/**
 * @file 管理画面の「BGM管理」タブ（チャンネル共通。BGM の一覧と試聴）
 *
 * server/assets/channels/<チャンネル>/bgm/ の下の opening・main・ending のファイルを一覧し、試聴できるようにする。
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
import type { ChannelAccent } from '../types';
import { CHANNEL_ACCENT } from '../constants';

/**
 * BGM の一覧を、オープニング・2つ目・（あれば）3つ目の区分ごとに表で表示する。
 * @param props.channelSlug チャンネル名（API の URL と、フォルダーの表示に使う）
 * @param props.bgmAll GET /api/<ch>/bgm/all の結果。読み込み前は null
 * @param props.extraMainNote 2つ目の区分の見出しに添える補足
 */
export function ChannelBgmTab({
  channelLabel, accent, channelSlug, bgmAll, onRefresh,
  localPlayingUrl, playLocal, formatFileSize, serverUrl, extraMainNote,
  secondBucket = { key: 'main', label: 'トーク用BGM（番組中シャッフル再生）', icon: '🎵' },
  thirdBucket,
}: {
  channelLabel: string;
  accent: ChannelAccent;
  channelSlug: string;
  bgmAll: { opening: { filename: string; size: number }[]; main: { filename: string; size: number }[]; ending?: { filename: string; size: number }[] } | null;
  onRefresh: () => void;
  localPlayingUrl: string | null;
  playLocal: (url: string) => void;
  formatFileSize: (bytes: number) => string;
  serverUrl: string;
  extraMainNote?: string;
  // 2つ目の区分。既定はトーク用の BGM（main）。The Answers はエンディングのジングル（ending）を持つので差し替える
  secondBucket?: { key: 'main' | 'ending'; label: string; icon: string };
  // 3つ目の区分（opening・main・ending の3種類を持つ The Answers 用）
  thirdBucket?: { key: 'main' | 'ending'; label: string; icon: string };
}) {
  const col = CHANNEL_ACCENT[accent];
  const BgmTable = ({ files, basePath = '' }: { files: { filename: string; size: number }[]; basePath?: string }) => {
    if (files.length === 0) return <p className="text-gray-600 text-xs py-2 pl-1">ファイルなし</p>;
    return (
      <table className="w-full text-sm border-collapse">
        <tbody>
          {files.map((f, idx) => {
            const url = `${serverUrl}/api/${channelSlug}/bgm-preview/${basePath}${f.filename}`;
            const isPlaying = localPlayingUrl === url;
            return (
              <tr key={f.filename} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)' }} className="text-gray-300">
                <td className="pr-3 truncate max-w-0" style={{ padding: '10px 12px 10px 0', width: '60%' }}>{f.filename}</td>
                <td className="pr-3 text-xs text-gray-500 whitespace-nowrap" style={{ padding: '10px 12px 10px 0' }}>{formatFileSize(f.size)}</td>
                <td className="text-right whitespace-nowrap" style={{ padding: '10px 0' }}>
                  <button
                    onClick={() => playLocal(url)}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${isPlaying ? col.playingBorderClass : 'border-glass text-gray-400 hover:text-white hover:border-gray-400'}`}
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
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <div className="flex items-center gap-2">
          <Music className="w-5 h-5" style={{ color: col.musicIcon }} />
          <h2 className="text-lg font-bold" style={{ color: col.heading }}>BGM管理（{channelLabel}）</h2>
        </div>
        <button onClick={onRefresh} className="btn btn-dark text-xs px-3 py-1">↻ 更新</button>
      </div>
      <div className="flex flex-col gap-6">
        <div>
          <div className="flex items-center gap-2 pt-2 pb-1 border-b border-glass/50">
            <span>🎬</span>
            <span className="text-sm font-bold text-gray-200">オープニングジングル</span>
            <code className="text-xs text-gray-600 ml-1">server/assets/channels/{channelSlug}/bgm/opening/</code>
          </div>
          <BgmTable files={bgmAll?.opening ?? []} basePath="opening/" />
        </div>
        <div>
          <div className="flex items-center gap-2 pt-2 pb-1 border-b border-glass/50">
            <span>{secondBucket.icon}</span>
            <span className="text-sm font-bold text-gray-200">{secondBucket.label}</span>
            <code className="text-xs text-gray-600 ml-1">server/assets/channels/{channelSlug}/bgm/{secondBucket.key}/</code>
            {extraMainNote && <span className="text-xs text-gray-500">— {extraMainNote}</span>}
          </div>
          <BgmTable files={(secondBucket.key === 'ending' ? bgmAll?.ending : bgmAll?.main) ?? []} basePath={`${secondBucket.key}/`} />
        </div>
        {thirdBucket && (
          <div>
            <div className="flex items-center gap-2 pt-2 pb-1 border-b border-glass/50">
              <span>{thirdBucket.icon}</span>
              <span className="text-sm font-bold text-gray-200">{thirdBucket.label}</span>
              <code className="text-xs text-gray-600 ml-1">server/assets/channels/{channelSlug}/bgm/{thirdBucket.key}/</code>
            </div>
            <BgmTable files={(thirdBucket.key === 'ending' ? bgmAll?.ending : bgmAll?.main) ?? []} basePath={`${thirdBucket.key}/`} />
          </div>
        )}
      </div>
    </div>
  );
}
