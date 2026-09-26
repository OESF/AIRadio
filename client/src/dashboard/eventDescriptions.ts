/**
 * @file ダッシュボードのできごとのフィードで、サーバーのイベントを人が読める日本語の1行にする
 *
 * サーバーが投げうるイベントから日本語の説明への対応表をここに集める（サーバーのイベントは変えず、表示の側だけで
 * 変換する）。話し手はエージェントのキーではなく、管理画面で設定された名前か役割の名前で出す。
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

import { cornerLabel, DISCUSSION_ROLE_LABELS, isCornerKey, shortAgentName, TWENTYFOURYOU_MODE_LABELS } from './constants';
import type { AgentNameMap } from './hooks/useAgentNames';
import type { DashboardEvent } from './types';

/** フィード1行の種別。左端に色付きのラベルとして出し、ひと目で分類できるようにする。 */
export type FeedKind = 'speech' | 'program' | 'music' | 'listener' | 'secretary' | 'record' | 'alert';

export const FEED_KIND_META: Record<FeedKind, { label: string; color: string }> = {
  speech:    { label: '発言',     color: '#93c5fd' },
  program:   { label: '進行',     color: '#c4b5fd' },
  music:     { label: '音楽',     color: '#5eead4' },
  listener:  { label: 'リスナー', color: '#fcd34d' },
  secretary: { label: '秘書',     color: '#f0abfc' },
  record:    { label: '記録',     color: '#94a3b8' },
  alert:     { label: '注意',     color: '#fca5a5' },
};

export interface FeedLine { kind: FeedKind; text: string }

// ─── フィードに出さないイベント ───
// 人が読むできごとではなく、画面を描くためのデータや定期の知らせにあたるもの。状態のカードの更新には使うので、
// 除くのはフィードへの追加だけ（useDashboardSocket.ts で判定する）。
export const FEED_HIDDEN_EVENTS = new Set([
  'HEARTBEAT',        // 30秒ごとの疎通確認
  'CAPTION',          // リスナー画面の字幕テキスト。発言の開始/終了と重複する上、1文ごとに飛ぶ
  'ROUND_TIMER',      // The Answers の経過時間（15秒ごと）。ステータスカードの「経過」に出る
  'CAST_LIST',        // 接続時に出演者一覧をまとめて送るデータ
  '24YOU_PLAYED_LIST', // 24/You の再生履歴データ
  'DASHBOARD_SNAPSHOT', // 接続直後の状態復元（ここには来ないが念のため）
]);

// ─── エージェントのキーから役割の日本語名へ ───
// 管理画面で設定された名前（config.agents.<key>.name）が取れなかったときに使う。
const AGENT_ROLE_LABELS: Record<string, string> = {
  caster: 'キャスター', assistant: 'アシスタント', director: 'ディレクタ',
  weather: '気象情報センター', traffic: '交通情報センター', news: '報道センター',
  finance: '金融情報センター', music_dj: '音楽DJ', commentator: 'コメンテーター',
  journalist: 'ジャーナリスト', life_advisor: '生活アドバイザー',
  world_report: 'ワールドレポート', legal_advisor: '法律相談',
  comedian: 'お笑い芸人', doctor: '医師', marketer: 'マーケター',
  secretary: '秘書',
  classic_personality: 'パーソナリティ', classic_director: 'ディレクタ',
  jazz_personality: 'パーソナリティ', jazz_director: 'ディレクタ',
  mood_personality: 'パーソナリティ', mood_director: 'ディレクタ',
  beatles_personality: 'パーソナリティ', beatles_director: 'ディレクタ',
  answers_director: 'ディレクタ', '24you_selector': 'AI選曲',
};

/**
 * エージェントのキーを、人が読む名前にする。
 *   1. 管理画面で設定された名前（useAgentNames から）
 *   2. The Answers の poolKey（live_commentator など）は、出演元のチャンネルの名前を引く
 *   3. 役割の日本語名
 *   4. それでも分からなければキーのまま（エージェントが増えたときの保険）
 * @param agentKey エージェントのキー
 * @param channel チャンネル
 * @param agentNames チャンネルごとの名前の対応
 * @returns 表示する名前
 */
export function resolveAgentLabel(
  agentKey: unknown, channel: string, agentNames: AgentNameMap,
): string {
  const key = typeof agentKey === 'string' ? agentKey : '';
  if (!key) return '担当者';
  const direct = agentNames[channel]?.[key];
  if (direct) return shortAgentName(direct);
  // The Answers のパネリストは live_commentator のように、出演元のチャンネル名が前に付く
  const m = key.match(/^(live|classic|jazz|mood|beatles)_(.+)$/);
  if (m) {
    const viaHome = agentNames[m[1]]?.[m[2]] ?? agentNames[m[1]]?.[key];
    if (viaHome) return shortAgentName(viaHome);
    if (AGENT_ROLE_LABELS[m[2]]) return AGENT_ROLE_LABELS[m[2]];
  }
  return AGENT_ROLE_LABELS[key] ?? key;
}

