/**
 * @file ダッシュボードの Live パネルの右半分に出す、ディレクターの編成（今日のコーナーの並び）
 *
 * 放送中・次・この後の予定・直近に放送したコーナーを並べる。Live に属する情報なので、Live パネルの中に置く。
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
import { EmptyNote, SectionLabel } from './PanelParts';
import {
  DIM_TEXT, DISCUSSION_CORNER_KEYS, DISCUSSION_CORNER_META, LIVE_COLOR, LIVE_TEXT_COLOR,
  cornerEmoji, cornerLabel, discussionEnabled, discussionFrequencyLabel, discussionName, infoLineStyle, isCornerKey,
} from '../constants';
import type { DiscussionSettings, DiscussionStatus, LiveQueueShape } from '../types';

interface Props {
  queue: LiveQueueShape | undefined;
  /** リスナーが繋いでいるか（「編成中」と「待機中」の言い分け） */
  isLive: boolean;
  /**
   * 管理画面で設定したディレクターの名前（ハードコードしない。CLAUDE.md を参照）
   */
  directorName: string;
  discussions: Record<string, DiscussionStatus> | undefined;
  settings: DiscussionSettings | null;
}

/**
 * ディレクターの編成。
 *
 * 討論コーナーは編成のキューに載らず、ニュースや金融が終わった後に続けて差し込まれる
 * （agent-discussion-corner.js の after）。そこで、オンになっているものをそのコーナーの直下に「↳」で添える。
 */
