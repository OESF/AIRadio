/**
 * @file 秘書のデイリーノートと週次ノート（Obsidian）を作る
 *
 * その日のノートに天気・ニュース・金融と、秘書自身の業務ログを書き、日曜の夜には1週間分をまとめた
 * 週次ノートを書く。会話から頼まれたとき（create_daily_report などのツール）と、秘書のループが
 * 自動で行うとき（secretary-loop.js）の両方から、同じ処理を通る。
 *
 * - createDailyReport: その日の天気・ニュース・金融（と天気図・衛星画像）をデイリーノートへ
 * - createSecretaryActivityLog: その日の業務内容・報告事項・所感をデイリーノートへ
 * - createWeeklyReport: 1週間の天気・ニュース・AI とテクノロジーの話題・活動記録・資産を週次ノートへ
 *
 * ATTENTION: 見出しやリンクを含むもの（地震・台風・時間帯別の予報・ニュースの一覧）は、LLM に渡さず
 * コードで組み立てる。渡すと見出しやリンクを書き換えられてしまう。LLM に任せるのは、体裁を整えること・
 * たくさんある中から選ぶこと・概況を書くことだけ。
 *
 * 資産のレポート（updateFinanceReport）は secretary-tools-finance.js にあり、週次からそれを呼ぶ。
 * 依存はこのファイル → finance の一方向にする。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */
'use strict';

const obsidianService = require('../services/obsidian-service');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const secretaryStore = require('./secretary-store');
const { fetchWeatherChartBuffer, fetchSatelliteImageBuffer } = require('../routes/weather-satellite-routes');
// 【2026-08-08・リファクタ】デイリーノート整形ヘルパー群（formatNewsForDailyNote〜
// _extractQuakeSectionDeterministic）を切り出し済み（詳細・移行の経緯は同ファイル先頭コメント参照）。
const {
  formatNewsForDailyNote, _buildNewsMarkdown, _buildBusinessNewsMarkdown,
  _extractBusinessNewsSectionFromFinanceText, formatFinanceForDailyNote,
  _extractQuakeSectionDeterministic, _extractTyphoonSectionDeterministic,
  _extractOfficialForecastSectionDeterministic, _extractForecastSectionDeterministic,
  _extractForecastRowsDeterministic, _extractWeatherWarningSection, _stripCurrentWeatherLine,
  _stripJgbSection, _buildTempLineChart,
} = require('./secretary-daily-note-formatting');
const {
  datesForWeekEndingOn, buildPastWeekWeatherMarkdown, buildNextWeekForecastMarkdown, prepareNextWeekForecast,
} = require('./secretary-weekly-note-formatting');
const { _requireObsidian } = require('./secretary-tools-obsidian');
const { getEffectiveLocationFromConfig } = require('./secretary-profile-format');
const { updateFinanceReport } = require('./secretary-tools-finance');
const {
  estimatePersonalHoldingsDailyChange, formatPersonalHoldingsChangeForPrompt,
  formatPersonalHoldingsTableForNote,
} = require('./personal-holdings-value');
const { weatherService, newsService, financeService, buildCenterOverview } = require('./secretary-tools-services');
const { generateText } = require('./llm-client');
const GoogleService = require('../services/google-service');

// ATTENTION: カレンダー・タスクのメソッドは実行時にミックスインで生やしているため、静的には見えない
/** @type {any} */
const googleService = new GoogleService();

/**
 * ニュースの一覧から、市場に大きく関わるものだけを LLM に選ばせる。
 * ATTENTION: 返させるのは選んだ番号だけにすること。本文を書かせると見出しやリンクが書き換わる。
 * 失敗したときと API キーが無いときは、先頭から順に採る。
 * @param {Array<any>} items ニュース（title・desc）
 * @param {{max: number, apiKey?: string, activitySessionId?: any, focusLabel: string}} opts
 * @returns {Promise<number[]>} 採る番号（重要な順）
 */
async function _selectImportantNewsIndices(items, { max, apiKey, activitySessionId = null, focusLabel }) {
  const fallback = items.map((_, i) => i).slice(0, max);
  if (!items || items.length === 0 || !apiKey) return fallback;
  try {
    const payload = items.map((it, i) => ({ i, title: it.title, desc: it.desc || '' }));
    const { text: text } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: `あなたは${focusLabel}ニュースの編集者です。以下の一覧から、`
        + '日本の株式市場・為替・金利、または世界のマーケット全体に大きな影響を与えると'
        + `考えられる項目だけを、重要な順に最大${max}件選んでください。個別企業の話題で`
        + 'あっても、市場全体を動かすほどの規模・話題性が無ければ選ばないこと。該当する'
        + `項目が${max}件に満たない場合は、無理に${max}件へ埋めず少ない件数で構いません。`
        + '内容の書き換えは一切せず、選んだ項目のインデックス番号だけを返してください。\n'
        + '出力は次の形式のJSON配列のみとし、説明文や前置きは一切含めないでください。\n'
        + `[0, 3, 5]（重要な順、最大${max}件）`,
      prompt: JSON.stringify(payload),
      temperature: 0,
      json: true,
      agentKey: 'secretary',
      activitySessionId,
      logMeta: { purpose: 'daily_report_news_select' },
    });
    const indices = JSON.parse(text);
    if (!Array.isArray(indices) || indices.length === 0) return fallback;
    const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < items.length).slice(0, max);
    return valid.length > 0 ? valid : fallback;
  } catch (e) {
    getLogger().warn(`[DailyNote] ${focusLabel}ニュースの重要度選別に失敗（先頭${max}件をそのまま採用）: ${e.message}`);
    return fallback;
  }
}

/**
 * 海外のマーケットニュースの見出しと要約を日本語にする（数字と固有名詞は変えさせない）。
 * 訳せなければ元のまま返す（ノートに載らないより、英語でも載る方がよい）。
 * @param {Array<any>} items ニュース（title・desc）
 * @param {{apiKey?: string, activitySessionId?: any}} opts
 * @returns {Promise<Array<any>>} 訳したニュース
 */
async function _translateGlobalNewsItems(items, { apiKey, activitySessionId = null }) {
  if (!items || items.length === 0 || !apiKey) return items || [];
  try {
    const payload = items.map((it, i) => ({ i, title: it.title, desc: it.desc || '' }));
    const { text: text } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: 'あなたは経済ニュースの翻訳者です。英語の見出しと要約を、日本の読者向けの'
        + '自然な日本語へ訳してください。\n'
        + '【最重要】数値・日付・企業名・人名・指標名（CPI、FRB、FOMC等）は一切変更・創作しないこと。'
        + '原文に無い情報を足さないこと。意訳しすぎず、事実関係を保つこと。\n'
        + '見出しは簡潔に、要約は1〜2文に収めてください。原文に要約が無い項目はdescを空文字にしてください。\n'
        + '出力は次の形式のJSON配列のみとし、説明文や前置きは一切含めないでください。\n'
        + '[{"i": 0, "title": "日本語の見出し", "desc": "日本語の要約"}]',
      prompt: JSON.stringify(payload),
      temperature: 0,
      json: true,
      agentKey: 'secretary',
      activitySessionId,
      logMeta: { purpose: 'global_news_translate' },
    });
    const translated = JSON.parse(text);
    if (!Array.isArray(translated)) return items;
    const byIndex = new Map(translated.map(t => [Number(t.i), t]));
    return items.map((it, i) => {
      const t = byIndex.get(i);
      return t && t.title ? { ...it, title: String(t.title), desc: t.desc ? String(t.desc) : '' } : it;
    });
  } catch (e) {
    getLogger().warn(`[DailyNote] 海外ニュースの翻訳に失敗（原文のまま掲載）: ${e.message}`);
    return items;
  }
}

/**
 * 週次ノート用に、海外の AI・テクノロジーのニュースを集める（取得は news-service.js に任せる）。
 * ATTENTION: 直近1週間に絞ること。技術のメディアは、特集など日付の古い記事も上位に残る。
 * @param {{perFeed?: number}} [opts] 配信元ごとに取る件数
 * @returns {Promise<Array<any>>} ニュース
 */
async function _fetchWeeklyTechNewsPool({ perFeed = 15 } = {}) {
  return newsService.fetchGlobalNews({ category: 'tech', perFeed, maxAgeHours: 7 * 24 });
}

/**
 * 集めた AI・テクノロジーのニュースから、伝える価値の高いものを数件だけ選ばせ、日本語にして箇条書きにする。
 * 選ぶのと訳すのを1回の呼び出しでまとめて行う（先に全部訳すと無駄になるため）。
 * ATTENTION: 一覧に無い話題を作らせないこと。URL は選んだ元の記事のものをそのまま使わせる。
 * @param {{apiKey?: string, activitySessionId?: any}} opts
 * @returns {Promise<string>} 週次ノートに書く文
 */
