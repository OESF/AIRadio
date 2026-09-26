/**
 * @file 秘書（My Secretary）の LINE での会話（受け取ったテキスト1件に、ツールを使いながら答える）
 *
 * 音声の秘書（routes/secretary-live-routes.js）とは別の、テキストの会話の経路。受信は routes/line-webhook-routes.js で、
 * ここは通信の方式に依らない中身だけを受け持つ。会話は conversation_history.jsonl に Live などと同じく書き、
 * LINE の分だけを agentKey で見分けて直近の文脈にする。
 *
 * ツールの実行は secretary-tools.js の executeSecretaryTool を使い、音声の秘書と同じツールが使える。LINE は
 * その場で言い直しや訂正がしやすいので、Obsidian の Inbox の処理（聞き返せない）と違い、予定の変更・削除などの
 * 書き込みも制限しない。関数呼び出し（ツールを呼ぶ → 結果を返す → 続きを生成する）の往復は、ここで回す。
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

const { generateTurn, modelTurn, toolResultPart, toolResultTurn } = require('./llm-client');
const systemAlerts = require('./system-alerts');
const fs = require('fs');
const { executeSecretaryTool } = require('./secretary-tools');
// ATTENTION: ツールの宣言は buildLineSecretaryTools を使う。buildSecretaryTools() は音声用の最小の組しか返さず、
//            buildAllSecretaryTools() には ask_helper など音声の経路だけで意味のある制御のツールが入っている。
// BUGFIX: 制御のツールを渡すと、LINE の経路では処理が無いのに選ばれて unknown tool のエラーになり、1往復分の
//         コストを無駄にした。
const { buildLineSecretaryTools } = require('./secretary-tool-declarations');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const activityDb = require('../activity-db');
const secretaryMemory = require('./secretary-memory');

// 文脈に使う直近の往復の数（1往復はリスナーの発言と秘書の返答の2件）
const MAX_CONTEXT_TURNS = 10;
// ツールの呼び出しの往復の上限。呼び出しが止まらない異常を防ぐ安全弁（普通の依頼は1〜2往復で終わる）
const MAX_TOOL_LOOP_TURNS = 6;

/**
 * 会話の記録で LINE の分を見分ける agentKey（管理画面の「会話履歴」でも見分けられる）
 */
const AGENT_KEY_USER = 'secretary_line_user';
const AGENT_KEY_SECRETARY = 'secretary_line';

/**
 * conversation_history.jsonl（Live などと共有）から、LINE の会話の直近の分だけを取り出す。
 * ファイル全体を読んでから絞る素朴な作りだが、このファイルは2000行で切り替わるので問題ない。
 * @param {string} convHistoryPath
 * @returns {Array<Record<string, any>>}
 */
function _readRecentLineHistory(convHistoryPath) {
  if (!fs.existsSync(convHistoryPath)) return [];
  const lines = fs.readFileSync(convHistoryPath, 'utf8').split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.agentKey === AGENT_KEY_USER || obj.agentKey === AGENT_KEY_SECRETARY) entries.push(obj);
    } catch { /* 壊れた行は無視して続行 */ }
  }
  return entries.slice(-MAX_CONTEXT_TURNS * 2);
}

/**
 * 会話の記録に1件足す（失敗しても続ける）。
 * @param {string} convHistoryPath
 * @param {string} agentKey
 * @param {string} agentName
 * @param {string} text
 */
function _appendLineHistory(convHistoryPath, agentKey, agentName, text) {
  try {
    fs.appendFileSync(convHistoryPath, `${JSON.stringify({ time: Date.now(), agentKey, agentName, text })}\n`, 'utf8');
  } catch (e) {
    getLogger().warn(`[SecretaryLine] 会話履歴の書き込み失敗: ${e.message}`);
  }
}

/**
 * LINE 用のシステムプロンプトを組み立てる。
 * 音声の秘書用（secretary-prompt.js）は発音・「お待ちください」の間合い・キャンバスなど音声に固有の指示が
 * 大半なので使わず、テキストの会話用に短く組み立てる。
 * @param {{ config: Record<string, any> }} args
 * @returns {string}
 */
