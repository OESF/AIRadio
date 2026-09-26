/**
 * @file 管理画面の Live の設定パネル（プロフィール・エージェント・金融・ウォッチリスト・BGM などのタブをまとめる）
 *
 * 選んでいるタブ（adminSubTab）に応じて、Live の各タブ（components/live/ 以下）を表示する。
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
import type {
  FullConfig, AgentConfig, TempStay, SpecialDate, DiaryEntry,
  FinanceWatchlist, JournalistWatchlist, BgmAll,
} from '../types';
import { ListenerInfoTab } from '../components/live/ListenerInfoTab';
import { MusicProfileTab } from '../components/live/MusicProfileTab';
import { TrafficAreaTab } from '../components/live/TrafficAreaTab';
import { TempStayTab } from '../components/live/TempStayTab';
import { SpecialDatesTab } from '../components/live/SpecialDatesTab';
import { ShowSettingsTab } from '../components/live/ShowSettingsTab';
import { TalkSettingsTab } from '../components/live/TalkSettingsTab';
import { InfoDisplayTab } from '../components/live/InfoDisplayTab';
import { AgentsTab } from '../components/live/AgentsTab';
import { FinanceTab } from '../components/live/FinanceTab';
import { JournalistWatchlistTab } from '../components/live/JournalistWatchlistTab';
import { BgmTab } from '../components/live/BgmTab';
import { LiveDiaryTab } from '../components/live/LiveDiaryTab';

/**
 * Live の設定のタブを切り替えて表示する。各タブの状態と操作は親（App.tsx）が持ち、ここは受け渡すだけ。
 * @param props.adminSubTab 選んでいるタブ
 */
export function LivePanel({
  adminSubTab, config, setConfig, saveConfig,
  musicGenresText, setMusicGenresText, newArtistInput, setNewArtistInput,
  trafficAreaInput, setTrafficAreaInput, suggestTrafficAreas, isSuggestingTraffic,
  newTempStay, setNewTempStay, editingTempStay, setEditingTempStay,
  newSpecialDate, setNewSpecialDate, editingSpecialIdx, setEditingSpecialIdx,
  openAgents, setOpenAgents, avatarErrors, onAvatarError, getAgentEmoji,
  liveTtsTestText, setLiveTtsTestText, playLiveTtsTest, testingAgent, creds,
  financeWL, toggleWLItem, removeStock, newStock, setNewStock, addStock, togglePersonalHolding,
  journalistWL, getJournalistDraft, setJournalistDraft, addJournalistItem, removeJournalistItem,
  openJournalistSections, toggleJournalistSection,
  fetchSettings, localPlayingUrl, currentBgmFile, bgmAll, bgmFiles, playLocal, formatFileSize, serverUrl,
  diaryEntries, diaryAgentFilter, setDiaryAgentFilter, diaryAutoRefresh, setDiaryAutoRefresh, fetchAgentDiary,
}: {
  adminSubTab: string;
  config: FullConfig | null;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
  musicGenresText: string;
  setMusicGenresText: (v: string) => void;
  newArtistInput: string;
  setNewArtistInput: (v: string) => void;
  trafficAreaInput: string;
  setTrafficAreaInput: (v: string) => void;
  suggestTrafficAreas: () => void;
  isSuggestingTraffic: boolean;
  newTempStay: TempStay;
  setNewTempStay: Dispatch<SetStateAction<TempStay>>;
  editingTempStay: boolean;
  setEditingTempStay: (v: boolean) => void;
  newSpecialDate: SpecialDate;
  setNewSpecialDate: Dispatch<SetStateAction<SpecialDate>>;
  editingSpecialIdx: number | null;
  setEditingSpecialIdx: (v: number | null) => void;
  openAgents: Set<string>;
  setOpenAgents: Dispatch<SetStateAction<Set<string>>>;
  avatarErrors: Set<string>;
  onAvatarError: (role: string) => void;
  getAgentEmoji: (role: string) => string;
  liveTtsTestText: string;
  setLiveTtsTestText: (v: string) => void;
  playLiveTtsTest: (agentKey: string, agent: AgentConfig) => void;
  testingAgent: string | null;
  creds: { gemini?: { model?: string } } | null;
  financeWL: FinanceWatchlist;
  toggleWLItem: (section: keyof FinanceWatchlist, symbol: string) => void;
  removeStock: (symbol: string) => void;
  newStock: { symbol: string; name: string; unit: string; dec: number };
  setNewStock: Dispatch<SetStateAction<{ symbol: string; name: string; unit: string; dec: number }>>;
  addStock: () => void;
  togglePersonalHolding: (name: string) => void;
  journalistWL: JournalistWatchlist;
  getJournalistDraft: (section: string) => { name: string; x_handle: string };
  setJournalistDraft: (section: string, patch: Partial<{ name: string; x_handle: string }>) => void;
  addJournalistItem: (section: keyof JournalistWatchlist) => void;
  removeJournalistItem: (section: keyof JournalistWatchlist, name: string) => void;
  openJournalistSections: Set<string>;
  toggleJournalistSection: (id: string) => void;
  fetchSettings: () => void;
  localPlayingUrl: string | null;
  currentBgmFile: string | null;
  bgmAll: BgmAll;
  bgmFiles: { filename: string; size: number }[];
  playLocal: (url: string) => void;
  formatFileSize: (bytes: number) => string;
  serverUrl: string;
  diaryEntries: DiaryEntry[];
  diaryAgentFilter: string;
  setDiaryAgentFilter: (v: string) => void;
  diaryAutoRefresh: boolean;
  setDiaryAutoRefresh: (v: boolean) => void;
  fetchAgentDiary: (agent: string) => void;
}) {
  return (
    <>
      {/* ── プロフィール系コンテンツ ─────────────────────────────── */}
      {(['listener_info','music_profile','traffic_area','temp_stay','special_dates',
         'show_settings'] as string[]).includes(adminSubTab) && config && (
        <div className="flex flex-col gap-6">
          <form onSubmit={saveConfig} className="flex flex-col gap-6">

            {adminSubTab === 'listener_info' && (
              <ListenerInfoTab config={config} setConfig={setConfig} />
            )}

            {adminSubTab === 'music_profile' && (
              <MusicProfileTab
                config={config} setConfig={setConfig}
                musicGenresText={musicGenresText} setMusicGenresText={setMusicGenresText}
                newArtistInput={newArtistInput} setNewArtistInput={setNewArtistInput}
              />
            )}

            {adminSubTab === 'traffic_area' && (
              <TrafficAreaTab
                config={config} setConfig={setConfig}
                trafficAreaInput={trafficAreaInput} setTrafficAreaInput={setTrafficAreaInput}
                suggestTrafficAreas={suggestTrafficAreas} isSuggestingTraffic={isSuggestingTraffic}
              />
            )}

            {adminSubTab === 'temp_stay' && (
              <TempStayTab
                config={config} setConfig={setConfig}
                newTempStay={newTempStay} setNewTempStay={setNewTempStay}
                editingTempStay={editingTempStay} setEditingTempStay={setEditingTempStay}
              />
            )}

            {adminSubTab === 'special_dates' && (
              <SpecialDatesTab
                config={config} setConfig={setConfig}
                newSpecialDate={newSpecialDate} setNewSpecialDate={setNewSpecialDate}
                editingSpecialIdx={editingSpecialIdx} setEditingSpecialIdx={setEditingSpecialIdx}
              />
            )}

            {adminSubTab === 'show_settings' && (
              <>
                <ShowSettingsTab config={config} setConfig={setConfig} />
                <TalkSettingsTab config={config} setConfig={setConfig} />
                <InfoDisplayTab config={config} setConfig={setConfig} />
              </>
            )}

            <button type="submit" className="btn btn-primary py-3">設定を保存</button>
          </form>
        </div>
      )}

      {/* ── エージェント設定 ──────────────────────────────── */}
      {adminSubTab === 'agents' && config && (
        <AgentsTab
          config={config} setConfig={setConfig} saveConfig={saveConfig}
          openAgents={openAgents} setOpenAgents={setOpenAgents}
          avatarErrors={avatarErrors} onAvatarError={onAvatarError} getAgentEmoji={getAgentEmoji}
          liveTtsTestText={liveTtsTestText} setLiveTtsTestText={setLiveTtsTestText}
          playLiveTtsTest={playLiveTtsTest} testingAgent={testingAgent} creds={creds}
        />
      )}

      {/* ── 金融設定 ──────────────────────────────────────── */}
      {adminSubTab === 'finance' && (
        <FinanceTab
          financeWL={financeWL} toggleWLItem={toggleWLItem} removeStock={removeStock}
          newStock={newStock} setNewStock={setNewStock} addStock={addStock}
          togglePersonalHolding={togglePersonalHolding}
        />
      )}

      {/* ── ジャーナリストウォッチリスト ──────────────────────── */}
      {adminSubTab === 'journalist_watchlist' && (
        <JournalistWatchlistTab
          config={config}
          journalistWL={journalistWL} getJournalistDraft={getJournalistDraft} setJournalistDraft={setJournalistDraft}
          addJournalistItem={addJournalistItem} removeJournalistItem={removeJournalistItem}
          openJournalistSections={openJournalistSections} toggleJournalistSection={toggleJournalistSection}
        />
      )}

      {/* ── BGM管理 ──────────────────────────────────────── */}
      {adminSubTab === 'bgm' && (
        <BgmTab
          fetchSettings={fetchSettings} localPlayingUrl={localPlayingUrl} currentBgmFile={currentBgmFile}
          bgmAll={bgmAll} bgmFiles={bgmFiles} playLocal={playLocal} formatFileSize={formatFileSize} serverUrl={serverUrl}
        />
      )}

      {adminSubTab === 'live_diary' && (
        <LiveDiaryTab
          diaryEntries={diaryEntries} diaryAgentFilter={diaryAgentFilter} setDiaryAgentFilter={setDiaryAgentFilter}
          diaryAutoRefresh={diaryAutoRefresh} setDiaryAutoRefresh={setDiaryAutoRefresh} fetchAgentDiary={fetchAgentDiary}
        />
      )}
    </>
  );
}
