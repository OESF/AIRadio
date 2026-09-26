/**
 * @file エージェントの日記の週1回のふり返り（自己ダイジェスト・ディレクターのまとめ・見立ての答え合わせ）
 *
 * エージェントの日記（agent-diary.js）を、書きっぱなしにせず次の放送へ生かすための週次の処理。
 * 日曜4:30を過ぎたら1回だけ（server.js の5分ごとの tick から maybeRunWeeklyDiaryFeedback）、
 * 次をまとめて行う。手動の実行口は routes/agent-diary-feedback-routes.js。
 *
 * 1. 見立ての答え合わせ（checkDuePredictions）: 期日が来た見立てを Google 検索で確かめ、当たり外れを
 *    本人の日記へ書き込む（その後の要約と日記の横断検索に自然に乗る）。
 * 2. 自己ダイジェスト（summarizeAgentSelfDigest）: エージェント自身の直近1週間の日記から、仕事の
 *    進め方の繰り返しの気づきと、専門家として蓄えたことをまとめ、digest.json に保存する。
 * 3. チームのまとめ（summarizeDirectorTeamDigest）: 各チャンネルのディレクターが、配下の出演者全員の
 *    日記から編成の気づきをまとめ、team_digest.json に保存する。
 * 4. Secretary の所感（addSecretaryFeedbackToTeamDigest）: 3 のまとめに、リスナー本人をよく知る
 *    秘書の立場からの所感を追記する。
 *
 * 保存先は server/data/agent-diary/<channel>/<agentKey>/ の digest.json・team_digest.json。読み出しは
 * agent-shared-mixin.js の _getAgentDiarySelfDigest・_getAgentDiaryTeamDigest。最後に実行した日は
 * server/data/agent-diary-feedback-state.json。
 *
 * ATTENTION: まとめはプロンプトへ一時的に足す材料としてだけ使い、config.agents.*.prompt（キャラクター
 * 設定そのもの）は決して書き換えない。反省のたびに性格が変わると、キャラクターがぶれるため。
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
const { generateText } = require('./llm-client');
const { getLogger } = require('../logger');
const jsonFileStore = require('./json-file-store');
const agentDiary = require('./agent-diary');
const agentPredictions = require('./agent-predictions');
const secretaryMemory = require('./secretary-memory');

const STATE_PATH = path.join(__dirname, '..', 'data', 'agent-diary-feedback-state.json');
const WINDOW_DAYS = 7; // 直近何日分の日記を材料にするか
// 使うモデルは llm-models.js のティア表で決める。日記の要約は light（軽い作文）、見立ての答え合わせは
// research（Google 検索で裏を取って判定するため）。

/**
 * 対象のチャンネルと、そのディレクターの agentKey（24You はナレーションのエージェントが無いので対象外）。
 * エージェントの一覧は直書きせず、実際に日記を書いたことがあるエージェント
 * （server/data/agent-diary/<channel>/ の下のフォルダー）から得る。
 */
const CHANNELS = [
  { channel: 'live',        directorAgentKey: 'director' },
  { channel: 'classic',     directorAgentKey: 'classic_director' },
  { channel: 'jazz',        directorAgentKey: 'jazz_director' },
  { channel: 'mood',        directorAgentKey: 'mood_director' },
  { channel: 'beatles',     directorAgentKey: 'beatles_director' },
  { channel: 'the_answers', directorAgentKey: 'director' },
  // BUGFIX: Secretary も対象にする。Secretary は日記を書いていたのに一覧に無く、誰も読み返さない
  // 状態だった。配下の出演者もディレクターもいないので、directorAgentKey は null
  // （チームのまとめは作らない）。
  { channel: 'secretary',   directorAgentKey: null },
];

// 週次の処理を始める時刻（日曜4:30）。Obsidian のウィークリーレポート（日曜23:50）と時間をずらし、
// LLM の一括処理が重ならないようにする。
const RUN_TRIGGER_HOUR = 4;
const RUN_TRIGGER_MINUTE = 30;

/**
 * 開始の時刻（4:30）を過ぎているか。
 *
 * @param {Date} now 今の時刻
 * @returns {boolean} 過ぎていれば true
 */
function _isPastTriggerTime(now) {
  return now.getHours() > RUN_TRIGGER_HOUR
    || (now.getHours() === RUN_TRIGGER_HOUR && now.getMinutes() >= RUN_TRIGGER_MINUTE);
}

/**
 * ローカル時刻の日付を YYYY-MM-DD にする。
 *
 * @param {Date} [d] 時刻（既定は今）
 * @returns {string} YYYY-MM-DD
 */
function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 最後に実行した日を読む。
 *
 * @returns {Record<string, any>} { lastRunDate }
 */
function readState() {
  return jsonFileStore.readJsonFile(STATE_PATH, { lastRunDate: null }, '[AgentDiaryFeedback]');
}

/**
 * 最後に実行した日を書き込む。
 *
 * @param {Record<string, any>} state { lastRunDate }
 * @returns {void}
 */
function writeState(state) {
  jsonFileStore.writeJsonFile(STATE_PATH, state, '[AgentDiaryFeedback]');
}

/**
 * エージェントの日記フォルダーの中のファイルのパスを返す。
 *
 * @param {string} channel チャンネル
 * @param {string} agentKey エージェントのキー
 * @param {string} filename ファイル名（digest.json・team_digest.json）
 * @returns {string} 絶対パス
 */
function _digestFilePath(channel, agentKey, filename) {
  return path.join(agentDiary.DIARY_DIR, channel, agentKey, filename);
}

/**
 * まとめの文章を LLM（light ティア）に書かせる共通の処理。失敗しても例外は投げず null を返す。
 *
 * @param {Record<string, any>} opts systemInstruction・userPrompt・apiKey・activitySessionId・
 *   agentKey・kind（活動記録の種類）・channel
 * @returns {Promise<string|null>} 書かれた文章（失敗・空なら null）
 */
async function _callGemini({ systemInstruction, userPrompt, apiKey, activitySessionId, agentKey, kind, channel }) {
  try {
    const { text } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt: userPrompt,
      temperature: 0.3,
      agentKey,
      activitySessionId,
      logMeta: { kind, channel },
    });
    return text.trim() || null;
  } catch (e) {
    getLogger().warn(`[AgentDiaryFeedback] ${channel}/${agentKey} (${kind}) 生成に失敗: ${e.message}`);
    return null;
  }
}

/**
 * エージェント自身の直近1週間の日記をまとめ、digest.json に保存する（自己ダイジェスト）。
 * 直近1週間に日記が1件も無ければ何もしない（LLM を呼ばない）。
 *
 * @param {Record<string, any>} opts channel・agentKey・agentName・apiKey・activitySessionId
 * @returns {Promise<void>}
 */
