/**
 * @file 保存したレシピの一覧（プレーヤー画面のモーダル）
 *
 * Obsidian に保存したレシピを一覧し、開くと材料と作り方を表示する。
 *
 * ATTENTION: 「削除」ではなく「一覧から外す」操作なので、ゴミ箱のアイコン（捨てることを連想させる）は
 *            使わない。Obsidian のノートと画像はそのまま残る。
 * ATTENTION: 余白は Tailwind のクラス（p-4・pb-8 など）では効かない（実測で 0px だった）。style で指定する。
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

import { EyeOff } from 'lucide-react';
import type { SavedRecipe } from '../types';

/**
 * 保存したレシピのモーダル。
 * @param props.savedRecipes 保存したレシピ
 */
export function SavedRecipesModal({
  savedRecipes, onClose, onRemove,
}: {
  savedRecipes: SavedRecipe[];
  onClose: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-md flex flex-col rounded-2xl overflow-hidden border border-white/15"
        style={{ background: 'var(--bg-surface, #0f1623)', maxHeight: '80vh', boxShadow: '0 24px 80px rgba(0,0,0,0.7)' }}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0"
          style={{ background: 'rgba(249,115,22,0.15)' }}>
          <div className="flex items-center gap-2">
            <span className="text-lg">📖</span>
            <span className="font-bold text-sm text-orange-300 tracking-wide">保存したレシピ</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 transition-colors w-7 h-7
              flex items-center justify-center rounded-lg hover:bg-white/10"
            style={{ fontSize: '1.2rem', lineHeight: 1 }}
          >×</button>
        </div>

        {/* レシピ一覧 */}
        {/* 下側の余白だけを厚くする（最後のカードが下端に貼り付いて見切れないように） */}
        {/* 余白は style で指定する（Tailwind の余白のクラスは効かない） */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0"
          style={{ padding: '16px 16px 32px' }}>
          {savedRecipes.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">まだ保存したレシピがありません</p>
          ) : (
            savedRecipes.map(r => (
              /* BUGFIX: このカードに overflow-hidden を付けないこと。開いた中身がカードに切り取られ、
                          外側のスクロールも中身が増えたことに気づけずスクロールできなくなった
                          （角丸は内側の要素がそれぞれ持っている）。
                 ATTENTION: ここは map の返り値（式の位置）なので、波かっこで囲んだ JSX のコメントは置けない
                            （オブジェクトとして解釈されて構文が壊れる）。普通のコメントにすること。 */
              <details key={r.id} className="rounded-xl border border-white/10 bg-white/5">
                {/* BUGFIX: フォーカスの枠は内側に描く（ring-inset）。ブラウザの既定の枠は外側に描かれ、
                            角丸に四隅を削られて「角が欠けた」ように見えた */}
                <summary className="flex items-center gap-3 cursor-pointer select-none list-none rounded-xl outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-400/60"
                  style={{ padding: '10px 12px' }}>
                  <div className="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-orange-900/20 border border-orange-700/20 flex items-center justify-center">
                    {/* 画像は URL で参照する。以前の形式（base64）のデータが残っていても表示できるようにしている */}
                    {r.imageUrl
                      ? <img src={r.imageUrl} alt={r.name} className="w-12 h-12 object-cover" loading="lazy" />
                      : r.imageBase64
                      ? <img src={`data:${r.imageMimeType || 'image/png'};base64,${r.imageBase64}`} alt={r.name} className="w-12 h-12 object-cover" />
                      : <span className="text-xl">🍳</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-200 truncate">{r.name}</p>
                    {r.description && <p className="text-xs text-gray-500 truncate">{r.description}</p>}
                  </div>
                  <button
                    onClick={e => { e.preventDefault(); onRemove(r.id); }}
                    title="この一覧から外す（Obsidianのノートはそのまま残ります）"
                    className="flex-shrink-0 p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-white/10 active:scale-90 transition-all"
                  >
                    <EyeOff className="w-3.5 h-3.5" />
                  </button>
                </summary>
                <div className="space-y-2" style={{ padding: '0 12px 12px' }}>
                  {r.ingredients.length > 0 && (
                    <div>
                      <p className="text-xs font-mono text-orange-400/70 uppercase tracking-wider mb-1">材料</p>
                      <ul className="text-sm text-gray-300 space-y-0.5">
                        {r.ingredients.map((ing, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-orange-400/50 flex-shrink-0">•</span>{ing}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {r.steps.length > 0 && (
                    <div>
                      <p className="text-xs font-mono text-orange-400/70 uppercase tracking-wider mb-1">作り方</p>
                      <ol className="text-sm text-gray-300 space-y-1.5">
                        {r.steps.map((step, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-orange-400/80 font-bold flex-shrink-0 w-4">{i + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </details>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
