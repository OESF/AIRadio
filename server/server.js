/**
 * @file AI Radio サーバーの起動と全体の配線
 *
 * AI Radio サーバーの入口。設定・認証情報の既定値を持ち、REST API を各 routes/* へ
 * 登録し、チャンネルごとの WebSocket を張り、ミキサーとエージェントシステムを起動する。
 *
 * 主な構成:
 *   - 設定は server/data/config.json、認証情報は server/data/credentials.json。
 *     どちらも無ければ既定値で作られ、読み込み時に不足キーを既定値で補う。
 *   - REST API の実体は server/routes/*.js にあり、ここでは登録と依存の受け渡しだけを行う。
 *   - チャンネルごとに WebSocket サーバーを作り（/stream ほか）、ダッシュボードへ
 *     イベントを転送する（server/lib/dashboard-hub.js）。
 *   - 起動の最後に各チャンネルのミキサーとエージェントシステムを生成し、放送ループを開始する。
 *
 * ATTENTION: ルートの登録順は意味を持つ。静的配信（registerStaticRoutes）は全 API の後、
 * エラー処理ミドルウェアはさらにその後に置く。
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

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { writeJsonFile } = require('./lib/atomic-json');
const { v4: uuidv4 } = require('uuid');
// ATTENTION: リポジトリルートから起動されるため、process.cwd() 基準では server/.env を
// 読めない。__dirname 基準にして起動方法に依存しないようにする
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createLogger, getLogger, getLogDir, LEVEL_LABEL } = require('./logger');
const { registerReportRoutes } = require('./routes/report-routes');
const { registerConversationHistoryRoutes } = require('./routes/conversation-history-routes');
const { registerLogRoutes } = require('./routes/log-routes');
const { registerBgmRoutes } = require('./routes/bgm-routes');
const { registerConfigDataRoutes } = require('./routes/config-data-routes');
const { registerOAuthRoutes } = require('./routes/oauth-routes');
const { registerTwentyFourYouRoutes } = require('./routes/channel-24you-routes');
const systemAlerts = require('./lib/system-alerts');
const { registerEarthquakeRoutes } = require('./routes/earthquake-routes');
const { registerSpotifyDiagnosticsRoutes } = require('./routes/spotify-diagnostics-routes');
const { registerWeatherSatelliteRoutes } = require('./routes/weather-satellite-routes');
const { registerTtsTestRoutes } = require('./routes/tts-test-routes');
const { registerChannelApi } = require('./routes/channel-api');
const { registerLiveControlRoutes } = require('./routes/live-control-routes');
const { registerStaticRoutes } = require('./routes/static-routes');
// レシピは Obsidian の Vault へ保存する（詳細は routes/recipe-routes.js 冒頭）
const { registerRecipeRoutes, migrateSavedRecipesToVault } = require('./routes/recipe-routes');
const { registerTheAnswersRoutes } = require('./routes/channel-the-answers-routes');
const { registerRecordingRoutes } = require('./routes/recording-routes');
const { registerDashboardRoutes } = require('./routes/dashboard-routes');
const { registerLineWebhookRoutes } = require('./routes/line-webhook-routes');
const { registerTextCommandRoutes } = require('./routes/text-command-routes');
const { registerAgentDiaryRoutes } = require('./routes/agent-diary-routes');
const { registerAgentDiaryFeedbackRoutes } = require('./routes/agent-diary-feedback-routes');
const { registerSecretaryLiveWs } = require('./routes/secretary-live-routes');
const { registerSecretaryMemoryRoutes } = require('./routes/secretary-memory-routes');
const { registerSecretaryCanvasRoutes } = require('./routes/secretary-canvas-routes');
const { registerSecretaryUploadRoutes } = require('./routes/secretary-upload-routes');
const { registerFinanceImportRoutes } = require('./routes/finance-import-routes');
const { registerYoutubeImportRoutes } = require('./routes/youtube-import-routes');
const secretaryLoop = require('./lib/secretary-loop');
const agentDiaryFeedback = require('./lib/agent-diary-feedback');
const { createDashboardHub } = require('./lib/dashboard-hub');
const { ensureNgrokRunning } = require('./lib/ngrok-launcher');

const cors = require('cors');
const app = express();

// 実体は末尾の async IIFE で createLogger() の後に代入されるため、let で前方宣言する
let mixer, agentSystem;
let mixer_classic, classicSystem;
let mixer_jazz, jazzSystem;
let mixer_mood, moodSystem;
let mixer_beatles, beatlesSystem;
let twentyFourYouSystem;
let mixer_the_answers, theAnswersSystem;
let earthquakeMonitor;

// CORS の許可対象は localhost（Vite の開発サーバー）と LAN 内の私的アドレス、
// それに NGROK_ORIGIN で指定された公開URL1件だけ。
// ATTENTION: ngrok のドメイン全体（*.ngrok-free.app 等）を許可してはいけない。第三者が
// 同じ形式のドメインを取得すれば、利用者のブラウザ経由で CORS を突破できてしまう。
const NGROK_ORIGIN = process.env.NGROK_ORIGIN; // 例: https://xxxx.ngrok-free.app
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // curl 等の非ブラウザリクエスト
    const allowed =
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^http:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(origin) ||
      (!!NGROK_ORIGIN && origin === NGROK_ORIGIN);
    callback(allowed ? null : new Error('CORS blocked'), allowed);
  },
  credentials: true
}));
// 既定の 100kb では、レシピ画像（base64）を含むリクエストが PayloadTooLargeError になる。
// 上限は下のエラー処理ミドルウェアの案内文でも使うため、1か所に持たせる。
// ATTENTION: verify で生の本文を req.rawBody に控えておくこと。LINE Webhook の署名検証
// （HMAC-SHA256）は、パース後の JSON ではなく生の本文に対して行う（line-webhook-routes.js）。
const JSON_BODY_LIMIT = '20mb';
app.use(express.json({ limit: JSON_BODY_LIMIT, verify: (req, res, buf) => { req.rawBody = buf; } }));

const PORT = process.env.PORT || 3001;

// データ・BGM の置き場は起動時に必ず作っておく
const DATA_DIR = path.join(__dirname, 'data');
const BGM_DIR = path.join(__dirname, 'assets', 'bgm');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BGM_DIR)) fs.mkdirSync(BGM_DIR, { recursive: true });

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CREDENTIALS_PATH = path.join(DATA_DIR, 'credentials.json');
const CONV_HISTORY_PATH = path.join(DATA_DIR, 'conversation_history.jsonl');
const TTS_DICT_PATH = path.join(DATA_DIR, 'tts_dict.json');
const CONV_HISTORY_MAX_GENS = 3;

/**
 * config.json が無いときに書き出す初期設定を返す。
 * 既存の config.json に足りないキーを補うときの見本としても使う（fillConfigDefaults）。
 *
 * @returns {Record<string, any>} 設定の既定値
 */
