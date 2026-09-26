/**
 * @file Secretary が使う全ツールの宣言（Function Declarations）の組み立て
 *
 * 各ドメインのファイル（secretary-tools-*.js）の TOOL_DECLARATIONS と、ここに書いた共通のツールを集め、
 * 使う経路ごとに絞った一覧を返す。
 * - buildSecretaryTools: Gemini Live（音声の会話）用。LIVE_ONLY_TOOL_NAMES だけ
 * - buildAllSecretaryTools: 全ツール。ヘルパーエージェント・Inbox の一括処理が使う
 * - buildLineSecretaryTools: LINE 用。全ツールから Live 専用の制御のツールを除いたもの
 *
 * ATTENTION: このファイルは各ドメインの宣言だけに依存する末端のモジュールにしておくこと。
 * secretary-live-routes.js と secretary-inbox.js の両方から require されるので、ここから
 * secretary-loop.js などを require すると循環参照（loop → inbox → live-routes → loop）になる。
 *
 * ATTENTION: 説明文に出すエージェントの名前は、必ず設定から引くこと（CLAUDE.md 1節）。
 * 管理画面で変えられるため、直書きすると変更に追従しない。
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

const { CONSULTABLE_AGENT_KEYS } = require('./secretary-tools');
const { TOOL_DECLARATIONS: googleToolDeclarations } = require('./secretary-tools-google');
const { TOOL_DECLARATIONS: spotifyToolDeclarations } = require('./secretary-tools-spotify');
const { TOOL_DECLARATIONS: youtubeToolDeclarations } = require('./secretary-tools-youtube');
const { TOOL_DECLARATIONS: obsidianToolDeclarations } = require('./secretary-tools-obsidian');
const { TOOL_DECLARATIONS: reportsToolDeclarations } = require('./secretary-tools-reports');
const { TOOL_DECLARATIONS: financeToolDeclarations } = require('./secretary-tools-finance');
const { TOOL_DECLARATIONS: historyToolDeclarations } = require('./secretary-tools-history');
const { TOOL_DECLARATIONS: presentationToolDeclarations } = require('./secretary-tools-presentation');

// ─────────────────────────────────────────────
/**
 * Gemini Live（音声の会話）に渡すツールの許可リスト。外部と通信せず必ず一瞬で終わる操作だけを残し、
 * データに触れる依頼はすべて ask_helper（ヘルパーエージェント）を通す。
 *
 * BUGFIX: 「速く終わるツールは Live に残し、5秒を超えたら非同期にする」という線引きはしないこと。
 * 所要時間は事前に分からず（get_emails は実測12.6秒）、境界をまたぐと「受け付けました」だけが返り、
 * Live が同じツールをもう一度呼んで、画面に同じものが何度も表示された。途中の状態を作らない
 * （Live は会話だけ、処理はすべてヘルパー）ことで防いでいる。
 */
const LIVE_ONLY_TOOL_NAMES = new Set([
  'get_current_time',   // その場で時計を読むだけ
  'remember_fact',      // ローカルのJSONへ1行書くだけ
  'get_watchlist_updates', // ローカルのJSON（secretary-loop.jsが定期取得済み）を読むだけ
  'show_on_canvas',     // 手元のテキストを画面へ送るだけ
  'end_session',        // 会話の終了
  'ask_helper',         // 実処理の窓口
  'get_job_status',     // 進捗の確認
  // consult_agent は時間がかかるが Live に残す。成果は専門エージェント本人の声で、それを再生できるのは
  // Live の経路だけ（ヘルパー経由だと本人の声が失われ、秘書が代わりに読むことになる）。
  'consult_agent',
  // request_show_content は config.json への書き込み（またはチャンネルの handleListenerRequest の呼び出し。
  // どちらも結果を待たずにすぐ返る）だけなので、remember_fact と同じく Live に残す。
  'request_show_content',
]);

/**
 * Gemini Live に渡すツール（LIVE_ONLY_TOOL_NAMES だけに絞ったもの）。googleSearch などの組み込みはそのまま。
 *
 * @param {Record<string, any>} config 設定全体
 * @returns {Array<any>} Gemini のツールの宣言
 */
