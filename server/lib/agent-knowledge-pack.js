/**
 * @file エージェントの「知識パック」（そのエージェントが今持っている知識をひとまとめにする）
 *
 * エージェントは出演を重ねるほど詳しくなる前提なので、どこに出演しても自分の手持ちを持って出る。
 * リスナー像・週次の自己学習・継続観測メモ・分かったことの台帳・定期監視・自主リサーチ・YouTube の視聴記録・
 * リスナーの予定・裏の顔を、ここ1か所で組み立てる。出演の場（Live の各コーナー・討論コーナー・The Answers・
 * 秘書経由の相談）はすべてここを通る。出演で得た内容の書き戻し（recordAgentNote）も、出演の場に関わらずここを通す。
 *
 * ATTENTION: 手持ちの項目を増やすときは、ここに足せば全員・全出演の場に届く。個別の場所で同じものを足さない
 *            （二重になる）。以前は口が分かれていて、秘書経由の相談でメモ・定期監視・YouTube・裏の顔が欠けていた。
 *            担当分野のデータ（市場データ・天気など）は、その場に固有のものなので各呼び出し側が渡す。
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

const { getLogger } = require('../logger');
const { buildHiddenTalentNote } = require('./hidden-talent-profiles');
const journalistWatch = require('./journalist-watch');
const agentProactiveResearch = require('./agent-proactive-research');
const youtubeWatchStore = require('./youtube-watch-store');
const listenerContext = require('./listener-context');
const knowledgeLedger = require('./agent-knowledge-ledger');

// エージェントごとの継続観測メモ。読み（formatNotesForPrompt）と書き（recordNote）の両方をここで引く
const NOTES_BY_AGENT = {
  commentator:   require('./commentator-corner-notes'),
  journalist:    require('./journalist-corner-notes'),
  legal_advisor: require('./legal-advisor-corner-notes'),
  life_advisor:  require('./life-advisor-corner-notes'),
  news:          require('./news-corner-notes'),
  finance:       require('./finance-corner-notes'),
  traffic:       require('./traffic-corner-notes'),
  weather:       require('./weather-corner-notes'),
  world_report:  require('./world-report-corner-notes'),
  // ゲスト論客。討論コーナー・The Answers・自分のコーナーに出演するたびに溜まり、次の出演で読まれる
  ...require('./guest-agent-notes'),
};

// YouTube の視聴記録（未検証の情報を含む）を渡す相手。議論して立場を取る側だけに限る。
// 顔ぶれは agent-discussion-corner.js の analysts と guestAnalysts と同じだが、あちらを読み込むと循環参照に
// なるので、ここで持つ。
// ATTENTION: agent-system.js の _ytKnowledge（Live の自分のコーナー）と顔ぶれをそろえる。同じ人の手持ちが
//            出演の場で変わらないようにする。
// 報道センターは対象外（事実を預かる役に未検証の材料を持たせると、役割と衝突する）。
const DISCUSSION_ANALYSTS = ['commentator', 'journalist', 'legal_advisor', 'comedian', 'doctor', 'marketer'];

/**
 * The Answers の poolKey（live_commentator など）を、Live 側のエージェントのキーへ戻す。
 * 知識は Live 側のキーで保存されているので、どこから呼ばれても同じ器を引けるようにする。
 * @param {string} key エージェントのキー（接頭辞が無ければそのまま返す）
 * @returns {string}
 */
function resolveHomeAgentKey(key) {
  return String(key || '').replace(/^live_/, '');
}

// 項目ごとの文字数の上限。
// BUGFIX: 全体で1つの上限にして末尾から切ると、末尾にある「裏の顔」や YouTube の後半が黙って消えた。
//         項目ごとに上限を持たせれば、どれか1つが育っても他は消えない。値は今の中身がどれも切られない
//         （全エージェントの最大のおよそ2倍）ように決めてある。
const SECTION_LIMITS = {
  listener:     2000,
  selfDigest:   2000,
  notes:        3000,
  knowledge:    3000,
  watch:        4000,
  research:     7000,
  youtube:      6000,
  hiddenTalent: 800,
  schedule:     3000,
  requests:     1500,
};

/**
 * 1つの項目を上限に収める。行の途中で切らないよう、なるべく直前の改行で切る。
 * @param {string} text
 * @param {keyof typeof SECTION_LIMITS} section 項目の名前
 * @param {string} agentKey ログ用
 * @returns {string}
 */
function _clipSection(text, section, agentKey) {
  const limit = SECTION_LIMITS[section];
  if (!text || !limit || text.length <= limit) return text || '';
  const lastBreak = text.lastIndexOf('\n', limit);
  const cutAt = lastBreak > limit * 0.6 ? lastBreak : limit;
  getLogger().debug(`[KnowledgePack] ${agentKey}/${section}: ${text.length}字 → ${cutAt}字へ切り詰め`);
  return `${text.slice(0, cutAt)}\n（この項目は長いため以下省略）\n`;
}

/**
 * そのエージェントが今持っている知識をひとまとめにして返す。
 *
 * @param {Object} opts
 * @param {string} opts.agentKey        エージェントのキー（poolKey でもよい。自動で変換する）
 * @param {string} [opts.selfDigest]    自分の日記のダイジェスト。呼び出し側が _getAgentDiarySelfDigest() で
 *                                      取って渡す（チャンネルの解決は呼び出し側が持っているため）
 * @param {boolean} [opts.includeListener] リスナー像を含めるか（既定は true）
 * @param {'broadcast'|'consult'} [opts.scene] 出演の場面（既定は broadcast）。リスナー本人の情報をどこまで渡すかが
 *                                      場面で変わる（lib/listener-context.js の POLICY）
 * @param {string} [opts.listenerName]  見出しに使うリスナーの呼び名（無ければ「リスナー」）
 * @param {string} [opts.topic]         今の話題（キャスターの質問・討論の話題・相談の内容など）。
 *                                      分かったことの台帳から関係する事実を選ぶのに使う。無ければ新しい順
 * @param {boolean} [opts.includeSchedule] 予定と TODO を含めるか（既定は true。キャスターとアシスタントは
 *                                      共通の文で受け取るので false）
 * @param {boolean} [opts.includeHiddenTalent] 裏の顔を含めるか（既定は true）。The Answers は番組独自の
 *                                      使い方の指示と一緒に自分で渡すので、二重にならないよう false にする
 * @returns {string} プロンプトへそのままつなげられる文字列（何も無ければ空文字）
 */
