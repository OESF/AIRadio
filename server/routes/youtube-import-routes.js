/**
 * @file 見た YouTube の受け口（ブラウザの拡張機能 Tampermonkey から字幕と視聴の記録を受け取る）
 *
 * 見た動画の中身を溜めて、番組の議論を深くする。公式の API では他人の動画の字幕を取れないが、開いている
 * ページの中には字幕があるので、拡張機能がそこから拾って送ってくる（lib/youtube-watch-store.js）。
 *   - POST /api/youtube-import        … 受け取って要約し、保存し、エージェントの学びにも書き留める
 *   - GET  /api/youtube-import/status … 何がどれだけ溜まっているか
 *
 * ATTENTION: 守りは資産の取り込み（finance-import-routes.js）と同じにすること。共有トークン（X-Import-Token）の
 *            一致と、既定で localhost からだけ受け付けること（トークンは、悪意のあるページが偽のデータを
 *            送り込むことも防ぐ）。トークンは credentials.json の finance_import.token を共用している
 *            （同じ性質の窓口で、設定する項目を増やしたくないため）。
 *
 * 拡張機能のスクリプトの配信（GET /tampermonkey/:name.user.js）は finance-import-routes.js にあり、
 * server/tampermonkey/youtube.user.js を置けばそのまま配信される。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-18
 */
'use strict';

const { getLogger } = require('../logger');
const youtubeWatchStore = require('../lib/youtube-watch-store');
const { summarizeWatchedVideo } = require('../lib/youtube-watch-summarize');

/**
 * 同じ PC（ループバック）からのアクセスか。IPv6 と、IPv4 を IPv6 の形にしたものの両方を見る。
 * @param {{socket?: {remoteAddress?: string}}} req
 * @returns {boolean}
 */
function isLoopback(req) {
  const raw = req.socket?.remoteAddress || '';
  const addr = raw.replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || raw === '::1';
}

/**
 * 「見た」とみなす下限（視聴した割合と秒数）。これを下回るものは捨てる。
 * ATTENTION: スクリプト側でも足切りしているが、サーバー側でも持つこと。スクリプトの条件をあとで緩めたときに、
 *            「クリックしただけ」の動画が気づかないうちに大量に溜まるのを防ぐ。
 */
const MIN_WATCHED_PCT = 25;
const MIN_WATCHED_SEC = 120;

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{readJsonFile: Function, getInitialCredentials: Function, CREDENTIALS_PATH: string}} ctx
 */
