/**
 * @file 音楽4チャンネル共通の「アンコールリスト」（再生履歴）パネル
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

import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChannelListAccent } from '../types';
import { PLAYED_ACCENT } from '../constants';

/**
 * これまでに流れた曲を一覧表示し、各行の再生ボタンで「もう一度聴く」を送る。
 * @param props.renderRow 曲を「題名・補足・演奏者」に変換する（チャンネルごとに曲の型が違うため）
 * @param props.onReplay 再生ボタンを押したときに呼ぶ
 */
export function PlayedHistoryPanel<T>({
  icon, accent, list, renderRow, onReplay,
}: {
  icon: ReactNode;
  accent: ChannelListAccent;
  list: T[];
  renderRow: (track: T) => { title: ReactNode; subtitle: ReactNode; performerDisplay: string | null; performerIcon: string };
  onReplay: (track: T) => void;
}) {
  const col = PLAYED_ACCENT[accent];
  return (
    <fieldset className="glass-fieldset">
      <legend>
        {icon}
        <span className="text-base font-normal text-gray-300">アンコールリスト</span>
      </legend>
      <div className="mt-3 space-y-2 overflow-y-auto" style={{ maxHeight: '280px' }}>
        {list.map((track, i) => {
          const { title, subtitle, performerDisplay, performerIcon } = renderRow(track);
          return (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2" style={{ padding: '8px 12px' }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200 truncate font-medium">{title}</div>
                <div className="text-xs text-gray-500 truncate">{subtitle}</div>
                {performerDisplay && (
                  <div className="text-xs truncate mt-0.5" style={{ color: col.color }}>{performerIcon} {performerDisplay}</div>
                )}
              </div>
              <button
                onClick={() => onReplay(track)}
                title="もう一度聴く"
                className="flex-shrink-0 p-1.5 rounded-lg border transition-all active:scale-90"
                style={{ background: col.bg, borderColor: col.border, color: col.color }}
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
