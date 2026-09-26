/**
 * @file My Secretary（秘書）のメインパネル（状態・ファイルとテキストの共有・キャンバス）
 *
 * 上から順に、状態の行・入力欄（ファイルの添付とテキストの共有）・キャンバス（秘書が画面に出した情報）を置く。
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

import { useRef, useState } from 'react';
import type { useSecretaryLive } from '../hooks/useSecretaryLive';
import { SecretaryCanvasView } from './SecretaryCanvas';

/**
 * 秘書のパネル。
 * @param props.secretary useSecretaryLive の返り値（会話の状態・キャンバス・送信の関数）
 */
export function SecretaryPanel({
  secretaryLive, onExitChannel,
}: {
  secretaryLive: ReturnType<typeof useSecretaryLive>;
  onExitChannel: () => void;
}) {
  // 添付ボタンは、隠したファイルの入力欄をクリックして開く
  const secretaryFileInputRef = useRef<HTMLInputElement>(null);
  // テキストの共有欄（URL・長文など、音声では伝えにくいものを何でも渡せる）
  const [secretaryInfoText, setSecretaryInfoText] = useState('');

  return (
    <fieldset className="glass-fieldset">
      <legend>
        <span className="text-xl">👩‍💼</span>
        <span className="text-base font-normal text-gray-300">My Secretary</span>
      </legend>
      {/* BUGFIX: 外枠の高さを画面に合わせて固定し、中身を flex で分けること（calc(100vh - 84px)。84px は実測の開始位置と下の余白）。
                  以前はキャンバスだけが画面基準の固定の高さを持ち、状態の行と入力欄の分だけはみ出して、ページ全体が常に縦にスクロールした */}
      <div className="flex flex-col gap-3 mt-3 h-[calc(100vh-84px)]">
        <div className="flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
              secretaryLive.activeJobs.length > 0 ? 'bg-amber-300 animate-pulse'
              : secretaryLive.consultingAgentName ? 'bg-purple-400 animate-pulse'
              : secretaryLive.consultPendingName ? 'bg-purple-400 animate-pulse'
              : secretaryLive.isStalled ? 'bg-red-400 animate-pulse'
              : secretaryLive.isProcessing ? 'bg-sky-400 animate-pulse'
              : secretaryLive.status === 'connected' ? 'bg-emerald-400 animate-pulse'
              : secretaryLive.status === 'connecting' ? 'bg-amber-400 animate-pulse'
              : 'bg-red-400'}`}
            />
            <span className="text-sm text-gray-300">
              {secretaryLive.activeJobs.length > 0
                ? `⚙️ ご依頼の処理を進めています（${secretaryLive.activeJobs.length}件）`
                : secretaryLive.consultingAgentName
                ? `🎙️ ${secretaryLive.consultingAgentName}が回答中…`
                : secretaryLive.consultPendingName
                ? `📞 ${secretaryLive.consultPendingName}にお繋ぎしています… （声が始まるまで30秒ほどかかります）`
                : secretaryLive.isStalled ? '⚠️ 応答がありません — もう一度話しかけてみてください'
                : secretaryLive.isProcessing ? '処理中…'
                : secretaryLive.status === 'connected' ? '会話中 — マイクに話しかけてください'
                : secretaryLive.status === 'connecting' ? '接続中…'
                : secretaryLive.status === 'error' ? '接続に失敗しました' : ''}
            </span>
          </div>
          {(secretaryLive.status === 'connected' || secretaryLive.status === 'connecting') ? (
            <button
              onClick={() => { secretaryLive.disconnect(); onExitChannel(); }}
              className="btn btn-dark text-sm flex-shrink-0"
            >
              会話を終了
            </button>
          ) : (
            <button
              onClick={() => secretaryLive.connect()}
              className="btn btn-primary text-sm flex-shrink-0"
            >
              もう一度試す
            </button>
          )}
        </div>
        {/* 裏で動いている仕事の進み具合。スライド作成のように数分かかるものは、その間モデルが何も話さず
            黙り込んだように見えるため、何をどこまで進めたかをここに出し続ける（進み具合はサーバーが随時更新する）。
            ATTENTION: 会話の一時的な状態（処理中・相談中）とは別に、独立した欄として常に出すこと。
            状態の行だけだと、秘書が別の発言をした拍子に表示が入れ替わって見えなくなる */}
        {secretaryLive.activeJobs.length > 0 && (
          <div className="flex-shrink-0 rounded-lg border border-amber-300/25 bg-amber-300/8 px-3 py-2">
            <div className="text-xs text-amber-200/90 mb-1">
              ⚙️ ご依頼の処理を進めています。終わりましたらこの画面と声でお知らせします。
            </div>
            {secretaryLive.activeJobs.map(job => (
              <div key={job.id} className="text-xs text-gray-300 flex items-baseline gap-2 py-0.5">
                <span className="flex-shrink-0 text-amber-200/70">
                  {job.kind === 'presentation' ? 'スライド作成' : '調べもの'}
                </span>
                <span className="truncate text-gray-400">{job.request}</span>
                {job.progress && (
                  <span className="flex-shrink-0 ml-auto text-amber-100">{job.progress}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {/* ファイルの添付とテキストの共有を1行にまとめた入力欄（テキスト欄の横に 📎 を置く、チャット画面の一般的な形）。
            ATTENTION: ファイルの形式もテキストの中身も、ここで判断しないこと。可否は秘書（Gemini）に任せる */}
        {secretaryLive.status === 'connected' && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <input
              ref={secretaryFileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) secretaryLive.uploadFile(file);
                e.target.value = ''; // 同じファイルを続けて選び直せるようにリセット
              }}
            />
            <button
              onClick={() => secretaryFileInputRef.current?.click()}
              disabled={secretaryLive.isUploadingFile}
              title="ファイルを添付（20MBまで、形式は問いません）"
              className="btn btn-dark text-sm flex-shrink-0 w-9 h-9 !p-0 flex items-center justify-center"
            >
              {secretaryLive.isUploadingFile ? '⏳' : '📎'}
            </button>
            <textarea
              value={secretaryInfoText}
              onChange={(e) => setSecretaryInfoText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && secretaryInfoText.trim()) {
                  e.preventDefault();
                  secretaryLive.shareInfo(secretaryInfoText.trim());
                  setSecretaryInfoText('');
                }
              }}
              placeholder="音声では伝えにくい情報を貼り付け（URL・長文など。Shift+Enterで改行）"
              rows={1}
              className="flex-1 min-w-0 rounded-lg bg-black/30 border border-white/10 px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 resize-y"
            />
            <button
              onClick={() => {
                if (!secretaryInfoText.trim()) return;
                secretaryLive.shareInfo(secretaryInfoText.trim());
                setSecretaryInfoText('');
              }}
              disabled={!secretaryInfoText.trim()}
              className="btn btn-dark text-sm flex-shrink-0"
            >
              🔗 共有
            </button>
          </div>
        )}
        {/* キャンバス: 秘書が show_on_canvas などで画面に出した情報（メールのまとめ・株価・レシピ・天気図など）。
            上書きせずに追記していく。会話の一時的な状態は上の状態の行で伝えるので、ここでは履歴が空のときだけ案内を出す */}
        {secretaryLive.canvasEntries.length === 0 ? (
          <div className="rounded-lg border border-white/8 bg-black/20 flex-1 min-h-0 flex items-center justify-center px-4 text-center text-sm text-gray-500">
            {secretaryLive.consultingAgentName
              ? `${secretaryLive.consultingAgentName}本人の声で回答しています…`
              : secretaryLive.consultPendingName
              ? `${secretaryLive.consultPendingName}にお繋ぎしています。本人の声が始まるまで30秒ほどかかります…`
              : secretaryLive.isStalled
              ? '応答が止まっているようです。少し待つか、もう一度話しかけてください。'
              : secretaryLive.isProcessing
              ? '内部で情報を確認しています。少々お待ちください…'
              : 'ここに会話に関連する情報が表示されます（「キャンバスに表示して」と話しかけてみてください）'}
          </div>
        ) : (
          <SecretaryCanvasView
            entries={secretaryLive.canvasEntries}
            className="rounded-lg border border-white/8 bg-black/20 py-4 px-4 flex-1 min-h-0 overflow-y-auto"
          />
        )}
      </div>
    </fieldset>
  );
}
