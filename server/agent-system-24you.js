/**
 * @file 24/You チャンネル（しゃべりの無い、AI が選んだ曲を流し続けるチャンネル）のエージェントシステム
 *
 * ナレーションのエージェントも BGM も無く、曲を選ぶ・流す・終わるのを待つ、をひたすら繰り返す。
 * ChannelAgentBase を継承するが、読み上げとミキサーは使わず _showLoop を丸ごと上書きする。
 *
 * 選び方（モード）は5つ。config.json の program.selection_mode で切り替える。
 * - omakase（おまかせ）: 曜日・時間帯・リスナーの好みから LLM に選ばせる
 * - anokoro（あの頃）: 誕生日と指定の年齢から「その頃」の3年間のヒット曲を LLM に選ばせる
 * - wagamama（わがまま）: リスナーが書いたリクエスト（気分・場面）に合う曲を LLM に選ばせる
 * - artist（歌手）: 登録した好きなアーティストから Spotify の検索で選ぶ（LLM を使わない）
 * - shinpu（新譜）: Spotify の検索で最近のアルバム・曲から選ぶ（LLM を使わない）
 *
 * LLM を使う3つは、1回の呼び出しで TWENTYFOURYOU_BATCH_SIZE 曲をまとめて選ばせ、条件（モードと
 * cacheKey）ごとにディスクへ残して、同じ条件の間はそこから1曲ずつ使う。先読みはしない（まだ一度も
 * 選んでいない条件で待つのはやむを得ないものとし、API の費用を使わない方を採る）。
 *
 * 保存先は server/data/channels/24you/ の config.json（設定）・played_tracks.json（再生の履歴）・
 * track_batch_cache.json（選曲の候補）。利用元は server.js。
 *
 * ATTENTION: 曲の再生の終わりはクライアント（Spotify SDK）の通知で知る。切断されると通知が来ないので、
 * 接続と切断の両方で待つのをやめる（onClientConnected・onClientDisconnected）。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */
'use strict';

const { writeJsonFile } = require('./lib/atomic-json');
const path = require('path');
const { getLogger } = require('./logger');
const ChannelAgentBase = require('./channel-base');
const activityDb = require('./activity-db');
const spotifyRateLimit = require('./spotify-rate-limit');
const spotifyService = require('./services/spotify-service');
const jsonFileStore = require('./lib/json-file-store');

const TWENTYFOURYOU_CONFIG_PATH = path.join(__dirname, 'data', 'channels', '24you', 'config.json');
const TWENTYFOURYOU_PLAYED_PATH = path.join(__dirname, 'data', 'channels', '24you', 'played_tracks.json');
// 選曲の候補の保存先。メモリではなくディスクに置く（再起動しても残るように）
const TWENTYFOURYOU_BATCH_CACHE_PATH = path.join(__dirname, 'data', 'channels', '24you', 'track_batch_cache.json');
// 残しておく候補のまとまりの数（モードと条件の組み合わせ）。おまかせは曜日と時間帯で条件が変わるので、
// 行き来しても前のものが残るよう多めに持つ（1件で16曲・数KB）
const TWENTYFOURYOU_BATCH_CACHE_MAX = 24;
const TWENTYFOURYOU_PLAYED_MAX   = 200; // 再生の履歴を残す件数（他のチャンネルと同じ）
// 同じ曲を繰り返さない期間（時間）。
// BUGFIX: 期間は7日。48時間だったころ、候補の少なさ（あの頃モードは3年間に限られ、他のモードも LLM が
// 同じ問いにほぼ同じ答えを返す）から、数分おきに同じ曲が流れていた
const TWENTYFOURYOU_PLAYED_HOURS = 168;
const TWENTYFOURYOU_DEDUP_RETRIES = 3;  // 直近と重なったときに選び直す回数
const TWENTYFOURYOU_DEFAULT_ANOKORO_AGE = 20; // あの頃モードで、年齢の指定が無いときの年齢
// 1回の LLM の呼び出しでまとめて選ばせる曲数。
// BUGFIX: 16曲。8曲だったころ、特にあの頃モード（3年間の中から選ぶ）では選び直しがすぐ尽き、
// 「あきらめて同じ曲を流す」が頻繁に起きていた
const TWENTYFOURYOU_BATCH_SIZE = 16;
const TWENTYFOURYOU_SPOTIFY_BACKOFF_MS = 5 * 60 * 1000; // Spotify に断られ続けるときに呼び出しを控える時間

/** 24/You チャンネルのエージェントシステム（ファイルの冒頭参照）。 */
class TwentyFourYouAgentSystem extends ChannelAgentBase {
  /**
   * @param {Record<string, any>} mixer 音声のミキサー（このチャンネルでは使わない）
   * @param {Record<string, any>} serverWrapper WebSocket への配信などを持つサーバー側のラッパー
   */
  constructor(mixer, serverWrapper) {
    super(mixer, serverWrapper, TWENTYFOURYOU_CONFIG_PATH, '24You');
    this._playedPath   = TWENTYFOURYOU_PLAYED_PATH;
    this._playedPieces = this._loadPlayedPieces();
    this._playedMax    = TWENTYFOURYOU_PLAYED_MAX;
    this._trackBatchCache = this._loadTrackBatchCache();
  }

