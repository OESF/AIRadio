/**
 * @file クライアント画面（client/dist）の配信と、SPA のフォールバック
 *
 * ビルド済みの画面があれば配信し、どのルートにも当たらない画面の URL には HTML を返す
 * （/admin → admin.html、/dashboard → dashboard.html、それ以外 → index.html のプレーヤー）。
 * ビルドが無ければ '/' に案内の文言を返す（開発時はクライアントの dev サーバーを別に起動する）。
 *
 * ATTENTION: この関数は、全ての API・test のルートを登録した後、WebSocket を作る前に呼ぶこと。
 *            フォールバックは /api・/test を素通しするが、後から登録した API ルートが先に評価される
 *            保証はない。
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
const express = require('express');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ clientBuildPath: string }} ctx clientBuildPath は client/dist の絶対パス
 */
function registerStaticRoutes(app, ctx) {
  const { clientBuildPath } = ctx;

  if (fs.existsSync(clientBuildPath)) {
    // /assets/ はファイル名に内容のハッシュが入るので長期キャッシュしてよい。
    // それ以外（index.html など）はキャッシュさせず、常に最新を返す
    app.use('/assets', express.static(path.join(clientBuildPath, 'assets'), {
      maxAge: '1y', immutable: true,
    }));
    app.use(express.static(clientBuildPath, { maxAge: 0, etag: false }));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/test')) {
        return next();
      }
      res.setHeader('Cache-Control', 'no-store');
      if (req.path.startsWith('/admin')) {
        return res.sendFile(path.join(clientBuildPath, 'admin.html'));
      }
      if (req.path.startsWith('/dashboard')) {
        return res.sendFile(path.join(clientBuildPath, 'dashboard.html'));
      }
      res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.send('AI Radio Backend is running. Build the client project to access UI here, or run the client dev server.');
    });
  }
}

module.exports = { registerStaticRoutes };
