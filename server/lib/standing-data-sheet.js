/**
 * @file 定点観測の数値シート（コメンテーターのコーナーに渡す、指標の変化・位置・連動性）
 *
 * 毎回同じ顔ぶれの指標（国債利回り・日経平均・米金利・ドル円・政策金利）について、1週間・1か月・1年の
 * 変化、過去5年の中での位置、系列どうしの連動性を計算して渡す。「今いくつか」だけでは、解説に数値が
 * 出てこなかったため。
 *
 *   - LLM は使わない（話題に合わせて系列を選ぶ討論版 lib/discussion-data-sheet.js と違い、顔ぶれが固定なので）
 *   - 取得と計算は market-data-kit.js が行う（取得はキャッシュ付き。国債6時間・相場3時間・FRED 12時間）
 *   - 「今週とくに動いた項目」をコードで選び、必ず取り上げさせる
 *   - 時間の上限（既定6秒）を過ぎたら空を返し、コーナーは数値シートなしで進む
 *
 * 主な利用元: agent-system.js（コメンテーターのコーナー）
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
const kit = require('./market-data-kit');

// 定点観測の顔ぶれ。増やすとコーナーのプロンプトが長くなるので、毎回押さえたいものだけに絞る。
// label は market-data-kit の呼び名とそろえる（取れなかったときに名前を出すため）。
const JGB_SERIES = [
  { key: 'jgb_2y', label: '日本国債2年利回り' },
  { key: 'jgb_10y', label: '日本国債10年利回り' },
  { key: 'jgb_20y', label: '日本国債20年利回り' },
];
const MARKET_SERIES = [
  { symbol: '^N225', label: '日経平均', unit: '' },
  { symbol: '^TNX', label: '米国債10年利回り', unit: '%' },
  { symbol: 'USDJPY=X', label: 'ドル/円', unit: '' },
];
// 政策金利は、水準より「いつから動いていないか」が論点になるので入れている。
const FRED_SERIES = [
  { id: 'FEDFUNDS', label: '米FF金利（月次平均）', unit: '%' },
  { id: 'IRSTCI01JPM156N', label: '日本の政策金利', unit: '%' },
];

// シートの並び順。取得は並行して行うので、届いた順に並べると回ごとに順番が変わってしまう
// （実際に FRED の2系列が毎回入れ替わった）。毎回同じ並びで渡すため、ここで固定する。
const SHEET_ORDER = [
  ...JGB_SERIES,
  ...MARKET_SERIES.map((m) => ({ key: m.symbol, label: m.label })),
  ...FRED_SERIES.map((f) => ({ key: f.id, label: f.label })),
];

/**
 * 1週間の変化の大きさを、過去5年の幅で割って比べられるようにする（単位の違う系列を並べるため）。
 * @param {Record<string, any>} a analyzeSeries の結果
 * @returns {number} 計算できなければ 0
 */
function _moveScore(a) {
  const w = a.changes?.w1?.diff;
  if (!Number.isFinite(w) || !a.position) return 0;
  const range = a.position.max.value - a.position.min.value;
  if (!(range > 0)) return 0;
  return Math.abs(w) / range;
}

/**
 * 定点観測のシートを作る。
 * @param {{creds?: Record<string, any>, capMs?: number}} [opts] creds は認証情報（FRED の API キーを使う。
 *   無ければ政策金利は省く）、capMs は時間の上限
 * @returns {Promise<string>} 空文字なら渡すものが無い（コーナーはシートなしで進む）
 */
async function buildStandingDataSheet({ creds, capMs = 6000 } = {}) {
  const fredKey = creds?.fred?.api_key;

  const work = (async () => {
    const series = [];
    const byKey = new Map();

    const jgb = await kit.getJgbSeries().catch((e) => {
      getLogger().warn(`[StandingData] 国債利回りの取得に失敗: ${e.message}`);
      return {};
    });
    for (const { key } of JGB_SERIES) if (jgb[key]) byKey.set(key, jgb[key]);

    await Promise.all(MARKET_SERIES.map(async (m) => {
      try {
        byKey.set(m.symbol, await kit.getYahooSeries(m.symbol, { label: m.label, unit: m.unit }));
      } catch (e) {
        getLogger().warn(`[StandingData] ${m.label} の取得に失敗: ${e.message}`);
      }
    }));

    await Promise.all(FRED_SERIES.map(async (f) => {
      if (!fredKey) return;
      try {
        byKey.set(f.id, await kit.getFredSeries(fredKey, f.id, { label: f.label, unit: f.unit }));
      } catch (e) {
        getLogger().warn(`[StandingData] ${f.label} の取得に失敗: ${e.message}`);
      }
    }));

    // 取れたものも取れなかったものも、SHEET_ORDER の順に並べる
    const missing = [];
    for (const { key, label } of SHEET_ORDER) {
      const s = byKey.get(key);
      if (!s) { missing.push(label); continue; }
      const a = kit.analyzeSeries(s);
      if (a) series.push(a);
      else missing.push(label);
    }
    if (series.length === 0) return '';

    // 連動性は、相場の話で必ず出てくる2組（日米の長期金利、ドル円と米金利）に絞る
    const pairs = [];
    const pairOf = (x, y) => (byKey.get(x) && byKey.get(y) ? kit.analyzePair(byKey.get(x), byKey.get(y)) : null);
    for (const p of [pairOf('jgb_10y', '^TNX'), pairOf('USDJPY=X', '^TNX')]) if (p) pairs.push(p);

    const body = kit.formatDataSheet({ series, pairs, missing });
    if (!body) return '';

    // 「今週とくに動いた項目」をコードで決める。これが無いと、議題の無い回に数値を素通りして、
    // 政治や社会の一般論に流れてしまう
    const movers = series
      .map((a) => ({ a, score: _moveScore(a) }))
      .filter((m) => m.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 2)
      .map(({ a }) => {
        const d = a.changes.w1.diff;
        const sign = d >= 0 ? '+' : '−';
        const digits = a.unit === '%' ? 3 : Math.abs(d) >= 1000 ? 0 : 2;
        return `${a.label}（1週間で ${sign}${Math.abs(d).toFixed(digits)}${a.unit === '%' ? 'pt' : ''}）`;
      });

    return `${body}${movers.length > 0
      ? `\n\n■ 今週とくに動いた項目\n  ${movers.join(' ／ ')}` : ''}`;
  })();

  const text = await Promise.race([
    work.catch((e) => {
      getLogger().warn(`[StandingData] 組み立てに失敗（数値シートなしで進行）: ${e.message}`);
      return '';
    }),
    new Promise((resolve) => setTimeout(() => resolve(''), capMs)),
  ]);

  if (!text) return '';
  getLogger().info(`[StandingData] 定点観測シート ${text.length}字を解説コーナーへ供給`);
  return `▼ 定点観測の数値（公式データから取得し、変化・連動性はシステムが計算したもの）\n${text}`;
}

module.exports = { buildStandingDataSheet };
