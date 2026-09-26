/**
 * @file ゲスト論客（お笑い芸人・医師・マーケター）の「継続観測メモ」
 *
 * 自分のコーナーを持たないゲスト論客も、出演のたびに成長していくためのメモ。コーナーのメモ
 * （commentator-corner-notes.js など）と同じ仕組みで、3人とも「何を追いかけるか」の文面だけが違うので、
 * 1つの作り方（createGuestNotesStore）から3人分を作る。
 *
 * 討論コーナー・The Answers に出演した直後に記録し（recordAgentNote から）、次に出演したときに
 * プロンプトへ渡す（buildAgentKnowledgePack から）。
 *
 * ATTENTION: focus などの文面に人物の名前を書かないこと（名前は管理画面で変えられる）。
 *
 * 主な利用元: lib/agent-knowledge-pack.js
 * 保存先: data/<agentKey>_notes.json
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

/** ファイルに残す件数の上限（超えたら古いものから消す）。 */
const MAX_STORED = 30;
/** プロンプトに渡す直近の件数。 */
const MAX_INJECTED = 5;

/**
 * 1人分のメモの置き場を作る。
 * @param {object} opts
 * @param {string} opts.agentKey  Live 側のエージェントのキー（保存するファイル名と、使用量の記録に使う）
 * @param {string} opts.logTag    ログの接頭辞
 * @param {string} opts.focus     何を「次も追いかけること」として抜き出すか（LLM への指示に入る）
 * @returns {{recordNote: Function, formatNotesForPrompt: () => string}}
 */
function createGuestNotesStore({ agentKey, logTag, focus }) {
  const notesPath = path.join(__dirname, '..', 'data', `${agentKey}_notes.json`);
  const readNotes = () => jsonFileStore.readJsonFile(notesPath, [], logTag);
  const writeNotes = (list) => jsonFileStore.writeJsonFile(notesPath, list.slice(-MAX_STORED), logTag);

  /**
   * 出演で話した内容から、次も追いかけることを抜き出して保存する（0〜3件）。
   * 20文字未満の内容や API キーが無いときは何もしない。失敗しても例外は出さない。
   *
   * ATTENTION: LLM を呼ぶので、呼び出し側は await せずに呼ぶこと。
   * @param {string} spokenText 出演で話した内容
   * @param {{apiKey?: string, activitySessionId?: number, sourceHint?: string}} [opts]
   *   sourceHint は材料の説明の書き出し（YouTube の要約から記録するときなど）
   * @returns {Promise<void>}
   */
  async function recordNote(spokenText, { apiKey, activitySessionId, sourceHint = '' } = {}) {
    if (!apiKey || !spokenText || spokenText.length < 20) return;

    let rawText;
    try {
      const systemInstruction = `あなたはラジオ出演者の記録係です。${focus}だけを、`
        + '後から単独で読んでも意味が通る短い1文ずつで抽出してください。'
        + 'その場限りの感想や冗談、一般論は対象外です。該当する事項が無ければ空配列を、'
        + 'あれば最大3件までにしてください。出力はJSON配列のみとし、説明文などは一切含めないでください。';
      const userPrompt = `${sourceHint || '以下はこの出演者が番組で実際に話した内容です。'}\n\n${spokenText}\n\n`
        + '出力形式（この配列の形のJSONのみ）: ["追いかける事項1", "追いかける事項2", ...]（無ければ []）';
      ({ text: rawText } = await generateText({
        tier: 'light',
        apiKey,
        systemInstruction,
        prompt: userPrompt,
        temperature: 0,
        json: true,
        agentKey,
        activitySessionId,
      }));
    } catch (e) {
      getLogger().debug(`${logTag} メモ抽出に失敗（無視して続行）: ${e.message}`);
      return;
    }

    let notes;
    try {
      notes = JSON.parse(rawText);
    } catch (e) {
      getLogger().debug(`${logTag} JSON解析に失敗（無視して続行）: ${e.message}`);
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
      getLogger().info(`${logTag} 継続観測メモを${added}件記録`);
    }
  }

  /**
   * 直近のメモを、出演するときのプロンプトに差し込む段落にする。
   * @returns {string} メモが無ければ空文字
   */
  function formatNotesForPrompt() {
    const list = readNotes();
    if (list.length === 0) return '';
    const lines = list.slice(-MAX_INJECTED).map((e) => {
      const d = new Date(e.recordedAt);
      return `- [${d.getMonth() + 1}月${d.getDate()}日時点] ${e.note}`;
    });
    return `\n\n【継続観測メモ（過去の自分の発言からの振り返り対象）】\n${lines.join('\n')}\n`
      + '今回の話題や材料にこれらの続報が含まれていれば、「前に私が言った〜ですが、その後〜」のように'
      + '振り返って話してください。続報が無ければ無理に触れる必要はありません。';
  }

  return { recordNote, formatNotesForPrompt };
}

module.exports = {
  comedian: createGuestNotesStore({
    agentKey: 'comedian',
    logTag: '[ComedianNotes]',
    focus: 'お笑い芸人として話した内容のうち、次回以降も追いかけるべき「芸能界・エンタメ・世間で話題になっている出来事の続報」や、'
      + '「自分が言い切った見立て（その後どうなったか確かめたいもの）」',
  }),
  doctor: createGuestNotesStore({
    agentKey: 'doctor',
    logTag: '[DoctorNotes]',
    focus: '医師・元国会議員として話した内容のうち、次回以降も追いかけるべき「医療・健康・美容に関する研究や制度の続報」、'
      + '「審議中の政策や法改正の行方」、「自分が示した見立て」',
  }),
  marketer: createGuestNotesStore({
    agentKey: 'marketer',
    logTag: '[MarketerNotes]',
    focus: 'マーケターとして話した内容のうち、次回以降も追いかけるべき「流行・消費動向・企業の打ち手の続報」や、'
      + '「自分が示した見立て（そのブームや施策がその後どうなったか等）」',
  }),
};
