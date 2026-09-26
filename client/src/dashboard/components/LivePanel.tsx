/**
 * @file ダッシュボードの AI Radio Live の固定パネル
 *
 * Live は話している人・コーナー・編成・討論コーナーと情報がいちばん多いので、上段に大きく固定する。
 * 左に「いま」（話している人・考えている人・コーナー・曲）と討論コーナー、右にディレクターの編成を置く。
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
import AgentAvatar from './AgentAvatar';
import DirectorSchedule from './DirectorSchedule';
import DiscussionCorners from './DiscussionCorners';
import { LastSessionFooter, PanelHeader, errorTitle, recentErrorOf } from './PanelParts';
import {
  DIM_TEXT, DISCUSSION_CORNER_KEYS, LIVE_COLOR,
  cornerEmoji, cornerLabel, discussionName, infoLineStyle, isCornerKey, readableOnPanel, shortAgentName,
} from '../constants';
import type { ChannelSnapshot, DiscussionSettings, LiveQueueShape } from '../types';

interface Props {
  snapshot: ChannelSnapshot | undefined;
  /** live チャンネルの agentKey → 表示名（useAgentNames 由来） */
  agentNames?: Record<string, string>;
  discussionSettings: DiscussionSettings | null;
}

/**
 * Live のパネル。
 * @param props.snapshot Live の今の状態
 * @param props.discussionSettings 討論コーナーのオン・オフ
 */
export default function LivePanel({ snapshot, agentNames, discussionSettings }: Props) {
  const meta = CHANNELS.find((c) => c.id === 'live');
  const isTalking = !!(snapshot?.speakingAgent || snapshot?.thinkingAgent);
  const isOnAir = !!snapshot?.connected || isTalking;
  const err = recentErrorOf(snapshot);
  const nameOf = (key: string | null | undefined) => (key ? shortAgentName(agentNames?.[key] ?? key) : null);
  const directorName = agentNames?.director ? shortAgentName(agentNames.director) : 'ディレクタ';

  const running = DISCUSSION_CORNER_KEYS
    .map((k) => snapshot?.discussions?.[k])
    .find((d) => d?.state === 'running');

  // 討論コーナーの最中は、編成の current が直前のコーナー（ニュースなど）のままのことがあるので、
  // 討論コーナーの進行を優先して出す
  const cornerText = running
    ? `${cornerEmoji(running.key)} ${discussionName(discussionSettings, running.key, running.name)}`
      + `（${(running.stepIndex ?? 0) + 1}/${running.plan?.length ?? '?'}）`
    : isCornerKey(snapshot?.corner)
      ? `${cornerEmoji(snapshot.corner)} ${cornerLabel(snapshot.corner)}`
      : isOnAir ? 'コーナーの合間（トーク）' : '—';

  return (
    <div
      className="glass-panel dash-main-panel dash-live"
      style={{
        padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden',
        borderColor: isTalking ? LIVE_COLOR : undefined,
        boxShadow: isTalking ? `0 0 18px ${LIVE_COLOR}33` : undefined,
      }}
    >
      <PanelHeader
        emoji={meta?.emoji ?? '📻'}
        name={meta?.name ?? 'AI Radio Live'}
        color={readableOnPanel(meta?.color)}
        dot={err ? 'error' : isOnAir ? 'active' : 'inactive'}
        dotTitle={err ? errorTitle(err) : isOnAir ? '放送中' : '待機中'}
        aside={isOnAir && snapshot?.showInfo?.name ? (
          <span style={{ ...infoLineStyle, fontSize: '0.72rem', color: DIM_TEXT }}>{snapshot.showInfo.name}</span>
        ) : null}
      />

      <div className="dash-live-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          {/* ── いま ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
              <WhoBlock
                label="話者"
                agentKey={snapshot?.speakingAgent}
                name={nameOf(snapshot?.speakingAgent)}
                glowColor={LIVE_COLOR}
              />
              <WhoBlock
                label="🧠 思考中"
                agentKey={snapshot?.thinkingAgent}
                name={nameOf(snapshot?.thinkingAgent)}
                glowColor="var(--color-warning)"
              />
            </div>
            <div style={{ fontSize: '0.82rem', color: DIM_TEXT, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <div style={infoLineStyle}>
                コーナー: <span style={{ color: '#e2e8f0' }}>{cornerText}</span>
              </div>
              {snapshot?.nowPlaying && (
                <div style={{ ...infoLineStyle, color: '#e2e8f0' }}>
                  ♪ {snapshot.nowPlaying.title} — {snapshot.nowPlaying.artist}
                </div>
              )}
            </div>
          </div>

          {/* ── 討論コーナー（余った高さはここがスクロールで引き受ける）── */}
          <div className="dash-scroll" style={{ flex: 1, paddingRight: 2 }}>
            <DiscussionCorners
              discussions={snapshot?.discussions}
              settings={discussionSettings}
              agentNames={agentNames}
            />
          </div>
        </div>

        <DirectorSchedule
          queue={snapshot?.queue as LiveQueueShape | undefined}
          isLive={!!snapshot?.connected}
          directorName={directorName}
          discussions={snapshot?.discussions}
          settings={discussionSettings}
        />
      </div>

      <LastSessionFooter snapshot={snapshot} />
    </div>
  );
}

/** 「話している人」「考えている人」の欄（アバター・名前）。 */
function WhoBlock({ label, agentKey, name, glowColor }: {
  label: string;
  agentKey: string | null | undefined;
  name: string | null;
  glowColor: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <AgentAvatar agentKey={agentKey} size={48} active={!!agentKey} glowColor={glowColor} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: '0.68rem', color: DIM_TEXT }}>{label}</span>
        <span style={{ ...infoLineStyle, fontSize: '0.86rem', fontWeight: 600, color: name ? '#e2e8f0' : '#64748b' }}>
          {name ?? '—'}
        </span>
      </div>
    </div>
  );
}
