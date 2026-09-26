/**
 * @file プレゼンテーション作成の設定（テンプレートの一覧と、依頼の既定値）を読む
 *
 * server/data/presentation-design.md の frontmatter のうち、templates・content_defaults・design_defaults・
 * font_aliases を読む。同じファイルの colors・typography は presentation-design-tokens.js が読む。
 * 利用元は secretary-tools-presentation.js。
 *
 * コードが解釈するのは配色とフォントだけで、残り（「余白を十分に取る」「要点は3つまで」など）は定数にできる性質の
 * ものではないので、AI へ渡す文としてプロンプトへそのまま通す。
 *
 * キャッシュはしない。管理画面からテンプレートを足した直後に反映させたいので、呼ばれるたびに読み直す
 * （ファイル1つを読むだけで、スライドの作成は数分かかるので負荷は無視できる）。
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

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { getLogger } = require('../logger');

const DESIGN_MD_PATH = path.join(__dirname, '..', 'data', 'presentation-design.md');

const FALLBACK_CONTENT_DEFAULTS = {
  purpose: 'テーマの要点を分かりやすく共有する資料',
  audience: '予備知識のない一般の読み手',
  slides: '5〜7',
  tone: '落ち着いた説明調。誇張しない',
};

const FALLBACK_DESIGN_DEFAULTS = {
  colors: 'テンプレートに従う',
  fonts: 'テンプレートに従う',
  layout: '1スライドの要点は3つまで',
  diagrams: '数値の比較は棒グラフ、構成比は円グラフ、時系列は折れ線',
  whitespace: '余白を十分に取り、詰め込まない',
  notes: '各スライドに発表者用のメモを付ける',
};

// 「テンプレートに従う」（上書きしない）とみなす言い方
const FOLLOW_TEMPLATE_RE = /^(テンプレートに従う|template|default|既定|指定なし|なし)$/i;

/**
 * presentation-design.md の frontmatter を読む（読めなければ空のオブジェクト）。
 * @returns {Record<string, any>}
 */
function _read() {
  try {
    return matter(fs.readFileSync(DESIGN_MD_PATH, 'utf-8')).data || {};
  } catch (e) {
    getLogger().warn(`[PresConfig] presentation-design.md を読めませんでした（既定値で続行）: ${e.message}`);
    return {};
  }
}

/**
 * 登録されているテンプレートの一覧。presentation_id が無いものは除く。
 *
 * ATTENTION: 一覧は config.json にも置け、そちらに登録があれば優先する。presentation-design.md にはコメントが
 *            多く、管理画面から YAML を書き戻すと gray-matter がコメントを落としてしまうので、管理画面で
 *            編集するものは config.json に置く。手で書く場合は presentation-design.md にも書ける。
 *
 * @param {Record<string, any>|null} [config] config.json 全体（省略すると presentation-design.md だけを見る）
 * @returns {Array<{id: string, presentationId: string, name: string, description: string}>}
 */
function listTemplates(config = null) {
  const fromConfig = config?.presentation?.templates;
  if (Array.isArray(fromConfig) && fromConfig.length > 0) return _normalizeTemplates(fromConfig);
  const fm = _read();
  return _normalizeTemplates(Array.isArray(fm.templates) ? fm.templates : []);
}

/**
 * テンプレートの登録を、内部で使う形にそろえる。
 * @param {Array<Record<string, any>>} raw
 * @returns {Array<{id: string, presentationId: string, name: string, description: string}>}
 */
function _normalizeTemplates(raw) {
  return raw
    .filter((t) => t && typeof t.presentation_id === 'string' && t.presentation_id.trim())
    .map((t) => ({
      id: String(t.id || t.presentation_id).trim(),
      presentationId: t.presentation_id.trim(),
      name: String(t.name || t.id || '名前なし').trim(),
      description: String(t.description || '').trim(),
    }));
}

// 照合の邪魔になる語尾（「赤のテンプレートで」から「赤」を取り出すため）。助詞と、どのテンプレートにも
// 付きうる一般的な語を落とす
const MATCH_NOISE_RE = /(テンプレート|template|のやつ|もの|で作って|で|の|を|に|は|が|用|向け|版)$/g;

/**
 * 照合用に、小文字にして語尾を落とす。
 * @param {string} v
 * @returns {string}
 */
function _normalizeForMatch(v) {
  let out = String(v || '').trim().toLowerCase();
  let prev = null;
  // 語尾が重なる場合（「赤のテンプレートで」）に備え、変わらなくなるまで削る
  while (out !== prev) { prev = out; out = out.replace(MATCH_NOISE_RE, '').trim(); }
  return out;
}

/**
 * 会話での指定とテンプレートを突き合わせる。
 *
 * BUGFIX: 語尾を落としたうえで両方向を見る。「テンプレート名が指定を含むか」の一方向だけだと、「赤で」と
 *         言われたときに「赤テンプレート」に一致しなかった。
 * @param {Array<Record<string, any>>} list テンプレートの一覧
 * @param {string} requested 会話での指定
 * @returns {Record<string, any>|null}
 */
function _matchTemplate(list, requested) {
  const raw = String(requested).trim().toLowerCase();
  const q = _normalizeForMatch(raw);
  if (!q) return null;
  // ID か呼び名と完全に一致する
  const exact = list.find((t) => t.id.toLowerCase() === q || t.name.toLowerCase() === q
    || t.id.toLowerCase() === raw || t.name.toLowerCase() === raw);
  if (exact) return exact;
  // 呼び名か用途のメモが指定を含む（「ロゴ入り」なら用途のメモの「ロゴ入り」）
  const contains = list.find((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  if (contains) return contains;
  // 指定が呼び名を含む（「赤テンプレートで作って」のように長く言われた場合）
  const reverse = list.find((t) => t.name && raw.includes(t.name.toLowerCase()));
  if (reverse) return reverse;
  // 呼び名から一般的な語を落とした核（「赤テンプレート」なら「赤」）が指定に含まれる
  return list.find((t) => {
    const core = _normalizeForMatch(t.name);
    return core.length >= 1 && (raw.includes(core) || q.includes(core));
  }) || null;
}

/**
 * 使うテンプレートを1つ決める（指定・既定・先頭の順。AI の判断は含まない）。
 *
 * 戻り値の matchedBy で、明示されたのか既定に落ちたのかを呼び出し側が判断し、既定に落ちて候補が複数あるときだけ
 * AI に選ばせる（明示があれば確実に従う）。
 *   requested … 会話での指定に一致した
 *   default   … 既定に指定されたものを使った
 *   only      … 1つしか登録が無い
 *   first     … 既定が無いので先頭を使った
 *
 * @param {string|null} requested 会話での指定（ID・名前・用途のメモのいずれにも部分一致する）
 * @param {Record<string, any>|null} [config] config.json 全体
 * @returns {Record<string, any>|null} テンプレートと matchedBy。登録が無ければ null
 */
function resolveTemplate(requested, config = null) {
  const list = listTemplates(config);
  if (list.length === 0) return null;
  const fm = _read();

  if (requested) {
    const hit = _matchTemplate(list, requested);
    if (hit) return { ...hit, matchedBy: 'requested' };
    getLogger().warn(`[PresConfig] 「${requested}」に一致するテンプレートが無いため既定を使います`);
  }

  if (list.length === 1) return { ...list[0], matchedBy: 'only' };

  const defId = String(config?.presentation?.default_template || fm.default_template || '').trim().toLowerCase();
  if (defId) {
    const hit = list.find((t) => t.id.toLowerCase() === defId);
    if (hit) return { ...hit, matchedBy: 'default' };
  }
  return { ...list[0], matchedBy: 'first' };
}

/**
 * 依頼で指定されなかった項目を、presentation-design.md の既定値で埋める。
 * @param {Record<string, any>} [given] 会話から取れた指定（指定の無い項目は undefined）
 * @returns {Record<string, any>} purpose・audience・slides・tone・style・colors・fonts・project
 */
function buildBrief(given = {}) {
  const fm = _read();
  const content = { ...FALLBACK_CONTENT_DEFAULTS, ...(fm.content_defaults || {}) };
  const design = { ...FALLBACK_DESIGN_DEFAULTS, ...(fm.design_defaults || {}) };

  const pick = (v, fallback) => {
    const s = v == null ? '' : String(v).trim();
    return s ? s : fallback;
  };

  return {
    purpose:  pick(given.purpose,  content.purpose),
    audience: pick(given.audience, content.audience),
    slides:   pick(given.slides,   content.slides),
    tone:     pick(given.tone,     content.tone),
    // 見た目の指示。会話での指定が無ければ、既定の方針をまとめて渡す
    style: pick(given.style, [design.layout, design.diagrams, design.whitespace].filter(Boolean).join('。')),
    colors: pick(given.colors, design.colors),
    fonts:  pick(given.fonts,  design.fonts),
    project: given.project || null,
  };
}

/**
 * 「明朝体」のような言い方を、Google スライドが認識するフォントの名前へ直す。
 *
 * ATTENTION: スライドは知らないフォントの名前を渡されても、警告なく既定のフォントに落ちる（効いたのか失敗したのか
 *            見分けが付かない）。表に無い名前は解決できないものとして null を返し、呼び出し側はテンプレートの
 *            書式のままにする。
 *
 * @param {string} input
 * @returns {string|null} フォントの名前。解決できなければ null
 */
function resolveFontName(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (FOLLOW_TEMPLATE_RE.test(raw)) return null;
  const aliases = _read().font_aliases || {};
  if (aliases[raw]) return aliases[raw];
  // 「見出しはゴシック体で」のような言い方から拾う
  for (const [alias, family] of Object.entries(aliases)) {
    if (raw.includes(alias)) return family;
  }
  // 別名の表に無くても、フォントの名前（英字）で書かれていればそのまま通す
  if (/^[A-Za-z0-9 +\-_]+$/.test(raw)) return raw;
  getLogger().warn(`[PresConfig] フォント「${raw}」を解決できませんでした（テンプレートの書式のままにします）`);
  return null;
}

/**
 * 「テンプレートに従う」（上書きしない）の指定か。空も含む。
 * @param {string} value
 * @returns {boolean}
 */
function isFollowTemplate(value) {
  return !value || FOLLOW_TEMPLATE_RE.test(String(value).trim());
}

/**
 * 配色の指定から16進のカラーコードを拾う（「コーポレートカラーの青（#003366）」など）。
 * @param {string} value
 * @returns {string[]}
 */
function extractHexColors(value) {
  if (!value || isFollowTemplate(value)) return [];
  return [...String(value).matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
}

module.exports = {
  listTemplates,
  resolveTemplate,
  buildBrief,
  resolveFontName,
  isFollowTemplate,
  extractHexColors,
  DESIGN_MD_PATH,
};
