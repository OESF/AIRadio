/**
 * @file 音声合成の受け口（プロバイダに依存しない形で、テキストを音声にする）
 *
 * LLM のベンダーに縛られないための層。テキスト生成は llm-client.js の generateText() が受け持つが、
 * 音声合成はその形に乗らないので、ここで別に受ける。音声合成は放送のコストのうち無視できない割合を占めるので、
 * 他社へ移る選択肢を残しておくことが、そのままコストに効く。利用元は agent-shared-mixin.js。
 *
 * この層が隠すもの（プロバイダ固有）:
 *   - 演技指示のプロンプトの形（Gemini は AUDIO PROFILE・THE SCENE・DIRECTOR'S NOTES・TRANSCRIPT という
 *     Markdown の見出しで渡す。他社は個別のパラメータや SSML）
 *   - リクエストと応答の形、音声データの取り出し方
 *   - タイムアウトとリトライ
 *
 * 隠さないもの（プロバイダに依らないので呼び出し側に残す）:
 *   - 取得した音声のリサンプルと音量の正規化（ffmpeg）
 *   - 稼働ログへの記録（ffmpeg を含めた所要時間を測りたいので、呼び出し側で行う）
 *
 * 他社へ移すときは、synthesizeSpeech() の中身を差し替えればよい。
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

const { getLogger } = require('../logger');
const systemAlerts = require('./system-alerts');
const { resolveModel } = require('./llm-models');

const FETCH_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [1000, 2000];

// 成功した合成は debug でファイルにだけ残す（コンソールには出さない）。1回の放送で何百回も走るので、
// info や warn にすると警告やエラーが埋もれる。上限の時間を超えたものはタイムアウトとして warn に出る。
// この時間を超えた成功には「遅い」の目印を付け、後から grep で上限に近かったものの分布を数えられるようにする。
const SLOW_TTS_MARK_MS = Number(process.env.TTS_SLOW_WARN_MS) || 12000;

/**
 * 演技指示とテキストを、Gemini TTS のプロンプトの形に組み立てる。
 *
 * BUGFIX: TRANSCRIPT の見出しは、演技指示が1つも無いときも必ず付ける。付けないと、短い挨拶文などを
 *         台本ではなくモデルへの話しかけと受け取り、テキストで答えようとして 400 エラーになる
 *         （"Model tried to generate text, but it should only be used for TTS"）。
 * @param {string} text 読み上げるテキスト
 * @param {Record<string, any>} [direction] 演技指示（name・profileTitle・scene・style・accent・pacing・context。
 *   古い形の instruction・languageCode も受け付ける）
 * @returns {string}
 */
function buildGeminiTtsPrompt(text, direction = {}) {
  const {
    name = '', profileTitle = '', scene = '',
    style = '', accent = '', pacing = '', context = '',
    instruction = '', languageCode = null,   // 後方互換
  } = direction;

  const effectiveStyle = style || instruction || '';
  const effectiveAccent = accent || (languageCode ? `Speak in ${languageCode}` : '');
  const sections = [];
  if (name || profileTitle) {
    const lines = [];
    if (name) lines.push(`# AUDIO PROFILE: ${name}`);
    if (profileTitle) lines.push(`## "${profileTitle}"`);
    sections.push(lines.join('\n'));
  }
  if (scene) sections.push(`## THE SCENE\n${scene}`);
  const noteLines = [];
  if (effectiveStyle) noteLines.push(`Style: ${effectiveStyle}`);
  if (effectiveAccent) noteLines.push(`Accent: ${effectiveAccent}`);
  if (pacing) noteLines.push(`Pacing: ${pacing}`);
  if (noteLines.length > 0) sections.push(`### DIRECTOR'S NOTES\n${noteLines.join('\n')}`);
  if (context) sections.push(`### SAMPLE CONTEXT\n${context}`);
  sections.push(`#### TRANSCRIPT\n${text}`);
  return sections.join('\n\n');
}

/**
 * テキストを音声に合成する。
 *
 * @param {Object} opts
 * @param {string} opts.text        読み上げるテキスト
 * @param {string} [opts.voice]     声の名前（プロバイダの声の ID をそのまま渡す）
 * @param {Record<string, any>} [opts.direction] 演技指示（buildGeminiTtsPrompt を参照）
 * @param {Record<string, any>|null} [opts.creds] 認証情報（API キーとモデルの上書き設定の取得元）
 * @param {string} [opts.logLabel]  ログの見出し（チャンネル名など）
 * @returns {Promise<{audio: Buffer, mimeType: string, usage: Record<string, any>, model: string}>}
 *   audio はプロバイダが返した生の音声（形式は mimeType で判断する）。
 *   サンプリングレートの変換や音量の正規化は呼び出し側で行う。
 * @throws リトライしても音声が得られないとき・通信に失敗したとき・HTTP エラーのとき
 */
