/**
 * @file プレーヤー画面のスリープタイマー
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

/**
 * 指定した分数のあとに再生を止めるタイマー。動いている間は画面のスリープを抑え（Screen Wake Lock）、
 * 確実に時間どおりに止まるようにする。
 * @param onExpire 時間が来たときに呼ぶ停止処理（Player.tsx の handleExplicitStop。WebSocket や音声は
 *   Player.tsx が持つので、それに依存せず関数として受け取る）
 * @returns 終了予定の時刻・残り時間の表示・startSleepTimer・cancelSleepTimer
 */
export function useSleepTimer(onExpire: () => void) {
  const [sleepTimerEndMs,   setSleepTimerEndMs]   = useState<number | null>(null);
  const [sleepTimerDisplay, setSleepTimerDisplay] = useState('');
  const sleepTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const sleepWakeLockRef = useRef<any>(null);

  // 1秒ごとに残り時間の表示を更新し、時間が来たら止める
  useEffect(() => {
    if (sleepTimerEndMs === null) {
      if (sleepTimerRef.current) { clearInterval(sleepTimerRef.current); sleepTimerRef.current = null; }
      setSleepTimerDisplay('');
      return;
    }
    const tick = () => {
      const remaining = sleepTimerEndMs - Date.now();
      if (remaining <= 0) {
        if (sleepTimerRef.current) { clearInterval(sleepTimerRef.current); sleepTimerRef.current = null; }
        setSleepTimerEndMs(null);
        setSleepTimerDisplay('');
        console.log('[Sleep] タイマー発火 → 停止');
        sleepWakeLockRef.current?.release().catch(() => {});
        sleepWakeLockRef.current = null;
        onExpire();
        return;
      }
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      setSleepTimerDisplay(
        (h > 0 ? `${h}時間` : '') + (m > 0 ? `${m}分` : '') + `${s}秒後に停止`
      );
    };
    tick();
    sleepTimerRef.current = setInterval(tick, 1000);
    return () => { if (sleepTimerRef.current) clearInterval(sleepTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepTimerEndMs]);

  /** タイマーを始める。 */
  const startSleepTimer = (minutes: number) => {
    console.log(`[Sleep] タイマー開始: ${minutes}分後に停止`);
    setSleepTimerEndMs(Date.now() + minutes * 60 * 1000);
    // PC がスリープするとタイマーが止まるので、画面のスリープを抑える
    if ('wakeLock' in navigator) {
      (navigator as any).wakeLock.request('screen')
        .then((lock: any) => {
          sleepWakeLockRef.current = lock;
          lock.addEventListener('release', () => { sleepWakeLockRef.current = null; });
          console.log('[Sleep] Screen Wake Lock 取得');
        })
        .catch(() => {});
    }
  };
  /** タイマーを取り消す。 */
  const cancelSleepTimer = () => {
    console.log('[Sleep] タイマーキャンセル');
    setSleepTimerEndMs(null);
    sleepWakeLockRef.current?.release().catch(() => {});
    sleepWakeLockRef.current = null;
  };

  // ATTENTION: Wake Lock はタブが隠れると自動で解放される。タブに戻ったときに取り直さないと、
  //            別のタブを見ている間に PC がスリープしてタイマーが止まる
  useEffect(() => {
    if (sleepTimerEndMs === null || !('wakeLock' in navigator)) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || sleepWakeLockRef.current) return;
      (navigator as any).wakeLock.request('screen')
        .then((lock: any) => {
          sleepWakeLockRef.current = lock;
          lock.addEventListener('release', () => { sleepWakeLockRef.current = null; });
          console.log('[Sleep] Screen Wake Lock 再取得');
        })
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [sleepTimerEndMs]);

  return { sleepTimerEndMs, sleepTimerDisplay, startSleepTimer, cancelSleepTimer };
}
