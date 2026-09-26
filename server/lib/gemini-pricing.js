/**
 * @file Gemini API の料金表と、使ったトークン数からの概算コスト
 *
 * 料金は Google の公式の料金ページ（https://ai.google.dev/gemini-api/docs/pricing）を見て手で反映している。
 * 自動で取得する仕組みは無いので、モデルの追加や値段の変更があれば書き直すこと。
 *
 * 思考トークン（thoughtsTokenCount）は出力と同じ単価で課金される。画面に出ない分にもコストがかかる。
 *
 * 主な利用元: activity-db.js（コストの記録・集計）
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

/**
 * モデルごとの単価（USD・100万トークンあたり）。
 *
 * Live API のように、テキスト・音声・画像で単価が違うモデルは inputText・inputAudio… の形で持つ。
 */
const GEMINI_PRICING_PER_1M = {
  // ─── テキスト生成 ───────────────────────────────────────────────
  'gemini-2.5-flash':             { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite':        { input: 0.10, output: 0.40 },
  'gemini-3.5-flash':             { input: 1.50, output: 9.00 },
  // ATTENTION: 3.1-flash-lite と 3.5-flash-lite は単価が違う。取り違えやすいので、直すときは公式の
  //            Flash-Lite の節で確かめること
  'gemini-3.1-flash-lite':        { input: 0.25, output: 1.50 },
  'gemini-3.5-flash-lite':        { input: 0.30, output: 2.50 },  // 3.1-flash-lite の後継（3.1 は 2027-05-07 に提供終了）
  'gemini-3-flash-preview':       { input: 0.50, output: 3.00 },  // Preview 版（Stable ではない）
  // TODO: 3.6・3.7・3.8 Flash は 2026-12-31 までのキャンペーン価格。2027-01-01 から倍額になるので書き直す
  'gemini-3.6-flash':             { input: 0.75, output: 3.75 },
  'gemini-3.7-flash':             { input: 0.75, output: 3.75 },
  'gemini-3.8-flash':             { input: 0.75, output: 3.75 },
  'gemini-3.1-pro-preview':       { input: 2.00, output: 12.00 },
  // ─── 画像生成（出力は画像トークンの単価） ─────────────────────────
  'gemini-2.5-flash-image':       { input: 0.30, output: 30.00 },  // 2026-10-02 に提供終了
  'gemini-3.1-flash-image':       { input: 0.50, output: 60.00 },  // Nano Banana 2（上記の後継）
  'gemini-3.1-flash-lite-image':  { input: 0.30, output: 30.00 },  // Nano Banana 2 Lite（さらに安い選択肢）
  // ─── TTS（出力は音声トークンの単価） ─────────────────────────────
  'gemini-3.1-flash-tts-preview': { input: 1.00, output: 20.00 },
  'gemini-2.5-flash-preview-tts': { input: 0.50, output: 10.00 },
  'gemini-2.5-pro-preview-tts':   { input: 1.00, output: 20.00 },
  // ─── Live API（音声対音声。テキスト・音声・画像で単価が違う） ────────
  'gemini-3.1-flash-live-preview': {
    inputText: 0.75, inputAudio: 3.00, inputImage: 1.00,
    outputText: 4.50, outputAudio: 12.00,
  },
};

/**
 * 使ったトークン数（_extractGeminiUsage が返す形）から、概算のコスト（USD）を計算する。
 * 料金表に無いモデルは null を返す（0円と誤解されないよう、分からないものは分からないままにする）。
 * @param {string} model
 * @param {{
 *   promptTokens?: number|null, outputTokens?: number|null, thoughtsTokens?: number|null,
 *   promptTextTokens?: number|null, promptAudioTokens?: number|null, promptImageTokens?: number|null,
 *   outputTextTokens?: number|null, outputAudioTokens?: number|null,
 * }} usage
 * @returns {number|null}
 */
function calcGeminiCostUsd(model, usage) {
  const price = GEMINI_PRICING_PER_1M[model];
  if (!price || !usage) return null;

  // テキスト・音声・画像で単価が違うモデル（音声はテキストの3〜4倍）。内訳が無ければ、
  // 安い単価で計算してしまうより「不明」（null）を返す
  if (price.inputText != null) {
    const hasDetail = usage.promptTextTokens != null || usage.promptAudioTokens != null
      || usage.outputTextTokens != null || usage.outputAudioTokens != null;
    if (!hasDetail) return null;
    return ((usage.promptTextTokens  ?? 0) / 1_000_000) * price.inputText
         + ((usage.promptAudioTokens ?? 0) / 1_000_000) * price.inputAudio
         + ((usage.promptImageTokens ?? 0) / 1_000_000) * (price.inputImage ?? 0)
         + ((usage.outputTextTokens  ?? 0) / 1_000_000) * price.outputText
         + ((usage.outputAudioTokens ?? 0) / 1_000_000) * price.outputAudio;
  }

  const inputTokens  = usage.promptTokens ?? 0;
  // 思考トークンは出力と同じ単価で課金される
  const outputTokens = (usage.outputTokens ?? 0) + (usage.thoughtsTokens ?? 0);
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

module.exports = { GEMINI_PRICING_PER_1M, calcGeminiCostUsd };
