/**
 * @file 管理画面の Jazz（琥珀色のインプロヴィゼーション）の設定パネル（番組・エージェント・BGM・日記の各タブ）
 *
 * Jazz は英語の番組なので、番組設定に「翻訳テロップ」（パーソナリティの英語のセリフの日本語訳）の設定がある。
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
import type { BgmFile, ChannelAgentShape, JazzConfig } from '../types';
import { ChannelShowSettingsTab } from '../components/ChannelShowSettingsTab';
import { ChannelAgentsTab } from '../components/ChannelAgentsTab';
import { ChannelBgmTab } from '../components/ChannelBgmTab';
import { AgentDiaryTab } from '../components/AgentDiaryTab';

/**
 * 選んでいるタブ（adminSubTab）に応じて、番組設定・エージェント設定・BGM 管理・日記を表示する。
 * 各タブの中身はチャンネル共通の部品（ChannelShowSettingsTab など）を使う。
 * @param props.config Jazz の設定。読み込めていなければ null（そのときは読み直しのボタンを出す）
 * @param props.onRefreshSettings 設定を読み直す
 */
export function JazzPanel({
  adminSubTab, config, setConfig, bgmAll,
  ttsTestText, setTtsTestText, onSave, onTest, onRefreshBgm, onRefreshSettings,
  avatarErrors, onAvatarError, getAgentEmoji, openAgents, setOpenAgents,
  testingAgent, creds, localPlayingUrl, playLocal, formatFileSize, serverUrl,
}: {
  adminSubTab: string;
  config: JazzConfig | null;
  setConfig: (v: JazzConfig) => void;
  bgmAll: { opening: BgmFile[]; main: BgmFile[] } | null;
  ttsTestText: string;
  setTtsTestText: (v: string) => void;
  onSave: (e: FormEvent) => void;
  onTest: (role: 'jazz_director' | 'jazz_personality', agent: ChannelAgentShape) => void;
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
      {/* 設定を読み込めなかったとき */}
      {(['jazz_show_settings','jazz_agents','jazz_bgm'] as string[]).includes(adminSubTab) && !config && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
          <span className="text-3xl">🎷</span>
          <p className="text-sm">Jazz設定を読み込めませんでした。</p>
          <p className="text-xs text-gray-600">サーバーが起動しているか確認してから
            <button onClick={onRefreshSettings} className="ml-1 underline hover:text-gray-400">↻ 更新</button>
            してください。
          </p>
        </div>
      )}
      {(['jazz_show_settings','jazz_agents','jazz_bgm'] as string[]).includes(adminSubTab) && config && (
        <div className="flex flex-col gap-6">

          {/* 番組設定（Jazz） */}
          {adminSubTab === 'jazz_show_settings' && (
            <ChannelShowSettingsTab
              icon="🎷"
              title="番組設定（琥珀色のインプロヴィゼーション）"
              program={config.program}
              setProgram={patch => setConfig({ ...config, program: { ...config.program, ...patch } })}
              onSubmit={onSave}
              extra={
                <>
                  {/* 翻訳テロップ（パーソナリティの英語のセリフの日本語訳） */}
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">翻訳テロップ</h3>
                  <div className="bg-black/20 border border-glass rounded-xl flex flex-col gap-4" style={{ padding: '16px' }}>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" id="jazz_caption_enabled"
                        checked={config.program.caption_enabled !== false}
                        onChange={e => setConfig({ ...config, program: { ...config.program, caption_enabled: e.target.checked } })}
                      />
                      <label htmlFor="jazz_caption_enabled" className="mb-0 cursor-pointer">Louisの英語セリフを日本語訳テロップで表示する</label>
                    </div>
                    {config.program.caption_enabled !== false && (() => {
                      const sp = config.program.caption_speed ?? 170;
                      const desc = sp <= 100 ? 'ゆっくり' : sp <= 150 ? 'やや遅め' : sp <= 190 ? '標準' : sp <= 240 ? 'やや速め' : '速い';
                      return (
                        <div>
                          <label className="mb-1">スクロール速度</label>
                          <div className="flex items-center gap-2 flex-nowrap">
                            <span className="text-xs text-gray-500 flex-shrink-0">遅</span>
                            <input
                              type="range" min="60" max="300" step="10"
                              value={sp}
                              onChange={e => setConfig({ ...config, program: { ...config.program, caption_speed: Number(e.target.value) } })}
                              className="flex-1 min-w-0 accent-amber-500"
                            />
                            <span className="text-xs text-gray-500 flex-shrink-0">速</span>
                            <span className="text-sm font-bold font-mono text-amber-500 w-24 text-right flex-shrink-0">{sp} px/秒</span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">{desc}（デフォルト: 170）</p>
                        </div>
                      );
                    })()}
                  </div>
                </>
              }
            />
          )}

          {/* エージェント設定（Jazz） */}
          {adminSubTab === 'jazz_agents' && (
            <ChannelAgentsTab
              channelLabel="Jazz"
              accent="amber"
              agentRoles={['jazz_director', 'jazz_personality'] as const}
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

          {/* BGM管理（Jazz） */}
          {adminSubTab === 'jazz_bgm' && (
            <ChannelBgmTab
              channelLabel="Jazz"
              accent="amber"
              channelSlug="jazz"
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

      {adminSubTab === 'jazz_diary' && (
        <AgentDiaryTab
          serverUrl={serverUrl}
          channel="jazz"
          emptyMessage="日記がまだありません。Jazz は24時間ノンストップ放送のため「番組終了」がありません。全リスナーが退出したタイミングで、それまでの楽曲紹介・曲後コメントをまとめてパーソナリティが1回だけ振り返ります。"
        />
      )}
    </>
  );
}
