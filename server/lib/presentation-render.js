/**
 * @file Google Slides のスライドの組み立て（描画する側の道具）
 *
 * presentation-template.js が作ったマニフェストをもとに、実際の Google Slides のデッキを組み立てる。
 * Presentation Creator（presentation-creator-agent.js）が、ここの関数を道具として呼ぶ。
 *
 * ATTENTION: 構図（レイアウト）ごとの分岐をここに書かないこと。構図はテンプレートの側にあり、
 * ここは差し込み口を埋めるだけなので、構図を増やしてもこのコードは変わらない。
 * ATTENTION: 道具は「スライドを1枚足す」「図を置く」「見る」のような汎用のものだけにし、依頼の種類ごとに
 * 専用の道具を増やさないこと。
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
const { NON_FILLABLE_PLACEHOLDERS } = require('./presentation-template');

const EMU_PER_INCH = 914400;
const inch = (v) => Math.round(v * EMU_PER_INCH);

/**
 * アイコンとして使える名前（Material Symbols Outlined の合字）。すべて実際に描画して確かめたもの。
 *
 * Slides は合字を解釈するので、アイコン用の書式の差し込み口に「folder」と入れるとフォルダーの形になる。
 * ATTENTION: 存在しない名前を入れると、アイコンのフォントのまま英字が描かれ、明らかに壊れた見た目に
 * なる。モデルが思いつきで名前を書けないよう、この表に無い名前は差し込まない。
 */
const ICON_NAMES = new Set([
  'folder', 'lightbulb', 'hub', 'rocket_launch', 'insights', 'schema', 'speed', 'security',
  'cloud', 'storage', 'code', 'build', 'search', 'timeline', 'trending_up', 'trending_down',
  'groups', 'person', 'settings', 'check_circle', 'warning', 'error', 'info', 'description',
  'edit', 'share', 'sync', 'api', 'memory', 'bolt', 'star', 'flag',
  'psychology', 'analytics', 'layers', 'account_tree', 'fact_check', 'verified', 'savings',
  'payments', 'schedule', 'language', 'public', 'science', 'engineering', 'terminal',
  'extension', 'tune', 'visibility', 'key', 'lock', 'database', 'target',
]);

/**
 * 表に無い名前が来たときの代わり。近い名前を推測するより、意味の薄い汎用の印にする。
 */
const ICON_FALLBACK = 'star';

/**
 * 差し込み口がアイコン用か（名前が「アイコン」で終わるか）。
 *
 * @param {string} key 差し込み口の名前
 * @returns {boolean} アイコン用なら true
 */
function isIconSlot(key) {
  return /アイコン$/.test(String(key || ''));
}

/**
 * アイコンの名前を確かめる。表に無ければ代わりの名前にし、警告のログを残す
 * （黙って壊れた見た目を仕上げないため）。
 *
 * @param {*} value モデルが書いた名前
 * @returns {string} 使える名前（空なら空文字）
 */
function normalizeIconName(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!raw) return '';
  if (ICON_NAMES.has(raw)) return raw;
  getLogger().warn(`[PresRender] アイコン「${value}」は使える名前にないため ${ICON_FALLBACK} で代替します`);
  return ICON_FALLBACK;
}

