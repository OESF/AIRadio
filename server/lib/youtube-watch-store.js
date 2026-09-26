/**
 * @file リスナーが実際に見た YouTube 動画の要約の保存と、各エージェントへの渡し方
 *
 * Tampermonkey のスクリプトが視聴中のページから字幕を拾って送り（youtube-import-routes.js）、
 * youtube-watch-summarize.js が要約したものをここへ保存する。保存先は
 * server/data/secretary/youtube-watched.json（新しい順・最大 MAX_ENTRIES 件）。
 *
 * 公式 API を使わないのは、視聴履歴は API から廃止済みで、字幕（captions.download）も自分が所有する
 * 動画しか取れないため。ログインして開いているページの中には字幕があるので、そこから拾う。
 *
 * ATTENTION: 生の字幕は保存しない。30分の動画で1〜2万字あり、そのままではプロンプトに入らず
 * ディスクも食うので、取り込むときに要約し、要約だけを残す。
 *
 * 同じデータを、渡す相手によって別の書式で渡す。
 * - 放送に出るエージェント（formatForPrompt）: エージェント自身の知識として
 * - Secretary（formatForSecretaryPrompt）: リスナー本人の視聴記録として（URL 付き）
 * - The Answers のディレクター（formatForThemeSelection）: テーマの種を探す俯瞰用に
 * - 継続観測メモ（learnFromVideo）: 持ち場の正面にある出演者だけが論点を書き留める
 *
 * youtube-interest-learning.js（登録チャンネルの名前から興味の傾向を推測する）とは別物で、
 * こちらは実際に見た動画の中身を扱う。
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
const { writeJsonFile } = require('./atomic-json');
const { getLogger } = require('../logger');
const { getGuestAnalystDef } = require('./guest-analyst-corner');

const STORE_PATH = path.join(__dirname, '..', 'data', 'secretary', 'youtube-watched.json');

// 保持する件数（1日5本見るとして約2か月ぶん）。古いものから落とす。
const MAX_ENTRIES = 300;
// formatForPrompt がプロンプトへ入れる既定の上限（日数・本数・文字数）。呼び出し側で変えられる。
const DEFAULT_PROMPT_DAYS = 7;
const DEFAULT_PROMPT_LIMIT = 12;
const DEFAULT_PROMPT_CHARS = 2500;

/**
 * 保存している動画の一覧を読む（読めなければ空の配列）。
 *
 * @returns {Array<Record<string, any>>} 新しい順の動画
 */
function _read() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.videos) ? data.videos : [];
  } catch {
    return [];
  }
}

/**
 * 動画の一覧を書き込む（原子的に書き込む）。
 *
 * @param {Array<Record<string, any>>} videos 新しい順の動画
 * @returns {void}
 */
function _write(videos) {
  writeJsonFile(STORE_PATH, { videos, updatedAt: new Date().toISOString() });
}

/**
 * すでに取り込んだ動画か（同じ動画を何度も要約しないため）。
 *
 * @param {string} videoId YouTube の動画 ID
 * @returns {boolean} 取り込み済みなら true
 */
function hasVideo(videoId) {
  return _read().some((v) => v.videoId === videoId);
}

/**
 * 見た動画の要約を保存する。
 *
 * 同じ videoId がすでにあれば置き換える（見直したときに、長く見た方の記録で更新されるように）。
 * 新しい順に並べ、MAX_ENTRIES 件で切る。
 *
 * @param {Object} entry 保存する動画
 * @param {string} entry.videoId 動画 ID
 * @param {string} entry.title 題名
 * @param {string} entry.channel チャンネル名
 * @param {string} entry.url 動画の URL
 * @param {string} entry.summary 要約した本文（生の字幕は渡さないこと）
 * @param {string} [entry.publishedAt] 動画の公開日（ページから取れた場合）
 * @param {number} [entry.watchedPct] どこまで見たか（0〜100）
 * @param {boolean} [entry.hadTranscript] 字幕から要約できたか（題名と説明文だけなら false）
 * @returns {void}
 */
function saveVideo(entry) {
  const videos = _read().filter((v) => v.videoId !== entry.videoId);
  videos.push({ ...entry, importedAt: new Date().toISOString() });
  // 新しい順に並べて上限で切る
  videos.sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  _write(videos.slice(0, MAX_ENTRIES));
  getLogger().info(`[YouTubeWatch] 取り込み: ${entry.channel} / ${String(entry.title).slice(0, 40)}`
    + `（${entry.hadTranscript ? '字幕あり' : '字幕なし・説明文から'}・要約${(entry.summary || '').length}字・保持${Math.min(videos.length, MAX_ENTRIES)}件）`);
}

/**
 * 直近 days 日に取り込んだ動画を新しい順に返す。
 *
 * @param {{days?: number, limit?: number}} [opts] 日数と最大本数
 * @returns {Array<Record<string, any>>} 動画
 */
function listRecent({ days = DEFAULT_PROMPT_DAYS, limit = DEFAULT_PROMPT_LIMIT } = {}) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return _read()
    .filter((v) => Date.parse(v.importedAt || '') >= since)
    .slice(0, limit);
}

/**
 * 放送に出るエージェントのプロンプトへ入れる形で返す。
 *
 * これは行動の記録ではなく情報源として渡す。誰が見たかではなく、何が語られていたかを
 * エージェント自身の知識として持たせるのが目的。
 *
 * ATTENTION: 「リスナーが見た動画では」という紹介のしかたはさせない（プロンプトで禁止している）。
 * 一方で出どころ（個人発信の未検証の情報）は必ず添え、鵜呑みにも無視にもさせず、正しいかどうかを
 * エージェント自身に判断させる。
 *
 * Secretary 向け（formatForSecretaryPrompt）は逆に、リスナー本人と直接話す相手なので、本人の
 * 視聴記録として渡す。
 *
 * @param {{days?: number, limit?: number, maxChars?: number}} [opts] 日数・最大本数・最大文字数
 * @returns {string} プロンプトに入れる文（動画が無ければ空文字）
 */
function formatForPrompt({ days = DEFAULT_PROMPT_DAYS, limit = DEFAULT_PROMPT_LIMIT,
                           maxChars = DEFAULT_PROMPT_CHARS } = {}) {
  const list = listRecent({ days, limit });
  if (list.length === 0) return '';
  const lines = list.map((v) => {
    const d = v.importedAt ? new Date(v.importedAt) : null;
    const label = d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
    return `- [${label} ${v.channel}]「${v.title}」\n  ${v.summary}`;
  });
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n（以下省略）';
  return `\n\n【あなたが把握しておくべき最近の情報（${days}日以内・${list.length}本の解説動画より）】\n${body}\n`
    + '※ これは**あなた自身が仕入れた知識**として扱ってください。番組で議論・解説をするときの'
    + '材料であり、必要な場面で中身（主張・数字・固有名詞）を使ってください。\n'
    + '※ **「リスナーが見た動画では」という紹介のしかたはしないでください。**'
    + '誰が見たかは本質ではありません。あなたが知っている情報の一つとして、内容そのものを使うこと。\n'
    + '※ ただし出どころは**個人が発信した未検証の情報**です。大手メディアが報じていない論点が'
    + '含まれる一方、裏の取れていない主張も混ざります。**鵜呑みにせず、正しいかどうかを'
    + 'あなた自身が判断してください。** 確認が取れていないことを断定するのは禁止です'
    + '（「そういう見方もありますが」と留保を付けるか、事実として確認できた部分だけを使う）。\n'
    + '※ ここに書かれている内容と、あなたが別に持っている事実が食い違う場合は、'
    + '**食い違っていること自体が論点**になりえます。黙って一方に合わせず、'
    + '「そこは見方が分かれています」と示してよい。\n';
}

/**
 * Secretary（リスナー本人の秘書）のプロンプトへ入れる形で返す。
 *
 * 放送向け（formatForPrompt）との違いは語り口で、本人と直接話す相手なので「あなたが見たもの」として
 * 渡す。未検証の情報である注意は同じく付ける（秘書が動画の内容を確かな事実として語らないように）。
 * 起動時に渡すのは直近ぶんだけで、それより前は get_watched_videos で引かせる。
 *
 * @param {{days?: number, limit?: number, maxChars?: number}} [opts] 日数・最大本数・最大文字数
 * @returns {string} プロンプトに入れる文（動画が無ければ空文字）
 */
