/**
 * @file 常設のティッカー（金融・天気・ニュース・交通）の流れる帯
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

import { useRef, useLayoutEffect, useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * 中身を右端の外から流し入れ、そのあと継ぎ目なく流し続ける。
 *
 * children には同じ内容を2回並べたもの（二重の中身）を渡す。入場が終わったら、
 * 全体の半分（1周分）だけ左へ動かすアニメーションを無限に繰り返すので、境目が見えない。
 * 入場は中身（contentKey）が変わったときだけで、同じ中身の間は流れ続ける。
 * @param props.contentKey 中身を表すキー。変わったときだけ入場からやり直す
 * @param props.loopDurationSec 1周にかける秒数（入場の速さもこれに合わせる）
 */
export function LoopingTicker({ contentKey, loopDurationSec, children }: { contentKey: string; loopDurationSec: number; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const innerRef     = useRef<HTMLDivElement | null>(null);
  const animRef      = useRef<Animation | null>(null);
  const prevKeyRef   = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (contentKey === prevKeyRef.current) return;
    prevKeyRef.current = contentKey;
    animRef.current?.cancel();

    const containerEl = containerRef.current;
    const innerEl      = innerRef.current;
    if (!containerEl || !innerEl) return;

    const containerW = containerEl.offsetWidth;
    const halfW       = innerEl.offsetWidth / 2; // 二重の中身のうち1周分の幅
    const pxPerSec    = halfW / Math.max(0.1, loopDurationSec);

    // 入場: 右端の外 → 0
    const entranceDurationMs = Math.max(200, (containerW / pxPerSec) * 1000);
    const entranceAnim = innerEl.animate(
      [{ transform: `translateX(${containerW}px)` }, { transform: 'translateX(0px)' }],
      { duration: entranceDurationMs, easing: 'linear', fill: 'forwards' },
    );
    animRef.current = entranceAnim;

    entranceAnim.onfinish = () => {
      // 流し続ける: 0 → -halfW を無限に繰り返す
      const loopAnim = innerEl.animate(
        [{ transform: 'translateX(0px)' }, { transform: `translateX(${-halfW}px)` }],
        { duration: loopDurationSec * 1000, easing: 'linear', iterations: Infinity },
      );
      animRef.current = loopAnim;
    };
  }, [contentKey, loopDurationSec]);

  useEffect(() => () => { animRef.current?.cancel(); }, []);

  return (
    <div ref={containerRef} style={{ overflow: 'hidden', flex: 1, height: '100%', position: 'relative' }}>
      <div ref={innerRef} style={{
        position: 'absolute', top: 0, left: 0, height: '100%',
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
        transform: 'translateX(100%)', // アニメーションが始まるまでのちらつきを防ぐ
      }}>
        {children}
      </div>
    </div>
  );
}
