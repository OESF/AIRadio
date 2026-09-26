/**
 * @file 秘書の資産（金融）まわりの道具
 *
 * 秘書の道具のうち、資産（金融）にかかわるものをまとめたもの。週次の資産レポートの作成
 * （updateFinanceReport）と、会話の中で資産について答えるためのデータ取得・ヒートマップ作成。
 *
 * データの流れ:
 *   - 数字の出どころは、ブラウザ拡張から届いた取り込みデータ（lib/finance-import-store.js）を
 *     最優先し、届いていない金融機関だけ画像の読み取りに回す。
 *   - 読み取った1回分は secretary-store の finance-snapshots へ追記する（消さない・上書きしない）。
 *   - 長期の推移は、設定された資産台帳（スプレッドシート）から読む。
 *   - 出来上がったレポートは Obsidian の週次ノートの資産の節へ書き込む。
 *
 * ATTENTION: 並べ替え・集計・率の計算・図の配置は、すべてこのファイルの中でコードが行うこと。
 * 言語モデルに暗算や並べ替えをさせると、実在しない数値や銘柄名を作る。過去に実際に起きている。
 *
 * ATTENTION: 比較の相手は必ず週をまたいで選ぶこと（_findPreviousWeekSnapshot）。同じ週の記録を
 * 相手にすると、対前週比が全銘柄0%になり、ヒートマップの色も消える。
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

const { generateText, imagePart } = require('./llm-client');
const obsidianService = require('../services/obsidian-service');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const secretaryStore = require('./secretary-store');
const financeImportStore = require('./finance-import-store');

// 取り込んだデータを「古い」とみなす日数。週1回の運用なら必ず収まるが、1回飛ばせば超える。
// ATTENTION: 古くても使うのをやめないこと。代わりにレポートへ時点を書いて気づけるようにする。
const STALE_IMPORT_DAYS = 8;
const secretaryMemory = require('./secretary-memory');
const { datesForWeekEndingOn } = require('./secretary-weekly-note-formatting');
const { _requireObsidian } = require('./secretary-tools-obsidian');
const { wrapDataForSpeechGuidance, googleService, buildCenterOverview } = require('./secretary-tools-services');
const { normalizeLargeNumbersForSpeech } = require('./number-speech-format');

// 円グラフに個別で出す銘柄数の上限（超えた分は「その他」へまとめる）。
// ATTENTION: 全件を出さないこと。保有は30件以上あり、そのまま出すと読み取れない図になる。
const FINANCE_PIE_TOP_N = 8;

/**
 * 銘柄の騰落率（買ったときからの通算の損益率）を求める。
 *
 * 評価金額は「取得元本＋評価損益」なので、元本は評価金額から評価損益を引けば逆算できる。
 * ATTENTION: 評価金額ではなく取得元本に対する割合にすること。証券会社の画面が表示する
 * 「評価損益(%)」と同じ定義（投資額に対する戻り）に合わせるため。
 *
 * @param {any} valuation 評価金額
 * @param {any} gainLoss 評価損益
 * @returns {any} 騰落率（%）。元本が0以下・損益が不明なら null
 */
function _financeGainLossRatePct(valuation, gainLoss) {
  if (typeof valuation !== 'number' || typeof gainLoss !== 'number') return null;
  const cost = valuation - gainLoss;
  if (cost <= 0) return null;
  return (gainLoss / cost) * 100;
}

/**
 * 2つの時点を比べた変化率を求める。騰落率が買ったときからの通算なのに対し、こちらは単純な
 * 期間の比較（前週比・複数週の推移）に使う。
 *
 * @param {any} current 今の値
 * @param {any} previous 前の値
 * @returns {any} 変化率（%）。計算できなければ null
 */
