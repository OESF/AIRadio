/**
 * @file 資産の自動取り込みの受け口（ブラウザの拡張機能 Tampermonkey から口座のデータを受け取る）
 *
 * 証券会社・銀行のページを開いてボタンを押すと、拡張機能がデータを送ってくる。
 *   - POST /api/finance-import/:source          … 受け取って解析し、保存する（lib/finance-import-store.js）
 *   - GET  /api/finance-import/status           … 何がいつ届いているか
 *   - GET  /tampermonkey/:name.user.js          … 拡張機能のスクリプトの配信（開くとインストール画面が出る）
 *
 * ATTENTION: 守りを外さないこと。
 *   1. credentials.json の共有トークン（X-Import-Token）が一致しないと受け付けない。カスタムヘッダーを付けた
 *      リクエストはブラウザが事前確認（preflight）をするので、悪意のあるページが裏で偽の資産データを
 *      送り込むことも防げる（ヘッダーの無い単純な POST は事前確認なしで届いてしまう）
 *   2. 既定では localhost からしか受け付けない（ngrok で外に公開されていることがあるため）
 * ATTENTION: 受け取った生のデータは、解析したら捨てる（PayPay 銀行のページにはセッションのトークンと
 *            氏名が含まれる）。ログにも出さない。例外は解析に失敗したときの診断用の1件だけ（下を参照）。
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
const { getLogger } = require('../logger');
const { parseRakutenCsv, parsePayPayBankHtml } = require('../lib/finance-import');
const financeImportStore = require('../lib/finance-import-store');

const USERSCRIPT_DIR = path.join(__dirname, '..', 'tampermonkey');

/**
 * 同じ PC（ループバック）からのアクセスか。IPv6 と、IPv4 を IPv6 の形にしたものの両方を見る。
 * @param {{socket?: {remoteAddress?: string}}} req
 * @returns {boolean}
 */
function isLoopback(req) {
  const raw = req.socket?.remoteAddress || '';
  const addr = raw.replace(/^::ffff:/, '');
  return addr === '127.0.0.1' || addr === '::1' || raw === '::1';
}

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{readJsonFile: Function, getInitialCredentials: Function, CREDENTIALS_PATH: string, port?: number}} ctx
 */
