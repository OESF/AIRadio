/**
 * @file 資産の自動取り込み（ブラウザの拡張機能から届く口座のデータ）の一時置き場
 *
 * 楽天証券と PayPay 銀行は別々のページなので、データは1社ずつ別々のときに届く。届いたものをここに置き、
 * 週次の資産レポート（secretary-tools-finance.js の updateFinanceReport）を作るときに両社分を合わせる。
 *
 * ATTENTION: 届いた時点で finance-snapshots に書かないこと。finance-snapshots は追記式で、同じ週に2件入ると
 *            対前週比が「今週と今週」の比較になり、全銘柄が0%になる（実際に起きた）。書き込みは
 *            updateFinanceReport の1本だけにして、ここは最新の材料の置き場にとどめる。
 * ATTENTION: 受け取った生の HTML・CSV を残さないこと。PayPay 銀行のページにはセッションのトークンと氏名が
 *            含まれる。解析した結果だけを保存する（例外は、解析に失敗したときに routes/finance-import-routes.js が
 *            診断のために残す last-failure-<source>.bin の1件だけ。次に成功したら消える）。
 *
 * 主な利用元: routes/finance-import-routes.js（受け取り）・lib/secretary-tools-finance.js（レポート）・lib/secretary-loop.js
 * 保存先: data/finance-import/<source>.json（金融機関ごとに最新の1件）
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

const IMPORT_DIR = path.join(__dirname, '..', 'data', 'finance-import');

/** 対応する金融機関。キーはURLの一部にもなるので英小文字のみ。 */
const SOURCES = {
  rakuten: { institution: '楽天証券' },
  paypay: { institution: 'PayPay銀行' },
};

/** @param {string} source @returns {boolean} 対応している金融機関か */
function isKnownSource(source) {
  return Object.prototype.hasOwnProperty.call(SOURCES, source);
}

/** @param {string} source @returns {string} 保存先のパス */
function _pathFor(source) {
  return path.join(IMPORT_DIR, `${source}.json`);
}

/**
 * 解析した資産データを保存する（同じ金融機関の前回分は置き換える）。
 * @param {string} source 'rakuten' | 'paypay'
 * @param {Record<string, any>} parsed finance-import.js の解析結果
 * @returns {object} 保存した内容
 * @throws {Error} 対応していない金融機関のとき
 */
function saveImport(source, parsed) {
  if (!isKnownSource(source)) throw new Error(`未知の取り込み元です: ${source}`);
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  const record = {
    source,
    institution: parsed.institution,
    receivedAt: new Date().toISOString(),
    asOf: parsed.asOf || null,
    totalAssets: parsed.totalAssets ?? null,
    totalGainLoss: parsed.totalGainLoss ?? null,
    holdings: parsed.holdings || [],
    sourceLabel: parsed.sourceLabel || null,
    warnings: parsed.warnings || [],
  };
  writeJsonFile(_pathFor(source), record);
  return record;
}

/**
 * 保存したデータを読む。
 * @param {string} source
 * @returns {Record<string, any>|null} 無い・壊れているときは null
 */
function readImport(source) {
  if (!isKnownSource(source)) return null;
  try {
    return JSON.parse(fs.readFileSync(_pathFor(source), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 受け取ってから何日たったか。
 * @param {Record<string, any>|null} record
 * @returns {number|null} 受け取った時刻が無ければ null
 */
function ageInDays(record) {
  if (!record?.receivedAt) return null;
  const ms = Date.now() - new Date(record.receivedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * 週次レポートに使える新しいデータと、古くなったデータを分けて返す。
 *
 * 古いものを黙って使い続けると、拡張機能が止まっていることに気づけないまま、何週間も同じ資産額が
 * レポートされる。既定の8日は「週1回の運用なら必ず新しくなるが、1回でも抜けたら古くなる」長さ。
 * @param {{maxAgeDays?: number}} [opts]
 * @returns {{fresh: Object<string, object>, stale: Object<string, object>}} 金融機関 → データ
 */
function readFreshImports({ maxAgeDays = 8 } = {}) {
  const fresh = {};
  const stale = {};
  for (const source of Object.keys(SOURCES)) {
    const rec = readImport(source);
    if (!rec) continue;
    const age = ageInDays(rec);
    if (age != null && age <= maxAgeDays) fresh[source] = rec;
    else stale[source] = rec;
  }
  return { fresh, stale };
}

/**
 * 何がいつ届いているかの一覧（確かめるためのもの。保有の明細そのものは含めない）。
 * @returns {Array<Record<string, any>>}
 */
function summarize() {
  return Object.keys(SOURCES).map((source) => {
    const rec = readImport(source);
    if (!rec) return { source, institution: SOURCES[source].institution, received: false };
    const age = ageInDays(rec);
    return {
      source,
      institution: rec.institution,
      received: true,
      receivedAt: rec.receivedAt,
      ageInDays: age == null ? null : Math.round(age * 10) / 10,
      asOf: rec.asOf,
      totalAssets: rec.totalAssets,
      totalGainLoss: rec.totalGainLoss,
      holdingsCount: (rec.holdings || []).length,
      warnings: rec.warnings || [],
    };
  });
}

module.exports = {
  SOURCES,
  IMPORT_DIR,
  isKnownSource,
  saveImport,
  readImport,
  readFreshImports,
  summarize,
};
