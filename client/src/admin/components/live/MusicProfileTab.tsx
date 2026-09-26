/**
 * @file 管理画面の Live「音楽プロファイル」タブ（DJ の選曲に使う好み）
 *
 * 好きなジャンル・アーティスト・音楽のメモを、リスナーのプロフィール（config.show.user_profile）に保存する。
 * 青春時代の年代は、生年月日から自動で計算される。
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

import type { FullConfig } from '../../types';

/**
 * ジャンル（カンマ・読点区切り）、アーティスト（1人ずつ追加・削除）、自由記述のメモを編集する。
 * 保存は親のフォームが行う。
 *
 * ATTENTION: 画面に出す担当の名前は、必ず設定（config.agents）から引くこと。管理画面で変えられる。
 * @param props.musicGenresText ジャンルの入力欄の文字列（入力中の IME を邪魔しないよう、配列とは別に持つ）
 * @param props.newArtistInput アーティストの追加の入力欄
 */
export function MusicProfileTab({
  config, setConfig, musicGenresText, setMusicGenresText, newArtistInput, setNewArtistInput,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  musicGenresText: string;
  setMusicGenresText: (v: string) => void;
  newArtistInput: string;
  setNewArtistInput: (v: string) => void;
}) {
  const djName = config.agents?.music_dj?.name || '音楽DJ';
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-xl">🎵</span>
        <h2 className="text-lg font-bold text-white">音楽プロファイル</h2>
        <span className="text-xs text-gray-500">{djName}の選曲に使用</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        {djName}はこの情報をもとに選曲します。生年月日から青春時代の年代は自動計算されます。
        複数ある場合は読点（、）または半角カンマ（,）区切りで入力してください。
      </p>
      <div className="flex flex-col gap-4">
        <div>
          <label>好きな音楽ジャンル</label>
          <input type="text"
            placeholder="例: 昭和歌謡、フォーク、ニューミュージック、ジャズ"
            value={musicGenresText}
            onChange={e => {
              const raw = e.target.value;
              setMusicGenresText(raw); // 入力欄の文字列を先に更新する（IME の変換を邪魔しないため）
              const arr = raw.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
              setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, music_genres: arr } } });
            }}
          />
        </div>
        <div>
          <label>好きなアーティスト・歌手名</label>
          <p className="text-xs text-gray-500 mb-2">
            アーティスト名を入力して Enter または「追加」で登録。× で個別削除できます。
          </p>
          {/* タグ一覧（ラップ表示） */}
          <div className="flex flex-wrap gap-1.5 mb-2 bp-3 bg-black/30 border border-glass rounded min-h-[40px]">
            {(config.show.user_profile.favorite_artists ?? []).map((artist, idx) => (
              <span
                key={idx}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-neon-purple/20 border border-neon-purple/40 text-purple-200"
              >
                {artist}
                <button
                  type="button"
                  onClick={() => {
                    const arr = (config.show.user_profile.favorite_artists ?? []).filter((_, i) => i !== idx);
                    setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, favorite_artists: arr } } });
                  }}
                  className="ml-0.5 text-purple-400 hover:text-red-400 transition-colors leading-none"
                  title="削除"
                >×</button>
              </span>
            ))}
            {(config.show.user_profile.favorite_artists ?? []).length === 0 && (
              <span className="text-xs text-gray-600 self-center">まだ登録されていません</span>
            )}
          </div>
          {/* 新規追加入力 */}
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="アーティスト名を入力（例: 山下達郎）"
              value={newArtistInput}
              onChange={e => setNewArtistInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === '、' || e.key === ',') {
                  e.preventDefault();
                  const names = newArtistInput.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
                  if (names.length === 0) return;
                  const arr = [...(config.show.user_profile.favorite_artists ?? []), ...names];
                  setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, favorite_artists: arr } } });
                  setNewArtistInput('');
                }
              }}
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => {
                const names = newArtistInput.split(/[,、，]/).map(s => s.trim()).filter(Boolean);
                if (names.length === 0) return;
                const arr = [...(config.show.user_profile.favorite_artists ?? []), ...names];
                setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, favorite_artists: arr } } });
                setNewArtistInput('');
              }}
              className="btn border border-neon-purple text-neon-purple hover:bg-neon-purple/20 px-3 py-1.5 text-sm whitespace-nowrap"
            >追加</button>
          </div>
        </div>
        <div>
          <label>その他の音楽メモ（自由記述）</label>
          <textarea rows={2}
            placeholder="例: 楽器演奏が好きなのでインスト曲も歓迎。朝は明るめの曲が好きです。"
            value={config.show.user_profile.music_notes ?? ''}
            onChange={e => setConfig({ ...config, show: { ...config.show, user_profile: { ...config.show.user_profile, music_notes: e.target.value } } })}
          />
        </div>
      </div>
    </div>
  );
}
