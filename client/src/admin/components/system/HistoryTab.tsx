/**
 * @file 管理画面の「会話履歴」タブ（放送で話した内容の記録）
 *
 * 放送の会話の記録（GET /api/conversation-history）を、エージェントで絞り込んで一覧する。
 * 自動更新・クリップボードへのコピー・全削除ができる。
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

import type { RefObject } from 'react';
import type { ConversationEntry } from '../../types';

/**
 * 会話履歴の一覧と操作。取得・削除は親が行う。
 * @param props.historyAgentFilter 絞り込むエージェント（'all' で全員）
 */
export function HistoryTab({
  serverUrl,
  convHistory, setConvHistory, historyAgentFilter, setHistoryAgentFilter,
  historyAutoRefresh, setHistoryAutoRefresh, fetchConversationHistory, convHistoryEndRef,
}: {
  serverUrl: string;
  convHistory: ConversationEntry[];
  setConvHistory: (v: ConversationEntry[]) => void;
  historyAgentFilter: string;
  setHistoryAgentFilter: (v: string) => void;
  historyAutoRefresh: boolean;
  setHistoryAutoRefresh: (v: boolean) => void;
  fetchConversationHistory: (agent?: string) => void;
  convHistoryEndRef: RefObject<HTMLDivElement | null>;
}) {
  // エージェントごとのバッジの色
  const AGENT_BADGE: Record<string, string> = {
    director:    'bg-purple-900/50 text-purple-300',
    caster:      'bg-blue-900/50 text-blue-300',
    assistant:   'bg-pink-900/50 text-pink-300',
    weather:     'bg-cyan-900/50 text-cyan-300',
    traffic:     'bg-orange-900/50 text-orange-300',
    news:        'bg-gray-700/60 text-gray-300',
    finance:     'bg-green-900/50 text-green-300',
    journalist:  'bg-yellow-900/50 text-yellow-300',
    commentator: 'bg-amber-900/50 text-amber-300',
    music_dj:     'bg-fuchsia-900/50 text-fuchsia-300',
    world_report: 'bg-cyan-900/50 text-cyan-300',
    secretary:      'bg-violet-900/50 text-violet-300',
    secretary_user: 'bg-slate-700/60 text-slate-300',
  };
  // 絞り込みの選択肢（履歴に出てくるエージェント）
  const agentKeys = Array.from(new Set(convHistory.map(e => e.agentKey)));

  // 表示中の履歴をテキストにしてクリップボードへ写す
  const copyAllText = () => {
    const txt = convHistory.map(e =>
      `[${new Date(e.time).toLocaleString('ja-JP')}] ${e.agentName}: ${e.text}`
    ).join('\n');
    navigator.clipboard.writeText(txt).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between border-b border-glass pb-4 flex-wrap gap-3" style={{ marginBottom: "20px" }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">💬</span>
          <h2 className="text-lg font-bold text-neon-blue">会話履歴</h2>
          <span className="text-xs text-gray-500">server/data/conversation_history.jsonl</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* エージェントフィルター */}
          <select
            value={historyAgentFilter}
            onChange={e => setHistoryAgentFilter(e.target.value)}
            className="bg-gray-900 border border-glass text-xs text-gray-300 rounded px-2 py-1"
          >
            <option value="all">全エージェント</option>
            {agentKeys.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          {/* 自動更新トグル */}
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-400">
            <input type="checkbox" className="accent-neon-blue"
              checked={historyAutoRefresh}
              onChange={e => setHistoryAutoRefresh(e.target.checked)}
            />
            自動更新 (10s)
          </label>
          {/* 手動更新 */}
          <button onClick={() => fetchConversationHistory(historyAgentFilter)}
            className="btn btn-dark text-xs px-3 py-1 border border-neon-blue/30 hover:border-neon-blue text-neon-blue">
            ↻ 更新
          </button>
          {/* コピー */}
          <button onClick={copyAllText}
            className="btn btn-dark text-xs px-3 py-1 border border-neon-purple/30 hover:border-neon-purple text-neon-purple">
            📋 コピー
          </button>
          {/* クリア */}
          <button onClick={async () => {
            if (!window.confirm('会話履歴をすべて削除しますか？')) return;
            await fetch(`${serverUrl}/api/conversation-history`, { method: 'DELETE' });
            setConvHistory([]);
          }}
            className="btn btn-dark text-xs px-3 py-1 border border-red-500/30 hover:border-red-500 text-red-400">
            🗑 クリア
          </button>
        </div>
      </div>

      {/* 件数表示 */}
      <p className="text-xs text-gray-500">
        {convHistory.length} 件表示（最大 500 件 / ローテート 2000 行毎）
      </p>

      {/* 一覧テーブル */}
      <div className="bg-black/50 border border-glass rounded-xl overflow-hidden font-mono text-xs">
        <div className="overflow-y-auto min-h-[300px] bp-3" style={{ height: 'calc(100vh - 250px)' }}>
        {convHistory.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600">
            会話履歴がありません。番組を開始してから「↻ 更新」を押してください。
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-gray-900/95 backdrop-blur-sm z-10">
              <tr className="text-gray-500 text-left">
                <th className="px-3 py-2 w-28 font-normal whitespace-nowrap">時刻</th>
                <th className="px-2 py-2 w-44 font-normal">エージェント</th>
                <th className="px-3 py-2 font-normal">発話テキスト</th>
              </tr>
            </thead>
            <tbody>
              {convHistory.map((entry, idx) => {
                const badgeClass = AGENT_BADGE[entry.agentKey] ?? 'bg-gray-800 text-gray-300';
                const timeStr = (() => {
                  try {
                    return new Date(entry.time).toLocaleTimeString('ja-JP', {
                      hour: '2-digit', minute: '2-digit', second: '2-digit'
                    });
                  } catch { return String(entry.time); }
                })();
                return (
                  <tr key={idx}
                    className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{timeStr}</td>
                    <td className="px-2 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold truncate max-w-[160px] ${badgeClass}`}>
                        {entry.agentName}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-200 break-all leading-relaxed">{entry.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div ref={convHistoryEndRef} />
        </div>
      </div>
      <p className="text-xs text-gray-600">
        📋 コピーボタンで全発話テキストをクリップボードに取得できます（発音辞書メンテナンス用途に）。
      </p>
    </div>
  );
}
