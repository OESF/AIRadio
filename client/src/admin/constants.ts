/**
 * @file 管理画面（admin.html）で使う定数（モデルの一覧・色・ショートカットの表示名・都道府県など）
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

import type { ChannelAccent, ShortcutAction, RecordableChannel, JournalistWatchlist } from './types';

/** 管理画面で選べる Gemini のテキストのモデル。 */
export const GEMINI_MODELS = [
  { value: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite  ⚡ 高速・低コスト' },
  { value: 'gemini-2.5-flash',      label: 'gemini-2.5-flash  🔵 標準（推奨）' },
  { value: 'gemini-2.5-pro',        label: 'gemini-2.5-pro  🟣 高精度' },
  { value: 'gemini-3.5-flash',      label: 'gemini-3.5-flash  🚀 最新・高性能（5×コスト）' },
];

/** 管理画面で選べる画像生成のモデル。 */
export const GEMINI_IMAGE_MODELS = [
  { value: 'gemini-2.5-flash-image',  label: 'gemini-2.5-flash-image  🍌 Nano Banana（標準）' },
  { value: 'gemini-3.1-flash-image',  label: 'gemini-3.1-flash-image  🍌🍌 Nano Banana 2（新世代）' },
  { value: 'gemini-3-pro-image',      label: 'gemini-3-pro-image  🍌👑 Nano Banana Pro（高品質）' },
];

// ─── 最大発話文字数の選択肢 ─────────────────────────────────────────────────
export const MAX_CHARS_OPTIONS = [
  { label: '無制限', value: 0 },
  { label: '100',   value: 100 },
  { label: '300',   value: 300 },
  { label: '500',   value: 500 },
];

// ─── 音楽4チャンネル共通のタブの色 ─────────────────────────────────────────
export const CHANNEL_ACCENT: Record<ChannelAccent, {
  icon: string; heading: string; musicIcon: string;
  llmBg: string; llmBorder: string; llmHeading: string;
  playingBorderClass: string;
  directionBg: string; directionBorder: string; directionText: string;
}> = {
  amber: {
    icon: '#d97706', heading: '#d97706', musicIcon: '#d97706',
    llmBg: 'rgba(245,158,11,0.04)', llmBorder: 'rgba(245,158,11,0.2)', llmHeading: '#fbbf24',
    playingBorderClass: 'border-yellow-400/60 text-yellow-300',
    directionBg: 'bg-amber-900/20', directionBorder: 'border-amber-700/30', directionText: 'text-amber-500',
  },
  blue: {
    icon: '#3b82f6', heading: '#60a5fa', musicIcon: '#1e3a5f',
    llmBg: 'rgba(59,130,246,0.08)', llmBorder: 'rgba(59,130,246,0.3)', llmHeading: '#60a5fa',
    playingBorderClass: 'border-blue-400/60 text-blue-300',
    directionBg: 'bg-blue-900/20', directionBorder: 'border-blue-700/30', directionText: 'text-blue-400',
  },
  red: {
    icon: '#ef4444', heading: '#f87171', musicIcon: '#b91c1c',
    llmBg: 'rgba(239,68,68,0.08)', llmBorder: 'rgba(239,68,68,0.3)', llmHeading: '#f87171',
    playingBorderClass: 'border-red-400/60 text-red-300',
    directionBg: 'bg-red-900/20', directionBorder: 'border-red-700/30', directionText: 'text-red-400',
  },
  cyan: {
    icon: '#0891b2', heading: '#22d3ee', musicIcon: '#0891b2',
    llmBg: 'rgba(8,145,178,0.08)', llmBorder: 'rgba(8,145,178,0.3)', llmHeading: '#22d3ee',
    playingBorderClass: 'border-cyan-400/60 text-cyan-300',
    directionBg: 'bg-cyan-900/20', directionBorder: 'border-cyan-700/30', directionText: 'text-cyan-400',
  },
};

/**
 * 日記のバッジの色の候補。エージェントのキーのハッシュで選ぶ（utils.tsx の diaryBadgeClass）。
 * チャンネルとエージェントの組み合わせはチャンネルが増えるたびに増えるので、手で色を決めない。
 */
export const DIARY_BADGE_PALETTE = [
  'bg-blue-900/50 text-blue-300', 'bg-pink-900/50 text-pink-300', 'bg-amber-900/50 text-amber-300',
  'bg-yellow-900/50 text-yellow-300', 'bg-cyan-900/50 text-cyan-300', 'bg-fuchsia-900/50 text-fuchsia-300',
  'bg-purple-900/50 text-purple-300', 'bg-green-900/50 text-green-300', 'bg-sky-900/50 text-sky-300',
  'bg-orange-900/50 text-orange-300', 'bg-emerald-900/50 text-emerald-300', 'bg-rose-900/50 text-rose-300',
];

/** ショートカットの操作の表示名。 */
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  open_inquiry:        '💬 お問い合わせ・リクエストを開く',
  mute_toggle:         '🔇 ミュート切替',
  volume_up:           '🔊 音量を上げる',
  volume_down:         '🔉 音量を下げる',
  toggle_connection:   '📡 接続 / 切断',
  show_recipes:        '📖 保存したレシピを開く',
  channel_live:        '📻 Liveに切り替え',
  channel_classic:     '🎼 Classicに切り替え',
  channel_jazz:        '🎷 Jazzに切り替え',
  channel_mood:        '🌙 Moodに切り替え',
  channel_beatles:     '🪲 Beatlesに切り替え',
  channel_24you:       '🔀 24/Youに切り替え',
  channel_the_answers: '🗣️ The Answersを選択',
  corner_weather:      '☀️ 【Live】天気コーナー',
  corner_traffic:      '🚗 【Live】交通コーナー',
  corner_news:         '📰 【Live】ニュースコーナー',
  corner_finance:      '💹 【Live】金融コーナー',
  corner_commentator:  '📚 【Live】コメンテーターコーナー',
  corner_journalist:   '🕵️ 【Live】X情報（ジャーナリスト）コーナー',
  corner_music_dj:     '🎧 【Live】DJコーナー',
  corner_life_advisor: '🌿 【Live】ライフコーナー',
  corner_world_report: '🌍 【Live】ワールドレポートコーナー',
  corner_legal_advisor:'⚖️ 【Live】法律コーナー',
  corner_comedian:     '🎤 【Live】世間ばなし（お笑い芸人）コーナー',
  corner_doctor:       '🩺 【Live】健康・医療（医師）コーナー',
  corner_marketer:     '💡 【Live】トレンド解析（マーケター）コーナー',
  corner_activities:   '📅 【Live】スケジュール確認',
};

/** ショートカットの設定画面での並び順。 */
export const SHORTCUT_ORDER: ShortcutAction[] = [
  'open_inquiry', 'mute_toggle', 'volume_up', 'volume_down', 'toggle_connection', 'show_recipes',
  'channel_live', 'channel_classic', 'channel_jazz', 'channel_mood', 'channel_beatles', 'channel_24you', 'channel_the_answers',
  'corner_weather', 'corner_traffic', 'corner_news', 'corner_finance', 'corner_commentator',
  'corner_journalist', 'corner_music_dj', 'corner_life_advisor', 'corner_world_report',
  'corner_legal_advisor', 'corner_comedian', 'corner_doctor', 'corner_marketer',
  'corner_activities',
];

/** ログのレベル（pino の数値）ごとの見た目。 */
export const SERVER_LOG_LEVEL_STYLE: Record<number, { badge: string; text: string }> = {
  10: { badge: 'bg-gray-700 text-gray-400',    text: 'text-gray-500'   },
  20: { badge: 'bg-cyan-900 text-cyan-300',    text: 'text-gray-400'   },
  30: { badge: 'bg-blue-900 text-blue-300',    text: 'text-gray-200'   },
  40: { badge: 'bg-yellow-900 text-yellow-300',text: 'text-yellow-200' },
  50: { badge: 'bg-red-900 text-red-300',      text: 'text-red-300'    },
  60: { badge: 'bg-red-700 text-white',        text: 'text-red-200 font-bold' },
};

// ─── 放送の録音 ─────────────────────────────────────────────────────────────
export const RECORDING_CHANNELS: { key: RecordableChannel; label: string }[] = [
  { key: 'all',         label: 'ALL（視聴中のチャンネルを自動録音）' },
  { key: 'live',        label: 'Live' },
  { key: 'classic',     label: 'Classic' },
  { key: 'jazz',        label: 'Jazz' },
  { key: 'mood',        label: 'Mood' },
  { key: 'beatles',     label: 'Beatles' },
  { key: 'the_answers', label: 'The Answers' },
  { key: 'secretary',   label: 'My Secretary（ALLモード非対応・個別に開始してください）' },
];

// ─── 稼働レポート ─────────────────────────────────────────────────────────
export const REPORT_PAGE_SIZE = 20;

// ─── The Answers アーカイブ ───────────────────────────────────────────────
export const ANSWERS_ARCHIVE_PAGE_SIZE = 20;
// ATTENTION: サーバーの ARCHIVE_SUMMARY_MIN_TRANSCRIPT_ENTRIES と同じ値にすること（要約ボタンを押せるかの判定）
export const ANSWERS_ARCHIVE_SUMMARY_MIN_TRANSCRIPT_ENTRIES = 5;

// ─── 緊急地震速報の絞り込みの都道府県（P2PQuake の areas[].pref と同じ表記） ───
export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県',
  '沖縄県',
];

// ─── Live のジャーナリストのウォッチリストの分類 ───────
export const JOURNALIST_CATEGORIES: { key: keyof JournalistWatchlist; label: string }[] = [
  { key: 'japan_official',     label: '🏛 日本政府・省庁' },
  { key: 'japan_politics',     label: '🎌 日本の政治家' },
  { key: 'us_official',        label: '🇺🇸 米国政府' },
  { key: 'us_politics',        label: '🇺🇸 米国の政治家' },
  { key: 'tech_business',      label: '💼 テック・ビジネス' },
  { key: 'world_leaders',      label: '🌍 世界の指導者' },
  { key: 'international_orgs', label: '🏢 国際機関' },
  { key: 'primary_wire',       label: '📰 一次通信社' },
  { key: 'sports',             label: '⚽ スポーツ' },
];
