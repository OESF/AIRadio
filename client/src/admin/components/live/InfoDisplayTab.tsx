/**
 * @file 管理画面の Live「情報表示」タブ（プレーヤー画面のティッカーと InfoView の設定）
 *
 * プレーヤー画面の下を流れるティッカー（金融・天気・ニュース・交通）の表示・速さと、コーナーの内容を
 * 画面に大きく出す InfoView のズームやアニメーションの時間を設定する。
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

import type { FullConfig, DisplayConfig } from '../../types';

/**
 * ティッカーと InfoView の設定を編集する。保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体
 */
export function InfoDisplayTab({
  config, setConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
}) {
  const disp = config.show.display ?? {};
  const ticker = disp.ticker ?? {};
  const iv = disp.info_view ?? {};
  const setDisp = (patch: DisplayConfig) =>
    setConfig({ ...config, show: { ...config.show, display: { ...disp, ...patch } } });

  return (
    <div>
      {/* ── ティッカー ───────────────────────────── */}
      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">📊 ティッカーバー</h3>
      <div className="bg-black/20 border border-glass rounded-xl flex flex-col gap-4" style={{ padding: '16px', marginBottom: '24px' }}>
        <div className="flex items-center gap-3">
          <input type="checkbox" id="ticker_enabled"
            checked={ticker.enabled !== false}
            onChange={e => setDisp({ ticker: { ...ticker, enabled: e.target.checked } })}
          />
          <label htmlFor="ticker_enabled" className="mb-0 cursor-pointer">ティッカーバーを表示する</label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="mb-1">フォントサイズ</label>
            {(() => {
              const fs = ticker.font_size_rem ?? 1.5;
              return (
                <>
                  <div className="flex items-center gap-2 flex-nowrap">
                    <span className="text-xs text-gray-500 flex-shrink-0">小</span>
                    <input
                      type="range" min="0.8" max="2.5" step="0.1"
                      value={fs}
                      onChange={e => setDisp({ ticker: { ...ticker, font_size_rem: Number(e.target.value) } })}
                      className="flex-1 min-w-0 accent-neon-blue"
                    />
                    <span className="text-xs text-gray-500 flex-shrink-0">大</span>
                    <span className="text-sm font-bold font-mono text-neon-blue w-12 text-right flex-shrink-0">{fs.toFixed(1)} rem</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">金融・ニュース・天気・交通コーナー中に画面下部に表示される情報バーの文字サイズです。</p>
                </>
              );
            })()}
          </div>
          <div>
            <label className="mb-1">スクロール速度</label>
            {(() => {
              const sp = ticker.scroll_speed ?? 15;
              const desc = sp <= 7  ? 'ゆっくり'
                         : sp <= 11 ? 'やや遅め'
                         : sp === 12 ? '標準'
                         : sp <= 15 ? 'やや速め'
                         :            '速い';
              return (
                <>
                  <div className="flex items-center gap-2 flex-nowrap">
                    <span className="text-xs text-gray-500 flex-shrink-0">遅</span>
                    <input
                      type="range" min="5" max="19" step="1"
                      value={sp}
                      onChange={e => setDisp({ ticker: { ...ticker, scroll_speed: Number(e.target.value) } })}
                      className="flex-1 min-w-0 accent-neon-blue"
                    />
                    <span className="text-xs text-gray-500 flex-shrink-0">速</span>
                    <span className="text-sm font-bold font-mono text-neon-blue w-20 text-right flex-shrink-0">{sp} 文字/秒</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{desc}（全角文字は2倍幅で計算。デフォルト: 12）</p>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ── InfoView ─────────────────────────────── */}
      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">InfoView（地図パネル）</h3>
      <div className="bg-black/20 border border-glass rounded-xl flex flex-col gap-4" style={{ padding: '16px' }}>
        <div className="flex items-center gap-3">
          <input type="checkbox" id="iv_enabled"
            checked={iv.enabled !== false}
            onChange={e => setDisp({ info_view: { ...iv, enabled: e.target.checked } })}
          />
          <label htmlFor="iv_enabled" className="mb-0 cursor-pointer">ワールドレポート地図を表示する</label>
        </div>
        {/* ズームの開始・終了・アニメーションの時間を3列に並べる */}
        {(() => {
          const zoomStart = iv.world_report_zoom_start ?? 2;
          const zoomEnd   = iv.world_report_zoom ?? 12;
          const dur       = iv.zoom_duration_sec ?? 15;
          const zoomLabel = (z: number) =>
            z <= 2  ? '地球全体' :
            z <= 4  ? '大陸レベル' :
            z <= 6  ? '国レベル' :
            z <= 8  ? '地方・州レベル' :
            z <= 10 ? '都市圏（20km圏）' :
            z <= 12 ? '市街地（5〜10km）' :
            z <= 14 ? '街区レベル' : '通り・建物';
          return (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="mb-1">ズーム開始レベル</label>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="text-xs text-gray-500 flex-shrink-0">広</span>
                  <input
                    type="range" min="1" max="10" step="1"
                    value={zoomStart}
                    onChange={e => setDisp({ info_view: { ...iv, world_report_zoom_start: Math.min(Number(e.target.value), zoomEnd - 1) } })}
                    className="flex-1 min-w-0 accent-neon-blue"
                  />
                  <span className="text-xs text-gray-500 flex-shrink-0">詳</span>
                  <span className="text-sm font-bold font-mono text-neon-blue w-8 text-right flex-shrink-0">{zoomStart}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">{zoomLabel(zoomStart)}</p>
              </div>
              <div>
                <label className="mb-1">ズーム終了レベル（最終表示）</label>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="text-xs text-gray-500 flex-shrink-0">広</span>
                  <input
                    type="range" min="6" max="16" step="1"
                    value={zoomEnd}
                    onChange={e => setDisp({ info_view: { ...iv, world_report_zoom: Math.max(Number(e.target.value), zoomStart + 1) } })}
                    className="flex-1 min-w-0 accent-neon-blue"
                  />
                  <span className="text-xs text-gray-500 flex-shrink-0">詳</span>
                  <span className="text-sm font-bold font-mono text-neon-blue w-8 text-right flex-shrink-0">{zoomEnd}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">{zoomLabel(zoomEnd)} ← 推奨: 12</p>
              </div>
              <div>
                <label className="mb-1">ズームアニメーション時間</label>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="text-xs text-gray-500 flex-shrink-0">速</span>
                  <input
                    type="range" min="3" max="60" step="1"
                    value={dur}
                    onChange={e => setDisp({ info_view: { ...iv, zoom_duration_sec: Number(e.target.value) } })}
                    className="flex-1 min-w-0 accent-neon-blue"
                  />
                  <span className="text-xs text-gray-500 flex-shrink-0">遅</span>
                  <span className="text-sm font-bold font-mono text-neon-blue w-12 text-right flex-shrink-0">{dur} 秒</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">推奨: 15〜30秒</p>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
