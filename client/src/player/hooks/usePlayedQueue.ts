/**
 * @file 音楽4チャンネル共通の「再生履歴」と「リクエストキュー」の状態
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

import { useState } from 'react';

/**
 * 再生履歴とリクエストキューの状態を作る。
 *
 * useState と同じ並びのタプルで返すので、呼び出し側は好きな変数名（classicPlayedList など）で受け取れる。
 * @returns [再生履歴, 再生履歴の setter, リクエストキュー, リクエストキューの setter]
 */
export function usePlayedQueue<T>() {
  const [playedList, setPlayedList] = useState<T[]>([]);
  const [queue,      setQueue]      = useState<T[]>([]);
  return [playedList, setPlayedList, queue, setQueue] as const;
}
