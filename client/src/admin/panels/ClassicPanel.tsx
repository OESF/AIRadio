/**
 * @file 管理画面の Classic（静寂のスコア）の設定パネル（番組・エージェント・BGM・日記の各タブ）
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

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { BgmFile, ChannelAgentShape, ClassicConfig } from '../types';
import { ChannelShowSettingsTab } from '../components/ChannelShowSettingsTab';
import { ChannelAgentsTab } from '../components/ChannelAgentsTab';
import { ChannelBgmTab } from '../components/ChannelBgmTab';
import { AgentDiaryTab } from '../components/AgentDiaryTab';

/**
 * 選んでいるタブ（adminSubTab）に応じて、番組設定・エージェント設定・BGM 管理・日記を表示する。
 * 各タブの中身はチャンネル共通の部品（ChannelShowSettingsTab など）を使う。
 * @param props.config Classic の設定。読み込めていなければ null（そのときは何も出さない）
 */
export function ClassicPanel({
  adminSubTab, config, setConfig, bgmAll,
  ttsTestText, setTtsTestText, onSave, onTest, onRefreshBgm,
  avatarErrors, onAvatarError, getAgentEmoji, openAgents, setOpenAgents,
  testingAgent, creds, localPlayingUrl, playLocal, formatFileSize, serverUrl,
}: {
  adminSubTab: string;
  config: ClassicConfig | null;
  setConfig: (v: ClassicConfig) => void;
  bgmAll: { opening: BgmFile[]; main: BgmFile[] } | null;
  ttsTestText: string;
  setTtsTestText: (v: string) => void;
  onSave: (e: FormEvent) => void;
  onTest: (role: 'classic_director' | 'classic_personality', agent: ChannelAgentShape) => void;
  onRefreshBgm: () => void;
  avatarErrors: Set<string>;
  onAvatarError: (role: string) => void;
  getAgentEmoji: (role: string) => string;
  openAgents: Set<string>;
  setOpenAgents: Dispatch<SetStateAction<Set<string>>>;
  testingAgent: string | null;
  creds: { gemini?: { model?: string } } | null;
  localPlayingUrl: string | null;
  playLocal: (url: string) => void;
  formatFileSize: (bytes: number) => string;
  serverUrl: string;
}) {
  return (
    <>
      {(['classic_show_settings','classic_agents','classic_bgm'] as string[]).includes(adminSubTab) && config && (
        <div className="flex flex-col gap-6">

          {/* 番組設定（Classic） */}
          {adminSubTab === 'classic_show_settings' && (
            <ChannelShowSettingsTab
              icon="🎼"
              title="番組設定（静寂のスコア）"
              program={config.program}
              setProgram={patch => setConfig({ ...config, program: { ...config.program, ...patch } })}
              onSubmit={onSave}
            />
          )}

          {/* エージェント設定（Classic） */}
          {adminSubTab === 'classic_agents' && (
            <ChannelAgentsTab
              channelLabel="Classic"
              accent="amber"
              agentRoles={['classic_director', 'classic_personality'] as const}
              agents={config.agents}
              setAgent={(role, patch) => setConfig({ ...config, agents: { ...config.agents, [role]: { ...config.agents[role], ...patch } } })}
              ttsTestText={ttsTestText}
              setTtsTestText={v => { setTtsTestText(v); setConfig({ ...config, program: { ...config.program, tts_test_text: v } }); }}
              onTest={(role, agent) => onTest(role, agent)}
              onSubmit={onSave}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              testingAgent={testingAgent}
              creds={creds}
            />
          )}


          {/* BGM管理（Classic） */}
          {adminSubTab === 'classic_bgm' && (
            <ChannelBgmTab
              channelLabel="Classic"
              accent="amber"
              channelSlug="classic"
              bgmAll={bgmAll}
              onRefresh={onRefreshBgm}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={serverUrl}
              extraMainNote="パーソナリティ発話中の背景音楽（省略可）"
            />
          )}

        </div>
      )}

      {adminSubTab === 'classic_diary' && (
        <AgentDiaryTab
          serverUrl={serverUrl}
          channel="classic"
          emptyMessage="日記がまだありません。Classic は24時間ノンストップ放送のため「番組終了」がありません。全リスナーが退出したタイミングで、それまでの楽曲紹介・曲後コメントをまとめてパーソナリティが1回だけ振り返ります。"
        />
      )}
    </>
  );
}