  // ─── 選曲の候補の保存 ───────────────────────────────────────────

  /**
   * 保存してある選曲の候補を読む。
   *
   * BUGFIX: 候補はディスクに残す。メモリだけに持ち、モードごとに1件だけだったころ、再起動や条件の変更の
   * たびに捨てられ、チャンネルを開くたびに LLM の選曲を十数秒待たされていた。
   *
   * @returns {Array<any>} [{ id: 'モード|条件', candidates: [...], updatedAt }] の一覧（新しい順）
   */
  _loadTrackBatchCache() {
    const raw = jsonFileStore.readJsonFile(TWENTYFOURYOU_BATCH_CACHE_PATH, [], `[${this._channelId}]`);
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => e && typeof e.id === 'string' && Array.isArray(e.candidates));
  }

  /**
   * 選曲の候補を保存する。
   * @returns {void}
   */
  _saveTrackBatchCache() {
    jsonFileStore.writeJsonFile(TWENTYFOURYOU_BATCH_CACHE_PATH, this._trackBatchCache, `[${this._channelId}]`);
  }

  /**
   * 使い切ったまとまりを捨て、新しい順に上限（TWENTYFOURYOU_BATCH_CACHE_MAX）まで残す。
   * @returns {void}
   */
  _trimTrackBatchCache() {
    this._trackBatchCache = this._trackBatchCache
      .filter(e => e.candidates.length > 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, TWENTYFOURYOU_BATCH_CACHE_MAX);
  }

  // ─── 接続と切断 ─────────────────────────────────────────────────

  /**
   * クライアントがつながったとき。曲の再生の終わりを待っていれば、その待ちを打ち切って選曲を再開し、
   * 今持っている再生の履歴をすぐ送る。
   *
   * BUGFIX: 曲の終わりはクライアントの通知で知るので、切断されている間は通知が来ず、曲の長さ（数分）
   * ずっと待ち続けてしまう。つながった時点で待ちを打ち切る（切断のときも同じ・onClientDisconnected）。
   * BUGFIX: 履歴をここで送る。次の選曲が終わるまでイベントが飛ばず、履歴があるのに画面には一時的に
   * 「再生履歴がありません」と出ていた。
   *
   * @returns {void}
   */
  onClientConnected() {
    super.onClientConnected();
    if (this._spotifyPlayResolve) {
      getLogger().info(`[${this._channelId}] クライアント接続 — Spotify 再生待機を中断して選曲を即時再開します`);
      clearTimeout(this._spotifyPlayTimer);
      const _resolve = this._spotifyPlayResolve;
      this._spotifyPlayResolve = null;
      this._spotifyPlayTimer   = null;
      _resolve();
    }
    this._broadcastPlayedList();
  }

  /**
   * クライアントが切れたとき。誰も聴いていなければ、曲の再生の終わりを待つのをやめる
   * （通知が来ないため。onClientConnected 参照）。
   * @returns {void}
   */
  onClientDisconnected() {
    super.onClientDisconnected();
    if (this.server.getClientCount() === 0 && this._spotifyPlayResolve) {
      getLogger().info(`[${this._channelId}] 全クライアント切断 — Spotify 再生待機を中断します`);
      clearTimeout(this._spotifyPlayTimer);
      const _resolve = this._spotifyPlayResolve;
      this._spotifyPlayResolve = null;
      this._spotifyPlayTimer   = null;
      _resolve();
    }
  }

  // ─── モードの切り替え ───────────────────────────────────────────

  /**
   * 選び方（モード）と、その設定を変える。管理画面と Play 画面の両方から呼ばれる。
   *
   * 変えた内容は config.json に書き、画面へも知らせる。先読みしてあった次の曲は前のモードで選ばれて
   * いるので、捨てて選び直す（しないと、新しいモードは次の次の曲からしか効かない）。
   *
   * @param {object} [opts]
   * @param {string} [opts.mode] 選び方（omakase・anokoro・artist・shinpu・wagamama）
   * @param {number} [opts.anokoro_age] あの頃モードの年齢
   * @param {string[]} [opts.favorite_artists] 歌手モードの好きなアーティスト
   * @param {string} [opts.language_pref] 邦楽・洋楽の希望（japanese・western・any）
   * @param {string} [opts.wagamama_request] わがままモードのリクエストの文
   * @returns {void}
   */
  handleModeChange({ mode, anokoro_age, favorite_artists, language_pref, wagamama_request } = {}) {
    const config = this.getConfig();
    if (!config.program) config.program = {};
    if (mode) config.program.selection_mode = mode;
    if (anokoro_age       !== undefined) config.program.anokoro_age       = anokoro_age;
    if (favorite_artists  !== undefined) config.program.favorite_artists  = favorite_artists;
    if (language_pref     !== undefined) config.program.language_pref     = language_pref;
    if (wagamama_request  !== undefined) config.program.wagamama_request  = wagamama_request;
    writeJsonFile(this._configPath, config);
    this._broadcast({
      event: '24YOU_MODE_UPDATE',
      mode: config.program.selection_mode,
      anokoro_age:        config.program.anokoro_age        ?? null,
      favorite_artists:   config.program.favorite_artists   ?? [],
      language_pref:      config.program.language_pref      ?? 'any',
      wagamama_request:   config.program.wagamama_request   ?? '',
    });

    if (this._pendingTrack) {
      getLogger().info(`[${this._channelId}] モード変更を検知 — 先読み済みの曲を破棄して選び直します`);
      this._prefetchNextTrack();
    }
  }

  /**
   * 邦楽・洋楽の希望を、プロンプトに入れる一文にする。
   * @param {Record<string, any>} config チャンネルの設定
   * @returns {string} 指示の文（希望が無ければ空文字）
   */
  _languageInstruction(config) {
    const pref = config.program?.language_pref || 'any';
    if (pref === 'japanese') return '邦楽（日本のアーティストによる日本語の楽曲）のみを選んでください。';
    if (pref === 'western')  return '洋楽（海外のアーティストによる楽曲）のみを選んでください。';
    return '';
  }

  /**
   * 直近に流した曲を、LLM への「避けてほしい曲」の一覧にする（LLM を使う3つのモードで共通）。
   *
   * BUGFIX: この一覧を渡す。渡していなかったころ、候補を取り直すたびに LLM は履歴を知らないまま同じ問いに
   * 答えるので、ほぼ同じ曲が返り続けていた。履歴は最大200件たまりうるので、プロンプトが膨らまないよう
   * 直近の limit 件に絞る。
   *
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @param {number} [limit] 渡す件数の上限
   * @returns {string} プロンプトに入れる文（履歴が無ければ空文字）
   */
  _buildRecentSection(recentKeys, limit = 40) {
    if (!recentKeys || recentKeys.length === 0) return '';
    const lines = recentKeys.slice(0, limit).map(k => {
      const [artist, title] = k.split('|');
      return `- ${artist} 「${title}」`;
    });
    return `\n【直近再生した曲 — 避けてください】\n${lines.join('\n')}\n`;
  }

  // ─── まとめて選んだ候補からの消費 ───────────────────────────────

  /**
   * 保存してある候補から1曲決める。無ければ LLM にまとめて選ばせてから決める。
   *
   * 時間帯・年代・リクエストの文といった条件は曲ごとには変わらないので、1回の呼び出しで
   * TWENTYFOURYOU_BATCH_SIZE 曲を選ばせ、同じ条件（cacheKey）の間はそこから1曲ずつ使う。
   * 直近に流した曲と Spotify で見つからない曲は、LLM を呼ばずに次の候補へ送る。
   *
   * ATTENTION: 取り出した候補はその都度ディスクに書き戻す。途中で止まっても同じ曲を二度使わないため。
   *
   * @param {string} mode 選び方
   * @param {string} cacheKey 条件（これが同じ間は同じ候補を使う）
   * @param {string} systemPrompt LLM への役割の指示
   * @param {string} userPrompt LLM への依頼の文
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @param {any} agentKey 記録用のエージェントのキー
   * @returns {Promise<any>} Spotify の曲（決められなければ null）
   */
  async _selectFromBatch(mode, cacheKey, systemPrompt, userPrompt, recentKeys, agentKey) {
    if (!Array.isArray(this._trackBatchCache)) this._trackBatchCache = [];
    const id = `${mode}|${cacheKey}`;

    const tryResolveFromCache = async (entry) => {
      while (entry && entry.candidates.length > 0) {
        const plan = entry.candidates.shift();
        entry.updatedAt = Date.now();
        this._saveTrackBatchCache();
        if (!plan?.spotify_query) continue;
        if (plan.artist && plan.title && recentKeys.includes(`${plan.artist}|${plan.title}`)) {
          continue; // 直近に流した曲なので、LLM を呼ばずに次の候補へ
        }
        const track = await this._searchSpotifyTrack(plan.spotify_query, { artist: plan.artist });
        if (track) return track;
        // Spotify で見つからなかったときも、次の候補へ（LLM を呼ばずに済ませる）
      }
      return null;
    };

    const cached = this._trackBatchCache.find(e => e.id === id);
    if (cached) {
      getLogger().info(`[${this._channelId}] ${mode}: キャッシュ済みの候補${cached.candidates.length}曲から選びます（Gemini呼び出し無し）`);
      const resolved = await tryResolveFromCache(cached);
      if (resolved) return resolved;
      // 使い切った（または全部だめだった）ので、下で新しく選ばせる
    }

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', agentKey);
    if (!raw) return null;
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const list = JSON.parse(match[0]);
      if (!Array.isArray(list) || list.length === 0) return null;
      const entry = { id, candidates: list, updatedAt: Date.now() };
      this._trackBatchCache = [entry, ...this._trackBatchCache.filter(e => e.id !== id)];
      this._trimTrackBatchCache();
      this._saveTrackBatchCache();
      getLogger().info(`[${this._channelId}] ${mode}: Geminiから${list.length}曲をまとめて取得しキャッシュしました（保持${this._trackBatchCache.length}件）`);
      return await tryResolveFromCache(entry);
    } catch (e) {
      getLogger().warn(`[24You] ${mode}バッチ選曲パース失敗: ${e.message}`);
      return null;
    }
  }

  // ─── 選曲 ───────────────────────────────────────────────────────

  /**
   * 今のモードに応じた選び方で1曲選ぶ。
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectNextTrack(recentKeys) {
    const mode = this.getConfig().program?.selection_mode || 'omakase';
    if (mode === 'anokoro')  return this._selectAnokoroTrack(recentKeys);
    if (mode === 'artist')   return this._selectArtistModeTrack(recentKeys);
    if (mode === 'shinpu')   return this._selectShinpuTrack(recentKeys);
    if (mode === 'wagamama') return this._selectWagamamaTrack(recentKeys);
    return this._selectOmakaseTrack(recentKeys);
  }

  /**
   * おまかせモード。曜日・時間帯・リスナーの好みに合う曲を LLM に選ばせる。
   * 同じ曜日・時間帯・好みの間は、選んである候補から使う。
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectOmakaseTrack(recentKeys) {
    const config   = this.getConfig();
    const listener = this._getListenerProfile();

    const now     = new Date();
    const hour    = now.getHours();
    const timeCtx = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    const dayJa   = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];

    const listenerInfo = [
      listener.hobbies              ? `趣味: ${listener.hobbies}`                       : '',
      listener.interests            ? `興味: ${listener.interests}`                     : '',
      (listener.music_genres || []).length ? `好きなジャンル: ${listener.music_genres.join('、')}` : '',
    ].filter(Boolean).join('\n');

    const langInstruction = this._languageInstruction(config);
    // ATTENTION: 直近に流した曲は条件（cacheKey）に入れない。曲ごとに変わるので、入れると候補が1曲ごとに
    // 作り直され、まとめて選ぶ意味が無くなる。直近の曲を避けるのは候補を使うときに行う（_selectFromBatch）。
    // プロンプトに入れるのは、実際に選ばせ直すときには最新の履歴が使われるので問題ない
    const cacheKey = `${dayJa}|${timeCtx}|${listenerInfo}|${langInstruction}`;
    const recentSection = this._buildRecentSection(recentKeys);

    const systemPrompt = 'あなたは音楽ストリーミングチャンネルの選曲AIです。ナレーションは一切なく、曲を選ぶことだけが仕事です。';
    const userPrompt = `${dayJa}曜日${timeCtx}（${hour}時台）に合う曲を${TWENTYFOURYOU_BATCH_SIZE}曲選んでください。
${listenerInfo ? `【リスナー情報】\n${listenerInfo}\n` : ''}${recentSection}
ジャンル・時代を問わず、その時間帯・リスナーの好みに合いそうな実在する楽曲を${TWENTYFOURYOU_BATCH_SIZE}曲、重複なく選んでください。${langInstruction ? `\n【重要】${langInstruction}` : ''}
有効なJSON配列のみ出力（マークダウン不要）:
[
  { "artist": "アーティスト名", "title": "曲名", "spotify_query": "Spotify検索クエリ（artist:\\"アーティスト名\\" track:\\"曲名\\" 形式）" },
  ...
]`;

    return await this._selectFromBatch('omakase', cacheKey, systemPrompt, userPrompt, recentKeys, 'curator');
  }

  /**
   * あの頃モード。誕生日と指定の年齢から年を求め、その前後1年（計3年間）のヒット曲を LLM に選ばせる。
   * 誕生日が設定されていなければ、おまかせにする。
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectAnokoroTrack(recentKeys) {
    const config   = this.getConfig();
    const listener = this._getListenerProfile();

    const birthYear = listener.birthday ? parseInt(listener.birthday.slice(0, 4), 10) : null;
    if (!birthYear) {
      getLogger().warn('[24You] あの頃モード: 誕生日未設定のためおまかせにフォールバック');
      return this._selectOmakaseTrack(recentKeys);
    }
    const age = config.program?.anokoro_age || TWENTYFOURYOU_DEFAULT_ANOKORO_AGE;
    const centerYear = birthYear + age;
    const startYear  = centerYear - 1;
    const endYear    = centerYear + 1;

    const langInstruction = this._languageInstruction(config);
    const cacheKey = `${startYear}-${endYear}|${langInstruction}`;
    const recentSection = this._buildRecentSection(recentKeys);

    const systemPrompt = 'あなたは音楽ストリーミングチャンネルの選曲AIです。ナレーションは一切なく、曲を選ぶことだけが仕事です。';
    const userPrompt = `${startYear}年〜${endYear}年に流行した曲の中から${TWENTYFOURYOU_BATCH_SIZE}曲選んでください。
その年代を代表する、多くの人が知っているヒット曲・名曲を、重複なく${TWENTYFOURYOU_BATCH_SIZE}曲選んでください。${langInstruction || '（日本の曲・海外の曲どちらでも構いません）'}
${recentSection}
有効なJSON配列のみ出力（マークダウン不要）:
[
  { "artist": "アーティスト名", "title": "曲名", "spotify_query": "Spotify検索クエリ（artist:\\"アーティスト名\\" track:\\"曲名\\" 形式）" },
  ...
]`;

    return await this._selectFromBatch('anokoro', cacheKey, systemPrompt, userPrompt, recentKeys, 'curator');
  }

  /**
   * 歌手モード。登録した好きなアーティストから1人選び、その曲を Spotify の検索から1曲選ぶ（LLM は使わない）。
   * 登録が無ければ、おまかせにする。
   *
   * ATTENTION: アーティストの人気曲の API は使えない（承認済みのアプリ限定で、このアプリでは断られる）。
   * ふつうの検索で代わりにする。
   *
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectArtistModeTrack(recentKeys) {
    const config  = this.getConfig();
    const artists = (config.program?.favorite_artists || []).map(a => a.trim()).filter(Boolean);
    if (artists.length === 0) {
      getLogger().warn('[24You] 歌手モード: お気に入りアーティスト未登録のためおまかせにフォールバック');
      return this._selectOmakaseTrack(recentKeys);
    }

    const recentArtists = recentKeys.map(k => k.split('|')[0]);
    const candidates     = artists.filter(a => !recentArtists.includes(a));
    const pickList        = candidates.length > 0 ? candidates : artists;
    const artistName      = pickList[Math.floor(Math.random() * pickList.length)];

    const tracks = await this._searchArtistTracks(artistName);
    if (!tracks || tracks.length === 0) {
      getLogger().warn(`[24You] 歌手モード: 楽曲が見つかりません: ${artistName}`);
      return null;
    }

    const recentTitles = recentKeys.map(k => k.split('|')[1]);
    const filtered      = tracks.filter(t => !recentTitles.includes(t.name));
    const pool          = filtered.length > 0 ? filtered : tracks;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 新譜モード。Spotify の検索で最近のアルバムを1つ選び、その中から1曲選ぶ（LLM は使わない）。
   *
   * ATTENTION: 新着の API は使えない（承認済みのアプリ限定）。ふつうの検索（tag:new）で代わりにする。
   * BUGFIX: 邦楽の指定のときは別の道を通る。市場の指定（JP）は「その地域で聴けるか」でしかなく、
   * アーティストの国や言語では絞れないので、海外の新譜ばかりが返っていた。ジャンル（j-pop）での曲の検索に
   * 切り替えて邦楽に絞る（このジャンルの絞り込みはアルバムの検索には効かず、曲の検索でだけ効く）。
   *
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectShinpuTrack(recentKeys) {
    const pref = this.getConfig().program?.language_pref || 'any';

    if (pref === 'japanese') {
      const tracks = await this._searchNewTracksByGenre('j-pop', 'JP');
      if (!tracks || tracks.length === 0) return null;
      const recentTitles = recentKeys.map(k => k.split('|')[1]);
      const filtered      = tracks.filter(t => (t.duration_ms || 0) >= 60 * 1000 && !recentTitles.includes(t.name));
      const pool          = filtered.length > 0 ? filtered : tracks;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    const country = pref === 'western' ? 'US' : 'JP'; // 指定なしは JP にする
    const albums  = await this._searchNewAlbums(country);
    if (!albums || albums.length === 0) return null;

    const album  = albums[Math.floor(Math.random() * albums.length)];
    const tracks = await this._getAlbumTracks(album, country);
    if (!tracks || tracks.length === 0) return null;

    const recentTitles = recentKeys.map(k => k.split('|')[1]);
    const filtered      = tracks.filter(t => !recentTitles.includes(t.name));
    const pool          = filtered.length > 0 ? filtered : tracks;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * わがままモード。リスナーが書いたリクエスト（「雨の日に聴きたい」など、気分や場面）に合う曲を
   * LLM に選ばせる。リクエストが無ければ、おまかせにする。
   * @param {string[]} recentKeys 直近に流した曲（'アーティスト|曲名'）
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectWagamamaTrack(recentKeys) {
    const config  = this.getConfig();
    const request = (config.program?.wagamama_request || '').trim();
    if (!request) {
      getLogger().warn('[24You] わがままモード: リクエスト未設定のためおまかせにフォールバック');
      return this._selectOmakaseTrack(recentKeys);
    }

    const langInstruction = this._languageInstruction(config);
    const cacheKey = `${request}|${langInstruction}`;
    const recentSection = this._buildRecentSection(recentKeys);

    const systemPrompt = 'あなたは音楽ストリーミングチャンネルの選曲AIです。ナレーションは一切なく、リスナーの自由なリクエストに合う曲を選ぶことだけが仕事です。';
    const userPrompt = `リスナーから次のようなリクエストが届いています。この気分・シチュエーションに合う曲を${TWENTYFOURYOU_BATCH_SIZE}曲選んでください。
【リクエスト】${request}
${langInstruction ? `\n【重要】${langInstruction}` : ''}${recentSection}
リクエストの雰囲気に合う、実在する楽曲を重複なく${TWENTYFOURYOU_BATCH_SIZE}曲選んでください。
有効なJSON配列のみ出力（マークダウン不要）:
[
  { "artist": "アーティスト名", "title": "曲名", "spotify_query": "Spotify検索クエリ（artist:\\"アーティスト名\\" track:\\"曲名\\" 形式）" },
  ...
]`;

    return await this._selectFromBatch('wagamama', cacheKey, systemPrompt, userPrompt, recentKeys, 'curator');
  }

  // ─── Spotify の呼び出し（channel-base.js に無いものをここに置く）─────

  /**
   * Spotify を呼ぶ。断られた（レート制限）ときの待ち方は services/spotify-service.js に任せ、
   * このチャンネル用の値（その場で待つのは10秒まで・断られ続けたら5分控える）を渡す。
   *
   * BUGFIX: 断られたときに一度待ってやり直し、それでも断られたら一定時間呼び出しを控える。すぐ諦めて
   * いたころ、選び直しと5秒ごとのループが同じ制限を踏み続け、制限がなかなか解けなかった。
   * ATTENTION: その場で待つのは10秒まで。Spotify が18時間のような長い待ち時間を返すことがあり、
   * そのまま待つと番組のループごと止まる。
   *
   * @param {string} url 呼び出す URL
   * @param {Record<string, string>} headers ヘッダー（認証）
   * @param {string} label ログに出す呼び出しの名前
   * @returns {Promise<any>} 応答（呼べなければ null）
   */
  async _fetchSpotifyWithRetry(url, headers, label) {
    return spotifyService.spotifyFetch(url, {
      headers,
      logPrefix: '[24You]',
      label,
      maxSyncWaitMs: 10 * 1000,
      persistBackoffMs: TWENTYFOURYOU_SPOTIFY_BACKOFF_MS,
    });
  }

  /**
   * 指定したアーティストの曲を検索し、アーティスト名がぴったり一致するものに絞って返す。
   *
   * BUGFIX: 取り出す位置（offset）を毎回ずらす。先頭から取っていたころ、関連度の順で同じ人気曲の上位10曲
   * ばかりが返り、曲の多い歌手ほど同じ曲が繰り返されていた。
   *
   * @param {string} name アーティスト名
   * @param {string} [market] 市場（国）
   * @returns {Promise<Array<any>|null>} 曲の一覧（取れなければ null）
   */
  async _searchArtistTracks(name, market = 'JP') {
    const token = await this._getSpotifyToken();
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}` };
    const baseUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(`artist:"${name}"`)}&type=track&market=${market}`;
    try {
      // ATTENTION: 取り出す件数は10まで。このアプリの検索では11以上だと断られる。
      // まず総件数だけ取り、その範囲で位置を決める
      const probeRes = await this._fetchSpotifyWithRetry(`${baseUrl}&limit=1`, headers, `歌手モード probe: ${name}`);
      if (!probeRes || !probeRes.ok) {
        if (probeRes) getLogger().warn(`[24You] 歌手モード: 検索失敗 HTTP ${probeRes.status} (${name})`);
        return null;
      }
      const probeData = await probeRes.json();
      const total     = probeData.tracks?.total || 0;
      // 位置を大きくしすぎると、このアプリの検索で別の制限に当たるおそれがあるので控えめにする
      const maxOffset = Math.max(0, Math.min(total - 10, 190));
      const offset    = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0;

      const res = await this._fetchSpotifyWithRetry(`${baseUrl}&limit=10&offset=${offset}`, headers, `歌手モード: ${name}`);
      if (!res || !res.ok) {
        if (res) getLogger().warn(`[24You] 歌手モード: 検索失敗 HTTP ${res.status} (${name})`);
        return null;
      }
      const data = await res.json();
      const items = data.tracks?.items || [];
      const target = name.trim().toLowerCase();
      const exact = items.filter(t => (t.artists || []).some(a => (a.name || '').trim().toLowerCase() === target));
      return exact.length > 0 ? exact : items;
    } catch (e) {
      getLogger().warn(`[24You] 歌手モード: 検索エラー: ${e.message}`);
      return null;
    }
  }

  /**
   * 最近出たアルバムを検索して返す（新譜モード）。
   * @param {string} [country] 市場（国）
   * @returns {Promise<Array<any>|null>} アルバムの一覧（取れなければ null）
   */
  async _searchNewAlbums(country = 'JP') {
    const token = await this._getSpotifyToken();
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      // ATTENTION: 取り出す件数は10まで（11以上だと断られる）
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent('tag:new')}&type=album&limit=10&market=${country}`;
      const res = await this._fetchSpotifyWithRetry(url, headers, '新譜モード(album)');
      if (!res || !res.ok) {
        if (res) getLogger().warn(`[24You] 新譜モード: 検索失敗 HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      return data.albums?.items || [];
    } catch (e) {
      getLogger().warn(`[24You] 新譜モード: 検索エラー: ${e.message}`);
      return null;
    }
  }

  /**
   * 指定したジャンルの、去年から今年までの曲を検索して返す（邦楽の新譜モード用）。
   *
   * ATTENTION: ジャンルの絞り込みはアルバムの検索には効かないので、曲の検索を使う。
   * 取り出す位置は歌手モードと同じくずらし、同じ人気曲に偏らないようにする。
   *
   * @param {string} genre ジャンル（例: 'j-pop'）
   * @param {string} [market] 市場（国）
   * @returns {Promise<Array<any>|null>} 曲の一覧（取れなければ null）
   */
  async _searchNewTracksByGenre(genre, market = 'JP') {
    const token = await this._getSpotifyToken();
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}` };
    const currentYear = new Date().getFullYear();
    const q = `genre:"${genre}" year:${currentYear - 1}-${currentYear}`;
    const baseUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&market=${market}`;
    try {
      // ATTENTION: 取り出す件数は10まで（11以上だと断られる）
      const probeRes = await this._fetchSpotifyWithRetry(`${baseUrl}&limit=1`, headers, `新譜モード probe(genre=${genre})`);
      if (!probeRes || !probeRes.ok) {
        if (probeRes) getLogger().warn(`[24You] 新譜モード: 検索失敗 HTTP ${probeRes.status} (genre=${genre})`);
        return null;
      }
      const probeData = await probeRes.json();
      const total     = probeData.tracks?.total || 0;
      const maxOffset = Math.max(0, Math.min(total - 10, 190));
      const offset    = maxOffset > 0 ? Math.floor(Math.random() * (maxOffset + 1)) : 0;

      const res = await this._fetchSpotifyWithRetry(`${baseUrl}&limit=10&offset=${offset}`, headers, `新譜モード(genre=${genre})`);
      if (!res || !res.ok) {
        if (res) getLogger().warn(`[24You] 新譜モード: 検索失敗 HTTP ${res.status} (genre=${genre})`);
        return null;
      }
      const data = await res.json();
      return data.tracks?.items || [];
    } catch (e) {
      getLogger().warn(`[24You] 新譜モード: 検索エラー: ${e.message}`);
      return null;
    }
  }

  /**
   * アルバムに入っている曲を取り出す（1分に満たない曲は除く）。
   * @param {Record<string, any>} album Spotify のアルバム
   * @param {string} [market] 市場（国）
   * @returns {Promise<Array<any>|null>} 曲の一覧（取れなければ null）
   */
  async _getAlbumTracks(album, market = 'JP') {
    const token = await this._getSpotifyToken();
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const url = `https://api.spotify.com/v1/albums/${album.id}/tracks?market=${market}&limit=50`;
      const res = await this._fetchSpotifyWithRetry(url, headers, `アルバム楽曲取得(${album.name})`);
      if (!res || !res.ok) {
        if (res) getLogger().warn(`[24You] 新譜モード: アルバム楽曲取得失敗 HTTP ${res.status} (${album.name})`);
        return null;
      }
      const data = await res.json();
      const items = data.items || [];
      // アルバムの中の曲にはアルバムの情報が入っていないので、ここで足す（画面に出すため）
      return items
        .filter(t => (t.duration_ms || 0) >= 60 * 1000)
        .map(t => ({ ...t, album: { name: album.name, images: album.images, release_date: album.release_date } }));
    } catch (e) {
      getLogger().warn(`[24You] 新譜モード: アルバム楽曲取得エラー: ${e.message}`);
      return null;
    }
  }

  /**
   * 再生の履歴を画面へ送る。
   * @returns {void}
   */
  _broadcastPlayedList() {
    this._broadcast({ event: '24YOU_PLAYED_LIST', list: this._playedPieces.slice(0, this._playedMax) });
  }

  /**
   * 直近に流した曲を避けて1曲選ぶ（重なったら TWENTYFOURYOU_DEDUP_RETRIES 回まで選び直す）。
   * 候補が少なくて全部重なったときは、無音になるより最後の候補を流す。
   * @returns {Promise<any>} Spotify の曲（選べなければ null）
   */
  async _selectTrackWithRetry() {
    const ch = `[${this._channelId}]`;
    // ダッシュボードに「選曲中」を出すため、他のチャンネルの「考え中」と同じイベントを使う。
    // '24you_selector' にはアバターの画像が無く、ダッシュボードでは絵文字になる
    this._broadcast({ event: 'AGENT_THINKING', agent: '24you_selector', state: 'start' });
    try {
      const cutoffMs     = Date.now() - TWENTYFOURYOU_PLAYED_HOURS * 60 * 60 * 1000;
      const recentPlayed = this._playedPieces.filter(p => new Date(p.playedAt).getTime() > cutoffMs);
      const recentUris   = recentPlayed.map(p => p.uri).filter(Boolean);
      const recentKeys   = recentPlayed.map(p => `${p.artist}|${p.title}`);

      let track = null;
      let lastCandidate = null;
      for (let attempt = 0; attempt <= TWENTYFOURYOU_DEDUP_RETRIES; attempt++) {
        const candidate = await this._selectNextTrack(recentKeys);
        if (!candidate) break;
        lastCandidate = candidate;
        if (!recentUris.includes(candidate.uri)) { track = candidate; break; }
        getLogger().warn(`${ch} 重複検出（直近${TWENTYFOURYOU_PLAYED_HOURS}時間以内）: ${candidate.name} → 再選曲します（${attempt + 1}/${TWENTYFOURYOU_DEDUP_RETRIES}）`);
      }
      // 全部重なったときは、無音になるより最後の候補を流す
      if (!track && lastCandidate) {
        getLogger().warn(`${ch} リトライ上限に達したため重複を許容して再生します: ${lastCandidate.name}`);
        track = lastCandidate;
      }
      return track;
    } finally {
      this._broadcast({ event: 'AGENT_THINKING', agent: '24you_selector', state: 'end' });
    }
  }

  /**
   * 今の曲が流れている間に、次の曲を先に選んでおく（this._pendingTrack に持つ）。
   * ATTENTION: ループの中の変数ではなくインスタンスに持つこと。モードが変わったときに捨てて選び直すため。
   * @returns {void}
   */
  _prefetchNextTrack() {
    const ch = `[${this._channelId}]`;
    this._pendingTrack = this._selectTrackWithRetry().catch(e => {
      getLogger().warn(`${ch} 先読み選曲エラー: ${e.message}`);
      return null;
    });
  }

  // ─── 番組のループ（ChannelAgentBase のものを丸ごと上書きする）────────

  /**
   * 曲を選ぶ・流す・終わるのを待つ、を繰り返す。しゃべりも BGM もオープニングも無い。
   *
   * 曲の間の無音（LLM と Spotify の待ち時間）を減らすため、流している間に次の曲を選んでおく。
   * 誰も聴いていない間は選ばない。
   *
   * ATTENTION: 選び終えた曲を捨てないこと。候補からは取り出し済みで戻せないため、捨てるとその曲は
   * 二度と流れない。誰も聴いていない間も持ち越し、次にリスナーが来たときに使う
   * （モードが変わったときは _applyProgramConfig が捨てて選び直すので、古い条件の曲は残らない）。
   *
   * @returns {Promise<void>}
   */
  async _showLoop() {
    const ch = `[${this._channelId}]`;

    while (this.isLoopRunning && this.server.getClientCount() === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this.isLoopRunning) return;

    /** @type {any} 先に選んでおいた次の曲（誰も聴いていない間も持ち越す） */
    this._pendingTrack = null;

    while (this.isLoopRunning) {
      if (this.server.getClientCount() === 0) {
        // 先読み済みの曲はそのまま持ち越す（捨てると候補から消えたまま二度と流れない）
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      try {
        const mode = this.getConfig().program?.selection_mode || 'omakase';
        let track;
        if (this._pendingTrack) {
          getLogger().info(`${ch} 先読み済みの曲を使用します (mode=${mode})`);
          track = await this._pendingTrack;
        } else {
          getLogger().info(`${ch} 選曲中... (mode=${mode})`);
          track = await this._selectTrackWithRetry();
        }
        this._pendingTrack = null;

        if (!track) {
          // Spotify の呼び出しを控えている間は、5秒ごとに呼んでも無駄なので、解けるまで（最大5分）待つ
          if (spotifyRateLimit.isBackedOff()) {
            const waitMs = Math.min(spotifyRateLimit.getBackoffMinutesRemaining() * 60 * 1000, 5 * 60 * 1000) || 5000;
            getLogger().warn(`${ch} 選曲失敗（Spotify 429バックオフ中 — あと約${spotifyRateLimit.getBackoffMinutesRemaining()}分）。${Math.round(waitMs/1000)}秒後にリトライします。`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          getLogger().warn(`${ch} 選曲失敗。5秒後にリトライします。`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        if (this.server.getClientCount() === 0) {
          // 選び終えた後に誰もいなくなった。次に来たときへ回す
          this._pendingTrack = Promise.resolve(track);
          continue;
        }

        const displayArtist = (track.artists || []).map(a => a.name).join(' / ');
        const durationMs = track.duration_ms || 4 * 60 * 1000;
        getLogger().info(`${ch} 次の曲: ${displayArtist} - ${track.name}`);

        this._broadcast({ event: 'SPOTIFY_PLAY', uri: track.uri, title: track.name, artist: displayArtist, durationMs });
        this._broadcast({
          event:      'MUSIC_PLAY_START',
          mode:       'spotify_sdk',
          title:      track.name,
          artist:     displayArtist,
          albumImage: track.album?.images?.[0]?.url || null,
        });

        this._playedPieces.unshift({
          title:       track.name,
          artist:      displayArtist,
          albumName:   track.album?.name || '',
          albumImage:  track.album?.images?.[0]?.url || null,
          releaseYear: (track.album?.release_date || '').slice(0, 4) || null,
          uri:         track.uri,
          playedAt:    new Date().toISOString(),
        });
        if (this._playedPieces.length > this._playedMax) this._playedPieces.pop();
        this._savePlayedPieces();
        this._broadcastPlayedList();
        activityDb.logEvent(this._activitySessionId, 'song_played', {
          metadata: {
            title:       track.name,
            artist:      displayArtist,
            uri:         track.uri,
            album:       track.album?.name ?? null,
            duration_ms: durationMs,
          },
        });

        // 流している間に次の曲を選んでおく
        this._prefetchNextTrack();

        await this._waitForSpotifyPlayDone(durationMs + 15000);
        this._broadcast({ event: 'MUSIC_PLAY_END', title: track.name });

        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        getLogger().error(`${ch} ショーループエラー: ` + e.message);
        this._pendingTrack = null;
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

module.exports = TwentyFourYouAgentSystem;
