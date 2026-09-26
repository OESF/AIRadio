/**
 * @file 天気図（気象庁）と気象衛星の画像を取ってきて返す API（/api/weather-chart・/api/satellite-image）
 *
 * 外部の画像を取得してキャッシュするだけで、番組の状態には依存しない。取得の関数は、秘書のキャンバスや
 * デイリーノート、Live の天気コーナーからも使う。
 *
 * 主な利用元: server.js（ルートの登録）・agent-system.js・lib/secretary-tools.js・lib/secretary-tools-reports.js
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

/** 天気図のキャッシュ（3時間有効）。 @type {{buf: Buffer, fetchedAt: number, label: string}|null} */
let _weatherChartCache   = null;
/**
 * 衛星画像のキャッシュ（時刻 → 画像）。同じ時刻の画像は変わらないので、時間での期限は設けず、
 * 代わりに新しい方から一定の枚数だけ残す（_pruneSatSnapCache）。
 * @type {Record<string, {buf: Buffer, label: string}>}
 */
const _satSnapCache = {};
/**
 * キャッシュに残す枚数。
 *
 * ATTENTION: 実際に要るのは今の時刻と、その1つ前（取得に失敗したときの代わり）だけ。少し余裕を
 * 持たせてあるが、これを外したり大きくしたりすると、24時間動かし続ける運用でメモリが増え続ける。
 */
const SAT_SNAP_CACHE_MAX = 4;

/**
 * 衛星画像のキャッシュを、新しい順に SAT_SNAP_CACHE_MAX 枚だけ残す。
 *
 * BUGFIX: 古い時刻のものを消さずに溜めていくと、1時間に1枚ずつメモリが増え続ける。
 * キーは wn-YYYY-MM-DD-HH-00 の形なので、文字列の並び順がそのまま時刻の順になる。
 *
 * @returns {void}
 */
function _pruneSatSnapCache() {
  const keys = Object.keys(_satSnapCache).sort();
  for (const key of keys.slice(0, -SAT_SNAP_CACHE_MAX)) delete _satSnapCache[key];
}

/**
 * その時刻の衛星画像の URL と表示用のラベルを作る。
 * @param {Date} jstDate 日本時間にずらした日時（getUTC* で日本時間の値が取れるもの）
 * @returns {{url: string, label: string, key: string}}
 */
function _buildWnSatUrl(jstDate) {
  const yyyy = String(jstDate.getUTCFullYear());
  const mo   = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(jstDate.getUTCDate()).padStart(2, '0');
  const hh   = String(jstDate.getUTCHours()).padStart(2, '0');
  const ts   = `${yyyy}-${mo}-${dd}-${hh}-00`;
  return {
    url:   `https://memgvs-cdn.weathernews.jp/s/satellite/cloud/JAPAN/${ts}.webp`,
    label: `${mo}/${dd} ${hh}:00 JST`,
    key:   `wn-${ts}`,
  };
}

/**
 * その時刻の衛星画像を取得する（キャッシュにあればそれを返す）。
 * @param {Date} jstDate 日本時間にずらした日時
 * @returns {Promise<{buf: Buffer, label: string}>}
 * @throws {Error} 取得に失敗したとき
 */
async function _fetchWnSatSnapshot(jstDate) {
  const { url, label, key } = _buildWnSatUrl(jstDate);
  if (_satSnapCache[key]) return _satSnapCache[key];
  const r = await fetch(url);
  if (!r.ok) throw new Error(`WeatherNews HTTP ${r.status}: ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  _satSnapCache[key] = { buf, label };
  _pruneSatSnapCache();
  getLogger().info(`[SatelliteImage] キャッシュ: ${key} (${label}) ${buf.length} bytes`);
  return { buf, label };
}

/**
 * 気象庁の最新の地上天気図（PNG）を取得する（3時間キャッシュする）。
 *
 * @param {{forceRefresh?: boolean}} [opts] forceRefresh はキャッシュを使わず必ず取り直す
 *   （デイリーノートのように「その時点の最新」を確実に載せたいときに使う）
 * @returns {Promise<{buf: Buffer, label: string}>} label は「2026/09/18 09:00 JST」の形
 * @throws {Error} 取得に失敗したとき
 */
async function fetchWeatherChartBuffer({ forceRefresh = false } = {}) {
  const THREE_HOURS = 3 * 60 * 60 * 1000;
  if (!forceRefresh && _weatherChartCache && Date.now() - _weatherChartCache.fetchedAt < THREE_HOURS) {
    return _weatherChartCache;
  }
  const headers = { 'Referer': 'https://www.jma.go.jp/bosai/weather_map/', 'User-Agent': 'Mozilla/5.0' };
  const listRes = await fetch('https://www.jma.go.jp/bosai/weather_map/data/list.json', { headers });
  if (!listRes.ok) throw new Error(`list.json HTTP ${listRes.status}`);
  const list = await listRes.json();
  const nowList = list?.near?.now;
  if (!Array.isArray(nowList) || nowList.length === 0) throw new Error('list.json に天気図ファイルなし');
  const filename = nowList[nowList.length - 1];
  // BUGFIX: ファイル名の時刻（例: …_20260621060000_MET…）は UTC なので、日本時間に直してから表示する
  //         （衛星画像の表示とそろえる。以前は UTC のまま出ていた）
  const m = filename.match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_MET/);
  let label;
  if (m) {
    const utcMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    const jstDate = new Date(utcMs + 9 * 60 * 60 * 1000);
    const mo = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(jstDate.getUTCDate()).padStart(2, '0');
    const hh = String(jstDate.getUTCHours()).padStart(2, '0');
    const mi = String(jstDate.getUTCMinutes()).padStart(2, '0');
    label = `${jstDate.getUTCFullYear()}/${mo}/${dd} ${hh}:${mi} JST`;
  } else {
    label = filename.slice(0, 20);
  }
  const imgRes = await fetch(`https://www.jma.go.jp/bosai/weather_map/data/png/${filename}`, { headers });
  if (!imgRes.ok) throw new Error(`PNG HTTP ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  _weatherChartCache = { buf, fetchedAt: Date.now(), label };
  return _weatherChartCache;
}

/**
 * 最新の気象衛星の画像（ウェザーニュースの配信、webp）を取得する。取れなければ1時間前のものを試す。
 * @returns {Promise<{buf: Buffer, label: string}>}
 * @throws {Error} 1時間前のものも取れなかったとき
 */
async function fetchSatelliteImageBuffer() {
  // 画像は毎時更新される。毎時0〜10分は配信がまだ更新されていないことがあるので、1時間前のものを使う
  const jst = new Date(Date.now() + 9 * 3600000);
  const use = jst.getUTCMinutes() < 10
    ? new Date(jst.getTime() - 3600000)
    : jst;
  try {
    return await _fetchWnSatSnapshot(use);
  } catch (e) {
    getLogger().warn(`[SatelliteImage] ${e.message} → 前時刻にフォールバック`);
    return await _fetchWnSatSnapshot(new Date(use.getTime() - 3600000));
  }
}

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 */
function registerWeatherSatelliteRoutes(app) {
  app.get('/api/weather-chart', async (req, res) => {
    try {
      const { buf, label } = await fetchWeatherChartBuffer();
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=3600');
      res.set('X-Chart-Label', label);
      res.send(buf);
    } catch (e) {
      getLogger().warn(`[WeatherChart] 取得失敗: ${e.message}`);
      res.status(503).json({ error: '天気図取得失敗', detail: e.message });
    }
  });

  app.get('/api/satellite-image', async (req, res) => {
    try {
      const { buf, label } = await fetchSatelliteImageBuffer();
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=1800');
      res.set('X-Satellite-Time', label);
      res.send(buf);
    } catch (e) {
      getLogger().warn(`[SatelliteImage] 取得失敗: ${e.message}`);
      res.status(503).json({ error: '衛星画像取得失敗', detail: e.message });
    }
  });
}

module.exports = { registerWeatherSatelliteRoutes, fetchWeatherChartBuffer, fetchSatelliteImageBuffer };
