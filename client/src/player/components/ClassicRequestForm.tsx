/**
 * @file Classic チャンネルの選曲リクエストの入力欄（時代・ムード・ジャンル・自由入力）
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
 * 時代・ムード・ジャンルの候補（押すと選び、もう一度押すと外れる）と自由入力の欄。
 * どれか1つでも選ぶか入力すれば送れる。Enter でも送れる。
 * @param props.onSend 送信するときに呼ぶ
 */
export function ClassicRequestForm({
  era, mood, genre, free, onEraChange, onMoodChange, onGenreChange, onFreeChange, onSend,
}: {
  era: string; mood: string; genre: string; free: string;
  onEraChange: (v: string) => void;
  onMoodChange: (v: string) => void;
  onGenreChange: (v: string) => void;
  onFreeChange: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <fieldset className="glass-fieldset">
      <legend>
        <span className="text-xl">🎻</span>
        <span className="text-base font-normal text-gray-300">選曲リクエスト</span>
      </legend>
      <div className="mt-3 space-y-3">
        {/* 時代チップ */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">時代</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['バロック', '古典派', 'ロマン派', '近現代'] as const).map(e => (
              <button key={e}
                onClick={() => onEraChange(era === e ? '' : e)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${era === e
                    ? 'bg-indigo-600/40 border-indigo-500/70 text-indigo-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}>
                {e}
              </button>
            ))}
          </div>
        </div>
        {/* ムードチップ */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">ムード</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['穏やか', '華やか', '情熱的', '瞑想的'] as const).map(m => (
              <button key={m}
                onClick={() => onMoodChange(mood === m ? '' : m)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${mood === m
                    ? 'bg-indigo-600/40 border-indigo-500/70 text-indigo-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>
        {/* ジャンルチップ */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">ジャンル</p>
          <div className="flex gap-1.5 flex-wrap">
            {(['交響曲', 'ピアノ曲', '室内楽', '協奏曲'] as const).map(g => (
              <button key={g}
                onClick={() => onGenreChange(genre === g ? '' : g)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${genre === g
                    ? 'bg-indigo-600/40 border-indigo-500/70 text-indigo-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}>
                {g}
              </button>
            ))}
          </div>
        </div>
        {/* 自由入力 + 送信 */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="作曲家・曲名など（例: ショパンの夜想曲、カラヤン指揮で）"
            value={free}
            onChange={e => onFreeChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onSend()}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl
              outline-none text-sm text-gray-200 placeholder-gray-500
              px-3 py-2 focus:ring-0 focus:border-indigo-500/50 transition-colors"
            style={{ boxShadow: 'none' }}
          />
          <button
            onClick={onSend}
            disabled={!era && !mood && !genre && !free.trim()}
            className="p-2.5 rounded-xl bg-indigo-600/30 border border-indigo-500/40
              text-indigo-400 hover:bg-indigo-600/50 transition-all
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
