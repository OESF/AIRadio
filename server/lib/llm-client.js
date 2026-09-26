/**
 * @file LLM（Gemini）の呼び出しを1か所にまとめる抽象化層
 *
 * すべての LLM の呼び出しはここを通す。モデルを差し替えるときや SDK を替えるときに、触る場所を
 * このファイル（と llm-models.js）だけにするため。使う SDK は @google/genai。
 *
 * この層が引き受けること:
 * 1. 用途（ティア）からモデル名を決める（llm-models.js の resolveModel）
 * 2. SDK の呼び出し方を隠す
 * 3. 応答からの文の取り出し（思考のパーツの除外・重複したパーツの除去）
 * 4. 使用量とコストの記録（activity-db.js の llm_chat・llm_image）
 * 5. 一時的な失敗のやり直しと、残高切れなどの異常の報告（system-alerts.js）
 *
 * 意識して引き受けないこと:
 * - Gemini に固有の機能を隠すこと。grounded（Google 検索）と thinkingBudget は引数として明示的に通す。
 *   裏に隠すと、検索が効かなくなっても思考の予算が既定に戻っても呼び出し側から見えず、事実の正しさと
 *   コストの制御という一番大事な2つを黙って失う。他社へ移すときも、移せない機能が見えている方がよい。
 * - 例外を握りつぶすこと。失敗したときの振る舞い（null を返す・代わりの処理・上へ投げる）は
 *   呼び出し箇所ごとに違うので、判断は呼び出し側に残す。
 * - 話す文の後処理（思考の漏れの除去・重複の除去・英語の前置きの除去など）。エージェントに固有の事情なので
 *   agent-shared-mixin.js に置く。
 *
 * 呼び出し側へ返すのは、プロバイダーに依存しない形（text・toolCalls・images など）だけにする。
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

const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');
const { getLogger } = require('../logger');
const activityDb = require('../activity-db');
const { MODEL_TIERS, resolveModel } = require('./llm-models');
const systemAlerts = require('./system-alerts');

/**
 * 一時的な失敗（system-alerts.js の isRetryable）のときに、やり直すまで待つ時間（ミリ秒）。要素の数がやり直す回数。
 * 放送は応答の速さが大事なので、待つのは合わせて数秒にとどめる。
 */
const RETRY_DELAYS_MS = [1500, 4000];

/**
 * プロバイダへの呼び出しを1箇所で包み、一時的な失敗のやり直しと、異常の system-alerts への報告を行う。
 *
 * すべての LLM の呼び出しがこの層を通るので、残高切れなどの異常は呼び出し側で判定せずここで拾う。
 * 成功したら復旧とみなして警告を消す（入金後は次の呼び出しが通るので、これが最も確かな「直った」の合図）。
 * 一時的な失敗（503 など）は RETRY_DELAYS_MS の間隔でやり直し、それでも失敗したときだけ報告して例外を投げ直す
 * （呼び出し側のフォールバックはそのまま動く）。ストリーミングでは、ストリームを開くところだけをやり直す。
 *
 * @param {Function} fn プロバイダを呼ぶ関数（Promise を返す）
 * @param {string} source どこからの呼び出しか（ログと警告の検知元に使う。例: llm:light）
 * @returns {Promise<any>} fn の結果
 */
