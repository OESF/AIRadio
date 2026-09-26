/**
 * @file 秘書用の Google 連携（カレンダー・Gmail・ToDo・ドライブ・スプレッドシート・スライド・YouTube）
 *
 * 認証（OAuth の refresh_token からアクセストークンを得る処理とそのキャッシュ）だけをここで持ち、
 * 各サービスのメソッドはドメインごとのファイル（google-service-*.js）から取り込む。
 *
 * Live の Google 連携（agent-system.js の _refreshGoogleData。一度紹介した未読メールを次は飛ばす、
 * 5分ごとのキャッシュなど放送向けの工夫がある）とは、あえて別にしている。秘書は頼まれるたびに
 * 正確な最新の状態を答える必要があり、要件が違うため。
 *
 * 主な利用元: lib/secretary-tools-services.js（共有のインスタンスを作る）
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

const { getLogger } = require('../logger');

const { calendarMethods } = require('./google-service-calendar');
const { gmailMethods } = require('./google-service-gmail');
const { sheetsMethods } = require('./google-service-sheets');
const { tasksMethods } = require('./google-service-tasks');
const { driveMethods } = require('./google-service-drive');
const { slidesMethods } = require('./google-service-slides');
const { youtubeMethods } = require('./google-service-youtube');

/**
 * 秘書用の Google 連携。アクセストークンは有効期限の少し前まで、プロセスの中で使い回す。
 */
class GoogleService {
  constructor() {
    // YouTube は別の認可で得た別の refresh_token（creds.google.youtube_refresh_token）を使うので、
    // アクセストークンのキャッシュも分ける（oauth-routes.js の YOUTUBE_SCOPES を参照）
    this._tokenCache = {
      default: { accessToken: null, expiresAt: 0 },
      youtube: { accessToken: null, expiresAt: 0 },
    };
  }

  /**
   * refresh_token からアクセストークンを得る（キャッシュが有効ならそれを返す）。
   * @param {Record<string, any>} creds 認証情報（credentials.json の内容）
   * @param {{refreshTokenField: string, cacheKey: 'default'|'youtube', missingCredsError: string, failureError: string}} opts
   *   refreshTokenField は creds.google の中の refresh_token の項目名、cacheKey はキャッシュの区分、
   *   missingCredsError・failureError は認証情報が無い・取得に失敗したときのエラー文
   * @returns アクセストークン
   * @throws {Error} 認証情報が無い、または取得に失敗したとき
   */
  async _refreshOAuthToken(creds, { refreshTokenField, cacheKey, missingCredsError, failureError }) {
    const cache = this._tokenCache[cacheKey];
    if (cache.accessToken && Date.now() < cache.expiresAt) return cache.accessToken;
    const refreshToken = creds?.google?.[refreshTokenField];
    if (!refreshToken || !creds?.google?.client_id) {
      throw new Error(missingCredsError);
    }
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.google.client_id,
        client_secret: creds.google.client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokens = await tokenResponse.json();
    if (!tokens.access_token) throw new Error(failureError);
    cache.accessToken = tokens.access_token;
    // 有効期限（普通は3600秒）の2分前に切れたことにする
    cache.expiresAt = Date.now() + Math.max((tokens.expires_in || 3000) - 120, 60) * 1000;
    return cache.accessToken;
  }

  /**
   * カレンダー・Gmail・ToDo・ドライブ・スプレッドシート・スライド用のアクセストークン。
   * @param {Record<string, any>} creds
   * @returns アクセストークン
   */
  async _getAccessToken(creds) {
    return this._refreshOAuthToken(creds, {
      refreshTokenField: 'refresh_token',
      cacheKey: 'default',
      missingCredsError: 'Google認証情報が設定されていません（管理画面のシステム接続設定を確認してください）',
      failureError: 'Googleアクセストークンの取得に失敗しました',
    });
  }

  /**
   * YouTube 用のアクセストークン。/callback/youtube で保存した、カレンダーなどとは別の
   * refresh_token（creds.google.youtube_refresh_token）を使う。
   * @param {Record<string, any>} creds
   * @returns アクセストークン
   */
  async _getYoutubeAccessToken(creds) {
    return this._refreshOAuthToken(creds, {
      refreshTokenField: 'youtube_refresh_token',
      cacheKey: 'youtube',
      missingCredsError: 'YouTube連携が未認証です（管理画面のシステム接続設定で「YouTubeでサインイン」を行ってください）',
      failureError: 'YouTubeアクセストークンの取得に失敗しました',
    });
  }
}

// ドメインごとのファイルのメソッドを、このクラスに取り込む。
// ATTENTION: 上のクラス本体には認証まわりしか置かないこと。同じ名前のメソッドをクラス本体に書くと、
//            ここで取り込むメソッドに上書きされる（クラス本体 → Object.assign の順に評価されるため）
Object.assign(
  GoogleService.prototype,
  calendarMethods,
  gmailMethods,
  sheetsMethods,
  tasksMethods,
  driveMethods,
  slidesMethods,
  youtubeMethods,
);

module.exports = GoogleService;
