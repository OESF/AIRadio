/**
 * @file 音楽4チャンネル共通の「リクエストキュー」パネル
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

import type { ReactNode } from 'react';
import type { ChannelListAccent } from '../types';
import { QUEUE_ACCENT } from '../constants';

/**
 * これから流れるリクエスト曲を、順番の番号付きで一覧表示する。
 * @param props.accent チャンネルの色
 * @param props.renderRow 曲を「題名・補足」の2行に変換する（チャンネルごとに曲の型が違うため）
 */
export function RequestQueuePanel<T>({
  accent, queue, renderRow,
}: {
  accent: ChannelListAccent;
  queue: T[];
  renderRow: (track: T) => { title: ReactNode; subtitle: ReactNode };
}) {
  const col = QUEUE_ACCENT[accent];
  return (
    <fieldset className="glass-fieldset">
      <legend>
        <span className="text-xl">📋</span>
        <span className="text-base font-normal text-gray-300">リクエストキュー</span>
      </legend>
      <div className="mt-3 space-y-2">
        {queue.map((track, i) => {
          const { title, subtitle } = renderRow(track);
          return (
            <div key={i} className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10" style={{ padding: '8px 12px' }}>
              <span className="flex-shrink-0 w-5 h-5 rounded-full border text-xs flex items-center justify-center font-mono"
                style={{ background: col.bg, borderColor: col.border, color: col.color }}>
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200 truncate">{title}</div>
                <div className="text-xs text-gray-500 truncate">{subtitle}</div>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
