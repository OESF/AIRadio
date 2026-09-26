/**
 * @file 管理画面の「リリースノート」タブ（RELEASENOTE.md の表示）
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

import { ReleaseNotesView } from '../ReleaseNotesView';

/**
 * RELEASENOTE.md の内容を、画面の高さに合わせてスクロールできる枠に表示する。
 * @param props.releaseNotesContent 本文。空文字なら「読み込み中」を表示する
 * @param props.fetchReleaseNotes 「更新」ボタンで呼ぶ
 */
export function ReleaseNotesTab({
  releaseNotesContent, fetchReleaseNotes,
}: {
  releaseNotesContent: string;
  fetchReleaseNotes: () => void;
}) {
  return (
    // ATTENTION: この管理画面では Tailwind の余白クラス（p-5 など）が効かないことがあるため、
    //            余白と高さはインラインの style で指定している。高さは画面に合わせる
    //            （計算の根拠は AgentDiaryTab.tsx のコメントを参照）。
    <div className="flex flex-col gap-4" style={{ height: 'calc(100vh - 64px)' }}>
      <div className="flex items-center justify-between border-b border-glass pb-4 flex-wrap gap-3 flex-shrink-0" style={{ marginBottom: "20px" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg">📋</span>
          <h2 className="text-lg font-bold text-neon-blue">リリースノート</h2>
          <span className="text-xs text-gray-500">RELEASENOTE.md</span>
        </div>
        <button onClick={fetchReleaseNotes}
          className="btn btn-dark text-xs px-3 py-1 border border-neon-blue/30 hover:border-neon-blue text-neon-blue">
          ↻ 更新
        </button>
      </div>

      <div className="bg-black/50 border border-glass rounded-xl overflow-hidden" style={{ flex: '1 1 auto', minHeight: 0 }}>
        <div className="overflow-y-auto" style={{ padding: '20px', height: '100%' }}>
          {releaseNotesContent === '' ? (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              読み込み中、またはRELEASENOTE.mdが見つかりません。
            </div>
          ) : (
            <ReleaseNotesView content={releaseNotesContent} />
          )}
        </div>
      </div>
    </div>
  );
}
