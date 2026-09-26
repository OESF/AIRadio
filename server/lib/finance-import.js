/**
 * @file 証券会社・銀行の画面から届いた保有資産のデータの解析（楽天証券の CSV・PayPay 銀行の HTML）
 *
 * ブラウザの Tampermonkey のスクリプトが口座のページから送ってきたデータを、保有銘柄の一覧と
 * 合計に直す。受け口は routes/finance-import-routes.js、保存は finance-import-store.js。
 *
 * 解析をスクリプト側ではなくサーバーに置くのは、サイトの改修で壊れたときにサーバー側だけを直せば
 * 済むようにするため（スクリプトは「送るだけ」にして、以後さわらない）。
 *
 * ATTENTION: 数字の解析を LLM にさせないこと。同じ依頼でも毎回違う結果になる。
 * ATTENTION: 解析できなかったときは、黙って0件にせず、はっきりエラーを返すこと。間違った数値が
 * 静かに入る方が、失敗するよりはるかに危険。
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

/**
 * CSV の1行を、引用符に対応して列に分ける。
 *
 * 楽天証券の CSV は数量が "1,031,655" のように引用符の中にカンマを含むので、
 * 単純な split(',') では壊れる。
 *
 * @param {string} line CSV の1行
 * @returns {string[]} 列の値
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuote = false; }
      } else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * "+446,176"・"-5,999"・"1,408,800"・"556,648円" のような金額の文字を数値にする。
 *
 * ATTENTION: null と 0 を区別する。数字を1文字も含まないもの（"-"・"－"・"—"・空文字）は null を
 * 返す（「データなし」を0円として集計しないため）。PayPay 銀行は値なしを全角の "－" で書くので、
 * 文字を列挙せず「数字があるか」で判定している。
 *
 * @param {*} s 金額の文字
 * @returns {number|null} 数値（読めなければ null）
 */
