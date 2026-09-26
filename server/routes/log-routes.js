/**
 * @file ログの取得とリリースノートの API（/api/logs・/api/release-notes）
 *
 * ログは logger.js が logs/ に書く JSON Lines を、新しいファイルの末尾から読んで返す。
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
const path = require('path');
const { getLogger, getLogDir, LEVEL_LABEL } = require('../logger');

/** ログレベルの名前 → pino の数値。 */
const LEVEL_NUMS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ RELEASE_NOTES_PATH: string }} ctx RELEASE_NOTES_PATH は RELEASENOTE.md の絶対パス
 */
function registerLogRoutes(app, ctx) {
  const { RELEASE_NOTES_PATH } = ctx;

  // 最新のログファイルの末尾から、minLevel（既定 info）以上を最大 limit 件（既定 300・上限 1000）返す
  app.get('/api/logs', (req, res) => {
    const minLevel  = LEVEL_NUMS[req.query.minLevel] ?? 30;
    const limit     = Math.min(parseInt(req.query.limit) || 300, 1000);
    const logDir    = getLogDir();

    // ファイル名は日付ごとなので、更新日時が最も新しい .log を使う
    let logFile = null;
    try {
      const files = fs.readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ f, mtime: fs.statSync(path.join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) logFile = path.join(logDir, files[0].f);
    } catch { /* ディレクトリなし */ }

    if (!logFile) return res.json([]);

    try {
      // 大きなファイルを全部読まないよう、末尾の 512KB だけを読む
      const MAX_BYTES = 512 * 1024;
      const stat = fs.statSync(logFile);
      const start = Math.max(0, stat.size - MAX_BYTES);
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);

      const entries = buf.toString('utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(e => e && typeof e.level === 'number' && e.level >= minLevel)
        .slice(-limit)
        .map(e => ({
          time:  e.time,
          level: e.level,
          label: LEVEL_LABEL[e.level] ?? '?????',
          msg:   e.msg ?? '',
        }));

      res.json(entries);
    } catch (e) {
      getLogger().error('[LogAPI] Failed to read log file: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // RELEASENOTE.md の内容を返す（管理画面のリリースノート）
  app.get('/api/release-notes', (req, res) => {
    try {
      const content = fs.readFileSync(RELEASE_NOTES_PATH, 'utf-8');
      res.json({ content });
    } catch (e) {
      res.status(404).json({ error: 'RELEASENOTE.md が見つかりません' });
    }
  });
}

module.exports = { registerLogRoutes };
