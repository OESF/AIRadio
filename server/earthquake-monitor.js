/**
 * @file 緊急地震速報（EEW）の監視（P2P地震情報の WebSocket を受けて、全画面へ知らせる）
 *
 * P2P地震情報（wss://api.p2pquake.net/v2/ws）の緊急地震速報（code 556）を受け取り、警報の地域のうち
 * 震度が基準以上のものがあれば、EARTHQUAKE_ALERT を全画面に送る。切れたら5秒後につなぎ直す。
 * 都道府県の絞り込み（管理画面の「システム接続設定」）は、設定を受信のたびに読み直すので、再起動せずに効く。
 *
 * 主な利用元: server.js（起動）・routes/earthquake-routes.js（試験の発火）
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
const WebSocket = require('ws');
const { getLogger } = require('./logger');

const P2P_QUAKE_WS = 'wss://api.p2pquake.net/v2/ws';

/**
 * 震度の数値（scaleFrom・scaleTo）→ 表示。
 */
const SCALE_LABELS = {
  10: '1', 20: '2', 30: '3', 40: '4', 45: '4強',
  50: '5弱', 55: '5強', 60: '6弱', 65: '6強', 70: '7',
};

/** @param {number} n 震度の数値 @returns {string} 「5弱」などの表示 */
function scaleLabel(n) {
  return SCALE_LABELS[n] ?? `${n}`;
}

/**
 * 緊急地震速報の監視を始める。
 * @param {(data: object) => void} broadcast EARTHQUAKE_ALERT を全画面に送る関数
 * @param {{minScale?: number, configPath?: string|null}} [options]
 *   minScale は知らせる最小の震度（既定 40 = 震度4）。configPath を渡すと、config.json の
 *   show.earthquake_filter（都道府県の絞り込み）を受信のたびに読み直して使う
 * @returns {{stop: () => void, testFire: (overrides?: Record<string, any>) => void}}
 */
function startEarthquakeMonitor(broadcast, options = {}) {
  const minScale = options.minScale ?? 40;
  const configPath = options.configPath ?? null;
  let ws = null;
  let reconnectTimer = null;
  let stopped = false;

  // 都道府県の絞り込みの設定を読む。
  // ATTENTION: 読めない・未設定のときは「絞り込みなし（全国を知らせる）」にすること。「知らせない」に倒すと、
  //            設定の誤りで地震の知らせが一切来なくなり、そのほうが危ない。
  function readFilterConfig() {
    if (!configPath) return { enabled: false, pref: '' };
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return cfg.show?.earthquake_filter ?? { enabled: false, pref: '' };
    } catch {
      return { enabled: false, pref: '' };
    }
  }

  // 同じ速報を何度も知らせないため、60秒以内に知らせた速報の ID を覚えておく（ID → 時刻）
  const recentIds = new Map(); // id → timestamp

  function pruneRecentIds() {
    const cutoff = Date.now() - 60_000;
    for (const [id, ts] of recentIds) {
      if (ts < cutoff) recentIds.delete(id);
    }
  }

  function connect() {
    if (stopped) return;
    getLogger().info('[EEW] P2PQuake WebSocket に接続中…');
    ws = new WebSocket(P2P_QUAKE_WS);

    ws.on('open', () => {
      getLogger().info('[EEW] P2PQuake WebSocket 接続成功');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    });

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        handleMessage(data);
      } catch (e) {
        getLogger().warn('[EEW] JSON パース失敗:', e.message);
      }
    });

    ws.on('close', (code, reason) => {
      getLogger().warn(`[EEW] 接続切断 (code=${code}) — 5秒後に再接続`);
      ws = null;
      if (!stopped) reconnectTimer = setTimeout(connect, 5000);
    });

    ws.on('error', (e) => {
      getLogger().warn('[EEW] WebSocket エラー:', e.message);
      // onclose が続けて発火するため再接続はそちらに委任
    });
  }

  function handleMessage(data) {
    // code=556 = 緊急地震速報
    if (data.code !== 556) return;
    if (data.cancelled) {
      getLogger().info('[EEW] キャンセル受信 — 無視');
      return;
    }

    pruneRecentIds();

    // 重複チェック (id が存在する場合)
    const eewId = data.id ?? `${data.issue?.time ?? Date.now()}`;
    if (recentIds.has(eewId)) return;
    recentIds.set(eewId, Date.now());

    const areas = Array.isArray(data.areas) ? data.areas : [];

    // 警報エリア (kindCode=10) のうち scaleFrom >= minScale のもの
    const alertAreas = areas.filter(a =>
      String(a.kindCode) === '10' && (a.scaleFrom ?? 0) >= minScale
    );

    if (alertAreas.length === 0) {
      getLogger().info(`[EEW] 対象エリアなし (minScale=${minScale}) — スキップ`);
      return;
    }

    // 都道府県フィルタ（管理画面「システム接続設定」→ 緊急地震速報）。有効時は指定した
    // 都道府県が対象エリアに含まれる速報のみ通知する。震度・アラート文は「自分の地域」
    // 基準のフィルタ後エリアから算出する（全国最大震度ではなく、自分に関係する震度を伝えるため）。
    const filter = readFilterConfig();
    const targetAreas = (filter.enabled && filter.pref)
      ? alertAreas.filter(a => a.pref === filter.pref)
      : alertAreas;

    if (targetAreas.length === 0) {
      getLogger().info(`[EEW] フィルタ対象外（設定都道府県: ${filter.pref}）— スキップ`);
      return;
    }

    const maxScale = Math.max(...targetAreas.map(a => a.scaleFrom ?? 0));
    const hypo = data.earthquake?.hypocenter ?? {};
    const hypocenter = hypo.name ?? hypo.reduceName ?? '不明';
    const magnitude  = hypo.magnitude != null ? `M${hypo.magnitude}` : '';
    const depth      = hypo.depth      != null ? `深さ${hypo.depth}km` : '';
    const areaNames  = [...new Set(targetAreas.map(a => a.pref || a.name).filter(Boolean))].slice(0, 5);

    const maxScaleLabel = scaleLabel(maxScale);
    const alertText = [
      '緊急地震速報です。',
      hypocenter ? `${hypocenter}を震源とする地震が発生しました。` : '',
      magnitude  ? `${magnitude}${depth ? '、' + depth : ''}。` : '',
      `最大震度${maxScaleLabel}が予想されます。`,
      '強い揺れに備えてください。',
    ].join('');

    getLogger().info(`[EEW] ⚠️ 警報発令: ${hypocenter} ${magnitude} 最大震度${maxScaleLabel} 対象:${areaNames.join('/')}`);

    broadcast({
      event:         'EARTHQUAKE_ALERT',
      hypocenter,
      magnitude,
      depth,
      maxScale,
      maxScaleLabel,
      areaNames,
      alertText,
      issuedAt:      data.issue?.time ?? new Date().toISOString(),
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { ws.terminate(); ws = null; }
      getLogger().info('[EEW] モニター停止');
    },
    // 試験用に、ダミーの速報を流す（overrides で震源・震度などを変えられる）
    testFire(overrides = {}) {
      handleMessage({
        code: 556,
        cancelled: false,
        id: `test-${Date.now()}`,
        earthquake: {
          hypocenter: {
            name: overrides.hypocenter ?? '東京都南部',
            magnitude: overrides.magnitude ?? 5.2,
            depth:     overrides.depth     ?? 10,
          },
        },
        areas: [{
          pref:      overrides.pref       ?? '東京都',
          name:      overrides.areaName   ?? '東京23区',
          kindCode:  '10',
          scaleFrom: overrides.scaleFrom  ?? 50,
          scaleTo:   overrides.scaleTo    ?? 55,
        }],
        issue: { time: new Date().toISOString() },
      });
    },
  };
}

module.exports = { startEarthquakeMonitor };
