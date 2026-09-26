/**
 * @file 金融・マーケットの情報の取得（相場・投資信託の基準価額・国債利回り・経済ニュース）
 *
 * config.finance_watchlist に載っている指数・為替・債券・商品・個別株・個人の保有分の値を取り、市場の開閉
 * （market-calendar.js）・日本国債の利回り（財務省の CSV）・経済ニュース（Yahoo!ニュースの経済の RSS、
 * 必要なら海外の CNBC）と合わせて、プロンプトへそのまま入れられる文章にする。
 *
 * - 相場: Yahoo Finance の API（無料）。投資信託は証券コードが無いので、Yahoo!ファイナンス日本版の
 *   投信のページから基準価額を読む。
 * - 放送の金融コーナー・ティッカー・デイリーノート・週次レポート・Secretary の会話・secretary-loop.js の
 *   相場急変の検知が使う。this.cache は Live の AgentSystem などが直接読むので public にしている
 *   （{ data, lastFetch, structured, businessNewsItems, globalNewsItems, fetchedWithDescriptions,
 *   fetchedWithGlobalNews }）。
 *
 * キャッシュは「毎朝7時」を区切りにし、その日は同じ値を使い回す（DAILY_ANCHOR_HOUR）。
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
const marketCalendar = require('./market-calendar');
const path = require('path');
const { readJsonFile, writeJsonFile } = require('../lib/json-file-store');

/**
 * 最後に取れた投資信託の基準価額の控え。
 *
 * ATTENTION: 取得先（Yahoo!ファイナンス）は祝日や夜間に止まることがあり、実際に秋分の日に
 * HTTP 500 が返って投資信託24件が丸ごと欠けた。取れなかった回に黙って銘柄を落とすと、資産の
 * 合計が数百万円単位で減って見える。前回取れた値へ落とし、いつ時点の値かを添えて出す。
 */
const LAST_FUND_QUOTES_PATH = path.join(__dirname, '..', 'data', 'finance-last-fund-quotes.json');
const LAST_FUND_QUOTES_LOG = '[Finance]';

// キャッシュの区切りにする時刻（毎朝7時）。デイトレードはしないので、日中に何度も取り直さず、
// 7時に確定した値をその日1日使い回す。7時には、米国市場の終値（日本時間の5〜6時に確定）と
// 投資信託の基準価額（前日の夜に算出され、翌朝6時ごろまでに確定表示）がそろっている。
// サーバーのローカル時刻が日本時間であることが前提（secretary-loop.js の各トリガーと同じ）。
// ATTENTION: デイリーノートは7時30分に作る（secretary-loop.js の DAILY_NOTE_TRIGGER_HOUR）。
// この締めを後ろへ動かすと、ノートに前日の値が書かれる。
const DAILY_ANCHOR_HOUR = 7;
/**
 * 今有効な区切りの時刻（今日の7時。7時より前なら前日の7時）を返す。
 *
 * @param {Date} [now] 今の時刻
 * @returns {number} 区切りの時刻（ミリ秒）
 */
function _currentAnchorTime(now = new Date()) {
  const anchor = new Date(now);
  anchor.setHours(DAILY_ANCHOR_HOUR, 0, 0, 0);
  if (now < anchor) anchor.setDate(anchor.getDate() - 1); // 今日の7時前はまだ前日のアンカーが有効
  return anchor.getTime();
}

/** 金融・マーケットの情報を取得・キャッシュするサービス。 */
class FinanceService {
  constructor() {
    /** @type {Record<string, any>} */
    this.cache = { data: null, lastFetch: 0, structured: [] };
  }

  /**
   * キャッシュを空にする。
   *
   * @returns {void}
   */
  clear() {
    /** @type {Record<string, any>} */
    this.cache = { data: null, lastFetch: 0, structured: [] };
  }

