/**
 * @file スライドの画像とグラフの差し込み（{{IMAGE}}・{{CHART}} の目印を実体に差し替える）
 *
 * テンプレートの見本スライドに置かれた {{IMAGE}}・{{CHART}} の目印を探し、同じ位置と大きさに
 * 画像（生成したものを Drive 経由で貼る）または Sheets のグラフ（元データを後から編集できる）を置く。
 * 目印を探して差し替える部分そのものは presentation-render.js が持ち、ここは「何を作って渡すか」を担う。
 *
 * ATTENTION: googleService はここで require せず、引数で受け取ること。secretary-tools-services.js を
 * 読み込むと secretary-tools-presentation.js との循環参照になる（あちらがこの系統を読み込んでいる）。
 *
 * 主な利用元: lib/presentation-creator-agent.js（put_image・put_chart の道具）・
 * lib/secretary-tools-presentation.js（古い方式のグラフ組み立て）
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-22
 */
'use strict';

const { generateImage } = require('./llm-client');
const { COLORS, hexToRgbFloat } = require('./presentation-design-tokens');
const presRender = require('./presentation-render');
const { getLogger } = require('../logger');

/**
 * Sheets API の basicChart で使えるグラフの種類（円グラフは別の pieChart なので含めない）。
 * 知らない種類なら COLUMN にする。
 */
const BASIC_CHART_TYPES = new Set(['COLUMN', 'BAR', 'LINE', 'AREA', 'SCATTER']);

/**
 * 画像生成で指定できる縦横比。この中から、置き場所の形に一番近いものを選ぶ。
 */
const IMAGE_ASPECT_RATIOS = [
  { name: '1:1', ratio: 1 },
  { name: '3:4', ratio: 3 / 4 },
  { name: '4:3', ratio: 4 / 3 },
  { name: '9:16', ratio: 9 / 16 },
  { name: '16:9', ratio: 16 / 9 },
];

/**
 * 置き場所の実寸から、一番近い縦横比の名前を返す。
 *
 * ATTENTION: 縦横比をモデルに決めさせないこと。合わない比で作ると、Slides は画像の形を保ったまま枠に
 * 収めるため、枠の大半が余白になる。置き場所の形は分かっているので、ここで決める方が確実。
 *
 * @param {Record<string, any>} area 目印の要素（size と transform を持つ）
 * @returns {string} '16:9' のような縦横比の名前
 */
function pickAspectRatio(area) {
  const w = (area?.size?.width?.magnitude || 0) * (area?.transform?.scaleX ?? 1);
  const h = (area?.size?.height?.magnitude || 0) * (area?.transform?.scaleY ?? 1);
  if (!(w > 0) || !(h > 0)) return '4:3';
  const target = w / h;
  let best = IMAGE_ASPECT_RATIOS[0];
  for (const cand of IMAGE_ASPECT_RATIOS) {
    if (Math.abs(Math.log(cand.ratio / target)) < Math.abs(Math.log(best.ratio / target))) best = cand;
  }
  return best.name;
}

/**
 * 作った画像を Drive に置き、Slides API の createImage が取り込める URL を返す。
 *
 * ATTENTION: 画像は「リンクを知っている全員が見られる」にする必要がある。Slides が匿名で URL を
 * 取りに行くため。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{name: string, imageBase64: string, mimeType: string}} image ファイル名と画像
 * @returns {Promise<string>} 画像の URL
 */
async function uploadImageForSlides(googleService, creds, { name, imageBase64, mimeType }) {
  const uploaded = await googleService.uploadImageToDrive(creds, { name, base64Data: imageBase64, mimeType });
  await googleService.makeFilePublicReadable(creds, { fileId: uploaded.id });
  return `https://drive.google.com/uc?export=view&id=${uploaded.id}`;
}

/**
 * スライドに入れる画像を1枚作る。
 *
 * @param {any} args apiKey・prompt・aspectRatio・imageModel（直接指定）・creds/config（ティアの上書き元）・activitySessionId
 * @returns {Promise<{imageBase64: string, mimeType: string, usage: any}|null>} 作れなければ null
 */
async function generateSlideImage({
  apiKey, prompt, aspectRatio, imageModel = null, creds = null, config = null, activitySessionId = null,
}) {
  const img = await generateImage({
    tier: 'image',
    apiKey,
    prompt,
    aspectRatio,
    modelOverrideForCompat: imageModel || null,
    creds,
    config,
    agentKey: 'secretary_presentation',
    activitySessionId,
    logMeta: { purpose: 'presentation_image' },
  });
  return img ? { imageBase64: img.imageBase64, mimeType: img.mimeType, usage: img.usage } : null;
}

/**
 * スライドの {{IMAGE}} の目印を、作った画像に差し替える。
 *
 * 縦横比は置き場所の形から決める（pickAspectRatio）。画像が作れなかったときは目印をそのままにせず、
 * 呼び出し側が消せるよう placed: false を返す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {any} opts deckId・slideId・apiKey・prompt・config・activitySessionId
 * @returns {Promise<{placed: boolean, reason?: string, aspectRatio?: string}>}
 */
