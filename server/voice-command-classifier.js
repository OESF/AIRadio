/**
 * @file AI Radio 管理人への入力（お問い合わせ・リクエスト欄）を、操作の種類（intent）へ分類する
 *
 * チャンネルの切り替え・停止・音量・コーナーのリクエスト・録音・質問への回答などを、軽量モデルで1回の呼び出しで
 * 分類し、管理人が返す一言（response）も同時に作らせる。利用元は routes/text-command-routes.js。
 * 実行できるかどうかの判定は LLM に任せず、isVoiceCommandRequestFeasible がコードで決める。
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

const { generateText } = require('./lib/llm-client');
const { getLogger } = require('./logger');

// 分類のプロンプトで「今どのチャンネルを放送中か」を伝えるときの、チャンネルの呼び名
const CHANNEL_NAMES = {
  live: 'Live（AI Radio Live）', classic: 'Classic（静寂のスコア／クラシック音楽）',
  jazz: 'Jazz（琥珀色のインプロヴィゼーション）', mood: 'Mood（トワイライト・ラウンジ）',
  beatles: 'Beatles（Eight Days A Week）', '24you': '24/You（言葉のいらない選曲チャンネル）',
};

// アプリのチャンネル一覧に表示されている名前と読み方。リスナーは ID（live・classic など）ではなく
// この名前で話しかけてくるので、分類のプロンプトに全部並べる。
// ATTENTION: client/src/Player.tsx の CHANNELS の表示名と必ずそろえる。
const CHANNEL_ALIASES = {
  live: ['ライブ', 'AI Radio Live'],
  classic: ['クラシック', '静寂のスコア', 'しじまのスコア', 'シジマのスコア'],
  jazz: ['ジャズ', '琥珀色のインプロヴィゼーション', 'こはくいろのインプロヴィゼーション'],
  mood: ['ムード', 'トワイライト・ラウンジ', 'トワイライトラウンジ'],
  beatles: ['ビートルズ', 'Eight Days A Week', 'エイトデイズアウィーク'],
  '24you': ['24You', '24/You', 'トゥエンティフォーユー'],
};

const CORNER_KEYS = [
  'weather', 'traffic', 'news', 'finance', 'activities', 'commentator',
  'journalist', 'music_dj', 'life_advisor', 'world_report', 'legal_advisor',
];

/**
 * 管理人への入力テキストを、intent と引数へ分類する。管理人が声で返す一言（response）も同時に作らせる。
 * 失敗したときは例外を投げず、info_query（質問・雑談）として返す。
 * @param {string} transcript リスナーの入力テキスト
 * @param {{ apiKey: string, channel?: string, isStreaming?: boolean, administratorName?: string,
 *   longTermContext?: string, recentConversation?: string, playedHistoryContext?: string,
 *   activitySessionId?: any }} context
 *   番組の文脈（過去の記録・直近の会話・再生履歴）は、質問に答えるときの材料。
 *   activitySessionId は稼働記録のセッション（呼び出し側が管理人用に開く）
 * @returns {Promise<{ intent: string, params: Record<string, any>, response: string }>}
 */
