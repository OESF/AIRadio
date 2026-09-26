/**
 * @file 管理画面の「番組設定（The Answers）」グループ（番組設定・ディレクター・パネリスト・BGM・アーカイブ・日記）
 *
 * The Answers（討論の番組）の設定を編集する画面をまとめたもの。adminSubTab の値で、次のどれか1つを出す。
 * - 番組設定・ディレクター・BGM: ほかのチャンネルと共通のタブ（ChannelShowSettingsTab など）を使う
 * - パネリスト: 出演の候補（panelist_pool）。ほかのチャンネルのエージェントを参照し、隠れた才能・話す速さの
 *   上書き・多様性のための属性などを足す
 * - アーカイブ: 過去のエピソードの一覧（パネリストでの絞り込み・会話の記録・要約・録音・削除）
 * - 日記: パネリストとしての出演ごとのふり返り（AgentDiaryTab）
 * 設定と操作は App.tsx が持ち、このコンポーネントは表示と入力だけを受け持つ。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-19
 */

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  BeatlesConfig, ClassicConfig, FullConfig, JazzConfig, MoodConfig,
  TheAnswersBgmAll, TheAnswersConfig, TheAnswersDirectorAgent, TheAnswersHistoryEntry, TheAnswersPanelistEntry,
} from '../types';
import { ANSWERS_ARCHIVE_PAGE_SIZE, ANSWERS_ARCHIVE_SUMMARY_MIN_TRANSCRIPT_ENTRIES } from '../constants';
import { ChannelShowSettingsTab } from '../components/ChannelShowSettingsTab';
import { ChannelAgentsTab } from '../components/ChannelAgentsTab';
import { ChannelBgmTab } from '../components/ChannelBgmTab';
import { AccordionSection } from '../components/AccordionSection';
import { AgentDiaryTab } from '../components/AgentDiaryTab';

/**
 * The Answers の管理画面（adminSubTab に応じたタブを1つ出す）。
 *
 * @param props.adminSubTab 選ばれている管理画面のタブ
 * @param props.theAnswersConfig The Answers の設定（読み込み中は null）
 * @param props.setTheAnswersConfig 設定を書き換える（保存するまでファイルには書かれない）
 * @param props.onRefreshSettings 設定を読み直す
 * @param props.onSave 設定を保存する
 * @param props.ttsTestText 声の試聴に使う文
 * @param props.setTtsTestText 試聴の文を変える
 * @param props.onTest ディレクターの声を試聴する
 * @param props.avatarErrors アバター画像を読めなかった役割
 * @param props.onAvatarError アバター画像を読めなかったことを記録する
 * @param props.getAgentEmoji 役割に合う絵文字を返す（アバターが無いとき用）
 * @param props.openAgents 開いているエージェントの欄
 * @param props.setOpenAgents 開いているエージェントの欄を変える
 * @param props.testingAgent 試聴中のエージェント
 * @param props.creds 認証情報（既定のモデルを表示するため）
 * @param props.config Live の設定（パネリストの名前を引くため）
 * @param props.classicConfig Classic の設定（同上）
 * @param props.jazzConfig Jazz の設定（同上）
 * @param props.moodConfig Mood の設定（同上）
 * @param props.beatlesConfig Beatles の設定（同上）
 * @param props.openAnswersPanelistSections 開いているパネリストの欄
 * @param props.toggleAnswersPanelistSection パネリストの欄を開閉する
 * @param props.theAnswersBgmAll The Answers の BGM の一覧
 * @param props.localPlayingUrl 試聴中の BGM の URL
 * @param props.playLocal BGM を試聴する（同じものなら止める）
 * @param props.formatFileSize ファイルの大きさを表示用にする
 * @param props.serverUrl サーバーの URL
 * @param props.theAnswersHistory 過去のエピソード
 * @param props.answersArchiveFilterKey アーカイブを絞り込むパネリスト（空ならすべて）
 * @param props.setAnswersArchiveFilterKey 絞り込むパネリストを変える
 * @param props.answersArchivePage アーカイブのページ（0から）
 * @param props.setAnswersArchivePage アーカイブのページを変える
 * @param props.openArchiveEntries 会話の記録を開いているエピソード
 * @param props.toggleArchiveEntry 会話の記録を開閉する
 * @param props.openArchiveCards 開いているエピソードのカード
 * @param props.toggleArchiveCard エピソードのカードを開閉する
 * @param props.deleteArchiveEntry エピソードを削除する
 * @param props.deletingArchiveIds 削除中のエピソード
 * @param props.summarizingIds 要約を作っているエピソード
 * @param props.openSummaryEntries 要約を開いているエピソード
 * @param props.fetchArchiveSummary エピソードの要約を作る（または開く）
 * @returns The Answers の管理画面の要素
 */
export function TheAnswersPanel({
  adminSubTab, theAnswersConfig, setTheAnswersConfig, onRefreshSettings, onSave,
  ttsTestText, setTtsTestText, onTest,
  avatarErrors, onAvatarError, getAgentEmoji, openAgents, setOpenAgents,
  testingAgent, creds,
  config, classicConfig, jazzConfig, moodConfig, beatlesConfig,
  openAnswersPanelistSections, toggleAnswersPanelistSection,
  theAnswersBgmAll, localPlayingUrl, playLocal, formatFileSize, serverUrl,
  theAnswersHistory, answersArchiveFilterKey, setAnswersArchiveFilterKey,
  answersArchivePage, setAnswersArchivePage,
  openArchiveEntries, toggleArchiveEntry, openArchiveCards, toggleArchiveCard,
  deleteArchiveEntry, deletingArchiveIds,
  summarizingIds, openSummaryEntries, fetchArchiveSummary,
}: {
  adminSubTab: string;
  theAnswersConfig: TheAnswersConfig | null;
  setTheAnswersConfig: (v: TheAnswersConfig) => void;
  onRefreshSettings: () => void;
  onSave: (e: FormEvent) => void;
  ttsTestText: string;
  setTtsTestText: (v: string) => void;
  onTest: (agentKey: string, agent: TheAnswersDirectorAgent) => void;
  avatarErrors: Set<string>;
  onAvatarError: (role: string) => void;
  getAgentEmoji: (role: string) => string;
  openAgents: Set<string>;
  setOpenAgents: Dispatch<SetStateAction<Set<string>>>;
  testingAgent: string | null;
  creds: { gemini?: { model?: string } } | null;
  config: FullConfig | null;
  classicConfig: ClassicConfig | null;
  jazzConfig: JazzConfig | null;
  moodConfig: MoodConfig | null;
  beatlesConfig: BeatlesConfig | null;
  openAnswersPanelistSections: Set<string>;
  toggleAnswersPanelistSection: (id: string) => void;
  theAnswersBgmAll: TheAnswersBgmAll;
  localPlayingUrl: string | null;
  playLocal: (url: string) => void;
  formatFileSize: (bytes: number) => string;
  serverUrl: string;
  theAnswersHistory: TheAnswersHistoryEntry[];
  answersArchiveFilterKey: string;
  setAnswersArchiveFilterKey: (v: string) => void;
  answersArchivePage: number;
  setAnswersArchivePage: (v: number) => void;
  openArchiveEntries: Set<string>;
  toggleArchiveEntry: (id: string) => void;
  openArchiveCards: Set<string>;
  toggleArchiveCard: (id: string) => void;
  deleteArchiveEntry: (id: string) => void;
  deletingArchiveIds: Set<string>;
  summarizingIds: Set<string>;
  openSummaryEntries: Set<string>;
  fetchArchiveSummary: (id: string) => void;
}) {
  return (
    <>
      {/* ── The Answers チャンネル管理 ────────────────────────────── */}
      {(adminSubTab === 'answers_show_settings' || adminSubTab === 'answers_director' ||
        adminSubTab === 'answers_panelists' || adminSubTab === 'answers_bgm' || adminSubTab === 'answers_history') && !theAnswersConfig && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
          <span className="text-3xl">🗣️</span>
          <p className="text-sm">The Answers設定を読み込めませんでした。</p>
          <p className="text-xs text-gray-600">サーバーが起動しているか確認してから
            <button onClick={onRefreshSettings} className="ml-1 underline hover:text-gray-400">↻ 更新</button>
            してください。
          </p>
        </div>
      )}

      {adminSubTab === 'answers_show_settings' && theAnswersConfig && (
        <ChannelShowSettingsTab
          icon="🗣️"
          title="番組設定（The Answers）"
          program={theAnswersConfig.program}
          setProgram={patch => setTheAnswersConfig({ ...theAnswersConfig, program: { ...theAnswersConfig.program, ...patch } })}
          onSubmit={onSave}
          extra={
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label>目標時間（分）</label>
                <input type="number" value={theAnswersConfig.program.session_target_minutes}
                  onChange={e => setTheAnswersConfig({ ...theAnswersConfig, program: { ...theAnswersConfig.program, session_target_minutes: parseInt(e.target.value, 10) || 25 } })} />
              </div>
              <div>
                <label>上限時間（分）</label>
                <input type="number" value={theAnswersConfig.program.session_max_minutes}
                  onChange={e => setTheAnswersConfig({ ...theAnswersConfig, program: { ...theAnswersConfig.program, session_max_minutes: parseInt(e.target.value, 10) || 30 } })} />
              </div>
            </div>
          }
        />
      )}

      {adminSubTab === 'answers_director' && theAnswersConfig && (
        <ChannelAgentsTab
          channelLabel="The Answers"
          accent="cyan"
          agentRoles={['director'] as const}
          agents={{ director: theAnswersConfig.director }}
          setAgent={(_role, patch) => setTheAnswersConfig({ ...theAnswersConfig, director: { ...theAnswersConfig.director, ...patch } })}
          ttsTestText={ttsTestText}
          setTtsTestText={setTtsTestText}
          onTest={(role, agent) => onTest(role, agent)}
          onSubmit={onSave}
          avatarErrors={avatarErrors}
          onAvatarError={onAvatarError}
          getAgentEmoji={() => '🗣️'}
          avatarFile={() => 'answers_director'}
          openAgents={openAgents}
          setOpenAgents={setOpenAgents}
          testingAgent={testingAgent}
          creds={creds}
        />
      )}

      {adminSubTab === 'answers_panelists' && theAnswersConfig && (() => {
        const resolveDisplay = (entry: TheAnswersPanelistEntry): { name: string; role: string } => {
          const key = entry.sourceAgentKey;
          const src = entry.sourceChannel === 'live' ? config?.agents?.[key]
            : entry.sourceChannel === 'classic' ? classicConfig?.agents?.[key as keyof typeof classicConfig.agents]
            : entry.sourceChannel === 'jazz'    ? jazzConfig?.agents?.[key as keyof typeof jazzConfig.agents]
            : entry.sourceChannel === 'mood'    ? moodConfig?.agents?.[key as keyof typeof moodConfig.agents]
            : entry.sourceChannel === 'beatles' ? beatlesConfig?.agents?.[key as keyof typeof beatlesConfig.agents]
            : undefined;
          return { name: src?.name || key, role: (src as { role?: string } | undefined)?.role || key };
        };
        const setPanelistEntry = (poolKey: string, patch: Partial<TheAnswersPanelistEntry>) => {
          setTheAnswersConfig({
            ...theAnswersConfig,
            panelist_pool: {
              ...theAnswersConfig.panelist_pool,
              [poolKey]: { ...theAnswersConfig.panelist_pool[poolKey], ...patch },
            },
          });
        };
        return (
          <form onSubmit={onSave} className="flex flex-col gap-6">
            <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
              <span className="text-xl">🗣️</span>
              <h2 className="text-lg font-bold text-white">パネリスト裏プロファイル（隠れた才能）</h2>
            </div>
            <p className="text-sm text-gray-400">
              各パネリストの名前・声・本来のプロンプトは出演元チャンネルの設定がそのまま使われます（ここでは変更できません）。
              ここで編集するのは The Answers 出演時にのみ追加される「隠れた才能」と、テンポ調整用の会話ペース上書きです。
            </p>
            <div className="flex flex-col gap-3">
              {Object.entries(theAnswersConfig.panelist_pool).map(([poolKey, entry]) => {
                const display = resolveDisplay(entry);
                const badges = [
                  entry.always_include ? '常時起用' : null,
                  entry.perspective_type || null,
                ].filter(Boolean) as string[];
                const avatarKey = entry.sourceAgentKey;
                return (
                  <AccordionSection
                    key={poolKey}
                    id={poolKey}
                    title={
                      <span className="flex items-center gap-2">
                        {avatarErrors.has(avatarKey) ? (
                          <span className="text-xl flex-shrink-0" style={{ width: '36px' }}>{getAgentEmoji(avatarKey)}</span>
                        ) : (
                          <img
                            src={`/avatars/${avatarKey}.png`}
                            alt={avatarKey}
                            onError={() => onAvatarError(avatarKey)}
                            className="w-9 h-9 object-contain rounded-full flex-shrink-0"
                            style={{ background: 'rgba(255,255,255,0.04)' }}
                          />
                        )}
                        {/* 各列を固定幅にして、名前・役職・チャンネルの開始位置を全行で揃える */}
                        <span className="truncate" style={{ width: '280px', flexShrink: 0 }}>{display.name}</span>
                        <span className="text-xs text-gray-500 uppercase tracking-widest font-normal truncate" style={{ width: '130px', flexShrink: 0 }}>{display.role}</span>
                        <span className="text-xs text-gray-600 font-mono font-normal" style={{ width: '80px', flexShrink: 0 }}>({entry.sourceChannel})</span>
                        <span className="flex items-center gap-2 flex-wrap">
                          {badges.map(b => (
                            <span key={b} className="text-xs px-2 py-0.5 rounded-full bg-cyan-900/40 text-cyan-300 border border-cyan-700/40 font-normal">{b}</span>
                          ))}
                        </span>
                      </span>
                    }
                    open={openAnswersPanelistSections.has(poolKey)}
                    onToggle={toggleAnswersPanelistSection}
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="md:col-span-2">
                        <label>隠れた才能（The Answers出演時のみ追加されるプロフィール）</label>
                        <textarea rows={2} value={entry.hidden_talent_prompt}
                          onChange={e => setPanelistEntry(poolKey, { hidden_talent_prompt: e.target.value })} />
                      </div>
                      <div className="md:col-span-2">
                        <label>会話ペース上書き（tts_pacing。本来のチャンネルの設定は変更されません）</label>
                        <input type="text" value={entry.tts_pacing_override}
                          onChange={e => setPanelistEntry(poolKey, { tts_pacing_override: e.target.value })} />
                      </div>
                      <div className="md:col-span-2 text-xs text-gray-500">
                        パネル選定の多様性バランス用タグ（ディレクタが選定時の参考にします。テーマとの関連性を優先するため強制ではありません）
                      </div>
                      <div>
                        <label>性別</label>
                        <select value={entry.gender || ''} onChange={e => setPanelistEntry(poolKey, { gender: e.target.value })}>
                          <option value="">未設定</option>
                          <option value="男性">男性</option>
                          <option value="女性">女性</option>
                        </select>
                      </div>
                      <div>
                        <label>年代</label>
                        <select value={entry.age_bracket || ''} onChange={e => setPanelistEntry(poolKey, { age_bracket: e.target.value })}>
                          <option value="">未設定</option>
                          <option value="20代">20代</option>
                          <option value="30代">30代</option>
                          <option value="40代">40代</option>
                          <option value="50代">50代</option>
                          <option value="60代以上">60代以上</option>
                        </select>
                      </div>
                      <div>
                        <label>未婚・既婚</label>
                        <select value={entry.marital_status || ''} onChange={e => setPanelistEntry(poolKey, { marital_status: e.target.value })}>
                          <option value="">未設定</option>
                          <option value="独身">独身</option>
                          <option value="既婚">既婚</option>
                        </select>
                      </div>
                      <div>
                        <label>政治的スタンス</label>
                        <select value={entry.political_stance || ''} onChange={e => setPanelistEntry(poolKey, { political_stance: e.target.value })}>
                          <option value="">未設定</option>
                          <option value="保守">保守</option>
                          <option value="中道">中道</option>
                          <option value="革新">革新</option>
                        </select>
                      </div>
                      <div>
                        <label>出身地（食べ物・方言など地域差テーマで本人の発言に反映されます）</label>
                        <input type="text" value={entry.hometown_region || ''} placeholder="例: 関東 / 関西（京都） / 海外（アメリカ）"
                          onChange={e => setPanelistEntry(poolKey, { hometown_region: e.target.value })} />
                      </div>
                      <div>
                        <label>視点タイプ（専門家型ばかりに偏らせないための分類）</label>
                        <select value={entry.perspective_type || ''} onChange={e => setPanelistEntry(poolKey, { perspective_type: e.target.value })}>
                          <option value="">未設定</option>
                          <option value="専門家型">専門家型</option>
                          <option value="庶民感覚型">庶民感覚型</option>
                          <option value="芸術家・感性型">芸術家・感性型</option>
                          <option value="こだわり・目利き型">こだわり・目利き型</option>
                          <option value="変わり者・独自路線型">変わり者・独自路線型</option>
                        </select>
                      </div>
                    </div>
                  </AccordionSection>
                );
              })}
            </div>
            <button type="submit" className="btn btn-primary py-3">パネリスト裏プロファイルを保存</button>
          </form>
        );
      })()}

      {adminSubTab === 'answers_bgm' && theAnswersConfig && (
        <ChannelBgmTab
          channelLabel="The Answers"
          accent="cyan"
          channelSlug="the_answers"
          bgmAll={theAnswersBgmAll}
          onRefresh={onRefreshSettings}
          localPlayingUrl={localPlayingUrl}
          playLocal={playLocal}
          formatFileSize={formatFileSize}
          serverUrl={serverUrl}
          extraMainNote="ディスカッション中ずっと静かに流れる背景BGM"
          secondBucket={{ key: 'main', label: 'トーク用BGM（番組中シャッフル再生）', icon: '🎵' }}
          thirdBucket={{ key: 'ending', label: 'エンディングジングル', icon: '🎬' }}
        />
      )}

      {adminSubTab === 'answers_history' && theAnswersConfig && (() => {
        const resolveSpeakerName = (poolKey: string): string => {
          if (poolKey === 'user') return 'リスナー';
          const entry = theAnswersConfig.panelist_pool[poolKey];
          if (!entry) return poolKey;
          const key = entry.sourceAgentKey;
          const src = entry.sourceChannel === 'live' ? config?.agents?.[key]
            : entry.sourceChannel === 'classic' ? classicConfig?.agents?.[key as keyof typeof classicConfig.agents]
            : entry.sourceChannel === 'jazz'    ? jazzConfig?.agents?.[key as keyof typeof jazzConfig.agents]
            : entry.sourceChannel === 'mood'    ? moodConfig?.agents?.[key as keyof typeof moodConfig.agents]
            : entry.sourceChannel === 'beatles' ? beatlesConfig?.agents?.[key as keyof typeof beatlesConfig.agents]
            : undefined;
          return src?.name || poolKey;
        };
        // エピソード全体の開始・終了の時刻は記録していないので、会話の記録の最初と最後の発言の時刻で近似する
        // （会話の記録が無い＝何も話さずに途中で終わった場合は、playedAt の一点だけを使う）
        const getEpisodeTimeRange = (ep: TheAnswersHistoryEntry) => {
          const transcript = ep.transcript || [];
          const startTs = transcript.length > 0 ? transcript[0].ts : new Date(ep.playedAt).getTime();
          const endTs = transcript.length > 0 ? transcript[transcript.length - 1].ts : startTs;
          const startDate = new Date(startTs);
          const endDate = new Date(endTs);
          return {
            dateStr: startDate.toLocaleDateString('ja-JP'),
            startTimeStr: startDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
            endTimeStr: endDate.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
          };
        };
        // パネリストで絞り込むためのプルダウン候補（登場する全パネリストの重複除去・表示名でソート）
        const panelistFilterOptions = Array.from(new Set(theAnswersHistory.flatMap(e => e.panelKeys)))
          .map(k => ({ key: k, name: resolveSpeakerName(k) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        const filteredHistory = answersArchiveFilterKey
          ? theAnswersHistory.filter(e => e.panelKeys.includes(answersArchiveFilterKey))
          : theAnswersHistory;
        return (
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
            <div className="flex items-center gap-2">
              <span className="text-xl">🗣️</span>
              <h2 className="text-lg font-bold text-white">アーカイブ</h2>
            </div>
            <button onClick={onRefreshSettings} className="btn btn-dark text-xs px-3 py-1">↻ 更新</button>
          </div>
          <p className="text-sm text-gray-400">
            日時・テーマ・パネリストに加え、全発言のテキストと番組全体の録音を蓄積します。
            直近{theAnswersConfig.program.rotation_lookback_episodes ?? 3}エピソード分は同じパネリストの連続起用を避けるローテーション判定にも使われます。
          </p>
          {theAnswersHistory.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-400 shrink-0">パネリストで絞り込み</label>
              <select
                value={answersArchiveFilterKey}
                onChange={e => { setAnswersArchiveFilterKey(e.target.value); setAnswersArchivePage(0); }}
                className="text-xs"
                style={{ maxWidth: '240px' }}
              >
                <option value="">すべて</option>
                {panelistFilterOptions.map(o => (
                  <option key={o.key} value={o.key}>{o.name}</option>
                ))}
              </select>
            </div>
          )}
          {theAnswersHistory.length === 0 ? (
            <p className="text-gray-600 text-sm py-4">まだ放送履歴がありません。</p>
          ) : filteredHistory.length === 0 ? (
            <p className="text-gray-600 text-sm py-4">条件に一致するエピソードがありません。</p>
          ) : (() => {
            const totalPages = Math.max(1, Math.ceil(filteredHistory.length / ANSWERS_ARCHIVE_PAGE_SIZE));
            const safePage = Math.min(answersArchivePage, totalPages - 1);
            const pageItems = filteredHistory.slice(
              safePage * ANSWERS_ARCHIVE_PAGE_SIZE,
              (safePage + 1) * ANSWERS_ARCHIVE_PAGE_SIZE
            );
            return (
            <>
            <div className="flex flex-col gap-2">
              {pageItems.map((ep) => {
                const panelNames = ep.panelKeys.map(k => resolveSpeakerName(k)).join('、');
                const isOpen = openArchiveEntries.has(ep.id);
                const isCardOpen = openArchiveCards.has(ep.id);
                const timeRange = getEpisodeTimeRange(ep);
                return (
                  <div key={ep.id} className="border border-glass rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.2)' }}>
                    <div className="flex items-center justify-between gap-2 flex-wrap" style={{ padding: '10px 16px' }}>
                      <button
                        type="button"
                        onClick={() => toggleArchiveCard(ep.id)}
                        className="flex flex-col items-start gap-0.5 flex-1 text-left hover:opacity-80 transition-opacity"
                        style={{ minWidth: 0 }}
                      >
                        <div className="flex items-center gap-2 flex-wrap w-full">
                          <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ${isCardOpen ? 'rotate-180' : ''}`} />
                          <span className="text-sm text-gray-300 whitespace-nowrap">
                            {timeRange.dateStr} {timeRange.startTimeStr} - {timeRange.endTimeStr}
                          </span>
                          {ep.interrupted && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300 border border-amber-700/40 shrink-0">途中終了</span>
                          )}
                        </div>
                        <span
                          className={`text-white font-bold w-full ${isCardOpen ? 'whitespace-normal' : 'truncate'}`}
                          style={{ paddingLeft: '24px' }}
                        >
                          {ep.theme}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteArchiveEntry(ep.id)}
                        disabled={deletingArchiveIds.has(ep.id)}
                        className="btn btn-dark text-xs px-2 py-1 shrink-0"
                        style={{ color: '#f87171' }}
                        title="このアーカイブを削除（録音データも削除されます）"
                      >
                        {deletingArchiveIds.has(ep.id) ? '削除中…' : '🗑️ 削除'}
                      </button>
                    </div>
                    {isCardOpen && (
                      <div className="border-t border-glass" style={{ padding: '12px 16px' }}>
                        <p className="text-xs text-gray-500">{panelNames}</p>
                        <div className="flex items-center gap-2 flex-wrap mt-2">
                          {ep.transcript && ep.transcript.length > 0 && (
                            <button
                              onClick={() => toggleArchiveEntry(ep.id)}
                              className="btn btn-dark text-xs px-2 py-1"
                            >
                              {isOpen ? '会話を閉じる' : `会話を表示（${ep.transcript.length}件）`}
                            </button>
                          )}
                          {(() => {
                            const entryCount = ep.transcript?.length ?? 0;
                            const canSummarize = entryCount >= ANSWERS_ARCHIVE_SUMMARY_MIN_TRANSCRIPT_ENTRIES;
                            const isSummarizing = summarizingIds.has(ep.id);
                            const isSummaryOpen = openSummaryEntries.has(ep.id);
                            return (
                              <button
                                onClick={() => fetchArchiveSummary(ep.id)}
                                disabled={!canSummarize || isSummarizing}
                                title={canSummarize ? undefined : '会話量が少ないため要約を生成できません'}
                                className="btn btn-dark text-xs px-2 py-1"
                              >
                                {isSummarizing ? '要約生成中…'
                                  : ep.summary ? (isSummaryOpen ? '要約を閉じる' : '要約を表示')
                                  : '📝 要約'}
                              </button>
                            );
                          })()}
                          {ep.recordingFilename ? (
                            <div className="flex items-center gap-2">
                              <audio controls preload="none" style={{ height: '32px' }}
                                src={`${serverUrl}/api/the_answers/archive/${ep.id}/audio`} />
                              {!!ep.recordingSizeBytes && (
                                <span className="text-xs text-gray-600">{formatFileSize(ep.recordingSizeBytes)}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-600">録音なし</span>
                          )}
                        </div>
                        {isOpen && ep.transcript && (
                          <div className="mt-3 pt-3 border-t border-glass flex flex-col gap-1.5" style={{ maxHeight: '360px', overflowY: 'auto' }}>
                            {ep.transcript.map((t, i) => (
                              <p key={i} className="text-xs text-gray-300">
                                <span className="text-gray-500 font-mono mr-2">{new Date(t.ts).toLocaleTimeString('ja-JP')}</span>
                                <span className="font-bold text-gray-200 mr-1">{resolveSpeakerName(t.speaker)}:</span>
                                {t.text}
                              </p>
                            ))}
                          </div>
                        )}
                        {openSummaryEntries.has(ep.id) && ep.summary && (
                          <div className="mt-3 pt-3 border-t border-glass flex flex-col gap-3">
                            <div>
                              <p className="text-xs text-gray-500 font-bold mb-1">まとめ</p>
                              <p className="text-xs text-gray-300 leading-relaxed">{ep.summary.summary}</p>
                            </div>
                            {ep.summary.highlights.length > 0 && (
                              <div>
                                <p className="text-xs text-gray-500 font-bold mb-1">名言・面白かった瞬間</p>
                                <ul className="flex flex-col gap-1 list-disc pl-4">
                                  {ep.summary.highlights.map((h, i) => (
                                    <li key={i} className="text-xs text-gray-300 leading-relaxed">{h}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-2">
                <button
                  onClick={() => setAnswersArchivePage(safePage - 1)}
                  disabled={safePage <= 0}
                  className="btn btn-dark text-xs px-3 py-1"
                >
                  ← 前へ
                </button>
                <span className="text-xs text-gray-400">{safePage + 1} / {totalPages}（全{filteredHistory.length}件）</span>
                <button
                  onClick={() => setAnswersArchivePage(safePage + 1)}
                  disabled={safePage >= totalPages - 1}
                  className="btn btn-dark text-xs px-3 py-1"
                >
                  次へ →
                </button>
              </div>
            )}
            </>
            );
          })()}
        </div>
        );
      })()}

      {adminSubTab === 'answers_diary' && (
        <AgentDiaryTab
          serverUrl={serverUrl}
          channel="the_answers"
          emptyMessage="日記がまだありません。The Answers のエピソードが終了すると、そのエピソードに出演した各パネリスト（MAXを含む）が番組全体を通しての振り返りを1回だけ書きます（発言のたびにではありません）。ホームチャンネル側の日記とは別に、出演回ごとの裏プロファイル込みの振り返りとして記録されます。"
        />
      )}
    </>
  );
}
