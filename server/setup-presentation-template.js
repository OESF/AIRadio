#!/usr/bin/env node
/**
 * @file create_presentation 用のテンプレートの Google Slides デッキを作るスクリプト
 *
 * presentation-design-tokens.js の色とフォントから、6種類の構図（表紙・箇条書き・比較・KPI・グラフ・画像）を
 * 持つテンプレートのデッキを、毎回同じ結果になるように作る。最後に lib/secretary-tools-presentation.js の
 * TEMPLATE_PRESENTATION_ID の行を、作ったデッキの ID に書き換える。
 *
 * 使い方: node server/setup-presentation-template.js
 * 出力:   作ったデッキの presentationId と URL を表示する（サーバーが動いていれば再起動が要る）。
 *
 * デザインを変えるときは、presentation-design.md（人が読む方）と presentation-design-tokens.js
 * （プログラムが読む方）の両方を直してから、このスクリプトを実行し直す。
 *
 * ATTENTION: 実行した後に Slides の画面で文字間隔などを少し整えるのはよいが、目印の文字（{{TITLE}} など）と、
 * CHART_AREA・IMAGE_AREA・COVER_IMAGE_AREA の代替テキストは変えないこと。実行時の処理がこれを頼りに
 * 差し込む場所を探している。
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
const { COLORS, FONTS, hexToRgbFloat } = require('./lib/presentation-design-tokens');

const CREDENTIALS_PATH = path.join(__dirname, 'data', 'credentials.json');

// Slides の標準の16:9（ワイドスクリーン）のページの大きさ。単位は EMU（914400 = 1インチ）。
const PAGE_W = 9144000;
const PAGE_H = 5143500;
const emu = (inches) => Math.round(inches * 914400);

/**
 * #RRGGBB の色を Slides API の色（rgbColor）にする。
 *
 * @param {string} hex 色
 * @returns {Record<string, any>} { rgbColor }
 */
function rgbColor(hex) {
  return { rgbColor: hexToRgbFloat(hex) };
}

/**
 * 単色の塗りを作る。
 *
 * @param {string} hex 色
 * @param {number} [alpha] 不透明度（0〜1）
 * @returns {Record<string, any>} { solidFill }
 */
function solidFill(hex, alpha = 1) {
  return { solidFill: { color: rgbColor(hex), alpha } };
}

/**
 * スライドの背景色を設定するリクエストを作る。
 *
 * @param {string} slideId スライド
 * @param {string} hex 色
 * @returns {Record<string, any>} リクエスト
 */
function setBackground(slideId, hex) {
  return {
    updatePageProperties: {
      objectId: slideId,
      pageProperties: { pageBackgroundFill: solidFill(hex) },
      fields: 'pageBackgroundFill',
    },
  };
}

/**
 * テキストボックスを1つ作り、目印の文字を入れて書式を当てるリクエストを作る。
 *
 * @param {string} objectId テキストボックスの ID
 * @param {string} slideId スライド
 * @param {{x: number, y: number, w: number, h: number}} box 位置と大きさ（インチ）
 * @param {string} text 入れる文字（{{TITLE}} などの目印）
 * @param {{fontFamily?: string, fontSizePt?: number, colorHex: string, bold?: boolean, align?: string}} style
 *   フォント・大きさ（pt）・色・太字・揃え
 * @returns {Array<Record<string, any>>} リクエスト
 */
function textBox(objectId, slideId, { x, y, w, h }, text, {
  fontFamily = FONTS.body, fontSizePt = 18, colorHex, bold = false, align = 'START',
}) {
  return [
    {
      createShape: {
        objectId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: emu(w), unit: 'EMU' }, height: { magnitude: emu(h), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: 'EMU' },
        },
      },
    },
    { insertText: { objectId, text } },
    {
      updateTextStyle: {
        objectId,
        style: {
          fontFamily,
          fontSize: { magnitude: fontSizePt, unit: 'PT' },
          bold,
          foregroundColor: { opaqueColor: rgbColor(colorHex) },
        },
        fields: 'fontFamily,fontSize,bold,foregroundColor',
        textRange: { type: 'ALL' },
      },
    },
    {
      updateParagraphStyle: {
        objectId,
        style: { alignment: align },
        fields: 'alignment',
        textRange: { type: 'ALL' },
      },
    },
  ];
}

/**
 * タイトルの下のアクセントの罫線（全構図に共通の目印のモチーフ）を作るリクエスト。
 *
 * @param {string} objectId 罫線の ID
 * @param {string} slideId スライド
 * @param {{x: number, y: number, w: number}} pos 位置と幅（インチ）
 * @returns {Array<Record<string, any>>} リクエスト
 */
function titleRule(objectId, slideId, { x, y, w }) {
  return [{
    createShape: {
      objectId,
      shapeType: 'RECTANGLE',
      elementProperties: {
        pageObjectId: slideId,
        size: { width: { magnitude: emu(w), unit: 'EMU' }, height: { magnitude: emu(0.02), unit: 'EMU' } },
        transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: 'EMU' },
      },
    },
  }, {
    updateShapeProperties: {
      objectId,
      shapeProperties: { shapeBackgroundFill: solidFill(COLORS.accent), outline: { propertyState: 'NOT_RENDERED' } },
      fields: 'shapeBackgroundFill,outline',
    },
  }];
}

/**
 * 隅の淡い光のモチーフ（薄い円）を作り、最背面へ送るリクエスト。
 *
 * 本当は index.css の radial-gradient を再現したいが、Slides API の塗りはグラデーションに対応して
 * いないので、透明度の低い円で代わりにする（完全な再現ではないが、隅の淡い光という意図は保つ）。
 *
 * @param {string} objectId 円の ID
 * @param {string} slideId スライド
 * @param {{corner: string, hex: string}} opts どちらの隅か（'left' か 'right'）と色
 * @returns {Array<Record<string, any>>} リクエスト
 */
function cornerMotif(objectId, slideId, { corner, hex }) {
  const size = 3.0; // インチ、円の直径
  const x = corner === 'left' ? -size * 0.4 : PAGE_W / 914400 - size * 0.6;
  const y = -size * 0.4;
  return [{
    createShape: {
      objectId,
      shapeType: 'ELLIPSE',
      elementProperties: {
        pageObjectId: slideId,
        size: { width: { magnitude: emu(size), unit: 'EMU' }, height: { magnitude: emu(size), unit: 'EMU' } },
        transform: { scaleX: 1, scaleY: 1, translateX: emu(x), translateY: emu(y), unit: 'EMU' },
      },
    },
  }, {
    updateShapeProperties: {
      objectId,
      shapeProperties: { shapeBackgroundFill: solidFill(hex, 0.12), outline: { propertyState: 'NOT_RENDERED' } },
      fields: 'shapeBackgroundFill,outline',
    },
  }, {
    // 動線の邪魔にならないよう最背面へ送る
    updatePageElementsZOrder: { pageElementObjectIds: [objectId], operation: 'SEND_TO_BACK' },
  }];
}

/**
 * 表紙の構図（題名・副題と、右半分の画像の枠 COVER_IMAGE_AREA）を作る。
 *
 * @returns {{slideId: string, reqs: Array<Record<string, any>>}} スライドの ID とリクエスト
 */
function buildTitleLayout() {
  const slideId = 'layout_title';
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.darkBg),
    ...cornerMotif(`${slideId}_motif`, slideId, { corner: 'right', hex: COLORS.accent }),
    // 右半分には、テーマに合わせて毎回作る画像を入れる枠を置く。CHART_AREA と同じ仕組み（代替テキストで
    // 役割を示し、実行時に位置と大きさを読んで削除し、createImage で差し替える）。
    // 文字は左半分に収まるよう幅を狭くしている。
    ...textBox(`${slideId}_title`, slideId, { x: 0.6, y: 1.6, w: 4.8, h: 1.4 }, '{{TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 36, colorHex: '#ffffff', bold: true,
    }),
    ...titleRule(`${slideId}_rule`, slideId, { x: 0.6, y: 2.9, w: 2.0 }),
    ...textBox(`${slideId}_subtitle`, slideId, { x: 0.6, y: 3.1, w: 4.8, h: 0.9 }, '{{SUBTITLE}}', {
      fontFamily: FONTS.body, fontSizePt: 16, colorHex: '#c9c9d4',
    }),
    {
      createShape: {
        objectId: `${slideId}_cover_image_area`,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: emu(4.0), unit: 'EMU' }, height: { magnitude: emu(5.625), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: emu(6.0), translateY: emu(0), unit: 'EMU' },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: `${slideId}_cover_image_area`,
        shapeProperties: { shapeBackgroundFill: solidFill(COLORS.darkSurface, 1), outline: { propertyState: 'NOT_RENDERED' } },
        fields: 'shapeBackgroundFill,outline',
      },
    },
    {
      updatePageElementAltText: {
        objectId: `${slideId}_cover_image_area`,
        description: 'COVER_IMAGE_AREA',
        title: 'COVER_IMAGE_AREA',
      },
    },
  ];
  return { slideId, reqs };
}

/**
 * 箇条書きの構図（題名と本文）を作る。
 *
 * @returns {{slideId: string, reqs: Array<Record<string, any>>}} スライドの ID とリクエスト
 */
function buildBulletLayout() {
  const slideId = 'layout_bullet';
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.lightBg),
    ...textBox(`${slideId}_title`, slideId, { x: 0.7, y: 0.5, w: 8.6, h: 0.9 }, '{{TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 32, colorHex: COLORS.lightInk, bold: true,
    }),
    ...titleRule(`${slideId}_rule`, slideId, { x: 0.7, y: 1.4, w: 2.2 }),
    ...textBox(`${slideId}_body`, slideId, { x: 0.7, y: 1.7, w: 8.6, h: 3.5 }, '{{BODY}}', {
      fontFamily: FONTS.body, fontSizePt: 20, colorHex: COLORS.lightInk,
    }),
  ];
  // 実機で確認済み: {{BODY}} を replaceAllText で複数行（\n 区切り）に置き換えると、各行が
  // この箇条書きの書式を引き継ぐ。
  reqs.push({
    createParagraphBullets: {
      objectId: `${slideId}_body`,
      textRange: { type: 'ALL' },
      bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
    },
  });
  return { slideId, reqs };
}

/**
 * 比較の構図（題名と、左右2列の見出し・本文、間の縦の区切り線）を作る。
 *
 * @returns {{slideId: string, reqs: Array<Record<string, any>>}} スライドの ID とリクエスト
 */
function buildComparisonLayout() {
  const slideId = 'layout_comparison';
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.lightBg),
    ...textBox(`${slideId}_title`, slideId, { x: 0.7, y: 0.5, w: 8.6, h: 0.9 }, '{{TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 32, colorHex: COLORS.lightInk, bold: true,
    }),
    ...titleRule(`${slideId}_rule`, slideId, { x: 0.7, y: 1.4, w: 2.2 }),
    // 中央の縦区切り線（アクセント色、薄め）
    {
      createShape: {
        objectId: `${slideId}_divider`,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: emu(0.02), unit: 'EMU' }, height: { magnitude: emu(2.9), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: emu(5.0), translateY: emu(1.8), unit: 'EMU' },
        },
      },
    },
    { updateShapeProperties: {
      objectId: `${slideId}_divider`,
      shapeProperties: { shapeBackgroundFill: solidFill(COLORS.accent, 0.4), outline: { propertyState: 'NOT_RENDERED' } },
      fields: 'shapeBackgroundFill,outline',
    } },
    ...textBox(`${slideId}_left_title`, slideId, { x: 0.7, y: 1.8, w: 3.9, h: 0.6 }, '{{COMPARE_LEFT_TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 22, colorHex: COLORS.accent, bold: true,
    }),
    ...textBox(`${slideId}_left_body`, slideId, { x: 0.7, y: 2.4, w: 3.9, h: 2.3 }, '{{COMPARE_LEFT_BODY}}', {
      fontFamily: FONTS.body, fontSizePt: 18, colorHex: COLORS.lightInk,
    }),
    ...textBox(`${slideId}_right_title`, slideId, { x: 5.4, y: 1.8, w: 3.9, h: 0.6 }, '{{COMPARE_RIGHT_TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 22, colorHex: COLORS.chartSecondary, bold: true,
    }),
    ...textBox(`${slideId}_right_body`, slideId, { x: 5.4, y: 2.4, w: 3.9, h: 2.3 }, '{{COMPARE_RIGHT_BODY}}', {
      fontFamily: FONTS.body, fontSizePt: 18, colorHex: COLORS.lightInk,
    }),
  ];
  return { slideId, reqs };
}

/**
 * KPI の構図（題名と、3つの大きな数字とそのラベル）を作る。
 *
 * @returns {{slideId: string, reqs: Array<Record<string, any>>}} スライドの ID とリクエスト
 */
function buildKpiLayout() {
  const slideId = 'layout_kpi';
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.darkBg),
    ...cornerMotif(`${slideId}_motif`, slideId, { corner: 'left', hex: COLORS.accent }),
    ...textBox(`${slideId}_title`, slideId, { x: 0.7, y: 0.5, w: 8.6, h: 0.9 }, '{{TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 32, colorHex: '#ffffff', bold: true,
    }),
    ...titleRule(`${slideId}_rule`, slideId, { x: 0.7, y: 1.4, w: 2.2 }),
  ];
  const slots = [
    { i: 1, x: 0.7 },
    { i: 2, x: 3.63 },
    { i: 3, x: 6.56 },
  ];
  for (const { i, x } of slots) {
    reqs.push(
      ...textBox(`${slideId}_stat${i}_val`, slideId, { x, y: 2.2, w: 2.6, h: 1.1 }, `{{STAT_${i}_VALUE}}`, {
        fontFamily: FONTS.heading, fontSizePt: 44, colorHex: COLORS.accent, bold: true, align: 'CENTER',
      }),
      ...textBox(`${slideId}_stat${i}_lbl`, slideId, { x, y: 3.3, w: 2.6, h: 0.6 }, `{{STAT_${i}_LABEL}}`, {
        fontFamily: FONTS.body, fontSizePt: 16, colorHex: '#c9c9d4', align: 'CENTER',
      }),
    );
  }
  return { slideId, reqs };
}

/**
 * グラフの構図（題名・グラフの枠 CHART_AREA・要点の一文）を作る。
 *
 * @returns {{slideId: string, reqs: Array<Record<string, any>>}} スライドの ID とリクエスト
 */
function buildChartLayout() {
  const slideId = 'layout_chart';
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.lightBg),
    ...textBox(`${slideId}_title`, slideId, { x: 0.7, y: 0.4, w: 8.6, h: 0.8 }, '{{TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 30, colorHex: COLORS.lightInk, bold: true,
    }),
    ...titleRule(`${slideId}_rule`, slideId, { x: 0.7, y: 1.2, w: 2.2 }),
    // グラフを入れる位置の枠。代替テキストに 'CHART_AREA' を入れておき、実行時にこの枠の位置と大きさで
    // createSheetsChart し、枠そのものは消す。
    // BUGFIX: 枠の縦横比は約2:1にする。以前は横長すぎ（約2.8:1）、グラフが枠に合わせて引き伸ばされ、
    // 縦につぶれて見えた。左揃えのまま幅を抑え、右の余白は意図的に空けている（中央揃えはデザインの
    // 禁止事項）。
    {
      createShape: {
        objectId: `${slideId}_chart_area`,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: emu(6.6), unit: 'EMU' }, height: { magnitude: emu(3.3), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: emu(0.7), translateY: emu(1.3), unit: 'EMU' },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: `${slideId}_chart_area`,
        shapeProperties: {
          shapeBackgroundFill: solidFill('#e8e7ee', 1),
          outline: { propertyState: 'NOT_RENDERED' },
        },
        fields: 'shapeBackgroundFill,outline',
      },
    },
    {
      updatePageElementAltText: {
        objectId: `${slideId}_chart_area`,
        description: 'CHART_AREA',
        title: 'CHART_AREA',
      },
    },
    ...textBox(`${slideId}_takeaway`, slideId, { x: 0.7, y: 4.6, w: 8.6, h: 0.5 }, '{{TAKEAWAY}}', {
      fontFamily: FONTS.body, fontSizePt: 16, colorHex: COLORS.lightInk,
    }),
  ];
  return { slideId, reqs };
}

/**
 * 画像の構図（題名・画像の枠 IMAGE_AREA・説明の一文）を作る。
 * スライドの内容に合わせて毎回作る画像を入れる。CHART_AREA と同じ仕組み（代替テキストで役割を示し、
 * 実行時に位置と大きさを読んで削除し、createImage で差し替える）。
 *
 * @returns {{slideId: string, reqs: Array<Record<string, any>>}} スライドの ID とリクエスト
 */
