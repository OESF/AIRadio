/**
 * @file 秘書のツールが共有するサービスのインスタンスと、共通の小さな関数
 *
 * secretary-tools-*.js の各ドメイン（Google・Spotify・YouTube・レポート・資産など）が共有する
 * サービス（Google・天気・ニュース・金融など、各1つ）と定数、関数を置く。
 *
 * サービスは Live のものとは別のインスタンスで、キャッシュも別に持つ。
 *
 * ATTENTION: このファイルから他の secretary-tools-*.js を require しないこと。どのドメインからも安全に
 *            読めるよう、依存の末端に置いている（読むと循環 require になる）。
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
const { resolveModel } = require('./llm-models');
const GoogleService = require('../services/google-service');
const SpotifyUserService = require('../services/spotify-user-service');
const NewsService = require('../services/news-service');
const WeatherService = require('../services/weather-service');
const FinanceService = require('../services/finance-service');
const YouTubeService = require('../services/youtube-service');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const { normalizeLargeNumbersForSpeech } = require('./number-speech-format');
const { normalizeCompassDirectionsForSpeech } = require('./compass-direction-format');

const googleService = new GoogleService();
const spotifyUserService = new SpotifyUserService();
const newsService = new NewsService();
const weatherService = new WeatherService();
const financeService = new FinanceService();
const youtubeService = new YouTubeService();

/**
 * 日報など、短い分類・要約に使う軽いモデル。
 * ATTENTION: モデル名をここに直書きしないこと。モデルは llm-models.js のティア表で1か所で管理している。
 */
const SECRETARY_LIGHTWEIGHT_MODEL = resolveModel('secretary_light');

/**
 * 添付ファイルの分析に使うモデル。決算書のような数値や図表を含む文書を正しく読むには、
 * 軽いモデルより推論力のある中位のモデルが要る（ティア表の 'analysis'）。
 */
const FILE_ANALYSIS_MODEL = resolveModel('analysis');

/**
 * ツールが返すデータを、秘書（音声対音声のモデル）が読み上げやすい形にして渡す。
 *
 * BUGFIX: 先頭に「全文を読み上げず要点だけを伝える」という指示を付けること。ニュース・金融・天気の
 *         データは Live のコーナー用（見出しや【】付きの内部指示入り）の形のままなので、そのまま渡すと
 *         秘書が構造ごと読み上げて音声が破綻した。
 * BUGFIX: 大きな数値と方位を、先に読み上げやすい表記に変えておくこと（37,785,540 → 3778万5540、
 *         北北西 → ほくほくせい）。Gemini Live は合成前の文に後から手を入れられないが、モデルに渡す前の
 *         この文は自由に変えられる。多くのツールがここを通るので、ここ1か所で全体に効く。
 * @param {string} rawText ツールが返すデータ
 * @returns {string}
 */
function wrapDataForSpeechGuidance(rawText) {
  const normalized = normalizeCompassDirectionsForSpeech(normalizeLargeNumbersForSpeech(rawText));
  return `（以下は参考データです。全文をそのまま読み上げず、要点だけをあなた自身の言葉で`
    + `短く自然に伝えてください。【】で囲まれた文言は見出しやあなたへの内部指示であり、`
    + `記号ごと読み上げないでください。詳しく知りたそうであれば、画面表示機能で見せることを`
    + `断定的に伝えてから提案してください）\n\n${normalized}`;
}

/**
 * 末尾に付いてしまった放送用の受け渡しフレーズ（「○○さん、どうぞ」「お返しします」）を落とす。
 *
 * ATTENTION: プロンプトで「受け渡しは不要」と伝えても、放送向けの人格設定が強い出演者では
 * 付いてくる。ノートに残ると意味が通らないので、機械的にも落とす。
 * ATTENTION: 「どうぞ」は読点を伴う場合だけ落とすこと。「熱いうちにどうぞ」のような、
 * 料理の締めくくりまで消してしまわないため。
 *
 * @param {string} text 生成された文
 * @returns {string} 落とした後の文
 */
function _stripBroadcastHandoff(text) {
  return String(text || '')
    .replace(/\s*[^\n。！？]*?[、,]\s*どうぞ[。！]?\s*$/u, '')
    .replace(/\s*[^\n。！？]*?スタジオに?お返し(?:します|いたします)[。！]?\s*$/u, '')
    .replace(/\s*お返し(?:します|いたします)[。！]?\s*$/u, '')
    .trim();
}

/**
 * 気象・報道・金融の各センターに、担当するデータの概況を2〜4文で書かせる（デイリー・ウィークリーノート、
 * 資産レポート用）。
 *
 * BUGFIX: 「これは放送ではない」「放送用の体裁を使わない」と明示すること。人格設定（config.agents.<key>.prompt）は
 *         放送向けに書かれているので、そのままだとリスナーへの呼びかけや「…」「。さて、」のような間の記号が
 *         書き言葉のノートに混ざる（consult_agent で繰り返し起きた問題と同じ）。
 * @param {{agentKey: string, defaultName: string, materialText: string, focusInstruction: string,
 *   apiKey: string, activitySessionId?: *, config: Record<string, any>}} opts
 *   defaultName は設定に名前が無いときの名前、materialText は概況の材料、focusInstruction は何を書くかの指示
 * @returns {Promise<string|null>} 材料や API キーが無い・失敗したときは null
 */

async function buildCenterOverview({ agentKey, defaultName, materialText, focusInstruction, apiKey, activitySessionId = null, config }) {
  if (!materialText || !apiKey) return null;
  const agentName = config?.agents?.[agentKey]?.name || defaultName;
  const agentPrompt = config?.agents?.[agentKey]?.prompt || '';
  try {
    const { text: __raw } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: `あなたは${agentName}です。${agentPrompt}\n\n`
        + '【今回の場面】これは放送ではなく、Obsidianのノートに残す書き言葉の概況です。'
        + 'リスナーへの呼びかけ・挨拶、他の出演者への話の受け渡しは不要です。あなたの設定に'
        + '放送用の体裁（番号付け、「…」「。さて、」といった間を作る記号、締めの定型句など）'
        + 'が書かれていても、この場面では使わず、ふつうの文章としてつなげてください。\n\n'
        + `${focusInstruction}\n\n`
        + '【最重要】以下の材料に書かれている事実・数値だけを根拠にしてください。材料に無い'
        + '出来事・数値・将来の予測を新たに作らないこと。分からないことは無理に語らず、'
        + '材料から言える範囲に留めてください。2〜4文程度の簡潔な文章1つにまとめ、'
        + '見出しは付けず本文だけを返してください。',
      prompt: materialText,
      temperature: 0.4,
      agentKey: agentKey,
      activitySessionId,
      logMeta: { purpose: 'center_overview' },
    });
    const text = _stripBroadcastHandoff(__raw);
    return text || null;
  } catch (e) {
    getLogger().warn(`[Secretary] ${agentName}の概況生成に失敗（省略します）: ${e.message}`);
    return null;
  }
}

module.exports = {
  googleService, spotifyUserService, newsService, weatherService, financeService, youtubeService,
  SECRETARY_LIGHTWEIGHT_MODEL, FILE_ANALYSIS_MODEL, wrapDataForSpeechGuidance, buildCenterOverview,
};
