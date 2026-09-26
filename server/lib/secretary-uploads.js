/**
 * @file 秘書へ添付されたファイルの保存・取得・削除
 *
 * ファイルは HTTP（routes/secretary-upload-routes.js）で受け取り、ここでは保存・取得・削除だけを行う
 * （分析は secretary-tools.js の analyze_uploaded_file が Gemini に渡して行う）。
 *
 * 本体（<fileId>.bin）とメタデータ（<fileId>.json。mimeType・元のファイル名）を別々に保存する。
 * 拡張子から種類を推測すると、元のファイル名の拡張子が違う・無いときに壊れるため。
 *
 * 形式の可否はここで判断せず、サイズの上限だけを確かめる。対応していない形式なら、分析のときに
 * Gemini がエラーを返し、それがリスナーに伝わる（Gemini の対応形式は広がり続けているため）。
 *
 * ATTENTION: 決算書のような機密性の高い文書を想定しているので、ファイルは秘書との会話が終わった
 *            時点で削除する。会話とファイルの対応は secretary-live-routes.js が持ち、終了時に
 *            deleteUploads を呼ぶ（このモジュールは会話の概念を持たない）。
 *
 * 保存先: data/secretary/uploads/
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
const crypto = require('crypto');
const { getLogger } = require('../logger');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'secretary', 'uploads');
/** fileId の形式（UUID）。これ以外はパスとして使わない（フォルダーの外を指されないように）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ファイルの大きさの上限（Gemini の上限 50MB より十分小さくしている）。 */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** @param {string} fileId @returns {string} 本体のパス */
function _binPath(fileId) { return path.join(UPLOADS_DIR, `${fileId}.bin`); }
/** @param {string} fileId @returns {string} メタデータのパス */
function _metaPath(fileId) { return path.join(UPLOADS_DIR, `${fileId}.json`); }

/**
 * 添付されたファイルを保存する。
 * @param {Buffer} buffer ファイルの中身
 * @param {string} originalName 元のファイル名（空なら fileId を使う）
 * @param {string} mimeType
 * @returns {{ fileId: string, mimeType: string, originalName: string }}
 * @throws {Error} 大きさが上限を超えたとき
 */
function saveUpload(buffer, originalName, mimeType) {
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`ファイルサイズが上限（${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB）を超えています。`);
  }
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fileId = crypto.randomUUID();
  fs.writeFileSync(_binPath(fileId), buffer);
  writeJsonFile(_metaPath(fileId), {
    mimeType, originalName: originalName || fileId, uploadedAt: new Date().toISOString(),
  }, { spaces: 0 });
  getLogger().info(`[SecretaryUploads] ファイルを保存: ${fileId}（${originalName}, ${mimeType}, ${buffer.length}バイト）`);
  return { fileId, mimeType, originalName: originalName || fileId };
}

/**
 * 保存したファイルを読む。
 * @param {string} fileId
 * @returns {{ buffer: Buffer, mimeType: string, originalName: string } | null} 無い・形式が違う・読めないときは null
 */
function getUpload(fileId) {
  if (!UUID_RE.test(fileId || '')) return null;
  const binPath = _binPath(fileId);
  const metaPath = _metaPath(fileId);
  if (!fs.existsSync(binPath) || !fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    return { buffer: fs.readFileSync(binPath), mimeType: meta.mimeType, originalName: meta.originalName };
  } catch (e) {
    getLogger().warn(`[SecretaryUploads] メタデータの読み込みに失敗: ${fileId} — ${e.message}`);
    return null;
  }
}

/**
 * 保存したファイル（本体とメタデータ）を削除する。失敗しても例外は出さない。
 * @param {string} fileId
 */
function deleteUpload(fileId) {
  if (!UUID_RE.test(fileId || '')) return;
  for (const p of [_binPath(fileId), _metaPath(fileId)]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      getLogger().warn(`[SecretaryUploads] ファイル削除に失敗: ${fileId} — ${e.message}`);
    }
  }
  getLogger().info(`[SecretaryUploads] ファイルを削除: ${fileId}`);
}

/**
 * 複数のファイルを削除する（会話の終了時にまとめて消す）。
 * @param {string[]} fileIds
 */
function deleteUploads(fileIds) {
  for (const fileId of fileIds) deleteUpload(fileId);
}

module.exports = { saveUpload, getUpload, deleteUpload, deleteUploads, MAX_FILE_SIZE_BYTES };