function registerYoutubeImportRoutes(app, ctx) {
  const { readJsonFile, getInitialCredentials, CREDENTIALS_PATH } = ctx;
  const settings = () => (readJsonFile(CREDENTIALS_PATH, getInitialCredentials())?.finance_import) || {};

  /** 共通の守り（トークン・接続元）。通してよければ false、拒否して応答を返したら true。 */
  const guard = (req, res) => {
    const cfg = settings();
    if (!cfg.token) {
      res.status(503).json({ error: 'credentials.json に finance_import.token が設定されていません' });
      return true;
    }
    if (!cfg.allow_remote && !isLoopback(req)) {
      getLogger().warn('[YouTubeImport] localhost以外からのアクセスを拒否しました');
      res.status(403).json({ error: 'localhost以外からは受け付けません' });
      return true;
    }
    if (req.get('X-Import-Token') !== cfg.token) {
      getLogger().warn('[YouTubeImport] トークンが一致しないリクエストを拒否しました');
      res.status(401).json({ error: 'トークンが一致しません' });
      return true;
    }
    return false;
  };

  // 受け取り。本文は { videoId, title, channel, url, publishedAt, description, transcript, durationSec,
  // watchedSec, transcriptSource }。transcriptSource は字幕の取り方（'player'・'panel'・'none'）で、
  // YouTube の変更でどちらかが壊れたときにログで切り分けるために残す
  app.post('/api/youtube-import', async (req, res) => {
    if (guard(req, res)) return;

    const b = req.body || {};
    const videoId = String(b.videoId || '').trim();
    const title = String(b.title || '').trim();
    if (!videoId || !title) {
      return res.status(400).json({ error: 'videoId と title は必須です' });
    }

    // 手動の送信（拡張機能のメニューから）は「もう一度ちゃんと取り込ませたい」という意思なので、足切りと
    // 重複の判定を飛ばして上書きする（字幕が取れないまま保存された動画を、送り直せるように）
    const force = b.force === true;

    const durationSec = Number(b.durationSec) || 0;
    const watchedSec = Number(b.watchedSec) || 0;
    const watchedPct = durationSec > 0 ? Math.round((watchedSec / durationSec) * 100) : 0;
    if (!force && watchedPct < MIN_WATCHED_PCT && watchedSec < MIN_WATCHED_SEC) {
      getLogger().debug(`[YouTubeImport] 視聴が浅いためスキップ: ${title.slice(0, 30)}`
        + `（${watchedPct}% / ${Math.round(watchedSec)}秒）`);
      return res.json({ ok: true, skipped: 'watched_too_little', watchedPct });
    }

    // 同じ動画を何度も要約しない（見直すたびに LLM を呼ばない）。手動の送信は例外
    if (!force && youtubeWatchStore.hasVideo(videoId)) {
      return res.json({ ok: true, skipped: 'already_imported' });
    }

    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    const apiKey = creds?.gemini?.api_key;
    if (!apiKey) return res.status(503).json({ error: 'Gemini APIキーが設定されていません' });

    // 字幕の取りこぼしはログでも分かるようにする（9割未満なら警告）
    const cov = (b.coveragePct === null || b.coveragePct === undefined) ? null : Number(b.coveragePct);
    const covLabel = cov === null ? '' : `・字幕が覆う範囲${cov}%`;
    getLogger().info(`[YouTubeImport] 受信: ${title.slice(0, 40)}`
      + `（字幕${String(b.transcript || '').length}字・取得方法=${b.transcriptSource || 'none'}`
      + `${covLabel}・視聴${watchedPct}%${force ? '・手動' : ''}）`);
    if (cov !== null && cov < 90) {
      getLogger().warn(`[YouTubeImport] 字幕が動画の${cov}%しか取れていません`
        + `（要約はこの範囲だけを材料にします）: ${title.slice(0, 40)}`);
    }

    // BUGFIX: 字幕の範囲が動画の長さを大きく超えるものは保存しない。スクリプトが字幕ではない要素（関連動画の一覧）を
    //         拾い、サムネイルの再生時間を字幕の時刻として送ってきたことがある（41分の動画で「1:30:56 まで」、
    //         カバー率204%）。スクリプト側でも弾いているが、受け取る側でも弾いて蓄積を汚さない
    if (cov !== null && cov > 105) {
      getLogger().warn(`[YouTubeImport] 字幕の範囲が動画の長さを超えています（${cov}%）。`
        + `文字起こし以外を読んだ可能性が高いため取り込みません: ${title.slice(0, 40)}`);
      return res.json({ ok: true, skipped: 'transcript_range_invalid', coveragePct: cov });
    }

    // BUGFIX: 範囲に対して字数が少なすぎるもの（1分あたり20字未満。普通の話す速さは毎分300字前後）は
    //         取り込まない。時刻だけを拾って本文を読み落とすと、範囲は広いのに中身が空になる
    //         （53分の動画で範囲93%なのに本文199字という送信があった）
    const transcriptChars = String(b.transcript || '').length;
    const minExpectedChars = durationSec > 0 ? Math.floor((durationSec / 60) * 20) : 0;
    if (transcriptChars > 0 && minExpectedChars > 0 && transcriptChars < minExpectedChars) {
      getLogger().warn(`[YouTubeImport] 字幕が短すぎます（${transcriptChars}字 / `
        + `${Math.round(durationSec / 60)}分の動画なら最低${minExpectedChars}字は欲しい）。`
        + `読み落としの可能性が高いため取り込みません: ${title.slice(0, 40)}`);
      return res.json({ ok: true, skipped: 'transcript_too_sparse', transcriptChars, minExpectedChars });
    }

    try {
      const { summary, hadTranscript, failed } = await summarizeWatchedVideo(
        { title, channel: String(b.channel || '').trim(), transcript: b.transcript, description: b.description },
        { apiKey, activitySessionId: null },
      );
      if (!summary && failed) {
        // AI の失敗（やり直しても通らなかった）。材料不足とは原因が違うので、ログと応答を分ける
        getLogger().warn(`[YouTubeImport] AIの不調で要約できず、取り込めませんでした: ${title.slice(0, 40)}`
          + '（もう一度取り込むには、Tampermonkey のメニュー「この動画をAI Radioへ送る」で送り直してください）');
        return res.json({ ok: true, skipped: 'summarize_failed' });
      }
      if (!summary) {
        getLogger().info(`[YouTubeImport] 材料が足りず取り込まない: ${title.slice(0, 40)}`
          + `（字幕${String(b.transcript || '').length}字 / 概要欄${String(b.description || '').length}字`
          + ` / 取得方法=${b.transcriptSource || '不明'}）`);
        return res.json({ ok: true, skipped: 'no_material' });
      }
      youtubeWatchStore.saveVideo({
        videoId, title,
        channel: String(b.channel || '').trim() || '(チャンネル不明)',
        url: String(b.url || `https://www.youtube.com/watch?v=${videoId}`),
        publishedAt: String(b.publishedAt || ''),
        summary, hadTranscript, watchedPct,
        transcriptSource: String(b.transcriptSource || ''),
        // 字数だけでは最後まで読めたかが分からないので、読めた範囲と動画の長さも残す
        transcriptChars,
        durationSec: Number(b.durationSec) || 0,
        coveragePct: (b.coveragePct === null || b.coveragePct === undefined)
          ? null : Number(b.coveragePct),
        coverageFromSec: (b.coverageFromSec === null || b.coverageFromSec === undefined)
          ? null : Number(b.coverageFromSec),
        coverageToSec: (b.coverageToSec === null || b.coverageToSec === undefined)
          ? null : Number(b.coverageToSec),
      });
      // 要約は7日で手元から消えるので、取り込んだその場で各エージェントの学びにも書き留める
      // （待たずに進める。詳しくは youtube-watch-store.js の learnFromVideo）
      youtubeWatchStore.learnFromVideo(
        { title, channel: String(b.channel || '').trim() || '(チャンネル不明)', summary },
        { apiKey, activitySessionId: null },
      );
      res.json({ ok: true, imported: true, hadTranscript, watchedPct, summaryLength: summary.length });
    } catch (e) {
      getLogger().warn(`[YouTubeImport] 取り込みに失敗: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ちゃんと溜まっているかを確かめるためのもの
  app.get('/api/youtube-import/status', (req, res) => {
    if (guard(req, res)) return;
    res.json(youtubeWatchStore.summarize());
  });
}

module.exports = { registerYoutubeImportRoutes };