// 新しいオブジェクト ID を作る。ATTENTION: Slides API はオブジェクト ID に5文字以上を求める（短いと400）。
let _seq = 0;
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(_seq += 1).toString(36)}`.slice(0, 48);

/**
 * #RRGGBB の色を Slides API の rgbColor（0〜1）にする。
 *
 * @param {string} hex 色（# は省略可）
 * @returns {{red: number, green: number, blue: number}} rgbColor
 * @throws {Error} 色の形が正しくない場合
 */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) throw new Error(`不正なカラーコード: ${hex}`);
  return { red: parseInt(m[1], 16) / 255, green: parseInt(m[2], 16) / 255, blue: parseInt(m[3], 16) / 255 };
}

/**
 * デッキのスライドの ID を、並んでいる順に返す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string}} opts デッキ
 * @returns {Promise<string[]>} 並び順のスライド ID
 */
async function listSlideIds(googleService, creds, { deckId }) {
  const got = await googleService.getPresentation(creds, {
    presentationId: deckId, fields: 'slides(objectId)',
  });
  /** @type {any[]} */
  const slides = got.slides || [];
  return slides.map((s) => s.objectId);
}

/**
 * スライドを指定の位置へ動かす。targetIndex が null なら末尾へ動かす。
 *
 * BUGFIX: duplicateObject で作ったスライドは、複製元のすぐ後ろに置かれる。見本スライドは仕上げまで
 * デッキに残るため、位置を直さないと、同じ見本から作ったスライドが作った順と逆に並ぶ（後から作った
 * ものほど見本の近く＝前に入る）。作るたびに必ずここを通して並びを決める。
 *
 * ATTENTION: updateSlidesPosition の insertionIndex は「動かす前の並びでの位置」で数える。後ろへ
 * 動かすときは、自分が抜ける分を足さないと1つ手前に入る。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, targetIndex: number|null}} opts デッキ・動かすスライド・移動先
 * @returns {Promise<void>}
 */
async function _moveSlideTo(googleService, creds, { deckId, slideId, targetIndex }) {
  const ids = await listSlideIds(googleService, creds, { deckId });
  const from = ids.indexOf(slideId);
  if (from < 0) return;
  const last = ids.length - 1;
  const to = targetIndex == null ? last : Math.min(Math.max(targetIndex, 0), last);
  if (from === to) return;
  await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: [{
      updateSlidesPosition: { slideObjectIds: [slideId], insertionIndex: from < to ? to + 1 : to },
    }],
  });
}

/**
 * テンプレートを複製して新しいデッキを作る。
 *
 * テンプレートのスライド（見本スライド）はここでは消さず、ID を控えて返す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{templateId: string, title: string}} opts テンプレートのファイル ID とデッキの題名
 * @returns {Promise<{deckId: string, webViewLink: string, libraryIds: string[]}>} デッキの ID・URL・見本スライドの ID
 */
async function createDeck(googleService, creds, { templateId, title }) {
  const dup = await googleService.duplicatePresentation(creds, { templateId, name: title });
  const deckId = dup.id;
  // ATTENTION: ここで既存のスライドを消してはいけない。テンプレートのスライドは見本スライドで、
  // これから複製元として使う。仕上げる前に finalizeDeck で取り除く。
  const got = await googleService.getPresentation(creds, { presentationId: deckId, fields: 'slides(objectId)' });
  const libraryIds = (got.slides || []).map((s) => s.objectId);
  getLogger().info(`[PresRender] デッキを作成: ${deckId}（見本スライド${libraryIds.length}枚を保持）`);
  return { deckId, webViewLink: dup.webViewLink, libraryIds };
}

/**
 * 仕上げの後片付け。複製元として使った見本スライドを取り除く。
 * 1枚も作れていないときは見本を残す（真っ白なデッキを渡すより、何が使えたはずかが分かる方がよい）。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, libraryIds?: string[], madeSlideIds?: string[]}} opts デッキ・見本スライド・作ったスライド
 * @returns {Promise<{deleted: number}>} 消した枚数
 */
async function finalizeDeck(googleService, creds, { deckId, libraryIds, madeSlideIds }) {
  const toDelete = (libraryIds || []).filter((id) => !(madeSlideIds || []).includes(id));
  if (toDelete.length === 0 || (madeSlideIds || []).length === 0) return { deleted: 0 };
  await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: toDelete.map((objectId) => ({ deleteObject: { objectId } })),
  });
  getLogger().info(`[PresRender] 見本スライド${toDelete.length}枚を納品物から除去`);
  return { deleted: toDelete.length };
}

/**
 * 構図を1つ選んでスライドを足し、差し込み口を埋める。
 *
 * 見本スライド（kind が slide）は複製で作る。レイアウトは createSlide で作り、プレースホルダーには
 * 割り当てた ID へ直接、{{変数}} にはこのスライドに絞った replaceAllText で文字を入れる。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, layout: Record<string, any>, values?: Record<string, any>, insertAt?: number|null}} opts
 *   デッキ・マニフェストの構図1件（slots を持つ）・差し込み口の key → 入れる文字・入れる位置
 *   insertAt は見本スライドを含むデッキ全体での位置。null なら末尾（作った順に並ぶ）
 * @returns {Promise<{slideId: string, placeholderIds: Record<string, string>}>} 作ったスライドとプレースホルダーの ID
 */
async function addSlide(googleService, creds, { deckId, layout, values = {}, insertAt = null }) {
  // 見本スライドは複製で作る。複製すると要素が実体としてコピーされ、{{変数}} をスライド単位で
  // 置換できる（レイアウトの上の変数は継承して表示しているだけなので置換できない）。
  if (layout.kind === 'slide') {
    return _addSlideFromTemplateSlide(googleService, creds, { deckId, layout, values, insertAt });
  }

  const slideId = newId('slide');

  // placeholderIdMappings の対象はプレースホルダーの差し込み口だけ。SLIDE_NUMBER は実体化されず400に
  // なるので、マニフェストを作る時点で外してある。
  const phSlots = (layout.slots || []).filter(
    (s) => s.kind === 'placeholder' && !NON_FILLABLE_PLACEHOLDERS.has(s.type),
  );
  const mappings = phSlots.map((s) => ({
    layoutPlaceholder: { type: s.type, index: s.index || 0 },
    objectId: newId('slot'),
  }));

  const createReq = {
    createSlide: {
      objectId: slideId,
      slideLayoutReference: { layoutId: layout.id },
      placeholderIdMappings: mappings,
    },
  };
  if (insertAt != null) createReq.createSlide.insertionIndex = insertAt;
  await googleService.batchUpdatePresentation(creds, { presentationId: deckId, requests: [createReq] });

  // ATTENTION: replaceAllText は pageObjectIds でこのスライドに絞ること。絞らないと他のスライドまで
  // 置き換わる。
  const fill = [];
  phSlots.forEach((s, i) => {
    const v = values[s.key];
    if (v == null || v === '') return;
    fill.push({ insertText: { objectId: mappings[i].objectId, text: String(v) } });
  });
  for (const s of (layout.slots || []).filter((x) => x.kind === 'variable')) {
    const v = values[s.key];
    if (v == null) continue;
    fill.push({
      replaceAllText: {
        containsText: { text: `{{${s.key}}}`, matchCase: true },
        replaceText: String(v),
        pageObjectIds: [slideId],
      },
    });
  }
  if (fill.length > 0) {
    await googleService.batchUpdatePresentation(creds, { presentationId: deckId, requests: fill });
  }
  return { slideId, placeholderIds: Object.fromEntries(phSlots.map((s, i) => [s.key, mappings[i].objectId])) };
}

/**
 * 見本スライドを複製して1枚作り、{{変数}} を埋める。
 * 名前の目印（{{LAYOUT_NAME:...}}）は、仕上がりに残らないよう空文字にして消す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, layout: Record<string, any>, values: Record<string, any>, insertAt: number|null}} opts
 *   デッキ・見本スライド・差し込み口の key → 入れる文字・入れる位置（デッキ全体での位置。null なら末尾）
 * @returns {Promise<{slideId: string, placeholderIds: Record<string, string>}>} 作ったスライド（placeholderIds は空）
 */
async function _addSlideFromTemplateSlide(googleService, creds, { deckId, layout, values, insertAt }) {
  const reply = await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: [{ duplicateObject: { objectId: layout.id } }],
  });
  const slideId = reply.replies?.[0]?.duplicateObject?.objectId;
  if (!slideId) throw new Error('見本スライドの複製に失敗しました。');

  const fill = [];
  for (const s of layout.slots || []) {
    const v = values[s.key];
    // 値が渡されなかった差し込み口は、{{...}} が生のまま残らないよう空文字で消す。
    // アイコンの差し込み口だけは、使える名前かどうかをここで確かめる。
    const replaceText = v == null ? ''
      : (isIconSlot(s.key) ? normalizeIconName(v) : String(v));
    fill.push({
      replaceAllText: {
        containsText: { text: `{{${s.key}}}`, matchCase: true },
        replaceText,
        pageObjectIds: [slideId],
      },
    });
  }
  if (layout.named) {
    fill.push({
      replaceAllText: {
        containsText: { text: `{{LAYOUT_NAME:${layout.name}}}`, matchCase: true },
        replaceText: '',
        pageObjectIds: [slideId],
      },
    });
  }
  await googleService.batchUpdatePresentation(creds, { presentationId: deckId, requests: fill });
  // 位置を決めるのは中身を入れた後。複製した直後は見本スライドの真横にいる。
  await _moveSlideTo(googleService, creds, { deckId, slideId, targetIndex: insertAt });
  return { slideId, placeholderIds: {} };
}

/**
 * デッキ全体で1回だけ差し替える変数（会社名・機密区分など、マスターに置いたもの）を埋める。
 * pageObjectIds を指定しないので、マスター・レイアウト・全スライドをまたいで置き換わる。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, variables?: Record<string, any>}} opts デッキと、変数名 → 値
 * @returns {Promise<{replaced: number}>} 置き換えを頼んだ変数の数
 */
async function setDeckVariables(googleService, creds, { deckId, variables }) {
  const requests = Object.entries(variables || {})
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({
      replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: true }, replaceText: String(v) },
    }));
  if (requests.length === 0) return { replaced: 0 };
  await googleService.batchUpdatePresentation(creds, { presentationId: deckId, requests });
  return { replaced: requests.length };
}

/**
 * 要素の実際の表示寸法と位置（EMU）を返す。size × scale で計算する。
 *
 * @param {Record<string, any>} el ページの要素
 * @returns {{x: number, y: number, w: number, h: number}}
 */
function _rectOf(el) {
  return {
    x: el.transform?.translateX || 0,
    y: el.transform?.translateY || 0,
    w: (el.size?.width?.magnitude || 0) * (el.transform?.scaleX ?? 1),
    h: (el.size?.height?.magnitude || 0) * (el.transform?.scaleY ?? 1),
  };
}

/**
 * スライドの上の目印（{{CHART}}・{{IMAGE}}）を探し、画像やグラフを置く枠と、消す要素を返す。
 *
 * ATTENTION: 目印の文字が入っているのは、枠そのものではなく枠に重ねた細いラベルのことがある
 * （標準テンプレートの「画像と説明」は 5.40×3.20 インチの長方形の上に、高さ 0.30 インチの
 * ラベルが載っている）。ラベルの寸法で置くと、画像が帯のように潰れる。目印を囲む図形があれば、
 * そちらを枠として使い、ラベルと一緒に消す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, marker: string}} opts デッキ・スライド・目印（'CHART' か 'IMAGE'）
 * @returns {Promise<{area: Record<string, any>, deleteIds: string[]}|null>} 枠と消す要素（無ければ null）
 */
async function findPlaceholderArea(googleService, creds, { deckId, slideId, marker }) {
  const got = await googleService.getPresentation(creds, {
    presentationId: deckId,
    fields: 'slides(objectId,pageElements(objectId,size,transform,shape(shapeType,text(textElements(textRun(content))))))',
  });
  /** @type {any} */
  const slide = (got.slides || []).find((/** @type {any} */ s) => s.objectId === slideId);
  const elements = slide?.pageElements || [];
  const textOf = (/** @type {any} */ el) =>
    (el.shape?.text?.textElements || []).map((/** @type {any} */ t) => t.textRun?.content || '').join('');

  const label = elements.find((/** @type {any} */ el) => textOf(el).includes(`{{${marker}}}`));
  if (!label) return null;

  // 目印を囲んでいる図形のうち、一番小さいもの（＝一番内側の枠）を探す。文字の入っている要素は
  // 見出しや説明なので除く。わずかなはみ出しは許す（枠の内側に少し余白を取ってラベルを置くため）。
  const TOL = 91440 / 2; // 0.05 インチ
  const lr = _rectOf(label);
  /** @type {any} */
  let frame = null;
  for (const el of elements) {
    if (el.objectId === label.objectId) continue;
    if (textOf(el).trim()) continue;
    const r = _rectOf(el);
    const contains = r.x <= lr.x + TOL && r.y <= lr.y + TOL
      && r.x + r.w >= lr.x + lr.w - TOL && r.y + r.h >= lr.y + lr.h - TOL;
    if (!contains) continue;
    if (r.w * r.h <= lr.w * lr.h * 1.5) continue; // ラベルとほぼ同じ大きさのものは枠とみなさない
    if (!frame || r.w * r.h < _rectOf(frame).w * _rectOf(frame).h) frame = el;
  }

  const area = frame || label;
  const deleteIds = frame ? [frame.objectId, label.objectId] : [label.objectId];
  return { area, deleteIds };
}

/**
 * 目印の要素の位置と大きさから、画像やグラフを作るリクエストの elementProperties を組み立てる。
 *
 * BUGFIX: 目印の size・transform をそのまま渡さず、実際の表示寸法（size × scale）を計算して scale を1で
 * 渡す。要素の種類ごとに内部の基準の寸法が違い、そのまま渡すと高さだけ半分に潰れるなどしていた。
 *
 * @param {Record<string, any>} area 目印の要素
 * @param {Record<string, any>} extra リクエストに足す値（pageObjectId を含む）
 * @returns {Record<string, any>} extra と elementProperties
 */
function _geometryRequest(area, extra) {
  const w = Math.round(area.size.width.magnitude * (area.transform?.scaleX ?? 1));
  const h = Math.round(area.size.height.magnitude * (area.transform?.scaleY ?? 1));
  return {
    ...extra,
    elementProperties: {
      pageObjectId: extra.pageObjectId,
      size: { width: { magnitude: w, unit: 'EMU' }, height: { magnitude: h, unit: 'EMU' } },
      transform: {
        scaleX: 1, scaleY: 1,
        translateX: area.transform?.translateX ?? 0,
        translateY: area.transform?.translateY ?? 0,
        unit: 'EMU',
      },
    },
  };
}

/**
 * 目印の要素を消し、同じ位置と大きさに画像を置く。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, area: Record<string, any>, imageUrl: string,
 *   deleteIds?: string[]|null}} opts
 *   デッキ・スライド・置く枠・画像の URL・消す要素（省略すると枠だけ消す）
 * @returns {Promise<void>}
 */
async function replaceAreaWithImage(googleService, creds, { deckId, slideId, area, imageUrl, deleteIds = null }) {
  const req = _geometryRequest(area, { pageObjectId: slideId });
  delete req.pageObjectId;
  /** @type {string[]} */
  const toDelete = deleteIds || [area.objectId];
  await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: [
      ...toDelete.map((objectId) => ({ deleteObject: { objectId } })),
      { createImage: { url: imageUrl, elementProperties: req.elementProperties } },
    ],
  });
}

/**
 * 目印の要素を消し、同じ位置と大きさにスプレッドシートのグラフを（リンク付きで）置く。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, area: Record<string, any>, spreadsheetId: string, chartId: number,
 *   deleteIds?: string[]|null}} opts
 *   デッキ・スライド・置く枠・スプレッドシート・グラフの ID・消す要素（省略すると枠だけ消す）
 * @returns {Promise<void>}
 */
async function replaceAreaWithChart(googleService, creds, { deckId, slideId, area, spreadsheetId, chartId, deleteIds = null }) {
  const req = _geometryRequest(area, { pageObjectId: slideId });
  delete req.pageObjectId;
  /** @type {string[]} */
  const toDelete = deleteIds || [area.objectId];
  await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: [
      ...toDelete.map((objectId) => ({ deleteObject: { objectId } })),
      {
        createSheetsChart: {
          spreadsheetId, chartId, linkingMode: 'LINKED',
          elementProperties: req.elementProperties,
        },
      },
    ],
  });
}

/**
 * 使われなかった置き場所の目印（{{IMAGE}}・{{CHART}}）を、指定のスライドから消す。
 *
 * BUGFIX: これらの目印は差し込み口（slots）として扱わないため、画像・グラフを入れなかったスライドでは
 * 目印の文字がそのまま納品物に残る（枠だけあって中身の無いページに見える）。仕上げの最後に必ず消す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideIds: string[], markers?: string[]}} opts デッキ・対象のスライド・消す目印
 * @returns {Promise<void>}
 */
async function clearUnusedMarkers(googleService, creds, { deckId, slideIds, markers = ['IMAGE', 'CHART'] }) {
  if (!slideIds || slideIds.length === 0) return;
  await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: markers.map((marker) => ({
      replaceAllText: {
        containsText: { text: `{{${marker}}}`, matchCase: true },
        replaceText: '',
        pageObjectIds: slideIds,
      },
    })),
  });
}

/**
 * 発表者用のメモ（スピーカーノート）を書き込む。
 * notesProperties.speakerNotesObjectId へ insertText するだけ（書式は変えられず、本文だけ）。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, text: string}} opts デッキ・スライド・メモの本文
 * @returns {Promise<boolean>} 書き込めたら true
 */
async function setSpeakerNotes(googleService, creds, { deckId, slideId, text }) {
  if (!text) return false;
  const got = await googleService.getPresentation(creds, {
    presentationId: deckId,
    fields: 'slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))',
  });
  const slide = (got.slides || []).find((s) => s.objectId === slideId);
  const notesId = slide?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
  if (!notesId) return false;
  await googleService.batchUpdatePresentation(creds, {
    presentationId: deckId,
    requests: [{ insertText: { objectId: notesId, text: String(text) } }],
  });
  return true;
}

/**
 * 図形やテキストボックスを自由に置く（構図の作り込み用）。
 * 位置と大きさはインチ（既定の16:9のページは 10 × 5.625 インチ）。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, elements?: Array<Record<string, any>>}} opts
 *   デッキ・スライド・置く要素（kind・x・y・w・h・fill・outline・text・font・sizePt・bold・color・align・sendToBack など）
 * @returns {Promise<{placed: number}>} 置いた数
 */
async function placeElements(googleService, creds, { deckId, slideId, elements }) {
  const requests = [];
  for (const el of elements || []) {
    const id = newId(el.kind === 'text' ? 'txt' : 'shp');
    requests.push({
      createShape: {
        objectId: id,
        shapeType: el.kind === 'text' ? 'TEXT_BOX' : (el.shapeType || 'RECTANGLE'),
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: inch(el.w), unit: 'EMU' }, height: { magnitude: inch(el.h), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: inch(el.x), translateY: inch(el.y), unit: 'EMU' },
        },
      },
    });
    if (el.fill) {
      requests.push({
        updateShapeProperties: {
          objectId: id,
          shapeProperties: {
            shapeBackgroundFill: { solidFill: { color: { rgbColor: hexToRgb(el.fill) }, alpha: el.alpha ?? 1 } },
            outline: el.outline
              ? { outlineFill: { solidFill: { color: { rgbColor: hexToRgb(el.outline) } } },
                  weight: { magnitude: Math.round((el.outlineWeightPt ?? 1) * 12700), unit: 'EMU' }, dashStyle: 'SOLID' }
              : { propertyState: 'NOT_RENDERED' },
          },
          fields: 'shapeBackgroundFill,outline',
        },
      });
    }
    if (el.text) {
      requests.push({ insertText: { objectId: id, text: String(el.text) } });
      const style = {};
      const fields = [];
      if (el.font)      { style.fontFamily = el.font; fields.push('fontFamily'); }
      if (el.sizePt)    { style.fontSize = { magnitude: el.sizePt, unit: 'PT' }; fields.push('fontSize'); }
      if (el.bold != null) { style.bold = !!el.bold; fields.push('bold'); }
      if (el.color)     { style.foregroundColor = { opaqueColor: { rgbColor: hexToRgb(el.color) } }; fields.push('foregroundColor'); }
      if (fields.length > 0) {
        requests.push({ updateTextStyle: { objectId: id, style, fields: fields.join(','), textRange: { type: 'ALL' } } });
      }
      if (el.align) {
        requests.push({ updateParagraphStyle: { objectId: id, style: { alignment: el.align }, fields: 'alignment', textRange: { type: 'ALL' } } });
      }
    }
    if (el.sendToBack) requests.push({ updatePageElementsZOrder: { pageElementObjectIds: [id], operation: 'SEND_TO_BACK' } });
  }
  if (requests.length === 0) return { placed: 0 };
  await googleService.batchUpdatePresentation(creds, { presentationId: deckId, requests });
  return { placed: (elements || []).length };
}

/**
 * スライドのサムネイルを取る（描いた結果を「見る」）。Presentation Creator の見直しのループの中心。
 *
 * BUGFIX: 作った直後のスライドは「is not a page」の400が返ることがある（Google 側でページとして
 * 参照できるまでに少し時間がかかる）。ここで失敗すると見直しのループが成り立たないので、
 * 間隔をあけて3回まで取り直す。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{deckId: string, slideId: string, size?: string}} opts デッキ・スライド・大きさ（既定 'MEDIUM'）
 * @returns {Promise<any>} サムネイル
 */
async function lookAtSlide(googleService, creds, { deckId, slideId, size = 'MEDIUM' }) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await googleService.getPageThumbnail(creds, { presentationId: deckId, pageObjectId: slideId, size });
    } catch (e) {
      lastErr = e;
      if (!/is not a page|not found/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

module.exports = {
  createDeck,
  finalizeDeck,
  listSlideIds,
  clearUnusedMarkers,
  ICON_NAMES,
  isIconSlot,
  normalizeIconName,
  addSlide,
  setDeckVariables,
  findPlaceholderArea,
  replaceAreaWithImage,
  replaceAreaWithChart,
  setSpeakerNotes,
  placeElements,
  lookAtSlide,
  inch,
  hexToRgb,
};
