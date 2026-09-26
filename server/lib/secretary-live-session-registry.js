/**
 * @file 稼働中の秘書（Gemini Live）セッションへ、外のモジュールから話しかけるための仲介
 *
 * Gemini Live との接続は secretary-live-routes.js の接続処理の中に閉じていて、外からは触れない。
 * 一方、ヘルパーエージェントは会話のターンとは無関係に数分後に仕事を終えるため、
 * 「終わったので画面に出して読み上げてほしい」と外から届ける手段がいる。
 * 秘書は1接続につき Gemini Live を1本張る設計なので、「今のセッション」を1つだけ保持すれば足りる
 * （lib/secretary-recorder.js の setActiveRecorder と同じ形）。
 *
 * このモジュールは WebSocket を知らない。登録する側（secretary-live-routes.js）が次の3つの関数を
 * 備えたオブジェクトを渡す:
 *   - injectSystemTurn(text) … 内部の指示を user ロールのターンとして送る
 *   - sendCanvas(payload)    … CANVAS_UPDATE をブラウザへ送る
 *   - sendJobStatus(payload) … SECRETARY_JOB_STATUS（裏で動いている仕事の進み具合）をブラウザへ送る
 *   - isBusy()               … モデルが生成中か（生成中に送ると割り込み扱いになり、音声が切れる）
 *
 * 主な利用元: routes/secretary-live-routes.js（登録・解除）・lib/secretary-helper-agent.js（完了の通知）
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
 * 秘書セッションの操作口。
 * @typedef {object} SecretaryLiveSession
 * @property {(text: string) => void} injectSystemTurn
 * @property {(payload: object) => void} sendCanvas
 * @property {(payload: object) => void} sendJobStatus
 * @property {() => boolean} isBusy
 */

/** @type {SecretaryLiveSession|null} */
let _activeSession = null;

/**
 * 今のセッションとして登録する。
 * @param {SecretaryLiveSession} session
 */
function setActiveSession(session) { _activeSession = session; }

/**
 * 今のセッションを返す。接続が無ければ null。
 * @returns {SecretaryLiveSession|null}
 */
function getActiveSession() { return _activeSession; }

/**
 * 登録を解除する。
 *
 * ATTENTION: 呼び出し側は自分が登録したセッションを渡すこと。接続が入れ替わったあと、古い接続の
 *            終了処理が新しい接続の登録を消してしまわないよう、自分のものであるときだけ消す。
 * @param {SecretaryLiveSession} [session] 省略すると無条件に解除する
 */
function clearActiveSession(session) {
  if (!session || _activeSession === session) _activeSession = null;
}

module.exports = { setActiveSession, getActiveSession, clearActiveSession };
