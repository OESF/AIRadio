/**
 * @file ダッシュボードの、Live の討論コーナー（ニュースディープダイブなど）の状態
 *
 * Live のパネルの中に、討論コーナーごとに1枚のカードを出す。ふだんは「オン・オフ」と「前回いつ流れたか」の
 * 2行だけ。準備中・進行中になると、台本（誰がどの役で何番目に話すか）をアバターの列で広げ、取材
 * （Google 検索で事実を集める裏の処理）が済んだかも出す。
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

import AgentAvatar from './AgentAvatar';
import { Pill, SectionLabel } from './PanelParts';
import {
  DIM_TEXT, DISCUSSION_CORNER_KEYS, DISCUSSION_CORNER_META, DISCUSSION_ROLE_LABELS, LIVE_COLOR, LIVE_TEXT_COLOR,
  cornerLabel, discussionEnabled, discussionFrequencyLabel, discussionName, formatClock, infoLineStyle, shortAgentName,
} from '../constants';
import type { DiscussionSettings, DiscussionStatus } from '../types';

interface Props {
  discussions: Record<string, DiscussionStatus> | undefined;
  /** null = まだ読めていない（オン・オフの表示を出さない） */
  settings: DiscussionSettings | null;
  agentNames?: Record<string, string>;
}

/**
 * 討論コーナーのカードを並べる。
 * @param props.discussions コーナーごとの直近の状態
 * @param props.settings コーナーのオン・オフ（まだ読めていなければ null）
 */
export default function DiscussionCorners({ discussions, settings, agentNames }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SectionLabel>討論コーナー</SectionLabel>
      {DISCUSSION_CORNER_KEYS.map((key) => (
        <DiscussionCard
          key={key}
          cornerKey={key}
          status={discussions?.[key]}
          settings={settings}
          agentNames={agentNames}
        />
      ))}
    </div>
  );
}

/** 討論コーナー1つ分のカード。 */
function DiscussionCard({ cornerKey, status, settings, agentNames }: {
  cornerKey: string;
  status: DiscussionStatus | undefined;
  settings: DiscussionSettings | null;
  agentNames?: Record<string, string>;
}) {
  const meta = DISCUSSION_CORNER_META[cornerKey];
  const enabled = settings ? discussionEnabled(settings, cornerKey) : null;
  const name = discussionName(settings, cornerKey, status?.name);
  const state = status?.state;
  const isRunning = state === 'running';
  const isActive = isRunning || state === 'preparing';
  const plan = status?.plan ?? [];
  const step = typeof status?.stepIndex === 'number' ? status.stepIndex : null;

  const when = status?.ts ? formatClock(status.ts) : '';
  const headline: { text: string; color: string } =
    isRunning ? { text: `進行中 ${(step ?? 0) + 1} / ${plan.length}`, color: LIVE_TEXT_COLOR }
      : state === 'preparing' ? { text: `準備中（${cornerLabel(meta.after)}の読み上げ中）`, color: 'var(--color-warning)' }
        : state === 'finished' ? { text: `前回 ${when}・${status?.turns ?? 0}発言`, color: DIM_TEXT }
          : state === 'cancelled' ? { text: `${when} 見送り（オフに切り替え）`, color: DIM_TEXT }
            : state === 'interrupted' ? { text: `${when} 中断（切断）`, color: DIM_TEXT }
              : { text: 'まだ流れていません', color: DIM_TEXT };

  return (
    <div style={{
      borderRadius: 10, padding: '8px 10px',
      display: 'flex', flexDirection: 'column', gap: 6,
      background: isActive ? `${LIVE_COLOR}1f` : 'rgba(255,255,255,0.025)',
      border: `1px solid ${isRunning ? `${LIVE_COLOR}aa` : isActive ? `${LIVE_COLOR}55` : 'rgba(255,255,255,0.07)'}`,
      boxShadow: isRunning ? `0 0 14px ${LIVE_COLOR}33` : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ flexShrink: 0 }}>{meta.emoji}</span>
        <span style={{ ...infoLineStyle, flex: 1, fontWeight: 700, fontSize: '0.86rem', color: '#e2e8f0' }}>
          {name}
        </span>
        {enabled !== null && (
          <Pill color={enabled ? '#6ee7b7' : '#94a3b8'}>{enabled ? 'オン' : 'オフ'}</Pill>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.74rem', minWidth: 0 }}>
        <span style={{ ...infoLineStyle, color: headline.color, fontWeight: isActive ? 600 : 400 }}>{headline.text}</span>
        {!isActive && enabled !== null && (
          <span style={{ ...infoLineStyle, color: DIM_TEXT, flexShrink: 0 }}>
            {enabled
              ? `${cornerLabel(meta.after)}の後に${discussionFrequencyLabel(settings, cornerKey)}`
              : '流れません'}
          </span>
        )}
      </div>

      {plan.length > 0 && (
        <StepStrip plan={plan} step={step} state={state} agentNames={agentNames} />
      )}

      {isActive && <ResearchLine status={status!} />}
    </div>
  );
}

/**
 * 台本の列。1発言＝アバター1つ。進行中は今の発言を光らせ、済んだ発言を薄くする。
 * 終わった回・中断した回は、全体を薄くして「誰が出たか」だけ残す。
 */
function StepStrip({ plan, step, state, agentNames }: {
  plan: { agent: string; role: string }[];
  step: number | null;
  state: DiscussionStatus['state'] | undefined;
  agentNames?: Record<string, string>;
}) {
  const live = state === 'running' || state === 'preparing';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {plan.map((st, i) => {
        const isCurrent = state === 'running' && i === step;
        const isDone = state === 'running' && step !== null && i < step;
        const who = agentNames?.[st.agent] ? shortAgentName(agentNames[st.agent]) : st.agent;
        const role = DISCUSSION_ROLE_LABELS[st.role] ?? st.role;
        return (
          <div
            key={i}
            title={`${i + 1}. ${who}（${role}）`}
            style={{
              width: 42, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              opacity: !live ? 0.5 : isDone ? 0.45 : 1,
            }}
          >
            <AgentAvatar agentKey={st.agent} size={28} active={isCurrent} glowColor={LIVE_COLOR} />
            <span style={{
              fontSize: '0.6rem', whiteSpace: 'nowrap',
              color: isCurrent ? '#f1f5f9' : DIM_TEXT, fontWeight: isCurrent ? 700 : 400,
            }}>
              {role}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 取材（事実集め）の状態の1行。 */
function ResearchLine({ status }: { status: DiscussionStatus }) {
  const r = status.research;
  const view =
    r === 'done' ? { text: `🔎 取材メモ ${(status.researchChars ?? 0).toLocaleString()}字をそろえました`, color: '#6ee7b7' }
      : r === 'empty' ? { text: '⚠ 取材メモが空でした（数字なしで進行）', color: '#fca5a5' }
        : r === 'failed' ? { text: '⚠ 取材に失敗しました（数字なしで進行）', color: '#fca5a5' }
          : { text: '🔎 取材中…', color: 'var(--color-warning)' };
  return <div style={{ ...infoLineStyle, fontSize: '0.72rem', color: view.color }}>{view.text}</div>;
}
