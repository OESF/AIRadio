/**
 * @file ダッシュボードで使う、エージェントのキーから表示名への対応表
 *
 * 各チャンネルの config（config.agents.<key>.name）を読み、チャンネルごとの対応表を作る。
 * エージェント名は管理画面で変えられるので、画面に名前を固定で書かず、ここから引く。
 * The Answers は出演者の名前が PANEL_ASSIGNED イベントに含まれるので対象外。
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

/** チャンネル ID → （エージェントのキー → 表示名） */
export type AgentNameMap = Record<string, Record<string, string>>;

/** チャンネル ID → その config を返す API。 */
const CONFIG_ENDPOINTS: Record<string, string> = {
  live: '/api/config',
  classic: '/api/classic/config',
  jazz: '/api/jazz/config',
  mood: '/api/mood/config',
  beatles: '/api/beatles/config',
};

/**
 * 全チャンネルの config を読み、対応表を返す。読めたチャンネルから順に埋まっていく。
 * @param serverUrl サーバーの URL
 */
export function useAgentNames(serverUrl: string): AgentNameMap {
  const [names, setNames] = useState<AgentNameMap>({});

  useEffect(() => {
    let cancelled = false;
    for (const [channelId, path] of Object.entries(CONFIG_ENDPOINTS)) {
      fetch(`${serverUrl}${path}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d?.agents) return;
          const map: Record<string, string> = {};
          for (const [key, agent] of Object.entries(d.agents as Record<string, { name?: string }>)) {
            if (agent?.name) map[key] = agent.name;
          }
          setNames((prev) => ({ ...prev, [channelId]: map }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [serverUrl]);

  return names;
}
