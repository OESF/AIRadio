/**
 * @file Beatles チャンネル（The Beatles 専門）のエージェントシステム
 *
 * 24時間続く The Beatles 専門の音楽チャンネル「Eight Days A Week」。ディレクター（beatles_director、声は無い
 * 裏方）がテーマのあるセッションを企画し、パーソナリティ（beatles_personality）が曲の前の紹介と曲の後の
 * コメントを話す。番組の進め方・Spotify での再生・日記・リクエストなどの共通の流れは
 * MusicChannelAgentBase（music-channel-base.js と channel-base.js）にあり、このファイルは Beatles に固有の
 * 部分（選曲のプロンプト・語り口・記録の形・本人の演奏だけを選ぶ絞り込み）だけをフックとして持つ。
 * アーティストは常に The Beatles なので、曲は題名で見分ける。
 *
 * 保存先は server/data/channels/beatles/ の config.json（チャンネルの設定）・long_term_memory.json（セッションの
 * 要約）・played_tracks.json（再生の履歴）。
 *
 * ATTENTION: プロンプトの中でパーソナリティの名前は直書きせず、_paulName（config の名前）を使うこと
 * （CLAUDE.md 参照）。
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

const BEATLES_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'beatles', 'config.json');
const BEATLES_MEMORY_PATH  = path.join(__dirname, 'data', 'channels', 'beatles', 'long_term_memory.json');
const BEATLES_PLAYED_PATH  = path.join(__dirname, 'data', 'channels', 'beatles', 'played_tracks.json');

const BEATLES_PLAYED_MAX    = 200;
// 再生の履歴に残す最大件数と、同じ曲を繰り返さない期間（時間）。
// BUGFIX: 期間は7日。候補（BEATLES_REPERTOIRE）が少なく、48時間だとすぐ同じ定番曲が戻ってきていた
// （Jazz で見つかり、同じ作りの全チャンネルに当てた）。
const BEATLES_PLAYED_HOURS  = 168;

const BEATLES_ARTIST = 'The Beatles';

/**
 * ディレクターに参考として見せる候補の曲（The Beatles の公式の曲だけで、ソロやカバーは含まない）。
 */
const BEATLES_REPERTOIRE = [
  { title: 'Love Me Do',                  album: 'Please Please Me',          year: '1962' },
  { title: 'Please Please Me',            album: 'Please Please Me',          year: '1963' },
  { title: 'She Loves You',               album: 'Single',                    year: '1963' },
  { title: 'I Want to Hold Your Hand',    album: 'Single',                    year: '1963' },
  { title: 'A Hard Day\'s Night',         album: 'A Hard Day\'s Night',       year: '1964' },
  { title: 'And I Love Her',              album: 'A Hard Day\'s Night',       year: '1964' },
  { title: 'Eight Days a Week',           album: 'Beatles for Sale',          year: '1964' },
  { title: 'Ticket to Ride',              album: 'Help!',                     year: '1965' },
  { title: 'Help!',                       album: 'Help!',                     year: '1965' },
  { title: 'Yesterday',                   album: 'Help!',                     year: '1965' },
  { title: 'Norwegian Wood (This Bird Has Flown)', album: 'Rubber Soul',      year: '1965' },
  { title: 'In My Life',                  album: 'Rubber Soul',               year: '1965' },
  { title: 'Michelle',                    album: 'Rubber Soul',               year: '1965' },
  { title: 'Eleanor Rigby',               album: 'Revolver',                  year: '1966' },
  { title: 'Yellow Submarine',            album: 'Revolver',                  year: '1966' },
  { title: 'Here, There and Everywhere',  album: 'Revolver',                  year: '1966' },
  { title: 'Penny Lane',                  album: 'Single',                    year: '1967' },
  { title: 'Strawberry Fields Forever',   album: 'Single',                    year: '1967' },
  { title: 'Sgt. Pepper\'s Lonely Hearts Club Band', album: 'Sgt. Pepper\'s Lonely Hearts Club Band', year: '1967' },
  { title: 'With a Little Help from My Friends', album: 'Sgt. Pepper\'s Lonely Hearts Club Band', year: '1967' },
  { title: 'Lucy in the Sky with Diamonds', album: 'Sgt. Pepper\'s Lonely Hearts Club Band', year: '1967' },
  { title: 'A Day in the Life',           album: 'Sgt. Pepper\'s Lonely Hearts Club Band', year: '1967' },
  { title: 'All You Need Is Love',        album: 'Single',                    year: '1967' },
  { title: 'Hey Jude',                    album: 'Single',                    year: '1968' },
  { title: 'Back in the U.S.S.R.',        album: 'The Beatles (White Album)', year: '1968' },
  { title: 'While My Guitar Gently Weeps', album: 'The Beatles (White Album)', year: '1968' },
  { title: 'Blackbird',                   album: 'The Beatles (White Album)', year: '1968' },
  { title: 'Get Back',                    album: 'Let It Be',                 year: '1969' },
  { title: 'Come Together',               album: 'Abbey Road',                year: '1969' },
  { title: 'Something',                   album: 'Abbey Road',                year: '1969' },
  { title: 'Here Comes the Sun',          album: 'Abbey Road',                year: '1969' },
  { title: 'Let It Be',                   album: 'Let It Be',                 year: '1970' },
  { title: 'The Long and Winding Road',   album: 'Let It Be',                 year: '1970' },
];

