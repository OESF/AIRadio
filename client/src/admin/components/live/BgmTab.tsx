/**
 * @file 管理画面の Live「BGM管理」タブ（メイン・オープニング・ワールドレポートの BGM の一覧と試聴）
 *
 * server/assets/bgm/ の下の BGM を区分ごとに一覧し、試聴できるようにする（GET /api/bgm/all）。
 * ワールドレポートは、ジングルと、都市ごとのフォルダーに分けた環境音を持つ。
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

import { Music } from 'lucide-react';
import type { BgmAll, BgmFile } from '../../types';

/**
 * BGM の一覧と試聴。取得は親が行う。
 * @param props.bgmAll GET /api/bgm/all の結果（読み込み前は null）
 */
export function BgmTab({
  fetchSettings, localPlayingUrl, currentBgmFile, bgmAll, bgmFiles, playLocal, formatFileSize, serverUrl,
}: {
  fetchSettings: () => void;
  localPlayingUrl: string | null;
  currentBgmFile: string | null;
  bgmAll: BgmAll;
  bgmFiles: BgmFile[];
  playLocal: (url: string) => void;
  formatFileSize: (bytes: number) => string;
  serverUrl: string;
}) {
  const SectionTitle = ({ icon, title, path: p, desc }: { icon: string; title: string; path: string; desc?: string }) => (
    <div className="flex items-center gap-2 pt-2 pb-1 border-b border-glass/50">
      <span>{icon}</span>
      <span className="text-sm font-bold text-gray-200">{title}</span>
      <code className="text-xs text-gray-600 ml-1">{p}</code>
      {desc && <span className="text-xs text-gray-500">— {desc}</span>}
    </div>
  );
  const BgmTable = ({ files, currentFile, basePath = '' }: {
    files: BgmFile[];
    currentFile?: string;
    basePath?: string;
  }) => {
    if (files.length === 0) return (
      <p className="text-gray-600 text-xs py-2 pl-1">ファイルなし</p>
    );
    return (
      <table className="w-full text-sm border-collapse">
        <tbody>
          {files.map((f, idx) => {
            const onAir = f.filename === currentFile;
            const url = `${serverUrl}/api/bgm-preview/${basePath}${f.filename}`;
            const isPlaying = localPlayingUrl === url;
            return (
              <tr key={f.filename} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: onAir ? 'rgba(0,180,216,0.07)' : idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)' }} className={onAir ? 'text-neon-blue' : 'text-gray-300'}>
                <td className="pr-3 w-5 text-center" style={{ padding: '10px 12px 10px 0' }}>{onAir ? '▶' : ''}</td>
                <td className="pr-3 truncate max-w-0" style={{ padding: '10px 12px 10px 0', width: '60%' }}>{f.filename}</td>
                <td className="pr-3 text-xs text-gray-500 whitespace-nowrap" style={{ padding: '10px 12px 10px 0' }}>{formatFileSize(f.size)}</td>
                <td className="text-right whitespace-nowrap" style={{ padding: '10px 0' }}>
                  <button
                    onClick={() => playLocal(url)}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${isPlaying ? 'border-yellow-400/60 text-yellow-300' : 'border-glass text-gray-400 hover:text-white hover:border-gray-400'}`}
                  >
                    {isPlaying ? '■ 停止' : '▶ 試聴'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  const FOLDER_LABELS: Record<string, string> = {
    '_default': '🌐 デフォルト（都市未マッチ時）',
    'japan':       '🇯🇵 日本',
    'middleeast':  '🕌 中東',
    'paris':       '🥐 パリ・フランス',
    'london':      '🎡 ロンドン・イギリス',
    'europe':      '🏰 欧州',
    'newyork':     '🗽 ニューヨーク',
    'usa':         '🦅 北米',
    'latinamerica':'💃 中南米',
    'china':       '🏮 中国・香港',
    'korea':       '🎵 韓国',
    'asia':        '🌏 東南アジア',
    'africa':      '🌍 アフリカ',
    'oceania':     '🦘 オセアニア',
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <div className="flex items-center gap-2">
          <Music className="w-5 h-5 text-neon-blue" />
          <h2 className="text-lg font-bold text-neon-blue">BGM管理</h2>
        </div>
        <button onClick={fetchSettings} className="btn btn-dark text-xs px-3 py-1">↻ 更新</button>
      </div>

      <div className="flex flex-col gap-6">
        {/* ── 1. メイン BGM ── */}
        <div>
          <SectionTitle icon="🎵" title="メイン BGM（番組中シャッフル再生）" path="server/assets/bgm/" />
          <div className="flex items-center gap-2 py-2 text-xs text-gray-500">
            <Music className="w-3.5 h-3.5 text-neon-blue" />
            Now Playing: <span className="text-white font-bold">{currentBgmFile ?? '（未選択）'}</span>
          </div>
          <BgmTable
            files={bgmAll?.main.files ?? bgmFiles}
            currentFile={bgmAll?.main.current ?? currentBgmFile ?? undefined}
          />
        </div>

        {/* ── 2. オープニング ── */}
        <div>
          <SectionTitle icon="🎬" title="オープニングジングル" path="bgm/opening/" desc="番組開始時" />
          <BgmTable files={bgmAll?.opening ?? []} basePath="opening/" />
        </div>

        {/* ── 3. ワールドレポート ── */}
        <div>
          <SectionTitle icon="🌍" title="ワールドレポート" path="server/assets/bgm/world_report/" />
          <div className="mt-3 flex flex-col gap-4">
            {/* 3a. ジングル */}
            <div>
              <p className="text-xs text-gray-500 font-bold mb-1">📞 ジングル（コーナー開始時）</p>
              <BgmTable files={bgmAll?.world_report.jingles ?? []} basePath="world_report/" />
            </div>
            {/* 3b. アンビエント */}
            {Object.keys(bgmAll?.world_report.ambient ?? {}).length > 0 && (
              <div>
                <p className="text-xs text-gray-500 font-bold mb-2">🔊 アンビエントサウンド（レポート中BGM）</p>
                <div style={{ maxHeight: 360, overflowY: 'auto' }} className="rounded border border-white/5">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-black/80 backdrop-blur-sm z-10">
                    <tr className="text-xs text-gray-600" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                      <th className="pr-3 text-left font-normal w-40" style={{ padding: '8px 12px 8px 0' }}>フォルダ</th>
                      <th className="pr-3 text-left font-normal" style={{ padding: '8px 12px 8px 0' }}>ファイル</th>
                      <th className="pr-3 text-right font-normal" style={{ padding: '8px 12px 8px 0' }}>サイズ</th>
                      <th style={{ padding: '8px 0' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let rowIdx = 0;
                      return Object.entries(bgmAll!.world_report.ambient).map(([folder, files]) =>
                        files.length === 0 ? (() => {
                          const bg = rowIdx++ % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)';
                          return (
                            <tr key={folder} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: bg }}>
                              <td className="pr-3 text-xs text-gray-400" style={{ padding: '10px 12px 10px 0' }}>{FOLDER_LABELS[folder] ?? folder}</td>
                              <td className="text-gray-600 text-xs" colSpan={3} style={{ padding: '10px 0' }}>ファイルなし</td>
                            </tr>
                          );
                        })() : files.map((f, i) => {
                          const bg = rowIdx++ % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)';
                          const url = `${serverUrl}/api/bgm-preview/world_report/${folder}/${f.filename}`;
                          const isPlaying = localPlayingUrl === url;
                          return (
                            <tr key={`${folder}-${f.filename}`} className="text-gray-300" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: bg }}>
                              <td className="pr-3 text-xs text-gray-400 align-top" style={{ padding: '10px 12px 10px 0' }}>
                                {i === 0 ? (FOLDER_LABELS[folder] ?? folder) : ''}
                              </td>
                              <td className="pr-3 truncate max-w-0" style={{ padding: '10px 12px 10px 0', width: '55%' }}>{f.filename}</td>
                              <td className="pr-3 text-right text-xs text-gray-500 whitespace-nowrap" style={{ padding: '10px 12px 10px 0' }}>{formatFileSize(f.size)}</td>
                              <td className="text-right whitespace-nowrap" style={{ padding: '10px 0' }}>
                                <button
                                  onClick={() => playLocal(url)}
                                  className={`text-xs px-2 py-1 rounded border transition-colors ${isPlaying ? 'border-yellow-400/60 text-yellow-300' : 'border-glass text-gray-400 hover:text-white hover:border-gray-400'}`}
                                >
                                  {isPlaying ? '■ 停止' : '▶ 試聴'}
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      );
                    })()}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-gray-600">
          ※ ファイルの追加・削除は各フォルダに直接 MP3 を配置後「更新」を押してください。
        </p>
      </div>
    </div>
  );
}
