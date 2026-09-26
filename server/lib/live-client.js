/**
 * @file リアルタイム音声対話（Gemini Live API）の窓口（接続・設定・送受信の形の変換）
 *
 * Live API は WebSocket の双方向通信で、generateContent の形に乗らないので、LLM の抽象化層（llm-client.js）
 * とは別にこの窓口を置く。送るときは「音声で返して」「この声で」のような意図を Gemini の形に、受け取るときは
 * Gemini の形を、提供元に依らない形に変える。
 *
 * ここに置くもの: 接続先・開始時の設定の組み立て・送受信の形の変換。
 * ここに置かないもの: 無応答からの立て直し・催促・ツールの実行・文字起こしの記録など、会話の運び方
 * （提供元に依らないので、呼び出し側に残す）。
 *
 * LLM の提供元に縛られないため（乗り換えられないと、コストを下げる選択肢が無くなる）、Gemini の
 * ワイヤの形はこの1ファイルだけが知る。他社へ移すときは、このファイルの中身（URL・設定・変換）を差し替える。
 *
 * 主な利用元: routes/secretary-live-routes.js
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

const { resolveModel } = require('./llm-models');

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/'
  + 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** 接続先URL（APIキー付き）。 */
function buildConnectUrl(apiKey) {
  return `${WS_URL}?key=${apiKey}`;
}

/** Live API のモデル名（`models/` 接頭辞が要る点も含めて層が知っている）。 */
function liveModelName() {
  return `models/${resolveModel('live')}`;
}

/** 料金表を引くためのキー（接頭辞なしのモデル名）。 */
function livePricingKey() {
  return resolveModel('live');
}

// ─── 送信（中立な意図 → ワイヤ形式） ──────────────────────────────

/**
 * 会話を始めるときの設定を、意図から Gemini の形に組み立てる。
 *
 * 呼び出し側は「音声で返す」「この声で」「文字起こしも欲しい」「このツールを使う」といった意図だけを渡し、
 * generationConfig・realtimeInputConfig などのキーの名前は知らなくてよい。
 *
 * @param {object} o
 * @param {string} o.voice              声の名前
 * @param {string} o.systemInstruction  システムの指示
 * @param {Array}  o.tools              ツールの宣言
 * @param {string|null} [o.resumeHandle] 会話を再開するためのハンドル（省略すると新しく始め、ハンドルを受け取れるようにする）
 * @param {boolean} [o.transcribe]      入出力の文字起こしをするか（既定 true）
 * @param {boolean} [o.lowStartSensitivity] 話し始めの判定を鈍くするか（既定 true）
 * @returns {object}
 */
function buildSetupPayload({
  voice, systemInstruction, tools, resumeHandle = null,
  transcribe = true, lowStartSensitivity = true,
} = {}) {
  return {
    model: liveModelName(),
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    // BUGFIX: 話し始めの判定だけを、確信が高いときに限ること。環境音や回り込みを話し声と誤って判定して
    //         割り込み扱いになり、「会話の記録には文が出ているのに何も喋らない」ことが起きた。
    //         話し終わりの判定は既定のまま（鈍くすると、誤って判定した「発話」が長く続いたことになり復帰が遅れる）。
    //         リスナーが割り込んで話すことはできる。
    ...(lowStartSensitivity ? {
      realtimeInputConfig: {
        automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' },
      },
    } : {}),
    // 会話の記録に残すため、リスナーと秘書の両方の発話を文字にさせる
    ...(transcribe ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
    systemInstruction: { parts: [{ text: systemInstruction }] },
    tools,
    // 省略しても空のオブジェクトを入れておくと、再開用のハンドルが届くようになる
    sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
  };
}



/**
 * 開始の設定を送るメッセージ（JSON の文字列）にする。 @param {object} setupPayload @returns {string}
 */
function encodeSetup(setupPayload) {
  return JSON.stringify({ setup: setupPayload });
}

/**
 * リスナー（またはシステム）の文を1ターンとして送るメッセージ（JSON の文字列）にする。 @param {string} text @returns {string}
 */
function encodeUserText(text) {
  return JSON.stringify({
    clientContent: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete: true,
    },
  });
}

/**
 * マイクの音声（PCM）を送るメッセージ（JSON の文字列）にする。
 * @param {string} base64Pcm
 * @param {string} [mimeType]
 * @returns {string}
 */
