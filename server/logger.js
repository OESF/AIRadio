/**
 * @file サーバー全体のログ（pino・ファイルは日ごとに切り替えて7日分を残す）
 *
 *   - ファイル: logs/server.<日付>.<番号>.log に全レベル（debug 以上）を JSON Lines で書く。
 *               日ごと、または 20MB を超えたら次のファイルへ切り替え、7世代を残す
 *   - 画面（コンソール）: info 以上を、色付きの読みやすい形で出す
 * レベル: trace(10)・debug(20)・info(30)・warn(40)・error(50)・fatal(60)
 *
 * createLogger を呼ぶまでは、console に出すだけの代わりのロガーが使われる（debug と trace は出さない）。
 *
 * 主な利用元: サーバーのほぼ全てのファイル（getLogger）・routes/log-routes.js（ログの閲覧）
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

const pino   = require('pino');
const pinoRoll = require('pino-roll');
const path   = require('path');
const fs     = require('fs');
const { Writable } = require('stream');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/** レベルの数値 → 表示名。 */
const LEVEL_LABEL = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** コンソールでのレベルごとの色（ANSI エスケープ）。 */
const COLORS = {
  10: '\x1b[90m', // gray    TRACE
  20: '\x1b[36m', // cyan    DEBUG
  30: '\x1b[32m', // green   INFO
  40: '\x1b[33m', // yellow  WARN
  50: '\x1b[31m', // red     ERROR
  60: '\x1b[35m', // magenta FATAL
};
const RESET = '\x1b[0m';

/** pino の JSON を「[時刻] レベル 本文」の形にしてコンソールへ出す。JSON でなければそのまま出す。 */
const consoleStream = new Writable({
  write(chunk, _enc, cb) {
    try {
      const e = JSON.parse(chunk.toString().trim());
      const color = COLORS[e.level] ?? '';
      const label = (LEVEL_LABEL[e.level] ?? '?????').padEnd(5);
      const time  = new Date(e.time).toLocaleTimeString('ja-JP', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const extra = e.err
        ? `\n  ${e.err.stack || e.err.message}`
        : '';
      process.stdout.write(`${color}[${time}] ${label}${RESET} ${e.msg || ''}${extra}\n`);
    } catch {
      process.stdout.write(chunk);
    }
    cb();
  },
});

/** 今のロガー。createLogger を呼ぶまでは console に出すだけの代わりのもの。 */
let _logger = {
  trace: (...a) => {},
  debug: (...a) => {},
  info:  (...a) => console.log('[INFO]',  ...a),
  warn:  (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]',...a),
  fatal: (...a) => console.error('[FATAL]',...a),
};

/**
 * ロガーを作る。サーバーの起動時に1回だけ await して呼ぶ。
 * @returns pino のロガー
 */
async function createLogger() {
  // ファイル名は <名前>.<日付>.<番号>.log（例: server.2026-05-29.1.log）
  const dest = await pinoRoll({
    file:       path.join(LOG_DIR, 'server.log'),
    frequency:  'daily',
    dateFormat: 'yyyy-MM-dd',
    // BUGFIX: removeOtherLogFiles を外さないこと。pino-roll は既定では自分のプロセスが作ったファイルしか
    //         消さないので、再起動をまたいだ古いログが消えずに溜まり続けた。true なら毎回フォルダーを調べて、
    //         7世代を超えた分を消す
    limit:      { count: 7, removeOtherLogFiles: true },
    size:       '20m',        // 20MB を超えたら、日の途中でも次のファイルへ
    mkdir:      true,
  });

  _logger = pino(
    {
      level:     'debug',
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: { err: pino.stdSerializers.err },
    },
    pino.multistream([
      { stream: dest,          level: 'debug' },
      { stream: consoleStream, level: 'info'  },
    ])
  );

  _logger.info('[Logger] ロガーを初期化しました (logs/server.log, 日次ローテート, 7世代保持)');
  return _logger;
}

/**
 * 今のロガーを返す（createLogger の前は console に出すだけの代わりのもの）。
 */
function getLogger() { return _logger; }

/** @returns {string} ログのフォルダーの絶対パス */
function getLogDir() { return LOG_DIR; }

module.exports = { createLogger, getLogger, getLogDir, LEVEL_LABEL };
