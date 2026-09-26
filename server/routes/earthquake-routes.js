/**
 * @file 緊急地震速報（EEW）のチャイム配信と試験発火の API
 *
 *   - GET  /api/earthquake-chime … チャイム音（mp3）を返す
 *   - POST /api/test-earthquake  … 試験用の速報を発火する（開発・検証用）
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
 * @param {{ CHIME_PATH: string, getMonitor: () => any }} ctx
 *   CHIME_PATH はチャイム音のファイル。getMonitor は EEW の監視を返す
 *   （server.js で後から代入されるため、値ではなく取得関数で受け取る）
 */
function registerEarthquakeRoutes(app, ctx) {
  const { CHIME_PATH, getMonitor } = ctx;

  app.get('/api/earthquake-chime', (req, res) => {
    if (!fs.existsSync(CHIME_PATH)) return res.status(404).json({ error: 'チャイムファイルが見つかりません' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(CHIME_PATH).pipe(res);
  });

  // body は速報の内容の上書き（震度・地域など）。省略すると既定の試験データ
  app.post('/api/test-earthquake', (req, res) => {
    const earthquakeMonitor = getMonitor();
    if (!earthquakeMonitor) return res.status(503).json({ error: 'EEW モニター未起動' });
    const overrides = req.body || {};
    earthquakeMonitor.testFire(overrides);
    res.json({ ok: true, message: 'テスト EEW を発火しました', overrides });
  });
}

module.exports = { registerEarthquakeRoutes };