function formatForSecretaryPrompt({ days = 3, limit = 8, maxChars = 3500 } = {}) {
  const list = listRecent({ days, limit });
  if (list.length === 0) return '';
  // BUGFIX: URL も渡す。渡していなかったころは、URL は保存済みなのに秘書の手元に無く、
  // 「リンクは出せません」と答えていた。
  const lines = list.map((v) => {
    const d = v.importedAt ? new Date(v.importedAt) : null;
    const label = d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
    return `- [${label} ${v.channel}]「${v.title}」\n  ${v.summary}\n  URL: ${v.url}`;
  });
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n（以下省略）';
  return `\n\n【リスナーがこの${days}日で実際に見たYouTube（${list.length}本）】\n${body}\n`
    + '※ リスナーが自分で選んで見た動画の内容です。今どんなことに関心を持っているかが'
    + 'ここに表れているので、話題に出たときは踏まえて応じてください。'
    + '聞かれてもいないのに一覧を読み上げる必要はありません。\n'
    + '※ ただし**個人が発信した未検証の情報を含みます**。動画で語られていたことを、'
    + '確認された事実であるかのように話さないでください。'
    + '「先日ご覧になっていた動画では〜と言われていましたね」のように、'
    + '出どころが分かる言い方をしてください。\n'
    + '※ ここに無い、もっと前に見た動画について聞かれた場合は、視聴記録を読む機能で'
    + '確認してから答えてください（記憶や推測で動画の内容を作って話さないこと）。\n'
    + '※ URLは**読み上げないでください**（音では伝わりません）。'
    + '「もう一度見たい」「リンクある？」と言われたときや、一覧を画面に出すときは、'
    + '実際のURLをそのまま使ったMarkdownリンク（[タイトル](URL)）で画面表示機能を'
    + '呼んでください。**URLを推測で組み立てるのは禁止**です（ここにあるものだけを使うこと）。\n';
}


/**
 * selectLearnersForVideo が読む Live の設定ファイルと、人物設定の冒頭から読む文字数。
 */
const LIVE_CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const PERSONA_GIST_CHARS = 160;

/**
 * この動画を、自分の持ち場のコーナーで専門家として追いかけるのが自然な出演者を選ぶ。
 *
 * 担当分野はコードに書かず、管理画面で編集できる各人の人物設定（prompt）の冒頭を読んで判定する
 * （エージェント名・人物設定をハードコードしない方針。CLAUDE.md 参照）。ゲスト論客は人物設定の
 * 冒頭に分野が書かれていないことがあるので、担当コーナーの名前も添える。
 *
 * @param {Record<string, any>} entry 動画（channel・title・summary）
 * @param {{apiKey: string, activitySessionId?: any, learners: any}} opts
 *   API キー・活動記録のセッション ID・判定の対象にするエージェントキー
 * @returns {Promise<string[]|null>} 選ばれたエージェントキー（判定に失敗したら null）
 */