function buildSecretaryTools(config) {
  return buildAllSecretaryTools(config).map((entry) => {
    if (!entry.functionDeclarations) return entry; // googleSearch等の組み込みはそのまま
    const kept = entry.functionDeclarations.filter((d) => LIVE_ONLY_TOOL_NAMES.has(d.name));
    return kept.length > 0 ? { functionDeclarations: kept } : null;
  }).filter(Boolean);
}

/**
 * Live の経路だけが扱える制御のツール。secretary-tools.js の TOOL_HANDLERS に実際の処理が無い
 * （ask_helper はハンドラ自体が無く、ほかは戻り値の canvas・endSession を Live のルートだけが解釈する）ので、
 * ほかの経路から呼んでも実行できないか、何も起きない。
 * BUGFIX: LINE にはこれらを渡さない。渡していたころは、LINE で ask_helper が選ばれて「unknown tool」の
 * エラーを受け取り、改めて別のツールを呼び直す無駄な往復が起きていた。
 * ATTENTION: 値は secretary-helper-agent.js の EXCLUDED_TOOL_NAMES と同じにしてある（目的は違うが、
 * 対象の性質は同じ）。変えるときは両方を確かめること。
 */
const NON_LIVE_CONTROL_TOOL_NAMES = new Set([
  'ask_helper', 'get_job_status', 'show_on_canvas', 'show_weather_map', 'end_session',
]);

/**
 * LINE 用のツール（全ツールから、Live 専用の制御のツール NON_LIVE_CONTROL_TOOL_NAMES を除いたもの）。
 *
 * @param {Record<string, any>} config 設定全体
 * @returns {Array<any>} Gemini のツールの宣言
 */
function buildLineSecretaryTools(config) {
  return buildAllSecretaryTools(config).map((entry) => {
    if (!entry.functionDeclarations) return entry;
    const kept = entry.functionDeclarations.filter((d) => !NON_LIVE_CONTROL_TOOL_NAMES.has(d.name));
    return kept.length > 0 ? { functionDeclarations: kept } : null;
  }).filter(Boolean);
}

/**
 * 全ツールの宣言を返す。ヘルパーエージェントと Inbox の一括処理が使う（LINE はここから絞ったもの）。
 *
 * ATTENTION: LINE やヘルパーは Live とは別の同期のループ（通常の generateContent で自前のツールの
 * 呼び出しを回す）で動くので、Live 用に絞った一覧を渡さないこと。絞ると大半の機能が使えなくなる。
 *
 * @param {Record<string, any>} config 設定全体
 * @returns Gemini のツールの宣言
 */
function buildAllSecretaryTools(config) {
  return _buildAllToolDeclarations(config);
}

/**
 * 全ツールの宣言を組み立てる（エージェントの名前は設定から読んで説明文に入れる）。
 *
 * @param {Record<string, any>} config 設定全体
 * @returns Gemini のツールの宣言
 */
