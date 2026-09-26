/**
 * @file Jazz チャンネル（英語で話すジャズの番組）のエージェントシステム
 *
 * 24時間続くジャズのチャンネル「琥珀色のインプロヴィゼーション」。ディレクター（jazz_director、声は無い裏方）が
 * テーマのあるセッションを企画し、パーソナリティ（jazz_personality）が英語で曲の前の紹介と曲の後のコメントを話す。
 * 英語のセリフは日本語に訳してテロップ（字幕）として出す（管理画面の caption_enabled で切り替え）。
 * 番組の進め方・Spotify での再生・日記・リクエストなどの共通の流れは MusicChannelAgentBase
 * （music-channel-base.js と channel-base.js）にあり、このファイルは Jazz に固有の部分だけをフックとして持つ。
 *
 * 保存先は server/data/channels/jazz/ の config.json（チャンネルの設定）・long_term_memory.json（セッションの
 * 要約）・played_tracks.json（再生の履歴）。
 *
 * ATTENTION: プロンプトの中でパーソナリティの名前は直書きせず、_louName（config の名前）を使うこと
 * （CLAUDE.md 参照）。候補の曲の一覧にある実在のアーティスト名（Louis Armstrong など）は別物。
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

const fs   = require('fs');
const { writeJsonFile } = require('./lib/atomic-json');
const listenerContext = require('./lib/listener-context');
const path = require('path');
const { getLogger } = require('./logger');
const MusicChannelAgentBase = require('./music-channel-base');

const JAZZ_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'jazz', 'config.json');
const JAZZ_MEMORY_PATH  = path.join(__dirname, 'data', 'channels', 'jazz', 'long_term_memory.json');
const JAZZ_PLAYED_PATH  = path.join(__dirname, 'data', 'channels', 'jazz', 'played_tracks.json');

const JAZZ_PLAYED_MAX   = 200;
// 同じ曲を繰り返さない期間（時間）。
// BUGFIX: 期間は7日。候補（JAZZ_REPERTOIRE、20曲）が少なく、48時間だと同じ定番曲がすぐ戻ってきていた
// （再生の履歴の半分以上がこの20曲だった。指示は守られており、期間が短すぎただけだった）。
const JAZZ_PLAYED_HOURS = 168;

/**
 * ディレクターに参考として見せる候補の曲（これ以外の曲も選べる）。
 */
const JAZZ_REPERTOIRE = [
  { artist: 'Miles Davis',        title: 'Kind of Blue',          period: 'Modal Jazz' },
  { artist: 'John Coltrane',      title: 'A Love Supreme',        period: 'Avant-garde Jazz' },
  { artist: 'Dave Brubeck',       title: 'Take Five',             period: 'Cool Jazz' },
  { artist: 'Bill Evans',         title: 'Waltz for Debby',       period: 'Post-Bop' },
  { artist: 'Thelonious Monk',    title: "Round Midnight",        period: 'Bebop' },
  { artist: 'Charlie Parker',     title: 'Ko-Ko',                 period: 'Bebop' },
  { artist: 'Duke Ellington',     title: 'Take the A Train',      period: 'Swing' },
  { artist: 'Louis Armstrong',    title: "What a Wonderful World", period: 'Dixieland' },
  { artist: 'Herbie Hancock',     title: 'Cantaloupe Island',     period: 'Hard Bop' },
  { artist: 'Chet Baker',         title: "My Funny Valentine",    period: 'Cool Jazz' },
  { artist: 'Sonny Rollins',      title: "St. Thomas",            period: 'Hard Bop' },
  { artist: 'Wes Montgomery',     title: "Four on Six",           period: 'Hard Bop' },
  { artist: 'Art Blakey',         title: "Moanin'",               period: 'Hard Bop' },
  { artist: 'Cannonball Adderley', title: 'Mercy Mercy Mercy',   period: 'Soul Jazz' },
  { artist: 'Chick Corea',        title: 'Spain',                 period: 'Fusion' },
  { artist: 'Pat Metheny',        title: 'Bright Size Life',      period: 'Contemporary Jazz' },
  { artist: 'Keith Jarrett',      title: 'The Köln Concert',      period: 'Post-Bop' },
  { artist: 'Freddie Hubbard',    title: 'Red Clay',              period: 'Hard Bop' },
  { artist: 'Clifford Brown',     title: 'Joy Spring',            period: 'Hard Bop' },
  { artist: 'Oscar Peterson',     title: 'Night Train',           period: 'Swing/Bop' },
];

/** Jazz チャンネルのエージェントシステム（MusicChannelAgentBase のフックを Jazz 用に実装する）。 */
class JazzAgentSystem extends MusicChannelAgentBase {
  /**
   * @param {Record<string, any>} mixer 音声のミキサー
   * @param {Record<string, any>} serverWrapper WebSocket への配信などを持つサーバー側のラッパー
   */
  constructor(mixer, serverWrapper) {
    super(mixer, serverWrapper, JAZZ_CONFIG_PATH, 'Jazz');

    this._memoryPath = JAZZ_MEMORY_PATH;
    this._playedPath = JAZZ_PLAYED_PATH;
    this._playedMax  = JAZZ_PLAYED_MAX;

    this._playedPieces      = this._loadPlayedPieces();
    this._requestQueue      = [];
    this._sessionPlan       = null; // { theme, concept, pieces: [...] }
    this._isShuttingDown    = false;
    this._sessionStartTime  = Date.now();
    this._longTermContext   = '';
    this._nextIntroPrefetch = null; // { artist, title, text, pcm0 }
    this._openingPlanData   = null; // オープニングジングル中に事前計算した第1曲データ
    this._needsNewSession   = false; // 修了処理完了後の再接続時にオープニングを再実行するフラグ

    this._interruptAgentKey = 'jazz_personality';

    getLogger().info('[Jazz] JazzAgentSystem 初期化完了');
  }

  /**
   * パーソナリティの英語のセリフを日本語に訳し、テロップの文を返す。
   *
   * ディレクターは声を持たないので対象外。セリフ全体の訳を1つのテロップとして出すだけで、文ごとの
   * 厳密な同期はしない。channel-base.js が曲の再生中に先読みで呼ぶので、話し始めた時点で訳は済んでいる。
   *
   * 引数 text: セリフ（英語）
   * 引数 agentKey: 話すエージェントのキー
   * @returns {Promise<any>} 日本語のテロップ（対象外・無効・失敗なら null）
   */
  async _maybePrefetchCaption(text, agentKey) {
    if (agentKey !== 'jazz_personality') return null;
    // 管理画面の「番組設定」の翻訳表示の切り替え。設定が無ければ有効として扱う
    if (this.getConfig().program?.caption_enabled === false) return null;
    try {
      // 演技のタグ（[laughs] など）は音声合成のための記号なので、訳す前に取り除く
      // （音声合成には、タグ付きの元の文が別に渡る）
      const textForCaption = text.replace(/\[[A-Za-z][A-Za-z ]*\]/g, '').trim();
      return await this._translateToJapanese(textForCaption);
    } catch (e) {
      getLogger().warn(`[Jazz] 翻訳テロップ生成失敗: ${e.message}`);
      return null;
    }
  }

  /**
   * 英語のセリフを、字幕に使える自然な日本語に訳す。
   *
   * @param {string} text 英語のセリフ
   * @returns {Promise<string|null>} 日本語の訳（失敗なら null）
   */
  async _translateToJapanese(text) {
    const config = this.getConfig();
    const systemPrompt = 'あなたは優秀な翻訳者です。英語のセリフを、ラジオ番組の字幕として使える自然な日本語に翻訳します。';
    const userPrompt = `以下の英語のセリフを自然な日本語に翻訳してください。翻訳文のみを出力し、説明・引用符・前置きは一切不要です。\n\n${text}`;
    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'jazz_personality');
    return raw ? raw.trim() : null;
  }

  /**
   * オープニングの紹介を作れなかったときの代わりの一言（英語）。
   *
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {string} 代わりのセリフ
   */
  _getOpeningFallbackText(plan) {
    return `Alright, we got ${plan.artist} coming up with "${plan.title}". Here it is.`;
  }

  /**
   * 先読み（オープニング）で使う演奏者の情報を組み立てる。
   *
   * 引数 track: Spotify の曲
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * 引数 spotifyArtists: Spotify のアーティスト名
   * @returns {any} 演奏者・アルバム・主な奏者
   */
  _buildPrefetchPerformerInfo(track, plan, spotifyArtists) {
    return {
      spotifyArtists,
      spotifyAlbum:   track.album?.name || '',
      artist:         plan.artist,
      key_performers: plan.key_performers || '',
    };
  }

  // ─── 長期記憶 ─────────────────────────────────────────────────

  /**
   * 長期記憶に書くセッションの見出し。
   *
   * 引数 date: 日付
   * @returns {string} 見出し
   */
  _getMemorySessionHeader(date) { return `[Session: ${date}]`; }
  /**
   * 長期記憶に書く1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatMemoryPieceLine(p) { return `${p.artist} "${p.title}"`; }

  /**
   * セッションの要約を頼むときの、1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatSummaryPieceLine(p) { return `- ${p.artist} "${p.title}"`; }

  /**
   * セッションの要約（長期記憶）を作らせるプロンプト（英語）。
   *
   * 引数 piecesList: 流した曲の一覧
   * @returns {{systemPrompt: string, userPrompt: string}} プロンプト
   */
  _getSessionSummaryPrompts(piecesList) {
    return {
      systemPrompt: 'You are an archiver for a jazz radio program.',
      userPrompt: `Summarize this jazz radio session in 2-3 sentences covering the mood and style range. Output only JSON:\n{\n  "summary": "...",\n  "pieces_played": [{"artist": "...", "title": "..."}]\n}\n\nTracks played:\n${piecesList}`,
    };
  }

  // ─── プランニング ──────────────────────────────────────────────

  /**
   * ディレクターに、テーマのあるセッションを企画させる。
   *
   * 材料は、リスナーの情報・秘書が学んだリスナー像・日記のふり返り・リクエストの履歴・ディレクター同士の
   * 共有・過去のセッション・リスナーのリクエスト・最近流した曲など。リスナーのリクエストは1回使ったら
   * 設定から消す。
   *
   * @param {string[]} [recentArtists] 直前に流したアーティスト（避けさせる）
   * @returns {Promise<Record<string, any>|null>} セッションの計画（theme・concept・pieces）。作れなければ null
   */
  async _planSession(recentArtists = []) {
    const config      = this.getConfig();
    const directorCfg = config.agents?.jazz_director || {};

    const cutoffMs = Date.now() - JAZZ_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection = failedPieces.length > 0
      ? `\n[Tracks not found on Spotify — do not select]\n` +
        failedPieces.map(p => `- ${p.artist} "${p.title}"`).join('\n')
      : '';
    const recentSection = recentPlayed.length > 0
      ? `\n[Recently played — do not repeat]\n` +
        recentPlayed.map(p => `- ${p.artist} "${p.title}"`).join('\n')
      : '';
    const artistBan = recentArtists.length > 0
      ? `\n[Artists played just before — vary the selection]\n${recentArtists.join(', ')}\n`
      : '';
    const memorySection = this._longTermContext
      ? `\n[Past session records]\n${this._longTermContext}\n`
      : '';

    const listenerRequest = config.program?.listener_request || '';
    if (listenerRequest) {
      try {
        config.program.listener_request = '';
        writeJsonFile(JAZZ_CONFIG_PATH, config);
      } catch { }
    }
    const requestSection = listenerRequest
      ? `\n[Listener request — prioritize this]\n${listenerRequest}\n`
      : '';

    const listener   = this._getListenerProfile();
    const listenerInfo = [
      listener.name       ? `Listener name: ${listener.name}` : '',
      listener.occupation ? `Occupation: ${listener.occupation}` : '',
      listener.hobbies    ? `Interests: ${listener.hobbies}` : '',
    ].filter(Boolean).join(', ');
    // Secretary との会話から学んだリスナー像のまとめ（agent-shared-mixin.js 参照）。まだ無ければ空文字
    const listenerDigest = this._getListenerDigest();
    // 日記のふり返り（週1回）。ディレクター自身の選曲の傾向と、パーソナリティの日記から見えた気づき。
    // まだ無ければ空文字。
    const diaryFeedback = this._getAgentDiarySelfDigest('jazz_director') + this._getAgentDiaryTeamDigest('jazz_director');
    // 最近のリクエストの履歴（知っておくだけの材料。lib/listener-context.js）
    const requestHistory = listenerContext.formatRequestHistoryForPrompt('jazz_director', { channel: 'jazz', lang: 'en' });
    // ディレクター同士の共有・予定・季節と世の中の動き（channel-base.js の _buildDirectorSharedContext）
    const sharedContext = await this._buildDirectorSharedContext({ lang: 'en' });

    const now  = new Date();
    const hour = now.getHours();
    const timeCtx = hour < 6 ? 'late night' : hour < 10 ? 'early morning' : hour < 14 ? 'mid-morning to noon' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'late night';
    // BUGFIX: 曜日と時間帯だけでなく暦日まで渡す。"Thursday late night" は木曜から金曜にかけてとも読め、
    // 1日ずれていた。ここで決まったテーマ名はオープニングで声になるので、そろえておく。
    const dateCtxPlan = this._buildDateTimeContext(now, timeCtx, { lang: 'en' });

    const systemPrompt = directorCfg.prompt || 'You are the director of a jazz radio program. Plan a thematic session of 4 tracks.';

    const userPrompt = `Plan a 4-track jazz session for ${dateCtxPlan}.
${listenerInfo ? `Listener: ${listenerInfo}` : ''}${listenerDigest ? `\nListener background (learned from AI secretary conversations, in Japanese): ${listenerDigest}` : ''}${diaryFeedback}${requestHistory}${sharedContext}${memorySection}${requestSection}${failedSection}${recentSection}${artistBan}
Pick 4 tracks with a cohesive theme. Vary the era (swing, bebop, cool, hard bop, fusion, contemporary) and mood.
Use this candidate list for inspiration (not a strict list — you may select other well-known jazz tracks):
${JAZZ_REPERTOIRE.filter(r => !recentArtists.includes(r.artist)).slice(0, 12).map((r, i) => `${i+1}. ${r.artist} — "${r.title}" (${r.period})`).join('\n')}

Output ONLY valid JSON (no markdown):
{
  "theme": "Theme title (e.g. 'Bebop After Dark', 'Miles Davis Universe')",
  "concept": "2-sentence description of the theme",
  "pieces": [
    {
      "order": 1,
      "artist": "Artist name",
      "title": "Track title",
      "period": "Jazz era/style",
      "key_performers": "Sidemen and notable performers",
      "album": "Album name",
      "year": "Recording year (approximate)",
      "spotify_query": "Spotify search query in English",
      "key_points": "What makes this track special (1 sentence)",
      "background": "Historical context or story (under 20 words)",
      "role": "opening"
    },
    { "order": 2, "role": "main" },
    { "order": 3, "role": "featured" },
    { "order": 4, "role": "closing" }
  ]
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const plan = JSON.parse(match[0]);
      if (!Array.isArray(plan.pieces) || plan.pieces.length === 0) return null;
      getLogger().info(`[Jazz] セッション計画: テーマ「${plan.theme}」 ${plan.pieces.length}曲`);
      return plan;
    } catch (e) {
      getLogger().warn('[Jazz] セッション計画パース失敗: ' + e.message);
      return null;
    }
  }

  /**
   * ディレクターに、次に流す1曲を選ばせる（セッションの企画に失敗したときの代わり）。
   *
   * @param {string[]} [recentArtists] 直前に流したアーティスト（避けさせる）
   * @returns {Promise<Record<string, any>|null>} 曲の計画（作れなければ null）
   */
  async _directorPlan(recentArtists = []) {
    const config      = this.getConfig();
    const directorCfg = config.agents?.jazz_director || {};

    const cutoffMs = Date.now() - JAZZ_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection = failedPieces.length > 0
      ? `\n[Not on Spotify — skip these]\n${failedPieces.map(p => `- ${p.artist} "${p.title}"`).join('\n')}`
      : '';
    const recentSection = recentPlayed.length > 0
      ? `\n[Recently played — do not repeat]\n${recentPlayed.map(p => `- ${p.artist} "${p.title}"`).join('\n')}`
      : '';
    const artistBan = recentArtists.length > 0
      ? `\n[Just played these artists — pick someone different]\n${recentArtists.join(', ')}`
      : '';

    const now  = new Date();
    const hour = now.getHours();
    const timeCtx = hour < 6 ? 'late night' : hour < 10 ? 'early morning' : hour < 14 ? 'mid-morning' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'late night';
    const dateCtxDir = this._buildDateTimeContext(now, timeCtx, { lang: 'en' });

    const systemPrompt = directorCfg.prompt || 'You are a jazz radio program director.';

    const userPrompt = `Choose one jazz track to play next. Time: ${dateCtxDir}.
${failedSection}${recentSection}${artistBan}

Candidates (you may choose others):
${JAZZ_REPERTOIRE.filter(r => !recentArtists.includes(r.artist)).slice(0, 10).map((r, i) => `${i+1}. ${r.artist} — "${r.title}" (${r.period})`).join('\n')}

Output ONLY valid JSON (no markdown):
{
  "artist": "Artist name",
  "title": "Track title",
  "period": "Jazz era/style",
  "key_performers": "Notable sidemen or performers",
  "album": "Album name",
  "year": "Recording year",
  "spotify_query": "Spotify search query in English",
  "key_points": "What makes this special (1 sentence)",
  "background": "History or story behind the track (under 20 words)"
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      getLogger().warn('[Jazz Director] JSON パース失敗: ' + e.message);
      return null;
    }
  }

  // ─── コンテンツ生成 ────────────────────────────────────────────

  /**
   * パーソナリティに、曲の前の紹介のセリフを英語で書かせる（オープニングの挨拶を含む）。
   *
   * @param {Record<string, any>} plan 曲の計画
   * @param {boolean} [isOpening] セッションの最初の曲（挨拶から始める）か
   * @param {Record<string, any>|null} [sessionInfo] セッションのテーマ（theme・concept）
   * @param {Record<string, any>|null} [performerInfo] Spotify の演奏者・アルバム
   * @param {Function|null} [onSentence] 文が1つできるたびに呼ぶ関数（渡すとストリーミングで書かせる）
   * @param {number} [speakDelayMs] このセリフを実際に話すまでの見込みの時間（ミリ秒）。先読みのときに、
   *   今の曲の残りの分だけ先の時刻として扱う（channel-base.js 参照）
   * @returns {Promise<string>} セリフ（書けなければ決まった一言）
   */
  async _generateIntroduction(plan, isOpening = false, sessionInfo = null, performerInfo = null, onSentence = null, speakDelayMs = 0) {
    const config         = this.getConfig();
    const personalityCfg = config.agents?.jazz_personality || {};
    const _louName       = personalityCfg.name || 'Louis';
    const listener       = this._getListenerProfile();
    const listenerName   = listener.name || null;

    const now  = new Date(Date.now() + speakDelayMs);
    const hour = now.getHours();
    const timeLabel = hour < 6 ? 'late night' : hour < 10 ? 'early morning' : hour < 14 ? 'morning' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'late night';
    // BUGFIX: 暦日まで含めて誤読の余地を無くす（channel-base.js の同じメソッド参照）。英語でも
    // "Thursday late night" は木曜から金曜にかけてと読まれる余地がある。
    const dateTimeCtx = this._buildDateTimeContext(now, timeLabel, { lang: 'en' });
    const isEvening = hour >= 17;

    // 今日すでに挨拶したか
    const showDay = this._getShowDay();
    let isReturningToday = false;
    try {
      if (fs.existsSync(JAZZ_MEMORY_PATH)) {
        const mem = JSON.parse(fs.readFileSync(JAZZ_MEMORY_PATH, 'utf-8'));
        if (mem.last_greeting_show_day === showDay) isReturningToday = true;
      }
    } catch { /* ignore */ }

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt || 'You are Louis, a jazz radio personality.',
      'jazz_personality'
    );

    let openingLine;
    if (isOpening) {
      const nameGreet = listenerName ? `, ${listenerName}` : '';
      // BUGFIX: リスナーの名前が誰の名前かをはっきり書く（パーソナリティがリスナーの名前で名乗るのを防ぐ。
      // agent-system-mood.js の同じ変数を参照）。パーソナリティは英語で話すので、英語で書く。
      const nameGuard = listenerName
        ? ` IMPORTANT: "${listenerName}" is the LISTENER's name, not yours. You are "${_louName}".`
          + ` Greet the listener by that name, but never introduce yourself as "${listenerName}".`
        : '';
      const eveningNote = isEvening ? '' : ` ⚠️ Current time is ${dateTimeCtx} — do NOT say "good evening", "tonight", or any night-time phrase.`;

      if (isReturningToday) {
        const welcomeBack = `"Welcome back${nameGreet}! So glad you're back with us."`;
        if (sessionInfo?.theme) {
          openingLine = `Open with ${welcomeBack} — warmly, like greeting a dear friend who came back. Then introduce today's theme "${sessionInfo.theme}" with soulfulness, and flow into the first track.${eveningNote}${nameGuard}`;
          if (sessionInfo.concept) openingLine += ` Theme context: ${sessionInfo.concept}`;
        } else {
          openingLine = `Open with ${welcomeBack} — warmly, like greeting a dear friend who came back. Then introduce the first track.${eveningNote}${nameGuard}`;
        }
      } else {
        const welcome = `"Welcome${nameGreet} — glad you could join us."`;
        if (sessionInfo?.theme) {
          openingLine = `Open with ${welcome} as a warm ${timeLabel} greeting, then introduce today's theme "${sessionInfo.theme}" with energy and soulfulness. Flow naturally into the first track.${eveningNote}${nameGuard}`;
          if (sessionInfo.concept) openingLine += ` Theme context: ${sessionInfo.concept}`;
        } else {
          openingLine = `Open with ${welcome} as a warm ${timeLabel} greeting, then introduce the first track.${eveningNote}${nameGuard}`;
        }
      }
    } else {
      openingLine = `Introduce the next track. Keep the momentum going.`;
    }

    const performerLine = performerInfo?.spotifyArtists?.length > 0
      ? `Performers (Spotify): ${performerInfo.spotifyArtists.join(' / ')}${performerInfo.spotifyAlbum ? ' — Album: ' + performerInfo.spotifyAlbum : ''}`
      : (plan.key_performers ? `Key performers: ${plan.key_performers}` : '');

    const userPrompt = `${openingLine}

Current time: ${dateTimeCtx}

Track info:
Artist: ${plan.artist}
Title: "${plan.title}"
Style/Era: ${plan.period}
Album: ${plan.album || 'N/A'}
Year: ${plan.year || 'N/A'}
${performerLine}
What makes it special: ${plan.key_points || ''}
Background: ${plan.background || ''}

Write ${_louName}'s radio script in English (with occasional Japanese words naturally). Be conversational, rhythmic, and soulful — like ${_louName} is feeling the music as he talks. Share the history and soul of this track so even a jazz newcomer gets excited.
End with something like "Let's listen" or "Here it is" to cue the music.
Output only the spoken text — no stage directions, no character notes.
${this._geminiInlineTagGuidanceEn()}${this._getAgentDiarySelfDigest('jazz_personality')}`;

    if (onSentence) {
      const text = await this._callGeminiStreaming(systemPrompt, userPrompt, onSentence, -1, 'main', 'jazz_personality');
      return text || `Alright, we got ${plan.artist} coming up with "${plan.title}". Listen to this — it's something special. Here it is.`;
    }
    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'jazz_personality');
    return text || `Alright, we got ${plan.artist} coming up with "${plan.title}". Listen to this — it's something special. Here it is.`;
  }

  /**
   * パーソナリティに、曲の後のコメントを英語で書かせる。
   *
   * @param {Record<string, any>} plan 曲の計画
   * @param {string|null} [actualTrackName] Spotify で実際に流れた曲名（計画に題名が無いときに使う）
   * @param {Record<string, any>|null} [performerInfo] Spotify の演奏者・アルバム
   * @returns {Promise<string>} セリフ（書けなければ決まった一言）
   */
  async _generateComment(plan, actualTrackName = null, performerInfo = null) {
    const config         = this.getConfig();
    const personalityCfg = config.agents?.jazz_personality || {};
    const _louName       = personalityCfg.name || 'Louis';

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt || 'You are Louis, a jazz radio personality.',
      'jazz_personality'
    );

    const performers = [];
    if (performerInfo?.spotifyArtists?.length > 0)
      performers.push(`On the recording: ${performerInfo.spotifyArtists.join(', ')}`);
    if (performerInfo?.spotifyAlbum)
      performers.push(`Album: ${performerInfo.spotifyAlbum}`);
    const performerSection = performers.length > 0 ? '\n' + performers.join('\n') : '';

    const userPrompt = `React to the jazz track we just heard. Be soulful, warm, and personal.

Track: ${plan.artist} — "${plan.title || actualTrackName}"
Style: ${plan.period}${performerSection}

Write ${_louName}'s post-song commentary — 2-4 sentences. Draw on the trumpet-playing past if relevant. Speak from the heart about what you heard: the groove, the phrasing, the feeling, a personal memory it stirs.
Output only the spoken text — no stage directions.
${this._geminiInlineTagGuidanceEn()}${this._getAgentDiarySelfDigest('jazz_personality')}`;

    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'jazz_personality');
    return text || `Man, that right there... that's what jazz is all about. Beautiful. Just beautiful.`;
  }

  // ─── ショーループフック ─────────────────────────────────────────

  /**
   * ディレクターのエージェントキー。
   * @returns {string} jazz_director
   */
  get _directorAgentKey() { return 'jazz_director'; }

  /**
   * リスナーのリクエスト曲から、曲の計画を作る。
   *
   * 引数 req: リクエスト（artist・title など）
   * @returns {Record<string, any>} 曲の計画
   */
  _buildRequestPlan(req) {
    return {
      artist:        req.artist,
      title:         req.title,
      period:        req.period || '',
      spotify_query: req.spotify_query || `${req.artist} ${req.title} jazz`,
      key_points:    "Listener's request.",
      background:    '',
      isReplay:      true,
    };
  }

  /**
   * ログなどに出す曲の表記。
   *
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {string} 表記
   */
  _getPlanLabel(plan) { return `${plan.artist} "${plan.title}"`; }

  /**
   * Spotify の曲から演奏者の情報を組み立てる。
   *
   * 引数 spotifyTrack: Spotify の曲
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {Record<string, any>} 演奏者・アルバム・主な奏者
   */
  _buildSpotifyPerformerInfo(spotifyTrack, plan) {
    const spotifyArtists = this._extractSpotifyArtistNames(spotifyTrack);
    const spotifyAlbum   = spotifyTrack.album?.name || '';
    return { spotifyArtists, spotifyAlbum, artist: plan.artist, key_performers: plan.key_performers || '' };
  }

  /**
   * Spotify で見つからなかった曲の記録（次から選ばせないため）。
   *
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {Record<string, any>} 再生の履歴の1件
   */
  _buildSpotifyFailedEntry(plan) {
    return {
      artist: plan.artist, title: plan.title,
      trackName: null, playedAt: new Date().toISOString(), spotifyFailed: true,
    };
  }

  /**
   * 先読みした紹介が、この曲のものか。
   *
   * 引数 cached: 先読みした紹介
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {boolean} 同じ曲なら true
   */
  _checkIntroCacheHit(cached, plan) {
    return cached.artist === plan.artist && cached.title === plan.title;
  }

  /**
   * 画面と記録に使うアーティスト名（Spotify の名前、無ければ計画の名前）。
   *
   * 引数 performerInfo: 演奏者の情報
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {string} アーティスト名
   */
  _getDisplayArtist(performerInfo, plan) {
    return performerInfo.spotifyArtists[0] || plan.artist;
  }

  /**
   * 再生の履歴の1件を作る。
   *
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * 引数 spotifyTrack: Spotify の曲
   * 引数 performerInfo: 演奏者の情報
   * @returns {Record<string, any>} 再生の履歴の1件
   */
  _buildPlayedEntry(plan, spotifyTrack, performerInfo) {
    return {
      // BUGFIX: アーティスト名は Spotify で確かめた正式な名前にする。LLM が毎回書く名前をそのまま使うと、
      // 「Dave Brubeck Quartet」と「The Dave Brubeck Quartet」のような表記のゆれで同じ曲が別の曲として記録され、
      // 重複の防止とアンコールの一覧の両方で増えていた。
      artist:        this._getDisplayArtist(performerInfo, plan),
      title:         plan.title,
      period:        plan.period || '',
      spotify_query: plan.spotify_query || '',
      trackName:     spotifyTrack.name,
      performers:    performerInfo.spotifyArtists,
      albumName:     performerInfo.spotifyAlbum,
      playedAt:      new Date().toISOString(),
    };
  }

  /**
   * 画面に出す、今の曲の表示名。
   *
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {string} 表示名
   */
  _getCornerStartName(plan) { return `${plan.artist} — "${plan.title}"`; }

  /**
   * 「直前に流した」の判定に使うキー（アーティスト）。
   *
   * 引数 plan: 曲の計画（artist・title・key_performers など）
   * @returns {string} キー
   */
  _getRecentKey(plan) { return plan.artist; }

  /**
   * 設定に番組名が無いときの番組名。
   * @returns {string} 番組名
   */
  _getDefaultProgramName() { return '琥珀色のインプロヴィゼーション'; }

  // ─── 管理コマンド ─────────────────────────────────────────────

  /**
   * 管理人やリクエストの文から取り出した曲の情報を、曲の計画の形にする。
   *
   * 引数 info: 取り出した情報（artist・title・composer・composition など）
   * @returns {Record<string, any>} 曲の計画
   */
  _buildExtractedRequestTrack(info) {
    return {
      artist:        info.artist        || info.composer,
      title:         info.title         || info.composition,
      period:        info.period        || '',
      spotify_query: info.spotify_query || `${info.artist || info.composer} ${info.title || info.composition} jazz`,
      key_points:    "Listener's request.",
      background:    '',
      isReplay:      true,
    };
  }
}

module.exports = JazzAgentSystem;
