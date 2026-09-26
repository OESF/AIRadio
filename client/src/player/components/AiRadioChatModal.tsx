/**
 * @file AI Radio 管理人（お問い合わせ・リクエストの窓口）のチャット画面
 *
 * 管理人はチャンネルの切り替え・音量などアプリ全体の操作、コーナー・曲・話題のリクエスト、
 * 雑談や質問に答える。放送中かどうかに関わらず使える。
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
import type { RefObject } from 'react';

/**
 * チャットの画面（モーダル）。外側を押すと閉じる。Enter でも送れる。
 * @param props.messages これまでのやり取り
 * @param props.loading 返事を待っている間は true（入力を止め、「…」を出す）
 * @param props.endRef 一覧の末尾（新しいメッセージが来たらここまでスクロールする）
 */
export function AiRadioChatModal({
  onClose, messages, loading, endRef, input, onInputChange, onSend,
}: {
  onClose: () => void;
  messages: { role: 'user' | 'bot'; text: string }[];
  loading: boolean;
  endRef: RefObject<HTMLDivElement | null>;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md flex flex-col rounded-2xl overflow-hidden border border-white/15"
        style={{ background: 'var(--bg-surface, #0f1623)', maxHeight: '80vh', boxShadow: '0 24px 80px rgba(0,0,0,0.7)' }}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0"
          style={{ background: 'rgba(99,102,241,0.15)' }}>
          <div className="flex items-center gap-2">
            <span className="text-lg">💬</span>
            <span className="font-bold text-sm text-indigo-300 tracking-wide">AI Radio管理人</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors w-7 h-7
              flex items-center justify-center rounded-lg hover:bg-white/10"
            style={{ fontSize: '1.2rem', lineHeight: 1 }}
          >×</button>
        </div>

        {/* メッセージ一覧 */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed
                  ${msg.role === 'user'
                    ? 'bg-indigo-600/40 border border-indigo-500/30 text-white'
                    : 'bg-white/8 border border-white/10 text-gray-200'}`}
              >
                {msg.text}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-white/8 border border-white/10 rounded-2xl px-4 py-2.5 text-sm text-gray-400">
                <span className="animate-pulse">…</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {/* 入力エリア */}
        <div className="flex items-center gap-2 px-3 py-3 border-t border-white/10 flex-shrink-0">
          <input
            type="text"
            placeholder="ご質問・リクエストをどうぞ..."
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onSend()}
            disabled={loading}
            autoFocus
            className="flex-1 bg-white/5 border border-white/10 rounded-xl
              outline-none text-sm text-gray-200 placeholder-gray-500
              px-3 py-2 focus:ring-0 focus:border-indigo-500/50 transition-colors
              disabled:opacity-50"
            style={{ boxShadow: 'none' }}
          />
          <button
            onClick={onSend}
            disabled={!input.trim() || loading}
            className="p-2.5 rounded-xl bg-indigo-600/30 border border-indigo-500/40
              text-indigo-400 hover:bg-indigo-600/50 transition-all
              disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
