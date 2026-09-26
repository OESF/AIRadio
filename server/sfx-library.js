/**
 * @file 効果音（assets/sfx/*.mp3）のデコードとキャッシュ（全チャンネル共有）
 *
 * 初めて使うときにそのファイルだけを PCM にデコードし、以降はメモリ上のものを使い回す。
 * LLM が台本に効果音のタグを書き、そのタグ名で音を引く。
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

const fs = require('fs');
const path = require('path');
const { decodeToPcm16MonoOnce } = require('../utils/audio-decoder');
const { getLogger } = require('./logger');

const SFX_DIR = path.join(__dirname, 'assets', 'sfx');

/** 効果音名 → PCM */
const pcmCache = new Map();
/** 効果音名 → デコード中の Promise（同じ音を同時に何度もデコードしないため） */
const decodingPromises = new Map();

/**
 * ファイル名（拡張子なし）を、小文字・アンダースコア区切りのタグ名にする（例: "Door Bell" → door_bell）。
 * @param {string} fileBaseName
 * @returns {string}
 */
function normalizeName(fileBaseName) {
  return fileBaseName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * assets/sfx/ の .mp3 を一覧する。フォルダーが無ければ空。
 * @returns {Array<{name: string, filePath: string}>}
 */
function _listSfxFiles() {
  let files = [];
  try {
    files = fs.readdirSync(SFX_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));
  } catch {
    return [];
  }
  return files.map(f => ({
    name: normalizeName(path.basename(f, path.extname(f))),
    filePath: path.join(SFX_DIR, f),
  }));
}

/**
 * 使える効果音名の一覧（プロンプトで LLM に示すため）。
 * @returns {string[]}
 */
function listSfxNames() {
  return _listSfxFiles().map(f => f.name);
}

/**
 * 効果音名から PCM（s16le・24kHz・モノラル）を返す。
 * @param {string} name 効果音名
 * @returns {Promise<Buffer|null>} 無い名前（LLM のタグの書き間違いなど）やデコードの失敗は null。
 *   呼び出し側は無視すればよい
 */
async function getSfxPcm(name) {
  if (pcmCache.has(name)) return pcmCache.get(name);

  const entry = _listSfxFiles().find(f => f.name === name);
  if (!entry) return null;

  if (!decodingPromises.has(name)) {
    decodingPromises.set(name, decodeToPcm16MonoOnce(entry.filePath)
      .then(buf => { pcmCache.set(name, buf); return buf; })
      .catch(err => {
        getLogger().error(`[SFX] "${name}" のデコードに失敗しました: ${err.message}`);
        return null;
      })
      .finally(() => decodingPromises.delete(name)));
  }
  return decodingPromises.get(name);
}

/**
 * 全ての効果音を先にデコードしておく（初めて鳴らすときの遅れをなくすため、起動時に呼ぶ）。
 * @returns {Promise<void>}
 */
async function warmUp() {
  await Promise.all(listSfxNames().map(name => getSfxPcm(name)));
}

module.exports = { getSfxPcm, listSfxNames, warmUp };
