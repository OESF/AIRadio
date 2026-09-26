/**
 * @file Jazz チャンネルの選曲リクエストの入力欄（スタイル・ムード・楽器・自由入力）
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
 * スタイル・ムード・楽器の候補（押すと選び、もう一度押すと外れる）と自由入力の欄。
 * どれか1つでも選ぶか入力すれば送れる。Enter でも送れる。
 * @param props.onSend 送信するときに呼ぶ
 */
export function JazzRequestForm({
  style, mood, instrument, free, onStyleChange, onMoodChange, onInstrumentChange, onFreeChange, onSend,
}: {
  style: string; mood: string; instrument: string; free: string;
  onStyleChange: (v: string) => void;
  onMoodChange: (v: string) => void;
  onInstrumentChange: (v: string) => void;
  onFreeChange: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <fieldset className="glass-fieldset">
      <legend>
        <span className="text-xl">🎷</span>
        <span className="text-base font-normal text-gray-300">選曲リクエスト</span>
      </legend>
      <div className="mt-3 space-y-3">
        {/* スタイルチップ */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">スタイル</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['スウィング', 'ビバップ', 'クールジャズ', 'フュージョン'] as const).map(s => (
              <button key={s}
                onClick={() => onStyleChange(style === s ? '' : s)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${style === s
                    ? 'border-yellow-600/70 text-yellow-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}
                style={style === s ? { background: 'rgba(180,83,9,0.3)' } : {}}>
                {s}
              </button>
            ))}
          </div>
        </div>
        {/* ムードチップ */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">ムード</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['メロウ', 'アップテンポ', 'バラード', 'ラテン'] as const).map(m => (
              <button key={m}
                onClick={() => onMoodChange(mood === m ? '' : m)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${mood === m
                    ? 'border-yellow-600/70 text-yellow-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}
                style={mood === m ? { background: 'rgba(180,83,9,0.3)' } : {}}>
                {m}
              </button>
            ))}
          </div>
        </div>
        {/* 楽器チップ */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">楽器</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['トランペット', 'サックス', 'ピアノ', 'ギター'] as const).map(inst => (
              <button key={inst}
                onClick={() => onInstrumentChange(instrument === inst ? '' : inst)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${instrument === inst
                    ? 'border-yellow-600/70 text-yellow-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}
                style={instrument === inst ? { background: 'rgba(180,83,9,0.3)' } : {}}>
                {inst}
              </button>
            ))}
          </div>
        </div>
        {/* 自由入力 + 送信 */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="アーティスト・曲名など（例: Miles Davis、Kind of Blue系）"
            value={free}
            onChange={e => onFreeChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onSend()}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl
              outline-none text-sm text-gray-200 placeholder-gray-500
              px-3 py-2 focus:ring-0 transition-colors"
            style={{ boxShadow: 'none', outlineColor: 'rgba(217,119,6,0.5)' }}
          />
          <button
            onClick={onSend}
            disabled={!style && !mood && !instrument && !free.trim()}
            className="p-2.5 rounded-xl border transition-all
              disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
            style={{ background: 'rgba(180,83,9,0.3)', borderColor: 'rgba(217,119,6,0.4)', color: '#d97706' }}
            title="送信"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </fieldset>
  );
}
