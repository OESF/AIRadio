/**
 * @file プレーヤー画面のキーボードショートカット（マウスを使わずに一通り操作できるように）
 *
 * ショートカットは管理画面の「ショートカットキー設定」で変えられる（config.shortcuts）。既定はすべて
 * Ctrl+Option+<キー>。入力欄にフォーカスがある間は反応しない。
 *
 * ATTENTION: 既定の組み合わせを足すときは、macOS 標準のショートカットとぶつからないことを実機で
 *            確かめること（例: Ctrl+Option+Space は入力ソースの切り替えに使われている）。
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

import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { ShortcutAction, FullConfig, CornerKey } from '../types';
import { DEFAULT_SHORTCUTS } from '../types';
import type { ChannelId } from '../constants';

/** useKeyboardShortcuts が受け取るもの（Player.tsx の状態と操作）。 */
export interface UseKeyboardShortcutsDeps {
  config: FullConfig | null;
  selectedChannel: ChannelId | null;
  isStreamingRef: RefObject<boolean>;
  volumeRef: RefObject<number>;
  pendingConnectRef: RefObject<boolean>;
  infoChatOpenRef: RefObject<boolean>;
  setSelectedChannel: (id: ChannelId) => void;
  setInfoChatOpen: (open: boolean) => void;
  setSavedRecipesOpen: (updater: (prev: boolean) => boolean) => void;
  stopRadioStream: () => void;
  startRadioStream: () => Promise<void>;
  openInquiryBox: () => void;
  toggleMute: () => void;
  handleVolumeChange: (val: number) => void;
  sendCornerRequest: (corner: CornerKey) => void;
  theAnswersCandidates: string[];
  fetchTheAnswersCandidates: () => Promise<void>;
}

/**
 * キー入力を見張り、ショートカットに合えば操作を行う。
 *
 * 操作: 問い合わせ窓口の開閉・ミュート・音量・接続の開始と停止・レシピの表示・チャンネルの切り替え・
 * コーナーのリクエスト（Live のときだけ）。
 */
export function useKeyboardShortcuts({
  config, selectedChannel, isStreamingRef, volumeRef, pendingConnectRef, infoChatOpenRef,
  setSelectedChannel, setInfoChatOpen, setSavedRecipesOpen, stopRadioStream, startRadioStream,
  openInquiryBox, toggleMute, handleVolumeChange, sendCornerRequest,
  theAnswersCandidates, fetchTheAnswersCandidates,
}: UseKeyboardShortcutsDeps) {
  useEffect(() => {
    const shortcuts = config?.shortcuts ?? {};
    const matches = (action: ShortcutAction, e: KeyboardEvent) => {
      const s = shortcuts[action] ?? DEFAULT_SHORTCUTS[action];
      return !!s && e.ctrlKey === s.ctrlKey && e.altKey === s.altKey
        && e.metaKey === s.metaKey && e.shiftKey === s.shiftKey && e.code === s.code;
    };
    const switchChannel = (id: ChannelId) => {
      if (selectedChannel === id && isStreamingRef.current) return;
      if (isStreamingRef.current) stopRadioStream();
      pendingConnectRef.current = id !== 'the_answers';
      setSelectedChannel(id);
      if (id === 'the_answers' && theAnswersCandidates.length === 0) fetchTheAnswersCandidates();
    };
    const CHANNEL_ACTIONS: Partial<Record<ShortcutAction, ChannelId>> = {
      channel_live: 'live', channel_classic: 'classic', channel_jazz: 'jazz',
      channel_mood: 'mood', channel_beatles: 'beatles', channel_24you: '24you',
      channel_the_answers: 'the_answers',
    };
    // コーナーのリクエストは Live を選んでいるときだけ効く（handleKeyDown で判定）
    const CORNER_ACTIONS: Partial<Record<ShortcutAction, CornerKey>> = {
      corner_weather: 'weather', corner_traffic: 'traffic', corner_news: 'news',
      corner_finance: 'finance', corner_commentator: 'commentator', corner_journalist: 'journalist',
      corner_music_dj: 'music_dj', corner_life_advisor: 'life_advisor',
      corner_world_report: 'world_report', corner_legal_advisor: 'legal_advisor',
      corner_comedian: 'comedian', corner_doctor: 'doctor', corner_marketer: 'marketer',
      corner_activities: 'activities',
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || active?.isContentEditable) return;

      if (matches('open_inquiry', e)) {
        e.preventDefault();
        if (infoChatOpenRef.current) setInfoChatOpen(false);
        else openInquiryBox();
        return;
      }
      if (matches('mute_toggle', e)) { e.preventDefault(); toggleMute(); return; }
      if (matches('volume_up', e)) { e.preventDefault(); handleVolumeChange(Math.min(100, volumeRef.current + 10)); return; }
      if (matches('volume_down', e)) { e.preventDefault(); handleVolumeChange(Math.max(0, volumeRef.current - 10)); return; }
      if (matches('toggle_connection', e)) {
        e.preventDefault();
        if (isStreamingRef.current) stopRadioStream();
        else if (selectedChannel && selectedChannel !== 'the_answers') { pendingConnectRef.current = true; startRadioStream(); }
        return;
      }
      if (matches('show_recipes', e)) { e.preventDefault(); setSavedRecipesOpen(prev => !prev); return; }
      for (const [action, id] of Object.entries(CHANNEL_ACTIONS) as [ShortcutAction, ChannelId][]) {
        if (matches(action, e)) { e.preventDefault(); switchChannel(id); return; }
      }
      if (selectedChannel === 'live') {
        for (const [action, corner] of Object.entries(CORNER_ACTIONS) as [ShortcutAction, CornerKey][]) {
          if (matches(action, e)) { e.preventDefault(); sendCornerRequest(corner); return; }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [config, selectedChannel, theAnswersCandidates]);
}
