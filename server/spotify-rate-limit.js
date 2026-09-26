/**
 * @file Spotify API のレート制限（429）による待機状態を、全チャンネルで共有する
 *
 * Spotify の client_id / secret（data/credentials.json）は全チャンネル共通の1つなので、
 * 429 を受けたときの待機もプロセス全体で1つにまとめる。
 *
 * 主な利用元: channel-base.js・agent-system.js・agent-system-24you.js・services/spotify-service.js
 *
 * ATTENTION: チャンネルごとに待機状態を持たせないこと。1チャンネルが待機中でも他のチャンネルが
 *            リクエストを送り続け、同じペナルティを重ねて待機を長引かせてしまう。
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

/** 待機が明ける時刻（ミリ秒）。0 は待機なし。 */
let backoffUntil = 0;

/**
 * 今が待機中か。
 * @returns {boolean}
 */
function isBackedOff() {
  return Date.now() < backoffUntil;
}

/**
 * 待機が明けるまでの残り時間（分、切り上げ）。待機中でなければ 0。
 * @returns {number}
 */
function getBackoffMinutesRemaining() {
  return Math.max(0, Math.ceil((backoffUntil - Date.now()) / 60000));
}

/**
 * 待機が明ける時刻を設定する。今より長い待機のときだけ上書きする（短い値で縮めない）。
 * @param {number} timestamp 待機が明ける時刻（ミリ秒）
 */
function setBackoffUntil(timestamp) {
  if (timestamp > backoffUntil) backoffUntil = timestamp;
}

module.exports = { isBackedOff, getBackoffMinutesRemaining, setBackoffUntil };
