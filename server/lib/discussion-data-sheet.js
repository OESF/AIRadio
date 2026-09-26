/**
 * @file 討論コーナーへ渡す「数値シート」（話題に合った統計・相場の推移と連動性）を組み立てる
 *
 * 固定の一覧を渡すと、金利の話には効いても医療や芸能の日には意味が無い。そこで2つに分ける。
 *   - 何を取るか: 話題を見て、軽量モデルがどの系列が要るかを選ぶ（LLM を使うのはここだけ）
 *   - どう取り、どう計算するか: コードが決まった手順で行う（market-data-kit.js。財務省・Yahoo・FRED）
 * 利用元は agent-discussion-corner.js。
 *
 * ATTENTION: モデルに系列の ID を書かせると、存在しない ID を作る。選ばせるのは一覧から選ぶキーと、
 *            検索用のキーワードだけにする。
 * 数値が無い話題（芸能・世間の空気など公的統計の無い分野）では空のシートを返す。無理に数字をひねり出すより、
 * 「数値は無い」と分かる方が議論が創作に流れない。
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
const { generateText } = require('./llm-client');
const kit = require('./market-data-kit');

// 選択肢に出す国債の年限（market-data-kit の JGB_TENORS と対応）
const JGB_CHOICES = [
  { key: 'jgb_2y', label: '日本国債2年利回り' },
  { key: 'jgb_5y', label: '日本国債5年利回り' },
  { key: 'jgb_10y', label: '日本国債10年利回り' },
  { key: 'jgb_20y', label: '日本国債20年利回り' },
  { key: 'jgb_30y', label: '日本国債30年利回り' },
];

const MAX_SERIES = 6;      // 1回の討論で取る系列の上限（長くなりすぎないように）
const MAX_KEYWORDS = 3;    // FRED をキーワードで探す回数の上限
const MAX_PAIRS = 3;       // 連動性を見る組み合わせの上限

/**
 * モデルに見せる「選べる系列」の一覧を作る。
 * 相場はリスナーのウォッチリスト（config.finance_watchlist）から作るので、管理画面で銘柄を足せばそのまま
 * 選択肢になる。個人の保有銘柄は放送の討論で扱うものではないので入れない。
 * @param {Record<string, any>} config Live の設定
 * @returns {Array<Record<string, any>>} key・label・kind・unit（相場は symbol も）
 */
function buildCatalog(config) {
  const out = [];
  for (const c of JGB_CHOICES) out.push({ key: c.key, label: c.label, kind: 'jgb', unit: '%' });
  const wl = config?.finance_watchlist || {};
  for (const group of ['indices', 'forex', 'bonds', 'commodities', 'stocks']) {
    for (const e of wl[group] || []) {
      if (!e?.symbol || !e?.name) continue;
      // 国債の利回りは財務省の履歴を使うので、ウォッチリストの同じ項目は出さない
      if (/^\^JGBY/.test(e.symbol)) continue;
      out.push({ key: `mkt:${e.symbol}`, label: e.name, kind: 'market', unit: e.unit === '%' ? '%' : '', symbol: e.symbol });
    }
  }
  return out;
}

/**
 * 話題に対して、どの数値が要るかを決める（LLM を使うのはここだけ）。
 * 一覧に無いキーや多すぎる指定は、ここで捨てる。
 * @param {{ apiKey: string, topic: string, sourceText?: string, cornerTheme?: string,
 *   catalog: Array<Record<string, any>>, activitySessionId?: any }} opts
 * @returns {Promise<Record<string, any>|null>} needed・seriesKeys・fredKeywords・pairs・researchKind・reason。
 *   JSON を読めなければ null
 */