async function summarizeAgentSelfDigest({ channel, agentKey, agentName, apiKey, activitySessionId }) {
  if (!apiKey) return;
  const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const entries = agentDiary.listDiaryEntries({ channel, agentKey, limit: 200 })
    .filter(e => new Date(e.time).getTime() >= cutoffMs);
  if (entries.length === 0) return;

  const inputLines = entries.slice().reverse().map(e => `- ${e.text}`).join('\n'); // 古い順に並べ替え
  // BUGFIX: 仕事の進め方（繰り返しの気づき）と、専門家として蓄えたこと（知った事実・見立て・
  // リスナーの関心）の2つの軸に分けて残す。以前は「繰り返し現れる自己批評」だけを残し、1回だけの
  // ものは捨てていたので、プロンプトへ戻るのが話し方の反省だけになっていた。
  // 「1回しか出てこないものは無視」は、自己批評の軸にだけ当てはめる（リスナーの関心や自分の
  // 見立ては、1回きりでも次に効くため）。
  const systemInstruction = `あなたは「${agentName}」自身が書いた、この1週間分の非公開の日記（一人称の振り返り）を`
    + 'まとめて読む役割です。次の2つに分けて、あわせて4〜6文の自然な日本語にまとめてください。\n'
    + '① 仕事の進め方について: 同じような反省・気づき・課題が繰り返し書かれていないか探し、'
    + '繰り返し現れているものだけを書いてください。1回しか出てこない感想は無視して構いません。'
    + '繰り返しの傾向が無ければこの軸は省略してください。\n'
    + '② 専門家として蓄えたことについて: この期間に知った事実・数字、自分が述べた見立てや判断、'
    + 'リスナーが何を気にしていたか。**これらは1回しか出てこなくても、次に活きるものは'
    + '残してください。** 特に、リスナーから直接受けた相談で分かったこと（何を気にされていたか、'
    + '次はどう答えたいと思ったか）は優先して残してください。\n'
    + 'どちらの軸にも書くことが無い場合のみ「特に繰り返しの傾向は見られません」とだけ書いてください。'
    + '出力は要約文のみとし、前置き・見出し・番号・箇条書き記号は一切含めないでください'
    + '（そのまま自分への申し送りとして読める、地の文にしてください）。';
  const userPrompt = `以下は「${agentName}」がこの1週間に書いた日記です（古い順）。\n\n${inputLines}\n\n`
    + '上記から、①仕事の進め方についての繰り返しの気づきと、②専門家として蓄えた事実・見立て・'
    + 'リスナーの関心を、あわせて要約してください。';

  const text = await _callGemini({
    systemInstruction, userPrompt, apiKey, activitySessionId,
    agentKey, kind: 'agent_diary_self_digest', channel,
  });
  if (!text) return;

  jsonFileStore.writeJsonFile(_digestFilePath(channel, agentKey, 'digest.json'), {
    text,
    sourceEntryCount: entries.length,
    sourceLatestTime: entries[0]?.time || null,
    generatedAt: new Date().toISOString(),
  }, '[AgentDiaryFeedback]');
  getLogger().info(`[AgentDiaryFeedback] ${channel}/${agentKey} 自己ダイジェストを更新（${entries.length}件の日記から）`);
}

/**
 * ディレクターに、配下の出演者全員（ディレクター自身を除く）の直近1週間の日記を読ませ、
 * 編成の気づきを team_digest.json に保存する（チームのまとめ）。
 *
 * @param {Record<string, any>} opts channel・directorAgentKey・directorAgentName・apiKey・activitySessionId
 * @returns {Promise<string|undefined>} 保存したまとめの文（対象の日記が無い・失敗したときは undefined）
 */
async function summarizeDirectorTeamDigest({ channel, directorAgentKey, directorAgentName, apiKey, activitySessionId }) {
  if (!apiKey) return;
  const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const entries = agentDiary.listDiaryEntries({ channel, limit: 500 })
    .filter(e => e.agentKey !== directorAgentKey && new Date(e.time).getTime() >= cutoffMs);
  if (entries.length === 0) return;

  // 出演者ごとにまとめる（古い順）
  const byAgent = new Map();
  for (const e of entries.slice().reverse()) {
    if (!byAgent.has(e.agentName)) byAgent.set(e.agentName, []);
    byAgent.get(e.agentName).push(e.text);
  }
  const inputLines = [...byAgent.entries()]
    .map(([name, texts]) => `【${name}】\n${texts.map(t => `- ${t}`).join('\n')}`)
    .join('\n\n');

  const systemInstruction = `あなたは番組のディレクター「${directorAgentName}」です。出演者たちがこの1週間に書いた`
    + '非公開の日記をまとめて読む役割です。番組運営者の視点から、今後の編成の参考になりそうな'
    + '気づきを2〜3文の自然な日本語でまとめてください。特定の1人だけの感想ではなく、複数人に'
    + '共通する傾向や、特に印象的だった出演者の声を優先してください。参考になる気づきが'
    + '見当たらない場合は「特に編成に反映すべき気づきは見られません」とだけ書いてください。'
    + '出力は要約文のみとし、前置き・見出し・箇条書き記号は一切含めないでください。';
  const userPrompt = `以下は出演者ごとの、この1週間分の日記です。\n\n${inputLines}\n\n`
    + '上記から、番組編成の参考になる気づきの要約のみを出力してください。';

  const text = await _callGemini({
    systemInstruction, userPrompt, apiKey, activitySessionId,
    agentKey: directorAgentKey, kind: 'agent_diary_team_digest', channel,
  });
  if (!text) return;

  jsonFileStore.writeJsonFile(_digestFilePath(channel, directorAgentKey, 'team_digest.json'), {
    text,
    sourceEntryCount: entries.length,
    sourceLatestTime: entries[0]?.time || null,
    generatedAt: new Date().toISOString(),
  }, '[AgentDiaryFeedback]');
  getLogger().info(`[AgentDiaryFeedback] ${channel}/${directorAgentKey} チームダイジェストを更新（${entries.length}件の日記から）`);
  return text;
}

