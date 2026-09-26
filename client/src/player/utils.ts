/**
 * @file プレーヤー画面（index.html）専用の小さな関数（ショートカット・エージェントの絵文字・設定の保存・リクエストの送信）
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

import type { RefObject } from 'react';
import type { ShortcutConfig } from './types';

/**
 * KeyboardEvent.code を表示用のキー名にする（KeyM → M、Digit1 → 1）。
 * @param code KeyboardEvent.code
 */
export function formatShortcutCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'Space';
  return code;
}
/**
 * ショートカットを「Ctrl+Option+M」の形にする。
 * @param s ショートカットの設定
 */
export function formatShortcut(s: ShortcutConfig): string {
  const parts: string[] = [];
  if (s.ctrlKey) parts.push('Ctrl');
  if (s.altKey) parts.push('Option');
  if (s.shiftKey) parts.push('Shift');
  if (s.metaKey) parts.push('Cmd');
  parts.push(formatShortcutCode(s.code));
  return parts.join('+');
}

/**
 * エージェントのキーから、アバター画像が無いときに代わりに出す絵文字を返す。
 * @param key エージェントのキー
 * @returns 登録が無ければ 🤖
 */
export function getAgentEmoji(key: string): string {
  const map: Record<string, string> = {
    caster: '🎙', assistant: '✨', weather: '☀️', traffic: '🚦',
    news: '📰', finance: '📈', music_dj: '🎧', commentator: '📚',
    journalist: '🕵️', life_advisor: '💚', world_report: '🌍',
    legal_advisor: '⚖️', director: '🎬',
    comedian: '🎤', doctor: '🩺', marketer: '💡',
    secretary: '🎙️',
    classic_personality: '🎼',
    jazz_personality: '🎷', jazz_director: '🎬',
  };
  return map[key] ?? '🤖';
}

/**
 * 「名前（役割）」または「名前(役割)」の形のエージェント名を、名前と役割に分ける。
 * @param fullName エージェント名
 * @returns 役割が無ければ role は空文字
 */
export function parseAgentName(fullName: string): { displayName: string; role: string } {
  const m = fullName.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/);
  if (m) return { displayName: m[1].trim(), role: m[2].trim() };
  return { displayName: fullName, role: '' };
}

// ─── 画面の設定（この端末の localStorage に保存） ─────────────────────────────
export const PREFS_KEY = 'airadio-player-prefs';
/** 画面の設定を読む。読めなければ空。 */
export const _loadPrefs = (): Record<string, unknown> => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
};
/** 画面の設定のうち、渡した項目だけを書き換えて保存する。 */
export const _savePrefs = (patch: Record<string, unknown>) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ..._loadPrefs(), ...patch })); } catch {}
};

/**
 * WebSocket で届いた一覧（CLASSIC_PLAYED_LIST など）を、配列であることを確かめてから setter に渡す。
 * 音楽チャンネルと24/You で共通。
 * @param setter 状態の setter
 * @param value 届いた値（配列でなければ何もしない）
 */
export function applyListUpdate<T>(setter: (list: T[]) => void, value: unknown) {
  if (Array.isArray(value)) setter(value as T[]);
}

// ─── 音楽チャンネル共通のリクエストの送信 ─────────────────────────────────

/**
 * 「もう一度聴く」を WebSocket で送り、受け付けたことをトーストで知らせる。接続していなければ何もしない。
 * @param wsRef WebSocket
 * @param showInfo お知らせのトースト
 * @param event 送るイベント名（例: CLASSIC_REPLAY_REQUEST）
 * @param track もう一度聴く曲
 * @param label トーストに出す曲の表記
 * @param emoji トーストの頭に付ける絵文字
 */
export function sendChannelReplayRequest(
  wsRef: RefObject<WebSocket | null>, showInfo: (msg: string) => void,
  event: string, track: unknown, label: string, emoji: string,
) {
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
  wsRef.current.send(JSON.stringify({ event, track }));
  showInfo(`${emoji} ${label} のリクエストを受け付けました`);
}

/**
 * 選曲リクエストを HTTP（POST /api/<channelSlug>/listener-request）で送る。
 * @param channelSlug チャンネル名（URL に使う）
 * @param requestText 送るリクエストの文
 * @param onSuccess 送れたときに呼ぶ（入力欄を空にするなど）
 * @param successMessage 送れたときのトースト
 * @param errorMessage 送れなかったときのトースト
 */
export async function postListenerRequest(
  serverUrl: string, showInfo: (msg: string) => void, showWarn: (msg: string) => void,
  channelSlug: string, requestText: string, onSuccess: () => void,
  successMessage: string, errorMessage = '送信に失敗しました。',
) {
  try {
    await fetch(`${serverUrl}/api/${channelSlug}/listener-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: requestText }),
    });
    onSuccess();
    showInfo(successMessage);
  } catch { showWarn(errorMessage); }
}
