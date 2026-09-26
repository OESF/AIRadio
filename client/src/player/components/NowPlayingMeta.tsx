/**
 * @file プレーヤー画面の「再生中の曲」の補足情報（チャンネルごとに項目が違う）
 *
 * Classic は作品と演奏者、Jazz・Mood・Beatles・24/You は曲の情報、Live は Spotify の音の特徴
 * （ジャンル・雰囲気・テンポなど）を表示する。
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

import type { ChannelId } from '../constants';
import type { ClassicTrack, JazzTrack, MoodTrack, BeatlesTrack, TwentyFourYouTrack } from '../types';

/** Live で再生中の曲の、Spotify の音の特徴。 */
type LiveNowPlaying = { genres?: string; mood?: string; tempo?: number; energy?: string; keyMode?: string } | null;

/**
 * 選んでいるチャンネルの、再生中の曲の補足情報を表示する（該当するチャンネルの項目だけが出る）。
 * @param props.selectedChannel 選んでいるチャンネル
 */
export function NowPlayingMeta({
  selectedChannel, classicTrack, jazzTrack, moodTrack, beatlesTrack, twentyFourYouTrack, nowPlaying,
}: {
  selectedChannel: ChannelId | null;
  classicTrack?: ClassicTrack;
  jazzTrack?: JazzTrack;
  moodTrack?: MoodTrack;
  beatlesTrack?: BeatlesTrack;
  twentyFourYouTrack?: TwentyFourYouTrack;
  nowPlaying: LiveNowPlaying;
}) {
  return (
    <>
      {/* Classic チャンネル: 作品・演奏者メタ情報 */}
      {selectedChannel === 'classic' && classicTrack && (() => {
        const ct = classicTrack;
        const performersLine = ct.performers && ct.performers.length > 0 ? ct.performers.join(' / ') : null;
        return (
          <div className="mt-3 pt-3 border-t border-white/8 flex flex-col gap-1.5">
            <p className="text-sm font-semibold text-indigo-200/90 truncate">
              <span style={{ filter: 'brightness(0) invert(1)', opacity: 0.75, display: 'inline-block' }}>🎼</span>
              {' '}{ct.composition}
              {ct.period && <span className="text-xs text-gray-500 ml-1.5">（{ct.period}）</span>}
            </p>
            {ct.composer && (
              <p className="text-xs text-gray-400 truncate">作曲：{ct.composer}</p>
            )}
            {ct.conductor && (
              <p className="text-xs text-gray-400 truncate">🎩 指揮：{ct.conductor}</p>
            )}
            {ct.ensemble && (
              <p className="text-xs text-gray-400 truncate">🎻 {ct.ensemble}</p>
            )}
            {performersLine && (
              <p className="text-xs text-gray-400 truncate">🎶 {performersLine}</p>
            )}
          </div>
        );
      })()}
      {/* Jazz チャンネル: 楽曲メタ情報 */}
      {selectedChannel === 'jazz' && jazzTrack && (() => {
        const jt = jazzTrack;
        const performersLine = jt.performers && jt.performers.length > 0 ? jt.performers.join(' / ') : null;
        if (!jt.period && !performersLine) return null;
        return (
          <div className="mt-3 pt-3 border-t border-white/8 flex flex-col gap-1.5">
            {jt.period && (
              <p className="text-xs text-gray-400 truncate">🎷 {jt.period}</p>
            )}
            {performersLine && (
              <p className="text-xs text-gray-400 truncate">🎸 {performersLine}</p>
            )}
          </div>
        );
      })()}
      {/* Mood チャンネル: 楽曲メタ情報 */}
      {selectedChannel === 'mood' && moodTrack && (() => {
        const mt = moodTrack;
        const performersLine = mt.performers && mt.performers.length > 0 ? mt.performers.join(' / ') : null;
        if (!mt.category && !mt.film_title && !mt.composer && !performersLine) return null;
        return (
          <div className="mt-3 pt-3 border-t border-white/8 flex flex-col gap-1.5">
            {mt.category && (
              <p className="text-xs text-gray-400 truncate">🌙 {mt.category}</p>
            )}
            {mt.film_title && (
              <p className="text-xs text-gray-400 truncate">🎬 映画: {mt.film_title}</p>
            )}
            {mt.composer && mt.composer !== mt.artist && (
              <p className="text-xs text-gray-400 truncate">🖊 作曲: {mt.composer}</p>
            )}
            {performersLine && (
              <p className="text-xs text-gray-400 truncate">🎻 {performersLine}</p>
            )}
          </div>
        );
      })()}
      {/* Beatles チャンネル: 楽曲メタ情報 */}
      {selectedChannel === 'beatles' && beatlesTrack && (() => {
        const bt = beatlesTrack;
        const performersLine = bt.performers && bt.performers.length > 0 ? bt.performers.join(' / ') : null;
        if (!bt.album && !bt.year && !performersLine) return null;
        return (
          <div className="mt-3 pt-3 border-t border-white/8 flex flex-col gap-1.5">
            {bt.album && (
              <p className="text-xs text-gray-400 truncate">🪲 {bt.album}{bt.year ? `（${bt.year}）` : ''}</p>
            )}
            {performersLine && (
              <p className="text-xs text-gray-400 truncate">🎸 {performersLine}</p>
            )}
          </div>
        );
      })()}
      {/* 24/You チャンネル: 楽曲メタ情報 */}
      {selectedChannel === '24you' && twentyFourYouTrack && (() => {
        const yt = twentyFourYouTrack;
        if (!yt.albumName && !yt.releaseYear) return null;
        return (
          <div className="mt-3 pt-3 border-t border-white/8 flex flex-col gap-1.5">
            {yt.albumName && (
              <p className="text-xs text-gray-400 truncate">🔀 {yt.albumName}{yt.releaseYear ? `（${yt.releaseYear}）` : ''}</p>
            )}
          </div>
        );
      })()}
      {/* Live チャンネル: Spotify オーディオ情報 */}
      {selectedChannel === 'live' && (nowPlaying?.genres || nowPlaying?.mood || nowPlaying?.tempo || nowPlaying?.energy || nowPlaying?.keyMode) && (
        <div className="mt-3 pt-3 border-t border-white/8 flex flex-col gap-1.5">
          {nowPlaying.genres && (
            <p className="text-xs text-gray-400 truncate">🎵 {nowPlaying.genres}</p>
          )}
          {nowPlaying.mood && (
            <p className="text-xs text-gray-400 truncate">💫 {nowPlaying.mood}</p>
          )}
          {nowPlaying.energy && (
            <p className="text-xs text-gray-400 truncate">⚡ {nowPlaying.energy}</p>
          )}
          {nowPlaying.tempo && (
            <p className="text-xs text-gray-400 truncate">🥁 {nowPlaying.tempo} BPM</p>
          )}
          {nowPlaying.keyMode && (
            <p className="text-xs text-gray-400 truncate">🎼 {nowPlaying.keyMode}</p>
          )}
        </div>
      )}
    </>
  );
}
