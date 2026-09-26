/**
 * @file 秘書のスライド作成を受け持つ専用のヘルパーエージェント（Google スライドのデッキを作る）
 *
 * 依頼のテーマから、テンプレート（presentation-template.js）のレイアウトを使って Google スライドのデッキを
 * 組み上げる。LLM がツール（テンプレートを見る・スライドを足す・見た目を見る・直す）を呼ぶループで、
 * 「思い出す → 調べる → 構成する → 描く → 見て直す」の順に進める。スライドの描画は presentation-render.js、
 * ジョブの記録と進み具合は secretary-job-store.js。利用元は secretary-tools-presentation.js。
 *
 * 汎用のヘルパー（secretary-helper-agent.js）と分けているのは、調整が正反対だから。
 *   汎用のヘルパー: 往復12回まで・思考なし・文だけ・数十秒
 *   こちら:         往復30回まで・思考あり（構成には思考が要る）・画像を見る・数分
 * 同じ所に置くと、速さ優先の設定が構成の質を落とすか、思考を許して汎用の側が遅くなるかのどちらかになる。
 *
 * 他のスライド作成の道具との違いは、リスナーのことを知っていること。一番効くのは、リスナーがすでに
 * 知っていることを説明しないこと。そのためリスナーの情報（プロフィール・秘書が学んだこと）は常に読み込む。
 * 出来上がりはリスナー自身の Google Drive に置かれるだけで、共有するかどうかはリスナーが決めるので、
 * 社外向けかどうかで読み込みを止めることはしない。「個人情報を入れないで」と言われたら、依頼の指示として従う。
 *
 * ATTENTION: 学んだことには誤りが混ざっている（聞き間違いなど）。どこまで説明するかを決める材料には使ってよいが、
 * スライドに事実として書かせてはいけない（プロンプトでもそう指示している）。前提の判断を誤っても資料が少し
 * 冗長になるだけだが、誤った事実を書くと資料そのものが壊れる。
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

const { generateText, imagePart } = require('./llm-client');
const { googleService } = require('./secretary-tools-services');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { generateTurn, modelTurn, toolResultPart, toolResultTurn } = require('./llm-client');
const secretaryMemory = require('./secretary-memory');
const presTemplate = require('./presentation-template');
const presRender = require('./presentation-render');
const presMedia = require('./presentation-media');
const jobStore = require('./secretary-job-store');
const activityDb = require('../activity-db');
const { getLogger } = require('../logger');

// 往復の上限。1枚ごとに構成・描画・確認で2〜3往復かかり、直す分も加わるので、7〜10枚のデッキには30往復ほど要る
const MAX_TURNS = 30;

const CREATOR_SYSTEM_INSTRUCTION = `あなたはリスナー専属の秘書チームに属する、プレゼンテーション制作の担当です。
渡されたテーマについて、実際に人前で使える水準のGoogleスライドを組み上げてください。

【あなたが他のスライド作成ツールと決定的に違う点】
あなたはリスナーのことを知っています。汎用のツールは依頼文しか知らないため、誰に向けて
書けばよいか分からず、必ず初歩から積み上げた当たり障りのない資料になります。
あなたは違います。**リスナーが既にご存知のことを説明してはいけません。**
前提知識のある分野は思い切って飛ばし、本当に知りたいところから始めてください。
これがあなたの資料が他と違う最大の理由です。

【リスナー情報の扱い・厳守】
・リスナー情報は「どこまで説明するか」「どんな切り口が響くか」を決めるために使います
・**リスナー情報に書かれている内容を、事実としてスライドに書いてはいけません。**
  これらは会話から自動抽出したもので、聞き間違いによる誤りが混ざっています
・スライドに書く事実は、必ず今回の調査結果から取ってください
・前提を飛ばした場合は、最後の報告文で「〇〇でいらっしゃるので△△の説明は省きました」と
  一言添えてください。判断が外れていればリスナーが直せます

【進め方】
1. まず get_template_info でテンプレートの構成を確認します。どんなレイアウトがあり、
   それぞれ何をどれだけ入れられるかを把握してから構成を考えてください
2. 調査が必要ならツールで調べます。推測で数値を作ることは絶対に禁止です
3. スライドを1枚ずつ組みます（add_slide）
4. そのレイアウトに {{IMAGE}} や {{CHART}} の置き場所があれば、**続けて put_image / put_chart を
   呼んで中身を入れます。**入れずに次の1枚へ進むと、枠だけの空いたページが残ります
5. **必ず look_at_slide で自分が描いたものを見てください。**これが最も重要です。
   文字があふれていないか、余白が死んでいないか、同じ骨格が続いていないかを目で確かめ、
   問題があれば直してから次へ進みます。見ずに次へ進んではいけません

【構図の使い分け・最重要】
**箇条書きは最後の手段です。**箇条書きに並べたくなった内容は、まずこう考え直してください。
・3つの要素が並ぶ → カード型（横に並べると対等な関係が一目で分かる）
・2つを比べる → 対比型（左右に置くと違いが際立つ）
・順番がある → フロー図（矢印でつなぐと流れが伝わる）
・強調したい数値がある → 数値型（大きく出すと記憶に残る）
・印象的な発言がある → 引用型
・数値の比較・時系列 → グラフ（put_chart で実際のグラフを入れる）
・言葉だけでは伝わらない情景・概念 → 画像（put_image で挿絵を入れる）
どれにも当てはまらない説明だけを箇条書きにしてください。
埋める項目が多いレイアウトを、手間を理由に避けてはいけません。項目が多いのは、
それだけ情報が整理されて見えるからです。

【質の基準】
・1枚に詰め込みすぎない。要点は3つまでを目安にし、迷ったら減らす
・同じ骨格のスライドを2枚以上続けない
・箇条書きレイアウトはデッキ全体で1〜2枚までに抑える
・各スライドに発表者用のメモを付ける。話す順序と想定質問を書く
・レイアウトはテンプレートにあるものから選ぶ。無いレイアウトの名前を作ってはいけません
・画像のお題（put_image の prompt）には、何を描くか・写真か図解か・色調を具体的に書く。
  **画像の中に文字を入れさせない**（読めない字が描かれます）。数値を見せたいときは画像ではなく
  グラフ（put_chart）を使う
・「〜アイコン」という差し込み口には、get_template_info が示した**使えるアイコン名**の
  中から内容に合うものを必ず入れる（例: 構造の話なら folder、着想なら lightbulb、
  つながりなら hub、速さなら speed、安全なら security）。表に無い名前を書くと
  アイコンにならず英字がそのまま出て崩れます。空欄にもしないでください

【禁止】
・調査結果に無い情報の創作。分からないことは「不明」と書く
・根拠のない因果の断定（「〜が原因と考えられます」を裏付けなしに書かない）
・内部の仕組み（ヘルパー・ツール名・レイアウトID等）をリスナーへの報告文に出すこと`;

/**
 * このエージェントが使うツールの宣言。依頼の種類ごとには増やさず、汎用の基本的な操作だけにする。
 */