function _periodChangePct(current, previous) {
  if (typeof current !== 'number' || typeof previous !== 'number' || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * 保有の1行を前週の同じ行と突き合わせるための鍵。
 * ATTENTION: 銘柄名だけでは一意にならない。同じ銘柄を口座区分違いで複数持っている場合が
 * あるため、金融機関・銘柄・口座区分の3つを組にすること。
 *
 * @param {any} h 保有の1件
 * @returns {string} 突き合わせ用の鍵
 */
function _holdingIdentityKey(h) {
  return [h.institution, h.fund, h.accountType].map(_normalizeHoldingName).join('\u0000');
}

/**
 * 銘柄名・口座名を突き合わせ用に整える。全角と半角をそろえ、空白を落とし、大文字小文字を無視する。
 *
 * BUGFIX: 素朴に文字列を比べてはいけない。読み取りの元によって全角・半角の書き方が揺れるため、
 * 同じ銘柄が「前週から消えた」と「今週の新規」の2件に割れる。持ち続けている銘柄が毎週
 * 「新規」と表示される状態になっていた。
 *
 * @param {any} s 整える文字列
 * @returns {string} 整えた文字列
 */
function _normalizeHoldingName(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * 今週の保有を、前週の同じ銘柄と結び付ける。
 *
 * BUGFIX: 厳密な一致だけで結んではいけない。データの出どころが切り替わると、銘柄名の書き方も
 * 口座区分の書き方も変わる。38件中5件しか結べず、残りが「前週比なし」になってヒートマップから
 * 黙って落ちた（全資産のはずが一部の投信だけになっていた）。
 *
 * 2段で結ぶ。1段目は厳密な一致で、取り違えの余地が無いものを先に確定する。2段目は書き方の
 * 揺れを許す一致だが、ATTENTION: 両側で候補が1つに定まるときだけ結ぶこと。複数あるときに
 * 結ぶと取り違える。
 *
 * @param {any[]} currentHoldings 今週の保有
 * @param {any[]} previousHoldings 前週の保有
 * @returns {any} 今週の保有から前週の保有への対応（見つからないものは入らない）
 */
function matchHoldingsAcrossWeeks(currentHoldings, previousHoldings) {
  const pairs = new Map();
  const prevLeft = [...(previousHoldings || [])];
  const cur = currentHoldings || [];

  for (const h of cur) {
    const key = _holdingIdentityKey(h);
    const i = prevLeft.findIndex((p) => _holdingIdentityKey(p) === key);
    if (i >= 0) { pairs.set(h, prevLeft[i]); prevLeft.splice(i, 1); }
  }

  const same = (h, p) => _normalizeHoldingName(h.institution) === _normalizeHoldingName(p.institution)
    && _accountTypeKey(h.accountType) === _accountTypeKey(p.accountType)
    && _sameHoldingName(h.fund, p.fund);
  for (const h of cur.filter((x) => !pairs.has(x))) {
    const cands = prevLeft.filter((p) => same(h, p));
    if (cands.length !== 1) continue;
    // 今週側にも同じ前週の銘柄を指す候補が他にあれば、どちらとも結ばない（取り違えを防ぐ）
    const rivals = cur.filter((o) => o !== h && !pairs.has(o) && same(o, cands[0]));
    if (rivals.length > 0) continue;
    pairs.set(h, cands[0]);
    prevLeft.splice(prevLeft.indexOf(cands[0]), 1);
  }
  return pairs;
}

/**
 * 口座区分を比べるための鍵。分配方法の前置きだけを落とす。
 * ATTENTION: 枠の区分（つみたて投資・成長投資）は落とさないこと。同じ投信を複数の枠で
 * 持っている場合があり、ここを潰すと別口座の同名銘柄が1つに重なって結べなくなる。
 *
 * @param {any} a 口座区分の文字列
 * @returns {string} 比較用の鍵
 */
function _accountTypeKey(a) {
  const s = _normalizeHoldingName(a).replace(/^(再投資|分配)/, '');
  return (!s || s === '-' || s === 'null') ? 'none' : s;
}

/**
 * 2つの銘柄名が同じものを指すか判定する。「記号＋名前」と「名前」の関係だけを同じとみなす。
 * ATTENTION: 先頭の短い語を無条件に落とす方式は採らないこと。名前の一部まで削ってしまい、
 * かえって一致しなくなる。
 *
 * @param {any} a 一方の銘柄名
 * @param {any} b もう一方の銘柄名
 * @returns {boolean} 同じものを指すなら true
 */
function _sameHoldingName(a, b) {
  const x = _normalizeHoldingName(a);
  const y = _normalizeHoldingName(b);
  if (x === y) return true;
  const [long, short] = x.length > y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.endsWith(short)
    && /^[a-z0-9]{1,6}$/.test(long.slice(0, long.length - short.length));
}

/**
 * 推移データに「計算・作図に使う生の数値」を添える。
 *
 * BUGFIX: 読み上げ用の表記だけを渡してはいけない。声で自然に読めるよう「万」を使った表記へ
 * 変換しているが、下4桁の先頭に0があると桁が曖昧になり、同じ戻り値を計算や作図に使う側が
 * 桁を取り違える。実際に資産推移のグラフが、右肩上がりのはずが右肩下がりに見えた。
 *
 * ATTENTION: このかたまりは、読み上げ向けの変換の外でつなぐこと。中に入れるとここまで
 * 「万」表記へ変換されて元も子もない。
 *
 * @param {any[]} series 日付と値の並び
 * @returns {string} 添えるかたまり
 */
function _rawSeriesBlock(series) {
  return '\n\n【計算・作図用の生データ（円単位・区切り記号なし）】\n'
    + '⚠️ グラフや計算には**必ずこちらの数値を使ってください**。上の読み上げ用の表記'
    + '（「2659万622円」のような万表記）から桁を復元しようとしないでください。\n'
    + series.map((p) => `${p.date}\t${p.value}`).join('\n');
}

/**
 * 資産台帳から読んだ推移を、推移取得の道具と同じ形の回答文へ整える。
 *
 * 台帳は週次より細かく長い（2年近い）ため、新しい側から上限ぶんだけ取り、並びは古い順で返す。
 * ATTENTION: 前回比の金額と率は、すべてここで計算してから渡すこと。
 *
 * @param {any} ledger 台帳から読んだ口座名と各時点の値
 * @param {number} limit 返す点の最大数
 * @returns {any} 回答文。2点未満しか無ければ null（呼び出し元が別の出どころへ落ちる）
 */
function _formatLedgerHistory(ledger, limit) {
  // ATTENTION: 台帳には口座ごとの列に加えて「合計」の列がある。全部足すと合計を二重に
  // 数えて、ちょうど2倍の値になる。合計の列があるときはそれを正とし、無いときだけ足し合わせる。
  const _sumAccounts = ledger.accounts.filter((a) => !/^(合計|総計|計)$/.test(String(a).trim()));
  const _totalCol = ledger.accounts.find((a) => /^(合計|総計|計)$/.test(String(a).trim())) || null;
  const total = (pt) => (_totalCol && typeof pt.values[_totalCol] === 'number')
    ? pt.values[_totalCol]
    : _sumAccounts.reduce((sum, a) => sum + (typeof pt.values[a] === 'number' ? pt.values[a] : 0), 0);
  const points = ledger.points.filter((pt) => total(pt) > 0).slice(-Math.max(2, limit));
  if (points.length < 2) return null;

  const yen = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP') + '円' : '不明');
  const lines = [];
  lines.push(`【資産台帳（スプレッドシート）の推移データ ${points.length}件です】`);
  points.forEach((pt, i) => {
    const cur = total(pt);
    const prev = i > 0 ? total(points[i - 1]) : null;
    const pct = prev ? _periodChangePct(cur, prev) : null;
    const diff = prev != null ? cur - prev : null;
    const changeStr = pct != null
      ? `（前回比 ${diff >= 0 ? '+' : ''}${diff.toLocaleString('ja-JP')}円／${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）`
      : '（この期間の最初の記録）';
    lines.push(`- ${pt.date}: 資産合計${yen(cur)} ${changeStr}`);
  });
  const totalPct = _periodChangePct(total(points[points.length - 1]), total(points[0]));
  if (totalPct != null) {
    lines.push('');
    lines.push(`${points[0].date}から${points[points.length - 1].date}までの合計変化率: `
      + `${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`);
  }
  lines.push('');
  lines.push('【重要】上に列挙した日付・数値がこのデータの全てです。ここに無い日付・数値を作らないで'
    + 'ください。グラフ化を求められた場合は、この日付・資産合計の値だけを使って構いません。');

  secretaryStore.appendEntry('daily-briefings', { tool: 'get_finance_history', result: '資産台帳から推移データを返しました。' });
  return {
    result: wrapDataForSpeechGuidance(lines.join('\n'))
      + _rawSeriesBlock(points.map((pt) => ({ date: pt.date, value: total(pt) }))),
  };
}

/**
 * 資産合計の推移を折れ線グラフとして組み立てる。
 * 直近12件に絞るのは、それより古い点まで含めると横軸のラベルが密集して読みにくいため
 * （記録そのものは全期間残るので、絞るのは表示上の都合だけ）。
 *
 * @param {any[]} points 日付と資産合計の並び
 * @returns {any} 図の記法。2点未満なら null
 */
function _buildFinanceTrendChart(points) {
  if (!points || points.length < 2) return null;
  const recent = points.slice(-12);
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const labels = recent.map((p) => `"${fmtDate(p.date)}"`).join(', ');
  const values = recent.map((p) => Math.round(p.totalAssets));
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  // 変化が小さいとグラフが横一線に潰れて見えるため、上下に少し余白を持たせる
  const margin = Math.max(Math.round((maxV - minV) * 0.15), Math.round(maxV * 0.02), 1);
  const yMin = Math.max(0, minV - margin);
  const yMax = maxV + margin;
  const lines = [
    '```mermaid',
    '%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "#ffb385, #ff6b35"}}}}%%',
    'xychart-beta',
    '    title "資産合計の推移"',
    `    x-axis [${labels}]`,
    `    y-axis "円" ${yMin} --> ${yMax}`,
    `    line [${values.join(', ')}]`,
    '```',
  ];
  return lines.join('\n');
}

/**
 * 保有の評価金額を円グラフとして組み立てる。
 * ATTENTION: 円グラフでは銘柄名で合算すること。同じ銘柄を複数の金融機関・口座区分で
 * 持っている場合がある。一方、表の側は内訳を保つため合算しない（役割を分けている）。
 *
 * @param {any[]} holdings 保有の一覧
 * @returns {any} 図の記法。描けなければ null
 */
function _buildFinancePieChart(holdings) {
  if (!holdings || holdings.length === 0) return null;
  const merged = new Map();
  for (const h of holdings) {
    if (typeof h.valuation !== 'number' || !h.fund) continue;
    merged.set(h.fund, (merged.get(h.fund) || 0) + h.valuation);
  }
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;

  const rows = sorted.slice(0, FINANCE_PIE_TOP_N);
  const restSum = sorted.slice(FINANCE_PIE_TOP_N).reduce((sum, [, v]) => sum + v, 0);
  if (restSum > 0) rows.push(['その他', restSum]);

  // ラベルは二重引用符で囲まれるため、名前に含まれる二重引用符は単引用符へ置き換える
  const escapeLabel = (s) => s.replace(/"/g, "'");
  const lines = ['```mermaid', 'pie showData', '    title 資産ポートフォリオ'];
  for (const [label, value] of rows) {
    lines.push(`    "${escapeLabel(label)}" : ${Math.round(value)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * 資産台帳（スプレッドシート）から、口座ごとの評価額の長期の推移を読む。
 *
 * 1行目が口座のまとまりの見出し、2行目が各まとまりの項目名、という構造を前提に、
 * 「時価評価額」の列を見出しから探す。
 * ATTENTION: 列の位置を決め打ちしないこと。シートの列順を変えられても壊れないようにする。
 * ATTENTION: 読み取りに言語モデルを使わないこと。
 *
 * @param {any} config 設定（台帳の URL を持つ）
 * @param {any} creds 認証情報
 * @returns {Promise<any>} 口座名の一覧と各時点の値。読めなければ null
 */
async function _fetchAssetLedgerHistory(config, creds) {
  const url = (config.obsidian?.asset_ledger_sheet_url || '').trim();
  if (!url) return null;
  const m = /\/d\/([a-zA-Z0-9-_]+)/.exec(url);
  if (!m) return null;
  const gidMatch = /[?&#]gid=(\d+)/.exec(url);
  let sheet;
  try {
    sheet = await googleService.fetchSpreadsheetValues(creds, { spreadsheetId: m[1], gid: gidMatch ? gidMatch[1] : undefined });
  } catch (e) {
    getLogger().warn(`[Secretary] 資産台帳の読み取りに失敗（推移の共有はスキップ）: ${e.message}`);
    return null;
  }
  const rows = sheet.rows || [];
  if (rows.length < 3) return null;

  // 1行目の見出しから「どの列からどの口座が始まるか」を拾い、2行目でその範囲の
  // 「時価評価額」の列を特定する
  const groupRow = rows[0] || [];
  const itemRow = rows[1] || [];
  const starts = [];
  groupRow.forEach((v, i) => { if (i > 0 && String(v || '').trim()) starts.push({ name: String(v).trim(), col: i }); });
  const accounts = [];
  for (let g = 0; g < starts.length; g++) {
    const from = starts[g].col;
    const to = g + 1 < starts.length ? starts[g + 1].col : itemRow.length;
    for (let c = from; c < to; c++) {
      if (String(itemRow[c] || '').replace(/\s/g, '') === '時価評価額') {
        accounts.push({ name: starts[g].name, col: c });
        break;
      }
    }
  }
  if (accounts.length === 0) return null;

  const num = (s) => {
    const n = Number(String(s ?? '').replace(/[,\s¥円]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const points = [];
  for (const row of rows.slice(2)) {
    const date = String(row[0] || '').trim();
    if (!/\d{4}\/\d{1,2}\/\d{1,2}/.test(date)) continue;
    const values = {};
    let any = false;
    for (const a of accounts) {
      const v = num(row[a.col]);
      if (v != null) { values[a.name] = v; any = true; }
    }
    if (any) points.push({ date, values });
  }
  if (points.length === 0) return null;
  return { accounts: accounts.map(a => a.name), points };
}

/**
 * 推移から、口座ごとの主な指標（期間・増減・期間中の最大の下げ幅）を求める。
 *
 * @param {any} history 台帳から読んだ推移
 * @returns {any[]} 口座ごとの指標
 */
function _summarizeLedgerStats(history) {
  if (!history) return [];
  const out = [];
  for (const name of history.accounts) {
    const series = history.points.filter(p => p.values[name] != null);
    if (series.length < 2) continue;
    const first = series[0], last = series[series.length - 1];
    let peak = -Infinity, worst = 0, worstDate = null;
    for (const p of series) {
      const v = p.values[name];
      if (v > peak) peak = v;
      const dd = (v - peak) / peak * 100;
      if (dd < worst) { worst = dd; worstDate = p.date; }
    }
    out.push({
      account: name,
      from: first.date, to: last.date,
      firstValue: first.values[name], lastValue: last.values[name],
      changePct: _periodChangePct(last.values[name], first.values[name]),
      maxDrawdownPct: worst, maxDrawdownDate: worstDate,
      points: series.length,
    });
  }
  return out;
}

/**
 * 口座区分の文字列から、非課税制度の枠の区分を判定する。
 * ATTENTION: この分類を言語モデルに毎回読み取らせないこと。枠の名前は制度上の用語で
 * 金融機関に依らないため、コードで判定できる。
 *
 * @param {any} accountType 口座区分の文字列
 * @returns {any} 枠の名前。対象外なら null
 */
function _classifyNisaQuota(accountType) {
  const s = accountType || '';
  if (s.includes('つみたて投資')) return 'つみたて投資枠';
  if (s.includes('成長投資')) return '成長投資枠';
  if (s.includes('NISA')) return '旧NISA（枠区分なし）';
  return null; // 非課税制度の枠以外は対象外
}

/**
 * 保有を非課税制度の枠の区分ごとに集計する。
 *
 * @param {any[]} holdings 保有の一覧
 * @returns {any} 枠ごとの合計と銘柄。該当が無ければ null
 */
function _buildNisaQuotaSummary(holdings) {
  const groups = new Map();
  for (const h of holdings || []) {
    const label = _classifyNisaQuota(h.accountType);
    if (!label || typeof h.valuation !== 'number') continue;
    if (!groups.has(label)) groups.set(label, { sum: 0, funds: [] });
    const g = groups.get(label);
    g.sum += h.valuation;
    g.funds.push({ fund: h.fund, institution: h.institution, valuation: h.valuation });
  }
  if (groups.size === 0) return null;
  const order = ['成長投資枠', 'つみたて投資枠', '旧NISA（枠区分なし）'];
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([label, { sum, funds }]) => ({
      label, sum, funds: funds.sort((a, b) => b.valuation - a.valuation),
    }));
}

/**
 * 資産クラスごとの構成比を求める。金額そのものは返さず、割合と銘柄名だけにする。
 * 種別が空のものは「未分類」としてまとめる。
 *
 * @param {any[]} holdings 保有の一覧
 * @returns {any} 構成比と説明文。求められなければ null
 */
function _buildFinanceCompositionSummary(holdings) {
  if (!holdings || holdings.length === 0) return null;
  const classified = holdings.filter((h) => typeof h.valuation === 'number');
  if (classified.length === 0) return null;

  const total = classified.reduce((sum, h) => sum + h.valuation, 0);
  if (total <= 0) return null;

  const byClass = new Map();
  for (const h of classified) {
    const cls = (h.assetClass || '').trim() || '未分類';
    if (!byClass.has(cls)) byClass.set(cls, { sum: 0, funds: new Set() });
    const entry = byClass.get(cls);
    entry.sum += h.valuation;
    if (h.fund) entry.funds.add(h.fund);
  }

  const classes = [...byClass.entries()]
    .map(([assetClass, { sum, funds }]) => ({
      assetClass,
      pct: Math.round((sum / total) * 100),
      funds: [...funds],
    }))
    .sort((a, b) => b.pct - a.pct);

  const text = `資産クラス別の構成比: ${classes.map((c) => `${c.assetClass} ${c.pct}%（${c.funds.join('・') || '銘柄名不明'}）`).join('、')}`;

  return { classes, text, generatedAt: new Date().toISOString() };
}

/**
 * 放送側の専門家へ共有する資産データ一式を組み立てる。
 *
 * 含めるのは、資産合計と評価損益、保有銘柄の全件（金融機関・口座区分・評価額・損益・騰落率）、
 * 資産クラスごとの構成比、台帳から読んだ長期の推移の要約と月ごとの抜き出し。
 * 構成比と銘柄名だけを共有していた頃は「投資信託が多いですね」程度の浅い話にしかならなかった
 * ため、金額も含めて共有する。
 *
 * @param {any} opts holdings・totalAssets・totalGainLoss・history
 * @returns {any} 共有するデータ一式。組み立てられなければ null
 */
function _buildFinancePublicSummary({ holdings, totalAssets, totalGainLoss, history }) {
  const composition = _buildFinanceCompositionSummary(holdings);
  if (!composition) return null;

  const yen = (n) => (typeof n === 'number' ? `${n.toLocaleString('ja-JP')}円` : '不明');
  const pct = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

  const lines = [];
  lines.push(`【資産の全体像】資産合計 ${yen(totalAssets)}`
    + (totalGainLoss != null ? ` / 評価損益合計 ${yen(totalGainLoss)}` : ''));
  lines.push('');
  lines.push(`【資産クラス別の構成比】${composition.classes.map(c => `${c.assetClass} ${c.pct}%`).join(' / ')}`);
  lines.push('');
  lines.push('【保有銘柄の全件】（金融機関／口座区分／評価額／評価損益／騰落率）');
  const sorted = [...holdings]
    .filter(h => typeof h.valuation === 'number')
    .sort((a, b) => b.valuation - a.valuation);
  for (const h of sorted) {
    lines.push(`・${h.fund}｜${h.institution || '不明'}／${h.accountType || '区分不明'}`
      + `／${yen(h.valuation)}／${h.gainLoss != null ? yen(h.gainLoss) : '不明'}`
      + `／${pct(_financeGainLossRatePct(h.valuation, h.gainLoss))}`);
  }

  const stats = _summarizeLedgerStats(history);
  if (stats.length > 0) {
    lines.push('');
    lines.push('【長期の推移（ご本人の資産台帳より）】');
    for (const s of stats) {
      lines.push(`・${s.account}: ${s.from}〜${s.to}（${s.points}週分）`
        + ` ${yen(s.firstValue)} → ${yen(s.lastValue)}（${pct(s.changePct)}）`
        + ` / 期間中の最大ドローダウン ${pct(s.maxDrawdownPct)}（${s.maxDrawdownDate}）`);
    }
    // 全週分を載せると渡す量が膨らむため、月の最初の1点だけを拾って形が分かるようにする
    const monthly = [];
    let lastKey = '';
    for (const p of history.points) {
      const key = p.date.slice(0, p.date.lastIndexOf('/'));
      if (key !== lastKey) { monthly.push(p); lastKey = key; }
    }
    const tail = monthly.slice(-24);
    lines.push('');
    lines.push(`【月次サンプル（${tail.length}点・各月の最初の記録）】`);
    for (const p of tail) {
      lines.push(`  ${p.date}: ${history.accounts.map(a => `${a} ${yen(p.values[a])}`).join(' / ')}`);
    }
  }

  return {
    // ATTENTION: 古いキーは残すこと（管理画面の閲覧が参照している）
    classes: composition.classes,
    totalAssets: totalAssets ?? null,
    totalGainLoss: totalGainLoss ?? null,
    holdings: sorted,
    ledgerStats: stats,
    text: lines.join('\n'),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 週次の資産レポートを作り、Obsidian の週次ノートへ書き込む。
 *
 * 数字の出どころは、ブラウザ拡張から届いた取り込みデータを優先し、届いていない金融機関だけ
 * 画像の読み取りに回す。ログインや自動巡回は一切行わない。
 * 日曜夜の週次の自動実行と、週次レポート全体の作り直しの両方から呼ばれる。
 *
 * ATTENTION: 前回と同じ材料でも作り直しを止めないこと。「週末が忙しくて更新できないことも
 * ある。その場合は何も無い状態にせず、古いデータでも今の最新として扱ってほしい」という
 * 方針のため。代わりに、いつ時点のデータかを本文に必ず書く。
 *
 * @param {any} opts config・creds・activitySessionId
 * @returns {Promise<any>} 読み上げ用の短い結果。失敗時は error
 */
async function updateFinanceReport({ config, creds, activitySessionId = null }) {
  const { obs, error: _obsErr } = _requireObsidian(config);
  if (_obsErr) return _obsErr;
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };

  // 週次ノートの資産の節へ書き込む。どこから呼ばれても常に「今週」のノートへ反映する。
  // 書き込みは節ごとの置き換えなので、週の途中で何度呼ばれても上書きされるだけで壊れない。
  const weekDates = datesForWeekEndingOn(new Date());
  const [weekStart, weekEnd] = [weekDates[0], weekDates[6]];
  const weeklyNotesFolder = obs.weekly_notes_folder || '04_Weekly Notes';
  const weeklyNotePath = obsidianService.weeklyNoteRelPath(weeklyNotesFolder, weekStart);
  const writeSection = (content) => obsidianService.setSectionContent(obs.vault_path, weeklyNotePath, '💰 週次金融資産レポート', content, {
    templateRelativePath: obs.weekly_note_template,
    templateVars: { weekStart, weekEnd },
  });

  const rakutenFolder = obs.rakuten_screenshot_folder || '20_asset_data/Rakuten';
  const paypayFolder = obs.paypay_screenshot_folder || '20_asset_data/PayPay';
  const rakuten = obsidianService.findLatestImageFile(obs.vault_path, rakutenFolder);
  const paypay = obsidianService.findLatestImageFile(obs.vault_path, paypayFolder);

  // ブラウザ拡張から届いた取り込みデータがあれば、その金融機関は画像の読み取りより優先する。
  // 機械的に読んだ値なので画像を読ませるより正確で、費用もかからない。
  const { fresh: importedFresh, stale: importedStale } = financeImportStore.readFreshImports({ maxAgeDays: STALE_IMPORT_DAYS });

  // ATTENTION: 古い取り込みデータも捨てないこと。ただし黙って使うと拡張が止まっていることに
  // 気づけないため、本文に必ず「いつ時点か」を書く。
  const importedAll = { ...importedStale, ...importedFresh };
  const importedList = Object.values(importedAll);
  const staleImports = Object.values(importedStale).filter((r) => !importedFresh[r.source]);
  for (const rec of staleImports) {
    getLogger().warn(`[Secretary] ${rec.institution}の取り込みデータが古くなっています（${rec.receivedAt}）`);
  }

  // ATTENTION: 既定では画像を読まないこと。拡張が止まったときに何か月も前の画像へ黙って
  // 切り替わり、それを最新として報告してしまう。この静かな誤りは、データが欠けることより危険。
  // 画像の経路へ戻す場合だけ、設定で明示的に有効にする。
  const screenshotFallback = config.finance_import?.screenshot_fallback === true;
  const rakutenImg = (screenshotFallback && !importedAll.rakuten) ? rakuten : null;
  const paypayImg = (screenshotFallback && !importedAll.paypay) ? paypay : null;
  const hasImages = !!(rakutenImg || paypayImg);

  if (!hasImages && importedList.length === 0) {
    const msg = screenshotFallback
      ? `資産データが見つかりませんでした（ブラウザで口座ページを開くか、${rakutenFolder}・${paypayFolder}にスクリーンショットを保存してください）。`
      : '資産データが届いていません。楽天証券・PayPay銀行の口座ページをブラウザで開くと自動で送信されます。';
    writeSection(msg);
    return { result: msg };
  }

  // 推移のグラフにも使うため、直近1件だけでなくまとめて読む（絞り込みは図を作る側で行う）
  const prevSnapshots = secretaryStore.listEntries('finance-snapshots', { limit: 52 });
  // 直前の1件。画像の更新日時を引き継ぐためだけに使う
  const prevAny = prevSnapshots[0] || null;
  // ATTENTION: 対前週比の相手は必ず週をまたいで選ぶこと。同じ週の再実行を相手にすると
  // 全銘柄0%になる。
  const prev = _findPreviousWeekSnapshot(prevSnapshots, new Date());

  if (rakuten && prevAny?.sources?.rakuten?.mtimeMs === rakuten.mtimeMs) {
    getLogger().debug('[Secretary] 週次金融レポート: 楽天証券の画像は前回と同じですが、そのまま分析します');
  }
  if (paypay && prevAny?.sources?.paypay?.mtimeMs === paypay.mtimeMs) {
    getLogger().debug('[Secretary] 週次金融レポート: PayPay銀行の画像は前回と同じですが、そのまま分析します');
  }

  // ATTENTION: 画像ごとに、その直前へ金融機関名を書いた文を挟むこと。複数枚をまとめて渡すと
  // どの画像がどの金融機関か曖昧になり、保有の金融機関名が取り違えられる。
  const parts = [];
  if (rakutenImg) {
    parts.push({ text: 'この次の画像は楽天証券の資産状況スクリーンショットです。' });
    parts.push(imagePart(rakutenImg.buffer.toString('base64'), rakutenImg.mimeType));
  }
  if (paypayImg) {
    parts.push({ text: 'この次の画像はPayPay銀行の資産状況スクリーンショットです。' });
    parts.push(imagePart(paypayImg.buffer.toString('base64'), paypayImg.mimeType));
  }
  parts.push({ text: '表示されている数値をそのまま正確に読み取り、指定のJSON形式で出力してください。' });

  // 画像が1枚も無い（＝すべて取り込み済み）なら、言語モデルは呼ばない
  let rawText = '{"totalAssets":null,"totalGainLoss":null,"holdings":[]}';
  if (hasImages) try {
    ({ text: rawText } = await generateText({
      tier: 'analysis',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、証券会社・銀行の資産状況スクリーンショットを読み取り、'
        + '構造化データとして抽出するアシスタントです。画像に表示されている数値をそのまま正確に'
        + '読み取ってください（推測・四捨五入・単位換算による改変は禁止）。合計行が画像内にあれば、'
        + '個別項目の合計と一致しているか自分で検算し、一致しない場合は画像に表示されている合計値を'
        + '優先してください。画像に無い情報を創作しないでください。複数枚渡された場合は、すべてを'
        + '合算した資産合計・評価損益合計と、保有銘柄を1つのholdings配列にまとめて出力してください'
        + '（銀行口座の残高のように個別銘柄が無い場合はholdingsに含めなくてよい）。'
        + '各holdingのinstitutionには、その項目がどちらの画像（金融機関）から読み取ったものかを'
        + '正確に入れてください。accountTypeには、画像内に「口座区分」「コース」のような列が'
        + 'あれば、そこに表示されている文字列（例: NISA、NISA（つみたて投資）、NISA（成長投資）等）'
        + 'をそのまま入れてください。無い・読み取れない場合は空文字にしてください（推測で埋めない）。'
        + 'assetClassには、画像内に「種別」のような資産クラスを示す列があれば、そこに表示されている'
        + '文字列（例: 国内株式、米国株式、投資信託、外貨預り金等）をそのまま入れてください。無い・'
        + '読み取れない場合は空文字にしてください（推測で埋めない）。',
      contents: [{ role: 'user', parts }],
      temperature: 0,
      schema: {
        type: 'object',
        properties: {
          totalAssets: { type: 'number' },
          totalGainLoss: { type: 'number' },
          holdings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                institution: { type: 'string' },
                fund: { type: 'string' },
                accountType: { type: 'string' },
                assetClass: { type: 'string' },
                valuation: { type: 'number' },
                gainLoss: { type: 'number' },
              },
              required: ['institution', 'fund', 'valuation'],
            },
          },
        },
        required: ['totalAssets', 'holdings'],
      },
      agentKey: 'secretary_finance_report',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] 週次金融資産レポート分析に失敗: ${e.message}`);
    return { error: '資産スクリーンショットの分析に失敗しました。時間をおいて再度お試しください。' };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[Secretary] 週次金融資産レポートのJSON解析に失敗: ${e.message}`);
    return { error: '資産スクリーンショットの分析に失敗しました（内容の解析エラー）。' };
  }

  // 一方の金融機関の画面には資産の種別の列が無いため、その分だけコード側で補う。
  // ATTENTION: この補いは画像から読み取った分にだけ効かせること。取り込んだ分は種別が
  // 明示されており、一律に倒すと預金が投資信託に化ける。
  const visionHoldings = (parsed.holdings || []).map((h) => (
    /paypay/i.test(h.institution || '') ? { ...h, assetClass: '投資信託' } : h
  ));
  const importedHoldings = importedList.flatMap((rec) => rec.holdings || []);
  const holdings = [...importedHoldings, ...visionHoldings];

  // 合計は「取り込んだ分の合計＋画像から読んだ分の合計」。
  // ATTENTION: 数値が1つも無いときは 0 ではなく null にすること。0円だと資産が消えたように見える。
  const _sumOrNull = (vals) => {
    const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v));
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
  };

  const snapshot = {
    totalAssets: _sumOrNull([...importedList.map((r) => r.totalAssets), parsed.totalAssets]),
    totalGainLoss: _sumOrNull([...importedList.map((r) => r.totalGainLoss), parsed.totalGainLoss]),
    holdings,
    sources: {
      rakuten: rakuten ? { mtimeMs: rakuten.mtimeMs } : (prevAny?.sources?.rakuten || null),
      paypay: paypay ? { mtimeMs: paypay.mtimeMs } : (prevAny?.sources?.paypay || null),
      // どの金融機関を取り込みで賄ったか。画像の更新を促す処理が見る
      imported: Object.fromEntries(
        Object.entries(importedFresh).map(([k, r]) => [k, { receivedAt: r.receivedAt, asOf: r.asOf }])
      ),
    },
  };
  if (importedList.length) {
    getLogger().info(
      `[Secretary] 週次金融レポート: ${importedList.map((r) => r.institution).join('・')} は拡張の取り込みデータを使用`
      + `${hasImages ? '（残りは画像解析）' : '（画像解析は不要のため省略）'}`
    );
  }
  secretaryStore.appendEntry('finance-snapshots', snapshot);
  secretaryStore.appendEntry('daily-briefings', { tool: 'update_finance_report', result: `資産合計${snapshot.totalAssets ?? '不明'}円のレポートを記録しました。` });
  // 台帳（長期の推移）の読み取りは、失敗してもレポート作成を妨げない（推移が欠けるだけ）
  const _ledgerHistory = await _fetchAssetLedgerHistory(config, creds).catch(() => null);
  secretaryMemory.writeFinancePublicSummary(_buildFinancePublicSummary({
    holdings: snapshot.holdings,
    totalAssets: snapshot.totalAssets,
    totalGainLoss: snapshot.totalGainLoss,
    history: _ledgerHistory,
  }));

  const yen = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP') + '円' : '不明');
  const gainLossRate = (valuation, gainLoss) => {
    const pct = _financeGainLossRatePct(valuation, gainLoss);
    if (pct == null) return '-';
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };
  const lines = [];
  lines.push(`**資産合計**: ${yen(snapshot.totalAssets)}`);
  if (snapshot.totalGainLoss != null) lines.push(`**評価損益合計**: ${yen(snapshot.totalGainLoss)}`);
  // 前週比は金額と率の両方を出す
  if (prev?.totalAssets != null && snapshot.totalAssets != null) {
    const diff = snapshot.totalAssets - prev.totalAssets;
    const sign = diff >= 0 ? '+' : '';
    const pct = _periodChangePct(snapshot.totalAssets, prev.totalAssets);
    const pctStr = pct != null ? `（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）` : '';
    lines.push(`**前週比**: ${sign}${diff.toLocaleString('ja-JP')}円 ${pctStr}`);
  } else {
    lines.push('**前週比**: 比較できる先週分の記録がありませんでした（今回が初回の記録です）。');
  }

  // ATTENTION: 数字がいつ時点のものかを必ず書くこと。取り込みの値は「最後に口座のページを
  // 開いた時刻」のもので、レポートを作った時刻とは一致しない。
  if (importedList.length > 0) {
    const at = (iso) => new Date(iso).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    lines.push(`**データの時点**: ${importedList.map((r) => `${r.institution} ${at(r.receivedAt)}`).join(' ／ ')}`);
    for (const rec of staleImports) {
      const days = Math.floor((Date.now() - new Date(rec.receivedAt).getTime()) / 86400000);
      lines.push(`> ⚠️ ${rec.institution}のデータは${days}日前のものです。ブラウザで口座ページを開くと更新されます。`);
    }
  }
  // ATTENTION: 推移のグラフも、週で揃えてから使うこと。同じ週に複数件あると同じ日付の点が
  // 2つ並び、グラフが階段状に乱れる。
  const trendPoints = [...dedupeSnapshotsByWeek(prevSnapshots)].reverse()
    .filter((s) => typeof s.totalAssets === 'number')
    .map((s) => ({ date: s.time, totalAssets: s.totalAssets }));
  if (typeof snapshot.totalAssets === 'number') {
    trendPoints.push({ date: new Date().toISOString(), totalAssets: snapshot.totalAssets });
  }
  const trendChart = _buildFinanceTrendChart(trendPoints);
  if (trendChart) {
    lines.push('', '**資産推移**', trendChart);
  } else {
    lines.push('', '**資産推移**: データが2週分以上たまるまで表示されません（現在1週分）。');
  }
  if (snapshot.holdings.length > 0) {
    const pie = _buildFinancePieChart(snapshot.holdings);
    if (pie) lines.push('', pie);
    // ATTENTION: 突き合わせは必ず共有の関数を使うこと。ここに別実装を書くと、ヒートマップ
    // だけ直って表の前週比は大半が「新規」のまま、という片方だけの修正になる。
    const prevOf = matchHoldingsAcrossWeeks(snapshot.holdings, prev?.holdings || []);
    const fundWowPct = (h) => {
      const prevH = prevOf.get(h);
      if (!prevH) return '新規';
      const pct = _periodChangePct(h.valuation, prevH.valuation);
      if (pct == null) return '-';
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    };
    lines.push('', '| 金融機関 | ファンド名 | 口座区分 | 評価金額 | 評価損益 | 騰落率 | 前週比 |', '|---|---|---|---|---|---|---|');
    for (const h of snapshot.holdings) {
      lines.push(`| ${h.institution || '-'} | ${h.fund} | ${h.accountType || '-'} | ${yen(h.valuation)} | ${h.gainLoss != null ? yen(h.gainLoss) : '-'} | ${gainLossRate(h.valuation, h.gainLoss)} | ${fundWowPct(h)} |`);
    }
  }

  // 金融情報の担当による今週の総括を添える。
  // ATTENTION: 材料には上で組み立てた本文そのものを渡し、金額を計算し直させないこと。
  const financeOverview = await buildCenterOverview({
    agentKey: 'finance', defaultName: '金融情報センター', config, apiKey, activitySessionId,
    materialText: lines.join('\n'),
    focusInstruction: '【今回書くこと】今週の資産状況を取りまとめて総括してください。前週比が'
      + '大きく動いた銘柄があれば触れ、材料から言える範囲で来週以降の注目点があれば添えて'
      + 'ください（材料に無い独自の予測は作らないこと）。',
  });
  if (financeOverview) {
    lines.unshift(`### 💰 ${config.agents?.finance?.name || '金融情報センター'}による今週の総括\n${financeOverview}\n`);
  }
  writeSection(lines.join('\n'));

  // 戻り値は会話でそのまま読み上げられるため、表ではなく短い文にする
  // （詳しい内容は週次ノート側にあるので、ここでは要点だけ）
  let spoken = `今週の資産合計は${yen(snapshot.totalAssets)}`;
  if (prev?.totalAssets != null && snapshot.totalAssets != null) {
    const diff = snapshot.totalAssets - prev.totalAssets;
    const sign = diff >= 0 ? 'プラス' : 'マイナス';
    const pct = _periodChangePct(snapshot.totalAssets, prev.totalAssets);
    const pctStr = pct != null ? `（${Math.abs(pct).toFixed(1)}%）` : '';
    spoken += `で、前週比は${sign}${Math.abs(diff).toLocaleString('ja-JP')}円${pctStr}でした`;
  } else {
    spoken += 'でした（比較できる前週分の記録が無いため、今回が初回の記録です）';
  }
  spoken += '。ウィークリーノートに記録しました。';
  // ATTENTION: 他の道具と違い読み上げ向けの包みを通していないので、大きな数値の読み方の
  // 変換をここで個別に掛けること。
  return { result: normalizeLargeNumbersForSpeech(spoken) };
}

/**
 * 記録の一覧を「1週につき1件」へ揃える。保存は追記のまま、読むときだけ揃える。
 *
 * BUGFIX: 同じ週に複数件入ることが実際にある（会話から作り直したとき）。素通しすると
 * 推移に同じ日付の行が2回並び、「直近4週」と言いながら重複が1週分を食って3週しか遡れない。
 *
 * ATTENTION: 保存時に上書きするのではなく、読むときに揃えること。途中で取った記録を失わない
 * ため。週内で残すのはその週の最後の1件（＝日曜の週次の値）で、前週の同じ曜日と比べる軸が保たれる。
 *
 * @param {any[]} snapshots 新しい順の一覧
 * @returns {any[]} 新しい順のまま、各週の最新1件だけにしたもの
 */
function dedupeSnapshotsByWeek(snapshots) {
  const seen = new Set();
  const out = [];
  for (const snap of snapshots || []) {
    if (!snap?.time) continue;
    // 新しい順に見るので、ある週で最初に出会うものがその週の最新＝残すべき1件
    const week = datesForWeekEndingOn(new Date(snap.time))[0];
    if (seen.has(week)) continue;
    seen.add(week);
    out.push(snap);
  }
  return out;
}

/**
 * 「前の週の記録」を選ぶ。
 *
 * BUGFIX: 比較の相手を「直近2件」で取ってはいけない。記録は実行のたびに追記されるため、
 * 同じ週に2回実行すると今週と今週を比べることになり、対前週比が全銘柄0%になる。
 * ヒートマップも中心の色で塗られ「色がついていない」ように見えた。
 *
 * 週の区切りは週次ノートと同じ起点に合わせる。「対前週比」という表示に対し、比較相手が
 * 別の週であることを保証するのが目的。
 *
 * @param {any[]} snapshots 新しい順の記録
 * @param {any} referenceTime 「今週」を決める基準の時刻
 * @returns {any} 基準より前の週の中で最も新しいもの。無ければ null
 */
function _findPreviousWeekSnapshot(snapshots, referenceTime) {
  const currentWeekStart = datesForWeekEndingOn(new Date(referenceTime))[0];
  return (snapshots || []).find((s) => {
    if (!s?.time) return false;
    return datesForWeekEndingOn(new Date(s.time))[0] < currentWeekStart;
  }) || null;
}

/**
 * 面積が値に比例し、なるべく正方形に近い形で敷き詰める配置を計算する。
 *
 * ATTENTION: この配置を言語モデルに解かせないこと。決まった手順で計算できるものであり、
 * 任せると回ごとに品質がぶれる（全部が同じ大きさのマス目になる、余白だらけに崩れる）。
 *
 * 手順は、値の大きい順に並べ、いまの帯へ1つ足すたびに最も悪い縦横比を計算し、悪化するなら
 * その帯を確定して次の帯を始める、というもの。
 *
 * @param {any[]} items value（面積の元になる正の数）を持つ配列
 * @param {any} [box] 描く領域（既定は 100×100 の相対座標）
 * @returns {any[]} items と同じ順の矩形（x・y・w・h）
 */
function squarifiedTreemap(items, { width = 100, height = 100 } = {}) {
  const valid = items.map((it, i) => ({ i, value: Number(it.value) || 0 })).filter((it) => it.value > 0);
  if (valid.length === 0) return items.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  valid.sort((a, b) => b.value - a.value);

  const total = valid.reduce((sum, it) => sum + it.value, 0);
  const scale = (width * height) / total;
  const areas = valid.map((it) => ({ i: it.i, area: it.value * scale }));

  const out = new Array(items.length).fill(null).map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  let x = 0, y = 0, w = width, h = height;

  // 帯を短い辺に沿って並べたときの、最も悪い縦横比
  const worstRatio = (row, side) => {
    if (row.length === 0 || side <= 0) return Infinity;
    const sum = row.reduce((s, r) => s + r.area, 0);
    const max = Math.max(...row.map((r) => r.area));
    const min = Math.min(...row.map((r) => r.area));
    const s2 = sum * sum, side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };

  // 確定した帯を実際の矩形に変換し、残りの領域を縮める
  const layoutRow = (row) => {
    const sum = row.reduce((s, r) => s + r.area, 0);
    const horizontal = w >= h;          // 短い辺に沿って積む
    const side = horizontal ? h : w;
    const thickness = sum / side;       // 帯の厚み
    let pos = horizontal ? y : x;
    for (const r of row) {
      const len = r.area / thickness;
      out[r.i] = horizontal
        ? { x, y: pos, w: thickness, h: len }
        : { x: pos, y, w: len, h: thickness };
      pos += len;
    }
    if (horizontal) { x += thickness; w -= thickness; } else { y += thickness; h -= thickness; }
  };

  let row = [];
  for (const item of areas) {
    const side = Math.min(w, h);
    if (row.length === 0 || worstRatio([...row, item], side) <= worstRatio(row, side)) {
      row.push(item);
    } else {
      layoutRow(row);
      row = [item];
    }
  }
  if (row.length > 0) layoutRow(row);
  return out;
}

/**
 * 保有のヒートマップ用のデータ（座標つき）を返す。会話からの依頼と週次ノートの両方がこれを使う。
 *
 * @returns {any} 行と前週・今週の日付。前週比が出せなければ null
 */
function buildHoldingsTreemapRows() {
  const wow = buildHoldingsWeekOverWeek();
  if (!wow || !wow.prevSnapshot) return null;
  // 対前週比が出せた銘柄だけ。今週からの保有は比較の相手が無く、0%（動いていない）と
  // 混同されるため色を塗らせない
  const rows = wow.rows.filter((r) => r._wowPct != null && typeof r.valuation === 'number' && r.valuation > 0);
  if (rows.length === 0) return null;

  const layout = squarifiedTreemap(rows.map((r) => ({ value: r.valuation })), { width: 100, height: 100 });
  return {
    rows: rows.map((r, i) => ({ ...r, _rect: layout[i] })),
    prevLabel: wow.prevSnapshot.time ? String(wow.prevSnapshot.time).slice(0, 10) : '前週',
    curLabel: wow.snapshot.time ? String(wow.snapshot.time).slice(0, 10) : '今週',
  };
}

/**
 * 保有のヒートマップの図を、描き上がった形まで作って返す。
 *
 * ATTENTION: 描画までここで完結させること。座標だけ渡す方式でも、絞り込みが入ると渡した
 * 座標が使えなくなり、受け取った側が自分で描き直してしまう。依頼のたびに違う図が出た。
 * 絞り込みごとに配置を計算し直し、完成した図まで作れば、何度頼んでも同じ図になる。
 *
 * opts の内訳:
 *   - institution: 金融機関名の部分一致。省略で全件
 *   - topN: 評価額の上位N件に絞る。省略で全件
 *
 * @param {any} [opts] 上記の絞り込み
 * @returns {any} 図・行・題名・副題。描けなければ null
 */
function buildHoldingsHeatmapSvg({ institution = '', topN = 0 } = {}) {
  const { renderTreemapSvg } = require('./holdings-treemap-svg');
  const wow = buildHoldingsWeekOverWeek();
  if (!wow || !wow.prevSnapshot) return null;

  // BUGFIX: 前週比を出せない銘柄（今週から保有・突き合わせに失敗）も落とさないこと。
  // 絞っていた頃は、突き合わせに失敗した大半が黙って消え、全資産のはずが一部だけになっていた。
  // 面積は評価額で決まるので、前週比が無くても描ける（色は灰色で「新規」と表示する）。
  let rows = wow.rows.filter((r) => typeof r.valuation === 'number' && r.valuation > 0);
  if (institution) {
    const key = String(institution).trim();
    rows = rows.filter((r) => String(r.institution || '').includes(key));
  }
  if (rows.length === 0) return null;
  rows = [...rows].sort((a, b) => b.valuation - a.valuation);
  if (topN > 0) rows = rows.slice(0, topN);

  // 絞り込んだ後の集合に対して配置を計算し直す（そうしないと領域に隙間ができる）
  const layout = squarifiedTreemap(rows.map((r) => ({ value: r.valuation })), { width: 100, height: 100 });
  const placed = rows.map((r, i) => ({ ...r, _rect: layout[i] }));

  const curLabel = wow.snapshot.time ? String(wow.snapshot.time).slice(0, 10) : '今週';
  const prevLabel = wow.prevSnapshot.time ? String(wow.prevSnapshot.time).slice(0, 10) : '前週';
  const total = placed.reduce((sum, r) => sum + r.valuation, 0);
  const title = institution ? `${institution} 保有資産ヒートマップ` : '保有資産ヒートマップ';
  const newCount = placed.filter((r) => r._wowPct == null).length;
  const subtitle = `${prevLabel} → ${curLabel} の比較　／　${placed.length}銘柄${newCount > 0 ? `（うち前週比なし${newCount}）` : ''}　合計 ${(total / 10000).toFixed(1)}万円`;

  return { svg: renderTreemapSvg(placed, { title, subtitle }), rows: placed, title, subtitle };
}

/**
 * ヒートマップのデータを、座標込みの表形式の文字列へ整える。
 * 座標は 100×100 の相対座標で、左上が原点、縦は下向き。
 *
 * @param {any} tm buildHoldingsTreemapRows の結果
 * @returns {string} 表形式の文字列
 */
function formatHoldingsTreemapCsv(tm) {
  return ['fund,valuation,wowPct,x,y,w,h']
    .concat(tm.rows.map((r) => [
      '"' + String(r.fund || '').replace(/"/g, '') + '"',
      r.valuation,
      r._wowPct.toFixed(4),
      r._rect.x.toFixed(3), r._rect.y.toFixed(3), r._rect.w.toFixed(3), r._rect.h.toFixed(3),
    ].join(','))).join('\n');
}

/**
 * 直近の記録と前の週の記録を突き合わせ、保有ごとの騰落率・対前週比を付けて返す。
 *
 * ATTENTION: 突き合わせの実装は必ずここに集約すること。会話からの問い合わせと週次ノートの
 * ヒートマップの両方がこれを使う。2か所に分けると、正規化の漏れのような不具合が片方だけ直る。
 *
 * @returns {any} 今週の記録・前週の記録・行の一覧。データが無ければ null。
 *   各行は保有の項目に加えて、_ratePct（通算の騰落率）・_wowPct と _wowYen（対前週比）・
 *   _isNew（今週から保有）を持つ。
 */
function buildHoldingsWeekOverWeek() {
  // 同じ週に複数回記録が作られることがあるため、「直近2件」ではなく週をまたいだ相手を選ぶ
  const snapshots = secretaryStore.listEntries('finance-snapshots', { limit: 12 });
  const snapshot = snapshots[0];
  if (!snapshot || !snapshot.holdings || snapshot.holdings.length === 0) return null;
  const prevSnapshot = _findPreviousWeekSnapshot(snapshots.slice(1), snapshot.time);
  const prevOf = matchHoldingsAcrossWeeks(snapshot.holdings, prevSnapshot?.holdings || []);
  const rows = snapshot.holdings.map((h) => {
    const prevH = prevOf.get(h);
    return {
      ...h,
      _ratePct: _financeGainLossRatePct(h.valuation, h.gainLoss),
      // 前週に同じ銘柄が無い＝今週からの保有。0 と混同されないよう null で区別する
      _wowPct: prevH ? _periodChangePct(h.valuation, prevH.valuation) : null,
      _wowYen: prevH && typeof h.valuation === 'number' && typeof prevH.valuation === 'number'
        ? h.valuation - prevH.valuation : null,
      _isNew: !prevH,
    };
  });
  return { snapshot, prevSnapshot, rows };
}

/**
 * 直近の記録から、保有ごとの評価金額・評価損益・騰落率・対前週比を返す。会話の中で資産について
 * 特定の角度から聞かれたときに使う。画像の読み直しはせず、記録済みのものをそのまま返す。
 *
 * BUGFIX: 並べ替えを呼び出した側に任せないこと。数十件を暗算で並べ替えられず、未確定の
 * place holder をそのまま画面に出す事故が起きた。並べ替えはここで行い、返した順をそのまま
 * 使ってもらう。
 *
 * ATTENTION: 「ここには日々の値動きも過去の推移も無い」ことを本文に明記すること。一般的な
 * 「創作しないこと」という注意だけでは、存在しない推移を作ってグラフにしてしまう。
 *
 * @param {any} [args] sort_by（並べ替えの基準）・order（並び順）
 * @returns {any} 読み上げ向けに整えたデータ。記録が無ければ error
 */
function getFinanceDetails(args = {}) {
  const wow = buildHoldingsWeekOverWeek();
  const snapshot = wow?.snapshot;
  const prevSnapshot = wow?.prevSnapshot || null;
  if (!snapshot || !snapshot.holdings || snapshot.holdings.length === 0) {
    return { error: 'まだ資産データがありません。「資産レポートを作成して」と言っていただければ、'
      + 'Vault内のスクリーンショットを分析します。' };
  }

  const yen = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP') + '円' : '不明');
  const dateLabel = snapshot.time
    ? new Date(snapshot.time).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
    : '不明';

  const sortKeyMap = { rate: '_ratePct', valuation: 'valuation', gain_loss: 'gainLoss', wow: '_wowPct' };
  const sortKey = sortKeyMap[args?.sort_by] || null;
  const order = args?.order === 'asc' ? 'asc' : 'desc';
  const holdings = [...wow.rows];
  if (sortKey) {
    holdings.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return order === 'asc' ? av - bv : bv - av;
    });
  }

  const lines = [];
  lines.push(`【${dateLabel}に分析したスクリーンショットに基づくデータです。最新のスクリーンショットが`
    + '更新され、次回レポート作成が行われるまでは同じ内容です】');
  lines.push(`資産合計: ${yen(snapshot.totalAssets)}`);
  if (snapshot.totalGainLoss != null) lines.push(`評価損益合計: ${yen(snapshot.totalGainLoss)}`);
  if (prevSnapshot?.time) {
    const prevLabel = new Date(prevSnapshot.time).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    lines.push(`対前週比の比較基準: ${prevLabel}時点のデータ`);
    if (prevSnapshot.totalAssets != null && snapshot.totalAssets != null) {
      const d = snapshot.totalAssets - prevSnapshot.totalAssets;
      const p = _periodChangePct(snapshot.totalAssets, prevSnapshot.totalAssets);
      lines.push(`資産合計の対前週比: ${d >= 0 ? '+' : ''}${d.toLocaleString('ja-JP')}円`
        + `${p != null ? `（${p >= 0 ? '+' : ''}${p.toFixed(2)}%）` : ''}`);
    }
    // ATTENTION: 合計は画面の合計欄から、明細は表から、それぞれ別に読み取っている。両者が
    // 食い違う週が実際にあり、そのまま対前週比を出すと、値動きでない差が混ざったまま
    // 「今週は◯%下げました」と伝わる。見つけたら必ず明示すること。勝手にどちらかへ寄せない
    // （合計欄が現金を含むなど、正しく食い違う場合もあり、判断できるのは本人だけ）。
    const sumOf = (snap) => (snap?.holdings || []).reduce((a, h) => a + (typeof h.valuation === 'number' ? h.valuation : 0), 0);
    const gaps = [[dateLabel, snapshot], [prevLabel, prevSnapshot]]
      .map(([label, snap]) => ({ label, gap: sumOf(snap) - (snap?.totalAssets ?? 0) }))
      .filter((g) => Math.abs(g.gap) >= 1000);
    if (gaps.length > 0) {
      lines.push('【注意・データの食い違い】'
        + gaps.map((g) => `${g.label}は明細の合計が資産合計より${Math.abs(g.gap).toLocaleString('ja-JP')}円`
          + `${g.gap > 0 ? '多い' : '少ない'}`).join('、')
        + 'です。スクリーンショットの合計欄と明細テーブルの読み取りが食い違っている可能性があります。'
        + 'この差は値動きではないため、資産合計の対前週比を伝えるときは、'
        + '**その差がある事実も併せて一言伝えてください**（個別銘柄の対前週比は明細どうしの'
        + '比較なので、この影響を受けません）。');
    }
  } else {
    lines.push('対前週比: 前週のデータがまだ無いため計算できません（今回が初回の記録です）。');
  }
  lines.push('');
  lines.push(sortKey
    ? `保有内訳（${{ rate: '騰落率', valuation: '評価金額', gain_loss: '評価損益', wow: '対前週比' }[args.sort_by]}の${order === 'desc' ? '大きい' : '小さい'}順に並んでいます。この順序をそのまま使ってください）:`
    : '保有内訳（順位／金融機関／ファンド名／口座区分／評価金額／評価損益／騰落率／対前週比）:');
  holdings.forEach((h, i) => {
    const rateStr = h._ratePct != null ? `${h._ratePct >= 0 ? '+' : ''}${h._ratePct.toFixed(1)}%` : '不明';
    // 対前週比は率と金額の両方を出す。率だけだと小口の銘柄が大きく振れて見え、金額だけだと
    // 大口の銘柄しか目に入らない（どちらが要るかは聞き方によって変わる）
    const wowStr = h._isNew
      ? '対前週比なし(今週から保有)'
      : (h._wowPct != null
        ? `対前週比${h._wowPct >= 0 ? '+' : ''}${h._wowPct.toFixed(2)}%`
          + `(${h._wowYen != null ? (h._wowYen >= 0 ? '+' : '') + h._wowYen.toLocaleString('ja-JP') + '円' : '金額不明'})`
        : '対前週比不明');
    lines.push(`${i + 1}. ${h.institution || '不明'}／${h.fund}／${h.accountType || '(区分不明)'}／`
      + `${yen(h.valuation)}／${h.gainLoss != null ? yen(h.gainLoss) : '不明'}／騰落率${rateStr}／${wowStr}`);
  });

  // 枠の区分ごとの内訳も、こちらで集計して添える（読み取りと分類をさせないため）
  const nisaSummary = _buildNisaQuotaSummary(holdings);
  if (nisaSummary) {
    lines.push('');
    lines.push('【NISA枠区分別の内訳（サーバー側で決定的に集計済み。この分類・合計値をそのまま'
      + '使ってください。自分で口座区分の文字列を解釈し直す必要はありません）:】');
    nisaSummary.forEach((g) => {
      lines.push(`${g.label}: 合計${yen(g.sum)}（${g.funds.length}件） — `
        + g.funds.map((f) => `${f.fund}[${f.institution || '不明'}](${yen(f.valuation)})`).join('、'));
    });
  }

  lines.push('');
  lines.push('【重要】上に列挙した項目・数値がこのデータの全てです。ここに無いファンド名や数値'
    + '（「XX.X%」のような未確定のプレースホルダーを含む）を作らないでください。順位付けや'
    + '上位・下位を尋ねられた場合も、自分で並べ替え直さず、この順序をそのまま使ってください。'
    + 'また、このデータは直近1回分の残高・評価損益と、その1つ前（前週）と比べた対前週比までです。'
    + '「資産の推移をグラフにして」「ここ半年でどう変わった？」のように**3週以上さかのぼる**'
    + '変化を尋ねられた場合は、こちらで架空の数値を作らず、資産推移取得の機能（週次の資産合計の'
    + '時系列データが取れます）や個別ファンド推移取得の機能を別途呼び出してください。'
    + '先週と今週の比較だけであれば、上の各銘柄の対前週比がその答えですので、この機能だけで'
    + '足ります。いずれの場合も、ここに無い過去の値を推測で埋めないこと。');

  // 他の読み取り系の道具と同じく記録に残す（1日の業務ログが拾い上げる）
  secretaryStore.appendEntry('daily-briefings', { tool: 'get_finance_details', result: '資産の詳細データについて質問に回答しました。' });
  return { result: wrapDataForSpeechGuidance(lines.join('\n')) };
}

/**
 * 資産合計の推移（各時点の値と前回比）を返す。1回分の記録では答えられない、複数週にまたがる
 * 問いのための道具。
 *
 * ATTENTION: 前回比の計算はすべてここで済ませてから渡すこと。暗算させると実在しない数値を作る。
 *
 * @param {any} [args] weeks（遡る週数）
 * @param {any} [ctx] config・creds（台帳を読むために使う）
 * @returns {Promise<any>} 読み上げ向けの推移と、計算用の生の数値。データが足りなければ error
 */
async function getFinanceHistory(args = {}, ctx = {}) {
  const weeksLimit = Number.isFinite(args?.weeks) && args.weeks > 0 ? Math.floor(args.weeks) : 26;

  // BUGFIX: 長い推移が要るときに見るべきは台帳のほう。週次の記録はレポートを作ったときしか
  // 増えず、運用を始めた直後は数週分しか無い。台帳を読まなかった頃は、足りない分を探しに
  // Obsidian を何度も検索し、往復の上限で打ち切られて「システム障害」に見えていた。
  // まず台帳を読み、駄目なときだけ週次の記録へ落ちる。台帳の読み取りは失敗しても例外にしない。
  const _ledger = ctx?.config && ctx?.creds
    ? await _fetchAssetLedgerHistory(ctx.config, ctx.creds).catch(() => null)
    : null;
  if (_ledger && Array.isArray(_ledger.points) && _ledger.points.length >= 2) {
    return _formatLedgerHistory(_ledger, weeksLimit);
  }
  // ATTENTION: 週で揃えてから件数を絞ること。生の一覧をそのまま取ると、同じ週に複数件ある
  // ときに「4週分」が実際には3週分しか遡れない。
  const snapshots = dedupeSnapshotsByWeek(
    secretaryStore.listEntries('finance-snapshots', { limit: weeksLimit * 4 })
  ).slice(0, weeksLimit);
  if (snapshots.length === 0) {
    return { error: 'まだ資産データがありません。「資産レポートを作成して」と言っていただければ、'
      + 'Vault内のスクリーンショットを分析します。' };
  }
  const chronological = [...snapshots].reverse(); // 古い順
  if (chronological.length < 2) {
    return { error: 'まだ1週分のデータしかなく、推移を計算できません。来週以降のレポート作成後に'
      + 'また聞いてみてください。' };
  }

  const yen = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP') + '円' : '不明');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const lines = [];
  lines.push(`【過去${chronological.length}件の資産レポートに基づく推移データです】`);
  chronological.forEach((s, i) => {
    const prevEntry = i > 0 ? chronological[i - 1] : null;
    const pct = prevEntry ? _periodChangePct(s.totalAssets, prevEntry.totalAssets) : null;
    const diffYen = prevEntry && typeof s.totalAssets === 'number' && typeof prevEntry.totalAssets === 'number'
      ? s.totalAssets - prevEntry.totalAssets : null;
    const changeStr = pct != null
      ? `（前回比 ${diffYen >= 0 ? '+' : ''}${diffYen.toLocaleString('ja-JP')}円／${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）`
      : '（初回の記録）';
    lines.push(`- ${fmtDate(s.time)}: 資産合計${yen(s.totalAssets)} ${changeStr}`);
  });
  const latest = chronological[chronological.length - 1];
  const first = chronological[0];
  const totalPct = _periodChangePct(latest.totalAssets, first.totalAssets);
  if (totalPct != null) {
    lines.push('');
    lines.push(`${fmtDate(first.time)}から${fmtDate(latest.time)}までの合計変化率: `
      + `${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`);
  }
  lines.push('');
  lines.push('【重要】上に列挙した日付・数値がこのデータの全てです。ここに無い日付・数値を作らないで'
    + 'ください。グラフ化を求められた場合は、この日付・資産合計の値だけを使って構いません。'
    + '個別ファンド単位の推移（「〇〇ファンドはどう推移した？」等）を尋ねられた場合は、'
    + 'こちらではなく個別ファンド推移取得の機能を別途呼び出してください。');

  secretaryStore.appendEntry('daily-briefings', { tool: 'get_finance_history', result: '資産の推移について質問に回答しました。' });
  return {
    result: wrapDataForSpeechGuidance(lines.join('\n'))
      + _rawSeriesBlock(chronological
        .filter((s2) => typeof s2.totalAssets === 'number')
        .map((s2) => ({ date: fmtDate(s2.time), value: s2.totalAssets }))),
  };
}

/**
 * 指定した1銘柄の評価金額・評価損益の推移を返す。記録には保有の内訳が毎週まるごと残っているので、
 * 週をまたいで同じ銘柄を突き合わせて並べ直すだけでよい。
 *
 * 銘柄の特定は名前の部分一致で行う（記号だけで呼ぶことも、正式名称の一部で呼ぶこともあるため）。
 * 同じ銘柄を複数の口座で持っている場合、1週の中で一致した複数件は合算してその週の1点とする。
 *
 * ATTENTION: 一致する銘柄が無い週は、0円ではなくその週ごと外すこと。0にすると「持っていない」
 * と「たまたま値が0」の区別がつかなくなる。
 *
 * @param {any} [args] fund_name（銘柄名の一部）・weeks（遡る週数）
 * @returns {any} 読み上げ向けの推移。見つからなければ error
 */
function getFundHistory(args = {}) {
  const fundName = (args?.fund_name || '').trim();
  if (!fundName) {
    return { error: 'ファンド名を指定してください。' };
  }
  const weeksLimit = Number.isFinite(args?.weeks) && args.weeks > 0 ? Math.floor(args.weeks) : 26;
  // ATTENTION: 週で揃えてから件数を絞ること（理由は推移取得の側のコメントと同じ）
  const snapshots = dedupeSnapshotsByWeek(
    secretaryStore.listEntries('finance-snapshots', { limit: weeksLimit * 4 })
  ).slice(0, weeksLimit);
  if (snapshots.length === 0) {
    return { error: 'まだ資産データがありません。「資産レポートを作成して」と言っていただければ、'
      + 'Vault内のスクリーンショットを分析します。' };
  }

  const needle = fundName.toLowerCase();
  const chronological = [...snapshots].reverse(); // 古い順
  const points = [];
  for (const s of chronological) {
    const matched = (s.holdings || []).filter((h) => (h.fund || '').toLowerCase().includes(needle));
    if (matched.length === 0) continue;
    const valuation = matched.reduce((sum, h) => sum + (typeof h.valuation === 'number' ? h.valuation : 0), 0);
    const gainLoss = matched.every((h) => typeof h.gainLoss === 'number')
      ? matched.reduce((sum, h) => sum + h.gainLoss, 0)
      : null;
    points.push({
      date: s.time,
      valuation,
      gainLoss,
      matchedNames: [...new Set(matched.map((h) => h.fund))],
      accountBreakdown: matched.length > 1
        ? matched.map((h) => `${h.institution || '不明'}/${h.accountType || '区分不明'}`)
        : null,
    });
  }

  if (points.length === 0) {
    return { error: `「${fundName}」に一致するファンドは、これまでの資産レポートの記録の中に`
      + 'は見つかりませんでした。ファンド名を正確に確認するか、資産レポートを更新してから'
      + 'もう一度お試しください。' };
  }

  const yen = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP') + '円' : '不明');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const lines = [];
  const matchedNameSet = [...new Set(points.flatMap((p) => p.matchedNames))];
  lines.push(`【「${fundName}」に一致するファンド（${matchedNameSet.join('・')}）の、`
    + `過去${points.length}件の資産レポートに基づく推移データです】`);
  if (matchedNameSet.length > 1) {
    lines.push('（名前が完全一致ではない複数のファンドが一致したため、合算した値です。'
      + '個別に見たい場合はより正確なファンド名で聞き直してください）');
  }
  points.forEach((p, i) => {
    const prevPoint = i > 0 ? points[i - 1] : null;
    const pct = prevPoint ? _periodChangePct(p.valuation, prevPoint.valuation) : null;
    const diffYen = prevPoint ? p.valuation - prevPoint.valuation : null;
    const changeStr = pct != null
      ? `（前回比 ${diffYen >= 0 ? '+' : ''}${diffYen.toLocaleString('ja-JP')}円／${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）`
      : '（この期間で最初に確認できた記録）';
    const accountNote = p.accountBreakdown ? `［内訳: ${p.accountBreakdown.join('、')}］` : '';
    lines.push(`- ${fmtDate(p.date)}: 評価金額${yen(p.valuation)}${p.gainLoss != null ? `（評価損益${yen(p.gainLoss)}）` : ''} ${changeStr}${accountNote}`);
  });
  if (points.length >= 2) {
    const totalPct = _periodChangePct(points[points.length - 1].valuation, points[0].valuation);
    if (totalPct != null) {
      lines.push('');
      lines.push(`${fmtDate(points[0].date)}から${fmtDate(points[points.length - 1].date)}までの合計変化率: `
        + `${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%`);
    }
  } else {
    lines.push('', 'このファンドが記録に登場するのはこの1回分のみで、まだ推移は計算できません。');
  }
  lines.push('');
  lines.push('【重要】上に列挙した日付・数値がこのデータの全てです。ここに無い日付・数値を作らないで'
    + 'ください。このファンドが登場しない週は、保有していなかった可能性もあれば、資産レポートが'
    + '作成されなかっただけの可能性もあるため、断定せず「記録が見つからなかった」とだけ伝えて'
    + 'ください。グラフ化を求められた場合は、この日付・評価金額の値だけを使って構いません。');

  secretaryStore.appendEntry('daily-briefings', { tool: 'get_fund_history', fundName, result: `「${fundName}」の推移について質問に回答しました。` });
  return { result: wrapDataForSpeechGuidance(lines.join('\n')) };
}

// 会話の相手へ見せる道具の宣言。
// ATTENTION: 週次レポートの作成（updateFinanceReport）は、ここに載せないこと。「レポートして
// （＝報告して）」という読み取りの依頼が「更新して」に化け、会話の途中で週次ノートが
// 書き換わり、同じ週に記録が2件できて対前週比が全銘柄0%になる事故が起きた。
// 週次ノートは日曜夜の自動実行の成果物であり、会話から書き換わるべきではない。会話で資産を
// 聞かれたときは、下の読み取り専用の3つで足りる。関数そのものは、週次レポート全体の
// 作り直しから呼ばれる本来の経路のために残す。
const TOOL_DECLARATIONS = [
      {
        name: 'create_holdings_heatmap',
        description: '保有資産のヒートマップ（ツリーマップ）を作成し、Obsidianへ保存します。'
          + '**面積が評価金額、色が対前週比**の四角形の図で、サーバー側で完成した画像まで作られます。'
          + '「資産のヒートマップを作って」「楽天証券の保有状況を図にして」のように頼まれたときは、'
          + '必ずこのツールを使ってください。'
          + '\n\n【重要】自分でグラフを描こうとしないでください。'
          + 'このツールが返す画像パスを、そのまま結果のノートへ ![[パス]] の形で貼るだけにします。'
          + 'コード実行でmatplotlib等を使って描き直すと、依頼のたびに違う図になってしまいます'
          + '（2026-09-10までに実際に3回、毎回違う形の図が作られました）。',
        parameters: {
          type: 'OBJECT',
          properties: {
            institution: { type: 'STRING', description: '証券会社で絞る場合の名前（部分一致・例:「楽天」「PayPay」）。全体なら省略' },
            top_n: { type: 'INTEGER', description: '評価金額の上位N銘柄に絞る場合の件数。全件なら省略' },
          },
        },
      },
      {
        name: 'get_finance_details',
        description: '直近の資産レポート作成時に読み取った、保有ファンドごとの評価金額・評価損益・'
          + '金融機関・口座区分と、**前週の同じ銘柄と比べた対前週比（率と金額）**の詳細データを'
          + '取得します。「PayPay銀行の新NISAのつみたて枠の収益は？」'
          + '「楽天証券で一番増えているファンドは？」のように、資産について特定の角度から質問された'
          + 'ときに使います。スクリーンショットの再分析は行わず、直近の資産レポート作成時のデータを'
          + 'そのまま返すため、リアルタイムの最新値ではなく、その時点のスナップショットである点を'
          + '踏まえて回答してください。一度も資産レポートを作成していない場合はエラーになるので、'
          + 'その場合は「日曜夜の週次レポートで最新のスクリーンショットを読み取ります」と案内してください'
          + '（資産レポートの更新は週次バッチの担当で、会話からは実行しません）。'
          // ATTENTION: 「分析して」「グラフにして」の依頼がこちらへ来ないよう明示すること。
          // 取得したデータを自分で集計・作図しようとする。分析と作図は裏方ヘルパーの担当。
          + '\n\n【重要・この機能を選んではいけない場合】「分析して」「グラフにして」'
          + '「ポートフォリオを作って」「比べて」のように、**計算・作図・組み立てを求められた場合は、'
          + 'この機能ではなくヘルパーへの依頼（ask_helper）を使ってください。**'
          + 'この機能は「今いくらか」「どの口座にいくらあるか」のような、そのまま答えられる'
          + '問い合わせ専用です。取得した数値をあなた自身が計算・順位付け・作図することは'
          + 'できません（実在しない数値を作ってしまう事故が過去に起きています）。'
          + '\n\n【重要・並び順について】「騰落率が高い順に5件」「一番評価損益が大きいファンドは」'
          + 'のように、順位付け・上位/下位を尋ねられた場合は、必ずsort_by（とorder）を指定して'
          + '呼び出してください。件数が多いデータをあなた自身の暗算で並べ替えようとすると、'
          + '実在しない数値やファンド名を作ってしまう事故につながります。指定して呼び出せば、'
          + '既に正しい順序で返ってくるので、あなたは並べ替え直さず、返ってきた順序と数値を'
          + 'そのまま使ってください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            sort_by: {
              type: 'STRING',
              description: '並び替えの基準（順位付けを聞かれていない場合は指定不要）。'
                + 'rate: 騰落率（買った時からの通算）／valuation: 評価金額／'
                + 'gain_loss: 評価損益／wow: 対前週比（先週から今週の動き）。'
                + '「今週上がったのは？」「先週から一番下げた銘柄は？」のように'
                + '**直近の動き**を聞かれたらwowを使ってください（rateは通算の損益率なので別物です）。',
              enum: ['rate', 'valuation', 'gain_loss', 'wow'],
            },
            order: {
              type: 'STRING',
              description: '並び順。省略時はdesc（大きい順）。「一番少ない」「損失が大きい」'
                + 'のように小さい順・マイナス側を聞かれたときはascを指定してください。',
              enum: ['desc', 'asc'],
            },
          },
        },
      },
      {
        name: 'get_finance_history',
        description: '資産合計の推移（各時点の値・前回比の金額と%）を取得します。'
          + '資産台帳のスプレッドシートに2年近い記録があればそちらを読み、無ければ'
          + '過去の週次レポートから組み立てます。**「2025年1月から」「全期間」のように'
          + '長い期間を指定されてもこの機能で足ります**（別の場所を探しに行かないでください）。'
          + 'を取得します。「先週末比でどれだけ増えた？」「資産の推移をグラフにして」「ここ最近で'
          + 'どう変わった？」のように、過去からの変化を尋ねられたときに使います（get_finance_details'
          + 'は直近1週分の内訳のみを返すツールで、こちらとは別物です。過去との比較を聞かれたら'
          + 'こちらを使ってください）。前回比の計算はサーバー側で行った結果をそのまま使い、'
          + '自分で暗算しないでください。グラフ化を頼まれた場合はキャンバス表示機能のxychart-betaで、'
          + 'ここで渡された日付・資産合計の値だけを使って作成してください（無いデータを創作しない'
          + 'こと）。台帳も週次レポートも無く2点未満しかデータが無い場合だけエラーになるので、'
          + 'その旨を正直に伝えてください。'
          // ATTENTION: 集計を伴う依頼がこちらへ来ないよう明示すること（集計は裏方ヘルパーの担当）
          + '\n\n【重要・この機能を選んではいけない場合】「分析して」「まとめて」「月ごとに集計して」'
          + 'のように、**取得した値をさらに計算・集計・比較することを求められた場合は、この機能では'
          + 'なくヘルパーへの依頼（ask_helper）を使ってください。**この機能が返すのは各週の値と'
          + '前回比までで、それ以上の集計をあなた自身が行うことはできません。',
        parameters: {
          type: 'OBJECT',
          properties: {
            weeks: {
              type: 'NUMBER',
              description: '遡る週数（省略時は直近26週分）。「半年分」「直近1ヶ月」のように'
                + '期間を指定されたときに調整してください。',
            },
          },
        },
      },
      {
        name: 'get_fund_history',
        description: '過去複数週分の資産レポートから、指定した1つの個別ファンド（銘柄）の'
          + '評価金額・評価損益の推移（各週の値・前回比の金額と%）を取得します。'
          + '「NVDAの推移は？」「〇〇ファンドはどう変わった？」「〇〇の資産推移をグラフにして」'
          + 'のように、個別ファンド単位で過去からの変化を尋ねられたときに使います'
          + '（get_finance_historyは資産合計＝全ファンド合算の推移、こちらは個別ファンド単位の'
          + '推移で別物です。個別ファンドについて聞かれたらこちらを使ってください）。'
          + 'fund_nameは部分一致で構いません（ティッカーだけ、正式名称の一部だけでも構いません）。'
          + '前回比の計算はサーバー側で行った結果をそのまま使い、自分で暗算しないでください。'
          + 'グラフ化を頼まれた場合はキャンバス表示機能のxychart-betaで、ここで渡された日付・'
          + '評価金額の値だけを使って作成してください（無いデータを創作しないこと）。'
          + '一致するファンドが見つからない、またはデータが1週分しか無い場合はエラーに'
          + 'なるので、その旨を正直に伝えてください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            fund_name: {
              type: 'STRING',
              description: '推移を知りたいファンド名・銘柄名（部分一致。例: "NVDA"、'
                + '"S&P500"、"ひふみプラス"）。',
            },
            weeks: {
              type: 'NUMBER',
              description: '遡る週数（省略時は直近26週分）。「半年分」「直近1ヶ月」のように'
                + '期間を指定されたときに調整してください。',
            },
          },
          required: ['fund_name'],
        },
      },
];

