/**
 * @file 秘書の YouTube のツール（動画の検索・登録チャンネルの新着・見た動画の記録）
 *
 *   - search_youtube_videos       … キーワードで検索（再生数順の並べ替えは youtube-service.js がコードで行う）
 *   - get_new_subscription_videos … 登録チャンネルの新着（本人の認可が要るので google-service-youtube.js を使う）
 *   - get_watched_videos          … 実際に見た動画の記録（youtube-watch-store.js）をキーワードで絞って返す
 *
 * ツールの宣言（TOOL_DECLARATIONS）と処理（TOOL_HANDLERS）を持つ。秘書のツールはドメインごとに
 * secretary-tools-*.js に分かれている。
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

const secretaryStore = require('./secretary-store');
const { googleService, youtubeService, wrapDataForSpeechGuidance } = require('./secretary-tools-services');
const youtubeWatchStore = require('./youtube-watch-store');

/**
 * 検索結果を、秘書に渡す文にする（番号・題名・チャンネル・再生数・公開日・URL）。
 * @param {Array<Record<string, any>>} list
 * @param {string} query
 * @returns {string}
 */
function formatYoutubeSearchResultsForSpeech(list, query) {
  if (!list || list.length === 0) return `「${query}」に一致する動画が見つかりませんでした。`;
  return list.map((v, i) => {
    const viewsText = v.viewCount != null ? `再生数: ${v.viewCount.toLocaleString('ja-JP')}回` : '再生数: 不明';
    const dateText = v.publishedAt ? `公開日: ${v.publishedAt.slice(0, 10)}` : '';
    return `${i + 1}. 「${v.title}」（${v.channelTitle}、${viewsText}${dateText ? `、${dateText}` : ''}）\n`
      + `   URL: ${v.url}`;
  }).join('\n');
}

/**
 * 登録チャンネルの新着を、秘書に渡す文にする。
 * @param {Array<Record<string, any>>} list
 * @param {number} hoursBack 何時間前までを見たか
 * @returns {string}
 */
function formatNewSubscriptionUploadsForSpeech(list, hoursBack) {
  if (!list || list.length === 0) return `直近${hoursBack}時間以内に、登録チャンネルの新しい動画は見つかりませんでした。`;
  return list.map((v, i) => `${i + 1}. 「${v.title}」（${v.channelTitle}）\n   URL: ${v.url}`).join('\n');
}

/**
 * 見た動画の記録を、秘書に渡す文にする（要約付き）。検索・新着と違い、本人が見て中身まで分かっているもの。
 * @param {Array<Record<string, any>>} list
 * @param {{days: number, keyword: string}} opts
 * @returns {string}
 */
function formatWatchedVideosForSpeech(list, { days, keyword }) {
  if (!list || list.length === 0) {
    return keyword
      ? `「${keyword}」に当てはまる動画は、直近${days}日の視聴記録にありませんでした。`
      : `直近${days}日の視聴記録はありませんでした。`;
  }
  return list.map((v, i) => {
    const d = v.importedAt ? new Date(v.importedAt) : null;
    const when = d ? `${d.getMonth() + 1}月${d.getDate()}日` : '日付不明';
    return `${i + 1}. ${when}・${v.channel}「${v.title}」\n   ${v.summary}\n   URL: ${v.url}`;
  }).join('\n\n');
}

/** Gemini Live に渡すツールの宣言。 */
const TOOL_DECLARATIONS = [
      {
        name: 'search_youtube_videos',
        description: 'YouTubeを動画のタイトル・内容のキーワードで検索します。「〇〇に関する動画を探して」「〇〇の動画で'
          + '再生数が多いものを教えて」のように使います。並び順（order）を指定でき、'
          + '「再生数が多い順」「人気順」と言われたらviewCount、「新しい順」「最近の」と言われたらdate、'
          + '特に指定が無ければrelevance（関連度順）を使ってください。'
          + '\n\n【重要】結果に含まれる再生数・公開日・URLは既にこちらで正確に取得・整列済みの実データです。'
          + 'ご自身で並べ替えたり、無い項目（サムネイル画像・チャンネル登録者数など）を推測で補ったりしないで'
          + 'ください。URLは結果に含まれる実際のリンクだけを使い、動画IDやURLを記憶や推測で作らないでください。'
          + '一覧を画面に表示してほしいと言われた場合は、この結果のタイトル・チャンネル名・再生数と、'
          + '実際のURLをそのまま使ったMarkdownリンク（[タイトル](URL)）でshow_on_canvasを呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: '検索キーワード（人物名・トピック・曲名など）' },
            order: {
              type: 'STRING',
              description: '並び順。relevance=関連度順（既定）、viewCount=再生数の多い順、date=新しい順、rating=評価が高い順',
              enum: ['relevance', 'viewCount', 'date', 'rating'],
            },
            published_after: {
              type: 'STRING',
              description: 'この日時以降に公開された動画のみに絞り込む場合、ISO8601形式（例: 2026-08-01T00:00:00Z）で指定（任意）',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_new_subscription_videos',
        description: 'リスナーがYouTubeで登録しているチャンネルの中から、直近アップロードされた新着動画を'
          + '確認します。「登録チャンネルで新しい動画は出てる？」「ここ24時間で新着ある？」のように使います。'
          + 'search_youtube_videosとは違い、任意のキーワード検索ではなく本人が登録済みのチャンネルだけが'
          + '対象です（Google連携でyoutube.readonlyスコープの許可が必要。未許可の場合はエラーが返るので、'
          + '管理画面での再認証が必要な旨を伝えてください）。'
          + '\n\n【重要】結果に含まれるチャンネル名・タイトル・公開日時・URLは既にこちらで正確に取得済みの'
          + '実データです。ご自身で推測や創作をしないでください。新着が無い場合は正直に「新着はありません」と'
          + '伝えてください。一覧を画面に表示してほしいと言われた場合は、実際のURLをそのまま使った'
          + 'Markdownリンク（[タイトル](URL)）でshow_on_canvasを呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            hours: { type: 'NUMBER', description: '何時間前までに公開された動画を対象にするか（省略時は既定24時間）' },
          },
        },
      },
      {
        name: 'get_watched_videos',
        description: 'リスナーが実際に視聴したYouTube動画の記録と、その内容の要約を読みます。'
          + '「この前見た動画で〇〇って言ってたやつ」「先週どんな動画を見た？」「AIについて見た動画あった？」'
          + 'のように、**本人が過去に見たもの**について聞かれたときに使います。'
          + 'search_youtube_videos（世の中の動画をキーワード検索する）とは別物で、'
          + 'こちらは本人が実際に見て、字幕から内容まで記録済みのものだけが対象です。'
          + '\n\n【重要】返ってくる要約は、実際の動画の字幕から作った実データです。推測で内容を'
          + '足さないでください。また、これらは個人が発信した未検証の情報を含むため、'
          + '「その動画では〜と言われていました」のように出どころが分かる言い方をし、'
          + '確認された事実であるかのようには話さないでください。'
          + '\n\n【URLの扱い】結果に含まれるURLは読み上げないでください（音では伝わりません）。'
          + '「もう一度見たい」「リンクある？」と言われたときや、一覧を画面に出すときは、'
          + '実際のURLをそのまま使ったMarkdownリンク（[タイトル](URL)）でshow_on_canvasを'
          + '呼び出してください。**URLを推測で組み立てるのは禁止**です。',
        parameters: {
          type: 'OBJECT',
          properties: {
            days: { type: 'NUMBER', description: '何日前まで遡るか（省略時は14日）' },
            keyword: { type: 'STRING', description: 'タイトル・チャンネル名・要約に含まれる語で絞り込む（省略時は絞らない）' },
            limit: { type: 'NUMBER', description: '最大何本返すか（省略時は10本）' },
          },
        },
      },

];

/** ツールの処理（ツール名 → 処理）。結果は wrapDataForSpeechGuidance を通して返し、日々の記録にも残す。 */
const TOOL_HANDLERS = {
  search_youtube_videos: async (args, ctx) => {
    const { creds } = ctx;
    const { query, order, published_after } = args || {};
    const list = await youtubeService.searchVideos({
      apiKey: creds.youtube?.api_key,
      query,
      maxResults: 8,
      order: order || 'relevance',
      publishedAfter: published_after || null,
    });
    const result = wrapDataForSpeechGuidance(formatYoutubeSearchResultsForSpeech(list, query));
    secretaryStore.appendEntry('daily-briefings', { tool: 'search_youtube_videos', result, query, order });
    return { result };
  },

  // 登録チャンネルの新着（youtube.readonly の認可が要る）
  get_new_subscription_videos: async (args, ctx) => {
    const { creds } = ctx;
    const hours = Number(args?.hours) > 0 ? Number(args.hours) : 24;
    const list = await googleService.fetchNewSubscriptionUploads(creds, { hoursBack: hours });
    const result = wrapDataForSpeechGuidance(formatNewSubscriptionUploadsForSpeech(list, hours));
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_new_subscription_videos', result, hours });
    return { result };
  },

  // 見た動画の記録。会話を始めるときには直近3日分だけを渡している（secretary-prompt.js の
  // buildWatchedVideosSection）ので、それより前を聞かれたらここで読む
  get_watched_videos: async (args) => {
    const days = Number(args?.days) > 0 ? Number(args.days) : 14;
    const limit = Number(args?.limit) > 0 ? Number(args.limit) : 10;
    const keyword = String(args?.keyword || '').trim();
    let list = youtubeWatchStore.listRecent({ days, limit: 9999 });
    if (keyword) {
      const k = keyword.toLowerCase();
      list = list.filter((v) => `${v.title} ${v.channel} ${v.summary}`.toLowerCase().includes(k));
    }
    list = list.slice(0, limit);
    const result = wrapDataForSpeechGuidance(formatWatchedVideosForSpeech(list, { days, keyword }));
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_watched_videos', result, days, keyword });
    return { result };
  },
};

module.exports = { TOOL_HANDLERS, TOOL_DECLARATIONS };