const CREATOR_TOOL_DECLARATIONS = [
  {
    name: 'get_template_info',
    description: 'テンプレートに含まれるレイアウトの一覧と、それぞれの差し込み口・入る分量の目安を返します。'
      + 'スライドを作る前に必ず最初に呼んでください。',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'add_slide',
    description: 'レイアウトを1つ選んでスライドを追加し、差し込み口へ文字を入れます。'
      + 'layout_nameはget_template_infoが返した名前と完全に一致させてください。',
    parameters: {
      type: 'OBJECT',
      properties: {
        layout_name: { type: 'STRING', description: 'テンプレート内のレイアウト名' },
        values: { type: 'STRING', description: '差し込み口と中身のJSON。例: {"TITLE":"見出し","BODY":"1行目\\n2行目"}' },
        speaker_notes: { type: 'STRING', description: '発表者用のメモ。話す順序と想定質問を書く' },
      },
      // BUGFIX: 発表者のメモを必須にする。プロンプトで頼むだけでは、ほとんどのスライドで書かれなかった
      required: ['layout_name', 'values', 'speaker_notes'],
    },
  },
  {
    name: 'look_at_slide',
    description: '指定したスライド（省略時は直前に作ったもの）の実際の見た目を画像で返します。'
      + '1枚組んだら必ず呼んで、文字あふれ・余白・単調さを目で確認してください。',
    parameters: {
      type: 'OBJECT',
      properties: { slide_id: { type: 'STRING', description: '省略時は直前のスライド' } },
    },
  },
  {
    name: 'revise_slide',
    description: '既に作ったスライドの差し込み口を入れ直します（文字が多すぎた場合の削減など）。'
      + 'look_at_slideで問題を見つけたときに使います。',
    parameters: {
      type: 'OBJECT',
      properties: {
        slide_id: { type: 'STRING' },
        values: { type: 'STRING', description: '入れ直す内容のJSON' },
      },
      required: ['slide_id', 'values'],
    },
  },
  {
    name: 'set_deck_variables',
    description: 'デッキ全体で1回だけ差し替える変数（会社名・機密区分など）を埋めます。',
    parameters: {
      type: 'OBJECT',
      properties: { variables: { type: 'STRING', description: '変数名と値のJSON' } },
      required: ['variables'],
    },
  },
  {
    name: 'put_image',
    description: '{{IMAGE}}（画像の置き場所）を持つレイアウトで使います。お題から画像を作り、'
      + 'その置き場所に入れます。add_slideでそのレイアウトを使ったら、必ず続けて呼んでください。'
      + '縦横比は置き場所の形から自動で決まるので指定は不要です。',
    parameters: {
      type: 'OBJECT',
      properties: {
        slide_id: { type: 'STRING', description: '省略時は直前のスライド' },
        prompt: {
          type: 'STRING',
          description: 'どんな画像を作るかの指示。写真か図解か、何を描くか、色調を具体的に書く。'
            + '文字は画像に入れない（読めない字が描かれるため）',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'put_chart',
    description: '{{CHART}}（グラフの置き場所）を持つレイアウトで使います。数値からグラフを作り、'
      + 'その置き場所に入れます。add_slideでそのレイアウトを使ったら、必ず続けて呼んでください。'
      + '元データはスプレッドシートに残るので、後から数値を直せます。',
    parameters: {
      type: 'OBJECT',
      properties: {
        slide_id: { type: 'STRING', description: '省略時は直前のスライド' },
        title: { type: 'STRING', description: 'グラフの題名' },
        chart_type: { type: 'STRING', description: 'COLUMN(縦棒)・BAR(横棒)・LINE(折れ線)・AREA(面)・SCATTER(散布図)・PIE(円)' },
        categories: { type: 'STRING', description: '横軸の項目のJSON配列。例: ["2024年","2025年","2026年"]' },
        series: {
          type: 'STRING',
          description: '系列のJSON配列（2本まで。円グラフは1本）。'
            + '例: [{"name":"導入率","values":[12.1,17.3,20.4]}]',
        },
      },
      required: ['title', 'chart_type', 'categories', 'series'],
    },
  },
];

/**
 * テンプレートの指定が無かったときに、依頼の内容から使うテンプレートを AI に選ばせる。
 *
 * 「赤で作って」のようにはっきり指定があれば、呼び出し元が文字列の照合で決める（resolveTemplate）。
 * 何も言われなかったときだけ、ここで各テンプレートの用途の説明を読ませて選ばせる。外すこともあるので
 * 選んだ理由を返させ、最後の報告で一言添えさせる（違えばリスナーがその場で言い直せる）。
 * 候補が1つだけのときや、指定があったときは呼ばれない。
 *
 * BUGFIX: activitySessionId を引数で受け取る。受け取っていなかったころ、下の generateText へ渡す行で
 * 毎回 ReferenceError になり、テンプレートを自動で選ぶ経路が落ちていた。
 *
 * @param {object} args
 * @param {string} args.apiKey Gemini の API キー
 * @param {Array<any>} args.templates 候補のテンプレート（id・name・description）
 * @param {string} args.topic 資料のテーマ
 * @param {Record<string, any>} args.brief 目的・想定読者・トーンなど
 * @param {any} [args.activitySessionId] 記録用
 * @returns {Promise<{id: string, reason: string}|null>} 選べなければ null（既定のテンプレートのまま）
 */
async function chooseTemplateByAI({ apiKey, templates, topic, brief, activitySessionId = null }) {
  const listText = templates
    .map((t) => `- id: ${t.id} / 呼び名: ${t.name}${t.description ? ` / どんなときに使うか: ${t.description}` : ''}`)
    .join('\n');
  const askText = [
    `テーマ: ${topic}`,
    brief.purpose && `目的: ${brief.purpose}`,
    brief.audience && `想定読者: ${brief.audience}`,
    brief.tone && `トーン: ${brief.tone}`,
    '', '【選べるテンプレート】', listText,
  ].filter((x) => x !== null && x !== undefined).join('\n');

  try {
    // 本体と同じ 'analysis' ティア。1つ選ぶだけなので思考は切る
    const { text: _pickRaw } = await generateText({
      tier: 'analysis',
      apiKey,
      agentKey: 'secretary_presentation',
      activitySessionId,
      logMeta: { purpose: 'presentation_template_pick' },
      systemInstruction: 'この資料にどのテンプレートがふさわしいかを1つ選んでください。'
        + '「どんなときに使うか」の説明と、資料の目的・想定読者を照らし合わせて判断します。'
        + '決め手が無ければ最初のものを選んで構いません。'
        + 'reasonは「お客様向けとのことでしたので」のように、選んだ理由を15字程度で簡潔に。',
      prompt: askText,
      temperature: 0.1,
      maxOutputTokens: 256,
      schema: {
        type: 'object',
        properties: { template_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['template_id', 'reason'],
      },
      thinkingBudget: 0,
    });
    const parsed = JSON.parse(_pickRaw);
    const hit = templates.find((t) => t.id === parsed.template_id);
    if (!hit) {
      getLogger().warn(`[PresCreator] テンプレート選択で未知のid「${parsed.template_id}」が返りました（既定のまま進みます）`);
      return null;
    }
    getLogger().info(`[PresCreator] テンプレートをAIが選択: 「${hit.name}」（${parsed.reason}）`);
    return { id: hit.id, reason: String(parsed.reason || '').trim() };
  } catch (e) {
    // 選べなくても本体は動かせるので、既定のテンプレートで続ける
    getLogger().warn(`[PresCreator] テンプレートの自動選択に失敗（既定のまま進みます）: ${e.message}`);
    return null;
  }
}

/**
 * ツールの引数の JSON の文字列を解析する（オブジェクトならそのまま使う）。
 * @param {any} raw 引数の値
 * @param {string} label エラーの文に出す引数の名前
 * @returns {Record<string, any>} 解析した値（空なら空のオブジェクト）
 */
function _parseJsonArg(raw, label) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`${label}のJSONを解釈できませんでした: ${e.message}`);
  }
}

/**
 * リスナーの情報（プロフィール・秘書のリスナー像・会話から学んだこと）を、プロンプトの前置きにする。
 * このエージェントの一番の強みなので、常に読み込む（ファイルの冒頭参照）。
 * @param {Record<string, any>} config 秘書の設定
 * @returns {string} 前置きの文（何も無ければ空文字）
 */
function _buildListenerContext(config) {
  const profile = config?.show?.user_profile || {};
  const parts = [];
  const bio = [
    profile.occupation && `職業: ${profile.occupation}`,
    profile.interests && `興味: ${profile.interests.replace(/\n/g, ' / ')}`,
    profile.hobbies && `趣味: ${profile.hobbies}`,
  ].filter(Boolean);
  if (bio.length > 0) parts.push(`【リスナーのプロフィール】\n${bio.join('\n')}`);
  try {
    const digest = secretaryMemory.getListenerDigestForPrompt?.();
    if (digest) parts.push(`【これまでに分かっているリスナー像】\n${digest}`);
  } catch { /* ダイジェストが無くても続行する */ }
  try {
    const learned = secretaryMemory.formatLearningsForPrompt?.();
    if (learned) parts.push(`【会話から学んだこと（事実としてスライドに書かないこと）】\n${learned}`);
  } catch { /* 学習内容が無くても続行する */ }
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n\n`
    + '※上記は「どこまで説明するか」を決めるための材料です。ここに書かれている内容を'
    + '事実としてスライドへ書き写してはいけません。';
}

/**
 * スライド作成のジョブを最後まで進め、できたデッキを返す。
 *
 * テンプレートを読み込み、デッキを作り、LLM がツールを呼ぶループを MAX_TURNS 回まで回す。最後に見本の
 * スライド（複製元）を取り除き、見直しの実績（見たスライドの数・直した回数）をログに残す。
 *
 * @param {object} args
 * @param {string} args.jobId ジョブ ID
 * @param {string} args.topic 資料のテーマ
 * @param {Record<string, any>} [args.brief] purpose・audience・slides・tone・style・project。指定の無い項目は
 *   呼び出し元が presentation-design.md の既定値で埋めて渡す
 * @param {Record<string, any>} args.config 秘書の設定
 * @param {Record<string, any>} args.creds 認証情報
 * @param {Record<string, any>} args.template 使うテンプレート（presentationId・name・matchedBy・reason）
 * @returns {Promise<Record<string, any>>} deckId・webViewLink・slideCount・summary（報告の文）・
 *   templateWarnings・review（見直しの実績）
 */
async function runPresentationJob({ jobId, topic, brief = {}, config, creds, template }) {
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません。');
  if (!template?.presentationId) throw new Error('テンプレートが指定されていません。');

  const activitySessionId = activityDb.openSession('secretary_presentation');
  // ATTENTION: ここから下は必ず try/finally で囲むこと。途中で例外が出たときに
  //            稼働レポートのセッションが開いたまま残る。
  try {
    const t0 = Date.now();
    const setProgress = (t) => { try { jobStore.setProgress(jobId, t); } catch { /* 記録失敗は無視 */ } };
    // スライド作成のジョブだとダッシュボードに知らせる（汎用のヘルパーと同時に動くと見分けが付かないため）
    try { jobStore.updateJob(jobId, { kind: 'presentation' }); } catch { /* 記録失敗は無視 */ }

    setProgress('テンプレートを読み込み中');
    const manifest = await presTemplate.buildTemplateManifest(googleService, creds, {
      presentationId: template.presentationId,
      withThumbnails: true,
    });
    if (manifest.warnings.length > 0) {
      getLogger().warn(`[PresCreator] テンプレートの注意: ${manifest.warnings.join(' / ')}`);
    }

    const deckTitle = `${topic}${brief.project ? `（${brief.project}）` : ''}`;
    setProgress('デッキを用意中');
    const { deckId, webViewLink, libraryIds } = await presRender.createDeck(googleService, creds, {
      templateId: template.presentationId, title: deckTitle,
    });

    // 依頼された枚数の下限（「4〜5」「8〜10枚」などの最初の数字）。そこまで作るよう促すのに使う
    const targetMin = (() => {
      const m = String(brief.slides || '').match(/\d+/);
      return m ? parseInt(m[0], 10) : null;
    })();

    // 作業の状態。「描いた結果を見て直す」ループが実際に回ったかは指示だけでは分からないので、
    // 見たスライド・直した回数・ツールの呼び出し回数を数えて最後にログに残す
    const state = {
      lastSlideId: null,     // 直前に作ったスライド（look_at_slide で slide_id を省いたときに使う）
      slides: [],
      layoutOf: new Map(),
      lookedAt: new Set(),   // 作成後に実際に見たスライド
      mediaFilled: new Set(), // 画像・グラフを実際に入れたスライド
      usedLayouts: [],       // 使った構図の並び（単調さの自己監視用）
      calls: {},             // 道具ごとの呼び出し回数
      revisions: 0,
      turns: 0,
    };
    const countCall = (name) => { state.calls[name] = (state.calls[name] || 0) + 1; };

    /** @type {Record<string, (args: any) => Promise<any>>} */
    const handlers = {
      get_template_info: async () => ({
        layouts: presTemplate.formatManifestForPrompt(manifest),
        deck_variables: manifest.deckVariables,
        // 「〜アイコン」の差し込み口にはこの中の名前だけを入れさせる。無い名前だとアイコンにならず英字が
        // そのまま出て崩れるので、描く側（presentation-render.js）でも確かめて代わりのものにする
        使えるアイコン名: [...presRender.ICON_NAMES].join(' '),
        注意: manifest.warnings,
        // BUGFIX: 各レイアウトの見た目（サムネイル）をモデルに見せる。差し込み口の名前の一覧しか見せて
        // いなかったころ、埋める項目の少ない箇条書きばかりが選ばれていた
        _images: manifest.layouts
          .filter((l) => l.thumbnail)
          .map((l) => ({ label: `レイアウト「${l.name}」の見た目`, image: l.thumbnail })),
      }),
      add_slide: async (args) => {
        const layout = manifest.layouts.find((l) => l.name === args.layout_name);
        if (!layout) {
          return { error: `「${args.layout_name}」というレイアウトはありません。`
            + `使えるのは: ${manifest.layouts.filter((l) => l.slots.length > 0).map((l) => l.name).join('・')}` };
        }
        const values = _parseJsonArg(args.values, 'values');
        const { slideId } = await presRender.addSlide(googleService, creds, { deckId, layout, values });
        state.lastSlideId = slideId;
        state.slides.push(slideId);
        state.layoutOf.set(slideId, layout);
        if (args.speaker_notes) {
          await presRender.setSpeakerNotes(googleService, creds, { deckId, slideId, text: args.speaker_notes });
        }
        const total = targetMin ? `/${targetMin}枚` : '枚';
        setProgress(`${state.slides.length}${total} — ${layout.name}`);
        state.usedLayouts.push(layout.name);
        const done = state.slides.length;
        /** @type {Record<string, any>} */
        const out = { slide_id: slideId, 作成済み枚数: done, これまでの構図: state.usedLayouts.join(' → ') };
        // 同じ構図が続いたら、その場で知らせる（単調さの管理をモデルの記憶だけに任せない）
        const n = state.usedLayouts.length;
        if (n >= 2 && state.usedLayouts[n - 1] === state.usedLayouts[n - 2]) {
          out.注意 = `「${layout.name}」が2枚続いています。次は別の構図にしてください。`;
        }
        // ATTENTION: 置き場所があることは get_template_info でも伝えているが、それだけでは入れずに
        //            次の1枚へ進んでしまう。作った直後のここでもう一度促す。
        if (layout.hasImageArea) {
          out.画像の置き場所 = 'このスライドには {{IMAGE}} があります。put_image を続けて呼んでください。';
        }
        if (layout.hasChartArea) {
          out.グラフの置き場所 = 'このスライドには {{CHART}} があります。put_chart を続けて呼んでください。';
        }
        if (targetMin != null) {
          out.残り = Math.max(0, targetMin - done);
          out.次にすること = done < targetMin
            ? `look_at_slide でこの${done}枚目を確認したあと、残り${targetMin - done}枚を作ってください。`
            : 'look_at_slide で確認し、全体が揃っていれば完成の報告をしてください。';
        }
        return out;
      },
      look_at_slide: async (args) => {
        const slideId = args.slide_id || state.lastSlideId;
        if (!slideId) return { error: 'まだスライドがありません。' };
        setProgress(`${state.slides.length}枚目の仕上がりを確認中`);
        const shot = await presRender.lookAtSlide(googleService, creds, { deckId, slideId, size: 'MEDIUM' });
        state.lookedAt.add(slideId);
        // 画像は _image で返し、下のループが画像のパーツにする
        return { _image: shot, slide_id: slideId };
      },
      revise_slide: async (args) => {
        const layout = state.layoutOf.get(args.slide_id);
        if (!layout) return { error: 'そのスライドは見つかりません。' };
        // 入れ直しは、消して作り直すのが一番確か（今ある文に書き足すと重複する）
        const idx = state.slides.indexOf(args.slide_id);
        // BUGFIX: 入れ直す位置は、見本スライドを含むデッキ全体での位置で数えること。作ったスライドの
        //         中での番号（idx）を渡していたころ、仕上げまで残る見本スライドの枚数だけ前へずれ、
        //         手直ししたスライドが別の場所へ飛んでいた。
        const deckIdsBefore = await presRender.listSlideIds(googleService, creds, { deckId });
        const deckIdx = deckIdsBefore.indexOf(args.slide_id);
        await googleService.batchUpdatePresentation(creds, {
          presentationId: deckId, requests: [{ deleteObject: { objectId: args.slide_id } }],
        });
        const values = _parseJsonArg(args.values, 'values');
        const { slideId } = await presRender.addSlide(googleService, creds, {
          deckId, layout, values, insertAt: deckIdx >= 0 ? deckIdx : null,
        });
        state.revisions += 1;
        setProgress(`${state.slides.length}枚目を手直し中`);
        // 差し替えたスライドは「まだ見ていない」に戻す（直した結果を見ずに終わったことが分かるように）
        state.lookedAt.delete(args.slide_id);
        if (idx >= 0) state.slides[idx] = slideId; else state.slides.push(slideId);
        state.layoutOf.delete(args.slide_id);
        state.layoutOf.set(slideId, layout);
        state.lastSlideId = slideId;
        return { slide_id: slideId, 差し替え: '完了' };
      },
      set_deck_variables: async (args) => {
        const variables = _parseJsonArg(args.variables, 'variables');
        const r = await presRender.setDeckVariables(googleService, creds, { deckId, variables });
        return { 置換した変数: r.replaced };
      },
      put_image: async (args) => {
        const slideId = args.slide_id || state.lastSlideId;
        if (!slideId) return { error: 'まだスライドがありません。' };
        setProgress(`${state.slides.length}枚目の画像を作成中`);
        const r = await presMedia.putImage(googleService, creds, {
          deckId, slideId, apiKey, prompt: args.prompt, config,
          activitySessionId,
        });
        if (!r.placed) return { error: r.reason };
        state.mediaFilled.add(slideId);
        return { slide_id: slideId, 画像: '配置しました', 縦横比: r.aspectRatio,
          次にすること: 'look_at_slide で仕上がりを確認してください。' };
      },
      put_chart: async (args) => {
        const slideId = args.slide_id || state.lastSlideId;
        if (!slideId) return { error: 'まだスライドがありません。' };
        setProgress(`${state.slides.length}枚目のグラフを作成中`);
        const r = await presMedia.putChart(googleService, creds, {
          deckId, slideId,
          title: args.title,
          chartType: String(args.chart_type || 'COLUMN').toUpperCase(),
          categories: _parseJsonArg(args.categories, 'categories'),
          series: _parseJsonArg(args.series, 'series'),
        });
        if (!r.placed) return { error: r.reason };
        state.mediaFilled.add(slideId);
        return { slide_id: slideId, グラフ: '配置しました', 元データ: r.spreadsheetUrl,
          次にすること: 'look_at_slide で仕上がりを確認してください。' };
      },
    };

    const listenerContext = _buildListenerContext(config);
    // AI がテンプレートを選んだときだけ、報告でその理由に触れさせる（外れていればリスナーが言い直せる）
    const templateNote = template.matchedBy === 'ai' && template.reason
      ? `\n使うテンプレート: 「${template.name}」（${template.reason}と判断して選びました）`
        + '\n※このテンプレートを選んだ理由を、最後の報告文で一言添えてください。'
      : '';

    const briefText = [
      `テーマ: ${topic}${templateNote}`,
      brief.purpose && `目的: ${brief.purpose}`,
      brief.audience && `想定読者: ${brief.audience}`,
      brief.slides && `枚数の目安: ${brief.slides}`,
      brief.tone && `トーン: ${brief.tone}`,
      brief.style && `見た目の希望: ${brief.style}`,
    ].filter(Boolean).join('\n');

    // 毎回の呼び出しに渡す設定
    const _creatorConfig = {
      tools: [{ functionDeclarations: CREATOR_TOOL_DECLARATIONS }, { googleSearch: {} }],
      // ATTENTION: 組み込みのツール（googleSearch）と自前のツールを一緒に使うには必須。無いと 400 になる
      toolConfig: { functionCallingConfig: { mode: 'AUTO' }, includeServerSideToolInvocations: true },
      systemInstruction: CREATOR_SYSTEM_INSTRUCTION,
      temperature: 0.4,
      maxOutputTokens: 8192,
    };

    let contents = [{ role: 'user', parts: [{ text: `${listenerContext}${briefText}` }] }];
    let finalText = '';

    // ATTENTION: ループの変数は i にすること。turn にすると下の const turn が同じブロックの中で
    //            これを隠し、state.turns の行が宣言前の参照になって、1回目の往復で必ず
    //            ReferenceError になる（スライド作成が毎回失敗する）。
    //            他の往復ループ（secretary-helper-agent・secretary-line）も同じ付け方にしてある。
    for (let i = 0; i < MAX_TURNS; i++) {
      state.turns = i + 1;
      // ツール呼び出しなどの取り出しは llm-client の generateTurn に任せる
      const turn = await generateTurn({
        tier: 'analysis',
        apiKey,
        contents,
        tools: _creatorConfig.tools,
        systemInstruction: _creatorConfig.systemInstruction,
        temperature: _creatorConfig.temperature,
        maxOutputTokens: _creatorConfig.maxOutputTokens,
        extraConfig: { toolConfig: _creatorConfig.toolConfig },
        agentKey: 'secretary_presentation',
        activitySessionId,
        logMeta: { purpose: 'presentation_creator' },
      });
      const parts = turn.modelParts;

      const calls = turn.toolCalls;
      if (calls.length === 0) {
        finalText = turn.text.trim();
        break;
      }

      contents = [...contents, modelTurn(parts)];
      const responseParts = [];
      const imageParts = [];
      for (const call of calls) {
        const handler = handlers[call.name];
        countCall(call.name);
        let out;
        try {
          out = handler ? await handler(call.args || {}) : { error: `未知の機能: ${call.name}` };
        } catch (e) {
          getLogger().warn(`[PresCreator] ${call.name} が失敗: ${e.message}`);
          out = { error: e.message };
        }
        // 画像を返すツール（look_at_slide・get_template_info）は、結果とは別に画像のパーツを添える。
        // これで自分の描いたものを見られる
        if (out?._image || out?._images) {
          const { _image, _images, ...rest } = out;
          responseParts.push(toolResultPart(call.name, rest));
          // 複数の画像を渡すときは、どれが何かを言葉で添える（無いと対応が付かない）
          for (const it of _images || []) {
            imageParts.push({ text: it.label });
            imageParts.push(imagePart(it.image.base64, it.image.mimeType));
          }
          if (_image) imageParts.push(imagePart(_image.base64, _image.mimeType));
        } else {
          responseParts.push(toolResultPart(call.name, out));
        }
      }
      contents = [...contents, toolResultTurn(responseParts)];
      // BUGFIX: 画像はツールの結果と同じターンに混ぜず、別のユーザーのターンとして渡す。混ぜていたころ、
      // 最後の応答が意味のない断片に壊れ、指定の枚数に届かずに打ち切られていた。
      // 何の画像かも言葉で添える（何を見ているのかが分からないと、講評が的外れになる）
      if (imageParts.length > 0) {
        const isTemplateTour = calls.some((c) => c.name === 'get_template_info');
        contents = [...contents, {
          role: 'user',
          parts: [
            { text: isTemplateTour
              ? '以下は、このテンプレートで使える各レイアウトの実際の見た目です。'
                + '名前と差し込み口の数だけでなく、**どう見えるか**を見て使い分けてください。'
                + 'カード・対比・数値・図解のレイアウトは、同じ内容でも箇条書きよりはるかに'
                + '伝わります。埋める項目が多いことを理由に避けないでください。'
              : '以下は、今あなたが作ったスライドの実際の見た目です。文字があふれていないか、'
                + '余白が死んでいないか、直前のスライドと骨格が似すぎていないかを確認してください。'
                + '問題があれば revise_slide で直し、無ければ次のスライドへ進んでください。' },
            ...imageParts,
          ],
        }];
      }
    }

    // 見本のスライド（複製元に使ったもの）を、出来上がりから取り除く
    try {
      await presRender.finalizeDeck(googleService, creds, {
        deckId, libraryIds, madeSlideIds: state.slides,
      });
    } catch (e) {
      getLogger().warn(`[PresCreator] 見本スライドの除去に失敗（デッキ自体は使えます）: ${e.message}`);
    }

    // BUGFIX: 画像・グラフを入れられなかったスライドから、{{IMAGE}}・{{CHART}} の目印を消す。
    //         これらは差し込み口（slots）として扱わないため、放っておくと目印の文字が納品物に
    //         そのまま残る（枠だけあって中身の無いページに見える）。
    try {
      await presRender.clearUnusedMarkers(googleService, creds, {
        deckId, slideIds: state.slides.filter((id) => !state.mediaFilled.has(id)),
      });
    } catch (e) {
      const _msg = e instanceof Error ? e.message : String(e);
      getLogger().warn(`[PresCreator] 未使用の置き場所の目印を消せませんでした: ${_msg}`);
    }

    const elapsed = Math.round((Date.now() - t0) / 1000);

    // 見直しのループが回ったかを数字で残す。unreviewed が0でなければ、描いたきり見ていないスライドがある
    const unreviewed = state.slides.filter((id) => !state.lookedAt.has(id));
    const callSummary = Object.entries(state.calls).map(([k, v]) => `${k}=${v}`).join(' ');
    getLogger().info(`[PresCreator] 「${deckTitle}」完成: ${state.slides.length}枚（${elapsed}秒、${state.turns}往復）`);
    getLogger().info(`[PresCreator] 見直しの実績: 確認済み${state.lookedAt.size}/${state.slides.length}枚`
      + `、差し替え${state.revisions}回、道具の呼び出し ${callSummary}`);
    if (unreviewed.length > 0) {
      getLogger().warn(`[PresCreator] 見ずに納品したスライドが${unreviewed.length}枚あります`
        + '（見直しループが働いていません）。');
    }
    if (state.turns >= MAX_TURNS) {
      getLogger().warn(`[PresCreator] 往復上限（${MAX_TURNS}）に達しました。途中で打ち切られた可能性があります。`);
    }

    // BUGFIX: 最後の報告が短すぎる・日本語を含まないときは壊れているとみなし、決まった文にする。
    // 意味のない断片だけが報告として返ったことがある
    const looksBroken = !finalText
      || finalText.length < 15
      || !/[ぁ-んァ-ヶ一-鿿]/.test(finalText);
    if (looksBroken && finalText) {
      getLogger().warn(`[PresCreator] 最終報告文が壊れているため差し替えます: ${JSON.stringify(finalText.slice(0, 40))}`);
    }

    return {
      deckId,
      webViewLink,
      slideCount: state.slides.length,
      summary: looksBroken ? `「${deckTitle}」を${state.slides.length}枚で作成しました。` : finalText,
      templateWarnings: manifest.warnings,
      review: {
        turns: state.turns,
        reviewed: state.lookedAt.size,
        unreviewed: unreviewed.length,
        revisions: state.revisions,
        calls: state.calls,
        elapsedSec: elapsed,
      },
    };
  } finally {
    activityDb.closeSession(activitySessionId);
  }
}

module.exports = { runPresentationJob, chooseTemplateByAI, CREATOR_TOOL_DECLARATIONS, MAX_TURNS };
