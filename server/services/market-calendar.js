/**
 * @file 東京市場・米国市場が開いているか・休んでいるかの判定
 *
 * ある時点で東京市場（東証）と米国市場（NYSE・Nasdaq）が立会日か、いま取引中か、直近で終値が
 * 確定したのはいつか、次に開くのはいつかを求め、プロンプトやノートへそのまま入れられる日本語の
 * 事実にする（describeMarkets・describeMarketsForPrompt）。放送（agent-system.js など）・デイリーノート・
 * 週次レポート・Secretary の会話が使う。
 *
 * ATTENTION: 市場の開閉は LLM に判断させず、すべてここで決めてプロンプトへ事実として渡す。
 *
 * - 米国の休場日は「9月第1月曜」のように完全にルールで決まるので、外部 API を使わず計算する
 *   （取得に失敗して休場を見落とすことが無い）。
 * - 日本の祝日は政令で決まり機械的に導けない年があるので、holiday-service（holidays-jp）を使う。
 *   そのインスタンスはこのモジュールが持って公開し、agent-system.js も同じものを使う
 *   （祝日のキャッシュをプロセス内で1つにするため）。
 *
 * BUGFIX: 米国の休場日を知らなかったころは、レイバーデーに前の取引日の値を「本日の終値」として
 * 扱っていた。また日本の祝日を米国にも当てはめ、米国が開いている日に「日米とも休場」と言っていた。
 *
 * 同期で即答する（ネットワークを待たない）。
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

const HolidayService = require('./holiday-service');

/**
 * 日本の祝日のサービス（プロセス内で共有する）。refresh() は呼び出し側が随時、結果を待たずに呼ぶ。
 * @type {Record<string, any>}
 */
const holidayService = new HolidayService();

/** 市場ごとの設定（表示名・タイムゾーン・現地の取引時間）。 */
const MARKETS = {
  tokyo: {
    key: 'tokyo',
    label: '東京市場',
    timeZone: 'Asia/Tokyo',
    // 東証は2024-11-05から15:30終了（それ以前は15:00）。前場・後場の2部制。
    sessions: [['09:00', '11:30'], ['12:30', '15:30']],
  },
  us: {
    key: 'us',
    label: '米国市場',
    timeZone: 'America/New_York',
    sessions: [['09:30', '16:00']],
    // 感謝祭翌日など、13:00に早じまいする日。休場ではなく「短縮取引」。
    halfDaySessions: [['09:30', '13:00']],
  },
};

/** 曜日の日本語（0=日曜）。 */
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

// ── 現地時刻の取り出し ───────────────────────────────────────────────────────
// サーバーのタイムゾーンの設定に頼らず、米国の夏時間も Intl に解決させる
const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * ある時刻を、指定したタイムゾーンの現地の日付・曜日・時刻（0時からの分）に分ける。
 *
 * @param {Date} date 時刻
 * @param {string} timeZone IANA のタイムゾーン名
 * @returns {{dateStr: string, year: number, month: number, day: number, weekday: number, minutes: number}}
 *   現地の YYYY-MM-DD・年・月・日・曜日（0=日）・0時からの分
 */
function _localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    weekday: _WD[p.weekday],
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/**
 * 市場の現地の日時（YYYY-MM-DD と HH:MM）が、実際にはいつ（UTC）なのかを求める。
 * 「米国市場は日本時間の何時に開くか」を答えるために使う。夏時間の切り替えも Intl に解決させるため、
 * 推定と誤差の修正を数回くり返して合わせる。
 *
 * @param {string} dateStr 現地の日付（YYYY-MM-DD）
 * @param {string} hhmm 現地の時刻（HH:MM）
 * @param {string} timeZone IANA のタイムゾーン名
 * @returns {Date} 対応する時刻
 */
function _zonedToUtc(dateStr, hhmm, timeZone) {
  const { y, m, d } = _ymd(dateStr);
  const [H, M] = hhmm.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, H, M); // 目標の「現地の壁時計」
  let ts = target;
  for (let i = 0; i < 3; i += 1) {
    const p = _localParts(new Date(ts), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
    const drift = asUtc - target; // 現地の壁時計が目標からどれだけずれているか
    if (drift === 0) break;
    ts -= drift;
  }
  return new Date(ts);
}

/**
 * HH:MM を0時からの分にする。
 *
 * @param {string} hhmm 時刻
 * @returns {number} 0時からの分
 */
