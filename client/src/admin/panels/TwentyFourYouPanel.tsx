/**
 * @file 管理画面の 24/You「番組設定」パネル
 *
 * 24/You はナレーションのエージェントが無いので、番組名と選曲の既定値だけを設定する。
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
import type { TwentyFourYouConfig } from '../types';

/**
 * 番組名・キャッチフレーズと、選曲の既定値（モード・洋楽邦楽・「あの頃」の年齢・「わがまま」のリクエスト）を
 * 編集する。設定を読み込めていなければ、読み直しのボタンを出す。
 * @param props.adminSubTab 管理画面で選んでいるタブ（'you_show_settings' のときだけ表示する）
 * @param props.config 24/You の設定。読み込めていなければ null
 * @param props.onRefreshSettings 設定を読み直す
 */
export function TwentyFourYouPanel({
  adminSubTab, config, setConfig, onSave, onRefreshSettings,
}: {
  adminSubTab: string;
  config: TwentyFourYouConfig | null;
  setConfig: (v: TwentyFourYouConfig) => void;
  onSave: (e: FormEvent) => void;
  onRefreshSettings: () => void;
}) {
  return (
    <>
      {/* 設定を読み込めなかったとき */}
      {adminSubTab === 'you_show_settings' && !config && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-gray-500">
          <span className="text-3xl">🔀</span>
          <p className="text-sm">24/You設定を読み込めませんでした。</p>
          <p className="text-xs text-gray-600">サーバーが起動しているか確認してから
            <button onClick={onRefreshSettings} className="ml-1 underline hover:text-gray-400">↻ 更新</button>
            してください。
          </p>
        </div>
      )}
      {adminSubTab === 'you_show_settings' && config && (
        <form onSubmit={onSave} className="flex flex-col gap-6">
          <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
            <span className="text-xl">🔀</span>
            <h2 className="text-lg font-bold text-white">番組設定（24/You）</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label>番組名</label>
              <input type="text" value={config.program.name}
                onChange={e => setConfig({ ...config, program: { ...config.program, name: e.target.value } })} />
            </div>
            <div>
              <label>よみがな</label>
              <input type="text" value={config.program.name_reading}
                onChange={e => setConfig({ ...config, program: { ...config.program, name_reading: e.target.value } })} />
            </div>
            <div className="md:col-span-2">
              <label>キャッチフレーズ</label>
              <textarea rows={2} value={config.program.description}
                onChange={e => setConfig({ ...config, program: { ...config.program, description: e.target.value } })} />
            </div>
            <div>
              <label>デフォルト選曲モード</label>
              <select value={config.program.selection_mode}
                onChange={e => setConfig({ ...config, program: { ...config.program, selection_mode: e.target.value as TwentyFourYouConfig['program']['selection_mode'] } })}>
                <option value="omakase">おまかせ</option>
                <option value="anokoro">あの頃</option>
                <option value="artist">歌手</option>
                <option value="shinpu">新譜</option>
                <option value="wagamama">わがまま</option>
              </select>
            </div>
            <div>
              <label>デフォルト洋楽・邦楽設定</label>
              <select value={config.program.language_pref ?? 'any'}
                onChange={e => setConfig({ ...config, program: { ...config.program, language_pref: e.target.value as TwentyFourYouConfig['program']['language_pref'] } })}>
                <option value="any">指定せず</option>
                <option value="japanese">邦楽</option>
                <option value="western">洋楽</option>
              </select>
            </div>
            <div>
              <label>あの頃: 年齢（空欄=20歳の頃。誕生日から算出した年 ± 1年で選曲）</label>
              <input type="number" value={config.program.anokoro_age ?? ''}
                onChange={e => setConfig({ ...config, program: { ...config.program, anokoro_age: e.target.value ? parseInt(e.target.value, 10) : null } })} />
            </div>
            <div className="md:col-span-2">
              <label>わがまま: デフォルトリクエスト（例: 雨の日に聴きたい、クリスマス、寂しい時に聴きたい）</label>
              <input type="text" value={config.program.wagamama_request ?? ''}
                onChange={e => setConfig({ ...config, program: { ...config.program, wagamama_request: e.target.value } })} />
            </div>
          </div>
          <p className="text-xs text-gray-500">
            ※「歌手」モードで使用するお気に入りアーティスト、「わがまま」モードのリクエスト内容は、Play画面のモード切替パネルからも登録・編集できます。
          </p>
          <button type="submit" className="btn btn-primary py-3">番組設定を保存</button>
        </form>
      )}
    </>
  );
}
