/**
 * @file 秘書が会話をまたいで覚えておく学習と、全エージェント向けのリスナー像を扱う
 *
 * Gemini Live の会話は毎回まっさらな状態から始まるので、会話で分かった訂正や好みは、接続が切れると
 * 失われる。ここでは次の会話でも使う短い事実を learnings.json に残し、接続のときに秘書の system
 * instruction に入れる。学習が増える経路は3つ。
 * - リスナーが「覚えておいて」と頼んだとき（remember_fact ツール。source: 'explicit'）
 * - 会話の終わりに、会話全体から LLM で取り出す（summarizeSessionLearnings）
 * - 新着メールなど会話以外の材料から、LLM で取り出す（summarizeAmbientLearnings）
 *
 * プロンプトには全部を入れず、明示的なものと直近の自動のものだけを入れる（全部入れると肝心の1件が
 * 埋もれる）。古い自動の学習は LLM でまとめて減らす（compactOldAutoLearnings）。
 *
 * 学習とは別に、全エージェントが読む短いリスナー像（digest.json）と、YouTube の登録チャンネルから
 * 推し量った興味の傾向（youtube_interest_digest.json）、他チャンネルと共有する資産の構成比
 * （finance_public_summary.json）も持つ。
 *
 * 保存先: server/data/secretary/memory/
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-19
 */
'use strict';

const path = require('path');
const { generateText } = require('./llm-client');
const { getLogger } = require('../logger');
const jsonFileStore = require('./json-file-store');

const MEMORY_DIR = path.join(__dirname, '..', 'data', 'secretary', 'memory');
const LEARNINGS_PATH = path.join(MEMORY_DIR, 'learnings.json');
const DIGEST_PATH = path.join(MEMORY_DIR, 'digest.json');
const YOUTUBE_INTEREST_DIGEST_PATH = path.join(MEMORY_DIR, 'youtube_interest_digest.json');
const FINANCE_PUBLIC_SUMMARY_PATH = path.join(MEMORY_DIR, 'finance_public_summary.json');
const MAX_STORED = 200; // ファイルに残す件数の上限（古いものから消す）
const MAX_INJECTED = 30; // プロンプトに入れる自動の学習（圧縮したものを含む）の件数の上限。明示的なものは別枠で全部入れる

// 自動の学習が増えると、上限を超えた古いものはプロンプトに入らなくなる。そこで直近 AUTO_KEEP_RECENT 件より
// 古いものが AUTO_COMPACT_BATCH_MIN 件以上たまったら、LLM で数件にまとめる（compactOldAutoLearnings）。
// ATTENTION: 明示的に覚えさせたもの（source: 'explicit'）は圧縮しない。次の接続でも必ず参照される、という約束のため
const AUTO_KEEP_RECENT = 20;      // 自動の学習のうち、圧縮せずに残す直近の件数
const AUTO_COMPACT_BATCH_MIN = 10; // 古い自動の学習がこの件数に満たない間は圧縮しない（数件のために LLM を呼ばない）

/**
 * 学習した内容の一覧を読む。
 * @returns {Array<any>} 学習（id・text・source・addedAt）。無ければ空
 */
function readLearnings() {
  return jsonFileStore.readJsonFile(LEARNINGS_PATH, [], '[SecretaryMemory]');
}

/**
 * 学習した内容の一覧を書く（新しい方から MAX_STORED 件まで）。
 * @param {Array<any>} list 学習の一覧
 * @returns {void}
 */
function writeLearnings(list) {
  jsonFileStore.writeJsonFile(LEARNINGS_PATH, list.slice(-MAX_STORED), '[SecretaryMemory]');
}

/**
 * 次に使う ID（一覧の最大の ID＋1）。書き足すたびにその時点の一覧から決める（手で編集されても食い違わない）。
 * @param {Array<any>} list 学習の一覧
 * @returns {number} ID
 */
function nextIdFor(list) {
  return list.reduce((max, e) => Math.max(max, e.id || 0), 0) + 1;
}

/**
 * リスナーが「覚えておいて」と頼んだことを1件保存する（remember_fact ツールから）。
 * @param {string} fact 覚える内容
 * @returns {void}
 */
function rememberExplicit(fact) {
  const text = (fact || '').trim();
  if (!text) return;
  const list = readLearnings();
  list.push({ id: nextIdFor(list), text, source: 'explicit', addedAt: new Date().toISOString() });
  writeLearnings(list);
  getLogger().info(`[SecretaryMemory] 明示的な学習内容を保存: ${text.slice(0, 60)}`);
}

/**
 * 学習を取り出すプロンプトに添える、リスナー像の短い手がかりを作る。
 * 音声認識の誤変換を「話の流れから浮いている」と見分ける材料にするため。
 * @param {Record<string, any>|null|undefined} profile config.show.user_profile
 * @returns {string} 手がかりの文（プロフィールが無ければ空文字）
 */
function _buildProfileHint(profile) {
  if (!profile) return '';
  const bits = [];
  if (profile.occupation) bits.push(`職業: ${profile.occupation}`);
  if (profile.interests) bits.push(`関心事: ${String(profile.interests).replace(/\s+/g, ' ').slice(0, 200)}`);
  if (profile.hobbies) bits.push(`趣味: ${profile.hobbies}`);
  if (bits.length === 0) return '';
  return `【リスナーについて分かっていること（話の流れから浮いた内容を見分けるための参考。`
    + `ここに書かれていない話題が出ること自体は自然ですが、文脈と無関係で唐突なものは`
    + `誤変換を疑ってください）】\n${bits.join('\n')}\n\n`;
}

/**
 * 会話の終わりに、会話全体から覚えておくべきこと（訂正・好み・生活の変化など）を LLM で取り出し、
 * learnings.json に書き足す（同じ文は足さない）。失敗しても例外を投げない（呼び出し元は待たずに呼ぶ）。
 *
 * @param {Array<{speaker: string, text: string}>} transcriptLines 会話（speaker は 'user' か 'secretary'）
 * @param {{apiKey?: string, activitySessionId?: any, listenerProfile?: any}} [opts]
 * @returns {Promise<void>}
 */
async function summarizeSessionLearnings(transcriptLines, { apiKey, activitySessionId, listenerProfile } = {}) {
  if (!apiKey || !transcriptLines || transcriptLines.length === 0) return;
  const transcriptText = transcriptLines
    .map(l => `${l.speaker === 'user' ? 'リスナー' : '秘書'}: ${l.text}`)
    .join('\n');
  if (transcriptText.length < 20) return; // 挨拶だけのようなとても短い会話は扱わない

  let _outText;
  try {
    // 取り出す種類は広め（雑談で語られた個人的な話も拾う。狭いと学ぶことが少なすぎた）。
    // BUGFIX: 確定しているプロフィール（特に名前）を、聞き間違いから新しい事実として書き換えさせない。
    // 名前を誤って覚えたことがある
    const systemInstruction = 'あなたはAI秘書の会話ログから、次回以降の会話でも覚えておくべき情報だけを抽出するアシスタントです。'
      + '抽出対象は次のいずれかに当てはまるものです:\n'
      + '・発音・呼び方の訂正\n'
      + '・リスナーの好み・習慣\n'
      + '・今後の会話で役立つ新しい事実\n'
      + '・生活状況の変化（引っ越し、転職、体調・健康に関する言及など）\n'
      + '・家族・人間関係についての言及\n'
      + '・進行中のプロジェクトや作業の状況（作りかけの作品、取り組んでいること等）\n'
      + '・会話の中で語られた具体的な出来事・エピソード\n'
      + '天気・ニュースなど外部の一時的な情報（今日の天気・株価等、その時点でしか意味を持たない'
      + '数値・状況）は対象外です。一方で、雑談の中で語られた個人的な話は、その場限りの世間話で'
      + 'あっても、リスナー自身について学べる内容であれば積極的に対象に含めてください。'
      + '該当が無ければ空配列を返してください。\n'
      + '【重要】リスナーの名前など、既にプロフィールとして確定している情報を、聞き取りミス・'
      + '言い間違い・一度きりの発言から新しい事実として書き換えないでください。名前についての'
      + '学習は、リスナー本人が明確に「名前の呼び方はこう直してほしい」等と訂正を述べた場合のみ'
      + '対象にしてください。\n'
      // BUGFIX: 材料が音声認識の書き起こしで、誤変換が多いことを伝え、話の流れから浮いた内容は捨てさせる。
      // 伝えていなかったころ、誤変換をそのまま事実として覚えていた（名前に限った対策では防げない）
      + '\n【最重要・聞き間違いの扱い】この会話ログは音声認識で文字に起こしたもので、'
      + '**誤変換が頻繁に含まれます**（実例: 「会話の方は1回の応答だけを着実に実行」が'
      + '「カイワレ大根は1回の収穫だけを確立実行」と誤認識された）。次の場合は、'
      + '**記録せずに捨ててください**:\n'
      + '・前後の話の流れから明らかに浮いている内容（技術的な相談の最中に唐突に出てくる'
      + '野菜・食べ物・地名などは、ほぼ確実に同音異義語の誤変換です）\n'
      + '・意味が通らない、または不自然に具体的すぎる断片\n'
      + '・一度しか出てこず、秘書もそれに応答していない内容\n'
      + '**迷ったら記録しない**でください。誤った記憶が残り続ける害の方が、'
      + '拾い漏らす害よりはるかに大きいためです。\n'
      + '各項目は、後から単独で読んでも意味が通る短い1文にしてください。'
      + '出力はJSON配列のみとし、説明文などは一切含めないでください。';
    // リスナー像を添えるのは、話の流れから浮いているかを判断する材料にするため
    const profileHint = _buildProfileHint(listenerProfile);
    const userPrompt = `${profileHint}以下はAI秘書とリスナーの会話ログ（音声認識による書き起こし）です。`
      + `\n\n${transcriptText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["学習内容の文1", "学習内容の文2", ...]（該当が無ければ []）';

    // 記憶の処理は軽いので 'secretary_light' ティア
    ({ text: _outText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'secretary',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] セッション要約に失敗: ${e.message}`);
    return;
  }

  const rawText = _outText;

  let facts;
  try {
    facts = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] セッション要約のJSON解析に失敗: ${e.message}`);
    return;
  }
  if (!Array.isArray(facts) || facts.length === 0) return;

  const list = readLearnings();
  const existingTexts = new Set(list.map(e => e.text));
  let id = nextIdFor(list);
  let added = 0;
  for (const f of facts) {
    const text = typeof f === 'string' ? f.trim() : '';
    if (!text || existingTexts.has(text)) continue;
    list.push({ id: id++, text, source: 'auto_summary', addedAt: new Date().toISOString() });
    existingTexts.add(text);
    added++;
  }
  if (added > 0) {
    writeLearnings(list);
    getLogger().info(`[SecretaryMemory] セッション要約から${added}件の学習内容を保存`);
  }
}

/**
 * 会話以外の材料（新着メールなど）から、覚えておくべきことを LLM で取り出して learnings.json に書き足す。
 *
 * summarizeSessionLearnings は会話からしか学ばないので、話題に出ないメールなどの情報は学ばれない。
 * これはその姉妹。音声認識の誤変換の注意は要らない代わりに、広告・通知・一度きりの用件のような
 * 学ぶ価値の無いものを覚えないように念を押す。失敗しても例外を投げない。
 *
 * @param {string} materialText 材料（新着メールの件名・差出人・本文の抜粋などをまとめた文）
 * @param {{apiKey?: string, activitySessionId?: any, listenerProfile?: object, sourceLabel?: string}} [opts]
 *   sourceLabel は学習の source に残す出どころ（例: 'auto_ambient_email'）。ログと管理画面で見分けるため
 * @returns {Promise<void>}
 */
async function summarizeAmbientLearnings(materialText, { apiKey, activitySessionId, listenerProfile, sourceLabel = 'auto_ambient' } = {}) {
  if (!apiKey || !materialText || materialText.trim().length < 20) return;

  let _outText;
  try {
    const systemInstruction = 'あなたはAI秘書として、リスナー本人が読み取りを許可しているメール等の情報から、'
      + '次回以降の会話でも覚えておくべき情報だけを抽出するアシスタントです。'
      + '抽出対象は次のいずれかに当てはまるものです:\n'
      + '・かかりつけ医・よく使う店・サービスなど、繰り返し登場する固有名詞\n'
      + '・生活状況の変化（引っ越し、転職、体調・健康に関する言及など）\n'
      + '・家族・人間関係についての言及\n'
      + '・進行中のプロジェクトや作業の状況\n'
      + '・今後の会話で役立つ新しい事実\n\n'
      + '【最重要・記録しないもの】以下は対象外です。**迷ったら記録しない**でください——'
      + '誤った記憶が残り続ける害の方が、拾い漏らす害よりはるかに大きいためです。\n'
      + '・広告・宣伝・メールマガジン・自動送信の通知（発送完了・入金確認等）で、それ自体が'
      + '恒久的な事実を示さないもの\n'
      + '・一度きりの用件で、今後も参照する価値が無いもの（日程調整の細かいやり取り等）\n'
      + '・材料から確実に読み取れない推測\n'
      + '該当が無ければ空配列を返してください。各項目は、後から単独で読んでも意味が通る'
      + '短い1文にしてください。出力はJSON配列のみとし、説明文などは一切含めないでください。';
    const profileHint = _buildProfileHint(listenerProfile);
    const userPrompt = `${profileHint}以下はリスナー本人のメール等から抽出した材料です。`
      + `\n\n${materialText}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["学習内容の文1", "学習内容の文2", ...]（該当が無ければ []）';

    // 記憶の処理は軽いので 'secretary_light' ティア
    ({ text: _outText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'secretary',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] アンビエント学習の抽出に失敗: ${e.message}`);
    return;
  }

  const rawText = _outText;

  let facts;
  try {
    facts = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] アンビエント学習結果のJSON解析に失敗: ${e.message}`);
    return;
  }
  if (!Array.isArray(facts) || facts.length === 0) return;

  const list = readLearnings();
  const existingTexts = new Set(list.map(e => e.text));
  let id = nextIdFor(list);
  let added = 0;
  for (const f of facts) {
    const text = typeof f === 'string' ? f.trim() : '';
    if (!text || existingTexts.has(text)) continue;
    list.push({ id: id++, text, source: sourceLabel, addedAt: new Date().toISOString() });
    existingTexts.add(text);
    added++;
  }
  if (added > 0) {
    writeLearnings(list);
    getLogger().info(`[SecretaryMemory] ${sourceLabel}から${added}件の学習内容を保存`);
  }
}

