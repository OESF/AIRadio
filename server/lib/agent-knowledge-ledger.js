/**
 * @file エージェントの「分かったこと」の台帳（いつ・どこで知り・何が分かったかを1件ずつ溜める）
 *
 * 継続観測メモ（追っている話題の見出し）や日記の週次の要約（主に話し方の反省）には、「何が分かったか」が残らない。
 * ここでは事実を1件ずつ溜め、話すときに今の話題に関係するものを選んで渡す。直近の数件で押し出されないので長く残る。
 * 保存先は server/data/agent-knowledge/<エージェント>.json。
 *
 * 書き込み: 自主リサーチの結果（agent-proactive-research.js）と、放送・討論・The Answers・見た YouTube
 *   （agent-knowledge-pack.js の recordAgentNote）。軽量モデルが「後から読んでも意味が通る事実」を取り出す
 *   （意見・予想・演出は除く）。同じ事実は重ねず、再確認された日付だけ更新する（キーワードの重なりで判定）。
 * 読み出し: agent-knowledge-pack.js の knowledge の項目。関連度は日記の横断検索と同じキーワードの一致で決める
 *   （LLM は使わない）。キャスターとアシスタントには、全員の台帳から選んだもの（formatCrossAgentKnowledge）を渡す。
 * 対象: 知識が積み上がる持ち場だけ（KNOWLEDGE_AGENTS）。天気・交通のようなその日限りの情報や、自分の知識で
 *   話さない音楽 DJ・ワールドレポートは対象外。
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
const crypto = require('crypto');
const { generateText } = require('./llm-client');
const { getLogger } = require('../logger');
const jsonFileStore = require('./json-file-store');
const { extractKeywords } = require('./agent-diary');

const LEDGER_DIR = path.join(__dirname, '..', 'data', 'agent-knowledge');
const MAX_STORED = 400;            // 1人あたりの保存の上限（超えたら古いものから落とす）
const MAX_FACTS_PER_RECORD = 4;    // 1つの出来事から取り出す上限
const DEDUP_OVERLAP = 0.6;         // キーワードの重なりがこれ以上なら同じ事実とみなす
const DEFAULT_INJECT = 8;          // 1回に渡す件数
// 話題から関連度を測るときに数えない、どの話題にも出てくる語
const GENERIC_TOPIC_WORDS = new Set([
  '発表', '最近', '影響', '関係', '問題', '話題', '判断', '状況', '今後', '日本', '世界', '情報',
  '一般', '全国', '可能', '必要', '内容', '場合', '時点', '予定', '結果', '調査', '動向', '注目',
]);
const MIN_FACT_CHARS = 15;         // これより短い文は事実として扱わない（挨拶や感想を拾わないため）

const KNOWLEDGE_AGENTS = [
  'commentator', 'journalist', 'legal_advisor',
  'doctor', 'life_advisor', 'marketer', 'comedian',
  'news', 'finance',
];

/**
 * どこで知ったか（プロンプトと一覧に出す呼び名）
 */
const SOURCE_TYPES = {
  research: '自主リサーチ',
  corner: '自分のコーナー',
  discussion: '討論',
  the_answers: 'The Answers',
  youtube: '見た動画（未検証）',
};

/**
 * 台帳を持つエージェントか。
 * @param {string} agentKey エージェントのキー（poolKey でもよい）
 * @returns {boolean}
 */
function isKnowledgeAgent(agentKey) {
  return KNOWLEDGE_AGENTS.includes(String(agentKey || '').replace(/^live_/, ''));
}

/**
 * 台帳のファイルのパス。
 * @param {string} agentKey
 * @returns {string}
 */
function _path(agentKey) {
  return path.join(LEDGER_DIR, `${agentKey}.json`);
}

/**
 * 台帳の事実をすべて読む。
 * @param {string} agentKey
 * @returns {Array<any>}
 */
