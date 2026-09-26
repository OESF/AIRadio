/**
 * @file リスナーのリクエスト・アンコールの記録と集計
 *
 * 番組がどう受け取られたかを推し量るのではなく、行動に表れた選択（リクエスト・アンコール）だけを
 * 記録する。推論の要らない、はっきりした意思表示だから。
 *
 * 滞在時間や切断は使わない。24時間放送なので切断は必ず番組の途中で起き、生の離脱率はコーナーの
 * 長さを見ているだけになる（露出時間で割ると順位が入れ替わる）。テスト接続も混ざっている。
 *
 * 主な利用元:
 *   - 各チャンネル（記録）
 *   - lib/listener-context.js（ディレクター・DJ に直近のリクエストを渡す）
 *   - routes/dashboard-routes.js（視聴の統計）
 *
 * 保存先: data/listener_requests.jsonl（追記だけの JSON Lines、1行1件）
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
const path = require('path');
const { getLogger } = require('../logger');

const REQUESTS_PATH = path.join(__dirname, '..', 'data', 'listener_requests.jsonl');

/** リクエストの種類（キー → 表示名）。増やすときもここに足す。 */
const KINDS = {
  corner: 'コーナーのリクエスト',
  music:  '曲のリクエスト',
  topic:  '話題のリクエスト',
  encore: 'アンコール（もう一度）',
};

/**
 * リクエストを1件記録する。放送を止めないよう、失敗しても例外は出さない。
 * チャンネルが空、または種類が KINDS に無ければ記録しない。
 *
 * @param {object} p
 * @param {string} p.channel  チャンネルID（'live'/'classic'/'jazz'/'mood'/'beatles'）
 * @param {string} p.kind     KINDS のキー
 * @param {string} p.label    人が読んで分かる短い内容（コーナー名・曲名・話題など）
 * @param {object} [p.detail] 追加情報（アーティスト名・生の依頼文など）
 */
function recordRequest({ channel, kind, label, detail = null }) {
  if (!channel || !KINDS[kind]) return;
  try {
    const row = {
      time: Date.now(),
      channel,
      kind,
      label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      ...(detail ? { detail } : {}),
    };
    fs.appendFileSync(REQUESTS_PATH, `${JSON.stringify(row)}\n`, 'utf8');
    getLogger().info(`[Request] 記録: [${channel}] ${KINDS[kind]} — ${row.label}`);
  } catch (e) {
    getLogger().warn(`[Request] 記録に失敗（無視して続行）: ${e.message}`);
  }
}

/**
 * 記録を新しい順に読む。
 * @param {{days?: number|null, channel?: string|null, kind?: string|null, limit?: number}} [opts]
 *   days はその日数以内に絞る（null は全期間）、limit は件数の上限（既定 200）
 * @returns {Array<{time: number, channel: string, kind: string, label: string, detail?: object}>}
 */
function readRequests({ days = null, channel = null, kind = null, limit = 200 } = {}) {
  if (!fs.existsSync(REQUESTS_PATH)) return [];
  const since = days ? Date.now() - days * 86400000 : 0;
  const out = [];
  for (const line of fs.readFileSync(REQUESTS_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.time < since) continue;
    if (channel && o.channel !== channel) continue;
    if (kind && o.kind !== kind) continue;
    out.push(o);
  }
  return out.slice(-limit).reverse();
}

/**
 * 直近の記録を集計する（種類ごとの件数と、何が何回頼まれたかの上位20件）。
 * @param {{days?: number}} [opts] 既定 30日
 * @returns {{total: number, days: number, byKind: object,
 *   top: Array<{kind: string, label: string, count: number}>}} byKind は種類ごとの件数
 */
function summarizeRequests({ days = 30 } = {}) {
  const rows = readRequests({ days, limit: 100000 });
  const byKind = {};
  const byLabel = {};
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const key = `${r.kind}:${r.label}`;
    byLabel[key] = (byLabel[key] || 0) + 1;
  }
  const top = Object.entries(byLabel).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, n]) => { const i = k.indexOf(':'); return { kind: k.slice(0, i), label: k.slice(i + 1), count: n }; });
  return { total: rows.length, days, byKind, top };
}

module.exports = { recordRequest, readRequests, summarizeRequests, KINDS, REQUESTS_PATH };
