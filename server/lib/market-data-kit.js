/**
 * @file 数値データの取得と分析（LLM を使わず決定的に計算する層）
 *
 * 討論コーナーなどで出演者が数字に基づいて語れるように、公式の時系列を取ってきて計算し、
 * プロンプトへそのまま入れられる日本語の「数値シート」にする。数字を取ることと計算することだけを
 * 受け持ち、解釈は出演者に任せる。
 *
 * - 取得元: 財務省（国債利回り）、Yahoo Finance（相場の履歴）、FRED（各国の公式時系列）
 * - 計算: 1週間・1か月・1年の変化、過去5年の中での位置、2つの系列の相関・回帰の傾き・差
 *
 * ATTENTION: 相関係数や変化率を LLM に計算させないこと（暗算させると必ず狂う）。ここで計算した
 * 数値だけを渡す。
 *
 * ATTENTION: 相関は1つの数字で渡さない。連動の強さは時期によって変わるので、同じ組み合わせを
 * 約1か月・3か月・1年・3年の4つの期間で並べて渡す（「足元では強まっているが、常にではない」と
 * 語れるようにするため）。
 *
 * 取得した系列はプロセス内にキャッシュする（同じ討論の中で同じ系列を何度も引くため）。
 * 利用元は discussion-data-sheet.js と standing-data-sheet.js。
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

const MOF_ALL_CSV = 'https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv';
const MOF_CURRENT_CSV = 'https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv';
const UA = 'Mozilla/5.0 (compatible; AIRadio/1.0)';

// プロセス内のキャッシュ（同じ討論の中で何度も同じ系列を引くため）と、種類ごとの有効期間（ミリ秒）
const _cache = { jgb: { at: 0, data: null }, yahoo: new Map(), fred: new Map(), fredSearch: new Map() };
const TTL = { jgb: 6 * 3600 * 1000, yahoo: 3 * 3600 * 1000, fred: 12 * 3600 * 1000, search: 24 * 3600 * 1000 };

/**
 * 和暦の日付（R8.9.15 など、昭和・平成・令和）を YYYY-MM-DD にする。
 *
 * @param {string} s 和暦の日付
 * @returns {string|null} YYYY-MM-DD（読めなければ null）
 */
