/**
 * @file The Answers（プレーヤー画面）の状態と操作（議題・出演者・挙手と発言・時間・カルーセル）
 *
 * 他のチャンネルと違い、接続の前に議題を REST で送ってエピソードを始め、それから WebSocket につなぐ。
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

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TheAnswersPanelMember, TheAnswersHandState, TheAnswersRoundTimer } from '../types';

/** useTheAnswers が受け取るもの。 */
export interface UseTheAnswersDeps {
  serverUrl: string;
  wsRef: RefObject<WebSocket | null>;
  activeSpeaker: string | null;
  showWarn: (msg: string) => void;
  startRadioStream: () => Promise<void>;
}

/**
 * The Answers の状態と操作を返す。
 * @param deps.activeSpeaker 今話している人（カルーセルをその人に向ける）
 * @param deps.startRadioStream エピソードを始めたあとに WebSocket へつなぐ
 * @returns 議題・候補・出演者・挙手の状態・時間と、それらを操作する関数
 */
export function useTheAnswers({ serverUrl, wsRef, activeSpeaker, showWarn, startRadioStream }: UseTheAnswersDeps) {
  const [theAnswersTopicInput, setTheAnswersTopicInput] = useState('');
  const [theAnswersStarting,   setTheAnswersStarting]   = useState(false);
  // ウェルカム画面の議題の候補（3つ）。「テーマ検索」で何度でも引き直せる
  const [theAnswersCandidates, setTheAnswersCandidates] = useState<string[]>([]);
  const [theAnswersCandidatesLoading, setTheAnswersCandidatesLoading] = useState(false);
  const [theAnswersTheme,      setTheAnswersTheme]      = useState<string | null>(null);
  const [theAnswersPanel,      setTheAnswersPanel]      = useState<TheAnswersPanelMember[]>([]);
  const [theAnswersHandState,  setTheAnswersHandState]  = useState<TheAnswersHandState>('idle');
  const [theAnswersTextInput,  setTheAnswersTextInput]  = useState('');
  const [theAnswersRoundTimer, setTheAnswersRoundTimer] = useState<TheAnswersRoundTimer | null>(null);
  const [theAnswersClosing,    setTheAnswersClosing]    = useState(false);
  // このタブを見分ける ID（挙手・発言がどのリスナーのものかを示す）
  const theAnswersClientIdRef = useRef<string>(Math.random().toString(36).slice(2) + Date.now().toString(36));

  // 出演者の3Dカルーセルの回転の角度（度、足し込んでいく値）。話す人が変わるたびにその人を正面に向ける。
  // ATTENTION: 目標の角度をそのまま入れず、最短の向き（±180度以内）の差を足し込むこと。CSS の rotateY は
  //            数値の差のまま動くので、目標の角度を入れると大回りすることがある
  const [theAnswersCarouselRotation, setTheAnswersCarouselRotation] = useState(0);
  const theAnswersCarouselRotationRef = useRef(0);
  const theAnswersPanelSignatureRef = useRef('');

  // 新しいエピソード（顔ぶれ）になったら回転を戻す（前の回の位置のまま、関係ない人が正面に来ないように）
  useEffect(() => {
    const signature = theAnswersPanel.map(p => p.key).join(',');
    if (signature !== theAnswersPanelSignatureRef.current) {
      theAnswersPanelSignatureRef.current = signature;
      theAnswersCarouselRotationRef.current = 0;
      setTheAnswersCarouselRotation(0);
    }
  }, [theAnswersPanel]);

  // 話す人が変わったら、その人が正面に来るよう最短の向きで回す
  useEffect(() => {
    if (theAnswersPanel.length === 0) return;
    const activeIdx = theAnswersPanel.findIndex(p => p.key === activeSpeaker);
    if (activeIdx < 0) return; // 発言中でない（音楽再生中・ターンの合間等）場合は直前の向きを維持
    const anglePerItem = 360 / theAnswersPanel.length;
    const targetNormalized  = (((-activeIdx * anglePerItem) % 360) + 360) % 360;
    const currentNormalized = ((theAnswersCarouselRotationRef.current % 360) + 360) % 360;
    let delta = targetNormalized - currentNormalized;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const next = theAnswersCarouselRotationRef.current + delta;
    theAnswersCarouselRotationRef.current = next;
    setTheAnswersCarouselRotation(next);
  }, [activeSpeaker, theAnswersPanel]);

  /** 議題の候補を3つ取得する。 */
  const fetchTheAnswersCandidates = async () => {
    setTheAnswersCandidatesLoading(true);
    try {
      const res = await fetch(`${serverUrl}/api/the_answers/theme-candidates`);
      const d = await res.json();
      if (Array.isArray(d.themes)) setTheAnswersCandidates(d.themes);
    } catch {
      // 失敗しても、自由入力の欄は使える
    } finally {
      setTheAnswersCandidatesLoading(false);
    }
  };

  /**
   * 議題を送ってエピソードを始め、WebSocket につなぐ。
   * @param topicOverride 候補のボタンから始めるときの議題（状態の更新を待たずに、押した候補をそのまま使う）
   */
  const startTheAnswersEpisode = async (topicOverride?: string) => {
    if (theAnswersStarting) return;
    setTheAnswersStarting(true);
    try {
      const res = await fetch(`${serverUrl}/api/the_answers/start-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topicOverride ?? theAnswersTopicInput }),
      });
      const d = await res.json();
      if (!res.ok || d.ok === false) {
        showWarn(d.error || '開始に失敗しました。');
        return;
      }
      setTheAnswersTopicInput('');
      setTheAnswersCandidates([]);
      // BUGFIX: 新しい議題と出演者が届くまで、前の回の表示を消しておく（消さないと、選んでいる数秒〜十数秒の間、
      //         前の回の内容が出たままになる）
      setTheAnswersTheme(null);
      setTheAnswersPanel([]);
      setTheAnswersClosing(false);
      setTheAnswersRoundTimer(null);
      setTheAnswersHandState('idle');
      setTheAnswersTextInput('');
      await startRadioStream();
    } catch {
      showWarn('開始に失敗しました。');
    } finally {
      setTheAnswersStarting(false);
    }
  };

  /** 挙手する。 */
  const sendTheAnswersRaiseHand = async () => {
    if (theAnswersHandState !== 'idle') return;
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ event: 'RAISE_HAND', clientId: theAnswersClientIdRef.current }));
      } else {
        await fetch(`${serverUrl}/api/the_answers/hand-raise`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: theAnswersClientIdRef.current }),
        });
      }
    } catch { showWarn('送信に失敗しました。'); }
  };

  /** 発言を送る（挙手して発言権を得てから）。 */
  const sendTheAnswersSubmitText = async () => {
    const text = theAnswersTextInput.trim();
    if (!text || theAnswersHandState !== 'granted') return;
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ event: 'SUBMIT_TEXT', clientId: theAnswersClientIdRef.current, text }));
      } else {
        await fetch(`${serverUrl}/api/the_answers/submit-text`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: theAnswersClientIdRef.current, text }),
        });
      }
    } catch { showWarn('送信に失敗しました。'); }
  };

  /** The Answers の表示の状態を全部戻す（チャンネルを離れたときなど）。 */
  const resetTheAnswersState = () => {
    setTheAnswersTheme(null);
    setTheAnswersPanel([]);
    setTheAnswersClosing(false);
    setTheAnswersRoundTimer(null);
    setTheAnswersHandState('idle');
    setTheAnswersTextInput('');
    setTheAnswersCandidates([]);
  };

  return {
    theAnswersTopicInput, setTheAnswersTopicInput, theAnswersStarting,
    theAnswersCandidates, setTheAnswersCandidates, theAnswersCandidatesLoading,
    theAnswersTheme, setTheAnswersTheme,
    theAnswersPanel, setTheAnswersPanel,
    theAnswersHandState, setTheAnswersHandState,
    theAnswersTextInput, setTheAnswersTextInput,
    theAnswersRoundTimer, setTheAnswersRoundTimer,
    theAnswersClosing, setTheAnswersClosing,
    theAnswersCarouselRotation, theAnswersClientIdRef,
    fetchTheAnswersCandidates, startTheAnswersEpisode,
    sendTheAnswersRaiseHand, sendTheAnswersSubmitText,
    resetTheAnswersState,
  };
}
