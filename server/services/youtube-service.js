/**
 * @file YouTube の動画検索（秘書の search_youtube ツール用）
 *
 * YouTube Data API v3 のキーワード検索。公開の API なので OAuth ではなく API キーだけで呼ぶ
 * （天気などの「キー1つだけ」の外部連携と同じ形）。
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

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/** YouTube の動画検索。 */
class YouTubeService {
  /**
   * キーワードで動画を検索する（日本・日本語向け、セーフサーチは中程度）。
   *
   * search.list は再生数を返さないので、search.list で動画を探したあと videos.list で再生数を取る。
   * @param {{ apiKey: string, query: string, maxResults?: number, order?: 'relevance'|'viewCount'|'date'|'rating', publishedAfter?: string|null }} args
   *   maxResults は 1〜20（既定 8）、publishedAfter は ISO 形式の日時（これより後に公開されたもの）
   * @returns {Promise<Array<{videoId: string, title: string, channelTitle: string, publishedAt: string|null, viewCount: number|null, url: string}>>}
   */
  async searchVideos({ apiKey, query, maxResults = 8, order = 'relevance', publishedAfter = null }) {
    if (!apiKey) throw new Error('YouTube APIキーが設定されていません。管理画面から設定してください。');
    if (!query || !query.trim()) throw new Error('検索キーワードが指定されていません。');

    const clampedMax = Math.min(Math.max(Number(maxResults) || 8, 1), 20);
    const searchParams = new URLSearchParams({
      key: apiKey,
      q: query.trim(),
      part: 'snippet',
      type: 'video',
      maxResults: String(clampedMax),
      order,
      regionCode: 'JP',
      relevanceLanguage: 'ja',
      safeSearch: 'moderate',
    });
    if (publishedAfter) searchParams.set('publishedAfter', publishedAfter);

    const searchRes = await fetch(`${YOUTUBE_API_BASE}/search?${searchParams}`);
    if (!searchRes.ok) {
      const body = await searchRes.text().catch(() => '');
      throw new Error(`YouTube検索に失敗しました (HTTP ${searchRes.status}): ${body.slice(0, 200)}`);
    }
    const searchData = await searchRes.json();
    const videoIds = (searchData.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
    if (videoIds.length === 0) return [];

    // 並び順は search.list の結果（order を指定済み）を正とし、ここでは並べ替えない
    const videosParams = new URLSearchParams({
      key: apiKey,
      id: videoIds.join(','),
      part: 'snippet,statistics',
    });
    const videosRes = await fetch(`${YOUTUBE_API_BASE}/videos?${videosParams}`);
    if (!videosRes.ok) {
      const body = await videosRes.text().catch(() => '');
      throw new Error(`YouTube動画詳細の取得に失敗しました (HTTP ${videosRes.status}): ${body.slice(0, 200)}`);
    }
    const videosData = await videosRes.json();
    const byId = new Map((videosData.items || []).map((v) => [v.id, v]));

    const results = videoIds.map((id) => {
      const v = byId.get(id);
      if (!v) return null;
      return {
        videoId: id,
        title: v.snippet && v.snippet.title || '(タイトル不明)',
        channelTitle: v.snippet && v.snippet.channelTitle || '',
        publishedAt: v.snippet && v.snippet.publishedAt || null,
        viewCount: v.statistics && v.statistics.viewCount != null ? Number(v.statistics.viewCount) : null,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    }).filter(Boolean);

    // 再生数順のときだけは、videos.list で取った正確な再生数で並べ直す（search.list の再生数順は
    // 近似値によるもので、実際の数値とずれることがある）
    if (order === 'viewCount') {
      results.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
    }
    return results;
  }
}

module.exports = YouTubeService;
