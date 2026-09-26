/**
 * @file 専門エージェントの自主リサーチ（毎朝1回、担当分野の新しい動きを検索して手元に残す）
 *
 * ジャーナリストの定期監視（journalist-watch.js）と同じく、決まった時刻に検索し、前回から新しいものだけを
 * 記録して、番組と秘書に渡す。対象はエージェントごとの定義（AGENT_RESEARCH_DEFS）で、2種類ある。
 *   - リスナーの状況を材料にする（コメンテーター: 保有銘柄、弁護士: 職業と人物像）。既にあるデータから組み立て、
 *     新しい登録の作業は増やさない
 *   - 担当分野の最新の動きを調べる（general: true。医師・生活アドバイス・マーケター・芸人）
 *
 * 直近 RETAIN_DAYS 日分を日付ごとに server/data/secretary/agent-research/<agentKey>.json に残す。長く残す価値のある
 * 事実は、分かったことの台帳（agent-knowledge-ledger.js）へ移す。利用元は自律ループ（secretary-loop.js）、
 * 知識パック（agent-knowledge-pack.js）、ディレクターの材料（topical-materials.js）。
 *
 * BUGFIX: 「新しい動きは無い」日は記録を増やさない。以前は1日分だけを毎朝上書きしており、動きの無い日にそれまでの
 *         内容が「新しい動きはありません」の一文で消えた。
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
const { generateText } = require('./llm-client');
const { getLogger } = require('../logger');
const activityDb = require('../activity-db');
const jsonFileStore = require('./json-file-store');
const secretaryMemory = require('./secretary-memory');
const { getEffectiveLocationFromConfig } = require('./secretary-profile-format');
const knowledgeLedger = require('./agent-knowledge-ledger');

const RESEARCH_DIR = path.join(__dirname, '..', 'data', 'secretary', 'agent-research');
const RESEARCH_HOUR = 8; // 毎朝8時に1回（finance-service.jsの7時アンカーの後、資産データが確定してから）
const RETAIN_DAYS = 7;   // 何日分の調査結果を手元に残すか
const DIGEST_MAX_CHARS = 6000; // 知識パックへ渡す合計の目安（新しい日から詰め、超えたら古い日を落とす）

// 「新しい動きは無い」という返答（記録として残さず、それまでの内容を消さない）
const NO_NEWS_PATTERN = /^(新しい動きはありません|特に無し|特になし)[。.]?$/;

/** リスナーの呼び名 */
const _listenerName = (config) => config.show?.user_profile?.name || 'リスナー';

/**
 * 今日の日付と季節の一文（分野の動きを調べるとき、いつの時点で調べるかをはっきりさせるため）。
 * @param {Date} [now]
 * @returns {string}
 */
function _todayLine(now = new Date()) {
  const m = now.getMonth() + 1;
  const season = [12, 1, 2].includes(m) ? '冬' : [3, 4, 5].includes(m) ? '春' : [6, 7, 8].includes(m) ? '夏' : '秋';
  return `今日は${now.getFullYear()}年${m}月${now.getDate()}日（${season}）です。`;
}

/**
 * エージェントごとの調査の定義。
 *   defaultName   config.agents.<key>.name が未設定のときだけ使う名前（CLAUDE.md の、名前のハードコードが
 *                 許される例外。AGENT_DEFAULTS と同じ扱い）
 *   promptLabel   知識パック（agent-knowledge-pack.js）が見出しに使う「何について調べたか」
 *   general       true なら、相談者の状況ではなく担当分野の最新の動きを調べる
 *   buildContext  調べる前提となる材料。null を返すと調べない
 *   searchFocus   何を調べるか
 */
const AGENT_RESEARCH_DEFS = {
  commentator: {
    defaultName: '高橋洋二教授',
    promptLabel: '保有銘柄について',
    buildContext(config) {
      const holdings = (config.finance_watchlist?.personal_holdings || []).filter((h) => h.enabled);
      if (holdings.length === 0) return null;
      const names = holdings.map((h) => h.name).join('・');
      return `${_listenerName(config)}さんが実際に保有しているファンド・株式は次の通りです: ${names}`;
    },
    searchFocus: '上記の保有銘柄について、運用会社からの重要な発表・レポート、組入銘柄に関する'
      + '重要なニュース、今後の見通しに影響しうる情報を調べてください。',
  },
  legal_advisor: {
    defaultName: '北村昭雄',
    promptLabel: 'リスナーの状況を踏まえて',
    buildContext(config) {
      const profile = config.show?.user_profile || {};
      const parts = [];
      if (profile.occupation) parts.push(`職業: ${profile.occupation}`);
      // 秘書が蓄えたリスナーの人物像（職歴など）も材料にする。法的に何を調べるべきかの手がかりになる
      const digest = secretaryMemory.getListenerDigestForPrompt();
      if (digest) parts.push(`これまでに分かっている人物像: ${digest.trim()}`);
      if (parts.length === 0) return null;
      return parts.join('\n');
    },
    searchFocus: '上記の人物像（職業・経歴）を踏まえ、この人が事業者・個人として知っておくべき'
      + '直近の法改正・法的な制度変更・注意喚起があれば調べてください（フリーランス・小規模'
      + '事業者向けの新制度、契約・取引に関する法改正等）。',
  },
  doctor: {
    defaultName: '華院 麗子',
    promptLabel: '医療・健康の分野で',
    general: true,
    buildContext() {
      return `${_todayLine()}日本で暮らす一般の人に向けて、医療・健康について話す立場です。`;
    },
    searchFocus: '直近1週間ほどの間に出た、次のような医療・健康の新しい情報を調べてください。\n'
      + '① 厚生労働省・PMDA・国立感染症研究所などの発表（新薬や新しい治療法の承認、医療制度・'
      + '保険・診療報酬の変更、健康に関する注意喚起や回収情報）\n'
      + '② 大学・研究機関・主要な医学誌が発表した研究のうち、一般の人の生活や健康に関わるもの\n'
      + '③ 感染症の流行状況（インフルエンザ・新型コロナ・季節性の感染症など）と、今の季節に'
      + '気をつけたい健康上のリスク\n'
      + '④ 美容医療・健康食品・サプリメントに関する注意喚起や新しい知見\n'
      + '各項目には**発表元と日付を必ず添えて**ください。発表元や日付を確認できないもの、'
      + '研究段階で結論が出ていないものを確定した事実のように書くことはしないでください。',
  },
  life_advisor: {
    defaultName: '平野ドレミ',
    promptLabel: '暮らしと食の分野で',
    general: true,
    buildContext(config) {
      const { location } = getEffectiveLocationFromConfig(config);
      return `${_todayLine()}${location}周辺で暮らす人に向けて、料理・家事・暮らしの知恵について話す立場です。`;
    },
    searchFocus: '直近1週間ほどの間に出た、次のような暮らしと食の新しい情報を調べてください。\n'
      + '① 今が旬の食材と、野菜・魚・米などの店頭価格の動き（高騰・値下がりとその理由）\n'
      + '② いま話題になっている料理・レシピ・食のトレンド（SNSやテレビで注目されているもの）\n'
      + '③ 値上げ・新しい制度・ごみ出しのルール変更・防災情報など、家計や暮らしに直結する変化\n'
      + '④ 今の季節に役立つ家事や生活の知恵（衣替え・保存方法・体調管理など）\n'
      + '各項目には**出典と日付を必ず添えて**ください。確認できないものは書かないでください。',
  },
  marketer: {
    defaultName: '世界 創',
    promptLabel: '流行と消費の分野で',
    general: true,
    buildContext() {
      return `${_todayLine()}日本の消費者と企業の動きを、「何が人の心を動かしたか」という視点で読み解く立場です。`;
    },
    searchFocus: '直近1週間ほどの間に出た、次のような流行と消費の新しい情報を調べてください。\n'
      + '① 新商品・ヒット商品・売れ筋ランキングの動き（何が売れ、何が失速したか）\n'
      + '② 消費動向を示す統計や調査（家計調査・消費者態度指数・百貨店やコンビニの売上など）\n'
      + '③ 企業のマーケティングの打ち手（キャンペーン・ブランドの刷新・値付けの変更、話題になった成功例や失敗例）\n'
      + '④ SNSや若い世代を中心に広がっている流行・ブーム\n'
      + '各項目には**出典と日付を必ず添えて**ください。確認できないもの、宣伝目的の情報を'
      + '裏付けなしに事実として書くことはしないでください。',
  },
  comedian: {
    defaultName: '難波亭 ボケ',
    promptLabel: '芸能と世間の話題で',
    general: true,
    buildContext() {
      return `${_todayLine()}世の中の出来事を、庶民の感覚で噛み砕いて話す立場です。`;
    },
    searchFocus: '直近1週間ほどの間に出た、次のような話題を調べてください。\n'
      + '① 芸能界・エンタメの出来事（テレビ・映画・音楽・お笑い界の新しい動き）\n'
      + '② 世間で話題になっている出来事や、SNSで大きく盛り上がっている話題\n'
      + '③ スポーツの大きな話題や、季節の行事・イベント\n'
      + '④ 身近な暮らしの中で多くの人が話題にしている出来事\n'
      + '各項目には**出典と日付を必ず添えて**ください。**報道などで確認できた出来事だけ**を書き、'
      + '噂・憶測・週刊誌的なゴシップ、個人の私生活への踏み込みは書かないでください。',
  },
};

/**
 * 調査の結果のファイルのパス。
 * @param {string} agentKey
 * @returns {string}
 */
function _watchPath(agentKey) {
  return path.join(RESEARCH_DIR, `${agentKey}.json`);
}

/**
 * 調査の結果を読む。
 * 形: { entries: [{ slotKey, fetchedAt, text }]（新しい順）, slotKey（最後に調べた日） }。
 * 古い形 { digest, fetchedAt, slotKey } は読むときに変換する（「新しい動きはありません」だけのものは入れない）。
 * @param {string} agentKey
 * @returns {{ entries: Array<Record<string, any>>, slotKey: string }}
 */
function _readWatch(agentKey) {
  const raw = jsonFileStore.readJsonFile(_watchPath(agentKey), null, '[AgentProactiveResearch]');
  if (!raw) return { entries: [], slotKey: '' };
  if (Array.isArray(raw.entries)) return { entries: raw.entries, slotKey: raw.slotKey || '' };
  const text = String(raw.digest || '').trim();
  const entries = (text && !NO_NEWS_PATTERN.test(text))
    ? [{ slotKey: raw.slotKey || '', fetchedAt: raw.fetchedAt || 0, text }]
    : [];
  return { entries, slotKey: raw.slotKey || '' };
}

/**
 * 調査の結果を書く。
 * @param {string} agentKey
 * @param {Record<string, any>} data
 */
function _writeWatch(agentKey, data) {
  jsonFileStore.writeJsonFile(_watchPath(agentKey), data, '[AgentProactiveResearch]');
}

/**
 * 今の時刻が属する日付（RESEARCH_HOUR より前なら前の日）。1日に1回だけ調べるための印。
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
function _currentSlotKey(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < RESEARCH_HOUR) d.setDate(d.getDate() - 1);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 残しておく期間の中の結果だけに絞る（新しい順）。
 * @param {Array<Record<string, any>>} entries
 * @param {number} [now]
 * @returns {Array<Record<string, any>>}
 */
function _retained(entries, now = Date.now()) {
  const cutoff = now - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter((e) => (e.fetchedAt || 0) >= cutoff).slice(0, RETAIN_DAYS);
}

/**
 * 「9月18日」の形の日付。
 * @param {string} slotKey
 * @returns {string}
 */
function _slotLabel(slotKey) {
  const [, m, d] = String(slotKey).split('-');
  return m && d ? `${Number(m)}月${Number(d)}日` : slotKey;
}

/**
 * 日付ごとにまとめた本文（新しい日から詰め、合計の目安を超えたら古い日を落とす）。
 * @param {Array<Record<string, any>>} entries
 * @returns {string}
 */
function _formatEntries(entries) {
  const blocks = [];
  let total = 0;
  for (const e of entries) {
    const block = `▼${_slotLabel(e.slotKey)}の調査\n${e.text}`;
    if (blocks.length > 0 && total + block.length > DIGEST_MAX_CHARS) break;
    blocks.push(block);
    total += block.length;
  }
  return blocks.join('\n\n');
}

/**
 * 調査のプロンプトを組み立てる（これまで把握している内容を渡し、新しいものだけを書かせる）。
 * @param {{ def: Record<string, any>, config: Record<string, any>, agentName: string, previousDigest: string }} opts
 * @returns {string|null} 材料が無ければ null
 */
function _buildPrompt({ def, config, agentName, previousDigest }) {
  const context = def.buildContext(config);
  if (!context) return null;
  const previousBlock = previousDigest ? `【これまでに把握している内容（直近${RETAIN_DAYS}日）】\n${previousDigest}\n\n` : '';
  const intro = def.general
    ? `あなたは${agentName}です。担当分野の最新の動きを、放送や相談に備えて調べておきます。\n\n${context}\n\n`
    : `あなたは${agentName}です。以下は相談者（${_listenerName(config)}さん）の状況です。\n\n${context}\n\n`;
  return `${previousBlock}${intro}${def.searchFocus}\n\n`
    + (previousDigest
      ? '【重要】上の「これまでに把握している内容」に既に含まれているものは書かないでください。それ以降に'
        + '出た新しい情報だけを、要点・（分かれば）日時の形で簡潔に列挙してください。特に新しい'
        + '動きが無ければ「新しい動きはありません」とだけ書いてください。'
      : '要点・（分かれば）日時の形で簡潔に列挙してください。特に無ければ「特に無し」とだけ書いてください。')
    + '\n挨拶や自己紹介は書かず、調べた内容だけを書いてください。';
}

/**
 * 1人分の調査を、今日まだなら行う。
 * @param {string} agentKey
 * @param {Record<string, any>} def AGENT_RESEARCH_DEFS の定義
 * @param {{ config: Record<string, any>, creds: Record<string, any> }} ctx
 * @returns {Promise<void>}
 */
async function _runOne(agentKey, def, { config, creds }) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) return;
  const slotKey = _currentSlotKey();
  const watch = _readWatch(agentKey);
  if (watch.slotKey === slotKey) return; // 今日の分は取得済み

  const agentName = config.agents?.[agentKey]?.name || def.defaultName;
  const kept = _retained(watch.entries);
  const prompt = _buildPrompt({ def, config, agentName, previousDigest: _formatEntries(kept) });
  if (!prompt) return; // 材料が無い（保有銘柄が0件・プロフィールが未設定など）

  const activitySessionId = activityDb.openSession('secretary');
  let text;
  try {
    // 検索を伴う調査なので research のティア
    ({ text } = await generateText({
      tier: 'research',
      apiKey,
      prompt,
      grounded: true,
      agentKey: `proactive_research_${agentKey}`,
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[AgentProactiveResearch] ${agentKey}の取得に失敗（次回に再試行します）: ${e.message}`);
    activityDb.closeSession(activitySessionId);
    return;
  }
  activityDb.closeSession(activitySessionId);
  const body = String(text || '').trim();
  if (!body) return;

  if (NO_NEWS_PATTERN.test(body)) {
    // 新しい動きが無い日は、調べたことだけを記録し、これまでの内容は残す
    _writeWatch(agentKey, { entries: kept, slotKey });
    getLogger().info(`[AgentProactiveResearch] ${agentKey}: 新しい動きなし（手元の${kept.length}日分は保持、slot=${slotKey}）`);
    return;
  }
  const entries = [{ slotKey, fetchedAt: Date.now(), text: body }, ...kept].slice(0, RETAIN_DAYS);
  _writeWatch(agentKey, { entries, slotKey });
  getLogger().info(`[AgentProactiveResearch] ${agentKey}の定期取得完了（${body.length}文字、手元${entries.length}日分、slot=${slotKey}）`);
  // 調査の結果は7日で手元から外れるので、長く残す価値のある事実は分かったことの台帳へ移す（結果は待たない）
  knowledgeLedger.recordKnowledge(agentKey, body, { apiKey, sourceType: 'research', maxFacts: 8 }).catch(() => {});
}

/**
 * 全員分の調査を、今日まだなら行う。自律ループ（secretary-loop.js）から、journalist-watch.js と同じく
 * 自律ループの有効・無効に関わらず呼ばれる。1日1回の軽い処理なので、単純さを優先して1人ずつ順に行う。
 * @param {{ config: Record<string, any>, creds: Record<string, any> }} ctx
 * @returns {Promise<void>}
 */
async function maybeRunAgentProactiveResearch({ config, creds }) {
  for (const [agentKey, def] of Object.entries(AGENT_RESEARCH_DEFS)) {
    await _runOne(agentKey, def, { config, creds }).catch((e) => {
      getLogger().warn(`[AgentProactiveResearch] ${agentKey}の処理で例外: ${e.message}`);
    });
  }
}

/**
 * 番組と秘書が使う、直近の調査の結果（残しておく期間の分を日付ごとにまとめる）。
 * @param {string} agentKey
 * @returns {{digest: string, fetchedAt: number, days: number} | null} 中身のある結果がまだ無ければ null
 */
function getLatestResearch(agentKey) {
  const kept = _retained(_readWatch(agentKey).entries);
  if (kept.length === 0) return null;
  return { digest: _formatEntries(kept), fetchedAt: kept[0].fetchedAt, days: kept.length };
}

module.exports = { maybeRunAgentProactiveResearch, getLatestResearch, AGENT_RESEARCH_DEFS, RETAIN_DAYS };
