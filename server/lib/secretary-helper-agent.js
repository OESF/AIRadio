/**
 * @file 秘書の裏方として、時間のかかる調べもの・集計・作図を最後まで処理するヘルパーエージェント
 *
 * 秘書（Gemini Live）は会話だけを受け持ち、時間のかかる実際の処理はこのヘルパーがジョブとして引き受ける。
 * Gemini Live は1秒に満たない受け答えを前提にしているため、数分かかる処理をそこへ同期でぶら下げると、
 * 待ち時間を何秒にしても「会話が固まる」か「途中で切られる」かになる。
 *
 * - runToolJob: Live から来た1つのツール呼び出しを、LLM を通さずにジョブとして実行する
 * - runHelperJob: 言葉での依頼を、ツールとコード実行を使う LLM のループで最後まで処理する
 * - deliverJob: 終わったジョブの結果を、画面と秘書の声で届ける（会話が無ければ次の接続まで持ち越す）
 * - stripSandboxImageEmbeds: 報告の本文から、Vault に存在しない画像の埋め込みを除く
 *
 * ツールは汎用の能力（データを取る・画面に出す）だけにし、何をどう計算してどう描くかは AI に任せる。
 * 依頼の種類ごと・グラフの種類ごとに専用のツールは作らない。ただし算術は AI に暗算させず、Gemini の
 * コード実行（Python をプロバイダー側のサンドボックスで実行する）で行わせ、数値の正しさを機械で保証する。
 * ループの形は secretary-line.js の手回しのツールループと同じ。
 *
 * ジョブの状態は secretary-job-store.js に記録する。利用元は secretary-live-routes.js（ジョブの起動と配信）・
 * secretary-inbox.js と secretary-tools-reports.js（stripSandboxImageEmbeds）。
 *
 * ATTENTION: ヘルパーには日記も学習（secretary-memory への書き込み）も持たせない。リスナーを知らず、
 * 秘書の処理を実行するだけの役なので、ふり返るものが無い。成果は秘書が伝えることで、秘書の日記と学習に入る。
 * 学ぶのは秘書1人だけ、という形を保つこと。
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

const { getLogger } = require('../logger');
const toolGroups = require('./secretary-tool-groups');
const activityDb = require('../activity-db');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { generateTurn, modelTurn, toolResultPart, toolResultTurn } = require('./llm-client');
const { executeSecretaryTool } = require('./secretary-tools');
const jobStore = require('./secretary-job-store');
const sessionRegistry = require('./secretary-live-session-registry');
// ATTENTION: secretary-loop.js は、ここで先頭で require せず、使う所（deliverJob）でその都度 require する。
// loop → inbox → このファイル → loop と require が循環しており、secretary-loop.js は module.exports を
// 末尾でまとめて代入するため、先頭で require すると読み込み途中の空のオブジェクトを掴んだままになる
// （addPendingNotification が「関数ではない」になる）。

// 1つの依頼でツールを呼び合う往復の上限。secretary-line.js（会話の速さを優先して6）より広く取る。
// こちらは時間の制約が無く、何段もの作業をさせたいため
const MAX_TOOL_LOOP_TURNS = 12;

// ヘルパーには渡さないツール。
//   ask_helper      … 自分自身を呼び出してしまう
//   get_job_status  … ジョブの外側の話で、ヘルパーが気にすることではない
//   show_on_canvas / show_weather_map … 画面に出すのはジョブが終わったときの配信（deliverJob）の役目。
//     戻り値の canvas を画面の更新に変えるのは Live のルートの側なので、ヘルパーが呼んでも画面には出ない
//   end_session     … 会話を終えるのはヘルパーの役目ではない
const EXCLUDED_TOOL_NAMES = new Set([
  'ask_helper', 'get_job_status', 'show_on_canvas', 'show_weather_map', 'end_session',
]);

/**
 * 会話から頼まれた仕事のときだけ、さらに外すツール。
 *
 * ATTENTION: consult_agent を常に外してはいけない。Obsidian のインボックスのように、リスナーが
 * その場にいないバッチの依頼では「〇〇先生に評価してもらって」という多段の作業が実際に使われており、
 * そこでは文章での回答が正しい成果物になる。
 * 一方、会話の最中は事情が逆で、成果は専門エージェント本人の声であり、それを再生できるのは Live の
 * 経路だけ。ヘルパーから呼ぶと本人の声が失われ、秘書が代わりに読むことになる（秘書側の許可リストに
 * consult_agent を残してあるのはこのため。secretary-tool-declarations.js の LIVE_ONLY_TOOL_NAMES 参照）。
 */
const EXCLUDED_WHEN_LIVE = new Set(['consult_agent']);

const HELPER_SYSTEM_INSTRUCTION = `あなたはAI秘書の裏方として、時間のかかる調査・集計・作図を引き受けるヘルパーです。
リスナーと直接会話はしません。作業を最後までやり切り、結果を報告してください。

【最重要・数値の扱い】
数値の計算・集計・並べ替え・比較は、必ずコード実行（Python）で行ってください。
頭の中で計算した数値を答えに書くことは絶対に禁止です。件数が少なく見えても同じです。
過去に、暗算で順位付けをさせた結果、実在しない数値をそのまま報告する事故が起きています。

【データの取得】
必要なデータは、用意されている機能（ツール）で実際に取得してください。
取得していない値を推測や記憶で埋めないでください。

**サンプルデータ・デモ用データを自分で作ることは、いかなる理由でも禁止です。**
（2026-08-29に実測で発覚: 「ヒートマップを作成してください」とだけ依頼したところ、
何のデータかが分からないまま、架空の「曜日別・時間帯別の店舗売上」を丸ごと創作して
グラフを描き、それらしい分析まで付けて報告した。リスナーには本物と区別がつかない。）

依頼が「何についてか」を示しておらず、どの機能で取ればよいか決められない場合は、
**推測で進めず、作らずに、何のデータについてかを尋ねる報告を返してください。**
例:「ヒートマップとのことですが、対象が分かりませんでした。資産・支出・予定など、
どれについてでしょうか」。空手で戻ることは失敗ではありません——
架空のデータで作られた図を渡すことのほうが、はるかに悪い結果です。
取得したデータをコード実行へ渡すときは、CSVなどの形でコードの中に埋め込んで構いません。
スプレッドシートの数値を扱うときは、内容を要約する機能ではなく、**生データを取得する機能**を
使ってください（要約を経由すると数値が失われたり丸められたりする恐れがあります）。

【グラフ】
グラフが必要な場合はmatplotlibで描いてください。種類（折れ線・棒・円・散布図など）は
依頼内容に合うものを自分で選んでください。
**グラフ内の文字は日本語のままで構いません。** ただし、matplotlibの既定フォントには
日本語が無く豆腐（□□□）に化けるため、描く前に必ず次の1行を実行してください。

    plt.rcParams['font.family'] = 'IPAGothic'

（2026-08-29に実測で確認: このサンドボックスには IPAGothic / IPAPGothic が入っており、
銘柄名・資産クラス名などの日本語ラベルが問題なく描画できる。指定を忘れたときだけ化ける。
リスナーが読むのは日本語のラベルなので、無理に英語へ言い換えないこと——
「楽天・プラス・SOX」を "Rakuten Plus SOX" と書き換えると、元の名前と対応が取れなくなる。）
凡例・軸ラベル・タイトルを付け、読み取りやすい大きさにしてください。

【ヒートマップを頼まれたとき】
**保有資産のヒートマップには専用の機能があります。**「資産のヒートマップを作って」
「楽天証券の保有状況を図にして」のように頼まれたら、必ずその機能を使ってください
（面積＝評価金額、色＝対前週比の図が、完成した画像として返ってきます）。
返ってきた画像のパスを ![[パス]] の形でノートへ貼るだけにし、**自分で描き直さないこと**。

自分でmatplotlibを使って描くと、依頼のたびに違う図になってしまいます（2026-09-10までに
実際に3回、毎回まったく違う形の図が作られました：
全銘柄が同じ大きさのマス目／文字が重なる図／銘柄×指標の行列ヒートマップ）。

資産以外のヒートマップを自分で描く場合も、**大きさで量を、色で変化率を表す**四角形の図に
してください。同じ大きさのマス目を並べただけの表は、色しか情報を持たないためヒートマップ
として成立しません。
画像は1枚だけ出力してください（複数の系列は1枚の中にまとめること）。

【最後の報告】
あなたの報告は、秘書がリスナーへ伝えるための**材料**です。
読み上げ用の原稿を書く必要はありません——言葉にして伝えるのは秘書の仕事です。
分かった事実を、短く、具体的に並べてください。
・数字は具体的に。単位も添える
・3〜5項目程度に絞る。前置きの挨拶や結びの言葉は不要
・グラフを描いた場合は、そこから読み取れる要点も1つ添える
・途中で使ったコードやその出力をそのまま貼り付けない
・**データから読み取れる事実だけを述べる。**「〜が原因と考えられます」のように、
  データに含まれていない理由・背景を推測で補わないでください（値の動きは説明できても、
  その理由はデータからは分かりません）
・対応できなかった場合は、何ができなかったかを一言で書く（取り繕わない）`;

/**
 * 別の分野のツールを使えるようにするツールの宣言（ヘルパーだけが持つ）。
 *
 * ヘルパーには依頼に関係する分野のツールだけを渡すため、途中で別の分野が要ると分かったときの逃げ道。
 * 呼ぶと、次の往復からその分野のツールが使える。
 */
const USE_MORE_TOOLS_DECLARATION = {
  name: 'use_more_tools',
  description: '今使える機能の中に必要なものが無い場合に、別の分野の機能を使えるようにします。'
    + '「その機能はありません」と諦める前に必ずこれを試してください。',
  parameters: {
    type: 'OBJECT',
    properties: {
      groups: { type: 'STRING', description: '必要な分野をカンマ区切りで（例: obsidian,calendar）' },
    },
    required: ['groups'],
  },
};

/**
 * ヘルパーにだけ渡すツールの宣言。
 *
 * ATTENTION: Live（声）の側には見せない。スプレッドシートの生データは数千文字になることがあり、
 * 会話へ流すとトークンを無駄に使ううえ、モデルが読み上げようとする。
 * データの取得はツールで決まったとおりに行い、読み解きと計算はコード実行で行う、という分担のための道具。
 */
const HELPER_ONLY_TOOL_DECLARATIONS = [
  USE_MORE_TOOLS_DECLARATION,
  {
    name: 'fetch_spreadsheet_data',
    description: 'Googleスプレッドシートの中身を、加工していない生データ（タブ区切り）のまま取得します。'
      + '\n\n【発動条件】スプレッドシートの数値を使って計算・集計・作図をするときは、必ずこの機能で'
      + '取得してください。取得した生データはコード実行へ渡して解析してください。'
      + '\n特定のタブを読みたい場合は、URLに #gid=数字 を付けて指定します（省略すると先頭のタブ）。'
      + '目的のタブにデータが無かった場合は、他のタブのgidを試してください。',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'スプレッドシートのURL（gidを付けるとそのタブを読む）' },
      },
      required: ['url'],
    },
  },
];

/**
 * ヘルパーへ渡すツール一式（コード実行・ヘルパー専用のツール・秘書のツール）を組み立てる。
 *
 * groups を渡すと、その分野のツールだけに絞る。全部のツール（約6,000トークン）を毎回送ると、呼ぶツールを
 * 決めるだけで数秒〜十数秒かかり、しかも大きく振れる。分野を絞ると1秒弱で安定する。
 * groups が null なら全部のツールを渡す（分野を決められなかったときの安全側）。
 *
 * 秘書のツール（liveTools）は、呼び出し元の Live のルートから受け取る。そちらがこのファイルを require
 * しているので、こちらから require すると循環する。
 *
 * @param {Array<any>} liveTools 秘書（Live）のツールの一覧
 * @param {string[]|null} [groups] 使う分野。null なら全部
 * @param {boolean} [readOnly] true なら書き込み系のツールを渡さない
 * @param {boolean} [fromLiveConversation] 会話から頼まれた仕事か（EXCLUDED_WHEN_LIVE を足す）
 * @returns {any} Gemini の tools に渡す一覧
 */
function _buildHelperTools(liveTools, groups = null, readOnly = false, fromLiveConversation = false) {
  const excluded = fromLiveConversation
    ? new Set([...EXCLUDED_TOOL_NAMES, ...EXCLUDED_WHEN_LIVE])
    : EXCLUDED_TOOL_NAMES;
  const out = [{ codeExecution: {} }, { functionDeclarations: [...HELPER_ONLY_TOOL_DECLARATIONS] }];
  const scoped = groups
    ? toolGroups.filterToolsByGroups(liveTools || [], groups, excluded, { readOnly })
    : null;
  for (const entry of scoped || liveTools || []) {
    if (entry.functionDeclarations) {
      const kept = entry.functionDeclarations.filter((d) => !excluded.has(d.name));
      if (kept.length > 0) out.push({ functionDeclarations: kept });
    } else {
      // googleSearch などの組み込みのツールはそのまま渡す
      out.push(entry);
    }
  }
  return out;
}

/**
 * 1つのツールを1件のジョブとして実行する（LLM は通さない）。Live から来るツール呼び出しはすべてここを通る。
 *
 * ATTENTION: 時間の上限は設けない。上限があると、時間はかかるが成功している処理を失敗として扱ってしまう
 * （それを避けるのがこのファイルの役目）。
 * ATTENTION: ここでは結果を届けない。その場で返せたか後から届けるかは呼び出し元が決める。ここでも
 * 届けると、呼び出し元の待ち時間ぎりぎりで終わったときに、同じ結果を2回届けてしまう。
 *
 * @param {{jobId: string, name: string, args: any, ctx: any}} job ジョブ ID・ツール名・
 *   引数・ツールに渡す文脈
 * @returns {Promise<Record<string, any>>} ツールの結果（result か error）
 */
async function runToolJob({ jobId, name, args, ctx }) {
  try {
    const toolResult = await executeSecretaryTool(name, args, ctx);
    if (toolResult?.error) {
      jobStore.failJob(jobId, toolResult.error);
    } else {
      jobStore.finishJob(jobId, { resultText: toolResult?.result ?? null });
    }
    return toolResult;
  } catch (e) {
    getLogger().warn(`[SecretaryHelper] ツール実行で例外: ${name} — ${e.message}`);
    jobStore.failJob(jobId, `処理中にエラーが発生しました（${e.message}）`);
    return { error: `${name}の実行中にエラーが発生しました。` };
  }
}

/**
 * 言葉での依頼を、ヘルパー（ツールとコード実行を使う LLM のループ）で最後まで処理する。
 *
 * まず依頼に関係する分野を選び（読み取りだけの依頼なら書き込み系を渡さない）、ツールを呼ぶ往復を
 * MAX_TOOL_LOOP_TURNS 回まで繰り返す。描かれたグラフは最後の1枚を結果の画像にする。
 * 時間の上限は設けず、結果は届けずに返す（理由は runToolJob 参照）。例外は投げず、失敗はジョブに記録する。
 *
 * @param {object} job
 * @param {string} job.jobId ジョブ ID
 * @param {string} job.request 依頼の文
 * @param {Record<string, any>} job.config 秘書の設定
 * @param {Record<string, any>} job.creds 認証情報（Gemini の API キーなど）
 * @param {Array<any>} job.liveTools 秘書（Live）のツールの一覧
 * @param {any} [job.getChannelSystem] チャンネルのエージェントシステムを返す関数
 * @param {boolean} [job.fromLiveConversation] 会話の最中に頼まれた仕事か（渡すツールが変わる。
 *   EXCLUDED_WHEN_LIVE 参照）。バッチの依頼では省略する
 * @returns {Promise<Record<string, any>>} 結果の文（result）か失敗の理由（error）
 */
async function runHelperJob({
  jobId, request, config, creds, liveTools, getChannelSystem = null, fromLiveConversation = false,
}) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) {
    jobStore.failJob(jobId, 'Gemini APIキーが設定されていません');
    return { error: 'Gemini APIキーが設定されていません' };
  }

  const activitySessionId = activityDb.openSession('secretary');
  const _jobT0 = Date.now();
  try {

    // 依頼に関係する分野のツールだけを渡す。分野を選ぶのは、分野名と短い説明だけを見る軽い1回で、
    // そのぶん以降の往復がすべて軽くなる。選べなければ null のまま（全部のツール）
    const picked = await toolGroups.chooseGroups({ apiKey, request, activitySessionId });
    let activeGroups = picked?.groups ?? null;
    // BUGFIX: 読み取りだけの依頼には、書き込み系のツールをそもそも渡さない。予定を確認するだけの依頼で
    // 作成と削除が何度も動き、予定が二重に登録されていた。プロンプトで戒めるのではなく、渡さないことで防ぐ
    let readOnly = picked?.readOnly === true;
    if (picked) {
      getLogger().info(`[SecretaryHelper] 使う分野: ${picked.groups.join('・')}`
        + `${readOnly ? '（読み取り専用）' : ''}${picked.reason ? `（${picked.reason}）` : ''}`);
    } else {
      getLogger().info('[SecretaryHelper] 分野を絞れなかったため全機能で実行します');
    }

    // 分野を足すたびに、ツール一式を含む設定を作り直す
    const buildConfig = () => ({
      tools: _buildHelperTools(liveTools, activeGroups, readOnly, fromLiveConversation),
      systemInstruction: HELPER_SYSTEM_INSTRUCTION,
      temperature: 0.2,
      // 思考は切る。共通の既定（無制限）だと、同じ判断に数十秒かかることがある（切ると数秒）。
      // ヘルパーが決めるのはどのツールを呼ぶかとどんなコードを書くかだけで、数値の正しさは
      // コード実行が保証するため、長く考えさせる必要が無い
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      // ATTENTION: 自前のツールと組み込みのツール（コード実行・googleSearch）を一緒に使うには必須。
      // 無いと 400（include_server_side_tool_invocations を有効にせよ）で断られる
      toolConfig: { functionCallingConfig: { mode: 'AUTO' }, includeServerSideToolInvocations: true },
    });
    let helperConfig = buildConfig();
    // getAgentSystem は null を返す。consult_agent で相談相手の声を作らず、文だけで続けるため
    // （ヘルパーには文で十分で、読み上げの費用が無駄になる）。
    // BUGFIX: jobId を渡す。無いと、時間のかかるツール（create_presentation など）が進み具合を
    // 書いても捨てられ、ダッシュボードに何をしているかが出ない
    const ctx = { config, creds, activitySessionId, jobId, getAgentSystem: () => null, getChannelSystem };

    let turnContents = [{ role: 'user', parts: [{ text: request }] }];
    let lastImage = null;      // 途中の往復で描かれることもあるので、見つけるたびに持っておく
    let lastImageMime = null;
    const seenCallKeys = new Set(); // 同じツールを同じ引数で繰り返すのを防ぐため（下の BUGFIX 参照）

    for (let i = 0; i < MAX_TOOL_LOOP_TURNS; i++) {
      // ツール呼び出し・コード実行・画像の取り出しは llm-client の generateTurn に任せる
      // （プロバイダーごとに返り方が違うため、ここで SDK の応答を直接読まない）
      const turn = await generateTurn({
        tier: 'analysis',
        apiKey,
        contents: turnContents,
        tools: helperConfig.tools,
        systemInstruction: helperConfig.systemInstruction,
        temperature: helperConfig.temperature,
        thinkingBudget: helperConfig.thinkingConfig.thinkingBudget,
        includeThoughts: helperConfig.thinkingConfig.includeThoughts,
        extraConfig: { toolConfig: helperConfig.toolConfig },
        agentKey: 'secretary_helper',
        activitySessionId,
      });
      const parts = turn.modelParts;
      // Google 検索はプロバイダーの側で完結し、ツール呼び出しとして届かない。記録しないと、実際に
      // 調べたのか覚えていることだけで答えたのかが後から分からないので、検索の言葉を残す
      const searched = turn.grounding.queries;   // llm-client が形をそろえたもの
      if (searched?.length) {
        jobStore.setProgress(jobId, '調べもの中');
        getLogger().info(`[SecretaryHelper] Google検索: ${searched.join(' / ').slice(0, 120)}`);
      }

      // コード実行はプロバイダーの側で済み、書いたコードと結果が同じ応答で返る（こちらで実行はしない）。
      // 進み具合の表示とログのために見るだけ
      if (turn.code.length > 0) {
        jobStore.setProgress(jobId, '計算・作図中');
        for (const c of turn.code) {
          if (c.code) getLogger().debug(`[SecretaryHelper] コード実行: ${String(c.code).slice(0, 120).replace(/\n/g, ' ')}`);
        }
      }
      for (const img of turn.images) {
        lastImage = img.base64;
        lastImageMime = img.mimeType;
      }

      const functionCalls = turn.toolCalls;
      if (functionCalls.length === 0) {
        const text = turn.text.trim();
        getLogger().info(`[SecretaryHelper] ジョブ完了（${Math.round((Date.now() - _jobT0) / 1000)}秒、往復${i + 1}回）`);
        if (!text && !lastImage) {
          jobStore.failJob(jobId, '結果を取得できませんでした。');
          return { error: '結果を取得できませんでした。' };
        }
        const resultText = text || '結果をまとめました。画面をご覧ください。';
        jobStore.finishJob(jobId, { resultText, resultImage: lastImage, resultImageMime: lastImageMime });
        return { result: resultText };
      }

      turnContents = [...turnContents, modelTurn(parts)];
      const responseParts = [];
      for (const call of functionCalls) {
        // BUGFIX: 同じツールを同じ引数で2回目以降に呼んだら、実行せず「結果は変わらない」と返して別の手を
        // 考えさせる。探し物が見つからないとき、同じ検索を上限まで繰り返して時間とトークンを無駄にしていた
        const callKey = `${call.name}:${JSON.stringify(call.args || {})}`;
        if (seenCallKeys.has(callKey)) {
          getLogger().warn(`[SecretaryHelper] 同一の呼び出しの繰り返しを検知したため実行を省略: ${call.name}`);
          responseParts.push(toolResultPart(call.name, {
            error: 'この呼び出しは既に同じ引数で実行済みで、結果は変わりません。'
              + '同じことを繰り返さず、別の方法を試すか、ここまでに分かったことで回答をまとめてください。',
          }));
          continue;
        }
        // 分野の追加は、ふつうのツールとしては実行せずここで処理し、設定を作り直す（次の往復から効く）
        if (call.name === 'use_more_tools') {
          const asked = String(call.args?.groups || '').split(/[,、\s]+/).map((x) => x.trim()).filter(Boolean);
          const added = asked.filter((g) => toolGroups.GROUPS[g] && !(activeGroups || []).includes(g));
          // 読み取りだけと判定したのに、書き込みが要ると申告があったら解除する。「登録して」という依頼を
          // 読み取りと誤って判定したときに、何もできなくなるのを防ぐ逃げ道。
          // BUGFIX: 読み取り専用を解除しただけで新しい分野が増えないときも、成功として返すこと。
          // error で返していたころ、実際には書き込みができるようになっているのにモデルが失敗と
          // 受け取り、そこで諦めてしまっていた。
          const wantsWrite = /write|書き込み|登録|作成|変更|削除/.test(String(call.args?.groups || ''));
          let unlockedWrite = false;
          if (readOnly && wantsWrite) {
            readOnly = false;
            unlockedWrite = true;
            getLogger().info('[SecretaryHelper] 書き込みが必要と申告があったため読み取り専用を解除');
          }
          if (added.length > 0 || unlockedWrite) {
            activeGroups = [...(activeGroups || []), ...added];
            helperConfig = buildConfig();
            getLogger().info(`[SecretaryHelper] 分野を更新: ${(activeGroups || []).join('・')}`);
          }
          const _unlocked = [
            added.length > 0 ? `${added.join('・')}の機能` : '',
            unlockedWrite ? '書き込みの操作' : '',
          ].filter(Boolean).join('と');
          responseParts.push(toolResultPart(call.name, _unlocked
            ? { result: `${_unlocked}が使えるようになりました。続けてください。` }
            : { error: `指定された分野が見つかりませんでした。使えるのは: ${toolGroups.SELECTABLE_KEYS.join(', ')}` }));
          continue;
        }

        seenCallKeys.add(callKey);
        jobStore.setProgress(jobId, `${call.name} を実行中`);
        getLogger().info(`[SecretaryHelper] tool呼び出し: ${call.name}`);
        const toolResult = await executeSecretaryTool(call.name, call.args, ctx);
        // audioBase64 などの大きな文字でない項目はモデルに渡しても意味が無いので、result と error だけ渡す
        responseParts.push(toolResultPart(call.name, { result: toolResult.result, error: toolResult.error }));
      }
      turnContents = [...turnContents, toolResultTurn(responseParts)];
    }

    const overrun = `処理が${MAX_TOOL_LOOP_TURNS}往復を超えたため打ち切りました。依頼を分けてお試しください。`;
    jobStore.failJob(jobId, overrun);
    return { error: overrun };
  } catch (e) {
    getLogger().warn(`[SecretaryHelper] ジョブ実行で例外: ${e.message}`);
    jobStore.failJob(jobId, `処理中にエラーが発生しました（${e.message}）`);
    return { error: `処理中にエラーが発生しました（${e.message}）` };
  } finally {
    activityDb.closeSession(activitySessionId);
  }
}