function _buildAllToolDeclarations(config) {
  const agents = config.agents || {};
  const weatherName = agents.weather?.name || '気象情報センター';
  const legalName    = agents.legal_advisor?.name || '弁護士';
  const financeName  = agents.finance?.name || '金融情報センター';
  const journalistName = agents.journalist?.name || '謎のジャーナリストX';
  // 例文に出すリスナーの呼び方。末尾の「さん」は下で一律に付けるので取り除く
  const _profile = config.show?.user_profile || {};
  const listenerName = String(_profile.short_name || _profile.name || 'リスナー').replace(/さん$/, '');
  // BUGFIX: consult_agent の agent_key は、キーと実際の名前を対にして示す。キーだけを並べていたころは、
  // 依頼に本人の名前（例: コメンテーターの名前）があっても、話題が金融だというだけで金融情報センターを
  // 選んでしまっていた。
  const consultableAgentDescriptions = CONSULTABLE_AGENT_KEYS
    .map((key) => `${key}（${agents[key]?.name || key}）`)
    .join(' / ');
  return [
  {
    functionDeclarations: [
      {
        name: 'get_current_time',
        description: '現在の日本時間（日時・曜日）を取得します。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'get_watchlist_updates',
        description: `${journalistName}が定期的に監視している要人・機関（日米の政府関係者・`
          + '政治家・テック企業・世界の指導者・国際機関・一次通信社等）の最新の発言・発表を'
          + '確認します。「トランプさんは何か言ってた？」「高市総理が何か発言した？」'
          + '「大きなニュースある？」のように、要人の動向や重大なニュースの有無を'
          + '聞かれたときに使います。0時・6時・12時・18時の1日4回、定期的に更新されています。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      // ── Google Workspace連携（secretary-tools-google.js） ──────────────────────
      ...googleToolDeclarations,
      {
        name: 'get_news',
        description: '最新のニュースの見出し・概要（既定8件）を取得し、あなた自身の声で伝えます。'
          // BUGFIX: 海外のニュースも scope で選べるようにしている。無かったころは、本文だけを Google 検索で得て
          // リンクは Yahoo のものを流用し、出典が食い違っていた。
          + '\n\n【scopeの選び方】既定（scope省略時）はYahoo Japanニュース（国内/国際/経済/IT等）です。'
          + '「海外のニュースを」「ワールドワイドで」「アメリカ発の」「US発の」のように'
          + '海外発の情報を明示的に求められた場合は、必ずscopeに"world"を指定してください'
          + '（指定しないと日本のメディアの記事しか手に入らず、海外発の記事のリンクを'
          + '案内できません）。scope="world"で取得できるのは、AI・テクノロジー分野'
          + '（TechCrunch・VentureBeat・MIT Technology Review）と、経済・市場分野（CNBC）の'
          + '英語メディアの記事です。スポーツ・芸能など他ジャンルの海外ニュースは'
          + 'これらのフィードには含まれないため、その場合は無理にscope="world"を使わず、'
          + '取得できる範囲を正直に伝えてください。'
          + '「最新ニュースを教えて」「今日のニュースは？」のように、エージェント名・センター名を一切含まない一般的な質問にだけ使います。'
          + '「報道センターに繋いで」「報道センターに繋いでニュースを教えて」「報道センターに読んでもらって」のように'
          + '「報道センター」という言葉が発言に含まれている場合は、このツールではなくconsult_agent（agent_key: news）を使ってください。'
          + '「AI関連のニュースを探して」「スポーツのニュースは？」のように特定の話題を指定された場合は、'
          + '必ずtopic引数にそのキーワードを渡してください（このツール自身がタイトル一致で機械的に絞り込みます。'
          + 'あなた自身の判断で一般ニュース一覧から該当しそうな項目を選び出そうとしないでください）。'
          + '「10件ほど」「5つくらい」のように件数を指定された場合は、必ずcount引数にその数値を渡してください'
          + '（指定が無ければ既定の8件のままで構いません）。'
          + 'topicを渡して0件だった場合は、その話題の見出しが現時点では無いことを正直に伝えてください'
          + '（一般ニュースの中から関連しそうな項目を無理にこじつけて紹介しないこと）。'
          + '結果を紹介する際は、実際に見つかった件数を最初に必ず伝えてください（例:「5件見つかりました」）。'
          + 'リスナーが指定した件数より少なかった場合も、隠さず正直にその件数を伝えてください'
          + '（「10件ほど検索します」のように先に件数を約束していた場合は特に、届かなかった件数を'
          + 'ごまかさず最初に伝えること）。'
          + '各項目には「URL: 〜」として記事の実際のリンクが付属しています。後から'
          + '「リンクも見せて」と頼まれshow_on_canvasで表示する場合は、必ずこのURLをそのまま使ってください'
          + '（存在しないURLを推測・創作することは絶対にしないでください）。',
        parameters: {
          type: 'OBJECT',
          properties: {
            topic: { type: 'STRING', description: 'リスナーが指定した話題のキーワード（例: "AI"、"スポーツ"、"台風"）。特定の話題を指定されていない一般的な質問の場合は省略すること。' },
            count: { type: 'INTEGER', description: 'リスナーが指定した希望件数（例: 10）。指定が無ければ省略すること（既定の8件になります）。' },
            scope: {
              type: 'STRING',
              description: '取得元。"world"＝海外の英語メディア（AI・テクノロジー／経済・市場）。'
                + '省略時は日本のYahoo Japanニュース。海外発の情報を求められたときだけ"world"を指定すること。',
              enum: ['world'],
            },
          },
        },
      },
      {
        name: 'get_weather',
        description: 'リスナーの居住地の現在の天気予報を取得し、あなた自身の声で伝えます（OpenWeatherMap）。'
          + '「今日の天気は？」のように、エージェント名・センター名を一切含まない一般的な質問にだけ使います。'
          + '「気象情報センターに繋いで」のように「気象情報センター」という言葉が発言に含まれている場合は、'
          + 'このツールではなくconsult_agent（agent_key: weather）を使ってください。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'get_finance',
        description: '株価指数・為替・債券利回りなど、管理画面に登録済みの金融ウォッチリストの最新値を取得し、あなた自身の声で伝えます。'
          + '**東京市場・米国市場それぞれが本日開いているか休場か、直近で終値が確定しているのはいつの取引か、次に開くのはいつか**も'
          + '同時に得られるため、「今日は市場やってる？」「米国市場は休み？」「ニューヨークは何時から？」といった質問にもこのツールを使います。'
          + '「日経平均は？」「マーケットの状況は？」のように、エージェント名・センター名を一切含まない一般的な質問にだけ使います。'
          + '「金融情報センターに繋いで」のように「金融情報センター」という言葉が発言に含まれている場合は、'
          + 'このツールではなくconsult_agent（agent_key: finance）を使ってください。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      // ── Spotify連携（secretary-tools-spotify.js） ──────────────────────
      ...spotifyToolDeclarations,
      // ── YouTube連携（secretary-tools-youtube.js） ──────────────────────
      ...youtubeToolDeclarations,
      {
        name: 'remember_fact',
        description: 'リスナーが「覚えておいて」「これは覚えておいて」のように明示的に記憶を依頼した内容を、'
          + '次回以降の会話でも参照できるよう保存します。リスナーが明示的に依頼したときだけ呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            fact: { type: 'STRING', description: `覚えておくべき内容を、後から読んでも意味が通る短い1文で（例: ${listenerName}さんは辛い物が苦手）` },
          },
          required: ['fact'],
        },
      },
      {
        name: 'end_session',
        description: 'リスナーが「切断して」「終了して」「もう大丈夫です、ありがとう」のように、会話を終えたい'
          + 'ことを明示的に伝えたときに呼び出します。呼び出す直前に必ず「かしこまりました、失礼します」'
          + 'のような短い別れの挨拶を、あなた自身の言葉で話してから呼び出してください。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'show_on_canvas',
        // 説明文に「いつ呼ぶか」（発動条件）を書く（Gemini Live のベストプラクティス）。「画面に表示しますね」と
        // 言いながら実際には呼ばないことが繰り返し起きているため。
        // ATTENTION: ツールの宣言は Live のターンごとに丸ごと課金されるので、説明文を長くしないこと。
        // Mermaid の書式のように、コードで確実に直せるものは secretary-tools.js の _normalizeMermaidInContent に
        // 任せ、説明文には書かない。
        description: 'メールのサマリー・株価一覧・レシピなど、音声だけでは聞き流して'
          + '忘れてしまうような情報を、見出し・箇条書き・太字を使ったMarkdown形式のテキストとして画面に表示します。'
          + '\n\n【発動条件】次のいずれかに当てはまったら、必ずこの機能を呼び出してください:\n'
          + '  ・リスナーが「キャンバスに表示して」「画面に出して」のように表示を明示的に依頼したとき\n'
          + '  ・あなた自身が「画面に表示しますね」「画面に出しておきます」等、表示すると口にしたとき\n'
          + '表示すると言ったのにこの機能を呼ばなければ、リスナーの画面には何も出ません。'
          + '言葉だけで済ませることは絶対にしないでください。'
          + '必要なデータがまだ手元に無い場合は、先に対応するget_*ツールやconsult_agentでデータを取得してから、'
          + 'その内容を分かりやすく整理してこのツールを呼び出してください。'
          // BUGFIX: リンクは、その項目自体の取得結果に付いていた URL だけを使わせる。本文は Google 検索から得て、
          // リンクだけ直前の get_news（Yahoo）のものを流用し、すべてのリンクが記事に繋がらなかったことがある。
          + '\n\n【リンク・厳守】URLは「今表示しようとしているその項目そのもの」の取得結果に付いていた、'
          + '実在が確認できているURLだけを使ってください。URLを推測・創作すること、別の話題や別の検索で'
          + '得た項目のURLを流用することは絶対にしないでください。実際のURLが手元に無い項目は、'
          + 'リンクを付けずに見出しと概要だけを表示してください'
          + '（誤ったリンクを付けるより、リンクが無い方がはるかに良いです）。'
          + '\n\n【グラフ】数値の推移や比較を「グラフにして」と言われたときは、contentの中に'
          + '```mermaid〜```のコードブロックでxychart-betaを書いてください。内訳・構成比を'
          + '「円グラフにして」と言われたときはpie showDataを使います。書式の細部（色指定・'
          + 'ラベルの引用符・コードブロックの囲み）はサーバー側で自動的に補正されるので、'
          + '下記の形に沿っていれば十分です。数値・ラベルはデータに基づいて正確に作成し、'
          + '架空の数値を創作しないこと。\n'
          + '  ```mermaid\n'
          + '  xychart-beta\n'
          + '      title "日経平均の推移"\n'
          + '      x-axis ["月", "火", "水"]\n'
          + '      y-axis "円" 64000 --> 67000\n'
          + '      bar [66300, 65900, 65683]\n'
          + '      line [66300, 65900, 65683]\n'
          + '  ```\n'
          + '  円グラフはpie showDataの次の行にtitleを書き、さらに「"ラベル" : 数値」を'
          + '1項目1行で並べます（各行は半角スペースでインデントすること）。',
        parameters: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'キャンバスの見出し（例: 本日のメールサマリー、注目銘柄一覧、本日のレシピ）' },
            content: { type: 'STRING', description: '表示する内容。Markdown形式（# 見出し、- 箇条書き、**太字**、```mermaid```によるグラフが使えます）' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'show_weather_map',
        description: '気象情報センターが放送でも使っている最新の地上天気図（気象庁）または雲画像の衛星画像（WeatherNews）を'
          + '取得し、キャンバスに画像として表示します。「天気図を見せて」「衛星画像を表示して」「気象情報センターの'
          + '天気図をキャンバスに出して」のように、天気図・衛星画像そのものを画面に表示したいと言われたときに使います。'
          + 'get_weatherやconsult_agent（weather）は文章での天気予報であり、この画像とは別物です。',
        parameters: {
          type: 'OBJECT',
          properties: {
            map_type: { type: 'STRING', description: '表示する画像の種類', enum: ['天気図', '衛星画像'] },
          },
          required: ['map_type'],
        },
      },
      {
        name: 'consult_agent',
        description: 'AI Radioの放送に出演している専門エージェント（ニュース・法律・経済・世界情勢など）に、放送とは無関係の個人的な相談として意見を求め、その本人の声で回答します。'
          // 本人の声が流れるまで30秒ほどかかるので、呼ぶ前に必ず一言話させる。
          // BUGFIX: 同じ指示は systemInstruction（buildAgentNameJudgmentSection）にもあるが、このツールに限って
          // 無言で呼ばれていた。離れた場所の一般則より、ツールを選ぶ瞬間に読む説明文に書く方が届く。
          + '\n\n【このツールを呼ぶ前に必ず一言話すこと】本人の声が流れ始めるまで30秒ほどかかります。'
          + '「〇〇さんにお繋ぎしますね。少々お待ちください」のように、誰に繋ぐのかを含む一言を'
          + '必ずあなた自身の声で話してから呼び出してください。無言で呼び出すと、リスナーは'
          + '何が起きているか分からないまま長く待たされることになります。'
          + `判断基準はただ一つ、発言の中にエージェント名またはセンター名（例: 報道センター、気象情報センター、金融情報センター、${legalName}）が`
          + `含まれているかどうかです。「${legalName}にこのメールの法的な良し悪しをチェックしてもらって」「報道センターに読んでもらって」`
          + `「報道センターに繋いで」「報道センターに繋いでニュースを教えて」「${weatherName}に聞いて」のように、`
          + 'エージェント名・センター名が発言に含まれている場合は、内容が「ニュースを教えて」等の一般的な依頼と同じであっても、'
          + '必ずこのツールを使ってください（get_news等で自分の声で代読してはいけません）。'
          + 'エージェント名・センター名が一切含まれない完全に一般的な質問（「ニュースを教えて」「天気は？」等）には使わず、'
          + 'get_news等の対応するget_*ツールを使ってください。'
          + `\n\n【個人データを材料にした相談】「この資産状況を${financeName}に分析してもらって」`
          + 'のように、あなたが持っている個人データ（資産の詳細・推移、メールの内容等）について'
          + `${financeName}等の専門エージェントの見解を求められた場合は、先に対応するget_*ツール`
          + '（例: 資産なら資産詳細取得・資産推移取得）でその内容を取得し、その結果をcontext_text'
          + 'に入れてこのツールを呼び出してください。あなた自身の言葉で読み上げるのではなく、'
          + '専門エージェント本人の声で解説してもらうのがこの機能の目的です。'
          + '\n\n【絶対禁止】このツールを実際には呼び出さずに、その専門エージェント本人が答えた'
          + 'かのような意見・分析・コメントをあなた自身で創作し、「〜さんに聞いたところ」'
          + '「〜さんの分析によると」のように本人の発言として話したり画面に表示したりすることは'
          + '絶対にしないでください。それは本人になりすまして偽の発言を作ることです。専門'
          + 'エージェントの見解が必要な場面では、必ずこのターン内で実際にこのツールを呼び出し、'
          + 'その戻り値だけを使ってください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            agent_key: {
              type: 'STRING',
              description: '相談する相手（キーと実際の名前）。依頼文に本人の名前が含まれて'
                + 'いる場合は、話題の分野に関わらず必ずその名前が指すキーを選ぶこと'
                + '（例: 金融データの話でも「高橋教授に」とあればcommentatorを選ぶ）。'
                + consultableAgentDescriptions,
              enum: CONSULTABLE_AGENT_KEYS,
            },
            task: { type: 'STRING', description: '何を相談・依頼したいか（例: このメールの内容に法的なリスクがないか教えてください）' },
            context_text: { type: 'STRING', description: '相談材料となる本文（メールの内容など）。無ければ省略可' },
          },
          required: ['agent_key', 'task'],
        },
      },
      // ── Obsidian連携（secretary-tools-obsidian.js） ──────────────────────
      ...obsidianToolDeclarations,
      // ── 日報・週報生成（secretary-tools-reports.js） ──────────────────────
      ...reportsToolDeclarations,
      // ── 資産（金融）レポート（secretary-tools-finance.js） ──────────────────────
      ...financeToolDeclarations,
      // ── 会話履歴の横断参照（secretary-tools-history.js） ──────────────────────
      // この一覧は LINE（secretary-line.js）も使うので、音声からも LINE からも、もう一方の会話を参照できる。
      ...historyToolDeclarations,
      // ── プレゼンテーション作成（secretary-tools-presentation.js） ──────────────
      ...presentationToolDeclarations,
      {
        name: 'analyze_uploaded_file',
        description: 'リスナーがアップロードしたファイル（PDF・画像・音声・動画・CSV・Markdown・'
          + 'テキスト等、形式は問いません）を分析します。ファイルがアップロードされると'
          + '「(ファイル「〇〇」がアップロードされました。file_id: xxxx)」という形でfile_idが'
          + '伝えられるので、それをそのまま使ってください。「これに対して〜をしてください」'
          + '「この決算書を分析して」のように、何をしてほしいかの指示（instruction）とあわせて'
          + '呼び出してください。ファイルがアップロードされていない状態でこのツールを呼ばないこと。'
          + 'このツール自身は形式を制限していないため、内容を読み取れなかった場合はエラーとして'
          + '返ってきます。その場合は正直にリスナーへ「この形式は読み取れませんでした」等と伝えて'
          + 'ください（対応できるかのように装わないこと）。'
          // 「いつ呼ぶか」（発動条件）を明記する（Gemini Live のベストプラクティス）
          + '\n\n【発動条件】アップロードされたファイルについて何かを尋ねられたら、必ずこの機能を'
          + '呼び出してください。この機能を呼ばない限り、あなたはファイルの中身を一切見ていません。'
          + 'ファイル名や拡張子から中身を推測して答えることは絶対にしないでください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            file_id: { type: 'STRING', description: 'アップロード通知で伝えられたfile_id' },
            instruction: { type: 'STRING', description: 'ファイルに対して何をしてほしいか（例: 主な収益と費用の変化を要約してください）' },
          },
          required: ['file_id', 'instruction'],
        },
      },
      {
        name: 'analyze_google_sheet',
        description: 'リスナーがテキスト共有欄で共有した情報の中に、GoogleスプレッドシートのURL'
          + '（docs.google.com/spreadsheets/…）が含まれていた場合に、その内容を分析します。'
          + 'urlには共有された内容に含まれるURLをそのまま（一字一句変えずに）渡してください'
          + '（声で聞き取ってURLを推測・作文することは絶対にしないでください）。「このシートを'
          + '分析して」「売上の傾向を教えて」のように、何をしてほしいかの指示（instruction）と'
          + 'あわせて呼び出してください。'
          // 「いつ呼ぶか」（発動条件）を明記する（Gemini Live のベストプラクティス）
          + '\n\n【発動条件】共有されたスプレッドシートについて何かを尋ねられたら、必ずこの機能を'
          + '呼び出してください。この機能を呼ばない限り、あなたはシートの中身を一切見ていません。'
          + 'URLやファイル名から中身を推測して答えることは絶対にしないでください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: { type: 'STRING', description: '共有された内容に含まれるGoogleスプレッドシートのURL' },
            instruction: { type: 'STRING', description: 'シートに対して何をしてほしいか（例: 各月の売上合計を比較して傾向を教えてください）' },
          },
          required: ['url', 'instruction'],
        },
      },
      {
        name: 'analyze_web_page',
        description: 'リスナーがテキスト共有欄で共有した情報の中に、Googleスプレッドシート以外の'
          + '一般的なWebページのURLが含まれていた場合に、そのページを取得して内容を分析します。'
          + 'urlには共有された内容に含まれるURLをそのまま（一字一句変えずに）渡してください'
          + '（声で聞き取ってURLを推測・作文することは絶対にしないでください）。「このページの'
          + '内容を要約して」のように、何をしてほしいかの指示（instruction）とあわせて呼び出して'
          + 'ください。'
          // 「いつ呼ぶか」（発動条件）を明記する（Gemini Live のベストプラクティス）
          + '\n\n【発動条件】共有されたWebページについて何かを尋ねられたら、必ずこの機能を'
          + '呼び出してください。この機能を呼ばない限り、あなたはそのページを一切読んでいません。'
          + 'URLや見出しから内容を推測して答えることは絶対にしないでください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: { type: 'STRING', description: '共有された内容に含まれるWebページのURL' },
            instruction: { type: 'STRING', description: 'ページに対して何をしてほしいか（例: 内容を3分で分かるように要約してください）' },
          },
          required: ['url', 'instruction'],
        },
      },
      // ── ヘルパーエージェント ────────────────────────────────────────────
      {
        name: 'ask_helper',
        description: '**あなたが実際の作業を行うための、唯一の窓口です。**'
          + 'メールの確認、天気・ニュース・株価の取得、カレンダーの確認や予定の登録、'
          + 'Obsidianへの記録、ファイルやWebページの分析、集計・計算、グラフ作成、'
          + 'プレゼン資料の作成、専門エージェントへの相談——'
          + 'リスナーが「〇〇して」と頼んだことは、内容を問わずすべてこの機能へ渡してください。'
          + '\n裏方のヘルパーがあらゆる機能を使って実行し、必要ならPythonのコードを書いて'
          + '計算やグラフ作成まで行います。結果は自動的に画面へ表示され、あなたへも知らされます。'
          + '\n\n【発動条件】リスナーから何かを頼まれたら、まずこの機能を呼んでください。'
          + '「調べる」「取ってくる」「作る」「記録する」はすべてヘルパーの仕事です。'
          + '自分でやろうとしないでください。'
          + '\n\n【例外・この機能を使わない依頼】次の場合だけは、あなたが直接扱ってください:\n'
          + '  ・時刻の確認、覚えておくこと、手元の情報の画面表示、会話の終了\n'
          + '  ・**エージェント名やセンター名を挙げて「繋いで」「聞かせて」と言われた場合**'
          + '（例:「報道センターに繋いでニュースを聞かせて」「弁護士さんに聞いて」）。'
          + 'これは専門エージェント本人の声で答えてもらう機能で、ヘルパーを経由すると'
          + '本人の声が失われてしまうため、専用の相談機能を直接呼び出してください'
          + '\n\n【requestの書き方】リスナーの依頼をあなたの言葉で具体的にまとめて渡してください。'
          + '会話の流れで分かっている前提（対象のデータがどこにあるか、いつの分か、どの口座か等）は、'
          + 'ヘルパーは知らないので必ず書き添えてください。'
          + '\n\n【最重要】この機能はすぐに返ってきますが、それは「受け付けた」という意味であって'
          + '**作業が終わったわけではありません。** 結果を知っているかのように話すことは絶対に'
          + 'しないでください。完了すると自動的にお知らせが届くので、そのときに要点を伝えてください。'
          + '\n待ち時間を告げる一言は、この機能を呼ぶ**前に一度だけ**で十分です。'
          + '呼び出した後に改めて「お待ちください」と言い直さないでください（同じ案内が'
          + '二度三度続くと、リスナーには不具合に見えます）。'
          + '\n同じ依頼をこの機能へ二度渡さないでください。一度渡したら、完了の知らせを待ってください。'
          // BUGFIX: 「ヘルパーに依頼します」のように内部の仕組みを口に出させない。リスナーから見れば、
          // 作業をしているのは秘書本人。
          + '\n\n【厳守】「ヘルパー」「裏方」といった内部の仕組みの話を、リスナーへ口に出さないで'
          + 'ください。リスナーから見れば、作業をしているのはあなた自身です。'
          + '「確認しますね」「お調べします」のように、あなたが行うこととして伝えてください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            request: { type: 'STRING', description: 'ヘルパーへの依頼内容（具体的に。対象のデータの所在と、してほしいことを含める）' },
          },
          required: ['request'],
        },
      },
      {
        name: 'get_job_status',
        description: '裏方のヘルパーへ依頼した作業が今どうなっているかを確認します。'
          + '\n\n【発動条件】「さっきのどうなった？」「まだかかる？」「終わった？」のように、'
          + '依頼した作業の進み具合を尋ねられたら、必ずこの機能を呼び出してください。'
          + '推測で「もう少しで終わります」などと答えないでください——'
          + 'この機能を呼ばない限り、あなたは進捗を知りません。',
        parameters: { type: 'OBJECT', properties: {} },
      },
    ],
  },
  // 交通情報は Live と同じく Google 検索のグラウンディングでその場で取る（交通情報センターは実際の
  // データを持たず作り話の危険があるので、consult_agent の相手にしない）。API キーでのサーバー間の
  // 接続なので、function calling と一緒に使う制限は受けない。
  { googleSearch: {} },
  ];
}

module.exports = {
  LIVE_ONLY_TOOL_NAMES, buildSecretaryTools, buildAllSecretaryTools,
  NON_LIVE_CONTROL_TOOL_NAMES, buildLineSecretaryTools,
};
