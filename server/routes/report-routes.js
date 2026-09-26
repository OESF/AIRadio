/**
 * @file 稼働レポートの API（/api/report/*。セッション・コストの集計）
 *
 * activity-db.js に記録したセッションとコストを集計して返す。管理画面の稼働レポートから使う。
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

const activityDb = require('../activity-db');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 */
function registerReportRoutes(app) {
  /** セッションの一覧。クエリ: channel・from・to・limit（既定 50）・offset */
  app.get('/api/report/sessions', (req, res) => {
    try {
      const { channel, from, to, limit = 50, offset = 0 } = req.query;
      const result = activityDb.querySessions({ channel, from, to, limit, offset });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** セッション1件の詳細（イベントの一覧と統計）。 */
  app.get('/api/report/sessions/:id', (req, res) => {
    try {
      const detail = activityDb.querySessionDetail(Number(req.params.id));
      if (!detail) return res.status(404).json({ error: 'not found' });
      res.json(detail);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** 期間の集計。クエリ: channel・from・to */
  app.get('/api/report/summary', (req, res) => {
    try {
      const { channel, from, to } = req.query;
      res.json(activityDb.querySummary({ channel, from, to }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** 日ごと・モデル別の概算コスト（コストのグラフ用）。クエリ: days */
  app.get('/api/report/daily-cost', (req, res) => {
    try {
      res.json(activityDb.queryDailyCost({ days: req.query.days }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Gemini のコストの、モデル別・エージェント別の集計。クエリ: channel・from・to */
  app.get('/api/report/cost-breakdown', (req, res) => {
    try {
      const { channel, from, to } = req.query;
      res.json(activityDb.queryCostBreakdown({ channel, from, to }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerReportRoutes };
