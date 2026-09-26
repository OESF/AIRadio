/**
 * @file 秘書へのファイル添付を受け取る API（POST /api/secretary/upload-file）
 *
 * Gemini Live の WebSocket とは別の、通常の HTTP（multipart/form-data）で受け取って保存する。
 * 保存後、クライアントが WebSocket で SECRETARY_FILE_UPLOADED を送り、それを受けた
 * secretary-live-routes.js が Gemini Live にファイルの存在を知らせる（このファイルは WebSocket に触れない）。
 *
 * 保存先: lib/secretary-uploads.js が管理する（サイズ上限もそちらで定義）
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

const multer = require('multer');
const secretaryUploads = require('../lib/secretary-uploads');

/**
 * ルートを登録する。応答は `{ fileId, mimeType, fileName }`。
 * @param {import('express').Express} app
 */
function registerSecretaryUploadRoutes(app) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: secretaryUploads.MAX_FILE_SIZE_BYTES },
  });

  app.post('/api/secretary/upload-file', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        // サイズ超過などの multer のエラーも、その他のエラーも 400 で返す
        return res.status(400).json({ error: err.message || 'アップロードに失敗しました' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'ファイルが指定されていません' });
      }
      try {
        // BUGFIX: multer（内部の busboy）はファイル名を常に latin1 として解釈するため、日本語の
        //         ファイル名が文字化けする。送られてくるのは UTF-8 なので、latin1→utf8 で読み直す。
        const originalNameFixed = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const { fileId, mimeType, originalName } = secretaryUploads.saveUpload(
          req.file.buffer, originalNameFixed, req.file.mimetype
        );
        res.json({ fileId, mimeType, fileName: originalName });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  });
}

module.exports = { registerSecretaryUploadRoutes };
