/**
 * @file 秘書（My Secretary）の日記を、会話が終わったときに1回だけ書く
 *
 * 他のチャンネルと同じ一人称の振り返りを、秘書にも書かせる。保存と閲覧は共通の agent-diary.js と
 * 管理画面の AgentDiaryTab を使う（channel: 'secretary'）。
 * secretary-memory.js（次の会話に活かす学習内容）とは別物で、日記は管理画面で読むためだけのもの。
 *
 * 秘書にはコーナーの区切りが無く、1接続が1つの続いた会話なので、音楽チャンネルや The Answers と同じく
 * 会話全体を通して1回だけ書く（発言のたびに書くと、日記ではなくログの延長になる）。
 *
 * 主な利用元: routes/secretary-live-routes.js（切断時）
 * 保存先: data/agent-diary/secretary/secretary/
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

const { generateText } = require('./llm-client');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const agentDiary = require('./agent-diary');

// ATTENTION: 思考の漏れ（CoT）の除去は、agent-shared-mixin.js の _collapseReasoningLeak を必ず通すこと
//            （除去の実装はそこ1か所だけ）。クラスを持たないので、呼び出しに要る最小限の this を用意する
//            （secretary-tools.js の _leakCtx と同じ）。
const _leakCtx = { _channelId: 'Secretary', _hasReasoningLeakSignal: sharedAgentMethods._hasReasoningLeakSignal };

/** 材料にする自分の発言の文字数の上限（channel-base.js の番組全体の日記と同じ）。 */
const EXCERPT_MAX_CHARS = 1200;

/**
 * 会話が終わったとき、秘書自身の発言だけを材料に一人称の振り返りを書いて保存する。
 *
 * リスナーの発言は材料に入れない（何を自分のこととして振り返っているのかが薄まるため）。
 * 自分の発言が20文字未満（挨拶だけなど）なら書かない。失敗しても例外は出さない。
 * @param {Array<{speaker: 'user'|'secretary', text: string}>} transcriptLines 会話の記録
 * @param {{apiKey?: string, agentName?: string, activitySessionId?: number,
 *   onDiaryWritten?: (info: object) => void}} [opts]
 *   onDiaryWritten は書けたときに呼ぶ（ダッシュボードへ短い抜粋を知らせる）
 * @returns {Promise<void>}
 */
async function writeSessionDiaryReflection(transcriptLines, { apiKey, agentName, activitySessionId, onDiaryWritten } = {}) {
  if (!apiKey || !transcriptLines || transcriptLines.length === 0) return;
  const excerpt = transcriptLines
    .filter(l => l.speaker === 'secretary')
    .map(l => l.text)
    .join('\n')
    .replace(/[\n\r]+/g, ' ')
    .slice(0, EXCERPT_MAX_CHARS);
  if (excerpt.length < 20) return;

  let rawText;
  try {
    const systemPrompt = `あなたは「${agentName}」です。`;
    const userPrompt = `リスナーとの1回の会話を通して、以下のように発言しました。

【今回の会話での自分の発言（抜粋）】${excerpt}

これは公開されない、あなただけの非公開の日記です。今回の会話全体を振り返って、一人称で
2〜4文の感想を書いてください。うまく対応できた点、もっとこうすればよかったと思う点、
リスナーとのやり取りで印象に残ったことなど、率直な気持ちを書いてください。堅苦しい言葉遣いに
こだわらず、本音に近い書き方で構いません。日本語で、日記の本文のみを出力してください。`;

    // 短い作文なので軽いモデルで十分
    ({ text: rawText } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction: systemPrompt,
      prompt: userPrompt,
      agentKey: 'secretary',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().debug(`[Diary] secretary の日記生成に失敗しました（無視して続行）: ${e.message}`);
    return;
  }

  const diaryText = sharedAgentMethods._collapseReasoningLeak.call(_leakCtx, rawText, {});
  if (!diaryText || !diaryText.trim()) return;

  agentDiary.appendDiaryEntry({
    channel: 'secretary',
    agentKey: 'secretary',
    agentName,
    corner: 'session',
    text: diaryText.trim(),
  });
  // ダッシュボードには短い抜粋だけを知らせる（本文は管理画面で読む）
  onDiaryWritten?.({ agentKey: 'secretary', agentName, corner: 'session', excerpt: diaryText.trim().slice(0, 40) });
}

module.exports = { writeSessionDiaryReflection };
