/**
 * @file ディレクターの掲示板（各番組のディレクターが直近に決めた方針を共有する）
 *
 * 各番組のディレクターが、他のディレクターが何を決めたかを知るための掲示板。方針が決まった時点で1件ずつ書く。
 *   - Live のディレクター … 編成方針を決めたとき（LLM で判断した回だけ。lib/agent-director-decision.js）
 *   - 音楽4チャンネル     … セッションの計画を決めたとき（channel-base.js の _writeDirectorSessionDiary）
 *   - The Answers         … エピソードの議題が決まったとき（agent-system-the-answers.js）
 * 読むのは次の2つ:
 *   - formatOthersForDirector … 自分以外のディレクターの直近の方針（編成・計画のプロンプトへ）
 *   - formatOwnHistory        … 自分が最近企画したテーマ（The Answers に出演するときの見識として）
 *
 * ATTENTION: 方針の中身だけを置くこと。リスナー本人の情報（予定・資産など）は置かない。
 *
 * 保存先: data/director_board.json
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
const jsonFileStore = require('./json-file-store');

const BOARD_PATH = path.join(__dirname, '..', 'data', 'director_board.json');
/** ディレクターごとに残す件数。 */
const KEEP_PER_DIRECTOR = 12;
/** 他のディレクターの方針として見せるのは、この時間以内のものだけ。 */
const OTHERS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * ディレクターのキー → 番組名。書き込むときに programName が渡されなかった場合だけ使う
 * （番組名は管理画面で変えられるので、普段は config から渡してもらう）。
 */
const PROGRAM_LABELS = {
  director: 'AI Radio Live',
  classic_director: '静寂のスコア',
  jazz_director: '琥珀色のインプロヴィゼーション',
  mood_director: 'トワイライト・ラウンジ',
  beatles_director: 'Eight Days A Week',
  answers_director: 'The Answers',
};

/**
 * 掲示板を読む。無い・壊れているときは空の掲示板。
 * @returns {{posts: Record<string, Array<{at: number, directorName: string, programName: string, title: string, detail: string}>>}}
 */
function _read() {
  const data = jsonFileStore.readJsonFile(BOARD_PATH, null, '[DirectorBoard]');
  return data && typeof data === 'object' && data.posts ? data : { posts: {} };
}

/**
 * 方針を1件書き込む（ディレクターごとに新しい KEEP_PER_DIRECTOR 件を残す）。
 * @param {{directorKey: string, directorName?: string, programName?: string,
 *          title: string, detail?: string}} post
 *   title はテーマや「本日の大きな話題」など一言で表せる方針（200文字まで）、
 *   detail は補足（狙い・起用したゲストなど。300文字まで）。directorKey か title が空なら書かない
 */
function post({ directorKey, directorName = '', programName = '', title, detail = '' }) {
  if (!directorKey || !title) return;
  const data = _read();
  const list = Array.isArray(data.posts[directorKey]) ? data.posts[directorKey] : [];
  list.unshift({
    at: Date.now(),
    directorName: String(directorName || ''),
    programName: String(programName || PROGRAM_LABELS[directorKey] || directorKey),
    title: String(title).slice(0, 200),
    detail: String(detail || '').slice(0, 300),
  });
  data.posts[directorKey] = list.slice(0, KEEP_PER_DIRECTOR);
  jsonFileStore.writeJsonFile(BOARD_PATH, data, '[DirectorBoard]');
}

/** @param {number} ms @returns {string} 「9/18 10:30」の形 */
function _timeLabel(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 自分以外のディレクターの直近の方針（1人1件・12時間以内）を、プロンプト用の段落にする。
 * @param {string} selfKey 自分のディレクターのキー
 * @param {{lang?: 'ja'|'en', usageNote?: string}} [opts] lang は見出しの言語（Jazz は英語）、
 *   usageNote は末尾に添える使い方の指示
 * @returns {string} 無ければ空文字
 */
function formatOthersForDirector(selfKey, { lang = 'ja', usageNote = '' } = {}) {
  const now = Date.now();
  const lines = [];
  for (const [key, list] of Object.entries(_read().posts)) {
    if (key === selfKey || !Array.isArray(list) || list.length === 0) continue;
    const p = list[0];
    if (now - p.at > OTHERS_MAX_AGE_MS) continue;
    const who = p.directorName ? `${p.programName}・${p.directorName}` : p.programName;
    lines.push(`- [${who}（${_timeLabel(p.at)}）] ${p.title}${p.detail ? ` — ${p.detail}` : ''}`);
  }
  if (lines.length === 0) return '';
  const head = lang === 'en'
    ? '\n\n[Latest decisions by the other program directors of this radio station (for reference)]\n'
    : '\n\n【他の番組のディレクターが直近に決めた方針（参考）】\n';
  return `${head}${lines.join('\n')}\n${usageNote ? `${usageNote}\n` : ''}`;
}

/**
 * 自分が最近企画したテーマの履歴（新しい順）を、プロンプト用の段落にする。
 * @param {string} directorKey
 * @param {{limit?: number, heading?: string}} [opts] limit は件数（既定 8）、heading は見出しの差し替え
 * @returns {string} 無ければ空文字
 */
function formatOwnHistory(directorKey, { limit = 8, heading = '' } = {}) {
  const list = (_read().posts[directorKey] || []).slice(0, limit);
  if (list.length === 0) return '';
  const head = heading || `【あなたの番組『${list[0].programName}』で最近企画したテーマ】`;
  const lines = list.map((p) => `- ${_timeLabel(p.at)}「${p.title}」${p.detail ? ` — ${p.detail}` : ''}`);
  return `\n\n${head}\n${lines.join('\n')}\n`;
}

module.exports = { post, formatOthersForDirector, formatOwnHistory, PROGRAM_LABELS, BOARD_PATH };
