/**
 * @file 見た YouTube 動画の字幕を、番組で使える要約にする
 *
 * 30分の動画の字幕は1万〜2万字あり、そのまま溜めても使えないので、取り込んだその場で要約し、
 * 要約だけを保存する（保存は youtube-watch-store.js）。
 *
 * 討論で使えるのは感想ではなく具体的な主張・数字・固有名詞なので、それを優先して残させる。
 *
 * ATTENTION: 要約に Google 検索（グラウンディング）を付けないこと。動画に無い話が混ざり、出典が曖昧になる。
 *
 * 主な利用元: lib/youtube-watch-store.js
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
const { getLogger } = require('../logger');

/** LLM に渡す字幕の文字数の上限（長いとコストも遅延も膨らむ）。 */
const MAX_TRANSCRIPT_CHARS = 24000;

/**
 * 字幕を上限の文字数に収める。導入と結論を残すため、先頭6割と末尾4割を残して中間を省く。
 * @param {string} [text]
 * @returns {string}
 */
function _clampTranscript(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_TRANSCRIPT_CHARS) return t;
  const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.6);
  const tail = MAX_TRANSCRIPT_CHARS - head;
  return `${t.slice(0, head)}\n…（中略）…\n${t.slice(-tail)}`;
}

/**
 * 動画1本の要約を作る。字幕が無ければ概要欄だけで要約する。
 *
 * @param {object} v
 * @param {string} v.title
 * @param {string} v.channel
 * @param {string} [v.transcript] 字幕（200文字未満は「無し」として扱う）
 * @param {string} [v.description] 概要欄
 * @param {{apiKey?: string, activitySessionId?: number|null}} [opts] activitySessionId は稼働記録のセッション番号
 * @returns {Promise<{summary: string, hadTranscript: boolean, failed?: boolean}>} 材料が足りない・失敗したときは
 *   summary が空。AI の呼び出しが失敗したときだけ failed が true
 */
async function summarizeWatchedVideo(v, { apiKey, activitySessionId = null } = {}) {
  const transcript = _clampTranscript(v.transcript);
  const hadTranscript = transcript.length >= 200;
  const description = String(v.description || '').slice(0, 2000);
  if (!hadTranscript && description.length < 40) {
    // 題名だけでは要約にならないので、保存しない
    return { summary: '', hadTranscript: false };
  }

  const systemInstruction = 'あなたは、リスナーが視聴した動画の内容を、ラジオ番組の出演者が'
    + '議論の材料として使えるよう書き留める記録係です。\n'
    + '- 感想・評価は書かないでください。**何が語られたか**だけを書きます。\n'
    + '- **具体的な主張・数字・固有名詞（企業名・人名・製品名・時期）**を優先して残してください。'
    + '「AIについて解説していた」のような要約は役に立ちません。\n'
    + '- 動画の中で語られていないことを補ってはいけません。推測で書かないこと。\n'
    + '- 話し手が「自分の見立て」として述べたことは、事実と区別が付くように'
    + '「〜だと述べている」の形で書いてください。\n'
    + '- 3〜5文の日本語の文章にまとめてください（箇条書きにしないこと）。\n'
    + '- 出力は本文のみとし、前置き・見出しは含めないでください。';

  const prompt = `【動画】${v.title}\n【チャンネル】${v.channel}\n\n`
    + (hadTranscript
      ? `【字幕（自動生成を含む。誤変換がありえます）】\n${transcript}\n\n`
      : `【概要欄】\n${description}\n\n⚠️ この動画の字幕は取得できませんでした。`
        + `概要欄から分かる範囲だけを書き、本編の内容を推測で補わないでください。\n\n`)
    + '上記から、議論の材料になる内容を書き留めてください。';

  try {
    const { text } = await generateText({
      tier: 'secretary_light',   // 写し取るだけなので軽いモデルで十分
      apiKey,
      systemInstruction,
      prompt,
      temperature: 0.2,
      agentKey: 'youtube_watch_summary',
      activitySessionId,
    });
    return { summary: (text || '').trim(), hadTranscript };
  } catch (e) {
    getLogger().warn(`[YouTubeWatch] 要約に失敗（この動画は取り込まない）: ${e.message}`);
    // 材料が足りなかったのか、AI の失敗だったのかを呼び出し側がログで言い分けられるように印を付ける
    return { summary: '', hadTranscript, failed: true };
  }
}

module.exports = { summarizeWatchedVideo };
