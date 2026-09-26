/**
 * @file ショートカットキーを、実際にキーを押して記録する入力欄
 *
 * KeyboardEvent.code（物理的なキーの位置）で記録するので、macOS の Option による合成文字
 * （例: Option+M → µ）の影響を受けない。
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

import { useState, useEffect } from 'react';
import type { ShortcutConfig } from '../types';
import { formatShortcut } from '../utils';

/** 修飾キーのコード。これだけを押した時点では確定しない。 */
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight',
]);

/**
 * ボタンを押すと記録待ちになり、次に押したキーの組み合わせを記録する。Esc で取り消す。
 * 修飾キー（Ctrl・Option・Cmd）を含まない組み合わせは、通常の文字入力と衝突するので受け付けない。
 * @param props.value 今のショートカット
 * @param props.onChange 記録できたときに呼ぶ
 */
export function ShortcutRecorder({ value, onChange }: {
  value: ShortcutConfig | null | undefined;
  onChange: (v: ShortcutConfig) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [warning, setWarning] = useState('');

  useEffect(() => {
    if (!recording) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') { setRecording(false); return; }
      if (MODIFIER_CODES.has(e.code)) return;
      if (!(e.ctrlKey || e.altKey || e.metaKey)) {
        setWarning('修飾キー（Ctrl/Option/Cmd）を含めてください（通常の文字入力と衝突するため）');
        return;
      }
      onChange({ ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey, code: e.code });
      setWarning('');
      setRecording(false);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recording, onChange]);

  return (
    <div>
      <button type="button"
        onClick={() => { setRecording(true); setWarning(''); }}
        className={`btn ${recording ? 'btn-primary' : 'btn-dark'}`}
        style={{ padding: '4px 10px', fontSize: '0.78rem', minWidth: '150px', lineHeight: 1.2 }}
      >
        {recording ? 'キーを押してください…（Esc）' : formatShortcut(value)}
      </button>
      {warning && <p className="text-xs text-red-400 mt-1">{warning}</p>}
    </div>
  );
}
