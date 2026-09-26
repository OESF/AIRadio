/**
 * @file プレーヤー画面（index.html）で使う定数（チャンネルの一覧・コーナーの色とアイコンなど）
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

import type { CornerKey, ShortcutAction, ChannelListAccent } from './types';

// ─── 定数 ────────────────────────────────────────────────────────────────────

/** コーナーのアイコン。 */
export const CORNER_ICONS: Record<string, string> = {
  weather: '☀️', traffic: '🚗', news: '📰', finance: '💹',
  commentator: '📚', journalist: '🕵️', music_dj: '🎧',
  life_advisor: '🌿', world_report: '🌍', activities: '📅', legal_advisor: '⚖️',
  comedian: '🎤', doctor: '🩺', marketer: '💡',
};

/** コーナーの色。 */
export const CORNER_COLORS: Record<string, string> = {
  weather:     'border-sky-500/50 hover:border-sky-400 hover:bg-sky-500/15',
  traffic:     'border-yellow-500/50 hover:border-yellow-400 hover:bg-yellow-500/15',
  news:        'border-green-500/50 hover:border-green-400 hover:bg-green-500/15',
  finance:     'border-emerald-500/50 hover:border-emerald-400 hover:bg-emerald-500/15',
  commentator: 'border-orange-500/50 hover:border-orange-400 hover:bg-orange-500/15',
  journalist:  'border-red-500/50 hover:border-red-400 hover:bg-red-500/15',
  music_dj:    'border-pink-500/50 hover:border-pink-400 hover:bg-pink-500/15',
  life_advisor:'border-lime-500/50 hover:border-lime-400 hover:bg-lime-500/15',
  world_report:'border-cyan-500/50 hover:border-cyan-400 hover:bg-cyan-500/15',
  activities:    'border-purple-500/50 hover:border-purple-400 hover:bg-purple-500/15',
  legal_advisor: 'border-blue-500/50 hover:border-blue-400 hover:bg-blue-500/15',
  comedian:      'border-amber-500/50 hover:border-amber-400 hover:bg-amber-500/15',
  doctor:        'border-teal-500/50 hover:border-teal-400 hover:bg-teal-500/15',
  marketer:      'border-violet-500/50 hover:border-violet-400 hover:bg-violet-500/15',
};

/** コーナーの表示名。 */
export const CORNER_LABELS: Record<string, string> = {
  weather: '天気', traffic: '交通', news: 'ニュース', finance: '金融',
  music_dj: 'DJ', commentator: 'コメント', journalist: 'X情報',
  life_advisor: 'ライフ', world_report: 'ワールド', legal_advisor: '法律',
  comedian: '世間ばなし', doctor: '健康', marketer: 'トレンド',
  caster: 'トーク', assistant: 'トーク', activities: 'スケジュール',
};

/** コーナー → そのリクエストのショートカットの操作（ボタンの説明にショートカットを出すため）。 */
export const CORNER_SHORTCUT_ACTIONS: Record<CornerKey, ShortcutAction> = {
  weather: 'corner_weather', traffic: 'corner_traffic', news: 'corner_news',
  finance: 'corner_finance', commentator: 'corner_commentator', journalist: 'corner_journalist',
  music_dj: 'corner_music_dj', life_advisor: 'corner_life_advisor',
  world_report: 'corner_world_report', legal_advisor: 'corner_legal_advisor',
  comedian: 'corner_comedian', doctor: 'corner_doctor', marketer: 'corner_marketer',
  activities: 'corner_activities',
};

/** エージェントの色（話しているときに光らせる色）。 */
export const AGENT_GLOW: Record<string, string> = {
  caster:       'rgba(0,180,216,0.5)',
  assistant:    'rgba(157,78,221,0.5)',
  weather:      'rgba(56,189,248,0.5)',
  traffic:      'rgba(234,179,8,0.5)',
  news:         'rgba(34,197,94,0.5)',
  finance:      'rgba(16,185,129,0.5)',
  music_dj:     'rgba(236,72,153,0.5)',
  commentator:  'rgba(249,115,22,0.5)',
  journalist:   'rgba(239,68,68,0.5)',
  life_advisor: 'rgba(132,204,22,0.5)',
  world_report:  'rgba(6,182,212,0.5)',
  legal_advisor: 'rgba(59,130,246,0.5)',
  comedian:      'rgba(245,158,11,0.5)',
  doctor:        'rgba(20,184,166,0.5)',
  marketer:      'rgba(139,92,246,0.5)',
};

// ─── チャンネル ─────────────────────────────────────────────────────

// チャンネルの一覧。並び順はウェルカム画面でチャンネルを選ぶときの順番で、よく使い情報の多い
// Live → My Secretary → The Answers を上に、音楽チャンネルをその下に置く（ダッシュボードの上段と同じ）。
// 並び順に意味があるのはウェルカム画面だけで、他の画面は id で引く。
// 秘書のロゴはイラストが無いので、アバター（スーツ姿の女性）と合わせて絵文字の 👩‍💼 にしている。
export const CHANNELS = [
  {
    id:       'live' as const,
    name:     'AI Radio Live',
    subtitle: 'パーソナライズされたマルチエージェントAIラジオ',
    wsPath:   '/stream',
    color:    '#7c3aed',
    emoji:    '📻',
  },
  {
    id:       'secretary' as const,
    name:     'My Secretary',
    subtitle: 'あなた専属のAI秘書と、声でリアルタイムに会話する',
    wsPath:   '/stream-secretary',
    color:    '#a855f7',
    emoji:    '👩‍💼',
  },
  {
    id:       'the_answers' as const,
    name:     'The Answers',
    subtitle: '答えは一つじゃない — マルチアングル・ディスカッション',
    wsPath:   '/stream-the-answers',
    color:    '#0891b2',
    emoji:    '🗣️',
  },
  {
    id:       'classic' as const,
    name:     '静寂のスコア',
    subtitle: 'しじまのスコア — クラシック音楽専門チャンネル',
    wsPath:   '/stream-classic',
    color:    '#b45309',
    emoji:    '🎼',
  },
  {
    id:       'jazz' as const,
    name:     '琥珀色のインプロヴィゼーション',
    subtitle: 'こはくいろのインプロヴィゼーション — Jazz Music Channel',
    wsPath:   '/stream-jazz',
    color:    '#92400e',
    emoji:    '🎷',
  },
  {
    id:       'mood' as const,
    name:     'トワイライト・ラウンジ',
    subtitle: 'ムードミュージックと映画音楽の夕べ',
    wsPath:   '/stream-mood',
    color:    '#1e3a5f',
    emoji:    '🌙',
  },
  {
    id:       'beatles' as const,
    name:     'Eight Days A Week',
    subtitle: '週に7日じゃ足りない。僕らには、8日目のビートルズがある。',
    wsPath:   '/stream-beatles',
    color:    '#b91c1c',
    emoji:    '🪲',
  },
  {
    id:       '24you' as const,
    name:     '24/You',
    subtitle: '言葉はいらない。AIが選ぶ、あなたのための24時間。',
    wsPath:   '/stream-24you',
    color:    '#0d9488',
    emoji:    '🔀',
  },
] as const;

export type ChannelId = typeof CHANNELS[number]['id'];

// ロゴのファイル名が `${channelId}_logo.png` の規則と違うチャンネルだけ、ここで指定する
export const CHANNEL_LOGO_FILE: Partial<Record<ChannelId, string>> = {
  the_answers: 'answers',
};

/** アンコールリストの色（色の名前 → 背景・枠・文字）。 */
export const PLAYED_ACCENT: Record<ChannelListAccent, { bg: string; border: string; color: string }> = {
  indigo: { bg: 'rgba(79,70,229,0.2)', border: 'rgba(99,102,241,0.3)', color: '#818cf8' },
  amber:  { bg: 'rgba(180,83,9,0.2)',  border: 'rgba(217,119,6,0.3)',  color: '#d97706' },
  blue:   { bg: 'rgba(30,58,95,0.4)',  border: 'rgba(59,130,246,0.3)', color: '#60a5fa' },
  red:    { bg: 'rgba(185,28,28,0.2)', border: 'rgba(239,68,68,0.3)',  color: '#ef4444' },
};
/** リクエストキューの色。 */
export const QUEUE_ACCENT: Record<ChannelListAccent, { bg: string; border: string; color: string }> = {
  indigo: { bg: 'rgba(79,70,229,0.3)', border: 'rgba(99,102,241,0.4)', color: '#818cf8' },
  amber:  { bg: 'rgba(180,83,9,0.3)',  border: 'rgba(217,119,6,0.4)',  color: '#d97706' },
  blue:   { bg: 'rgba(30,58,95,0.4)',  border: 'rgba(59,130,246,0.3)', color: '#60a5fa' },
  red:    { bg: 'rgba(185,28,28,0.3)', border: 'rgba(239,68,68,0.3)',  color: '#ef4444' },
};
