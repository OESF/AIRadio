/**
 * @file Mood チャンネル（ムードミュージック・映画音楽）のエージェントシステム
 *
 * 24時間続く音楽チャンネル「トワイライト・ラウンジ」。ディレクター（mood_director、声は無い裏方）が
 * 4曲ずつのテーマのあるセッションを企画し、パーソナリティ（mood_personality）が曲の前の紹介と曲の後の
 * コメントを話す。番組の進め方・Spotify での再生・日記・リクエストなどの共通の流れは
 * MusicChannelAgentBase（music-channel-base.js と channel-base.js）にあり、このファイルは Mood に固有の
 * 部分（選曲のプロンプト・語り口・記録の形）だけをフックとして持つ。
 *
 * 保存先は server/data/channels/mood/ の config.json（チャンネルの設定）・long_term_memory.json（セッションの
 * 要約）・played_tracks.json（再生の履歴）。
 *
 * ATTENTION: プロンプトの中でパーソナリティの名前は直書きせず、_joeName（config の名前）を使うこと
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

const MOOD_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'mood', 'config.json');
const MOOD_MEMORY_PATH  = path.join(__dirname, 'data', 'channels', 'mood', 'long_term_memory.json');
const MOOD_PLAYED_PATH  = path.join(__dirname, 'data', 'channels', 'mood', 'played_tracks.json');

const MOOD_PLAYED_MAX    = 200;
// 再生の履歴に残す最大件数と、同じ曲を繰り返さない期間（時間）。
// BUGFIX: 期間は7日。候補（MOOD_REPERTOIRE、20曲）が少なく、48時間だとすぐ同じ定番曲が戻ってきていた
// （Jazz で見つかり、同じ作りの全チャンネルに当てた）。
const MOOD_PLAYED_HOURS  = 168;

/**
 * ディレクターに参考として見せる候補の曲（これ以外の曲も選べる）。
 */
const MOOD_REPERTOIRE = [
  { artist: 'ヘンリー・マンシーニ',    title: 'ムーン・リバー',              category: '映画音楽', film: 'ティファニーで朝食を' },
  { artist: 'エンニオ・モリコーネ',    title: 'ニュー・シネマ・パラダイス',    category: '映画音楽', film: 'ニュー・シネマ・パラダイス' },
  { artist: 'エンニオ・モリコーネ',    title: 'ガブリエルのオーボエ',          category: '映画音楽', film: 'ミッション' },
  { artist: 'フランシス・レイ',        title: '男と女',                       category: '映画音楽', film: '男と女' },
  { artist: 'ポール・モーリア',        title: '恋はみずいろ',                  category: 'ムード',   film: null },
  { artist: 'ポール・モーリア',        title: 'エーゲ海の真珠',               category: 'ムード',   film: null },
  { artist: 'ミシェル・ルグラン',      title: 'シェルブールの雨傘',            category: '映画音楽', film: 'シェルブールの雨傘' },
  { artist: 'ニーノ・ロータ',          title: 'ゴッドファーザー愛のテーマ',    category: '映画音楽', film: 'ゴッドファーザー' },
  { artist: 'ニーノ・ロータ',          title: 'ロミオとジュリエットのテーマ',  category: '映画音楽', film: 'ロミオとジュリエット' },
  { artist: 'ジョン・バリー',          title: '愛はすべての彼方に',            category: '映画音楽', film: '愛はすべての彼方に' },
  { artist: 'ジョン・ウィリアムズ',    title: 'シンドラーのリスト テーマ',     category: '映画音楽', film: 'シンドラーのリスト' },
  { artist: '坂本龍一',               title: '戦場のメリークリスマス',         category: '映画音楽', film: '戦場のメリークリスマス' },
  { artist: 'ジョルジュ・ドルリュー',  title: '軽蔑のテーマ',                 category: '映画音楽', film: '軽蔑' },
  { artist: 'モーリス・ジャール',      title: 'ドクトル・ジバゴのテーマ',      category: '映画音楽', film: 'ドクトル・ジバゴ' },
  { artist: 'チャーリー・チャップリン', title: 'スマイル',                     category: '映画音楽', film: 'モダン・タイムス' },
  { artist: 'アストル・ピアソラ',      title: 'リベルタンゴ',                 category: 'ムード',   film: null },
  { artist: 'フランク・チャックスフィールド', title: 'エボニー・コンチェルト', category: 'ムード',   film: null },
  { artist: 'ビリー・ヴォーン',        title: 'ダンケルク',                   category: 'ムード',   film: null },
  { artist: 'ジョン・ウィリアムズ',    title: 'ムーンライト・セレナーデ',      category: 'ムード',   film: null },
  { artist: 'バート・バカラック',      title: '雨にぬれても',                 category: 'ムード',   film: '明日に向かって撃て' },
];

/** Mood チャンネルのエージェントシステム（MusicChannelAgentBase のフックを Mood 用に実装する）。 */
class MoodAgentSystem extends MusicChannelAgentBase {
  /**
   * @param {Record<string, any>} mixer 音声のミキサー
   * @param {Record<string, any>} serverWrapper WebSocket への配信などを持つサーバー側のラッパー
   */
  constructor(mixer, serverWrapper) {
    super(mixer, serverWrapper, MOOD_CONFIG_PATH, 'Mood');

    this._memoryPath = MOOD_MEMORY_PATH;
    this._playedPath = MOOD_PLAYED_PATH;
    this._playedMax  = MOOD_PLAYED_MAX;

    this._playedPieces      = this._loadPlayedPieces();
    this._requestQueue      = [];
    this._sessionPlan       = null; // { theme, concept, pieces: [...] }
    this._isShuttingDown    = false;
    this._sessionStartTime  = Date.now();
    this._longTermContext   = '';
    this._nextIntroPrefetch = null; // { artist, title, text, pcm0 }
    this._openingPlanData   = null;
    this._needsNewSession   = false;

    this._interruptAgentKey = 'mood_personality';

    getLogger().info('[Mood] MoodAgentSystem 初期化完了');
  }

  // ─── オープニングプリフェッチ ─────────────────────────────────────

  /**
   * オープニングの紹介を作れなかったときの代わりの一言。
   *
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {string} 代わりのセリフ
   */
  _getOpeningFallbackText(plan) {
    return `${plan.artist}の「${plan.title}」をお届けします。どうぞ。`;
  }

