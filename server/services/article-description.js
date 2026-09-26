/**
 * @file Yahoo!ニュースの記事ページから、記事の要約文を全文で取り出す
 *
 * 記事ページの og:description は Yahoo! 側で約99文字で打ち切られていて、しかも末尾に「…」が付かない。
 * 一方、同じページの本文には要約の全文が <p> として入っている。そこで og:description の書き出しを
 * 目印（アンカー）にして、その書き出しを含む <p> のうち最も長いものを全文として使う。
 * <p> の側にはコメント数（「62コメント62件」）などの前置きが付くことがあるので、目印より前は捨てる。
 *
 * og:description が元から切れていない記事では、<p> から得た文と一致するので結果は変わらない。
 * 全文が見つからない、または長すぎるときは og:description をそのまま使う。
 *
 * 主な利用元: services/news-service.js（一般ニュース）・services/finance-service.js（経済ニュース）
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

/**
 * 目印にする og:description の先頭の文字数。長すぎると表記の揺れで一致しなくなり、
 * 短すぎると無関係な段落に偶然一致する（実データで確かめて25文字にした）。
 */
const ANCHOR_LENGTH = 25;
/**
 * <p> から採る全文の上限。要約のつもりで記事の本文を丸ごと拾ってしまったときの保険
 * （実際の要約は130文字程度）。超えたら og:description に戻す。
 */
const MAX_FULL_TEXT_LENGTH = 1000;

/**
 * タグを除き、文字参照（&amp; など）を戻してテキストにする。
 * @param {string} html
 * @returns {string}
 */
function _toPlainText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * メタタグ（og:description、無ければ description）から要約文を取り出す。
 * @param {string} html
 * @returns {string} 無ければ空文字
 */
function _extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/)
         || html.match(/<meta[^>]+content="([^"]*)"[^>]+property="og:description"/)
         || html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)
         || html.match(/<meta[^>]+content="([^"]*)"[^>]+name="description"/);
  return m ? _toPlainText(m[1]) : '';
}

/**
 * 記事ページのHTMLから要約文を返す。取り出せなければ空文字。
 * @param {string} html 記事ページのHTML全文
 * @returns {string}
 */
function extractArticleDescription(html) {
  const meta = _extractMetaDescription(html);
  if (!meta) return '';

  const anchor = meta.slice(0, ANCHOR_LENGTH);
  if (!anchor) return meta;

  let best = '';
  for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = _toPlainText(m[1]);
    const at = text.indexOf(anchor);
    if (at === -1) continue;
    const candidate = text.slice(at);
    if (candidate.length > best.length) best = candidate;
  }

  if (best.length > meta.length && best.length <= MAX_FULL_TEXT_LENGTH) return best;
  return meta;
}

module.exports = { extractArticleDescription };
