/**
 * @file ダッシュボードの下端の「できごとの記録」
 *
 * ふだんは1行に畳み、注意が要るもの（エラー・地震・依頼の失敗）だけを直近3件まで出す。
 * 調べ物のときは「すべて表示」で全件を開ける。開いたかどうかは、このブラウザに覚えておく。
 * 中身の多くは上のパネルと重なるので、画面の情報を優先して小さくしている。
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

import { useMemo, useState } from 'react';
import { CHANNELS } from '../../player/constants';
import { DIM_TEXT, readableOnFeed } from '../constants';
import { describeEvent, FEED_KIND_META, type FeedLine } from '../eventDescriptions';
import type { AgentNameMap } from '../hooks/useAgentNames';
import type { DashboardEvent } from '../types';

interface Props {
  feed: DashboardEvent[];
  agentNames: AgentNameMap;
}

/** 開いているかを覚えておく localStorage のキー。 */
const STORAGE_KEY = 'aiRadio.dashboard.eventLogExpanded';
const FEED_TIME_COLOR = '#6c7b91';
/** 畳んでいるときに出す、注意が要るできごとの件数。 */
const ALERTS_WHEN_COLLAPSED = 3;

/** 前回開いていたか。読めなければ畳む。 */
function loadExpanded(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

/**
 * できごとの記録。
 * @param props.feed 届いたイベント
 * @param props.agentNames エージェントの表示名（イベントを文にするのに使う）
 */
export default function EventLogStrip({ feed, agentNames }: Props) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const toggle = () => setExpanded((prev) => {
    const next = !prev;
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* 保存できなくても表示は切り替える */ }
    return next;
  });

  const lines = useMemo(
    () => feed.map((evt) => ({ evt, line: describeEvent(evt, agentNames) })),
    [feed, agentNames],
  );
  const alerts = lines.filter(({ line }) => line.kind === 'alert');
  const shown = expanded ? lines : alerts.slice(0, ALERTS_WHEN_COLLAPSED);

  return (
    <div className="glass-panel" style={{ padding: '10px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#cbd5e1', flexShrink: 0 }}>できごとの記録</span>
        {alerts.length > 0 ? (
          <span style={{
            flexShrink: 0, fontSize: '0.7rem', fontWeight: 700, color: '#fca5a5',
            border: '1px solid #fca5a566', borderRadius: 999, padding: '1px 9px',
          }}>
            ⚠ 注意 {alerts.length}件
          </span>
        ) : (
          <span style={{ fontSize: '0.74rem', color: DIM_TEXT }}>注意が必要な出来事はありません</span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          style={{
            marginLeft: 'auto', flexShrink: 0, cursor: 'pointer',
            fontSize: '0.72rem', color: '#cbd5e1', background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 999, padding: '3px 12px',
          }}
        >
          {expanded ? '閉じる ▴' : `すべて表示（${feed.length}件）▾`}
        </button>
      </div>

      {shown.length > 0 && (
        <div className="log-terminal" style={{ maxHeight: expanded ? 320 : undefined, padding: '8px 12px' }}>
          {shown.map(({ evt, line }, i) => <FeedRow key={i} evt={evt} line={line} />)}
        </div>
      )}
      {expanded && shown.length === 0 && (
        <div style={{ fontSize: '0.76rem', color: DIM_TEXT }}>
          まだ何も起きていません（放送や秘書が動き出すとここに表示されます）
        </div>
      )}
    </div>
  );
}

/** できごと1件の行（時刻・種類・チャンネル・内容）。 */
function FeedRow({ evt, line }: { evt: DashboardEvent; line: FeedLine }) {
  const meta = CHANNELS.find((c) => c.id === evt.channel);
  const time = new Date(evt.ts ?? Date.now()).toLocaleTimeString('ja-JP', { hour12: false });
  const kindMeta = FEED_KIND_META[line.kind];
  const isAlert = line.kind === 'alert';
  return (
    <div
      className={`log-entry ${isAlert ? 'err' : 'info'}`}
      style={{ borderColor: isAlert ? undefined : (meta?.color ?? undefined), display: 'flex', alignItems: 'baseline', gap: 8 }}
    >
      <span style={{ color: FEED_TIME_COLOR, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{time}</span>
      <span style={{
        flexShrink: 0, width: '4.6em', textAlign: 'center',
        fontSize: '0.7rem', color: kindMeta.color,
        border: `1px solid ${kindMeta.color}55`, borderRadius: 999, padding: '1px 0',
      }}>
        {kindMeta.label}
      </span>
      <span
        style={{
          color: readableOnFeed(meta?.color), flexShrink: 0,
          width: '8.5em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={meta?.name ?? evt.channel}
      >
        {meta?.emoji ?? '📡'} {meta?.name ?? evt.channel}
      </span>
      <span style={{ minWidth: 0 }}>{line.text}</span>
    </div>
  );
}
