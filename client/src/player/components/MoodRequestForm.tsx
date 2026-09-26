/**
 * @file Mood チャンネルの選曲リクエストの入力欄
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

import { Send } from 'lucide-react';

/**
 * 候補のボタン（押すと入力欄に入り、もう一度押すと消える）と自由入力の欄。Enter か送信ボタンで送る。
 * @param props.free 入力欄の値
 * @param props.onSend 送信するときに呼ぶ
 */
export function MoodRequestForm({
  free, onFreeChange, onSend,
}: {
  free: string;
  onFreeChange: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <fieldset className="glass-fieldset">
      <legend>
        <span className="text-xl">🌙</span>
        <span className="text-base font-normal text-gray-300">選曲リクエスト</span>
      </legend>
      <div className="mt-3">
        <div className="flex gap-1.5 flex-wrap mb-3">
          {(['映画音楽', 'ムードミュージック', 'ボサノバ', 'タンゴ'] as const).map(cat => (
            <button key={cat}
              onClick={() => onFreeChange(free === cat ? '' : cat)}
              className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                ${free === cat
                  ? 'border-blue-500/70 text-blue-200'
                  : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}
              style={free === cat ? { background: 'rgba(30,58,95,0.4)' } : {}}>
              {cat}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="アーティスト・映画名・雰囲気など自由に"
            value={free}
            onChange={e => onFreeChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onSend()}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl
              outline-none text-sm text-gray-200 placeholder-gray-500
              px-3 py-2 focus:ring-0 transition-colors"
            style={{ boxShadow: 'none', outlineColor: 'rgba(59,130,246,0.5)' }}
          />
          <button
            onClick={onSend}
            disabled={!free.trim()}
            className="p-2.5 rounded-xl bg-blue-600/30 border border-blue-500/40
              text-blue-400 hover:bg-blue-600/50 transition-all
              disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
            title="送信"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </fieldset>
  );
}
