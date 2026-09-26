// ==UserScript==
// @name         AI Radio 視聴記録（YouTube）
// @namespace    https://github.com/MiuraMasataka/ai-radio
// @version      2.6.0
// @description  実際に視聴したYouTubeの字幕を取得し、AI Radio へ送って要約・蓄積する
// @author       AI Radio
// @match        https://www.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      localhost
// @run-at       document-idle
// @downloadURL  __SERVER_ORIGIN__/tampermonkey/youtube.user.js
// @updateURL    __SERVER_ORIGIN__/tampermonkey/youtube.user.js
// ==/UserScript==

/**
 * @file 見た YouTube の字幕をページから取り出し、AI Radio へ送るブラウザ拡張（Tampermonkey）
 *
 * リスナーがログインして開いている YouTube のページから、実際に見た動画の字幕・題名・チャンネル・
 * 概要を取り出し、サーバーの取り込み口（/api/youtube-import）へ送る。サーバー側は字幕から要約を作り、
 * 秘書と放送の材料として貯める（server/lib/youtube-watch-store.js）。
 *
 * ATTENTION: 字幕はサーバーからは取れない。公式の API で落とせるのは自分が持っている動画の字幕だけ。
 * ログインして開いているページの中には字幕があるので、そこから取る。
 *
 * 字幕の取り方は2通りを順に試し、どちらで取れたかをサーバーへ報告する（片方が壊れたときに切り分けられる）。
 * 1. ページの中にある字幕のデータの URL から取る（速いが、YouTube の作りが変わると壊れる）
 * 2. 「文字起こしを表示」のパネルを開いて画面の文字から読む（比較的安定）
 *
 * ATTENTION: 画面の状態を変えないこと。スクロールしていたころ、見ている画面が勝手に動いて使い物に
 * ならなかった。今は DOM を読むだけで、パネルを開くときも画面の外で開き、読み終えたら閉じて元へ戻す。
 * 自分で開いたものだけを閉じ、リスナーが開いていたものはそのままにする（開閉は visibility 属性で見分ける）。
 *
 * ATTENTION: 送るのは「実際に見た」とみなせてから（25%以上または120秒以上）。開いてすぐ閉じた動画まで
 * 貯めると、材料が雑音だらけになる。サーバー側にも同じ足切りがある。
 *
 * ATTENTION: このファイルはそのまま配られるのではなく、サーバーが配る前に接続先と合い言葉を差し込む
 * （server/routes/youtube-import-routes.js）。差し込みの目印を書き換えないこと。
 *
 * YouTube は動画を切り替えてもページを読み込み直さないので、切り替えの合図と URL の変化の両方を見る。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */
(function () {
  'use strict';

  const ENDPOINT = '__SERVER_ORIGIN__/api/youtube-import';
  const TOKEN = '__IMPORT_TOKEN__';

  // 「見た」とみなす条件（どちらかを満たせば送る）
  const MIN_WATCHED_PCT = 25;
  const MIN_WATCHED_SEC = 120;
  const CHECK_INTERVAL_MS = 15000;

  const sentThisLoad = new Set();   // 同じ動画を1回の滞在で何度も送らない
  let timer = null;

  // ATTENTION: ログの先頭に版を出す。出していなかったころ、直したはずの動きが出ない原因が、拡張の更新漏れ
  // なのかコードの不備なのか切り分けられなかった
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '不明';
  const log = (...a) => console.log(`[AI Radio/YouTube v${VERSION}]`, ...a);

  /**
   * 今開いている動画の ID（URL の v= から取る）。
   * @returns {string|null} 動画の ID（動画のページでなければ null）
   */
  function currentVideoId() {
    const m = /[?&]v=([\w-]{6,})/.exec(location.href);
    return m ? m[1] : null;
  }

  /**
   * ページの中にあるプレイヤーの情報（題名・長さ・字幕の在りかなど）。置き場所が複数あるので順に探す。
   * @returns {any} プレイヤーの情報（見つからなければ null）
   */
  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
      const el = document.querySelector('#movie_player');
      if (el && typeof el.getPlayerResponse === 'function') return el.getPlayerResponse();
    } catch (e) { /* 取れなければ次の手へ */ }
    return null;
  }

  /**
   * 今どこまで見たか（秒）と、動画の長さ（秒）。
   *
   * BUGFIX: 長さはプレイヤーの情報（videoDetails）を最優先で使う。動画の要素から取ると、広告の再生中は
   * 広告の長さ（数十秒）が返り、その値で字幕の範囲を判定すると、正しい字幕まで範囲外として弾いてしまう。
   *
   * @returns {{watchedSec: number, durationSec: number}|null} 分からなければ null
   */
  function getProgress() {
    try {
      const pr = getPlayerResponse();
      const metaDur = Number(pr?.videoDetails?.lengthSeconds) || 0;
      const el = document.querySelector('#movie_player');
      // これが使えれば、本編の再生位置と長さをまとめて取れる（最も確か）
      const st = el && typeof el.getProgressState === 'function' ? el.getProgressState() : null;
      if (st && st.duration > 0) {
        return { watchedSec: st.current || 0, durationSec: metaDur || st.duration };
      }
      if (el && typeof el.getCurrentTime === 'function' && typeof el.getDuration === 'function') {
        const cur = el.getCurrentTime(), dur = el.getDuration();
        if (metaDur > 0 || dur > 0) return { watchedSec: cur, durationSec: metaDur || dur };
      }
      const v = document.querySelector('video');
      if (v && (metaDur > 0 || v.duration > 0)) {
        return { watchedSec: v.currentTime, durationSec: metaDur || v.duration };
      }
    } catch (e) { /* 分からない */ }
    return null;
  }

  // ── 方法1: ページの中にある字幕のデータから取る ────────────────────────

  /**
   * json3 形式の字幕を、文の並びにする。
   * @param {string} text 応答の本文
   * @returns {string} 字幕の文
   */
  function _parseJson3(text) {
    const data = JSON.parse(text);
    const events = Array.isArray(data?.events) ? data.events : [];
    return events.map(e => (e.segs || []).map(s => s.utf8 || '').join('')).join('');
  }
  /**
   * XML 形式の字幕を、文の並びにする。
   * @param {string} text 応答の本文
   * @returns {string} 字幕の文
   */
  function _parseTimedTextXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const nodes = doc.querySelectorAll('text, p');
    return [...nodes].map(n => n.textContent || '').join(' ');
  }
  /**
   * 改行と続いた空白を1つの空白にまとめる。
   * @param {string} t 字幕の文
   * @returns {string} 整えた文
   */
  function _cleanup(t) {
    return String(t || '').replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * ページの中にある字幕のデータから、字幕の文を取る（方法1）。
   * 日本語・英語・先頭の順に選ぶ（自動生成のものも使う）。
   *
   * ATTENTION: 形式を変えて3回まで試し、何が起きたかを必ずログに出す。字幕はあるのに、そのまま取りに行くと
   * 中身が返らないことがあり（YouTube 側が弾いていると見られる）、推測ではなく応答を見て判断できるようにするため。
   *
   * @param {any} pr プレイヤーの情報
   * @returns {Promise<string>} 字幕の文（取れなければ空文字）
   */
  async function fetchTranscriptViaPlayer(pr) {
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      log('診断: 字幕トラックがページ内に見つかりません（この動画には字幕が無い可能性）');
      return '';
    }
    log(`診断: 字幕トラック ${tracks.length}件 — `
      + tracks.map(t => `${t.languageCode || '?'}${t.kind === 'asr' ? '(自動)' : ''}`).join(', '));
    const pick = tracks.find(t => (t.languageCode || '').startsWith('ja'))
      || tracks.find(t => (t.languageCode || '').startsWith('en'))
      || tracks[0];
    if (!pick?.baseUrl) { log('診断: baseUrl がありません'); return ''; }

    // 形式の指定が既に付いていることがあるので、取り除いてから付け直す
    const base = pick.baseUrl.replace(/&fmt=[^&]*/g, '');
    const attempts = [
      { label: 'json3', url: `${base}&fmt=json3`, parse: _parseJson3 },
      { label: 'srv3',  url: `${base}&fmt=srv3`,  parse: _parseTimedTextXml },
      { label: '素',    url: base,                parse: _parseTimedTextXml },
    ];
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, { credentials: 'include' });
        const body = await res.text();
        if (!res.ok) { log(`診断: ${a.label} → HTTP ${res.status}`); continue; }
        if (!body || body.length < 20) { log(`診断: ${a.label} → 200だが本文が空(${body.length}バイト)`); continue; }
        const out = _cleanup(a.parse(body));
        if (out.length >= 50) { log(`診断: ${a.label} で取得できました（${out.length}字）`); return out; }
        log(`診断: ${a.label} → 解析後が短すぎます(${out.length}字)`);
      } catch (e) {
        log(`診断: ${a.label} → ${e.message}`);
      }
    }
    return '';
  }

  // ── 方法2: 「文字起こし」のパネルを開いて画面の文字から読む ──────────────
  // ATTENTION: パネルが開く・中身が載るまでには時間がかかる。段階ごとに待ち、どこで詰まったかが分かるよう
  // それぞれログを出す。

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /**
   * 条件が成り立つまで、少しずつ待ちながら繰り返す。
   * @param {Function} fn 成り立ったら真を返す関数
   * @param {{tries?: number, interval?: number}} [opts] 回数と間隔（ミリ秒）
   * @returns {Promise<boolean>} 成り立てば true
   */
  async function waitFor(fn, { tries = 20, interval = 300 } = {}) {
    for (let i = 0; i < tries; i++) {
      if (fn()) return true;
      await sleep(interval);
    }
    return false;
  }

  /**
   * 「文字起こしを表示」のボタンを探す。
   *
   * ATTENTION: 概要欄を展開しないこと。畳んだままでもボタンは DOM にあり（見えないだけ）、押すことはできる。
   * 展開は画面が動く原因そのものだった。
   * パネルの中にも同じ名前のボタンがあるので、パネルの外にあるものだけを選ぶ。
   *
   * @returns {any} ボタンの要素（見つからなければ undefined）
   */
  function findTranscriptButton() {
    const cands = [...document.querySelectorAll('button, tp-yt-paper-button')];
    return cands.find(b =>
      /文字起こしを表示|字幕を表示|show transcript/i.test(
        `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`)
      && !b.closest('ytd-engagement-panel-section-list-renderer'));
  }

  // パネルを画面の外へ追い出す指定。
  // ATTENTION: 非表示（display:none）にしてはいけない。描かれなくなると、行ごとの改行が失われて全部が
  // つながってしまい、行の先頭のタイムスタンプを落とす処理が働かない。描いたまま画面の外へ出せば、
  // 読める文はそのままで見えなくなる（位置を固定するので、周りの並びにも影響しない）
  const OFFSCREEN_CSS = 'position:fixed!important;top:-100000px!important;'
    + 'left:-100000px!important;width:420px!important;height:900px!important;'
    + 'opacity:0!important;pointer-events:none!important;z-index:-1!important;';

  /**
   * 画面の外へ逃がす対象のパネル（今閉じているものすべて）。
   *
   * BUGFIX: 属性で絞らない。絞っていたころ、その属性を持たないパネルに文字起こしが開く動画があり、
   * 逃がし損ねて画面に出てしまった。開いているパネルはリスナーが開いたものなので触らない。
   *
   * @returns {Array<any>} 閉じているパネル
   */
  function hideablePanels() {
    return [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .filter((p) => !(p.getAttribute('visibility') || '').includes('EXPANDED'));
  }

  /**
   * 閉じているパネルを画面の外へ逃がす。
   * @returns {{reapply: Function, restore: Function}} reapply は後から現れたパネルにも同じ指定を当てる。
   *   restore は逃がしたものをすべて元に戻す
   */
  function hidePanelsOffscreen() {
    const saved = new Map();
    const apply = () => {
      for (const el of hideablePanels()) {
        if (!saved.has(el)) saved.set(el, el.getAttribute('style'));
        el.setAttribute('style', OFFSCREEN_CSS);
      }
    };
    apply();
    return {
      reapply: apply,
      restore: () => {
        for (const [el, style] of saved) {
          if (style === null) el.removeAttribute('style');
          else el.setAttribute('style', style);
        }
      },
    };
  }

  /**
   * 読んでいる間だけ、画面の位置を保つ。
   *
   * パネルを画面の外に置いても、YouTube 自身がパネルを開くときにページの先頭へ動かそうとするため、
   * 短い間隔で引き戻す。
   * ATTENTION: リスナーが自分で動かしたら、すぐに手を引くこと。画面を動かさないための仕組みが、
   * 自分でスクロールできない原因になっては本末転倒。念のため一定時間で必ず手を引く。
   *
   * @param {number} target 保つ位置
   * @returns {Function} 呼ぶと見張りをやめる
   */
  function keepScrollPosition(target) {
    const USER_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      for (const ev of USER_EVENTS) window.removeEventListener(ev, release, true);
    };
    const timer = setInterval(() => {
      if (Math.abs(window.scrollY - target) > 4) {
        window.scrollTo({ top: target, behavior: 'instant' });
      }
    }, 50);
    for (const ev of USER_EVENTS) window.addEventListener(ev, release, true);
    setTimeout(release, 15000);   // いつまでも握り続けない
    return release;
  }

  /**
   * 文字起こしのパネルを探す（属性 → 中の言葉 → 中身の形、の順）。
   *
   * ATTENTION: 中の要素の名前を当てにしないこと。数えていたころ、YouTube が名前を変えた途端に
   * 「ボタンは押せたのに中身が0件」になった。パネルを見つけて、表示されている文から読む。
   *
   * @returns {any} パネルの要素（見つからなければ null）
   */
  function findTranscriptPanel() {
    const byTarget = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]');
    if (byTarget && (byTarget.innerText || '').length > 200) return byTarget;
    const byText = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find(el => /文字起こし|transcript/i.test((el.textContent || '').slice(0, 200)));
    if (byText && (byText.innerText || '').length > 200) return byText;
    // 名前でも属性でも見つからなければ、中身の形から探す
    return findTranscriptPanelByContent();
  }

  /**
   * 中身の形から文字起こしのパネルを探す（最後の手段）。
   *
   * 文字起こしは、時刻の付いた行がたくさん並ぶという他に無い特徴を持つ。その行が一番多く、かつ一番小さい
   * 要素（余計なものを含まない入れ物）を選ぶ。要素の名前にも属性にも頼らないので、YouTube の作りが
   * 変わっても効く。
   *
   * BUGFIX: 探す範囲に右側の関連動画を含めないこと。含めていたころ、動画の長さ（1:30:56 など）が時刻の行
   * として大量に数えられ、文字起こしより高い点を取って選ばれていた。
   * BUGFIX: 目次やコメントのパネルは対象から外す。時刻の付いた行が並ぶ点で紛らわしく、実際に目次を字幕として
   * 送ってしまった。
   *
   * @returns {any} パネルの要素（見つからなければ null）
   */
  function findTranscriptPanelByContent() {
    const TS = /(^|\n)\s*\d{1,2}:\d{2}(:\d{2})?(\s|$)/g;
    const cands = new Set();
    const push = (sel) => {
      try { document.querySelectorAll(sel).forEach(el => cands.add(el)); } catch (e) { /* 使えない指定は無視 */ }
    };
    push('[target-id]');
    push('ytd-engagement-panel-section-list-renderer');
    push('[id*="transcript" i], [class*="transcript" i]');
    push('#panels, #below');

    const NOT_TRANSCRIPT = /chapter|macro-markers|comments|ads|structured-description|search_preview/i;
    let best = null, bestScore = 0;
    for (const el of cands) {
      const owner = el.closest('[target-id]');
      if (owner && NOT_TRANSCRIPT.test(owner.getAttribute('target-id') || '')) continue;
      const t = el.innerText || '';
      if (t.length < 200) continue;
      const score = (t.match(TS) || []).length;
      if (score < 5) continue;
      if (!_looksLikeTranscript(el)) continue;           // 関連動画などを掴まないための関門（下を参照）
      const isBetter = score > bestScore
        || (score === bestScore && best && t.length < (best.innerText || '').length);
      if (isBetter) { best = el; bestScore = score; }
    }
    if (best) {
      const _d = getProgress()?.durationSec || 0;
      const _pm = _d > 0 ? (bestScore / (_d / 60)).toFixed(1) : '?';
      log(`診断: 中身からパネルを特定しました（<${best.tagName.toLowerCase()}> `
        + `タイムスタンプ${bestScore}行・${(best.innerText || '').length}字・${_pm}行/分）`);
    }
    return best;
  }

  // 落とす行の形。パネルの1区切りは3行（見えている時刻・読み上げ用の時刻・本文）で描かれ、先頭と末尾には
  // 操作用の見出しが付く。
  // BUGFIX: 読み上げ用の時刻（「41 分 52 秒」）も落とすこと。落とし損ねていたころ、本文の1割近くが
  // この文字列として要約に流れ込み、読み手が内容と取り違える余地もあった
  const TS_DISPLAY = /^\d{1,2}:\d{2}(:\d{2})?$/;                      // 0:00 / 1:02:33
  const TS_SPOKEN = /^(?:\d+\s*時間\s*)?(?:\d+\s*分\s*)?\d+\s*秒$/;    // 0 秒 / 41 分 52 秒
  const UI_LABEL = /^(文字起こし|文字音声変換を検索|動画の時間と同期|言語を選択|タイムスタンプ|Transcript|Search in transcript|Show transcript|Toggle timestamps)$/;

  /**
   * パネルの表示されている文から、本文の行だけを取り出す（時刻の行と操作の見出しを落とす）。
   * @param {any} panel パネルの要素
   * @returns {string[]} 本文の行
   */
  function panelLines(panel) {
    const raw = (panel && panel.innerText || '').trim();
    if (!raw) return [];
    return raw.split('\n').map(l => l.trim()).filter(Boolean)
      .filter(l => !UI_LABEL.test(l))
      .filter(l => !TS_DISPLAY.test(l) && !TS_SPOKEN.test(l))
      .map(l => l.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, ''))   // 「0:12 本文」と1行になっている形にも備える
      .filter(Boolean);
  }

  /**
   * パネルの本文を、1つの文につなぐ。
   * @param {any} panel パネルの要素
   * @returns {string} 字幕の文
   */
  function readPanelText(panel) {
    return panelLines(panel).join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * 「1:02:33」のような時刻を秒に直す。
   * @param {string} s 時刻
   * @returns {number|null} 秒（形が違えば null）
   */
  function _tsToSec(s) {
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /**
   * パネルの各行の先頭にある時刻を、秒にして集める。
   * どこからどこまで読めたかを数字で言えるようにするため（読み落としを推測で語らずに済む）。
   * @param {any} panel パネルの要素
   * @returns {number[]} 秒の一覧
   */
  function panelTimestamps(panel) {
    const raw = (panel && panel.innerText || '').trim();
    if (!raw) return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const m = /^\s*(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$)/.exec(line);
      if (!m) continue;
      const sec = _tsToSec(m[1]);
      if (sec !== null) out.push(sec);
    }
    return out;
  }

  /**
   * その要素が本当に文字起こしか。時刻の付いた行が並ぶ要素は、ほかにもあるので見分ける。
   *
   * BUGFIX: 時刻が動画の長さに収まっているかを見る。見ていなかったころ、関連動画の一覧（動画の長さが
   * たくさん並ぶ）を文字起こしとして掴み、41分の動画に「5:22〜1:30:56」という範囲を報告していた。
   * BUGFIX: 1分あたりの行数も見る。範囲だけでは目次を弾けない。文字起こしは数秒おき（6〜7行/分）に並ぶが、
   * 目次は数分おき（0.5行/分）しかない。1分に2行を境にすれば分かれる。
   *
   * @param {any} el 調べる要素
   * @param {{quiet?: boolean}} [opts] quiet が true ならログを出さない
   * @returns {boolean} 文字起こしとみなせれば true
   */
  function _looksLikeTranscript(el, { quiet = false } = {}) {
    const dur = getProgress()?.durationSec || 0;
    const ts = panelTimestamps(el);
    if (ts.length < 5) return false;
    if (!(dur > 0)) return true;          // 長さが分からないときは弾かない
    // 範囲が動画に収まっているか
    if (Math.max(...ts) > dur * 1.05 + 5) return false;
    // 1分あたりの行数（目次との見分け）
    const perMinute = ts.length / (dur / 60);
    if (perMinute < 2) {
      if (!quiet) {
        log(`診断: 文字起こしではないと判断しました（${ts.length}行 / ${Math.round(dur / 60)}分`
          + ` = ${perMinute.toFixed(2)}行/分。チャプター等の可能性）`);
      }
      return false;
    }
    return true;
  }

  // 直前の読み取りが動画のどの範囲を覆えたか。readPanelTextFully が書き、送るときに使う
  let lastReadRange = { minSec: null, maxSec: null };

  /**
   * パネルから字幕の本文を読む。読めた範囲（最初と最後の時刻）も控える。
   *
   * ATTENTION: スクロールしないこと。文字起こしは全行が最初から描かれていて（見えている高さの百倍以上の
   * 長さがあっても）、下まで送っても1字も増えない。スクロールしていたころは、見ている画面が勝手に動くうえ、
   * 掴む要素を間違えるとページ全体が動いていた。読めないのは要素を間違えているときなので、足りないまま返す
   * （範囲が足りなければ、呼び出し元とサーバーが弾く）。
   *
   * @param {any} panel パネルの要素
   * @returns {string} 字幕の文
   */
  function readPanelTextFully(panel) {
    const lines = [...new Set(panelLines(panel))];
    const ts = panelTimestamps(panel);
    const minSec = ts.length ? Math.min(...ts) : null;
    const maxSec = ts.length ? Math.max(...ts) : null;
    lastReadRange = { minSec, maxSec };

    const dur = getProgress()?.durationSec || 0;
    const range = (minSec !== null) ? `${_fmtSec(minSec)}〜${_fmtSec(maxSec)}` : '不明';
    if (_coversWholeVideo(minSec, maxSec, dur)) {
      log(`診断: 読み取り完了（${lines.length}行・${range} / 全${_fmtSec(dur)}）`);
    } else {
      log(`⚠️ 診断: 読めた範囲が足りません（${lines.length}行・${range} / 全${_fmtSec(dur)}）`
        + ' — 画面は動かさず、このまま返します');
    }
    return lines.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  /**
   * 読めた範囲が動画のほぼ全体を覆っているか。
   * 終わりに字幕の無い動画（音楽だけのエンディングなど）を弾かないよう、9割5分以上か、残り60秒以内の
   * どちらかを満たせば十分とみなす。分からないときは false。
   * @param {number|null} minSec 最初の時刻
   * @param {number|null} maxSec 最後の時刻
   * @param {number} durationSec 動画の長さ
   * @returns {boolean} 覆えていれば true
   */
  function _coversWholeVideo(minSec, maxSec, durationSec) {
    if (!(durationSec > 0) || minSec === null || maxSec === null) return false;
    if (minSec > 60) return false;                       // 頭が読めていない
    return maxSec >= durationSec * 0.95 || (durationSec - maxSec) <= 60;
  }

  /**
   * 秒を「mm:ss」または「h:mm:ss」にする（ログと報告用）。
   * @param {number} s 秒
   * @returns {string} 時刻
   */
  function _fmtSec(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? `${h}:` : '') + `${mm}:${String(x).padStart(2, '0')}`;
  }

  /**
   * 読めなかったときに、パネルの中に何があるかをログに出す（次の手を決めるため）。
   * @param {any} panel パネルの要素
   * @returns {void}
   */
  function dumpPanelDiagnostics(panel) {
    if (!panel) { log('診断: 文字起こしパネル自体が見つかりません'); return; }
    const tags = {};
    panel.querySelectorAll('*').forEach(el => {
      const t = el.tagName.toLowerCase();
      if (t.indexOf('-') >= 0) tags[t] = (tags[t] || 0) + 1;   // YouTube 独自の要素だけ数える
    });
    const top = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([t, n]) => `${t}×${n}`).join(', ');
    log(`診断: パネル内のカスタム要素 → ${top || '（なし）'}`);
    log(`診断: パネルの表示テキスト先頭 → ${JSON.stringify((panel.innerText || '').slice(0, 160))}`);
    log(`診断: パネルの visibility → ${panel.getAttribute('visibility') || '(未設定)'}`);
  }

  /**
   * 今開いている文字起こしのパネル。
   *
   * ATTENTION: 開いているかは visibility 属性で見分けること。閉じているパネルも DOM にはあり、見出し分の
   * 文字を持っているので、文字数では「開いている」と間違える。
   * BUGFIX: どのパネルかは属性ではなく中身で見分ける。属性で探していたころ、その属性を持たないパネルに
   * 文字起こしが入る動画で見落とし、閉じる処理も画面の外へ逃がす処理も働かず、画面に出っ放しになった。
   *
   * @returns {any} パネルの要素（無ければ null）
   */
  function getOpenTranscriptPanel() {
    const open = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .filter((p) => (p.getAttribute('visibility') || '').includes('EXPANDED'));
    if (open.length === 0) return null;
    const byContent = open.filter((p) => _looksLikeTranscript(p, { quiet: true }));
    const pool = byContent.length
      ? byContent
      : open.filter((p) => /transcript/i.test(p.getAttribute('target-id') || ''));
    if (pool.length === 0) return null;
    return pool.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];
  }

  /**
   * タブを持つ、開いているパネル（「動画の関連情報」）。
   * ATTENTION: タブの操作では属性に頼らないこと。タブを切り替えるとパネルの属性そのものが変わるため、
   * 属性で探すと切り替えた瞬間に見失い、元のタブへ戻せなくなる。
   * @returns {any} パネルの要素（無ければ null）
   */
  function getOpenTabbedPanel() {
    return [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .filter((p) => (p.getAttribute('visibility') || '').includes('EXPANDED'))
      .find((p) => p.querySelector('chip-view-model')) || null;
  }

  /**
   * パネルのタブの一覧（名前とボタン）。
   *
   * BUGFIX: タブ形式の画面にも対応すること。動画によっては、ボタンを押すと「動画の関連情報」が開き、
   * その中の「目次」「文字起こし」をタブで選ぶ形になる。対応していなかったころ、この形の動画を
   * 「文字起こしが無い」と判断し、代わりに目次を字幕として取り込んでいた。
   *
   * @param {any} panel パネルの要素
   * @returns {Array<any>} タブ（label と button）
   */
  function getPanelTabs(panel) {
    return [...(panel ? panel.querySelectorAll('chip-view-model') : [])]
      .map((c) => ({
        label: (c.textContent || '').trim(),
        button: c.querySelector('button[role="tab"]') || c.querySelector('button'),
      }))
      .filter((t) => t.button);
  }

  /**
   * 今選ばれているタブの名前（元へ戻すために控えておく）。
   * @param {any} panel パネルの要素
   * @returns {string|null} タブの名前（タブが無ければ null）
   */
  function getSelectedTabLabel(panel) {
    const cur = getPanelTabs(panel).find((t) => t.button.getAttribute('aria-selected') === 'true');
    return cur ? cur.label : null;
  }

  /**
   * 指定した名前のタブへ切り替える（既に選ばれていれば何もしない）。
   * @param {any} panel パネルの要素
   * @param {RegExp|string} matcher タブの名前、または名前に当てる正規表現
   * @returns {boolean} 切り替えたら true
   */
  function selectPanelTab(panel, matcher) {
    const tabs = getPanelTabs(panel);
    if (tabs.length === 0) return false;
    const target = tabs.find((t) => (matcher instanceof RegExp ? matcher.test(t.label) : t.label === matcher));
    if (!target) return false;
    if (target.button.getAttribute('aria-selected') === 'true') return false;
    target.button.click();
    return true;
  }

  /**
   * 自分で開いたパネルを閉じ、リスナーが見ていた画面に戻す。
   * BUGFIX: 閉じるボタンは部分一致で探す。完全一致にしていたころ、「文字起こしを閉じる」のような表記を
   * 取りこぼしていた（パネルの中のボタンは数個なので、誤って別のものを押す恐れは無い）。
   * @returns {void}
   */
  function closeTranscriptPanel() {
    const panel = getOpenTranscriptPanel();
    if (!panel) return;
    const btn = [...panel.querySelectorAll('button')]
      .find(b => /閉じる|close/i.test((b.getAttribute('aria-label') || '').trim()));
    if (btn) { btn.click(); log('診断: 文字起こしを閉じました（開く前の状態へ戻しました）'); }
    else log('診断: 閉じるボタンが見つからないため、パネルは開いたままです');
  }

  /**
   * 概要欄が開いているか。
   * @returns {boolean} 開いていれば true
   */
  function isDescriptionExpanded() {
    return !!document.querySelector('#description-inline-expander[is-expanded]');
  }

  /**
   * 概要欄を畳む（自分で開いたときに元へ戻すため）。
   * @returns {void}
   */
  function collapseDescription() {
    const btn = document.querySelector(
      '#description-inline-expander #collapse, tp-yt-paper-button#collapse, #collapse');
    if (btn) { btn.click(); log('診断: 概要欄を畳みました（開く前の状態へ戻しました）'); }
  }

  /**
   * 「文字起こし」のパネルから字幕の文を取る（方法2）。
   *
   * 開閉は visibility 属性で分かるので、次のように分ける。
   * - 既に開いている: そのまま読み、閉じない（リスナーが開いたものなので）
   * - タブ形式で別のタブが選ばれている: 文字起こしへ切り替えて読み、見ていたタブへ必ず戻す
   * - 閉じている: 画面の外で自分で開いて読み、必ず閉じて元へ戻す
   *
   * ATTENTION: 元へ戻す処理は finally に置くこと。途中で失敗したときこそ、パネルが開きっぱなしになりやすい。
   *
   * @returns {Promise<string>} 字幕の文（取れなければ空文字）
   */
  async function fetchTranscriptViaPanel() {
    let out = '';
    const TRANSCRIPT_TAB = /文字起こし|transcript/i;

    // 既に開いていれば、そのまま読むのが一番良い（画面に触れずに済む）
    const alreadyOpen = getOpenTranscriptPanel();
    if (alreadyOpen && _looksLikeTranscript(alreadyOpen) && readPanelText(alreadyOpen).length >= 50) {
      const full = readPanelTextFully(alreadyOpen);
      log(`診断: 文字起こしは既に開かれていました（${full.length}字・開いたままにします）`);
      return full;
    }
    // タブ形式で別のタブが選ばれていれば、切り替えて読み、見ていたタブへ必ず戻す
    const tabbedOpen = getOpenTabbedPanel();
    if (tabbedOpen) {
      const prevTab = getSelectedTabLabel(tabbedOpen);
      if (prevTab && !TRANSCRIPT_TAB.test(prevTab) && selectPanelTab(tabbedOpen, TRANSCRIPT_TAB)) {
        log(`診断: 開いていたのは「${prevTab}」タブだったので、文字起こしへ切り替えます`);
        try {
          const panel2 = await _waitForTranscriptBody();
          if (panel2) {
            const full = readPanelTextFully(panel2);
            log(`診断: タブを切り替えて読み取りました（${full.length}字）`);
            return full;
          }
        } finally {
          if (selectPanelTab(getOpenTabbedPanel(), prevTab)) {
            log(`診断: 「${prevTab}」タブへ戻しました`);
          }
        }
      }
    }

    // ここから先は自分で開く。画面の外へ逃がしてから開き（開く瞬間も画面に出ない）、概要欄は展開せず、
    // YouTube がページの先頭へ動かそうとするのを押さえ込む
    const scrollBefore = window.scrollY;
    const descWasExpanded = isDescriptionExpanded();
    const panelGuard = hidePanelsOffscreen();
    const releaseScroll = keepScrollPosition(scrollBefore);
    let openedByUs = false;
    try {
      let btn = findTranscriptButton();
      // 畳んだままでもボタンは見つかるはずだが、見つからないときだけ展開する（ここを通ると画面が少し動く）
      if (!btn && !descWasExpanded) {
        log('診断: ボタンが見つからないため、やむを得ず概要欄を展開します');
        const expand = document.querySelector(
          '#description-inline-expander #expand, tp-yt-paper-button#expand, #expand');
        if (expand) { expand.click(); await sleep(800); }
        btn = findTranscriptButton();
      }
      if (!btn) await waitFor(() => (btn = findTranscriptButton()), { tries: 10, interval: 300 });
      if (!btn) {
        log('診断: 「文字起こしを表示」ボタンが見つかりません（この動画では提供されていない可能性）');
        return '';
      }
      log('診断: 画面外で文字起こしを開きます（画面には現れません）');
      btn.click();
      openedByUs = true;

      // パネルが開くのを待ってから、タブ形式なら文字起こしを選ぶ。
      // BUGFIX: この切り替えを忘れないこと。抜けていたころ、タブ形式の動画で目次を字幕として取り込んでいた
      await waitFor(() => !!(getOpenTranscriptPanel() || getOpenTabbedPanel()),
        { tries: 20, interval: 300 });
      // ATTENTION: 押したことで現れたパネルにも、もう一度逃がす指定を当てること（最初の退避には入っていない）
      panelGuard.reapply();
      if (selectPanelTab(getOpenTabbedPanel(), TRANSCRIPT_TAB)) {
        log('診断: 「動画の関連情報」の文字起こしタブへ切り替えました');
        await sleep(600);
      }

      const panel = await _waitForTranscriptBody();
      if (!panel) {
        log('診断: パネルは開いたが本文が読めません。中身を報告します');
        dumpPanelDiagnostics(getOpenTranscriptPanel());
        return '';
      }
      await sleep(700);   // 描き終わるのを待つ
      out = readPanelTextFully(panel);
      log(`診断: パネルから取得できました（${out.length}字）`);
      return out;
    } finally {
      // ATTENTION: 途中で失敗しても、開けたものは閉じ、逃がした指定も解いて元へ戻す
      if (openedByUs) { closeTranscriptPanel(); await sleep(300); }
      panelGuard.restore();
      if (!descWasExpanded && isDescriptionExpanded()) collapseDescription();
      await sleep(200);
      if (Math.abs(window.scrollY - scrollBefore) > 8) {
        window.scrollTo({ top: scrollBefore, behavior: 'instant' });
      }
      releaseScroll();
    }
  }

  /**
   * パネルに文字起こしの本文が載るのを待つ。
   * ATTENTION: 要素の数ではなく中身で判定すること（要素の名前が変わっても影響を受けないため）。
   * タブを切り替えた直後は読み込み中の印だけが入っていることがあるので、文字起こしとみなせるまで待つ。
   * @returns {Promise<any>} 本文が載ったパネル（駄目なら null）
   */
  async function _waitForTranscriptBody() {
    let panel = null;
    const ok = await waitFor(() => {
      panel = getOpenTranscriptPanel() || findTranscriptPanel();
      if (!panel || !_looksLikeTranscript(panel)) return false;
      return readPanelText(panel).length >= 50;
    }, { tries: 30, interval: 400 });
    return ok ? panel : null;
  }

  /**
   * 動画の題名・チャンネル・概要・公開日を集める。
   * @param {any} pr プレイヤーの情報
   * @returns {Record<string, any>} 動画の情報
   */
  function collectMeta(pr) {
    const vd = pr?.videoDetails || {};
    return {
      title: vd.title || document.title.replace(/ - YouTube$/, ''),
      channel: vd.author
        || document.querySelector('ytd-channel-name a, #owner #channel-name a')?.textContent?.trim()
        || '',
      description: (vd.shortDescription || '').slice(0, 3000),
      publishedAt: pr?.microformat?.playerMicroformatRenderer?.publishDate || '',
    };
  }

  /**
   * サーバーの取り込み口へ送る（合い言葉はヘッダーに付ける）。結果はログに出すだけで、失敗しても投げない。
   * @param {Record<string, any>} body 送る内容
   * @returns {Promise<void>}
   */
  function post(body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url: ENDPOINT,
        headers: { 'Content-Type': 'application/json', 'X-Import-Token': TOKEN },
        data: JSON.stringify(body),
        onload: (r) => {
          let j = null; try { j = JSON.parse(r.responseText); } catch (e) { /* 読めなくても続ける */ }
          if (r.status >= 200 && r.status < 300) {
            if (j?.imported) log(`✅ 取り込みました（字幕${j.hadTranscript ? 'あり' : 'なし'}・要約${j.summaryLength}字・視聴${j.watchedPct}%）`);
            else log(`— 見送り: ${j?.skipped || '理由不明'}`);
          } else {
            log(`❌ サーバーが拒否しました HTTP ${r.status}: ${j?.error || r.responseText?.slice(0, 200)}`);
          }
          resolve();
        },
        onerror: () => { log('❌ サーバーへ送れませんでした（AI Radio は起動していますか？）'); resolve(); },
      });
    });
  }

  /**
   * 今の動画を取り込めるなら取り込む（字幕を取ってサーバーへ送る）。
   *
   * 自動のときは「実際に見た」とみなせる分だけ再生されてから送り、同じ動画は1回の滞在で一度だけ送る。
   * 字幕は方法1を試し、駄目なら方法2。読めた範囲と動画の長さから、どれだけ覆えたかも一緒に送る。
   *
   * @param {{manual?: boolean}} [opts] manual が true なら、メニューからの手動の送信。見た割合の条件を
   *   飛ばし、サーバー側にも上書きさせる
   * @returns {Promise<void>}
   */
  async function tryCapture({ manual = false } = {}) {
    const videoId = currentVideoId();
    if (!videoId) return;
    if (sentThisLoad.has(videoId)) return;

    const prog = getProgress();
    if (!manual) {
      if (!prog) return;
      const pct = (prog.watchedSec / prog.durationSec) * 100;
      if (pct < MIN_WATCHED_PCT && prog.watchedSec < MIN_WATCHED_SEC) return;
    }

    const pr = getPlayerResponse();
    const meta = collectMeta(pr);
    if (!meta.title) return;

    let transcript = '', transcriptSource = 'none';
    try {
      transcript = await fetchTranscriptViaPlayer(pr);
      if (transcript) transcriptSource = 'player';
    } catch (e) {
      log('方法①（内部データ）が失敗しました:', e.message);
    }
    if (!transcript) {
      try {
        transcript = await fetchTranscriptViaPanel();
        if (transcript) transcriptSource = 'panel';
      } catch (e) {
        log('方法②（文字起こしパネル）が失敗しました:', e.message);
      }
    }
    // 読めた字幕の最初と最後の時刻を動画の長さと突き合わせ、どれだけ覆えたかを数字で出す
    // （取りこぼしていれば、その場で分かるように）
    let coveragePct = null, coverageFrom = null, coverageTo = null;
    const durSec = prog?.durationSec || 0;
    if (transcriptSource === 'panel' && durSec > 0
        && lastReadRange.minSec !== null && lastReadRange.maxSec !== null) {
      coverageFrom = lastReadRange.minSec;
      coverageTo = lastReadRange.maxSec;
      coveragePct = Math.round(((coverageTo - coverageFrom) / durSec) * 100);
    }

    if (!transcript) {
      log('字幕は取得できませんでした（概要欄だけで要約します）');
    } else if (coveragePct === null) {
      log(`字幕を取得しました（${transcript.length}字・方法=${transcriptSource}）`);
    } else {
      const detail = `${transcript.length}字・方法=${transcriptSource}`
        + `・${_fmtSec(coverageFrom)}〜${_fmtSec(coverageTo)} / 全${_fmtSec(durSec)}`
        + ` = 約${coveragePct}%`;
      // 9割を下回るなら、どこかを読み落としている。黙って進めずに警告を出す
      if (coveragePct < 90) log(`⚠️ 字幕を取得しましたが取りこぼしがあります（${detail}）`);
      else log(`字幕を取得しました（${detail}）`);
    }

    sentThisLoad.add(videoId);
    await post({
      videoId, url: location.href.split('&')[0],
      title: meta.title, channel: meta.channel,
      description: meta.description, publishedAt: meta.publishedAt,
      transcript, transcriptSource,
      // 読めた範囲（サーバーが残すので、後から取りこぼしが分かる）
      coveragePct, coverageFromSec: coverageFrom, coverageToSec: coverageTo,
      durationSec: prog?.durationSec || 0,
      watchedSec: prog?.watchedSec || 0,
      // 手動の送信は「もう一度きちんと取り込ませたい」という意思なので、取り込み済み・視聴が浅いという理由の
      // 見送りを飛び越えて上書きさせる
      force: manual,
    });
  }

  /**
   * 動画のページなら、一定の間隔で取り込みを試し始める。
   * @returns {void}
   */
  function start() {
    if (timer) clearInterval(timer);
    if (!/\/watch/.test(location.pathname)) return;
    timer = setInterval(() => { tryCapture().catch(() => {}); }, CHECK_INTERVAL_MS);
  }

  // ATTENTION: 動画の切り替えは、YouTube の合図と URL の変化の両方で拾うこと。ページは読み込み直されない
  window.addEventListener('yt-navigate-finish', () => { sentThisLoad.clear(); start(); });
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; sentThisLoad.clear(); start(); }
  }, 2000);
  start();

  // 見ている途中でも手で送れるようにする（動きの確認と、最後まで見ない動画のため）
  GM_registerMenuCommand('この動画をAI Radioへ送る（今すぐ）', () => {
    sentThisLoad.delete(currentVideoId());
    log('手動で送信します…');
    tryCapture({ manual: true }).catch((e) => log('失敗:', e.message));
  });

  log('待機中（15秒ごとに視聴状況を確認します。手動送信はTampermonkeyのメニューから）');
})();
