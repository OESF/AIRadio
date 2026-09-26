/**
 * @file 保存したレシピの API（Obsidian の Vault に、レシピ1件をノート1枚として保存する）
 *
 * GET /api/recipes/list・/api/recipes/image、POST /api/recipes/save、DELETE /api/recipes/item。
 * 画像は Vault の中に JPEG のファイルとして書き出し、ノートから ![[...]] で参照する（キャンバスの Obsidian 保存と
 * 同じ考え方）。一覧はノートの frontmatter だけを読むので軽く、Obsidian でも普通に検索・リンクできる。
 *
 * BUGFIX: 保存で送るのはその1件だけにする。以前は一覧をまるごと1つの JSON に持ち、保存のたびに全件を送り直して
 *         いたため、画像（1枚2MB前後の Base64）が増えると express.json の上限を超えて保存できなくなった。
 *         上限を上げても先送りにしかならない。
 *
 * 画像は JPEG に変換して軽くする（Vault は同期の対象なので）。変換には音声処理で使っている ffmpeg-static を使い、
 * 失敗したら元の画像のまま保存する。同じ名前のレシピは置き換える。
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
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const obsidianService = require('../services/obsidian-service');
const { getLogger } = require('../logger');

const DEFAULT_RECIPES_FOLDER = '01_Notes/クッキングレシピ';

/**
 * Vault のファイル名に使えない文字を落とす（パスの区切りが混ざるのも防ぐ）。
 * @param {string} name
 * @returns {string}
 */
function _safeFileName(name) {
  return String(name || 'レシピ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80) || 'レシピ';
}

/**
 * レシピと画像のフォルダー。
 * @param {Record<string, any>} obs config.obsidian
 * @returns {{ recipes: string, images: string }}
 */
function _folders(obs) {
  const recipes = obs.recipes_folder || DEFAULT_RECIPES_FOLDER;
  return { recipes, images: path.posix.join(recipes, 'images') };
}

// 一覧から外したレシピの名前（server/data/recipe_hidden.json）。
// ATTENTION: 「削除」は Vault のファイルに一切触れず、名前を控えて一覧から隠すだけ。Obsidian 側はすべて蓄積し、
//            画面には必要なもの・新しいものだけを残す。
// 端末をまたいでそろえるためサーバーに置く（ブラウザの localStorage だと端末ごとにばらつく）。
const HIDDEN_PATH = path.join(__dirname, '..', 'data', 'recipe_hidden.json');

/**
 * 一覧から外した名前を読む。
 * @returns {string[]}
 */
function _readHidden() {
  try {
    const v = JSON.parse(fs.readFileSync(HIDDEN_PATH, 'utf-8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];   // 無い・壊れているときは、何も外していないとみなす
  }
}

/**
 * 一覧から外した名前を書く（重なりは除く）。
 * @param {string[]} list
 */
function _writeHidden(list) {
  fs.writeFileSync(HIDDEN_PATH, JSON.stringify([...new Set(list)], null, 2), 'utf-8');
}

/**
 * PNG などを JPEG に変換する（画像1枚なので mjpeg で1フレームだけ出す）。
 * @param {Buffer} buffer
 * @returns {Promise<Buffer|null>} 失敗したら null（呼び出し側が元の画像を使う）
 */
function _toJpeg(buffer) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ff = spawn(ffmpegStatic, [
        '-i', 'pipe:0',
        '-f', 'mjpeg', '-q:v', '3',   // 見た目の劣化がほぼ分からず、十分小さい
        'pipe:1',
      ]);
      ff.stdout.on('data', (c) => chunks.push(c));
      ff.stdout.on('end', () => {
        const out = Buffer.concat(chunks);
        finish(out.length > 0 ? out : null);
      });
      ff.stderr.on('data', () => {});
      ff.on('error', () => finish(null));
      ff.stdin.on('error', () => finish(null));   // 途中で終わったときの EPIPE で落とさない
      ff.stdin.write(buffer);
      ff.stdin.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * ノートの本文（人が読む形）を作る。構造化した値は frontmatter の側に持たせる。
 * @param {{ description?: string, ingredients?: string[], steps?: string[], imageRel?: string|null }} recipe
 * @returns {string}
 */
function _buildBody({ description, ingredients, steps, imageRel }) {
  const lines = [];
  if (imageRel) lines.push(`![[${imageRel}]]`, '');
  if (description) lines.push(description, '');
  if (ingredients?.length) {
    lines.push('## 材料', ...ingredients.map((x) => `- ${x}`), '');
  }
  if (steps?.length) {
    lines.push('## 作り方', ...steps.map((x, i) => `${i + 1}. ${x}`), '');
  }
  return lines.join('\n').trim();
}

/**
 * レシピ1件を Vault へ書き出す（保存と移行で使う）。
 * @param {string} vaultPath
 * @param {Record<string, any>} obs config.obsidian
 * @param {Record<string, any>} recipe
 * @returns {Promise<{ noteRel: string, imageRel: string|null }>}
 */
async function _writeRecipeToVault(vaultPath, obs, recipe) {
  const { recipes: recipesFolder, images: imagesFolder } = _folders(obs);
  const safe = _safeFileName(recipe.name);
  const noteRel = path.posix.join(recipesFolder, `${safe}.md`);

  let imageRel = null;
  if (recipe.imageBase64) {
    const raw = Buffer.from(recipe.imageBase64, 'base64');
    const jpeg = await _toJpeg(raw);
    const ext = jpeg ? 'jpg' : (String(recipe.imageMimeType || '').includes('jpeg') ? 'jpg' : 'png');
    imageRel = path.posix.join(imagesFolder, `${safe}.${ext}`);
    obsidianService.writeBinaryAsset(vaultPath, imageRel, jpeg || raw);
    if (jpeg) {
      getLogger().info(`[Recipe] 画像を変換: ${(raw.length / 1024 / 1024).toFixed(2)}MB → `
        + `${(jpeg.length / 1024).toFixed(0)}KB (${safe})`);
    } else {
      getLogger().warn(`[Recipe] 画像のJPEG変換に失敗したため元の形式で保存: ${safe}`);
    }
  }

  // 同じ名前は置き換える（writeNote は上書きしないので、先に消す）
  const noteFull = obsidianService.resolveSafePath(vaultPath, noteRel);
  if (fs.existsSync(noteFull)) fs.unlinkSync(noteFull);

  obsidianService.writeNote(vaultPath, noteRel, {
    frontmatter: {
      title: recipe.name,
      type: 'recipe',
      tags: ['レシピ', '料理'],
      description: recipe.description || '',
      ingredients: recipe.ingredients || [],
      steps: recipe.steps || [],
      image: imageRel || '',
      savedAt: recipe.savedAt || new Date().toISOString(),
    },
    body: _buildBody({
      description: recipe.description,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      imageRel,
    }),
  });
  return { noteRel, imageRel };
}

/**
 * ノート1枚を、画面が扱う形に戻す（画像は URL で参照し、バイト列は載せない）。
 * @param {string} vaultPath
 * @param {string} noteRel
 * @returns {Record<string, any>|null}
 */
function _noteToRecipe(vaultPath, noteRel) {
  const note = obsidianService.readNote(vaultPath, noteRel);
  if (!note) return null;
  const fm = note.frontmatter || {};
  const name = fm.title || path.basename(noteRel, '.md');
  return {
    id: name,
    name,
    description: fm.description || '',
    ingredients: Array.isArray(fm.ingredients) ? fm.ingredients : [],
    steps: Array.isArray(fm.steps) ? fm.steps : [],
    imageBase64: null,
    imageUrl: fm.image ? `/api/recipes/image?path=${encodeURIComponent(fm.image)}` : null,
    savedAt: fm.savedAt || fm.created || '',
    notePath: noteRel,
  };
}

/**
 * 古い saved_recipes.json を Vault へ移す（起動時に1回だけ）。
 * 移したらファイルを空の配列にして、大きなファイルを毎回読む状態もなくす。
 * @param {{ recipesPath: string, config: Record<string, any> }} opts
 * @returns {Promise<void>}
 */
async function migrateSavedRecipesToVault({ recipesPath, config }) {
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.vault_path) return;
  if (!fs.existsSync(recipesPath)) return;

  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(recipesPath, 'utf-8'));
  } catch (e) {
    getLogger().warn(`[Recipe] 旧レシピの読み込みに失敗（移行を中止）: ${e.message}`);
    return;
  }
  if (!Array.isArray(list) || list.length === 0) return;

  getLogger().info(`[Recipe] 旧レシピ${list.length}件をObsidianへ移行します`);
  let ok = 0;
  for (const r of list) {
    try {
      await _writeRecipeToVault(obs.vault_path, obs, r);
      ok++;
    } catch (e) {
      getLogger().warn(`[Recipe] 移行に失敗（この1件はスキップ）: ${r?.name || '(名前なし)'} — ${e.message}`);
    }
  }
  if (ok > 0) {
    // 全部移せたときだけ空にする。1件でも失敗したら元のファイルを残し、次回また試す
    if (ok === list.length) {
      fs.writeFileSync(recipesPath, '[]', 'utf-8');
      getLogger().info(`[Recipe] 移行完了（${ok}件）。saved_recipes.json を空にしました`);
    } else {
      getLogger().warn(`[Recipe] 移行は${ok}/${list.length}件のみ成功。元ファイルは残します`);
    }
  }
}

/**
 * レシピの API を登録する。
 * @param {import('express').Express} app
 * @param {{ readJsonFile: Function, getInitialConfig: Function, CONFIG_PATH: string }} ctx
 */
function registerRecipeRoutes(app, { readJsonFile, getInitialConfig, CONFIG_PATH }) {
  const _obs = () => {
    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    return config.obsidian || {};
  };
  const _guard = (res, obs) => {
    if (!obs.enabled || !obs.vault_path) {
      res.status(400).json({ error: 'Obsidian連携が有効になっていません（管理画面で設定してください）。' });
      return true;
    }
    return false;
  };

  // 一覧（frontmatter だけを読む。画像のバイト列は載せないので軽い）
  app.get('/api/recipes/list', (req, res) => {
    const obs = _obs();
    if (!obs.enabled || !obs.vault_path) return res.json([]);   // 未設定なら空（画面は壊さない）
    try {
      const { recipes: folder } = _folders(obs);
      // 一覧から外したものは返さない（Vault には残っている）
      const hidden = new Set(_readHidden());
      const items = obsidianService.listNotes(obs.vault_path, folder)
        .map((rel) => _noteToRecipe(obs.vault_path, rel))
        .filter(Boolean)
        .filter((x) => !hidden.has(x.name))
        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      res.json(items);
    } catch (e) {
      getLogger().warn(`[Recipe] 一覧の取得に失敗: ${e.message}`);
      res.json([]);
    }
  });

  // 画像（Vault の中のファイルを返す。パスは resolveSafePath で Vault の外へ出られない）
  app.get('/api/recipes/image', (req, res) => {
    const obs = _obs();
    if (_guard(res, obs)) return;
    try {
      const rel = String(req.query.path || '');
      if (!rel) return res.status(400).json({ error: 'path が必要です' });
      const full = obsidianService.resolveSafePath(obs.vault_path, rel);
      if (!fs.existsSync(full)) return res.status(404).json({ error: '画像が見つかりません' });
      res.type(path.extname(full).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');
      res.sendFile(full);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 保存（1件だけ受け取るので、送る量は件数に関わらず一定）
  app.post('/api/recipes/save', async (req, res) => {
    const obs = _obs();
    if (_guard(res, obs)) return;
    try {
      const recipe = req.body || {};
      if (!recipe.name) return res.status(400).json({ error: 'レシピ名がありません' });
      const { noteRel } = await _writeRecipeToVault(obs.vault_path, obs, recipe);
      // 一覧から外した料理をもう一度保存したら、また見たいということなので戻す
      const hidden = _readHidden();
      if (hidden.includes(recipe.name)) _writeHidden(hidden.filter((n) => n !== recipe.name));
      getLogger().info(`[Recipe] 保存しました: ${noteRel}`);
      res.json({ success: true, notePath: noteRel, recipe: _noteToRecipe(obs.vault_path, noteRel) });
    } catch (e) {
      getLogger().warn(`[Recipe] 保存に失敗: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // 一覧から外す。
  // ATTENTION: Obsidian のノートと画像には一切触れない（Vault の側は常に全件が残る）。
  app.delete('/api/recipes/item', (req, res) => {
    try {
      const name = String(req.query.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name が必要です' });
      _writeHidden([..._readHidden(), name]);
      getLogger().info(`[Recipe] 一覧から外しました（Obsidianのノートはそのまま残ります）: ${name}`);
      res.json({ success: true, hidden: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerRecipeRoutes, migrateSavedRecipesToVault, DEFAULT_RECIPES_FOLDER };
