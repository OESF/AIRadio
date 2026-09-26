/**
 * @file エージェントの「見立て」の記録と、答え合わせの期日の管理
 *
 * 教授やコメンテーターが述べた「円安は止まらない」のような見立てを記録し、期日が来たら当たったかを
 * 確かめられるようにする（見立てが外れたと気づくことで、エージェントが伸びる）。
 *
 * 日記を書くとき（agent-diary.js の buildReflectionPrompt）に、検証できる見立てがあれば1行添えるよう
 * 指示しており、appendDiaryEntry がその1行を読み取って recordPrediction を呼ぶ。答え合わせは別の処理が
 * getDuePredictions で期日の来たものを探し、結果を markChecked で書き戻す。
 *
 * 日記は日付ごとのファイルに分かれていて「まだ答え合わせしていないもの」を横断して探しにくいので、
 * 見立てだけを別の1ファイルに持つ。
 *
 * 保存先: data/agent-diary/predictions.json
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

const PREDICTIONS_PATH = path.join(__dirname, '..', 'data', 'agent-diary', 'predictions.json');
/** 保存する件数の上限（週に数件の想定なので十分な余裕がある）。 */
const MAX_PREDICTIONS = 500;
/** 答え合わせまでの日数の下限・上限・既定。 */
const MIN_CHECK_DAYS = 3;
const MAX_CHECK_DAYS = 30;
const DEFAULT_CHECK_DAYS = 7;

/**
 * 全件を読む。ファイルが無い・壊れているときは空。
 * @returns {Array<Record<string, any>>}
 */
function _readAll() {
  try {
    return JSON.parse(fs.readFileSync(PREDICTIONS_PATH, 'utf-8'));
  } catch (e) {
    return [];
  }
}

/**
 * 全件を書く。失敗しても例外は出さない。
 * @param {Array<Record<string, any>>} list
 */
function _writeAll(list) {
  try {
    fs.mkdirSync(path.dirname(PREDICTIONS_PATH), { recursive: true });
    writeJsonFile(PREDICTIONS_PATH, list);
  } catch (e) {
    getLogger().warn(`[AgentPredictions] 保存に失敗: ${e.message}`);
  }
}

/**
 * 見立てを1件記録する。答え合わせの日は checkInDays 日後（3〜30日に収める。既定 7日）。
 * @param {{channel: string, agentKey: string, agentName?: string, claim: string, checkInDays?: *}} p
 *   claim は見立ての文（200文字まで）。checkInDays は数値でなければ既定の日数にする。channel・agentKey・claim のどれかが空なら記録しない
 */
function recordPrediction({ channel, agentKey, agentName, claim, checkInDays }) {
  if (!channel || !agentKey || !claim) return;
  const list = _readAll();
  const days = Number.isFinite(checkInDays)
    ? Math.min(Math.max(Math.round(checkInDays), MIN_CHECK_DAYS), MAX_CHECK_DAYS)
    : DEFAULT_CHECK_DAYS;
  list.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    channel,
    agentKey,
    agentName: agentName || agentKey,
    claim: String(claim).slice(0, 200),
    madeAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + days * 86400000).toISOString(),
    checked: false,
  });
  const trimmed = list.length > MAX_PREDICTIONS ? list.slice(-MAX_PREDICTIONS) : list;
  _writeAll(trimmed);
  getLogger().info(`[AgentPredictions] ${channel}/${agentKey} の見立てを記録（${days}日後に答え合わせ予定）: ${claim}`);
}

/**
 * 答え合わせの期日が来ていて、まだ確かめていない見立てを返す。
 * @returns {Array<Record<string, any>>}
 */
function getDuePredictions() {
  const now = Date.now();
  return _readAll().filter((p) => !p.checked && new Date(p.dueAt).getTime() <= now);
}

/**
 * 答え合わせの結果を記録する。該当する見立てが無ければ何もしない。
 * @param {string} id 見立ての ID
 * @param {{verdict?: string, verdictNote?: string}} [result] 判定と、その理由
 */
function markChecked(id, { verdict, verdictNote } = {}) {
  const list = _readAll();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return;
  list[idx].checked = true;
  list[idx].checkedAt = new Date().toISOString();
  list[idx].verdict = verdict || null;
  list[idx].verdictNote = verdictNote || null;
  _writeAll(list);
}

module.exports = { recordPrediction, getDuePredictions, markChecked, PREDICTIONS_PATH };
