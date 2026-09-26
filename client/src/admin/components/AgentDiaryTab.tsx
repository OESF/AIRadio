/**
 * @file 管理画面の「エージェント日記」タブ（Live 以外のチャンネル共通）
 *
 * チャンネルの日記を取得し、エージェントで絞り込んで新しい順にカードで表示する。10秒ごとの自動更新もできる。
 * Live は専用の LiveDiaryTab.tsx を使う。
 *
 * 高さは画面に合わせる。全体の高さを「画面の高さ − 64px」にし、一覧のカードの部分だけが残りの高さを
 * 引き受けてスクロールする（32px はこの部品が画面の上から始まる位置の実測値で、下にも同じだけ余白を残す）。
 *
 * ATTENTION: この管理画面では Tailwind の余白のクラス（p-3 など）が効かないことがあるので、余白は
 *            インラインの style で指定する。
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

import { useState, useEffect, useRef } from 'react';
import type { DiaryEntry } from '../types';
import { diaryBadgeClass } from '../utils';

/**
 * エージェント日記のタブ。
 * @param props.channel チャンネル（'classic' など。GET /api/agent-diary の channel に渡す）
 * @param props.emptyMessage 日記がまだ無いときの説明
 */
export function AgentDiaryTab({ serverUrl, channel, emptyMessage }: {
  serverUrl: string;
  channel: string;
  emptyMessage: string;
}) {
  const [entries, setEntries]         = useState<DiaryEntry[]>([]);
  const [agentFilter, setAgentFilter] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDiary = async (agent = agentFilter) => {
    try {
      const q = agent !== 'all' ? `&agentKey=${agent}` : '';
      const res = await fetch(`${serverUrl}/api/agent-diary?channel=${channel}&limit=300${q}`);
      if (res.ok) setEntries(await res.json()); // サーバーが新しい順で返す
    } catch { /* サーバーが動いていないときは何もしない */ }
  };

  useEffect(() => { fetchDiary(agentFilter); }, [agentFilter, channel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (autoRefresh) {
      autoRefreshRef.current = setInterval(() => fetchDiary(agentFilter), 10000);
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [autoRefresh, agentFilter, channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentKeys = Array.from(new Set(entries.map(e => e.agentKey)));

  // 高さを画面に合わせる（計算はファイルの先頭の説明を参照）
  return (
    <div className="flex flex-col gap-4" style={{ height: 'calc(100vh - 64px)' }}>
      {/* ヘッダー（自然な高さのまま、伸縮しない） */}
      <div className="flex items-center justify-between border-b border-glass pb-4 flex-wrap gap-3 flex-shrink-0" style={{ marginBottom: "20px" }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">📔</span>
          <h2 className="text-lg font-bold text-neon-blue">エージェント日記</h2>
          <span className="text-xs text-gray-500">server/data/agent-diary/{channel}/ — 一人称の振り返り（非公開・放送されません）</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={agentFilter}
            onChange={e => setAgentFilter(e.target.value)}
            className="bg-gray-900 border border-glass text-xs text-gray-300 rounded px-2 py-1"
          >
            <option value="all">全エージェント</option>
            {agentKeys.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-400">
            <input type="checkbox" className="accent-neon-blue"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            自動更新 (10s)
          </label>
          <button onClick={() => fetchDiary(agentFilter)}
            className="btn btn-dark text-xs px-3 py-1 border border-neon-blue/30 hover:border-neon-blue text-neon-blue">
            ↻ 更新
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500 flex-shrink-0">
        {entries.length} 件表示（最大 300 件 / エージェントごとに1日最大 200 件保存）
      </p>

      {/* カードの一覧（残りの高さを引き受ける。minHeight: 0 が無いと中身の高さより縮まず、スクロールしなくなる） */}
      <div className="bg-black/50 border border-glass rounded-xl overflow-hidden" style={{ flex: '1 1 auto', minHeight: 0 }}>
        {/* 余白は style で指定する（Tailwind の余白のクラスが効かないことがあるため） */}
        <div className="overflow-y-auto flex flex-col gap-2" style={{ padding: '12px', height: '100%' }}>
          {entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-600 text-xs text-center px-6">
              {emptyMessage}
            </div>
          ) : (
            entries.map((entry, idx) => {
              const badgeClass = diaryBadgeClass(entry.agentKey);
              const timeStr = (() => {
                try {
                  return new Date(entry.time).toLocaleString('ja-JP', {
                    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                  });
                } catch { return entry.time; }
              })();
              return (
                <div key={idx} className="bg-white/5 border border-white/10 rounded-lg" style={{ padding: '8px 12px' }}>
                  <div className="flex items-center gap-2 mb-1 text-xs">
                    <span className={`inline-block rounded font-bold ${badgeClass}`} style={{ padding: '2px 8px' }}>
                      {entry.agentName}
                    </span>
                    <span className="text-gray-500">{timeStr}</span>
                  </div>
                  <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{entry.text}</p>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
