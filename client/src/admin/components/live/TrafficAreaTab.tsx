/**
 * @file 管理画面の Live「交通情報エリア」タブ（渋滞情報を取る道路の登録）
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

import type { FullConfig } from '../../types';

/**
 * 交通情報のコーナーで調べる道路を登録する（5〜7件くらいがおすすめ）。手で追加するか、AI に提案させる。
 * 保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体（show.user_profile.traffic_areas を書き換える）
 * @param props.trafficAreaInput 追加の入力欄の値
 * @param props.suggestTrafficAreas AI に道路を提案させる
 * @param props.isSuggestingTraffic 提案を待っている間は true
 */
export function TrafficAreaTab({
  config, setConfig, trafficAreaInput, setTrafficAreaInput, suggestTrafficAreas, isSuggestingTraffic,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  trafficAreaInput: string;
  setTrafficAreaInput: (v: string) => void;
  suggestTrafficAreas: () => void;
  isSuggestingTraffic: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
          <span className="text-xl">🚗</span>
          <h2 className="text-lg font-bold text-white">交通情報エリア</h2>
        </div>
        <p className="text-xs text-gray-500">
          ここに登録した道路の渋滞情報を Google Search でリアルタイム取得してアナウンスします。<br/>
          多すぎると情報が散らかるため 5〜7 件程度が推奨です。
        </p>
      </div>

      {/* 登録済みエリアのタグ表示 */}
      {(config.show.user_profile.traffic_areas ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(config.show.user_profile.traffic_areas ?? []).map(area => (
            <span key={area}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-neon-blue/15 border border-neon-blue/40 text-sm text-white"
            >
              {area}
              <button
                className="text-gray-400 hover:text-red-400 transition-colors leading-none"
                onClick={() => {
                  const next = (config.show.user_profile.traffic_areas ?? []).filter(a => a !== area);
                  setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, traffic_areas: next } } });
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}

      {/* 手動追加インプット */}
      <div className="flex gap-2">
        <input
          type="text"
          className="flex-1 input-field text-sm"
          placeholder="例: 阪神高速3号神戸線（西行き）"
          value={trafficAreaInput}
          onChange={e => setTrafficAreaInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && trafficAreaInput.trim()) {
              const val = trafficAreaInput.trim();
              const current = config.show.user_profile.traffic_areas ?? [];
              if (!current.includes(val)) {
                setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, traffic_areas: [...current, val] } } });
              }
              setTrafficAreaInput('');
            }
          }}
        />
        <button
          className="btn btn-dark text-sm px-3"
          onClick={() => {
            const val = trafficAreaInput.trim();
            if (!val) return;
            const current = config.show.user_profile.traffic_areas ?? [];
            if (!current.includes(val)) {
              setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, traffic_areas: [...current, val] } } });
            }
            setTrafficAreaInput('');
          }}
        >追加</button>
        <button
          className="btn btn-dark text-sm px-3 flex items-center gap-1.5 border-violet-500/50 text-violet-300 hover:border-violet-400 flex-shrink-0"
          onClick={suggestTrafficAreas}
          disabled={isSuggestingTraffic}
        >
          {isSuggestingTraffic ? (
            <><span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-violet-300 border-t-transparent rounded-full" />提案中…</>
          ) : (
            <>✨ AIで自動提案</>
          )}
        </button>
      </div>
      <div>
        <p className="text-xs text-gray-600">Enter キーまたは「追加」ボタンで手動追加できます。</p>
      </div>
    </div>
  );
}