/** Beatles チャンネルのエージェントシステム（MusicChannelAgentBase のフックを Beatles 用に実装する）。 */
class BeatlesAgentSystem extends MusicChannelAgentBase {
  /**
   * @param {Record<string, any>} mixer 音声のミキサー
   * @param {Record<string, any>} serverWrapper WebSocket への配信などを持つサーバー側のラッパー
   */
  constructor(mixer, serverWrapper) {
    super(mixer, serverWrapper, BEATLES_CONFIG_PATH, 'Beatles');

    this._memoryPath = BEATLES_MEMORY_PATH;
    this._playedPath = BEATLES_PLAYED_PATH;
    this._playedMax  = BEATLES_PLAYED_MAX;

    this._playedPieces      = this._loadPlayedPieces();
    this._requestQueue      = [];
    this._sessionPlan       = null; // { theme, concept, pieces: [...] }
    this._isShuttingDown    = false;
    this._sessionStartTime  = Date.now();
    this._longTermContext   = '';
    this._nextIntroPrefetch = null;
    this._openingPlanData   = null;
    this._needsNewSession   = false;

    this._interruptAgentKey = 'beatles_personality';

    getLogger().info('[Beatles] BeatlesAgentSystem 初期化完了');
  }

  // ─── オープニングプリフェッチ ─────────────────────────────────────

  /**
   * オープニングの紹介を作れなかったときの代わりの一言。
   *
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {string} 代わりのセリフ
   */
  _getOpeningFallbackText(plan) {
    return `The Beatlesの「${plan.title}」をお届けします。どうぞ。`;
  }

  /**
   * 先読み（オープニング）で使う演奏者の情報を組み立てる。
   *
   * 引数 track: Spotify の曲
   * 引数 plan: 曲の計画（title・album・year など）
   * 引数 spotifyArtists: Spotify のアーティスト名
   * @returns {any} 演奏者・アルバム・発表年
   */
  _buildPrefetchPerformerInfo(track, plan, spotifyArtists) {
    return {
      spotifyArtists,
      spotifyAlbum: track.album?.name || plan.album || '',
      artist:       BEATLES_ARTIST,
      album:        plan.album || '',
      year:         plan.year || '',
    };
  }

  // ─── 長期記憶 ──────────────────────────────────────────────────────

  /**
   * 長期記憶に書くセッションの見出し。
   *
   * 引数 date: 日付
   * @returns {string} 見出し
   */
  _getMemorySessionHeader(date) { return `【セッション: ${date}】`; }
  /**
   * 長期記憶に書く1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatMemoryPieceLine(p) { return `「${p.title}」`; }

  /**
   * セッションの要約を頼むときの、1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatSummaryPieceLine(p) { return `- 「${p.title}」`; }

  /**
   * セッションの要約（長期記憶）を作らせるプロンプト。
   *
   * 引数 piecesList: 流した曲の一覧
   * @returns {{systemPrompt: string, userPrompt: string}} プロンプト
   */
  _getSessionSummaryPrompts(piecesList) {
    const directorCfg = this.getConfig().agents?.beatles_director || {};
    return {
      systemPrompt: 'あなたはThe Beatles専門ラジオ番組のアーカイバーです。',
      userPrompt: `このラジオセッションを2〜3文で要約してください。選曲の傾向や時代感を含めること。JSON形式で出力：\n{\n  "summary": "...",\n  "pieces_played": [{"title": "..."}]\n}\n\n演奏曲:\n${piecesList}`,
    };
  }