  /**
   * 海外の経済・マーケットのニュース（CNBC の Economy と Finance）を取る。
   *
   * 持っている資産は海外の比率が高く、国内の値動きより海外の動き（米国の CPI・FRB の発表など）の方が
   * 大事なので、Yahoo!ニュースの経済の RSS とは別枠で取る。2つのフィードを交互に混ぜて偏らないようにする。
   * fetch の includeGlobalNews を指定したとき（デイリーノート）だけ使い、放送のコーナーには影響させない。
   *
   * @param {{perFeed?: number}} [opts] フィード1つあたりの件数（既定5）
   * @returns {Promise<Array<{title: string, link: string, desc: string, source: string}>>} ニュース
   */
  async _fetchGlobalMarketNews({ perFeed = 5 } = {}) {
    const FEEDS = [
      { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', source: 'CNBC Economy' },
      { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', source: 'CNBC Finance' },
    ];
    const decode = (t) => t
      .replace(/&apos;|&#x27;|&#39;/g, "'").replace(/&quot;|&#34;/g, '"')
      .replace(/&#x2019;|&#8217;/g, '\u2019').replace(/&#x201[cd];/g, '"')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const per = await Promise.allSettled(FEEDS.map(async ({ url, source }) => {
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
          const title = decode(tm[1]);
          let desc = dm ? decode(dm[1].replace(/<[^>]+>/g, '')) : '';
          if (desc === title) desc = '';
          out.push({ title, link: lm ? lm[1].trim() : '', desc, source });
        }
        return out;
      } finally { clearTimeout(timer); }
    }));

