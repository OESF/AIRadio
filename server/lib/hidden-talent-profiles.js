/**
 * @file Live のエージェントの「裏の顔」（The Answers で設定した個人的な一面）を引く
 *
 * The Answers の出演者（panelist_pool）には、人物像を深めるための「裏の顔」（hidden_talent_prompt。
 * 例: コメンテーターは熱狂的な野球ファン）が設定されている。これを Live でも、話題と重なったときに
 * 一言だけ覗かせる形で使う。
 *
 * panelist_pool の各エントリは sourceChannel・sourceAgentKey で元のエージェントを持っているので、
 * sourceChannel が 'live' のものを Live 側のキーで引けるように詰め替える。
 *
 * The Answers の設定は管理画面でいつでも編集されるので、ファイルの更新時刻が変わったら読み直す。
 * ファイルが無い・壊れているときは「裏の顔なし」として扱い、放送は止めない。
 *
 * 主な利用元: lib/agent-knowledge-pack.js
 * 読み込み元: data/channels/the_answers/config.json
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

const THE_ANSWERS_CONFIG_PATH = path.join(__dirname, '..', 'data', 'channels', 'the_answers', 'config.json');

/** 最後に読んだときのファイルの更新時刻と、その内容。 */
let _cache = { mtimeMs: 0, byAgentKey: {} };

/**
 * Live のエージェントのキー（'commentator' など）→ 裏の顔 の対応表を返す。
 * @returns 対応表。登録が無ければ空のオブジェクト
 */
function getHiddenTalentsByLiveAgentKey() {
  try {
    const stat = fs.statSync(THE_ANSWERS_CONFIG_PATH);
    if (stat.mtimeMs === _cache.mtimeMs) return _cache.byAgentKey;

    const cfg = JSON.parse(fs.readFileSync(THE_ANSWERS_CONFIG_PATH, 'utf8'));
    const pool = cfg.panelist_pool || {};
    const byAgentKey = {};
    for (const entry of Object.values(pool)) {
      if (!entry || entry.sourceChannel !== 'live') continue;
      const key = entry.sourceAgentKey;
      const talent = (entry.hidden_talent_prompt || '').trim();
      if (key && talent) byAgentKey[key] = talent;
    }
    _cache = { mtimeMs: stat.mtimeMs, byAgentKey };
    return byAgentKey;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      getLogger().warn(`[HiddenTalent] The Answers設定の読み込みに失敗: ${e.message}`);
    }
    return {};
  }
}

/**
 * 1人のエージェントの裏の顔を返す。
 * @param {string} agentKey
 * @returns {string} 無ければ空文字
 */
function getHiddenTalent(agentKey) {
  return getHiddenTalentsByLiveAgentKey()[agentKey] || '';
}

/**
 * プロンプトに差し込む「裏の顔」の段落を作る。
 *
 * 毎回私生活を語り出すと本来の専門の解説が薄まるので、「話題と自然に重なるときだけ」「一言だけ」
 * という制約を必ず添える。
 * @param {string} agentKey
 * @returns {string} 裏の顔が無ければ空文字
 */
function buildHiddenTalentNote(agentKey) {
  const talent = getHiddenTalent(agentKey);
  if (!talent) return '';
  return `\n\n【あなたの個人的な一面（普段は表に出さない）】${talent}\n`
    + `※ 今回の話題がこの個人的な一面と自然に重なるときに限り、一言だけ、さりげなく`
    + `覗かせて構いません（例: 「実は私、これには目がなくてね」程度）。話題と関係が無ければ`
    + `一切触れないでください。自己紹介として説明したり、本題の解説より長く語ったりするのは`
    + `絶対に避け、あくまで本来の専門的な解説が主役です。`;
}

module.exports = { getHiddenTalentsByLiveAgentKey, getHiddenTalent, buildHiddenTalentNote };