function _toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// 'YYYY-MM-DD' を暦の計算に使うための道具。タイムゾーンの影響を受けないよう UTC で扱う。
// _ymd は年月日へ分け、_fromUTC は Date を YYYY-MM-DD に戻し、_utc はその日の0時（UTC）を作る。
// _weekdayOf は曜日（0=日）を、_shift は days 日ずらした日付を返す。
function _ymd(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return { y, m, d }; }
function _fromUTC(dt) { return dt.toISOString().slice(0, 10); }
function _utc(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
function _weekdayOf(dateStr) { const { y, m, d } = _ymd(dateStr); return _utc(y, m, d).getUTCDay(); }
function _shift(dateStr, days) {
  const { y, m, d } = _ymd(dateStr);
  return _fromUTC(new Date(_utc(y, m, d).getTime() + days * 86400000));
}

// ── 米国（NYSE / Nasdaq）の休場日をルールから算出 ────────────────────────────
/**
 * ある月の n 番目の指定した曜日を返す。
 *
 * @param {number} year 年
 * @param {number} month 月（1〜12）
 * @param {number} weekday 曜日（0=日）
 * @param {number} n 何番目か
 * @returns {string} YYYY-MM-DD
 */
function _nthWeekday(year, month, weekday, n) {
  const first = _utc(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return _fromUTC(new Date(first.getTime() + (offset + 7 * (n - 1)) * 86400000));
}

/**
 * ある月の最後の指定した曜日を返す。
 *
 * @param {number} year 年
 * @param {number} month 月（1〜12）
 * @param {number} weekday 曜日（0=日）
 * @returns {string} YYYY-MM-DD
 */
function _lastWeekday(year, month, weekday) {
  const last = new Date(_utc(year, month + 1, 1).getTime() - 86400000);
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return _fromUTC(new Date(last.getTime() - back * 86400000));
}

/**
 * 復活祭の日曜（グレゴリオ暦、Anonymous Gregorian algorithm）を返す。グッドフライデーを求めるのに使う。
 *
 * @param {number} year 年
 * @returns {string} YYYY-MM-DD
 */
function _easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return _fromUTC(_utc(year, month, day));
}

/**
 * 祝日が土曜なら前日の金曜、日曜なら翌日の月曜へ振り替える（NYSE の慣行）。
 *
 * @param {string} dateStr 祝日（YYYY-MM-DD）
 * @returns {string} 実際に休む日
 */
function _observed(dateStr) {
  const wd = _weekdayOf(dateStr);
  if (wd === 6) return _shift(dateStr, -1);
  if (wd === 0) return _shift(dateStr, 1);
  return dateStr;
}

/** 年 → その年の米国市場の休場日（usMarketHolidays の計算結果）。 */
const _usHolidayCache = new Map();

/**
 * その年の米国市場の休場日を返す。
 *
 * @param {number} year 年
 * @returns {Map<string, string>} 'YYYY-MM-DD' → 名称
 */
function usMarketHolidays(year) {
  if (_usHolidayCache.has(year)) return _usHolidayCache.get(year);
  const easter = _easterSunday(year);
  const map = new Map([
    [_observed(`${year}-01-01`), '元日'],
    [_nthWeekday(year, 1, 1, 3), 'キング牧師記念日'],
    [_nthWeekday(year, 2, 1, 3), '大統領の日'],
    [_shift(easter, -2), 'グッドフライデー'],
    [_lastWeekday(year, 5, 1), 'メモリアルデー（戦没者追悼の日）'],
    [_observed(`${year}-06-19`), 'ジューンティーンス'],
    [_observed(`${year}-07-04`), '独立記念日'],
    [_nthWeekday(year, 9, 1, 1), 'レイバーデー（労働者の日）'],
    [_nthWeekday(year, 11, 4, 4), '感謝祭'],
    [_observed(`${year}-12-25`), 'クリスマス'],
  ]);
  _usHolidayCache.set(year, map);
  return map;
}

/**
 * その年の米国市場の短縮取引日（東部時間13時に引ける日）を返す。
 *
 * 休場日と違って慣行で決まる部分があり、NYSE が年ごとに公表する。ここでは定着している3つ
 * （感謝祭の翌日・クリスマスイブ・独立記念日の前日）だけを導く。取りこぼしても通常営業として
 * 扱われるだけで、休場を見落とすような重い誤りにはならない。
 *
 * @param {number} year 年
 * @returns {Map<string, string>} 'YYYY-MM-DD' → 名称
 */
function usMarketHalfDays(year) {
  const map = new Map();
  const thanksgiving = _nthWeekday(year, 11, 4, 4);
  map.set(_shift(thanksgiving, 1), '感謝祭の翌日');
  const xmasEve = `${year}-12-24`;
  if (![0, 6].includes(_weekdayOf(xmasEve))) map.set(xmasEve, 'クリスマスイブ');
  const julyThird = `${year}-07-03`;
  if (![0, 6].includes(_weekdayOf(julyThird)) && ![0, 6].includes(_weekdayOf(`${year}-07-04`))) {
    map.set(julyThird, '独立記念日の前日');
  }
  return map;
}

// ── 各市場の「その日が立会日か」判定 ────────────────────────────────────────
/**
 * 東京市場（東証）がその日に休む理由を返す（立会日なら null）。
 *
 * BUGFIX: 週末と日本の祝日に加え、年末年始（12/31〜1/3）も休業にする。1/2・1/3・12/31 は
 * 祝日ではないので holidays-jp に載らず、祝日の判定だけでは取りこぼしていた。
 *
 * @param {string} dateStr 日付（YYYY-MM-DD）
 * @returns {{reason: string, name: string}|null} 理由（weekend・year_end・holiday）と表示名
 */
function _tokyoClosedReason(dateStr) {
  const wd = _weekdayOf(dateStr);
  if (wd === 0 || wd === 6) return { reason: 'weekend', name: `${WEEKDAY_JA[wd]}曜日` };
  const { m, d } = _ymd(dateStr);
  if ((m === 12 && d === 31) || (m === 1 && d <= 3)) return { reason: 'year_end', name: '年末年始の休業' };
  const { y } = _ymd(dateStr);
  const name = holidayService.getHolidayName(new Date(Date.UTC(y, m - 1, d, 3, 0, 0)));
  if (name) return { reason: 'holiday', name: `祝日「${name}」` };
  return null;
}

/**
 * 米国市場がその日に休む理由を返す（立会日なら null）。
 *
 * @param {string} dateStr 日付（YYYY-MM-DD）
 * @returns {{reason: string, name: string}|null} 理由（weekend・holiday）と表示名
 */
function _usClosedReason(dateStr) {
  const wd = _weekdayOf(dateStr);
  if (wd === 0 || wd === 6) return { reason: 'weekend', name: `${WEEKDAY_JA[wd]}曜日` };
  const name = usMarketHolidays(_ymd(dateStr).y).get(dateStr);
  if (name) return { reason: 'holiday', name: `休場日「${name}」` };
  return null;
}

/**
 * 市場がその日に休む理由を返す（立会日なら null）。
 *
 * @param {string} marketKey 'tokyo' か 'us'
 * @param {string} dateStr 日付（YYYY-MM-DD）
 * @returns {{reason: string, name: string}|null} 理由と表示名
 */
function _closedReason(marketKey, dateStr) {
  return marketKey === 'tokyo' ? _tokyoClosedReason(dateStr) : _usClosedReason(dateStr);
}

/**
 * その市場にとって dateStr が立会日か。
 *
 * @param {string} marketKey 'tokyo' か 'us'
 * @param {string} dateStr 日付（YYYY-MM-DD）
 * @returns {boolean} 立会日なら true
 */
function isTradingDay(marketKey, dateStr) {
  return _closedReason(marketKey, dateStr) === null;
}

/**
 * dateStr から step の向きへ進み、最初に見つかる立会日を返す（dateStr 自身も含む。最大30日）。
 *
 * @param {string} marketKey 'tokyo' か 'us'
 * @param {string} dateStr 起点の日付（YYYY-MM-DD）
 * @param {number} step 1（未来へ）か -1（過去へ）
 * @returns {string} 立会日（YYYY-MM-DD）
 */
function _seekTradingDay(marketKey, dateStr, step) {
  let d = dateStr;
  for (let i = 0; i < 30; i += 1) {
    if (isTradingDay(marketKey, d)) return d;
    d = _shift(d, step);
  }
  return d; // 30日連続で休場はあり得ないが、無限ループにはしない
}

// ── 市場の状態 ───────────────────────────────────────────────────────────────
/**
 * ある時点の市場の状態を返す（同期で即答する）。
 *
 * 日本の祝日のデータがまだ取れていなければ「祝日ではない」側に倒す（holiday-service と同じ。
 * 誤って「休場です」と言い切るより、通常営業として扱う方が害が小さい）。
 *
 * @param {'tokyo'|'us'} marketKey 市場
 * @param {Date} [at] 時点（既定は今）
 * @returns {Record<string, any>} 現地の日付・時刻・曜日、立会日か・取引中か・短縮取引か、休む理由、
 *   日本の暦日に対応するセッションの有無、直近の立会日・終値が確定した立会日、次の立会日と日本時間の開始時刻
 */
function getMarketStatus(marketKey, at = new Date()) {
  const mkt = MARKETS[marketKey];
  if (!mkt) throw new Error(`[market-calendar] 未知の市場: ${marketKey}`);
  const now = _localParts(at, mkt.timeZone);
  const today = now.dateStr;
  const closed = _closedReason(marketKey, today);
  const tradingToday = closed === null;
  const halfDay = marketKey === 'us' && tradingToday && usMarketHalfDays(now.year).has(today);
  const sessions = halfDay ? mkt.halfDaySessions : mkt.sessions;
  const openMin = _toMinutes(sessions[0][0]);
  const closeMin = _toMinutes(sessions[sessions.length - 1][1]);

  const isOpenNow = tradingToday && sessions.some(
    ([s, e]) => now.minutes >= _toMinutes(s) && now.minutes < _toMinutes(e)
  );
  const afterClose = tradingToday && now.minutes >= closeMin;

  // 終値が確定している直近の立会日（今日が立会日でも、まだ引けていなければ前の立会日）
  const lastClosedSession = afterClose ? today : _seekTradingDay(marketKey, _shift(today, -1), -1);
  // 次に取引が行われる日（今日が立会日で、まだ寄り付いていなければ今日）
  const nextSession = (tradingToday && now.minutes < openMin)
    ? today : _seekTradingDay(marketKey, _shift(today, 1), 1);
  const nextHalf = marketKey === 'us' && usMarketHalfDays(_ymd(nextSession).y).has(nextSession);
  const nextSessions = nextHalf ? mkt.halfDaySessions : mkt.sessions;
  const nextOpenAt = _zonedToUtc(nextSession, nextSessions[0][0], mkt.timeZone);

  // ATTENTION: 米国市場の現地の日付は、日本時間の昼間はまだ「前日」になる（NY の寄り付きは日本時間の
  // 22:30ごろ）。放送もノートも日本の暦で書くので、「本日の米国市場」として答えるべきなのは、
  // 現地の日付ではなく日本の暦日と同じ日付のセッション。両方を持たせて使い分ける。
  const japanDate = _localParts(at, 'Asia/Tokyo').dateStr;
  const japanDayClosed = _closedReason(marketKey, japanDate);

  return {
    key: mkt.key,
    label: mkt.label,
    timeZone: mkt.timeZone,
    localDate: today,
    localTime: `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`,
    localWeekday: WEEKDAY_JA[now.weekday],
    sessionHours: sessions.map(([a, b]) => `${a}〜${b}`).join(' / '),
    isTradingDay: tradingToday,
    isOpenNow,
    isHalfDay: halfDay,
    closedReason: closed?.reason || null,
    closedName: closed?.name || null,
    // 日本の暦日（＝放送・ノートで言う「本日」）に対応するセッションが立つかどうか
    japanDate,
    tradesOnJapanDate: japanDayClosed === null,
    japanDateClosedName: japanDayClosed?.name || null,
    japanDateIsHalfDay: marketKey === 'us' && japanDayClosed === null
      && usMarketHalfDays(_ymd(japanDate).y).has(japanDate),
    japanDateSessionHours: (marketKey === 'us' && japanDayClosed === null
      && usMarketHalfDays(_ymd(japanDate).y).has(japanDate)
      ? mkt.halfDaySessions : mkt.sessions).map(([a, b]) => `${a}〜${b}`).join(' / '),
    lastTradingDay: _seekTradingDay(marketKey, today, -1),
    lastClosedSession,
    nextTradingDay: nextSession,
    nextOpenAt,
    nextOpenJstText: (() => {
      const j = _localParts(nextOpenAt, 'Asia/Tokyo');
      const hh = String(Math.floor(j.minutes / 60)).padStart(2, '0');
      const mm = String(j.minutes % 60).padStart(2, '0');
      return `${formatDateJa(j.dateStr)}${hh}:${mm}`;
    })(),
  };
}

/**
 * 東京市場と米国市場の状態をまとめて返す。
 *
 * @param {Date} [at] 時点（既定は今）
 * @returns {{tokyo: Record<string, any>, us: Record<string, any>}} 市場ごとの状態
 */
function getAllMarketStatuses(at = new Date()) {
  return { tokyo: getMarketStatus('tokyo', at), us: getMarketStatus('us', at) };
}

/**
 * ある時刻を、指定したタイムゾーンの暦日として返す。
 *
 * @param {Date} date 時刻
 * @param {string} timeZone IANA のタイムゾーン名
 * @returns {string} YYYY-MM-DD
 */
function localDateOf(date, timeZone) { return _localParts(date, timeZone).dateStr; }

/**
 * ある時刻を、指定したタイムゾーンの時刻として返す。
 *
 * @param {Date} date 時刻
 * @param {string} timeZone IANA のタイムゾーン名
 * @returns {string} HH:MM
 */
function localTimeOf(date, timeZone) {
  const p = _localParts(date, timeZone);
  return `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}`;
}

/**
 * 日付を短い日本語（例: '9/4(金)'）にする。価格のラベルのように短く書きたいところで使う。
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string} 表示用の日付
 */
function formatDateShortJa(dateStr) {
  const { m, d } = _ymd(dateStr);
  return `${m}/${d}(${WEEKDAY_JA[_weekdayOf(dateStr)]})`;
}

/**
 * 日付を日本語（例: '9月4日(金)'）にする。プロンプトやノートで日付をあいまいにしないために使う。
 *
 * @param {string} dateStr YYYY-MM-DD
 * @returns {string} 表示用の日付
 */
function formatDateJa(dateStr) {
  const { m, d } = _ymd(dateStr);
  return `${m}月${d}日(${WEEKDAY_JA[_weekdayOf(dateStr)]})`;
}

/**
 * 市場の開閉を、プロンプトやノートへそのまま入れられる日本語の事実にする。
 *
 * BUGFIX: 「本日は休場です」で終わらせず、終値が確定している直近の立会日がいつかまで書く。
 * エージェントが「本日の終値は」と言ってしまう誤りは、手元の数字がいつのものか分からないことから
 * 起きていた。
 *
 * @param {Date} [at] 時点（既定は今）
 * @returns {string} 「【市場の開閉】」から始まる文
 */
function describeMarkets(at = new Date()) {
  const { tokyo, us } = getAllMarketStatuses(at);
  const jstDate = tokyo.japanDate;
  const lines = [];
  for (const st of [tokyo, us]) {
    const parts = [];
    // ① 「本日」＝日本の暦日について、その市場が立つのかどうか（最も知りたい事実）
    if (st.tradesOnJapanDate) {
      parts.push(`本日${formatDateJa(jstDate)}は立会日です`
        + `（現地 ${st.japanDateSessionHours}${st.japanDateIsHalfDay ? '・短縮取引' : ''}）`);
    } else {
      parts.push(`本日${formatDateJa(jstDate)}は${st.japanDateClosedName}のため休場です`);
    }
    // ② いま取引中かどうか（現地の営業時間で判断）
    parts.push(st.isOpenNow ? `現在は取引時間中です（現地 ${st.localTime}）` : '現在は取引時間外です');
    // ③ 手元の数字がいつのものか。ここを明示しないと「本日の終値は」と言ってしまう
    parts.push(`直近で終値が確定しているのは${formatDateJa(st.lastClosedSession)}の取引`);
    // ④ 次に開くのはいつか（日本時間で伝える）
    parts.push(`次に取引が行われるのは${formatDateJa(st.nextTradingDay)}（日本時間 ${st.nextOpenJstText} 開始）`);
    lines.push(`- ${st.label}: ${parts.join('。')}。`);
  }
  return '【市場の開閉】\n' + lines.join('\n');
}

/**
 * describeMarkets に、LLM へ渡すときだけ要る一文（事実として扱い、推測で補わない）を足したもの。
 *
 * デイリーノートのように人が読むところへそのまま載せるときは describeMarkets を使い、
 * プロンプト向けの指示が本文に混ざらないようにする。
 *
 * @param {Date} [at] 時点（既定は今）
 * @returns {string} プロンプトに入れる文
 */
function describeMarketsForPrompt(at = new Date()) {
  return `${describeMarkets(at)}\n（上記は事実です。この通りに扱い、推測で補わないでください。）`;
}

module.exports = {
  MARKETS, holidayService,
  getMarketStatus, getAllMarketStatuses, isTradingDay,
  usMarketHolidays, usMarketHalfDays,
  formatDateJa, formatDateShortJa, localDateOf, localTimeOf,
  describeMarkets, describeMarketsForPrompt,
};
