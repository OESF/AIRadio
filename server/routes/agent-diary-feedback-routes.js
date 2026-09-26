/**
 * @file エージェント日記のフィードバックを手動で走らせる API（POST /api/agent-diary-feedback/run）
 *
 * lib/agent-diary-feedback.js の週次バッチ（runFeedbackForAllChannels）を、曜日・時刻の条件を
 * 無視してすぐに1回実行する。動作確認・手動実行用。
 * 普段の自動実行（日曜4:30）は server.js の5分ごとの定期処理から別に呼ばれる。
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

const { runFeedbackForAllChannels } = require('../lib/agent-diary-feedback');
const { getLogger } = require('../logger');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ readJsonFile: Function, getInitialCredentials: Function, CREDENTIALS_PATH: string,
 *           getInitialConfig: Function, CONFIG_PATH: string }} ctx
 */
function registerAgentDiaryFeedbackRoutes(app, ctx) {
  const { readJsonFile, getInitialCredentials, CREDENTIALS_PATH, getInitialConfig, CONFIG_PATH } = ctx;

  app.post('/api/agent-diary-feedback/run', async (req, res) => {
    try {
      const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
      const apiKey = creds?.gemini?.api_key;
      if (!apiKey) return res.status(400).json({ error: 'Gemini API キーが設定されていません' });
      const config = readJsonFile(CONFIG_PATH, getInitialConfig());

      const result = await runFeedbackForAllChannels({ config, apiKey });
      res.json(result);
    } catch (e) {
      getLogger().warn(`[AgentDiaryFeedback] 手動実行に失敗: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerAgentDiaryFeedbackRoutes };
