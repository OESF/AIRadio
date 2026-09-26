/**
 * @file プレーヤー画面のログビューアの表示
 *
 * ログの収集は useLogViewer が行い、ここでは一覧の表示とクリップボードへのコピーだけを行う。
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

import { Terminal } from 'lucide-react';
import type { RefObject } from 'react';
import type { LogEntry } from '../hooks/useLogViewer';

/**
 * ログを色分けして一覧表示する。「コピー」で全件をテキストとしてクリップボードへ写す。
 * @param props.logEndRef 一覧の末尾。開いたときにここまでスクロールする
 */
export function LogViewerPanel({
  logEntries, logEndRef,
}: {
  logEntries: LogEntry[];
  logEndRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/30 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3 h-3 text-gray-600" />
          <span className="text-xs font-mono text-gray-600">
            Client Logs ({logEntries.length})
          </span>
        </div>
        <button
          onClick={() => {
            const text = logEntries.map(e =>
              `${e.ts} [${e.level.toUpperCase().padEnd(5)}] ${e.msg}`
            ).join('\n');
            navigator.clipboard.writeText(text).catch(() => {});
          }}
          className="text-xs text-gray-700 hover:text-gray-400 px-2 py-0.5 rounded
            border border-white/8 hover:border-white/20 transition-colors"
        >
          コピー
        </button>
      </div>
      <div className="overflow-y-auto p-2 font-mono space-y-0.5"
        style={{ maxHeight: 300, fontSize: '1rem' }}>
        {logEntries.length === 0 ? (
          <p className="text-gray-500 text-center py-6">ログなし</p>
        ) : logEntries.map((e, i) => (
          <div key={i} className={`flex gap-1.5 leading-relaxed ${
            e.level === 'error' ? 'text-red-300' :
            e.level === 'warn'  ? 'text-yellow-200' :
            e.level === 'info'  ? 'text-sky-300' : 'text-gray-300'
          }`}>
            <span className="text-gray-500 shrink-0 select-none">{e.ts}</span>
            <span className={`shrink-0 select-none ${
              e.level === 'error' ? 'text-red-500' :
              e.level === 'warn'  ? 'text-yellow-500' :
              e.level === 'info'  ? 'text-sky-500' : 'text-gray-500'
            }`}>[{e.level.slice(0,4).toUpperCase()}]</span>
            <span className="break-all">{e.msg}</span>
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