/**
 * 自動の学習のうち、直近 AUTO_KEEP_RECENT 件より古いものを LLM で数件にまとめる。
 *
 * 明示的なもの・圧縮済みのものは対象外。古いものが AUTO_COMPACT_BATCH_MIN 件に満たなければ何もしない。
 * まとめたものは source: 'compacted' で一覧の末尾（プロンプトに入る側）に足し、addedAt はまとめた元の
 * 一番古い日時にする（管理画面で並べたとき、元の位置に収まるように）。失敗しても例外を投げない。
 *
 * @param {{apiKey?: string, activitySessionId?: any}} [opts]
 * @returns {Promise<void>}
 */
async function compactOldAutoLearnings({ apiKey, activitySessionId } = {}) {
  if (!apiKey) return;
  const list = readLearnings();
  // BUGFIX: 'explicit' と 'compacted' 以外は、すべて自動の学習として扱う。会話からのもの（'auto_summary'）
  // だけを対象にしていたころ、メールなどからの学習が圧縮されずに増え続けた
  const autoEntries = list.filter(e => e.source !== 'explicit' && e.source !== 'compacted');
  if (autoEntries.length <= AUTO_KEEP_RECENT) return;
  const toCompact = autoEntries.slice(0, autoEntries.length - AUTO_KEEP_RECENT); // 古いもの
  if (toCompact.length < AUTO_COMPACT_BATCH_MIN) return;

  let _outText;
  const inputLines = toCompact.map(e => `- ${e.text}`).join('\n');
  const targetCount = Math.max(3, Math.ceil(toCompact.length / 4));
  try {
    const systemInstruction = 'あなたはAI秘書の学習内容（過去の会話から自動抽出された事実の一覧）を、'
      + '情報を失わないよう気をつけながら、より少ない件数へ要約・統合するアシスタントです。'
      + '重複する内容は1つにまとめ、既に無意味になった一時的な情報（当時限りの状況等）があれば'
      + '省いてよいですが、訂正・好み・継続する事実は残してください。各項目は単独で読んでも'
      + '意味が通る短い1文にしてください。出力はJSON配列のみとし、説明文などは一切含めないでください。';
    const userPrompt = `以下は古い学習内容の一覧です。内容を保ったまま、目安${targetCount}件程度へ`
      + `要約・統合してください。\n\n${inputLines}\n\n`
      + '出力形式（この配列の形のJSONのみ）: ["要約後の学習内容1", "要約後の学習内容2", ...]';

    // 記憶の処理は軽いので 'secretary_light' ティア
    ({ text: _outText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0,
      json: true,
      agentKey: 'secretary_memory_compact',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] 学習内容の圧縮に失敗: ${e.message}`);
    return;
  }

  const rawText = _outText;

  let summarized;
  try {
    summarized = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] 学習内容圧縮結果のJSON解析に失敗: ${e.message}`);
    return;
  }
  if (!Array.isArray(summarized) || summarized.length === 0) return;

  // LLM を呼んでいる間に書き込みがあったときのために、読み直してから置き換える
  const latest = readLearnings();
  const compactedIds = new Set(toCompact.map(e => e.id));
  const remaining = latest.filter(e => !compactedIds.has(e.id));
  let id = nextIdFor(remaining);
  const oldestAddedAt = toCompact[0].addedAt;
  let compactedCount = 0;
  for (const text of summarized) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) continue;
    remaining.push({ id: id++, text: t, source: 'compacted', addedAt: oldestAddedAt });
    compactedCount++;
  }
  if (compactedCount === 0) return;
  writeLearnings(remaining);
  getLogger().info(`[SecretaryMemory] 学習内容を圧縮: ${toCompact.length}件 → ${compactedCount}件`);
}

