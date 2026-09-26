/**
 * @file Gmail の未読の取得・本文の抜粋・除外した件数・下書きの作成（GoogleService に取り込むメソッド群）
 *
 * google-service.js が Object.assign(GoogleService.prototype, ...) で取り込む。認証（_getAccessToken）と
 * トークンのキャッシュは google-service.js が持ち、各メソッドは this を通して呼ぶ。
 * 利用元は秘書のメールのツール、自律ループ（secretary-loop.js）、Live のオープニングの読み上げ。
 *
 * ATTENTION: メールを送る機能は用意しない。作るのは下書きまでで、送信は必ず本人が Gmail で確かめて行う。
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

// 要約の材料にする本文の抜粋の長さ。
// BUGFIX: Gmail の snippet（本文の冒頭の自動プレビュー、100文字ほど）だけでは、定型の前置きで埋まって
//         日時や場所に届かず、LLM が無い内容を作ってしまった。本文を取り出して渡す。
// BUGFIX: text/html を優先する（タグは除く）。HTML のメルマガの text/plain は「画像が表示されない場合は」
//         のような定型の案内だけのことがある。text/plain しか無いメールではそちらを使う。
const BODY_EXCERPT_MAX_CHARS = 800;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * エポックのミリ秒（Gmail の internalDate など）を、日本時間の「M月D日(曜) HH:MM」にする。
 * @param {number|string} epochMs
 * @returns {string}
 */
