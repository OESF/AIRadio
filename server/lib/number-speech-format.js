/**
 * @file 大きな数値を「万・億」区切りの表記に変換する（読み上げの誤り対策）
 *
 * 日本語の数の読みは1万（10^4）区切りだが、カンマは千（10^3）区切りなので、5桁以上では
 * カンマの位置と「万」の境目がずれる（例: 37,785,540 は「3778万5540」と読むが、カンマは
 * 「37|785|540」にある）。TTS も音声対音声の LLM も、このずれのある大きな数値を誤読しやすい。
 *
 * 主な利用元: lib/agent-shared-mixin.js（放送の TTS 前の正規化）・
 *             lib/secretary-tools-finance.js・lib/secretary-tools-services.js（秘書に渡すテキストの整形）
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
 * 文中のカンマ区切りの数値のうち、1万以上のものを「◯億◯万◯」の表記に置き換える。
 * 小数部はそのまま残す。1万未満はカンマ区切りのままでも誤読されにくいので変えない。
 * @param {string} text
 * @returns {string}
 * @example normalizeLargeNumbersForSpeech('37,785,540円') // → '3778万5540円'
 */
function normalizeLargeNumbersForSpeech(text) {
  return text.replace(/[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?/g, (m) => {
    const dotIdx = m.indexOf('.');
    const intPart = dotIdx === -1 ? m : m.slice(0, dotIdx);
    const decPart = dotIdx === -1 ? '' : m.slice(dotIdx);
    const n = parseInt(intPart.replace(/,/g, ''), 10);
    if (!Number.isFinite(n) || n < 10000) return m;
    const oku = Math.floor(n / 100000000);
    const man = Math.floor((n % 100000000) / 10000);
    const rest = n % 10000;
    let result = '';
    if (oku > 0) result += `${oku}億`;
    if (man > 0) result += `${man}万`;
    if (rest > 0 || result === '') result += `${rest}`;
    return result + decPart;
  });
}

module.exports = { normalizeLargeNumbersForSpeech };
