/**
 * @file ダッシュボードで使う型（チャンネルのスナップショット・イベントなど）
 *
 * ChannelSnapshot は、server.js の dashboardSnapshots と、それを更新する updateDashboardSnapshot() が
 * 持つ項目をそのまま写したもの。サーバー側で項目を足したら、ここにも足す。
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

/** 秘書のヘルパーエージェントの仕事1件。 */
export type HelperJob = {
  id?: string;
  // 'helper' は通常の作業、'presentation' はスライドの作成
  kind?: 'helper' | 'presentation';
  running: boolean;
  request?: string;
  progress?: string;
  status?: string;
  ts: number;
};

/** 1チャンネルの今の状態。 */
export interface ChannelSnapshot {
  speakingAgent?: string | null;
  thinkingAgent?: string | null;
  corner?: string | null;
  queue?: Record<string, unknown> | null;
  showInfo?: { slot?: string; name?: string } | null;
  nowPlaying?: { title?: string; artist?: string } | null;
  lastError?: { code?: string; message?: string; ts: number } | null;
  theAnswers?: Record<string, Record<string, unknown>>;
  // 秘書だけ: 会話の状態。secretary-live-routes.js の onActivity から届く（他のチャンネルとは別の経路）
  secretaryState?: 'idle' | 'searching' | 'speaking';
  // 秘書だけ: 自律ループ（5分ごとの見張り）が確認中か。会話の状態とは別
  loopStatus?: 'checking' | 'idle';
  // 24/You だけ: 選曲モード（'omakase'・'anokoro'・'artist'・'shinpu'・'wagamama' など）
  twentyFourYouMode?: string | null;
  // 接続で true。最後のリスナーが切断するとスナップショットごと空に戻るので、そのとき undefined になる
  connected?: boolean;
  // 最後の接続（1件だけ）。end が null なら今も続いている
  lastSession?: { start: number; end: number | null } | null;
  // 秘書だけ: 専門家に相談して、その専門家の声を流している間の相手（Player.tsx の consultingAgentKey と同じ）
  consultingAgent?: { key: string; name: string } | null;
  // 秘書だけ: LINE からの依頼の処理状況。LINE は WebSocket ではなく HTTP の Webhook なので、会話の状態とは別に持つ。
  // 終わると processing が false になり、最後の依頼の内容だけが残る
  lineRequest?: { processing: boolean; requestText?: string; ts: number } | null;
  // ヘルパーエージェントの仕事。会話は待機中でも、裏で作業が動いていることがある
  helperJob?: HelperJob | null;
  // 通常の作業とスライドの作成は同時に動くことがあるので、動いているものを全部持つ（id → 仕事）。
  // 終わったものは lastHelperJob に1件だけ残す
  helperJobs?: Record<string, HelperJob>;
  lastHelperJob?: HelperJob | null;
  // Live だけ: 討論コーナーごとの直近の状態（DISCUSSION_STATUS）
  discussions?: Record<string, DiscussionStatus>;
  // Live だけ: プレーヤー画面で切り替えた、討論コーナーのオン・オフ（DISCUSSION_SETTINGS）
  discussionSettings?: DiscussionSettings | null;
}

/** Live の編成キュー（CORNER_QUEUE_UPDATE） */
export interface LiveQueueShape { current?: string; next?: string; queue?: string[]; recent?: string[] }

/** 討論コーナーの状態（server/lib/agent-discussion-corner.js の _broadcastDiscussionStatus が送る形）。 */
export interface DiscussionStatus {
  key: string;
  name?: string;
  // interrupted はサーバーの dashboard-hub が切断時に付ける（放送側からは送られない）
  state: 'preparing' | 'running' | 'finished' | 'cancelled' | 'interrupted';
  plan?: { agent: string; role: string }[];
  /** running のときの、いま何番目の発言か（0始まり） */
  stepIndex?: number | null;
  turns?: number;
  research?: 'running' | 'done' | 'empty' | 'failed';
  researchChars?: number;
  ts?: number;
}

/** config.show.discussion_corners */
export type DiscussionSettings = Record<string, {
  name?: string;
  enabled?: boolean;
  frequency?: number;
  max_turns?: number;
  opening_jingle_ms?: number;
}>;

/**
 * /stream-dashboard から届くイベント（各チャンネルの _broadcast の内容に channel を足したもの）。
 * イベントごとに中身がまちまちなので、厳密な型にはせず、event の名前で分けて読む。
 */
export interface DashboardEvent {
  event: string;
  channel: string;
  cat?: string;
  ts?: number;
  [key: string]: unknown;
}

/** 接続したときに届く、全チャンネルの状態。 */
export interface DashboardSnapshotMessage {
  event: 'DASHBOARD_SNAPSHOT';
  channels: Record<string, ChannelSnapshot>;
  ts: number;
}

export type DashboardChannelId =
  | 'live' | 'classic' | 'jazz' | 'mood' | 'beatles' | 'the_answers' | 'secretary';