async function _selectWeeklyTechNewsHighlights({ apiKey, activitySessionId = null }) {
  const pool = await _fetchWeeklyTechNewsPool().catch((e) => {
    getLogger().warn(`[Secretary] AI・テクノロジーニュースの取得に失敗: ${e.message}`);
    return [];
  });
  if (pool.length === 0) return '今週はAI・テクノロジー関連のニュースを取得できませんでした。';
  if (!apiKey) return '今週のAI・テクノロジーニュースは取得できましたが、選定にはGemini APIキーが必要です。';

  const listText = pool.map((it, i) => `${i + 1}. [${it.source}] ${it.title}`
    + `${it.desc ? `\n   概要: ${it.desc}` : ''}${it.link ? `\n   URL: ${it.link}` : ''}`).join('\n');

  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: 'あなたはAI・テクノロジー分野専門の週刊ニュースダイジェストの編集者です。'
        + '渡される英語の記事一覧（海外の技術専門メディア由来、重複含む）から、リスナーが1週間の'
        + 'AI・テクノロジー業界の動きを把握する上で特に重要な話題だけを3〜4件選んでください。\n'
        + '・同じ話題が複数の見出しで重複している場合は1件にまとめてください\n'
        + '・見出し・要約は日本語へ翻訳してください。数値・日付・企業名・製品名・人名は'
        + '変更・創作しないでください\n'
        + '・URLは選んだ元の記事のものをそのまま使い、改変・創作しないでください（無ければ空文字）\n'
        + '・summaryは1文程度で、何が起きたか・なぜ重要かが分かる簡潔な説明にしてください\n'
        + '・一覧に無い話題を創作しないでください\n'
        + '・技術的に些末なアップデートより、業界へのインパクトが大きい話題を優先してください',
      prompt: `【今週のAI・テクノロジー関連記事一覧（${pool.length}件）】\n${listText}`,
      temperature: 0.3,
      schema: {
          type: 'object',
          properties: {
            highlights: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  link: { type: 'string' },
                  summary: { type: 'string' },
                },
                required: ['title', 'summary'],
              },
            },
          },
          required: ['highlights'],
        },
      agentKey: 'secretary_weekly_tech_news',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] AI・テクノロジーニュース選定に失敗: ${e.message}`);
    return '今週のAI・テクノロジーニュースの選定に失敗しました。';
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[Secretary] AI・テクノロジーニュース選定結果のJSON解析に失敗: ${e.message}`);
    return '今週のAI・テクノロジーニュースの選定に失敗しました（内容の解析エラー）。';
  }
  const highlights = parsed.highlights || [];
  if (highlights.length === 0) return '今週は特に注目すべきAI・テクノロジーニュースが見当たりませんでした。';
  return highlights.map(h => {
    const headline = h.link ? `[${h.title}](${h.link})` : h.title;
    return `- ${headline}\n  - ${h.summary}`;
  }).join('\n');
}

/**
 * 資産台帳（スプレッドシート）から、長い期間の資産の推移と下げ幅のグラフを作り、週次ノートに貼る。
 *
 * 作図は秘書のヘルパーに任せる。会話から「グラフを作って」と頼んだときと同じ経路を通るので、
 * 計算の仕方と数値の確かさ（コード実行）が1か所にまとまる。
 *
 * ATTENTION: ヘルパーは、読み込みのときではなく呼び出すときに読み込むこと。このファイル → ヘルパー →
 * 秘書の道具 → このファイル、と一周するため。
 * ATTENTION: このジョブにツールは渡さない。渡すには全部のツールの一覧が要り、それを読み込むとまた
 * 一周してしまう。コード実行とスプレッドシートの取得だけで足りる。
 *
 * @param {{config: any, creds: any, obs: any, weekStart: string, activitySessionId?: any}} args
 * @returns {Promise<string|null>} 週次ノートに書く文（台帳の URL が無い・失敗したら null）
 */
