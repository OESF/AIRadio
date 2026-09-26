/**
 * @file 保有資産のヒートマップ（ツリーマップ）の SVG を描く
 *
 * 箱の大きさが評価額、色が対前週比の、一般的なヒートマップを SVG の文字列として組み立てる。
 * 資産レポートでは、ここで完成させた図をヘルパーに保存させるだけにする。
 *
 * ATTENTION: 図の描画を LLM（ヘルパーの matplotlib など）に任せないこと。任せると頼むたびに違う図になった
 *            （全部同じ大きさのマス目・文字の重なり・ツリーマップですらない表など）。レイアウトの座標だけを
 *            渡しても、絞り込み（「楽天証券だけ」など）が入るとモデルが描き直してしまった。
 *
 * SVG にしているのは、サーバーに PNG を描く手段が無い（依存を増やしたくない）ためで、SVG なら依存なしに
 * 文字列で作れ、Obsidian でもそのまま表示でき、拡大しても劣化しない。
 *
 * 主な利用元: lib/secretary-tools-finance.js
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

/**
 * 対前週比の色（赤〜黄〜緑。RdYlGn と同じ考え方）。0 付近が淡い黄、マイナスが赤、プラスが緑。
 * @param {number} t -1〜+1
 * @returns {string} 「rgb(r,g,b)」の形
 */