async function selectLearnersForVideo(entry, { apiKey, activitySessionId = null, learners }) {
  let agents = {};
  try {
    agents = JSON.parse(fs.readFileSync(LIVE_CONFIG_PATH, 'utf8')).agents || {};
  } catch (e) {
    getLogger().warn(`[YouTubeWatch] 学習の判定: 設定を読めませんでした（${e.message}）`);
    return null;
  }
  const roster = learners
    .map((key) => {
      const a = agents[key] || {};
      const gist = String(a.prompt || '').replace(/\s+/g, ' ').trim().slice(0, PERSONA_GIST_CHARS);
      // ゲスト論客は、人物設定の冒頭に芸風や経歴しか無く持ち場が読み取れないことがある。
      // 担当コーナーの定義（lib/guest-analyst-corner.js）があれば添える。
      const corner = getGuestAnalystDef(key)?.cornerName || '';
      return gist ? { key, name: a.name || key, gist, corner } : null;
    })
    .filter(Boolean);
  if (roster.length === 0) return null;

  const { generateText } = require('./llm-client');
  const systemInstruction = 'あなたはラジオ番組の編成担当です。視聴された動画の内容について、'
    + '出演者それぞれが「自分の持ち場のコーナーで、専門家として今後も追いかける論点」として'
    + '扱うのが自然かどうかを判定してください。\n'
    + '判定の基準:\n'
    + '- 動画の主題が、その人の人物設定に書かれた専門分野・持ち場の**正面**にあるときだけ選ぶ\n'
    + '- 「一般論として少しは関係しうる」「話のネタにはなるかもしれない」程度では選ばない\n'
    + '- 経歴として書かれているだけの分野（「元◯◯」など）ではなく、その人が番組で**いま担当している専門**で判断する。［担当］があればそれを最も重く見る\n'
    + '- 誰の持ち場にも当てはまらなければ、空の配列にする（無理に誰かを選ばない）\n'
    + '出力はJSONのみとし、説明文は含めないでください。';
  const prompt = '【出演者（キーと人物設定の冒頭）】\n'
    + roster.map((r) => `- ${r.key}（${r.name}）${r.corner ? `［担当: ${r.corner}］` : ''}: ${r.gist}`).join('\n')
    + `\n\n【動画】\n【${entry.channel}】「${entry.title}」\n${String(entry.summary).slice(0, 2500)}\n\n`
    + '出力形式（このJSONのみ）: {"learners": ["該当する出演者のキー", ...]}（該当者なしは {"learners": []}）';

  let raw;
  try {
    ({ text: raw } = await generateText({
      tier: 'light',
      apiKey,
      systemInstruction,
      prompt,
      temperature: 0,
      json: true,
      agentKey: 'youtube_learning_selector',
      activitySessionId,
    }));
    const picked = JSON.parse(raw)?.learners;
    if (!Array.isArray(picked)) throw new Error('learners が配列ではありません');
    const valid = new Set(roster.map((r) => r.key));
    return [...new Set(picked.filter((k) => valid.has(k)))];
  } catch (e) {
    getLogger().warn(`[YouTubeWatch] 学習の判定に失敗（この動画では誰も書き留めません）: ${e.message}`);
    return null;
  }
}

/**
 * 取り込んだ動画から、持ち場の正面にある出演者が「継続観測メモ」へ論点を書き留める。
 *
 * プロンプトへ渡すのは直近7日ぶんだけなので、それより前に見た動画で知ったことは消えてしまう。
 * 継続観測メモ（週次で digest.json へ要約され、buildAgentKnowledgePack が毎回読む）へ流し込み、
 * 後々まで手持ちとして残す。全文ではなく、その人の立場から見て重要な論点へ圧縮するのが要点。
 *
 * 書き留める候補は、知識を読む側（agent-knowledge-pack.js の DISCUSSION_ANALYSTS）と同じ顔ぶれ。
 * そのうち selectLearnersForVideo で選ばれた人だけに書かせる。
 *
 * BUGFIX: 候補の一覧はここに直書きせず DISCUSSION_ANALYSTS を参照する。直書きしていたころは、
 * 読む側にだけゲスト論客が加わり、ゲスト論客が動画から論点を溜めることが一度も無かった。
 *
 * BUGFIX: 全員に書かせず、持ち場の正面にある人だけに書かせる。書き留める係はその人の担当を
 * 知らないので、全員に渡すと、持ち場から遠い論点（例: 芸人やマーケターが Mac のメモリと
 * ローカル LLM の速度の話）まで書き留めていた。判定に失敗した動画では誰にも書かせない
 * （全員に書かせると同じ問題が起きるため）。
 *
 * 結果を待たずに裏で進める。失敗しても取り込み自体は成功とする（学習は後から取り返せるが、
 * 要約を失うと動画は戻ってこない）。
 *
 * @param {Record<string, any>} entry 保存した動画（channel・title・summary）
 * @param {{apiKey?: string, activitySessionId?: any}} [opts] API キーと活動記録のセッション ID
 * @returns {void}
 */
function learnFromVideo(entry, { apiKey, activitySessionId = null } = {}) {
  if (!apiKey || !entry?.summary) return;
  // 循環参照を避けるため、使うときに require する（agent-knowledge-pack → youtube-watch-store の向きがすでにある）
  const { recordAgentNote, DISCUSSION_ANALYSTS } = require('./agent-knowledge-pack');
  const material = `【${entry.channel}】「${entry.title}」
${entry.summary}`;
  const titleLabel = String(entry.title).slice(0, 30);

  (async () => {
    const learners = await selectLearnersForVideo(entry, { apiKey, activitySessionId, learners: DISCUSSION_ANALYSTS });
    if (!learners) return;
    if (learners.length === 0) {
      getLogger().info(`[YouTubeWatch] 学習: 誰の持ち場にも当たらないため書き留めません（${titleLabel}）`);
      return;
    }
    for (const agentKey of learners) {
      recordAgentNote(agentKey, material, {
        apiKey,
        activitySessionId,
        label: 'youtube',
        sourceHint: '以下は、あなたが見た解説動画の内容です（個人の発信を含む未検証の情報）。'
          + 'ここから、**あなたの専門の立場で今後も継続して追うべき論点**があれば書き留めてください。'
          + '動画の主張をそのまま事実として書くのではなく、「何が争点になっているか」'
          + '「今後どこを確かめるべきか」の形にすること。',
      }).catch(() => {});
    }
    getLogger().info(`[YouTubeWatch] 学習: ${learners.join('・')} が継続観測メモへ書き留めます（${titleLabel}）`);
  })().catch((e) => getLogger().warn(`[YouTubeWatch] 学習の処理で例外: ${e.message}`));
}


/**
 * The Answers のディレクターがテーマを選ぶときのプロンプトへ入れる形で返す。
 *
 * ニュースの見出しと照らし合わせて、いま何が話題になっているかを俯瞰し、議題の種を見つけるための
 * もの。放送向け（formatForPrompt）と違って中身を議論に使うわけではないので、要約は冒頭だけにし、
 * そのぶん本数を多く見せる。
 *
 * @param {{days?: number, limit?: number, maxChars?: number, summaryChars?: number}} [opts]
 *   日数・最大本数・最大文字数・1本あたりの要約の文字数
 * @returns {string} プロンプトに入れる文（動画が無ければ空文字）
 */
function formatForThemeSelection({ days = 10, limit = 20, maxChars = 3000, summaryChars = 160 } = {}) {
  const list = listRecent({ days, limit });
  if (list.length === 0) return '';
  const lines = list.map((v) => {
    const d = v.importedAt ? new Date(v.importedAt) : null;
    const label = d ? `${d.getMonth() + 1}/${d.getDate()}` : '';
    const head = String(v.summary || '').replace(/\s+/g, ' ').slice(0, summaryChars);
    return `- [${label} ${v.channel}]「${v.title}」\n  ${head}…`;
  });
  let body = lines.join('\n');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n（以下省略）';
  return `\n\n【リスナーが最近ここ${days}日で実際に見た解説動画（${list.length}本）】\n${body}\n`
    + '※ これは**いま何が話題になっているか**を示す生きた手がかりです。'
    + 'テレビ・新聞が扱う前の論点や、大手が報じない角度がここに現れることがあります。\n'
    + '※ **上のニュース見出しと照らし合わせてください。** 同じ出来事が両方に出ていれば'
    + 'それは注目度が高く、議論しがいのある話題である可能性が高い。'
    + '逆に動画にだけ出ている論点は、まだ表に出ていない争点かもしれません。\n'
    + '※ ただし個人の発信を含む未検証の情報です。**動画の主張をそのままテーマにしない**こと。'
    + '「何が争点になっているか」を読み取り、答えが一つではない問いの形へ組み立て直してください。\n';
}

/**
 * 取り込みの状況を返す（管理画面や確認用）。
 *
 * @returns {{total: number, recent7d: number, latest: Record<string, any>|null}} 総数・直近7日の数・最新の1件
 */
function summarize() {
  const all = _read();
  return {
    total: all.length,
    recent7d: listRecent({ days: 7, limit: 9999 }).length,
    latest: all[0] ? { title: all[0].title, channel: all[0].channel, importedAt: all[0].importedAt } : null,
  };
}

module.exports = {
  saveVideo, hasVideo, listRecent, formatForPrompt, formatForSecretaryPrompt,
  formatForThemeSelection, learnFromVideo, selectLearnersForVideo, summarize, STORE_PATH,
};