export default function DirectorSchedule({ queue: liveQueue, isLive, directorName, discussions, settings }: Props) {
  const queue = liveQueue?.queue ?? [];
  const recent = liveQueue?.recent ?? [];
  // current と next は「今マイクを持っている人」を指すので、コーナーの合間は待機中の値（director）になる。
  // これをコーナーとして扱わない（isCornerKey を参照）
  const next = isCornerKey(liveQueue?.next) ? liveQueue.next : undefined;
  const current = isCornerKey(liveQueue?.current) ? liveQueue.current : undefined;
  const nextIsSeparate = !!next && next !== current;

  const statuses = DISCUSSION_CORNER_KEYS.map((k) => discussions?.[k]);
  const running = statuses.find((d) => d?.state === 'running');
  const preparing = statuses.find((d) => d?.state === 'preparing');

  // そのコーナーの後に続く討論コーナー（オンのものだけ）。設定が読めていないときは出さない
  // （オフなのに「続く」と出すより、出さないほうが誤解が少ない）
  const followUps = (key: string) => (settings
    ? DISCUSSION_CORNER_KEYS.filter((k) => DISCUSSION_CORNER_META[k].after === key && discussionEnabled(settings, k))
    : []);

  // 残りの数。recent はサイクルをまたいで直近4件を持つ別のものなので数えない
  const totalInCycle = queue.length + (nextIsSeparate ? 1 : 0) + (current ? 1 : 0);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0,
      paddingLeft: 16, borderLeft: '1px solid rgba(255,255,255,0.07)',
    }}>
      {/* ── 見出し: ディレクタのアバターと状態 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <AgentAvatar agentKey="director" size={36} glowColor={LIVE_COLOR} active={isLive} />
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <div style={{ ...infoLineStyle, fontSize: '0.86rem', fontWeight: 700, color: '#e2e8f0' }}>
            {directorName}
          </div>
          <div style={{ ...infoLineStyle, fontSize: '0.68rem', color: LIVE_TEXT_COLOR }}>
            {isLive ? '🎬 本日の番組を編成中' : '🎬 本日の編成（放送は待機中）'}
          </div>
        </div>
        {totalInCycle > 0 && (
          <div style={{
            flexShrink: 0, fontSize: '0.66rem', color: '#94a3b8',
            border: '1px solid rgba(255,255,255,0.10)', borderRadius: 999,
            padding: '2px 8px', fontVariantNumeric: 'tabular-nums',
          }}>
            残り {totalInCycle}
          </div>
        )}
      </div>

      {!liveQueue ? (
        <EmptyNote>まだ編成情報がありません</EmptyNote>
      ) : (
        <>
          {/* ── オンエア中 / 次 ── */}
          {(running || current || nextIsSeparate) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
              {running ? (
                <CornerRow
                  cornerKey={running.key}
                  label={discussionName(settings, running.key, running.name)}
                  tone="onair"
                  badge={`${(running.stepIndex ?? 0) + 1}/${running.plan?.length ?? '?'}`}
                />
              ) : current && (
                <>
                  <CornerRow cornerKey={current} tone="onair" />
                  {preparing && DISCUSSION_CORNER_META[preparing.key]?.after === current && (
                    <FollowRow label={discussionName(settings, preparing.key, preparing.name)} cornerKey={preparing.key} note="準備中" highlight />
                  )}
                </>
              )}
              {nextIsSeparate && (
                <>
                  <CornerRow cornerKey={next!} tone="next" />
                  {followUps(next!).map((k) => (
                    <FollowRow key={k} cornerKey={k} label={discussionName(settings, k)} note={discussionFrequencyLabel(settings, k)} />
                  ))}
                </>
              )}
            </div>
          )}

          {/* ── この後の予定（余った高さはここがスクロールで引き受ける）── */}
          {queue.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 }}>
              <SectionLabel>この後の予定</SectionLabel>
              <div className="dash-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, paddingRight: 2 }}>
                {queue.map((key, i) => (
                  <div key={`${key}-${i}`} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <CornerRow cornerKey={key} tone="queued" index={i + 1} />
                    {followUps(key).map((k) => (
                      <FollowRow key={k} cornerKey={k} label={discussionName(settings, k)} note={discussionFrequencyLabel(settings, k)} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── 直近に放送 ── */}
          {recent.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0, marginTop: 'auto' }}>
              <SectionLabel>直近に放送</SectionLabel>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {recent.map((key, i) => (
                  <span
                    key={`${key}-${i}`}
                    style={{
                      fontSize: '0.68rem', color: DIM_TEXT,
                      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                      borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap',
                    }}
                  >
                    {cornerEmoji(key)} {DISCUSSION_CORNER_META[key] ? discussionName(settings, key) : cornerLabel(key)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * コーナー1件の行。tone で見え方を変える:
 *   onair  … 今放送中（Live の色で塗り、最も目立たせる）
 *   next   … 次に流れる（Live の色の枠線）
 *   queued … 待ちの列（控えめ。左に順番の番号）
 */
function CornerRow({ cornerKey, label, tone, index, badge }: {
  cornerKey: string;
  label?: string;
  tone: 'onair' | 'next' | 'queued';
  index?: number;
  badge?: string;
}) {
  const isOnair = tone === 'onair';
  const isNext = tone === 'next';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: isOnair || isNext ? '6px 9px' : '4px 8px',
      borderRadius: 9,
      background: isOnair ? `${LIVE_COLOR}26` : isNext ? `${LIVE_COLOR}14` : 'rgba(255,255,255,0.025)',
      border: `1px solid ${isOnair ? `${LIVE_COLOR}88` : isNext ? `${LIVE_COLOR}44` : 'rgba(255,255,255,0.06)'}`,
    }}>
      {index !== undefined && (
        <span style={{
          flexShrink: 0, width: 14, textAlign: 'right',
          fontSize: '0.62rem', color: '#64748b', fontVariantNumeric: 'tabular-nums',
        }}>
          {index}
        </span>
      )}
      <span style={{ flexShrink: 0, fontSize: isOnair || isNext ? '0.9rem' : '0.8rem' }}>
        {cornerEmoji(cornerKey)}
      </span>
      <span style={{
        ...infoLineStyle, flex: 1,
        fontSize: isOnair || isNext ? '0.82rem' : '0.76rem',
        fontWeight: isOnair ? 700 : isNext ? 600 : 400,
        color: isOnair ? '#f1f5f9' : isNext ? '#e2e8f0' : '#94a3b8',
      }}>
        {label ?? cornerLabel(cornerKey)}
      </span>
      {badge && (
        <span style={{ flexShrink: 0, fontSize: '0.64rem', color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
          {badge}
        </span>
      )}
      {(isOnair || isNext) && (
        <span style={{
          flexShrink: 0, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.06em',
          color: isOnair ? '#f1f5f9' : LIVE_TEXT_COLOR,
          background: isOnair ? `${LIVE_COLOR}cc` : 'transparent',
          border: isOnair ? 'none' : `1px solid ${LIVE_COLOR}66`,
          borderRadius: 999, padding: '2px 6px',
        }}>
          {isOnair ? 'ON AIR' : 'NEXT'}
        </span>
      )}
    </div>
  );
}

/**
 * 直前のコーナーに続けて流れる討論コーナー（編成のキューには載らないので、行の下に添える）。
 */
function FollowRow({ cornerKey, label, note, highlight = false }: {
  cornerKey: string;
  label: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, marginLeft: 20,
      padding: '3px 8px', borderRadius: 8, fontSize: '0.72rem',
      color: highlight ? '#e2e8f0' : DIM_TEXT,
      background: highlight ? `${LIVE_COLOR}14` : 'transparent',
      border: `1px dashed ${highlight ? `${LIVE_COLOR}77` : 'rgba(255,255,255,0.12)'}`,
    }}>
      <span style={{ flexShrink: 0 }}>↳</span>
      <span style={{ flexShrink: 0 }}>{cornerEmoji(cornerKey)}</span>
      <span style={{ ...infoLineStyle, flex: 1 }}>{label}</span>
      {note && (
        <span style={{ flexShrink: 0, fontSize: '0.62rem', color: highlight ? 'var(--color-warning)' : DIM_TEXT }}>
          {note}
        </span>
      )}
    </div>
  );
}
