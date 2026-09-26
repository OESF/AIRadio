/**
 * @file Live の音声合成を試聴する API（POST /api/live/tts-test）
 *
 * 管理画面の「試聴」から呼ばれ、Live の Gemini TTS 合成をそのまま使って WAV を返す。
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

const { getLogger } = require('../logger');

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ getAgentSystem: () => any, pcmToWav: (buf: Buffer, rate?: number) => Buffer }} ctx
 */
function registerTtsTestRoutes(app, ctx) {
  const { getAgentSystem, pcmToWav } = ctx;

  // body: { text, gemini_voice?, tts_profile_title?, tts_scene?, tts_style?, tts_accent?,
  //         tts_pacing?, tts_context?, gemini_language? }
  app.post('/api/live/tts-test', async (req, res) => {
    const { text, gemini_voice, gemini_language,
            tts_profile_title, tts_scene, tts_style, tts_accent, tts_pacing, tts_context,
            gemini_instruction } = req.body; // gemini_instruction は後方互換
    if (!text) return res.status(400).json({ error: 'text は必須です' });

    try {
      const agentSystem = getAgentSystem();
      const pcm = await agentSystem._geminiSynthesizeToBuffer(text, gemini_voice || 'Kore', {
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
      getLogger().error('[Live TTS Test] Error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerTtsTestRoutes };
