/**
 * @file リスナー向けの再生画面（全チャンネル共通のルート）
 *
 * ウェルカム画面でのチャンネル選択から、WebSocket での音声受信・再生、画面表示（字幕・翻訳
 * テロップ・ティッカー・地図や天気図のパネル・スケジュール）、リクエストの送信までを受け持つ。
 *
 * 音声は WebSocket から 24bit ステレオの生 PCM で届き、AudioWorklet のリングバッファ
 * （player/audioWorklet.ts）へ流す。楽曲は Spotify Web Playback SDK 側で鳴らし、
 * このファイルはその再生の開始・終了とデバイス登録の面倒を見る。
 *
 * チャンネルごとの状態（リクエスト・再生履歴・討論番組の進行など）は player/hooks/ の
 * 各フックへ、繰り返し使う表示は player/components/ へ分けてある。My Secretary だけは
 * 他チャンネルの配信の流れを一切使わず、useSecretaryLive による1対1の会話になる。
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

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Square, Volume2, VolumeX, Signal, Moon, X, Clock, Terminal, Bookmark, BookmarkCheck } from 'lucide-react';
import type {
  FullConfig, CycleMonitor, CornerKey,
  TickerData, InfoViewData,
  ClassicTrack, JazzTrack, MoodTrack, BeatlesTrack, TwentyFourYouTrack, EarthquakeAlert,
} from './player/types';
import { DEFAULT_SHORTCUTS } from './player/types';
import { PCM_RING_WORKLET } from './player/audioWorklet';
import {
  CORNER_ICONS, CORNER_COLORS, CORNER_LABELS, CORNER_SHORTCUT_ACTIONS, AGENT_GLOW,
  CHANNELS, CHANNEL_LOGO_FILE,
} from './player/constants';
import type { ChannelId } from './player/constants';
import {
  formatShortcut, getAgentEmoji, parseAgentName,
  _loadPrefs, _savePrefs, postListenerRequest, applyListUpdate,
} from './player/utils';
import { CaptionTicker } from './player/components/CaptionTicker';
import { LoopingTicker } from './player/components/LoopingTicker';
import { PlayedHistoryPanel } from './player/components/PlayedHistoryPanel';
import { RequestQueuePanel } from './player/components/RequestQueuePanel';
import { ToastOverlay } from './player/components/ToastOverlay';
import { EarthquakeAlertOverlay } from './player/components/EarthquakeAlertOverlay';
import { SystemAlertBanner } from './player/components/SystemAlertBanner';
import { LogViewerPanel } from './player/components/LogViewerPanel';
import { SavedRecipesModal } from './player/components/SavedRecipesModal';
import { AiRadioChatModal } from './player/components/AiRadioChatModal';
import { ClassicRequestForm } from './player/components/ClassicRequestForm';
import { JazzRequestForm } from './player/components/JazzRequestForm';
import { MoodRequestForm } from './player/components/MoodRequestForm';
import { BeatlesRequestForm } from './player/components/BeatlesRequestForm';
import { TwentyFourYouRequestPanel } from './player/components/TwentyFourYouRequestPanel';
import { TheAnswersRequestPanel } from './player/components/TheAnswersRequestPanel';
import { LiveRequestForm } from './player/components/LiveRequestForm';
import { NowPlayingMeta } from './player/components/NowPlayingMeta';
import { SecretaryPanel } from './player/components/SecretaryPanel';
import { useToasts } from './player/hooks/useToasts';
import { useLogViewer } from './player/hooks/useLogViewer';
import { useSavedRecipes } from './player/hooks/useSavedRecipes';
import { useSleepTimer } from './player/hooks/useSleepTimer';
import { useInfoViewMap } from './player/hooks/useInfoViewMap';
import { useAiRadioChat } from './player/hooks/useAiRadioChat';
import { useClassicRequests } from './player/hooks/useClassicRequests';
import { useJazzRequests } from './player/hooks/useJazzRequests';
import { useMoodRequests } from './player/hooks/useMoodRequests';
import { useBeatlesRequests } from './player/hooks/useBeatlesRequests';
import { useTwentyFourYouRequests } from './player/hooks/useTwentyFourYouRequests';
import { useTheAnswers } from './player/hooks/useTheAnswers';
import { useEarthquakeAlert } from './player/hooks/useEarthquakeAlert';
import { useSecretaryLive } from './player/hooks/useSecretaryLive';
import { useKeyboardShortcuts } from './player/hooks/useKeyboardShortcuts';
import { usePlayedQueue } from './player/hooks/usePlayedQueue';

/**
 * 再生画面のルートコンポーネント。
 *
 * @returns チャンネル選択・再生・リクエストの画面
 */
export default function Player() {
  const SERVER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : window.location.origin;

  // ── チャンネル選択 ────────────────────────────────────────────────────────
  const [selectedChannel, setSelectedChannel] = useState<ChannelId | null>(null);

  /**
   * チャンネルの WebSocket 接続先を組み立てる。
   *
   * @param channelId チャンネルの識別子
   * @returns 接続先の URL
   */
  const getWsUrl = (channelId: ChannelId) => {
    const ch = CHANNELS.find(c => c.id === channelId)!;
    return window.location.hostname === 'localhost'
      ? `ws://localhost:3001${ch.wsPath}`
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${ch.wsPath}`;
  };

  // 後方互換: 既存コードが参照する WS_URL (selectedChannel 確定後に使用)
  const WS_URL = selectedChannel ? getWsUrl(selectedChannel) : getWsUrl('live');

  // ── state ─────────────────────────────────────────────────────────────────
  const [isStreaming,     setIsStreaming]     = useState(false);
  const [activeSpeaker,   setActiveSpeaker]   = useState<string | null>(null);
  const [volume,          setVolume]          = useState<number>(() => (_loadPrefs().volume as number) ?? 80);
  const [isMuted,         setIsMuted]         = useState<boolean>(() => (_loadPrefs().isMuted as boolean) ?? false);
  const [nowPlaying,      setNowPlaying]      = useState<{
    title: string; artist: string; type: 'spotify' | 'bgm' | null;
    albumImage?: string; albumName?: string; releaseYear?: string;
    genres?: string; mood?: string; tempo?: number; energy?: string; keyMode?: string;
  } | null>(null);
  const [cycleMonitor,    setCycleMonitor]    = useState<CycleMonitor | null>(null);
  const [cornerRequests,  setCornerRequests]  = useState<string[]>([]);
  const [config,          setConfig]          = useState<FullConfig | null>(null);
  const [directionInput,  setDirectionInput]  = useState('');
  const [subtitle,        setSubtitle]        = useState<string | null>(null);
  const [isTerminating,   setIsTerminating]   = useState(false);
  // ウェルカム画面では、挨拶文とフッター（バージョン表記等）を常に画面内へ収め、間の
  // チャンネルメニューだけをスクロールさせたい。実際に表示されている画面の高さを基準に
  // するため、カードの画面上端からの位置とウィンドウの高さから、許容できる最大高さを都度求める。
  const welcomeCardRef = useRef<HTMLDivElement>(null);
  const [welcomeCardMaxHeight, setWelcomeCardMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!welcomeCardRef.current) return;
    const recalc = () => {
      if (!welcomeCardRef.current) return;
      // ATTENTION: 2カラムが横並びになる幅（768px）未満では左カラムが上へ縦積みされ、カードの
      //            画面上端からの位置が大きく下がるため、高さ制限をかけると逆にチャンネルリストが
      //            極端に窮屈になる。その幅ではページ全体をスクロールする挙動に戻す（制限なし）。
      if (window.innerWidth < 768) {
        setWelcomeCardMaxHeight(undefined);
        return;
      }
      const top = welcomeCardRef.current.getBoundingClientRect().top;
      // ルート要素の下端の余白（16px）を差し引き、フッターが画面下端で見切れないようにする。
      const available = window.innerHeight - top - 16;
      setWelcomeCardMaxHeight(Math.max(available, 240));
    };
    recalc();
    window.addEventListener('resize', recalc);
    return () => window.removeEventListener('resize', recalc);
  }, [isStreaming, selectedChannel, isTerminating]);
  // ティッカー（金融コーナー等で表示される情報バー）
  const [ticker, setTicker] = useState<TickerData>(null);
  // 翻訳テロップ（英語のセリフを話すチャンネル向けの日本語訳）。
  // ATTENTION: サーバーからの「クリア」信号（空文字）では消さず、表示中のテロップは自身の
  //            スクロールが最後まで終わるまで出し続ける。曲を挟まず発話が続く場合は前の
  //            テロップの表示中に次の訳が届くため、順番待ちさせず1本の文章としてつなげて
  //            流し直す（つなげることでテロップが実際の発話に追いつける）。
  const [currentCaption, setCurrentCaption] = useState<string | null>(null);
  // テロップの React key。つなげるたびに変えると毎回スクロールがリセットされてしまうため、
  // 「表示なし → 表示あり」に転じた（＝新しい発話のひとまとまりが始まった）時だけ増やす。
  const [captionSessionId, setCaptionSessionId] = useState(0);
  const prevCaptionWasNullRef = useRef(true);
  useEffect(() => {
    if (currentCaption !== null && prevCaptionWasNullRef.current) {
      setCaptionSessionId(id => id + 1);
    }
    prevCaptionWasNullRef.current = currentCaption === null;
  }, [currentCaption]);
  // 右カラムのパネル（ワールドレポートの地図・レシピカード・天気図）。
  const [infoView, setInfoView] = useState<InfoViewData>(null);

  // ── 衛星画像 5分ごと自動更新 ────────────────────────────────────────────
  const [satTick, setSatTick] = useState(() => Math.floor(Date.now() / 60000));
  const satIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (infoView?.type === 'weather_chart') {
      satIntervalRef.current = setInterval(async () => {
        const t = Math.floor(Date.now() / 60000);
        const r = await fetch(`/api/satellite-image?t=${t}`, { method: 'HEAD' }).catch(() => null);
        const time = r?.headers.get('x-satellite-time') || '';
        setSatTick(t);
        if (time) setInfoView(v => v?.type === 'weather_chart' ? { ...v, satelliteTime: time } : v);
      }, 5 * 60 * 1000);
    }
    return () => { if (satIntervalRef.current) clearInterval(satIntervalRef.current); };
  }, [infoView?.type]);

  // アバター画像の読み込みエラー（エラーになったキーはemoji fallback）
  const [avatarErrors, setAvatarErrors] = useState<Set<string>>(new Set());
  const onAvatarError = (key: string) =>
    setAvatarErrors(prev => new Set([...prev, key]));

  /**
   * コーナーのアイコンを、担当エージェントのアバター画像で描く。
   *
   * コーナーキーはそのままアバターのファイル名（/avatars/{agentKey}.png）に対応する。
   * 5箇所で同じ描画をするためまとめてあるが、コンポーネントではなく単なる関数なので、
   * 再レンダーのたびに画像が読み直される心配は無い。画像が無いコーナーが増えても壊れないよう、
   * 読み込みに失敗したら従来の絵文字へ戻す。
   *
   * @param key コーナーキー（＝エージェントキー）
   * @param sizeClass 画像の大きさを決めるクラス
   * @param emojiClass 絵文字へ戻したときの大きさを決めるクラス
   * @returns アバター画像、または絵文字
   */
  const renderCornerAvatar = (key: string, sizeClass: string, emojiClass: string) => (
    !avatarErrors.has(key) ? (
      <img
        src={`/avatars/${key}.png`}
        alt={config?.agents?.[key]?.name ?? key}
        onError={() => onAvatarError(key)}
        draggable={false}
        className={`${sizeClass} rounded-full object-cover select-none flex-shrink-0 border border-white/10`}
      />
    ) : (
      <span className={`${emojiClass} leading-none flex-shrink-0`}>{CORNER_ICONS[key] ?? '🎙'}</span>
    )
  );


  const { infoToast, warnToast, infoLeave, warnLeave, showInfo, showWarn } = useToasts();
  // My Secretary は他チャンネルの配信の流れとは完全に独立した、1対1の会話専用。
  const secretaryLive = useSecretaryLive({
    wsUrl: getWsUrl('secretary'), serverUrl: SERVER_URL, showWarn,
    // 音声での指示でセッションが終わった場合も、手動の終了と同じくウェルカム画面へ戻す
    // （切断そのものはフックの中で完結している）。
    onSessionEnd: () => setSelectedChannel(null),
  });
  // My Secretary の「伝えたいことがあります」の印。接続前のウェルカム画面で、未消化の通知が
  // あるかどうかを消費せずに問い合わせ、あればチャンネルボタンの絵文字を切り替える。
  // ATTENTION: 実際に接続して挨拶を聞くまで通知はクリアしないため、消費しない専用の
  //            問い合わせ先を使うこと。
  const [secretaryHasPendingNotification, setSecretaryHasPendingNotification] = useState(false);
  useEffect(() => {
    if (isStreaming || selectedChannel === 'secretary') return;
    let cancelled = false;
    const checkPending = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/secretary-notifications/pending-count`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSecretaryHasPendingNotification((data?.count ?? 0) > 0);
      } catch {
        // サーバー未起動時は無視（他の画面のポーリングと同じ方針）
      }
    };
    checkPending();
    const interval = setInterval(checkPending, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isStreaming, selectedChannel]);
  const { showLogs, setShowLogs, logEntries, logEndRef, openLogViewer } = useLogViewer();
  const { savedRecipes, savedRecipesOpen, setSavedRecipesOpen, saveRecipe, removeSavedRecipe } =
    useSavedRecipes(SERVER_URL, showInfo, showWarn);

  // 音楽チャンネルの再生履歴とリクエストの待ち行列。
  const [classicPlayedList, setClassicPlayedList, classicQueue, setClassicQueue] = usePlayedQueue<ClassicTrack>();
  const [jazzPlayedList,    setJazzPlayedList,    jazzQueue,    setJazzQueue]    = usePlayedQueue<JazzTrack>();
  const [moodPlayedList,    setMoodPlayedList,    moodQueue,    setMoodQueue]    = usePlayedQueue<MoodTrack>();
  const [beatlesPlayedList, setBeatlesPlayedList, beatlesQueue, setBeatlesQueue] = usePlayedQueue<BeatlesTrack>();

  // 24/You チャンネル: 再生履歴（アンコール機能・リクエスト機能なし）
  const [twentyFourYouPlayedList, setTwentyFourYouPlayedList] = useState<TwentyFourYouTrack[]>([]);

  const [googleCreditAlert, setGoogleCreditAlert] = useState(false);

  // Live リクエスト種別
  const [liveRequestType, setLiveRequestType] = useState<'song' | 'topic' | 'message'>('message');

  // チャンネル選択後に自動接続するための一時フラグ
  const pendingConnectRef = useRef(false);

  // ── refs ──────────────────────────────────────────────────────────────────
  const wsRef             = useRef<WebSocket | null>(null);
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const audioWorkletRef   = useRef<AudioWorkletNode | null>(null);
  const wakeLockRef       = useRef<(() => void) | null>(null);
  const isStreamingRef    = useRef(false);
  const volumeRef         = useRef<number>((_loadPrefs().volume as number) ?? 80);
  const isMutedRef        = useRef(false);
  const spotifyPlayerRef      = useRef<any>(null);
  const spotifyDeviceRef      = useRef<string | null>(null);
  const spotifyDeviceReadyAt  = useRef<number>(0);
  // 最後に再生が成立した時刻。長時間使われないと Spotify 側でデバイスの登録が失効するため、
  // 「どれだけ使われていないか」を測るのに使う。
  const spotifyLastPlayAt     = useRef<number>(0);
  // チャンネルを抜けるときの「こちらから切った」印。自動の再接続と喧嘩しないようにする。
  const spotifyIntentionalDisconnect = useRef<boolean>(false);
  const lastSpotifyTrackIdRef = useRef<string | null>(null);
  // BUGFIX: 再生開始を指示したトラックの URI。再生状態の通知がこの URI に切り替わるまで
  //         アルバムアートの更新を止め、前の曲の画像が一瞬出るのを防ぐ。
  const pendingSpotifyUriRef  = useRef<string | null>(null);
  const spotifyVolTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spotifyPlayCleanupRef = useRef<(() => void) | null>(null);
  const terminatePollRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  // バックグラウンドタブ抑制・オートプレイブロック対策: 無音 AudioContext を常時稼働させる
  const keepAliveRef = useRef<{ ctx: AudioContext; osc: OscillatorNode } | null>(null);

  const {
    classicReqEra, setClassicReqEra, classicReqMood, setClassicReqMood,
    classicReqGenre, setClassicReqGenre, classicReqFree, setClassicReqFree,
    sendClassicListenerRequest, sendClassicReplayRequest,
  } = useClassicRequests({ serverUrl: SERVER_URL, wsRef, config, showInfo, showWarn });

  const {
    jazzReqStyle, setJazzReqStyle, jazzReqMood, setJazzReqMood,
    jazzReqInstrument, setJazzReqInstrument, jazzReqFree, setJazzReqFree,
    sendJazzListenerRequest, sendJazzReplayRequest,
  } = useJazzRequests({ serverUrl: SERVER_URL, wsRef, config, showInfo, showWarn });

  const { moodReqFree, setMoodReqFree, sendMoodListenerRequest, sendMoodReplayRequest } =
    useMoodRequests({ serverUrl: SERVER_URL, wsRef, showInfo, showWarn });

  const { beatlesReqFree, setBeatlesReqFree, sendBeatlesListenerRequest, sendBeatlesReplayRequest } =
    useBeatlesRequests({ serverUrl: SERVER_URL, wsRef, showInfo, showWarn });

  const {
    twentyFourYouMode, setTwentyFourYouMode, twentyFourYouAnokoroAge, setTwentyFourYouAnokoroAge,
    twentyFourYouArtists, setTwentyFourYouArtists, twentyFourYouArtistInput, setTwentyFourYouArtistInput,
    twentyFourYouWagamamaRequest, setTwentyFourYouWagamamaRequest,
    twentyFourYouLanguagePref, setTwentyFourYouLanguagePref,
    sendTwentyFourYouMode, addTwentyFourYouArtist, removeTwentyFourYouArtist,
    addTwentyFourYouArtistFromProfile, sendTwentyFourYouWagamama, sendTwentyFourYouLanguagePref,
  } = useTwentyFourYouRequests({ serverUrl: SERVER_URL, showInfo, showWarn });

  const boundPostListenerRequest = (
    channelSlug: string, requestText: string, onSuccess: () => void,
    successMessage: string, errorMessage?: string,
  ) => postListenerRequest(SERVER_URL, showInfo, showWarn, channelSlug, requestText, onSuccess, successMessage, errorMessage);

  // ATTENTION: 配信の開始処理は下で定義されるが、討論番組のフックは早い段階の副作用から
  //            その候補を参照する必要があるためここで呼ぶ。開始処理そのものは ref 経由の
  //            間接呼び出しで渡し、宣言前の参照を避ける。
  const startRadioStreamRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const {
    theAnswersTopicInput, setTheAnswersTopicInput, theAnswersStarting,
    theAnswersCandidates, theAnswersCandidatesLoading,
    theAnswersTheme, setTheAnswersTheme, theAnswersPanel, setTheAnswersPanel,
    theAnswersHandState, setTheAnswersHandState,
    theAnswersTextInput, setTheAnswersTextInput,
    theAnswersRoundTimer, setTheAnswersRoundTimer,
    theAnswersClosing, setTheAnswersClosing, theAnswersCarouselRotation,
    theAnswersClientIdRef, fetchTheAnswersCandidates, startTheAnswersEpisode,
    sendTheAnswersRaiseHand, sendTheAnswersSubmitText, resetTheAnswersState,
  } = useTheAnswers({
    serverUrl: SERVER_URL, wsRef, activeSpeaker, showWarn,
    startRadioStream: () => startRadioStreamRef.current(),
  });

  const { earthquakeAlert, setEarthquakeAlert, handleEarthquakeAlert, systemAlerts } = useEarthquakeAlert();

  // ── ref 同期 ──────────────────────────────────────────────────────────────
  useEffect(() => { isStreamingRef.current    = isStreaming;    }, [isStreaming]);
  useEffect(() => { volumeRef.current         = volume;         }, [volume]);
  useEffect(() => { isMutedRef.current        = isMuted;        }, [isMuted]);


  // ── チャンネル選択後の自動接続 ───────────────────────────────────────────────
  useEffect(() => {
    if (selectedChannel && pendingConnectRef.current && !isStreaming) {
      pendingConnectRef.current = false;
      startRadioStream();
    }
  // startRadioStream は毎レンダーで新しい参照になるため deps から除外
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannel]);

  // ── プリファレンス永続化（変更時に localStorage へ保存）──────────────────
  useEffect(() => { _savePrefs({ volume }); }, [volume]);
  useEffect(() => { _savePrefs({ isMuted }); }, [isMuted]);

  // ── 初期設定取得 ──────────────────────────────────────────────────────────
  const [classicAgents, setClassicAgents] = useState<Record<string, { name?: string }>>({});
  const [jazzAgents,    setJazzAgents]    = useState<Record<string, { name?: string }>>({});
  const [moodAgents,    setMoodAgents]    = useState<Record<string, { name?: string }>>({});
  const [beatlesAgents, setBeatlesAgents] = useState<Record<string, { name?: string }>>({});
  // Jazz: 翻訳テロップのスクロール速度（管理画面の番組設定で調整可能）
  const [jazzCaptionSpeed, setJazzCaptionSpeed] = useState(170);
  useEffect(() => {
    fetch(`${SERVER_URL}/api/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setConfig(d))
      .catch(() => {});
    fetch(`${SERVER_URL}/api/classic/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.agents && setClassicAgents(d.agents))
      .catch(() => {});
    fetch(`${SERVER_URL}/api/jazz/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.agents) setJazzAgents(d.agents);
        if (typeof d?.program?.caption_speed === 'number') setJazzCaptionSpeed(d.program.caption_speed);
      })
      .catch(() => {});
    fetch(`${SERVER_URL}/api/mood/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.agents && setMoodAgents(d.agents))
      .catch(() => {});
    fetch(`${SERVER_URL}/api/beatles/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d?.agents && setBeatlesAgents(d.agents))
      .catch(() => {});
    fetch(`${SERVER_URL}/api/24you/config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.program) return;
        if (d.program.selection_mode) setTwentyFourYouMode(d.program.selection_mode);
        setTwentyFourYouAnokoroAge(d.program.anokoro_age != null ? String(d.program.anokoro_age) : '');
        setTwentyFourYouArtists(Array.isArray(d.program.favorite_artists) ? d.program.favorite_artists : []);
        setTwentyFourYouWagamamaRequest(d.program.wagamama_request ?? '');
        if (d.program.language_pref) setTwentyFourYouLanguagePref(d.program.language_pref);
      })
      .catch(() => {});
  }, []);

  // ── visibilitychange ──────────────────────────────────────────────────────
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !isStreamingRef.current) return;
      const ctx = audioCtxRef.current as any;
      if (ctx?.state === 'suspended') ctx.resume().catch(console.error);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // ── Spotify activateElement: ユーザー操作のたびに AudioContext を再アクティブ化 ──
  // ブラウザはバックグラウンドタブ復帰後に Spotify SDK の内部 AudioContext を suspend
  // することがある。pointerdown（クリック・タップの先頭イベント）はユーザーアクションと
  // みなされるため、ここで activateElement() を呼ぶことで次の再生に備えておく。
  useEffect(() => {
    if (!isStreaming) return;
    const onPointerDown = () => {
      spotifyPlayerRef.current?.activateElement?.().catch(() => {});
    };
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isStreaming]);

  // ── MediaSession ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!('mediaSession' in navigator) || !isStreaming) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying?.title || 'AI Radio',
      artist: nowPlaying?.artist || 'Live Broadcast',
      album: 'AI Radio Station',
    });
  }, [nowPlaying, isStreaming]);

  // ── ミュート/ボリューム変更を AudioContext に反映 ─────────────────────────
  useEffect(() => {
    const gain = (audioCtxRef.current as any)?.masterGain;
    if (gain) gain.gain.value = isMuted ? 0 : volume / 100;
    // Spotify ボリュームは handleVolumeChange / toggleMute で直接適用する
  }, [isMuted, volume]);

  // ── Spotify SDK ───────────────────────────────────────────────────────────
  /**
   * Spotify Web Playback SDK を読み込み、プレーヤーを作って接続する。
   *
   * トークンに配信の権限があるか、アカウントが Premium かをここで確かめ、満たさなければ
   * 警告を出して何もしない。SDK のバージョンが前回と変わっていれば警告を出す。
   */
  const initSpotifyPlayer = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/spotify/sdk-token`);
      if (!res.ok) return;
      const { access_token } = await res.json();
      if (!access_token) return;

      // streaming スコープ確認（client_credentials トークンは /v1/me が 401 を返す）
      const meRes = await fetch('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!meRes.ok) {
        console.error('[Spotify] token lacks streaming scope — re-auth required');
        showWarn('⚠️ Spotify: streaming 権限なし。管理画面で再認証してください');
        return;
      }
      const me = await meRes.json();
      if (me.product !== 'premium') {
        showWarn(`⚠️ Spotify Premium が必要です (現在: ${me.product})`);
        return;
      }

      // onSpotifyWebPlaybackSDKReady はスクリプト追加より前に設定必須
      if (!(window as any).Spotify) {
        await new Promise<void>(resolve => {
          (window as any).onSpotifyWebPlaybackSDKReady = resolve;
          const s = document.createElement('script');
          s.src = 'https://sdk.scdn.co/spotify-player.js';
          document.head.appendChild(s);
        });
      }

      // SDK のバージョンをスクリプト本文から拾ってログに残す。変わっていれば知らせる
      // （SDK 側の更新が原因の不具合を切り分けられるようにするため）。
      fetch('https://sdk.scdn.co/spotify-player.js')
        .then(r => r.text())
        .then(src => {
          // 複数パターンを試す
          const patterns = [
            /"?version"?\s*:\s*"([\d]+\.[\d]+\.[\d]+[\w.-]*)"/i,
            /sdkVersion\s*[=:]\s*"([\d]+\.[\d]+\.[\d]+[\w.-]*)"/i,
            /SDK_VERSION\s*[=:]\s*"([\d]+\.[\d]+\.[\d]+[\w.-]*)"/i,
            /[^a-z]v([\d]+\.[\d]+\.[\d]+[\w.-]*)[^a-z\d]/i,
          ];
          const found = patterns.reduce<string | null>((acc, re) => acc ?? (src.match(re)?.[1] ?? null), null);
          if (found) {
            const STORAGE_KEY = 'spotify_sdk_version';
            const prev = localStorage.getItem(STORAGE_KEY);
            if (!prev) {
              localStorage.setItem(STORAGE_KEY, found);
              console.log('[Spotify SDK] version:', found, '(初回記録)');
            } else if (prev === found) {
              console.log('[Spotify SDK] version:', found, '(前回と同じ)');
            } else {
              localStorage.setItem(STORAGE_KEY, found);
              console.warn(`[Spotify SDK] バージョン変更検出: ${prev} → ${found}`);
              showWarn(`⚠️ Spotify SDK が更新されました: ${prev} → ${found}`);
            }
          } else {
            console.warn('[Spotify SDK] version 検出不可 — 先頭200文字:', src.slice(0, 200).replace(/\s+/g, ' '));
          }
        })
        .catch(() => console.warn('[Spotify SDK] スクリプト取得失敗'));

      const player = new (window as any).Spotify.Player({
        name: 'AI Radio Player',
        getOAuthToken: async (cb: (t: string) => void) => {
          try {
            const r = await fetch(`${SERVER_URL}/api/spotify/sdk-token`);
            cb((await r.json()).access_token || access_token);
          } catch { cb(access_token); }
        },
        volume: volumeRef.current / 100,
      });

      // SDK 内部の AudioContext を即時アクティブ化する。接続直後のこの経路はユーザー操作の
      // 直後のため、Chrome では数百ミリ秒以内なら操作の文脈が有効なことがある。
      player.activateElement?.().catch(() => {});

      // ATTENTION: 接続の完了前に準備完了が発火しても受け取れるよう、参照へ先に保存する。
      spotifyPlayerRef.current = player;
      spotifyIntentionalDisconnect.current = false;

      player.addListener('ready', ({ device_id }: { device_id: string }) => {
        console.log('[Spotify] device ready:', device_id.slice(0, 8) + '...');
        spotifyDeviceRef.current    = device_id;
        spotifyDeviceReadyAt.current = Date.now();
        showInfo('🎵 Spotify 接続完了');
      });
      player.addListener('not_ready', () => {
        spotifyDeviceRef.current = null;
        // チャンネルを抜けたことによる切断なら、ここで勝手に繋ぎ直さない
        // （繋ぎ直すと登録が残り続け、登録を解除した意味が無くなる）。
        if (spotifyIntentionalDisconnect.current) {
          console.log('[Spotify] not_ready（チャンネル終了による切断）');
          return;
        }
        console.warn('[Spotify] not_ready — 2秒後に再接続を試みます');
        setTimeout(() => {
          spotifyPlayerRef.current?.connect().catch((e: any) => {
            console.error('[Spotify] reconnect failed:', e?.message);
          });
        }, 2000);
      });
      player.addListener('initialization_error', (e: any) => {
        console.error('[Spotify] initialization_error', e?.message);
        showWarn(`⚠️ Spotify 初期化エラー: ${e?.message ?? '不明'}`);
      });
      player.addListener('authentication_error', (e: any) => {
        console.error('[Spotify] authentication_error', e?.message);
        showWarn(`⚠️ Spotify 認証エラー: ${e?.message ?? '不明'}`);
      });
      player.addListener('account_error', (e: any) => {
        console.error('[Spotify] account_error', e?.message);
        showWarn(`⚠️ Spotify アカウントエラー: ${e?.message ?? '不明'}`);
      });

      // アルバムアートとメタデータは SDK のステート変更イベントから取得
      player.addListener('player_state_changed', async (state: any) => {
        if (!state) return;
        const track = state.track_window?.current_track;
        if (!track) return;
        // 切り替え中の URI があるなら、SDK がまだ前のトラックを報告している間はアルバムアートの
        // 更新を飛ばし、前の画像が一瞬出るのを防ぐ。
        if (pendingSpotifyUriRef.current && track.uri !== pendingSpotifyUriRef.current) return;
        pendingSpotifyUriRef.current = null; // URI 一致 → ロック解除
        const images: { url: string; width: number }[] = track.album?.images || [];
        const img = images[0] || images[images.length - 1];
        const albumName: string | undefined = track.album?.name || undefined;
        if (img?.url) setNowPlaying(prev => prev ? { ...prev, albumImage: img.url, albumName } : prev);

        const trackId: string | undefined = track.uri?.replace('spotify:track:', '');
        if (trackId && trackId !== lastSpotifyTrackIdRef.current) {
          lastSpotifyTrackIdRef.current = trackId;
          try {
            const { access_token: tok } = await fetch(`${SERVER_URL}/api/spotify/sdk-token`).then(r => r.json());
            const r = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
              headers: { Authorization: `Bearer ${tok}` },
            });
            if (r.ok) {
              const data = await r.json();
              const releaseYear = data.album?.release_date?.split('-')[0];
              setNowPlaying(prev => prev ? { ...prev, releaseYear } : prev);
            }
          } catch { /* ignore */ }
        }
      });

      // ATTENTION: 接続がハングしても準備完了は後から発火することがあるため、上限を過ぎても
      //            プレーヤーの参照は保持し続ける。
      let connectTimer: ReturnType<typeof setTimeout>;
      const connected = await Promise.race([
        player.connect(),
        new Promise<boolean>(r => { connectTimer = setTimeout(() => r(false), 15000); }),
      ]);
      clearTimeout(connectTimer!);
      if (!connected) {
        console.warn('[Spotify] connect() timed out — ready イベント待機中。DRM 初期化が遅延している可能性あり');
        // connect() がタイムアウトしても ready イベントが後から発火する場合がある（待機継続）
      }
    } catch (e: any) {
      console.error('[Spotify] init error:', e?.message);
      showWarn(`⚠️ Spotify 初期化に失敗: ${e?.message ?? '不明'}`);
    }
  };

  /**
   * SDK デバイスを登録し直し、新しいデバイス ID を返す（失敗したら null）。
   *
   * BUGFIX: 接続してから最初の再生までが長いと、Spotify 側でデバイスの登録が失効し、
   *         転送の API が 404 を返す（音楽チャンネルは接続の1〜2分後に曲が鳴るのに対し、
   *         DJ のコーナーが回ってくるのは20分以上あと）。
   * ATTENTION: 復旧には必ず切ってから繋ぎ直すこと。繋ぎ直すだけでは SDK が自分を「接続済み」と
   *            見なして何も起こらず、準備完了も発火しない。
   * ATTENTION: デバイス ID が前と同じでも成功として扱うこと。同じ ID でも登録は新しい。
   *            ID が変わったことを条件にすると、成功を失敗と判定してしまう。
   *
   * @param timeoutMs 準備完了を待つ上限
   * @returns 新しいデバイス ID。取れなければ null
   */
  const reregisterSpotifyDevice = async (timeoutMs = 12000): Promise<string | null> => {
    const player = spotifyPlayerRef.current;
    if (!player) return null;
    try { await player.disconnect(); } catch { /* 既に切れていてもよい */ }
    spotifyDeviceRef.current = null;
    // BUGFIX: 切断が解決しても SDK 内部の切断は終わっていないことがある。間を置かずに繋ぎ直すと
    //         「まだ接続中」と判断されて何も起こらず、準備完了が来ないまま待ち時間を捨てる
    //         （実測では長時間アイドル後の1回目が8秒空振りし、2回目はすぐ通った）。
    await new Promise(r => setTimeout(r, 600));
    // ATTENTION: 繋ぎ直すより先に待受を張ること。後から張ると準備完了を取りこぼす。
    const ready = new Promise<string | null>(resolve => {
      const t = setTimeout(() => { player.removeListener('ready', onReady); resolve(null); }, timeoutMs);
      const onReady = ({ device_id }: { device_id: string }) => {
        clearTimeout(t); player.removeListener('ready', onReady); resolve(device_id);
      };
      player.addListener('ready', onReady);
    });
    player.connect().catch(() => {});
    return ready;
  };

  /**
   * 1曲を Spotify で再生し、終わったらサーバーへ完了を知らせる。
   *
   * デバイスが取れなければ Spotify Connect の既存デバイスへ倒し、それも無ければ諦めて
   * 完了を返す（返さないと番組の進行が止まる）。再生の終わりは再生状態の通知で判定し、
   * 取りこぼしに備えて曲尺からの見張りも置く。
   *
   * @param uri 再生する曲の URI
   * @param title 曲名
   * @param artist アーティスト名
   * @param durationMs 曲の長さ
   */
  const handleSpotifyPlay = async (uri: string, title: string, artist: string, durationMs: number) => {
    console.log(`[Spotify] handleSpotifyPlay: "${title}" / ${artist} (${Math.round(durationMs/1000)}s)`);
    const sendDone = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(JSON.stringify({ event: 'SPOTIFY_PLAY_DONE', title, artist }));
    };

    // デバイス待機（最大10秒）
    let deviceId = spotifyDeviceRef.current;
    if (!deviceId) {
      deviceId = await new Promise<string | null>(resolve => {
        const deadline = setTimeout(() => resolve(null), 10000);
        const poll = setInterval(() => {
          if (spotifyDeviceRef.current) {
            clearInterval(poll); clearTimeout(deadline);
            resolve(spotifyDeviceRef.current);
          }
        }, 200);
      });
    }

    // SDK デバイス未取得 → Spotify Connect API（既存デバイス）にフォールバック
    let usingConnectFallback = false;
    if (!deviceId) {
      console.warn('[Spotify] SDK デバイス未取得 → Connect API フォールバック');
      try {
        const { access_token: tok } = await fetch(`${SERVER_URL}/api/spotify/sdk-token`).then(r => r.json());
        const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
          headers: { Authorization: `Bearer ${tok}` },
        });
        if (devRes.ok) {
          const { devices } = await devRes.json();
          console.log('[Spotify] Connect API devices:', (devices as any[])?.map((d: any) => `${d.name}(${d.is_active ? 'active' : '-'})`).join(', ') || 'none');
          const chosen = (devices as any[])?.find(d => d.is_active) || (devices as any[])?.[0];
          if (chosen) {
            showInfo(`🎵 Spotify: ${chosen.name} で再生`);
            deviceId = chosen.id;
            usingConnectFallback = true;
          }
        }
      } catch (e) {
        console.error('[Spotify] Connect fallback error:', e);
      }
    } else {
      console.log('[Spotify] SDK デバイス使用:', deviceId.slice(0, 8) + '...');
    }
    if (!deviceId) {
      console.error('[Spotify] no device available');
      showWarn('⚠️ Spotify: デバイスが見つかりません。Spotify アプリを開いてください');
      sendDone(); return;
    }

    pendingSpotifyUriRef.current = uri; // この URI の再生状態が届くまでアルバムアートの更新を止める
    setNowPlaying({ title, artist, type: 'spotify' });

    const doPlay = async (token: string, did: string) => {
      const tr = await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [did], play: false }),
      });
      if (tr.status === 404) throw new Error('TRANSFER_404');
      if (!tr.ok && tr.status !== 204) throw new Error(`TRANSFER_${tr.status}`);
      await new Promise(r => setTimeout(r, 500));
      const r = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${did}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri], position_ms: 0 }),
      });
      if (!r.ok && r.status !== 204) {
        const body = await r.text().catch(() => '');
        console.error('[Spotify] play API error:', r.status, body);
        throw new Error(`PLAY_${r.status}`);
      }
    };

    // バックグラウンドのタブかどうかの判定。
    // BUGFIX: 再生を指示した後に判定すると、上限を過ぎてからタブを開いた際に音の再生が再開し、
    //         溜まっていた再生の指示が実行されて会話と音楽が重なる。指示を送る前に判定すれば、
    //         上限を過ぎた場合は指示そのものを送らずに確実に飛ばせる。
    if (document.visibilityState === 'hidden') {
      if (Notification.permission === 'granted') {
        new Notification('AI Radio 🎵', {
          body: `${title} — ${artist}\nタブを開くと再生します（30秒でスキップ）`,
          tag: 'ai-radio-music',
        });
      }
      showInfo('⏸ Spotify: タブを開くと再生します（30秒でスキップ）');
      const bgResult = await new Promise<'visible' | 'timeout'>(resolve => {
        const timer = setTimeout(() => {
          document.removeEventListener('visibilitychange', onBgCheck);
          resolve('timeout');
        }, 30000);
        const onBgCheck = () => {
          if (document.visibilityState !== 'visible') return;
          clearTimeout(timer);
          document.removeEventListener('visibilitychange', onBgCheck);
          keepAliveRef.current?.ctx.resume().catch(() => {});
          audioCtxRef.current?.resume().catch(() => {});
          spotifyPlayerRef.current?.resume().catch(() => {});
          resolve('visible');
        };
        document.addEventListener('visibilitychange', onBgCheck);
      });
      if (bgResult === 'timeout') {
        showWarn('⚠️ Spotify: バックグラウンドのためスキップしました');
        sendDone();
        return;
      }
      // タブが前面に戻った → 以降の doPlay() へ続く
    }

    // SDK デバイス登録直後は少し待つ（フォールバック時はスキップ）
    if (!usingConnectFallback) {
      const deviceAge = Date.now() - spotifyDeviceReadyAt.current;
      if (deviceAge < 1000) await new Promise(r => setTimeout(r, 1000 - deviceAge));
    }

    // 長時間まったく使われていないデバイスは登録が失効している可能性が高いので、404 を受けてから
    // 直すのではなく先に登録し直す（そのぶん無音が短い）。DJ のコーナーは接続から20分以上あとに
    // 来るため、ここに該当する。
    if (!usingConnectFallback) {
      const idleMs = Date.now() - Math.max(spotifyDeviceReadyAt.current, spotifyLastPlayAt.current);
      if (idleMs > 10 * 60 * 1000) {
        console.log(`[Spotify] ${Math.round(idleMs / 60000)}分間アイドル → 事前にデバイスを登録し直します`);
        // 1回目が空振りしても2回目は通るという実測があるため、もう一度だけ試す。
        // ここで通せば転送の 404 そのものが起きず、無音が最も短くなる。
        let fresh = await reregisterSpotifyDevice();
        if (!fresh) {
          console.warn('[Spotify] 事前再登録 1回目が空振り → もう一度試します');
          fresh = await reregisterSpotifyDevice();
        }
        if (fresh) { deviceId = fresh; console.log('[Spotify] 事前再登録 完了:', fresh.slice(0, 8) + '...'); }
        else console.warn('[Spotify] 事前再登録に失敗 — そのまま再生を試みます（404なら再登録で復帰します）');
      }
    }

    let played = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const latestDid = usingConnectFallback ? deviceId : (spotifyDeviceRef.current || deviceId);
      if (!latestDid) break;
      try {
        const { access_token } = await fetch(`${SERVER_URL}/api/spotify/sdk-token`).then(r => r.json());
        await doPlay(access_token, latestDid);
        console.log(`[Spotify] 再生成功 (attempt ${attempt})`);
        spotifyLastPlayAt.current = Date.now(); // 次回のアイドル判定に使う
        played = true;
        break;
      } catch (e: any) {
        console.error(`[Spotify] play attempt ${attempt} failed:`, e?.message);
        if ((e.message?.includes('404') || e.message?.includes('TRANSFER')) && attempt < 3) {
          // SDK デバイスが stale → まず SDK 再接続を試み、新しい device_id を待つ
          let reconnected = false;
          if (spotifyPlayerRef.current) {
            console.warn('[Spotify] TRANSFER_404 → SDK を切断して登録し直します...');
            // ATTENTION: 同じデバイス ID が返っても成功。登録が作り直されたことが重要で、ID が変わるか
            //            どうかは Spotify 側の都合。
            const newId = await reregisterSpotifyDevice();
            if (newId) {
              console.warn(`[Spotify] 再登録成功: ${newId.slice(0, 8)}...`);
              deviceId = newId;
              usingConnectFallback = false;
              reconnected = true;
            }
          }
          if (!reconnected) {
            // SDK 再接続失敗 → Connect API でアクティブなデバイスを探す
            try {
              const { access_token: tok } = await fetch(`${SERVER_URL}/api/spotify/sdk-token`).then(r => r.json());
              const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
                headers: { Authorization: `Bearer ${tok}` },
              });
              if (devRes.ok) {
                const { devices } = await devRes.json() as { devices: any[] };
                const chosen = devices?.find(d => d.is_active) || devices?.[0];
                if (chosen) {
                  console.warn(`[Spotify] TRANSFER_404 → Connect API デバイスに切替: ${chosen.name}`);
                  deviceId = chosen.id;
                  usingConnectFallback = true;
                }
              }
            } catch { /* ignore */ }
            await new Promise(r => setTimeout(r, 500));
          }
        } else break;
      }
    }
    if (!played) {
      showWarn('⚠️ Spotify 再生に失敗しました');
      sendDone(); return;
    }

    // 再生終了の watchdog
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;

    const resetWatchdog = (remainingMs: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => settle(), remainingMs + 5000);
    };

    const settle = async () => {
      if (settled) return; settled = true;
      spotifyPlayCleanupRef.current = null;
      clearTimeout(watchdog);
      document.removeEventListener('visibilitychange', onVisibility);
      spotifyPlayerRef.current?.removeListener('player_state_changed', onStateChange);
      try { await spotifyPlayerRef.current?.pause(); } catch { /* ignore */ }
      sendDone();
    };

    const confirmedAt = Date.now();

    // タブが前面に戻ったときの復帰。
    // ATTENTION: 音の再開は await より前に同期的に呼ぶこと。タブの切り替えはユーザー操作だが、
    //            その文脈は await を挟むと失われる。
    // 一度も再生できていない場合（再生位置が0）は再生の指示を丸ごとやり直し、見張りの期限も
    // 実際の残り時間で計算し直して誤って打ち切らないようにする。
    const onVisibility = async () => {
      if (document.visibilityState !== 'visible' || settled) return;
      // ① 同期的に resume（ユーザー操作の文脈を保持）
      keepAliveRef.current?.ctx.resume().catch(() => {});
      audioCtxRef.current?.resume().catch(() => {});
      spotifyPlayerRef.current?.resume().catch(() => {});
      // ② 状態確認・再試行（await はここから）
      try {
        const state = await spotifyPlayerRef.current?.getCurrentState();
        const neverPlayed = !state || (state.paused && state.position < 1000);
        if (neverPlayed && !settled) {
          // 一度も再生できていない → doPlay を再試行
          const { access_token } = await fetch(`${SERVER_URL}/api/spotify/sdk-token`).then(r => r.json());
          const did = spotifyDeviceRef.current;
          if (did && access_token) await doPlay(access_token, did).catch(() => {});
        }
        // ③ watchdog 再計算
        const s2 = await spotifyPlayerRef.current?.getCurrentState();
        const remaining = (s2 && s2.duration > 0)
          ? Math.max(s2.duration - s2.position, 0)
          : durationMs;
        resetWatchdog(remaining);
      } catch { /* ignore */ }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onStateChange = (state: any) => {
      if (!state?.paused) return;
      if (Date.now() - confirmedAt < 5000) return;
      const elapsed = Date.now() - confirmedAt;
      // BUGFIX: SDK は曲の終わりに再生位置を0へ戻してから停止を発火することがあり、その場合は
      //         「残り4秒以内」の判定が通らない。経過時間が曲尺の85%以上なら自然終了とみなす。
      const nearEnd = state.duration > 0 && state.position >= state.duration - 4000;
      const resetAfterDone = state.position < 2000 && elapsed >= durationMs * 0.85;
      if (!nearEnd && !resetAfterDone) return;
      settle();
    };
    // stopRadioStream から呼ばれるキャンセル関数：visibilitychange リスナーを確実に解除
    spotifyPlayCleanupRef.current = () => {
      if (settled) return;
      settled = true;
      spotifyPlayCleanupRef.current = null;
      clearTimeout(watchdog);
      document.removeEventListener('visibilitychange', onVisibility);
      spotifyPlayerRef.current?.removeListener('player_state_changed', onStateChange);
      spotifyPlayerRef.current?.pause().catch(() => {});
    };
    spotifyPlayerRef.current?.addListener('player_state_changed', onStateChange);
    resetWatchdog(durationMs);
  };

  // ── WebSocket コマンドハンドラ ─────────────────────────────────────────────
  /**
   * サーバーから届いた制御メッセージを画面の状態へ反映する。
   *
   * @param payload サーバーからの制御メッセージ
   */
  const handleServerCommand = useCallback((payload: any) => {
    switch (payload.event) {
      case 'CORNER_START':
        console.log('[Corner] 開始:', payload.name ?? payload.corner ?? '');
        setTicker(payload.ticker ?? null);
        if (payload.ticker?.type === 'weather') {
          Promise.all([
            fetch('/api/weather-chart', { method: 'HEAD' }).catch(() => null),
            fetch('/api/satellite-image', { method: 'HEAD' }).catch(() => null),
          ]).then(([wRes, sRes]) => {
            setInfoView({
              type: 'weather_chart',
              chartLabel:    wRes?.headers.get('x-chart-label')   || '',
              satelliteTime: sRes?.headers.get('x-satellite-time') || '',
            });
          });
        } else {
          setInfoView(null);
        }
        break;
      case 'TICKER_UPDATE':
        if (payload.ticker) setTicker(payload.ticker);
        break;
      case 'INFOVIEW_DATA':
        if (payload.type === 'world_report')
          setInfoView({ type: 'world_report', city: payload.city, englishName: payload.englishName || '' });
        else if (payload.type === 'recipe')
          setInfoView({ type: 'recipe', name: payload.name || '', description: payload.description || '', ingredients: payload.ingredients || [], steps: payload.steps || [], imageBase64: payload.imageBase64 ?? null, imageMimeType: payload.imageMimeType });
        break;
      case 'AGENT_SPEAKING':   console.log('[Agent] 発話:', payload.agent); setActiveSpeaker(payload.agent); break;
      case 'AGENT_SILENT':     setActiveSpeaker(null); break;
      case 'CORNER_QUEUE_UPDATE':
        setCycleMonitor({
          current: payload.current || null, next: payload.next || null,
          queue: payload.queue || [], recent: payload.recent || [],
        });
        if (payload.current)
          setCornerRequests(prev => prev.filter(c => c !== payload.current));
        break;
      case 'MUSIC_PLAY_START':
        console.log('[Music] 再生開始:', payload.title, '/', payload.artist);
        setNowPlaying({
          title: payload.title, artist: payload.artist, type: 'spotify',
          ...(payload.meta?.genres  && { genres:  payload.meta.genres }),
          ...(payload.meta?.mood    && { mood:    payload.meta.mood }),
          ...(payload.meta?.tempo   && { tempo:   payload.meta.tempo }),
          ...(payload.meta?.energy  && { energy:  payload.meta.energy }),
          ...(payload.meta?.key_mode && { keyMode: payload.meta.key_mode }),
        }); break;
      case 'MUSIC_PLAY_END':   console.log('[Music] 再生終了'); setNowPlaying(null); break;
      case 'BGM_START':
        console.log('[BGM] 開始:', payload.title);
        setNowPlaying({ title: payload.title, artist: payload.artist ?? 'BGM', type: 'bgm' }); break;
      case 'BGM_STOP': case 'BGM_END': console.log('[BGM] 停止'); setNowPlaying(null); break;
      case 'CORNER_REQUEST_QUEUED': {
        if (payload.corner)
          setCornerRequests(prev => prev.includes(payload.corner) ? prev : [...prev, payload.corner]);
        const label = payload.corner
          ? `${CORNER_ICONS[payload.corner] ?? '🎙'} ${config?.agents?.[payload.corner]?.name ?? payload.corner}`
          : 'コーナー';
        showInfo(`✅ ${label} を受け付けました`);
        break;
      }
      case 'CORNER_REQUEST_DUPLICATE': showInfo('このリクエストはすでに承っています。'); break;
      case 'CORNER_REQUEST_FULL':      showWarn('リクエストが立て込んでいます。しばらくお待ちください。'); break;
      case 'SPOTIFY_PLAY':
        console.log('[Spotify] 再生指示:', payload.title, '/', payload.artist, payload.uri?.slice(-22));
        handleSpotifyPlay(payload.uri, payload.title, payload.artist, payload.durationMs || 30000); break;
      case 'CLASSIC_PLAYED_LIST': applyListUpdate(setClassicPlayedList, payload.list); break;
      case 'CLASSIC_QUEUE_UPDATE': applyListUpdate(setClassicQueue, payload.queue); break;
      case 'JAZZ_PLAYED_LIST': applyListUpdate(setJazzPlayedList, payload.list); break;
      case 'JAZZ_QUEUE_UPDATE': applyListUpdate(setJazzQueue, payload.queue); break;
      case 'MOOD_PLAYED_LIST': applyListUpdate(setMoodPlayedList, payload.list); break;
      case 'MOOD_QUEUE_UPDATE': applyListUpdate(setMoodQueue, payload.queue); break;
      case 'BEATLES_PLAYED_LIST': applyListUpdate(setBeatlesPlayedList, payload.list); break;
      case 'BEATLES_QUEUE_UPDATE': applyListUpdate(setBeatlesQueue, payload.queue); break;
      case '24YOU_PLAYED_LIST': applyListUpdate(setTwentyFourYouPlayedList, payload.list); break;
      case '24YOU_MODE_UPDATE':
        if (payload.mode) setTwentyFourYouMode(payload.mode);
        setTwentyFourYouAnokoroAge(payload.anokoro_age != null ? String(payload.anokoro_age) : '');
        if (Array.isArray(payload.favorite_artists)) setTwentyFourYouArtists(payload.favorite_artists);
        if (payload.wagamama_request != null) setTwentyFourYouWagamamaRequest(payload.wagamama_request);
        if (payload.language_pref) setTwentyFourYouLanguagePref(payload.language_pref);
        break;
      case 'THEME_ANNOUNCED':
        setTheAnswersTheme(payload.theme || null);
        setTheAnswersClosing(false);
        break;
      case 'PANEL_ASSIGNED':
        if (Array.isArray(payload.panel)) setTheAnswersPanel(payload.panel);
        break;
      case 'HAND_RAISE_ACK':
        if (payload.clientId === theAnswersClientIdRef.current) setTheAnswersHandState('waiting');
        break;
      case 'HAND_RAISE_GRANTED':
        if (payload.clientId === theAnswersClientIdRef.current) setTheAnswersHandState('granted');
        break;
      case 'HAND_RAISE_TIMEOUT':
        if (payload.clientId === theAnswersClientIdRef.current) {
          setTheAnswersHandState('idle');
          showWarn('発言の時間が終了しました。もう一度「✋ 手を挙げる」からお試しください。');
        }
        break;
      case 'SUBMIT_REJECTED_NOT_GRANTED':
        if (payload.clientId === theAnswersClientIdRef.current) {
          showWarn(payload.reason || '発言権がありません。挙手をしてお待ちください。');
        }
        break;
      case 'USER_SPEAKING':
        if (payload.clientId === theAnswersClientIdRef.current) {
          setTheAnswersHandState('idle');
          setTheAnswersTextInput('');
        }
        showInfo(`✅ ご意見がパネルに紹介されました：「${payload.text}」`);
        break;
      case 'MODERATION_REJECTED':
        if (!payload.clientId || payload.clientId === theAnswersClientIdRef.current) {
          showWarn(payload.reason || 'その内容は番組では紹介できません。');
          setTheAnswersHandState('idle');
        }
        break;
      case 'ROUND_TIMER':
        setTheAnswersRoundTimer({ elapsedMs: payload.elapsedMs || 0, targetMs: payload.targetMs || 0, capMs: payload.capMs || 0 });
        break;
      case 'CLOSING':
        setTheAnswersClosing(true);
        break;
      case 'SHOW_ENDED':
        stopRadioStream();
        break;
      case 'CAPTION':
        // 空文字（発話終了のクリア信号）は無視する。表示中のテロップがまだ流れ切っていなければ、
        // 新しい翻訳を末尾につなげて1本の文章として流し直す（曲を挟まない連続発話向け）。
        // 何も表示していなければそのまま新規表示。
        if (payload.text) {
          setCurrentCaption(prev => prev ? `${prev}　／　${payload.text}` : payload.text);
        }
        break;
      case 'SYSTEM_ERROR':
        if (payload.code === 'GOOGLE_CREDIT_DEPLETED') setGoogleCreditAlert(true);
        break;
      case 'EARTHQUAKE_ALERT':
        handleEarthquakeAlert(payload as EarthquakeAlert);
        break;
      case 'HEARTBEAT': break;
      default: break;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ストリーム開始 ─────────────────────────────────────────────────────────
  /**
   * 選択中のチャンネルへ接続し、音声の受信と再生を始める。
   */
  const startRadioStream = async () => {
    if (isStreaming) return;

    // ATTENTION: SDK の音の有効化は、ユーザー操作と同じ同期の呼び出しの中でのみ効く。
    spotifyPlayerRef.current?.activateElement?.().catch(() => {});

    // バックグラウンドタブ検知の Web通知許可をリクエスト（Connect ボタン押下 = ユーザー操作文脈）
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // ATTENTION: ここの標本化周波数は、サーバー側のミキサーと必ず一致させること。WebSocket で
    //            送る生 PCM には周波数の情報が含まれないため、食い違うと早送り・遅回しで再生される。
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioContextClass({ sampleRate: 24000 });
    await audioCtx.resume().catch(console.error);
    audioCtxRef.current = audioCtx;

    if ('locks' in navigator) {
      (navigator as any).locks.request('ai-radio-keepalive', { mode: 'shared' },
        () => new Promise<void>(r => { wakeLockRef.current = r; }));
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'AI Radio', artist: 'Live Broadcast', album: 'AI Radio Station',
      });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('stop', () => stopRadioStream());
    }

    const workletBlob = new Blob([PCM_RING_WORKLET], { type: 'application/javascript' });
    const workletUrl  = URL.createObjectURL(workletBlob);
    try {
      await audioCtx.audioWorklet.addModule(workletUrl);
    } catch {
      audioCtx.close(); audioCtxRef.current = null; return;
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const destCh = Math.min(2, audioCtx.destination.maxChannelCount);
    try {
      audioCtx.destination.channelCount         = destCh;
      audioCtx.destination.channelCountMode      = 'explicit';
      audioCtx.destination.channelInterpretation = 'speakers';
    } catch { /* Firefox */ }

    const workletNode = new AudioWorkletNode(audioCtx, 'pcm-ring-processor', {
      numberOfOutputs: 1, outputChannelCount: [2],
    });
    audioWorkletRef.current = workletNode;

    const masterGain = audioCtx.createGain();
    masterGain.gain.value          = isMutedRef.current ? 0 : volume / 100;
    masterGain.channelCount        = 2;
    masterGain.channelCountMode    = 'explicit';
    masterGain.channelInterpretation = 'speakers';
    (audioCtx as any).masterGain  = masterGain;
    workletNode.connect(masterGain);
    masterGain.connect(audioCtx.destination);

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[WS] 接続');
      setIsStreaming(true);
      startKeepAlive(); // バックグラウンド抑制対策: 無音 AudioContext を開始
      // ATTENTION: プレーヤーが既にあるなら作り直さず、繋ぎ直すだけにすること。作り直すと古い
      //            プレーヤーとその待受が残り、チャンネルを行き来するたびに増えていく。
      if (!spotifyPlayerRef.current) {
        initSpotifyPlayer();
      } else if (!spotifyDeviceRef.current) {
        console.log('[Spotify] チャンネル接続 → デバイスを登録し直します');
        spotifyIntentionalDisconnect.current = false;
        spotifyPlayerRef.current.connect().catch((e: any) => {
          console.error('[Spotify] connect failed:', e?.message);
        });
      }
    };
    ws.onerror = (e) => {
      console.error('[WS] エラー', (e as ErrorEvent).message ?? e);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const totalFrames = event.data.byteLength / 6;
        const floatSamples = new Float32Array(totalFrames * 2);
        for (let i = 0; i < totalFrames; i++) {
          const off = i * 6;
          let vL = view.getUint8(off) | (view.getUint8(off+1)<<8) | (view.getUint8(off+2)<<16);
          if (vL & 0x800000) vL -= 0x1000000;
          floatSamples[i*2] = vL / 8388608.0;
          let vR = view.getUint8(off+3) | (view.getUint8(off+4)<<8) | (view.getUint8(off+5)<<16);
          if (vR & 0x800000) vR -= 0x1000000;
          floatSamples[i*2+1] = vR / 8388608.0;
        }
        audioWorkletRef.current?.port.postMessage(floatSamples.buffer, [floatSamples.buffer]);
      } else {
        try { handleServerCommand(JSON.parse(event.data as string)); } catch { /* ignore */ }
      }
    };

    ws.onclose = () => { console.log('[WS] 切断'); stopRadioStream(); };
  };
  useEffect(() => { startRadioStreamRef.current = startRadioStream; });

  /**
   * 無音のオシレーターを回して、音の処理を止められないようにする。
   *
   * ブラウザはバックグラウンドのタブでは音の処理を止め、Spotify の再生開始を妨げることがある。
   * 極小音量（実質無音）を鳴らし続けることで「このタブは音を使っている」と認識させる。
   */
  const startKeepAlive = () => {
    if (keepAliveRef.current) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001; // 実質無音（完全に0だと最適化で止められる）
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      keepAliveRef.current = { ctx, osc };
    } catch { /* ignore */ }
  };

  const stopKeepAlive = () => {
    if (!keepAliveRef.current) return;
    try { keepAliveRef.current.osc.stop(); keepAliveRef.current.ctx.close(); } catch { /* ignore */ }
    keepAliveRef.current = null;
  };

  // ── ストリーム停止 ─────────────────────────────────────────────────────────
  /**
   * 配信を止め、画面の状態・音声・Spotify の後始末をまとめて行う。
   */
  const stopRadioStream = () => {
    setIsStreaming(false);
    setSelectedChannel(null);
    setActiveSpeaker(null);
    setNowPlaying(null);
    setSubtitle(null);
    setCornerRequests([]);
    setCycleMonitor(null);
    setTicker(null);
    setCurrentCaption(null);
    setInfoView(null);
    setClassicPlayedList([]);
    setClassicQueue([]);
    setJazzPlayedList([]);
    setJazzQueue([]);
    setMoodPlayedList([]);
    setMoodQueue([]);
    setBeatlesPlayedList([]);
    setBeatlesQueue([]);
    setTwentyFourYouPlayedList([]);
    resetTheAnswersState();
    if (wakeLockRef.current) { wakeLockRef.current(); wakeLockRef.current = null; }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    // 再生中の待受をまとめて解除してから止める。
    spotifyPlayCleanupRef.current?.();
    spotifyPlayCleanupRef.current = null;
    // BUGFIX: チャンネルを抜けたら、止めるだけでなく登録も解除する。止めるだけでは登録が残り続け、
    //         翌日そのまま使おうとした時には Spotify 側で既に失効している（実測で548分アイドル）。
    //         「入ったら張る・出たら外す」に揃えると、失効した登録を使う経路そのものが無くなる。
    spotifyIntentionalDisconnect.current = true;
    spotifyPlayerRef.current?.pause()
      .catch(() => { /* 再生していなければ失敗してよい */ })
      .finally(() => { try { spotifyPlayerRef.current?.disconnect(); } catch { /* ignore */ } });
    spotifyDeviceRef.current = null;
    spotifyDeviceReadyAt.current = 0;
    spotifyLastPlayAt.current = 0;
    // SDK が使えず既存デバイスで鳴らしていた場合にも効くよう、Spotify 側へも停止を送る。
    fetch(`${SERVER_URL}/api/spotify/sdk-token`)
      .then(r => r.json())
      .then(({ access_token }) => {
        if (!access_token) return;
        return fetch('https://api.spotify.com/v1/me/player/pause', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${access_token}` },
        });
      })
      .catch(() => {});
    if (audioWorkletRef.current) {
      audioWorkletRef.current.port.postMessage('reset');
      audioWorkletRef.current.disconnect();
      audioWorkletRef.current = null;
    }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    stopKeepAlive();
  };

  // ── 明示的切断（ユーザー操作）：終了処理中表示→サーバー Ready まで待機 ──────
  /**
   * ユーザー操作での切断。終了処理中の表示を出し、サーバーが次の受け入れ準備を終えるまで待つ。
   */
  const handleExplicitStop = () => {
    stopRadioStream();
    if (terminatePollRef.current) clearTimeout(terminatePollRef.current);
    setIsTerminating(true);
    const poll = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/status`);
        if (res.ok) {
          const { ready } = await res.json();
          if (ready) { setIsTerminating(false); return; }
        }
      } catch { /* ignore */ }
      terminatePollRef.current = setTimeout(poll, 1500);
    };
    // サーバーが切断に気づくまで少し待ってから問い合わせを始める。
    terminatePollRef.current = setTimeout(poll, 1000);
  };

  const { sleepTimerEndMs, sleepTimerDisplay, startSleepTimer, cancelSleepTimer } = useSleepTimer(handleExplicitStop);

  /**
   * 音量を Spotify の SDK と Spotify 側の両方へ反映する。
   *
   * ATTENTION: SDK だけだと、サーバー側の音量の同期で上書きされることがあるため両方へ送る。
   * スライダーの連続操作で API の制限に掛からないよう、Spotify 側への送信は間引く。
   *
   * @param vol 音量（0〜1）
   */
  const applySpotifyVolume = (vol: number) => {
    spotifyPlayerRef.current?.setVolume(vol)
      .catch((e: any) => console.warn('[Spotify] setVolume failed:', e));
    if (spotifyVolTimerRef.current) clearTimeout(spotifyVolTimerRef.current);
    spotifyVolTimerRef.current = setTimeout(async () => {
      try {
        const { access_token } = await fetch(`${SERVER_URL}/api/spotify/sdk-token`).then(r => r.json());
        if (!access_token) return;
        await fetch(
          `https://api.spotify.com/v1/me/player/volume?volume_percent=${Math.round(vol * 100)}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${access_token}` } },
        );
      } catch { /* ignore — SDK volume already applied above */ }
    }, 250);
  };

  /**
   * 会話を始めるときに番組の音を一時的に絞る（マイクへの回り込み対策も兼ねる）。
   * ATTENTION: 音量・ミュートの状態そのものは変えず、出力の増幅だけを直接操作すること。
   */
  const duckAudio = () => {
    const gain = (audioCtxRef.current as any)?.masterGain;
    if (gain) gain.gain.value = 0;
    applySpotifyVolume(0);
  };
  /**
   * 絞っていた番組の音を、元の音量へ戻す。
   */
  const unduckAudio = () => {
    const gain = (audioCtxRef.current as any)?.masterGain;
    const vol = isMutedRef.current ? 0 : volumeRef.current / 100;
    if (gain) gain.gain.value = vol;
    applySpotifyVolume(vol);
  };

  /**
   * 音量スライダーの操作を、番組の音と Spotify の両方へ反映する。
   *
   * @param val 音量（0〜100）
   */
  const handleVolumeChange = (val: number) => {
    setVolume(val);
    const gain = (audioCtxRef.current as any)?.masterGain;
    if (gain) gain.gain.value = isMuted ? 0 : val / 100;
    if (!isMuted) applySpotifyVolume(val / 100);
  };

  // ── ミュート切替 ──────────────────────────────────────────────────────────
  /**
   * ミュートを切り替え、番組の音と Spotify の両方へ反映する。
   */
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    const gain = (audioCtxRef.current as any)?.masterGain;
    if (gain) gain.gain.value = next ? 0 : volume / 100;
    applySpotifyVolume(next ? 0 : volume / 100);
  };

  // ── コーナーリクエスト ────────────────────────────────────────────────────
  /**
   * コーナーのリクエストをサーバーへ送る。
   *
   * @param corner リクエストするコーナー
   */
  const sendCornerRequest = (corner: CornerKey) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ event: 'CORNER_REQUEST', corner }));
  };

  // 討論コーナーのオン・オフ。位置づけはコーナーリクエストと同じで、「そのコーナーを議論つきで
  // 拡張して聴きたいか」をリスナーが選ぶもの。
  // ATTENTION: 討論コーナーだけを単独でリクエストする形にしない。取材や開幕アナウンスの
  //            先読みが、直前のコーナーの読み上げ中に行われるため。
  // ATTENTION: 表示名は設定から読むこと（エージェント名・コーナー名をコードに書かない）。
  const DISCUSSION_CORNER_ITEMS: { key: string; fallbackName: string; after: CornerKey }[] = [
    { key: 'news_deep_dive', fallbackName: 'ニュースディープダイブ', after: 'news' },
    { key: 'insight_money',  fallbackName: 'インサイト・マネー',     after: 'finance' },
  ];
  // 項目が無い（古い設定）ときはオン扱い。サーバー側の判定と揃える。
  const isDiscussionCornerEnabled = (key: string) => config?.show?.discussion_corners?.[key]?.enabled !== false;
  const setDiscussionCornerEnabledLocal = (key: string, enabled: boolean) => {
    setConfig(prev => prev ? {
      ...prev,
      show: {
        ...prev.show,
        discussion_corners: {
          ...(prev.show.discussion_corners ?? {}),
          [key]: { ...(prev.show.discussion_corners?.[key] ?? {}), enabled },
        },
      },
    } : prev);
  };
  const toggleDiscussionCorner = async (key: string, fallbackName: string, enabled: boolean) => {
    const name = config?.show?.discussion_corners?.[key]?.name ?? fallbackName;
    setDiscussionCornerEnabledLocal(key, enabled);   // 先に画面へ反映する（押した手応えを優先）
    try {
      const res = await fetch(`${SERVER_URL}/api/discussion-corners/${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showInfo(`${name}を${enabled ? 'オン' : 'オフ'}にしました`);
    } catch {
      setDiscussionCornerEnabledLocal(key, !enabled); // 保存できなかったら元に戻す
      showWarn(`${name}の切り替えを保存できませんでした。`);
    }
  };


  // ── Live リクエスト（種別付き） ─────────────────────────────────────────
  /**
   * Live チャンネルへ、種別（曲・話題・メッセージ）付きのリクエストを送る。
   */
  const sendLiveRequest = async () => {
    if (!directionInput.trim()) return;
    try {
      const userName = config?.show?.user_profile?.name || 'リスナー';
      const prefixes: Record<string, string> = {
        song:    `楽曲リクエスト（${userName}さん）: `,
        topic:   `トーク話題リクエスト（${userName}さん）: `,
        message: `リスナーの${userName}さんからのメッセージ: `,
      };
      const instruction = (prefixes[liveRequestType] ?? '') + directionInput;
      await fetch(`${SERVER_URL}/api/direction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      setDirectionInput('');
      showInfo('✅ リクエストを送信しました');
    } catch { showWarn('送信に失敗しました。'); }
  };


  const {
    infoChatOpen, setInfoChatOpen, infoChatMessages, infoChatInput, setInfoChatInput,
    infoChatLoading, infoChatEndRef, infoChatOpenRef, openInquiryBox, sendInfoChat,
  } = useAiRadioChat({
    serverUrl: SERVER_URL, selectedChannel, isStreaming, isStreamingRef, volumeRef, isMutedRef,
    pendingConnectRef, setSelectedChannel, stopRadioStream, duckAudio, unduckAudio, handleVolumeChange, toggleMute,
    showInfo, showWarn, sendCornerRequest, postListenerRequest: boundPostListenerRequest, startTheAnswersEpisode,
    sendTwentyFourYouMode, sendTwentyFourYouWagamama, cancelSleepTimer, startSleepTimer, setSavedRecipesOpen,
  });

  useKeyboardShortcuts({
    config, selectedChannel, isStreamingRef, volumeRef, pendingConnectRef, infoChatOpenRef,
    setSelectedChannel, setInfoChatOpen, setSavedRecipesOpen, stopRadioStream, startRadioStream,
    openInquiryBox, toggleMute, handleVolumeChange, sendCornerRequest,
    theAnswersCandidates, fetchTheAnswersCandidates,
  });

  const { worldReportPhotos, infoViewContainerRef, replayZoom } = useInfoViewMap(infoView, config);

  // ─── derived values ──────────────────────────────────────────────────────
  const isAudioActive = !!activeSpeaker || !!nowPlaying;
  const _speakerFullName = activeSpeaker
    ? (config?.agents?.[activeSpeaker]?.name ?? classicAgents[activeSpeaker]?.name ?? jazzAgents[activeSpeaker]?.name ?? moodAgents[activeSpeaker]?.name ?? beatlesAgents[activeSpeaker]?.name
        ?? theAnswersPanel.find(p => p.key === activeSpeaker)?.name ?? activeSpeaker)
    : null;
  // 討論番組は出演者ごとの別のキーで発言者を識別するが、アバター画像は出演元チャンネルでの
  // 本来のキーで保存されているため変換する。
  const activeSpeakerAvatarKey = activeSpeaker
    ? (theAnswersPanel.find(p => p.key === activeSpeaker)?.sourceAgentKey ?? activeSpeaker)
    : activeSpeaker;
  const { displayName: speakerName, role: speakerRole } = _speakerFullName
    ? parseAgentName(_speakerFullName)
    : { displayName: null, role: '' };
  const corners: CornerKey[] = [
    'weather', 'traffic', 'news', 'finance',
    'commentator', 'journalist', 'music_dj', 'life_advisor',
    'world_report', 'legal_advisor',
    // ゲスト論客3人
    'comedian', 'doctor', 'marketer',
  ];

  const glowColor     = activeSpeaker ? AGENT_GLOW[activeSpeaker] ?? 'rgba(99,102,241,0.5)' : 'rgba(99,102,241,0.3)';

  // 翻訳テロップを出すチャンネルでのみ、画面下部にバーを表示する。
  const showCaptionBar = !!(currentCaption && selectedChannel === 'jazz');

  // My Secretary は他チャンネルの配信状態とは独立しているため、表示の切り替えに使う値を
  // ここでまとめる。
  const secretaryActive    = selectedChannel === 'secretary';
  const secretaryConnected = secretaryActive && secretaryLive.status === 'connected';
  const secretaryGlowColor = 'rgba(168,85,247,0.5)';
  // 相談先の「本人の声」を再生している間は、アバター・名前・発光色を一時的に相談先のものへ
  // 切り替える（他チャンネルと同じアバターのファイル名の規則をそのまま使う）。
  // ATTENTION: 表示名はサーバーから届く名前をそのまま使うこと（名前をコードに書かない）。
  const secretaryDisplayAvatarKey = secretaryLive.consultingAgentKey ?? 'secretary';
  const secretaryDisplayName = secretaryLive.consultingAgentName || (config?.agents?.secretary?.name || 'My Secretary');
  const secretaryDisplayGlowColor = secretaryLive.consultingAgentKey
    ? (AGENT_GLOW[secretaryLive.consultingAgentKey] ?? secretaryGlowColor)
    : secretaryGlowColor;

  // ─── JSX ────────────────────────────────────────────────────────────────

  // メインの表示カード。左カラムの中で共通に使う。
  const MainCard = (
    <div
      className="relative rounded-2xl overflow-hidden w-full"
      style={{
        aspectRatio: '1 / 1',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: (isStreaming || secretaryConnected)
          ? `0 0 50px ${secretaryActive ? secretaryDisplayGlowColor : glowColor}, 0 6px 24px rgba(0,0,0,0.5)`
          : '0 6px 24px rgba(0,0,0,0.4)',
        transition: 'box-shadow 1s ease',
      }}
    >
      <div className="absolute inset-0 transition-all duration-1000" style={{
        background: secretaryActive
          ? `radial-gradient(circle at 50% 35%, ${secretaryDisplayGlowColor} 0%, rgba(7,9,19,0.96) 65%)`
          : activeSpeaker
            ? `radial-gradient(circle at 50% 35%, ${AGENT_GLOW[activeSpeaker] ?? 'rgba(99,102,241,0.35)'} 0%, rgba(7,9,19,0.96) 65%)`
            : nowPlaying?.albumImage
              ? 'transparent'
              : 'radial-gradient(circle at 50% 35%, rgba(20,25,50,0.8) 0%, rgba(7,9,19,1) 70%)',
      }} />

      {secretaryActive ? (
        <>
          {secretaryConnected && (
            <>
              <div className="absolute inset-8 rounded-full border border-white/5
                animate-[spin_20s_linear_infinite]" />
              <div className="absolute inset-12 rounded-full border border-white/5
                animate-[spin_15s_linear_infinite_reverse]" />
              {secretaryLive.isSpeaking && (
                <div className="absolute inset-6 rounded-full" style={{
                  background: `conic-gradient(from 0deg, transparent 0%, ${secretaryDisplayGlowColor} 25%, transparent 50%)`,
                  animation: 'spin 3s linear infinite', opacity: 0.4,
                }} />
              )}
            </>
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            {!avatarErrors.has(secretaryDisplayAvatarKey) ? (
              <img
                key={secretaryDisplayAvatarKey}
                src={`/avatars/${secretaryDisplayAvatarKey}.png`}
                alt={secretaryDisplayAvatarKey}
                onError={() => onAvatarError(secretaryDisplayAvatarKey)}
                className="w-4/5 h-auto select-none object-contain"
                draggable={false}
                style={{
                  filter: secretaryLive.isSpeaking ? `drop-shadow(0 0 30px ${secretaryDisplayGlowColor})` : 'none',
                  animation: secretaryLive.isSpeaking ? 'subtleBounce 1.2s ease-in-out infinite alternate' : 'none',
                  transition: 'filter 0.5s ease',
                  maxHeight: '75%',
                }}
              />
            ) : (
              <div className="text-6xl select-none leading-none" style={{
                filter: secretaryLive.isSpeaking ? `drop-shadow(0 0 20px ${secretaryDisplayGlowColor})` : 'none',
                animation: secretaryLive.isSpeaking ? 'subtleBounce 1.2s ease-in-out infinite alternate' : 'none',
                transition: 'filter 0.5s ease',
              }}>
                {getAgentEmoji(secretaryDisplayAvatarKey)}
              </div>
            )}
            <div className="text-center px-3">
              <p className="text-base font-bold text-white/90 tracking-wide font-mono mt-1">
                {secretaryDisplayName}
              </p>
              {secretaryLive.status === 'connecting' && (
                <p className="text-xs text-gray-400 mt-1">接続中…</p>
              )}
            </div>
          </div>
        </>
      ) : nowPlaying?.albumImage ? (
        <img src={nowPlaying.albumImage} alt="album"
          className="absolute inset-0 w-full h-full object-cover" />
      ) : (
        <>
          {isStreaming && (
            <>
              <div className="absolute inset-8 rounded-full border border-white/5
                animate-[spin_20s_linear_infinite]" />
              <div className="absolute inset-12 rounded-full border border-white/5
                animate-[spin_15s_linear_infinite_reverse]" />
              {isAudioActive && (
                <div className="absolute inset-6 rounded-full" style={{
                  background: `conic-gradient(from 0deg, transparent 0%, ${glowColor} 25%, transparent 50%)`,
                  animation: 'spin 3s linear infinite', opacity: 0.4,
                }} />
              )}
            </>
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            {!isStreaming ? (
              /* ── オフライン時: AI Radio ロゴ ─────────────────────────── */
              <img src="/logo.png" alt="AI Radio"
                className="w-4/5 h-auto select-none object-contain"
                draggable={false} />
            ) : (
              /* ── ストリーミング中: エージェント / 曲情報 ──────────────── */
              <>
                {(activeSpeaker || nowPlaying?.type === 'bgm') ? (
                  activeSpeakerAvatarKey && !avatarErrors.has(activeSpeakerAvatarKey) ? (
                    <img
                      key={activeSpeakerAvatarKey}
                      src={`/avatars/${activeSpeakerAvatarKey}.png`}
                      alt={activeSpeakerAvatarKey}
                      onError={() => onAvatarError(activeSpeakerAvatarKey)}
                      className="w-4/5 h-auto select-none object-contain"
                      draggable={false}
                      style={{
                        filter: isAudioActive ? `drop-shadow(0 0 30px ${glowColor})` : 'none',
                        animation: isAudioActive ? 'subtleBounce 1.2s ease-in-out infinite alternate' : 'none',
                        transition: 'filter 0.5s ease',
                        maxHeight: '75%',
                      }}
                    />
                  ) : (
                  <div
                    className="text-6xl select-none leading-none"
                    style={{
                      filter: isAudioActive ? `drop-shadow(0 0 20px ${glowColor})` : 'none',
                      animation: isAudioActive ? 'subtleBounce 1.2s ease-in-out infinite alternate' : 'none',
                      transition: 'filter 0.5s ease',
                    }}
                  >
                    {activeSpeakerAvatarKey ? getAgentEmoji(activeSpeakerAvatarKey) : '🎵'}
                  </div>
                  )
                ) : (
                  <img src={selectedChannel ? `/${CHANNEL_LOGO_FILE[selectedChannel] ?? selectedChannel}_logo.png` : '/logo.png'} alt="AI Radio"
                    className="w-4/5 h-auto select-none object-contain"
                    draggable={false} />
                )}
                {speakerName && (
                  <div className="text-center px-3">
                    {speakerRole && (
                      <p className="text-xs text-gray-400 leading-none">
                        {speakerRole}
                      </p>
                    )}
                    <p className="text-base font-bold text-white/90 tracking-wide font-mono mt-1">
                      {speakerName}
                    </p>
                  </div>
                )}
                {nowPlaying && !activeSpeaker && (
                  <div className="text-center px-3">
                    <p className="text-base font-bold text-white/80 truncate">{nowPlaying.title}</p>
                    <p className="text-sm text-white/50 truncate mt-0.5">{nowPlaying.artist}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {isMuted && isStreaming && (
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5
          bg-black/70 backdrop-blur-sm rounded-full px-2.5 py-1 border border-orange-500/40">
          <VolumeX className="w-3.5 h-3.5 text-orange-400" />
          <span className="text-sm font-bold text-orange-400 tracking-widest font-mono">MUTED</span>
        </div>
      )}
    </div>
  );

  return (
    <div
      className="min-h-screen flex flex-col items-center px-4 pb-4"
      style={{
        paddingTop: '20px',
        background: `
          radial-gradient(ellipse at 50% -10%, rgba(99,102,241,0.18) 0%, transparent 55%),
          radial-gradient(ellipse at 90% 90%, rgba(0,180,216,0.08) 0%, transparent 45%),
          var(--bg-base)
        `,
      }}
    >

      {/* ── トースト ─────────────────────────────────────────────────────── */}
      <ToastOverlay
        warnToast={warnToast} infoToast={infoToast} warnLeave={warnLeave} infoLeave={infoLeave}
        raised={!!((ticker && config?.show?.display?.ticker?.enabled !== false) || showCaptionBar)}
      />

      {/* ── 2カラム ラッパー ─────────────────────────────────────────────── */}
      <div className="w-full max-w-5xl flex flex-col md:flex-row gap-4 items-start">

        {/* ══ 左カラム ══ */}
        <div className="flex flex-col gap-2.5 w-full md:w-80 flex-shrink-0">

          {/* ── ヘッダー ────────────────────────────────────────────────── */}
          <div className="flex items-center justify-between px-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <img src="/Bland_logo.png" alt="AI Radio" style={{ width: '100px', height: 'auto', flexShrink: 0 }} draggable={false} />
              {selectedChannel && selectedChannel !== 'live' && (
                <span className="text-xs text-amber-400/80 font-medium truncate">
                  {CHANNELS.find(c => c.id === selectedChannel)?.emoji}{' '}
                  {CHANNELS.find(c => c.id === selectedChannel)?.name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {(isStreaming || secretaryConnected) && (
                <div className="flex-shrink-0 p-2" title="Connected">
                  <Signal className="w-5 h-5" style={{ color: '#34d399' }} />
                </div>
              )}
            </div>
          </div>

          {/* ── メインビジュアルカード ───────────────────────────────────── */}
          {MainCard}

          {/* ── 字幕 / 再生中情報 ─────────────────────────────────────────── */}
          <div className="h-7 overflow-hidden relative px-0.5">
            {subtitle && isStreaming ? (
              <p className="text-sm text-gray-400 whitespace-nowrap"
                style={{ animation: 'marquee 14s linear infinite' }}>
                {subtitle}
              </p>
            ) : nowPlaying && nowPlaying.type !== 'spotify' ? (
              <p className="text-sm text-gray-500 truncate">
                ♪ {nowPlaying.title}{nowPlaying.artist ? ` — ${nowPlaying.artist}` : ''}
              </p>
            ) : null}
          </div>

          {/* ── ボリューム + ミュート ──────────────────────────────────────── */}
          <div className="glass-panel flex flex-col gap-5 py-3 px-3">
            <div className="flex items-center gap-2">
              <button
                onClick={toggleMute}
                className={`flex-shrink-0 p-2 rounded-lg border transition-all active:scale-90
                  ${isMuted
                    ? 'bg-orange-500/20 border-orange-500/50 text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.3)]'
                    : 'bg-white/5 border-white/10 text-gray-500 hover:border-white/20 hover:text-gray-300'}`}
                title={isMuted ? 'ミュート解除' : 'ミュート'}
              >
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              {/* カスタムスライダー：ノブ位置とトラック塗りを完全一致させる */}
              {(() => {
                const KR = 11; // ノブ半径 px
                const KD = KR * 2;
                const handlePtr = (e: React.PointerEvent<HTMLDivElement>) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const trackW = rect.width - KD;
                  const calc = (clientX: number) => {
                    const x = Math.max(0, Math.min(clientX - rect.left - KR, trackW));
                    handleVolumeChange(Math.round((x / trackW) * 100));
                  };
                  calc(e.clientX);
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const onMove = (ev: PointerEvent) => calc(ev.clientX);
                  const onUp   = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup',   onUp);
                  };
                  window.addEventListener('pointermove', onMove);
                  window.addEventListener('pointerup',   onUp);
                };
                return (
                  <div
                    className="relative flex-1 flex items-center select-none"
                    style={{ height: KD, opacity: isMuted ? 0.4 : 1, cursor: 'pointer' }}
                    onPointerDown={handlePtr}
                  >
                    {/* トラック（ノブ半径分だけ左右を内側に） */}
                    <div className="absolute rounded-full"
                      style={{ left: KR, right: KR, height: 6, background: 'rgba(255,255,255,0.1)' }}>
                      {/* フィル */}
                      <div className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${volume}%`, background: isMuted ? 'rgba(255,255,255,0.15)' : '#6366f1' }} />
                    </div>
                    {/* ノブ */}
                    <div className="absolute rounded-full pointer-events-none"
                      style={{
                        left: `calc(${volume / 100} * (100% - ${KD}px))`,
                        width: KD, height: KD,
                        background: 'radial-gradient(circle at 38% 32%, #f1f5f9 0%, #cbd5e1 40%, #64748b 100%)',
                        border: '2px solid rgba(255,255,255,0.55)',
                        boxShadow: '0 3px 8px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 3px rgba(255,255,255,0.45), inset 0 -1px 2px rgba(0,0,0,0.25)',
                      }}
                    />
                  </div>
                );
              })()}
              <span className="font-mono text-gray-200 flex-shrink-0" style={{ fontSize: '2rem', lineHeight: 1, minWidth: '2.8rem', textAlign: 'right' }}>
                {isMuted ? '🔇' : volume}
              </span>
            </div>

            {/* ── 接続/切断 ──────────────────────────────────────────────── */}
            {isTerminating ? (
              <button disabled
                className="w-full py-2.5 rounded-xl font-bold text-base tracking-[0.08em]
                  flex items-center justify-center gap-2
                  bg-gray-800/60 text-gray-400 border border-gray-600/30 cursor-not-allowed"
              >
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                終了処理中...
              </button>
            ) : !isStreaming ? null : (
              <button onClick={handleExplicitStop}
                className="w-full py-2.5 rounded-xl font-bold text-base tracking-[0.08em] uppercase
                  flex items-center justify-center gap-2 transition-all duration-300
                  bg-gradient-to-r from-red-700/80 to-rose-600/80
                  hover:from-red-600 hover:to-rose-500 active:scale-[0.98]
                  shadow-[0_0_8px_rgba(239,68,68,0.2)] border border-red-500/30"
              >
                <Square className="w-3.5 h-3.5" />
                切断
              </button>
            )}
          </div>

          {/* ── スリープタイマー ────────────────────────────────────────────── */}
          {isStreaming && (
            <div className="glass-panel py-3 px-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Moon className={`w-3.5 h-3.5 transition-colors duration-300 ${sleepTimerEndMs !== null ? 'text-indigo-400 drop-shadow-[0_0_4px_rgba(129,140,248,0.9)]' : 'text-slate-500'}`} />
                <span className="text-xs font-semibold text-indigo-200 tracking-wide">スリープタイマー</span>
              </div>
              {sleepTimerEndMs === null ? (
                <div className="grid grid-cols-4 gap-1.5">
                  {[10, 20, 30, 60].map(m => (
                    <button key={m} onClick={() => startSleepTimer(m)}
                      className="py-1.5 rounded-lg text-xs font-bold text-indigo-200
                        bg-indigo-600/15 border border-indigo-500/30
                        hover:bg-indigo-600/30 hover:border-indigo-400/50 active:scale-95
                        transition-all duration-150">
                      {m < 60 ? `${m}分` : `${m/60}時間`}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-indigo-400 shrink-0 animate-pulse" />
                  <span className="text-sm font-bold text-indigo-200 flex-1">{sleepTimerDisplay}</span>
                  <button onClick={cancelSleepTimer}
                    className="p-1 rounded-lg text-indigo-400 hover:text-white
                      hover:bg-indigo-600/30 active:scale-95 transition-all duration-150">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── お問い合わせ・リクエスト（AI Radio管理人） ── */}
          <div className="glass-panel py-3 px-3">
            <button
              disabled={isTerminating}
              onClick={() => openInquiryBox()}
              title={`ショートカット: ${formatShortcut(config?.shortcuts?.open_inquiry ?? DEFAULT_SHORTCUTS.open_inquiry)}`}
              className={`w-full py-2 rounded-xl font-bold text-sm tracking-wide
                flex items-center justify-center gap-2 transition-all duration-200
                ${isTerminating
                  ? 'bg-gray-800/40 border border-gray-600/30 text-gray-600 cursor-not-allowed'
                  : 'bg-indigo-600/20 border border-indigo-500/50 text-indigo-300 hover:bg-indigo-600/35 hover:border-indigo-400/70 hover:text-indigo-200 shadow-[0_0_10px_rgba(99,102,241,0.2)] active:scale-[0.98]'}`}
            >
              💬 お問い合わせ・リクエスト
            </button>
          </div>

          {/* ── 保存したレシピ ──────────────────────────────────────────────── */}
          {savedRecipes.length > 0 && (
            <div className="glass-panel py-3 px-3">
              <button
                onClick={() => setSavedRecipesOpen(true)}
                className="w-full py-2 rounded-xl font-bold text-sm tracking-wide
                  flex items-center justify-center gap-2 transition-all duration-200
                  bg-orange-600/20 border border-orange-500/50 text-orange-300
                  hover:bg-orange-600/35 hover:border-orange-400/70 hover:text-orange-200
                  shadow-[0_0_10px_rgba(249,115,22,0.2)] active:scale-[0.98]"
              >
                📖 保存したレシピ（{savedRecipes.length}）
              </button>
            </div>
          )}

          {/* ── Google クレジット残高不足アラート ─────────────────────────── */}
          {googleCreditAlert && (
            <div className="glass-panel py-3 px-3">
              <div className="flex items-start gap-2">
                <span className="text-lg shrink-0 leading-none mt-0.5">⚠️</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold" style={{ color: '#fbbf24' }}>Googleクレジット残高不足</p>
                  <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>AI機能の一部が停止しています。</p>
                  <a
                    href="https://ai.studio/projects"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs mt-1 block"
                    style={{ color: '#60a5fa' }}
                  >
                    Google AI Studio でチャージ →
                  </a>
                </div>
                <button
                  onClick={() => setGoogleCreditAlert(false)}
                  className="shrink-0 p-0.5 rounded transition-colors"
                  style={{ color: '#6b7280' }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* ── クライアントログ トグルボタン ──────────────────────────── */}
          <button
            onClick={() => { if (showLogs) { setShowLogs(false); } else { openLogViewer(); } }}
            className="flex items-center gap-1 px-1 text-gray-700 hover:text-gray-500
              transition-colors duration-150 self-start"
          >
            <Terminal className="w-2.5 h-2.5 shrink-0" />
            <span className="text-xs font-mono">Client Logs</span>
          </button>

        </div>{/* /左カラム */}

        {/* ══ 右カラム ══ */}
        <div className="flex flex-col gap-2.5 flex-1 min-w-0">

          {/* ── InfoView（Steveのワールドレポート地図） ─────────────────── */}
          {infoView?.type === 'world_report' && config?.show?.display?.info_view?.enabled !== false && (
            <fieldset className="glass-fieldset"
              style={{ borderColor: 'rgba(14,165,233,0.35)', boxShadow: '0 0 20px rgba(14,165,233,0.12)' }}>
              <legend>
                <span className="text-base">🌍</span>
                <span className="text-sm font-mono text-sky-400/80 tracking-widest uppercase">World Report</span>
                <span className="text-sm text-gray-300 ml-2">{infoView.city}</span>
                <button
                  title="ズームをリプレイ"
                  onClick={replayZoom}
                  style={{
                    marginLeft: '8px', padding: '2px 8px', borderRadius: '6px', fontSize: '0.7rem',
                    background: 'rgba(14,165,233,0.15)', border: '1px solid rgba(14,165,233,0.35)',
                    color: '#38bdf8', cursor: 'pointer', lineHeight: 1.4,
                  }}
                >
                  ▶ リプレイ
                </button>
              </legend>
              <div ref={infoViewContainerRef}
                style={{ width: '100%', height: '220px', marginTop: '10px', borderRadius: '8px', overflow: 'hidden' }} />

              {/* 現地写真ストリップ */}
              {worldReportPhotos.length > 0 && (
                <div
                  className="flex gap-2 mt-2 pb-1 overflow-x-auto"
                  style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(14,165,233,0.3) transparent' }}
                >
                  {worldReportPhotos.map((p, i) => (
                    <a key={i} href={p.url} target="_blank" rel="noopener noreferrer"
                      className="flex-shrink-0 rounded-lg overflow-hidden border border-sky-500/20
                        hover:border-sky-400/50 transition-all duration-200 hover:scale-[1.03]"
                      title={p.title}
                    >
                      <img
                        src={p.url}
                        alt={p.title}
                        className="h-28 w-auto object-cover"
                        style={{ maxWidth: '200px' }}
                      />
                    </a>
                  ))}
                </div>
              )}
            </fieldset>
          )}

          {/* ── InfoView（ドレミのレシピカード） ────────────────────────── */}
          {infoView?.type === 'recipe' && config?.show?.display?.info_view?.enabled !== false && (
            <fieldset className="glass-fieldset"
              style={{ borderColor: 'rgba(249,115,22,0.35)', boxShadow: '0 0 20px rgba(249,115,22,0.12)' }}>
              <legend>
                <span className="text-base">🍳</span>
                <span className="text-sm font-mono text-orange-400/80 tracking-widest uppercase ml-1">Recipe</span>
                <span className="text-sm text-gray-300 ml-2">{infoView.name}</span>
                {infoView.name && (
                  <button
                    onClick={() => saveRecipe(infoView)}
                    title={savedRecipes.some(r => r.name === infoView.name) ? '保存済み（更新する）' : 'このレシピを保存'}
                    className="ml-1 p-1 rounded-md text-orange-400/70 hover:text-orange-300 hover:bg-orange-500/10 active:scale-90 transition-all"
                  >
                    {savedRecipes.some(r => r.name === infoView.name)
                      ? <BookmarkCheck className="w-3.5 h-3.5" />
                      : <Bookmark className="w-3.5 h-3.5" />}
                  </button>
                )}
              </legend>
              <div className="mt-3 flex gap-3">
                {/* 左カラム: 料理画像（1:1） */}
                <div className="flex-shrink-0 w-36">
                  {infoView.imageBase64 ? (
                    <img
                      src={`data:${infoView.imageMimeType || 'image/png'};base64,${infoView.imageBase64}`}
                      alt={infoView.name}
                      className="w-36 h-36 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="w-36 h-36 rounded-lg bg-orange-900/20 border border-orange-700/20 flex items-center justify-center">
                      <span className="text-4xl animate-pulse">🍳</span>
                    </div>
                  )}
                </div>
                {/* 右カラム: レシピ内容 */}
                <div className="flex-1 min-w-0 space-y-2 overflow-y-auto" style={{ maxHeight: '220px' }}>
                  {infoView.description && (
                    <p className="text-xs text-gray-400 italic">{infoView.description}</p>
                  )}
                  {infoView.ingredients.length > 0 && (
                    <div>
                      <p className="text-xs font-mono text-orange-400/70 uppercase tracking-wider mb-1">材料</p>
                      <ul className="text-sm text-gray-300 space-y-0.5">
                        {infoView.ingredients.map((ing, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-orange-400/50 flex-shrink-0">•</span>{ing}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {infoView.steps.length > 0 && (
                    <div>
                      <p className="text-xs font-mono text-orange-400/70 uppercase tracking-wider mb-1">作り方</p>
                      <ol className="text-sm text-gray-300 space-y-1.5">
                        {infoView.steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-orange-400/80 font-bold flex-shrink-0 w-4">{i + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </div>
            </fieldset>
          )}

          {/* ── InfoView（天気図パネル） ─────────────────────────────────── */}
          {infoView?.type === 'weather_chart' && config?.show?.display?.info_view?.enabled !== false && (
            <fieldset className="glass-fieldset"
              style={{ borderColor: 'rgba(56,189,248,0.35)', boxShadow: '0 0 20px rgba(56,189,248,0.12)' }}>
              <legend>
                <span className="text-base">🌦</span>
                <span className="text-sm font-mono text-sky-300/80 tracking-widest uppercase ml-1">天気図 / 衛星</span>
                {infoView.chartLabel && (
                  <span className="text-xs text-gray-400 ml-2">天気図: {infoView.chartLabel}</span>
                )}
                <a
                  href="https://www.jma.go.jp/bosai/weather_map/"
                  target="_blank" rel="noopener noreferrer"
                  style={{
                    marginLeft: '8px', padding: '2px 8px', borderRadius: '6px', fontSize: '0.7rem',
                    background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.35)',
                    color: '#7dd3fc', cursor: 'pointer', lineHeight: 1.4, textDecoration: 'none',
                  }}
                >気象庁 ↗</a>
              </legend>
              <div className="mt-2 flex gap-2 flex-wrap items-stretch">
                {/* 地上天気図 */}
                <div className="flex-1 flex flex-col" style={{ minWidth: '240px' }}>
                  <p className="text-xs text-gray-500 mb-1">🗺 地上天気図（6h更新 / 気象庁）</p>
                  <img
                    src={`/api/weather-chart?t=${Math.floor(Date.now() / 3600000)}`}
                    alt="地上天気図（気象庁）"
                    style={{ width: '100%', flex: 1, objectFit: 'cover', borderRadius: '8px' }}
                  />
                  <p className="text-xs text-gray-600 mt-1">© 気象庁 JMA</p>
                </div>
                {/* 衛星画像（WeatherNews） */}
                <div className="flex-1 flex flex-col" style={{ minWidth: '240px' }}>
                  <p className="text-xs text-gray-500 mb-1">
                    🛰 衛星画像（{infoView.satelliteTime || '—'}）
                  </p>
                  <img
                    src={`/api/satellite-image?t=${satTick}`}
                    alt="衛星画像（WeatherNews）"
                    style={{ width: '100%', flex: 1, objectFit: 'cover', borderRadius: '8px', background: '#000' }}
                  />
                  <p className="text-xs text-gray-600 mt-1">© ウェザーニューズ（赤外 10.4μm）</p>
                </div>
              </div>
            </fieldset>
          )}

          {/* ── Spotify 楽曲情報（大） ──────────────────────────────────── */}
          {nowPlaying?.type === 'spotify' && (
            <fieldset className="glass-fieldset"
              style={{ borderColor: 'rgba(34,197,94,0.25)', boxShadow: '0 0 20px rgba(34,197,94,0.12)' }}>
              <legend>
                <span className="text-base">▶</span>
                <span className="text-sm font-mono text-green-400/80 tracking-widest uppercase">SPOTIFY 再生中</span>
              </legend>
              <div className="flex items-center gap-4 mt-3">
                {nowPlaying.albumImage ? (
                  <img
                    src={nowPlaying.albumImage}
                    alt="album"
                    className="w-20 h-20 rounded-xl object-cover flex-shrink-0"
                    style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
                  />
                ) : (
                  <div className="w-20 h-20 rounded-xl bg-green-900/30 border border-green-700/30
                    flex items-center justify-center flex-shrink-0">
                    <span className="text-4xl">🎵</span>
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xl font-bold text-white leading-tight truncate">
                    {nowPlaying.title}
                  </p>
                  <p className="text-base text-green-300/80 truncate mt-1">
                    {nowPlaying.artist}
                  </p>
                  {nowPlaying.albumName && (
                    <p className="text-sm text-green-400/60 truncate mt-1">
                      💿 {nowPlaying.albumName}
                    </p>
                  )}
                  {nowPlaying.releaseYear && (
                    <p className="text-sm text-gray-500 mt-0.5">
                      {nowPlaying.releaseYear}年
                    </p>
                  )}
                </div>
              </div>
              <NowPlayingMeta
                selectedChannel={selectedChannel}
                classicTrack={classicPlayedList[0]}
                jazzTrack={jazzPlayedList[0]}
                moodTrack={moodPlayedList[0]}
                beatlesTrack={beatlesPlayedList[0]}
                twentyFourYouTrack={twentyFourYouPlayedList[0]}
                nowPlaying={nowPlaying}
              />
            </fieldset>
          )}

          {/* ── 未接続: ウェルカムパネル / 接続中: コーナーリクエスト ── */}
          {/* SecretaryはisStreamingを使わない独立セッションのため、選択時点でウェルカム
              パネルをスキップし、他チャンネルと同じ「接続中」側の分岐に直接入る */}
          {(!isStreaming && !secretaryActive) ? (
            <div ref={welcomeCardRef} className="rounded-2xl border border-white/8 bg-black/20 flex flex-col items-center text-center gap-6"
              style={{
                paddingTop: '48px', paddingBottom: '24px', paddingLeft: '24px', paddingRight: '24px',
                maxHeight: welcomeCardMaxHeight, overflow: 'hidden',
              }}>
              <div className="space-y-3" style={{ flexShrink: 0 }}>
                <p className="text-2xl font-semibold text-white">
                  {config?.show?.user_profile?.name || 'リスナー'}さん
                </p>
                <p className="text-lg text-gray-300">いつもAI Radioをお聴きいただきありがとうございます。</p>
                <p className="text-lg text-gray-300">今日も、素敵な番組をお楽しみください。</p>
              </div>
              {/* チャンネル選択（＋The Answersの議題入力）: 挨拶文・フッターは常に画面内へ
                  収め、チャンネル数が増えても増減するこの区間だけを縦スクロールさせる */}
              <div className="w-full flex flex-col gap-6" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
              <div className={`flex flex-col gap-2.5 w-full transition-opacity duration-300 ${isTerminating ? 'opacity-40 pointer-events-none' : ''}`}>
                {isTerminating && (
                  <p className="text-center text-xs text-gray-500 pb-1">終了処理が完了するまでお待ちください</p>
                )}
                {CHANNELS.map(ch => {
                  const isSelected = selectedChannel === ch.id;
                  return (
                    <button
                      key={ch.id}
                      disabled={isTerminating}
                      onClick={() => {
                        if (ch.id === 'secretary') {
                          // Secretaryは他チャンネルのisStreaming/WS配信パイプラインを一切使わない
                          // 独立セッションのため、専用フックのconnect()を直接呼ぶ
                          setSelectedChannel('secretary');
                          if (secretaryLive.status === 'idle' || secretaryLive.status === 'error') {
                            secretaryLive.connect();
                          }
                          return;
                        }
                        if (selectedChannel === ch.id) {
                          // The Answersは議題入力欄の「始める」ボタンから開始する（下の専用ブロック参照）
                          if (ch.id !== 'the_answers') startRadioStream();
                        } else {
                          // The Answersは選択しただけでは接続しない（議題入力を待つ）
                          pendingConnectRef.current = ch.id !== 'the_answers';
                          setSelectedChannel(ch.id);
                          // The Answers選択時、まだ候補を取得していなければウェルカム画面用の
                          // テーマ候補を先読みしておく（「テーマ検索」ボタンで何度でも引き直せる）
                          if (ch.id === 'the_answers' && theAnswersCandidates.length === 0) {
                            fetchTheAnswersCandidates();
                          }
                        }
                      }}
                      className={`flex items-center gap-4 rounded-2xl text-left
                        border transition-all duration-200 group
                        ${isTerminating
                          ? 'border-white/10 bg-black/20 cursor-not-allowed'
                          : isSelected
                            ? 'border-white/30 bg-white/8 active:scale-[0.98]'
                            : 'border-white/10 bg-black/20 hover:border-white/25 hover:bg-white/5 active:scale-[0.98]'}`}
                      style={{ width: '100%', padding: '16px 20px' }}
                    >
                      <span
                        className="text-3xl flex-shrink-0"
                        style={ch.id === 'classic' ? { filter: 'brightness(0) invert(1)', opacity: 0.8 } : undefined}
                      >{ch.id === 'secretary' && secretaryHasPendingNotification ? '🙋‍♀️' : ch.emoji}</span>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0 text-left">
                        <span className="text-white font-bold text-base leading-tight">{ch.name}</span>
                        <span className="text-gray-400 text-xs leading-snug">{ch.subtitle}</span>
                      </div>
                      <svg className={`w-4 h-4 flex-shrink-0 transition-colors ${isSelected && !isTerminating ? 'text-gray-300' : 'text-gray-600 group-hover:text-gray-400'}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  );
                })}
              </div>
              {selectedChannel === 'the_answers' && (
                <fieldset className="glass-fieldset w-full" style={{ textAlign: 'left' }}>
                  <legend>
                    <span className="text-xl">🗣️</span>
                    <span className="text-base font-normal text-gray-300">今日の議題</span>
                  </legend>
                  {theAnswersStarting ? (
                    // 候補選択・自由入力のどちらでも、送信後はテーマが確定済みなので候補UIは
                    // 隠す。裏側では自由入力の場合のみディベート向けの言い換えが1回走るが、
                    // 候補選択の場合も含め、ユーザーには一律「テーマ整理中」と見せてよい。
                    <p className="text-sm text-gray-300 py-4 text-center">テーマ整理中…</p>
                  ) : (
                    <>
                      <p className="text-xs text-gray-400 mt-1">
                        気になるテーマを選ぶか、下に自由に入力してください。
                      </p>
                      <div className="flex flex-col gap-1.5 mt-2">
                        {theAnswersCandidatesLoading && theAnswersCandidates.length === 0 && (
                          <p className="text-xs text-gray-500 py-2 text-center">テーマ候補を探しています…</p>
                        )}
                        {theAnswersCandidates.map((cand, idx) => (
                          <button
                            key={idx}
                            onClick={() => startTheAnswersEpisode(cand)}
                            disabled={theAnswersCandidatesLoading}
                            className="btn btn-dark text-left text-sm"
                            style={{ whiteSpace: 'normal', lineHeight: 1.4 }}
                          >
                            {cand}
                          </button>
                        ))}
                        <button
                          onClick={fetchTheAnswersCandidates}
                          disabled={theAnswersCandidatesLoading}
                          className="btn text-xs self-start mt-0.5"
                          style={{ opacity: 0.7 }}
                        >
                          {theAnswersCandidatesLoading ? '検索中…' : '🔄 テーマ検索（他の候補を見る）'}
                        </button>
                      </div>
                      <textarea
                        value={theAnswersTopicInput}
                        onChange={e => setTheAnswersTopicInput(e.target.value)}
                        placeholder="または、議論したいテーマを自由に入力"
                        rows={2}
                        className="input-field w-full mt-2 text-sm"
                        style={{ resize: 'none' }}
                      />
                      <button
                        onClick={() => startTheAnswersEpisode()}
                        disabled={!theAnswersTopicInput.trim()}
                        className="btn btn-dark w-full mt-2 text-sm"
                      >
                        ▶ ディスカッションを始める
                      </button>
                    </>
                  )}
                </fieldset>
              )}
              </div>
              <div className="border-t border-white/8 pt-4 w-full space-y-1.5" style={{ fontSize: '0.75rem', flexShrink: 0 }}>
                <p className="font-mono text-gray-500">
                  AI Radio&nbsp;&nbsp;Version {__APP_VERSION__}&nbsp;&nbsp;Build: {__BUILD_HASH__}
                </p>
                <p className="text-gray-600">MIT License — © 2026 Masataka Miura</p>
                <p className="text-gray-600">
                  Developed with{' '}
                  <a href="https://claude.ai/claude-code" target="_blank" rel="noopener noreferrer"
                    className="text-gray-500 hover:text-gray-400 underline underline-offset-2">
                    Claude Code
                  </a>
                  {' '}(Anthropic) and Antigravity.
                </p>
              </div>
            </div>
          ) : selectedChannel === 'secretary' ? (
            <SecretaryPanel secretaryLive={secretaryLive} onExitChannel={() => setSelectedChannel(null)} />
          ) : selectedChannel === 'live' ? (
            <fieldset className="glass-fieldset">
              <legend>
                <span className="text-xl">🎙</span>
                <span className="text-base font-normal text-gray-300">コーナーリクエスト</span>
              </legend>
              <div className="grid grid-cols-5 gap-2 mt-3">
                {corners.map(c => {
                  const shortcut = config?.shortcuts?.[CORNER_SHORTCUT_ACTIONS[c]] ?? DEFAULT_SHORTCUTS[CORNER_SHORTCUT_ACTIONS[c]];
                  return (
                    <button
                      key={c}
                      onClick={() => sendCornerRequest(c)}
                      title={`${config?.agents?.[c]?.name ?? c}（${formatShortcut(shortcut)}）`}
                      className={`h-24 rounded-xl flex flex-col items-center justify-center gap-2
                        border bg-black/30 transition-all duration-200 active:scale-90
                        ${CORNER_COLORS[c] ?? 'border-white/10 hover:border-white/30'}`}
                    >
                      {renderCornerAvatar(c, 'w-12 h-12', 'text-2xl')}
                      <span className="text-base font-mono text-gray-400 leading-none">
                        {CORNER_LABELS[c] ?? c}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* スケジュール確認ボタン（別枠） */}
              <button
                onClick={() => sendCornerRequest('activities')}
                title={`スケジュール確認（${formatShortcut(config?.shortcuts?.corner_activities ?? DEFAULT_SHORTCUTS.corner_activities)}）`}
                style={{ marginTop: '12px' }}
                className="w-full h-10 rounded-xl flex items-center justify-center gap-2
                  border border-purple-500/50 hover:border-purple-400 hover:bg-purple-500/15
                  bg-black/30 transition-all duration-200 active:scale-95"
              >
                <span className="text-base leading-none">📅</span>
                <span className="text-sm font-mono text-gray-400">スケジュール確認</span>
              </button>
              {/* ── ディスカッション（討論コーナー）のオン・オフ ── */}
              <div className="border-t border-white/8" style={{ marginTop: '14px', paddingTop: '12px' }}>
                <p className="text-xs text-gray-500" style={{ marginBottom: '8px' }}>
                  ディスカッション（オンにすると、直前のコーナーに続けて議論が流れます）
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {DISCUSSION_CORNER_ITEMS.map(({ key, fallbackName, after }) => {
                    const enabled = isDiscussionCornerEnabled(key);
                    const name = config?.show?.discussion_corners?.[key]?.name ?? fallbackName;
                    const afterName = config?.agents?.[after]?.name ?? CORNER_LABELS[after] ?? after;
                    return (
                      <label
                        key={key}
                        title={`${afterName}のコーナーの後に${name}を流す`}
                        style={{ padding: '10px 12px' }}
                        className={`rounded-xl flex items-center gap-3 border bg-black/30 transition-all duration-200
                          ${enabled ? 'border-emerald-500/50 hover:border-emerald-400' : 'border-white/10 hover:border-white/30'}
                          ${config ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={!config}
                          onChange={e => toggleDiscussionCorner(key, fallbackName, e.target.checked)}
                        />
                        <span className="flex flex-col leading-tight">
                          <span className="text-sm text-gray-200">{name}</span>
                          <span className="text-xs text-gray-500">{afterName}の後</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </fieldset>
          ) : null}

          {/* ── Classic: アンコールリスト ──────────────────────────────────── */}
          {isStreaming && selectedChannel === 'classic' && classicPlayedList.length > 0 && (
            <PlayedHistoryPanel
              icon={<span className="text-xl" style={{ filter: 'brightness(0) invert(1)', opacity: 0.8 }}>🎼</span>}
              accent="indigo"
              list={classicPlayedList}
              onReplay={sendClassicReplayRequest}
              renderRow={track => ({
                title: track.composition,
                subtitle: <>{track.composer}{track.period ? `　${track.period}` : ''}</>,
                performerDisplay: (track.performers && track.performers.length > 0)
                  ? track.performers.join(' / ')
                  : track.conductor || track.ensemble || null,
                performerIcon: '🎻',
              })}
            />
          )}

          {/* ── Jazz: アンコールリスト ────────────────────────────────────── */}
          {isStreaming && selectedChannel === 'jazz' && jazzPlayedList.length > 0 && (
            <PlayedHistoryPanel
              icon={<span className="text-xl">🎷</span>}
              accent="amber"
              list={jazzPlayedList}
              onReplay={sendJazzReplayRequest}
              renderRow={track => ({
                title: track.title,
                subtitle: <>{track.artist}{track.period ? `　${track.period}` : ''}</>,
                performerDisplay: (track.performers && track.performers.length > 0)
                  ? track.performers.join(' / ')
                  : track.artist || null,
                performerIcon: '🎷',
              })}
            />
          )}

          {/* ── Mood: アンコールリスト ───────────────────────────────────── */}
          {isStreaming && selectedChannel === 'mood' && moodPlayedList.length > 0 && (
            <PlayedHistoryPanel
              icon={<span className="text-xl">🌙</span>}
              accent="blue"
              list={moodPlayedList}
              onReplay={sendMoodReplayRequest}
              renderRow={track => ({
                title: track.title,
                subtitle: <>{track.artist}{track.film_title ? `　映画: ${track.film_title}` : ''}</>,
                performerDisplay: (track.performers && track.performers.length > 0)
                  ? track.performers.join(' / ')
                  : track.artist || null,
                performerIcon: '🎻',
              })}
            />
          )}

          {/* ── Beatles: アンコールリスト ─────────────────────────────────── */}
          {isStreaming && selectedChannel === 'beatles' && beatlesPlayedList.length > 0 && (
            <PlayedHistoryPanel
              icon={<span className="text-xl">🪲</span>}
              accent="red"
              list={beatlesPlayedList}
              onReplay={sendBeatlesReplayRequest}
              renderRow={track => ({
                title: track.title,
                subtitle: <>The Beatles{track.album ? `　${track.album}` : ''}</>,
                performerDisplay: (track.performers && track.performers.length > 0)
                  ? track.performers.join(' / ')
                  : null,
                performerIcon: '🪲',
              })}
            />
          )}

          {/* ── リクエスト入力（接続中かつ Classic / Live のみ表示） ────── */}
          {isStreaming && selectedChannel === 'classic' ? (
            <ClassicRequestForm
              era={classicReqEra} mood={classicReqMood} genre={classicReqGenre} free={classicReqFree}
              onEraChange={setClassicReqEra} onMoodChange={setClassicReqMood}
              onGenreChange={setClassicReqGenre} onFreeChange={setClassicReqFree}
              onSend={sendClassicListenerRequest}
            />
          ) : isStreaming && selectedChannel === 'jazz' ? (
            <JazzRequestForm
              style={jazzReqStyle} mood={jazzReqMood} instrument={jazzReqInstrument} free={jazzReqFree}
              onStyleChange={setJazzReqStyle} onMoodChange={setJazzReqMood}
              onInstrumentChange={setJazzReqInstrument} onFreeChange={setJazzReqFree}
              onSend={sendJazzListenerRequest}
            />
          ) : isStreaming && selectedChannel === 'mood' ? (
            <MoodRequestForm free={moodReqFree} onFreeChange={setMoodReqFree} onSend={sendMoodListenerRequest} />
          ) : isStreaming && selectedChannel === 'beatles' ? (
            <BeatlesRequestForm free={beatlesReqFree} onFreeChange={setBeatlesReqFree} onSend={sendBeatlesListenerRequest} />
          ) : isStreaming && selectedChannel === '24you' ? (
            <TwentyFourYouRequestPanel
              mode={twentyFourYouMode} anokoroAge={twentyFourYouAnokoroAge}
              artists={twentyFourYouArtists} artistInput={twentyFourYouArtistInput}
              wagamamaRequest={twentyFourYouWagamamaRequest} languagePref={twentyFourYouLanguagePref}
              profileArtists={config?.show?.user_profile?.favorite_artists ?? []}
              playedList={twentyFourYouPlayedList}
              onModeChange={key => sendTwentyFourYouMode(key, twentyFourYouAnokoroAge)}
              onAnokoroAgeChange={setTwentyFourYouAnokoroAge}
              onAnokoroAgeBlur={() => sendTwentyFourYouMode('anokoro', twentyFourYouAnokoroAge)}
              onArtistInputChange={setTwentyFourYouArtistInput}
              onAddArtist={addTwentyFourYouArtist}
              onRemoveArtist={removeTwentyFourYouArtist}
              onAddArtistFromProfile={addTwentyFourYouArtistFromProfile}
              onWagamamaChange={setTwentyFourYouWagamamaRequest}
              onWagamamaSend={() => sendTwentyFourYouWagamama(twentyFourYouWagamamaRequest)}
              onLanguagePrefChange={sendTwentyFourYouLanguagePref}
            />
          ) : isStreaming && selectedChannel === 'the_answers' ? (
            <TheAnswersRequestPanel
              theme={theAnswersTheme} roundTimer={theAnswersRoundTimer} closing={theAnswersClosing}
              panel={theAnswersPanel} carouselRotation={theAnswersCarouselRotation} activeSpeaker={activeSpeaker}
              avatarErrors={avatarErrors} onAvatarError={onAvatarError}
              handState={theAnswersHandState} textInput={theAnswersTextInput}
              onTextInputChange={setTheAnswersTextInput}
              onRaiseHand={sendTheAnswersRaiseHand} onSubmitText={sendTheAnswersSubmitText}
            />
          ) : isStreaming && selectedChannel === 'live' ? (
            <LiveRequestForm
              requestType={liveRequestType} onRequestTypeChange={setLiveRequestType}
              directionInput={directionInput} onDirectionInputChange={setDirectionInput}
              onSend={sendLiveRequest}
            />
          ) : null}

          {/* ── Classic: リクエストキュー ────────────────────────────── */}
          {isStreaming && selectedChannel === 'classic' && classicQueue.length > 0 && (
            <RequestQueuePanel
              accent="indigo"
              queue={classicQueue}
              renderRow={track => ({ title: track.composition, subtitle: track.composer })}
            />
          )}

          {/* ── Jazz: リクエストキュー ───────────────────────────────── */}
          {isStreaming && selectedChannel === 'jazz' && jazzQueue.length > 0 && (
            <RequestQueuePanel
              accent="amber"
              queue={jazzQueue}
              renderRow={track => ({ title: track.title, subtitle: track.artist })}
            />
          )}

          {/* ── Mood: リクエストキュー ───────────────────────────────── */}
          {isStreaming && selectedChannel === 'mood' && moodQueue.length > 0 && (
            <RequestQueuePanel
              accent="blue"
              queue={moodQueue}
              renderRow={track => ({ title: track.title, subtitle: track.artist })}
            />
          )}

          {/* ── Beatles: リクエストキュー ────────────────────────────── */}
          {isStreaming && selectedChannel === 'beatles' && beatlesQueue.length > 0 && (
            <RequestQueuePanel
              accent="red"
              queue={beatlesQueue}
              renderRow={track => ({ title: track.title, subtitle: 'The Beatles' })}
            />
          )}

          {/* ── スケジュール ─────────────────────────────────────────── */}
          {isStreaming && (cycleMonitor || cornerRequests.length > 0) && (
            <fieldset className="glass-fieldset">
              <legend>
                <span className="text-xl">🗓️</span>
                <span className="text-base font-normal text-gray-300">スケジュール</span>
              </legend>
              <div className="flex flex-col gap-3 mt-3">

              {/* REQUEST 行 — ユーザーリクエスト優先キュー */}
              {cornerRequests.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-mono font-bold text-purple-400 tracking-widest">REQUEST</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {cornerRequests.map((c, i) => (
                      <div key={i} className="flex items-center gap-2 w-[120px] flex-shrink-0
                        bg-purple-500/20 border border-purple-400/60 rounded-lg px-2.5 py-2
                        animate-pulse">
                        {renderCornerAvatar(c, 'w-6 h-6', 'text-lg')}
                        <span className="flex-1 text-center text-sm font-bold text-purple-200
                          font-mono leading-tight truncate">
                          {CORNER_LABELS[c] ?? c}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* REQUEST と NOW の区切り */}
              {cornerRequests.length > 0 && cycleMonitor?.current && (
                <div className="border-t border-white/10" />
              )}

              {/* NOW 行 — ラベル上・全幅バー */}
              {cycleMonitor?.current && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-mono font-bold text-yellow-400 tracking-widest">NOW</span>
                  <div className="flex items-center gap-3
                    bg-yellow-400/25 border border-yellow-300/70 rounded-xl px-4 py-2.5">
                    {renderCornerAvatar(cycleMonitor.current, 'w-8 h-8', 'text-xl')}
                    <span className="text-base font-bold text-yellow-100 font-mono">
                      {CORNER_LABELS[cycleMonitor.current] ?? cycleMonitor.current}
                    </span>
                  </div>
                </div>
              )}

              {/* NOW と NEXT の区切り */}
              {cycleMonitor?.current && cycleMonitor?.next && cycleMonitor.next !== cycleMonitor.current && (
                <div className="border-t border-white/10 my-1" />
              )}

              {/* NEXT 行 + 以降のキューを横並びラップ */}
              {(() => {
                // next が current と同じ場合は先頭をスキップしてキューから表示
                const showNext = cycleMonitor?.next && cycleMonitor.next !== cycleMonitor.current;
                const queueItems = cycleMonitor?.queue.slice(0, 8) ?? [];
                if (!showNext && queueItems.length === 0) return null;
                return (
                  <div className="flex items-start gap-2">
                    <span className="text-sm font-mono font-bold text-sky-400 tracking-widest
                      w-14 flex-shrink-0 pt-2">NEXT</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {/* NEXT アイテム（current と重複しない場合のみ） */}
                      {showNext && (
                        <div className="flex items-center gap-2 w-[120px] flex-shrink-0
                          bg-sky-500/20 border border-sky-400/60 rounded-lg px-2.5 py-2">
                          {renderCornerAvatar(cycleMonitor!.next!, 'w-6 h-6', 'text-lg')}
                          <span className="flex-1 text-center text-sm font-bold text-sky-200
                            font-mono leading-tight truncate">
                            {CORNER_LABELS[cycleMonitor!.next!] ?? cycleMonitor!.next}
                          </span>
                        </div>
                      )}
                      {/* キュー */}
                      {queueItems.flatMap((c, i) => [
                        // NEXT バッジがある、または2番目以降のキューアイテムの場合のみ区切り▶を表示
                        (showNext || i > 0) ? <span key={`qa${i}`} className="text-gray-500 text-base flex-shrink-0">▶</span> : null,
                        <div key={`q${i}`} className="flex items-center gap-2 w-[120px] flex-shrink-0
                          bg-white/5 border border-white/15 rounded-lg px-2.5 py-2">
                          {renderCornerAvatar(c, 'w-6 h-6', 'text-lg')}
                          <span className="flex-1 text-center text-sm font-mono text-gray-300
                            leading-tight truncate">
                            {CORNER_LABELS[c] ?? c}
                          </span>
                        </div>,
                      ]).filter(Boolean)}
                    </div>
                  </div>
                );
              })()}
              </div>
            </fieldset>
          )}

          {/* ── クライアントログ 表示エリア ─────────────────────────────── */}
          {showLogs && <LogViewerPanel logEntries={logEntries} logEndRef={logEndRef} />}

        </div>{/* /右カラム */}

      </div>

      {/* ── CSS ──────────────────────────────────────────────────────────── */}
      {/* ── ティッカーバー ───────────────────────────────────────────────── */}
      {ticker && config?.show?.display?.ticker?.enabled !== false && (() => {
        // コーナー別テーマ（traffic_structured は traffic と同じテーマ）
        const _themeKey = ticker.type === 'traffic_structured' ? 'traffic' : ticker.type;
        const theme = ({
          finance: { icon: '📈', label: 'MARKET',  border: 'rgba(16,185,129,0.35)', labelColor: '#10b981' },
          weather: { icon: '🌤', label: 'WEATHER', border: 'rgba(56,189,248,0.35)', labelColor: '#38bdf8' },
          news:    { icon: '📰', label: 'NEWS',    border: 'rgba(34,197,94,0.35)',  labelColor: '#22c55e' },
          traffic: { icon: '🚦', label: 'TRAFFIC', border: 'rgba(234,179,8,0.35)', labelColor: '#eab308' },
        } as Record<string, { icon: string; label: string; border: string; labelColor: string }>)[_themeKey]
          ?? { icon: '📡', label: 'INFO', border: 'rgba(100,116,139,0.35)', labelColor: '#94a3b8' };

        // スクロールコンテンツを文字列配列で組み立て
        let segments: { text: string; color?: string }[] = [];
        const SEP = { text: '｜', color: '#1e3a5f' };

        if (ticker.type === 'finance') {
          ticker.items.forEach((item, i) => {
            const up  = item.diff > 0.0001, dn = item.diff < -0.0001;
            const clr = up ? '#10b981' : dn ? '#ef4444' : '#94a3b8';
            const arr = up ? '▲' : dn ? '▼' : '━';
            const price   = Number(item.price.toFixed(item.dec)).toLocaleString('ja-JP');
            const diffStr = (item.diff >= 0 ? '+' : '') + item.diff.toFixed(item.dec);
            const pctStr  = (item.pct  >= 0 ? '+' : '') + item.pct.toFixed(2) + '%';
            if (i > 0) segments.push(SEP);
            segments.push({ text: `${item.key}:`, color: '#f1f5f9' });
            segments.push({ text: ` ${price}${item.unit} ` });
            segments.push({ text: `${arr}${diffStr}（${pctStr}）`, color: clr });
          });
        } else if (ticker.type === 'weather') {
          const t = ticker;
          // 緊急情報を先頭に
          if (t.hasQuake)   segments.push({ text: `🔴 ${t.quakeSummary ?? '地震情報あり'}`, color: '#ef4444' }, SEP);
          if (t.hasTyphoon) segments.push({ text: `🌀 ${t.typhoonSummary ?? '台風情報あり'}`, color: '#f97316' }, SEP);
          if (t.hasWarning) segments.push({ text: `⚠️ ${t.warningSummary ?? '気象警報'}`, color: '#eab308' }, SEP);
          // 居住地の外で出ている特別警報（レベル5）。居住地は対象外だが命に関わる事態のため表示する。
          if (t.hasNationalAlert) segments.push({ text: `🆘 ${t.nationalAlertSummary ?? '他県に特別警報'}`, color: '#ef4444' }, SEP);
          // 通常天気
          segments.push({ text: `📍 ${t.location}`, color: '#94a3b8' });
          segments.push({ text: `  現在 ${t.temp}℃ ${t.desc}` });
          segments.push({ text: `  本日 最高${t.todayMax}℃・最低${t.todayMin}℃` });
          if (t.tomorrow) {
            segments.push(SEP);
            segments.push({ text: `明日(${t.tomorrow.month}/${t.tomorrow.day}) 最高${t.tomorrow.max}℃・最低${t.tomorrow.min}℃` });
          }
        } else if (ticker.type === 'news') {
          ticker.items.forEach((item, i) => {
            if (i > 0) segments.push(SEP);
            segments.push({ text: item.title, color: '#f1f5f9' });
          });
        } else if (ticker.type === 'traffic') {
          // Phase 1: コーナー開始時（LLM発話生成中）— 対象エリア名を表示
          const t = ticker;
          segments.push({ text: `📍 ${t.location}`, color: '#94a3b8' });
          t.areas.forEach(a => { segments.push(SEP); segments.push({ text: `🛣 ${a}` }); });
          if (t.nearestStation) { segments.push(SEP); segments.push({ text: `🚉 ${t.nearestStation}周辺路線` }); }
          t.airports.forEach(a => { segments.push(SEP); segments.push({ text: `✈️ ${a}` }); });
        } else if (ticker.type === 'traffic_structured') {
          // Phase 2: LLM 発話と並行して構造抽出完了後 — 道路/鉄道/航空を整形表示
          const ICONS = { road: '🛣', rail: '🚃', air: '✈️' };
          const COLORS = { road: '#fde68a', rail: '#93c5fd', air: '#67e8f9' };
          ticker.items.forEach((item, i) => {
            if (i > 0) segments.push(SEP);
            segments.push({ text: `${ICONS[item.category]} ${item.text}`, color: COLORS[item.category] });
          });
        }

        // 2倍に複製してシームレスループ
        const doubled = [...segments, { text: '　　　　', color: undefined }, ...segments];

        // 全角文字は半角の2倍幅のためビジュアル幅として2カウント
        const visualWidth = (text: string) =>
          [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0x7F ? 2 : 1), 0);
        const totalVisual = segments.reduce((n, s) => n + visualWidth(s.text), 0);
        const scrollSec = Math.max(5, Math.round(totalVisual / (config?.show?.display?.ticker?.scroll_speed ?? 12)));
        // 中身が変わった時だけ入場アニメーションをやり直すための識別キー
        const contentKey = `${ticker.type}:${segments.map(s => s.text).join('§')}`;

        return (
          <div className="fixed bottom-0 left-0 right-0 z-40 flex items-center"
            style={{ height: 52, background: 'rgba(8,12,24,0.97)', borderTop: `1px solid ${theme.border}` }}>
            {/* ラベル */}
            <div className="flex-shrink-0 flex items-center gap-1 px-4 border-r"
              style={{ borderColor: theme.border, height: '100%' }}>
              <span style={{ fontSize: 20 }}>{theme.icon}</span>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: theme.labelColor, letterSpacing: 1 }}>{theme.label}</span>
            </div>
            {/* スクロール */}
            <LoopingTicker contentKey={contentKey} loopDurationSec={scrollSec}>
              {doubled.map((seg, idx) => (
                <span key={idx} style={{
                  fontSize: `${config?.show?.display?.ticker?.font_size_rem ?? 1.5}rem`, fontFamily: 'ui-monospace,monospace',
                  color: seg.color ?? '#cbd5e1',
                  padding: seg.text === '｜' ? '0 20px' : undefined,
                }}>{seg.text}</span>
              ))}
            </LoopingTicker>
          </div>
        );
      })()}

      {/* ── 翻訳テロップ（Jazz: Louisの英語セリフの日本語訳） ─────────────────── */}
      {showCaptionBar && currentCaption && (
        <div className="fixed bottom-0 left-0 right-0 z-40 flex items-center"
          style={{ height: 52, background: 'rgba(8,12,24,0.97)', borderTop: '1px solid rgba(45,212,191,0.35)' }}>
          <div className="flex-shrink-0 flex items-center gap-1 px-4 border-r"
            style={{ borderColor: 'rgba(45,212,191,0.35)', height: '100%' }}>
            <span style={{ fontSize: 20 }}>💬</span>
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#2dd4bf', letterSpacing: 1 }}>訳</span>
          </div>
          <CaptionTicker key={captionSessionId} text={currentCaption} pxPerSec={jazzCaptionSpeed} onDone={() => setCurrentCaption(null)} />
        </div>
      )}

      {/* ── 保存したレシピ一覧 ──────────────────────────────────────────────── */}
      {savedRecipesOpen && (
        <SavedRecipesModal
          savedRecipes={savedRecipes}
          onClose={() => setSavedRecipesOpen(false)}
          onRemove={removeSavedRecipe}
        />
      )}

      {/* ── AI Radio管理人（お問い合わせ・リクエスト共通窓口） ──────────────── */}
      {infoChatOpen && (
        <AiRadioChatModal
          onClose={() => setInfoChatOpen(false)}
          messages={infoChatMessages}
          loading={infoChatLoading}
          endRef={infoChatEndRef}
          input={infoChatInput}
          onInputChange={setInfoChatInput}
          onSend={() => sendInfoChat()}
        />
      )}

      <style>{`
        @keyframes marquee {
          0%   { transform: translateX(110%); }
          100% { transform: translateX(-110%); }
        }
        @keyframes subtleBounce {
          from { transform: translateY(0px) scale(1); }
          to   { transform: translateY(-4px) scale(1.05); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>

      {/* ── システム異常バナー（残高不足など。ウェルカム画面でも常に出る） ───── */}
      <SystemAlertBanner alerts={systemAlerts} />

      {/* ── 緊急地震速報オーバーレイ ──────────────────────────────────── */}
      {earthquakeAlert && <EarthquakeAlertOverlay alert={earthquakeAlert} onClose={() => { window.speechSynthesis?.cancel(); setEarthquakeAlert(null); }} />}
    </div>
  );
}
