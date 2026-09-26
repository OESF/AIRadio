/**
 * @file ジャーナリストのコーナーの「継続観測メモ」（追いかけている話題・伏線を引き継ぐ）
 *
 * コーナーで実際に話した内容から、次の回にも引き継ぐべきことを軽い LLM で抽出してファイルに溜め、
 * 次にそのコーナーを作るときにプロンプトへ渡す（formatNotesForPrompt）。専門家が定点観測を
 * 続けているような連続性を持たせるため。
 *
 * メモにするのは、今後の動きが注目される人物・組織、裏取りが済んでいない情報など、引き続き追いかける
 * 話題（最大3件）。このキャラクターには単発の速報より「追い続けている話」に価値がある。
 * ラジオで話した内容のほか、見た YouTube の要約からも記録する（sourceHint で材料が何かを伝える）。
 *
 * 主な利用元: lib/agent-knowledge-pack.js（記録は recordAgentNote から、プロンプトへは手持ちとして渡す）
 * 保存先: data/journalist_corner_notes.json
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

const NOTES_PATH = path.join(__dirname, '..', 'data', 'journalist_corner_notes.json');
/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 5;

/**
 * 溜めたメモを読む。ファイルが無ければ空。
 * @returns {Array<{note: string, recordedAt: string}>}
 */
function readNotes() {
  return jsonFileStore.readJsonFile(NOTES_PATH, [], '[JournalistNotes]');
}

/**
 * メモを保存する（新しい MAX_STORED 件だけを残す）。
 * @param {Array<{note: string, recordedAt: string}>} list
 */
function writeNotes(list) {
  jsonFileStore.writeJsonFile(NOTES_PATH, list.slice(-MAX_STORED), '[JournalistNotes]');
}

/**
 * 話した内容からメモを抽出して保存する（0〜3件）。
 *
 * 20文字未満の内容や API キーが無いときは何もしない。抽出・解析に失敗しても例外は出さない。
 * ATTENTION: LLM を呼ぶので、呼び出し側は await せずに呼ぶこと（コーナーの進行を止めない）。
 * @param {string} spokenText コーナーで話した内容
 * @param {{apiKey?: string, activitySessionId?: number, sourceHint?: string}} [opts]
 *   sourceHint は材料の説明の書き出し（YouTube の要約から記録するときなど）。省略するとコーナーで話した内容として扱う
 * @returns {Promise<void>}
 */
async function recordNote(spokenText, { apiKey, activitySessionId, sourceHint = '' } = {}) {
  if (!apiKey || !spokenText || spokenText.length < 20) return;

  let rawText;
  try {
    const systemInstruction = 'あなたは謎めいたジャーナリストの記録係です。ラジオのコーナーで実際に話された'
      + '内容から、次回以降の放送でも「引き続き追いかけている情報筋・裏取り中の話題」として'
      + '言及する価値がある事項だけを、後から単独で読んでも意味が通る短い1文ずつで抽出して'
      + 'ください（例: 今後の展開が注目される人物・組織の動き、裏取りが完了していない情報、'
      + '継続取材中と述べたテーマなど）。単発で完結したニュースの紹介は対象外です。'
      + '該当する事項が無ければ空配列を、あれば最大3件までにしてください。'
      + '出力はJSON配列のみとし、説明文などは一切含めないでください。';
    const userPrompt = `${sourceHint || '以下はジャーナリストXのコーナーで実際に話した内容です。'}\n\n${spokenText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["追跡中の話題1", "追跡中の話題2", ...]（無ければ []）';

    // 軽い抽出なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'journalist',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[JournalistNotes] メモ抽出に失敗（無視して続行）: ${e.message}`);
    return;
  }

  let notes;
  try {
    notes = JSON.parse(rawText);
  } catch (e) {
    getLogger().debug(`[JournalistNotes] JSON解析に失敗（無視して続行）: ${e.message}`);
    return;
  }
  if (!Array.isArray(notes) || notes.length === 0) return;

  const list = readNotes();
  const recordedAt = new Date().toISOString();
  let added = 0;
  for (const n of notes) {
    const note = typeof n === 'string' ? n.trim() : '';
    if (!note) continue;
    list.push({ note, recordedAt });
    added++;
  }
  if (added > 0) {
    writeNotes(list);
    getLogger().info(`[JournalistNotes] 継続観測メモを${added}件記録`);
  }
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
    const label = `${d.getMonth() + 1}月${d.getDate()}日`;
    return `- [${label}時点] ${e.note}`;
  });
  return `\n\n【継続観測メモ（あなたが引き続き追っている話題）】\n${lines.join('\n')}\n`
    + '今回の検索結果にこれらの続報・進展が含まれていれば「以前触れた〜の件ですが」のように'
    + '独自の情報網で追い続けている雰囲気で触れてください。続報が見つからなければ無理に'
    + '触れる必要はありません。';
}

module.exports = { recordNote, formatNotesForPrompt };
