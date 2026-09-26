/**
 * @file 管理画面の「ログ」タブ（サーバーのログの閲覧）
 *
 * サーバーのログを、レベルと本文の言葉で絞り込んで表示する。自動更新もできる。
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

import { useState } from 'react';
import type { ServerLogEntry } from '../../types';
import { SERVER_LOG_LEVEL_STYLE } from '../../constants';

/**
 * ログの一覧と絞り込み。取得は親が行う（GET /api/logs）。
 * @param props.logMinLevel 表示する最低のレベル
 * @param props.fetchServerLogs ログを取り直す
 */
export function LogsTab({
  serverLogs, logMinLevel, setLogMinLevel, logAutoRefresh, setLogAutoRefresh, fetchServerLogs,
}: {
  serverLogs: ServerLogEntry[];
  logMinLevel: 'debug' | 'info' | 'warn' | 'error';
  setLogMinLevel: (v: 'debug' | 'info' | 'warn' | 'error') => void;
  logAutoRefresh: boolean;
  setLogAutoRefresh: (v: boolean) => void;
  fetchServerLogs: (level?: 'debug' | 'info' | 'warn' | 'error') => void;
}) {
  // 本文の言葉による絞り込み（例:「SecretaryLoop」で自律ループのログだけに）。取得済みのログを
  // 画面の側で絞るだけなので、入力のたびに取り直さない
  const [logSearchTerm, setLogSearchTerm] = useState('');

  return (
    <div className="flex flex-col gap-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between border-b border-glass pb-4 flex-wrap gap-3" style={{ marginBottom: "20px" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg">🗒️</span>
          <h2 className="text-lg font-bold text-neon-blue">サーバーログ</h2>
          <span className="text-xs text-gray-500">server/logs/server.log</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* レベルフィルター */}
          {(['debug','info','warn','error'] as const).map(lv => (
            <button key={lv} onClick={() => setLogMinLevel(lv)}
              className={`btn text-xs px-3 py-1 uppercase font-mono ${
                logMinLevel === lv ? 'btn-primary' : 'btn-dark'
              }`}
            >{lv}+</button>
          ))}
          {/* 自動更新トグル */}
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-400 ml-2">
            <input type="checkbox" className="accent-neon-blue"
              checked={logAutoRefresh}
              onChange={e => setLogAutoRefresh(e.target.checked)}
            />
            自動更新 (10s)
          </label>
          {/* 手動更新 */}
          <button onClick={() => fetchServerLogs(logMinLevel)}
            className="btn btn-dark text-xs px-3 py-1 border border-neon-blue/30 hover:border-neon-blue text-neon-blue">
            ↻ 更新
          </button>
        </div>
      </div>

      {/* 本文の言葉による絞り込み */}
      <div className="flex items-center gap-2 flex-wrap -mt-2">
        <input
          type="text"
          value={logSearchTerm}
          onChange={e => setLogSearchTerm(e.target.value)}
          placeholder="🔍 メッセージを絞り込み（例: SecretaryLoop）"
          className="flex-1 min-w-[240px] text-xs bg-black/30 border border-glass rounded px-3 py-1.5 text-white/90"
        />
        {logSearchTerm && (
          <button
            onClick={() => setLogSearchTerm('')}
            className="btn btn-dark text-xs px-2 py-1 border border-glass text-gray-400"
          >
            ✕ クリア
          </button>
        )}
      </div>

      {/* ログ一覧 */}
      <div className="bg-black/50 border border-glass rounded-xl overflow-hidden font-mono text-xs">
        <div className="overflow-y-auto min-h-[300px] bp-3" style={{ height: 'calc(100vh - 230px)' }}>
        {(() => {
          const filteredLogs = logSearchTerm.trim()
            ? serverLogs.filter(e => e.msg.toLowerCase().includes(logSearchTerm.trim().toLowerCase()))
            : serverLogs;
          return filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600">
            {serverLogs.length === 0
              ? 'ログがありません。サーバーを起動してから「↻ 更新」を押してください。'
              : `「${logSearchTerm}」に一致するログがありません。`}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-gray-900/95 backdrop-blur-sm z-10">
              <tr className="text-gray-500 text-left">
                <th className="px-3 py-2 w-32 font-normal whitespace-nowrap">時刻</th>
                <th className="px-2 py-2 w-16 font-normal">レベル</th>
                <th className="px-3 py-2 font-normal">メッセージ</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((entry, idx) => {
                const style = SERVER_LOG_LEVEL_STYLE[entry.level]
                  ?? { badge: 'bg-gray-800 text-gray-400', text: 'text-gray-400' };
                const timeStr = (() => {
                  try {
                    return new Date(entry.time).toLocaleTimeString('ja-JP', {
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    });
                  } catch { return entry.time; }
                })();
                return (
                  <tr key={idx}
                    className={`border-b border-white/5 hover:bg-white/5 transition-colors
                      ${entry.level >= 50 ? 'bg-red-900/10' : entry.level >= 40 ? 'bg-yellow-900/10' : ''}`}
                  >
                    <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{timeStr}</td>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold ${style.badge}`}>
                        {entry.label}
                      </span>
                    </td>
                    <td className={`px-3 py-1.5 break-all ${style.text}`}>{entry.msg}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          );
        })()}
        </div>
      </div>
      <p className="text-xs text-gray-600">
        ログファイルは日次ローテート（20MB超でも即時ローテート）、7世代保持後に自動削除されます。
        保存先: <code className="text-neon-blue">server/logs/</code>
      </p>
    </div>
  );
}
