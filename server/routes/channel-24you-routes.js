/**
 * @file 24/You チャンネルの設定・モード切替 API（/api/24you/config・/api/24you/mode）
 *
 * 24/You はナレーションのエージェントも BGM も無いため、他チャンネル共通の registerChannelApi は使わず
 * 個別に実装している。モードの切り替えは24/You のシステムに任せる。
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
 * @param {{ CONFIG_PATH: string, readJsonFile: Function, getSystem: () => any }} ctx
 *   CONFIG_PATH は24/You の設定ファイル。getSystem は24/You のシステムを返す
 *   （server.js で後から代入されるため、値ではなく取得関数で受け取る）
 */
function registerTwentyFourYouRoutes(app, ctx) {
  const { CONFIG_PATH, readJsonFile, getSystem } = ctx;

  app.get('/api/24you/config', (req, res) => {
    try { res.json(readJsonFile(CONFIG_PATH, {})); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/24you/config', (req, res) => {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2), 'utf-8'); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/24you/mode', (req, res) => {
    try { getSystem()?.handleModeChange(req.body || {}); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { registerTwentyFourYouRoutes };
