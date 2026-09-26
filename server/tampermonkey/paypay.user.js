// ==UserScript==
// @name         AI Radio 資産取り込み（PayPay銀行）
// @namespace    https://github.com/MiuraMasataka/ai-radio
// @version      1.0.1
// @description  PayPay銀行の投資信託ページから保有残高を読み取り、AI Radio へ送る
// @author       AI Radio
// @match        https://*.paypay-bank.co.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @run-at       document-idle
// @downloadURL  __SERVER_ORIGIN__/tampermonkey/paypay.user.js
// @updateURL    __SERVER_ORIGIN__/tampermonkey/paypay.user.js
// ==/UserScript==

/**
 * @file PayPay 銀行の投資信託の保有残高を読み取って、AI Radio に送るユーザースクリプト（Tampermonkey）
 *
 * PayPay 銀行には CSV のダウンロードが無いので、ページの HTML を送り、サーバー側で解析する
 * （routes/finance-import-routes.js）。共有トークンとサーバーの URL は、サーバーが配信するときに差し込む
 *（コメントに目印の文字列を書くと、そこも置き換わるので書かない）。
 *
 * @match はドメイン全体にしている。ページの URL に頼ると改修で黙って壊れるので、「口座区分」「評価損益」を
 * 持つ表があるかどうかで判定し、無いページでは何もしない。
 *
 * ATTENTION: 送る前に、hidden の input と script をすべて取り除くこと。このページには CSRF のトークンと
 *            セッション ID が hidden で入っている。解析には使わない（銘柄のコードはリンクの URL から取る）ので、
 *            送らなければ漏れない。
 * ATTENTION: 先頭の ==UserScript== のかたまりは、必ずファイルの先頭に置く（Tampermonkey がそこを読む）。
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
(function () {
  'use strict';

  // 【診断用】メニューが出ない・何も起きないときに、「そもそも実行されていない」のか
  // 「実行されたが途中で失敗した」のかをコンソールで切り分けられるようにする。
  const TAG = '[AI Radio/PayPay]';
  console.log(TAG, 'ユーザースクリプト v1.0.1 起動', location.href);

  const SERVER = '__SERVER_ORIGIN__';
  const TOKEN = '__IMPORT_TOKEN__';
  const SOURCE = 'paypay';
  const LABEL = 'PayPay銀行';

  // ── 画面の隅に出す小さな表示 ───────────────────────────────────────────────
  let chip = null;
  function say(text, kind = 'info') {
    if (!chip) {
      chip = document.createElement('div');
      Object.assign(chip.style, {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
        padding: '10px 14px', borderRadius: '8px', font: '13px/1.5 sans-serif',
        color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.3)', maxWidth: '340px',
        cursor: 'pointer', whiteSpace: 'pre-wrap',
      });
      chip.title = 'クリックで閉じる';
      chip.addEventListener('click', () => chip.remove());
    }
    chip.style.background = kind === 'error' ? '#b3261e' : kind === 'ok' ? '#1b5e20' : '#37474f';
    chip.textContent = `AI Radio / ${LABEL}\n${text}`;
    if (!document.body.contains(chip)) document.body.appendChild(chip);
  }

  // ── 保有残高一覧が現れたかを見る ──────────────────────────────────────────
  // URLやページ名ではなく「欲しい表があるか」で判定する。表があるということは
  // データも揃っているということなので、描画待ちの取りこぼしが起きない。
  function findHoldingsTable() {
    for (const t of document.querySelectorAll('table')) {
      const s = t.textContent || '';
      if (s.includes('口座区分') && s.includes('評価損益') && s.includes('ファンド名')) return t;
    }
    return null;
  }

  function waitForTable(timeoutMs, onFound, onTimeout) {
    const found = findHoldingsTable();
    if (found) return onFound(found);
    let done = false;
    const obs = new MutationObserver(() => {
      if (done) return;
      const el = findHoldingsTable();
      if (el) { done = true; obs.disconnect(); clearTimeout(timer); onFound(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      obs.disconnect();
      onTimeout();
    }, timeoutMs);
    return undefined;
  }

  /**
   * 送信用のHTMLを組み立てる。元のページは一切変更せず、複製に対して行う。
   * 落とすもの: script / style / noscript / iframe と、すべての hidden input。
   */
  function buildPayload() {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, iframe, link, img, svg').forEach((el) => el.remove());
    clone.querySelectorAll('input[type="hidden"], input[type="password"]').forEach((el) => el.remove());
    return clone.outerHTML;
  }

  function fingerprint(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${s.length}:${h.toString(16)}`;
  }

  function send({ manual }) {
    waitForTable(
      manual ? 15000 : 8000,
      () => {
        const payload = buildPayload();
        const fp = fingerprint(payload);
        if (!manual && GM_getValue('lastFingerprint') === fp) {
          say('前回と同じ内容のため送信を省略しました。');
          return;
        }
        post(payload, fp);
      },
      () => {
        if (manual) say('このページに保有残高の一覧が見つかりません。\n「投資信託トップ」を開いてからお試しください。', 'error');
      }
    );
  }

  function post(payload, fp) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SERVER}/api/finance-import/${SOURCE}`,
      headers: { 'Content-Type': 'application/json', 'X-Import-Token': TOKEN },
      data: JSON.stringify({ encoding: 'text', payload }),
      onload: (res) => {
        let body = {};
        try { body = JSON.parse(res.responseText); } catch { /* 下でHTTP状態から判断する */ }
        if (res.status !== 200 || !body.ok) {
          say(`送信できませんでした（HTTP ${res.status}）\n${body.error || res.responseText || ''}`.trim(), 'error');
          return;
        }
        GM_setValue('lastFingerprint', fp);
        GM_setValue('lastSentAt', new Date().toISOString());
        const yen = (n) => (typeof n === 'number' ? n.toLocaleString('ja-JP') + '円' : '不明');
        const warn = (body.warnings || []).length ? `\n⚠ ${body.warnings.join('\n⚠ ')}` : '';
        say(`送信しました\n資産合計 ${yen(body.totalAssets)} / ${body.holdingsCount}件${warn}`, warn ? 'info' : 'ok');
      },
      onerror: () => say(`AI Radio (${SERVER}) へ接続できませんでした。\nサーバーは起動していますか。`, 'error'),
      ontimeout: () => say('AI Radio への送信がタイムアウトしました。', 'error'),
      timeout: 30000,
    });
  }

  // ── メニュー登録と起動 ──────────────────────────────────────────────────
  function boot() {
  GM_registerMenuCommand('今すぐ送信', () => send({ manual: true }));
  GM_registerMenuCommand('自動送信の切り替え', () => {
    const next = !(GM_getValue('autoSend', true));
    GM_setValue('autoSend', next);
    say(`自動送信を ${next ? 'ON' : 'OFF'} にしました。`);
  });
  GM_registerMenuCommand('接続テスト', () => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${SERVER}/api/finance-import/status`,
      headers: { 'X-Import-Token': TOKEN },
      onload: (res) => {
        if (res.status !== 200) { say(`接続できましたが拒否されました（HTTP ${res.status}）\n${res.responseText}`, 'error'); return; }
        const lines = (JSON.parse(res.responseText).sources || []).map((s) => (
          s.received
            ? `${s.institution}: ${s.ageInDays}日前 / ${s.holdingsCount}件`
            : `${s.institution}: 未受信`
        ));
        say(`接続OK\n${lines.join('\n')}`, 'ok');
      },
      onerror: () => say(`AI Radio (${SERVER}) へ接続できませんでした。`, 'error'),
    });
  });

  // ── 自動送信 ────────────────────────────────────────────────────────────
  if (GM_getValue('autoSend', true)) send({ manual: false });
  else console.log(TAG, '自動送信はOFFです（メニューの「今すぐ送信」から送れます）');
  }

  // 起動時の例外を握り潰すと「何も起きない」だけが残り、原因が分からなくなる。
  // コンソールと画面の両方へ必ず出す。
  try {
    if (typeof GM_registerMenuCommand !== 'function') {
      console.error(TAG, 'GM_registerMenuCommand が使えません。@grant を確認してください');
    }
    boot();
    console.log(TAG, 'メニューを登録しました');
  } catch (e) {
    console.error(TAG, '起動時にエラー:', e);
    try { say(`スクリプトの起動に失敗しました\n${e.message}`, 'error'); } catch { /* 表示すらできない場合は諦める */ }
  }
})();