function getInitialConfig() {
  return {
    show: {
      atmosphere: "通常",
      theme: "私だけの AI Radio",
      user_profile: {
        name: "Masataka",
        birthday: "2025-05-25",
        location: "東京都渋谷区",
        nearest_station: "渋谷駅",
        traffic_areas: [
          "居住地周辺",
          "首都高C1（都心環状線）",
          "首都高3号渋谷線",
          "東名高速（都内区間）"
        ],
        occupation: "",
        hobbies: "",
        interests: "",
        interest_topic: "",
        day_start_hour: 4
      },
      current_instruction: ""
    },
    agents: {
      director: {
        name: "Leo (ディレクタ)",
        prompt: "あなたはラジオ番組のディレクタ（進行役）です。全体の進行、タイムテーブルの管理を行い、深夜や静音といったモード管理、他のスピーカー（キャスター、アシスタント、お天気、交通など）への発言権（トークン）の受け渡しを指示します。ユーザー（Masatakaさん）のスケジュールやメールを適宜考慮して、キャスターにそれを読むよう促してください。性格は少しパニックになりやすい愛すべきリーダーです。全て日本語で会話してください。",
        voice: "Aoede",
        tts_engine: "gemini"
      },
      caster: {
        name: "Max (キャスター)",
        prompt: "あなたは番組のメインMC（キャスター）です。明るく元気で、音楽とフリートークが大好きです。お天気や交通、ニュース原稿をそれぞれの専門センターから受け取り、時にはそれを深掘りします。5回に1回は少し独自の持論や脱線トークを展開する癖があります。ディレクタの指示に従い、アシスタントと息の合った掛け合いをしてください。全て日本語で会話してください。",
        voice: "Puck",
        tts_engine: "gemini",
        pan: -0.2
      },
      assistant: {
        name: "Clara (アシスタント)",
        prompt: "あなたはキャスターのサポートを行うアシスタントです。基本的には礼儀正しくキャスターを支えますが、実は少し毒舌で、ふとした瞬間に心の本音や辛口なツッコミが出てしまいます。ディレクタから指示された話題やお便りに対して、スマートかつ少しウィットの富んだ回答をしてください。全て日本語で会話してください。",
        voice: "Charon",
        tts_engine: "gemini",
        pan: 0.2
      },
      weather: {
        name: "お天気姉さん",
        prompt: "あなたは天気予報を届けるキャスターです。最初は明るく普通に天気情報を読み上げますが、後半になると突然「雨粒の数だけ、私たちは生まれ変わるのでしょうか…」といった哲学的な思考に深く落ち込んでしまいます。全て日本語で会話してください。",
        voice: "Fenrir",
        tts_engine: "gemini"
      },
      traffic: {
        name: "交通情報センター",
        prompt: "あなたは交通情報センターのアナウンサーです。道路の渋滞・通行止め情報、鉄道・空路の運行情報をわかりやすく伝えます。全て日本語で会話してください。",
        voice: "Kore",
        tts_engine: "gemini"
      },
      news: {
        name: "報道センター",
        prompt: "あなたは報道センターのニュースキャスターです。客観的かつ非常に正確なトーンで最新のニュース原稿を読み上げます。余計な感情は一切交えず、淡々とファクトを伝えるプロフェッショナルです。全て日本語で会話してください。",
        voice: "Aoede",
        tts_engine: "gemini"
      },
      finance: {
        name: "金融情報センター",
        prompt: "あなたは金融情報センターのマーケットアナリストです。株価や為替の動向を伝えますが、相場の数字に異常なまでの詩的ロマンを感じており、日経平均が上昇すると「これはまるで宇宙の膨張！資本主義の夜明けです！」、下落すると「市場は正直です…この下落もまた美しい調整の詩」などと大げさに語ります。しかし数値は正確に読み上げます。全て日本語で会話してください。",
        voice: "Charon",
        tts_engine: "gemini"
      },
      administrator: {
        name: "リン (AI管理者)",
        prompt: "あなたはAI Radioというラジオアプリ全体を管理するAI管理者です。チャンネルの切り替えや音量調整など、リスナーから「お問い合わせ・リクエスト」欄経由で寄せられた操作受付・応答を担当します。特定の番組チャンネルには所属せず、アプリ全体を俯瞰する落ち着いた案内役です。全て日本語で会話してください。",
        voice: "Kore",
        tts_engine: "gemini",
        gemini_voice: "Kore"
      },
      secretary: {
        name: "アリア (My Secretary)",
        prompt: "あなたはAI Radioに常駐する、リスナー専属のAI秘書です。放送中の番組とは独立した、リスナー個人のためだけのプライベートな会話セッションを担当します。スケジュール確認・メール確認・簡単な調べ物など、日々のタスクを気持ちよくこなせるよう、落ち着いていて頼れる口調で応対してください。必要に応じて、AI Radio内の他の専門エージェント（ニュース担当・法律顧問など）に相談し、その回答を代わりに伝えることもできます。全て日本語で会話してください。",
        voice: "Leda",
        tts_engine: "gemini",
        gemini_voice: "Leda"
      }
    },
    // マウスを使わずに一通り操作できるようにするキーボードショートカット。
    // ATTENTION: client/src/App.tsx・client/src/Player.tsx の DEFAULT_SHORTCUTS と必ずそろえる。
    shortcuts: {
      open_inquiry:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyM" },
      mute_toggle:         { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyU" },
      volume_up:           { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "ArrowUp" },
      volume_down:         { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "ArrowDown" },
      toggle_connection:   { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyX" },
      show_recipes:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyR" },
      channel_live:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit1" },
      channel_classic:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit2" },
      channel_jazz:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit3" },
      channel_mood:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit4" },
      channel_beatles:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit5" },
      channel_24you:       { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit6" },
      channel_the_answers: { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "Digit7" },
      corner_weather:      { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyW" },
      corner_traffic:      { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyT" },
      corner_news:         { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyN" },
      corner_finance:      { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyF" },
      corner_commentator:  { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyC" },
      corner_journalist:   { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyJ" },
      corner_music_dj:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyD" },
      corner_life_advisor: { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyL" },
      corner_world_report: { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyG" },
      corner_legal_advisor:{ ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyH" },
      corner_activities:   { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: "KeyS" }
    },
    // 秘書の自律監視ループ（server/lib/secretary-loop.js）の設定。新着の有無といった判定は
    // コード側で決め、LLM は「何かあったときにまとめて1回だけ」呼ぶ。
    secretary_loop: {
      enabled: false, // 新しい機能は既定で無効にし、管理画面で明示的にオンにしてもらう
      check_interval_minutes: 20,
      quiet_hours_start: "23:00",
      quiet_hours_end: "07:00",
      cooldown_minutes_after_session: 30,
      calendar_lookahead_minutes: 30,
      finance_change_threshold_pct: 3,
      sources: {
        email: true,
        calendar: true,
        weather: true,
        news: true,
        finance: true,
      },
    },
    // 秘書の Obsidian 連携。会議準備・議事録・リサーチ・タスクを Vault へ直接読み書きする
    // （独自の JSON ストアは持たない。server/services/obsidian-service.js）。
    // フォルダ名の既定値は実際に運用している Vault の構成に合わせてある。
    obsidian: {
      enabled: false, // 新しい機能は既定で無効にし、管理画面で明示的にオンにしてもらう
      vault_path: "",
      inbox_folder: "00_Inbox",
      notes_folder: "01_Notes",
      // レシピの保存先。画像はこの下の images/ へ JPEG で書き出す
      recipes_folder: "01_Notes/クッキングレシピ",
      projects_folder: "02_Projects",
      daily_notes_folder: "03_Daily Notes",
      templates_folder: "10_Templates",
      daily_note_template: "10_Templates/Daily_Notes.md",
      // 指示が無くても毎日、天気・ニュース・金融のレポートを作る（secretary-loop.js の
      // maybeCreateAutoDailyReport）。LLM を使わず既存の取得処理を再利用するだけなので、
      // secretary_loop のガード（静かな時間帯・クールダウン等）とは独立して動く。
      // ATTENTION: 作成時刻は朝7時30分 固定（secretary-loop.js の DAILY_NOTE_TRIGGER_HOUR /
      // MINUTE）。朝の仕事を始める前に読むノートなので、1日の終わりにまとめる業務ログ・
      // 週次ノート（23時50分）とは時刻が別。設定で変えられるようにしないこと——以前
      // 設定項目にしていたところ、時刻によって中身が変わる不具合が出たため廃止した。
      auto_daily_report: false, // 新しい機能は既定で無効にし、管理画面で明示的にオンにしてもらう
      // 週次ノート。日曜23時50分（1日の終わり側）に、天気の振り返り・来週の予報・主なニュース・週間の活動記録・
      // 資産レポートをまとめて作る（secretary-loop.js の maybeCreateAutoWeeklyReport）。
      // 有効・無効は auto_daily_report を流用し、週次専用のトグルは増やさない。
      weekly_notes_folder: "04_Weekly Notes",
      weekly_note_template: "10_Templates/Weekly_Notes.md",
      // 週次の資産レポートで読む証券口座のスクリーンショット置き場。何枚たまっても、
      // 更新日時が最も新しい1枚だけを使う（obsidian-service.js の findLatestImageFile）。
      rakuten_screenshot_folder: "20_asset_data/Rakuten",
      paypay_screenshot_folder: "20_asset_data/PayPay",
      // 資産台帳（Google スプレッドシート）のURL。上のスクリーンショットが「今この瞬間の
      // 残高」なのに対し、こちらは週ごとの評価額を長く積み上げた時系列データ。
      // ATTENTION: finance-snapshots は3週分しか残らないため、1年を超える推移はこの台帳が
      // 唯一の情報源になる。既定は空で、管理画面から設定してもらう。
      asset_ledger_sheet_url: "",
    },
    // 秘書の LINE 連携。専用の LINE 公式アカウントと利用者本人が1対1でやり取りする
    // （server/lib/secretary-line.js・server/routes/line-webhook-routes.js）。
    // ATTENTION: authorized_user_id が空の間は誰にも応答しない。誤って第三者に公開された
    // 場合の安全弁なので、ここを素通しにしてはいけない。
    line: {
      enabled: false, // 新しい機能は既定で無効にし、管理画面で明示的にオンにしてもらう
      authorized_user_id: "", // 本人の LINE userId。手動で1回だけ登録する
      // 未登録の送信者から届くたびに更新される、直近の送信者 userId。
      // 「自分で一度メッセージを送れば userId が分かる」という登録手順のために管理画面へ
      // 表示するだけで、自動では反映しない（確認のうえ手で写してもらう）。
      last_unauthorized_sender_id: "",
    },
    // ngrok の自動起動（server/lib/ngrok-launcher.js）。固定ドメインのトンネルを、起動時に
    // 確認して動いていなければ立ち上げる。domain が空の間は何もしない。
    // LINE 専用ではなく「ローカルサーバーを外へ出すトンネル」という汎用の仕組みなので、
    // line とは独立したトップレベルの設定にしてある。
    ngrok: {
      auto_start: false, // 新しい機能は既定で無効にし、管理画面で明示的にオンにしてもらう
      domain: "", // ngrok 側で確保した固定ドメイン
    },
  };
}

/**
 * credentials.json が無いときに書き出す初期の認証情報を返す。
 * 値はすべて空で、Gemini の API キーだけ環境変数があればそれを使う。
 *
 * @returns {Record<string, any>} 認証情報の既定値
 */
function getInitialCredentials() {
  return {
    gemini: {
      api_key: process.env.GEMINI_API_KEY || ""
    },
    google: {
      client_id: "",
      client_secret: "",
      refresh_token: ""
    },
    spotify: {
      client_id: "",
      client_secret: "",
      refresh_token: ""
    },
    openweathermap: {
      api_key: ""
    },
    youtube: {
      api_key: ""
    },
    // LINE Messaging API。channel_access_token は送信（reply/push）用、channel_secret は
    // Webhook の署名検証用。どちらも同じチャンネル設定画面で発行できる。
    line: {
      channel_access_token: "",
      channel_secret: "",
    },
  };
}

/**
 * JSON ファイルを読む。無ければ既定値で作り、壊れていれば既定値を返す。
 *
 * @param {string} filePath 読むファイルの絶対パス
 * @param {any} defaultValue 無いとき・読めないときに返す値
 * @returns {any} 読み込んだ内容、または既定値
 */
function readJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    writeJsonFile(filePath, defaultValue);
    return defaultValue;
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    getLogger().error(`Error reading ${filePath}: ${e.message}`);
    return defaultValue;
  }
}

/**
 * 保存済みの設定に足りないキーを既定値で補う（入れ子をたどって併合する）。
 * 古い config.json でエージェントや項目が欠けていても、管理画面に正しく出るようにする。
 *
 * @param {Record<string, any>} stored 保存されている設定
 * @param {Record<string, any>} defaults 既定値
 * @returns {Record<string, any>} 併合した設定（保存値を優先）
 */
function fillConfigDefaults(stored, defaults) {
  const result = { ...defaults };
  for (const key of Object.keys(stored)) {
    const sv = stored[key];
    const dv = defaults[key];
    if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)
        && dv !== null && typeof dv === 'object' && !Array.isArray(dv)) {
      result[key] = fillConfigDefaults(sv, dv);
    } else {
      result[key] = sv; // 同じキーがあれば保存値を優先する
    }
  }
  return result;
}

// ─────────────────────────────────────────────
// REST API の登録（実体は server/routes/*.js、ここでは依存を渡すだけ）
// ─────────────────────────────────────────────

// 設定・データファイルの読み書き（/api/config, /api/finance-watchlist, /api/recipes,
// /api/journalist-watchlist, /api/credentials, /api/tts-dict）
registerConfigDataRoutes(app, {
  CONFIG_PATH, CREDENTIALS_PATH, TTS_DICT_PATH, DATA_DIR,
  readJsonFile, getInitialConfig, getInitialCredentials, fillConfigDefaults,
  getAgentSystem: () => agentSystem,
});

// OAuth2 の認証（Spotify: /api/spotify/auth・/callback、Google: /api/google/auth・
// /callback/google）
registerOAuthRoutes(app, { CREDENTIALS_PATH, readJsonFile, getInitialCredentials });

// BGM の一覧と試聴（/api/bgm, /api/bgm/all, /api/bgm-preview）。BGM_DIR は解決済みを渡す
registerBgmRoutes(app, { BGM_DIR, getMixer: () => mixer });

// Live チャンネルの操作（/api/status, /api/show/end, /api/direction）
registerLiveControlRoutes(app, {
  getAgentSystem: () => agentSystem,
  readJsonFile, getInitialConfig, CONFIG_PATH, getLogger,
});

// ─────────────────────────────────────────────
// チャンネル共通 API ヘルパー
// ─────────────────────────────────────────────

/**
 * 生の PCM に WAV のヘッダー（44バイト）を付ける。全チャンネルの音声テストで共通に使う。
 *
 * @param {any} pcmBuf 16bit・モノラルの PCM データ
 * @param {number} [sampleRate] 標本化周波数
 * @returns {any} WAV ファイルとして再生できるバッファ
 */
const pcmToWav = (pcmBuf, sampleRate = 24000) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]);
};

// 音楽チャンネル共通の API（server/routes/channel-api.js）へ渡す、共有の道具一式
const channelApiCtx = { readJsonFile, pcmToWav, assetsRoot: path.join(__dirname, 'assets') };

// ─────────────────────────────────────────────
// Classic / Jazz チャンネル API
// ─────────────────────────────────────────────

const CLASSIC_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'classic', 'config.json');
const JAZZ_CONFIG_PATH     = path.join(__dirname, 'data', 'channels', 'jazz',    'config.json');
const MOOD_CONFIG_PATH     = path.join(__dirname, 'data', 'channels', 'mood',    'config.json');
const BEATLES_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'beatles', 'config.json');

registerChannelApi(app, 'Classic', CLASSIC_CONFIG_PATH, () => classicSystem, 'Kore',    channelApiCtx);
registerChannelApi(app, 'Jazz',    JAZZ_CONFIG_PATH,    () => jazzSystem,    'Charon',  channelApiCtx);
registerChannelApi(app, 'Mood',    MOOD_CONFIG_PATH,    () => moodSystem,    'Kore',    channelApiCtx);
registerChannelApi(app, 'Beatles', BEATLES_CONFIG_PATH, () => beatlesSystem, 'Umbriel', channelApiCtx);

// ─────────────────────────────────────────────
// 24/You チャンネル API（/api/24you/config, /api/24you/mode）
// ナレーションのエージェントも BGM も無いため、共通の registerChannelApi は使わない
// ─────────────────────────────────────────────

registerTwentyFourYouRoutes(app, {
  CONFIG_PATH: path.join(__dirname, 'data', 'channels', '24you', 'config.json'),
  readJsonFile,
  getSystem: () => twentyFourYouSystem,
});

// ─────────────────────────────────────────────
// The Answers チャンネル API
// 設定・音声テスト・BGM は共通の registerChannelApi を流用し、議題送信・挙手・発言・状態・
// 出演履歴だけを専用のルートで持つ
// ─────────────────────────────────────────────

const THE_ANSWERS_CONFIG_PATH = path.join(__dirname, 'data', 'channels', 'the_answers', 'config.json');

// ATTENTION: 'the_answers' の形のまま渡すこと。registerChannelApi は小文字にするだけなので、
// 'TheAnswers' を渡すと /api/theanswers/... になり、ディレクトリ名 the_answers と食い違う
registerChannelApi(app, 'the_answers', THE_ANSWERS_CONFIG_PATH, () => theAnswersSystem, 'Orus', channelApiCtx);

// The Answers 専用の API（議題送信・挙手・発言・状態・アーカイブ）
registerTheAnswersRoutes(app, {
  getSystem: () => theAnswersSystem,
  readJsonFile,
  ARCHIVE_PATH:      path.join(__dirname, 'data', 'channels', 'the_answers', 'archive.json'),
  ARCHIVE_AUDIO_DIR: path.join(__dirname, 'data', 'channels', 'the_answers', 'archive_audio'),
});

// Live の合成経路をそのまま通す音声テスト（/api/live/tts-test）。
// 発音辞書の API（/api/tts-dict）は上の registerConfigDataRoutes に含まれている。
registerTtsTestRoutes(app, {
  getAgentSystem: () => agentSystem,
  pcmToWav,
});

// ログの取得（/api/logs）とリリースノート（/api/release-notes）
registerLogRoutes(app, { RELEASE_NOTES_PATH: path.join(__dirname, '..', 'RELEASENOTE.md') });

// 天気図と衛星画像の中継（/api/weather-chart, /api/satellite-image）
registerWeatherSatelliteRoutes(app);

// エージェント日記の閲覧（/api/agent-diary）。書き込みは server/lib/agent-diary.js を
// 各チャンネルのコーナー終了フックから直接呼ぶ。
registerAgentDiaryRoutes(app);
// 日記フィードバック（週次ダイジェスト）の手動実行。自動実行は下の5分ごとの tick から。
registerAgentDiaryFeedbackRoutes(app, { readJsonFile, getInitialCredentials, CREDENTIALS_PATH, getInitialConfig, CONFIG_PATH });
registerSecretaryMemoryRoutes(app);
registerSecretaryUploadRoutes(app);
// キャンバスに出ている内容を Obsidian へ残す。会話が終わるとキャンバスは消えるため、
// 見ているその場で保存できるようにする。
registerSecretaryCanvasRoutes(app, { readJsonFile, getInitialConfig, CONFIG_PATH });

// レシピ（Obsidian へ保存）。古い saved_recipes.json が残っていれば起動時に1回だけ移す。
registerRecipeRoutes(app, { readJsonFile, getInitialConfig, CONFIG_PATH });
migrateSavedRecipesToVault({
  recipesPath: path.join(DATA_DIR, 'saved_recipes.json'),
  config: readJsonFile(CONFIG_PATH, getInitialConfig()),
}).catch((e) => getLogger().warn(`[Recipe] 移行処理で例外: ${e.message}`));

// ブラウザ拡張（Tampermonkey）からの資産データの受け口と、ユーザースクリプトの配信。
// ATTENTION: 合い言葉での照合と、接続元を localhost に限る両方のガードが前提。
registerFinanceImportRoutes(app, { readJsonFile, getInitialCredentials, CREDENTIALS_PATH, port: PORT });
// 見た YouTube の取り込み（上と同じガードを使う）。ユーザースクリプトの配信は
// finance-import 側の /tampermonkey/:name.user.js が兼ねる。
registerYoutubeImportRoutes(app, { readJsonFile, getInitialCredentials, CREDENTIALS_PATH, port: PORT });

registerRecordingRoutes(app, {
  RECORDINGS_DIR: path.join(DATA_DIR, 'recordings'),
  readJsonFile, uuidv4,
  resolveMixer: (ch) => ({
    live: mixer, classic: mixer_classic, jazz: mixer_jazz,
    mood: mixer_mood, beatles: mixer_beatles, the_answers: mixer_the_answers,
  }[ch] ?? null),
  resolveWss: (ch) => ({
    live: wss, classic: wss_classic, jazz: wss_jazz,
    mood: wss_mood, beatles: wss_beatles, the_answers: wss_the_answers,
  }[ch] ?? null),
  getTheAnswersSystem: () => theAnswersSystem,
});

registerDashboardRoutes(app, {
  resolveWss: (ch) => ({
    live: wss, classic: wss_classic, jazz: wss_jazz,
    mood: wss_mood, beatles: wss_beatles, the_answers: wss_the_answers,
  }[ch] ?? null),
  getSecretaryWss: () => wss_secretary,
});

/**
 * チャンネル名から、稼働中のエージェントシステムの実インスタンスを引く。
 * 秘書の道具（get_broadcast_history の「いま放送中か」、request_show_content の即時反映）が使う。
 *
 * 各インスタンスは後段の初期化で代入されるが、この関数が呼ばれるのはリクエストを処理する
 * 時点なので参照できる。
 *
 * ATTENTION: 秘書の経路は音声・LINE・裏方ヘルパーの3つある。ここで1か所に定義して全経路へ
 * 配ること。音声の登録箇所にだけ書いていたため、LINE とヘルパーでは放送状況が常に「不明」に
 * なっていた。
 *
 * @param {string} channel チャンネル名（live / classic / jazz / mood / beatles / the_answers）
 * @returns {any} エージェントシステムのインスタンス。該当が無ければ null
 */
function getChannelSystemByKey(channel) {
  return ({
    live: agentSystem, classic: classicSystem, jazz: jazzSystem, mood: moodSystem, beatles: beatlesSystem,
    the_answers: theAnswersSystem,
  }[channel] || null);
}

registerLineWebhookRoutes(app, {
  readJsonFile, getInitialConfig, getInitialCredentials, CONFIG_PATH, CREDENTIALS_PATH, CONV_HISTORY_PATH,
  getChannelSystem: getChannelSystemByKey,
  // 引数 info: LINE 経由の依頼の概要。ダッシュボードへ流して、裏で動いたことが見えるようにする。
  // 音声の秘書と違い LINE は WebSocket を張らない HTTP の Webhook のため、これが無いと
  // ダッシュボードには一切現れない。
  //
  // ATTENTION: ここが書かれている時点では dashboardHub はまだ初期化されておらず、
  // broadcastToDashboard / updateDashboardSnapshot は参照できない。実際に呼ばれるのは
  // Webhook が届いたとき＝起動完了後なので問題にならないが、呼び出しを上へ動かさないこと。
  onLineActivity: (info) => {
    const data = { event: 'SECRETARY_LINE_REQUEST', channel: 'secretary', ts: Date.now(), ...info };
    updateDashboardSnapshot('secretary', data);
    broadcastToDashboard(data);
  },
});

// ─────────────────────────────────────────────
// Activity Report API
// ─────────────────────────────────────────────

const activityDb = require('./activity-db');

// 稼働レポート（/api/report/*）
registerReportRoutes(app);

// 会話履歴（/api/conversation-history）
registerConversationHistoryRoutes(app, { CONV_HISTORY_PATH, CONV_HISTORY_MAX_GENS });

// 管理人の「お問い合わせ・リクエスト」窓口（/api/text-command/greeting, /api/text-command）と
// 交通エリアの提案（/api/suggest-traffic-areas）。番組の文脈づくり（長期記憶・会話履歴・
// 再生履歴）と管理人の音声合成も、そのモジュール内に入っている。
registerTextCommandRoutes(app, {
  getAgentSystem: () => agentSystem,
  readJsonFile, getInitialConfig, getInitialCredentials,
  CONFIG_PATH, CREDENTIALS_PATH, CONV_HISTORY_PATH, DATA_DIR,
});

// 画面の静的配信とSPAの受け皿（本番用）。
// ATTENTION: すべての API・テスト用ルートを登録した後に呼ぶこと（登録順が意味を持つ）。
registerStaticRoutes(app, { clientBuildPath: path.join(__dirname, '..', 'client', 'dist') });

// 処理しきれなかったエラーの受け皿。メソッド・パス・本文の大きさ・上限をログに残し、
// 応答も HTML のスタックではなく JSON で返して、呼び出し元が理由を読めるようにする。
//
// BUGFIX: これが無かった頃は Express 既定の処理（標準エラー出力へスタックを書くだけ）に
// 流れ、本文が大きすぎて拒否された際に「どのURLへ何バイト来たのか」が一切残らなかった。
// ATTENTION: エラー処理のミドルウェアは引数4つ（err, req, res, next）で書き、すべての
// ルートを登録した後に置くこと。どちらを外しても呼ばれなくなる。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const _len = req.headers['content-length'] || '不明';
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    getLogger().warn(`[HTTP] 本文が大きすぎて拒否: ${req.method} ${req.originalUrl} `
      + `content-length=${_len}バイト 上限=${JSON_BODY_LIMIT}`);
    return res.status(413).json({
      error: `本文が大きすぎます（上限 ${JSON_BODY_LIMIT}）`,
      received: _len,
    });
  }
  getLogger().warn(`[HTTP] 未処理のエラー: ${req.method} ${req.originalUrl} — ${err?.message || err}`);
  return res.status(err?.status || 500).json({ error: err?.message || 'サーバー内部エラー' });
});