/**
 * ディレクターのまとめ（team_digest）に、Secretary の所感を追記する。
 *
 * 出演者の日記 → ディレクターのまとめ → Secretary の所感 → ディレクターの次の編成、という
 * ループの最後の段。新しい注入の経路は作らず、team_digest.json の text の末尾へ足すだけにする。
 * 各ディレクターの編成のプロンプトはすでに team_digest の text を丸ごと読んでいる
 * （agent-shared-mixin.js の _getAgentDiaryTeamDigest）ので、全チャンネルに自然に反映される。
 *
 * ATTENTION: summarizeDirectorTeamDigest がその週に実際にまとめを作ったときだけ呼ぶこと。
 * 対象の日記が無かった週に古いまとめへ追記すると、今週見ていない内容への所感が積み重なる。
 *
 * ATTENTION: プロンプトに出すリスナーの呼び方は、必ず設定から引くこと。管理画面で変えられる。
 *
 * @param {Record<string, any>} opts config・channel・directorAgentKey・teamDigestText（今週のまとめ）・
 *   apiKey・activitySessionId
 * @returns {Promise<void>}
 */
async function addSecretaryFeedbackToTeamDigest({ config, channel, directorAgentKey, teamDigestText, apiKey, activitySessionId }) {
  if (!apiKey || !teamDigestText) return;
  const secretaryName = config?.agents?.secretary?.name || 'コナミ';
  // 呼び方は「呼び方」→ 名前 の順に引く。末尾の「さん」は、下で一律に付けるので取り除く
  // （他の呼び出し箇所と同じ扱い）。
  const _profile = config?.show?.user_profile || {};
  const listenerName = String(_profile.short_name || _profile.name || 'リスナー').replace(/さん$/, '');
  const listenerDigest = secretaryMemory.getListenerDigestForPrompt();

  const systemInstruction = `あなたは「${secretaryName}」です。${listenerName}さんの秘書として、普段から本人と`
    + '最も長く対話している立場です。以下は番組のディレクターが、出演者たちの直近1週間の'
    + '日記をまとめて出した「編成上の気づき」です。\n\n'
    + `【ディレクターの気づき】${teamDigestText}\n`
    + `${listenerDigest}\n\n`
    + `これを読んで、${listenerName}さん本人ならどう感じるかという視点から、率直な所感を2〜3文で`
    + '述べてください。あなたがこれまでの会話から把握しているリスナー本人の好み・関心と'
    + '照らして、ディレクターの気づきが的を射ていそうか、ズレていそうか、具体的に評価して'
    + 'ください。特に指摘することが無ければ「ディレクターの気づきは概ね妥当と思われます」'
    + 'とだけ書いてください。出力は所感の本文のみとし、前置き・見出しは不要です。';

  const text = await _callGemini({
    systemInstruction, userPrompt: '上記を踏まえ、所感を出力してください。',
    apiKey, activitySessionId, agentKey: 'secretary', kind: 'director_team_digest_secretary_feedback', channel,
  });
  if (!text) return;

  const filePath = _digestFilePath(channel, directorAgentKey, 'team_digest.json');
  const existing = jsonFileStore.readJsonFile(filePath, null, '[AgentDiaryFeedback]');
  if (!existing?.text) return;
  existing.text = `${existing.text}\n\n【${secretaryName}（Secretary）からの所感・リスナー本人視点】${text}`;
  jsonFileStore.writeJsonFile(filePath, existing, '[AgentDiaryFeedback]');
  getLogger().info(`[AgentDiaryFeedback] ${channel}/${directorAgentKey} のチームダイジェストへ${secretaryName}の所感を追加`);
}

