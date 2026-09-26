/**
 * @file ワールドレポートの「継続観測メモ」（訪れた土地を超えて見えてきた共通のテーマを引き継ぐ）
 *
 * コーナーで実際に話した内容から、次の回にも引き継ぐべきことを軽い LLM で抽出してファイルに溜め、
 * 次にそのコーナーを作るときにプロンプトへ渡す（formatNotesForPrompt）。専門家が定点観測を
 * 続けているような連続性を持たせるため。
 *
 * ワールドレポートは毎回違う都市を伝えるので、「同じ場所の続報」という形の連続性は成り立たない。
 * 代わりに、いくつもの土地を巡る特派員として気づいた、地域を超えて繰り返し見られるテーマ・傾向
 * （気候変動の影響・都市と農村の格差など）をメモにする（最大3件）。
 *
 * 主な利用元: lib/agent-knowledge-pack.js（記録は recordAgentNote から、プロンプトへは手持ちとして渡す）
 * 保存先: data/world_report_corner_notes.json
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

const NOTES_PATH = path.join(__dirname, '..', 'data', 'world_report_corner_notes.json');
/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 5;

/**
 * 溜めたメモを読む。ファイルが無ければ空。
 * @returns {Array<{note: string, recordedAt: string}>}
 */
function readNotes() {
  return jsonFileStore.readJsonFile(NOTES_PATH, [], '[WorldReportNotes]');
}

/**
 * メモを保存する（新しい MAX_STORED 件だけを残す）。
 * @param {Array<{note: string, recordedAt: string}>} list
 */
function writeNotes(list) {
  jsonFileStore.writeJsonFile(NOTES_PATH, list.slice(-MAX_STORED), '[WorldReportNotes]');
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
    const systemInstruction = 'あなたは世界各地を巡る特派員レポートの記録係です。ラジオで実際に'
      + '話されたレポート内容から、他の地域のレポートでも繰り返し言及する価値がある'
      + '「地域を超えて共通して見られるテーマ・傾向」だけを、後から単独で読んでも意味が'
      + '通る短い1文ずつで抽出してください（例: 気候変動が複数地域の暮らしに与えている'
      + '影響、都市化と農村の格差、特定の社会課題が地域を超えて共通して見られること等）。'
      + 'その土地固有の一回限りの出来事（地名・個人名込みの具体的ニュース）は対象外です'
      + '（それは他地域では再利用できないため）。該当する事項が無ければ空配列を、あれば'
      + '最大2件までにしてください。出力はJSON配列のみとし、説明文などは一切含めないで'
      + 'ください。';
    const userPrompt = `以下は特派員レポートで実際に話した内容です。\n\n${spokenText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["共通テーマ1", "共通テーマ2", ...]（無ければ []）';

    // 軽い抽出なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'world_report',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[WorldReportNotes] メモ抽出に失敗（無視して続行）: ${e.message}`);
    return;
  }

  let notes;
  try {
    notes = JSON.parse(rawText);
  } catch (e) {
    getLogger().debug(`[WorldReportNotes] JSON解析に失敗（無視して続行）: ${e.message}`);
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
    getLogger().info(`[WorldReportNotes] 継続観測メモを${added}件記録`);
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
  const lines = recent.map(e => `- ${e.note}`);
  return `\n\n【これまで訪れた土地で気づいた共通テーマ（あなたの経験の蓄積）】\n${lines.join('\n')}\n`
    + '今回の場所のレポート内容がこれらの共通テーマに当てはまると感じた場合のみ、'
    + '「これまでいくつかの場所で見てきたのですが〜」のように、複数の土地を巡ってきた'
    + '特派員としての経験を軽く一言添えてください。無理にこじつけて毎回触れる必要は'
    + 'ありません。';
}

module.exports = { recordNote, formatNotesForPrompt };