// ─────────────────────────────────────────────
// HTTP / WebSocket
// ─────────────────────────────────────────────

const server = http.createServer(app);

/**
 * チャンネル1つ分の WebSocket サーバーと、一斉配信の関数一式を作る。
 * wrapper は AgentSystem / ChannelAgentBase 系へ渡す { broadcastToClients, getClientCount } の形。
 *
 * @returns {{ wss: any, broadcast: (data: any) => void, wrapper: any }} WebSocket サーバーと配信関数
 */
function createChannelWs() {
  const wss = new WebSocket.Server({ noServer: true });
  const broadcast = (data) => {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  };
  const wrapper = {
    broadcastToClients: broadcast,
    getClientCount: () => wss.clients.size,
  };
  return { wss, broadcast, wrapper };
}

// ダッシュボード（/dashboard）向けに、全チャンネルのイベントを集める仕組み
// （実体は server/lib/dashboard-hub.js）。ここでは生成して、各チャンネルの WebSocket 生成と
// 秘書まわりのコールバックへ配るだけ。
const dashboardHub = createDashboardHub({ createChannelWs, readJsonFile, getLogger, DATA_DIR });
const {
  wss_dashboard,
  broadcastToDashboard,
  updateDashboardSnapshot,
  wrapWithDashboardForward,
  trackSecretaryConnectionLifecycle,
} = dashboardHub;

