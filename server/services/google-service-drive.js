/**
 * @file Google ドライブのファイルの作成・更新・画像のアップロード・公開設定（GoogleService に取り込むメソッド群）
 *
 * 秘書の create_drive_file・update_drive_file と、プレゼンテーション作成（生成した画像の挿入、テンプレートの
 * 更新の確認）で使う。認証は google-service.js の _getAccessToken を this 経由で使う。
 * スコープは drive.file なので、このアプリ自身が作った（または明示的に共有された）ファイルしか扱えない。
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

const driveMethods = {
  /**
   * 名前でファイルを探す（ゴミ箱のものは除く）。
   * @param {string} accessToken
   * @param {string} name
   * @returns {Promise<{id: string, name: string}|null>} 見つからなければ null
   */
  async _findDriveFileByName(accessToken, name) {
    const q = `name='${name.replace(/'/g, "\\'")}' and trashed=false`;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) throw new Error(`Drive API(検索) HTTP ${res.status}`);
    const data = await res.json();
    return data.files?.[0] || null;
  },

  /**
   * テキストファイルを作る。
   *
   * TODO: 今はテキスト（.txt）だけ。Google ドキュメントの形式にするには Docs API と追加のスコープが要る。
   * @param {Record<string, any>} creds
   * @param {{name: string, content: string}} opts
   * @returns {Promise<{id: string, name: string, webViewLink: string}>}
   */
  async createDriveFile(creds, { name, content }) {
    const accessToken = await this._getAccessToken(creds);
    const boundary = 'ai_radio_secretary_boundary';
    const metadata = { name, mimeType: 'text/plain' };
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });
    if (!res.ok) throw new Error(`Drive API(作成) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * テキストファイルに追記する、または中身を置き換える。
   * drive.file のスコープなので、秘書が作ったファイルしか見つからない。
   * @param {Record<string, any>} creds
   * @param {{name: string, content: string, mode?: 'append'|'replace'}} opts 既定は追記
   * @returns {Promise<object>}
   * @throws {Error} ファイルが見つからないとき
   */
  async updateDriveFile(creds, { name, content, mode = 'append' }) {
    const accessToken = await this._getAccessToken(creds);
    const file = await this._findDriveFileByName(accessToken, name);
    if (!file) throw new Error(`Driveファイル「${name}」が見つかりませんでした（Secretaryが作成したファイルのみ操作できます）`);

    let newContent = content;
    if (mode === 'append') {
      const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const existing = getRes.ok ? await getRes.text() : '';
      newContent = existing ? `${existing}\n${content}` : content;
    }
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain; charset=UTF-8' },
      body: newContent,
    });
    if (!res.ok) throw new Error(`Drive API(更新) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * ファイルの最終更新時刻を取得する。
   *
   * プレゼンテーションのテンプレートが編集されたかを安く確かめるために使う（テンプレートの中身と
   * サムネイルを取り直すと23往復・1.5秒かかるが、これは1往復で済む）。
   * @param {Record<string, any>} creds
   * @param {{fileId: string}} opts
   * @returns {Promise<string|null>} ISO 形式の時刻
   */
  async getFileModifiedTime(creds, { fileId }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=modifiedTime`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Drive API(更新時刻) HTTP ${res.status}`);
    const { modifiedTime } = await res.json();
    return modifiedTime || null;
  },

  /**
   * base64 の画像をアップロードする（プレゼンテーションに生成した画像を入れるため）。
   *
   * ATTENTION: 画像を文字列として連結すると中のバイトが壊れる。base64 のまま送り、
   *            Content-Transfer-Encoding: base64 で Google 側に戻してもらう。
   * @param {Record<string, any>} creds
   * @param {{name: string, base64Data: string, mimeType?: string}} opts
   * @returns {Promise<{id: string, name: string}>}
   */
  async uploadImageToDrive(creds, { name, base64Data, mimeType = 'image/png' }) {
    const accessToken = await this._getAccessToken(creds);
    const boundary = 'ai_radio_secretary_image_boundary';
    const metadata = { name, mimeType };
    const multipartBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Data}\r\n` +
      `--${boundary}--`;
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipartBody,
    });
    if (!res.ok) throw new Error(`Drive API(画像アップロード) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * ファイルを「リンクを知っている全員が見られる」にする。
   *
   * ATTENTION: スライドに画像を入れる（createImage）前に呼ぶこと。スライドの API は画像の URL を
   *            ログインなしで取りに行くので、この権限が無いと失敗する。
   * @param {Record<string, any>} creds
   * @param {{fileId: string}} opts
   * @returns {Promise<object>}
   */
  async makeFilePublicReadable(creds, { fileId }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    if (!res.ok) throw new Error(`Drive API(権限設定) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },
};

module.exports = { driveMethods };
