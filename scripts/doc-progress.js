#!/usr/bin/env node
/**
 * @file コメント整理の進み具合を表示する
 *
 * ファイルヘッダーに `@doc-reviewed` の行があるものを「整理済み」、`@doc-partial` の行があるものを
 * 「途中」（大きいファイルを何回かに分けて整理している最中）として数え、領域（server/lib・server/routes など）
 * ごとの件数と、途中・未整理のファイル一覧を表示する。
 * 進み具合は各ファイルの目印だけを正とし、別の管理表は持たない。
 *
 * 使い方:
 *   node scripts/doc-progress.js          領域ごとの集計と、未整理のファイル（行数の少ない順）
 *   node scripts/doc-progress.js --done   整理済みのファイル一覧も表示する
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

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKER = '@doc-reviewed';
const PARTIAL_MARKER = '@doc-partial';
/** ヘッダーとみなす先頭の行数。目印はヘッダーの中にだけ置く。 */
const HEADER_LINES = 100;

/** 対象にするファイル（git で管理しているもののうち、自分たちが書いたソース）。 */
function listTargets() {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter((f) =>
    /\.(js|ts|tsx)$/.test(f)
    && !f.includes('node_modules/')
    && !f.endsWith('.d.ts')
    && (f.startsWith('server/') || f.startsWith('client/src/') || f.startsWith('scripts/') || f.startsWith('utils/')));
}

/** 表示用の領域名（server/lib/foo.js → server/lib）。 */
function areaOf(file) {
  const parts = file.split('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
}

function main() {
  const showDone = process.argv.includes('--done');
  const rows = listTargets().map((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const header = text.split('\n', HEADER_LINES).join('\n');
    const partialLine = header.split('\n').find((l) => l.includes(PARTIAL_MARKER));
    return {
      file,
      area: areaOf(file),
      lines: text.split('\n').length,
      done: header.includes(MARKER),
      partial: partialLine ? partialLine.slice(partialLine.indexOf(PARTIAL_MARKER) + PARTIAL_MARKER.length).trim() : null,
    };
  });

  const areas = new Map();
  for (const r of rows) {
    const a = areas.get(r.area) || { done: 0, total: 0 };
    a.total += 1;
    if (r.done) a.done += 1;
    areas.set(r.area, a);
  }

  const doneCount = rows.filter((r) => r.done).length;
  const pct = rows.length ? Math.round((doneCount / rows.length) * 100) : 0;
  const sumLines = (list) => list.reduce((n, r) => n + r.lines, 0);
  const totalLines = sumLines(rows);
  const doneLines = sumLines(rows.filter((r) => r.done));
  const linePct = totalLines ? Math.round((doneLines / totalLines) * 100) : 0;
  console.log(`整理済み ${doneCount} / ${rows.length} ファイル（${pct}%）・${doneLines.toLocaleString()} / ${totalLines.toLocaleString()} 行（${linePct}%）\n`);
  for (const [area, a] of [...areas.entries()].sort()) {
    console.log(`  ${area.padEnd(20)} ${String(a.done).padStart(3)} / ${String(a.total).padStart(3)}`);
  }

  if (showDone) {
    console.log('\n整理済み:');
    for (const r of rows.filter((x) => x.done)) console.log(`  ${r.file}`);
  }

  const partial = rows.filter((x) => !x.done && x.partial);
  if (partial.length) {
    console.log('\n途中（続きから進める）:');
    for (const r of partial) console.log(`  ${String(r.lines).padStart(6)}行  ${r.file}  … ${r.partial}`);
  }

  console.log('\n未整理（行数の少ない順）:');
  for (const r of rows.filter((x) => !x.done && !x.partial).sort((a, b) => a.lines - b.lines)) {
    console.log(`  ${String(r.lines).padStart(6)}行  ${r.file}`);
  }
}

main();
