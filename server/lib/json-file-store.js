/**
 * @file JSON ファイルの読み書き（副作用なし・失敗しても例外を出さない）
 *
 * 秘書・エージェントのメモ・台帳など、多くのモジュールが使う共通の読み書き。
 * 読み込みはファイルが無い・壊れているときに fallback を返し、書き込みは原子的に行う
 * （一時ファイルに書いてから rename するので、途中で強制終了されても壊れた JSON が残らない。
 * atomic-json.js 参照）。
 *
 * ATTENTION: server.js の readJsonFile とは別物で、統合しないこと。あちらはファイルが無いときに
 *            既定値を書き込む副作用がある。こちらは「まだ作られていない」状態を、書き込まずに
 *            fallback を返すことで表す。
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
const { writeJsonFile: writeJsonAtomic } = require('./atomic-json');
const { getLogger } = require('../logger');

/**
 * JSON ファイルを読む。
 * @param {string} filePath
 * @param {*} fallback ファイルが無い・読み込みに失敗したときに返す値
 * @param {string} [logPrefix] 警告ログのラベル（例: '[SecretaryLoop]'）
 * @returns {*}
 */
function readJsonFile(filePath, fallback, logPrefix = '[JsonFileStore]') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    getLogger().warn(`${logPrefix} ${filePath} の読み込みに失敗: ${e.message}`);
    return fallback;
  }
}

/**
 * JSON ファイルを原子的に書く。失敗したら警告ログを出すだけで、例外は出さない。
 * @param {string} filePath
 * @param {*} data
 * @param {string} [logPrefix] 警告ログのラベル
 */
function writeJsonFile(filePath, data, logPrefix = '[JsonFileStore]') {
  try {
    writeJsonAtomic(filePath, data);
  } catch (e) {
    getLogger().warn(`${logPrefix} ${filePath} の保存に失敗: ${e.message}`);
  }
}

module.exports = { readJsonFile, writeJsonFile };