async function classifyVoiceCommand(transcript, {
  apiKey, channel, isStreaming, administratorName,
  longTermContext, recentConversation, playedHistoryContext,
  activitySessionId = null,
}) {
  if (!apiKey) return { intent: 'info_query', params: {}, response: '' };

  try {
    // 単純な分類なので軽量モデル（light ティア。思考を切る設定もティアの側にある）

    const statusLine = isStreaming && channel
      ? `現在「${CHANNEL_NAMES[channel] || channel}」を放送中です。`
      : '現在何も放送していません（ウェルカム画面）。';
    const name = administratorName || 'AI管理者';

    const channelAliasLines = Object.entries(CHANNEL_ALIASES)
      .map(([id, aliases]) => `  ${id}: ${aliases.join(' / ')}`)
      .join('\n');

    // 「今の話どう思う？」のような文脈に頼る質問にもその場で答えられるよう、番組の記録を添える
    // （info_query 以外では実質使われない）
    const contextBlock = [
      longTermContext ? `【過去の番組の記録】\n${longTermContext}` : '',
      recentConversation ? `【現在放送中の会話（直近）】\n${recentConversation}` : '',
      playedHistoryContext ? `【このチャンネルの再生履歴（新しい順）】\n${playedHistoryContext}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `AIラジオアプリ「AI Radio」の音声アシスタント「AI Radio管理人」への発話を、
以下のJSON形式のいずれか1行のみで分類してください（他のテキストは一切出力しないこと）。
どの分類でも共通で"response"フィールドに、あなた（${name}という名のAI管理者）の発言を
含めること。info_query以外は、これから操作を行うことを伝える短い相槌（日本語、10〜20文字
程度、1文）。info_queryの場合のみ、下記の番組コンテキストを踏まえた実際の回答
（200文字程度まで）にすること。

${statusLine}

チャンネルの正規idと、アプリ画面に実際に表示されている別名（呼びかけはこちらの名前で
来ることが多い）:
${channelAliasLines}
${contextBlock ? `\n${contextBlock}\n` : ''}
発話:「${transcript}」

分類候補:
{"intent":"channel_switch","channel":"live|classic|jazz|mood|beatles|24you","response":"例:「クラシックに切り替えますね」"}
  ← チャンネルの選択・切り替え・開始（例:「クラシックを再生して」「ライブに変えて」）。
     The Answersは別の分類（the_answers_start）を使うためchannelには含めない
{"intent":"stop","response":"例:「停止しますね」"}
  ← 停止・終了（例:「止めて」「終了して」）
{"intent":"the_answers_start","topic":"議題（不明ならnull）","response":"例:「The Answersを始めますね」"}
  ← The Answersの開始（例:「The Answersで最近のニュースについて議論して」）
{"intent":"volume_relative","direction":"up|down","response":"例:「音量を上げますね」"}
  ← 音量の相対変更（例:「音量上げて」「ボリューム下げて」）
{"intent":"volume_absolute","value":0から100の数値,"response":"例:「音量を50にしますね」"}
  ← 音量の絶対値指定（例:「音量を50にして」「ボリューム80%」）
{"intent":"mute_toggle","state":"mute|unmute","response":"例:「ミュートしますね」"}
  ← ミュート切り替え（例:「消して」「ミュート解除して」）
{"intent":"24you_mode","mode":"omakase|anokoro|artist|shinpu|wagamama","anokoro_age":"年代（あの頃モードのみ、不明ならnull）","wagamama_request":"自由要望（わがままモードのみ、不明ならnull）","response":"例:「おまかせモードにしますね」"}
  ← 24/Youの選曲モード変更（例:「おまかせにして」「あの頃モードで20代の頃の曲」「わがままモードでアップテンポな曲」）
{"intent":"corner_request","corner":"weather|traffic|news|finance|activities|commentator|journalist|music_dj|life_advisor|world_report|legal_advisor|comedian|doctor|marketer","response":"例:「天気コーナーにしますね」"}
  ← Live専用。特定のコーナー（天気/交通/ニュース/経済/おでかけ情報/コメンテーター/
     ジャーナリスト/音楽DJ/人生相談/世界の現地リポート/法律相談/お笑い芸人の世間ばなし/
     医師の健康・医療/マーケターのトレンド解析）を今すぐ呼ぶ・振る指示
     （例:「天気コーナーやって」「ジャーナリストに聞いて」）
{"intent":"content_request","text":"リクエスト内容をそのまま（要約せず）","channel":"live|classic|jazz|mood|beatles（発話内で明示的にチャンネル切り替えも求められている場合のみ。それ以外はnull）","response":"例:「かしこまりました、お伝えしますね」"}
  ← コーナー指定以外の内容リクエスト全般。曲・アーティスト・ジャンル・話題・雰囲気の
     リクエスト（例:「もっと明るい曲をかけて」「最近のニュースについて話して」
     「〇〇の曲をリクエスト」）はすべてこれに分類する。
     「トワイライトラウンジに切り替えてスターウォーズのテーマをかけて」のように、
     チャンネル切り替えとリクエストが1文で両方求められている場合は、切り替え先を
     channelに正規のidで入れる（実行側が切り替えてからリクエストする）。切り替えの
     言及が無ければchannelはnullのままにする（現在再生中のチャンネルが対象になる）
{"intent":"recording_start","channel":"live|classic|jazz|mood|beatles|the_answers|all|null","response":"例:「録音を開始しますね」"}
  ← 番組の録音・収録を開始する指示（例:「録音して」「このチャンネルを収録してください」
     「クラシックを録音して」「全部自動で録音して」）。発話中で名指しされたチャンネルが
     あれば正規のidに正規化してchannelに入れる。名指しがなければchannelはnull
     （現在再生中のチャンネルが対象になる）。「全部」「オールモード」「自動で」等はallにする
{"intent":"recording_stop","response":"例:「録音を停止しますね」"}
  ← 録音・収録の停止指示（例:「録音を止めて」「録音停止」「収録終わって」）
{"intent":"sleep_timer","minutes":分数の数値（解除の場合はnull）,"response":"例:「30分後に停止しますね」"}
  ← スリープタイマーの設定・解除。「30分後に止めて」「1時間後に停止して」等、"時間指定を伴う"
     停止指示はこれに分類する（時間指定の無い即時停止は既存のstopを使う）。「タイマー解除して」
     「スリープタイマーやめて」等の解除指示はminutesをnullにする
{"intent":"show_recipes","response":"例:「保存したレシピをお見せしますね」"}
  ← 保存したレシピの一覧表示指示（例:「レシピを見せて」「保存したレシピある？」）
{"intent":"the_answers_topic_suggest","response":"例:「テーマ候補をお探ししますね」"}
  ← The Answersのテーマ候補の提案依頼（例:「The Answersで話すネタ何かある？」「テーマ候補見せて」）。
     the_answers_startと違い、まだ議題が決まっておらず候補だけを見たい場合に使う
{"intent":"info_query","response":"（実際の回答内容。番組コンテキストを踏まえて具体的に）"}
  ← 上記のどれにも当てはまらない場合のデフォルト。操作・リクエストではなく単なる質問・雑談
     （例:「今日の天気は？」「さっき何の曲がかかった？」「今の話どう思う？」）はすべて
     これに分類する。responseは取り次ぎの相槌ではなく、番組コンテキストを踏まえて実際に
     質問へ回答すること。コンテキストに情報が無ければ「現在ご案内できる情報がありません」
     等、正直に伝える

判断ルール:
- 迷ったら必ず info_query を選ぶこと（操作として解釈できないものを無理に当てはめない）
- 【重要】チャンネル名は上記の別名一覧（表示名・読み方）のいずれで呼ばれても正規のidに
  正規化すること。カタカナ表記の揺れ（例:「シジマ」「ジジマ」等、「静寂」の読み違い）も
  同じチャンネルとして扱う。一覧に無い未知のチャンネル名だけを「用意がない」として扱う
- 【重要】content_requestで「〇〇に切り替えて△△をかけて」のように、チャンネル切り替えと
  リクエストが1文で両方含まれている場合は、絶対にchannelフィールドを省略・nullにせず、
  切り替え先の正規idを入れること（例:「トワイライトラウンジに切り替えてスターウォーズの
  テーマをかけて」→ {"intent":"content_request","text":"スターウォーズのテーマをかけて","channel":"mood",...}）。
  切り替えの言及が無い場合のみchannelはnullにする
- corner_request/content_request/recording_startは、今何も放送していない（ウェルカム画面）場合や、
  現在のチャンネルがそのリクエストに対応していない場合でも、分類（intent/params）自体は
  通常通り行うこと。実行可否の判定と、実行できない場合の案内はサーバー側が別途行うため、
  responseの文面は気にしなくてよい
- responseは例文をそのまま使わず、発話内容に応じて自然に言い換えること`;

    // ATTENTION: activitySessionId を必ず渡す。稼働記録に載らない呼び出しがあると、請求額と突き合わせられない
    const { text: rawText, usage: _u } = await generateText({
      tier: 'light',
      apiKey,
      prompt,
      agentKey: 'administrator',
      activitySessionId,
      logMeta: { purpose: 'voice_command_classify' },
    });
    const raw = rawText.trim().replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
    const parsed = JSON.parse(raw);
    const { intent, response, ...params } = parsed;
    getLogger().info(`[VoiceCommand] classify: 「${transcript}」→ intent=${intent} usage(prompt=${_u.promptTokens ?? '?'} out=${_u.outputTokens ?? '?'} thoughts=${_u.thoughtsTokens ?? '?'})`);
    return { intent: intent || 'info_query', params, response: response || '' };
  } catch (e) {
    getLogger().warn(`[VoiceCommand] classify失敗 → info_query にフォールバック: ${e.message}`);
    return { intent: 'info_query', params: {}, response: '' };
  }
}

// リクエストを受け付けられるチャンネル。受け付けられないときは、サーバーが固定の案内文に差し替える
// （固定の文なら音声合成をディスクのキャッシュから出せて、速く安い。LLM に毎回言い回しを考えさせない）
const CONTENT_REQUEST_CHANNELS = ['live', 'classic', 'jazz', 'mood', 'beatles'];

/**
 * 分類した操作が今のチャンネルで実行できるかを、コードで判定する。
 * @param {string} intent 分類
 * @param {Record<string, any>} params 分類の引数
 * @param {string} channel 今のチャンネル
 * @returns {boolean}
 */
function isVoiceCommandRequestFeasible(intent, params, channel) {
  switch (intent) {
    // コーナーは Live 専用だが、クライアントが必要なら Live へ切り替えてから頼むので、いつでも実行できる
    case 'corner_request':
      return true;
    case 'content_request': {
      // 切り替え先を言っていればそのチャンネル（クライアントが切り替えてから頼む）、無ければ今のチャンネルが対象
      const target = params?.channel || channel;
      return !!target && CONTENT_REQUEST_CHANNELS.includes(target);
    }
    case 'recording_start': {
      const target = params?.channel || channel;
      return target !== '24you';
    }
    default:
      return true;
  }
}

module.exports = { classifyVoiceCommand, isVoiceCommandRequestFeasible };