async function planDataNeeds({ apiKey, topic, sourceText, cornerTheme, catalog, activitySessionId }) {
  const list = catalog.map(c => `- ${c.key}: ${c.label}`).join('\n');
  const systemInstruction = 'あなたは報道番組のデータ担当です。これから行う討論に必要な数値データを選びます。'
    + '選ぶのは「議論の根拠になる数字」だけで、話題と関係の薄い系列は選ばないでください。'
    + '公的統計や相場の数字が存在しない話題（芸能・世間の空気・個別の事件など）では、'
    + '無理に選ばず needed を false にしてください。';
  const prompt = `【討論のテーマ】${cornerTheme}
【深掘りする話題】${topic}
【直前に放送された内容（抜粋）】
${(sourceText || '').slice(0, 1200)}

【選べる系列（この一覧のキーだけを使うこと。一覧に無いキーを作らないこと）】
${list}

【FRED（米セントルイス連銀の統計データベース）】
一覧に無い統計は、英語のキーワードを書けばシステムが検索して取得します（最大${MAX_KEYWORDS}件）。
各国の政策金利・物価・雇用・住宅・生産などが揃っています。
例: "Japan consumer price index", "Federal funds effective rate", "US 10-year treasury constant maturity"

【連動性を見る組み合わせ】
「AとBがどれくらい一緒に動いているか」を知りたい組を最大${MAX_PAIRS}件挙げてください。
各要素は上の一覧のキー、またはあなたが書いたFREDキーワードのどちらかです。

【追加の取材】この話題が相場・経済に関わるものなら research_kind を "market"、
それ以外の出来事なら "event"、どちらも要らなければ "none" にしてください。

以下のJSONのみで出力してください:
{
  "needed": true または false,
  "series_keys": ["一覧のキー", ...],
  "fred_keywords": ["英語のキーワード", ...],
  "pairs": [["キーまたはキーワード", "キーまたはキーワード"], ...],
  "research_kind": "market" | "event" | "none",
  "reason": "なぜこの数値が要るのかを1文で"
}`;

  const { text } = await generateText({
    tier: 'secretary_light',
    apiKey,
    systemInstruction,
    prompt,
    temperature: 0,
    json: true,
    thinkingBudget: 0,
    agentKey: 'discussion_data_plan',
    activitySessionId,
    logMeta: { purpose: 'discussion_data_plan' },
  });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    getLogger().warn(`[DataSheet] 計画のJSON解析に失敗: ${e.message}`);
    return null;
  }
  const keys = new Set(catalog.map(c => c.key));
  return {
    needed: parsed.needed !== false,
    seriesKeys: (Array.isArray(parsed.series_keys) ? parsed.series_keys : []).filter(k => keys.has(k)).slice(0, MAX_SERIES),
    fredKeywords: (Array.isArray(parsed.fred_keywords) ? parsed.fred_keywords : [])
      .filter(k => typeof k === 'string' && k.trim()).map(k => k.trim()).slice(0, MAX_KEYWORDS),
    pairs: (Array.isArray(parsed.pairs) ? parsed.pairs : [])
      .filter(p => Array.isArray(p) && p.length === 2).slice(0, MAX_PAIRS),
    researchKind: ['market', 'event', 'none'].includes(parsed.research_kind) ? parsed.research_kind : 'event',
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
  };
}

/**
 * 計画に沿って系列を取得する。1つ失敗しても他は続ける。
 * @param {{ plan: Record<string, any>, catalog: Array<Record<string, any>>, fredApiKey?: string }} opts
 * @returns {Promise<{ byKey: Map<string, any>, missing: any[] }>} 取れた系列と、取れなかったものの名前
 */
async function fetchPlannedSeries({ plan, catalog, fredApiKey }) {
  const byKey = new Map();         // キーから取得できた系列へ
  const missing = [];

  const jgbKeys = plan.seriesKeys.filter(k => k.startsWith('jgb_'));
  if (jgbKeys.length > 0) {
    try {
      const jgb = await kit.getJgbSeries();
      for (const k of jgbKeys) {
        if (jgb[k]) byKey.set(k, jgb[k]);
        else missing.push(catalog.find(c => c.key === k)?.label || k);
      }
    } catch (e) {
      getLogger().warn(`[DataSheet] 国債利回りの取得に失敗: ${e.message}`);
      for (const k of jgbKeys) missing.push(catalog.find(c => c.key === k)?.label || k);
    }
  }

  await Promise.all(plan.seriesKeys.filter(k => k.startsWith('mkt:')).map(async (k) => {
    const c = catalog.find(x => x.key === k);
    if (!c) return;
    try {
      byKey.set(k, await kit.getYahooSeries(c.symbol, { label: c.label, unit: c.unit }));
    } catch (e) {
      getLogger().warn(`[DataSheet] ${c.label} の履歴取得に失敗: ${e.message}`);
      missing.push(c.label);
    }
  }));

  await Promise.all(plan.fredKeywords.map(async (kw) => {
    if (!fredApiKey) { missing.push(`${kw}（FREDの鍵が未設定）`); return; }
    try {
      const found = await kit.searchFredSeries(fredApiKey, kw);
      if (!found) { missing.push(kw); return; }
      const series = await kit.getFredSeries(fredApiKey, found.id, {
        label: `${found.title}${found.frequency ? `（${found.frequency}）` : ''}`,
        unit: /percent|%/i.test(found.unit) ? '%' : '',
      });
      if (series.points.length === 0) { missing.push(kw); return; }
      byKey.set(kw, series);
    } catch (e) {
      getLogger().warn(`[DataSheet] FRED「${kw}」の取得に失敗: ${e.message}`);
      missing.push(kw);
    }
  }));

  return { byKey, missing };
}

/**
 * 討論で全員が共有する数値シートを組み立てる。
 * @param {{ topic: string, sourceText?: string, cornerTheme?: string, config: Record<string, any>,
 *   creds: Record<string, any>, activitySessionId?: any }} opts
 * @returns {Promise<{text: string, researchKind: string, reason: string, seriesCount: number}|null>}
 *   数値が無い話題なら text は空文字。判断に失敗したら null
 */
async function buildDiscussionDataSheet({ topic, sourceText, cornerTheme, config, creds, activitySessionId = null }) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey || !topic) return null;
  const catalog = buildCatalog(config);

  let plan;
  try {
    plan = await planDataNeeds({ apiKey, topic, sourceText, cornerTheme, catalog, activitySessionId });
  } catch (e) {
    getLogger().warn(`[DataSheet] 必要な数値の判断に失敗（数値シートなしで進行）: ${e.message}`);
    return null;
  }
  if (!plan) return null;
  if (!plan.needed || (plan.seriesKeys.length === 0 && plan.fredKeywords.length === 0)) {
    getLogger().info(`[DataSheet] この話題に渡せる数値はありませんでした（${plan.reason || '理由なし'}）`);
    return { text: '', researchKind: plan.researchKind, reason: plan.reason, seriesCount: 0 };
  }

  const { byKey, missing } = await fetchPlannedSeries({ plan, catalog, fredApiKey: creds?.fred?.api_key });

  const analyzed = [];
  for (const s of byKey.values()) {
    const a = kit.analyzeSeries(s);
    if (a) analyzed.push(a);
  }
  const pairs = [];
  for (const [x, y] of plan.pairs) {
    const a = byKey.get(x); const b = byKey.get(y);
    if (a && b && a !== b) pairs.push(kit.analyzePair(a, b));
  }

  const body = kit.formatDataSheet({ series: analyzed, pairs, missing });
  const text = body
    ? `▼ 数値データ（公式データから取得し、変化・連動性はシステムが計算したもの）\n${body}`
    : '';
  getLogger().info(`[DataSheet] 数値シート: 系列${analyzed.length}件 / 連動性${pairs.length}組 / ${text.length}字`
    + `${plan.reason ? `（${plan.reason}）` : ''}`);
  return { text, researchKind: plan.researchKind, reason: plan.reason, seriesCount: analyzed.length };
}

module.exports = { buildDiscussionDataSheet, buildCatalog, planDataNeeds, fetchPlannedSeries };