function _buildSystemInstruction({ config }) {
  const userName = config.show?.user_profile?.name || 'リスナー';
  const secretaryName = config.agents?.secretary?.name || 'コナミ';
  const obsidianEnabled = !!config.obsidian?.enabled;
  const todayFull = new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return `あなたは${secretaryName}という名前のAI秘書です。LINEのトーク画面を通じて、`
    + `${userName}さんとテキストでやり取りしています。\n\n`
    + `【重要】声ではなく文章でのやり取りです。簡潔で読みやすい日本語の文章で応答してください。`
    + `LINEのトーク画面ではMarkdown記法（見出しの#、強調の**等）は装飾として表示されず記号の`
    + `ままリスナーに見えてしまうため、絶対に使わないでください。箇条書きが必要な場合は「・」を`
    + `使ってください。\n\n`
    + `あなたが持つ機能（ツール）を呼び出す前に「少々お待ちください」のような前置きを言う必要は`
    + `ありません（音声と違い、返信は結果がまとまってから一度に届くため）。黙って呼び出しを`
    + `開始し、結果が揃ってから一度にまとめて返信してください。\n\n`
    + `対応できること: 予定の確認・追加・変更・削除、メールの確認・返信下書き作成、タスクの確認・`
    + `追加、ニュース・天気・金融情報の確認、専門エージェントへの相談、Spotify操作（検索・`
    + `プレイリスト作成等）、YouTube検索、LINE・音声をまたいだ過去のやり取りの振り返り`
    + `${obsidianEnabled ? '、Obsidianノートの検索・作成（会議ノート・リサーチ・タスク一覧）' : ''}。\n`
    + `対応できないこと: メールの実際の送信（下書き作成のみで、送信は必ず本人がGmail上で行う`
    + `ことを伝えてください）、タスクの削除・完了、既存Driveファイルの削除、Spotifyの実際の`
    + `再生操作（一時停止・再開・スキップ・音量変更）。対応できない依頼には、できるふりをせず`
    + `正直にその旨を伝えてください。\n\n`
    + `画面表示（キャンバス）機能は音声チャンネル専用のためLINEでは使えません。表示系の依頼を`
    + `受けた場合は、内容をそのままテキストで簡潔にまとめて伝えてください。\n\n`
    // 音声と LINE は別の経路だが、リスナーから見ればどちらも同じ秘書なので、地続きであることを伝える
    // （音声の側は secretary-prompt.js の buildSelfIntroductionSection で同じことを指示している）
    + `あなたはこのLINEの窓口とは別に、AI Radioの画面で音声でも同じリスナーの依頼を受けて`
    + `います（同じあなたです）。「さっき声で話した件だけど」のように別の窓口でのやり取りに`
    + `ついて尋ねられたら、過去のやり取りを振り返る機能で確認してから答えてください。\n\n`
    + `ただし、参照できるのはあなた自身とリスナーとのやり取りだけです。リスナーがご家族や`
    + `ご友人と交わしている個人間のLINEトークは、LINE側が外部に一切提供していないため`
    + `読むことも返信することもできません。その種の依頼には正直にその旨を伝えてください。\n\n`
    + `専門エージェントへ相談する際、本来は本人の声で回答が再生されますが、LINEでは音声を送れ`
    + `ないため、テキストでの回答のみになります（「〇〇の見解: ...」のように、誰の見解かを`
    + `明記して伝えてください）。\n\n`
    // BUGFIX: 専門エージェントを名指しされたら、必ず相談の機能を使わせる。「交通情報センターに繋いで」で別の
    //         エージェントに勝手に振り替え、存在しない肩書きを作って答えたことがある（交通の担当が相談できる
    //         相手に入っていなかったのが原因で、secretary-tools.js の CONSULTABLE_AGENT_KEYS で直してある）。
    + `【重要】「交通情報センターに繋いで」のように専門エージェントを名指しで依頼された場合は、`
    + `必ず専門エージェントへの相談機能を呼び出してください（あなた自身の言葉で代わりに`
    + `答えないこと）。\n\n`
    + `【重要】専門エージェントへの相談で対応できるのは実在するエージェントに限られます。`
    + `リスナーが指定したセンター名やエージェント名が実在しない場合、それらしい名前を`
    + `でっち上げたり、別の実在エージェントに勝手に振り替えて話を合わせたりすることは`
    + `絶対にしないでください。該当する機能が無いことを正直に伝えてください。\n\n`
    + `本日の日付: ${todayFull}`;
}

/**
 * LINE で受け取ったメッセージ1件を処理し、返答のテキストを1つ返す。
 * @param {{ config: any, creds: any, userText: string, convHistoryPath: string, getChannelSystem?: ((channel: string) => any) | null }} args
 *   getChannelSystem は「今放送中か」の判定と、番組へのリクエストをすぐ反映するのに使う
 * @returns {Promise<{ replyText: string }>}
 */