async function synthesizeSpeech({ text, voice = 'Kore', direction = {}, creds = null, logLabel = 'TTS' } = {}) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  // 既定値と creds.gemini.tts_model の優先順位は tts ティア（llm-models.js）の overrides が持つ。
  const model = resolveModel('tts', { creds });
  const promptText = buildGeminiTtsPrompt(text, direction);

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));

    // 成功・失敗の両方で所要時間と本文の長さを残す。上限の時間を延ばすべきか、GA 版（Cloud TTS）へ移るべきかを
    // 分布を見て決めるための材料
    const _t0 = Date.now();
    const _elapsed = () => ((Date.now() - _t0) / 1000).toFixed(1);

    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
          // BUGFIX: Gemini TTS はエラーを返さずに応答を止めてしまうことがある。タイムアウトが無いと待ち続け、
          //         会話がまるごと止まる
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }
      );
    } catch (fetchErr) {
      getLogger().warn(`[${logLabel}] TTS fetch失敗/タイムアウト ${_elapsed()}秒 textLen=${text.length} `
        + `attempt=${attempt + 1}/${RETRY_DELAYS_MS.length + 1} model=${model} voice=${voice}: ${fetchErr.message}`);
      if (attempt < RETRY_DELAYS_MS.length) continue;
      throw new Error(`TTS: 通信に失敗しました（${fetchErr.message}）`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      getLogger().warn(`[${logLabel}] TTS ${res.status} model=${model} voice=${voice} body=${body.slice(0, 500)}`);
      const err = new Error(`TTS HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      // 残高不足や API キーの無効のような「待っても直らない」異常は、原稿の生成より回数の多い音声合成で先に
      // 現れることがある。llm-client と同じく system-alerts へ通し、メイン画面へ必ず出す
      systemAlerts.report(err, { source: `tts:${model}` });
      if (res.status === 500 && attempt < RETRY_DELAYS_MS.length) continue;
      throw err;
    }

    const json = await res.json();
    const part = json.candidates?.[0]?.content?.parts?.[0];
    const audioB64 = part?.inlineData?.data;
    if (!audioB64) {
      if (attempt < RETRY_DELAYS_MS.length) {
        getLogger().warn(`[${logLabel}] TTS 音声データなし retry ${attempt + 1}/${RETRY_DELAYS_MS.length}`);
        continue;
      }
      // 最後の失敗では、原因を調べられるように何が返ってきたかを残す
      const nCand = json.candidates?.length ?? 0;
      const fr = json.candidates?.[0]?.finishReason ?? '(none)';
      const fb = json.promptFeedback?.blockReason ?? null;
      const textResp = json.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
      if (fb) getLogger().warn(`[${logLabel}] TTS ブロック blockReason=${fb} candidates=${nCand} textLen=${text.length} text="${text}"`);
      else if (textResp) getLogger().warn(`[${logLabel}] TTS テキスト応答: ${textResp.slice(0, 120)}`);
      else getLogger().warn(`[${logLabel}] TTS finishReason=${fr} candidates=${nCand} textLen=${text.length} parts=${JSON.stringify(json.candidates?.[0]?.content?.parts ?? []).slice(0, 120)}`);
      throw new Error('TTS: 音声データが取得できませんでした');
    }

    const mimeType = part?.inlineData?.mimeType || '';
    const audio = Buffer.from(audioB64, 'base64');
    systemAlerts.reportSuccess(); // 音声が取れた＝APIは生きている
    const _ms = Date.now() - _t0;
    const _line = `[${logLabel}] TTS 完了 ${_elapsed()}秒 textLen=${text.length} `
      + `attempt=${attempt + 1} bytes=${audio.length} mimeType=${mimeType}`;
    getLogger().debug(_ms >= SLOW_TTS_MARK_MS
      ? `${_line} ← 遅い（上限${(FETCH_TIMEOUT_MS / 1000).toFixed(0)}秒・成功）`
      : _line);
    return {
      audio,
      mimeType,
      usage: require('./llm-client').extractUsage(json.usageMetadata),
      model,
    };
  }
  throw new Error('TTS: 最大リトライ回数を超えました');
}

module.exports = { synthesizeSpeech, buildGeminiTtsPrompt };
