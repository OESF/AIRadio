/**
 * @file 天気と防災情報（気象庁・OpenWeatherMap）の取得
 *
 * OpenWeatherMap（現在の天気・3時間ごとの予報）と気象庁（公式予報・台風・警報・地震・津波・
 * 週間予報）から情報を集め、放送とノートで共通に使う1本の文面と、判定用の生の値を組み立てる。
 *
 * 利用元は Live チャンネルの気象コーナー（server/agent-system.js）、秘書の自律監視
 * （server/lib/secretary-loop.js）、Obsidian のデイリー／ウィークリーノート。保存はせず、
 * 結果は this.cache に20分だけ持つ（cache.structured を呼び出し側が直接読む）。
 *
 * ATTENTION: 文面の組み立ては必ずこのサービスの中で行うこと。放送もノートも同じ関数を呼ぶ
 * ことで、同じ数字・同じ言い回しになる。呼び出し側で作り直すと話が食い違う。
 *
 * ATTENTION: 危険の判定は「存在するか」ではなく「影響があるか」で行う。都道府県単位の見出しや
 * 「日本のどこかで起きた地震」をそのまま緊急として扱うと、ほぼ常に緊急になり、本当の緊急時に
 * 聞き流されてしまう。距離・地域コード・震度・警報レベルで機械的に絞り込んでいる。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */
'use strict';

const { getLogger } = require('../logger');

/**
 * 気象庁の API を叩く（8秒で打ち切る）。
 * ATTENTION: Referer と User-Agent を付けないと弾かれる。気象庁のどの API でも同じなので、
 * 直接 fetch せず必ずこれを通すこと。
 *
 * @param {string} url 取得先
 * @returns {Promise<any>} fetch の応答
 */
function _jmaFetch(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  return fetch(url, {
    signal: ac.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer':    'https://www.jma.go.jp/bosai/typhoon/',
    },
  }).finally(() => clearTimeout(timer));
}

/**
 * 住所から緯度経度を引くときに試す検索語を、絞り込みの強い順に並べて返す。
 *
 * BUGFIX: OpenWeatherMap の住所検索は「東京都◯◯市」のような都道府県込みの表記を解決できず
 * 0件を返す。以前はその場合に黙って都心の座標へ代用していたため、設定とはまったく別の場所の
 * 天気を配信し続けていた。都道府県名・市区町村の接尾辞を順に落とした候補を試し、それでも
 * 駄目なときだけ代用する（代用したことは必ず警告に残す。黙って入れ替わったことが、この不具合に
 * 長く気づけなかった原因）。
 *
 * @param {string} location 設定された住所
 * @returns {string[]} 試す順に並べた検索語
 */
function _geocodeCandidates(location) {
  const cands = [location];
  // 都道府県名を落とす。京都府・大阪府・北海道を誤って削らないよう明示的に並べる
  const noPref = location.replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, '');
  if (noPref && noPref !== location) cands.push(noPref);
  // 市区町村の接尾辞も落とす（先方が接尾辞なしで持っている場合がある）
  const bare = (noPref || location).replace(/[市区町村]$/, '');
  if (bare && !cands.includes(bare)) cands.push(bare);
  return cands;
}

/**
 * 気象庁の3桁の天気コードから、先頭桁だけを見て大まかな分類を返す。
 * ATTENTION: 詳細な言い回しの変換表は意図的に持たない（理由は fetchWeeklyForecast 参照）。
 *
 * @param {string} code 3桁の天気コード
 * @returns {string} 晴れ / くもり / 雨 / 雪。判別できなければ空文字
 */
function _weatherCodeCategory(code) {
  const n = parseInt(code, 10);
  if (isNaN(n)) return '';
  if (n < 200) return '晴れ';
  if (n < 300) return 'くもり';
  if (n < 400) return '雨';
  return '雪';
}

// ─── 「影響があるか」を機械的に判定するための道具 ────────────────────────
//
// BUGFIX: かつては「あるかないか」だけで判定していた。都道府県の見出しをそのまま使うため
// 300km離れた島の注意報でも警報あり、太平洋のどこかに熱帯低気圧があれば台風あり、日本の
// どこかで M4 以上なら地震あり、という状態で、ほぼ常に「緊急」になっていた。
// 距離・地域コード・震度で絞り込むこと。

/**
 * 2地点間の距離を求める。
 *
 * @param {number} lat1 1点目の緯度
 * @param {number} lon1 1点目の経度
 * @param {number} lat2 2点目の緯度
 * @param {number} lon2 2点目の経度
 * @returns {number} 距離（km・四捨五入）
 */
function _distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * 1点目から見た2点目の方位角を求める。台風がどちらへ進んでいるかを言葉にするのに使う。
 *
 * @param {number} lat1 起点の緯度
 * @param {number} lon1 起点の経度
 * @param {number} lat2 目標の緯度
 * @param {number} lon2 目標の経度
 * @returns {number} 方位角（度・真北が0）
 */
function _bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
    - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const _COMPASS_16 = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
/**
 * 方位角を16方位の言葉に直す。
 *
 * @param {number} deg 方位角（度）
 * @returns {string} 「北北東」などの方位名
 */
function _compass16(deg) { return _COMPASS_16[Math.round(deg / 22.5) % 16]; }

// 日本列島をおおよそ覆う代表地点。
// ATTENTION: 台風の緊急度は「居住地からの直線距離」で決めてはいけない。台風は進路で意味が
// 変わり、2,000km東にあっても西へ進んでいれば数日後に来るし、500kmでも東進中なら無関係。
// この地点列を使い、現在位置と72時間先までの予報位置それぞれについて、最も近い地点までの
// 距離を測る。予報円の半径を差し引くことで「予報円の縁が日本に掛かるか」という
// 気象庁の見方に近い、安全側の判定になる。
const _JAPAN_REF_POINTS = [
  { name: '先島諸島', lat: 24.34, lon: 124.16 },
  { name: '沖縄',     lat: 26.21, lon: 127.68 },
  { name: '奄美',     lat: 28.38, lon: 129.49 },
  { name: '九州南部', lat: 31.60, lon: 130.56 },
  { name: '九州北部', lat: 33.59, lon: 130.40 },
  { name: '四国',     lat: 33.56, lon: 133.53 },
  { name: '近畿',     lat: 34.69, lon: 135.50 },
  { name: '東海',     lat: 35.18, lon: 136.91 },
  { name: '関東',     lat: 35.69, lon: 139.69 },
  { name: '小笠原',   lat: 27.09, lon: 142.19 },
  { name: '北陸',     lat: 37.90, lon: 139.02 },
  { name: '東北',     lat: 38.27, lon: 140.87 },
  { name: '北海道',   lat: 43.06, lon: 141.35 },
  { name: '北海道東部', lat: 42.98, lon: 144.38 },
];

/**
 * 指定した座標から最も近い日本の代表地点を求める。
 *
 * @param {number} lat 緯度
 * @param {number} lon 経度
 * @returns {any} 地点名と距離（km）。{ name, km }
 */
function _nearestJapanPoint(lat, lon) {
  let best = null;
  for (const p of _JAPAN_REF_POINTS) {
    const km = _distanceKm(lat, lon, p.lat, p.lon);
    if (!best || km < best.km) best = { name: p.name, km };
  }
  return best;
}

// 気象庁の警報コードから警戒レベルを引く表。名称改定で「警報」が「危険警報」になり、
// レベル番号付きの表記になった体系に合わせてある。ここに無いコードは注意報（20）として扱う。
// ATTENTION: 要素をまたいでコードが重複する箇所はあるが、重複しているものは必ず同じレベル
// なので、この平たい表で曖昧さは出ない。
const _WARNING_LEVEL_BY_CODE = (() => {
  const m = {};
  for (const c of ['32', '33', '35', '36', '37', '38', '39', '51', '53']) m[c] = 50; // 特別警報
  for (const c of ['40', '41', '43', '48', '49']) m[c] = 40;                          // レベル4 危険警報
  for (const c of ['02', '03', '05', '06', '07', '08', '09', '30', '31']) m[c] = 30;  // レベル3 警報
  return m;
})();

