/**
 * @file 秘書の学習内容・リスナー像の閲覧と訂正、資産の共有内容と通知件数の API
 *
 *   - GET/DELETE/PUT /api/secretary-memory[/:id]         … 学習内容の一覧・削除・編集
 *   - GET/PUT        /api/secretary-digest               … リスナー像（学習内容の要約）の閲覧・手での訂正
 *   - GET            /api/finance-public-summary         … Live へ共有している資産の構成比（読み取りのみ）
 *   - GET            /api/secretary-notifications/pending-count … 伝えたいことの件数（ウェルカム画面の印）
 *
 * 学習内容の追加は remember_fact ツールと会話終了時の自動要約で行う。自動要約が誤った内容を記録する
 * ことがあるので、管理画面から削除・編集できるようにしている。
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

const { readLearnings, deleteLearning, updateLearning, readDigest, updateDigestManually, readFinancePublicSummary } = require('../lib/secretary-memory');
const { peekPendingNotificationCount } = require('../lib/secretary-loop');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 */
function registerSecretaryMemoryRoutes(app) {
  app.get('/api/secretary-memory', (req, res) => {
    try {
      const entries = readLearnings().slice().sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
      res.json(entries);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/secretary-memory/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'idが不正です' });
      const ok = deleteLearning(id);
      if (!ok) return res.status(404).json({ error: '指定された学習内容が見つかりませんでした' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/secretary-memory/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'idが不正です' });
      const text = (req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'textが空です' });
      const ok = updateLearning(id, text);
      if (!ok) return res.status(404).json({ error: '指定された学習内容が見つかりませんでした' });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // リスナー像（学習内容の全件を要約した文章）。要約が誤ることがあるので、手で直せるようにしている
  app.get('/api/secretary-digest', (req, res) => {
    try {
      res.json(readDigest());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/secretary-digest', (req, res) => {
    try {
      const text = (req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'textが空です' });
      const digest = updateDigestManually(text);
      res.json({ success: true, digest });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Live へ共有している資産の構成比（%）とファンド名。確かめるためのもので、書き込みは
  // update_finance_report ツールだけが行う
  app.get('/api/finance-public-summary', (req, res) => {
    try {
      res.json(readFinancePublicSummary());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 自律ループが見つけた「伝えたいこと」の件数（接続前のウェルカム画面に印を出すため）。
  // ATTENTION: 数えるだけで消さないこと（peek を使う）。接続して挨拶で伝えるまでは残しておく
  app.get('/api/secretary-notifications/pending-count', (req, res) => {
    try {
      res.json({ count: peekPendingNotificationCount() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerSecretaryMemoryRoutes };
