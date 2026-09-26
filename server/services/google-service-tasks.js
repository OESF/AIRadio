/**
 * @file Google ToDo の取得・作成（GoogleService に取り込むメソッド群）
 *
 * google-service.js が Object.assign(GoogleService.prototype, tasksMethods) で取り込む。
 * ここに置くのはメソッドの実装だけで、認証（_getAccessToken）とトークンのキャッシュは
 * google-service.js 本体が持つ。各メソッドは this 経由でそれらを呼ぶ。
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

const tasksMethods = {
  /**
   * 既定のリストから、未完了のタスク（期限なし、または期限が今日以降）を取得する。
   * @param {object} creds 認証情報（credentials.json の内容）
   * @param {{maxResults?: number}} [opts]
   * @returns {Promise<Array<{title: string, due: string|null}>>} due は「9/18」の形
   */
  async fetchTasks(creds, { maxResults = 20 } = {}) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(
      `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks` +
      `?showCompleted=false&showHidden=false&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) throw new Error(`Tasks API HTTP ${res.status}`);
    const data = await res.json();
    const todayStartISO = new Date(new Date().toDateString()).toISOString();
    return (data.items || [])
      .filter(t => t.status !== 'completed')
      .filter(t => !t.due || t.due >= todayStartISO)
      .map(t => ({
        title: t.title,
        due: t.due ? new Date(t.due).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : null,
      }));
  },

  /**
   * 既定のリストにタスクを作成する。
   * @param {object} creds 認証情報
   * @param {{title: string, notes?: string, dueISO?: string|null}} task dueISO を省略すると期限なし
   * @returns {Promise<object>} Tasks API が返したタスク
   */
  async createTask(creds, { title, notes = '', dueISO = null }) {
    const accessToken = await this._getAccessToken(creds);
    const body = { title, notes };
    if (dueISO) body.due = dueISO;
    const res = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Tasks API(作成) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },
};

module.exports = { tasksMethods };
