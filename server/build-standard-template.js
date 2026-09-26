#!/usr/bin/env node
/**
 * @file プレゼンテーション作成の標準テンプレート（Google スライド）を1つ作るスクリプト
 *
 * 使い方: node server/build-standard-template.js [--update <ID>]
 * 出力:   作ったファイルの ID と URL。管理画面の「スライドのテンプレート」で登録する。
 * --update を付けると、登録済みのテンプレートを作り直す（ID が変わらないので登録し直さなくてよい）。
 *
 * テンプレートは本来、利用者が Google スライドの画面で作るもの。白紙から作るのは大変なので、よい出発点を1回だけ
 * 用意する。作ったあとはスライドの画面で自由に変えてよく、このスクリプトを再び動かす必要は無い（動かすと別の
 * ファイルができる）。
 *
 * ATTENTION: 構図はレイアウトではなく「見本スライド」として作る。Slides API ではレイアウトの名前を変えられず、
 *            プレースホルダーも作れない。さらにレイアウトに置いた {{変数}} はスライドごとに置き換えられない（試すと
 *            文字が {{カード1数値}} のまま残った）。スライドを複製すれば要素が実体として写るので、置き換えられる。
 *
 * 利用者が後から変えるときの約束事:
 *   - 意味のある名前は、画面の外（負の座標）の {{LAYOUT_NAME:名前}} で付ける
 *   - 差し込み口は {{名前}} と書いたテキストボックス
 *   - 図・グラフの置き場所は {{CHART}}・{{IMAGE}}
 *   - ロゴ・フッター・背景はマスターに置く（全スライドに引き継がれる）
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

const fs = require('fs');
const path = require('path');
const GoogleService = require('./services/google-service');

const CREDENTIALS_PATH = path.join(__dirname, 'data', 'credentials.json');
/** インチを EMU に変える（Slides API の長さの単位）。 */
const IN = (v) => Math.round(v * 914400);

// 配色。落ち着いた紫を1つのアクセントにし、対比が要るところだけ深いティールを使う。AI Radio のネオンの配色より
// 彩度を落としてあるのは、印刷や投影に耐えるようにするため
const C = {
  bg:     '#f5f4f7',
  card:   '#ffffff',
  ink:    '#1b1b21',
  sub:    '#5b5768',
  faint:  '#8a8598',
  line:   '#e0dce8',
  accent: '#7b2fbe',
  teal:   '#0f7a91',
  dark:   '#17161d',
};
const FONT = 'Noto Sans JP';

// アイコンは Material Symbols Outlined の合字で出す（「folder」と書くとフォルダーの字形になり、色と大きさも効く）。
// ATTENTION: 無い名前を書くと文字がそのまま出て崩れる。使える名前は presentation-render.js の ICON_NAMES で確かめる。
const ICON_FONT = 'Material Symbols Outlined';

/** 要素の ID を作る（通し番号） */
let _n = 0;
const oid = (p) => `tpl_${p}_${String(++_n).padStart(3, '0')}`;

/**
 * 「#rrggbb」を Slides API の色（0〜1）にする。
 * @param {string} hex
 * @returns {{ red: number, green: number, blue: number }}
 */
function rgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return { red: parseInt(m[1], 16) / 255, green: parseInt(m[2], 16) / 255, blue: parseInt(m[3], 16) / 255 };
}

/**
 * 図形を置くリクエスト（位置と大きさはインチ）。
 * @param {string} page ページ（スライドかマスター）の ID
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @param {{ hex: string, kind?: string, outline?: string|null, alpha?: number, back?: boolean }} style
 *   back は最背面へ送る
 * @returns {Array<any>}
 */
