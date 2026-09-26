/**
 * @file 「いま世の中で何が起きているか」の材料を、ディレクター向けの短い形にまとめる
 *
 * 番組の中ですでに集めている材料（ニュースの見出し・社説の読み比べ・専門分野の動き・世の中の反応）を、
 * Live のディレクター（lib/agent-director-decision.js）、The Answers（agent-system-the-answers.js）、
 * 音楽チャンネルのディレクター（channel-base.js）が共通で使えるようにする。
 *
 * ATTENTION: 同じ材料を2か所で組み立てない。口が分かれると取りこぼしが起きる（lib/agent-knowledge-pack.js の
 *            冒頭を参照）。
 * ATTENTION: 専門分野の動きのうち、リスナー本人の情報にもとづく調査（教授の保有銘柄・弁護士の職業と経歴）は
 *            どのディレクターにも渡さない（公開範囲は lib/listener-context.js の冒頭を参照）。分野の一般的な
 *            動きを調べる定義（general: true）だけを使う。地域名を含む項目を除くかは呼び出し側が決める
 *            （The Answers は除く）。
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
const MediaCompareService = require('../services/media-compare-service');
const TrendingService = require('../services/trending-service');
const NewsService = require('../services/news-service');
const { buildEditorialCompareBlock } = require('./editorial-compare');
const agentProactiveResearch = require('./agent-proactive-research');
const journalistWatch = require('./journalist-watch');
const { getEffectiveLocationFromConfig } = require('./secretary-profile-format');

const LIVE_CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

/**
 * Live の config.json を読む（読めなければ空のオブジェクト）。
 * @returns {Record<string, any>}
 */
function _readLiveConfig() {
  try { return JSON.parse(fs.readFileSync(LIVE_CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// 呼び出し元がサービスのインスタンスを持っていないときに使う共有のもの（取得結果は各サービスがキャッシュする）
let _sharedMediaCompare = null;
let _sharedTrending = null;
let _sharedNews = null;

/**
 * ニュースの見出しを「総合・国内・国際・経済」で集める。
 *
 * BUGFIX: 国内・国際・経済は topic を指定して別に取る。fetch({}) の既定の8件は5つのフィードをつないだ
 *         先頭から取るので、実質いつも「トップ」だけになり、国際面や経済面が入らなかった
 *         （topic を指定した取得は newsService.cache を書き換えないので、他の利用者には影響しない）。
 * @param {Record<string, any>} newsService services/news-service.js のインスタンス
 * @param {{topCount?: number}} [opts]
 * @returns {Promise<string>} 取得できなければ '（取得できませんでした）'
 */
async function buildNewsHeadlinesText(newsService, { topCount = 8 } = {}) {
  try {
    const [topRes, domesticRes, worldRes, bizRes] = await Promise.all([
      newsService.fetch({}).then(() => newsService.cache?.structured || []),
      newsService.fetch({ topic: '国内', maxItems: 5 }),
      newsService.fetch({ topic: '国際', maxItems: 5 }),
      newsService.fetch({ topic: '経済', maxItems: 5 }),
    ]);
    const lines = [];
    if (topRes.length > 0) lines.push('【総合】', ...topRes.slice(0, topCount).map((n) => `- ${n.title}`));
    // topic を指定して1件も無いときは説明文（「Yahoo Japanニュースの…」）が返るので除く
    const pickIfFound = (res) => (typeof res === 'string' && !res.startsWith('Yahoo Japanニュースの') ? res : null);
    for (const [label, res] of [['【国内】', domesticRes], ['【国際】', worldRes], ['【経済】', bizRes]]) {
      const text = pickIfFound(res);
      if (text) lines.push(label, text);
    }
    return lines.length > 0 ? lines.join('\n') : '（取得できませんでした）';
  } catch (e) {
    getLogger().warn(`[TopicalMaterials] ニュースの見出しの取得に失敗: ${e.message}`);
    return '（取得できませんでした）';
  }
}

/**
 * 社説の読み比べで「各社の主張が割れている話題」を返す。
 * 判定は editorial-compare.js が30分キャッシュするので、報道センター・教授・討論コーナーと同じ時間帯に
 * 呼んでも LLM の呼び出しは増えない。設定（媒体・無効化）は Live の config を見る。
 * @param {{apiKey: string, activitySessionId?: string|null, mediaCompareService?: Record<string, any>|null, usageNote?: string}} opts
 *   usageNote は材料の後ろに添える使い方の注意
 * @returns {Promise<string>} 割れていなければ空文字
 */
async function buildEditorialSplitText({ apiKey, activitySessionId = null, mediaCompareService = null, usageNote = '' } = {}) {
  try {
    const liveConfig = _readLiveConfig();
    if (!MediaCompareService.isEnabled(liveConfig)) return '';
    const service = mediaCompareService || (_sharedMediaCompare ||= new MediaCompareService());
    const clusters = await service.fetchEditorialClusters(liveConfig, { maxClusters: 4 });
    const block = await buildEditorialCompareBlock({ clusters, apiKey, activitySessionId });
    if (!block) return '';
    return `\n【各社の主張が割れている話題（社説の読み比べ）】${block}${usageNote ? `${usageNote}\n` : ''}`;
  } catch (e) {
    getLogger().warn(`[TopicalMaterials] 社説の読み比べに失敗: ${e.message}`);
    return '';
  }
}

/**
 * 自主リサーチ・定期監視の調査結果（Markdown の箇条書き）から、項目ごとに「見出し — 要点の最初の一文」だけを
 * 抜き出す（LLM は使わない）。
 * 書式は「* **見出し**」の下に「* **要点：** 本文」「* **日時：** …」が並ぶ形を前提にしている。
 * @param {string} text
 * @param {{maxItems?: number, gistChars?: number}} [opts]
 * @returns {string[]}
 */
function digestHeadlines(text, { maxItems = 6, gistChars = 70 } = {}) {
  const items = [];
  let current = null;
  const FIELD = /^(要点|発表元|日時|日付|出典|日時・日付)\s*[:：]?$/;
  for (const line of String(text || '').split('\n')) {
    const top = line.match(/^\*\s+\*\*(.+?)\*\*\s*(.*)$/);
    if (top && !FIELD.test(top[1].trim())) {
      if (current) items.push(current);
      current = { title: top[1].replace(/[:：]$/, '').trim(), gist: '' };
      continue;
    }
    const gist = line.match(/^\s+\*\s+\*\*要点\s*[:：]?\*\*\s*[:：]?\s*(.+)$/);
    if (current && gist && !current.gist) {
      current.gist = gist[1].split(/。/)[0].slice(0, gistChars);
    }
  }
  if (current) items.push(current);
  return items.slice(0, maxItems).map((it) => (it.gist ? `${it.title} — ${it.gist}` : it.title));
}

/**
 * 専門分野の最新の動き（エージェントが毎朝調べている内容と、ジャーナリストの定期監視）を、見出しと要点の
 * 一文だけにまとめる。調査の全文は数万字になるため。
 *
 * @param {{excludeListenerLocal?: boolean, perField?: number, watchItems?: number, onlyKeys?: string[]|null, usageNote?: string}} [opts]
 *   onlyKeys: 使う自主リサーチを絞る（例: 音楽チャンネルには暮らしと芸能だけ）
 *   excludeListenerLocal: リスナーの住む地域名を含む項目を除く（The Answers のように、リスナー本人の情報を
 *     渡さない場で true にする）
 * @returns {string} 材料が無ければ空文字
 */
function buildSpecialistDigestText({ excludeListenerLocal = false, perField = 6, watchItems = 8, onlyKeys = null, usageNote = '' } = {}) {
  try {
    let isLocal = () => false;
    if (excludeListenerLocal) {
      const { location } = getEffectiveLocationFromConfig(_readLiveConfig());
      const place = String(location || '').replace(/^.+?[都道府県]/, '');   // 都道府県を除き、市区町村から
      const tokens = [place, place.replace(/[市区町村]$/, '')].filter((t) => t.length >= 2);
      isLocal = (h) => tokens.some((t) => h.includes(t));
    }
    const blocks = [];
    for (const [key, def] of Object.entries(agentProactiveResearch.AGENT_RESEARCH_DEFS || {})) {
      if (!def.general) continue;   // リスナー本人の情報にもとづく調査（教授・弁護士）は渡さない
      if (onlyKeys && !onlyKeys.includes(key)) continue;
      const r = agentProactiveResearch.getLatestResearch(key);
      const heads = r ? digestHeadlines(r.digest, { maxItems: perField + 2 }).filter((h) => !isLocal(h)).slice(0, perField) : [];
      if (heads.length > 0) {
        const field = String(def.promptLabel || key).replace(/(の分野|の話題)?で$/, '');
        blocks.push(`▼${field}\n${heads.map((h) => `- ${h}`).join('\n')}`);
      }
    }
    const watch = journalistWatch.getLatestDigest();
    const watchHeads = watch ? digestHeadlines(watch.digest, { maxItems: watchItems }) : [];
    if (watchHeads.length > 0) {
      blocks.push(`▼要人・政府・企業の公式発表と発言（一次情報の定期監視）\n${watchHeads.map((h) => `- ${h}`).join('\n')}`);
    }
    if (blocks.length === 0) return '';
    return `\n【専門分野の最新の動き（番組のエージェントが直近に調べた内容・発表元と日付は確認済み）】\n`
      + `${blocks.join('\n')}\n${usageNote ? `${usageNote}\n` : ''}`;
  } catch (e) {
    getLogger().warn(`[TopicalMaterials] 専門分野の動きの読み込みに失敗: ${e.message}`);
    return '';
  }
}

/**
 * 世の中の反応（はてなブックマークの反応数・Google トレンド）をプロンプト用の文字列にする。
 * @param {Record<string, any>|null} [trendingService] services/trending-service.js のインスタンス（無ければ共有のもの）
 * @param {{includeVoices?: boolean}} [opts]
 *   includeVoices: 記事に書き込まれた個人の声と、その扱い方の指示（約2,700字）も含めるか。
 *     討論のテーマ選びでは「見方が割れている箇所」が材料になるので含める。編成の判断では含めない
 * @returns {Promise<string>} 失敗したら空文字
 */
async function buildTrendingText(trendingService = null, { includeVoices = true } = {}) {
  try {
    const service = trendingService || (_sharedTrending ||= new TrendingService());
    await service.fetch();
    const { hotEntries, trends, voices } = service.cache || {};
    return service.formatForPrompt({ hotEntries, trends, voices: includeVoices ? voices : [] });
  } catch (e) {
    getLogger().warn(`[TopicalMaterials] 世の中の反応の取得に失敗: ${e.message}`);
    return '';
  }
}

/**
 * 音楽チャンネルのディレクター向けの、短い「季節と世の中の動き」。
 * 選曲やテーマの計画に使うので、Live や The Answers より大きく絞る: 総合ニュースの見出し数件と、
 * 暮らしと食・芸能と世間の新しい動き（季節の行事・エンタメ）だけ。
 * @param {{topCount?: number, perField?: number, usageNote?: string}} [opts]
 * @returns {Promise<string>} 材料が無ければ空文字
 */
async function buildBriefWorldText({ topCount = 5, perField = 3, usageNote = '' } = {}) {
  let headlines = '';
  try {
    const news = (_sharedNews ||= new NewsService());
    await news.fetch({});
    const top = (news.cache?.structured || []).slice(0, topCount).map((n) => `- ${n.title}`);
    if (top.length > 0) headlines = `【総合ニュースの見出し】\n${top.join('\n')}\n`;
  } catch (e) {
    getLogger().warn(`[TopicalMaterials] ニュースの見出しの取得に失敗: ${e.message}`);
  }
  const specialist = buildSpecialistDigestText({
    excludeListenerLocal: false, perField, watchItems: 0, onlyKeys: ['life_advisor', 'comedian'],
  }).replace(/^\n/, '');
  if (!headlines && !specialist) return '';
  return `\n\n【季節と世の中の動き（参考）】\n${headlines}${specialist}${usageNote ? `${usageNote}\n` : ''}`;
}

module.exports = {
  buildBriefWorldText,
  buildNewsHeadlinesText, buildEditorialSplitText, buildSpecialistDigestText, buildTrendingText, digestHeadlines,
};