async function callProvider(fn, source) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      systemAlerts.reportSuccess();
      return result;
    } catch (e) {
      // BUGFIX: Gemini 側の一時的な不調（503 など）は、少し待ってやり直す。1回の不調でそのまま失敗させていたころは、
      //         YouTube の取り込みで要約が作れず、その動画が取り込まれないまま失われていた
      if (attempt < RETRY_DELAYS_MS.length && systemAlerts.isRetryable(e)) {
        const delay = RETRY_DELAYS_MS[attempt];
        getLogger().warn(`[llm-client] ${source} が一時的に失敗しました。${delay / 1000}秒後にやり直します`
          + `（${attempt + 1}/${RETRY_DELAYS_MS.length}回目）: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      systemAlerts.report(e, { source });
      throw e;
    }
  }
}

/**
 * 応答のパーツから、思考を除いた文をつないで返す。
 *
 * プロバイダーに固有の応答の形はここで吸収し、呼び出し側はパーツを直接読まない。
 * Gemini は思考を thought: true のパーツとして同じ配列に混ぜて返す。
 * BUGFIX: 検索（グラウンディング）を使うと、まれに同じ内容のパーツが重なって返る。そのままつなぐと
 * 同じ文を2回話してしまうので、直前までの文と同じ・その末尾と同じパーツは飛ばす。
 *
 * @param {Array<any>} parts 応答のパーツ
 * @param {{agentKey?: string|null}} [opts] agentKey はログの見出しに使う
 * @returns {{text: string, outPartCount: number}} つないだ文と、思考でないパーツの数
 */
function joinOutputParts(parts, { agentKey = null } = {}) {
  const textParts = parts.filter((p) => p.text != null);
  const outParts = textParts.filter((p) => !p.thought);
  if (outParts.length < textParts.length) {
    // ATTENTION: ログの文言は変えない（この文言でログを集計しているため）
    getLogger().info(`[${agentKey || 'llm'}] thought パーツ除外: ${textParts.length - outParts.length}件をスキップ`);
  }
  let joined = '';
  let skipped = 0;
  for (const p of outParts) {
    if (p.text === joined || (joined && joined.endsWith(p.text))) { skipped++; continue; }
    joined += p.text;
  }
  if (skipped > 0) {
    getLogger().warn(`[${agentKey || 'llm'}] 重複パーツを${skipped}件スキップしました（grounding時に稀に起こる）`);
  }
  return { text: joined, outPartCount: outParts.length };
}

/**
 * 応答から、実際に話す・使う文を取り出す（思考は除く）。
 * @param {any} response SDK の応答（ストリーミングの1チャンクでもよい）
 * @param {{agentKey?: string|null}} [opts] agentKey はログの見出しに使う
 * @returns {string} 文（無ければ空文字）
 */
function extractText(response, opts = {}) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const { text, outPartCount } = joinOutputParts(parts, opts);
  if (outPartCount > 0) return text;
  // パーツが無い応答（安全のためのブロックなど）は SDK の text に任せる
  try { return response.text || ''; } catch { return ''; }
}

/**
 * 応答から、思考の文を取り出す（何を考えていたかを見たいとき用）。
 * @param {any} response SDK の応答
 * @returns {string} 思考の文（無ければ空文字）
 */
function extractThoughts(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => p.text != null && p.thought).map((p) => p.text).join('');
}

/**
 * 検索（グラウンディング）をしたかどうかと中身を、プロバイダーに依存しない形にして返す。
 * 呼び出し側が groundingMetadata という Gemini に固有の名前を知らなくて済むようにする。
 * @param {any} response SDK の応答
 * @returns {{searched: boolean, queries: string[], sources: string[], supportCount: number}}
 *   検索したか・検索の言葉・出典の題名（または URL）・根拠の付いた箇所の数
 */
function extractGrounding(response) {
  const gm = response?.candidates?.[0]?.groundingMetadata;
  const queries = gm?.webSearchQueries || [];
  const chunks = gm?.groundingChunks || [];
  const supports = gm?.groundingSupports || [];
  return {
    searched: queries.length > 0 || chunks.length > 0 || supports.length > 0,
    queries,
    sources: chunks.map((c) => c.web?.title || c.web?.uri).filter(Boolean),
    supportCount: supports.length,
  };
}

/**
 * 使用量（トークン数）を、llm_chat の記録に載せる形にする。
 * @param {any} usageMetadata SDK の usageMetadata
 * @returns {Record<string, any>} promptTokens・outputTokens・thoughtsTokens・cachedTokens・totalTokens
 */
function extractUsage(usageMetadata) {
  if (!usageMetadata) return {};
  return {
    promptTokens:   usageMetadata.promptTokenCount ?? null,
    outputTokens:   usageMetadata.candidatesTokenCount ?? null,
    thoughtsTokens: usageMetadata.thoughtsTokenCount ?? null,
    cachedTokens:   usageMetadata.cachedContentTokenCount ?? null,
    totalTokens:    usageMetadata.totalTokenCount ?? null,
  };
}

/**
 * 文を生成する。
 *
 * @param {object}  opts
 * @param {string}  opts.tier              使う用途。`llm-models.js` の MODEL_TIERS のキー
 * @param {string}  opts.apiKey            Gemini APIキー（必須）
 * @param {string}  [opts.systemInstruction]
 * @param {string}  [opts.prompt]          ユーザープロンプト。`contents` を渡す場合は不要
 * @param {Array}   [opts.contents]        contents を直接組み立てたい場合（画像添付など）
 * @param {object}  [opts.creds]           ティア解決の上書き元（認証情報）
 * @param {object}  [opts.config]          ティア解決の上書き元（config.json）
 *   モデル名は渡さない。呼び出し側はティアだけを指定し、ユーザーの設定（認証情報・config・
 *   エージェントごと）の反映は resolveModel がまとめて行う
 * @param {number}  [opts.temperature]
 * @param {boolean} [opts.json]            true で `responseMimeType: 'application/json'`
 * @param {object}  [opts.schema]          responseSchema（構造化出力）
 * @param {boolean} [opts.grounded]        true で Google検索グラウンディングを有効化
 * @param {number}  [opts.thinkingBudget]  思考予算を明示指定（省略時はティア／モデルから決まる）
 * @param {boolean} [opts.includeThoughts] 思考パーツを応答に含めるか（既定 true）。
 *                                         思考漏れ検知の保険として通常は true のままにする
 * @param {number}  [opts.maxOutputTokens] 出力トークン数の上限
 * @param {Array}   [opts.safetySettings]  セーフティ設定（放送本編は緩和した設定を渡している）
 * @param {string}  [opts.agentKey]        記録用（`llm_chat` の agent）
 * @param {number}  [opts.activitySessionId] 記録用
 * @param {object}  [opts.logMeta]         記録に追加したい項目（kind / channel など）
 * @returns {Promise<any>} text・thoughts・usage・model・finishReason・grounding と、SDK の応答そのもの（raw）。
 *   raw は最後の逃げ道で、ふだんは使わない
 */
async function generateText({
  tier,
  apiKey,
  systemInstruction = null,
  prompt = null,
  contents = null,
  creds = null,
  config = null,
  temperature = null,
  json = false,
  schema = null,
  grounded = false,
  thinkingBudget = null,
  includeThoughts = true,
  maxOutputTokens = null,
  safetySettings = null,
  agentKey = null,
  activitySessionId = null,
  logMeta = null,
} = {}) {
  if (!apiKey) throw new Error('[llm-client] apiKey が指定されていません');
  if (!prompt && !contents) throw new Error('[llm-client] prompt か contents のどちらかが必要です');

  // ── モデルの決定 ───────────────────────────────────────────────
  // ティアと agentKey だけから決める。ユーザーの設定は resolveModel が見る。
  // 知らないティアなら resolveModel が例外を投げる（打ち間違いを黙って通さない）
  const model = resolveModel(tier, { creds, config, agentKey });

  // ── 思考予算の決定 ─────────────────────────────────────────────
  // 引数で指定があればそれ、無ければティアの既定値。
  // BUGFIX: 思考の設定はモデル名ではなくティアから引く。モデル名で引いていたころ、モデルを替えたときに
  // 判定が漏れて思考を切れず、処理が何倍も遅くなった。ティアに付けておけば、モデルを替えても付いてくる
  const budget = thinkingBudget != null ? thinkingBudget : MODEL_TIERS[tier].thinkingBudget;

  const generationConfig = { thinkingConfig: { thinkingBudget: budget, includeThoughts } };
  if (temperature != null) generationConfig.temperature = temperature;
  if (maxOutputTokens != null) generationConfig.maxOutputTokens = maxOutputTokens;
  if (json || schema) generationConfig.responseMimeType = 'application/json';
  if (schema) generationConfig.responseSchema = schema;

  const ai = new GoogleGenAI({ apiKey });

  const t0 = Date.now();
  // 例外はそのまま呼び出し側へ投げる（失敗したときの扱いは呼び出し箇所ごとに違うため）
  const response = await callProvider(() => ai.models.generateContent({
    model,
    contents: contents || [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      ...generationConfig,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
      ...(safetySettings ? { safetySettings: resolveSafety(safetySettings) } : {}),
    },
  }), `llm:${tier}`);

  const usage = extractUsage(response?.usageMetadata);
  activityDb.logEvent(activitySessionId, 'llm_chat', {
    agent: agentKey,
    durationMs: Date.now() - t0,
    metadata: { model, ...(logMeta || {}), ...usage },
  });

  // 返すのはプロバイダーに依存しない結果だけ。candidates や groundingMetadata のような Gemini に固有の
  // 形は外に出さない（raw は最後の逃げ道で、ふだんは使わない）
  return {
    text: extractText(response, { agentKey }),
    thoughts: extractThoughts(response),
    usage,
    model,
    finishReason: response?.candidates?.[0]?.finishReason ?? null,
    grounding: extractGrounding(response),
    raw: response,
  };
}

/**
 * JSON を生成させ、解析まで行う。
 *
 * 壊れた JSON が返ったときは、例外ではなく data を null にして返す（呼び出し側の大半が、
 * 解析できなければあきらめて既定の動きにするため）。
 *
 * @param {any} opts generateText と同じ（json は常に true になる）
 * @returns {Promise<any>} generateText の結果に、解析した data を足したもの
 */
async function generateJson(opts) {
  const res = await generateText({ ...opts, json: true });
  try {
    // ```json ... ``` で囲まれて返ることがあるため取り除く
    const cleaned = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return { ...res, data: JSON.parse(cleaned) };
  } catch (e) {
    getLogger().warn(`[llm-client] JSONの解析に失敗（${res.model}）: ${e.message}`);
    return { ...res, data: null };
  }
}




/**
 * 画像をモデルへの入力として渡すためのパーツを作る。
 *
 * 画像の渡し方はプロバイダーごとに違うので、呼び出し側で inlineData の形を直接書かずにここで作る。
 *
 * @param {string} base64   画像のデータ（base64）
 * @param {string} [mimeType] 例: 'image/png'
 * @returns {Record<string, any>} contents の parts に入れるパーツ
 */
function imagePart(base64, mimeType = 'image/png') {
  return { inlineData: { mimeType, data: base64 } };
}

/**
 * ツールを呼ぶループで、モデルの発言を会話の履歴に積む1ターンを作る。
 *
 * BUGFIX: ターンの役割名（role）を知っているのはこの層だけにする。呼び出し側が role: 'function' などを
 * 直接書いていたころ、モデルを新しい世代に替えた途端に 400（その role は使えない）で全部失敗した。
 * 世代によって受け付ける role が違い、どの世代でも通るのは 'user'（toolResultTurn 参照）。
 *
 * ATTENTION: parts には generateTurn が返した modelParts を手を加えずに渡すこと。Gemini 3 系は
 * functionCall のパーツに thoughtSignature を載せており、落とすと次のターンが 400 になる。
 *
 * @param {Array<any>} parts generateTurn の modelParts
 * @returns {Record<string, any>} 履歴に積む1ターン
 */
function modelTurn(parts) {
  return { role: 'model', parts };
}

/**
 * ツール1件の実行結果を、モデルへ返すパーツにする。
 * @param {string} name ツール名
 * @param {Record<string, any>} response 結果（result か error など）
 * @returns {Record<string, any>} パーツ
 */
function toolResultPart(name, response) {
  return { functionResponse: { name, response } };
}

/**
 * ツールの実行結果のパーツを、会話の履歴に積む1ターンにまとめる。
 * ATTENTION: role は 'user' にする（どの世代のモデルでも通るのはこれだけ。modelTurn 参照）。
 * @param {Array<any>} parts toolResultPart で作ったパーツ
 * @returns {Record<string, any>} 履歴に積む1ターン
 */
function toolResultTurn(parts) {
  return { role: 'user', parts };
}

/**
 * 安全のための設定（セーフティ設定）の決まった組み合わせ。
 *
 * 分類の名前もしきい値の刻みもプロバイダーごとに違うので、呼び出し側はどれくらい緩めたいかを
 * 名前で指定するだけにし、実際の値はここで持つ。
 *
 * - relaxed: しきい値を「高いものだけ止める」にする。
 *   BUGFIX: 既定のしきい値のままだと、気象庁の警報（台風・強風・高波など）やニュースといった公開済みの
 *   事実へのコメントまで止められていた。本当に深刻な内容は、緩めても止まる。
 */
const SAFETY_PRESETS = {
  relaxed: [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  ],
};

/**
 * セーフティ設定の名前（'relaxed' など）を、プロバイダーの設定値にする。配列ならそのまま使う。
 * @param {string|Array<any>|null} safety 名前か設定値の配列
 * @returns {any} 設定値の配列（指定が無ければ null）
 */
function resolveSafety(safety) {
  if (!safety) return null;
  if (Array.isArray(safety)) return safety;
  const preset = SAFETY_PRESETS[safety];
  if (!preset) throw new Error(`[llm-client] 未知のセーフティ設定: ${safety}`);
  return preset;
}

/**
 * ツールを呼ぶループの1往復ぶんを生成し、プロバイダーに依存しない形で返す。
 * 使うのは秘書の LINE・秘書のヘルパー・プレゼンテーションの作成の3つのループ。
 *
 * ツール呼び出し・実行したコード・画像の取り出し方はプロバイダーごとに違うので、ここで吸収する。
 * TODO: contents と tools は、今は Gemini の形のまま受け渡している（会話の履歴の形までは揃えていない）。
 *
 * @param {any} opts generateText とほぼ同じ（prompt・json・schema・grounded は無い）。tier・apiKey・contents は必須
 *   - tier: 使う用途。llm-models.js の MODEL_TIERS のキー
 *   - apiKey: Gemini の API キー
 *   - contents: 会話の履歴
 *   - tools: 渡すツール（Gemini の形）
 *   - systemInstruction
 *   - creds: ティアの解決の上書き元（認証情報）
 *   - config: ティアの解決の上書き元（config.json）
 *   - temperature
 *   - thinkingBudget: 思考の予算（省略するとティアの既定値）
 *   - includeThoughts: 思考のパーツを応答に含めるか
 *   - maxOutputTokens
 *   - safetySettings: セーフティ設定（resolveSafety 参照）
 *   - extraConfig: config に足す項目（toolConfig など）
 *   - agentKey: 記録用
 *   - activitySessionId: 記録用
 *   - logMeta: 記録に足したい項目
 * @returns {Promise<{text: string, thoughts: string, toolCalls: Array<any>, code: Array<any>, images: Array<any>,
 *   grounding: any, usage: any, model: string, finishReason: any, modelParts: Array<any>, raw: any}>}
 *   toolCalls は name と args の一覧（無ければ空）、code はプロバイダーの側で実行したコードと出力、
 *   images は応答に含まれた画像（base64 と mimeType）、modelParts はモデルの発言として履歴に積み戻す
 *   生のパーツ（modelTurn 参照）
 */
async function generateTurn({
  tier, apiKey, contents, tools = null, systemInstruction = null,
  creds = null, config = null, temperature = null, thinkingBudget = null,
  includeThoughts = true, maxOutputTokens = null, safetySettings = null,
  extraConfig = null, agentKey = null, activitySessionId = null, logMeta = null,
} = {}) {
  if (!apiKey) throw new Error('[llm-client] apiKey が指定されていません');
  if (!contents) throw new Error('[llm-client] contents が必要です');

  const model = resolveModel(tier, { creds, config, agentKey });
  const budget = thinkingBudget != null ? thinkingBudget : MODEL_TIERS[tier].thinkingBudget;

  const cfg = { thinkingConfig: { thinkingBudget: budget, includeThoughts } };
  if (temperature != null) cfg.temperature = temperature;
  if (maxOutputTokens != null) cfg.maxOutputTokens = maxOutputTokens;
  if (systemInstruction) cfg.systemInstruction = systemInstruction;
  if (tools) cfg.tools = tools;
  if (safetySettings) cfg.safetySettings = resolveSafety(safetySettings);
  Object.assign(cfg, extraConfig || {});

  const ai = new GoogleGenAI({ apiKey });
  const t0 = Date.now();
  const response = await callProvider(
    () => ai.models.generateContent({ model, contents, config: cfg }),
    `llm:${tier}`,
  );

  const usage = extractUsage(response?.usageMetadata);
  activityDb.logEvent(activitySessionId, 'llm_chat', {
    agent: agentKey, durationMs: Date.now() - t0,
    metadata: { model, ...(logMeta || {}), ...usage },
  });

  const parts = response?.candidates?.[0]?.content?.parts || [];
  return {
    text: extractText(response, { agentKey }),
    thoughts: extractThoughts(response),
    toolCalls: parts.filter((p) => p.functionCall).map((p) => ({
      name: p.functionCall.name, args: p.functionCall.args || {}, _raw: p.functionCall,
    })),
    code: parts.filter((p) => p.executableCode || p.codeExecutionResult).map((p) => ({
      code: p.executableCode?.code || null,
      output: p.codeExecutionResult?.output || null,
    })),
    images: parts.filter((p) => p.inlineData?.data).map((p) => ({
      base64: p.inlineData.data, mimeType: p.inlineData.mimeType || 'image/png',
    })),
    grounding: extractGrounding(response),
    usage,
    model,
    finishReason: response?.candidates?.[0]?.finishReason ?? null,
    modelParts: parts,
    raw: response,
  };
}

/**
 * 画像を生成する。呼び出し側はプロンプトと縦横比だけを知っていればよい。
 * 利用元はレシピの写真（agent-system.js）とスライドの挿絵（secretary-tools-presentation.js）。
 *
 * @param {any} opts 画像の生成の指定。apiKey・prompt は必須
 *   - tier: 使う用途（既定 'image'）
 *   - apiKey: Gemini の API キー
 *   - prompt: 画像の説明
 *   - aspectRatio: 縦横比（例: '16:9'）
 *   - modelOverrideForCompat: モデル名を直接指定する（ティアより優先）
 *   - creds: ティアの解決の上書き元（認証情報）
 *   - config: ティアの解決の上書き元（config.json）
 *   - agentKey: 記録用
 *   - activitySessionId: 記録用
 *   - logMeta: 記録に足したい項目
 * @returns {Promise<{imageBase64: string, mimeType: string, usage: any, model: string}|null>} 画像が無ければ null
 */
async function generateImage({
  tier = 'image', apiKey, prompt, aspectRatio = null, modelOverrideForCompat = null,
  creds = null, config = null, agentKey = null, activitySessionId = null, logMeta = null,
} = {}) {
  if (!apiKey) throw new Error('[llm-client] apiKey が指定されていません');
  const model = modelOverrideForCompat || resolveModel(tier, { creds, config });

  const cfg = { responseModalities: ['TEXT', 'IMAGE'] };
  if (aspectRatio) cfg.imageConfig = { aspectRatio };

  const ai = new GoogleGenAI({ apiKey });
  const t0 = Date.now();
  const response = await callProvider(
    () => ai.models.generateContent({ model, contents: prompt, config: cfg }),
    `llm:${tier}`,
  );
  const durationMs = Date.now() - t0;

  const usage = extractUsage(response?.usageMetadata);
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      activityDb.logEvent(activitySessionId, 'llm_image', {
        agent: agentKey, durationMs, metadata: { model, ...(logMeta || {}), ...usage },
      });
      return { imageBase64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png', usage, model };
    }
  }
  getLogger().debug(`[llm-client] 画像パーツなし (model=${model} parts=${parts.length})`);
  return null;
}


/**
 * 文をストリーミングで生成し、プロバイダーに依存しない増分の列として流す。
 *
 * ストリームの単位も終わり方もプロバイダーごとに違うので、ここで吸収する。呼び出し側は
 * for await で textDelta（本文の増分）だけを受け取り、読み終えたあとに result（usage と model）を読む。
 * 文の切り出しや思考の漏れの判定は文に対する処理なので、呼び出し側（channel-base.js）に残す。
 *
 * @param {any} opts generateText とほぼ同じ（temperature・json・grounded などは無い）。tier・apiKey は必須
 *   - tier: 使う用途
 *   - apiKey: Gemini の API キー
 *   - prompt: ユーザーのプロンプト（contents を渡すなら不要）
 *   - contents
 *   - systemInstruction
 *   - creds: ティアの解決の上書き元（認証情報）
 *   - config: ティアの解決の上書き元（config.json）
 *   - thinkingBudget: 思考の予算（省略するとティアの既定値）
 *   - includeThoughts: 思考のパーツを応答に含めるか
 *   - agentKey: 記録用
 *   - activitySessionId: 記録用
 *   - logMeta: 記録に足したい項目
 * @returns {any} textDelta を順に返す AsyncGenerator。result に usage・model が入る（finishReason は入らない）
 */
function streamText({
  tier, apiKey, prompt, contents = null, systemInstruction = null,
  creds = null, config = null, thinkingBudget = null, includeThoughts = true,
  agentKey = null, activitySessionId = null, logMeta = null,
} = {}) {
  if (!apiKey) throw new Error('[llm-client] apiKey が指定されていません');
  const model = resolveModel(tier, { creds, config, agentKey });
  const budget = thinkingBudget != null ? thinkingBudget : MODEL_TIERS[tier].thinkingBudget;

  const out = { usage: {}, model, finishReason: null };
  async function* run() {
    const ai = new GoogleGenAI({ apiKey });
    const t0 = Date.now();
    const stream = await callProvider(() => ai.models.generateContentStream({
      model,
      contents: contents || [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        thinkingConfig: { thinkingBudget: budget, includeThoughts },
      },
    }), `llm:${tier}`);
    let rawUsage = null;
    for await (const chunk of stream) {
      if (chunk.usageMetadata) rawUsage = chunk.usageMetadata;   // 最後のチャンクで確定する
      const textDelta = extractText(chunk, { agentKey });
      if (textDelta) yield { textDelta };
    }
    out.usage = extractUsage(rawUsage);
    activityDb.logEvent(activitySessionId, 'llm_chat', {
      agent: agentKey, durationMs: Date.now() - t0,
      metadata: { model, stream: true, ...(logMeta || {}), ...out.usage },
    });
  }
  const gen = run();
  gen.result = out;   // 読み終えたあとに usage と model を読むための口
  return gen;
}

module.exports = {
  generateText, generateJson, generateTurn, generateImage, streamText, SAFETY_PRESETS, imagePart,
  modelTurn, toolResultPart, toolResultTurn,
  extractText, extractThoughts, extractGrounding, extractUsage,
};
