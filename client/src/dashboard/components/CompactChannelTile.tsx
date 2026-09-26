/**
 * @file ダッシュボードの、音楽チャンネル（Classic・Jazz・Mood・Beatles・24/You）の小さなタイル
 *
 * 情報が多くないチャンネルなので、1チャンネルを3行に絞る:
 *   1行目: チャンネル名と状態のランプ
 *   2行目: 今いちばん大事なこと（話している人 → 考えている人 → 再生中の曲 → 待機中、の順に優先）
 *   3行目: 最後の接続
 * 動いているチャンネルだけ枠を光らせ、止まっているものは薄く見せる。
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

import type { ReactNode } from 'react';
import { CHANNELS } from '../../player/constants';
import AgentAvatar from './AgentAvatar';
import { LastSessionFooter, PanelHeader, errorTitle, recentErrorOf } from './PanelParts';
import { DIM_TEXT, TWENTYFOURYOU_MODE_LABELS, infoLineStyle, readableOnPanel, shortAgentName } from '../constants';
import type { ChannelSnapshot } from '../types';

interface Props {
  channelId: string;
  snapshot: ChannelSnapshot | undefined;
  agentNames?: Record<string, string>;
}

/**
 * 音楽チャンネル1つ分のタイル。
 * @param props.channelId チャンネル ID
 * @param props.snapshot チャンネルの今の状態（まだ届いていなければ undefined）
 * @param props.agentNames エージェントのキー → 表示名
 */
export default function CompactChannelTile({ channelId, snapshot, agentNames }: Props) {
  const meta = CHANNELS.find((c) => c.id === channelId);
  const is24You = channelId === '24you';
  const connected = !!snapshot?.connected;
  const speaking = snapshot?.speakingAgent;
  const thinking = snapshot?.thinkingAgent;
  const isActive = connected || !!speaking || !!thinking;
  const err = recentErrorOf(snapshot);
  const color = meta?.color ?? '#7c3aed';
  const nameOf = (key: string) => shortAgentName(agentNames?.[key] ?? key);

  let primary: ReactNode;
  if (is24You) {
    // 24/You には話す人（アバター）がいないので、選曲中かどうかと選曲モードを出す
    const mode = snapshot?.twentyFourYouMode
      ? (TWENTYFOURYOU_MODE_LABELS[snapshot.twentyFourYouMode] ?? snapshot.twentyFourYouMode) : null;
    primary = thinking === '24you_selector'
      ? <Line color="var(--color-warning)">🤔 選曲中…</Line>
      : snapshot?.nowPlaying
        ? <Line color="#e2e8f0">♪ {snapshot.nowPlaying.title} — {snapshot.nowPlaying.artist}</Line>
        : <Line>{connected ? `視聴中${mode ? `・${mode}` : ''}` : '未接続'}</Line>;
  } else if (speaking) {
    primary = <Line agentKey={speaking} color="#e2e8f0" glow={color}>{nameOf(speaking)}が話し中</Line>;
  } else if (thinking) {
    primary = <Line agentKey={thinking} color="var(--color-warning)" glow="var(--color-warning)">{nameOf(thinking)}が考え中</Line>;
  } else if (snapshot?.nowPlaying) {
    primary = <Line color="#e2e8f0">♪ {snapshot.nowPlaying.title} — {snapshot.nowPlaying.artist}</Line>;
  } else {
    primary = <Line>{connected ? '放送中' : '待機中'}</Line>;
  }

  return (
    <div
      className="glass-panel"
      style={{
        height: 112, padding: '10px 14px',
        display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden',
        borderColor: isActive ? color : undefined,
        boxShadow: isActive ? `0 0 14px ${color}33` : undefined,
        opacity: isActive ? 1 : 0.82,
      }}
    >
      <PanelHeader
        compact
        emoji={meta?.emoji ?? '📡'}
        name={meta?.name ?? channelId}
        color={readableOnPanel(meta?.color)}
        dot={err ? 'error' : isActive ? 'active' : 'inactive'}
        dotTitle={err ? errorTitle(err) : isActive ? '稼働中' : '待機中'}
      />
      {primary}
      <LastSessionFooter snapshot={snapshot} />
    </div>
  );
}

/**
 * タイルの2行目。agentKey があれば小さなアバターを添える。
 * @param props.glow アバターを光らせる色
 */
function Line({ children, agentKey, color = DIM_TEXT, glow }: {
  children: ReactNode;
  agentKey?: string;
  color?: string;
  glow?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: '0.78rem', color }}>
      {agentKey && <AgentAvatar agentKey={agentKey} size={20} active glowColor={glow} />}
      <span style={infoLineStyle}>{children}</span>
    </div>
  );
}