/**
 * 終わったジョブの結果を届ける。届け方は画面に出すのが既定（Obsidian などへの保存は、
 * 後の会話で頼まれたときだけ行う）。
 *
 * - 会話中でモデルが話していない: 画面に出し、秘書に伝えさせる
 * - モデルが話している最中: 空くまで待つ。ATTENTION: 話している最中に差し込むと割り込みになり、
 *   再生中の声が切れる
 * - 会話が無い: 秘書の持ち越し（secretary-loop.js の pending）に積み、次の接続の挨拶で伝える
 *
 * @param {Record<string, any>|null} job ジョブ（secretary-job-store.js のもの）
 * @returns {void}
 */
function deliverJob(job) {
  if (!job) return;
  const session = sessionRegistry.getActiveSession();

  if (!session) {
    require('./secretary-loop').addPendingNotification(_buildPendingText(job));
    getLogger().info('[SecretaryHelper] 接続中のセッションが無いため、次回接続時に伝えるよう持ち越しました');
    return;
  }

  const deliverNow = () => {
    try {
      if (job.status === 'done' && (job.resultText || job.resultImage)) {
        session.sendCanvas({
          title: _canvasTitle(job),
          content: job.resultText || '',
          imageBase64: job.resultImage || undefined,
          imageMime: job.resultImageMime || undefined,
        });
      }
      session.injectSystemTurn(_buildInjectionText(job));
      getLogger().info(`[SecretaryHelper] 結果を配信しました id=${job.id.slice(0, 8)}`);
    } catch (e) {
      getLogger().warn(`[SecretaryHelper] 結果の配信に失敗: ${e.message}`);
    }
  };

  if (session.isBusy()) {
    getLogger().debug('[SecretaryHelper] モデルが生成中のため、空くまで配信を保留します');
    session.deferDelivery(deliverNow);
    return;
  }
  deliverNow();
}

