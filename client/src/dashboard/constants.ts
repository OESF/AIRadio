/**
 * @file ダッシュボードで使う定数と小さな関数（コーナーの表示・名前の短縮・色のコントラスト補正など）
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

import type { CSSProperties } from 'react';
import { CHANNELS, CORNER_LABELS as PLAYER_CORNER_LABELS } from '../player/constants';
import { getAgentEmoji, parseAgentName } from '../player/utils';
import type { DiscussionSettings } from './types';

/**
 * コーナーの表示名を返す。プレーヤー画面のコーナーリクエストのボタン（player/constants.ts の CORNER_LABELS）と
 * そろえる（ダッシュボード独自の長い名前だと折り返してしまう）。討論コーナーは既定の名前を使う。
 * @param key コーナーのキー
 */
export function cornerLabel(key: string | null | undefined): string {
  if (!key) return '—';
  if (key === IDLE_TOKEN_HOLDER) return 'コーナー外（待機中）';
  return PLAYER_CORNER_LABELS[key] ?? DISCUSSION_CORNER_META[key]?.defaultName ?? key;
}

/** コーナーの絵文字。討論コーナーは担当エージェントを持たないため専用の絵文字にする。 */
export function cornerEmoji(key: string): string {
  return DISCUSSION_CORNER_META[key]?.emoji ?? getAgentEmoji(key);
}

/**
 * サーバーの currentTokenHolder（今マイクを持っている人）の、「誰のコーナーでもない」ときの値。
 * BUGFIX: これをコーナーとして扱わないこと。以前は「コーナー: director」と内部のキーがそのまま表示された。
 */
const IDLE_TOKEN_HOLDER = 'director';

/** 実際に放送中のコーナーを指しているか（待機中の値なら false）。 */
export function isCornerKey(key: string | null | undefined): key is string {
  return !!key && key !== IDLE_TOKEN_HOLDER;
}

/**
 * 「名前（役職）」の形の名前から、役職を落として短くする（例:「山田太郎（ディレクター）」→「山田太郎」）。
 * カードは幅が狭く、名前が長いとアバターの下で箱の高さが変わるため。CSS の1行省略（infoLineStyle）と一緒に使う。
 * @param fullName 設定の名前
 */
export function shortAgentName(fullName: string): string {
  return parseAgentName(fullName).displayName;
}

/**
 * カードの情報の行（コーナー・再生中の曲など）を1行に収めて省略する見た目。
 */
export const infoLineStyle: CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

// パネルの高さは dashboard.css（.dash-main-panel）で決めている（画面の幅で段組みを変えるのにメディアクエリが要り、
// インラインでは書けないため）。

/**
 * 補足の文字の色。パネルの背景 rgb(35,35,35) に対して、WCAG AA（4.5:1）を満たす明るさ（約4.9:1）にしている
 * （以前の #64748b は 3.3:1 で読みづらかった）。
 */
export const DIM_TEXT = '#8391a7';

/** Live のチャンネルの色（塗りと枠に使う）。 */
export const LIVE_COLOR = CHANNELS.find((c) => c.id === 'live')?.color ?? '#7c3aed';
/**
 * Live の小さな文字に使う色。チャンネルの色（#7c3aed）は文字に使うと背景に対して 2.76:1 しかなく読みづらいので、
 * 同じ紫で明るくしたもの（5.78:1）を使う。
 */
export const LIVE_TEXT_COLOR = '#a78bfa';

