/**
 * @file ダッシュボードの My Secretary の固定パネル
 *
 * 秘書は接続ごとに専用の Gemini Live を張る1対1の中継なので、他のチャンネルの _broadcast には乗らない。
 * 代わりに secretary-live-routes.js の onActivity（ツールの呼び出し中・音声の受信・返事の終わり）から届く
 * secretaryState で、動いているかを表示する。
 *
 * 「裏で動いている作業」（ヘルパーエージェント）と「LINE からの依頼」を分けて出し、依頼の文は2行まで表示する。
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
import { DIM_TEXT, formatClock, infoLineStyle, readableOnPanel, shortAgentName } from '../constants';
import AgentAvatar from './AgentAvatar';
import { EmptyNote, LastSessionFooter, PanelHeader, Pill, SectionLabel } from './PanelParts';
import type { ChannelSnapshot, HelperJob } from '../types';

interface Props {
  snapshot: ChannelSnapshot | undefined;
}

const STATE_LABEL: Record<string, string> = {
  idle: '待機中',
  searching: '🔍 調べ物・作業中…',
  speaking: '🗣️ 発話中',
};

/**
 * 秘書のパネル。
 * @param props.snapshot 秘書の今の状態
 */
export default function SecretaryStatusCard({ snapshot }: Props) {
  const meta = CHANNELS.find((c) => c.id === 'secretary');
  const color = meta?.color ?? '#9d4edd';
  const state = snapshot?.secretaryState ?? 'idle';
  const isChecking = snapshot?.loopStatus === 'checking';
  const isConnected = !!snapshot?.connected;
  // BUGFIX: 専門家に相談してその本人の声を流している間は、アバターと状態をその専門家に切り替える
  //         （プレーヤー画面と同じ。以前は専門家が話していても秘書のままだった）
  const consulting = snapshot?.consultingAgent ?? null;
  // LINE からの依頼。会話とは別の経路なので、会話が待機中でも LINE の側だけが動いていることがある
  const lineReq = snapshot?.lineRequest ?? null;
  const isLineProcessing = !!lineReq?.processing;
  // ヘルパーエージェントの仕事。会話が待機中でも、裏で数分かかる作業が動いていることがある。
  // 動いているものは全部並べ、何も動いていなければ最後に終わった1件を出す
  const runningJobs = Object.values(snapshot?.helperJobs ?? {}).filter((j) => j.running);
  const lastJob = snapshot?.lastHelperJob
    ?? (snapshot?.helperJob && !snapshot.helperJob.running ? snapshot.helperJob : null);
  const isHelperRunning = runningJobs.length > 0;
  const isActive = state !== 'idle' || isChecking || !!consulting || isLineProcessing || isHelperRunning;

  const headline = consulting ? `🗣️ ${shortAgentName(consulting.name)}が回答中`
    : state !== 'idle' ? STATE_LABEL[state]
      : isLineProcessing ? '💬 LINEの依頼に対応中…'
        : isHelperRunning
          ? (runningJobs.length > 1
            ? `🛠️ 裏で${runningJobs.length}件の作業中…`
            : (runningJobs[0].kind === 'presentation' ? '🖼️ スライドを作成中…' : '🛠️ ヘルパーが作業中…'))
          : STATE_LABEL.idle;

  return (
    <div
      className="glass-panel dash-main-panel"
      style={{
        padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14, overflow: 'hidden',
        borderColor: isActive ? color : undefined,
        boxShadow: isActive ? `0 0 18px ${color}33` : undefined,
      }}
    >
      <PanelHeader
        emoji={meta?.emoji ?? '👩‍💼'}
        name={meta?.name ?? 'My Secretary'}
        color={readableOnPanel(meta?.color)}
        dot={isActive ? 'active' : 'inactive'}
        dotTitle={headline}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
        <AgentAvatar agentKey={consulting?.key ?? 'secretary'} active={isActive} glowColor={color} size={64} />
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="dash-clamp-2" style={{ fontSize: '0.95rem', fontWeight: 600, color: isActive ? '#f1f5f9' : '#cbd5e1' }}>
            {headline}
          </div>
          {isChecking ? (
            <div style={{ ...infoLineStyle, fontSize: '0.74rem', color: 'var(--color-warning)' }}>🔎 自律監視チェック中…</div>
          ) : (
            <div style={{ ...infoLineStyle, fontSize: '0.74rem', color: DIM_TEXT }}>
              {isConnected ? '🎧 音声で接続中' : '音声は未接続'}
            </div>
          )}
        </div>
      </div>

      <div className="dash-scroll" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel right={isHelperRunning ? <Pill color="#67e8f9">{runningJobs.length}件 実行中</Pill> : null}>
            裏で動いている作業
          </SectionLabel>
          {isHelperRunning
            ? runningJobs.map((job, i) => <JobRow key={job.id ?? i} job={job} />)
            : lastJob ? <JobRow job={lastJob} /> : <EmptyNote>最近の作業はありません</EmptyNote>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionLabel right={isLineProcessing ? <Pill color="#c4b5fd">対応中</Pill> : null}>
            LINEからの依頼
          </SectionLabel>
          {lineReq?.requestText ? (
            <ItemBox highlight={isLineProcessing} icon="💬" title={lineReq.requestText}>
              <div className="dash-clamp-2" style={{ fontSize: '0.78rem', color: isLineProcessing ? '#e2e8f0' : '#cbd5e1' }}>
                {lineReq.requestText}
              </div>
              <div style={{ fontSize: '0.66rem', color: DIM_TEXT }}>{formatClock(lineReq.ts)}</div>
            </ItemBox>
          ) : (
            <EmptyNote>最近の依頼はありません</EmptyNote>
          )}
        </div>
      </div>

      <LastSessionFooter snapshot={snapshot} />
    </div>
  );
}

/** ヘルパーの仕事1件の行（依頼・進み具合）。 */
function JobRow({ job }: { job: HelperJob }) {
  const failed = job.status === 'failed' || job.status === 'error';
  const statusLabel = job.running ? (job.progress || '作業中') : failed ? '失敗' : '完了';
  const statusColor = job.running ? '#67e8f9' : failed ? '#fca5a5' : DIM_TEXT;
  return (
    <ItemBox highlight={job.running} icon={job.kind === 'presentation' ? '🖼️' : '🛠️'} title={job.request}>
      <div className="dash-clamp-2" style={{ fontSize: '0.78rem', color: job.running ? '#e2e8f0' : '#cbd5e1' }}>
        {job.request || '（依頼内容なし）'}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.66rem' }}>
        <span style={{ ...infoLineStyle, color: statusColor }}>{statusLabel}</span>
        <span style={{ flexShrink: 0, color: DIM_TEXT }}>{formatClock(job.ts)}</span>
      </div>
    </ItemBox>
  );
}

/**
 * パネルの中の小さな枠（アイコン・見出し・中身）。
 * @param props.highlight 動いている最中なら強調する
 */
function ItemBox({ highlight, icon, title, children }: {
  highlight: boolean;
  icon: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      title={title}
      style={{
        display: 'flex', gap: 8, padding: '7px 10px', borderRadius: 9,
        background: highlight ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.025)',
        border: `1px solid ${highlight ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)'}`,
      }}
    >
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>{children}</div>
    </div>
  );
}
