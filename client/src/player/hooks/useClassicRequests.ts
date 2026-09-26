/**
 * @file Classic チャンネルの選曲リクエスト・もう一度聴くリクエスト
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
import type { ClassicTrack, FullConfig } from '../types';
import { postListenerRequest, sendChannelReplayRequest } from '../utils';

/** useClassicRequests が受け取るもの。 */
export interface UseClassicRequestsDeps {
  serverUrl: string;
  wsRef: RefObject<WebSocket | null>;
  config: FullConfig | null;
  showInfo: (msg: string) => void;
  showWarn: (msg: string) => void;
}

/**
 * 選曲リクエストと、アンコールリストからの「もう一度聴く」。
 *
 * 選曲リクエストは、時代・ジャンル・気分の選択（「バロックの協奏曲の穏やかなをお願いします」のような
 * 文にまとめる）と自由入力を合わせて、HTTP で送る。「もう一度聴く」は WebSocket で送る。
 * @returns 各入力の値と setter、2つの送信関数
 */
export function useClassicRequests({ serverUrl, wsRef, config, showInfo, showWarn }: UseClassicRequestsDeps) {
  const [classicReqEra,   setClassicReqEra]   = useState('');
  const [classicReqMood,  setClassicReqMood]  = useState('');
  const [classicReqGenre, setClassicReqGenre] = useState('');
  const [classicReqFree,  setClassicReqFree]  = useState('');

  const sendClassicListenerRequest = () => {
    const parts = [
      classicReqEra,
      classicReqGenre,
      classicReqMood ? `${classicReqMood}な` : '',
    ].filter(Boolean);
    const chipText = parts.length > 0 ? parts.join('の') + 'をお願いします' : '';
    const fullText = [chipText, classicReqFree.trim()].filter(Boolean).join('。');
    if (!fullText) return;
    const userName = config?.show?.user_profile?.name || 'リスナー';
    postListenerRequest(serverUrl, showInfo, showWarn, 'classic', `リスナーの${userName}さんからのリクエスト: ${fullText}`, () => {
      setClassicReqEra(''); setClassicReqMood(''); setClassicReqGenre(''); setClassicReqFree('');
    }, '🎻 選曲リクエストを送信しました');
  };

  const sendClassicReplayRequest = (track: ClassicTrack) =>
    sendChannelReplayRequest(wsRef, showInfo, 'CLASSIC_REPLAY_REQUEST', track, `「${track.composition}」`, '🎵');

  return {
    classicReqEra, setClassicReqEra, classicReqMood, setClassicReqMood,
    classicReqGenre, setClassicReqGenre, classicReqFree, setClassicReqFree,
    sendClassicListenerRequest, sendClassicReplayRequest,
  };
}
