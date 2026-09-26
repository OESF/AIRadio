/**
 * @file 秘書用の Spotify（リスナー本人の再生状況・履歴・プレイリストの操作）
 *
 * Live などの放送の Spotify（agent-shared-mixin.js の _getSpotifyToken。曲の検索・選曲用）とは、あえて別にしている。
 * 秘書は頼まれるたびに正確な最新の状態を答える必要があり、放送のキャッシュなどとは要件が違うため
 * （google-service.js と同じ理由）。認証情報（credentials.json の spotify）は共有し、アクセストークンの
 * キャッシュはこのクラスの中で持つ。
 *
 * ATTENTION: 再生状況・履歴・よく聴く曲・プレイリストの操作には、追加のスコープ（user-read-currently-playing・
 *            user-read-recently-played・user-top-read・playlist-modify-*）が要る。管理画面で再認証
 *            （/api/spotify/auth）していないと 401・403 で失敗し、その場合は再認証を案内するエラーを返す。
 *
 * 主な利用元: lib/secretary-tools-services.js（共有のインスタンスを作る）・lib/secretary-tools-spotify.js
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

const { spotifyFetch } = require('./spotify-service');

/**
 * 秘書用の Spotify。失敗したらエラーを投げ、呼び出し側がリスナーに分かる言葉にする。
 */
class SpotifyUserService {
  constructor() {
    this._accessToken = null;
    this._tokenExpiresAt = 0;
  }

