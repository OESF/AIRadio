/**
 * @file Classic チャンネル（クラシック音楽の番組）のエージェントシステム
 *
 * 24時間続くクラシックのチャンネル「静寂のスコア」。ディレクター（classic_director、声は無い裏方）が
 * テーマのあるセッションを企画し、パーソナリティ（classic_personality）が曲の前の紹介と曲の後のコメントを話す。
 * 番組の進め方・Spotify での再生・日記・リクエストなどの共通の流れは MusicChannelAgentBase
 * （music-channel-base.js と channel-base.js）にあり、このファイルは Classic に固有の部分だけをフックとして持つ。
 *
 * 保存先は server/data/channels/classic/ の config.json（チャンネルの設定）・long_term_memory.json（セッションの
 * 要約）・played_tracks.json（再生の履歴）。
 *
 * ATTENTION: パーソナリティの名前は、今はプロンプトで参照していない（設定の prompt をそのまま使う）。
 * 名前を入れるときは、他のチャンネルと同じく personalityCfg.name から変数を作ること（CLAUDE.md 参照）。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-19
 */
'use strict';

const fs   = require('fs');
const { writeJsonFile } = require('./lib/atomic-json');
const listenerContext = require('./lib/listener-context');
const path = require('path');
const { getLogger } = require('./logger');
const MusicChannelAgentBase = require('./music-channel-base');

const CLASSIC_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'classic', 'config.json');
const CLASSIC_MEMORY_PATH  = path.join(__dirname, 'data', 'channels', 'classic', 'long_term_memory.json');
const CLASSIC_PLAYED_PATH  = path.join(__dirname, 'data', 'channels', 'classic', 'played_tracks.json');
const CLASSIC_PLAYED_MAX      = 200;  // 再生の履歴を残す件数
// 同じ曲を繰り返さない期間（時間）。
// BUGFIX: 期間は7日。候補（CLASSIC_REPERTOIRE、約24曲）が少なく、48時間だと同じ定番曲がすぐ戻ってきていた
const CLASSIC_PLAYED_HOURS    = 168;

// ディレクターに見せる候補の曲（ここに無い名曲を選んでもよい）
const CLASSIC_REPERTOIRE = [
  { composer: 'ベートーヴェン', composition: '交響曲第5番 ハ短調「運命」', period: '古典派' },
  { composer: 'ベートーヴェン', composition: '交響曲第9番 ニ短調「合唱」', period: '古典派' },
  { composer: 'モーツァルト',   composition: '交響曲第40番 ト短調',        period: '古典派' },
  { composer: 'モーツァルト',   composition: 'ピアノ協奏曲第21番 ハ長調',  period: '古典派' },
  { composer: 'バッハ',        composition: '無伴奏チェロ組曲第1番',        period: 'バロック' },
  { composer: 'バッハ',        composition: 'G線上のアリア',               period: 'バロック' },
  { composer: 'ドビュッシー',   composition: '月の光',                     period: '近現代' },
  { composer: 'ショパン',      composition: '夜想曲 第2番 変ホ長調',        period: 'ロマン派' },
  { composer: 'ブラームス',    composition: '交響曲第1番 ハ短調',            period: 'ロマン派' },
  { composer: 'チャイコフスキー', composition: 'ピアノ協奏曲第1番',          period: 'ロマン派' },
  { composer: 'チャイコフスキー', composition: '弦楽セレナード ハ長調',      period: 'ロマン派' },
  { composer: 'ドヴォルザーク', composition: '交響曲第9番「新世界より」',    period: 'ロマン派' },
  { composer: 'ヴィヴァルディ', composition: '四季 春',                     period: 'バロック' },
  { composer: 'ヴィヴァルディ', composition: '四季 冬',                     period: 'バロック' },
  { composer: 'ハイドン',      composition: '交響曲第94番「驚愕」',          period: '古典派' },
  { composer: 'シューベルト',   composition: '弦楽四重奏曲「死と乙女」',     period: 'ロマン派' },
  { composer: 'シューベルト',   composition: '「未完成」交響曲',             period: 'ロマン派' },
  { composer: 'マーラー',      composition: '交響曲第5番 嬰ハ短調',          period: '近現代' },
  { composer: 'ラヴェル',      composition: 'ボレロ',                      period: '近現代' },
  { composer: 'バルトーク',    composition: '弦楽器と打楽器とチェレスタのための音楽', period: '近現代' },
  { composer: 'ヘンデル',      composition: 'メサイア ハレルヤ',            period: 'バロック' },
  { composer: 'グリーグ',      composition: 'ペール・ギュント 朝',           period: 'ロマン派' },
  { composer: 'サン＝サーンス', composition: '動物の謝肉祭 白鳥',           period: 'ロマン派' },
  { composer: 'ラフマニノフ',   composition: 'ピアノ協奏曲第2番 ハ短調',     period: '近現代' },
];

