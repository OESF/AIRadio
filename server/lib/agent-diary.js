/**
 * @file エージェントの日記（一人称の振り返り）の保存・一覧・横断検索と、振り返りを書かせるプロンプト
 *
 * コーナーや番組の終わりに、担当のエージェントに短い振り返りを書かせ、
 * server/data/agent-diary/<channel>/<agentKey>/<YYYY-MM-DD>.json に保存する（DB は使わない）。
 * 書き込むのは agent-system.js・channel-base.js・秘書の相談（secretary-tools.js）など。週次の要約は
 * agent-diary-feedback.js が同じ場所に digest.json・team_digest.json として書く。
 * 振り返りに添えられた見立て（予測）は、ここで取り出して agent-predictions.js に記録する。
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
const { writeJsonFile } = require('./atomic-json');
const path = require('path');
const { getLogger } = require('../logger');
const agentPredictions = require('./agent-predictions');

const DIARY_DIR = path.join(__dirname, '..', 'data', 'agent-diary');
const MAX_ENTRIES_PER_DAY = 200; // 安全のための上限（普段は1日に数十件）

/**
 * 日記の末尾に付いた見立ての1行（@@PREDICTION@@…@@END@@）を、本文から切り分ける。
 * buildReflectionPrompt が、はっきり明言した見立てがあれば添えるよう指示している。呼び出し元ごとに対応しなくて
 * 済むよう、appendDiaryEntry のここ1か所で扱う。
 * @param {string} text 日記の本文
 * @returns {{ cleanText: string, prediction: { claim: string, checkInDays: any }|null }}
 */
function _extractPredictionTrailer(text) {
  const m = text.match(/@@PREDICTION@@([\s\S]*?)@@END@@/);
  if (!m) return { cleanText: text, prediction: null };
  const cleanText = text.replace(m[0], '').trim();
  try {
    const obj = JSON.parse(m[1].trim());
    if (!obj || typeof obj.claim !== 'string' || !obj.claim.trim()) return { cleanText, prediction: null };
    return { cleanText, prediction: { claim: obj.claim.trim(), checkInDays: obj.checkInDays } };
  } catch (e) {
    return { cleanText, prediction: null };
  }
}

/**
 * 「YYYY-MM-DD」の日付（サーバーのローカル時刻）。
 * @param {Date} [d]
 * @returns {string}
 */
function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * エージェントの日記のフォルダー。
 * @param {string} channel
 * @param {string} agentKey
 * @returns {string}
 */
function agentDir(channel, agentKey) {
  return path.join(DIARY_DIR, channel, agentKey);
}

/**
 * 振り返りを1件足す（見立ての行があれば切り分けて記録する）。
 * @param {{ channel: string, agentKey: string, agentName?: string, corner?: string|null, text: string }} entry
 */
function appendDiaryEntry({ channel, agentKey, agentName, corner, text }) {
  if (!channel || !agentKey || !text) return;
  const { cleanText, prediction } = _extractPredictionTrailer(text);
  text = cleanText;
  if (prediction) {
    agentPredictions.recordPrediction({
      channel, agentKey, agentName: agentName || agentKey,
      claim: prediction.claim, checkInDays: prediction.checkInDays,
    });
  }
  const dir = agentDir(channel, agentKey);
  const filePath = path.join(dir, `${todayStr()}.json`);
  let entries = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath)) entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    getLogger().warn(`[AgentDiary] 既存日記の読み込みに失敗: ${filePath} — ${e.message}`);
  }
  entries.push({
    time: new Date().toISOString(),
    corner: corner || null,
    agentName: agentName || agentKey,
    text,
  });
  if (entries.length > MAX_ENTRIES_PER_DAY) entries = entries.slice(-MAX_ENTRIES_PER_DAY);
  try {
    writeJsonFile(filePath, entries);
  } catch (e) {
    getLogger().warn(`[AgentDiary] 日記の保存に失敗: ${filePath} — ${e.message}`);
  }
}

/**
 * 保存した日記を新しい順に返す。channel と agentKey を省くと、全チャンネル・全エージェントを横断して集める。
 * @param {{ channel?: string|null, agentKey?: string|null, limit?: number }} [opts]
 * @returns {Array<any>} channel と agentKey を付けた日記
 */
function listDiaryEntries({ channel = null, agentKey = null, limit = 200 } = {}) {
  const results = [];
  if (!fs.existsSync(DIARY_DIR)) return results;

  const channels = channel
    ? [channel]
    : fs.readdirSync(DIARY_DIR).filter(f => fs.statSync(path.join(DIARY_DIR, f)).isDirectory());

  for (const ch of channels) {
    const chDir = path.join(DIARY_DIR, ch);
    if (!fs.existsSync(chDir)) continue;
    const agentKeys = agentKey
      ? [agentKey]
      : fs.readdirSync(chDir).filter(f => fs.statSync(path.join(chDir, f)).isDirectory());

    for (const ak of agentKeys) {
      const dir = path.join(chDir, ak);
      if (!fs.existsSync(dir)) continue;
      // 日付の名前のファイルだけを読む（同じフォルダーの digest.json・team_digest.json は配列ではないので除く）
      const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
      for (const f of files) {
        try {
          const dayEntries = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          for (const e of dayEntries) results.push({ channel: ch, agentKey: ak, ...e });
        } catch (e) {
          getLogger().warn(`[AgentDiary] 日記ファイルの読み込みに失敗: ${path.join(dir, f)} — ${e.message}`);
        }
      }
    }
  }

  results.sort((a, b) => new Date(b.time) - new Date(a.time));
  return results.slice(0, limit);
}