  /**
   * 先読み（オープニング）で使う演奏者の情報を組み立てる。
   *
   * 引数 track: Spotify の曲
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * 引数 spotifyArtists: Spotify のアーティスト名
   * @returns {any} 演奏者・アルバム・作曲者・映画の題名
   */
  _buildPrefetchPerformerInfo(track, plan, spotifyArtists) {
    return {
      spotifyArtists,
      spotifyAlbum: track.album?.name || '',
      artist:       plan.artist,
      composer:     plan.composer || plan.artist,
      film_title:   plan.film_title || null,
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
  _formatMemoryPieceLine(p) { return `${p.artist}「${p.title}」`; }

  /**
   * セッションの要約を頼むときの、1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatSummaryPieceLine(p) { return `- ${p.artist}「${p.title}」`; }

  /**
   * セッションの要約（長期記憶）を作らせるプロンプト。
   *
   * 引数 piecesList: 流した曲の一覧
   * @returns {{systemPrompt: string, userPrompt: string}} プロンプト
   */
  _getSessionSummaryPrompts(piecesList) {
    const directorCfg = this.getConfig().agents?.mood_director || {};
    return {
      systemPrompt: 'あなたはムードミュージック・映画音楽ラジオ番組のアーカイバーです。',
      userPrompt: `このラジオセッションを2〜3文で要約してください。雰囲気と選曲の傾向を含めること。JSON形式で出力：\n{\n  "summary": "...",\n  "pieces_played": [{"artist": "...", "title": "..."}]\n}\n\n演奏曲:\n${piecesList}`,
    };
  }

  // ─── プランニング ──────────────────────────────────────────────────

  /**
   * ディレクターに、テーマのある4曲のセッションを企画させる。
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
    const directorCfg = config.agents?.mood_director || {};

    const cutoffMs     = Date.now() - MOOD_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection  = failedPieces.length > 0
      ? `\n【Spotifyで見つからない曲 — 選ばないこと】\n${failedPieces.map(p => `- ${p.artist}「${p.title}」`).join('\n')}`
      : '';
    const recentSection  = recentPlayed.length > 0
      ? `\n【最近流した曲 — 繰り返さないこと】\n${recentPlayed.map(p => `- ${p.artist}「${p.title}」`).join('\n')}`
      : '';
    const artistBan = recentArtists.length > 0
      ? `\n【直前に流したアーティスト — 選曲を変えること】\n${recentArtists.join('、')}\n`
      : '';
    const memorySection = this._longTermContext
      ? `\n【過去のセッション記録】\n${this._longTermContext}\n`
      : '';

    const listenerRequest = config.program?.listener_request || '';
    if (listenerRequest) {
      try {
        config.program.listener_request = '';
        writeJsonFile(MOOD_CONFIG_PATH, config);
      } catch { }
    }
    const requestSection = listenerRequest
      ? `\n【リスナーリクエスト — 最優先で反映すること】\n${listenerRequest}\n`
      : '';

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
    const diaryFeedback = this._getAgentDiarySelfDigest('mood_director') + this._getAgentDiaryTeamDigest('mood_director');
    // 最近のリクエストの履歴（知っておくだけの材料。lib/listener-context.js）
    const requestHistory = listenerContext.formatRequestHistoryForPrompt('mood_director', { channel: 'mood' });
    // ディレクター同士の共有・予定・季節と世の中の動き（channel-base.js の _buildDirectorSharedContext）
    const sharedContext = await this._buildDirectorSharedContext({ lang: 'ja' });

    const now      = new Date();
    const hour     = now.getHours();
    const timeCtx  = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    // BUGFIX: 曜日と時間帯だけでなく暦日まで渡す。「◯曜日深夜」は前日の夜とも読め、1日ずれていた。
    // ここで決まったテーマ名はオープニングで声になるので、そろえておく。
    const dateCtxPlan = this._buildDateTimeContext(now, timeCtx);

    const systemPrompt = directorCfg.prompt ||
      'あなたはムードミュージック・映画音楽ラジオ番組のディレクターです。4曲のテーマ性あるセッションを企画してください。';

    const userPrompt = `${dateCtxPlan}の放送に合わせた4曲のセッションを企画してください。
${listenerInfo ? `リスナー情報: ${listenerInfo}` : ''}${listenerDigest ? `\n【AI秘書がこれまでの会話から学んだリスナー像】${listenerDigest}` : ''}${diaryFeedback}${requestHistory}${sharedContext}${memorySection}${requestSection}${failedSection}${recentSection}${artistBan}
ムードミュージック・映画音楽の幅広いジャンルから選曲し、1つの統一テーマのもとにセッションを構成してください。
参考候補（これ以外の著名な楽曲も可）:
${MOOD_REPERTOIRE.filter(r => !recentArtists.includes(r.artist)).slice(0, 10).map((r, i) => `${i+1}. ${r.artist}「${r.title}」（${r.category}${r.film ? '、映画: ' + r.film : ''}）`).join('\n')}

有効なJSONのみ出力（マークダウン不要）:
{
  "theme": "テーマタイトル（例: 「映画の夜 ―― イタリア映画音楽の夕べ」）",
  "concept": "テーマの説明（2文程度）",
  "pieces": [
    {
      "order": 1,
      "artist": "アーティスト名",
      "title": "曲名",
      "category": "映画音楽 or ムード or ボサノバ など",
      "composer": "作曲者名",
      "film_title": "映画タイトル（映画音楽の場合のみ、なければnull）",
      "year": "録音・公開年（概算）",
      "spotify_query": "Spotify検索クエリ（英語推奨）",
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
      getLogger().info(`[Mood] セッション計画: テーマ「${plan.theme}」 ${plan.pieces.length}曲`);
      return plan;
    } catch (e) {
      getLogger().warn('[Mood] セッション計画パース失敗: ' + e.message);
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
    const directorCfg = config.agents?.mood_director || {};

    const cutoffMs     = Date.now() - MOOD_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection = failedPieces.length > 0
      ? `\n【Spotifyで見つからない曲 — 除外】\n${failedPieces.map(p => `- ${p.artist}「${p.title}」`).join('\n')}`
      : '';
    const recentSection = recentPlayed.length > 0
      ? `\n【最近流した曲 — 繰り返さないこと】\n${recentPlayed.map(p => `- ${p.artist}「${p.title}」`).join('\n')}`
      : '';
    const artistBan = recentArtists.length > 0
      ? `\n【直前のアーティスト — 別のアーティストを選ぶこと】\n${recentArtists.join('、')}`
      : '';

    const now     = new Date();
    const hour    = now.getHours();
    const timeCtx = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    const dateCtxDir = this._buildDateTimeContext(now, timeCtx);

    const systemPrompt = directorCfg.prompt || 'あなたはムードミュージック・映画音楽ラジオ番組のディレクターです。';

    const userPrompt = `次に流す1曲を選んでください。時間帯: ${dateCtxDir}。
${failedSection}${recentSection}${artistBan}

候補（これ以外も可）:
${MOOD_REPERTOIRE.filter(r => !recentArtists.includes(r.artist)).slice(0, 10).map((r, i) => `${i+1}. ${r.artist}「${r.title}」（${r.category}${r.film ? '、' + r.film : ''}）`).join('\n')}

有効なJSONのみ出力:
{
  "artist": "アーティスト名",
  "title": "曲名",
  "category": "ジャンルカテゴリ",
  "composer": "作曲者名",
  "film_title": "映画タイトル（映画音楽の場合のみ、なければnull）",
  "year": "録音・公開年",
  "spotify_query": "Spotify検索クエリ（英語推奨）",
  "key_points": "この曲の聴きどころ（1文以内）",
  "background": "楽曲の背景やエピソード（30字以内）"
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      getLogger().warn('[Mood Director] JSON パース失敗: ' + e.message);
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
    const personalityCfg = config.agents?.mood_personality || {};
    const _joeName       = personalityCfg.name || 'ジョー匠';
    const listener       = this._getListenerProfile();
    const listenerName   = listener.name || null;

    const now       = new Date(Date.now() + speakDelayMs);
    const hour      = now.getHours();
    const timeLabel = hour < 6 ? '深夜' : hour < 10 ? '朝' : hour < 14 ? '昼前後' : hour < 18 ? '午後' : hour < 22 ? '夜' : '深夜';
    // BUGFIX: 暦日まで含めて誤読の余地を無くす（channel-base.js の同じメソッド参照）。
    // 「木曜日深夜」と渡していたころは、日付が1日ずれて読み上げられた。
    const dateTimeCtx = this._buildDateTimeContext(now, timeLabel);

    const showDay = this._getShowDay();
    let isReturningToday = false;
    try {
      if (fs.existsSync(MOOD_MEMORY_PATH)) {
        const mem = JSON.parse(fs.readFileSync(MOOD_MEMORY_PATH, 'utf-8'));
        if (mem.last_greeting_show_day === showDay) isReturningToday = true;
      }
    } catch { /* ignore */ }

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt ||
      'あなたはジョー匠、ラジオ番組のパーソナリティです。品格ある美しい日本語で、ムードミュージックと映画音楽を紹介します。',
      'mood_personality'
    );

    let openingLine;
    if (isOpening) {
      const nameGreet = listenerName ? `、${listenerName}さん` : '';
      // BUGFIX: リスナーの名前が誰の名前かをはっきり書く。挨拶の中に「ようこそ、〜へ、◯◯さん」とリスナーの
      // 名前を入れているため、自己紹介の形に読み替えて、パーソナリティがリスナーの名前で名乗ってしまっていた。
      const nameGuard = listenerName
        ? `\n【重要】「${listenerName}」はリスナー（聴いている人）の名前であって、あなたの名前では`
          + `ありません。あなたは「${_joeName}」です。挨拶ではリスナーに呼びかけるだけにし、`
          + `「${listenerName}です」のようにリスナーの名前で名乗ることは絶対にしないでください。`
        : '';
      if (isReturningToday) {
        if (sessionInfo?.theme) {
          openingLine = `「おかえりなさいませ${nameGreet}。またお越しいただけて光栄です」という温かな言葉で始め、本日のテーマ「${sessionInfo.theme}」を品よく紹介し、最初の楽曲へと誘ってください。現在は${dateTimeCtx}です。${nameGuard}`;
        } else {
          openingLine = `「おかえりなさいませ${nameGreet}。またお越しいただけて光栄です」という温かな言葉で始め、最初の楽曲をご紹介ください。現在は${dateTimeCtx}です。${nameGuard}`;
        }
      } else {
        if (sessionInfo?.theme) {
          openingLine = `「ようこそ、トワイライト・ラウンジへ${nameGreet}」という品のある挨拶で始め、本日のテーマ「${sessionInfo.theme}」を情感豊かに紹介し、最初の楽曲へと誘ってください。現在は${dateTimeCtx}です。${nameGuard}`;
          if (sessionInfo.concept) openingLine += `テーマの背景: ${sessionInfo.concept}`;
        } else {
          openingLine = `「ようこそ、トワイライト・ラウンジへ${nameGreet}」という品のある挨拶で始め、最初の楽曲をご紹介ください。現在は${dateTimeCtx}です。${nameGuard}`;
        }
      }
    } else {
      openingLine = '次の楽曲をご紹介ください。自然な流れで続けてください。';
    }

