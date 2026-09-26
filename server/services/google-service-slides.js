/**
 * @file Google スライドの作成・取得・複製・サムネイル・一括更新（GoogleService に取り込むメソッド群）
 *
 * 秘書のプレゼンテーション作成（create_presentation）で使う。スライドのスコープは他の Google Workspace と
 * 同じ通常のスコープなので、認証は google-service.js の _getAccessToken を this 経由で使う。
 *
 * batchUpdate に渡す requests の中身（replaceAllText・duplicateObject・createSheetsChart など）は、
 * 呼び出し元の lib/secretary-tools-presentation.js で組み立てる。ここは1メソッド1機能の薄い層にとどめる。
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

const slidesMethods = {
  /**
   * 空のプレゼンテーションを作る（テンプレートを最初に組み立てる setup-presentation-template.js だけが使う）。
   *
   * ATTENTION: 作ると最初からタイトルのスライドが1枚入っている。レイアウト見本を組み立てる前に消すこと。
   * @param {Record<string, any>} creds 認証情報
   * @param {{title: string}} opts
   * @returns {Promise<{presentationId: string, slides: object[]}>}
   */
  async createPresentation(creds, { title }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch('https://slides.googleapis.com/v1/presentations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`Slides API(新規作成) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * プレゼンテーションを取得する（テンプレートの要素を探す、複製後にグラフを置く位置を調べるなど）。
   * @param {Record<string, any>} creds
   * @param {{presentationId?: string, fields?: string}} [opts] fields で返す項目を絞ると応答が小さくなる
   * @returns {Promise<object>}
   */
  async getPresentation(creds, { presentationId, fields } = {}) {
    const accessToken = await this._getAccessToken(creds);
    const params = fields ? `?fields=${encodeURIComponent(fields)}` : '';
    const res = await fetch(`https://slides.googleapis.com/v1/presentations/${presentationId}${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Slides API(取得) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * プレゼンテーションを複製する（Drive API）。複製元はこのアカウント自身が作ったファイルなので、
   * drive.file のスコープで足りる。
   * @param {Record<string, any>} creds
   * @param {{templateId: string, name: string}} opts
   * @returns {Promise<{id: string, webViewLink: string}>}
   */
  async duplicatePresentation(creds, { templateId, name }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${templateId}/copy?fields=id,webViewLink`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }
    );
    if (!res.ok) throw new Error(`Drive API(複製) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * ページ（スライド・レイアウト・マスターのどれでもよい）のサムネイル画像を base64 で取得する。
   *
   * プレゼンテーション作成の専用ヘルパー（lib/presentation-creator-agent.js）が、画像を見て判断するために使う:
   *   - 自分が作ったスライドを見て直す（文字のあふれ・無駄な余白・同じ形の連続は、構成の JSON を
   *     見ていても気づけない）
   *   - テンプレートのレイアウトを見て使い分ける（プレースホルダーの種類だけでは「3枚のカードで比較」と
   *     「ただの箇条書き」の区別が付かない）
   * 画像の URL は短時間で無効になる署名付きのものなので、その場で取得して base64 にする。
   * @param {Record<string, any>} creds
   * @param {{presentationId: string, pageObjectId: string, size?: string}} opts size は SMALL・MEDIUM・LARGE
   * @returns {Promise<{base64: string, mimeType: string}>}
   */
  async getPageThumbnail(creds, { presentationId, pageObjectId, size = 'MEDIUM' }) {
    const accessToken = await this._getAccessToken(creds);
    const url = `https://slides.googleapis.com/v1/presentations/${presentationId}/pages/${pageObjectId}/thumbnail`
      + `?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=${size}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Slides API(サムネイル) HTTP ${res.status}: ${await res.text()}`);
    const { contentUrl } = await res.json();
    if (!contentUrl) throw new Error('サムネイルのURLが返りませんでした');
    const img = await fetch(contentUrl);
    if (!img.ok) throw new Error(`サムネイル画像の取得に失敗 HTTP ${img.status}`);
    return { base64: Buffer.from(await img.arrayBuffer()).toString('base64'), mimeType: 'image/png' };
  },

  /**
   * batchUpdate を実行する。呼び出し元が組み立てた requests をそのまま渡す。
   * @param {Record<string, any>} creds
   * @param {{presentationId: string, requests: object[]}} opts
   * @returns {Promise<{replies: object[]}>}
   */
  async batchUpdatePresentation(creds, { presentationId, requests }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      }
    );
    if (!res.ok) throw new Error(`Slides API(batchUpdate) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },
};

module.exports = { slidesMethods };