  // ─── プランニング ──────────────────────────────────────────────────

  /**
   * ディレクターに、テーマのあるセッションを企画させる。
   *
   * 材料は、リスナーの情報・秘書が学んだリスナー像・日記のふり返り・リクエストの履歴・ディレクター同士の
   * 共有・過去のセッション・リスナーのリクエスト・最近流した曲など。リスナーのリクエストは1回使ったら
   * 設定から消す。
   *
   * @param {string[]} [recentTitles] 直前に流した曲の題名（避けさせる）
   * @returns {Promise<Record<string, any>|null>} セッションの計画（theme・concept・pieces）。作れなければ null
   */
  async _planSession(recentTitles = []) {
    const config      = this.getConfig();
    const directorCfg = config.agents?.beatles_director || {};

    const cutoffMs     = Date.now() - BEATLES_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection  = failedPieces.length > 0
      ? `\n【Spotifyで見つからない曲 — 選ばないこと】\n${failedPieces.map(p => `- 「${p.title}」`).join('\n')}`
      : '';
    const recentSection  = recentPlayed.length > 0
      ? `\n【最近流した曲 — 繰り返さないこと】\n${recentPlayed.map(p => `- 「${p.title}」`).join('\n')}`
      : '';
    const titleBan = recentTitles.length > 0
      ? `\n【直前に流した曲 — 別の曲を選ぶこと】\n${recentTitles.join('、')}\n`
      : '';
    const memorySection = this._longTermContext
      ? `\n【過去のセッション記録】\n${this._longTermContext}\n`
      : '';

    const listenerRequest = config.program?.listener_request || '';
    if (listenerRequest) {
      try {
        config.program.listener_request = '';
        writeJsonFile(BEATLES_CONFIG_PATH, config);
      } catch { }
    }
    const requestSection = listenerRequest
      ? `\n【リスナーリクエスト — 最優先で反映すること】\n${listenerRequest}\n`
      : '';

    // リスナーの個人情報は name/occupation/hobbies のみ使用する（email・schedule等は取得しない）
    const listener     = this._getListenerProfile();
    const listenerInfo = [
      listener.name       ? `リスナー名: ${listener.name}` : '',
      listener.occupation ? `職業: ${listener.occupation}` : '',
      listener.hobbies    ? `趣味・興味: ${listener.hobbies}` : '',
    ].filter(Boolean).join('、');
    // Secretary との会話から学んだリスナー像のまとめ
    const listenerDigest = this._getListenerDigest();
    // 日記のふり返り（週1回）。ディレクター自身の選曲の傾向と、パーソナリティの日記から見えた気づき。
    // まだ無ければ空文字。
    const diaryFeedback = this._getAgentDiarySelfDigest('beatles_director') + this._getAgentDiaryTeamDigest('beatles_director');
    // 最近のリクエストの履歴（知っておくだけの材料。lib/listener-context.js）
    const requestHistory = listenerContext.formatRequestHistoryForPrompt('beatles_director', { channel: 'beatles' });
    // ディレクター同士の共有・予定・季節と世の中の動き（channel-base.js の _buildDirectorSharedContext）
    const sharedContext = await this._buildDirectorSharedContext({ lang: 'ja' });

    const now      = new Date();
    const hour     = now.getHours();
    const timeCtx  = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    // BUGFIX: 曜日と時間帯だけでなく暦日まで渡す。「◯曜日深夜」は前日の夜とも読め、1日ずれていた。
    // ここで決まったテーマ名はオープニングで声になるので、そろえておく。
    const dateCtxPlan = this._buildDateTimeContext(now, timeCtx);

    const systemPrompt = directorCfg.prompt ||
      'あなたはThe Beatles専門ラジオ番組『Eight Days A Week』のディレクターです。4曲のテーマ性あるセッションを企画してください。';

    const userPrompt = `${dateCtxPlan}の放送に合わせた4曲のセッションを企画してください。
${listenerInfo ? `リスナー情報: ${listenerInfo}` : ''}${listenerDigest ? `\n【AI秘書がこれまでの会話から学んだリスナー像】${listenerDigest}` : ''}${diaryFeedback}${requestHistory}${sharedContext}${memorySection}${requestSection}${failedSection}${recentSection}${titleBan}
【重要】The Beatles（ザ・ビートルズ）の公式楽曲のみを選曲すること。メンバーのソロ活動やカバーバージョンは絶対に選ばないこと。
参考候補（これ以外の著名なビートルズ楽曲も可）:
${BEATLES_REPERTOIRE.filter(r => !recentTitles.includes(r.title)).slice(0, 12).map((r, i) => `${i+1}. 「${r.title}」（${r.album}、${r.year}年）`).join('\n')}

有効なJSONのみ出力（マークダウン不要）:
{
  "theme": "テーマタイトル（例: 「初期ビートルズ ―― マージービートの輝き」）",
  "concept": "テーマの説明（2文程度）",
  "pieces": [
    {
      "order": 1,
      "title": "曲名（英語）",
      "album": "収録アルバム名",
      "year": "発表年",
      "spotify_query": "Spotify検索クエリ（artist:\\"The Beatles\\" track:\\"曲名\\" 形式）",
      "key_points": "この曲の聴きどころ（1文以内）",
      "background": "楽曲の背景やエピソード（30字以内）"
    },
    { "order": 2 },
    { "order": 3 },
    { "order": 4 }
  ]
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const plan = JSON.parse(match[0]);
      if (!Array.isArray(plan.pieces) || plan.pieces.length === 0) return null;
      plan.pieces.forEach(p => { p.artist = BEATLES_ARTIST; });
      getLogger().info(`[Beatles] セッション計画: テーマ「${plan.theme}」 ${plan.pieces.length}曲`);
      return plan;
    } catch (e) {
      getLogger().warn('[Beatles] セッション計画パース失敗: ' + e.message);
      return null;
    }
  }

  /**
   * ディレクターに、次に流す1曲を選ばせる（セッションの企画に失敗したときの代わり）。
   *
   * @param {string[]} [recentTitles] 直前に流した曲の題名（避けさせる）
   * @returns {Promise<Record<string, any>|null>} 曲の計画（作れなければ null）
   */
  async _directorPlan(recentTitles = []) {
    const config      = this.getConfig();
    const directorCfg = config.agents?.beatles_director || {};

    const cutoffMs     = Date.now() - BEATLES_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection = failedPieces.length > 0
      ? `\n【Spotifyで見つからない曲 — 除外】\n${failedPieces.map(p => `- 「${p.title}」`).join('\n')}`
      : '';
    const recentSection = recentPlayed.length > 0
      ? `\n【最近流した曲 — 繰り返さないこと】\n${recentPlayed.map(p => `- 「${p.title}」`).join('\n')}`
      : '';
    const titleBan = recentTitles.length > 0
      ? `\n【直前の曲 — 別の曲を選ぶこと】\n${recentTitles.join('、')}`
      : '';

    const now     = new Date();
    const hour    = now.getHours();
    const timeCtx = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    const dateCtxDir = this._buildDateTimeContext(now, timeCtx);

    const systemPrompt = directorCfg.prompt || 'あなたはThe Beatles専門ラジオ番組『Eight Days A Week』のディレクターです。';

    const userPrompt = `次に流す1曲を選んでください。時間帯: ${dateCtxDir}。
${failedSection}${recentSection}${titleBan}
【重要】The Beatles の公式楽曲のみ選曲すること（ソロ活動・カバーは禁止）。

候補（これ以外も可）:
${BEATLES_REPERTOIRE.filter(r => !recentTitles.includes(r.title)).slice(0, 12).map((r, i) => `${i+1}. 「${r.title}」（${r.album}、${r.year}年）`).join('\n')}

有効なJSONのみ出力:
{
  "title": "曲名（英語）",
  "album": "収録アルバム名",
  "year": "発表年",
  "spotify_query": "Spotify検索クエリ（artist:\\"The Beatles\\" track:\\"曲名\\" 形式）",
  "key_points": "この曲の聴きどころ（1文以内）",
  "background": "楽曲の背景やエピソード（30字以内）"
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const plan = JSON.parse(match[0]);
      plan.artist = BEATLES_ARTIST;
      return plan;
    } catch (e) {
      getLogger().warn('[Beatles Director] JSON パース失敗: ' + e.message);
      return null;
    }
  }

