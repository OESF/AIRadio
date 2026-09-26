/**
 * @file 管理画面の「Obsidian 連携設定」タブ（秘書が読み書きする Vault とフォルダーの設定）
 *
 * 秘書のノート・デイリーノート・ウィークリーノート・レシピ・Inbox の依頼の処理が使う、Vault のパスと
 * フォルダーの名前を設定する。保存は config.json の obsidian。
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
import type { FullConfig, ObsidianConfig } from '../../types';

/**
 * Obsidian 連携の設定の欄。
 * @param props.config 設定の全体
 * @param props.setConfig 設定を書き換える
 * @param props.saveConfig 保存する
 */
export function SecretaryObsidianTab({
  config, setConfig, saveConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
}) {
  const DEFAULT_OBSIDIAN: ObsidianConfig = {
    enabled: false,
    vault_path: '',
    inbox_folder: '00_Inbox',
    notes_folder: '01_Notes',
    // レシピの保存先。画像はこの下の images/ へ JPEG で書き出す
    recipes_folder: '01_Notes/クッキングレシピ',
    projects_folder: '02_Projects',
    daily_notes_folder: '03_Daily Notes',
    templates_folder: '10_Templates',
    daily_note_template: '10_Templates/Daily_Notes.md',
    auto_daily_report: false,
    weekly_notes_folder: '04_Weekly Notes',
    weekly_note_template: '10_Templates/Weekly_Notes.md',
    rakuten_screenshot_folder: '20_asset_data/Rakuten',
    paypay_screenshot_folder: '20_asset_data/PayPay',
    asset_ledger_sheet_url: '',
    outbox_folder: '',
  };
  // BUGFIX: 読み込むときも既定値と重ねる。config.obsidian がすでに保存されていると、後から足した項目が
  //         undefined のまま入力欄に渡り、空欄に見えていた。
  const obsidian = { ...DEFAULT_OBSIDIAN, ...(config.obsidian ?? {}) };
  const setObsidian = (patch: Partial<ObsidianConfig>) => {
    setConfig({ ...config, obsidian: { ...DEFAULT_OBSIDIAN, ...obsidian, ...patch } });
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">🗂️</span>
        <h2 className="text-lg font-bold text-neon-blue">Obsidian連携設定</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        My SecretaryのPARA機能（会議準備・議事録・リサーチ・タスク管理）を、独自のストアではなく
        実際にお使いのObsidian Vaultへ直接読み書きします（Vaultはローカルフォルダなので、
        Obsidianアプリの起動は不要です）。既存のノート（手動で書いたファイル）は絶対に上書きせず、
        新規ファイルの作成か、Secretary専有のファイル・セクションへの追記のみを行います。
        作成されたノートには<code>source: ai-radio-secretary</code>という印が付き、ご自身の
        ノートと区別できます。
      </p>
      <form onSubmit={saveConfig} className="flex flex-col gap-5">
        {/* ① 全体的な設定 ─────────────────────────────────────── */}
        <div>
          <p className="text-sm font-bold text-gray-300 mb-3">全体的な設定</p>
          <label className="flex items-center gap-3 mb-4">
            <input type="checkbox" checked={obsidian.enabled}
              onChange={e => setObsidian({ enabled: e.target.checked })} />
            <span>Obsidian連携を有効にする</span>
          </label>

          <div className="mb-4">
            <label>Vaultの絶対パス</label>
            <input type="text" value={obsidian.vault_path} placeholder="/Users/you/path/to/Vault"
              onChange={e => setObsidian({ vault_path: e.target.value })} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label>Inboxフォルダ名</label>
              <input type="text" value={obsidian.inbox_folder}
                onChange={e => setObsidian({ inbox_folder: e.target.value })} />
            </div>
            <div>
              <label>ノート（参考・リサーチ）フォルダ名</label>
              <input type="text" value={obsidian.notes_folder}
                onChange={e => setObsidian({ notes_folder: e.target.value })} />
            </div>
            <div>
              <label>プロジェクトフォルダ名</label>
              <input type="text" value={obsidian.projects_folder}
                onChange={e => setObsidian({ projects_folder: e.target.value })} />
            </div>
            <div>
              <label>レシピフォルダ名</label>
              <input type="text" value={obsidian.recipes_folder}
                onChange={e => setObsidian({ recipes_folder: e.target.value })} />
              <p className="text-xs text-gray-500 mt-1">
                料理レシピの保存先。画像はこの下の images/ へJPEGで書き出されます。
              </p>
            </div>
          </div>
        </div>

        {/* ② デイリーノートに関する設定 ───────────────────────── */}
        <div className="border-t border-glass pt-5">
          <p className="text-sm font-bold text-gray-300 mb-3">デイリーノートに関する設定</p>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label>デイリーノートフォルダ名</label>
              <input type="text" value={obsidian.daily_notes_folder}
                onChange={e => setObsidian({ daily_notes_folder: e.target.value })} />
            </div>
            <div>
              <label>デイリーノートのテンプレートパス（Vaultルートからの相対パス）</label>
              <input type="text" value={obsidian.daily_note_template}
                onChange={e => setObsidian({ daily_note_template: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            その日のデイリーノートがまだ無い場合、このテンプレートから新規作成します
            （{'{{date:YYYY-MM-DD}}'}等のプレースホルダは自動で展開されます）。
          </p>

          <label className="flex items-center gap-3">
            <input type="checkbox" checked={obsidian.auto_daily_report}
              onChange={e => setObsidian({ auto_daily_report: e.target.checked })} />
            <span>天気・ニュース・金融情報のレポートを指示なしで毎日自動作成する</span>
          </label>
          <p className="text-xs text-gray-500 mt-1">
            作成時刻は23時50分固定です（Daily Notesは「その日の終わりにまとめるもの」のため、
            時刻を早めるとまだ実測データが十分に溜まっておらずレポート内容が変わってしまうため
            変更できません）。LLMは使わず、既存の天気・ニュース・金融データ取得を再利用するだけ
            なので追加のAPI費用は発生しません。My Secretaryとの会話とは無関係に、サーバー側で
            自動的に実行されます。
          </p>
        </div>

        {/* ③ ウィークリーノートに関する設定 ───────────────────── */}
        <div className="border-t border-glass pt-5">
          <p className="text-sm font-bold text-gray-300 mb-3">ウィークリーノートに関する設定</p>
          <p className="text-xs text-gray-500 mb-4">
            上のチェックがオンの場合、毎週日曜23時50分に天気の週間振り返り・来週の天気予報・
            今週の主なニュース・秘書の週間活動記録をまとめて自動作成します。
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label>ウィークリーノートフォルダ名</label>
              <input type="text" value={obsidian.weekly_notes_folder}
                onChange={e => setObsidian({ weekly_notes_folder: e.target.value })} />
            </div>
            <div>
              <label>ウィークリーノートのテンプレートパス</label>
              <input type="text" value={obsidian.weekly_note_template}
                onChange={e => setObsidian({ weekly_note_template: e.target.value })} />
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-4 mb-2">
            週次金融資産レポート（楽天証券・PayPay銀行）用に、資産スクリーンショット（PNG/JPG）を
            あらかじめ保存しておくフォルダです。複数枚保存されていても、最終更新日時が最も新しい
            1枚が毎週使われます（証券口座へのログイン・自動取得は一切行いません）。
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label>楽天証券スクリーンショットフォルダ名</label>
              <input type="text" value={obsidian.rakuten_screenshot_folder}
                onChange={e => setObsidian({ rakuten_screenshot_folder: e.target.value })} />
            </div>
            <div>
              <label>PayPay銀行スクリーンショットフォルダ名</label>
              <input type="text" value={obsidian.paypay_screenshot_folder}
                onChange={e => setObsidian({ paypay_screenshot_folder: e.target.value })} />
            </div>
          </div>

          <p className="text-xs text-gray-500 mt-4 mb-2">
            ご自身で管理されている資産台帳（Googleスプレッドシート）のURLです。上のスクリーンショットが
            「今この瞬間の残高」であるのに対し、こちらは週次の時価評価額が長期にわたって蓄積された
            時系列データとして扱います。ドローダウンや資産推移のように、過去からの変化を見るための
            材料になります。
            <br />
            シートはSecretaryのGoogleアカウントから読める必要があります（閲覧権限で共有してください）。
            特定のタブを指定する場合は、URL末尾の<code>#gid=数字</code>まで含めて貼り付けてください。
          </p>
          <div>
            <label>資産台帳スプレッドシートのURL</label>
            <input type="text"
              placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"
              value={obsidian.asset_ledger_sheet_url}
              onChange={e => setObsidian({ asset_ledger_sheet_url: e.target.value })} />
          </div>
        </div>

        {/* ④ Inboxバッチ処理に関する設定 ───────────────────────── */}
        <div className="border-t border-glass pt-5">
          <p className="text-sm font-bold text-gray-300 mb-3">Inboxバッチ処理に関する設定</p>
          <p className="text-xs text-gray-500 mb-4">
            上のInboxフォルダの中に作成した<code>secretary</code>サブフォルダ
            （例: <code>{obsidian.inbox_folder}/secretary</code>）に「〇〇について調べてまとめて」
            のような依頼メモ（.mdファイル）を置いておくと、secretary_loopが定期的に検知して
            調査・レポート化まで自動で行います。結果は下のOutboxフォルダの中の
            <code>secretary</code>サブフォルダへ、「完了しました」というステータスや
            問題があればその内容として書き込まれます（処理済みの依頼メモ自体は
            Inbox内の<code>_done</code>/<code>_failed</code>サブフォルダへ移動します）。
            Outboxフォルダ名を空欄のままにしておくと、この機能自体が無効になります
            （既存のInbox運用に影響しません）。
          </p>
          <div className="mb-2">
            <label>Outboxフォルダ名</label>
            <input type="text" value={obsidian.outbox_folder} placeholder="例: 09_outbox"
              onChange={e => setObsidian({ outbox_folder: e.target.value })} />
          </div>
        </div>

        <button type="submit" className="btn btn-primary py-3">💾 保存</button>
      </form>
    </div>
  );
}
