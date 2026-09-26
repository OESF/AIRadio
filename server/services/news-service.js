/**
 * @file ニュースの見出しの取得（Yahoo!ニュースの RSS と、海外の英語フィード）
 *
 * Yahoo!ニュース（トップ・国内・国際・経済・IT）の RSS から見出しを集め、放送のニュースコーナー・
 * ティッカー・Secretary の get_news・デイリーノートに渡す。API キーは要らない。海外のニュースは
 * fetchGlobalNews が英語圏のフィードから実際の記事 URL 付きで取る。
 *
 * キャッシュは2つある。
 * - this.cache: トピック指定なしの最新の一覧。Live の AgentSystem（コーナーのデータ・ティッカー）、
 *   secretary-loop.js の変化の検知、デイリーレポートが直接読むので public にしている。形は
 *   { data, lastFetch, structured, detailedItems }。
 * - this._rawPoolCache: 全フィードから集めた、切り詰める前の候補（20分）。トピック検索と、
 *   条件の違う呼び出しの組み立て直しに使う。
 *
 * 放送（agent-system.js）と Secretary 側（secretary-tools-services.js など）で、別々のインスタンスを持つ。
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
const { extractArticleDescription } = require('./article-description');

// 全フィードの候補（_rawPoolCache）を持っておく時間（20分）
const RAW_POOL_CACHE_TTL_MS = 1200000; // 20分
// 1つのフィードから候補に入れる最大件数（呼び出し側の maxItems とは別）。
// BUGFIX: 全体で maxItems 件集まったら打ち切ると、配列の末尾にある IT（AI のニュースが最も多い）が
// 先のフィードだけで埋まって一度も読まれなかった。まず全フィードから公平に集めてから絞り込む。
const RAW_POOL_MAX_PER_FEED = 15;

/**
 * 海外（英語圏）のニュースのフィード（fetchGlobalNews が使う）。
 *
 * BUGFIX: Yahoo!ニュースしか無かったころは、Secretary に海外ニュースを取る手段が無く、モデルが
 * Google 検索のグラウンディングで本文だけを得て、リンクは直前の get_news（Yahoo）のものを流用し、
 * 本文と出典が食い違っていた。実際の記事 URL 付きで取れるようにしている。
 * CNBC のフィードは finance-service.js の _fetchGlobalMarketNews と同じもの。
 */
const GLOBAL_RSS_FEEDS = {
  tech: [
    { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', source: 'TechCrunch AI' },
    { url: 'https://venturebeat.com/category/ai/feed/', source: 'VentureBeat AI' },
    { url: 'https://www.technologyreview.com/feed/', source: 'MIT Technology Review' },
  ],
  business: [
    { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC Economy' },
    { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', source: 'CNBC Finance' },
  ],
};

/**
 * RSS のタイトル・概要に混ざる HTML の実体参照を、読める文字へ戻す（空白は1つに畳む）。
 *
 * BUGFIX: 数値文字参照は個別に列挙せず、まとめて戻す。列挙していたころは、想定していない番号
 * （例: &#8230;）がそのまま画面に出ていた。
 * ATTENTION: &amp; は最後に戻すこと。先に戻すと、二重にエスケープされたもの（&amp;#8230;）まで
 * 誤って文字に戻してしまう。
 *
 * @param {string} t RSS の文字列
 * @returns {string} 戻した文字列
 */
function _decodeFeedText(t) {
  const fromCode = (n) => {
    // 不正なコードポイントでStringが例外を投げるため、戻せない場合は元の表記のまま残す
    try { return String.fromCodePoint(n); } catch { return null; }
  };
  return t
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => fromCode(parseInt(h, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, d) => fromCode(parseInt(d, 10)) ?? m)
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Yahoo!ニュースのフィードのカテゴリ（label）ごとの同義語。カテゴリそのものを指す広い言葉で
 * 検索されたら、そのカテゴリの全件を対象にする（fetch の中のコメント参照）。
 */
const NEWS_CATEGORY_SYNONYMS = [
  { label: 'IT',     synonyms: ['it', 'テクノロジー', 'テック', 'tech', '科学', 'デジタル', 'it関連', 'テクノロジー関連'] },
  { label: '経済',   synonyms: ['経済', 'マネー', '金融', 'ビジネス', '経済関連'] },
  { label: '国際',   synonyms: ['国際', '海外', 'world', '国際関連'] },
  { label: '国内',   synonyms: ['国内', '国内関連'] },
];

/** ニュースの見出しを取得・キャッシュするサービス。 */
class NewsService {
  constructor() {
    this.cache = { data: null, lastFetch: 0, structured: [] };
    // トピック検索用の候補（全フィード分）。this.cache とは別に持つ。
    // ATTENTION: this.cache は複数の利用元が「トピック指定なしの最新の一覧」として読むので、
    // トピックで絞り込んだ結果で上書きしてはいけない。
    this._rawPoolCache = { items: [], fetchedAt: 0 };
  }

  /**
   * キャッシュを両方とも空にする（リスナーが長く離れたときなどに呼ぶ）。
   *
   * @returns {void}
   */
  clear() {
    this.cache = { data: null, lastFetch: 0, structured: [] };
    this._rawPoolCache = { items: [], fetchedAt: 0 };
  }

  /**
   * RSS の item から、タグの値を取り出す（CDATA でも通常のテキストでもよい）。
   *
   * @param {string} chunk item の中身
   * @param {string} tag タグ名
   * @returns {string} 値（無ければ空文字）
   */
  static _extractTag(chunk, tag) {
    const m = chunk.match(new RegExp(`<${tag}><\\!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))
           || chunk.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
    return m ? m[1].trim() : '';
  }

  /**
   * Yahoo!ニュースの全フィードから候補を集める（20分キャッシュ）。
   *
   * ここでは説明文の切り詰めも記事ページの取得もしない。呼び出しごとに条件が違いうるので、
   * 切り詰める前のまま持っておき、fetch で選んだ後に適用する。
   *
   * @returns {Promise<Array<{title: string, desc: string, link: string, label: string}>>} 候補
   */
  async _fetchRawPool() {
    if (this._rawPoolCache.items.length > 0 && Date.now() - this._rawPoolCache.fetchedAt < RAW_POOL_CACHE_TTL_MS) {
      return this._rawPoolCache.items;
    }

    const RSS_FEEDS = [
      { url: 'https://news.yahoo.co.jp/rss/topics/top-picks.xml', label: 'トップ' },
      { url: 'https://news.yahoo.co.jp/rss/topics/domestic.xml',  label: '国内'   },
      { url: 'https://news.yahoo.co.jp/rss/topics/world.xml',     label: '国際'   },
      { url: 'https://news.yahoo.co.jp/rss/topics/business.xml',  label: '経済'   },
      { url: 'https://news.yahoo.co.jp/rss/topics/it.xml',        label: 'IT'     },
    ];

    // 全フィードを並列に取る（順番に取ると最大10秒かかる）
    const fetchResults = await Promise.allSettled(
      RSS_FEEDS.map(feed =>
        fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } })
          .then(res => res.ok ? res.text().then(xml => ({ xml, label: feed.label })) : null)
          .catch(e => { getLogger().warn(`[News] Feed fetch failed (${feed.label}): ${e.message}`); return null; })
      )
    );

    const items = [];
    const seen  = new Set(); // 重複排除

    for (const result of fetchResults) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { xml, label } = result.value;

      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      let countThisFeed = 0;
      while ((match = itemRegex.exec(xml)) !== null) {
        if (countThisFeed >= RAW_POOL_MAX_PER_FEED) break;
        const chunk = match[1];
        const title = NewsService._extractTag(chunk, 'title');
        if (!title || seen.has(title)) continue;

        // description: HTMLタグを除去（maxDescLengthでの切り詰めはfetch()側で選定後に行う）
        let desc = NewsService._extractTag(chunk, 'description')
          .replace(/<[^>]+>/g, '')  // HTMLタグ除去
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .trim();
        if (desc === title) desc = ''; // タイトルと同じなら不要

        // リンクURL（記事URLとして参考情報に使う）
        const link = NewsService._extractTag(chunk, 'link')
          || (chunk.match(/<link>([^<]+)<\/link>/) || [])[1] || '';

        seen.add(title);
        items.push({ title, desc, link, label });
        countThisFeed += 1;
      }
    }

    if (items.length > 0) {
      this._rawPoolCache = { items, fetchedAt: Date.now() };
    }
    return items;
  }

  /**
   * 最新の見出しを、モデルへそのまま渡せる文章にして返す。
   *
   * - topic を指定すると、候補の中からタイトルにキーワードを含むものだけを、コードの文字列一致で
   *   決定的に選ぶ。一致が0件なら、その旨の文を返す。
   * - fetchArticleDescriptions を true にすると、記事のページを1件ずつ取って要約文を補う
   *   （RSS には説明文が無いため）。デイリーノートが使う。放送のコーナーは渡さないので、
   *   放送の途中で余計な HTTP リクエストは起きない。
   * - トピック指定なしの結果だけ this.cache を更新する。
   *
   * BUGFIX: トピックとの一致をモデルの目視に任せていたころは、「AI 関連」では「無い」と言い、
   * 「テクノロジー関連」では AI のニュースばかり出す、という判断のブレが起きていた。
   *
   * @param {{ maxItems?: number, maxDescLength?: number, fetchArticleDescriptions?: boolean, topic?: string }} opts
   *   件数（既定8）・説明文の最大文字数（既定120）・記事ページから要約を補うか・絞り込むキーワード
   * @returns {Promise<string|null>} 見出しの一覧の文（取れなければ null か前回の一覧）
   */
  async fetch({ maxItems = 8, maxDescLength = 120, fetchArticleDescriptions = false, topic = '' } = {}) {
    const trimmedTopic = (topic || '').trim();

    // BUGFIX: this.cache が新しくても、それを返して済ませず毎回候補から組み立て直す。以前は、どの
    // オプションで作ったかをキャッシュに残していなかったので、先に別の条件（切り詰めあり）で呼ばれると、
    // 後の呼び出し（切り詰めなし・記事ページあり）のオプションが無視され、デイリーノートの説明が
    // 途中で切れていた。RSS の取得は _fetchRawPool のキャッシュが効くので、通信は増えない。
    const rawItems = await this._fetchRawPool();
    if (rawItems.length === 0) {
      return trimmedTopic ? null : (this.cache.data || null);
    }

    let selected;
    let noTopicMatch = false;
    if (trimmedTopic) {
      const kw = trimmedTopic.toLowerCase();
      // 「テクノロジー」「経済」のようなカテゴリそのものを指す言葉は、見出しの中にまず現れないので、
      // カテゴリの同義語に当たったらそのカテゴリの全件を対象にする。
      // ATTENTION: 「AI」のような個別のトピックは同義語に入れないこと。カテゴリごと広げると、AI で
      // 検索しても関係の無い IT の記事まで混ざる。
      const categoryMatch = NEWS_CATEGORY_SYNONYMS.find(({ synonyms }) => synonyms.includes(kw));
      // Yahoo!ニュースの RSS には説明文がまず無いので、実質はタイトルでの一致になる。記事の本文まで
      // 探すと全候補の記事ページを取ることになり重いので、あえてタイトル（と説明文）に限っている。
      selected = categoryMatch
        ? rawItems.filter(it => it.label === categoryMatch.label).slice(0, maxItems)
        : rawItems.filter(it => it.title.toLowerCase().includes(kw) || it.desc.toLowerCase().includes(kw)).slice(0, maxItems);
      if (selected.length === 0) noTopicMatch = true;
    } else {
      selected = rawItems.slice(0, maxItems);
    }

    if (noTopicMatch) {
      // 見つからなかったことは事実としてそのまま返す（モデルに判断させない）。this.cache は更新しない。
      return `Yahoo Japanニュースの現在の見出し一覧の中に、「${trimmedTopic}」に関連するものは見つかりませんでした。`;
    }

    // 選んだ分だけ説明文を切り詰める（候補は切り詰める前のまま持っている）
    const items = selected.map(it => ({
      ...it,
      desc: it.desc.length > maxDescLength ? it.desc.slice(0, maxDescLength) + '…' : it.desc,
    }));

    // RSS には説明文が無いので、記事ページを並列に取って要約文を補う。取れない記事は説明文が空のまま
    // 進める。選んだ件数分だけ取るので、トピック検索でも費用は変わらない。
    if (fetchArticleDescriptions) {
      await Promise.all(items.map(async (item) => {
        if (item.desc || !item.link) return; // 既にRSS側で説明文があれば上書きしない
        try {
          const artRes = await fetch(item.link, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } });
          if (!artRes.ok) return;
          const html = await artRes.text();
          // BUGFIX: og:description は Yahoo! 側で約99字に切られているので、ページ内にある要約の全文を
          // 拾い直す（article-description.js 参照）。
          const d = extractArticleDescription(html);
          if (d && d !== item.title) {
            item.desc = d.length > maxDescLength ? d.slice(0, maxDescLength) + '…' : d;
          }
        } catch (e) {
          getLogger().debug(`[News] 記事ページからの説明文取得失敗（${item.title}）: ${e.message}`);
        }
      }));
    }

    // 見出し・説明文・URL を1件ずつ並べる。
    // BUGFIX: URL も渡す。渡していなかったころは、「リンクも出して」と頼まれたモデルが、それらしい
    // 文字列を作っていた。
    const lines = items.map((item, i) => {
      const descPart = item.desc ? `\n   概要: ${item.desc}` : '';
      const linkPart = item.link ? `\n   URL: ${item.link}` : '';
      return `${i + 1}. [${item.label}] ${item.title}${descPart}${linkPart}`;
    });
    const result = trimmedTopic
      ? `Yahoo Japanニュース 「${trimmedTopic}」に関連する見出し（${items.length}件）:\n${lines.join('\n')}`
      : `Yahoo Japanニュース 最新情報（${items.length}件）:\n${lines.join('\n')}`;

    if (!trimmedTopic) {
      // トピック指定なしの結果だけ、ほかの利用元が読む共有のキャッシュを更新する
      this.cache = {
        data: result, lastFetch: Date.now(),
        structured: items.map(i => ({ title: i.title, label: i.label })),
        // structured はティッカーなどのために title と label だけの形を保つ。デイリーノートで出典の
        // リンクを付けるための完全な項目は、別のプロパティに入れる。
        detailedItems: items,
      };
    }
    return result;
  }

  /**
   * 海外（英語圏）のニュースを、実際の記事 URL 付きで取る（GLOBAL_RSS_FEEDS）。
   *
   * fetch とは独立しており、this.cache（放送のティッカーなどが読む）には触らない。
   *
   * @param {{ category?: 'tech'|'business'|'all', perFeed?: number, maxAgeHours?: number,
   *           maxDescLength?: number }} opts
   *   分野・1フィードあたりの件数・何時間前までの記事か・説明文の最大文字数。
   *   説明文を切り詰めるのは、本文をまるごと説明文に入れて配信するフィード（6000字を超えるものが
   *   あった）がモデルのコンテキストを圧迫するため。
   * @returns {Promise<Array<{title:string, link:string, desc:string, source:string, pubDate:string|null}>>}
   *   フィードを交互に並べた記事（1つのフィードだけで埋まらないように）
   */
  async fetchGlobalNews({ category = 'tech', perFeed = 8, maxAgeHours = 72, maxDescLength = 300 } = {}) {
    const feeds = category === 'all'
      ? [...GLOBAL_RSS_FEEDS.tech, ...GLOBAL_RSS_FEEDS.business]
      : (GLOBAL_RSS_FEEDS[category] || GLOBAL_RSS_FEEDS.tech);

    const per = await Promise.allSettled(feeds.map(async ({ url, source }) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const out = [];
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          if (out.length >= perFeed) break;
          const tm = m[1].match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || m[1].match(/<title>([^<]+)<\/title>/);
          if (!tm) continue;
          const lm = m[1].match(/<link>([^<]+)<\/link>/);
          const dm = m[1].match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || m[1].match(/<description>([^<]*)<\/description>/);
          const pm = m[1].match(/<pubDate>([^<]+)<\/pubDate>/);
          const title = _decodeFeedText(tm[1]);
          let desc = dm ? _decodeFeedText(dm[1].replace(/<[^>]+>/g, '')) : '';
          if (desc === title) desc = '';
          if (maxDescLength > 0 && desc.length > maxDescLength) desc = `${desc.slice(0, maxDescLength)}…`;
          const pub = pm ? new Date(pm[1]) : null;
          out.push({
            title, link: lm ? lm[1].trim() : '', desc, source,
            pubDate: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null,
          });
        }
        return out;
      } finally { clearTimeout(timer); }
    }));

    const lists = per.map(r => (r.status === 'fulfilled' ? r.value : []));
    const merged = [];
    for (let i = 0; i < perFeed; i++) for (const l of lists) if (l[i]) merged.push(l[i]);
    const failed = per.filter(r => r.status === 'rejected').length;
    if (failed) getLogger().warn(`[News] 海外ニュースの取得に一部失敗: ${failed}/${feeds.length}件のフィード`);

    // 特集記事などで古い記事が上位に残ることがあるため、公開日時で足切りする
    // （pubDateが読めなかったものは、取りこぼしを避けるため残す）。
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    const fresh = merged.filter(it => !it.pubDate || new Date(it.pubDate).getTime() >= cutoff);
    getLogger().info(`[News] 海外ニュース（${category}）: ${fresh.length}件（直近${maxAgeHours}時間、全${merged.length}件中）`);
    return fresh;
  }
}

module.exports = NewsService;
