/**
 * @file 管理画面の Live「エージェント日記」タブ
 *
 * Live のエージェントの日記を、エージェントで絞り込んで新しい順にカードで表示する。他のチャンネルは
 * 共通の AgentDiaryTab.tsx を使うが、Live は先に作ったこの専用のものを使っている（バッジの色を手で決めている）。
 * 高さを画面に合わせる計算は AgentDiaryTab.tsx と同じ。
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

import type { DiaryEntry } from '../../types';

/**
 * 日記の一覧・エージェントの絞り込み・自動更新の切り替え・手動の更新。取得は親が行う。
 * @param props.diaryAgentFilter 絞り込むエージェント（'all' で全員）
 * @param props.fetchAgentDiary 指定したエージェントの日記を取り直す
 */
export function LiveDiaryTab({
  diaryEntries, diaryAgentFilter, setDiaryAgentFilter, diaryAutoRefresh, setDiaryAutoRefresh, fetchAgentDiary,
}: {
  diaryEntries: DiaryEntry[];
  diaryAgentFilter: string;
  setDiaryAgentFilter: (v: string) => void;
  diaryAutoRefresh: boolean;
  setDiaryAutoRefresh: (v: boolean) => void;
  fetchAgentDiary: (agent: string) => void;
}) {
  // エージェントごとのバッジの色
  const DIARY_AGENT_BADGE: Record<string, string> = {
    caster:        'bg-blue-900/50 text-blue-300',
    assistant:     'bg-pink-900/50 text-pink-300',
    commentator:   'bg-amber-900/50 text-amber-300',
    journalist:    'bg-yellow-900/50 text-yellow-300',
    world_report:  'bg-cyan-900/50 text-cyan-300',
    music_dj:      'bg-fuchsia-900/50 text-fuchsia-300',
    life_advisor:  'bg-purple-900/50 text-purple-300',
    legal_advisor: 'bg-green-900/50 text-green-300',
    weather:       'bg-sky-900/50 text-sky-300',
    traffic:       'bg-orange-900/50 text-orange-300',
    news:          'bg-gray-700/60 text-gray-300',
    finance:       'bg-emerald-900/50 text-emerald-300',
    // ゲスト論客（自分のコーナーは持たず、討論コーナーに出演した後に書く）
    comedian:      'bg-red-900/50 text-red-300',
    doctor:        'bg-teal-900/50 text-teal-300',
    marketer:      'bg-indigo-900/50 text-indigo-300',
  };
  // 絞り込みの選択肢（日記に出てくるエージェント）
  const diaryAgentKeys = Array.from(new Set(diaryEntries.map(e => e.agentKey)));

  // 高さを画面に合わせる（計算の根拠は AgentDiaryTab.tsx）
  return (
    <div className="flex flex-col gap-4" style={{ height: 'calc(100vh - 64px)' }}>
      {/* ヘッダー（自然な高さのまま、伸縮しない） */}
      <div className="flex items-center justify-between border-b border-glass pb-4 flex-wrap gap-3 flex-shrink-0" style={{ marginBottom: "20px" }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">📔</span>
          <h2 className="text-lg font-bold text-neon-blue">エージェント日記</h2>
          <span className="text-xs text-gray-500">server/data/agent-diary/ — コーナー終了後の一人称の振り返り（非公開・放送されません）</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* エージェントフィルター */}
          <select
            value={diaryAgentFilter}
            onChange={e => setDiaryAgentFilter(e.target.value)}
            className="bg-gray-900 border border-glass text-xs text-gray-300 rounded px-2 py-1"
          >
            <option value="all">全エージェント</option>
            {diaryAgentKeys.map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          {/* 自動更新トグル */}
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-gray-400">
            <input type="checkbox" className="accent-neon-blue"
              checked={diaryAutoRefresh}
              onChange={e => setDiaryAutoRefresh(e.target.checked)}
            />
            自動更新 (10s)
          </label>
          {/* 手動更新 */}
          <button onClick={() => fetchAgentDiary(diaryAgentFilter)}
            className="btn btn-dark text-xs px-3 py-1 border border-neon-blue/30 hover:border-neon-blue text-neon-blue">
            ↻ 更新
          </button>
        </div>
      </div>

      {/* 件数表示 */}
      <p className="text-xs text-gray-500 flex-shrink-0">
        {diaryEntries.length} 件表示（最大 300 件 / エージェントごとに1日最大 200 件保存）
      </p>

      {/* エントリ一覧（カード表示、残りの縦スペースをすべて吸収する） */}
      <div className="bg-black/50 border border-glass rounded-xl overflow-hidden" style={{ flex: '1 1 auto', minHeight: 0 }}>
        {/* 余白は style で指定する（Tailwind の余白のクラスが効かないことがあるため） */}
        <div className="overflow-y-auto flex flex-col gap-2" style={{ padding: '12px', height: '100%' }}>
          {diaryEntries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-600 text-xs">
              日記がまだありません。Live 番組のコーナー（天気・交通・ニュース・金融・コメンテーター・
              ジャーナリスト・法律相談・ワールドレポート・音楽DJ・生活アドバイス）が1つ終了するか、
              MAX・Clara がオープニング／エンディングを迎えると、担当エージェントの振り返りがここに記録されます。
            </div>
          ) : (
            diaryEntries.map((entry, idx) => {
              const badgeClass = DIARY_AGENT_BADGE[entry.agentKey] ?? 'bg-gray-800 text-gray-300';
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
