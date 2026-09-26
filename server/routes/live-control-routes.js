/**
 * @file Live チャンネルの操作 API（状態・番組終了・ディレクションの送信）
 *
 *   - GET  /api/status    … 終了処理中でなければ ready: true
 *   - POST /api/show/end  … エンディングを始める
 *   - POST /api/direction … ディレクターへの指示を config.json の show.current_instruction に書く
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
 * ルートを登録する。getAgentSystem は Live のシステムを返す（server.js で後から代入されるため、
 * 値ではなく取得関数で受け取る）。
 * @param {import('express').Express} app
 * @param {{
 *   getAgentSystem: () => any, readJsonFile: Function,
 *   getInitialConfig: Function, CONFIG_PATH: string, getLogger: () => any,
 * }} ctx
 */
function registerLiveControlRoutes(app, ctx) {
  const { getAgentSystem, readJsonFile, getInitialConfig, CONFIG_PATH, getLogger } = ctx;

  app.get('/api/status', (req, res) => {
    res.json({ ready: !getAgentSystem()._isShuttingDown });
  });

  app.post('/api/show/end', (req, res) => {
    getAgentSystem().runEndingSequence().catch(err => {
      getLogger().error('[Server] Ending sequence error: ' + err.message);
    });
    res.json({ success: true, message: 'Ending sequence started' });
  });

  app.post('/api/direction', (req, res) => {
    const { instruction, instantMusicCheck } = req.body;
    try {
      const config = readJsonFile(CONFIG_PATH, getInitialConfig());
      config.show.current_instruction = instruction;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

      // 管理人の依頼（instantMusicCheck）のときだけ、曲名らしき語があればすぐに曲を予約する
      // （リスナーの乱入と同じ救済処理）
      const agentSystem = getAgentSystem();
      if (instantMusicCheck && agentSystem) {
        agentSystem._instantMusicRequestIfDetected(instruction);
      }

      res.json({ success: true, instruction });
    } catch (e) {
      res.status(500).json({ error: 'Failed to send instruction' });
    }
  });
}

module.exports = { registerLiveControlRoutes };
