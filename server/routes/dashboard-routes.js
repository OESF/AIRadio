/**
 * @file ダッシュボード（/dashboard）用の API（接続数・視聴の統計・台帳の状態）
 *
 * リアルタイムの状態は WebSocket（/stream-dashboard）で送る。ここは画面を開いたときの初期値と、
 * 統計・台帳の状態を1回の GET で返すためのもの。
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
const listenerRequests = require('../lib/listener-requests');
const listenerContext = require('../lib/listener-context');
const knowledgeLedger = require('../lib/agent-knowledge-ledger');

const DASHBOARD_CHANNELS = ['live', 'classic', 'jazz', 'mood', 'beatles', 'the_answers'];

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ resolveWss: (channel: string) => any, getSecretaryWss: () => any }} ctx
 *   resolveWss はチャンネル名から WebSocket サーバーを返す（server.js で後から代入されるため、
 *   値ではなく取得関数で受け取る）
 */
function registerDashboardRoutes(app, ctx) {
  const { resolveWss, getSecretaryWss } = ctx;

  /**
   * リスナー本人の情報の台帳の状態（項目ごとの出典・更新時刻・鮮度・渡し先・公開範囲）。
   *
   * ATTENTION: 本文は返さないこと。状態を確かめるための一覧で、予定やメールの中身を持ち出す口にしない。
   */
  app.get('/api/listener-context', (req, res) => {
    res.json({ sources: listenerContext.getSnapshot(), ts: Date.now() });
  });

  /**
   * エージェントごとの「分かったこと」の台帳の件数・最新の日付・どこで知ったかの内訳（本文は返さない）。
   * エージェントの育ち具合を確かめるためのもの。
   */
  app.get('/api/agent-knowledge', (req, res) => {
    res.json({ agents: knowledgeLedger.summarizeLedger(), ts: Date.now() });
  });

  /** 全チャンネルと秘書の、今の接続数。 */
  app.get('/api/dashboard/overview', (req, res) => {
    const channels = DASHBOARD_CHANNELS.map((ch) => ({
      channel: ch,
      clientCount: resolveWss(ch)?.clients.size ?? 0,
    }));
    channels.push({
      channel: 'secretary',
      clientCount: getSecretaryWss()?.clients.size ?? 0,
    });
    res.json({ channels, ts: Date.now() });
  });

  /**
   * 視聴の統計（チャンネルごとの聴かれ方・週ごとの変化・曲ごとの再生回数・リクエスト）。
   * クエリ: days（既定 28・1〜365）。稼働レポート（/api/report/*）がコストと処理量を見るのに対し、
   * こちらは聴かれ方の傾向を見る。
   *
   * ATTENTION: この数字には開発中のテスト接続も含まれる。接続の記録に実運用かどうかの区別が無く、
   * 後から切り分けることはできない。画面にもその旨を出してあるので、傾向を見る用途に留めること。
   */
  app.get('/api/dashboard/stats', (req, res) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 1), 365);
      // 期間が長いほどバケットを粗くして、棒の本数が増えすぎないようにする
      const bucketDays = days <= 14 ? 1 : days <= 60 ? 7 : 30;
      const from = Date.now() - days * 86400000;
      const stats = activityDb.queryListeningStats({ from, bucketDays });
      res.json({
        ...stats,
        days,
        from,
        requests: listenerRequests.summarizeRequests({ days }),
        ts: Date.now(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerDashboardRoutes };
