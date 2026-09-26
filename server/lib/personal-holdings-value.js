/**
 * @file 保有している投資信託・株式の、今日の値動きを金額（円）に換算する
 *
 * 日々の騰落率（%）と、直近の資産スナップショット（finance-snapshots。資産の自動取り込みで作られる
 * 評価額のデータ）を掛け合わせて、「今日どれくらい動いたか」を概算する。
 *
 * スナップショットには保有口数が無く評価額しか分からないので、「評価額 × 今日の騰落率」は、
 * スナップショットの後に口数が変わっていない前提の近似値になる。スナップショットは長くても1週間前なので、
 * 放送で「だいたいこれくらい」と話すには十分な精度。プロンプトにも概算であることを明記する。
 *
 * ATTENTION: ドル建ての銘柄は、値動きだけでなく為替の動きも円建ての評価額を動かす。騰落率をそのまま
 * 掛けると、円安・円高のぶんがまるごと抜け落ちる（実測でドル円が1日 +0.77% 動いた日があり、
 * ドル建ての銘柄では無視できない差になる）。usdJpyPct を渡して掛け合わせること。
 *
 * 主な利用元: agent-system.js（金融コーナー）・lib/secretary-tools-reports.js（デイリーノート）
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

const secretaryStore = require('./secretary-store');
const financeImportStore = require('./finance-import-store');
const { getLogger } = require('../logger');

/**
 * 投資信託の基準価額は「1万口あたり」。株式は1株あたりなので割らない。
 *
 * ATTENTION: これを掛け違えると評価額が1万倍ずれる。下の _valuationFromQuantity は、求めた額が
 * スナップショットの評価額とかけ離れていたら採用しない（掛け違いを黙って納品しないため）。
 */
const FUND_UNITS_PER_PRICE = 10000;

/**
 * スナップショットの評価額と比べて、この倍率の範囲に収まっていれば数量からの計算を信用する。
 * スナップショットは最大1週間前なので、その間の値動きぶんの差は許す。
 */
const QUANTITY_SANITY_RANGE = [0.5, 2.0];

/**
 * 銘柄名を突き合わせるための形にそろえる。
 *
 * BUGFIX: 全角と半角の違いだけで照合が外れていた。管理画面には半角で登録されているのに、証券会社は
 * 全角で返す（「eMAXIS Slim米国株式(S&P500)」と「(S＆P500)」、「HSBC インド・インフラ」と「インド･インフラ」、
 * 「ヘルスケア&バイオ<健次>」と「ヘルスケア＆バイオ＜健次＞」）。この5件はどれも登録済みなのに
 * 金額換算から丸ごと抜け落ちており、合計で794万円ぶんが表に出ていなかった。
 * NFKC で全角を半角へそろえ、空白を除き、大文字小文字も無視する。
 *
 * @param {*} s 銘柄名
 * @returns {string} そろえた名前
 */