function parseYen(s) {
  const t = String(s ?? '').trim();
  if (!/[0-9]/.test(t)) return null;
  const n = Number(t.replace(/[－−—]/g, '-').replace(/[,+\s円]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 取り込んだ明細のうち、保有量まで取れたのが何件かをログに残す。
 *
 * ATTENTION: 黙って0件のまま進めないこと。保有量が取れないと評価額の計算がスナップショット頼みの
 * 概算に落ちるが、数字そのものは出てしまうので、取れていないことに気づけない。
 *
 * @param {string} institution 金融機関の名前
 * @param {Array<any>} holdings 取り込んだ明細
 * @returns {void}
 */
function _logQuantityResult(institution, holdings) {
  const got = holdings.filter((h) => Number(h.quantity) > 0).length;
  const msg = `[FinanceImport] ${institution}: 保有量を取得 ${got}/${holdings.length}件`;
  if (got === 0) getLogger().warn(`${msg}（評価額からの概算になります）`);
  else getLogger().info(msg);
}

/**
 * 保有量（株数・口数）の列の見出しの候補。金融機関ごとに呼び方が違う。
 *
 * ATTENTION: 数量は「取れたら取る」任意の項目にすること。必須にすると、見出しが少し変わっただけで
 * 取り込み全体が例外で止まり、評価額まで入らなくなる（評価額があれば概算はできる）。
 */
const QUANTITY_HEADER_CANDIDATES = ['保有数量', '保有口数', '数量', '口数'];

/**
 * 見出しの一覧から、保有量の列の位置を探す（見つからなければ -1）。
 *
 * @param {string[]} header 見出しの並び
 * @param {boolean} [partial] true なら部分一致で探す（並べ替えの記号が付く表のため）
 * @returns {number} 列の位置。無ければ -1
 */
function findQuantityColumn(header, partial = false) {
  for (const name of QUANTITY_HEADER_CANDIDATES) {
    const i = partial
      ? header.findIndex((h) => String(h || '').includes(name))
      : header.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * "1,031,655"・"12.3456" のような保有量の文字を数値にする。小数（口数）もあるので parseYen とは分ける。
 *
 * @param {*} s 保有量の文字
 * @returns {number|null} 数値（読めなければ null）
 */
function parseQuantity(s) {
  const t = String(s ?? '').trim();
  if (!/[0-9]/.test(t)) return null;
  const n = Number(t.replace(/[,\s]/g, '').replace(/[株口]$/, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 楽天証券の「保有商品一覧」の CSV を解析する。
 *
 * ATTENTION: CSV は Shift_JIS（ページ本体は EUC-JP なので取り違えないこと）。
 * 構造は2部構成:
 *   ■資産合計欄     … 資産合計・種別ごとの小計
 *   ■ 保有商品詳細  … 1銘柄1行。列の位置は見出しの文字から引く（列の順番が変わっても壊れない）
 *
 * @param {Buffer|Uint8Array} buffer 受け取った生のバイト列
 * @returns {{institution: string, totalAssets: number|null, totalGainLoss: number|null,
 *   holdings: Array<Record<string, any>>, sourceLabel: string}} 機関名・資産合計・評価損益の合計・保有銘柄・出どころ
 * @throws {Error} 明細の見出しが見つからないなど、解析できなかった場合
 */
function parseRakutenCsv(buffer) {
  const text = new TextDecoder('shift_jis').decode(buffer);
  const lines = text.split(/\r?\n/);

  // ── 資産合計欄 ──
  let totalAssets = null;
  let totalGainLoss = null;
  for (const line of lines) {
    const c = parseCsvLine(line);
    if (c[0] === '資産合計') {
      totalAssets = parseYen(c[1]);
      totalGainLoss = parseYen(c[6]);
      break;
    }
  }

  // ── 保有商品詳細 ──
  // 列の位置は決め打ちにせず、見出しの文字から引く（楽天が列を足しても壊れないように）
  const headIdx = lines.findIndex((l) => {
    const c = parseCsvLine(l);
    return c[0] === '種別' && c.includes('銘柄') && c.some((x) => x.startsWith('時価評価額'));
  });
  if (headIdx === -1) {
    throw new Error('保有商品詳細のヘッダー行が見つかりませんでした（CSVの形式が変わった可能性があります）');
  }
  const head = parseCsvLine(lines[headIdx]);
  const col = (name) => head.indexOf(name);
  const idx = {
    assetClass: col('種別'),
    ticker: col('銘柄コード・ティッカー'),
    fund: col('銘柄'),
    account: col('口座'),
    valuation: head.indexOf('時価評価額[円]'),
    gainLoss: head.indexOf('評価損益[円]'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v === -1) throw new Error(`CSVに「${k}」に対応する列が見つかりませんでした`);
  }
  // 数量は任意（QUANTITY_HEADER_CANDIDATES 参照）。見出しが変わっても取り込みは止めない
  const quantityIdx = findQuantityColumn(head);
  if (quantityIdx === -1) {
    getLogger().warn(`[FinanceImport] 楽天証券: 保有量の列が見つかりません（見出し: ${head.join(' / ')}）`);
  }

  const holdings = [];
  for (let i = headIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) break;                 // 空行で明細セクションは終わり
    if (line.startsWith('"■')) break;        // 次のセクション（参考為替レート等）
    const c = parseCsvLine(line);
    const fund = (c[idx.fund] || '').trim();
    const valuation = parseYen(c[idx.valuation]);
    if (!fund || valuation == null) continue;
    holdings.push({
      institution: '楽天証券',
      fund,
      valuation,
      accountType: (c[idx.account] || '').trim() || null,
      assetClass: (c[idx.assetClass] || '').trim() || null,
      gainLoss: parseYen(c[idx.gainLoss]),
      ticker: (c[idx.ticker] || '').trim() || null,
      quantity: quantityIdx === -1 ? null : parseQuantity(c[quantityIdx]),
    });
  }

  if (holdings.length === 0) {
    throw new Error('保有銘柄が1件も読み取れませんでした（ログイン切れ、または明細が未表示の可能性があります）');
  }
  _logQuantityResult('楽天証券', holdings);
  return { institution: '楽天証券', totalAssets, totalGainLoss, holdings, sourceLabel: '楽天証券 保有商品一覧CSV' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PayPay 銀行の「投資信託トップ」のページの解析。
//
// PayPay 銀行には CSV のダウンロードが無いので、スクリプトがページの HTML をそのまま送り、
// ここで表を読む。このページの表は、セルの中にさらに table が入っている（見出しの行と合計の行）。
// 入れ子の分まで拾うと列がずれるので、table の深さを数えながら、今の表に直接属する行・セルだけを
// 取り出す道具（topLevelTables・topLevelSegments）を使う。
//
// ATTENTION: 正規表現1本で表を読もうとしないこと。列が1つずれても例外にならず、静かに間違った
// 金額が入るという最悪の壊れ方をする。

/**
 * HTML の実体参照を戻す（このページに出てくるものだけで足りる）。
 *
 * @param {*} s HTML の文字
 * @returns {string} 戻した文字
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * タグ（script・style は中身ごと）を落として表示される文字だけにする。空白は1つに畳む。
 *
 * @param {*} html HTML
 * @returns {string} 文字
 */
function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/**
 * 入れ子の table を飛ばしながら、直下の要素（tr や td・th）だけを切り出す。
 * 閉じタグが無い HTML に備え、次の開始タグでも1つの要素として確定させる。
 *
 * @param {string} html 親の要素の中身
 * @param {string[]} tags 取り出したいタグ名（['tr'] か ['td','th']）
 * @returns {{tag: string, html: string}[]} タグ名と中身
 */
function topLevelSegments(html, tags) {
  const re = /<(\/?)(table|tr|td|th)\b[^>]*>/gi;
  const out = [];
  let depth = 0;   // 入れ子tableの深さ。0のときだけ「自分の表」
  let open = null;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'table') {
      depth += closing ? -1 : 1;
      if (depth < 0) depth = 0;
      continue;
    }
    if (depth !== 0) continue;
    if (!open) {
      if (!closing && tags.includes(tag)) open = { tag, start: m.index + m[0].length };
      continue;
    }
    // 閉じタグで確定。閉じ忘れのHTMLに備え、次の開始タグでも確定させる。
    if (closing && tag === open.tag) {
      out.push({ tag: open.tag, html: html.slice(open.start, m.index) });
      open = null;
    } else if (!closing && tags.includes(tag)) {
      out.push({ tag: open.tag, html: html.slice(open.start, m.index) });
      open = { tag, start: m.index + m[0].length };
    }
  }
  if (open) out.push({ tag: open.tag, html: html.slice(open.start) });
  return out;
}

/**
 * 文書の中の、入れ子になっていない table の中身を順に返す。
 *
 * @param {string} html 文書の HTML
 * @returns {string[]} table の中身
 */
function topLevelTables(html) {
  const re = /<table\b[^>]*>|<\/table\s*>/gi;
  const out = [];
  let depth = 0;
  let contentStart = -1;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] !== '/') {
      if (depth === 0) contentStart = m.index + m[0].length;
      depth += 1;
    } else {
      depth -= 1;
      if (depth <= 0) {
        if (contentStart !== -1) out.push(html.slice(contentStart, m.index));
        depth = 0;
        contentStart = -1;
      }
    }
  }
  return out;
}

/**
 * セルの中の最初の div の文字を返す（PayPay は1つのセルに評価金額と基準価額を縦に並べるため）。
 *
 * @param {string} cellHtml セルの HTML
 * @returns {string} 文字
 */
function firstDivText(cellHtml) {
  const m = /<div\b[^>]*>([\s\S]*?)<\/div\s*>/i.exec(cellHtml);
  return stripTags(m ? m[1] : cellHtml);
}

/**
 * PayPay 銀行の「投資信託トップ」のページの HTML を解析する。
 *
 * 読むのは2か所:
 *   ご利用者情報     … 普通預金の残高（投資信託ではないが、資産の合計に要る）
 *   お預かり残高一覧 … 1明細1行。同じファンドでも口座区分ごとに行が分かれる
 *
 * ATTENTION: 「トータルリターン（総合損益）」の表は使わないこと。そちらの損益は売却済み・受取済みの
 * 金額まで含む累計で、楽天の CSV の評価損益（今の含み損益）とは意味が違う。混ぜると資産全体の
 * 損益がおかしくなる。
 *
 * 表は class 名ではなく見出しの文字で探す（体裁が変わっても壊れにくい。見出しに「ファンド名」
 * 「口座区分」「評価損益」がそろう表は、このページでは一覧表だけ）。ページが自分で出している合計と
 * 読み取った合計を突き合わせ、ずれていれば warnings で知らせる。
 *
 * @param {string|Buffer|Uint8Array} input ページの HTML（スクリプトから文字列で届く想定）
 * @returns {{institution: string, totalAssets: number, totalGainLoss: number, holdings: Array<Record<string, any>>,
 *   sourceLabel: string, asOf: string|null, warnings: string[]}} 機関名・合計・保有・出どころ・基準日・注意
 * @throws {Error} 一覧表が見つからない・1件も読めない場合
 */
function parsePayPayBankHtml(input) {
  const html = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  const tables = topLevelTables(html);

  // ── お預かり残高一覧を見出しで特定する ──
  let listRows = null;
  let header = null;
  for (const t of tables) {
    const rows = topLevelSegments(t, ['tr']);
    for (const r of rows) {
      const cells = topLevelSegments(r.html, ['td', 'th']);
      if (cells.length < 5 || cells.some((c) => c.tag !== 'th')) continue;
      const texts = cells.map((c) => stripTags(c.html));
      const joined = texts.join('|');
      if (joined.includes('ファンド名') && joined.includes('口座区分') && joined.includes('評価損益')) {
        listRows = rows;
        header = texts;
        break;
      }
    }
    if (listRows) break;
  }
  if (!listRows) {
    throw new Error('「お預かり残高一覧」の表が見つかりませんでした（ログイン切れ、またはページの構成が変わった可能性があります）');
  }

  // 列の位置は見出しの文字から引く。並べ替えると見出しに「▲」が付くので部分一致で見る。
  const colOf = (kw) => header.findIndex((h) => h.includes(kw));
  const idx = {
    fund: colOf('ファンド名'),
    account: colOf('口座区分'),
    valuation: colOf('評価金額'),
    gainLoss: colOf('評価損益'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v === -1) throw new Error(`一覧表に「${k}」に対応する列が見つかりませんでした`);
  }
  // 数量は任意。見出しは並べ替えの記号が付くので部分一致で探す
  const quantityIdx = findQuantityColumn(header || [], true);
  if (quantityIdx === -1) {
    getLogger().warn(`[FinanceImport] PayPay銀行: 保有量の列が見つかりません（見出し: ${(header || []).join(' / ')}）`);
  }

  const holdings = [];
  let declaredValuationTotal = null;
  let declaredGainLossTotal = null;

  for (const r of listRows) {
    const cells = topLevelSegments(r.html, ['td', 'th']);
    if (cells.length !== header.length) continue;

    // 合計の行は先頭が th（3列分の colspan）。ページが出している合計を控えて、後で突き合わせる。
    if (cells.some((c) => c.tag === 'th')) {
      if (stripTags(r.html).includes('合計')) {
        const nums = cells.map((c) => parseYen(stripTags(c.html))).filter((n) => n != null);
        if (nums.length >= 1) declaredValuationTotal = nums[0];
        if (nums.length >= 2) declaredGainLossTotal = nums[1];
      }
      continue;
    }

    const fund = stripTags(cells[idx.fund].html);
    const valuation = parseYen(firstDivText(cells[idx.valuation].html));
    if (!fund || valuation == null) continue;

    // 口座区分のセルは「再投資」と「NISA（成長投資）」のように改行で2段になっている。下の段が口座区分。
    const accountParts = cells[idx.account].html
      .split(/<br\s*\/?>/i)
      .map((x) => stripTags(x))
      .filter(Boolean);
    const accountType = accountParts.length ? accountParts[accountParts.length - 1] : null;

    // PayPay の中のファンドコード。市場のティッカーではないので ticker には入れない。
    const codeMatch = /fund_code=(\d+)/.exec(cells[idx.fund].html);

    holdings.push({
      institution: 'PayPay銀行',
      fund,
      valuation,
      accountType,
      assetClass: '投資信託',
      gainLoss: parseYen(stripTags(cells[idx.gainLoss].html)),
      ticker: null,
      fundCode: codeMatch ? codeMatch[1] : null,
      quantity: quantityIdx === -1 || !cells[quantityIdx]
        ? null : parseQuantity(firstDivText(cells[quantityIdx].html)),
    });
  }

  if (holdings.length === 0) {
    throw new Error('保有ファンドが1件も読み取れませんでした（ログイン切れ、または明細が未表示の可能性があります）');
  }

  // ── 普通預金残高（ご利用者情報）──
  // 「普通預金残高」の見出しのセルを探し、その1つ下の行の同じ列を読む。
  let cashBalance = null;
  for (const t of tables) {
    const rows = topLevelSegments(t, ['tr']);
    for (let i = 0; i < rows.length - 1; i += 1) {
      const cells = topLevelSegments(rows[i].html, ['td', 'th']);
      const at = cells.findIndex((c) => stripTags(c.html).includes('普通預金残高'));
      if (at === -1) continue;
      const below = topLevelSegments(rows[i + 1].html, ['td', 'th']);
      if (below[at]) cashBalance = parseYen(stripTags(below[at].html));
      break;
    }
    if (cashBalance != null) break;
  }
  if (cashBalance != null) {
    holdings.push({
      institution: 'PayPay銀行',
      fund: '普通預金',
      valuation: cashBalance,
      accountType: null,
      assetClass: '預金',
      gainLoss: null,
      ticker: null,
      fundCode: null,
    });
  }

  const sum = (key) => holdings.reduce((a, h) => a + (h[key] == null ? 0 : h[key]), 0);
  const totalAssets = sum('valuation');
  const totalGainLoss = sum('gainLoss');

  // ページが自分で出している合計と突き合わせる。ずれていたら黙って通さず知らせる。
  const warnings = [];
  const fundValuation = totalAssets - (cashBalance || 0);
  if (declaredValuationTotal != null && declaredValuationTotal !== fundValuation) {
    warnings.push(`評価金額の合計がページの表示と一致しません（読み取り ${fundValuation} / 表示 ${declaredValuationTotal}）`);
  }
  if (declaredGainLossTotal != null && declaredGainLossTotal !== totalGainLoss) {
    warnings.push(`評価損益の合計がページの表示と一致しません（読み取り ${totalGainLoss} / 表示 ${declaredGainLossTotal}）`);
  }
  if (cashBalance == null) {
    warnings.push('普通預金残高を読み取れませんでした（投資信託のみの合計になっています）');
  }

  const asOf = /基準日[\s　]*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(html);

  _logQuantityResult('PayPay銀行', holdings);
  return {
    institution: 'PayPay銀行',
    totalAssets,
    totalGainLoss,
    holdings,
    sourceLabel: 'PayPay銀行 お預かり残高一覧',
    asOf: asOf ? `${asOf[1]}-${String(asOf[2]).padStart(2, '0')}-${String(asOf[3]).padStart(2, '0')}` : null,
    warnings,
  };
}

module.exports = {
  parseRakutenCsv,
  parsePayPayBankHtml,
  parseCsvLine,
  parseYen,
};

