/**
 * @file My Secretary チャンネルの Gemini Live 中継
 *
 * 他チャンネルと同格の1チャンネルだが、複数のリスナーが1つの放送を共有する他チャンネルと違い、
 * 接続ごとに独立した Gemini Live セッションを1本張る（本質的に1対1の対話であるため）。
 *
 * ブラウザ ⇄ AI Radio サーバー ⇄ Gemini Live の3者構成にし、API キーは常にサーバー側に留める。
 * サーバーが担うのは setup の組み立てと最初の挨拶の起動だけで、それ以外のメッセージは中身を
 * 解釈せずそのまま中継する。例外は Function Calling の toolCall で、これだけはサーバー側で
 * 実処理を行い toolResponse を組み立てて返す。
 *
 * 会話が止まったときの復帰（無応答の検知・続行の催促）、キャンバス表示の漏れ検知、
 * セッション上限の予告を受けてからの接続の差し替えも、このファイルが受け持つ。
 * 接続先・setup・ワイヤ形式の相互変換は lib/live-client.js にある。
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

const liveClient = require('../lib/live-client');
const systemAlerts = require('../lib/system-alerts');
const WebSocket = require('ws');
const { generateText } = require('../lib/llm-client');
const { getLogger } = require('../logger');
const { sharedAgentMethods } = require('../lib/agent-shared-mixin');
const { executeSecretaryTool, CONSULTABLE_AGENT_KEYS } = require('../lib/secretary-tools');
// ATTENTION: ツール宣言の組み立ては secretary-tool-declarations.js に置く。
//            secretary-inbox.js も同じ宣言を必要とするが、そこからこのファイルを直接
//            require すると循環参照になる（このファイル → secretary-loop.js →
//            secretary-inbox.js）。
const { LIVE_ONLY_TOOL_NAMES, buildSecretaryTools, buildAllSecretaryTools } = require('../lib/secretary-tool-declarations');
const activityDb = require('../activity-db');
const secretaryMemory = require('../lib/secretary-memory');
const secretaryDiary = require('../lib/secretary-diary');
const secretaryRecorder = require('../lib/secretary-recorder');
const secretaryLoop = require('../lib/secretary-loop');
const secretaryUploads = require('../lib/secretary-uploads');
const jobStore = require('../lib/secretary-job-store');
const helperAgent = require('../lib/secretary-helper-agent');
const sessionRegistry = require('../lib/secretary-live-session-registry');
const { buildSystemInstructionText } = require('../lib/secretary-prompt');

// 稼働レポート（gemini-pricing.js）の料金表のキーは "models/" 接頭辞の無い形式で管理して
// いるため、記録にはこちらを使う（Live API への接続自体は接頭辞付きの名前を要する）。
const GEMINI_LIVE_MODEL_PRICING_KEY = liveClient.livePricingKey();
// ここに残るのは会話運用のロジック（無応答からの復帰・催促・ツール実行）だけ。

// Live 側に残したツールがハングした場合の最終防衛線（dispatchToolCall 内のコメント参照）。
const LIVE_TOOL_HANG_GUARD_MS = 120000;

// ATTENTION: 実処理は例外なくヘルパーのジョブにする（ask_helper 経由）。Live に残すのは
//            外部と通信しない一瞬の操作だけ（LIVE_ONLY_TOOL_NAMES 参照）で、
//            「速ければ同期、遅ければ非同期」という中間状態を作らないこと。境界をまたいだ
//            瞬間に「呼べば結果が返る」という Live の前提が崩れ、二重呼び出し・二重表示を招く。
// BUGFIX: ツールごとの個別タイムアウト表は廃止した。Gemini Live は1秒未満のターン交代を
//         前提とした仕組みで、そこへ数分の処理を同期的にぶら下げている限り、枠を何秒にしても
//         「会話が固まる」か「切られる」かにしかならない。さらに Promise.race はタイムアウト側が
//         勝っても実処理を止められないため、実測45.9秒・62.5秒で成功していた処理が失敗として
//         報告される事故が起きていた。

/**
 * ツール呼び出しを捌く。
 *
 * @param {string} name ツール名
 * @param {any} args ツールの引数
 * @param {any} ctx 実行に必要な文脈（設定・認証情報・稼働レポートのセッション等）
 * @returns {Promise<any>} Live へ返す toolResponse の中身
 */
async function dispatchToolCall(name, args, ctx) {
  if (name !== 'ask_helper') {
    // Live に残した操作はそのまま実行する。ほとんどは一瞬で終わるが、consult_agent だけは
    // 本人の声を届ける都合で Live 側に残しており、文章の生成＋音声合成で数十秒かかる。
    // ATTENTION: 下の上限は、想定外のハングで toolResponse が永久に返らず会話全体が止まるのを
    //            防ぐ最終防衛線。所要時間で処理を振り分けるための仕組みではないため、正常な処理を
    //            絶対に切らない長さ（consult_agent の実測25〜45秒の3倍近く）にしてある。
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        error: `${name}の処理が終わりませんでした。時間をおいて再度お試しください。`,
      }), LIVE_TOOL_HANG_GUARD_MS);
    });
    try {
      return await Promise.race([executeSecretaryTool(name, args, ctx), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const request = String(args?.request || '').trim();
  if (!request) return { error: '依頼の内容が空でした。何をしてほしいかを添えて呼び出してください。' };

  // BUGFIX: 同じ依頼が既に走っていれば新しいジョブを作らない。Live は結果が返らないと
  //         「まだ実行できていない」と解釈して同じ依頼を繰り返すことがあり、二重に走って
  //         画面が二度書き換わる事故が起きた。
  const already = jobStore.listRunningJobs().find((j) => j.request === request);
  if (already) {
    getLogger().info(`[Secretary] 同じ依頼が既に処理中のため、二重実行を避けました id=${already.id.slice(0, 8)}`);
    return { result: `その依頼は既に受け付けており、ただいま処理中です（${already.progress}）。`
      + '重ねて依頼する必要はありません。完了したら自動的にお知らせします。' };
  }

  const job = jobStore.createJob({ request });
  // 完了を待たない。会話を止めないことがこの仕組みの目的なので、必ず即座に返す。
  helperAgent.runHelperJob({
    jobId: job.id, request,
    config: ctx.config, creds: ctx.creds,
    // 放送状況の判定・番組へのリクエストの即時反映に使う。
    getChannelSystem: ctx.getChannelSystem,
    liveTools: buildAllSecretaryTools(ctx.config),
    // 会話の最中なので、専門家への相談は秘書自身（Live）が行う。ヘルパーから呼ぶと本人の声が失われる
    fromLiveConversation: true,
  })
    .then(() => helperAgent.deliverJob(jobStore.getJob(job.id)))
    .catch((e) => getLogger().warn(`[Secretary] ジョブの後処理で例外: ${e.message}`));

  // ATTENTION: この戻り値を読む時点で、モデルは既に待機の一言を伝え終えている（実際の流れは
  //            「待機の一言を話す → ターンを終える → サーバーの催促 → 無言でこのツールを呼ぶ」）。
  //            ここで待機案内を促すと3回目の案内になるため、逆に「もう言わなくてよい」と書く。
  //            ただし単に「言うな」と書くだけでは足りない。システムプロンプトに「結果を受け取ったら
  //            必ず一言話す」という強いルールがあり競合するため、話す内容を待ち時間の再告知から
  //            逸らす書き方にすること。
  return {
    // ATTENTION: ここは「受け付けた」という通知だけで、結果は一切含まれていない。待機案内を
    //            禁じたところ、モデルが話す内容を失って、持っていないはずのメールの中身を
    //            でっち上げた。案内の重複より捏造の方がはるかに害が大きい。
    result: '【この時点では結果はまだ何も分かっていません】依頼を受け付けただけで、作業は'
      + 'これから裏で進みます。メールの件数・内容、調べ物の答え、集計結果など、'
      + '**結果に類することを一切話さないでください。**推測で埋めることも絶対に禁止です。'
      + '結果は作業が終わってから改めてお知らせが届きます。'
      // 重複の抑制は禁止ではなく「もう済んでいる」という事実の提示に留める
      // （強く禁じると上の捏造に逃げるため）。
      + '\n\n待ち時間の案内は、あなたが既にリスナーへ伝えているはずです。'
      + '同じ案内を言い直す必要はありません。'
      + 'ここでは、短い相槌ひとつで止めるか、「他に何かございますか」と尋ねる程度に留めてください。'
      + '\n完了を待って黙り込んだり、同じ依頼をもう一度渡したりしないでください。',
  };
}


/**
 * base64 の WAV から、その音声の再生時間（ミリ秒）を概算する。
 *
 * BUGFIX: 再生完了の待ち時間を15秒固定にすると、それを超える長い音声（実測: 183文字で
 *         約31秒）では再生の途中で toolResponse を送ってしまい、次の発言が本人の音声と
 *         重なって聞こえる。consult_agent の音声は 24kHz・16bit・モノラルの WAV 固定のため、
 *         base64 の長さから実データ量、さらに再生時間を逆算できる。
 *
 * @param {string} base64 WAV 全体の base64
 * @returns {number} 再生時間（ミリ秒）
 */
function estimateWavPlaybackMs(base64) {
  const byteLength = Math.floor(base64.length * 3 / 4); // base64→バイト数の概算（パディング誤差は無視できる程度）
  const pcmBytes = Math.max(byteLength - 44, 0); // WAVヘッダ44byte分を除く
  const BYTES_PER_SEC = 24000 * 2; // 24kHz・16bit・モノラル固定
  return (pcmBytes / BYTES_PER_SEC) * 1000;
}

/**
 * 会話履歴へ書く前に、疑似的なツール呼び出し構文や自己言及の地の文を取り除く。
 *
 * BUGFIX: プロンプト側の対策だけでは「call:consult_agent{agent_key:news,task:...}」のような
 *         疑似構文や「（consult_agent ツールを呼び出す）」という地の文がそのまま音声になるのを
 *         防ぎきれない。流れてしまった音声は取り消せないが、管理画面に永続的に残る会話履歴
 *         だけは汚さないための最終防衛線。
 * ATTENTION: 括弧書きの判定では「ツールを」「関数を」のような直前の名詞を固定しないこと。
 *            「(キャンバス表示を呼び出す)」のような別の言い回しをすり抜けさせてしまう。
 *
 * @param {string} text 文字起こし
 * @returns {string} 取り除いた後の文字起こし
 */
function stripToolCallLeak(text) {
  // 疑似構文は閉じ括弧が無いまま文章が続くことがある（モデルが書きかけて別の文へなだれ込む）
  // ため、`}` だけでなく句点も終端とみなし、どちらか早い方で打ち切る。
  const cleaned = text
    .replace(/call[:：]\s*[\w.:]+\{[^}。]*[}。]?/g, '')
    .replace(/[（(][^（）()]*呼び出[すし][^（）()]*[）)]/g, '')
    .replace(/[ 　]{2,}/g, ' ')
    .trim();
  if (cleaned !== text) {
    getLogger().warn(`[Secretary] outputTranscriptionに疑似ツール呼び出し構文の漏れを検知、会話履歴から除去しました: ${text.slice(0, 200)}`);
  }
  return cleaned;
}

// BUGFIX: プロンプトの指示だけでは「(キャンバス表示を呼び出す)」と言いながら実際には
//         呼ばない事象を防ぎきれないため、サーバー側で決定的に検知する。指示は確率的な
//         緩和にすぎず、確定的な防止策にはならない。
// ATTENTION: パターンはキャンバス関連の言い回しに絞ること。stripToolCallLeak の汎用パターンを
//            そのまま流用すると、キャンバスと無関係な漏れにまで訂正ターンを送ってしまう。
const CANVAS_NARRATION_LEAK_PATTERN = /キャンバス[^。\n]{0,20}呼び出/;

// BUGFIX: 「呼び出すと言って呼び出さない」だけでなく、一度も呼び出していないのに
//         「画面への表示がうまくできませんでした」と、起きてもいない失敗を実況する
//         パターンもある。ツールが呼ばれていないときだけ見るため、本当に失敗した場合は
//         誤検知しない。
const CANVAS_FALSE_FAILURE_PATTERN = /(画面|キャンバス)[^。\n]{0,15}表示[^。\n]{0,15}(できません|うまくいきません|失敗)/;

// BUGFIX: 上の2つは「呼び出」という語を含む不自然な言い回ししか拾えず、
//         「画面に表示しておきますね」のようなごく自然な日本語での予告を取りこぼしていた。
//         表示の約束・完了報告そのものを、未実行の状態で検知する。
const CANVAS_PROMISE_LEAK_PATTERN = /(画面|キャンバス)[^。\n]{0,20}(表示しておき|表示します|表示しますね|表示いたします|表示しました|お見せします|お見せしますね)/;

// BUGFIX: 「call:show_weather_map{map_type:天気図}」のような疑似構文は上の3つのどれにも
//         一致せず、訂正ターンが送られないまま読み上げられていた（会話履歴からの除去は
//         stripToolCallLeak が行うが、それは事後処理でしかなく、リスナーは既に聞いた後）。
// ATTENTION: 判定はキャンバス系ツールに限定せず、どのツールも呼ばれていないことで行う。
const PSEUDO_CALL_SYNTAX_PATTERN = /call[:：]\s*[\w.:]+\{/;

// ATTENTION: 訂正ターンには「やってほしいこと」だけでなく「やってほしくないこと」も書く。
//            直前に届く訂正ターンは、プロンプト側の同趣旨の禁止より次の発話への影響が強い。
// BUGFIX: 「今すぐ実際にその機能を呼び出してください」とだけ書いたところ、モデルが表示すべき
//         内容（見出し・箇条書き・マークダウン記法）を丸ごと音声で読み上げてから機能を呼んだ。
// BUGFIX: 例文を「画面に表示しますね程度の短い一言」としたところ、モデルがその例文をほぼ
//         そのまま復唱し、直前に自分が言った予告を（気まずさから謝罪を添えて）もう一度
//         繰り返した。例文は「予告の言い直し」ではなく「既に予告済みなので繰り返さなくてよい」
//         という明示にする。
const CANVAS_NUDGE_NO_NARRATION_SUFFIX = 'その際、表示する内容そのもの（見出し・箇条書き・'
  + 'マークダウン記法・記号など）を声に出して読み上げることは絶対にしないでください。'
  + '内容は機能の呼び出しにだけ渡してください。また、「画面に表示します」という予告は'
  + '直前の発言で既にリスナーに伝えているため、機能を呼び出す際に同じ予告を繰り返す'
  + '必要はありません。「失礼しました」のような謝罪も不要です。特に話すことが無ければ'
  + '無言のまま機能だけを呼び出してください。';

// キャンバス関連の4パターンは、いずれも「検知 → 一回限りのガード → フラグのリセット →
// タイマーの起動 → 警告ログ → 訂正ターンの送信」が完全に同型のため、文言だけを表にして回す。
//
// ATTENTION: 待機の約束（waitPromiseLeakDetected）はこの表に入れない。①即時ではなく猶予を
//            置いてから送る、②ガードを検知時ではなく送信時に立てる（猶予中に toolCall が
//            届けば送信自体を取り消すため）、③ダッシュボードへの通知やタイマーの後始末を
//            伴う、④文面も別物、と構造が違う。無理に押し込むと分岐だらけになる。
const CANVAS_LEAK_NUDGE_RULES = [
  {
    detectedKey: 'canvasFalseFailureDetected',
    guardFlagKey: 'canvasNudgeSentThisLeak',
    warnMessage: 'キャンバス表示を呼び出してもいないのに失敗したと発言したことを検知、自動的に再実行を促します',
    correctionText: '(システムより: 直前の発言で画面表示に失敗したと伝えましたが、実際にはキャンバス表示機能を一度も'
      + '呼び出していません。本当に失敗したと決めつけず、今すぐ実際にその機能を呼び出してください。'
      + CANVAS_NUDGE_NO_NARRATION_SUFFIX + ')',
  },
  {
    detectedKey: 'canvasLeakDetected',
    guardFlagKey: 'canvasNudgeSentThisLeak',
    warnMessage: 'キャンバス表示のナレーション漏れ（未実行）を検知、自動的に再実行を促します',
    correctionText: '(システムより: 直前の発言で画面に表示すると言いましたが、実際にはキャンバス表示機能を呼び出していません。'
      + '「表示しました」のような発言だけで済ませず、今すぐ実際にその機能を呼び出してください。'
      + CANVAS_NUDGE_NO_NARRATION_SUFFIX + ')',
  },
  {
    detectedKey: 'canvasPromiseLeakDetected',
    guardFlagKey: 'canvasNudgeSentThisLeak',
    warnMessage: 'キャンバス表示の約束（自然な言い回し）を検知したが未実行、自動的に再実行を促します',
    correctionText: '(システムより: 直前の発言で画面に表示すると言いましたが、実際にはキャンバス表示機能を呼び出していません。'
      + '「表示しました」「表示しておきます」のような発言だけで済ませず、今すぐ実際にその機能を呼び出してください。'
      + CANVAS_NUDGE_NO_NARRATION_SUFFIX + ')',
  },
  {
    detectedKey: 'pseudoCallSyntaxDetected',
    guardFlagKey: 'pseudoCallNudgeSentThisLeak',
    warnMessage: '疑似ツール呼び出し構文の読み上げ（未実行）を検知、自動的に再実行を促します',
    correctionText: '(システムより: 直前の発言でプログラムのコードのような文字列を話しましたが、それは実際には'
      + '何も実行していません。今すぐ本来呼び出すべき機能を実際に呼び出してください。'
      + CANVAS_NUDGE_NO_NARRATION_SUFFIX + ')',
  },
];

// BUGFIX: キャンバスに限らない「約束したのに実行しなかった」パターン。「少々お待ちください」と
//         言った直後、実際にはどの機能も呼ばないまま黙り込む。toolResponse が一度も送られない
//         ため toolResponse 起点のタイマーでは捕捉できず、別途このパターンで検知する。
// ATTENTION: 「少々」「少し」「そのまま」という前置きは任意にしてある。「そのままお待ち
//            ください」のように前置きが直接続かない言い回しを取りこぼすため。
const WAIT_PROMISE_PATTERN = /(少々|少し|そのまま)?お?待ち(くださ|ちゃ)/;
// 上と同じ意味だが、丁寧語尾（い／ね／よ）まで含めて一致させたグローバル版。
// ATTENTION: 上のパターンは「くださ」で止まるため、そのまま位置を求めると末尾の「いね。」が
//            後続テキスト側に混じり、実質的な内容の判定を誤る。
const WAIT_PROMISE_PATTERN_G = /(少々|少し|そのまま)?お?待ち(くださいませ|ください|くださ|ちゃ)(ね|よ)?/g;

// 待機を告げる言い回しの語彙。
//
// BUGFIX: この判定が「お待ち」という文字列だけを見ていたため、2回目以降が「お時間を
//         いただきます」のような別語彙になると繰り返しだと気づけず、下の文数の数えが1件に
//         留まった。結果、続行の催促が一度も送られずリスナーが聞き直すまで20秒まるごと停止した。
// ATTENTION: 「お時間」は敬語の接頭辞付きに限ること。「三時間かかります」のような実質的な
//            回答の中の所要時間の言及まで、待ち文言と誤認しないため。
const WAIT_MENTION_PATTERN   = /お待ち|お時間[をはが]?(?:いただ|頂|かか)/;
const WAIT_MENTION_PATTERN_G = /お待ち|お時間[をはが]?(?:いただ|頂|かか)/g;

/**
 * 正規表現（グローバル）が text 内で最後に一致した位置の直後を返す。
 *
 * @param {RegExp} regexG グローバルフラグ付きの正規表現
 * @param {string} text 探す対象
 * @returns {number} 最後の一致の直後の位置。一致しなければ -1
 */
function _lastMatchEndOf(regexG, text) {
  let lastEnd = -1;
  let m;
  regexG.lastIndex = 0;
  while ((m = regexG.exec(text)) !== null) lastEnd = m.index + m[0].length;
  return lastEnd;
}

/**
 * 「お待ちください」の後に、実質的な本文が実際に続いているかを見る。
 *
 * BUGFIX: 待ち文言を含みツールを1つも呼んでいないターンを一律「黙り込んだ」と判定すると、
 *         同じ発言の中できちんと回答を続けている場合まで毎回訂正ターンを送ってしまう。
 * ATTENTION: しきい値30字は実データで調整済み。言い直しに過ぎない短文（15字）は下回って
 *            検知を維持し、実際の回答（80字超）は上回って除外する。
 *
 * @param {string} text ターン全体の文字起こし
 * @returns {boolean} 実質的な本文が続いていれば true
 */
function _hasSubstantiveContentAfterWaitPromise(text) {
  const SUBSTANTIVE_THRESHOLD = 30;
  // 待ち文言の語彙が混在しても「最後の待ち文言より後」を正しく切り出せるよう、2つの語彙の
  // 出現位置のうち遅い方を採る（ここがずれると、後続の言い直しを回答と数えてしまう）。
  const lastMatchEnd = Math.max(
    _lastMatchEndOf(WAIT_PROMISE_PATTERN_G, text),
    _lastMatchEndOf(WAIT_MENTION_PATTERN_G, text),
  );
  if (lastMatchEnd === -1) return false;
  // BUGFIX: 言い回しを変えながら待ち文言を同じターン内で繰り返すケースは、「最後の出現位置
  //         より後の文字数」だけでは判定できない（2回目の言い直し自体が30字を超えてしまう）。
  //         待ち文言を含む文が2文以上あれば、文字数を問わず実質的な継続なしとみなす。
  const waitMentionSentenceCount = text.split('。').filter(s => WAIT_MENTION_PATTERN.test(s)).length;
  if (waitMentionSentenceCount >= 2) return false;
  return text.slice(lastMatchEnd).trim().length >= SUBSTANTIVE_THRESHOLD;
}

/**
 * リスナーの依頼がまだ果たされていないかを、軽量モデルに判定させる。
 *
 * Gemini Live の turnComplete は「回答し終えた」ではなく「私の番を終え、次のリスナーの入力を
 * 待つ」という意味しか持たない。モデルが「調べますね」と言い終えてターンを閉じた瞬間、
 * リスナーは処理中だと思って黙って待ち、モデルはリスナーの発話待ちで止まり、互いに相手を
 * 待ち続ける。判定したい命題は「ターンが終わり、ツールも呼ばれず、それでも依頼はまだ
 * 果たされていない」で、前2つは状態から機械的に分かるが、3つ目だけは意味の判断になる。
 *
 * ATTENTION: ここを文言マッチへ戻さないこと。喋った内容を正規表現で判定する方式は、方言・
 *            言い回しの揺れ・英語混じりのぶんだけ語彙が無限に増え続ける。上の WAIT_PROMISE 系は
 *            即時に効く高速パスとして残してあり、この関数がその取りこぼしを拾う受け皿になる。
 * ATTENTION: 判定できないときは「催促しない」側に倒すこと。誤って催促するとモデルが挨拶から
 *            やり直し、同じ返事が2回聞こえる後退が起きる。
 *
 * @param {any} params apiKey・userText・modelText・activitySessionId
 * @returns {Promise<boolean|null>} true=未達（続行を促す）／false=完了／null=判定できず
 */
async function _judgeRequestStillPending({ apiKey, userText, modelText, activitySessionId = null }) {
  if (!apiKey || !userText || !modelText) return null;
  const _t0 = Date.now();
  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: 'あなたはAI秘書とリスナーの会話を監視し、「秘書の応答でリスナーの依頼が'
        + '果たされたか、それともまだ処理が残っているか」だけを判定するアシスタントです。\n'
        + 'pending=true にするのは次の場合です:\n'
        + '・秘書が「調べます」「確認します」「お待ちください」等、これから何かをすると述べただけで、'
        + 'その結果をまだ伝えていない\n'
        + '・依頼に対して相槌・返事だけを返し、実質的な回答をまだしていない\n'
        + 'pending=false にするのは次の場合です:\n'
        + '・依頼された内容に対する回答・結果を実際に伝え終えている\n'
        + '・そもそも挨拶・雑談・お礼など、何かを実行する必要のないやり取りである\n'
        + '・秘書が「できません」「対応していません」等、明確に断りを伝えている\n'
        + '・秘書がリスナーに質問を返しており、次はリスナーが答える番になっている\n'
        + '判定は会話の見た目の丁寧さではなく「依頼された作業の結果が伝わったかどうか」だけで'
        + '行ってください。出力はJSONのみとし、説明文は含めないでください。',
      prompt: `【リスナーの依頼】\n${userText}\n\n【秘書の応答】\n${modelText}`,
      temperature: 0,
      schema: {
          type: 'object',
          properties: {
            pending: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['pending'],
        },
      agentKey: 'secretary_pending_judge',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] 依頼の未達判定に失敗（催促は行いません）: ${e.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(rawText);
    if (typeof parsed.pending !== 'boolean') return null;
    if (parsed.pending) {
      getLogger().info(`[Secretary] 依頼が未達と判定（${Date.now() - _t0}ms）: ${String(parsed.reason || '').slice(0, 80)}`);
    }
    return parsed.pending;
  } catch (e) {
    getLogger().warn(`[Secretary] 依頼の未達判定のJSON解析に失敗（催促は行いません）: ${e.message}`);
    return null;
  }
}

// 停止からの復帰を促す訂正ターンの文面。文言マッチ経路と軽量モデルでの判定経路の両方から
// 使うため、片方だけ直して食い違うことがないようここに集約する。
//
// ATTENTION: 「返事を促す」形ではなく「黙って処理を続けさせる」形にしてある。応答を求める
//            書き方にすると、モデルが律儀に挨拶からやり直し、同じ返事が2回聞こえる。
const CONTINUATION_NUDGE_TEXT = '(システムより: 処理を続行してください。あなたは既にリスナーへ待つように'
  + '伝えてあります。挨拶や返事を繰り返す必要はありません。声に出して話し直さず、'
  + '必要な機能の呼び出しだけを今すぐ行ってください。'
  + 'どうしても対応できない内容だった場合に限り、その旨を一度だけ短く伝えてください)';

/**
 * 接続時点の設定から、システム指示の組み立てに必要な値をまとめて導出する
 * （副作用なし・設定の読み取りのみ）。日付・時刻はここで一度だけ求め、同じ接続内で使い回す。
 *
 * BUGFIX: 本日の日付が無いと「本日」を取り違え、時刻が無いと時間帯に関わらず
 *         「おはようございます」になる。他チャンネルの各コーナーと同じ形式で明示的に渡す。
 *
 * @param {any} config 接続時点の設定
 * @returns {any} 秘書の設定・リスナー情報・呼び方・声・基本プロンプト・日付・時刻・相談先の名前一覧
 */
function _buildSecretaryConnectionContext(config) {
  const secretaryCfg = config.agents?.secretary || {};
  const listenerProfile = config.show?.user_profile || {};
  // ATTENTION: フルネームの発音は Gemini Live の音声ネイティブ生成では安定せず、カタカナ併記等の
  //            対策をしても誤読が再発した。「呼び方」（short_name）が設定されていればそちらを
  //            会話中の呼びかけに使い、フルネームの発音自体を避ける。
  // 誤って「さん」付きで入力された場合の保険として末尾の「さん」を取り除く
  // （既存コードは一律「さん」を付けた形で使うため）。
  const userName = (listenerProfile.short_name || listenerProfile.name || 'リスナー').replace(/さん$/, '');
  const geminiVoice = secretaryCfg.gemini_voice || secretaryCfg.voice || 'Leda';
  const basePrompt = secretaryCfg.prompt || 'あなたはリスナー専属のAI秘書です。全て日本語で会話してください。';

  const now = new Date();
  const todayFull = now.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const nowTimeStr = now.toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // 相談先を自己紹介する文で列挙する名前の一覧。
  // ATTENTION: 個別の名前を書かず、実際に受け付けるキーの一覧から都度、現在の名前を引くこと。
  const consultableAgentNames = CONSULTABLE_AGENT_KEYS
    .map((key) => config.agents?.[key]?.name)
    .filter(Boolean)
    .join('・');

  return { secretaryCfg, listenerProfile, userName, geminiVoice, basePrompt, todayFull, nowTimeStr, consultableAgentNames };
}

/**
 * 1接続分の「だんまり」監視をまとめて持つ。
 *
 * 処理中なのか無反応なのかがログを見ないと分からなかったため、一定時間 Gemini Live から
 * 何の応答も無ければ、それをクライアントへ知らせる。
 *
 * @param {any} params clientWs・ログの接頭辞・判定までの時間
 * @returns {any} 活動の記録・ツール実行中の出し入れ・停止
 */
function _createStallWatchdog({ clientWs, ch, thresholdMs = 20000 }) {
  let lastUpstreamActivityAt = Date.now();
  let stalledNotified = false;
  // ツール実行中は Gemini Live とは一切やり取りしないため、それだけで判定の時間を超えることが
  // 普通にある（正常な処理中）。この間は判定を止めないと、正常な処理中に誤って警告してしまう。
  let toolCallInFlight = false;
  const interval = setInterval(() => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    if (stalledNotified || toolCallInFlight) return;
    if (Date.now() - lastUpstreamActivityAt >= thresholdMs) {
      stalledNotified = true;
      getLogger().warn(`${ch} ${thresholdMs / 1000}秒間Gemini Liveから応答が無く、だんまり状態と判定`);
      clientWs.send(JSON.stringify({ event: 'SECRETARY_STALLED', stalled: true }));
    }
  }, 3000);

  // Gemini Live から何らかのメッセージが来るたびに「生きている」証拠として記録する。
  function markActivity() {
    lastUpstreamActivityAt = Date.now();
    if (stalledNotified) {
      stalledNotified = false;
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ event: 'SECRETARY_STALLED', stalled: false }));
      }
    }
  }
  function setToolCallInFlight(inFlight) {
    toolCallInFlight = inFlight;
    if (!inFlight) {
      // ツール実行中は判定を止めていたため、再開の時点を「今」にする
      // （実行にかかった時間を判定の数えに含めてしまわないため）。
      lastUpstreamActivityAt = Date.now();
    }
  }
  function stop() { clearInterval(interval); }

  return { markActivity, setToolCallInFlight, stop };
}

/**
 * 相談先の「本人の声」を再生している間、クライアントからの完了通知を待つための保留の並び。
 *
 * BUGFIX: 以前は単一の変数で保持していたが、1ターンに複数の相談が並行して走ると2件目の
 *         待受が1件目を上書きし、届いた完了通知が2件目のものとして消費され、1件目は
 *         タイムアウトまで打ち切られていた。単一変数をやめ、先入れ先出しの並びにして
 *         「届いた完了通知は最も古い待受から順に1件ずつ消費する」ようにする
 *         （音声はクライアント側で必ず順番に再生されるため、この対応付けが正しい）。
 *
 * @param {any} params ログの接頭辞
 * @returns {any} 待受と、最も古い待受の解決
 */
function _createAudioAckWaiter({ ch }) {
  /**
   * @type {Array<() => void>} 保留中の待受（古い順）。
   */
  const pendingResolvers = [];
  function wait(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const entry = { fn: null };
      const timeoutHandle = setTimeout(() => {
        getLogger().warn(`${ch} 本人音声の再生完了通知がタイムアウト（${timeoutMs}ms）— 会話を継続します`);
        const idx = pendingResolvers.indexOf(entry.fn);
        if (idx !== -1) pendingResolvers.splice(idx, 1);
        resolve();
      }, timeoutMs);
      entry.fn = () => { clearTimeout(timeoutHandle); resolve(); };
      pendingResolvers.push(entry.fn);
    });
  }
  /**
   * 最も古い保留中の待受を1件だけ解決する（並びから取り出すため二重解決は起きない）。
   */
  function resolveIfPending() { pendingResolvers.shift()?.(); }
  return { wait, resolveIfPending };
}

/**
 * 1ターン分の文字起こしをためて、ターンの終わりにまとめて会話履歴へ書き込む。
 *
 * 文字起こしは1ターン内で断片的に届くため、その場では書けない。書き込み自体は他チャンネルの
 * 会話履歴の記録（ローテート処理込み）をそのまま使い、ロジックを重ねない。保存先は
 * server/data/conversation_history.jsonl で、管理画面の「会話履歴」タブに出る。
 * セッション全体の発話は別にため、切断時の自動学習と日記の材料にする。
 *
 * @param {any} params エージェントシステムの取得と、リスナーの呼び方
 * @returns {any} 文字起こしの追記・書き出し・このターンの発話の取得
 */
function _createTranscriptTracker({ getAgentSystem, userName }) {
  let userTranscriptBuf = '';
  let modelTranscriptBuf = '';
  // セッション終了時の自動学習・日記の材料になる、このセッション全体の発話のやり取り。
  const fullSessionTranscript = [];

  function appendUserPart(text) { userTranscriptBuf += text; }
  function appendModelPart(text) { modelTranscriptBuf += text; }

  // BUGFIX: 相談先の回答はツールの実行中（＝ターンの途中）に即座に会話履歴へ書き込まれる
  //         一方、リスナー自身の発話はターンの終わりにまとめて書き込むため、「リスナーが
  //         質問した」より先に「相談先が回答した」行が書き込まれ、管理画面の表示順が逆転する。
  //         ツールの呼び出しを受け取った時点＝リスナーの発話は既に確定しているタイミングで、
  //         まずリスナーの発話だけを先に書き出して順序を守る。
  function flushUserOnly() {
    const trimmed = userTranscriptBuf.trim();
    if (!trimmed) return;
    fullSessionTranscript.push({ speaker: 'user', text: trimmed });
    const agentSystem = getAgentSystem?.();
    if (agentSystem) agentSystem._logConversationHistory('secretary_user', trimmed, userName);
    userTranscriptBuf = '';
  }
  /**
   * ためた文字起こしを会話履歴へ書き出し、あわせて発話の漏れを検知して返す。
   *
   * 取り除いた後のテキストには漏れの痕跡が残らない（括弧ごと消えるため）ので、判定は生の
   * バッファに対して行う。このターンで実際にキャンバス系ツールを呼んだか、何らかのツールを
   * 呼んだかを呼び出し元から受け取り、それと突き合わせる。
   *
   * @param {any} params canvasCalledThisTurn・anyToolCalledThisTurn
   * @returns {any} 4種のキャンバス関連の漏れと、待機の約束の漏れ
   */
  function flushAll({ canvasCalledThisTurn = true, anyToolCalledThisTurn = true } = {}) {
    const agentSystem = getAgentSystem?.();
    const trimmedUser = userTranscriptBuf.trim();
    if (trimmedUser) {
      fullSessionTranscript.push({ speaker: 'user', text: trimmedUser });
      if (agentSystem) agentSystem._logConversationHistory('secretary_user', trimmedUser, userName);
    }
    const rawModelText = modelTranscriptBuf.trim();
    const canvasLeakDetected = !canvasCalledThisTurn && CANVAS_NARRATION_LEAK_PATTERN.test(rawModelText);
    const canvasFalseFailureDetected = !canvasCalledThisTurn && CANVAS_FALSE_FAILURE_PATTERN.test(rawModelText);
    // 上の2つ（疑似構文の漏れ／起きてもいない失敗の主張）に加え、「画面に表示しておきますね」の
    // ような自然な言い回しでの未実行を検知する3つ目のパターン。
    const canvasPromiseLeakDetected = !canvasCalledThisTurn && CANVAS_PROMISE_LEAK_PATTERN.test(rawModelText);
    // ツール名を問わない疑似構文の漏れ。上の3つはいずれもキャンバス関連の言い回しに絞っている
    // ため取りこぼす、生の「call:関数名{」という構文そのものをここで拾う。
    const pseudoCallSyntaxDetected = !anyToolCalledThisTurn && PSEUDO_CALL_SYNTAX_PATTERN.test(rawModelText);
    // 待ち文言に一致しても、その後に実質的な回答が続いていれば誤検知になる
    // （_hasSubstantiveContentAfterWaitPromise が弾く）。
    // 「お待ちください」と一度も言わず「少々お時間をいただきます」だけで待たせるケースも同じ
    // 停止パターンになるため、そちらの語彙も一致条件に加える。
    const waitPromiseLeakDetected = !anyToolCalledThisTurn
      && (WAIT_PROMISE_PATTERN.test(rawModelText) || WAIT_MENTION_PATTERN.test(rawModelText))
      && !_hasSubstantiveContentAfterWaitPromise(rawModelText);
    const cleanedModelText = stripToolCallLeak(rawModelText);
    if (cleanedModelText) {
      fullSessionTranscript.push({ speaker: 'secretary', text: cleanedModelText });
      if (agentSystem) agentSystem._logConversationHistory('secretary', cleanedModelText);
    }
    userTranscriptBuf = '';
    modelTranscriptBuf = '';
    return { canvasLeakDetected, canvasFalseFailureDetected, canvasPromiseLeakDetected, pseudoCallSyntaxDetected, waitPromiseLeakDetected };
  }

  /**
   * このターンでモデルが既に何か話していたかを返す。
   *
   * ためているバッファはターンの終わりに空になるため、ツールの呼び出しを受け取った時点で
   * これが空かどうかを見れば「前置きを言わずに無言で呼んだ」のか「前置きは生成されていたのに
   * 音声が届いていない」のかを切り分けられる（会話履歴のテキストだけでは、前置きがツールの
   * 呼び出しの前に生成されたのか後なのかを判別できない）。
   *
   * @returns {string} このターンでこれまでに話した内容
   */
  function getModelSpokenSoFar() { return modelTranscriptBuf.trim(); }

  return { appendUserPart, appendModelPart, flushUserOnly, flushAll, getModelSpokenSoFar, getFullTranscript: () => fullSessionTranscript };
}

/**
 * My Secretary 用の WebSocket サーバーに接続ハンドラを登録する。
 *
 * 接続ごとに Gemini Live セッションを1本張り、ブラウザ ⇄ サーバー ⇄ Gemini Live の中継を行う。
 *
 * @param {import('ws').WebSocketServer} wssSecretary 接続を待ち受ける WebSocket サーバー
 * @param {any} ctx 設定・認証情報の読み出し、各チャンネルの参照、ダッシュボードへの通知フック
 */
