/**
 * @file ジャーナリストのウォッチリストの定期監視（1日4回、要人の最新の発言・発表を取ってくる）
 *
 * ウォッチリスト（config.journalist_watchlist）の人物・機関の直近の発言・発表を、0時・6時・12時・18時の
 * 1日4回、Google 検索付きで取得して保存する。取得したものは次の2か所で使う。
 *   - Live のジャーナリストのコーナー（agent-system.js の _buildJournalistCornerContext）: その場の検索の前に、
 *     「既に把握している最新の情報」として渡す（その場の検索は置き換えず、上乗せする）
 *   - 秘書の get_watchlist_updates ツール: 「トランプさんは何か言ってた？」などにすぐ答える
 *
 * 新しいかどうかは機械的には判定できない（公開日時が無い）ので、前回の要約をプロンプトに含めて
 * 「そこに無い新しいものだけを書く」よう指示する。保存するのは直近の1回分だけ（上書き）。
 *
 * コストを抑えるため、モデルは 'research' のティア（前回との突き合わせに推論が要るので、最も軽いモデルは使わない）。
 *
 * ATTENTION: プロンプトに出す担当の名前は、必ず設定から引くこと（CLAUDE.md 1節）。管理画面で
 *            変えられるため、直書きすると変更に追従しない。
 *
 * 主な利用元: lib/secretary-loop.js（定期処理のたびに呼ぶ）・agent-system.js・lib/secretary-tools.js
 * 保存先: data/secretary/journalist-watch.json
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

const path = require('path');
const { generateText } = require('./llm-client');
const { getLogger } = require('../logger');
const activityDb = require('../activity-db');
const jsonFileStore = require('./json-file-store');

const WATCH_PATH = path.join(__dirname, '..', 'data', 'secretary', 'journalist-watch.json');
/** 取得する時刻（時）。 */
const WATCH_HOURS = [0, 6, 12, 18];

/**
 * 保存した直近の取得結果を読む。
 * @returns {{digest: string, fetchedAt: number, slotKey: string}}
 */
function readWatch() {
  return jsonFileStore.readJsonFile(WATCH_PATH, { digest: '', fetchedAt: 0, slotKey: '' }, '[JournalistWatch]');
}

/**
 * 取得結果を保存する（上書き）。
 * @param {{digest: string, fetchedAt: number, slotKey: string}} data
 */
function writeWatch(data) {
  jsonFileStore.writeJsonFile(WATCH_PATH, data, '[JournalistWatch]');
}

/**
 * 今が属する取得の枠（例: 2026-09-01-12）。この値が変わったら取得する。
 * @param {Date} [now]
 * @returns {string}
 */
function _currentSlotKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hour = [...WATCH_HOURS].reverse().find((h) => now.getHours() >= h) ?? 0;
  return `${y}-${m}-${d}-${String(hour).padStart(2, '0')}`;
}

/**
 * 人物・機関の一覧を「・」でつなぐ（文字列でも { name } でもよい）。
 * @param {Array<string|{name: string}>} [arr]
 * @returns {string}
 */
function _nameList(arr) {
  return (arr || []).map((e) => (typeof e === 'string' ? e : e.name)).join('・');
}

/**
 * ウォッチリストを、分類ごとの名前の一覧（1分類1行）にする。
 *
 * agent-system.js の _buildJournalistCornerContext などにも似た処理があるが、空の分類の扱いなどが
 * 少しずつ違うので、あえて共通にしていない（共通にすると挙動が変わる）。
 * @param {Record<string, any>} config
 * @returns {string} 空なら空文字
 */
function _buildWatchlistLines(config) {
  const wl = config.journalist_watchlist || {};
  return [
    ['日本政府・省庁', wl.japan_official],
    ['日本政治', wl.japan_politics],
    ['米国政府・政治', [...(wl.us_official || []), ...(wl.us_politics || [])]],
    ['テック・ビジネス', wl.tech_business],
    ['世界の指導者', wl.world_leaders],
    ['国際機関', wl.international_orgs],
    ['一次通信社', wl.primary_wire],
    ['スポーツ', wl.sports],
  ]
    .map(([label, arr]) => (arr && arr.length ? `- ${label}: ${_nameList(arr)}` : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 取得の枠が変わっていれば、ウォッチリストの最新の発言・発表を取得して保存する。
 * 自律ループの設定（secretary_loop.enabled）に関わらず、定期処理のたびに呼んでよい。
 * 失敗したら次の枠でやり直す。
 * @param {{config: Record<string, any>, creds: Record<string, any>}} args
 * @returns {Promise<void>}
 */
async function maybeRunJournalistWatch({ config, creds }) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) return;

  const slotKey = _currentSlotKey();
  const watch = readWatch();
  if (watch.slotKey === slotKey) return;

  const lines = _buildWatchlistLines(config);
  if (!lines) return;

  const previousBlock = watch.digest
    ? `【前回（${new Date(watch.fetchedAt).toLocaleString('ja-JP')}時点）に把握していた内容】\n${watch.digest}\n\n`
    : '';

  const _jnName = config.agents?.journalist?.name || '謎のジャーナリストX';
  const prompt = `${previousBlock}あなたは「${_jnName}」です。以下の人物・機関について、`
    + '直近の発言・発表をGoogle検索で確認してください。情報源の優先順位は'
    + '①X本人・公式機関の直接投稿 ②公式プレスリリース ③Reuters・AP・Bloombergの速報 ④その他、の順です。\n\n'
    + `▼ ウォッチ対象:\n${lines}\n\n`
    + (watch.digest
      ? '【重要】上の「前回把握していた内容」に既に含まれているものは書かないでください。'
        + 'それ以降に出た新しい発言・発表だけを、人物名・要点・（分かれば）日時の形で簡潔に'
        + '列挙してください。特に新しい動きが無ければ「新しい動きはありません」とだけ書いてください。'
      : '各人物・機関について、直近の主要な発言・発表を人物名・要点・（分かれば）日時の形で'
        + '簡潔に列挙してください。');

  const activitySessionId = activityDb.openSession('secretary');
  let text;
  try {
    ({ text } = await generateText({
      tier: 'research',
      apiKey,
      prompt,
      grounded: true,
      agentKey: 'journalist_watch',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[JournalistWatch] 取得に失敗（次のスロットで再試行します）: ${e.message}`);
    activityDb.closeSession(activitySessionId);
    return;
  }
  activityDb.closeSession(activitySessionId);
  if (!text.trim()) return;

  writeWatch({ digest: text.trim(), fetchedAt: Date.now(), slotKey });
  getLogger().info(`[JournalistWatch] 定期取得完了（${text.trim().length}文字、slot=${slotKey}）`);
}

/**
 * 直近の取得結果を返す（番組と秘書の両方が使う）。
 * @returns {{digest: string, fetchedAt: number, slotKey: string}|null} まだ一度も取得していなければ null
 */
function getLatestDigest() {
  const watch = readWatch();
  return watch.digest ? watch : null;
}

module.exports = { maybeRunJournalistWatch, getLatestDigest, WATCH_HOURS };