function divergingColor(t) {
  const stops = [
    [-1.0, [165, 0, 38]], [-0.5, [244, 109, 67]], [-0.15, [254, 224, 139]],
    [0.0, [255, 255, 191]],
    [0.15, [217, 239, 139]], [0.5, [102, 189, 99]], [1.0, [0, 104, 55]],
  ];
  const v = Math.max(-1, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i += 1) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (v >= p0 && v <= p1) {
      const k = p1 === p0 ? 0 : (v - p0) / (p1 - p0);
      const c = c0.map((c0i, j) => Math.round(c0i + (c1[j] - c0i) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(255,255,191)';
}

/**
 * 背景の色に対して読みやすい文字の色（明るさで白と黒を切り替える）。
 * @param {string} rgb 「rgb(r,g,b)」の形
 * @returns {string}
 */
function textColorOn(rgb) {
  const m = rgb.match(/(\d+),(\d+),(\d+)/);
  if (!m) return '#111';
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff';
}

/** SVG に入れる文字の <・>・& を置き換える。 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 全角を1、半角を0.5として文字の幅を数える（日本語の銘柄名が収まるかを判定するため。厳密ではない）。
 * @param {string} s
 * @returns {number}
 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\x00-\x7F｡-ﾟ]/.test(ch) ? 0.5 : 1;
  return w;
}

/**
 * 表示の幅が max を超えたら、末尾を「…」にして切る。
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncateToWidth(s, max) {
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = /[\x00-\x7F｡-ﾟ]/.test(ch) ? 0.5 : 1;
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
}

const fmtMan = (yen) => `${(yen / 10000).toFixed(1)}万円`;
const fmtPct = (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
/** 今週から持ち始めた銘柄（前週比が無い）の色。 */
const NEW_HOLDING_FILL = 'rgb(189,189,189)';

/**
 * ツリーマップの SVG を組み立てる（タイトル・タイル・色の凡例）。
 *
 * @param {Array<Record<string, any>>} rows `_rect`（squarifiedTreemap の結果。100×100 の相対座標）と、
 *   fund（銘柄名）・valuation（評価額）・_wowPct（対前週比。無ければ今週から持ち始めた銘柄）を持つ行
 * @param {{title:string, subtitle?:string, width?:number, height?:number}} [opts]
 * @returns {string} SVG の文字列
 */
function renderTreemapSvg(rows, { title, subtitle = '', width = 1600, height = 900 } = {}) {
  const PAD_TOP = subtitle ? 84 : 60;
  const PAD_BOTTOM = 96;   // カラーバー
  const PAD_SIDE = 24;
  const plotW = width - PAD_SIDE * 2;
  const plotH = height - PAD_TOP - PAD_BOTTOM;

  // 色の幅。1つの外れ値で他が全部淡くならないよう、最低でも ±3% にする
  const maxAbs = Math.max(3, ...rows.filter((r) => r._wowPct != null).map((r) => Math.abs(r._wowPct)));

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Hiragino Sans, Yu Gothic, Meiryo, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${width / 2}" y="38" text-anchor="middle" font-size="26" font-weight="bold" fill="#111">${esc(title)}</text>`);
  if (subtitle) {
    parts.push(`<text x="${width / 2}" y="66" text-anchor="middle" font-size="15" fill="#555">${esc(subtitle)}</text>`);
  }

  for (const r of rows) {
    const x = PAD_SIDE + (r._rect.x / 100) * plotW;
    const y = PAD_TOP + (r._rect.y / 100) * plotH;
    const w = (r._rect.w / 100) * plotW;
    const h = (r._rect.h / 100) * plotH;
    // 前週比の無い銘柄（今週から保有）は灰色にする。赤〜黄〜緑のどこかの色にすると「横ばい」と誤読される
    const isNew = r._wowPct == null;
    const fill = isNew ? NEW_HOLDING_FILL : divergingColor(r._wowPct / maxAbs);
    const fg = textColorOn(fill);
    parts.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="#ffffff" stroke-width="2"/>`);

    // 文字は収まるときだけ描く。大きさはタイルから決め、収まらない行は出さない（隣のタイルに重ならないように）
    const fs = Math.max(9, Math.min(20, Math.sqrt(w * h) / 7));
    // BUGFIX: 全角1文字の幅は文字の大きさより少し広い。係数と余白は小さくしないこと
    //         （係数0.95・余白10px では、長い投資信託の名前が隣のタイルにはみ出した）
    const ADVANCE = 1.06;
    const PAD = 16;
    const nameBudget = (w - PAD) / (fs * ADVANCE);
    const lineH = fs * 1.25;
    const lines = [];
    if (w > 34 && h > lineH * 1.4 && nameBudget >= 3) {
      const name = truncateToWidth(r.fund, nameBudget);
      // 切り詰めても収まらなければ、名前ごと描かない
      if (displayWidth(name) * fs * ADVANCE <= w - PAD) lines.push(name);
    }
    if (w > 58 && h > lineH * 2.6) lines.push(fmtMan(r.valuation));
    if (w > 58 && h > lineH * 3.6) lines.push(isNew ? '前週比なし' : fmtPct(r._wowPct));
    if (lines.length === 0) continue;

    const cy = y + h / 2 - ((lines.length - 1) * lineH) / 2 + fs * 0.35;
    lines.forEach((line, i) => {
      const weight = i === 0 ? '600' : '400';
      const size = i === 0 ? fs : fs * 0.92;
      parts.push(`<text x="${(x + w / 2).toFixed(2)}" y="${(cy + i * lineH).toFixed(2)}" text-anchor="middle" font-size="${size.toFixed(1)}" font-weight="${weight}" fill="${fg}">${esc(line)}</text>`);
    });
  }

  // ── 色の凡例 ──
  const barW = Math.min(700, plotW * 0.55);
  const barX = (width - barW) / 2;
  const barY = height - 58;
  parts.push('<defs><linearGradient id="cb" x1="0" x2="1">');
  for (let i = 0; i <= 20; i += 1) {
    parts.push(`<stop offset="${(i / 20 * 100).toFixed(0)}%" stop-color="${divergingColor(-1 + (i / 20) * 2)}"/>`);
  }
  parts.push('</linearGradient></defs>');
  parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="18" fill="url(#cb)" stroke="#999" stroke-width="0.5"/>`);
  for (let i = 0; i <= 4; i += 1) {
    const v = -maxAbs + (i / 4) * maxAbs * 2;
    const tx = barX + (i / 4) * barW;
    parts.push(`<text x="${tx.toFixed(1)}" y="${barY + 34}" text-anchor="middle" font-size="13" fill="#333">${v.toFixed(1)}</text>`);
  }
  parts.push(`<text x="${width / 2}" y="${barY - 8}" text-anchor="middle" font-size="13" fill="#333">面積 = 評価金額　／　色 = 対前週比（%）${rows.some((r) => r._wowPct == null) ? '　／　灰色 = 前週比なし（今週から保有）' : ''}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

module.exports = { renderTreemapSvg, divergingColor, truncateToWidth, displayWidth };