async function putImage(googleService, creds, { deckId, slideId, apiKey, prompt, config = null, activitySessionId = null }) {
  const found = await presRender.findPlaceholderArea(googleService, creds, { deckId, slideId, marker: 'IMAGE' });
  if (!found) return { placed: false, reason: 'このスライドに画像の置き場所（{{IMAGE}}）がありません。' };
  const { area, deleteIds } = found;

  const aspectRatio = pickAspectRatio(area);
  const img = await generateSlideImage({ apiKey, prompt, aspectRatio, creds, config, activitySessionId });
  if (!img) return { placed: false, reason: '画像を作れませんでした。' };

  const imageUrl = await uploadImageForSlides(googleService, creds, {
    name: `slide-${slideId}.png`, imageBase64: img.imageBase64, mimeType: img.mimeType,
  });
  await presRender.replaceAreaWithImage(googleService, creds, { deckId, slideId, area, imageUrl, deleteIds });
  getLogger().info(`[PresMedia] 画像を配置: ${slideId}（${aspectRatio}）`);
  return { placed: true, aspectRatio };
}

/**
 * Sheets に書く表（見出しの行と、項目ごとの値）を作る。系列は2本まで（円グラフは1本）。
 *
 * @param {{categories: string[], series: Array<any>, chartType: string}} args
 * @returns {Array<Array<any>>} 2次元の配列
 */
function buildChartValues({ categories, series, chartType }) {
  const maxSeries = chartType === 'PIE' ? 1 : 2;
  const header = ['', ...series.slice(0, maxSeries).map((s) => s.name)];
  const rows = categories.map((cat, i) => [cat, ...series.slice(0, maxSeries).map((s) => s.values[i] ?? '')]);
  return [header, ...rows];
}

/**
 * Sheets のグラフの指定（ChartSpec）を作る。色は presentation-design-tokens.js のもの。
 *
 * グラフは自前で描いて画像にするのではなく、Sheets のグラフにする（元のデータを編集できることを優先）。
 * 表現の幅は、Sheets が持つ種類（棒・横棒・折れ線・面・散布図・円）から選ばせることで補う。
 * 円グラフ（PIE）は basicChart とは別の形（pieChart）で、使う系列は1本目だけ。
 *
 * @param {{sheetId: number, title: string, chartType: string, categories: string[], series: Array<any>}} args
 * @returns {Record<string, any>} ChartSpec
 */
function buildChartSpec({ sheetId, title, chartType, categories, series }) {
  const numRows = categories.length + 1; // 見出しの行を含む

  if (chartType === 'PIE') {
    return {
      title,
      pieChart: {
        legendPosition: 'BOTTOM_LEGEND',
        domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: 1 }] } },
        series: { sourceRange: { sources: [{ sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 1, endColumnIndex: 2 }] } },
        threeDimensional: false,
        // 円グラフは、切れ目ごとの色を Sheets API で指定できない。そのため円グラフだけ Sheets の既定の配色になる
      },
    };
  }

  const seriesColors = [COLORS.accent, COLORS.chartSecondary];
  const domain = { domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: 1 }] } } };
  const seriesSpecs = series.slice(0, 2).map((s, i) => ({
    series: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: i + 1, endColumnIndex: i + 2 }] } },
    targetAxis: 'LEFT_AXIS',
    color: hexToRgbFloat(seriesColors[i]),
  }));
  return {
    title,
    basicChart: {
      chartType: BASIC_CHART_TYPES.has(chartType) ? chartType : 'COLUMN',
      legendPosition: 'BOTTOM_LEGEND',
      headerCount: 1,
      axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
      domains: [domain],
      series: seriesSpecs,
    },
  };
}

/**
 * スライドの {{CHART}} の目印を、Sheets のグラフに差し替える。
 *
 * グラフの元データは新しいスプレッドシートに書き、リンクした状態で貼る（後から数値を直せる）。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {any} opts deckId・slideId・title・chartType・categories・series
 * @returns {Promise<{placed: boolean, reason?: string, spreadsheetUrl?: string}>}
 */
async function putChart(googleService, creds, { deckId, slideId, title, chartType, categories, series }) {
  const found = await presRender.findPlaceholderArea(googleService, creds, { deckId, slideId, marker: 'CHART' });
  if (!found) return { placed: false, reason: 'このスライドにグラフの置き場所（{{CHART}}）がありません。' };
  const { area, deleteIds } = found;
  if (!Array.isArray(categories) || categories.length === 0) return { placed: false, reason: '項目（categories）がありません。' };
  if (!Array.isArray(series) || series.length === 0) return { placed: false, reason: '系列（series）がありません。' };

  const sheet = await googleService.createSpreadsheet(creds, { title: `${title} - データ` });
  const sheetId = sheet.sheets?.[0]?.properties?.sheetId ?? 0;
  const values = buildChartValues({ categories, series, chartType });
  await googleService.writeSpreadsheetValues(creds, { spreadsheetId: sheet.spreadsheetId, range: 'Data!A1', values });
  const chartSpec = buildChartSpec({ sheetId, title, chartType, categories, series });
  const chartId = await googleService.addSheetsChart(creds, { spreadsheetId: sheet.spreadsheetId, sheetId, chartSpec });

  await presRender.replaceAreaWithChart(googleService, creds, {
    deckId, slideId, area, spreadsheetId: sheet.spreadsheetId, chartId, deleteIds,
  });
  getLogger().info(`[PresMedia] グラフを配置: ${slideId}（${chartType}・${categories.length}項目）`);
  return { placed: true, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit` };
}

module.exports = {
  BASIC_CHART_TYPES,
  IMAGE_ASPECT_RATIOS,
  pickAspectRatio,
  uploadImageForSlides,
  generateSlideImage,
  putImage,
  buildChartValues,
  buildChartSpec,
  putChart,
};
