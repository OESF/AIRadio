/**
 * @file 管理画面（admin.html）専用の小さな関数（ショートカットの表示・日記のバッジ色・Markdown の簡易表示）
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
import type { ShortcutConfig } from './types';
import { DIARY_BADGE_PALETTE } from './constants';

/**
 * KeyboardEvent.code を表示用のキー名にする（KeyM → M、Digit1 → 1）。
 * @param code KeyboardEvent.code
 */
export function formatShortcutCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'Space';
  return code;
}

/**
 * ショートカットを「Ctrl+Option+M」の形にする。未設定なら「未設定」。
 * @param s ショートカットの設定
 */
export function formatShortcut(s: ShortcutConfig | null | undefined): string {
  if (!s || !s.code) return '未設定';
  const parts: string[] = [];
  if (s.ctrlKey) parts.push('Ctrl');
  if (s.altKey) parts.push('Option');
  if (s.shiftKey) parts.push('Shift');
  if (s.metaKey) parts.push('Cmd');
  parts.push(formatShortcutCode(s.code));
  return parts.join('+');
}

/**
 * エージェントの日記のバッジの色（CSS クラス）を、キーのハッシュで決める。同じキーは常に同じ色になる。
 * @param agentKey エージェントのキー
 */
export function diaryBadgeClass(agentKey: string): string {
  let hash = 0;
  for (let i = 0; i < agentKey.length; i++) hash = (hash * 31 + agentKey.charCodeAt(i)) >>> 0;
  return DIARY_BADGE_PALETTE[hash % DIARY_BADGE_PALETTE.length];
}

/**
 * リリースノート用の最小限のインライン記法（**太字**・`コード`・[リンク](url)）を React 要素にする。
 *
 * リンクはクリックできるようにせず、表示の文字だけを強調して出す。リンク先（README.md など）は
 * 画面の配信対象に含まれず、開けないため。
 * @param text 1行分のテキスト
 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).filter(p => p !== '').map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-white font-bold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="text-neon-blue bg-black/40 px-1 rounded text-xs">{part.slice(1, -1)}</code>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return <span key={i} className="text-neon-blue">{linkMatch[1]}</span>;
    }
    return part;
  });
}
