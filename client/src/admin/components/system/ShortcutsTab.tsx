/**
 * @file 管理画面の「ショートカットキー設定」タブ
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

import type { FormEvent } from 'react';
import type { FullConfig, ShortcutAction, ShortcutConfig } from '../../types';
import { DEFAULT_SHORTCUTS } from '../../types';
import { SHORTCUT_LABELS, SHORTCUT_ORDER } from '../../constants';
import { ShortcutRecorder } from '../ShortcutRecorder';

/**
 * 操作ごとのキーボードショートカットを記録・保存する。未設定の操作は既定のショートカットを表示する。
 * @param props.config 管理画面の設定全体（shortcuts を書き換える）
 */
export function ShortcutsTab({
  config, setConfig, saveConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
}) {
  const shortcuts = config.shortcuts ?? {};
  const setShortcut = (action: ShortcutAction, value: ShortcutConfig) => {
    setConfig({ ...config, shortcuts: { ...shortcuts, [action]: value } });
  };
  return (
    <div className="flex flex-col gap-6" style={{ height: 'calc(100vh - 60px)' }}>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">⌨️</span>
        <h2 className="text-lg font-bold text-neon-blue">ショートカットキー設定</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        マウス操作なしでも一通り操作できるよう、主要な操作にキーボードショートカットを
        割り当てられます。入力欄にフォーカスがある間は無効化されます。変更はプレイヤー画面の
        再読み込み後に反映されます。
      </p>
      <form onSubmit={saveConfig} className="flex flex-col flex-1 min-h-0">
        <div className="overflow-y-auto flex-1 min-h-0 pr-1">
          {SHORTCUT_ORDER.map(action => (
            <div key={action} className="flex items-center justify-between border-b border-white/5"
              style={{ gap: '12px', paddingTop: '6px', paddingBottom: '6px' }}>
              <label className="!mb-0" style={{ fontSize: '0.8rem', fontWeight: 400 }}>
                {SHORTCUT_LABELS[action]}
              </label>
              <ShortcutRecorder
                value={shortcuts[action] ?? DEFAULT_SHORTCUTS[action]}
                onChange={v => setShortcut(action, v)}
              />
            </div>
          ))}
        </div>
        <button type="submit" className="btn btn-primary" style={{ marginTop: '16px', padding: '10px' }}>💾 保存</button>
      </form>
    </div>
  );
}
