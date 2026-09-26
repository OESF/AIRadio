/**
 * @file システム監視ダッシュボードの画面全体
 *
 * 画面は3段に分けている（段組みは dashboard.css）。
 *   - 上段: 情報の多い Live・My Secretary・The Answers を大きな固定パネルで
 *   - 中段: 残りのチャンネルを小さなタイルで
 *   - 下段: できごとの記録を畳んで（注意が要るものだけを目立たせる）
 * ディレクターの編成は Live に属する情報なので、Live のパネルの中に表示する。
 * このダッシュボードは「いま何が起きているか」に専念する。視聴の推移などの統計は、管理画面の
 * 稼働レポートの「視聴記録」タブ（admin/components/system/ListeningStatsPanel.tsx）にある。
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

import './dashboard.css';
import { useDashboardSocket } from './hooks/useDashboardSocket';
import { useAgentNames } from './hooks/useAgentNames';
import { useDiscussionSettings } from './hooks/useDiscussionSettings';
import LivePanel from './components/LivePanel';
import SecretaryStatusCard from './components/SecretaryStatusCard';
import TheAnswersStatusCard from './components/TheAnswersStatusCard';
import CompactChannelTile from './components/CompactChannelTile';
import EventLogStrip from './components/EventLogStrip';
import SystemErrorBanner from './components/SystemErrorBanner';
import { DASHBOARD_SUB_CHANNEL_IDS } from './constants';

/** 開発時（localhost）は API サーバーのポートへ、それ以外は同じオリジンへつなぐ。 */
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : window.location.origin;

/** ダッシュボードの画面。 */
export default function Dashboard() {
  const { connected, channels, feed } = useDashboardSocket();
  const agentNames = useAgentNames(SERVER_URL);
  const discussionSettings = useDiscussionSettings(SERVER_URL, connected, channels.live?.discussionSettings);

  return (
    <div style={{ minHeight: '100vh', padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="brand" style={{ fontSize: '1.3rem', color: '#e2e8f0' }}>
          AI Radio <span className="text-neon-purple">システム監視ダッシュボード</span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: '#94a3b8' }}>
          <span className={`indicator ${connected ? 'active' : 'inactive'}`} />
          {connected ? '接続中' : '再接続中…'}
        </div>
      </header>

      <SystemErrorBanner channels={channels} />

      <div className="dash-main-grid">
        <LivePanel snapshot={channels.live} agentNames={agentNames.live} discussionSettings={discussionSettings} />
        <SecretaryStatusCard snapshot={channels.secretary} />
        <TheAnswersStatusCard snapshot={channels.the_answers} />
      </div>

      <div className="dash-sub-grid">
        {DASHBOARD_SUB_CHANNEL_IDS.map((id) => (
          <CompactChannelTile key={id} channelId={id} snapshot={channels[id]} agentNames={agentNames[id]} />
        ))}
      </div>

      <EventLogStrip feed={feed} agentNames={agentNames} />

      {/* 視聴の統計はここに置かない（管理画面の稼働レポート「視聴記録」タブにある） */}
    </div>
  );
}
