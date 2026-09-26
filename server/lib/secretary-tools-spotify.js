/**
 * @file 秘書の Spotify のツール（再生中・履歴・よく聴く曲・検索・保存した曲・プレイリストの一覧と作成・曲の追加）
 *
 * 実際の処理は spotify-user-service.js（SpotifyUserService）に任せ、ここでは声で伝えやすい文への整形だけを行う。
 * ツールの宣言は secretary-tool-declarations.js、呼び出しは secretary-tools.js が集める。
 * 結果は秘書の記録（daily-briefings）にも残す。
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

const secretaryStore = require('./secretary-store');
const { spotifyUserService, wrapDataForSpeechGuidance } = require('./secretary-tools-services');

/**
 * 再生中の曲を読み上げ用の文にする。
 * @param {Record<string, any>|null} np 再生中の曲（何も無ければ null）
 * @returns {string}
 */
function formatCurrentlyPlayingForSpeech(np) {
  if (!np) return '現在Spotifyで何も再生されていません。';
  if (!np.isPlaying) return `Spotifyは一時停止中です。直前の曲は「${np.trackName}」（${np.artists}）でした。`;
  return `現在「${np.trackName}」（${np.artists}、アルバム: ${np.albumName}）を再生中です。`;
}

/**
 * 最近の再生履歴を読み上げ用の箇条書きにする。
 * @param {Array<Record<string, any>>} list
 * @returns {string}
 */
function formatRecentlyPlayedForSpeech(list) {
  if (!list || list.length === 0) return '最近の再生履歴が見つかりませんでした。';
  return list.map(t => `・${t.trackName}（${t.artists}）`).join('\n');
}

const SPOTIFY_TIME_RANGE_LABELS = { short_term: '直近4週間', medium_term: '直近6ヶ月', long_term: 'これまで全期間' };
/**
 * よく聴いている曲を読み上げ用の番号付きの一覧にする。
 * @param {Array<Record<string, any>>} list
 * @param {keyof typeof SPOTIFY_TIME_RANGE_LABELS} timeRange 集計期間
 * @returns {string}
 */
function formatTopTracksForSpeech(list, timeRange) {
  if (!list || list.length === 0) return 'よく聴いている曲が見つかりませんでした。';
  const label = SPOTIFY_TIME_RANGE_LABELS[timeRange] || timeRange;
  return `【${label}のよく聴いている曲】\n` + list.map((t, i) => `${i + 1}. ${t.trackName}（${t.artists}）`).join('\n');
}

/**
 * 曲の検索結果を読み上げ用の箇条書きにする。
 *
 * ATTENTION: 秘書への返答（toolResponse）は result と error しか Gemini へ渡らない（secretary-live-routes.js）。
 *            後で add_tracks_to_spotify_playlist に使う曲の uri は、別の項目ではなくこの文の中に埋め込む。
 *            声に出されないよう「内部情報・声に出さないこと」で囲む（スプレッドシートの ID などと同じ）。
 * @param {Array<Record<string, any>>} list
 * @param {string} query 検索の言葉
 * @returns {string}
 */
function formatSearchResultsForSpeech(list, query) {
  if (!list || list.length === 0) return `「${query}」に一致する曲が見つかりませんでした。`;
  return list.map(t => `・${t.trackName}（${t.artists}、アルバム: ${t.albumName}）`
    + `（内部情報・声に出さないこと: uri: ${t.uri}。この文字列はadd_tracks_to_spotify_playlist`
    + `ツール呼び出し時にのみそのまま使ってください）`).join('\n');
}

/**
 * 保存した曲を読み上げ用の箇条書きにする。
 * @param {Array<Record<string, any>>} list
 * @returns {string}
 */
function formatSavedTracksForSpeech(list) {
  if (!list || list.length === 0) return '保存済みの曲（お気に入り）が見つかりませんでした。';
  return list.map(t => `・${t.trackName}（${t.artists}）`).join('\n');
}

/**
 * プレイリストの一覧を読み上げ用の箇条書きにする。
 * ID は曲の追加で使うので、検索結果と同じく「内部情報・声に出さないこと」で囲んで埋め込む。
 * @param {Array<Record<string, any>>} list
 * @returns {string}
 */
function formatPlaylistsForSpeech(list) {
  if (!list || list.length === 0) return 'プレイリストが見つかりませんでした。';
  return list.map(p => `・${p.name}（${p.trackCount}曲）`
    + `（内部情報・声に出さないこと: playlist_id: ${p.id}。この文字列はadd_tracks_to_spotify_playlist`
    + `ツール呼び出し時にのみそのまま使ってください）`).join('\n');
}