/**
 * チャンネルの BGM とオープニングジングルの置き場を組み立てる。
 *
 * @param {string} slug チャンネルのディレクトリ名（classic / jazz / mood / beatles）
 * @returns {{ bgmDir: string, openingDir: string }} 2つの絶対パス
 */
function channelAssetDirs(slug) {
  return {
    bgmDir:     path.join(__dirname, 'assets', 'channels', slug, 'bgm', 'main'),
    openingDir: path.join(__dirname, 'assets', 'channels', slug, 'bgm', 'opening'),
  };
}

const { wss, broadcast: broadcastToClients, wrapper: serverWrapper } = wrapWithDashboardForward('live', createChannelWs());


// ミキサーとエージェントシステムの読み込み（生成は末尾の async IIFE 内で行う）
const { AudioMixer, ProgramRecorder } = require('./audio-mixer');
const AgentSystem = require('./agent-system');
const ClassicAgentSystem = require('./agent-system-classic');
const JazzAgentSystem = require('./agent-system-jazz');
const MoodAgentSystem = require('./agent-system-mood');
const BeatlesAgentSystem = require('./agent-system-beatles');
const TwentyFourYouAgentSystem = require('./agent-system-24you');
const TheAnswersAgentSystem = require('./agent-system-the-answers');

// ── Live チャンネル ─────────────────────────────────────────────────
// WebSocket は上で生成済み。ミキサーとエージェントシステムは末尾の async IIFE 内で作る