function registerFinanceImportRoutes(app, ctx) {
  const { readJsonFile, getInitialCredentials, CREDENTIALS_PATH } = ctx;

  const settings = () => (readJsonFile(CREDENTIALS_PATH, getInitialCredentials())?.finance_import) || {};

  /**
   * 共通の守り（トークン・接続元）。通してよければ false、拒否して応答を返したら true。
   * 拒否した理由も応答に書く（自分で原因を切り分けられるように。localhost 限定なので外には漏れない）。
   */
  const guard = (req, res) => {
    const cfg = settings();
    if (!cfg.token) {
      res.status(503).json({ error: 'credentials.json に finance_import.token が設定されていません' });
      return true;
    }
    if (!cfg.allow_remote && !isLoopback(req)) {
      getLogger().warn('[FinanceImport] localhost以外からのアクセスを拒否しました');
      res.status(403).json({ error: 'localhost以外からは受け付けません' });
      return true;
    }
    if (req.get('X-Import-Token') !== cfg.token) {
      getLogger().warn('[FinanceImport] トークンが一致しないリクエストを拒否しました');
      res.status(401).json({ error: 'トークンが一致しません' });
      return true;
    }
    return false;
  };

  // 受け取り。本文は { encoding: 'base64' | 'text', payload } の JSON にそろえる（楽天の CSV は Shift_JIS の
  // バイト列なので base64、PayPay の HTML は文字列なので text）。バイト列をそのまま POST すると、
  // 拡張機能の GM_xmlhttpRequest の実装の違いでつまずきやすいため
  app.post('/api/finance-import/:source', (req, res) => {
    if (guard(req, res)) return;

    const source = String(req.params.source || '').toLowerCase();
    if (!financeImportStore.isKnownSource(source)) {
      return res.status(404).json({ error: `未知の取り込み元です: ${source}` });
    }

    const { encoding, payload, sourceUrl } = req.body || {};
    if (typeof payload !== 'string' || payload.length === 0) {
      return res.status(400).json({ error: 'payload が空です' });
    }

    let parsed;
    try {
      if (source === 'rakuten') {
        if (encoding !== 'base64') return res.status(400).json({ error: '楽天証券のCSVは base64 で送ってください' });
        parsed = parseRakutenCsv(Buffer.from(payload, 'base64'));
      } else {
        parsed = parsePayPayBankHtml(encoding === 'base64' ? Buffer.from(payload, 'base64') : payload);
      }
    } catch (e) {
      // ATTENTION: 解析できないものを0件として通さないこと。間違った資産額が黙って記録される。必ず失敗を返す。
      // 診断のため、失敗したときだけ受け取った生データを1件残す（「CSV のつもりがログイン画面の HTML だった」
      // などは中身を見ないと分からない）。次に成功したら消す
      try {
        fs.mkdirSync(financeImportStore.IMPORT_DIR, { recursive: true });
        const raw = encoding === 'base64' ? Buffer.from(payload, 'base64') : Buffer.from(payload, 'utf8');
        fs.writeFileSync(path.join(financeImportStore.IMPORT_DIR, `last-failure-${source}.bin`), raw);
      } catch { /* 診断の失敗で本体を巻き込まない */ }
      getLogger().warn(`[FinanceImport] ${source} の解析に失敗: ${e.message}`
        + `${sourceUrl ? ` / 取得元: ${sourceUrl}` : ''}`);
      return res.status(422).json({ error: e.message, sourceUrl: sourceUrl || null });
    }

    try { fs.unlinkSync(path.join(financeImportStore.IMPORT_DIR, `last-failure-${source}.bin`)); } catch { /* 無ければ何もしない */ }
    const record = financeImportStore.saveImport(source, parsed);
    getLogger().info(
      `[FinanceImport] ${record.institution} を受け取りました（${record.holdings.length}件・`
      + `資産合計${record.totalAssets == null ? '不明' : record.totalAssets.toLocaleString('ja-JP')}円）`
    );
    if (record.warnings.length) {
      getLogger().warn(`[FinanceImport] ${record.institution}: ${record.warnings.join(' / ')}`);
    }

    res.json({
      ok: true,
      institution: record.institution,
      asOf: record.asOf,
      totalAssets: record.totalAssets,
      totalGainLoss: record.totalGainLoss,
      holdingsCount: record.holdings.length,
      warnings: record.warnings,
    });
  });

  // 何がいつ届いているか（拡張機能の表示と、確かめるために使う）
  app.get('/api/finance-import/status', (req, res) => {
    if (guard(req, res)) return;
    res.json({ sources: financeImportStore.summarize() });
  });

  // 拡張機能のスクリプトの配信。.user.js で終わる URL を開くと Tampermonkey がインストール画面を出す
  // （スクリプトの @version を上げれば、以後は自動で更新される）。
  // ATTENTION: 配信も localhost 限定にすること。共有トークンを埋め込んで返すので、ngrok 経由で外から
  //            取れるとトークンが漏れる
  app.get('/tampermonkey/:name.user.js', (req, res) => {
    const cfg = settings();
    if (!cfg.allow_remote && !isLoopback(req)) return res.status(403).send('localhost以外からは取得できません');

    const name = String(req.params.name || '');
    if (!/^[a-z0-9_-]+$/.test(name)) return res.status(400).send('不正なスクリプト名です');
    const file = path.join(USERSCRIPT_DIR, `${name}.user.js`);
    if (!fs.existsSync(file)) return res.status(404).send('スクリプトが見つかりません');

    // ATTENTION: リポジトリのファイルにはトークンを書かないこと（git に入る）。配信するときに差し込む
    const body = fs.readFileSync(file, 'utf8')
      .replace(/__IMPORT_TOKEN__/g, cfg.token || '')
      .replace(/__SERVER_ORIGIN__/g, `http://localhost:${ctx.port || 3001}`);

    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  });
}

module.exports = { registerFinanceImportRoutes };
