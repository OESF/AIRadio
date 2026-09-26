/**
 * @file Spotify Web API の呼び出し（レート制限への対応を全チャンネルで共通化）
 *
 * 429（リクエストが多すぎる）と Retry-After に対応した fetch を1か所にまとめる。
 * 待機の状態は spotify-rate-limit.js でプロセス全体に共有する。
 *
 * 検索・選曲の評価・再生など、チャンネルごとに中身が違う処理はここに集めない。呼び出し側がトークン
 * （headers）を用意し、返ってきた Response を自分で判定・解析する。
 *
 * 主な利用元: agent-system.js・channel-base.js・agent-system-24you.js
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

const { getLogger } = require('../logger');
const spotifyRateLimit = require('./../spotify-rate-limit');

/**
 * レート制限に対応した Spotify API の fetch。
 *
 *   1. 待機中なら Spotify に問い合わせず、すぐに null を返す。
 *   2. fetch して、429 でなければそのまま Response を返す。
 *   3. 429 なら Retry-After（秒・既定 3）を見る。
 *      - maxSyncWaitMs より長ければ待たずに、その時間だけ待機状態にして Response を返す
 *        （長い Retry-After でプロセスが止まらないように）。
 *      - それ以内なら待ってから1回だけやり直す。やり直しても 429 で persistBackoffMs > 0 なら、
 *        その時間だけ待機状態にする。
 *
 * @param {string} url
 * @param {object} opts
 * @param {Record<string,string>} opts.headers   Authorization などのヘッダー（トークンは呼び出し側で設定）
 * @param {string} [opts.method='GET']           HTTP メソッド
 * @param {string} [opts.body]                   リクエストの本文（JSON.stringify 済みの文字列）
 * @param {string} [opts.logPrefix='[Spotify]']  ログの接頭辞（例: '[24You]'・'[Music]'）
 * @param {string} [opts.label='']               ログに残す、何のための呼び出しか
 * @param {number} [opts.maxSyncWaitMs=10000]    これより長い Retry-After は待たない
 * @param {number} [opts.persistBackoffMs=0]     やり直しても 429 のときの待機時間（0 は待機しない）
 * @returns {Promise<Response|null>}             待機中は null、それ以外は Response（429 を含む）
 */
async function spotifyFetch(url, {
  headers,
  method = 'GET',
  body,
  logPrefix = '[Spotify]',
  label = '',
  maxSyncWaitMs = 10000,
  persistBackoffMs = 0,
} = {}) {
  if (spotifyRateLimit.isBackedOff()) {
    getLogger().warn(`${logPrefix} Spotify 429バックオフ中 — あと約${spotifyRateLimit.getBackoffMinutesRemaining()}分はスキップ (${label})`);
    return null;
  }

  let res = await fetch(url, { method, headers, body });
  if (res.status === 429) {
    const waitSec = parseInt(res.headers.get('Retry-After') || '3', 10);
    const wait = waitSec * 1000;
    if (wait > maxSyncWaitMs) {
      spotifyRateLimit.setBackoffUntil(Date.now() + wait);
      getLogger().warn(`${logPrefix} Spotify 429 — Retry-Afterが${waitSec}秒と長いため、待機せず即座にバックオフします (${label})`);
      return res;
    }
    getLogger().warn(`${logPrefix} Spotify 429 — ${waitSec}秒待機してリトライします (${label})`);
    await new Promise(r => setTimeout(r, wait));
    res = await fetch(url, { method, headers, body });
    if (res.status === 429 && persistBackoffMs > 0) {
      spotifyRateLimit.setBackoffUntil(Date.now() + persistBackoffMs);
      getLogger().warn(`${logPrefix} Spotify 429継続 — ${Math.ceil(persistBackoffMs / 60000)}分間バックオフします (${label})`);
    }
  }
  return res;
}

module.exports = { spotifyFetch };
