/**
 * @file システム監視ダッシュボード（/dashboard）のために、全チャンネルのイベントを1本に集める
 *
 * 各チャンネルの WebSocket（createChannelWs の結果）を包み、既存の _broadcast の呼び出しをそのまま
 * ダッシュボード用の WebSocket（/stream-dashboard）へも転送する（チャンネルの側は変えない）。チャンネルごとの
 * 直近の状態（スナップショット）を持ち、ダッシュボードがつないだ直後にまとめて送る。利用元は server.js。
 * 最後の接続の履歴（lastSession）だけは、再起動をまたいで server/data/dashboard-last-sessions.json に残す。
 *
 * ATTENTION: 状態の更新の仕方は、クライアントの client/src/dashboard/hooks/useDashboardSocket.ts とそろえる。
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
'use strict';

const { writeJsonFile } = require('./atomic-json');
const path = require('path');

/**
 * 準備中・進行中の討論コーナーを「中断」に書き換える（切断のとき用）。終わった回はそのまま残す。
 * @param {Record<string, any>} discussions コーナーごとの状態
 * @returns {Record<string, any>}
 */
function interruptDiscussions(discussions) {
  const out = {};
  for (const [key, d] of Object.entries(discussions)) {
    out[key] = (d && (d.state === 'preparing' || d.state === 'running'))
      ? { ...d, state: 'interrupted', stepIndex: null, ts: Date.now() }
      : d;
  }
  return out;
}

/**
 * ダッシュボードの集約を作る。
 * @param {{
 *   createChannelWs: () => { wss: import('ws').Server, broadcast: (data: any) => void, wrapper: any },
 *   readJsonFile: (filePath: string, defaultValue: any) => any,
 *   getLogger: () => any,
 *   DATA_DIR: string,
 * }} deps
 * @returns {Record<string, any>} ダッシュボードの WebSocket・配信・スナップショット・包む関数など
 */
