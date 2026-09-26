/**
 * @file ダッシュボードのパネルで共通に使う部品（見出し・状態のランプ・ラベル・最後の接続など）
 *
 * 大きい固定のパネルと小さいタイルの両方で使う。
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

import type { ReactNode } from 'react';
import { DIM_TEXT, formatLastSession, infoLineStyle } from '../constants';
import { errorCodeLabel } from '../eventDescriptions';
import type { ChannelSnapshot } from '../types';

/** これより古いエラーは出さない。 */
const ERROR_STALE_MS = 5 * 60 * 1000;

/**
 * 直近5分以内のエラーを返す。古いものは出さない（いつまでも赤いままにしないため）。
 * @param snapshot チャンネルの状態
 * @returns エラー。無ければ null
 */
export function recentErrorOf(snapshot: ChannelSnapshot | undefined) {
  const err = snapshot?.lastError;
  return err && (Date.now() - err.ts) < ERROR_STALE_MS ? err : null;
}

/**
 * エラーを、ランプに添える説明（「⚠ 音声の合成に失敗: …」）にする。
 * @param err エラー
 */
export function errorTitle(err: { code?: string; message?: string }): string {
  return `⚠ ${errorCodeLabel(err.code)}${err.message ? `: ${err.message}` : ''}`;
}

/** 状態のランプの色（稼働中・待機中・エラー）。 */
export type DotState = 'active' | 'inactive' | 'error';

/**
 * 状態のランプ。
 * @param props.title マウスを乗せたときの説明
 */
export function StatusDot({ state, title }: { state: DotState; title: string }) {
  return (
    <span
      className={`indicator ${state === 'error' ? '' : state}`}
      style={state === 'error'
        ? { backgroundColor: 'var(--color-danger)', boxShadow: '0 0 10px var(--color-danger)', flexShrink: 0 }
        : { flexShrink: 0 }}
      title={title}
    />
  );
}

interface PanelHeaderProps {
  emoji: string;
  name: string;
  color?: string;
  dot: DotState;
  dotTitle: string;
  /** 名前の右に添える補足（番組名など） */
  aside?: ReactNode;
  /** 小さいタイル用の詰めた見出し */
  compact?: boolean;
}

/** パネルの見出し（絵文字・名前・補足と、右端の状態のランプ）。 */
export function PanelHeader({ emoji, name, color, dot, dotTitle, aside, compact = false }: PanelHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 6 : 8, minWidth: 0 }}>
        <span style={{ fontSize: compact ? '1.05rem' : '1.35rem', flexShrink: 0 }}>{emoji}</span>
        <span style={{
          ...infoLineStyle, fontWeight: 700,
          fontSize: compact ? '0.84rem' : '1.02rem', color: color ?? '#e2e8f0',
        }}>
          {name}
        </span>
        {aside}
      </div>
      <StatusDot state={dot} title={dotTitle} />
    </div>
  );
}

/**
 * パネルの中の小見出し。
 * @param props.right 右端に置くもの
 */
export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
      <div style={{ fontSize: '0.68rem', color: '#94a3b8', letterSpacing: '0.08em', fontWeight: 600 }}>
        {children}
      </div>
      {right}
    </div>
  );
}

/** 「まだありません」のような、中身が無いときの薄い文。 */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: '0.76rem', color: DIM_TEXT }}>{children}</div>;
}

/**
 * 小さな丸いラベル（「3件 実行中」など）。
 * @param props.filled 塗りつぶすか（既定は枠だけ）
 */
export function Pill({ children, color = '#94a3b8', filled = false }: { children: ReactNode; color?: string; filled?: boolean }) {
  return (
    <span style={{
      flexShrink: 0, fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.03em',
      color: filled ? '#0b0f17' : color,
      background: filled ? color : 'transparent',
      border: `1px solid ${filled ? color : `${color}66`}`,
      borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

/** パネルの下端の「最終接続: …」の行。接続の記録が無ければ何も出さない。 */
export function LastSessionFooter({ snapshot }: { snapshot: ChannelSnapshot | undefined }) {
  const text = formatLastSession(snapshot?.lastSession);
  if (!text) return null;
  return (
    <div style={{
      ...infoLineStyle, fontSize: '0.72rem', color: DIM_TEXT, flexShrink: 0,
      borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6, marginTop: 'auto',
    }}>
      最終接続: {text}
    </div>
  );
}
