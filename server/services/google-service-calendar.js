/**
 * @file Google カレンダーの予定の取得・重なりの確認・作成・更新・削除（GoogleService に取り込むメソッド群）
 *
 * 秘書の予定のツールと、Live・自律ループの「今日の予定」で使う。認証は google-service.js の
 * _getAccessToken を this 経由で使う。
 *
 * ATTENTION: 書き込み（作成・更新・削除）には、読み取り専用ではないスコープが要る。古いスコープのまま
 *            連携していると失敗するので、管理画面で Google を連携し直す（routes/oauth-routes.js）。
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

const calendarMethods = {
  /**
   * 予定を取得する（既定は今から7日分）。
   *
   * BUGFIX: 取得する範囲を起点（fromDate）と日数（rangeDays）で指定できるようにしてある。以前は「今から3日」
   *         固定で、5日先の予定を聞かれても最初から見えておらず「何も入っていません」と答え、さらに
   *         確認だけの依頼で予定を作ってしまい二重登録になった。
   * @param {Record<string, any>} creds 認証情報
   * @param {{ rangeDays?: number, maxResults?: number, fromDate?: string|null }} [opts]
   *   fromDate は日本時間の「YYYY-MM-DD」。省略すると今から
   * @returns {Promise<Array<Record<string, any>>>} 予定（id・表示用の日付と時刻・開始時刻など）
   */
  async fetchCalendar(creds, { rangeDays = 7, maxResults = 50, fromDate = null } = {}) {
    const accessToken = await this._getAccessToken(creds);
    // fromDate はJSTの日付として解釈する（サーバーのローカル時刻に依存させない）。
    const startMs = fromDate
      ? new Date(`${fromDate}T00:00:00+09:00`).getTime()
      : Date.now();
    if (Number.isNaN(startMs)) throw new Error(`日付の指定が不正です: ${fromDate}`);
    const rangeEnd = new Date(startMs + rangeDays * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: new Date(startMs).toISOString(),
      timeMax: rangeEnd.toISOString(),
      maxResults: String(maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Calendar API HTTP ${res.status}`);
    const data = await res.json();
    const JST_OFF = 9 * 60 * 60 * 1000;
    const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
    return (data.items || []).map(item => {
      const start = item.start.dateTime || item.start.date;
      const startJST = new Date(new Date(start).getTime() + JST_OFF);
      const month = startJST.getUTCMonth() + 1;
      const date = startJST.getUTCDate();
      const dow = DOW_JA[startJST.getUTCDay()];
      const timeStr = item.start.dateTime
        ? `${String(startJST.getUTCHours()).padStart(2, '0')}:${String(startJST.getUTCMinutes()).padStart(2, '0')}`
        : '終日';
      return {
        // 予定を変更・削除するときに一つに特定できるよう、Google カレンダーのイベント ID を持たせる
        // （題名や日時の文字列で探すと、同じ名前の予定を取り違える）
        id: item.id,
        summary: item.summary || '(無題の予定)',
        dateLabel: `${month}月${date}日(${dow})`,
        timeStr,
        description: item.description || '',
        location: item.location || '',
        attendees: (item.attendees || []).map(a => a.email).filter(Boolean),
        // 自律ループ（secretary-loop.js）が「もうすぐ始まるか」を判定するための、生の開始時刻
        // （dateLabel・timeStr は表示用に整えたものなので計算には使えない。終日の予定は時刻が無いので対象外）
        startISO: item.start.dateTime || null,
      };
    });
  },

  // ─────────────────────────────────────────────
  // ─── 書き込み（作成・更新・削除） ─────────────────────────────

  /**
   * 指定した時間帯に少しでも重なる予定を返す（二重登録を防ぐため、作る前に確かめる）。
   * @param {Record<string, any>} creds
   * @param {{startISO: string, endISO: string}} opts タイムゾーン付きの ISO 形式
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async findOverlappingEvents(creds, { startISO, endISO }) {
    const accessToken = await this._getAccessToken(creds);
    const params = new URLSearchParams({
      timeMin: new Date(startISO).toISOString(),
      timeMax: new Date(endISO).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '10',
    });
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Calendar API(重複確認) HTTP ${res.status}`);
    const data = await res.json();
    const JST = 9 * 60 * 60 * 1000;
    return (data.items || []).map((item) => {
      const st = item.start.dateTime || item.start.date;
      const d = new Date(new Date(st).getTime() + JST);
      const hhmm = item.start.dateTime
        ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
        : '終日';
      return {
        id: item.id,
        summary: item.summary || '(無題の予定)',
        when: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hhmm}`,
      };
    });
  },

  /**
   * 予定を作る。
   * @param {Record<string, any>} creds
   * @param {{summary: string, startISO: string, endISO: string, description?: string, location?: string}} opts
   *   startISO・endISO はタイムゾーン付きの ISO 形式
   * @returns {Promise<object>} 作った予定
   */
  async createCalendarEvent(creds, { summary, startISO, endISO, description = '', location = '' }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description,
        location,
        start: { dateTime: startISO, timeZone: 'Asia/Tokyo' },
        end: { dateTime: endISO, timeZone: 'Asia/Tokyo' },
      }),
    });
    if (!res.ok) throw new Error(`Calendar API(作成) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * 予定の一部を変える（渡した項目だけが変わり、渡さなかった項目はそのまま）。
   *
   * ATTENTION: eventId は fetchCalendar が返す id（Google カレンダーのイベント ID）を使うこと。
   *            題名で探すと、同じ名前の別の予定を変えてしまう。
   * @param {Record<string, any>} creds
   * @param {{eventId: string, summary?: string, startISO?: string, endISO?: string, description?: string, location?: string}} opts
   * @returns {Promise<object>}
   */
  async updateCalendarEvent(creds, { eventId, summary, startISO, endISO, description, location }) {
    const accessToken = await this._getAccessToken(creds);
    const body = {};
    if (summary !== undefined) body.summary = summary;
    if (description !== undefined) body.description = description;
    if (location !== undefined) body.location = location;
    if (startISO !== undefined) body.start = { dateTime: startISO, timeZone: 'Asia/Tokyo' };
    if (endISO !== undefined) body.end = { dateTime: endISO, timeZone: 'Asia/Tokyo' };
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Calendar API(変更) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * 予定を削除する。eventId は updateCalendarEvent と同じく、題名ではなくイベント ID を使う。
   * @param {Record<string, any>} creds
   * @param {{eventId: string}} opts
   * @returns {Promise<void>}
   */
  async deleteCalendarEvent(creds, { eventId }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // すでに削除された予定なら 410 が返るが、「その予定が無い」という望んだ状態なのでエラーにしない
    if (!res.ok && res.status !== 410) throw new Error(`Calendar API(削除) HTTP ${res.status}: ${await res.text()}`);
  },
};

module.exports = { calendarMethods };
