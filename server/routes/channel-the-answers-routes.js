/**
 * @file The Answers 固有の API（エピソードの開始・挙手・発言・状態・アーカイブ）
 *
 *   - POST   /api/the_answers/start-session          … 議題を受け取ってエピソードを始める（議題は事前に審査する）
 *   - GET    /api/the_answers/theme-candidates       … 議題の候補
 *   - POST   /api/the_answers/hand-raise・submit-text … リスナーの挙手と発言
 *   - GET    /api/the_answers/status                 … 進行の状態と出演者
 *   - GET    /api/the_answers/archive[/:id/audio]    … アーカイブの一覧と録音
 *   - POST   /api/the_answers/archive/:id/summarize  … AI による要約（作成済みならそれを返す）
 *   - DELETE /api/the_answers/archive/:id            … アーカイブの削除（録音も消す）
 *
 * 設定・試聴・BGM などの定型の API は channel-api.js が登録する。
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

/**
 * ルートを登録する。getSystem は The Answers のシステムを返す（server.js で後から代入されるため、
 * 値ではなく取得関数で受け取る）。ARCHIVE_PATH・ARCHIVE_AUDIO_DIR はアーカイブの JSON と録音のフォルダー。
 * @param {import('express').Express} app
 * @param {{
 *   getSystem: () => any, readJsonFile: Function,
 *   ARCHIVE_PATH: string, ARCHIVE_AUDIO_DIR: string,
 * }} ctx
 */
function registerTheAnswersRoutes(app, ctx) {
  const { getSystem, readJsonFile, ARCHIVE_PATH, ARCHIVE_AUDIO_DIR } = ctx;

  app.post('/api/the_answers/start-session', async (req, res) => {
    try {
      const sys = getSystem();
      const topic = (req.body?.topic || '').trim();
      if (topic) {
        const mod = await sys._moderateText(topic);
        if (!mod.allowed) return res.status(400).json({ ok: false, error: 'その内容は番組では紹介できません。表現を変えて試してみてください。' });
      }
      const result = await sys.startEpisode(topic);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/the_answers/theme-candidates', async (req, res) => {
    try { res.json({ themes: await getSystem().generateThemeCandidates() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/the_answers/hand-raise', (req, res) => {
    try { getSystem().raiseHand(req.body?.clientId); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/the_answers/submit-text', async (req, res) => {
    try { await getSystem().submitUserText(req.body?.clientId, req.body?.text || ''); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/the_answers/status', (req, res) => {
    const sys = getSystem();
    res.json({
      state: sys._state,
      topic: sys._topic,
      panel: Object.values(sys._activePanel).map(p => ({ key: p.poolKey, name: p.name, role: p.role })),
    });
  });

  /** アーカイブの一覧（日時・議題・出演者・全発言・録音の情報）。 */
  app.get('/api/the_answers/archive', (req, res) => {
    try { res.json(readJsonFile(ARCHIVE_PATH, [])); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /** 録音（MP3）を返す。sendFile なので Range に対応し、途中から再生できる。 */
  app.get('/api/the_answers/archive/:id/audio', (req, res) => {
    const list = readJsonFile(ARCHIVE_PATH, []);
    const entry = list.find(e => e.id === req.params.id);
    if (!entry || !entry.recordingFilename) return res.status(404).json({ error: '録音が見つかりません' });
    const filePath = path.join(ARCHIVE_AUDIO_DIR, entry.recordingFilename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'ファイルが存在しません' });
    res.sendFile(filePath);
  });

  /** AI による要約を作る（作成済みならそれを返す）。 */
  app.post('/api/the_answers/archive/:id/summarize', async (req, res) => {
    try {
      const result = await getSystem().generateArchiveSummary(req.params.id);
      if (result?.error) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** アーカイブを1件削除する（録音も消す）。 */
  app.delete('/api/the_answers/archive/:id', (req, res) => {
    try {
      const result = getSystem().deleteArchiveEntry(req.params.id);
      if (result?.error) return res.status(404).json({ error: result.error });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerTheAnswersRoutes };
