/**
 * @file ダッシュボードの WebSocket（/stream-dashboard）につなぎ、チャンネルごとの状態とできごとのフィードを持つフック
 *
 * 最初に届くスナップショット（DASHBOARD_SNAPSHOT）を元に、その後の個別のイベントで差分を更新する。切れたら
 * 3秒後につなぎ直す。
 * ATTENTION: 状態の更新の仕方は、サーバーの server/lib/dashboard-hub.js（updateDashboardSnapshot・
 *            resetDashboardSnapshot）とそろえる。
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
import { FEED_HIDDEN_EVENTS } from '../eventDescriptions';
import type {
  ChannelSnapshot, DashboardEvent, DashboardSnapshotMessage, DiscussionSettings, DiscussionStatus, HelperJob,
} from '../types';

/**
 * 準備中・進行中の討論コーナーを「中断」に書き換える（切断のとき用。dashboard-hub.js と同じ）。
 * @param discussions コーナーごとの状態
 * @returns 書き換えた状態
 */
function interruptDiscussions(discussions: Record<string, DiscussionStatus>): Record<string, DiscussionStatus> {
  const out: Record<string, DiscussionStatus> = {};
  for (const [key, d] of Object.entries(discussions)) {
    out[key] = d.state === 'preparing' || d.state === 'running'
      ? { ...d, state: 'interrupted', stepIndex: null, ts: Date.now() }
      : d;
  }
  return out;
}

const FEED_MAX = 200;
const RECONNECT_DELAY_MS = 3000;
// 「考え中」の表示を残す最短の時間。3ターン先読みのため、実際の生成は前の人が話している数秒で終わってしまい、
// そのまま出すと画面ではほとんど見えない。表示だけをこの時間残す（サーバーのイベントは変えない）
const MIN_THINKING_VISIBLE_MS = 2500;

/**
 * ダッシュボードの WebSocket の URL（開発時は API サーバーのポート、それ以外は同じオリジン）。
 * @returns URL
 */
function getDashboardWsUrl() {
  return window.location.hostname === 'localhost'
    ? 'ws://localhost:3001/stream-dashboard'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/stream-dashboard`;
}

/**
 * 個別のイベント1件をチャンネルの状態へ重ねる（server/lib/dashboard-hub.js の updateDashboardSnapshot と同じ）。
 * @param snap 今の状態
 * @param data イベント
 * @returns 新しい状態
 */
function applyEventToSnapshot(snap: ChannelSnapshot, data: DashboardEvent): ChannelSnapshot {
  const next = { ...snap };
  switch (data.event) {
    case 'AGENT_SPEAKING':
      next.speakingAgent = data.agent as string;
      break;
    case 'AGENT_SILENT':
      if (next.speakingAgent === data.agent) next.speakingAgent = null;
      break;
    // AGENT_THINKING は、表示の最短の時間を持たせるためフックの側で扱う（ここには来ない）。
    // CORNER_START の name はリスナー向けの説明文で短いコーナー名ではないので使わない。コーナーの種類は
    // CORNER_QUEUE_UPDATE（Live だけ）の current から取る。
    case 'CORNER_QUEUE_UPDATE':
      next.corner = (data.current as string) ?? null;
      next.queue = data;
      break;
    case 'SHOW_INFO':
      next.showInfo = { slot: data.slot as string, name: data.name as string };
      break;
    case 'SPOTIFY_PLAY':
    case 'MUSIC_PLAY_START':
      next.nowPlaying = { title: data.title as string, artist: data.artist as string };
      break;
    case 'MUSIC_PLAY_END':
      next.nowPlaying = null;
      break;
    case 'SYSTEM_ERROR':
      next.lastError = { code: data.code as string, message: data.message as string, ts: Date.now() };
      break;
    case 'SECRETARY_ACTIVITY':
      next.secretaryState = data.state as ChannelSnapshot['secretaryState'];
      break;
    case 'SECRETARY_LOOP_STATUS':
      next.loopStatus = data.state as ChannelSnapshot['loopStatus'];
      break;
    case 'SECRETARY_CONSULTING':
      next.consultingAgent = data.agentKey
        ? { key: data.agentKey as string, name: (data.agentName as string) ?? (data.agentKey as string) }
        : null;
      break;
    // LINE からの依頼。終わった後も「最後に LINE から依頼があった時刻」を残したいので、依頼の文と時刻は消さない。
    case 'SECRETARY_LINE_REQUEST':
      next.lineRequest = data.state === 'processing'
        ? { processing: true, requestText: data.requestText as string, ts: (data.ts as number) ?? Date.now() }
        : { ...(next.lineRequest ?? { ts: (data.ts as number) ?? Date.now() }), processing: false };
      break;
    // ヘルパーのジョブ。会話が待機中でも裏で作業が走るので、終わった後も「最後に処理した依頼」として残す。
    // BUGFIX: 走っているジョブはすべて helperJobs に持つ（サーバーと同じ）。古い形の helperJob だけを更新していた
    //         ときは、開いた後に始まった・終わったジョブが反映されず、「実行中」のまま残った。
    case 'SECRETARY_HELPER_JOB': {
      const jobs = { ...(next.helperJobs ?? {}) };
      const key = (data.id as string) || 'legacy';
      const job = {
        id: key, kind: ((data.kind as HelperJob['kind']) || 'helper'),
        request: data.request as string, progress: data.progress as string,
        ts: (data.ts as number) ?? Date.now(),
      };
      if (data.state === 'running') {
        jobs[key] = { ...job, running: true };
      } else {
        delete jobs[key];
        next.lastHelperJob = { ...job, running: false, status: data.status as string };
      }
      next.helperJobs = jobs;
      next.helperJob = Object.values(jobs)[0] ?? next.lastHelperJob ?? null;
      break;
    }
    // Live の討論コーナー。コーナーごとに直近の状態を1件ずつ持つ
    case 'DISCUSSION_STATUS':
      if (data.key) {
        next.discussions = {
          ...(next.discussions ?? {}),
          [data.key as string]: { ...(data as unknown as DiscussionStatus), ts: (data.ts as number) ?? Date.now() },
        };
      }
      break;
    case 'DISCUSSION_SETTINGS':
      next.discussionSettings = (data.corners as DiscussionSettings) ?? null;
      break;
    case '24YOU_MODE_UPDATE':
      next.twentyFourYouMode = (data.mode as string) ?? null;
      break;
    case 'CHANNEL_CONNECTED':
      next.connected = true;
      next.lastSession = { start: (data.ts as number) ?? Date.now(), end: null };
      break;
    default:
      if (data.event.endsWith('_QUEUE_UPDATE')) {
        next.queue = data;
      } else if (data.event === 'THEME_ANNOUNCED') {
        // BUGFIX: テーマが決まったら（新しいエピソードの始まり）、前の回の状態を捨てる。前の回の CLOSING などを
        //         残したまま積み増すと、2回目以降も「エピソード終了」と表示され続けた。
        next.theAnswers = { THEME_ANNOUNCED: data };
      } else if (['PANEL_ASSIGNED', 'ROUND_TIMER', 'CLOSING', 'SHOW_ENDED'].includes(data.event)) {
        next.theAnswers = { ...(next.theAnswers ?? {}), [data.event]: data };
      }
  }
  return next;
}

/**
 * ダッシュボードの WebSocket の接続と状態。
 * @returns 接続中か・チャンネルごとの状態・できごとのフィード（新しい順、最大200件）
 */
export function useDashboardSocket() {
  const [connected, setConnected] = useState(false);
  const [channels, setChannels] = useState<Record<string, ChannelSnapshot>>({});
  const [feed, setFeed] = useState<DashboardEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // AGENT_THINKING を表示し始めた時刻と、消すタイマー（チャンネルごと）
  const thinkingStartedAtRef = useRef<Record<string, number>>({});
  const thinkingClearTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(getDashboardWsUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onmessage = (event) => {
        let data: DashboardSnapshotMessage | DashboardEvent;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (data.event === 'DASHBOARD_SNAPSHOT') {
          setChannels((data as DashboardSnapshotMessage).channels ?? {});
          return;
        }
        const evt = data as DashboardEvent;
        // 画面を描くためのデータや定期の知らせは「できごと」ではないので、フィードには載せない（一覧と理由は
        // eventDescriptions.ts の FEED_HIDDEN_EVENTS）。ただしカードの表示に使うもの（ROUND_TIMER の経過時間など）が
        // あるので、除くのはフィードへの追加だけで、状態の更新は行う。HEARTBEAT は状態を持たないので、ここで打ち切る。
        if (evt.event === 'HEARTBEAT') return;
        const hiddenFromFeed = FEED_HIDDEN_EVENTS.has(evt.event);
        const pushFeed = (e: DashboardEvent) => {
          if (hiddenFromFeed) return;
          setFeed((prev) => [{ ...e, ts: e.ts ?? Date.now() }, ...prev].slice(0, FEED_MAX));
        };
        // 最後のリスナーが切断した合図。コーナーや再生中の曲などの表示は消すが、サーバーで確定した lastSession
        // （最後の接続）は引き継ぐ。
        if (evt.event === 'CHANNEL_RESET') {
          setChannels((prev) => ({
            ...prev,
            // LINE の依頼も引き継ぐ。LINE は音声の接続と関係ないので、音声を切っただけで消えるのはおかしい
            // （サーバーの resetDashboardSnapshot も同じ）
            [evt.channel]: {
              lastSession: evt.lastSession as ChannelSnapshot['lastSession'] ?? null,
              ...(prev[evt.channel]?.lineRequest
                ? { lineRequest: { ...prev[evt.channel].lineRequest!, processing: false } }
                : {}),
              // Live の編成のキューは接続や再起動をまたいで続く「その日の編成」（サーバーがディスクに保存）なので残す。
              // 他のチャンネルのキューはリクエストの待ち行列でセッション限りなので消す
              ...(evt.channel === 'live' && prev.live?.queue ? { queue: prev.live.queue } : {}),
              // 討論コーナーの前回の状態とオン・オフもセッションに閉じないので残す。準備中・進行中だったものは「中断」にする
              // （サーバーの resetDashboardSnapshot と同じ）
              ...(evt.channel === 'live' && prev.live?.discussions
                ? { discussions: interruptDiscussions(prev.live.discussions) } : {}),
              ...(evt.channel === 'live' && prev.live?.discussionSettings
                ? { discussionSettings: prev.live.discussionSettings } : {}),
            },
          }));
          pushFeed(evt);
          return;
        }
        // AGENT_THINKING は、最短の時間（MIN_THINKING_VISIBLE_MS）表示してから消す。始まりのときは消すタイマーを
        // 取り消し、終わりのときは時間が足りなければ残りの時間だけ遅らせて消す（その間に別の人が考え始めていたら
        // 上書きしない）。
        if (evt.event === 'AGENT_THINKING') {
          const channel = evt.channel;
          if (thinkingClearTimerRef.current[channel]) {
            clearTimeout(thinkingClearTimerRef.current[channel]);
            delete thinkingClearTimerRef.current[channel];
          }
          if (evt.state === 'start') {
            thinkingStartedAtRef.current[channel] = Date.now();
            setChannels((prev) => ({
              ...prev,
              [channel]: { ...prev[channel], thinkingAgent: evt.agent as string },
            }));
          } else {
            const elapsed = Date.now() - (thinkingStartedAtRef.current[channel] ?? 0);
            const doClear = () => {
              setChannels((prev) => (
                prev[channel]?.thinkingAgent === evt.agent
                  ? { ...prev, [channel]: { ...prev[channel], thinkingAgent: null } }
                  : prev
              ));
              delete thinkingClearTimerRef.current[channel];
            };
            if (elapsed >= MIN_THINKING_VISIBLE_MS) doClear();
            else thinkingClearTimerRef.current[channel] = setTimeout(doClear, MIN_THINKING_VISIBLE_MS - elapsed);
          }
          pushFeed(evt);
          return;
        }
        setChannels((prev) => ({
          ...prev,
          [evt.channel]: applyEventToSnapshot(prev[evt.channel] ?? {}, evt),
        }));
        pushFeed(evt);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      Object.values(thinkingClearTimerRef.current).forEach(clearTimeout);
      wsRef.current?.close();
    };
  }, []);

  return { connected, channels, feed };
}
