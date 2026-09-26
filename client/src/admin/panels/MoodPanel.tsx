/**
 * @file 管理画面の Mood（トワイライト・ラウンジ）の設定パネル（番組・エージェント・BGM・日記の各タブ）
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
import type { BgmFile, ChannelAgentShape, MoodConfig } from '../types';
import { ChannelShowSettingsTab } from '../components/ChannelShowSettingsTab';
import { ChannelAgentsTab } from '../components/ChannelAgentsTab';
import { ChannelBgmTab } from '../components/ChannelBgmTab';
import { AgentDiaryTab } from '../components/AgentDiaryTab';

/**
 * 選んでいるタブ（adminSubTab）に応じて、番組設定・エージェント設定・BGM 管理・日記を表示する。
 * 各タブの中身はチャンネル共通の部品（ChannelShowSettingsTab など）を使う。
 * @param props.config Mood の設定。読み込めていなければ null（そのときは読み直しのボタンを出す）
 * @param props.onRefreshSettings 設定を読み直す
 */
export function MoodPanel({
  adminSubTab, config, setConfig, bgmAll,
  ttsTestText, setTtsTestText, onSave, onTest, onRefreshBgm, onRefreshSettings,
  avatarErrors, onAvatarError, getAgentEmoji, openAgents, setOpenAgents,
  testingAgent, creds, localPlayingUrl, playLocal, formatFileSize, serverUrl,
}: {
  adminSubTab: string;
  config: MoodConfig | null;
  setConfig: (v: MoodConfig) => void;
  bgmAll: { opening: BgmFile[]; main: BgmFile[] } | null;
  ttsTestText: string;
  setTtsTestText: (v: string) => void;
  onSave: (e: FormEvent) => void;
  onTest: (role: 'mood_director' | 'mood_personality', agent: ChannelAgentShape) => void;
  onRefreshBgm: () => void;
  onRefreshSettings: () => void;
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
      {/* 設定を読み込めなかったとき ─────────────────────────────────── */}
      {(['mood_show_settings','mood_agents','mood_bgm'] as string[]).includes(adminSubTab) && !config && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
          <span className="text-3xl">🌙</span>
          <p className="text-sm">Mood設定を読み込めませんでした。</p>
          <p className="text-xs text-gray-600">サーバーが起動しているか確認してから
            <button onClick={onRefreshSettings} className="ml-1 underline hover:text-gray-400">↻ 更新</button>
            してください。
          </p>
        </div>
      )}
      {(['mood_show_settings','mood_agents','mood_bgm'] as string[]).includes(adminSubTab) && config && (
        <div className="flex flex-col gap-6">

          {/* 番組設定（Mood） */}
          {adminSubTab === 'mood_show_settings' && (
            <ChannelShowSettingsTab
              icon="🌙"
              title="番組設定（トワイライト・ラウンジ）"
              program={config.program}
              setProgram={patch => setConfig({ ...config, program: { ...config.program, ...patch } })}
              onSubmit={onSave}
            />
          )}

          {/* エージェント設定（Mood） */}
          {adminSubTab === 'mood_agents' && (
            <ChannelAgentsTab
              channelLabel="Mood"
              accent="blue"
              agentRoles={['mood_director', 'mood_personality'] as const}
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

          {/* BGM管理（Mood） */}
          {adminSubTab === 'mood_bgm' && (
            <ChannelBgmTab
              channelLabel="Mood"
              accent="blue"
              channelSlug="mood"
              bgmAll={bgmAll}
              onRefresh={onRefreshBgm}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={serverUrl}
            />
          )}

        </div>
      )}

      {adminSubTab === 'mood_diary' && (
        <AgentDiaryTab
          serverUrl={serverUrl}
          channel="mood"
          emptyMessage="日記がまだありません。Mood は24時間ノンストップ放送のため「番組終了」がありません。全リスナーが退出したタイミングで、それまでの楽曲紹介・曲後コメントをまとめてパーソナリティが1回だけ振り返ります。"
        />
      )}
    </>
  );
}