/**
 * 答え合わせの期日が来た見立てについて、Google 検索で裏を取りながら LLM に当たり外れを判定させ、
 * 結果をそのエージェントの日記へ新しい1件として書き込む。
 *
 * 日記へ書くだけで、自己ダイジェスト・チームのまとめ・日記の横断検索（agent-diary.js の
 * searchDiaryEntries）にそのまま乗るので、コーナーのプロンプトへの新しい経路は要らない。
 * 判定に失敗した見立ては済みにしないので、次の回にやり直す。
 *
 * @param {{apiKey: string, activitySessionId?: any}} opts API キーと活動記録のセッション ID
 * @returns {Promise<void>}
 */
async function checkDuePredictions({ apiKey, activitySessionId }) {
  if (!apiKey) return;
  const due = agentPredictions.getDuePredictions();
  if (due.length === 0) return;

  for (const p of due) {
    const daysAgo = Math.round((Date.now() - new Date(p.madeAt).getTime()) / 86400000);
    const systemInstruction = `あなたは「${p.agentName}」です。${daysAgo}日前に次のような見立てを述べました。\n\n`
      + `【見立て】${p.claim}\n\n`
      + 'この見立てが実際に当たったか、Google検索で最新の情報を調べて確認してください。'
      + '調査結果をもとに、次のJSON形式のみを出力してください（他の文章・前置きは一切不要です）。\n'
      + '{"verdict":"hit"または"miss"または"partial"または"unclear","note":"実際どうだったかを1〜2文で"}\n'
      + '"hit"=見立て通りだった／"miss"=見立てと反対の結果だった／"partial"=一部当たり一部外れ／'
      + '"unclear"=検索しても実際どうだったか判断できない場合。分からない場合に無理にhit/missを'
      + '選ばず、正直に"unclear"を選んでください。';

    let text;
    try {
      // 検索を伴う調査なので research ティア（grounded: true で Google 検索を使う）
      ({ text } = await generateText({
        tier: 'research',
        apiKey,
        systemInstruction,
        prompt: '上記の見立てについて調べて、指定のJSON形式で結果のみを教えてください。',
        grounded: true,
        agentKey: `prediction_check_${p.agentKey}`,
        activitySessionId,
      }));
    } catch (e) {
      getLogger().warn(`[AgentDiaryFeedback] 見立ての答え合わせに失敗（${p.channel}/${p.agentKey}、次回に再試行）: ${e.message}`);
      continue; // checkedにしないので次回のtickで再試行される
    }

    let verdict = null;
    let note = '';
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      verdict = obj.verdict || null;
      note = obj.note || '';
    } catch (e) {
      getLogger().warn(`[AgentDiaryFeedback] 見立ての答え合わせ結果の解析に失敗（${p.channel}/${p.agentKey}）: ${text.slice(0, 200)}`);
      continue;
    }
    if (!verdict) continue;

    agentPredictions.markChecked(p.id, { verdict, verdictNote: note });

    const verdictLabel = { hit: '当たりました', miss: '外れました', partial: '一部当たりました', unclear: '実際どうだったか確認できませんでした' }[verdict] || verdict;
    const diaryText = `${daysAgo}日前、「${p.claim}」と申し上げましたが、実際には${verdictLabel}。${note}`;
    agentDiary.appendDiaryEntry({
      channel: p.channel, agentKey: p.agentKey, agentName: p.agentName,
      corner: 'prediction_check', text: diaryText,
    });
    getLogger().info(`[AgentDiaryFeedback] ${p.channel}/${p.agentKey} の見立てを答え合わせしました（${verdict}）: ${p.claim}`);
  }
}

/**
 * 全チャンネル・全エージェントについて、見立ての答え合わせ・自己ダイジェスト・チームのまとめ・
 * Secretary の所感を実行する（日付の判定はしない本体）。手動の実行口
 * （routes/agent-diary-feedback-routes.js）からも直接呼ばれる。
 *
 * @param {{config?: Record<string, any>|null, apiKey?: string, activitySessionId?: any}} [opts]
 *   設定全体・API キー・活動記録のセッション ID
 * @returns {Promise<{ran: boolean, reason?: string, processed?: Array<Record<string, any>>}>}
 *   実行したか（API キーが無ければ ran: false）と、処理したエージェント
 */
async function runFeedbackForAllChannels({ config = null, apiKey, activitySessionId = null } = {}) {
  if (!apiKey) return { ran: false, reason: 'no_api_key' };

  await checkDuePredictions({ apiKey, activitySessionId }).catch((e) => {
    getLogger().warn(`[AgentDiaryFeedback] 見立ての答え合わせ処理全体に失敗: ${e.message}`);
  });

  const results = [];
  for (const { channel, directorAgentKey } of CHANNELS) {
    const channelDir = path.join(agentDiary.DIARY_DIR, channel);
    if (!fs.existsSync(channelDir)) continue;
    const agentKeys = fs.readdirSync(channelDir).filter(f => {
      try { return fs.statSync(path.join(channelDir, f)).isDirectory(); } catch { return false; }
    });

    for (const agentKey of agentKeys) {
      const latest = agentDiary.listDiaryEntries({ channel, agentKey, limit: 1 })[0];
      const agentName = latest?.agentName || agentKey;
      await summarizeAgentSelfDigest({ channel, agentKey, agentName, apiKey, activitySessionId }).catch(() => {});
      results.push({ channel, agentKey, type: 'self' });
    }

    // directorAgentKeyがnullのチャンネル（secretary）はチームダイジェストを作らない
    if (directorAgentKey && agentKeys.includes(directorAgentKey)) {
      const latestDirector = agentDiary.listDiaryEntries({ channel, agentKey: directorAgentKey, limit: 1 })[0];
      const directorAgentName = latestDirector?.agentName || directorAgentKey;
      const teamDigestText = await summarizeDirectorTeamDigest({ channel, directorAgentKey, directorAgentName, apiKey, activitySessionId }).catch(() => null);
      results.push({ channel, agentKey: directorAgentKey, type: 'team' });
      // まとめを作らなかった週は所感を追記しない（addSecretaryFeedbackToTeamDigest 参照）
      if (teamDigestText) {
        await addSecretaryFeedbackToTeamDigest({ config, channel, directorAgentKey, teamDigestText, apiKey, activitySessionId }).catch((e) => {
          getLogger().warn(`[AgentDiaryFeedback] ${channel}/${directorAgentKey} のSecretary所感追加に失敗: ${e.message}`);
        });
      }
    }
  }
  return { ran: true, processed: results };
}

/**
 * 日曜4:30を過ぎていて、今週の分をまだ実行していなければ、1回だけ実行する。
 * server.js の5分ごとの tick から呼ばれる（secretary-loop.js の maybeCreateAutoWeeklyReport と同じ
 * 日付の判定のしかた）。失敗したら実行日を更新せず、次の tick でやり直す。
 *
 * @param {{config?: Record<string, any>, creds?: Record<string, any>}} [opts] 設定全体と認証情報
 * @returns {Promise<void>}
 */
async function maybeRunWeeklyDiaryFeedback({ config, creds } = {}) {
  const now = new Date();
  if (now.getDay() !== 0) return; // 日曜日のみ
  if (!_isPastTriggerTime(now)) return;

  const state = readState();
  const today = todayStr(now);
  if (state.lastRunDate === today) return; // 今週分は実行済み

  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) return;

  try {
    await runFeedbackForAllChannels({ config, apiKey });
    getLogger().info('[AgentDiaryFeedback] 週次ダイジェスト生成を実行しました');
  } catch (e) {
    getLogger().warn(`[AgentDiaryFeedback] 週次ダイジェスト生成に失敗: ${e.message}`);
    return; // 失敗時はlastRunDateを更新せず、次のtickで再試行させる
  }
  state.lastRunDate = today;
  writeState(state);
}

module.exports = {
  maybeRunWeeklyDiaryFeedback,
  runFeedbackForAllChannels,
  summarizeAgentSelfDigest,
  summarizeDirectorTeamDigest,
  checkDuePredictions,
  addSecretaryFeedbackToTeamDigest,
};
