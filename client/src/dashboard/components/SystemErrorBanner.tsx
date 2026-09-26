/**
 * @file ダッシュボード上部の「直近の不具合」バナー
 *
 * 各チャンネルのスナップショットにある最後のエラーのうち、5分以内のものを表示する。
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

import { CHANNELS } from '../../player/constants';
import { errorCodeLabel } from '../eventDescriptions';
import type { ChannelSnapshot } from '../types';

interface Props {
  channels: Record<string, ChannelSnapshot>;
}

/** これより古いエラーは表示しない。 */
const ERROR_STALE_MS = 5 * 60 * 1000;

/**
 * 5分以内のエラーがあるチャンネルごとに1行ずつ表示する。無ければ何も描画しない。
 * @param props.channels チャンネル ID → スナップショット
 */
export default function SystemErrorBanner({ channels }: Props) {
  const now = Date.now();
  const errors = Object.entries(channels)
    .filter(([, snap]) => snap.lastError && (now - snap.lastError.ts) < ERROR_STALE_MS)
    .map(([channelId, snap]) => ({ channelId, error: snap.lastError! }));

  if (errors.length === 0) return null;

  return (
    <div style={{
      background: 'rgba(239, 71, 111, 0.10)', border: '1px solid var(--color-danger)',
      borderRadius: 12, padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ color: 'var(--color-danger)', fontWeight: 700, fontSize: '0.9rem' }}>
        ⚠ 直近5分以内に発生した不具合
      </div>
      {errors.map(({ channelId, error }) => {
        const meta = CHANNELS.find((c) => c.id === channelId);
        return (
          <div key={channelId} style={{ fontSize: '0.82rem', color: '#e2e8f0' }}>
            {/* 内部コード（TTS_FAILED など）は、読んで分かる言葉に置き換えて表示する */}
            {meta?.emoji ?? '📡'} {meta?.name ?? channelId}: <span style={{ color: 'var(--color-danger)' }}>
              {errorCodeLabel(error.code)}
            </span>{error.message ? ` — ${error.message}` : ''}
          </div>
        );
      })}
    </div>
  );
}