    const performerLine = performerInfo?.spotifyArtists?.length > 0
      ? `演奏者（Spotify）: ${performerInfo.spotifyArtists.join(' / ')}${performerInfo.spotifyAlbum ? '　アルバム: ' + performerInfo.spotifyAlbum : ''}`
      : '';
    const filmLine = plan.film_title ? `映画: ${plan.film_title}` : '';
    const composerLine = plan.composer && plan.composer !== plan.artist ? `作曲者: ${plan.composer}` : '';

    const userPrompt = `${openingLine}

現在時刻: ${dateTimeCtx}

楽曲情報:
アーティスト: ${plan.artist}
曲名: 「${plan.title}」
カテゴリ: ${plan.category || 'ムードミュージック'}
${composerLine}
${filmLine}
${performerLine}
発表年: ${plan.year || '不明'}
聴きどころ: ${plan.key_points || ''}
背景・エピソード: ${plan.background || ''}

${_joeName}のラジオセリフを日本語で書いてください。品格ある美しい言葉遣いで、楽曲の歴史や背景を詳しく、かつ聴衆が惹きつけられるように語ります。「それでは、どうぞ」「お聴きください」などで楽曲を誘い込んでください。
セリフのみを出力してください。ト書き・説明・括弧書きは不要です。
${this._geminiInlineTagGuidanceJa()}${this._getAgentDiarySelfDigest('mood_personality')}`;