    // 交互に混ぜる（片方のフィードだけで埋まらないように）
    const lists = per.map(r => (r.status === 'fulfilled' ? r.value : []));
    const merged = [];
    for (let i = 0; i < perFeed; i++) for (const l of lists) if (l[i]) merged.push(l[i]);
    const failed = per.filter(r => r.status === 'rejected').length;
    if (failed) getLogger().warn(`[Finance] 海外ニュースの取得に一部失敗: ${failed}/${FEEDS.length}件のフィード`);
    getLogger().info(`[Finance] 海外マーケットニュース: ${merged.length}件`);
    return merged;
  }

  /**
   * 投資信託の基準価額を、Yahoo!ファイナンス日本版の投信のページから読む。
   *
   * 投資信託は上場しておらず証券コードも無いので、ファンドコード（投資信託協会が付ける8桁の英数字）で
   * ページを開く。ページはサーバー側で描かれた静的な HTML なので、そのまま読める。
   * class 名（例: StyledNumber__value__zj25）は、ビルドで末尾の文字が変わりうるので前方一致で拾う。
   * PriceBoard__priceInfo より後に、基準価額・前日比（額）・前日比（%）の順で数字が並ぶ。
   *
   * @param {string} fundCode ファンドコード
   * @returns {Promise<{price: number, prev: number, diff: number, pct: number,
   *   stale: boolean, asOf: string|null}|null>} 基準価額と前日比。stale は前回の控えへ落ちたか
   *   （そのときの asOf は控えを取った日時）。控えも無ければ null
   */
  async _fetchFundQuote(fundCode) {
    const fresh = await this._fetchFundQuoteLive(fundCode);
    if (fresh) {
      const store = readJsonFile(LAST_FUND_QUOTES_PATH, {}, LAST_FUND_QUOTES_LOG);
      store[fundCode] = { ...fresh, savedAt: new Date().toISOString() };
      writeJsonFile(LAST_FUND_QUOTES_PATH, store, LAST_FUND_QUOTES_LOG);
      return { ...fresh, stale: false, asOf: null };
    }
    // 取れなかったときは、前回取れた値へ落とす（祝日・メンテナンスで止まることがある）
    const saved = readJsonFile(LAST_FUND_QUOTES_PATH, {}, LAST_FUND_QUOTES_LOG)[fundCode];
    if (!saved) return null;
    getLogger().debug(`[Finance] 投資信託 ${fundCode}: 取得できないため ${saved.savedAt} 時点の値を使います`);
    return { price: saved.price, prev: saved.prev, diff: saved.diff, pct: saved.pct,
      stale: true, asOf: saved.savedAt };
  }

  /**
   * 投資信託の基準価額を、その場で取りに行く（控えは見ない）。
   * @param {string} fundCode Yahoo!ファイナンスのコード（例: 9C311125）
   * @returns {Promise<{price:number, prev:number, diff:number, pct:number}|null>} 取れなければ null
   */
  async _fetchFundQuoteLive(fundCode) {
    const url = `https://finance.yahoo.co.jp/quote/${encodeURIComponent(fundCode)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } });
    if (!res.ok) return null;
    const html = await res.text();
    const idx = html.indexOf('PriceBoard__priceInfo');
    if (idx === -1) return null;
    const window = html.slice(idx, idx + 1200);
    const values = [...window.matchAll(/StyledNumber__value[^"]*">([+-]?[0-9,]+(?:\.[0-9]+)?)</g)]
      .map((m) => Number(m[1].replace(/,/g, '')));
    if (values.length < 3 || !Number.isFinite(values[0])) return null;
    const [price, diff, pct] = values;
    return { price, prev: price - diff, diff, pct };
  }

  /**
   * 相場と関連の情報を取り、プロンプトへ入れる文章にして返す（7時の区切りまではキャッシュを使う）。
   *
   * - fetchArticleDescriptions: 経済ニュースの説明文を、記事ページを1件ずつ取って補う（RSS に説明文が
   *   無いため）。デイリーノートが使う。放送のコーナーは渡さないので、余計な HTTP リクエストは起きない。
   * - includeGlobalNews: 海外のマーケットのニュースも取る（デイリーノート用）。
   *
   * BUGFIX: キャッシュを使うかの判定は、説明文の有無だけでなく海外のニュースの有無も見ること。
   * 見ていなかったころ、海外のニュース無しで作られたキャッシュが有効な間に海外のニュースありで
   * 呼ぶと、取りに行かないまま前のもの（無ければ空）を返していた。
   *
   * @param {Record<string, any>} config 設定全体（finance_watchlist を使う）
   * @param {{fetchArticleDescriptions?: boolean, includeGlobalNews?: boolean}} [opts] 取得のオプション
   * @returns {Promise<string|null>} マーケット情報の文章（すべて失敗したら前回の文章か null）
   */
  async fetch(config, { fetchArticleDescriptions = false, includeGlobalNews = false } = {}) {
    // BUGFIX: 説明文を求める呼び出しには、説明文付きで作ったキャッシュだけを返す。以前は、先に説明文なしで
    // 作られたキャッシュをそのまま返し、デイリーノートの経済ニュースの説明が欠けていた。
    // 逆（説明文付きのキャッシュを、説明文の要らない呼び出しへ返す）はかまわない。説明文は data の本文には
    // 入れず businessNewsItems にだけ持たせるので、返す文章はどちらでも同じになる。
    // 海外のニュースも同じ考え方。海外のニュースを求める呼び出しには、それを持っているキャッシュだけを返す。
    const cacheHasDescriptions = this.cache.fetchedWithDescriptions === true;
    const cacheHasGlobalNews   = this.cache.fetchedWithGlobalNews === true;
    if (this.cache.data && this.cache.lastFetch >= _currentAnchorTime()
        && (!fetchArticleDescriptions || cacheHasDescriptions)
        && (!includeGlobalNews || cacheHasGlobalNews)) {
      return this.cache.data;
    }

    // 取りに行く銘柄: config.finance_watchlist の有効なもの
    const wl = (config?.finance_watchlist) || {};
    const buildTargets = (items, typeOverride) =>
      (items || []).filter(i => i.enabled).map(i => ({
        key: i.name, symbol: i.symbol, unit: i.unit,
        type: typeOverride || i.type, dec: i.dec ?? 2,
      }));
    // 個人の保有分のうち株式は、仕組みは個別株と同じ（証券コード・ティッカーを持つ）なので、
    // type: 'personal' として同じ取得の流れに入れる。投資信託はティッカーが無いので入れず、
    // _fetchFundQuote で別に取る。
    const personalStockHoldings = (wl.personal_holdings || []).filter(i => i.kind === 'stock');
    const personalFundHoldings  = (wl.personal_holdings || []).filter(i => i.enabled && i.kind === 'fund' && i.fund_code);
    const TARGETS = [
      ...buildTargets(wl.indices,     null),
      ...buildTargets(wl.forex,       'fx'),
      ...buildTargets(wl.bonds,       'bond'),
      ...buildTargets(wl.commodities, 'commodity'),
      ...buildTargets(wl.stocks,      'stock'),
      // 個人の保有分には kind も持たせる。secretary-loop.js の相場急変の検知が、株式と投資信託で
      // しきい値を分けるのに使う。
      ...buildTargets(personalStockHoldings, 'personal').map(t => ({ ...t, kind: 'stock' })),
    ];
    // ウォッチリストが空のときの代わり（古い設定との互換）
    if (TARGETS.length === 0) {
      TARGETS.push(
        { key: '日経平均', symbol: '^N225',    unit: '円',   type: 'jp', dec: 0 },
        { key: 'NYダウ',   symbol: '^DJI',     unit: 'ドル', type: 'us', dec: 0 },
        { key: 'ドル円',   symbol: 'USDJPY=X', unit: '円',   type: 'fx', dec: 2 },
      );
    }

    try {
      const fetched = await Promise.all(
        TARGETS.map(async (t) => {
          try {
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/` +
              `${encodeURIComponent(t.symbol)}?interval=1d&range=2d&includePrePost=false`;
            const res = await fetch(url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept':     'application/json',
              }
            });
            if (!res.ok) return { ...t, ok: false };
            const json = await res.json();
            const meta = json?.chart?.result?.[0]?.meta;
            if (!meta || !meta.regularMarketPrice) return { ...t, ok: false };

            const price = meta.regularMarketPrice;
            const prev  = meta.previousClose ?? meta.chartPreviousClose ?? price;
            const diff  = price - prev;
            const pct   = prev ? (diff / prev) * 100 : 0;

            // ── 価格のラベル（いつの値か）─────────────────────────────────
            // BUGFIX: 最終取引の時刻は、日本の暦日ではなく取引所のタイムゾーン（meta.exchangeTimezoneName）で
            // 解釈し、実際に取引があったセッションの日付と曜日をラベルにする。日本の暦日にしていたころは、
            // ニューヨークの引け（日本時間の翌朝5時）のせいで米国の銘柄に必ず1日後の日付が付き、放送でも
            // その日付で読み上げていた。
            const exchangeTz = meta.exchangeTimezoneName || 'Asia/Tokyo';
            const tradeUnix = meta.regularMarketTime * 1000; // ms
            const tradeAt = new Date(tradeUnix);
            const sessionDate = marketCalendar.localDateOf(tradeAt, exchangeTz);
            const japanToday = marketCalendar.localDateOf(new Date(), 'Asia/Tokyo');

            let priceLabel;
            if (!meta.regularMarketTime) {
              priceLabel = '時刻不明';
            } else if (sessionDate === japanToday) {
              // 日本の暦で「本日」のセッション。最終取引から60分を超えていれば終値として扱う
              const ageMin = (Date.now() - tradeUnix) / 60000;
              priceLabel = ageMin < 60
                ? '現在値'
                : `本日 ${marketCalendar.localTimeOf(tradeAt, exchangeTz)} 終値`;
            } else {
              // 別の日のセッション。取引所の現地の日付でそのまま示す
              const ageMin = (Date.now() - tradeUnix) / 60000;
              priceLabel = ageMin < 60
                ? '現在値'
                : `${marketCalendar.formatDateShortJa(sessionDate)} 終値`;
            }

            return { ...t, ok: true, price, prev, diff, pct, priceLabel };
          } catch {
            return { ...t, ok: false };
          }
        })
      );

      // 投資信託は _fetchFundQuote で別に取り、ほかの結果と同じ形にそろえて fmt をそのまま使えるようにする
      const fundFetched = await Promise.all(
        personalFundHoldings.map(async (f) => {
          try {
            const q = await this._fetchFundQuote(f.fund_code);
            if (!q) return { key: f.name, ok: false };
            return {
              key: f.name, unit: f.unit, type: 'personal', kind: 'fund', dec: f.dec ?? 0,
              ok: true, price: q.price, prev: q.prev, diff: q.diff, pct: q.pct,
              priceLabel: '基準価額', stale: !!q.stale, asOf: q.asOf || null,
            };
          } catch {
            return { key: f.name, ok: false };
          }
        })
      );

      const ok = fetched.filter(r => r.ok).concat(fundFetched.filter(r => r.ok));
      if (ok.length === 0) throw new Error('All finance symbols failed');

      // 1銘柄を1行にする。
      // ATTENTION: LLM が前日比を自分で計算しないよう、前日終値と上がったか下がったかを文字で書き、
      // その前日比をそのまま使うよう指示を付ける（計算させると学習データの古い値が混ざる）。
      const fmt = (r) => {
        const p    = r.price.toFixed(r.dec);
        const prev = (r.prev ?? r.price).toFixed(r.dec);
        const d    = (r.diff >= 0 ? '+' : '') + r.diff.toFixed(r.dec);
        const pStr = (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) + '%';
        const dir  = r.diff > 0.0001 ? '上昇' : r.diff < -0.0001 ? '下落' : '変わらず';
        // 取得できずに前回の値へ落ちた銘柄は、本日の値と取り違えられないよう必ず明示する
        const staleNote = r.stale
          ? `【本日は取得できず、${String(r.asOf || '').slice(0, 10)}時点の値です・本日の値動きとして話さないこと】`
          : '';
        return `  ${r.key}: ${Number(p).toLocaleString('ja-JP')}${r.unit} [${r.priceLabel}] ` +
               `前日終値:${Number(prev).toLocaleString('ja-JP')}${r.unit} ` +
               `→前日比:${dir}${d}（${pStr}）【この前日比を必ずそのまま使うこと・自分で計算禁止】${staleNote}`;
      };

      const jp        = ok.filter(r => r.type === 'jp');
      const us        = ok.filter(r => r.type === 'us');
      const fx        = ok.filter(r => r.type === 'fx');
      const bonds     = ok.filter(r => r.type === 'bond');
      const commodity = ok.filter(r => r.type === 'commodity');
      const stocks    = ok.filter(r => r.type === 'stock');
      const personal  = ok.filter(r => r.type === 'personal');

      const now = new Date();
      const ts  = `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;
      // 市場の開閉は、取得元のここで1回だけ付ける。放送の金融コーナー・デイリーノート・週次レポート・
      // Secretary の会話・consult_agent はどれもこの文章を材料にしているので、呼び出し側ごとに付けなくても
      // すべてに行き渡る。
      let result = `【マーケット情報】データ取得 ${ts}\n`
        + `${marketCalendar.describeMarkets(new Date())}`;
      if (jp.length)        result += `\n■ 国内株式\n`    + jp.map(fmt).join('\n');
      if (us.length)        result += `\n■ 米国・海外株式\n` + us.map(fmt).join('\n');
      if (fx.length)        result += `\n■ 為替\n`         + fx.map(fmt).join('\n');
      if (bonds.length)     result += `\n■ 債券\n`         + bonds.map(fmt).join('\n');
      if (commodity.length) result += `\n■ コモディティ\n` + commodity.map(fmt).join('\n');
      if (stocks.length)    result += `\n■ 個別株\n`       + stocks.map(fmt).join('\n');
      // リスナー自身が持っているファンド・株式は、いつも最後の独立した欄に出す
      if (personal.length)  result += `\n■ 個人所有ファンド・株式\n` + personal.map(fmt).join('\n');

      // ── 日本国債利回り（財務省CSVから日次取得）──────────────────────────────
      try {
        const mofRes = await fetch(
          'https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv',
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } }
        );
        if (mofRes.ok) {
          const csvText = await mofRes.text();
          // 末尾から有効なデータ行を探す（空行・ヘッダーをスキップ）
          const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
          const dataLine = [...lines].reverse().find(l => /^[RSH]\d/.test(l)); // 令和/昭和/平成
          if (dataLine) {
            const cols = dataLine.split(',');
            // 列順: 0=日付, 1=1年, 2=2年, 3=3年, 4=4年, 5=5年, ... 10=10年
            const y3  = parseFloat(cols[3]);
            const y5  = parseFloat(cols[5]);
            const y10 = parseFloat(cols[10]);
            const y20 = parseFloat(cols[12]);
            const jgbLines = [];
            if (!isNaN(y3))  jgbLines.push(`  日本国債3年利回り: ${y3.toFixed(3)}%`);
            if (!isNaN(y5))  jgbLines.push(`  日本国債5年利回り: ${y5.toFixed(3)}%`);
            if (!isNaN(y10)) jgbLines.push(`  日本国債10年利回り: ${y10.toFixed(3)}%`);
            if (!isNaN(y20)) jgbLines.push(`  日本国債20年利回り: ${y20.toFixed(3)}%`);
            if (jgbLines.length > 0) {
              result += `\n■ 日本国債利回り（財務省・日次）\n` + jgbLines.join('\n');
              getLogger().info(`[Finance] JGB利回り取得: 3Y=${y3} 5Y=${y5} 10Y=${y10}`);
            }
          }
        }
      } catch (jgbErr) {
        getLogger().warn('[Finance] JGB利回り取得失敗:', jgbErr.message);
      }

      // ── 経済・マーケットニュース（Yahoo Japan 経済RSS）──
      let businessNewsItems = [];
      try {
        const newsRes = await fetch(
          'https://news.yahoo.co.jp/rss/topics/business.xml',
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } }
        );
        if (newsRes.ok) {
          const xml = await newsRes.text();
          const itemRegex = /<item>([\s\S]*?)<\/item>/g;
          const headlines = [];
          let m;
          while ((m = itemRegex.exec(xml)) !== null && headlines.length < 6) {
            const titleMatch = m[1].match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/)
                            || m[1].match(/<title>([^<]+)<\/title>/);
            const linkMatch = m[1].match(/<link>([^<]+)<\/link>/);
            // 説明文も取る。放送用の result には入れず、businessNewsItems（デイリーノート用）にだけ持たせる。
            const descMatch = m[1].match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)
                            || m[1].match(/<description>([^<]*)<\/description>/);
            let desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .trim() : '';
            if (titleMatch && desc === titleMatch[1].trim()) desc = ''; // タイトルと同じなら不要
            // 説明文は切り詰めない（途中で切れると内容が分からないため）。デイリーノートにだけ使い、放送用の
            // result には入らないので、長くても放送のテンポには影響しない。
            if (titleMatch) {
              headlines.push({ title: titleMatch[1].trim(), link: linkMatch ? linkMatch[1].trim() : '', desc });
            }
          }
          // Yahoo!ニュースの経済の RSS には説明文が無いので、fetchArticleDescriptions のときは記事ページを
          // 取って補う（news-service.js と同じ）。更新するのは businessNewsItems の説明文だけ。
          if (fetchArticleDescriptions) {
            await Promise.all(headlines.map(async (h) => {
              if (h.desc || !h.link) return;
              try {
                const artRes = await fetch(h.link, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' } });
                if (!artRes.ok) return;
                const artHtml = await artRes.text();
                // BUGFIX: og:description は Yahoo! 側で約99字に切られているので、ページ内にある要約の全文を
                // 拾い直す（article-description.js 参照）。
                const d = extractArticleDescription(artHtml);
                if (d && d !== h.title) h.desc = d; // 切り詰めない（上のコメント参照）
              } catch (e) {
                getLogger().debug(`[Finance] 経済ニュース記事ページからの説明文取得失敗（${h.title}）: ${e.message}`);
              }
            }));
          }
          if (headlines.length > 0) {
            result += `\n■ 経済・マーケットニュース\n` +
              headlines.map((h, i) => `  ${i + 1}. ${h.title}`).join('\n');
          }
          // 放送用の result は書式を変えず、デイリーノートで出典のリンクを付けるための完全な形は別に持つ
          // （news-service.js の detailedItems と同じ考え方）
          businessNewsItems = headlines;
        }
      } catch (newsErr) {
        getLogger().warn('[Finance] Business news fetch failed:', newsErr.message);
        // ニュース取得失敗でも相場データは返す
      }

      // 海外のマーケットのニュース（デイリーノート専用。_fetchGlobalMarketNews 参照）
      // 求められなかった回は前のキャッシュから引き継ぐので、引き継いだ分も「持っている」と数える。
      const hadGlobalNews = this.cache.fetchedWithGlobalNews === true;
      const globalNewsItems = includeGlobalNews
        ? await this._fetchGlobalMarketNews().catch(() => [])
        : (this.cache.globalNewsItems || []);

      this.cache = {
        data:       result,
        lastFetch:  Date.now(),
        structured: ok.map(r => ({
          key:        r.key,
          price:      r.price,
          diff:       r.diff,
          pct:        r.pct,
          unit:       r.unit,
          type:       r.type,
          kind:       r.kind, // 個人所有分のみ 'fund' | 'stock'（secretary-loop.jsの閾値分岐用）
          dec:        r.dec,
          priceLabel: r.priceLabel,
          // 取得できずに前回の値へ落ちたか（デイリーノートの損益の表が、本日の損益として数えないために見る）
          stale:      !!r.stale,
          asOf:       r.asOf || null,
        })),
        businessNewsItems,
        globalNewsItems,
        // このキャッシュが説明文付き・海外のニュース付きで作られたか（上のキャッシュの判定で使う）
        fetchedWithDescriptions: fetchArticleDescriptions,
        fetchedWithGlobalNews:   includeGlobalNews || hadGlobalNews,
      };
      return result;

    } catch (e) {
      getLogger().error('[Finance] fetchFinanceData error:', e.message);
      return this.cache.data || null;
    }
  }
}

module.exports = FinanceService;