  /**
   * アクセストークンを返す（有効なうちは使い回す）。
   * @param {Record<string, any>} creds 認証情報
   * @returns {Promise<string>}
   * @throws {Error} 認証情報が無い・失効している・取得に失敗したとき
   */
  async _getAccessToken(creds) {
    if (this._accessToken && Date.now() < this._tokenExpiresAt) return this._accessToken;
    const { client_id, client_secret, refresh_token } = creds?.spotify || {};
    if (!client_id || !client_secret || !refresh_token) {
      throw new Error('Spotify認証情報が設定されていません（管理画面でSpotify連携を認証してください）');
    }
    const authHeader = 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authHeader },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant') {
        throw new Error('Spotifyの認証が失効しています。管理画面で再度Spotify連携を認証してください。');
      }
      throw new Error(`Spotifyアクセストークンの取得に失敗しました: ${data.error || res.status}`);
    }
    this._accessToken = data.access_token;
    // 有効期限（普通は3600秒）の2分前に切れたことにする
    this._tokenExpiresAt = Date.now() + Math.max((data.expires_in || 3000) - 120, 60) * 1000;
    return this._accessToken;
  }

  /**
   * API を呼ぶ共通の処理（トークンの取得・呼び出し・エラーの処理）。各メソッドはパスと結果の整形だけを書く。
   * @param {Record<string, any>} creds
   * @param {string} path API のパス（/me/... など）
   * @param {{method?: string, body?: string, query?: Record<string, any>, label?: string}} [opts] body は JSON の文字列
   * @returns {Promise<any>} 応答の JSON（204、またはレート制限で待機中なら null）
   * @throws {Error} 失敗したとき（401・403 は再認証を案内する文になる）
   */
  async _apiCall(creds, path, { method = 'GET', body, query, label } = {}) {
    const accessToken = await this._getAccessToken(creds);
    const url = new URL(`https://api.spotify.com/v1${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const res = await spotifyFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      logPrefix: '[Secretary Spotify]',
      label: label || path,
    });
    if (!res) throw new Error('Spotify APIが現在レート制限中です。時間をおいて再度お試しください。');
    if (res.status === 204) return null; // 「現在何も再生していない」等の正常な空レスポンス
    if (!res.ok) {
      // スコープ不足は普通 403 だが、API によっては 401 で返る（/me/player/currently-playing など）ので、
      // どちらも再認証の案内にする
      if (res.status === 401 || res.status === 403) {
        throw new Error('Spotifyの権限が不足しているか認証が失効しています（管理画面で再度Spotify連携を認証してください）。');
      }
      throw new Error(`Spotify API HTTP ${res.status}`);
    }
    return res.json();
  }

  /** 今再生している曲。何も再生していなければ null。 @param {Record<string, any>} creds */
  async getCurrentlyPlaying(creds) {
    const data = await this._apiCall(creds, '/me/player/currently-playing', { label: 'currently-playing' });
    if (!data?.item) return null;
    return {
      isPlaying: !!data.is_playing,
      trackName: data.item.name,
      artists: (data.item.artists || []).map(a => a.name).join('・'),
      albumName: data.item.album?.name || '',
    };
  }

  /** 最近再生した曲（limit は最大50）。 @param {Record<string, any>} creds @param {{limit?: number}} [opts] */
  async getRecentlyPlayed(creds, { limit = 10 } = {}) {
    const data = await this._apiCall(creds, '/me/player/recently-played', {
      query: { limit: Math.min(limit, 50) }, label: 'recently-played',
    });
    return (data?.items || []).map(it => ({
      trackName: it.track?.name || '',
      artists: (it.track?.artists || []).map(a => a.name).join('・'),
    }));
  }

  /**
   * よく聴く曲。
   * @param {Record<string, any>} creds
   * @param {{timeRange?: string, limit?: number}} [opts] timeRange は short_term・medium_term・long_term
   */
  async getTopTracks(creds, { timeRange = 'medium_term', limit = 10 } = {}) {
    const data = await this._apiCall(creds, '/me/top/tracks', {
      query: { time_range: timeRange, limit: Math.min(limit, 50) }, label: 'top-tracks',
    });
    return (data?.items || []).map(t => ({
      trackName: t.name, artists: (t.artists || []).map(a => a.name).join('・'),
    }));
  }

  /**
   * キーワードで曲を探す（プレイリストに足すための URI を得る）。
   * @param {Record<string, any>} creds @param {string} query @param {{limit?: number}} [opts]
   */
  async searchTracks(creds, query, { limit = 10 } = {}) {
    const data = await this._apiCall(creds, '/search', {
      query: { q: query, type: 'track', limit: Math.min(limit, 50) }, label: 'search',
    });
    return (data?.tracks?.items || []).map(t => ({
      uri: t.uri, trackName: t.name, artists: (t.artists || []).map(a => a.name).join('・'), albumName: t.album?.name || '',
    }));
  }

  /** ライブラリに保存した曲（お気に入り）。 @param {Record<string, any>} creds @param {{limit?: number}} [opts] */
  async getSavedTracks(creds, { limit = 20 } = {}) {
    const data = await this._apiCall(creds, '/me/tracks', {
      query: { limit: Math.min(limit, 50) }, label: 'saved-tracks',
    });
    return (data?.items || []).map(it => ({
      trackName: it.track?.name || '', artists: (it.track?.artists || []).map(a => a.name).join('・'),
    }));
  }

  /** リスナーのプレイリストの一覧。 @param {Record<string, any>} creds @param {{limit?: number}} [opts] */
  async getPlaylists(creds, { limit = 20 } = {}) {
    const data = await this._apiCall(creds, '/me/playlists', {
      query: { limit: Math.min(limit, 50) }, label: 'playlists',
    });
    return (data?.items || []).map(p => ({
      id: p.id, name: p.name, trackCount: p.tracks?.total ?? 0, isPublic: !!p.public,
    }));
  }

  /**
   * プレイリストを作る（既定は非公開）。
   * @param {Record<string, any>} creds
   * @param {{name: string, description?: string, isPublic?: boolean}} opts
   */
  async createPlaylist(creds, { name, description = '', isPublic = false }) {
    const data = await this._apiCall(creds, '/me/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description, public: !!isPublic }),
      label: 'create-playlist',
    });
    return { id: data.id, name: data.name, url: data.external_urls?.spotify || '' };
  }

  /**
   * プレイリストに曲を足す。
   * @param {Record<string, any>} creds
   * @param {{playlistId: string, trackUris: string[]}} opts trackUris は spotify:track:… の形
   */
  async addTracksToPlaylist(creds, { playlistId, trackUris }) {
    await this._apiCall(creds, `/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: 'POST',
      body: JSON.stringify({ uris: trackUris }),
      label: 'add-items-to-playlist',
    });
    return { addedCount: trackUris.length };
  }
}

module.exports = SpotifyUserService;