// Gemini の関数呼び出しに渡すツールの宣言（8個）
const TOOL_DECLARATIONS = [
      {
        name: 'get_spotify_now_playing',
        description: 'リスナーのSpotifyで現在再生中の曲（何も再生していなければその旨）を取得します。'
          + '「今何がかかっている？」「今の曲は？」のように使います。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'get_spotify_recently_played',
        description: 'リスナーのSpotifyの直近の再生履歴を取得します。「最近聴いた曲は？」「さっきまで何を聴いてた？」のように使います。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'get_spotify_top_tracks',
        description: 'リスナーがよく聴いている曲（トップトラック）を取得します。「最近よく聴いてる曲は？」'
          + '「お気に入りの曲教えて」のように使います。期間の指定が無ければ直近6ヶ月（medium_term）を使ってください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            time_range: {
              type: 'STRING',
              description: '集計期間。short_term=直近4週間、medium_term=直近6ヶ月（既定）、long_term=これまで全期間',
              enum: ['short_term', 'medium_term', 'long_term'],
            },
          },
        },
      },
      {
        name: 'search_spotify_tracks',
        description: 'Spotifyのカタログから曲をキーワード検索します。「〇〇という曲を探して」のように使います。'
          + '検索結果をプレイリストに追加したいと言われた場合は、この結果を使ってadd_tracks_to_spotify_playlistを呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: '検索キーワード（曲名・アーティスト名等）' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_spotify_saved_tracks',
        description: 'リスナーがSpotifyのライブラリに保存済みの曲（お気に入り）一覧を取得します。'
          + '「保存した曲は？」「お気に入りの曲一覧を教えて」のように使います。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'get_spotify_playlists',
        description: 'リスナーのSpotifyプレイリスト一覧を取得します。「プレイリスト一覧を教えて」のように使います。'
          + '既存プレイリストに曲を追加したいと言われた場合は、この結果からplaylist_idを見つけて'
          + 'add_tracks_to_spotify_playlistを呼び出してください。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'create_spotify_playlist',
        description: 'Spotifyに新しいプレイリストを作成します。「プレイリストを作って」のように依頼されたときに使います。'
          + '作成直後に曲も追加したいと言われた場合は、この結果のplaylist_idを使ってadd_tracks_to_spotify_playlistを続けて呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING', description: 'プレイリスト名' },
            description: { type: 'STRING', description: 'プレイリストの説明（任意）' },
            is_public: { type: 'BOOLEAN', description: '公開プレイリストにするか（既定は非公開=false）' },
          },
          required: ['name'],
        },
      },
      {
        name: 'add_tracks_to_spotify_playlist',
        description: 'Spotifyの指定プレイリストに曲を追加します。「この曲をプレイリストに追加して」のように依頼されたときに使います。'
          + 'playlist_idはget_spotify_playlistsまたはcreate_spotify_playlistの結果から、track_urisはsearch_spotify_tracksの'
          + '結果から取得してください（声で聞き取ったIDを推測で使わないこと）。',
        parameters: {
          type: 'OBJECT',
          properties: {
            playlist_id: { type: 'STRING', description: '追加先プレイリストのID' },
            track_uris: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: '追加する曲のURI一覧（spotify:track:... 形式、search_spotify_tracksの結果から取得）',
            },
          },
          required: ['playlist_id', 'track_uris'],
        },
      },
];

/** ツールの名前から処理への対応。各処理は (args, ctx) を受け、{ result } を返す */
const TOOL_HANDLERS = {
  get_spotify_now_playing: async (args, ctx) => {
    const { creds } = ctx;
    const np = await spotifyUserService.getCurrentlyPlaying(creds);
    const result = formatCurrentlyPlayingForSpeech(np);
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_spotify_now_playing', result });
    return { result };
  },

  get_spotify_recently_played: async (args, ctx) => {
    const { creds } = ctx;
    const list = await spotifyUserService.getRecentlyPlayed(creds, { limit: 10 });
    const result = wrapDataForSpeechGuidance(formatRecentlyPlayedForSpeech(list));
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_spotify_recently_played', result });
    return { result };
  },

  get_spotify_top_tracks: async (args, ctx) => {
    const { creds } = ctx;
    const { time_range } = args || {};
    const timeRange = time_range || 'medium_term';
    const list = await spotifyUserService.getTopTracks(creds, { timeRange });
    const result = wrapDataForSpeechGuidance(formatTopTracksForSpeech(list, timeRange));
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_spotify_top_tracks', result, timeRange });
    return { result };
  },

  search_spotify_tracks: async (args, ctx) => {
    const { creds } = ctx;
    const { query } = args || {};
    const list = await spotifyUserService.searchTracks(creds, query, { limit: 10 });
    const result = wrapDataForSpeechGuidance(formatSearchResultsForSpeech(list, query));
    secretaryStore.appendEntry('daily-briefings', { tool: 'search_spotify_tracks', result, query });
    return { result };
  },

  get_spotify_saved_tracks: async (args, ctx) => {
    const { creds } = ctx;
    const list = await spotifyUserService.getSavedTracks(creds, { limit: 20 });
    const result = wrapDataForSpeechGuidance(formatSavedTracksForSpeech(list));
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_spotify_saved_tracks', result });
    return { result };
  },

  get_spotify_playlists: async (args, ctx) => {
    const { creds } = ctx;
    const list = await spotifyUserService.getPlaylists(creds, { limit: 20 });
    const result = wrapDataForSpeechGuidance(formatPlaylistsForSpeech(list));
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_spotify_playlists', result });
    return { result };
  },

  create_spotify_playlist: async (args, ctx) => {
    const { creds } = ctx;
    const { name, description, is_public } = args || {};
    const playlist = await spotifyUserService.createPlaylist(creds, { name, description, isPublic: !!is_public });
    // playlist_id は続く曲の追加で使うので、検索結果と同じくこの文に埋め込む
    const result = `プレイリスト「${playlist.name}」を作成しました。`
      + `（内部情報・声に出さないこと: playlist_id: ${playlist.id}。この文字列は`
      + `add_tracks_to_spotify_playlistツール呼び出し時にのみそのまま使ってください）`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'create_spotify_playlist', result, name, playlistId: playlist.id });
    return { result };
  },

  add_tracks_to_spotify_playlist: async (args, ctx) => {
    const { creds } = ctx;
    const { playlist_id, track_uris } = args || {};
    const res = await spotifyUserService.addTracksToPlaylist(creds, { playlistId: playlist_id, trackUris: track_uris || [] });
    const result = `${res.addedCount}曲をプレイリストに追加しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'add_tracks_to_spotify_playlist', result, playlistId: playlist_id });
    return { result };
  },
};

module.exports = { TOOL_HANDLERS, TOOL_DECLARATIONS };