function createDashboardHub({ createChannelWs, readJsonFile, getLogger, DATA_DIR }) {
  const { wss: wss_dashboard, broadcast: broadcastToDashboard } = createChannelWs();

  // チャンネルごとの直近の状態（ダッシュボードがつないだ直後にすぐ出すため）。音声を伴わない軽い状態だけを持つ
  const dashboardSnapshots = new Map(); // チャンネル ID から状態へ

  // 最後の接続の履歴（lastSession）だけは、再起動をまたいで残すためファイルに書く
  const DASHBOARD_LAST_SESSIONS_PATH = path.join(DATA_DIR, 'dashboard-last-sessions.json');

  /**
   * 最後の接続の履歴を保存する。
   * @param {string} channelId
   * @param {{ start: number, end: number|null }} lastSession
   */
  function saveLastSession(channelId, lastSession) {
    const all = readJsonFile(DASHBOARD_LAST_SESSIONS_PATH, {});
    all[channelId] = lastSession;
    try {
      writeJsonFile(DASHBOARD_LAST_SESSIONS_PATH, all);
    } catch (e) {
      getLogger().warn(`[Dashboard] 最終接続履歴の保存に失敗: ${e.message}`);
    }
  }

  // 起動時に前回までの履歴を読み、最初の状態に入れる。終わりが記録されていない（正常に止まらなかった）ものは、
  // 起動した時刻を終わりとして確定させる（「接続中」のまま固まらないように）。
  {
    const _persistedLastSessions = readJsonFile(DASHBOARD_LAST_SESSIONS_PATH, {});
    const _startupTs = Date.now();
    let _needsRewrite = false;
    for (const [channelId, lastSession] of Object.entries(_persistedLastSessions)) {
      if (lastSession && lastSession.end === null) {
        lastSession.end = _startupTs;
        _persistedLastSessions[channelId] = lastSession;
        _needsRewrite = true;
      }
      dashboardSnapshots.set(channelId, { lastSession });
    }
    if (_needsRewrite) {
      try {
        writeJsonFile(DASHBOARD_LAST_SESSIONS_PATH, _persistedLastSessions);
      } catch (e) {
        getLogger().warn(`[Dashboard] 最終接続履歴の起動時補正の保存に失敗: ${e.message}`);
      }
    }
  }

  /**
   * イベント1件をチャンネルの状態へ重ねる。
   * @param {string} channelId
   * @param {Record<string, any>} data イベント
   */
  function updateDashboardSnapshot(channelId, data) {
    const snap = dashboardSnapshots.get(channelId) ?? {};
    switch (data.event) {
      case 'AGENT_SPEAKING': snap.speakingAgent = data.agent; break;
      case 'AGENT_SILENT':   if (snap.speakingAgent === data.agent) snap.speakingAgent = null; break;
      case 'AGENT_THINKING': snap.thinkingAgent = data.state === 'start' ? data.agent : null; break;
      // CORNER_START の name はリスナー向けの説明文で、短いコーナー名ではないので使わない。コーナーの種類
      // （weather など）は CORNER_QUEUE_UPDATE（Live だけ。ディレクターの編成のキュー）の current から取る。
      case 'CORNER_QUEUE_UPDATE': snap.corner = data.current ?? null; snap.queue = data; break;
      case 'SHOW_INFO':      snap.showInfo = { slot: data.slot, name: data.name }; break;
      case 'SPOTIFY_PLAY':
      case 'MUSIC_PLAY_START': snap.nowPlaying = { title: data.title, artist: data.artist }; break;
      case 'MUSIC_PLAY_END':   snap.nowPlaying = null; break;
      case 'SYSTEM_ERROR':     snap.lastError = { code: data.code, message: data.message, ts: Date.now() }; break;
      case 'SECRETARY_ACTIVITY': snap.secretaryState = data.state; break;
      // 秘書の相談で、相手のエージェントの声を再生している間の相手（始まりで入り、終わりで null に戻る）
      case 'SECRETARY_CONSULTING':
        snap.consultingAgent = data.agentKey ? { key: data.agentKey, name: data.agentName } : null;
        break;
      // 自律ループが実際にチェックしている間。会話の状態（secretaryState）とは別の軸
      case 'SECRETARY_LOOP_STATUS': snap.loopStatus = data.state; break;
      // LINE からの依頼。LINE は WebSocket を張らない HTTP の Webhook なので、会話の状態にも接続の履歴にも現れない。
      // 終わった後も依頼の文と時刻は消さず、「最後に LINE から来た依頼」として残す（処理中の印だけ倒す）。
      case 'SECRETARY_LINE_REQUEST':
        snap.lineRequest = data.state === 'processing'
          ? { processing: true, requestText: data.requestText, ts: data.ts }
          : { ...(snap.lineRequest ?? { ts: data.ts }), processing: false };
        break;
      // ヘルパーのジョブ。会話の状態が「待機中」でも裏で数分の作業が走ることがあるので、別の軸として持つ。
      // 走っているものはすべて持ち（通常の作業とスライドの作成が同時に走っても両方見える）、終わったものは直近の
      // 1件だけ「最後に処理した依頼」として残す。
      case 'SECRETARY_HELPER_JOB': {
        const jobs = { ...(snap.helperJobs ?? {}) };
        const key = data.id || 'legacy';
        if (data.state === 'running') {
          jobs[key] = { id: key, kind: data.kind || 'helper', running: true,
            request: data.request, progress: data.progress, ts: data.ts };
        } else {
          delete jobs[key];
          snap.lastHelperJob = { id: key, kind: data.kind || 'helper', running: false,
            request: data.request, progress: data.progress, status: data.status, ts: data.ts };
        }
        snap.helperJobs = jobs;
        // 古い形（1件だけの helperJob）も残す。走っているものの1件目、無ければ直近の完了
        const runningList = Object.values(jobs);
        snap.helperJob = runningList[0] ?? snap.lastHelperJob ?? null;
        break;
      }
      case '24YOU_MODE_UPDATE': snap.twentyFourYouMode = data.mode ?? null; break;
      // Live の討論コーナー。コーナーごとに直近の状態を1件ずつ持つ（終わった回も「前回」として残す）
      case 'DISCUSSION_STATUS':
        if (data.key) snap.discussions = { ...(snap.discussions ?? {}), [data.key]: { ...data, ts: data.ts ?? Date.now() } };
        break;
      // 再生画面のチェックボックスで切り替えたオン・オフ（config-data-routes.js から届く）
      case 'DISCUSSION_SETTINGS': snap.discussionSettings = data.corners ?? null; break;
      // 最後の接続の履歴: 「いつからいつまでつながっていたか」を1件だけ持つ。つないだときに終わりを null で立て、
      // 切断したとき（resetDashboardSnapshot）に終わりを埋める。リセットしても、これだけは引き継ぐ。
      case 'CHANNEL_CONNECTED':
        snap.connected = true;
        snap.lastSession = { start: data.ts, end: null };
        saveLastSession(channelId, snap.lastSession);
        break;
      default:
        // 音楽チャンネルの <CH>_QUEUE_UPDATE はリクエストの待ち行列でコーナーの種類を持たないので、queue にだけ入れる
        if (typeof data.event === 'string' && data.event.endsWith('_QUEUE_UPDATE')) snap.queue = data;
        // BUGFIX: 新しいエピソードの始まりで、前の回の CLOSING・SHOW_ENDED を捨てる。積み増すと、2回目以降も
        //         「エピソード終了」と表示され続けた。
        else if (data.event === 'THEME_ANNOUNCED') snap.theAnswers = { THEME_ANNOUNCED: data };
        else if (typeof data.event === 'string' && ['PANEL_ASSIGNED', 'ROUND_TIMER', 'CLOSING', 'SHOW_ENDED'].includes(data.event)) {
          snap.theAnswers = { ...(snap.theAnswers ?? {}), [data.event]: data };
        }
    }
    dashboardSnapshots.set(channelId, snap);
  }

  /**
   * リスナーが1人もいなくなったチャンネルの状態を空に戻し、ダッシュボードにも知らせる（切断後もコーナーや
   * 再生中の曲が残って見えないように）。最後の接続の履歴は引き継ぎ、終わりの時刻を確定させる。
   * @param {string} channelId
   */
  function resetDashboardSnapshot(channelId) {
    const prev = dashboardSnapshots.get(channelId) ?? {};
    const lastSession = prev.lastSession
      ? { start: prev.lastSession.start, end: Date.now() }
      : null;
    // LINE の依頼も引き継ぐ（LINE は音声の接続と関係ないので、音声を切っただけで消えるのはおかしい）。
    // 処理中の印は念のため倒す（残ると「処理中」がずっと出たままになる）
    const lineRequest = prev.lineRequest ? { ...prev.lineRequest, processing: false } : null;
    // Live の編成のキューも引き継ぐ。ディスクに保存され、接続や再起動をまたいで続く「その日の編成」なので、
    // リスナーがいない間も意味がある。音楽チャンネルのキューはセッション限りのリクエストの待ち行列なので消す
    const liveQueue = channelId === 'live' && prev.queue ? prev.queue : null;
    // 討論コーナーの前回の状態とオン・オフも、セッションに閉じないので引き継ぐ。準備中・進行中だったものは、
    // 切断で番組の側の状態が捨てられる（_resetSessionConversationState）ので「中断」にする
    const discussions = channelId === 'live' && prev.discussions
      ? interruptDiscussions(prev.discussions)
      : null;
    const discussionSettings = channelId === 'live' ? prev.discussionSettings : null;
    dashboardSnapshots.set(channelId, {
      lastSession,
      ...(lineRequest ? { lineRequest } : {}),
      ...(liveQueue ? { queue: liveQueue } : {}),
      ...(discussions ? { discussions } : {}),
      ...(discussionSettings ? { discussionSettings } : {}),
    });
    if (lastSession) saveLastSession(channelId, lastSession);
    broadcastToDashboard({ event: 'CHANNEL_RESET', channel: channelId, lastSession, ts: Date.now() });
  }

  /**
   * 最初のリスナーがつないだとき（視聴の始まり）に知らせ、最後のリスナーが切れたときに状態を空に戻す。
   * agent-system.js などの接続・切断の処理とは別に、見るためだけに足すリスナー（connection・close のイベントは
   * 複数のリスナーを付けられる）。wrapWithDashboardForward を通る6チャンネルと、秘書の両方から使う。
   * @param {string} channelId
   * @param {Record<string, any>} wss チャンネルの WebSocket サーバー
   */
  function _trackConnectionLifecycle(channelId, wss) {
    wss.on('connection', (ws) => {
      if (wss.clients.size === 1) {
        const data = { event: 'CHANNEL_CONNECTED', channel: channelId, ts: Date.now() };
        updateDashboardSnapshot(channelId, data);
        broadcastToDashboard(data);
      }
      ws.on('close', () => {
        if (wss.clients.size === 0) resetDashboardSnapshot(channelId);
      });
    });
  }

  /**
   * チャンネルの WebSocket を包み、そのチャンネルへの配信はそのままに、ダッシュボードへも channel を付けて転送する。
   * ATTENTION: wrapper.broadcastToClients は AgentSystem などが this.server を通して直接呼ぶので、broadcast を
   *            差し替えるときに一緒に差し替える。
   * @param {string} channelId
   * @param {Record<string, any>} chWs createChannelWs() の結果
   * @returns {Record<string, any>} 同じもの（包んだ後）
   */
  function wrapWithDashboardForward(channelId, chWs) {
    const originalBroadcast = chWs.broadcast;
    chWs.broadcast = (data) => {
      originalBroadcast(data);
      updateDashboardSnapshot(channelId, data);
      broadcastToDashboard({ ...data, channel: channelId });
    };
    chWs.wrapper.broadcastToClients = chWs.broadcast;
    _trackConnectionLifecycle(channelId, chWs.wss);
    return chWs;
  }

  /**
   * 秘書の接続・切断をダッシュボードに知らせる。秘書の WebSocket は1対1の中継で broadcast を使わず
   * wrapWithDashboardForward を通せないので、接続の始まりと終わりだけを同じ仕組みで見る。
   * @param {Record<string, any>} wssSecretary 秘書の WebSocket サーバー
   */
  function trackSecretaryConnectionLifecycle(wssSecretary) {
    _trackConnectionLifecycle('secretary', wssSecretary);
  }

  // ダッシュボードの WebSocket（JSON だけで音声は無い）。つないだ直後に、全チャンネルの直近の状態をまとめて送る
  wss_dashboard.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.send(JSON.stringify({
      event: 'DASHBOARD_SNAPSHOT',
      channels: Object.fromEntries(dashboardSnapshots),
      ts: Date.now(),
    }));
  });

  return {
    wss_dashboard,
    broadcastToDashboard,
    dashboardSnapshots,
    updateDashboardSnapshot,
    resetDashboardSnapshot,
    wrapWithDashboardForward,
    trackSecretaryConnectionLifecycle,
  };
}

module.exports = { createDashboardHub };
