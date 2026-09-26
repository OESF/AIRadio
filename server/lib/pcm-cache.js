/**
 * @file 割り込み音声（PCM）の永続キャッシュ（全チャンネル共有）
 *
 * 番組中の割り込みアナウンスなど、同じ文言を何度も合成する音声をファイルにキャッシュする。
 * キーは「文言＋全 TTS 設定」の SHA-256（先頭24文字）なので、声や文言を変えると自動的に作り直される。
 *
 * 主な利用元: channel-base.js・routes/text-command-routes.js
 * 保存先: data/interrupt_pcm_cache.json
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

const fs     = require('fs');
const { writeJsonFile } = require('./atomic-json');
const path   = require('path');
const crypto = require('crypto');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'interrupt_pcm_cache.json');

/** キャッシュの本体（キー → 音声データ）。読み込むまでは null。 */
let _cache = null;

/**
 * キャッシュを返す。初回だけファイルから読む。読めなければ空で始める。
 * @returns {Record<string, any>}
 */
function load() {
  if (_cache !== null) return _cache;
  try {
    _cache = fs.existsSync(CACHE_PATH)
      ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
      : {};
  } catch {
    _cache = {};
  }
  return _cache;
}

/** キャッシュをファイルへ保存する。失敗しても例外は出さない。 */
function persist() {
  if (!_cache) return;
  try { writeJsonFile(CACHE_PATH, _cache, { spaces: 0 }); } catch {}
}

/**
 * キャッシュのキーを作る。
 * @param {string} text 合成する文言
 * @param {Record<string, any>} agentCfg エージェントの設定（tts_engine・gemini_voice・tts_style などを使う）
 * @returns {string} 24文字の16進
 */
function buildKey(text, agentCfg) {
  const raw = JSON.stringify({
    t:  text,
    e:  agentCfg.tts_engine       || 'gemini',
    v:  agentCfg.gemini_voice      || '',
    s:  agentCfg.tts_style         || agentCfg.gemini_instruction || '',
    a:  agentCfg.tts_accent        || '',
    p:  agentCfg.tts_pacing        || '',
    pt: agentCfg.tts_profile_title || '',
    sc: agentCfg.tts_scene         || '',
    cx: agentCfg.tts_context       || '',
  });
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

module.exports = { load, persist, buildKey };
