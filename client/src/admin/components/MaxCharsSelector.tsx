/**
 * @file 管理画面の「最大発話文字数」の選択ボタン
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

import { MAX_CHARS_OPTIONS } from '../constants';

/**
 * エージェントが1回に話す文字数の上限を、ボタンの並びから選ぶ。0 は無制限。
 * @param props.value 今の設定。未設定は無制限として扱う
 * @param props.accentColor 選択中のボタンの色
 */
export function MaxCharsSelector({
  value, onChange, accentColor = 'purple',
}: {
  value: number | undefined;
  onChange: (v: number) => void;
  accentColor?: 'purple' | 'amber' | 'blue' | 'red' | 'cyan';
}) {
  const current = value ?? 0;
  // ATTENTION: accentColor に色を足したら、ここの分岐にも足すこと（足し忘れると既定の紫になる）。
  const activeCol = accentColor === 'amber' ? '#f59e0b' : accentColor === 'blue' ? '#3b82f6' : accentColor === 'red' ? '#ef4444' : accentColor === 'cyan' ? '#0891b2' : '#6366f1';
  return (
    <div>
      <label className="mb-2" style={{ display: 'block' }}>
        最大発話文字数
        <span className="ml-2 text-xs" style={{ color: current === 0 ? '#6b7280' : activeCol, fontWeight: 600 }}>
          {current === 0 ? '無制限（現在の設定）' : `${current}字以内（現在の設定）`}
        </span>
      </label>
      <div className="flex flex-wrap gap-1.5">
        {MAX_CHARS_OPTIONS.map(opt => {
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              style={{
                padding: '3px 12px', fontSize: '12px', borderRadius: '9999px', border: '1px solid',
                cursor: 'pointer',
                borderColor: active ? activeCol : '#4b5563',
                background:  active ? activeCol : 'transparent',
                color:       active ? '#fff'    : '#9ca3af',
                fontWeight:  active ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
