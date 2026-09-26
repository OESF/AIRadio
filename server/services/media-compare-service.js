/**
 * @file 同じ話題を各社がどう書いたかを集めて並べる（新聞の読み比べ）
 *
 * Google ニュースの RSS を媒体ごと（site: の指定）に引き、同じ話題の見出しを束ねて返す。今使っているのは
 * 社説（fetchEditorialClusters）と、話題ごとの過去の社説（fetchPastEditorials）。束ねたものは
 * lib/editorial-compare.js が読み、報道センター・コメンテーター・討論コーナー（lib/topical-materials.js 経由）が使う。
 *
 * ひとつの情報源を別のひとつに替えても偏りは直らないので、各社の見出しを並べ、扱いの差そのものを材料にする。
 * media_compare の設定（config.show.media_compare）で、比べる媒体を管理画面から変えられる。
 *
 * ATTENTION: 守るべき決まりが3つある。
 * 1. どの見出しが同じ話題かはコードで決める（LLM にも検索の順位にも任せない）。キーワード検索で束ねると、
 *    抽象的なテーマでは無関係な記事だらけになる。
 * 2. 差が無いときは黙る。横並びの出来事は各社ほぼ同じ書き方になり、無理に読み比べさせると、ありもしない
 *    対立を作文する。取り上げるかどうかは lib/editorial-compare.js が決め、プロンプトでも
 *    「実際に差がある所だけ」と伝える。
 * 3. 「A社は◯◯寄り」といった論調の札を先に渡さない。記事と関係なく、その通りの解説を作文してしまう。
 *    各社が実際に何と書いたかという事実だけを渡す。
 *
 * 記事の本文は取りに行かない（各社とも robots.txt で AI のクローラーを断っているため）。見出しだけで足りる。
 *
 * ATTENTION: 結果の保存（キャッシュ）は条件を鍵にしていないので、同じ種類の呼び出しは同じ条件で行うこと。
 * 時間の幅や閾値を変えて呼ぶと、前の条件の結果がそのまま返る。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */
'use strict';

const { getLogger } = require('../logger');

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const USER_AGENT = 'Mozilla/5.0 (compatible; AIRadio/1.0)';
const CACHE_TTL_MS = 1800000; // 結果を使い回す時間（30分。報道センターが出る間隔より十分短い）
const FETCH_TIMEOUT_MS = 8000;

// 既定の比べる媒体（全国紙5紙・NHK・通信社2社）。管理画面から変えられる。
// 通信社は各紙より事実に寄る傾向があるので、比べるときの基準になる
const DEFAULT_OUTLETS = [
  { name: 'NHK',         domain: 'nhk.or.jp' },
  { name: '朝日新聞',     domain: 'asahi.com' },
  { name: '毎日新聞',     domain: 'mainichi.jp' },
  { name: '産経新聞',     domain: 'sankei.com' },
  { name: '読売新聞',     domain: 'yomiuri.co.jp' },
  { name: '日本経済新聞', domain: 'nikkei.com' },
  { name: '時事通信',     domain: 'jiji.com' },
  { name: '共同通信',     domain: '47news.jp' },
];

// 社説の呼び名が「社説」でない媒体。ここに無ければ「社説」で探す。
// 社説を持たない媒体（通信社・NHK）は0本になるだけで、他社には影響しない
const EDITORIAL_WORD_BY_DOMAIN = {
  'sankei.com': '主張',
};

// 社説の見出しに付く飾り（（社説）・社説：・［社説］・＜主張＞ など）。
// ATTENTION: 外してから束ねること。外さないと、どの見出しにも同じ語が入り、束ねる手がかりとして働いてしまう
const EDITORIAL_TITLE_DECORATIONS = [
  /^[（(【［〈<＜]\s*(?:社説|主張)\s*[）)】］〉>＞]\s*/,
  /^(?:社説|主張)\s*[：:＞>]\s*/,
  /\s*[（(]?\s*(?:社説|主張)\s*[）)]?\s*$/,
];

