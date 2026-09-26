/**
 * @file Spotify の再生用トークンと、診断・試験用の API
 *
 *   - GET /api/spotify/sdk-token   … ブラウザの Web Playback SDK に渡すアクセストークン
 *   - GET /test/spotify/diagnose   … トークンの取得と簡単な検索が通るかを確かめる
 *   - GET /test/spotify/scan       … 国（market）ごとに、試聴用の URL がある曲を探す
 *   - GET /test/spotify            … 曲を検索して試聴を再生する（?play=false で確認だけ）
 * /test/* は開発・検証用。/test/spotify は既定で実際に再生するので注意。
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

/**
 * ルートを登録する。Spotify の処理は Live のシステムのものを使う。
 * @param {import('express').Express} app
 * @param {{ getAgentSystem: () => any }} ctx getAgentSystem は Live のシステムを返す（server.js で後から
 *   代入されるため、値ではなく取得関数で受け取る）
 */
function registerSpotifyDiagnosticsRoutes(app, ctx) {
  const { getAgentSystem } = ctx;

  app.get('/api/spotify/sdk-token', async (req, res) => {
    try {
      const token = await getAgentSystem()._getSpotifyToken();
      if (!token) return res.status(503).json({ error: 'Spotify 未設定またはトークン取得失敗' });
      res.json({ access_token: token });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/test/spotify/diagnose', async (req, res) => {
    const agentSystem = getAgentSystem();
    const result = {};
    try {
      result.token = await agentSystem._getSpotifyToken() ? 'OK' : 'FAIL';
      if (result.token === 'OK') {
        const token = await agentSystem._getSpotifyToken();
        const r = await fetch('https://api.spotify.com/v1/search?q=YOASOBI&type=track&limit=3', {
          headers: { Authorization: `Bearer ${token}` }
        });
        result.search_status = r.status;
        const data = await r.json();
        result.search_items = data.tracks?.items?.length ?? 0;
        result.sample = data.tracks?.items?.[0] ? {
          name: data.tracks.items[0].name,
          artist: data.tracks.items[0].artists[0].name,
          uri: data.tracks.items[0].uri,
          preview_url: data.tracks.items[0].preview_url,
        } : null;
      }
    } catch (e) {
      result.error = e.message;
    }
    res.json(result);
  });

  app.get('/test/spotify/scan', async (req, res) => {
    const agentSystem = getAgentSystem();
    const market = req.query.market || 'JP';
    const queries = ['j-pop 2025', 'j-pop 2024', 'anime song 2025', 'pop 2025', 'k-pop 2025',
                     'YOASOBI', 'Ado', 'Official髭男dism', 'Mrs. GREEN APPLE', 'back number'];
    try {
      const token = await agentSystem._getSpotifyToken();
      if (!token) return res.json({ ok: false, error: 'Spotify トークン取得失敗' });
      const results = [];
      for (const q of queries) {
        const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10&market=${market}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { results.push({ q, error: `HTTP ${r.status}` }); continue; }
        const data = await r.json();
        const items = data.tracks?.items || [];
        const withPreview = items.filter(t => t.preview_url);
        results.push({
          q, market, total: items.length, withPreview: withPreview.length,
          samples: withPreview.slice(0, 2).map(t => `${t.artists[0].name} / ${t.name}`),
        });
      }
      res.json({ ok: true, market, results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/test/spotify', async (req, res) => {
    const agentSystem = getAgentSystem();
    const query = req.query.q || 'YOASOBI/アイドル';
    const play  = req.query.play !== 'false';
    try {
      const track = await agentSystem._searchSpotifyTrack(query);
      if (!track) return res.json({ ok: false, error: 'トラックが見つかりません', query });
      if (!track.preview_url) return res.json({ ok: false, error: 'preview_url なし', track, query });
      if (play) agentSystem._playSpotifyPreview(track.preview_url).catch(() => {});
      res.json({ ok: true, message: play ? '再生開始！' : '確認のみ', track, query });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, query });
    }
  });
}

module.exports = { registerSpotifyDiagnosticsRoutes };
