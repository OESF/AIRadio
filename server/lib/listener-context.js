/**
 * @file リスナーコンテキスト — リスナー本人の情報の台帳と、公開範囲の決定
 *
 * リスナー本人について分かっていること（リスナー像・予定とTODO・リクエスト履歴・最近見た動画の題名など）を
 * 台帳（SOURCES）に登録し、「どのエージェントに、どの場面で、どこまで見せるか」を POLICY 1か所で決める。
 * 各情報は「出典」と「いつの時点か」を添えてプロンプト用の文章に整形して返す。
 *
 * 公開の段階は3つ。放送に乗る情報なので、渡すかどうかだけでなく「口に出してよいか」を分けている。
 *   - use  … ◎ 使ってよい。持ち場に関係するときは具体的に口に出してよい
 *   - know … ○ 知っているだけ。判断材料として持つが、具体的な中身は口に出さない
 *   - none … × 渡さない
 *
 * 現在の公開範囲（変えるときは POLICY を書き換えれば、全出演の場に効く）:
 *   - 資産           金融情報センター・教授が◎、他は×（POLICY に載せず既存の経路で渡している）
 *   - 予定・TODO     キャスター・アシスタント・生活アドバイス・医師・秘書経由の相談が◎、他は○
 *   - 重要メール     キャスター・アシスタントが◎、ディレクターは自律ループの速報として○
 *   - リクエスト履歴 ディレクター（Live・音楽4チャンネル）とDJが○
 *   - 動画の題名     Liveのディレクターが○（人選の手がかり。中身は渡さない）
 *
 * 見た YouTube の「中身」は、ここでは扱わない。討論に出る専門家が自分で仕入れた知識として、
 * agent-knowledge-pack.js（DISCUSSION_ANALYSTS）から受け取る。ここの interests は題名だけ。
 *
 * 主な利用元:
 *   - lib/agent-knowledge-pack.js       … 全エージェントの手持ち（リスナー像・予定・リクエスト履歴）
 *   - lib/agent-director-decision.js    … Live ディレクターの人選材料（formatListenerNowForDirector）
 *   - agent-system.js                   … 予定の取得に成功したときに publishSchedule を呼ぶ
 *   - channel-base.js・音楽4チャンネル  … ディレクターの計画にリクエスト履歴を渡す
 *   - routes/dashboard-routes.js        … GET /api/listener-context（getSnapshot。本文は返さない）
 *
 * 保存先: data/listener_schedule.json（予定・TODO。.gitignore 対象）
 *
 * ATTENTION: The Answers は不特定多数に向けた討論番組という設定のため、リスナー本人の情報を一切渡さない。
 *            呼び出し側は scene 'none'（知識パックでは includeListener:false）で呼ぶこと。
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
const listenerRequests = require('./listener-requests');
const secretaryMemory = require('./secretary-memory');
const youtubeWatchStore = require('./youtube-watch-store');
const jsonFileStore = require('./json-file-store');

/** @typedef {'use'|'know'|'none'} Level 公開の段階 */

/**
 * 1つの場面での公開範囲。全員同じなら段階そのもの、人によって違うなら use・know に挙げた人がその段階、
 * それ以外は default。
 * @typedef {Level|{default?: Level, use?: string[], know?: string[]}} PolicyRule
 */

/**
 * 公開の段階。
 * @type {{USE: Level, KNOW: Level, NONE: Level}}
 */
const LEVEL = { USE: 'use', KNOW: 'know', NONE: 'none' };

const MUSIC_DIRECTORS = ['classic_director', 'jazz_director', 'mood_director', 'beatles_director'];

/**
 * 情報の種類ごとの公開範囲。
 *
 * 場面（scene）は 'broadcast'（放送・討論）と 'consult'（秘書経由の相談）の2つ。
 * 各場面は、全員が同じ段階なら文字列で、人によって違うなら `{ default, use, know }` で書く
 * （use・know に挙げた人がその段階、それ以外は default）。
 * @type {Record<string, {broadcast: PolicyRule, consult: PolicyRule}>}
 */
const POLICY = {
  // リスナー像は全員が受け取る（The Answers を除く）
  portrait: {
    broadcast: LEVEL.USE,
    consult: LEVEL.USE,
  },
  schedule: {
    broadcast: { default: LEVEL.KNOW, use: ['caster', 'assistant', 'life_advisor', 'doctor'] },
    consult: LEVEL.USE,
  },
  requestHistory: {
    broadcast: { default: LEVEL.NONE, know: ['director', 'music_dj', ...MUSIC_DIRECTORS] },
    consult: LEVEL.NONE,
  },
  // ディレクターの人選の手がかりとして、最近見た動画の題名だけを渡す（中身は渡さない）。
  // 外すときは know の配列から 'director' を消す。
  interests: {
    broadcast: { default: LEVEL.NONE, know: ['director'] },
    consult: LEVEL.NONE,
  },
};

/**
 * あるエージェントが、ある場面で、ある種類の情報をどの段階で持つかを返す。
 * @param {string} kind 情報の種類（POLICY のキー）
 * @param {string} agentKey エージェントのキー。The Answers の `live_` 付きのキーも受け付ける
 * @param {'broadcast'|'consult'|'none'} [scene] 'none' は常に none を返す（The Answers 用）
 * @returns {Level}
 */
function levelFor(kind, agentKey, scene = 'broadcast') {
  if (scene === 'none') return LEVEL.NONE;
  const rule = POLICY[kind]?.[scene];
  if (!rule) return LEVEL.NONE;
  if (typeof rule === 'string') return rule;
  const key = String(agentKey || '').replace(/^live_/, '');
  if (rule.use?.includes(key)) return LEVEL.USE;
  if (rule.know?.includes(key)) return LEVEL.KNOW;
  return rule.default || LEVEL.NONE;
}

// ── 予定・TODO の置き場所 ──────────────────────────────────────────────────
//
// 取得の実体は Live の agent-system.js（_refreshGoogleData、5分ごと）にある。他の出演の場
// （討論・秘書の相談など）からも読めるよう、取得に成功したときだけここへ置いてもらう。
// 再起動の直後も読めるようファイルにも保存する。古さは fetchedAt で判定するので、
// 長く止まっていた後に古い予定が渡ることはない。

const SCHEDULE_PATH = path.join(__dirname, '..', 'data', 'listener_schedule.json');
/** これより古い予定は渡さない（誤った「今日の予定」として話されるため）。 */
const SCHEDULE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let _schedule = jsonFileStore.readJsonFile(SCHEDULE_PATH, null, '[ListenerContext]')
  || { calendar: '', tasks: '', fetchedAt: 0 };

/**
 * 取得できた予定・TODOを置く（メモリとファイルの両方）。
 *
 * ATTENTION: 取得に成功したときだけ呼ぶこと。認証情報が無いときのダミーや、取得エラー時の
 *            代わりの文言を渡すと、実在しない予定をエージェントが本物として話してしまう。
 * @param {{calendar?: string, tasks?: string}} [data] 整形済みの予定とTODOの文章
 */
function publishSchedule({ calendar = '', tasks = '' } = {}) {
  _schedule = { calendar: String(calendar || '').trim(), tasks: String(tasks || '').trim(), fetchedAt: Date.now() };
  jsonFileStore.writeJsonFile(SCHEDULE_PATH, _schedule, '[ListenerContext]');
}

/**
 * 最後に置かれた予定・TODOを返す（古さの判定はしない）。
 * @returns {{calendar: string, tasks: string, fetchedAt: number}}
 */
function getSchedule() {
  return _schedule;
}

// ── 台帳 ───────────────────────────────────────────────────────────────────

const SIGNAL_FEED_PATH = path.join(__dirname, '..', 'data', 'secretary', 'memory', 'live_signal_feed.json');
const INTEREST_DAYS = 7;
const REQUEST_HISTORY_DAYS = 30;

/** ISO 文字列をミリ秒に変換する。空や不正な値は 0。 */
const _time = (iso) => { const t = iso ? new Date(iso).getTime() : 0; return Number.isFinite(t) ? t : 0; };

/**
 * 台帳の1項目。read() は同期で、LLM は呼ばない。
 * @typedef {object} ListenerSource
 * @property {string} label 見出し
 * @property {string} origin 出典。プロンプトの「出典: 」と一覧に使う
 * @property {number|null} maxAgeMs これより古ければ「古い」と判定し、エージェントには渡さない（null は期限なし）
 * @property {string} wiring どこへ渡しているか（一覧用の説明）
 * @property {string} [visibilityNote] POLICY に載せず既存の経路で渡しているものの公開範囲（一覧用の説明）
 * @property {() => {text: string, updatedAt: number}} read 本文と更新時刻（ミリ秒）を返す
 */

/**
 * リスナー本人に関する情報の台帳。
 * @type {Record<string, ListenerSource>}
 */
const SOURCES = {
  portrait: {
    label: 'リスナー像',
    origin: 'My Secretaryとの会話から学んだ内容・YouTube登録チャンネルの傾向',
    maxAgeMs: null,
    wiring: '知識パック（Liveの全コーナー・討論・秘書経由の相談）',
    read() {
      const updatedAt = Math.max(_time(secretaryMemory.readDigest()?.generatedAt),
        _time(secretaryMemory.readYoutubeInterestDigest()?.generatedAt));
      return { text: secretaryMemory.getListenerDigestForPrompt() || '', updatedAt };
    },
  },
  schedule: {
    label: '予定・TODO',
    origin: 'Googleカレンダー・Google ToDo（Liveが5分ごとに取得）',
    maxAgeMs: SCHEDULE_MAX_AGE_MS,
    wiring: '知識パック（全員）／キャスター・アシスタントは共通文でも受け取る',
    read() {
      const { calendar, tasks, fetchedAt } = _schedule;
      return { text: [calendar, tasks].filter(Boolean).join('\n'), updatedAt: fetchedAt || 0 };
    },
  },
  requestHistory: {
    label: 'リクエスト・アンコールの履歴',
    origin: `リクエストの記録（直近${REQUEST_HISTORY_DAYS}日）`,
    maxAgeMs: null,
    wiring: 'Live・音楽4チャンネルのディレクターの編成プロンプト／知識パック（DJ・曲のみ）',
    read() {
      const rows = listenerRequests.readRequests({ days: REQUEST_HISTORY_DAYS, limit: 100000 });
      return { text: rows.map((r) => r.label).join('\n'), updatedAt: rows[0]?.time || 0 };
    },
  },
  interests: {
    label: '最近見たYouTubeの題名',
    origin: `YouTube視聴履歴の取り込み（直近${INTEREST_DAYS}日）`,
    maxAgeMs: null,
    wiring: 'Liveディレクターの編成プロンプト（題名のみ）',
    read() {
      const list = youtubeWatchStore.listRecent({ days: INTEREST_DAYS, limit: 15 });
      const updatedAt = list.reduce((m, v) => Math.max(m, _time(v.importedAt)), 0);
      return { text: list.map((v) => v.title).join('\n'), updatedAt };
    },
  },
  // 以下は公開範囲を変えず、既存の経路で渡しているもの。一覧で見えるように登録だけしておく。
  finance: {
    label: '資産データ',
    origin: '資産の自動取り込み（My Secretaryが集計）',
    maxAgeMs: null,
    wiring: '金融情報センター・教授のコーナー（agent-system.js）',
    visibilityNote: '◎ 金融情報センター・教授',
    read() {
      const s = secretaryMemory.readFinancePublicSummary();
      return { text: s?.text || '', updatedAt: _time(s?.generatedAt) };
    },
  },
  email: {
    label: '重要メールの概要',
    origin: 'Gmail（Liveが5分ごとに取得）',
    maxAgeMs: null,
    wiring: 'キャスター・アシスタントの共通文（agent-system.js）。本文はこの台帳に置かない',
    visibilityNote: '◎ キャスター・アシスタント',
    read() {
      // ATTENTION: メールにはリスナー以外の人の名前や用件が含まれるため、公開範囲を広げない。
      //            本文を共有の置き場所へ持ち出さず、取得時刻だけを返す（予定と同じ処理で取得している）。
      return { text: '', updatedAt: _schedule.fetchedAt || 0 };
    },
  },
  signals: {
    label: '自律ループの速報',
    origin: 'My Secretaryの監視（メール・天気・報道・金融の変化）',
    maxAgeMs: null,
    wiring: 'Liveディレクターの編成プロンプト・キャスターの話題づくり（secretary-loop.js）',
    visibilityNote: '○ ディレクター／話題の起点としてキャスター',
    read() {
      const feed = jsonFileStore.readJsonFile(SIGNAL_FEED_PATH, [], '[ListenerContext]');
      const list = Array.isArray(feed) ? feed : [];
      const updatedAt = list.reduce((m, x) => Math.max(m, _time(x.detectedAt)), 0);
      return { text: list.map((x) => x.text).join('\n'), updatedAt };
    },
  },
};

/**
 * 台帳の1項目を読む。読み取りに失敗しても例外を出さず、空として扱う。
 * @param {string} key SOURCES のキー
 * @returns {{text: string, updatedAt: number}}
 */
function _readSource(key) {
  try {
    return SOURCES[key].read();
  } catch {
    return { text: '', updatedAt: 0 };
  }
}

/**
 * 項目が古すぎるか（maxAgeMs を超えたか、更新時刻が無いか）。期限なしの項目は常に false。
 * @param {string} key SOURCES のキー
 * @param {number} updatedAt 更新時刻（ミリ秒）
 * @returns {boolean}
 */
function _isStale(key, updatedAt) {
  const max = SOURCES[key].maxAgeMs;
  return !!(max && (!updatedAt || Date.now() - updatedAt > max));
}

/** ミリ秒を「2026/09/18 10:30」の形にする。 */
function _fmtTime(ms) {
  return new Date(ms).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * プロンプトの各項目に添える「（出典: ◯◯／◯月◯日 ◯時点）」の1行。
 * @param {string} key SOURCES のキー
 * @param {number} updatedAt 更新時刻（ミリ秒）。0 なら時点を省く
 * @returns {string}
 */
function _provenance(key, updatedAt) {
  const at = updatedAt ? `／${_fmtTime(updatedAt)}時点` : '';
  return `（出典: ${SOURCES[key].origin}${at}）`;
}

// ── プロンプト用の書式 ─────────────────────────────────────────────────────

/**
 * リスナー像を出典付きで返す。渡さない段階、またはデータが無ければ空文字。
 * @param {string} agentKey
 * @param {{scene?: 'broadcast'|'consult'|'none'}} [opts]
 * @returns {string}
 */
function formatPortraitForPrompt(agentKey, { scene = 'broadcast' } = {}) {
  if (levelFor('portrait', agentKey, scene) === LEVEL.NONE) return '';
  const { text, updatedAt } = _readSource('portrait');
  if (!text) return '';
  return `${text}\n${_provenance('portrait', updatedAt)}\n`;
}

/**
 * 予定・TODOを、段階に応じた使い方の指示付きで返す。
 * 渡さない段階、データが無い、または古すぎる（SCHEDULE_MAX_AGE_MS 超）場合は空文字。
 * @param {string} agentKey
 * @param {{scene?: 'broadcast'|'consult'|'none', listenerName?: string}} [opts]
 *   listenerName は見出しの「◯◯さんの予定」に使う。空なら「リスナーの予定」
 * @returns {string}
 */
function formatScheduleForPrompt(agentKey, { scene = 'broadcast', listenerName = '' } = {}) {
  const level = levelFor('schedule', agentKey, scene);
  if (level === LEVEL.NONE) return '';
  const { calendar, tasks, fetchedAt } = _schedule;
  if (_isStale('schedule', fetchedAt)) return '';
  if (!calendar && !tasks) return '';

  const body = [
    calendar ? `▼予定（現在から3日先まで）\n${calendar}` : '',
    tasks ? `▼未完了のTODO\n${tasks}` : '',
  ].filter(Boolean).join('\n');

  let usage;
  if (scene === 'consult') {
    usage = '相談への回答に関係があれば、具体的な予定やTODOを参照して構いません'
      + '（例: 立て込んでいる日を避けた提案、期限の近いTODOを踏まえた助言）。関係が無ければ触れないでください。';
  } else if (level === LEVEL.USE) {
    usage = 'あなたの持ち場に関係するときは、具体的に触れて構いません'
      + '（例: 忙しい日に合った手早い献立、予定が立て込んだ週の体調への気遣い）。'
      + 'ただし予定を読み上げるだけの紹介はしないこと。キャスターが既に紹介した予定を、'
      + '改めて一つずつ伝え直す必要はありません。持ち場と関係が無ければ触れないでください。';
  } else {
    usage = '**判断材料として知っておくだけ**にしてください。予定の名前・日時・TODOの中身など'
      + '具体的なことは口に出さないこと。話の流れで自然なときに「お忙しい時期ですね」程度の'
      + '気遣いを添えるまでは構いません。';
  }
  const whose = listenerName ? `${listenerName}さん` : 'リスナー';
  return `\n\n【${whose}の予定・TODO】${_provenance('schedule', fetchedAt)}\n${body}\n${usage}\n`;
}

/**
 * リクエスト・アンコールの直近の履歴を「何が何回頼まれたか」に集計し、上位10件を返す。
 * 放送では読み上げず、編成・選曲の判断材料として使うよう指示を添える。
 * @param {string} agentKey 段階の判定に使う（director / music_dj / classic_director など）
 * @param {{channel: string, kinds?: string[]|null, lang?: 'ja'|'en'}} opts
 *   channel は対象チャンネル、kinds は絞り込む種類（null なら全種類）、lang は英語番組なら 'en'
 * @returns {string} 渡さない段階、または履歴が無ければ空文字
 */
function formatRequestHistoryForPrompt(agentKey, { channel, kinds = null, lang = 'ja' } = {}) {
  if (levelFor('requestHistory', agentKey, 'broadcast') === LEVEL.NONE) return '';
  const rows = listenerRequests.readRequests({ days: REQUEST_HISTORY_DAYS, channel, limit: 100000 })
    .filter((r) => !kinds || kinds.includes(r.kind));
  if (rows.length === 0) return '';

  // 集計の鍵は [種類, 内容] の組を JSON にしたもの（区切り文字が内容と衝突しないように）
  const counts = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.kind, r.label]);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, n]) => { const [kind, label] = JSON.parse(k); return { kind, label, n }; });
  const latest = rows[0]?.time || 0;

  if (lang === 'en') {
    const lines = top.map(({ kind, label, n }) => `- ${label} (${kind}, ${n}x)`);
    const at = latest ? `, latest ${new Date(latest).toISOString().slice(0, 10)}` : '';
    return `\n\n[Listener's requests in the last ${REQUEST_HISTORY_DAYS} days — ${rows.length} total${at}]\n${lines.join('\n')}\n`
      + 'Use this as a hint about the listener\'s tastes when planning. Do not read this list out on air.\n';
  }
  const lines = top.map(({ kind, label, n }) => `- ${label}（${listenerRequests.KINDS[kind] || kind}・${n}回）`);
  return `\n\n【直近${REQUEST_HISTORY_DAYS}日のリスナーからのリクエスト（計${rows.length}件）】${_provenance('requestHistory', latest)}\n${lines.join('\n')}\n`
    + 'リスナーが何を求めているかを知る手がかりとして、編成・選曲の判断に反映してください。'
    + 'この一覧そのものを放送で読み上げることはしないでください'
    + '（話の流れで「以前リクエストいただいた〜」と軽く触れる程度は構いません）。\n';
}

/**
 * 最近見た動画の題名（直近 INTEREST_DAYS 日・最大15本）を返す。動画の中身は渡さない。
 * @param {string} agentKey
 * @returns {string} 渡さない段階、または動画が無ければ空文字
 */
function formatInterestsForPrompt(agentKey) {
  if (levelFor('interests', agentKey, 'broadcast') === LEVEL.NONE) return '';
  const list = youtubeWatchStore.listRecent({ days: INTEREST_DAYS, limit: 15 });
  if (list.length === 0) return '';
  const updatedAt = list.reduce((m, v) => Math.max(m, _time(v.importedAt)), 0);
  const lines = list.map((v) => {
    const d = v.importedAt ? new Date(v.importedAt) : null;
    return `- ${d ? `${d.getMonth() + 1}/${d.getDate()} ` : ''}「${v.title}」（${v.channel}）`;
  });
  return `\n\n【リスナーが最近見た動画の題名（直近${INTEREST_DAYS}日・${list.length}本）】${_provenance('interests', updatedAt)}\n${lines.join('\n')}\n`;
}

/**
 * ディレクターが人選・編成を判断するための「リスナーの今」を返す。
 *
 * リスナー像・予定・最近の関心・リクエスト履歴を、それぞれ POLICY の段階に従ってまとめる。
 * ディレクターは放送で話さないため、段階の違い（◎/○）は「中身を番組の台本に書き写さない」
 * という1つの指示にまとめている。
 * @param {string} agentKey 'director'
 * @param {{channel: string}} opts
 * @returns {string} どれも無ければ空文字
 */
function formatListenerNowForDirector(agentKey, { channel }) {
  const parts = [
    formatPortraitForPrompt(agentKey),
    formatScheduleForPrompt(agentKey),
    formatInterestsForPrompt(agentKey),
    formatRequestHistoryForPrompt(agentKey, { channel }),
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return `\n\n━━━━ リスナーの今（人選・編成の手がかり）━━━━${parts.join('')}\n`
    + '【使い方】ゲストは**話題との相性で選ぶのが最優先**です。そのうえで、上のリスナーの状況や'
    + '最近の関心に照らして「今この人の視点がいちばん響くか」も考慮してください'
    + '（例: 体調や健康に関わる予定・関心が見えるなら健康の専門家、流行や消費に関心が向いているなら'
    + 'その分野の専門家）。ただしリスナー情報を理由に毎回同じ人を選ぶことはしないでください。'
    + 'ここに書かれた予定・題名・リクエストの中身を big_topic などにそのまま書き写すことはしないでください。\n';
}

// ── 台帳の一覧（GET /api/listener-context） ───────────────────────────────

const _levelLabel = { use: '◎', know: '○' };

/**
 * POLICY を人が読める形にする（例: 「◎ caster・assistant ／ ○ その他全員」）。
 * @param {string} kind 情報の種類
 * @returns {{broadcast: string, consult: string, theAnswers: string}|null} POLICY に無い種類は null
 */
function _describePolicy(kind) {
  const rule = POLICY[kind];
  if (!rule) return null;
  const describe = (r) => {
    if (typeof r === 'string') return r === LEVEL.NONE ? '× 全員' : `${_levelLabel[r]} 全員`;
    const out = [];
    if (r.use?.length) out.push(`◎ ${r.use.join('・')}`);
    if (r.know?.length) out.push(`○ ${r.know.join('・')}`);
    if (r.default && r.default !== LEVEL.NONE) out.push(`${_levelLabel[r.default]} その他全員`);
    return out.length ? out.join(' ／ ') : '× 全員';
  };
  return { broadcast: describe(rule.broadcast), consult: describe(rule.consult), theAnswers: '× 全員' };
}

/**
 * 台帳の全項目の状態を返す（管理画面の一覧用）。本文は含めず、文字数だけを返す。
 * @returns {Array<{key:string,label:string,origin:string,wiring:string,updatedAt:number|null,
 *   ageMinutes:number|null,status:'fresh'|'stale'|'empty',chars:number,visibility:object|string}>}
 */
function getSnapshot() {
  return Object.entries(SOURCES).map(([key, def]) => {
    const { text, updatedAt } = _readSource(key);
    const chars = (text || '').length;
    // メールは本文を置かないので、取得時刻があれば「新しい」とみなす
    const status = _isStale(key, updatedAt) ? 'stale' : (chars > 0 || (key === 'email' && updatedAt) ? 'fresh' : 'empty');
    return {
      key,
      label: def.label,
      origin: def.origin,
      wiring: def.wiring,
      updatedAt: updatedAt || null,
      ageMinutes: updatedAt ? Math.round((Date.now() - updatedAt) / 60000) : null,
      status,
      chars,
      visibility: _describePolicy(key) || def.visibilityNote || null,
    };
  });
}

module.exports = {
  LEVEL, POLICY, SOURCES, levelFor,
  publishSchedule, getSchedule,
  formatPortraitForPrompt, formatScheduleForPrompt, formatRequestHistoryForPrompt,
  formatInterestsForPrompt, formatListenerNowForDirector,
  getSnapshot,
};