/**
 * 学習した内容を1件消す（誤って覚えた内容を管理画面から取り除くため）。
 *
 * ATTENTION: 消したらリスナー像の作り直しを促すこと（invalidateListenerDigest 参照）。
 *
 * @param {number} id 学習の ID
 * @returns {boolean} 消せたら true（その ID が無ければ false）
 */
function deleteLearning(id) {
  const list = readLearnings();
  const filtered = list.filter(e => e.id !== id);
  if (filtered.length === list.length) return false;
  writeLearnings(filtered);
  invalidateListenerDigest();
  getLogger().info(`[SecretaryMemory] 学習内容を削除: id=${id}`);
  return true;
}

/**
 * 学習した内容の文を1件書き換える（誤った内容の訂正用）。
 *
 * ATTENTION: 直したらリスナー像の作り直しを促すこと（invalidateListenerDigest 参照）。
 *
 * @param {number} id 学習の ID
 * @param {string} newText 新しい文
 * @returns {boolean} 書き換えたら true（文が空・その ID が無ければ false）
 */
function updateLearning(id, newText) {
  const text = (newText || '').trim();
  if (!text) return false;
  const list = readLearnings();
  const entry = list.find(e => e.id === id);
  if (!entry) return false;
  entry.text = text;
  writeLearnings(list);
  invalidateListenerDigest();
  getLogger().info(`[SecretaryMemory] 学習内容を編集: id=${id}`);
  return true;
}

/**
 * 秘書の system instruction に入れる、学習した内容の文を作る。
 *
 * 明示的なものは全部、自動のもの（圧縮したものを含む）は直近 MAX_INJECTED 件だけ入れる。
 * BUGFIX: 明示的なものは別枠で全部入れる。全部を合わせてから直近の件数に切っていたころ、自動の学習が
 * 多いと、明示的に覚えさせたものまで入らなくなっていた。
 *
 * @returns {string} プロンプトに入れる文（学習が無ければ空文字）
 */
function formatLearningsForPrompt() {
  const list = readLearnings();
  if (list.length === 0) return '';
  const explicit = list.filter(e => e.source === 'explicit');
  const others = list.filter(e => e.source !== 'explicit').slice(-MAX_INJECTED);
  const combined = [...explicit, ...others];
  if (combined.length === 0) return '';
  const lines = combined.map(e => `- ${e.text}`);
  return `\n\n【これまでの会話で学習した内容】これらは過去の会話から学んだ事実です。矛盾する新しい情報を`
    + `会話中に得た場合は、そちらを優先してください。\n${lines.join('\n')}`;
}

// ─────────────────────────────────────────────
// 全エージェント向けのリスナー像（digest.json）
//
// 学習の一覧をそのまま全コーナーのプロンプトに入れると、役割と関係の無い長い一覧が割り込み、
// トークンも増える。そこで学習とは別に、短くまとめたリスナー像（数文）を1つ作り、それを全エージェント
// （Live の各コーナー・音楽チャンネル・The Answers・consult_agent など）が読む。
// 作り直すのは、前回の材料（sourceMaxId）より学習の最大の ID が進んだときだけ（変化が無ければ LLM を呼ばない）。
// ─────────────────────────────────────────────

/**
 * リスナー像を読む。
 * @returns {Record<string, any>|null} text・sourceMaxId・generatedAt・manualCore・manuallyEdited（無ければ null）
 */
function readDigest() {
  return jsonFileStore.readJsonFile(DIGEST_PATH, null, '[SecretaryMemory]');
}

/**
 * リスナー像を書く。
 * @param {Record<string, any>} digest リスナー像
 * @returns {void}
 */
function writeDigest(digest) {
  jsonFileStore.writeJsonFile(DIGEST_PATH, digest, '[SecretaryMemory]');
}

/**
 * リスナー像を「作り直しが要る」状態にする（次の summarizeListenerDigest で必ず作り直される）。
 *
 * BUGFIX: 学習を消した・直したときは必ずこれを呼ぶこと。作り直すかは学習の最大の ID が進んだかだけで
 * 決めているため、消しても直しても ID は進まず、取り除いたはずの誤りが次に学習が増えるまで
 * リスナー像に残り続ける（リスナー像は全チャンネルが読むので、誤りが放送に乗る）。
 *
 * @returns {void}
 */
function invalidateListenerDigest() {
  const cached = readDigest();
  if (!cached) return;
  writeDigest({ ...cached, sourceMaxId: null });
}

/**
 * YouTube の登録チャンネルから推し量った興味の傾向を読む。
 * @returns {Record<string, any>|null} text・channelCount・generatedAt（無ければ null）
 */
function readYoutubeInterestDigest() {
  return jsonFileStore.readJsonFile(YOUTUBE_INTEREST_DIGEST_PATH, null, '[SecretaryMemory]');
}

/**
 * YouTube の登録チャンネルから推し量った興味の傾向を書く。
 * @param {Record<string, any>} digest 興味の傾向
 * @returns {void}
 */
function writeYoutubeInterestDigest(digest) {
  jsonFileStore.writeJsonFile(YOUTUBE_INTEREST_DIGEST_PATH, digest, '[SecretaryMemory]');
}

/**
 * YouTube の登録チャンネルの名前の一覧から、興味の傾向を LLM に推し量らせ、youtube_interest_digest.json に
 * 保存する（視聴の履歴は API で取れないため、登録チャンネルで代わりにする）。
 *
 * チャンネル名を1件ずつ学習（learnings.json）に足すことはしない。名前の並びは、いくつも合わせて初めて
 * 興味の傾向として意味を持つため。利用元は youtube-interest-learning.js。失敗しても例外を投げない。
 *
 * @param {string[]} channelTitles 登録チャンネルの名前の一覧（全部）
 * @param {{apiKey?: string, activitySessionId?: any}} [opts]
 * @returns {Promise<void>}
 */
