/**
 * @file 管理画面の開閉できる区画（アコーディオン）
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
import { ChevronDown } from 'lucide-react';

/**
 * 見出しを押すと中身が開閉する区画。開閉の状態は親が持つ（複数の区画をまとめて管理するため）。
 * @param props.id 区画の識別子。onToggle に渡される
 * @param props.open 開いているか
 */
export function AccordionSection({ id, title, open, onToggle, children }: {
  id: string;
  title: ReactNode;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="bg-black/30 border border-glass rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
      >
        <span className="font-bold text-white text-sm">{title}</span>
        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-white/5" style={{ padding: '20px' }}>
          {children}
        </div>
      )}
    </div>
  );
}
