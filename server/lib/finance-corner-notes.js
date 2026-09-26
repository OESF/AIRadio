/**
 * @file 金融情報センターの「継続観測メモ」（今後注目すべき決定・発表の予定を引き継ぐ）
 *
 * コーナーで実際に話した内容から、次の回にも引き継ぐべきことを軽い LLM で抽出してファイルに溜め、
 * 次にそのコーナーを作るときにプロンプトへ渡す（formatNotesForPrompt）。専門家が定点観測を
 * 続けているような連続性を持たせるため。
 *
 * メモにするのは、次の FOMC・日銀会合の日程、審議中の政策の論点など、事実に基づく今後の注目点（最大3件）。
 * 振り返るのは「その決定が実際にどうなったか」で、投資判断が当たったかどうかではない。
 * ATTENTION: 値動きの予想や個別銘柄の売買の助言をメモにしないこと（金融コーナーの禁止事項と矛盾する）。
 *
 * 主な利用元: lib/agent-knowledge-pack.js（記録は recordAgentNote から、プロンプトへは手持ちとして渡す）
 * 保存先: data/finance_corner_notes.json
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

const NOTES_PATH = path.join(__dirname, '..', 'data', 'finance_corner_notes.json');
/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 5;

/**
 * 溜めたメモを読む。ファイルが無ければ空。
 * @returns {Array<{note: string, recordedAt: string}>}
 */
function readNotes() {
  return jsonFileStore.readJsonFile(NOTES_PATH, [], '[FinanceNotes]');
}

/**
 * メモを保存する（新しい MAX_STORED 件だけを残す）。
 * @param {Array<{note: string, recordedAt: string}>} list
 */
function writeNotes(list) {
  jsonFileStore.writeJsonFile(NOTES_PATH, list.slice(-MAX_STORED), '[FinanceNotes]');
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
    const systemInstruction = 'あなたは金融情報の記録係です。ラジオの金融コーナーで実際に話された'
      + '内容から、次回の放送でも継続して確認すべき「今後の予定・決定待ちの事項」だけを、'
      + '後から単独で読んでも意味が通る短い1文ずつで抽出してください'
      + '（例: 次回FOMCの日程と注目点、日銀金融政策決定会合の予定、審議中の経済政策の行方など）。'
      + '株価の値動き予想や個別銘柄の売買判断は絶対に対象外です（それらは抽出しないでください）。'
      + '該当する事項が無ければ空配列を、あれば最大3件までにしてください。'
      + '出力はJSON配列のみとし、説明文などは一切含めないでください。';
    const userPrompt = `以下は金融コーナーで実際に話した内容です。\n\n${spokenText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["今後の注目点1", "今後の注目点2", ...]（無ければ []）';

    // 軽い抽出なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'finance',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[FinanceNotes] メモ抽出に失敗（無視して続行）: ${e.message}`);
    return;
  }

  let notes;
  try {
    notes = JSON.parse(rawText);
  } catch (e) {
    getLogger().debug(`[FinanceNotes] JSON解析に失敗（無視して続行）: ${e.message}`);
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
    getLogger().info(`[FinanceNotes] 継続観測メモを${added}件記録`);
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
    + '該当する事項について、今回のデータ（経済・マーケットニュース等）に結果や続報が含まれて'
    + 'いれば「以前注目していた〜ですが、結果は〜でした」のように振り返って解説してください。'
    + '今回のデータに続報が無ければ無理に触れる必要はありません。'
    + '（この振り返りは値動きの予想的中・不的中の話ではなく、決定事項の結果確認です）';
}

module.exports = { recordNote, formatNotesForPrompt };
