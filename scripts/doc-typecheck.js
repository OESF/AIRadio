#!/usr/bin/env node
/**
 * @file コメント整理の前後で、サーバー側 JS の型検査の指摘が増えていないかを比べる
 *
 * 指定したファイルを tsc（client/node_modules の TypeScript、checkJs）で検査し、各ファイル自身の
 * 指摘だけを数える。作業ツリーの内容（整理後）と、対象ファイルだけを一時的に HEAD へ戻した内容
 * （整理前）の両方で検査し、増えた指摘を表示する。行番号は比較から外す。
 *
 * JSDoc の型を書くと、エラー文の中の型の表記が変わることがある。同じ種類の指摘が
 * 表記違いで出入りしているだけなら問題ない。
 *
 * 使い方:
 *   node scripts/doc-typecheck.js <file> [<file> ...]
 *
 * ATTENTION: 対象ファイルを git stash で一時的に戻すため、整理以外の作業中の変更があるファイルには使わない。
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

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TSC = path.join(ROOT, 'client', 'node_modules', '.bin', 'tsc');
const TSC_ARGS = ['--ignoreConfig', '--allowJs', '--checkJs', '--noEmit', '--noUnusedLocals', '--ignoreDeprecations', '6.0'];

/**
 * 対象ファイル自身の指摘を、行番号を除いて返す。
 * @param {string[]} files リポジトリ直下からの相対パス
 * @returns {string[]} 並べ替え済み
 */
function diagnostics(files) {
  const r = spawnSync(TSC, [...TSC_ARGS, ...files], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return (r.stdout || '').split('\n')
    .filter((l) => l.includes('error TS') && files.some((f) => l.startsWith(`${f}(`)))
    .map((l) => l.replace(/\(\d+,\d+\)/, ''))
    .sort();
}

function main() {
  const files = process.argv.slice(2).map((f) => path.relative(ROOT, path.resolve(f)));
  if (files.length === 0) {
    console.error('使い方: node scripts/doc-typecheck.js <file> [<file> ...]');
    process.exit(1);
  }
  const after = diagnostics(files);
  execFileSync('git', ['stash', 'push', '-q', '--', ...files], { cwd: ROOT });
  let before;
  try {
    before = diagnostics(files);
  } finally {
    execFileSync('git', ['stash', 'pop', '-q'], { cwd: ROOT });
  }

  // 同じ指摘が複数あるので、件数で差を取る
  const remaining = new Map();
  for (const d of before) remaining.set(d, (remaining.get(d) || 0) + 1);
  const added = [];
  for (const d of after) {
    const n = remaining.get(d) || 0;
    if (n > 0) remaining.set(d, n - 1); else added.push(d);
  }

  console.log(`対象 ${files.length} ファイル / 整理前 ${before.length} 件 → 整理後 ${after.length} 件`);
  if (added.length === 0) {
    console.log('増えた指摘: なし');
  } else {
    console.log(`増えた指摘（表記違いの出入りを含む）: ${added.length} 件`);
    for (const d of added) console.log(`  ${d.length > 200 ? `${d.slice(0, 200)}…` : d}`);
  }
}

main();