/**
 * 画面に出す結果の見出し（依頼の文の先頭40文字）。
 * @param {Record<string, any>} job ジョブ
 * @returns {string} 見出し
 */
function _canvasTitle(job) {
  const r = job.request || '';
  return r.length > 40 ? `${r.slice(0, 40)}…` : (r || '処理結果');
}

/**
 * 声の側へ渡すために、Markdown の飾りの記号（箇条書き・見出し・太字・斜体・コード）を落とす。
 *
 * 画面には元のまま出し（整形されて読みやすい）、声の側には記号を落としたものを渡す。そのまま渡すと
 * 秘書が「アスタリスク」などと読み上げかねない。ヘルパーに記号を禁じるより、使い道ごとに変える。
 *
 * @param {string} text 報告の本文
 * @returns {string} 記号を落とした文
 */
function _toSpeechSafeText(text) {
  return String(text || '')
    .replace(/^\s*[*\-+]\s+/gm, '')      // 箇条書きの先頭記号
    .replace(/^\s*#{1,6}\s+/gm, '')      // 見出し
    .replace(/\*\*(.+?)\*\*/g, '$1')     // 太字
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1') // 斜体
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // コード
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Live に差し込む内部の指示を作る。伝えるべき事実と、画面に出し終えていることを知らせる。
 * @param {Record<string, any>} job ジョブ
 * @returns {string} 指示の文
 */
function _buildInjectionText(job) {
  if (job.status !== 'done') {
    return `(内部情報・この文をそのまま読み上げないこと: 先ほど受け付けた依頼「${job.request}」は`
      + `処理に失敗しました。理由: ${job.error || '不明'}。リスナーへ、失敗した事実と理由を`
      + `一度だけ短く正直に伝えてください)`;
  }
  const imageNote = job.resultImage ? 'グラフの画像も画面に表示済みです。' : '';
  // 渡すのは読み上げの原稿ではなく、事実の材料。言葉にするのは秘書の役目で、ヘルパーに原稿を
  // 書かせると文を作るのが二重になって遅くなり、秘書の口調も平板になる
  return `(内部情報・この文をそのまま読み上げないこと: 先ほど受け付けた依頼「${job.request}」の`
    + `処理が完了しました。結果は既に画面へ表示済みです。${imageNote}`
    // BUGFIX: ここで「ヘルパー」という言葉を使わない。使うと、モデルが「ヘルパーに頼みます」のように
    // 裏の仕組みをリスナーへ話してしまった。リスナーから見れば、調べたのは秘書自身
    + `以下が分かった事実です。**そのまま読み上げず、あなた自身の言葉で、`
    + `いつもの話し方で、要点だけ短く伝えてください。**`
    + `裏でどう処理したかには触れず、あなたが確認してきたこととして伝えてください。`
    + `画面表示の機能を改めて呼び出す必要はありません（既に出ています）。\n\n${_toSpeechSafeText(job.resultText)})`;
}

/**
 * 会話が無いときに持ち越す文（次の接続の挨拶で使う）。
 * @param {Record<string, any>} job ジョブ
 * @returns {string} 持ち越す文（結果は400文字まで）
 */
function _buildPendingText(job) {
  if (job.status !== 'done') {
    return `依頼「${job.request}」の処理は失敗しました（${job.error || '不明'}）。`;
  }
  return `依頼「${job.request}」の処理が完了しています。結果: ${_toSpeechSafeText(job.resultText).slice(0, 400)}`;
}

/**
 * ヘルパーの報告の本文から、Vault に存在しない画像の埋め込みの行を取り除く。
 *
 * ヘルパーはサンドボックスでグラフを描き、画像のデータ（resultImage）を返す。呼び出し元はそれを Vault に
 * 保存して貼る。ところがヘルパーは本文にも、サンドボックスの中でのファイル名で画像を埋め込むことがあり
 * （書くかどうかはモデルの言い回し次第）、そのファイルは Vault に無いので必ずリンク切れになる。
 * 正しい画像はコードが保存した1枚だけなので、本文の側の埋め込みはコードで取り除く。
 *
 * 行全体が画像の埋め込みになっている行だけを対象にし、文の中の記述には触れない。外部 URL の画像は残す。
 *
 * ATTENTION: 週次ノートの資産台帳（secretary-tools-reports.js の _buildAssetLedgerSection）と、受信箱の
 * リサーチレポート（secretary-inbox.js）の両方が、ここの1つを使う。書き写すと片方だけ直らなくなる。
 *
 * @param {string} markdown 報告の本文
 * @returns {string} 埋め込みの行を除いた本文
 */
function stripSandboxImageEmbeds(markdown) {
  return String(markdown || '')
    .split('\n')
    .filter((line) => !/^\s*!\[[^\]]*\]\((?!https?:\/\/)[^)]*\)\s*$/.test(line)   // ![説明](ローカルのファイル)
      && !/^\s*!\[\[[^\]]+\]\]\s*$/.test(line))                                  // ![[ローカルのファイル]]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { runToolJob, runHelperJob, deliverJob, stripSandboxImageEmbeds };
