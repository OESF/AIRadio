/**
 * @file AI Radio 管理人の「お問い合わせ・リクエスト」窓口の API と、交通情報の道路の自動提案
 *
 * GET /api/text-command/greeting、POST /api/text-command、POST /api/suggest-traffic-areas。
 *
 * text-command は入力を操作の種類へ分類し（voice-command-classifier.js）、管理人の声で相づちを合成して返す。
 * 質問に答えられるよう、番組の文脈（長期記憶・直近の会話・チャンネルの再生履歴）を渡す。音声合成には Live の
 * agentSystem を使う（起動後に作られるので、関数を通して受け取る）。実際の操作（チャンネルの切り替え・音量など）は、
 * 返した intent を見てクライアントが行う。
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
const { getLogger } = require('../logger');
const { classifyVoiceCommand, isVoiceCommandRequestFeasible } = require('../voice-command-classifier');
const activityDb = require('../activity-db');

/**
 * 管理人の窓口の API を登録する。
 * @param {import('express').Express} app
 * @param {{
 *   getAgentSystem: () => any, readJsonFile: Function,
 *   getInitialConfig: Function, getInitialCredentials: Function,
 *   CONFIG_PATH: string, CREDENTIALS_PATH: string, CONV_HISTORY_PATH: string, DATA_DIR: string,
 * }} ctx
 */
function registerTextCommandRoutes(app, ctx) {
  const {
    getAgentSystem, readJsonFile, getInitialConfig, getInitialCredentials,
    CONFIG_PATH, CREDENTIALS_PATH, CONV_HISTORY_PATH, DATA_DIR,
  } = ctx;

  const LONG_TERM_MEMORY_PATH = path.join(DATA_DIR, 'long_term_memory.json');

  // 音楽チャンネルの再生履歴。Live のような会話の記録や長期記憶を持たないチャンネルでも、「さっきの曲は？」に
  // 答えられるよう、再生履歴をそのまま文脈に使う（24/You も含む）
  const CHANNEL_PLAYED_PATHS = {
    classic: path.join(DATA_DIR, 'channels', 'classic', 'played_tracks.json'),
    jazz:    path.join(DATA_DIR, 'channels', 'jazz',    'played_tracks.json'),
    mood:    path.join(DATA_DIR, 'channels', 'mood',    'played_tracks.json'),
    beatles: path.join(DATA_DIR, 'channels', 'beatles', 'played_tracks.json'),
    '24you': path.join(DATA_DIR, 'channels', '24you',   'played_tracks.json'),
  };

  // played_tracks.json の1件を、読める1行にする（チャンネルごとに項目の名前が違う）
  function summarizePlayedEntry(entry) {
    const label = entry.composer && entry.composition
      ? `${entry.composer}「${entry.composition}」`
      : entry.artist && entry.title
        ? `${entry.artist} - ${entry.title}`
        : entry.title || entry.trackName || '(不明な曲)';
    const when = entry.playedAt ? new Date(entry.playedAt).toLocaleString('ja-JP') : '';
    return `・${when} ${label}`;
  }

  /**
   * 番組の文脈（長期記憶・直近の会話・チャンネルの再生履歴）を、質問への回答の材料としてまとめる。
   * @param {*} channel 今のチャンネル（無ければ null）
   * @returns {{ longTermContext: string, recentConversation: string, playedHistoryContext: string }}
   */
  function buildBroadcastContext(channel) {
    // 直近の会話（最新の30件）。Live の会話の記録なので、Live 以外では使わない
    let recentConversation = '';
    if ((!channel || channel === 'live') && fs.existsSync(CONV_HISTORY_PATH)) {
      try {
        const lines = fs.readFileSync(CONV_HISTORY_PATH, 'utf8').split('\n').filter(l => l.trim());
        const entries = lines.slice(-30).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (entries.length > 0) {
          recentConversation = entries.map(e => `${e.agentKey}: ${e.text}`).join('\n');
        }
      } catch { /* ignore */ }
    }

    // 長期記憶（最新の30件。トークンを節約するため、日付・要約・話題などだけを取る）。これも Live だけ
    let longTermContext = '';
    if ((!channel || channel === 'live') && fs.existsSync(LONG_TERM_MEMORY_PATH)) {
      try {
        const memData = JSON.parse(fs.readFileSync(LONG_TERM_MEMORY_PATH, 'utf8'));
        const memEntries = (memData.entries || []).slice(-30);
        const memLines = memEntries.map(e => {
          const parts = [`・${e.date}: ${e.summary}`];
          if ((e.topics || []).length > 0)        parts.push(`  [話題: ${e.topics.join('、')}]`);
          if ((e.music_played || []).length > 0)  parts.push(`  [曲: ${e.music_played.join(' / ')}]`);
          if (e.weather)                          parts.push(`  [天気: ${e.weather}]`);
          if (e.world_report_city)                parts.push(`  [ワールドレポート: ${e.world_report_city}]`);
          if (e.recipe)                           parts.push(`  [レシピ: ${e.recipe}]`);
          if ((e.news_headlines || []).length > 0) parts.push(`  [ニュース: ${e.news_headlines.join(' / ')}]`);
          return parts.join('\n');
        });
        if ((memData.recent_topics || []).length > 0) {
          memLines.push(`・最近の話題: ${memData.recent_topics.join('、')}`);
        }
        if (memData.listener_memory) memLines.push(`・リスナーメモ: ${memData.listener_memory}`);
        longTermContext = memLines.join('\n');
      } catch { /* ignore */ }
    }

    // 音楽チャンネルは会話の記録を持たない（24/You はナレーション自体が無い）ので、再生履歴を代わりにする
    let playedHistoryContext = '';
    const playedPath = channel && CHANNEL_PLAYED_PATHS[channel];
    if (playedPath && fs.existsSync(playedPath)) {
      try {
        const played = JSON.parse(fs.readFileSync(playedPath, 'utf8'));
        if (Array.isArray(played) && played.length > 0) {
          playedHistoryContext = played.slice(0, 20).map(summarizePlayedEntry).join('\n');
        }
      } catch { /* ignore */ }
    }

    return { longTermContext, recentConversation, playedHistoryContext };
  }

  /**
   * 管理人の声でテキストを合成し、WAV（Base64）にして返す。
   * cacheable なら lib/pcm-cache.js のディスクのキャッシュを使い、決まった文を合成し直さない。
   * @param {string} text
   * @param {{ cacheable?: boolean }} [opts]
   * @returns {Promise<string|null>} 失敗したら null（クライアントは文字の表示だけにする）
   */
  async function synthesizeAdministratorSpeech(text, { cacheable = false } = {}) {
    const agentSystem = getAgentSystem();
    if (!text || !agentSystem) return null;
    const pcmCache = cacheable ? require('../lib/pcm-cache') : null;
    const agentCfg = cacheable ? (agentSystem.getConfig()?.agents?.administrator || {}) : null;
    const cacheKey = pcmCache ? pcmCache.buildKey(text, agentCfg) : null;
    try {
      if (pcmCache) {
        const cache = pcmCache.load();
        if (cache[cacheKey]) return cache[cacheKey];
      }
      const pcm = await agentSystem._collectPcm(text, 'administrator');
      if (!pcm || pcm.length === 0) return null;
      const wav = agentSystem._pcmToWav(pcm, 24000, 1, 16);
      const base64 = wav.toString('base64');
      if (pcmCache) {
        const cache = pcmCache.load();
        cache[cacheKey] = base64;
        pcmCache.persist();
      }
      return base64;
    } catch (e) {
      getLogger().warn(`[TextCommand] AI管理者音声合成失敗: ${e.message}`);
      return null;
    }
  }

  // 実行できないリクエストへの案内は、内容に関わらずこの決まった文にする（ディスクのキャッシュから合成できる）
  const VOICE_COMMAND_DECLINE_MESSAGE = '申し訳ありません。ご依頼いただいたリクエストは処理できません。';

  /**
   * GET /api/text-command/greeting
   * 窓口を開いた直後に管理人が話す挨拶を返す。リスナーの名前で呼びかける（決まった文なのでキャッシュから合成する）。
   */
  app.get('/api/text-command/greeting', async (req, res) => {
    // 窓口の画面に出している文と同じ内容を読み上げる。リスナーの名前はチャンネルに依らない設定なので、いつも使う
    const baseGreeting = 'AI Radio管理人です。\nご質問・チャンネル操作・曲や話題のリクエストなど、何でもどうぞ。';
    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    const userName = config.show?.user_profile?.name || 'リスナー';
    const greeting = `はい、${userName}さん。${baseGreeting}`;
    const speechWavBase64 = await synthesizeAdministratorSpeech(greeting, { cacheable: true });
    res.json({ speechWavBase64 });
  });

  /**
   * POST /api/text-command
   * body: { text: string, channel: string|null }
   * 入力を操作の種類へ分類し、管理人の声の相づち（WAV の Base64）と一緒に返す。放送の有無に関わらず HTTP の応答で
   * 直接返すので、チャンネルのミキサーには依存しない。このAPIは分類だけで、実際の操作はクライアントが行う。
   */
  app.post('/api/text-command', async (req, res) => {
    try {
      const agentSystem = getAgentSystem();
      if (!agentSystem) return res.status(503).json({ intent: 'unrecognized', error: 'not ready' });
      const text = (req.body?.text || '').toString().trim();
      if (!text) return res.status(400).json({ intent: 'unrecognized', error: 'text is required' });

      const creds  = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
      const apiKey = creds?.gemini?.api_key;
      const channel = (req.body?.channel || '').toString() || null;
      const administratorName = agentSystem.getConfig()?.agents?.administrator?.name;
      const broadcastContext = buildBroadcastContext(channel);
      // 稼働レポートに載せるため、1回のリクエストを管理人用の1つのセッションとして開く
      const activitySessionId = activityDb.openSession('administrator');
      const { intent, params, response } = await classifyVoiceCommand(text, {
        apiKey, channel, isStreaming: !!channel, administratorName, ...broadcastContext,
        activitySessionId,
      });
      // 実行できるかは LLM の返答に頼らずコードで判定し、できなければ決まった文に差し替える
      const feasible = isVoiceCommandRequestFeasible(intent, params, channel);
      const message = feasible ? response : VOICE_COMMAND_DECLINE_MESSAGE;
      const speechWavBase64 = await synthesizeAdministratorSpeech(message, { cacheable: !feasible });
      // 音声合成（_collectPcm）の使用量は Live のセッションの側に記録される。ここで閉じるのは分類の分だけ
      activityDb.closeSession(activitySessionId);
      res.json({ intent, params, message, speechWavBase64 });
    } catch (e) {
      getLogger().error(`[TextCommand] エラー: ${e.message}`);
      res.status(500).json({ intent: 'unrecognized', error: e.message });
    }
  });

  /**
   * POST /api/suggest-traffic-areas
   * body: { location: string }
   * 住んでいる場所から、よく使いそうな高速道路・幹線道路を Gemini に5〜7件挙げさせる（管理画面の交通情報の設定）。
   */
  app.post('/api/suggest-traffic-areas', async (req, res) => {
    const { location } = req.body || {};
    if (!location) return res.status(400).json({ error: 'location is required' });

    try {
      const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
      const apiKey = creds?.gemini?.api_key;
      if (!apiKey) return res.status(503).json({ error: 'Gemini API key not configured' });

      const { generateText } = require('../lib/llm-client');

      const prompt = `ユーザーの居住地は「${location}」です。
この居住地の住民が通勤・日常のドライブ・外出で利用しそうな高速道路・都市高速・主要幹線道路を 5〜7 件リストアップしてください。

条件:
- 日本国内の実在する道路・路線名を使うこと
- Google Search のクエリとして使えるよう「路線名（区間・方面）」形式で具体的に書くこと
  例: 「阪神高速3号神戸線（西行き）」「名神高速（大阪〜京都区間）」「首都高C1（都心環状線）」
- 居住地から実際にアクセスしやすい道路を優先すること
- 居住地から離れた関係のない道路は含めないこと

出力形式: JSON 配列のみ（説明文・コメント不要）
例: ["道路名1", "道路名2", "道路名3"]`;

      // 管理画面の機能もコストがかかるので、稼働レポートに載せる
      const _suggestSessionId = activityDb.openSession('administrator');
      const { text: _rawText, usage: _u } = await generateText({
        tier: 'main',
        apiKey,
        prompt,
        agentKey: 'administrator',
        activitySessionId: _suggestSessionId,
        logMeta: { purpose: 'suggest_traffic_areas' },
      });
      activityDb.closeSession(_suggestSessionId);
      const text = _rawText.trim();
      getLogger().info(`[SuggestTraffic] usage(prompt=${_u.promptTokens ?? '?'} out=${_u.outputTokens ?? '?'} thoughts=${_u.thoughtsTokens ?? '?'})`);

      // 前後にマークダウンなどが付いていても、JSON の配列だけを取り出す
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) {
        getLogger().warn(`[SuggestTraffic] JSON parse failed: ${text.slice(0, 200)}`);
        return res.status(500).json({ error: 'Failed to parse Gemini response' });
      }
      const areas = JSON.parse(match[0]);
      if (!Array.isArray(areas)) return res.status(500).json({ error: 'Unexpected response format' });

      getLogger().info(`[SuggestTraffic] ${location} → ${areas.join(', ')}`);
      res.json({ areas });
    } catch (e) {
      getLogger().error(`[SuggestTraffic] Error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerTextCommandRoutes };
