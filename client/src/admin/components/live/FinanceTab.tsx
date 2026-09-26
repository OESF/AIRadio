/**
 * @file 管理画面の Live「金融設定」タブ（金融コーナーで見る個別株と、保有しているファンド・株式）
 *
 * 金融コーナー（と資産の値動きの円換算）で使う銘柄を登録する。個別株は追加・削除でき、保有している
 * ファンド・株式は一覧を表示する。
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

import type { Dispatch, SetStateAction } from 'react';
import type { FinanceWatchlist } from '../../types';

/**
 * 金融の監視銘柄の編集。保存は親のフォームが行う。
 * @param props.financeWL 監視銘柄の一覧
 */
export function FinanceTab({
  financeWL, toggleWLItem, removeStock, newStock, setNewStock, addStock, togglePersonalHolding,
}: {
  financeWL: FinanceWatchlist;
  toggleWLItem: (section: keyof FinanceWatchlist, symbol: string) => void;
  removeStock: (symbol: string) => void;
  newStock: { symbol: string; name: string; unit: string; dec: number };
  setNewStock: Dispatch<SetStateAction<{ symbol: string; name: string; unit: string; dec: number }>>;
  addStock: () => void;
  togglePersonalHolding: (name: string) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-neon-blue text-xl">💹</span>
        <h2 className="text-lg font-bold text-neon-blue">金融情報ウォッチリスト</h2>
        <span className="text-xs text-gray-400 ml-2">☑ にした項目が放送・レポートに含まれます</span>
      </div>

      {/* 区分ごとの共通の部品 */}
      {(['indices','forex','bonds','commodities'] as const).map(section => {
        const labels: Record<string, string> = {
          indices: '📈 主要株式指数',
          forex:   '💱 為替',
          bonds:   '🏦 債券',
          commodities: '🛢 コモディティ',
        };
        return (
          <div key={section}>
            <h3 className="text-sm font-bold text-gray-300 mb-2">{labels[section]}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {financeWL[section].map(item => (
                <label
                  key={item.symbol}
                  className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer border transition-colors
                    ${item.enabled
                      ? 'border-neon-blue bg-neon-blue/10 text-white'
                      : 'border-gray-600 bg-black/20 text-gray-400 hover:border-gray-400'}`}
                >
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={() => toggleWLItem(section, item.symbol)}
                    className="accent-neon-blue w-4 h-4 flex-shrink-0"
                  />
                  <span className="text-sm leading-tight">
                    <span className="font-bold">{item.name}</span>
                    <span className="text-xs text-gray-400 block">{item.symbol}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      {/* 個別株 */}
      <div>
        <h3 className="text-sm font-bold text-gray-300 mb-2">🏢 個別株</h3>

        {/* 登録済みリスト */}
        {financeWL.stocks.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 mb-4">
            {financeWL.stocks.map(item => (
              <div
                key={item.symbol}
                className={`flex items-center gap-2 px-3 py-2 rounded border transition-colors
                  ${item.enabled ? 'border-neon-blue bg-neon-blue/10' : 'border-gray-600 bg-black/20 text-gray-400'}`}
              >
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={() => toggleWLItem('stocks', item.symbol)}
                  className="accent-neon-blue w-4 h-4 flex-shrink-0"
                />
                <span className="text-sm leading-tight flex-1 min-w-0">
                  <span className="font-bold truncate block">{item.name}</span>
                  <span className="text-xs text-gray-400">{item.symbol}</span>
                </span>
                <button
                  onClick={() => removeStock(item.symbol)}
                  className="text-red-400 hover:text-red-300 text-sm flex-shrink-0 ml-1"
                  title="削除"
                >✕</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm mb-4">まだ登録されていません</p>
        )}

        {/* 新規追加フォーム */}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">ティッカー記号</label>
            <input
              type="text"
              placeholder="例: 7203.T / AAPL"
              value={newStock.symbol}
              onChange={e => setNewStock(s => ({ ...s, symbol: e.target.value }))}
              className="input-field w-36 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">表示名</label>
            <input
              type="text"
              placeholder="例: トヨタ / Apple"
              value={newStock.name}
              onChange={e => setNewStock(s => ({ ...s, name: e.target.value }))}
              className="input-field w-32 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">単位</label>
            <select
              value={newStock.unit}
              onChange={e => setNewStock(s => ({ ...s, unit: e.target.value }))}
              className="input-field w-20 text-sm"
            >
              <option value="円">円</option>
              <option value="ドル">ドル</option>
              <option value="pt">pt</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-400">小数桁</label>
            <select
              value={newStock.dec}
              onChange={e => setNewStock(s => ({ ...s, dec: Number(e.target.value) }))}
              className="input-field w-16 text-sm"
            >
              {[0,1,2,3,4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button
            onClick={addStock}
            disabled={!newStock.symbol.trim() || !newStock.name.trim()}
            className="btn btn-primary text-sm disabled:opacity-40"
          >＋ 追加</button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          ※ Yahoo Finance のティッカー記号を使用（日本株は末尾に .T、例: 7203.T）
        </p>
      </div>

      {/* 保有しているファンド・株式（この画面からは追加・削除しない。一覧を表示するだけ） */}
      <div>
        <h3 className="text-sm font-bold text-gray-300 mb-2">👤 個人所有ファンド・株式</h3>
        <p className="text-xs text-gray-400 mb-2">
          三浦さんが実際に保有しているファンド・株式。常に金融情報の取得対象になります。
        </p>
        {financeWL.personal_holdings.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {financeWL.personal_holdings.map(item => (
              <label
                key={item.name}
                className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer border transition-colors
                  ${item.enabled
                    ? 'border-neon-blue bg-neon-blue/10 text-white'
                    : 'border-gray-600 bg-black/20 text-gray-400 hover:border-gray-400'}`}
              >
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={() => togglePersonalHolding(item.name)}
                  className="accent-neon-blue w-4 h-4 flex-shrink-0"
                />
                <span className="text-sm leading-tight min-w-0">
                  <span className="font-bold block truncate">{item.name}</span>
                  <span className="text-xs text-gray-400 block">
                    {item.institution}・{item.kind === 'fund' ? '投資信託' : '株式/ETF'}
                    {item.kind === 'fund' ? `（${item.fund_code}）` : `（${item.symbol}）`}
                  </span>
                  {item.note && (
                    <span className="text-xs text-yellow-500 block">⚠ {item.note}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">まだ登録されていません</p>
        )}
      </div>
    </div>
  );
}
