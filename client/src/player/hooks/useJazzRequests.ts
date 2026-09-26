/**
 * @file Jazz チャンネルの選曲リクエスト・もう一度聴くリクエスト
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
import type { JazzTrack, FullConfig } from '../types';
import { postListenerRequest, sendChannelReplayRequest } from '../utils';

/** useJazzRequests が受け取るもの。 */
export interface UseJazzRequestsDeps {
  serverUrl: string;
  wsRef: RefObject<WebSocket | null>;
  config: FullConfig | null;
  showInfo: (msg: string) => void;
  showWarn: (msg: string) => void;
}

/**
 * 選曲リクエストと、アンコールリストからの「もう一度聴く」。
 *
 * 選曲リクエストは、スタイル・気分・楽器の選択を1文にまとめ、自由入力と合わせて HTTP で送る
 * （Jazz は英語の番組なので、送る文の書き出しは英語）。「もう一度聴く」は WebSocket で送る。
 * @returns 各入力の値と setter、2つの送信関数
 */
export function useJazzRequests({ serverUrl, wsRef, config, showInfo, showWarn }: UseJazzRequestsDeps) {
  const [jazzReqStyle,      setJazzReqStyle]      = useState('');
  const [jazzReqMood,       setJazzReqMood]       = useState('');
  const [jazzReqInstrument, setJazzReqInstrument] = useState('');
  const [jazzReqFree,       setJazzReqFree]       = useState('');

  const sendJazzListenerRequest = () => {
    const parts = [
      jazzReqStyle,
      jazzReqMood ? `${jazzReqMood}な` : '',
      jazzReqInstrument ? `${jazzReqInstrument}が活きる` : '',
    ].filter(Boolean);
    const chipText = parts.length > 0 ? parts.join('、') + '曲をお願いします' : '';
    const fullText = [chipText, jazzReqFree.trim()].filter(Boolean).join('。');
    if (!fullText) return;
    const userName = config?.show?.user_profile?.name || 'リスナー';
    postListenerRequest(serverUrl, showInfo, showWarn, 'jazz', `${userName}'s request: ${fullText}`, () => {
      setJazzReqStyle(''); setJazzReqMood(''); setJazzReqInstrument(''); setJazzReqFree('');
    }, '🎷 選曲リクエストを送信しました');
  };

  const sendJazzReplayRequest = (track: JazzTrack) =>
    sendChannelReplayRequest(wsRef, showInfo, 'JAZZ_REPLAY_REQUEST', track, `"${track.title}"`, '🎷');

  return {
    jazzReqStyle, setJazzReqStyle, jazzReqMood, setJazzReqMood,
    jazzReqInstrument, setJazzReqInstrument, jazzReqFree, setJazzReqFree,
    sendJazzListenerRequest, sendJazzReplayRequest,
  };
}
