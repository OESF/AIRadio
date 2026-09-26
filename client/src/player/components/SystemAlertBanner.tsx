/**
 * @file システムの異常（AI の利用料金の残高切れなど）を知らせる、閉じられないバナー
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

import { useLayoutEffect, useRef } from 'react';
import type { SystemAlert } from '../hooks/useEarthquakeAlert';

/**
 * システムの異常を画面の上端に出し続けるバナー。
 *
 * AI の利用料金の残高が尽きると、放送も秘書も日報も止まる。LINE は見ていないことがあるので、
 * 必ず見るメイン画面（ウェルカム画面を含む）に出す。
 *
 * ATTENTION: このバナーを閉じられるようにしないこと。原因が解消するまで放送が動かないので、
 *            消せると見落とす。サーバーが復旧（次の API 呼び出しの成功）を見つけると自動で消える。
 *            一時的な異常（AI 側の不調・レート制限）は、新しい失敗がしばらく無ければサーバーが解消とみなして消す。
 * @param props.alerts 表示する異常（無ければ何も描画しない）
 */
export function SystemAlertBanner({ alerts }: { alerts: SystemAlert[] }) {
  const barRef = useRef<HTMLDivElement>(null);
  const shown = alerts?.length ?? 0;

  // バナーは上端に固定するので、そのままでは画面の上の内容に重なる。バナーの高さを測り、
  // アプリの一番外の要素に padding-top を入れて内容を押し下げる。
  // ATTENTION: 押し下げたあとに resize を発火させること。ウェルカム画面のチャンネル一覧は
  //            位置から高さを計算していて（Player.tsx の welcomeCardMaxHeight）、resize のときしか
  //            計算し直さない
  useLayoutEffect(() => {
    const root = document.getElementById('root')?.firstElementChild as HTMLElement | null;
    if (!root) return;
    const prevPadding = root.style.paddingTop;
    const prevBoxSizing = root.style.boxSizing;

    const apply = () => {
      const h = shown > 0 ? (barRef.current?.offsetHeight ?? 0) : 0;
      root.style.boxSizing = 'border-box';
      root.style.paddingTop = h > 0 ? `${h}px` : prevPadding;
      window.dispatchEvent(new Event('resize'));
    };
    apply();

    const ro = barRef.current ? new ResizeObserver(apply) : null;
    if (ro && barRef.current) ro.observe(barRef.current);
    return () => {
      ro?.disconnect();
      root.style.paddingTop = prevPadding;
      root.style.boxSizing = prevBoxSizing;
      window.dispatchEvent(new Event('resize'));
    };
  }, [shown]);

  if (!alerts || alerts.length === 0) return null;

  return (
    <div ref={barRef} style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998 }}>
      {alerts.map((a) => {
        const critical = a.severity === 'critical';
        return (
          <div
            key={a.kind}
            role="alert"
            style={{
              display: 'flex', alignItems: 'flex-start', gap: '12px',
              padding: '12px 20px',
              background: critical ? '#7f1d1d' : '#78350f',
              borderBottom: `2px solid ${critical ? '#ef4444' : '#f59e0b'}`,
              color: '#fff',
              boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
              animation: critical ? 'systemAlertPulse 2.4s ease-in-out infinite' : undefined,
            }}
          >
            <span style={{ fontSize: '20px', lineHeight: 1.2, flexShrink: 0 }} aria-hidden>
              {critical ? '⚠️' : 'ℹ️'}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '2px' }}>{a.title}</div>
              <div style={{ fontSize: '13px', lineHeight: 1.6, opacity: 0.92 }}>{a.detail}</div>
              <div style={{ fontSize: '11px', marginTop: '4px', opacity: 0.7 }}>
                {new Date(a.since).toLocaleString('ja-JP')} から発生（{a.count}件）
                — 復旧すると自動的に消えます
              </div>
            </div>
          </div>
        );
      })}
      <style>{`
        @keyframes systemAlertPulse {
          0%, 100% { border-bottom-color: #ef4444; }
          50%      { border-bottom-color: #fca5a5; }
        }
      `}</style>
    </div>
  );
}
