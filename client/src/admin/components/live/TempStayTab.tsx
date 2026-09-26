/**
 * @file 管理画面の Live「臨時滞在」タブ（旅行中などに天気・交通を取る場所の登録）
 *
 * 期間を決めて滞在先を登録すると、その期間中は居住地の代わりに滞在先の天気・交通を伝える
 * （放送と秘書の両方。サーバーの secretary-profile-format.js の getEffectiveLocationFromConfig で判定）。
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
import type { FullConfig, TempStay } from '../../types';

/**
 * 登録済みの滞在の一覧と、登録・編集のフォーム。保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体（show.temp_stay を書き換える）
 * @param props.newTempStay 登録フォームの入力中の値
 * @param props.editingTempStay 編集中の滞在（無ければ新規登録）
 */
export function TempStayTab({
  config, setConfig, newTempStay, setNewTempStay, editingTempStay, setEditingTempStay,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  newTempStay: TempStay;
  setNewTempStay: Dispatch<SetStateAction<TempStay>>;
  editingTempStay: boolean;
  setEditingTempStay: (v: boolean) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-xl">📍</span>
        <h2 className="text-lg font-bold text-white">臨時滞在地</h2>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        設定期間中は天気・交通情報の取得先が滞在地に切り替わり、番組の会話にも反映されます。
      </p>

      {/* 登録済みカード */}
      {(() => {
        const ts = config.show.temp_stay;
        if (!ts?.location || !ts?.start || !ts?.end) return null;
        const today = new Date().toISOString().slice(0, 10);
        const isActive = today >= ts.start && today <= ts.end;
        return (
          <div className={`mb-4 bp-5 rounded-xl border-2 ${isActive ? 'border-neon-green/60 bg-neon-green/5' : 'border-glass bg-white/3'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${isActive ? 'bg-neon-green/20 text-neon-green' : 'bg-gray-700 text-gray-400'}`}>
                    {isActive ? '🟢 現在滞在中' : '⚪ 期間外'}
                  </span>
                  <span className="text-base font-bold text-white">{ts.location}</span>
                  <span className="text-sm text-gray-400">({ts.purpose})</span>
                </div>
                <div className="text-sm text-gray-300">
                  📅 {ts.start} 〜 {ts.end}
                  {ts.timezone !== 'Asia/Tokyo' && <span className="ml-2 text-gray-500">({ts.timezone})</span>}
                </div>
                {ts.note && <div className="text-sm text-gray-400 mt-1">📝 {ts.note}</div>}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => { setNewTempStay({ ...ts, note: ts.note ?? '' }); setEditingTempStay(true); }}
                  className="btn btn-dark text-sm px-3 py-1 border border-neon-blue/40 hover:border-neon-blue text-neon-blue"
                >✏️ 編集</button>
                <button
                  onClick={() => { setConfig({ ...config, show: { ...config.show, temp_stay: undefined } }); setEditingTempStay(false); setNewTempStay({ location: '', purpose: 'レジャー', start: '', end: '', timezone: 'Asia/Tokyo', note: '' }); }}
                  className="btn btn-dark text-sm px-3 py-1 border border-red-500/40 hover:border-red-500 text-red-400"
                >🗑 削除</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 登録・編集フォーム */}
      <div className={`flex flex-col gap-4 bp-5 border-2 rounded-xl ${editingTempStay ? 'border-neon-blue/50 bg-neon-blue/5' : 'border-dashed border-glass'}`}>
        <p className="text-sm font-bold text-gray-300">{editingTempStay ? '✏️ 編集中' : '＋ 新規登録'}</p>
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1 flex-1 min-w-[160px]">
            <label className="text-sm text-gray-400">滞在地名 *</label>
            <input type="text" placeholder="白馬村 / ニューヨーク"
              value={newTempStay.location}
              onChange={e => setNewTempStay(p => ({ ...p, location: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-400">目的</label>
            <select value={newTempStay.purpose} onChange={e => setNewTempStay(p => ({ ...p, purpose: e.target.value }))}>
              <option>レジャー</option><option>出張</option><option>帰省</option><option>その他</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-400">タイムゾーン</label>
            <select value={newTempStay.timezone} onChange={e => setNewTempStay(p => ({ ...p, timezone: e.target.value }))}>
              <option value="Asia/Tokyo">日本 (JST)</option>
              <option value="America/New_York">米国東部 (ET)</option>
              <option value="America/Los_Angeles">米国西部 (PT)</option>
              <option value="Europe/London">ロンドン (GMT)</option>
              <option value="Europe/Paris">中欧 (CET)</option>
              <option value="Asia/Singapore">シンガポール (SGT)</option>
              <option value="Asia/Seoul">韓国 (KST)</option>
              <option value="Australia/Sydney">シドニー (AEST)</option>
            </select>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-400">開始日 *</label>
            <input type="date" value={newTempStay.start} onChange={e => setNewTempStay(p => ({ ...p, start: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-400">終了日 *</label>
            <input type="date" value={newTempStay.end} onChange={e => setNewTempStay(p => ({ ...p, end: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label className="text-sm text-gray-400">メモ（任意）</label>
            <input type="text" placeholder="スキー旅行 / カンファレンス参加"
              value={newTempStay.note ?? ''} onChange={e => setNewTempStay(p => ({ ...p, note: e.target.value }))} />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const { location, start, end } = newTempStay;
              if (!location || !start || !end) { alert('滞在地名・開始日・終了日は必須です'); return; }
              if (start > end) { alert('終了日は開始日以降にしてください'); return; }
              setConfig({ ...config, show: { ...config.show, temp_stay: { ...newTempStay } } });
              setNewTempStay({ location: '', purpose: 'レジャー', start: '', end: '', timezone: 'Asia/Tokyo', note: '' });
              setEditingTempStay(false);
            }}
            className="btn btn-primary px-5"
          >{editingTempStay ? '✏️ 更新' : '＋ 登録'}</button>
          {editingTempStay && (
            <button onClick={() => { setEditingTempStay(false); setNewTempStay({ location: '', purpose: 'レジャー', start: '', end: '', timezone: 'Asia/Tokyo', note: '' }); }}
              className="btn btn-dark px-4">キャンセル</button>
          )}
        </div>
      </div>
    </div>
  );
}
