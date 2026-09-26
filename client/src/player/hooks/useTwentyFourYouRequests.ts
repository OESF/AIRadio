/**
 * @file 24/You チャンネルの選曲モード・好きなアーティスト・わがままリクエスト・洋楽邦楽の切り替え
 *
 * どれも POST /api/24you/mode で送る。
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

import { useState } from 'react';
import type { TwentyFourYouMode, TwentyFourYouLanguagePref } from '../types';

/** useTwentyFourYouRequests が受け取るもの。 */
export interface UseTwentyFourYouRequestsDeps {
  serverUrl: string;
  showInfo: (msg: string) => void;
  showWarn: (msg: string) => void;
}

/**
 * 24/You の選曲の設定の状態と、それをサーバーへ送る関数を返す。
 * @returns 各設定の値と setter、送信・追加・削除の関数
 */
export function useTwentyFourYouRequests({ serverUrl, showInfo, showWarn }: UseTwentyFourYouRequestsDeps) {
  const [twentyFourYouMode, setTwentyFourYouMode] = useState<TwentyFourYouMode>('omakase');
  const [twentyFourYouAnokoroAge, setTwentyFourYouAnokoroAge] = useState<string>('');
  const [twentyFourYouArtists, setTwentyFourYouArtists] = useState<string[]>([]);
  const [twentyFourYouArtistInput, setTwentyFourYouArtistInput] = useState('');
  const [twentyFourYouWagamamaRequest, setTwentyFourYouWagamamaRequest] = useState('');
  const [twentyFourYouLanguagePref, setTwentyFourYouLanguagePref] = useState<TwentyFourYouLanguagePref>('any');

  /** 選曲モードを切り替える。「あの頃」なら年齢も送る。 */
  const sendTwentyFourYouMode = async (mode: TwentyFourYouMode, anokoroAge?: string) => {
    setTwentyFourYouMode(mode);
    const body: Record<string, unknown> = { mode };
    if (mode === 'anokoro') {
      body.anokoro_age = anokoroAge ? parseInt(anokoroAge, 10) : null;
    }
    try {
      await fetch(`${serverUrl}/api/24you/mode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      showInfo('🔀 選曲モードを変更しました');
    } catch {
      showWarn('モードの変更に失敗しました');
    }
  };

  /** 好きなアーティストの一覧を置き換えて送る。 */
  const sendTwentyFourYouArtists = async (artists: string[]) => {
    setTwentyFourYouArtists(artists);
    try {
      await fetch(`${serverUrl}/api/24you/mode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite_artists: artists }),
      });
    } catch {
      showWarn('アーティストリストの更新に失敗しました');
    }
  };

  /** 入力欄のアーティスト（カンマ・読点で区切って複数可）を、重ならないように足す。 */
  const addTwentyFourYouArtist = () => {
    const names = twentyFourYouArtistInput.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    const merged = [...twentyFourYouArtists, ...names.filter(n => !twentyFourYouArtists.includes(n))];
    sendTwentyFourYouArtists(merged);
    setTwentyFourYouArtistInput('');
  };

  const removeTwentyFourYouArtist = (name: string) => {
    sendTwentyFourYouArtists(twentyFourYouArtists.filter(a => a !== name));
  };

  /** プロフィールにある好きなアーティストを1人足す。 */
  const addTwentyFourYouArtistFromProfile = (name: string) => {
    if (twentyFourYouArtists.includes(name)) return;
    sendTwentyFourYouArtists([...twentyFourYouArtists, name]);
  };

  /** 「わがまま」モードのリクエストを送る。 */
  const sendTwentyFourYouWagamama = async (request: string) => {
    setTwentyFourYouWagamamaRequest(request);
    try {
      await fetch(`${serverUrl}/api/24you/mode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wagamama_request: request }),
      });
      showInfo('🎁 わがままリクエストを反映しました');
    } catch {
      showWarn('リクエストの送信に失敗しました');
    }
  };

  /** 洋楽・邦楽の指定を送る。 */
  const sendTwentyFourYouLanguagePref = async (pref: TwentyFourYouLanguagePref) => {
    setTwentyFourYouLanguagePref(pref);
    try {
      await fetch(`${serverUrl}/api/24you/mode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language_pref: pref }),
      });
    } catch {
      showWarn('言語設定の変更に失敗しました');
    }
  };

  return {
    twentyFourYouMode, setTwentyFourYouMode, twentyFourYouAnokoroAge, setTwentyFourYouAnokoroAge,
    twentyFourYouArtists, setTwentyFourYouArtists, twentyFourYouArtistInput, setTwentyFourYouArtistInput,
    twentyFourYouWagamamaRequest, setTwentyFourYouWagamamaRequest,
    twentyFourYouLanguagePref, setTwentyFourYouLanguagePref,
    sendTwentyFourYouMode, addTwentyFourYouArtist, removeTwentyFourYouArtist,
    addTwentyFourYouArtistFromProfile, sendTwentyFourYouWagamama, sendTwentyFourYouLanguagePref,
  };
}