// 自社の社説ではないもの（英字版の再掲・他紙からの転載・写真のページ）を落とすための印
const NON_EDITORIAL_PATTERNS = [
  /^EDITORIAL/i, /WSJ/i, /ウォール\s*ストリート/, /写真・画像/, /^\s*"?site:/,
];

// 媒体の指定（site:）は関連する別の媒体も拾ってしまう（本紙に対する雑誌・通販・別サイトなど）。
// 配信元の名前に含まれていたら落とす語
const RELATED_MEDIA_EXCLUDE = [
  'AERA', 'アエラ', 'よみぽ', 'エクイティ', '教員採用', 'emogram', 'movie-a',
  'ランド', 'マガジン', 'ムック', '通販', 'ショッピング',
];

// よく出るが出来事を特定しない語。珍しさの重み付けでもある程度は落ちるが、記事が少ない日は効きが弱いので
// はっきり除いておく
const STOPWORD_TERMS = new Set([
  '速報', '独自', '解説', '詳報', '特集', '写真', '画像', '動画', '一覧', '全文',
  '今日', '本日', '昨日', '今年', '来年', '昨年', '今月', '来月', '先月',
  '発表', '報道', '会見', '取材', '記事', '掲載', '更新', '公開',
]);

/**
 * RSS の見出しに混ざる HTML の記法（&amp; など）を、読める文字に戻す（news-service.js と同じ考え方）。
 * @param {string} t 見出し
 * @returns {string} 戻した見出し
 */
function _decode(t) {
  const fromCode = (n) => { try { return String.fromCodePoint(n); } catch { return null; } };
  return t
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => fromCode(parseInt(h, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, d) => fromCode(parseInt(d, 10)) ?? m)
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/**
 * 全角の英数字と記号を半角に寄せる。同じ出来事でも媒体によって「１～６月」「1〜6月」のように書き方が
 * 割れるため、そろえないと同じ話題として束ねられない。
 *
 * BUGFIX: 長音符（ー）をハイフンに寄せてはいけない。寄せていたころ「ネパール」が2つに割れ、カタカナの
 * 語として拾えず、固有名詞が手がかりから丸ごと消えていた。全角のハイフンの類だけを対象にする。
 *
 * @param {string} s 文字列
 * @returns {string} そろえた文字列
 */
function _normalizeWidth(s) {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[～〜]/g, '~')
    .replace(/[－―−]/g, '-')
    .replace(/[　]/g, ' ');
}

/**
 * 共通の語の一覧を、元の言葉（概念）の数に畳む。
 *
 * BUGFIX: 漢字は2文字ずつに切って取り出すので、1つの固有名詞から複数の語が生まれる（「北海道」→ 北海・海道）。
 * そのまま2語と数えると、同じ地名が出てくるだけの無関係な記事どうしが「2語が共通＝同じ出来事」と判定された。
 * 1文字重なってつながるものを元の言葉に戻してから数える。
 *
 * @param {string[]} terms 共通の語
 * @returns {string[]} 畳んだ語
 */
function _foldTermsToConcepts(terms) {
  const kanji = terms.filter((t) => /^[一-鿿々]{2}$/.test(t));
  const others = terms.filter((t) => !/^[一-鿿々]{2}$/.test(t));
  const merged = [...kanji];
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let a = 0; a < merged.length; a++) {
      for (let b = 0; b < merged.length; b++) {
        if (a === b) continue;
        // 「北海」+「海道」→「北海道」のように1文字重なりで連結できるものを畳む
        if (merged[a].slice(1) === merged[b].slice(0, merged[b].length - 1)) {
          const joined = merged[a] + merged[b].slice(-1);
          merged.splice(Math.max(a, b), 1);
          merged.splice(Math.min(a, b), 1, joined);
          changed = true;
          break outer;
        }
      }
    }
  }
  // 長い語に含まれてしまった短い語を落とす（「土石」は「土石流」に入っている）
  const concepts = merged.filter((m, i) => !merged.some((o, j) => j !== i && o.length > m.length && o.includes(m)));
  return [...concepts, ...others];
}

