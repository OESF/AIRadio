/**
 * @file チャンネル共通の API（設定・リクエスト・BGM・試聴）をまとめて登録する
 *
 * Classic・Jazz・Mood・Beatles・The Answers が共有する定型の API:
 *   - GET/POST /api/<ch>/config            … 設定の読み書き
 *   - POST     /api/<ch>/listener-request  … リスナーのリクエスト
 *   - GET      /api/<ch>/bgm/all           … BGM の一覧（opening・main・ending）
 *   - GET      /api/<ch>/bgm-preview/...   … BGM の試聴（静的配信）
 *   - POST     /api/<ch>/tts-test          … 声の試聴
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
const { getLogger } = require('../logger');

/**
 * 1つのチャンネルの共通 API を登録する。
 * @param {import('express').Express} app
 * @param {string} channelName          チャンネル名（小文字にして URL に使う）
 * @param {string} configPath           チャンネルの config.json の絶対パス
 * @param {() => any} getSystem         チャンネルのシステムを返す（server.js で後から代入されるため、
 *                                      値ではなく取得関数で受け取る）
 * @param {string} defaultGeminiVoice   試聴で声が指定されなかったときの Gemini TTS の声
 * @param {{ readJsonFile: Function, pcmToWav: (buf: Buffer, rate?: number) => Buffer,
 *           assetsRoot: string }} ctx  server.js の共通の関数と、assets フォルダーの絶対パス
 */
function registerChannelApi(app, channelName, configPath, getSystem, defaultGeminiVoice, ctx) {
  const { readJsonFile, pcmToWav, assetsRoot } = ctx;
  const name = channelName.toLowerCase();
  const assetsBase = path.join(assetsRoot, 'channels', name, 'bgm');
  const listBgmDir = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
      .map(f => ({ filename: f, size: fs.statSync(path.join(dir, f)).size }));
  };

  app.get(`/api/${name}/config`, (req, res) => {
    try { res.json(readJsonFile(configPath, {})); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post(`/api/${name}/config`, (req, res) => {
    try { fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), 'utf-8'); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post(`/api/${name}/listener-request`, (req, res) => {
    try { const sys = getSystem(); if (sys) sys.handleListenerRequest(req.body.request || ''); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get(`/api/${name}/bgm/all`, (req, res) => {
    try {
      res.json({
        opening: listBgmDir(path.join(assetsBase, 'opening')),
        main:    listBgmDir(path.join(assetsBase, 'main')),
        // ending（エンディングのジングル）は The Answers だけ。他のチャンネルでは空になる
        ending:  listBgmDir(path.join(assetsBase, 'ending')),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.use(`/api/${name}/bgm-preview`, express.static(assetsBase));

  app.post(`/api/${name}/tts-test`, async (req, res) => {
    const { text, gemini_voice, gemini_language,
            tts_profile_title, tts_scene, tts_style, tts_accent, tts_pacing, tts_context,
            gemini_instruction } = req.body; // gemini_instruction は後方互換
    if (!text) return res.status(400).json({ error: 'text は必須です' });
    try {
      const sys = getSystem();
      const pcm = await sys._geminiSynthesizeToBuffer(text, gemini_voice || defaultGeminiVoice, {
        profileTitle: tts_profile_title || '',
        scene:        tts_scene         || '',
        style:        tts_style         || gemini_instruction || '',
        accent:       tts_accent        || (gemini_language ? `Speak in ${gemini_language}` : ''),
        pacing:       tts_pacing        || '',
        context:      tts_context       || '',
        languageCode: gemini_language   || null,
      });
      res.setHeader('Content-Type', 'audio/wav');
      res.send(pcmToWav(pcm));
    } catch (e) {
      getLogger().error(`[${channelName} TTS Test] Error: ` + e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerChannelApi };
