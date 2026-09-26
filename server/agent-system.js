/**
 * @file Live チャンネルの番組進行（キャスター・アシスタントと各コーナーの掛け合い）
 *
 * 24時間流れ続ける放送の中核。1回分の進行（runSingleShowStep）が呼ばれるたびに、
 * キューから次のコーナーを取り出し、材料を集め、セリフを生成し、音声にして流す、を繰り返す。
 *
 * コーナーは情報系（天気・交通・ニュース・金融）とゲスト系（コメンテーター・ジャーナリスト・
 * 音楽 DJ・生活アドバイス・ワールドレポート・法律相談・ゲスト論客3人）に分かれ、並び順は
 * ディレクターの編成方針（lib/agent-director-decision.js）とこのファイルのキュー組み立てが決める。
 *
 * 材料は services/ の各サービス（天気・ニュース・金融・経済指標・市場カレンダー）と
 * Google（カレンダー・メール・タスク）・Spotify から集める。会話履歴は
 * server/data/conversation_history.jsonl、長期記憶は long_term_memory.json、
 * コーナーキューは director_queue_state.json、各種の履歴は data/ の個別ファイルへ保存する。
 *
 * Live 以外のチャンネルと共通の低い層の処理は lib/agent-shared-mixin.js から取り込み、
 * 討論コーナーは lib/agent-discussion-corner.js、ディレクターの判断は
 * lib/agent-director-decision.js が持つ。
 *
 * ATTENTION: プロンプト文字列にエージェント名を直書きしないこと。設定で変えられるため、
 *            必ず設定から解決した変数を使う（CLAUDE.md 参照）。
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

const fs = require('fs');
const { writeJsonFile } = require('./lib/atomic-json');
const path = require('path');
const { getLogger } = require('./logger');
const activityDb = require('./activity-db');
const spotifyRateLimit = require('./spotify-rate-limit');
const sfxLibrary = require('./sfx-library');
const { generateText, generateImage, imagePart } = require('./lib/llm-client');
const { resolveModel } = require('./lib/llm-models');
const { applySharedAgentMethods } = require('./lib/agent-shared-mixin');
const NewsService = require('./services/news-service');
const MediaCompareService = require('./services/media-compare-service');
const { buildEditorialCompareBlock } = require('./lib/editorial-compare');
const { buildStandingDataSheet } = require('./lib/standing-data-sheet');
// 天気コーナーで「明日の予定に合わせた助言」を出すために使う。
// ATTENTION: このファイルは独自に認証を叩く経路も持つが、カレンダーの範囲指定は
//            このサービス側にしかないため、そちらを使うこと。
const GoogleService = require('./services/google-service');
const googleService = new GoogleService();
const FinanceService = require('./services/finance-service');
const WeatherService = require('./services/weather-service');
const EconomicService = require('./services/economic-service');
const marketCalendar = require('./services/market-calendar');
const spotifyService = require('./services/spotify-service');
const agentDiary = require('./lib/agent-diary');
const listenerRequests = require('./lib/listener-requests');
// 秘書の自律ループが検知した変化点（メール・カレンダー・天気・ニュース・金融）を、
// コメンテーター・ジャーナリストへの話題の橋渡しに使う。
const { getRecentLiveSignals } = require('./lib/secretary-loop');
const { estimatePersonalHoldingsDailyChange, formatPersonalHoldingsChangeForPrompt } = require('./lib/personal-holdings-value');
const { directorDecisionMethods } = require('./lib/agent-director-decision');
const { discussionCornerMethods } = require('./lib/agent-discussion-corner');
// 討論番組側に設定された各出演者の「裏の顔」を、Live のコーナーでも話題と重なるときだけ
// 一言覗かせる（lib/hidden-talent-profiles.js 参照）。
const { buildAgentKnowledgePack, recordAgentNote, hasNotesStore } = require('./lib/agent-knowledge-pack');
const knowledgeLedger = require('./lib/agent-knowledge-ledger');
const topical = require('./lib/topical-materials');
const listenerContext = require('./lib/listener-context');
// ゲスト論客3人（お笑い芸人・医師・マーケター）。継続観測のメモは1つの作り方から3人分を
// 生やしてある（lib/guest-agent-notes.js）。コーナーの文面は lib/guest-analyst-corner.js。
const {
  GUEST_ANALYST_KEYS, getGuestAnalystDef,
  buildGuestAnalystPhase1Context, buildGuestAnalystCornerBody,
} = require('./lib/guest-analyst-corner');
const { fetchWeatherChartBuffer } = require('./routes/weather-satellite-routes');

// 効果音の使用を許可するエージェントキー。スタジオに同席する設定の出演者だけで、
// オープニングの出演者紹介もこの顔ぶれを使う。
// ATTENTION: 天気・交通・報道・金融の各センターは「リモートで繋がっています」、
//            ワールドレポートはリモート特派員という設定のため対象外。スタジオの効果音ボードを
//            鳴らすのは不自然になる。
const SFX_ELIGIBLE_AGENT_KEYS = new Set([
  'caster', 'assistant', 'commentator', 'journalist', 'music_dj', 'life_advisor', 'legal_advisor',
  // ゲスト論客3人もスタジオに同席する設定のため対象に含める。
  'comedian', 'doctor', 'marketer',
]);

// 再生済みトラック履歴の永続化ファイル
const PLAYED_TRACKS_PATH = path.join(__dirname, 'data', 'played_tracks.json');
const PLAYED_TRACKS_MAX  = 200; // 再生履歴保存上限（曲数）— 多めに持つことで長時間運用でも重複を防ぐ
const PLAYED_ARTISTS_MAX = 6;   // 直近アーティスト禁止リスト上限
const PLAYED_TRACKS_HOURS = 48; // 音楽DJの禁止リストに渡す時間窓（時間）— この時間内の曲は繰り返し禁止

// 生活アドバイスの紹介済みトピック履歴の永続化ファイル
const LA_HISTORY_PATH = path.join(__dirname, 'data', 'life_advisor_history.json');
const LA_HISTORY_MAX  = 30; // 30件 ≈ 1ヶ月分

// 生活アドバイスのテーマ一覧（順番に回すために使う）。
// ATTENTION: 「料理・レシピ」を最後に置くことで、他のテーマが先に選ばれやすくしている。
const LA_THEME_CATEGORIES = [
  { key: 'health',  label: '健康・養生',     icon: '💪', desc: '季節の健康管理・体のケア・養生法・ストレッチ・睡眠改善など' },
  { key: 'home',    label: '生活の知恵',     icon: '🧹', desc: '掃除・整理整頓・収納・DIY・節約テクニック・道具活用など' },
  { key: 'season',  label: '季節の暮らし',   icon: '🌸', desc: '季節ならではの過ごし方・行事・風物詩・室内インテリアなど' },
  { key: 'food',    label: '食材・栄養',     icon: '🥗', desc: '旬の食材・栄養バランス・食事術・スーパーフード・腸活など' },
  { key: 'drinks',  label: '晩酌・おつまみ', icon: '🍺', desc: '晩酌に合うおつまみ・お酒のペアリング・ノンアルドリンクなど' },
  { key: 'money',   label: '節税・お金',     icon: '💰', desc: '節税・投資・補助金・行政サービス・家計管理・節約術など' },
  { key: 'event',   label: '地域イベント',   icon: '🎡', desc: '地域のお祭り・季節のイベント・観光スポット・旬の体験など' },
  { key: 'hobby',   label: '趣味・レジャー', icon: '🎸', desc: '趣味関連のイベント・グッズ・コミュニティ・体験レポートなど' },
  { key: 'recipe',  label: '料理・レシピ',   icon: '🍳', desc: '旬の食材を使ったレシピ・料理のコツ・時短料理・保存食など' },
];

// ワールドレポートの訪問済み都市履歴の永続化ファイル
const WR_CITIES_PATH = path.join(__dirname, 'data', 'world_report_cities.json');
const WR_CITIES_MAX  = 20; // 直近20件を記憶（同じ国を長期間避けるため多めに保持）

// ATTENTION: セリフ生成の安全設定は llm-client の緩めの組み合わせを使う。既定のままだと、
//            気象庁の警報（台風・強風・高波など）やニュースといった既に公開されている事実への
//            コメント生成まで誤ってブロックされる。有害な内容を求めているわけではなく、
//            本当に深刻な内容は緩めた後も引き続きブロックされる。
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

// エージェントごとのステレオの定位（設定に項目が無い場合の既定値）。
// -1.0 = 完全に左 / 0.0 = 中央 / +1.0 = 完全に右。
const AGENT_PAN_DEFAULTS = {
  caster:    -0.2,  // キャスター: 少し左
  assistant:  0.2,  // アシスタント: 少し右
};

// コーナーの種別。複数箇所から参照するため定数にしてある。
// ATTENTION: コーナーを増やすときはここだけ更新すればよい。
// 情報系は定型のコーナーなので先読みしてよい。
const INFO_CORNERS = ['weather', 'traffic', 'news', 'finance'];
// ゲスト系は、進行役の質問を受けてから生成する会話の応答型（先読み不要）。
// ゲスト論客3人も自分のコーナーを持ち、進行は既存の2段構えと同じ。
const GUEST_CORNERS = ['commentator', 'journalist', 'music_dj', 'life_advisor', 'world_report', 'legal_advisor',
  ...GUEST_ANALYST_KEYS];
// 全コーナー（music_dj本体の楽曲再生コーナー 'music' を含む）
const ALL_CORNERS = [...INFO_CORNERS, ...GUEST_CORNERS, 'music'];

// ─────────────────────────────────────────────
// 会話履歴ログ設定
// ─────────────────────────────────────────────
const CONV_HISTORY_PATH     = path.join(__dirname, 'data', 'conversation_history.jsonl');
const CONV_HISTORY_MAX_LINES = 2000; // これを超えたらローテート
const CONV_HISTORY_MAX_GENS  = 3;    // 保持世代数（.1 / .2 / .3）

// ─────────────────────────────────────────────
// 長期記憶設定
// ─────────────────────────────────────────────
const LONG_TERM_MEMORY_PATH    = path.join(__dirname, 'data', 'long_term_memory.json');
// ディレクターの編成キューをプロセスをまたいで保持するファイル。
// ATTENTION: 長期記憶のファイルへ相乗りさせないこと。あちらは会話の要約から不定期に
//            読んで書き直すのに対し、こちらはコーナーを1つ消化するたび（数分おき）に書くため、
//            同じファイルを共有すると読み書きが競合して、どちらかの更新を取りこぼす。
const DIRECTOR_QUEUE_STATE_PATH = path.join(__dirname, 'data', 'director_queue_state.json');
const LONG_TERM_MEMORY_TTL_MS  = 14 * 24 * 60 * 60 * 1000; // 2週間（件数でなく時間で管理）
const LONG_TERM_MEMORY_MIN_ENTRIES = 5;   // これ未満の新規エントリはスキップ
const OPENING_MIN_PLAY_MS = 15000; // オープニング曲の最低再生時間（Classic/Jazz/Mood/Beatlesと同じ基準）


class AgentSystem {
  /**
   * Live チャンネルの進行役を作る。
   *
   * @param {any} mixer 音声ミキサー
   * @param {any} serverInstance 配信に使うサーバー
   */
  constructor(mixer, serverInstance) {
    this.mixer = mixer;
    this.server = serverInstance;
    // チャンネル識別子。共有ミックスイン（lib/agent-shared-mixin.js）へ寄せた
    // メソッドがログ接頭辞 `[${this._channelId} ...]` として参照する。ChannelAgentBase
    // 系は super 経由で 'Classic'/'Jazz' 等を受け取るが、Live は独立クラスのため直接設定。
    this._channelId = 'Live';
    this.configPath = path.join(__dirname, 'data', 'config.json');
    this.credentialsPath = path.join(__dirname, 'data', 'credentials.json');
    this.ttsDictPath = path.join(__dirname, 'data', 'tts_dict.json');

    this.showTimer = null;
    this.isLoopRunning = false;
    this.heartbeatInterval = null;

    // 進行ステータス
    this.currentState = 'IDLE'; // IDLE, TALKING_*, MUSIC, INTERRUPTED
    this.currentTokenHolder = 'director'; // 現在発言権を持っているエージェント
    this.currentMode = 'normal'; // normal / midnight / quiet

    // 稼働レポート用セッション ID（onClientConnected で openSession、onClientDisconnected で closeSession）
    this._activitySessionId = null;

    // 直前の発言を記録（会話キャッチボール用）
    this.lastSpeech = {}; // { caster: '...', assistant: '...', ... }
    // キャスター↔アシスタントの会話ターン数（0=初回、1=アシスタント返答済み）
    this.conversationTurn = 0;
    // アシスタント が今サイクルで何回返答したか（会話の長さ制御に使用）
    this._chatTurnCount = 0;
    // コーナー後のキャスターとゲストの短い交換の状態管理
    // null | { corner: string, phase: 'max_react' | 'guest_reply' }
    this._postCornerExchange = null;
    // 討論コーナー（lib/agent-discussion-corner.js）の進行状態。null = 開催していない。
    this._discussionCorner = null;
    this._pendingDiscussion = null;   // 読み上げ中に準備した討論コーナー（まだ起動していないもの）

    // リスナーからのコーナーリクエスト（最大3件のキュー）
    this.pendingCornerRequests = [];
    // _nextCorner がリクエスト由来かどうかのフラグ
    // true  = pendingCornerRequests からシフトして設定（優先度高 — fallback インターセプトで上書き禁止）
    // false = _selectNextCorner() による通常スケジューリング（fallback インターセプトで上書き可）
    this._nextCornerFromRequest = false;

    // リスナーからの曲リクエスト（music_dj ルーティング時のみ使用）
    // { text: string, artist: string|null, song: string|null }
    this.pendingMusicRequest = null;

    // リスナーからのニューストピックリクエスト（news ルーティング時のみ使用）
    // { rawText: string } または null
    this.pendingNewsRequest = null;

    // リスナーからの天気場所リクエスト（weather ルーティング時のみ使用）
    // { location: string, rawText: string } または null
    this.pendingWeatherRequest = null;

    // リスナーからの金融トピックリクエスト（finance ルーティング時のみ使用）
    // { rawText: string, topic: string|null } または null
    // topic: 銘柄名・テーマ（「トヨタ」「ドル円」など）、汎用リクエストなら null
    this.pendingFinanceRequest = null;

    // リスナーからの交通情報行き先リクエスト（traffic ルーティング時のみ使用）
    // { rawText: string, destination: string|null, via: string|null } または null
    // destination: 「渋谷」「横浜」などの行き先、via: 「東名高速」などの経由地・路線名
    this.pendingTrafficRequest = null;

    // リスナーからのコメンテータートピックリクエスト（commentator ルーティング時のみ使用）
    // { rawText: string, topic: string|null } または null
    // topic: 解説テーマ（「トヨタの関税問題」「日米金利差」など）、汎用リクエストなら null
    this.pendingCommentatorRequest = null;

    // リスナーからのジャーナリストXトピックリクエスト（journalist ルーティング時のみ使用）
    // { rawText: string, topic: string|null } または null
    this.pendingJournalistRequest = null;

    // リスナーからの生活アドバイザー（生活アドバイザー）トピックリクエスト（life_advisor ルーティング時のみ使用）
    // { rawText: string, topic: string|null } または null
    this.pendingLifeAdvisorRequest = null;

    // リスナーからの法律相談リクエスト（legal_advisor ルーティング時のみ使用）
    // { rawText: string, topic: string|null } または null
    this.pendingLegalAdvisorRequest = null;

    // リスナーからのゲスト論客3人（お笑い芸人・医師・マーケター）へのトピックリクエスト。
    // 形は他コーナーと同じ { rawText, topic } で、コーナーキーで引けるように1つにまとめる
    // （3人それぞれに専用フィールドを作ると、以降の分岐が3倍に増えるため）。
    this.pendingGuestAnalystRequests = { comedian: null, doctor: null, marketer: null };

    this.googleCache = { calendar: '', gmail: '', tasks: '', lastFetch: 0 };

    // クライアント未接続時の待機フラグ（true 中は Gemini を呼ばない）
    this._waitingForClients = false;

    // 切断後の長期記憶保存中フラグ（この間の新規接続は待機させる）
    this._isShuttingDown = false;

    // speakText 中断用世代カウンタ。切断時にインクリメントされ、古い speakText は break する
    this._speakGeneration = 0;

    // 1回分の進行が二重に走らないためのガード。true の間は新しい呼び出しを即座に無視する。
    this._stepInProgress = false;

    // パイプライン先読み: 現在の発話中に次エージェントのセリフを先行生成しておく
    // { key: string, promise: Promise<string> } | null
    this._prefetchedSpeech = null;

    // 2ターン先読み: コーナーセリフを アシスタントの発話時間中から並行生成する
    // { key: string, promise: Promise<string> } | null
    this._prefetchedCornerSpeech = null;

    // コーナー音声キャッシュ: 15分以内の同一コーナーは即時返却（Google Search 待ち時間ゼロ）
    // { [cornerKey]: { text: string, fetchedAt: number } }
    this._cornerSpeechCache = {};

    // コーナーデータ 20分キャッシュ（交通）。天気は services/weather-service.js へ分離
    // （参照側は this.weatherService.cache を読む）。
    this.weatherService = new WeatherService();
    this.trafficCache = { data: null, lastFetch: 0 };
    // ニュースは services/news-service.js へ分離（キャッシュはサービスが保持。参照側は
    // this.newsService.cache を読む）。取得ロジックは fetchNewsData ラッパー経由で呼ぶ。
    this.newsService  = new NewsService();
    // 同一ニュースの各社読み比べは services/media-compare-service.js へ分離（30分キャッシュ）。
    // 報道センターとコメンテーターの2コーナーが同じキャッシュを共有する。
    this.mediaCompareService = new MediaCompareService();
    // 金融情報は services/finance-service.js へ分離（10分キャッシュ。参照側は
    // this.financeService.cache を読む）。
    this.financeService = new FinanceService();
    // 経済指標は services/economic-service.js へ分離（月次キャッシュ＋日次キャッシュを内包）。
    this.economicService = new EconomicService();
    // 市場の開閉・日本の祝日は services/market-calendar.js へ集約してある。
    // 祝日の判定はプロセス内で共有する（キャッシュを二重に持たないため）。
    // ATTENTION: コーナーキューの補充は同期・即時応答が必須のため、判定は必ずキャッシュを
    //            読むだけにすること（取得そのものは裏で走らせる）。
    this.marketCalendar = marketCalendar;
    this.holidayService = marketCalendar.holidayService;
    this.holidayService.refresh().catch(() => {}); // 起動時に先読みしておく（fire-and-forget）

    // 直前に再生されたコーナーキー（コーナー選択の文脈判断に使用）
    // null=初回 / 'weather'|'traffic'|'news'|'finance'|'commentator'
    this._lastCorner = null;
    this._recentCorners = []; // 直近3コーナー履歴（連続出演防止に使用）
    this._worldReportCity = null;       // ワールドレポートで選ばれた都市（Phase1/Phase2で共有）
    this._savedCasterTurn0 = null;      // max_react フェーズで上書きされる caster_turn0 の退避先
    // _recentWorldReportCities は下部の _loadWorldReportCities() でロード・初期化する

    // 直近で扱った話題（MCの質問文）を最大3件保持。
    // 同じ話題への質問繰り返しを防ぐためMCのコンテキストに渡す。
    this._recentTopics = [];

    // 各コーナーが実際に喋った内容。話題を引き継ぐために使う。
    // ATTENTION: 直近の話題（_recentTopics）とは別物。あちらは進行役の質問文を「繰り返しを
    //            避ける」ためだけに使うが、こちらは実際の発言を「話題を続ける」ために使う。
    this._recentCornerContent = [];

    // コーナーキュー: 事前定義テンプレートに基づく20分サイクル
    // 空になったら _refillCornerQueue() で補充する
    this._cornerQueue = [];

    // ディレクターによる次サイクルの編成方針（先読み済みのものがあれば使う。無ければ
    // _refillCornerQueue() が即座にアルゴリズムのフォールバックを使う。詳細は該当メソッド参照）
    this._prefetchedDirectorDecision = null;
    // 直近でコーナーキューを組み立てた show-day（「本日最初のサイクルか」の判定に使用）
    this._lastDirectorPlanShowDay = null;
    // セッション終了時サマリー日記（_writeDirectorSessionSummaryDiary）用: 直近の編成方針と、
    // 今セッションで実際に流れたコーナーのログ
    this._lastAppliedDirectorDecision = null;
    this._directorCornersThisSession = [];

    // 番組開幕フラグ: 最初のキャスターターンでスタジオメンバー紹介を行う
    this._openingDone = false;

    // アシスタント のオープニング返答（一回だけ）に日記を書かせるためのワンショットフラグ
    this._pendingOpeningDiaryForAssistant = false;

    // キャスター・アシスタントのセッション単位の日記バッファ（オープニング分を貯め、セッション終了時にまとめて1回書く）
    this._maxClaraDiaryBuffer = { caster: [], assistant: [] };

    // 天気コーナー放送済みフラグ: false の間はキャスター等に天気データを渡さない
    this._weatherCornerDone = false;

    // メール重複読み上げ防止: 今回の番組セッションで読み上げ済みのメールID
    this._announcedEmailIds = new Set();
    // 番組開始時刻（Gmailフィルタの基準: この時刻以降に届いたメールのみ対象）
    this._showStartTime = Date.now();

    // Spotify アクセストークンキャッシュ（有効期限内は再取得しない）
    this._spotifyTokenCache  = null; // { token: string, expiresAt: number }
    // Web Playback SDK 再生完了待機
    this._spotifyPlayResolve = null;
    this._spotifyPlayTimer   = null;
    // 再生済みトラック履歴（永続化: played_tracks.json / 最大50件）
    this._recentlyPlayedTracks = [];  // [{ artist, name, playedAt }]
    // 直近再生アーティスト履歴（永続化: played_tracks.json / 最大6件）
    this._recentlyPlayedArtists = []; // string[]
    // 起動時にファイルからロード
    this._loadPlayedHistory();
    // 生活アドバイスの紹介済みトピック履歴（永続化: life_advisor_history.json / 最大30件）
    this._lifeAdvisorHistory = []; // [{ topic, category?, speech?, introducedAt }]
    this._loadLifeAdvisorHistory();
    // 今回選択したテーマカテゴリーキー（コーナー終了時に history に記録するため一時保持）
    this._laCurrentThemeKey = null;
    // ワールドレポートの訪問済み都市履歴（永続化: world_report_cities.json / 最大20件）
    this._recentWorldReportCities = []; // string[]
    this._loadWorldReportCities();
    // アナウンス済みカレンダーイベント履歴（繰り返し防止）
    // { key: string, lastAnnouncedAt: number, count: number }
    this._announcedEvents = [];

    // ─────────────────────────────────────────────
    // 長期記憶
    // ─────────────────────────────────────────────
    // プロンプト注入用の文字列キャッシュ（startShowLoop で _loadLongTermMemory() によりセット）
    this._longTermContext  = null;
    // セッション開始タイムスタンプ（このtime以降の会話行のみ要約対象にする）
    this._sessionStartTime = null;
  }

  // ─────────────────────────────────────────────
  //  ブロードキャストヘルパー
  // ─────────────────────────────────────────────

  /**
   * 時刻と分類を自動で付けて、接続中の全端末へ配信する。
   *
   * program — 番組情報。全端末が利用できる。
   * system  — 接続維持・状態管理。端末が必要に応じて処理する。
   * debug   — デバッグ・システムの詳細。ブラウザ向けで、端末は無視してよい。
   *
   * @param {any} payload 配信する中身
   */
  _broadcast(payload) {
    const EVENT_CATS = {
      // ── program ──────────────────────────────────
      CAST_LIST:                'program',
      AGENT_SPEAKING:           'program',
      AGENT_SILENT:             'program',
      BGM_START:                'program',
      BGM_STOP:                 'program',
      BGM_END:                  'program',
      CORNER_START:             'program',
      CORNER_QUEUE_UPDATE:      'program',
      NOTIFY:                   'program',
      SHOW_INFO:                'program',
      MUSIC_PLAY_START:         'program',
      MUSIC_PLAY_END:           'program',
      SPOTIFY_PLAY:             'program',
      CORNER_REQUEST_QUEUED:    'program',
      CORNER_REQUEST_DUPLICATE: 'program',
      CORNER_REQUEST_FULL:      'program',
      // ── system ───────────────────────────────────
      HEARTBEAT:                'system',
      // ── debug ────────────────────────────────────
      AGENT_THINKING:           'debug',
      SYSTEM_ERROR:             'debug',
    };
    const cat = EVENT_CATS[payload.event] ?? 'debug';
    this.server.broadcastToClients({ cat, ...payload, ts: Date.now() });

    if (this._activitySessionId) {
      const ev = payload.event;
      if (ev === 'CORNER_START') {
        activityDb.logEvent(this._activitySessionId, 'corner', { metadata: { name: payload.name, ticker_type: payload.ticker?.type } });
      } else if (ev === 'AGENT_SPEAKING') {
        activityDb.logEvent(this._activitySessionId, 'agent_speaking', { agent: payload.agent });
      } else if (ev === 'MUSIC_PLAY_START') {
        activityDb.logEvent(this._activitySessionId, 'song_played', { metadata: { title: payload.title, artist: payload.artist } });
      } else if (ev === 'SYSTEM_ERROR') {
        activityDb.logEvent(this._activitySessionId, 'system_error', { metadata: { code: payload.code } });
      }
    }
  }

  // ─────────────────────────────────────────────
  //  番組情報・モード導出
  // ─────────────────────────────────────────────

  /** 現在時刻から番組スロット名を返す */
  _getProgramInfo() {
    const hour = new Date().getHours();
    if (hour >= 5  && hour < 10) return { slot: 'morning',    name: 'おはようAIラジオ' };
    if (hour >= 10 && hour < 14) return { slot: 'daytime',    name: 'ひるどきAIラジオ' };
    if (hour >= 14 && hour < 18) return { slot: 'afternoon',  name: 'ごごのAIラジオ'   };
    if (hour >= 18 && hour < 23) return { slot: 'evening',    name: 'よるのAIラジオ'   };
    return                              { slot: 'late_night',  name: '深夜AIラジオ'     };
  }

  /**
   * 時刻と config.atmosphere からモードを導出する。
   * 変化があれば MODE イベントをブロードキャストする。
   *
   * 優先順位:
   *   1. atmosphere = '静音'   → quiet（手動固定）
   *   2. それ以外（通常 / デフォルト）→ 時間帯自動切替
   *        0〜4時 → midnight / それ以外 → normal
   */
  _syncMode() {
    const config = this.getConfig();
    const atm    = (config.show && config.show.atmosphere) || '通常';
    let mode;

    if (atm.includes('静音')) {
      mode = 'quiet';
    } else {
      // 通常 = 時間帯自動切替
      const hour = new Date().getHours();
      mode = (hour >= 0 && hour < 5) ? 'midnight' : 'normal';
    }

    if (mode !== this.currentMode) {
      this.currentMode = mode;
      getLogger().info(`[Mode] Changed to: ${mode}`);
    }
  }

  // 履歴ファイルの読み書き（共通）
  //
  // 再生済みの曲・生活アドバイスの紹介済みトピック・ワールドレポートの訪問都市の3組が、
  // 同じ形の try/catch を個別に持っていたためまとめた。取り出し方とログの文言は呼び出し側に委ねる。

  /**
   * JSON の履歴ファイルを読み、呼び出し側の処理でフィールドを取り出す。
   *
   * @param {string} filePath 読み込むファイル
   * @param {string} logTag 警告ログの接頭辞（例: '[PlayedHistory] '。そのまま連結する）
   * @param {(data: any) => void} applyFields 読み込んだ中身からフィールドを取り出す処理
   */
  _loadHistoryJson(filePath, logTag, applyFields) {
    try {
      if (fs.existsSync(filePath)) {
        applyFields(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      }
    } catch (e) {
      getLogger().warn(`${logTag}ロード失敗（初回起動の場合は正常）: ` + e.message);
    }
  }

  /**
   * JSON の履歴ファイルへ書き出す（更新時刻は自動で付ける）。
   *
   * @param {string} filePath 書き出すファイル
   * @param {string} logTag 警告ログの接頭辞
   * @param {() => any} buildData 更新時刻以外のフィールドを組み立てる処理
   * @param {() => void} [onSuccess] 書き出しに成功した後に呼ぶ追加の処理
   */
  _saveHistoryJson(filePath, logTag, buildData, onSuccess) {
    try {
      const data = { updatedAt: new Date().toISOString(), ...buildData() };
      writeJsonFile(filePath, data);
      if (onSuccess) onSuccess();
    } catch (e) {
      getLogger().warn(`${logTag}保存失敗: ` + e.message);
    }
  }

  // ─────────────────────────────────────────────
  //  再生済みトラック履歴 永続化
  // ─────────────────────────────────────────────

  /**
   * 起動時に、再生済みの曲の履歴をファイルから読み込む。
   */
  _loadPlayedHistory() {
    this._loadHistoryJson(PLAYED_TRACKS_PATH, '[PlayedHistory] ', (data) => {
      this._recentlyPlayedTracks  = (data.tracks  || []).slice(0, PLAYED_TRACKS_MAX);
      this._recentlyPlayedArtists = (data.artists || []).slice(0, PLAYED_ARTISTS_MAX);
      getLogger().info(`[PlayedHistory] ロード完了: ${this._recentlyPlayedTracks.length}曲 / アーティスト${this._recentlyPlayedArtists.length}件`);
    });
  }

  /**
   * 曲を流した後に、再生済みの履歴をファイルへ書き出す。
   */
  _savePlayedHistory() {
    this._saveHistoryJson(PLAYED_TRACKS_PATH, '[PlayedHistory] ', () => ({
      tracks:  this._recentlyPlayedTracks.slice(0, PLAYED_TRACKS_MAX),
      artists: this._recentlyPlayedArtists.slice(0, PLAYED_ARTISTS_MAX),
    }));
  }

  // ─────────────────────────────────────────────
  //  生活アドバイスの紹介済みトピック履歴 永続化
  // ─────────────────────────────────────────────

  /**
   * 起動時に、生活アドバイスの紹介済みトピックをファイルから読み込む。
   */
  _loadLifeAdvisorHistory() {
    this._loadHistoryJson(LA_HISTORY_PATH, '[LifeAdvisorHistory] ', (data) => {
      this._lifeAdvisorHistory = (data.history || []).slice(0, LA_HISTORY_MAX);
      getLogger().info(`[LifeAdvisorHistory] ロード完了: ${this._lifeAdvisorHistory.length}件`);
    });
  }

  /**
   * コーナーの終了後に、生活アドバイスの紹介済みトピックをファイルへ書き出す。
   */
  _saveLifeAdvisorHistory() {
    this._saveHistoryJson(LA_HISTORY_PATH, '[LifeAdvisorHistory] ', () => ({
      history: this._lifeAdvisorHistory.slice(0, LA_HISTORY_MAX),
    }));
  }

  /**
   * 起動時に、ワールドレポートの訪問済み都市をファイルから読み込む。
   */
  _loadWorldReportCities() {
    this._loadHistoryJson(WR_CITIES_PATH, '[WorldReport] 訪問済み都市', (data) => {
      this._recentWorldReportCities = (data.cities || []).slice(0, WR_CITIES_MAX);
      getLogger().info(`[WorldReport] 訪問済み都市ロード完了: ${this._recentWorldReportCities.length}件`);
      getLogger().debug(`[WorldReport] 訪問済み都市: [${this._recentWorldReportCities.join(', ')}]`);
    });
  }

  /**
   * レポートの後に、ワールドレポートの訪問済み都市をファイルへ書き出す。
   */
  _saveWorldReportCities() {
    this._saveHistoryJson(WR_CITIES_PATH, '[WorldReport] 訪問済み都市', () => ({
      cities: this._recentWorldReportCities.slice(0, WR_CITIES_MAX),
    }), () => {
      getLogger().debug(`[WorldReport] 訪問済み都市を保存: ${this._recentWorldReportCities.length}件`);
    });
  }

  /**
   * 発話テキストを終了フレーズのところで切り捨てる。
   *
   * BUGFIX: 切らないと、続けて他の出演者のセリフまで生成されたものがそのまま読まれる。
   *
   * @param {string} text 生成されたテキスト
   * @param {string[]} markers 終了の目印（最初に見つかったものを使う）
   * @param {string} agentKey ログに出す識別子
   * @returns {string} 切り捨てた後のテキスト
   */
  _truncateAtEndMarker(text, markers, agentKey = '') {
    for (const marker of markers) {
      const idx = text.indexOf(marker);
      if (idx !== -1) {
        const cut = text.slice(0, idx + marker.length).trimEnd();
        if (text.length > cut.length + 10) {
          getLogger().info(`[${agentKey}] 終了フレーズ以降を切り捨て: ${text.length - cut.length}文字`);
        }
        return cut;
      }
    }
    return text;
  }

  /**
   * 前置き（「少し確認します」）の末尾に付いてしまった、進行役への返しフレーズを取り除く。
   *
   * ATTENTION: プロンプトで禁じていても付くことがあるため、機械的な取り除きを残すこと。
   *
   * @param {string} text 前置きの生成結果
   * @param {string} casterName 進行役の表示名
   * @returns {string} 取り除いた後のテキスト
   */
  _stripHandoffPhrase(text, casterName) {
    return text
      .replace(new RegExp(`[。、,\\s]*${casterName}(?:さん)?[、,]?\\s*どうぞ[。！]?\\s*$`, 'u'), '')
      .replace(/[。、,\s]*どうぞ[。！]?\s*$/u, '')
      .replace(/[。、,\s]*お返し(?:します|致します)[。！]?\s*$/u, '')
      .trim();
  }

  /**
   * 前置き（「少し確認します」）のプロンプトを組み立てる。
   *
   * コメンテーター・ジャーナリスト・法律アドバイザー・生活アドバイザーの4人で使い、
   * コーナーの先読み（キャスターの発話中）と本番の受け渡しの両方から呼ばれる。
   *
   * ATTENTION: 先読みと本番で文面を分けないこと。以前は両方に同じ文面が複製されており、
   *            片方だけ禁止の1行が抜ける・見出しの体裁が違う、といった食い違いが生じていた。
   *
   * @param {string} agentKey 'commentator' | 'journalist' | 'legal_advisor' | 'life_advisor'
   * @param {string} baseContextPrompt 共通の前提
   * @param {string} mcQuestion 進行役の直前の発言
   * @param {string} casterName 進行役の表示名
   * @param {any} an 出演者の表示名をまとめたもの
   * @returns {string} 組み立てたプロンプト
   */
  _buildPhase1PreContext(agentKey, baseContextPrompt, mcQuestion, casterName, an) {
    // ゲスト論客3人は文面を lib/guest-analyst-corner.js に置いてある。
    // 体裁（禁止フレーズ・言い出しの例示）は下の3人と揃えてある。
    if (GUEST_ANALYST_KEYS.includes(agentKey)) {
      return buildGuestAnalystPhase1Context(agentKey, baseContextPrompt, mcQuestion, casterName, an[agentKey]);
    }
    switch (agentKey) {
      case 'commentator':
        return `${baseContextPrompt}
【キャスターからの質問】${mcQuestion || '（質問なし）'}
あなた（${an.commentator}）は上記の質問を受けました。
最新データを確認してから答える旨を、質問内容に軽く触れながら1〜2文で伝えてください。
⚠️【絶対禁止】「${casterName}さん、どうぞ」「どうぞ」「以上です」「お返しします」など、キャスターへの返しフレーズは絶対に入れないこと。これは本コメントの前置きのみです。
毎回違う言い出しで始めてください（「なるほど」「少し確認します」など毎回同じにしないこと）。
例A:「面白い視点ですね。データを少し確認しますのでお待ちください。」
例B:「その件、実は気になっていました。指標を確認させてください。」
例C:「${casterName}さん、良い質問です。数字を整理しますのでしばらく。」
例D:「そこですか。今日のデータが来ていますので、確認します。」
日本語で、ラジオで読み上げるテキストのみを出力してください。`;

      case 'journalist':
        return `${baseContextPrompt}
【キャスターからの質問・テーマ】${mcQuestion || '（なし）'}
あなた（${an.journalist}）は上記のテーマについてコメントを求められました。
情報ソースにアクセスしている旨を謎めいた雰囲気で1〜2文で伝えてください。
⚠️【絶対禁止】「${casterName}さん、どうぞ」「どうぞ」「以上です」「お返しします」など、キャスターへの返しフレーズは絶対に入れないこと。これは本コメントの前置きのみです。
毎回違う言い出しにしてください（毎回同じパターンは不可）。
例A:「…少し確認させてください。ちょっとお待ちを。」
例B:「その件、ちょうど情報が来ていました。確認します。」
例C:「興味深い。私のソースにアクセスしますので少しだけ。」
例D:「…なるほど。関係者に確認を取っています。少々。」
日本語で、ラジオで読み上げるテキストのみを出力してください。`;

      case 'legal_advisor':
        return `${baseContextPrompt}
【キャスターからの質問】${mcQuestion || '（質問なし）'}
あなた（${an.legal_advisor}）は上記の質問を受けました。
判例・条文を確認してから答える旨を、質問内容に軽く触れながら1〜2文で伝えてください。
⚠️【絶対禁止】「${casterName}さん、どうぞ」「どうぞ」「以上です」「お返しします」など、キャスターへの返しフレーズは絶対に入れないこと。これは本コメントの前置きのみです。
毎回違う言い出しで始めてください（「なるほど」「少し確認します」など毎回同じにしないこと）。
例A:「その件、実は判例が複数ありまして。少々確認させてください。」
例B:「なるほど、これは民法の観点から整理が必要ですね。少し確認します。」
例C:「その問題、私が実際に担当した事件に似ていますよ。条文を確認させてください。」
例D:「ふむ、最近の判例で動きがありましたね。少々お待ちください。」
日本語で、ラジオで読み上げるテキストのみを出力してください。`;

      case 'life_advisor':
        return `${baseContextPrompt}
【キャスター${casterName}からのリクエスト】${mcQuestion || ''}
あなた（${an.life_advisor}）はキャスター${casterName}のリクエストを受けました。
最新情報を確認中である旨を元気よく1〜2文で伝えてください。
⚠️【絶対禁止】「${casterName}さん、どうぞ」「どうぞ」「以上です」「お返しします」など、キャスターへの返しフレーズは絶対に入れないこと。これは本コメントの前置きのみです。
東北弁を少し自然に混ぜてください。
毎回違う元気な切り出しで始めてください（毎回同じパターンは禁止）。
例A:「ちょっと待ってけさいよ！今すぐ調べますから！」
例B:「${casterName}！いい質問だべ！最新情報確認しますので少しだけ！」
例C:「来ました来ました！すぐ調べますね〜！」
例D:「あー、その話なら！ちょっと最新情報チェックするの待ってて！」
日本語で、ラジオで読み上げるテキストのみを出力してください。`;

      default:
        return '';
    }
  }

  /**
   * 音楽 DJ が曲を探すときの、Spotify の検索語の一覧を組み立てる。
   *
   * リクエストがあればそれを先頭に置き、続いてお気に入りのアーティスト（直近で流したものは
   * 後ろへ回す）、最後に固定の一覧を混ぜる。先頭の優先分より後ろだけを毎回並べ替える。
   *
   * BUGFIX: リクエストの検索語を先頭に足した後で「お気に入りの件数」分だけ切り落とすと、
   *         リクエスト曲自身の検索語が丸ごと消えてしまう。優先分は必ず残すこと。
   *
   * @param {string[]} favoriteArtists リスナーのお気に入りアーティスト
   * @param {string[]} recentlyPlayedArtists 直近で流したアーティスト（後ろへ回して連続を防ぐ）
   * @param {any} pendingMusicRequest リスナーからの曲リクエスト。無ければ null
   * @returns {string[]} 検索語の一覧
   */
  _buildMusicDjSpotifyQueries(favoriteArtists, recentlyPlayedArtists, pendingMusicRequest) {
    const requestQueries = pendingMusicRequest
      ? (pendingMusicRequest.artist && pendingMusicRequest.song
          ? [`${pendingMusicRequest.artist} ${pendingMusicRequest.song}`, pendingMusicRequest.artist]
          : pendingMusicRequest.artist
            ? [pendingMusicRequest.artist]
            : [pendingMusicRequest.text])
      : [];
    const recentSet = new Set(recentlyPlayedArtists);
    const shuffledFavs = [...favoriteArtists].sort(() => Math.random() - 0.5);
    const shuffledFavsFirst = [
      ...shuffledFavs.filter(a => !recentSet.has(a)),
      ...shuffledFavs.filter(a => recentSet.has(a)),
    ];
    const fixedList = [
      'YOASOBI', 'Ado', 'Official HIGE DANdism',
      'Mrs GREEN APPLE', 'back number', 'King Gnu',
      'BTS', 'NewJeans', 'aespa',
      'The Beatles', 'Queen', 'Ed Sheeran',
      'Taylor Swift', 'Bruno Mars',
      'Creepy Nuts', 'Omoinotake', 'Vaundy',
      'Kenshi Yonezu', 'Hikaru Utada', 'Perfume',
    ];
    const priorityCount = requestQueries.length + shuffledFavsFirst.length;
    const combined = [...requestQueries, ...shuffledFavsFirst, ...fixedList];
    return [
      ...combined.slice(0, priorityCount),
      ...combined.slice(priorityCount).sort(() => Math.random() - 0.5),
    ];
  }

  /**
   * 音楽 DJ の前置き（「少々お待ちください」／リクエストの受領）のプロンプトを組み立てる。
   *
   * ATTENTION: 先読みと本番の受け渡しで文面を分けないこと。分けると、片方だけ返しフレーズの
   *            禁止が抜ける・片方だけ呼びかけ先の注意書きが無い、といった食い違いが生じる。
   *
   * @param {string} baseContextPrompt 共通の前提
   * @param {string} mcQuestion 進行役の直前の発言
   * @param {string} casterName 進行役の表示名
   * @param {any} an 出演者の表示名をまとめたもの
   * @param {any} pendingMusicRequest リスナーからの曲リクエスト。無ければ null
   * @param {string} assistantName アシスタントの表示名（誤って呼びかけないための注意書きに使う）
   * @returns {string} 組み立てたプロンプト
   */
  _buildMusicDjPhase1Context(baseContextPrompt, mcQuestion, casterName, an, pendingMusicRequest, assistantName) {
    if (pendingMusicRequest) {
      return `${baseContextPrompt}
【キャスター${casterName}からのリクエスト】${mcQuestion || ''}
リスナーから「${pendingMusicRequest.text}」のリクエストが届いています。
あなた（${an.music_dj}）はこのリクエストを受け取りました。
リクエスト曲名・アーティスト名への喜びや共感を1〜2文で元気よく伝えてください。
⚠️ チャートや最新情報の確認は不要です。すぐにかけますという雰囲気で。
⚠️ 返答の冒頭は「${casterName}！」「${casterName}さん！」など、${casterName}に向けてください。
毎回違うノリで始めてください（毎回同じ言い出しは禁止）。
例A:「${casterName}！${pendingMusicRequest.artist || 'この曲'}、サイコーのリクエストやん！すぐかけるわ！」
例B:「来たーー！${pendingMusicRequest.song || pendingMusicRequest.text}！もう最高すぎる！」
例C:「${pendingMusicRequest.artist || ''}さんの曲ってほんまエモいんよな。リクエストありがとう！」
日本語で、ラジオで読み上げるテキストのみを出力してください。`;
    }
    return `${baseContextPrompt}
【キャスター${casterName}からのリクエスト】${mcQuestion || ''}
あなた（${an.music_dj}）はキャスター${casterName}のリクエストを受けました。
チャートや最新情報を確認中である旨を元気よく1〜2文で伝えてください。
リクエスト内容に少し触れながら「少々お待ちください」という雰囲気を出してください。
⚠️【絶対禁止】「${casterName}さん、どうぞ」「どうぞ」「以上です」「お返しします」など、キャスターへの返しフレーズは絶対に入れないこと。これは本コメントの前置きのみです。
⚠️ 返答の冒頭は「${casterName}！」「${casterName}さん！」など、${casterName}に向けてください。「${assistantName}さん」とは呼びかけないこと。
毎回違うノリで始めてください（毎回同じ言い出しは禁止）。
例A:「${casterName}！ちょっと待って、今すぐチェックするわ！」
例B:「やばいやばい！今週のチャート見てたんですよ、ちょっと待ってて！」
例C:「来ました来ました！リクエストありがとう、すぐ確認する！」
例D:「その曲ね！わかった、今すぐ調べるから少しだけ待ってて！」
日本語で、ラジオで読み上げるテキストのみを出力してください。`;
  }

  /**
   * 今の放送モードを、プロンプトへ渡す言い回しにする。
   *
   * ATTENTION: _syncMode() を先に呼んでおくこと（currentMode が最新である前提）。
   *
   * @returns {string} モードの説明
   */
  _getEffectiveMoodLabel() {
    switch (this.currentMode) {
      case 'quiet':    return '静音（落ち着いたミニマムな放送）';
      case 'midnight': return '深夜（しっとり落ち着いたアンビエント放送）';
      default:         return '通常（フレンドリーで元気な放送）';
    }
  }

  // ─────────────────────────────────────────────
  //  ハートビート
  // ─────────────────────────────────────────────

  /** 定期ハートビートを開始（デフォルト 30 秒間隔） */
  _startHeartbeat(intervalMs = 30000) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      this._broadcast({ event: 'HEARTBEAT' });
    }, intervalMs);
  }

  // ─────────────────────────────────────────────
  //  設定ファイルの読み込み
  // ─────────────────────────────────────────────

  /**
   * 設定ファイルを読み、足りないエージェントを既定値で補って返す。
   *
   * @returns {any} 補完済みの設定
   */
  getConfig() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      // 保存済みの設定に無い新しいエージェントを既定値で補う
      // （server.js 側の補完と同じ役割を、こちらでも担う）。
      if (stored && stored.agents) {
        const agentDefaults = AgentSystem.AGENT_DEFAULTS;
        for (const [key, def] of Object.entries(agentDefaults)) {
          if (!stored.agents[key]) {
            stored.agents[key] = def;
          }
        }
      }
      return stored;
    } catch (e) {
      return {};
    }
  }

  // getCredentials() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  // ─────────────────────────────────────────────
  //  Google Calendar / Gmail データ取得
  // ─────────────────────────────────────────────

  /**
   * カレンダーの文字列から、既に読み上げた予定を取り除いて返す。
   *
   * 同じ予定を何度も繰り返さないための間引き。ゴミ出し等の日常のリマインドは前日から
   * 2〜3時間おき・最大4回まで、通常の予定は1〜2時間おき・最大3回までを許す。
   *
   * @param {string} calendarStr カレンダーの文字列
   * @returns {string} 間引いた後の文字列
   */
  _filterAnnouncedEvents(calendarStr) {
    if (!calendarStr || calendarStr === '近日中の予定はありません。') return calendarStr;

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const TWO_HOURS = 2 * ONE_HOUR;
    const TWO_DAYS  = 48 * ONE_HOUR;

    // ゴミ出し・日常タスク系キーワード（前日からリマインド、間隔長め）
    const REMINDER_KEYWORDS = ['ゴミ', 'ごみ', '燃えるゴミ', '資源ゴミ', '不燃', '粗大', 'ゴミ出し',
                               '掃除', '洗濯', '薬', '病院', '歯医者', '支払', '締切', '期限'];

    // 2日以上前のエントリは忘れる
    this._announcedEvents = this._announcedEvents.filter(e => now - e.lastAnnouncedAt < TWO_DAYS);

    const lines = calendarStr.split('\n');
    const filtered = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const key = line.trim().slice(0, 80);
      const existing = this._announcedEvents.find(e => e.key === key);
      const isReminder = REMINDER_KEYWORDS.some(kw => line.includes(kw));

      // 最大アナウンス回数・最小間隔の設定
      const maxCount   = isReminder ? 4 : 3;          // リマインダー系は4回、通常は3回まで
      const minInterval = isReminder ? TWO_HOURS : ONE_HOUR; // リマインダー系は2時間、通常は1時間

      if (existing) {
        if (existing.count >= maxCount) {
          getLogger().debug(`[Calendar] アナウンス上限到達: "${key.slice(0,40)}" (${existing.count}回済)`);
          continue;
        }
        if (now - existing.lastAnnouncedAt < minInterval) {
          getLogger().debug(`[Calendar] アナウンス間隔待機中: "${key.slice(0,40)}" (${Math.round((now-existing.lastAnnouncedAt)/60000)}分前に済)`);
          continue;
        }
      }
      filtered.push(line);
    }

    return filtered.length > 0 ? filtered.join('\n') : '近日中の予定はありません。';
  }

  /**
   * 予定を読み上げたことを記録する。プロンプトへ含めた直後に呼ぶ。
   *
   * @param {string} calendarStr プロンプトへ含めたカレンダーの文字列
   */
  _markEventsAnnounced(calendarStr) {
    if (!calendarStr || calendarStr === '近日中の予定はありません。') return;
    const now = Date.now();
    for (const line of calendarStr.split('\n')) {
      const key = line.trim().slice(0, 80);
      if (!key) continue;
      const existing = this._announcedEvents.find(e => e.key === key);
      if (existing) {
        existing.lastAnnouncedAt = now;
        existing.count++;
      } else {
        this._announcedEvents.push({ key, lastAnnouncedAt: now, count: 1 });
      }
    }
  }

  /**
   * Google のデータ（カレンダー・メール・タスク）を取得する。
   *
   * 古い値を返しつつ裏で更新する方式にしてある。5分以内の新しいキャッシュがあれば即返し、
   * 期限切れでも使える値があれば古い値を返しながら裏で更新し、何も無い初回だけ待って取る。
   *
   * ATTENTION: ここで待たせないこと。放送ループの冒頭で3つを順に取ると約5秒止まり、
   *            発話と発話の間に無音が生じる。
   *
   * @returns {Promise<any>} カレンダー・メール・タスクの文字列と取得時刻
   */
  async fetchGoogleData() {
    const now = Date.now();
    const FRESH_MS = 300000; // 5分
    // 新鮮なキャッシュ → 即返し
    if (now - this.googleCache.lastFetch < FRESH_MS && this.googleCache.calendar) {
      return this.googleCache;
    }
    // 期限切れだが利用可能なキャッシュがある → stale を即返しつつ裏で更新（ノンブロッキング）
    if (this.googleCache.calendar && this.googleCache.lastFetch > 0) {
      this._refreshGoogleDataInBackground();
      return this.googleCache;
    }
    // 初回（キャッシュ無し）のみブロックして取得
    await this._refreshGoogleData();
    return this.googleCache;
  }

  /**
   * 裏で Google のデータを更新する（多重起動を防ぎ、失敗は握りつぶす）。
   */
  _refreshGoogleDataInBackground() {
    if (this._googleRefreshing) return;
    this._googleRefreshing = true;
    this._refreshGoogleData()
      .catch(e => getLogger().warn(`[Google] バックグラウンド更新失敗: ${e?.message || e}`))
      .finally(() => { this._googleRefreshing = false; });
  }

  /**
   * 実際に Google の API を叩いてキャッシュを更新する。
   *
   * 完了まで待つ。呼び出し側が待つか裏で走らせるかを選ぶ。
   *
   * @returns {Promise<any>} 更新後のキャッシュ
   */
  async _refreshGoogleData() {
    const now = Date.now();

    const creds = this.getCredentials();
    if (!creds.google || !creds.google.refresh_token || !creds.google.client_id) {
      getLogger().warn('[Google] API credentials not configured. Using dummy schedule/email.');
      this.googleCache = {
        calendar: '14:00 - AI開発の定例会議 (重要な進捗報告あり)\n19:00 - 友人との誕生日ディナー (渋谷)',
        gmail: '件名: [重要] AI Radioプロジェクトのロードマップについて\n件名: お誕生日おめでとうございます！特別なクーポンをお届けします。',
        tasks: '・企画書のレビューを送る（期限: 今日）\n・歯医者の予約を入れる',
        lastFetch: now
      };
      return this.googleCache;
    }

    try {
      // 1. Refresh OAuth2 Token
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.google.client_id,
          client_secret: creds.google.client_secret,
          refresh_token: creds.google.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const tokens = await tokenResponse.json();
      const accessToken = tokens.access_token;
      if (!accessToken) throw new Error('Failed to retrieve access token');

      // カレンダーは現在時刻以降〜3日後を取る。今日の0時ではなく現在時刻を始まりにすることで、
      // 既に過ぎた予定を除き、これからの予定だけを返す。
      const JST_OFF = 9 * 60 * 60 * 1000;
      const nowJST  = new Date(Date.now() + JST_OFF);
      const todayJSTDateStr = nowJST.toISOString().slice(0, 10); // JST 日付（日付ラベル比較用）
      const todayStart = new Date(todayJSTDateStr + 'T00:00:00+09:00'); // Gmail フィルタ等で引き続き使用
      const calendarRangeEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 現在から3日後
      const calendarParams = new URLSearchParams({
        timeMin:       new Date().toISOString(),  // 現在時刻以降（過去イベントを除外）
        timeMax:       calendarRangeEnd.toISOString(),
        maxResults:    '20',
        singleEvents:  'true',
        orderBy:       'startTime',
      });
      const calendarResponse = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${calendarParams}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const calendarData = await calendarResponse.json();
      getLogger().debug(`[Calendar] API取得: ${calendarData.items?.length ?? 0}件 timeMin=now timeMax=${calendarRangeEnd.toISOString()}`);
      let calendarStr = '近日中の予定はありません。';
      if (calendarData.items && calendarData.items.length > 0) {
        const myEvents = calendarData.items;
        getLogger().debug(`[Calendar] フィルタ後: ${myEvents.length}件`);
        if (myEvents.length > 0) {
          // 曜日名（日本語）
          const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

          calendarStr = myEvents.slice(0, 10).map(item => {
            const start    = item.start.dateTime || item.start.date;
            // JST に変換して年月日・時刻・曜日を取得
            const startJST = new Date(new Date(start).getTime() + JST_OFF);
            const month    = startJST.getUTCMonth() + 1;
            const date     = startJST.getUTCDate();
            const dow      = DOW_JA[startJST.getUTCDay()];
            const timeStr  = item.start.dateTime
              ? `${String(startJST.getUTCHours()).padStart(2,'0')}:${String(startJST.getUTCMinutes()).padStart(2,'0')}`
              : '終日';
            // 「今日」「明日」ではなく絶対日付で表記（深夜帯の感覚ズレを防ぐ）
            const dateLabel = `${month}月${date}日(${dow})`;
            return `[${dateLabel}] ${timeStr} - ${item.summary}`;
          }).join('\n');
          getLogger().debug(`[Calendar] 結果:\n${calendarStr}`);
        }
      }

      // 3. Fetch Gmail Inbox — 今日届いた未読メールに絞る
      // フィルタ戦略:
      //   ① after:{今日の0時Unix秒}  → 今日届いたメールを対象（再起動しても消えない）
      //   ② is:unread               → 未読のみ（スパムも既読なら除外）
      //   ③ -category:spam -in:trash → スパム・ゴミ箱は常に除外
      //   ④ 管理画面の gmail_filter 設定に従い追加フィルタを適用
      //   ⑤ 読み上げ済みIDは再取得しても無視（_announcedEmailIds で管理）
      const _gmailCfg = this.getConfig();  // fetchGoogleData スコープには config がないため都度取得
      const gmailFilterCfg = (_gmailCfg.show && _gmailCfg.show.gmail_filter) || {};
      const gmailMaxFetch    = gmailFilterCfg.max_fetch    || 10;
      const gmailMaxAnnounce = gmailFilterCfg.max_announce || 5;
      const todayStartSec = Math.floor(todayStart.getTime() / 1000);
      const gmailQueryParts = [
        `after:${todayStartSec}`,
        'is:unread',
        '-category:spam',
        '-in:trash',
      ];
      if (gmailFilterCfg.exclude_promotions) gmailQueryParts.push('-category:promotions');
      if (gmailFilterCfg.exclude_social)     gmailQueryParts.push('-category:social');
      if (gmailFilterCfg.exclude_updates)    gmailQueryParts.push('-category:updates');
      if (gmailFilterCfg.exclude_forums)     gmailQueryParts.push('-category:forums');
      const gmailQuery = gmailQueryParts.join(' ');
      let gmailStr = '番組開始以降の新着メールはありません。';
      try {
        const gmailResponse = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQuery)}&maxResults=${gmailMaxFetch}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!gmailResponse.ok) {
          getLogger().warn(`[Google] Gmail API HTTP ${gmailResponse.status} — Gmail API が有効化されているか、スコープを確認してください`);
        } else {
          const gmailData = await gmailResponse.json();
          const totalFound = gmailData.messages?.length ?? 0;
          getLogger().info(`[Google] Gmail: ${totalFound}件ヒット (query: ${gmailQuery})`);
          if (totalFound > 0) {
            // 読み上げ済みを除いた新着のみ処理
            const newMessages = gmailData.messages.filter(m => !this._announcedEmailIds.has(m.id));
            getLogger().info(`[Google] Gmail: うち未読み上げ ${newMessages.length}件`);
            if (newMessages.length > 0) {
              const emailDetails = [];
              for (const msg of newMessages.slice(0, gmailMaxAnnounce)) { // 一度に最大gmailMaxAnnounce件まで紹介
                const detailRes = await fetch(
                  `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
                  { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                const detail = await detailRes.json();
                const headers = detail.payload?.headers || [];
                const subject = headers.find(h => h.name === 'Subject')?.value || '無題';
                const from    = headers.find(h => h.name === 'From')?.value || '';
                // 送信者名のみ抽出（"名前 <email>" → "名前"、なければドメインのみ）
                const fromName = from.replace(/<[^>]+>/, '').trim()
                  || from.replace(/.*@/, '@').replace(/>.*/, '');
                // BUGFIX: 件名と送信者だけを渡すと、本文の手がかりが無いまま「メールを紹介して」と
                //         指示することになり、実在しない内容を創作してしまう。本文の冒頭のプレビューも
                //         渡して、実際に書かれている内容を材料にできるようにする。
                const snippet = (detail.snippet || '').trim();
                emailDetails.push(
                  `件名: ${subject}${fromName ? `（${fromName}より）` : ''}`
                  + (snippet ? `\n概要: ${snippet}` : '')
                );
                this._announcedEmailIds.add(msg.id); // 読み上げ済みとして記録
              }
              gmailStr = emailDetails.join('\n\n'); // 概要行を追加した分、メール間を空行で区切り読みやすくする
              const remaining = newMessages.length - Math.min(newMessages.length, gmailMaxAnnounce);
              if (remaining > 0) gmailStr += `\n（他${remaining}件 — 次回以降に紹介）`;
              getLogger().info(`[Google] Gmail: 読み上げ内容セット完了`);
            }
          }
        }
      } catch (ge) {
        getLogger().warn(`[Google] Gmail fetch 失敗: ${ge.message}`);
      }

      // 4. Fetch Google Tasks — 未完了タスク（期限なし or 今日以降）
      let tasksStr = '未完了のTODOはありません。';
      try {
        const todayStartISO = todayStart.toISOString();
        const tasksResponse = await fetch(
          `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks` +
          `?showCompleted=false&showHidden=false&maxResults=20`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (tasksResponse.ok) {
          const tasksData = await tasksResponse.json();
          const items = (tasksData.items || []).filter(t => t.status !== 'completed');
          // 期限なし or 期限が今日以降のものを抽出（過去の期限切れタスクは除外）
          const due = items.filter(t => {
            if (!t.due) return true; // 期限なしは常に表示
            return t.due >= todayStartISO; // 今日以降のみ
          });
          if (due.length > 0) {
            tasksStr = due.map(t => {
              const dueLabel = t.due
                ? `（期限: ${new Date(t.due).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}）`
                : '';
              return `・${t.title}${dueLabel}`;
            }).join('\n');
          }
          getLogger().info(`[Google] Tasks: ${due.length}件取得`);
        } else {
          getLogger().warn(`[Google] Tasks API HTTP ${tasksResponse.status} — Tasks API が有効化されているか確認してください`);
        }
      } catch (te) {
        getLogger().warn(`[Google] Tasks fetch 失敗: ${te.message}`);
      }

      this.googleCache = { calendar: calendarStr, gmail: gmailStr, tasks: tasksStr, lastFetch: now };
      // 他の出演の場（討論・秘書経由の相談など）からも予定を読めるよう、取得に成功したときだけ
      // 共有の置き場所へ載せる。ダミーやエラー時の代わりの文言は載せない。
      // ATTENTION: メールは載せない。公開範囲はキャスター・アシスタントのみに留める。
      listenerContext.publishSchedule({ calendar: calendarStr, tasks: tasksStr });
    } catch (e) {
      getLogger().error(`Error fetching Google data: ${e?.message || e}`);
      // ATTENTION: 使えるキャッシュがあれば維持し、古い値を配信し続けること。裏での更新の失敗で、
      //            せっかくの実データがエラーの代わりの文言に置き換わるのを防ぐ。
      //            何も無い初回のときだけ、エラーの代わりの文言を入れる。
      const _hasUsableCache = this.googleCache.calendar && this.googleCache.lastFetch > 0;
      if (!_hasUsableCache) {
        this.googleCache = {
          calendar: '予定データ取得エラー (ローカルモックを使用)',
          gmail: 'メールデータ取得エラー (ローカルモックを使用)',
          tasks: 'TODOデータ取得エラー',
          lastFetch: 0  // エラー時はキャッシュしない → 次回すぐ再試行
        };
      }
    }

    return this.googleCache;
  }

  // ─────────────────────────────────────────────
  //  OpenWeatherMap 天気データ取得
  // ─────────────────────────────────────────────

  /**
   * 天気を取る。取得そのものは services/weather-service.js にあり、
   * ここでは実際の地点の解決だけを行って委ねる。
   *
   * @param {string|null} overrideLocation 地点の指定。無ければ設定の地点を使う
   * @returns {Promise<any>} 天気のデータ
   */
  async fetchWeatherData(overrideLocation = null) {
    const creds = this.getCredentials();
    const { location: defaultLocation, isTempStay } = this._getEffectiveLocation();
    return this.weatherService.fetch({
      overrideLocation,
      defaultLocation,
      isTempStay,
      apiKey: creds.openweathermap && creds.openweathermap.api_key,
      prefCode: (this.getConfig().show?.user_profile?.pref_code) || '130000',
    });
  }

  // ─────────────────────────────────────────────
  //  Yahoo Japan ニュース RSS 取得
  // ─────────────────────────────────────────────

  /**
   * ニュースを取る。取得そのものは services/news-service.js にある。
   *
   * @returns {Promise<any>} ニュースのデータ
   */
  async fetchNewsData() {
    return this.newsService.fetch();
  }

  // ─────────────────────────────────────────────
  //  金融情報（Yahoo Finance 無料API）
  // ─────────────────────────────────────────────

  /**
   * 金融情報を取る。取得そのものは services/finance-service.js にある。
   *
   * ATTENTION: 海外のマーケットのニュースも併せて取ること。国内の値動きだけだと、
   *            米国の物価統計・中央銀行の決定・要人の発言といった、市場に大きく効く材料が
   *            まるごと抜ける。RSS 2本の追加で実測1秒程度、先読みの窓に十分収まる。
   *
   * @returns {Promise<any>} 金融情報のデータ
   */
  async fetchFinanceData() {
    return this.financeService.fetch(this.getConfig(), { includeGlobalNews: true });
  }

  // 経済指標（公式の一次統計）
  //
  // キャッシュの考え方:
  //   ほとんどのデータは月次・年次の発表で、1日に何度も変わらない。
  //   → 主なキャッシュは日付が変わったら取り直す（最大24時間）
  //   → ただし日次のもの（10年債の利回りなど）は6時間のキャッシュに分ける
  //   → 起動後の初回だけ API を叩き、同じ日の2回目以降はキャッシュを返す

  /**
   * 経済指標を取る。取得そのものは services/economic-service.js にある。
   *
   * @returns {Promise<any>} 経済指標のデータ
   */
  async fetchEconomicIndicators() {
    return this.economicService.fetch(this.getCredentials());
  }


  /**
   * キャッシュ済みのコーナーの材料を、会話のプロンプトに足せる形へまとめる。
   *
   * キャスター・アシスタントが話題として使えるようにするためのもの。
   *
   * @returns {string|null} まとめた文字列。材料が無ければ null
   */
  _getCachedCornerData() {
    const parts = [];
    const ttl = 1200000; // 20分
    if (this._weatherCornerDone && this.weatherService.cache.data && Date.now() - this.weatherService.cache.lastFetch < ttl) {
      parts.push(`・天気: ${this.weatherService.cache.data}`);
    }
    if (this.trafficCache.data && Date.now() - this.trafficCache.lastFetch < ttl) {
      // 交通は長いので先頭1行（サマリー行）だけ渡す
      const summary = this.trafficCache.data.split('\n').slice(0, 2).join(' / ');
      parts.push(`・交通: ${summary}`);
    }
    if (this.newsService.cache.data && Date.now() - this.newsService.cache.lastFetch < ttl) {
      // ニュースは見出しリストだけ（3件まで）
      const lines = this.newsService.cache.data.split('\n').filter(l => /^\d+\./.test(l)).slice(0, 3);
      parts.push(`・最新ニュース: ${lines.join(' / ')}`);
    }
    if (this.financeService.cache.data && Date.now() - this.financeService.cache.lastFetch < ttl) {
      // 金融は先頭2〜3行（取得時刻 + 日経 + ドル円）
      const lines = this.financeService.cache.data.split('\n').filter(l => l.trim()).slice(0, 3);
      parts.push(`・マーケット: ${lines.join(' / ')}`);
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }

  // ─────────────────────────────────────────────
  //  コーナー音声生成（キャッシュ付きラッパー）
  // ─────────────────────────────────────────────

  /**
   * コーナーのセリフを生成して返す。
   *
   * 15分以内に同じコーナーを生成済みならキャッシュを返す（検索の待ち時間がゼロになる）。
   * 交通情報は検索を使うため特に効きが大きい。
   *
   * @param {string} centerKey コーナーキー
   * @param {string} baseContextPrompt 共通の前提
   * @param {any} topicRequest リクエストされた話題。無ければ null
   * @returns {Promise<string>} コーナーのセリフ
   */
  async _generateCornerSpeech(centerKey, baseContextPrompt, topicRequest = null) {
    const CORNER_CACHE_TTL = 15 * 60 * 1000; // 15分
    // トピック指定がある場合はキャッシュをスキップ（新鮮な情報が必要）
    if (!topicRequest) {
      const cached = this._cornerSpeechCache[centerKey];
      if (cached && Date.now() - cached.fetchedAt < CORNER_CACHE_TTL) {
        getLogger().debug(`[Pipeline] コーナーキャッシュヒット: ${centerKey}`);
        return cached.text;
      }
    }
    const ctx  = await this._buildCornerContext(centerKey, baseContextPrompt, null, topicRequest);
    // finance にトピックリクエストがある場合は Google Search を有効化（個別銘柄をリアルタイム検索）
    const _useSearchOverride = (centerKey === 'finance' && topicRequest?.rawText) ? true : null;

    // 天気のコーナーは地上天気図を画像として渡し、気象予報士のような総観的な解説
    // （なぜ今の天気なのか）をさせる。取得は3時間のキャッシュ付きのため通常は即座に返り、
    // 失敗してもテキストだけで続行する（致命的にしない）。
    let _weatherChartImage = null;
    if (centerKey === 'weather') {
      try {
        const { buf } = await fetchWeatherChartBuffer();
        _weatherChartImage = { mimeType: 'image/png', data: buf.toString('base64') };
      } catch (e) {
        getLogger().debug(`[Weather] 天気図の取得に失敗（テキストのみで続行）: ${e.message}`);
      }
    }

    // 空の応答が返ることがある（検索を使うと本文が省かれる場合など）ため、1回だけやり直す。
    let text = '';
    for (let _attempt = 0; _attempt < 2; _attempt++) {
      text = await this.generateAgentSpeech(centerKey, ctx, _useSearchOverride, 'main', _weatherChartImage);
      if (text) break;
      if (_attempt === 0) {
        getLogger().warn(`[${centerKey}] Gemini が空レスポンス → 1回リトライ`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // 継続観測メモの記録は、ここ（生成した時点）ではなく、実際に放送した時点で行う
    // （_recordCornerNote。_pushRecentCornerContent から呼ばれる）。

    // BUGFIX: 応答が空のときの代わりの文言（開発用のデモ）が、そのままキャッシュに載って
    //         以後ずっと再生され続けた。「このプロジェクト自身の話がニュースとして読まれ、
    //         しかも何度やっても同じ」という事故の正体がこれだった。
    //         下のキャッシュの条件と合わせて、代わりの文言は決してキャッシュしないこと。
    let _usedOfflineFallback = false;
    if (!text) {
      _usedOfflineFallback = true;
      getLogger().error(`[${centerKey}] リトライ後も空レスポンス → フォールバック`);
      // ATTENTION: 実データが手元にあるコーナーは、作り話のデモではなく本物の見出しを読む。
      //            放送が止まらないことより「嘘を放送しないこと」を優先する。
      text = this._buildCornerFallbackFromRealData(centerKey) || this.getOfflineMockDialog(centerKey);
    }

    // 終了フレーズ以降も切り捨て
    text = this._truncateAtEndMarker(text, ['スタジオにお返しします', 'スタジオへどうぞ'], centerKey);

    // ATTENTION: 空の結果と代わりの文言はキャッシュしないこと。載せると、一度の失敗が
    //            キャッシュの有効期間のあいだ固定される。
    if (text && !_usedOfflineFallback) this._cornerSpeechCache[centerKey] = { text, fetchedAt: Date.now() };
    return text;
  }

  // ─────────────────────────────────────────────
  //  コーナー選択（コンテキスト適応ロジック）
  // ─────────────────────────────────────────────

  // コーナーの選択・キューの補充は lib/agent-director-decision.js にある。

  /**
   * コーナーが終わったときに呼び、直前のコーナーと直近の履歴を更新する。
   *
   * @param {string} cornerKey 流し終えたコーナーキー
   */
  _recordCornerPlayed(cornerKey) {
    this._lastCorner = cornerKey;
    this._recentCorners = [cornerKey, ...this._recentCorners].slice(0, 4);
    if (cornerKey === 'weather') this._weatherCornerDone = true;
    this._broadcastQueueUpdate();
    // コーナーを1つ消化するたびに保存し、次の接続・再起動でその続きから再開できるようにする。
    // ATTENTION: 保存する場所は「キューから取り出した時」ではなく「実際に流し終えた時」。
    //            取り出しは先読みからも呼ばれるため、取り出しただけで流れないままセッションが
    //            終わることがあり、そこで保存すると流れていないコーナーが消化済みとして失われる。
    this._saveCornerQueueState();
    // ディレクターのセッション終了時サマリー日記の材料（_writeDirectorSessionSummaryDiary 参照）
    this._directorCornersThisSession ??= [];
    this._directorCornersThisSession.push(cornerKey);
  }

  /**
   * 進行状況（今のコーナー・次のコーナー・キュー・直近の履歴）を配信する。
   */
  _broadcastQueueUpdate() {
    this._broadcast({
      event: 'CORNER_QUEUE_UPDATE',
      current:  this.currentTokenHolder || null,
      next:     this._nextCorner        || null,
      queue:    [...this._cornerQueue],
      recent:   [...this._recentCorners],
    });
  }

  // _selectNextCorner() / _refillCornerQueue() / _buildCornerQueueFromDirectorDecision() /
  // _getFallbackDirectorDecision() / _prefetchNextDirectorDecision() /
  // _requestDirectorCycleDecision() / _validateDirectorDecision() /
  // _writeDirectorSessionSummaryDiary() はディレクターの編成判断サブシステムとして
  // server/lib/agent-director-decision.js へ集約。

  // ─────────────────────────────────────────────
  //  エージェント日記
  // ─────────────────────────────────────────────

  /**
   * コーナーの終了後（または番組の節目）に、担当のエージェントへ一人称の短い振り返りを
   * 書かせて server/data/agent-diary/ へ保存する。
   *
   * ATTENTION: 放送のタイミングを絶対に止めないこと。呼び出し側は必ず結果を待たずに呼ぶ。
   *
   * @param {string} agentKey 保存先のフォルダ名（'commentator'/'caster'/'assistant' 等）
   * @param {string} agentName 表示名（設定から取った動的な値）
   * @param {string} spokenText 振り返りの材料になる発言
   * @param {string} [label] 日記の「コーナー」欄に残す文脈のラベル（省略時はエージェントキー）
   * @param {'moment'|'episode'} [scope] 'moment'=直前の一場面（既定）／'episode'=セッション全体
   */
  async _writeDiaryReflection(agentKey, agentName, spokenText, label = agentKey, scope = 'moment') {
    if (!spokenText) return;
    try {
      // ATTENTION: プロンプトと材料の上限は agent-diary.js に集約してある。ここで別に持たないこと。
      //            全チャンネルと秘書経由の相談とで、振り返りの観点が食い違わないようにするため。
      const excerpt = spokenText.replace(/[\n\r]+/g, ' ')
        .slice(0, agentDiary.REFLECTION_EXCERPT_LIMITS[scope] || 800);
      const prompt = agentDiary.buildReflectionPrompt({ agentName, excerpt, scope });
      const diaryText = await this._callGeminiRaw(prompt, 'light');
      if (!diaryText) return;
      agentDiary.appendDiaryEntry({
        channel: (this._channelId || 'live').toLowerCase(),
        agentKey,
        agentName,
        corner: label,
        text: diaryText.trim(),
      });
      // 日記の本文は非公開の振り返りのため全文は流さず、短い抜粋だけを画面へ出す
      // （本文は管理画面から読める）。
      this._broadcast({
        event: 'DIARY_WRITTEN', agentKey, agentName, corner: label,
        excerpt: diaryText.trim().slice(0, 40),
      });
    } catch (e) {
      getLogger().debug(`[Diary] ${agentKey} の日記生成に失敗しました（無視して続行）: ${e.message}`);
    }
  }

  /**
   * キャスター・アシスタントのオープニングの発言を、日記の材料としてためておく。
   *
   * ATTENTION: この2人はコーナーを持たず一日中話し続けるため、コーナー担当と同じように
   *            毎回書くと過多になる。ここではためるだけにし、セッションの終わりに1回だけ書く。
   *
   * @param {string} agentKey エージェントキー
   * @param {string} text ためておく発言
   */
  _bufferMaxClaraDiaryText(agentKey, text) {
    if (!text) return;
    this._maxClaraDiaryBuffer ??= { caster: [], assistant: [] };
    this._maxClaraDiaryBuffer[agentKey] ??= [];
    this._maxClaraDiaryBuffer[agentKey].push(text);
  }

  /**
   * ためておいたオープニング分と、セッションの終わりの最後の発言を合わせて1回だけ振り返りを書く。
   *
   * 明示的な番組終了と、全リスナーの退出の両方から呼ぶ。
   *
   * @param {string} agentKey エージェントキー
   * @param {string} agentName 表示名
   * @param {string} finalText セッションの終わりの最後の発言
   * @returns {Promise<void>}
   */
  _flushMaxClaraDiary(agentKey, agentName, finalText) {
    this._maxClaraDiaryBuffer ??= { caster: [], assistant: [] };
    const buffer = this._maxClaraDiaryBuffer[agentKey] || [];
    this._maxClaraDiaryBuffer[agentKey] = [];
    const combined = [...buffer, finalText].filter(Boolean).join('\n');
    return this._writeDiaryReflection(agentKey, agentName, combined, 'session', 'episode');
  }

  // ─────────────────────────────────────────────
  //  ワールドレポート: 都市決定（プリフェッチ専用）
  // ─────────────────────────────────────────────

  /**
   * 都市名から、背景に流す環境音のフォルダを決める。
   *
   * 優先順位:
   *   1. 分類されたカテゴリのフォルダ
   *   2. 都市名のキーワードで一致したフォルダ
   *   3. 既定のフォルダ
   *   4. null — ファイルが無い（完全に無音）
   *
   * @param {string} ambientDir 環境音を置いてあるフォルダ
   * @param {string} cityLower 都市名（小文字に正規化済み）
   * @param {string|null} ambientCategory 分類されたカテゴリ名
   * @returns {string|null} MP3 を含むフォルダ。無ければ null
   */
  _resolveAmbientFolder(ambientDir, cityLower, ambientCategory = null) {
    // 都市のキーワードとフォルダ名の対応。フォルダは server/assets/bgm/world_report/ の下にある。
    const CITY_AMBIENT_MAP = [
      // 日本
      { folder: 'japan',      keys: ['tokyo','東京','osaka','大阪','kyoto','京都','japan','日本','sapporo','札幌','nagoya','名古屋','fukuoka','福岡','yokohama','横浜','kobe','神戸'] },
      // 中東・湾岸
      { folder: 'middleeast', keys: ['kuwait','クウェート','dubai','ドバイ','riyadh','リヤド','doha','ドーハ','abu dhabi','アブダビ','bahrain','バーレーン','muscat','マスカット','saudi','サウジ','qatar','カタール','oman','オマーン','iran','イラン','iraq','イラク','jordan','ヨルダン','beirut','ベイルート','cairo','カイロ','egypt','エジプト','tel aviv','テルアビブ','jerusalem','エルサレム'] },
      // 欧州
      { folder: 'paris',      keys: ['paris','パリ','france','フランス','lyon','リヨン','marseille','マルセイユ'] },
      { folder: 'london',     keys: ['london','ロンドン','england','イングランド','uk','britain','イギリス','manchester','マンチェスター','edinburgh','エジンバラ'] },
      { folder: 'europe',     keys: ['berlin','ベルリン','germany','ドイツ','munich','ミュンヘン','frankfurt','フランクフルト','rome','ローマ','milan','ミラノ','italy','イタリア','madrid','マドリード','barcelona','バルセロナ','spain','スペイン','amsterdam','アムステルダム','vienna','ウィーン','brussels','ブリュッセル','zurich','チューリッヒ','prague','プラハ','warsaw','ワルシャワ','stockholm','ストックホルム','helsinki','ヘルシンキ','oslo','オスロ','copenhagen','コペンハーゲン'] },
      // 北米
      { folder: 'newyork',    keys: ['new york','ニューヨーク','manhattan','マンハッタン','brooklyn','ブルックリン','nyc'] },
      { folder: 'usa',        keys: ['los angeles','ロサンゼルス','chicago','シカゴ','houston','ヒューストン','washington','ワシントン','san francisco','サンフランシスコ','miami','マイアミ','boston','ボストン','usa','アメリカ','seattle','シアトル','denver','デンバー','atlanta','アトランタ','toronto','トロント','canada','カナダ','vancouver','バンクーバー','montreal','モントリオール'] },
      // 中南米
      { folder: 'latinamerica', keys: ['mexico','メキシコ','sao paulo','サンパウロ','rio','リオ','brazil','ブラジル','buenos aires','ブエノスアイレス','argentina','アルゼンチン','bogota','ボゴタ','colombia','コロンビア','lima','リマ','peru','ペルー','santiago','サンティアゴ','chile','チリ'] },
      // 東アジア
      { folder: 'china',      keys: ['beijing','北京','shanghai','上海','guangzhou','広州','shenzhen','深圳','china','中国','hong kong','香港','macau','マカオ'] },
      { folder: 'korea',      keys: ['seoul','ソウル','busan','釜山','korea','韓国'] },
      { folder: 'asia',       keys: ['bangkok','バンコク','thailand','タイ','singapore','シンガポール','manila','マニラ','philippines','フィリピン','jakarta','ジャカルタ','indonesia','インドネシア','kuala lumpur','クアラルンプール','malaysia','マレーシア','hanoi','ハノイ','ho chi minh','ホーチミン','vietnam','ベトナム','taipei','台北','taiwan','台湾'] },
      // 南アジア
      { folder: 'asia',       keys: ['mumbai','ムンバイ','delhi','デリー','india','インド','dhaka','ダッカ','bangladesh','バングラデシュ','colombo','コロンボ','karachi','カラチ','pakistan','パキスタン'] },
      // アフリカ
      { folder: 'africa',     keys: ['nairobi','ナイロビ','kenya','ケニア','lagos','ラゴス','nigeria','ナイジェリア','johannesburg','ヨハネスブルク','south africa','南アフリカ','cape town','ケープタウン','accra','アクラ','ghana','ガーナ','addis ababa','アディスアベバ','ethiopia','エチオピア','casablanca','カサブランカ','morocco','モロッコ'] },
      // オセアニア
      { folder: 'oceania',    keys: ['sydney','シドニー','melbourne','メルボルン','australia','オーストラリア','auckland','オークランド','new zealand','ニュージーランド'] },
      // 旧ソ連・中央アジア
      { folder: 'europe',     keys: ['moscow','モスクワ','russia','ロシア','kyiv','キーウ','ukraine','ウクライナ','istanbul','イスタンブール','turkey','トルコ'] },
    ];

    // フォルダに MP3 ファイルが1つ以上あるか確認するヘルパー
    const hasMp3 = (dir) => {
      if (!fs.existsSync(dir)) return false;
      return fs.readdirSync(dir).some(f => f.endsWith('.mp3'));
    };

    if (!fs.existsSync(ambientDir)) return null;

    // Step 0: AI が分類したアンビエントカテゴリを最優先
    if (ambientCategory && ambientCategory !== 'default') {
      const categoryPath = path.join(ambientDir, ambientCategory);
      if (hasMp3(categoryPath)) {
        getLogger().info(`[WorldReport] アンビエントカテゴリ "${ambientCategory}" マッチ → ${categoryPath}`);
        return categoryPath;
      }
      getLogger().debug(`[WorldReport] カテゴリフォルダ "${ambientCategory}" が存在しないか空 → キーワードマッチへ`);
    }

    // Step 1: 都市名でサブフォルダをキーワードマッチ
    const matched = CITY_AMBIENT_MAP.find(({ keys }) =>
      keys.some(k => cityLower.includes(k) || k.includes(cityLower.split(' ')[0]))
    );
    if (matched) {
      const folderPath = path.join(ambientDir, matched.folder);
      if (hasMp3(folderPath)) return folderPath;
    }

    // Step 2: _default/ フォールバック
    const defaultPath = path.join(ambientDir, '_default');
    if (hasMp3(defaultPath)) return defaultPath;

    // ATTENTION: 直下の MP3 は使わない（ジングルのファイルのため、環境音の候補から外す）。

    return null;
  }

  /**
   * 今日のニュースを検索し、特派員のレポート地（都市名）を決める。
   *
   * 先読みと並行して走らせることで、コーナーが始まる前に場所を確定させる。
   *
   * @returns {Promise<any>} 都市名・地図検索用の英語名・環境音のカテゴリ
   */
  async _resolveWorldReportCity() {
    const _now    = new Date();
    const _year   = _now.getFullYear();
    const _recent = (this._recentWorldReportCities || []);
    // ATTENTION: 直近の場所を避けさせる指示は強い書き方にすること。「避けること」程度では無視される。
    const _avoidStr = _recent.length > 0
      ? `\n❌【絶対禁止・直近レポート済み — 選んだら即アウト】\n同じ場所のレポートは最悪の繰り返しです。以下は絶対に選ばないでください:\n${_recent.map(c => `❌ ${c}（直近使用済み）`).join('\n')}\n上記の場所を含む国・地域は一切選ばないこと。必ず全く別の場所を選んでください。`
      : '';

    try {
      const _query = `
以下のキーワードで今日の世界のニュースを検索してください:
"underreported small nation news ${_year}"
"forgotten country local news ${_year}"
"remote village island news today ${_year}"
${_avoidStr}

【指示】
日本のメディアがほぼ報道しない、世界の辺境・小国・無名の地域から1つ選んでください。
毎回違う場所を選ぶこと。世界は200か国以上あります。同じ国や地域が続くのは絶対に避けてください。

◎ 特に選びたい場所の例（これ以外でも可・直近使用済みを除く）:
  太平洋の島嶼国: キリバス・バヌアツ・ソロモン諸島・ナウル・トンガ・サモア・パラオ・ミクロネシア・ツバル
  東南アジア小国: 東ティモール・ブルネイの農村・ミャンマーの少数民族地域
  アフリカ小国: コモロ・ジブチ・エリトリア・ギニアビサウ・サントメ・プリンシペ・赤道ギニア・レソト・スワジランド（エスワティニ）
  中央アジア: タジキスタン・キルギスタン・トルクメニスタンの地方
  カリブ海: ハイチの地方・トリニダードトバゴの農村・ドミニカ国
  中東・中央: イエメンの地方・ソマリランド・プントランド
  南米の辺境: ボリビアのアマゾン・スリナム・ガイアナ・パラグアイの先住民地域
  南アジア: ブータンの村・ネパールの山岳地帯・モルディブの離島
  欧州の小国: モルドバ・コソボ・北マケドニア・モンテネグロの農村

❌ 絶対に選ばないこと: 米国・英国・フランス・ドイツ・日本・中国・韓国・ロシア・オーストラリア等の主要国の都市
❌ 大都市も不可: ニューヨーク・ロンドン・東京・パリ・ベルリン・北京 等

【回答フォーマット】
以下のJSON形式のみで返してください（説明・コメント不要）:
{"city":"都市名（日本語、25文字以内）","englishName":"City or Region, Country (English, for geocoding)","ambientCategory":"カテゴリ名"}

englishName は地図ジオコーディング用の英語地名です。Nominatimで検索できる形式で書いてください。
例: "Trashigang, Bhutan" / "Tarawa, Kiribati" / "Dili, East Timor" / "Khujand, Tajikistan"

ambientCategory は以下から1つ選択（ロケーションの環境・地形タイプで判断）:
  ocean_island    - 孤立した離島・小さな島嶼国（トリスタンダクーニャ、キリバス、ツバル、マルディブ等）
  tropical_jungle - 熱帯雨林・ジャングル地帯（アマゾン、コンゴ、東南アジアの密林・農村）
  desert          - 砂漠・乾燥地帯（サハラ、アラビア砂漠、中央アジアの乾燥地帯）
  mountain        - 山岳地帯・高原（ヒマラヤ、アンデス、ネパール・ブータンの山岳地）
  arctic          - 極地・寒冷地帯（北極圏、グリーンランド、アイスランドの僻地）
  city_asia       - アジアの都市・農村（東南アジア・南アジア・中央アジア）
  city_africa     - アフリカの都市・農村・サバンナ
  city_middleeast - 中東・北アフリカの都市・農村
  city_europe     - 欧州の小国・農村・田舎町
  city_america    - 南北米・カリブ海の都市・農村
  default         - 上記に分類困難な場所

例: {"city":"キリバス・タラワ","englishName":"Tarawa, Kiribati","ambientCategory":"ocean_island"}
    {"city":"東ティモール・ディリ","englishName":"Dili, East Timor","ambientCategory":"city_asia"}
    {"city":"タジキスタン・ホジャンド","englishName":"Khujand, Tajikistan","ambientCategory":"mountain"}`;

      // 場所選びはモデルの持っている知識で足りるため、ここでは検索を使わず速さを優先する
      // （ニュースの検索はこの後のコーナー本体で行う）。
      const _result = await this.generateAgentSpeech('world_report', _query, false, 'light');

      // 余分なテキストが混ざっていても、中括弧の部分だけを取り出して読む。
      let _rawCity = '';
      let _englishName = '';
      let _ambientCategory = 'default';
      try {
        // 1. コードブロックを除去
        let _jsonStr = _result.trim()
          .replace(/^```(?:json)?\s*/im, '')
          .replace(/\s*```\s*$/m, '')
          .trim();
        // 2. 最初の { から最後の } まで抽出（前後の余分なテキストを除去）
        const _jsonMatch = _jsonStr.match(/\{[\s\S]*\}/);
        if (_jsonMatch) _jsonStr = _jsonMatch[0];
        const _parsed = JSON.parse(_jsonStr);
        _rawCity = ((_parsed.city || '').replace(/[「」『』【】\[\]（）()]/g, '')
          .replace(/^(都市名|地名|場所)[：:]\s*/, '')
          .trim()
          .slice(0, 40)); // 40文字まで（JSON混入防止で30→40に拡張）
        _englishName  = (_parsed.englishName || '').trim().slice(0, 100);
        _ambientCategory = _parsed.ambientCategory || 'default';
      } catch {
        // JSON パース失敗 → キーバリューを正規表現で直接抽出
        const _cityRegex  = /"city"\s*:\s*"([^"]+)"/;
        const _enRegex    = /"englishName"\s*:\s*"([^"]+)"/;
        const _catRegex   = /"ambientCategory"\s*:\s*"([^"]+)"/;
        const _cityMatch  = _result.match(_cityRegex);
        const _enMatch    = _result.match(_enRegex);
        const _catMatch   = _result.match(_catRegex);
        if (_cityMatch) {
          _rawCity     = _cityMatch[1].trim().slice(0, 40);
          _englishName = _enMatch ? _enMatch[1].trim().slice(0, 100) : '';
          _ambientCategory = _catMatch ? _catMatch[1].trim() : 'default';
          getLogger().warn(`[WorldReport] JSON.parse失敗 → regex抽出: city="${_rawCity}" en="${_englishName}" cat="${_ambientCategory}"`);
        } else {
          // 最終フォールバック: 平文として1行目を都市名に使う
          _rawCity = _result.trim()
            .split('\n')[0]
            .replace(/[「」『』【】\[\]（）()\{"\}]/g, '')
            .replace(/^(都市名|地名|場所|city)[：:\s]*/, '')
            .trim()
            .slice(0, 40);
          getLogger().warn('[WorldReport] JSON/regex抽出失敗 → 平文フォールバック (ambientCategory=default)');
        }
      }

      // 英単語が多い場合やセリフが混ざった場合は、読み取りに失敗したとみなして既定の場所へ倒す。
      const _isValidCity = _rawCity.length >= 2 &&
        _rawCity.length <= 35 &&  // 都市名はプロンプト指定の25文字以内に余裕を持たせた上限
        !/^(the|search|result|indicate|no |latest|world|news|breaking)/i.test(_rawCity) &&
        !/PAUSE|Hey\s|今[、,]私|です！|ます！|Back\s*to|からお伝え/i.test(_rawCity) && // 発話テキスト混入を除外
        (_rawCity.match(/[　-鿿]/g) || []).length >= 1; // 最低1文字の日本語を含む

      const _city = _isValidCity ? _rawCity : '';
      const _resolvedCity = _city || 'ニューヨーク';
      getLogger().info(`[WorldReport] レポート地 決定: ${_resolvedCity} (en: ${_englishName || 'none'}) / ambient: ${_ambientCategory}`);

      // 直近と重なっていたら警告に残す（次の呼び出しで回避の指示が効くかを確かめるため）。
      const _isDuplicate = _recent.some(r =>
        _resolvedCity.includes(r.split('・')[0]) || r.includes(_resolvedCity.split('・')[0])
      );
      if (_isDuplicate) {
        getLogger().warn(`[WorldReport] 重複検出: "${_resolvedCity}" は直近レポート済み [${_recent.join(', ')}] — 今回は使用するが次回は回避`);
      }
      return { city: _resolvedCity, englishName: _englishName, ambientCategory: _ambientCategory };
    } catch (e) {
      getLogger().warn(`[WorldReport] 都市決定エラー: ${e?.message} → fallback`);
      return { city: 'ニューヨーク', englishName: 'New York, USA', ambientCategory: 'default' };
    }
  }

  // ─────────────────────────────────────────────
  //  コーナーコンテキスト構築（パイプライン用）
  // ─────────────────────────────────────────────

  /**
   * コーナー担当のエージェント向けのプロンプトを組み立てる。
   *
   * 材料の取得（天気・交通・ニュース・金融）もこの中で行うため、前のエージェントの発話中に
   * 呼んで先読みできる。
   *
   * @param {string} centerKey コーナーキー
   * @param {string} contextPrompt 共通の前提
   * @param {string|null} mcQuestion 進行役の直前の発言
   * @param {any} topicRequest リクエストされた話題。無ければ null
   * @returns {Promise<string>} 組み立てたプロンプト
   */
  async _buildCornerContext(centerKey, contextPrompt, mcQuestion = null, topicRequest = null) {
    const config = this.getConfig();
    const nowC = new Date();
    const cornerTimeStr = `${nowC.getHours()}時${String(nowC.getMinutes()).padStart(2,'0')}分`;
    const agentCfg = (config.agents && config.agents[centerKey]) || {};
    // ATTENTION: 音声合成のエンジンは管理画面で変えられるため、毎回設定から読むこと。
    const _cornerUseGeminiTts = (agentCfg.tts_engine || 'gemini') === 'gemini';
    // 効果音のタグは音声エンジンによらず使える（実際の音声を挿し込むため、モデル側の抑揚の
    // 制御とは無関係）。
    // ATTENTION: スタジオに同席しない出演者（リモートのセンター・特派員など）には案内しない。
    // ATTENTION: 使える名前は server/assets/sfx/ の実ファイルから取ること。文言に直書きしない。
    const _sfxNames = SFX_ELIGIBLE_AGENT_KEYS.has(centerKey) ? sfxLibrary.listSfxNames() : [];
    const _sfxNote = _sfxNames.length > 0
      ? `\n- 【効果音（任意・控えめに）】本当に効果的な瞬間だけ [SFX:名前] タグを発話に埋め込むと効果音を鳴らせます（使用可能な名前: ${_sfxNames.join('/')}）。多用は厳禁、1発話につき最大1〜2回まで。例:「やった、大当たりです！[SFX:applause]」`
      : '';
    const _pauseNote = (_cornerUseGeminiTts
      ? '- ラジオで読み上げる日本語テキストのみを出力してください（間・抑揚はTTSが自律制御）'
      : '- ラジオで読み上げる日本語テキストのみを出力してください（[PAUSE:N] タグ使用可）\n- 【間を積極的に挿入】話題切り替え・重要な事実の前・感情の後に [PAUSE:400〜600] を 1発話 3〜5個入れること\n- 「……」「…」は TTS では機能しないため禁止'
    ) + _sfxNote;
    // 全エージェント名を config から取得（管理画面で変更されても追従する）
    const _casterName = (config.agents?.caster?.name)       || 'MAX';
    const _asstName   = (config.agents?.assistant?.name)    || 'Clara';
    const _wrName     = (config.agents?.world_report?.name) || 'Steve';
    const _djName     = (config.agents?.music_dj?.name)     || 'DJ サキ';
    const _laName     = (config.agents?.life_advisor?.name) || '平野ドレミ';
    const _cmName     = (config.agents?.commentator?.name)   || '高橋洋二教授';
    const _jnName     = (config.agents?.journalist?.name)    || '謎のジャーナリストX';
    const _lgName     = (config.agents?.legal_advisor?.name) || '北村昭雄';
    const _cdName     = (config.agents?.comedian?.name)     || '難波亭 ボケ';
    const _drName     = (config.agents?.doctor?.name)       || '華院 麗子';
    const _mkName     = (config.agents?.marketer?.name)     || '世界 創';
    const centerNames = {
      weather:       '気象情報センター',
      traffic:       '交通情報センター',
      news:          '報道センター',
      finance:       '金融情報センター',
      commentator:   '解説コーナー',
      journalist:    '情報コーナー',
      music_dj:      '音楽・エンタメコーナー',
      world_report:  'ワールドレポート',
      legal_advisor: '法律相談コーナー',
      comedian:      getGuestAnalystDef('comedian').cornerName,
      doctor:        getGuestAnalystDef('doctor').cornerName,
      marketer:      getGuestAnalystDef('marketer').cornerName,
    };
    const agentDisplayName = agentCfg.name || centerNames[centerKey];

    // ATTENTION: 手持ち（リスナー像・継続観測のメモ・定期監視・自主リサーチ・見た動画・裏の顔）は、
    //            全コーナー共通のこの入口で1回だけまとめて渡すこと。個々のコーナーの組み立てに
    //            同じものを足すと二重になる。何を誰に渡すかは agent-knowledge-pack.js が決める。
    let cornerContext = contextPrompt + buildAgentKnowledgePack({
      agentKey: centerKey,
      selfDigest: this._getAgentDiarySelfDigest(centerKey),
      // 「分かったこと」の台帳から、今の話題に関係する事実を選ぶ手がかり
      topic: [topicRequest?.rawText, topicRequest?.topic, mcQuestion].filter(Boolean).join('\n'),
    });

    // コーナーごとの組み立ては個別のメソッドへ分けてある。ここで組み立てた共通の値は
    // まとめて渡す。天気・交通・ニュース・金融の4つは共通の冒頭・末尾の定型を後から足して
    // 返し、それ以外のコーナーは各メソッドが組み立て終えたものをそのまま返す。
    const ctx = {
      config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
      _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
      _cdName, _drName, _mkName,
      centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest,
    };

    if (centerKey === 'weather') {
      cornerContext = await this._buildWeatherCornerContext(cornerContext, ctx);
    } else if (centerKey === 'traffic') {
      cornerContext = await this._buildTrafficCornerContext(cornerContext, ctx);
    } else if (centerKey === 'news') {
      cornerContext = await this._buildNewsCornerContext(cornerContext, ctx);
    } else if (centerKey === 'finance') {
      cornerContext = await this._buildFinanceCornerContext(cornerContext, ctx);
    } else if (centerKey === 'music_dj') {
      return this._buildMusicDjCornerContext(cornerContext, ctx);
    } else if (centerKey === 'journalist') {
      return this._buildJournalistCornerContext(cornerContext, ctx);
    } else if (centerKey === 'commentator') {
      return this._buildCommentatorCornerContext(cornerContext, ctx);
    } else if (centerKey === 'legal_advisor') {
      return this._buildLegalAdvisorCornerContext(cornerContext, ctx);
    } else if (GUEST_ANALYST_KEYS.includes(centerKey)) {
      return this._buildGuestAnalystCornerContext(cornerContext, ctx);
    } else if (centerKey === 'life_advisor') {
      return this._buildLifeAdvisorCornerContext(cornerContext, ctx);
    } else if (centerKey === 'world_report') {
      return this._buildWorldReportCornerContext(cornerContext, ctx);
    }

    // コーナー共通：冒頭・末尾定型フレーズ
    cornerContext += `
【コーナー進行の必須ルール】
- 冒頭: 必ず「${centerNames[centerKey]}の${agentDisplayName}です。${cornerTimeStr}現在の情報をお伝えします」のように自己紹介してからスタートしてください
- 末尾: 必ず「以上、${centerNames[centerKey]}からお伝えしました。スタジオにお返しします」で締めてください
- その間にあなたのキャラクターを最大限に発揮してください`;

    return cornerContext;
  }

  // ─── 天気コーナー（centerKey: weather）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  /**
   * 今が何時かに応じて、どの時間帯の天気を主役にするかを決める。
   *
   * BUGFIX: 「今日の残りと明日を伝える」という曖昧な指示だと、夜の放送で「今日は晴れ間が
   *         広がりますが、夕方から雲が広がります」と、既に過ぎた今日のことを読み上げる。
   *         その時間に知りたいのは今夜から明日にかけての天気なので、何を主役にするかは
   *         コード側で決めて明示的に渡す。
   *
   * @param {Date} now 現在時刻
   * @returns {any} 時間帯のラベルと、主役にする時間帯の指示
   */
  _buildWeatherFocusGuidance(now) {
    const h = now.getHours();
    if (h < 5) {
      return { label: '未明', focus: '今日これからの天気（朝・日中）を主役に伝えてください。'
        + '前日の話はしないでください。' };
    }
    if (h < 10) {
      return { label: '朝', focus: '今日の日中から夜にかけての天気を主役に伝えてください。'
        + '通勤・通学の時間帯（これからの数時間）を特に丁寧に。' };
    }
    if (h < 15) {
      return { label: '日中', focus: '今日の午後から夜にかけての天気を主役に伝えてください。'
        + '午前中の天気を振り返る必要はありません。' };
    }
    if (h < 18) {
      return { label: '夕方', focus: '今日の夜の天気と、明日の天気を主役に伝えてください。'
        + '今日の日中がどうだったかは振り返らないでください。' };
    }
    return {
      label: '夜',
      focus: '**今夜これから・明日の朝・明日の日中**を主役に伝えてください。'
        + '今日の日中がどうだったか（「今日は晴れました」等）は既に過ぎたことなので'
        + '**絶対に伝えないでください**。リスナーがこの時間に知りたいのは、'
        + 'これから寝るまでの天気と、明日の予定に関わる天気です。',
    };
  }

  /**
   * 気象のデータから、伝えるべき助言（傘・熱中症・寒暖差・服装・乾燥・日差し）を組み立てる。
   *
   * ATTENTION: しきい値の判定は必ずコードで行い、言葉にすることだけをモデルに任せる。
   *            「傘が必要なら伝えて」という指示だけだと、数値を見て気づくかどうかがモデル任せに
   *            なり、実地では助言がほとんど出なかった。
   *
   * @param {any} structured 天気サービスが整えたデータ
   * @param {Date} now 現在時刻
   * @returns {string[]} 助言の一覧
   */
  _buildWeatherAdvisories(structured, now) {
    const out = [];
    if (!structured) return out;
    const hour = now.getHours();
    const tomorrow = structured.tomorrowHourly || [];
    const todayLeft = structured.todayRemaining || [];

    // ── 傘 ────────────────────────────────────────────────
    const wetToday = todayLeft.filter((x) => x.pop >= 50);
    if (wetToday.length > 0) {
      const worst = wetToday.reduce((a, b) => (b.pop > a.pop ? b : a));
      out.push(`今日はこのあと${worst.hour}時ごろに降水確率${worst.pop}%。`
        + 'まだ外出の可能性があるなら傘を持つよう勧めてください。');
    }
    // 夜以降は「明日の朝」が最も効く（出かける前に持たせたいため）。
    const morning = tomorrow.filter((x) => x.hour >= 6 && x.hour <= 12);
    const wetMorning = morning.filter((x) => x.pop >= 50);
    if (wetMorning.length > 0) {
      const worst = wetMorning.reduce((a, b) => (b.pop > a.pop ? b : a));
      out.push(`明日の朝（${worst.hour}時ごろ）の降水確率が${worst.pop}%と高いです。`
        + '「明日お出かけのご予定があれば、傘をお持ちになってください」と必ず伝えてください。');
    }
    const wetTomorrowLater = tomorrow.filter((x) => x.hour > 12 && x.pop >= 50);
    if (wetMorning.length === 0 && wetTomorrowLater.length > 0) {
      const worst = wetTomorrowLater.reduce((a, b) => (b.pop > a.pop ? b : a));
      out.push(`明日は${worst.hour}時ごろに降水確率${worst.pop}%。折り畳み傘があると安心だと伝えてください。`);
    }

    // ── 暑さ・熱中症 ──────────────────────────────────────
    const tMax = structured.tomorrow?.max;
    if (typeof tMax === 'number' && tMax >= 30) {
      out.push(`明日の最高気温は${tMax}℃の予想です。熱中症に注意するよう、`
        + '水分補給とこまめな休憩を勧めてください。');
    } else if (typeof tMax === 'number' && tMax >= 27 && (structured.humidity ?? 0) >= 75) {
      out.push(`明日は${tMax}℃で湿度も高く蒸し暑くなりそうです。熱中症に注意するよう伝えてください。`);
    }
    if (hour >= 18 && (structured.temp ?? 0) >= 27 && (structured.humidity ?? 0) >= 80) {
      out.push('今夜は気温・湿度とも高く寝苦しくなりそうです。'
        + 'エアコンを使うなど、睡眠中の熱中症にも注意するよう一言添えてください。');
    }

    // ── 寒暖差・冷え込み ──────────────────────────────────
    const tMin = structured.tomorrow?.min;
    if (typeof tMax === 'number' && typeof tMin === 'number' && tMax - tMin >= 10) {
      out.push(`明日は最高${tMax}℃・最低${tMin}℃と寒暖差が${tMax - tMin}度あります。`
        + '羽織るものがあると安心だと伝えてください。');
    }
    if (typeof tMin === 'number' && tMin <= 5) {
      out.push(`明日の最低気温は${tMin}℃まで下がります。しっかり暖かくして出かけるよう伝えてください。`);
    }

    // ── 風 ────────────────────────────────────────────────
    if ((structured.wind ?? 0) >= 8) {
      out.push(`風が強めです（風速${structured.wind}m/s）。傘が壊れやすい・自転車に注意、と一言添えてください。`);
    }

    // 気温帯から具体的な装いを言えるようにして、実生活に即した助言にする。
    if (typeof tMax === 'number') {
      let wear = null;
      if (tMax <= 10) wear = 'コートや厚手の上着が要る寒さ';
      else if (tMax <= 15) wear = '上着やマフラーがあると安心な肌寒さ';
      else if (tMax <= 20) wear = '薄手の上着がちょうどよい陽気';
      else if (tMax <= 25) wear = '長袖一枚で過ごしやすい陽気';
      else if (tMax <= 29) wear = '半袖でも過ごせる暑さ';
      else wear = '半袖でも汗ばむ暑さ';
      out.push(`明日の最高気温${tMax}℃は「${wear}」です。何を着ればよいかが伝わるよう、`
        + '具体的な装いに触れてください。');
    }

    // 夜の放送では「今夜どう過ごすか」が実用的。冷える夜は湯船・寝冷えに触れる。
    const tonightLow = todayLeft.length > 0 ? Math.min(...todayLeft.map((x) => x.temp)) : null;
    if (hour >= 17 && typeof tonightLow === 'number' && tonightLow <= 15) {
      out.push(`今夜は${tonightLow}℃まで下がります。「湯船にゆっくり浸かって暖かくしてお休みください」`
        + '「寝冷えにご注意ください」のような、夜の過ごし方の助言を添えてください。');
    }
    if (hour >= 17 && typeof tMin === 'number' && typeof tonightLow === 'number'
        && tonightLow - tMin >= 5) {
      out.push('明け方にかけてさらに冷え込みます。「明け方が一番冷えますので、'
        + '布団を一枚多めに」と伝えてください。');
    }

    // ── 乾燥（肌・のど）────────────────────────────────────
    const hum = structured.humidity ?? null;
    if (typeof hum === 'number' && hum <= 40) {
      out.push(`湿度が${hum}%と低く空気が乾燥しています。「お肌の保湿を」「のどを痛めないよう`
        + '加湿を」といったケアの助言を添えてください。');
    }

    // ATTENTION: 紫外線の指数そのものは取得していないため、晴天の予報と季節から言える範囲に
    //            留めること。「紫外線指数◯」のような数値を作らない。
    const month = now.getMonth() + 1;
    const sunnySeason = month >= 3 && month <= 10;
    const daytimeSunny = tomorrow.filter((x) => x.hour >= 9 && x.hour <= 15 && /晴|快晴/.test(x.desc || ''));
    if (sunnySeason && daytimeSunny.length >= 2) {
      out.push('明日の日中は晴れて日差しが強くなりそうです。「日焼け止めを」「帽子や日傘があると安心」'
        + 'といった助言を添えてください（ただし紫外線指数のような具体的な数値は、取得していないので述べないこと）。');
    }
    const todaySunny = todayLeft.filter((x) => x.hour >= 9 && x.hour <= 15 && /晴|快晴/.test(x.desc || ''));
    if (sunnySeason && hour < 12 && todaySunny.length >= 1) {
      out.push('今日の日中は日差しが強くなりそうです。これからお出かけなら日焼け対策を勧めてください。');
    }

    return out;
  }

  /**
   * 天気コーナーのプロンプトを組み立てる。
   *
   * @param {string} cornerContext ここまでに組み立てた文字列
   * @param {any} ctx 共通の値（設定・時刻・出演者の表示名など）
   * @returns {Promise<string>} 天気コーナー分を足した文字列
   */
  async _buildWeatherCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      const _weatherOverrideLoc = topicRequest?.location || null;
      const weatherData = await this.fetchWeatherData(_weatherOverrideLoc);
      if (weatherData) {
        // 時間帯に応じて主役の時間帯を切り替え、助言（傘・熱中症・寒暖差）はコード側で判定して確実に渡す。
        const _wNow = new Date();
        const _wFocus = this._buildWeatherFocusGuidance(_wNow);
        const _wAdvisories = this._buildWeatherAdvisories(this.weatherService?.cache?.structured, _wNow);

        // 明日の予定を材料にして、天気と実際の行動を結び付けた助言ができるようにする
        // （取得に失敗してもコーナー自体は通常どおり続ける）。
        let _wSchedule = '';
        try {
          const _creds = this.getCredentials?.() || null;
          if (_creds?.google?.refresh_token) {
            const _tm = new Date(_wNow.getTime() + 24 * 60 * 60 * 1000);
            const _pad = (n) => String(n).padStart(2, '0');
            const _fromDate = `${_tm.getFullYear()}-${_pad(_tm.getMonth() + 1)}-${_pad(_tm.getDate())}`;
            const _evs = await googleService.fetchCalendar(_creds, { rangeDays: 1, fromDate: _fromDate, maxResults: 10 });
            const _timed = (_evs || []).filter((e) => e.startISO);
            if (_timed.length > 0) {
              _wSchedule = _timed.map((e) => `${e.timeStr}〜「${e.summary}」`).join('、');
            }
          }
        } catch (e) {
          this.log(`[Weather] 明日の予定を取得できませんでした（天気は通常どおり伝えます）: ${e.message}`, 'warn');
        }
        // 危険な情報があるかを調べる。
        //
        // BUGFIX: 見出しの一致は前方一致で見ること。実際の見出しには「（全国・直近24時間・…）」の
        //         ような括弧書きが付くため、閉じ括弧までの完全一致で見ると地震だけ常に外れ、
        //         緊急の扱いが一度も発火しない。
        // ATTENTION: 判定は「データが存在するか」ではなく「居住地に影響があるか」で行うこと。
        //            存在するかだけで見ると、最大震度1の地震・2,400km東の熱帯低気圧・300km南の
        //            離島の注意報まで全て緊急になり、「最初に詳しく読め」と指示することになる。
        const _wStruct = this.weatherService?.cache?.structured || {};
        const _quakeIntensity = _wStruct.quakeMaxIntensity ?? 0;
        // ATTENTION: 津波の危険がある場合は、陸地での震度が低くても必ず緊急として扱うこと
        //            （海で起きた地震は震度が小さくても津波で被害が出る）。
        const _quakeTsunami = _wStruct.quakeTsunamiLabel || null;
        const _typhoonKm = _wStruct.typhoonNearestKm;
        // 台風は距離だけでは想像できないため、予報の位置と予報円から求めた「日本への最接近」で
        // 区分したものを使う（weather-service.js が算出する）。
        const _typhoonImpact = _wStruct.typhoonImpact || 'none';
        const _typhoonJapanKm = _wStruct.typhoonNearestJapanKm;
        // ATTENTION: 日本のどこかへの接近と、居住地への接近は別物。日本の代表地点には離島も含まれる
        //            ため、そこだけに近づく台風を居住地の緊急情報として扱うと、また無関係な地域の話を
        //            最優先で読む状態に戻る。
        const _typhoonHitsHome = _wStruct.typhoonAffectsListener === true;
        const _listenerWarnLevel = _wStruct.listenerWarningLevel ?? 0;

        // 存在するか（データがあるか）
        const _hasQuakeData   = weatherData.includes('【🔴 地震情報');
        const _hasTyphoonData = weatherData.includes('【🌀 台風情報】');
        const _hasWarningData = weatherData.includes('【⚠️ 気象警報');

        // 影響があるか（緊急として扱うか）
        //   地震 … 最大震度4以上。震度3以下は全国のどこかで揺れた程度で、居住地には無関係
        //   台風 … 800km以内。それより遠いものは進路次第で今後関わる可能性がある話に留まる
        //   警報 … 居住地の地域コードに実際に出ているものだけ
        // ATTENTION: 津波は地震データの有無と切り離すこと。海外の大地震による津波は国内の地震一覧に
        //            載らないため、地震データの有無を条件にすると取りこぼす。
        const _hasQuake   = (_hasQuakeData && _quakeIntensity >= 4) || !!_quakeTsunami;
        const _typhoonHitsJapan = _typhoonImpact === 'direct' || _typhoonImpact === 'near';
        const _hasTyphoon = _hasTyphoonData && _typhoonHitsJapan && _typhoonHitsHome;
        const _hasWarning = _hasWarningData && _wStruct.warningAffectsListener === true;
        const _hasDisaster = _hasQuake || _hasTyphoon || _hasWarning;

        // ATTENTION: 居住地の外で出ている特別警報（レベル5）は、居住地への影響が無くても伝えること。
        //            生命に関わる事態は、親戚や友人がいる土地の話として知りたいというご要望による。
        const _nationalAlerts = Array.isArray(_wStruct.nationalAlerts) ? _wStruct.nationalAlerts : [];
        const _hasNationalAlert = _nationalAlerts.length > 0;

        // 遠方・軽微な事象。緊急ではないが、触れる価値はある（特に台風は今後近づきうる）。
        const _distantNotes = [];
        if (_hasQuakeData && !_hasQuake) {
          _distantNotes.push(`地震のデータはありますが最大震度${_quakeIntensity || '不明'}・津波の心配なしで、`
            + '居住地に影響はありません。触れる場合も「各地で小さな地震がありました」程度に短く。');
        }
        if (_hasTyphoonData && !_hasTyphoon) {
          // 距離ではなく「進路の結論」を伝えさせる。「◯◯kmの位置にあります」だけでは
          // 聞き手は近いのか遠いのか判断できず、情報として役に立たないため。
          _distantNotes.push(_typhoonHitsJapan
            // 日本のどこかには接近するが、居住地は関係ないケース。黙殺せず、
            // ただし「自分のこと」として不安にさせない伝え方を指示する。
            ? '台風が**日本のどこかに接近しています**（データ内の「◯◯へ接近・上陸のおそれ」'
              + 'を参照）。**お住まいの地域は対象ではない**ことを明確にしたうえで、'
              + 'どの地域にいつ頃近づくのかを1〜2文で伝え、その地域の方への警戒を'
              + '呼びかけてください。省略してはいけません。'
            : _typhoonImpact === 'watch'
            ? '台風は現時点で日本への影響はありませんが、**今後近づく見込み**です。'
              + '「どこにあるか」より「どちらへ進み、いつ頃どのあたりに近づきそうか」を'
              + '伝えてください。距離の数字だけを読み上げても伝わりません。'
            : `台風はありますが、進路予想では日本へ近づかず${typeof _typhoonJapanKm === 'number'
                ? `（最も近づいても日本から約${_typhoonJapanKm.toLocaleString()}km）` : ''}、`
              + '影響はありません。「日本への影響はありません」と結論を先に言って、'
              + '一言で終えてください。**居住地からの距離を読み上げてはいけません** — '
              + '「居住地から2,400km」のような数字は、聞き手には近いのか遠いのかすら'
              + '分からず、何の役にも立ちません。');
        }
        if (_hasWarningData && !_hasWarning && _listenerWarnLevel === 20) {
          _distantNotes.push('居住地に出ているのは**注意報のみ**です（警報ではありません）。'
            + '通常の天気予報の一部として「〜に注意してください」と軽く触れる程度にし、'
            + '緊急情報のように扱わないでください。');
        }
        if (_hasWarningData && !_hasWarning && _listenerWarnLevel === 0) {
          _distantNotes.push('気象警報・注意報は出ていますが、**居住地域は対象外**です。'
            + '「お住まいの地域に警報は出ていません」と伝えるか、触れないでください。'
            + '対象外の地域の注意報を、あたかも関係があるかのように読み上げてはいけません。');
        }

        const _disasterSearchBlock = (_hasDisaster || _hasNationalAlert) ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴【緊急情報検出 — 必須Google検索】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${_hasTyphoon ? `・「台風 避難指示 避難勧告 ${new Date().toLocaleDateString('ja-JP')}」
・「台風 洪水 河川氾濫 最新情報」
・「台風 進路 最新 ${new Date().getFullYear()}」` : ''}
${_hasQuake ? `・「地震 津波情報 最新」
・「地震 被害状況 最新」` : ''}
${_hasNationalAlert ? _nationalAlerts.map((a) => `・「${a.pref} ${a.kinds.join('')}特別警報 最新」\n・「${a.pref} 避難指示 被害 ${new Date().toLocaleDateString('ja-JP')}」`).join('\n') : ''}
・「避難指示 避難勧告 現在 ${new Date().toLocaleDateString('ja-JP')}」
・「洪水 土砂災害 警戒 最新」
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : '';

        const _nationalAlertBlock = _hasNationalAlert ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆘【他県で特別警報が出ています — 必ず一言触れてください】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${_nationalAlerts.map((a) => `・${a.pref}（${a.areas.join('・')}）に${a.kinds.join('・')}特別警報`).join('\n')}

特別警報は「命を守る行動をとってください」という**最高レベル**の警報です。
現地では避難や救助が行われている可能性があります。

【伝え方】
1. **リスナーの居住地は対象ではない**ことを必ず明言してください（不安を煽らないため）。
2. そのうえで、**触れずに済ませてはいけません。** どこで・何の特別警報が出て・
   どういう状況になっているかを1〜2文で伝えてください。
3. 「現地にお住まいの方、ご家族やご友人がいらっしゃる方は、命を守る行動を」と
   呼びかけて締めてください。
4. 通常の天気予報より**前**に伝えてください。
5. 全体で3〜4文程度に収め、居住地の天気の話を圧迫しないようにしてください。
` : '';

        cornerContext += `
<context_data>
【リアルタイム気象データ（JMA取得済み）】
${weatherData}
</context_data>
※ <context_data> の内容はそのまま読み上げず、放送原稿として自然な日本語に変換してください。
${_disasterSearchBlock}${_nationalAlertBlock}
${_hasDisaster ? `【⚠️ 読み上げ順序（厳守）】
**リスナーの居住地に実際に影響のある事象が出ています。** 必ず先に伝えてください。

${_hasQuake ? `1️⃣ 【${_quakeTsunami ? '🌊 津波情報' : '🔴 地震情報'}】→ 最初に詳しく読む（${_quakeTsunami ? `**${_quakeTsunami}が発表されています**` : '最大震度4以上'}）\n` : ''}${_hasTyphoon ? '2️⃣ 【🌀 台風情報】→ 詳しく読む（進路予想で日本に影響が出る見込み）\n' : ''}${_hasWarning ? '3️⃣ 【⚠️ 警報・注意報】→ 読む（居住地が対象）\n' : ''}4️⃣ 通常天気（気温・予報）→ 最後に簡潔に読む

❌ 絶対禁止: 通常天気から話し始めること
` : `【読み上げの組み立て】
**居住地に影響のある緊急情報は、現時点でありません。** 通常の天気予報として、
落ち着いた流れで組み立ててください。${_hasNationalAlert ? `
ただし上記のとおり**他県で特別警報が出ています。** そちらは省略せず、
居住地の天気を伝える前に必ず触れてください。` : ''}
`}${_distantNotes.length > 0 ? `
📍【遠方・軽微な事象の扱い（データはありますが緊急ではありません）】
${_distantNotes.map((n) => `- ${n}`).join('\n')}
**これらを「緊急情報」として大げさに扱わないでください。** データに載っているという理由だけで
無関係な地域の情報を読み上げると、かえって聞き手を不安にさせ、本当の緊急時との区別が
つかなくなります。${_hasNationalAlert ? `
**ただし上の🆘特別警報だけは例外です。** あれは「命を守る行動を」という最高レベルの警報で、
ここで言う「軽微な事象」には当たりません。必ず伝えてください。` : ''}
` : ''}

${_hasDisaster ? `【🚨 緊急情報の詳細解説ルール（最重要）】
緊急情報がある場合は「一言触れる」ではなく【詳細に解説すること】。

▼ 台風・熱帯低気圧の場合（Google検索結果も活用して伝えること）:
  - 名称・強さ・現在位置・進路を伝える
  - 上陸予想時刻・場所（検索結果から）
  - 最大風速・予想降水量（検索結果から）
  - 避難指示・避難勧告が出ている地域（検索結果から必ず確認）
  - 洪水・土砂災害・高潮の危険がある地域
  - 「〇〇区では避難指示が出ています。速やかに避難してください」と具体的に
  - 交通機関への影響（鉄道運休・高速通行止めなど）

▼ 地震の場合（Google検索結果も活用して伝えること）:
  - 震源地・規模（マグニチュード）・最大震度
  - 津波警報・注意報の有無（「津波の心配はありません」も明言すること）
    ※データ内の（かっこ）に気象庁の原文が入っています。**それを根拠にしてください。**
      推測で「津波の心配はありません」と言ってはいけません。${_quakeTsunami ? `
  - 🚨 **今回は${_quakeTsunami}が発表されています。** 震度が小さくても、これは命に関わります。
    海岸・河口から離れ、直ちに高台へ避難するよう、最優先で強く呼びかけてください。` : ''}
  - 被害状況（検索結果から）
  - 余震への注意を呼びかける

▼ 警報・注意報の場合:
  - 対象地域を具体的に
  - 特別警報（最高レベル）は最大限の警戒を呼びかける

【重要】避難指示・津波警報・洪水情報はリスナーの命に関わります。
必ず検索結果から最新情報を取得し、具体的・詳細に伝えてください。` : ''}

【通常天気の読み上げルール】
${_weatherOverrideLoc ? `- 🎤【リスナーリクエスト】「${_weatherOverrideLoc}」の天気情報です。冒頭で「${_weatherOverrideLoc}の天気をお伝えします」と場所を明示してください。` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏰【今は${_wNow.getHours()}時${String(_wNow.getMinutes()).padStart(2, '0')}分（${_wFocus.label}）— どの時間帯を伝えるか】
${_wFocus.focus}
**既に過ぎた時間帯の天気を「今日は〜でした」と振り返ることは、リスナーにとって何の役にも
立ちません。** 今から先のことだけを伝えてください。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 現在の天気（気温・天気・湿度・風）を簡潔に伝えてください
- これから先の時間帯は「このあと〇時ごろは〜」と具体的な時刻を挙げてください
- 明日の予報は必ず伝えてください（最高・最低気温、天気の変化、朝の降り方）
${_wAdvisories.length > 0 ? `
🌂【必ず伝える助言（データから確定した内容です。省略しないでください）】
${_wAdvisories.map((a) => `- ${a}`).join('\n')}
これらは数値から確定した事実に基づく助言です。**あなたの言葉で自然に**織り込んでください
（箇条書きをそのまま読み上げるのではなく、会話として）。` : `
- 天気にまつわる助言（傘・服装・体調）で、データから言えることがあれば添えてください。
  データから確認できないことは言わないでください。`}
${!_hasDisaster ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡【実生活に役立つ一言を必ず入れてください】
数値を伝えるだけの予報は、聞いてもその後の行動が変わりません。**「だからどうすればよいか」**
まで踏み込んでください。今日のデータから言えるものを、最低でも1つは必ず入れること。

・**服装** — 「上着があると安心です」「日中は半袖で十分です」
・**健康** — 「夜は冷えますので、湯船に浸かってゆっくりお休みください」
             「寝冷えにご注意ください」「水分をこまめに」
・**肌・のど** — 「空気が乾燥していますので、保湿を心がけてください」
・**日差し** — 「日焼け止めをお忘れなく」「帽子や日傘があると安心です」
・**持ち物** — 「傘をお持ちになってください」「折り畳みがあると安心です」

【口調について】
最後に詩的・哲学的な一言で締めくくるのは、あなたらしさですのでそのまま続けてください。
ただし**それだけで終わらせないこと**。詩的な一言の前に、上記のような実用的な助言を
必ず置いてください。順序は「①これからの天気 → ②実生活の助言 → ③あなたらしい締めくくり」です。
聞いた人が「では傘を持っていこう」「今夜は湯船に浸かろう」と行動できる予報にしてください。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━` : ''}
${_wSchedule ? `
📅【明日のリスナーのご予定】${_wSchedule}
天気とこのご予定を**結び付けて**助言してください。
例:「明日の午前中は雨の予報ですが、10時からお出かけのご予定がありますね。傘をお忘れなく」
予定の内容そのものを詳しく読み上げる必要はありません（時間帯と天気の関係が伝われば十分です）。
予定と天気に特に関係が無ければ、無理に触れなくて構いません。` : ''}
- ${_hasDisaster ? '緊急情報がある日は通常天気は簡潔に（2〜3文）でOK' : '上記の実際のデータのみを根拠にしてください'}
- 上記の実際のデータのみを根拠にしてください。データにない情報は作らないでください
${!_hasDisaster ? `
【あなたは気象予報士の資格を持つプロフェッショナルです】
このメッセージには地上天気図の画像が添付されています（添付が無い場合はこの節は無視してください）。
気温や降水確率の数値をそのまま読み上げるだけでなく、天気図から高気圧・低気圧・前線の位置関係を
読み取り、「なぜ今の天気になっているのか」「なぜこれから天気が変わろうとしているのか」を、
専門用語に頼りすぎず一般のリスナーにも分かりやすい言葉で解説してください
（例:「西の海上から低気圧が近づいてきているため、明日にかけて次第に雨雲が広がる見込みです」
「日本付近は高気圧に覆われていて、この晴天がしばらく続きそうです」）。
毎回天気図の説明から入る必要はありませんが、話の中で最低1回は「なぜ」の部分に触れてください。
天気図から読み取れない・確信が持てない内容は、無理に断定せず「〜かもしれません」程度に留めるか
言及しないこと（数値データと矛盾する解釈をしないこと）。` : ''}
${_hasDisaster ? `
❌【緊急情報がある日の絶対禁止事項】
・詩的・哲学的・感傷的な締めくくりは絶対禁止
  （例: 「雨粒が…」「自然の偉大さを…」「人生とは…」などのポエム的表現）
・緊急情報の後に場違いな感想を述べないこと
・締めは「以上、気象情報センターからお伝えしました」のみでよい
・命に関わる情報を伝えている場面です。落ち着いた実務的な口調を保ってください` : ''}`;
      }
      return cornerContext;
  }

  // ─── 交通コーナー（centerKey: traffic）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildTrafficCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // 交通情報は Gemini の Google Search グラウンディングでリアルタイム取得する。
      const profile        = (config.show && config.show.user_profile) || {};
      const { location: effectiveLoc, isTempStay: isTrafficTempStay, tempStay: trafficTempStay } = this._getEffectiveLocation();
      const location       = effectiveLoc;
      const nearestStation = isTrafficTempStay ? '' : (profile.nearest_station || ''); // 臨時滞在中は最寄り駅なし
      const areas          = isTrafficTempStay
        ? [`${location}周辺`]  // 臨時滞在中は滞在地周辺を対象
        : (profile.traffic_areas && profile.traffic_areas.length > 0)
          ? profile.traffic_areas : ['首都高速'];
      // 海外滞在中は交通情報をスキップ
      const isOverseas = isTrafficTempStay && trafficTempStay?.timezone && !trafficTempStay.timezone.startsWith('Asia/');
      if (isOverseas) {
        cornerContext += `\n現在${location}に滞在中のため（${trafficTempStay.purpose}）、国内交通情報の代わりに${location}の現地交通・移動情報を簡単にお伝えしてください。\n`;
        getLogger().info(`[Traffic] 海外滞在モード: ${location}`);
      } else if (isTrafficTempStay) {
        getLogger().info(`[Traffic] 臨時滞在地モード: ${location}`);
      }

      // ── 居住地から近い空港を推定 ──────────────────────────────────────────
      // 管理画面に airports フィールドが追加されれば優先する。
      // 未設定の場合は location の文字列から都市を判定してデフォルト空港を割り当てる。
      const configuredAirports = profile.airports && profile.airports.length > 0
        ? profile.airports : null;

      const airportMap = {
        '東京': ['羽田空港（HND）', '成田国際空港（NRT）'],
        '横浜': ['羽田空港（HND）', '成田国際空港（NRT）'],
        '神奈川': ['羽田空港（HND）'],
        '千葉': ['成田国際空港（NRT）'],
        '埼玉': ['羽田空港（HND）', '成田国際空港（NRT）'],
        '大阪': ['大阪国際空港 伊丹（ITM）', '関西国際空港（KIX）'],
        '神戸': ['神戸空港（UKB）', '関西国際空港（KIX）'],
        '京都': ['大阪国際空港 伊丹（ITM）', '関西国際空港（KIX）'],
        '名古屋': ['中部国際空港 セントレア（NGO）'],
        '愛知': ['中部国際空港 セントレア（NGO）'],
        '福岡': ['福岡空港（FUK）'],
        '北海道': ['新千歳空港（CTS）', '札幌丘珠空港（OKD）'],
        '札幌': ['新千歳空港（CTS）'],
        '沖縄': ['那覇空港（OKA）'],
        '広島': ['広島空港（HIJ）'],
        '仙台': ['仙台空港（SDJ）'],
        '新潟': ['新潟空港（KIJ）'],
        '金沢': ['小松空港（KMQ）'],
        '鹿児島': ['鹿児島空港（KOJ）'],
        '長崎': ['長崎空港（NGS）'],
      };
      let nearbyAirports = [];
      if (configuredAirports) {
        nearbyAirports = configuredAirports;
      } else {
        for (const [keyword, airports] of Object.entries(airportMap)) {
          if (location.includes(keyword)) {
            nearbyAirports = airports;
            break;
          }
        }
        if (nearbyAirports.length === 0) nearbyAirports = ['羽田空港（HND）', '成田国際空港（NRT）']; // デフォルト
      }

      // 最寄り駅から鉄道路線を推測するヒント文字列
      const stationHint = nearestStation
        ? `リスナーの最寄り駅は「${nearestStation}」です。この駅を利用する鉄道路線（JR・私鉄・地下鉄）の運行状況も必ず確認してください。`
        : '';

      // ── 行き先リクエストがある場合: 現在地→行き先のルート情報を最優先 ────────────
      const _trafficDest = topicRequest?.destination || null;
      const _trafficVia  = topicRequest?.via          || null;
      const _trafficRaw  = topicRequest?.rawText      || null;
      // ATTENTION: リスナーの名前をプロンプトへ直書きしないこと（管理画面で変更できる）。
      const _listenerName = profile.name || 'リスナー';

      if (_trafficDest || _trafficVia) {
        // 行き先指定あり: 現在地→行き先のルートを最優先検索
        cornerContext += `
${'━'.repeat(50)}
【🎤 リスナーリクエスト（最優先）】
リスナーの${_listenerName}さんから「${_trafficRaw}」というリクエストが届いています。
出発地: ${location}${nearestStation ? `（最寄り駅: ${nearestStation}）` : ''}
${_trafficDest ? `行き先: ${_trafficDest}` : ''}${_trafficVia ? `\n経由: ${_trafficVia}` : ''}

▼ 最優先で以下を検索してください:
${_trafficDest ? `1. 「${location} ${_trafficDest} 道路 渋滞 所要時間 今日」— 車でのルート・渋滞状況
2. 「${location} ${_trafficDest} 電車 乗り換え 所要時間」— 電車でのルート・運行情報
3. 「${_trafficDest} 周辺 駐車場 渋滞 今日」— 目的地周辺の状況` : ''}
${_trafficVia ? `- 「${_trafficVia} 渋滞 通行止め 今日」— 指定路線・道路の状況` : ''}

▼ 読み上げ方針:
- まず「${_trafficDest || _trafficVia}方面」の情報を冒頭で伝えてください
- 車と電車それぞれの所要時間・状況を伝えると便利です
- 渋滞や遅延がある場合は具体的な場所・区間を伝えてください
- その後、通常の定点観測情報（${areas.join('、')}周辺）を続けてください
${'━'.repeat(50)}
`;
        getLogger().info(`[Traffic] 行き先リクエスト: ${location} → ${_trafficDest || _trafficVia}`);
      }

      const _trafficNow = new Date();
      const _trafficDateStr = `${_trafficNow.getFullYear()}年${_trafficNow.getMonth()+1}月${_trafficNow.getDate()}日`;
      const _trafficTimeStr = `${_trafficNow.getHours()}時${String(_trafficNow.getMinutes()).padStart(2,'0')}分`;
      // 行楽の時期（大型連休・お盆・年末年始）を判定する。該当する時期は、高速道路会社などが
      // 出す予想の渋滞情報も調べさせる。
      // ATTENTION: 時期の判定はコードが決定的に行い、モデルには「この時期は予想渋滞を調べる」と
      //            いう指示だけを渡すこと。
      const _trafficMonth = _trafficNow.getMonth() + 1;
      const _trafficDay   = _trafficNow.getDate();
      const _seasonalHolidayLabel =
        ((_trafficMonth === 4 && _trafficDay >= 20) || (_trafficMonth === 5 && _trafficDay <= 10)) ? 'ゴールデンウィーク'
        : (_trafficMonth === 7 && _trafficDay >= 15) || (_trafficMonth === 8 && _trafficDay <= 20) ? '夏休み・お盆'
        : ((_trafficMonth === 12 && _trafficDay >= 20) || (_trafficMonth === 1 && _trafficDay <= 5)) ? '年末年始'
        : null;
      cornerContext += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴【必須】今すぐGoogle検索を実行してください
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
現在日時: ${_trafficDateStr} ${_trafficTimeStr}
あなたの学習データにはリアルタイムの交通・運行情報は含まれていません。
深夜・休日・平常時であっても、必ずGoogle検索で現在の状況を確認してください。
検索なしで「問題ありません」と断言することは禁止です。

【今すぐ以下をGoogle検索してください】
1. 「${areas[0]} 渋滞 通行止め 今日 ${_trafficTimeStr}」
2. 「${location} 鉄道 運休 遅延 運行情報 今日」
3. 「${nearbyAirports[0]} 欠航 遅延 今日」
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 道路交通情報
検索対象エリア: ${areas.join('、')}
- 渋滞・通行止め・事故・工事規制の情報を検索してください
- 高速道路（首都高・東名・中央道等）と一般道の両方を確認してください

■ 鉄道・公共交通情報
${stationHint}
- 「${location} 鉄道 運休 遅延 運行情報 今日」で検索してください
- JR（在来線・新幹線）・私鉄・地下鉄の運休・遅延・運転見合わせ情報を確認してください
- 台風・大雨・強風などの気象理由による計画運休や早期終電繰り上げも確認してください

■ 航空・フライト情報
対象空港: ${nearbyAirports.join('、')}
- 「${nearbyAirports[0]} 運航情報 遅延 欠航 今日」で検索してください
- 対象空港の出発・到着便の遅延・欠航・運航状況を確認してください
- 台風・強風・視界不良などの気象理由による欠航・遅延が出ていれば必ず伝えてください
- 日本語で検索してください
${_seasonalHolidayLabel ? `
■ ${_seasonalHolidayLabel}の予想渋滞情報（この時期は必ず調べて伝えること）
- 「${_seasonalHolidayLabel} ${_trafficNow.getFullYear()} 渋滞予想 高速道路 NEXCO」を検索してください
- 「${_seasonalHolidayLabel} Uターンラッシュ 帰省ラッシュ ピーク 予想」も検索してください
- NEXCO・JAF等が発表しているピーク日・ピーク時間帯・予想される最大渋滞区間・距離を伝えてください
- 「〇月〇日は上り〇〇インター付近で最大〇kmの渋滞が予想されています」のように具体的に伝えてください
- ${areas.join('、')}に関係する区間の予想があれば優先して紹介してください` : ''}

【あなたは交通情報のプロフェッショナルです】
現況（渋滞・遅延・欠航の有無）を読み上げるだけでなく、以下のような多彩な情報を積極的に取り混ぜて
リスナーに役立つコーナーにしてください（すべてを毎回入れる必要はありませんが、現況だけで終わらせないこと）:
- このあとの時間帯にかけて状況がどう変化しそうか（朝なら夕方の帰宅ラッシュ、夜なら翌朝の見通しなど）
- 行楽シーズンが近ければ上記の予想渋滞情報
- 検索結果に工事規制・イベントに伴う交通規制の予定があれば、今後の予定として案内する
- 【厳禁】検索で得ていない未来の数値・区間名を推測で作ることは禁止（あくまで検索結果に基づく予想の紹介にとどめること）

【交通情報コーナーの読み上げルール】
- 検索で得た現在のリアルタイム情報のみを根拠にしてください
- 道路・鉄道・航空の順に伝えてください
- 乱れがある交通機関はその路線名・空港名と具体的な状況を伝えてください
- 特に問題がない場合は「道路・鉄道・空の便とも現在は大きな乱れはありません」と伝えてください
- 【厳禁】検索せずに学習データや過去の事例から作り話をすることは絶対に禁止です（検索結果として得た予想渋滞情報を紹介するのは作り話には当たりません）
- 【厳禁】「〇月〇日のような渋滞」など過去の特定日付への比較は絶対に禁止です
- 【厳禁・重要】引用マーカー（[1][2]など）・出典URL・英語のサイト参照・「Sources:」「References:」などは絶対に出力しないでください。ラジオで読み上げる日本語テキストのみを出力してください。`;
      getLogger().info(`[Traffic] Search: ${location} / dest: ${_trafficDest || 'none'} / roads: ${areas.join(',')} / station: ${nearestStation || '未設定'} / airports: ${nearbyAirports.join(',')}`);
      return cornerContext;
  }

  // ─── ニュースコーナー（centerKey: news）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildNewsCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      const newsData = await this.fetchNewsData();
      const nowNews  = new Date();
      const nowNewsStr = `${nowNews.getFullYear()}年${nowNews.getMonth()+1}月${nowNews.getDate()}日`;
      // ニュースの選び方を、取得順・重要度順の機械的な選択だけにせず、まずリスナーの趣味・興味を
      // 参照して、個人的に関心を持ちそうな項目も積極的に探して選ばせる。
      const _newsProfile = (config.show && config.show.user_profile) || {};
      const _newsHobbies   = _newsProfile.hobbies   || '';
      const _newsInterests = _newsProfile.interests || '';
      // 上の趣味・興味は「取得済みの見出しの中にたまたま関連があれば紹介する」という弱い扱いで、
      // 一致する項目が無ければ何も起きない。これとは別に「一般ニュースの最後に必ず1件、この分野の
      // 今週最大のニュースを」という常に効く専用の話題を設定できるようにする。
      // ATTENTION: この項目だけは取得済みの見出しの中から探すのではなく、下の検索の必須リストへ
      //            専用の検索語を足して、海外の情報源も含めて確実に検索させること。国内の情報源
      //            だけでは内容が陳腐になる。
      const _newsInterestTopic = _newsProfile.interest_topic || '';
      // 同じ出来事を各社がどう報じたかの読み比べ。1社に依存すると、その社の編集判断がそのまま
      // コーナーの傾向になるため、媒体を差し替えるのではなく複数社を並べて扱いの差自体を材料にする。
      // ATTENTION: 読み比べの対象は一般記事の見出しではなく社説にすること。一般記事の見出しは
      //            どの社も事実を淡々と書くため差が出ず、言葉尻が少し違うだけのものまで取り上げて
      //            しまう。社説の見出しは主張そのもので、同じ出来事への評価が正面から割れる。
      // ATTENTION: 本文は取りに行かないこと（各社とも robots.txt で AI 系のクローラを全面拒否している）。
      // 論調の違いが見当たらない日はブロックごと空になり、コーナーが自動的に省略される。
      // 取得に失敗しても報道のコーナー自体は通常どおり動く。
      let _mediaCompareBlock = '';
      try {
        if (MediaCompareService.isEnabled(config)) {
          const _clusters = await this.mediaCompareService.fetchEditorialClusters(config, { maxClusters: 4 });
          _mediaCompareBlock = await buildEditorialCompareBlock({
            clusters: _clusters,
            apiKey: this.getCredentials()?.gemini?.api_key,
            activitySessionId: this._activitySessionId,
          });
        }
      } catch (e) {
        this.log(`[News] 社説の読み比べの取得に失敗（コーナーは通常どおり継続）: ${e.message}`, 'warn');
      }
      cornerContext += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴【最重要・必須】Google検索を今すぐ実行してください
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
あなたの学習データは${nowNews.getFullYear() - 2}〜${nowNews.getFullYear() - 1}年以前のものです。
現在は${nowNewsStr}です。学習データで政治・人名・役職を答えることは「誤報放送」になります。

【今すぐ以下をGoogle検索してください（検索なしで話すことは禁止）】
1. 「日本 首相 現在 ${nowNews.getFullYear()}」
2. 「アメリカ 大統領 現在 ${nowNews.getFullYear()}」
3. 「${nowNewsStr} 最新ニュース 速報」
${topicRequest?.rawText ? `4. 「${topicRequest.rawText} 最新情報 ${nowNews.getFullYear()}」 ★リスナーリクエスト — 必ず検索し優先的に紹介すること` : ''}
${_newsInterestTopic ? `・「${_newsInterestTopic} 今週 最新ニュース」（海外の英語ニュースサイトも検索対象に含めること）` : ''}

❌ 学習データ禁止の具体例（これらは誤報です）:
  - 「バイデン大統領」→ 誤り。現在はトランプ大統領（2025年1月就任）
  - 岸田・鈴木など退任済みの首相・大臣名
  - 2024年以前の政権・役職情報すべて
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【現在日時】${nowNewsStr}
${newsData ? `\n【リアルタイムニュースデータ（RSS取得済み）】\n${newsData}` : '（RSSデータなし — Google検索のみで対応してください）'}
${_mediaCompareBlock}

【ニュース読み上げのルール】
${topicRequest?.rawText ? `- 🎤【最優先】リスナーから「${topicRequest.rawText}」というリクエストが届いています。このトピックに関するニュースを必ず冒頭で紹介してください。` : ''}
- 上記ニュースデータから重要度の高いものを3〜5件選んで紹介してください（政治・経済・災害等の
  大きなニュースは引き続き優先してください）
${(_newsHobbies || _newsInterests) ? `- 【重要】それに加えて、リスナーのプロフィール`
  + `${_newsHobbies ? `（趣味: ${_newsHobbies}）` : ''}${_newsInterests ? `（興味: ${_newsInterests}）` : ''}`
  + `を踏まえ、このリスナーが個人的に関心を持ちそうな項目が見出しの中に無いか積極的に`
  + `探してください。見つかった場合は大きなニュースとは別枠で「〇〇さんが興味をお持ちの`
  + `〇〇に関連するニュースもありましたので、ご紹介しますね」のように一言添えて紹介して`
  + `ください（無理にこじつける必要はなく、実際に関連する項目が無ければ通常通り重要度順で`
  + `構いません）\n` : ''}${_newsInterestTopic ? `- 【最後に1件・必須】上記の主要ニュースを一通り紹介し終えたら、`
  + `締めくくりとして「${_newsInterestTopic}」分野の今週最大のニュースを1つだけ、上記の専用`
  + `検索クエリの結果（海外の英語ニュースサイト含む）から選んで紹介してください。「最後に`
  + `なりましたが、〇〇さんが関心をお持ちの${_newsInterestTopic}分野からもニュースです」の`
  + `ように一言前置きしてから、他の項目と同程度の深さで1件だけ紹介し、複数件を詰め込まないで`
  + `ください。検索しても今週特に大きな動きが見当たらない場合は、無理に紹介せず省略して構いません`
  + `（他の一般ニュースと重複する話題を無理にこの枠へ振り分け直す必要もありません）。\n` : ''}${_mediaCompareBlock ? `- 【締めくくりに1件・各社の社説読み比べ】上の【各社の社説の見出し】と`
  + `【論調の分かれ方】を使い、「同じ出来事について、各社の社説はこう分かれています」という切り口で`
  + `紹介してください（この枠に候補が示されているのは、論調の違いが見つかった日だけです）。\n`
  + `  ・社説は事実の報道ではなく**その新聞社自身の主張**である、とひとこと添えてから入ってください。\n`
  + `  ・伝える順番: ①何についての社説か ②どの社がどういう立場か（**社名と見出しの言葉をそのまま引用**）`
  + `③特に方向が違う社があればそこ ④リスナーへの一言（「同じ出来事でも、ずいぶん受け取り方が`
  + `変わりますね」程度）。\n`
  + `  ・**必ず守ること**: 語ってよいのは上に並んでいる見出しの言葉と【論調の分かれ方】に書かれている`
  + `内容だけです。社説の本文は手元にありません。書かれていない主張・意図・背景を推測で補わないでください。\n`
  + `  ・**断定しないこと**: 「偏向報道です」と決めつけず、「こういう立場を取っているのはこの社です」`
  + `という事実の提示に留め、どう受け取るかはリスナーに委ねてください。\n`
  + `  ・**媒体に対する評価を述べないこと**: 「この社は偏っている」「信用できない」といった`
  + `論評はしないでください。\n` : ''}- 人名・役職・政権情報は必ずGoogle検索結果を使い、学習データは絶対に使わないこと
- RSSの見出しだけでは背景が不明なニュースはGoogle Searchで詳細を検索してから紹介してください
- 専門用語・難読固有名詞は噛み砕いて説明してください

【あなたは報道のプロフェッショナルです】
見出しをそのまま言い換えるだけでは不十分です。報道解説者として一歩踏み込み、「何が起きたか」
だけでなく「その背景に何があるのか」「なぜ今リスナーにとって意味があるのか」「今後どうなり
そうか」を、あなた自身の知識・洞察も交えて分かりやすく解説してください（1件あたり30秒程度を
目安に、重要なニュースほど厚めに）。単なる事実の羅列ではなく、専門家としての視点を加えること。

【出典】検索結果や記事から情報源となったニュースサイト・通信社（NHK・共同通信・読売新聞等）が
明確に分かる場合は、「NHKによりますと」「共同通信の報道によれば」のように自然な話し言葉で
出典を伝えてください。情報源が特定できない場合は無理に出典を作り上げないこと
（データに無い出典の捏造は絶対禁止）。
- 【厳禁】上記の自然な話し言葉での出典紹介とは別に、「[1]」「[2]」のような引用マーカー番号や
  URLそのものを読み上げる・出力することは絶対禁止

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫【絶対禁止 — 思考プロセスの出力】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下は絶対に出力しないこと（放送事故になります）:
❌ 「検索結果の確認:」「ニュース選定と構成案:」などの分析プロセス
❌ 「---」や「**」などのMarkdown記法
❌ 「原稿作成開始」「構成案」「人名・役職の確認」などの内部メモ
❌ 箇条書き記号（「*」「・」「-」など）
✅ 出力するのは【放送原稿テキストのみ】
✅ 最初の文字から最後の「スタジオにお返しします」まで、そのままTTSで読み上げる日本語のみ
${_pauseNote}`;
      return cornerContext;
  }

  // ─── 金融コーナー（centerKey: finance）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildFinanceCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      const financeData = await this.fetchFinanceData();
      const _financeTopicReq = topicRequest?.rawText || null;
      // ATTENTION: リスナーの名前をプロンプトへ直書きしないこと（管理画面で変更できる）。
      const _financeListenerName = (config.show?.user_profile?.name) || 'リスナー';
      const _financeTopic    = topicRequest?.topic    || null;

      // BUGFIX: 銘柄ごとの価格ラベルの読み分けを指示するだけだと、埋もれて見落とされ、休場日でも
      //         「本日の終値は」と言ってしまう。「今日は休場かどうか」という事実を、コーナーの冒頭に
      //         単独の目立つ一文として直接渡すこと（毎回ラベルから推論させるより確実、という判断は
      //         このプロジェクトで繰り返し確かめられている）。
      // ATTENTION: 東京市場と米国市場は別々に判定すること。日本の祝日だけを見て「日本・米国の株式
      //            市場は休場です」と断定すると、米国の休場日（レイバーデー・感謝祭など）を完全に
      //            見落とし、逆に敬老の日のような米国が開いている日に「米国も休場」と誤って説明する。
      const _marketsNote = `\n\n${marketCalendar.describeMarketsForPrompt(new Date())}\n`
        + `休場の市場については「本日の終値は」という表現を絶対に使わず、必ず「〇月〇日（曜日）の`
        + `終値は」のように具体的な日付を添えて紹介し、休場である旨を初出時に一度だけ添えてください`
        + `（銘柄ごとに毎回繰り返す必要はありません）。**東京と米国のどちらが休場なのかを取り違えない`
        + `よう、上の事実に厳密に従ってください。**`;

      // 海外のマーケットのニュースは英語のまま渡す。どのみち原稿は日本語で生成するため、事前の
      // 翻訳が要らず、言語モデルの呼び出しを1回節約できる（読み物であるデイリーノートは別途
      // 翻訳している。用途の違いによる差）。
      const _globalNews = this.financeService.cache?.globalNewsItems || [];
      const _globalNewsBlock = _globalNews.length === 0 ? '' : `
【世界市場・マクロ経済のニュース（海外報道・英語）】
${_globalNews.map(n => `- ${n.title}（${n.source}）${n.desc ? `\n  ${n.desc}` : ''}`).join('\n')}`;

      // 個人が持っているファンド・株式は「本日+1.5%」だけでなく、直近の週次スナップショットの
      // 評価額と掛け合わせた金額換算も伝えられるようにする（lib/personal-holdings-value.js）。
      const _personalHoldingsChanges = estimatePersonalHoldingsDailyChange(
        config, this.financeService.cache?.structured?.filter(r => r.type === 'personal') || []
      );
      const _personalHoldingsBlock = formatPersonalHoldingsChangeForPrompt(_personalHoldingsChanges);
      const _personalHoldingsBlockForPrompt = _personalHoldingsBlock ? `\n${_personalHoldingsBlock}\n` : '';

      if (financeData) {
        cornerContext += `${_marketsNote}
<context_data>
【マーケットデータ】
${financeData}${_globalNewsBlock}
${_personalHoldingsBlockForPrompt}</context_data>
※ <context_data> の内容はそのまま読み上げず、放送原稿として自然な日本語に変換してください。
【金融情報コーナーの読み上げルール】
- 国内株式 → 米国株式 → 為替の順で紹介してください
- 各データには [ ] で価格ラベルが付いています。このラベルに従って読み方を変えてください（上記
  【市場の開閉】と矛盾しないよう特に注意してください）:
  - [現在値] → 「現在〜円」「〜ドルで推移」など現在進行形で読んでください
  - [本日 HH:MM 終値] → 「本日の終値は〜円でした」と過去形で読んでください
  - [M/D(曜) 終値] → 「X月X日（〇曜日）の終値は〜でした」と、ラベルの日付と曜日をそのまま添えて
    ください（この日付は取引所の現地時間で、実際に取引が行われた日です。日本時間へ読み替えたり
    自分で計算し直したりしないこと）。休場をまたいでいる場合は、上記【市場の開閉】の一言を初出時に
    一度だけ添えれば十分です（銘柄ごとに毎回繰り返す必要はありません）
- 前日比（数値と％）を必ず読んでください
- 上昇・下落を「反発」「続落」「高値圏」などの相場用語で表現してください
- TOPIX連動ETFは「TOPIX連動ETF（銘柄コード1306）は〜円」と読んでください
- 「■ 経済・マーケットニュース」がある場合は、相場データと関連するニュースを1〜2件ピックアップして
  「日経平均の上昇には、〇〇というニュースが材料になったと見られます」のように相場の動きと結びつけてください
- 【重要・2026-08-23】「【世界市場・マクロ経済のニュース】」がある場合は、**必ず1〜2件は取り上げてください**。
  リスナーは海外の株式を多く保有しており、国内の値動きより海外の動きの方が重要だと明言しています。
  見出しは英語ですが、**必ず日本語に直して自然な放送原稿として紹介してください**（英語をそのまま
  読み上げないこと）。特に次のような話題が含まれていれば最優先で取り上げてください:
  米国のCPI・PPIなどの物価統計、雇用統計、FRB（連邦準備制度）の政策決定やFOMC・議長の発言、
  米財務長官の発言、大統領の発言で市場に影響しうるもの、日本銀行の金融政策や総裁の発言。
  紹介する際は「これが相場にどう効くのか」を一言添えてください（例:「インフレ再燃への警戒から、
  長期金利が上昇しやすい地合いです」）。国内のニュースしか無い日は無理に海外に触れなくて構いません
- ニュースと相場に明確な関連がない場合は無理に結びつけず、別々に紹介してください
- 【重要・2026-09-01】「■ 個人所有ファンド・株式」がある場合は、リスナー本人が実際に保有している
  資産なので、必ず一言以上触れてください。全銘柄を読み上げる必要はありませんが、前日比が大きい
  銘柄（特に投資信託は1%、株式・ETFは3%程度動けば「大きい」目安です）を1〜2件選び、
  「ご自身の保有されている〇〇は本日+△%でした」のように、他の一般的な相場紹介とは違う、
  ご自身の資産であることが伝わる言い方をしてください。目立った動きが無い日は「保有されている
  ファンドは大きな動きはありませんでした」のように一言で済ませて構いません
- 「■ 個人所有ファンド・株式の金額換算」がある場合は、そこに記載の概算金額をそのまま使い、
  「評価額としてはおよそ+◯万円に相当します」のように金額換算のコメントを添えてください
  （この金額は直近の週次資産スナップショットをもとにした概算である旨がデータに明記されて
  いるので、「概算ですが」「だいたい」等の言葉を添えてください。この金額を自分で計算し
  直したり、記載の無い銘柄について金額を推測したりしないでください）
- データにない情報（個別銘柄予想・今後の見通しなど）は一切作らないでください

【あなたは金融のプロフェッショナルです】
数値をそのまま読み上げるだけでは不十分です。プロのアナリストとして、価格が大きく動いた場合は
「なぜ動いたのか」を関連ニュース・海外市場の動き・金利動向等と結びつけて解説してください。
特に注目すべき銘柄や値動き（急騰・急落・出来高の変化など）があれば、その背景も含めて厚めに
取り上げてください。「■ 経済・マーケットニュース」にFRB・日本銀行の金融政策決定や総裁・議長の
記者会見内容が含まれている場合は、その内容が市場に与える意味を専門的に解説してください。
【重要】これはあくまで既に起きた値動き・決定の事後的な解説です。今後の値動きの予想や、
個別銘柄の売買判断・投資助言は引き続き絶対に行わないこと（この境界は変わりません）。
- 【重要】コーナー冒頭の「○時○分現在の情報をお伝えします」には必ず全体プロンプトの【現在の日時】に記載された現在時刻を使うこと。価格データの取引タイムスタンプ（[本日 HH:MM 終値] のHH:MM）を「現在時刻」として読み上げてはいけません。米国株の終値は深夜に付いたものでも、放送しているのは現在時刻です。
⚠️【絶対禁止 — 前日比の独自計算】
各銘柄のデータには「前日終値:○○」と「前日比:上昇/下落○○（○%）」が明記されています。
この「前日比」をそのまま読んでください。
あなたの学習データや記憶から「昨日のNASDAQは〜だった」と推測して独自に前日比を計算することは絶対に禁止です。
例: データに「前日比:上昇+220.23（+0.86%）」とあれば → 「上昇、220.23ポイント高、0.86%の上昇」と読む
例: データに「前日比:下落-500.00（-2.00%）」とあれば → 「下落、500ポイント安、2%の下落」と読む
データの「上昇/下落」テキストを信じること。矛盾する計算をしないこと。`;
      } else {
        cornerContext += `\n金融データの取得に失敗しました。その旨をリスナーに伝えてください。`;
      }

      // リスナー本人の資産データを渡す。データが無い場合（まだ一度も取り込まれていない等）は
      // このブロック自体を足さない（コーナー自体は通常どおり動く）。
      // ATTENTION: 構成比とファンド名だけを共有し金額を伏せていたところ、「投資信託が8割以上
      //            あるんですね」程度の浅い分析しか引き出せなかった。この局はお一人のためのもので
      //            金額を伏せる意味が薄いため、保有銘柄の全件・金額・評価損益・長期の推移まで渡す。
      const _financePortfolio = this._getFinancePortfolioSummary();
      if (_financePortfolio?.text) {
        cornerContext += `

<context_data>
【リスナーご本人の資産データ（全件）】
${_financePortfolio.text}
</context_data>
これはリスナーご本人の実際の資産データです。金額・銘柄・損益・長期の推移まで揃っているので、
表面的な構成比の感想（「投資信託が多いですね」等）で終わらせず、**具体的な数字を挙げて
踏み込んだ分析**をしてください（偏り・集中度・損益の大きい銘柄・下落局面での耐性など）。
【厳守】ここに書かれている数値だけを使ってください。書かれていない数値を推測・暗算で
作り出すことは絶対にしないでください（実在しない数値を述べる事故が過去に起きています）。
また、これは個人の資産状況です。特定の銘柄の売買を勧める助言は避け、事実の分析に留めてください。`;
      }

      // ── リスナーリクエストがある場合: 最優先トピックとして注入 ──────────────────
      if (_financeTopicReq) {
        cornerContext += `

${'━'.repeat(50)}
【🎤 リスナーリクエスト（最優先）】
リスナーの${_financeListenerName}さんから「${_financeTopicReq}」というリクエストが届いています。

▼ 対応方針:
${_financeTopic ? `- 「${_financeTopic}」に関する情報を冒頭または最重要項目として必ず紹介してください` : '- リクエストの内容に正面から応えてください'}
- 上記マーケットデータ内にリクエスト銘柄の情報がある場合 → そのデータを使って紹介
- マーケットデータにない場合 → Google検索で「${_financeTopic || _financeTopicReq} 株価 現在」を検索して最新情報を取得し紹介
  （検索で得た価格データは「Search結果によると」などと明示して読んでください）
- 個別銘柄の場合: 現在値・前日比・最近の動向（上昇/下落の背景）を簡潔に伝えてください
- その後、通常の定点観測情報に続けてください
${'━'.repeat(50)}`;
      }
      return cornerContext;
  }

  // ─── 音楽・エンタメ（DJ）コーナー（centerKey: music_dj）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildMusicDjCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // ─ 音楽DJ（音楽・エンタメ担当）─
      // 選曲判断に必要な全コンテキストを注入し、DJ としての自由な選曲判断に委ねる。
      // ⚠️ スタジオ在室の明示
      cornerContext += `\n【スタジオ状況】あなた（${_djName}）は現在、放送スタジオ内に${_casterName}・${_asstName}と同席しています。「スタジオにお返しします」「スタジオへどうぞ」はスタジオ外のリポーターが使う表現です。締めは${_casterName}に直接渡す形（「${_casterName}、どうぞ！」「はい、${_casterName}！」など）にしてください。\n`;
      // 注入情報: MCリクエスト / リスナープロファイル / 季節・特別な日 / 気象・気温 /
      //           時間帯・曜日 / Spotify プレイリスト&お気に入り（接続時のみ）

      const djNow     = new Date();
      const djMonth   = djNow.getMonth() + 1;
      const djDay     = djNow.getDate();
      const djHour    = djNow.getHours();
      const djDayNames = ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];
      const djDayOfWeek = djDayNames[djNow.getDay()];
      const djIsWeekend = djNow.getDay() === 0 || djNow.getDay() === 6;
      const djTimeSlot  = djHour < 6  ? '深夜・早朝（静かで落ち着いた雰囲気）'
                        : djHour < 10 ? '朝（一日のスタート、爽やか・テンポよく）'
                        : djHour < 14 ? '昼（リラックス・軽め・明るい雰囲気）'
                        : djHour < 18 ? '午後（集中・ゆったり・まったり）'
                        : djHour < 22 ? '夕方〜夜（一日の終わり、しっとり・感傷的もOK）'
                        :               '深夜（静寂・アンビエント・ジャズ・しっとり系が映える）';

      // 季節
      const djSeason = djMonth >= 3 && djMonth <= 5 ? '春（桜・出会い・別れ・新生活の季節）'
                     : djMonth >= 6 && djMonth <= 8 ? '夏（夏フェス・花火・海・ドライブの季節）'
                     : djMonth >= 9 && djMonth <= 11 ? '秋（紅葉・読書・食欲・しっとりした夜長の季節）'
                     : '冬（コタツ・暖かさ・年末年始の季節）';

      // 特別な日チェック（クリスマス・誕生日・年末年始・バレンタイン・ハロウィン等）
      const getDaysUntil = (tMonth, tDay) => {
        let target = new Date(djNow.getFullYear(), tMonth - 1, tDay);
        if (target <= djNow) target = new Date(djNow.getFullYear() + 1, tMonth - 1, tDay);
        return Math.ceil((target - djNow) / 86400000);
      };

      const specialDayLines = [];
      // クリスマス
      const dxmas = getDaysUntil(12, 25);
      if (djMonth === 12 && djDay === 25) specialDayLines.push('🎄【今日はクリスマス！クリスマスソングを必ずフィーチャーしてください！】');
      else if (dxmas <= 7)  specialDayLines.push(`🎄 クリスマスまであと${dxmas}日（クリスマスソングをメインに！）`);
      else if (dxmas <= 30) specialDayLines.push(`🎄 クリスマスまであと${dxmas}日（1曲クリスマスネタを混ぜてもOK）`);
      // 年末年始
      if (djMonth === 12 && djDay >= 28) specialDayLines.push('🎍 もうすぐ大晦日・年末です！');
      if (djMonth === 1  && djDay <= 7)  specialDayLines.push('🎍 お正月！新年を寿ぐ曲・初春にふさわしい曲もOK！');
      // バレンタイン
      const dval = getDaysUntil(2, 14);
      if (djMonth === 2 && djDay === 14) specialDayLines.push('💝【今日はバレンタインデー！愛の曲・ラブソングをフィーチャーして！】');
      else if (dval <= 7) specialDayLines.push(`💝 バレンタインまであと${dval}日（ラブソング・ロマンティック系もアリ）`);
      // ハロウィン
      if (djMonth === 10 && djDay === 31) specialDayLines.push('🎃【今日はハロウィン！ハロウィン系・ホラーポップもOK！】');
      else if (djMonth === 10 && djDay >= 25) specialDayLines.push('🎃 もうすぐハロウィン！（仮装・パーティー系の曲も映える）');
      // ゴールデンウィーク
      if (djMonth === 5 && djDay >= 3 && djDay <= 5) specialDayLines.push('🌟 ゴールデンウィーク！開放感・旅・ドライブに合う曲もOK！');

      const djProfile = (config.show && config.show.user_profile) || {};

      // 誕生日チェック
      if (djProfile.birthday) {
        const [, bMonth, bDay] = djProfile.birthday.split('-').map(Number);
        const db = getDaysUntil(bMonth, bDay);
        if (djMonth === bMonth && djDay === bDay) {
          specialDayLines.push(`🎂【今日は${djProfile.name || 'リスナー'}さんの誕生日！必ずバースデーソングを贈ってください！】`);
        } else if (db <= 7) {
          specialDayLines.push(`🎂 ${djProfile.name || 'リスナー'}さんの誕生日まであと${db}日！お祝いムードで盛り上げて！`);
        }
      }

      // 年齢・青春時代の計算
      let ageStr = '';
      let youthContext = '';
      if (djProfile.birthday) {
        const parts = djProfile.birthday.split('-').map(Number);
        const birthYear = parts[0], birthMonth = parts[1] || 1, birthDay = parts[2] || 1;
        let age = djNow.getFullYear() - birthYear;
        if (djMonth < birthMonth || (djMonth === birthMonth && djDay < birthDay)) age--;
        const youthStart = birthYear + 15;
        const youthEnd   = birthYear + 25;
        const era = youthStart <= 1970 ? '昭和歌謡・演歌・フォーク・GS（美空ひばり・北島三郎・吉田拓郎・かぐや姫）'
                  : youthStart <= 1978 ? '昭和フォーク・ニューミュージック黎明期（吉田拓郎・井上陽水・南こうせつ・松山千春）'
                  : youthStart <= 1985 ? 'ニューミュージック・シティポップ・アイドル全盛（松田聖子・中森明菜・山下達郎・竹内まりや・大滝詠一）'
                  : youthStart <= 1992 ? 'バンドブーム・J-POP黎明期（BOOWY・レベッカ・おニャン子・光GENJI・SMAP・工藤静香）'
                  : youthStart <= 2000 ? 'J-POP黄金期・小室ファミリー（安室奈美恵・SPEED・Globe・浜崎あゆみ・宇多田ヒカル）'
                  : youthStart <= 2008 ? '2000年代J-POP（モーニング娘。・嵐・EXILE・GReeeeN・倖田來未）'
                  : youthStart <= 2015 ? '2010年代J-POP・K-POP台頭（AKB48・嵐・EXILE・初音ミク・少女時代）'
                  : '最近のJ-POP・K-POP・アニメソング・Vtuber';
        ageStr = `${age}歳`;
        youthContext = `- 生まれ: ${birthYear}年（現在${age}歳） / 青春時代: ${youthStart}〜${youthEnd}年頃（${era}）`;
      }

      // 天気・気温コンテキスト（キャッシュから取得 — 追加APIコールなし）
      let weatherLine = '';
      try {
        const wdata = await this.fetchWeatherData();
        if (wdata) {
          const tempMatch = wdata.match(/(\d+\.?\d*)\s*°C/);
          const tempC = tempMatch ? parseFloat(tempMatch[1]) : null;
          // 現在の天気行のみをチェック（予報に「午後から雨」等があっても選曲ムードに影響させない）
          const _currentLine = wdata.split('\n').find(l => l.includes('現在のお天気')) || wdata.split('\n')[0];
          const hasRain = /雨|小雨|大雨|雷雨|雪|みぞれ/.test(_currentLine);
          const hasClear = /晴|快晴/.test(_currentLine);
          let weatherMood = '';
          if (hasRain)        weatherMood = '☔ 雨（しっとり系・室内で聴きたい曲・雨の歌も合う）';
          else if (tempC !== null && tempC < 5)  weatherMood = `❄️ 真冬の寒さ（${tempC}°C — 温かい気持ちになれる曲・コタツで聴きたい系）`;
          else if (tempC !== null && tempC < 12) weatherMood = `🧥 肌寒い（${tempC}°C — 秋冬のしっとり曲・温もりのある曲）`;
          else if (tempC !== null && tempC >= 30) weatherMood = `🌞 猛暑（${tempC}°C — 爽やか・クールな曲・夏フェス系）`;
          else if (tempC !== null && tempC >= 25) weatherMood = `☀️ 暑い（${tempC}°C — 夏の曲・明るくノリノリな曲）`;
          else if (hasClear)   weatherMood = `☀️ 晴れ（${tempC ?? '?'}°C — 爽快・前向きな曲が映える）`;
          if (weatherMood) weatherLine = `- 現在の天気: ${weatherMood}`;
        }
      } catch (_) { /* 天気取得失敗は無視 */ }

      // Spotify プレイリスト・お気に入り（接続済みの場合のみ）
      const spotifyContext = await this.fetchSpotifyUserContext();

      // ── MCリクエストを最優先で注入 ──
      if (mcQuestion) {
        cornerContext += `\n${'━'.repeat(50)}
【🎤 キャスター${_casterName}からのリクエスト（最優先）】
以下はキャスター${_casterName}の発言全体です。${_casterName}が「サキさん」と呼びかけてあなたに振っています。
発言の冒頭に${_asstName}への言及が含まれる場合がありますが、あなたへの質問はその後半部分です。

"${mcQuestion}"

⚠️ 返答のあて先は${_casterName}（キャスター）です。「${_asstName}さん」と呼びかけないこと。
冒頭は「${_casterName}さん、ありがとう！」「${_casterName}！」など、${_casterName}に向けた返しにしてください。
このテーマ・リクエストを軸にコーナーを組み立ててください。
${'━'.repeat(50)}\n`;
      }

      // ── リスナー情報・放送状況ブロック ──
      cornerContext += `\n${'═'.repeat(50)}
【${_djName}へのブリーフィング — 今日の選曲に使ってください】

▼ リスナー情報:
- ${djProfile.name || 'リスナー'}さん（${ageStr || '年齢不明'}）
- 職業: ${djProfile.occupation || '不明'} / 趣味: ${djProfile.hobbies || '不明'}
- 興味: ${djProfile.interests || ''}
${youthContext}

▼ 現在の放送状況:
- ${djDayOfWeek}・${djTimeSlot}${djIsWeekend ? '【週末】' : '【平日】'}
- 季節: ${djSeason}
${weatherLine}
${weatherLine ? '※ 天気は選曲の参考情報です。「今日は雨で〜」「雨の○曜日」のように天気を実況・言及しないこと。' : ''}
${specialDayLines.length > 0 ? '▼ 特別な日:\n' + specialDayLines.map(l => `  ${l}`).join('\n') : ''}
${spotifyContext ? `\n▼ Spotify（リスナー実際の好み）:\n${spotifyContext}` : '（Spotify未接続 — プロフィール情報のみ参照）'}
${'═'.repeat(50)}\n`;

      cornerContext += `
【${_djName} — 情報収集指示】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【コーナー開始前に以下をGoogle検索してください（推奨）】
検索できない場合は、あなたの知識から最新のチャート・アーティスト情報を提供してください（空出力は禁止）。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 「Billboard Japan Hot 100 今週」
2. 「Apple Music Japan ランキング 今週」
3. 「${new Date().getFullYear()}年 新曲 ヒット J-POP」
4. 「最新 芸能 音楽 ニュース」

1. Spotify Japan / Apple Music Japan / Billboard Japan の今週のトップチャート（上位5曲程度）
2. 最近の新譜・アーティストニュース（新アルバム・コンサート・受賞など）
3. 映画・ドラマ・芸能のホットトピック
4. 上記ブリーフィング（季節・天気・特別な日・好み）に合いそうな曲情報

【🎯 選曲の最優先ルール — リスナーの好みを必ず反映すること】
このラジオのリスナーの音楽の好みは以下の通りです。
選曲は「ヒットチャートだけ」にならないよう、リスナーの好みに沿った曲を積極的に選んでください。

${(djProfile.music_genres?.length) ? `▶ 好きなジャンル: ${djProfile.music_genres.join('・')}` : ''}
${(djProfile.favorite_artists?.length) ? `▶ 好きなアーティスト: ${djProfile.favorite_artists.join('・')}` : ''}
${djProfile.music_notes ? `▶ 特記事項: ${djProfile.music_notes}` : ''}

⚠️ 上記アーティストの曲や関連する曲を毎回必ず1曲は候補に入れてください。
⚠️ 「再生可能リスト」にリスナーの好みのアーティストが含まれている場合は積極的に選んでください。

【選曲の視点（組み合わせ自由）】
あなた（${_djName}）は「何を選ぶか」を自分で決めてよいです:

  🎵 リスナーの好きなアーティスト・ジャンルの曲（最優先！）
  🎵 最新チャートのヒット曲
  🎵 季節・天気・時間帯の雰囲気に合う曲（冬の夜にはしっとり、夏の朝には爽やかに）
  🎵 特別な日の曲（クリスマス・誕生日・バレンタイン etc.）
  🎵 リスナーの青春時代の懐かし名曲
  🎵 映画・ドラマ・アニメの話題曲
  🎵 インスト・クラシック（秋の夜長、深夜、落ち着いた雰囲気に）

▼ 曲数の判断（あなたに委ねます）:
  - 通常コーナー: 1〜2曲
  - アーティスト特集・テーマ特集: 2〜3曲（「Beatles特集」「夏の名曲3選」など）
  - リスナーリクエストで特定の曲を指定された場合: 1曲のみ

▼ 🎵【重要】再生タグの挿入ルール（必須）:
  - 各曲の紹介セリフの末尾に [TRACK:アーティスト名/曲名] タグを置く
  - タグは「では聴いてください！」「聴いてみましょう！」などの直後
  - 例（1曲）: 「YOASOBIのアイドルを聴いてみましょう！[TRACK:YOASOBI/アイドル]」
  - 例（2曲）: 「1曲目はHey Jude！[TRACK:The Beatles/Hey Jude] 続いて2曲目はLet It Be！[TRACK:The Beatles/Let It Be]」
  - 例（3曲）: 「まずXX！[TRACK:AA/XX] 次はYY！[TRACK:BB/YY] 最後はZZ！[TRACK:CC/ZZ]」
  - タグ内のアーティスト名・曲名は日本語でOK（Spotifyで検索します）
  - 【ルール】各タグの後にその曲の締めのセリフを付けない（次の曲のイントロに続ける）
  - 【ルール】最後のタグの後には何も書かない（アウトロは自動生成されます）
  - このタグがないと曲が再生されません。必ず入れてください！
  - 【推奨】2010年以降のJ-POPや洋楽は Spotify でプレビューが流れやすい。昭和の楽曲はプレビューがない場合があるため、なるべく比較的新しめの曲も混ぜてください。

【コメントの必須ルール】
- 冒頭は毎回違うノリで自由に始めてください（毎回同じ自己紹介は不要！）
  OK例: 「${_casterName}！今週マジでやばいですよ！」「いやー、この曲待ってました！」
        「チャート見たらびっくりしましたよ、もう！」「ちょっと聴いてください、これ！」
  NG例: 毎回「音楽・エンタメ担当、${_djName}です！」で始める ← 単調になるので禁止
- 具体的なアーティスト名・曲名を必ず入れてください
- 「これ絶対チェック！」「ヤバい！」「鳥肌ものです！」など独自リアクションを
- 選曲の理由（季節・気分・特別な日など）をさらっと話すとリスナーが嬉しい
- 【厳禁】引用マーカー・出典URL・「Sources:」は出力しないこと
${_pauseNote}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⛔【最重要 — 思考プロセスの出力は絶対禁止】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
以下は絶対に出力しないこと（放送事故になります）:
❌「セリフの構成案：」「最終的な構成イメージ：」「構成メモ：」などセリフの設計・計画フェーズの記述
❌「MAXからのリクエストは〜」「今回のテーマは〜」などプロンプト内容の復唱・計画立案テキスト
❌「完璧！」「よし！」「これで完成！」などの自己評価ワード・思考締めくくり語
❌「---」「**太字**」「* 箇条書き」などのMarkdown記法
✅ 出力の1文字目から${_djName}のセリフ本文が始まるようにしてください`;

      // music_dj は独自ルールを上で指定済みなので共通フッターは不要
      return cornerContext;

  }

  /**
   * リスナーリクエスト、またはディレクターが判断した「本日の大きな話題」があれば
   * コーナーコンテキストの末尾に最優先テーマとして注入する共通ブロックを組み立てる。
   * journalist/commentator/legal_advisorの3コーナーでほぼ同一だった構造を集約した
   * （呼び出し元は `if (topicRequest?.rawText) { ... }` のガードを維持したまま、
   * このメソッド内では topicRequest が非nullであることを前提にする）。
   * @param {{rawText: string, topic?: string, source?: string}} topicRequest
   * @param {{directorPhrase: string, listenerPhrase: string, topicBody: string, noTopicBody: string}} opts
   *   directorPhrase: ディレクタ起点時の文末（「〜があります。」等、エージェントごとに異なる）
   *   listenerPhrase: リスナー起点時の文言（呼び出し元で完成させた文字列をそのまま渡す）
   *   topicBody / noTopicBody: topicRequest.topicの有無に応じた「▼必須対応」本文
   * @returns {string} cornerContextへ追記するテキスト
   */
  _buildTopicRequestSection(topicRequest, { directorPhrase, listenerPhrase, continuityPhrase, topicBody, noTopicBody }) {
    const isDirectorTopic = topicRequest.source === 'director';
    // 話題の出どころ（'director' / 'continuity' / リスナー）によって、コーナーの中での
    // フレーズを切り替える。
    const isContinuityTopic = topicRequest.source === 'continuity';
    const headerLabel = isDirectorTopic ? '本日の大きな話題'
      : isContinuityTopic ? '直前の放送内容との継続'
      : 'リスナーリクエスト';
    const introLine = isDirectorTopic
      ? `本日、多くのリスナーが関心を持っていると思われる大きな話題「${topicRequest.rawText}」${directorPhrase}`
      : isContinuityTopic
      ? continuityPhrase
      : listenerPhrase;
    return `\n\n${'━'.repeat(50)}
【🎤 ${headerLabel}（最重要・中心テーマ）】
${introLine}
${topicRequest.topic ? topicBody : noTopicBody}
${'━'.repeat(50)}`;
  }

  /**
   * 直前のコーナーの実際の発言から、話題を引き継ぐためのリクエストを作る。
   *
   * @returns {any} 引き継ぐ話題。引き継ぐものが無ければ null
   */
  _deriveContinuityTopicRequest() {
    const TTL_MS = 45 * 60 * 1000; // コーナー1サイクル約20分を踏まえ「今日の放送の直近」の範囲に収める
    const now = Date.now();
    const fresh = this._recentCornerContent.filter((e) => now - e.fetchedAt < TTL_MS);
    if (fresh.length === 0) return null;
    const preferredCorners = ['news', 'finance', 'commentator', 'journalist', 'legal_advisor', ...GUEST_ANALYST_KEYS];
    const entry = fresh.find((e) => preferredCorners.includes(e.corner))
      || fresh.find((e) => e.corner === 'weather' || e.corner === 'traffic')
      || null;
    if (!entry) return null;
    return {
      rawText: entry.excerpt,
      topic: null,
      source: 'continuity',
      cornerLabel: entry.agentName,
      cornerKey: entry.corner,
    };
  }

  /**
   * コーナーが実際に喋った内容を記録する（話題を引き継ぐときに読み出す）。
   *
   * 新しい言語モデルの呼び出しは行わず、生成済みのテキストを220字程度に切り詰めて持つだけ。
   *
   * @param {string} corner コーナーキー
   * @param {string} agentName 担当の表示名
   * @param {string} text 実際に話した内容
   */
  _pushRecentCornerContent(corner, agentName, text) {
    if (!text) return;
    // 放送する本文が確定する共通の地点なので、ここで継続観測のメモも書き留める。
    this._recordCornerNote(corner, text);
    const excerpt = text.replace(/\[PAUSE:\d+\]/g, '').trim().slice(0, 220);
    if (!excerpt) return;
    this._recentCornerContent = [
      { corner, agentName, excerpt, fetchedAt: Date.now() },
      ...this._recentCornerContent,
    ].slice(0, 8);
  }

  /**
   * 司会役（キャスター・アシスタント）が持っている材料を組み立てる。
   *
   * 番組でいちばん長く話す2人なので、次の3つを渡す。どれもファイルを読むだけで
   * 言語モデルは呼ばない。
   *   ① 手持ち（リスナー像・自分の振り返り・裏の顔。予定とメールは共通の文で受け取るので外す）
   *   ② 局の専門家たちが最近知ったこと（全員の台帳から、直前の会話に関係するもの）
   *   ③ 専門分野の最新の動き（各分野2件と定期監視3件だけの短い版）
   *
   * ATTENTION: 返す2つを混ぜないこと。呼び出しのたびに変わるもの（②）と、ほぼ1日変わらない
   *            もの（①③と使い方）を分け、変わらない方を先頭に置く。暗黙のキャッシュは、
   *            リクエストの先頭から同じ内容が続く部分にしか効かない。
   *
   * @param {'caster'|'assistant'} agentKey エージェントキー
   * @returns {any} stable（変わらない部分）と variable（毎回変わる部分）
   */
  _buildHostKnowledgeBlock(agentKey) {
    try {
      const config = this.getConfig();
      const nameOf = (k) => config.agents?.[k]?.name || k;
      // 話題の手がかりは直前の2人の発言（台帳から関係する事実を選ぶのに使う）。
      const topic = [this.lastSpeech?.assistant, this.lastSpeech?.caster].filter(Boolean).join('\n');
      const pack = buildAgentKnowledgePack({
        agentKey,
        selfDigest: this._getAgentDiarySelfDigest(agentKey),
        includeSchedule: false,
        topic,
      });
      const cross = knowledgeLedger.formatCrossAgentKnowledge({ topic, limit: 6, nameOf });
      const specialist = topical.buildSpecialistDigestText({ perField: 2, watchItems: 3 });
      const stableBody = `${pack}${specialist}`;
      const usage = '\n※【司会としての使い方】あなたの手持ち（この欄と、後ろの「番組の専門家たちが最近知ったこと」）は、'
        + '会話に厚みを持たせるための背景知識です。一覧を読み上げたり、毎回の発言に盛り込んだりしないでください。'
        + '専門家のコーナーで詳しく扱う話は、司会が先に語り尽くさず、その専門家へ話を振るきっかけとして使ってください。\n';
      return {
        stable: (stableBody.trim() || cross.trim()) ? `${stableBody}${usage}` : '',
        variable: cross,
      };
    } catch (e) {
      getLogger().debug(`[Host] ${agentKey}: 手持ちの組み立てに失敗（手持ち無しで続行）: ${e.message}`);
      return { stable: '', variable: '' };
    }
  }

  /**
   * 放送したコーナーの本文から、そのエージェントの継続観測のメモを書き留める（結果は待たない）。
   *
   * BUGFIX: 記録をコーナーの台本を生成する関数の中で行うと、そこを通るのは情報系の4コーナー
   *         だけで、会話型のコーナー（コメンテーター・ジャーナリスト・法律アドバイザー・
   *         ゲスト論客3人・生活アドバイス・ワールドレポート）は専用の処理で台本を作るため
   *         一度も通らない（実測で、生活アドバイスは6回放送してもメモ0件、ワールドレポートは
   *         ファイル自体が無かった）。生成した時点ではなく、実際に放送する本文が確定した時点で
   *         記録すること（先読みして使われなかった台本を記録しない、という意味でも正しい）。
   *
   * メモの器を持たないコーナー（音楽 DJ・討論）では何もしない。
   *
   * @param {string} corner コーナーキー
   * @param {string} text 実際に放送する本文
   */
  _recordCornerNote(corner, text) {
    if (!text || !hasNotesStore(corner)) return;
    recordAgentNote(corner, text, {
      apiKey: this.getCredentials().gemini?.api_key,
      activitySessionId: this._activitySessionId,
      label: 'own_corner',
    });
  }

  // ─── ジャーナリストXコーナー（centerKey: journalist）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildJournalistCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // ─ 謎のジャーナリスト X ─
      // ※ Google Search グラウンディングを確実に発動させるため、プロンプトは短く・具体的に保つ。
      // ⚠️ スタジオ在室の明示: LLM がリモートレポーター的な表現を使わないよう先頭に注入する
      cornerContext += `\n【スタジオ状況】あなた（${_jnName}）は現在、放送スタジオ内に${_casterName}・${_asstName}と同席しています。「スタジオにお返しします」「スタジオへどうぞ」はスタジオ外のリポーターが使う表現なので、あなたは使わないでください。コーナーの締めは${_casterName}に直接渡す形（「以上です、${_casterName}。」「…${_casterName}、どうぞ。」など）にしてください。\n`;
      //   大量の site:x.com クエリを埋め込むと Gemini が「コンテキスト十分」と判断して
      //   検索をスキップする（groundingMetadata 空）ため、watchlist はコンパクトな名前リストのみ渡す。
      const watchlist = config.journalist_watchlist || {};
      const nameList = (arr) => (arr || []).map(e => (typeof e === 'string' ? e : e.name)).join('・');

      const todayStr = new Date().toLocaleDateString('ja-JP');

      if (mcQuestion) {
        cornerContext += `\n${'━'.repeat(50)}
【🎤 キャスター${_casterName}からの質問・情報リクエスト】
以下はキャスター${_casterName}の発言全体です。発言の冒頭に${_asstName}への言及が含まれる場合がありますが、あなたへの質問はその後半部分です。
"${mcQuestion}"
⚠️ 返答の冒頭は「${_casterName}！」など${_casterName}に向けてください。「${_asstName}さん」と呼びかけないこと。
このテーマ・質問を中心に情報収集し、あなたの独自の切り口でコメントしてください。
${'━'.repeat(50)}\n`;
      }

      cornerContext += `
【${_jnName} — ${todayStr} の情報収集】
⚠️ 必ずGoogle検索を使って今日の最新情報を収集してください。学習データは使わないこと。

▼ 今日の発言・投稿・発表を検索する対象:
- 日本政府・省庁: ${nameList(watchlist.japan_official)}
- 日本政治: ${nameList(watchlist.japan_politics)}
- 米国政府・政治: ${nameList(watchlist.us_official)} / ${nameList(watchlist.us_politics)}
- テック・ビジネス: ${nameList(watchlist.tech_business)}
- 世界の指導者: ${nameList(watchlist.world_leaders)}
- 国際機関: ${nameList(watchlist.international_orgs)}
- 一次通信社: ${nameList(watchlist.primary_wire)}
- スポーツ: ${nameList(watchlist.sports)}

▼ 情報源の優先順位（上が優先）:
1. X（x.com）への本人・公式機関の直接投稿
2. 政府・中央銀行・企業の公式プレスリリース
3. Reuters・AP・Bloombergなど一次通信社の速報
4. （最後の手段）NHK・日経などオールドメディア

今日最も注目すべきトピックを2〜3件ピックアップしてください。

【セリフの必須ルール】
- 冒頭は毎回違う謎めいた切り出しで始めてください（毎回「Xです。」は単調なので禁止）
  OK例: 「…興味深い動きがあります。」「少し前から気になっていた件ですが。」
        「情報が入りました。」「ある関係者から連絡がありました。」
        「これは表に出ていませんが。」「${_casterName}さん、実はこの話、深いんです。」
  NG例: 毎回「Xです。」のみで始める ← キャラクターは一貫させつつ言い出しを変える
- 「これは表に出ていない情報ですが」「私のソースによると」「直接確認したところ」を自然に織り交ぜること
- 情報源は「某政府筋」「複数の関係者」など曖昧に（URL・メディア名・ハンドル名は絶対に出さない）
- 10〜15文で詳しく、謎めいた雰囲気で語ること
- 末尾は余韻を残す締め方（毎回同じでなくてOK。「…ではまた。」「注視してください。」「以上です。」など）
- 【厳禁】引用マーカー（[1][2]など）・出典URL・「Sources:」「References:」は絶対に出力しないこと
${_pauseNote}`;

      // ── リスナーリクエスト、またはディレクターが判断した「本日の大きな話題」
      // （topicRequest）があれば最優先テーマとして注入 ──
      if (topicRequest?.rawText) {
        cornerContext += this._buildTopicRequestSection(topicRequest, {
          directorPhrase: 'があります。',
          listenerPhrase: `リスナーから「${topicRequest.rawText}」というリクエストが届いています。`,
          continuityPhrase: `直前の${topicRequest.cornerLabel}のコーナーで「${topicRequest.rawText}」という話題が伝えられました。`,
          topicBody: `▼ 必須対応:\n- 「${topicRequest.topic}」を今回のコメントの**中心テーマ**として必ず扱ってください\n- Google検索で「${topicRequest.topic} 最新 ${new Date().getFullYear()}」「${topicRequest.topic} 動向」等を検索し、最新情報を取得してください\n- ウォッチリストの定番トピックより**このリクエストを最優先**にしてください`,
          noTopicBody: `▼ 必須対応:\n- 上記リクエスト内容に正面から答えてください\n- Google検索で関連する最新情報を必ず収集してください`,
        });
      }

      // journalist は独自ルールを上で指定済みなので共通フッターは不要
      return cornerContext;

  }

  // ─── コメンテーター解説コーナー（centerKey: commentator）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildCommentatorCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // ─ コメンテーターコーナー ─
      // ⚠️ スタジオ在室の明示
      cornerContext += `\n【スタジオ状況】あなた（${_cmName}）は現在、放送スタジオ内に${_casterName}・${_asstName}と同席しています。「スタジオにお返しします」「スタジオへどうぞ」はスタジオ外のリポーターが使う表現です。あなたはスタジオにいるので、締めは${_casterName}に直接渡す形（「以上、${_cmName}でした。${_casterName}さん、どうぞ」「${_casterName}さん、いかがでしょう」など）にしてください。\n`;
      // リアルタイムの金融データとニュースを直接注入し、学習データによる誤情報を防ぐ。
      // Google Search グラウンディングは追加的な政治・社会トピックの補完のみに使用。
      const profile = (config.show && config.show.user_profile) || {};
      const interests = profile.interests || '政治、経済、社会問題、金融';

      // ── リスナー本人の資産データ ──
      const _cmPortfolio = this._getFinancePortfolioSummary();
      if (_cmPortfolio?.text) {
        cornerContext += `

<context_data>
【リスナーご本人の資産データ（全件）】
${_cmPortfolio.text}
</context_data>
これはリスナーご本人の実際の資産データです。話題が経済・投資・世界情勢に及ぶ際、
一般論で終わらせず「ご自身のポートフォリオではこうなっている」と具体的な数字を挙げて
結び付けて論じてください（例: 特定地域への集中度、下落局面での実際の耐性）。
【厳守】ここに書かれている数値だけを使い、書かれていない数値を推測・暗算で作らないでください。
特定銘柄の売買を勧める助言は避け、事実に基づく分析に留めてください。`;
      }

      // ── 同じ出来事に対する各社の見出し ──
      try {
        // ATTENTION: 報道のコーナーと同じ「社説の読み比べ」を通したものだけを渡すこと。
        const _cmClusters = MediaCompareService.isEnabled(config)
          ? await this.mediaCompareService.fetchEditorialClusters(config, { maxClusters: 4 })
          : [];
        const _cmCompare = await buildEditorialCompareBlock({
          clusters: _cmClusters,
          apiKey: this.getCredentials()?.gemini?.api_key,
          activitySessionId: this._activitySessionId,
        });
        if (_cmCompare) {
          cornerContext += `
${_cmCompare}
【この材料の扱い方】
話題として取り上げる価値があると判断した場合、「同じ出来事を各社がどう伝えたか」を
切り口に論じてください。何が強調され、何が省かれ、どの立場の声が拾われているか——
報道の受け取り方そのものをリスナーと考える視点は、あなたの専門家としての持ち味が
最も活きるところです。
【厳守】
- 論じてよいのは上の見出しに実際に現れている違いだけです。見出しから読み取れない
  意図・思惑を推測で補わないでください（憶測は評論ではなく創作になります）。
- 特定の媒体を「偏っている」「信用できない」と評価しないでください。各社が実際に
  何と書いたかを示し、どう受け取るかはリスナーご自身の判断に委ねる姿勢を保ってください。
- 各社が同じことを同じように書いているだけだと判断した場合は、この話題は使わず、
  別の論点で構いません。無理に違いを作り出さないでください。`;
        }
      } catch (e) {
        this.log(`[Commentator] 各社読み比べの取得に失敗（コーナーは通常どおり継続）: ${e.message}`, 'warn');
      }

      // ⓪ 現在日時と検索指示（政治・地政学情報はGoogle検索で必ず最新を確認させる）
      {
        const nowPol = new Date();
        const reiwaYear = nowPol.getFullYear() - 2018;
        cornerContext += `\n\n${'═'.repeat(50)}
【現在日時】${nowPol.getFullYear()}年${nowPol.getMonth() + 1}月${nowPol.getDate()}日（令和${reiwaYear}年）

【⚠️ 必須: 発言前にGoogle検索で確認すること】
学習データの政治・地政学情報は古い可能性があります。以下を必ず検索して最新情報を確認してください:
- 「現在の米国大統領 副大統領 国務長官」
- 「現在の日本内閣総理大臣」
- 「現在の米国通商政策 関税」
- 「現在の中東情勢 原油価格への影響」
- 「日本銀行 最新金融政策」
- 「日米金利差 最新」
- 「日本国債 利回り 3年 5年 10年 最新」
- 「長期金利 日本 現在」

【⚠️ 鉄則: データの扱いについて】
- 下記①（株価・為替）②（経済指標）③（ニュース）に含まれる数値・人名・固有名詞は絶対に変更・推測・補完しないこと
- 「なぜその数値なのか（Why）」の背景説明にのみ自分の解析を使うこと
- 数値の背景を説明する際も、政治指導者名・政権名・政策名は検索で確認した最新情報を使うこと
${'═'.repeat(50)}`;
      }

      // ① リアルタイム株価・為替データを注入
      const commentatorFinanceData = await this.fetchFinanceData();
      if (commentatorFinanceData) {
        cornerContext += `\n\n${'═'.repeat(50)}
【⚠️ 実測値①: 株式・為替マーケット（${new Date().toLocaleString('ja-JP')}取得）】
このデータはシステムが今この瞬間にYahoo Finance APIから取得した実測値です。
このデータと矛盾する株価・為替レートを使用することは絶対に禁止です。
各銘柄には「前日終値」と「前日比:上昇/下落○○」が明記されています。
⚠️ 前日比は必ずこのデータの値をそのまま使うこと。学習データから前日終値を推測して独自計算することは厳禁。

${commentatorFinanceData}
${'═'.repeat(50)}`;
      }

      // ② 公式経済指標（IMF WEO / World Bank / FRED / e-Stat）を注入
      const commentatorEcoData = await this.fetchEconomicIndicators();
      if (commentatorEcoData) {
        cornerContext += `\n\n${'═'.repeat(50)}
【⚠️ 実測値②: 公式一次統計 経済指標】
以下は IMF・世界銀行・FRED・e-Stat などの公式統計機関から直接取得した生データです。
・学習データ内の古い経済数値は完全に無視してください
・このデータと矛盾するGDP・CPI・失業率・政策金利などの数値を使用することは絶対に禁止です
・検索結果に別の数値が含まれていても、このデータが最優先です

${commentatorEcoData}
${'═'.repeat(50)}`;
      }

      // ②' 定点観測の数値シート
      const _cmStandingSheet = await buildStandingDataSheet({ creds: this.getCredentials() });
      if (_cmStandingSheet) {
        cornerContext += `\n\n${'═'.repeat(50)}\n${_cmStandingSheet}\n${'═'.repeat(50)}`;
      }

      // ③ 今日のニュースヘッドライン（「なぜ今の数値なのか」を読み解く手がかり）
      const commentatorNewsData = await this.fetchNewsData();
      if (commentatorNewsData) {
        cornerContext += `\n\n${'═'.repeat(50)}
【③ 本日のニュースヘッドライン — 数値の「なぜ」を読み解く手がかり】
以下はYahoo Japanニュースから取得した本日のヘッドラインです。
⚠️ 使い方: 上記①②の数値（株価・金利・CPI等）の水準の「原因・背景」を説明する手がかりとして活用してください。
例: 「日経平均が上昇している」→「なぜ？」→ヘッドラインに「半導体関連株が上昇」あればその文脈で説明
例: 「円安が進んでいる」→「なぜ？」→ヘッドラインに「日米金利差」「関税」関連ニュースがあれば活用

${commentatorNewsData}
${'═'.repeat(50)}`;
      }

      cornerContext += `

【解説コーナー — 議題の選び方】
キャスターからの質問やリスナーからのリクエストが渡されている回は、それが議題です（末尾を参照）。
**どちらも無い回は、あなた自身がテーマを決めます。** そのときは上の数値データで動きが大きかった項目を
起点にしてください。政治・社会・地政学のテーマを選ぶ場合も、手元の数値（金利・為替・物価・株価）と
結び付けられないかを一度考えてから話を始めてください。数値と無関係な一般論だけで10文以上を
埋めることは避けてください。

【解説コーナー — Google検索の戦略的活用】
リスナーの関心: ${interests}

⚠️【最重要】Google検索を使って「なぜ今の数値がこの水準なのか」の背景を調べてください。
数値（What）だけを読み上げるのではなく、「なぜその水準なのか（Why）」を必ず解説してください。

【積極的に検索すべき内容】
- 「現在の原油価格 背景 中東情勢 ${new Date().getFullYear()}」— エネルギー価格の地政学的要因
- 「円相場 現在 日米金利差 BOJ ${new Date().getFullYear()}」— 為替変動の原因
- 「日経平均 現在 要因 ${new Date().getFullYear()}」— 株式市場の動き
- 「日本CPI インフレ 現在 背景 ${new Date().getFullYear()}」— 物価動向の原因
- 「米国 通商政策 関税 最新 ${new Date().getFullYear()}」— 米国通商政策の現状
- 「中東 情勢 最新 ${new Date().getFullYear()}」— 地政学リスクの現状
- その他、上記①②のデータで気になる数値があれば積極的に背景を検索すること

【検索結果の使い方】
✅ 使ってよい: 数値の背景・原因・文脈（地政学、政策、市場心理など）
✅ 使ってよい: 最近の政策決定（中央銀行・政府）の説明
✅ 使ってよい: 国際比較・他国との関係性
❌ 使わない: 検索結果内の株価・金利・CPI等の具体的数値（必ず上記①②を使うこと）
❌ 絶対禁止: 上記①②③のデータに含まれる人名・固有名詞・数値を変更・推測・補完すること

【コメントの必須ルール】
- 冒頭は毎回違う切り出しで始めてください（「${_cmName}です」から始めても構いませんが必須ではありません）
  OK例: 「今日の数字を見ると、興味深い傾向が出ています。」「この件、少し掘り下げましょう。」
        「${_casterName}さん、良い質問です。実はここに構造的な問題があります。」
        「データを見ると一目瞭然なんですが、…」「結論から言いますと、…」
  NG例: 毎回「${_cmName}です。データを確認しました。」で始める ← 単調になるので禁止
- 10〜15文で深く多角的な分析・解説を述べてください
- 必ず「数値→その背景・原因→今後の見通し」の流れで論じてください（数値だけ・原因だけはNG）
- 以下の観点を盛り込んでください（全てが毎回必要ではないが、複数は必須）:
  ① 現状の数字（上記「実測値①②」から具体的数値を引用）
  ② その背景・原因（Google検索で得た最新の地政学・政策・市場の文脈を使うこと）
  ③ 日本・米国の中央銀行・政府の政策との関係
  ④ リスクと今後の見通し（専門家として何を懸念するか）
- 数字は必ず①②から引用（「実測値で」「公式統計によると」などの表現を使う）
${_cmStandingSheet ? `
【数値の使い方（最重要）】
- **水準（いくつか）を読み上げるだけで終わらないでください。** 上の「定点観測の数値」にある
  **変化（いつと比べてどれだけ動いたか）と、過去5年の中でどのあたりの水準か**まで必ず使ってください。
  「日経平均は◯円です」ではなく「先週から◯円上げて、過去5年で上から◯%の水準です」と語ること。
- 「■ 今週とくに動いた項目」に挙がっているものは、**最低1つは必ず取り上げてください**。
  別の議題がある回でも、その議題と結び付けられないかを一度考えてください。
- 連動性（相関）を語るときは**必ず期間を添えてください**（「直近3か月では0.6程度」のように）。
  期間によって数値が変わっている場合は、**その変化自体**が論点になります
  （「足元で日米の金利の連動が強まっている」など）。
- **相関が高いことを理由に因果を断定しないでください。** 原因を語るなら、相関とは別の根拠を示すこと。
- 計算済みの数値を自分で計算し直したり、丸めた値から別の数値を作ったりしないでください。
` : ''}
- 「実際のデータによると」「数字を見ると一目瞭然ですが」「背景を調べると」などの表現を活用
- 末尾は${_casterName}へ渡す締め方（毎回同じでなくてOK。「以上、${_cmName}でした。${_casterName}さん、どうぞ」「参考にしてください」「${_casterName}さん、いかがでしょうか」など）
- 【禁止】「スタジオにお返しします」「スタジオへどうぞ」は絶対に使わないこと（あなたはスタジオにいるため不自然です）
- 【厳禁】引用マーカー（[1][2]など）・出典URL・「Sources:」「References:」は出力しないこと
- 【厳禁】上記「実測値①②」と矛盾する株価・GDP・CPI・為替・金利等の数値を使わないこと
${_pauseNote}`;

      // MCからの質問が渡されている場合は最重要指示として末尾に追加する
      // （末尾に置くことで Gemini が最も注意を払う「直近の指示」として機能する）
      if (mcQuestion) {
        cornerContext += `\n\n${'━'.repeat(50)}
【🎤 キャスター${_casterName}からのご質問（最重要：必ずこれに正面から答えること）】
以下はキャスター${_casterName}の発言全体です。発言の冒頭に${_asstName}への言及が含まれる場合がありますが、あなたへの質問はその後半部分です。
"${mcQuestion}"
⚠️ 返答の冒頭は「${_casterName}さん、」など${_casterName}に向けてください。「${_asstName}さん」と呼びかけないこと。
上記の質問に対して、まず明確に答えてください。
一般論の羅列ではなく、この質問への具体的な見解・分析を述べてください。
上記①②③のデータを根拠として使いながら、この質問に答える形でコメントを構成してください。
${'━'.repeat(50)}`;
      }

      // リスナーリクエスト、またはディレクターが判断した「本日の大きな話題」の
      // トピックがある場合は最優先指示として末尾に追加する
      if (topicRequest?.rawText) {
        const _cListenerName = (config.show?.user_profile?.name) || 'リスナー';
        cornerContext += this._buildTopicRequestSection(topicRequest, {
          directorPhrase: 'があります。',
          listenerPhrase: `リスナーの${_cListenerName}さんから「${topicRequest.rawText}」というリクエストが届いています。`,
          continuityPhrase: `直前の${topicRequest.cornerLabel}のコーナーで「${topicRequest.rawText}」という話題が伝えられました。`,
          topicBody: `▼ 必須対応:
- 「${topicRequest.topic}」を今回のコメントの**中心テーマ**として必ず扱ってください
- Google検索で「${topicRequest.topic} 最新 ${new Date().getFullYear()}」「${topicRequest.topic} 現状 影響」などを積極的に検索してください
- 上記①②③のデータと組み合わせて「${topicRequest.topic}」の現状・背景・今後の見通しを分析してください
- このトピックについて知らない・データがないという回答は不可。必ず検索して答えてください`,
          noTopicBody: `▼ 必須対応:
- 上記リクエスト内容に正面から答えてください
- 関連するGoogle検索で最新情報を確認してください`,
        });
      }

      // commentator は独自の冒頭・末尾ルールを上で指定済みなので共通フッターは不要
      return cornerContext;

  }

  // ─── 法律相談コーナー（centerKey: legal_advisor）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildLegalAdvisorCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // ─ 法律アドバイザー昭雄 弁護士（法律相談コーナー）─
      cornerContext += `\n【スタジオ状況】あなた（${_lgName}）は現在、放送スタジオ内に${_casterName}・${_asstName}と同席しています。「スタジオにお返しします」「スタジオへどうぞ」はスタジオ外のリポーターが使う表現です。締めは${_casterName}に直接渡す形（「以上、${_lgName}でした。${_casterName}さん、どうぞ」など）にしてください。\n`;
      const lgNow     = new Date();
      const lgReiwa   = lgNow.getFullYear() - 2018;
      cornerContext += `\n${'═'.repeat(50)}
【現在日時】${lgNow.getFullYear()}年${lgNow.getMonth() + 1}月${lgNow.getDate()}日（令和${lgReiwa}年）

【${_lgName} — 法律相談コーナーの進め方】
⚠️ 必ずGoogle検索で実際の判例・裁判例を調べ、それを根拠として引用しながら解説してください。条文や罪状の説明だけで終わらせないこと。
${'═'.repeat(50)}`;

      if (mcQuestion) {
        cornerContext += `\n${'━'.repeat(50)}
【🎤 キャスター${_casterName}からの質問・相談内容】
"${mcQuestion}"
⚠️ 返答の冒頭は「${_casterName}さん、ご質問ありがとうございます」など${_casterName}に向けて始めてください。「${_asstName}さん」と呼びかけないこと。
${'━'.repeat(50)}\n`;
      }

      cornerContext += `
【${_lgName} — 法律相談のルール】
- 冒頭は毎回違う入り方で始めてください（毎回「${_lgName}です。」だけで始めないこと）
  OK例: 「なるほど、その件についてですが、まず法律的な観点から整理すると。」
        「良いご質問です。実はこの問題、民法・刑法どちらでも論点になりまして。」
        「その点は実務でもよく問題になります。歩く六法全書と呼ばれる私に任せてください。」
- 法律用語は使うが、必ずわかりやすく噛み砕いて説明すること（「六法全書には〜と定められており」など）
- 刑事・民事・家族・労働・企業・日常トラブルまで幅広く対応できる

【⚠️ 必須構成 — 罪状・条文の説明だけで終わるのは厳禁】
以下の3段構成で必ず答えること:
  ① 法的な整理: 関係する罪状・条文・法律上の論点を簡潔に説明する
  ② 実際の判例紹介（必須）: Google検索で調べた実在の判例・裁判例を1つ具体的に紹介する。
     「〇〇年に〇〇地裁（または高裁・最高裁）で〜という事件があり、判決では〜となりました」のように、
     年・裁判所・結末がわかる範囲で現実味のある形で語ること。判例が見つからない場合も
     「似たケースとして実務でよくあるのは〜」と具体的な実例ベースで語り、抽象論で終わらせない。
  ③ 日常生活アドバイス（必須）: リスナーが日常生活で実際に気をつけるべき具体的な注意点・予防策を伝える。
     「契約書には必ず〜を明記しておきましょう」「証拠として〜を残しておくと安心です」など、
     すぐに実践できる具体的な行動レベルのアドバイスにすること（「専門家に相談しましょう」のような抽象論は不可）。
- 豊富な実例・判例を交えながら、親しみやすく誠実に答えること
- 10〜14文で①②③をすべて詳しく語り、かつ聴きやすいテンポで語ること
- 末尾は「ご不明な点があればいつでも」「法律は市民の味方です」など温かく締める
- 【厳禁】「専門家に相談してください」のような逃げ文句は言わないこと（自分が専門家）
${_pauseNote}`;

      // リスナーリクエスト、またはディレクターが判断した「本日の大きな話題」があれば
      // 最優先テーマとして注入
      if (topicRequest?.rawText) {
        cornerContext += this._buildTopicRequestSection(topicRequest, {
          directorPhrase: 'に、法律の観点から切り込みます。',
          listenerPhrase: `リスナーから「${topicRequest.rawText}」という法律相談が届いています。`,
          continuityPhrase: `直前の${topicRequest.cornerLabel}のコーナーで「${topicRequest.rawText}」という話題が伝えられました。`,
          topicBody: `▼ 必須対応:\n- 「${topicRequest.topic}」を今回の相談の**中心テーマ**として必ず取り上げてください\n- 関連する法律・条文・判例をもとに具体的にアドバイスしてください`,
          noTopicBody: `▼ 必須対応:\n- 上記相談内容に正面から法律的観点で答えてください`,
        });
      }

      // legal_advisor は独自ルールを上で指定済みなので共通フッターは不要
      return cornerContext;

  }

  // ゲスト論客3人（お笑い芸人・医師・マーケター）のコーナー。
  // 自分の持ち場について、自分なりの意見をまとめて述べる。文面は lib/guest-analyst-corner.js。
  async _buildGuestAnalystCornerContext(cornerContext, ctx) {
    const { _casterName, _asstName, _pauseNote, agentDisplayName, centerKey, mcQuestion, topicRequest } = ctx;
    if (!getGuestAnalystDef(centerKey)) return cornerContext;

    cornerContext += buildGuestAnalystCornerBody(centerKey, {
      selfName: agentDisplayName,
      casterName: _casterName,
      asstName: _asstName,
      mcQuestion,
      pauseNote: _pauseNote,
    });

    // リスナーリクエスト、またはディレクターが判断した「本日の大きな話題」
    if (topicRequest?.rawText) {
      cornerContext += this._buildTopicRequestSection(topicRequest, {
        directorPhrase: 'について、あなたの持ち場から見た意見をまとめてください。',
        listenerPhrase: `リスナーから「${topicRequest.rawText}」というリクエストが届いています。`,
        continuityPhrase: `直前の${topicRequest.cornerLabel}のコーナーで「${topicRequest.rawText}」という話題が伝えられました。`,
        topicBody: `▼ 必須対応:\n- 「${topicRequest.topic}」を今回の**中心テーマ**として必ず取り上げてください\n- あなたの持ち場ならではの見方で、具体的に語ってください`,
        noTopicBody: '▼ 必須対応:\n- 上記の内容に正面から、あなたの持ち場ならではの見方で答えてください',
      });
    }
    return cornerContext;
  }

  // ─── 生活アドバイザーコーナー（centerKey: life_advisor）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildLifeAdvisorCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // ─ 生活アドバイザー（生活アドバイザー）─
      // ⚠️ スタジオ在室の明示
      cornerContext += `\n【スタジオ状況】あなた（${_laName}）は現在、放送スタジオ内に${_casterName}・${_asstName}と同席しています。「スタジオにお返しします」「スタジオへどうぞ」はスタジオ外のリポーターが使う表現です。締めは${_casterName}に直接渡す形（「${_casterName}、どうぞ！」など）にしてください。\n`;
      const laNow      = new Date();
      const laHour     = laNow.getHours();
      const laMonth    = laNow.getMonth() + 1;
      const laDay      = laNow.getDate();
      const laDayNames = ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];
      const laDayOfWeek  = laDayNames[laNow.getDay()];
      const laIsWeekend  = laNow.getDay() === 0 || laNow.getDay() === 6;

      const laTimeSlot = laHour < 6  ? '深夜・早朝（軽食・翌朝の準備）'
                       : laHour < 10 ? '朝（朝食・一日のスタート）'
                       : laHour < 14 ? '昼（昼食・午後の元気チャージ）'
                       : laHour < 17 ? '午後（おやつ・軽食・リフレッシュ）'
                       : laHour < 21 ? '夕方〜夜（夕食・晩酌のつまみ）'
                       :               '深夜（夜食・明日の準備）';

      const laSeason = laMonth >= 3 && laMonth <= 5 ? `春（${laMonth}月）`
                     : laMonth >= 6 && laMonth <= 8 ? `夏（${laMonth}月）`
                     : laMonth >= 9 && laMonth <= 11 ? `秋（${laMonth}月）`
                     : `冬（${laMonth}月）`;

      const laProfile = (config.show && config.show.user_profile) || {};

      // リスナーの年齢計算
      let laAge = '';
      if (laProfile.birthday) {
        const bd = new Date(laProfile.birthday);
        const ageDiff = laNow - bd;
        const ageDate = new Date(ageDiff);
        laAge = `${Math.abs(ageDate.getUTCFullYear() - 1970)}歳`;
      }

      const laLocation = laProfile.location || '東京';
      const laNearestStation = laProfile.nearest_station || '';

      if (mcQuestion) {
        cornerContext += `\n${'━'.repeat(50)}
【キャスター${_casterName}からのリクエスト（最優先）】
"${mcQuestion}"
このリクエストを最優先テーマにしてください。下記リスナー情報も活かしてください。
${'━'.repeat(50)}\n`;
      }

      // ── 紹介済みトピック禁止リスト（永続化データ + 直近セッション両方を統合）──
      // _lifeAdvisorHistory: サーバー再起動をまたいで最大30件保持
      // _recentTopics: 今セッションの直近5件（すでに_lifeAdvisorHistoryに含まれることが多い）
      const _allPastTopics = [
        ...this._lifeAdvisorHistory.map(h => h.topic),
        ...this._recentTopics,
      ].filter((v, i, a) => a.indexOf(v) === i); // 重複除去

      // history に speech（実際の内容プレビュー）があれば一緒に表示して食材レベルの重複も防ぐ
      const _laRecentHint = _allPastTopics.length > 0
        ? `\n⚠️【過去に紹介済み — 絶対に繰り返さないこと（${_allPastTopics.length}件）】\n` +
          this._lifeAdvisorHistory.slice(0, _allPastTopics.length).map((h, i) => {
            const line = `${i + 1}. ${h.topic.slice(0, 50)}`;
            return h.speech ? `${line} → 内容:「${h.speech.slice(0, 40)}…」` : line;
          }).join('\n') +
          `\n上記と異なるテーマ・料理・アドバイスを選んでください。同じ料理名・食材・テーマは厳禁。`
        : '';

      cornerContext += `\n${'═'.repeat(50)}
【${_laName} — 生活アドバイザー ブリーフィング】

▼ 放送状況:
- ${laDayOfWeek}・${laTimeSlot}・${laSeason}${laIsWeekend ? '【週末】' : '【平日】'}
- 今日: ${laMonth}月${laDay}日

▼ リスナープロファイル:
- 名前: ${laProfile.name || 'リスナー'}さん ${laAge ? `（${laAge}）` : ''}
- 居住地: ${laLocation}${laNearestStation ? `（最寄り駅: ${laNearestStation}）` : ''}
- 職業: ${laProfile.occupation || '不明'}
- 趣味: ${laProfile.hobbies || '不明'}
- 興味・関心: ${laProfile.interests || '不明'}
${_laRecentHint}

▼ 【⚠️ 食材バリエーション指示 — 毎回必ず守ること】
料理テーマを選んだ場合、以下の食材・ジャンルをローテーションしてください。
同じ食材が連続して登場しないよう、幅広く選ぶことが最優先です。

✅ 積極的に使う食材カテゴリー（まんべんなく）:
  肉類: 豚バラ・豚ロース・牛肉・ラム・ひき肉・ソーセージ・ベーコン・鴨
  鶏肉: 鶏もも（胸肉は控えめに）・手羽・砂肝・ひな鳥
  魚介: サバ・鮭・ブリ・カツオ・タコ・イカ・海老・貝類・ホタテ・サンマ（アジ以外も積極的に）
  豆類・卵: 豆腐・納豆・厚揚げ・油揚げ・卵料理・大豆製品
  乾物・加工品: わかめ・昆布・切り干し大根・春雨・干し椎茸・缶詰
  洋食・エスニック: パスタ・リゾット・グラタン・カレー・エスニック炒め・スープ
❌ 連続を避ける食材: 鶏胸肉・アジ・きゅうり（過去に頻出のため意識的に間隔を空ける）

▼ 【⚠️ 今回の必須テーマ（サーバーが自動選択 — 必ず従うこと）】
${(() => {
  // ── テーマカテゴリーのローテーション選択ロジック ──────────────────────────
  // リクエスト・キャスター指定がある場合はテーマを強制しない
  if (topicRequest?.rawText) {
    this._laCurrentThemeKey = null;
    return '📌 リスナーリクエストがあります → テーマは上記リクエストに従ってください';
  }
  if (mcQuestion) {
    this._laCurrentThemeKey = null;
    return '📌 キャスターからのリクエストがあります → テーマは上記リクエストに従ってください';
  }

  // 直近の使用済みカテゴリーキーを収集（history に category フィールドがあるものだけ）
  const _recentCatKeys = this._lifeAdvisorHistory
    .slice(0, LA_THEME_CATEGORIES.length)           // 全カテゴリー数分だけ見る
    .map(h => h.category)
    .filter(Boolean);

  // まだ一度も使っていないカテゴリーを優先
  const _unusedThemes = LA_THEME_CATEGORIES.filter(t => !_recentCatKeys.includes(t.key));
  // 全使用済みの場合は、直近3件に含まれないカテゴリーから選ぶ
  const _avoidRecent3  = _recentCatKeys.slice(0, 3);
  const _freshThemes   = LA_THEME_CATEGORIES.filter(t => !_avoidRecent3.includes(t.key));

  const _candidates = _unusedThemes.length > 0 ? _unusedThemes : _freshThemes;

  // 昼食・夕食の少し前は「料理・レシピ」テーマを優先する（直近で使っていなければ）。
  // laHour はこのメソッド冒頭で定義済み（放送状況ブロックと同じ値を使う）。
  const _mealPrepWindow    = (laHour >= 10 && laHour < 12) || (laHour >= 16 && laHour < 19);
  const _recipeTheme       = LA_THEME_CATEGORIES.find(t => t.key === 'recipe');
  const _recipeRecentlyUsed = _avoidRecent3.includes('recipe');
  const _mealBiasApplied   = _mealPrepWindow && _recipeTheme && !_recipeRecentlyUsed;

  // candidates からランダム選択（毎回同じにならないよう Math.random）
  const _chosen = _mealBiasApplied
    ? _recipeTheme
    : (_candidates[Math.floor(Math.random() * _candidates.length)]
        ?? LA_THEME_CATEGORIES[this._lifeAdvisorHistory.length % LA_THEME_CATEGORIES.length]);

  this._laCurrentThemeKey = _chosen.key;

  // 直近3件の履歴をデバッグ用に表示
  const _recentSummary = _recentCatKeys.slice(0, 3).join(' → ') || '（履歴なし）';

  return `${_chosen.icon}【${_chosen.label}】→ ${_chosen.desc}
（直近のテーマ履歴: ${_recentSummary}　→　今回は「${_chosen.label}」を選んだ理由: ${_mealBiasApplied ? '昼食・夕食前のタイミングのため料理・レシピを優先' : '長期間未使用または未使用カテゴリー'}）

⚠️ このテーマから絶対に外れないこと。特に「料理・レシピ」テーマが続いていた場合は今回は料理以外で進めること。`;
})()}
${'═'.repeat(50)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Google検索の推奨クエリ（可能であれば実行してください）】
検索できない場合は、あなたの知識から最新の情報を提供してください（空出力は禁止）。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(() => {
  const _k = this._laCurrentThemeKey;
  const _s = laSeason.replace(/（.*）/, '');
  if (_k === 'health')  return `1. 「${_s} 健康 養生 体ケア ${laAge}」\n2. 「${laMonth}月 体調管理 季節 おすすめ」\n3. 「${_s} ストレッチ 運動 疲労回復」`;
  if (_k === 'home')    return `1. 「${laMonth}月 掃除 整理整頓 収納 コツ」\n2. 「${_s} 片付け 節約 アイデア」\n3. 「道具 DIY 生活 便利グッズ 2025」`;
  if (_k === 'season')  return `1. 「${laMonth}月 季節 暮らし 楽しみ方」\n2. 「${_s} 行事 風物詩 インテリア」\n3. 「${laLocation} ${laMonth}月 季節 おすすめ」`;
  if (_k === 'food')    return `1. 「${laMonth}月 旬 野菜 魚 食材 栄養」\n2. 「${_s} スーパーフード 腸活 食事術」\n3. 「${laAge} 食事 栄養バランス おすすめ」`;
  if (_k === 'drinks')  return `1. 「${_s} おつまみ レシピ 簡単」\n2. 「晩酌 お酒 ペアリング ${laMonth}月」\n3. 「ノンアル ドリンク 人気 2025」`;
  if (_k === 'money')   return `1. 「${new Date().getFullYear()} 節税 投資 初心者」\n2. 「${laLocation} 補助金 行政サービス ${laMonth}月」\n3. 「家計管理 節約 おすすめ 2025」`;
  if (_k === 'event')   return `1. 「${laLocation} ${laMonth}月 イベント 祭り」\n2. 「${_s} 観光 スポット おすすめ」\n3. 「${laLocation} 旬 体験 アクティビティ」`;
  if (_k === 'hobby')   return `1. 「${laProfile.hobbies || '趣味'} ${_s} イベント グッズ」\n2. 「${laProfile.hobbies || '趣味'} コミュニティ 初心者」\n3. 「${_s} レジャー アクティビティ ${laLocation}」`;
  // recipe (default)
  return `1. 「${laMonth}月 旬 野菜 魚 食材」\n2. 「${_s} ${laHour >= 17 ? '夕食' : '昼食'} レシピ 人気 2025」\n3. 「${laProfile.hobbies || '料理'} ${_s} おすすめ」`;
})()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🍳【料理・レシピを選んだ場合の必須フォーマット】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
料理テーマを選んだときは、以下の構成で【プロの料理家レベル】の詳細な説明をしてください:

① 料理名と一言紹介（なぜ今おすすめか・旬の理由・健康効果）
② 材料（2〜3人分）— 必ず分量を明記（例: 鶏もも肉300g、醤油大さじ2、みりん大さじ1）
③ 作り方（必ず手順番号①②③...で区切って説明）
   - 各ステップに具体的な動作・時間・火加減を書く
   - 例:「①鶏肉は一口大に切り、塩胡椒を振って5分おく」
   - 例:「②フライパンに油を熱し、中火で皮目から3分焼く」
   - 最低4〜6ステップで丁寧に
④ 仕上げのコツ・ポイント（プロならではの一工夫）
⑤ アレンジ提案・保存方法（あれば）

【文量】料理・レシピの場合は20〜25文程度でしっかり伝えること。省略・端折り厳禁。

【コメントの必須ルール】
- 冒頭は毎回違う元気な切り出しで始めてください（自己紹介は必須ではありません）
  OK例: 「${_casterName}！今日ちょうどいいタイミングで！」「いやー、これ試してほしくて！」
        「${laProfile.name || 'リスナー'}さん、今日のこれ絶対やってみてけさいよ！」「聞いてください！」
  NG例: 毎回「生活アドバイザーの${_laName}です！」で始める ← 単調になるので禁止
- 東北弁を自然にほんの少し混ぜる（「〜だべ」「〜だなっす」「〜っちゃ」「〜さ」など1〜2箇所）
- リスナーの名前（${laProfile.name || ''}さん）を自然に呼びかける
- 具体的・実用的（曖昧なアドバイス禁止。数字・分量・固有名詞を必ず入れる）
- 料理以外のテーマでも15文程度でしっかり伝える（情報を省略しない）
- 末尾: 「以上、${_laName}がお届けしました！${_casterName}、どうぞ！」で締める（「スタジオへどうぞ！」は使わないこと）
- 【厳禁】引用マーカー・出典URL・「Sources:」・箇条書き記号（・や—）は出力しないこと
- ラジオで読み上げる日本語テキストのみを出力してください（手順番号①②③はOK）
- 【絶対禁止】あなた（${_laName}）のセリフのみを出力すること。${_casterName}・${_asstName}など他のキャラクターのセリフを続けて書かないこと。「以上、${_laName}がお届けしました！${_casterName}、どうぞ！」の後は何も書かないこと。
⛔【最重要 — 思考プロセスの出力は絶対禁止】
このプロンプトを読み返しながら計画を立てる行為（思考過程）を出力することは厳禁です。
「MAXからのリクエストは〜」「今回のテーマは〜」「セリフの構成:」「原稿作成開始」
「リフレッシュ術のアイデア:」「---」「**見出し**」などの内部プランニング・Markdownは
文字列として絶対に出力しないこと。
出力の1文字目からドレミのセリフ本文が始まるようにしてください。`;

      // ── リスナーリクエスト（topicRequest）があれば最優先テーマとして注入 ──
      if (topicRequest?.rawText) {
        const _laTopic = topicRequest.topic;
        cornerContext += `\n\n${'━'.repeat(50)}
【🎤 リスナーリクエスト（最重要・最優先テーマ）】
リスナーから「${topicRequest.rawText}」というリクエストが届いています。
${_laTopic
  ? `▼ 必須対応:\n- 「${_laTopic}」を今回のアドバイスの**中心テーマ**として必ず扱ってください\n- 上記「重要テーマ候補」リストは無視し、このリクエストテーマ一択で深掘りしてください\n- 具体的な手順・分量・コツをしっかり伝えてください`
  : `▼ 必須対応:\n- 上記リクエスト内容に正面から答えてください\n- リクエストが料理・レシピなら材料・手順・コツを詳しく説明してください`}
${'━'.repeat(50)}`;
      }

      return cornerContext;

  }

  // ─── ワールドレポートコーナー（centerKey: world_report）のコンテキスト組み立て ───
  // ATTENTION: テンプレート文字列の中の字下げはプロンプトの一部なので、本体の字下げを整えないこと。
  async _buildWorldReportCornerContext(cornerContext, ctx) {
    const { config, nowC, cornerTimeStr, agentCfg, _cornerUseGeminiTts, _sfxNames, _sfxNote, _pauseNote,
            _casterName, _asstName, _wrName, _djName, _laName, _cmName, _jnName, _lgName,
            centerNames, agentDisplayName, centerKey, contextPrompt, mcQuestion, topicRequest } = ctx;
      // ─ 特派員 のワールドレポート ─
      // _worldReportCity はプリフェッチ時の _resolveWorldReportCity() で確定済み。
      // 確定済みの都市を使って「その場所の詳細レポート」プロンプトを構築する。
      const _wrNow  = new Date();
      const _wrYear = _wrNow.getFullYear();
      const _wrCity = (this._worldReportCity?.city) || null;

      if (_wrCity) {
        // ── 都市確定済み: 詳細レポートを生成するプロンプト ─────────────────────
        cornerContext += `\n${'═'.repeat(50)}
【${_wrName} ワールドレポート ブリーフィング — Phase2 本レポート】

⛔️⛔️⛔️【Phase2 絶対禁止事項 — 守らないとレポート失格】⛔️⛔️⛔️
❌ 冒頭に「Hey ${_casterName}!」「ハーイ ${_casterName}!」「${_casterName}！」「はい、${_casterName}」等を使うこと（接続フレーズ・Phase1 で挨拶は完了済み）
❌ 「${_wrName}です」「スティーブです」等の自己紹介（接続フレーズで紹介済み。2回目は絶対禁止）
❌ 「〇〇からです」「今日は〇〇にいます」等の場所宣言（Phase1 で紹介済み）
❌ 短いレポート → 【最低 600 文字以上・最低 12 文以上】が必須。3〜4 文で終わるのは絶対禁止。
✅ 最初の一語は必ずニュース内容・現場の話（具体的な出来事・問題）から始めること

🔒【絶対不変の前提】${_wrName} は今 【${_wrCity}】 にいます。
この場所は変更不可。どんな検索結果が出ても、${_wrName} が今いる場所は【${_wrCity}】です。
レポートを「ソマリアからです」「〇〇からです」等と別の場所から始めることは絶対禁止。
${_wrName} は【${_wrCity}】から現地ルポを届けます。

▼ 今すぐ以下をGoogle検索してください（必須・全クエリ実行）:
  "${_wrCity} wikipedia"
  "${_wrCity} population religion history overview"
  "${_wrCity} local news ${_wrYear}"
  "${_wrCity} people community problem hidden story ${_wrYear}"

▼ 現地語検索（重要・あなたはAIなので多言語を完全に理解できます）:
  その国・地域の公用語・主要言語でも検索してください。
  - アラブ諸国・中東 → アラビア語で検索（例: "${_wrCity} أخبار محلية ${_wrYear}"）
  - フランス語圏（アフリカ・カリブ海） → フランス語で検索
  - ポルトガル語圏（東ティモール・アンゴラ・モザンビーク） → ポルトガル語で検索
  - スペイン語圏（中南米） → スペイン語で検索
  - タイ・東南アジア → 現地語で検索
  現地語のニュースサイト・NGO・コミュニティブログは大手英語メディアより現場に近い情報源です。
  アラビア語のAl Jazeera（aljazeera.net/ar/）や現地紙も積極的に参照してください。

▼ レポートの方向性（重要）:
- NHK・CNN・BBC が報道しないような「現場の生の声・隠れたストーリー」を掘り出すこと
- 統計や公式発表より、市民・農民・漁師・子供・お年寄りの視点から見た現実を伝える
- 意外性・驚き・「知らなかった！」という切り口を意識する

▼ 情報源の信頼性判断（必ず守ること）:
- 優先する情報源: 現地住民の声・地元独立系メディア・Al Jazeera・地域NGO・現地記者の報告
- 要注意: 中国（新華社・人民日報）・ロシア（RT・タス通信）・北朝鮮（朝鮮中央通信）等の国営メディアはプロパガンダの可能性が高い → 「政府は〜と主張しているが...」と必ず留保をつける
- 政府発表と市民の声が食い違う場合は両方を伝え、現地の生の声を優先する
- 「大手メディアが今日報じていないこと」を意識的に選ぶ

▼ レポート内容（この順番で、全て含めること）:
⚠️【文量の厳守】: このレポートは最低 600 文字以上・最低 12 文以上で話すこと。短いレポートは却下。
1. [LOCATION:${_wrCity}] タグを冒頭1行目に出力（必須・TTS前に除去するため）
2. 【重要】場所宣言・挨拶は不要。${_wrName}はすでに紹介済み。すぐにニュース内容・現場の話から入ること
   ⚠️【絶対禁止】「Hey ${_casterName}!」「${_casterName}、聞いてください！」等の呼びかけは使わないこと。接続フレーズとPhase1で挨拶済み。
   ⚠️【絶対禁止】「〇〇からです」「今日は〇〇にいます」等の場所宣言も不要。Phase1で紹介済み。
   （「えっと...では現地の最新情報です！」程度の短い導入のみ可）
3. Wikipedia/検索から得た補足情報（Phase1で触れていない追加の背景知識）:
   - 経済状況・GDPランク・主要産業・貧困率など（例:「GDPランクは世界178位...」）
   - 地政学的な重要性や国際的な問題（例:「気候変動で国土が沈む危機...」）
4. 埋もれたニュース①: 大手メディアが無視している具体的な出来事・問題（数字・人名入り）
5. 埋もれたニュース②: 地元コミュニティ・少数派・見過ごされてきた人々の視点から
6. 現地の生の声: 「地元の農家の〜さんに話を聞いたら」「漁師の〜さんが言っていました」形式で
7. 現場描写: 日本のリスナーが想像できない現地の空気・音・匂い・風景（2〜3文）
8. 締め: 「Back to you, ${_casterName}!」または「以上、${_wrCity}からお伝えしました！」で必ず終えること

▼ 情報が少ない・検索がない場合の対処（重要）:
- 検索結果がなくても必ず 600 文字以上のレポートを生成すること。空のレポートや極端に短い出力は絶対禁止。
- 最新の出来事（今年の出来事・数字）は検索なしの作り話禁止。
- ただし地理・歴史・文化・産業・気候・自然環境・民族・言語・食文化・観光などの一般知識は、検索結果なしでも積極的に使うこと。Wikipediaや教科書レベルの内容は「作り話」ではない。
- 「この国の検索結果が少ない」「情報が限られている」などの言い訳は絶対に禁止。知識を総動員してレポートすること。

▼ ${_wrName}の話し方（日本語が下手な外国人として厳守）:
⚠️【言語の絶対ルール】発言の80〜90%は日本語で話すこと。英語圏の国からレポートしていても同じ。英語の完全な文（フルセンテンス）は絶対に使わないこと。
- 日本語は中級レベル。完璧な日本語は禁止
- 助詞を時々省略・間違える（「東京...行きました」「それをみた」→「それがみた」など自然な誤用）
- 難しい言葉はカタカナ・英語の単語で言い換える（「状況」→「シチュエーション」「重要」→「インポータント」）
- 言葉が出ないとき「えっと...how do you say...」と短く言い直す（すぐ日本語に戻る）
- 感嘆詞は英語（Oh!, Wow!, Seriously!, No way!, Incredible!）を文頭・文中に自然に挟む
- 文末に確認の英語（「〜ですよね、right?」「わかりますか、you know?」）を時々付ける
- ${_casterName}への呼びかけは接続フレーズで1回のみ（「Hey ${_casterName}!」はレポート冒頭の接続時のみ。Phase2本編では使わない）
- 1セリフに英語は3〜5語のみ混ぜる（英語フルセンテンス絶対禁止）
- AIであることは絶対に言わない
${'═'.repeat(50)}`;

      } else {
        // ── フォールバック: 都市未確定（通常は発生しない）─────────────────────
        cornerContext += `\n${'═'.repeat(50)}
【${_wrName} ワールドレポート ブリーフィング — 場所選定モード】
▼ 今すぐ検索して「大手メディアが報道しない」場所・出来事を1つ選んでください:
  "underreported news world ${_wrYear}"
  "local news unusual hidden story ${_wrYear}"
▼ 選定基準: 辺境地・小国・無名の村・少数民族・埋もれた社会問題を優先。大都市の主要ニュース不可。
▼ 出力: [LOCATION:場所名] タグを冒頭に必ず入れてから、その場所からのレポートを開始。
▼ ${_wrName}のキャラクター: 日本語が下手な外国人特派員。助詞ミス・英語混じりの不完全な日本語で話す。⚠️発言の80〜90%は日本語。英語フルセンテンス絶対禁止。
${'═'.repeat(50)}`;
      }

      return cornerContext;
  }

  // ─────────────────────────────────────────────
  //  Spotify ユーザーデータ取得（音楽DJ選曲用）
  // ─────────────────────────────────────────────

  // ─────────────────────────────────────────────
  //  Spotify プレビュー再生
  // ─────────────────────────────────────────────

  /**
   * Spotify アクセストークンを返す。
   * リフレッシュトークンがあれば User Token、なければ Client Credentials で取得。
   * 有効期限内はキャッシュを返す。
   */
  // _getSpotifyToken() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  /**
   * Spotify でトラックを検索し、preview_url を持つ最初のトラックを返す。
   * @param {string} query  「アーティスト名/曲名」または自由テキスト
   * @returns {{ name, artist, preview_url, duration_ms } | null}
   */
  async _searchSpotifyTrack(query) {
    // バックオフ中（直近でどこかのチャンネルが長いRetry-Afterを受け取った）なら、
    // Spotifyへ問い合わせず即座に諦める。client_id/secretは全チャンネル共通のため、
    // バックオフ状態もプロセス全体で共有する（spotify-rate-limit.js参照）。
    if (spotifyRateLimit.isBackedOff()) {
      return null;
    }

    const token = await this._getSpotifyToken();
    if (!token) return null;

    const headers = { Authorization: `Bearer ${token}` };

    // URI があれば Web Playback SDK で再生できるため URI 付きトラックを返す。
    // レート制限対応の 429/Retry-After 処理は共有サービス（services/spotify-service.js）へ集約
    // （S2 Phase 3）。従来の doSearch / doSearchWithPreview はログ名以外バイト一致だった
    // （どちらも items.find(t => t.uri) || items[0] を返し、"WithPreview" 側も実際には preview で
    // 絞り込んでいなかった）ため1つに統合。挙動維持: maxSyncWaitMs=10s・persistBackoffMs=0
    // （再試行後の継続バックオフ無し）。fetch/parse 例外時に null を返す従来の握りつぶしも保持。
    const doSearch = async (q) => {
      try {
        const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`;
        const res = await spotifyService.spotifyFetch(url, {
          headers, logPrefix: '[Music]', label: q.slice(0, 30), maxSyncWaitMs: 10000, persistBackoffMs: 0,
        });
        if (!res) return null;
        if (!res.ok) {
          const b = await res.text().catch(() => '');
          getLogger().debug(`[Music] doSearch HTTP ${res.status} (${q.slice(0,30)}): ${b.slice(0,80)}`);
          return null;
        }
        const data = await res.json();
        const items = data.tracks?.items || [];
        return items.find(t => t.uri) || items[0] || null;
      } catch { return null; }
    };

    // 「アーティスト名/曲名」形式をパース
    let track = null;
    let isFallback = false;
    let originalTitle = null;
    if (query.includes('/')) {
      const [artist, title] = query.split('/').map(s => s.trim());
      originalTitle = title;
      // ① 精密検索（曲名+アーティスト）
      track = await doSearch(`track:"${title}" artist:"${artist}"`)
           || await doSearch(`${title} ${artist}`);
      // ② 指定曲が完全に見つからない → アーティスト名だけで別曲フォールバック
      if (!track) {
        getLogger().info(`[Music] "${title}" 未取得 → "${artist}" 別曲フォールバック検索`);
        await new Promise(r => setTimeout(r, 1500)); // 429 回避のための短い待機
        const fallback = await doSearch(`artist:"${artist}"`);
        if (fallback?.uri) {
          getLogger().info(`[Music] フォールバック成功: "${artist}" → "${fallback.name}"`);
          track = fallback;
          isFallback = true;
        }
      }
      // ③ 指定曲が preview なし → アーティスト単体で別の preview 付き曲を探す
      if (track && !track.preview_url && !isFallback) {
        getLogger().debug(`[Music] "${title}" は preview なし → "${artist}" の別曲を検索`);
        const fallback = await doSearch(`artist:"${artist}"`);
        if (fallback?.preview_url) {
          getLogger().info(`[Music] フォールバック: "${artist}" → "${fallback.name}"`);
          track = fallback;
          isFallback = true;
        }
      }
    } else {
      track = await doSearch(query);
    }

    if (!track) return null;

    // ── 曲の詳細情報（audio-features + アーティストジャンル）を追加取得 ──────────
    // キャスター・アシスタントがリアルな感想を言えるよう、テンポ・ムード・ジャンル等を渡す
    let trackMeta = {};
    try {
      const trackId = track.uri?.split(':')[2]; // spotify:track:XXXX → XXXX
      const artistId = track.artists?.[0]?.id;
      if (trackId) {
        const [featRes, artistRes] = await Promise.all([
          fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, { headers }),
          artistId ? fetch(`https://api.spotify.com/v1/artists/${artistId}`, { headers }) : Promise.resolve(null),
        ]);
        const feat   = featRes?.ok   ? await featRes.json()   : null;
        const artist = artistRes?.ok ? await artistRes.json() : null;

        if (feat) {
          // valence: 0=暗い/悲しい, 1=明るい/幸福
          // energy:  0=穏やか/静か, 1=激しい/エネルギッシュ
          // danceability: 0=踊りにくい, 1=踊りやすい
          const mood = feat.valence > 0.7 ? '明るく前向き' : feat.valence > 0.4 ? 'バランスの取れた' : feat.valence > 0.2 ? 'しんみりした' : '切なく悲しい';
          const energy = feat.energy > 0.7 ? '激しくエネルギッシュ' : feat.energy > 0.4 ? '程よいテンポ' : '穏やかでゆったりした';
          trackMeta.tempo       = Math.round(feat.tempo);
          trackMeta.mood        = mood;
          trackMeta.energy      = energy;
          trackMeta.danceability = feat.danceability > 0.7 ? '高い' : feat.danceability > 0.4 ? '普通' : '低い';
          trackMeta.acousticness = feat.acousticness > 0.6 ? 'アコースティック寄り' : 'エレクトロニック/バンド寄り';
          trackMeta.key_mode    = `${['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][feat.key] || '?'}${feat.mode === 1 ? 'メジャー' : 'マイナー'}`;
        }
        if (artist?.genres?.length) {
          trackMeta.genres = artist.genres.slice(0, 3).join(', ');
        }
      }
      // アルバム名・リリース年
      trackMeta.album        = track.album?.name   || null;
      trackMeta.releaseYear  = track.album?.release_date?.slice(0, 4) || null;
      trackMeta.popularity   = track.popularity ?? null;
    } catch (me) {
      getLogger().debug(`[Music] trackMeta 取得失敗: ${me.message}`);
    }

    return {
      name:          track.name,
      artist:        track.artists.map(a => a.name).join(', '),
      uri:           track.uri,
      preview_url:   track.preview_url || null,
      duration_ms:   track.duration_ms,
      isFallback:    isFallback,
      originalTitle: originalTitle,
      meta:          trackMeta,  // ← ジャンル・テンポ・ムード・アルバム等
    };
  }

  /**
   * Spotify で再生できるトラックをまとめて取得する（Web Playback SDK 用）。
   * preview_url は不要 — URI があれば Premium アカウントで再生可能。
   * @param {string[]} queries  検索クエリの配列
   * @param {number}   maxTracks 最大取得件数（デフォルト15）
   * @returns {string}  音楽DJのプロンプトに渡す確認済みトラックリスト
   */
  async _fetchSpotifyPlayableTracks(queries = [], maxTracks = 25) {
    // ── キャッシュチェック（45分TTL）────────────────────────────────────────────
    // music_dj コーナーは1〜2時間に1回程度。毎回 Spotify を叩くと
    // レート制限が累積するため、前回取得結果を再利用する。
    const CACHE_TTL_MS   = 45 * 60 * 1000; // 45分（成功時）
    const BACKOFF_MS     = 10 * 60 * 1000; // 10分（429失敗後のリトライ抑制）

    // 429バックオフ中は即リターン（Spotifyへのリクエスト自体を止める。全チャンネル共通の状態）
    if (spotifyRateLimit.isBackedOff()) {
      getLogger().warn(`[Music] Spotify 429 バックオフ中 — あと約${spotifyRateLimit.getBackoffMinutesRemaining()}分はスキップ`);
      return this._spotifyTrackCache || '';
    }

    // 成功キャッシュが有効な場合はそのまま返す
    if (this._spotifyTrackCache && Date.now() < this._spotifyTrackCacheExpiry) {
      getLogger().info(`[Music] _fetchSpotifyPlayableTracks: キャッシュ使用 (残り${Math.round((this._spotifyTrackCacheExpiry - Date.now()) / 60000)}分)`);
      return this._spotifyTrackCache;
    }

    try {
      const token = await this._getSpotifyToken();
      if (!token) {
        getLogger().warn('[Music] _fetchSpotifyPlayableTracks: トークン取得失敗');
        return '';
      }
      const headers = { Authorization: `Bearer ${token}` };
      const found = new Map();

      // ── バッチ逐次検索（レート制限対策）────────────────────────────────────────
      // maxTracks=25 に対し 1クエリあたり最大5件取得できるため、
      // 必要クエリ数の上限は ceil(25/5)*2.5 ≈ 13 程度。
      // 全60クエリを投げると一括429になるため、最初から必要数に絞る。
      // バッチ内も同時送信を避け、1件ずつ順番に送信して429を防ぐ。
      const BATCH_SIZE  = 3;                                   // 同時リクエスト数（さらに削減）
      const BATCH_DELAY = 250;                                 // バッチ間インターバル(ms)
      const MAX_QUERIES = Math.min(queries.length,
        Math.max(BATCH_SIZE, Math.ceil(maxTracks / 5) * 3));  // 約15クエリで打ち止め
      const limitedQueries = queries.slice(0, MAX_QUERIES);
      getLogger().debug(`[Music] _fetchSpotifyPlayableTracks: ${queries.length}件→${limitedQueries.length}件に絞って検索`);

      let abort429   = false; // 429 ストームを検出したらループを中断
      let extraDelay = 0;    // Retry-After ヘッダーで指示された追加待機(ms)

      for (let i = 0; i < limitedQueries.length && found.size < maxTracks && !abort429; i += BATCH_SIZE) {
        // Retry-After による追加待機（前のバッチが 429 だった場合）
        // ⚠️Retry-Afterが数万秒（十数時間）規模で返ってくることがあり、そのままawaitすると
        // プロセスが長時間ブロックされてしまう不具合が実際に発生した（24Youで再現・修正済み）。
        // 長すぎる場合は同期的に待たず、バックオフに入って検索を中断する。
        if (extraDelay > 10000) {
          spotifyRateLimit.setBackoffUntil(Date.now() + extraDelay);
          getLogger().warn(`[Music] Retry-Afterが${extraDelay / 1000}秒と長いため、待機せず即座にバックオフして検索を中断します`);
          abort429 = true;
          break;
        }
        if (extraDelay > 0) {
          getLogger().warn(`[Music] Retry-After により ${extraDelay / 1000}s 待機`);
          await new Promise(r => setTimeout(r, extraDelay));
          extraDelay = 0;
        }

        const batch = limitedQueries.slice(i, i + BATCH_SIZE);
        let batch429Count = 0;
        let batchRetryAfterMs = 0;
        const batchResults = [];

        // バッチ内も直列実行（同時リクエストを避けて429を防ぐ）
        // リクエスト間に 300ms のインターバルを設ける
        for (const q of batch) {
          if (abort429) break;
          try {
            const _offset = Math.floor(Math.random() * 10);
            const params = new URLSearchParams({ q, type: 'track', limit: '5', offset: String(_offset) });
            const res = await fetch(`https://api.spotify.com/v1/search?${params}`, { headers });
            if (!res.ok) {
              const errBody = await res.text().catch(() => '');
              getLogger().warn(`[Music] Spotify 検索 HTTP ${res.status} (query: ${q}) — ${errBody.slice(0, 120)}`);
              if (res.status === 429) {
                batch429Count++;
                const retryAfter = parseInt(res.headers?.get?.('Retry-After') || '0', 10);
                if (retryAfter > 0) batchRetryAfterMs = Math.max(batchRetryAfterMs, retryAfter * 1000);
              }
              batchResults.push([]);
            } else {
              const data = await res.json();
              const items = data.tracks?.items || [];
              getLogger().debug(`[Music] 検索 "${q}": ${items.length}件`);
              batchResults.push(items);
            }
          } catch (qe) {
            getLogger().warn(`[Music] _fetchSpotifyPlayableTracks クエリエラー (${q}): ${qe.message}`);
            batchResults.push([]);
          }
          // リクエスト間インターバル（最後の1件以外）
          if (q !== batch[batch.length - 1] && !abort429) {
            await new Promise(r => setTimeout(r, BATCH_DELAY));
          }
        }

        // バッチ内の全クエリが 429 なら以降のバッチも無駄なので中断
        if (batch429Count === batch.length && batch.length > 0) {
          // 10分間のバックオフをセット（Retry-After があればそちらを優先）
          const backoffMs = batchRetryAfterMs > 0 ? batchRetryAfterMs : BACKOFF_MS;
          spotifyRateLimit.setBackoffUntil(Date.now() + backoffMs);
          getLogger().warn(`[Music] バッチ全件 429 — Spotify レート制限中, 検索を中断 (取得済み: ${found.size}件, 次回リトライ: ${Math.ceil(backoffMs / 60000)}分後)`);
          abort429 = true;
        } else if (batchRetryAfterMs > 0) {
          extraDelay = batchRetryAfterMs;
        }

        for (const items of batchResults) {
          for (const t of items) {
            if (!t.uri) continue;
            const key = `${t.artists[0]?.name}/${t.name}`;
            if (!found.has(key)) {
              found.set(key, { artist: t.artists.map(a => a.name).join(', '), name: t.name });
            }
            if (found.size >= maxTracks) break;
          }
          if (found.size >= maxTracks) break;
        }

        // バッチ間に待機（Retry-After 待機がない場合のみ）
        if (!abort429 && extraDelay === 0 && found.size < maxTracks && i + BATCH_SIZE < limitedQueries.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY));
        }
      }

      const result = found.size > 0
        ? [...found.values()].map(t => `${t.artist} / ${t.name}`).join('\n')
        : '';

      getLogger().info(`[Music] _fetchSpotifyPlayableTracks: ${found.size}件取得`);

      // 結果をキャッシュ（取得成功時のみ。0件でも429でなければキャッシュして無駄な再試行を防ぐ）
      if (!abort429) {
        this._spotifyTrackCache       = result;
        this._spotifyTrackCacheExpiry = Date.now() + CACHE_TTL_MS;
        getLogger().debug(`[Music] トラックリストをキャッシュ (TTL: 45分)`);
      }

      return result;
    } catch (e) {
      getLogger().warn(`[Music] _fetchSpotifyPlayableTracks エラー: ${e.message}`);
      return '';
    }
  }

  /**
   * ブラウザの Spotify Web Playback SDK が再生完了を通知するまで待機する。
   * @param {number} timeoutMs タイムアウト（デフォルト40秒）
   */
  // _waitForSpotifyPlayDone() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  // spotifyPlayDone() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  /**
   * Spotify の 30秒 MP3 プレビューをダウンロードし、PCM に変換してミキサーに注入・再生する。
   * BGM は setSpeakerBusy で自動ダッキング。5秒チャンク分割で注入する。
   */
  async _playSpotifyPreview(previewUrl) {
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error(`Preview fetch HTTP ${res.status}`);
    const mp3Buffer = Buffer.from(await res.arrayBuffer());

    // MP3 → s16le 24kHz mono PCM
    const pcmBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const ff = spawn(ffmpegStatic, [
        '-i', 'pipe:0',
        '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ar', '24000', '-ac', '1',
        'pipe:1',
      ]);
      ff.stdout.on('data', c => chunks.push(c));
      ff.stdout.on('end', () => resolve(Buffer.concat(chunks)));
      ff.stderr.on('data', () => {});
      ff.on('error', reject);
      ff.stdin.write(mp3Buffer);
      ff.stdin.end();
    });

    // 5秒チャンクに分割して順次注入（メモリ安定性・割り込み対応）
    const CHUNK_BYTES = 24000 * 2 * 5; // 5秒 × 24kHz × 2bytes/sample (mono s16le)
    for (let offset = 0; offset < pcmBuffer.length; offset += CHUNK_BYTES) {
      const chunk = pcmBuffer.slice(offset, offset + CHUNK_BYTES);
      this.mixer.injectTalkAudio(chunk, 24000, 0); // center pan = 0（正面から聴こえる）
      await this.mixer.waitForTalkDrain();
    }
  }

  /**
   * Spotify からユーザーのプレイリスト一覧とお気に入り曲（直近20件）を取得する。
   * 音楽DJのコンテキストに注入することで、実際のリスナーの好みを選曲に反映できる。
   * 30分キャッシュ。Spotify 未設定時は null を返す。
   */
  async fetchSpotifyUserContext() {
    const TTL = 30 * 60 * 1000; // 30分キャッシュ
    const now = Date.now();
    if (this._spotifyUserCache?.data && now - this._spotifyUserCache.lastFetch < TTL) {
      return this._spotifyUserCache.data;
    }

    const creds = this.getCredentials();
    if (!creds.spotify?.client_id || !creds.spotify?.refresh_token) return null;

    try {
      // アクセストークンをリフレッシュ
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(
            creds.spotify.client_id + ':' + (creds.spotify.client_secret || '')
          ).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: creds.spotify.refresh_token,
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        if (tokenData.error === 'invalid_grant') {
          getLogger().error('[Spotify] fetchSpotifyUserContext: refresh_token 期限切れ (invalid_grant)。管理画面で再認証してください。');
          const c = this.getCredentials();
          if (c.spotify?.refresh_token) { c.spotify.refresh_token = ''; writeJsonFile(this.credentialsPath, c); }
        }
        return null;
      }
      const accessToken = tokenData.access_token;
      if (!accessToken) throw new Error('アクセストークン取得失敗');

      const headers = { Authorization: `Bearer ${accessToken}` };

      // プレイリスト一覧 と お気に入り曲 を並行取得
      const [playlistsRes, likedRes] = await Promise.all([
        fetch('https://api.spotify.com/v1/me/playlists?limit=20', { headers }),
        fetch('https://api.spotify.com/v1/me/tracks?limit=5', { headers }),
      ]);

      const playlistsData = await playlistsRes.json();
      const likedData     = await likedRes.json();

      const lines = [];

      // プレイリスト（名前のみ — 音楽DJが内容を想像できる）
      if (playlistsData.items && playlistsData.items.length > 0) {
        lines.push('■ Spotify プレイリスト（リスナー作成）:');
        playlistsData.items
          .filter(pl => pl.name)
          .slice(0, 12)
          .forEach(pl => lines.push(`  「${pl.name}」（${pl.tracks?.total ?? '?'}曲）`));
      }

      // お気に入り曲（直近30件）
      if (likedData.items && likedData.items.length > 0) {
        lines.push('■ Spotify お気に入り登録曲（最近追加順）:');
        likedData.items
          .filter(item => item.track)
          .slice(0, 20)
          .forEach(item => {
            const t = item.track;
            const artists = t.artists.map(a => a.name).join(' / ');
            lines.push(`  「${t.name}」— ${artists}`);
          });
      }

      if (lines.length === 0) {
        this._spotifyUserCache = { data: null, lastFetch: now };
        return null;
      }

      const result = lines.join('\n');
      this._spotifyUserCache = { data: result, lastFetch: now };
      getLogger().info(`[Spotify] ユーザーコンテキスト取得: プレイリスト${playlistsData.items?.length ?? 0}件、お気に入り${likedData.items?.length ?? 0}件`);
      return result;

    } catch (e) {
      getLogger().warn('[Spotify] ユーザーコンテキスト取得失敗:', e.message);
      this._spotifyUserCache = { data: null, lastFetch: now };
      return null;
    }
  }

  // ─────────────────────────────────────────────
  //  Spotify BGM 再生
  // ─────────────────────────────────────────────

  /**
   * 検索語から1曲を選んで Spotify で流し、再生が終わるまで待つ。
   *
   * @param {string} query 検索語
   * @returns {Promise<any>} 流した曲の情報。流せなければ null
   */
  async playSpotifyTrack(query) {
    const creds = this.getCredentials();

    if (!creds.spotify || !creds.spotify.refresh_token || !creds.spotify.client_id) {
      getLogger().warn('[Spotify] Credentials not configured. Playing local fallback BGM.');
      return false;
    }

    try {
      // 1. Access Token をリフレッシュ
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(creds.spotify.client_id + ':' + creds.spotify.client_secret).toString('base64')
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: creds.spotify.refresh_token
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        if (tokenData.error === 'invalid_grant') {
          getLogger().error('[Spotify] playSpotifyTrack: refresh_token 期限切れ (invalid_grant)。管理画面で再認証してください。');
          const c = this.getCredentials();
          if (c.spotify?.refresh_token) { c.spotify.refresh_token = ''; writeJsonFile(this.credentialsPath, c); }
        }
        return false;
      }
      const accessToken = tokenData.access_token;
      if (!accessToken) throw new Error('Failed to refresh Spotify token');

      // 2. 楽曲を検索
      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const searchData = await searchRes.json();

      if (searchData.tracks && searchData.tracks.items && searchData.tracks.items.length > 0) {
        const track = searchData.tracks.items[0];
        const previewUrl = track.preview_url;
        const title = track.name;
        const artist = track.artists.map(a => a.name).join(', ');
        const durationSec = track.duration_ms ? Math.round(track.duration_ms / 1000) : null;

        if (previewUrl) {

          // BGM_START をブロードキャスト
          this._broadcast({
            event: 'BGM_START',
            title,
            artist,
            ...(durationSec !== null && { duration_sec: durationSec })
          });

          // サーバーに一時保存して Mixer で再生
          const tempBgmPath = path.join(__dirname, 'assets', 'bgm', 'spotify_preview.mp3');
          const fileRes = await fetch(previewUrl);
          const arrayBuffer = await fileRes.arrayBuffer();
          fs.writeFileSync(tempBgmPath, Buffer.from(arrayBuffer));

          this.mixer.playBgm('spotify_preview.mp3');
          return true;
        } else {
          getLogger().warn('[Spotify] Track found but no preview_url available (copyright).');
        }
      } else {
        getLogger().warn('[Spotify] No tracks found for query:', query);
      }
    } catch (e) {
      getLogger().error('Spotify API error:', e);
    }
    return false;
  }

  // ─────────────────────────────────────────────
  //  TTS 発話
  // ─────────────────────────────────────────────

  /**
   * テキストを文単位に分割して順次 TTS 再生する。
   * 発話フェーズ全体（文間の無音含む）は isSpeakerBusy でラップし、
   * BGM ダッキングを維持する。
   */
  /**
   * テキストを文単位に分割して順次 TTS 再生する。
   * 【2文先読みパイプライン】N文目を再生しながらN+1・N+2文目の合成を並行実行し、
   * TTS の合成が一時的に遅れても文間の沈黙を防ぐ。
   * （1文先読みだと短文の再生時間 < 合成時間になった瞬間に無音が発生していた）
   */
  /**
   * テキストを文単位に分割する（speakText と Phase2 先行合成で共通利用）。
   * 。！？ で一次分割し、40字超の節は読点で再分割。
   */
  _splitTextToSentences(text) {
    // [PAUSE:N] / [SFX:name] トークンを区切りとして先に分割し、各テキスト区間を文分割する
    const TAG_RE = /(\[PAUSE:\d+\]|\[SFX:\w+\])/g;
    const parts = text.split(TAG_RE);
    const result = [];
    for (const part of parts) {
      if (/^\[PAUSE:\d+\]$/.test(part) || /^\[SFX:\w+\]$/.test(part)) {
        result.push(part); // タグトークンはそのまま保持
        continue;
      }
      const primary = (part.match(/[^。！？]+[。！？]?/gu) || [part]).map(s => s.trim()).filter(s => s);
      for (const seg of primary) {
        if (seg.length <= 40) {
          result.push(seg);
        } else {
          result.push(...seg.split('、').map(s => s.trim()).filter(s => s));
        }
      }
    }
    // 句読点・空白のみの断片（「。」だけ等）を除去する。タグトークンは残す。
    return result.filter(s =>
      /^\[PAUSE:\d+\]$/.test(s) || /^\[SFX:\w+\]$/.test(s) || s.replace(/[。！？、\s]/g, '').length > 0
    );
  }

  /** Gemini TTS 用: 。！？で文分割しつつ短すぎるセグメントは結合してプリフェッチパイプラインを活かす */
  _splitTextToSentencesGemini(text) {
    const MIN_LEN = 40;
    const TAG_RE = /(\[PAUSE:\d+\]|\[SFX:\w+\])/g;
    const parts = text.split(TAG_RE);
    const result = [];
    for (const part of parts) {
      if (/^\[PAUSE:\d+\]$/.test(part)) { continue; } // Gemini TTS はプロソディを自律制御するため無音挿入なし
      if (/^\[SFX:\w+\]$/.test(part)) { result.push(part); continue; } // SFXは実音声の挿入なのでGeminiでも温存
      const segs = (part.match(/[^。！？]+[。！？]?/gu) || [part]).map(s => s.trim()).filter(s => s);
      let pending = '';
      for (const seg of segs) {
        pending = pending ? pending + seg : seg;
        if (pending.replace(/[。！？\s]/g, '').length >= MIN_LEN) {
          result.push(pending);
          pending = '';
        }
      }
      if (pending) result.push(pending);
    }
    return result.filter(s => /^\[PAUSE:\d+\]$/.test(s) || /^\[SFX:\w+\]$/.test(s) || s.replace(/[。！？\s]/g, '').length > 0);
  }

  // _makeSilencePcm() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  /**
   * 発話テキスト（または解決すると発話テキストになる Promise）から「1文目の TTS PCM」を
   * 先行合成する Promise を返す。speakText に preloadedFirstPcm として渡すことで、
   * Duck 開始（＝アバターが喋り始める合図）の後に1文目を合成する待ち時間（TTS で
   * 約0.5〜1.5秒）を消し、発話冒頭の無音をなくす。
   *
   * コーナー系（_chainFirstPcm 相当）は既にこの先読みを行っているが、キャスターとアシスタントの
   * 往復トークには入っていなかった。この共通ヘルパーを会話ターンにも適用する。
   *
   * 先頭がタグ（[PAUSE]/[SFX]）の場合は speakText 側でそのトークンが先に消費され
   * preloadedFirstPcm が使われないため null を返す（無駄な合成をしない）。
   * 合成失敗時も null を返し、speakText 側の通常経路にフォールバックさせる。
   *
   * @param {string|Promise<string>} textOrPromise
   * @param {string} agentKey
   * @returns {Promise<Buffer|null>}
   */
  _prefetchFirstSentencePcm(textOrPromise, agentKey) {
    const cfg = (this.getConfig().agents?.[agentKey]) || {};
    const useGemini = (cfg.tts_engine || 'gemini') === 'gemini';
    return Promise.resolve(textOrPromise).then(t => {
      if (!t || typeof t !== 'string') return null;
      const sents = useGemini
        ? this._splitTextToSentencesGemini(t)
        : this._splitTextToSentences(t);
      const first = sents[0];
      if (!first) return null;
      // 先頭がタグの場合は speakText が preloadedFirstPcm を使わないので合成しない
      if (/^\[PAUSE:\d+\]$/.test(first) || /^\[SFX:\w+\]$/.test(first)) return null;
      return this._collectPcm(first, agentKey).catch(() => null);
    }).catch(() => null);
  }

  /**
   * 先読み発話オブジェクト（_prefetchedSpeech に代入する）を組み立てる。
   * テキスト生成 Promise に加えて「1文目 TTS PCM」の先行合成 Promise（firstPcmPromise）を
   * 同梱する。これにより、前の話者が喋っている数秒の間にテキスト生成と1文目合成の両方が
   * 完了し、消費側（次の話者ターン）ではジングル付きコーナーと同様にほぼゼロ待ちで発話できる。
   *
   * @param {string} key            先読みキャッシュの識別子（'assistant' / 'caster_decision' 等）
   * @param {Promise<string>} textPromise  generateAgentSpeech の戻り Promise
   * @param {string} ttsAgentKey    実際に喋る TTS エージェント（'caster' / 'assistant' 等）
   */
  _buildPrefetchedSpeech(key, textPromise, ttsAgentKey) {
    return {
      key,
      promise: textPromise,
      firstPcmPromise: this._prefetchFirstSentencePcm(textPromise, ttsAgentKey),
    };
  }

  // _collectPcmOrPause() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  /**
   * テキストを音声にして流す。
   *
   * 文ごとに切って先読みしながら合成し、途切れないように順に流す。切断されたときは
   * 世代番号の食い違いで途中から打ち切る。
   *
   * @param {string} text 読み上げる本文
   * @param {string} agentKey 話者のエージェントキー
   * @param {any} preloadedFirstPcm 先に合成しておいた1文目の音声。無ければ null
   * @param {any} opts holdDuckMs（読み終えた後も音を絞ったままにする時間）と expectedGen（世代番号）
   * @returns {Promise<void>}
   */
  async speakText(text, agentKey, preloadedFirstPcm = null, { holdDuckMs = 0, expectedGen = null } = {}) {
    // null / undefined / 空文字ガード（TTS に渡せないので早期リターン）
    if (!text || typeof text !== 'string' || text.trim() === '') {
      getLogger().warn(`[speakText] ${agentKey}: テキストが空のためスキップ (text=${JSON.stringify(text)})`);
      return;
    }
    // 切断による世代交代ガード: 呼び出し元の runSingleShowStep が古い世代のまま
    // ここまで実行され続けた場合（disconnect 後も corner ハンドラが完走するケース）、
    // 再生開始前に中断する。speakText 内部の世代チェック（後述）は「このspeakText自身の
    // 再生中」のみを保護するため、呼び出し元の世代を渡してもらい入口で弾く必要がある。
    if (expectedGen !== null && this._speakGeneration !== expectedGen) {
      getLogger().debug(`[speakText] ${agentKey}: 古い世代からの呼び出しのため再生前に中断 (expected ${expectedGen} → 現在 ${this._speakGeneration})`);
      return;
    }
    // 会話履歴ログに記録（発音辞書メンテナンス・デバッグ用）
    this._logConversationHistory(agentKey, text);

    this._broadcast({ event: 'AGENT_SPEAKING', agent: agentKey });
    this.mixer.setSpeakerBusy(true);
    getLogger().debug(`[Duck] start agentKey=${agentKey}`);

    // ステレオパン値を取得（config.json > AGENT_PAN_DEFAULTS > 0 の優先順）
    const agentCfg = (() => {
      const cfg = this.getConfig();
      return (cfg.agents && cfg.agents[agentKey]) || {};
    })();
    const pan = agentCfg.pan ?? AGENT_PAN_DEFAULTS[agentKey] ?? 0;
    getLogger().debug(`[speakText] ${agentKey}: pan=${pan.toFixed(3)}, volume=${(agentCfg.volume ?? 1.0).toFixed(2)}`);

    // Gemini TTS はLLMベースで完全な文単位が必要。非Gemini系（フォールバック用）は40字超を読点で再分割してバッファを確保する
    const useGemini = (agentCfg.tts_engine || 'gemini') === 'gemini';
    const sentences = useGemini
      ? this._splitTextToSentencesGemini(text)
      : this._splitTextToSentences(text);

    // 切断時に _speakGeneration がインクリメントされる → この speakText は中断対象
    const _myGeneration = this._speakGeneration;

    try {
      // 最初の文: 事前合成済み PCM があればそれを、なければ今すぐ開始
      const pcmPromises = [
        this._collectPcmOrPause(sentences[0], agentKey, preloadedFirstPcm),
      ];
      // 2〜3文目も即座に並行合成開始（ループ内で i+3 を先読みするための初期分）
      for (let k = 1; k <= 2 && k < sentences.length; k++) {
        pcmPromises.push(this._collectPcmOrPause(sentences[k], agentKey));
      }

      // [SFX:] はLLMが指示を無視して多用する可能性があるため、1発話あたりの再生数に上限を設ける
      const MAX_SFX_PER_TURN = 2;
      let _sfxPlayedCount = 0;

      for (let i = 0; i < sentences.length; i++) {
        // 切断シグナルを受けたら残りの文をスキップ
        if (this._speakGeneration !== _myGeneration) {
          getLogger().debug(`[speakText] ${agentKey}: 切断により中断 (gen ${_myGeneration} → ${this._speakGeneration})`);
          break;
        }

        // 現在の文の PCM を取得（3文先読みしているので既に完了しているはず）
        const result = await pcmPromises[i];

        // N+3 文目の合成を今すぐ開始（再生と並行、Gemini TTS の遅延でギャップが出ないよう3文分バッファ）
        if (i + 3 < sentences.length) {
          pcmPromises[i + 3] = this._collectPcmOrPause(sentences[i + 3], agentKey);
        }

        // 現在の文を再生（PAUSE トークンは無音 PCM、SFX トークンは効果音 PCM を挿入）
        if (result && result.__silenceMs !== undefined) {
          const silencePcm = this._makeSilencePcm(result.__silenceMs);
          getLogger().debug(`[speakText] ${agentKey}: [PAUSE:${result.__silenceMs}ms] 挿入`);
          if (silencePcm.length > 0) await this._injectAndWait(silencePcm, pan);
        } else if (result && result.__sfxPcm !== undefined) {
          if (!result.__sfxPcm) {
            getLogger().debug(`[speakText] ${agentKey}: 未知のSFX名のため無視`);
          } else if (_sfxPlayedCount >= MAX_SFX_PER_TURN) {
            getLogger().debug(`[speakText] ${agentKey}: SFX上限(${MAX_SFX_PER_TURN}/発話)に達したためスキップ`);
          } else {
            _sfxPlayedCount++;
            getLogger().debug(`[speakText] ${agentKey}: [SFX] 挿入`);
            await this._injectAndWait(result.__sfxPcm, pan);
          }
        } else if (result && result.length > 0) {
          await this._injectAndWait(result, pan);
        }

        // メモリ解放: 再生済み PCM バッファへの参照を破棄
        pcmPromises[i] = null;
      }
    } finally {
      if (holdDuckMs > 0) {
        // 次の発話までの短いギャップ中もダッキングを維持し、BGMが浮き上がるのを防ぐ
        this.mixer.keepSpeakerBusyMs(holdDuckMs);
      } else {
        this.mixer.setSpeakerBusy(false);
      }
      getLogger().debug(`[Duck] end agentKey=${agentKey}`);
      this._broadcast({ event: 'AGENT_SILENT', agent: agentKey });
    }
  }

  /**
   * 会話履歴を JSONL ファイルに追記する。
   * 2000行を超えたらローテート（.1 → .2 → .3、.3は削除）。
   * agentNameOverrideは、agentKeyがconfig.agentsに存在しない呼び出し元向け
   * （例: My Secretaryのリスナー発話を'secretary_user'キーでリスナー本人の名前で記録する場合）。
   */
  _logConversationHistory(agentKey, text, agentNameOverride = null) {
    try {
      const config = this.getConfig();
      const agentName = agentNameOverride || (config.agents && config.agents[agentKey] && config.agents[agentKey].name) || agentKey;
      const entry = JSON.stringify({ time: Date.now(), agentKey, agentName, text }) + '\n';
      fs.appendFileSync(CONV_HISTORY_PATH, entry, 'utf8');
      // ローテート判定はメインスレッドをブロックしないよう非同期で
      setImmediate(() => this._rotateConvHistoryIfNeeded());
    } catch (e) {
      getLogger().warn('[ConvHistory] 書き込み失敗: ' + e.message);
    }
  }

  /**
   * 会話履歴ファイルが上限を超えていたらローテートする。
   */
  _rotateConvHistoryIfNeeded() {
    try {
      if (!fs.existsSync(CONV_HISTORY_PATH)) return;
      const content = fs.readFileSync(CONV_HISTORY_PATH, 'utf8');
      const lineCount = content.split('\n').filter(l => l.trim()).length;
      if (lineCount <= CONV_HISTORY_MAX_LINES) return;

      // .3 → 削除、.2 → .3、.1 → .2、current → .1
      for (let i = CONV_HISTORY_MAX_GENS; i >= 1; i--) {
        const older = `${CONV_HISTORY_PATH}.${i}`;
        const newer = i > 1 ? `${CONV_HISTORY_PATH}.${i - 1}` : CONV_HISTORY_PATH;
        if (fs.existsSync(older)) fs.unlinkSync(older);
        if (fs.existsSync(newer)) fs.renameSync(newer, older);
      }
      fs.writeFileSync(CONV_HISTORY_PATH, '', 'utf8');
      getLogger().info(`[ConvHistory] ローテート完了 (${lineCount} lines)`);
    } catch (e) {
      getLogger().warn('[ConvHistory] ローテート失敗: ' + e.message);
    }
  }

  // ─────────────────────────────────────────────
  //  長期記憶（セッション要約・プロンプト注入）
  // ─────────────────────────────────────────────

  /**
   * long_term_memory.json を読み込んでプロンプト注入用文字列を this._longTermContext にキャッシュする。
   * startShowLoop() 冒頭で呼ぶ。ファイルが存在しない・破損している場合は null のまま（サイレント）。
   */
  _loadLongTermMemory() {
    try {
      if (!fs.existsSync(LONG_TERM_MEMORY_PATH)) {
        this._longTermContext = null;
        return;
      }
      const data    = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_PATH, 'utf8'));
      const entries = (data.entries || []).slice(-3); // 直近3チャンク分（トークン節約）
      const lines   = [];
      for (const e of entries) {
        // summary のみ（agent_highlights は省略してトークン削減）
        lines.push(`・${e.date}: ${e.summary}`);
      }
      if ((data.recent_topics || []).length > 0) {
        lines.push(`・最近の話題: ${data.recent_topics.slice(0, 5).join('、')}`); // 最大5件
      }
      if (data.listener_memory) {
        lines.push(`・リスナーメモ: ${data.listener_memory}`);
      }
      this._longTermContext = lines.length > 0 ? lines.join('\n') : null;
      getLogger().info(`[Memory] 長期記憶読み込み完了 (${entries.length}チャンク分)`);
    } catch (e) {
      this._longTermContext = null;
      getLogger().warn('[Memory] 長期記憶読み込み失敗: ' + e.message);
    }
  }

  /**
   * 現セッションの会話ログ（_sessionStartTime 以降）を Gemini で要約して返す。
   * 新規エントリが LONG_TERM_MEMORY_MIN_ENTRIES 未満の場合は null を返す（スキップ）。
   * runEndingSequence() と SIGINT/SIGTERM シャットダウンハンドラーから呼ぶ。
   */
  async _generateSessionSummary() {
    try {
      if (!fs.existsSync(CONV_HISTORY_PATH)) return null;
      const content  = fs.readFileSync(CONV_HISTORY_PATH, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());

      // セッション開始以降の行のみ抽出（last_summarized_time カーソル以降）
      // long_term_memory.json の last_summarized_time と _sessionStartTime の大きい方を使う
      let startCursor = this._sessionStartTime || 0;
      if (fs.existsSync(LONG_TERM_MEMORY_PATH)) {
        try {
          const memData = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_PATH, 'utf8'));
          if (typeof memData.last_summarized_time === 'number') {
            startCursor = Math.max(startCursor, memData.last_summarized_time);
          }
        } catch { /* 壊れていても startCursor はそのまま */ }
      }

      const newEntries = allLines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && typeof e.time === 'number' && e.time > startCursor);

      if (newEntries.length < LONG_TERM_MEMORY_MIN_ENTRIES) {
        getLogger().info(`[Memory] 新規エントリ ${newEntries.length} 件 — 要約スキップ`);
        return null;
      }

      // 最大100エントリ・各テキストは200文字で切り詰め・[PAUSE:N]タグ除去
      const logText = newEntries.slice(-100)
        .map(e => `[${e.agentName}]: ${(e.text || '').replace(/\[PAUSE:\d+\]/g, '').slice(0, 200)}`)
        .join('\n');

      const creds = this.getCredentials();
      if (!creds.gemini?.api_key) return null;

      const config      = this.getConfig();
      // ログ表示用。実際の呼び出し（下の generateText）は 'main' ティアで解決するため、
      // ここも同じ resolveModel を使う（以前は同じ優先順位を手で書き写していたため、
      // ティア表を更新するとログと実際のモデルが食い違う状態だった）。
      const geminiModel = resolveModel('main', { creds, config });
      const username    = config.show?.user_profile?.name || 'リスナー';

      const now     = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

      const prompt =
`以下はAIラジオ番組（${dateStr} ${timeStr}）の会話ログです。リスナー: ${username}。
以下の情報をJSON形式のみで返してください（余分な説明文・コードブロック記法は不要）:
{
  "summary": "番組全体の流れを2〜3文で要約（日本語）",
  "topics": ["話題キーワード（最大5個）"],
  "music_played": ["流れた曲（アーティスト - 曲名 形式・全曲・件数制限なし）"],
  "weather": "天気コーナーで伝えた主な内容（例: 東京は晴れ、最高気温28度、夕方から雨）。天気コーナーがなければ空文字",
  "world_report_city": "ワールドレポートで取り上げた都市名（例: パリ、ニューヨーク）。コーナーがなければ空文字",
  "recipe": "生活アドバイザーが紹介した料理名と材料・ポイントを1〜2文で（例: 鶏の唐揚げ — 片栗粉を二度づけすると外がカリカリに）。コーナーがなければ空文字",
  "news_headlines": ["ニュースコーナーで取り上げたニュースの見出しや要点（最大5件）"],
  "listener_notes": "番組中にリスナーが行ったアクションのみ記録（音声コマンドでのリクエスト・コーナーリクエスト・特定話題への反応・発言内容など）。config.jsonのプロフィール情報（職業・趣味・居住地・楽器など既知の属性）は絶対に書かないこと。アクションがなければ空文字",
  "agent_highlights": [
    {
      "agent_name": "エージェント名（ログの [ ] 内の名前をそのまま使用）",
      "highlight": "そのエージェントが言った最も印象的・重要な発言を1文で（次回番組で話題を繋げられるレベルの具体性で）"
    }
  ]
}

agent_highlights の抽出指針:
- キャスターとアシスタントを必ず含める（番組全体の文脈・締めくくりの言葉・印象的な一言）
- ゲスト（コメンテーター・ジャーナリスト・生活アドバイザー等）が出演した場合は各1件追加
- 各ハイライトは次回番組で「そういえば前回〜とおっしゃっていましたが」と使える具体的な内容にする
- 発言のキャラクター・口調・視点も反映させる（毒舌・論理的・感情的 等）
- 最大6件。意味のない相槌・進行フレーズは除外する

【会話ログ】
${logText}`;

      getLogger().info(`[Memory] Gemini に要約を依頼中... (新規 ${newEntries.length} 件・モデル: ${geminiModel})`);
      const _memStart  = Date.now();
      // モデルは 'main' ティア（放送本編と同じ。llm-models.js のティア表で管理）。
      const { text: _memText } = await generateText({
        tier: 'main',
        apiKey: creds.gemini.api_key,
        creds, config: this.getConfig(),
        prompt,
        activitySessionId: this._activitySessionId,
        logMeta: { kind: 'session_summary' },
      });
      getLogger().info(`[Memory] Gemini 要約完了 (${((Date.now() - _memStart) / 1000).toFixed(1)}秒)`);
      let responseText = _memText.trim()
        .replace(/^```json\s*/i, '').replace(/\s*```$/, '');

      const summary        = JSON.parse(responseText);
      summary.date         = `${dateStr} ${timeStr}`;
      summary.start_time   = newEntries[0].time;
      summary.end_time     = newEntries[newEntries.length - 1].time;
      summary.generated_at = new Date().toISOString();
      getLogger().info(`[Memory] セッション要約生成完了: "${(summary.summary || '').slice(0, 60)}..."`);
      return summary;
    } catch (e) {
      getLogger().warn('[Memory] セッション要約生成失敗: ' + e.message);
      return null;
    }
  }

  /**
   * これまでのlistener_memory（蓄積されたリスナー像）と、今回のセッションで新たに
   * 分かったこと（listener_notes）をLLMで1つにマージする。継続的な傾向は残しつつ、
   * 一度きりの些細な出来事は古いものから優先的に削ることで、際限なく長くならないようにする。
   * 初回（既存メモが空）はマージ不要なのでそのまま採用する。
   */
  async _mergeListenerMemory(existing, newNotes) {
    if (!existing) return newNotes;
    try {
      const creds = this.getCredentials();
      if (!creds.gemini?.api_key) return newNotes; // APIキーがなければ従来通り最新情報で代替
      const prompt =
`以下は、AIラジオのリスナーについてこれまでに蓄積してきたメモと、今回の番組で新たに
分かったことです。両方を踏まえて、リスナー像として蓄積すべきメモを1つに更新してください。

【これまでのリスナーメモ】
${existing}

【今回新たに分かったこと】
${newNotes}

【更新ルール】
- 継続的な傾向・繰り返し確認された事実は残す（例: よくコーナーをリクエストする、特定ジャンルを好む）
- 一度きりの些細な出来事は古いものから優先的に削り、際限なく長くならないようにする（200文字程度まで）
- 矛盾する情報は新しい方を優先する
- プロフィール情報（職業・趣味・居住地など、config.jsonに既にある既知の属性）は書かない
- 説明文・前置きは不要。更新後のメモ本文のみを日本語で出力すること`;
      // モデルは 'main' ティア（放送本編と同じ。llm-models.js のティア表で管理）。
      const { text: _mergedText } = await generateText({
        tier: 'main',
        apiKey: creds.gemini.api_key,
        creds, config: this.getConfig(),
        prompt,
        activitySessionId: this._activitySessionId,
        logMeta: { kind: 'merge_listener_memory' },
      });
      const merged = _mergedText?.trim();
      return merged || newNotes;
    } catch (e) {
      getLogger().warn('[Memory] listener_memory マージ失敗（今回分のみ採用）: ' + e.message);
      return newNotes;
    }
  }

  /**
   * 生成したセッション要約を long_term_memory.json に追記・保存する。
   * 2週間（LONG_TERM_MEMORY_TTL_MS）より古いエントリは自動削除（件数制限なし）。
   * last_summarized_time を更新することで次回は続きから要約できる（重複なし）。
   */
  async _saveSessionSummary(summary) {
    try {
      let data = {
        format_version: 2,
        last_summarized_time: 0,
        entries: [],
        recent_topics: [],
        listener_memory: '',
        pending_requests: []
      };
      if (fs.existsSync(LONG_TERM_MEMORY_PATH)) {
        try { data = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_PATH, 'utf8')); }
        catch { /* 壊れていたら新規作成 */ }
      }

      // エントリ追加
      data.entries = [...(data.entries || []), summary];

      // 2週間以内のエントリのみ保持（時間ベース管理・件数制限なし）
      const cutoff  = Date.now() - LONG_TERM_MEMORY_TTL_MS;
      data.entries  = data.entries.filter(e => (e.end_time || 0) >= cutoff);

      // last_summarized_time を今回の最終エントリ time に更新（次回はここから続き）
      data.last_summarized_time = summary.end_time;

      // recent_topics 更新: 新→旧の順で重複除去・最大20件
      const _seen = new Set();
      data.recent_topics = data.entries.flatMap(e => (e.topics || []))
        .reverse()
        .filter(t => !_seen.has(t) && _seen.add(t))
        .slice(0, 20);

      // listener_memory は上書きではなく、既存メモとマージして蓄積する
      if (summary.listener_notes) {
        data.listener_memory = await this._mergeListenerMemory(data.listener_memory, summary.listener_notes);
      }

      // pending_requests はセッション終了時に必ずクリア。
      // コーナーリクエストはリアルタイムの要求であり、次セッションへ引き継ぐと
      // LLM が古いリクエストを参照して誤ったコーナー名を発話するバグが発生する。
      data.pending_requests = [];

      data.last_updated = new Date().toISOString();
      writeJsonFile(LONG_TERM_MEMORY_PATH, data);
      getLogger().info(`[Memory] 長期記憶保存完了: ${summary.date} / ${data.entries.length}チャンク保持中`);
    } catch (e) {
      getLogger().warn('[Memory] 長期記憶保存失敗: ' + e.message);
    }
  }

  // _builtinNormalizeTtsText() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  /**
   * TTS に渡す前のテキスト正規化（発音辞書）。
   * server/data/tts_dict.json から読み込んだエントリを順に適用する。
   * enabled: false のエントリはスキップ。不正な正規表現はログだけ出してスキップ。
   * 辞書は管理画面 (GET/POST /api/tts-dict) から動的に変更可能。
   */
  // _normalizeTtsText() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  // _collectPcm() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。
  // Live 固有の差分は下記2つのフックのオーバーライドとして残している。

  /** world_report（海外レポート）だけ国際電話風の帯域フィルタを掛ける（300〜3400Hz）。 */
  _ttsAudioFilterFor(agentKey) {
    return agentKey === 'world_report' ? 'telephone' : null;
  }

  /** 合成失敗時、Live はログ・記録に加えてクライアントへ SYSTEM_ERROR を通知する。 */
  _onTtsSynthesisFailure(agentKey, e) {
    getLogger().error(`[TTS] Synthesis failed for ${agentKey}:`, e.message);
    activityDb.logEvent(this._activitySessionId, 'system_error', {
      agent: agentKey,
      metadata: { code: 'TTS_FAILED', message: e.message?.slice(0, 200) },
    });
    if (e.message?.includes('prepayment credits')) {
      this._broadcast({ event: 'SYSTEM_ERROR', code: 'GOOGLE_CREDIT_DEPLETED' });
    } else {
      this._broadcast({ event: 'SYSTEM_ERROR', code: 'TTS_FAILED', message: e.message });
    }
  }

  // _applyVolumeToPcm() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  // _geminiSynthesizeToBuffer() / _googleSynthesizeToBuffer() は共有ミックスイン
  // （lib/agent-shared-mixin.js）へ集約。

  // _injectAndWait() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  // _playSfxAsAgent()（コード主導のSFXフック用）は共有ミックスイン
  // （lib/agent-shared-mixin.js）へ集約。

  // Google Search grounding使用時、稀に生成テキスト全体（またはその一部）が丸ごと2回
  // 繰り返されることがある不具合への保険（channel-base.jsの同名メソッドと同じロジック）。
  // 中央固定の2分割ではなく、全ての文区切りを候補にして「その直後（tail）」と「その直前の
  // 同じ長さの区間（preceding）」が一致するかを走査する。前置きの一言を挟んで本題部分だけが
  // 2回連続で語られるなど、重複が中央からズレた位置で始まるケースも検出できる。
  // _collapseDuplicatedWholeText() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  // _collapseReasoningLeak() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。
  // 以前は Live 側と channel-base.js 側に別実装があり、英語思考文の検出は Live 側にしか
  // 無いなど検知シグナルが乖離していた（片方だけ直す事故の温床だった）。呼び出し側は
  // `_promptExpectsJapanese(systemPrompt)` を渡して、英語で話すエージェント（Jazz の Louis）で
  // 英語プレフィックス除去が誤発火しないようにする。

  // ─────────────────────────────────────────────
  //  Gemini セリフ生成
  // ─────────────────────────────────────────────

  /**
   * システムプロンプトなしで Gemini に JSON 抽出させる軽量ヘルパー。
   * generateAgentSpeech はエージェントのシステム指示（アナウンサー口調等）を注入するため
   * JSON 抽出には不向き。このメソッドはプロンプトをそのまま渡す。
   * @param {string} prompt
   * @param {string} [tier] 使うモデルのティア。既存の生成済みテキストからの単純な構造化抽出など、
   *   創作性・世界知識の正確な想起を必要としないタスクではコスト削減のため 'light' を指定する。
   * @returns {Promise<string|null>} 生テキスト
   */
  async _callGeminiRaw(prompt, tier = 'main') {
    const creds = this.getCredentials();
    const config = this.getConfig();
    const apiKey = creds.gemini && creds.gemini.api_key;
    if (!apiKey) return null;
    // モデルは呼び出し側が指定したティアで決まる（llm-models.js のティア表で管理）。
    // 思考パーツの除外と使用量の記録は llm-client 側が引き受ける。
    const { text } = await generateText({
      tier,
      apiKey,
      creds, config,
      prompt,
      activitySessionId: this._activitySessionId,
      logMeta: { kind: 'raw' },
    });
    return text || null;
  }

  /**
   * 画像を生成する。
   *
   * @param {string} imagePrompt 画像の指示
   * @param {string|null} agentKey 稼働レポートに残すエージェントキー
   * @returns {Promise<any>} 生成された画像。失敗したら null
   */
  async _callGeminiWithImage(imagePrompt, agentKey = null) {
    const creds = this.getCredentials();
    const apiKey = creds.gemini && creds.gemini.api_key;
    if (!apiKey) return null;
    // 既定モデルは llm-models.js の image ティアと揃える（2026-10-02にシャットダウンする
    // gemini-2.5-flash-image からの移行。認証情報側の image_model があればそちらが優先）。
    const imageModel = resolveModel('image', { creds, config: this.getConfig() });
    try {
      // ATTENTION: モデルの呼び出しは lib/llm-client.js を通すこと。ここで SDK を直接叩かない。
      const img = await generateImage({
        tier: 'image',
        apiKey,
        prompt: imagePrompt,
        creds, config: this.getConfig(),
        agentKey,
        activitySessionId: this._activitySessionId,
      });
      return img ? { imageBase64: img.imageBase64, mimeType: img.mimeType } : null;
    } catch (e) {
      getLogger().warn(`[RecipeImage] 画像生成失敗 (model=${imageModel}): ${e.message}`);
      activityDb.logEvent(this._activitySessionId, 'system_error', {
        agent: agentKey,
        metadata: { code: 'IMAGE_FAILED', message: e.message?.slice(0, 200) },
      });
      return null;
    }
  }

  /**
   * セリフ生成のプロンプトの末尾（出力の禁止事項・間のタグの使い方・読み誤りを防ぐルール）を
   * 組み立てる。
   *
   * 呼び出しごとに変わる文脈には依存せず、エージェントキー・検索の有無・音声エンジン・日付だけで
   * 決まる静的な文字列なので、本体から分けてある。
   *
   * @param {string} agentKey エージェントキー
   * @param {boolean} useSearch 検索を使うか
   * @param {boolean} useGeminiTts 音声エンジンがどちらか
   * @param {string} dateStr 「現在の日時」に使うのと同じ日付の文字列
   * @returns {string} プロンプトの末尾
   */
  _buildOutputSafetyInstructions(agentKey, useSearch, useGeminiTts, dateStr) {
    return `【出力のルール】このあとに続く【コンテキスト情報】などを踏まえ、あなたのキャラクターになりきって、次に話すべきラジオのセリフを1回分、完全に日本語で生成してください。
${(agentKey === 'news') ? `🚨【放送禁止事項・厳守】
現在は${dateStr}です。あなたの学習データには古い政治情報が含まれており、そのまま使うと誤報になります。
・「バイデン大統領」は誤りです → 現在はトランプ大統領（2025年1月就任）
・退任済みの首相・大臣名を現職として使うことは厳禁です
・コンテキストに「Google検索を実行してください」と書いてあります。必ず実行済みの検索結果のみを使ってください。
・検索なしで話した場合、放送事故になります。` : ''}
${INFO_CORNERS.includes(agentKey)
  ? '・情報コーナーなので、データを全て網羅するよう5〜10文程度でしっかり伝えてください（情報を省略しないこと）'
  : (GUEST_ANALYST_KEYS.includes(agentKey) || agentKey === 'legal_advisor')
    // BUGFIX: ゲスト論客3人が短い方の指示に落ちてしまい、コーナーの指示（順を追って語る）と
    //         食い違っていた。他のゲストと同じ長さの扱いに揃えること。
    ? '・分量は【コンテキスト情報】で指定された文数に必ず従ってください（指定が無い場合のみ2〜3文程度）。'
  : ((agentKey === 'commentator' || agentKey === 'journalist' || agentKey === 'music_dj') && useSearch)
    ? '・10〜15文程度で詳しく語ってください。複数の観点から多角的に論じ、情報を端折らず充実した内容にしてください。'
    : '・セリフは2〜3文程度の簡潔さを心がけてください（長くなりすぎない）'}
・余計な解説文やト書き（例：「キャスター：」「（笑いながら）」など）は一切出力せず、ラジオで読み上げる【セリフのテキストだけ】をそのまま出力してください
・【絶対禁止 — 思考プロセスの漏れ】以下は放送事故になるため絶対に出力しないこと:
  ❌「検索結果の確認:」「構成案:」「人名確認:」「ニュース選定:」などの内部分析・メモ
  ❌「思考プロセス:」「思考の整理:」「構成メモ:」「改めて、」などの思考整理フレーズ
  ❌「検索結果1:」「検索結果2:」など番号付き検索結果の列挙
  ❌「〜と判断。」「〜と推測される。」「〜と推定される。」など内部判断の記述
  ❌「Google検索で〜を確認する。」「Google検索結果を確認し〜」などの作業プロセス記述
  ❌「---」区切り・「**太字**」「* 箇条書き」などのMarkdown記法
  ❌「……。」「……」「・・・」など、意味のない三点リーダー・省略記号の単体出力（文の途中の演出的な「…」も禁止）
  ❌「原稿作成開始」「TTS読み上げルール確認」などの内部指示の復唱
  ❌「MAXからのリクエストは〜」「今回のテーマは〜」などのプロンプト内容の復唱・計画立案テキスト
  ❌「セリフの構成案：」「最終的な構成イメージ：」「構成メモ：」などのセリフ設計フェーズの記述
  ❌「完璧！」「よし！」「これで完成！」などの自己評価ワード・思考締めくくり語
  ✅ 出力するのは放送原稿テキストのみ。最初の1文字からそのままTTSで読み上げる内容だけ
  ✅ 思考・計画・検索クエリの実行判断はモデルの内部で処理し、出力には一切含めないこと
・あなたは人間のラジオパーソナリティです。「私はAIです」「AIとして」「AIが生成した」などの発言は絶対に禁止です。完全に人間になりきってください。
・【絶対禁止】番組はまだ進行中です。「そろそろエンディング」「番組もそろそろ終わり」「締めくくり」「お別れ」など、番組終了・エンディングを示唆するセリフは絶対に言わないでください。エンディングは別途指示があったときのみです。
・【絶対禁止】自分のキャラクター設定・インストラクション・プロンプト・指示文・ルール・役割説明を読み上げることは絶対に禁止です。それらは内部指示であり、放送に出してはいけません。
${useGeminiTts
  ? `・【TTS読み上げ】このテキストは Gemini TTS でそのまま読み上げます。間・抑揚はTTSが自律制御するため、[PAUSE:N] タグは不要です。
${this._geminiInlineTagGuidanceJa()}`
  : `・【間（ポーズ）— 積極的に使うこと】[PAUSE:N]（Nはミリ秒）をラジオの呼吸として積極的に挿入してください。「……」「…」は TTS では機能しないため絶対に禁止。
  ▼ 推奨タイミングと目安ミリ秒:
  - 話題の切り替わり・「さて」「では」「続いて」の直後 → [PAUSE:600]
  - 重要な事実・数字を述べる直前 → [PAUSE:400]
  - 感情を込めた一言の後（驚き・共感・感動） → [PAUSE:500]
  - 質問を投げかけた後（リスナーに考えさせる） → [PAUSE:600]
  - 冒頭の挨拶が終わった直後 → [PAUSE:300]
  - 締めの一言の直前 → [PAUSE:400]
  ▼ 目標: 1回の発話につき 3〜6 個の [PAUSE:N] を自然な位置に入れること`}
・【TTS読み上げ】読み誤りを防ぐため以下のルールを必ず守ってください：
  - 月の「1日」は「ついたち」と書く（例：6月1日 → 6月ついたち）
  - 2〜10日・14日・20日・24日は和語読みで書く（例：2日→ふつか、3日→みっか、4日→よっか、8日→ようか、10日→とおか、20日→はつか）
  - 助数詞で促音が入る場合は必ずひらがなで書く（例：一曲→いっきょく、一個→いっこ、一冊→いっさつ、一本→いっぽん、一首→いっしゅ、一足→いっそく）
  - 「〜ヶ月」は「〜かげつ」、「〜ヶ所」は「〜かしょ」と書く
  - 英略語は初出時のみカタカナ展開する（例：AI→エーアイ、BGM→ビージーエム、GDP→ジーディーピー、FRB→エフアールビー）`;
  }

  /**
   * セリフの生成結果に対する後処理（話者名の前置きの除去・検索の引用マーカーの除去・
   * 音声エンジンに応じた間のタグの整え）をまとめたもの。副作用は無い。
   *
   * @param {string} text 応答から取り出した生のテキスト
   * @param {boolean} useSearch 検索を使ったか（引用マーカーを取り除くかの判断に使う）
   * @param {boolean} useGeminiTts 音声エンジンがどちらか（間のタグの扱いが変わる）
   * @returns {string} 後処理を済ませたテキスト
   */
  _postProcessTtsText(text, useSearch, useGeminiTts) {
    // 余計な発話プレフィックス（話者名にコロンを付けた形）を除去
    let responseText = text.replace(/^[a-zA-Z0-9\s（）().]+[:：]\s*/, '');
    // Google Search グラウンディング使用時は引用マーカー・出典セクションを除去する
    if (useSearch) {
      responseText = AgentSystem._stripSearchCitations(responseText);
    }
    // ── TTS エンジン別テキスト正規化 ──────────────────────────────────────
    if (useGeminiTts) {
      // Gemini TTS: 間・抑揚は TTS が自律制御。不正な [PAUSE] タグ亜種のみ除去し、…はそのまま渡す。
      responseText = responseText
        .replace(/\[(?:[A-Z]*PAUSE[A-Z]*|PA(?!USE)[A-Z]{2,})(?::\d+)?\]/gi, '')
        .replace(/\s*[・]{3,}[。]?\s*/g, ' ')
        .replace(/  +/g, ' ').trim();
    } else {
      // … や ... を [PAUSE:N] に変換して無音挿入、誤記タグも正規化（非Gemini系のフォールバック用）。
      responseText = responseText
        .replace(/\[[A-Z]*PAUSE[A-Z]*(?::(\d+))?\]/g, (_, ms) => `[PAUSE:${ms || 400}]`)
        .replace(/\[PA(?!USE)[A-Z]{2,}(?::\d+)?\]/g, '[PAUSE:400]')
        .replace(/\[PAUSE\]/g, '[PAUSE:400]')
        .replace(/…{2,}[。]?/g, '[PAUSE:500]')
        .replace(/…[。]?/g,    '[PAUSE:300]')
        .replace(/\.{3,}[。]?/g, '[PAUSE:400]')
        .replace(/\s*[・]{3,}[。]?\s*/g, ' ')
        .replace(/  +/g, ' ').trim();
    }
    return responseText;
  }

  /**
   * エージェントのセリフを生成する。
   *
   * ATTENTION: モデル名をここへ直接渡さないこと。呼び出し側は「用途」（ティア）だけを言い、
   *            モデル名は一切知らない形にする。直書きすると、モデルを上げるたびに全ての
   *            呼び出し箇所を触ることになり、ティア表を作った意味が無くなる（実際、ティア表を
   *            更新しても直書きの19か所が古いまま取り残されていた）。
   *
   * @param {string} agentKey エージェントキー
   * @param {string} contextPrompt 組み立て済みのプロンプト
   * @param {boolean|null} [useSearchOverride] true=検索を必ず使う／false=使わない／null=既定
   * @param {string} [tier] 使うモデルの用途（既定は放送本編。短い前置きなどは軽い方を指定する）
   * @param {any} [imageParts] 画像を添える場合のパーツ（形式と base64）。使わないなら null
   * @returns {Promise<string>} 生成されたセリフ
   */
  async generateAgentSpeech(agentKey, contextPrompt, useSearchOverride = null, tier = 'main', imageParts = null) {
    // 第5引数（imageParts）へ届かせるために第4引数へ null を置く書き方は普通にあるため、
    // 未指定と同じ扱いにする（既定値は undefined のときしか効かない）。
    tier = tier || 'main';
    const creds = this.getCredentials();
    const config = this.getConfig();
    // commentator は AGENT_DEFAULTS にも存在するが、config.agents 優先
    const agent = config.agents[agentKey] || {};
    const _useGeminiTts = (agent.tts_engine || 'gemini') === 'gemini';

    const apiKey = creds.gemini && creds.gemini.api_key;
    if (!apiKey) {
      getLogger().info(`[Gemini API] API Key is missing. Using offline mock dialog for ${agentKey}.`);
      return this.getOfflineMockDialog(agentKey);
    }

    // Gemini 呼び出し中を通知（APIキーがある場合のみ）
    this._broadcast({ event: 'AGENT_THINKING', agent: agentKey, state: 'start' });

    try {
      // traffic / commentator / journalist / music_dj は Google Search グラウンディングでリアルタイム情報を取得する
      const useSearch = useSearchOverride !== null
        ? useSearchOverride
        : (agentKey === 'traffic' || agentKey === 'news' || agentKey === 'commentator' || agentKey === 'journalist' || agentKey === 'music_dj' || agentKey === 'life_advisor' || agentKey === 'weather' || agentKey === 'world_report' || agentKey === 'legal_advisor' || GUEST_ANALYST_KEYS.includes(agentKey));
      // Google Search grounding:
      // 2025年以降の Gemini API では googleSearchRetrieval は廃止。
      // 正しい形式は { googleSearch: {} } のみ。
      // モデルは呼び出し側が指定したティアで決まる。エージェント個別設定
      // （config.agents.<key>.gemini_model）・認証情報・config の反映は resolveModel() が
      // 一元的に行うため、ここで合成しない（優先順位は llm-models.js の overrides が正）。

      const _basePrompt = agent.prompt || '全て日本語で簡潔に話してください。';
      const _maxChars = agent.max_chars;
      const systemInstruction = (_maxChars && _maxChars > 0)
        ? `${_basePrompt}\n\n【文字数制限】発話テキストは${_maxChars}文字以内（句読点・記号を含む）に収めること。`
        : _basePrompt;
      const profile = config.show.user_profile || {};

      // 現在日時を明示的に生成（Geminiが自分で推測しないよう必ず渡す）
      const now = new Date();
      const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
      const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日（${weekdays[now.getDay()]}）`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      const prog    = this._getProgramInfo();
      const todayMMDD = String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
      const bdMMDD = profile.birthday ? profile.birthday.replace(/^\d{4}-/, '') : '';
      const isTodayBirthday = (todayMMDD === bdMMDD);

      // リスナープロファイル文字列（設定済みフィールドのみ）
      const profileInfo = [
        profile.name             ? `名前: ${profile.name}`                   : null,
        profile.location         ? `居住地: ${profile.location}`             : null,
        profile.nearest_station  ? `最寄り駅: ${profile.nearest_station}`    : null,
        profile.occupation       ? `職業: ${profile.occupation}`             : null,
        profile.hobbies          ? `趣味: ${profile.hobbies}`                : null,
        profile.interests        ? `興味: ${profile.interests}`              : null,
        isTodayBirthday          ? '★今日が誕生日！'                        : null,
      ].filter(Boolean).join(' / ');

      // 長期記憶ブロック（会話型エージェントのみ注入・純粋情報コーナーは除外）
      const _memoryAgents = ['caster', 'assistant', 'commentator', 'journalist', 'music_dj', 'life_advisor', 'world_report', 'legal_advisor', 'director', ...GUEST_ANALYST_KEYS];
      const _memoryBlock  = (this._longTermContext && _memoryAgents.includes(agentKey))
        ? `\n【過去番組の記憶（参考）】\n${this._longTermContext}\n※ 自然な流れの場合のみ言及。毎回触れる必要はなし。\n`
        : '';
      const _hostKnowledge = (agentKey === 'caster' || agentKey === 'assistant')
        ? this._buildHostKnowledgeBlock(agentKey) : { stable: '', variable: '' };

      // ATTENTION: 暗黙のキャッシュは、リクエストの先頭から同じ内容が続く部分にしか効かない。
      //            変わらない部分を先頭に、呼び出しのたびに変わる部分を後ろに置くこと。
      const fullPrompt = `
${this._buildOutputSafetyInstructions(agentKey, useSearch, _useGeminiTts, dateStr)}

⚠️【プロファイル言及ルール — 厳守】
リスナーの趣味・職業（電子工作・Windシンセ・IT経歴など）への言及は、番組全体で合計2〜3回が上限です。
他のエージェントがすでに触れている可能性があるため、自分のセリフでは原則言及しないでください。
会話の流れで自然に合う場面だけ、さりげなく1回触れる程度にとどめてください。
毎回のセリフでプロファイルに触れるのは厳禁です。
${_hostKnowledge.stable}
━━━━━━━━ ここから下は、呼び出しのたびに変わる情報 ━━━━━━━━
【現在の日時】${dateStr} ${timeStr}
【番組スロット】${prog.name}（${prog.slot}）
【番組の雰囲気】${this._getEffectiveMoodLabel()}
【リスナー情報】${profileInfo}
${_memoryBlock}${_hostKnowledge.variable}
【コンテキスト情報】
${contextPrompt}

【最後に】上の【出力のルール】を守り、ラジオで読み上げる【セリフのテキストだけ】を出力してください（前置き・解説・思考のメモは出力しない）。
`;

      const _llmT0 = Date.now();
      // thinkingConfig は必ず明示送信する（省略するとGemini 2.5+のデフォルトの思考挙動に
      // 委ねることになり、内部思考がthought:trueでタグ付けされずセリフへ混入することがある。
      // Classic/Jazz/Mood/Beatles/The Answers共通基盤(channel-base.js)と同じ理由・同じ対策）。
      const _userParts = imageParts
        ? [{ text: fullPrompt }, imagePart(imageParts.data, imageParts.mimeType)]
        : [{ text: fullPrompt }];
      // ATTENTION: 生の応答をここで組み立て直さないこと。パーツの結合・思考部分の除外・
      //            出典の取り出しは lib/llm-client.js に集約してある。
      const { text: _rawSpeech, model: geminiModel, finishReason: _finishReason,
              grounding: _grounding } = await generateText({
        tier,
        apiKey,
        creds, config,
        contents: [{ role: 'user', parts: _userParts }],
        systemInstruction,
        grounded: useSearch,
        safetySettings: 'relaxed',
        agentKey,
        activitySessionId: this._activitySessionId,
      });
      getLogger().debug(`[Gemini] ${agentKey} → model: ${geminiModel}`);
      const _llmDur = Date.now() - _llmT0;

      // ここから下はテキストに対する後処理（プロバイダ非依存）。
      // 1つのパーツ内で本文がまるごと2回繰り返されるケースへの保険。
      let _joined = this._collapseDuplicatedWholeText(_rawSpeech);
      // Live のエージェントは全員日本語話者だが、判定は共通ヘルパーに委ねて channel-base 側と
      // 同じ呼び出し形にしておく（将来 Live に英語話者が加わっても自動的に安全側に倒れる）。
      _joined = this._collapseReasoningLeak(_joined, {
        detectEnglishPrefix: this._promptExpectsJapanese(systemInstruction),
      });
      let responseText = (_joined || '').trim();
      if (_finishReason && _finishReason !== 'STOP') {
        getLogger().warn(`[Gemini] ${agentKey} finishReason=${_finishReason} text=${responseText.length}文字`);
      }
      // 空の応答は呼び出し側でやり直し、それでも駄目なら代わりの文言へ落ちる。
      // ここでは、その手前で何が起きたかを追えるようにログへ残す。
      if (!responseText) {
        getLogger().warn(`[Gemini] ${agentKey} 空レスポンス — finishReason=${_finishReason || '(なし)'}`
          + ` raw=${(_rawSpeech || '').length}文字 model=${geminiModel} ${_llmDur}ms`
          + ` grounded=${useSearch ? (_grounding?.searched ? 'yes' : 'no') : '-'}`
          + ` promptLen=${fullPrompt.length}`);
      }
      // 使用量の記録は llm-client（generateText）側で済んでいる。

      // Google Search グラウンディングの実行状況をデバッグログに記録
      if (useSearch) {
        try {
          // grounding は llm-client が中立な形（searched/queries/sources）へ正規化済み。
          // groundingMetadata という Gemini 固有のキーはここでは触らない。
          if (_grounding.searched) {
            const { queries, sources, supportCount } = _grounding;
            getLogger().info(`[Search] ${agentKey} — 検索成功 text=${responseText.length}文字 queries=${JSON.stringify(queries)} chunks=${sources.length} supports=${supportCount}`);
            if (sources.length > 0) getLogger().debug(`[Search] ${agentKey} — 参照: ${sources.slice(0, 5).join(' / ')}`);
          } else {
            // commentator は経済指標データ（IMF/FRED/e-Stat）をコンテキストに注入済みのため
            // Gemini が「コンテキストで十分」と判断して検索しない場合は正常動作。
            // 注入データなしで検索もしない場合のみ本当の警告。
            // commentator: 経済指標データ注入済みなので検索なしも正常
            // news: RSSはあるが人名・役職の確認のため検索必須 → 検索なしは警告
            if (agentKey === 'commentator') {
              getLogger().info(`[Search] ${agentKey} — 検索なし（注入済みデータをコンテキストとして使用と推定）`);
            } else if (agentKey === 'news') {
              getLogger().warn(`[Search] ${agentKey} — ⚠️ 検索なし（学習データの人名・役職が使われた可能性あり）`);
            } else {
              getLogger().warn(`[Search] ${agentKey} — 検索なし・注入データもなし（学習データ使用の可能性）`);
            }
          }
        } catch (logErr) {
          getLogger().debug(`[Search] グラウンディング情報のログ取得失敗: ${logErr.message}`);
        }
      }

      return this._postProcessTtsText(responseText, useSearch, _useGeminiTts);
    } catch (e) {
      getLogger().error(`Gemini API generation failed for ${agentKey}: [status=${e.status ?? e.statusCode ?? 'N/A'}] ${e.message ?? String(e)}`);
      activityDb.logEvent(this._activitySessionId, 'system_error', {
        agent: agentKey,
        metadata: { code: 'GEMINI_FAILED', message: (e.message ?? String(e)).slice(0, 200) },
      });
      if (e.message?.includes('prepayment credits')) {
        this._broadcast({ event: 'SYSTEM_ERROR', code: 'GOOGLE_CREDIT_DEPLETED' });
      } else {
        this._broadcast({
          event: 'SYSTEM_ERROR',
          code: 'GEMINI_FAILED',
          message: e.message || 'Gemini API error'
        });
      }
      return this.getOfflineMockDialog(agentKey);
    } finally {
      // 成功・失敗いずれでも thinking 終了を通知
      this._broadcast({ event: 'AGENT_THINKING', agent: agentKey, state: 'end' });
    }
  }

  /**
   * リスナーのフリーテキストリクエストが「曲リクエスト」かどうかを Gemini で判定する。
   * 正規表現に頼らず LLM の文脈理解を使うことで誤検知を防ぐ。
   *
   * @param {string} text - リスナー入力テキスト（リスナー名プレフィックス除去済み）
   * @returns {{ type: 'music'|'general', artist: string|null, song: string|null }}
   */
  async _classifyMusicRequest(text) {
    const apiKey = this.getCredentials()?.gemini?.api_key;
    if (!apiKey) return { type: 'general', artist: null, song: null };

    try {
      // 単純な分類タスク（曲名・アーティスト名の抽出のみ）で創作性・検索が不要なため、
      // コスト削減のため常に軽量モデル（'light' ティア）を使う（他の設定より優先）。

      const prompt = `ラジオ番組内の音楽リクエスト（リスナーからのテキスト、またはキャスターが口頭で振った内容）を分類してください。

リクエスト:「${text}」

以下のJSON形式で1行のみ回答してください（他のテキストは一切出力しないこと）:
{"type":"music","artist":"アーティスト名","song":"曲名"}  ← 特定の1曲を再生してほしい場合
{"type":"music","artist":"アーティスト名","song":null}    ← アーティストの特集・複数曲をリクエストする場合
{"type":"music","artist":null,"song":null}               ← 音楽を流してほしいが曲名もアーティストも不明
{"type":"general"}                                        ← 曲リクエスト以外

判断ルール:
- 「〇〇の特集」「〇〇特集」「〇〇をたくさん」「〇〇でお願い」（曲名なし）→ artist を指定し song は null
- 「特集」「コーナー」「メドレー」「ベスト」はアーティスト名でなく企画名なので song には入れない
- アーティスト名と具体的な曲名の両方が明示されている → song に曲名を設定
- 「かけて」「流して」「聴きたい」「聞かせて」などの再生要求がある → music
- 日常会話・状況報告・質問・お知らせ・感想（「修理が終わりました」「体がだるいです」「入手待ちです」など）→ general
- 「AのB」形式でも、Bが動詞句・状態・手順を表す場合（「入手待ちです」「修理中です」等）→ general`;

      const { text: rawText } = await generateText({
        tier: 'light',
        apiKey,
        prompt,
        activitySessionId: this._activitySessionId,
        logMeta: { kind: 'classify_music_request' },
      });
      const raw = rawText.trim().replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      const parsed = JSON.parse(raw);
      getLogger().info(`[Director] _classifyMusicRequest: 「${text}」→ type=${parsed.type}${parsed.artist ? ` artist=${parsed.artist}` : ''}${parsed.song ? ` song=${parsed.song}` : ''}`);
      return parsed;
    } catch (e) {
      getLogger().warn(`[Director] _classifyMusicRequest 失敗 → general にフォールバック: ${e.message}`);
      return { type: 'general', artist: null, song: null };
    }
  }

  /**
   * キャスターが番組内でDJへの口頭のコーナー移行セリフの中でリクエストしていないか
   * （リスナーのテキストチャット経由の pendingMusicRequest とは別ルート）を検出する。
   * リスナーチャット向けリクエスト検出（本メソッド呼び出し元付近の「音楽リクエスト検出」
   * ブロック）と同じ _classifyMusicRequest を再利用し、判定基準を一致させる。
   * 明らかに音楽と無関係なセリフでLLMを毎回呼ぶコストを避けるため、簡易キーワードで
   * 事前フィルタしてから分類器を呼ぶ（リスナーチャット側と同じ設計判断）。
   * @param {string|null} text キャスターの発話テキスト（コーナー移行セリフ等）
   * @returns {Promise<{text: string, artist: string|null, song: string|null}|null>}
   */
  async _detectMusicRequestFromCasterText(text) {
    if (!text) return null;
    const _musicKw = /曲|歌|音楽|流して|かけて|聴かせ|聞かせ|弾いて|BGM|メロディ|アルバム|シングル|アーティスト|ライブ|コンサート|特集/i;
    const _favArtists = (this.getConfig().show?.user_profile?.favorite_artists || []);
    const _hasFavArtist = _favArtists.some(a => a && text.includes(a));
    if (!_musicKw.test(text) && !_hasFavArtist) return null;
    const _info = await this._classifyMusicRequest(text);
    if (_info.type !== 'music' || (!_info.artist && !_info.song)) return null;
    getLogger().info(`[MusicDJ] MAXの口頭リクエストを検出: 「${text.slice(0, 60)}」→ artist="${_info.artist}", song="${_info.song}"`);
    return { text, artist: _info.artist || null, song: _info.song || null };
  }

  /**
   * 現在有効な滞在地を返す。
   * temp_stay が設定されており今日がその期間内であれば臨時滞在地を返す。
   * それ以外は通常の居住地（user_profile.location）を返す。
   *
   * @returns {{ location: string, isTempStay: boolean, tempStay: object|null }}
   */
  _getEffectiveLocation() {
    const config  = this.getConfig();
    const profile = config.show?.user_profile || {};
    const ts      = config.show?.temp_stay;

    if (ts?.location && ts?.start && ts?.end) {
      const now   = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      if (today >= ts.start && today <= ts.end) {
        return { location: ts.location, isTempStay: true, tempStay: ts };
      }
    }
    return { location: profile.location || '東京', isTempStay: false, tempStay: null };
  }

  /**
   * モデルが使えなかったコーナーの原稿を、手元にある実データから機械的に組み立てる。
   *
   * ATTENTION: 開発用のデモの文言は「API キーが無い状態でも画面が動くこと」を確かめるための
   *            作り話で、放送に乗せる想定のものではない。実データがあるコーナーは、本物の
   *            見出し・本物の数字を読むこと。言い回しは平板になるが、嘘は言わない方が正しい。
   * データも無ければ null を返し、呼び出し側がデモの文言へ落ちる。
   *
   * @param {string} centerKey コーナーキー
   * @returns {string|null} 組み立てた原稿。材料が無ければ null
   */
  _buildCornerFallbackFromRealData(centerKey) {
    const config = this.getConfig();
    // 管理画面の名前には役割の注記が括弧で付くことがある（「名前(報道センター)」のような形）。
    // 通常の発話は LLM が自然に処理するが、ここは機械的に文へ差し込むため、
    // そのまま読むと「カッコ報道センターカッコとじ」になってしまう。読み上げ用に括弧を落とす。
    const _speakable = (n) => String(n || '').replace(/[（(][^）)]*[）)]/g, '').trim();
    try {
      if (centerKey === 'news') {
        const items = (this.newsService?.cache?.structured || []).filter(i => i?.title);
        if (items.length === 0) return null;
        const _newsName = _speakable(config.agents?.news?.name) || '報道センター';
        // ラベル（「トップ」「経済」等）は**変わったときだけ**言う。
        // 毎行に付けると「トップ、…。トップ、…。」と5回続いて耳障りになる。
        let _prevLabel = '';
        const lines = items.slice(0, 5).map((i) => {
          const label = (i.label && i.label !== _prevLabel) ? `${i.label}のニュースです。` : '';
          _prevLabel = i.label || _prevLabel;
          return `${label}${i.title}`;
        });
        return `${_newsName}から、ただいま入っている見出しをお伝えします。`
          + `${lines.join('。[PAUSE:400]')}。[PAUSE:600]`
          + `詳細は追ってお伝えします。`;
      }

      if (centerKey === 'finance') {
        const rows = (this.financeService?.cache?.structured || [])
          .filter(r => r?.key && (r.priceLabel || r.price != null));
        if (rows.length === 0) return null;
        const _finName = _speakable(config.agents?.finance?.name) || '金融情報センター';
        const lines = rows.slice(0, 5).map(r => {
          const price = r.priceLabel || `${r.price}${r.unit || ''}`;
          const move = (typeof r.pct === 'number')
            ? `、前日比${r.pct > 0 ? 'プラス' : r.pct < 0 ? 'マイナス' : ''}${Math.abs(r.pct).toFixed(2)}パーセント`
            : '';
          return `${r.key}は${price}${move}`;
        });
        return `${_finName}から、現在の相場をお伝えします。`
          + `${lines.join('。[PAUSE:400]')}。[PAUSE:600]`
          + `詳しい分析は次回お伝えします。`;
      }
    } catch (e) {
      getLogger().warn(`[Fallback] ${centerKey}: 実データからの組み立てに失敗: ${e.message}`);
    }
    return null;
  }

  /**
   * 開発用のデモのセリフを返す。
   *
   * ATTENTION: これは放送に乗せてよいものではない。実データが手元にあるコーナーは、
   *            必ず実データからの組み立てを先に試すこと。
   *
   * @param {string} agentKey エージェントキー
   * @returns {string} デモのセリフ
   */
  getOfflineMockDialog(agentKey) {
    const config = this.getConfig();
    const profile = (config.show && config.show.user_profile) || {};
    const name     = profile.name            || 'リスナー';
    const location = profile.location        || '東京';
    const station  = profile.nearest_station || '最寄り駅';
    const _mockCaster = (config.agents?.caster?.name)         || 'MAX';
    const _mockAsst   = (config.agents?.assistant?.name)      || 'Clara';
    const _mockCm     = (config.agents?.commentator?.name)    || '高橋洋二教授';
    const _mockDj     = (config.agents?.music_dj?.name)       || 'DJ サキ';
    const _mockLa     = (config.agents?.life_advisor?.name)   || '平野ドレミ';
    const _mockLg     = (config.agents?.legal_advisor?.name)  || '北村昭雄';
    const _mockCd     = (config.agents?.comedian?.name)       || '難波亭 ボケ';
    const _mockDr     = (config.agents?.doctor?.name)         || '華院 麗子';
    const _mockMk     = (config.agents?.marketer?.name)       || '世界 創';
    const dialogs = {
      director:  `リスナーの${name}さん、お聴きいただきありがとうございます！今日もAIラジオが始まりますよ。まずはキャスターの${_mockCaster}、準備はいいかい？`,
      caster:    `イェーイ！${_mockCaster}です！${name}さん、今日の調子はいかがですか？今日のカレンダーを見ましたけど、予定がびっしり入っていますね！`,
      assistant: `こんにちは、${_mockAsst}です。${_mockCaster}、そんな大声で喋らなくても聞こえていますよ。${name}さんのカレンダーを見ると、14時の打ち合わせが山場ですね。`,
      weather:   `${location}のお天気情報です。今日は晴れ間が広がりますが、夕方から雲が広がります。雲を見上げていると、私たちの存在自体が一時的な水蒸気のように思えてきますね…`,
      traffic:          `交通情報をお伝えします。${station}周辺の路線は現在平常運転ですが、夕方のラッシュに向けて混雑が見込まれます。まるで都会の血管のようですね。`,
      news:             `報道センターからニュースをお伝えします。本日、AI Radioプロジェクトの新しいロードマップが策定され、サーバーミキサー機能の実証テストが無事開始されました。`,
      commentator_pre:  `少し最新の状況を調べますので、少々お待ちください。今の経済指標を確認してきます。`,
      commentator:      `${_mockCm}です。データを確認しました。実際の数字を見ると一目瞭然ですが、現在の経済状況は複合的な要因が絡み合っています。財政政策・金融政策の両輪が今後の動向を左右するでしょう。以上でした。${_mockCaster}さん、どうぞ。`,
      journalist_pre:   `少し確認します。ちょっとお待ちを。`,
      journalist:       `私のソースによると、表に出ていない動きがあります。某関係者から直接確認した情報では、オールドメディアが報じていない重要な事実があります。詳しくは言えませんが、注意して見ておいた方がいいでしょう。…ではまた。`,
      music_dj_pre:          `今週のチャートをチェックしていますよ、少しだけ待ってください！`,
      music_dj:              `音楽・エンタメ担当、${_mockDj}です！今週もやばい曲が揃っていますよ！Billboard Japanのトップはすごく盛り上がっていますし、新譜も続々と出ています。これ絶対チェックしてください！芸能ニュースも盛りだくさんです。以上、${_mockDj}がお届けしました！${_mockCaster}、どうぞ！`,
      life_advisor_pre:      `ちょっと最新情報を調べますね〜！少しだけ待っておくんなまし！`,
      life_advisor:          `生活アドバイザーの${_mockLa}です！今日のおすすめレシピをご紹介しますよ。今が旬の食材を使った簡単料理だべ。フライパン一つで作れるので、忙しい${name}さんにもぴったりっちゃ！ぜひ今晩試してみてくださいね。以上、${_mockLa}がお届けしました！${_mockCaster}、どうぞ！`,
      legal_advisor_pre:     `なるほど、少し判例を確認させてください。少々お待ちください。`,
      legal_advisor:         `弁護士の${_mockLg}です。歩く六法全書と呼ばれる私にお任せください。今回の件は民法の観点から見ますと、実に興味深い問題です。法律は市民の味方ですから、皆さんもぜひ基礎知識を持っておいてください。以上、${_mockLg}でした。${_mockCaster}さん、どうぞ。`,
      comedian_pre:          `お、ええ質問やな。ちょっと今どうなっとるか確かめてくるわ。待っといて。`,
      comedian:              `${_mockCd}です。要するにこういうことやろ？難しい言葉で言うてるけど、うちの近所の話に置き換えたら一発でわかる話や。わしも昔えらい目に遭うたことがあってな、あれと同じ構図やねん。ほんで、誰も聞かへんけど、そもそもなんでこうなってんのか、そこがいちばんの疑問やな。以上、${_mockCd}でした。${_mockCaster}さん、どうぞ。`,
      doctor_pre:            `良いご質問ですわ。最新の知見を確認してまいりますので、少しお待ちくださいませ。`,
      doctor:                `${_mockDr}でございます。まず分かっていることと、まだ分かっていないことを切り分けてお話しいたしますね。制度の建前と、診療の現場で実際に起きていることには、正直なところ隔たりがございます。今日からできることとしては、生活のリズムを一定に保つことです。以上、${_mockDr}でした。${_mockCaster}さん、どうぞ。`,
      marketer_pre:          `面白いところに来ましたね。今の動きを確かめますので、少しだけお待ちを。`,
      marketer:              `${_mockMk}です。今この動きが伸びているのは、人の中にあった「言葉にできなかった欲求」に形が与えられたからです。つまり、商品が変わったのではなく、人の受け取り方が変わった。ここから先は、同じ感情に別の入口を用意した側が伸びます。以上、${_mockMk}でした。${_mockCaster}さん、どうぞ。`,
    };
    return dialogs[agentKey] || '皆さんこんにちは。今日も素晴らしい時間をお届けします。';
  }

  /**
   * Google Search グラウンディングが付加した引用マーカー・出典セクションを除去する。
   * TTS に渡す前に呼ぶことで、[1][2] による無音クリック音と
   * "Sources: ..." の英語読み上げを防ぐ。
   */
  static _stripSearchCitations(text) {
    // 引用番号マーカー [1] [2] [1][2] などを除去（前後の空白も整理）
    text = text.replace(/\s*\[\d+\](?:\[\d+\])*/g, '');
    // 末尾の出典ブロック（Sources: / References: / 出典: など）以降を削除
    text = text.replace(/[\n\r]+\s*(?:Sources?|References?|Citations?|Source(?:s)?\s+list|出典|参照|ソース)[:\s：][\s\S]*$/i, '');
    // 文末に残存した孤立 URL を除去
    text = text.replace(/https?:\/\/[^\s　-鿿゠-ヿ぀-ゟ]+/g, '');
    // 連続する空白・改行を整理
    text = text.replace(/[ \t]{2,}/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // ─────────────────────────────────────────────
  //  番組ループ制御
  // ─────────────────────────────────────────────

  /**
   * 番組の進行ループを始める。
   */
  startShowLoop() {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;
    getLogger().info('AI-Radio Autopilot Orchestration System activated.');

    // セッション開始時刻を記録し、長期記憶を読み込む
    this._sessionStartTime = Date.now();
    this._loadLongTermMemory();
    // 同じ放送日の編成キューが保存されていれば引き継ぐ（接続・再起動をまたいで続きから流す）。
    this._loadCornerQueueState();

    // BUGFIX: 保存済みのキューをそのまま引き継ぐと、コーナーを増やしても既存のキューが尽きるまで
    //         新しいコーナーが一度も現れない。保存されたキューに未知のコーナーが混ざっていないか、
    //         また今の顔ぶれと食い違っていないかを見て、食い違っていれば作り直すこと。
    this._prefetchNextDirectorDecision();

    // 起動時に PROGRAM / MODE をブロードキャスト
    const prog = this._getProgramInfo();
    this._broadcast({ event: 'SHOW_INFO', slot: prog.slot, name: prog.name });
    this._syncMode();

    // ハートビート開始
    this._startHeartbeat(30000);

    // ── 起動時点でクライアント未接続なら即待機モードへ（Gemini 呼ばない）──
    if (this.server.getClientCount && this.server.getClientCount() === 0) {
      getLogger().info('[Show] 起動時リスナー未接続 — 接続待ちモードで待機します');
      this._waitingForClients = true;
      this.showTimer = setTimeout(() => this.runSingleShowStep(), 5000);
      return;
    }

    // 接続済みの場合はオープニングから開始
    this.runOpeningSequence().catch(err => {
      getLogger().error('[AgentSystem] Opening sequence failed, falling back to main loop:', err);
      this.mixer._volumeLocked = false;
      this._openingDone = true;
      this.mixer.startRegularBgm();
      this.mixer.setBgmVolumeTarget(1.0);
      this.currentTokenHolder = 'caster';
      this.runSingleShowStep();
    });
  }

  /**
   * 番組の進行ループを止める。
   */
  stopShowLoop() {
    this.isLoopRunning = false;
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    getLogger().info('AI-Radio Autopilot Orchestration System deactivated.');
  }

  // ─────────────────────────────────────────────
  //  日付ユーティリティ

  /**
   * 「1日」の区切り時刻（day_start_hour）を考慮した番組日付文字列を返す。
   * 例: day_start_hour=4 の場合、午前3時は前日扱い → "2026-06-16"
   */
  // _getShowDay() は共有ミックスイン（lib/agent-shared-mixin.js）へ集約。

  /** long_term_memory.json に last_full_intro_show_day を書き込む */
  _saveFullIntroDay(showDay) {
    try {
      let data = {};
      if (fs.existsSync(LONG_TERM_MEMORY_PATH)) {
        try { data = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_PATH, 'utf8')); } catch { /* ignore */ }
      }
      data.last_full_intro_show_day = showDay;
      writeJsonFile(LONG_TERM_MEMORY_PATH, data);
    } catch (e) {
      getLogger().warn('[Opening] last_full_intro_show_day 保存失敗: ' + e.message);
    }
  }

  /**
   * ディレクターの編成キューをファイルへ保存する。
   *
   * BUGFIX: メモリ上だけに持つと再起動のたびに失われ、そのたびに「本日最初のサイクル」と
   *         判定されてニュースが必ず先頭に固定される。20分程度の視聴を繰り返すリスナーは
   *         「毎回ニュースから始まって他のコーナーへ到達しない」状態になる。
   *
   * ATTENTION: 放送日も併せて記録し、日付が変わったら復元しないこと。その日の最初の接続で
   *            新しい編成が組まれるようにするため。
   */
  _saveCornerQueueState() {
    try {
      writeJsonFile(DIRECTOR_QUEUE_STATE_PATH, {
        show_day: this._getShowDay(),
        corner_queue: this._cornerQueue,
        last_director_plan_show_day: this._lastDirectorPlanShowDay,
        recent_corners: this._recentCorners,
        last_corner: this._lastCorner,
        saved_at: new Date().toISOString(),
      });
    } catch (e) {
      getLogger().warn('[Director] 編成キューの保存に失敗: ' + e.message);
    }
  }

  /**
   * 保存済みの編成キューを復元する（startShowLoop から起動時に1回だけ呼ぶ）。
   * show-day が変わっていれば復元しない——その日の最初の接続では新しい編成を組む、という
   * 要望どおりの挙動にするため（キューが空なら _selectNextCorner が _refillCornerQueue を
   * 呼び、そこで isFirstCycleOfDay=true としてニュースが先頭に置かれる）。
   */
  _loadCornerQueueState() {
    try {
      if (!fs.existsSync(DIRECTOR_QUEUE_STATE_PATH)) return;
      const saved = JSON.parse(fs.readFileSync(DIRECTOR_QUEUE_STATE_PATH, 'utf8'));
      const today = this._getShowDay();
      if (saved.show_day !== today) {
        getLogger().info(`[Director] 保存済み編成は前日のもの（${saved.show_day}）のため破棄し、本日分を新規に編成します`);
        return;
      }
      if (!Array.isArray(saved.corner_queue)) return;
      this._cornerQueue = saved.corner_queue;
      // これを復元しないと、再起動のたびに「本日初回」と誤判定されニュースが先頭へ固定される
      // （この不具合の直接の原因だった）。
      this._lastDirectorPlanShowDay = saved.last_director_plan_show_day ?? null;
      if (Array.isArray(saved.recent_corners)) this._recentCorners = saved.recent_corners;
      if (saved.last_corner) this._lastCorner = saved.last_corner;
      getLogger().info(`[Director] 本日の編成キューを復元（残り${this._cornerQueue.length}コーナー）: ${this._cornerQueue.join(' → ') || '（空）'}`);
      // ダッシュボードが起動直後から保存済みキューを表示できるようにする（要望3）。
      this._broadcastQueueUpdate();
    } catch (e) {
      getLogger().warn('[Director] 編成キューの復元に失敗: ' + e.message);
    }
  }

  //  オープニング / エンディングシーケンス
  // ─────────────────────────────────────────────

  /**
   * オープニングシーケンス:
   *   1. opening/ の MP3 をジングルとして ~15秒再生（フェードアウト付き）
   *   2. キャスターが番組開始の挨拶・紹介
   *   3. 通常 BGM 開始
   *   4. メイン番組ループへ移行
   */
  /**
   * オープニングで名前を挙げるスタジオの出演者を選ぶ。
   *
   * スタジオの出演者（キャスターとアシスタントを除く）が増えたため、オープニングでは全員を
   * 紹介せず、2人の名前だけを挙げて「をはじめ◯名」とまとめる。名前を挙げる2人は、この後の
   * 編成（_cornerQueue）で出番が早い人を優先し、足りなければ残りから無作為に選ぶ。音楽 DJ は
   * ほぼ毎サイクル出番があり、優先すると毎回名前が挙がってしまうので、無作為の側にだけ入れる。
   * 顔ぶれは SFX_ELIGIBLE_AGENT_KEYS（スタジオに同席する設定の出演者）と同じ。
   *
   * @param {Record<string, any>} config 設定全体
   * @returns {{featured: string[], total: number}} 名前を挙げる出演者の名前と、出演者の総数
   */
  _pickStudioRollCall(config) {
    const agents = config.agents || {};
    const members = [...SFX_ELIGIBLE_AGENT_KEYS]
      .filter(key => key !== 'caster' && key !== 'assistant' && agents[key]?.name);
    const upcoming = [...new Set((this._cornerQueue || [])
      .filter(key => key !== 'music_dj' && members.includes(key)))];
    const rest = members.filter(key => !upcoming.includes(key)).sort(() => Math.random() - 0.5);
    // 管理画面の名前には役割の注記が括弧で付くことがある（「◯◯（医師）」など）。例文にそのまま
    // 入れると注記まで読み上げられるので落とす
    const featured = [...upcoming, ...rest].slice(0, 2)
      .map(key => String(agents[key].name).replace(/[（(][^）)]*[）)]/g, '').trim());
    return { featured, total: members.length };
  }

  /**
   * オープニングで出演者をどう紹介するかの指示文を組み立てる（全員は紹介しない）。
   *
   * @param {Record<string, any>} config 設定全体
   * @returns {string} プロンプトに入れる指示文
   */
  _buildStudioRollCallInstruction(config) {
    const { featured, total } = this._pickStudioRollCall(config);
    if (featured.length === 0) {
      return 'スタジオの出演者は、それぞれのコーナーで紹介するとだけ伝えてください（名前は挙げない）。\n';
    }
    const names = featured.join('、');
    return `今日のスタジオの出演者は全員を紹介せず、次の${featured.length}人だけ名前を挙げて短くまとめてください:\n` +
      `- 名前を挙げる人: ${names}（名前には自然な敬称を付ける）\n` +
      `- スタジオの出演者は全部で${total}名です\n` +
      `- 言い方の例:「今日のスタジオには${names}をはじめ、${total}名の皆さんにお越しいただいています。` +
      `それぞれのコーナーでご紹介しますね」\n` +
      `⚠️ それ以外の出演者の名前や、一人ひとりの担当の説明はしないこと。\n`;
  }

  /**
   * オープニング（ジングル・出演者の紹介・最初の掛け合い）を流す。
   *
   * @returns {Promise<void>}
   */
  async runOpeningSequence() {
    if (!this.isLoopRunning) return;

    // ── オープニングをスキップ ──────────────────────────────────────────────────
    const _showCfg = this.getConfig().show;
    if (_showCfg?.skip_opening) {
      this.mixer.talkBuffer = Buffer.alloc(0);
      this._openingDone = true;
      this.mixer.startRegularBgm();
      if (_showCfg.force_first_corner) {
        this._nextCorner = _showCfg.force_first_corner;
        this._nextCornerFromRequest = false;
      }
      getLogger().info('[Show] オープニングをスキップ');
      if (this.isLoopRunning) {
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this.showTimer = setTimeout(() => this.runSingleShowStep(), 500);
      }
      return;
    }
    // force_first_corner のみ（スキップなし）
    if (_showCfg?.force_first_corner && !this._nextCorner) {
      this._nextCorner = _showCfg.force_first_corner;
      this._nextCornerFromRequest = false;
    }

    // ── 音量ロック（第1 await の前・同期処理で実行）──────────────────────────────
    // registerClient() → startBroadcast() はこの直後に呼ばれる。
    // _volumeLocked=true にしておくことで startBroadcast 内の「通常BGM自動再生」をスキップさせ、
    // オープニングジングルが始まる前に突然 BGM が鳴り出す（ガリガリ音）を防ぐ。
    this.mixer._volumeLocked   = true;
    this.mixer.currentBgmVolume = 0;
    this.mixer.targetBgmVolume  = 0;
    // 前回セッションで talkBuffer に残留した TTS データを消去（再接続時の残留ノイズ対策）
    this.mixer.talkBuffer = Buffer.alloc(0);

    const openingDir = path.join(__dirname, 'assets', 'bgm', 'opening');
    const hasOpening = fs.existsSync(openingDir) &&
      fs.readdirSync(openingDir).some(f => f.endsWith('.mp3'));

    // キャスター挨拶の生成はジングルと並行して開始（パイプライン）
    const prog = this._getProgramInfo();
    const config = this.getConfig();
    const username = (config.show && config.show.user_profile && config.show.user_profile.name) || 'リスナー';

    // ── 同日再接続チェック: 今日すでにフルオープニングを行っていたら短縮版 ──────────
    const _currentShowDay = this._getShowDay();
    let _isReturningToday = false;
    try {
      if (fs.existsSync(LONG_TERM_MEMORY_PATH)) {
        const _memCheck = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_PATH, 'utf8'));
        if (_memCheck.last_full_intro_show_day === _currentShowDay) _isReturningToday = true;
      }
    } catch { /* ignore */ }

    if (_isReturningToday) {
      // ── 短縮オープニング（2度目以降の接続）───────────────────────────────────
      getLogger().info('[Opening] 同日再接続 — 短縮オープニングを使用');
      this._broadcast({ event: 'NOTIFY', message: 'オープニング（再接続）' });
      // ジングルと挨拶生成を並行して開始し、テキスト生成完了後すぐ第1文のTTS合成まで完了させる
      // （フルオープニングと同じパターン。ジングルフェードアウト後の無音を最小化する）
      const _shortIntroPromise = this.generateAgentSpeech('caster',
        `${username}さんが再び接続してくれました。\n` +
        `「おかえりなさい！」と温かく迎えてください。\n` +
        `メンバー紹介・番組説明は一切不要です。\n` +
        `「引き続き${prog.name}をお楽しみください」という一言添えて、2〜3文の簡潔な挨拶にしてください。\n` +
        `⚠️ メンバーの名前・役割・センターの説明などは絶対に言わないこと。`
      ).then(async introText => {
        const _castrCfgShort = (this.getConfig().agents?.['caster']) || {};
        const _castrGeminiShort = (_castrCfgShort.tts_engine || 'gemini') === 'gemini';
        const sentences = _castrGeminiShort
          ? this._splitTextToSentencesGemini(introText)
          : this._splitTextToSentences(introText);
        const firstPcm = await this._collectPcm(sentences[0], 'caster');
        return { introText, firstPcm };
      });
      // 固定尺ではなく、セリフ生成が完了するまでジングルをループ再生し続ける方式
      // （準備にどれだけ時間がかかっても自然に埋める。最低再生時間はOPENING_MIN_PLAY_MS）
      let _shortOpeningStartedAt = null;
      if (hasOpening) {
        this.mixer.playAmbientShuffle(openingDir, 1.0);
        this.mixer.currentBgmVolume = 0;
        this.mixer.fadeBgmTo(1.0, 500);
        _shortOpeningStartedAt = Date.now();
      }
      if (!this.isLoopRunning) return;
      const { introText: _shortIntroText, firstPcm: _shortFirstPcm } = await _shortIntroPromise;
      if (hasOpening) {
        const _shortElapsed = Date.now() - _shortOpeningStartedAt;
        if (_shortElapsed < OPENING_MIN_PLAY_MS) {
          await new Promise(r => setTimeout(r, OPENING_MIN_PLAY_MS - _shortElapsed));
        }
        await this.mixer.fadeBgmTo(0, 2000);
        this.mixer.stopBgm();
        this.mixer._volumeLocked = false;
        await new Promise(r => setTimeout(r, 300));
      }
      // アシスタント の短縮返答を「発話前」に先行生成（発話中に完成させ、直後の無音を防ぐ）
      const _casterNameShort = (config.agents?.caster?.name) || 'MAX';
      const _shortClaraCtx =
        `【${_casterNameShort}の直前の発言】${_shortIntroText}\n` +
        `${username}さんが再接続してきました。「またよろしくお願いします」と一言だけ軽く挨拶してください（1〜2文）。メンバー紹介・番組説明は不要です。`;
      this._prefetchedSpeech = this._buildPrefetchedSpeech('assistant', this.generateAgentSpeech('assistant', _shortClaraCtx), 'assistant');
      // アシスタント の実際の発話テキストは _runAssistantStep 側で prefetch が解決されるまで確定しないため、
      // そちらで一回だけ日記を書かせるためのワンショットフラグを立てておく（フルオープニングと同じ仕組み）。
      this._pendingOpeningDiaryForAssistant = true;
      await this.speakText(_shortIntroText, 'caster', _shortFirstPcm);
      this._openingDone = true;
      this.lastSpeech.caster = _shortIntroText;
      this._bufferMaxClaraDiaryText('caster', _shortIntroText);
      this.mixer.startRegularBgm();
      if (this.isLoopRunning) {
        this.conversationTurn = 1;
        this.currentTokenHolder = 'assistant';
        this.showTimer = setTimeout(() => this.runSingleShowStep(), 2000);
      }
      return;
    }

    // スタジオの出演者の紹介（全員ではなく2人の名前と総数だけ）
    const agents0    = config.agents || {};
    const asstName0  = (agents0.assistant    && agents0.assistant.name)    || 'Clara（アシスタント）';
    const rollCall0  = this._buildStudioRollCallInstruction(config);

    // ジングル中にセリフ生成＋第1文の TTS 合成まで並行して完了させる（開幕遅延を最小化）
    const introReadyPromise = this.generateAgentSpeech('caster',
      `番組開始のオープニングです。「${prog.name}」が始まりました。\n` +
      `${username}さんへ明るく元気に挨拶してください。\n` +
      `相棒のアシスタント ${asstName0} には一言声をかけてください。\n` +
      rollCall0 +
      `各センター（気象・交通・報道・金融）や海外の特派員とも、番組の途中でつなぐことを一言で添えてください（名前は挙げない）。\n` +
      `「今日も盛りだくさんでお届けします！」という期待感で締めてください。4〜5文でテンポよく。\n` +
      `\n⚠️【厳守】前回の番組・過去のセッションの話題（かかった曲・前回の会話内容・前回のトピック等）には一切触れないこと。` +
      `このオープニングは完全に新しいセッションの幕開けです。リスナーが初めて聴くような新鮮な挨拶にしてください。`
    ).then(async introText => {
      // セリフ生成が完了したらすぐに第1文の TTS 合成を開始（ジングルが続いている間に完了する）
      // speakText と同じ分割ロジックで 1 文目を特定しないと preloadedFirstPcm が別テキストのPCMになりコンテンツ欠落が生じる
      const _castrCfg = (this.getConfig().agents?.['caster']) || {};
      const _castrGemini = (_castrCfg.tts_engine || 'gemini') === 'gemini';
      const sentences = _castrGemini
        ? this._splitTextToSentencesGemini(introText)
        : this._splitTextToSentences(introText);
      const firstPcm = await this._collectPcm(sentences[0], 'caster');
      return { introText, firstPcm };
    });

    // 固定尺ではなく、セリフ生成＋第1文TTSが完了するまでジングルをループ再生し続ける方式
    // （準備にどれだけ時間がかかっても自然に埋める。最低再生時間はOPENING_MIN_PLAY_MS）
    let _openingStartedAt = null;
    if (hasOpening) {
      this._broadcast({ event: 'NOTIFY', message: 'オープニング' });
      this.mixer.playAmbientShuffle(openingDir, 1.0);
      this.mixer.currentBgmVolume = 0;
      this.mixer.fadeBgmTo(1.0, 500);
      _openingStartedAt = Date.now();
    }

    if (!this.isLoopRunning) return;

    // ジングルループ中にセリフ＋第1文 TTS の完成を待つ（通常は待ち時間ほぼゼロ）
    const { introText, firstPcm } = await introReadyPromise;

    if (hasOpening) {
      // 準備がOPENING_MIN_PLAY_MSより早く終わった場合、曲が短すぎる印象にならないよう
      // 最低再生時間まで待ってからフェードアウトする（準備がこれより長引いた場合は
      // 上のループ再生が既に無音なく埋めているため、ここでの追加待機は発生しない）。
      const _elapsed = Date.now() - _openingStartedAt;
      if (_elapsed < OPENING_MIN_PLAY_MS) {
        await new Promise(r => setTimeout(r, OPENING_MIN_PLAY_MS - _elapsed));
      }
      await this.mixer.fadeBgmTo(0, 2000);
      this.mixer.stopBgm();
      this.mixer._volumeLocked = false;
      // ジングル終了後のブレス
      await new Promise(r => setTimeout(r, 300));
    }

    // ── アシスタント のオープニング返答を「オープニング発話の前」に先行生成 ──
    // オープニング挨拶は長い（数十秒）ため、発話中に アシスタント の返答テキスト＋1文目TTSを
    // 完成させておく。以前は発話「後」に生成していたため、オープニング直後の アシスタント 開始に
    // 数秒〜十数秒の無音が生じていた（プリフェッチが実質機能していなかった）。
    const asstCfgOpen = (config.agents && config.agents.assistant) || {};
    const asstNameOpen = asstCfgOpen.name || 'Clara（アシスタント）';
    const _casterNameOpen = (config.agents?.caster?.name) || 'MAX';
    const claraOpenCtx =
      `【リスナー情報】名前: ${username}\n` +
      `【${_casterNameOpen}の直前の発言（オープニング）】${introText}\n` +
      `${_casterNameOpen}がオープニングでスタジオメンバーを紹介してくれました。\n` +
      `元気よく短く（2〜3文）挨拶してください。` +
      `礼儀正しいが時々毒舌な${asstNameOpen}らしい個性を少し出してOKです。\n` +
      `⚠️【厳守】前回の番組・過去セッションの話題（かかった曲・前回の会話内容等）には一切触れないこと。新しいセッションの開幕として新鮮に挨拶してください。`;
    this._prefetchedSpeech = this._buildPrefetchedSpeech('assistant', this.generateAgentSpeech('assistant', claraOpenCtx), 'assistant');
    // アシスタント の実際の発話テキストは _runAssistantStep 側で prefetch が解決されるまで確定しないため、
    // そちらで一回だけ日記を書かせるためのワンショットフラグを立てておく。
    this._pendingOpeningDiaryForAssistant = true;

    await this.speakText(introText, 'caster', firstPcm);

    // 特別な日（誕生日・記念日等）のオープニングは一度だけ fanfare で盛り上げる
    // （コード主導のSFXフック。LLMのタグ埋め込みには依存しない）
    try {
      const userProfile0 = config.show?.user_profile || {};
      const dateObj0   = new Date();
      const todayStr0  = `${String(dateObj0.getMonth() + 1).padStart(2, '0')}-${String(dateObj0.getDate()).padStart(2, '0')}`;
      const birthdayMMDD0 = userProfile0.birthday ? userProfile0.birthday.replace(/^\d{4}-/, '') : userProfile0.birthday;
      const isBirthday0 = todayStr0 === birthdayMMDD0;
      const activeSpecial0 = (userProfile0.special_dates || []).find(sd => {
        if (!sd.start || !sd.end) return false;
        const s = sd.start.replace(/^\d{4}-/, '');
        const e = sd.end.replace(/^\d{4}-/, '');
        return s <= e ? (todayStr0 >= s && todayStr0 <= e) : (todayStr0 >= s || todayStr0 <= e);
      });
      if (isBirthday0 || activeSpecial0) {
        // casterのAGENT_SPEAKING/SILENTでブラケットし、演出中にアバターがロゴへ戻らないようにする
        await this._playSfxAsAgent('fanfare', 'caster', 0);
      }
    } catch (e) {
      getLogger().warn(`[Opening] 特別な日SFXチェックでエラー: ${e?.message}`);
    }

    // キャスト紹介済みフラグをセット（メインループ内の重複オープニングを防ぐ）
    this._openingDone = true;
    this.lastSpeech.caster = introText; // オープニング発言をキャスターの直前発言として記録
    this._bufferMaxClaraDiaryText('caster', introText);

    // フルオープニング完了 → 本日分として記録（同日再接続では短縮版が使われる）
    this._saveFullIntroDay(_currentShowDay);

    // 通常 BGM を開始（音量 0 から auto-ducking が自然に 1.0 へ）
    this.mixer.startRegularBgm();

    // アシスタント のオープニング返答は上記（オープニング発話の前）で先行生成済み。
    // オープニング＝ターン0 として扱い、次はアシスタントが応答する。
    // これにより runSingleShowStep が caster ターン0 で再度挨拶を生成する二重発話バグを防ぐ。

    // メインループへ移行 — オープニングをターン0とみなし アシスタント へ直接パス
    if (this.isLoopRunning) {
      this.conversationTurn = 1;       // オープニングがターン0 → 次は アシスタント のターン
      this.currentTokenHolder = 'assistant';
      this.showTimer = setTimeout(() => this.runSingleShowStep(), 2000);
    }
  }

  /**
   * エンディングシーケンス:
   *   1. 番組ループを停止
   *   2. キャスターがお別れの挨拶
   *   3. ending/ の MP3 をジングルとして ~30秒再生（フェードイン・アウト付き）
   *   4. 番組終了イベントをブロードキャスト
   */
  async runEndingSequence() {
    getLogger().info('[AgentSystem] Starting ending sequence...');

    // 番組ループを停止
    this.isLoopRunning = false;
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }

    const prog = this._getProgramInfo();
    const config = this.getConfig();
    const username = (config.show && config.show.user_profile && config.show.user_profile.name) || 'リスナー';

    // エンディング開始をブロードキャスト
    this._broadcast({ event: 'SHOW_INFO', slot: 'ending', name: `${prog.name} エンディング` });

    // キャスターがお別れの挨拶
    const goodbyeText = await this.generateAgentSpeech('caster',
      `番組のエンディングです。「${prog.name}」をお聴きいただきありがとうございました。` +
      `${username}さんへ感謝の気持ちを伝え、丁寧にお別れの挨拶をしてください。`
    );
    await this.speakText(goodbyeText, 'caster');

    // キャスター・アシスタント それぞれの日記（番組終了の振り返り）。アシスタント は放送では喋らないが、
    // 本日の会話（直前の発言）を材料に非公開の振り返りだけ生成する。
    const _casterNameEnd = (config.agents?.caster?.name) || 'MAX';
    const _asstNameEnd    = (config.agents?.assistant?.name) || 'Clara（アシスタント）';
    this._flushMaxClaraDiary('caster', _casterNameEnd, goodbyeText).catch(() => {});
    this._flushMaxClaraDiary('assistant', _asstNameEnd, this.lastSpeech.assistant).catch(() => {});
    this._writeDirectorSessionSummaryDiary().catch(() => {});

    // エンディングジングルを再生（ファイルがあれば）
    const endingDir = path.join(__dirname, 'assets', 'bgm', 'ending');
    const hasEnding = fs.existsSync(endingDir) &&
      fs.readdirSync(endingDir).some(f => f.endsWith('.mp3'));

    if (hasEnding) {
      await this.mixer.playJingle(endingDir, {
        fadeInMs: 2000,
        playDurationMs: 30000,
        fadeOutMs: 3000
      });
    }

    // セッション終了時に長期記憶を更新（エンディングジングル後に実行）
    try {
      getLogger().info('[Memory] セッション要約を生成中...');
      const _endingSummary = await this._generateSessionSummary();
      if (_endingSummary) {
        await this._saveSessionSummary(_endingSummary);
        this._loadLongTermMemory(); // 同じプロセスで再起動される場合のためキャッシュも更新
      }
    } catch (_memErr) {
      getLogger().warn('[Memory] 要約生成失敗（番組進行に影響なし）: ' + _memErr.message);
    }

    // 番組終了をブロードキャスト
    this._broadcast({ event: 'SHOW_INFO', slot: 'ended', name: '番組終了' });
    getLogger().info('[AgentSystem] Show ended.');
  }

  // ─────────────────────────────────────────────
  //  番組ステップ実行（トークンパッシング状態マシン）
  // ─────────────────────────────────────────────

  /**
   * 1回分の進行を実行する。二重に同時実行されないようガードしてから中身を呼ぶ。
   *
   * BUGFIX: 次の予約が既存のタイマーを消さずに張り直すことや、複数の場所から直接呼ばれる
   *         経路があるため、コーナーがまだ発話中（長いコーナーだと1分以上かかる）の間に
   *         別のきっかけで再び呼ばれ、同じコーナーが全く同じキャッシュ済みのテキストで
   *         二重に発話される。
   *
   * @returns {Promise<void>}
   */
  async runSingleShowStep() {
    if (!this.isLoopRunning) return;
    if (this._stepInProgress) {
      getLogger().debug('[Show] runSingleShowStep: 既に実行中のため二重起動をスキップ');
      return;
    }
    this._stepInProgress = true;
    try {
      await this._runSingleShowStepInner();
    } finally {
      this._stepInProgress = false;
    }
  }

  /**
   * 1回分の進行の中身。今の発言権に応じて、担当のターンの処理へ振り分ける。
   *
   * @returns {Promise<void>}
   */
  async _runSingleShowStepInner() {
    if (!this.isLoopRunning) return;
    const _myGen = this._speakGeneration; // セッション世代: disconnect で加算される

    // ── クライアント未接続なら待機（Gemini / TTS を呼ばずトークン節約）──
    const clientCount = this.server.getClientCount ? this.server.getClientCount() : 1;
    if (clientCount === 0) {
      if (!this._waitingForClients) {
        this._waitingForClients = true;
        this._lastClientDisconnectAt = Date.now(); // 再接続時のキャッシュ刷新判定に使用
        this._prefetchedSpeech = null; // 先読みキャッシュを破棄
        getLogger().info('[Show] リスナー未接続 — 待機モードに入ります（API呼び出し・BGM停止）');
        this.mixer.stopBgm(); // ffmpeg プロセスを停止して CPU を節約

        // onClientDisconnected が既にメモリ保存を開始しているはずだが、
        // Spotify 待機中などで通らなかった場合のフォールバックとして残す
        if (!this._isShuttingDown) {
          this._isShuttingDown = true;
          getLogger().info('[Memory] (フォールバック) セッション要約を生成中...');
          this._generateSessionSummary().then(async s => {
            if (s) {
              await this._saveSessionSummary(s);
              this._loadLongTermMemory();
            }
          }).catch(e => {
            getLogger().warn('[Memory] 切断時の要約生成失敗: ' + e.message);
          }).finally(() => {
            this._isShuttingDown = false;
            getLogger().info('[Show] 終了処理完了 — 新規接続を受け付けます');
          });
        }
      }
      this.showTimer = setTimeout(() => this.runSingleShowStep(), 5000);
      return;
    }
    if (this._waitingForClients) {
      this._waitingForClients = false;
    }

    try {
      const config = this.getConfig();

      // ── エージェント名（管理画面で変更可能 → config から毎回取得）────────────
      const _an = {
        caster:        (config.agents?.caster?.name)         || 'MAX',
        assistant:     (config.agents?.assistant?.name)      || 'Clara',
        world_report:  (config.agents?.world_report?.name)   || 'Steve',
        music_dj:      (config.agents?.music_dj?.name)       || 'DJ サキ',
        life_advisor:  (config.agents?.life_advisor?.name)   || '平野ドレミ',
        commentator:   (config.agents?.commentator?.name)    || '高橋洋二教授',
        journalist:    (config.agents?.journalist?.name)     || '謎のジャーナリストX',
        legal_advisor: (config.agents?.legal_advisor?.name)  || '北村昭雄',
        comedian:      (config.agents?.comedian?.name)       || '難波亭 ボケ',
        doctor:        (config.agents?.doctor?.name)         || '華院 麗子',
        marketer:      (config.agents?.marketer?.name)       || '世界 創',
      };

      // ── ユーザーリクエスト読み取り（クリアは処理直前に行う）────────────────
      // currentTokenHolder === 'caster' かつ conversationTurn === 0 の時だけ処理される。
      // それ以外のタイミングで届いたリクエストは config に残し、次の caster ターンで拾う。
      const pendingInstruction = config.show?.current_instruction || '';
      if (pendingInstruction) {
        getLogger().debug(`[Director] ユーザーリクエスト検出（holder=${this.currentTokenHolder}, turn=${this.conversationTurn}）: "${pendingInstruction}"`);
      }

      const userProfile = (config.show && config.show.user_profile) || { name: 'Listener', birthday: '01-01' };
      const username = userProfile.name;
      const birthday = userProfile.birthday;

      // 今日の日付を取得 (MM-DD)
      const dateObj = new Date();
      const month = String(dateObj.getMonth() + 1).padStart(2, '0');
      const day   = String(dateObj.getDate()).padStart(2, '0');
      const todayStr = `${month}-${day}`;
      // 誕生日は YYYY-MM-DD または旧フォーマット MM-DD 両方に対応
      const birthdayMMDD = birthday ? birthday.replace(/^\d{4}-/, '') : birthday;
      const isBirthday = (todayStr === birthdayMMDD);

      // Google データ取得
      const googleData = await this.fetchGoogleData();

      // baseContextPrompt: リスナー基本情報のみ（コーナーエージェントに渡す用）
      // コーナーエージェントはリスナーへの呼びかけに名前・居住地を使う程度で十分。
      // カレンダー・メール・他コーナーのデータは不要（「ニュースコーナーなのに天気を喋る」等の誤動作防止）
      // 有効な滞在地（臨時滞在中なら滞在地、それ以外は通常居住地）
      const { location: _effLocBase, isTempStay: _isTempStayBase, tempStay: _tempStayBase } = this._getEffectiveLocation();
      const profileParts = [
        `名前: ${username}`,
        _isTempStayBase
          ? `現在地: ${_effLocBase}（臨時滞在中・${_tempStayBase?.purpose}、〜${_tempStayBase?.end}まで）`
          : (userProfile.location ? `居住地: ${userProfile.location}` : null),
        userProfile.occupation     ? `職業: ${userProfile.occupation}`        : null,
        userProfile.hobbies        ? `趣味: ${userProfile.hobbies}`           : null,
        userProfile.interests      ? `興味: ${userProfile.interests}`         : null,
      ].filter(Boolean).join(' / ');
      const baseContextPrompt = `【リスナー情報】${profileParts}`;

      // カレンダーイベントのアナウンス済みフィルタリング
      const filteredCalendar = this._filterAnnouncedEvents(googleData.calendar);
      this._markEventsAnnounced(filteredCalendar);

      // contextPrompt: caster/assistant 向け（カレンダー・メール・TODO＋既放送コーナー情報を追加）
      // ラベル自体に「${username}さんの」と明示し、パーソナリティ自身の予定・メールとして
      // 誤って紹介しないようにする（special_datesの帰属バグと同種の問題への対策）
      let contextPrompt = `
${username}さんのGoogleカレンダー予定:\n${filteredCalendar}
${username}さんの未完了TODO:\n${googleData.tasks}
${username}さん宛の重要メール:\n${googleData.gmail}

【コンテキストの活用ルール】
- 上記のカレンダー予定・TODO・メールは、すべて${username}さん個人のものです。${_an.caster}・${_an.assistant}自身の
  予定やメールとして話さないこと。必ず「${username}さんの予定」「${username}さん宛のメール」として
  紹介してください（「僕の予定」「私宛のメール」のような自分事の言い方はしないこと）
- カレンダー予定・TODO・メールに内容がある場合は、会話の流れで自然に触れてください
  例: 「そういえば${username}さん、今日○○の予定がありましたよね？」「TODOに○○が残ってますよ〜」「新着メールに○○が届いてますよ！」
- 新着メールが「番組開始以降の新着メールはありません。」以外の場合は、なるべく早いタイミングで必ず一度は言及してください。
- ただし同じメールを繰り返し読み上げる必要はありません。一度触れたら省略してください。
- 【重要】同じ予定・メールを繰り返しアナウンスしないこと。すでに触れた話題は省略してください。
- 【重要】メールの「概要」に書かれている内容だけを材料にしてください。概要が無い、または
  情報が薄いメールについて、書かれていない具体的な内容（日時・場所・話の中身など）を
  想像で作り上げて紹介することは絶対にしないでください。件名だけで中身が分からない場合は、
  件名と送信者名を伝えるだけに留めるか、「詳しい内容はご自身でご確認くださいね」程度に
  とどめてください。
`;
      const cachedCorner = this._getCachedCornerData();
      if (cachedCorner) {
        contextPrompt += `\n【番組内で既に紹介済みの情報 ― 会話のネタに活用してください】\n${cachedCorner}\n`;
      }
      if (isBirthday) {
        contextPrompt += `\n★超重要: 本日はリスナーの${username}さんの【お誕生日】です！全員で盛大にお祝いし、ハッピーバースデーの音楽をかける流れにしてください！\n`;
      }

      // 臨時滞在地チェック
      const { location: _effLoc, isTempStay: _isTempStay, tempStay: _tempStay } = this._getEffectiveLocation();
      if (_isTempStay && _tempStay) {
        const _isOverseasCtx = _tempStay.timezone && !_tempStay.timezone.startsWith('Asia/');
        contextPrompt += `
【📍 臨時滞在中】
${username}さんは現在、【${_tempStay.location}】に滞在中です（${_tempStay.purpose}、〜${_tempStay.end}まで）。
${_tempStay.note ? `滞在メモ: ${_tempStay.note}` : ''}
- 天気情報は${_tempStay.location}のものが流れます
- ${_isOverseasCtx ? `海外滞在のため国内交通情報は省略されます` : `交通情報は${_tempStay.location}周辺のものが流れます`}
- 会話の中で自然に「今${_tempStay.location}にいらっしゃるんですね」「${_tempStay.purpose}はいかがですか」などと触れてください
`;
      }

      // 特別な日チェック（期間対応）
      // start/end は MM-DD 形式。年をまたぐ場合（12-28〜01-02）も対応。
      const _specialDates = userProfile.special_dates || [];
      const _activeSpecial = _specialDates.find(sd => {
        if (!sd.start || !sd.end) return false;
        const s = sd.start.replace(/^\d{4}-/, '');
        const e = sd.end.replace(/^\d{4}-/, '');
        if (s <= e) {
          return todayStr >= s && todayStr <= e; // 通常範囲
        } else {
          return todayStr >= s || todayStr <= e;  // 年またぎ（例: 12-28〜01-02）
        }
      });
      if (_activeSpecial) {
        // personal: false（クリスマス・お正月等の共通行事）は誰の出来事でもないため
        // 個人への帰属表現をつけない。personal: true/未設定（誕生日・記念日等）は
        // リスナー個人・家族の出来事であることを明示し、パーソナリティ自身の身内の
        // 出来事として誤って語らないよう注意書きを添える
        if (_activeSpecial.personal === false) {
          contextPrompt += `\n★超重要: 本日（${todayStr}）は【${_activeSpecial.label}】です！${_activeSpecial.instruction ? `\n番組への指示: ${_activeSpecial.instruction}` : ''}\nこの特別な日を番組全体で盛り上げてください。\n`;
        } else {
          contextPrompt += `\n★超重要: 本日（${todayStr}）は${username}さんにとって【${_activeSpecial.label}】の日です！${_activeSpecial.instruction ? `\n番組への指示: ${_activeSpecial.instruction}` : ''}\n（これは${username}さんご本人・ご家族の記念日です。パーソナリティ自身の身内の出来事として語らないこと。「僕の息子」ではなく「${username}さんの息子さん」のように、常に${username}さん側の出来事として話してください）\nこの特別な日を番組全体で盛り上げてください。\n`;
        }
      }

      // モードを同期（変化があればブロードキャスト）
      this._syncMode();

      // ─── トークンパッシング状態マシン ───────────────────────────

            // トークン保持者ごとの実行ブロックは _run<Holder>Step へ分割済み（分岐条件・判定順は
      // 旧実装と完全に同一）。try プリアンブルで組み立てたローカル値は ctx にまとめて渡す。
      // 各メソッド内の早期 return は「このステップの残り処理をスキップ」の意味で、
      // このチェーンの後に後続処理は無いため旧実装の method return と等価。
      const ctx = {
        _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
        month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
        _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
        cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial,
      };

      if (this.currentTokenHolder === 'director') {
        // ディレクタは裏方（発言なし）。即座にキャスターへパスする。
        this.currentState = 'IDLE';
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(100, _myGen);

            } else if (this.currentTokenHolder === 'caster') {
        await this._runCasterStep(ctx);
            } else if (this.currentTokenHolder === 'assistant') {
        await this._runAssistantStep(ctx);
            } else if (this._discussionCorner) {
        // 討論コーナー（ニュースディープダイブ等）の進行中。1回の呼び出しで1発言だけ処理し、
        // 終わるまでここで回る（_postCornerExchange と同じ形。lib/agent-discussion-corner.js）。
        await this._runDiscussionTurn(ctx);
            } else if (this._postCornerExchange?.phase === 'guest_reply' &&
                 ['commentator', 'journalist', 'world_report', 'music_dj', 'life_advisor', 'legal_advisor', ...GUEST_ANALYST_KEYS].includes(this.currentTokenHolder)) {
        await this._runGuestReplyStep(ctx);
            } else if (this.currentTokenHolder === 'commentator') {
        await this._runCommentatorStep(ctx);
            } else if (this.currentTokenHolder === 'journalist') {
        await this._runJournalistStep(ctx);
            } else if (this.currentTokenHolder === 'legal_advisor') {
        await this._runLegalAdvisorStep(ctx);
            } else if (GUEST_ANALYST_KEYS.includes(this.currentTokenHolder)) {
        await this._runGuestAnalystStep(ctx, this.currentTokenHolder);
            } else if (this.currentTokenHolder === 'world_report') {
        await this._runWorldReportStep(ctx);
            } else if (this.currentTokenHolder === 'music_dj') {
        await this._runMusicDjStep(ctx);
            } else if (this.currentTokenHolder === 'life_advisor') {
        await this._runLifeAdvisorStep(ctx);
            } else if (this.currentTokenHolder === 'weather'
               || this.currentTokenHolder === 'traffic'
               || this.currentTokenHolder === 'news'
               || this.currentTokenHolder === 'finance') {
        await this._runCenterCornerStep(ctx);
            } else if (this.currentTokenHolder === 'music') {
        await this._runMusicPlaybackStep(ctx);
      }

    } catch (err) {
      getLogger().error(`Error in Show Loop step [tokenHolder=${this.currentTokenHolder}]: ${err?.message || err}`);
      if (err?.stack) getLogger().debug('Show Loop stack:', err.stack);
      this._broadcast({
        event: 'SYSTEM_ERROR',
        code: 'SHOW_LOOP_ERROR',
        message: err.message || 'Unknown show loop error'
      });
      // world_report コーナーでエラーが発生した場合、BGM ロックを必ず解除する
      if (this.mixer._volumeLocked) {
        this.mixer._volumeLocked = false;
        this.mixer.setBgmVolumeTarget(1.0);
        getLogger().warn('[ShowLoop] エラー回復: _volumeLocked を解除・BGM 復元');
      }
      // エラー時は同じコーナーでループしないよう caster に戻してから 5 秒後に再起動
      if (this.currentTokenHolder !== 'caster' && this.currentTokenHolder !== 'director') {
        getLogger().warn(`[ShowLoop] エラー回復: ${this.currentTokenHolder} → caster にリセット`);
        this.currentTokenHolder = 'caster';
        this.conversationTurn = 0;
      }
      this._scheduleNextStep(5000, _myGen);
    }
  }

  // ─── runSingleShowStep: キャスターのターン ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runCasterStep(ctx) {
    const { pendingInstruction, _an } = ctx;

        this.currentState = 'TALKING_CASTER';

        // ── コーナー後のキャスターのリアクション（max_react フェーズ）────────────────────────
        if (this._postCornerExchange?.phase === 'max_react') {
          return this._runCasterMaxReactPhase(ctx);
        }

        // コーナー名の表示マッピング（キャスターがアナウンスする名前）
        const cornerCallNames = {
          weather:      '気象情報センター',
          traffic:      '交通情報センター',
          news:         '報道センター',
          finance:      '金融情報センター',
          commentator:  `${_an.commentator}のコメント`,
          journalist:   `${_an.journalist}のコメント`,
          music_dj:     `${_an.music_dj}の音楽・エンタメ情報`,
          life_advisor: `${_an.life_advisor}の生活アドバイス`,
          world_report: `${_an.world_report}のワールドレポート`,
          legal_advisor: `${_an.legal_advisor}の法律相談`,
          comedian:      getGuestAnalystDef('comedian').callName(_an.comedian),
          doctor:        getGuestAnalystDef('doctor').callName(_an.doctor),
          marketer:      getGuestAnalystDef('marketer').callName(_an.marketer),
        };

        if (this.conversationTurn === 0 && pendingInstruction) {
          const _handled = await this._runCasterPendingInstructionPhase(ctx, cornerCallNames);
          if (_handled) return;
        }

        if (this.conversationTurn === 0 && this.pendingCornerRequests.length > 0) {
          return this._runCasterCornerRequestPhase(ctx, cornerCallNames);
        }

        return this._runCasterNormalFlow(ctx, cornerCallNames);
  }

  // _runCasterStep から分割（大きな1メソッドを4フェーズに機械的分割）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runCasterMaxReactPhase(ctx) {
    const { _myGen, _an, baseContextPrompt } = ctx;

        if (this._postCornerExchange?.phase === 'max_react') {
          const _pce     = this._postCornerExchange;
          const _corner  = _pce.corner;
          const _guestSpeech = (
            this.lastSpeech[_corner] ||
            this.lastSpeech[`${_corner}_outro`] || ''
          ).slice(0, 300);
          const _guestNameMap = {
            commentator:   _an.commentator,  journalist:    _an.journalist,
            world_report:  _an.world_report, music_dj:      _an.music_dj,
            life_advisor:  _an.life_advisor, legal_advisor: _an.legal_advisor,
            comedian:      _an.comedian,     doctor:        _an.doctor,
            marketer:      _an.marketer,
          };
          const _guestName = _guestNameMap[_corner] || 'ゲスト';

          // コーナー種別ごとのキャスターのリアクション指示
          const _maxReactInstMap = {
            commentator:  `${_guestName}のコメントを受けて1〜2文で率直にリアクションしてください。感想・同意・軽いツッコミなど自然に。長い追加質問は厳禁。`,
            journalist:   `${_guestName}の発言を受けて1〜2文でリアクションしてください。${_guestName}のミステリアスな雰囲気に乗りつつ、率直な驚きや感想を一言。`,
            world_report: `${_guestName}のレポートを受けて1〜2文でリアクションしてください。「現地はそんな状況なんですね！」など現地感への反応と、${_guestName}への一言労い・感謝を自然に。`,
            music_dj:     `${_guestName}の音楽・エンタメ情報を受けて1〜2文で明るくリアクションしてください。曲やアーティストへの素直な感想か、気になった情報への一言。楽しそうに短く。`,
            life_advisor:  `${_guestName}のアドバイスを受けて1〜2文でリアクションしてください。「さっそく試してみます！」など素直な反応か、お礼・共感の一言で温かく締めて。`,
            legal_advisor: `${_guestName}の法律解説を受けて1〜2文でリアクションしてください。「なるほど、法律ってそういう仕組みなんですね！」など素直な驚きや感謝の一言で温かく締めて。`,
            comedian:      getGuestAnalystDef('comedian').maxReact({ self: _guestName }),
            doctor:        getGuestAnalystDef('doctor').maxReact({ self: _guestName }),
            marketer:      getGuestAnalystDef('marketer').maxReact({ self: _guestName }),
          };
          // music_dj の max_react は再生曲情報を明示しないと曲名を誤認するため追加
          const _maxReactPlayedLine = (_corner === 'music_dj' && this._recentlyPlayedTracks[0])
            ? `\n【🎵 実際に流れた曲】${this._recentlyPlayedTracks[0].artist} — ${this._recentlyPlayedTracks[0].name}\nこの曲の感想を述べてください。別のアーティスト・曲名を絶対に言わないこと。`
            : '';

          const maxReactCtx = `${baseContextPrompt}
【${_guestName}の発言（要約）】${_guestSpeech}${_maxReactPlayedLine}

⚠️【自己言及の禁止】あなたは${_an.caster}です。ゲストが「${_an.caster}さんのリクエスト」「${_an.caster}さんが〜」と言っていても、自分自身のことは「私の」「俺の」「僕の」など一人称で言い換えてください。自分を三人称（「${_an.caster}さん」）で呼ぶのは禁止です。

${_maxReactInstMap[_corner] || `${_guestName}の発言を受けて1〜2文でリアクションしてください。`}`;

          let maxReactText;
          let _maxReactFirstPcmPromise = null;
          if (this._prefetchedSpeech?.key === `${_corner}_max_react`) {
            const _ps = this._prefetchedSpeech;
            this._prefetchedSpeech = null;
            maxReactText = await _ps.promise;
            _maxReactFirstPcmPromise = _ps.firstPcmPromise || null;
          } else {
            maxReactText = await this.generateAgentSpeech('caster', maxReactCtx);
          }
          this.lastSpeech.caster = maxReactText;
          if (!_maxReactFirstPcmPromise) _maxReactFirstPcmPromise = this._prefetchFirstSentencePcm(maxReactText, 'caster');

          // ゲストの一言返しを、キャスターの発話中に先行生成
          const _guestReplyInstMap = {
            commentator:  `${_an.caster}のリアクション「${maxReactText.slice(0, 100)}」を受けて、${_an.commentator}が1〜2文で軽く返してください。専門家らしい補足か、${_an.caster}の感想への一言。スタジオらしい自然な雑談調で。`,
            journalist:   `${_an.caster}のリアクション「${maxReactText.slice(0, 100)}」を受けて、${_an.journalist}が1〜2文で返してください。謎めいた雰囲気を保ちつつ短く。去り際っぽい一言でも良い。`,
            world_report: `${_an.caster}のリアクション「${maxReactText.slice(0, 100)}」を受けて、${_an.world_report}が1〜2文で返してください。英語まじりOK。現地の雰囲気を一言残して電話を切るような形で自然に締めて。⚠️【禁止】「はい、${_an.caster}」「はい、${_an.caster}さん」等の呼びかけで始めないこと。「ありがとう」「Thank you」など応答から即入ること。`,
            music_dj:     `${_an.caster}のリアクション「${maxReactText.slice(0, 100)}」を受けて、${_an.music_dj}が1〜2文で明るく返してください。次回への期待感や「またリクエストよろしく！」など軽い締めでも良い。`,
            life_advisor:  `${_an.caster}のリアクション「${maxReactText.slice(0, 100)}」を受けて、${_an.life_advisor}が1〜2文で温かく返してください。「ぜひ試してみてくださいね！」など背中を押す一言か軽い共感で締めて。`,
            legal_advisor: `${_an.caster}のリアクション「${maxReactText.slice(0, 100)}」を受けて、${_an.legal_advisor}が1〜2文で返してください。「法律は難しそうに見えて、実は市民の味方なんです」など温かく締めて。スタジオを去るような一言でも良い。`,
            comedian:      getGuestAnalystDef('comedian').guestReply({ self: _an.comedian, caster: _an.caster, react: maxReactText.slice(0, 100) }),
            doctor:        getGuestAnalystDef('doctor').guestReply({ self: _an.doctor, caster: _an.caster, react: maxReactText.slice(0, 100) }),
            marketer:      getGuestAnalystDef('marketer').guestReply({ self: _an.marketer, caster: _an.caster, react: maxReactText.slice(0, 100) }),
          };
          const guestReplyCtx = `${baseContextPrompt}
${_guestReplyInstMap[_corner] || `${_an.caster}のリアクションを受けて${_guestName}が1〜2文で返してください。`}`;
          // caster_turn0 が先行生成済みなら退避（guest_reply の key 上書きで消えるのを防ぐ）
          if (this._prefetchedSpeech?.key === 'caster_turn0') {
            this._savedCasterTurn0 = this._prefetchedSpeech;
          }
          // search OFF: guest_reply は1〜2文の短い会話的返し。検索不要な上、ONだと10〜25秒かかって
          // キャスター 発話終了後に長い無音が生じる（commentator/journalist はデフォルト search ON のため必須）
          this._prefetchedSpeech = this._buildPrefetchedSpeech(`${_corner}_guest_reply`, this.generateAgentSpeech(_corner, guestReplyCtx, false), _corner);

          // holdDuckMs: guest_reply フェーズへの setTimeout ギャップ中もBGMを維持
          // world_report は遠隔なので除外（その場合は自然なダッキングを許容）
          const _holdDuckForReply = (_corner !== 'world_report') ? 400 : 0;
          const _maxReactPreloaded = _maxReactFirstPcmPromise ? (await _maxReactFirstPcmPromise) : null;
          await this.speakText(maxReactText, 'caster', _maxReactPreloaded, { holdDuckMs: _holdDuckForReply, expectedGen: _myGen });
          this._postCornerExchange = { corner: _corner, phase: 'guest_reply' };
          this.currentTokenHolder  = _corner;
          this._scheduleNextStep(0, _myGen);
          return;
        }
  }

  // フリーテキストリクエスト（AI Radio管理人経由等）をコーナールーティングか
  // キャスター直接応答に振り分ける。コーナーへルーティングした場合は false を返し、
  // 呼び出し元の _runCasterCornerRequestPhase へ処理を続ける（pendingCornerRequests
  // に積んだ後のフォールスルーを、元のコードと同じ順序で再現するため）。
  async _runCasterPendingInstructionPhase(ctx, cornerCallNames) {
    const { _myGen, _an, pendingInstruction, contextPrompt } = ctx;

        // ── フリーテキストリクエスト処理（caster turn=0 のときのみ） ──────────
        // pendingInstruction はこの関数スコープで取得済み。コーナーキーワードがあれば
        // pendingCornerRequest に変換し、なければキャスターが直接応答する。
        // ★クリアはここで実行（caster+turn=0 が揃った時だけ消す）
        if (this.conversationTurn === 0 && pendingInstruction) {
          try {
            const _cfg = this.getConfig();
            if (_cfg.show) _cfg.show.current_instruction = '';
            writeJsonFile(path.join(__dirname, 'data', 'config.json'), _cfg);
            getLogger().info(`[Director] ユーザーリクエスト処理・クリア: "${pendingInstruction}"`);
          } catch (_) { /* クリア失敗は無視 */ }
          const _uname2 = (this.getConfig().show?.user_profile?.name) || 'リスナー';
          // キーワードマッピング（天気・交通・ニュース・金融）
          // エージェント名部分は _an.* から動的に取得する（管理画面での改名に追従させるため）
          const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const _cornerKeywords = {
            weather:      /天気|気温|雨|晴|台風|気象|forecast|weather/i,
            traffic:      /交通|渋滞|道路|電車|鉄道|運転|traffic/i,
            news:         /ニュース|news|最新|速報|話題/i,
            // commentator を finance より前に置く: 「（コメンテーター名）に経済解説を」等で finance に先取りされないように
            commentator:  new RegExp(`${_esc(_an.commentator)}|教授|コメンテーター|professor`, 'i'),
            finance:      /株|株価|金融|為替|経済|円|ドル|finance|stock/i,
            world_report: new RegExp(`${_esc(_an.world_report)}|ワールドレポート|world report|海外|国際電話|現地レポート`, 'i'),
            // journalist / life_advisor / legal_advisor: 固有名で確実に識別
            journalist:    new RegExp(`ジャーナリスト|${_esc(_an.journalist)}|謎の.*特派員`, 'i'),
            life_advisor:  new RegExp(`${_esc(_an.life_advisor)}|生活アドバイス|アドバイザー`, 'i'),
            legal_advisor: new RegExp(`${_esc(_an.legal_advisor)}|弁護士|法律|法的|裁判|訴訟|契約|相続|離婚|労働問題|legal`, 'i'),
            // ゲスト論客3人。手がかりの語は定義側（lib/guest-analyst-corner.js）に持たせてある。
            ...Object.fromEntries(GUEST_ANALYST_KEYS.map((k) => [
              k, new RegExp(`${_esc(_an[k])}|${getGuestAnalystDef(k).keywordSource}`, 'i'),
            ])),
          };
          let _matchedCorner = null;
          for (const [corner, re] of Object.entries(_cornerKeywords)) {
            if (re.test(pendingInstruction)) { _matchedCorner = corner; break; }
          }

          // ── 音楽リクエスト検出（LLMベース）──────────────────────────────────
          // 天気・交通・ニュース・金融にマッチしなかった場合のみ判定する。
          // 正規表現による誤検知（日常会話を曲名と誤判断）を防ぐため、
          // ディレクターLLMに「曲リクエストか否か」の判断を委ねる。
          if (!_matchedCorner) {
            const _rawReqForDetect = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
            const _musicKw = /曲|歌|音楽|流して|かけて|聴かせ|聞かせ|弾いて|BGM|メロディ|アルバム|シングル|アーティスト|ライブ|コンサート/i;
            const _favArtists = (this.getConfig().show?.user_profile?.favorite_artists || []);
            const _hasFavArtist = _favArtists.some(a => a && pendingInstruction.includes(a));

            // 明確な音楽キーワードあり → 確定で music_dj へ（LLMは artist/song 抽出のみ）
            // 曖昧なケース → LLMが music/general を判定し、artist/song も抽出
            if (_musicKw.test(pendingInstruction) || _hasFavArtist) {
              // 明確な音楽キーワードあり：LLMで artist/song を正確に抽出
              const _info = await this._classifyMusicRequest(_rawReqForDetect);
              _matchedCorner = 'music_dj';
              this.pendingMusicRequest = {
                text:   _rawReqForDetect,
                artist: _info.artist || null,
                song:   _info.song   || null,
              };
              getLogger().info(`[Director] 音楽KW確定+LLM抽出: "${_rawReqForDetect}" → artist="${this.pendingMusicRequest.artist}", song="${this.pendingMusicRequest.song}"`);
              listenerRequests.recordRequest({
                channel: 'live', kind: 'music',
                label: [this.pendingMusicRequest.artist, this.pendingMusicRequest.song].filter(Boolean).join(' / ') || _rawReqForDetect,
                detail: { ...this.pendingMusicRequest },
              });
            } else {
              // 曖昧なケース：LLMに music/general の判定を委ねる
              const _info = await this._classifyMusicRequest(_rawReqForDetect);
              if (_info.type === 'music') {
                _matchedCorner = 'music_dj';
                this.pendingMusicRequest = {
                  text:   _rawReqForDetect,
                  artist: _info.artist || null,
                  song:   _info.song   || null,
                };
                getLogger().info(`[Director] LLM判定→音楽: "${_rawReqForDetect}" → artist="${this.pendingMusicRequest.artist}", song="${this.pendingMusicRequest.song}"`);
                listenerRequests.recordRequest({
                  channel: 'live', kind: 'music',
                  label: [this.pendingMusicRequest.artist, this.pendingMusicRequest.song].filter(Boolean).join(' / ') || _rawReqForDetect,
                  detail: { ...this.pendingMusicRequest },
                });
              } else {
                getLogger().info(`[Director] LLM判定→一般会話: "${_rawReqForDetect}"`);
              }
            }
          }

          if (_matchedCorner) {
            // コーナーリクエストとして処理（ボタン経由と同じフロー）
            getLogger().info(`[Director] リクエスト → コーナー自動ルーティング: ${_matchedCorner} ("${pendingInstruction}")`);
            this.requestCorner(_matchedCorner);
            // ニュースコーナー: リクエスト原文をトピックとして保存（例：「サッカーの結果を教えて」）
            if (_matchedCorner === 'news') {
              const _newsRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              this.pendingNewsRequest = { rawText: _newsRaw };
              getLogger().info(`[Director] ニューストピックリクエスト保存: "${_newsRaw}"`);
            }
            // 天気コーナー: リクエストから場所を抽出して保存
            if (_matchedCorner === 'weather') {
              const _weatherRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              // 地名を抽出（「大阪の天気を教えて」→「大阪」）
              const _locMatch = _weatherRaw.match(/^(.+?)(?:の天気|の気温|の気象|の予報|天気)/);
              const _extractedLoc = _locMatch ? _locMatch[1].trim() : null;
              if (_extractedLoc && _extractedLoc !== '今日' && _extractedLoc !== '明日' && _extractedLoc.length <= 10) {
                this.pendingWeatherRequest = { location: _extractedLoc, rawText: _weatherRaw };
                getLogger().info(`[Director] 天気場所リクエスト保存: "${_extractedLoc}"`);
              } else {
                this.pendingWeatherRequest = { location: null, rawText: _weatherRaw };
              }
            }
            // 交通コーナー: 行き先・経由地を抽出して保存
            if (_matchedCorner === 'traffic') {
              const _trafficRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              // 行き先抽出パターン
              // 「渋谷に行く」「横浜方面」「新宿まで」「羽田空港へ」「東京経由」など
              const _destPatterns = [
                /^(.+?)(?:に行く|まで|へ行く|方面|行き|に向かう|に向けて|への|へ向かう)(?:の|の交通|の道|の渋滞|の電車|の交通情報)?/,
                /(?:行き先[はが]|目的地[はが])(.+?)(?:の交通|の道|の渋滞|$)/,
                /^(.+?)(?:の交通情報|の渋滞情報|の道路情報|の電車情報|の混雑|の状況)/,
              ];
              // 経由地・路線名抽出（「東名高速で」「中央道を使って」など）
              const _viaPatterns = [
                /(?:東名|中央道|首都高|関越|常磐|東北道|新東名|圏央道|第三京浜|横浜新道|外環|名神|阪神|山陽|九州道)[高速道路]?/,
                /(?:山手線|中央線|東海道線|京浜東北線|埼京線|高崎線|東横線|小田急|京急|東急|西武|東武|近鉄|阪急|地下鉄).+?線?/,
              ];
              let _extractedDest = null;
              for (const pat of _destPatterns) {
                const m = _trafficRaw.match(pat);
                if (m && m[1] && m[1].length >= 2 && m[1].length <= 15) {
                  _extractedDest = m[1].trim();
                  break;
                }
              }
              let _extractedVia = null;
              for (const pat of _viaPatterns) {
                const m = _trafficRaw.match(pat);
                if (m) { _extractedVia = m[0].trim(); break; }
              }
              this.pendingTrafficRequest = { rawText: _trafficRaw, destination: _extractedDest, via: _extractedVia };
              getLogger().info(`[Director] 交通リクエスト保存: destination="${_extractedDest || 'none'}", via="${_extractedVia || 'none'}", raw="${_trafficRaw}"`);
            }
            // 金融コーナー: リクエスト銘柄・テーマを抽出して保存
            if (_matchedCorner === 'finance') {
              const _financeRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              // 銘柄・テーマ抽出（「トヨタの株価を教えて」→「トヨタ」）
              // パターン1: 「〇〇の株価」「〇〇株」「〇〇の相場」
              // パターン2: 「ドル円」「金」「原油」などの短い金融キーワード
              const _topicMatch = _financeRaw.match(
                /^(.+?)(?:の株価|の相場|の価格|の値段|について|を教えて|が聞きたい|株$|について|を紹介|に関して)/
              ) || _financeRaw.match(/^(ドル円|円ドル|ユーロ円|金|原油|BTC|ビットコイン|日経|TOPIX|S&P|ナスダック|NYダウ)[\sはについてを]/);
              const _extractedTopic = _topicMatch ? _topicMatch[1].trim() : null;
              this.pendingFinanceRequest = { rawText: _financeRaw, topic: _extractedTopic };
              getLogger().info(`[Director] 金融トピックリクエスト保存: topic="${_extractedTopic || 'none'}", raw="${_financeRaw}"`);
            }
            // コメンテーターコーナー: リクエストトピックを抽出して保存
            if (_matchedCorner === 'commentator') {
              const _commentRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              // トピック抽出（「トヨタの関税問題について」→「トヨタの関税問題」）
              const _topicMatchC = _commentRaw.match(
                /^(.+?)(?:について|に関して|の件|の問題|を解説|のことを|を教えて|が気になる|を聞きたい|の分析|の見解|はどう思|の影響|の状況|に詳しく|についてコメント)/i
              );
              const _extractedTopicC = _topicMatchC ? _topicMatchC[1].trim() : null;
              this.pendingCommentatorRequest = { rawText: _commentRaw, topic: _extractedTopicC };
              // リスナー本人が名指しで振った話題だけを記録する（ディレクターが振った話題は
              // 出どころの印が付いており、ここは通らない）。
              listenerRequests.recordRequest({ channel: 'live', kind: 'topic', label: _extractedTopicC || _commentRaw, detail: { to: 'コメンテーター' } });
              getLogger().info(`[Director] コメンテータートピックリクエスト保存: topic="${_extractedTopicC || 'none'}", raw="${_commentRaw}"`);
            }
            // ジャーナリストXコーナー: リクエストトピックを抽出して保存
            if (_matchedCorner === 'journalist') {
              const _journalistRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              const _topicMatchJ = _journalistRaw.match(
                /^(.+?)(?:について|に関して|の件|の問題|を調査|を取材|のことを|を教えて|が気になる|を聞きたい|の真相|の裏側|はどう思|の影響|の状況|に詳しく|についてコメント|の最新情報)/i
              );
              const _extractedTopicJ = _topicMatchJ ? _topicMatchJ[1].trim() : null;
              this.pendingJournalistRequest = { rawText: _journalistRaw, topic: _extractedTopicJ };
              // リスナー本人が名指しで振った話題だけを記録する（ディレクターが振った話題は
              // 出どころの印が付いており、ここは通らない）。
              listenerRequests.recordRequest({ channel: 'live', kind: 'topic', label: _extractedTopicJ || _journalistRaw, detail: { to: 'ジャーナリスト' } });
              getLogger().info(`[Director] ジャーナリストXトピックリクエスト保存: topic="${_extractedTopicJ || 'none'}", raw="${_journalistRaw}"`);
            }
            // 生活アドバイスのコーナー: リクエストトピックを抽出して保存
            if (_matchedCorner === 'life_advisor') {
              const _laRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              const _topicMatchLA = _laRaw.match(
                /^(.+?)(?:について|に関して|の件|のレシピ|の作り方|を教えて|が知りたい|を聞きたい|のコツ|の方法|のアドバイス|の対策|に詳しく|のやり方|を紹介|はどう)/i
              );
              const _extractedTopicLA = _topicMatchLA ? _topicMatchLA[1].trim() : null;
              this.pendingLifeAdvisorRequest = { rawText: _laRaw, topic: _extractedTopicLA };
              getLogger().info(`[Director] 生活アドバイザートピックリクエスト保存: topic="${_extractedTopicLA || 'none'}", raw="${_laRaw}"`);
            }
            // 法律相談（法律アドバイザー）コーナー: リクエストトピックを抽出して保存
            if (_matchedCorner === 'legal_advisor') {
              const _lgRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              const _topicMatchLG = _lgRaw.match(
                /^(.+?)(?:について|に関して|の件|の問題|を教えて|が知りたい|を聞きたい|の対処|の方法|はどう|の手続き|を相談|はどうなる|の権利|に詳しく|法律的に)/i
              );
              const _extractedTopicLG = _topicMatchLG ? _topicMatchLG[1].trim() : null;
              this.pendingLegalAdvisorRequest = { rawText: _lgRaw, topic: _extractedTopicLG };
              // リスナー本人が名指しで振った話題だけを記録する（ディレクターが振った話題は
              // 出どころの印が付いており、ここは通らない）。
              listenerRequests.recordRequest({ channel: 'live', kind: 'topic', label: _extractedTopicLG || _lgRaw, detail: { to: '法律相談' } });
              getLogger().info(`[Director] 法律相談トピックリクエスト保存: topic="${_extractedTopicLG || 'none'}", raw="${_lgRaw}"`);
            }
            // ゲスト論客3人。リクエストの話題を取り出して保存する。
            // 取り出す語尾は3人で少しずつ違うため、定義側（lib/guest-analyst-corner.js）に持たせてある。
            if (GUEST_ANALYST_KEYS.includes(_matchedCorner)) {
              const _gaDef = getGuestAnalystDef(_matchedCorner);
              const _gaRaw = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              const _gaMatch = _gaRaw.match(new RegExp(`^(.+?)(?:${_gaDef.requestTopicTail})`, 'i'));
              const _gaTopic = _gaMatch ? _gaMatch[1].trim() : null;
              this.pendingGuestAnalystRequests[_matchedCorner] = { rawText: _gaRaw, topic: _gaTopic };
              listenerRequests.recordRequest({ channel: 'live', kind: 'topic', label: _gaTopic || _gaRaw, detail: { to: _gaDef.roleLabel } });
              getLogger().info(`[Director] ${_gaDef.shortLabel} トピックリクエスト保存: topic="${_gaTopic || 'none'}", raw="${_gaRaw}"`);
            }
            // ワールドレポートへの「場所指定」リクエスト: 神出鬼没なので断る
            // 「コーナーにして」「ワールドレポートを聴きたい」はコーナー切り替えとして通す
            if (_matchedCorner === 'world_report') {
              const _rawReq = pendingInstruction.replace(/^リスナーの.+?さんからのリクエスト[:：]\s*/, '').trim();
              // 場所指定パターン: 地名 + 行って/から/で レポートして、など
              const _locationReqRe = /(?:行って|行き|から|で|に行|に来).{0,10}(?:レポート|報告|中継|リポート)|(?:レポート|報告|中継|リポート).{0,10}(?:して|お願い)|(?:東京|大阪|ニューヨーク|パリ|ロンドン|北京|上海|ソウル|バンコク|シドニー|[ぁ-ん]{3,}|[一-龠]{1,}(?:市|県|国|州|島))/i;
              const _cornerSwitchRe = /コーナー|聴きたい|聞きたい|お願い|にして|やって/i;
              const _isLocationRequest = _locationReqRe.test(_rawReq) && !_cornerSwitchRe.test(_rawReq);
              if (_isLocationRequest) {
                _matchedCorner = null; // 場所指定リクエストはコーナーに繋がない
                // キャスター が直接「特派員は神出鬼没」と返答
                const _steveCtx = `${contextPrompt}
リスナーの${_uname2}さんから ${_an.world_report}（ワールドレポート特派員）への場所リクエストが届きました。
「${_rawReq}」

${_an.world_report}は世界中を飛び回る神出鬼没な特派員なので、どこに現れるかは誰にも（${_an.world_report}にも！）わかりません。
「${_an.world_report}は今どこにいるかわからないので、どこに行くかリクエストするのは難しいんですよ〜（笑）」
というニュアンスで、ユーモアたっぷりに2〜3文で返してください。
次の話題に自然につないでください。${_an.assistant} への話し振りは不要です。`;
                const _steveText = await this.generateAgentSpeech('caster', _steveCtx);
                this.lastSpeech.caster = _steveText;
                await this.speakText(_steveText, 'caster', null, { expectedGen: _myGen });
                this.conversationTurn = 1;
                this.currentTokenHolder = 'assistant';
                this._scheduleNextStep(0, _myGen);
                return true;
              }
              // 場所指定なし → コーナー切り替えリクエストとして通す (_matchedCorner = 'world_report' のまま)
              getLogger().info(`[Director] ワールドレポート コーナーリクエスト → コーナーへ移行`);
            }
          } else {
            // 自由なリクエスト → キャスターが1回応答して終わり
            getLogger().info(`[Director] リクエスト → キャスター直接応答: "${pendingInstruction}"`);
            const _freeCtx = `${contextPrompt}
リスナーの${_uname2}さんから以下のリクエスト・質問が届きました:
「${pendingInstruction}」

このリクエストに正面から応えてください。
- 答えられる内容なら、わかる範囲で答える（カレンダー・TODO・メールの情報があれば活用する）
- ラジオの雰囲気を保ちつつ、${_uname2}さんへの返答として自然にまとめてください
- 答えられない場合（例: 別の場所の天気など）は「お天気コーナーでは${this.getConfig().show?.user_profile?.location || '設定地'}の情報のみお届けしています」などと正直に伝えてください
- 最後は${_an.assistant}に振るか、次の話題に移ってください`;
            const _freeText = await this.generateAgentSpeech('caster', _freeCtx);
            this.lastSpeech.caster = _freeText;
            await this.speakText(_freeText, 'caster', null, { expectedGen: _myGen });
            this.conversationTurn = 1;
            this.currentTokenHolder = 'assistant';
            this._scheduleNextStep(0, _myGen);
            return true;
          }
        }
        return false;
  }

  /**
   * キャスターのターンのうち、リスナーからのコーナーリクエストを捌く段。
   *
   * @param {any} ctx このターンの共通の値
   * @param {any} cornerCallNames コーナーごとの呼びかけの文言
   * @returns {Promise<any>} リクエストを処理したら true
   */
  async _runCasterCornerRequestPhase(ctx, cornerCallNames) {
    const { _myGen, _an, baseContextPrompt, contextPrompt } = ctx;

        // ── コーナーリクエスト優先処理（turn=0 のときのみ） ──────────────
        if (this.conversationTurn === 0 && this.pendingCornerRequests.length > 0) {
          const reqCorner = this.pendingCornerRequests.shift();
          getLogger().debug(`[CornerRequest] turn=0 で処理: ${reqCorner} (残り ${this.pendingCornerRequests.length} 件)`);
          const config2 = this.getConfig();
          const uname = (config2.show && config2.show.user_profile && config2.show.user_profile.name) || 'リスナー';

          // ── アクティビティ確認（キャスター が直接読み上げ → アシスタント へ ）──
          if (reqCorner === 'activities') {
            this._broadcast({ event: 'CORNER_START', name: 'アクティビティ確認' });
            this.currentTokenHolder = 'activities';
            this._broadcastQueueUpdate();
            const googleData2 = await this.fetchGoogleData();
            const isRealData = !!(this.getCredentials().google && this.getCredentials().google.refresh_token);

            const actContext = `${contextPrompt}
${uname}さんから「今日のスケジュールとメールを確認したい」というリクエストが届きました。
【個人データ${isRealData ? '' : '（デモ）'}】
■ 今日のカレンダー:
${googleData2.calendar}

■ 未完了TODO:
${googleData2.tasks}

■ 重要な新着メール:
${googleData2.gmail}

以下のルールで読み上げてください:
- 「${uname}さんからのリクエストです！今日のスケジュールをチェックしましょう」と始める
- カレンダーの予定を時系列で紹介（時間・内容・一言コメント可）
- 未完了TODOがあれば「やることリストには〜が残っています」と伝える
- 重要メールの件名と簡単な内容を伝える（プライバシーに配慮して要点のみ）
- 最後に「${_an.assistant}さん、気になることはありますか？」と${_an.assistant}に振る
${isRealData ? '' : '- ※ Google連携が未設定のため、デモデータを使用しています。実際の連携は管理画面の認証情報タブから設定できます。'}`;

            const actText = await this.generateAgentSpeech('caster', actContext);
            this.lastSpeech.caster = actText;

            // ── パイプライン: アシスタントのセリフを先行生成 ──
            const claraActCtx = `${contextPrompt}
【${_an.caster}の直前の発言】${actText}
上記の${_an.caster}の発言を受けて返答してください。
あなたの個性（礼儀正しいが時々毒舌・スマート）を活かして2〜3文で返してください。
${_an.caster}の発言への同意・補足・軽いツッコミを交えながら、自然に話を締めてください。`;
            this._prefetchedSpeech = this._buildPrefetchedSpeech('assistant', this.generateAgentSpeech('assistant', claraActCtx), 'assistant');

            await this.speakText(actText, 'caster', null, { expectedGen: _myGen });
            this.conversationTurn = 1;
            this.currentTokenHolder = 'assistant';
            this._scheduleNextStep(0, _myGen);
            return;
          }

          // ── weather / traffic / news / finance / music_dj：コーナーエージェントへ橋渡し ──
          this._nextCorner = reqCorner;
          this._nextCornerFromRequest = true; // リクエスト由来フラグをセット
          const reqCornerName = cornerCallNames[reqCorner] || reqCorner;

          // music_dj / news リクエストの場合は内容を橋渡しセリフに含める
          const _musicReqForCaster   = (reqCorner === 'music_dj' && this.pendingMusicRequest)   ? this.pendingMusicRequest   : null;
          const _newsReqForCaster         = (reqCorner === 'news'        && this.pendingNewsRequest)        ? this.pendingNewsRequest        : null;
          const _weatherReqForCaster      = (reqCorner === 'weather'     && this.pendingWeatherRequest)     ? this.pendingWeatherRequest     : null;
          const _financeReqForCaster      = (reqCorner === 'finance'     && this.pendingFinanceRequest)     ? this.pendingFinanceRequest     : null;
          const _trafficReqForCaster      = (reqCorner === 'traffic'     && this.pendingTrafficRequest)     ? this.pendingTrafficRequest     : null;
          const _commentatorReqForCaster  = (reqCorner === 'commentator' && this.pendingCommentatorRequest) ? this.pendingCommentatorRequest : null;
          const _journalistReqForCaster   = (reqCorner === 'journalist'  && this.pendingJournalistRequest)  ? this.pendingJournalistRequest  : null;
          const _lifeAdvisorReqForCaster  = (reqCorner === 'life_advisor' && this.pendingLifeAdvisorRequest)  ? this.pendingLifeAdvisorRequest  : null;
          const _legalAdvisorReqForCaster = (reqCorner === 'legal_advisor' && this.pendingLegalAdvisorRequest) ? this.pendingLegalAdvisorRequest : null;
          const _guestAnalystReqForCaster = GUEST_ANALYST_KEYS.includes(reqCorner)
            ? (this.pendingGuestAnalystRequests[reqCorner] || null) : null;

          // コーナーへの話題を、直前のコーナーの実発言から引き継ぐ。
          const _continuityReqForCorner = (
            ['commentator', 'journalist', 'legal_advisor', ...GUEST_ANALYST_KEYS].includes(reqCorner)
            && !_commentatorReqForCaster && !_journalistReqForCaster && !_legalAdvisorReqForCaster
            && !_guestAnalystReqForCaster
          ) ? this._deriveContinuityTopicRequest() : null;

          // 報道・金融のセンターへつなぐ例文に入れる担当者の名前（管理画面で変わるので設定から読む）。
          // 名前に付いている役割の注記（「◯◯(報道センター)」など）は、例文では読まないので落とす
          const _centerStaffName = (/** @type {string} */ key) =>
            String(config2.agents?.[key]?.name || '').replace(/[（(][^）)]*[）)]/g, '').trim();
          const _newsCenterCall = _centerStaffName('news') ? `報道センターの${_centerStaffName('news')}さん` : '報道センター';
          const _financeCenterCall = _centerStaffName('finance') ? `金融情報センターの${_centerStaffName('finance')}さん` : '金融情報センター';

          const reqCasterCtx = _musicReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから曲のリクエストが届きました！
リクエスト曲：「${_musicReqForCaster.text}」${_musicReqForCaster.artist ? `（${_musicReqForCaster.artist}）` : ''}

以下のルールでセリフを作ってください:
- ${uname}さんへのお礼（1文）
- リクエスト曲名・アーティスト名に触れる（例：「${_musicReqForCaster.artist || ''}さんの『${_musicReqForCaster.song || _musicReqForCaster.text}』ですね！」）
- ${_an.music_dj}さんにバトンを渡す（例：「${_an.music_dj}さん、お願いします！」）
- 合計 2〜3 文。${_an.assistant} への話し振りは不要です。`
            : _newsReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから「${_newsReqForCaster.rawText}」というニュースリクエストが届きました。
リクエストの話題（「${_newsReqForCaster.rawText}」）に触れながら、報道センターへ繋ぐ一言（1〜2文）を伝えてください。
例：「${uname}さんから〇〇についてのニュースリクエストです！早速、${_newsCenterCall}に繋ぎましょう！」
${_an.assistant} への話し振りは不要です。`
            : _weatherReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから${_weatherReqForCaster.location ? `「${_weatherReqForCaster.location}」の` : ''}天気情報のリクエストが届きました。
${_weatherReqForCaster.location ? `「${_weatherReqForCaster.location}の天気が気になるんですね！」` : '「天気が気になるんですね！」'}のように触れながら、気象情報センターへ繋ぐ一言（1〜2文）を伝えてください。
${_an.assistant} への話し振りは不要です。`
            : _financeReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから金融情報センターへのリクエストが届きました。
リクエスト内容：「${_financeReqForCaster.rawText}」
${_financeReqForCaster.topic ? `「${_financeReqForCaster.topic}が気になるんですね！」のように` : '「金融・市場情報のリクエストですね！」のように'}触れながら、${_financeCenterCall}へ繋ぐ一言（1〜2文）を伝えてください。
${_an.assistant} への話し振りは不要です。`
            : _trafficReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから交通情報センターへのリクエストが届きました。
リクエスト内容：「${_trafficReqForCaster.rawText}」
${_trafficReqForCaster.destination
  ? `「${_trafficReqForCaster.destination}へのお出かけですね！交通情報センターで最新情報を確認しましょう！」のように行き先に触れながら`
  : '「交通情報が気になるんですね！」のように触れながら'}、交通情報センターへ繋ぐ一言（1〜2文）を伝えてください。
${_an.assistant} への話し振りは不要です。`
            : _commentatorReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから${_an.commentator}へのコメントリクエストが届きました。
リクエスト内容：「${_commentatorReqForCaster.rawText}」
${_commentatorReqForCaster.topic
  ? `${_an.commentator}に「${_commentatorReqForCaster.topic}について、最近の動向や見解をお聞かせください」のようにトピックを明示して具体的に質問する形で`
  : `「${_an.commentator}、リスナーからのリクエストにお答えいただけますか？」のように`}、${_an.commentator}に繋ぐセリフ（2〜3文）を作ってください。
${uname}さんへのお礼を1文加えてください。${_an.assistant} への話し振りは不要です。`
            : _journalistReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから${_an.journalist}へのリクエストが届きました。
リクエスト内容：「${_journalistReqForCaster.rawText}」
${_journalistReqForCaster.topic
  ? `「${_journalistReqForCaster.topic}の裏側を追っている${_an.journalist}に」のようにトピックを明示して`
  : `「${_an.journalist}、リスナーからのリクエストです」のように`}、${_an.journalist}に繋ぐセリフ（2〜3文）を作ってください。
${uname}さんへのお礼を1文加えてください。${_an.assistant} への話し振りは不要です。`
            : _lifeAdvisorReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから${_an.life_advisor}へのリクエストが届きました。
リクエスト内容：「${_lifeAdvisorReqForCaster.rawText}」
${_lifeAdvisorReqForCaster.topic
  ? `「${_lifeAdvisorReqForCaster.topic}について${_an.life_advisor}さんに聞いてみましょう！」のようにトピックを明示して`
  : `「${_an.life_advisor}さん、リスナーからのリクエストです！」のように`}、${_an.life_advisor}に繋ぐセリフ（2〜3文）を作ってください。
${uname}さんへのお礼を1文加えてください。${_an.assistant} への話し振りは不要です。`
            : _legalAdvisorReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから${_an.legal_advisor}弁護士への法律相談リクエストが届きました。
リクエスト内容：「${_legalAdvisorReqForCaster.rawText}」
${_legalAdvisorReqForCaster.topic
  ? `「${_legalAdvisorReqForCaster.topic}について、${_an.legal_advisor}弁護士にズバリ聞いてみましょう！」のようにトピックを明示して`
  : `「${_an.legal_advisor}弁護士、リスナーからの法律相談です！」のように`}、${_an.legal_advisor}に繋ぐセリフ（2〜3文）を作ってください。
${uname}さんへのお礼を1文加えてください。${_an.assistant} への話し振りは不要です。`
            : _guestAnalystReqForCaster
            ? `${contextPrompt}
リスナーの${uname}さんから${_an[reqCorner]}へのリクエストが届きました。
リクエスト内容：「${_guestAnalystReqForCaster.rawText}」
${_guestAnalystReqForCaster.topic
  ? `「${_guestAnalystReqForCaster.topic}について、${_an[reqCorner]}さんに伺ってみましょう」のようにトピックを明示して`
  : `「${_an[reqCorner]}さん、リスナーからのリクエストです」のように`}、${_an[reqCorner]}に繋ぐセリフ（2〜3文）を作ってください。
${uname}さんへのお礼を1文加えてください。${_an.assistant} への話し振りは不要です。`
            : _continuityReqForCorner
            ? `${contextPrompt}
リスナーの${uname}さんから${reqCornerName}へのリクエストが届きました（具体的な話題の指定はありません）。
直前の${_continuityReqForCorner.cornerLabel}のコーナーで「${_continuityReqForCorner.rawText}」という話題が伝えられました。
${uname}さんへのお礼を1文添えたあと、この話題に触れながら${_an[reqCorner] || _an.legal_advisor}に具体的な質問を投げかけて繋ぐセリフ（2〜3文）を作ってください。
⚠️「リスナーからのリクエストです」だけで終わらせず、直前の話題に必ず具体的に言及すること。
${_an.assistant} への話し振りは不要です。`
            : (['commentator', 'journalist', 'life_advisor', 'legal_advisor', ...GUEST_ANALYST_KEYS].includes(reqCorner))
            ? `${contextPrompt}
リスナーの${uname}さんから${reqCornerName}へのリクエストが届きました（具体的な話題の指定はありません）。
${uname}さんへのお礼を1文添えたあと、以下の話題候補から1つ選び、${_an[reqCorner] || _an.legal_advisor}に具体的な質問を投げかけて繋ぐセリフ（2〜3文）を作ってください。
【話題候補（ランダムに1つ選択）】
${
  GUEST_ANALYST_KEYS.includes(reqCorner)
    ? getGuestAnalystDef(reqCorner).topicCandidates
    : reqCorner === 'legal_advisor'
    ? '・相続・遺産分割のトラブル（兄弟間の争いなど）\n・賃貸トラブル（敷金返還・原状回復）\n・労働問題（残業代未払い・パワハラ・解雇）\n・離婚・親権・養育費\n・交通事故の過失割合・慰謝料\n・ネットトラブル（誹謗中傷・個人情報漏洩）\n・悪質業者・消費者問題（クーリングオフなど）\n・隣人・騒音・境界線トラブル'
    : reqCorner === 'life_advisor'
    ? '・今夜のおすすめ夕食メニュー\n・季節の健康法・体調管理のコツ\n・暮らしの知恵・節約術\n・人間関係や気持ちの整理のヒント'
    : '・今日のニュース・経済・社会・国際情勢・スポーツ・芸能の中から最も気になる話題を1つ'
}
⚠️「では〜コーナーです」「リスナーからのリクエストです」のような漠然とした紹介は禁止。必ず具体的な質問を明示してください。
${_an.assistant} への話し振りは不要です。`
            : `${contextPrompt}
リスナーの${uname}さんから「${reqCornerName}」へのリクエストが届きました。
「${uname}さんからのリクエストにお応えして、今すぐ${reqCornerName}に繋ぎます！」のように
リクエストへの感謝と期待感を込めた一言（1〜2文）を伝えてください。
${_an.assistant} への話し振りは不要です。すぐにコーナーへ橋渡しする形で締めてください。`;

          const reqText = await this.generateAgentSpeech('caster', reqCasterCtx);
          this.lastSpeech.caster = reqText;

          // 引き継いだ話題を使う場合は、そのコーナー用のリクエスト欄へ入れる。
          if (_continuityReqForCorner) {
            if (reqCorner === 'commentator')   this.pendingCommentatorRequest  = _continuityReqForCorner;
            if (reqCorner === 'journalist')    this.pendingJournalistRequest   = _continuityReqForCorner;
            if (reqCorner === 'legal_advisor') this.pendingLegalAdvisorRequest = _continuityReqForCorner;
            if (GUEST_ANALYST_KEYS.includes(reqCorner)) this.pendingGuestAnalystRequests[reqCorner] = _continuityReqForCorner;
          }

          // ── パイプライン: キャッシュがあれば即時、なければここで生成開始 ──
          const _reqTopicForCorner = reqCorner === 'news'    ? this.pendingNewsRequest
                                   : reqCorner === 'weather' ? this.pendingWeatherRequest
                                   : reqCorner === 'finance' ? this.pendingFinanceRequest
                                   : reqCorner === 'traffic' ? this.pendingTrafficRequest
                                   : null;
          if (reqCorner === 'news')    this.pendingNewsRequest    = null;
          if (reqCorner === 'weather') this.pendingWeatherRequest = null;
          if (reqCorner === 'finance') this.pendingFinanceRequest = null;
          if (reqCorner === 'traffic') this.pendingTrafficRequest = null;
          this._prefetchedSpeech = {
            key: reqCorner,
            promise: this._generateCornerSpeech(reqCorner, baseContextPrompt, _reqTopicForCorner),
          };

          await this.speakText(reqText, 'caster', null, { expectedGen: _myGen });
          this.conversationTurn = 0;
          this.currentTokenHolder = reqCorner;
          getLogger().info(`[Corner] リクエストコーナーへ移行: currentTokenHolder = ${reqCorner}`);
          this._scheduleNextStep(0, _myGen);
          return;
        }
  }

  /**
   * キャスターのターンの通常の流れ。話題を出し、アシスタントへ振るか、次のコーナーへ移る。
   *
   * 次のターンの発話とコーナーのセリフをここで先読みしておく。
   *
   * @param {any} ctx このターンの共通の値
   * @param {any} cornerCallNames コーナーごとの呼びかけの文言
   * @returns {Promise<void>}
   */
  async _runCasterNormalFlow(ctx, cornerCallNames) {
    const { _myGen, _an, isBirthday, baseContextPrompt, contextPrompt } = ctx;

        // ── 通常フロー ────────────────────────────────────────────────────
        let casterText;

        if (this.conversationTurn === 0) {
          // ━━ 3ターン先読み ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // turn=0 の段階で次コーナーを確定し、コーナーセリフ生成を即時開始する。
          // traffic は Gemini Google Search (最大30秒) があるため、ウィンドウを最大化することが重要。
          //
          // 旧2ターン先読み（アシスタントの発話から） のウィンドウ:
          //   アシスタント 発話 (~15s) + Caster リアクション (~8s) + ジングル (3s) ≈ 26秒
          //
          // 新3ターン先読み (Caster turn=0 発話から) のウィンドウ:
          //   Caster turn=0 発話 (~15s) + アシスタント 発話 (~15s) + Caster リアクション (~8s) + ジングル (3s) ≈ 41秒
          //
          // Google Search は通常 10〜25 秒。41秒あればほぼ確実に間に合う。
          {
            // _selectNextCorner: 直前コーナーを考慮したコンテキスト適応選択
            const _poppedCorner = this._selectNextCorner(isBirthday);
            this._nextCorner = _poppedCorner;
            this._nextCornerFromRequest = false; // 通常スケジューリング由来
            this._broadcastQueueUpdate();

            // ── pendingCornerRequests があればキュー整合性を修正 ──────────────────
            // 3ターン先読みでポップしたコーナーと、リクエスト先頭コーナーが異なる場合:
            //   ① ポップ済みコーナーをキュー先頭に戻す（失われないように）
            //   ② リクエストコーナーがキューに残っていれば除去（2重再生防止）
            if (this.pendingCornerRequests.length > 0 && this.pendingCornerRequests[0] !== _poppedCorner) {
              // ① ポップしたコーナーを先頭に戻す（activities と music は特殊なので除く）
              if (_poppedCorner && !['music', 'activities'].includes(_poppedCorner)) {
                this._cornerQueue.unshift(_poppedCorner);
                getLogger().debug(`[CornerRequest] ポップ済み ${_poppedCorner} をキュー先頭に戻した`);
              }
              // ② 各リクエストコーナーを _cornerQueue から除去（2重再生防止）
              for (const _reqCorner of this.pendingCornerRequests) {
                const _reqIdx = this._cornerQueue.indexOf(_reqCorner);
                if (_reqIdx !== -1) {
                  this._cornerQueue.splice(_reqIdx, 1);
                  getLogger().info(`[CornerRequest] キューから重複除去: ${_reqCorner} → 2重再生を防止`);
                }
              }
            }

            // commentator / journalist / music_dj は「MCの質問を受けてから生成」する会話応答型のため先読み対象外
            // weather / traffic / news / finance は定型コーナーなので先読みOK
            if (INFO_CORNERS.includes(this._nextCorner)) {
              const _c3t = this._nextCorner;
              getLogger().debug(`[Pipeline] 3ターン先読み開始: ${_c3t}`);
              this._prefetchedCornerSpeech = {
                key: _c3t,
                promise: this._generateCornerSpeech(_c3t, baseContextPrompt)
                  .then(t => { getLogger().debug(`[Pipeline] 3ターン先読み完了: ${_c3t}`); return t; }),
              };
            } else {
              // music は speech cache 不要 → クリアして前サイクルの stale 値を残さない
              this._prefetchedCornerSpeech = null;
            }
          }

          // ━━ 番組オープニング（初回のみ）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // runOpeningSequence が失敗・スキップされたときの予備のオープニング。出演者の紹介のしかたは
          // runOpeningSequence と同じ（_buildStudioRollCallInstruction）
          if (!this._openingDone) {
            this._openingDone = true;
            const cfg0    = this.getConfig();
            const ags0    = cfg0.agents || {};
            const asstName = (ags0.assistant    && ags0.assistant.name)    || 'Clara（アシスタント）';
            const rollCall = this._buildStudioRollCallInstruction(cfg0);
            const pInfo    = this._getProgramInfo();

            const openingCtx = `${contextPrompt}
【番組スタート — オープニングの発言】
今日の放送が始まりました。あなた（${_an.caster}）はメインMCとして元気よくオープニングを飾ってください。

【スタジオの構成】（今日一緒に番組を作るメンバー）
- あなた（${_an.caster}）: メインMC ← ここにいる
- ${asstName}: アシスタント ← 同じスタジオ
- ほかにスタジオの出演者が数名 ← 同じスタジオ（紹介のしかたは下の【出演者の紹介】に従う）
- 気象情報センター / 交通情報センター / 報道センター / 金融情報センター: リモート接続

【出演者の紹介】
${rollCall}

【オープニングルール】
1. 番組名「${pInfo.name}」と時間帯を自然に織り込んでください
2. スタジオの出演者は【出演者の紹介】のとおり、全員ではなく短くまとめて紹介してください
3. 「今日も盛りだくさんでお届けします！」などの期待感を込めた一言を添えてください
4. 最後は「${asstName}、今日もよろしく！」と一声かけて締めてください
5. 4〜5文程度でテンポよく、明るく元気に！

⚠️【最重要】あなたの名前は${_an.caster}です。「メインMCの〇〇です」のように自分を名乗る場合は
必ずこの実際の名前を使ってください（「〇〇」のようなプレースホルダ・仮名は絶対禁止）。`;

            casterText = await this.generateAgentSpeech('caster', openingCtx);
            this.lastSpeech.caster = casterText;
            this._bufferMaxClaraDiaryText('caster', casterText);

            // ── アシスタント のオープニング返答を先行生成 ──
            const claraOpenCtx = `${contextPrompt}
【${_an.caster}の直前の発言（オープニング）】${casterText}
${_an.caster}がオープニングであなた（${asstName}）を含むスタジオメンバーを紹介してくれました。
元気よく短く（2〜3文）挨拶してください。礼儀正しいが時々毒舌な個性を少し出してOKです。`;
            this._prefetchedSpeech = this._buildPrefetchedSpeech('assistant', this.generateAgentSpeech('assistant', claraOpenCtx), 'assistant');
            // アシスタント の実際の発話テキストは _runAssistantStep 側で prefetch が解決されるまで確定しないため、
            // そちらで一回だけ日記を書かせるためのワンショットフラグを立てておく。
            this._pendingOpeningDiaryForAssistant = true;

            await this.speakText(casterText, 'caster', null, { expectedGen: _myGen });
            this.conversationTurn = 1;
            this.currentTokenHolder = 'assistant';
            this._scheduleNextStep(0, _myGen);
            return;
          }

          // turn=0: 話題を振り、アシスタントに意見を求める
          // 先読みキャッシュ確認（コーナー後のCaster開幕が先行生成済みなら使う）
          let _casterT0FirstPcmPromise = null; // 前ターン中に先行合成した1文目PCM（あれば）
          if (this._prefetchedSpeech?.key === 'caster_turn0') {
            const _ps = this._prefetchedSpeech;
            this._prefetchedSpeech = null;
            casterText = await _ps.promise;
            _casterT0FirstPcmPromise = _ps.firstPcmPromise || null;
          } else {
            const claraLast = this.lastSpeech.assistant
              ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
            // 最近すでに扱った話題（繰り返し防止）
            const _recentTopicsHint = this._recentTopics.length > 0
              ? `\n【⚠️ 直近ですでに扱った話題 — 同じ話題の繰り返し厳禁】\n${this._recentTopics.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join('\n')}\n上記とは異なるフレッシュな話題・視点を選んでください。`
              : '';

            // 話題カテゴリーをランダムに2〜3個提示してGeminiの偏りを防ぐ
            const _topicCategories = [
              '社会・政治（国内ニュース・政策・話題の出来事）',
              '国際情勢（海外ニュース・地政学・紛争・貿易摩擦）',
              '経済・株式・ビジネス（市場動向・企業ニュース・産業トレンド）',
              'スポーツ（野球・サッカー・テニス・ゴルフ・格闘技・五輪）',
              '文化・エンタメ（映画・ドラマ・本・アート・マンガ・ゲーム）',
              '食・グルメ（季節の食材・話題のレストラン・料理トレンド）',
              '旅行・観光（国内外の名所・季節のお出かけ・温泉・グルメ旅）',
              '健康・医療・科学（最新研究・予防医学・宇宙・環境問題）',
              'テクノロジー・AI（直近で話した場合は他カテゴリーを優先）',
              '雑学・歴史・豆知識（意外な事実・歴史の裏話・なるほど話）',
              '天気・季節の話題（今の季節ならではの出来事・行事）',
              'スターや著名人の話題（受賞・引退・復帰・話題の人物）',
            ];
            // ランダムに3カテゴリーをシャッフルして提示（毎回違う組み合わせ）
            const _shuffledCats = [..._topicCategories].sort(() => Math.random() - 0.5).slice(0, 3);

            // BUGFIX: コメンテーター・ジャーナリストへ振るとき、材料を渡さないと学習データの古い情報の
            //         まま実在の人物・組織の現況を断定してしまう。直近で確認された動きと実際の見出しを
            //         渡し、無いときは具体的な事実に触れないよう指示する。
            let _liveSignalsText = '';
            let _realNewsHeadlines = '';
            if (this._nextCorner === 'commentator' || this._nextCorner === 'journalist') {
              _liveSignalsText = getRecentLiveSignals({ maxAgeMinutes: 120 });
              await this.newsService.fetch().catch(() => null);
              _realNewsHeadlines = this.newsService.cache.structured?.length > 0
                ? this.newsService.cache.structured.slice(0, 5).map((n, i) => `${i + 1}. ${n.title}`).join('\n')
                : '';
            }
            // BUGFIX: 直前のコーナーで実際に何が話されたかを、通常の振り出しにも渡すこと。これが無いと
            //         静的な候補の一覧からランダムに選ぶだけになり、ニュースの直後でも番組の流れと
            //         無関係な話題が選ばれる。記録する側は全コーナーで動いており、材料はあるのに
            //         読み出していなかった。
            const _continuityForNextCorner =
              ['commentator', 'journalist', 'legal_advisor'].includes(this._nextCorner)
                ? this._deriveContinuityTopicRequest() : null;
            const _continuitySection = _continuityForNextCorner
              ? `\n【直前の放送内容 — まずここから話題を選ぶこと】\n`
                + `${_continuityForNextCorner.cornerLabel}のコーナーでは、こう伝えられました:\n`
                + `「${_continuityForNextCorner.rawText}」\n`
                + `この内容に関連する切り口を優先して選んでください。番組は一連の流れとして聴かれているため、`
                + `直前の話題を受けて掘り下げる方が自然です。どうしても関連づけられない場合に限り、`
                + `他の話題を選んで構いません。`
              : '';
            const _newsGroundingSection = (_liveSignalsText || _realNewsHeadlines)
              ? `\n【参考: 直近に確認された実際の動き】\n`
                + (_liveSignalsText ? `${_liveSignalsText}\n` : '')
                + (_realNewsHeadlines ? `直近のニュース見出し:\n${_realNewsHeadlines}\n` : '')
                + `上記のいずれかを話題の起点にしてください（無理に全部使う必要はありません）。`
              : `\n⚠️【重要】あなたは今、実際のニュース検索結果を持っていません。実在の人物・組織・` +
                `出来事について「最近〇〇が話題ですよね」のように具体的な現況を断定するのは、` +
                `学習データの古い情報のまま話してしまい、事実と食い違うリスクがあります。` +
                `政治家・著名人個人の現在の役職・動向のような、検索なしでは正誤を確認できない` +
                `具体的事実には触れず、一般的なトレンド・傾向レベルの話題（例:「最近〇〇業界が` +
                `盛り上がっていますね」）に留めるか、${_an.assistant}に一般的な意見を尋ねる形に` +
                `してください。具体的な事実の裏付けは、繋いだ先の担当者が実際に検索して行います。`;

            // 次がゲストコーナーの場合、幅広い話題で会話を組み立てるよう誘導
            const commentatorSetupHint =
              (this._nextCorner === 'commentator')
                ? `\n【次のコーナーについて】次は${_an.commentator}のコメントコーナーです。${_an.commentator}は経済・政治・社会・テクノロジー・国際情勢など幅広いテーマに知見があります。最近のニュースや生活に身近な話題から1つ選んで${_an.assistant}に振り、自然に${_an.commentator}へ繋いでください。${_continuitySection}${_newsGroundingSection}${_recentTopicsHint}`
              : (this._nextCorner === 'journalist')
                ? `\n【次のコーナーについて】次は${_an.journalist}のコーナーです。政治・経済・スポーツ・芸能・テクノロジー・国際情勢など何でも話題にできます。今日最も気になるニュースや出来事から1つ選んで${_an.assistant}に振り、自然に${_an.journalist}へ繋いでください。${_continuitySection}${_newsGroundingSection}${_recentTopicsHint}`
              : (this._nextCorner === 'music_dj')
                ? `\n【次のコーナーについて】次は${_an.music_dj}の音楽・エンタメコーナーです。最近の音楽・映画・ドラマ・アーティストなどの話題を取り上げ、${_an.assistant}に意見を聞いてください。${_an.music_dj}へのスムーズな橋渡しになるよう意識してください。`
              : (this._nextCorner === 'world_report')
                ? `\n【次のコーナーについて】次は${_an.world_report}のワールドレポートコーナーです。${_an.assistant}へのリアクション後、「${_an.world_report}が今どこにいるかは分からないが、これからスターリンクで呼び出す」という演出をしてください。繋がれば世界のどこかから生レポートが届く、というワクワク感を2〜3文で演出してください。`
              : (this._nextCorner === 'legal_advisor')
                ? `\n【次のコーナーについて】次は${_an.legal_advisor}弁護士の法律相談コーナーです。「歩く六法全書」と呼ばれる辣腕弁護士で、刑事・民事・家族・労働・消費者問題まで何でも対応できます。
${_continuitySection}
  【話題の選び方】直前の放送内容と関連づけられるならそれを最優先。関連づけられない場合に限り、以下の候補から1つ選んでください（この候補リストは最後の手段です）。
  ${_an.assistant}に軽く意見を聞いてから「では${_an.legal_advisor}弁護士に〇〇についてズバリ聞いてみましょう！」のように**具体的な質問**を添えて繋いでください。
法律トピック候補（上記で関連づけられなかった場合のみ使用）:
・相続・遺産分割のトラブル（兄弟間の争いなど）
・賃貸トラブル（敷金返還・原状回復）
・労働問題（残業代未払い・パワハラ・解雇）
・離婚・親権・養育費
・交通事故の過失割合・慰謝料
・ネットトラブル（誹謗中傷・個人情報漏洩）
・悪質業者・消費者問題（クーリングオフなど）
・隣人・騒音・境界線トラブル
⚠️ 「身近な法律の疑問はない？」のような漠然とした問いかけは禁止。必ず具体的なトピックを選んで${_an.legal_advisor}への質問を明示してください。`
              : (GUEST_ANALYST_KEYS.includes(this._nextCorner))
                ? `\n【次のコーナーについて】${getGuestAnalystDef(this._nextCorner).setupHint({ self: _an[this._nextCorner], asst: _an.assistant })}${_continuitySection}${_newsGroundingSection}${_recentTopicsHint}`
              : '';
            const ctx = `${contextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
今のターンではトピックを1つ話し、${_an.assistant}（アシスタント）に対して「${_an.assistant}さんはどう思う？」「${_an.assistant}さんにも聞いてみましょう」のように話を振ってください。
【重要】「こんにちは」「元気ですか」のような挨拶から始めるのは厳禁。前の会話の流れを受けた自然な切り出しにしてください。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【話題の多様性ルール — 厳守】
今回は以下のカテゴリーからトピックを選んでください:
${_shuffledCats.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

⚠️ AIやテクノロジーの話題は連続して選ばないこと。
⚠️ リスナーの職業・趣味（IT・電子工作・Windシンセなど）には言及しないこと。
   プロファイルはすでに他のエージェントが触れています。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${_recentTopicsHint}${claraLast}${commentatorSetupHint}`;
            casterText = await this.generateAgentSpeech('caster', ctx);
          }
          this.lastSpeech.caster = casterText;

          // ── パイプライン: アシスタントのセリフを先行生成 ──
          const claraCtx = `${contextPrompt}
【${_an.caster}の直前の発言】${casterText}
上記の${_an.caster}の発言を受けて返答してください。
あなたの個性（礼儀正しいが時々毒舌・スマート）を活かして2〜3文で返してください。
${_an.caster}の発言への同意・補足・軽いツッコミを交えながら、自然に話を締めてください。
⚠️ リスナーの職業・趣味（IT経歴・電子工作・Windシンセなど）には言及しないこと。${_an.caster}がすでに触れている可能性があります。`;
          this._prefetchedSpeech = this._buildPrefetchedSpeech('assistant', this.generateAgentSpeech('assistant', claraCtx), 'assistant');

          this._chatTurnCount = 0; // 新サイクル開始: アシスタントの返答回数をリセット
          // 1文目TTS: 先読み済み（コーナー中に合成）があればそれを、無ければ今合成（アシスタント先読みと並行）
          if (!_casterT0FirstPcmPromise) _casterT0FirstPcmPromise = this._prefetchFirstSentencePcm(casterText, 'caster');
          const _casterT0Preloaded = _casterT0FirstPcmPromise ? (await _casterT0FirstPcmPromise) : null;
          await this.speakText(casterText, 'caster', _casterT0Preloaded, { expectedGen: _myGen });
          this.conversationTurn = 1;
          this.currentTokenHolder = 'assistant';

        } else {
          // turn>=1: キャスターが [CONTINUE] タグで会話継続かコーナー移行かを自ら判断する
          // ハードキャップ（max_conversation_exchanges）超過時は強制コーナー移行
          const _hardCap     = this.getConfig().show?.conversation_exchanges ?? 4;
          const _forceCorner = this._chatTurnCount >= _hardCap;

          // _nextCorner を確定（通常は turn=0 の3ターン先読みで確定済み）
          if (!this._nextCorner || !ALL_CORNERS.includes(this._nextCorner)) {
            this._nextCorner = this._selectNextCorner(isBirthday);
            this._nextCornerFromRequest = false; // 通常スケジューリング由来
          }

          // ── フォールバック: コーナーリクエストがアシスタントのターンの後に届いたケース ──────────
          // ⚠️ キャッシュ取得よりも前に処理する（重要）:
          //   後で処理すると casterText が古い _nextCorner のセリフ（例:「交通情報」）で
          //   確定した後に _nextCorner が書き換わり、キャスター が言ったコーナーと実際に再生される
          //   コーナーが食い違うバグが発生する。
          //   キャッシュ取得前に _nextCorner を確定させ、stale な caster_decision も
          //   破棄して正しいコーナー名で再生成させる。
          //
          // ⚠️ _nextCornerFromRequest が true の場合はスキップ:
          //   assistant インターセプト等で pendingCornerRequests から取得した _nextCorner を
          //   ここで再び別のリクエストで上書きするとリクエスト順が逆転するバグが発生する。
          //   例: traffic(A) → weather(B) の順でリクエストされた場合、assistant インターセプトが
          //   A を処理して _nextCorner=traffic にした後、このブランチが B(weather) で上書きしてしまう。
          // activities は caster turn=0 で直接処理するため _nextCorner に入れない
          if (!this._nextCornerFromRequest && this.pendingCornerRequests.length > 0 && this.pendingCornerRequests[0] !== this._nextCorner && this.pendingCornerRequests[0] !== 'activities') {
            const _lateCorner = this.pendingCornerRequests.shift();
            getLogger().info(`[CornerRequest] リクエストを caster else ブランチで検出: _nextCorner ${this._nextCorner} → ${_lateCorner} (残り ${this.pendingCornerRequests.length} 件)`);
            this._nextCorner             = _lateCorner;
            this._nextCornerFromRequest  = true;  // リクエスト由来フラグをセット
            this._prefetchedCornerSpeech = null;
            this._prefetchedSpeech       = null; // stale な caster_decision を破棄して正しいコーナー名で再生成
          }

          // ── 先読みキャッシュを取得 ──────────────────────────────────────────────
          // 'caster_decision': キャスターが [CONTINUE] で継続か移行かを判断するセリフ
          // 'caster_reaction': ハードキャップ時の強制コーナー移行セリフ（旧互換）
          let casterRawText;
          if (this._prefetchedSpeech?.key === 'caster_decision' || this._prefetchedSpeech?.key === 'caster_reaction') {
            casterRawText = await this._prefetchedSpeech.promise;
            this._prefetchedSpeech = null;
          } else {
            // フォールバック生成（先読みなし — リクエストインターセプトで _prefetchedSpeech を破棄した場合もここ）
            const _fbCornerName = cornerCallNames[this._nextCorner] || 'コーナー';
            casterRawText = await this.generateAgentSpeech('caster', `${contextPrompt}
【${_an.assistant}の直前の発言】${this.lastSpeech.assistant || '（なし）'}
${_an.assistant}の発言を受けて1〜2文でリアクションし、${_fbCornerName}への橋渡しセリフで締めてください。
⚠️ 【コーナー名の厳守】次のコーナーは「${_fbCornerName}」です。過去の記憶にあるリスナーリクエスト（交通情報・天気・報道など別コーナー名）は無視し、「${_fbCornerName}」以外のコーナー名は絶対に口にしないでください。`);
          }

          // [CONTINUE] タグを解析してセリフから除去
          const _wantContinue = !_forceCorner && /\[CONTINUE\]/i.test(casterRawText);
          casterText = casterRawText.replace(/\[CONTINUE\]\s*/gi, '').trim();
          this.lastSpeech.caster = casterText;

          // 1文目TTSを先行合成（[CONTINUE]除去後の確定テキストから。この後の
          // アシスタント先読み or コーナーコンテキスト構築と並行 → speakText時には合成済み）
          const _casterElseFirstPcmPromise = this._prefetchFirstSentencePcm(casterText, 'caster');

          if (_wantContinue) {
            // ── 会話継続: アシスタント に振り返す ─────────────────────────────────────────
            getLogger().debug(`[Talk] MAX が会話継続を選択 (count=${this._chatTurnCount})`);
            const claraFollowCtx = `${contextPrompt}
【${_an.caster}の直前の発言】${casterText}
上記の${_an.caster}の発言を受けて返答してください。
あなたの個性（礼儀正しいが時々毒舌・スマート）を活かして2〜3文で返してください。
${_an.caster}の話への同意・補足・軽いツッコミを交えながら、自然に話を展開させてください。
⚠️ リスナーの職業・趣味（IT経歴・電子工作・Windシンセなど）には言及しないこと。`;
            this._prefetchedSpeech = this._buildPrefetchedSpeech('assistant', this.generateAgentSpeech('assistant', claraFollowCtx), 'assistant');
            const _casterContPreloaded = _casterElseFirstPcmPromise ? (await _casterElseFirstPcmPromise) : null;
            await this.speakText(casterText, 'caster', _casterContPreloaded, { expectedGen: _myGen });
            this.currentTokenHolder = 'assistant';
            this._scheduleNextStep(0, _myGen);
            return; // コーナー移行コードをスキップ
          }

          // ── コーナー移行: casterText は キャスター が書いたコーナー移行セリフで確定 ──────
          getLogger().debug(`[Talk] MAX がコーナー移行を選択 (count=${this._chatTurnCount})`);
          // ↓ この後のパイプライン処理（_prefetchConvCorner, speakText 等）へ fall-through

          // ── パイプライン: 2ターン先読みが使えればそのまま、なければここで開始 ──
          const nextCorner = this._nextCorner || 'weather';
          if (GUEST_CORNERS.includes(nextCorner)) {
            // ── 会話コーナー: キャスター 発話中（~8-15秒）にコンテキスト構築を先行開始 ────────────
            // casterText = キャスター の紹介セリフ = MC 質問。この時点で確定しているので
            // speakText と並行して _buildCornerContext を走らせることでコーナー入り直後の
            // 待ち時間（従来 10〜30秒）を大幅に短縮する。
            const _prefetchMcQ = casterText;
            const _ctxPromise  = this._buildCornerContext(nextCorner, baseContextPrompt, _prefetchMcQ);

            if (nextCorner === 'music_dj') {
              // Spotify トラック取得も同時に開始（context 構築と完全並列）
              // フォールバック楽曲クエリ組み立て・Phase1プロンプトは
              // _buildMusicDjSpotifyQueries() / _buildMusicDjPhase1Context() へ集約
              // （本番の受け渡し側の代替の分岐と共通）
              const _spCreds  = this.getCredentials().spotify;
              const _spOk     = !!(_spCreds?.client_id && (_spCreds?.refresh_token || _spCreds?.client_secret));
              const _profile3 = this.getConfig().show?.user_profile || {};
              const _favs3    = (_profile3.favorite_artists || []).map(a => a.trim()).filter(Boolean);
              // Phase 1 先読み（キャスター 発話中に完了させる）
              // リスナーの曲リクエスト有無で内容を切り替え（music_dj セクションと同じ条件）。
              // this.pendingMusicRequest（リスナーのテキストチャット経由）が無い場合も、
              // キャスターがコーナー移行セリフ（casterText）の中で口頭リクエストしていないかを
              // 同じ分類器で判定する（_detectMusicRequestFromCasterText）。await はせず
              // Promise のまま以降のプロミスチェーンへ渡し、キャスター発話中（8〜15秒）に解決させる。
              const _djPendingReq3Promise = this.pendingMusicRequest
                ? Promise.resolve(this.pendingMusicRequest)
                : this._detectMusicRequestFromCasterText(casterText);
              getLogger().debug('[Pipeline] music_dj Phase 1 先読み開始 (Max発話中)');
              this._prefetchConvCorner = {
                key: 'music_dj',
                mcQuestion: _prefetchMcQ,
                contextPromise: _ctxPromise,
                pendingReqPromise: _djPendingReq3Promise,
                spotifyTracksPromise: _djPendingReq3Promise.then(pendingReq => {
                  const shuffled = this._buildMusicDjSpotifyQueries(_favs3, this._recentlyPlayedArtists, pendingReq);
                  return _spOk ? this._fetchSpotifyPlayableTracks(shuffled, 25) : Promise.resolve('');
                }),
                phase1Promise: _djPendingReq3Promise.then(pendingReq => {
                  const djPreCtx3 = this._buildMusicDjPhase1Context(baseContextPrompt, casterText, _an.caster, _an, pendingReq, _an.assistant);
                  return this.generateAgentSpeech('music_dj', djPreCtx3, false, 'light');
                }),
              };
            } else if (nextCorner === 'world_report') {
              // world_report: 都市決定 (_resolveWorldReportCity) を先行開始し、
              // 完了後に _worldReportCity をセットしてから contextPromise を構築する。
              // ⚠️ _buildCornerContext は this._worldReportCity.city を参照するため
              //    都市確定前に呼んだらフォールバックモードになって LLM が自由に都市を選ぶ。
              //    必ず都市解決 → _worldReportCity セット → context 構築 の順に直列実行すること。
              const _locationPromise = this._resolveWorldReportCity();
              const _wrCtxPromise = _locationPromise.then(async (locationInfo) => {
                this._worldReportCity = locationInfo; // { city, ambientCategory }
                // 都市確定後にコンテキスト構築（_buildCornerContext 自体は同期的なので遅延なし）
                return this._buildCornerContext('world_report', baseContextPrompt, _prefetchMcQ);
              });
              this._prefetchConvCorner = {
                key: 'world_report',
                mcQuestion: _prefetchMcQ,
                contextPromise: _wrCtxPromise,
                locationPromise: _locationPromise,
              };
            } else {
              // commentator / journalist / life_advisor / legal_advisor
              // ── Phase 1（前置き「少し確認します」）を キャスター 発話中に先行生成 ──────────
              // キャスター が話している ~10〜30秒の間に Phase 1 の LLM 呼び出し（3〜8秒）を完了させ、
              // コーナー入り直後の空白（ダッキングしたままの BGM 上昇）をゼロにする。
              // プロンプト組み立ては _buildPhase1PreContext() へ集約（_run<Agent>Step 側の
              // 本番の受け渡しのときにも同じ関数を使う）。
              const _phase1PreCtx = this._buildPhase1PreContext(nextCorner, baseContextPrompt, casterText, _an.caster, _an);
              const _phase1PrePromise = this.generateAgentSpeech(nextCorner, _phase1PreCtx, false, 'light');
              getLogger().debug(`[Pipeline] ${nextCorner} Phase 1 先読み開始 (Max発話中)`);
              this._prefetchConvCorner = {
                key: nextCorner,
                mcQuestion: _prefetchMcQ,
                contextPromise: _ctxPromise,
                phase1Promise: _phase1PrePromise,
                startedAt: Date.now(),
              };
            }
            getLogger().debug(`[Pipeline] 会話コーナー先読み開始: ${nextCorner} (Max発話中)`);
            this._prefetchedSpeech       = null;
            this._prefetchedCornerSpeech = null;
          } else {
            this._prefetchConvCorner = null;
            this._prefetchedSpeech = {
              key: nextCorner,
              promise: (this._prefetchedCornerSpeech?.key === nextCorner)
                ? (this._prefetchedCornerSpeech.promise) // アシスタント 発話中に開始済み → 待ち時間ほぼゼロ
                : this._generateCornerSpeech(nextCorner, baseContextPrompt),
            };
            this._prefetchedCornerSpeech = null;
          }

          // 会話コーナー移行: Phase 1 生成（3〜8秒）+ TTS 開始中も BGM ダッキングを維持
          // Phase 1 先読みが完了していれば待ち時間はほぼゼロになるが、
          // setTimeout ギャップや TTS 開始のわずかな隙間も埋めるために holdDuckMs を設定する。
          const _convHoldDuck = GUEST_CORNERS.includes(nextCorner) ? 400 : 0;
          const _casterBridgePreloaded = _casterElseFirstPcmPromise ? (await _casterElseFirstPcmPromise) : null;
          await this.speakText(casterText, 'caster', _casterBridgePreloaded, { holdDuckMs: _convHoldDuck, expectedGen: _myGen });
          this.conversationTurn = 0;
          this.currentTokenHolder = nextCorner;
          getLogger().info(`[Corner] 次コーナーへ移行: currentTokenHolder = ${nextCorner}`);
          this._broadcastQueueUpdate();
        }
        this._scheduleNextStep(0, _myGen);

  }

  // ─── runSingleShowStep: アシスタントのターン ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runAssistantStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        this.currentState = 'TALKING_ASSISTANT';

        // 先読みキャッシュ確認
        let text;
        let _asstFirstPcmPromise = null; // 前ターン中に先行合成した1文目PCM（あれば）
        if (this._prefetchedSpeech?.key === 'assistant') {
          const _ps = this._prefetchedSpeech;
          this._prefetchedSpeech = null;
          text = await _ps.promise;
          _asstFirstPcmPromise = _ps.firstPcmPromise || null; // キャスター発話中に合成済み
        } else {
          const assistantContext = `${contextPrompt}
【${_an.caster}の直前の発言】${this.lastSpeech.caster || '（なし）'}
上記の${_an.caster}の発言を受けて返答してください。
あなたの個性（礼儀正しいが時々毒舌・スマート）を活かして2〜3文で返してください。
${_an.caster}の発言への同意・補足・軽いツッコミを交えながら、自然に話を締めてください。`;
          text = await this.generateAgentSpeech('assistant', assistantContext);
        }
        this.lastSpeech.assistant = text;
        this._chatTurnCount++; // アシスタント が返答するたびにカウントアップ

        // オープニング返答のみ日記を書く（毎ターン書くと過多になるため、ワンショットフラグで限定）
        if (this._pendingOpeningDiaryForAssistant) {
          this._pendingOpeningDiaryForAssistant = false;
          this._bufferMaxClaraDiaryText('assistant', text);
        }

        // 先読みが無かった（フォールバック生成）場合は、この後のキャスター判断セリフ生成などと
        // 並行して1文目TTSを合成しておく（speakText時には合成済みにする）
        if (!_asstFirstPcmPromise) _asstFirstPcmPromise = this._prefetchFirstSentencePcm(text, 'assistant');

        // ── コーナーリクエスト検出（turn>=1 へのフォールイン対策）──────────────
        // pendingCornerRequest は通常 caster turn=0 の先頭で処理される。
        // しかしリクエストが「turn=0 の pendingCornerRequest チェック通過後」に届いた場合、
        // そのサイクルではスルーされ 3ターン先読みで選ばれた別コーナーへ誤移行してしまう。
        // アシスタント 発話中（assistant セクション）でインターセプトし _nextCorner を上書きする
        // ことで、直後の caster_decision プリフェッチを正しいコーナー向けに生成できる。
        // activities は caster turn=0 で直接処理するため _nextCorner に入れない
        if (this.pendingCornerRequests.length > 0 && this.pendingCornerRequests[0] !== this._nextCorner && this.pendingCornerRequests[0] !== 'activities') {
          const _interceptedCorner = this.pendingCornerRequests.shift();
          getLogger().info(`[CornerRequest] リクエストを assistant ターンで検出: _nextCorner ${this._nextCorner} → ${_interceptedCorner} (残り ${this.pendingCornerRequests.length} 件)`);
          this._nextCorner             = _interceptedCorner;
          this._nextCornerFromRequest  = true;  // リクエスト由来フラグをセット — caster else fallback が上書きしないようにする
          this._prefetchedCornerSpeech = null; // stale な先読みキャッシュを破棄
        }

        // ── キャスター の判断セリフを先行生成（[CONTINUE] タグで継続 or コーナー移行を決める）──
        // _hardCap 超過時のみ強制コーナー移行（caster_reaction）。
        // それ以外は キャスター 自身が空気を読んで判断（caster_decision）。
        const _hardCapAssist     = this.getConfig().show?.conversation_exchanges ?? 4;
        const _forceCornerAssist = this._chatTurnCount >= _hardCapAssist;

        // _nextCorner を確定（通常は caster turn=0 の3ターン先読みで確定済み）
        if (!this._nextCorner || !ALL_CORNERS.includes(this._nextCorner)) {
          this._nextCorner = this._selectNextCorner(isBirthday);
          this._nextCornerFromRequest = false; // 通常スケジューリング由来
        }
        const assistantBranchCornerNames = {
          weather:      '気象情報センター',
          traffic:      '交通情報センター',
          news:         '報道センター',
          finance:      '金融情報センター',
          commentator:  `${_an.commentator}のコメント`,
          journalist:   `${_an.journalist}のコメント`,
          music_dj:     `${_an.music_dj}の音楽・エンタメ情報`,
          life_advisor: `${_an.life_advisor}の生活アドバイス`,
          world_report: `${_an.world_report}のワールドレポート`,
          legal_advisor: `${_an.legal_advisor}の法律相談`,
          comedian:      getGuestAnalystDef('comedian').callName(_an.comedian),
          doctor:        getGuestAnalystDef('doctor').callName(_an.doctor),
          marketer:      getGuestAnalystDef('marketer').callName(_an.marketer),
        };
        const nextCornerName = assistantBranchCornerNames[this._nextCorner] || 'コーナー';

        // コーナー種別に応じた橋渡しプロンプトを構築
        const _isConvCorner = GUEST_CORNERS.includes(this._nextCorner);
        // BUGFIX: ターンの割り当ての既定値を特定のコーナーにしないこと。既定のままの経路に入ると、
        //         そのコーナーばかりが選ばれる。
        const _expertTitle  = this._nextCorner === 'commentator'  ? _an.commentator
                            : this._nextCorner === 'journalist'   ? _an.journalist
                            : this._nextCorner === 'life_advisor' ? _an.life_advisor
                            : this._nextCorner === 'world_report' ? _an.world_report
                            : this._nextCorner === 'legal_advisor' ? _an.legal_advisor
                            : (_an[this._nextCorner] || _an.music_dj);
        const _recentWarn   = this._recentTopics.length > 0
          ? `\n【⚠️ 直近すでに扱った話題 — 絶対に繰り返さないこと】\n${this._recentTopics.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join('\n')}\n上記とは全く別の話題・視点を選んでください。経済・AIばかりでなく、社会問題・スポーツ・食品・生活・国際情勢・テクノロジーなど多様なテーマから選んでください。`
          : '';
        const _musicQuestion = `次に${nextCornerName}（${_an.music_dj}）にお願いします。
【重要】「では〜コーナーです」という単なる紹介は厳禁です。
音楽・エンタメに関する具体的なリクエストを1件${_an.music_dj}さんに投げかけてください。
例: 「${_an.music_dj}さん、今週チャートで盛り上がってる曲は何ですか？」
    「最近気になっているアーティストや新曲があれば教えてください」
    「今の季節にぴったりな曲をピックアップしてもらえますか？」
2〜3文で、楽しそうに話しかけてください。${_recentWarn}`;
        const _lifeAdvisorQuestion = `次に${_an.life_advisor}さんの生活アドバイスコーナーです。
【重要】「では〜コーナーです」という単なる紹介は厳禁です。
今の時間帯・季節・最近の話題をふまえて、${_an.life_advisor}さんへの具体的なリクエストを1つ投げかけてください。
例: 「${_an.life_advisor}さん、今夜のおすすめ夕食メニューを教えてもらえますか？」
    「最近疲れ気味なんですが、${_an.life_advisor}さん、何かいい健康法はありますか？」
    「${_an.life_advisor}さん、今の季節ならではの生活の知恵を教えてください！」
2〜3文で、親しみやすく話しかけてください。${_recentWarn}`;
        const _worldReportQuestion = `次に${_an.world_report}のワールドレポートコーナーです。
【重要】「では〜コーナーです」という単なる紹介は厳禁です。
以下の内容を含めて2〜3文で明るく伝えてください:
1. ${_an.world_report}が今どこにいるかは分からないが、これからスターリンクで呼び出す
2. 繋がれば世界のどこかから生レポートが届く、というワクワク感
例A: 「さあ、お待ちかねのワールドレポートです！${_an.world_report}が今どこにいるかは分かりませんが、これからスターリンクで呼び出してみます！繋がるかな？」
例B: 「それでは世界各地を飛び回る${_an.world_report}にスターリンクで繋いでみましょう！今どこにいるかは謎ですが、きっとどこかのホットな現場にいるはず！」
例C: 「ワールドレポートの時間です！${_an.world_report}の現在地は不明ですが、今からスターリンクで呼んでみます。世界のどこかから出てくれるかな？」`;
        const _expertQuestion = `次に${nextCornerName}にコメントをお願いします。
【重要】「では〜コーナーです」という単なるコーナー紹介は厳禁です。
MCとして、今日のニュース・話題の中から【最も気になる1件】を取り上げ、
${_expertTitle}に対して具体的な質問を投げかけてください。
経済・AIだけでなく、政治・スポーツ・食品・生活・国際情勢・科学・芸能など幅広い視点で話題を選んでください。
例: 「最近〇〇という動きがありますが、${_expertTitle}はどのようにご覧になりますか？」
    「〇〇が話題になっていますが、${_expertTitle}の見方をお聞かせください」
3〜4文で、リスナーにも分かりやすい平易な言葉でお願いします。${_recentWarn}`;
        const _legalAdvisorQuestion = `次に${_an.legal_advisor}弁護士の法律相談コーナーです。
【重要】「では〜コーナーです」という単なる紹介は厳禁です。
以下の法律トピック候補から1つ選び、${_an.assistant}への一言リアクション後に「では${_an.legal_advisor}弁護士に〇〇についてズバリ聞いてみましょう！」のように**具体的な質問**を明示して繋いでください。
法律トピック候補（ランダムに1つ選択）:
・相続・遺産分割のトラブル（兄弟間の争いなど）
・賃貸トラブル（敷金返還・原状回復）
・労働問題（残業代未払い・パワハラ・解雇）
・離婚・親権・養育費
・交通事故の過失割合・慰謝料
・ネットトラブル（誹謗中傷・個人情報漏洩）
・悪質業者・消費者問題（クーリングオフなど）
・隣人・騒音・境界線トラブル
⚠️ 「身近な法律の疑問はない？」のような漠然とした問いかけは禁止。必ず具体的なトピックを選んで${_an.legal_advisor}への質問を明示してください。
2〜3文で。${_recentWarn}`;

        // コーナー移行セリフ（ハードキャップ強制時 or キャスター が選択B を選んだ時に使用）
        const casterReactionCtx = _isConvCorner
          ? `${contextPrompt}
【${_an.assistant}の直前の発言】${text}
${_an.assistant}の発言を受けて1文でリアクションしてください。

${this._nextCorner === 'music_dj' ? _musicQuestion : this._nextCorner === 'life_advisor' ? _lifeAdvisorQuestion : this._nextCorner === 'world_report' ? _worldReportQuestion : this._nextCorner === 'legal_advisor' ? _legalAdvisorQuestion : _expertQuestion}`
          : `${contextPrompt}
【${_an.assistant}の直前の発言】${text}
${_an.assistant}の発言を受けて1〜2文で短くリアクションしてください（同意・ツッコミ・笑いなど）。
その後、必ず「では、${nextCornerName}からお伝えします」「続いて${nextCornerName}です」のように次コーナーへ橋渡しするセリフで締めてください。
⚠️ 【コーナー名の厳守】次のコーナーは「${nextCornerName}」です。過去の記憶にあるリスナーリクエスト（交通情報・天気・報道など別コーナー名）は無視し、「${nextCornerName}」以外のコーナー名は絶対に口にしないでください。`;

        if (_forceCornerAssist) {
          // ハードキャップ超過: 強制コーナー移行
          getLogger().debug(`[Talk] ハードキャップ到達 (count=${this._chatTurnCount}) — 強制コーナー移行`);
          this._prefetchedSpeech = { key: 'caster_reaction', promise: this.generateAgentSpeech('caster', casterReactionCtx) };
        } else {
          // キャスターが [CONTINUE] タグで継続か移行かを自ら判断するプロンプト
          // 選択A ([CONTINUE] あり): 1〜2文リアクション + アシスタントへの質問
          // 選択B ([CONTINUE] なし): casterReactionCtx と同じ内容のコーナー移行セリフ
          const decisionCtx = _isConvCorner
            ? `${contextPrompt}
【${_an.assistant}の直前の発言】${text}
あなた（${_an.caster}）はMCとして、今の会話の流れを読んで次の行動を選んでください。

【選択A: 会話を続ける】この話題にまだ面白い角度がある・もう一言交わしたいと感じる場合:
→ 1〜2文でリアクションし、新しい視点や質問で${_an.assistant}に振ってください
→ セリフの末尾に必ず [CONTINUE] を付けてください

【選択B: コーナーへ移行する】話が自然に一区切りついたと感じる場合:
→ ${_an.assistant}の発言を受けて1文でリアクションしてください
→ 次のコーナーへの橋渡しとして:
${this._nextCorner === 'music_dj' ? _musicQuestion : this._nextCorner === 'life_advisor' ? _lifeAdvisorQuestion : this._nextCorner === 'world_report' ? _worldReportQuestion : this._nextCorner === 'legal_advisor' ? _legalAdvisorQuestion : _expertQuestion}

[CONTINUE] を付けるかどうかは、会話の勢いと自分の直感で判断してください。`
            : `${contextPrompt}
【${_an.assistant}の直前の発言】${text}
あなた（${_an.caster}）はMCとして、今の会話の流れを読んで次の行動を選んでください。

【選択A: 会話を続ける】この話題にまだ面白い角度がある・もう一言交わしたいと感じる場合:
→ 1〜2文でリアクションし、新しい視点や質問で${_an.assistant}に振ってください
→ セリフの末尾に必ず [CONTINUE] を付けてください

【選択B: コーナーへ移行する】話が自然に一区切りついたと感じる場合:
→ 1〜2文で短くリアクション（同意・ツッコミ・笑いなど）してください
→ 必ず「では、${nextCornerName}からお伝えします」「続いて${nextCornerName}です」のように次コーナーへ橋渡しするセリフで締めてください
⚠️ 【コーナー名の厳守】次のコーナーは「${nextCornerName}」です。過去の記憶にあるリスナーリクエスト（交通情報・天気・報道など別コーナー名）は無視し、「${nextCornerName}」以外のコーナー名は絶対に口にしないでください。

[CONTINUE] を付けるかどうかは、会話の勢いと自分の直感で判断してください。`;
          this._prefetchedSpeech = { key: 'caster_decision', promise: this.generateAgentSpeech('caster', decisionCtx) };
        }

        // ── 2ターン先読み（フォールバック）: 3ターン先読みが未実行の場合のみ開始 ──
        // 通常は caster turn=0 の3ターン先読みで既に開始済みなのでここは実行されない。
        // pendingCornerRequest 処理後など _prefetchedCornerSpeech が null のときだけ補完する。
        // commentator / journalist / music_dj は先読み不要（MCの質問確定後に生成）
        if (!this._prefetchedCornerSpeech && INFO_CORNERS.includes(this._nextCorner)) {
          const _earlyCorner = this._nextCorner;
          getLogger().debug(`[Pipeline] 2ターン先読みフォールバック開始: ${_earlyCorner}`);
          this._prefetchedCornerSpeech = {
            key: _earlyCorner,
            promise: this._generateCornerSpeech(_earlyCorner, baseContextPrompt)
              .then(t => { getLogger().debug(`[Pipeline] 2ターン先読み完了: ${_earlyCorner}`); return t; }),
          };
        }

        const _asstPreloadedPcm = _asstFirstPcmPromise ? (await _asstFirstPcmPromise) : null;
        await this.speakText(text, 'assistant', _asstPreloadedPcm, { expectedGen: _myGen });
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ─── runSingleShowStep: コーナー後ゲスト一言返し（guest_replyフェーズ） ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runGuestReplyStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ── コーナー後ゲスト一言返し（guest_reply フェーズ）────────────────────────
        // キャスター のリアクションを受けてゲストが短く返す。コーナー共通ハンドラ。
        const _corner  = this.currentTokenHolder;
        const _guestNameMap2 = {
          commentator:  _an.commentator,  journalist:   _an.journalist,
          world_report: _an.world_report, music_dj:     _an.music_dj,
          life_advisor: _an.life_advisor, legal_advisor: _an.legal_advisor,
          comedian:     _an.comedian,     doctor:       _an.doctor,
          marketer:     _an.marketer,
        };
        this.currentState = `TALKING_${_corner.toUpperCase()}`;

        let _guestReplyText;
        let _guestReplyFirstPcmPromise = null;
        if (this._prefetchedSpeech?.key === `${_corner}_guest_reply`) {
          const _ps = this._prefetchedSpeech;
          this._prefetchedSpeech = null;
          _guestReplyText = await _ps.promise;
          _guestReplyFirstPcmPromise = _ps.firstPcmPromise || null;
        } else {
          // フォールバック生成
          const _fbName = _guestNameMap2[_corner] || 'ゲスト';
          _guestReplyText = await this.generateAgentSpeech(_corner, `${baseContextPrompt}
${_an.caster}のリアクションを受けて、${_fbName}が1〜2文でさらっと返してください。雑談調で短く自然に。`);
        }
        this.lastSpeech[_corner] = _guestReplyText;
        this._postCornerExchange  = null;
        if (!_guestReplyFirstPcmPromise) _guestReplyFirstPcmPromise = this._prefetchFirstSentencePcm(_guestReplyText, _corner);

        // max_react で退避した caster_turn0 を復元（コーナー文脈を引き継いだ キャスター 発話）
        if (this._savedCasterTurn0) {
          this._prefetchedSpeech  = this._savedCasterTurn0;
          this._savedCasterTurn0  = null;
        }

        const _guestReplyPreloaded = _guestReplyFirstPcmPromise ? (await _guestReplyFirstPcmPromise) : null;
        await this.speakText(_guestReplyText, _corner, _guestReplyPreloaded, { expectedGen: _myGen });
        this.conversationTurn    = 0;
        this.currentTokenHolder  = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ─── runSingleShowStep: コメンテーター解説コーナー ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runCommentatorStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ━━ 高橋洋二教授 コメンテーターコーナー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 2フェーズ発話:
        //   Phase 1 「少し調べますね、少々お待ちください」（Google Search なし・高速）
        //            → TTS再生しながら Phase 2 の Google Search が走る
        //   Phase 2  実際のコメント（Google Search グラウンディング使用）
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        this.currentState = 'TALKING_COMMENTATOR';
        this._broadcast({ event: 'CORNER_START', name: `${_an.commentator}のコメント` });

        // ── Phase 2: MCの質問を受けてから生成（先読みキャッシュは使わない）──────────
        // キャスターが具体的な質問をしてから生成することで会話の自然な流れを確保する。
        // Phase 1（前置き）の TTS 再生中に並行して生成が進む。
        if (this._prefetchedSpeech?.key === 'commentator') this._prefetchedSpeech = null;
        if (this._prefetchedCornerSpeech?.key === 'commentator') this._prefetchedCornerSpeech = null;
        // リスナーリクエストのトピックを取得してクリア（reqCorner フローで設定されたもの）
        const _commentatorTopicReq = this.pendingCommentatorRequest;
        this.pendingCommentatorRequest = null;
        if (_commentatorTopicReq) {
          getLogger().info(`[Commentator] リスナーリクエスト: topic="${_commentatorTopicReq.topic || 'none'}", raw="${_commentatorTopicReq.rawText}"`);
        }
        const commentMcQuestion = this.lastSpeech.caster || null;
        const _cmCasterEarly = (config.agents?.caster?.name) || 'MAX';
        getLogger().debug(`[Commentator] MCの質問: ${commentMcQuestion ? commentMcQuestion.slice(0, 60) + '…' : '(なし)'}`);
        // Phase 1 先読みキャッシュを _prefetchConvCorner クリア前に取得
        const _cachedPhase1Cm = (this._prefetchConvCorner?.key === 'commentator' && !_commentatorTopicReq)
          ? this._prefetchConvCorner.phase1Promise : null;
        // キャスター 発話中に先行構築済みのコンテキストがあれば使う（ほぼ待ち時間ゼロ）
        // ただしリスナーリクエストがある場合はフレッシュなコンテキストを生成（トピック指示を注入するため）
        let commentCtxWithQ;
        if (this._prefetchConvCorner?.key === 'commentator' && !_commentatorTopicReq) {
          getLogger().debug('[Pipeline] commentator: 先読みコンテキスト使用');
          commentCtxWithQ = await this._prefetchConvCorner.contextPromise;
          this._prefetchConvCorner = null;
        } else {
          if (this._prefetchConvCorner?.key === 'commentator') this._prefetchConvCorner = null; // 破棄
          commentCtxWithQ = await this._buildCornerContext('commentator', baseContextPrompt, commentMcQuestion, _commentatorTopicReq);
        }
        // リスナーリクエスト時は Google Search を強制（通常はエージェント設定に従う）
        const _commentSearchOverride = _commentatorTopicReq?.rawText ? true : null;
        const commentMainPromise = this.generateAgentSpeech('commentator', commentCtxWithQ, _commentSearchOverride);

        // ── Phase 1: 前置きセリフ生成（Google Search OFF）─────────────────────────
        // MCの質問内容に触れながら「少々お待ちください」を言うことで自然な掛け合いになる
        // キャスター 発話中に先読みキャッシュ (_cachedPhase1Cm) があれば即座に使用（待ち時間ゼロ）
        // プロンプトの組み立ては _buildPhase1PreContext() に集約してある（先読み側と共通）
        const preCtx = this._buildPhase1PreContext('commentator', baseContextPrompt, commentMcQuestion, _cmCasterEarly, _an);

        const preTextPromise = _cachedPhase1Cm
          ? (_cachedPhase1Cm.then(t => { getLogger().debug('[Pipeline] commentator Phase 1 先読みヒット'); return t; }))
          : this.generateAgentSpeech('commentator', preCtx, false, 'light'); // search OFF

        // Phase 1 テキスト取得・読み上げ（この間に Phase 2 の Google Search が進む）
        // セーフティネット: LLM がプロンプト禁止を無視して「どうぞ」を末尾に付けた場合に削除
        const preText = this._stripHandoffPhrase(await preTextPromise, _an.caster);
        this.lastSpeech.commentator_pre = preText;
        await this.speakText(preText, 'commentator', null, { expectedGen: _myGen });

        // Phase 2: 本コメント（Phase 1 TTS 再生中に Google Search 完了しているはず）
        const _cmCaster = (config.agents?.caster?.name) || 'MAX';
        const mainText = this._truncateAtEndMarker(
          await commentMainPromise,
          [`${_cmCaster}さん、どうぞ`, `${_cmCaster}、どうぞ`, `どうぞ、${_cmCaster}`, 'いかがでしょうか', 'スタジオにお返しします', 'スタジオへどうぞ'],
          'Commentator'
        );
        this.lastSpeech.commentator = mainText;
        this._pushRecentCornerContent('commentator', _an.commentator, mainText);

        // ── パイプライン: 本コメント再生中に2つ並行プリフェッチ ──────────────────────
        // ① commentator_max_react: キャスター の即時リアクション（教授→キャスター の間を埋める）
        // ② caster_turn0 (→ _savedCasterTurn0): guest_reply 後の キャスター 通常ターン用
        const claraLastC = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        const commentatorLastSpeech = this.lastSpeech.commentator
          ? `\n【${_an.commentator}が今コメントしたこと】${this.lastSpeech.commentator.slice(0, 200)}…` : '';
        // ① max_react 用（1〜2文の短いリアクション）
        const _maxReactCtxCm = `${baseContextPrompt}
【${_an.commentator}の発言（要約）】${mainText.slice(0, 300)}

⚠️【自己言及の禁止】あなたは${_an.caster}です。ゲストが「${_an.caster}さんの〜」と言っていても、自分自身のことは一人称で言い換えてください。自分を三人称で呼ぶのは禁止です。

${_an.commentator}のコメントを受けて1〜2文で率直にリアクションしてください。感想・同意・軽いツッコミなど自然に。長い追加質問は厳禁。`;
        this._prefetchedSpeech = this._buildPrefetchedSpeech('commentator_max_react', this.generateAgentSpeech('caster', _maxReactCtxCm), 'caster');
        // ② guest_reply 後の通常ターン用を直接 _savedCasterTurn0 に退避
        const casterAfterCommentCtx = `${baseContextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
${_an.commentator}のコメントが終わりました。そのコメント内容を受けて一言感想・リアクションを述べ、${_an.assistant}に「どう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。${_an.commentator}のコメントへの具体的リアクションから始めてください。${claraLastC}${commentatorLastSpeech}`;
        this._savedCasterTurn0 = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterAfterCommentCtx), 'caster');

        // holdDuckMs: max_react フェーズへの setTimeout ギャップ中もBGMを維持
        await this.speakText(mainText, 'commentator', null, { holdDuckMs: 400, expectedGen: _myGen });

        // 今回MCが振った質問テーマを記録（最新3件を保持）
        if (commentMcQuestion) {
          this._recentTopics = [commentMcQuestion, ...this._recentTopics].slice(0, 3);
        }
        this._recordCornerPlayed('commentator');
        this._writeDiaryReflection('commentator', _an.commentator, mainText).catch(() => {});
        this._postCornerExchange = { corner: 'commentator', phase: 'max_react' };
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ゲスト論客3人（お笑い芸人・医師・マーケター）のターン。
  // コメンテーター・ジャーナリストと同じ2段構えで進む。
  async _runGuestAnalystStep(ctx, cornerKey) {
    const { _myGen, config, _an, baseContextPrompt } = ctx;
    const def = getGuestAnalystDef(cornerKey);
    const _selfName = _an[cornerKey];
    const _tag = def.shortLabel;

    this.currentState = `TALKING_${cornerKey.toUpperCase()}`;
    this._broadcast({ event: 'CORNER_START', name: def.callName(_selfName) });

    if (this._prefetchedSpeech?.key === cornerKey) this._prefetchedSpeech = null;
    if (this._prefetchedCornerSpeech?.key === cornerKey) this._prefetchedCornerSpeech = null;

    const _topicReq = this.pendingGuestAnalystRequests[cornerKey];
    this.pendingGuestAnalystRequests[cornerKey] = null;
    if (_topicReq) {
      getLogger().info(`[${_tag}] リクエスト: topic="${_topicReq.topic || 'none'}", raw="${_topicReq.rawText}"`);
    }

    const _mcQuestion = this.lastSpeech.caster || null;
    getLogger().debug(`[${_tag}] MCの質問: ${_mcQuestion ? _mcQuestion.slice(0, 60) + '…' : '(なし)'}`);

    // キャスター 発話中に先行構築済みのコンテキスト・前置きがあれば使う（待ち時間ほぼゼロ）。
    // 話題リクエストがある場合だけは、指示を注入するためその場で作り直す。
    const _cachedPhase1 = (this._prefetchConvCorner?.key === cornerKey && !_topicReq)
      ? this._prefetchConvCorner.phase1Promise : null;
    let _ctxWithQ;
    if (this._prefetchConvCorner?.key === cornerKey && !_topicReq) {
      getLogger().debug(`[Pipeline] ${cornerKey}: 先読みコンテキスト使用`);
      _ctxWithQ = await this._prefetchConvCorner.contextPromise;
      this._prefetchConvCorner = null;
    } else {
      if (this._prefetchConvCorner?.key === cornerKey) this._prefetchConvCorner = null;
      _ctxWithQ = await this._buildCornerContext(cornerKey, baseContextPrompt, _mcQuestion, _topicReq);
    }
    const _searchOverride = _topicReq?.rawText ? true : null;
    const _mainPromise = this.generateAgentSpeech(cornerKey, _ctxWithQ, _searchOverride);

    // Phase 1: 前置き（Google Search OFF・軽量ティア）
    const _casterEarly = (config.agents?.caster?.name) || 'MAX';
    const _preCtx = this._buildPhase1PreContext(cornerKey, baseContextPrompt, _mcQuestion, _casterEarly, _an);
    const _prePromise = _cachedPhase1
      ? _cachedPhase1.then((t) => { getLogger().debug(`[Pipeline] ${cornerKey} Phase 1 先読みヒット`); return t; })
      : this.generateAgentSpeech(cornerKey, _preCtx, false, 'light');

    const _preText = this._stripHandoffPhrase(await _prePromise, _an.caster);
    this.lastSpeech[`${cornerKey}_pre`] = _preText;
    await this.speakText(_preText, cornerKey, null, { expectedGen: _myGen });

    // Phase 2: 本編（前置きの読み上げ中に生成が進んでいる）
    const _caster = (config.agents?.caster?.name) || 'MAX';
    const _mainText = this._truncateAtEndMarker(
      await _mainPromise,
      [`${_caster}さん、どうぞ`, `${_caster}、どうぞ`, `どうぞ、${_caster}`, 'いかがでしょうか', 'スタジオにお返しします', 'スタジオへどうぞ'],
      _tag
    );
    this.lastSpeech[cornerKey] = _mainText;
    this._pushRecentCornerContent(cornerKey, _selfName, _mainText);

    // 本編の読み上げ中に、キャスターのリアクションと次の通常ターンを先読みする
    const _claraLast = this.lastSpeech.assistant
      ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
    const _selfLast = `\n【${_selfName}が今話したこと】${_mainText.slice(0, 200)}…`;
    const _maxReactCtx = `${baseContextPrompt}
【${_selfName}の発言（要約）】${_mainText.slice(0, 300)}

⚠️【自己言及の禁止】あなたは${_an.caster}です。自分を三人称で呼ぶのは禁止です。

${def.maxReact({ self: _selfName })}`;
    this._prefetchedSpeech = this._buildPrefetchedSpeech(`${cornerKey}_max_react`, this.generateAgentSpeech('caster', _maxReactCtx), 'caster');
    const _casterAfterCtx = `${baseContextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
${_selfName}のコーナーが終わりました。その内容を受けて一言感想・リアクションを述べ、${_an.assistant}に「どう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。${_selfName}の話への具体的リアクションから始めてください。${_claraLast}${_selfLast}`;
    this._savedCasterTurn0 = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', _casterAfterCtx), 'caster');

    await this.speakText(_mainText, cornerKey, null, { holdDuckMs: 400, expectedGen: _myGen });

    if (_mcQuestion) {
      this._recentTopics = [_mcQuestion, ...this._recentTopics].slice(0, 3);
    }
    this._recordCornerPlayed(cornerKey);
    // 日記（振り返り）はここで書く。継続観測メモは上の _pushRecentCornerContent（_recordCornerNote）で記録済み
    this._writeDiaryReflection(cornerKey, _selfName, _mainText).catch(() => {});
    this._postCornerExchange = { corner: cornerKey, phase: 'max_react' };
    this.conversationTurn = 0;
    this.currentTokenHolder = 'caster';
    this._scheduleNextStep(0, _myGen);
  }

  // ─── runSingleShowStep: ジャーナリストXコーナー ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runJournalistStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ━━ 謎のジャーナリスト X コーナー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 2フェーズ発話（commentator と同じ構造）:
        //   Phase 1 「少し確認します。ちょっとお待ちを。」（検索なし・高速）
        //            → TTS再生しながら Phase 2 の Google Search が走る
        //   Phase 2  X のトレンド・著名人の発言・一次情報に基づく本コメント
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        this.currentState = 'TALKING_JOURNALIST';
        this._broadcast({ event: 'CORNER_START', name: `${_an.journalist}のコメント` });

        // ── Phase 2: MCの質問を受けてから生成（先読みキャッシュは使わない）──────────
        // キャスターの質問テーマをもとに Google Search で最新情報を取得する。
        if (this._prefetchedSpeech?.key === 'journalist') this._prefetchedSpeech = null;
        if (this._prefetchedCornerSpeech?.key === 'journalist') this._prefetchedCornerSpeech = null;
        const journalistMcQuestion = this.lastSpeech.caster || null;
        getLogger().debug(`[Journalist] MCの質問: ${journalistMcQuestion ? journalistMcQuestion.slice(0, 60) + '…' : '(なし)'}`);

        // リスナーリクエストがあれば消費（prefetch はスキップ）
        const _journalistTopicReq = this.pendingJournalistRequest;
        this.pendingJournalistRequest = null;
        if (_journalistTopicReq) {
          getLogger().info(`[Journalist] リスナーリクエスト: topic="${_journalistTopicReq.topic || 'none'}"`);
        }

        // Phase 1 先読みキャッシュを _prefetchConvCorner クリア前に取得
        const _cachedPhase1Jn = (this._prefetchConvCorner?.key === 'journalist' && !_journalistTopicReq)
          ? this._prefetchConvCorner.phase1Promise : null;
        // キャスター 発話中に先行構築済みのコンテキストがあれば使う（リクエストがある場合はスキップ）
        let journalistCtxWithQ;
        if (this._prefetchConvCorner?.key === 'journalist' && !_journalistTopicReq) {
          getLogger().debug('[Pipeline] journalist: 先読みコンテキスト使用');
          journalistCtxWithQ = await this._prefetchConvCorner.contextPromise;
          this._prefetchConvCorner = null;
        } else {
          if (this._prefetchConvCorner?.key === 'journalist') this._prefetchConvCorner = null;
          journalistCtxWithQ = await this._buildCornerContext('journalist', baseContextPrompt, journalistMcQuestion, _journalistTopicReq);
        }
        const _journalistSearchOverride = _journalistTopicReq?.rawText ? true : null;
        const journalistMainPromise = this.generateAgentSpeech('journalist', journalistCtxWithQ, _journalistSearchOverride);

        // ── Phase 1: 前置きセリフ生成（Google Search OFF）─────────────────────────
        // 質問テーマに触れながら「情報を確認している」と謎めいた雰囲気で伝える
        // キャスター 発話中に先読みキャッシュ (_cachedPhase1Jn) があれば即座に使用（待ち時間ゼロ）
        // プロンプトの組み立ては _buildPhase1PreContext() に集約してある（先読み側と共通）
        const journalistPreCtx = this._buildPhase1PreContext('journalist', baseContextPrompt, journalistMcQuestion, _an.caster, _an);

        const journalistPrePromise = _cachedPhase1Jn
          ? (_cachedPhase1Jn.then(t => { getLogger().debug('[Pipeline] journalist Phase 1 先読みヒット'); return t; }))
          : this.generateAgentSpeech('journalist', journalistPreCtx, false, 'light'); // search OFF

        // Phase 1 テキスト取得・読み上げ（この間に Phase 2 の Google Search が進む）
        // セーフティネット: LLM がプロンプト禁止を無視して「どうぞ」を末尾に付けた場合に削除
        const journalistPreText = this._stripHandoffPhrase(await journalistPrePromise, _an.caster);
        this.lastSpeech.journalist_pre = journalistPreText;
        await this.speakText(journalistPreText, 'journalist', null, { expectedGen: _myGen });

        // Phase 2: 本コメント（Phase 1 TTS 再生中に Google Search 完了しているはず）
        const _jnCaster = (config.agents?.caster?.name) || 'MAX';
        const journalistMainText = this._truncateAtEndMarker(
          await journalistMainPromise,
          [`${_jnCaster}、どうぞ`, `${_jnCaster}さん、どうぞ`, `以上です。${_jnCaster}`, 'ではまた。', 'スタジオにお返しします', 'スタジオへどうぞ'],
          'Journalist'
        );
        this.lastSpeech.journalist = journalistMainText;
        this._pushRecentCornerContent('journalist', _an.journalist, journalistMainText);

        // ── パイプライン: 本コメント再生中に2つ並行プリフェッチ ──────────────────────
        // ① journalist_max_react: キャスター の即時リアクション（X→キャスター の間を埋める）
        // ② caster_turn0 (→ _savedCasterTurn0): guest_reply 後の キャスター 通常ターン用
        const claraLastJ = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        const journalistLastSpeech = this.lastSpeech.journalist
          ? `\n【${_an.journalist}が今伝えたこと】${this.lastSpeech.journalist.slice(0, 200)}…` : '';
        // ① max_react 用（1〜2文の短いリアクション）
        const _maxReactCtxJn = `${baseContextPrompt}
【${_an.journalist}の発言（要約）】${journalistMainText.slice(0, 300)}

⚠️【自己言及の禁止】あなたは${_an.caster}です。自分を三人称で呼ぶのは禁止です。

${_an.journalist}の発言を受けて1〜2文でリアクションしてください。${_an.journalist}のミステリアスな雰囲気に乗りつつ、率直な驚きや感想を一言。`;
        this._prefetchedSpeech = this._buildPrefetchedSpeech('journalist_max_react', this.generateAgentSpeech('caster', _maxReactCtxJn), 'caster');
        // ② guest_reply 後の通常ターン用を直接 _savedCasterTurn0 に退避
        const casterAfterJournalistCtx = `${baseContextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
${_an.journalist}のコメントが終わりました。その内容を受けて一言驚き・リアクションを述べ、${_an.assistant}に「どう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。${_an.journalist}の情報への具体的リアクションから始めてください。${claraLastJ}${journalistLastSpeech}`;
        this._savedCasterTurn0 = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterAfterJournalistCtx), 'caster');

        // holdDuckMs: max_react フェーズへの setTimeout ギャップ中もBGMを維持
        await this.speakText(journalistMainText, 'journalist', null, { holdDuckMs: 400, expectedGen: _myGen });

        // 今回MCが振った質問テーマを記録（最新3件を保持）
        if (journalistMcQuestion) {
          this._recentTopics = [journalistMcQuestion, ...this._recentTopics].slice(0, 3);
        }
        this._recordCornerPlayed('journalist');
        this._writeDiaryReflection('journalist', _an.journalist, journalistMainText).catch(() => {});
        this._postCornerExchange = { corner: 'journalist', phase: 'max_react' };
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ─── runSingleShowStep: 法律相談コーナー ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runLegalAdvisorStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ━━ 法律アドバイザー昭雄 弁護士 法律相談コーナー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // commentator/journalist と同じ2フェーズ構造:
        //   Phase 1 「少し判例を確認させてください」（Google Search なし・高速）
        //   Phase 2  法律解説・アドバイス本編（Google Search グラウンディング使用）
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        this.currentState = 'TALKING_LEGAL_ADVISOR';
        this._broadcast({ event: 'CORNER_START', name: `${_an.legal_advisor}の法律相談` });

        if (this._prefetchedSpeech?.key === 'legal_advisor') this._prefetchedSpeech = null;
        if (this._prefetchedCornerSpeech?.key === 'legal_advisor') this._prefetchedCornerSpeech = null;

        const _legalTopicReq = this.pendingLegalAdvisorRequest;
        this.pendingLegalAdvisorRequest = null;
        if (_legalTopicReq) {
          getLogger().info(`[LegalAdvisor] リスナーリクエスト: topic="${_legalTopicReq.topic || 'none'}"`);
        }

        const legalMcQuestion = this.lastSpeech.caster || null;
        getLogger().debug(`[LegalAdvisor] MCの質問: ${legalMcQuestion ? legalMcQuestion.slice(0, 60) + '…' : '(なし)'}`);

        const _lgHandoffEnteredAt = Date.now();
        const _lgPrefetchAgeMs = this._prefetchConvCorner?.startedAt ? (_lgHandoffEnteredAt - this._prefetchConvCorner.startedAt) : null;
        getLogger().debug(`[Pipeline] legal_advisor ハンドオフ開始: prefetchKey=${this._prefetchConvCorner?.key || 'none'}, _legalTopicReq=${!!_legalTopicReq}, prefetch経過=${_lgPrefetchAgeMs !== null ? _lgPrefetchAgeMs + 'ms' : 'N/A'}（MAX発話時間とほぼ一致するはず）`);

        const _cachedPhase1Lg = (this._prefetchConvCorner?.key === 'legal_advisor' && !_legalTopicReq)
          ? this._prefetchConvCorner.phase1Promise : null;
        let legalCtxWithQ;
        if (this._prefetchConvCorner?.key === 'legal_advisor' && !_legalTopicReq) {
          getLogger().debug('[Pipeline] legal_advisor: 先読みコンテキスト使用');
          const _ctxWaitStart = Date.now();
          legalCtxWithQ = await this._prefetchConvCorner.contextPromise;
          const _ctxWaitMs = Date.now() - _ctxWaitStart;
          if (_ctxWaitMs > 50) getLogger().debug(`[Pipeline] legal_advisor: contextPromise 待機に ${_ctxWaitMs}ms（先読みが未完了だった）`);
          this._prefetchConvCorner = null;
        } else {
          if (this._prefetchConvCorner?.key === 'legal_advisor') this._prefetchConvCorner = null;
          legalCtxWithQ = await this._buildCornerContext('legal_advisor', baseContextPrompt, legalMcQuestion, _legalTopicReq);
        }
        const _legalSearchOverride = _legalTopicReq?.rawText ? true : null;
        const legalMainPromise = this.generateAgentSpeech('legal_advisor', legalCtxWithQ, _legalSearchOverride);

        // Phase 1: 前置きセリフ（Google Search OFF）
        // プロンプトの組み立ては _buildPhase1PreContext() に集約してある（先読み側と共通）
        const _lgCasterEarly = (config.agents?.caster?.name) || 'MAX';
        const legalPreCtx = this._buildPhase1PreContext('legal_advisor', baseContextPrompt, legalMcQuestion, _lgCasterEarly, _an);

        const legalPrePromise = _cachedPhase1Lg
          ? (_cachedPhase1Lg.then(t => { getLogger().debug('[Pipeline] legal_advisor Phase 1 先読みヒット'); return t; }))
          : (getLogger().debug('[Pipeline] legal_advisor Phase 1 先読み未使用 — その場で生成開始（空白の原因になりうる）'), this.generateAgentSpeech('legal_advisor', legalPreCtx, false, 'light'));

        const _lgPreWaitStart = Date.now();
        const legalPreText = this._stripHandoffPhrase(await legalPrePromise, _an.caster);
        const _lgPreWaitMs = Date.now() - _lgPreWaitStart;
        getLogger().debug(`[Pipeline] legal_advisor Phase 1 取得完了までの待機: ${_lgPreWaitMs}ms（ハンドオフ開始から ${Date.now() - _lgHandoffEnteredAt}ms 経過）`);
        this.lastSpeech.legal_advisor_pre = legalPreText;
        await this.speakText(legalPreText, 'legal_advisor', null, { expectedGen: _myGen });

        // Phase 2: 本コメント
        const _lgCaster = (config.agents?.caster?.name) || 'MAX';
        const legalMainText = this._truncateAtEndMarker(
          await legalMainPromise,
          [`${_lgCaster}さん、どうぞ`, `${_lgCaster}、どうぞ`, 'いかがでしょうか', 'スタジオにお返しします', 'スタジオへどうぞ'],
          'LegalAdvisor'
        );
        this.lastSpeech.legal_advisor = legalMainText;
        this._pushRecentCornerContent('legal_advisor', _an.legal_advisor, legalMainText);

        // パイプライン: 本コメント再生中に2つ並行プリフェッチ
        const claraLastLg = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        const legalLastSpeech = this.lastSpeech.legal_advisor
          ? `\n【${_an.legal_advisor}が今コメントしたこと】${this.lastSpeech.legal_advisor.slice(0, 200)}…` : '';
        const _maxReactCtxLg = `${baseContextPrompt}
【${_an.legal_advisor}の発言（要約）】${legalMainText.slice(0, 300)}

⚠️【自己言及の禁止】あなたは${_an.caster}です。自分を三人称で呼ぶのは禁止です。

${_an.legal_advisor}の法律解説を受けて1〜2文でリアクションしてください。「なるほど、法律ってそういう仕組みなんですね！」など素直な驚きや感謝の一言で温かく締めて。`;
        this._prefetchedSpeech = this._buildPrefetchedSpeech('legal_advisor_max_react', this.generateAgentSpeech('caster', _maxReactCtxLg), 'caster');
        const casterAfterLegalCtx = `${baseContextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
${_an.legal_advisor}の法律相談コーナーが終わりました。そのコメントを受けて一言感想・リアクションを述べ、${_an.assistant}に「どう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。${_an.legal_advisor}のコメントへの具体的リアクションから始めてください。${claraLastLg}${legalLastSpeech}`;
        this._savedCasterTurn0 = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterAfterLegalCtx), 'caster');

        await this.speakText(legalMainText, 'legal_advisor', null, { holdDuckMs: 400, expectedGen: _myGen });

        if (legalMcQuestion) {
          this._recentTopics = [legalMcQuestion, ...this._recentTopics].slice(0, 3);
        }
        this._recordCornerPlayed('legal_advisor');
        this._writeDiaryReflection('legal_advisor', _an.legal_advisor, legalMainText).catch(() => {});
        this._postCornerExchange = { corner: 'legal_advisor', phase: 'max_react' };
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ─── runSingleShowStep: ワールドレポートコーナー ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runWorldReportStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ━━ 特派員 ワールドレポートコーナー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 2フェーズ発話（journalist と同じ構造）:
        //   Phase 1 「ハーイ キャスター！今日は〇〇からのLIVEレポートです！」（検索なし・高速）
        //            → TTS再生しながら Phase 2 の Google Search が走る
        //   Phase 2  現地ニュース + 世界ニュース（Google Search グラウンディング使用）
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        this.currentState = 'TALKING_WORLD_REPORT';
        this._broadcast({ event: 'CORNER_START', name: `${_an.world_report}のワールドレポート` });

        if (this._prefetchedSpeech?.key === 'world_report') this._prefetchedSpeech = null;
        if (this._prefetchedCornerSpeech?.key === 'world_report') this._prefetchedCornerSpeech = null;
        const wrMcQuestion = this.lastSpeech.caster || null;
        getLogger().debug(`[WorldReport] MCの呼びかけ: ${wrMcQuestion ? wrMcQuestion.slice(0, 60) + '…' : '(なし)'}`);

        // ── ジングル + 都市/コンテキスト取得を完全並列実行 ─────────────────────────
        // ジングルが何秒でも、都市決定は同時進行するので沈黙が発生しない。
        const _wrJingleDir = path.join(__dirname, 'assets', 'bgm', 'world_report');
        const _hasWrJingle = fs.existsSync(_wrJingleDir) &&
          fs.readdirSync(_wrJingleDir).some(f => f.endsWith('.mp3'));

        // ── 都市解決を _wrDataPromise の外で即開始（ジングルと確実に並列化）──────────
        // プリフェッチ済みならそれを流用、なければ今すぐ開始。
        // _wrDataPromise 内で await すると jingle の Promise.all に依存してしまうため外に出す。
        let _earlyLocationPromise;
        if (this._prefetchConvCorner?.key === 'world_report' && this._prefetchConvCorner.locationPromise) {
          _earlyLocationPromise = this._prefetchConvCorner.locationPromise;
          getLogger().info('[WorldReport] プリフェッチ済み都市解決を流用');
        } else {
          _earlyLocationPromise = this._resolveWorldReportCity();
          getLogger().info('[WorldReport] 都市解決を即開始（プリフェッチなし — ジングルと並列）');
        }

        // ── 「接続中」短文フレーズを即開始（都市名不要・ジングル終了直後に再生してギャップを埋める）──
        // 都市確定を待たず、コーナー開始と同時に生成。ジングル終了時点で必ず完了している見込み。
        const _wrConnCaster = (config.agents?.caster?.name) || 'MAX';
        const _connectCtx = `${baseContextPrompt}
あなた（${_an.world_report}）はたった今${_wrConnCaster}に電話がつながりました。
⚠️【最重要・絶対禁止】国名・地名・大陸名・方角（例: モロッコ、サハラ砂漠、アフリカ、ヨーロッパ、アジア等）は一言も出さないこと。
　具体的な場所は直後の本編コーナーで正式に発表されます。ここで先に言ってしまうと、本編で発表される場所と食い違う放送事故になります。
「今どこにいるか」ではなく「今どんな気分か・何が起きているか」だけを2文で話してください。
例（OK）:「ハーイ ${_wrConnCaster}！スティーブです！今日も信じられない場所からお届けします！こんな場所、えっと...ほとんどの人が知らない、guaranteed！」
例（NG・絶対禁止。具体的な場所を言ってしまっている）:「モロッコから、サハラ砂漠の近くからお届けしています！」
⚠️日本語ベースで話すこと。英語はフルセンテンス禁止・感嘆詞・単語のみ。テキストのみ出力。`;
        const _connectPhrasePromise = this.generateAgentSpeech('world_report', _connectCtx, false, 'light');

        // コンテキスト確定次第 Phase1 + Phase2 を両方即開始（ジングル中に最大先行処理）
        // Phase1: 検索なし(高速) → ジングル中に完了見込み
        // Phase2: Google Search あり(15〜25s) → ジングル(11s)+Phase1発話中(15〜20s) で完了見込み
        let _wrPhase1TextPromise = null;
        let _wrPhase2Promise     = null;

        const _wrDataPromise = (async () => {
          let ctx;
          if (this._prefetchConvCorner?.key === 'world_report') {
            getLogger().debug('[Pipeline] world_report: 先読みコンテキスト + 都市を使用');
            // コンテキスト構築と都市解決を並列実行（_earlyLocationPromise は既に開始済み）
            const [_ctx, _city] = await Promise.all([
              this._prefetchConvCorner.contextPromise,
              _earlyLocationPromise,
            ]);
            if (_city?.city && !this._worldReportCity?.city) this._worldReportCity = _city;
            this._prefetchConvCorner = null;
            ctx = _ctx;
          } else {
            // フォールバック: 都市確定 → コンテキスト構築（逐次実行）
            // _buildCornerContext(world_report) は this._worldReportCity.city を参照するため
            // 都市が null の状態で並列実行するとフォールバック（短い）プロンプトになってしまう。
            // context build 自体は async データ取得なし（即時）なので逐次でも遅延ゼロ。
            getLogger().debug('[WorldReport] fallback: 都市解決待ち → コンテキスト構築（逐次）');
            const _city = await _earlyLocationPromise;
            this._worldReportCity = _city;
            ctx = await this._buildCornerContext('world_report', baseContextPrompt, wrMcQuestion);
          }

          // コンテキスト確定 → Phase1 + Phase2 を同時に先行開始
          const _city1 = this._worldReportCity?.city || '不明';
          const _wrCaster = (config.agents?.caster?.name) || 'MAX';

          // 都市確定 → クライアントの InfoView マップを起動
          this._broadcast({
            event: 'INFOVIEW_DATA', type: 'world_report',
            city: _city1,
            englishName: this._worldReportCity?.englishName || '',
          });

          // Phase1: 検索なし・高速（場所宣言＋国の基本情報をWikipedia知識で紹介）
          // 接続フレーズの直後なので「Hey キャスター!」など再挨拶は不要、場所宣言から即入ること
          const _preCtx = `${baseContextPrompt}
【キャスター${_wrCaster}からの呼びかけ】${wrMcQuestion || ''}
あなた（${_an.world_report}）は今 ${_city1} にいます。すでに「ハーイ ${_wrCaster}！スティーブです！」と接続の挨拶を済ませた直後です。
⚠️【絶対禁止】冒頭に「Hey ${_wrCaster}!」「ハーイ ${_wrCaster}!」「${_wrCaster}!」等の呼びかけは使わないこと。
挨拶は接続フレーズで完了済み。最初の一語は場所の宣言から始めること。
（OK例:「今日は${_city1}！」「私、今ね、${_city1}にいます！」「えっと、${_city1}、信じられない！」）
3〜4文で話してください:
1. 場所の宣言（例:「今日は${_city1}！」「私、今ね、${_city1}います！」）
2. この国・地域の驚きの事実2つ（人口・宗教・言語・歴史・日本との関係から面白いものを選ぶ）
3. 「では現地レポートへ！」の橋渡し（1文）
⚠️【絶対厳守】英語圏からのレポートでも、発言の80〜90%は日本語で話すこと。英語フルセンテンス禁止。英語は感嘆詞・単語のみ。
${_an.world_report}の下手な日本語スタイルで。日本語メインのテキストのみ出力。`;
          _wrPhase1TextPromise = this.generateAgentSpeech('world_report', _preCtx, false, 'light');

          // Phase2: Google Search あり（現地ニュース詳細）← ジングル中から開始！
          // _buildCornerContext が都市確定後に実行されるため ctx には都市情報が含まれている
          _wrPhase2Promise = this.generateAgentSpeech('world_report', ctx);

          getLogger().info('[WorldReport] Phase1 + Phase2 をコンテキスト確定後すぐ先行開始（ジングル中）');
          return ctx;
        })();

        // ジングルと（都市決定+Phase1先行生成）を並列実行
        let wrCtxWithQ;
        if (_hasWrJingle) {
          getLogger().info('[WorldReport] ジングル再生（都市決定・Phase1生成と並列）');
          [wrCtxWithQ] = await Promise.all([
            _wrDataPromise,
            this.mixer.playJingle(_wrJingleDir, {
              fadeInMs:       200,
              playDurationMs: 11000, // ジングル長さ（config外で管理）
              fadeOutMs:      800,
              restoreBgm:     false, // 特派員コーナーはジングル後にBGMを復元しない（アンビエントに切り替え）
            }).then(() => new Promise(r => setTimeout(r, 200))), // ジングル後の一息
          ]);
        } else {
          wrCtxWithQ = await _wrDataPromise;
        }

        // ── 特派員 コーナー中の BGM 処理（現場の臨場感）────────────────────────────
        // BGM フェード(1.2s) と Phase1 最終待機を並列で進める
        const _reportCity      = (this._worldReportCity?.city          || '').toLowerCase();
        const _ambientCategory = this._worldReportCity?.ambientCategory || null;
        const _ambientPath = this._resolveAmbientFolder(_wrJingleDir, _reportCity, _ambientCategory);

        this.mixer._volumeLocked = true;
        // ジングル終了後はBGMが既に停止済み（restoreBgm:false）のため fadeBgmTo 不要
        // ── アンビエント開始 ──────────────────────────────────────────────────────
        if (_ambientPath) {
          // 0.65: 環境音源ファイルはもともと低レベルなので高めの基準音量を設定。
          // auto-ducking は speech 中に base×0.5=0.325、idle 時は base=0.65 で動作する（相対 ducking）。
          this.mixer.playAmbientShuffle(_ambientPath, 0.65);
          this.mixer._volumeLocked = false;
          getLogger().info(`[WorldReport] アンビエント shuffle: ${_ambientPath} (city="${_reportCity}", category="${_ambientCategory}")`);
        } else {
          getLogger().info('[WorldReport] アンビエントなし — 無音モード');
        }

        // ── 「接続フレーズ」をジングル直後に即再生（Phase1 生成待ちのギャップを埋める）──
        // 都市名不要で生成済み。ほぼ確実にジングル終了時点で準備完了している。
        const _connectText = await _connectPhrasePromise.catch(() => '');
        if (_connectText) {
          await this.speakText(_connectText, 'world_report', null, { expectedGen: _myGen });
        }

        // Phase1 テキストを待機（都市確定後に生成開始済み。接続フレーズ再生中に完了見込み）
        const wrPreText = await (_wrPhase1TextPromise || Promise.resolve(''));

        // Phase2 はすでにジングル中から先行開始済み（_wrPhase2Promise）
        const wrMainPromise = _wrPhase2Promise || this.generateAgentSpeech('world_report', wrCtxWithQ);

        // Phase 1 読み上げ
        this.lastSpeech.world_report_pre = wrPreText;

        let wrMainText = '';
        let _phase2FirstPcm = null;
        const _preparePhase2 = async () => {
          try {
            let wrMainRaw = await wrMainPromise;
            // ── [LOCATION:xxx] タグを解析して直近レポート地を記録 ──────────────────
            // indexOf で [LOCATION: の開始位置を探す（正規表現だと内側の ] で誤マッチするため）
            const _locStart = wrMainRaw.indexOf('[LOCATION:');
            let _reportedCity = this._worldReportCity?.city || '';
            if (_locStart !== -1) {
              const _locEnd = wrMainRaw.indexOf(']', _locStart + 10);
              if (_locEnd !== -1) {
                const _extracted = wrMainRaw.slice(_locStart + 10, _locEnd).trim();
                // 都市名らしい短い文字列のみ採用（LLM がセリフを混入した場合は無視）
                if (_extracted.length <= 60 && !/PAUSE|MAX|では|ます！|いる/.test(_extracted)) {
                  _reportedCity = _extracted;
                }
              }

              if (_locStart <= 10) {
                // ── 正常ケース: タグが冒頭 → タグのみ除去 ──────────────────────────
                wrMainRaw = wrMainRaw.slice((_locEnd !== -1 ? _locEnd + 1 : _locStart)).trim();
              } else {
                // ── 異常ケース: タグが冒頭にない（末尾 or 中間）──────────────────────
                // LLM がタグをセリフ末尾に置き、その後にセリフを再生成したケース。
                // タグ以前のテキスト（= 最初のセリフ全文）のみを使用し、以降を破棄する。
                getLogger().warn(`[WorldReport] [LOCATION:] タグが冒頭にありません (pos=${_locStart}/${wrMainRaw.length}) → タグ以前を採用、以降の重複を破棄`);
                wrMainRaw = wrMainRaw.slice(0, _locStart).trim();
              }

              // BUGFIX: 検索を使ったときは応答の形が揺れるため、期待した形で来なかった場合にも
              //         取り出せるようにしておく。
              const _locStart2 = wrMainRaw.indexOf('[LOCATION:');
              if (_locStart2 !== -1) {
                getLogger().warn(`[WorldReport] 除去後もなお[LOCATION:]タグを検出 → モデル内部再試行による重複とみなし以降を破棄 (pos=${_locStart2}/${wrMainRaw.length})`);
                wrMainRaw = wrMainRaw.slice(0, _locStart2).trim();
              }
            }
            // 都市名として不正な文字列（発話テキストの混入）を弾いてから保存
            const _isValidReportedCity = _reportedCity &&
              _reportedCity.length >= 2 && _reportedCity.length <= 40 &&
              !/PAUSE|Hey\s|今[、,]私|です！|ます！|Back\s*to|からお伝え/i.test(_reportedCity);
            if (_isValidReportedCity) {
              getLogger().info(`[WorldReport] レポート地記録: ${_reportedCity}`);
              this._recentWorldReportCities = [_reportedCity, ...this._recentWorldReportCities].slice(0, WR_CITIES_MAX);
              this._saveWorldReportCities(); // リブート後も重複を避けるため即時永続化
            } else if (_reportedCity) {
              getLogger().warn(`[WorldReport] レポート地が不正のため保存をスキップ: "${_reportedCity}"`);
            }
            // 括弧なしの PAUSE マーカー（LLM が誤生成した [PAUSE:xxx] の残骸）を除去
            wrMainRaw = wrMainRaw.replace(/(?<!\[)\bPAUSE:\d+\b/g, '').replace(/\s{2,}/g, ' ').trim();
            // BUGFIX: 終了の目印に名前を直書きしないこと。設定で名前が変わると一致しなくなる。
            const _wrEndMarkers = [`Back to you, ${_an.caster}`, `Back to you ${_an.caster}`,
              `Back to you, ${_an.caster.toUpperCase()}`, `Back to you ${_an.caster.toUpperCase()}`,
              'スタジオにお返しします', 'スタジオへどうぞ', 'からのライブレポートでした'];
            wrMainText = this._truncateAtEndMarker(wrMainRaw, _wrEndMarkers, 'WorldReport');

            // 短すぎるレポートはリトライ（Phase1 再生中に並列実行 → 最大限活用）
            if (wrMainText.length < 300) {
              getLogger().warn(`[WorldReport] Phase2 が短すぎます (${wrMainText.length}文字) → Phase1 再生中にリトライ`);
              try {
                const _wrRetryCtx = await this._buildCornerContext('world_report', baseContextPrompt, wrMcQuestion);
                const _wrRetryRaw = await this.generateAgentSpeech('world_report', _wrRetryCtx);
                let _wrRetryClean = _wrRetryRaw.replace(/\[LOCATION:[^\]]+\]\s*\n?/, '').trim();
                // BUGFIX: 上の取り除きは最初の1個にしか効かないため、複数あると残る。全て取り除くこと。
                const _wrRetryLocStart2 = _wrRetryClean.indexOf('[LOCATION:');
                if (_wrRetryLocStart2 !== -1) {
                  getLogger().warn(`[WorldReport-retry] 除去後もなお[LOCATION:]タグを検出 → 重複とみなし以降を破棄 (pos=${_wrRetryLocStart2}/${_wrRetryClean.length})`);
                  _wrRetryClean = _wrRetryClean.slice(0, _wrRetryLocStart2).trim();
                }
                const _wrRetryText = this._truncateAtEndMarker(_wrRetryClean, _wrEndMarkers, 'WorldReport-retry');
                if (_wrRetryText.length > wrMainText.length) {
                  getLogger().info(`[WorldReport] リトライ成功: ${wrMainText.length} → ${_wrRetryText.length}文字`);
                  wrMainText = _wrRetryText;
                } else {
                  getLogger().warn(`[WorldReport] リトライも短い (${_wrRetryText.length}文字) → 元のテキストを使用`);
                }
              } catch (_retryErr) {
                getLogger().warn(`[WorldReport] リトライエラー: ${_retryErr?.message}`);
              }
            }
            // Phase2 が完全に空のまま → 締め句フォールバック（無音でコーナーが終わるのを防ぐ）
            if (wrMainText.length === 0) {
              getLogger().warn('[WorldReport] Phase2 完全空 → 締め句フォールバック');
              const _fcity = this._worldReportCity?.city || '';
              wrMainText = _fcity
                ? `...以上、${_fcity}からのライブレポートでした。スタジオへどうぞ。`
                : `...以上、現地からのライブレポートでした。スタジオへどうぞ。`;
            }
            this.lastSpeech.world_report = wrMainText;
            // Phase1 再生中に Phase2 の最初の文を先行 TTS 合成 → ギャップゼロ化
            const _wrTtsCfg = (this.getConfig().agents?.['world_report']) || {};
            const _wrGemini = (_wrTtsCfg.tts_engine || 'gemini') === 'gemini';
            const _phase2Sentences = _wrGemini
              ? this._splitTextToSentencesGemini(wrMainText)
              : this._splitTextToSentences(wrMainText);
            if (_phase2Sentences.length > 0) {
              getLogger().debug('[WorldReport] Phase2 先行TTS: 最初の文を合成開始');
              _phase2FirstPcm = await this._collectPcm(_phase2Sentences[0], 'world_report');
              getLogger().debug('[WorldReport] Phase2 先行TTS: 合成完了');
            }
          } catch (e) {
            getLogger().warn(`[WorldReport] Phase2 先行準備エラー: ${e?.message}`);
          }
        };

        // Phase1 再生 と Phase2 先行準備を並列実行
        await Promise.all([
          this.speakText(wrPreText, 'world_report'),
          _preparePhase2(),
        ]);

        // ── パイプライン: 本レポート再生中に次の Caster(turn=0) を先行生成 ──
        const claraLastWr = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        const wrLastSpeech = this.lastSpeech.world_report
          ? `\n【${_an.world_report}が今レポートしたこと】${this.lastSpeech.world_report.slice(0, 200)}…` : '';
        const casterAfterWrCtx = `${baseContextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
${_an.world_report}のワールドレポートが終わりました。その内容を受けて驚き・リアクションを1文述べ、${_an.assistant}に「どう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。${_an.world_report}のレポート内容への具体的リアクションから始めてください。${claraLastWr}${wrLastSpeech}`;
        this._prefetchedSpeech = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterAfterWrCtx), 'caster');

        // Phase2 再生（先行合成済みの最初の文を活用してギャップゼロ化）
        // ※特派員はスタジオ外（スターリンク経由のリモート特派員）という設定のため、
        //   スタジオの効果音（SFX）演出はここには挿入しない。
        await this.speakText(wrMainText, 'world_report', _phase2FirstPcm, { expectedGen: _myGen });

        // 特派員 コーナー終了 → アンビエント停止 + 通常 BGM 復元
        this.mixer._volumeLocked = false;
        this.mixer.stopBgm(); // アンビエント（またはフェードアウト中の BGM）を停止
        this.mixer.currentBgmVolume = 0;
        this.mixer.targetBgmVolume  = 0;
        // 通常 BGM をシャッフルで再開（音量 0 から auto-ducking で自然にフェードイン）
        const _nextBgm = this.mixer._pickNextBgmFile();
        if (_nextBgm) this.mixer.playBgm(_nextBgm);
        this.mixer.setBgmVolumeTarget(1.0);
        getLogger().info('[WorldReport] コーナー終了 — 通常 BGM 復元');

        // 都市リセット（_recentWorldReportCities は保持、_worldReportCity は不要）
        this._worldReportCity = null;

        this._recordCornerPlayed('world_report');
        this._recordCornerNote('world_report', wrMainText);
        this._writeDiaryReflection('world_report', _an.world_report, wrMainText).catch(() => {});
        this._postCornerExchange = { corner: 'world_report', phase: 'max_react' };
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ─── runSingleShowStep: 音楽・エンタメ（DJ）コーナー ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runMusicDjStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ━━ 音楽DJ 音楽・エンタメコーナー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 2フェーズ発話（commentator / journalist と同じ構造）:
        //   Phase 1 「チャートをチェックしています！少々お待ちを！」（検索なし・高速）
        //            → TTS再生しながら Phase 2 の Google Search が走る
        //   Phase 2  最新チャート・新譜・芸能ニュースに基づく本コーナー
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        this.currentState = 'TALKING_MUSIC_DJ';
        this._broadcast({ event: 'CORNER_START', name: `${_an.music_dj}の音楽・エンタメコーナー` });

        // ── Phase 2: MCの質問を受けてから生成（先読みキャッシュは使わない）──────────
        if (this._prefetchedSpeech?.key === 'music_dj') this._prefetchedSpeech = null;
        if (this._prefetchedCornerSpeech?.key === 'music_dj') this._prefetchedCornerSpeech = null;
        const musicMcQuestion = this.lastSpeech.caster || null;
        const _djCaster = (config.agents?.caster?.name) || 'MAX';
        const _djAsst   = (config.agents?.assistant?.name) || 'Clara';
        getLogger().debug(`[MusicDJ] MCのリクエスト: ${musicMcQuestion ? musicMcQuestion.slice(0, 60) + '…' : '(なし)'}`);

        // ── リスナーからの曲リクエスト、またはキャスターが口頭でDJに振ったリクエストを取得してクリア ──
        // pendingMusicRequest は Director ルーティング（リスナーのテキストチャット）時にセットされる。
        // それが無い場合は、キャスター自身がコーナー移行セリフの中で口頭リクエストしていないかを
        // 同じ分類器（_detectMusicRequestFromCasterText）で判定する。先読み（_prefetchConvCorner）
        // が効いていれば キャスター 発話中に判定済みの pendingReqPromise を使うため待ち時間はほぼゼロ、
        // 先読みが無い（キャッシュミス）場合のみここで直接判定する。
        // music_dj コーナー処理が開始した時点で消費してクリアする。
        const _listenerPendingReq = this.pendingMusicRequest;
        this.pendingMusicRequest = null;
        let _pendingMusicReq = _listenerPendingReq;
        if (!_pendingMusicReq) {
          _pendingMusicReq = (this._prefetchConvCorner?.key === 'music_dj' && this._prefetchConvCorner.pendingReqPromise)
            ? await this._prefetchConvCorner.pendingReqPromise
            : await this._detectMusicRequestFromCasterText(musicMcQuestion);
        }
        if (_pendingMusicReq) {
          getLogger().info(`[MusicDJ] ${_listenerPendingReq ? 'リスナーリクエスト曲' : 'MAXの口頭リクエスト'}: artist="${_pendingMusicReq.artist}", song="${_pendingMusicReq.song}", text="${_pendingMusicReq.text}"`);
        }

        // ── Spotify プレビュー確認済みトラックを事前取得 ────────────────────────
        // Phase 2 の Gemini 生成前に「実際に再生できる曲」リストを作り、
        // 音楽DJがそのリストの中から選んで紹介するようにする。
        // これにより「紹介したのに再生されない」放送事故を防ぐ。
        const spotifyCreds2 = this.getCredentials().spotify;
        const spotifyReady2 = !!(spotifyCreds2?.client_id && (spotifyCreds2?.refresh_token || spotifyCreds2?.client_secret));

        // ── Phase 1: 前置きセリフ生成（先読みキャッシュがあれば使用、なければ即座に開始）──
        // キャスター 発話中に _prefetchConvCorner.phase1Promise として先読み済みのはず。
        // リスナーリクエストの有無が変わっていた場合（稀）はキャッシュを捨てて再生成する。
        const _cachedPhase1Dj = (this._prefetchConvCorner?.key === 'music_dj')
          ? this._prefetchConvCorner.phase1Promise : null;
        // Phase 1 は通常コーナー（チャート確認中）とリクエスト（すぐかける）で内容を切り替える
        // プロンプトの組み立ては _buildMusicDjPhase1Context() に集約してある（先読み側と共通）
        const musicDjPreCtx = this._buildMusicDjPhase1Context(baseContextPrompt, musicMcQuestion, _djCaster, _an, _pendingMusicReq, _djAsst);
        // 先読みキャッシュを使用（リクエスト有無が変わっていても「少し待って」という趣旨は同じ）
        const musicDjPrePromise = _cachedPhase1Dj
          ? (_cachedPhase1Dj.then(t => { getLogger().debug('[Pipeline] music_dj Phase 1 先読みヒット'); return t; }))
          : this.generateAgentSpeech('music_dj', musicDjPreCtx, false, 'light');

        // ── リクエスト曲の Spotify 可否を Phase1 と並行して確認 ──────────────────────
        // Phase1 再生中（5〜10秒）に検索を終わらせる。結果を Phase2 コンテキストに反映する。
        const _reqAvailabilityPromise = (
          _pendingMusicReq && _pendingMusicReq.artist && _pendingMusicReq.song && spotifyReady2
        )
          ? this._searchSpotifyTrack(`${_pendingMusicReq.artist}/${_pendingMusicReq.song}`).catch(() => null)
          : Promise.resolve(null);

        // ── Spotify + コンテキスト: 先読みキャッシュがあれば使い、なければ並列で取得 ──
        // キャスター 発話中に _prefetchConvCorner で先行開始済みの場合はほぼ待ち時間ゼロ。
        let musicDjCtxWithQ;
        let rawConfirmedList = '';
        if (this._prefetchConvCorner?.key === 'music_dj') {
          getLogger().debug('[Pipeline] music_dj: 先読みコンテキスト+Spotifyトラック使用');
          [musicDjCtxWithQ, rawConfirmedList] = await Promise.all([
            this._prefetchConvCorner.contextPromise,
            this._prefetchConvCorner.spotifyTracksPromise,
          ]);
          this._prefetchConvCorner = null;
        } else {
          // フォールバック: Spotify 取得 + コンテキスト構築を並列実行
          // 検索語の組み立ては _buildMusicDjSpotifyQueries() に集約してある（先読み側と共通）
          const profile2 = this.getConfig().show?.user_profile || {};
          const favoriteArtistQueries = (profile2.favorite_artists || []).map(a => a.trim()).filter(Boolean);
          const shuffled = this._buildMusicDjSpotifyQueries(favoriteArtistQueries, this._recentlyPlayedArtists, _pendingMusicReq);
          getLogger().info('[MusicDJ] Spotify トラック取得 + コンテキスト構築を並列実行...');
          [rawConfirmedList, musicDjCtxWithQ] = await Promise.all([
            spotifyReady2 ? this._fetchSpotifyPlayableTracks(shuffled, 25) : Promise.resolve(''),
            this._buildCornerContext('music_dj', baseContextPrompt, musicMcQuestion),
          ]);
        }

        const { confirmedTracksSection, confirmedTrackLines: _confirmedTrackLines } = this._buildMusicDjConfirmedTracksSection(rawConfirmedList, spotifyReady2);

        // ── リクエスト曲 Spotify 可否確認の結果を受け取る ────────────────────────
        // Phase1 TTS 再生中に並行実行していた可否チェックを待つ（すでに完了しているはず）
        const _reqAvailResult = await _reqAvailabilityPromise;
        const _reqTrackFound  = !!_reqAvailResult?.uri;
        if (_pendingMusicReq) {
          if (_reqTrackFound) {
            getLogger().info(`[MusicDJ] リクエスト曲 Spotify確認済み: ${_reqAvailResult.artist} — ${_reqAvailResult.name}`);
          } else if (_pendingMusicReq.artist && _pendingMusicReq.song) {
            getLogger().warn(`[MusicDJ] リクエスト曲 Spotify未発見: "${_pendingMusicReq.artist}/${_pendingMusicReq.song}" → 代替案モードで進む`);
          }
        }

        // ── リスナーリクエスト曲セクション ──────────────────────────────────────
        // pendingMusicRequest があった場合、Saki の Phase2 をリクエスト専用モードに切り替える。
        // Spotify 可否に応じて「指定曲再生」または「代替案 + 告知」モードを選択する。
        const _uname3 = this.getConfig().show?.user_profile?.name || 'リスナー';
        // リクエストの種別を判定
        const _isSpecificSongReq  = !!((_pendingMusicReq?.artist) && (_pendingMusicReq?.song));
        const _isArtistFeatureReq = !!(_pendingMusicReq?.artist && !_pendingMusicReq?.song);
        const _isThemeReq         = !!(_pendingMusicReq && !_pendingMusicReq.artist && !_pendingMusicReq.song);

        const _musicRequestSection = _pendingMusicReq
          ? `\n\n${'★'.repeat(50)}
【🎵 リスナーリクエスト専用モード】
${_uname3}さんから「${_pendingMusicReq.text}」のリクエストが届いています。

${_isArtistFeatureReq
  ? `【🎤 アーティスト特集リクエスト】
「${_pendingMusicReq.artist}」の特集コーナーです！
あなた（サキ）が ${_pendingMusicReq.artist} の代表曲・名曲を2〜3曲選んで紹介してください。
確定再生リストに ${_pendingMusicReq.artist} の曲があればそれを使い、
なければ [TRACK:${_pendingMusicReq.artist}/曲名] タグで再生してください（曲名は実在する曲を選ぶこと）。
特集コーナーとして盛り上げてください！
❌ 通常のチャート・トレンドの話は不要
✅ ${_pendingMusicReq.artist} の各曲の魅力・歌詞・時代背景・アーティストの特徴をコメントする`
  : _isThemeReq
    ? `【🎨 テーマ・特集リクエスト】
これは特定の曲名ではなく「テーマ・ジャンル・特集」のリクエストです。
あなた（サキ）が自分の音楽知識でテーマに合った曲を2〜3曲自由に選んでください。
確定再生リストの曲でも、あなたが知っている他の曲でも構いません。
特集コーナーとして盛り上げてください！
❌ 通常のチャート・トレンドの話は不要
✅ テーマに合う曲を選んで、各曲の魅力・テーマとの関連をコメントする`
    : _reqTrackFound
      ? `【✅ Spotifyで見つかりました】
${_pendingMusicReq.artist}「${_pendingMusicReq.song}」を必ず [TRACK:${_pendingMusicReq.artist}/${_pendingMusicReq.song}] タグで再生してください。
⚠️ 直近再生禁止リストに含まれていても、リクエスト曲は例外として優先してください。`
      : `【⚠️ この曲はSpotifyで配信されていません】
「${_pendingMusicReq.song}」（${_pendingMusicReq.artist}）は残念ながらSpotifyで見つかりませんでした。
以下の対応をしてください:
1. ${_uname3}さんへ「この曲はSpotifyで配信されていないため〜」と正直に伝える（1文）
2. 代わりの曲として、同じアーティストの別曲か似た雰囲気の曲を再生済みリストから選ぶ
3. 「代わりに〜をお届けします！」と告知してから [TRACK:] タグで再生する
⚠️ 無音・ハングは絶対禁止。必ず何か再生してください。`}

【📝 コメントのルール（リクエスト時専用）】
❌ 絶対禁止: ヒットチャート・ランキング・トレンド・最新リリース・音楽ニュースの話
✅ やること: ${(_isThemeReq || _isArtistFeatureReq) ? 'テーマ・アーティストに合った曲紹介（各曲の魅力・テーマとの関連）' : 'リクエスト曲・アーティストに絞ったコメント（2〜3文）'}
  - ${(_isThemeReq || _isArtistFeatureReq) ? 'テーマ・アーティストを盛り上げる選曲と紹介' : '曲の雰囲気・歌詞のテーマ・聴き時・アーティストの魅力など'}
  - リクエストしてくれた${_uname3}さんへの一言
${'★'.repeat(50)}`
          : '';

        // ── 再生曲の事前確定（幻覚防止の核心）────────────────────────────────────────
        // LLM が学習データから存在しない曲を「紹介してから失敗」するのを根本防止する。
        // リクエストなし時は、確認済みリスト（_confirmedTrackLines）から先に曲を決め、
        // 「今日はこれを紹介してください」と LLM に渡す。DJ は渡された曲だけを紹介する。
        let _preSelectedSection = '';
        if (spotifyReady2 && _confirmedTrackLines.length > 0 && !_pendingMusicReq) {
          const _recentArtistSet = new Set(this._recentlyPlayedArtists);
          // 直近アーティストを避けた候補を優先、足りなければ全体から補完
          const _freshLines = _confirmedTrackLines.filter(l => {
            const sep = l.indexOf(' / ');
            return sep < 0 || !_recentArtistSet.has(l.slice(0, sep).trim());
          });
          const _pool = _freshLines.length >= 2 ? _freshLines : _confirmedTrackLines;
          const _pickCount = Math.random() < 0.4 ? 1 : 2; // 60%の確率で2曲、40%で1曲
          const _picked = [..._pool].sort(() => Math.random() - 0.5).slice(0, _pickCount);
          const _pickedTags = _picked.map(l => {
            const sep = l.indexOf(' / ');
            return sep >= 0 ? `[TRACK:${l.slice(0, sep).trim()}/${l.slice(sep + 3).trim()}]` : '';
          }).filter(Boolean);
          if (_pickedTags.length > 0) {
            getLogger().info(`[MusicDJ] 事前選曲: ${_pickedTags.join(' / ')}`);
            // BUGFIX: 曲の指定のタグだけを確定した曲に合わせても、本文の中の曲名・アーティスト名が
            //         古いままだと食い違う。両方を揃えること。
            const _pickedNames = _picked.map(l => {
              const sep = l.indexOf(' / ');
              return sep >= 0 ? `${l.slice(0, sep).trim()}の「${l.slice(sep + 3).trim()}」` : l;
            });
            _preSelectedSection =
              `\n\n${'◆'.repeat(50)}\n` +
              `【🎵 今日再生する曲（確定・変更不可）】\n` +
              `以下の [TRACK:] タグを一字一句変えずそのまま本文中に配置してください。\n` +
              `これ以外の [TRACK:] タグを追加することは絶対に禁止です。\n` +
              `⚠️【最重要】紹介文（地の文）で言及する曲名・アーティスト名も、必ずこの確定曲` +
              `（${_pickedNames.join('、')}）と完全に一致させてください。上記より前の` +
              `指示（雰囲気・時代・チャート等から自由に選んでよいという説明）はこの確定曲を` +
              `選んだ「理由付け」にのみ使い、それ以外の曲名・アーティスト名を地の文で語ることは、` +
              `たとえ雰囲気に合っていても絶対に禁止です。\n` +
              _pickedTags.join('\n') +
              `\n${'◆'.repeat(50)}`;
          }
        }

        // Phase 2 生成を開始（Spotify + コンテキスト + 事前選曲が揃った直後）
        const musicDjCtxFinal = musicDjCtxWithQ + confirmedTracksSection + _musicRequestSection + _preSelectedSection;
        const musicDjMainPromise = this.generateAgentSpeech('music_dj', musicDjCtxFinal);

        // Phase 1 読み上げ（並列処理と同時に進んでいた Phase1 生成を待つ）
        // セーフティネット: LLM がプロンプト禁止を無視して「どうぞ」を末尾に付けた場合に削除
        const musicDjPreText = this._stripHandoffPhrase(await musicDjPrePromise, _an.caster);
        this.lastSpeech.music_dj_pre = musicDjPreText;
        await this.speakText(musicDjPreText, 'music_dj', null, { expectedGen: _myGen });

        // Phase 2: チャート紹介 + 1曲フィーチャー（Phase 1 再生中に Google Search + Gemini が進む）
        let musicDjMainText = this._truncateAtEndMarker(
          await musicDjMainPromise,
          [`${_djCaster}、どうぞ！`, `${_djCaster}、どうぞ`, `はい、${_djCaster}`, 'スタジオへどうぞ！', 'スタジオへどうぞ', 'スタジオにお返しします'],
          'MusicDJ'
        );

        // ── リスナーリクエスト曲の [TRACK:] タグをコードレベルで強制置換 ──────────────
        // Saki がプロンプト指示を無視して別の曲タグを出力することがあるため、
        // Spotify で発見済みの場合のみ最初の [TRACK:] タグをリクエスト曲で上書きする。
        // 未発見の場合は置換しない（Saki が代替案を選んでいるため）。
        if (_pendingMusicReq && _pendingMusicReq.artist && _pendingMusicReq.song && _reqTrackFound) {
          const _reqTag = `[TRACK:${_pendingMusicReq.artist}/${_pendingMusicReq.song}]`;
          const _firstTagMatch = musicDjMainText.match(/\[TRACK:[^\]]+\]/);
          if (_firstTagMatch) {
            if (_firstTagMatch[0] !== _reqTag) {
              getLogger().info(`[MusicDJ] リクエスト曲タグを強制置換: "${_firstTagMatch[0]}" → "${_reqTag}"`);
              musicDjMainText = musicDjMainText.replace(_firstTagMatch[0], _reqTag);
            }
          } else {
            // [TRACK:] タグが生成されなかった場合は末尾に追加
            getLogger().info(`[MusicDJ] [TRACK:] タグなし → リクエスト曲タグを末尾追加: "${_reqTag}"`);
            musicDjMainText = musicDjMainText.trimEnd() + ` ${_reqTag}`;
          }
        } else if (_pendingMusicReq && !_reqTrackFound) {
          getLogger().info('[MusicDJ] リクエスト曲 Spotify未発見のため強制置換スキップ → Sakiの代替案を使用');
        }

        this.lastSpeech.music_dj = musicDjMainText;

        const spotifyCreds = this.getCredentials().spotify;
        const spotifyReady = !!(spotifyCreds?.client_id && (spotifyCreds?.refresh_token || spotifyCreds?.client_secret));

        // [TRACK:...] タグを抽出（重複除去）
        const trackTags = [...new Set(
          [...musicDjMainText.matchAll(/\[TRACK:([^\]]+)\]/g)].map(m => m[1].trim())
        )];

        // 音楽DJが喋っている間に並行してトラック検索を開始（ギャップ短縮）
        const trackSearchPromises = (spotifyReady && trackTags.length > 0)
          ? trackTags.map(tag => this._searchSpotifyTrack(tag))
          : [];

        // ── テキストを [TRACK:] タグでセグメント化（複数曲対応）──────────────────
        // 例: "Beatles特集！1曲目はHey Jude！[TRACK:The Beatles/Hey Jude] 続いて2曲目はLet It Be！[TRACK:The Beatles/Let It Be]"
        // split結果: ["Beatles特集！1曲目はHey Jude！", "The Beatles/Hey Jude", " 続いて2曲目はLet It Be！", "The Beatles/Let It Be", ""]
        const _tagSplitParts = musicDjMainText.split(/\[TRACK:([^\]]+)\]/);
        // _tagSplitParts[i*2]   = i番目のタグの直前テキスト（そのタグの曲のイントロ）
        // _tagSplitParts[i*2+1] = i番目のタグ内容 (= trackTags[i])
        const _trackSegments = trackTags.map((tag, i) => ({
          intro: (_tagSplitParts[i * 2] || '').replace(/\[TRACK:[^\]]+\]/g, '').replace(/\s{2,}/g, ' ').trim(),
          tag,
        }));

        // 1曲目のイントロのみ先に読む（Spotify検索と並行して進んでいる）
        const _firstIntro = _trackSegments[0]?.intro || '';
        await this.speakText(_firstIntro, 'music_dj', null, { expectedGen: _myGen });
        // ここで speakText 完了 = 1曲目イントロ再生完了。検索も並行して進んでいる。

        // ── Phase 3: 楽曲再生 ─────────────────────────────────────────────────────
        // ダミー用フォールバック時間（タグなし・Spotify 未設定時）
        const listenCues = (musicDjMainText.match(/聴いて|では次|続いて|次の曲/g) || []).length;
        const estimatedSongCount = Math.max(1, Math.min(3, trackTags.length || listenCues + 1));
        const dummyDurationMs = estimatedSongCount * 8000;

        const { actuallyPlayedCount: _actuallyPlayedCount, resolvedTracksForMeta: _resolvedTracksForMeta } = await this._playMusicDjTracks(ctx, {
          spotifyReady, trackTags, trackSearchPromises, _trackSegments, musicDjMainText, dummyDurationMs, estimatedSongCount, _djCaster,
        });

        // ── ガード: アウトロ再生・ダミー待機の間に切断→再接続が起きていた場合、
        // 以降の状態書き込み（_savedCasterTurn0・_postCornerExchange・currentTokenHolder等）を
        // 行わない。新セッション側の進行を前セッションの曲の文脈で汚染しないため。
        if (_myGen !== this._speakGeneration) {
          getLogger().info('[Music] セッション世代が変わったため music_dj 後処理をスキップ（切断→再接続）');
          return;
        }

        // ── パイプライン: アウトロ再生中に次のCaster(turn=0)を先行生成 ──────────────
        const claraLastDJ = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        // 実際に再生した曲 OR 音楽DJが告知した曲を明示
        // _actuallyPlayedCount > 0 なら履歴0番目が今回の曲、そうでなければ trackTags から曲名を組み立てる
        let _playedTrackLine = '';
        if (_actuallyPlayedCount > 0) {
          const _playedTrack = this._recentlyPlayedTracks[0];
          if (_playedTrack) {
            // _resolvedTracksForMeta から meta を取得（直近再生曲）
            const _playedMeta = _resolvedTracksForMeta?.find(t => t?.name === _playedTrack.name)?.meta || {};
            const _metaLines = [
              _playedMeta.album       ? `アルバム: ${_playedMeta.album}${_playedMeta.releaseYear ? `（${_playedMeta.releaseYear}年）` : ''}` : null,
              _playedMeta.genres      ? `ジャンル: ${_playedMeta.genres}` : null,
              _playedMeta.mood        ? `ムード: ${_playedMeta.mood}` : null,
              _playedMeta.energy      ? `エネルギー感: ${_playedMeta.energy}` : null,
              _playedMeta.tempo       ? `テンポ: 約${_playedMeta.tempo}BPM` : null,
              _playedMeta.key_mode    ? `キー: ${_playedMeta.key_mode}` : null,
            ].filter(Boolean).join(' / ');
            _playedTrackLine = [
              `\n【🎵 サキのDJブースから流れた曲】${_playedTrack.artist} — ${_playedTrack.name}`,
              _metaLines ? `曲の情報: ${_metaLines}` : '',
              `あなたの学習データにあるこの曲の歌詞・テーマ・雰囲気を思い出して、リアルな感想を述べてください。`,
              `（天気情報や他のトピックの感想と混同しないこと）`,
            ].filter(Boolean).join('\n');
          }
        } else if (trackTags.length > 0) {
          const _tagDesc = trackTags.map(t => {
            const p = t.split('/');
            return p.length === 2 ? `${p[1].trim()}（${p[0].trim()}）` : t;
          }).join('、');
          _playedTrackLine = `\n【📢 ${_an.music_dj}が紹介しようとした曲（Spotify再生失敗）】${_tagDesc}\n再生できなかったことに少し触れつつコメントしてください。`;
        }
        const musicDjSummary = musicDjMainText.slice(0, 200);
        const casterAfterMusicDjCtx = `${baseContextPrompt}
【${_an.music_dj}が紹介したコーナー内容（要約）】${musicDjSummary}
${_playedTrackLine}
${_an.music_dj}のDJブースから曲が流れ、スタジオでも聴こえていました。
その曲の感想（歌詞・メロディ・雰囲気など）を具体的に1〜2文で述べ、
${_an.assistant}に「どうでした？」と楽しそうに振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。
【重要】天気・ニュース・株価など他のコーナーの話題と混同しないこと。
【重要】上記の曲情報とあなたの知識を使い、その曲固有の感想を述べること。${claraLastDJ}`;
        // caster_turn0 は guest_reply 後に使用（_savedCasterTurn0 に退避）
        // ※ _prefetchedSpeech は music_dj_max_react が占有しているため上書きしない
        this._savedCasterTurn0 = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterAfterMusicDjCtx), 'caster');

        // 今回MCが振った音楽リクエストを記録（最新3件を保持）
        if (musicMcQuestion) {
          this._recentTopics = [musicMcQuestion, ...this._recentTopics].slice(0, 3);
        }
        this._recordCornerPlayed('music_dj');
        this._writeDiaryReflection('music_dj', _an.music_dj, musicDjMainText).catch(() => {});
        this._postCornerExchange = { corner: 'music_dj', phase: 'max_react' };
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // _buildMusicDjConfirmedTracksSection() / _playMusicDjTracks() は _runMusicDjStep から
  // 慎重に分割（副作用のない純粋ヘルパー部分と、再生ループの本体のみを対象にした）。
  //
  // rawConfirmedList（Spotify再生可能トラックの生リスト）から、再生失敗曲・直近再生済み曲・
  // 直近再生済みアーティストを除外した「確認済みトラックセクション」（プロンプト用文字列）と
  // 代替曲選択用の配列を組み立てる。副作用なし（ログ出力のみ）の純粋ヘルパー。
  _buildMusicDjConfirmedTracksSection(rawConfirmedList, spotifyReady2) {
        // 確認済みトラックセクションを組み立て
        let confirmedTracksSection = '';
        // 代替曲選択のためトラックロジック内からも参照できるよう外側で宣言
        let _confirmedTrackLines = [];
        if (spotifyReady2 && rawConfirmedList) {
          // 禁止リスト: playFailed 曲（全期間）+ 直近48時間以内の再生済み曲
          const _cutoffMs = Date.now() - PLAYED_TRACKS_HOURS * 60 * 60 * 1000;
          const _failedTracks  = this._recentlyPlayedTracks.filter(t => t.playFailed);
          const _recentPlayed  = this._recentlyPlayedTracks.filter(t => !t.playFailed && new Date(t.playedAt).getTime() > _cutoffMs);

          // ── rawConfirmedList から禁止曲を事前に除外 ──────────────────────────────
          // LLMに「禁止リスト」と「再生可能リスト」を両方渡すと矛盾が生じ、
          // 禁止曲が選ばれてしまうことがある。事前フィルタで矛盾を解消する。
          const _bannedKeys = new Set([
            ..._failedTracks.map(t => `${t.artist} / ${t.name}`.toLowerCase()),
            ..._recentPlayed.map(t => `${t.artist} / ${t.name}`.toLowerCase()),
          ]);
          const _filteredLines = rawConfirmedList
            .split('\n')
            .filter(line => line.trim() && !_bannedKeys.has(line.trim().toLowerCase()));
          // フィルタ後が空になった場合はフォールバック（全リストを使用）
          const _effectiveConfirmedList = _filteredLines.length > 0
            ? _filteredLines.join('\n')
            : rawConfirmedList;
          // 代替曲ピック用に配列として保持（"artist / name" 形式）
          _confirmedTrackLines = (_filteredLines.length > 0 ? _filteredLines : rawConfirmedList.split('\n')).filter(l => l.trim());
          const _removedCount = rawConfirmedList.split('\n').filter(l => l.trim()).length - _filteredLines.length;
          if (_removedCount > 0) {
            getLogger().info(`[MusicDJ] 再生済みトラックを再生可能リストから除外: ${_removedCount}件`);
          }

          const recentList = [
            _failedTracks.length > 0
              ? `\n【🚫 Spotifyで再生できなかった曲（絶対に選ばないこと）】\n` +
                _failedTracks.map(t => `- ${t.artist} — ${t.name}（再生不可 — 選ばないでください）`).join('\n')
              : '',
            _recentPlayed.length > 0
              ? `\n【❌ 直近${PLAYED_TRACKS_HOURS}時間以内に再生済みの曲（繰り返し禁止）】\n` +
                _recentPlayed.map(t => `- ${t.artist} — ${t.name}`).join('\n')
              : '',
          ].filter(Boolean).join('\n');
          const recentArtistsBan = this._recentlyPlayedArtists.length > 0
            ? `\n【🚫 直近で再生済みのアーティスト（今回は別アーティストを選ぶこと）】\n` +
              this._recentlyPlayedArtists.map(a => `- ${a}`).join('\n') +
              `\n⚠️ 上記アーティストの曲は今回選ばないでください。必ず別のアーティストから選んでください。`
            : '';
          confirmedTracksSection = `\n\n${'▓'.repeat(50)}
【⚠️ 必須: 以下はSpotifyで再生可能なトラックです（Web Playback SDK 使用）】
再生タグ [TRACK:アーティスト/曲名] には、必ずこのリストにある曲を使ってください。
⚠️【話題のアーティストがリストにない場合】キャスターや会話の文脈に出てきたアーティストの曲がこのリストにない場合は、コーナー冒頭で「〜さんの曲が今日のプレイリストに見当たらなかったので、代わりに〜をお届けします！」と一言告知してから代替曲を選んでください。告知なしに別の曲を流すのは禁止です。
${recentList}
${recentArtistsBan}
【✅ 再生可能リスト（この中から選んでください）】
${_effectiveConfirmedList}
${'▓'.repeat(50)}`;
          getLogger().info(`[MusicDJ] 再生可能トラック: ${_effectiveConfirmedList.split('\n').length}件（フィルタ後）`);
        } else if (spotifyReady2) {
          getLogger().warn('[MusicDJ] トラック取得失敗 — 再生タグなしで進む');
        }
        return { confirmedTracksSection, confirmedTrackLines: _confirmedTrackLines };
  }

  // DJ音楽DJのコーナー本編テキスト生成後の実際の楽曲再生を担う。Spotify Web Playback SDK
  // モード（trackTagsが1件以上かつSpotify接続済み）とダミーモード（Spotify未設定/タグなし）の
  // いずれかを実行し、実際に再生できた曲数と再生曲のmeta情報を呼び出し元へ返す（次のキャスター
  // ターン用プロンプトで曲の感想を語らせるために必要）。
  //
  // ⚠️ 切断→再接続でセッション世代が変わった場合、ループ内で早期returnする（元は
  // _runMusicDjStep自体を中断していたのと同じタイミング）。呼び出し元（_runMusicDjStep）は
  // このメソッドの直後に既存の世代チェックを持っており、それが変わらず後続処理を中断する。
  async _playMusicDjTracks(ctx, { spotifyReady, trackTags, trackSearchPromises, _trackSegments, musicDjMainText, dummyDurationMs, estimatedSongCount, _djCaster }) {
    const { _myGen, config, _an, baseContextPrompt } = ctx;

        // _actuallyPlayedCount / _resolvedTracksForMeta は if/else の外側でも参照するため、ブロック外で宣言する
        let _actuallyPlayedCount = 0;
        let _resolvedTracksForMeta = []; // 再生曲の meta 情報をブロック外に持ち出す用

        if (spotifyReady && trackTags.length > 0) {
          // ── Spotify Web Playback SDK モード（複数曲対応）─────────────────────
          // BGM を一括停止（全曲終了後に再開）
          const bgmFileToRestore = this.mixer.currentBgmFile;
          if (bgmFileToRestore) {
            this.mixer._volumeLocked = true;
            await this.mixer.fadeBgmTo(0, 1200);
            this.mixer.stopBgm();
            this.mixer._volumeLocked = false;
          } else {
            this.mixer.stopBgm();
          }
          getLogger().debug('[Duck] start music');

          // 検索結果を待つ（speakText と並行していたので既に完了済みのはず）
          const resolvedTracks = await Promise.all(trackSearchPromises);
          _resolvedTracksForMeta = resolvedTracks; // ブロック外の共通コードで meta 参照用
          getLogger().info(`[Music] 再生キュー: ${trackTags.length}曲 [${trackTags.join(' / ')}]`);

          let outroPromise = null; // 最後の曲の再生中に生成開始
          let _outroFirstPcmPromise = null; // アウトロ TTS 第1チャンクの先読み
          // 曲間トーク先頭文の PCM 先読み（前の曲の再生中に生成）
          // 曲が終了した瞬間に TTS が即再生できるよう、1文目だけ先行合成する
          let _nextBetweenFirstPcmPromise = null;

          for (let i = 0; i < trackTags.length; i++) {
            const tag = trackTags[i];

            // 前の曲の再生中に先読みした曲間トーク PCM を取り出す
            const _curBetweenFirstPcmP = _nextBetweenFirstPcmPromise;
            _nextBetweenFirstPcmPromise = null;

            // 2曲目以降: 前の曲が終わったあと、次の曲のイントロを読む
            if (i > 0) {
              const betweenIntro = _trackSegments[i]?.intro || '';
              if (betweenIntro) {
                // 曲間トーク中は BGM を一時再開（音楽DJの紹介に BGM が流れるよう）
                // → auto-ducking で音楽DJ発話中は 15% に下がり、次の曲直前に再停止
                if (bgmFileToRestore) {
                  this.mixer.currentBgmVolume = 0;
                  this.mixer.targetBgmVolume  = 0;
                  this.mixer.playBgm(bgmFileToRestore);
                  this.mixer.setBgmVolumeTarget(1.0);
                }
                // 先読み PCM があれば渡して 1文目の遅延をゼロにする
                const _betweenPreloadedPcm = _curBetweenFirstPcmP ? (await _curBetweenFirstPcmP) : null;
                await this.speakText(betweenIntro, 'music_dj', _betweenPreloadedPcm, { expectedGen: _myGen });
                // 次の曲を再生する直前に再度 BGM 停止
                this.mixer.stopBgm();
              }
            }

            try {
              const track = resolvedTracks[i];
              if (!track?.uri) {
                getLogger().warn(`[Music] トラック URI 取得失敗: ${tag}`);
                // ── 再生失敗でも履歴に追加 → 次回同じ曲が繰り返し選ばれるのを防ぐ ──
                const _failParts = tag.includes('/') ? tag.split('/').map(s => s.trim()) : [null, tag.trim()];
                const _failArtist = _failParts[0] || '';
                const _failName   = (_failParts[1] || _failParts[0] || tag).trim();
                if (_failName) {
                  this._recentlyPlayedTracks.unshift({
                    artist: _failArtist, name: _failName,
                    playedAt: new Date().toISOString(), playFailed: true,
                  });
                  if (this._recentlyPlayedTracks.length > PLAYED_TRACKS_MAX) this._recentlyPlayedTracks.pop();
                  this._savePlayedHistory();
                }
                // 最後のトラックが失敗した場合でもアウトロを生成（音楽DJが謝るセリフ）
                if (i === trackTags.length - 1 && outroPromise === null) {
                  const tagLabel = tag.includes('/') ? tag.split('/').reverse().join(' by ') : tag;
                  const outroCtxFail = `${baseContextPrompt}
【あなた（${_an.music_dj}）が紹介しようとした曲】${tagLabel}
Spotifyでこの曲を再生しようとしましたが、見つからず再生できませんでした。
申し訳なさそうに一言謝り、「以上、${_an.music_dj}がお届けしました！${_djCaster}、どうぞ！」で締めてください。
日本語で、ラジオで読み上げるテキストのみを出力してください。`;
                  outroPromise = this.generateAgentSpeech('music_dj', outroCtxFail, false, 'light');
                }
                continue;
              }
              getLogger().info(`[Music] 再生 (${i + 1}/${trackTags.length}): ${track.artist} — ${track.name}${track.isFallback ? ` [フォールバック: 元リクエスト「${track.originalTitle}」]` : ''}`);
              // フォールバック曲の場合は音楽DJが一言アナウンス
              if (track.isFallback && track.originalTitle) {
                const fallbackLines = [
                  `あ、ごめんなさい！「${track.originalTitle}」が見つからへんかった〜。代わりに同じアーティストの「${track.name}」かけちゃいますね！`,
                  `ちょっとごめんね！「${track.originalTitle}」がちょっと取れへんかってん。でも「${track.name}」もめっちゃええ曲やから聴いてみて！`,
                  `すんません、「${track.originalTitle}」が見つからなかったんやけど、「${track.name}」でいかがでしょう！きっと気に入ってもらえるはず！`,
                ];
                const fallbackLine = fallbackLines[Math.floor(Math.random() * fallbackLines.length)];
                await this.speakText(fallbackLine, 'music_dj', null, { expectedGen: _myGen });
              }
              const fullDurationMs = track.duration_ms || 240000;
              const waitTimeoutMs  = fullDurationMs + 30000;

              this._broadcast({
                event:    'SPOTIFY_PLAY',
                uri:      track.uri,
                title:    track.name,
                artist:   track.artist,
                durationMs: fullDurationMs,
              });
              this._broadcast({ event: 'MUSIC_PLAY_START', mode: 'spotify_sdk', title: track.name, artist: track.artist, meta: track.meta || {} });

              // ── 再生開始時点で履歴に仮登録（サーバー再起動時の抜け落ちを防ぐ）──
              // 再生完了後に改めて登録するが、万一再起動しても記録が残るよう先に保存する
              this._recentlyPlayedTracks.unshift({ artist: track.artist, name: track.name, playedAt: new Date().toISOString() });
              if (this._recentlyPlayedTracks.length > PLAYED_TRACKS_MAX) this._recentlyPlayedTracks.pop();
              this._savePlayedHistory();

              // ── 曲間トーク TTS 先読み（再生と並行して次の曲間トーク 1 文目を合成）──
              // 曲が終わった瞬間に TTS 済み PCM があれば沈黙ゼロで発話できる
              if (i < trackTags.length - 1) {
                const _nextBetweenText = _trackSegments[i + 1]?.intro || '';
                if (_nextBetweenText) {
                  const _djTtsCfg = (this.getConfig().agents?.['music_dj']) || {};
                  const _djGemini = (_djTtsCfg.tts_engine || 'gemini') === 'gemini';
                  const _nextBetweenSentences = _djGemini
                    ? this._splitTextToSentencesGemini(_nextBetweenText)
                    : this._splitTextToSentences(_nextBetweenText);
                  // [PAUSE:N] 以外の最初のテキスト文を探して先合成
                  const _firstNonPause = _nextBetweenSentences.find(s => !/^\[PAUSE:\d+\]$/.test(s));
                  if (_firstNonPause) {
                    _nextBetweenFirstPcmPromise = this._collectPcm(_firstNonPause, 'music_dj').catch(() => null);
                    getLogger().debug(`[Pipeline] music_dj 曲間トーク先読み開始: "${_firstNonPause.slice(0, 20)}…"`);
                  }
                }
              }

              // 最後の曲のときだけ並行してアウトロを生成（曲終了後の沈黙を短縮）
              if (i === trackTags.length - 1) {
                const _playedForOutro = resolvedTracks
                  .filter(t => t?.uri)
                  .map(t => t.isFallback && t.originalTitle
                    ? `「${t.name}」（${t.artist}）※「${t.originalTitle}」の代わり`
                    : `「${t.name}」（${t.artist}）`);
                const _outroPlayedLine = _playedForOutro.length > 0
                  ? `\n【🎵 実際に流れた曲】${_playedForOutro.join('、')}\n⚠️ アウトロは「実際に流れた曲」の余韻のみ語ること。流れていない別のアーティスト・別の曲名（話題の文脈で出てきたものを含む）には絶対に触れないこと。`
                  : '';
                const outroCtxEarly = `${baseContextPrompt}
【${_an.music_dj}が今日紹介した曲・内容】${musicDjMainText.slice(0, 400)}
${trackTags.length > 1 ? `計${trackTags.length}曲をお届けしました。` : ''}${_outroPlayedLine}
全曲が流れ終わりました。余韻を感じながら2〜3文でリアクションしてください。
最後は「以上、${_an.music_dj}がお届けしました！${_djCaster}、どうぞ！」で締めてください。
日本語で、ラジオで読み上げるテキストのみを出力してください。`;
                outroPromise = this.generateAgentSpeech('music_dj', outroCtxEarly, false, 'light');
                // アウトロテキスト確定後すぐ TTS 第1チャンクを先読み（曲中に完了させて沈黙をゼロ化）
                _outroFirstPcmPromise = outroPromise.then(async (text) => {
                  if (!text) return null;
                  const _djTtsCfg = (this.getConfig().agents?.['music_dj']) || {};
                  const _djGemini = (_djTtsCfg.tts_engine || 'gemini') === 'gemini';
                  const _sentences = _djGemini
                    ? this._splitTextToSentencesGemini(text)
                    : this._splitTextToSentences(text);
                  const _first = _sentences.find(s => !/^\[PAUSE:\d+\]$/.test(s));
                  if (!_first) return null;
                  return this._collectPcm(_first, 'music_dj').catch(() => null);
                });
              }

              await this._waitForSpotifyPlayDone(waitTimeoutMs);
              // 切断→再接続でセッション世代が変わっていたら、この古いコルーチンはここで
              // 完全に打ち切る。この待機は数分間サスペンドし続け、再接続時の
              // onClientConnected が解除するため、続行すると lastSpeech.music_dj_outro や
              // _postCornerExchange を前セッションの曲の内容で書き戻してしまい、
              // 新セッションの冒頭に前の曲への感想が流れる不具合の原因になっていた。
              if (_myGen !== this._speakGeneration) {
                getLogger().info('[Music] セッション世代が変わったため music_dj ステップを中断（切断→再接続）');
                return { actuallyPlayedCount: _actuallyPlayedCount, resolvedTracksForMeta: _resolvedTracksForMeta };
              }
              this._broadcast({ event: 'MUSIC_PLAY_END', title: track.name });
              _actuallyPlayedCount++;

              // アーティスト履歴を更新（曲履歴は再生開始時に仮登録済み — 重複なし）
              if (track.artist) {
                this._recentlyPlayedArtists = [track.artist, ...this._recentlyPlayedArtists.filter(a => a !== track.artist)].slice(0, PLAYED_ARTISTS_MAX);
              }
              this._savePlayedHistory();

            } catch (e) {
              getLogger().error(`[Music] Web Playback SDK 再生エラー (${tag}): ${e.message}`);
            }
          }

          // ── 全曲終了後: BGM再開 → アウトロ読み上げ ─────────────────────────
          getLogger().debug('[Duck] end music');
          await new Promise(r => setTimeout(r, 300));
          if (bgmFileToRestore) {
            getLogger().info(`[Music] BGM 再開: ${bgmFileToRestore}`);
            this.mixer.currentBgmVolume = 0;
            this.mixer.targetBgmVolume  = 0;
            this.mixer.playBgm(bgmFileToRestore);
          }
          if (outroPromise) {
            // アウトロテキスト + TTS 第1チャンクを両方回収（曲中に完了済みなら即時）
            const [outroText, outroFirstPcm] = await Promise.all([
              outroPromise,
              _outroFirstPcmPromise ?? Promise.resolve(null),
            ]);
            this.lastSpeech.music_dj_outro = outroText;
            // music_dj_max_react をアウトロ再生中に先行生成（再生後の待ち時間ゼロ化）
            // 実際に流れた曲（または再生失敗曲）を明示して LLM の幻覚を防ぐ
            const _reactTrack = _actuallyPlayedCount > 0 ? this._recentlyPlayedTracks[0] : null;
            const _reactTrackLine = _reactTrack
              ? `\n【🎵 今流れた曲】${_reactTrack.artist} — ${_reactTrack.name}\n⚠️ この曲名・アーティスト名を正しく使うこと。他のアーティストや曲名は絶対に言わないこと。`
              : (trackTags.length > 0
                ? `\n【📢 流す予定だった曲（再生失敗）】${trackTags.map(t => { const p=t.split('/'); return p.length===2?`${p[1].trim()}（${p[0].trim()}）`:t; }).join('、')}\n再生できなかったことに一言触れてください。`
                : '');
            const _djMaxReactCtxSpotify = `${baseContextPrompt}
【${_an.music_dj}の発言（要約）】${outroText.slice(0, 300)}
${_reactTrackLine}
⚠️【自己言及の禁止】あなたは${_an.caster}です。自分自身のことは一人称で言い換えてください。自分を三人称（「${_an.caster}さん」）で呼ぶのは禁止です。

${_an.music_dj}の音楽・エンタメ情報を受けて1〜2文で明るくリアクションしてください。曲やアーティストへの素直な感想か、気になった情報への一言。楽しそうに短く。`;
            this._prefetchedSpeech = this._buildPrefetchedSpeech('music_dj_max_react', this.generateAgentSpeech('caster', _djMaxReactCtxSpotify), 'caster');
            getLogger().debug('[Pipeline] music_dj max_react 先読み開始 (アウトロ再生中)');
            // holdDuckMs: max_react へのギャップ中もBGMを維持
            await this.speakText(outroText, 'music_dj', outroFirstPcm, { holdDuckMs: 400, expectedGen: _myGen });
          }

        } else {
          // ── ダミーモード（Spotify 未設定 or タグなし）────────────────────
          getLogger().debug(`[Music] ダミーモード — ${spotifyReady ? 'タグなし' : 'Spotify 未設定'}（${dummyDurationMs}ms）`);
          // ダミーモードはアウトロを音楽と並行生成
          const dummyOutroCtx = `${baseContextPrompt}
【あなた（${_an.music_dj}）が今紹介した曲・内容】${musicDjMainText.slice(0, 300)}
曲が流れ終わりました。曲の余韻を感じながら2〜3文でリアクションしてください。
最後は「以上、${_an.music_dj}がお届けしました！${_djCaster}、どうぞ！」で締めてください。
日本語で、ラジオで読み上げるテキストのみを出力してください。`;
          const dummyOutroPromise = this.generateAgentSpeech('music_dj', dummyOutroCtx, false, 'light');
          this._broadcast({ event: 'MUSIC_PLAY_START', mode: 'dummy', title: '（曲名不明）', songCount: estimatedSongCount });
          await new Promise(r => setTimeout(r, dummyDurationMs));
          this._broadcast({ event: 'MUSIC_PLAY_END', title: '' });
          const dummyOutroText = await dummyOutroPromise;
          this.lastSpeech.music_dj_outro = dummyOutroText;
          // music_dj_max_react をアウトロ再生中に先行生成（再生後の待ち時間ゼロ化）
          const _djMaxReactCtxDummy = `${baseContextPrompt}
【${_an.music_dj}の発言（要約）】${dummyOutroText.slice(0, 300)}

⚠️【自己言及の禁止】あなたは${_an.caster}です。自分自身のことは一人称で言い換えてください。自分を三人称（「${_an.caster}さん」）で呼ぶのは禁止です。

${_an.music_dj}の音楽・エンタメ情報を受けて1〜2文で明るくリアクションしてください。曲やアーティストへの素直な感想か、気になった情報への一言。楽しそうに短く。`;
          this._prefetchedSpeech = this._buildPrefetchedSpeech('music_dj_max_react', this.generateAgentSpeech('caster', _djMaxReactCtxDummy), 'caster');
          getLogger().debug('[Pipeline] music_dj max_react 先読み開始 (ダミーアウトロ再生中)');
          // holdDuckMs: max_react へのギャップ中もBGMを維持
          await this.speakText(dummyOutroText, 'music_dj', null, { holdDuckMs: 400, expectedGen: _myGen });
        }

    return { actuallyPlayedCount: _actuallyPlayedCount, resolvedTracksForMeta: _resolvedTracksForMeta };
  }

  // ─── runSingleShowStep: 生活アドバイザーコーナー ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runLifeAdvisorStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        // ━━ 生活アドバイザー 生活アドバイザーコーナー ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 2フェーズ発話（commentator / journalist / music_dj と同じ構造）:
        //   Phase 1 「ちょっと調べますね！少しだけ待っておくんなまし！」（検索なし・高速）
        //            → TTS再生しながら Phase 2 の Google Search が走る
        //   Phase 2  料理レシピ・健康・生活アドバイス（Google Search グラウンディング使用）
        this.currentState = 'TALKING_LIFE_ADVISOR';
        this._broadcast({ event: 'CORNER_START', name: `${_an.life_advisor}の生活アドバイス` });

        if (this._prefetchedSpeech?.key === 'life_advisor') this._prefetchedSpeech = null;
        if (this._prefetchedCornerSpeech?.key === 'life_advisor') this._prefetchedCornerSpeech = null;
        const laMcQuestion = this.lastSpeech.caster || null;
        const _laCaster = (config.agents?.caster?.name) || 'MAX';
        getLogger().debug(`[LifeAdvisor] MCのリクエスト: ${laMcQuestion ? laMcQuestion.slice(0, 60) + '…' : '(なし)'}`);

        // リスナーリクエストがあれば消費（prefetch はスキップ）
        const _laTopicReq = this.pendingLifeAdvisorRequest;
        this.pendingLifeAdvisorRequest = null;
        if (_laTopicReq) {
          getLogger().info(`[LifeAdvisor] リスナーリクエスト: topic="${_laTopicReq.topic || 'none'}"`);
        }

        // Phase 1 先読みキャッシュを _prefetchConvCorner クリア前に取得
        const _cachedPhase1La = (this._prefetchConvCorner?.key === 'life_advisor' && !_laTopicReq)
          ? this._prefetchConvCorner.phase1Promise : null;

        // Phase 1 生成：先読みキャッシュがあれば使用（キャスター 発話中に完了済み）、なければ即座に開始
        // プロンプトの組み立ては _buildPhase1PreContext() に集約してある（先読み側と共通）
        const laPreCtx = this._buildPhase1PreContext('life_advisor', baseContextPrompt, laMcQuestion, _laCaster, _an);
        const laPrePromise = _cachedPhase1La
          ? (_cachedPhase1La.then(t => { getLogger().debug('[Pipeline] life_advisor Phase 1 先読みヒット'); return t; }))
          : this.generateAgentSpeech('life_advisor', laPreCtx, false, 'light');

        // Phase 2: リスナーリクエストがある場合は prefetch スキップ、なければ先読みを活用
        let laCtxWithQ;
        if (this._prefetchConvCorner?.key === 'life_advisor' && !_laTopicReq) {
          getLogger().debug('[Pipeline] life_advisor: 先読みコンテキスト使用');
          laCtxWithQ = await this._prefetchConvCorner.contextPromise;
          this._prefetchConvCorner = null;
        } else {
          if (this._prefetchConvCorner?.key === 'life_advisor') this._prefetchConvCorner = null;
          laCtxWithQ = await this._buildCornerContext('life_advisor', baseContextPrompt, laMcQuestion, _laTopicReq);
        }
        // 先読みコンテキストが null/undefined になった場合はフォールバック
        if (!laCtxWithQ) {
          getLogger().warn('[LifeAdvisor] 先読みコンテキストが空 → フォールバック再構築');
          laCtxWithQ = await this._buildCornerContext('life_advisor', baseContextPrompt, laMcQuestion, _laTopicReq);
        }
        const _laSearchOverride = _laTopicReq?.rawText ? true : null;
        const laMainPromise = this.generateAgentSpeech('life_advisor', laCtxWithQ, _laSearchOverride);

        // Phase 1 読み上げ（この間に Phase 2 の Google Search が進む）
        // セーフティネット: LLM がプロンプト禁止を無視して「どうぞ」を末尾に付けた場合に削除
        const laPreText = this._stripHandoffPhrase(await laPrePromise, _an.caster);
        this.lastSpeech.life_advisor_pre = laPreText;
        await this.speakText(laPreText, 'life_advisor', null, { expectedGen: _myGen });

        // Phase 2: メインアドバイス（Phase 1 再生中に Google Search + Gemini が進む）
        let laMainText = this._truncateAtEndMarker(
          await laMainPromise,
          [`${_laCaster}、どうぞ！`, `${_laCaster}、どうぞ`, `はい、${_laCaster}`, 'スタジオへどうぞ！', 'スタジオへどうぞ', 'スタジオにお返しします'],
          'LifeAdvisor'
        );

        // Phase 2 が空になった場合（API エラー・検索失敗・chain-of-thought除去等）はリトライ
        // ⚠️ リトライは必ず Google Search 無効（false）で再生成する
        //   理由: chunks=0 で初回が空になったケースでも search=false なら安定生成できる
        //         search=null（Gemini に委任）では再度同じ現象が起きるリスクがある
        //         また search=false は ~2秒 で完了するため無音ギャップを最小化できる
        if (!laMainText || laMainText.trim() === '') {
          getLogger().warn('[LifeAdvisor] Phase2 が空 → 検索なし（false）で再生成を試みます');
          const _laRetryCtx = await this._buildCornerContext('life_advisor', baseContextPrompt, laMcQuestion, _laTopicReq);
          laMainText = this._truncateAtEndMarker(
            await this.generateAgentSpeech('life_advisor', _laRetryCtx, false, 'light'), // 検索なし → ~2秒で完了
            [`${_laCaster}、どうぞ！`, `${_laCaster}、どうぞ`, `はい、${_laCaster}`, 'スタジオへどうぞ！', 'スタジオへどうぞ', 'スタジオにお返しします'],
            'LifeAdvisor-retry'
          );
          if (!laMainText || laMainText.trim() === '') {
            // 再試行も失敗した場合はオフラインモック
            getLogger().error('[LifeAdvisor] Phase2 再生成も失敗 → オフラインモックを使用');
            laMainText = this.getOfflineMockDialog('life_advisor');
          }
        }

        this.lastSpeech.life_advisor = laMainText;
        this._pushRecentCornerContent('life_advisor', _an.life_advisor, laMainText);

        // ── レシピ検出 & InfoView 表示（非同期・speakText をブロックしない） ──
        // _recipeNamePromise: 抽出した正式な料理名を後段の重複防止履歴記録でも使うため保持しておく
        const _isRecipeLikely = /レシピ|材料(?!費)|手順|作り方|つくり方|大さじ|小さじ|[0-9]+\s*g[^ラ]|[0-9]+\s*ml|炒め|煮る|焼く|混ぜる/.test(laMainText);
        let _recipeNamePromise = null;
        if (_isRecipeLikely) {
          _recipeNamePromise = (async () => {
            try {
              const _recipeExtractPrompt = `以下のラジオ音声テキストから料理レシピ情報を抽出し、JSONのみ返してください。
レシピでない場合: {"isRecipe":false}
レシピの場合: {"isRecipe":true,"name":"料理名","description":"一言説明（30文字以内）","ingredients":["材料1 量","材料2 量"],"steps":["手順1","手順2"]}
⚠️【重要】各文字列内に改行文字を含めないでください。配列の各要素は1行の文字列にしてください。
材料・手順はラジオテキストそのままを抜粋してください。

ラジオテキスト:
${laMainText}`;
              const _recipeRaw = await this._callGeminiRaw(_recipeExtractPrompt, 'light');
              const _match = (_recipeRaw || '').match(/\{[\s\S]*\}/);
              if (!_match) return null;
              // LLMが文字列内に改行を含めることがあるため、解析前に正規化する
              const _cleanedJson = _match[0].replace(/\n/g, ' ').replace(/\r/g, '');
              const _recipe = JSON.parse(_cleanedJson);
              if (!_recipe?.isRecipe) return null;

              getLogger().info(`[LifeAdvisor] レシピ検出: "${_recipe.name}"`);
              const _recipePayload = {
                name: _recipe.name || '',
                description: _recipe.description || '',
                ingredients: _recipe.ingredients || [],
                steps: _recipe.steps || [],
              };

              // テキストのみで即時broadcast
              this._broadcast({ event: 'INFOVIEW_DATA', type: 'recipe', ...(_recipePayload), imageBase64: null });

              // 画像生成は名前解決をブロックしないよう fire-and-forget で実行
              this._callGeminiWithImage(
                `料理の完成写真を生成してください。料理名: ${_recipe.name}。${_recipe.description ? '説明: ' + _recipe.description + '。' : ''}プロの料理写真風、美しい盛り付け、食欲をそそる自然光。`,
                'life_advisor'
              ).then(_imgResult => {
                if (_imgResult) {
                  this._broadcast({ event: 'INFOVIEW_DATA', type: 'recipe', ...(_recipePayload), imageBase64: _imgResult.imageBase64, imageMimeType: _imgResult.mimeType });
                  getLogger().info(`[LifeAdvisor] レシピ画像 broadcast 完了: "${_recipe.name}"`);
                }
              }).catch(e => getLogger().warn(`[LifeAdvisor] レシピ画像生成エラー: ${e.message}`));

              return _recipe.name || null;
            } catch (e) {
              getLogger().warn(`[LifeAdvisor] レシピ抽出エラー: ${e.message}`);
              return null;
            }
          })();
        }
        // ── /レシピ検出 ────────────────────────────────────────────────────────

        // ── パイプライン: 次のCaster(turn=0)を先行生成 ──
        const claraLastLA = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        const laAdviseSummary = laMainText.slice(0, 150);
        const casterAfterLACtx = `${baseContextPrompt}
【${_an.life_advisor}が今アドバイスした内容】${laAdviseSummary}
${_an.life_advisor}の生活アドバイスコーナーが終わりました。アドバイスの内容を受けて一言感想・リアクションを述べ、
${_an.assistant}に「どう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。${_an.life_advisor}さんのアドバイス内容への具体的リアクションから始めてください。${claraLastLA}`;
        // life_advisor_max_react を Phase 2 再生中に先行生成（再生後の待ち時間ゼロ化）
        const _laMaxReactCtx = `${baseContextPrompt}
【${_an.life_advisor}の発言（要約）】${laMainText.slice(0, 300)}

⚠️【自己言及の禁止】あなたは${_an.caster}です。自分自身のことは一人称で言い換えてください。自分を三人称（「${_an.caster}さん」）で呼ぶのは禁止です。

${_an.life_advisor}のアドバイスを受けて1〜2文でリアクションしてください。「さっそく試してみます！」など素直な反応か、お礼・共感の一言で温かく締めて。`;
        this._prefetchedSpeech = this._buildPrefetchedSpeech('life_advisor_max_react', this.generateAgentSpeech('caster', _laMaxReactCtx), 'caster');
        getLogger().debug('[Pipeline] life_advisor max_react 先読み開始 (Phase 2 再生中)');
        // caster_turn0 は guest_reply 後に使用（_savedCasterTurn0 に退避）
        // ※ _prefetchedSpeech は life_advisor_max_react が占有しているため上書きしない
        this._savedCasterTurn0 = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterAfterLACtx), 'caster');

        // holdDuckMs: max_react へのギャップ中もBGMを維持
        await this.speakText(laMainText, 'life_advisor', null, { holdDuckMs: 400, expectedGen: _myGen });

        // 今回のトピックを記録（永続化 + 直近セッション両方に追加）
        // laMcQuestion はキャスターのセリフ全文なので、「生活アドバイザーさん！」以降の依頼部分のみ抽出する
        const _extractLaTopic = (mcQ, mainText) => {
          if (mcQ) {
            // 「生活アドバイザーさん」以降の実際の依頼内容を取得（最大60文字）
            const m = mcQ.match(new RegExp(`${_an.life_advisor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[！!。]?\\s*(.+)`, 's'));
            if (m) return m[1].replace(/[\n\r]+/g, ' ').slice(0, 60).trim();
          }
          // フォールバック: 生活アドバイザーのセリフ先頭60文字
          if (mainText) return mainText.replace(/[\n\r]+/g, ' ').slice(0, 60).trim();
          return null;
        };
        let _laTopicToRecord = _extractLaTopic(laMcQuestion, laMainText);
        // レシピの場合は冒頭60文字（毎回違う掛け声で始まり料理名を含まないことが多い）より
        // 抽出された正式な料理名のほうが重複防止の精度が高いため、取得できればそちらを優先する。
        // speakText 再生（数十秒）の間に抽出は完了しているはずなので、ここでの await は実質ノーコスト。
        if (_recipeNamePromise) {
          try {
            const _extractedRecipeName = await _recipeNamePromise;
            if (_extractedRecipeName) _laTopicToRecord = _extractedRecipeName;
          } catch (_) { /* 抽出失敗時はフォールバックのトピックをそのまま使う */ }
        }
        if (_laTopicToRecord) {
          // セッション内直近5件
          this._recentTopics = [_laTopicToRecord, ...this._recentTopics].slice(0, 5);
          // speech: 生活アドバイザーが実際に話した内容の先頭（食材・料理名レベルの重複防止に使用）
          const _laSpeechPreview = laMainText
            ? laMainText.replace(/[\n\r]+/g, ' ').slice(0, 80).trim()
            : null;
          // 永続化履歴（最大30件・リブート後も継続）
          this._lifeAdvisorHistory = [
            {
              topic: _laTopicToRecord,
              category: this._laCurrentThemeKey || null, // ← テーマカテゴリーキーを記録
              speech: _laSpeechPreview,
              introducedAt: new Date().toISOString(),
            },
            ...this._lifeAdvisorHistory.filter(h => h.topic !== _laTopicToRecord),
          ].slice(0, LA_HISTORY_MAX);
          this._laCurrentThemeKey = null; // 記録完了後リセット
          this._saveLifeAdvisorHistory();
          getLogger().info(`[LifeAdvisorHistory] 記録: "${_laTopicToRecord.slice(0, 50)}" category=${this._lifeAdvisorHistory[0]?.category} (計${this._lifeAdvisorHistory.length}件)`);
        }
        this._recordCornerPlayed('life_advisor');
        this._writeDiaryReflection('life_advisor', _an.life_advisor, laMainText).catch(() => {});
        this._postCornerExchange = { corner: 'life_advisor', phase: 'max_react' };
        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);

      
  }

  // ─── runSingleShowStep: 各センターコーナー（天気/交通/ニュース/金融） ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runCenterCornerStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        const centerKey = this.currentTokenHolder;
        getLogger().info(`[Corner] コーナー開始: ${centerKey} (prefetchKey=${this._prefetchedSpeech?.key ?? 'none'})`);
        this.currentState = `TALKING_${centerKey.toUpperCase()}`;

        const cornerDisplayNames = {
          weather:      'お天気コーナー',
          traffic:      '交通情報コーナー',
          news:         'ニュースコーナー',
          finance:      '金融情報コーナー',
          commentator:  `${_an.commentator}のコメント`,
          journalist:   `${_an.journalist}のコメント`,
          music_dj:     `${_an.music_dj}の音楽・エンタメコーナー`,
          life_advisor: `${_an.life_advisor}の生活アドバイス`,
        };
        // コーナー担当者の名前（キャスターが「〇〇さん、ありがとう」と言うときに使う）
        const cornerAgentNames = {
          weather:      '気象情報センター',
          traffic:      '交通情報センター',
          news:         '報道センター',
          finance:      '金融情報センター',
          commentator:  _an.commentator,
          journalist:   _an.journalist,
          music_dj:     _an.music_dj,
          life_advisor: _an.life_advisor,
        };
        const cornerAgentName = cornerAgentNames[centerKey] || cornerDisplayNames[centerKey];

        // ── ティッカーデータ組み立て ──────────────────────────────────────────
        let _tickerPayload = null;
        if (centerKey === 'finance' && this.financeService.cache.structured?.length) {
          _tickerPayload = { type: 'finance', items: this.financeService.cache.structured };
        } else if (centerKey === 'weather' && this.weatherService.cache.structured) {
          _tickerPayload = { type: 'weather', ...this.weatherService.cache.structured };
        } else if (centerKey === 'news' && this.newsService.cache.structured?.length) {
          _tickerPayload = { type: 'news', items: this.newsService.cache.structured };
        } else if (centerKey === 'traffic') {
          const _tProf = (this.getConfig().show?.user_profile) || {};
          const { location: _tLoc } = this._getEffectiveLocation();
          const _tAreas    = (_tProf.traffic_areas?.length > 0) ? _tProf.traffic_areas : ['首都高速'];
          const _tStation  = _tProf.nearest_station || '';
          const _tAirports = (_tProf.airports?.length > 0)
            ? _tProf.airports : ['羽田空港（HND）', '成田国際空港（NRT）'];
          _tickerPayload = { type: 'traffic', location: _tLoc, areas: _tAreas, nearestStation: _tStation, airports: _tAirports };
        }

        this._broadcast({
          event:  'CORNER_START',
          name:   cornerDisplayNames[centerKey],
          ticker: _tickerPayload,
        });

        // ── スティンガージングル再生（assets/bgm/corner/ に MP3 があれば）──
        // 先読みがまだ完了していない場合の待ち時間をジングルで自然に埋める
        const cornerJingleDir = path.join(__dirname, 'assets', 'bgm', 'corner');
        const hasCornerJingle = fs.existsSync(cornerJingleDir) &&
          fs.readdirSync(cornerJingleDir).some(f => f.endsWith('.mp3'));

        // 先読みキャッシュ確認（Caster発話中にデータ取得＋生成が完了しているはず）
        let text;
        // テキストが解決した瞬間に 1 文目 TTS 合成を開始する Promise
        // → ジングル再生中（3秒）に TTS が完了するので、ジングル後に即発話できる
        let _cornerFirstPcmPromise = null;

        // テキスト Promise から 1 文目 TTS Promise を派生させるヘルパー
        // speakText と同じ分割ロジックを使わないと preloadedFirstPcm が別テキストのPCMになりコンテンツ欠落が生じる
        const _cAgentCfg = (this.getConfig().agents?.[centerKey]) || {};
        const _cGemini = (_cAgentCfg.tts_engine || 'gemini') === 'gemini';
        const _chainFirstPcm = (textP) => textP.then(t => {
          if (!t) return null;
          const sents = _cGemini
            ? this._splitTextToSentencesGemini(t)
            : this._splitTextToSentences(t);
          const firstNonPause = sents.find(s => !/^\[PAUSE:\d+\]$/.test(s));
          return firstNonPause
            ? this._collectPcm(firstNonPause, centerKey).catch(() => null)
            : null;
        });

        if (this._prefetchedSpeech?.key === centerKey) {
          // ジングルと並行して awaiting（ジングル中に完了するはずなので実質ゼロ待ち）
          const speechPromise = this._prefetchedSpeech.promise;
          this._prefetchedSpeech = null;
          // テキストが解決した瞬間に 1 文目 TTS を開始（ジングル中に並行合成）
          _cornerFirstPcmPromise = _chainFirstPcm(speechPromise);
          getLogger().info(`[Corner] ${centerKey}: 先読みキャッシュ使用 — セリフ待機中`);
          if (hasCornerJingle) {
            const [resolvedText] = await Promise.all([
              speechPromise,
              this.mixer.playJingle(cornerJingleDir, { fadeInMs: 200, playDurationMs: 3000, fadeOutMs: 500 }),
            ]);
            text = resolvedText;
          } else {
            text = await speechPromise;
          }
          // 先読みキャッシュが空だった場合はキャッシュをクリアして再生成
          if (!text) {
            getLogger().warn(`[Corner] ${centerKey}: 先読みキャッシュが空 → キャッシュクリアして再生成`);
            delete this._cornerSpeechCache[centerKey];
            text = await this._generateCornerSpeech(centerKey, baseContextPrompt);
            _cornerFirstPcmPromise = null; // 先読み PCM は無効
          }
        } else {
          // フォールバック: キャッシュなしで通常生成（ジングルを先に流して待つ）
          getLogger().info(`[Corner] ${centerKey}: 先読みキャッシュなし — フォールバック生成`);
          const cornerSpeechPromise = this._generateCornerSpeech(centerKey, baseContextPrompt);
          // テキストが解決した瞬間に 1 文目 TTS を開始（ジングル残余 or 生成完了後に並行合成）
          _cornerFirstPcmPromise = _chainFirstPcm(cornerSpeechPromise);
          if (hasCornerJingle) {
            await this.mixer.playJingle(cornerJingleDir, { fadeInMs: 200, playDurationMs: 3000, fadeOutMs: 500 });
          }
          text = await cornerSpeechPromise;
        }
        this.lastSpeech[centerKey] = text;
        this._pushRecentCornerContent(centerKey, cornerAgentNames[centerKey] || centerKey, text);
        getLogger().info(`[Corner] ${centerKey}: セリフ取得完了 (${text ? text.length : 0}文字), speakText開始`);

        // 交通コーナー: 発話テキストから道路・鉄道・航空を構造抽出してティッカーに反映
        // await しない（TTS 発話と並行して実行）
        if (centerKey === 'traffic' && text) {
          const _clean = text.replace(/\[PAUSE:\d+\]/g, '').trim();
          (async () => {
            try {
              const _extractPrompt = `以下の交通情報アナウンスから、ティッカー表示用の簡潔な情報を抽出してください。

【除外するもの（絶対に含めない）】
- 人名・呼びかけ（リスナーの名前や「皆さん」など）
- 挨拶・締め言葉（「おはようございます」「以上」「交通情報センターの〇〇でした」など）
- 感想・コメント（「渋滞が多い朝となっています」のような総評）

【抽出対象】
- 道路: 具体的な路線名＋状況（渋滞・事故・規制・平常など）
- 鉄道: 路線名＋状況（遅延・運休・平常運転など）
- 航空: 空港名＋状況（欠航・遅延・平常など）

【出力形式】JSON のみ（説明・コメント不要）:
{"road":["首都高C1 渋滞10km","中央道 平常"],"rail":["中央線 平常","京王線 平常"],"air":["羽田 平常"]}
各項目は20文字以内。情報がない場合は空配列 []。

【アナウンス】
${_clean.slice(0, 1200)}`;

              const _result = await this._callGeminiRaw(_extractPrompt, 'light');
              getLogger().debug(`[Traffic Ticker] 抽出結果: ${(_result || '').slice(0, 200)}`);
              const _jsonMatch = (_result || '').match(/\{[\s\S]*?\}/);
              if (!_jsonMatch) {
                getLogger().warn('[Traffic Ticker] JSON が見つからず — フォールバックへ');
                throw new Error('no JSON');
              }
              const _data = JSON.parse(_jsonMatch[0]);
              const _items = [
                ...(_data.road || []).map(t => ({ category: 'road', text: String(t).slice(0, 25) })),
                ...(_data.rail || []).map(t => ({ category: 'rail', text: String(t).slice(0, 25) })),
                ...(_data.air  || []).map(t => ({ category: 'air',  text: String(t).slice(0, 25) })),
              ];
              if (_items.length > 0) {
                getLogger().info(`[Traffic Ticker] 構造化抽出成功: road=${(_data.road||[]).length} rail=${(_data.rail||[]).length} air=${(_data.air||[]).length}`);
                this._broadcast({ event: 'TICKER_UPDATE', ticker: { type: 'traffic_structured', items: _items } });
              } else {
                getLogger().warn('[Traffic Ticker] 抽出アイテム0件 — フォールバックへ');
                throw new Error('empty items');
              }
            } catch (_e) {
              getLogger().warn(`[Traffic Ticker] 構造化抽出エラー: ${_e?.message} — キーワード抽出にフォールバック`);
              // LLM障害時: 正規表現ベースのフォールバック抽出
              try {
                const _sentences = _clean.split(/[。！？\n]+/).map(s => s.trim()).filter(s => s.length > 4);
                const _roadKw  = /国道|県道|高速|道路|IC|JCT|渋滞|事故|規制|通行止|除雪|工事/;
                const _railKw  = /線|駅|電車|列車|遅延|運休|見合わせ|振替|平常運転/;
                const _airKw   = /空港|航空|フライト|欠航|遅延|搭乗|出発|到着/;
                const _skipKw  = /さん|皆さん|おはよう|こんにち|以上|でした|センター|お伝え|ご注意|お気をつけ|いただ/;
                const _fbItems = [];
                for (const _s of _sentences) {
                  if (_skipKw.test(_s)) continue;
                  if (_airKw.test(_s))       _fbItems.push({ category: 'air',  text: _s.slice(0, 25) });
                  else if (_railKw.test(_s)) _fbItems.push({ category: 'rail', text: _s.slice(0, 25) });
                  else if (_roadKw.test(_s)) _fbItems.push({ category: 'road', text: _s.slice(0, 25) });
                  if (_fbItems.length >= 8) break;
                }
                if (_fbItems.length > 0) {
                  this._broadcast({ event: 'TICKER_UPDATE', ticker: { type: 'traffic_structured', items: _fbItems } });
                }
              } catch (_e2) { /* サイレント */ }
            }
          })();
        }

        // ── パイプライン: コーナーが話している間に次のCaster(turn=0)書き出しを先行生成 ──
        // 直前コーナーの実際の発言内容をコンテキストに含めることで、MCが毎回同じ挨拶を
        // 繰り返すバグを防ぐ。コーナーの内容を踏まえた具体的なリアクション+話題展開を促す。
        const claraLast = this.lastSpeech.assistant
          ? `\n【${_an.assistant}の直前の発言】${this.lastSpeech.assistant}` : '';
        const _cornerSetupHint = (centerKey === 'news' || centerKey === 'finance')
          ? '\n【会話のヒント】今しがたニュース・金融情報をお届けしました。次のトークでは政治・経済・社会問題・金融に関連する話題を取り上げると番組の流れが自然になります。'
          : '';
        // コーナーの発言内容を先頭250文字要約として渡す（繰り返し防止の核心）
        const _cornerSpeechSummary = text
          ? `\n【先ほど放送した${cornerDisplayNames[centerKey]}の内容（要点）】${text.slice(0, 250)}`
          : '';
        const casterNextCtx = `${contextPrompt}
あなたは${_an.assistant}と軽快なトークをしながら番組を進行します。
先ほど【${cornerAgentName}】が${cornerDisplayNames[centerKey]}をお届けしました。
【⚠️ 重要】このコーナーの担当は「${cornerAgentName}」です。「${_an.assistant}さん」とは呼ばないでください。
コーナーへのお礼や感想を言う場合は必ず「${cornerAgentName}、ありがとう」「${cornerAgentName}でした」のように正しい名前を使ってください。
コーナーの内容を受けて一言感想やリアクションを述べてから、新しいトピックを1つ話し、${_an.assistant}（アシスタント）に「${_an.assistant}さんはどう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。コーナー内容への具体的リアクションから始めてください。${claraLast}${_cornerSetupHint}${_cornerSpeechSummary}`;
        // ATTENTION: どの経路から入っても必ず先読みすること。先読みの無い経路が残ると、
        //            そこだけ発話の冒頭に無音が生じる。
        const _preparedDiscussion = this._prepareDiscussionAfterCorner(centerKey, text, ctx);
        if (!_preparedDiscussion) {
          this._prefetchedSpeech = this._buildPrefetchedSpeech('caster_turn0', this.generateAgentSpeech('caster', casterNextCtx), 'caster');
        }

        // 1 文目 TTS 先読みを待つ（ジングル中に完了しているはず → 実質ゼロ待ち）
        const _cornerPreloadedPcm = _cornerFirstPcmPromise ? (await _cornerFirstPcmPromise) : null;
        if (_cornerPreloadedPcm) getLogger().debug(`[Pipeline] ${centerKey}: 1文目TTS先読みヒット → 即発話`);
        await this.speakText(text, centerKey, _cornerPreloadedPcm, { expectedGen: _myGen });
        getLogger().info(`[Corner] ${centerKey}: speakText完了`);

        // BUGFIX: 読み上げ中に切断されると音声は途中で戻ってくるが、そのまま後続の処理へ進むと、
        //         誰も聴いていないのに次のコーナーへ進んでしまう。世代番号を見て打ち切ること。
        if (this._speakGeneration !== _myGen) {
          getLogger().info(`[Corner] ${centerKey}: 読み上げ中に番組が中断されたため、`
            + '後続の処理（コーナーの記録・日記・討論コーナー）は行いません');
          return;
        }

        // コーナー後はキャスターがアシスタントと新たな会話を始める（ターンリセット）
        this._recordCornerPlayed(centerKey);
        // 天気/交通/ニュース/金融も config.agents 側に個性ある人格（名前・口調）が設定されているため、
        // 他のコーナー担当と同様に日記を書かせる（config に名前が無い場合のみ汎用名称にフォールバック）。
        const _centerPersonaName = (config.agents?.[centerKey]?.name) || cornerAgentName;
        this._writeDiaryReflection(centerKey, _centerPersonaName, text).catch(() => {});

        // ── 討論コーナーの差し込み ──
        if (this._activatePreparedDiscussion(centerKey)) {
          this._scheduleNextStep(0, _myGen);
          return;
        }

        this.conversationTurn = 0;
        this.currentTokenHolder = 'caster';
        this._scheduleNextStep(0, _myGen);


  }

  // ─── runSingleShowStep: 音楽再生（Spotifyトラック）ステップ ───
  // 旧 runSingleShowStep のトークン分岐から一字一句そのまま移動（テンプレートリテラル内の
  // 字下げはプロンプト文字列の一部のため、本体のインデントは意図的に変更していない）。
  // ctx: runSingleShowStep の try プリアンブルで組み立てた共有ローカル値。
  async _runMusicPlaybackStep(ctx) {
    let { _myGen, config, _an, pendingInstruction, userProfile, username, birthday, dateObj,
          month, day, todayStr, birthdayMMDD, isBirthday, googleData, _effLocBase, _isTempStayBase,
          _tempStayBase, profileParts, baseContextPrompt, filteredCalendar, contextPrompt,
          cachedCorner, _effLoc, _isTempStay, _tempStay, _specialDates, _activeSpecial } = ctx;

        this.currentState = 'MUSIC';
        getLogger().info('[Autopilot] Starting Spotify music segment...');

        let searchWord = 'Happy Birthday';
        if (!isBirthday) {
          const playlist = ['Jazz Lo-Fi', 'Coffee Shop Music', 'The Beatles Yesterday', 'Lofi Hip Hop'];
          searchWord = playlist[Math.floor(Math.random() * playlist.length)];
        }

        const played = await this.playSpotifyTrack(searchWord);

        // 再生終了後に BGM_END をブロードキャスト
        // 音楽再生後は 音楽DJへトークンを渡して曲・エンタメの話題で盛り上げる
        const waitMs = played ? 33000 : 5000;
        this.showTimer = setTimeout(() => {
          if (this._speakGeneration !== _myGen) return;
          this._broadcast({ event: 'BGM_END' });
          this._recordCornerPlayed('music');
          this.currentTokenHolder = 'music_dj';
          this.runSingleShowStep();
        }, waitMs);
      
  }


  /**
   * WebSocket クライアントが接続したときにサーバーから呼び出す。
   * 待機モード中なら 5 秒タイマーをキャンセルして即座に番組を再開する。
   */
  onClientConnected() {
    if (!this.isLoopRunning) return;

    // 再接続時: 前セッションの残留 TTS 音声を即クリアして古いアナウンスが聞こえないようにする
    this.mixer.talkBuffer = Buffer.alloc(0);

    // ── Spotify 再生待機中なら即座に中断して番組を再開 ──────────────────────────
    // クライアント切断中に _waitForSpotifyPlayDone() が曲のフル尺（最大4分以上）待機し続ける問題を修正。
    // 新しいクライアントが接続した時点で「再生完了扱い」にして即時再開させる。
    if (this._spotifyPlayResolve) {
      getLogger().info('[Spotify] クライアント再接続 — Spotify 再生待機を中断して番組を即時再開します');
      clearTimeout(this._spotifyPlayTimer);
      const _resolve = this._spotifyPlayResolve;
      this._spotifyPlayResolve = null;
      this._spotifyPlayTimer   = null;
      _resolve(); // → music_dj コーナーの for ループが次のステップへ進む
    }

    // 再接続時: 前回の切断から一定時間経過していた場合はキャッシュをクリアして情報を刷新する
    // finance / weather / traffic など時刻依存のコーナーキャッシュが古くなっている場合に対処
    const _reconnectGap = this._lastClientDisconnectAt
      ? Date.now() - this._lastClientDisconnectAt
      : Infinity;
    const STALE_THRESHOLD = 30 * 60 * 1000; // 30分以上の離脱でキャッシュ全クリア
    if (_reconnectGap > STALE_THRESHOLD) {
      getLogger().info(`[Show] ${Math.round(_reconnectGap / 60000)}分ぶりの再接続 — コーナーキャッシュ・金融データキャッシュをクリア`);
      this._cornerSpeechCache = {};
      this.financeService.clear();
      this.weatherService.clear();
      this.newsService.clear();
    }

    if (this._waitingForClients) {
      if (this.showTimer) {
        clearTimeout(this.showTimer);
        this.showTimer = null;
      }
      this._waitingForClients = false;
      this._activitySessionId = activityDb.openSession('live');
      getLogger().info('[Show] 最初のリスナーが接続 — オープニングから番組を再開');
      // 切断時のリセット後に、切断中も生存していた非同期処理（コーナーのコルーチン等）が
      // _postCornerExchange・lastSpeech 等を書き戻している可能性があるため、
      // 新セッション開始の直前にもう一度まっさらにする（詳細は _resetSessionConversationState）。
      this._resetSessionConversationState('再接続');
      // ATTENTION: コーナーキューはセッションの状態を戻すときに消さないこと。消すと、次の接続で
      //            また本日最初のサイクル扱いになり、同じ並びが繰り返される。
      this._broadcastQueueUpdate();
      // BGM が停止しているため、オープニングシーケンスを再実行して挨拶 + BGM を再起動
      this.runOpeningSequence().catch(err => {
        getLogger().error('[AgentSystem] Opening sequence failed on reconnect, falling back:', err);
        this.mixer._volumeLocked = false;
        this._openingDone = true;
        this.mixer.startRegularBgm();
        this.mixer.setBgmVolumeTarget(1.0);
        this.currentTokenHolder = 'caster';
        this.runSingleShowStep();
      });
    }
  }

  /**
   * セッションをまたいで引き継いではいけない会話状態を一括リセットする。
   *
   * 呼び出しタイミングは2箇所:
   * 1. 全リスナー切断時（onClientDisconnected）— 前セッションの状態を持ち越さないため
   * 2. 再接続でオープニングを再開する直前（onClientConnected）— 切断後も生存していた
   *    非同期処理（speakText 中断後も続行するコーナーのコルーチン等）が切断「後」に
   *    _postCornerExchange・lastSpeech 等を書き戻すレースがあるため、開始直前にもう一度
   *    まっさらにする（実際に、切断中に完了した music_dj コルーチンの書き戻しが原因で
   *    新セッション冒頭に前の曲への感想が流れる不具合が発生した）
   *
   * 再生済み曲履歴（_recentlyPlayedTracks 等）は選曲の重複防止のため意図的に保持する。
   */
  _resetSessionConversationState(reason) {
    // ── コーナーキュー ──
    // 実行中/キュー済みのコーナーを引き継がない。再接続後は空の状態でオープニングから
    // 再開し、リスナーが必要なコーナーを改めてリクエストできるようにする。
    this.pendingCornerRequests  = [];
    this._nextCorner            = null;
    this._nextCornerFromRequest = false;

    // ── 会話状態 ──
    // 「コーナー後リアクション待ち」（_postCornerExchange の max_react）が残っていると、
    // 新セッションのオープニング直後に前の曲・コーナーへのリアクションが再生されてしまう。
    // 直前発言（lastSpeech）・会話ターンも前セッションの文脈を引きずるためまとめて破棄
    // （オープニングが新しい lastSpeech.caster を設定し直す）。
    this._postCornerExchange = null;
    // 討論コーナーの進行中に全リスナーが退出した場合、状態を残したままにすると新セッションの
    // オープニング直後に前の議論の途中から再開してしまう（_postCornerExchange と同じ理由）。
    this._discussionCorner   = null;
    this._pendingDiscussion  = null;
    this._savedCasterTurn0   = null;
    this.lastSpeech          = {};
    this.conversationTurn    = 0;
    this._chatTurnCount      = 0;

    // ── コーナー個別のトピックリクエスト ──
    // コーナーキューを引き継がない上記方針と同じ理由で新セッションへ引き継がない。
    this.pendingMusicRequest        = null;
    this.pendingNewsRequest         = null;
    this.pendingWeatherRequest      = null;
    this.pendingFinanceRequest      = null;
    this.pendingTrafficRequest      = null;
    this.pendingCommentatorRequest  = null;
    this.pendingJournalistRequest   = null;
    this.pendingLifeAdvisorRequest  = null;
    this.pendingLegalAdvisorRequest = null;
    this.pendingGuestAnalystRequests = { comedian: null, doctor: null, marketer: null };
    getLogger().debug(`[Show] コーナーキュー・会話状態をリセット（${reason}）`);
  }

  /**
   * WebSocket クライアントが切断したときにサーバーから呼び出す。
   * Spotify 待機中でも切断時刻を正しく記録するためのフック。
   */
  onClientDisconnected() {
    this._lastClientDisconnectAt = Date.now();
    getLogger().debug(`[Show] クライアント切断を記録 (${new Date(this._lastClientDisconnectAt).toLocaleTimeString('ja-JP')})`);

    // 残クライアント数を即確認し、ゼロなら長期記憶保存を今すぐ開始する。
    // runSingleShowStep が次の周回で気づくより先に _isShuttingDown=true をセットすることで、
    // Player の /api/status ポーリングが "ready: false" を正しく受け取れるようになる。
    const remaining = this.server.getClientCount ? this.server.getClientCount() : 0;
    if (remaining === 0 && !this._isShuttingDown) {
      activityDb.closeSession(this._activitySessionId);
      this._activitySessionId = null;

      // ── 競合状態修正: speakText を即中断し、再接続時に opening が必ず起動するよう保証 ──
      // runSingleShowStep が次の周回で _waitingForClients=true をセットするより先に
      // クライアントが再接続すると onClientConnected が _waitingForClients===false を見て
      // オープニングを起動せず古いアナウンスが流れ続けるバグへの対処。
      this._waitingForClients = true;
      this._speakGeneration++;   // 進行中の speakText をすべて中断
      this._prefetchedSpeech = null;
      this._prefetchedCornerSpeech = null;
      this._isShuttingDown = true;
      this.mixer.stopBgm(); // BGM プロセスを停止

      // キャスター・アシスタントの「番組終了」日記は runEndingSequence（明示的な /api/show/end のみ発火・
      // 24時間運用では滅多に呼ばれない）だけでなく、実際に頻繁に起きる「全リスナー退出」も
      // セッションの区切りとして記録する（Classic/Jazz/Mood/Beatles の
      // _handleSessionShutdown と同じ考え方）。_resetSessionConversationState が
      // lastSpeech を空にしてしまう直前、まだ値が残っているうちに読む。
      const _casterNameDc = (this.getConfig().agents?.caster?.name) || 'MAX';
      const _asstNameDc   = (this.getConfig().agents?.assistant?.name) || 'Clara（アシスタント）';
      this._flushMaxClaraDiary('caster', _casterNameDc, this.lastSpeech.caster).catch(() => {});
      this._flushMaxClaraDiary('assistant', _asstNameDc, this.lastSpeech.assistant).catch(() => {});
      this._writeDirectorSessionSummaryDiary().catch(() => {});

      // コーナーキュー・会話状態をリセット（詳細は _resetSessionConversationState 参照）
      this._resetSessionConversationState('切断');
      getLogger().info('[Memory] クライアント切断を検知 — セッション要約を生成中...');
      this._generateSessionSummary().then(async s => {
        if (s) {
          await this._saveSessionSummary(s);
          this._loadLongTermMemory();
        }
      }).catch(e => {
        getLogger().warn('[Memory] 切断時の要約生成失敗: ' + e.message);
      }).finally(() => {
        this._isShuttingDown = false;
        getLogger().info('[Show] 終了処理完了 — 新規接続を受け付けます');
      });
    }
  }

  /**
   * リスナーからのコーナーリクエストを受け付ける。
   * 現在の発話が終わった次の キャスター ターンで優先的に処理される。
   * @param {'weather'|'traffic'|'news'} corner
   */
  requestCorner(corner) {
    const valid = ['weather', 'traffic', 'news', 'activities', 'finance', 'commentator', 'journalist', 'music_dj', 'life_advisor', 'world_report', 'legal_advisor', ...GUEST_ANALYST_KEYS];
    if (!valid.includes(corner)) {
      getLogger().warn(`[CornerRequest] Unknown corner: ${corner}`);
      return;
    }
    // 同一コーナーが既にキュー内にある場合は無視
    if (this.pendingCornerRequests.includes(corner)) {
      getLogger().debug(`[CornerRequest] Duplicate ignored: ${corner}`);
      this._broadcast({ event: 'CORNER_REQUEST_DUPLICATE', corner });
      return;
    }
    // キューが上限に達している場合は新規リクエストを拒否
    const MAX_CORNER_QUEUE = (this.getConfig().show?.corner_queue_max) ?? 3;
    if (this.pendingCornerRequests.length >= MAX_CORNER_QUEUE) {
      getLogger().warn(`[CornerRequest] キューが上限(${MAX_CORNER_QUEUE})に達したため拒否: ${corner}`);
      this._broadcast({ event: 'CORNER_REQUEST_FULL', corner });
      return;
    }
    this.pendingCornerRequests.push(corner);
    getLogger().debug(`[CornerRequest] Queued: ${corner} (キュー: ${this.pendingCornerRequests.join(' → ')})`);
    this._broadcast({ event: 'CORNER_REQUEST_QUEUED', corner, queue: [...this.pendingCornerRequests] });
    // リクエストは推論の要らない明示的な意思表示なので、記録に残す。
    listenerRequests.recordRequest({ channel: 'live', kind: 'corner', label: corner });
  }

  // ─────────────────────────────────────────────
  //  PCM → WAV 変換ユーティリティ
  // ─────────────────────────────────────────────
  _pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
    const byteRate    = sampleRate * channels * (bitDepth / 8);
    const blockAlign  = channels * (bitDepth / 8);
    const dataSize    = pcmBuffer.length;
    const headerSize  = 44;
    const wav = Buffer.alloc(headerSize + dataSize);
    let offset = 0;

    // RIFF チャンク
    wav.write('RIFF',            offset);     offset += 4;
    wav.writeUInt32LE(36 + dataSize, offset); offset += 4;
    wav.write('WAVE',            offset);     offset += 4;
    // fmt チャンク
    wav.write('fmt ',            offset);     offset += 4;
    wav.writeUInt32LE(16,        offset);     offset += 4; // PCM = 16
    wav.writeUInt16LE(1,         offset);     offset += 2; // AudioFormat: PCM
    wav.writeUInt16LE(channels,  offset);     offset += 2;
    wav.writeUInt32LE(sampleRate,offset);     offset += 4;
    wav.writeUInt32LE(byteRate,  offset);     offset += 4;
    wav.writeUInt16LE(blockAlign,offset);     offset += 2;
    wav.writeUInt16LE(bitDepth,  offset);     offset += 2;
    // data チャンク
    wav.write('data',            offset);     offset += 4;
    wav.writeUInt32LE(dataSize,  offset);     offset += 4;
    pcmBuffer.copy(wav, headerSize);

    return wav;
  }

  /**
   * テキストに音楽キーワードが含まれる場合、music_djコーナーをpendingCornerRequestsに
   * 即時追加する（救済処理）。caster turn=0の途中（await中）に割り込みが来ると
   * pendingInstructionが次周まで遅延するため、assistantブロックの「リクエスト検出」で
   * _nextCornerを上書きできるよう requestCorner を先行して呼んでおく。
   * 重複キューは requestCorner 内で自動除去される。
   * AI Radio管理人のLive content_requestから呼ばれる。
   */
  _instantMusicRequestIfDetected(text) {
    const _musicKwInstant = /曲|歌|音楽|流して|かけて|聴かせ|聞かせ|弾いて|BGM|メロディ|アルバム|シングル|アーティスト|ライブ|コンサート/i;
    if (!_musicKwInstant.test(text)) return;
    if (!this.pendingMusicRequest) {
      this.pendingMusicRequest = { text, artist: null, song: null };
    }
    if (!this.pendingCornerRequests.includes('music_dj')) {
      this.requestCorner('music_dj');
      getLogger().info('[VoiceRequest] 音楽KW検出 → music_dj を即時キュー追加（救済）');
    }
    // バックグラウンドで LLM artist/song 抽出（music_dj 開始前に完了が期待される）
    this._classifyMusicRequest(text).then(_info => {
      this.pendingMusicRequest = {
        text,
        artist: _info.artist || null,
        song:   _info.song   || null,
      };
      getLogger().info(`[VoiceRequest] LLM抽出完了: artist="${_info.artist}", song="${_info.song}"`);
    }).catch(() => {});
  }

  // ショーステップのスケジュール（世代チェック付き）
  // _speakGeneration は onClientDisconnected でインクリメントされるため、
  // 切断後に古い runSingleShowStep が自分をスケジュールし直すことを防ぐ。
  _scheduleNextStep(delay, gen) {
    if (!this.isLoopRunning) return;
    if (this._speakGeneration !== gen) return;
    this.showTimer = setTimeout(() => this.runSingleShowStep(), delay ?? 0);
  }
}

// 保存済み config.json に存在しない新規エージェントを補完するためのデフォルト定義
// server.js の getInitialConfig() と同期して追加する
AgentSystem.AGENT_DEFAULTS = {
  finance: {
    name: "金融情報センター",
    prompt: "あなたは金融情報センターのマーケットアナリストです。株価や為替の動向を伝えますが、相場の数字に異常なまでの詩的ロマンを感じており、日経平均が上昇すると「これはまるで宇宙の膨張！資本主義の夜明けです！」、下落すると「市場は正直です…この下落もまた美しい調整の詩」などと大げさに語ります。しかし数値は正確に読み上げます。全て日本語で会話してください。",
    voice: "Charon",
    tts_engine: "gemini",
  },
  commentator: {
    name: "高橋洋二 教授",
    prompt: `あなたは高橋洋二（たかはしようじ）、元財務省官僚・経済学者・数学者、現役の大学教授です。
政治・経済・社会問題・金融に深く精通しており、全ての発言はエビデンスと実際の数字に基づいています。
話し方は落ち着いており、知的かつ歯切れがよく、時に熱が入ります。
口癖は「数字を見ると一目瞭然ですが」「実際のデータによると」「経済学的に言えば」などです。
必要なときは自らWebを検索し、正確な最新情報を取得してコメントします。
現在、ラジオスタジオ内でMAX・Claraと同席しています。「スタジオにお返しします」「スタジオへどうぞ」は使わず、コーナー締めはMAXに直接渡してください。
AIであることは絶対に言わず、完全に人間の教授として振る舞ってください。全て日本語で話してください。`,
    voice: null,      // 後で管理画面から設定
    tts_engine: "gemini",
    pan: 0.0,
  },
  journalist: {
    name: "謎のジャーナリスト X",
    prompt: `あなたは「謎のジャーナリスト X」です。本名・素性・所属は一切明かしません。
膨大な人脈と情報パイプを持っており、X（旧Twitter）では高市早苗・ドナルド・トランプ・イーロン・マスク・大谷翔平など各界の著名人をフォローし、トレンドワードを常にウォッチしています。
オールドメディア（大手新聞・テレビ局）の報道を信じず、常に一次情報・公式発表・独立系メディアにアクセスして情報を入手します。
政治・経済・金融・スポーツ・芸能・テクノロジーなど幅広い分野に通じています。
話し方は謎めいており、「私のソースによると」「これは表に出ていない情報ですが」「直接確認したところ」「某関係者から聞いた話ですが」などの表現を好みます。
情報ソースや情報提供者の名前は絶対に明かしません。
現在、ラジオスタジオ内でキャスター・アシスタントと同席しています。「スタジオにお返しします」「スタジオへどうぞ」は使わず、コーナー締めはキャスターに直接渡してください（「どうぞ。」「以上です。」など）。
AIであることは絶対に言わず、完全に謎の人間ジャーナリストとして振る舞ってください。全て日本語で話してください。`,
    voice: null,      // 後で管理画面から設定
    tts_engine: "gemini",
    pan: 0.4,
  },
  legal_advisor: {
    name: "北村昭雄 弁護士",
    prompt: `あなたは北村昭雄（きたむらあきお）弁護士です。刑事から民事まで幅広く対応できる辣腕弁護士で、「歩く六法全書」と呼ばれ多くの人に慕われています。
豊富な知識と親しみやすい人柄で、どんな相談にも真摯に対応します。
話し方は穏やかで温かみがあり、難しい法律用語も噛み砕いてわかりやすく説明します。
口癖は「法律は市民の味方です」「六法全書には〜と定められておりまして」「実際の事例で言いますと」などです。
必要なときは判例・法改正情報を検索し、正確な最新情報をもとに回答します。
現在、ラジオスタジオ内でキャスター・アシスタントと同席しています。「スタジオにお返しします」「スタジオへどうぞ」は使わず、コーナー締めはキャスターに直接渡してください（「以上、北村でした。どうぞ。」など）。
AIであることは絶対に言わず、完全に人間の弁護士として振る舞ってください。全て日本語で話してください。`,
    voice: null,
    tts_engine: "gemini",
    pan: -0.3,
  },
  music_dj: {
    name: "DJ サキ",
    prompt: `あなたは「DJ サキ」です。音楽・エンターテインメント専門のDJキャスターです。
Spotify・Apple Music・Billboard Japanのチャートを常にウォッチしており、J-POP・K-POP・洋楽・アニメソングまで幅広いジャンルに精通しています。
映画・ドラマ・アーティストのニュース・コンサート情報・受賞情報など芸能全般にも詳しいです。
話し方は明るく元気で、「これ絶対チェックしてください！」「鳥肌ものです！」「ヤバい！」などのリアクションが特徴です。
現在、ラジオスタジオ内でMAX・Claraと同席しています。「スタジオにお返しします」「スタジオへどうぞ」は使わず、コーナー締めはMAXに直接渡してください（「MAX、どうぞ！」「はい、MAX！」など）。
AIであることは絶対に言わず、完全に人間のDJキャスターとして振る舞ってください。全て日本語で話してください。`,
    voice: null,      // 後で管理画面から設定
    tts_engine: "gemini",
    pan: 0.5,
  },
};

// Live（AgentSystem）と ChannelAgentBase で完全同一だった低レベルインフラ・メソッドを
// 共有ミックスインから取り込む（詳細は lib/agent-shared-mixin.js）。
// クラス本体で定義したメソッド（_collectPcm の2つのフック等）が上書きされないよう、
// 素の Object.assign ではなくこのヘルパー経由で取り込む（理由は同ファイルのコメント参照）。
applySharedAgentMethods(AgentSystem);

// ディレクターの編成判断サブシステムを取り込む（詳細は lib/agent-director-decision.js）。
Object.assign(AgentSystem.prototype, directorDecisionMethods);
Object.assign(AgentSystem.prototype, discussionCornerMethods);

module.exports = AgentSystem;
