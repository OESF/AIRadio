/**
 * @file 秘書のキャンバスの内容を Obsidian に保存する API（POST /api/secretary/canvas-to-obsidian）
 *
 * キャンバス（秘書がグラフや表を映す画面）は会話が終わると消える。「残しておきたい」かどうかは
 * 見た本人にしか分からないので、AI の判断ではなく、リスナーがボタンを押したときに保存する。
 *
 * 画像はファイルとして Vault に書き出してノートから参照し、本文と合わせて1つのノートにする。
 *
 * ATTENTION: 保存先は 01_Notes（notes_folder）にすること。00_Inbox は secretary-inbox.js が見張っていて、
 *            置くと自動処理が始まってしまう。
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

const path = require('path');
const obsidianService = require('../services/obsidian-service');
const { getLogger } = require('../logger');

/**
 * 題名からファイル名を作る。ファイル名に使えない文字と、Obsidian のリンク記法を壊す文字を除き、60文字までにする。
 * @param {string} [title]
 * @returns {string} 空なら「Secretaryのメモ」
 */
function _safeFileName(title) {
  const base = String(title || '').trim().replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').slice(0, 60);
  return base || 'Secretaryのメモ';
}

/** @param {Date} [d] @returns {string} 「YYYY-MM-DD」 */
function _stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** @param {Date} [d] @returns {string} 「HHMM」 */
function _timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * ルートを登録する。body: { title, content, imageBase64, imageMime }（content か画像のどちらかは必須）。
 * @param {import('express').Express} app
 * @param {{readJsonFile: Function, getInitialConfig: Function, CONFIG_PATH: string}} ctx
 */
function registerSecretaryCanvasRoutes(app, { readJsonFile, getInitialConfig, CONFIG_PATH }) {
  app.post('/api/secretary/canvas-to-obsidian', (req, res) => {
    try {
      const config = readJsonFile(CONFIG_PATH, getInitialConfig());
      const obs = config.obsidian || {};
      if (!obs.enabled || !obs.vault_path) {
        return res.status(400).json({ error: 'Obsidian連携が有効になっていません（管理画面で設定してください）。' });
      }

      const { title, content, imageBase64, imageMime } = req.body || {};
      if (!content && !imageBase64) {
        return res.status(400).json({ error: '保存する内容がありません。' });
      }

      const now = new Date();
      const notesFolder = obs.notes_folder || '01_Notes';
      const name = _safeFileName(title);
      // 同じ話題を何度も保存することがあるので、日付と時刻でファイル名を分ける
      const relPath = path.posix.join(notesFolder, `${_stamp(now)} ${name} ${_timeStamp(now)}.md`);

      let body = '';
      // 画像は Vault にファイルとして書き出して参照する（base64 のまま埋めると Obsidian で読めない）
      if (imageBase64) {
        const assetFolder = obs.canvas_asset_folder || '20_asset_data/secretary';
        const ext = String(imageMime || 'image/png').includes('jpeg') ? 'jpg' : 'png';
        const assetRel = path.posix.join(assetFolder, `${_stamp(now)}-${_timeStamp(now)}-${name}.${ext}`);
        obsidianService.writeBinaryAsset(obs.vault_path, assetRel, Buffer.from(imageBase64, 'base64'));
        body += `![[${assetRel}]]\n\n`;
      }
      if (content) body += `${String(content).trim()}\n`;

      obsidianService.writeNote(obs.vault_path, relPath, {
        // ノートの frontmatter の決まり（タイトル・出典・日付・タグ）に合わせる
        frontmatter: {
          title: title || 'Secretaryのメモ',
          source: 'My Secretary（キャンバス）',
          date: _stamp(now),
          tags: ['secretary', 'canvas'],
        },
        body,
      });

      getLogger().info(`[SecretaryCanvas] キャンバスをObsidianへ保存: ${relPath}`);
      res.json({ ok: true, path: relPath });
    } catch (e) {
      getLogger().warn(`[SecretaryCanvas] Obsidianへの保存に失敗: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { registerSecretaryCanvasRoutes };
