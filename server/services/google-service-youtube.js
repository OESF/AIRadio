/**
 * @file YouTube の登録チャンネルと、その新着動画の取得（GoogleService に取り込むメソッド群）
 *
 * 本人の認可（youtube.readonly）が要る「自分の登録チャンネル」を扱う。API キーだけで呼べる検索
 * （services/youtube-service.js）とは別物。認証は google-service.js の _getYoutubeAccessToken を this 経由で使う。
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

const youtubeMethods = {
  /**
   * 登録チャンネルの一覧を取得する。
   *
   * 1ページ50件で maxPages ページまで（既定 4 = 200件）。軽い API だが、たくさん登録していても
   * 新着の確認が長引かないよう上限を設けている。
   * @param {Record<string, any>} creds 認証情報
   * @param {{maxPages?: number}} [opts]
   * @returns {Promise<Array<{channelId: string, channelTitle: string}>>}
   */
  async fetchSubscriptions(creds, { maxPages = 4 } = {}) {
    const accessToken = await this._getYoutubeAccessToken(creds);
    const subscriptions = [];
    let pageToken = null;
    let page = 0;
    do {
      const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await fetch(`https://www.googleapis.com/youtube/v3/subscriptions?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`YouTube Subscriptions API HTTP ${res.status}`);
      const data = await res.json();
      subscriptions.push(...(data.items || []));
      pageToken = data.nextPageToken || null;
      page++;
    } while (pageToken && page < maxPages);
    return subscriptions
      .map((item) => ({
        channelId: item.snippet?.resourceId?.channelId,
        channelTitle: item.snippet?.title || '(チャンネル名不明)',
      }))
      .filter((s) => s.channelId);
  },

  /**
   * 登録チャンネルの、直近 hoursBack 時間以内に公開された動画を、新しい順に返す。
   *
   * 各チャンネルの「アップロード用の再生リスト」（channelId の先頭の UC を UU に変えたもの）を
   * playlistItems.list で読む。search.list（1回100ユニット）より大幅に安い（1回1ユニット）ので、
   * 登録が多くても現実的なコストで済む。一度に大量に呼ぶとレート制限にかかるので、10チャンネルずつ並列に呼ぶ。
   * 1チャンネルの取得に失敗しても（非公開・削除など）、全体は続ける。
   * @param {Record<string, any>} creds 認証情報
   * @param {{hoursBack?: number}} [opts] 既定 24時間
   * @returns {Promise<Array<{channelTitle: string, videoId: string, title: string, publishedAt: string, url: string}>>}
   */
  async fetchNewSubscriptionUploads(creds, { hoursBack = 24 } = {}) {
    const subs = await this.fetchSubscriptions(creds);
    const accessToken = await this._getYoutubeAccessToken(creds); // 直前に取ったものがキャッシュから返る
    const sinceMs = Date.now() - hoursBack * 60 * 60 * 1000;
    const CONCURRENCY = 10;
    const results = [];
    for (let i = 0; i < subs.length; i += CONCURRENCY) {
      const batch = subs.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (sub) => {
        const uploadsPlaylistId = sub.channelId.replace(/^UC/, 'UU');
        try {
          const params = new URLSearchParams({ part: 'snippet,contentDetails', playlistId: uploadsPlaylistId, maxResults: '5' });
          const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!res.ok) return [];
          const data = await res.json();
          return (data.items || [])
            .map((item) => {
              const videoId = item.contentDetails?.videoId;
              const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
              if (!videoId || !publishedAt) return null;
              return {
                channelTitle: sub.channelTitle,
                videoId,
                title: item.snippet?.title || '(タイトル不明)',
                publishedAt,
                url: `https://www.youtube.com/watch?v=${videoId}`,
              };
            })
            .filter((v) => v && new Date(v.publishedAt).getTime() >= sinceMs);
        } catch (e) {
          getLogger().warn(`[GoogleService] 登録チャンネル「${sub.channelTitle}」の新着取得に失敗: ${e.message}`);
          return [];
        }
      }));
      results.push(...batchResults.flat());
    }
    results.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    return results;
  },
};

module.exports = { youtubeMethods };
