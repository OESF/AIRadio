/**
 * @file 秘書のヘルパーへ渡すツールを、依頼に要る分野だけに絞る
 *
 * ヘルパー（secretary-helper-agent.js）が毎回すべてのツールの定義（約6,000トークン）を送ると、どのツールを
 * 呼ぶかの判断が遅く、ばらつく（計測では同じ入力で2〜13秒。カレンダーの4つに絞ると1秒弱で安定した）。
 * 会話が進むほど文脈も積み重なり、往復のたびに重くなる。
 *
 * ATTENTION: 依頼ごとに専用のツールを作るのではなく、既にあるツールを分野ごとに束ね、その回に要る束だけを渡す。
 *   - core は常に渡す（時刻・記憶・ファイルの解析など、どの依頼でも使いうるもの）
 *   - 依頼から分野を選ぶのは軽量な LLM の1回（分野の名前の一覧だけを見るので速い）
 *   - 選び損ねても詰まないよう、ヘルパー自身が use_more_tools で束を足せる
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

const { generateText } = require('./llm-client');
const { getLogger } = require('../logger');

/**
 * 分野の定義。キーはモデルに見せる識別子、description は選ぶための手がかり、tools はその分野の機能の名前、
 * writes はそのうち書き込み（作成・変更・削除・記録）をするもの。
 *
 * ATTENTION: 常に渡す core は、どの依頼でも使いうるごく少数に絞る。増やすと絞り込みの意味が薄れるので、
 *            迷ったら分野の側へ入れる。
 */
const GROUPS = {
  core: {
    description: '（常に利用可能）',
    always: true,
    tools: [
      'get_current_time',
      'remember_fact',
      'analyze_uploaded_file',
      'analyze_web_page',
    ],
    writes: ['remember_fact'],
  },
  calendar: {
    description: '予定の確認・登録・変更・削除（カレンダー）',
    tools: ['get_calendar', 'create_calendar_event', 'update_calendar_event', 'delete_calendar_event'],
    writes: ['create_calendar_event', 'update_calendar_event', 'delete_calendar_event'],
  },
  mail: {
    description: 'メールの確認・下書き作成',
    tools: ['get_emails', 'create_email_draft'],
    writes: ['create_email_draft'],
  },
  tasks: {
    description: 'TODO・タスクの確認と追加',
    tools: ['get_tasks', 'create_task'],
    writes: ['create_task'],
  },
  drive: {
    description: 'Googleドライブのファイル作成・更新、スプレッドシートの読み取り分析',
    tools: ['create_drive_file', 'update_drive_file', 'analyze_google_sheet'],
    writes: ['create_drive_file', 'update_drive_file'],
  },
  info: {
    description: 'ニュース・天気・株価など外部の最新情報の取得',
    tools: ['get_news', 'get_weather', 'get_finance', 'get_watchlist_updates'],
  },
  finance: {
    // ATTENTION: この分野は読み取り専用。会話からウィークリーノートを書き換えないよう、update_finance_report は
    //            ツールから外してある（secretary-tools-finance.js を参照）。資産レポートの更新は日曜の週次の処理が行う。
    description: 'リスナー本人の資産（保有銘柄・評価額・推移）の確認と、保有資産ヒートマップの作成',
    tools: ['get_finance_details', 'get_finance_history', 'get_fund_history', 'create_holdings_heatmap'],
    // create_holdings_heatmap は画像を1つ書き出すが、資産のデータ（スナップショット・ウィークリーノート）には
    // 触れない。読み取り専用の依頼でもヒートマップを作れるよう、writes には入れない
    writes: [],
  },
  obsidian: {
    description: 'Obsidianのノート検索・読み取り（デイリーノート等の中身を開く）・記録・レポート保存・プロジェクト管理',
    // read_obsidian_note は読むだけなので writes に入れない（読み取り専用の依頼でも使える）
    tools: ['search_obsidian_notes', 'read_obsidian_note', 'log_to_daily_note', 'save_research_report',
      'create_meeting_notes', 'update_project_tasks'],
    writes: ['log_to_daily_note', 'save_research_report', 'create_meeting_notes', 'update_project_tasks'],
  },
  reports: {
    description: '日報・週報の作成、活動の記録',
    tools: ['create_daily_report', 'report_daily_activity', 'create_weekly_report'],
    writes: ['create_daily_report', 'report_daily_activity', 'create_weekly_report'],
  },
  music: {
    description: 'Spotifyの再生履歴・お気に入り・プレイリスト、YouTubeの動画検索、'
      + '本人が実際に見たYouTube動画の内容',
    tools: ['get_spotify_now_playing', 'get_spotify_recently_played', 'get_spotify_top_tracks',
      'search_spotify_tracks', 'get_spotify_saved_tracks', 'get_spotify_playlists',
      'create_spotify_playlist', 'add_tracks_to_spotify_playlist',
      'search_youtube_videos', 'get_new_subscription_videos', 'get_watched_videos'],
    writes: ['create_spotify_playlist', 'add_tracks_to_spotify_playlist'],
  },
  presentation: {
    description: 'プレゼンテーション（Googleスライド）の作成',
    tools: ['create_presentation'],
    writes: ['create_presentation'],
  },
  agents: {
    description: '番組の専門エージェント（コメンテーター・弁護士等）への相談、放送・会話の履歴照会、'
      + '番組への話題・曲のリクエスト送信',
    tools: ['consult_agent', 'get_secretary_history', 'get_broadcast_history', 'request_show_content'],
    writes: ['request_show_content'],
  },
};

/**
 * 書き込み（作成・変更・削除・記録）をする機能の集合。
 *
 * BUGFIX: 読み取りの依頼では、書き込みの機能をそもそも渡さない。確認だけを頼んだのに作成と削除が5回動き、
 *         予定が二重に登録されたことがある。プロンプトで「読むだけに」と伝えても確実ではなく、渡っていなければ
 *         呼びようがない、というのが確実な歯止めになる。
 */
const WRITE_TOOLS = new Set(Object.values(GROUPS).flatMap((g) => g.writes || []));

const CORE_KEYS = Object.keys(GROUPS).filter((k) => GROUPS[k].always);
const SELECTABLE_KEYS = Object.keys(GROUPS).filter((k) => !GROUPS[k].always);

/**
 * 機能の名前から分野のキーへの逆引き
 */
const TOOL_TO_GROUP = new Map();
for (const [key, g] of Object.entries(GROUPS)) {
  for (const t of g.tools) TOOL_TO_GROUP.set(t, key);
}

/**
 * モデルに見せる分野の一覧（選ばせるための短い文）。
 * @returns {string}
 */
function describeGroups() {
  return SELECTABLE_KEYS.map((k) => `- ${k}: ${GROUPS[k].description}`).join('\n');
}

/**
 * 選ばれた分野の機能だけを、元のツールの宣言から抜き出す。core は常に含める。知らない分野のキーは無視する。
 *
 * @param {Array<Record<string, any>>} allTools buildAllSecretaryTools() の戻り値（そのままの形）
 * @param {string[]} groupKeys 選ばれた分野
 * @param {Set<string>} [excluded] ヘルパーでは使わない機能の名前
 * @param {{ readOnly?: boolean }} [opts] readOnly なら書き込みの機能を除く
 * @returns {Array<Record<string, any>>} 同じ形のツールの宣言
 */
function filterToolsByGroups(allTools, groupKeys, excluded = new Set(), { readOnly = false } = {}) {
  const keys = new Set([...CORE_KEYS, ...(groupKeys || []).filter((k) => GROUPS[k])]);
  const allow = new Set();
  for (const k of keys) for (const t of GROUPS[k].tools) allow.add(t);
  if (readOnly) for (const t of WRITE_TOOLS) allow.delete(t);

  const out = [];
  for (const entry of allTools) {
    if (!entry.functionDeclarations) { out.push(entry); continue; }
    const kept = entry.functionDeclarations.filter((d) => allow.has(d.name) && !excluded.has(d.name));
    if (kept.length > 0) out.push({ functionDeclarations: kept });
  }
  return out;
}

/**
 * どの分野にも入っていない機能を探す（新しいツールを足して分類し忘れるのを防ぐ）。
 * @param {Array<Record<string, any>>} allTools
 * @param {Set<string>} [excluded]
 * @returns {string[]}
 */
function findUngroupedTools(allTools, excluded = new Set()) {
  const names = allTools.flatMap((e) => (e.functionDeclarations || []).map((d) => d.name));
  return names.filter((n) => !excluded.has(n) && !TOOL_TO_GROUP.has(n));
}

/**
 * 依頼から使う分野と、読み取りだけの依頼かどうかを選ぶ。分野の名前と短い説明だけを見せるので、入力は数百トークンで済む。
 *
 * 選び損ねても詰まないよう、呼び出し側は use_more_tools で後から束を足せるようにしておく。
 *
 * @param {{ apiKey: string, request: string, activitySessionId?: any }} opts
 * @returns {Promise<{groups: string[], readOnly: boolean, reason: string}|null>}
 *   判断に失敗したら null（呼び出し側はすべての機能で動く）
 */
async function chooseGroups({ apiKey, request, activitySessionId = null }) {
  try {
    // 分野を選ぶだけの軽い判断なので、軽量のティア
    const res = await generateText({
      tier: 'secretary_light',
      apiKey,
      agentKey: 'secretary_helper',
      activitySessionId,
      logMeta: { purpose: 'helper_choose_groups' },
      systemInstruction: 'この依頼を達成するために必要な分野を選んでください。'
        + '迷ったら多めに選んで構いませんが、明らかに関係の無い分野は入れないでください。'
        + '依頼の結果をノートへ残すよう頼まれている場合は obsidian も選びます。'
        + '\n\nあわせて read_only を判定してください。'
        + '「確認して」「教えて」「見せて」「どうなっている？」のように、'
        + '**何かを調べて答えるだけ**で、作成・変更・削除・記録を一切求められていない依頼なら true。'
        + '少しでも作る・変える・消す・残すことが含まれるなら false。'
        + '迷ったら false にしてください（false でも従来どおり動きます）。',
      prompt: `依頼: ${request}\n\n【分野】\n${describeGroups()}`,
      temperature: 0,
      maxOutputTokens: 256,
      schema: {
        type: 'object',
        properties: {
          groups: { type: 'array', items: { type: 'string' } },
          read_only: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['groups', 'read_only'],
      },
      // 分野を選ぶだけなので、思考は要らない
      thinkingBudget: 0,
      includeThoughts: false,
    });
    const parsed = JSON.parse(res.text);
    const groups = (parsed.groups || []).filter((g) => GROUPS[g] && !GROUPS[g].always);
    if (groups.length === 0) return null;
    return { groups, readOnly: parsed.read_only === true, reason: String(parsed.reason || '').trim() };
  } catch (e) {
    getLogger().warn(`[SecretaryTools] 分野の選択に失敗（全機能で続行）: ${e.message}`);
    return null;
  }
}

module.exports = {
  GROUPS,
  WRITE_TOOLS,
  SELECTABLE_KEYS,
  CORE_KEYS,
  describeGroups,
  filterToolsByGroups,
  findUngroupedTools,
  chooseGroups,
};
