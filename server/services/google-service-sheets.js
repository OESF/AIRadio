/**
 * @file Google スプレッドシートの読み取り・作成・書き込み・グラフの追加（GoogleService に取り込むメソッド群）
 *
 * 秘書の analyze_google_sheet（シートの分析）と、プレゼンテーション作成のグラフ（スプレッドシートに
 * データとグラフを作り、スライドへリンクで貼る）で使う。認証は google-service.js の _getAccessToken を
 * this 経由で使う。
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

const sheetsMethods = {
  /**
   * スプレッドシートの1つのシート（タブ）の値を取得する（spreadsheets.readonly のスコープが要る）。
   *
   * gid があればそのシート、無ければ先頭のシートを読む。共有される URL は特定のタブを開いた状態
   * （?gid=…）のことが多く、いつも先頭を読むと違うデータを分析してしまうため。
   * @param {Record<string, any>} creds 認証情報
   * @param {{spreadsheetId: string, gid?: string|number|null}} opts
   * @returns {Promise<{spreadsheetTitle: string, sheetTitle: string, rows: string[][]}>}
   * @throws {Error} 読めないとき（原因に応じた対処を書いた文になる）
   */
  async fetchSpreadsheetValues(creds, { spreadsheetId, gid }) {
    const accessToken = await this._getAccessToken(creds);
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties.title,sheets.properties`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (metaRes.status === 403 || metaRes.status === 404) {
      // BUGFIX: 403 の原因は2通りあり、対処が全く違う。エラーの reason を見て案内を分けること。
      //         一律に「共有設定を確認して」と出すと、Google Cloud で Sheets API が無効になっているとき
      //         （SERVICE_DISABLED）にも見当違いの対処（シートの共有設定の変更）をさせてしまった
      let reason = null;
      try {
        const body = await metaRes.json();
        reason = body?.error?.details?.find(d => d.reason)?.reason || null;
      } catch (_) { /* JSON以外のレスポンスは無視してデフォルトメッセージへ */ }
      if (reason === 'SERVICE_DISABLED') {
        throw new Error('Google Cloud側でSheets APIが無効化されています。管理画面のGoogle連携設定に'
          + '記載のプロジェクト番号でSheets APIを有効化してください（スプレッドシート自体の共有設定は'
          + '無関係です）。');
      }
      throw new Error('このスプレッドシートにアクセスできませんでした。共有設定を確認するか、正しいURLか確認してください。');
    }
    if (!metaRes.ok) throw new Error(`Sheets API HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    const sheets = meta.sheets || [];
    const targetSheet = (gid != null)
      ? sheets.find(s => String(s.properties?.sheetId) === String(gid))
      : sheets[0];
    if (!targetSheet) throw new Error('指定されたシート（タブ）が見つかりませんでした。');
    const sheetTitle = targetSheet.properties.title;

    const valuesRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetTitle)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!valuesRes.ok) throw new Error(`Sheets API(値取得) HTTP ${valuesRes.status}`);
    const valuesData = await valuesRes.json();
    return {
      spreadsheetTitle: meta.properties?.title || '',
      sheetTitle,
      rows: valuesData.values || [],
    };
  },

  /**
   * スプレッドシートを作る（グラフのデータの置き場として）。
   * @param {Record<string, any>} creds
   * @param {{title: string, sheetTitle?: string}} opts sheetTitle は最初のシートの名前（既定 Data）
   * @returns {Promise<{spreadsheetId: string, sheets: object[]}>}
   */
  async createSpreadsheet(creds, { title, sheetTitle = 'Data' }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: sheetTitle } }] }),
    });
    if (!res.ok) throw new Error(`Sheets API(作成) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * 値を書き込む（読み取りと違い、spreadsheets の書き込みのスコープが要る）。
   * @param {Record<string, any>} creds
   * @param {{spreadsheetId: string, range: string, values: any[][]}} opts range は "Data!A1" のような形
   * @returns {Promise<object>}
   */
  async writeSpreadsheetValues(creds, { spreadsheetId, range, values }) {
    const accessToken = await this._getAccessToken(creds);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}` +
      '?valueInputOption=USER_ENTERED',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      }
    );
    if (!res.ok) throw new Error(`Sheets API(書き込み) HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  },

  /**
   * グラフを追加して、その chartId を返す（スライドの createSheetsChart にそのまま渡す）。
   * @param {Record<string, any>} creds
   * @param {{spreadsheetId: string, sheetId: number, chartSpec: object}} opts chartSpec はデザインの色を入れた ChartSpec
   * @returns {Promise<number>}
   */
  async addSheetsChart(creds, { spreadsheetId, sheetId, chartSpec }) {
    const accessToken = await this._getAccessToken(creds);
    // BUGFIX: 既存のシートに置くには overlayPosition でセルを指定すること（position: {newSheet: false} は
    //         API に拒否される）。位置と大きさはスライドに貼るときに決まるので、ここは仮に F1 に置くだけ
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          addChart: {
            chart: {
              spec: chartSpec,
              position: { overlayPosition: { anchorCell: { sheetId, rowIndex: 0, columnIndex: 5 } } },
            },
          },
        }],
      }),
    });
    if (!res.ok) throw new Error(`Sheets API(グラフ追加) HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const chartId = data.replies?.[0]?.addChart?.chart?.chartId;
    if (chartId == null) throw new Error('Sheets API(グラフ追加): レスポンスにchartIdが含まれていません');
    return chartId;
  },
};

module.exports = { sheetsMethods };