function buildAgentKnowledgePack({ agentKey, selfDigest = '', includeListener = true, includeHiddenTalent = true, includeSchedule = true, scene = 'broadcast', listenerName = '', topic = '' } = {}) {
  const key = resolveHomeAgentKey(agentKey);
  const parts = [];
  const add = (section, text) => { if (text) parts.push(_clipSection(text, section, key)); };
  try {
    // リスナー本人の情報をどこまで渡すかは場面で決まる（lib/listener-context.js の POLICY）。
    // includeListener が false（The Answers）の場では、本人の情報を一切渡さない。
    const _scene = includeListener ? scene : 'none';

    // リスナー像（誰に向けて話しているか）。出典と時点を添える
    add('listener', listenerContext.formatPortraitForPrompt(key, { scene: _scene }));

    // 週次の自己学習（日記から取り出した「繰り返しの気づき」と「専門家として得た知見」）
    add('selfDigest', selfDigest);

    // 継続観測メモ。自分が追い続けている話題で、出演を重ねるほど厚くなる
    const notes = NOTES_BY_AGENT[key];
    if (notes?.formatNotesForPrompt) add('notes', notes.formatNotesForPrompt());

    // これまでに分かったこと。継続観測メモが「追う話題の見出し」なのに対し、こちらは「いつ・どこで知り・何が
    // 分かったか」。今の話題に関係するものを選ぶ
    add('knowledge', knowledgeLedger.formatKnowledgeForPrompt(key, { topic }));

    // 定期監視（ジャーナリストだけ。0・6・12・18時に更新。出典付き）
    if (key === 'journalist') {
      const w = journalistWatch.getLatestDigest?.();
      if (w?.digest) {
        const at = new Date(w.fetchedAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
        add('watch', `\n\n【あなたの定期監視で${at}時点に把握済みの最新情報】\n${w.digest}\n`
          + '⚠️ ここに書かれていることは**出典まで確認済み**です。「〜という話もある」ではなく、'
          + '**いつ・誰が・どこで言ったか**を添えて言い切ってください。'
          + 'この情報は最大6時間前のものなので、それより新しい動きは検索で補ってください。');
      }
    }

    // 自主リサーチ（毎朝8時に自分の担当分野を調べたもの。対象は agent-proactive-research.js の AGENT_RESEARCH_DEFS）。
    // 直近の数日分が日付ごとにまとまって届く。見出しは担当ごとの定義（promptLabel）と最新の取得時刻
    const r = agentProactiveResearch.getLatestResearch?.(key);
    if (r?.digest) {
      const at = new Date(r.fetchedAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
      const subject = agentProactiveResearch.AGENT_RESEARCH_DEFS?.[key]?.promptLabel || '';
      add('research', `\n\n【${subject}あなたが自分で先取り調査しておいた情報（直近${r.days || 1}日分・最新は${at}時点）】\n${r.digest}\n`
        + '話題に関係するものがあれば、日付と発表元を添えて使ってください。'
        + 'ライブの検索結果と併用し、より新しい動きがあればそちらを優先してください。');
    }

    // リスナーが実際に見た YouTube の中身（登録チャンネルから推した興味の傾向ではなく）。大手メディアが報じない
    // 最新の情報も多い。議論する人にだけ渡す（事実を確かめる役の報道に未検証の材料を持たせると、「事実と憶測の
    // 線を引く」という役割と衝突する）
    if (DISCUSSION_ANALYSTS.includes(key)) {
      add('youtube', youtubeWatchStore.formatForPrompt());
    }

    // リスナー本人の予定など。誰にどこまで見せるかは lib/listener-context.js の POLICY が決める。
    // includeSchedule が false なのは、キャスターやアシスタントのように別の経路（共通の文）で既に受け取っている場合
    if (includeSchedule) add('schedule', listenerContext.formatScheduleForPrompt(key, { scene: _scene, listenerName }));
    // リクエストの履歴は、知識パックを通る人の中では DJ だけが対象（ディレクターは編成のプロンプトで直接受け取る）。
    // DJ は選曲の担当なので、曲のリクエストに絞る。
    if (_scene === 'broadcast' && key === 'music_dj') {
      add('requests', listenerContext.formatRequestHistoryForPrompt(key, { channel: 'live', kinds: ['music', 'encore'] }));
    }

    // 裏の顔（人間味。使いどころは各所の指示に任せる）
    if (includeHiddenTalent) add('hiddenTalent', buildHiddenTalentNote(key));
  } catch (e) {
    getLogger().warn(`[KnowledgePack] ${agentKey}: 組み立てに失敗（手持ち無しで続行）: ${e.message}`);
  }

  return parts.join('');
}

/**
 * 出演で得た内容を、そのエージェントの継続観測メモと、分かったことの台帳へ書き戻す。
 * 出演した場所に関わらず、ここを通せば手持ちが増える。
 *
 * 失敗しても放送は止めない（結果を待たずに呼ぶ）。
 *
 * @param {string} agentKey エージェントのキー（poolKey でもよい）
 * @param {string} spokenText その出演で本人が話した内容
 * @param {{apiKey?: string, activitySessionId?: string|null, label?: string, sourceHint?: string}} [opts]
 *   label は呼び出し元の印（own_corner・youtube・the_answers・討論コーナーのキー）
 * @returns {Promise<any>}
 */
function recordAgentNote(agentKey, spokenText, { apiKey = null, activitySessionId = null, label = '', sourceHint = '' } = {}) {
  const key = resolveHomeAgentKey(agentKey);
  if (!spokenText || !apiKey) return Promise.resolve();
  // 同じ出来事から、分かったことも台帳へ取り出す
  const sourceType = label === 'own_corner' ? 'corner'
    : label === 'youtube' ? 'youtube'
    : label === 'the_answers' ? 'the_answers'
    : 'discussion';
  const knowledge = knowledgeLedger.recordKnowledge(key, spokenText, { apiKey, activitySessionId, sourceType })
    .catch((e) => getLogger().debug(`[KnowledgePack] ${key}${label ? `(${label})` : ''}: 知見の記録に失敗（無視）: ${e.message}`));
  const notes = NOTES_BY_AGENT[key];
  if (!notes?.recordNote) return knowledge;
  return Promise.all([
    knowledge,
    notes.recordNote(spokenText, { apiKey, activitySessionId, sourceHint })
      .catch((e) => getLogger().debug(`[KnowledgePack] ${key}${label ? `(${label})` : ''}: メモの記録に失敗（無視）: ${e.message}`)),
  ]);
}

/**
 * 継続観測メモの器を持っているエージェントか。
 * @param {string} agentKey
 * @returns {boolean}
 */
function hasNotesStore(agentKey) {
  return !!NOTES_BY_AGENT[resolveHomeAgentKey(agentKey)];
}

module.exports = { buildAgentKnowledgePack, recordAgentNote, resolveHomeAgentKey, hasNotesStore, DISCUSSION_ANALYSTS };
