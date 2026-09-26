/**
 * @file 世の中で反応が多かった話題（はてなブックマーク・Google トレンド）と、それに付いた個人の声を取得する
 *
 * The Answers のテーマ選びと、話題の材料（lib/topical-materials.js）が使う。反応の数で世間の関心を測るのが目的。
 * X（Twitter）の API は投稿の読み取りが有料なので、無料で取れる次の2つを使う。
 *
 *   - はてなブックマークのホットエントリ: ブックマーク数が「何人が反応したか」の実数になる。議論になる記事が
 *     集まりやすい。上位の記事には、個人のコメント（生の声）も取る
 *   - Google トレンド（日本）: 検索数は取れるが、単語だけで文脈が無く雑音も多いので、補助として扱う
 *
 * ATTENTION: はてなブックマークの利用者層には偏りがある（世間全体の関心と同じではない）。Yahoo! ニュースの
 *            見出しと合わせて使う前提。
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

const HATENA_FEEDS = [
  { url: 'https://b.hatena.ne.jp/hotentry/social.rss', label: '世の中' },
  { url: 'https://b.hatena.ne.jp/hotentry.rss',        label: '総合' },
];
const TRENDS_URL = 'https://trends.google.co.jp/trending/rss?geo=JP';
const CACHE_TTL_MS = 30 * 60 * 1000; // テーマ選びはエピソード単位なので、短くする必要は無い

// 生の声を取りに行く記事の数と、1記事あたりに渡すコメントの数。増やすほどプロンプトが膨らむので、
// 賛否の分かれ目が見える最小限にする
const COMMENT_TARGET_ENTRIES = 4;
const COMMENTS_PER_ENTRY = 8;
const COMMENT_MAX_LEN = 90;

// 明らかな宣伝やスパム（業者の書き込みがコメント欄に紛れていた）。厳しくしすぎると「まだ高い」のような
// 短くて価値のある声まで落ちるので、長さでは切らず、宣伝に特有の語と URL だけを見る
const SPAM_PATTERNS = [
  /telegram/i, /デリヘル|風俗|出張エステ|人妻|援交/, /line[ 　]*id|ライン[ 　]*ID/i,
  /https?:\/\/\S+\s*$/,   // コメントがURLだけで終わっているもの
];

/**
 * コメントが宣伝・スパム、または中身が無いか。
 * @param {string} text
 * @returns {boolean}
 */
function isSpamComment(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (SPAM_PATTERNS.some(re => re.test(t))) return true;
  // URL を除くとほとんど何も残らないもの
  return t.replace(/https?:\/\/\S+/g, '').trim().length < 2;
}

/**
 * RSS のタイトルの文字参照（&#x3042; など）を文字へ戻し、空白を詰める。
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * タイムアウト付きで取得する。
 * @param {string} url
 * @param {number} [ms] タイムアウト（ミリ秒）
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } })
    .finally(() => clearTimeout(timer));
}

/** 反応の多い話題の取得と、プロンプト用の整形（30分キャッシュ） */
class TrendingService {
  constructor() {
    this.cache = { hotEntries: [], trends: [], voices: [], lastFetch: 0 };
  }

