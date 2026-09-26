/**
 * @file 音楽チャンネル共通の「番組設定」タブ（番組名・よみがな・概要）
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

import type { FormEvent, ReactNode } from 'react';

/**
 * 番組名・よみがな・概要の入力欄と保存ボタン。チャンネル固有の項目は extra で下に足す。
 * @param props.setProgram 変更した項目だけを渡す（親が既存の値と合わせる）
 * @param props.extra チャンネル固有の追加の入力欄
 */
export function ChannelShowSettingsTab<TProgram extends { name: string; name_reading: string; description: string }>({
  icon, title, program, setProgram, onSubmit, extra,
}: {
  icon: string;
  title: string;
  program: TProgram;
  setProgram: (patch: Partial<TProgram>) => void;
  onSubmit: (e: FormEvent) => void;
  extra?: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-xl">{icon}</span>
        <h2 className="text-lg font-bold text-white">{title}</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label>番組名</label>
          <input type="text" value={program.name}
            onChange={e => setProgram({ name: e.target.value } as Partial<TProgram>)} />
        </div>
        <div>
          <label>よみがな</label>
          <input type="text" value={program.name_reading}
            onChange={e => setProgram({ name_reading: e.target.value } as Partial<TProgram>)} />
        </div>
        <div className="md:col-span-2">
          <label>番組概要</label>
          <textarea rows={3} value={program.description}
            onChange={e => setProgram({ description: e.target.value } as Partial<TProgram>)} />
        </div>
      </div>
      {extra}
      <button type="submit" className="btn btn-primary py-3">番組設定を保存</button>
    </form>
  );
}
