/**
 * @file 保存したレシピ（Obsidian の Vault に保存）の一覧・保存・一覧から外す
 *
 * レシピは1件ずつ Obsidian のノートとして保存し、一覧はノートの frontmatter だけを読む
 * （画像は URL で、表示するときに取りに行く）。詳しくは server/routes/recipe-routes.js の冒頭。
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

import { useEffect, useState } from 'react';
import type { SavedRecipe } from '../types';

/**
 * 保存したレシピの一覧と、保存・一覧から外す関数を返す。画面を開いたときに一覧を読む。
 * @param serverUrl サーバーの URL
 * @param showInfo 成功を知らせるトースト
 * @param showWarn 失敗を知らせるトースト
 */
export function useSavedRecipes(serverUrl: string, showInfo: (msg: string) => void, showWarn: (msg: string) => void) {
  const [savedRecipes,     setSavedRecipes]     = useState<SavedRecipe[]>([]);
  const [savedRecipesOpen, setSavedRecipesOpen] = useState(false);

  // 画像の URL はサーバーからの相対パスで返ってくるので、表示用に絶対 URL にする
  const _withServerUrl = (list: SavedRecipe[]) => list.map(r => ({
    ...r,
    imageUrl: r.imageUrl ? `${serverUrl}${r.imageUrl}` : null,
  }));

  const _reload = () =>
    fetch(`${serverUrl}/api/recipes/list`)
      .then(r => (r.ok ? r.json() : []))
      .then((list: SavedRecipe[]) => { if (Array.isArray(list)) setSavedRecipes(_withServerUrl(list)); })
      .catch(() => {});

  useEffect(() => {
    _reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** レシピを1件保存し、一覧を読み直す。 */
  const saveRecipe = (recipe: { name: string; description: string; ingredients: string[]; steps: string[]; imageBase64: string | null; imageMimeType?: string }) => {
    fetch(`${serverUrl}/api/recipes/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // BUGFIX: 送るのはこの1件だけにする。以前は保存のたびに一覧を丸ごと送っていて、
      //         画像（1枚2MB前後）が溜まると本文の上限（20MB）を超えて保存できなくなった
      body: JSON.stringify({ ...recipe, savedAt: new Date().toISOString() }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          showWarn(body.error || 'レシピの保存に失敗しました');
          return;
        }
        showInfo(`「${recipe.name}」をObsidianに保存しました`);
        _reload();
      })
      .catch(() => showWarn('レシピの保存に失敗しました'));
  };

  /**
   * レシピを一覧から外す。削除ではなく、Obsidian のノートと画像はそのまま残る。
   * @param id レシピの名前（ノートの名前）
   */
  const removeSavedRecipe = (id: string) => {
    fetch(`${serverUrl}/api/recipes/item?name=${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((r) => {
        if (!r.ok) { showWarn('一覧から外せませんでした'); return; }
        showInfo(`「${id}」を一覧から外しました（Obsidianには残っています）`);
        _reload();
      })
      .catch(() => showWarn('一覧から外せませんでした'));
  };

  return { savedRecipes, savedRecipesOpen, setSavedRecipesOpen, saveRecipe, removeSavedRecipe };
}
