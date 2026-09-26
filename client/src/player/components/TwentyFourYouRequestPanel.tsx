/**
 * @file プレイヤーの 24/You の操作欄（選曲モードの切り替えと、再生履歴）
 *
 * 24/You にはリクエストの機能が無いので、代わりに選曲モード（おまかせ・あの頃・歌手・新譜・わがまま）と
 * 洋楽・邦楽の指定を切り替える。状態と送信は親が持つ。
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

import { Send } from 'lucide-react';
import type { TwentyFourYouMode, TwentyFourYouLanguagePref, TwentyFourYouTrack } from '../types';

/**
 * 選曲モードの切り替えと再生履歴。
 * @param props.mode 今の選曲モード
 * @param props.anokoroAge 「あの頃」の年齢（空なら誕生日から自動）
 * @param props.artists 「歌手」モードで登録したアーティスト
 * @param props.profileArtists リスナーのプロファイルの好きなアーティスト（登録の候補）
 * @param props.wagamamaRequest 「わがまま」モードの要望
 * @param props.languagePref 洋楽・邦楽の指定
 * @param props.playedList 再生履歴
 */
export function TwentyFourYouRequestPanel({
  mode, anokoroAge, artists, artistInput, wagamamaRequest, languagePref,
  profileArtists, playedList,
  onModeChange, onAnokoroAgeChange, onAnokoroAgeBlur,
  onArtistInputChange, onAddArtist, onRemoveArtist, onAddArtistFromProfile,
  onWagamamaChange, onWagamamaSend, onLanguagePrefChange,
}: {
  mode: TwentyFourYouMode;
  anokoroAge: string;
  artists: string[];
  artistInput: string;
  wagamamaRequest: string;
  languagePref: TwentyFourYouLanguagePref;
  profileArtists: string[];
  playedList: TwentyFourYouTrack[];
  onModeChange: (mode: TwentyFourYouMode) => void;
  onAnokoroAgeChange: (v: string) => void;
  onAnokoroAgeBlur: () => void;
  onArtistInputChange: (v: string) => void;
  onAddArtist: () => void;
  onRemoveArtist: (artist: string) => void;
  onAddArtistFromProfile: (artist: string) => void;
  onWagamamaChange: (v: string) => void;
  onWagamamaSend: () => void;
  onLanguagePrefChange: (pref: TwentyFourYouLanguagePref) => void;
}) {
  const remainingProfileArtists = profileArtists.filter(a => !artists.includes(a));
  return (
    <>
      <fieldset className="glass-fieldset">
        <legend>
          <span className="text-xl">🔀</span>
          <span className="text-base font-normal text-gray-300">選曲モード</span>
        </legend>
        <div className="mt-3 space-y-3">
          <div className="flex gap-1.5 flex-wrap">
            {([
              { key: 'omakase',  label: 'おまかせ' },
              { key: 'anokoro',  label: 'あの頃' },
              { key: 'artist',   label: '歌手' },
              { key: 'shinpu',   label: '新譜' },
              { key: 'wagamama', label: 'わがまま' },
            ] as const).map(({ key, label }) => (
              <button key={key}
                onClick={() => onModeChange(key)}
                className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                  ${mode === key
                    ? 'border-teal-500/70 text-teal-200'
                    : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}
                style={mode === key ? { background: 'rgba(13,148,136,0.3)' } : {}}>
                {label}
              </button>
            ))}
          </div>
          {mode === 'anokoro' && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="number"
                placeholder="20（自動）"
                value={anokoroAge}
                onChange={e => onAnokoroAgeChange(e.target.value)}
                onBlur={onAnokoroAgeBlur}
                className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-gray-200 outline-none"
              />
              <span className="text-gray-500">歳の頃（誕生日から算出した年 ± 1年で選曲）</span>
            </div>
          )}
          {mode === 'artist' && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-1.5 flex-wrap">
                {artists.length === 0 && (
                  <p className="text-xs text-gray-500">好きなアーティストを登録してください</p>
                )}
                {artists.map((artist, idx) => (
                  <span key={idx}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-teal-600/20 border border-teal-500/40 text-teal-200">
                    {artist}
                    <button type="button" onClick={() => onRemoveArtist(artist)}
                      className="ml-0.5 text-teal-400 hover:text-red-400 transition-colors leading-none" title="削除">×</button>
                  </span>
                ))}
              </div>
              {remainingProfileArtists.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1.5">候補（リスナープロファイルの好きなアーティストから選択）</p>
                  <div className="flex gap-1.5 flex-wrap overflow-y-auto" style={{ maxHeight: '96px' }}>
                    {remainingProfileArtists.map((artist, idx) => (
                      <button key={idx} type="button"
                        onClick={() => onAddArtistFromProfile(artist)}
                        className="px-2 py-0.5 rounded-full text-xs border border-white/15 bg-white/5 text-gray-400
                          hover:border-teal-500/50 hover:text-teal-200 transition-all active:scale-95">
                        + {artist}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="アーティスト名を入力（例: 山下達郎）"
                  value={artistInput}
                  onChange={e => onArtistInputChange(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onAddArtist()}
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl
                    outline-none text-sm text-gray-200 placeholder-gray-500
                    px-3 py-2 focus:ring-0 transition-colors"
                  style={{ boxShadow: 'none' }}
                />
                <button
                  type="button"
                  onClick={onAddArtist}
                  disabled={!artistInput.trim()}
                  className="p-2.5 rounded-xl bg-teal-600/30 border border-teal-500/40
                    text-teal-400 hover:bg-teal-600/50 transition-all
                    disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
                  title="追加"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
          {mode === 'wagamama' && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="例: 雨の日に聴きたい、友達と盛り上がりたい、クリスマス、寂しい時に聴きたい、夏にぴったりの曲"
                value={wagamamaRequest}
                onChange={e => onWagamamaChange(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && onWagamamaSend()}
                onBlur={onWagamamaSend}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl
                  outline-none text-sm text-gray-200 placeholder-gray-500
                  px-3 py-2 focus:ring-0 transition-colors"
                style={{ boxShadow: 'none' }}
              />
              <button
                type="button"
                onClick={onWagamamaSend}
                disabled={!wagamamaRequest.trim()}
                className="p-2.5 rounded-xl bg-teal-600/30 border border-teal-500/40
                  text-teal-400 hover:bg-teal-600/50 transition-all
                  disabled:opacity-30 disabled:cursor-not-allowed active:scale-90"
                title="送信"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          )}
          {mode !== 'artist' && (
            <div>
              <p className="text-xs text-gray-500 mb-1.5">洋楽・邦楽</p>
              <div className="flex gap-1.5 flex-wrap">
                {([
                  { key: 'any',      label: '指定せず' },
                  { key: 'japanese', label: '邦楽' },
                  { key: 'western',  label: '洋楽' },
                ] as const).map(({ key, label }) => (
                  <button key={key}
                    onClick={() => onLanguagePrefChange(key)}
                    className={`px-3 py-1 rounded-full text-xs border transition-all active:scale-95
                      ${languagePref === key
                        ? 'border-teal-500/70 text-teal-200'
                        : 'bg-white/5 border-white/15 text-gray-400 hover:border-white/30'}`}
                    style={languagePref === key ? { background: 'rgba(13,148,136,0.3)' } : {}}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </fieldset>

      {/* 再生履歴（常に表示・読むだけで、アンコールは無い） */}
      <fieldset className="glass-fieldset">
        <legend>
          <span className="text-xl">📜</span>
          <span className="text-base font-normal text-gray-300">再生履歴</span>
        </legend>
        <div className="mt-3 space-y-2 overflow-y-auto" style={{ maxHeight: '280px' }}>
          {playedList.length === 0 && (
            <p className="text-xs text-gray-500">まだ再生履歴がありません</p>
          )}
          {playedList.map((track, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2" style={{ padding: '8px 12px' }}>
              {track.albumImage && (
                <img src={track.albumImage} alt="" className="w-9 h-9 rounded-md flex-shrink-0 object-cover" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200 truncate font-medium">{track.title}</div>
                <div className="text-xs text-gray-500 truncate">{track.artist}{track.albumName ? `　${track.albumName}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      </fieldset>
    </>
  );
}
