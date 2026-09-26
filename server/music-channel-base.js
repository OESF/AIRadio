/**
 * @file 音楽4チャンネル（Classic・Jazz・Mood・Beatles）の共通の基底クラス
 *
 * 4チャンネルとも「ディレクター（音声なし・裏方）＋パーソナリティ（音声あり）」の2エージェント構成で、
 * リスナーの接続・切断時の扱い（接続情報の配信・Spotify 再生待ちの中断・セッション終了処理）が共通している。
 *
 * ChannelAgentBase（channel-base.js）は The Answers・24/You とも共有しており、それらは接続・切断時に
 * 別の処理をするため、音楽4チャンネル固有の共通処理はこの中間クラスに置く。
 * 呼び出している _broadcastConnectionInfo・_interruptSpotifyPlayWait・_handleSessionShutdown の
 * 実体は ChannelAgentBase にある。
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

const ChannelAgentBase = require('./channel-base');
const { getLogger } = require('./logger');

/**
 * 音楽4チャンネルの中間基底クラス。
 */
class MusicChannelAgentBase extends ChannelAgentBase {
  /** リスナーが接続したとき。接続情報（番組名・曲など）をすぐに配信する。 */
  onClientConnected() {
    super.onClientConnected();
    getLogger().info(`[${this._channelId}] クライアント接続`);
    this._broadcastConnectionInfo();
  }

  /** リスナーが切断したとき。Spotify の再生待ちを中断し、セッションを終える（日記の書き込みなど）。 */
  onClientDisconnected() {
    super.onClientDisconnected();
    getLogger().info(`[${this._channelId}] クライアント切断`);
    this._interruptSpotifyPlayWait();
    this._handleSessionShutdown();
  }
}

module.exports = MusicChannelAgentBase;
