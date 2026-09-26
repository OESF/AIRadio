/**
 * @file LLM のモデルのティア表（用途からモデル名への対応）
 *
 * LLM は頻繁に新しい版が出るので、モデルの差し替えをこのファイルだけで済ませるための表。モデルを上げるときは
 * MODEL_TIERS の model を書き換える。利用元は llm-client.js・tts-client.js・live-client.js・agent-shared-mixin.js・
 * agent-system.js・秘書のツールなど。
 *
 * ATTENTION: 呼び出し側にはモデル名ではなくティア（用途）を書かせる。generateText({ model: '…' }) のように
 *            モデル名を書かせると、モデルを上げるたびにすべての呼び出し箇所を触ることになる。
 * ATTENTION: モデルを差し替えたら findModelsMissingFromPricing() で料金表（gemini-pricing.js）の入れ忘れを確かめる。
 *            載っていないと、稼働レポートのコストが黙って少なく数えられる。
 *
 * ティアは、コードに散らばっていた定数（SECRETARY_LIGHTWEIGHT_MODEL・FILE_ANALYSIS_MODEL・HELPER_MODEL・
 * CREATOR_MODEL・PREDICTION_CHECK_MODEL・LINE_MODEL など）を1か所に集めたもの。
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

/**
 * ティアの定義。
 *
 * - model:          既定のモデル名。モデルを上げるときはここだけを書き換える
 * - purpose:        何に使うティアか（呼び出し側がティアを選ぶときの判断材料）
 * - overrides:      実行時に model より優先する設定（書いた順に見る）
 * - thinkingBudget: 思考トークンの設定（0 は無効、-1 は動的）
 * - sites:          このティアを使う主な呼び出し箇所（目安）
 *
 * BUGFIX: 思考の設定はモデル名ではなくティアに紐づける。モデル名の集合で判定していたとき、モデルを上げた際に
 *         判定の更新が漏れて思考が切れず、メールの分類に本来の4倍以上の時間がかかった。
 */
const MODEL_TIERS = {
  live: {
    // ATTENTION: Live API には正式版（Stable）が1つも無い。「Preview は正式版へ置き換える」方針を適用できないので、
    //            廃止の予告が出ていないかを定期的に見る。
    model: 'gemini-3.1-flash-live-preview',
    purpose: 'Secretaryの音声対話（Live API）。他と違い WebSocket 双方向で、generateContent 系ではない',
    overrides: [],
    thinkingBudget: null,  // Live APIは thinkingConfig を使わない
    sites: 'routes/secretary-live-routes.js（GEMINI_LIVE_MODEL / 料金キー）',
  },

  main: {
    // gemini-2.5-flash に据え置く（2.5-flash には廃止日も推奨の移行先も告知されていない）。
    // 古い人名が出るハルシネーションは学習データの古さの問題で、検索を有効にすれば正しく答える。放送と同じ条件で
    // 比べると、速さ・コスト・正確さのいずれでも 2.5-flash が最もよかった（3-flash-preview は放送で14〜18秒かかり、
    // 間が空く）。上げるなら正式版の gemini-3.8-flash（コストは約1.7倍）。
    model: 'gemini-2.5-flash',
    purpose: '放送本編の発話生成（MAX・アシスタント・各コーナー担当・音楽chパーソナリティ）',
    // 優先順位: エージェント個別 > 認証情報 > config（Live は show の下、音楽チャンネルは program の下）> 既定値。
    // エージェント個別の設定（管理画面の機能）は、config.agents.$agent.gemini_model のこの1行でまかなう
    // （$agent は resolveModel の agentKey で置き換える。agentKey が無ければ読み飛ばす）。
    overrides: ['config.agents.$agent.gemini_model', 'creds.gemini.model',
                'config.show.gemini_model', 'config.program.gemini_model'],
    thinkingBudget: -1,  // 動的思考
    sites: 'generateAgentSpeech / _callGeminiRaw / channel-base._callGemini の既定ティア（tier省略時）',
  },

  light: {
    // 2.5-flash-lite の方が安いが、前置きのセリフの言い回しがぶれる（タメ口が混ざるなど）ので 3.1 を使う。
    //
    // ATTENTION: このモデルは 2027-05-07 に廃止される（推奨の移行先は gemini-3.5-flash-lite）。3.5-flash-lite は
    //            thinkingBudget: 0 を 400 で拒否するので、移るときは thinkingBudget を指定しないか 128 にする
    //            （どちらでも実際の思考は0トークンになる）。
    model: 'gemini-3.1-flash-lite',
    purpose: '短い前置き・つなぎ・先読み・抽出・分類・日記生成・各コーナーのノート生成',
    overrides: [],
    thinkingBudget: 0,  // 思考を切る
    sites: "tier: 'light' を指定する呼び出し全般（前置き・つなぎ・抽出・分類・日記・各コーナーのノート生成）",
  },

  secretary_light: {
    // ATTENTION: light と同じく 2027-05-07 に廃止。移るときの注意も light を参照。
    model: 'gemini-3.1-flash-lite',
    purpose: 'Secretaryまわりの軽量処理（記憶の要約・小さな判断など）',
    // 今は light と同じモデルだが、ティアは分けておく。放送側と秘書側で調整を変えたくなったとき、1行の書き換えで
    // 別々に動かせるようにするため。
    overrides: [],
    thinkingBudget: 0,  // 思考を切る
    sites: 'secretary-tools-services.js（SECRETARY_LIGHTWEIGHT_MODEL）, secretary-tools-google.js',
  },

  analysis: {
    model: 'gemini-3.5-flash',
    purpose: 'ファイル・スプレッドシート・Webページの解析、ヘルパーエージェント、プレゼン生成、'
           + 'consult_agent（放送エージェントへの個人的な相談）。'
           + '長い入力を読んで構造化した出力を返す用途',
    // 認証情報のモデルの設定を優先する（consult_agent の優先順位もここで持つ。呼び出し側に持たせると経路が分かれる）。
    // FILE_ANALYSIS_MODEL などはモジュールを読み込むときに認証情報なしで解決するので、既定値がそのまま使われる。
    overrides: ['creds.gemini.model'],
    thinkingBudget: -1,  // 動的思考
    sites: 'secretary-tools-services.js（FILE_ANALYSIS_MODEL）, secretary-helper-agent.js（HELPER_MODEL）, '
         + 'presentation-creator-agent.js（CREATOR_MODEL）',
  },

  research: {
    // Preview は廃止時期が決まるので正式版を使う。3.6・3.7・3.8 の Flash はどれも正式版で同じ価格だが、3.6 は
    // thinkingBudget: 0 を 400 で拒否し、3.8 は 0 も -1 も通るので 3.8 を選ぶ。検索を伴う調査で放送の尺に直接
    // 乗らないので、速さより確かさを優先する。
    model: 'gemini-3.8-flash',
    purpose: '実質的な推論と検索を要する調査（ジャーナリスト監視・能動的リサーチ・見立ての答え合わせ・LINE応答）',
    overrides: [],
    thinkingBudget: -1,  // 検索と推論を要するため動的思考のまま
    sites: 'journalist-watch.js, agent-proactive-research.js, agent-diary-feedback.js（PREDICTION_CHECK_MODEL）, secretary-line.js',
  },

  image: {
    // Preview ではない GA 版（Nano Banana 2）を使う。出力の単価は 2.5 の2倍だが、使うのはレシピの写真の生成などで
    // 回数が少なく、影響は小さい。さらに安くするなら gemini-3.1-flash-lite-image（Nano Banana 2 Lite）も選べる。
    model: 'gemini-3.1-flash-image',
    purpose: '画像生成（生活アドバイスコーナーのレシピ写真・プレゼン資料の画像）',
    overrides: ['creds.gemini.image_model'],
    thinkingBudget: null,  // 画像生成では使わない
    sites: 'agent-system.js（_callGeminiWithImage）, secretary-tools-presentation.js',
  },

  tts: {
    // ATTENTION: 音声合成にも正式版が1つも無い（live と同じく、Preview を避ける方針を適用できない）。
    model: 'gemini-3.1-flash-tts-preview',
    purpose: '音声合成。LLM抽象化層（llm-client.js）の対象外だが、'
           + 'モデル差し替えの一元管理という目的は共通のためここに置く',
    // ATTENTION: credentials.json の tts_model が設定されていると、既定値より優先される。古いモデルを指したままだと、
    //            ここを書き換えても実際には古いモデルで動く。
    overrides: ['creds.gemini.tts_model'],
    thinkingBudget: null,  // 音声合成では使わない
    sites: 'agent-shared-mixin.js:126（_geminiSynthesizeToBuffer）',
  },
};

/**
 * ティアの名前から、実際に使うモデル名を決める。
 * overrides に挙げた設定を、書いた順に優先して見る。
 *
 * @param {string} tier MODEL_TIERS のキー
 * @param {{creds?: Record<string, any>|null, config?: Record<string, any>|null, agentKey?: string|null}} [ctx]
 *   認証情報・設定・エージェントのキー（config.agents.$agent.gemini_model の解決に使う）
 * @returns {string} モデル名
 * @throws 知らないティアのとき
 */
function resolveModel(tier, { creds = null, config = null, agentKey = null } = {}) {
  const def = MODEL_TIERS[tier];
  if (!def) {
    throw new Error(`[llm-models] 未知のティア: ${tier}（有効な値: ${Object.keys(MODEL_TIERS).join(', ')}）`);
  }
  const sources = { creds, config };
  for (const p of def.overrides) {
    // $agent を含むパスは、agentKey があるときだけ見る
    if (p.includes('$agent')) {
      if (!agentKey) continue;
      const value = p.replace('$agent', agentKey).split('.')
        .reduce((o, k) => (o == null ? undefined : o[k]), sources);
      if (value) return value;
      continue;
    }
    const value = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), sources);
    if (value) return value;
  }
  return def.model;
}

/**
 * 有効なティアの名前か。
 * @param {string} name
 * @returns {boolean}
 */
function isTier(name) {
  return Object.prototype.hasOwnProperty.call(MODEL_TIERS, name);
}

/**
 * 思考トークンを既定で切るモデル（モデル名で判定する経路のための定義。定義はここ1か所に置く）。
 */
const ZERO_BUDGET_MODELS = new Set(['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite']);

/**
 * モデル名から思考の予算を引く。
 *
 * 本来はティアの thinkingBudget を使う（llm-client を通る呼び出しはすべてそちら）。これは、ツールを呼ぶループ
 * （secretary-line.js・secretary-helper-agent.js）のように SDK を直接呼ぶ経路が、agent-shared-mixin.js の
 * _thinkingConfigFor(model) を通して使うために残してある。
 * BUGFIX: ZERO_BUDGET_MODELS の定義は、この1か所だけに置く。2か所にあったとき、片方の更新が漏れた。
 * @param {string} model
 * @returns {number} 0（切る）か -1（動的）
 */
function thinkingBudgetForModel(model) {
  return ZERO_BUDGET_MODELS.has(model) ? 0 : -1;
}

/**
 * すべてのティアのモデルが料金表（gemini-pricing.js）に載っているかを確かめる。
 * モデルを差し替えたあとに呼べば、料金の入れ忘れをその場で見つけられる。
 *
 * @returns {string[]} 料金表に無いモデル名（空なら問題なし）
 */
function findModelsMissingFromPricing() {
  const { GEMINI_PRICING_PER_1M } = require('./gemini-pricing');
  return Object.values(MODEL_TIERS)
    .map((d) => d.model)
    .filter((m) => !GEMINI_PRICING_PER_1M[m]);
}

module.exports = {
  MODEL_TIERS, ZERO_BUDGET_MODELS,
  resolveModel, isTier, thinkingBudgetForModel, findModelsMissingFromPricing,
};
