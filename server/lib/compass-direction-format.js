/**
 * @file 十六方位（「北北西」など）をひらがなに置き換える（読み上げの誤り対策）
 *
 * 「北北西」は形態素解析で「北」「北西」に分かれ、「キタホクセイ」と誤読される。
 * 16方位を調べると、3文字の方位8つのうち5つ（北北西・北北東・東南東・南南西・西南西）がこの形で
 * 誤読された。方位は読みが1通りに決まっていて数も限られるので、number-speech-format.js と同じく
 * 対応表で置き換える。
 *
 * 主な利用元: lib/agent-shared-mixin.js（放送の TTS 前の正規化）・lib/secretary-tools-services.js
 *
 * ATTENTION: 1文字の方位（北・南・東・西）は対象にしないこと。「東北」「北海道」「関西」のような
 *            無関係な語の一部として頻出し、誤って置き換えてしまう。
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

/** 3文字の方位（基本方位を2つ重ねたもの）。 */
const COMPASS_3CHAR = [
  ['北北東', 'ほくほくとう'],
  ['東北東', 'とうほくとう'],
  ['東南東', 'とうなんとう'],
  ['南南東', 'なんなんとう'],
  ['南南西', 'なんなんせい'],
  ['西南西', 'せいなんせい'],
  ['西北西', 'せいほくせい'],
  ['北北西', 'ほくほくせい'],
];

/** 2文字の方位（基本方位どうしの組み合わせ）。 */
const COMPASS_2CHAR = [
  ['北東', 'ほくとう'],
  ['南東', 'なんとう'],
  ['南西', 'なんせい'],
  ['北西', 'ほくせい'],
];

/**
 * 文中の2〜3文字の方位を、ひらがなの読みに置き換える。
 *
 * ATTENTION: 3文字を先に置き換えること。2文字を先にすると「北北西」の「北西」だけが置き換わる。
 * @param {string} text
 * @returns {string}
 * @example normalizeCompassDirectionsForSpeech('北北西の風') // → 'ほくほくせいの風'
 */
function normalizeCompassDirectionsForSpeech(text) {
  for (const [kanji, yomi] of COMPASS_3CHAR) {
    text = text.replaceAll(kanji, yomi);
  }
  for (const [kanji, yomi] of COMPASS_2CHAR) {
    text = text.replaceAll(kanji, yomi);
  }
  return text;
}

module.exports = { normalizeCompassDirectionsForSpeech };