function buildImageLayout() {
  const slideId = 'layout_image';
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.lightBg),
    ...textBox(`${slideId}_title`, slideId, { x: 0.7, y: 0.4, w: 8.6, h: 0.8 }, '{{TITLE}}', {
      fontFamily: FONTS.heading, fontSizePt: 30, colorHex: COLORS.lightInk, bold: true,
    }),
    ...titleRule(`${slideId}_rule`, slideId, { x: 0.7, y: 1.2, w: 2.2 }),
    {
      createShape: {
        objectId: `${slideId}_image_area`,
        shapeType: 'RECTANGLE',
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: emu(6.6), unit: 'EMU' }, height: { magnitude: emu(3.3), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: emu(0.7), translateY: emu(1.3), unit: 'EMU' },
        },
      },
    },
    {
      updateShapeProperties: {
        objectId: `${slideId}_image_area`,
        shapeProperties: { shapeBackgroundFill: solidFill('#e8e7ee', 1), outline: { propertyState: 'NOT_RENDERED' } },
        fields: 'shapeBackgroundFill,outline',
      },
    },
    {
      updatePageElementAltText: {
        objectId: `${slideId}_image_area`,
        description: 'IMAGE_AREA',
        title: 'IMAGE_AREA',
      },
    },
    ...textBox(`${slideId}_caption`, slideId, { x: 0.7, y: 4.6, w: 8.6, h: 0.5 }, '{{CAPTION}}', {
      fontFamily: FONTS.body, fontSizePt: 16, colorHex: COLORS.lightInk,
    }),
  ];
  return { slideId, reqs };
}

/**
 * デッキを作り、6つの構図を組み立て、secretary-tools-presentation.js のテンプレートの ID を書き換える。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const googleService = new GoogleService();

  console.log('[1/3] 空のpresentationを作成中...');
  const created = await googleService.createPresentation(creds, { title: 'AI Radio Presentation Template' });
  const presentationId = created.presentationId;
  const defaultSlideId = created.slides?.[0]?.objectId;
  console.log(`  presentationId = ${presentationId}`);

  console.log('[2/3] 6レイアウトを構築中...');
  const layouts = [buildTitleLayout(), buildBulletLayout(), buildComparisonLayout(), buildKpiLayout(), buildChartLayout(), buildImageLayout()];
  const requests = [];
  if (defaultSlideId) requests.push({ deleteObject: { objectId: defaultSlideId } });
  for (const layout of layouts) requests.push(...layout.reqs);

  // 1回の batchUpdate で送るには量が多いので、構図ごとに分けて送る（どの構図で失敗したか分かりやすい）
  if (defaultSlideId) {
    await googleService.batchUpdatePresentation(creds, {
      presentationId, requests: [{ deleteObject: { objectId: defaultSlideId } }],
    });
  }
  for (const layout of layouts) {
    console.log(`  - ${layout.slideId}`);
    await googleService.batchUpdatePresentation(creds, { presentationId, requests: layout.reqs });
  }

  console.log('[3/3] TEMPLATE_PRESENTATION_IDを自動更新中...');
  // デザインの文書を直して実行するだけで済むよう、ID を手でコピーする作業も無くす。
  // ATTENTION: 書き換えるのは TEMPLATE_PRESENTATION_ID の1行だけ（行頭からの完全一致で絞る）。
  const toolFilePath = path.join(__dirname, 'lib', 'secretary-tools-presentation.js');
  const toolFileSrc = fs.readFileSync(toolFilePath, 'utf-8');
  const idLinePattern = /^const TEMPLATE_PRESENTATION_ID = .*;$/m;
  if (!idLinePattern.test(toolFileSrc)) {
    throw new Error(`${toolFilePath} 内にTEMPLATE_PRESENTATION_ID定数の行が見つかりませんでした。手動で設定してください: ${presentationId}`);
  }
  fs.writeFileSync(
    toolFilePath,
    toolFileSrc.replace(idLinePattern, `const TEMPLATE_PRESENTATION_ID = '${presentationId}';`),
    'utf-8',
  );

  const webViewLink = `https://docs.google.com/presentation/d/${presentationId}/edit`;
  console.log('完了');
  console.log('');
  console.log(`presentationId: ${presentationId}`);
  console.log(`webViewLink:    ${webViewLink}`);
  console.log('');
  console.log('secretary-tools-presentation.js の TEMPLATE_PRESENTATION_ID を自動更新しました。');
  console.log('サーバーが起動中の場合は再起動して読み込み直してください。');
}

main().catch((e) => {
  console.error('テンプレート構築に失敗しました:', e.message);
  process.exit(1);
});