function _normalizeName(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * 監視銘柄（finance_watchlist.personal_holdings）に当たる、スナップショットの行を探す。
 *
 * 両者の名前の表記は完全には一致しない（楽天証券はティッカーが頭に付く、楽天・プラスのファンドは
 * 短い名前が後ろに重ねて付く、米国株は日本語の名前で入る）ので、4段階で照合する:
 *   1. ティッカーの一致（スナップショット側の ticker と、登録した symbol）
 *   2. 完全一致（全角・半角と空白をそろえてから比べる。_normalizeName 参照）
 *   3. 投資信託（kind: 'fund'）: スナップショットの名前が、登録した名前で始まる
 *      （例: 「…インデックス・ファンド」→「…インデックス・ファンド(楽天・プラス・オールカントリー)」）
 *   4. 株式（kind: 'stock'）: スナップショットの名前が、symbol から末尾の ".T" を除いたもの＋空白で始まる
 *      （例: "1557.T" → 「1557 SS SPDR S&P500」）
 *
 * BUGFIX: 1（ティッカー）を最初に見ること。名前だけで照合していたころ、楽天証券が日本語で持っている
 * 米国株（「エヌビディア」＝NVDA・「スペースX」＝SPCX）が、登録名「NVIDIA」「SpaceX」と一致せず
 * 金額換算から丸ごと抜け落ちていた（NVIDIA は174万円で、保有額の上位に入る）。
 *
 * 同じ銘柄が口座の区分（NISA など）ごとに複数行ある場合は、全部を返す（呼び出し側で合計する）。
 * @param {{name: string, kind?: string, symbol?: string}} item 監視銘柄
 * @param {Array<{fund: string, valuation?: number, ticker?: string}>} holdings スナップショットの保有一覧
 * @returns {Array<{fund: string, valuation?: number}>} 見つからなければ空
 */
function _matchSnapshotRows(item, holdings) {
  if (item.symbol) {
    const sym = item.symbol.replace(/\.T$/, '').toUpperCase();
    const byTicker = holdings.filter((h) => String(h.ticker || '').toUpperCase() === sym);
    if (byTicker.length > 0) return byTicker;
  }
  const want = _normalizeName(item.name);
  let rows = holdings.filter((h) => _normalizeName(h.fund) === want);
  if (rows.length > 0) return rows;
  if (item.kind === 'fund') {
    rows = holdings.filter((h) => _normalizeName(h.fund).startsWith(want));
    if (rows.length > 0) return rows;
  }
  if (item.kind === 'stock' && item.symbol) {
    const base = _normalizeName(item.symbol.replace(/\.T$/, ''));
    rows = holdings.filter((h) => _normalizeName(h.fund).startsWith(base));
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * 保有の明細をどこから読むかを決める。
 *
 * ブラウザ拡張の取り込み（finance-import-store）は、口座のページを開くたびに新しくなり、保有量まで
 * 入っている。週次のスナップショットは日曜に1回しか作られないので、取り込みがあればそちらを使う。
 *
 * ATTENTION: 取り込みが無い金融機関（画像から読んだ分）はスナップショットにしか無い。取り込みが
 * 1件も無いときだけスナップショットへ落ちる、という順番にしてある。
 *
 * @returns {{holdings: Array<any>, asOf: string|null, total: number}}
 */
function _loadHoldings() {
  const { fresh } = financeImportStore.readFreshImports();
  /** @type {any[]} */
  const records = Object.values(fresh);
  const imported = records.flatMap((r) => r.holdings || []);
  if (imported.length > 0) {
    const receivedAts = records.map((r) => r.receivedAt).filter(Boolean).sort();
    return {
      holdings: imported,
      asOf: receivedAts.length ? receivedAts[receivedAts.length - 1] : null,
      total: records.reduce((sum, r) => sum + (r.totalAssets || 0), 0),
    };
  }
  const snapshot = secretaryStore.listEntries('finance-snapshots', { limit: 1 })[0];
  return {
    holdings: snapshot?.holdings || [],
    asOf: snapshot?.time || null,
    total: snapshot?.totalAssets || 0,
  };
}

/**
 * 保有量（株数・口数）と今の値段から、評価額を円で求める。
 *
 * 数量が1行でも欠けていると合計が過小になるので、その場合は使わない（null を返して呼び出し側が
 * スナップショットの評価額へ落ちる）。
 *
 * @param {{name?: string, kind?: string}} item 監視銘柄
 * @param {Array<{valuation?: number, quantity?: number|null}>} rows スナップショットの該当行
 * @param {number} unitPrice 1株・1万口あたりの値段（その通貨のまま）
 * @param {number} fxRate 円に直す倍率（円建てなら1、ドル建てならドル円）
 * @returns {number|null} 円での評価額。数量が無い・値が不自然なら null
 */
function _valuationFromQuantity(item, rows, unitPrice, fxRate) {
  if (!(unitPrice > 0) || !(fxRate > 0)) return null;
  if (rows.some((r) => !(Number(r.quantity) > 0))) return null;
  const qty = rows.reduce((sum, r) => sum + Number(r.quantity), 0);
  const per = item.kind === 'fund' ? FUND_UNITS_PER_PRICE : 1;
  const value = (unitPrice * fxRate * qty) / per;
  if (!Number.isFinite(value) || value <= 0) return null;
  // 掛け違い（1万口あたりの扱い・通貨の取り違え）を検出する。スナップショットの評価額と桁が合わなければ使わない
  const snapshot = rows.reduce((sum, r) => sum + (r.valuation || 0), 0);
  if (snapshot > 0) {
    const ratio = value / snapshot;
    if (ratio < QUANTITY_SANITY_RANGE[0] || ratio > QUANTITY_SANITY_RANGE[1]) {
      getLogger().warn(`[Holdings] ${item.name || ''}: 数量からの評価額（${Math.round(value)}円）が`
        + `スナップショット（${Math.round(snapshot)}円）と離れているため、数量は使いません`);
      return null;
    }
  }
  return value;
}

/**
 * 保有銘柄ごとに、今日の評価額の変動を円で概算する。
 * @param {Record<string, any>} config config.json の内容
 * @param {Array<{key:string, kind?:string, pct:number, unit?:string, price:number, diff:number,
 *   stale?:boolean, asOf?:string|null}>} personalPriceItems
 *   今日の騰落率（financeService.cache.structured のうち type が 'personal' のもの）
 * @param {{usdJpyPct?: number, usdJpy?: number|null}} [opts]
 *   usdJpyPct はドル円の本日の騰落率（%）、usdJpy は本日のドル円。どちらもドル建ての銘柄に使う
 * @returns {Array<{name:string, kind:string, pct:number, yenPct:number, isUsd:boolean, basis:string,
 *   stale:boolean, asOf:string|null, valuation:number, estimatedYenChange:number,
 *   snapshotTime:string|null, snapshotTotal:number}>}
 *   直近のスナップショットに評価額が見つかった銘柄だけを、変動額の大きい順に返す。
 *   basis は 'quantity'（保有量と今の値段から計算）か 'snapshot'（評価額に騰落率を掛けた概算）
 */
function estimatePersonalHoldingsDailyChange(config, personalPriceItems, { usdJpyPct = 0, usdJpy = null } = {}) {
  if (!personalPriceItems || personalPriceItems.length === 0) return [];
  const { holdings, asOf: snapshotTime, total: snapshotTotal } = _loadHoldings();
  if (holdings.length === 0) return [];

  const priceByName = new Map(personalPriceItems.map((p) => [p.key, p]));
  const personalConfig = config?.finance_watchlist?.personal_holdings || [];

  const results = [];
  for (const item of personalConfig) {
    const price = priceByName.get(item.name);
    if (!price) continue;
    const rows = _matchSnapshotRows(item, holdings);
    if (rows.length === 0) continue;
    const valuation = rows.reduce((sum, r) => sum + (r.valuation || 0), 0);
    if (valuation <= 0) continue;
    // 円建ての騰落率。ドル建ての銘柄は、値動きと為替の動きの両方が効く（掛け合わせる。足し算ではない）
    const isUsd = (price.unit || item.unit || '円') !== '円';
    const yenPct = isUsd
      ? ((1 + price.pct / 100) * (1 + usdJpyPct / 100) - 1) * 100
      : price.pct;

    // 保有量が取れていれば、今の値段から評価額を出す（スナップショットの評価額より新しく、正確）。
    // 取れていなければ、これまでどおりスナップショットの評価額に騰落率を掛ける。
    const fxNow = isUsd ? (usdJpy || 0) : 1;
    const fxPrev = isUsd && usdJpy ? usdJpy / (1 + usdJpyPct / 100) : 1;
    const prevUnitPrice = price.price - (price.diff || 0);
    const todayValue = _valuationFromQuantity(item, rows, price.price, fxNow);
    const prevValue = todayValue == null ? null : _valuationFromQuantity(item, rows, prevUnitPrice, fxPrev);

    const useQuantity = todayValue != null && prevValue != null;
    // ATTENTION: 値段が取れずに前回の値へ落ちた銘柄は、本日の損益を0にすること。前回の値の前日比を
    //            そのまま使うと、動いていない日の値動きを本日のものとして合計してしまう。
    const isStale = !!price.stale;
    const baseValuation = useQuantity ? (isStale ? todayValue : prevValue) : valuation;
    const estimatedYenChange = isStale ? 0
      : useQuantity ? Math.round(todayValue - prevValue)
      : Math.round(valuation * (yenPct / 100));

    results.push({
      name: item.name, kind: item.kind, pct: price.pct, yenPct, isUsd,
      basis: useQuantity ? 'quantity' : 'snapshot',
      stale: isStale, asOf: price.asOf || null,
      valuation: baseValuation, estimatedYenChange, snapshotTime, snapshotTotal,
    });
  }
  results.sort((a, b) => Math.abs(b.estimatedYenChange) - Math.abs(a.estimatedYenChange));
  return results;
}

/**
 * プロンプトに埋め込む段落を作る（変動の大きい上位 topN 件）。
 *
 * ATTENTION: 円への換算はここで計算し、LLM には結果の数字だけを渡すこと。LLM に掛け算をさせると
 *            間違える（finance-service.js の前日比と同じ方針）。
 * @param {ReturnType<typeof estimatePersonalHoldingsDailyChange>} results
 * @param {number} [topN]
 * @returns {string} 結果が無ければ空文字
 */
function formatPersonalHoldingsChangeForPrompt(results, topN = 5) {
  if (!results || results.length === 0) return '';
  const lines = results.slice(0, topN).map((r) => {
    const pctStr = (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) + '%';
    const yenStr = (r.estimatedYenChange >= 0 ? '+' : '') + r.estimatedYenChange.toLocaleString('ja-JP');
    return `  ${r.name}: 直近評価額${Math.round(r.valuation).toLocaleString('ja-JP')}円 × 本日${pctStr} `
      + `→ 本日の評価額変動 概算${yenStr}円`;
  });
  return `■ 個人所有ファンド・株式の金額換算（直近の週次資産スナップショットとの概算）\n${lines.join('\n')}\n`
    + `【重要】上記は直近の週次資産スナップショット時点の評価額をもとにした概算です。保有口数の`
    + `変動（追加購入・売却）があった場合は実際の金額とズレます。この金額をそのまま使い、`
    + `自分で計算し直さないでください。`;
}

/**
 * デイリーノートに載せる表を作る（銘柄ごとの評価額と、本日の変動を円で）。
 *
 * ATTENTION: 数字はここで計算し切ること。表の組み立てを LLM に任せると掛け算を間違える
 * （finance-service.js の前日比・formatPersonalHoldingsChangeForPrompt と同じ方針）。
 * ATTENTION: Markdown の表の中に空行を入れないこと（Obsidian で表示が崩れる）。
 *
 * @param {ReturnType<typeof estimatePersonalHoldingsDailyChange>} results
 * @param {{usdJpy?: number|null}} [opts] usdJpy は換算に使ったドル円（表示用。無ければ触れない）
 * @returns {string} 結果が無ければ空文字
 */
function formatPersonalHoldingsTableForNote(results, { usdJpy = null } = {}) {
  if (!results || results.length === 0) return '';
  const yen = (/** @type {number} */ n) => Math.round(n).toLocaleString('ja-JP');
  const signed = (/** @type {number} */ n) => (n >= 0 ? '+' : '') + yen(n);
  const pctStr = (/** @type {number} */ n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

  // 評価額の大きい順に並べる（変動額の順だと、毎日並びが入れ替わって見比べにくい）
  const rows = [...results].sort((a, b) => b.valuation - a.valuation);
  const totalValuation = rows.reduce((s, r) => s + r.valuation, 0);
  const totalChange = rows.reduce((s, r) => s + r.estimatedYenChange, 0);
  // 率は、本日の値段が取れた銘柄だけを母数にする（取れなかった分を「変動0%」として薄めない）
  const movedValuation = rows.filter((r) => !r.stale).reduce((s, r) => s + r.valuation, 0);
  const totalPct = movedValuation > 0 ? (totalChange / movedValuation) * 100 : 0;
  const staleRows = rows.filter((r) => r.stale);

  const body = rows.map((r) => {
    if (r.stale) {
      // 本日の値段が取れなかった銘柄。評価額は出すが、損益は出さない（0を「変動なし」と読ませない）
      const when = String(r.asOf || '').slice(0, 10);
      return `| ${r.name} | ${yen(r.valuation)}円 | — | — | ${yen(r.valuation)}円 |`
        + (when ? '' : '');
    }
    // ドル建ては、値動きと為替を合わせた円建ての率も添える（なぜこの金額になるかが分かるように）
    const rate = r.isUsd ? `${pctStr(r.pct)}（円建て${pctStr(r.yenPct)}）` : pctStr(r.pct);
    return `| ${r.name} | ${yen(r.valuation)}円 | ${rate} | ${signed(r.estimatedYenChange)}円 | `
      + `${yen(r.valuation + r.estimatedYenChange)}円 |`;
  });

  const snapDate = rows[0]?.snapshotTime ? String(rows[0].snapshotTime).slice(0, 10) : null;
  // 保有量から計算できた銘柄と、評価額に騰落率を掛けただけの銘柄が混ざりうるので、内訳を添える
  const byQty = rows.filter((r) => r.basis === 'quantity').length;
  const fx = usdJpy ? `ドル建ては1ドル=${usdJpy.toFixed(2)}円で換算しています。` : '';
  const note = byQty === rows.length
    ? `保有量と本日の値段から計算しています。${fx}`
    : byQty > 0
      ? `${byQty}銘柄は保有量と本日の値段から、残りの${rows.length - byQty}銘柄は`
        + `${snapDate || '直近'}時点の評価額に本日の騰落率を掛けた仮計算です。${fx}`
      : `${snapDate ? `${snapDate}時点の評価額` : '直近の資産スナップショットの評価額'}に`
        + `本日の騰落率を掛けた仮計算です。${fx}`;
  // 監視に登録していない銘柄は表に出ない。合計を全資産と読み違えないよう、対象の範囲を添える
  const snapTotal = rows[0]?.snapshotTotal || 0;
  const coverage = snapTotal > totalValuation
    ? `この表は登録済みの${rows.length}銘柄ぶん（${yen(totalValuation)}円）が対象で、`
      + `資産全体（${yen(snapTotal)}円）のうち${yen(snapTotal - totalValuation)}円は含まれていません。`
    : '';

  return `### 📊 保有資産の本日の損益（概算）\n`
    + `| 銘柄名 | 評価額 | 本日の騰落率 | 本日の損益 | 本日の評価額 |\n`
    + `| --- | --- | --- | --- | --- |\n`
    + `${body.join('\n')}\n`
    + `| **合計** | **${yen(totalValuation)}円** | **${pctStr(totalPct)}** | `
    + `**${signed(totalChange)}円** | **${yen(totalValuation + totalChange)}円** |\n\n`
    + `> [!note] 概算です\n`
    + `> ${note}`
    + (byQty < rows.length
      ? '保有量が取れていない銘柄は、評価額を取り込んだ時点以降の売買や値動きのぶんがズレます。'
      : '')
    + `\n`
    + (staleRows.length > 0
      ? `> ${staleRows.length}銘柄は本日の値段を取得できなかったため、`
        + `${String(staleRows[0].asOf || '').slice(0, 10) || '前回'}時点の評価額のまま（損益は「—」）です。`
        + `合計の騰落率は、値段が取れた銘柄だけで計算しています。\n`
      : '')
    + (coverage ? `> ${coverage}\n` : '');
}

module.exports = {
  estimatePersonalHoldingsDailyChange,
  formatPersonalHoldingsChangeForPrompt,
  formatPersonalHoldingsTableForNote,
};
