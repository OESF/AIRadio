/**
 * @file Google Slides のテンプレートの取り込み（使える構図と差し込み口の一覧を作る）
 *
 * スライドの構図はコードに書かず、ユーザーが Google Slides の画面で作る資産として扱う。このファイルは
 * テンプレートのファイルをその場で読み、AI（Presentation Creator）へ渡せる「マニフェスト」
 * （使える構図・差し込み口・デッキ全体の変数・注意）を作る。利用元は presentation-creator-agent.js と
 * presentation-render.js。
 *
 * 構図は2種類を扱い、kind で区別する。
 * - slide（見本スライド）: 主に使う方式。スライドを duplicateObject で複製すると要素が実体として
 *   コピーされるので、{{変数}} をスライド単位で置換できる。名前は画面の外（負の座標）に置いた
 *   {{LAYOUT_NAME:3カード比較}} から読む（画面外の要素は描画されない）。
 * - layout（レイアウト）: 見本スライドが1枚も無いテンプレートだけで使う。単純な「タイトル＋本文」なら
 *   書式の継承が効いて素直。
 *
 * ATTENTION: レイアウトの上に置いた {{変数}} はスライド単位では置換できない（文字はレイアウトの
 * ページにあり、スライドには継承して表示されているだけなので、replaceAllText をスライドに絞ると
 * 1件も当たらない）。API ではプレースホルダーを新しく作れず、レイアウトの名前も変えられないので、
 * 作り込んだ構図は見本スライドで用意する。
 *
 * ATTENTION: SLIDE_NUMBER のプレースホルダーは placeholderIdMappings の対象外（指定すると
 * 「object could not be found」で400になる）。また、オブジェクト ID は5文字以上が必要。
 *
 * 取り込んだ結果は、Drive の modifiedTime をキーにしてメモリと
 * server/data/secretary/presentation-template-cache.json にキャッシュする。
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

const path = require('path');
const jsonFileStore = require('./json-file-store');
const { getLogger } = require('../logger');

/**
 * 取り込んだ結果のキャッシュ（presentationId → { modifiedTime, hasThumbnails, manifest }）。
 *
 * 取り込みのたびに、テンプレートの構造とレイアウトのサムネイルを取り直すと、HTTP の往復が20回以上に
 * なる（そのぶん失敗やレート制限の機会が増える）。ディスクにも置くのは、サーバーを再起動した後の
 * 初回も往復を減らすため。
 *
 * ATTENTION: テンプレートは Slides の画面でいつでも編集できるので、Drive の modifiedTime が
 * 変わっていたら必ず取り直すこと（古いまま使うと「直したのに反映されない」になる）。
 * 判定は1往復で済む。
 */
const CACHE_PATH = path.join(__dirname, '..', 'data', 'secretary', 'presentation-template-cache.json');
const _memCache = new Map(); // presentationId → { modifiedTime, manifest }

/**
 * キャッシュのファイルを読む（無ければ空のオブジェクト）。
 *
 * @returns {Record<string, any>} presentationId → キャッシュの1件
 */
function _readCacheFile() {
  const obj = jsonFileStore.readJsonFile(CACHE_PATH, {}, '[PresTemplate]');
  return obj && typeof obj === 'object' ? obj : {};
}

/**
 * placeholderIdMappings で実体化されないプレースホルダーの種類（差し込み口から外す）。
 */
const NON_FILLABLE_PLACEHOLDERS = new Set(['SLIDE_NUMBER']);

/**
 * レイアウトやスライドの文字に書いた、差し込み口の記法（{{名前}}）。
 */
const VARIABLE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

// 図・グラフの置き場所を示す予約語（{{CHART}}・{{IMAGE}}）。ユーザーはテキストボックスにこれを
// 書くだけでよく、マスター表示でプレースホルダーを作る必要が無い。
const RESERVED_CHART = 'CHART';
const RESERVED_IMAGE = 'IMAGE';

/**
 * 見本スライドの名前（例: {{LAYOUT_NAME:3カード比較}}）。画面の外に置いておき、複製した後に消す。
 */