async function _buildAssetLedgerSection({ config, creds, obs, weekStart, activitySessionId = null }) {
  const sheetUrl = (obs.asset_ledger_sheet_url || '').trim();
  if (!sheetUrl) return null; // 管理画面で未設定なら、このセクション自体を作らない

  // 呼び出すときに読み込む（上の ATTENTION 参照）
  const helperAgent = require('./secretary-helper-agent');
  const jobStore = require('./secretary-job-store');

  const request = `次のGoogleスプレッドシートは、週次の時価評価額を記録した資産台帳です。\n${sheetUrl}\n\n`
    + 'このデータから、PayPay銀行(NISA)と楽天証券それぞれについて、直近1年分の\n'
    + '(1) 時価評価額の推移\n'
    + '(2) ドローダウン（直近高値からの下落率、%）\n'
    + 'を、上下2段のサブプロットにまとめた**1枚**のグラフとして描いてください。'
    + '2口座は色分けし、凡例を付けてください。\n'
    + 'あわせて、各口座の「直近1年の最大ドローダウンの値と発生時期」「1年前と現在の時価評価額」'
    + '「その増減率」を報告してください。';

  const job = jobStore.createJob({ request, origin: 'weekly-report' });
  const _t0 = Date.now();
  const res = await helperAgent.runHelperJob({
    jobId: job.id, request, config, creds,
    // ツールは渡さない（上の ATTENTION 参照）
    liveTools: [],
  });
  const done = jobStore.getJob(job.id);
  if (!done || done.status !== 'done') {
    getLogger().warn(`[Secretary] 週次の資産台帳セクションの作成に失敗: ${done?.error || res?.error || '原因不明'}`);
    return null;
  }
  getLogger().info(`[Secretary] 週次の資産台帳セクションを作成（${Math.round((Date.now() - _t0) / 1000)}秒）`);

  const parts = [];
  // 本文にヘルパーの作業環境のファイル名が画像として書かれていると、必ずリンク切れになるので取り除く
  // （画像は下で保存する1枚だけを貼る）
  const body = done.resultText ? helperAgent.stripSandboxImageEmbeds(done.resultText) : '';
  if (body) parts.push(body);
  // ATTENTION: ファイル名には日付を入れること。固定の名前にすると、後の週の実行で上書きされ、過去の
  // ノートを開いたときにも最新の図に差し替わってしまう
  if (done.resultImage) {
    const rel = `08_assets/weekly-asset/${weekStart}-asset-drawdown.png`;
    try {
      obsidianService.writeBinaryAsset(obs.vault_path, rel, Buffer.from(done.resultImage, 'base64'));
      parts.push(`![[${rel}]]`);
    } catch (e) {
      getLogger().warn(`[Secretary] 資産グラフ画像の保存に失敗（本文のみ記録します）: ${e.message}`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * 保有している銘柄のヒートマップ（広さが評価額、色が前の週からの増減）を描いて週次ノートに貼る。
 * 上の推移のグラフが長い期間を見るのに対し、こちらは今週1週間で何が動いたかを1枚で見るためのもの。
 *
 * BUGFIX: 図はコード（secretary-tools-finance.js）で描くこと。ヘルパーに描かせていたころ、頼むたびに
 * 違う形の図になっていた。会話から頼んだときと同じ関数を使うので、体裁もそろう。
 *
 * @param {{config: any, creds: any, obs: any, weekStart: string, activitySessionId?: any}} args
 * @returns {Promise<string|null>} 週次ノートに書く文（前の週のデータが無い・失敗したら null）
 */
async function _buildHoldingsHeatmapSection({ config, creds, obs, weekStart, activitySessionId = null }) {
  const { buildHoldingsHeatmapSvg } = require('./secretary-tools-finance');
  const built = buildHoldingsHeatmapSvg({});
  if (!built) {
    getLogger().info('[Secretary] 資産ヒートマップ: 資産レポートが無いか前週と比較できないため今週は作成しません。');
    return null;
  }
  const rel = `08_assets/holdings-heatmap/${weekStart}.svg`;
  try {
    obsidianService.writeBinaryAsset(obs.vault_path, rel, Buffer.from(built.svg, 'utf8'));
  } catch (e) {
    getLogger().warn(`[Secretary] 資産ヒートマップの保存に失敗: ${e.message}`);
    return null;
  }
  getLogger().info(`[Secretary] 資産ヒートマップを作成（${built.rows.length}銘柄）`);

  // 動きの大きかった銘柄の一言（LLM は使わず、事実だけをコードで書く）。
  // BUGFIX: 前の週と比べられた銘柄だけを対象にすること。今週から持ち始めた銘柄が混ざると、比較の値が
  // 無いところで週次ノートの作成ごと止まる
  const sorted = [...built.rows].filter((r) => r._wowPct != null).sort((a, b) => b._wowPct - a._wowPct);
  const fmt = (r) => `${r.fund}（${r._wowPct >= 0 ? '+' : ''}${r._wowPct.toFixed(2)}%）`;
  const ups = sorted.filter((r) => r._wowPct > 0).slice(0, 3);
  const downs = sorted.filter((r) => r._wowPct < 0).slice(-3).reverse();

  const parts = [`![[${rel}]]`, `（${built.subtitle}）`];
  if (ups.length > 0) parts.push(`上げた銘柄: ${ups.map(fmt).join('、')}`);
  if (downs.length > 0) parts.push(`下げた銘柄: ${downs.map(fmt).join('、')}`);
  return parts.join('\n\n');
}

/**
 * 天気と金融の生のテキストを、ノートに貼りやすい形（金融は表）に整える。
 * ATTENTION: 数値・日時・地名・銘柄名を書き換えさせないこと。整えるだけにさせる。
 * 失敗したら、元のテキスト（最低限の整形だけ）にする。
 * @param {{weatherText?: string, financeText?: string, apiKey?: string, activitySessionId?: any}} args
 * @returns {Promise<{weather: any, finance: any}>} 整えた文
 */
async function _formatDailyReportSectionsWithGemini({ weatherText, financeText, apiKey, activitySessionId = null }) {
  const fallback = {
    weather: weatherText,
    finance: financeText ? formatFinanceForDailyNote(financeText) : financeText,
  };
  if (!apiKey) return fallback;

  const sections = [];
  if (weatherText) sections.push(`【天気】\n${weatherText}`);
  if (financeText) sections.push(`【金融情報】\n${financeText}`);
  if (sections.length === 0) return fallback;

  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、天気・金融情報の生データをObsidianノートに'
        + '貼りやすいMarkdown形式へ整形するアシスタントです。'
        + '【最重要】数値・日時・地名・銘柄名などのデータは一切変更・省略・創作せず、元のテキストに'
        + '書かれている内容だけを整形してください。あなた自身の判断でコメントや解説を追加しないこと。\n'
        + '・weather: 渡された内容をそのままの文章で整形してください（改行や体裁を整える'
        + '程度にとどめ、内容を要約・省略・創作しないこと）。元テキストに無いセクションは'
        + '出力しないこと。\n'
        + '  （地震情報・台風情報・時間帯別の天気予報・気象庁の公式予報は別処理で確実に'
        + '整形されるため、あなたには渡されません）\n'
        + '・finance: 「■」区切りの各グループ（国内株式・為替等）ごとに、元が箇条書きであっても'
        + '必ずMarkdownテーブルへ変換してください（列: 銘柄名・現在値・前日終値・前日比）\n'
        + '入力に無いセクション（例: 金融情報が渡されていない場合）は、出力側では該当フィールドを'
        + '空文字にしてください。',
      prompt: sections.join('\n\n'),
      temperature: 0,
      schema: {
        type: 'object',
        properties: {
          weather: { type: 'string' },
          finance: { type: 'string' },
        },
        required: ['weather', 'finance'],
        },
      agentKey: 'secretary_daily_report_format',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] 日報の整形に失敗（元の形式のまま記録します）: ${e.message}`);
    return fallback;
  }
  // ATTENTION: JSON を作らせる呼び出しなので、思考の漏れを落とす処理は使わない（agent-shared-mixin.js 参照）
  try {
    const parsed = JSON.parse(rawText);
    return {
      weather: weatherText ? (parsed.weather || fallback.weather) : null,
      finance: financeText ? (parsed.finance || fallback.finance) : null,
    };
  } catch (e) {
    getLogger().warn(`[Secretary] 日報整形結果のJSON解析に失敗（元の形式のまま記録します）: ${e.message}`);
    return fallback;
  }
}

/**
 * 昨日の日付を YYYY-MM-DD で返す。
 * @returns {string} 昨日の日付
 */
function _yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 昨日の気温の欄を、前日に記録しておいた実測だけで組み立てる。
 *
 * ATTENTION: 予報は混ぜないこと。終わった日なので実測がそろっており、混ぜると記録としての意味が薄れる。
 * 記録が無い日（前日にサーバーが動いていなかった等）は何も作らない。
 *
 * @returns {string|null} 昨日の気温の Markdown（記録が無ければ null）
 */
function _buildYesterdayTempSection() {
  const points = secretaryStore.readEntriesForDate('weather-history', _yesterdayStr())
    .slice()
    .sort((a, b) => a.bucketHour - b.bucketHour)
    .map((e) => ({ label: `${e.bucketHour}時`, temp: e.temp }));
  if (points.length === 0) return null;
  const temps = points.map((p) => p.temp);
  const summaryLine = `最高 ${Math.max(...temps)}℃・最低 ${Math.min(...temps)}℃`;
  const chart = _buildTempLineChart('昨日の気温推移', points);
  return chart
    ? `### 昨日の気温\n${summaryLine}\n\n${chart}`
    : `### 昨日の気温\n${summaryLine}`;
}

/**
 * 今日の予定（カレンダーの予定と、残っている ToDo）の欄を組み立てる。
 *
 * ATTENTION: 予定と ToDo は事実なので、LLM に通さずここで決定的に組み立てること。日時・件名を
 * 書き換えられると予定表として使えない。
 *
 * 連携していない・取得に失敗した場合は null を返し、欄ごと省く（「予定はありません」と
 * 書いてしまうと、本当に予定が無い日と区別が付かない）。
 *
 * @param {Record<string, any>} creds 認証情報
 * @returns {Promise<string|null>} 今日の予定の Markdown（作れなければ null）
 */
async function _buildTodayScheduleSection(creds) {
  if (!creds?.google?.refresh_token) return null;

  const todayIso = obsidianService.todayStr();
  const [evRes, taskRes] = await Promise.allSettled([
    googleService.fetchCalendar(creds, { rangeDays: 1, fromDate: todayIso, maxResults: 20 }),
    googleService.fetchTasks(creds, { maxResults: 20 }),
  ]);
  if (evRes.status === 'rejected' && taskRes.status === 'rejected') {
    getLogger().warn('[Secretary] 今日の予定を取得できませんでした（欄ごと省きます）');
    return null;
  }

  const events = evRes.status === 'fulfilled' ? (evRes.value || []) : [];
  const tasks = taskRes.status === 'fulfilled' ? (taskRes.value || []) : [];

  const lines = [];
  if (events.length > 0) {
    lines.push('### 予定');
    for (const e of events) {
      const when = e.timeStr ? `**${e.timeStr}**` : '**終日**';
      const where = e.location ? `（${e.location}）` : '';
      lines.push(`- ${when} ${e.summary}${where}`);
    }
  } else if (evRes.status === 'fulfilled') {
    lines.push('### 予定', '- 本日の予定はありません');
  }

  if (tasks.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('### 残っている ToDo');
    for (const t of tasks) {
      lines.push(`- [ ] ${t.title}${t.due ? `（期限: ${t.due}）` : ''}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * その日のデイリーノートに、天気・ニュース・金融のレポートを書く。会話から頼まれたときと、
 * 秘書のループが毎朝行うときの両方から呼ばれる。
 *
 * ATTENTION: 朝に読むノートとして組み立てること。天気は「今日の予報」が主役で、昨日は記録として
 * 後ろに置く。1日の終わりにまとめていたころとは日付が1つずれているので、取り違えないこと。
 *
 * 天気・ニュース・金融・天気図・衛星画像はそれぞれ独立に取り、1つ失敗しても他は書く。
 * 地震・台風・時間帯別の予報・ニュースの一覧はコードで組み立て、LLM には体裁を整えることと、
 * 各センターに概況を書かせることだけを任せる。
 *
 * @param {{config: any, creds: any, activitySessionId?: any}} args
 * @returns {Promise<Record<string, any>>} 結果の文（何も取れなければその旨）
 */
async function createDailyReport({ config, creds, activitySessionId = null }) {
  const { obs, error: _obsErr } = _requireObsidian(config);
  if (_obsErr) return _obsErr;
  const profile = config.show?.user_profile || {};
  // BUGFIX: 放送と同じ判定で場所を決める。決め打ちにしていたころ、旅行などの間は放送が滞在先の天気を
  // 伝えるのに、ノートには自宅の天気が書かれ、話が食い違っていた
  const { location: effectiveLocation, isTempStay: isTempStayNow } = getEffectiveLocationFromConfig(config);
  const relPath = obsidianService.dailyNoteRelPath(obs.daily_notes_folder);

  // どれも独立に失敗してよい（1つ取れなくても、ほかは書く）。ニュースは件数を増やさず、代わりに
  // 各記事のページから実際の要約を補う（題名だけでは中身が分からないため）。
  // ここで使うサービスは放送のものとは別なので、ここを変えても放送には影響しない
  const [weatherTextRaw, newsText, financeText, weatherChartImg, satelliteImg] = await Promise.all([
    weatherService.fetch({
      overrideLocation: null,
      defaultLocation: effectiveLocation,
      isTempStay: isTempStayNow,
      apiKey: creds.openweathermap?.api_key,
      prefCode: profile.pref_code || '130000',
    }).catch(() => null),
    // BUGFIX: 要約の長さに上限を付けない。付けていたころ、ノートの詳細が途中で切れていた
    newsService.fetch({ maxDescLength: Infinity, fetchArticleDescriptions: true }).catch(() => null),
    // 海外のニュースはノート専用（放送の金融コーナーには影響しない）
    financeService.fetch(config, { fetchArticleDescriptions: true, includeGlobalNews: true }).catch(() => null),
    // ノートには「その朝の最新」を載せたいので、キャッシュを使わず取り直す
    fetchWeatherChartBuffer({ forceRefresh: true }).catch(() => null),
    fetchSatelliteImageBuffer().catch(() => null),
  ]);
  // 今日の予定（カレンダー・ToDo）。天気などと同じく、取れなくてもノートの他の欄は書く
  const todayScheduleMd = await _buildTodayScheduleSection(creds).catch(() => null);
  // 取得の直後なので、リンク付きの完全な形で取り出せる
  const newsItems = newsService.cache?.detailedItems || [];
  // 経済のニュースは、先頭から何件かではなく、市場に大きく関わるものを選ばせて絞る
  const MAX_DAILY_NEWS_PER_SIDE = 3;
  const businessNewsPool = financeService.cache?.businessNewsItems || [];
  const globalNewsPool = financeService.cache?.globalNewsItems || [];
  const [businessNewsIdx, globalNewsIdx] = await Promise.all([
    _selectImportantNewsIndices(businessNewsPool, {
      max: MAX_DAILY_NEWS_PER_SIDE, apiKey: creds.gemini?.api_key, activitySessionId, focusLabel: '国内経済',
    }),
    _selectImportantNewsIndices(globalNewsPool, {
      max: MAX_DAILY_NEWS_PER_SIDE, apiKey: creds.gemini?.api_key, activitySessionId, focusLabel: '海外市場',
    }),
  ]);
  const businessNewsItems = businessNewsIdx.map((i) => businessNewsPool[i]);
  const globalNewsItems = globalNewsIdx.map((i) => globalNewsPool[i]);

  // ATTENTION: 地震・台風・時間帯別の予報はコードで表や箇条書きにし、LLM には渡さない。渡すと中身が
  // 書き換わる（台風では日本への影響・進む向き・警戒の要否が失われていた）。気温のグラフを作るのにも、
  // 整った形のデータが要る。
  // 朝に読むノートなので、今まさに出ている警報は取り除かず、冒頭のコールアウトとして置く
  const { quakeTable, remainingText: afterQuake } = _extractQuakeSectionDeterministic(weatherTextRaw);
  const { typhoonMd, remainingText: afterTyphoon } = _extractTyphoonSectionDeterministic(afterQuake);
  const { warningMd, remainingText: afterWarning } = _extractWeatherWarningSection(afterTyphoon);
  // ATTENTION: 朝のノートなので、時間帯別のグラフは「今日」を主役にすること。1日の終わりに作って
  // いたころは「明日」が主役で、今日は実測のふり返りだった。日付が1つずれるので取り違えないこと。
  // 明日の詳細は載せない（朝に要るのは今日の動きで、明日まで並べると読む量が倍になる）。
  const { rows: todayForecastRows, remainingText: afterTodayFc } = _extractForecastRowsDeterministic(
    afterWarning, '【今日の残り時間帯の予報');
  const { remainingText: afterTomorrowDetail } = _extractForecastSectionDeterministic(
    afterTodayFc, '【明日（', { chartTitle: '明日の気温推移' });
  // 気象庁の予報文は今日だけを使う（明日の分は上と同じ理由で載せない）
  const { todayMd: todayOfficialMd, remainingText: initialWeatherTextForLLM } =
    _extractOfficialForecastSectionDeterministic(afterTomorrowDetail);
  let weatherTextForLLM = initialWeatherTextForLLM;

  // 今日の気温＝今朝までの実測（2時間おき）＋この先の予報（3時間おき）。境目で間隔が変わるのは承知のうえ
  const actualTodayPoints = secretaryStore.readTodayEntries('weather-history')
    .slice()
    .sort((a, b) => a.bucketHour - b.bucketHour)
    .map((e) => ({ label: `${e.bucketHour}時`, temp: e.temp }));
  const forecastTodayPoints = todayForecastRows.map((r) => ({ label: `${r.hour}時`, temp: r.temp }));
  const combinedTodayPoints = [...actualTodayPoints, ...forecastTodayPoints];
  // BUGFIX: 今日の最高・最低は、記録しておいた実測も含めて計算し直す。予報だけから出していたころ、
  // 「今日の残り」がほとんど無い時間帯に作ると、最高と最低が同じ値になっていた
  const currentTempMatch = weatherTextForLLM.match(/気温 (-?\d+)℃（本日最高/);
  const allTodayTemps = combinedTodayPoints.map((p) => p.temp);
  if (currentTempMatch) allTodayTemps.push(parseInt(currentTempMatch[1], 10));
  let todayTempMd = null;
  if (allTodayTemps.length > 0) {
    const todayMax = Math.max(...allTodayTemps);
    const todayMin = Math.min(...allTodayTemps);
    weatherTextForLLM = weatherTextForLLM.replace(
      /（本日最高 -?\d+℃・本日最低 -?\d+℃）/,
      `（本日最高 ${todayMax}℃・本日最低 ${todayMin}℃）`,
    );
    const summaryLine = `最高 ${todayMax}℃・最低 ${todayMin}℃`;
    const chart = _buildTempLineChart('今日の気温推移', combinedTodayPoints);
    todayTempMd = chart
      ? `### 今日の気温\n${summaryLine}\n\n${chart}`
      : `### 今日の気温\n${summaryLine}`;
  }

  // 昨日の気温は、前日に記録しておいた実測だけで作る（予報は混ぜない。終わった日なので実測がそろっている）
  const yesterdayTempMd = _buildYesterdayTempSection();

  // 「現在のお天気」は、最高・最低を計算し終えたこの時点で取り除く（一瞬の値でしかなく、
  // 上の予報とグラフがあれば足りる）
  weatherTextForLLM = _stripCurrentWeatherLine(weatherTextForLLM);

  // ATTENTION: 天気図と衛星画像のファイル名には日付を入れること。固定の名前にすると、後日の実行で
  // 上書きされ、過去の日のノートまで最新の画像に差し替わる
  const assetDateStr = obsidianService.todayStr();
  const weatherImageLines = [];
  if (weatherChartImg) {
    const rel = `08_assets/daily-weather/${assetDateStr}-weathermap.png`;
    obsidianService.writeBinaryAsset(obs.vault_path, rel, weatherChartImg.buf);
    weatherImageLines.push(`### 天気図（${weatherChartImg.label}）\n![[${rel}]]`);
  }
  if (satelliteImg) {
    const rel = `08_assets/daily-weather/${assetDateStr}-satellite.webp`;
    obsidianService.writeBinaryAsset(obs.vault_path, rel, satelliteImg.buf);
    weatherImageLines.push(`### 衛星画像（${satelliteImg.label}）\n![[${rel}]]`);
  }
  const weatherImagesMd = weatherImageLines.length > 0 ? weatherImageLines.join('\n\n') : null;

  // 経済のニュースも、リンクを書き換えられないようコードで組み立てる。国債の利回りはノートには
  // 要らないので、渡す前に取り除く（放送はこれまでどおり）
  const financeTextForLLM = _stripJgbSection(_extractBusinessNewsSectionFromFinanceText(financeText));
  const businessNewsMd = _buildBusinessNewsMarkdown(businessNewsItems, '### 経済・マーケットニュース（国内）');
  const translatedGlobalNewsItems = await _translateGlobalNewsItems(
    globalNewsItems, { apiKey: creds.gemini?.api_key, activitySessionId });
  const globalNewsMd = _buildBusinessNewsMarkdown(
    translatedGlobalNewsItems, '### 世界市場のニュース（米国の経済指標・FRB・海外市場）');

  // 気象・報道・金融の3つのセンターに、それぞれ概況を書かせる（互いに関係しないので、表の整形と
  // 合わせて並行して行う）
  const weatherOverviewMaterial = [warningMd, typhoonMd, todayOfficialMd, todayTempMd].filter(Boolean).join('\n\n');
  const newsOverviewMaterial = newsItems.map((it) => `- ${it.title}${it.desc ? `（${it.desc}）` : ''}`).join('\n');
  // 持っている銘柄は、割合だけでなく金額に直した目安も渡す（personal-holdings-value.js）。
  // ドル建ての銘柄は為替の動きも効くので、本日のドル円を一緒に渡す
  /** @type {any[]} */
  const _structured = financeService.cache?.structured || [];
  const _usdJpyRow = _structured.find((r) => r.type === 'fx' && /ドル\s*\/\s*円/.test(r.key || ''));
  const personalHoldingsChanges = estimatePersonalHoldingsDailyChange(
    config, _structured.filter((r) => r.type === 'personal'),
    { usdJpyPct: _usdJpyRow?.pct || 0 }
  );
  const personalHoldingsBlock = formatPersonalHoldingsChangeForPrompt(personalHoldingsChanges);
  const financeOverviewMaterial = [
    financeTextForLLM,
    businessNewsItems.length > 0 ? `国内ニュース:\n${businessNewsItems.map((it) => `- ${it.title}`).join('\n')}` : '',
    translatedGlobalNewsItems.length > 0
      ? `海外ニュース:\n${translatedGlobalNewsItems.map((it) => `- ${it.title}${it.desc ? `（${it.desc}）` : ''}`).join('\n')}` : '',
    personalHoldingsBlock,
  ].filter(Boolean).join('\n\n');

  const [formatted, weatherOverview, newsOverview, financeOverview] = await Promise.all([
    _formatDailyReportSectionsWithGemini({
      weatherText: weatherTextForLLM, financeText: financeTextForLLM, apiKey: creds.gemini?.api_key, activitySessionId,
    }),
    buildCenterOverview({
      agentKey: 'weather', defaultName: '気象情報センター', config, apiKey: creds.gemini?.api_key, activitySessionId,
      materialText: weatherOverviewMaterial,
      focusInstruction: '【今回書くこと】天気概況として、明日以降の天気に関する解説を必ず含めてください'
        + '（台風の動向があれば、それが明日以降にどう影響しうるかも踏まえること）。',
    }),
    buildCenterOverview({
      agentKey: 'news', defaultName: '報道センター', config, apiKey: creds.gemini?.api_key, activitySessionId,
      materialText: newsOverviewMaterial,
      focusInstruction: '【今回書くこと】以下の主なニュース一覧を取りまとめ、今日はどんな1日だったかが'
        + '伝わるように概況を伝えてください。',
    }),
    buildCenterOverview({
      agentKey: 'finance', defaultName: '金融情報センター', config, apiKey: creds.gemini?.api_key, activitySessionId,
      materialText: financeOverviewMaterial,
      focusInstruction: '【市場の開閉】材料の冒頭に東京市場・米国市場それぞれの開閉状況が'
        + '事実として書かれています。休場だった市場について「本日の終値は」と書くことは絶対に'
        + '避け、「〇月〇日（〇曜日）の終値」のように具体的な日付を添えてください。'
        + '休場だった市場があれば、その旨を一言添えてください。\n'
        + '【今回書くこと】今日のマーケットで起きたことを取りまとめ、材料のニュースに'
        + '具体的な言及があれば明日以降の注目点にも触れてください（材料に無い独自の予測は'
        + '作らないこと）。「■ 個人所有ファンド・株式」がある場合は、リスナー本人が実際に'
        + '保有している資産なので必ず一言以上触れてください。前日比が大きい銘柄（投資信託は1%、'
        + '株式・ETFは3%程度が目安）を中心に、一般的な相場紹介とは分けて「ご自身の保有資産では'
        + '〇〇が+△%でした」のように書いてください。目立った動きが無ければ一言で構いません。'
        + '「■ 個人所有ファンド・株式の金額換算」がある場合は、記載の概算金額をそのまま使い'
        + '「評価額としてはおよそ+◯万円に相当します（直近の資産スナップショットをもとにした'
        + '概算です）」のように金額換算も添えてください（自分で計算し直さないこと。記載の無い'
        + '銘柄について金額を推測しないこと）。',
    }),
  ]);
  // おすすめレシピは、今日の予定と天気を材料に生活アドバイザーへ書かせる（概況と同じ仕組み）。
  // ATTENTION: 名前・口調は設定（config.agents.life_advisor）から取ること。ここに直書きしない。
  const _laName = config.agents?.life_advisor?.name || '生活アドバイザー';
  const recipeMaterial = [
    todayOfficialMd ? `【今日の天気】\n${todayOfficialMd}` : '',
    todayTempMd ? `【今日の気温】\n${todayTempMd}` : '',
    todayScheduleMd ? `【今日の予定】\n${todayScheduleMd}` : '',
  ].filter(Boolean).join('\n\n');
  const recipeText = await buildCenterOverview({
    agentKey: 'life_advisor', defaultName: '生活アドバイザー', config,
    apiKey: creds.gemini?.api_key, activitySessionId,
    materialText: recipeMaterial || '（今日の天気・予定は取得できませんでした）',
    focusInstruction: '【今回書くこと】今日のおすすめの料理を**1品だけ**提案してください。'
      + '材料の天気（暑さ寒さ・雨）と予定（外出や帰りの遅さ）に触れ、「だからこれ」と'
      + 'つながる形で勧めてください。\n'
      + '次の形で書いてください（見出しは付けない）:\n'
      + '1行目に **料理名** を太字で。\n'
      + '続けて、なぜ今日それを勧めるのかを1〜2文で。\n'
      + 'そのあと **材料** と **作り方** を、それぞれ太字の見出し行にして、続けて Markdown の\n'
      + '箇条書き（- で始まる行）で簡潔に。\n'
      + '材料は2人分の目安にし、作り方は3〜5手順にまとめてください。\n'
      + '凝った食材は避け、手に入りやすいもので作れる献立にしてください。',
  });
  const recipeMd = recipeText ? `### 🍳 ${_laName}のおすすめ\n${recipeText}` : null;

  const weatherOverviewMd = weatherOverview
    ? `### 🌦️ ${config.agents?.weather?.name || '気象情報センター'}による天気概況\n${weatherOverview}` : null;
  const newsOverviewMd = newsOverview
    ? `### 📰 ${config.agents?.news?.name || '報道センター'}によるニュースまとめ\n${newsOverview}` : null;
  const financeOverviewMd = financeOverview
    ? `### 💰 ${config.agents?.finance?.name || '金融情報センター'}による本日の総括\n${financeOverview}` : null;

  // ATTENTION: 並び順は「今すぐ効くもの → 今日 → 昨日」。朝に読むノートなので、まず警報・地震・台風を
  // 置き、次に今日の話（予報文と気温）、最後に昨日の記録を置く。今日と昨日を交互にすると、
  // 話を行ったり来たりすることになる
  const weatherParts = [
    warningMd, quakeTable, typhoonMd, weatherOverviewMd, formatted.weather,
    todayOfficialMd, todayTempMd, weatherImagesMd, yesterdayTempMd,
  ].filter(Boolean);
  formatted.weather = weatherParts.length > 0 ? weatherParts.join('\n\n') : null;
  const financeParts = [financeOverviewMd, formatted.finance, globalNewsMd, businessNewsMd].filter(Boolean);
  formatted.finance = financeParts.length > 0 ? financeParts.join('\n\n') : null;

  const filled = [];
  // 天気の文が取れなくても画像だけは取れていることがあるので、画像の有無も見る
  if (weatherTextRaw || weatherImagesMd) {
    obsidianService.setSectionContent(obs.vault_path, relPath, '🌤️ 天気', formatted.weather || weatherTextRaw || weatherImagesMd, { templateRelativePath: obs.daily_note_template });
    filled.push('天気');
  }
  // ATTENTION: 見出しはテンプレート（obsidian.daily_note_template）にあるものと一字一句そろえること。
  // 無い見出しへ書くと、タグ行より後ろ（ノートの末尾）に付いてしまう。
  if (todayScheduleMd) {
    obsidianService.setSectionContent(obs.vault_path, relPath, '📅 本日の予定', todayScheduleMd, { templateRelativePath: obs.daily_note_template });
    filled.push('本日の予定');
  }
  if (recipeMd) {
    obsidianService.setSectionContent(obs.vault_path, relPath, '🍳 本日のおすすめレシピ', recipeMd, { templateRelativePath: obs.daily_note_template });
    filled.push('おすすめレシピ');
  }
  if (newsText) {
    const newsBody = [newsOverviewMd, _buildNewsMarkdown(newsItems) || formatNewsForDailyNote(newsText)]
      .filter(Boolean).join('\n\n');
    obsidianService.setSectionContent(obs.vault_path, relPath, '📰 主なニュース', newsBody, { templateRelativePath: obs.daily_note_template });
    filled.push('ニュース');
    // ATTENTION: ここで週次用にも残しておくこと。ニュースの配信は「今」しか取れないので、日曜の夜に
    // 1週間分を遡ることはできない
    if (newsItems.length > 0) {
      secretaryStore.appendEntry('weekly-news-log', { items: newsItems.map(i => ({ title: i.title, link: i.link, label: i.label })) });
    }
  }
  if (financeText) {
    // 保有資産の損益の表は、整形済みの金融情報の後ろに足す。数字はコードで計算済みのものを
    // そのまま置く（LLM に通すと掛け算を間違える）
    const holdingsTable = formatPersonalHoldingsTableForNote(personalHoldingsChanges, {
      usdJpy: _usdJpyRow?.price || null,
    });
    const financeBody = [formatted.finance || formatFinanceForDailyNote(financeText), holdingsTable]
      .filter(Boolean).join('\n\n');
    obsidianService.setSectionContent(obs.vault_path, relPath, '💰 金融情報', financeBody, { templateRelativePath: obs.daily_note_template });
    filled.push('金融情報');
  }

  const result = filled.length > 0
    ? `今日のデイリーノートに${filled.join('・')}のレポートを記録しました。`
    : '天気・ニュース・金融情報のいずれも取得できず、レポートを記録できませんでした。';
  secretaryStore.appendEntry('daily-briefings', { tool: 'create_daily_report', result, filled });
  return { result, filled };
}

/**
 * 秘書の記録1件を、日報の1行（時刻と内容）にする。
 * メールの確認だけは形が違う（件数を持つ）ので別に扱う。ここで整えられる分は整えておき、後で LLM に
 * 渡すログを短く正確に保つ。
 * @param {Record<string, any>} entry 記録の1件
 * @returns {string} 1行
 */
function _formatActivityEntryLine(entry) {
  const time = entry.time
    ? new Date(entry.time).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false })
    : '--:--';
  if (!entry.tool && entry.emails) {
    const c = entry.counts || {};
    return `${time} [メール確認] 高${c['高'] || 0}件・中${c['中'] || 0}件・低${c['低'] || 0}件・無視${c['無視'] || 0}件`;
  }
  const resultText = (entry.result || '').toString().slice(0, 150);
  return `${time} [${entry.tool || '不明'}] ${resultText}`;
}

/**
 * 「昨日の業務内容」「報告事項」「所感」を、今日のデイリーノートに書く。
 *
 * 秘書の記録を材料に、1回の LLM の呼び出しで3つまとめて作る（報告事項と所感は、どのみち判断と作文が要るため）。
 *
 * ATTENTION: まとめる対象は昨日。朝に読むノートなので、今日の分はまだ何も起きていない。
 * ATTENTION: 見出しの名前は、リスナーが用意したノートの雛形に合わせてあるので変えないこと。
 *
 * @param {{config: any, creds: any, activitySessionId?: any}} args
 * @returns {Promise<Record<string, any>>} 結果の文（記録が無ければ、その旨）
 */
async function createSecretaryActivityLog({ config, creds, activitySessionId = null }) {
  const { obs, error: _obsErr } = _requireObsidian(config);
  if (_obsErr) return _obsErr;
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };

  // ATTENTION: 材料は「昨日」の分。朝に読むノートなので、まとめる対象は終わった1日になる
  // （今日の分はまだ何も起きていない）。
  const _logDate = _yesterdayStr();
  const entries = [
    ...secretaryStore.readEntriesForDate('daily-briefings', _logDate),
    ...secretaryStore.readEntriesForDate('email-logs', _logDate),
  ].sort((a, b) => new Date(a.time) - new Date(b.time));

  if (entries.length === 0) {
    return { result: null, skipped: true };
  }

  const logText = entries.map(_formatActivityEntryLine).join('\n');

  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、昨日1日の業務ログから日報を作成するアシスタントです。'
        + '渡されるログは「HH:MM [ツール名] 内容」の形式で、時系列に並んでいます。'
        + 'これを元に、以下3つのフィールドをJSONで出力してください。Obsidian（Markdown）のノートに'
        + 'そのまま貼り付けて表示されるため、読みやすいMarkdown書式を積極的に使ってください。\n'
        + '・work_summary: 昨日行った業務内容を、次のヘッダーを持つMarkdownテーブルで時系列に列挙する'
        + '（テーブル以外の形式は使わないこと）。\n'
        + '| 時刻 | 種別 | 内容 |\n|---|---|---|\n'
        + '「種別」は「カレンダー確認」「メール確認」「ファイル分析」「エージェント相談」のように'
        + '短い名詞で。「内容」は1文で簡潔に（ログに無い作業を創作しないこと。似た内容が連続する'
        + '場合は1行にまとめてよい）\n'
        + '・important_reports: 特に重要な報告事項（緊急のメール・要対応の予定・注意すべき分析結果等）を'
        + 'Markdown箇条書きで、太字（**）で要点を強調しながら簡潔に。無ければ「特になし」の1文にする\n'
        + '・reflection: 秘書自身の一人称視点での所感を1〜3文で（「〜だと感じました」のような'
        + '自然な振り返り。事務的な要約の繰り返しにしないこと）\n'
        + 'ログに実際に書かれている内容だけを根拠にし、推測で具体的な数字・固有名詞を補わないこと。',
      prompt: `【昨日（${_logDate}）の業務ログ】\n${logText}`,
      temperature: 0.3,
      json: true,
      agentKey: 'secretary_activity_log',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] report_daily_activity生成に失敗: ${e.message}`);
    return { error: '昨日の業務ログの作成に失敗しました。時間をおいて再度お試しください。' };
  }
  // ATTENTION: JSON を作らせる呼び出しなので、思考の漏れを落とす処理は使わない（agent-shared-mixin.js 参照）

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[Secretary] report_daily_activityのJSON解析に失敗: ${e.message}`);
    return { error: '昨日の業務ログの作成に失敗しました（内容の解析エラー）。' };
  }

  const relPath = obsidianService.dailyNoteRelPath(obs.daily_notes_folder);
  if (parsed.work_summary) {
    obsidianService.setSectionContent(obs.vault_path, relPath, '昨日の業務内容', parsed.work_summary, { templateRelativePath: obs.daily_note_template });
  }
  if (parsed.important_reports) {
    obsidianService.setSectionContent(obs.vault_path, relPath, '報告事項', parsed.important_reports, { templateRelativePath: obs.daily_note_template });
  }
  if (parsed.reflection) {
    obsidianService.setSectionContent(obs.vault_path, relPath, '所感', parsed.reflection, { templateRelativePath: obs.daily_note_template });
  }

  const result2 = '今日の業務内容・報告事項・所感をデイリーノートに記録しました。';
  secretaryStore.appendEntry('daily-briefings', { tool: 'report_daily_activity', result: result2 });
  return { result: result2 };
}

