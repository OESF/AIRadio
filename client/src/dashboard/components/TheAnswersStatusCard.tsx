/**
 * @file ダッシュボードの The Answers の固定パネル
 *
 * 議題（3行まで）・狙い（2行まで）・出演者の全員（話している人・考えている人を光らせる）・経過時間の棒を出す。
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
import { DIM_TEXT, infoLineStyle, readableOnPanel, shortAgentName } from '../constants';
import AgentAvatar from './AgentAvatar';
import { EmptyNote, LastSessionFooter, PanelHeader, Pill, SectionLabel, errorTitle, recentErrorOf } from './PanelParts';
import type { ChannelSnapshot } from '../types';

interface Props {
  snapshot: ChannelSnapshot | undefined;
}

/** 出演者1人の情報（PANEL_ASSIGNED で届く）。 */
interface PanelistInfo { key?: string; sourceAgentKey?: string; name?: string; role?: string }

/**
 * The Answers のパネル。
 * @param props.snapshot The Answers の今の状態
 */
export default function TheAnswersStatusCard({ snapshot }: Props) {
  const meta = CHANNELS.find((c) => c.id === 'the_answers');
  const color = meta?.color ?? '#9d4edd';
  const textColor = readableOnPanel(meta?.color);
  const ta = snapshot?.theAnswers ?? {};
  const themeEvt = ta.THEME_ANNOUNCED as { theme?: string; concept?: string } | undefined;
  const panel = (ta.PANEL_ASSIGNED as { panel?: PanelistInfo[] } | undefined)?.panel ?? [];
  const round = ta.ROUND_TIMER as { elapsedMs?: number; capMs?: number } | undefined;
  const isClosing = 'CLOSING' in ta;
  const isEnded = 'SHOW_ENDED' in ta;
  const isTalking = !!(snapshot?.speakingAgent || snapshot?.thinkingAgent);
  const isOnAir = !!snapshot?.connected || isTalking;
  const err = recentErrorOf(snapshot);

  // ディレクター（'answers_director'）は声を持たず出演者にも含まれないが、議題の候補を作ってから
  // 議題が決まるまでの間は thinkingAgent にこのキーが入る（agent-system-the-answers.js）
  const isDirectorThinking = snapshot?.thinkingAgent === 'answers_director';

  const phase = isEnded ? { label: 'エピソード終了', color: '#94a3b8' }
    : isClosing ? { label: 'まとめ', color: '#fcd34d' }
      : themeEvt ? { label: '討論中', color: '#6ee7b7' }
        : isDirectorThinking ? { label: '議題を検討中…', color: '#fcd34d' }
          : { label: '議題待機中', color: '#94a3b8' };

  const hasTimer = round?.elapsedMs != null && !!round?.capMs;
  const elapsedMin = hasTimer ? Math.round(round!.elapsedMs! / 60000) : 0;
  const capMin = hasTimer ? Math.round(round!.capMs! / 60000) : 0;
  const pct = hasTimer ? Math.min(100, (round!.elapsedMs! / round!.capMs!) * 100) : 0;

  return (
    <div
      className="glass-panel dash-main-panel"
      style={{
        padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden',
        borderColor: isTalking ? color : undefined,
        boxShadow: isTalking ? `0 0 18px ${color}33` : undefined,
      }}
    >
      <PanelHeader
        emoji={meta?.emoji ?? '🗣️'}
        name={meta?.name ?? 'The Answers'}
        color={textColor}
        dot={err ? 'error' : isOnAir ? 'active' : 'inactive'}
        dotTitle={err ? errorTitle(err) : isOnAir ? '稼働中' : '待機中'}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Pill color={phase.color}>{phase.label}</Pill>
          {hasTimer && (
            <span style={{ marginLeft: 'auto', fontSize: '0.74rem', color: DIM_TEXT, fontVariantNumeric: 'tabular-nums' }}>
              経過 {elapsedMin}分 / 上限 {capMin}分
            </span>
          )}
        </div>
        {hasTimer && (
          <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.6s ease' }} />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        <SectionLabel>テーマ</SectionLabel>
        <div
          className="dash-clamp-3"
          title={themeEvt?.theme}
          style={{ fontSize: '0.95rem', fontWeight: 600, lineHeight: 1.45, color: themeEvt?.theme ? '#f1f5f9' : DIM_TEXT }}
        >
          {themeEvt?.theme ?? (isDirectorThinking ? 'ディレクタが議題を検討しています…' : 'まだ決まっていません')}
        </div>
        {themeEvt?.concept && (
          <div className="dash-clamp-2" title={themeEvt.concept} style={{ fontSize: '0.74rem', lineHeight: 1.5, color: DIM_TEXT }}>
            {themeEvt.concept}
          </div>
        )}
      </div>

      <div className="dash-scroll" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>出演者</SectionLabel>
        {panel.length === 0 ? (
          <EmptyNote>まだ決まっていません</EmptyNote>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 10 }}>
            {panel.map((p, i) => {
              // 発言者は poolKey（例: live_commentator）で届くが、アバターの画像は元のチャンネルでの
              // キー（sourceAgentKey）で引く（Player.tsx と同じ）
              const isSpeaking = !!p.key && p.key === snapshot?.speakingAgent;
              const isThinking = !!p.key && p.key === snapshot?.thinkingAgent;
              return (
                <div
                  key={p.key ?? i}
                  title={`${p.name ?? ''}${p.role ? `（${p.role}）` : ''}`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}
                >
                  <AgentAvatar
                    agentKey={p.sourceAgentKey}
                    size={44}
                    active={isSpeaking || isThinking}
                    glowColor={isSpeaking ? color : 'var(--color-warning)'}
                  />
                  <span style={{
                    ...infoLineStyle, width: '100%', textAlign: 'center', fontSize: '0.74rem',
                    color: isSpeaking ? '#f1f5f9' : '#cbd5e1', fontWeight: isSpeaking ? 700 : 400,
                  }}>
                    {p.name ? shortAgentName(p.name) : '—'}
                  </span>
                  <span style={{
                    ...infoLineStyle, width: '100%', textAlign: 'center', fontSize: '0.62rem',
                    color: isSpeaking ? textColor : isThinking ? 'var(--color-warning)' : DIM_TEXT,
                  }}>
                    {isSpeaking ? '🗣 話し中' : isThinking ? '🧠 考え中' : (p.role || ' ')}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <LastSessionFooter snapshot={snapshot} />
    </div>
  );
}