const LAYOUT_NAME_RE = /\{\{\s*LAYOUT_NAME\s*:\s*([^}]+?)\s*\}\}/;

const EMU_PER_INCH = 914400;

/**
 * ページの要素から文字を取り出す（分かれた textRun をつなげる）。
 *
 * @param {Record<string, any>} el ページの要素
 * @returns {string} 文字
 */
function _textOf(el) {
  return (el?.shape?.text?.textElements || [])
    .map((te) => te.textRun?.content || '')
    .join('');
}

/**
 * size と transform の scale から、実際に表示される位置と大きさ（インチ）を求める。
 *
 * @param {Record<string, any>} el ページの要素
 * @returns {{xIn: number, yIn: number, wIn: number, hIn: number}|null} 位置と大きさ（寸法が無ければ null）
 */
function _geometryOf(el) {
  const w = el?.size?.width?.magnitude;
  const h = el?.size?.height?.magnitude;
  if (w == null || h == null) return null;
  const sx = el.transform?.scaleX ?? 1;
  const sy = el.transform?.scaleY ?? 1;
  return {
    xIn:  Math.round(((el.transform?.translateX ?? 0) / EMU_PER_INCH) * 100) / 100,
    yIn:  Math.round(((el.transform?.translateY ?? 0) / EMU_PER_INCH) * 100) / 100,
    wIn:  Math.round(((w * sx) / EMU_PER_INCH) * 100) / 100,
    hIn:  Math.round(((h * sy) / EMU_PER_INCH) * 100) / 100,
  };
}

/**
 * 差し込み口に何行・1行に何字くらい入るかの目安を出す。
 *
 * Slides は収まらない文字を自動で縮めることがあり、実際に何行入るかは描いてみるまで分からない。
 * それでも「2行しか入らない枠に10行」のような明らかな破綻は避けたいので、枠の高さとフォントの
 * 大きさから目安を出す。最後の判断は、描いた後にサムネイルを見て直すループ（Presentation Creator）に任せる。
 *
 * @param {Record<string, any>|null} geometry 位置と大きさ（インチ）
 * @param {number} fontSizePt フォントの大きさ（pt。無ければ18）
 * @returns {{lines: number, charsPerLine: number}|null} 行数と1行の字数（大きさが無ければ null）
 */
function _estimateCapacity(geometry, fontSizePt) {
  if (!geometry) return null;
  const pt = fontSizePt || 18;
  const lineHeightIn = (pt * 1.45) / 72; // 行間1.45を仮定
  const lines = Math.max(1, Math.floor(geometry.hIn / lineHeightIn));
  // 全角文字はおおよそフォントサイズと同じ幅を取る
  const charsPerLine = Math.max(4, Math.floor(geometry.wIn / (pt / 72)));
  return { lines, charsPerLine };
}

/**
 * 要素に設定されているフォントの大きさを返す（無ければタイトルは32、それ以外は18）。
 *
 * @param {Record<string, any>} el ページの要素
 * @returns {number} フォントの大きさ（pt）
 */
function _fontSizeOf(el) {
  for (const te of el?.shape?.text?.textElements || []) {
    const s = te.textRun?.style?.fontSize?.magnitude;
    if (s) return s;
  }
  return el?.shape?.placeholder?.type === 'TITLE' || el?.shape?.placeholder?.type === 'CENTERED_TITLE'
    ? 32 : 18;
}

/**
 * 1つのレイアウトを、AI へ渡せる形にまとめる。
 *
 * 差し込み口は2種類あり、どちらもユーザーが Slides の画面で用意できる:
 *   placeholder … マスター表示で追加したプレースホルダー。書式がレイアウトから継承される
 *   variable    … テキストボックスに {{名前}} と書いたもの。位置・書式を自由に作れる
 *
 * @param {Record<string, any>} layout Slides API のレイアウト
 * @returns {Record<string, any>} id・kind（layout）・name・named・slots・hasChartArea・hasImageArea
 */
