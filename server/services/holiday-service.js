/**
 * @file 日本の祝日の判定（holidays-jp の API をキャッシュして同期で答える）
 *
 * Live のディレクターが編成を決めるとき（週末・祝日は金融コーナーを外すなど）に使う。
 *
 * 主な利用元: agent-system.js（_refillCornerQueue・ディレクターの判断材料）
 *
 * ATTENTION: 判定（isHoliday・getHolidayName）は同期でキャッシュを読むだけにすること。呼び出し元の
 *            _refillCornerQueue は番組進行のタイミングに直結していて、fetch すら待てない。
 *            取得（refresh）は起動時とサイクルの補充のたびに fire-and-forget で呼ぶ。
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

/** 内閣府の「国民の祝日」を JSON で公開している無料の API。{ "YYYY-MM-DD": "祝日名" } を返す。 */
const HOLIDAY_API_URL = 'https://holidays-jp.github.io/api/v1/date.json';

/** 祝日は年に十数件で、直前に変わることも無いので長めにキャッシュする。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * ローカル時刻の「YYYY-MM-DD」を返す（agent-system.js の _getShowDay などと同じく、UTC に変換しない）。
 * @param {Date} date
 * @returns {string}
 */
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 祝日の判定。
 *
 * 取得に失敗してキャッシュも無いときは「祝日ではない」と答える（安全側。誤って金融コーナーなどを
 * 外さないため）。
 */
class HolidayService {
  constructor() {
    this.cache = { data: null, lastFetch: 0 };
  }

  /**
   * キャッシュを更新する。有効期限内なら何もしない。失敗しても例外は出さず、古いキャッシュを使い続ける。
   * await せずに呼んでよい。
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this.cache.data && Date.now() - this.cache.lastFetch < CACHE_TTL_MS) return;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      const res = await fetch(HOLIDAY_API_URL, { signal: ac.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.cache = { data, lastFetch: Date.now() };
      getLogger().debug(`[Holiday] 祝日データを更新しました（${Object.keys(data).length}件）`);
    } catch (e) {
      getLogger().warn(`[Holiday] 祝日データの取得に失敗（既存キャッシュがあればそのまま使用継続）: ${e.message}`);
    }
  }

  /**
   * その日が祝日か。
   * @param {Date} [date] 省略すると今日
   * @returns {boolean}
   */
  isHoliday(date = new Date()) {
    if (!this.cache.data) return false;
    return Object.prototype.hasOwnProperty.call(this.cache.data, localDateStr(date));
  }

  /**
   * 祝日の名前を返す。
   * @param {Date} [date] 省略すると今日
   * @returns {string|null} 祝日でない、またはまだ取得していなければ null
   */
  getHolidayName(date = new Date()) {
    if (!this.cache.data) return null;
    return this.cache.data[localDateStr(date)] || null;
  }
}

module.exports = HolidayService;
