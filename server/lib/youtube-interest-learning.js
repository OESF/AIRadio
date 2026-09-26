/**
 * @file YouTube の登録チャンネルから、リスナーの興味の傾向を学ぶ
 *
 * YouTube の視聴履歴は公式の API から取れない。代わりに、リスナーがたくさん登録していて新着を毎日見ている
 * 登録チャンネルの一覧を、興味の強い手がかりとして使う。チャンネル名の一覧から LLM に興味の傾向を
 * まとめさせ、secretary-memory.js のリスナー像（getListenerDigestForPrompt）に合流させる。
 * リスナー像は Live の全コーナー・秘書・ディレクターなどが読んでいるので、新しい渡し口は増やさない。
 *
 * チャンネル名は1件ずつでは意味が薄く、並べて初めて傾向になるので、1件ずつ追記するのではなく、
 * 顔ぶれが変わるたびに全部からまとめ直す。
 *
 * 主な利用元: lib/secretary-loop.js（定期処理のたびに呼ぶ）
 * 保存先: data/secretary/youtube-interest-watch.json（前回の登録チャンネルの ID）
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
const jsonFileStore = require('./json-file-store');
const { getLogger } = require('../logger');
const { googleService } = require('./secretary-tools-services');
const secretaryMemory = require('./secretary-memory');

const WATCH_PATH = path.join(__dirname, '..', 'data', 'secretary', 'youtube-interest-watch.json');

/**
 * 前回確かめたときの登録チャンネルを読む。
 * @returns {{channelIds: string[], updatedAt?: string}}
 */
function _readWatch() {
  return jsonFileStore.readJsonFile(WATCH_PATH, { channelIds: [] }, '[YoutubeInterestLearning]');
}
/**
 * 今回の登録チャンネルを保存する。
 * @param {{channelIds: string[], updatedAt: string}} data
 */
function _writeWatch(data) {
  jsonFileStore.writeJsonFile(WATCH_PATH, data, '[YoutubeInterestLearning]');
}

/**
 * 登録チャンネルの顔ぶれが前回から変わっていれば、興味の傾向をまとめ直す。
 *
 * 登録チャンネルの取得は軽い API なので毎回呼ぶ。LLM は顔ぶれが変わったときだけ呼ぶ。
 * Gemini の API キーか YouTube の連携が無ければ何もしない。
 * @param {{creds: Record<string, any>}} args creds は認証情報（credentials.json の内容）
 * @returns {Promise<void>}
 */
async function checkYoutubeInterestLearning({ creds }) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) return;
  if (!creds?.google?.youtube_refresh_token) return;

  let subs;
  try {
    subs = await googleService.fetchSubscriptions(creds);
  } catch (e) {
    getLogger().debug(`[YoutubeInterestLearning] 登録チャンネル取得に失敗（未認証等、無視して続行）: ${e.message}`);
    return;
  }
  if (!subs || subs.length === 0) return;

  const watch = _readWatch();
  const prevIds = new Set(watch.channelIds || []);
  const currentIds = subs.map((s) => s.channelId);
  const currentSet = new Set(currentIds);
  const changed = currentIds.some((id) => !prevIds.has(id)) || (watch.channelIds || []).some((id) => !currentSet.has(id));
  if (!changed) return;

  const titles = subs.map((s) => s.channelTitle);
  await secretaryMemory.summarizeYoutubeInterests(titles, { apiKey, activitySessionId: null })
    .catch((e) => getLogger().warn(`[YoutubeInterestLearning] 興味傾向の要約に失敗: ${e.message}`));

  _writeWatch({ channelIds: currentIds, updatedAt: new Date().toISOString() });
}

module.exports = { checkYoutubeInterestLearning };
