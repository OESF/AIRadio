/**
 * @file 翻訳テロップの流れる帯（右端の外から左端の外まで1回だけ流す）
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

import { useRef, useLayoutEffect } from 'react';

/**
 * テキストを右端の外から左端の外まで1回だけ流し、流れ切ったら onDone を呼ぶ（繰り返さない）。
 *
 * 曲を挟まずに発話が続くと、呼び出し元が text に新しい文を継ぎ足していく
 * （例: 「評論」→「評論／次の曲紹介」）。
 *
 * ATTENTION: text が伸びたときに流し直さないこと。読み終えた前半がもう一度流れてしまう。
 *            今の位置から、伸びた分の終わりまでを同じ速さで続けて流す。
 * @param props.text 流すテキスト（継ぎ足されて伸びることがある）
 * @param props.pxPerSec 流れる速さ（px/秒）
 * @param props.onDone 流れ切ったときに呼ぶ
 */
export function CaptionTicker({ text, pxPerSec, onDone }: { text: string; pxPerSec: number; onDone: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const textRef       = useRef<HTMLSpanElement | null>(null);
  const animRef       = useRef<Animation | null>(null);
  const prevTextRef   = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (text === prevTextRef.current) return; // onDone が作り直されただけの再実行は無視する
    const containerEl = containerRef.current;
    const textEl       = textRef.current;
    if (!containerEl || !textEl) return;

    const containerW = containerEl.offsetWidth;
    const textW      = textEl.offsetWidth; // 継ぎ足した後のテキスト全体の幅

    const prevAnim = animRef.current;
    if (!prevAnim) {
      // 初回: 右端の外側から左端の外側まで
      const distancePx  = containerW + textW;
      const durationMs  = Math.max(3000, (distancePx / pxPerSec) * 1000);
      const newAnim = textEl.animate(
        [{ transform: `translate(${containerW}px, -50%)` }, { transform: `translate(${-textW}px, -50%)` }],
        { duration: durationMs, easing: 'linear', fill: 'forwards' },
      );
      newAnim.onfinish = () => onDone();
      animRef.current = newAnim;
    } else {
      // 伸びたとき: 今の位置から、新しい終わりまでを同じ速さで続ける
      const elapsedMs = typeof prevAnim.currentTime === 'number' ? prevAnim.currentTime : 0;
      const currentX  = containerW - (pxPerSec * elapsedMs) / 1000;
      const remainingPx = currentX - (-textW);
      prevAnim.cancel();
      if (remainingPx <= 0) { onDone(); return; } // すでに流れ切っていた
      const durationMs = (remainingPx / pxPerSec) * 1000;
      const newAnim = textEl.animate(
        [{ transform: `translate(${currentX}px, -50%)` }, { transform: `translate(${-textW}px, -50%)` }],
        { duration: durationMs, easing: 'linear', fill: 'forwards' },
      );
      newAnim.onfinish = () => onDone();
      animRef.current = newAnim;
    }
    prevTextRef.current = text;
  }, [text, pxPerSec, onDone]);

  return (
    <div ref={containerRef} style={{ overflow: 'hidden', flex: 1, height: '100%', position: 'relative' }}>
      <span
        ref={textRef}
        style={{
          position: 'absolute', top: '50%', whiteSpace: 'nowrap',
          fontSize: '1.3rem', fontFamily: 'ui-monospace,monospace', color: '#e2e8f0',
          transform: 'translate(100%, -50%)', // アニメーションが始まるまで右の外に置き、ちらつきを防ぐ
        }}
      >
        {text}
      </span>
    </div>
  );
}
