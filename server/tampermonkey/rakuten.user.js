// ==UserScript==
// @name         AI Radio 資産取り込み（楽天証券）
// @namespace    https://github.com/MiuraMasataka/ai-radio
// @version      1.1.0
// @description  楽天証券の保有商品一覧から公式CSVを取得し、AI Radio へ送る
// @author       AI Radio
// @match        https://member.rakuten-sec.co.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      self
// @connect      localhost
// @run-at       document-idle
// @downloadURL  __SERVER_ORIGIN__/tampermonkey/rakuten.user.js
// @updateURL    __SERVER_ORIGIN__/tampermonkey/rakuten.user.js
// ==/UserScript==

/**
 * @file 楽天証券の保有商品の公式 CSV を裏で取得して、AI Radio に送るユーザースクリプト（Tampermonkey）
 *
 * 画面を読まず、楽天証券が用意している CSV を取得し、ファイルに保存せずそのまま送る（routes/finance-import-routes.js）。
 * 利用者が CSV をダウンロードする必要は無い。画面を読むより数値が正確で、銘柄コード（1557・NVDA など）まで取れる。
 * サーバーの URL と取り込み用のトークンは、サーバーが配信するときに差し込む。
 *
 * ATTENTION: CSV の URL は決め打ちせず、必ずページの CSV のフォームの action から取る。楽天はセッション ID を
 *            URL のパスに埋める（;BV_SessionID=…）。これを欠くと 200 OK でセッションエラーのページが返る。
 *            セッション ID は毎回変わるので、固定にはできない。
 * ATTENTION: 保有商品の表（#table_possess_data）は、最初は空で AJAX で後から入る。ページの CSV ボタン自身も、
 *            読み込みが終わる前は拒否する。表が埋まるのを待ってから CSV を要求する。
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

  // メニューが出ない・何も起きないときに、そもそも実行されていないのか、途中で失敗したのかをコンソールで切り分けるため
  const TAG = '[AI Radio/楽天]';
  console.log(TAG, 'ユーザースクリプト v1.1.0 起動', location.href);

  const SERVER = '__SERVER_ORIGIN__';
  const TOKEN = '__IMPORT_TOKEN__';
  const SOURCE = 'rakuten';
  const LABEL = '楽天証券';

  // ─── 画面の隅に出す小さな表示 ─────────────────────────────
  let chip = null;
  /**
   * 画面の右下に知らせを出す（クリックで閉じる）。
   * @param {string} text
   * @param {'info'|'ok'|'error'} [kind]
   */
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

  // ─── 道具 ─────────────────────────────────────────────
  /**
   * バイナリを Base64 にする。
   * @param {ArrayBuffer} arrayBuffer
   * @returns {string}
   */
  function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let bin = '';
    const CHUNK = 0x8000; // 一度に渡しすぎると引数の数の上限で落ちる
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /**
   * 同じ内容を何度も送らないための軽い指紋。
   * @param {string} s
   * @returns {string}
   */
  function fingerprint(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${s.length}:${h.toString(16)}`;
  }

  /**
   * CSV の URL をページのフォームから作る（セッション ID がパスに埋まっているので決め打ちにできない）。
   * @returns {string|null} フォームが無ければ null
   */
  function findCsvUrl() {
    const form = document.querySelector('form[name="csvOutputform"]')
      || [...document.querySelectorAll('form')].find((f) => (
        /ass_.*possess_lst\.do/i.test(f.getAttribute('action') || '')
        && [...f.querySelectorAll('input')].some((i) => i.value === 'csv')
      ));
    if (!form) return null;
    const action = form.action; // DOM が絶対 URL にしてくれる（セッション ID を含む）
    return action + (action.includes('?') ? '&' : '?') + 'eventType=csv';
  }

  /**
   * 保有商品の表が AJAX で埋まったか。
   * @returns {boolean}
   */
  function isDataReady() {
    const box = document.querySelector('#table_possess_data');
    return !!(box && box.innerHTML.trim().length > 0);
  }

  /**
   * 保有商品の表が埋まるのを待つ。
   * @param {number} timeoutMs
   * @param {() => void} onReady 埋まったとき
   * @param {() => void} onTimeout 時間切れのとき
   */
  function waitForData(timeoutMs, onReady, onTimeout) {
    if (isDataReady()) return onReady();
    let done = false;
    const obs = new MutationObserver(() => {
      if (done || !isDataReady()) return;
      done = true; obs.disconnect(); clearTimeout(timer); onReady();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true; obs.disconnect(); onTimeout();
    }, timeoutMs);
    return undefined;
  }

  // ─── 送信 ─────────────────────────────────────────────
  /**
   * 表が埋まるのを待ってから CSV を取得して送る。
   * @param {{ manual: boolean }} opts manual はメニューから手で送ったとき（知らせを出し、同じ内容でも送る）
   */
  function send({ manual }) {
    if (!findCsvUrl()) {
      const msg = 'このページにCSVの出力機能が見つかりません。\n「保有商品一覧」を開いてからお試しください。';
      console.log(TAG, msg);
      if (manual) say(msg, 'error');
      return;
    }
    if (manual) say('保有商品の読み込みを待っています…');

    waitForData(
      30000,
      () => fetchCsv(manual),
      () => {
        const msg = '保有商品の読み込みが終わりませんでした。\nページを再読み込みしてお試しください。';
        console.warn(TAG, msg);
        if (manual) say(msg, 'error');
      }
    );
  }

  /**
   * CSV を取得し、前回と同じでなければ送る。
   * @param {boolean} manual
   */
  function fetchCsv(manual) {
    const csvUrl = findCsvUrl(); // 待っている間に描き直されたかもしれないので取り直す
    if (!csvUrl) { if (manual) say('CSVの出力機能が見つかりません。', 'error'); return; }

    GM_xmlhttpRequest({
      method: 'GET',
      url: csvUrl,
      headers: { Referer: location.href, Accept: 'text/csv,application/octet-stream,*/*' },
      responseType: 'arraybuffer',
      timeout: 30000,
      onload: (res) => {
        if (res.status !== 200 || !res.response || res.response.byteLength === 0) {
          say(`CSVを取得できませんでした（HTTP ${res.status}）。\nログインが切れていませんか。`, 'error');
          return;
        }
        // セッションが切れていると 200 OK で HTML が返るので、状態コードだけでは判断できない。中身を見て確かめる
        let text = '';
        try { text = new TextDecoder('shift_jis').decode(res.response); } catch { /* 下で判定する */ }
        if (/^\s*<!DOCTYPE|^\s*<html/i.test(text)) {
          console.warn(TAG, 'CSVではなくHTMLが返りました:\n' + text.slice(0, 400));
          say('楽天側にセッション外と判定されました。\nページを再読み込みしてお試しください。', 'error');
          return;
        }
        console.log(TAG, 'CSVを取得しました', res.response.byteLength + ' bytes');

        const payload = toBase64(res.response);
        const fp = fingerprint(payload);
        if (!manual && GM_getValue('lastFingerprint') === fp) {
          say('前回と同じ内容のため送信を省略しました。');
          return;
        }
        post(payload, fp, csvUrl);
      },
      onerror: () => say('CSVの取得に失敗しました（通信エラー）。', 'error'),
      ontimeout: () => say('CSVの取得がタイムアウトしました。', 'error'),
    });
  }

  /**
   * AI Radio へ送る。成功したら指紋と送った時刻を覚えておく。
   * @param {string} payload Base64 の CSV
   * @param {string} fp 指紋
   * @param {string} sourceUrl 取得した URL
   */
  function post(payload, fp, sourceUrl) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${SERVER}/api/finance-import/${SOURCE}`,
      headers: { 'Content-Type': 'application/json', 'X-Import-Token': TOKEN },
      data: JSON.stringify({ encoding: 'base64', payload, sourceUrl }),
      timeout: 30000,
      onload: (res) => {
        let body = {};
        try { body = JSON.parse(res.responseText); } catch { /* 下でHTTP状態から判断する */ }
        if (res.status !== 200 || !body.ok) {
          console.error(TAG, '送信失敗', res.status, body.error || res.responseText);
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
    });
  }

  // ─── メニューの登録と起動 ─────────────────────────────
  /** メニュー（今すぐ送信・自動送信の切り替え・接続テスト）を登録し、自動送信が ON なら送る */
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

    if (GM_getValue('autoSend', true)) send({ manual: false });
    else console.log(TAG, '自動送信はOFFです（メニューの「今すぐ送信」から送れます）');
  }

  // 起動時の例外を握りつぶすと「何も起きない」だけが残り、原因が分からなくなるので、必ず出す
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