function parseEraDate(s) {
  const m = String(s || '').trim().match(/^([SHR])(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const base = { S: 1925, H: 1988, R: 2018 }[m[1]];
  const y = base + parseInt(m[2], 10);
  return `${y}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
}

/**
 * 財務省の国債金利の CSV（Shift_JIS）を取り、日付の付いた行の一覧にする（見出しや注記の行は飛ばす）。
 *
 * @param {string} url CSV の URL
 * @returns {Promise<Array<{date: string, cols: string[]}>>} 日付と列の値
 */
async function _fetchMofCsv(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = new TextDecoder('shift_jis').decode(Buffer.from(await res.arrayBuffer()));
  const rows = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(',');
    const date = parseEraDate(cols[0]);
    if (!date) continue;                    // 見出し・注記の行
    rows.push({ date, cols });
  }
  return rows;
}

/**
 * 取り出す年限と、財務省の CSV の列番号。
 * 列の並び: 0=基準日, 1年,2年,3年,4年,5年,6年,7年,8年,9年,10年,15年,20年,25年,30年,40年
 */
const JGB_TENORS = [
  { key: 'jgb_2y', col: 2, label: '日本国債2年利回り' },
  { key: 'jgb_5y', col: 5, label: '日本国債5年利回り' },
  { key: 'jgb_10y', col: 10, label: '日本国債10年利回り' },
  { key: 'jgb_20y', col: 12, label: '日本国債20年利回り' },
  { key: 'jgb_30y', col: 14, label: '日本国債30年利回り' },
];

/**
 * 年限ごとの国債利回りの時系列を返す。
 *
 * 全期間版の CSV（更新が数週間遅れる）と当月版を日付でつなぎ、最新の営業日までそろった1本の
 * 履歴にする（同じ日付は当月版を優先）。両方とも取れなければ空のオブジェクトを返す。
 *
 * @returns {Promise<Record<string, {label: string, unit: string, source: string, points: {date: string, value: number}[]}>>}
 *   jgb_2y などのキー → 系列
 */
async function getJgbSeries() {
  if (_cache.jgb.data && Date.now() - _cache.jgb.at < TTL.jgb) return _cache.jgb.data;
  const [all, cur] = await Promise.all([
    _fetchMofCsv(MOF_ALL_CSV).catch((e) => { getLogger().warn(`[MarketData] 国債利回り（全期間）の取得に失敗: ${e.message}`); return []; }),
    _fetchMofCsv(MOF_CURRENT_CSV).catch((e) => { getLogger().warn(`[MarketData] 国債利回り（当月）の取得に失敗: ${e.message}`); return []; }),
  ]);
  if (all.length === 0 && cur.length === 0) return {};

  const byDate = new Map();
  for (const r of [...all, ...cur]) byDate.set(r.date, r.cols);   // 当月版が全期間版を上書き
  const dates = [...byDate.keys()].sort();

  const out = {};
  for (const t of JGB_TENORS) {
    const points = [];
    for (const d of dates) {
      const v = parseFloat(byDate.get(d)[t.col]);
      if (Number.isFinite(v)) points.push({ date: d, value: v });
    }
    if (points.length > 0) out[t.key] = { label: t.label, unit: '%', source: '財務省', points };
  }
  _cache.jgb = { at: Date.now(), data: out };
  getLogger().info(`[MarketData] 国債利回りの履歴を取得（${dates.length}営業日・最新 ${dates[dates.length - 1]}）`);
  return out;
}

/**
 * Yahoo Finance から銘柄・指数の日々の終値の履歴を取る。
 *
 * BUGFIX: 既定で5年分を取る。3年分では日米の休場日の違いで共通の営業日が足りず、「直近3年」の
 * 相関が計算できなくなっていた。
 *
 * @param {string} symbol Yahoo Finance のシンボル
 * @param {{label?: string, unit?: string, range?: string}} [opts] 表示名・単位・取得期間（既定 5y）
 * @returns {Promise<{label: string, unit: string, source: string, points: {date: string, value: number}[]}>} 系列
 */
async function getYahooSeries(symbol, { label = '', unit = '', range = '5y' } = {}) {
  const ck = `${symbol}|${range}`;
  const hit = _cache.yahoo.get(ck);
  if (hit && Date.now() - hit.at < TTL.yahoo) return hit.data;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?interval=1d&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const close = r?.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const v = close[i];
    if (Number.isFinite(v)) points.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), value: v });
  }
  const data = { label: label || symbol, unit, source: 'Yahoo Finance', points };
  _cache.yahoo.set(ck, { at: Date.now(), data });
  return data;
}

/**
 * FRED の系列をキーワードで探し、人気順の先頭を返す。
 *
 * ATTENTION: 系列 ID を LLM に書かせると存在しない ID を作るので、LLM にはキーワードだけを
 * 言わせ、検索はここで行う。
 *
 * @param {string} apiKey FRED の API キー
 * @param {string} keyword 検索するキーワード
 * @returns {Promise<{id: string, title: string, unit: string, frequency: string}|null>} 見つかった系列（無ければ null）
 */
async function searchFredSeries(apiKey, keyword) {
  if (!apiKey || !keyword) return null;
  const hit = _cache.fredSearch.get(keyword);
  if (hit && Date.now() - hit.at < TTL.search) return hit.data;
  const url = 'https://api.stlouisfed.org/fred/series/search'
    + `?search_text=${encodeURIComponent(keyword)}&api_key=${apiKey}&file_type=json`
    + '&limit=5&order_by=popularity&sort_order=desc';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const s = (json.seriess || [])[0] || null;
  const data = s ? { id: s.id, title: s.title, unit: s.units_short || '', frequency: s.frequency_short || '' } : null;
  _cache.fredSearch.set(keyword, { at: Date.now(), data });
  return data;
}

/**
 * FRED の系列の観測値を取る（既定で5年分）。
 *
 * @param {string} apiKey FRED の API キー
 * @param {string} seriesId 系列 ID
 * @param {{label?: string, unit?: string, years?: number}} [opts] 表示名・単位・取得する年数
 * @returns {Promise<{label: string, unit: string, source: string, points: {date: string, value: number}[]}>} 系列
 */
async function getFredSeries(apiKey, seriesId, { label = '', unit = '', years = 5 } = {}) {
  const hit = _cache.fred.get(seriesId);
  if (hit && Date.now() - hit.at < TTL.fred) return hit.data;
  const start = new Date(Date.now() - years * 365.25 * 86400 * 1000).toISOString().slice(0, 10);
  const url = 'https://api.stlouisfed.org/fred/series/observations'
    + `?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const points = [];
  for (const o of json.observations || []) {
    const v = parseFloat(o.value);
    if (Number.isFinite(v)) points.push({ date: o.date, value: v });
  }
  const data = { label: label || seriesId, unit, source: `FRED（${seriesId}）`, points };
  _cache.fred.set(seriesId, { at: Date.now(), data });
  return data;
}

// ─── 分析（すべて決定的な計算） ───────────────────────────────────────────────

/**
 * 最新の観測日から days 日前に最も近い観測値を返す（目標日より3日以上あとの観測は使わない）。
 *
 * @param {Array<{date: string, value: number}>} points 日付の古い順の観測値
 * @param {number} days さかのぼる日数
 * @returns {{date: string, value: number}|null} 観測値（無ければ null）
 */
function _valueDaysAgo(points, days) {
  if (points.length === 0) return null;
  const last = new Date(points[points.length - 1].date).getTime();
  const target = last - days * 86400 * 1000;
  let best = null;
  for (const p of points) {
    const t = new Date(p.date).getTime();
    if (t > target + 3 * 86400 * 1000) break;     // 目標日より3日以上あとは見ない
    best = p;
  }
  return best;
}

/**
 * 直近 years 年の中で、value が下から何%の位置にあるかと、その期間の最高・最低を返す。
 *
 * @param {Array<{date: string, value: number}>} points 日付の古い順の観測値
 * @param {number} value 位置を調べる値
 * @param {number} years 対象にする年数
 * @returns {{percentile: number, min: Record<string, any>, max: Record<string, any>, n: number}|null}
 *   位置・最低・最高・観測数（観測が20件未満なら null）
 */
function _pct(points, value, years) {
  const from = new Date(points[points.length - 1].date).getTime() - years * 365.25 * 86400 * 1000;
  const window = points.filter(p => new Date(p.date).getTime() >= from);
  if (window.length < 20) return null;
  const below = window.filter(p => p.value <= value).length;
  const min = window.reduce((a, b) => (b.value < a.value ? b : a));
  const max = window.reduce((a, b) => (b.value > a.value ? b : a));
  return { percentile: Math.round((below / window.length) * 100), min, max, n: window.length };
}

/**
 * 1本の系列を分析する（最新値、1週間・1か月・1年前との差、過去5年の中での位置）。
 *
 * @param {Record<string, any>} series 系列（label・unit・source・points）
 * @returns {Record<string, any>|null} label・unit・source・latest・changes・position（観測が無ければ null）
 */
function analyzeSeries(series) {
  const points = series?.points || [];
  if (points.length === 0) return null;
  const latest = points[points.length - 1];
  const chg = (days) => {
    const p = _valueDaysAgo(points, days);
    if (!p || p.date === latest.date) return null;
    // BUGFIX: 比べる相手の日付が期間の半分〜2倍の範囲に無ければ出さない。月次・年次の系列で
    // 「1週間前比」と称して1か月前や1年前の値と比べていた。
    const gapDays = (new Date(latest.date).getTime() - new Date(p.date).getTime()) / 86400000;
    if (gapDays < days * 0.5 || gapDays > days * 2) return null;
    return { from: p, diff: latest.value - p.value };
  };
  return {
    label: series.label,
    unit: series.unit || '',
    source: series.source || '',
    latest,
    changes: { w1: chg(7), m1: chg(30), y1: chg(365) },
    position: _pct(points, latest.value, 5),
  };
}

/**
 * 2つの系列を日付で突き合わせ、両方に値がある日だけを並べる。
 *
 * @param {Record<string, any>} a 系列 a
 * @param {Record<string, any>} b 系列 b
 * @returns {Array<{date: string, a: number, b: number}>} 共通の日付の値
 */
function _align(a, b) {
  const mb = new Map(b.points.map(p => [p.date, p.value]));
  const rows = [];
  for (const p of a.points) {
    const v = mb.get(p.date);
    if (Number.isFinite(v)) rows.push({ date: p.date, a: p.value, b: v });
  }
  return rows;
}

/**
 * ピアソンの相関係数を計算する。
 *
 * @param {number[]} xs 値の列
 * @param {number[]} ys 値の列（xs と同じ長さ）
 * @returns {number|null} 相関係数（10件未満か、どちらかの分散が0なら null）
 */
function _pearson(xs, ys) {
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** 相関を出す期間（営業日数と表示名）。 */
const CORR_WINDOWS = [
  { days: 30, label: '直近約1か月' },
  { days: 90, label: '直近3か月' },
  { days: 250, label: '直近1年' },
  { days: 750, label: '直近3年' },
];

/**
 * 2つの系列の関係を分析する。
 *
 * 日々の変化どうしの相関を、CORR_WINDOWS の期間ごとに出す（水準どうしの相関は、両方が右肩上がり
 * というだけで高く出てしまい、連動の指標にならないため）。直近1年の回帰の傾きと、単位が同じなら
 * 差（スプレッド）の最新値と過去1年の幅も出す。
 *
 * @param {Record<string, any>} aSeries 系列 a
 * @param {Record<string, any>} bSeries 系列 b
 * @returns {Record<string, any>} a・b（表示名）・correlations・slope・spread・commonDays
 *   （共通の観測日が30日未満なら a・b・error）
 */
function analyzePair(aSeries, bSeries) {
  const rows = _align(aSeries, bSeries);
  if (rows.length < 30) {
    return { a: aSeries.label, b: bSeries.label, error: `共通する観測日が${rows.length}日しかなく、連動性は計算できません` };
  }
  const da = [], db = [];
  for (let i = 1; i < rows.length; i++) { da.push(rows[i].a - rows[i - 1].a); db.push(rows[i].b - rows[i - 1].b); }

  const correlations = [];
  for (const w of CORR_WINDOWS) {
    if (da.length < w.days) continue;
    const r = _pearson(da.slice(-w.days), db.slice(-w.days));
    if (r != null) correlations.push({ label: w.label, r: Math.round(r * 100) / 100, n: w.days });
  }

  // 回帰の傾き（直近1年）: bが1単位動いたときにaがどれだけ動いたか
  let slope = null;
  const N = Math.min(250, da.length);
  if (N >= 60) {
    const x = db.slice(-N), y = da.slice(-N);
    const mx = x.reduce((s, v) => s + v, 0) / N, my = y.reduce((s, v) => s + v, 0) / N;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < N; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    if (sxx > 0) slope = Math.round((sxy / sxx) * 1000) / 1000;
  }

  let spread = null;
  if ((aSeries.unit || '') === (bSeries.unit || '') && aSeries.unit) {
    const last = rows[rows.length - 1];
    const from = new Date(last.date).getTime() - 365.25 * 86400 * 1000;
    const win = rows.filter(r => new Date(r.date).getTime() >= from).map(r => r.a - r.b);
    spread = {
      latest: Math.round((last.a - last.b) * 1000) / 1000,
      date: last.date,
      min: win.length ? Math.round(Math.min(...win) * 1000) / 1000 : null,
      max: win.length ? Math.round(Math.max(...win) * 1000) / 1000 : null,
      unit: aSeries.unit,
    };
  }
  return { a: aSeries.label, b: bSeries.label, correlations, slope, spread, commonDays: rows.length };
}

// ─── 出演者へ渡す形へ整形 ───────────────────────────────────────────────────

/**
 * 値を単位付きで表示する（% は小数3桁、1000以上は整数、それ以外は小数2桁）。
 *
 * @param {number} v 値
 * @param {string} unit 単位
 * @returns {string} 表示用の文字列
 */
function _fmt(v, unit) {
  const digits = unit === '%' ? 3 : Math.abs(v) >= 1000 ? 0 : 2;
  return `${v.toFixed(digits)}${unit === '%' ? '%' : unit ? unit : ''}`;
}
/**
 * 差を符号付きで表示する（% の差は pt で表す）。
 *
 * @param {number} diff 差
 * @param {string} unit 単位
 * @returns {string} 表示用の文字列
 */
function _fmtDiff(diff, unit) {
  const sign = diff >= 0 ? '+' : '−';
  const abs = Math.abs(diff);
  const digits = unit === '%' ? 3 : abs >= 1000 ? 0 : 2;
  return `${sign}${abs.toFixed(digits)}${unit === '%' ? 'pt' : unit ? unit : ''}`;
}
/**
 * 日付を「月/日」で表示する。
 *
 * BUGFIX: 今年以外の日付には年を付ける。「最低 0.041%=9/15」が5年前なのか今年なのか
 * 区別できなかった。
 *
 * @param {string} d YYYY-MM-DD
 * @returns {string} 表示用の日付
 */
const _md = (d) => {
  const md = `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`;
  return d.slice(0, 4) === String(new Date().getFullYear()) ? md : `${d.slice(0, 4)}年${md}`;
};

/**
 * 分析結果を、そのままプロンプトへ入れられる日本語の数値シートにする。
 *
 * @param {{series?: Array<Record<string, any>>, pairs?: Array<Record<string, any>>, missing?: string[]}} [data]
 *   analyzeSeries・analyzePair の結果と、数字が見つからなかった項目
 * @returns {string} 数値シートの本文
 */
function formatDataSheet({ series = [], pairs = [], missing = [] } = {}) {
  const lines = [];
  if (series.length > 0) {
    lines.push('■ 水準と変化（公式データから直接取得し、変化はシステムが計算）');
    for (const s of series) {
      const parts = [`- ${s.label}: ${_fmt(s.latest.value, s.unit)}（${_md(s.latest.date)}時点）`];
      const ch = [];
      if (s.changes.w1) ch.push(`1週間前比 ${_fmtDiff(s.changes.w1.diff, s.unit)}`);
      if (s.changes.m1) ch.push(`1か月前比 ${_fmtDiff(s.changes.m1.diff, s.unit)}`);
      if (s.changes.y1) ch.push(`1年前比 ${_fmtDiff(s.changes.y1.diff, s.unit)}`);
      if (ch.length) parts.push(`　${ch.join(' / ')}`);
      if (s.position) {
        parts.push(`　過去5年の中では下から${s.position.percentile}%の位置`
          + `（最高 ${_fmt(s.position.max.value, s.unit)}=${_md(s.position.max.date)}・`
          + `最低 ${_fmt(s.position.min.value, s.unit)}=${_md(s.position.min.date)}）`);
      }
      parts.push(`（出典: ${s.source}）`);
      lines.push(parts.join(''));
    }
  }
  if (pairs.length > 0) {
    lines.push('');
    lines.push('■ 連動性（日々の変化どうしの相関。**期間によって変わるため、話すときは必ず期間を添えること**）');
    for (const p of pairs) {
      if (p.error) { lines.push(`- ${p.a} と ${p.b}: ${p.error}`); continue; }
      const corr = (p.correlations || []).map(c => `${c.label} ${c.r.toFixed(2)}`).join(' / ');
      lines.push(`- ${p.a} と ${p.b}: ${corr || '計算に必要な期間が足りません'}`);
      if (p.slope != null) {
        lines.push(`  　直近1年の回帰: ${p.b}が1単位動いたとき ${p.a} は平均 ${p.slope} 単位動いた`);
      }
      if (p.spread) {
        lines.push(`  　差（${p.a} − ${p.b}）: ${_fmt(p.spread.latest, p.spread.unit)}`
          + `（過去1年のレンジ ${_fmt(p.spread.min, p.spread.unit)}〜${_fmt(p.spread.max, p.spread.unit)}）`);
      }
    }
    lines.push('⚠️ 相関は「一緒に動いた度合い」であって、原因と結果の証明ではありません。'
      + '因果を語るときは、相関の数値とは別に根拠を示してください。');
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`（確かな数字が見つからなかった項目: ${missing.join(' / ')}）`);
  }
  return lines.join('\n');
}

module.exports = {
  getJgbSeries, getYahooSeries, searchFredSeries, getFredSeries,
  analyzeSeries, analyzePair, formatDataSheet,
  // 試験用
  parseEraDate, CORR_WINDOWS,
};
