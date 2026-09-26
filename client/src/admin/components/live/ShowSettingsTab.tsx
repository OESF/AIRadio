/**
 * @file 管理画面の Live「番組設定」タブ（テーマ・雰囲気・オープニング・最初のコーナー）
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
 * Live の番組全体の設定を編集する。保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体（show を書き換える）
 */
export function ShowSettingsTab({
  config, setConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-xl">📻</span>
        <h2 className="text-lg font-bold text-white">番組設定</h2>
      </div>
      <div className="flex flex-col gap-4">
        <div>
          <label>番組テーマ / タイトル</label>
          <input type="text" placeholder="私だけの AI Radio" value={config.show.theme}
            onChange={e => setConfig({ ...config, show: { ...config.show, theme: e.target.value } })}
          />
        </div>
        <div>
          <label>番組の雰囲気（モード）</label>
          <select value={config.show.atmosphere}
            onChange={e => setConfig({ ...config, show: { ...config.show, atmosphere: e.target.value } })}
          >
            <option value="通常">🌤 通常 — 時間帯に応じて自動切り替え（推奨）</option>
            <option value="静音">🤫 静音 — ミニマムなBGM中心放送（手動固定）</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="show_skip_opening"
            checked={!!config.show.skip_opening}
            onChange={e => setConfig({ ...config, show: { ...config.show, skip_opening: e.target.checked } })}
          />
          <label htmlFor="show_skip_opening" className="mb-0 cursor-pointer">オープニングをスキップ（接続時の挨拶を省略してコーナーから開始）</label>
        </div>
        <div>
          <label>最初のコーナーを固定（空欄 = 自動）</label>
          <select
            value={config.show.force_first_corner ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, force_first_corner: e.target.value } })}
          >
            <option value="">自動（通常スケジュール）</option>
            <option value="weather">お天気</option>
            <option value="traffic">交通情報</option>
            <option value="news">ニュース</option>
            <option value="finance">金融情報</option>
            <option value="commentator">コメンテーター</option>
            <option value="journalist">ジャーナリスト</option>
            <option value="music_dj">音楽・DJ</option>
            <option value="life_advisor">生活アドバイザー</option>
            <option value="world_report">ワールドレポート</option>
          </select>
        </div>
      </div>
    </div>
  );
}