    if (onSentence) {
      const text = await this._callGeminiStreaming(systemPrompt, userPrompt, onSentence, -1, 'main', 'mood_personality');
      return text || `${plan.artist}の「${plan.title}」です。どうぞ、お聴きください。`;
    }
    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'mood_personality');
    return text || `${plan.artist}の「${plan.title}」です。どうぞ、お聴きください。`;
  }

  /**
   * パーソナリティに、曲の後のコメント（2〜4文）を書かせる。
   *
   * @param {Record<string, any>} plan 曲の計画（artist・title・category・composer・film_title など）
   * @param {string|null} [actualTrackName] Spotify で実際に流れた曲名（計画に題名が無いときに使う）
   * @param {Record<string, any>|null} [performerInfo] Spotify の演奏者・アルバム
   * @returns {Promise<string>} セリフ（書けなければ決まった一言）
   */
  async _generateComment(plan, actualTrackName = null, performerInfo = null) {
    const config         = this.getConfig();
    const personalityCfg = config.agents?.mood_personality || {};
    const _joeName       = personalityCfg.name || 'ジョー匠';

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt ||
      'あなたはジョー匠、ラジオ番組のパーソナリティです。品格ある美しい日本語で音楽を語ります。',
      'mood_personality'
    );

    const performers = [];
    if (performerInfo?.spotifyArtists?.length > 0)
      performers.push(`演奏: ${performerInfo.spotifyArtists.join('、')}`);
    if (performerInfo?.spotifyAlbum)
      performers.push(`アルバム: ${performerInfo.spotifyAlbum}`);
    const performerSection = performers.length > 0 ? '\n' + performers.join('\n') : '';
    const filmNote = plan.film_title ? `\n映画: ${plan.film_title}` : '';

    const userPrompt = `今聴いていただいた楽曲についての感想・解説を語ってください。温かく、品格のある言葉で。

楽曲: ${plan.artist}「${plan.title || actualTrackName}」${filmNote}${performerSection}

${_joeName}の曲後コメントを2〜4文で書いてください。楽曲の響き、演奏の魅力、個人的な印象、映画の世界観などに触れてください。
セリフのみを出力してください。ト書き・説明は不要です。
${this._geminiInlineTagGuidanceJa()}${this._getAgentDiarySelfDigest('mood_personality')}`;

    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'mood_personality');
    return text || `素晴らしい曲でしたね。音楽というものは、心の奥深くに届くものですね。`;
  }

  // ─── ショーループフック ────────────────────────────────────────────

  /**
   * ディレクターのエージェントキー。
   * @returns {string} mood_director
   */
  get _directorAgentKey() { return 'mood_director'; }

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
      category:      req.category || 'ムードミュージック',
      composer:      req.composer || req.artist,
      film_title:    req.film_title || null,
      year:          req.year || '',
      spotify_query: req.spotify_query || `${req.artist} ${req.title}`,
      key_points:    'リスナーからのリクエスト曲です。',
      background:    '',
      isReplay:      true,
    };
  }

  /**
   * ログなどに出す曲の表記。
   *
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {string} 表記
   */
  _getPlanLabel(plan) { return `${plan.artist}「${plan.title}」`; }

  /**
   * Spotify の曲から演奏者の情報を組み立てる。
   *
   * 引数 spotifyTrack: Spotify の曲
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {Record<string, any>} 演奏者・アルバム・作曲者・映画の題名
   */
  _buildSpotifyPerformerInfo(spotifyTrack, plan) {
    const spotifyArtists = this._extractSpotifyArtistNames(spotifyTrack);
    const spotifyAlbum   = spotifyTrack.album?.name || '';
    return { spotifyArtists, spotifyAlbum, artist: plan.artist, composer: plan.composer || plan.artist, film_title: plan.film_title || null };
  }

  /**
   * Spotify で見つからなかった曲の記録（次から選ばせないため）。
   *
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
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
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {boolean} 同じ曲なら true
   */
  _checkIntroCacheHit(cached, plan) {
    return cached.artist === plan.artist && cached.title === plan.title;
  }

  /**
   * 画面と記録に使うアーティスト名（Spotify の名前、無ければ計画の名前）。
   *
   * 引数 performerInfo: 演奏者の情報
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {string} アーティスト名
   */
  _getDisplayArtist(performerInfo, plan) {
    return performerInfo.spotifyArtists[0] || plan.artist;
  }

  /**
   * 再生の履歴の1件を作る。
   *
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * 引数 spotifyTrack: Spotify の曲
   * 引数 performerInfo: 演奏者の情報
   * @returns {Record<string, any>} 再生の履歴の1件
   */
  _buildPlayedEntry(plan, spotifyTrack, performerInfo) {
    return {
      // BUGFIX: アーティスト名は Spotify で確かめた正式な名前にする。LLM が毎回書く名前をそのまま使うと、
      // 表記のゆれで同じ曲が別の曲として記録され、重複の防止とアンコールの一覧の両方で増えていた。
      artist:        this._getDisplayArtist(performerInfo, plan),
      title:         plan.title,
      category:      plan.category || 'ムード',
      composer:      plan.composer || plan.artist,
      film_title:    plan.film_title || null,
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
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {string} 表示名
   */
  _getCornerStartName(plan) { return `${plan.artist} ― 「${plan.title}」`; }

  /**
   * 「直前に流した」の判定に使うキー（アーティスト）。
   *
   * 引数 plan: 曲の計画（artist・title・category・composer・film_title など）
   * @returns {string} キー
   */
  _getRecentKey(plan) { return plan.artist; }

  /**
   * 設定に番組名が無いときの番組名。
   * @returns {string} 番組名
   */
  _getDefaultProgramName() { return 'トワイライト・ラウンジ'; }

  // ─── 管理コマンド ──────────────────────────────────────────────────

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
      category:      info.category      || 'ムードミュージック',
      composer:      info.composer      || info.artist,
      film_title:    info.film_title    || null,
      spotify_query: info.spotify_query || `${info.artist || info.composer} ${info.title || info.composition}`,
      isReplay:      true,
    };
  }
}

module.exports = MoodAgentSystem;