/**
 * 1週間ぶんの記録から、その週で特に注目すべき見出しを数件だけ選ばせ、箇条書きにする。
 * 同じ話題が何日も出ていることが多いので、まとめるのも同じ呼び出しで任せる。
 * @param {{weekDates: string[], apiKey?: string, activitySessionId?: any}} args
 * @returns {Promise<string>} 週次ノートに書く文（記録が無い・キーが無いときは、その理由の文）
 */
async function _selectWeeklyNewsHighlights({ weekDates, apiKey, activitySessionId = null }) {
  const range = secretaryStore.readEntriesForDateRange('weekly-news-log', weekDates);
  const allItems = range.flatMap(r => r.entries.flatMap(e => e.items || []));
  if (allItems.length === 0) return '今週はニュースの記録がありませんでした。';
  if (!apiKey) return '今週のニュース記録はありますが、選定にはGemini APIキーが必要です。';

  // 題名がまったく同じものだけ落とす。似た話題のまとめは LLM に任せる（機械で似ていると判定すると外す）
  const seenTitles = new Set();
  const deduped = allItems.filter(it => {
    if (!it.title || seenTitles.has(it.title)) return false;
    seenTitles.add(it.title);
    return true;
  });
  const listText = deduped.map((it, i) => `${i + 1}. [${it.label || ''}] ${it.title}${it.link ? `\n   URL: ${it.link}` : ''}`).join('\n');

  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      agentKey: 'secretary',
      activitySessionId,
      logMeta: { purpose: 'weekly_news_highlights' },
      systemInstruction: 'あなたは週刊ニュースダイジェストの編集者です。渡される1週間分のニュース'
        + '見出し一覧（重複含む）から、リスナーが1週間を振り返る上で特に注目すべき話題だけを'
        + '3〜5件選んでください。\n'
        + '・同じ話題が複数日・複数の見出しで繰り返し出ている場合は1件にまとめ、continuing_daysの'
        + 'ような形では出さず単に1件として扱ってください\n'
        + '・URLは選んだ元の見出しのものをそのまま使い、改変・創作しないでください（無ければ空文字）\n'
        + '・summaryは1文程度で、なぜ注目すべきかが分かる簡潔な補足にしてください\n'
        + '・一覧に無い話題を創作しないでください',
      prompt: `【今週のニュース見出し一覧（${deduped.length}件、重複除去済み）】\n${listText}`,
      temperature: 0.3,
      schema: {
        type: 'object',
        properties: {
          highlights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                link: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['title', 'summary'],
            },
          },
        },
        required: ['highlights'],
        },
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] 週間ニュース選定に失敗: ${e.message}`);
    return '今週の主なニュースの選定に失敗しました。';
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[Secretary] 週間ニュース選定結果のJSON解析に失敗: ${e.message}`);
    return '今週の主なニュースの選定に失敗しました（内容の解析エラー）。';
  }
  const highlights = parsed.highlights || [];
  if (highlights.length === 0) return '今週は特に注目すべきニュースが見当たりませんでした。';
  return highlights.map(h => {
    const headline = h.link ? `[${h.title}](${h.link})` : h.title;
    return `- ${headline}\n  - ${h.summary}`;
  }).join('\n');
}

/**
 * 1週間ぶんの記録から、週の活動のまとめと所感を作る（日次版の週まとめ)。
 * ATTENTION: 日付の見出しを挟んでから渡すこと。時刻だけでは、日をまたいだ流れが分からない。
 * @param {{weekDates: string[], apiKey?: string, activitySessionId?: any}} args
 * @returns {Promise<Record<string, any>>} 週次ノートに書く文（記録が無ければ、その旨）
 */
async function _summarizeWeeklyActivity({ weekDates, apiKey, activitySessionId = null }) {
  const briefings = secretaryStore.readEntriesForDateRange('daily-briefings', weekDates);
  const emails = secretaryStore.readEntriesForDateRange('email-logs', weekDates);
  const byDate = new Map(weekDates.map(d => [d, []]));
  for (const { date, entries } of briefings) byDate.get(date)?.push(...entries);
  for (const { date, entries } of emails) byDate.get(date)?.push(...entries);

  const dayBlocks = weekDates
    .map(date => {
      const entries = (byDate.get(date) || []).sort((a, b) => new Date(a.time) - new Date(b.time));
      if (entries.length === 0) return null;
      const [y, m, d] = date.split('-').map(Number);
      const label = new Date(y, m - 1, d).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
      return `【${label}】\n` + entries.map(_formatActivityEntryLine).join('\n');
    })
    .filter(Boolean);

  if (dayBlocks.length === 0) return { result: null, skipped: true };
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };

  const logText = dayBlocks.join('\n\n');
  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、1週間分の業務ログから週報を作成するアシスタントです。'
        + '渡されるログは日付見出し【○月○日(曜)】ごとに、その日の「HH:MM [ツール名] 内容」が'
        + '時系列に並んでいます。これを元に、以下2つのフィールドをJSONで出力してください。'
        + 'Obsidian（Markdown）のノートにそのまま貼り付けて表示されるため、読みやすいMarkdown書式を'
        + '積極的に使ってください。\n'
        + '・weekly_summary: 1週間の活動を、次のヘッダーを持つMarkdownテーブルで日付順に列挙する'
        + '（テーブル以外の形式は使わないこと）。同じ日に似た内容が複数あればまとめてよい。\n'
        + '| 日付 | 種別 | 内容 |\n|---|---|---|\n'
        + '「種別」は「カレンダー確認」「メール確認」「ファイル分析」「エージェント相談」のように'
        + '短い名詞で。「内容」は1文で簡潔に（ログに無い作業を創作しないこと）\n'
        + '・reflection: 秘書自身の一人称視点での、1週間全体を振り返った所感を2〜4文で（日ごとの'
        + '繰り返しではなく、週を通して見えた傾向・印象に触れること）\n'
        + '【厳禁】改行を表現するのに、実際の改行文字ではなく「\\n」というバックスラッシュとエヌの'
        + '2文字をテキストとしてそのまま出力に含めないでください。\n'
        + 'ログに実際に書かれている内容だけを根拠にし、推測で具体的な数字・固有名詞を補わないこと。',
      prompt: `【今週の業務ログ】\n${logText}`,
      temperature: 0.3,
      schema: {
          type: 'object',
          properties: {
            weekly_summary: { type: 'string' },
            reflection: { type: 'string' },
          },
          required: ['weekly_summary', 'reflection'],
        },
      agentKey: 'secretary_weekly_activity_log',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] 週報生成に失敗: ${e.message}`);
    return { error: '週報の作成に失敗しました。時間をおいて再度お試しください。' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[Secretary] 週報結果のJSON解析に失敗: ${e.message}`);
    return { error: '週報の作成に失敗しました（内容の解析エラー）。' };
  }
  const markdown = [parsed.weekly_summary, parsed.reflection ? `**この1週間の所感**: ${parsed.reflection}` : null]
    .filter(Boolean).join('\n\n');
  return { result: markdown };
}

/**
 * 週次ノートを作る。今週の天気のふり返り・来週の予報・今週の主なニュース・AI とテクノロジーの話題・
 * 秘書の1週間の活動・資産のレポート・保有銘柄のヒートマップ・資産の推移を書き込む。
 * 日曜の夜に秘書のループから呼ばれる。資産の部分は secretary-tools-finance.js をそのまま使う。
 * @param {{config: any, creds: any, activitySessionId?: any}} args
 * @returns {Promise<Record<string, any>>} 結果の文
 */
async function createWeeklyReport({ config, creds, activitySessionId = null }) {
  const { obs, error: _obsErr } = _requireObsidian(config);
  if (_obsErr) return _obsErr;

  const profile = config.show?.user_profile || {};
  const weekDates = datesForWeekEndingOn(new Date());
  const [weekStart, weekEnd] = [weekDates[0], weekDates[6]];
  const weeklyNotesFolder = obs.weekly_notes_folder || '04_Weekly Notes';
  const weeklyNotePath = obsidianService.weeklyNoteRelPath(weeklyNotesFolder, weekStart);
  const writeSection = (heading, content) => obsidianService.setSectionContent(obs.vault_path, weeklyNotePath, heading, content, {
    templateRelativePath: obs.weekly_note_template,
    templateVars: { weekStart, weekEnd },
  });

  const filled = [];
  const _now = new Date();
  const _todayDateStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;

  // ── 今週の天気のふり返り（実測）と、来週の予報 ──
  // BUGFIX: 週間予報の初日は気温が空になるので、今日・明日の詳しい予報で埋める。予報文は発行した当日の
  // 段落を除いて載せる（どちらも secretary-weekly-note-formatting.js の中で処理する）
  let _pastWeekMd = null;
  try {
    const range = secretaryStore.readEntriesForDateRange('weather-history', weekDates);
    _pastWeekMd = buildPastWeekWeatherMarkdown(weekDates, range);
    writeSection('🌤️ 今週の天気の振り返り', _pastWeekMd);
    filled.push('今週の天気');
  } catch (e) {
    getLogger().warn(`[Secretary] 週次天気（過去7日）の集計に失敗: ${e.message}`);
  }

  try {
    const [rawForecast, officialDaily] = await Promise.all([
      weatherService.fetchWeeklyForecast({ prefCode: profile.pref_code || '130000' }),
      weatherService.fetchOfficialDailyForecast({ prefCode: profile.pref_code || '130000' }).catch(() => null),
    ]);
    const forecast = prepareNextWeekForecast(rawForecast, officialDaily, _todayDateStr);
    const nextWeekMd = buildNextWeekForecastMarkdown(forecast);
    const weatherOverview = await buildCenterOverview({
      agentKey: 'weather', defaultName: '気象情報センター', config, apiKey: creds.gemini?.api_key, activitySessionId,
      materialText: (_pastWeekMd ? `【今週の天気（実績）】\n${_pastWeekMd}\n\n` : '') + `【来週の天気予報】\n${nextWeekMd}`,
      focusInstruction: '【今回書くこと】今週の天気を簡潔に振り返りつつ、来週（特に週明け）の'
        + '天気の見通しを必ず解説に含めてください。',
    });
    const weatherOverviewMd = weatherOverview ? `### 🌦️ ${config.agents?.weather?.name || '気象情報センター'}による天気概況\n${weatherOverview}` : null;
    writeSection('🔮 来週の天気予報', [weatherOverviewMd, nextWeekMd].filter(Boolean).join('\n\n'));
    filled.push('来週の天気予報');
  } catch (e) {
    getLogger().warn(`[Secretary] 週次天気予報の取得に失敗: ${e.message}`);
  }

  // ── 📰 今週の主なニュース ──
  try {
    const md = await _selectWeeklyNewsHighlights({ weekDates, apiKey: creds.gemini?.api_key, activitySessionId });
    // 見出しが実際に選ばれたとき（箇条書きになっているとき）だけ、概況を書かせる
    const hasHighlights = /^- /m.test(md);
    const newsOverview = hasHighlights ? await buildCenterOverview({
      agentKey: 'news', defaultName: '報道センター', config, apiKey: creds.gemini?.api_key, activitySessionId,
      materialText: md,
      focusInstruction: '【今回書くこと】以下の今週の主なニュース一覧を取りまとめ、今週はどんな'
        + '1週間だったかが伝わるように概況を伝えてください。',
    }) : null;
    const newsOverviewMd = newsOverview ? `### 📰 ${config.agents?.news?.name || '報道センター'}によるニュースまとめ\n${newsOverview}` : null;
    writeSection('📰 今週の主なニュース', [newsOverviewMd, md].filter(Boolean).join('\n\n'));
    filled.push('今週の主なニュース');
  } catch (e) {
    getLogger().warn(`[Secretary] 週間ニュースハイライトの生成に失敗: ${e.message}`);
  }

  // ── 今週の AI・テクノロジーのニュース ──
  try {
    const md = await _selectWeeklyTechNewsHighlights({ apiKey: creds.gemini?.api_key, activitySessionId });
    writeSection('🧠 今週のAI・テクノロジーニュース', md);
    filled.push('AI・テクノロジーニュース');
  } catch (e) {
    getLogger().warn(`[Secretary] 週間AI・テクノロジーニュースの生成に失敗: ${e.message}`);
  }

  // ── 🤖 秘書の1週間の活動記録 ──
  try {
    const res = await _summarizeWeeklyActivity({ weekDates, apiKey: creds.gemini?.api_key, activitySessionId });
    if (res.result) {
      writeSection('🤖 秘書の1週間の活動記録', res.result);
      filled.push('週間の活動記録');
    }
  } catch (e) {
    getLogger().warn(`[Secretary] 週間活動記録の生成に失敗: ${e.message}`);
  }

  // ── 資産のレポート（書き込みまで updateFinanceReport が行う）──
  try {
    const res = await updateFinanceReport({ config, creds, activitySessionId });
    if (!res.error) filled.push('金融資産レポート');
  } catch (e) {
    getLogger().warn(`[Secretary] 週次金融資産レポートの生成に失敗: ${e.message}`);
  }

  // ── 保有銘柄のヒートマップ ──
  // ATTENTION: 必ず上の資産のレポートの後に行うこと。レポートが今週分を書き込んで初めて「今週と前週」の
  // 比較になる。先に行うと「前週と前々週」の図になる
  try {
    const md = await _buildHoldingsHeatmapSection({ config, creds, obs, weekStart, activitySessionId });
    if (md) {
      writeSection('🔥 保有銘柄のヒートマップ（対前週比）', md);
      filled.push('保有銘柄のヒートマップ');
    }
  } catch (e) {
    getLogger().warn(`[Secretary] 保有銘柄のヒートマップの生成に失敗: ${e.message}`);
  }

  // ── 資産の推移と下げ幅 ──
  // 上のレポートが今この時点の残高なのに対し、こちらは台帳から長い期間の変化を見る
  try {
    const md = await _buildAssetLedgerSection({ config, creds, obs, weekStart, activitySessionId });
    if (md) {
      writeSection('📉 資産のドローダウンと推移', md);
      filled.push('資産のドローダウンと推移');
    }
  } catch (e) {
    getLogger().warn(`[Secretary] 資産のドローダウンと推移の生成に失敗: ${e.message}`);
  }

  const result = filled.length > 0
    ? `今週のウィークリーノートに${filled.join('・')}を記録しました。`
    : 'ウィークリーノートの作成に失敗しました。';
  secretaryStore.appendEntry('daily-briefings', { tool: 'create_weekly_report', result, filled });
  return { result, filled };
}

// 【2026-08-16・リファクタ（台帳#19）】Gemini Live Function Callingのtool宣言
// （旧: secretary-live-routes.jsのbuildSecretaryTools内、このドメインの2ツール分）。
const TOOL_DECLARATIONS = [
      {
        name: 'create_daily_report',
        // 【発動条件の明記・2026-08-27】Gemini Live公式のベストプラクティスに従い「いつ呼ぶか」を明示。
        description: '今日のObsidianデイリーノートに、天気・主なニュース・金融情報をまとめて記録します。'
          + '既に今日分が記録済みの場合は最新の内容に更新します（重複はしません）。'
          + '\n\n【発動条件】リスナーが「今日のレポートを作って」「今日のまとめを書いておいて」のように'
          + '本日分のレポート作成を求めたら、必ずこの機能を呼び出してください。'
          + '天気・ニュース・金融のデータ取得はこの機能が内部で行うため、事前に個別のget_*を'
          + '呼んでおく必要はありません。数十秒かかりますが、内容を自分で書き起こして代用せず、'
          + '必ずこの機能で記録してください。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'report_daily_activity',
        description: '昨日1日にあなた（秘書）が行った業務内容・特に重要な報告事項・所感を、'
          + '今日のObsidianデイリーノートの「昨日の業務内容」「報告事項」「所感」の各見出しへ記録します。'
          + '既に記録済みの場合は最新の内容に更新します（重複はしません）。'
          + '\n\n【発動条件】リスナーが「昨日の業務ログをまとめて」「昨日やったことを日報に書いて」の'
          + 'ように業務記録を求めたら、必ずこの機能を呼び出してください。業務内容は'
          + 'この機能が内部のログから組み立てるため、あなたが記憶から書き起こす必要はありません'
          + '（記憶で代用すると、この会話で扱っていない作業が抜け落ちます）。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      // ATTENTION: 週次レポートは日曜23:50の自動バッチ専用で、会話から
      // 呼ぶ手段が無かった（週に一度しか動かないため、内容を確認したいときに日曜まで待つ
      // しか無かった）。日報と同じく会話からも作成できるようにする。
      //
      // 【Liveには出さない】このツールはLIVE_ONLY_TOOL_NAMES（secretary-live-routes.js）に
      // 含めていないため、Gemini Liveからは直接見えず、ヘルパー経由でのみ呼ばれる。
      // 完了まで数分かかる処理であり、会話を止めずに裏で走らせる必要があるため——
      // まさにヘルパーへ移した理由そのものに該当する。
      {
        name: 'create_weekly_report',
        description: '今週のObsidianウィークリーノートに、天気の週間振り返り・来週の天気予報・'
          + '今週の主なニュース・AI/テクノロジーニュース・秘書の週間活動記録・週次金融資産レポート・'
          + '資産のドローダウンと推移をまとめて記録します。'
          + '既に今週分が記録済みの場合は最新の内容に更新します（重複はしません）。'
          + '\n\n【発動条件】リスナーが「週報を作って」「今週のまとめを書いておいて」'
          + '「ウィークリーノートを更新して」のように週次レポートの作成を求めたら、'
          + 'この機能を呼び出してください。'
          + '通常は日曜の夜に自動で作成されるため、それを待たずに今すぐ作りたい、'
          + 'あるいは作り直したい場合に使います。'
          + '\n【注意】各セクションのデータ収集・集計・作図を順に行うため、完了まで数分かかります。'
          + '途中で諦めたり、内容を自分で書き起こして代用したりせず、最後まで呼び出しきってください。',
        parameters: { type: 'OBJECT', properties: {} },
      },
];

const TOOL_HANDLERS = {
  create_weekly_report: async (args, ctx) => {
    const { config, creds, activitySessionId } = ctx;
    const res = await createWeeklyReport({ config, creds, activitySessionId });
    if (res.error) return { error: res.error };
    return { result: res.result };
  },

  create_daily_report: async (args, ctx) => {
    const { config, creds, activitySessionId } = ctx;
    const res = await createDailyReport({ config, creds, activitySessionId });
    if (res.error) return { error: res.error };
    return { result: res.result };
  },

  report_daily_activity: async (args, ctx) => {
    const { config, creds, activitySessionId } = ctx;
    const res = await createSecretaryActivityLog({ config, creds, activitySessionId });
    if (res.error) return { error: res.error };
    if (res.skipped) return { result: '本日はまだ記録できる業務が無いようです。' };
    return { result: res.result };
  },
};

module.exports = { TOOL_HANDLERS, TOOL_DECLARATIONS, createDailyReport, createSecretaryActivityLog, createWeeklyReport };