// 特別警報のコードから、放送で読み上げる短い現象名を引く表
const _SPECIAL_WARNING_ELEM = {
  '32': '暴風雪', '33': '大雨', '35': '暴風', '36': '大雪', '37': '波浪',
  '38': '高潮', '39': '土砂災害', '51': '氾濫', '53': '氾濫',
};

const _WARNING_LEVEL_LABEL = { 50: '特別警報', 40: '危険警報', 30: '警報', 20: '注意報' };

/**
 * いま出ている警報かどうかを判定する。解除済みや「発表なし」を除く。
 *
 * @param {any} kind 電文の kinds 要素
 * @returns {boolean} 発表中なら true
 */
function _isActiveKind(kind) {
  return kind && kind.code && (kind.status === '発表' || kind.status === '継続');
}

/**
 * 警報の電文（種別ごとの最新報の配列）から、指定した地域に掛かっている警報を拾う。
 * ATTENTION: 警報はどの粒度の地域区分で出るか分からないため、3種類すべてを見ること。
 *
 * @param {any} bulletins 警報の電文の配列
 * @param {any} areaCodes 対象の地域コードの配列
 * @returns {any} 最大レベルと、見つかった警報の一覧。{ maxLevel, found }
 */
function _collectWarningsForAreas(bulletins, areaCodes) {
  const codeSet = new Set((areaCodes || []).map(String));
  let maxLevel = 0;
  const found = [];
  for (const b of (Array.isArray(bulletins) ? bulletins : [])) {
    const w = b?.warning || {};
    for (const key of ['class10Items', 'class15Items', 'class20Items']) {
      for (const item of (w[key] || [])) {
        if (!codeSet.has(String(item.areaCode))) continue;
        for (const kind of (item.kinds || [])) {
          if (!_isActiveKind(kind)) continue;
          const level = _WARNING_LEVEL_BY_CODE[kind.code] || 20;
          if (level > maxLevel) maxLevel = level;
          found.push({ areaCode: item.areaCode, code: kind.code, level });
        }
      }
    }
  }
  return { maxLevel, found };
}

/**
 * 地震1件の詳細電文から、津波の危険があるかを読み取る。
 *
 * 地震の一覧には津波の情報が一切含まれず、各地震の詳細電文の注意文にだけ入っている。
 * 平常時は「この地震による津波の心配はありません。」の一文で、危険があるときだけ
 * 「大津波警報」「津波警報」「津波注意報」の語が現れる（1件あたり2KB程度と軽い）。
 *
 * ATTENTION: 危険を表す語が「ある」ことで判定すること。「心配はありません」が無いことで
 * 判定すると、想定外の文面が来たときに津波ありへ倒れて誤報になる。
 *
 * @param {any} fetchFn 気象庁 API を叩く関数
 * @param {string} jsonName 詳細電文のファイル名
 * @returns {Promise<any>} 津波の段階と元の文面。{ level, text }
 */
async function _fetchQuakeTsunami(fetchFn, jsonName) {
  if (!jsonName) return { level: null, text: null };
  try {
    const res = await fetchFn(`https://www.jma.go.jp/bosai/quake/data/${jsonName}`);
    if (!res.ok) return { level: null, text: null };
    const d = await res.json();
    const text = String(d?.Body?.Comments?.ForecastComment?.Text || '').trim();
    if (!text) return { level: null, text: null };
    const level = text.includes('大津波警報') ? 'major'
      : text.includes('津波警報') ? 'warning'
      : text.includes('津波注意報') ? 'advisory' : null;
    return { level, text };
  } catch (e) {
    return { level: null, text: null };
  }
}

/**
 * いま発表中の津波情報の一覧を見て、最も重い種別を返す。
 *
 * ATTENTION: 地震の電文だけでは足りないため、この経路も必ず見ること。遠くの海外で起きた
 * 大地震による津波は、地震の電文ではなく独立した津波の電文で発表されるので、地震側だけを
 * 見ていると取りこぼす。津波が無いときは空の配列（2バイト）が返るので平常時の負担は無い。
 *
 * 判定は電文の文字列に種別名が現れるかで行う。項目名に依存しないため、構造が変わっても
 * 壊れにくい。「若干の海面変動」しか無い場合は何も返さない（危険が無いときに避難を
 * 呼びかけることになるため）。
 *
 * @param {any} fetchFn 気象庁 API を叩く関数
 * @returns {Promise<any>} 最も重い段階と件数。{ level, count }
 */
async function _fetchActiveTsunamiLevel(fetchFn) {
  try {
    const res = await fetchFn('https://www.jma.go.jp/bosai/tsunami/data/list.json');
    if (!res.ok) return { level: null, count: 0 };
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return { level: null, count: 0 };
    const blob = JSON.stringify(list);
    const level = blob.includes('大津波警報') ? 'major'
      : blob.includes('津波警報') ? 'warning'
      : blob.includes('津波注意報') ? 'advisory' : null;
    return { level, count: list.length };
  } catch (e) {
    return { level: null, count: 0 };
  }
}

const _TSUNAMI_LABEL = { major: '大津波警報', warning: '津波警報', advisory: '津波注意報' };
// 津波の深刻さの順位（なし < 注意報 < 警報 < 大津波警報）
const _TSUNAMI_RANK = { null: 0, advisory: 1, warning: 2, major: 3 };

/**
 * 震度の表記（弱・強を含む）から数値を取り出す。
 *
 * @param {any} maxi 震度の文字列
 * @returns {number} 震度の数値。取れなければ 0
 */
function _intensityValue(maxi) {
  const n = parseInt(String(maxi || '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * マグニチュードを数値にする。「不明」が入ることがあるため、数にできなければ 0 を返す。
 *
 * @param {any} mag マグニチュードの文字列
 * @returns {number} マグニチュード。取れなければ 0
 */
function _magnitudeValue(mag) {
  const n = parseFloat(mag);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 電文に出てくる地域コードをすべて集める。居住地を特定できなかったときに、安全側へ倒して
 「県内のどこかに出ていれば影響あり」とみなすために使う。
 *
 * @param {any} bulletins 警報の電文の配列
 * @returns {any[]} 地域コードの配列
 */
function _allAreaCodesIn(bulletins) {
  const out = [];
  for (const b of (Array.isArray(bulletins) ? bulletins : [])) {
    const w = b?.warning || {};
    for (const key of ['class10Items', 'class15Items', 'class20Items']) {
      for (const item of (w[key] || [])) out.push(item.areaCode);
    }
  }
  return out;
}

// 気象庁の地域コード表。市区町村名から地域コードとその親をたどるために使う。
// 内容が変わることは滅多に無いため、起動後に一度だけ取って使い回す。
let _areaTablePromise = null;

/**
 * 地域コード表を読み込む（2回目以降は取得済みのものを返す）。
 *
 * @param {any} fetchFn 気象庁 API を叩く関数
 * @returns {Promise<any>} 地域コード表。取得できなければ null
 */
function _loadAreaTable(fetchFn) {
  if (!_areaTablePromise) {
    _areaTablePromise = fetchFn('https://www.jma.go.jp/bosai/common/const/area.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _areaTablePromise;
}

/**
 * 居住地の市区町村名から、気象庁の地域コードを自分から親へたどって並べる。
 * 警報がこのいずれかの地域に出ていれば「影響がある」と判定する。
 *
 * @param {any} fetchFn 気象庁 API を叩く関数
 * @param {string} location 設定された住所
 * @returns {Promise<any[]>} 地域コードの配列。特定できなければ空の配列
 */
async function _resolveListenerAreaCodes(fetchFn, location) {
  const table = await _loadAreaTable(fetchFn);
  if (!table?.class20s) return [];
  // 住所の文字列に含まれる市区町村名を拾う（一致するもののうち最も長いものを選ぶ）
  let best = null;
  for (const [code, v] of Object.entries(table.class20s)) {
    const name = String(v.name || '');
    if (name && location.includes(name) && (!best || name.length > best.name.length)) {
      best = { code, name, parent: v.parent };
    }
  }
  if (!best) return [];
  const codes = [best.code];
  let parent = best.parent;
  for (let i = 0; i < 3 && parent; i++) {
    codes.push(parent);
    parent = table.class15s?.[parent]?.parent || table.class10s?.[parent]?.parent || null;
  }
  return codes;
}

/**
 * 10秒で打ち切る fetch。住所検索と OpenWeatherMap の取得で使う。
 *
 * @param {string} url 取得先
 * @param {any} [opts] fetch へ渡す追加の設定
 * @returns {Promise<any>} fetch の応答
 */
function _fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

/**
 * 住所から緯度経度を求める。どの表記でも見つからなければ都心の座標で代用する。
 *
 * @param {string} location 設定された住所
 * @param {string} apiKey OpenWeatherMap の API キー
 * @returns {Promise<any>} 緯度と経度。{ lat, lon }
 */
async function _geocodeLocation(location, apiKey) {
  // 表記を段階的に緩めながら試す（_geocodeCandidates 参照）
  let lat = null, lon = null, geocodedBy = null;
  for (const q of _geocodeCandidates(location)) {
    try {
      const geoRes = await _fetchWithTimeout(
        `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(q)},JP&limit=1&appid=${apiKey}`
      );
      const geoData = await geoRes.json();
      if (Array.isArray(geoData) && geoData.length > 0) {
        ({ lat, lon } = geoData[0]);
        geocodedBy = q;
        break;
      }
    } catch (e) {
      getLogger().warn(`[Weather] ジオコーディング失敗（${q}）: ${e.message}`);
    }
  }
  if (lat == null) {
    // ATTENTION: 代用したことは必ず警告に残すこと。ここが黙っていたため、設定と実際の
    // 取得先がずれたまま長く気づけなかった。
    lat = 35.6895; lon = 139.6917;
    getLogger().warn(`[Weather] 「${location}」の座標を特定できず、東京駅の座標で代用します`
      + `（設定した場所の天気ではありません。config.show.user_profile.locationの表記を見直してください）`);
  } else if (geocodedBy !== location) {
    getLogger().info(`[Weather] 「${location}」→「${geocodedBy}」として座標を特定: ${lat}, ${lon}`);
  }
  return { lat, lon };
}

/**
 * OpenWeatherMap から現在の天気と3時間ごとの予報を取り、放送用の文面と生の値を組み立てる。
 *
 * @param {string} location 表示に使う地名
 * @param {number} lat 緯度
 * @param {number} lon 経度
 * @param {string} apiKey OpenWeatherMap の API キー
 * @returns {Promise<any>} 文面（regularWeather）と、判定に使う生の値一式
 */
async function _fetchCurrentAndForecast(location, lat, lon, apiKey) {
  const [wRes, fcRes] = await Promise.all([
    _fetchWithTimeout(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=ja`),
    _fetchWithTimeout(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=ja&cnt=16`),
  ]);
  const w  = await wRes.json();
  const fc = await fcRes.json();

  // ── 現在の天気 ──
  const temp     = Math.round(w.main.temp);
  const humidity = w.main.humidity;
  const desc     = w.weather[0].description;
  const wind     = w.wind.speed;

  // ATTENTION: 時刻は日本時間で固定して扱う。サーバーの時間帯の設定に左右されないよう、
  // 9時間の差を明示的に足して計算する。
  const JST_OFFSET = 9 * 60 * 60 * 1000;
  const toJST = (unixSec) => new Date(unixSec * 1000 + JST_OFFSET);
  const nowJST = new Date(Date.now() + JST_OFFSET);
  const jstDateStr = (jstDate) => jstDate.toISOString().slice(0, 10);
  const jstHour = (jstDate) => jstDate.getUTCHours();

  const todayStr    = jstDateStr(nowJST);
  const tomorrowJST = new Date(nowJST.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = jstDateStr(tomorrowJST);

  // 予報を今日・明日に振り分ける
  const todaySlots    = [];
  const tomorrowSlots = [];
  const todayRawSlots    = [];
  const tomorrowRawSlots = [];
  const todayAllTemps = [temp]; // 現在の気温も含めて今日の最高・最低を出す

  if (fc && fc.list && fc.list.length > 0) {
    for (const item of fc.list) {
      const dtJST  = toJST(item.dt);
      const dateStr = jstDateStr(dtJST);
      const hour   = jstHour(dtJST);
      const hourStr = `${String(hour).padStart(2,'0')}時`;
      const t      = Math.round(item.main.temp);
      const d      = item.weather[0].description;
      const pop    = item.pop != null ? Math.round(item.pop * 100) : 0;
      const entry  = `  ${hourStr}: ${d} ${t}℃ 降水確率${pop}%`;
      // 文章だけでなく生の値も残す。「朝は降水確率が高いので傘を」といった助言を、
      // モデルの気づきに頼らずコード側で組み立てるため。
      const raw = { hour, desc: d, temp: t, pop, humidity: item.main?.humidity ?? null };

      if (dateStr === todayStr) {
        todayAllTemps.push(t);
        const dtMs = item.dt * 1000 + JST_OFFSET;
        if (dtMs > nowJST.getTime()) {
          todaySlots.push(entry); // 文面に出すのは今より先の時間帯だけ
          todayRawSlots.push(raw);
        }
      } else if (dateStr === tomorrowStr) {
        tomorrowSlots.push(entry);
        tomorrowRawSlots.push(raw);
      }
    }
  }

  // ATTENTION: 今日の最高・最低は予報の各時間帯から出す。現在の天気に付いてくる最高・最低は
  // 使わない（観測地点や集計の取り方が違い、予報と食い違う）。
  const todayMax = Math.max(...todayAllTemps);
  const todayMin = Math.min(...todayAllTemps);

  // 通常の天気の文面（後で緊急度の高い情報の後ろに置かれる）
  let regularWeather = `${location}の現在のお天気: ${desc} / 気温 ${temp}℃（本日最高 ${todayMax}℃・本日最低 ${todayMin}℃）/ 湿度 ${humidity}% / 風速 ${wind}m/s`;

  if (todaySlots.length > 0) {
    regularWeather += `\n\n【今日の残り時間帯の予報（JST・3時間ごとの参考値／OpenWeatherMap）】\n` + todaySlots.join('\n');
  }
  let tomorrowInfo = null;
  if (tomorrowSlots.length > 0) {
    const tomorrowTemps = fc.list
      .filter(item => jstDateStr(toJST(item.dt)) === tomorrowStr)
      .map(item => Math.round(item.main.temp));
    const tMax = Math.max(...tomorrowTemps);
    const tMin = Math.min(...tomorrowTemps);
    const tm = tomorrowJST.getUTCMonth() + 1;
    const td = tomorrowJST.getUTCDate();
    tomorrowInfo = { max: tMax, min: tMin, month: tm, day: td };
    regularWeather += `\n\n【明日（${tm}月${td}日）の3時間ごとの推移（参考値／OpenWeatherMap。`
      + `最高・最低は上の気象庁の公式予報を優先してください）】\n  最高 ${tMax}℃・最低 ${tMin}℃\n` + tomorrowSlots.join('\n');
  }
  return {
    regularWeather, temp, desc, humidity, wind, todayMax, todayMin,
    tomorrowInfo, todayRawSlots, tomorrowRawSlots,
  };
}

/**
 * 気象庁の公式予報（今日・明日）の文面を組み立てる。
 *
 * ATTENTION: 「今日・明日はどうなるか」の基準は必ず気象庁を先に置くこと。日本の予報は
 * 気象庁が本家で、OpenWeatherMap とは実際に食い違う。3時間ごとの細かい推移は
 * OpenWeatherMap の方が細かいので、そちらは後ろに残す。
 *
 * @param {any} officialRes fetchOfficialDailyForecast の結果（Promise.allSettled 済み）
 * @returns {string} 組み立てた文面。取れなければ空文字
 */
function _buildOfficialForecastSection(officialRes) {
  let officialSection = '';
  if (officialRes.status === 'fulfilled' && officialRes.value) {
    const o = officialRes.value;
    const hhmm = (o.reportDatetime || '').slice(11, 16);
    const lines = [`【気象庁の公式予報（${o.areaName}・${hhmm}発表）※これが基準です】`];
    if (o.today.weather) {
      lines.push(`  本日: ${o.today.weather}`
        + (o.today.max != null ? ` / 最高 ${o.today.max}℃（${o.tempPointName}）` : ''));
    }
    if (o.tomorrow.weather) {
      const t = [];
      if (o.tomorrow.max != null) t.push(`最高 ${o.tomorrow.max}℃`);
      if (o.tomorrow.min != null) t.push(`最低 ${o.tomorrow.min}℃`);
      lines.push(`  明日: ${o.tomorrow.weather}`
        + (t.length ? ` / ${t.join('・')}（${o.tempPointName}）` : ''));
      if (o.tomorrow.pops) lines.push(`  明日の降水確率: ${o.tomorrow.pops}`);
    }
    if (lines.length > 1) officialSection = lines.join('\n');
  }
  return officialSection;
}

/**
 * 地震の情報の文面を組み立てる（津波の有無は詳細電文を引いて判定する）。
 *
 * BUGFIX: 気象庁は1つの地震に対し、速報から確定まで3段階の電文を、同じ地震IDを持つ別々の
 * 記録として順に出す（段階ごとに埋まっている項目が違う）。まとめずに行へ変換すると、
 * 同じ地震が最大3行に分かれて見える。必ず地震IDでまとめ、各項目の最初に埋まった値へ
 * 合わせてから1件として扱うこと。
 *
 * @param {any} quakeRes 地震の一覧の取得結果（Promise.allSettled 済み）
 * @param {any} jmaFetch 気象庁 API を叩く関数
 * @returns {Promise<any>} 文面・最大震度・津波の段階。{ quakeSection, quakeMaxIntensity, quakeTsunamiLevel }
 */
async function _buildQuakeSection(quakeRes, jmaFetch) {
  let quakeSection = '';
  let quakeMaxIntensity = 0;
  // 津波警報・注意報の最も重い段階（震度が低くても緊急として扱うための材料）
  let quakeTsunamiLevel = null;

  try {
    if (quakeRes.status === 'fulfilled' && quakeRes.value.ok) {
      const qj = await quakeRes.value.json();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const byEid = new Map();
      for (const q of (Array.isArray(qj) ? qj : [])) {
        const t = new Date(q.at).getTime();
        if (!(t > cutoff)) continue;
        const eid = q.eid || q.at;
        const existing = byEid.get(eid);
        if (!existing) {
          byEid.set(eid, { ...q });
        } else {
          if (!existing.mag && q.mag) existing.mag = q.mag;
          if (!existing.maxi && q.maxi) existing.maxi = q.maxi;
          if (!existing.anm && q.anm) existing.anm = q.anm;
          if (!existing.en_anm && q.en_anm) existing.en_anm = q.en_anm;
        }
      }
      // ATTENTION: 載せる地震の足切りは震度を中心にすること。次のいずれかを満たすものだけを
      // 採る。①最大震度3以上（人が揺れを感じる規模）②津波の警報・注意報が出ている
      // （震度に関わらず必ず採る）③M6.0以上（震度が低くても大きな地震は伝える価値がある）。
      // マグニチュードだけで足切りしていた頃は、震度1の地震が毎回載っていた。
      const all = Array.from(byEid.values());

      // 津波の有無は詳細電文にしか無いので、可能性のあるものだけ取りに行く。この絞り込みで
      // 平常時は0〜2件で済む。津波を伴う地震はM6級以上なので、M5.0 には十分な余裕がある。
      const needsTsunamiCheck = all.filter((q) =>
        _intensityValue(q.maxi) >= 3 || _magnitudeValue(q.mag) >= 5.0)
        .sort((a, b) => _magnitudeValue(b.mag) - _magnitudeValue(a.mag))
        .slice(0, 12);
      const tsunamiResults = await Promise.all(
        needsTsunamiCheck.map((q) => _fetchQuakeTsunami(jmaFetch, q.json)));
      const tsunamiByEid = new Map();
      needsTsunamiCheck.forEach((q, i) => tsunamiByEid.set(q.eid, tsunamiResults[i]));

      const recent = all
        .filter(q => {
          const mag = _magnitudeValue(q.mag);
          const int = _intensityValue(q.maxi);
          const ts  = tsunamiByEid.get(q.eid);
          return int >= 3 || (ts && ts.level) || mag >= 6.0;
        })
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, 5);
      if (recent.length > 0) {
        const lines = recent.map(q => {
          const at   = q.at ? new Date(q.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
          // BUGFIX: 震源地は日本語を先に取ること。英語を先にしていたため、日本語の放送に
          // 英語の地名が渡り、エージェントに訳させることになっていた。
          const hypo = q.anm || q.en_anm || '震源不明';
          const mag  = q.mag ? `M${q.mag}` : '';
          const maxi = q.maxi ? ` 最大震度${q.maxi}` : ' 最大震度不明';
          const iv = _intensityValue(q.maxi);
          if (iv > quakeMaxIntensity) quakeMaxIntensity = iv;
          const ts = tsunamiByEid.get(q.eid);
          let tsStr = '';
          if (ts && ts.level) {
            tsStr = ` ⚠️【${_TSUNAMI_LABEL[ts.level]}】${ts.text}`;
            if (_TSUNAMI_RANK[ts.level] > _TSUNAMI_RANK[quakeTsunamiLevel]) quakeTsunamiLevel = ts.level;
          } else if (ts && ts.text) {
            // ATTENTION: 「津波の心配はありません」も気象庁の文面のまま渡すこと。放送側に
            // それを明言する指示があるため、根拠を渡さないと推測で言うことになる。
            tsStr = `（${ts.text}）`;
          }
          return `${at} ${hypo} ${mag}${maxi}${tsStr}`;
        });
        // BUGFIX: 見出しに「全国」と明記すること。対象が日本全国であることが書かれて
        // いなかったため、居住地で起きたかのように伝えてしまう事故があった。
        quakeSection = '【🔴 地震情報（全国・直近24時間・最大震度3以上／津波あり／M6.0以上）】\n' + lines.join('\n');
        getLogger().info(`[Weather] 地震情報: ${recent.length}件`
          + `（全${all.length}件中・最大震度${quakeMaxIntensity}`
          + `${quakeTsunamiLevel ? `・${_TSUNAMI_LABEL[quakeTsunamiLevel]}発表中` : ''}）`);
      }
    }
  } catch (e) { getLogger().debug('[Weather] 地震情報取得失敗: ' + e.message); }
  return { quakeSection, quakeMaxIntensity, quakeTsunamiLevel };
}

/**
 * 地震の電文とは別の経路で取った津波の情報を、地震の文面へ足す。
 * 遠くで起きた地震による津波は地震の電文に載らないため、こちらで拾う。両方で見つかった
 * ときは重い方を採る。
 *
 * @param {any} tsunamiRes _fetchActiveTsunamiLevel の結果（Promise.allSettled 済み）
 * @param {string} quakeSection 地震の文面
 * @param {any} quakeTsunamiLevel 地震側で分かっている津波の段階
 * @returns {any} 足し込んだ文面と段階。{ quakeSection, quakeTsunamiLevel }
 */
function _applyStandaloneTsunami(tsunamiRes, quakeSection, quakeTsunamiLevel) {
  if (tsunamiRes.status === 'fulfilled' && tsunamiRes.value.level) {
    const lv = tsunamiRes.value.level;
    if (_TSUNAMI_RANK[lv] > _TSUNAMI_RANK[quakeTsunamiLevel]) quakeTsunamiLevel = lv;
    const line = `【🌊 ${_TSUNAMI_LABEL[lv]}が発表されています】\n`
      + `気象庁が津波に関する情報を${tsunamiRes.value.count}件発表中です。`
      + '対象地域と到達予想時刻は必ず最新の発表を確認してください。';
    quakeSection = quakeSection ? `${line}\n\n${quakeSection}` : line;
    getLogger().warn(`[Weather] 津波情報: ${_TSUNAMI_LABEL[lv]}発表中（${tsunamiRes.value.count}件）`);
  }
  return { quakeSection, quakeTsunamiLevel };
}

/**
 * 台風の文面と、日本・居住地それぞれへの影響の強さを組み立てる。
 *
 * @param {any} typhoonListRes 発生中の台風の一覧の取得結果（Promise.allSettled 済み）
 * @param {any} jmaFetch 気象庁 API を叩く関数
 * @param {number} lat 居住地の緯度
 * @param {number} lon 居住地の経度
 * @returns {Promise<any>} 文面と各種の距離・影響度
 */
async function _buildTyphoonSection(typhoonListRes, jmaFetch, lat, lon) {
  let typhoonSection  = '';
  let typhoonNearestKm = null;
  // ATTENTION: 台風の緊急度は「日本への最接近距離」で決める。居住地からの距離ではない。
  let typhoonNearestJapanKm = null;
  let typhoonImpact = 'none';
  // 予報された進路が居住地から500km以内まで近づくか（番組の冒頭で緊急として扱う基準）
  let typhoonAffectsListener = false;
  let typhoonListenerClosestKm = null;
  const typhoonImpactRank = { none: 0, watch: 1, near: 2, direct: 3 };

  try {
    if (typhoonListRes.status === 'fulfilled' && typhoonListRes.value.ok) {
      const tcList  = await typhoonListRes.value.json();
      const activeTc = Array.isArray(tcList) ? tcList : [];
      if (activeTc.length > 0) {
        const tcDetails = await Promise.allSettled(
          activeTc.map(tc =>
            jmaFetch(`https://www.jma.go.jp/bosai/typhoon/data/${tc.tropicalCyclone}/forecast.json`)
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        );
        const lines = [];
        for (let i = 0; i < activeTc.length; i++) {
          const tc  = activeTc[i];
          const det = tcDetails[i].status === 'fulfilled' ? tcDetails[i].value : null;
          const entries = Array.isArray(det) ? det : [];
          const titleEntry    = entries.find(e => e.part === 'title');
          const analysisEntry = entries.find(e => e.part?.jp === '実況' || e.part?.en === 'Analysis');
          const nameJp  = titleEntry?.name?.jp || `台風${tc.typhoonNumber}号`;
          const nameEn  = titleEntry?.name?.en || '';
          // ATTENTION: この2行は必ず numStr より前に置くこと。台風番号が無いときの代わりが
          // catStr を参照するため、後ろに置くと宣言前の参照になって例外が出る。囲っている
          // try/catch がそれを握り潰すので、台風の文面が丸ごと消える形でしか表面化しない。
          //
          // 気象庁の区分に合わせる。日本語で「熱帯低気圧」と呼ぶのは発生前・衰弱後の段階
          // だけで、それ以外はすべて「台風」。
          const catMap  = { TY: '強い台風', STS: '台風', TS: '台風', TD: '熱帯低気圧' };
          const catStr  = catMap[tc.category] || tc.category || '台風';
          // 台風番号は西暦の下2桁＋通し番号。放送では通し番号だけで呼ぶ
          const numStr  = tc.typhoonNumber
            ? `台風${Number(String(tc.typhoonNumber).slice(-2))}号` : catStr;
          const center  = analysisEntry?.center;
          const issueTime = titleEntry?.issue?.JST
            ? new Date(titleEntry.issue.JST).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '';
          const issueStr = issueTime ? ` [${issueTime}現在]` : '';

          if (!Array.isArray(center) || center.length < 2) {
            lines.push(`${catStr} ${nameJp}（${nameEn}）${numStr}${issueStr}`);
            continue;
          }
          const [cLat, cLon] = [Number(center[0]), Number(center[1])];

          // ここが判定の中心。「日本にどれだけ近いか」「どちらへ進むか」「今後近づくのか」
          // で組み立てる。
          const nowNear = _nearestJapanPoint(cLat, cLon);
          const dirFromJapan = _compass16(_bearingDeg(
            _JAPAN_REF_POINTS.find(p2 => p2.name === nowNear.name).lat,
            _JAPAN_REF_POINTS.find(p2 => p2.name === nowNear.name).lon, cLat, cLon));

          // 予報された位置。予報円の半径を差し引いて、安全側に測る
          const forecasts = entries
            .filter(e => Number(e.advancedHours) > 0 && Array.isArray(e.center))
            .sort((a, b) => a.advancedHours - b.advancedHours);
          let closest = { km: nowNear.km, hours: 0, name: nowNear.name };
          // ATTENTION: 「日本への影響」と「居住地への影響」は必ず分けて持つこと。日本の
          // 代表地点には離島も含まれるため、日本への影響だけで判定すると、1,000km以上
          // 離れた島の近くを通る台風まで最優先の緊急扱いになってしまう。
          //   ・日本への影響 … 進路として語る価値があるか
          //   ・居住地への影響 … 番組の冒頭で緊急として扱うか
          // 居住地への距離も、現在位置ではなく予報された進路全体で測る。
          let listenerClosest = { km: _distanceKm(lat, lon, cLat, cLon), hours: 0 };
          for (const f of forecasts) {
            const fLat = Number(f.center[0]);
            const fLon = Number(f.center[1]);
            const circleKm = (f.probabilityCircle?.radius || 0) / 1000;
            const near = _nearestJapanPoint(fLat, fLon);
            const km = Math.max(0, Math.round(near.km - circleKm));
            if (km < closest.km) closest = { km, hours: f.advancedHours, name: near.name };
            const lKm = Math.max(0, Math.round(_distanceKm(lat, lon, fLat, fLon) - circleKm));
            if (lKm < listenerClosest.km) listenerClosest = { km: lKm, hours: f.advancedHours };
          }
          const affectsListener = listenerClosest.km <= 500;
          // 進む向きは「現在位置 → 直近の予報位置」。気象庁の予報進路をそのまま使う
          const heading = forecasts.length > 0
            ? _compass16(_bearingDeg(cLat, cLon, Number(forecasts[0].center[0]), Number(forecasts[0].center[1])))
            : null;

          // 影響の段階。いずれも「日本のどこかに掛かるか」を基準にしている。
          //   direct … 300km以内。上陸・直撃のおそれがあり、最優先で詳しく伝える
          //   near   … 800km以内。暴風域や雨雲が掛かりうる。緊急として扱う
          //   watch  … 1,500km以内かつ近づいている。今後の見通しとして触れる
          //   none   … それ以外。「日本への影響はありません」と明言して終える
          const approaching = closest.km < nowNear.km - 100;
          const impact = closest.km <= 300 ? 'direct'
            : closest.km <= 800 ? 'near'
            : (closest.km <= 1500 && approaching) ? 'watch' : 'none';
          if (typhoonImpactRank[impact] > typhoonImpactRank[typhoonImpact]) typhoonImpact = impact;
          if (affectsListener) typhoonAffectsListener = true;
          if (typhoonListenerClosestKm == null || listenerClosest.km < typhoonListenerClosestKm) {
            typhoonListenerClosestKm = listenerClosest.km;
          }
          if (typhoonNearestJapanKm == null || closest.km < typhoonNearestJapanKm) {
            typhoonNearestJapanKm = closest.km;
          }
          // 居住地からの距離は判定には使わないが、迫っている場合の材料として残す
          const kmToListener = _distanceKm(lat, lon, cLat, cLon);
          if (Number.isFinite(kmToListener)
              && (typhoonNearestKm == null || kmToListener < typhoonNearestKm)) {
            typhoonNearestKm = kmToListener;
          }

          const galeKm = analysisEntry?.galeWarningArea?.radius
            ? Math.round(analysisEntry.galeWarningArea.radius / 1000) : null;
          const when = closest.hours === 0 ? '現在' : `${closest.hours}時間後`;
          const impactStr = {
            direct: `⚠️ ${closest.name}へ接近・上陸のおそれ（最接近 約${closest.km.toLocaleString()}km・${when}）`,
            near:   `⚠️ ${closest.name}に影響が出るおそれ（最接近 約${closest.km.toLocaleString()}km・${when}）`,
            watch:  `${closest.name}方面へ今後近づく見込み（最接近 約${closest.km.toLocaleString()}km・${when}）。現時点で影響なし`,
            none:   '72時間先までの予報でも日本へは近づかず、影響はありません',
          }[impact];
          const listenerStr = impact === 'none' ? ''
            : affectsListener
              ? `／お住まいの地域へも接近（最接近 約${listenerClosest.km.toLocaleString()}km・`
                + `${listenerClosest.hours === 0 ? '現在' : `${listenerClosest.hours}時間後`}）`
              : `／お住まいの地域への影響はありません（最も近づいても約${listenerClosest.km.toLocaleString()}km）`;

          // 番号と同じ言葉が並ばないよう、強さの情報を持つときだけ種別を添える
          const catSuffix = (catStr && catStr !== '台風' && !numStr.includes(catStr))
            ? `（${catStr}）` : '';
          lines.push(`${numStr}${catSuffix} ${nameJp}（${nameEn}）`
            + `／現在は${nowNear.name}の${dirFromJapan}約${nowNear.km.toLocaleString()}kmの海上`
            + (heading ? `を${heading}へ進行中` : '')
            + (galeKm ? `／暴風域は半径約${galeKm}km` : '')
            + `／${impactStr}${listenerStr}${issueStr}`);
        }
        typhoonSection = `【🌀 台風情報】\n` + lines.join('\n');
        getLogger().info(`[Weather] 台風情報: ${activeTc.length}件`
          + `（日本への影響: ${typhoonImpact}`
          + `${typhoonNearestJapanKm != null ? `・最接近約${typhoonNearestJapanKm}km` : ''}） — ${lines[0]?.slice(0, 50)}`);
      } else {
        getLogger().debug('[Weather] 台風情報: 現在発生中の台風なし');
      }
    }
  } catch (e) { getLogger().debug('[Weather] 台風情報取得失敗: ' + e.message); }
  return {
    typhoonSection, typhoonNearestKm, typhoonNearestJapanKm,
    typhoonImpact, typhoonAffectsListener, typhoonListenerClosestKm,
  };
}

/**
 * 気象警報・注意報の文面と、居住地に影響があるかを組み立てる。
 *
 * ATTENTION: 取得先は新しい形式の配信（warning/data/r8/）を使うこと。名称改定に伴って
 * 気象庁の配信が移り、古い配信は更新が止まった。気づかないまま古い方を見ていた間は、
 * 3か月前の警報を「現在の警報」として扱い続けていた。
 *
 * @param {any} warningRes 警報の取得結果（Promise.allSettled 済み）
 * @param {any} jmaFetch 気象庁 API を叩く関数
 * @param {string} location 居住地の住所
 * @returns {Promise<any>} 文面・居住地への影響・地域コード・最大レベル
 */
async function _buildWarningSection(warningRes, jmaFetch, location) {
  let warningSection = '';
  // 「出ているか」と「居住地に影響があるか」は分けて持つ
  let warningAffectsListener = false;
  let listenerAreaCodes = [];
  let listenerWarningLevel = 0;

  try {
    if (warningRes.status === 'fulfilled' && warningRes.value.ok) {
      const wj = await warningRes.value.json();
      const bulletins = Array.isArray(wj) ? wj : [wj];

      // ATTENTION: 都道府県の見出しは離島の注意報でも埋まるため、地域コードで居住地に
      // 出ているかを必ず確かめること。これが無いとほぼ常時「警報あり」になる。
      let listenerLevel = 0;
      try {
        const listenerCodes = await _resolveListenerAreaCodes(jmaFetch, location);
        if (listenerCodes.length > 0) {
          listenerAreaCodes = listenerCodes;
          listenerLevel = _collectWarningsForAreas(bulletins, listenerCodes).maxLevel;
        } else {
          // 地域を特定できなければ安全側に倒し、県内のどこかに出ていれば影響ありとみなす
          listenerLevel = _collectWarningsForAreas(
            bulletins, _allAreaCodesIn(bulletins)).maxLevel;
        }
      } catch (e) {
        listenerLevel = _collectWarningsForAreas(bulletins, _allAreaCodesIn(bulletins)).maxLevel;
        getLogger().debug('[Weather] 警報の地域判定に失敗（安全側で影響ありとみなす）: ' + e.message);
      }
      listenerWarningLevel = listenerLevel;
      // ATTENTION: 緊急として扱うのは警報以上。注意報は日常的に出ているもので、これを
      // 緊急にすると本当の警報と区別がつかなくなる。注意報は通常の予報の中で触れれば足りる。
      warningAffectsListener = listenerLevel >= 30;

      const latest = bulletins
        .filter((b) => b?.headlineText)
        .sort((a, b) => String(b.reportDatetime || '').localeCompare(String(a.reportDatetime || '')))[0];
      const headline = (latest?.headlineText || '').trim();
      if (headline && listenerLevel > 0) {
        const label = _WARNING_LEVEL_LABEL[listenerLevel] || '注意報';
        warningSection = `【⚠️ 気象警報・注意報（居住地に出ている最大レベル: ${label}）】\n${headline}`;
      } else if (headline) {
        warningSection = `【⚠️ 気象警報・注意報（※居住地域は対象外）】\n${headline}`;
      }
      if (warningSection) {
        getLogger().info(`[Weather] 警報: 居住地レベル${listenerLevel}`
          + `（${_WARNING_LEVEL_LABEL[listenerLevel] || 'なし'}） — ${headline.slice(0, 40)}`);
      }
    } else if (warningRes.status === 'fulfilled') {
      getLogger().warn(`[Weather] 警報JSONの取得に失敗（HTTP ${warningRes.value.status}）`);
    }
  } catch (e) { getLogger().debug('[Weather] 警報情報取得失敗: ' + e.message); }
  return { warningSection, warningAffectsListener, listenerAreaCodes, listenerWarningLevel };
}

/**
 * 居住地の外（他県）で発表中の特別警報の文面を組み立てる。
 * 居住地に影響が無くても、命に関わる事態は一言伝えるための枠。
 *
 * ATTENTION: 拾うのは特別警報だけにすること。それ以下の段階は全国のどこかに常時出ており、
 * 毎回読み上げると「本当に危ないとき」と区別がつかなくなる。
 *
 * @param {any} nationalRes fetchNationalSpecialWarnings の結果（Promise.allSettled 済み）
 * @returns {any} 文面と、拾った特別警報の一覧。{ nationalAlertSection, nationalAlerts }
 */
function _buildNationalAlertSection(nationalRes) {
  let nationalAlertSection = '';
  let nationalAlerts = [];

  if (nationalRes.status === 'fulfilled' && Array.isArray(nationalRes.value) && nationalRes.value.length > 0) {
    nationalAlerts = nationalRes.value;
    const lines = nationalAlerts.map((a) =>
      `${a.pref}（${a.areas.join('・')}）: ${a.kinds.join('・')}特別警報`
      + `${a.headline ? ` — ${a.headline}` : ''}`);
    nationalAlertSection = '【🆘 全国の特別警報（居住地の外・他県で発表中）】\n' + lines.join('\n');
    getLogger().info(`[Weather] 全国の特別警報: ${nationalAlerts.length}件 — `
      + nationalAlerts.map((a) => `${a.pref}(${a.kinds.join('/')})`).join(', '));
  }
  return { nationalAlertSection, nationalAlerts };
}

/**
 * 天気と防災情報をまとめて取ってくるサービス。
 *
 * ATTENTION: this.cache は放送のコーナーや画面のテロップの組み立てからも直接読まれるため、
 * 形（data / lastFetch / location / structured）を変えないこと。
 */
class WeatherService {
  constructor() {
    this.cache = { data: null, lastFetch: 0 };
    // 全国の特別警報。更新時刻が変わったときだけ本体を取り直す
    this._nationalStamp = null;
    this._nationalAlerts = [];
  }

  /**
   * 溜めてある取得結果を捨てる。
   *
   * @returns {void}
   */
  clear() {
    this.cache = { data: null, lastFetch: 0 };
  }

  /**
   * 全国で発表中の特別警報を取得する。
   *
   * 全国の最新報を集めた一覧は約1MBあるため、まず更新時刻だけの小さなファイルを見て、
   * 前回と同じなら前回の判定結果をそのまま返す。警報が動いていない平常時はほとんど
   * 通信せずに済み、荒天時だけ本体を取りに行く。
   *
   * ATTENTION: 発表の告知だけを流す配信ではなく、この一覧を使うこと。一覧は種別ごとの
   * 最新報なので、解除されれば自動的に対象から外れる。告知の側を使うと解除を追えず、
   * もう終わった特別警報を出し続けることになる。
   *
   * @returns {Promise<any[]>} 都道府県ごとの特別警報の一覧
   */
  async fetchNationalSpecialWarnings() {
    try {
      const timeRes = await _jmaFetch('https://www.jma.go.jp/bosai/warning/data/r8/map_time.json');
      let stamp = null;
      if (timeRes.ok) stamp = (await timeRes.json())?.latestControlDatetime || null;
      if (stamp && stamp === this._nationalStamp) return this._nationalAlerts || [];

      const [mapRes, table] = await Promise.all([
        _jmaFetch('https://www.jma.go.jp/bosai/warning/data/r8/map.json'),
        _loadAreaTable(_jmaFetch),
      ]);
      if (!mapRes.ok) return this._nationalAlerts || [];
      const bulletins = await mapRes.json();

      // 地域コードから都道府県名と地域名を引く
      const resolve = (areaCode) => {
        const c10 = table?.class10s?.[areaCode];
        if (c10) return { pref: table?.offices?.[c10.parent]?.name || null, area: c10.name };
        const c15 = table?.class15s?.[areaCode];
        if (c15) {
          const parent = table?.class10s?.[c15.parent];
          return { pref: table?.offices?.[parent?.parent]?.name || null, area: c15.name };
        }
        return { pref: null, area: null };
      };

      const byPref = new Map();
      for (const b of (Array.isArray(bulletins) ? bulletins : [])) {
        const w = b?.warning || {};
        for (const key of ['class10Items', 'class15Items']) {
          for (const item of (w[key] || [])) {
            for (const kind of (item.kinds || [])) {
              if (!_isActiveKind(kind)) continue;
              if (_WARNING_LEVEL_BY_CODE[kind.code] !== 50) continue;
              const { pref, area } = resolve(item.areaCode);
              if (!pref) continue;
              if (!byPref.has(pref)) {
                byPref.set(pref, {
                  pref, areas: new Set(), kinds: new Set(),
                  headline: (b.headlineText || '').trim(),
                  reportDatetime: b.reportDatetime || '',
                });
              }
              const rec = byPref.get(pref);
              if (area) rec.areas.add(area);
              rec.kinds.add(_SPECIAL_WARNING_ELEM[kind.code] || kind.code);
            }
          }
        }
      }
      const alerts = [...byPref.values()].map((r) => ({
        pref: r.pref, areas: [...r.areas], kinds: [...r.kinds],
        headline: r.headline, reportDatetime: r.reportDatetime,
      }));
      this._nationalStamp = stamp;
      this._nationalAlerts = alerts;
      return alerts;
    } catch (e) {
      getLogger().debug('[Weather] 全国の特別警報の取得に失敗: ' + e.message);
      return this._nationalAlerts || [];
    }
  }

  /**
   * 気象庁の「今日・明日」の詳しい公式予報を取得する。
   *
   * ATTENTION: 今日・明日は必ずこちらの詳しい予報を使うこと。週間予報は粗く、同じ日でも
   * 詳しい予報と食い違う。OpenWeatherMap だけに頼っていた頃は、明日の予報がよく外れていた。
   *
   * ATTENTION: 気温は必ず「日付＋時刻」で引き当てること。時刻の並びは時系列順とは限らず、
   * 順番で読むと最高と最低が入れ替わる（0時が最低・9時が最高）。
   *
   * @param {any} [opts] prefCode（都道府県コード。既定は東京）
   * @returns {Promise<any>} 地域名・発表時刻・今日と明日の天気と気温。取れなければ null
   */
  async fetchOfficialDailyForecast({ prefCode = '130000' } = {}) {
    try {
      const res = await _jmaFetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${prefCode}.json`);
      if (!res.ok) return null;
      const reports = await res.json();
      const rep = Array.isArray(reports) ? reports[0] : null;
      const ts = rep?.timeSeries;
      if (!ts || ts.length < 3) return null;

      // 先頭が県内の主要区分。市区町村単位の予報は気象庁も出していないため、
      // これが公式に取れる最小の粒度になる。
      const wArea = ts[0]?.areas?.[0];
      const pArea = ts[1]?.areas?.[0];
      const tArea = ts[2]?.areas?.[0];

      const JST_OFFSET = 9 * 60 * 60 * 1000;
      const nowJST = new Date(Date.now() + JST_OFFSET);
      const dayStr = (d) => d.toISOString().slice(0, 10);
      const todayStr = dayStr(nowJST);
      const tomorrowStr = dayStr(new Date(nowJST.getTime() + 86400000));

      // 天気の文。全角の空白をそのまま読ませると不自然なので、1つの空白へ潰す
      const weatherFor = (dateStr) => {
        const i = (ts[0].timeDefines || []).findIndex((t) => t.slice(0, 10) === dateStr);
        return i >= 0 ? String(wArea?.weathers?.[i] || '').replace(/[\s\u3000]+/g, ' ').trim() || null : null;
      };
      // 気温は「日付＋時刻」で引く（0時=最低・9時=最高）
      const tempAt = (dateStr, hour) => {
        const i = (ts[2].timeDefines || []).findIndex((t) => t.slice(0, 10) === dateStr && t.slice(11, 13) === hour);
        const v = i >= 0 ? tArea?.temps?.[i] : null;
        return v == null || v === '' ? null : parseInt(v, 10);
      };
      const popsFor = (dateStr) => {
        const out = [];
        (ts[1].timeDefines || []).forEach((t, i) => {
          if (t.slice(0, 10) !== dateStr) return;
          out.push(`${t.slice(11, 13)}時 ${pArea?.pops?.[i]}%`);
        });
        return out.length ? out.join(' / ') : null;
      };

      return {
        areaName: wArea?.area?.name || '',
        tempPointName: tArea?.area?.name || '',
        reportDatetime: rep.reportDatetime || '',
        today:    { weather: weatherFor(todayStr),    max: tempAt(todayStr, '09'),    min: tempAt(todayStr, '00') },
        tomorrow: { weather: weatherFor(tomorrowStr), max: tempAt(tomorrowStr, '09'), min: tempAt(tomorrowStr, '00'),
                    pops: popsFor(tomorrowStr) },
      };
    } catch (e) {
      getLogger().warn('[Weather] JMA今日・明日の予報取得エラー: ' + e.message);
      return null;
    }
  }

  /**
   * 気象庁の週間予報（7日先まで）と、公式の概況文を取得する。
   *
   * OpenWeatherMap の無料の範囲では5日先までしか返らないため、週次のノートで必要な
   * 7日先までの予報はこちらを使う。
   *
   * ATTENTION: 天気コードは先頭桁の大まかな分類（晴れ・くもり・雨・雪）だけを使うこと
   * （_weatherCodeCategory）。「くもり時々雨」のような詳しい言い回しへ変換する公式の表が
   * 手に入らず、手で作った表は実データと食い違った。粗くても確実に正しい方を採っている。
   *
   * @param {any} [opts] prefCode（都道府県コード。既定は東京）
   * @returns {Promise<any>} 概況文と日ごとの予報。{ overviewText, days }。取れなければ null
   */
  async fetchWeeklyForecast({ prefCode = '130000' } = {}) {
    try {
      const [forecastRes, overviewRes] = await Promise.allSettled([
        _jmaFetch(`https://www.jma.go.jp/bosai/forecast/data/forecast/${prefCode}.json`),
        _jmaFetch(`https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${prefCode}.json`),
      ]);

      let overviewText = null;
      if (overviewRes.status === 'fulfilled' && overviewRes.value.ok) {
        const ov = await overviewRes.value.json();
        overviewText = (ov.text || '').trim() || null;
      }

      if (forecastRes.status !== 'fulfilled' || !forecastRes.value.ok) {
        getLogger().warn('[Weather] JMA週間予報の取得に失敗');
        return overviewText ? { overviewText, days: [] } : null;
      }
      const reports = await forecastRes.value.json();
      const weekly = Array.isArray(reports) ? reports[1] : null;
      if (!weekly) return overviewText ? { overviewText, days: [] } : null;

      const codeSeries = (weekly.timeSeries || [])[0];
      const tempSeries = (weekly.timeSeries || [])[1];
      const codeArea = codeSeries?.areas?.[0];
      const tempArea = tempSeries?.areas?.[0];
      const timeDefines = codeSeries?.timeDefines || [];

      const days = timeDefines.map((iso, i) => {
        const date = iso.slice(0, 10);
        const code = codeArea?.weatherCodes?.[i] || '';
        const tempMinRaw = tempArea?.tempsMin?.[i];
        const tempMaxRaw = tempArea?.tempsMax?.[i];
        const popRaw = codeArea?.pops?.[i];
        return {
          date,
          weatherCode: code,
          weatherCategory: _weatherCodeCategory(code),
          tempMin: tempMinRaw ? parseInt(tempMinRaw, 10) : null,
          tempMax: tempMaxRaw ? parseInt(tempMaxRaw, 10) : null,
          pop: popRaw ? parseInt(popRaw, 10) : null,
          reliability: codeArea?.reliabilities?.[i] || '',
        };
      });

      getLogger().info(`[Weather] JMA週間予報を取得: ${days.length}日分`);
      return { overviewText, days };
    } catch (e) {
      getLogger().warn('[Weather] JMA週間予報取得エラー: ' + e.message);
      return null;
    }
  }

  /**
   * 天気と防災情報をまとめて取得し、1本の文面を返す。判定用の生の値は this.cache.structured
   * に入る。
   *
   * 実際にどこの天気を取るか（臨時の滞在先・その場の指定を踏まえた決定）は呼び出し側が
   * 済ませておき、ここには解決済みの地名だけを渡す。
   *
   * opts の内訳:
   *   - overrideLocation: その場だけ指定された地名。あるときは溜めてある結果を使わない
   *   - defaultLocation: 通常時の地名
   *   - isTempStay: 臨時の滞在先かどうか（ログに出すだけ）
   *   - apiKey: OpenWeatherMap の API キー
   *   - prefCode: 気象警報で使う都道府県コード（既定は東京）
   *
   * @param {any} [opts] 上記の設定
   * @returns {Promise<any>} 組み立てた文面。キーが無ければ null、失敗時は前回の結果
   */
  async fetch({ overrideLocation = null, defaultLocation, isTempStay = false, apiKey, prefCode = '130000' } = {}) {
    if (!apiKey) return null;

    const location = overrideLocation || defaultLocation;
    if (overrideLocation) {
      getLogger().info(`[Weather] リクエスト場所モード: ${location}`);
    } else {
      if (isTempStay) getLogger().info(`[Weather] 臨時滞在地モード: ${location}`);
      // 通常時は20分だけ前回の結果を使い回す
      if (this.cache.data && Date.now() - this.cache.lastFetch < 1200000
          && this.cache.location === location) {
        return this.cache.data;
      }
      // 場所が変わっていたら前回の結果は捨てる
      if (this.cache.location && this.cache.location !== location) {
        getLogger().info(`[Weather] 取得先変更（${this.cache.location} → ${location}）: キャッシュ破棄`);
        this.cache = { data: null, lastFetch: 0, location: null };
      }
    }

    try {
      const { lat, lon } = await _geocodeLocation(location, apiKey);

      const owm = await _fetchCurrentAndForecast(location, lat, lon, apiKey);
      const {
        temp, desc, humidity, wind, todayMax, todayMin,
        tomorrowInfo, todayRawSlots, tomorrowRawSlots,
      } = owm;
      let regularWeather = owm.regularWeather;

      // 気象庁の防災情報をまとめて取る。文面では緊急度の順（地震 > 台風 > 警報）に並べる
      const jmaFetch = _jmaFetch;

      const [typhoonListRes, warningRes, quakeRes, officialRes, nationalRes, tsunamiRes] = await Promise.allSettled([
        jmaFetch('https://www.jma.go.jp/bosai/typhoon/data/targetTc.json'),
        jmaFetch(`https://www.jma.go.jp/bosai/warning/data/r8/${prefCode}.json`),
        jmaFetch('https://www.jma.go.jp/bosai/quake/data/list.json'),
        this.fetchOfficialDailyForecast({ prefCode }),
        this.fetchNationalSpecialWarnings(),
        _fetchActiveTsunamiLevel(jmaFetch),
      ]);

      // 気象庁の公式予報を通常の天気の先頭に置く
      const officialSection = _buildOfficialForecastSection(officialRes);
      if (officialSection) regularWeather = `${officialSection}\n\n${regularWeather}`;

      // それぞれ別に組み立て、最後に緊急度の順で1本につなぐ
      const quake = await _buildQuakeSection(quakeRes, jmaFetch);
      const merged = _applyStandaloneTsunami(tsunamiRes, quake.quakeSection, quake.quakeTsunamiLevel);
      const { quakeSection, quakeTsunamiLevel } = merged;
      const { quakeMaxIntensity } = quake;

      const {
        typhoonSection, typhoonNearestKm, typhoonNearestJapanKm,
        typhoonImpact, typhoonAffectsListener, typhoonListenerClosestKm,
      } = await _buildTyphoonSection(typhoonListRes, jmaFetch, lat, lon);

      const { warningSection, warningAffectsListener, listenerAreaCodes, listenerWarningLevel } =
        await _buildWarningSection(warningRes, jmaFetch, location);

      const { nationalAlertSection, nationalAlerts } = _buildNationalAlertSection(nationalRes);

      // 地震 > 台風 > 警報 > 全国の特別警報 > 通常の天気 の順につなぐ
      const sections = [quakeSection, typhoonSection, warningSection, nationalAlertSection, regularWeather]
        .filter(Boolean);
      const result = sections.join('\n\n');

      this.cache = {
        data: result, lastFetch: Date.now(), location,
        structured: {
          location, temp, desc, todayMax, todayMin, humidity, wind,
          tomorrow: tomorrowInfo,
          // 時間帯ごとの生の値。傘・熱中症・寒暖差の助言をコード側で判定するのに使う
          todayRemaining: todayRawSlots,
          tomorrowHourly: tomorrowRawSlots,
          // ATTENTION: 「出ているか」と「影響があるか」は分けて持つ。呼び出し側は
          // 影響のある方だけを緊急として扱うこと。
          warningAffectsListener,
          listenerAreaCodes,
          typhoonNearestKm,
          // ATTENTION: 台風の緊急度はこちらで判断する。上の居住地からの直線距離は進路を
          // 見ていない指標なので、それだけで判断しないこと。
          typhoonImpact,
          typhoonNearestJapanKm,
          typhoonAffectsListener,
          typhoonListenerClosestKm,
          listenerWarningLevel,
          quakeMaxIntensity,
          // 津波の警報・注意報が出ているか（震度が低くても緊急として扱う根拠）
          quakeTsunamiLevel,
          quakeTsunamiLabel: quakeTsunamiLevel ? _TSUNAMI_LABEL[quakeTsunamiLevel] : null,
          hasTyphoon:    typhoonSection !== '',
          typhoonSummary: typhoonSection ? (typhoonSection.split('\n')[1] || null) : null,
          hasWarning:    warningSection !== '',
          warningSummary: warningSection ? (warningSection.replace(/【[^】]+】\n?/, '').split('\n')[0] || null) : null,
          hasQuake:      quakeSection !== '',
          // 津波が出ている回は見出しそのものが要約になる。通常は1行目が見出し・
          // 2行目が最新の地震なので2行目を使う。
          quakeSummary:  !quakeSection ? null
            : quakeSection.startsWith('【🌊')
              ? quakeSection.split('\n')[0].replace(/[【】]/g, '')
              : (quakeSection.split('\n')[1] || null),
          // 他県で発表中の特別警報。居住地の緊急情報とは別枠で扱う
          hasNationalAlert: nationalAlerts.length > 0,
          nationalAlerts,
          nationalAlertSummary: nationalAlerts.length > 0
            ? nationalAlerts.map((a) => `${a.pref}に${a.kinds.join('・')}特別警報`).join(' / ')
            : null,
        },
      };
      return result;

    } catch (e) {
      getLogger().error('[Weather] fetchWeatherData error:', e.message);
      return this.cache.data || null; // 失敗したときは前回の結果でしのぐ
    }
  }
}

module.exports = WeatherService;