/** 「21:15」。今日でなければ「9/14 21:15」。 */
export function formatClock(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 最後の接続を「8/20 21:15〜21:47」の形にする。今日かどうかに関わらず日付は必ず出す（いつのことかがすぐ分かるように）。
 * 接続中なら「〜（接続中）」、日をまたいだら終わりにも日付を付ける。
 * @param session 最後の接続
 * @returns 接続の記録が無ければ null
 */
export function formatLastSession(session: { start: number; end: number | null } | null | undefined): string | null {
  if (!session) return null;
  const start = new Date(session.start);
  const dateStr = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const timeStr = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (session.end === null) return `${dateStr(start)} ${timeStr(start)}〜（接続中）`;
  const end = new Date(session.end);
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${dateStr(start)} ${timeStr(start)}〜${timeStr(end)}`
    : `${dateStr(start)} ${timeStr(start)}〜${dateStr(end)} ${timeStr(end)}`;
}

/**
 * 24/You の選曲モードの表示名。プレーヤー画面の TwentyFourYouRequestPanel.tsx のボタンとそろえる。
 */
export const TWENTYFOURYOU_MODE_LABELS: Record<string, string> = {
  omakase: 'おまかせ', anokoro: 'あの頃', artist: '歌手', shinpu: '新譜', wagamama: 'わがまま',
};

/**
 * 小さなタイルで並べるチャンネル（Live・My Secretary・The Answers は情報が多いので、上段に大きく固定する）。
 * 表示名・色・絵文字は player/constants.ts の CHANNELS を使う。
 */
export const DASHBOARD_SUB_CHANNEL_IDS = ['classic', 'jazz', 'mood', 'beatles', '24you'] as const;

// ── Live の討論コーナー ─────────────────────────────────────────
// サーバーの DISCUSSION_CORNERS（server/lib/agent-discussion-corner.js）と対になる表。名前は
// config.show.discussion_corners.<key>.name で変えられるので、ここの名前は設定が読めないときの既定。
// after は、どのコーナーの後に続くか。
export const DISCUSSION_CORNER_META: Record<string, { defaultName: string; emoji: string; after: string }> = {
  news_deep_dive: { defaultName: 'ニュースディープダイブ', emoji: '🔍', after: 'news' },
  insight_money:  { defaultName: 'インサイト・マネー',     emoji: '💹', after: 'finance' },
};
export const DISCUSSION_CORNER_KEYS = Object.keys(DISCUSSION_CORNER_META);

/**
 * 台本の役割（_buildDiscussionPlan の role）→ 短い表示。
 */
export const DISCUSSION_ROLE_LABELS: Record<string, string> = {
  open: '開幕', factcheck: '事実', analyze: '分析', challenge: '反論', rebut: '再反論',
  push: '突っ込み', question: '疑問', answer: '回答', close: '締め',
};

/** オンか。項目が無い古い config.json では放送側と同じくオン扱い（readDiscussionConfig と同じ判定）。 */
export function discussionEnabled(settings: DiscussionSettings | null, key: string): boolean {
  return settings?.[key]?.enabled !== false;
}

/** 討論コーナーの名前（設定 → fallback → 既定の名前の順）。 */
export function discussionName(settings: DiscussionSettings | null, key: string, fallback?: string): string {
  const name = settings?.[key]?.name?.trim();
  return name || fallback || DISCUSSION_CORNER_META[key]?.defaultName || key;
}

/** 「毎回」「2回に1回」。frequency=0 は緊急停止用の値。 */
export function discussionFrequencyLabel(settings: DiscussionSettings | null, key: string): string {
  const f = settings?.[key]?.frequency;
  if (f === 0) return '停止中';
  if (typeof f === 'number' && f > 1) return `${f}回に1回`;
  return '毎回';
}

// ── 暗い背景の小さな文字のための色の補正 ──────────────────────────────────
// CHANNELS の色は塗りや枠で映えるように選んであり、小さな文字に使うとコントラストが足りないものがある
// （できごとの記録の背景に対して、Live は 3.60:1、静寂のスコアは 4.08:1 で、WCAG AA の 4.5:1 に届かない）。
// 色味を保ったまま白に寄せて、基準を満たす明るさにする。
const FEED_BG: [number, number, number] = [2, 4, 10];
// ATTENTION: パネル（glass-panel）の上とできごとの記録の上で、補正を使い分けること。パネルはページの背景と重なると
//            rgb(35,35,35) になり、できごとの記録より明るいので、記録用の補正のまま使うと基準を割る
//            （実測で8チャンネルすべて届かなかった）。
const PANEL_BG: [number, number, number] = [35, 35, 35];

/** "#rrggbb" を [r, g, b] にする。 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** 相対輝度（WCAG の計算式）。 */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 2つの色のコントラスト比（WCAG）。 */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** 指定した背景の上で読める明るさまで、色味を保ったまま白へ寄せる。 */
function readableOn(hex: string | undefined, bg: [number, number, number], minRatio: number): string {
  if (!hex || !/^#[0-9a-fA-F]{3,6}$/.test(hex)) return '#94a3b8';
  const base = hexToRgb(hex);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const mixed: [number, number, number] = [
      Math.round(base[0] + (255 - base[0]) * t),
      Math.round(base[1] + (255 - base[1]) * t),
      Math.round(base[2] + (255 - base[2]) * t),
    ];
    if (contrastRatio(mixed, bg) >= minRatio) {
      return '#' + mixed.map((v) => v.toString(16).padStart(2, '0')).join('');
    }
  }
  return '#f1f5f9';
}

/** できごとの記録（log-terminal、ほぼ黒）の上で読める色にする。 */
export function readableOnFeed(hex: string | undefined, minRatio = 4.5): string {
  return readableOn(hex, FEED_BG, minRatio);
}

/** glass-panel（統計パネル等、feedより明るい）の上で読める色にする。 */
export function readableOnPanel(hex: string | undefined, minRatio = 4.5): string {
  return readableOn(hex, PANEL_BG, minRatio);
}
