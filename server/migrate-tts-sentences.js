#!/usr/bin/env node
/**
 * @file 声の演技指示（tts_profile_title〜tts_context）を、英語の単語の羅列から自然な日本語の文へ書き直す一回限りの移行スクリプト
 *
 * Live・Classic・Jazz・Mood・Beatles の全エージェントと The Answers のディレクターの設定を Gemini で書き直す。
 * あわせて、画面に出ない古い項目 gemini_instruction を削除する。
 *
 * 使い方:
 *   node server/migrate-tts-sentences.js           差分を表示するだけ（書き込まない）
 *   node server/migrate-tts-sentences.js --write   各 config.json へ書き込む
 *
 * ATTENTION: 書き込む前に、必ず書き込まない実行の出力を確かめる。書き込んだ後は git diff で確かめる。
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

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const CREDENTIALS_PATH = path.join(__dirname, 'data', 'credentials.json');
const MODEL = 'gemini-2.5-flash';
const WRITE = process.argv.includes('--write');

const FIELD_LABELS = {
  tts_profile_title: 'Profile Title（役割名）',
  tts_scene: 'Scene（スタジオ・場所の情景）',
  tts_style: 'Style（声のスタイル・トーン）',
  tts_accent: 'Accent（アクセント・出身地）',
  tts_pacing: 'Pacing（話すテンポ・リズム）',
  tts_context: 'Context（キャラクターの役割説明）',
};
const FIELD_KEYS = Object.keys(FIELD_LABELS);

/**
 * JSON ファイルを読む。
 * @param {string} p パス
 * @returns {any}
 */
function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
/**
 * JSON ファイルへ書く（2文字の字下げ・末尾に改行）。
 * @param {string} p パス
 * @param {any} obj 書く内容
 */
function saveJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf-8'); }

/**
 * 移行する対象（エージェントごとの設定と、その保存先）を集める。
 *
 * Live の全エージェント、Classic・Jazz・Mood・Beatles の director と personality、The Answers の director
 * （panelist_pool とは別のトップレベルの項目）が対象。同じ config.json を複数のエージェントで共有するので、
 * 書き込みは保存先ごとに1回にする。
 * @returns {{ targets: Array<Record<string, any>>, answersConfig: Record<string, any>, answersPath: string }}
 */
function buildTargets() {
  const targets = [];

  const rootConfigPath = path.join(__dirname, 'data', 'config.json');
  const rootConfig = loadJson(rootConfigPath);
  for (const [agentKey, agent] of Object.entries(rootConfig.agents || {})) {
    targets.push({ label: `Live: ${agentKey}`, configPath: rootConfigPath, config: rootConfig, agent });
  }

  for (const ch of ['classic', 'jazz', 'mood', 'beatles']) {
    const p = path.join(__dirname, 'data', 'channels', ch, 'config.json');
    const c = loadJson(p);
    for (const [agentKey, agent] of Object.entries(c.agents || {})) {
      targets.push({ label: `${ch}: ${agentKey}`, configPath: p, config: c, agent });
    }
  }

  const answersPath = path.join(__dirname, 'data', 'channels', 'the_answers', 'config.json');
  const answersConfig = loadJson(answersPath);
  targets.push({ label: 'the_answers: director', configPath: answersPath, config: answersConfig, agent: answersConfig.director });

  return { targets, answersConfig, answersPath };
}

/**
 * 応答の本文を取り出す（思考の部分は除く）。
 *
 * ATTENTION: 思考するモデルは、思考の部分（thought: true）も本文と同じ並びで返す。response.text を使わず、
 *            thought の付いた部分を除いてつなぐ（channel-base.js の _callGemini と同じ）。
 * @param {Record<string, any>} result generateContent の結果
 * @returns {string}
 */
function extractText(result) {
  const parts = result.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => p.text != null && !p.thought).map(p => p.text).join('');
}

/**
 * コードフェンスで囲まれていても読めるように、JSON を読む。
 * @param {string} text
 * @returns {any}
 */
function parseJsonLoose(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}

/**
 * 1人のエージェントの演技指示6項目を、Gemini で自然な日本語の文へ書き直す。
 * @param {Record<string, any>} ai GoogleGenAI のクライアント
 * @param {Record<string, any>} agent エージェントの設定
 * @returns {Promise<any>} 項目名から書き直した文への対応（空欄は空文字）
 */
async function callGeminiForFields(ai, agent) {
  const current = {};
  for (const k of FIELD_KEYS) current[k] = agent[k] || '';

  const systemPrompt = `あなたはラジオ番組のTTS（音声合成）ディレクションを専門とするプロンプトエンジニアです。
Gemini TTSは、単語やキーワードの羅列よりも、自然な文章で演技を指示したほうが正確に演技を再現することが分かっています。
与えられたキャラクター設定と現在の（多くは英語キーワード羅列の）設定値をもとに、各項目を自然な日本語の一文（または一続きの短い文章）に書き直してください。
- キャラクターの個性・現在の設定の意図はできる限り保持すること
- 空欄の項目（特にAccent）は無理に埋めず、空文字のままにしてよい
- 出力は必ず次のJSON形式のみ。説明文やマークダウンのコードフェンスは付けないこと:
{"tts_profile_title":"...","tts_scene":"...","tts_style":"...","tts_accent":"...","tts_pacing":"...","tts_context":"..."}`;

  const userPrompt = `キャラクター名: ${agent.name || '(不明)'}
キャラクター設定プロンプト: ${agent.prompt || '(なし)'}
現在の設定値:
${FIELD_KEYS.map(k => `- ${FIELD_LABELS[k]}: ${current[k] || '(空欄)'}`).join('\n')}`;

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
    },
  });
  const parsed = parseJsonLoose(extractText(result));
  const out = {};
  for (const k of FIELD_KEYS) out[k] = typeof parsed[k] === 'string' ? parsed[k] : '';
  return out;
}

/**
 * The Answers のパネリスト共通の「話すテンポ」の指示を、自然な日本語の文へ書き直す。
 * @param {Record<string, any>} ai GoogleGenAI のクライアント
 * @param {string} sampleValue 今の指示文
 * @returns {Promise<string>}
 */
async function callGeminiForPacing(ai, sampleValue) {
  const systemPrompt = `あなたはラジオ番組のTTS（音声合成）ディレクションを専門とするプロンプトエンジニアです。
これは討論番組「The Answers」のパネリスト全員に共通で適用される、話すテンポの指示文です。
「複数人が活発に議論するパネルディスカッションらしい、テンポよく自然な会話」という意図を保ったまま、
自然な日本語の一文に書き直してください。出力は文章のみとし、説明やJSON・引用符は付けないこと。`;
  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: `現在の指示文: ${sampleValue}` }] }],
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
    },
  });
  return extractText(result).trim();
}

/**
 * 全員分を書き直して差分を表示し、--write のときは保存する。
 * @returns {Promise<void>}
 */
async function main() {
  const creds = loadJson(CREDENTIALS_PATH);
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) {
    console.error('Gemini APIキーが見つかりません:', CREDENTIALS_PATH);
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey });

  const { targets, answersConfig, answersPath } = buildTargets();
  const configByPath = new Map();
  for (const t of targets) configByPath.set(t.configPath, t.config);
  configByPath.set(answersPath, answersConfig);
  const touchedPaths = new Set();

  for (const t of targets) {
    console.log(`\n=== ${t.label} ===`);
    const before = {};
    for (const k of FIELD_KEYS) before[k] = t.agent[k] || '';
    const hadLegacyInstruction = t.agent.gemini_instruction !== undefined;
    if (hadLegacyInstruction) {
      console.log(`  [gemini_instruction] 削除対象: "${t.agent.gemini_instruction}"`);
    }

    let after;
    try {
      after = await callGeminiForFields(ai, t.agent);
    } catch (e) {
      console.error(`  ⚠ リライト失敗、このエージェントはスキップします: ${e.message}`);
      continue;
    }

    for (const k of FIELD_KEYS) {
      const b = before[k] || '(空欄)';
      const a = after[k] || '(空欄)';
      if (b !== a) console.log(`  ${FIELD_LABELS[k]}:\n    - ${b}\n    + ${a}`);
    }

    if (WRITE) {
      for (const k of FIELD_KEYS) t.agent[k] = after[k] || '';
      if (hadLegacyInstruction) delete t.agent.gemini_instruction;
      touchedPaths.add(t.configPath);
    }
  }

  // panelist_pool の tts_pacing_override は全員同じ値なので、1回だけ書き直して全員に入れる
  const poolEntries = Object.entries(answersConfig.panelist_pool || {}).filter(([, p]) => p.tts_pacing_override);
  if (poolEntries.length > 0) {
    console.log(`\n=== the_answers: panelist_pool.tts_pacing_override（${poolEntries.length}件、共通値のため一括リライト） ===`);
    const sample = poolEntries[0][1].tts_pacing_override;
    try {
      const rewritten = await callGeminiForPacing(ai, sample);
      console.log(`  - ${sample}\n  + ${rewritten}`);
      if (WRITE) {
        for (const [, p] of poolEntries) p.tts_pacing_override = rewritten;
        touchedPaths.add(answersPath);
      }
    } catch (e) {
      console.error(`  ⚠ リライト失敗、スキップします: ${e.message}`);
    }
  }

  if (WRITE) {
    for (const p of touchedPaths) {
      saveJson(p, configByPath.get(p));
      console.log(`\n✓ 書き込み完了: ${p}`);
    }
    console.log('\ngit diff で変更内容を確認してください。');
  } else {
    console.log('\n(dry-runモードのため書き込みは行っていません。内容を確認後 --write を付けて再実行してください)');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
