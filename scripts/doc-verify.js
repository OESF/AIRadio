#!/usr/bin/env node
/**
 * @file コメントだけを変えたことを確かめる（動作が変わっていないことの検査）
 *
 * 指定したファイルを、作業ツリーの内容と比較元（既定は HEAD）の内容の両方で構文解析し、
 * コメントと空白を除いた字句（識別子・文字列・テンプレートリテラル・記号など）の並びが
 * 完全に一致するかを調べる。一致すれば、変わったのはコメントと空白だけで、動作は同じ。
 * プロンプトの文字列（テンプレートリテラル）を誤って書き換えた場合も、ここで検出できる。
 *
 * 構文解析には client/node_modules の TypeScript を使う（サーバー側に解析器が無いため）。
 *
 * 使い方:
 *   node scripts/doc-verify.js <file> [<file> ...]           HEAD と比較する
 *   node scripts/doc-verify.js --base <rev> <file> [...]      指定したコミットと比較する
 *
 * 終了コード: すべて一致なら 0、一つでも不一致・エラーがあれば 1。
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

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ts = require(path.join(ROOT, 'client', 'node_modules', 'typescript'));

/**
 * ソースを字句の並びに変換する。コメントと空白は含まれない。
 * @param {string} fileName 拡張子で JS/TS/TSX を判定する
 * @param {string} text
 * @returns {string[]} 「種類:字面」の配列
 */
function tokensOf(fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (node) => {
    // ATTENTION: JS ファイルでは JSDoc も構文木の子として現れる。JSDoc はコメントなので比較から外す。
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) out.push(`${ts.SyntaxKind[node.kind]}:${node.getText(sf)}`);
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  return out;
}

function readBase(rev, file) {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  let base = 'HEAD';
  const bi = args.indexOf('--base');
  if (bi >= 0) { base = args[bi + 1]; args.splice(bi, 2); }
  if (args.length === 0) {
    console.error('使い方: node scripts/doc-verify.js [--base <rev>] <file> [<file> ...]');
    process.exit(1);
  }

  let failed = 0;
  for (const arg of args) {
    const file = path.relative(ROOT, path.resolve(arg));
    const before = readBase(base, file);
    if (before === null) { console.log(`－ ${file}: ${base} に無い（新規ファイル）ため比較しない`); continue; }
    const a = tokensOf(file, before);
    const b = tokensOf(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const n = Math.max(a.length, b.length);
    let diffAt = -1;
    for (let i = 0; i < n; i++) { if (a[i] !== b[i]) { diffAt = i; break; } }
    if (diffAt < 0) {
      console.log(`✓ ${file}: コードは同一（字句 ${a.length} 個）`);
    } else {
      failed += 1;
      console.log(`✗ ${file}: ${diffAt + 1} 個目の字句から食い違う`);
      console.log(`    比較元: ${a.slice(diffAt, diffAt + 3).join('  ')}`);
      console.log(`    作業中: ${b.slice(diffAt, diffAt + 3).join('  ')}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