function encodeAudioChunk(base64Pcm, mimeType = 'audio/pcm;rate=16000') {
  return JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType, data: base64Pcm }] } });
}

/**
 * ツールの実行結果を返すメッセージ（JSON の文字列）にする。
 * @param {Array<{id: string, name: string, response: object}>} responses
 * @returns {string}
 */
function encodeToolResponse(responses) {
  return JSON.stringify({ toolResponse: { functionResponses: responses } });
}

// ─── 受信（ワイヤ形式 → 中立な形） ────────────────────────────────

/**
 * Gemini から届いた1つのメッセージを、提供元に依らない形にする。
 *
 * @param {Record<string, any>} parsed JSON.parse 済みのメッセージ
 * @returns {{
 *   ready: boolean,                 // 会話の準備ができた（Gemini の setupComplete）
 *   audioChunks: string[],          // 音声（base64）。無ければ空
 *   modelParts: object[]|null,      // モデルの返事の生のパーツ（記録用）
 *   inputTranscript: string|null,   // リスナーの発話の文字起こし
 *   outputTranscript: string|null,  // 秘書の発話の文字起こし
 *   turnComplete: boolean,
 *   interrupted: boolean,
 *   toolCalls: {id, name, args}[],  // 実行するツール（無ければ空）
 *   usage: object|null,             // 使ったトークン数（extractLiveUsage で整えたもの）
 *   goAwayMs: number|null,          // 接続が切られるまでの残り時間
 *   resumptionHandle: string|null,  // 再開用のハンドル
 *   activity: boolean,              // 何か返ってきたか（無応答の判定のリセットに使う）
 * }}
 */
function decodeServerMessage(parsed) {
  const sc = parsed?.serverContent;
  const parts = sc?.modelTurn?.parts || null;
  const calls = parsed?.toolCall?.functionCalls || [];
  return {
    ready: !!parsed?.setupComplete,
    audioChunks: (parts || []).filter((p) => p.inlineData?.data).map((p) => p.inlineData.data),
    modelParts: parts,
    inputTranscript: sc?.inputTranscription?.text || null,
    outputTranscript: sc?.outputTranscription?.text || null,
    turnComplete: !!sc?.turnComplete,
    interrupted: !!sc?.interrupted,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args || {}, _raw: c })),
    usage: parsed?.usageMetadata ? extractLiveUsage(parsed.usageMetadata) : null,
    goAwayMs: parsed?.goAway ? parseGoAwayTimeLeftMs(parsed.goAway.timeLeft) : null,
    goAwayRaw: parsed?.goAway?.timeLeft ?? null,
    resumptionHandle: (parsed?.sessionResumptionUpdate?.resumable && parsed?.sessionResumptionUpdate?.newHandle) || null,
    // 何か返ってきたら、無応答のタイマーを戻してよい
    activity: !!(sc?.modelTurn || sc?.inputTranscription || sc?.outputTranscription || parsed?.toolCall),
  };
}

/**
 * 使ったトークン数を、テキスト・音声・画像の別に整える（単価が違うので、合計だけでなく内訳を残す）。
 * @param {Record<string, any>|undefined} usageMetadata
 * @returns {object|null}
 */
function extractLiveUsage(usageMetadata) {
  if (!usageMetadata) return {};
  const promptByModality = {};
  for (const d of usageMetadata.promptTokensDetails || []) promptByModality[d.modality] = d.tokenCount;
  const outputByModality = {};
  for (const d of usageMetadata.responseTokensDetails || []) outputByModality[d.modality] = d.tokenCount;
  return {
    promptTokens: usageMetadata.promptTokenCount ?? null,
    outputTokens: usageMetadata.responseTokenCount ?? null,
    totalTokens: usageMetadata.totalTokenCount ?? null,
    promptByModality,
    outputByModality,
  };
}

/**
 * 接続が切られるまでの残り時間（"12.5s" など）をミリ秒にする。
 * @param {string|undefined} timeLeft
 * @returns {number|null} 読めなければ null
 */
function parseGoAwayTimeLeftMs(timeLeft) {
  if (!timeLeft) return null;
  const m = String(timeLeft).match(/^([\d.]+)s$/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}

module.exports = {
  buildConnectUrl, liveModelName, livePricingKey,
  buildSetupPayload, encodeSetup, encodeUserText, encodeAudioChunk, encodeToolResponse,
  decodeServerMessage, extractLiveUsage, parseGoAwayTimeLeftMs,
};
