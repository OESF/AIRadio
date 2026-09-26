/**
 * @file 気象情報センターの「総観状況メモ」（前の回までの気象の状況を次の回へ引き継ぐ）
 *
 * コーナーで実際に話した内容から、次の回にも引き継ぐべきことを軽い LLM で抽出してファイルに溜め、
 * 次にそのコーナーを作るときにプロンプトへ渡す（formatNotesForPrompt）。専門家が定点観測を
 * 続けているような連続性を持たせるため。
 *
 * メモにするのは、気圧配置・前線・台風の動きなど数日単位で続く状況だけ（1文）。
 * 「今日は晴れ」のようなその場限りの実況は対象外。
 *
 * 主な利用元: lib/agent-knowledge-pack.js（記録は recordAgentNote から、プロンプトへは手持ちとして渡す）
 * 保存先: data/weather_corner_notes.json
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
const jsonFileStore = require('./json-file-store');

const NOTES_PATH = path.join(__dirname, '..', 'data', 'weather_corner_notes.json');
/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 3;

/**
 * 溜めたメモを読む。ファイルが無ければ空。
 * @returns {Array<{note: string, recordedAt: string}>}
 */
function readNotes() {
  return jsonFileStore.readJsonFile(NOTES_PATH, [], '[WeatherNotes]');
}

/**
 * メモを保存する（新しい MAX_STORED 件だけを残す）。
 * @param {Array<{note: string, recordedAt: string}>} list
 */
function writeNotes(list) {
  jsonFileStore.writeJsonFile(NOTES_PATH, list.slice(-MAX_STORED), '[WeatherNotes]');
}

/**
 * 話した内容からメモを抽出して保存する（1文）。
 *
 * 20文字未満の内容や API キーが無いときは何もしない。抽出・解析に失敗しても例外は出さない。
 * ATTENTION: LLM を呼ぶので、呼び出し側は await せずに呼ぶこと（コーナーの進行を止めない）。
 * @param {string} spokenText コーナーで話した内容
 * @param {{apiKey?: string, activitySessionId?: number}} [opts]
 * @returns {Promise<void>}
 */
async function recordNote(spokenText, { apiKey, activitySessionId } = {}) {
  if (!apiKey || !spokenText || spokenText.length < 20) return;

  let rawText;
  try {
    const systemInstruction = 'あなたは気象情報の記録係です。ラジオの天気コーナーで実際に話された内容から、'
      + '次回の放送でも参照すべき「現在進行中の気象状況」だけを、後から単独で読んでも意味が通る1文で'
      + '抽出してください。気圧配置・前線・台風の動向など、数日単位で継続する内容を優先してください。'
      + '「今日は晴れ」のような単発の実況情報（次回には価値が無い情報）は対象外です。'
      + '該当する継続的な状況が無ければ、noteを空文字にしてください。'
      + '出力はJSONのみとし、説明文などは一切含めないでください。';
    const userPrompt = `以下は天気コーナーで実際に話した内容です。\n\n${spokenText}\n\n`
      + '出力形式（このJSONのみ）: {"note": "..."}（該当が無ければ {"note": ""}）';

    // 軽い抽出なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'weather',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[WeatherNotes] メモ抽出に失敗（無視して続行）: ${e.message}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().debug(`[WeatherNotes] JSON解析に失敗（無視して続行）: ${e.message}`);
    return;
  }
  const note = (parsed?.note || '').trim();
  if (!note) return;

  const list = readNotes();
  list.push({ note, recordedAt: new Date().toISOString() });
  writeNotes(list);
  getLogger().info(`[WeatherNotes] 状況メモを記録: ${note}`);
}

/**
 * 直近のメモを、コーナーのプロンプトに差し込む段落にする。
 * @returns {string} メモが無ければ空文字
 */
function formatNotesForPrompt() {
  const list = readNotes();
  if (list.length === 0) return '';
  const recent = list.slice(-MAX_INJECTED);
  const lines = recent.map(e => {
    const d = new Date(e.recordedAt);
    const label = `${d.getMonth() + 1}月${d.getDate()}日${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `- [${label}] ${e.note}`;
  });
  return `\n\n【これまでの気象状況メモ（過去の自分の解説からの継続観測）】\n${lines.join('\n')}\n`
    + '継続している状況があれば「以前お伝えした〜が」のように連続性を持たせて解説してください。'
    + '矛盾する新しいデータが今回届いている場合は、そちらを優先してください。';
}

module.exports = { recordNote, formatNotesForPrompt };