// ─── システムのエラーのコードから日本語へ ───
export const ERROR_CODE_LABELS: Record<string, string> = {
  TTS_FAILED: '音声の合成に失敗しました',
  GEMINI_FAILED: 'AIからの応答を取得できませんでした',
  GOOGLE_CREDIT_DEPLETED: 'Google APIの残高が不足しています',
  SHOW_LOOP_ERROR: '番組進行の処理でエラーが発生しました',
};

/**
 * エラーのコードを日本語の説明にする。
 * @param code エラーのコード
 * @returns 説明（知らないコードは「原因不明」とコードを添える）
 */
export function errorCodeLabel(code: unknown): string {
  const key = typeof code === 'string' ? code : '';
  if (ERROR_CODE_LABELS[key]) return ERROR_CODE_LABELS[key];
  // 表に無いコード。コードを隠すと調べられなくなるので、「原因不明」とした上でかっこに添える
  return key ? `原因不明のエラー（${key}）` : '原因不明のエラー';
}

// ─── 番組の時間帯 ───
const SLOT_LABELS: Record<string, string> = {
  morning: '朝', daytime: '昼', afternoon: '午後', evening: '夕方〜夜',
  late_night: '深夜', ending: 'エンディング', ended: '放送終了',
};

// ─── 画面に出す資料（INFOVIEW_DATA）とテロップ（TICKER_UPDATE）の種類 ───
const INFOVIEW_LABELS: Record<string, string> = {
  recipe: 'レシピ', world_report: '世界の街の情報',
};
const TICKER_LABELS: Record<string, string> = {
  traffic_structured: '交通情報', traffic: '交通情報', weather: '天気',
  news: 'ニュース', finance: '株価・金融', music: '楽曲', track: '楽曲',
  recipe: 'レシピ', world_report: '世界の街の情報', general: 'お知らせ',
};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v ? v : fallback);
const quote = (v: unknown, max = 60): string => {
  const s = str(v);
  return s.length > max ? `「${s.slice(0, max)}…」` : `「${s}」`;
};

/**
 * ダッシュボードのイベント1件を、種別と日本語の説明の文にする。
 * ここに無いイベントは、最後の default で「未対応」と分かる形にする（内部の名前をそのまま出すより、
 * 新しい種類の知らせだと分かる）。
 * @param evt イベント
 * @param agentNames チャンネルごとのエージェントの名前
 * @returns フィードの1行
 */
export function describeEvent(evt: DashboardEvent, agentNames: AgentNameMap): FeedLine {
  const who = () => resolveAgentLabel(evt.agent, evt.channel, agentNames);

  switch (evt.event) {
    // ── 発言 ────────────────────────────────────────────────────────────────
    case 'AGENT_SPEAKING': return { kind: 'speech', text: `${who()}が話し始めました` };
    case 'AGENT_SILENT':   return { kind: 'speech', text: `${who()}が話し終えました` };
    case 'AGENT_THINKING': return {
      kind: 'speech',
      text: evt.state === 'start'
        ? `${who()}が話す内容を考えています…`
        : `${who()}の準備ができました`,
    };

    // ── 番組の進行 ──────────────────────────────────────────────────────────
    case 'CORNER_START': return {
      kind: 'program',
      text: `コーナーが始まりました: ${cornerLabel(str(evt.name) || str(evt.corner)) || '（名称不明）'}`,
    };
    case 'CORNER_QUEUE_UPDATE': {
      const now = isCornerKey(str(evt.current)) ? cornerLabel(str(evt.current)) : 'コーナー外';
      const next = isCornerKey(str(evt.next)) ? cornerLabel(str(evt.next)) : '未定';
      const rest = Array.isArray(evt.queue) ? evt.queue.length : 0;
      return {
        kind: 'program',
        text: `本日の編成を更新しました（放送中: ${now} ／ 次: ${next} ／ 残り${rest}件）`,
      };
    }
    case 'SHOW_INFO': {
      const slot = SLOT_LABELS[str(evt.slot)];
      return {
        kind: 'program',
        text: `番組情報: ${quote(evt.name)}${slot ? `（${slot}）` : ''}`,
      };
    }
    case 'NOTIFY': {
      const msg = str(evt.message);
      if (msg.startsWith('オープニング')) {
        return {
          kind: 'program',
          text: msg.includes('再接続')
            ? 'オープニングが始まりました（同じ日の再接続のため短縮版）'
            : 'オープニングが始まりました',
        };
      }
      return { kind: 'program', text: `お知らせ: ${msg || '（内容なし）'}` };
    }
    case 'TICKER_UPDATE': {
      const type = str((evt.ticker as { type?: string } | undefined)?.type);
      return { kind: 'program', text: `画面下のテロップを更新しました（${TICKER_LABELS[type] ?? 'お知らせ'}）` };
    }
    case 'INFOVIEW_DATA':
      return { kind: 'program', text: `リスナーの画面に資料を表示しました（${INFOVIEW_LABELS[str(evt.type)] ?? '資料'}）` };
    case 'CHANNEL_CONNECTED': return { kind: 'program', text: 'リスナーが接続しました（放送開始）' };
    case 'CHANNEL_RESET':     return { kind: 'program', text: 'リスナーが全員切断しました（表示をリセット）' };

    // ── 音楽 ────────────────────────────────────────────────────────────────
    case 'SPOTIFY_PLAY':
    case 'MUSIC_PLAY_START':
      return { kind: 'music', text: `曲の再生を始めました: ${quote(evt.title, 40)} — ${str(evt.artist, 'アーティスト不明')}` };
    case 'MUSIC_PLAY_END': return { kind: 'music', text: '曲の再生が終わりました' };
    case 'BGM_START':      return { kind: 'music', text: 'BGMを流し始めました' };
    case 'BGM_END':        return { kind: 'music', text: 'BGMを止めました' };
    case '24YOU_MODE_UPDATE': {
      const mode = str(evt.mode);
      return { kind: 'music', text: `選曲モードを変更しました: ${TWENTYFOURYOU_MODE_LABELS[mode] ?? mode}` };
    }

    // ── リスナーからの働きかけ ──────────────────────────────────────────────
    case 'CORNER_REQUEST_QUEUED':
      return { kind: 'listener', text: `コーナーのリクエストを受け付けました: ${cornerLabel(str(evt.corner))}` };
    case 'CORNER_REQUEST_DUPLICATE':
      return { kind: 'listener', text: 'すでに同じコーナーのリクエストを受付済みです' };
    case 'CORNER_REQUEST_FULL':
      return { kind: 'listener', text: 'コーナーのリクエストが上限に達したため受け付けられませんでした' };
    case 'USER_SPEAKING':
      return { kind: 'listener', text: `リスナーが番組に発言しました: ${quote(evt.text)}` };
    case 'HAND_RAISE_ACK':
      return { kind: 'listener', text: 'リスナーの挙手を受け付けました' };
    case 'HAND_RAISE_GRANTED':
      return { kind: 'listener', text: 'リスナーに発言権を渡しました' };
    case 'HAND_RAISE_TIMEOUT':
      return { kind: 'listener', text: '発言権の受付時間が終了しました' };
    case 'MODERATION_REJECTED':
      return { kind: 'listener', text: 'リスナーの投稿を内容の判断により見送りました' };
    case 'SUBMIT_REJECTED_NOT_GRANTED':
      return { kind: 'listener', text: `リスナーの投稿を受け付けませんでした（${str(evt.reason, '発言権がありません')}）` };

    // ── The Answers（討論番組）の進行 ───────────────────────────────────────
    case 'THEME_ANNOUNCED': return { kind: 'program', text: `今回のテーマが決まりました: ${quote(evt.theme)}` };
    case 'PANEL_ASSIGNED': {
      const panel = Array.isArray(evt.panel) ? (evt.panel as { name?: string }[]) : [];
      const names = panel.map((p) => shortAgentName(str(p.name))).filter(Boolean).join('・');
      return { kind: 'program', text: `出演者が決まりました${names ? `: ${names}` : ''}` };
    }
    case 'NEWS_BRIEFING':    return { kind: 'program', text: '討論の下調べ（最新ニュース）がまとまりました' };
    case 'OPINION_RESEARCH': return { kind: 'program', text: '討論の下調べ（世の中の意見）がまとまりました' };
    case 'CLOSING':          return { kind: 'program', text: '討論がまとめに入りました' };
    case 'SHOW_ENDED':       return { kind: 'program', text: '今回の討論が終了しました' };

    // ── Live の討論コーナー ──────────────────────────────────────
    case 'DISCUSSION_STATUS': {
      const name = str(evt.name, cornerLabel(str(evt.key)));
      const plan = Array.isArray(evt.plan) ? (evt.plan as { agent?: string; role?: string }[]) : [];
      const research = evt.research === 'done' ? `・取材メモ${Number(evt.researchChars) || 0}字`
        : evt.research === 'failed' || evt.research === 'empty' ? '・取材メモなし' : '・取材中';
      if (evt.state === 'preparing') return { kind: 'program', text: `${name}の準備を始めました（${research.slice(1)}）` };
      if (evt.state === 'running') {
        const i = typeof evt.stepIndex === 'number' ? evt.stepIndex : 0;
        const st = plan[i];
        const who = st ? `${resolveAgentLabel(st.agent, 'live', agentNames)}・${DISCUSSION_ROLE_LABELS[str(st.role)] ?? str(st.role)}` : '不明';
        return { kind: 'program', text: `${name}: ${i + 1}/${plan.length}番目の発言（${who}${research}）` };
      }
      if (evt.state === 'finished') return { kind: 'program', text: `${name}が終わりました（${Number(evt.turns) || 0}発言）` };
      if (evt.state === 'cancelled') return { kind: 'program', text: `${name}は準備の後にオフへ切り替えられたため流しませんでした` };
      return { kind: 'program', text: `${name}の状態が変わりました` };
    }
    case 'DISCUSSION_SETTINGS':
      return { kind: 'listener', text: '討論コーナーのオン・オフが切り替えられました' };

    // ── My Secretary（秘書） ────────────────────────────────────────────────
    case 'SECRETARY_ACTIVITY': {
      const label: Record<string, string> = {
        idle: '待機中に戻りました',
        searching: '調べ物・作業を始めました',
        speaking: '話し始めました',
      };
      return { kind: 'secretary', text: label[str(evt.state)] ?? `状態が変わりました（${str(evt.state)}）` };
    }
    case 'SECRETARY_LOOP_STATUS':
      return {
        kind: 'secretary',
        text: evt.state === 'checking'
          ? '定期チェックを始めました（メール・予定・天気・ニュース・相場）'
          : '定期チェックが終わりました',
      };
    case 'SECRETARY_CONSULTING':
      return {
        kind: 'secretary',
        text: evt.agentKey
          ? `${resolveAgentLabel(evt.agentKey, 'live', agentNames)}へ取り次ぎました（本人の声で回答中）`
          : '取り次ぎ先の回答が終わりました',
      };
    case 'SECRETARY_LINE_REQUEST':
      if (evt.state === 'processing') return { kind: 'secretary', text: `LINEから依頼が届きました: ${quote(evt.requestText)}` };
      if (evt.error) return { kind: 'alert', text: `LINEの依頼の処理に失敗しました: ${str(evt.error, '原因不明')}` };
      return { kind: 'secretary', text: `LINEへ返信しました: ${quote(evt.replyExcerpt)}` };
    // ヘルパー。会話の裏で走る作業の進み具合を見えるようにする
    case 'SECRETARY_HELPER_JOB':
      if (evt.state === 'running') {
        return { kind: 'secretary', text: `ヘルパーが作業中（${str(evt.progress, '準備中')}）: ${quote(evt.request)}` };
      }
      if (evt.status === 'failed') {
        return { kind: 'alert', text: `ヘルパーの作業が失敗しました: ${quote(evt.request)}` };
      }
      return { kind: 'secretary', text: `ヘルパーが作業を終えました: ${quote(evt.request)}` };

    // ── 記録 ────────────────────────────────────────────────────────────────
    case 'DIARY_WRITTEN':
      return {
        kind: 'record',
        text: `${resolveAgentLabel(evt.agentKey, evt.channel, agentNames)}が今日の振り返りを日記に書きました: ${quote(evt.excerpt, 40)}`,
      };

    // ── 注意・エラー ────────────────────────────────────────────────────────
    case 'SYSTEM_ERROR':
      return { kind: 'alert', text: `${errorCodeLabel(evt.code)}${evt.message ? ` — ${str(evt.message)}` : ''}` };
    case 'EARTHQUAKE_ALERT':
      return {
        kind: 'alert',
        text: `緊急地震速報: ${str(evt.hypocenter, '震源不明')}・最大震度${str(evt.maxScaleLabel, '不明')}`,
      };

    default:
      // 音楽チャンネルの「もう一度」のリクエストの待ち行列（CLASSIC_QUEUE_UPDATE など）
      if (evt.event.endsWith('_QUEUE_UPDATE')) {
        const q = Array.isArray(evt.queue) ? evt.queue.length : 0;
        return { kind: 'listener', text: `「もう一度」リクエストの待ち行列を更新しました（${q}件）` };
      }
      // サーバーにイベントが増えたとき、内部の名前を出さずに気づけるようにする
      return { kind: 'record', text: `未対応の通知を受信しました（種別: ${evt.event}）` };
  }
}
