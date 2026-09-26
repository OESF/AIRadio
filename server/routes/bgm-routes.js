/**
 * @file Live の BGM の一覧・試聴・試験用ストリーミングの API
 *
 *   - GET /api/bgm             … メインの BGM の一覧と、今流れているファイル
 *   - GET /api/bgm/all         … 全区分（メイン・オープニング・ワールドレポートのジングルと環境音）
 *   - GET /api/bgm-preview/... … 管理画面での試聴（静的配信）
 *   - GET /test/bgm/:filename  … ffmpeg で 24kHz・ステレオの WAV にして流し続ける（試験用）
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
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ BGM_DIR: string, getMixer: () => any }} ctx BGM_DIR は BGM のフォルダー、getMixer は
 *   Live のミキサーを返す（今流れているファイル名を知るため。server.js で後から代入されるので取得関数で受け取る）
 */
function registerBgmRoutes(app, ctx) {
  const { BGM_DIR, getMixer } = ctx;

  app.get('/api/bgm', (req, res) => {
    try {
      const files = fs.readdirSync(BGM_DIR)
        .filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
        .map(f => ({
          filename: f,
          size: fs.statSync(path.join(BGM_DIR, f)).size
        }));
      res.json({ files, current: getMixer().currentBgmFile });
    } catch (e) {
      res.status(500).json({ error: 'Failed to list BGM files' });
    }
  });

  /** 全区分の BGM をまとめて返す。 */
  app.get('/api/bgm/all', (req, res) => {
    try {
      const BASE = BGM_DIR;

      const listDir = (dir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
          .filter(f => (f.endsWith('.mp3') || f.endsWith('.wav')) && !f.startsWith('.'))
          .map(f => ({ filename: f, size: fs.statSync(path.join(dir, f)).size }))
          .sort((a, b) => a.filename.localeCompare(b.filename));
      };

      // ワールドレポートの環境音は都市などのサブフォルダーに分かれている（フォルダー名 → ファイル一覧）
      const listAmbientFolders = (dir) => {
        if (!fs.existsSync(dir)) return {};
        const result = {};
        fs.readdirSync(dir).forEach(item => {
          const fullPath = path.join(dir, item);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              const files = listDir(fullPath);
              result[item] = files; // 空のフォルダーも含める
            }
          } catch (_) { /* ignore */ }
        });
        return result;
      };

      const wrDir = path.join(BASE, 'world_report');
      res.json({
        main:    { files: listDir(BASE), current: getMixer().currentBgmFile },
        opening: listDir(path.join(BASE, 'opening')),
        world_report: {
          jingles: listDir(wrDir),
          ambient: listAmbientFolders(wrDir),
        },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use('/api/bgm-preview', express.static(BGM_DIR));

  // 試験用: 24kHz・ステレオの WAV（形式を指定していないので既定の 16bit）で、BGM を繰り返し流し続ける
  app.get('/test/bgm/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(BGM_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('BGM file not found');
    }
    const args = [
      '-stream_loop', '-1',
      '-i', filePath,
      '-ar', '24000',
      '-ac', '2',
      '-f', 'wav',
      'pipe:1'
    ];
    const ffmpeg = spawn(ffmpegStatic, args);
    res.setHeader('Content-Type', 'audio/wav');
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {}); // ffmpeg の進捗の出力は読み捨てる
    ffmpeg.on('close', () => {
      if (!res.headersSent) {
        res.end();
      }
    });
    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });
  });
}

module.exports = { registerBgmRoutes };
