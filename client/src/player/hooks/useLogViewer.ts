/**
 * @file プレーヤー画面のログビューア（ブラウザのコンソール出力を画面で見る）
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

import { useEffect, useRef, useState } from 'react';

/** ログ1件。ts は「HH:MM:SS」。 */
export type LogEntry = { level: 'log' | 'warn' | 'error' | 'info'; msg: string; ts: string };

/**
 * console.log / warn / error / info を横取りして直近500件を貯め、ログビューアの開閉状態を返す。
 * 画面を閉じると横取りを元に戻す。
 * @returns 表示状態・表示するログ・末尾へスクロールする位置・openLogViewer
 */
export function useLogViewer() {
  const logBufferRef = useRef<LogEntry[]>([]);
  const [showLogs,   setShowLogs]   = useState(false);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const push = (level: LogEntry['level'], args: unknown[]) => {
      const ts = new Date().toTimeString().slice(0, 8);
      const msg = args.map(a => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      logBufferRef.current = [...logBufferRef.current.slice(-499), { level, msg, ts }];
    };
    console.log   = (...args) => { orig.log(...args);   push('log',   args); };
    console.warn  = (...args) => { orig.warn(...args);  push('warn',  args); };
    console.error = (...args) => { orig.error(...args); push('error', args); };
    console.info  = (...args) => { orig.info(...args);  push('info',  args); };
    return () => { Object.assign(console, orig); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** その時点のログで表示を作り、開いて末尾へスクロールする。 */
  const openLogViewer = () => {
    setLogEntries([...logBufferRef.current]);
    setShowLogs(true);
    setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: 'instant' }), 50);
  };

  return { showLogs, setShowLogs, logEntries, logEndRef, openLogViewer };
}