  /**
   * はてなブックマークのホットエントリを、ブックマーク数の多い順に返す。
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<Array<{ title: string, bookmarks: number, link: string, category: string }>>}
   */
  async _fetchHotEntries({ limit = 12 } = {}) {
    const results = await Promise.allSettled(HATENA_FEEDS.map(async ({ url, label }) => {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const out = [];
      for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)) {
        const tm = m[1].match(/<title>([^<]+)<\/title>/);
        if (!tm) continue;
        const bm = m[1].match(/<hatena:bookmarkcount>(\d+)</);
        const lm = m[1].match(/<link>([^<]+)<\/link>/);
        out.push({
          title: decodeEntities(tm[1]),
          bookmarks: bm ? Number(bm[1]) : 0,
          link: lm ? lm[1].trim() : '',
          category: label,
        });
      }
      return out;
    }));

    // 2つのフィードは重なるので、同じ記事はブックマーク数の大きい方を残す
    const byTitle = new Map();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const item of r.value) {
        const prev = byTitle.get(item.title);
        if (!prev || item.bookmarks > prev.bookmarks) byTitle.set(item.title, item);
      }
    }
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) getLogger().warn(`[Trending] はてなブックマークの取得に一部失敗: ${failed}/${HATENA_FEEDS.length}件`);
    return [...byTitle.values()].sort((a, b) => b.bookmarks - a.bookmarks).slice(0, limit);
  }

  /**
   * Google トレンド（日本）の急上昇ワードを返す（単語だけで文脈は無い）。失敗したら空の配列。
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<Array<{ keyword: string, traffic: string }>>}
   */
  async _fetchGoogleTrends({ limit = 8 } = {}) {
    try {
      const res = await fetchWithTimeout(TRENDS_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const out = [];
      for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)) {
        if (out.length >= limit) break;
        const tm = m[1].match(/<title>([\s\S]*?)<\/title>/);
        if (!tm) continue;
        const am = m[1].match(/<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/);
        out.push({ keyword: decodeEntities(tm[1]), traffic: am ? am[1].trim() : '' });
      }
      return out;
    } catch (e) {
      getLogger().warn(`[Trending] Googleトレンドの取得に失敗: ${e.message}`);
      return [];
    }
  }

  /**
   * 上位の記事に付いた個人のコメント（生の声）を取る。
   *
   * 通信社の配信記事は各社が同じ元データをなぞるだけで、賛否の分かれ目が見えない。個人の声には同じ出来事への
   * 相反する見方が同居していて、討論の材料になる。
   * ATTENTION: 拾った声は事実ではなく「そういう声がある」としてだけ使う。真偽は確かめていないので、
   *            formatForPrompt で番組が事実として断定しないよう明示している。
   * @param {Array<Record<string, any>>} entries ホットエントリ
   * @returns {Promise<Array<{ title: string, bookmarks: number, comments: string[] }>>}
   */
  async _fetchEntryComments(entries) {
    const targets = (entries || []).slice(0, COMMENT_TARGET_ENTRIES).filter(e => e.link);
    const results = await Promise.allSettled(targets.map(async (entry) => {
      const res = await fetchWithTimeout(`https://b.hatena.ne.jp/entry/jsonlite/?url=${encodeURIComponent(entry.link)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const comments = (data.bookmarks || [])
        .map(b => String(b.comment || '').replace(/\s+/g, ' ').trim())
        .filter(c => c && !isSpamComment(c))
        .slice(0, COMMENTS_PER_ENTRY)
        .map(c => (c.length > COMMENT_MAX_LEN ? `${c.slice(0, COMMENT_MAX_LEN)}…` : c));
      return { title: entry.title, bookmarks: entry.bookmarks, comments };
    }));
    const out = results.filter(r => r.status === 'fulfilled' && r.value.comments.length > 0).map(r => r.value);
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) getLogger().warn(`[Trending] コメントの取得に一部失敗: ${failed}/${targets.length}件`);
    return out;
  }

  /**
   * ホットエントリ・トレンド・生の声をまとめて取得する（30分キャッシュ）。失敗しても投げず、空の配列で返す。
   * @param {{ force?: boolean }} [opts] force はキャッシュを使わない
   * @returns {Promise<Record<string, any>>} hotEntries・trends・voices・lastFetch
   */
  async fetch({ force = false } = {}) {
    if (!force && this.cache.lastFetch && Date.now() - this.cache.lastFetch < CACHE_TTL_MS) {
      return this.cache;
    }
    const [hot, trends] = await Promise.all([
      this._fetchHotEntries().catch(() => []),
      this._fetchGoogleTrends().catch(() => []),
    ]);
    // 生の声はホットエントリの URL が要るので、その後に取る
    const voices = await this._fetchEntryComments(hot).catch(() => []);
    this.cache = { hotEntries: hot, trends, voices, lastFetch: Date.now() };
    getLogger().info(`[Trending] 反応の多い話題: はてブ${hot.length}件 / トレンド${trends.length}件 / `
      + `生の声${voices.reduce((n, v) => n + v.comments.length, 0)}件（${voices.length}記事）`);
    return this.cache;
  }

  /**
   * テーマ選びのプロンプトへ差し込む文字列を組み立てる。
   * ブックマーク数は必ず添える。「何人が反応したか」という数があって初めて、関心の大きさを判断できる。
   * @param {Record<string, any>} [data] fetch の結果（省略するとキャッシュ）
   * @returns {string}
   */
  formatForPrompt({ hotEntries, trends, voices } = this.cache) {
    const parts = [];
    if (hotEntries && hotEntries.length > 0) {
      parts.push('\n【世の中で反応が多かった話題（はてなブックマーク・数字は実際にブックマークした人数）】\n'
        + hotEntries.map(e => `- [${e.bookmarks}件] ${e.title}`).join('\n'));
    }
    if (voices && voices.length > 0) {
      const blocks = voices.map(v => `■ ${v.title}（${v.bookmarks}件のブックマーク）\n`
        + v.comments.map(c => `  ・「${c}」`).join('\n')).join('\n');
      parts.push('\n【その記事に対して実際に書き込まれた個人の声】\n'
        + '※ 大手メディアの配信記事は各社が同じ元データをなぞるだけで賛否の分かれ目が見えません。\n'
        + '  以下は、その記事を読んだ個人が実際に書いた声です。同じ出来事に相反する見方が同居して\n'
        + '  いる箇所こそ、討論のテーマとして最良の材料になります。\n'
        + '【最重要・扱い方】これらは**事実ではなく「そういう声がある」という事実**です。内容の\n'
        + '  真偽は一切確認されていません。書かれている主張を事実として断定したり、番組が\n'
        + '  裏付けのある情報として紹介したりすることは絶対にしないでください。テーマにする際は\n'
        + '  「〜という見方と〜という見方が割れている」のように、**見方が分かれているという事実**\n'
        + '  を軸にしてください。個人の書き込みをそのまま引用する必要もありません。\n'
        + blocks);
    }
    if (trends && trends.length > 0) {
      parts.push('\n【いま検索されているワード（Googleトレンド日本・単語のみで文脈が無いため補助的に）】\n'
        + trends.map(t => `- ${t.keyword}${t.traffic ? `（検索数 ${t.traffic}）` : ''}`).join('\n'));
    }
    return parts.join('\n');
  }
}

module.exports = TrendingService;