function shape(page, { x, y, w, h }, { hex, kind = 'ROUND_RECTANGLE', outline = null, alpha = 1, back = false }) {
  const id = oid('s');
  const reqs = [
    { createShape: { objectId: id, shapeType: kind, elementProperties: { pageObjectId: page,
      size: { width: { magnitude: IN(w), unit: 'EMU' }, height: { magnitude: IN(h), unit: 'EMU' } },
      transform: { scaleX: 1, scaleY: 1, translateX: IN(x), translateY: IN(y), unit: 'EMU' } } } },
    { updateShapeProperties: { objectId: id, shapeProperties: {
      shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb(hex) }, alpha } },
      outline: outline
        ? { outlineFill: { solidFill: { color: { rgbColor: rgb(outline) } } }, weight: { magnitude: 9525, unit: 'EMU' }, dashStyle: 'SOLID' }
        : { propertyState: 'NOT_RENDERED' } },
      fields: 'shapeBackgroundFill,outline' } },
  ];
  if (back) reqs.push({ updatePageElementsZOrder: { pageElementObjectIds: [id], operation: 'SEND_TO_BACK' } });
  return reqs;
}

/**
 * テキストボックスを置くリクエスト。
 * @param {string} page
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @param {string} body 文字（{{名前}} は差し込み口）
 * @param {{ size?: number, hex?: string, bold?: boolean, align?: string }} [style]
 * @returns {Array<any>}
 */
function text(page, { x, y, w, h }, body, { size = 14, hex = C.ink, bold = false, align = 'START' } = {}) {
  const id = oid('t');
  return [
    { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: page,
      size: { width: { magnitude: IN(w), unit: 'EMU' }, height: { magnitude: IN(h), unit: 'EMU' } },
      transform: { scaleX: 1, scaleY: 1, translateX: IN(x), translateY: IN(y), unit: 'EMU' } } } },
    { insertText: { objectId: id, text: body } },
    { updateTextStyle: { objectId: id, style: { fontFamily: FONT, fontSize: { magnitude: size, unit: 'PT' }, bold,
      foregroundColor: { opaqueColor: { rgbColor: rgb(hex) } } },
      fields: 'fontFamily,fontSize,bold,foregroundColor', textRange: { type: 'ALL' } } },
    { updateParagraphStyle: { objectId: id, style: { alignment: align }, fields: 'alignment', textRange: { type: 'ALL' } } },
  ];
}

/**
 * アイコンの差し込み口（複製のときに「folder」などの名前に置き換わり、字形になる）。
 * @param {string} page
 * @param {{ x: number, y: number, size?: number }} pos
 * @param {string} key 差し込み口の名前
 * @param {{ hex?: string, pt?: number }} [style]
 * @returns {Array<any>}
 */
function icon(page, { x, y, size = 0.55 }, key, { hex = C.accent, pt = 26 } = {}) {
  const id = oid('i');
  return [
    { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: page,
      size: { width: { magnitude: IN(size * 1.8), unit: 'EMU' }, height: { magnitude: IN(size), unit: 'EMU' } },
      transform: { scaleX: 1, scaleY: 1, translateX: IN(x), translateY: IN(y), unit: 'EMU' } } } },
    { insertText: { objectId: id, text: `{{${key}}}` } },
    { updateTextStyle: { objectId: id, style: { fontFamily: ICON_FONT,
      fontSize: { magnitude: pt, unit: 'PT' }, foregroundColor: { opaqueColor: { rgbColor: rgb(hex) } } },
      fields: 'fontFamily,fontSize,foregroundColor', textRange: { type: 'ALL' } } },
  ];
}

/**
 * 見本スライドの共通部分（画面の外の名前の印・見出し・見出しの下のアクセントの罫線）。
 * @param {string} id スライドの ID
 * @param {string} name レイアウトの名前
 * @param {{ dark?: boolean, withTitle?: boolean }} [opts]
 * @returns {Array<any>}
 */
