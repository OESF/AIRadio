/**
 * @file ウィークリーノートの表と集計（先週の天気の実績・来週の予報）
 *
 * デイリーノートの整形（secretary-daily-note-formatting.js）とは分けている（週の範囲の集計を混ぜないため）。
 * 天気の絵文字はデイリー側の _weatherEmoji を使う（表記の揺れの吸収を2か所で管理しない）。
 *
 * 主な利用元: lib/secretary-tools-reports.js（ウィークリーノートの作成）
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

const { _weatherEmoji } = require('./secretary-daily-note-formatting');

/** 曜日の表記（getDay() の順）。 */
const WEEKDAY_LABELS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 基準日を含む週の、月曜から日曜までの7日分の日付を古い順に返す（週は月曜始まり・日曜終わり。
 * 日曜の夜に、その日までの1週間をまとめる）。
 * @param {Date} [referenceDate] 普通は週次の処理が走る日曜日
 * @returns {string[]} 「YYYY-MM-DD」の7件
 */
function datesForWeekEndingOn(referenceDate = new Date()) {
  const dow = referenceDate.getDay(); // 0=日, 1=月, ..., 6=土
  // 直近の月曜日までさかのぼる日数。日曜(0)なら6日前が月曜。
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(referenceDate);
  monday.setDate(monday.getDate() - daysSinceMonday);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

/**
 * 「YYYY-MM-DD」の曜日（日〜土）を返す（タイムゾーンでずれないよう、ローカルの日付として作る）。
 * @param {string} dateStr
 * @returns {string}
 */
function _weekdayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAY_LABELS_JA[new Date(y, m - 1, d).getDay()];
}

/**
 * 1日分の天気の記録（2時間おきの実測。{ time, bucketHour, temp, desc }）から、最高・最低気温と、
 * その日を代表する天気（正午に最も近い記録）を出す。
 * @param {Array<any>} entries secretaryStore.readEntriesForDate('weather-history', 日付) の結果
 * @returns {{ tempMax: number|null, tempMin: number|null, desc: string }}
 */
function summarizeDayFromWeatherHistory(entries) {
  if (!entries || entries.length === 0) return { tempMax: null, tempMin: null, desc: '' };
  const temps = entries.map(e => e.temp).filter(t => typeof t === 'number');
  const tempMax = temps.length > 0 ? Math.max(...temps) : null;
  const tempMin = temps.length > 0 ? Math.min(...temps) : null;
  // 正午に最も近い記録の天気を、その日の代表にする
  const closestToNoon = entries.reduce((best, e) => {
    const diff = Math.abs((e.bucketHour ?? 12) - 12);
    const bestDiff = Math.abs((best?.bucketHour ?? 12) - 12);
    return best === null || diff < bestDiff ? e : best;
  }, null);
  return { tempMax, tempMin, desc: closestToNoon?.desc || '' };
}

/**
 * 先週7日分の天気の実績の表（Markdown）を作る。
 * @param {string[]} weekDates datesForWeekEndingOn の結果（月〜日、古い順）
 * @param {Array<{date: string, entries: Array<Record<string, any>>}>} weatherHistoryRange
 *   secretaryStore.readEntriesForDateRange('weather-history', weekDates) の結果
 * @returns {string}
 */
function buildPastWeekWeatherMarkdown(weekDates, weatherHistoryRange) {
  const byDate = new Map(weatherHistoryRange.map(r => [r.date, r.entries]));
  const rows = weekDates.map(date => {
    const { tempMax, tempMin, desc } = summarizeDayFromWeatherHistory(byDate.get(date) || []);
    return { date, weekday: _weekdayLabel(date), tempMax, tempMin, desc };
  });
  const hasAnyData = rows.some(r => r.tempMax !== null);
  if (!hasAnyData) return '今週は天気の実測記録がありませんでした。';

  const lines = ['| 曜日 | 日付 | 最高 | 最低 | 天気 |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const emoji = _weatherEmoji(r.desc);
    const weather = r.desc ? `${emoji ? emoji + ' ' : ''}${r.desc}` : '記録なし';
    const max = r.tempMax !== null ? `${r.tempMax}℃` : '-';
    const min = r.tempMin !== null ? `${r.tempMin}℃` : '-';
    lines.push(`| ${r.weekday} | ${r.date} | ${max} | ${min} | ${weather} |`);
  }
  return lines.join('\n');
}

/**
 * 来週7日分の天気予報の表（Markdown）を作る。
 * @param {{ overviewText: string|null, days: Array<Record<string, any>> }|null} weeklyForecast
 *   weather-service.js の fetchWeeklyForecast の結果（prepareNextWeekForecast を通したもの）
 * @returns {string}
 */
function buildNextWeekForecastMarkdown(weeklyForecast) {
  if (!weeklyForecast || !weeklyForecast.days || weeklyForecast.days.length === 0) {
    return '来週の天気予報を取得できませんでした。';
  }
  const parts = [];
  if (weeklyForecast.overviewText) {
    parts.push(weeklyForecast.overviewText);
  }
  const lines = ['| 曜日 | 日付 | 最高 | 最低 | 天気 | 降水確率 |', '|---|---|---|---|---|---|'];
  for (const d of weeklyForecast.days) {
    const emoji = _weatherEmoji(d.weatherCategory);
    const weather = d.weatherCategory ? `${emoji ? emoji + ' ' : ''}${d.weatherCategory}` : '-';
    const max = d.tempMax !== null ? `${d.tempMax}℃` : '-';
    const min = d.tempMin !== null ? `${d.tempMin}℃` : '-';
    const pop = d.pop !== null ? `${d.pop}%` : '-';
    // 信頼度 C（週の後半に多い）は、参考程度であることを添える
    const reliabilityNote = d.reliability === 'C' ? '（信頼度低）' : '';
    lines.push(`| ${_weekdayLabel(d.date)} | ${d.date} | ${max} | ${min} | ${weather}${reliabilityNote} | ${pop} |`);
  }
  parts.push(lines.join('\n'));
  return parts.join('\n\n');
}

/**
 * 来週の予報の表を作る前に、週間予報の欠けと余計な部分を直す。
 *
 * BUGFIX: 週間予報の1日目（発行日の翌日）の最高・最低気温を、「今日・明日」の予報の値で埋めること。
 *         気象庁の週間予報は1日目の気温を持たず、表が「-」になっていた（その値は「今日・明日」の予報にだけ
 *         載っている。日曜に作るので、その「明日」＝月曜が週間予報の1日目と一致する）。
 * BUGFIX: 概況の文から、発行した当日（振り返る週の最終日）に触れる段落を除くこと。そのまま出すと、
 *         先週の最終日の話が来週の欄に混ざって見えた（前線・気圧配置など日付に結びつかない記述は残す）。
 *
 * @param {{overviewText: string|null, days: Array}|null} weeklyForecast fetchWeeklyForecastの戻り値
 * @param {{tomorrow: {max: number|null, min: number|null}}|null} officialDailyForecast
 *   fetchOfficialDailyForecastの戻り値（今夜時点の「明日」＝週間予報の1日目と同じ日を指す）
 * @param {string} todayDateStr 発行日（'YYYY-MM-DD'）。overviewText中の「当日」段落の除去に使う
 */
function prepareNextWeekForecast(weeklyForecast, officialDailyForecast, todayDateStr) {
  if (!weeklyForecast || !weeklyForecast.days || weeklyForecast.days.length === 0) return weeklyForecast;
  const days = weeklyForecast.days.map((d) => ({ ...d }));
  const first = days[0];
  if (first && first.tempMax === null && first.tempMin === null && officialDailyForecast?.tomorrow) {
    const t = officialDailyForecast.tomorrow;
    if (t.max != null) first.tempMax = t.max;
    if (t.min != null) first.tempMin = t.min;
  }
  return { overviewText: _stripTodayParagraph(weeklyForecast.overviewText, todayDateStr), days };
}

/**
 * 概況の文の段落のうち、todayDateStr の日にち（「18日」など）に触れるものだけを除く。
 * @param {string|null} overviewText
 * @param {string} todayDateStr 「YYYY-MM-DD」
 * @returns {string|null}
 */
function _stripTodayParagraph(overviewText, todayDateStr) {
  if (!overviewText || !todayDateStr) return overviewText;
  const todayDay = parseInt(todayDateStr.slice(8, 10), 10);
  const paragraphs = overviewText.split(/\n\s*\n/);
  const filtered = paragraphs.filter((p) => {
    const m = p.match(/([０-９0-9]+)日は/);
    if (!m) return true; // 日付言及の無い段落（地域の気圧配置等）はそのまま残す
    const hankaku = m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    return parseInt(hankaku, 10) !== todayDay;
  });
  const result = filtered.join('\n\n').trim();
  return result || null;
}

module.exports = {
  datesForWeekEndingOn,
  summarizeDayFromWeatherHistory,
  buildPastWeekWeatherMarkdown,
  buildNextWeekForecastMarkdown,
  prepareNextWeekForecast,
};
