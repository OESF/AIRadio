/**
 * @file プレゼンテーション（Google スライド）のデザインの値を、presentation-design.md から読む
 *
 * 秘書の create_presentation ツールが作るスライドの色・フォント・大きさを、
 * data/presentation-design.md の frontmatter から読み込む。値を変えるときは .md だけを書き換えればよい
 * （プログラムの知識が無くてもデザインを調整できるように）。
 *
 * frontmatter のキーは Google Labs の DESIGN.md の仕様（https://github.com/google-labs-code/design.md）の
 * colors・typography にできる限り合わせ、本家に無い概念（グラフの配色ルールなど）だけを
 * x_ で始まる拡張キー（x_chart_rules・x_layout）にしている。
 *
 * 呼び出し側は .md を直接読まず、このモジュールの COLORS・FONTS・SIZES を使う。frontmatter の
 * キーの構成が変わっても、呼び出し側を直さずに済む。
 *
 * 主な利用元: setup-presentation-template.js（テンプレートの作成）・lib/secretary-tools-presentation.js（グラフ）
 * 読み込み元: data/presentation-design.md
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

const DESIGN_MD_PATH = path.join(__dirname, '..', 'data', 'presentation-design.md');

/**
 * presentation-design.md の frontmatter を読む。
 * @returns {Record<string, any>}
 * @throws {Error} 必須のキー（name・colors・typography）が無いとき
 */
function _loadFrontmatter() {
  const raw = fs.readFileSync(DESIGN_MD_PATH, 'utf-8');
  const { data } = matter(raw);
  const required = ['name', 'colors', 'typography'];
  for (const key of required) {
    if (!data[key]) {
      throw new Error(`presentation-design.mdのfrontmatterに"${key}"がありません（${DESIGN_MD_PATH}）`);
    }
  }
  return data;
}

const _fm = _loadFrontmatter();

/** 色（"#rrggbb"）。 */
const COLORS = {
  darkBg: _fm.colors.dark_bg,
  darkSurface: _fm.colors.dark_surface,
  lightBg: _fm.colors.light_bg,
  lightInk: _fm.colors.light_ink,
  accent: _fm.colors.accent,
  chartSecondary: _fm.colors.chart_secondary,
  success: _fm.colors.success,
  danger: _fm.colors.danger,
  gridline: _fm.colors.gridline,
};

/** フォントの名前。 */
const FONTS = {
  heading: _fm.typography.heading,
  body: _fm.typography.body,
  mono: _fm.typography.mono,
};

/** 文字の大きさ（pt）と、箇条書きの行数の上限。 */
const SIZES = {
  titlePt: _fm.typography.min_title_pt,
  bodyPt: _fm.typography.min_body_pt,
  maxBulletLines: _fm.x_layout?.max_bullet_lines ?? 6,
};

/**
 * "#rrggbb" を、Slides・Sheets の API が求める { red, green, blue }（それぞれ 0〜1）に変換する。
 * @param {string} hex
 * @returns {{red: number, green: number, blue: number}}
 * @throws {Error} 形式が正しくないとき
 */
function hexToRgbFloat(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`不正なカラーコード: ${hex}`);
  return {
    red: parseInt(m[1], 16) / 255,
    green: parseInt(m[2], 16) / 255,
    blue: parseInt(m[3], 16) / 255,
  };
}

module.exports = { COLORS, FONTS, SIZES, hexToRgbFloat };