function readFacts(agentKey) {
  const data = jsonFileStore.readJsonFile(_path(agentKey), null, '[KnowledgeLedger]');
  return Array.isArray(data?.facts) ? data.facts : [];
}

/**
 * 台帳を書く（上限を超えた古いものは落とす）。
 * @param {string} agentKey
 * @param {Array<Record<string, any>>} facts
 */
function _writeFacts(agentKey, facts) {
  jsonFileStore.writeJsonFile(_path(agentKey), { facts: facts.slice(-MAX_STORED) }, '[KnowledgeLedger]');
}

/**
 * 2つのキーワードの並びの重なりの割合（短い方に対して）。
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0〜1
 */
function _overlap(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((k) => setB.has(k)).length;
  return shared / Math.min(a.length, b.length);
}

/**
 * 出来事の本文から「分かったこと」を取り出して台帳へ加える。結果を待たずに呼ぶ。
 * @param {string} agentKey エージェントのキー（poolKey でもよい）
 * @param {string} text     話した内容・調べた内容
 * @param {{apiKey?: string, activitySessionId?: string|null, sourceType?: string, maxFacts?: number}} [opts]
 *   sourceType は SOURCE_TYPES のキー。maxFacts は1回で取り出す上限（自主リサーチは1日に10件前後の発表が
 *   並ぶので多めに渡す）
 * @returns {Promise<number>} 新しく加えた件数
 */
async function recordKnowledge(agentKey, text, { apiKey = null, activitySessionId = null, sourceType = 'corner', maxFacts = MAX_FACTS_PER_RECORD } = {}) {
  const key = String(agentKey || '').replace(/^live_/, '');
  if (!isKnowledgeAgent(key) || !apiKey || !text || text.length < 40) return 0;
  const typeLabel = SOURCE_TYPES[sourceType] || SOURCE_TYPES.corner;

  const systemInstruction = 'あなたは専門家の「知識ノート」をつける記録係です。与えられた文章から、'
    + 'この専門家が**後日の放送や相談でも使える事実**だけを取り出してください。\n'
    + '取り出す基準:\n'
    + '- 誰が・何を・いつ・どれだけ、が分かる具体的な事実（決定・発表・承認・統計の数値・制度の変更・発売・出来事）\n'
    + '- 文章の中に書かれていることだけ。書かれていない数値・日付・発表元を補わない\n'
    + '- 後から単独で読んでも意味が通る1文にする。日付が分かれば文中に含める\n'
    + '対象外:\n'
    + '- 意見・感想・予想・見通し・「〜かもしれない」という推測\n'
    + '- 番組の演出（「独自ソースによると」「極秘情報」など、裏付けの無い話）\n'
    + '- 今日の天気や一時的な値動きのように、翌日には意味を失う情報\n'
    + '- 一般常識（誰でも知っていること）\n'
    + `取り出せる事実が無ければ空の配列にしてください。最大${maxFacts}件。出力はJSONのみ。`;
  const prompt = `【文章の出どころ】${typeLabel}\n\n${text.slice(0, 6000)}\n\n`
    + '出力形式（このJSONのみ）: {"facts": [{"fact": "事実の1文", "source": "発表元・出典（文中に書かれていれば。無ければ空文字）"}]}';

  let parsed;
  try {
    const { text: raw } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt,
      temperature: 0,
      json: true,
      agentKey: `knowledge_ledger_${key}`,
      activitySessionId,
    });
    parsed = JSON.parse(raw);
  } catch (e) {
    getLogger().debug(`[KnowledgeLedger] ${key}: 取り出しに失敗（無視して続行）: ${e.message}`);
    return 0;
  }
  const candidates = (Array.isArray(parsed?.facts) ? parsed.facts : [])
    .map((f) => ({ fact: String(f?.fact || '').trim(), source: String(f?.source || '').trim() }))
    .filter((f) => f.fact.length >= MIN_FACT_CHARS)
    .slice(0, maxFacts);
  if (candidates.length === 0) return 0;

  const facts = readFacts(key);
  const now = new Date().toISOString();
  let added = 0;
  let reconfirmed = 0;
  for (const c of candidates) {
    const keywords = extractKeywords(c.fact);
    const dup = facts.find((f) => _overlap(keywords, f.keywords || extractKeywords(f.fact)) >= DEDUP_OVERLAP);
    if (dup) {
      dup.lastConfirmedAt = now;
      reconfirmed++;
      continue;
    }
    facts.push({
      id: crypto.randomUUID(),
      fact: c.fact,
      source: c.source,
      sourceType,
      learnedAt: now,
      lastConfirmedAt: now,
      keywords,
    });
    added++;
  }
  if (added > 0 || reconfirmed > 0) {
    _writeFacts(key, facts);
    getLogger().info(`[KnowledgeLedger] ${key}: ${typeLabel}から ${added}件を記録${reconfirmed ? `（${reconfirmed}件は既知・再確認）` : ''}（計${Math.min(facts.length, MAX_STORED)}件）`);
  }
  return added;
}

