/**
 * @file プレイヤーの「AI Radio 管理人」窓口（お問い合わせ・リクエスト）の状態と処理
 *
 * 「💬 お問い合わせ・リクエスト」の吹き出しで、リスナーが書いた文をサーバーの分類器
 * （POST /api/text-command、server/routes/text-command-routes.js）へ送り、返ってきた意図
 * （intent）に応じてチャンネル切り替え・音量・コーナーのリクエスト・録音・スリープタイマーなどを
 * 実行する。質問への答えはチャット欄に表示し、管理人の音声（WAV）があれば番組の音を下げて再生する。
 * 利用元は Player.tsx。
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

import { useEffect, useRef, useState } from 'react';
import type { CornerKey, TwentyFourYouMode } from '../types';
import { CHANNELS } from '../constants';
import type { ChannelId } from '../constants';

/** 分類器が返す実行内容（意図・引数・リスナーへ見せる文）。 */
type VoiceCommandData = { intent?: string; params?: Record<string, any>; message?: string };

/** useAiRadioChat が使う、プレイヤー側の状態と操作。 */
export interface UseAiRadioChatDeps {
  serverUrl: string;
  selectedChannel: ChannelId | null;
  isStreaming: boolean;
  isStreamingRef: React.RefObject<boolean>;
  volumeRef: React.RefObject<number>;
  isMutedRef: React.RefObject<boolean>;
  pendingConnectRef: React.RefObject<boolean>;
  setSelectedChannel: (id: ChannelId) => void;
  stopRadioStream: () => void;
  duckAudio: () => void;
  unduckAudio: () => void;
  handleVolumeChange: (val: number) => void;
  toggleMute: () => void;
  showInfo: (msg: string) => void;
  showWarn: (msg: string) => void;
  sendCornerRequest: (corner: CornerKey) => void;
  postListenerRequest: (
    channelSlug: string, requestText: string, onSuccess: () => void,
    successMessage: string, errorMessage?: string,
  ) => void;
  startTheAnswersEpisode: (topicOverride?: string) => void;
  sendTwentyFourYouMode: (mode: TwentyFourYouMode, anokoroAge?: string) => void;
  sendTwentyFourYouWagamama: (request: string) => void;
  cancelSleepTimer: () => void;
  startSleepTimer: (minutes: number) => void;
  setSavedRecipesOpen: (open: boolean) => void;
}

/**
 * AI Radio 管理人の窓口（お問い合わせ・リクエスト共通）を扱うフック。
 *
 * @param deps プレイヤー側の状態と操作
 * @returns 窓口の開閉・メッセージ・入力欄の状態と、窓口を開く・送信する関数
 */
