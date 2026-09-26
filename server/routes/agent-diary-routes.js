/**
 * @file エージェント日記の閲覧 API（GET /api/agent-diary）
 *
 * lib/agent-diary.js が保存した日記を、チャンネル・エージェントで絞り込んで返す読み取り専用の API。
 * 日記の書き込みは各チャンネルのコーナー終了時などのフックから行うので、ここでは扱わない。
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

const { listDiaryEntries } = require('../lib/agent-diary');

/**
 * ルートを登録する。
 *
 * クエリ: channel（例: live）・agentKey・limit（既定 200）
 * @param {import('express').Express} app
 */
function registerAgentDiaryRoutes(app) {
  app.get('/api/agent-diary', (req, res) => {
    try {
      const { channel, agentKey, limit } = req.query;
      const entries = listDiaryEntries({
        channel: channel || null,
        agentKey: agentKey || null,
        limit: limit ? parseInt(limit, 10) : 200,
      });
      res.json(entries);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerAgentDiaryRoutes };
