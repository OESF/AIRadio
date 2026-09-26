/**
 * @file Live チャンネルのリクエストの入力欄（楽曲・話題・メッセージ）
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
 * リクエストの種類（楽曲・話題・メッセージ）を選ぶタブと、入力欄・送信ボタン。Enter でも送れる。
 * @param props.requestType 選んでいる種類（入力欄の例文が変わる）
 * @param props.onSend 送信するときに呼ぶ
 */
export function LiveRequestForm({
  requestType, onRequestTypeChange, directionInput, onDirectionInputChange, onSend,
}: {
  requestType: 'song' | 'topic' | 'message';
  onRequestTypeChange: (v: 'song' | 'topic' | 'message') => void;
  directionInput: string;
  onDirectionInputChange: (v: string) => void;
  onSend: () => void;
}) {
  return (
    <fieldset className="glass-fieldset">
      <legend>
        <span className="text-xl">💬</span>
        <span className="text-base font-normal text-gray-300">リクエスト送信</span>
      </legend>
      <div className="mt-3">
        {/* タイプ選択タブ */}
        <div className="flex gap-1.5">
          {([
            { key: 'song',    label: '🎵 楽曲' },
            { key: 'topic',   label: '🗣️ 話題' },
            { key: 'message', label: '✉️ メッセージ' },
          ] as const).map(({ key, label }) => (
            <button key={key}
              onClick={() => onRequestTypeChange(key)}
              className={`flex-1 px-2 py-1.5 rounded-lg text-xs border transition-all
                ${requestType === key
                  ? 'bg-indigo-600/40 border-indigo-500/70 text-indigo-200'
                  : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}>
              {label}
            </button>
          ))}
        </div>
        {/* テキスト入力 */}
        <div className="flex items-center gap-2" style={{ marginTop: '14px' }}>
          <input
            type="text"
            placeholder={
              requestType === 'song'  ? '曲名・アーティスト（例: ビートルズのLet It Be）' :
              requestType === 'topic' ? 'トークテーマ（例: 最近気になるニュース）' :
              'メッセージを入力...'
            }
            value={directionInput}
            onChange={e => onDirectionInputChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onSend()}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl
              outline-none text-base text-gray-200 placeholder-gray-500
              px-3 py-2 focus:ring-0 focus:border-indigo-500/50 transition-colors"
            style={{ boxShadow: 'none' }}
          />
          <button
            onClick={onSend}
            disabled={!directionInput.trim()}
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
