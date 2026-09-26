/**
 * @file 管理画面の「システム管理」グループ（辞書・管理人・秘書・接続情報・ログ・録音・稼働レポート・会話履歴など）
 *
 * 選ばれているサブタブ（adminSubTab）に応じて、各タブのコンポーネントを出し分けるだけの部品。状態と操作は
 * App.tsx が持ち、そのまま渡す。
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

import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';
import type {
  FullConfig, Credentials, AgentConfig,
  TtsDictEntry, ServerLogEntry, RecordableChannel, RecordingEntry, ConversationEntry,
  ReportSession, ReportDetail, ReportSummary, ReportCostBreakdown,
} from '../types';
import { AgentDiaryTab } from '../components/AgentDiaryTab';
import { DictTab } from '../components/system/DictTab';
import { AdministratorTab } from '../components/system/AdministratorTab';
import { SecretaryAgentTab } from '../components/system/SecretaryAgentTab';
import { SecretaryLearningTab } from '../components/system/SecretaryLearningTab';
import { SecretaryLoopTab } from '../components/system/SecretaryLoopTab';
import { SecretaryObsidianTab } from '../components/system/SecretaryObsidianTab';
import { SecretaryPresentationTab } from '../components/system/SecretaryPresentationTab';
import { SecretaryLineTab } from '../components/system/SecretaryLineTab';
import { ShortcutsTab } from '../components/system/ShortcutsTab';
import { CredentialsTab } from '../components/system/CredentialsTab';
import { LogsTab } from '../components/system/LogsTab';
import { ReleaseNotesTab } from '../components/system/ReleaseNotesTab';
import { RecordingTab } from '../components/system/RecordingTab';
import { ReportTab } from '../components/system/ReportTab';
import { HistoryTab } from '../components/system/HistoryTab';

/**
 * システム管理のタブの出し分け。
 * @param props.adminSubTab 選ばれているサブタブのキー
 * @param props.serverUrl API サーバーの URL
 * @param props.config 設定（読み込み前は null。設定を使うタブはそのあいだ出さない）
 * @param props.creds 接続情報（読み込み前は null）
 */
