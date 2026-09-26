/**
 * @file ダッシュボードに表示する、討論コーナーのオン・オフ
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

import { useEffect, useState } from 'react';
import type { DiscussionSettings } from '../types';

/**
 * 討論コーナーのオン・オフ（config.show.discussion_corners）を返す。
 *
 * プレーヤー画面で切り替えるとサーバーが DISCUSSION_SETTINGS を流し、Live のスナップショット
 * （fromSnapshot）に入る。一度も切り替えていなければスナップショットには無いので、
 * 接続したときに config を読んでおき、スナップショットが無い間はそちらを使う。
 *
 * ATTENTION: WebSocket が繋ぎ直されたとき（サーバーの再起動）も読み直すこと。再起動で
 *            スナップショットは空に戻るので、読み直さないと開いた時点の古い値が表示される。
 * @param serverUrl サーバーの URL
 * @param connected WebSocket が繋がっているか（false→true になるたびに読み直す）
 * @param fromSnapshot Live のスナップショットにある値
 * @returns 設定。まだ読めていなければ null
 */
export function useDiscussionSettings(
  serverUrl: string,
  connected: boolean,
  fromSnapshot: DiscussionSettings | null | undefined,
): DiscussionSettings | null {
  const [fetched, setFetched] = useState<DiscussionSettings | null>(null);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    fetch(`${serverUrl}/api/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setFetched((d.show?.discussion_corners as DiscussionSettings | undefined) ?? {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverUrl, connected]);

  return fromSnapshot ?? fetched;
}