async function processMessage({ config, creds, userText, convHistoryPath, getChannelSystem = null }) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) return { replyText: '現在、応答するための設定が整っていません。しばらくしてからもう一度お試しください。' };

  const secretaryName = config.agents?.secretary?.name || 'コナミ';
  const userName = config.show?.user_profile?.name || 'リスナー';

  _appendLineHistory(convHistoryPath, AGENT_KEY_USER, userName, userText);

  const history = _readRecentLineHistory(convHistoryPath);
  let turnContents = history.map(h => ({
    role: h.agentKey === AGENT_KEY_USER ? 'user' : 'model',
    parts: [{ text: h.text }],
  }));
  // 直近の記録には今回の入力も入っている（書いた直後に読み直すため）ので、重ねて足さない

  const activitySessionId = activityDb.openSession('secretary');
  try {
    const systemInstruction = _buildSystemInstruction({ config });
    const tools = buildLineSecretaryTools(config);

    // 相談したエージェントの声の合成は LINE では使わない（テキストで足り、音声合成のコストもかからない）。
    // getAgentSystem が null を返すと、secretary-tools.js の相談は音声を作らずテキストだけで続ける。
    const ctx = { config, creds, activitySessionId, getAgentSystem: () => null, getChannelSystem };

    for (let i = 0; i < MAX_TOOL_LOOP_TURNS; i++) {
      // ツールの呼び出しの表し方はプロバイダごとに違うので、llm-client の generateTurn に任せる
      // （ループの回し方はプロバイダに依らない）
      const turn = await generateTurn({
        tier: 'research',
        apiKey,
        contents: turnContents,
        systemInstruction,
        tools,
        temperature: 0.4,
        agentKey: 'secretary_line',
        activitySessionId,
        extraConfig: {
          // ATTENTION: ツールには自前の関数の宣言と組み込みの googleSearch が混ざっている。generateContent で
          //            両方を混ぜるときは includeServerSideToolInvocations を立てないと、400 で拒否される。
          toolConfig: { functionCallingConfig: { mode: 'AUTO' }, includeServerSideToolInvocations: true },
        },
      });

      const functionCalls = turn.toolCalls;
      const parts = turn.modelParts;   // 会話へ「モデルの発言」として積み戻す

      if (functionCalls.length === 0) {
        const replyText = turn.text.trim() || 'うまく応答を作れませんでした。もう一度お願いします。';
        _appendLineHistory(convHistoryPath, AGENT_KEY_SECRETARY, secretaryName, replyText);
        // BUGFIX: LINE の会話からも秘書の記憶を学習する。以前は音声の側でしか呼ばれず、LINE の会話が学習に入らなかった。
        //         LINE には「会話の終わり」が無いので、返答ができるたびに1往復を材料にする（訂正・好み・暮らしの変化は
        //         1往復でも拾える）。学習の抽出 → 古い自動学習の圧縮 → リスナー情報のダイジェストの作り直し、の順に
        //         つなぐ（secretary-live-routes.js の切断時と同じ）。返信を待たせないよう、結果は待たない。
        secretaryMemory.summarizeSessionLearnings(
          [{ speaker: 'user', text: userText }, { speaker: 'secretary', text: replyText }],
          { apiKey, activitySessionId, listenerProfile: config.show?.user_profile || {} },
        )
          .catch((e) => getLogger().warn(`[SecretaryLine] 学習内容の自動抽出に失敗: ${e.message}`))
          .finally(() => {
            secretaryMemory.compactOldAutoLearnings({ apiKey, activitySessionId })
              .catch((e) => getLogger().warn(`[SecretaryLine] 学習内容の圧縮に失敗: ${e.message}`))
              .finally(() => {
                secretaryMemory.summarizeListenerDigest({ apiKey, activitySessionId })
                  .catch((e) => getLogger().warn(`[SecretaryLine] リスナー情報ダイジェストの更新に失敗: ${e.message}`));
              });
          });
        return { replyText };
      }

      turnContents = [...turnContents, modelTurn(parts)];
      const responseParts = [];
      for (const call of functionCalls) {
        getLogger().info(`[SecretaryLine] tool呼び出し: ${call.name}`);
        const toolResult = await executeSecretaryTool(call.name, call.args, ctx);
        // 音声などの大きな項目はモデルに渡しても意味が無いので、result と error だけを渡す（音声の秘書と同じ）
        responseParts.push(toolResultPart(call.name, { result: toolResult.result, error: toolResult.error }));
      }
      turnContents = [...turnContents, toolResultTurn(responseParts)];
    }

    const fallback = 'すみません、処理が複雑になりすぎて完了できませんでした。少し分けてもう一度お伝えいただけますか？';
    _appendLineHistory(convHistoryPath, AGENT_KEY_SECRETARY, secretaryName, fallback);
    return { replyText: fallback };
  } catch (e) {
    getLogger().warn(`[SecretaryLine] 処理失敗: ${e.message}`);
    // 残高不足・レート制限・API キーの無効のように原因がはっきりしている異常は、理由まで返す（判定と文は
    // system-alerts に集めてあるので、ここで書き分けない）。分からないものだけ汎用の文にする
    const reason = systemAlerts.userMessageFor(e);
    if (reason) {
      _appendLineHistory(convHistoryPath, AGENT_KEY_SECRETARY, secretaryName, reason);
      return { replyText: reason };
    }
    return { replyText: '申し訳ありません、処理中にエラーが発生しました。時間をおいてもう一度お試しください。' };
  } finally {
    activityDb.closeSession(activitySessionId);
  }
}

module.exports = { processMessage };