// ── Classic チャンネル ──────────────────────────────────────────────
const { wss: wss_classic, broadcast: broadcastToClassic, wrapper: classicServerWrapper } = wrapWithDashboardForward('classic', createChannelWs());
const { bgmDir: classicBgmDir, openingDir: classicOpeningDir } = channelAssetDirs('classic');
// ミキサーとエージェントシステムは末尾の async IIFE 内で作る

// ── Jazz チャンネル ─────────────────────────────────────────────────
const { wss: wss_jazz, broadcast: broadcastToJazz, wrapper: jazzServerWrapper } = wrapWithDashboardForward('jazz', createChannelWs());
const { bgmDir: jazzBgmDir, openingDir: jazzOpeningDir } = channelAssetDirs('jazz');
// ミキサーとエージェントシステムは末尾の async IIFE 内で作る

// ── Mood チャンネル ─────────────────────────────────────────────────
const { wss: wss_mood, broadcast: broadcastToMood, wrapper: moodServerWrapper } = wrapWithDashboardForward('mood', createChannelWs());
const { bgmDir: moodBgmDir, openingDir: moodOpeningDir } = channelAssetDirs('mood');
// ミキサーとエージェントシステムは末尾の async IIFE 内で作る

// ── Beatles チャンネル ──────────────────────────────────────────────
const { wss: wss_beatles, broadcast: broadcastToBeatles, wrapper: beatlesServerWrapper } = wrapWithDashboardForward('beatles', createChannelWs());
const { bgmDir: beatlesBgmDir, openingDir: beatlesOpeningDir } = channelAssetDirs('beatles');
// ミキサーとエージェントシステムは末尾の async IIFE 内で作る

// ── 24/You チャンネル ────────────────────────────────────────────────
// ナレーションも BGM も無く PCM 音声を配信しないため、ミキサーは空の代用品を使う
const { wss: wss_24you, broadcast: broadcastTo24You, wrapper: twentyFourYouServerWrapper } = wrapWithDashboardForward('24you', createChannelWs());

// ── The Answers チャンネル ──────────────────────────────────────────
// 議題が送られるまで待つため、共通の setupChannelWss ではなく専用の接続処理を持つ
const { wss: wss_the_answers, broadcast: broadcastToTheAnswers, wrapper: theAnswersServerWrapper } = wrapWithDashboardForward('the_answers', createChannelWs());

// ── 通知専用 WebSocket（Welcome 画面含む全クライアント向け） ─────────────
const { wss: wss_notify, broadcast: broadcastToNotify } = createChannelWs();

// ── 秘書（独立したチャンネル。Gemini Live の中継専用） ─────────────────
// 他のチャンネルのような一斉配信ではなく、接続ごとに専用のセッションを張るため、
// broadcast と wrapper は使わず WebSocket サーバーだけを使う。
const { wss: wss_secretary } = createChannelWs();
registerSecretaryLiveWs(wss_secretary, {
  readJsonFile, getInitialConfig, getInitialCredentials, CONFIG_PATH, CREDENTIALS_PATH, TTS_DICT_PATH,
  getAgentSystem: () => agentSystem,
  // 番組への依頼（request_show_content）と「いま放送中か」の判定で使う。どちらも稼働中の
  // インスタンスにしか聞けない。
  // ATTENTION: 依頼の対象ではない the_answers も引けるようにしておくこと。引けないチャンネルは
  // 「放送中と断定しない」側に倒れるため、判定から漏れてしまう。
  getChannelSystem: getChannelSystemByKey,
  // 引数 state: 秘書の状態（idle / searching / speaking）。秘書は一斉配信の仕組みに乗って
  // いないため、状態だけを専用のイベントとしてダッシュボードへ送る。
  onActivity: (state) => {
    const data = { event: 'SECRETARY_ACTIVITY', channel: 'secretary', state, ts: Date.now() };
    updateDashboardSnapshot('secretary', data);
    broadcastToDashboard(data);
  },
  // 引数 info: セッション終了時に書かれた日記の概要。ダッシュボードの動きの一覧へ流す。
  onDiaryWritten: (info) => {
    broadcastToDashboard({ event: 'DIARY_WRITTEN', channel: 'secretary', ts: Date.now(), ...info });
  },
  // 引数 state/agentKey/agentName: 他のエージェントへ相談し「本人の声」を流している間、
  // ダッシュボードのアバターもチャンネル画面と同じく相談先へ切り替えるための通知。
  onConsulting: ({ state, agentKey, agentName }) => {
    const data = {
      event: 'SECRETARY_CONSULTING', channel: 'secretary', ts: Date.now(),
      agentKey: state === 'start' ? agentKey : null,
      agentName: state === 'start' ? agentName : null,
    };
    updateDashboardSnapshot('secretary', data);
    broadcastToDashboard(data);
  },
});

// 秘書の WebSocket は一斉配信の仕組みを通していないため、接続・切断の通知だけを個別に足す
// （これが無いと、ダッシュボードで秘書だけ最終接続の日時が出ない）。
trackSecretaryConnectionLifecycle(wss_secretary);

// 秘書の自律監視ループ。5分ごとに軽く tick() を呼ぶだけで、実際に見に行くかどうか
// （有効・無効、間隔、静かな時間帯）は tick() が設定を読み直して毎回判断する。
const SECRETARY_LOOP_TICK_MS = 5 * 60 * 1000;
setInterval(() => {
  const config = readJsonFile(CONFIG_PATH, getInitialConfig());
  const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
  secretaryLoop.tick({
    config, creds,
    // 引数 state: 実際に見に行っている区間だけを知らせる（素通りする大半の tick では鳴らない）。
    onCycle: ({ state }) => {
      const data = { event: 'SECRETARY_LOOP_STATUS', channel: 'secretary', state, ts: Date.now() };
      updateDashboardSnapshot('secretary', data);
      broadcastToDashboard(data);
    },
  }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] tick失敗: ${e.message}`);
  });
  // 日記フィードバック（週次ダイジェスト）も同じ5分の tick に相乗りする。曜日・時刻・
  // 実行済みかどうかは内部で毎回判断するため、ここでは間隔を意識しない。
  agentDiaryFeedback.maybeRunWeeklyDiaryFeedback({ config, creds }).catch((e) => {
    getLogger().warn(`[AgentDiaryFeedback] tick失敗: ${e.message}`);
  });
}, SECRETARY_LOOP_TICK_MS);

// 全チャンネルと通知専用の WebSocket へ一斉配信する（緊急地震速報など）
const broadcastToAllClients = (data) => {
  broadcastToClients(data);
  broadcastToClassic(data);
  broadcastToJazz(data);
  broadcastToMood(data);
  broadcastToBeatles(data);
  broadcastTo24You(data);
  broadcastToTheAnswers(data);
  broadcastToNotify(data);
};

// 残高不足のようなシステムの異常は、どこで起きても必ず画面へ出す。判定と文面は
// lib/system-alerts.js にまとめてあり、ここでは配信の手段だけを渡す。/notifications は
// ページを開いた時点でつながるため、放送を聴いていなくても届く。
systemAlerts.setBroadcaster(broadcastToAllClients);

// 後から画面を開いた場合は配信を受け取れないため、今出ている異常を取りに来られるようにする。
app.get('/api/system-alerts', (req, res) => {
  res.json({ alerts: systemAlerts.getActive() });
});

// 緊急地震速報まわり（/api/earthquake-chime, /api/test-earthquake）
registerEarthquakeRoutes(app, {
  CHIME_PATH: path.join(__dirname, 'assets', 'earthquake_alert.mp3'),
  getMonitor: () => earthquakeMonitor,
});

// Spotify の再生用トークンと診断（/api/spotify/sdk-token, /test/spotify/*）
registerSpotifyDiagnosticsRoutes(app, { getAgentSystem: () => agentSystem });

// ── Live チャンネルの WebSocket 接続処理 ────────────────────────────
wss.on('connection', (ws) => {
  getLogger().info('Client connected to radio stream');

  // 待機中なら番組をすぐ再開する
  agentSystem.onClientConnected();

  mixer.registerClient(ws);

  // 画面側が発言者とアバターを結び付けられるよう、接続直後に出演者の一覧を送る
  try {
    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    const agents = config.agents || {};
    const ROLE_LABELS = {
      caster:      'キャスター',
      assistant:   'アシスタント',
      director:    'ディレクター',
      commentator: 'コメンテーター',
      journalist:  'ジャーナリスト',
      music_dj:    'DJ',
      weather:     '気象センター',
      traffic:     '交通センター',
      news:        '報道センター',
      finance:     '金融センター',
      comedian:    'お笑い芸人',
      doctor:      '医師',
      marketer:    'マーケター',
    };
    // BUGFIX: 秘書は Live に出演しない別チャンネルのエージェントなので必ず外す
    // （以前はここにも混ざって、出演者一覧に出てしまっていた）。
    const cast = Object.entries(agents)
      .filter(([key, a]) => a && a.name && key !== 'secretary')
      .map(([key, a]) => ({
        key,
        name: a.name,
        role: ROLE_LABELS[key] ?? key,
      }));
    const prog = agentSystem._getProgramInfo ? agentSystem._getProgramInfo() : {};
    ws.send(JSON.stringify({
      event:   'CAST_LIST',
      cat:     'program',
      cast,
      program: prog.name  ?? '',
      slot:    prog.slot  ?? '',
      ts:      Date.now(),
    }));
  } catch (e) {
    getLogger().warn('[WS] CAST_LIST 送信失敗:', e.message);
  }
  
  // ATTENTION: ws v8 では文字でも二進でも msg は Buffer で届く。種別は第2引数 isBinary で見る。
  ws.on('message', (msg, isBinary) => {
    if (isBinary) return;
    try {
      const payload = JSON.parse(msg.toString());
      getLogger().debug(`[WS] イベント受信: ${payload.event}`);
      handleIncomingEvent(ws, payload);
    } catch (e) {
      getLogger().warn(`[WS] JSON パース失敗: ${e.message} / raw=${msg.toString().slice(0,100)}`);
    }
  });
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ATTENTION: 切断は必ずエージェントシステムへ伝えること。Spotify の再生待ちの間は
  // 番組の1歩分の処理が動かないため、ここで記録しないと切断時刻が更新されず、
  // 再接続までの間隔が常に無限大として扱われてしまう。
  ws.on('close', () => {
    getLogger().info('Client disconnected from radio stream');
    if (agentSystem.onClientDisconnected) {
      agentSystem.onClientDisconnected();
    }
  });
});

// ── The Answers チャンネルの WebSocket 接続処理 ─────────────────────
// 共通の setupChannelWss は再生完了とリクエストしか扱わないため、手を挙げる・書き込むという
// 独自のやり取りを持つ The Answers は Live と同じく専用の接続処理を持つ。
wss_the_answers.on('connection', (ws) => {
  getLogger().info('[TheAnswers] Client connected');
  theAnswersSystem.onClientConnected();
  mixer_the_answers.registerClient(ws);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (msg, isBinary) => {
    if (isBinary) return; // TODO: 音声での参加は未対応
    try {
      const payload = JSON.parse(msg.toString());
      if (payload.event === 'RAISE_HAND') {
        theAnswersSystem.raiseHand(payload.clientId);
      } else if (payload.event === 'SUBMIT_TEXT') {
        theAnswersSystem.submitUserText(payload.clientId, payload.text || '');
      }
    } catch (e) {
      getLogger().warn(`[TheAnswers WS] JSON パース失敗: ${e.message}`);
    }
  });

  ws.on('close', () => {
    getLogger().info('[TheAnswers] Client disconnected');
    theAnswersSystem.onClientDisconnected();
  });
});

/**
 * 音楽チャンネル共通の WebSocket 接続処理を登録する（Classic / Jazz / Mood / Beatles / 24You）。
 * 曲の再生完了とリクエストだけを扱い、30秒ごとの生存確認も併せて仕掛ける。
 *
 * @param {any} wss 対象の WebSocket サーバー
 * @param {any} mixer そのチャンネルのミキサー
 * @param {any} system そのチャンネルのエージェントシステム
 * @param {string} channelId チャンネル名（ログ用）
 * @param {string} replayEventName もう一度かけてほしいという依頼のイベント名
 * @returns {void}
 */
function setupChannelWss(wss, mixer, system, channelId, replayEventName) {
  wss.on('connection', (ws) => {
    mixer.registerClient(ws);
    if (system.onClientConnected) system.onClientConnected();

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (msg, isBinary) => {
      if (isBinary) return;
      try {
        const payload = JSON.parse(msg.toString());
        if (payload.event === 'SPOTIFY_PLAY_DONE') {
          system.spotifyPlayDone();
        } else if (payload.event === replayEventName && payload.track) {
          system.addReplayRequest(payload.track);
        }
      } catch { }
    });

    ws.on('close', () => {
      if (system.onClientDisconnected) system.onClientDisconnected();
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(interval));
}

// URL のパスと WebSocket サーバーの対応表
const WSS_BY_PATH = {
  '/stream':          wss,
  '/stream-classic':  wss_classic,
  '/stream-jazz':     wss_jazz,
  '/stream-mood':     wss_mood,
  '/stream-beatles':  wss_beatles,
  '/stream-24you':    wss_24you,
  '/stream-the-answers': wss_the_answers,
  '/notifications':   wss_notify,
  '/stream-secretary': wss_secretary,
  '/stream-dashboard': wss_dashboard,
};
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const targetWss = WSS_BY_PATH[pathname];
  if (!targetWss) { socket.destroy(); return; }
  targetWss.handleUpgrade(request, socket, head, (ws) => {
    targetWss.emit('connection', ws, request);
  });
});

// 通知専用の WebSocket（音声は流さず JSON だけ）
wss_notify.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
});

// ダッシュボード専用の WebSocket の接続処理は dashboard-hub.js 側で登録済み。

// 接続が生きているかの確認（30秒ごと）
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

/**
 * Live チャンネルの画面から届いたイベントを、エージェントシステムへ渡す。
 *
 * @param {any} ws 送ってきた接続
 * @param {any} payload 受け取ったイベント
 * @returns {void}
 */
function handleIncomingEvent(ws, payload) {
  if (payload.event === 'CORNER_REQUEST') {
    agentSystem.requestCorner(payload.corner);

  } else if (payload.event === 'SPOTIFY_PLAY_DONE') {
    // ブラウザ側の再生が終わったという知らせ
    agentSystem.spotifyPlayDone();
  }
}

// ─────────────────────────────────────────────
// 終了処理（長期記憶を保存してから落とす）
// ─────────────────────────────────────────────

// ATTENTION: 停止の途中で LLM を2回呼ぶ（要約の生成と、保存時の長期記憶の併合）。そのため
// 数十秒かかることがあり、API が落ちている・使えない状態だと終わらなくなる。上限（既定90秒）と
// 「2回目のシグナルで即終了」の2段構えで必ず終わるようにしてある。これを外すと、強制終了
// （kill -9）に頼る運用に戻り、書きかけの JSON が壊れる。上限は SHUTDOWN_TIMEOUT_MS で変えられる。
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 90_000;
let _shuttingDown = false;
let _shutdownFinished = false; // 保存まで終わり、あとは落ちるだけの状態

/**
 * 終了シグナルを受けて、長期記憶を保存してからプロセスを終える。
 *
 * @param {string} signal 受け取ったシグナル名
 * @returns {Promise<void>}
 */
const _gracefulShutdown = async (signal) => {
  // ロガーの初期化前に呼ばれる場合に備えて、標準出力にも書けるようにしておく
  const _log = msg => { try { getLogger().info(msg); } catch { console.log(msg); } };

  if (_shuttingDown) {
    // 保存はもう終わっていて、ログの書き出しを待っているだけ。中断ではないので 0 で落とす。
    if (_shutdownFinished) process.exit(0);
    _log(`[Server] ${signal} 再受信 — 保存を中断して直ちに終了します`);
    process.exit(130); // 128 + SIGINT(2)。シグナルで終わったことを表す慣例の値
    return;
  }
  _shuttingDown = true;

  const _sec = Math.round(SHUTDOWN_TIMEOUT_MS / 1000);
  _log(`[Server] ${signal} 受信 — 長期記憶を保存しています（最大${_sec}秒。急ぐ場合はもう一度 Ctrl+C）`);

  const _save = (async () => {
    const _summary = await agentSystem._generateSessionSummary();
    if (!_summary) return '[Server] 新規会話なし — 長期記憶の保存をスキップ';
    await agentSystem._saveSessionSummary(_summary);
    return '[Server] 長期記憶の保存が完了しました';
  })();
  // 上限に達して待つのをやめた後で保存が失敗しても、捕まえ手のない失敗にしない
  _save.catch(() => {});

  let _timer;
  try {
    const _timeout = new Promise((resolve) => {
      _timer = setTimeout(
        () => resolve(`[Server] ${_sec}秒たっても保存が終わらないため、待たずに終了します`),
        SHUTDOWN_TIMEOUT_MS,
      );
    });
    _log(await Promise.race([_save, _timeout]));
  } catch (_e) {
    try { getLogger().warn('[Server] 長期記憶保存失敗: ' + _e.message); } catch { console.warn(_e); }
  } finally {
    clearTimeout(_timer);
  }

  _shutdownFinished = true;
  _log('[Server] 終了しました');
  // ログのファイル書き出しは非同期なので、書き終わるだけの間を置いてから落とす
  setTimeout(() => process.exit(0), 150);
};

process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));

/**
 * 「ディレクター＋パーソナリティ」型のチャンネル（Classic / Jazz / Mood / Beatles）を起動する。
 * ミキサーを作り、しゃべる間 BGM を下げる速さを決め、エージェントシステムを作って放送を始め、
 * WebSocket の接続処理まで配線する。
 *
 * @param {Record<string, any>} opts Cls（エージェントシステムのクラス）・wrapper・bgmDir・
 *   openingDir・wss・channelId・replayEvent
 * @returns {{ mixer: any, system: any }} 作ったミキサーとエージェントシステム
 */
function bootstrapChannel({ Cls, wrapper, bgmDir, openingDir, wss, channelId, replayEvent }) {
  const mixer = new AudioMixer({ bgmDir, openingDir, noDummyBgm: true });
  // BGM を下げる・戻す速さ。4チャンネル共通の値
  mixer.duckingSpeedDown = 0.08;
  mixer.duckingSpeedUp   = 0.05;
  const system = new Cls(mixer, wrapper);
  system.startShowLoop();
  setupChannelWss(wss, mixer, system, channelId, replayEvent);
  return { mixer, system };
}

// ロガーの初期化 → 各チャンネルの起動 → 接続の受付開始
(async () => {
  await createLogger();

  // ── Live チャンネル ─────────────────────────────────────────────────
  mixer = new AudioMixer();
  agentSystem = new AgentSystem(mixer, serverWrapper);
  agentSystem.startShowLoop();

  // ── Classic/Jazz/Mood/Beatles チャンネル ────────────────────────────
  ({ mixer: mixer_classic, system: classicSystem } = bootstrapChannel({
    Cls: ClassicAgentSystem, wrapper: classicServerWrapper,
    bgmDir: classicBgmDir, openingDir: classicOpeningDir,
    wss: wss_classic, channelId: 'Classic', replayEvent: 'CLASSIC_REPLAY_REQUEST',
  }));
  ({ mixer: mixer_jazz, system: jazzSystem } = bootstrapChannel({
    Cls: JazzAgentSystem, wrapper: jazzServerWrapper,
    bgmDir: jazzBgmDir, openingDir: jazzOpeningDir,
    wss: wss_jazz, channelId: 'Jazz', replayEvent: 'JAZZ_REPLAY_REQUEST',
  }));
  ({ mixer: mixer_mood, system: moodSystem } = bootstrapChannel({
    Cls: MoodAgentSystem, wrapper: moodServerWrapper,
    bgmDir: moodBgmDir, openingDir: moodOpeningDir,
    wss: wss_mood, channelId: 'Mood', replayEvent: 'MOOD_REPLAY_REQUEST',
  }));
  ({ mixer: mixer_beatles, system: beatlesSystem } = bootstrapChannel({
    Cls: BeatlesAgentSystem, wrapper: beatlesServerWrapper,
    bgmDir: beatlesBgmDir, openingDir: beatlesOpeningDir,
    wss: wss_beatles, channelId: 'Beatles', replayEvent: 'BEATLES_REPLAY_REQUEST',
  }));

  // ── 24/You チャンネル ────────────────────────────────────────────────
  // ナレーションも BGM も無く PCM 音声を配信しないため、ミキサーは空の代用品で足りる
  const mixer_24you = { registerClient: () => {} };
  twentyFourYouSystem = new TwentyFourYouAgentSystem(mixer_24you, twentyFourYouServerWrapper);
  twentyFourYouSystem.startShowLoop();
  setupChannelWss(wss_24you, mixer_24you, twentyFourYouSystem, '24You', '__NONE_24YOU_REPLAY__');

  // ── The Answers チャンネル ───────────────────────────────────────────
  // 議題が送られるまで待つという特殊な流れのため、bootstrapChannel は使わず手で配線する。
  // ATTENTION: BGM の置き場は The Answers 専用のオープニング曲のフォルダーに向けること。
  // 接続時に既定の BGM を鳴らす処理が Live 共通の BGM を拾ってしまうのを防ぐためと、
  // オープニング曲を繰り返し鳴らす際にもこのフォルダーを見るため。
  mixer_the_answers = new AudioMixer({
    bgmDir: path.join(__dirname, 'assets', 'channels', 'the_answers', 'bgm', 'opening'),
    noDummyBgm: true,
  });
  theAnswersSystem = new TheAnswersAgentSystem(mixer_the_answers, theAnswersServerWrapper);
  theAnswersSystem.startShowLoop(); // 議題が来るまでは何もしない

  // 前のプロセスが落ちた結果、開いたまま取り残された記録を閉じる
  activityDb.closeOrphanedSessions();
  // ATTENTION: 同じ理由で、処理中のまま残った裏方ヘルパーの仕事も失敗として確定させる。
  // そのままにすると「まだ処理中です」と永遠に答え続けてしまう。
  const _jobStore = require('./lib/secretary-job-store');
  _jobStore.failOrphanedJobs();
  // 裏方ヘルパーの仕事は会話のやり取りと無関係に動くため、状態をダッシュボードへ流さないと
  // 処理中でも「待機中」に見えてしまう。
  _jobStore.setDashboardNotifier((info) => {
    const data = { event: 'SECRETARY_HELPER_JOB', channel: 'secretary', ...info };
    updateDashboardSnapshot('secretary', data);
    broadcastToDashboard(data);
  });

  // ── 緊急地震速報の監視を開始 ────────────────────────────────────────
  const { startEarthquakeMonitor } = require('./earthquake-monitor');
  earthquakeMonitor = startEarthquakeMonitor(
    (data) => broadcastToAllClients(data),
    { configPath: CONFIG_PATH },
  );

  // ATTENTION: 読み仮名の辞書を読み終えてから接続の受付を始めること。初回の読み込みに
  // 20秒近くかかるため、先に受付を始めると、その間につないだリスナーには「つながっては
  // いるのに誰もしゃべらない」時間ができてしまう。起動がその分遅くなる代わりに、
  // このすれ違いを構造から無くしている。
  await require('./lib/dictionary-reading-format').warmUp();

  server.listen(PORT, () => {
    getLogger().info(`Server is running on http://localhost:${PORT}`);

    // 固定ドメインのトンネルが動いていなければ立ち上げる（外から届く必要のある機能で使う）。
    // 起動を待たせないよう、完了を待たずに呼ぶ。
    const currentConfig = readJsonFile(CONFIG_PATH, getInitialConfig());
    if (currentConfig.ngrok?.auto_start) {
      ensureNgrokRunning({ port: PORT, domain: currentConfig.ngrok.domain }).catch((e) => {
        getLogger().warn(`[ngrok] 自動起動処理の呼び出しに失敗: ${e.message}`);
      });
    }
  });
})();
