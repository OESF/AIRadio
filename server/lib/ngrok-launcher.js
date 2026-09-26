/**
 * @file ngrok（LINE の Webhook を受けるための外部公開トンネル）を自動で起動する
 *
 * 秘書の LINE 連携（routes/line-webhook-routes.js）は、LINE からの Webhook を受けるために
 * localhost:3001 を固定ドメインで外部公開する ngrok トンネルが要る。サーバーの起動時に
 * ngrok が動いているかを確かめ、動いていなければ起動する。
 *
 * ngrok は自己診断用のローカル API（http://127.0.0.1:4040/api/tunnels、認証不要）を持つので、
 * そこへ問い合わせて動いているかを判定する（プロセス名で探すより確実）。
 *
 * ベストエフォートの補助機能で、ngrok が無い・起動に失敗したときも、AI Radio 本体と
 * LINE 以外の機能には影響しない。
 *
 * 主な利用元: server.js（起動時）
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

const { spawn } = require('child_process');
const { getLogger } = require('../logger');

const NGROK_LOCAL_API_URL = 'http://127.0.0.1:4040/api/tunnels';
/** 起動してから確かめるまでの待ち時間（起動直後はローカル API がまだ立ち上がっていないことがある）。 */
const STARTUP_CHECK_DELAY_MS = 5000;

/**
 * ngrok のローカル API に問い合わせ、トンネルが1つ以上あるかを確かめる。
 * ngrok が動いていない、または API に届かないときは false。
 * @returns {Promise<boolean>}
 */
async function _isNgrokRunning() {
  try {
    const res = await fetch(NGROK_LOCAL_API_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.tunnels) && data.tunnels.length > 0;
  } catch {
    return false;
  }
}

/**
 * トンネルが無ければ、指定のポートと固定ドメインで ngrok を起動する。
 * サーバーの起動を止めないよう、await せずに呼ぶ。
 * @param {{ port: number, domain: string }} args domain が空なら何もしない
 * @returns {Promise<void>}
 */
async function ensureNgrokRunning({ port, domain }) {
  if (!domain) {
    getLogger().debug('[ngrok] ドメイン未設定のため自動起動をスキップします');
    return;
  }

  const alreadyRunning = await _isNgrokRunning();
  if (alreadyRunning) {
    getLogger().info('[ngrok] 既に起動済みのトンネルを検出しました（自動起動は不要）');
    return;
  }

  getLogger().info(`[ngrok] トンネルが見つからないため自動起動します: ngrok http ${port} --url=${domain}`);
  try {
    // サーバーとは独立したプロセスとして起動し（detached）、サーバーが終わっても残す（unref）。
    // サーバーを再起動するたびにトンネルを張り直さないほうが、LINE の Webhook が安定する
    const child = spawn('ngrok', ['http', String(port), `--url=${domain}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (e) => {
      getLogger().warn(`[ngrok] 起動コマンドの実行に失敗しました: ${e.message}`
        + '（ngrokコマンドがPATHに無い可能性があります。手動での起動が必要です）');
    });

    setTimeout(async () => {
      const ok = await _isNgrokRunning();
      if (ok) getLogger().info('[ngrok] トンネルの起動を確認しました');
      else getLogger().warn('[ngrok] 起動を試みましたが、数秒経ってもトンネルを確認できませんでした。手動での確認をお願いします');
    }, STARTUP_CHECK_DELAY_MS);
  } catch (e) {
    getLogger().warn(`[ngrok] 自動起動処理で例外が発生しました: ${e.message}`);
  }
}

module.exports = { ensureNgrokRunning };