/**
 * 見出しから、出来事を特定する手がかりの語を切り出す。
 *
 * 日本語を単語に切る部品は入れていない（依存を増やさないため）ので、文字の種類の続きで代わりにする。
 * 漢字の続きは2文字ずつ、カタカナの続きは3文字以上をそのまま1語、英数字の続きは2文字以上をそのまま1語。
 *
 * ATTENTION: 漢字を2文字ずつに切るのが肝。媒体によって「◯◯首相」「◯◯△△首相」「首相」と書き方が揺れる
 * ので、続きを丸ごと1語にすると一致しない。2文字ずつなら共通の部分が残る。
 *
 * @param {string} title 見出し
 * @returns {Set<string>} 手がかりの語
 */
function _extractTerms(title) {
  const s = _normalizeWidth(title);
  const terms = new Set();
  for (const m of s.matchAll(/[一-鿿々]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOPWORD_TERMS.has(bg)) terms.add(bg);
    }
  }
  for (const m of s.matchAll(/[゠-ヿ]{3,}/g)) terms.add(m[0]);
  for (const m of s.matchAll(/[A-Za-z0-9]{2,}/g)) terms.add(m[0].toLowerCase());
  return terms;
}

/**
 * 社説の見出しから飾り（（社説）・＜主張＞ など）を外し、主張の本体だけにする。
 * @param {string} title 見出し
 * @returns {string} 飾りを外した見出し
 */
function _stripEditorialDecoration(title) {
  let t = title.trim();
  for (const re of EDITORIAL_TITLE_DECORATIONS) t = t.replace(re, '').trim();
  return t;
}

/**
 * その見出しが社説そのものか。飾りが実際に外せたときだけ社説とみなす。
 *
 * BUGFIX: 「社説」「主張」の語が含まれるかで判定しない。判定していたころ、「◯◯の主張に反論」のような
 * ふつうの記事や、「社説担当」という署名まで社説として拾っていた。
 *
 * @param {string} title 見出し
 * @returns {boolean} 社説なら true
 */
function _looksLikeEditorial(title) {
  const t = String(title || '').trim();
  return t.length > 0 && _stripEditorialDecoration(t) !== t;
}

/** 新聞の読み比べのサービス（ファイルの冒頭参照）。 */
class MediaCompareService {
  constructor() {
    // 社説の読み比べ用。他のサービス（news-service など）と同じく、外からも読めるようにしておく
    this.editorialCache = { clusters: [], fetchedAt: 0, outletCount: 0 };
    // 話題ごとの過去の社説（討論コーナーで、各社の変わらない立場を見るために使う）
    this.pastEditorialCache = { key: '', fetchedAt: 0, result: [] };
  }

  /**
   * 覚えている結果を全部捨てる。
   * @returns {void}
   */
  clear() {
    this.editorialCache = { clusters: [], fetchedAt: 0, outletCount: 0 };
    this.pastEditorialCache = { key: '', fetchedAt: 0, result: [] };
  }

  /**
   * 読み比べを使うか。設定が無ければ使う（既定はオン）。
   * 管理画面でチェックを外したときと、媒体を1社も選ばなかったときはオフにする。
   * @param {Record<string, any>} config config.json 全体
   * @returns {boolean} 使うなら true
   */
  static isEnabled(config) {
    const mc = config?.show?.media_compare;
    if (mc && mc.enabled === false) return false;
    if (mc && Array.isArray(mc.outlets) && mc.outlets.length === 0) return false;
    return true;
  }

  /**
   * 比べる媒体の一覧を設定から取り出す（設定が無い・空なら既定の媒体）。
   * @param {Record<string, any>} config config.json 全体
   * @returns {Array<any>} 媒体の一覧
   */
  static resolveOutlets(config) {
    const raw = config?.show?.media_compare?.outlets;
    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_OUTLETS;
    const cleaned = raw
      .filter((o) => o && typeof o.domain === 'string' && o.domain.trim())
      .map((o) => ({ name: (o.name || o.domain).trim(), domain: o.domain.trim() }));
    return cleaned.length > 0 ? cleaned : DEFAULT_OUTLETS;
  }

  /**
   * 1つの媒体の社説の見出しを Google ニュースの RSS から取る。
   *
   * ATTENTION: 記事のページは開かない（各社とも robots.txt で AI のクローラーを断っている）。社説の見出しは
   * 主張そのもので、同じ出来事への評価が正面から割れるため、見出しだけで足りる。
   *
   * @param {any} outlet 媒体（name・domain）
   * @param {{withinHours: number}} opts 何時間前までを対象にするか
   * @returns {Promise<Array<any>>} 社説の見出し（飾りは外してある）
   */
  async _fetchOutletEditorials({ name, domain }, { withinHours }) {
    const word = EDITORIAL_WORD_BY_DOMAIN[domain] || '社説';
    const when = withinHours <= 24 ? '1d' : `${Math.ceil(withinHours / 24)}d`;
    const q = encodeURIComponent(`site:${domain} ${word} when:${when}`);
    const url = `${GOOGLE_NEWS_RSS}?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const out = [];
      const seen = new Set();
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const chunk = m[1];
        const tm = chunk.match(/<title>([\s\S]*?)<\/title>/);
        if (!tm) continue;
        const sm = chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        const feedSource = sm ? _decode(sm[1]) : '';
        if (RELATED_MEDIA_EXCLUDE.some((w) => feedSource.includes(w))) continue;
        let title = _decode(tm[1]);
        if (feedSource) title = title.replace(new RegExp(`\\s*-\\s*${feedSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '');
        title = title.trim();
        // 社説そのものだけを残す（飾りが付いていないものは、ふつうの記事かコラム）
        if (!_looksLikeEditorial(title)) continue;
        if (NON_EDITORIAL_PATTERNS.some((re) => re.test(title))) continue;
        const stripped = _stripEditorialDecoration(title);
        if (stripped.length < 6) continue;
        // 同じ社説が書き方違いで何度も配信されることがあるので、媒体ごとに重なりを落とす
        const dedupeKey = stripped.replace(/[\s　・]/g, '');
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const pm = chunk.match(/<pubDate>([^<]+)<\/pubDate>/);
        const pub = pm ? new Date(pm[1]) : null;
        out.push({
          outlet: name,
          title: stripped,
          pubDate: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null,
          terms: _extractTerms(stripped),
        });
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 各社の社説を集め、同じ話題ごとに束ねて返す。結果は30分覚えておく。
   *
   * ATTENTION: 社説は一般の記事とは扱いを変えてある。
   * - 社説は各社数本と少ないので、束ねる閾値を下げる（語の珍しさの値そのものが小さくなるため）
   * - 語の散らばりで足切りしない。社説は言葉が似ていても立場が正反対のことがある。取り上げるかどうかは
   *   lib/editorial-compare.js が決める
   * - 対象は48時間。社説は朝刊ごとで、各社が同じ話題を書く日がずれることがある
   *
   * @param {Record<string, any>} config config.json 全体
   * @param {{withinHours?: number, minOutlets?: number, pairThreshold?: number, maxClusters?: number,
   *   forceRefresh?: boolean}} [opts] minOutlets は束ねるのに要る媒体の数、pairThreshold は同じ話題とみなす
   *   スコアの下限、forceRefresh は覚えている結果を使わずに取り直す
   * @returns {Promise<Array<any>>} 話題ごとの束（社説が足りなければ空）
   */
  async fetchEditorialClusters(config, {
    withinHours = 48,
    minOutlets = 3,
    pairThreshold = 2.0,
    maxClusters = 4,
    forceRefresh = false,
  } = {}) {
    const fresh = !forceRefresh && Date.now() - this.editorialCache.fetchedAt < CACHE_TTL_MS;
    if (fresh && this.editorialCache.clusters.length > 0) return this.editorialCache.clusters.slice(0, maxClusters);

    const outlets = MediaCompareService.resolveOutlets(config);
    const t0 = Date.now();
    const settled = await Promise.allSettled(outlets.map((o) => this._fetchOutletEditorials(o, { withinHours })));
    const items = [];
    let failed = 0;
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') items.push(...r.value);
      else { failed += 1; getLogger().warn(`[Editorial] ${outlets[idx].name}の社説取得に失敗: ${r.reason?.message || r.reason}`); }
    });
    const gotOutlets = new Set(items.map((i) => i.outlet)).size;