function _describeLayout(layout) {
  const name = layout.layoutProperties?.displayName || layout.layoutProperties?.name || '(名前なし)';
  const slots = [];
  let hasChartArea = false;
  let hasImageArea = false;

  for (const el of layout.pageElements || []) {
    const ph = el.shape?.placeholder;
    if (ph && !NON_FILLABLE_PLACEHOLDERS.has(ph.type)) {
      const geometry = _geometryOf(el);
      slots.push({
        kind: 'placeholder',
        key: ph.index ? `${ph.type}[${ph.index}]` : ph.type,
        type: ph.type,
        index: ph.index || 0,
        geometry,
        capacity: _estimateCapacity(geometry, _fontSizeOf(el)),
      });
      continue;
    }
    // {{名前}} 記法の差し込み口／図の置き場所
    const text = _textOf(el);
    if (!text) continue;
    for (const m of text.matchAll(VARIABLE_RE)) {
      const varName = m[1].trim();
      if (!varName) continue;
      if (varName.toUpperCase() === RESERVED_CHART) { hasChartArea = true; continue; }
      if (varName.toUpperCase() === RESERVED_IMAGE) { hasImageArea = true; continue; }
      const geometry = _geometryOf(el);
      slots.push({
        kind: 'variable',
        key: varName,
        geometry,
        capacity: _estimateCapacity(geometry, _fontSizeOf(el)),
      });
    }
  }

  return { id: layout.objectId, kind: 'layout', name, named: true, slots, hasChartArea, hasImageArea };
}

/**
 * 1枚の見本スライドを、AI へ渡せる形にまとめる。
 *
 * 名前は画面の外に置いた {{LAYOUT_NAME:...}} から読む。無ければ「見本N」とし、named を false にする。
 *
 * @param {Record<string, any>} slide Slides API のスライド
 * @param {number} index 何枚目か（0から）
 * @returns {Record<string, any>} id・kind（slide）・name・named・slots・hasChartArea・hasImageArea
 */
function _describeTemplateSlide(slide, index) {
  const slots = [];
  let hasChartArea = false;
  let hasImageArea = false;
  let name = null;

  for (const el of slide.pageElements || []) {
    const text = _textOf(el);
    if (!text) continue;
    const nameHit = text.match(LAYOUT_NAME_RE);
    if (nameHit) { name = nameHit[1].trim(); continue; }
    for (const m of text.matchAll(VARIABLE_RE)) {
      const varName = m[1].trim();
      if (!varName || /^LAYOUT_NAME\s*:/i.test(varName)) continue;
      if (varName.toUpperCase() === RESERVED_CHART) { hasChartArea = true; continue; }
      if (varName.toUpperCase() === RESERVED_IMAGE) { hasImageArea = true; continue; }
      const geometry = _geometryOf(el);
      slots.push({
        kind: 'variable',
        key: varName,
        geometry,
        capacity: _estimateCapacity(geometry, _fontSizeOf(el)),
      });
    }
  }

  return {
    id: slide.objectId,
    kind: 'slide',
    name: name || `見本${index + 1}`,
    named: !!name,
    slots,
    hasChartArea,
    hasImageArea,
  };
}

/**
 * テンプレート（ユーザーが用意した Google Slides のファイル）を読み、AI へ渡すマニフェストを作る。
 *
 * modifiedTime が前回と同じならキャッシュを返す（サムネイルを求められたのに、キャッシュに無いときを除く）。
 *
 * @param {Record<string, any>} googleService services/google-service.js のインスタンス
 * @param {Record<string, any>} creds 認証情報
 * @param {{ presentationId: string, withThumbnails?: boolean, forceRefresh?: boolean }} opts
 *   テンプレートのファイル ID・構図ごとの見た目の画像（base64）を付けるか・キャッシュを使わず取り直すか。
 *   画像は Presentation Creator が見て判断するためのもので、枚数分の往復が増えるので既定は false。
 * @returns {Promise<Record<string, any>>} presentationId・title・pageSize・layouts・templateSlideIds・
 *   deckVariables・warnings
 */
async function buildTemplateManifest(googleService, creds, { presentationId, withThumbnails = false, forceRefresh = false }) {
  // 変更されていなければ、前回の取り込み結果をそのまま使う（判定は1往復）
  let modifiedTime = null;
  if (!forceRefresh) {
    try {
      modifiedTime = await googleService.getFileModifiedTime(creds, { fileId: presentationId });
      const hit = _memCache.get(presentationId) || _readCacheFile()[presentationId];
      if (hit && modifiedTime && hit.modifiedTime === modifiedTime
          && (!withThumbnails || hit.hasThumbnails)) {
        _memCache.set(presentationId, hit);
        getLogger().info(`[PresTemplate] 「${hit.manifest.title}」は変更が無いためキャッシュを使います`);
        return hit.manifest;
      }
    } catch (e) {
      // 判定に失敗しても取り込みは続けられる（毎回取り直す側に倒す）
      getLogger().warn(`[PresTemplate] 更新時刻を確認できませんでした（取り直します）: ${e.message}`);
    }
  }

  const pres = await googleService.getPresentation(creds, {
    presentationId,
    fields: 'title,pageSize,'
      + 'layouts(objectId,layoutProperties(name,displayName),'
      + 'pageElements(objectId,size,transform,shape(shapeType,placeholder(type,index),text(textElements(textRun(content,style(fontSize))))))),'
      + 'masters(objectId,pageElements(objectId,shape(text(textElements(textRun(content))))))'
      + ',slides(objectId,pageElements(objectId,size,transform,shape(shapeType,text(textElements(textRun(content,style(fontSize)))))))',
  });

  // 見本スライドは差し込み口を持つものだけを使う。
  const templateSlides = (pres.slides || [])
    .map((sl, i) => _describeTemplateSlide(sl, i))
    .filter((t) => t.slots.length > 0 || t.hasChartArea || t.hasImageArea);
  const layoutPages = (pres.layouts || []).map(_describeLayout);
  // BUGFIX: 見本スライドが1枚でもあれば、Google の既定のレイアウト（「タイトルと本文」「2列」など）は
  // 選択肢から外す。既定のレイアウトは装飾を持たないので、選ばれるとテンプレートの意匠から浮いた
  // 素のスライドになっていた。テンプレートの作者が作った構図だけがそのデッキのデザインの語彙になる。
  // 見本スライドが無いテンプレートでは、既定のレイアウトを使う。
  const layouts = templateSlides.length > 0 ? templateSlides : layoutPages;

  // マスターに置いた {{変数}}（会社名・部署名など、デッキ全体で1回だけ差し替えるもの）
  const deckVariables = new Set();
  for (const master of pres.masters || []) {
    for (const el of master.pageElements || []) {
      for (const m of _textOf(el).matchAll(VARIABLE_RE)) {
        const v = m[1].trim();
        if (v && ![RESERVED_CHART, RESERVED_IMAGE].includes(v.toUpperCase())) deckVariables.add(v);
      }
    }
  }
  // BUGFIX: レイアウトやスライドに置いた {{変数}} はデッキの変数に含めない。マスターの変数（デッキ全体で
  // 1回）と、{{結論}} のようにスライドごとに中身が変わる変数は別物で、混ぜると全スライドの結論が
  // 同じ1文で置き換わる。スライドごとの変数は slots にだけ現れる。

  // テンプレートとして使えるかを確かめる。使えない理由は、ユーザーが原因を推測しなくて済むよう具体的に書く
  const warnings = [];
  const fillable = layouts.filter((l) => l.slots.length > 0 || l.hasChartArea || l.hasImageArea);
  if (layouts.length === 0) warnings.push('レイアウトが1つもありません。');
  if (fillable.length === 0) {
    warnings.push('差し込み口を持つレイアウトが1つもありません。'
      + 'マスター表示でプレースホルダーを追加するか、テキストボックスに {{見出し}} のように書いてください。');
  }
  const unnamed = layouts.filter((l) => !l.named
    || /^(レイアウト|Layout|Custom|カスタム|見本)\s*\d*$/i.test(l.name) || l.name === '(名前なし)');
  if (unnamed.length > 0) {
    warnings.push(`名前が付いていないものが${unnamed.length}件あります`
      + `（${unnamed.slice(0, 3).map((l) => l.name).join('・')}）。`
      + '名前はAIが使い分ける手がかりになるので、見本スライドには画面外に'
      + '{{LAYOUT_NAME:3カード比較}} のような名前を、レイアウトにはSlidesの画面で'
      + '内容が分かる名前を付けてください。');
  }

  if (withThumbnails) {
    // 構図の数だけ往復が増えるので、失敗しても全体は止めない（画像が無くても、名前と差し込み口だけで
    // 判断は続けられる）
    await Promise.all(layouts.map(async (l) => {
      try {
        const t = await googleService.getPageThumbnail(creds, { presentationId, pageObjectId: l.id, size: 'MEDIUM' });
        l.thumbnail = t;
      } catch (e) {
        getLogger().warn(`[PresTemplate] レイアウト「${l.name}」のサムネイル取得に失敗: ${e.message}`);
      }
    }));
  }

  getLogger().info(`[PresTemplate] 「${pres.title}」を取り込み: `
    + (templateSlides.length > 0
      ? `見本スライド${templateSlides.length}件を採用（Google既定レイアウト${layoutPages.length}件は除外）`
      : `レイアウト${layoutPages.length}件（見本スライドなし）`)
    + `、差し込み口あり${fillable.length}件、デッキ変数${deckVariables.size}件`
    + `${warnings.length ? `、注意${warnings.length}件` : ''}`);

  const manifest = {
    presentationId,
    title: pres.title,
    pageSize: pres.pageSize,
    layouts,
    // 仕上げたデッキから見本スライドを消すために、ID を控えておく
    templateSlideIds: (pres.slides || []).map((sl) => sl.objectId),
    deckVariables: [...deckVariables],
    warnings,
  };

  // modifiedTime が取れなかったときは、キーが作れないので保存しない（次回また取り直すだけで、
  // 古いものを使ってしまう心配は無い）
  if (modifiedTime) {
    const entry = { modifiedTime, hasThumbnails: !!withThumbnails, manifest };
    _memCache.set(presentationId, entry);
    try {
      const all = _readCacheFile();
      all[presentationId] = entry;
      jsonFileStore.writeJsonFile(CACHE_PATH, all, '[PresTemplate]');
    } catch (e) {
      getLogger().warn(`[PresTemplate] キャッシュの保存に失敗（動作に影響はありません）: ${e.message}`);
    }
  }
  return manifest;
}

/**
 * マニフェストを、AI のプロンプトへ入れる文章にする（サムネイルの画像は別に渡すので含めない）。
 *
 * @param {Record<string, any>} manifest buildTemplateManifest の結果
 * @returns {string} プロンプトに入れる文
 */
function formatManifestForPrompt(manifest) {
  const lines = [`【テンプレート「${manifest.title}」で使えるレイアウト】`];
  for (const l of manifest.layouts) {
    if (l.slots.length === 0 && !l.hasChartArea && !l.hasImageArea) continue;
    const slotDesc = l.slots.map((s) => {
      const cap = s.capacity ? `${s.capacity.lines}行×約${s.capacity.charsPerLine}字` : '容量不明';
      return `${s.key}（${cap}）`;
    });
    if (l.hasChartArea) slotDesc.push('{{CHART}}（グラフの置き場所）');
    if (l.hasImageArea) slotDesc.push('{{IMAGE}}（画像の置き場所）');
    lines.push(`・「${l.name}」— ${slotDesc.join(' / ') || '差し込み口なし'}`);
  }
  if (manifest.deckVariables.length > 0) {
    lines.push('', `【デッキ全体で1回だけ差し替える変数】${manifest.deckVariables.map((v) => `{{${v}}}`).join(' ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildTemplateManifest,
  formatManifestForPrompt,
  NON_FILLABLE_PLACEHOLDERS,
  VARIABLE_RE,
};
