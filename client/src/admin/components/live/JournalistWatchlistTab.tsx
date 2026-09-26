/**
 * @file 管理画面の Live「ジャーナリストウォッチリスト」タブ
 *
 * ジャーナリストが情報を集める手がかりにする人物・機関を、分類ごとに登録する。
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

import type { FullConfig, JournalistWatchlist } from '../../types';
import { JOURNALIST_CATEGORIES } from '../../constants';
import { AccordionSection } from '../AccordionSection';

/**
 * 分類ごとに開閉できる区画で、登録済みの人物・機関の一覧と追加の欄を表示する。
 *
 * ATTENTION: 画面に出す担当の名前は、必ず設定（config.agents）から引くこと。管理画面で変えられる。
 *
 * @param props.config 管理画面の設定全体（担当の名前の表示にだけ使う。読み込み前は null）
 * @param props.journalistWL 分類 → 登録済みの一覧
 * @param props.getJournalistDraft 分類ごとの入力途中の値
 * @param props.openJournalistSections 開いている分類
 */
export function JournalistWatchlistTab({
  config, journalistWL, getJournalistDraft, setJournalistDraft, addJournalistItem, removeJournalistItem,
  openJournalistSections, toggleJournalistSection,
}: {
  config: FullConfig | null;
  journalistWL: JournalistWatchlist;
  getJournalistDraft: (section: string) => { name: string; x_handle: string };
  setJournalistDraft: (section: string, patch: Partial<{ name: string; x_handle: string }>) => void;
  addJournalistItem: (section: keyof JournalistWatchlist) => void;
  removeJournalistItem: (section: keyof JournalistWatchlist, name: string) => void;
  openJournalistSections: Set<string>;
  toggleJournalistSection: (id: string) => void;
}) {
  const journalistName = config?.agents?.journalist?.name || 'ジャーナリスト';
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-neon-blue text-xl">🕵️</span>
        <h2 className="text-lg font-bold text-neon-blue">ジャーナリストウォッチリスト</h2>
      </div>
      <p className="text-xs text-gray-400">
        {journalistName}が情報収集のヒントとして参照する人物・機関のリストです。気になる人物・団体を追加できます。
        X（Twitter）アカウント名は任意項目です。
      </p>

      {JOURNALIST_CATEGORIES.map(({ key: section, label }) => {
        const draft = getJournalistDraft(section);
        const count = journalistWL[section].length;
        return (
          <AccordionSection
            key={section}
            id={section}
            title={<span>{label} <span className="text-xs text-gray-500 font-normal">（{count}件）</span></span>}
            open={openJournalistSections.has(section)}
            onToggle={toggleJournalistSection}
          >
            {journalistWL[section].length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 mb-3">
                {journalistWL[section].map(item => (
                  <div
                    key={item.name}
                    className="flex items-center gap-2 px-3 py-2 rounded border border-gray-600 bg-black/20"
                  >
                    <span className="text-sm leading-tight flex-1 min-w-0">
                      <span className="font-bold truncate block text-white">{item.name}</span>
                      {item.x_handle && <span className="text-xs text-gray-400">@{item.x_handle}</span>}
                    </span>
                    <button
                      onClick={() => removeJournalistItem(section, item.name)}
                      className="text-red-400 hover:text-red-300 text-sm flex-shrink-0 ml-1"
                      title="削除"
                    >✕</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-sm mb-3">まだ登録されていません</p>
            )}

            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">名前・機関名</label>
                <input
                  type="text"
                  placeholder="例: 山田太郎"
                  value={draft.name}
                  onChange={e => setJournalistDraft(section, { name: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && addJournalistItem(section)}
                  className="input-field w-40 text-sm"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Xアカウント（任意）</label>
                <input
                  type="text"
                  placeholder="例: yamada_taro（@なし）"
                  value={draft.x_handle}
                  onChange={e => setJournalistDraft(section, { x_handle: e.target.value })}
                  onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && addJournalistItem(section)}
                  className="input-field w-40 text-sm"
                />
              </div>
              <button
                onClick={() => addJournalistItem(section)}
                disabled={!draft.name.trim()}
                className="btn btn-primary text-sm disabled:opacity-40"
              >＋ 追加</button>
            </div>
          </AccordionSection>
        );
      })}
    </div>
  );
}
