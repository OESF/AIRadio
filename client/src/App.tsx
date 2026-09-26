/**
 * @file 管理画面（各チャンネルの設定・履歴・レポートの入口）
 *
 * 管理画面のルート。左のメニューでタブを選び、右へ各チャンネルのパネル（admin/panels/*）を
 * 差し替えて表示する。サーバーの設定・認証情報・各チャンネルの設定・BGM・発声辞書・各種の
 * 履歴をまとめて読み込み、状態と保存・取得の関数をパネルへ props で配る。
 *
 * 保存先はすべてサーバー側（/api/config, /api/credentials, /api/<チャンネル>/config など）で、
 * この画面自身はデータを持たない。
 *
 * ATTENTION: 新しいタブのキーを増やしたら、末尾の「ロード中...」を出すかどうかの判定にある
 * 除外の一覧にも必ず足すこと。忘れると、そのタブの下に「ロード中...」が二重に出る。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
} from 'lucide-react';
import type {
  ChannelAgentShape, BgmFile, ClassicConfig, JazzConfig, MoodConfig, BeatlesConfig, TwentyFourYouConfig,
  TheAnswersConfig, TheAnswersDirectorAgent, TheAnswersBgmAll, TheAnswersHistoryEntry,
  AgentConfig, TempStay, SpecialDate,
  FullConfig, Credentials, TtsDictEntry, LogEntry, ServerLogEntry,
  RecordableChannel, RecordingEntry, ConversationEntry, ReportSession, ReportDetail, ReportSummary, ReportCostBreakdown,
  DiaryEntry, FinanceWatchlist, JournalistWatchlist, BgmAll,
} from './admin/types';
import { REPORT_PAGE_SIZE } from './admin/constants';
import { ClassicPanel } from './admin/panels/ClassicPanel';
import { JazzPanel } from './admin/panels/JazzPanel';
import { MoodPanel } from './admin/panels/MoodPanel';
import { BeatlesPanel } from './admin/panels/BeatlesPanel';
import { TwentyFourYouPanel } from './admin/panels/TwentyFourYouPanel';
import { TheAnswersPanel } from './admin/panels/TheAnswersPanel';
import { SystemPanel } from './admin/panels/SystemPanel';
import { LivePanel } from './admin/panels/LivePanel';

// 各チャンネルのエージェント設定から、音声の試聴に必要な項目だけを抜き出した形。
// チャンネルごとに型は違うが、この範囲の形はそろっているので共通で受け取れる。
type TtsTestableAgent = {
  tts_engine?: string;
  gemini_voice?: string;
  gemini_language?: string;
  gemini_instruction?: string;
  tts_profile_title?: string;
  tts_scene?: string;
  tts_style?: string;
  tts_accent?: string;
  tts_pacing?: string;
  tts_context?: string;
};

export default function App() {
  const SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : window.location.origin;

  // いま開いているタブと、メニュー・折りたたみの開閉状態
  const [adminSubTab, setAdminSubTab] = useState<
    'listener_info' | 'music_profile' | 'traffic_area' | 'temp_stay' | 'special_dates' | 'finance' | 'journalist_watchlist' |
    'show_settings' | 'bgm' |
    'dict' | 'agents' | 'administrator' | 'secretary' | 'secretary_learning' | 'secretary_diary' | 'secretary_loop' | 'secretary_obsidian' | 'secretary_presentation' | 'secretary_line' | 'shortcuts' | 'credentials' | 'logs' | 'history' | 'live_diary' | 'recording' | 'report' | 'release_notes' |
    'classic_show_settings' | 'classic_agents' | 'classic_bgm' | 'classic_diary' |
    'jazz_show_settings' | 'jazz_agents' | 'jazz_bgm' | 'jazz_diary' |
    'mood_show_settings' | 'mood_agents' | 'mood_bgm' | 'mood_diary' |
    'beatles_show_settings' | 'beatles_agents' | 'beatles_bgm' | 'beatles_diary' |
    'you_show_settings' |
    'answers_show_settings' | 'answers_director' | 'answers_panelists' | 'answers_bgm' | 'answers_history' | 'answers_diary'
  >('listener_info');
  const [openNavGroups, setOpenNavGroups] = useState<Set<string>>(new Set());
  const [openAgents, setOpenAgents] = useState<Set<string>>(new Set());
  const [openCredsSections, setOpenCredsSections] = useState<Set<string>>(new Set());
  const toggleCredsSection = (id: string) =>
    setOpenCredsSections(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [avatarErrors, setAvatarErrors] = useState<Set<string>>(new Set());
  const onAvatarError = (key: string) =>
    setAvatarErrors(prev => new Set([...prev, key]));

  // サーバーから読み込んだ設定
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [creds, setCreds] = useState<Credentials | null>(null);

  // ── Classic チャンネル設定 ───────────────────────────────────────
  const [classicConfig, setClassicConfig] = useState<ClassicConfig | null>(null);
  const [classicBgmAll, setClassicBgmAll] = useState<{ opening: BgmFile[]; main: BgmFile[] } | null>(null);

  // ── Jazz チャンネル設定 ─────────────────────────────────────────
  const [jazzConfig, setJazzConfig] = useState<JazzConfig | null>(null);
  const [jazzBgmAll, setJazzBgmAll] = useState<{ opening: BgmFile[]; main: BgmFile[] } | null>(null);

  // ── Mood チャンネル設定 ─────────────────────────────────────────
  const [moodConfig, setMoodConfig] = useState<MoodConfig | null>(null);
  const [moodBgmAll, setMoodBgmAll] = useState<{ opening: BgmFile[]; main: BgmFile[] } | null>(null);
  const [moodTtsTestText, setMoodTtsTestText] = useState('ようこそ、トワイライト・ラウンジへ。今宵も素晴らしい音楽をお届けします。');

  // ── Beatles チャンネル設定 ───────────────────────────────────────
  const [beatlesConfig, setBeatlesConfig] = useState<BeatlesConfig | null>(null);
  const [beatlesBgmAll, setBeatlesBgmAll] = useState<{ opening: BgmFile[]; main: BgmFile[] } | null>(null);
  const [beatlesTtsTestText, setBeatlesTtsTestText] = useState('週に7日じゃ足りない。僕らには、8日目のビートルズがある。ようこそ、Eight Days A Weekへ。');

  // ── 24/You チャンネル設定（ナレーションのエージェントも BGM も無い） ─────
  const [youConfig, setYouConfig] = useState<TwentyFourYouConfig | null>(null);

  // ── The Answers チャンネル設定（複数の視点で語り合う討論番組） ─────────
  const [theAnswersConfig, setTheAnswersConfig] = useState<TheAnswersConfig | null>(null);
  const [theAnswersBgmAll, setTheAnswersBgmAll] = useState<TheAnswersBgmAll>(null);
  const [theAnswersTtsTestText, setTheAnswersTtsTestText] = useState('『The Answers』へようこそ。答えは一つじゃない、そんな時間を今日もお届けします。');
  const [theAnswersHistory, setTheAnswersHistory] = useState<TheAnswersHistoryEntry[]>([]);
  const [openArchiveEntries, setOpenArchiveEntries] = useState<Set<string>>(new Set());
  const toggleArchiveEntry = (id: string) =>
    setOpenArchiveEntries(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [openSummaryEntries, setOpenSummaryEntries] = useState<Set<string>>(new Set());
  const [summarizingIds, setSummarizingIds] = useState<Set<string>>(new Set());
  // 保存された回（テーマ・出演者・要約・録音）の折りたたみの開閉状態
  const [openArchiveCards, setOpenArchiveCards] = useState<Set<string>>(new Set());
  const toggleArchiveCard = (id: string) =>
    setOpenArchiveCards(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [answersArchivePage, setAnswersArchivePage] = useState(0);
  const [answersArchiveFilterKey, setAnswersArchiveFilterKey] = useState('');
  const [deletingArchiveIds, setDeletingArchiveIds] = useState<Set<string>>(new Set());
  const deleteArchiveEntry = async (id: string) => {
    if (!window.confirm('このアーカイブを削除します。録音データも削除され、元に戻せません。よろしいですか？')) return;
    setDeletingArchiveIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch(`${SERVER_URL}/api/the_answers/archive/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || data.error) {
        showWarningToast(data.error || '削除に失敗しました');
        return;
      }
      setTheAnswersHistory(prev => prev.filter(e => e.id !== id));
    } catch (e: any) {
      showWarningToast(`削除に失敗しました: ${e.message}`);
    } finally {
      setDeletingArchiveIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };
  const fetchArchiveSummary = async (id: string) => {
    const entry = theAnswersHistory.find(e => e.id === id);
    if (!entry) return;
    if (entry.summary) {
      setOpenSummaryEntries(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
      return;
    }
    setSummarizingIds(prev => new Set(prev).add(id));
    try {
      const res = await fetch(`${SERVER_URL}/api/the_answers/archive/${id}/summarize`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        showWarningToast(data.error || '要約の生成に失敗しました');
        return;
      }
      setTheAnswersHistory(prev => prev.map(e => e.id === id ? { ...e, summary: data } : e));
      setOpenSummaryEntries(prev => new Set(prev).add(id));
    } catch (e: any) {
      showWarningToast(`要約の生成に失敗しました: ${e.message}`);
    } finally {
      setSummarizingIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };
  const [openAnswersPanelistSections, setOpenAnswersPanelistSections] = useState<Set<string>>(new Set());
  const toggleAnswersPanelistSection = (id: string) =>
    setOpenAnswersPanelistSections(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // 金融の見守り一覧（指数・為替・債券・商品・個別株・保有資産）
  const [financeWL, setFinanceWL] = useState<FinanceWatchlist>({
    indices: [], forex: [], bonds: [], commodities: [], stocks: [], personal_holdings: []
  });
  const [newStock, setNewStock] = useState({ symbol: '', name: '', unit: 'ドル', dec: 1 });

  // ジャーナリストの見守り一覧（分野ごとの人物・組織）
  const [journalistWL, setJournalistWL] = useState<JournalistWatchlist>({
    japan_official: [], japan_politics: [], us_official: [], us_politics: [],
    tech_business: [], world_leaders: [], international_orgs: [], primary_wire: [], sports: [],
  });
  const [journalistDrafts, setJournalistDrafts] = useState<Record<string, { name: string; x_handle: string }>>({});
  const [openJournalistSections, setOpenJournalistSections] = useState<Set<string>>(new Set());
  const toggleJournalistSection = (id: string) =>
    setOpenJournalistSections(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [newSpecialDate, setNewSpecialDate] = useState<SpecialDate>({ start: '', end: '', label: '', instruction: '', personal: true });
  const [editingSpecialIdx, setEditingSpecialIdx] = useState<number | null>(null);
  const [newTempStay, setNewTempStay] = useState<TempStay>({ location: '', purpose: 'レジャー', start: '', end: '', timezone: 'Asia/Tokyo', note: '' });
  const [editingTempStay, setEditingTempStay] = useState(false);
  const [bgmFiles, setBgmFiles] = useState<{ filename: string; size: number }[]>([]);
  const [currentBgmFile, setCurrentBgmFile] = useState<string | null>(null);
  const [localPlayingUrl, setLocalPlayingUrl] = useState<string | null>(null);
  const localAudioRef = useRef<HTMLAudioElement | null>(null);

  // BGM の全区分（/api/bgm/all）
  const [bgmAll, setBgmAll] = useState<BgmAll>(null);

  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [toastLeaving, setToastLeaving] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [warningToastMsg, setWarningToastMsg] = useState<string | null>(null);
  const [warningToastLeaving, setWarningToastLeaving] = useState(false);
  const warningToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);


  // 交通情報の対象エリアの提案
  const [trafficAreaInput, setTrafficAreaInput] = useState('');
  const [isSuggestingTraffic, setIsSuggestingTraffic] = useState(false);

  // 音声の試聴で読ませる文（チャンネルごとに別々に持つ）
  const [liveTtsTestText,    setLiveTtsTestText]    = useState('こんにちは！今日もよろしくお願いします。');
  const [classicTtsTestText, setClassicTtsTestText] = useState('本日は美しいクラシック音楽をお届けします。');
  const [jazzTtsTestText,    setJazzTtsTestText]    = useState("Welcome to the Jazz channel. Let's feel the groove.");
  const [testingAgent, setTestingAgent] = useState<string | null>(null);


  // サーバーのログの表示
  const [serverLogs, setServerLogs] = useState<ServerLogEntry[]>([]);
  const [logMinLevel, setLogMinLevel] = useState<'debug'|'info'|'warn'|'error'>('info');
  const [logAutoRefresh, setLogAutoRefresh] = useState(false);
  const logAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // リリースノートの表示
  const [releaseNotesContent, setReleaseNotesContent] = useState('');

  // 番組録音
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingChannel, setRecordingChannel] = useState<RecordableChannel>('live');
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [recordingCurrentTarget, setRecordingCurrentTarget] = useState<string | null>(null);
  const [recordingHistory, setRecordingHistory] = useState<RecordingEntry[]>([]);
  const [playingRecordingId, setPlayingRecordingId] = useState<string | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 会話履歴の表示
  const [convHistory, setConvHistory]           = useState<ConversationEntry[]>([]);
  const [historyAgentFilter, setHistoryAgentFilter] = useState<string>('all');
  const [historyAutoRefresh, setHistoryAutoRefresh] = useState(false);
  const historyAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // エージェント日記（コーナーが終わった後の一人称の振り返り）
  const [diaryEntries, setDiaryEntries]           = useState<DiaryEntry[]>([]);
  const [diaryAgentFilter, setDiaryAgentFilter]   = useState<string>('all');
  const [diaryAutoRefresh, setDiaryAutoRefresh]   = useState(false);
  const diaryAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 好みの音楽の入力欄。
  // ATTENTION: 設定の配列を1文字打つごとに文字列と配列で変換すると、日本語の変換と
  // ぶつかって入力できなくなる。必ずこの文字列の状態をはさむこと。
  const musicFieldsInitRef                = useRef(false);
  const [musicGenresText, setMusicGenresText]         = useState('');
  const [newArtistInput, setNewArtistInput] = useState('');

  // 読み方の辞書
  const [ttsDict, setTtsDict]             = useState<TtsDictEntry[]>([]);
  const [dictEditing, setDictEditing]     = useState<number | null>(null);
  const [dictSaving, setDictSaving]       = useState(false);
  const [dictTestInput, setDictTestInput] = useState('NYダウが上昇、NASDAQ 100も急伸。CPI発表を受けFRBが動く。PM3時の速報。');
  const [dictPreviewOpen, setDictPreviewOpen] = useState(false);
  const EMPTY_DICT_ENTRY = { pattern: '', flags: 'g', replacement: '', note: '' };
  const [dictNewEntry, setDictNewEntry]   = useState(EMPTY_DICT_ENTRY);

  const convHistoryEndRef = useRef<HTMLDivElement>(null); // 会話履歴の末尾へ送るための目印

  // 履歴が増えたときとタブを開いたとき、会話履歴の末尾へ送る
  useEffect(() => {
    if (adminSubTab === 'history') {
      setTimeout(() => convHistoryEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [convHistory, adminSubTab]);

  // 画面を開いたときに一度だけ読み込む
  useEffect(() => {
    fetchSettings();
  }, []);

  // 設定を最初に読み込んだときだけ、好みの音楽の入力欄へ書き戻す
  useEffect(() => {
    if (config && !musicFieldsInitRef.current) {
      musicFieldsInitRef.current = true;
      setMusicGenresText((config.show.user_profile.music_genres ?? []).join('、'));
    }
  }, [config]);

  const addLog = (type: LogEntry['type'], message: string) => {
    console.log(`[${type.toUpperCase()}] ${message}`);
  };


  /**
   * 注意を促す通知を画面の隅に出す（3秒後に薄くなって消える）。
   *
   * @param msg 表示する文
   */
  const showWarningToast = (msg: string) => {
    if (warningToastTimerRef.current) clearTimeout(warningToastTimerRef.current);
    setWarningToastLeaving(false);
    setWarningToastMsg(msg);
    warningToastTimerRef.current = setTimeout(() => {
      setWarningToastLeaving(true);
      warningToastTimerRef.current = setTimeout(() => {
        setWarningToastMsg(null);
        setWarningToastLeaving(false);
      }, 320);
    }, 3000);
  };

  /**
   * 完了の通知を画面の隅に出す（2.5秒後に薄くなって消える）。
   *
   * @param msg 表示する文
   */
  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastLeaving(false);
    setSaveSuccessMsg(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastLeaving(true);
      // 薄くなる動きが終わってから消す
      toastTimerRef.current = setTimeout(() => {
        setSaveSuccessMsg(null);
        setToastLeaving(false);
      }, 320);
    }, 2500);
  };

  /** 居住地から、交通情報で取り上げる道路をサーバーに提案させる。 */
  const suggestTrafficAreas = async () => {
    const location = config?.show?.user_profile?.location;
    if (!location) { showWarningToast('先に居住地を入力してください。'); return; }
    setIsSuggestingTraffic(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/suggest-traffic-areas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location }),
      });
      if (!res.ok) {
        const body = await res.text();
        // HTML が返るのは、サーバーがこの API をまだ知らない（再起動していない）とき
        if (body.trim().startsWith('<')) throw new Error('サーバーを再起動してください（新しいAPIが認識されていません）');
        throw new Error(body);
      }
      const { areas } = await res.json() as { areas: string[] };
      // すでに入っているものは足さない
      const current = config.show.user_profile.traffic_areas ?? [];
      const merged  = [...new Set([...current, ...areas])];
      setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, traffic_areas: merged } } });
      showToast(`✅ ${areas.length} 件の道路を提案しました`);
    } catch (e: any) {
      showWarningToast(`AI 提案に失敗しました: ${e.message}`);
    } finally {
      setIsSuggestingTraffic(false);
    }
  };


  /**
   * サーバーのログを取得する。
   *
   * @param level 取り出す最低の重さ（debug / info / warn / error）
   */
  const fetchServerLogs = async (level = logMinLevel) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/logs?minLevel=${level}&limit=300`);
      if (res.ok) setServerLogs(await res.json());
    } catch { /* サーバーが起きていないときは黙って諦める */ }
  };

  // ログのタブを開いたときの取得と、自動更新の管理
  useEffect(() => {
    if (adminSubTab === 'logs') fetchServerLogs(logMinLevel);
  }, [adminSubTab, logMinLevel]);

  useEffect(() => {
    if (logAutoRefreshRef.current) clearInterval(logAutoRefreshRef.current);
    if (logAutoRefresh && adminSubTab === 'logs') {
      logAutoRefreshRef.current = setInterval(() => fetchServerLogs(logMinLevel), 10000);
    }
    return () => { if (logAutoRefreshRef.current) clearInterval(logAutoRefreshRef.current); };
  }, [logAutoRefresh, adminSubTab, logMinLevel]);

  /** リリースノートの本文を取得する。 */
  const fetchReleaseNotes = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/release-notes`);
      if (res.ok) {
        const { content } = await res.json();
        setReleaseNotesContent(content ?? '');
      }
    } catch { /* サーバーが起きていないときは黙って諦める */ }
  };

  // リリースノートのタブを開いたときに取得する
  useEffect(() => {
    if (adminSubTab === 'release_notes' && releaseNotesContent === '') fetchReleaseNotes();
  }, [adminSubTab]);

  /**
   * 会話履歴を取得する。
   *
   * @param agent 絞り込む相手。'all' なら全員
   */
  const fetchConversationHistory = async (agent = historyAgentFilter) => {
    try {
      const q = agent !== 'all' ? `&agent=${agent}` : '';
      const res = await fetch(`${SERVER_URL}/api/conversation-history?limit=500${q}`);
      if (res.ok) {
        const data = await res.json();
        setConvHistory(data); // 上が古く、下へ行くほど新しい
      }
    } catch { /* サーバーが起きていないときは黙って諦める */ }
  };

  // 会話履歴のタブを開いたときの取得と、自動更新の管理
  useEffect(() => {
    if (adminSubTab === 'history') fetchConversationHistory(historyAgentFilter);
  }, [adminSubTab, historyAgentFilter]);

  useEffect(() => {
    if (historyAutoRefreshRef.current) clearInterval(historyAutoRefreshRef.current);
    if (historyAutoRefresh && adminSubTab === 'history') {
      historyAutoRefreshRef.current = setInterval(() => fetchConversationHistory(historyAgentFilter), 10000);
    }
    return () => { if (historyAutoRefreshRef.current) clearInterval(historyAutoRefreshRef.current); };
  }, [historyAutoRefresh, adminSubTab, historyAgentFilter]);

  /**
   * エージェント日記を取得する。
   * ここは Live の番組設定の下にあるタブなので、チャンネルは live に固定する。
   * 他のチャンネルの日記は、それぞれの設定画面のタブが個別に取りに行く。
   *
   * @param agent 絞り込むエージェント。'all' なら全員
   */
  const fetchAgentDiary = async (agent = diaryAgentFilter) => {
    try {
      const q = agent !== 'all' ? `&agentKey=${agent}` : '';
      const res = await fetch(`${SERVER_URL}/api/agent-diary?channel=live&limit=300${q}`);
      if (res.ok) setDiaryEntries(await res.json()); // 新しい順
    } catch { /* サーバーが起きていないときは黙って諦める */ }
  };

  // 日記のタブを開いたときの取得と、自動更新の管理
  useEffect(() => {
    if (adminSubTab === 'live_diary') fetchAgentDiary(diaryAgentFilter);
  }, [adminSubTab, diaryAgentFilter]);

  useEffect(() => {
    if (diaryAutoRefreshRef.current) clearInterval(diaryAutoRefreshRef.current);
    if (diaryAutoRefresh && adminSubTab === 'live_diary') {
      diaryAutoRefreshRef.current = setInterval(() => fetchAgentDiary(diaryAgentFilter), 10000);
    }
    return () => { if (diaryAutoRefreshRef.current) clearInterval(diaryAutoRefreshRef.current); };
  }, [diaryAutoRefresh, adminSubTab, diaryAgentFilter]);

  // ─── 稼働レポート ───────────────────────────────────────────────
  const [reportSessions, setReportSessions] = useState<ReportSession[]>([]);
  const [reportTotal, setReportTotal]       = useState(0);
  const [reportDetail, setReportDetail]     = useState<ReportDetail | null>(null);
  const [reportSummary, setReportSummary]   = useState<ReportSummary | null>(null);
  const [reportCostBreakdown, setReportCostBreakdown] = useState<ReportCostBreakdown | null>(null);
  const [reportLoading, setReportLoading]   = useState(false);
  const [reportPage, setReportPage]         = useState(0);
  const [reportChannel, setReportChannel]   = useState('all');
  const todayStr = new Date().toLocaleDateString('sv-SE');
  const [reportFrom, setReportFrom]         = useState(todayStr);
  const [reportTo, setReportTo]             = useState(todayStr);
  const [reportEventFilter, setReportEventFilter] = useState('all');

  const fetchReport = async (page = 0, channel = reportChannel, from = reportFrom, to = reportTo) => {
    setReportLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(REPORT_PAGE_SIZE), offset: String(page * REPORT_PAGE_SIZE) });
      if (channel && channel !== 'all') params.set('channel', channel);
      if (from) params.set('from', String(new Date(from + 'T00:00:00').getTime()));
      if (to)   params.set('to',   String(new Date(to   + 'T23:59:59').getTime()));
      // 集計と費用の内訳も、一覧と同じチャンネル・期間で絞り込む
      const summaryParams = new URLSearchParams();
      if (channel && channel !== 'all') summaryParams.set('channel', channel);
      if (from) summaryParams.set('from', String(new Date(from + 'T00:00:00').getTime()));
      if (to)   summaryParams.set('to',   String(new Date(to   + 'T23:59:59').getTime()));
      const rangeQuery = summaryParams.toString() ? `?${summaryParams}` : '';
      const [sessRes, sumRes, costRes] = await Promise.all([
        fetch(`${SERVER_URL}/api/report/sessions?${params}`),
        fetch(`${SERVER_URL}/api/report/summary${rangeQuery}`),
        fetch(`${SERVER_URL}/api/report/cost-breakdown${rangeQuery}`),
      ]);
      if (sessRes.ok) { const d = await sessRes.json(); setReportSessions(d.rows); setReportTotal(d.total); }
      if (sumRes.ok)  { setReportSummary(await sumRes.json()); }
      if (costRes.ok) { setReportCostBreakdown(await costRes.json()); }
    } catch (e) { /* ignore */ }
    finally { setReportLoading(false); }
  };

  const fetchReportDetail = async (id: number) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/report/sessions/${id}`);
      if (res.ok) setReportDetail(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (adminSubTab === 'report') fetchReport(0, reportChannel, reportFrom, reportTo);
  }, [adminSubTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchRecordingStatus = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/recordings/status`);
      if (!res.ok) return;
      const d = await res.json();
      setRecordingActive(!!d.recording);
      if (d.recording) {
        setRecordingChannel(d.channel);
        setRecordingStartedAt(d.startedAt);
        setRecordingCurrentTarget(d.currentTarget ?? null);
      } else {
        setRecordingStartedAt(null);
        setRecordingCurrentTarget(null);
      }
    } catch { /* ignore */ }
  };

  const fetchRecordingHistory = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/recordings`);
      if (res.ok) setRecordingHistory(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (adminSubTab === 'recording') { fetchRecordingStatus(); fetchRecordingHistory(); }
  }, [adminSubTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 録音中の経過時間を1秒ごとに数える
  useEffect(() => {
    if (recordingActive && recordingStartedAt) {
      recordingTimerRef.current = setInterval(() => {
        setRecordingElapsedSec(Math.floor((Date.now() - recordingStartedAt) / 1000));
      }, 1000);
      return () => { if (recordingTimerRef.current) clearInterval(recordingTimerRef.current); };
    } else {
      setRecordingElapsedSec(0);
    }
  }, [recordingActive, recordingStartedAt]);

  // すべてのチャンネルを対象にしているときは、サーバー側が勝手に録音を始めたり終えたりする。
  // それを画面に映すため、待機中も含めて状態と履歴を見に行き続ける。
  useEffect(() => {
    if (recordingActive && recordingChannel === 'all') {
      const timer = setInterval(() => { fetchRecordingStatus(); fetchRecordingHistory(); }, 1000);
      return () => clearInterval(timer);
    }
  }, [recordingActive, recordingChannel]); // eslint-disable-line react-hooks/exhaustive-deps

  const startProgramRecording = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/recordings/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: recordingChannel }),
      });
      const d = await res.json();
      if (res.ok && d.ok !== false) {
        setRecordingActive(true);
        setRecordingStartedAt(d.startedAt);
        showToast(recordingChannel === 'all'
          ? '⏺ ALLモードを開始しました（視聴が始まったチャンネルを自動録音）'
          : `⏺ ${recordingChannel} チャンネルの録音を開始しました`);
      } else {
        showToast(d.error || '録音の開始に失敗しました');
      }
    } catch { showToast('録音の開始に失敗しました'); }
  };

  const stopProgramRecording = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/recordings/stop`, { method: 'POST' });
      const d = await res.json();
      setRecordingActive(false);
      setRecordingStartedAt(null);
      setRecordingCurrentTarget(null);
      if (d.ok && d.recording) {
        setRecordingHistory(prev => [d.recording, ...prev]);
        showToast('■ 録音を停止し、履歴に保存しました');
      } else {
        showToast(d.message || '録音を停止しました');
      }
    } catch { showToast('録音の停止に失敗しました'); }
  };

  const deleteRecording = async (id: string) => {
    try {
      await fetch(`${SERVER_URL}/api/recordings/${id}`, { method: 'DELETE' });
      setRecordingHistory(prev => prev.filter(r => r.id !== id));
      if (playingRecordingId === id) setPlayingRecordingId(null);
    } catch { showToast('削除に失敗しました'); }
  };

  const formatRecordingDuration = (sec: number) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  };

  const fetchSettings = async () => {
    try {
      const [configRes, credsRes, bgmRes, bgmAllRes, dictRes, financeWLRes, journalistWLRes, classicCfgRes, classicBgmRes, jazzCfgRes, jazzBgmRes, moodCfgRes, moodBgmRes, beatlesCfgRes, beatlesBgmRes, youCfgRes, answersCfgRes, answersBgmRes, answersHistoryRes] = await Promise.all([
        fetch(`${SERVER_URL}/api/config`),
        fetch(`${SERVER_URL}/api/credentials`),
        fetch(`${SERVER_URL}/api/bgm`),
        fetch(`${SERVER_URL}/api/bgm/all`),
        fetch(`${SERVER_URL}/api/tts-dict`),
        fetch(`${SERVER_URL}/api/finance-watchlist`),
        fetch(`${SERVER_URL}/api/journalist-watchlist`),
        fetch(`${SERVER_URL}/api/classic/config`),
        fetch(`${SERVER_URL}/api/classic/bgm/all`),
        fetch(`${SERVER_URL}/api/jazz/config`),
        fetch(`${SERVER_URL}/api/jazz/bgm/all`),
        fetch(`${SERVER_URL}/api/mood/config`),
        fetch(`${SERVER_URL}/api/mood/bgm/all`),
        fetch(`${SERVER_URL}/api/beatles/config`),
        fetch(`${SERVER_URL}/api/beatles/bgm/all`),
        fetch(`${SERVER_URL}/api/24you/config`),
        fetch(`${SERVER_URL}/api/the_answers/config`),
        fetch(`${SERVER_URL}/api/the_answers/bgm/all`),
        fetch(`${SERVER_URL}/api/the_answers/archive`),
      ]);
      const liveData = await configRes.json(); setConfig(liveData); if (liveData.show?.tts_test_text) setLiveTtsTestText(liveData.show.tts_test_text);
      setCreds(await credsRes.json());
      const bgmData = await bgmRes.json();
      setBgmFiles(bgmData.files || []);
      setCurrentBgmFile(bgmData.current || null);
      if (bgmAllRes.ok) setBgmAll(await bgmAllRes.json());
      const dictData: TtsDictEntry[] = dictRes.ok ? await dictRes.json() : [];
      setTtsDict(dictData);
      if (financeWLRes.ok) setFinanceWL(await financeWLRes.json());
      if (journalistWLRes.ok) setJournalistWL(await journalistWLRes.json());
      if (classicCfgRes.ok) { const d = await classicCfgRes.json(); setClassicConfig(d); if (d.program?.tts_test_text) setClassicTtsTestText(d.program.tts_test_text); }
      if (classicBgmRes.ok) setClassicBgmAll(await classicBgmRes.json());
      if (jazzCfgRes.ok) { const d = await jazzCfgRes.json(); setJazzConfig(d); if (d.program?.tts_test_text) setJazzTtsTestText(d.program.tts_test_text); }
      if (jazzBgmRes.ok) setJazzBgmAll(await jazzBgmRes.json());
      if (moodCfgRes.ok) { const d = await moodCfgRes.json(); setMoodConfig(d); if (d.program?.tts_test_text) setMoodTtsTestText(d.program.tts_test_text); }
      if (moodBgmRes.ok) setMoodBgmAll(await moodBgmRes.json());
      if (beatlesCfgRes.ok) { const d = await beatlesCfgRes.json(); setBeatlesConfig(d); if (d.program?.tts_test_text) setBeatlesTtsTestText(d.program.tts_test_text); }
      if (beatlesBgmRes.ok) setBeatlesBgmAll(await beatlesBgmRes.json());
      if (youCfgRes.ok) setYouConfig(await youCfgRes.json());
      if (answersCfgRes.ok) { const d = await answersCfgRes.json(); setTheAnswersConfig(d); if (d.program?.tts_test_text) setTheAnswersTtsTestText(d.program.tts_test_text); }
      if (answersBgmRes.ok) setTheAnswersBgmAll(await answersBgmRes.json());
      if (answersHistoryRes.ok) setTheAnswersHistory(await answersHistoryRes.json());
      addLog('info', `サーバー設定情報を取得しました。辞書: ${dictData.length}件`);
    } catch (e) {
      console.error('Failed to fetch settings:', e);
      addLog('err', 'サーバー設定の取得に失敗しました。サーバーが起動しているか確認してください。');
    }
  };

  /** 読み方の辞書を保存する。 */
  const saveTtsDict = async () => {
    setDictSaving(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/tts-dict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsDict),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setDictEditing(null);
      showToast(`✅ 発声辞書を保存しました（${ttsDict.length}件）`);
      addLog('info', `[辞書] 保存完了: ${ttsDict.length}件`);
    } catch (e: any) {
      addLog('err', `[辞書] 保存失敗: ${e.message}`);
    } finally {
      setDictSaving(false);
    }
  };

  /**
   * 辞書を使った書き換えを、画面の中だけで試す。
   *
   * @param input 試したい文
   * @returns 辞書を当てた後の文
   */
  const applyDictPreview = (input: string): string => {
    let result = input;
    for (const entry of ttsDict) {
      if (!entry.enabled) continue;
      try {
        const re = new RegExp(entry.pattern, entry.flags || 'g');
        result = result.replace(re, entry.replacement);
      } catch { /* 書き方が誤っている行は飛ばす */ }
    }
    return result;
  };

  /** 辞書に新しい行を足す。 */
  const addDictEntry = () => {
    if (!dictNewEntry.pattern.trim() || !dictNewEntry.replacement.trim()) return;
    try { new RegExp(dictNewEntry.pattern, dictNewEntry.flags || 'g'); }
    catch (e: any) { addLog('err', `[辞書] 不正な正規表現: ${e.message}`); return; }
    const maxId = ttsDict.reduce((m, e) => Math.max(m, e.id), 0);
    const newEntry: TtsDictEntry = {
      id: maxId + 1,
      pattern: dictNewEntry.pattern.trim(),
      flags: dictNewEntry.flags.trim() || 'g',
      replacement: dictNewEntry.replacement,
      note: dictNewEntry.note.trim(),
      enabled: true,
    };
    setTtsDict(prev => [...prev, newEntry]);
    setDictNewEntry(EMPTY_DICT_ENTRY);
  };

  const playLocal = (url: string) => {
    if (localAudioRef.current) { localAudioRef.current.pause(); localAudioRef.current = null; }
    if (localPlayingUrl === url) { setLocalPlayingUrl(null); return; }
    const audio = new Audio(url);
    audio.onended = () => setLocalPlayingUrl(null);
    audio.play().catch(() => {});
    localAudioRef.current = audio;
    setLocalPlayingUrl(url);
  };

  // ── 金融の見守り一覧（保存・切り替え・銘柄の増減） ───────────────
  const saveFinanceWL = async (updated: FinanceWatchlist) => {
    try {
      await fetch(`${SERVER_URL}/api/finance-watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      setFinanceWL(updated);
      showToast('💹 金融設定を保存しました');
    } catch { showToast('保存に失敗しました'); }
  };

  const toggleWLItem = (section: keyof FinanceWatchlist, symbol: string) => {
    const updated = {
      ...financeWL,
      [section]: financeWL[section].map(i =>
        i.symbol === symbol ? { ...i, enabled: !i.enabled } : i
      ),
    };
    saveFinanceWL(updated);
  };

  const addStock = () => {
    if (!newStock.symbol.trim() || !newStock.name.trim()) return;
    const updated = {
      ...financeWL,
      stocks: [...financeWL.stocks, {
        symbol: newStock.symbol.trim().toUpperCase(),
        name: newStock.name.trim(),
        unit: newStock.unit,
        type: 'stock',
        dec: newStock.dec,
        enabled: true,
      }],
    };
    saveFinanceWL(updated);
    setNewStock({ symbol: '', name: '', unit: 'ドル', dec: 1 });
  };

  const removeStock = (symbol: string) => {
    const updated = { ...financeWL, stocks: financeWL.stocks.filter(s => s.symbol !== symbol) };
    saveFinanceWL(updated);
  };

  // ATTENTION: 保有資産は投資信託に銘柄記号が無いため、名前で見分けること
  const togglePersonalHolding = (name: string) => {
    const updated = {
      ...financeWL,
      personal_holdings: financeWL.personal_holdings.map(i =>
        i.name === name ? { ...i, enabled: !i.enabled } : i
      ),
    };
    saveFinanceWL(updated);
  };

  const saveJournalistWL = async (updated: JournalistWatchlist) => {
    try {
      await fetch(`${SERVER_URL}/api/journalist-watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      setJournalistWL(updated);
      showToast('🕵️ ジャーナリストウォッチリストを保存しました');
    } catch { showToast('保存に失敗しました'); }
  };

  const getJournalistDraft = (section: string) => journalistDrafts[section] ?? { name: '', x_handle: '' };
  const setJournalistDraft = (section: string, patch: Partial<{ name: string; x_handle: string }>) =>
    setJournalistDrafts(prev => ({ ...prev, [section]: { ...getJournalistDraft(section), ...patch } }));

  const addJournalistItem = (section: keyof JournalistWatchlist) => {
    const draft = getJournalistDraft(section);
    if (!draft.name.trim()) return;
    const updated = {
      ...journalistWL,
      [section]: [...journalistWL[section], { name: draft.name.trim(), x_handle: draft.x_handle.trim() || null }],
    };
    saveJournalistWL(updated);
    setJournalistDraft(section, { name: '', x_handle: '' });
  };

  const removeJournalistItem = (section: keyof JournalistWatchlist, name: string) => {
    const updated = { ...journalistWL, [section]: journalistWL[section].filter(i => i.name !== name) };
    saveJournalistWL(updated);
  };

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        showToast('✅ 番組・エージェント設定を保存しました');
        addLog('info', '番組・エージェント設定を更新しました。');
      }
    } catch (e) {
      addLog('err', '設定の保存に失敗しました。');
    }
  };

  /**
   * チャンネルの設定を保存する。宛先と中身と表示名だけが違うので、6チャンネル分をこれ1本で扱う。
   *
   * @param e フォームの送信イベント
   * @param endpoint 保存先のパス
   * @param cfg 保存する設定
   * @param label 通知に出すチャンネル名
   */
  const saveChannelConfig = async (e: React.FormEvent, endpoint: string, cfg: unknown, label: string) => {
    e.preventDefault();
    if (!cfg) return;
    try {
      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (res.ok) {
        showToast(`✅ ${label} チャンネル設定を保存しました`);
        addLog('info', `${label} チャンネル設定を更新しました。`);
      }
    } catch (e) {
      addLog('err', `${label} 設定の保存に失敗しました。`);
    }
  };

  const saveClassicConfig = (e: React.FormEvent) => saveChannelConfig(e, '/api/classic/config', classicConfig, 'Classic');
  const saveJazzConfig = (e: React.FormEvent) => saveChannelConfig(e, '/api/jazz/config', jazzConfig, 'Jazz');
  const saveMoodConfig = (e: React.FormEvent) => saveChannelConfig(e, '/api/mood/config', moodConfig, 'Mood');
  const saveBeatlesConfig = (e: React.FormEvent) => saveChannelConfig(e, '/api/beatles/config', beatlesConfig, 'Beatles');
  const saveYouConfig = (e: React.FormEvent) => saveChannelConfig(e, '/api/24you/config', youConfig, '24/You');
  const saveTheAnswersConfig = (e: React.FormEvent) => saveChannelConfig(e, '/api/the_answers/config', theAnswersConfig, 'The Answers');

  /**
   * エージェントの声を試聴する。音声にかかわる項目の形は全チャンネルで同じなので、これ1本で扱う。
   *
   * @param endpoint 試聴を依頼するパス
   * @param agentKey 対象のエージェントのキー
   * @param agent そのエージェントの音声設定
   * @param testText 読ませる文
   * @param label ログに出すチャンネル名
   * @param defaultVoice 声が未設定のときに使う声
   */
  const playChannelTtsTest = async (
    endpoint: string,
    agentKey: string,
    agent: TtsTestableAgent,
    testText: string,
    label: string,
    defaultVoice: string,
  ) => {
    setTestingAgent(agentKey);
    try {
      const body: Record<string, unknown> = {
        text: testText,
        gemini_voice:      agent.gemini_voice      ?? defaultVoice,
        gemini_language:   agent.gemini_language    ?? '',
        tts_profile_title: agent.tts_profile_title  ?? '',
        tts_scene:         agent.tts_scene          ?? '',
        tts_style:         agent.tts_style          ?? agent.gemini_instruction ?? '',
        tts_accent:        agent.tts_accent         ?? '',
        tts_pacing:        agent.tts_pacing         ?? '',
        tts_context:       agent.tts_context        ?? '',
      };
      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
      addLog('tts', `[${label} TTS Test] ${agentKey} 再生中`);
    } catch (e: any) {
      addLog('err', `[${label} TTS Test] ${agentKey}: ${e.message}`);
    } finally {
      setTestingAgent(null);
    }
  };

  const playJazzTtsTest = (agentKey: string, agent: ChannelAgentShape) =>
    playChannelTtsTest('/api/jazz/tts-test', agentKey, agent, jazzTtsTestText, 'Jazz', 'Charon');
  const playMoodTtsTest = (agentKey: string, agent: ChannelAgentShape) =>
    playChannelTtsTest('/api/mood/tts-test', agentKey, agent, moodTtsTestText, 'Mood', 'Kore');
  const playTheAnswersTtsTest = (agentKey: string, agent: TheAnswersDirectorAgent) =>
    playChannelTtsTest('/api/the_answers/tts-test', agentKey, agent, theAnswersTtsTestText, 'The Answers', 'Kore');
  const playBeatlesTtsTest = (agentKey: string, agent: ChannelAgentShape) =>
    playChannelTtsTest('/api/beatles/tts-test', agentKey, agent, beatlesTtsTestText, 'Beatles', 'Kore');

  const saveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creds) return;
    try {
      const res = await fetch(`${SERVER_URL}/api/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds)
      });
      if (res.ok) {
        showToast('✅ アクセスキー・接続設定を安全に保存しました');
        addLog('info', 'API鍵・認証接続情報を更新しました。');
        fetchSettings(); // 読み直して、伏せ字にした表示へ戻す
      }
    } catch (e) {
      addLog('err', '鍵設定の保存に失敗しました。');
    }
  };



  const playClassicTtsTest = (agentKey: string, agent: ChannelAgentShape) =>
    playChannelTtsTest('/api/classic/tts-test', agentKey, agent, classicTtsTestText, 'Classic', 'Kore');
  const playLiveTtsTest = (agentKey: string, agent: AgentConfig) =>
    playChannelTtsTest('/api/live/tts-test', agentKey, agent, liveTtsTestText, 'Live', 'Kore');

  const formatFileSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  };

  /**
   * エージェントのキーから、一覧に出す絵文字を選ぶ。
   *
   * @param key エージェントのキー
   * @returns 絵文字1文字
   */
  const getAgentEmoji = (key: string) => {
    switch (key) {
      case 'director': return '🎬';
      case 'caster': return '🎙️';
      case 'assistant': return '💬';
      case 'weather':     return '☀️';
      case 'traffic':     return '🚗';
      case 'news':        return '📰';
      case 'finance':     return '💹';
      case 'commentator': return '🎓';
      case 'journalist':    return '🕵️';
      case 'music_dj':      return '🎵';
      case 'world_report':  return '🌍';
      case 'life_advisor':  return '💚';
      case 'secretary':     return '👩‍💼';
      case 'comedian':      return '🎤';
      case 'doctor':        return '🩺';
      case 'marketer':      return '💡';
      default: return '🤖';
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* メインコンテンツ */}
      <main className="flex-1 flex flex-col items-center px-4 pb-8 pt-6">

        {/* 完了の通知（画面の右下に出す） */}
        {saveSuccessMsg && (
          <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3
            bg-gray-900/95 border border-green-500/60 rounded-2xl px-5 py-4
            shadow-2xl shadow-green-900/30 backdrop-blur-md
            ${toastLeaving ? 'toast-leave' : 'toast-enter'}`}
          >
            <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0" />
            <span className="text-sm font-medium text-green-300">{saveSuccessMsg}</span>
          </div>
        )}

        {/* 注意を促す通知（完了の通知の上に出す） */}
        {warningToastMsg && (
          <div className={`fixed bottom-24 right-6 z-50 flex items-start gap-3
            bg-gray-900/95 border border-orange-500/60 rounded-2xl px-5 py-4
            shadow-2xl shadow-orange-900/30 backdrop-blur-md max-w-xs
            ${warningToastLeaving ? 'toast-leave' : 'toast-enter'}`}
          >
            <AlertCircle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
            <span className="text-sm font-medium text-orange-300 whitespace-pre-line">{warningToastMsg}</span>
          </div>
        )}


        {/* メニューと本文を横に並べ、全体を中央へ寄せる */}
        <div className="flex-1 w-full max-w-7xl flex gap-6">

        {/* 左サイドバーナビゲーション */}
        <aside className="w-64 shrink-0 pr-4 pt-6">
          <nav className="glass-panel py-3 px-2 flex flex-col sticky top-4" style={{ height: 'calc(100vh - 40px)' }}>
            {/* ロゴ */}
            <div className="px-4 py-3 border-b border-glass/50 flex justify-center" style={{ marginBottom: '8px' }}>
              <img src="/Bland_logo.png" alt="AI Radio" style={{ width: '100px', height: 'auto' }} draggable={false} />
            </div>
            {/* メニューをすべて開く・すべて閉じるボタン */}
            <div className="flex justify-end gap-1 px-2 pb-3">
              <button
                type="button"
                title="全て開く"
                onClick={() => setOpenNavGroups(new Set(['listener', 'show', 'show_classic', 'show_jazz', 'show_mood', 'show_beatles', 'show_24you', 'show_the_answers', 'my_secretary', 'system']))}
                className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-white/6 transition-colors"
              ><ChevronsDown className="w-4 h-4" /></button>
              <button
                type="button"
                title="全て閉じる"
                onClick={() => setOpenNavGroups(new Set())}
                className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-white/6 transition-colors"
              ><ChevronsUp className="w-4 h-4" /></button>
            </div>
            {/* メニュー本体。画面に収まらないときは、ここだけが動く（ロゴとボタンは動かない） */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            {([
              {
                key: 'listener', label: '👤 リスナープロファイル',
                items: [
                  { key: 'listener_info' as const,  label: 'リスナー情報' },
                  { key: 'music_profile' as const,  label: '音楽プロファイル' },
                  { key: 'traffic_area' as const,   label: '交通情報エリア' },
                  { key: 'temp_stay' as const,      label: '臨時滞在地' },
                  { key: 'special_dates' as const,  label: '特別な日' },
                  { key: 'finance' as const,        label: '金融情報ウォッチリスト' },
                ],
              },
              {
                key: 'show', label: '📻 番組設定（Live）',
                items: [
                  { key: 'show_settings' as const, label: '番組設定' },
                  { key: 'bgm' as const,           label: 'BGM管理' },
                  { key: 'agents' as const,        label: 'エージェント設定' },
                  { key: 'journalist_watchlist' as const, label: 'ジャーナリストウォッチリスト' },
                  { key: 'live_diary' as const,    label: 'エージェント日記' },
                ],
              },
              {
                key: 'show_classic', label: '🎼 番組設定（Classic）',
                items: [
                  { key: 'classic_show_settings' as const, label: '番組設定' },
                  { key: 'classic_agents' as const,        label: 'エージェント設定' },
                  { key: 'classic_bgm' as const,           label: 'BGM管理' },
                  { key: 'classic_diary' as const,         label: 'エージェント日記' },
                ],
              },
              {
                key: 'show_jazz', label: '🎷 番組設定（Jazz）',
                items: [
                  { key: 'jazz_show_settings' as const, label: '番組設定' },
                  { key: 'jazz_agents' as const,        label: 'エージェント設定' },
                  { key: 'jazz_bgm' as const,           label: 'BGM管理' },
                  { key: 'jazz_diary' as const,         label: 'エージェント日記' },
                ],
              },
              {
                key: 'show_mood', label: '🌙 番組設定（Mood）',
                items: [
                  { key: 'mood_show_settings' as const, label: '番組設定' },
                  { key: 'mood_agents' as const,        label: 'エージェント設定' },
                  { key: 'mood_bgm' as const,           label: 'BGM管理' },
                  { key: 'mood_diary' as const,         label: 'エージェント日記' },
                ],
              },
              {
                key: 'show_beatles', label: '🪲 番組設定（Beatles）',
                items: [
                  { key: 'beatles_show_settings' as const, label: '番組設定' },
                  { key: 'beatles_agents' as const,        label: 'エージェント設定' },
                  { key: 'beatles_bgm' as const,           label: 'BGM管理' },
                  { key: 'beatles_diary' as const,         label: 'エージェント日記' },
                ],
              },
              {
                key: 'show_24you', label: '🔀 番組設定（24/You）',
                items: [
                  { key: 'you_show_settings' as const, label: '番組設定' },
                ],
              },
              {
                key: 'show_the_answers', label: '🗣️ 番組設定（The Answers）',
                items: [
                  { key: 'answers_show_settings' as const, label: '番組設定' },
                  { key: 'answers_director' as const,       label: 'ディレクタ設定' },
                  { key: 'answers_panelists' as const,      label: 'パネリスト裏プロファイル' },
                  { key: 'answers_bgm' as const,            label: 'BGM管理' },
                  { key: 'answers_history' as const,        label: 'アーカイブ' },
                  { key: 'answers_diary' as const,          label: 'エージェント日記' },
                ],
              },
              {
                key: 'my_secretary', label: '👩‍💼 My Secretary',
                items: [
                  { key: 'secretary' as const, label: 'エージェント設定' },
                  { key: 'secretary_learning' as const, label: '学習内容' },
                  { key: 'secretary_diary' as const, label: 'エージェント日記' },
                  { key: 'secretary_loop' as const, label: '自律ループ設定' },
                  { key: 'secretary_obsidian' as const, label: 'Obsidian連携設定' },
                  { key: 'secretary_presentation' as const, label: 'スライドのテンプレート' },
                  { key: 'secretary_line' as const, label: 'LINE連携設定' },
                ],
              },
              {
                key: 'system', label: '⚙️ システム管理',
                items: [
                  { key: 'dict' as const,        label: '発声辞書' },
                  { key: 'administrator' as const, label: 'AI管理者設定' },
                  { key: 'shortcuts' as const,   label: 'ショートカットキー' },
                  { key: 'credentials' as const, label: 'システム接続設定' },
                  { key: 'logs' as const,        label: 'ログ' },
                  { key: 'history' as const,     label: '会話履歴' },
                  { key: 'recording' as const,   label: '番組録音' },
                  { key: 'report' as const,      label: '稼働レポート' },
                  { key: 'release_notes' as const, label: 'リリースノート' },
                ],
              },
            ]).map(({ key: groupKey, label: groupLabel, items }, groupIdx) => {
              const isOpen = openNavGroups.has(groupKey);
              return (
                <div key={groupKey} className={groupIdx > 0 ? 'mt-3' : ''}>
                  {/* まとまりの見出し。矢印を右に置いて、文字の始まりを左でそろえる */}
                  <button
                    onClick={() => setOpenNavGroups(prev => {
                      const next = new Set(prev);
                      next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey);
                      return next;
                    })}
                    className="w-full flex items-center justify-between pl-2 pr-2 py-2 rounded-lg text-sm font-bold text-gray-100 hover:text-white hover:bg-white/6 transition-colors select-none"
                  >
                    <span className="truncate">{groupLabel}</span>
                    <ChevronDown
                      className="w-4 h-4 text-gray-500 shrink-0 transition-transform duration-150"
                      style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                    />
                  </button>
                  {/* 中の項目。左を十分に下げて親との関係が見えるようにする */}
                  {isOpen && (
                    <div
                      className="flex flex-col gap-0.5 pb-1 pt-0.5"
                      style={{ marginLeft: '16px', paddingLeft: '10px', borderLeft: '2px solid rgba(255,255,255,0.12)' }}
                    >
                      {items.map(({ key, label }) => (
                        <button
                          key={key}
                          onClick={() => setAdminSubTab(key)}
                          className={`w-full text-left py-2 px-3 rounded-md text-sm transition-colors
                            ${adminSubTab === key
                              ? 'bg-gradient-to-r from-purple-600/80 to-cyan-600/60 text-white font-medium shadow-sm'
                              : 'text-gray-400 hover:text-gray-200 hover:bg-white/6'
                            }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </nav>
        </aside>

        {/* 右コンテンツエリア */}
          <div className="flex-1 flex flex-col gap-6 min-w-0" style={{ paddingTop: '32px' }}>

            {/* ── ここから各チャンネルのパネル。開いているタブのものだけが中身を描く ── */}
            <LivePanel
              adminSubTab={adminSubTab}
              config={config}
              setConfig={setConfig}
              saveConfig={saveConfig}
              musicGenresText={musicGenresText}
              setMusicGenresText={setMusicGenresText}
              newArtistInput={newArtistInput}
              setNewArtistInput={setNewArtistInput}
              trafficAreaInput={trafficAreaInput}
              setTrafficAreaInput={setTrafficAreaInput}
              suggestTrafficAreas={suggestTrafficAreas}
              isSuggestingTraffic={isSuggestingTraffic}
              newTempStay={newTempStay}
              setNewTempStay={setNewTempStay}
              editingTempStay={editingTempStay}
              setEditingTempStay={setEditingTempStay}
              newSpecialDate={newSpecialDate}
              setNewSpecialDate={setNewSpecialDate}
              editingSpecialIdx={editingSpecialIdx}
              setEditingSpecialIdx={setEditingSpecialIdx}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              liveTtsTestText={liveTtsTestText}
              setLiveTtsTestText={setLiveTtsTestText}
              playLiveTtsTest={playLiveTtsTest}
              testingAgent={testingAgent}
              creds={creds}
              financeWL={financeWL}
              toggleWLItem={toggleWLItem}
              removeStock={removeStock}
              newStock={newStock}
              setNewStock={setNewStock}
              addStock={addStock}
              togglePersonalHolding={togglePersonalHolding}
              journalistWL={journalistWL}
              getJournalistDraft={getJournalistDraft}
              setJournalistDraft={setJournalistDraft}
              addJournalistItem={addJournalistItem}
              removeJournalistItem={removeJournalistItem}
              openJournalistSections={openJournalistSections}
              toggleJournalistSection={toggleJournalistSection}
              fetchSettings={fetchSettings}
              localPlayingUrl={localPlayingUrl}
              currentBgmFile={currentBgmFile}
              bgmAll={bgmAll}
              bgmFiles={bgmFiles}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={SERVER_URL}
              diaryEntries={diaryEntries}
              diaryAgentFilter={diaryAgentFilter}
              setDiaryAgentFilter={setDiaryAgentFilter}
              diaryAutoRefresh={diaryAutoRefresh}
              setDiaryAutoRefresh={setDiaryAutoRefresh}
              fetchAgentDiary={fetchAgentDiary}
            />

            {/* ── 発声辞書 ──────────────────────────────────────── */}
            <SystemPanel
              adminSubTab={adminSubTab}
              serverUrl={SERVER_URL}
              config={config}
              setConfig={setConfig}
              saveConfig={saveConfig}
              creds={creds}
              setCreds={setCreds}
              saveCredentials={saveCredentials}
              openCredsSections={openCredsSections}
              toggleCredsSection={toggleCredsSection}
              testingAgent={testingAgent}
              playLiveTtsTest={playLiveTtsTest}
              ttsDict={ttsDict}
              setTtsDict={setTtsDict}
              dictEditing={dictEditing}
              setDictEditing={setDictEditing}
              dictSaving={dictSaving}
              dictTestInput={dictTestInput}
              setDictTestInput={setDictTestInput}
              dictPreviewOpen={dictPreviewOpen}
              setDictPreviewOpen={setDictPreviewOpen}
              dictNewEntry={dictNewEntry}
              setDictNewEntry={setDictNewEntry}
              applyDictPreview={applyDictPreview}
              addDictEntry={addDictEntry}
              saveTtsDict={saveTtsDict}
              serverLogs={serverLogs}
              logMinLevel={logMinLevel}
              setLogMinLevel={setLogMinLevel}
              logAutoRefresh={logAutoRefresh}
              setLogAutoRefresh={setLogAutoRefresh}
              fetchServerLogs={fetchServerLogs}
              releaseNotesContent={releaseNotesContent}
              fetchReleaseNotes={fetchReleaseNotes}
              recordingChannel={recordingChannel}
              setRecordingChannel={setRecordingChannel}
              recordingActive={recordingActive}
              startProgramRecording={startProgramRecording}
              stopProgramRecording={stopProgramRecording}
              recordingElapsedSec={recordingElapsedSec}
              recordingCurrentTarget={recordingCurrentTarget}
              recordingHistory={recordingHistory}
              fetchRecordingHistory={fetchRecordingHistory}
              formatRecordingDuration={formatRecordingDuration}
              playingRecordingId={playingRecordingId}
              setPlayingRecordingId={setPlayingRecordingId}
              deleteRecording={deleteRecording}
              formatFileSize={formatFileSize}
              reportDetail={reportDetail}
              setReportDetail={setReportDetail}
              reportEventFilter={reportEventFilter}
              setReportEventFilter={setReportEventFilter}
              reportSummary={reportSummary}
              reportCostBreakdown={reportCostBreakdown}
              reportSessions={reportSessions}
              reportTotal={reportTotal}
              reportLoading={reportLoading}
              reportPage={reportPage}
              setReportPage={setReportPage}
              reportChannel={reportChannel}
              setReportChannel={setReportChannel}
              reportFrom={reportFrom}
              setReportFrom={setReportFrom}
              reportTo={reportTo}
              setReportTo={setReportTo}
              fetchReport={fetchReport}
              fetchReportDetail={fetchReportDetail}
              convHistory={convHistory}
              setConvHistory={setConvHistory}
              historyAgentFilter={historyAgentFilter}
              setHistoryAgentFilter={setHistoryAgentFilter}
              historyAutoRefresh={historyAutoRefresh}
              setHistoryAutoRefresh={setHistoryAutoRefresh}
              fetchConversationHistory={fetchConversationHistory}
              convHistoryEndRef={convHistoryEndRef}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
            />

            {/* ── Classic チャンネル設定 ─────────────────────────────── */}
            <ClassicPanel
              adminSubTab={adminSubTab}
              config={classicConfig}
              setConfig={setClassicConfig}
              bgmAll={classicBgmAll}
              ttsTestText={classicTtsTestText}
              setTtsTestText={setClassicTtsTestText}
              onSave={saveClassicConfig}
              onTest={playClassicTtsTest}
              onRefreshBgm={fetchSettings}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              testingAgent={testingAgent}
              creds={creds}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={SERVER_URL}
            />

            <JazzPanel
              adminSubTab={adminSubTab}
              config={jazzConfig}
              setConfig={setJazzConfig}
              bgmAll={jazzBgmAll}
              ttsTestText={jazzTtsTestText}
              setTtsTestText={setJazzTtsTestText}
              onSave={saveJazzConfig}
              onTest={playJazzTtsTest}
              onRefreshBgm={fetchSettings}
              onRefreshSettings={fetchSettings}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              testingAgent={testingAgent}
              creds={creds}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={SERVER_URL}
            />

            <MoodPanel
              adminSubTab={adminSubTab}
              config={moodConfig}
              setConfig={setMoodConfig}
              bgmAll={moodBgmAll}
              ttsTestText={moodTtsTestText}
              setTtsTestText={setMoodTtsTestText}
              onSave={saveMoodConfig}
              onTest={playMoodTtsTest}
              onRefreshBgm={fetchSettings}
              onRefreshSettings={fetchSettings}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              testingAgent={testingAgent}
              creds={creds}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={SERVER_URL}
            />

            <BeatlesPanel
              adminSubTab={adminSubTab}
              config={beatlesConfig}
              setConfig={setBeatlesConfig}
              bgmAll={beatlesBgmAll}
              ttsTestText={beatlesTtsTestText}
              setTtsTestText={setBeatlesTtsTestText}
              onSave={saveBeatlesConfig}
              onTest={playBeatlesTtsTest}
              onRefreshBgm={fetchSettings}
              onRefreshSettings={fetchSettings}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              testingAgent={testingAgent}
              creds={creds}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={SERVER_URL}
            />

            {/* ── 24/You チャンネル管理 ─────────────────────────────────── */}
            <TwentyFourYouPanel
              adminSubTab={adminSubTab}
              config={youConfig}
              setConfig={setYouConfig}
              onSave={saveYouConfig}
              onRefreshSettings={fetchSettings}
            />

            <TheAnswersPanel
              adminSubTab={adminSubTab}
              theAnswersConfig={theAnswersConfig}
              setTheAnswersConfig={setTheAnswersConfig}
              onRefreshSettings={fetchSettings}
              onSave={saveTheAnswersConfig}
              ttsTestText={theAnswersTtsTestText}
              setTtsTestText={setTheAnswersTtsTestText}
              onTest={(role, agent) => playTheAnswersTtsTest(role, agent)}
              avatarErrors={avatarErrors}
              onAvatarError={onAvatarError}
              getAgentEmoji={getAgentEmoji}
              openAgents={openAgents}
              setOpenAgents={setOpenAgents}
              testingAgent={testingAgent}
              creds={creds}
              config={config}
              classicConfig={classicConfig}
              jazzConfig={jazzConfig}
              moodConfig={moodConfig}
              beatlesConfig={beatlesConfig}
              openAnswersPanelistSections={openAnswersPanelistSections}
              toggleAnswersPanelistSection={toggleAnswersPanelistSection}
              theAnswersBgmAll={theAnswersBgmAll}
              localPlayingUrl={localPlayingUrl}
              playLocal={playLocal}
              formatFileSize={formatFileSize}
              serverUrl={SERVER_URL}
              theAnswersHistory={theAnswersHistory}
              answersArchiveFilterKey={answersArchiveFilterKey}
              setAnswersArchiveFilterKey={setAnswersArchiveFilterKey}
              answersArchivePage={answersArchivePage}
              setAnswersArchivePage={setAnswersArchivePage}
              openArchiveEntries={openArchiveEntries}
              toggleArchiveEntry={toggleArchiveEntry}
              openArchiveCards={openArchiveCards}
              toggleArchiveCard={toggleArchiveCard}
              deleteArchiveEntry={deleteArchiveEntry}
              deletingArchiveIds={deletingArchiveIds}
              summarizingIds={summarizingIds}
              openSummaryEntries={openSummaryEntries}
              fetchArchiveSummary={fetchArchiveSummary}
            />

            {/* 設定を読み込むまでの表示。自前でデータを取るタブは除く */}
            {(adminSubTab !== 'bgm' && adminSubTab !== 'logs' && adminSubTab !== 'history' && adminSubTab !== 'live_diary' && adminSubTab !== 'classic_diary' && adminSubTab !== 'jazz_diary' && adminSubTab !== 'mood_diary' && adminSubTab !== 'beatles_diary' && adminSubTab !== 'answers_diary' && adminSubTab !== 'dict' && adminSubTab !== 'report' && adminSubTab !== 'secretary_learning' && adminSubTab !== 'secretary_diary') && !config && (
              <div className="text-center text-gray-500 py-12">ロード中...</div>
            )}

          </div>

        </div>{/* /max-w-7xl wrapper */}

      </main>

      {/* フッター */}
      <footer className="py-6 text-center text-xs text-gray-600 border-t border-glass/40 m-4 mt-auto">
        <p>© 2026 AI-RADIO Station. Designed for fully personalized autonomous broadcast tests.</p>
      </footer>
    </div>
  );
}
