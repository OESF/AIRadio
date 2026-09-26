/**
 * @file プレーヤー画面右下のトースト（警告・お知らせ）
 *
 * 表示の状態は useToasts が持ち、このコンポーネントは描画だけを行う。
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

/**
 * 警告（橙）とお知らせ（青）のトーストを右下に表示する。
 * @param props.warnLeave 警告が消えるアニメーション中か（infoLeave も同様）
 * @param props.raised 下にバーがあるときに、重ならないよう少し上に表示する
 */
export function ToastOverlay({
  warnToast, infoToast, warnLeave, infoLeave, raised,
}: {
  warnToast: string | null;
  infoToast: string | null;
  warnLeave: boolean;
  infoLeave: boolean;
  raised: boolean;
}) {
  return (
    <>
      {warnToast && (
        <div className={`fixed right-5 z-50 ${raised ? 'bottom-16' : 'bottom-5'} flex items-center gap-3
          bg-gray-900/95 border border-orange-500/60 rounded-2xl px-4 py-3
          shadow-2xl backdrop-blur-md max-w-xs ${warnLeave ? 'toast-leave' : 'toast-enter'}`}>
          <span className="text-base text-orange-300">{warnToast}</span>
        </div>
      )}
      {infoToast && (
        <div className={`fixed right-5 z-50 ${raised ? 'bottom-16' : 'bottom-5'} flex items-center gap-3
          bg-gray-900/95 border border-sky-500/60 rounded-2xl px-4 py-3
          shadow-2xl backdrop-blur-md max-w-xs ${infoLeave ? 'toast-leave' : 'toast-enter'}`}>
          <span className="text-base text-sky-300">{infoToast}</span>
        </div>
      )}
    </>
  );
}