/** Classic チャンネルのエージェントシステム（MusicChannelAgentBase のフックを Classic 用に実装する）。 */
class ClassicAgentSystem extends MusicChannelAgentBase {
  /**
   * @param {Record<string, any>} mixer 音声のミキサー
   * @param {Record<string, any>} serverWrapper WebSocket への配信などを持つサーバー側のラッパー
   */
  constructor(mixer, serverWrapper) {
    super(mixer, serverWrapper, CLASSIC_CONFIG_PATH, 'Classic');

    this._memoryPath = CLASSIC_MEMORY_PATH;
    this._playedPath = CLASSIC_PLAYED_PATH;
    this._playedMax  = CLASSIC_PLAYED_MAX;

    this._playedPieces = this._loadPlayedPieces();

    // リスナーからのもう一度流してほしい曲
    this._requestQueue = [];

    this._isShuttingDown   = false;
    this._sessionStartTime = Date.now();
    this._longTermContext  = '';
    this._sessionPlan      = null; // { theme, concept, pieces: [...] }

    // 次の曲の紹介の先読み（曲の再生中に裏で準備する）
    this._nextIntroPrefetch = null; // { composer, composition, text, pcm0 }

    // オープニングのジングル中に先に準備した、最初の曲
    this._openingPlanData = null;

    // 全員が退出して終わりの処理をした後、次の接続でオープニングからやり直す印
    this._needsNewSession = false;

    this._interruptAgentKey = 'classic_personality';

    getLogger().info('[Classic] ClassicAgentSystem 初期化完了');
  }

  /**
   * オープニングの紹介を作れなかったときの代わりの一言。
   *
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {string} 代わりのセリフ
   */
  _getOpeningFallbackText(plan) {
    return `${plan.composer}の「${plan.composition}」をお届けします。それでは、お聴きください。`;
  }

  /**
   * 先読み（オープニング）で使う演奏者の情報を組み立てる。
   *
   * 引数 track: Spotify の曲
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * 引数 spotifyArtists: Spotify のアーティスト名
   * @returns {any} 演奏者・アルバム・指揮者・オーケストラ
   */
  _buildPrefetchPerformerInfo(track, plan, spotifyArtists) {
    return {
      spotifyArtists,
      spotifyAlbum: track.album?.name || '',
      conductor:    plan.conductor || '',
      ensemble:     plan.ensemble  || '',
    };
  }

  // ─── 長期記憶 ───────────────────────────────────────────────────

  /**
   * 長期記憶に書くセッションの見出し。
   *
   * 引数 date: 日付
   * @returns {string} 見出し
   */
  _getMemorySessionHeader(date) { return `【${date}のセッション】`; }
  /**
   * 長期記憶に書く1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatMemoryPieceLine(p) { return `${p.composer}「${p.composition}」${p.conductor ? ` (指揮: ${p.conductor})` : ''}`; }

  /**
   * セッションの要約を頼むときの、1曲の表記。
   *
   * 引数 p: 曲
   * @returns {string} 表記
   */
  _formatSummaryPieceLine(p) {
    let s = `- ${p.composer}「${p.composition}」`;
    if (p.conductor) s += ` / 指揮: ${p.conductor}`;
    if (p.ensemble)  s += ` / ${p.ensemble}`;
    return s;
  }

  /**
   * セッションの要約（長期記憶）を作らせるプロンプト。
   *
   * 引数 piecesList: 流した曲の一覧
   * @returns {{systemPrompt: string, userPrompt: string}} プロンプト
   */
  _getSessionSummaryPrompts(piecesList) {
    return {
      systemPrompt: 'あなたはクラシック音楽番組のアーカイブ担当です。',
      userPrompt: `今回のクラシック音楽ラジオセッションを要約してください。\n\n【演奏楽曲】\n${piecesList}\n\n以下のJSONのみで出力してください（マークダウン不要）:\n{\n  "summary": "今回のセッションの流れ（2〜3文、時代・雰囲気を含む）",\n  "highlights": "印象的な演奏や楽曲に関する一言",\n  "pieces_played": [\n    { "composer": "作曲家名", "composition": "曲名", "conductor": "指揮者名（不明なら空文字）" }\n  ]\n}`,
    };
  }

  // ─── テーマ番組プランニング ─────────────────────────────────────

  /**
   * ディレクターに、4曲でテーマのあるセッションを企画させる。
   *
   * 材料は、リスナーの情報・秘書が学んだリスナー像・日記のふり返り・リクエストの履歴・ディレクター同士の
   * 共有・過去のセッション・リスナーのリクエスト・最近流した曲など。リスナーのリクエストは1回使ったら
   * 設定から消す。
   *
   * @param {string[]} [recentComposers] 直前に流した作曲家（避けさせる）
   * @returns {Promise<Record<string, any>|null>} セッションの計画（theme・concept・pieces）。作れなければ null
   */
  async _planSession(recentComposers = []) {
    const config      = this.getConfig();
    const directorCfg = config.agents?.classic_director || config.agents?.director || {};

    const cutoffMs = Date.now() - CLASSIC_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection = failedPieces.length > 0
      ? `\n【🚫 Spotifyで見つからなかった曲（選ばないこと）】\n` +
        failedPieces.map(p => `- ${p.composer}「${p.composition}」`).join('\n')
      : '';
    const recentSection = recentPlayed.length > 0
      ? `\n【❌ 直近${CLASSIC_PLAYED_HOURS}時間以内に放送済み（繰り返し禁止）】\n` +
        recentPlayed.map(p => `- ${p.composer}「${p.composition}」`).join('\n')
      : '';
    const composerBan = recentComposers.length > 0
      ? `\n【🚫 直前に放送した作曲家（今回は避けること）】: ${recentComposers.join(', ')}\n`
      : '';
    const memorySection = this._longTermContext
      ? `\n【過去セッションの記録（参考）】\n${this._longTermContext}\n`
      : '';

    // リスナーのリクエストは1回使ったら消す
    const listenerRequest = config.program?.listener_request || '';
    if (listenerRequest) {
      try {
        config.program.listener_request = '';
        writeJsonFile(CLASSIC_CONFIG_PATH, config);
      } catch { }
    }
    const listenerRequestSection = listenerRequest
      ? `\n【🎵 リスナーからの選曲リクエスト（最優先で反映すること）】\n${listenerRequest}\n`
      : '';

    const listener = this._getListenerProfile();
    const listenerInfo = [
      listener.name       ? `リスナー名: ${listener.name}` : '',
      listener.occupation ? `職業: ${listener.occupation}` : '',
      listener.hobbies    ? `趣味: ${listener.hobbies}` : '',
    ].filter(Boolean).join('、');
    // 秘書との会話から学んだリスナー像
    const listenerDigest = this._getListenerDigest();
    // 日記のふり返り（週1回作られる）。ディレクター自身の選曲の癖と、パーソナリティの日記から
    // 見えた気づき。まだ無ければ空文字
    const diaryFeedback = this._getAgentDiarySelfDigest('classic_director') + this._getAgentDiaryTeamDigest('classic_director');
    // 最近のリクエストの履歴（知っておくだけの情報。lib/listener-context.js）
    const requestHistory = listenerContext.formatRequestHistoryForPrompt('classic_director', { channel: 'classic' });
    // ディレクター同士の共有・予定・季節と世の中の動き（channel-base.js の _buildDirectorSharedContext）
    const sharedContext = await this._buildDirectorSharedContext({ lang: 'ja' });

    const now = new Date();
    const hour = now.getHours();
    const timeCtx = hour < 6 ? '深夜' : hour < 10 ? '早朝' : hour < 14 ? '午前〜昼' : hour < 18 ? '午後' : hour < 22 ? '夕方〜夜' : '深夜';
    // BUGFIX: 日付まで含めて渡す。曜日と時間帯だけだと「◯曜日深夜」が前日の夜とも読め、1日ずれていた。
    // ここは読み上げないが、決まったテーマ名はオープニングで声になる
    const dateCtxPlan = this._buildDateTimeContext(now, timeCtx);

    const systemPrompt = directorCfg.prompt || 'あなたはクラシック音楽番組のプログラムディレクターです。テーマを持った番組を企画してください。';

    const userPrompt = `クラシック音楽ラジオのプログラムを企画してください。

【現在時刻】${dateCtxPlan}
${listenerInfo ? `【リスナー情報】${listenerInfo}` : ''}${listenerDigest ? `\n【AI秘書がこれまでの会話から学んだリスナー像】${listenerDigest}` : ''}${diaryFeedback}${requestHistory}${sharedContext}${memorySection}${listenerRequestSection}${failedSection}${recentSection}${composerBan}
4曲でひとつのテーマを持った番組を企画してください。
※リスナー情報は選曲の参考のみに使用すること。各曲のkey_points/backgroundにリスナー名を含めないこと。
必ず以下のJSONのみで回答してください（マークダウンのコードブロック不要）:
{
  "theme": "今夜のテーマ（例: 「ロマン派の夕べ」「バッハの大聖堂」）",
  "concept": "テーマの説明（2文程度）",
  "pieces": [
    {
      "order": 1,
      "composer": "作曲家名（日本語）",
      "composition": "曲名（日本語）",
      "period": "時代（バロック/古典派/ロマン派/近現代）",
      "conductor": "おすすめ指揮者名（英語フルネーム、例: Herbert von Karajan）",
      "ensemble": "おすすめオーケストラ（英語、例: Berlin Philharmonic）",
      "spotify_query": "Spotify検索クエリ（英語。曲名＋指揮者名を含める）",
      "key_points": "聴きどころ（1文以内）",
      "background": "作曲の背景（30字以内）",
      "role": "opening"
    },
    { "order": 2, "role": "main" },
    { "order": 3, "role": "featured" },
    { "order": 4, "role": "closing" }
  ]
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const plan = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(plan.pieces) || plan.pieces.length === 0) return null;
      getLogger().info(`[Classic] セッション計画: テーマ「${plan.theme}」 ${plan.pieces.length}曲`);
      return plan;
    } catch (e) {
      getLogger().warn('[Classic] セッション計画パース失敗: ' + e.message);
      return null;
    }
  }

  // ─── ショーロジック ──────────────────────────────────────────────

  /**
   * ディレクターに、次に流す1曲を選ばせる（セッションの企画に失敗したときの代わり）。
   *
   * ATTENTION: ディレクターの設定は classic_director から読むこと。director だけを見ると、
   * 設定した prompt が使われず、いつも決まった一文になる（_planSession と同じ読み方にそろえてある）。
   *
   * @param {string[]} [recentComposers] 直前に流した作曲家（避けさせる）
   * @returns {Promise<Record<string, any>|null>} 曲の計画（作れなければ null）
   */
  async _directorPlan(recentComposers = []) {
    const config = this.getConfig();
    const directorCfg = config.agents?.classic_director || config.agents?.director || {};

    const cutoffMs = Date.now() - CLASSIC_PLAYED_HOURS * 60 * 60 * 1000;
    const recentPlayed  = this._playedPieces.filter(p => !p.spotifyFailed && new Date(p.playedAt).getTime() > cutoffMs);
    const failedPieces  = this._playedPieces.filter(p => p.spotifyFailed);

    const failedSection = failedPieces.length > 0
      ? `\n【🚫 Spotifyで見つからなかった曲（絶対に選ばないこと）】\n` +
        failedPieces.map(p => `- ${p.composer}「${p.composition}」`).join('\n')
      : '';
    const recentSection = recentPlayed.length > 0
      ? `\n【❌ 直近${CLASSIC_PLAYED_HOURS}時間以内に放送済み（繰り返し禁止）】\n` +
        recentPlayed.map(p => `- ${p.composer}「${p.composition}」（Spotify: ${p.trackName || '不明'}）`).join('\n')
      : '';
    const composerBan = recentComposers.length > 0
      ? `\n【🚫 直近で放送した作曲家（今回は別の作曲家を選ぶこと）】\n` +
        recentComposers.map(c => `- ${c}`).join('\n')
      : '';

    // リスナーの情報（Live チャンネルの設定を使う）
    const listener = this._getListenerProfile();
    const listenerInfo = [
      listener.name ? `リスナー名: ${listener.name}` : '',
      listener.occupation ? `職業: ${listener.occupation}` : '',
      listener.hobbies ? `趣味: ${listener.hobbies}` : '',
      listener.location ? `所在地: ${listener.location}` : '',
    ].filter(Boolean).join('\n');

    const now = new Date();
    const hour = now.getHours();
    const timeContext = hour < 6 ? '深夜' : hour < 10 ? '早朝' : hour < 14 ? '午前〜昼' : hour < 18 ? '午後' : hour < 22 ? '夕方〜夜' : '深夜';
    const dateCtxDir = this._buildDateTimeContext(now, timeContext);

    const systemPrompt = directorCfg.prompt || 'あなたはクラシック音楽番組のディレクターです。';

    const userPrompt = `以下の情報をもとに、次に流す1曲を選んでください。

【現在時刻】${dateCtxDir}
【リスナー情報】
${listenerInfo}
${failedSection}${recentSection}${composerBan}

以下の候補から選ぶか、あるいは別の名曲を選んでください（上記の禁止リストにある曲は選ばないこと）:
${CLASSIC_REPERTOIRE.filter(r => !recentComposers.includes(r.composer)).slice(0, 10).map((r, i) => `${i+1}. ${r.composer}「${r.composition}」(${r.period})`).join('\n')}

必ず以下のJSONのみで回答してください（余計な説明は不要）:
{
  "composer": "作曲家名（日本語）",
  "composition": "曲名（日本語）",
  "period": "時代区分（バロック/古典派/ロマン派/近現代）",
  "conductor": "推奨する指揮者名または演奏者名（日本語。例: ヘルベルト・フォン・カラヤン、マルタ・アルゲリッチ）",
  "ensemble": "推奨するオーケストラ・アンサンブル名（日本語。例: ベルリン・フィルハーモニー管弦楽団）",
  "spotify_query": "Spotify検索クエリ（英語で。指揮者・演奏者名も含めること。例: Beethoven Symphony No 5 Karajan Berlin Philharmonic）",
  "key_points": "聴きどころ（1〜2文）",
  "background": "作曲の背景・エピソード（2〜3文）"
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      getLogger().warn('[Classic Director] JSON 抽出失敗。フォールバック使用。');
      return null;
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      getLogger().warn('[Classic Director] JSON パース失敗: ' + e.message);
      return null;
    }
  }

  /**
   * パーソナリティに、曲の前の紹介のセリフを書かせる（オープニングの挨拶を含む）。
   *
   * その日すでに挨拶していれば「お帰りなさい」と迎え、夜（17時以降）でなければ夜の表現を禁じる。
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
    const config = this.getConfig();
    const personalityCfg = config.agents?.classic_personality || {};
    const listener = this._getListenerProfile();
    const listenerName = listener.name || 'リスナー';

    // 時間帯と挨拶の種類は Live と同じ決め方
    const now = new Date(Date.now() + speakDelayMs);
    const hour = now.getHours();
    const showDay = this._getShowDay();

    // その日すでに挨拶したか
    let isReturningToday = false;
    try {
      if (fs.existsSync(CLASSIC_MEMORY_PATH)) {
        const mem = JSON.parse(fs.readFileSync(CLASSIC_MEMORY_PATH, 'utf-8'));
        if (mem.last_greeting_show_day === showDay) isReturningToday = true;
      }
    } catch { /* ignore */ }

    let timeLabel;
    if (hour < 6)       timeLabel = '深夜';
    else if (hour < 10) timeLabel = '朝';
    else if (hour < 14) timeLabel = '午前〜昼';
    else if (hour < 18) timeLabel = '午後';
    else if (hour < 22) timeLabel = '夕方〜夜';
    else                timeLabel = '深夜';

    // 日付まで含めて、読み違えようのない言い方にする（channel-base.js の同メソッド参照）
    const dateTimeCtx = this._buildDateTimeContext(now, timeLabel);

    const isEvening = hour >= 17;
    // 夜だけの表現（今宵・今夜）を使ってよいか
    const eveningNote = isEvening
      ? '「今宵」「今夜」などの夜の表現を使って構いません。'
      : `⚠️ 現在は${dateTimeCtx}です。「今宵」「今夜」など夜限定の表現は絶対に使わないでください。`;

    const themePeriod = isEvening ? '今夜の' : '今回の';

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt || 'あなたはクラシック音楽番組のパーソナリティです。',
      'classic_personality'
    );

    let openingLine;
    if (isOpening && isReturningToday) {
      const returnGreet = `「${listenerName}さん、お帰りなさい！またお越しいただき、ありがとうございます。」と名前を呼んで温かくお迎えしてください。`;
      if (sessionInfo?.theme) {
        openingLine = `まず再接続への喜びを表す挨拶（${returnGreet}）をしてから、${themePeriod}テーマ「${sessionInfo.theme}」を紹介し、最初の楽曲を紹介してください。${eveningNote}` +
          (sessionInfo.concept ? `\nテーマの説明: ${sessionInfo.concept}` : '');
      } else {
        openingLine = `まず再接続への喜びを表す挨拶（${returnGreet}）をしてから（2〜3文）、最初の楽曲を紹介してください。${eveningNote}`;
      }
    } else if (isOpening && sessionInfo?.theme) {
      openingLine = `まず番組の始まりの挨拶をしてから、${themePeriod}テーマ「${sessionInfo.theme}」を紹介し、最初の楽曲を紹介してください。` +
        `挨拶は「ようこそ」を使って${listenerName}さんをお迎えし、テーマへの期待感を込めてください。${eveningNote}` +
        (sessionInfo.concept ? `\nテーマの説明: ${sessionInfo.concept}` : '');
    } else if (isOpening) {
      openingLine = `まず番組の始まりの挨拶（2〜3文）をしてから、最初の楽曲を紹介してください。挨拶は「ようこそ」を使って${listenerName}さんをお迎えし、番組への期待感を込めてください。${eveningNote}`;
    } else {
      openingLine = '以下の楽曲を紹介するトークを作ってください。';
    }

    const _pLines = [];
    if (performerInfo?.spotifyArtists?.length > 0) {
      _pLines.push(`演奏者: ${performerInfo.spotifyArtists.join(' / ')}`);
      if (performerInfo.spotifyAlbum) _pLines.push(`アルバム: ${performerInfo.spotifyAlbum}`);
    } else {
      if (plan.conductor) _pLines.push(`指揮者・演奏者: ${plan.conductor}`);
      if (plan.ensemble)  _pLines.push(`オーケストラ・アンサンブル: ${plan.ensemble}`);
    }
    const performerLines = _pLines.join('\n');

    const userPrompt = `${openingLine}

【現在時刻】${dateTimeCtx}

【楽曲情報】
作曲家: ${plan.composer}
曲名: ${plan.composition}
時代: ${plan.period}
${performerLines ? performerLines + '\n' : ''}聴きどころ: ${plan.key_points || ''}
背景・エピソード: ${plan.background || ''}

ラジオで読み上げる日本語テキストのみを出力してください。
紹介は2〜4段落程度。楽曲の美しさや聴きどころを丁寧に伝えてください。
指揮者・演奏者の名前が分かる場合は、その解釈や演奏スタイルにも触れてください。
末尾は「それでは、お聴きください」などで締めてください。
楽曲はラジオ局が選定したものとして紹介してください。
${this._geminiInlineTagGuidanceJa()}${this._getAgentDiarySelfDigest('classic_personality')}`;

    if (onSentence) {
      const text = await this._callGeminiStreaming(systemPrompt, userPrompt, onSentence, -1, 'main', 'classic_personality');
      return text || `${plan.composer}の「${plan.composition}」をお届けします。それでは、お聴きください。`;
    }
    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'classic_personality');
    return text || `${plan.composer}の「${plan.composition}」をお届けします。それでは、お聴きください。`;
  }

  /**
   * パーソナリティに、曲の後のコメントを書かせる。
   *
   * @param {Record<string, any>} plan 曲の計画
   * @param {string|null} [actualTrackName] Spotify で実際に流れた曲名（計画に曲名が無いときに使う）
   * @param {Record<string, any>|null} [performerInfo] Spotify の演奏者・アルバムと、計画の指揮者・オーケストラ
   * @returns {Promise<string>} セリフ（書けなければ決まった一言）
   */
  async _generateComment(plan, actualTrackName = null, performerInfo = null) {
    const config = this.getConfig();
    const personalityCfg = config.agents?.classic_personality || {};

    const systemPrompt = this._applyMaxChars(
      personalityCfg.prompt || 'あなたはクラシック音楽番組のパーソナリティです。',
      'classic_personality'
    );

    // 演奏者は、Spotify の実際の値と、ディレクターが勧めた指揮者・オーケストラを合わせて渡す
    const performerLines = [];
    if (performerInfo) {
      if (performerInfo.spotifyArtists?.length > 0)
        performerLines.push(`演奏者（Spotify）: ${performerInfo.spotifyArtists.join(' / ')}`);
      if (performerInfo.spotifyAlbum)
        performerLines.push(`アルバム名: ${performerInfo.spotifyAlbum}`);
      if (performerInfo.conductor)
        performerLines.push(`指揮者: ${performerInfo.conductor}`);
      if (performerInfo.ensemble)
        performerLines.push(`オーケストラ: ${performerInfo.ensemble}`);
    }
    const performerSection = performerLines.length > 0
      ? '\n' + performerLines.join('\n')
      : '';

    const userPrompt = `先ほどの楽曲についてのコメントを作ってください。

【楽曲情報】
作曲家: ${plan.composer}
曲名: ${plan.composition || actualTrackName}
時代: ${plan.period}${performerSection}

楽曲を聴き終わった余韻の中で、2〜3文のコメントをしてください。
演奏者・指揮者の情報がある場合は、その解釈の特徴や印象についても一言添えてください。
聴後の感想、演奏の特徴、作曲家の意図など、視点を絞って語ってください。
ラジオで読み上げる日本語テキストのみを出力してください。
${this._geminiInlineTagGuidanceJa()}${this._getAgentDiarySelfDigest('classic_personality')}`;

    const text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'classic_personality');
    return text || `素晴らしい演奏でした。しばし余韻に浸りましょう。`;
  }

  // ─── ショーループフック ─────────────────────────────────────────

  /**
   * ディレクターのエージェントキー。
   * @returns {string} classic_director
   */
  get _directorAgentKey() { return 'classic_director'; }

  /**
   * リスナーのリクエスト曲から、曲の計画を作る。
   *
   * 引数 req: リクエスト（composer・composition・trackName など）
   * @returns {Record<string, any>} 曲の計画
   */
  _buildRequestPlan(req) {
    return {
      composer:      req.composer,
      composition:   req.composition,
      period:        req.period || '',
      spotify_query: req.trackName || `${req.composition} ${req.composer}`,
      key_points:    'リスナーのリクエスト曲です。',
      background:    '',
      isReplay:      true,
    };
  }

  /**
   * ログに出す曲の名前。
   *
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {string} 作曲家「曲名」
   */
  _getPlanLabel(plan) { return `${plan.composer}「${plan.composition}」`; }

  /**
   * Spotify で見つけた曲から、演奏者の情報を組み立てる。
   *
   * 引数 spotifyTrack: Spotify の曲
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {any} 演奏者・アルバム・指揮者・オーケストラ
   */
  _buildSpotifyPerformerInfo(spotifyTrack, plan) {
    const spotifyArtists = this._extractSpotifyArtistNames(spotifyTrack);
    const spotifyAlbum   = spotifyTrack.album?.name || '';
    return { spotifyArtists, spotifyAlbum, conductor: plan.conductor || '', ensemble: plan.ensemble || '' };
  }

  /**
   * Spotify で見つからなかった曲の履歴（次から選ばせないための記録）。
   *
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {any} 履歴の1件
   */
  _buildSpotifyFailedEntry(plan) {
    return {
      composer: plan.composer, composition: plan.composition,
      trackName: null, playedAt: new Date().toISOString(), spotifyFailed: true,
    };
  }

  /**
   * 先読みした紹介が、この曲のものか。
   *
   * 引数 cached: 先読みした紹介
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {boolean} 作曲家と曲名が同じなら true
   */
  _checkIntroCacheHit(cached, plan) {
    return cached.composer === plan.composer && cached.composition === plan.composition;
  }

  /**
   * 画面に出すアーティスト名（演奏者 → 指揮者 → 作曲家の順で、あるものを使う）。
   *
   * 引数 performerInfo: 演奏者の情報
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {string} アーティスト名
   */
  _getDisplayArtist(performerInfo, plan) {
    return performerInfo.spotifyArtists[0] || plan.conductor || plan.composer;
  }

  /**
   * 流した曲の履歴の1件を作る。
   *
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * 引数 spotifyTrack: Spotify の曲
   * 引数 performerInfo: 演奏者の情報
   * @returns {any} 履歴の1件
   */
  _buildPlayedEntry(plan, spotifyTrack, performerInfo) {
    return {
      composer:      plan.composer,
      composition:   plan.composition,
      period:        plan.period || '',
      spotify_query: plan.spotify_query || '',
      trackName:     spotifyTrack.name,
      performers:    performerInfo.spotifyArtists,
      albumName:     performerInfo.spotifyAlbum,
      conductor:     plan.conductor || '',
      ensemble:      plan.ensemble  || '',
      playedAt:      new Date().toISOString(),
    };
  }

  /**
   * 画面に出す、今の曲の名前。
   *
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {string} 作曲家「曲名」
   */
  _getCornerStartName(plan) { return `${plan.composer}「${plan.composition}」`; }

  /**
   * 続けて同じにしないための鍵（作曲家）。
   *
   * 引数 plan: 曲の計画（composer・composition・conductor・ensemble など）
   * @returns {string} 作曲家
   */
  _getRecentKey(plan) { return plan.composer; }

  /**
   * 設定に番組名が無いときの番組名。
   * @returns {string} 番組名
   */
  _getDefaultProgramName() { return '静寂のスコア'; }

  // ─── ディレクション受信（管理画面から） ──────────────────────────

  /**
   * 管理人やリクエストの文から取り出した曲の情報を、曲の計画の形にする。
   *
   * 引数 info: 取り出した情報（composer・composition・artist・title など）
   * @returns {Record<string, any>} 曲の計画
   */
  _buildExtractedRequestTrack(info) {
    return {
      composer:      info.composer      || info.artist,
      composition:   info.composition   || info.title,
      period:        info.period        || '',
      spotify_query: info.spotify_query || `${info.composition || info.title} ${info.composer || info.artist}`,
      key_points:    'リスナーのリクエスト曲です。',
      background:    '',
      isReplay:      true,
    };
  }
}

module.exports = ClassicAgentSystem;