function _formatJstDateLabel(epochMs) {
  const jst = new Date(Number(epochMs) + JST_OFFSET_MS);
  const month = jst.getUTCMonth() + 1;
  const date = jst.getUTCDate();
  const dow = DOW_JA[jst.getUTCDay()];
  const timeStr = `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
  return `${month}月${date}日(${dow}) ${timeStr}`;
}

/**
 * URL 用の Base64 を UTF-8 の文字列に戻す。
 * @param {string} data
 * @returns {string} 失敗したら空文字
 */
function _decodeBase64Url(data) {
  try { return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'); }
  catch { return ''; }
}

/**
 * MIME のパートをたどり、指定した種類の本文を返す。
 * @param {Record<string, any>} part
 * @param {string} mimeType
 * @returns {string|null} 無ければ null
 */
function _findMimePart(part, mimeType) {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return _decodeBase64Url(part.body.data);
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      const found = _findMimePart(p, mimeType);
      if (found) return found;
    }
  }
  return null;
}

/**
 * メッセージの payload から、本文のテキストの抜粋（先頭の BODY_EXCERPT_MAX_CHARS 文字）を取り出す。
 * @param {Record<string, any>} payload
 * @returns {string}
 */
function extractBodyExcerpt(payload) {
  if (!payload) return '';
  let text = null;
  const html = _findMimePart(payload, 'text/html');
  if (html) {
    text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }
  if (!text) text = _findMimePart(payload, 'text/plain');
  if (!text && payload.body?.data) text = _decodeBase64Url(payload.body.data); // パートに分かれていないメール
  return (text || '')
    // Gmail の「メッセージの続きを表示」の切り詰めを避けるため、ソフトハイフン・ゼロ幅の文字・結合文字・特殊な
    // 空白を大量に埋め込む配信ツールがあり、抜粋の大半がそれで埋まる。取り除く（全角スペースは普通の文章でも
    // 使うので除かない）
    .replace(/[\u00AD\u200B-\u200D\uFEFF\u034F\u2000-\u200A\u202F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    // HTML のメールはレイアウト用の空行や行頭の空白が大量に残り、抜粋の大半を占めることがあるので詰める
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n')
    .trim()
    .slice(0, BODY_EXCERPT_MAX_CHARS);
}

/** GoogleService に取り込む Gmail のメソッド */
const gmailMethods = {
  /**
   * 直近24時間の未読メールを、件名・差出人・受信時刻・本文の抜粋と一緒に取得する。
   * filter は Live のオープニングの読み上げと同じ config.show.gmail_filter をそのまま渡せる形
   * （exclude_promotions・exclude_social・exclude_updates・exclude_forums・max_fetch）。
   * @param {Record<string, any>} creds 認証情報
   * @param {{ maxFetch?: number, filter?: Record<string, any> }} [opts]
   * @returns {Promise<Array<Record<string, any>>>} 新しい順
   */
  async fetchEmails(creds, { maxFetch = 15, filter = {} } = {}) {
    const accessToken = await this._getAccessToken(creds);
    const sinceSec = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const queryParts = [`after:${sinceSec}`, 'is:unread', '-category:spam', '-in:trash'];
    if (filter.exclude_promotions) queryParts.push('-category:promotions');
    if (filter.exclude_social)     queryParts.push('-category:social');
    if (filter.exclude_updates)    queryParts.push('-category:updates');
    if (filter.exclude_forums)     queryParts.push('-category:forums');
    const query = queryParts.join(' ');
    const effectiveMaxFetch = filter.max_fetch || maxFetch;
    const listRes = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${effectiveMaxFetch}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) throw new Error(`Gmail API HTTP ${listRes.status}`);
    const listData = await listRes.json();
    const messages = listData.messages || [];
    return this._fetchMessageDetails(accessToken, messages.map(m => m.id));
  },

  /**
   * 指定したメッセージの詳細だけを取得する。自律ループは未読の ID の差分を見ているので、新着の分だけ取れば済む。
   *
   * @param {Record<string, any>} creds 認証情報
   * @param {string[]} ids 取得したいメッセージの ID
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async fetchEmailDetailsByIds(creds, ids) {
    if (!ids || ids.length === 0) return [];
    const accessToken = await this._getAccessToken(creds);
    return this._fetchMessageDetails(accessToken, ids);
  },

  /**
   * メッセージの ID の並びから詳細を取り出す。
   * 並列に取る（1件ずつだと20件で7秒ほどかかった）。同時に取る数を絞るのは、Gmail API のレート制限（429）に
   * 当たらないため。
   * ATTENTION: 返す順は ids の順のままにする（呼び出し側が新しい順を前提にしている）。
   * @param {string} accessToken
   * @param {string[]} ids
   * @returns {Promise<Array<Record<string, any>>>} 取れなかったものは除く
   */
  async _fetchMessageDetails(accessToken, ids) {
    const CONCURRENCY = 5;
    const out = new Array(ids.length).fill(null);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= ids.length) return;
        const id = ids[i];
        try {
          // 本文も渡すため format=full で取る（format=metadata では snippet しか材料が無い）
          const detailRes = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!detailRes.ok) continue;
          const detail = await detailRes.json();
          const headers = detail.payload?.headers || [];
          const subject = headers.find(h => h.name === 'Subject')?.value || '無題';
          const from = headers.find(h => h.name === 'From')?.value || '';
          const fromName = from.replace(/<[^>]+>/, '').trim() || from.replace(/.*@/, '@').replace(/>.*/, '');
          // BUGFIX: 差出人のアドレスと受信時刻も持つ。表示名しか持たず、「いつ届いたの？」「送信元のアドレスは？」に
          //         答えられなかった。受信時刻は internalDate（Gmail が受け取った時刻。送る側が偽れる Date ヘッダーより
          //         確か）を使う。
          const fromAddressMatch = from.match(/<([^>]+)>/);
          const fromAddress = fromAddressMatch ? fromAddressMatch[1] : from.trim();
          const receivedAt = detail.internalDate ? _formatJstDateLabel(detail.internalDate) : '';
          const snippet = detail.snippet || '';
          // 本文を取り出せないとき（暗号化されたメール・特殊な形式など）は snippet を使う
          const body = extractBodyExcerpt(detail.payload) || snippet;
          out[i] = { id, subject, from: fromName, fromAddress, receivedAt, snippet, body };
        } catch (e) {
          getLogger().warn(`[Gmail] メッセージ詳細の取得に失敗（この1件をスキップ）: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return out.filter(Boolean);
  },

  /**
   * フィルタで除いたメールが何件あったかを、カテゴリごとに数える。
   *
   * 除くこと自体は正しいが、存在ごと見えないと取りこぼしに気づけないので、件数だけは知らせる。
   * 一覧の API だけで数えるので軽い。除く設定がオンのカテゴリだけを数える。
   *
   * @param {Record<string, any>} creds 認証情報
   * @param {{ filter?: Record<string, any> }} [opts]
   * @returns {Promise<{counts: Record<string, number>, total: number, capped?: boolean}>}
   *   capped は上限を超えたカテゴリがあったか（「N件以上」と分かるように）。失敗しても投げず、0件として返す
   */
  async countExcludedEmails(creds, { filter = {} } = {}) {
    const targets = [];
    if (filter.exclude_promotions) targets.push(['promotions', 'プロモーション']);
    if (filter.exclude_social)     targets.push(['social', 'ソーシャル']);
    if (filter.exclude_updates)    targets.push(['updates', '新着']);
    if (filter.exclude_forums)     targets.push(['forums', 'フォーラム']);
    if (targets.length === 0) return { counts: {}, total: 0 };

    try {
      const accessToken = await this._getAccessToken(creds);
      const sinceSec = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      // 数えるだけなので上限は大きめにし、超えたら「N件以上」と分かるようにする
      const LIMIT = 100;
      const results = await Promise.allSettled(targets.map(async ([cat, label]) => {
        const q = `after:${sinceSec} is:unread -in:trash category:${cat}`;
        const res = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${LIMIT}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return [label, (data.messages || []).length, !!data.nextPageToken];
      }));
      const counts = {};
      let total = 0;
      let capped = false;
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const [label, n, more] = r.value;
        if (n > 0) counts[label] = n;
        total += n;
        if (more) capped = true;
      }
      return { counts, total, capped };
    } catch (e) {
      getLogger().warn(`[Gmail] 除外件数の集計に失敗（無視して続行）: ${e.message}`);
      return { counts: {}, total: 0 };
    }
  },

  /**
   * 未読のメールの ID だけを返す（自律ループ用の軽い版）。
   * fetchEmails は1件ごとに詳細を取るので、頻繁な定期チェックには重い。こちらは一覧の API を1回呼ぶだけ。
   * @param {Record<string, any>} creds 認証情報
   * @param {{ maxFetch?: number, filter?: Record<string, any> }} [opts]
   * @returns {Promise<string[]>}
   */
  async fetchUnreadIds(creds, { maxFetch = 15, filter = {} } = {}) {
    const accessToken = await this._getAccessToken(creds);
    const sinceSec = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const queryParts = [`after:${sinceSec}`, 'is:unread', '-category:spam', '-in:trash'];
    if (filter.exclude_promotions) queryParts.push('-category:promotions');
    if (filter.exclude_social)     queryParts.push('-category:social');
    if (filter.exclude_updates)    queryParts.push('-category:updates');
    if (filter.exclude_forums)     queryParts.push('-category:forums');
    const query = queryParts.join(' ');
    const effectiveMaxFetch = filter.max_fetch || maxFetch;
    const listRes = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${effectiveMaxFetch}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) throw new Error(`Gmail API HTTP ${listRes.status}`);
    const listData = await listRes.json();
    return (listData.messages || []).map(m => m.id);
  },

  /**
   * Gmail の下書きを作る（送信はしない）。
   * @param {Record<string, any>} creds 認証情報
   * @param {{ to: string, subject: string, body: string }} draft
   * @returns {Promise<Record<string, any>>} Gmail が返した下書き
   */
  async createEmailDraft(creds, { to, subject, body }) {
    const accessToken = await this._getAccessToken(creds);
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
    ].join('\r\n');
    // Gmail は URL 用の Base64（+ と / を - と _ にし、末尾の = は付けない）を求める
    const raw = Buffer.from(mime, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) throw new Error(`Gmail API(下書き作成) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },
};

module.exports = { gmailMethods };