async function summarizeYoutubeInterests(channelTitles, { apiKey, activitySessionId } = {}) {
  if (!apiKey || !channelTitles || channelTitles.length === 0) return;

  let _outText;
  try {
    const systemInstruction = 'あなたはAI秘書として、リスナー本人がYouTubeでチャンネル登録している'
      + 'チャンネルの名前一覧から、興味・関心の傾向を推測する役割です。個々のチャンネル名を'
      + '1つずつ覚えるのではなく、複数のチャンネルに共通するジャンル・テーマ・関心領域を'
      + '読み取り、今後の会話でも参考になる「興味の傾向」として2〜4文の自然な日本語で'
      + 'まとめてください。\n'
      + '・複数のチャンネルから共通して読み取れる、明確な関心領域だけを対象にしてください\n'
      + '・チャンネル名だけからは判断できない曖昧な推測はしないでください。迷ったら書かないで'
      + 'ください\n'
      + '・特定できる傾向が無ければ「特に明確な傾向は読み取れません」とだけ書いてください\n'
      + '出力は要約文のみとし、前置き・見出し・箇条書き記号は一切含めないでください。';
    const userPrompt = `以下はリスナー本人が登録しているYouTubeチャンネルの名前一覧です`
      + `（${channelTitles.length}件）。\n\n${channelTitles.join('\n')}\n\n`
      + '上記から読み取れる興味・関心の傾向をまとめてください。';

    // 記憶の処理は軽いので 'secretary_light' ティア
    ({ text: _outText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0.3,
      agentKey: 'secretary',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] YouTube興味傾向の要約に失敗: ${e.message}`);
    return;
  }

  const text = _outText.trim();
  if (!text) return;

  writeYoutubeInterestDigest({
    text, channelCount: channelTitles.length, generatedAt: new Date().toISOString(),
  });
  getLogger().info(`[SecretaryMemory] YouTube興味傾向ダイジェストを更新（${channelTitles.length}チャンネルから）`);
}

/**
 * 学習の今の最大の ID を返す（前回リスナー像を作ってから学習が増えたかを、安く判定するため）。
 * @returns {number} 最大の ID（学習が無ければ 0）
 */
function _currentMaxLearningId() {
  const list = readLearnings();
  return list.reduce((max, e) => Math.max(max, e.id || 0), 0);
}

/**
 * 学習した内容を、全エージェント向けの短いリスナー像にまとめて digest.json に保存する。
 *
 * 前回から学習が増えていなければ何もしない（会話が終わるたびに呼ばれるため）。管理画面で手で直した内容
 * （manualCore）があれば、それは一字一句そのまま残し、LLM にはそこに無い新しい事実だけを書かせて後ろに
 * つなぐ。失敗しても例外を投げない。
 *
 * @param {{apiKey?: string, activitySessionId?: any}} [opts]
 * @returns {Promise<void>}
 */
async function summarizeListenerDigest({ apiKey, activitySessionId } = {}) {
  if (!apiKey) return;
  const list = readLearnings();
  if (list.length === 0) return;
  const currentMaxId = _currentMaxLearningId();
  const cached = readDigest();
  if (cached && cached.sourceMaxId === currentMaxId) return; // 前回生成時から変化なし

  // 管理画面で手で直した内容は、AI に黙って上書きさせない。
  // BUGFIX: ただし作り直しは止めず、手で直した内容（manualCore）を確定の情報として残したまま作り直す。
  // 手で直したら作り直しをやめていたころ、一度直すとリスナー像が凍り、その後の学習が放送に届かなかった。
  // 学習と食い違えば manualCore を正とするので、直した誤りは戻らない。
  // （manualCore の無い古いデータは、手で直してあれば text をそのまま核にする）
  const manualCore = cached?.manualCore
    || (cached?.manuallyEdited ? cached.text : '') || '';

  let _outText;
  const inputLines = list.map(e => `- ${e.text}`).join('\n');
  try {
    const systemInstruction = 'あなたはAI秘書が過去の会話から学んだリスナーに関する断片的な情報を、'
      + 'ラジオ番組の他のエージェント（天気・ニュース・音楽DJ・コメンテーター等）が一目で'
      + 'リスナー像を把握できるよう、簡潔な人物紹介文へまとめるアシスタントです。'
      + '3〜5文程度の自然な日本語の文章にまとめてください（箇条書きではなく、まとまった文章）。'
      + '個々の学習内容を全て網羅する必要はなく、継続的に成り立つ好み・関心事・人物像を'
      + '優先してください（一時的な状況・その場限りの発言は省いてよい）。'
      + '事実として書かれていないことを推測で付け加えないでください。'
      + '出力は要約文のみとし、前置き・見出し・箇条書き記号は一切含めないでください。'
      ;
    // 手で直した内容があるときに使う指示。
    // BUGFIX: 確定の情報を LLM に書き直させない。確定の情報を土台に全体を書き直させたら、「数文で」の指示と
    // ぶつかって確定の情報の方が削られ、新しい事実も入らなかった。確定の情報はコードでそのまま残し、
    // LLM にはそこに無い新しい事実だけを書かせてつなぐ
    const systemInstructionAppend = 'あなたはAI秘書が会話から学んだリスナーの情報のうち、'
      + '**すでに分かっていること（確定情報）に含まれていない新しい事実だけ**を抜き出して、'
      + 'ラジオ番組の他のエージェントへ伝える短い文章にまとめるアシスタントです。\n'
      + '- 確定情報に既に書かれている内容は、言い換えであっても**絶対に再掲しないでください**。\n'
      + '- 確定情報と食い違う学習内容は、**確定情報が正しい**ものとして扱い、採用しないでください。\n'
      + '- 継続的に成り立つ好み・関心事・契約や利用中のサービス・保有資産などを優先し、'
      + 'その場限りの状況は省いてください。\n'
      + '- 2〜4文の自然な日本語の文章にまとめてください（箇条書きにしないこと）。\n'
      + '- 書くに値する新しい事実が無ければ、何も出力せず空文字を返してください。\n'
      + '- 出力は本文のみとし、前置き・見出し・箇条書き記号は一切含めないでください。';
    const userPromptAppend = `【確定情報（すでに分かっていること）】\n${manualCore}\n\n`
      + `【AI秘書がこれまでの会話から学んだ情報の一覧】\n${inputLines}\n\n`
      + '確定情報に含まれていない新しい事実だけを、短い文章にまとめて出力してください。';
    const userPrompt = `以下はAI秘書がこれまでの会話から学んだリスナーに関する情報の一覧です。\n\n${inputLines}\n\n`
      + '上記を踏まえた、リスナー像の簡潔な要約文のみを出力してください。';

    // 記憶の処理は軽いので 'secretary_light' ティア
    ({ text: _outText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: manualCore ? systemInstructionAppend : systemInstruction,
      prompt: manualCore ? userPromptAppend : userPrompt,
      temperature: 0.2,
      agentKey: 'secretary_memory_digest',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[SecretaryMemory] リスナー情報ダイジェストの生成に失敗: ${e.message}`);
    return;
  }

  const _generated = (_outText || '').trim();
  // 確定の情報はそのまま残し、LLM の出力は書き足しとして後ろにつなぐだけ（手で直した内容が削られない）
  const text = manualCore
    ? (_generated ? `${manualCore}\n${_generated}` : manualCore)
    : _generated;
  if (!text) return;

  // manualCore は持ち越す（次に作り直すときも確定の情報として使うため）
  writeDigest({
    text, sourceMaxId: currentMaxId, generatedAt: new Date().toISOString(),
    ...(manualCore ? { manualCore, manuallyEdited: true } : {}),
  });
  getLogger().info(`[SecretaryMemory] リスナー情報ダイジェストを更新（学習内容${list.length}件から要約`
    + `${manualCore ? `・手動修正${manualCore.length}字を確定情報として保持` : ''}）`);
}