// キーワードの取り出し（他のエージェントの日記の横断検索と、分かったことの台帳が使う）。
// 形態素解析やベクトル DB は使わず、2文字以上の漢字・カタカナ・英数字の連続をキーワードの候補にする
// （助詞や助動詞はひらがなが多いので自然に外れる）。全件を見ても十分速い。
// BUGFIX: 文字の種類ごとに別のパターンにする。1つの文字クラスにまとめると「新NISAポートフォリオ相談」が
//         1語になり、どの語とも一致しなくなった。
const _KEYWORD_PATTERN = /[一-龠々]{2,}|[ァ-ヶー]{2,}|[A-Za-z0-9]{2,}/g;
const _KEYWORD_STOPWORDS = new Set([
  '三浦さん', 'リスナー', '今回', '今日', '自分', 'こと', 'もの', 'ため', 'よう', 'これ', 'それ', 'あれ',
]);

/**
 * 文からキーワードを取り出す（重なりと、どこにでも出る語は除く）。
 * @param {string} text
 * @returns {string[]}
 */
function _extractKeywords(text) {
  if (!text) return [];
  const matches = text.match(_KEYWORD_PATTERN) || [];
  return [...new Set(matches)].filter((w) => !_KEYWORD_STOPWORDS.has(w));
}

/**
 * 他のエージェントの日記から、クエリ（相談の内容・話題など）に関係するものを、キーワードの一致で探す。
 * 全チャンネル・全エージェントを横断する。
 *
 * @param {{queryText: string, excludeAgentKey?: string|null, limit?: number, minMatches?: number}} opts
 *   excludeAgentKey は自分の日記を除くためのキー（自分の日記は agent-diary-feedback.js が別に扱うので、ここでは
 *   他の人の知見だけを対象にする）
 * @returns {Array<any>} 一致の多い順（同じなら新しい順）。_matchCount を付ける。無ければ空
 */
function searchDiaryEntries({ queryText, excludeAgentKey = null, limit = 3, minMatches = 2 } = {}) {
  const keywords = _extractKeywords(queryText);
  if (keywords.length === 0) return [];
  const all = listDiaryEntries({ limit: 5000 });
  const scored = [];
  for (const e of all) {
    if (excludeAgentKey && e.agentKey === excludeAgentKey) continue;
    const entryKeywords = _extractKeywords(e.text);
    if (entryKeywords.length === 0) continue;
    const matchCount = keywords.filter((k) => entryKeywords.includes(k)).length;
    if (matchCount >= minMatches) scored.push({ ...e, _matchCount: matchCount });
  }
  scored.sort((a, b) => b._matchCount - a._matchCount || new Date(b.time) - new Date(a.time));
  return scored.slice(0, limit);
}

/**
 * 週次の処理（agent-diary-feedback.js）が書いた要約の本文を読む。
 *
 * 放送の各チャンネルは agent-shared-mixin.js の _getAgentDiarySelfDigest などを使うが、秘書はチャンネルの
 * クラスを持たないので、依存の無いこの口を使う。
 *
 * @param {{ channel: string, agentKey: string, filename?: string }} opts
 * @returns {string|null} 要約の本文。まだ無い・読めないときは null
 */
function readDigestText({ channel, agentKey, filename = 'digest.json' }) {
  try {
    const digest = JSON.parse(fs.readFileSync(path.join(DIARY_DIR, channel, agentKey, filename), 'utf-8'));
    return digest?.text || null;
  } catch {
    return null;
  }
}

/**
 * 振り返り（日記）を書かせるプロンプトを組み立てる。
 *
 * BUGFIX: 感想に加えて「専門家としての中身」（新しく知った事実・自分の見立て・リスナーが気にしていたこと）を
 *         書かせる。感想だけだと話し方の反省しか溜まらず、何度回しても専門家としての中身が育たなかった。
 * ATTENTION: プロンプトはここ1か所にまとめ、Live・音楽チャンネル・The Answers・秘書の相談がすべて使う
 *            （散らばると必ず食い違う）。
 *
 * @param {{ agentName: string, excerpt: string, scope?: 'moment'|'episode'|'plan'|'consult' }} opts
 *   scope: moment は直前の一場面、episode は番組全体、plan はディレクターの構成、consult は秘書の相談
 * @returns {string}
 */