/**
 * 「9/18」の形の日付。
 * @param {string} iso
 * @returns {string} 読めなければ空文字
 */
function _dateLabel(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 話題に関係する「分かったこと」を選ぶ。関係するものが足りなければ新しいもので埋める。
 * @param {string} agentKey
 * @param {{topic?: string, limit?: number}} [opts]
 * @returns {Array<Record<string, any>>} 関係の深い順、次に新しい順。話題に関係して選んだものは _related: true
 */
function selectFacts(agentKey, { topic = '', limit = DEFAULT_INJECT } = {}) {
  const key = String(agentKey || '').replace(/^live_/, '');
  const facts = readFacts(key);
  if (facts.length === 0) return [];
  const newest = (a, b) => String(b.lastConfirmedAt || b.learnedAt).localeCompare(String(a.lastConfirmedAt || a.learnedAt));

  // 関連度は「話題のキーワードが事実の文の中に含まれるか」で数える。
  // BUGFIX: キーワード同士の完全一致にしない。漢字が続くと1語にまとまり、事実の「感染症発生動向調査」が
  //         話題の「感染症」と一致しなくなる。
  // BUGFIX: 1語の一致でも関係ありとし、一致の多い順に並べる。2語以上を求めると取りこぼした。
  // どの話題にも出てくる語（GENERIC_TOPIC_WORDS）は数えない。
  const topicKeywords = extractKeywords(topic).filter((k) => !GENERIC_TOPIC_WORDS.has(k));
  const needed = 1;
  let related = [];
  if (topicKeywords.length > 0) {
    related = facts
      .map((f) => ({ f, score: topicKeywords.filter((k) => f.fact.includes(k)).length }))
      .filter((x) => x.score >= needed)
      .sort((a, b) => b.score - a.score || newest(a.f, b.f))
      .map((x) => x.f)
      .slice(0, limit);
  }
  const chosen = new Set(related.map((f) => f.id));
  const recent = facts.filter((f) => !chosen.has(f.id)).sort(newest).slice(0, Math.max(0, limit - related.length));
  return [...related.map((f) => ({ ...f, _related: true })), ...recent];
}

/**
 * 知識パックへ入れる文面を作る。
 * @param {string} agentKey
 * @param {{topic?: string, limit?: number}} [opts]
 * @returns {string} 台帳が空なら空文字
 */
function formatKnowledgeForPrompt(agentKey, opts = {}) {
  const chosen = selectFacts(agentKey, opts);
  if (chosen.length === 0) return '';
  const lines = chosen.map((f) => {
    const where = SOURCE_TYPES[f.sourceType] || '';
    const src = f.source ? `・出典: ${f.source}` : '';
    return `- [${_dateLabel(f.learnedAt)}に${where}で知った${src}] ${f.fact}`;
  });
  const relatedCount = chosen.filter((f) => f._related).length;
  const breakdown = relatedCount > 0
    ? `話題に関係するもの${relatedCount}件${chosen.length > relatedCount ? `・最近のもの${chosen.length - relatedCount}件` : ''}`
    : `最近のもの${chosen.length}件`;
  return `\n\n【あなたがこれまでに知ったこと（${breakdown}）】\n${lines.join('\n')}\n`
    + '※ 話題に関係するときは、あなた自身の知識として使ってください。**日付を見て、今も正しいかを'
    + '判断すること**（数値や状況は変わります。今回の検索結果やデータと食い違えば、新しい方を優先）。'
    + '「見た動画（未検証）」で知ったことは断定せず、留保を付けて扱ってください。関係が無ければ触れなくて構いません。\n';
}

/**
 * 全エージェントの台帳から、話題に関係する事実を選ぶ（キャスター・アシスタント用）。
 * 司会役は自分の台帳を持たないが、専門家たちが仕入れたことを踏まえて話を回せるようにする。
 * 選び方は selectFacts と同じ（話題のキーワードが文の中に含まれるか。足りなければ新しい順）。
 * @param {{topic?: string, limit?: number, nameOf?: (agentKey: string) => string}} [opts]
 *   nameOf はエージェントのキーから表示名を引く関数
 * @returns {string} 台帳が空なら空文字
 */
function formatCrossAgentKnowledge({ topic = '', limit = 6, nameOf = (k) => k } = {}) {
  const all = [];
  for (const agentKey of KNOWLEDGE_AGENTS) {
    for (const f of readFacts(agentKey)) all.push({ ...f, agentKey });
  }
  if (all.length === 0) return '';
  const newest = (a, b) => String(b.lastConfirmedAt || b.learnedAt).localeCompare(String(a.lastConfirmedAt || a.learnedAt));
  const topicKeywords = extractKeywords(topic).filter((k) => !GENERIC_TOPIC_WORDS.has(k));
  const scored = all.map((f) => ({ f, score: topicKeywords.filter((k) => f.fact.includes(k)).length }));
  const related = scored.filter((x) => x.score >= 1).sort((a, b) => b.score - a.score || newest(a.f, b.f)).map((x) => x.f);
  const picked = related.slice(0, limit);
  const ids = new Set(picked.map((f) => f.id));
  if (picked.length < limit) {
    picked.push(...all.filter((f) => !ids.has(f.id)).sort(newest).slice(0, limit - picked.length));
  }
  const lines = picked.map((f) => {
    const src = f.source ? `・出典: ${f.source}` : '';
    const unverified = f.sourceType === 'youtube' ? '・未検証' : '';
    return `- [${_dateLabel(f.learnedAt)}・${nameOf(f.agentKey)}が知った${src}${unverified}] ${f.fact}`;
  });
  return `\n\n【番組の専門家たちが最近知ったこと（話題に関係するものを中心に${picked.length}件）】\n${lines.join('\n')}\n`;
}

/**
 * 管理画面の一覧用（件数・最新の日付・どこで知ったかの内訳）。本文は返さない。
 * @returns {Array<{agentKey: string, count: number, latestLearnedAt: string|null, bySource: Object}>} bySource はどこで知ったかごとの件数
 */
function summarizeLedger() {
  return KNOWLEDGE_AGENTS.map((agentKey) => {
    const facts = readFacts(agentKey);
    const bySource = {};
    for (const f of facts) bySource[f.sourceType] = (bySource[f.sourceType] || 0) + 1;
    const latest = facts.reduce((m, f) => (String(f.learnedAt) > m ? String(f.learnedAt) : m), '');
    return { agentKey, count: facts.length, latestLearnedAt: latest || null, bySource };
  });
}

module.exports = {
  formatCrossAgentKnowledge,
  KNOWLEDGE_AGENTS, SOURCE_TYPES, isKnowledgeAgent,
  recordKnowledge, readFacts, selectFacts, formatKnowledgeForPrompt, summarizeLedger,
};
