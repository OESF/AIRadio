/**
 * @file リスナーのプロフィール（config.show.user_profile）の整形と、天気・交通を取る場所の決定
 *
 * 依存の無い小さな関数だけを集めたモジュール。
 *
 * ATTENTION: ここに他のモジュールへの依存を足さないこと。secretary-prompt.js・secretary-tools.js・
 *            secretary-tools-reports.js の3つから使われており、依存を足すと循環 require になる
 *            （そのために元の場所から切り出した）。
 *
 * 主な利用元: lib/secretary-prompt.js・lib/secretary-tools.js・lib/secretary-tools-reports.js
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
'use strict';

/**
 * 今日の日付を「MM-DD」で返す（特別な日との照合に使う）。
 * @returns {string}
 */
function todayMMDD() {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 今日が期間に含まれるか。期間は年をまたいでもよい（例: 12-31〜01-01）。
 * @param {string} start 「MM-DD」
 * @param {string} end 「MM-DD」
 * @returns {boolean}
 */
function isTodayWithinRange(start, end) {
  const today = todayMMDD();
  if (start <= end) return today >= start && today <= end;
  return today >= start || today <= end; // 年をまたぐ期間
}

/**
 * プロフィールを、プロンプト用の段落に整形する。
 *
 * 項目を選ばず全部渡す（誕生日・居住地・職業・趣味・音楽の好み・特別な日など）。特別な日のうち
 * 今日が期間に入るものには【本日該当】を付ける。
 * @param {Record<string, any>} profile config.show.user_profile
 * @returns {string} 項目が無ければ空文字
 */
function formatListenerProfile(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';
  const lines = [
    profile.birthday        ? `生年月日: ${profile.birthday}` : '',
    profile.location        ? `居住地: ${profile.location}` : '',
    profile.nearest_station ? `最寄り駅: ${profile.nearest_station}` : '',
    profile.occupation      ? `職業: ${profile.occupation}` : '',
    profile.hobbies         ? `趣味: ${profile.hobbies}` : '',
    profile.interests       ? `興味のあること:\n${profile.interests}` : '',
    (profile.music_genres?.length)     ? `好きな音楽ジャンル: ${profile.music_genres.join('、')}` : '',
    (profile.favorite_artists?.length) ? `好きなアーティスト: ${profile.favorite_artists.join('、')}` : '',
    profile.music_notes     ? `音楽の好みの補足: ${profile.music_notes}` : '',
  ].filter(Boolean);

  const specialDates = profile.special_dates || [];
  if (specialDates.length > 0) {
    lines.push('特別な日（家族の誕生日・記念日など）:');
    for (const d of specialDates) {
      const todayMark = isTodayWithinRange(d.start, d.end) ? '【本日該当】' : '';
      lines.push(`  - ${d.start}〜${d.end} ${d.label}${todayMark}`);
    }
  }

  // BUGFIX: 呼び名（short_name）があれば、見出しにもフルネームを出さない。フルネームの発音が
  //         安定しないため話させない方針で、見出しに出すとモデルが拾って話してしまう
  //         （secretary-live-routes.js の _buildSecretaryConnectionContext と合わせる）
  const displayName = profile.short_name || profile.name || 'リスナー';
  return lines.length > 0
    ? `\n\n【リスナー（${displayName}さん）のプロフィール】\n${lines.join('\n')}`
    : '';
}

/**
 * 今、天気・交通を取りに行くべき場所を返す。臨時滞在（config.show.temp_stay）の期間中は滞在先、
 * それ以外は居住地（未設定なら東京）。
 *
 * BUGFIX: 秘書側（デイリーノートなど）もこれを使うこと。放送側（agent-system.js の
 *         _getEffectiveLocation）と別の決め方をすると、旅行中に放送とノートで違う土地の天気が出る。
 * @param {Record<string, any>} config config.json の内容
 * @returns {{location: string, isTempStay: boolean, tempStay: object|null}}
 */
function getEffectiveLocationFromConfig(config) {
  const profile = config.show?.user_profile || {};
  const ts = config.show?.temp_stay;
  if (ts?.location && ts?.start && ts?.end) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (today >= ts.start && today <= ts.end) {
      return { location: ts.location, isTempStay: true, tempStay: ts };
    }
  }
  return { location: profile.location || '東京', isTempStay: false, tempStay: null };
}

module.exports = { todayMMDD, isTodayWithinRange, formatListenerProfile, getEffectiveLocationFromConfig };
