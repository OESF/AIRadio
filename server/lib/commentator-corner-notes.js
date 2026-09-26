/**
 * @file コメンテーター（教授）のコーナーの「継続観測メモ」（今後の展開を確かめるべきことを引き継ぐ）
 *
 * コーナーで実際に話した内容から、次の回にも引き継ぐべきことを軽い LLM で抽出してファイルに溜め、
 * 次にそのコーナーを作るときにプロンプトへ渡す（formatNotesForPrompt）。専門家が定点観測を
 * 続けているような連続性を持たせるため。
 *
 * メモにするのは、政治・経済・地政学のうち、中央銀行の次の会合・審議中の政策・緊張の推移など、
 * 今後の展開を確かめるべきこと（最大3件）。
 * ATTENTION: 値動きの予想や個別の投資判断をメモにしないこと。教授の解説は「今後の値動きの予想はしない」
 *            という線を引いており、それと矛盾する。
 * ラジオで話した内容のほか、見た YouTube の要約からも記録する（sourceHint で材料が何かを伝える）。
 *
 * 主な利用元: lib/agent-knowledge-pack.js（記録は recordAgentNote から、プロンプトへは手持ちとして渡す）
 * 保存先: data/commentator_corner_notes.json
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

const NOTES_PATH = path.join(__dirname, '..', 'data', 'commentator_corner_notes.json');
/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 5;

/**
 * 溜めたメモを読む。ファイルが無ければ空。
 * @returns {Array<{note: string, recordedAt: string}>}
 */
function readNotes() {
  return jsonFileStore.readJsonFile(NOTES_PATH, [], '[CommentatorNotes]');
}

/**
 * メモを保存する（新しい MAX_STORED 件だけを残す）。
 * @param {Array<{note: string, recordedAt: string}>} list
 */
function writeNotes(list) {
  jsonFileStore.writeJsonFile(NOTES_PATH, list.slice(-MAX_STORED), '[CommentatorNotes]');
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
    const systemInstruction = 'あなたは政治・経済解説コーナーの記録係です。ラジオで実際に話された'
      + '内容から、次回以降の放送でも継続して確認すべき「今後の予定・審議中の事項・注目すべき'
      + '展開」だけを、後から単独で読んでも意味が通る短い1文ずつで抽出してください'
      + '（例: 次回の中央銀行会合の日程と論点、審議中の法案・政策の行方、地政学的緊張の'
      + '今後の推移など）。株価の値動き予想や個別銘柄の売買判断は絶対に対象外です'
      + '（それらは抽出しないでください）。該当する事項が無ければ空配列を、あれば最大3件'
      + 'までにしてください。出力はJSON配列のみとし、説明文などは一切含めないでください。';
    const userPrompt = `${sourceHint || '以下はコメンテーターコーナーで実際に話した内容です。'}\n\n${spokenText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["今後の注目点1", "今後の注目点2", ...]（無ければ []）';

    // 軽い抽出なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'commentator',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[CommentatorNotes] メモ抽出に失敗（無視して続行）: ${e.message}`);
    return;
  }

  let notes;
  try {
    notes = JSON.parse(rawText);
  } catch (e) {
    getLogger().debug(`[CommentatorNotes] JSON解析に失敗（無視して続行）: ${e.message}`);
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
    getLogger().info(`[CommentatorNotes] 継続観測メモを${added}件記録`);
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
  return `\n\n【継続観測メモ（過去の自分の解説からの振り返り対象）】\n${lines.join('\n')}\n`
    + '該当する事項について、今回のデータ（ニュース・検索結果等）に結果や続報が含まれていれば'
    + '「以前触れた〜ですが、その後〜となりました」のように振り返って解説してください。'
    + '今回のデータに続報が無ければ無理に触れる必要はありません。';
}

module.exports = { recordNote, formatNotesForPrompt };