function registerSecretaryLiveWs(wssSecretary, ctx) {
  const {
    readJsonFile, getInitialConfig, getInitialCredentials, CONFIG_PATH, CREDENTIALS_PATH, TTS_DICT_PATH, getAgentSystem,
    getChannelSystem,
    // ダッシュボード向けの観測フック。My Secretary は他チャンネルのような集約バスに乗らない
    // 1対1の中継のため、既存の判定箇所へ1行ずつ足す形で稼働状態（待機／調べ物中／発話中）を
    // 知らせるだけにしてある（制御の流れには一切影響しない）。onConsulting は相談先の本人の声を
    // 再生している区間——チャンネル画面のアバターが相談先へ切り替わっている区間——を別軸で知らせる。
    onActivity, onDiaryWritten, onConsulting,
  } = ctx;

  wssSecretary.on('connection', (clientWs) => {
    const ch = '[Secretary]';
    getLogger().info(`${ch} クライアント接続`);

    // 稼働レポート用セッション（他チャンネルのopenSession('live')等と同じ仕組み）。
    // これが無いと「稼働レポート」画面にSecretaryの利用が一切反映されない。
    const activitySessionId = activityDb.openSession('secretary');

    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    const apiKey = creds.gemini?.api_key;
    if (!apiKey) {
      getLogger().warn(`${ch} Gemini APIキー未設定のため接続を拒否`);
      clientWs.send(JSON.stringify({ event: 'SECRETARY_ERROR', message: 'Gemini APIキーが設定されていません' }));
      clientWs.close();
      activityDb.closeSession(activitySessionId);
      return;
    }

    const config = readJsonFile(CONFIG_PATH, getInitialConfig());
    const {
      secretaryCfg, listenerProfile, userName, geminiVoice, basePrompt, todayFull, nowTimeStr, consultableAgentNames,
    } = _buildSecretaryConnectionContext(config);
    const ttsDict = readJsonFile(TTS_DICT_PATH, []);
    // プロンプトの組み立ては server/lib/secretary-prompt.js に集約している。
    const systemInstructionText = buildSystemInstructionText({
      todayFull, nowTimeStr, secretaryName: secretaryCfg.name, basePrompt, userName,
      listenerProfile, ttsDict, consultableAgentNames, obsidianEnabled: config.obsidian?.enabled,
    });

    let setupComplete = false;
    let clientClosed = false;
    let upstreamClosed = false;
    // BUGFIX: 「発話中」は音声チャンクを含む全メッセージで呼ばれるため、そのまま通すと1回の
    //         発話中に1秒間で何十回も発火し、ダッシュボードのフィードが同じ行で埋まる。
    //         状態が実際に変わったときだけ知らせる。
    let _lastDashboardActivity = null;
    const notifyDashboardActivity = (state) => {
      if (state === _lastDashboardActivity) return;
      _lastDashboardActivity = state;
      onActivity?.(state);
    };
    // 「toolResponse は送ったのに turnComplete が来ない」状態だけを追う専用タイマーの枠。
    //
    // ATTENTION: 汎用のだんまり監視（20秒・接続の生死確認とクライアント表示用）とは役割を分ける。
    //            こちらは何を待っているか（モデル自身の短い一言だけ）が完全に分かっているため、
    //            より早く介入してよい。
    // BUGFIX: 10秒では、まだ応答を組み立てている最中に割り込んでしまう（ツールが2つ続いた回では、
    //         自然な応答の完了まで実測15秒以上かかっていた）。そこへ新しいユーザーターンを送ると
    //         Gemini Live 側が想定外の状態になり、リスナーは繋がったままなのにセッションが
    //         打ち切られる。20秒の汎用監視より明確に短く保ちつつ、安全マージンを持たせてある。
    const PROMISE_FOLLOWUP_TIMEOUT_MS = 16000;
    // 無音に入る直前にモデルが喋っていた場合に使う、長い方の枠。
    //
    // BUGFIX: 組み込みの Google 検索は Google 側のサーバー内で完結し、こちらへツールの呼び出しが
    //         一切届かない。つまり「検索中」という状態を知る手段が無く、upstream がただ無音に
    //         なるだけなので、短い枠では停止と誤判定して訂正ターンを送ってしまう。訂正ターンは
    //         新しいユーザー発話として届くため割り込み扱いになり、生成中だった音声がその場で切れる。
    //         ・喋っていない … 本来の停止パターン。切るべき音声が無いので短い枠のまま。
    //         ・喋っていた   … ターンの途中で、見えない処理の最中である可能性が高いので長い枠。
    // 長い方へ倒しても、汎用の監視がクライアントへ「応答がありません」を知らせる経路は働くため、
    // リスナーが何も知らされないまま待たされることはない。
    const PROMISE_FOLLOWUP_MIDTURN_TIMEOUT_MS = 45000;
    // 直近の armPromiseFollowupTimer 以降に、モデルが実際に発話（音声・文字起こし）を
    // 届けてきたか。上記の枠の出し分けに使う。
    let modelSpokeSinceArm = false;
    let promiseFollowupTimer = null;
    function clearPromiseFollowupTimer() {
      if (promiseFollowupTimer) {
        clearTimeout(promiseFollowupTimer);
        promiseFollowupTimer = null;
      }
    }
    // キャンバス表示の漏れ検知用の状態。このターンで表示ツールが実際に呼ばれたか、
    // この漏れに対して既に訂正ターンを1回送ったか（無限に繰り返さないため1回だけ）。
    // いずれもターンの終わりの処理でリセットする。
    let canvasCalledThisTurn = false;
    let canvasNudgeSentThisLeak = false;
    // 「少々お待ちください」と言ったきり何も呼ばずに黙り込むケース用の同種の状態。
    // こちらはツール名を問わず、1つでも呼ばれていれば true にする。
    let anyToolCalledThisTurn = false;
    let waitPromiseNudgeSentThisLeak = false;
    // ターンごとの音声チャンクの数とバイト数。「文字起こしは会話履歴に残っているのに音声は
    // 一切聞こえなかった」事象の切り分けに使う。文字起こしと音声チャンクは Gemini Live 側で
    // 独立したストリームであり、この中継は全メッセージを無条件に転送するだけなので、
    // 中継側の欠陥でこの2つが乖離することはない。
    let turnAudioChunkCount = 0;
    let turnAudioByteCount = 0;
    // 軽量モデルによる「依頼が未達か」判定用の状態。判定は非同期（実測0.5〜1秒）のため、
    // その待ち時間の間に状況が変わっていたら結果を捨てる必要がある。この値は「判定結果を
    // 無効にすべき出来事」（リスナーの発話・ツールの呼び出し・次のターンの完了）のたびに進み、
    // 判定を始めた時の値と違っていれば催促を取り止める。
    let activityEpoch = 0;
    // 1つの依頼につき催促は1回まで（催促→モデルがまた喋るだけ→また催促、の無限ループを防ぐ）。
    // リスナーが次に発話した時点、またはツールが実際に呼ばれた時点で解除する。
    let judgeNudgeSentSinceUserTurn = false;
    // 待機の約束を検知してから、訂正ターンを送るまでの猶予。
    //
    // ATTENTION: この催促は誤検知ではなく、必須の復帰手段。Gemini Live は turnComplete の時点で
    //            リスナーの次の入力を待つため、「お待ちください」と言い切ったモデルは来ることの
    //            ない入力を待ち続けて停止する。実測でも、モデルが自発的にツールを呼んだ例は
    //            通算1件も無い（ツールの呼び出しは必ず催促の0.4〜1.6秒後に届く）。
    // ATTENTION: 猶予の役目は「ターンの終わりとツールの呼び出しがほぼ同時に届く、メッセージの
    //            順序の揺れ」を吸収することだけ。延ばしてもその分リスナーを無音で待たせるだけで、
    //            何も改善しない（猶予0秒・5秒・12秒での実測で確認済み）。
    // BUGFIX: 同じ返事が2回聞こえる原因は猶予の長さではなく、催促の文面だった
    //         （CONTINUATION_NUDGE_TEXT 参照）。
    // このタイマーはターンの終わり（＝モデルが発話を終えた時点）から数え始めるため、短くしても
    // 発話の途中に割り込むことはない。
    const WAIT_PROMISE_NUDGE_GRACE_MS = 1200;
    let waitPromiseNudgeTimer = null;
    function clearWaitPromiseNudgeTimer() {
      if (waitPromiseNudgeTimer) {
        clearTimeout(waitPromiseNudgeTimer);
        waitPromiseNudgeTimer = null;
      }
    }
    // 疑似構文の漏れ用の、一回限りのガード（他の漏れ検知と同じ。無限に繰り返さないため）。
    let pseudoCallNudgeSentThisLeak = false;
    // 同一ツール名・同一引数の呼び出しが連続して失敗した場合の、決定的な歯止め。
    //
    // BUGFIX: API キーが未設定で検索が失敗し続けたとき、モデルが自発的に「もう一度同じ条件で
    //         検索してみますね」と宣言してはやり直すのを20回以上繰り返し、最後は Gemini Live 側の
    //         強制切断を招いた。プロンプトの指示だけでは、モデル自身の善意のやり直し判断までは
    //         止められなかった。
    // ATTENTION: 停止の指示は toolResponse へ注入すること。モデルは実行結果を必ず読んでから次の
    //            出力を組み立てるため、プロンプトの一般則より確実に効く。
    let lastFailedToolCallKey = null;
    let lastFailedToolCallCount = 0;
    // Gemini Live のセッション上限の予告（接続後10〜15分程度で必ず届く）を受け取ったか。
    //
    // BUGFIX: 受け取っても何もしないでいると、Gemini 側が実際に打ち切るまでの無音区間
    //         （実測で最大50秒）が生じる。その間の問いかけには一切応答が無く、汎用の監視が
    //         だんまりと誤検知し、最後は Gemini 側からの強制切断で終わる。
    // ATTENTION: 予告を受けたら「予告してから切る」のではなく、セッション再開の仕組みで
    //            そもそも切らない。締めくくりの挨拶を挟んでも、リスナーがまだ話したい内容が
    //            残っている限り、一方的に打ち切ること自体が解決になっていないため。
    // BUGFIX: 移行の起点を「予告後の最初の正常なターンの終わり」だけにすると、予告が会話の切れ目
    //         （どちらも喋っていない時間帯）に届いた場合、その後ターンの終わりが一度も来ず、
    //         再開処理が走らないまま無警告で強制切断される。予告が届く時刻は接続からの経過時間
    //         だけで決まり会話のリズムとは無関係なので、切れ目に当たるのはむしろ当たり前だった。
    //         対策は2つで、①予告を受けた時点でやり取りが進行中でなければその場で直ちに移り、
    //         ②それでも取りこぼす場合に備えて残り時間から逆算した締切タイマーを必ず立てる。
    //         ①②とも合流先は handleGoAwayTransition。
    let goAwayReceived = false;
    let goAwayWrapUpSent = false;
    // 予告から実際の強制切断までの猶予（残り時間）から差し引く安全マージン。
    // 再開のハンドシェイクの枠が8秒なので、それを丸ごと使い切っても間に合う余裕を残す。
    const GO_AWAY_DEADLINE_MARGIN_MS = 15000;
    let goAwayDeadlineTimer = null;
    // 再開を二重に起動しないためのガード。上の①②とターンの終わりの経路の3つが同じ処理へ
    // 合流するため、候補の接続が同時に複数生まれるのを防ぐ。
    let resumptionInFlight = false;
    // 予告を受けた時点で「モデルまたはリスナーのやり取りが進行中か」。応答やツールの呼び出しを
    // 受けた時点で true、ターンの終わりで false。進行中でなければ待たずに再開してよい。
    let upstreamExchangeActive = false;
    function clearGoAwayDeadlineTimer() {
      if (goAwayDeadlineTimer) {
        clearTimeout(goAwayDeadlineTimer);
        goAwayDeadlineTimer = null;
      }
    }
    // Gemini Live から届く最新のセッション再開ハンドル。
    // ATTENTION: 再開可能でない間（モデルが関数呼び出し・生成の最中）は空で届くため、その間は
    //            更新しないこと。常に「再開可能だった直近の状態」を指すようにするため。
    let lastResumptionHandle = null;
    // 再開のため、古い接続を意図的に閉じている最中かどうか。true の間は切断時の後始末
    // （学習内容の要約・日記の生成・クライアント側の切断の連鎖）を一切行わない
    // ——会話はまだ終わっていないため。
    let intentionalUpstreamSwap = false;

    const audioAckWaiter = _createAudioAckWaiter({ ch });
    // この接続でアップロードされたファイルの ID。決算書等の機密文書を想定し、
    // セッション終了時（どちらの切断経路でも）にまとめて削除する保持ポリシーにしてある。
    const uploadedFileIds = new Set();
    const transcriptTracker = _createTranscriptTracker({ getAgentSystem, userName });

    // 接続したまま長時間離席した場合に、自動的に会話を終了する安全弁。セッション再開により、
    // 会話が続いている限り接続は無期限に延命されうるため、誰も使っていない場合まで API の利用が
    // 続いてしまわないようにする。
    //
    // ATTENTION: ここでの「活動」は、だんまり監視の方（メッセージが来るだけで発火する、単なる
    //            接続の生死確認）とは意図的に区別する。実際に会話が動いたと言える兆候（リスナー・
    //            秘書の発話・ターンの終わり・ツールの呼び出し）に限ること。マイクが繋がったまま
    //            無音の音声が送られ続けるだけでは活動とみなさない（そうするとこの安全弁自体が
    //            意味を失う）。
    const IDLE_DISCONNECT_TIMEOUT_MS = 5 * 60 * 1000;
    let lastRealActivityAt = Date.now();
    let idleDisconnectTriggered = false;
    function markRealActivity() {
      lastRealActivityAt = Date.now();
    }
    const idleDisconnectInterval = setInterval(() => {
      if (idleDisconnectTriggered) return;
      if (Date.now() - lastRealActivityAt < IDLE_DISCONNECT_TIMEOUT_MS) return;
      idleDisconnectTriggered = true;
      getLogger().info(`${ch} ${IDLE_DISCONNECT_TIMEOUT_MS / 60000}分間実質的な会話の動きが無いため、離席とみなして自動的に接続を終了します`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ event: 'SECRETARY_IDLE_TIMEOUT' }));
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    }, 30000);

    // ATTENTION: 再開時にこの変数自体を新しい接続へ差し替えるため const にしない。この関数
    //            スコープ内の他のクロージャは変数参照で見ているため、再代入するだけで自動的に
    //            「現在アクティブな接続」へ追従する。
    let upstream = new WebSocket(liveClient.buildConnectUrl(encodeURIComponent(apiKey)));

    /**
     * 「結果を伝える」という約束をした瞬間（toolResponse の送信・発話の開始）にタイマーを立てる。
     *
     * BUGFIX: 固定のカウントダウンにすると、生成そのものに時間がかかる正常な処理の最中に無条件で
     *         割り込んでしまう。それは Gemini Live では「リスナーの割り込み発話」と同じ扱いに
     *         なるため、モデルが生成中だった本来の応答が打ち切られる——「少々お待ちください」だけ
     *         言って本題に入らないまま黙り込む症状の直接の原因だった。だんまり監視と同じ
     *         「活動があるたびに締切を先送りする」方式にし、upstream の全メッセージで
     *         bumpPromiseFollowupTimer を呼ぶことで、本当に何も起きていない区間だけを検知する。
     */
    function armPromiseFollowupTimer() {
      clearPromiseFollowupTimer();
      // 既に喋り始めているターンの途中なら、無音は見えない処理の最中である可能性が高いので
      // 長い枠を使う。
      const timeoutMs = modelSpokeSinceArm
        ? PROMISE_FOLLOWUP_MIDTURN_TIMEOUT_MS
        : PROMISE_FOLLOWUP_TIMEOUT_MS;
      promiseFollowupTimer = setTimeout(() => {
        promiseFollowupTimer = null;
        if (upstream.readyState === WebSocket.OPEN) {
          getLogger().warn(`${ch} ${timeoutMs / 1000}秒間upstreamの活動が無くturnCompleteも来ないため、訂正ターンを自動送信します`
            + `（このターンでモデルの発話${modelSpokeSinceArm ? 'あり — グラウンディング等の可能性を考慮した長い枠' : 'なし — 応答が一度も返っていない'}）`);
          upstream.send(liveClient.encodeUserText('(システムより: しばらく応答がありません。直前の処理は完了しているはずです。結果を短く伝えてください)'));
          // 訂正ターンを送った＝ここから新しい待機区間。以後の無音は「催促したのに
          // 一言も返ってこない」状態なので、短い枠で判定してよい。
          modelSpokeSinceArm = false;
        }
      }, timeoutMs);
    }
    /**
     * 約束が現在進行中のときだけ、upstream の活動を締切の先送りとして扱う。
     * 約束が無い通常時は何もしないため、無関係な活動のたびにタイマーを新設することはない。
     */
    function bumpPromiseFollowupTimer() {
      if (promiseFollowupTimer) armPromiseFollowupTimer();
    }

    const watchdog = _createStallWatchdog({ clientWs, ch });

    // ヘルパーエージェントからこのセッションへ結果を届けるための仲介。
    // upstream はこの接続のクロージャの中に閉じているため、裏で走るジョブが完了しても外側からは
    // 触れない。必要な操作だけをシングルトンの登録簿経由で公開する。
    //
    // ATTENTION: モデルが生成中にターンを注入すると割り込み扱いになり、再生中の音声がその場で
    //            切られる。生成中に完了したジョブは、次のターンの終わりまで配信を待たせること。
    let _pendingDeliveries = [];
    const liveSession = {
      injectSystemTurn(text) {
        if (upstream.readyState !== WebSocket.OPEN) return;
        upstream.send(liveClient.encodeUserText(text));
      },
      sendCanvas({ title, content, imageBase64, imageMime }) {
        if (clientWs.readyState !== WebSocket.OPEN) return;
        clientWs.send(JSON.stringify({ event: 'CANVAS_UPDATE', title, content, imageBase64, imageMime }));
        // BUGFIX: ここで画面に出した回も「このターンで画面に出した」と数える。数えないと、ヘルパーの
        //         結果を配信した直後に秘書が「画面に出しておきますね」と言ったとき、言っただけで
        //         実行していないと誤判定され、show_on_canvas が呼び直されて同じ内容が2回出る。
        canvasCalledThisTurn = true;
      },
      /** @param {any} payload */
      sendJobStatus(payload) {
        if (clientWs.readyState !== WebSocket.OPEN) return;
        clientWs.send(JSON.stringify({ event: 'SECRETARY_JOB_STATUS', ...payload }));
      },
      // 「直近の待機区間でモデルが喋ったか」はターンの終わりで false へ戻されるため、
      // true の間は生成中とみなせる。
      isBusy() { return modelSpokeSinceArm; },
      deferDelivery(fn) { _pendingDeliveries.push(fn); },
    };
    function flushPendingDeliveries() {
      if (_pendingDeliveries.length === 0) return;
      // このターンの終わりの処理中に訂正ターンが送られた場合、モデルは今まさにそれへ応答しようと
      // している。そこへ結果を注入すると再び割り込みになるため、次のターンの終わりまで待たせる
      // （訂正ターンを送ると必ずタイマーが張り直されるので、その有無で判定できる）。
      if (promiseFollowupTimer) {
        getLogger().debug(`${ch} 訂正ターン送信直後のため、ジョブ結果の配信をさらに保留します`);
        return;
      }
      const queued = _pendingDeliveries;
      _pendingDeliveries = [];
      getLogger().info(`${ch} 保留していたジョブ結果${queued.length}件を配信します`);
      for (const fn of queued) {
        try { fn(); } catch (e) { getLogger().warn(`${ch} 保留配信で例外: ${e.message}`); }
      }
    }
    sessionRegistry.setActiveSession(liveSession);
    // BUGFIX: 今まさに動いている仕事を、つなぎ直した直後にも画面へ出す。進み具合は動きがあったときにしか
    //         送られないため、これが無いと、会話の途中で入り直したリスナーには何も動いていないように見える。
    for (const job of jobStore.listRunningJobs()) {
      liveSession.sendJobStatus({
        id: job.id, kind: job.kind || 'helper', status: job.status,
        request: job.request || '', progress: job.progress || '',
      });
    }

    /**
     * upstream の setup メッセージ本体を組み立てる。
     *
     * 初回接続・セッション再開のどちらでも使う。再開ハンドルを渡すとその状態から会話を続け、
     * 省略すると新規セッションを始めつつ、Gemini 側からのハンドル配信を有効にする。
     *
     * @param {any} resumeHandle 再開ハンドル。新規接続では null
     * @returns {any} setup の中身
     */
    function buildUpstreamSetupPayload(resumeHandle) {
      // 設定の形はプロバイダごとに違うため、意図（声・システム指示・ツール・再開ハンドル）だけを
      // 渡し、ワイヤ形式への変換は live-client に任せる。
      return liveClient.buildSetupPayload({
        voice: geminiVoice,
        systemInstruction: systemInstructionText,
        tools: buildSecretaryTools(config),
        resumeHandle,
      });
    }

    /**
     * upstream 用のイベントハンドラをまとめて1つの WebSocket へ登録する。
     * 初回接続・セッション再開の両方から呼ぶ共通処理。
     *
     * ATTENTION: 自分自身への送信は必ず引数の ws を使い、外側の upstream 変数（「現在アクティブな
     *            接続」を指し、再接続のたびに差し替わる）とは区別すること。再開のハンドシェイク中は
     *            まだ切り替えが済んでおらず、区別を怠ると送信が誤って古い接続へ飛ぶ。
     *
     * @param {any} ws ハンドラを登録する WebSocket
     * @param {any} params isResumption（再開時は起動用の挨拶ターンを送らない）
     */
    function attachUpstreamHandlers(ws, { isResumption }) {
      ws.on('open', () => {
        getLogger().info(`${ch} Gemini Liveへ接続、setup送信${isResumption ? '（セッション再開）' : ''}`);
        ws.send(liveClient.encodeSetup(buildUpstreamSetupPayload(isResumption ? lastResumptionHandle : null)));
      });

      ws.on('message', (data) => {
        const raw = data.toString();
        // Gemini Live から何らかのメッセージが来るたびに「生きている」証拠として記録する
        // （だんまり監視がこれを参照する）。
        watchdog.markActivity();
        // 同じ理由で、約束のタイマーの締切もストリーミング中の活動により先送りする。
        bumpPromiseFollowupTimer();

        // toolCallはサーバー側で処理してtoolResponseを返す必要があるため中身を見る。
        // それ以外（setupComplete・音声チャンク等）は中身を解釈せずそのままクライアントへ中継する。
        try {
          const parsed = JSON.parse(raw);
          // ここから下は中立化した ev を見る。Gemini のワイヤ形式を直接読まないことで、
          // 会話運用のロジックがプロバイダに依存しなくなる。
          const ev = liveClient.decodeServerMessage(parsed);

          if (ev.ready && !setupComplete && !isResumption) {
            setupComplete = true;
            getLogger().info(`${ch} setup完了、プロアクティブ挨拶を起動`);
            // Live API の自動の発話に頼らず、確実に秘書側から話し始めさせるための起動用ターン。
            //
            // ATTENTION: フルネームの読み方をテキストで指示しても発音は安定しない（読み方の明示・
            //            カタカナ併記のどちらでも、指示と無関係な一般的な人名パターンへの誤読が再発した）。
            //            「呼び方」が設定されていれば呼びかけは既に短い形になっているため、ここで
            //            追加の読み方指示はしない。カタカナ併記のリマインダーは、未設定のまま
            //            フルネーム運用を続ける場合の当面のフォールバック。
            const nameReading = listenerProfile.short_name ? null : listenerProfile.name_reading;
            const nameReadingKatakana = nameReading
              ? nameReading.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
              : '';
            const readingReminder = nameReading
              ? `。「${userName}」は必ず「${nameReading}」（カタカナ表記: ${nameReadingKatakana}）と`
                + `発音してください（他の読み方は絶対にしないこと）`
              : '';
            ws.send(liveClient.encodeUserText(`(セッションが開始されました。まず${userName}さんへの挨拶から会話を始めてください${readingReminder})`));
          }

          // セッション再開用のハンドル。再開可能でない間（モデルが関数呼び出し・生成の最中）は
          // 空で届くため、その場合は更新せず、常に「直近の再開可能だった状態」を指すようにする。
          if (ev.resumptionHandle) {
            lastResumptionHandle = ev.resumptionHandle;
          }

          // セッション終了の予告。下の中継でクライアントへもそのまま渡るが、実際の切断の導線としては
          // 使わせない（再開に成功すればクライアント側は何も気づかない）。
          // ここではやり取りが進行中かどうかを記録する——予告を受けた時に「ターンの終わりを待つ意味が
          // あるか」を判断する材料になる。
          if (ev.activity) {
            upstreamExchangeActive = true;
          }

          if (ev.goAwayRaw !== null) {
            goAwayReceived = true;
            const timeLeftMs = ev.goAwayMs;
            getLogger().info(`${ch} Live APIからgoAway受信（timeLeft=${ev.goAwayRaw || '不明'}）— セッション再開を試みます`);
            // まず締切タイマーを必ず立てる。これが最後の砦であり、下の即時移行が使えなかった場合でも、
            // 無警告の強制切断だけは防ぐ。
            armGoAwayDeadline(ws, timeLeftMs);
            // やり取りが進行中でなければ、ターンの終わりを待つ理由が無い（待っても来ない）。
            // 会話の切れ目に予告が届くケースこそが、実地で起きた障害の原因だった。
            if (!upstreamExchangeActive) {
              getLogger().info(`${ch} goAway受信時点でやり取りが進行中でないため、turnCompleteを待たず直ちに移行します`);
              handleGoAwayTransition(ws);
            }
          }

          // 割り込み（バージイン）の通知。クライアントはこれを受けると再生待ちの音声を全て破棄するため、
          // 「生成はされていたのに聞こえなかった」場合の有力な手がかりになる。
          if (ev.interrupted) {
            getLogger().info(`${ch} 割り込み（interrupted）を受信 — クライアントは再生待ちの音声を破棄します`);
          }

          // 文字起こしは1ターン内に複数回へ分割されて届くため、ターンの終わりまでためてから
          // まとめて会話履歴へ書き込む。
          if (ev.inputTranscript) {
            transcriptTracker.appendUserPart(ev.inputTranscript);
            markRealActivity();
            // リスナーが喋った＝停止は解消し、依頼も新しくなった。判定待ちの結果があれば無効にし、
            // 催促の回数制限もここで解除する。
            activityEpoch += 1;
            judgeNudgeSentSinceUserTurn = false;
          }
          if (ev.outputTranscript) {
            transcriptTracker.appendModelPart(ev.outputTranscript);
            markRealActivity();
            // ATTENTION: ここは内容に依存しない生存監視にしてある。モデルがこのターンで話し始めた時点で、
            //            まだツールを1つも呼んでいなければ無条件にタイマーを起動し、「何を言ったか」は
            //            一切見ない。口調を変える設定の下では言い回しが無数に揺れるため、文言での検知は
            //            本質的に脆い。既に何らかのツールが呼ばれていれば、toolResponse 起点の仕組みに
            //            委ねてここでは何もしない。以後の活動は締切を自動的に先送りするため、モデルが
            //            話し続けている限りここで割り込むことはない。
            // モデルが実際に喋ったことを記録する。この後に訪れる無音は「ターンの途中の見えない処理」で
            // ある可能性が高く、長い枠を選ぶ材料になるため、タイマーを立てるより前に記録すること。
            modelSpokeSinceArm = true;
            if (!anyToolCalledThisTurn) {
              armPromiseFollowupTimer();
            }
          }

          // 管理画面で録音中のときだけ、応答音声（24kHz PCM16）を録音バッファへ渡す。
          // 録音していない間は null の確認だけで実質コストは無い。
          // 音声チャンクは live-client が中立な形（base64 の配列）で渡してくる。
          if (ev.audioChunks.length > 0) {
            // ダッシュボード向け: 音声が含まれていれば「発話中」を通知
            // （client側のuseSecretaryLive.tsのisSpeaking判定と同じ条件）。
            notifyDashboardActivity('speaking');
            // 文字起こし（outputTranscription）が届かない構成でも取りこぼさないよう、
            // 実際の音声チャンクでも「喋った」と記録する（上と同じ理由）。
            modelSpokeSinceArm = true;
            // ターンごとの音声チャンクの数とバイト数を集計する。
            for (const _b64 of ev.audioChunks) {
              turnAudioChunkCount += 1;
              turnAudioByteCount += _b64.length;
            }
            const _activeRec = secretaryRecorder.getActiveRecorder();
            if (_activeRec) {
              // 秘書の発話中はマイク入力を録音対象から外すゲート。ターンの終わりまで維持する。
              _activeRec.setModelSpeaking(true);
              for (const _b64 of ev.audioChunks) _activeRec.append(Buffer.from(_b64, 'base64'), 24000);
            }
          }

          // BUGFIX: バージイン（発話中にリスナーが話し始める）では、ターンの終わりより先に割り込みが
          //         届くことがある。ここでゲートを解除しないと、割り込んだリスナー自身の発話が
          //         録音から漏れる。
          if (ev.interrupted) {
            secretaryRecorder.getActiveRecorder()?.setModelSpeaking(false);
            notifyDashboardActivity('idle');
          }

          if (ev.turnComplete) {
            markRealActivity();
            notifyDashboardActivity('idle');
            // やり取りが完結したので「進行中」を下ろす。以後に終了予告が届いた場合は、
            // ターンの終わりを待たずその場で移行してよい状態になる。
            upstreamExchangeActive = false;
            // ターンが終わったので「このターンで喋ったか」を戻す。次に待つのは新しいターンの開始であり、
            // そこでの無音は「一言も返ってこない」＝本来の停止パターンなので、短い枠で判定してよい。
            modelSpokeSinceArm = false;
            // モデルが空いたので、生成中で保留していたジョブの結果があれば流す。すぐに流さず遅らせるのは、
            // この下の訂正ターンの判定が全て終わってから配信するため（先に配信すると、その判定が
            // 古いターンを根拠に走ってしまう）。
            setImmediate(flushPendingDeliveries);
            // 送信待ちの訂正ターンがあれば一旦取り消し、この新しいターンの内容で判定し直す
            // （下の各検知が必要なら再度セットする）。猶予の間に別のターンが完結したということは会話が
            // 進んでいるので、古いターンを根拠にした催促をそのまま送るのは誤りになる。
            clearWaitPromiseNudgeTimer();
            // Geminiの発話ターンが終わったので、以後のマイク入力を録音対象へ戻す。
            secretaryRecorder.getActiveRecorder()?.setModelSpeaking(false);
            // 音声チャンクの集計を、文字起こしの文字数と突き合わせてログに残す（バッファが空になる前に
            // 読む）。文字起こしは十分あるのに音声チャンクが0件・極端に少ない場合、「文字は生成された
            // のに聞こえなかった」事象の再発を示す強い手がかりになる。
            const _turnModelText = transcriptTracker.getModelSpokenSoFar();
            const _turnTranscriptChars = _turnModelText.length;
            // else の側で false へ戻される前に確保する。
            const _hadToolCallThisTurn = anyToolCalledThisTurn;
            // このターンの終わりも「判定結果を無効にすべき出来事」。判定を仕掛ける直前に進めておき、
            // 直後に控えを取ることで、以後に別の出来事が起きた場合だけ食い違うようにする。
            activityEpoch += 1;
            if (_turnTranscriptChars > 0 && turnAudioChunkCount === 0) {
              getLogger().warn(`${ch} このターンは文字起こしが${_turnTranscriptChars}文字あるのに音声チャンクが0件でした`
                + '（音声が聞こえなかった可能性があります）');
            } else if (_turnTranscriptChars > 0 || turnAudioChunkCount > 0) {
              getLogger().debug(`${ch} ターン終了: 文字起こし${_turnTranscriptChars}文字 / 音声チャンク${turnAudioChunkCount}件（計${turnAudioByteCount}バイト、base64長）`);
            }
            turnAudioChunkCount = 0;
            turnAudioByteCount = 0;
            const { canvasLeakDetected, canvasFalseFailureDetected, canvasPromiseLeakDetected, pseudoCallSyntaxDetected, waitPromiseLeakDetected } = transcriptTracker.flushAll({
              canvasCalledThisTurn, anyToolCalledThisTurn,
            });
            // 同型の4分岐は表（CANVAS_LEAK_NUDGE_RULES）へ切り出してある。最初に一致した1件だけを
            // 処理する（元の if/else if の連鎖と同じ「最初の一致で確定」という優先順位を保つ）。
            const _leakDetections = {
              canvasFalseFailureDetected, canvasLeakDetected, canvasPromiseLeakDetected, pseudoCallSyntaxDetected,
            };
            const _leakGuards = { canvasNudgeSentThisLeak, pseudoCallNudgeSentThisLeak };
            const _matchedLeakRule = CANVAS_LEAK_NUDGE_RULES.find(
              (rule) => _leakDetections[rule.detectedKey] && !_leakGuards[rule.guardFlagKey]
            );
            if (_matchedLeakRule) {
              if (_matchedLeakRule.guardFlagKey === 'canvasNudgeSentThisLeak') canvasNudgeSentThisLeak = true;
              else pseudoCallNudgeSentThisLeak = true;
              canvasCalledThisTurn = false;
              anyToolCalledThisTurn = false;
              armPromiseFollowupTimer();
              getLogger().warn(`${ch} ${_matchedLeakRule.warnMessage}`);
              ws.send(liveClient.encodeUserText(_matchedLeakRule.correctionText));
            } else if (waitPromiseLeakDetected && !waitPromiseNudgeSentThisLeak) {
              // 「少々お待ちください」と言いながら、そのターン中に一切ツールを呼ばないまま黙り込んだ場合。
              // toolResponse が一度も送られないため、toolResponse 起点の仕組みでは捕捉できない。
              // キャンバスの場合と同様、訂正ターンを1回だけ自動送信する。
              anyToolCalledThisTurn = false;
              // 組み込みの Google 検索は Google 側のサーバー内で完結するためツールの呼び出しが届かず、
              // 「調べ物中」を出せる場所が存在しない。待機の約束をしながらこのターンで一度もツールを
              // 呼んでいない状態は、まさにその見えない処理が起きている可能性が高い区間なので、ここで
              // 一度出しておく（実際に音声が届けば「発話中」が即座に上書きし、次のターンの終わりで
              // 必ず「待機」に戻るため、誤表示も消し忘れも起きない）。
              notifyDashboardActivity('searching');
              // 即座に送らず猶予を置く。この猶予の間にツールの呼び出しが届けば、モデルは自分で呼ぼうと
              // していた＝誤検知だったということなので送信を取り消す。本当に何も起きなければ、
              // 従来通り訂正ターンを1回だけ送る。
              clearWaitPromiseNudgeTimer();
              waitPromiseNudgeTimer = setTimeout(() => {
                waitPromiseNudgeTimer = null;
                if (ws.readyState !== WebSocket.OPEN) return;
                waitPromiseNudgeSentThisLeak = true;
                armPromiseFollowupTimer();
                // ATTENTION: これは異常ではなく、待機の約束をすれば必ず起きる正常な流れのため info で記録する。
                //            異常時と同じ扱いで記録し続けると、本当の異常を見落とす。
                getLogger().info(`${ch} 発話後の待機状態を検知（${WAIT_PROMISE_NUDGE_GRACE_MS / 1000}秒）、`
                  + `処理の続行を促しました`);
                // 文面は「返事を促す」形ではなく「黙って処理を続けさせる」形（CONTINUATION_NUDGE_TEXT）。
                // このターンは復帰のきっかけを与えるためだけのもので、話し直させると同じ返事が2回聞こえる。
                ws.send(liveClient.encodeUserText(CONTINUATION_NUDGE_TEXT));
              }, WAIT_PROMISE_NUDGE_GRACE_MS);
            } else {
              canvasCalledThisTurn = false;
              canvasNudgeSentThisLeak = false;
              anyToolCalledThisTurn = false;
              waitPromiseNudgeSentThisLeak = false;
              pseudoCallNudgeSentThisLeak = false;
              // ターンの終わりが正常に届いた＝直前の約束（結果を伝えること）が果たされた。
              clearPromiseFollowupTimer();

              // ここへ到達したのは「文言マッチがどれも反応しなかったターン」である。これを無条件に
              // 正常終了とみなすことが、まさに停止を見逃す原因だった。ツールを1つも呼ばずに終わった
              // ターンに限り、依頼がまだ果たされていないかを軽量モデルに判定させ、未達なら続行を促す。
              // 文言マッチは即時に効く高速パスとして残し、こちらがその取りこぼしを拾う受け皿になる。
              const _judgeUserText = [...transcriptTracker.getFullTranscript()]
                .reverse().find(e => e.speaker === 'user')?.text || '';
              if (!_hadToolCallThisTurn && !judgeNudgeSentSinceUserTurn
                  && _turnModelText && _judgeUserText && ws.readyState === WebSocket.OPEN) {
                const _epochAtJudge = activityEpoch;
                _judgeRequestStillPending({
                  apiKey, userText: _judgeUserText, modelText: _turnModelText, activitySessionId,
                }).then((pending) => {
                  if (pending !== true) return; // false（完了）・null（判定不能）はどちらも何もしない
                  // 判定を待っている間にリスナーが喋った／ツールが呼ばれた／次のターンが完了していれば、
                  // この判定はもう古い。催促は取り止める。
                  if (activityEpoch !== _epochAtJudge) {
                    getLogger().debug(`${ch} 依頼は未達と判定されましたが、待機中に状況が変わったため催促は行いません`);
                    return;
                  }
                  if (ws.readyState !== WebSocket.OPEN) return;
                  judgeNudgeSentSinceUserTurn = true;
                  armPromiseFollowupTimer();
                  // 文言マッチの経路と同じく、見えない処理の最中である可能性を画面へ出しておく
                  // （音声が届けば「発話中」が上書きし、次のターンの終わりで「待機」に戻る）。
                  notifyDashboardActivity('searching');
                  getLogger().info(`${ch} 依頼が未達のままターンが終了したと判定、処理の続行を促しました`);
                  ws.send(liveClient.encodeUserText(CONTINUATION_NUDGE_TEXT));
                }).catch((e) => {
                  getLogger().warn(`${ch} 依頼の未達判定でエラー（催促は行いません）: ${e.message}`);
                });
              }
              // 終了予告を受けた後、漏れの検知が無い本当に正常なターンの終わり（＝訂正ターンの連鎖も
              // 含めて今のやり取りが完結した瞬間）に達したら、会話を打ち切らずセッション再開を試みる。
              // この区切りの良いタイミングでのみ行うのは、ツールの応答待ち等が一切残っていない、
              // 安全に接続を差し替えられる状態を保証するため。
              handleGoAwayTransition(ws);
            }
          }

          // 1ターン分の発話が完了するたびに利用量が届く。稼働レポートの「AI応答回数」「モデル別・
          // エージェント別コスト」に反映されるよう記録する（他チャンネルの発話と同じ種別を使う）。
          if (ev.usage) {
            activityDb.logEvent(activitySessionId, 'llm_chat', {
              agent: 'secretary',
              metadata: { model: GEMINI_LIVE_MODEL_PRICING_KEY, ...ev.usage },
            });
          }

          if (ev.toolCalls.length) {
            markRealActivity();
            const calls = ev.toolCalls;
            // このターンで何らかのツールが実際に呼ばれたことを記録する（ツール名を問わない汎用のフラグ）。
            anyToolCalledThisTurn = true;
            // モデルが自力で動き出した＝停止していない。判定待ちの結果があれば無効にし、
            // この依頼に対する催促の回数制限も解除する。
            activityEpoch += 1;
            judgeNudgeSentSinceUserTurn = false;
            // このターンで実際にキャンバス表示ツールが呼ばれたことを記録する（漏れの検知で使う）。
            if (calls.some((c) => c.name === 'show_on_canvas' || c.name === 'show_weather_map')) {
              canvasCalledThisTurn = true;
            }
            // 会話のどの区間（応答の判断／ツール実行そのもの／結果を返した後の音声生成）で時間が
            // かかっているかを、推測ではなく実測で切り分けるためのログ。
            const _toolCallReceivedAt = Date.now();
            // このターンでモデルが既に発話していたかを併記する。「前置きを言わずに無言でツールを
            // 呼んでいる」のか「前置きは生成されていたのに音声が届いていない」のかを、推測ではなく
            // 実測で切り分けるため。
            const _spokenBefore = transcriptTracker.getModelSpokenSoFar();
            getLogger().info(`${ch} tool呼び出し: ${calls.map(c => c.name).join(',')}`
              + `（呼び出し前の発話: ${_spokenBefore ? `あり・${_spokenBefore.length}文字「${_spokenBefore.slice(0, 40)}」` : 'なし（無言で呼び出し）'}）`);
            // ツール実行中はクライアントから見ると無音の時間になり、だんまりと区別が付かない。
            // 実行の開始・終了を知らせて「処理中」表示を出せるようにする。
            watchdog.setToolCallInFlight(true);
            // BUGFIX: ツールの呼び出しを受け取った時点で、約束のタイマーも必ず止めること。ツール実行中は
            //         Gemini Live 側が結果待ちで沈黙するのが正常な姿であり、upstream の無活動は異常では
            //         ない。止め忘れると枠が切れた時点で「応答がありません」という訂正ターンを送ってしまい、
            //         それが新しいユーザーターンとして解釈されて同一のツールが二重に呼ばれ、音声も
            //         二重に重なる（相談は生成＋音声合成＋再生完了待ちで60秒近くかかるため、短い枠は
            //         構造的に必ず超える）。実行が終わった時点で張り直すため、本来の役割は損なわれない。
            clearPromiseFollowupTimer();
            // ツール実行という新しい待機区間に入るため「喋ったか」を戻す。この後に張り直すタイマーが
            // 待つのは「結果を返したのに一言も返ってこない」状態であり、短い枠が妥当なため。
            modelSpokeSinceArm = false;
            // 黙り込んだ疑いで送信待ちにしていた訂正ターンを取り消す。ツールの呼び出しが届いた
            // ＝モデルは催促されなくても自分で呼ぼうとしていたということなので、ここで催促を送ると
            // 同じ挨拶を2回言わせるだけになる。
            clearWaitPromiseNudgeTimer();
            notifyDashboardActivity('searching');
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ event: 'SECRETARY_PROCESSING', processing: true }));
            }
            // 相談は本人の声が出るまで30秒前後かかる（実測: 文章の生成15.7秒＋音声合成17.3秒）。
            // その間クライアントには「処理中…」としか出ず、誰に繋いでいるのかが分からなかった
            // ——相手の名前が出るのは音声が届いてから、つまり待ちが終わった後だったため。秘書が声で
            // 一言添えるかはモデル任せで実測では毎回無言だったので、呼び出した瞬間にコード側から知らせる。
            const _consultCall = calls.find((c) => c.name === 'consult_agent');
            if (_consultCall && clientWs.readyState === WebSocket.OPEN) {
              const _consultKey = _consultCall.args?.agent_key;
              clientWs.send(JSON.stringify({
                event: 'SECRETARY_CONSULT_PENDING',
                agentKey: _consultKey || null,
                agentName: config.agents?.[_consultKey]?.name || null,
              }));
            }
            // リスナーの発話は既に確定しているはずのこのタイミングで、先に会話履歴へ書き込む
            // （相談先の回答が先に書き込まれて表示順が逆転するのを防ぐ）。
            transcriptTracker.flushUserOnly();
            // ツールの実行は外部への問い合わせを伴い非同期のため、完了を待たずに済むようここだけ
            // 切り離して実行する（外側のメッセージ処理は同期のまま）。
            Promise.all(calls.map(async (call) => {
              const response = await dispatchToolCall(call.name, call.args, { config, creds, activitySessionId, getAgentSystem, getChannelSystem });
              getLogger().info(`${ch} ${call.name}の実行完了（error=${response.error ? response.error : 'なし'}, audio=${response.audioBase64 ? 'あり' : 'なし'}）`);

              // 相談先の本人の声が合成できた場合は、Gemini Live へ結果を返す前にクライアント側でその音声を
              // 再生させ、再生完了の通知を待つ。Live 側は同期の関数呼び出しのため、結果を返すまで新たな
              // 音声生成を始めない——これで Gemini 自身の音声と差し込んだ音声が重ならない。
              if (response.audioBase64) {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    event: 'CONSULT_AGENT_AUDIO',
                    agentName: response.agentName,
                    agentKey: response.agentKey,
                    audioBase64: response.audioBase64,
                  }));
                  // チャンネル画面はアバターを相談先へ切り替えるが、ダッシュボードは常に秘書のままだった。
                  // 同じ区間（本人の声の再生中）を onConsulting で知らせる。
                  onConsulting?.({ state: 'start', agentKey: response.agentKey, agentName: response.agentName });
                  // ATTENTION: 実際の再生時間より短い上限で打ち切ると、再生中に次の発言と重なる。再生時間の
                  //            見積もりにネットワーク・デコードのマージン（8秒）を足して待ち、短い音声でも
                  //            最低15秒は確保する。
                  const estimatedMs = estimateWavPlaybackMs(response.audioBase64);
                  await audioAckWaiter.wait(Math.max(15000, estimatedMs + 8000));
                  onConsulting?.({ state: 'end' });
                }
              }
              // キャンバス表示の結果は専用のイベントとして即座に送る。音声とは無関係なので再生完了を
              // 待つ必要は無い。画像は会話のコンテキストには一切含めない（音声と同じ理由で、巨大なデータを
              // トークンとして消費させないため）。
              if (response.canvas && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  event: 'CANVAS_UPDATE',
                  title: response.canvas.title,
                  content: response.canvas.content,
                  imageBase64: response.canvas.imageBase64,
                  imageMime: response.canvas.imageMime,
                }));
              }
              // 実際の切断・画面遷移はクライアント側に任せる。このターンで話している別れの挨拶の再生が
              // 終わるまで待つ必要があるため、サーバーから一方的に切断しない。
              if (response.endSession && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'SECRETARY_SESSION_END' }));
              }
              // 同一ツール名・同一引数の呼び出しが連続して失敗していないか調べ、2回目以降なら
              // やり直しを止める指示を注入する。
              let finalError = response.error;
              if (response.error) {
                const callKey = `${call.name}:${JSON.stringify(call.args || {})}`;
                if (callKey === lastFailedToolCallKey) {
                  lastFailedToolCallCount++;
                } else {
                  lastFailedToolCallKey = callKey;
                  lastFailedToolCallCount = 1;
                }
                if (lastFailedToolCallCount >= 2) {
                  getLogger().warn(`${ch} 同一ツール呼び出しの連続失敗を検知（${lastFailedToolCallCount}回目、`
                    + `${call.name}）— リトライ抑止の指示を注入`);
                  finalError = `${response.error}\n\n【重要・システムからの指示】これは直前と全く同じ条件`
                    + `での呼び出しが連続して失敗しています。絶対にもう一度同じ条件で呼び出さないで`
                    + `ください。「もう一度〜してみますね」のような再試行の案内も言わないでください。`
                    + `今すぐこのエラー内容を踏まえて、うまくいかなかったことを一度だけ簡潔にリスナーに`
                    + `伝え、そこで止まってください。`;
                }
              } else {
                lastFailedToolCallKey = null;
                lastFailedToolCallCount = 0;
              }
              // 音声は Gemini 側のコンテキストへ送る必要が無いため、実行結果に含める内容からは除く
              // （巨大な base64 をトークンとして消費させないため）。
              return { id: call.id, name: call.name, response: { result: response.result, error: finalError } };
            })).then((responses) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(liveClient.encodeToolResponse(responses));
                getLogger().info(`${ch} toolResponse送信完了: ${responses.map(r => r.name).join(',')} `
                  + `（tool呼び出しからtoolResponse送信まで${Date.now() - _toolCallReceivedAt}ms）`);
              } else {
                getLogger().warn(`${ch} toolResponse送信スキップ（ws.readyState=${ws.readyState}、OPENではない）`);
              }
            }).catch((e) => {
              getLogger().warn(`${ch} tool実行失敗: ${e.message}`);
            }).finally(() => {
              // setToolCallInFlight(false)内で「再開時点を今からにする」処理も行う
              // （実行にかかった時間をだんまり判定のカウントに含めてしまわないため）。
              watchdog.setToolCallInFlight(false);
              notifyDashboardActivity('idle');
              // 結果を返した＝「それについて伝える」という約束をした瞬間。専用タイマーを起動し、
              // ターンの終わりを受け取った時点で解除する。
              armPromiseFollowupTimer();
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'SECRETARY_PROCESSING', processing: false }));
              }
            });
          }
        } catch (e) {
          getLogger().warn(`${ch} Gemini Liveメッセージのパース失敗（中継のみ続行）: ${e.message}`);
        }

        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(raw);
        }
      });

      ws.on('close', (code, reason) => {
        // 再開のため、こちらが意図して古い接続を閉じただけの場合は、本来の後始末（学習内容の要約・
        // 日記の生成・クライアント側の切断の連鎖）を一切行わない——会話はまだ終わっていないため。
        if (intentionalUpstreamSwap) {
          intentionalUpstreamSwap = false;
          getLogger().info(`${ch} セッション再開のため古い接続を閉じました（会話は継続中）code=${code}`);
          return;
        }
        upstreamClosed = true;
        watchdog.stop();
        clearGoAwayDeadlineTimer();
        clearPromiseFollowupTimer();
        clearWaitPromiseNudgeTimer();
        getLogger().info(`${ch} Gemini Live切断 code=${code} reason=${reason}`);
        // turnComplete前に切断された場合、蓄積済みの発話が失われないよう最後に一度フラッシュする
        transcriptTracker.flushAll();
        if (!clientClosed && clientWs.readyState === WebSocket.OPEN) clientWs.close();
        // セッション全体を振り返り、訂正・好み・発見を自動学習する。LLM の呼び出しを伴うため、
        // 切断処理を止めないよう結果を待たずに走らせる。続けて古い学習内容の圧縮と、各チャンネルへ
        // 配る「学習されたリスナー情報」ダイジェストの再生成も試みる（どちらも変化が無ければ内部で
        // 即座に何もせず返るため、毎回呼んでも軽い）。圧縮の直後に置くことで、最新の状態を材料にできる。
        secretaryMemory
          // リスナー情報を渡すのは、音声認識の誤変換を「文脈から浮いている」と判断させる材料にするため。
          .summarizeSessionLearnings(transcriptTracker.getFullTranscript(), { apiKey, activitySessionId, listenerProfile })
          .catch((e) => getLogger().warn(`${ch} セッション終了時の自動学習に失敗: ${e.message}`))
          .finally(() => {
            secretaryMemory
              .compactOldAutoLearnings({ apiKey, activitySessionId })
              .catch((e) => getLogger().warn(`${ch} 学習内容の圧縮に失敗: ${e.message}`))
              .finally(() => {
                secretaryMemory
                  .summarizeListenerDigest({ apiKey, activitySessionId })
                  .catch((e) => getLogger().warn(`${ch} リスナー情報ダイジェストの更新に失敗: ${e.message}`));
              });
          });
        // 一人称の振り返り（管理画面での読み物用途）。次回以降の会話に効かせる学習内容とは別物。
        // コーナーの区切りが無いため、他チャンネルと同じ「セッション全体で1回」方式にしてある。
        secretaryDiary
          .writeSessionDiaryReflection(transcriptTracker.getFullTranscript(), { apiKey, agentName: secretaryCfg.name, activitySessionId, onDiaryWritten })
          .catch((e) => getLogger().warn(`${ch} セッション終了時の日記生成に失敗: ${e.message}`));
        // 自律監視ループのクールダウンの起点。会話が終わった今まさに得た情報を、また少し経ってから
        // 「新着です」と伝えてしまう無駄・不自然さを避けるため。
        secretaryLoop.recordSessionEnded();
        // 機密文書を想定した保持ポリシーにより、セッション終了時にこの接続でアップロードされた
        // ファイルをまとめて削除する（既に削除済みの ID に対しても安全に呼べる）。
        secretaryUploads.deleteUploads([...uploadedFileIds]);
      });

      ws.on('error', (err) => {
        getLogger().warn(`${ch} Gemini Live接続エラー: ${err.message}`);
        // 残高不足・API キーの無効はここにも現れる。判定できた場合はメイン画面へ知らせ、
        // リスナーへも汎用の文言ではなく理由を返す。
        const alert = systemAlerts.report(err, { source: 'secretary_live' });
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            event: 'SECRETARY_ERROR',
            message: alert ? alert.userMessage : 'Gemini Liveとの接続でエラーが発生しました',
          }));
        }
      });
    }

    /**
     * 終了予告の後、「接続を差し替える」「締めくくって閉じる」のいずれかへ移る唯一の合流点。
     *
     * 呼び出し元は3つある。①予告を受けた時点でやり取りが進行中でなかった場合（即時）、
     * ②予告後の、漏れの検知が無い正常なターンの終わり（本命の経路。最も安全）、
     * ③締切タイマー（①②で移れないまま時間切れが迫った場合の最終手段）。
     * 再開ハンドルがまだ無い場合だけ、締めくくりの挨拶をしてから閉じる方へ倒す。
     *
     * @param {any} currentWs 現在の upstream
     */
    function handleGoAwayTransition(currentWs) {
      if (!goAwayReceived) return;
      if (currentWs.readyState !== WebSocket.OPEN) return;
      if (resumptionInFlight) return;
      clearGoAwayDeadlineTimer();
      if (lastResumptionHandle) {
        startSessionResumption(currentWs);
      } else if (!goAwayWrapUpSent) {
        // 再開用のハンドルがまだ無い場合のみ、締めくくりの挨拶をしてから閉じる
        // （無警告のまま打ち切らないための最終手段）。
        goAwayWrapUpSent = true;
        armPromiseFollowupTimer();
        getLogger().info(`${ch} goAway受信、セッション再開ハンドルが無いため締めくくりの挨拶を促してから閉じます`);
        currentWs.send(liveClient.encodeUserText('(システムより: まもなくこの接続の利用時間の上限に達します。今の内容を短くまとめ、'
                + `${userName}さんへ一言お別れの挨拶をしてから会話を終えてください)`));
      } else {
        getLogger().info(`${ch} goAway受信後の会話が完結。無音区間を避けるためこちらからupstreamを閉じます`);
        currentWs.close();
      }
    }

    /**
     * 区切りの良いターンの終わりを待つのを諦めて、強制的に移行させる締切タイマーを立てる。
     *
     * BUGFIX: これが無いと、終了予告の後にたまたま会話が途切れた場合そのまま何も起きず、
     *         Gemini 側から強制切断されて会話が唐突に終わる。
     *
     * @param {any} currentWs 現在の upstream
     * @param {number|null} timeLeftMs 予告に含まれていた残り時間
     */
    function armGoAwayDeadline(currentWs, timeLeftMs) {
      if (goAwayDeadlineTimer) return;
      // 残り時間が解釈できなかった場合のみ、実測値（50秒）で代用する。
      // 0 を50秒と誤読しないよう、|| ではなく ?? を使う。
      const delay = Math.max(3000, (timeLeftMs ?? 50000) - GO_AWAY_DEADLINE_MARGIN_MS);
      goAwayDeadlineTimer = setTimeout(() => {
        goAwayDeadlineTimer = null;
        if (!goAwayReceived || currentWs.readyState !== WebSocket.OPEN) return;
        getLogger().warn(`${ch} goAway後、区切りの良いturnCompleteが来ないまま締切（${Math.round(delay / 1000)}秒）に達しました。強制的に移行します`);
        handleGoAwayTransition(currentWs);
      }, delay);
    }

    /**
     * 終了予告の後、まだ間に合ううちにバックグラウンドで新しい upstream を確立し、setup が
     * 取れた時点で古い接続と静かに入れ替える。これにより「予告してから切る」ではなく
     * 「そもそも切らない」を実現する。
     *
     * ATTENTION: ハンドシェイク中に届くメッセージは、setup の完了を見るだけの最小限のリスナーで
     *            処理すること。フル処理を繋いでしまうと、まだ現在の会話を中継していないこの時点で
     *            ターンの終わり等の判定が誤作動する。
     * 成功したら古い接続を後始末なしで閉じ、新しい接続へフル処理を繋ぎ直す。タイムアウト・
     * エラー時は、従来通り「締めくくりの挨拶をしてから閉じる」へ倒す。
     *
     * @param {any} currentWs 現在の upstream
     */
    function startSessionResumption(currentWs) {
      const handle = lastResumptionHandle;
      resumptionInFlight = true;
      getLogger().info(`${ch} セッション再開ハンドルがあるため、バックグラウンドで再接続します`);
      const candidate = new WebSocket(liveClient.buildConnectUrl(encodeURIComponent(apiKey)));
      let settled = false;

      function fallbackToWrapUp(reason) {
        if (settled) return;
        settled = true;
        resumptionInFlight = false;
        clearTimeout(failTimer);
        getLogger().warn(`${ch} セッション再開に失敗（${reason}）。従来通り締めくくりの挨拶をしてから終了します`);
        try { candidate.close(); } catch { /* 接続確立前の可能性があるため失敗は無視 */ }
        if (currentWs.readyState === WebSocket.OPEN && !goAwayWrapUpSent) {
          goAwayWrapUpSent = true;
          armPromiseFollowupTimer();
          currentWs.send(liveClient.encodeUserText('(システムより: まもなくこの接続の利用時間の上限に達します。今の内容を短くまとめ、'
                  + `${userName}さんへ一言お別れの挨拶をしてから会話を終えてください)`));
        }
      }

      // 終了予告の残り時間は実測で最大50秒。8秒でハンドシェイクが終わらなければ、
      // 間に合わなくなる前に確実にフォールバックへ切り替える。
      const failTimer = setTimeout(() => fallbackToWrapUp('タイムアウト'), 8000);

      candidate.on('open', () => {
        candidate.send(liveClient.encodeSetup(buildUpstreamSetupPayload(handle)));
      });

      function onHandshakeMessage(data) {
        if (settled) return;
        let parsed;
        try { parsed = JSON.parse(data.toString()); } catch { return; }
        if (!liveClient.decodeServerMessage(parsed).ready) return;
        settled = true;
        resumptionInFlight = false;
        clearTimeout(failTimer);
        clearGoAwayDeadlineTimer();
        candidate.removeListener('message', onHandshakeMessage);
        intentionalUpstreamSwap = true;
        const old = upstream;
        upstream = candidate;
        goAwayReceived = false;
        goAwayWrapUpSent = false;
        upstreamExchangeActive = false;
        attachUpstreamHandlers(candidate, { isResumption: true });
        old.close();
        getLogger().info(`${ch} セッション再開に成功、無音区間なく会話を継続します`);
      }
      candidate.on('message', onHandshakeMessage);

      candidate.on('error', (err) => fallbackToWrapUp(err.message));
    }

    attachUpstreamHandlers(upstream, { isResumption: false });

    clientWs.on('message', (msg, isBinary) => {
      if (isBinary) return; // クライアントは常にJSONテキストフレーム（realtimeInput等）で送る
      const raw = msg.toString();

      // 本人の声の再生完了通知は制御メッセージのため、Gemini Live へは中継せずここで消費する。
      // それ以外は素通しする。
      try {
        const parsed = JSON.parse(raw);
        if (parsed.event === 'CONSULT_AGENT_AUDIO_DONE') {
          audioAckWaiter.resolveIfPending();
          return;
        }
        // アップロードは別の HTTP エンドポイントで行われるため、完了後にクライアントがこの制御
        // メッセージで知らせてくる。ファイルの ID は UUID でモデルが正確に扱える構造化データなので、
        // URL の読み上げのような聞き取りミスが起きない。
        if (parsed.event === 'SECRETARY_FILE_UPLOADED') {
          const { fileId, fileName } = parsed;
          if (fileId) {
            uploadedFileIds.add(fileId);
            getLogger().info(`${ch} ファイルアップロード通知: ${fileName}（file_id: ${fileId}）`);
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(liveClient.encodeUserText(`(内部情報・声に出さないこと: ファイル「${fileName}」が`
                      + `アップロードされました。file_id: ${fileId}（この文字列はanalyze_uploaded_file`
                      + `ツール呼び出し時にのみそのまま使い、声には出さないでください）。リスナーには`
                      + `「ファイルを受け取りました」のように短く自然に伝え、このファイルに対して`
                      + `何をすればよいか尋ねてください)`));
            }
          }
          return;
        }
        // 声で伝えるのが大変で誤認識も多い URL・長文を、ファイル添付と同じ「制御メッセージで
        // 構造化データとして渡す」方式で受け取る。
        //
        // ATTENTION: サーバー側で URL の解析・分類は一切行わず、共有された生のテキストをそのまま
        //            渡すこと。どのツールを呼ぶか（あるいは何も呼ばず地の文として使うか）は、
        //            内容を見てモデル自身が判断する。
        if (parsed.event === 'SECRETARY_INFO_SHARED') {
          const text = (parsed.text || '').trim();
          getLogger().info(`${ch} テキスト共有通知: ${text.length}文字`);
          if (upstream.readyState === WebSocket.OPEN && text) {
            upstream.send(liveClient.encodeUserText(`(内部情報・声に出さないこと: リスナーが音声では伝えにくい情報を`
                    + `テキスト共有欄から共有しました。以下がその内容です。GoogleスプレッドシートのURL`
                    + `であればanalyze_google_sheetツールへ、それ以外のWebページのURLであれば`
                    + `analyze_web_pageツールへ、共有された内容のURLを一字一句そのまま渡してください。`
                    + `URLではなく文章やデータそのものであれば、以下の内容そのものを情報として使って`
                    + `ください（ツールを呼ぶ必要はありません）。\n\n---共有された内容---\n${text}`
                    + `\n---ここまで---\n\nこの後、リスナーから音声でこの内容に対して何をしてほしいか`
                    + `の指示が続きます。まずは「情報を受け取りました」のように短く伝え、次の指示を`
                    + `待ってください)`));
          }
          return;
        }
        // 録音中のみ、リスナーのマイク入力（16kHz PCM16）を録音バッファへ渡す
        // （応答音声側と同じ仕組み）。
        const _recordingMicData = parsed.realtimeInput?.audio?.data;
        if (_recordingMicData) {
          const _activeRec = secretaryRecorder.getActiveRecorder();
          if (_activeRec) _activeRec.append(Buffer.from(_recordingMicData, 'base64'), 16000);
        }
      } catch { /* Gemini Live向けの通常メッセージ。パース失敗は無視してそのまま中継する */ }

      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(raw);
      }
    });

    clientWs.on('close', () => {
      clientClosed = true;
      notifyDashboardActivity('idle');
      onConsulting?.({ state: 'end' });
      watchdog.stop();
      clearGoAwayDeadlineTimer();
      clearPromiseFollowupTimer();
      clearWaitPromiseNudgeTimer();
      clearInterval(idleDisconnectInterval);
      // ヘルパーからの配信先を解除する。以後に完了したジョブは持ち越され、
      // 次回接続時の挨拶で伝えられる。
      sessionRegistry.clearActiveSession(liveSession);
      getLogger().info(`${ch} クライアント切断`);
      if (!upstreamClosed && upstream.readyState === WebSocket.OPEN) upstream.close();
      activityDb.closeSession(activitySessionId);
      // 切断の経路が先に削除していた場合も安全（同じ ID に対して何度呼んでも構わない）。
      secretaryUploads.deleteUploads([...uploadedFileIds]);
    });

    clientWs.on('error', () => {});
  });
}

module.exports = {
  registerSecretaryLiveWs,
  // Gemini Live へ渡す、絞り込み済みのツール（LIVE_ONLY_TOOL_NAMES 参照）。
  buildSecretaryTools,
  // 全ツール。LINE 連携とヘルパーエージェントが使う。実体は secretary-tool-declarations.js に
  // あり、ここでは後方互換のため再エクスポートしているだけ。
  buildAllSecretaryTools,
};
