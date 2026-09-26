/**
 * @file 生活アドバイスのコーナーの「継続観測メモ」（リスナーに勧めたことを、あとで気にかけるために引き継ぐ）
 *
 * コーナーで実際に話した内容から、次の回にも引き継ぐべきことを軽い LLM で抽出してファイルに溜め、
 * 次にそのコーナーを作るときにプロンプトへ渡す（formatNotesForPrompt）。専門家が定点観測を
 * 続けているような連続性を持たせるため。
 *
 * メモにするのは、リスナーに勧めた具体的な行動・提案（最大3件）。次の回に「先日の〜、試してみましたか？」と
 * 一言気にかけるための種にする。
 * 同じ話を繰り返さないための「紹介済みの話題」の記録（agent-system.js の _lifeAdvisorHistory）とは別の仕組み。
 *
 * 主な利用元: lib/agent-knowledge-pack.js（記録は recordAgentNote から、プロンプトへは手持ちとして渡す）
 * 保存先: data/life_advisor_corner_notes.json
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

const NOTES_PATH = path.join(__dirname, '..', 'data', 'life_advisor_corner_notes.json');
/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 3;

/**
 * 溜めたメモを読む。ファイルが無ければ空。
 * @returns {Array<{note: string, recordedAt: string}>}
 */
function readNotes() {
  return jsonFileStore.readJsonFile(NOTES_PATH, [], '[LifeAdvisorNotes]');
}

/**
 * メモを保存する（新しい MAX_STORED 件だけを残す）。
 * @param {Array<{note: string, recordedAt: string}>} list
 */
function writeNotes(list) {
  jsonFileStore.writeJsonFile(NOTES_PATH, list.slice(-MAX_STORED), '[LifeAdvisorNotes]');
}

/**
 * 話した内容からメモを抽出して保存する（0〜3件）。
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
    const systemInstruction = 'あなたは生活アドバイザーコーナーの記録係です。ラジオで実際に話された'
      + '内容から、後日「あれ、試してみましたか？」のように気にかけてフォローアップできる'
      + '「リスナーに勧めた具体的な行動・提案」だけを、後から単独で読んでも意味が通る短い'
      + '1文ずつで抽出してください（例: 勧めた具体的な料理・習慣・お店・グッズの名前）。'
      + '一般的な豆知識・季節の話題紹介など、フォローアップの必要がないものは対象外です。'
      + '該当する事項が無ければ空配列を、あれば最大2件までにしてください。出力はJSON配列'
      + 'のみとし、説明文などは一切含めないでください。';
    const userPrompt = `以下は生活アドバイザーコーナーで実際に話した内容です。\n\n${spokenText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["勧めた行動1", "勧めた行動2", ...]（無ければ []）';

    // 軽い抽出なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'life_advisor',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[LifeAdvisorNotes] メモ抽出に失敗（無視して続行）: ${e.message}`);
    return;
  }

  let notes;
  try {
    notes = JSON.parse(rawText);
  } catch (e) {
    getLogger().debug(`[LifeAdvisorNotes] JSON解析に失敗（無視して続行）: ${e.message}`);
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
    getLogger().info(`[LifeAdvisorNotes] 継続観測メモを${added}件記録`);
  }
}

/**
 * 直近のメモを、コーナーのプロンプトに差し込む段落にする。
 * @returns {string} メモが無ければ空文字
 */
function formatNotesForPrompt() {
  const list = readNotes();
  if (list.length === 0) return '';
  // 直近の数件だけを使う（何か月も前の提案を急に持ち出すと不自然なため）
  const recent = list.slice(-MAX_INJECTED);
  const lines = recent.map(e => {
    const d = new Date(e.recordedAt);
    const label = `${d.getMonth() + 1}月${d.getDate()}日`;
    return `- [${label}に勧めた] ${e.note}`;
  });
  return `\n\n【以前リスナーに勧めたこと（気が向いたらフォローアップに使ってよい）】\n${lines.join('\n')}\n`
    + '今回のテーマと関係がある場合のみ、「そういえば先日の〜、試してみましたか？」のように'
    + '軽く一言気にかけてください。関係が薄い・不自然になる場合は無理に触れなくてよいです。';
}

module.exports = { recordNote, formatNotesForPrompt };
