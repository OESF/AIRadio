/**
 * @file 秘書の LINE 連携の受け口（LINE の Webhook を受けて、本人からの依頼に返信する）
 *
 * POST /line_webhook。ngrok（lib/ngrok-launcher.js）で外部に公開している。ここでは次の3つだけを行い、
 * 依頼の中身の解釈と返事の作成は lib/secretary-line.js に任せる。
 *   1. 署名の確認（X-Line-Signature）
 *   2. 本人の確認（登録した userId 以外には応答しない）
 *   3. LINE への返信
 *
 * 返信は、無料の Reply API（受け取ったメッセージへの返信専用）を基本にし、失敗したとき（返信用の
 * トークンの期限切れなど）だけ Push API（月200通まで無料）に切り替える。
 *
 * ATTENTION: 相手へ返す文に出す名前は、必ず設定から引くこと（CLAUDE.md 1節）。ここは本人以外の
 * 相手にも届く唯一の経路なので、直書きすると意図しない相手に実名が出る。
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

const crypto = require('crypto');
const fs = require('fs');
const { getLogger } = require('../logger');
const secretaryLine = require('../lib/secretary-line');

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
/**
 * LINE のテキストは1通5000文字まで。余裕を持ってこの長さで切る。
 */
const LINE_MAX_TEXT_LENGTH = 4900;

/**
 * X-Line-Signature（HMAC-SHA256 の base64）を、受け取った生の本文に対して確かめる。
 * @param {Buffer|string} rawBody 受け取った生の本文
 * @param {string} signature X-Line-Signature
 * @param {string} channelSecret チャネルシークレット
 * @returns {boolean}
 */
function _verifySignature(rawBody, signature, channelSecret) {
  if (!rawBody || !signature || !channelSecret) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // 比べる時間から中身を推測されないよう、=== ではなく timingSafeEqual で比べる。
  // timingSafeEqual は長さが違うと例外を投げるので、先に長さを比べる
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * LINE の上限の長さを超えたら切り、省略したことを書き添える。
 * @param {string} text
 * @returns {string}
 */
function _truncateForLine(text) {
  if (text.length <= LINE_MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, LINE_MAX_TEXT_LENGTH)}\n…（長いため省略しました）`;
}

/**
 * LINE の Messaging API を呼ぶ。
 * @param {string} url Reply API か Push API の URL
 * @param {object} body
 * @param {string} accessToken チャネルアクセストークン
 * @returns {Promise<void>}
 * @throws {Error} 失敗したとき
 */
async function _lineApiCall(url, body, accessToken) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LINE API HTTP ${res.status}: ${errText}`);
  }
}

/**
 * 未登録の送信者の userId を config.json に書いておく（管理画面で本人の userId を登録するときの参考にする）。
 * @param {string} userId
 * @param {{readJsonFile: Function, getInitialConfig: Function, CONFIG_PATH: string}} deps
 */
function _recordUnauthorizedSender(userId, { readJsonFile, getInitialConfig, CONFIG_PATH }) {
  try {
    const current = readJsonFile(CONFIG_PATH, getInitialConfig());
    current.line = { ...(current.line || {}), last_unauthorized_sender_id: userId };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf-8');
  } catch (e) {
    getLogger().warn(`[LINE] 未登録送信者IDの記録に失敗: ${e.message}`);
  }
}

/**
 * LINE のイベントを1件処理する（テキストのメッセージだけ）。
 *
 * 本人がまだ登録されていなければ登録の案内を、本人以外なら「個人専用」とだけ返す。本人からなら
 * secretary-line.js で返事を作って返信する。
 * @param {Record<string, any>} event LINE の Webhook のイベント
 * @param {Record<string, any>} ctx config・creds・会話の記録の置き場・ダッシュボードへの通知など
 * @returns {Promise<void>}
 */
async function _handleEvent(event, { config, creds, convHistoryPath, deps, onLineActivity, getChannelSystem = null }) {
  if (event.type !== 'message' || event.message?.type !== 'text') return; // v1はテキストメッセージのみ対応
  const senderUserId = event.source?.userId;
  const replyToken = event.replyToken;
  const text = event.message.text;
  const accessToken = creds.line.channel_access_token;
  if (!senderUserId) return;

  const authorizedUserId = config.line?.authorized_user_id;

  if (!authorizedUserId) {
    getLogger().info(`[LINE] 未登録の送信者からメッセージを受信しました。userId: ${senderUserId}`);
    _recordUnauthorizedSender(senderUserId, deps);
    if (replyToken) {
      // 相手は本人とは限らないので、呼び方は設定から引く（未設定なら名前を出さない言い方にする）
      const _profile = config.show?.user_profile || {};
      const _ownerName = String(_profile.short_name || _profile.name || '').replace(/さん$/, '');
      const _who = _ownerName ? `${_ownerName}さんが` : '管理者が';
      await _lineApiCall(LINE_REPLY_URL, {
        replyToken,
        messages: [{ type: 'text', text: 'はじめまして。このアカウントはまだ管理画面での本人確認が完了していません。'
          + `${_who}管理画面で登録を行うまでお待ちください。` }],
      }, accessToken).catch((e) => getLogger().warn(`[LINE] 未登録案内の送信に失敗: ${e.message}`));
    }
    return;
  }

  if (senderUserId !== authorizedUserId) {
    getLogger().warn(`[LINE] ホワイトリスト外のuserIdからメッセージを受信、無視します: ${senderUserId}`);
    if (replyToken) {
      await _lineApiCall(LINE_REPLY_URL, {
        replyToken, messages: [{ type: 'text', text: 'これは個人専用のアシスタントです。' }],
      }, accessToken).catch(() => {});
    }
    return;
  }

  getLogger().info(`[LINE] 本人からメッセージを受信: ${text}`);
  // ダッシュボードに「LINE の依頼を処理中」と知らせる（依頼の文は1行に収まる長さに切る）
  onLineActivity?.({ state: 'processing', requestText: text.slice(0, 60) });
  let replyText;
  try {
    ({ replyText } = await secretaryLine.processMessage({ config, creds, userText: text, convHistoryPath, getChannelSystem }));
  } catch (e) {
    // 想定外の失敗で抜けても、ダッシュボードが「処理中」のまま固まらないよう、必ず戻す
    onLineActivity?.({ state: 'idle', error: e.message });
    throw e;
  }
  onLineActivity?.({ state: 'idle', replyExcerpt: replyText.slice(0, 60) });
  const finalText = _truncateForLine(replyText);

  try {
    if (replyToken) {
      await _lineApiCall(LINE_REPLY_URL, { replyToken, messages: [{ type: 'text', text: finalText }] }, accessToken);
      getLogger().info('[LINE] reply送信完了');
    } else {
      await _lineApiCall(LINE_PUSH_URL, { to: senderUserId, messages: [{ type: 'text', text: finalText }] }, accessToken);
      getLogger().info('[LINE] push送信完了（replyTokenなし）');
    }
  } catch (e) {
    getLogger().warn(`[LINE] reply失敗、pushへフォールバックします: ${e.message}`);
    await _lineApiCall(LINE_PUSH_URL, { to: senderUserId, messages: [{ type: 'text', text: finalText }] }, accessToken)
      .catch((e2) => getLogger().warn(`[LINE] pushも失敗: ${e2.message}`));
  }
}

/**
 * ルートを登録する。
 * @param {import('express').Express} app
 * @param {{ readJsonFile, getInitialConfig, getInitialCredentials, CONFIG_PATH, CREDENTIALS_PATH,
 *   CONV_HISTORY_PATH, onLineActivity?: (info: { state: 'processing'|'idle', requestText?: string,
 *   replyExcerpt?: string, error?: string }) => void, getChannelSystem?: (channel: string) => any }} ctx
 *   onLineActivity はダッシュボードへ処理の状況を知らせる（任意）。getChannelSystem はチャンネル名から
 *   動いているシステムを引く（「今放送中か」の判定と、番組へのリクエストをすぐ反映するため）
 */
function registerLineWebhookRoutes(app, ctx) {
  const {
    readJsonFile, getInitialConfig, getInitialCredentials,
    CONFIG_PATH, CREDENTIALS_PATH, CONV_HISTORY_PATH, onLineActivity, getChannelSystem,
  } = ctx;

  app.post('/line_webhook', (req, res) => {
    // LINE は Webhook にすぐ 200 を返すことを求めている。返事を作るのには数秒〜十数秒かかるので、
    // 先に 200 を返してから処理する（返事は Reply・Push の API で別に送る）
    res.status(200).send('OK');

    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());

    if (!config.line?.enabled || !creds.line?.channel_access_token || !creds.line?.channel_secret) {
      getLogger().debug('[LINE] Webhookを受信しましたが、連携が未設定/無効のため無視します');
      return;
    }

    const signature = req.headers['x-line-signature'];
    if (!_verifySignature(req.rawBody, signature, creds.line.channel_secret)) {
      getLogger().warn('[LINE] Webhook署名検証に失敗、リクエストを無視します');
      return;
    }

    const events = req.body?.events || [];
    for (const event of events) {
      _handleEvent(event, {
        config, creds, convHistoryPath: CONV_HISTORY_PATH,
        deps: { readJsonFile, getInitialConfig, CONFIG_PATH },
        onLineActivity,
        getChannelSystem,
      }).catch((e) => {
        getLogger().warn(`[LINE] イベント処理失敗: ${e.message}`);
        // 失敗したときも、ダッシュボードを「処理中」のまま残さない（_handleEvent で戻せなかった経路の保険）
        onLineActivity?.({ state: 'idle', error: e.message });
      });
    }
  });
}

module.exports = { registerLineWebhookRoutes };
