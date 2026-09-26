/**
 * @file Mood チャンネルの選曲リクエスト・もう一度聴くリクエスト
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
import type { RefObject } from 'react';
import type { MoodTrack } from '../types';
import { postListenerRequest, sendChannelReplayRequest } from '../utils';

/** useMoodRequests が受け取るもの。 */
export interface UseMoodRequestsDeps {
  serverUrl: string;
  wsRef: RefObject<WebSocket | null>;
  showInfo: (msg: string) => void;
  showWarn: (msg: string) => void;
}

/**
 * 自由入力の選曲リクエスト（HTTP で送る）と、アンコールリストからの「もう一度聴く」（WebSocket で送る）。
 * @returns 入力欄の値と setter、2つの送信関数
 */
export function useMoodRequests({ serverUrl, wsRef, showInfo, showWarn }: UseMoodRequestsDeps) {
  const [moodReqFree, setMoodReqFree] = useState('');

  const sendMoodListenerRequest = () => {
    const text = moodReqFree.trim();
    if (!text) return;
    postListenerRequest(serverUrl, showInfo, showWarn, 'mood', text, () => setMoodReqFree(''), '🌙 リクエストを受け付けました', 'リクエストの送信に失敗しました');
  };

  const sendMoodReplayRequest = (track: MoodTrack) =>
    sendChannelReplayRequest(wsRef, showInfo, 'MOOD_REPLAY_REQUEST', track, `"${track.title}"`, '🌙');

  return { moodReqFree, setMoodReqFree, sendMoodListenerRequest, sendMoodReplayRequest };
}