/**
 * 保有のヒートマップを作り、Obsidian の Vault へ保存する。
 * 図はここで完成させるので、受け取った側は返ってきたパスを貼るだけでよく、描き直しが起きない。
 *
 * @param {any} [args] institution（金融機関名の部分一致）・top_n（上位N件）
 * @param {any} [ctx] config
 * @returns {any} 保存したパスと要約。作れなければ error
 */
function createHoldingsHeatmap(args = {}, ctx = {}) {
  const config = ctx.config || {};
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.vault_path) {
    return { error: 'Obsidian連携が有効になっていないため、ヒートマップを保存できません。' };
  }
  const institution = String(args.institution || '').trim();
  const topN = Number.isInteger(args.top_n) ? args.top_n : 0;

  const built = buildHoldingsHeatmapSvg({ institution, topN });
  if (!built) {
    return { error: '前週と比較できる資産データが無いため、ヒートマップを作成できません。'
      + '（資産レポートが1回分しか無い場合は対前週比が出せず、色を塗る根拠がありません）' };
  }

  // ATTENTION: 日付はサーバーのローカル時刻で作ること。世界標準時で作ると、深夜に作った
  // ものが前日のファイル名になる。
  const _d = new Date();
  const stamp = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
  const suffix = institution ? `-${institution}` : '';
  const relPath = `08_assets/holdings-heatmap/${stamp}${suffix}.svg`;
  try {
    obsidianService.writeBinaryAsset(obs.vault_path, relPath, Buffer.from(built.svg, 'utf8'));
  } catch (e) {
    return { error: `ヒートマップの保存に失敗しました（${e.message}）` };
  }

  // 前週比の無い銘柄（今週から保有）は、上げ下げの比較から外す（値が無く例外になる）
  const top = [...built.rows].filter((r) => r._wowPct != null).sort((a, b) => b._wowPct - a._wowPct);
  const up = top.filter((r) => r._wowPct > 0).slice(0, 3);
  const down = top.filter((r) => r._wowPct < 0).slice(-3).reverse();
  const summary = [
    `${built.title}（${built.subtitle}）を作成しました。`,
    `画像のパス: ${relPath}`,
    'ノートへ貼るときは ![[' + relPath + ']] と書いてください。',
    up.length > 0 ? `上げた銘柄: ${up.map((r) => `${r.fund}（${r._wowPct.toFixed(2)}%）`).join('、')}` : '上げた銘柄はありませんでした。',
    `下げた銘柄: ${down.map((r) => `${r.fund}（${r._wowPct.toFixed(2)}%）`).join('、')}`,
  ].join('\n');

  secretaryStore.appendEntry('daily-briefings', { tool: 'create_holdings_heatmap', result: `${built.title}を作成しました。` });
  return { result: summary, imagePath: relPath };
}

const TOOL_HANDLERS = {
  create_holdings_heatmap: async (args, ctx) => createHoldingsHeatmap(args, ctx),

  get_finance_details: async (args) => getFinanceDetails(args),

  get_finance_history: async (args, ctx) => getFinanceHistory(args, ctx),

  get_fund_history: async (args) => getFundHistory(args),
};

module.exports = {
  TOOL_HANDLERS, TOOL_DECLARATIONS, updateFinanceReport, getFinanceDetails, getFinanceHistory, getFundHistory,
  // ATTENTION: 週次ノートのヒートマップと突き合わせの実装を共有するため、ここから公開する
  buildHoldingsWeekOverWeek, squarifiedTreemap, buildHoldingsTreemapRows, formatHoldingsTreemapCsv,
  buildHoldingsHeatmapSvg,
};
