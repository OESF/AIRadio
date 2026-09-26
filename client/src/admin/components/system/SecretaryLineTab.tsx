/**
 * @file 管理画面の「LINE連携設定」タブ（秘書の LINE 公式アカウント）
 *
 * LINE の認証情報（チャネルアクセストークン・シークレット）は「認証情報設定」で入力し、ここでは
 * 有効・無効と本人確認（応答してよい userId）を設定する。
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
import type { FullConfig, LineConfig } from '../../types';

/**
 * LINE 連携の有効化と、本人の userId の登録。
 *
 * 登録済みの userId 以外からのメッセージには応答しない（第三者が友だち追加しても応答しないため）。
 * 未登録の送信者が来たらサーバーがその userId を記録するので、それを本人のものとして登録できる。
 * @param props.config 管理画面の設定全体（line を書き換える）
 */
export function SecretaryLineTab({
  config, setConfig, saveConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
}) {
  const DEFAULT_LINE: LineConfig = {
    enabled: false,
    authorized_user_id: '',
    last_unauthorized_sender_id: '',
  };
  const line = { ...DEFAULT_LINE, ...(config.line ?? {}) };
  const setLine = (patch: Partial<LineConfig>) => {
    setConfig({ ...config, line: { ...DEFAULT_LINE, ...line, ...patch } });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">💬</span>
        <h2 className="text-lg font-bold text-neon-blue">LINE連携設定</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        My Secretary専用のLINE公式アカウントと、あなた本人が1対1でテキストのやり取りをできる
        ようにします。予定の確認・変更・削除、メール確認、Obsidianノート作成など、音声版の
        My Secretaryとほぼ同じ機能がLINEからも使えます。認証情報（チャネルアクセストークン・
        チャネルシークレット）は「システム管理 → 認証情報設定」の「💬 LINE連携」から入力
        してください。
      </p>
      <form onSubmit={saveConfig} className="flex flex-col gap-5">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={line.enabled}
            onChange={e => setLine({ enabled: e.target.checked })} />
          <span>LINE連携を有効にする</span>
        </label>

        <div className="border-t border-glass pt-5">
          <p className="text-sm font-bold text-gray-300 mb-3">本人確認（重要）</p>
          <p className="text-xs text-gray-500 mb-4">
            第三者がこのLINE公式アカウントを友だち追加した場合に誤って応答してしまわないよう、
            登録済みのuserId（あなた本人のLINE ID）と一致しない送信者には一切応答しません。
            まだ登録が済んでいない場合は、下の欄が空のままで大丈夫です——このLINE公式アカウント
            へ何かメッセージを1通送ってください。そのメッセージの送信元userIdが下に自動で
            表示されるので、それをあなた本人のuserIdとして「あなたのuserId」欄へ貼り付けて
            保存してください。
          </p>
          <div className="mb-4">
            <label>あなたのuserId</label>
            <input type="text" value={line.authorized_user_id} placeholder="U で始まる文字列"
              onChange={e => setLine({ authorized_user_id: e.target.value })} />
          </div>
          {line.last_unauthorized_sender_id && (
            <div className="bg-black/20 border border-glass rounded-lg px-3 py-3 text-xs text-gray-400">
              直近に検知した未登録の送信者userId: <code className="text-neon-blue">{line.last_unauthorized_sender_id}</code>
              <br />
              これがあなた自身から送ったメッセージであれば、上の欄へコピーして保存してください。
            </div>
          )}
        </div>

        <p className="text-xs text-gray-500 -mt-1">
          ※ LINEのWebhookを受け取るための外部公開（ngrokトンネル）の設定は、「システム管理 →
          認証情報設定 → 🌐 ngrokトンネル自動起動」に移動しました（LINE専用ではなく汎用の
          インフラ設定のため）。
        </p>

        <button type="submit" className="btn btn-primary py-3">💾 保存</button>
      </form>
    </div>
  );
}