function slideHead(id, name, { dark = false, withTitle = true } = {}) {
  const reqs = [
    { createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    // 名前は画面の外に置く（画面の外の要素は描かれない）
    ...text(id, { x: -4, y: -1, w: 3.5, h: 0.3 }, `{{LAYOUT_NAME:${name}}}`, { size: 8, hex: C.faint }),
  ];
  if (dark) {
    reqs.push(...shape(id, { x: 0, y: 0, w: 10, h: 5.625 }, { hex: C.dark, kind: 'RECTANGLE', back: true }));
  }
  if (withTitle) {
    reqs.push(...text(id, { x: 0.6, y: 0.5, w: 8.8, h: 0.62 }, '{{見出し}}',
      { size: 26, bold: true, hex: dark ? '#ffffff' : C.ink }));
    reqs.push(...shape(id, { x: 0.6, y: 1.16, w: 1.4, h: 0.035 }, { hex: C.accent, kind: 'RECTANGLE' }));
  }
  return reqs;
}

// ─── 見本スライド ─────────────────────────────────────
// 同じ骨格が続かないよう、用途の違う構図を揃える。

const LIBRARY = [
  // 1. 表紙
  (id) => [
    { createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...text(id, { x: -4, y: -1, w: 3.5, h: 0.3 }, '{{LAYOUT_NAME:表紙}}', { size: 8, hex: C.faint }),
    ...shape(id, { x: 0, y: 0, w: 10, h: 5.625 }, { hex: C.dark, kind: 'RECTANGLE', back: true }),
    ...shape(id, { x: 0.9, y: 3.05, w: 1.8, h: 0.05 }, { hex: C.accent, kind: 'RECTANGLE' }),
    ...text(id, { x: 0.9, y: 1.95, w: 8.2, h: 1.0 }, '{{表題}}', { size: 36, bold: true, hex: '#ffffff' }),
    ...text(id, { x: 0.9, y: 3.25, w: 8.2, h: 0.6 }, '{{副題}}', { size: 15, hex: '#b5b1c4' }),
  ],
  // 2. 章扉
  (id) => [
    { createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...text(id, { x: -4, y: -1, w: 3.5, h: 0.3 }, '{{LAYOUT_NAME:章扉}}', { size: 8, hex: C.faint }),
    ...shape(id, { x: 0, y: 2.25, w: 10, h: 1.2 }, { hex: C.accent, kind: 'RECTANGLE', alpha: 0.08 }),
    ...text(id, { x: 0.9, y: 2.3, w: 8.2, h: 0.7 }, '{{章題}}', { size: 30, bold: true, hex: C.accent }),
    ...text(id, { x: 0.9, y: 3.05, w: 8.2, h: 0.4 }, '{{ひとこと}}', { size: 13, hex: C.sub }),
  ],
  // 3. 箇条書き
  (id) => [
    ...slideHead(id, '箇条書き'),
    ...text(id, { x: 0.6, y: 1.55, w: 8.8, h: 2.9 }, '{{本文}}', { size: 17, hex: C.ink }),
  ],
  // 4. 3カード比較（アイコン付き）
  (id) => {
    const r = slideHead(id, '3カード比較');
    [{ x: 0.6, k: 'カード1', c: C.accent }, { x: 3.55, k: 'カード2', c: C.teal }, { x: 6.5, k: 'カード3', c: C.accent }]
      .forEach((cd) => {
        r.push(...shape(id, { x: cd.x, y: 1.55, w: 2.9, h: 2.15 }, { hex: C.card, outline: C.line }));
        r.push(...shape(id, { x: cd.x, y: 1.55, w: 2.9, h: 0.06 }, { hex: cd.c, kind: 'RECTANGLE' }));
        r.push(...icon(id, { x: cd.x + 0.22, y: 1.75 }, `${cd.k}アイコン`, { hex: cd.c, pt: 26 }));
        r.push(...text(id, { x: cd.x + 0.25, y: 2.35, w: 2.4, h: 0.35 }, `{{${cd.k}ラベル}}`, { size: 13.5, bold: true }));
        r.push(...text(id, { x: cd.x + 0.25, y: 2.75, w: 2.4, h: 0.9 }, `{{${cd.k}説明}}`, { size: 10.5, hex: C.sub }));
      });
    r.push(...shape(id, { x: 0.6, y: 3.95, w: 8.8, h: 0.75 }, { hex: C.card, outline: C.accent }));
    r.push(...shape(id, { x: 0.6, y: 3.95, w: 0.06, h: 0.75 }, { hex: C.accent, kind: 'RECTANGLE' }));
    r.push(...text(id, { x: 0.85, y: 4.12, w: 8.3, h: 0.45 }, '{{結論}}', { size: 12 }));
    return r;
  },
  // 4b. 3つの数値（KPI）。数値が主役の場面はこちらで受ける
  (id) => {
    const r = slideHead(id, '3つの数値');
    [{ x: 0.6, k: '数値1', c: C.accent }, { x: 3.55, k: '数値2', c: C.teal }, { x: 6.5, k: '数値3', c: C.accent }]
      .forEach((cd) => {
        r.push(...shape(id, { x: cd.x, y: 1.6, w: 2.9, h: 2.3 }, { hex: C.card, outline: C.line }));
        r.push(...text(id, { x: cd.x + 0.25, y: 1.85, w: 2.4, h: 0.3 }, `{{${cd.k}ラベル}}`, { size: 11, bold: true, hex: C.sub }));
        r.push(...text(id, { x: cd.x + 0.25, y: 2.2, w: 2.4, h: 0.8 }, `{{${cd.k}}}`, { size: 34, bold: true, hex: cd.c }));
        r.push(...text(id, { x: cd.x + 0.25, y: 3.05, w: 2.4, h: 0.7 }, `{{${cd.k}補足}}`, { size: 10, hex: C.sub }));
      });
    r.push(...text(id, { x: 0.6, y: 4.15, w: 8.8, h: 0.4 }, '{{結論}}', { size: 12 }));
    return r;
  },
  // 5. 左右対比
  (id) => {
    const r = slideHead(id, '左右対比');
    r.push(...shape(id, { x: 0.6, y: 1.55, w: 4.3, h: 2.9 }, { hex: C.card, outline: C.line }));
    r.push(...shape(id, { x: 0.6, y: 1.55, w: 4.3, h: 0.06 }, { hex: C.accent, kind: 'RECTANGLE' }));
    r.push(...icon(id, { x: 0.87, y: 1.78 }, '左のアイコン', { hex: C.accent, pt: 22 }));
    r.push(...text(id, { x: 1.55, y: 1.86, w: 3.05, h: 0.4 }, '{{左の見出し}}', { size: 15, bold: true, hex: C.accent }));
    r.push(...text(id, { x: 0.9, y: 2.4, w: 3.7, h: 1.9 }, '{{左の本文}}', { size: 12, hex: C.sub }));
    r.push(...shape(id, { x: 5.1, y: 1.55, w: 4.3, h: 2.9 }, { hex: C.card, outline: C.line }));
    r.push(...shape(id, { x: 5.1, y: 1.55, w: 4.3, h: 0.06 }, { hex: C.teal, kind: 'RECTANGLE' }));
    r.push(...icon(id, { x: 5.37, y: 1.78 }, '右のアイコン', { hex: C.teal, pt: 22 }));
    r.push(...text(id, { x: 6.05, y: 1.86, w: 3.05, h: 0.4 }, '{{右の見出し}}', { size: 15, bold: true, hex: C.teal }));
    r.push(...text(id, { x: 5.4, y: 2.4, w: 3.7, h: 1.9 }, '{{右の本文}}', { size: 12, hex: C.sub }));
    r.push(...text(id, { x: 0.6, y: 4.62, w: 8.8, h: 0.4 }, '{{結論}}', { size: 12 }));
    return r;
  },
  // 6. グラフ＋結論
  (id) => {
    const r = slideHead(id, 'グラフと結論');
    r.push(...shape(id, { x: 0.6, y: 1.5, w: 6.4, h: 3.2 }, { hex: '#eceaf2', kind: 'RECTANGLE' }));
    r.push(...text(id, { x: 0.62, y: 1.52, w: 6.3, h: 0.3 }, '{{CHART}}', { size: 10, hex: C.faint }));
    r.push(...shape(id, { x: 7.25, y: 1.5, w: 2.15, h: 3.2 }, { hex: C.card, outline: C.line }));
    r.push(...text(id, { x: 7.5, y: 1.75, w: 1.7, h: 0.3 }, '{{読み取り方}}', { size: 11, bold: true, hex: C.accent }));
    r.push(...text(id, { x: 7.5, y: 2.1, w: 1.7, h: 2.4 }, '{{補足}}', { size: 10.5, hex: C.sub }));
    r.push(...text(id, { x: 0.6, y: 4.85, w: 8.8, h: 0.4 }, '{{結論}}', { size: 12 }));
    return r;
  },
  // 7. 画像＋説明
  (id) => {
    const r = slideHead(id, '画像と説明');
    r.push(...shape(id, { x: 0.6, y: 1.5, w: 5.4, h: 3.2 }, { hex: '#eceaf2', kind: 'RECTANGLE' }));
    r.push(...text(id, { x: 0.62, y: 1.52, w: 5.3, h: 0.3 }, '{{IMAGE}}', { size: 10, hex: C.faint }));
    r.push(...text(id, { x: 6.3, y: 1.6, w: 3.1, h: 0.4 }, '{{小見出し}}', { size: 15, bold: true, hex: C.accent }));
    r.push(...text(id, { x: 6.3, y: 2.1, w: 3.1, h: 2.6 }, '{{説明}}', { size: 12, hex: C.sub }));
    r.push(...text(id, { x: 0.6, y: 4.85, w: 8.8, h: 0.4 }, '{{キャプション}}', { size: 10.5, hex: C.faint }));
    return r;
  },
  // 8. 4ステップのフロー
  (id) => {
    const r = slideHead(id, 'フロー図（4ステップ）');
    [0, 1, 2, 3].forEach((i) => {
      const x = 0.6 + i * 2.25;
      r.push(...shape(id, { x, y: 1.9, w: 2.05, h: 1.5 }, { hex: C.card, outline: C.line }));
      r.push(...icon(id, { x: x + 0.18, y: 2.05 }, `手順${i + 1}アイコン`, { hex: C.accent, pt: 20 }));
      r.push(...text(id, { x: x + 0.75, y: 2.12, w: 1.15, h: 0.28 }, String(i + 1), { size: 10, bold: true, hex: C.faint }));
      r.push(...text(id, { x: x + 0.2, y: 2.5, w: 1.65, h: 0.35 }, `{{手順${i + 1}}}`, { size: 12.5, bold: true }));
      r.push(...text(id, { x: x + 0.2, y: 2.86, w: 1.65, h: 0.5 }, `{{手順${i + 1}説明}}`, { size: 9.5, hex: C.sub }));
      if (i < 3) r.push(...shape(id, { x: x + 2.08, y: 2.58, w: 0.14, h: 0.14 }, { hex: C.accent, kind: 'RIGHT_ARROW' }));
    });
    r.push(...text(id, { x: 0.6, y: 3.75, w: 8.8, h: 0.4 }, '{{結論}}', { size: 12 }));
    return r;
  },
  // 9. 大きな数字ひとつ
  (id) => [
    ...slideHead(id, '大きな数字', { dark: true }),
    ...text(id, { x: 0.6, y: 1.85, w: 5.6, h: 1.5 }, '{{数値}}', { size: 76, bold: true, hex: C.accent }),
    ...text(id, { x: 0.6, y: 3.4, w: 5.6, h: 0.4 }, '{{数値の説明}}', { size: 14, hex: '#b5b1c4' }),
    ...shape(id, { x: 6.5, y: 1.9, w: 2.9, h: 2.4 }, { hex: '#ffffff', alpha: 0.06 }),
    ...text(id, { x: 6.8, y: 2.15, w: 2.3, h: 1.9 }, '{{補足}}', { size: 11.5, hex: '#d5d2de' }),
  ],
  // 10. 引用
  (id) => [
    ...slideHead(id, '引用', { withTitle: false }),
    ...shape(id, { x: 0.9, y: 1.9, w: 0.07, h: 2.0 }, { hex: C.accent, kind: 'RECTANGLE' }),
    ...text(id, { x: 1.3, y: 1.95, w: 7.8, h: 1.6 }, '{{引用文}}', { size: 22, hex: C.ink }),
    ...text(id, { x: 1.3, y: 3.65, w: 7.8, h: 0.35 }, '{{出典}}', { size: 11.5, hex: C.faint }),
  ],
];

/**
 * テンプレートを作る（--update なら作り直す）。
 * @returns {Promise<void>}
 */
async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const g = new GoogleService();

  // --update <ID> で既存のテンプレートを作り直す（新しく作ると ID が変わり、登録し直しになるため）
  const updateIdx = process.argv.indexOf('--update');
  const updateId = updateIdx >= 0 ? process.argv[updateIdx + 1] : null;

  let id;
  if (updateId) {
    console.log(`[1/3] 既存テンプレート ${updateId} を作り直します...`);
    id = updateId;
  } else {
    console.log('[1/3] テンプレートを作成中...');
    const created = await g.createPresentation(creds, { title: 'AI Radio 標準テンプレート' });
    id = created.presentationId;
  }
  const meta = await g.getPresentation(creds, {
    presentationId: id, fields: 'masters(objectId),slides(objectId,pageElements(objectId))',
  });

  if (updateId) {
    // 同じ要素を二重に置かないよう、既存の見本スライドとマスターの要素を片付ける
    const masterEls = (await g.getPresentation(creds, {
      presentationId: id, fields: 'masters(pageElements(objectId))',
    })).masters?.[0]?.pageElements || [];
    const cleanup = [
      ...(meta.slides || []).map((sl) => ({ deleteObject: { objectId: sl.objectId } })),
      ...masterEls.map((el) => ({ deleteObject: { objectId: el.objectId } })),
    ];
    if (cleanup.length > 0) {
      await g.batchUpdatePresentation(creds, { presentationId: id, requests: cleanup });
      console.log(`  既存の見本${(meta.slides || []).length}枚とマスター要素${masterEls.length}件を除去`);
    }
    meta.slides = [];
  }

  console.log('[2/3] マスター（背景・フッター）を設定中...');
  // ロゴ・フッター・背景はマスターへ（全スライドに引き継がれる）
  await g.batchUpdatePresentation(creds, { presentationId: id, requests: [
    { updatePageProperties: { objectId: meta.masters[0].objectId,
      pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb(C.bg) } } } },
      fields: 'pageBackgroundFill' } },
    ...shape(meta.masters[0].objectId, { x: 0.6, y: 5.06, w: 8.8, h: 0.008 }, { hex: C.line, kind: 'RECTANGLE' }),
    ...text(meta.masters[0].objectId, { x: 0.6, y: 5.12, w: 6.5, h: 0.3 },
      '{{会社名}}  |  {{機密区分}}', { size: 8.5, hex: C.faint }),
  ] });

  console.log(`[3/3] 見本スライド${LIBRARY.length}種を作成中...`);
  for (let i = 0; i < LIBRARY.length; i++) {
    const slideId = `lib_${String(i + 1).padStart(2, '0')}`;
    await g.batchUpdatePresentation(creds, { presentationId: id, requests: LIBRARY[i](slideId) });
    process.stdout.write(`  ${i + 1}/${LIBRARY.length}\r`);
  }
  // 作ったときからある空のスライドを消す
  if (meta.slides?.[0]?.objectId) {
    await g.batchUpdatePresentation(creds, { presentationId: id,
      requests: [{ deleteObject: { objectId: meta.slides[0].objectId } }] });
  }

  const url = `https://docs.google.com/presentation/d/${id}/edit`;
  console.log('\n完了\n');
  console.log(`  ID : ${id}`);
  console.log(`  URL: ${url}\n`);
  console.log('  管理画面「My Secretary → スライドのテンプレート」でこのURLを登録してください。');
  console.log('  登録すると、次回から新方式（Presentation Creator）で作成されます。');
  console.log('  中身はSlidesの画面で自由に改造できます（このスクリプトを再実行する必要はありません）。');
}

main().catch((e) => {
  console.error('テンプレートの作成に失敗しました:', e.message);
  process.exit(1);
});