    if (gotOutlets < minOutlets) {
      getLogger().info(`[Editorial] 社説が取れた媒体が${gotOutlets}社のみのため読み比べを見送ります（失敗${failed}社）`);
      this.editorialCache = { clusters: [], fetchedAt: Date.now(), outletCount: gotOutlets };
      return [];
    }

    const clusters = this._clusterItems(items, { minOutlets, pairThreshold });
    getLogger().info(`[Editorial] ${gotOutlets}社${items.length}本の社説から${clusters.length}話題`
      + `（${Date.now() - t0}ms、失敗${failed}社）`);
    this.editorialCache = { clusters, fetchedAt: Date.now(), outletCount: gotOutlets };
    return clusters.slice(0, maxClusters);
  }

  /**
   * ある話題について、各社がこれまでに書いてきた社説の見出しを集める（本文は取らない）。
   *
   * 今日の見出しだけでは「今日はこう書いた」しか言えないが、同じテーマの過去の社説が並ぶと、その社の
   * 変わらない立場が見える（討論コーナーで使う）。
   *
   * ATTENTION: 検索の指定は緩く、無関係な社説が大量に混ざるので、取ったあとに手がかりの語でこちらでも
   * 絞る。ただし絞りすぎないこと。語の一致だけで話題が同じかを決めようとすると、同じテーマの前の段階の
   * 社説まで落ちる。同じ話題かどうかは lib/editorial-compare.js が決める。
   * 続いているテーマは厚く集まるが、一度きりの出来事では各社1本ということもある。取れた分だけ渡す。
   *
   * @param {Record<string, any>} config config.json 全体
   * @param {{terms?: string[], titles?: string[], outlets?: string[]|null, withinDays?: number,
   *   maxPerOutlet?: number}} [opts] terms は話題の手がかりの語（先頭2語を検索の語にも使う）、
   *   titles は今日の見出し（当事者の名前が入るので、手がかりを広げるために使う）、
   *   outlets は媒体を絞るときの名前、withinDays は何日前まで、maxPerOutlet は1社あたりの本数
   * @returns {Promise<Array<{outlet: string, items: Array<{title: string, date: string}>}>>} 媒体ごとの社説
   */
  async fetchPastEditorials(config, {
    terms = [], titles = [], outlets: onlyOutlets = null, withinDays = 180, maxPerOutlet = 4,
  } = {}) {
    const keys = terms.filter(Boolean).slice(0, 6);
    if (keys.length === 0) return [];
    // 今日の見出しからも手がかりを広げる。束ねたときの語は「知事」のような一般の語になりがちだが、
    // 見出しには当事者の名前が入るので、話題を特定する力が強い
    const widened = new Set(keys);
    for (const t of titles) for (const term of _extractTerms(String(t || ''))) widened.add(term);
    const matchKeys = [...widened];
    const cacheKey = `${keys.join('|')}|${titles.join('|')}|${withinDays}`;
    if (this.pastEditorialCache.key === cacheKey
      && Date.now() - this.pastEditorialCache.fetchedAt < CACHE_TTL_MS) {
      return this.pastEditorialCache.result;
    }

    const query = keys.slice(0, 2).join(' ');
    const outlets = MediaCompareService.resolveOutlets(config)
      .filter((o) => !onlyOutlets || onlyOutlets.includes(o.name));
    const settled = await Promise.allSettled(outlets.map(async (o) => {
      const word = EDITORIAL_WORD_BY_DOMAIN[o.domain] || '社説';
      const when = `${withinDays}d`;
      const q = encodeURIComponent(`site:${o.domain} ${word} ${query} when:${when}`);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${GOOGLE_NEWS_RSS}?q=${q}&hl=ja&gl=JP&ceid=JP:ja`,
          { signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        const seen = new Set();
        const items = [];
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const chunk = m[1];
          const tm = chunk.match(/<title>([\s\S]*?)<\/title>/);
          if (!tm) continue;
          const sm = chunk.match(/<source[^>]*>([\s\S]*?)<\/source>/);
          const feedSource = sm ? _decode(sm[1]) : '';
          if (RELATED_MEDIA_EXCLUDE.some((w) => feedSource.includes(w))) continue;
          let title = _decode(tm[1]);
          if (feedSource) title = title.replace(new RegExp(`\\s*-\\s*${feedSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '');
          title = title.trim();
          if (!_looksLikeEditorial(title)) continue;
          if (NON_EDITORIAL_PATTERNS.some((re) => re.test(title))) continue;
          const stripped = _stripEditorialDecoration(title);
          // 検索の緩さを補う粗い絞り込み（手がかりの語を1つでも含むこと）。ATTENTION: ここは取りこぼさない
          // ことを優先する（同じ話題かどうかの判断は lib/editorial-compare.js が行う）
          if (!matchKeys.some((k) => stripped.includes(k))) continue;
          const dedupeKey = stripped.replace(/[\s　・]/g, '');
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const pm = chunk.match(/<pubDate>([^<]+)<\/pubDate>/);
          const d = pm ? new Date(pm[1]) : null;
          items.push({ title: stripped, date: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '' });
        }
        items.sort((a, b) => b.date.localeCompare(a.date));
        return { outlet: o.name, items: items.slice(0, maxPerOutlet) };
      } finally {
        clearTimeout(timer);
      }
    }));

    const result = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') { if (r.value.items.length > 0) result.push(r.value); }
      else getLogger().debug(`[Editorial] ${outlets[i].name}の過去社説の取得に失敗: ${r.reason?.message || r.reason}`);
    });
    getLogger().info(`[Editorial] 過去の社説（${query}）: ${result.length}社 / `
      + `計${result.reduce((s, r) => s + r.items.length, 0)}本`);
    this.pastEditorialCache = { key: cacheKey, fetchedAt: Date.now(), result };
    return result;
  }

  /**
   * 同じ出来事を報じた見出しを束ねる。
   *
   * 全部の見出しから語の珍しさ（IDF）を出し、媒体をまたぐ2本の見出しの共通の語の重みを足して、同じ出来事か
   * を決める。「首相」「発表」のようにどこにでも出る語は重みが小さく、固有名詞や具体的な数字が一致したときに
   * だけスコアが伸びる。
   *
   * BUGFIX: 新しく加えるものは、すでに入っている全部と閾値を超えていることを条件にする。つながったものを
   * 次々にまとめる作り方だと、A と B、B と C がつながるだけで、無関係な A と C まで1つの塊になった
   * （実際に、別々の出来事5件が1つの束になった）。
   *
   * @param {Array<any>} items 見出し（手がかりの語つき）
   * @param {{minOutlets: number, pairThreshold: number}} opts 束ねるのに要る媒体の数と、スコアの下限
   * @returns {any} 話題ごとの束（媒体の数・語の散らばり・代表の語・見出し）
   */
  _clusterItems(items, { minOutlets, pairThreshold }) {
    const N = items.length;
    if (N === 0) return [];

    const df = new Map();
    for (const it of items) for (const t of it.terms) df.set(t, (df.get(t) || 0) + 1);
    const idf = (t) => Math.log(N / (df.get(t) || 1));

    // 媒体をまたぐ2本だけを見る（同じ媒体の続報どうしを束ねても読み比べにならない）。
    // スコアは後の判定でも引くので、表として持っておく
    const scoreOf = new Map(); // `${i}:${j}`（i<j）→ スコア
    const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
    const pairs = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (items[i].outlet === items[j].outlet) continue;
        let score = 0;
        let shared = 0;
        for (const t of items[i].terms) {
          if (items[j].terms.has(t)) { score += idf(t); shared += 1; }
        }
        // 語が1つ一致しただけの偶然を落とす
        if (shared >= 2 && score >= pairThreshold) {
          scoreOf.set(key(i, j), score);
          pairs.push({ i, j, score });
        }
      }
    }
    if (pairs.length === 0) return [];
    pairs.sort((a, b) => b.score - a.score);

    // スコアが一番高い2本を種にして、すでに入っている全部と閾値を超えるものだけを足していく
    const used = new Set();
    const rawClusters = [];
    for (const seed of pairs) {
      if (used.has(seed.i) || used.has(seed.j)) continue;
      const members = [seed.i, seed.j];
      const outletsIn = new Set([items[seed.i].outlet, items[seed.j].outlet]);
      for (let k = 0; k < N; k++) {
        if (used.has(k) || members.includes(k)) continue;
        // 同じ媒体からは1本だけにする（1社1見出しで読み比べる）
        if (outletsIn.has(items[k].outlet)) continue;
        if (members.every((m) => scoreOf.has(key(k, m)))) {
          members.push(k);
          outletsIn.add(items[k].outlet);
        }
      }
      if (outletsIn.size < minOutlets) continue;
      members.forEach((m) => used.add(m));

      // BUGFIX: 同じ出来事の残りを拾ってから次の種へ進む。しないと、各社が1日に何本も続報を出す大きな
      // 出来事で、同じ話題の束が2つ3つに分かれる。種の2本の両方と閾値を超えるものは、同じ出来事として
      // 使用済みにするだけにする（1社1見出しを崩さないため、並べはしない）
      for (let k = 0; k < N; k++) {
        if (used.has(k) || members.includes(k)) continue;
        if (scoreOf.has(key(k, seed.i)) && scoreOf.has(key(k, seed.j))) used.add(k);
      }
      rawClusters.push(members.map((m) => items[m]));
    }

    const clusters = [];
    for (const picked of rawClusters) {
      const union = new Set();
      for (const p of picked) for (const t of p.terms) union.add(t);
      // 全部の見出しに共通して出る語が、同じ出来事である根拠。理屈の上では共通が空になることもあるので、
      // ここで最後に確かめる
      const core = [...union].filter((t) => picked.every((p) => p.terms.has(t)));
      const coreWeight = core.reduce((s, t) => s + idf(t), 0);
      // 元の言葉に畳んでから、別々の言葉が2つ以上あるかで判定する（地名1つの一致で束ねないため。
      // _foldTermsToConcepts 参照）
      const concepts = _foldTermsToConcepts(core);
      if (concepts.length < 2 || coreWeight < pairThreshold) continue;

      // 語の散らばり＝各社がどれだけ違う言葉で書いているか。2社ずつの語の重なりの平均で測る。
      // BUGFIX: 全社に共通する語が全体に占める割合では測らない。媒体が6〜8社に増えると共通の語が2〜3個まで
      // 減り、どの話題でも同じ値に張り付いて見分けがつかなくなる
      let simSum = 0;
      let simCount = 0;
      for (let a = 0; a < picked.length; a++) {
        for (let b = a + 1; b < picked.length; b++) {
          let inter = 0;
          for (const t of picked[a].terms) if (picked[b].terms.has(t)) inter += 1;
          const uni = picked[a].terms.size + picked[b].terms.size - inter;
          if (uni > 0) { simSum += inter / uni; simCount += 1; }
        }
      }
      const divergence = simCount > 0 ? 1 - simSum / simCount : 0;

      clusters.push({
        outletCount: picked.length,
        divergence: Math.round(divergence * 1000) / 1000,
        // 何の話題かを表す代表の語（珍しい順）
        topicTerms: concepts.sort((a, b) => idf(b) - idf(a)).slice(0, 6),
        headlines: picked
          .sort((a, b) => a.outlet.localeCompare(b.outlet, 'ja'))
          .map((p) => ({ outlet: p.outlet, title: p.title, pubDate: p.pubDate })),
      });
    }

    // 報じた社が多い順、次に書き方が割れている順。2社だけの珍しい話題より、各社がそろって報じた中の差の方が
    // 読み比べとして意味があるため
    clusters.sort((a, b) => (b.outletCount - a.outletCount) || (b.divergence - a.divergence));
    return clusters;
  }

}

module.exports = MediaCompareService;
module.exports.DEFAULT_OUTLETS = DEFAULT_OUTLETS;
