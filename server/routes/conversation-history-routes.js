/**
 * @file 会話履歴の読み出しと削除の API（/api/conversation-history）
 *
 * 会話ログは1行1件の JSON（JSONL）で、一定の大きさで世代交代する（.1 が1つ前、.2 がその前…）。
 * 現在のファイルと過去の世代をまとめて扱う。
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

const fs = require('fs');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ CONV_HISTORY_PATH: string, CONV_HISTORY_MAX_GENS: number }} ctx
 *   CONV_HISTORY_PATH は現在のログ、CONV_HISTORY_MAX_GENS は残す過去の世代数
 */
function registerConversationHistoryRoutes(app, ctx) {
  const { CONV_HISTORY_PATH, CONV_HISTORY_MAX_GENS } = ctx;

  /** 新しい順に最大 limit 件（既定 500・上限 2000）を、時刻の昇順で返す。?agent=caster で絞り込める。 */
  app.get('/api/conversation-history', (req, res) => {
    const limit       = Math.min(parseInt(req.query.limit) || 500, 2000);
    const agentFilter = req.query.agent || null; // 例: ?agent=caster

    // 古い世代から順に読む
    const files = [
      ...Array.from({ length: CONV_HISTORY_MAX_GENS }, (_, i) => `${CONV_HISTORY_PATH}.${CONV_HISTORY_MAX_GENS - i}`),
      CONV_HISTORY_PATH,
    ].filter(f => fs.existsSync(f));

    const entries = [];
    for (const file of files) {
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (!agentFilter || entry.agentKey === agentFilter) entries.push(entry);
          } catch { /* 壊れた行はスキップ */ }
        }
      } catch { /* 読めないファイルはスキップ */ }
    }

    entries.sort((a, b) => a.time - b.time);
    res.json(entries.slice(-limit));
  });

  /** 現在のログと過去の全世代を削除する。 */
  app.delete('/api/conversation-history', (req, res) => {
    try {
      [
        CONV_HISTORY_PATH,
        ...Array.from({ length: CONV_HISTORY_MAX_GENS }, (_, i) => `${CONV_HISTORY_PATH}.${i + 1}`),
      ].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ } });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerConversationHistoryRoutes };
