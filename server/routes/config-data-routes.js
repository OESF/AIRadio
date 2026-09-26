/**
 * @file 設定とデータのファイルの読み書きの API（config・ウォッチリスト・接続情報・読みの辞書など）
 *
 * GET・POST /api/config、POST /api/discussion-corners/:key、GET・POST /api/finance-watchlist・
 * /api/journalist-watchlist・/api/credentials・/api/tts-dict。どれも server/data の JSON を読み書きする。
 * パスと共通の関数は server.js から受け取る。ウォッチリストの保存でキャッシュを消すため、Live の agentSystem を
 * 関数を通して受け取る。
 *
 * ATTENTION: config.json の中の一部（finance_watchlist・journalist_watchlist・show.discussion_corners）は、
 *            専用の API でだけ更新する。POST /api/config ではディスクの今の値を正とし、送られてきた値は使わない。
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
const { getLogger } = require('../logger');
const { writeJsonFile } = require('../lib/atomic-json');

/**
 * 設定とデータの API を登録する。
 * @param {import('express').Express} app
 * @param {{
 *   CONFIG_PATH: string, CREDENTIALS_PATH: string, TTS_DICT_PATH: string,
 *   readJsonFile: Function, getInitialConfig: Function, getInitialCredentials: Function,
 *   fillConfigDefaults: Function, getAgentSystem: () => any,
 * }} ctx
 */
function registerConfigDataRoutes(app, ctx) {
  const {
    CONFIG_PATH, CREDENTIALS_PATH, TTS_DICT_PATH,
    readJsonFile, getInitialConfig, getInitialCredentials, fillConfigDefaults, getAgentSystem,
  } = ctx;

  const JOURNALIST_WATCHLIST_DEFAULT = {
    japan_official: [], japan_politics: [], us_official: [], us_politics: [],
    tech_business: [], world_leaders: [], international_orgs: [], primary_wire: [], sports: [],
  };

  app.get('/api/config', (req, res) => {
    const stored = readJsonFile(CONFIG_PATH, getInitialConfig());
    // 足りない項目を既定値で埋めてから返す
    const config = fillConfigDefaults(stored, getInitialConfig());
    res.json(config);
  });

  app.post('/api/config', (req, res) => {
    try {
      // BUGFIX: 2つのウォッチリストは専用の API でだけ更新するので、ディスクの今の値を使い、送られてきた値は無視する。
      //         管理画面が読み込んだときの古い設定のまま保存すると、専用の API で加えた変更が巻き戻った。
      const current = readJsonFile(CONFIG_PATH, getInitialConfig());
      const newConfig = {
        ...req.body,
        finance_watchlist: current.finance_watchlist,
        journalist_watchlist: current.journalist_watchlist,
      };
      // 討論コーナーのオン・オフ（show.discussion_corners）も同じ。再生画面のチェックボックスで専用の API から変わるので、
      // 管理画面の保存で巻き戻らないよう、ディスクの今の値を使う
      if (newConfig.show && typeof newConfig.show === 'object' && current.show?.discussion_corners) {
        newConfig.show = { ...newConfig.show, discussion_corners: current.show.discussion_corners };
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
      res.json({ success: true, config: newConfig });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  // ─── 討論コーナーのオン・オフ（再生画面のチェックボックス） ───
  // リスナーが「報道センター（金融情報センター）のコーナーを、議論つきで広げて聴きたいか」を選ぶもの。討論コーナーだけを
  // 単独でリクエストする形にしないのは、取材や冒頭の案内の先読みが、直前のコーナーの読み上げ中に行われるため。
  // 押した瞬間に config.json に書き、次のセッションや再起動の後も引き継ぐ（放送は毎回ディスクから読むので、
  // すぐ効く）。書き換えるのはそのコーナーの enabled だけ。
  app.post('/api/discussion-corners/:key', (req, res) => {
    try {
      const { DISCUSSION_CORNERS } = require('../lib/agent-discussion-corner');
      const key = String(req.params.key || '');
      if (!Object.prototype.hasOwnProperty.call(DISCUSSION_CORNERS, key)) {
        return res.status(400).json({ error: `不明な討論コーナーです: ${key}` });
      }
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled は true か false で指定してください' });
      }
      const current = readJsonFile(CONFIG_PATH, getInitialConfig());
      const show = (current.show && typeof current.show === 'object') ? current.show : {};
      const corners = (show.discussion_corners && typeof show.discussion_corners === 'object')
        ? show.discussion_corners : {};
      const next = {
        ...current,
        show: {
          ...show,
          discussion_corners: { ...corners, [key]: { ...(corners[key] || {}), enabled } },
        },
      };
      writeJsonFile(CONFIG_PATH, next);
      // ダッシュボードの表示をその場で合わせる（Live の配信に乗せるが、再生画面は知らないイベントを無視する）
      try {
        getAgentSystem()?._broadcast?.({ event: 'DISCUSSION_SETTINGS', corners: next.show.discussion_corners });
      } catch (e) {
        getLogger().debug(`[Config] ダッシュボードへの通知に失敗（保存は完了）: ${e.message}`);
      }
      getLogger().info(`[Config] 討論コーナー ${key} を${enabled ? 'オン' : 'オフ'}にしました（再生画面から）`);
      res.json({ ok: true, key, enabled });
    } catch (e) {
      getLogger().warn(`[Config] 討論コーナーのオン・オフの保存に失敗: ${e.message}`);
      res.status(500).json({ error: '保存に失敗しました' });
    }
  });

  // ─── 金融のウォッチリスト ───
  app.get('/api/finance-watchlist', (req, res) => {
    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    res.json(config.finance_watchlist || { indices: [], forex: [], bonds: [], commodities: [], stocks: [] });
  });

  app.post('/api/finance-watchlist', (req, res) => {
    try {
      const config = readJsonFile(CONFIG_PATH, getInitialConfig());
      config.finance_watchlist = req.body;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
      // キャッシュを消して、次の取得で新しい設定を使う。
      // BUGFIX: プロパティは financeService（以前の名前 financeCache のままで、消す処理が一度も効いていなかった）。
      //         金融のデータは1日1回の取得なので、消えないと次の朝まで反映されない。
      const agentSystem = getAgentSystem();
      if (agentSystem && agentSystem.financeService) {
        agentSystem.financeService.clear();
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save finance watchlist' });
    }
  });

  // ─── ジャーナリストのウォッチリスト ───
  app.get('/api/journalist-watchlist', (req, res) => {
    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    res.json(config.journalist_watchlist || JOURNALIST_WATCHLIST_DEFAULT);
  });

  app.post('/api/journalist-watchlist', (req, res) => {
    try {
      const config = readJsonFile(CONFIG_PATH, getInitialConfig());
      config.journalist_watchlist = req.body;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save journalist watchlist' });
    }
  });

  app.get('/api/credentials', (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    // API キーやシークレットは伏せて返す
    const maskedCreds = {
      gemini: {
        api_key: creds.gemini.api_key ? '●●●●●●●●' + creds.gemini.api_key.slice(-4) : ""
      },
      google: {
        client_id: creds.google.client_id ? '●●●●' + creds.google.client_id.slice(-4) : "",
        client_secret: creds.google.client_secret ? '●●●●' : "",
        refresh_token: creds.google.refresh_token ? '●●●●' : ""
      },
      spotify: {
        client_id: creds.spotify.client_id ? '●●●●' + creds.spotify.client_id.slice(-4) : "",
        client_secret: creds.spotify.client_secret ? '●●●●' : "",
        refresh_token: creds.spotify.refresh_token ? '●●●●' : ""
      },
      openweathermap: {
        api_key: (creds.openweathermap && creds.openweathermap.api_key)
          ? '●●●●' + creds.openweathermap.api_key.slice(-4) : ""
      },
      youtube: {
        api_key: (creds.youtube && creds.youtube.api_key)
          ? '●●●●' + creds.youtube.api_key.slice(-4) : ""
      },
      line: {
        channel_access_token: (creds.line && creds.line.channel_access_token)
          ? '●●●●' + creds.line.channel_access_token.slice(-4) : "",
        channel_secret: (creds.line && creds.line.channel_secret)
          ? '●●●●' : "",
      },
    };
    res.json(maskedCreds);
  });

  app.post('/api/credentials', (req, res) => {
    try {
      const currentCreds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
      const inputCreds = req.body;

      // 伏せ字のままの項目は変えず、入力された項目だけを上書きする
      if (inputCreds.gemini) {
        if (!currentCreds.gemini) currentCreds.gemini = {};
        if (inputCreds.gemini.api_key && !inputCreds.gemini.api_key.includes('●●●●')) {
          currentCreds.gemini.api_key = inputCreds.gemini.api_key;
        }
        if (inputCreds.gemini.tts_model !== undefined) {
          if (inputCreds.gemini.tts_model) currentCreds.gemini.tts_model = inputCreds.gemini.tts_model;
          else delete currentCreds.gemini.tts_model;
        }
        if (inputCreds.gemini.model !== undefined) {
          if (inputCreds.gemini.model) currentCreds.gemini.model = inputCreds.gemini.model;
          else delete currentCreds.gemini.model;
        }
        if (inputCreds.gemini.image_model !== undefined) {
          if (inputCreds.gemini.image_model) currentCreds.gemini.image_model = inputCreds.gemini.image_model;
          else delete currentCreds.gemini.image_model;
        }
      }
      if (inputCreds.google) {
        if (inputCreds.google.client_id && !inputCreds.google.client_id.includes('●●●●')) {
          currentCreds.google.client_id = inputCreds.google.client_id;
        }
        if (inputCreds.google.client_secret && !inputCreds.google.client_secret.includes('●●●●')) {
          currentCreds.google.client_secret = inputCreds.google.client_secret;
        }
        if (inputCreds.google.refresh_token && !inputCreds.google.refresh_token.includes('●●●●')) {
          currentCreds.google.refresh_token = inputCreds.google.refresh_token;
        }
      }
      if (inputCreds.spotify) {
        if (inputCreds.spotify.client_id && !inputCreds.spotify.client_id.includes('●●●●')) {
          currentCreds.spotify.client_id = inputCreds.spotify.client_id;
        }
        if (inputCreds.spotify.client_secret && !inputCreds.spotify.client_secret.includes('●●●●')) {
          currentCreds.spotify.client_secret = inputCreds.spotify.client_secret;
        }
        if (inputCreds.spotify.refresh_token && !inputCreds.spotify.refresh_token.includes('●●●●')) {
          currentCreds.spotify.refresh_token = inputCreds.spotify.refresh_token;
        }
      }
      if (inputCreds.openweathermap && inputCreds.openweathermap.api_key
          && !inputCreds.openweathermap.api_key.includes('●●●●')) {
        if (!currentCreds.openweathermap) currentCreds.openweathermap = {};
        currentCreds.openweathermap.api_key = inputCreds.openweathermap.api_key;
      }
      if (inputCreds.youtube && inputCreds.youtube.api_key
          && !inputCreds.youtube.api_key.includes('●●●●')) {
        if (!currentCreds.youtube) currentCreds.youtube = {};
        currentCreds.youtube.api_key = inputCreds.youtube.api_key;
      }
      if (inputCreds.line) {
        if (!currentCreds.line) currentCreds.line = {};
        if (inputCreds.line.channel_access_token && !inputCreds.line.channel_access_token.includes('●●●●')) {
          currentCreds.line.channel_access_token = inputCreds.line.channel_access_token;
        }
        if (inputCreds.line.channel_secret && !inputCreds.line.channel_secret.includes('●●●●')) {
          currentCreds.line.channel_secret = inputCreds.line.channel_secret;
        }
      }
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(currentCreds, null, 2), 'utf-8');
      res.json({ success: true, message: 'Credentials updated successfully' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save credentials' });
    }
  });

  /** GET /api/tts-dict — 現在の辞書エントリ一覧を返す */
  app.get('/api/tts-dict', (req, res) => {
    try {
      const dict = readJsonFile(TTS_DICT_PATH, []);
      res.json(dict);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/tts-dict — 辞書を上書き保存する */
  app.post('/api/tts-dict', (req, res) => {
    try {
      const dict = req.body;
      if (!Array.isArray(dict)) return res.status(400).json({ error: '配列形式で送信してください' });
      // 保存する前に、各項目の正規表現が正しいかを確かめる
      for (const entry of dict) {
        try { new RegExp(entry.pattern, entry.flags || 'g'); }
        catch (e) { return res.status(400).json({ error: `不正な正規表現: id=${entry.id} pattern="${entry.pattern}" — ${e.message}` }); }
      }
      fs.writeFileSync(TTS_DICT_PATH, JSON.stringify(dict, null, 2), 'utf-8');
      getLogger().info(`[TtsDict] 辞書を保存しました (${dict.length}件)`);
      res.json({ ok: true, count: dict.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerConfigDataRoutes };
