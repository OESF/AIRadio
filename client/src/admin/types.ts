/**
 * @file 管理画面（admin.html）で使う型の定義
 *
 * 設定（config.json とチャンネルごとの config.json）・認証情報・発声辞書・ログ・録音・稼働レポートなど、
 * 管理画面がサーバーとやり取りするデータの形と、キーボードショートカットの既定値を定める。
 * プレイヤー（Player.tsx）とは別のバンドルなので、管理画面だけが使う。
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

// ─── Gemini TTS 6フィールドコンポーネント用 ───────────────────────────────────
export type GeminiTtsAgent = {
  gemini_voice?: string; gemini_language?: string;
  tts_profile_title?: string; tts_scene?: string; tts_style?: string;
  tts_accent?: string; tts_pacing?: string; tts_context?: string;
  gemini_instruction?: string;
};
export type LangOption = { label: string; value: string };

// ─── BGM共通ファイル型 ────────────────────────────────────────────────────────
export type BgmFile = { filename: string; size: number };

// ─── Classic/Jazz/Mood/Beatles チャンネル設定 ─────────────────────────────────
// 4チャンネルとも「ディレクター＋パーソナリティ」の同じ構成なので、エージェントの形は ChannelAgentShape を共用する。
export type ClassicConfig = {
  channel_id: string;
  program: {
    name: string; name_reading: string; description: string;
    gemini_model: string;
    music_play_minutes: number; pieces_per_session: number; spotify_enabled: boolean;
    tts_test_text?: string;
  };
  agents: { classic_director: ChannelAgentShape; classic_personality: ChannelAgentShape };
};

export type JazzConfig = {
  channel_id: string;
  program: {
    name: string; name_reading: string; description: string;
    gemini_model: string;
    music_play_minutes: number; pieces_per_session: number; spotify_enabled: boolean;
    tts_test_text?: string;
    caption_enabled?: boolean; caption_speed?: number;
  };
  agents: { jazz_director: ChannelAgentShape; jazz_personality: ChannelAgentShape };
};

export type MoodConfig = {
  channel_id: string;
  program: {
    name: string; name_reading: string; description: string;
    gemini_model: string;
    music_play_minutes: number; pieces_per_session: number; spotify_enabled: boolean;
    tts_test_text?: string;
  };
  agents: { mood_director: ChannelAgentShape; mood_personality: ChannelAgentShape };
};

export type BeatlesConfig = {
  channel_id: string;
  program: {
    name: string; name_reading: string; description: string;
    gemini_model: string;
    music_play_minutes: number; pieces_per_session: number; spotify_enabled: boolean;
    tts_test_text?: string;
  };
  agents: { beatles_director: ChannelAgentShape; beatles_personality: ChannelAgentShape };
};

// ─── 24/You チャンネル設定（ナレーション・エージェント・BGMなし） ─────────────
export type TwentyFourYouConfig = {
  channel_id: string;
  program: {
    name: string; name_reading: string; description: string;
    gemini_model: string;
    selection_mode: 'omakase' | 'anokoro' | 'artist' | 'shinpu' | 'wagamama';
    anokoro_age: number | null;
    favorite_artists?: string[];
    wagamama_request?: string;
    language_pref?: 'any' | 'japanese' | 'western';
  };
};

// ─── Classic/Jazz/Mood/Beatles 共通タブ用 ─────────────────────────────────────
// この4チャンネルは「ディレクター＋パーソナリティ」の同じ構成なので、タブの画面を共通にしている。
export type ChannelAccent = 'amber' | 'blue' | 'red' | 'cyan';

export type ChannelAgentShape = {
  name: string; role: string; volume: number; pan: number; prompt: string;
  tts_engine?: string; gemini_tts_model?: string; gemini_voice?: string; gemini_language?: string; gemini_instruction?: string;
  tts_profile_title?: string; tts_scene?: string; tts_style?: string; tts_accent?: string; tts_pacing?: string; tts_context?: string;
  max_chars?: number; gemini_model?: string;
};

// ─── The Answers チャンネル設定（マルチアングル・ディスカッション） ───────────
// director はほかのチャンネルと同じ単体のエージェント。panelist_pool は、ほかのチャンネルの config.json の
// エージェントを指す参照と、追加の情報（隠れた才能・tts_pacing の上書き・多様性のための属性）だけを持つ。
export type TheAnswersDirectorAgent = ChannelAgentShape;

export type TheAnswersPanelistEntry = {
  sourceChannel: string; sourceAgentKey: string;
  always_include?: boolean; hidden_talent_prompt: string; tts_pacing_override: string;
  rotation_eligible?: boolean;
  opinion_research_default?: boolean;
  // パネルの人選で多様性をそろえるための属性（ディレクターの人選のプロンプトに出す）
  gender?: string; age_bracket?: string; marital_status?: string; political_stance?: string;
  // 出身地（地域差が関わる身近なテーマでは、本人の発言にも反映される）
  hometown_region?: string;
  // 視点の種類（専門家ばかりに偏らせないための分類。人選のプロンプトに出す）
  perspective_type?: string;
};

export type TheAnswersConfig = {
  channel_id: string;
  program: {
    name: string; name_reading: string; description: string; gemini_model: string;
    current_instruction: string; session_target_minutes: number; session_max_minutes: number;
    panelist_count_min?: number; panelist_count_max?: number; rotation_lookback_episodes?: number;
    tts_test_text?: string;
  };
  director: TheAnswersDirectorAgent;
  panelist_pool: Record<string, TheAnswersPanelistEntry>;
};

export type TheAnswersBgmAll = { opening: BgmFile[]; main: BgmFile[]; ending: BgmFile[] } | null;

export type TheAnswersArchiveSummary = { summary: string; highlights: string[]; generatedAt: string };

export type TheAnswersHistoryEntry = {
  id: string; theme: string; panelKeys: string[]; playedAt: string; interrupted?: boolean;
  transcript?: { speaker: string; text: string; ts: number }[];
  recordingFilename?: string | null; recordingSizeBytes?: number;
  summary?: TheAnswersArchiveSummary | null;
};

export interface DiaryEntry { channel: string; agentKey: string; agentName: string; corner: string | null; time: string; text: string; }

/** キーボードショートカット1つの形。code は KeyboardEvent.code（物理的なキーの位置で、キー配列に左右されない）。 */
export interface ShortcutConfig {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}

/**
 * キーボードショートカットで行える操作の一覧（マウスを使わずに一通り操作できるように）。
 * ATTENTION: client/src/Player.tsx 側の同じ名前の型・既定値と、必ず同じにしておくこと。
 */
export type ShortcutAction =
  | 'open_inquiry' | 'mute_toggle' | 'volume_up' | 'volume_down'
  | 'toggle_connection' | 'show_recipes'
  | 'channel_live' | 'channel_classic' | 'channel_jazz' | 'channel_mood'
  | 'channel_beatles' | 'channel_24you' | 'channel_the_answers'
  | 'corner_weather' | 'corner_traffic' | 'corner_news' | 'corner_finance'
  | 'corner_commentator' | 'corner_journalist' | 'corner_music_dj'
  | 'corner_life_advisor' | 'corner_world_report' | 'corner_legal_advisor'
  | 'corner_comedian' | 'corner_doctor' | 'corner_marketer' | 'corner_activities';

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, ShortcutConfig> = {
  open_inquiry:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyM' },
  mute_toggle:         { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyU' },
  volume_up:           { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'ArrowUp' },
  volume_down:         { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'ArrowDown' },
  toggle_connection:   { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyX' },
  show_recipes:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyR' },
  channel_live:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit1' },
  channel_classic:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit2' },
  channel_jazz:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit3' },
  channel_mood:        { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit4' },
  channel_beatles:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit5' },
  channel_24you:       { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit6' },
  channel_the_answers: { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'Digit7' },
  corner_weather:      { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyW' },
  corner_traffic:      { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyT' },
  corner_news:         { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyN' },
  corner_finance:      { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyF' },
  corner_commentator:  { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyC' },
  corner_journalist:   { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyJ' },
  corner_music_dj:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyD' },
  corner_life_advisor: { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyL' },
  corner_world_report: { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyG' },
  corner_legal_advisor:{ ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyH' },
  corner_comedian:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyB' },
  corner_doctor:       { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyE' },
  corner_marketer:     { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyK' },
  corner_activities:   { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, code: 'KeyS' },
};

export interface AgentConfig {
  name: string;
  prompt: string;
  voice: string;
  pan: number;
  volume?: number;            // 音量倍率: 0.1(小)〜2.0(大)、デフォルト 1.0
  gemini_model?: string;        // 未設定 = グローバル設定（show.gemini_model）に従う
  tts_engine?: string;          // 'gemini'（デフォルト・実質唯一の値）
  gemini_tts_model?: string;
  gemini_voice?: string;
  gemini_language?: string;
  gemini_instruction?: string;  // 旧フィールド（後方互換）
  tts_profile_title?: string;   // Audio Profile タイトル
  tts_scene?: string;           // スタジオ・場所の情景描写
  tts_style?: string;           // 声のスタイル・トーン
  tts_accent?: string;          // アクセント・出身地
  tts_pacing?: string;          // 話すテンポ・リズム
  tts_context?: string;         // キャラクターの役割説明
  max_chars?: number;           // 最大発話文字数（0または未設定=無制限）
}

export interface TempStay {
  location: string;    // 滞在地名（例: "白馬村"）
  purpose: string;     // 出張 / レジャー / その他
  start: string;       // YYYY-MM-DD
  end: string;         // YYYY-MM-DD
  timezone: string;    // 例: "Asia/Tokyo", "America/New_York"
  note?: string;       // 自由メモ
}

export interface SpecialDate {
  start: string;       // MM-DD（例: "12-23"）
  end: string;         // MM-DD（例: "12-25"）単日は start と同じ
  label: string;       // 表示名（例: "クリスマス"）
  instruction: string; // 番組への指示（例: "クリスマス特集コーナーを盛大に！"）
  personal?: boolean;  // true: リスナー個人・家族の記念日（誕生日等） / false: 誰にとっても共通の行事（クリスマス等）
}

export interface GmailFilter {
  exclude_promotions: boolean;  // プロモーション（通販・クーポン等）除外
  exclude_social: boolean;      // SNS通知除外
  exclude_updates: boolean;     // サービス更新通知除外
  exclude_forums: boolean;      // フォーラム通知除外
  max_fetch: number;            // API取得最大件数（5〜20）
  max_announce: number;         // 一度に紹介する件数（1〜10）
}

export interface DisplayConfig {
  ticker?: { enabled?: boolean; font_size_rem?: number; scroll_speed?: number };
  info_view?: { enabled?: boolean; world_report_zoom_start?: number; world_report_zoom?: number; zoom_duration_sec?: number };
}

export interface EarthquakeFilter {
  enabled: boolean; // true: prefで指定した都道府県が対象エリアに含まれる速報のみ通知
  pref: string;     // 都道府県名（例: "東京都"）。P2PQuakeのareas[].prefと同じ表記
}

export interface ShowConfig {
  atmosphere: string;
  theme: string;
  skip_opening?: boolean;       // オープニングをスキップ（Live 専用）
  force_first_corner?: string;  // 最初のコーナーを固定（Live 専用、空文字 = 自動）
  gemini_model: string;         // グローバルデフォルトモデル（エージェント個別設定がない場合に使用）
  gmail_filter?: GmailFilter; // Gmail フィルタ設定
  earthquake_filter?: EarthquakeFilter; // 緊急地震速報フィルタ設定
  display?: DisplayConfig; // 情報表示設定（ティッカー・InfoView）
  user_profile: {
    name: string;
    name_reading?: string;  // 名前の読み方（ひらがな）。TTSでの発音指定に使用（My Secretary等）。short_name設定時は未使用
    short_name?: string;    // My Secretaryが呼びかけに使う短い名前（姓だけ・「さん」無し）。フルネームの発音が不安定な場合の回避策
    birthday: string;       // YYYY-MM-DD (または旧フォーマット MM-DD)
    location: string;
    nearest_station: string;
    traffic_areas: string[];
    occupation: string;     // 職業
    hobbies: string;        // 趣味
    interests: string;      // 興味のあること
    interest_topic?: string; // 報道センターで一般ニュースの後に必ず1件追加してほしい関心トピック（例: AIテクノロジー（海外含む））
    // 音楽の好み（音楽DJの選曲に使う）
    music_genres?: string[];      // 好きなジャンル（カンマ区切りで複数）
    favorite_artists?: string[];  // 好きなアーティスト名（カンマ区切りで複数）
    music_notes?: string;         // その他の音楽メモ（自由記述）
    // 特別な日（期間対応）
    special_dates?: SpecialDate[];
    // 1日の開始時刻（再接続時の挨拶省略判定に使用）
    day_start_hour?: number;
  };

  // 同一ニュースの各社読み比べ（報道センターの締めくくり1件＋コメンテーターの論評材料）。
  // 未設定なら既定の8媒体（NHK・全国紙5紙・通信社2社）で有効。
  media_compare?: {
    enabled?: boolean;
    outlets?: { name: string; domain: string }[];
  };

  current_instruction: string;
  tts_test_text?: string;
  temp_stay?: TempStay; // 臨時滞在地（設定期間中は天気・交通・コンテキストが切り替わる）
  conversation_exchanges?: number; // キャスターとアシスタントの掛け合いの往復の上限 1〜4、既定 4（キャスターが自動で判断）
  corner_queue_max?: number;       // コーナーリクエストキュー上限 1〜5、デフォルト 3
}

// ─── My Secretary: 自律監視ループ ─────────────────────────────────────────
export interface SecretaryLoopConfig {
  enabled: boolean;
  check_interval_minutes: number;
  quiet_hours_start: string; // "HH:MM"
  quiet_hours_end: string;   // "HH:MM"
  cooldown_minutes_after_session: number;
  calendar_lookahead_minutes: number;
  finance_change_threshold_pct: number;
  finance_fund_change_threshold_pct: number;
  sources: {
    email: boolean;
    calendar: boolean;
    weather: boolean;
    news: boolean;
    finance: boolean;
  };
}

// ─── My Secretary: Obsidian連携 ──────────────────────────────────────────
export interface ObsidianConfig {
  enabled: boolean;
  vault_path: string;
  inbox_folder: string;
  notes_folder: string;
  // レシピの保存先。画像はこの下の images/ へ JPEG で書き出される
  recipes_folder: string;
  projects_folder: string;
  daily_notes_folder: string;
  templates_folder: string;
  daily_note_template: string;
  auto_daily_report: boolean;
  weekly_notes_folder: string;
  weekly_note_template: string;
  rakuten_screenshot_folder: string;
  paypay_screenshot_folder: string;
  // 資産台帳（Googleスプレッドシート）のURL。スクリーンショットが「今の残高」なのに対し、
  // こちらは週ごとの時価評価額が長く溜まった時系列のデータ。
  asset_ledger_sheet_url: string;
  outbox_folder: string;
}

// ─── My Secretary: LINE連携 ──────────────────────────────────────────────
export interface LineConfig {
  enabled: boolean;
  authorized_user_id: string;
  last_unauthorized_sender_id: string;
}

// ─── ngrokトンネル自動起動 ──────────────────────────────────────────────────
// LINE 専用ではなく「ローカルのサーバーを外へ公開する」汎用の仕組みなので、line とは別のトップレベルの設定にしている。
export interface NgrokConfig {
  auto_start: boolean;
  domain: string;
}

export interface FullConfig {
  show: ShowConfig;
  agents: Record<string, AgentConfig>;
  shortcuts?: Partial<Record<ShortcutAction, ShortcutConfig | null>>;
  secretary_loop?: SecretaryLoopConfig;
  obsidian?: ObsidianConfig;
  line?: LineConfig;
  ngrok?: NgrokConfig;
  // スライドのテンプレートの登録。テンプレートはユーザーが Google Slides で作る資産で、
  // ここに登録するのはファイルの ID だけ（複数あるときは名前と用途のメモも）。
  presentation?: PresentationConfig;
}

export type PresentationTemplate = {
  id: string;
  presentation_id: string;
  // 名前と用途メモは、テンプレートが複数あるとき「どれで作るか」をAIが選ぶためだけに使う。
  // 1つしか登録していない間は使われないため、管理画面でも入力欄を出さない。
  name?: string;
  description?: string;
};

export type PresentationConfig = {
  templates?: PresentationTemplate[];
  default_template?: string;
};

// ─── Live: 金融ウォッチリスト ─────────────────────────────────────────────
export type WatchItem = { symbol: string; name: string; unit: string; type: string; dec: number; enabled: boolean };
// リスナー個人が持っているファンド・株式。投資信託は symbol を持たないので、symbol ではなく
// name（登録するときに重複しないことを確かめている）で1件を見分ける。
export type PersonalHoldingItem = {
  name: string; institution: string; kind: 'fund' | 'stock';
  symbol: string | null; fund_code: string | null;
  unit: string; dec: number; enabled: boolean; type?: string; note?: string;
};
export type FinanceWatchlist = {
  indices: WatchItem[]; forex: WatchItem[]; bonds: WatchItem[];
  commodities: WatchItem[]; stocks: WatchItem[];
  personal_holdings: PersonalHoldingItem[];
};

// ─── Live: ジャーナリストのウォッチリスト ───────────────────────────────────
export type JournalistWatchItem = { name: string; x_handle: string | null };
export type JournalistWatchlist = {
  japan_official: JournalistWatchItem[]; japan_politics: JournalistWatchItem[];
  us_official: JournalistWatchItem[];    us_politics: JournalistWatchItem[];
  tech_business: JournalistWatchItem[];  world_leaders: JournalistWatchItem[];
  international_orgs: JournalistWatchItem[]; primary_wire: JournalistWatchItem[];
  sports: JournalistWatchItem[];
};

// ─── Live: 全 BGM カテゴリ（/api/bgm/all） ────────────────────────────────
export type BgmAll = {
  main:    { files: BgmFile[]; current: string | null };
  opening: BgmFile[];
  world_report: {
    jingles: BgmFile[];
    ambient: Record<string, BgmFile[]>;
  };
} | null;

export interface Credentials {
  gemini: { api_key: string; tts_model?: string; model?: string; image_model?: string };
  google: { client_id: string; client_secret: string; refresh_token: string };
  spotify: { client_id: string; client_secret: string; refresh_token: string };
  openweathermap: { api_key: string };
  youtube: { api_key: string };
  line: { channel_access_token: string; channel_secret: string };
}

export interface TtsDictEntry {
  id: number;
  pattern: string;
  flags: string;
  replacement: string;
  note: string;
  enabled: boolean;
}

export interface LogEntry {
  type: 'info' | 'event' | 'warn' | 'err' | 'tts';
  message: string;
  time: string;
}

// サーバーファイルログ（pino JSON 形式）
export interface ServerLogEntry {
  time: string;    // ISO timestamp
  level: number;   // 10=trace 20=debug 30=info 40=warn 50=error 60=fatal
  label: string;   // 'INFO' etc.
  msg: string;
}

// ─── システム管理（番組録音）───────────────────────────────────────────────
export type RecordableChannel = 'all' | 'live' | 'classic' | 'jazz' | 'mood' | 'beatles' | 'the_answers' | 'secretary';

export interface RecordingEntry {
  id: string; channel: string; filename: string;
  startedAt: number; endedAt: number; durationSec: number; skippedSec: number; sizeBytes: number;
}

// ─── システム管理（会話履歴ビューア）───────────────────────────────────────
export interface ConversationEntry { time: number; agentKey: string; agentName: string; text: string; }

// ─── システム管理（稼働レポート）───────────────────────────────────────────
export type ReportSession = {
  id: number; channel: string; started_at: number; ended_at: number | null;
  songs: number; llm_chat: number; llm_image: number; tts_gemini: number; tts_aivis: number;
  corners: number; agent_turns: number; errors: number;
};
export type ReportEvent = {
  id: number; session_id: number; event_type: string; ts: number;
  agent: string | null; duration_ms: number | null; chars: number | null; metadata: Record<string, unknown> | null;
};
export type ReportDetail = {
  session: ReportSession;
  events: ReportEvent[];
  stats: Record<string, number>;
  cornerBreakdown: { name: string; cnt: number }[];
  agentBreakdown:  { agent: string; cnt: number }[];
};
export type ReportSummary = {
  total_sessions: number; total_listen_ms: number; total_songs: number;
  total_llm_chat: number; total_llm_image: number; total_tts_gemini: number; total_tts_aivis: number;
  total_corners: number; total_errors: number;
  byChannel: { channel: string; sessions: number; listen_ms: number }[];
};
export type CostBreakdownEntry = {
  key: string; count: number; llmCount: number; ttsCount: number;
  promptTokens: number; outputTokens: number; thoughtsTokens: number;
  costUsd: number; costUnknown: boolean;
};
export type ReportCostBreakdown = {
  byModel: CostBreakdownEntry[];
  byAgent: CostBreakdownEntry[];
};