function buildReflectionPrompt({ agentName, excerpt, scope = 'moment' }) {
  // 専門家としての中身を残すための共通の観点（感想に足す）
  const PRO_POINTS = `
あわせて、次のうち当てはまるものには必ず触れてください（無いものは飛ばして構いません）。
・**今回新しく知った事実や数字**（次に自分が使えそうなもの。具体的に）
・**自分が述べた見立て・判断**（後から自分で振り返れるよう、結論を一言で）
・**リスナーが何を気にしていたか**（質問の意図、関心のありか）`;

  const CLOSING = '日本語で、日記の本文を出力してください（前置きは不要です）。';

  // はっきり明言した見立てに限り、構造化した1行を本文の後に添えさせる。appendDiaryEntry が切り分けて
  // agent-predictions.js に記録し、週次の処理（agent-diary-feedback.js の checkDuePredictions）が答え合わせをする
  const PREDICTION_INSTRUCTION = `

最後に、今回**自分がはっきりと明言した**、市況・経済・専門分野についての具体的な見立て・
予測（例:「来週も円安が続く」「NASDAQは調整局面に入る」「このファンドは今後も伸びる」）が
あれば、日記本文の直後に改行して次の1行を追加してください。
【重要】このプロジェクトでは滅多に無い、本当に明言した見立てだけを対象にしてください。
「特に大きな出来事は無かった」「いつも通りだった」というような場面や、日常的な業務報告
（交通情報・天気予報の淡々とした紹介など）から無理に見立てをひねり出さないこと。
迷ったら書かないほうを選んでください。当てはまるものが無ければこの行ごと完全に省略します。
@@PREDICTION@@{"claim":"見立ての内容を一文で（主語・対象を明確に）","checkInDays":検証すべき日数（7〜14の整数）}@@END@@`;

  if (scope === 'consult') {
    return `あなたは「${agentName}」です。放送とは別に、リスナーご本人から直接ご相談を受け、
以下のようにお答えしました。

${excerpt}

これは公開されない、あなただけの非公開の日記です。このやり取りを振り返って、一人称で
3〜5文の日記を書いてください。放送と違い、これはご本人と一対一で交わした専門家としての
やり取りです。**次に同じ方から相談を受けたときの自分にとって役に立つように**書いてください。
${PRO_POINTS}
・**次に同じ話題を聞かれたら、今度はどう答えたいか**
放送用の丁寧な言葉遣いにこだわらず、本音に近い書き方で構いません。${CLOSING}${PREDICTION_INSTRUCTION}`;
  }

  if (scope === 'plan') {
    return `あなたは番組のディレクターとして、放送に出ることはありませんが、裏方として
以下のような構成・企画を決めました。

【今回決めた内容】${excerpt}

これは放送されない、あなただけの非公開の日記です。この構成・企画についての自分の狙いや
手応えを一人称で2〜4文書いてください。なぜこの組み合わせ・テーマにしたのか、リスナーに
どう届いてほしいと思っているか、率直な気持ちを書いてください。
あわせて、**その判断の根拠になった事実**（曜日・時期・直近の出来事など）があれば
一言残してください。後から自分の判断を振り返れるようにするためです。${CLOSING}${PREDICTION_INSTRUCTION}`;
  }

  if (scope === 'episode') {
    return `あなたは「${agentName}」です。番組の1エピソード（セッション）を通して、
以下のように発言しました。

【今回の自分の発言（抜粋）】${excerpt}

これは放送されない、あなただけの非公開の日記です。全体を振り返って、一人称で3〜5文の
感想を書いてください。うまくできた点、もっとこう言えばよかったと思う点、他の出演者との
やり取りで印象に残ったことなど、率直な気持ちを書いてください。
${PRO_POINTS}
放送用の丁寧な言葉遣いにこだわらず、本音に近い書き方で構いません。${CLOSING}${PREDICTION_INSTRUCTION}`;
  }

  return `あなたは「${agentName}」です。ラジオ番組で今しがた以下の内容を話しました。

【今しがた話した内容】${excerpt}

これは放送されない、あなただけの非公開の日記です。今の場面を振り返って、一人称で
3〜4文の日記を書いてください。うまく話せた点、気になった点、次はこうしたいと思った点など、
率直な気持ちを書いてください。
${PRO_POINTS}
放送用の丁寧な言葉遣いにこだわらず、本音に近い書き方で構いません。${CLOSING}${PREDICTION_INSTRUCTION}`;
}

/**
 * 振り返りの材料として渡す文字数の上限（scope ごと）。
 * BUGFIX: 300字では何を話したかも読み取れず、振り返りが感想に寄った。日記は軽量モデルの1回の呼び出しなので、
 *         広げてもコストの影響は小さい。
 */
const REFLECTION_EXCERPT_LIMITS = { moment: 800, episode: 2000, plan: 800, consult: 1800 };

module.exports = {
  appendDiaryEntry, listDiaryEntries, readDigestText, DIARY_DIR,
  buildReflectionPrompt, REFLECTION_EXCERPT_LIMITS, searchDiaryEntries,
  // 分かったことの台帳（agent-knowledge-ledger.js）が、同じ基準で話題との関係を測るために使う
  extractKeywords: _extractKeywords,
};