/**
 * 全エージェントのプロンプトに入れる形で、保存してあるリスナー像を返す（YouTube の興味の傾向も添える）。
 * ファイルを読むだけなので、コーナーを作るたびに呼んでも軽い。
 * @returns {string} プロンプトに入れる文（まだ無ければ空文字）
 */
function getListenerDigestForPrompt() {
  const digest = readDigest();
  const ytDigest = readYoutubeInterestDigest();
  const blocks = [];
  if (digest?.text) blocks.push(digest.text);
  // YouTube の興味の傾向もここに合わせる（ここを読むすべての所に届く）
  if (ytDigest?.text) blocks.push(`（YouTube登録チャンネルの傾向）${ytDigest.text}`);
  if (blocks.length === 0) return '';
  return `\n\n【AI秘書がこれまでに把握しているリスナー像】${blocks.join('\n')}`;
}

/**
 * 管理画面から、リスナー像を手で直す。
 *
 * 直した内容は manualCore として別に持ち、以後の作り直し（summarizeListenerDigest）で確定の情報として
 * 使う。直した内容が AI に黙って上書きされないようにするため。
 *
 * @param {string} text 直したリスナー像
 * @returns {Record<string, any>|null} 保存したリスナー像（空なら null）
 */
function updateDigestManually(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const cached = readDigest();
  const digest = {
    text: trimmed,
    // 手で直した内容を別に持つ。text は作り直しで変わっていくが、manualCore は次に手で直すまで変わらない
    manualCore: trimmed,
    // ATTENTION: 今の最大の ID には合わせない。合わせると「変化なし」と判定され、次の作り直しが飛ばされる
    sourceMaxId: cached?.sourceMaxId ?? 0,
    generatedAt: new Date().toISOString(),
    manuallyEdited: true,
  };
  writeDigest(digest);
  getLogger().info('[SecretaryMemory] リスナー情報ダイジェストを手動編集');
  return digest;
}

/**
 * 資産の構成比（%）とファンド名の一覧（金額は無し）だけを、finance_public_summary.json に保存する
 * （Live などほかのチャンネルと共有するため）。
 *
 * 秘書だけが使う資産の全データとは別のファイルにする。このファイルを見れば、ほかへ渡してよい範囲が
 * 一目で分かる。利用元は secretary-tools-finance.js。
 *
 * @param {Record<string, any>|null} compositionSummary 構成比のまとめ。無ければ何も書かない
 * @returns {void}
 */
function writeFinancePublicSummary(compositionSummary) {
  if (!compositionSummary) return;
  jsonFileStore.writeJsonFile(FINANCE_PUBLIC_SUMMARY_PATH, compositionSummary, '[SecretaryMemory]');
}

/**
 * 共有用の資産のまとめを読む（管理画面での閲覧用）。
 * @returns {Record<string, any>|null} まとめ（まだ無ければ null）
 */
function readFinancePublicSummary() {
  return jsonFileStore.readJsonFile(FINANCE_PUBLIC_SUMMARY_PATH, null, '[SecretaryMemory]');
}

module.exports = {
  rememberExplicit, summarizeSessionLearnings, summarizeAmbientLearnings, compactOldAutoLearnings, formatLearningsForPrompt,
  readLearnings, deleteLearning, updateLearning,
  summarizeListenerDigest, getListenerDigestForPrompt, readDigest, updateDigestManually,
  writeFinancePublicSummary, readFinancePublicSummary,
  summarizeYoutubeInterests, readYoutubeInterestDigest,
};
