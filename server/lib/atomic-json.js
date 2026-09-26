/**
 * @file JSON ファイルを原子的に（途中で止まっても壊れないように）書く
 *
 * fs.writeFileSync は元のファイルを直接上書きするので、書いている最中にプロセスが強制終了
 * （kill -9）されると、途中までの壊れた JSON が残る。読み込み側の多くは JSON.parse の失敗を
 * 握りつぶして初期値で作り直すので、エラーにならず中身が黙って消える（長期記憶・設定・認証情報など）。
 *
 * そこで、同じフォルダーの一時ファイルに書き切ってから rename で置き換える。rename は同じ
 * ファイルシステムの中では分割されない操作なので、どの時点で止まっても「古い完全なファイル」か
 * 「新しい完全なファイル」のどちらかしか残らない。
 *
 * ATTENTION: 一時ファイルは必ず同じフォルダーに作ること。/tmp などに作ると、ファイルシステムを
 *            またぐ rename がコピーと削除に変わり、分割されない操作ではなくなる。
 *
 * 主な利用元: lib/json-file-store.js をはじめ、JSON を保存するほぼ全てのモジュール
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

/** このプロセスで既に掃除したフォルダー（掃除は1フォルダーにつき1回で足りる）。 */
const _sweptDirs = new Set();
/**
 * これより古い一時ファイルだけを消す。他のプロセスが書いている最中のファイルを巻き込まないための
 * 猶予（書き込みは普通ミリ秒で終わる）。
 */
const _TMP_STALE_MS = 5 * 60 * 1000;

/**
 * 前回の強制終了で残った一時ファイルを片付ける。
 *
 * rename の直前で強制終了されると一時ファイルが残る。害は無いが、放っておくと溜まる。
 * 書き込みのたびにフォルダーを調べると重いので、プロセスごと・フォルダーごとに1回だけ掃除する
 * （起動後の最初の書き込みで、前回の残りが片付く）。失敗しても書き込み本体は止めない。
 * @param {string} dir
 */
function _sweepStaleTemps(dir) {
  if (_sweptDirs.has(dir)) return;
  _sweptDirs.add(dir);
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      // 自分たちが作る形（.<元の名前>.tmp-<pid>-<base36>）だけを対象にする
      if (!name.startsWith('.') || !/\.tmp-\d+-[0-9a-z]+$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > _TMP_STALE_MS) fs.unlinkSync(full);
      } catch { /* 他プロセスが先に消した等。無視してよい */ }
    }
  } catch { /* ディレクトリが読めなくても本体の書き込みは妨げない */ }
}

/**
 * JSON を原子的に書く。使い方は writeFileSync と同じ。フォルダーが無ければ作る。
 *
 * @param {string} filePath 保存先
 * @param {any} data JSON にできる値
 * @param {{spaces?: number, eol?: string, fsync?: boolean}} [opts]
 *   spaces: インデント（既定 2。0 で詰める）
 *   eol: 末尾に付ける文字（既定なし）
 *   fsync: ディスクに確実に書き出してから置き換えるか（既定 true。プロセスの強制終了だけなら
 *          不要だが、電源断まで守るため）
 * @throws {Error} 書き込みに失敗したとき（一時ファイルは消してから投げる）
 */
function writeJsonFile(filePath, data, opts = {}) {
  const { spaces = 2, eol = '', fsync = true } = opts;
  const text = JSON.stringify(data, null, spaces) + eol;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  _sweepStaleTemps(dir);

  // 同じディレクトリに、他のプロセス・並行処理とぶつからない名前で作る
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    if (fsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath); // ここは分割されない。成功か失敗かしかない
  } catch (e) {
    // 失敗しても一時ファイルを残さない（次回の書き込みを邪魔しないため）
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 既に閉じている */ }
    try { fs.unlinkSync(tmp); } catch { /* 作られていない */ }
    throw e;
  }
}

module.exports = { writeJsonFile };
