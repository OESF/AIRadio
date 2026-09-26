/**
 * @file 秘書の活動の記録（ブリーフィング・メールの仕分けなど）を、区分ごと・日付ごとに保存する
 *
 * 区分ごとのフォルダーに、1日1つの JSON ファイルで追記していく（agent-diary.js と同じ形）。
 * 放送のエージェントの日記とは別のフォルダーに置き、混ぜない。
 * デイリーノート・ウィークリーノートの材料や、資産のスナップショットの保存にも使う。
 *
 * 保存先: data/secretary/areas/<区分>/<YYYY-MM-DD>.json
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

const fs = require('fs');
const { writeJsonFile } = require('./atomic-json');
const path = require('path');
const { getLogger } = require('../logger');

const SECRETARY_DIR = path.join(__dirname, '..', 'data', 'secretary');
/** 1日に残す件数の上限（超えたら古いものから消す）。 */
const MAX_ENTRIES_PER_DAY = 200;

/** @param {Date} [d] @returns {string} ローカル時刻の「YYYY-MM-DD」 */
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** @param {string} category @returns {string} 区分のフォルダー */
function categoryDir(category) {
  return path.join(SECRETARY_DIR, 'areas', category);
}

/**
 * 今日のファイルに1件追記する。失敗しても例外は出さない。
 * @param {string} category 'daily-briefings'・'email-logs' など
 * @param {object} entry 保存する内容（time は自動で付く）
 */
function appendEntry(category, entry) {
  if (!category || !entry) return;
  const dir = categoryDir(category);
  const filePath = path.join(dir, `${todayStr()}.json`);
  let entries = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath)) entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    getLogger().warn(`[SecretaryStore] 既存ログの読み込みに失敗: ${filePath} — ${e.message}`);
  }
  entries.push({ time: new Date().toISOString(), ...entry });
  if (entries.length > MAX_ENTRIES_PER_DAY) entries = entries.slice(-MAX_ENTRIES_PER_DAY);
  try {
    writeJsonFile(filePath, entries);
  } catch (e) {
    getLogger().warn(`[SecretaryStore] ログの保存に失敗: ${filePath} — ${e.message}`);
  }
}

/**
 * 記録を新しい順に返す（新しい日のファイルから読み、limit 件に達したら止める）。
 * @param {string} category
 * @param {{ limit?: number }} [opts] 既定 200件
 * @returns {Array<Record<string, any>>}
 */
function listEntries(category, { limit = 200 } = {}) {
  const dir = categoryDir(category);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  const results = [];
  for (const f of files) {
    try {
      const dayEntries = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      results.push(...dayEntries);
    } catch (e) {
      getLogger().warn(`[SecretaryStore] ログファイルの読み込みに失敗: ${path.join(dir, f)} — ${e.message}`);
    }
    if (results.length >= limit) break;
  }
  results.sort((a, b) => new Date(b.time) - new Date(a.time));
  return results.slice(0, limit);
}

/**
 * 1日分の記録だけを読む（listEntries と違い、他の日に広がらず、件数でも切らない）。
 * @param {string} category
 * @param {string} dateStr 「YYYY-MM-DD」
 * @returns {Array<Record<string, any>>} ファイルが無い・読めないときは空
 */
function readEntriesForDate(category, dateStr) {
  const filePath = path.join(categoryDir(category), `${dateStr}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    getLogger().warn(`[SecretaryStore] ログの読み込みに失敗: ${filePath} — ${e.message}`);
    return [];
  }
}

/**
 * 今日の記録だけを読む（デイリーノートの日報が、今日の活動だけを材料にするため）。
 * @param {string} category
 * @returns {Array<Record<string, any>>}
 */
function readTodayEntries(category) {
  return readEntriesForDate(category, todayStr());
}

/**
 * 複数日分の記録を、日付の並びのまま日ごとに返す（ウィークリーノート用）。
 * 日ごとの区切りが要らなければ、呼び出し側で .flatMap(d => d.entries) する。
 * 記録の無い日は空の配列になる（1週間のうち記録の無い日があるのは普通のこと）。
 * @param {string} category
 * @param {string[]} dateStrs 「YYYY-MM-DD」の並び
 * @returns {Array<{date: string, entries: Array<Record<string, any>>}>}
 */
function readEntriesForDateRange(category, dateStrs) {
  return dateStrs.map(date => ({ date, entries: readEntriesForDate(category, date) }));
}

module.exports = {
  appendEntry, listEntries, readTodayEntries, readEntriesForDate, readEntriesForDateRange,
  SECRETARY_DIR,
};
