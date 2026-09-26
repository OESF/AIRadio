/**
 * @file 管理画面「発声辞書」タブ（TTS に渡す前のセリフの置換表の編集）
 *
 * エージェントのセリフを TTS に渡す直前に、上から順に適用する置換表（正規表現と置換後の
 * テキスト）を一覧・編集する。辞書の中身と保存・プレビューの処理は App.tsx が持ち、この
 * コンポーネントは表示と入力だけを受け持つ。保存先は server/data/tts_dict.json で、サーバー側では
 * agent-system.js（Live）と channel-base.js（音楽チャンネル）が読み込んで適用する。
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

import type { Dispatch, SetStateAction } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TtsDictEntry } from '../../types';

/**
 * 発声辞書の編集画面。
 *
 * 上から「プレビュー」「辞書の表」「件数と保存ボタン」を並べる。辞書の表は、見出し・既存の行・
 * 新規追加の行を別々の table に分け、既存の行だけをスクロールさせている。
 *
 * ATTENTION: 3つの table の colgroup の列幅はそろえておくこと。1つだけ変えると列がずれる。
 *
 * @param props.ttsDict 辞書のエントリ（適用する順）
 * @param props.setTtsDict 辞書を書き換える（保存するまでファイルには書かれない）
 * @param props.dictEditing 編集中のエントリの id（無ければ null）
 * @param props.setDictEditing 編集中のエントリを切り替える
 * @param props.dictSaving 保存中か
 * @param props.dictTestInput プレビューに入力したテキスト
 * @param props.setDictTestInput プレビューの入力を更新する
 * @param props.dictPreviewOpen プレビューを開いているか
 * @param props.setDictPreviewOpen プレビューの開閉を切り替える
 * @param props.dictNewEntry 新規追加の行に入力中のエントリ
 * @param props.setDictNewEntry 新規追加の行の入力を更新する
 * @param props.applyDictPreview 今の辞書をテキストへ適用した結果を返す
 * @param props.addDictEntry 新規追加の行の内容を辞書へ加える
 * @param props.saveTtsDict 辞書をサーバーへ保存する
 * @returns 発声辞書タブの要素
 */
export function DictTab({
  ttsDict, setTtsDict, dictEditing, setDictEditing, dictSaving,
  dictTestInput, setDictTestInput, dictPreviewOpen, setDictPreviewOpen,
  dictNewEntry, setDictNewEntry, applyDictPreview, addDictEntry, saveTtsDict,
}: {
  ttsDict: TtsDictEntry[];
  setTtsDict: Dispatch<SetStateAction<TtsDictEntry[]>>;
  dictEditing: number | null;
  setDictEditing: (v: number | null) => void;
  dictSaving: boolean;
  dictTestInput: string;
  setDictTestInput: (v: string) => void;
  dictPreviewOpen: boolean;
  setDictPreviewOpen: Dispatch<SetStateAction<boolean>>;
  dictNewEntry: { pattern: string; flags: string; replacement: string; note: string };
  setDictNewEntry: Dispatch<SetStateAction<{ pattern: string; flags: string; replacement: string; note: string }>>;
  applyDictPreview: (input: string) => string;
  addDictEntry: () => void;
  saveTtsDict: () => void;
}) {
  return (
    <div className="flex flex-col gap-6" style={{ height: 'calc(100vh - 60px)' }}>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-lg">🗣</span>
        <h2 className="text-lg font-bold text-neon-blue">発声辞書</h2>
        <span className="text-xs text-gray-500">server/data/tts_dict.json</span>
      </div>

      <p className="text-xs text-gray-500 -mt-2">
        エージェントのセリフがTTSに渡される直前に適用される変換テーブルです。
        上から順に適用されます。正規表現（パターン）と置換後テキストを管理できます。<br/>
        <span className="text-yellow-400">変更はすぐに反映されます（「保存」するとファイルに書き込まれます）。</span>
      </p>

      {/* プレビュー（アコーディオン） */}
      <div className="border border-glass rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.2)' }}>
        <button
          type="button"
          onClick={() => setDictPreviewOpen(p => !p)}
          className="w-full flex items-center gap-2 px-4 py-3 hover:bg-white/5 transition-colors text-left"
        >
          <span className="text-sm font-bold text-neon-purple">🔍 プレビュー</span>
          <span className="text-xs text-gray-500 ml-1">— 辞書を適用した変換結果を確認</span>
          <ChevronDown
            className="w-4 h-4 text-gray-500 shrink-0 ml-auto transition-transform duration-150"
            style={{ transform: dictPreviewOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
          />
        </button>
        {dictPreviewOpen && (
          <div className="border-t border-glass flex flex-col gap-3" style={{ padding: '16px' }}>
            <textarea
              rows={2}
              value={dictTestInput}
              onChange={e => setDictTestInput(e.target.value)}
              placeholder="変換テストするテキストを入力..."
              className="font-mono text-sm"
            />
            <div className="rounded-lg border border-glass" style={{ background: 'rgba(0,0,0,0.3)', padding: '16px' }}>
              <p className="text-xs text-gray-500 mb-1">変換後：</p>
              <p className="font-mono text-sm text-green-300 break-all whitespace-pre-wrap">
                {dictTestInput ? applyDictPreview(dictTestInput) : <span className="text-gray-600">（入力待ち）</span>}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 辞書テーブル — ヘッダー・新規追加行は固定、既存エントリのみスクロール */}
      <div className="overflow-x-auto border border-glass rounded-xl overflow-hidden flex flex-col flex-1 min-h-0" style={{ background: 'rgba(0,0,0,0.15)' }}>
        {/* ヘッダー（固定） */}
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '40px' }} />
            <col />
            <col style={{ width: '64px' }} />
            <col />
            <col style={{ width: '112px' }} />
            <col style={{ width: '96px' }} />
          </colgroup>
          <thead>
            <tr className="text-gray-500 text-left border-b border-glass text-xs uppercase tracking-wider" style={{ background: 'var(--bg-surface-solid)' }}>
              <th className="px-2 py-2 text-center">有効</th>
              <th className="px-2 py-2">パターン (regex)</th>
              <th className="px-2 py-2">フラグ</th>
              <th className="px-2 py-2">変換後</th>
              <th className="px-2 py-2">メモ</th>
              <th className="px-2 py-2 text-center">操作</th>
            </tr>
          </thead>
        </table>

        {/* 既存エントリ（スクロール可） */}
        <div className="overflow-y-auto flex-1 min-h-0">
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '40px' }} />
            <col />
            <col style={{ width: '64px' }} />
            <col />
            <col style={{ width: '112px' }} />
            <col style={{ width: '96px' }} />
          </colgroup>
          <tbody>
            {ttsDict.map((entry) => {
              const isEditing = dictEditing === entry.id;
              // 編集中の行だけ、パターンが正規表現として正しいかを確かめて入力欄の下に出す
              let patternError = '';
              if (isEditing) {
                try { new RegExp(entry.pattern, entry.flags || 'g'); }
                catch (e: any) { patternError = e.message; }
              }
              return (
                <tr
                  key={entry.id}
                  className={`border-b border-white/5 hover:bg-white/5 transition-colors
                    ${!entry.enabled ? 'opacity-40' : ''}`}
                >
                  {/* 有効トグル */}
                  <td className="px-2 py-2 text-center">
                    <button
                      onClick={() => setTtsDict(prev => prev.map(e =>
                        e.id === entry.id ? { ...e, enabled: !e.enabled } : e
                      ))}
                      className={`w-6 h-6 rounded text-xs font-bold transition-colors ${
                        entry.enabled
                          ? 'bg-green-500/30 text-green-300 hover:bg-green-500/50'
                          : 'bg-gray-700 text-gray-500 hover:bg-gray-600'
                      }`}
                      title={entry.enabled ? '無効にする' : '有効にする'}
                    >
                      {entry.enabled ? '✓' : '✗'}
                    </button>
                  </td>

                  {/* パターン */}
                  <td className="px-2 py-2 font-mono">
                    {isEditing ? (
                      <div>
                        <input
                          type="text"
                          value={entry.pattern}
                          onChange={e => setTtsDict(prev => prev.map(en =>
                            en.id === entry.id ? { ...en, pattern: e.target.value } : en
                          ))}
                          className={`w-full text-xs font-mono ${patternError ? 'border-red-500' : ''}`}
                        />
                        {patternError && (
                          <p className="text-xs text-red-400 mt-0.5 truncate" title={patternError}>⚠ {patternError}</p>
                        )}
                      </div>
                    ) : (
                      <span className={`text-xs ${entry.enabled ? 'text-yellow-300' : 'text-gray-500'}`}>
                        /{entry.pattern}/
                      </span>
                    )}
                  </td>

                  {/* フラグ */}
                  <td className="px-2 py-2">
                    {isEditing ? (
                      <input
                        type="text"
                        value={entry.flags}
                        onChange={e => setTtsDict(prev => prev.map(en =>
                          en.id === entry.id ? { ...en, flags: e.target.value } : en
                        ))}
                        className="w-full text-xs font-mono"
                        placeholder="g"
                      />
                    ) : (
                      <span className="text-xs text-gray-400 font-mono">{entry.flags}</span>
                    )}
                  </td>

                  {/* 変換後 */}
                  <td className="px-2 py-2">
                    {isEditing ? (
                      <input
                        type="text"
                        value={entry.replacement}
                        onChange={e => setTtsDict(prev => prev.map(en =>
                          en.id === entry.id ? { ...en, replacement: e.target.value } : en
                        ))}
                        className="w-full text-xs"
                      />
                    ) : (
                      <span className={`text-xs ${entry.enabled ? 'text-cyan-300' : 'text-gray-500'}`}>
                        {entry.replacement}
                      </span>
                    )}
                  </td>

                  {/* メモ */}
                  <td className="px-2 py-2">
                    {isEditing ? (
                      <input
                        type="text"
                        value={entry.note}
                        onChange={e => setTtsDict(prev => prev.map(en =>
                          en.id === entry.id ? { ...en, note: e.target.value } : en
                        ))}
                        className="w-full text-xs"
                        placeholder="メモ（任意）"
                      />
                    ) : (
                      <span className="text-xs text-gray-500">{entry.note}</span>
                    )}
                  </td>

                  {/* 操作ボタン */}
                  <td className="px-2 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {isEditing ? (
                        <button
                          onClick={() => setDictEditing(null)}
                          className="btn btn-dark text-xs px-2 py-1 border border-green-500/40 text-green-400 hover:border-green-400"
                        >
                          ✓ 完了
                        </button>
                      ) : (
                        <button
                          onClick={() => setDictEditing(entry.id)}
                          className="btn btn-dark text-xs px-2 py-1 border border-neon-blue/30 text-neon-blue hover:border-neon-blue"
                        >
                          ✏
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (!window.confirm(`「/${entry.pattern}/」を削除しますか？`)) return;
                          setTtsDict(prev => prev.filter(e => e.id !== entry.id));
                          if (dictEditing === entry.id) setDictEditing(null);
                        }}
                        className="btn btn-dark text-xs px-2 py-1 border border-red-500/30 text-red-400 hover:border-red-500"
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>

        {/* 新規追加行（常に表示） */}
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed', background: 'rgba(30, 58, 138, 0.08)' }}>
          <colgroup>
            <col style={{ width: '40px' }} />
            <col />
            <col style={{ width: '64px' }} />
            <col />
            <col style={{ width: '112px' }} />
            <col style={{ width: '96px' }} />
          </colgroup>
          <tbody>
            <tr className="border-t-2 border-neon-blue/20">
              <td className="px-2 py-2 text-center text-gray-400 text-xs">＋</td>
              <td className="px-2 py-2">
                <input
                  type="text"
                  value={dictNewEntry.pattern}
                  onChange={e => setDictNewEntry(p => ({ ...p, pattern: e.target.value }))}
                  placeholder="正規表現パターン"
                  className="w-full text-xs font-mono"
                  onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && addDictEntry()}
                />
              </td>
              <td className="px-2 py-2">
                <input
                  type="text"
                  value={dictNewEntry.flags}
                  onChange={e => setDictNewEntry(p => ({ ...p, flags: e.target.value }))}
                  placeholder="g"
                  className="w-full text-xs font-mono"
                />
              </td>
              <td className="px-2 py-2">
                <input
                  type="text"
                  value={dictNewEntry.replacement}
                  onChange={e => setDictNewEntry(p => ({ ...p, replacement: e.target.value }))}
                  placeholder="変換後のテキスト"
                  className="w-full text-xs"
                  onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && addDictEntry()}
                />
              </td>
              <td className="px-2 py-2">
                <input
                  type="text"
                  value={dictNewEntry.note}
                  onChange={e => setDictNewEntry(p => ({ ...p, note: e.target.value }))}
                  placeholder="メモ（任意）"
                  className="w-full text-xs"
                />
              </td>
              <td className="px-2 py-2 text-center">
                <button
                  onClick={addDictEntry}
                  disabled={!dictNewEntry.pattern.trim() || !dictNewEntry.replacement.trim()}
                  className="btn btn-dark text-xs px-3 py-1 border border-neon-blue/40 text-neon-blue hover:border-neon-blue disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  追加
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 pt-2 border-t border-glass">
        <p className="text-xs text-gray-500">
          {ttsDict.length}件 / 有効: {ttsDict.filter(e => e.enabled).length}件<br/>
          <span className="text-gray-600">パターンは JavaScript の RegExp 構文です。フラグ: g=グローバル, i=大文字小文字無視, gi=両方</span>
        </p>
        <button
          onClick={saveTtsDict}
          disabled={dictSaving}
          className="btn btn-primary py-3 disabled:opacity-50"
        >
          {dictSaving ? '保存中...' : '💾 保存'}
        </button>
      </div>
    </div>
  );
}