export function SystemPanel({
  adminSubTab, serverUrl,
  config, setConfig, saveConfig,
  creds, setCreds, saveCredentials, openCredsSections, toggleCredsSection,
  testingAgent, playLiveTtsTest,
  ttsDict, setTtsDict, dictEditing, setDictEditing, dictSaving,
  dictTestInput, setDictTestInput, dictPreviewOpen, setDictPreviewOpen,
  dictNewEntry, setDictNewEntry, applyDictPreview, addDictEntry, saveTtsDict,
  serverLogs, logMinLevel, setLogMinLevel, logAutoRefresh, setLogAutoRefresh, fetchServerLogs,
  releaseNotesContent, fetchReleaseNotes,
  recordingChannel, setRecordingChannel, recordingActive, startProgramRecording, stopProgramRecording,
  recordingElapsedSec, recordingCurrentTarget, recordingHistory, fetchRecordingHistory,
  formatRecordingDuration, playingRecordingId, setPlayingRecordingId, deleteRecording, formatFileSize,
  reportDetail, setReportDetail, reportEventFilter, setReportEventFilter, reportSummary,
  reportCostBreakdown,
  reportSessions, reportTotal, reportLoading, reportPage, setReportPage,
  reportChannel, setReportChannel, reportFrom, setReportFrom, reportTo, setReportTo,
  fetchReport, fetchReportDetail,
  convHistory, setConvHistory, historyAgentFilter, setHistoryAgentFilter,
  historyAutoRefresh, setHistoryAutoRefresh, fetchConversationHistory, convHistoryEndRef,
  avatarErrors, onAvatarError, getAgentEmoji,
}: {
  adminSubTab: string;
  serverUrl: string;
  config: FullConfig | null;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
  creds: Credentials | null;
  setCreds: (v: Credentials) => void;
  saveCredentials: (e: FormEvent) => void;
  openCredsSections: Set<string>;
  toggleCredsSection: (id: string) => void;
  testingAgent: string | null;
  playLiveTtsTest: (agentKey: string, agent: AgentConfig) => void;

  ttsDict: TtsDictEntry[];
  setTtsDict: Dispatch<SetStateAction<TtsDictEntry[]>>;
  dictEditing: number | null;
  setDictEditing: (v: number | null) => void;
  dictSaving: boolean;
  dictTestInput: string;
  setDictTestInput: (v: string) => void;
  dictPreviewOpen: boolean;
  setDictPreviewOpen: Dispatch<SetStateAction<boolean>>;
  dictNewEntry: { pattern: string; flags: string; replacement: string; note: string };
  setDictNewEntry: Dispatch<SetStateAction<{ pattern: string; flags: string; replacement: string; note: string }>>;
  applyDictPreview: (input: string) => string;
  addDictEntry: () => void;
  saveTtsDict: () => void;

  serverLogs: ServerLogEntry[];
  logMinLevel: 'debug' | 'info' | 'warn' | 'error';
  setLogMinLevel: (v: 'debug' | 'info' | 'warn' | 'error') => void;
  logAutoRefresh: boolean;
  setLogAutoRefresh: (v: boolean) => void;
  fetchServerLogs: (level?: 'debug' | 'info' | 'warn' | 'error') => void;

  releaseNotesContent: string;
  fetchReleaseNotes: () => void;

  recordingChannel: RecordableChannel;
  setRecordingChannel: (v: RecordableChannel) => void;
  recordingActive: boolean;
  startProgramRecording: () => void;
  stopProgramRecording: () => void;
  recordingElapsedSec: number;
  recordingCurrentTarget: string | null;
  recordingHistory: RecordingEntry[];
  fetchRecordingHistory: () => void;
  formatRecordingDuration: (sec: number) => string;
  playingRecordingId: string | null;
  setPlayingRecordingId: (v: string | null) => void;
  deleteRecording: (id: string) => void;
  formatFileSize: (bytes: number) => string;

  reportDetail: ReportDetail | null;
  setReportDetail: (v: ReportDetail | null) => void;
  reportEventFilter: string;
  setReportEventFilter: (v: string) => void;
  reportSummary: ReportSummary | null;
  reportCostBreakdown: ReportCostBreakdown | null;
  reportSessions: ReportSession[];
  reportTotal: number;
  reportLoading: boolean;
  reportPage: number;
  setReportPage: (v: number) => void;
  reportChannel: string;
  setReportChannel: (v: string) => void;
  reportFrom: string;
  setReportFrom: (v: string) => void;
  reportTo: string;
  setReportTo: (v: string) => void;
  fetchReport: (page?: number, channel?: string, from?: string, to?: string) => void;
  fetchReportDetail: (id: number) => void;

  convHistory: ConversationEntry[];
  setConvHistory: (v: ConversationEntry[]) => void;
  historyAgentFilter: string;
  setHistoryAgentFilter: (v: string) => void;
  historyAutoRefresh: boolean;
  setHistoryAutoRefresh: (v: boolean) => void;
  fetchConversationHistory: (agent?: string) => void;
  convHistoryEndRef: RefObject<HTMLDivElement | null>;
  avatarErrors: Set<string>;
  onAvatarError: (key: string) => void;
  getAgentEmoji: (role: string) => string;
}) {
  return (
    <>
      {adminSubTab === 'dict' && (
        <DictTab
          ttsDict={ttsDict} setTtsDict={setTtsDict} dictEditing={dictEditing} setDictEditing={setDictEditing}
          dictSaving={dictSaving} dictTestInput={dictTestInput} setDictTestInput={setDictTestInput}
          dictPreviewOpen={dictPreviewOpen} setDictPreviewOpen={setDictPreviewOpen}
          dictNewEntry={dictNewEntry} setDictNewEntry={setDictNewEntry}
          applyDictPreview={applyDictPreview} addDictEntry={addDictEntry} saveTtsDict={saveTtsDict}
        />
      )}

      {/* ── AI 管理人の設定（お問い合わせ・リクエストの窓口の応答者） ── */}
      {adminSubTab === 'administrator' && config && (
        <AdministratorTab
          config={config} setConfig={setConfig} saveConfig={saveConfig}
          testingAgent={testingAgent} playLiveTtsTest={playLiveTtsTest}
        />
      )}

      {/* ── 秘書の設定（Gemini Live で会話する AI 秘書） ── */}
      {adminSubTab === 'secretary' && config && (
        <SecretaryAgentTab
          config={config} setConfig={setConfig} saveConfig={saveConfig}
          testingAgent={testingAgent} playLiveTtsTest={playLiveTtsTest}
          avatarErrors={avatarErrors} onAvatarError={onAvatarError} getAgentEmoji={getAgentEmoji}
        />
      )}

      {/* ── 秘書の学習内容（明示的な記憶と、会話の終わりの自動の要約を1ページにまとめる。由来は行ごとのバッジで示し、件数が多いときは各行を1行に畳む） ── */}
      {adminSubTab === 'secretary_learning' && (
        <SecretaryLearningTab serverUrl={serverUrl} />
      )}

      {/* ── 秘書の日記（会話の終わりの一人称の振り返り） ── */}
      {adminSubTab === 'secretary_diary' && (
        <AgentDiaryTab
          serverUrl={serverUrl}
          channel="secretary"
          emptyMessage="日記がまだありません。My Secretaryとの会話セッションが終了すると、その回の会話全体を通しての振り返りを1回だけ書きます（発言のたびにではありません）。"
        />
      )}

      {/* ── 秘書の自律ループの設定 ── */}
      {adminSubTab === 'secretary_loop' && config && (
        <SecretaryLoopTab config={config} setConfig={setConfig} saveConfig={saveConfig} />
      )}

      {/* ── 秘書の Obsidian 連携の設定 ── */}
      {adminSubTab === 'secretary_obsidian' && config && (
        <SecretaryObsidianTab config={config} setConfig={setConfig} saveConfig={saveConfig} />
      )}

      {/* ── スライドのテンプレートの登録 ── */}
      {adminSubTab === 'secretary_presentation' && config && (
        <SecretaryPresentationTab config={config} setConfig={setConfig} saveConfig={saveConfig} />
      )}

      {/* ── 秘書の LINE 連携の設定 ── */}
      {adminSubTab === 'secretary_line' && config && (
        <SecretaryLineTab config={config} setConfig={setConfig} saveConfig={saveConfig} />
      )}

      {/* ── ショートカットキー設定 ────────────────────────── */}
      {adminSubTab === 'shortcuts' && config && (
        <ShortcutsTab config={config} setConfig={setConfig} saveConfig={saveConfig} />
      )}

      {/* ── 接続情報 ──────────────────────────────────────── */}
      {adminSubTab === 'credentials' && creds && (
        <CredentialsTab
          serverUrl={serverUrl}
          config={config} setConfig={setConfig} saveConfig={saveConfig}
          creds={creds} setCreds={setCreds} saveCredentials={saveCredentials}
          openCredsSections={openCredsSections} toggleCredsSection={toggleCredsSection}
        />
      )}

      {/* ── ログビューア ──────────────────────────────────── */}
      {adminSubTab === 'logs' && (
        <LogsTab
          serverLogs={serverLogs} logMinLevel={logMinLevel} setLogMinLevel={setLogMinLevel}
          logAutoRefresh={logAutoRefresh} setLogAutoRefresh={setLogAutoRefresh} fetchServerLogs={fetchServerLogs}
        />
      )}

      {/* ── リリースノート ──────────────────────────────────── */}
      {adminSubTab === 'release_notes' && (
        <ReleaseNotesTab releaseNotesContent={releaseNotesContent} fetchReleaseNotes={fetchReleaseNotes} />
      )}

      {/* ── 番組録音 ──────────────────────────────────────── */}
      {adminSubTab === 'recording' && (
        <RecordingTab
          serverUrl={serverUrl}
          recordingChannel={recordingChannel} setRecordingChannel={setRecordingChannel}
          recordingActive={recordingActive} startProgramRecording={startProgramRecording}
          stopProgramRecording={stopProgramRecording} recordingElapsedSec={recordingElapsedSec}
          recordingCurrentTarget={recordingCurrentTarget} recordingHistory={recordingHistory}
          fetchRecordingHistory={fetchRecordingHistory} formatRecordingDuration={formatRecordingDuration}
          playingRecordingId={playingRecordingId} setPlayingRecordingId={setPlayingRecordingId}
          deleteRecording={deleteRecording} formatFileSize={formatFileSize}
        />
      )}

      {/* ── 稼働レポート ──────────────────────────────────── */}
      {adminSubTab === 'report' && (
        <ReportTab
          reportDetail={reportDetail} setReportDetail={setReportDetail}
          reportEventFilter={reportEventFilter} setReportEventFilter={setReportEventFilter}
          reportSummary={reportSummary} reportCostBreakdown={reportCostBreakdown}
          reportSessions={reportSessions} reportTotal={reportTotal} reportLoading={reportLoading}
          reportPage={reportPage} setReportPage={setReportPage}
          reportChannel={reportChannel} setReportChannel={setReportChannel}
          reportFrom={reportFrom} setReportFrom={setReportFrom} reportTo={reportTo} setReportTo={setReportTo}
          fetchReport={fetchReport} fetchReportDetail={fetchReportDetail}
        />
      )}

      {/* ── 会話履歴ビューア ──────────────────────────────── */}
      {adminSubTab === 'history' && (
        <HistoryTab
          serverUrl={serverUrl}
          convHistory={convHistory} setConvHistory={setConvHistory}
          historyAgentFilter={historyAgentFilter} setHistoryAgentFilter={setHistoryAgentFilter}
          historyAutoRefresh={historyAutoRefresh} setHistoryAutoRefresh={setHistoryAutoRefresh}
          fetchConversationHistory={fetchConversationHistory} convHistoryEndRef={convHistoryEndRef}
        />
      )}
    </>
  );
}
