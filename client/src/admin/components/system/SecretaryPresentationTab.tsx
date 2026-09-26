/**
 * @file 管理画面の「プレゼンテーション」タブ（秘書がスライドを作るときのテンプレートの登録）
 *
 * テンプレートは、利用者が Google スライドの画面で作るもの。コードはその中身を知らず、ここで登録するのは
 * 「どのファイルを使うか」だけ（レイアウト・配色・ロゴ・フッターはすべてテンプレートが持つ）。普段は URL を
 * 貼るだけで済む。
 *
 * 表示名と用途のメモは、テンプレートを2つ以上登録したときだけ出す（会話で「社外提案用ので作って」と言われたときに
 * AI が選ぶ手がかりで、1つしか無い間は使われない）。公開範囲の設定は置かない（作られるのは自分の Drive の中だけで、
 * 自動では送られず、共有も本人が決める。設定の誤りがかえって誤った安心を生む）。
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

import type { FormEvent } from 'react';
import type { FullConfig, PresentationTemplate } from '../../types';

/**
 * テンプレートの一覧と登録。保存は親のフォームが行う。
 * @param props.config 管理画面の設定全体（テンプレートの一覧を書き換える）
 */

export function SecretaryPresentationTab({
  config, setConfig, saveConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
}) {
  const pres = config.presentation ?? {};
  const templates: PresentationTemplate[] = pres.templates ?? [];
  // 表示名と用途のメモは「どれを使うか選ぶ」ためのものなので、選ぶ必要があるときだけ出す
  const needsLabels = templates.length >= 2;

  const update = (next: Partial<{ templates: PresentationTemplate[]; default_template: string }>) => {
    setConfig({ ...config, presentation: { ...pres, ...next } });
  };

  const updateAt = (i: number, patch: Partial<PresentationTemplate>) => {
    update({ templates: templates.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) });
  };

  const add = () => {
    update({
      templates: [...templates, { id: `template${templates.length + 1}`, presentation_id: '' }],
    });
  };

  const remove = (i: number) => {
    const t = templates[i];
    update({
      templates: templates.filter((_, idx) => idx !== i),
      ...(pres.default_template === t.id ? { default_template: '' } : {}),
    });
  };

  // スライドの URL（…/presentation/d/<ID>/edit）を貼られても、ID だけを取り出す
  const extractId = (v: string) => {
    const m = v.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : v.trim();
  };

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-xl">🖼️</span>
        <h2 className="text-lg font-bold text-white">スライドのテンプレート</h2>
      </div>

      <div className="bg-black/20 border border-glass rounded-lg p-4" style={{ marginBottom: '20px' }}>
        <p className="text-xs text-gray-400" style={{ lineHeight: 1.9 }}>
          Google スライドで作った<strong className="text-white">ご自身のファイル</strong>を、
          スライド生成の見本として使います。URL を貼るだけで登録できます。
        </p>
        <p className="text-xs text-gray-500 mt-3" style={{ lineHeight: 1.9 }}>
          中身は Slides の画面で自由に改造できます。見本スライドを1枚足せばレイアウトが1つ増え、
          コードの変更は要りません。ロゴ・フッター・背景は
          <strong className="text-gray-300">マスター</strong>に置くと全スライドへ自動で入ります。
          差し込みたい場所は <code className="text-neon-blue">{'{{見出し}}'}</code>、
          図の場所は <code className="text-neon-blue">{'{{CHART}}'}</code>・
          <code className="text-neon-blue">{'{{IMAGE}}'}</code>、
          レイアウト名は画面外に <code className="text-neon-blue">{'{{LAYOUT_NAME:3カード比較}}'}</code> と書きます。
        </p>
        <p className="text-xs text-gray-500 mt-3">
          1つも登録されていない間は、従来どおりの組み込みテンプレートで作成されます。
        </p>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-gray-500" style={{ marginBottom: '16px' }}>
          まだテンプレートが登録されていません。
        </p>
      ) : (
        <div className="flex flex-col gap-3" style={{ marginBottom: '16px' }}>
          {templates.map((t, i) => (
            <div key={i} className="bg-black/20 border border-glass rounded-lg p-4 flex flex-col gap-3">
              <div className="flex items-end gap-3">
                <div className="flex-1 min-w-0">
                  <label>Google スライドの URL</label>
                  <input
                    type="text" placeholder="https://docs.google.com/presentation/d/..."
                    value={t.presentation_id ?? ''}
                    onChange={e => updateAt(i, { presentation_id: extractId(e.target.value) })}
                  />
                </div>
                {t.presentation_id && (
                  <a
                    href={`https://docs.google.com/presentation/d/${t.presentation_id}/edit`}
                    target="_blank" rel="noreferrer"
                    className="text-xs px-3 py-2 rounded border border-neon-blue/40 text-neon-blue hover:bg-neon-blue/10 whitespace-nowrap"
                  >
                    開く
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="text-xs px-3 py-2 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 whitespace-nowrap"
                >
                  削除
                </button>
              </div>

              {/* 表示名と用途のメモは、2つ以上あってどれを使うかを選ぶときだけ */}
              {needsLabels && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label>呼び名</label>
                    <input
                      type="text" placeholder="例: 社外提案用"
                      value={t.name ?? ''}
                      onChange={e => updateAt(i, { name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>どんなときに使うか</label>
                    <input
                      type="text" placeholder="例: 青基調・ロゴ入り。お客様へ出す資料"
                      value={t.description ?? ''}
                      onChange={e => updateAt(i, { description: e.target.value })}
                    />
                  </div>
                </div>
              )}

              {needsLabels && (
                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer w-fit">
                  <input
                    type="radio"
                    name="default_template"
                    checked={pres.default_template === t.id}
                    onChange={() => update({ default_template: t.id })}
                  />
                  指定が無いときはこれを使う
                </label>
              )}
            </div>
          ))}
        </div>
      )}

      {needsLabels && (
        <p className="text-xs text-gray-500" style={{ marginBottom: '12px' }}>
          複数あるので、会話で「社外提案用のもので作って」のように呼び名で指定できます。
          上の「呼び名」と「どんなときに使うか」が、その手がかりになります。
        </p>
      )}

      <form onSubmit={saveConfig} className="flex items-center gap-3">
        <button
          type="button" onClick={add}
          className="text-sm px-3 py-2 rounded border border-neon-blue/40 text-neon-blue hover:bg-neon-blue/10"
        >
          ＋ テンプレートを追加
        </button>
        <button
          type="submit"
          className="text-sm px-3 py-2 rounded bg-neon-blue/20 border border-neon-blue text-white hover:bg-neon-blue/30"
        >
          保存
        </button>
      </form>

      <p className="text-xs text-gray-600 mt-4">
        目的・想定読者・枚数・トーンや、余白・図解の方針といった既定値は
        <code className="mx-1">server/data/presentation-design.md</code>
        にまとめてあります。会話で「経営層向けに10枚で」と指定すれば、その回だけ上書きされます。
      </p>
    </div>
  );
}