export function useAiRadioChat(deps: UseAiRadioChatDeps) {
  const {
    serverUrl, selectedChannel, isStreaming, isStreamingRef, volumeRef, isMutedRef,
    pendingConnectRef, setSelectedChannel, stopRadioStream, duckAudio, unduckAudio, handleVolumeChange,
    toggleMute, showInfo, showWarn, sendCornerRequest, postListenerRequest, startTheAnswersEpisode,
    sendTwentyFourYouMode, sendTwentyFourYouWagamama, cancelSleepTimer, startSleepTimer, setSavedRecipesOpen,
  } = deps;

  const [infoChatOpen,     setInfoChatOpen]     = useState(false);
  const [infoChatMessages, setInfoChatMessages] = useState<{ role: 'user' | 'bot'; text: string }[]>([
    { role: 'bot', text: 'AI Radio管理人です。\nご質問・チャンネル操作・曲や話題のリクエストなど、何でもどうぞ。' },
  ]);
  const [infoChatInput,    setInfoChatInput]    = useState('');
  const [infoChatLoading,  setInfoChatLoading]  = useState(false);
  const infoChatEndRef = useRef<HTMLDivElement | null>(null);
  // キーボードショートカット（open_inquiry）の useEffect の中からも最新の開閉状態を読むための ref
  const infoChatOpenRef = useRef(false);
  // 管理人の音声を鳴らす専用の AudioContext。
  // ATTENTION: fetch が終わってから（操作から時間が経ってから）new Audio().play() すると、
  // ブラウザの自動再生ブロックで無音になることがある。クリックや Enter の直後の同期区間で
  // resume() しておき、以降はこの Context で再生する。
  const administratorAudioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => { infoChatOpenRef.current = infoChatOpen; }, [infoChatOpen]);

  // メッセージが増えたら末尾までスクロールする
  useEffect(() => {
    infoChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [infoChatMessages, infoChatLoading]);

  /**
   * 分類器が返した意図を実行する（チャンネル切り替え・音量・コーナーや内容のリクエスト・録音など）。
   *
   * @param data 分類器の応答（意図・引数・表示する文）
   */
  const dispatchVoiceCommand = (data: VoiceCommandData) => {
    const { intent, params = {}, message } = data || {};
    const switchChannel = (id: ChannelId) => {
      if (selectedChannel === id && isStreaming) return;
      if (isStreaming) stopRadioStream();
      pendingConnectRef.current = true;
      setSelectedChannel(id);
    };
    // チャンネルの切り替えとリクエストを1文で頼まれたときは、切り替え（WebSocket の接続）が
    // 終わるのを待ってからリクエストを送る。8秒待っても終わらなければ諦める。
    const waitForStreaming = (timeoutMs = 8000): Promise<boolean> => {
      return new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
          if (isStreamingRef.current) { resolve(true); return; }
          if (Date.now() - start > timeoutMs) { resolve(false); return; }
          setTimeout(check, 200);
        };
        check();
      });
    };
    switch (intent) {
      case 'channel_switch': {
        const target = CHANNELS.find(c => c.id === params.channel);
        if (!target) { showWarn('聞き取れませんでした'); break; }
        switchChannel(target.id);
        showInfo(`✅ ${message || `${target.name}に切り替えました`}`);
        break;
      }
      case 'stop':
        stopRadioStream();
        showInfo(`✅ ${message || '停止しました'}`);
        break;
      case 'the_answers_start':
        startTheAnswersEpisode(params.topic);
        if (message) showInfo(`✅ ${message}`);
        break;
      case 'volume_relative': {
        const delta = params.direction === 'down' ? -10 : 10;
        handleVolumeChange(Math.max(0, Math.min(100, volumeRef.current + delta)));
        showInfo(`✅ ${message || '音量を変更しました'}`);
        break;
      }
      case 'volume_absolute': {
        const val = Number(params.value);
        if (Number.isFinite(val)) {
          handleVolumeChange(Math.max(0, Math.min(100, val)));
          showInfo(`✅ ${message || '音量を変更しました'}`);
        } else {
          showWarn('聞き取れませんでした');
        }
        break;
      }
      case 'mute_toggle': {
        const wantMute = params.state === 'mute';
        if (wantMute !== isMutedRef.current) toggleMute();
        showInfo(`✅ ${message || (wantMute ? 'ミュートしました' : 'ミュートを解除しました')}`);
        break;
      }
      case '24you_mode': {
        if (selectedChannel !== '24you' || !isStreaming) switchChannel('24you');
        if (params.mode === 'wagamama' && params.wagamama_request) {
          sendTwentyFourYouWagamama(params.wagamama_request);
        } else if (params.mode) {
          sendTwentyFourYouMode(params.mode, params.anokoro_age != null ? String(params.anokoro_age) : undefined);
        }
        if (message) showInfo(`✅ ${message}`);
        break;
      }
      case 'corner_request': {
        if (!params.corner) { showWarn(message || '聞き取れませんでした'); break; }
        const runCornerRequest = () => {
          sendCornerRequest(params.corner as CornerKey);
          showInfo(`✅ ${message || 'コーナーをリクエストしました'}`);
        };
        if (selectedChannel === 'live' && isStreaming) {
          runCornerRequest();
        } else {
          // コーナーは Live だけにあるので、Live 以外や放送していないときは Live へ切り替え、
          // 接続を待ってからリクエストする
          switchChannel('live');
          waitForStreaming().then(ok => {
            if (ok) runCornerRequest();
            else showWarn('チャンネルの切り替えに時間がかかっています。もう一度お試しください');
          });
        }
        break;
      }
      case 'content_request': {
        const text = params.text;
        const targetChannel = (params.channel as ChannelId) || selectedChannel;
        const isContentRequestChannel = (id: ChannelId | null) =>
          !!id && (['live', 'classic', 'jazz', 'mood', 'beatles'] as ChannelId[]).includes(id);

        if (!text || !isContentRequestChannel(targetChannel)) {
          // 24You・The Answers やチャンネルが分からないときは、内容のリクエストを届ける先が無い。
          // サーバーはこの場合に決まった案内文を message に入れて返すので、それを表示する。
          showWarn(message || '申し訳ありません。ご依頼いただいたリクエストは処理できません');
          break;
        }
        const runContentRequest = () => {
          if (targetChannel === 'live') {
            fetch(`${serverUrl}/api/direction`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              // instantMusicCheck: 乱入と同じく、音楽のキーワードがあればすぐキューへ入れる処理を
              // サーバーにさせる（曲のリクエストが1周早く反映される）
              body: JSON.stringify({ instruction: `リスナーからのリクエスト: ${text}`, instantMusicCheck: true }),
            }).catch(() => {});
            showInfo(`✅ ${message || 'リクエストを送信しました'}`);
          } else {
            postListenerRequest(targetChannel!, text, () => {}, `✅ ${message || 'リクエストを送信しました'}`);
          }
        };
        if (selectedChannel === targetChannel && isStreaming) {
          runContentRequest();
        } else {
          // 別のチャンネルを指定されたとき、またはそのチャンネルを放送していないときは、
          // 先に切り替えて接続を待つ
          switchChannel(targetChannel!);
          waitForStreaming().then(ok => {
            if (ok) runContentRequest();
            else showWarn('チャンネルの切り替えに時間がかかっています。もう一度お試しください');
          });
        }
        break;
      }
      case 'recording_start': {
        const targetChannel = (params.channel as string) || selectedChannel;
        if (!targetChannel || targetChannel === '24you') {
          showWarn(message || '24/Youチャンネルは録音に対応していません');
        } else {
          fetch(`${serverUrl}/api/recordings/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: targetChannel }),
          }).then(async (res) => {
            const d = await res.json();
            if (!res.ok || d.error) showWarn(d.error || '録音の開始に失敗しました');
            else showInfo(`⏺ ${message || '録音を開始しました'}`);
          }).catch(() => showWarn('録音の開始に失敗しました'));
        }
        break;
      }
      case 'recording_stop': {
        fetch(`${serverUrl}/api/recordings/stop`, { method: 'POST' })
          .then(async (res) => {
            const d = await res.json();
            showInfo(d.ok ? `⏺ ${message || '録音を停止しました'}` : (d.message || message || '録音は開始されていません'));
          }).catch(() => showWarn('録音の停止に失敗しました'));
        break;
      }
      case 'sleep_timer': {
        const minutes = params.minutes;
        if (minutes == null) {
          cancelSleepTimer();
          showInfo(`✅ ${message || 'スリープタイマーを解除しました'}`);
        } else {
          const val = Number(minutes);
          if (Number.isFinite(val) && val > 0) {
            startSleepTimer(val);
            showInfo(`✅ ${message || `${val}分後に停止するよう設定しました`}`);
          } else {
            showWarn(message || '聞き取れませんでした');
          }
        }
        break;
      }
      case 'show_recipes':
        setSavedRecipesOpen(true);
        if (message) showInfo(`✅ ${message}`);
        break;
      case 'the_answers_topic_suggest': {
        fetch(`${serverUrl}/api/the_answers/theme-candidates`)
          .then(res => res.json())
          .then(d => {
            const themes: string[] = Array.isArray(d.themes) ? d.themes : [];
            const text = themes.length > 0
              ? `こんなテーマはいかがですか？\n${themes.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
              : 'テーマ候補の取得に失敗しました。もう一度お試しください。';
            setInfoChatMessages(prev => [...prev, { role: 'bot', text }]);
          })
          .catch(() => {
            setInfoChatMessages(prev => [...prev, { role: 'bot', text: 'テーマ候補の取得に失敗しました。もう一度お試しください。' }]);
          });
        break;
      }
      case 'info_query':
        // 答えの文は sendInfoChat がすでにチャット欄へ出しているので、ここでは何もしない
        break;
      default:
        showWarn(message || '聞き取れませんでした');
    }
  };

  /**
   * 管理人の音声を鳴らす AudioContext を用意し、止まっていれば再開する。
   *
   * クリックや Enter の同期区間で呼ぶと、fetch の後で再生しても自動再生ブロックにかからない
   * （一度 resume した Context は、その後も再開したまま使える）。
   *
   * @returns 用意できた AudioContext（作れなければ null）
   */
  const ensureAdministratorAudioContext = (): AudioContext | null => {
    try {
      if (!administratorAudioCtxRef.current) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        administratorAudioCtxRef.current = new AudioContextClass();
      }
      const ctx = administratorAudioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    } catch { return null; }
  };

  /**
   * 管理人の音声（base64 の WAV）を再生し、鳴り終わるまで待てる Promise を返す。
   * 再生に失敗しても reject せず、そのまま resolve する。
   *
   * @param speechWavBase64 音声（無ければ何もしない）
   * @returns 鳴り終わったら（または失敗したら）解決する Promise
   */
  const playAdministratorSpeech = (speechWavBase64?: string): Promise<void> => {
    if (!speechWavBase64) return Promise.resolve();
    const ctx = administratorAudioCtxRef.current;
    if (!ctx) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const binary = atob(speechWavBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        ctx.decodeAudioData(bytes.buffer, (buffer) => {
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.onended = () => resolve();
          source.start();
        }, () => resolve());
      } catch { resolve(); }
    });
  };

  /**
   * 窓口を開いた直後の挨拶（サーバーがディスクにキャッシュしている WAV）を取って再生する。
   * チャンネルや放送の状況に関わらず、リスナーの名前で呼びかける挨拶になる。
   * 取れなくても鳴らなくても、窓口の対話は続けられるので失敗は無視する。
   */
  const playInquiryGreeting = async () => {
    try {
      const r = await fetch(`${serverUrl}/api/text-command/greeting`);
      const d = await r.json();
      if (d.speechWavBase64) {
        duckAudio();
        await playAdministratorSpeech(d.speechWavBase64);
        unduckAudio();
      }
    } catch { /* 挨拶が鳴らなくても対話自体は継続できる */ }
  };

  /**
   * 「💬 お問い合わせ・リクエスト」の窓口を開き、挨拶を鳴らす（すでに開いていれば何もしない）。
   * クリックやショートカットの同期区間で AudioContext を用意するので、挨拶が自動再生ブロックにかからない。
   */
  const openInquiryBox = () => {
    if (infoChatOpenRef.current) return;
    ensureAdministratorAudioContext();
    setInfoChatOpen(true);
    playInquiryGreeting();
  };

  /**
   * 入力した文を分類器へ送り、答えを表示して、意図を実行する。
   *
   * 質問なら info_query として答えだけが返り、実行できる依頼なら channel_switch・corner_request・
   * content_request などとして実行する。考え中の間は番組の音をそのまま流し、管理人の音声を
   * 鳴らす間だけ番組の音を下げる。
   *
   * @param textOverride 入力欄の代わりに送る文（省略時は入力欄の文）
   */
  const sendInfoChat = async (textOverride?: string) => {
    const text = (textOverride ?? infoChatInput).trim();
    if (!text || infoChatLoading) return;
    ensureAdministratorAudioContext();
    setInfoChatInput('');
    setInfoChatMessages(prev => [...prev, { role: 'user', text }]);
    setInfoChatLoading(true);
    let data: { intent?: string; params?: Record<string, any>; message?: string; speechWavBase64?: string } | null = null;
    try {
      const r = await fetch(`${serverUrl}/api/text-command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, channel: selectedChannel }),
      });
      data = await r.json();
      setInfoChatMessages(prev => [...prev, { role: 'bot', text: data?.message || 'エラーが発生しました。' }]);
    } catch {
      setInfoChatMessages(prev => [...prev, { role: 'bot', text: 'サーバーへの接続に失敗しました。' }]);
    } finally {
      setInfoChatLoading(false);
    }
    if (data) {
      if (data.speechWavBase64) {
        duckAudio();
        await playAdministratorSpeech(data.speechWavBase64);
        unduckAudio();
      }
      dispatchVoiceCommand(data);
    }
  };

  return {
    infoChatOpen, setInfoChatOpen, infoChatMessages, infoChatInput, setInfoChatInput,
    infoChatLoading, infoChatEndRef, infoChatOpenRef, openInquiryBox, sendInfoChat,
  };
}