  // ─── コンテンツ生成 ────────────────────────────────────────────────

  /**
   * パーソナリティに、曲の前の紹介のセリフを書かせる（オープニングの挨拶を含む）。
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
    const personalityCfg = config.agents?.beatles_personality || {};
    const _paulName      = personalityCfg.name || 'ポール小野';
    const listener       = this._getListenerProfile();
    const listenerName   = listener.name || null;

    const now       = new Date(Date.now() + speakDelayMs);
    const hour      = now.getHours();
    const timeLabel = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    // BUGFIX: 暦日まで含めて誤読の余地を無くす（channel-base.js の同じメソッド参照）。
    // 曜日と時間帯だけでは、日付が1日ずれて読み上げられた。
    const dateTimeCtx = this._buildDateTimeContext(now, timeLabel);

    const showDay = this._getShowDay();
    let isReturningToday = false;
    try {
      if (fs.existsSync(BEATLES_MEMORY_PATH)) {
        const mem = JSON.parse(fs.readFileSync(BEATLES_MEMORY_PATH, 'utf-8'));
        if (mem.last_greeting_show_day === showDay) isReturningToday = true;
      }
    } catch { /* ignore */ }

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt ||
      'あなたはThe Beatles専門ラジオ番組『Eight Days A Week』のパーソナリティです。ビートルズの楽曲に関する深い知識を持ち、美しい日本語で詳細な解説を行います。',
      'beatles_personality'
    );

    const catchphrase = '週に7日じゃ足りない。僕らには、8日目のビートルズがある。';

    let openingLine;
    if (isOpening) {
      const nameGreet = listenerName ? `、${listenerName}さん` : '';
      // BUGFIX: リスナーの名前が誰の名前かをはっきり書く。挨拶の中にリスナーの名前を入れると、自己紹介の形に
      // 読み替えて、パーソナリティがリスナーの名前で名乗ってしまうことがあった（Mood で起きた）。
      const nameGuard = listenerName
        ? `\n【重要】「${listenerName}」はリスナー（聴いている人）の名前であって、あなたの名前では`
          + `ありません。あなたは「${_paulName}」です。挨拶ではリスナーに呼びかけるだけにし、`
          + `「${listenerName}です」のようにリスナーの名前で名乗ることは絶対にしないでください。`
        : '';
      if (isReturningToday) {
        if (sessionInfo?.theme) {
          openingLine = `「おかえりなさい${nameGreet}」という温かな挨拶で始め、本日のテーマ「${sessionInfo.theme}」を紹介し、最初の楽曲へと誘ってください。現在は${dateTimeCtx}です。${nameGuard}`;
        } else {
          openingLine = `「おかえりなさい${nameGreet}」という温かな挨拶で始め、最初の楽曲をご紹介ください。現在は${dateTimeCtx}です。${nameGuard}`;
        }
      } else {
        if (sessionInfo?.theme) {
          openingLine = `番組冒頭で必ずキャッチフレーズ「${catchphrase}」を印象的に語り${nameGreet}への挨拶を添えて始め、本日のテーマ「${sessionInfo.theme}」を熱量高く紹介し、最初の楽曲へと誘ってください。現在は${dateTimeCtx}です。${nameGuard}`;
          if (sessionInfo.concept) openingLine += `テーマの背景: ${sessionInfo.concept}`;
        } else {
          openingLine = `番組冒頭で必ずキャッチフレーズ「${catchphrase}」を印象的に語り${nameGreet}への挨拶を添えて始め、最初の楽曲をご紹介ください。現在は${dateTimeCtx}です。${nameGuard}`;
        }
      }
    } else {
      openingLine = '次の楽曲をご紹介ください。自然な流れで続けてください。';
    }

    const performerLine = performerInfo?.spotifyArtists?.length > 0
      ? `演奏: ${performerInfo.spotifyArtists.join(' / ')}`
      : '';
    const albumLine = plan.album ? `収録アルバム: ${plan.album}` : '';
    const yearLine  = plan.year  ? `発表年: ${plan.year}` : '';

    const userPrompt = `${openingLine}

現在時刻: ${dateTimeCtx}

楽曲情報:
アーティスト: The Beatles
曲名: 「${plan.title}」
${albumLine}
${yearLine}
${performerLine}
聴きどころ: ${plan.key_points || ''}
背景・エピソード: ${plan.background || ''}

${_paulName}のラジオセリフを日本語で書いてください。ビートルズ楽曲についての深い知識を活かし、楽曲の背景やエピソードを詳しく、かつ若いリスナーにも惹きつけられるように語ります。「それでは、どうぞ」「お聴きください」などで楽曲を誘い込んでください。
セリフのみを出力してください。ト書き・説明・括弧書きは不要です。
${this._geminiInlineTagGuidanceJa()}${this._getAgentDiarySelfDigest('beatles_personality')}`;

    if (onSentence) {
      const text = await this._callGeminiStreaming(systemPrompt, userPrompt, onSentence, -1, 'main', 'beatles_personality');
      return text || `The Beatlesの「${plan.title}」です。どうぞ、お聴きください。`;
    }
    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'beatles_personality');
    return text || `The Beatlesの「${plan.title}」です。どうぞ、お聴きください。`;
  }

  /**
   * パーソナリティに、曲の後のコメントを書かせる。
   *
   * @param {Record<string, any>} plan 曲の計画
   * @param {string|null} [actualTrackName] Spotify で実際に流れた曲名（計画に題名が無いときに使う）
   * @param {Record<string, any>|null} [performerInfo] Spotify の演奏者・アルバム
   * @returns {Promise<string>} セリフ（書けなければ決まった一言）
   */
  async _generateComment(plan, actualTrackName = null, performerInfo = null) {
    const config         = this.getConfig();
    const personalityCfg = config.agents?.beatles_personality || {};
    const _paulName      = personalityCfg.name || 'ポール小野';

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt ||
      'あなたはThe Beatles専門ラジオ番組『Eight Days A Week』のパーソナリティです。ビートルズ楽曲について深い知識で語ります。',
      'beatles_personality'
    );

    const performers = [];
    if (performerInfo?.spotifyArtists?.length > 0)
      performers.push(`演奏: ${performerInfo.spotifyArtists.join('、')}`);
    const performerSection = performers.length > 0 ? '\n' + performers.join('\n') : '';
    const albumNote = plan.album ? `\n収録アルバム: ${plan.album}` : '';

    const userPrompt = `今聴いていただいた楽曲についての感想・解説を語ってください。ダンディで落ち着いた、それでいて若々しいエネルギーのある言葉で。

楽曲: The Beatles「${plan.title || actualTrackName}」${albumNote}${performerSection}

${_paulName}の曲後コメントを2〜4文で書いてください。楽曲の魅力、演奏の聴きどころ、個人的な印象、時代背景などに触れてください。
セリフのみを出力してください。ト書き・説明は不要です。
${this._geminiInlineTagGuidanceJa()}${this._getAgentDiarySelfDigest('beatles_personality')}`;

    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'beatles_personality');
    return text || `素晴らしい曲でしたね。ビートルズの音楽は、何度聴いても新しい発見がありますね。`;
  }

  // ─── ショーループフック ────────────────────────────────────────────

  /**
   * ディレクターのエージェントキー。
   * @returns {string} beatles_director
   */
  get _directorAgentKey() { return 'beatles_director'; }

  /**
   * リスナーのリクエスト曲から、曲の計画を作る。
   *
   * 引数 req: リクエスト（title など）
   * @returns {Record<string, any>} 曲の計画
   */
  _buildRequestPlan(req) {
    return {
      title:         req.title,
      album:         req.album || '',
      year:          req.year || '',
      artist:        BEATLES_ARTIST,
      spotify_query: req.spotify_query || `artist:"The Beatles" track:"${req.title}"`,
      key_points:    'リスナーからのリクエスト曲です。',
      background:    '',
      isReplay:      true,
    };
  }

  /**
   * ログなどに出す曲の表記。
   *
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {string} 表記
   */
  _getPlanLabel(plan) { return `The Beatles「${plan.title}」`; }

  /**
   * Spotify の曲から演奏者の情報を組み立てる。
   *
   * 引数 spotifyTrack: Spotify の曲
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {Record<string, any>} 演奏者・アルバム・発表年
   */
  _buildSpotifyPerformerInfo(spotifyTrack, plan) {
    const spotifyArtists = this._extractSpotifyArtistNames(spotifyTrack);
    const spotifyAlbum   = spotifyTrack.album?.name || plan.album || '';
    return { spotifyArtists, spotifyAlbum, artist: BEATLES_ARTIST, album: plan.album || '', year: plan.year || '' };
  }

  /**
   * Spotify の検索結果から、アーティスト名が The Beatles と完全に一致する曲だけを残して選ぶ。
   *
   * Spotify の artist: の絞り込みは部分一致なので、「The Beatles Piano Covers」のようなカバーやトリビュートも
   * 混ざる。基底の _pickBestSpotifyTrack は候補が1件だと無条件で採用するので、その抜け道もここで塞ぐ。
   *
   * 引数 items: Spotify の検索結果
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {any} 選んだ曲（本人の演奏が無ければ null）
   */
  _pickBestSpotifyTrack(items, plan) {
    const exact = (items || []).filter(t =>
      (t.artists || []).some(a => (a.name || '').trim().toLowerCase() === BEATLES_ARTIST.toLowerCase())
    );
    if (exact.length === 0) {
      if (items?.length > 0) {
        getLogger().warn(`[Beatles Spotify] アーティスト名不一致のため除外: ${items.map(t => (t.artists || []).map(a => a.name).join('/')).join(' / ')}`);
      }
      return null;
    }
    return super._pickBestSpotifyTrack(exact, plan);
  }

  /**
   * Spotify で見つからなかった曲の記録（次から選ばせないため）。
   *
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {Record<string, any>} 再生の履歴の1件
   */
  _buildSpotifyFailedEntry(plan) {
    return {
      title: plan.title, trackName: null, playedAt: new Date().toISOString(), spotifyFailed: true,
    };
  }

  /**
   * 先読みした紹介が、この曲のものか（題名で比べる）。
   *
   * 引数 cached: 先読みした紹介
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {boolean} 同じ曲なら true
   */
  _checkIntroCacheHit(cached, plan) {
    return cached.title === plan.title;
  }

  /**
   * 画面と記録に使うアーティスト名。
   *
   * 引数 performerInfo: 演奏者の情報
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {string} アーティスト名
   */
  _getDisplayArtist(performerInfo, plan) {
    return performerInfo.spotifyArtists?.[0] || plan.artist || BEATLES_ARTIST;
  }

  /**
   * 再生の履歴の1件を作る。
   *
   * 引数 plan: 曲の計画（title・album・year など）
   * 引数 spotifyTrack: Spotify の曲
   * 引数 performerInfo: 演奏者の情報
   * @returns {Record<string, any>} 再生の履歴の1件
   */
  _buildPlayedEntry(plan, spotifyTrack, performerInfo) {
    return {
      title:         plan.title,
      album:         plan.album || '',
      year:          plan.year || '',
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
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {string} 表示名
   */
  _getCornerStartName(plan) { return `The Beatles ―「${plan.title}」`; }

  /**
   * 「直前に流した」の判定に使うキー（アーティストが常に同じなので題名）。
   *
   * 引数 plan: 曲の計画（title・album・year など）
   * @returns {string} キー
   */
  _getRecentKey(plan) { return plan.title; }

  /**
   * 設定に番組名が無いときの番組名。
   * @returns {string} 番組名
   */
  _getDefaultProgramName() { return 'Eight Days A Week'; }

  // ─── 管理コマンド ──────────────────────────────────────────────────

  /**
   * 管理人やリクエストの文から取り出した曲の情報を、曲の計画の形にする。
   *
   * 引数 info: 取り出した情報（title・composition・album・year など）
   * @returns {Record<string, any>} 曲の計画
   */
  _buildExtractedRequestTrack(info) {
    return {
      title:         info.title || info.composition,
      album:         info.album || '',
      year:          info.year || '',
      artist:        BEATLES_ARTIST,
      spotify_query: info.spotify_query || `artist:"The Beatles" track:"${info.title || info.composition}"`,
      isReplay:      true,
    };
  }
}

module.exports = BeatlesAgentSystem;
