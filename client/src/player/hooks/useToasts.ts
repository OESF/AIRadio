/**
 * @file プレーヤー画面のトースト（警告・お知らせ）の表示状態
 *
 * 表示は ToastOverlay が行う。
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

import { useRef, useState } from 'react';

/**
 * トーストの表示状態と、表示する関数を返す。
 *
 * お知らせは3秒、警告は4秒表示し、そのあと 320ms の退場アニメーションを経て消える。
 * 表示中に次を出すと、前のタイマーを止めて差し替える。
 * @returns 表示中の文言・退場中かどうか・showInfo・showWarn
 */
export function useToasts() {
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const [warnToast, setWarnToast] = useState<string | null>(null);
  const [infoLeave, setInfoLeave] = useState(false);
  const [warnLeave, setWarnLeave] = useState(false);
  const infoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showInfo = (msg: string) => {
    if (infoTimer.current) clearTimeout(infoTimer.current);
    setInfoLeave(false); setInfoToast(msg);
    infoTimer.current = setTimeout(() => {
      setInfoLeave(true);
      infoTimer.current = setTimeout(() => { setInfoToast(null); setInfoLeave(false); }, 320);
    }, 3000);
  };
  const showWarn = (msg: string) => {
    if (warnTimer.current) clearTimeout(warnTimer.current);
    setWarnLeave(false); setWarnToast(msg);
    warnTimer.current = setTimeout(() => {
      setWarnLeave(true);
      warnTimer.current = setTimeout(() => { setWarnToast(null); setWarnLeave(false); }, 320);
    }, 4000);
  };

  return { infoToast, warnToast, infoLeave, warnLeave, showInfo, showWarn };
}
