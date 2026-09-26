/**
 * @file 緊急地震速報の全画面表示（プレーヤー画面）
 *
 * 震度・震源・対象の地域・定型の呼びかけ・発表時刻を、点滅する赤い枠で表示する。受信・チャイム・読み上げは
 * useEarthquakeAlert が行う。
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

import type { EarthquakeAlert } from '../types';

/**
 * 緊急地震速報のオーバーレイ。
 * @param props.alert 速報の内容
 * @param props.onClose 閉じるボタンで呼ぶ
 */
export function EarthquakeAlertOverlay({ alert, onClose }: { alert: EarthquakeAlert; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(180,0,0,0.92)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '24px',
        backdropFilter: 'blur(4px)',
        animation: 'eewFlash 0.4s ease-in-out 3',
      }}
    >
      {/* 点滅のアニメーションの定義 */}
      <style>{`
        @keyframes eewFlash {
          0%,100% { background: rgba(180,0,0,0.92); }
          50%      { background: rgba(255,60,0,0.97); }
        }
        @keyframes eewPulse {
          0%,100% { transform: scale(1); }
          50%      { transform: scale(1.04); }
        }
      `}</style>

      <div style={{
        maxWidth: 560, width: '100%',
        background: 'rgba(0,0,0,0.55)',
        borderRadius: 20,
        border: '3px solid rgba(255,200,0,0.8)',
        padding: '32px 28px',
        textAlign: 'center',
        boxShadow: '0 0 60px rgba(255,60,0,0.6)',
        animation: 'eewPulse 1s ease-in-out infinite',
      }}>
        {/* ヘッダー */}
        <div style={{ fontSize: 48, marginBottom: 8 }}>🚨</div>
        <div style={{
          fontSize: 28, fontWeight: 900, color: '#ffd700',
          letterSpacing: 4, marginBottom: 16,
          textShadow: '0 0 20px rgba(255,215,0,0.8)',
        }}>
          緊急地震速報
        </div>

        {/* 震度バッジ */}
        <div style={{
          display: 'inline-block',
          background: alert.maxScaleLabel.includes('6') || alert.maxScaleLabel === '7'
            ? '#7f1d1d' : '#92400e',
          border: '2px solid #fbbf24',
          borderRadius: 12,
          padding: '8px 24px',
          marginBottom: 20,
        }}>
          <span style={{ fontSize: 13, color: '#fcd34d', display: 'block', marginBottom: 2 }}>
            最大予測震度
          </span>
          <span style={{ fontSize: 42, fontWeight: 900, color: '#fff' }}>
            {alert.maxScaleLabel}
          </span>
        </div>

        {/* 震源情報 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 20, color: '#fff', fontWeight: 700, marginBottom: 6 }}>
            震源: {alert.hypocenter}
          </div>
          {alert.magnitude && (
            <div style={{ fontSize: 15, color: '#fca5a5' }}>
              {alert.magnitude}
              {alert.depth ? ` / ${alert.depth}` : ''}
            </div>
          )}
        </div>

        {/* 対象エリア */}
        {alert.areaNames?.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 6,
            justifyContent: 'center', marginBottom: 20,
          }}>
            {alert.areaNames.map(a => (
              <span key={a} style={{
                fontSize: 13, background: 'rgba(255,255,255,0.15)',
                borderRadius: 20, padding: '3px 12px', color: '#fef3c7',
              }}>{a}</span>
            ))}
          </div>
        )}

        {/* 定型メッセージ */}
        <div style={{
          fontSize: 16, color: '#fff', fontWeight: 600,
          background: 'rgba(255,255,255,0.1)',
          borderRadius: 10, padding: '12px 16px',
          marginBottom: 24, lineHeight: 1.6,
        }}>
          強い揺れに備えてください
        </div>

        {/* 発表時刻 */}
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 20 }}>
          発表: {alert.issuedAt}
        </div>

        {/* 閉じるボタン */}
        <button
          onClick={onClose}
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.4)',
            borderRadius: 8, padding: '8px 32px',
            color: '#fff', fontSize: 14, cursor: 'pointer',
            transition: 'background 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.25)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
        >
          閉じる
        </button>
      </div>
    </div>
  );
}
