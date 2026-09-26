/**
 * @file プレーヤー画面（index.html）で使う型
 *
 * 管理画面（App.tsx）とは別のバンドルなので、プレーヤー画面の型はここにまとめる。
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

/** キーボードショートカット。code は KeyboardEvent.code（キーの物理的な位置。キー配列に左右されない）。 */
export interface ShortcutConfig {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}

/**
 * キーボードショートカットで行える操作。
 * ATTENTION: 管理画面（admin/types.ts）の同じ名前の型と既定値にそろえること。管理画面で設定した値がここで使われる。
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
  // Live のコーナーのリクエスト（Live を選んでいるときだけ効く）
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

export interface FullConfig {
  show: {
    theme: string;
    user_profile: { name: string; favorite_artists?: string[] };
    display?: {
      ticker?:   { enabled?: boolean; font_size_rem?: number; scroll_speed?: number };
      info_view?: { enabled?: boolean; world_report_zoom_start?: number; world_report_zoom?: number; zoom_duration_sec?: number };
    };
    // 討論コーナー（ニュースディープダイブなど）の設定。プレーヤー画面では name と enabled を使う
    discussion_corners?: Record<string, {
      name?: string; enabled?: boolean; frequency?: number; max_turns?: number; opening_jingle_ms?: number;
    }>;
  };
  agents: Record<string, { name: string; prompt: string; voice: string; pan: number }>;
  shortcuts?: Partial<Record<ShortcutAction, ShortcutConfig | null>>;
}

export interface CycleMonitor {
  current: string | null;
  next:    string | null;
  queue:   string[];
  recent:  string[];
}

export type CornerKey = 'weather' | 'traffic' | 'news' | 'finance' | 'activities'
  | 'commentator' | 'journalist' | 'music_dj' | 'life_advisor' | 'world_report' | 'legal_advisor'
  | 'comedian' | 'doctor' | 'marketer';

// ─── ティッカー型定義 ─────────────────────────────────────────────────────────
export type FinanceTickerItem = {
  key: string; price: number; diff: number; pct: number;
  unit: string; type: string; dec: number; priceLabel: string;
};
export type TickerData =
  | { type: 'finance'; items: FinanceTickerItem[] }
  | { type: 'weather'; location: string; temp: number; desc: string;
      todayMax: number; todayMin: number;
      tomorrow: { max: number; min: number; month: number; day: number } | null;
      hasTyphoon: boolean; typhoonSummary: string | null;
      hasWarning: boolean; warningSummary: string | null;
      hasQuake:   boolean; quakeSummary:   string | null;
      // 他県で発表中の特別警報（レベル5）。居住地の緊急情報とは別枠。
      hasNationalAlert?: boolean; nationalAlertSummary?: string | null; }
  | { type: 'news'; items: { title: string; label: string }[] }
  | { type: 'traffic'; location: string; areas: string[];
      nearestStation: string; airports: string[] }
  | { type: 'traffic_structured'; items: Array<{ category: 'road' | 'rail' | 'air'; text: string }> }
  | null;

// ─── InfoView型定義 ──────────────────────────────────────────────────────────
export type InfoViewData =
  | { type: 'world_report'; city: string; englishName: string }
  | { type: 'recipe'; name: string; description: string; ingredients: string[]; steps: string[]; imageBase64: string | null; imageMimeType?: string }
  | { type: 'weather_chart'; chartLabel: string; satelliteTime: string }
  | null;

// ─── 保存したレシピ ────────────────────────────────────────────────────
// 一覧の画像は URL（imageUrl）で参照する。imageBase64 は、放送から届いたまだ保存していないレシピで使う
export type SavedRecipe = { id: string; name: string; description: string; ingredients: string[]; steps: string[]; imageBase64: string | null; imageMimeType?: string; imageUrl?: string | null; notePath?: string; savedAt: string };

// ─── 音楽4チャンネル共通のアンコールリスト・リクエストキューの色 ───────────
export type ChannelListAccent = 'indigo' | 'amber' | 'blue' | 'red';

// ─── 24/You 選曲モード ────────────────────────────────────────────────────
export type TwentyFourYouMode = 'omakase' | 'anokoro' | 'artist' | 'shinpu' | 'wagamama';
export type TwentyFourYouLanguagePref = 'any' | 'japanese' | 'western';

// ─── 緊急地震速報オーバーレイ ─────────────────────────────────────────────
export type EarthquakeAlert = {
  hypocenter: string;
  magnitude: string;
  depth?: string;
  maxScale?: number;
  maxScaleLabel: string;
  areaNames: string[];
  alertText: string;
  issuedAt: string;
};

// ─── The Answers の出演者・挙手の状態 ────────────────────────────────────
// key は The Answers の中での poolKey（話している人を光らせるのに使う）、sourceAgentKey は元のチャンネルでの
// キー（アバターの画像 /avatars/${sourceAgentKey}.png はこちらで引く）
export type TheAnswersPanelMember = { key: string; sourceAgentKey: string; name: string; role: string; perspectiveType?: string };
export type TheAnswersHandState = 'idle' | 'waiting' | 'granted';
export type TheAnswersRoundTimer = { elapsedMs: number; targetMs: number; capMs: number };

// ─── Classic/Jazz/Mood/Beatles: 再生履歴・リクエストキューの楽曲情報 ───────────
export type ClassicTrack = { composer: string; composition: string; period?: string; spotify_query?: string; trackName?: string; performers?: string[]; albumName?: string; conductor?: string; ensemble?: string; playedAt?: string };
export type JazzTrack = { artist: string; title: string; period?: string; trackName?: string; performers?: string[]; albumName?: string; playedAt?: string };
export type MoodTrack = { artist: string; title: string; category?: string; composer?: string; film_title?: string; trackName?: string; performers?: string[]; albumName?: string; playedAt?: string };
export type BeatlesTrack = { title: string; album?: string; year?: string; trackName?: string; performers?: string[]; albumName?: string; playedAt?: string };
export type TwentyFourYouTrack = { title: string; artist: string; albumName?: string; albumImage?: string | null; releaseYear?: string | null; playedAt?: string };
