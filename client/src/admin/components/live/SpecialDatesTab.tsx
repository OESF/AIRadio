/**
 * @file 管理画面の Live「特別な日」タブ（家族の誕生日・記念日など）
 *
 * リスナーのプロフィールに、特別な日（期間とラベル）を登録する。その期間中は、番組や秘書が
 * 【本日該当】として知り、ひとこと触れられる（サーバーの secretary-profile-format.js）。
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
import type { FullConfig, SpecialDate } from '../../types';

/**
 * 登録済みの特別な日の一覧と、追加・編集のフォーム。保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体（show.user_profile.special_dates を書き換える）
 */
export function SpecialDatesTab({
  config, setConfig, newSpecialDate, setNewSpecialDate, editingSpecialIdx, setEditingSpecialIdx,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  newSpecialDate: SpecialDate;
  setNewSpecialDate: Dispatch<SetStateAction<SpecialDate>>;
  editingSpecialIdx: number | null;
  setEditingSpecialIdx: (v: number | null) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-xl">🎉</span>
        <h2 className="text-lg font-bold text-white">特別な日</h2>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        登録した期間中は番組全体に自動で通知されます。MAX・Claraが話題にし、サキが特集コーナーを展開します。
      </p>

      {/* 登録済みカードリスト */}
      {(config.show.user_profile.special_dates ?? []).length > 0 && (
        <div className="flex flex-col gap-3 mb-4">
          {(config.show.user_profile.special_dates ?? []).map((sd, idx) => {
            const todayMMDD = (() => { const d = new Date(); return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
            const isActive = todayMMDD >= sd.start && todayMMDD <= sd.end;
            return (
              <div key={idx} className={`bp-5 rounded-xl border-2 ${isActive ? 'border-neon-purple/60 bg-neon-purple/5' : 'border-glass bg-white/3'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      {isActive && <span className="text-sm font-bold px-2 py-0.5 rounded-full bg-neon-purple/20 text-neon-purple">🎉 今日が対象期間</span>}
                      <span className="text-base font-bold text-white">{sd.label}</span>
                      <span className="text-sm font-mono text-neon-blue">
                        {sd.start === sd.end ? sd.start : `${sd.start} 〜 ${sd.end}`}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${sd.personal === false ? 'bg-white/10 text-gray-400' : 'bg-pink-500/20 text-pink-300'}`}>
                        {sd.personal === false ? '🌐 共通行事' : '👪 個人の記念日'}
                      </span>
                    </div>
                    {sd.instruction && (
                      <div className="text-sm text-gray-300">💬 {sd.instruction}</div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => { setNewSpecialDate({ ...sd }); setEditingSpecialIdx(idx); }}
                      className="btn btn-dark text-sm px-3 py-1 border border-neon-blue/40 hover:border-neon-blue text-neon-blue"
                    >✏️ 編集</button>
                    <button
                      onClick={() => {
                        const next = (config.show.user_profile.special_dates ?? []).filter((_, i) => i !== idx);
                        setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, special_dates: next } } });
                        if (editingSpecialIdx === idx) { setEditingSpecialIdx(null); setNewSpecialDate({ start: '', end: '', label: '', instruction: '', personal: true }); }
                      }}
                      className="btn btn-dark text-sm px-3 py-1 border border-red-500/40 hover:border-red-500 text-red-400"
                    >🗑 削除</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 追加・編集フォーム */}
      <div className={`flex flex-col gap-4 bp-5 border-2 rounded-xl ${editingSpecialIdx !== null ? 'border-neon-blue/50 bg-neon-blue/5' : 'border-dashed border-glass'}`}>
        <p className="text-sm font-bold text-gray-300">{editingSpecialIdx !== null ? '✏️ 編集中' : '＋ 新規追加'}</p>
        <div className="flex gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-400">開始日 (MM-DD) *</label>
            <input type="text" placeholder="12-23" maxLength={5}
              value={newSpecialDate.start}
              onChange={e => setNewSpecialDate(p => ({ ...p, start: e.target.value }))}
              className="w-28 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-gray-400">終了日 (MM-DD) *</label>
            <input type="text" placeholder="12-25" maxLength={5}
              value={newSpecialDate.end}
              onChange={e => setNewSpecialDate(p => ({ ...p, end: e.target.value }))}
              className="w-28 font-mono"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
            <label className="text-sm text-gray-400">ラベル *</label>
            <input type="text" placeholder="クリスマス / 結婚記念日"
              value={newSpecialDate.label}
              onChange={e => setNewSpecialDate(p => ({ ...p, label: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-400">番組への指示（サキへの依頼など）</label>
          <input type="text"
            placeholder="例: クリスマス特集コーナーを盛大に！ / 奥様との結婚記念日を祝うロマンティック特集を"
            value={newSpecialDate.instruction}
            onChange={e => setNewSpecialDate(p => ({ ...p, instruction: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && document.getElementById('saveSpecialDateBtn')?.click()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-400">種別</label>
          <div className="flex gap-2">
            <button type="button"
              onClick={() => setNewSpecialDate(p => ({ ...p, personal: true }))}
              className={`btn px-4 text-sm ${newSpecialDate.personal !== false ? 'btn-primary' : 'btn-dark'}`}
            >👪 個人の記念日</button>
            <button type="button"
              onClick={() => setNewSpecialDate(p => ({ ...p, personal: false }))}
              className={`btn px-4 text-sm ${newSpecialDate.personal === false ? 'btn-primary' : 'btn-dark'}`}
            >🌐 共通行事</button>
          </div>
          <p className="text-xs text-gray-500">
            個人の記念日（誕生日・結婚記念日など）は「リスナーご本人・ご家族の出来事」として扱われ、
            パーソナリティが自分の身内の話として語らないよう注意されます。共通行事（クリスマス・お正月など）は
            誰にとっても共通の行事として扱われます。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            id="saveSpecialDateBtn"
            onClick={() => {
              const { start, end, label, instruction, personal } = newSpecialDate;
              if (!start || !end || !label) { alert('開始日・終了日・ラベルは必須です'); return; }
              const mmdd = /^\d{2}-\d{2}$/;
              if (!mmdd.test(start) || !mmdd.test(end)) { alert('日付は MM-DD 形式で入力してください（例: 12-23）'); return; }
              const current = config.show.user_profile.special_dates ?? [];
              const next = editingSpecialIdx !== null
                ? current.map((sd, i) => i === editingSpecialIdx ? { start, end, label, instruction, personal: personal !== false } : sd)
                : [...current, { start, end, label, instruction, personal: personal !== false }];
              setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, special_dates: next } } });
              setNewSpecialDate({ start: '', end: '', label: '', instruction: '', personal: true });
              setEditingSpecialIdx(null);
            }}
            className="btn btn-primary px-5"
          >{editingSpecialIdx !== null ? '✏️ 更新' : '＋ 追加'}</button>
          {editingSpecialIdx !== null && (
            <button onClick={() => { setEditingSpecialIdx(null); setNewSpecialDate({ start: '', end: '', label: '', instruction: '', personal: true }); }}
              className="btn btn-dark px-4">キャンセル</button>
          )}
        </div>
      </div>
    </div>
  );
}
