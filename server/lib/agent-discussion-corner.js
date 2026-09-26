/**
 * @file 討論コーナー（ニュースディープダイブ／インサイト・マネー）
 *
 * 「討論コーナー」の仕組み。話題・出演者・進行の台本を持つ、複数の発言にまたがる小さな状態機械。
 * ニュースの直後に置く「ニュースディープダイブ」と、金融情報の直後に置く「インサイト・マネー」を
 * 同じ機構で動かしている。
 *
 * 流れ:
 *   1. 前のコーナーの原稿が出来た時点で準備を始める（_prepareDiscussionAfterCorner）。
 *      話題と人選はディレクターが、いま読み上げようとしている原稿を見て決める。
 *   2. 準備と並行して「取材」（検索で裏を取る）と「数値シート」（公式データからの計算）を走らせ、
 *      全員が同じ事実を手元に持った状態で議論させる。
 *   3. 前のコーナーを読み終えたら起動し（_activatePreparedDiscussion）、1回の進行につき
 *      1発言だけ処理して次へ回す。各発言のプロンプトにはここまでの議事録を渡す。
 *
 * server/agent-system.js へはこのファイルを Object.assign で混ぜ込むだけで、既存の各ステップには
 * 触れていない。設定を切ればこのコーナーだけを止められる。
 *
 * ATTENTION: 討論コーナーを増やすときは DISCUSSION_CORNERS へ定義を1つ足すこと。別実装を作らない。
 * ATTENTION: プロンプトの組み立ては _buildDiscussionTurnContext の1か所に集約すること。本番の
 * 発話時と先読み時の両方から呼ばれるため、2か所に書くと必ず食い違う。
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

const fs = require('fs');
const path = require('path');
const { getLogger } = require('../logger');
const { generateText } = require('./llm-client');
const { buildAgentKnowledgePack, recordAgentNote } = require('./agent-knowledge-pack');
const { getHiddenTalentsByLiveAgentKey } = require('./hidden-talent-profiles');
const { buildDiscussionDataSheet } = require('./discussion-data-sheet');
const { screenEditorials, buildEditorialDeepDiveMaterial, filterPastEditorialsByTopic } = require('./editorial-compare');

// 自分のコーナーを持たないゲストの論客。
// ATTENTION: 話題を見たディレクターが指名したときだけ席に着かせること。論客が足りないときの
// 機械的な補充には使わない（話題と無関係に呼ばれると浮く）。
const GUEST_ANALYSTS = ['comedian', 'doctor', 'marketer'];

// 人選の判断を待つ上限。前のコーナーの読み上げの裏で行うので、通常は数秒で終わる。
// 過ぎたら、レギュラーの論客だけで組んだ人選のまま進める。
const CAST_DECISION_WAIT_MS = 20000;

/**
 * 討論コーナーの定義。増やすときはここへ足す。
 *
 * - defaultName : 表示名の既定値。実際の名前は設定で上書きできる
 * - host        : 進行役。必ず参加し、開始と締めを担当する
 * - candidates  : 出演者として選べるエージェント（進行役は含めない）
 * - maxTurns    : 発言数の上限。尺に直結するため必ず打ち切る
 * - after       : このコーナーの直後に差し込む
 */
const DISCUSSION_CORNERS = {
  news_deep_dive: {
    defaultName: 'ニュースディープダイブ',
    host: 'caster',
    candidates: ['assistant', 'news', 'commentator', 'journalist', 'legal_advisor', ...GUEST_ANALYSTS],
    // ATTENTION: 席は2種類に分けること。出演者を一列に並べて誰にでも議論の役を割り当てると、
    // 報道の担当に「立場を言い切れ」「賛成するな」と命じることになり、役割として無理がある。
    //   analysts     … 議論する人。立場を取り、反論し、言い返す。最低2人を必ず確保する
    //   factCheckers … 議論しない人。議論の土台になる事実を置き、憶測との境目を示すだけ
    analysts: ['commentator', 'journalist', 'legal_advisor'],
    // ディレクターが話題を見て指名したときだけ論客の席に着く人
    guestAnalysts: GUEST_ANALYSTS,
    factCheckers: ['news'],
    // ATTENTION: 7より減らさないこと。開幕・事実・分析・反論・疑問・回答・締めの7つが
    // 収まらず、末尾が切られてアシスタントの疑問への回答が落ちる。
    maxTurns: 7,
    after: 'news',
    theme: '表面的な報道の「裏にある背景や意味」まで踏み込む',
    // 役割ごとの指示。台本の組み立ては _buildDiscussionPlan が行う。
    // ATTENTION: 賛成を禁じ、立場を義務づけ、答えの型を指定すること。「別の角度から」のような
    // 弱い言い方は「補足」と解釈されて「ご指摘の通り」で始まり、立場を取れと書かなければ
    // 全員が「複雑な側面がある」で逃げ、「まとめてください」と書けば空の締めになる。
    roleInstructions: {
      // 開幕の案内は意図的に長くしてある。この発話の裏で取材を走らせて時間を稼ぐため
      // （取材は20秒前後、この読み上げは30秒前後なので、2人目までに間に合う）。
      open:
        '【コーナーの開幕アナウンスです。3〜4文で、やや丁寧に】\n'
        + '① コーナー名を告げ、今日は誰が参加するのかを**出演者の名前を挙げて紹介**してください。\n'
        + '② 直前のニュースの中から **意見が分かれそうなもの・リスナーの生活や関心に'
        + '引っかかるもの** を1つだけ選び、それを取り上げると告げてください。1本目だから選ぶ、は禁止です。\n'
        + '③ なぜそれを掘るのかを一言添え、「ここは見方が分かれるところだと思います」と予告してください。\n'
        + '④ 最後は **特定の1人を指名せず、その場の全員へ問いを投げる形**で終えてください'
        + '（「みなさん、これどう見ますか？」のように）。点呼のように順番に振るのはやめてください。',
      // 報道の担当専用。立場を取らせないことがこの役割の全てで、分析役とは正反対の指示になる
      factcheck:
        '【あなたは論者ではありません。報道の担当として、議論の土台になる事実だけを置いてください】\n'
        + '① まず、**この話題に出てくる組織が何をしている組織なのか**を一言で押さえてください'
        + '（取材メモの「登場する組織は何者か」から）。社名だけが先行して中身が共有されないまま'
        + '議論が始まると、抽象論に流れます。\n'
        + '② この件で**確認が取れている事実**を1〜2点、数字・時期・当事者の固有名詞で簡潔に。\n'
        + '③ そのうえで、**まだ確認が取れていない点**を1つ「ここはまだ分かっていません」と明示してください。\n'
        + '**意見・評価・賛否は述べないでください。**「私はこう思います」「注目されます」は禁止です。'
        + '最後は「ここから先は皆さんの見方を聞かせてください」のように議論へ渡してください（合計3〜4文）。',
      analyze:
        '**まず自分の立場を1文で言い切ってから**、その理由を述べてください（合計2〜4文）。'
        + '「私はこう見ています」「これは〜だと思います」のように、賛否・評価がはっきり伝わる形にすること。'
        + '事実の要約だけで終わってはいけません。',
      challenge:
        '**直前の発言に賛成してはいけません。** 引っかかった点を1つ名指しし、'
        + '「そこはどうでしょうか」「私は違う見方をします」のように**正面から異を唱えて**ください（2〜4文）。'
        + '相手の言い換え・補足・「ご指摘の通り、しかし」は禁止です。反対したうえで、'
        + '自分はどう見るのかを必ず言い切ってください。',
      rebut:
        '**自分の説に反論されました。黙って引き下がらないでください。** 相手の名前を呼び、'
        + '「そこは違います」「いや、それは〜」のように短く言い返してください（1〜2文）。'
        + 'ただし相手の指摘のうち**認める部分が1つあれば先に認めて**から返すこと。',
      push:
        '進行役として、直前の発言を**そのまま通さないで**ください。「それは言い過ぎでは」'
        + '「逆の見方もありませんか」のように、リスナーが抱くであろう反論を1つぶつけてください（1〜2文）。',
      question:
        'ここまでの議論を聞いたリスナーが素直に抱くであろう疑問を、1〜2文で率直に投げかけてください。'
        + '専門用語を使わず、生活者の目線で。**意見が割れている点があれば「結局どっちなんですか」と'
        + '遠慮なく聞いてください。**',
      answer:
        '直前の疑問に2〜3文で正面から答えてください。**そのうえで、反対意見のどこは認めるのかを'
        + '1つだけ挙げてください**（「〜の点は確かにそのとおりで」）。全面的に自説を通さないこと。',
      close:
        '**まとめないでください。** ここで意見が割れた点を1つ名指しし、'
        + '「私は〜だと思いますが、皆さんはどう思いますか」のようにリスナーへ投げかけて締めてください（1〜2文）。'
        + '「複雑ですね」「奥深いですね」「今後の動向が注目されます」で終わるのは禁止です。',
    },

    // 同じ話題でも見る角度が違えば結論は割れる。全員が同じ方向を向いて頷き合うのを防ぐため、
    // 専門ごとに見るべき面を指定する。
    // ATTENTION: ここにエージェントの名前を書かないこと（設定で変わるため）。
    agentLenses: {
      commentator:   '学者として、個別の出来事ではなく**構造・歴史的な前例・理論の枠組み**から見てください。「過去に似たことが起きたときどうなったか」を具体的に挙げられると強い。',
      journalist:    '取材者として、**誰が得をして誰が損をするのか・その決定の裏で動いている力学**から見てください。ただし具体的な中身（数字・固有名詞・前例）を伴わないのに「情報筋によると」「表に出ていない情報ですが」と言うのは禁止です。',
      news:          '報道の担当として、**事実として確認できている線と、まだ憶測にすぎない線を切り分けて**見てください。'
                     + 'あなたは議論の参加者ではなく、**議論が寄って立つ事実を預かる立場**です。自分の意見を述べたり、'
                     + '他の出演者の見解に賛否を示したりしないこと。憶測が事実のように語られたときに線を引き直すのが役目です。',
      legal_advisor: '法律家として、**ルール・制度・責任の所在**から見てください。「それは誰の責任になるのか」「今の制度で対応できるのか」という問いを持ち込むこと。',
      assistant:     '生活者として、**自分や家族の暮らしにどう跳ね返るか**だけを考えてください。分からないことは分からないと言ってよい。',
      caster:        '進行役として、話が抽象論に流れたら「具体的にはどういうことですか」と引き戻してください。',
      // ゲストの論客。専門家の議論に、専門家からは出ない角度を持ち込む役
      comedian:      '芸能界の第一線にいる人として、**世間の空気・普通の人の本音**から見てください。'
                     + '専門家が見落としがちな「普通の人はそこをどう受け取るか」を、自分の体験や芸能界の内側の話を交えて率直に言うこと。'
                     + '笑いを交えても茶化して終わらせず、最後は自分の意見を言い切ってください。'
                     + '芸能・エンタメの話題では、業界を知る当事者として一番詳しい立場です。',
      doctor:        '医師として、**健康・医療の科学的な根拠**から見てください。あわせて元国会議員として、'
                     + '**制度や政策が決まる過程と、それが現場でどう運用されているか**という政治の実務の視点も持ち込めます。'
                     + '医療・健康・美容の話題では最も詳しい立場なので、誤解を正すことを優先してください。特定の人の診断はしないこと。',
      marketer:      'マーケターとして、**人の心がどう動くか・その出来事で誰の行動やお金の使い方がどう変わるか**から見てください。'
                     + '企業再生や大型イベントを手がけてきた経験から、「なぜ人々はこれに反応するのか」「ここにどんな市場や流行が生まれるか」を具体的に語ること。',
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 相場と経済を深掘りするコーナー。金融情報の直後に差し込む。
// 仕組みはニュースの討論と同じで、after を 'finance' にするだけで動く。
// ATTENTION: 役割ごとの指示は書き写さず、ニュースの討論のものを引き継ぐこと。立場を言い切れ・
// 賛成するな・まとめるな、は話題が何であれ同じものが要る。書き写すと片方だけ直したときに
// ずれる。上書きするのは、話題の選び方が変わる開幕と事実の置き方、それに見る角度だけ。
// ─────────────────────────────────────────────────────────────────────────────
DISCUSSION_CORNERS.insight_money = {
  defaultName: 'インサイト・マネー',
  host: 'caster',
  candidates: ['assistant', 'finance', 'commentator', 'journalist', 'legal_advisor', ...GUEST_ANALYSTS],
  // 議論する人。経済を構造で語る学者と、力学で語る取材者を軸に置く。
  // 弁護士も規制・制度の面から論じられるため候補に残す。
  analysts: ['commentator', 'journalist', 'legal_advisor'],
  guestAnalysts: GUEST_ANALYSTS,
  // 事実を置く人。金融情報の担当が数字の土台を預かる
  factCheckers: ['finance'],
  maxTurns: 7,
  after: 'finance',
  theme: '相場の値動きの裏で、世界の経済に何が起きているのかまで踏み込む',
  // 取材の種類。相場向けは「出来事の素性」ではなく「数字と、その背後にある力学」を集める
  research: 'market',
  roleInstructions: {
    ...DISCUSSION_CORNERS.news_deep_dive.roleInstructions,
    open:
      '【コーナーの開幕アナウンスです。3〜4文で、やや丁寧に】\n'
      + '① コーナー名を告げ、今日は誰が参加するのかを**出演者の名前を挙げて紹介**してください。\n'
      + '② 直前の金融情報の中から、**相場の数字そのものではなく「なぜそう動いたのか」を'
      + '掘る価値がある論点**を1つだけ選んで告げてください（例: 金利と株価の綱引き、'
      + '為替の水準が企業と家計に与える差、ある産業への資金の集中）。'
      + '「日経平均は◯円でした」と数字を繰り返すだけの導入は禁止です。\n'
      + '③ なぜそれを掘るのかを一言添え、「ここは見方が分かれるところだと思います」と予告してください。\n'
      + '④ 最後は **特定の1人を指名せず、その場の全員へ問いを投げる形**で終えてください'
      + '（「みなさん、これどう見ますか？」のように）。点呼のように順番に振るのはやめてください。',
    factcheck:
      '【あなたは論者ではありません。金融情報の担当として、議論の土台になる数字だけを置いてください】\n'
      + '① いま話題になっている市場・銘柄・指標について、**確認が取れている数字**を1〜2点。'
      + '水準だけでなく「いつと比べてどう変わったか」まで言うこと'
      + '（「◯円です」ではなく「先週末から◯%下げて◯円です」）。\n'
      + '② その数字が動いた理由として**確認されているもの**があれば1つ。'
      + '無ければ「理由はまだ確定していません」と正直に言ってください。\n'
      + '③ **まだ分かっていない点**を1つ「ここは見えていません」と明示してください。\n'
      + '**意見・相場観・予想は述べないでください。**「上がるでしょう」「注目されます」は禁止です。'
      + '最後は「ここから先は皆さんの見方を聞かせてください」のように議論へ渡してください（合計3〜4文）。',
  },
  agentLenses: {
    ...DISCUSSION_CORNERS.news_deep_dive.agentLenses,
    commentator: '経済学者として、**その値動きがどういう構造から生まれているのか**を見てください。'
      + '金融政策・景気循環・需給・過去の同じ局面を持ち込み、「今回は何が違うのか」まで言うこと。'
      + '相場の予想（上がる・下がる）を述べるのではなく、**何がそれを決めるのか**を示してください。',
    journalist: '取材者として、**その資金はどこから来てどこへ向かっているのか・誰が仕掛けて誰が降りたのか**'
      + 'を見てください。数字の裏で動いている当事者（機関投資家・政策当局・特定の業界）を名指しすること。'
      + 'ただし具体的な中身（数字・固有名詞・前例）を伴わないのに「関係者によると」と言うのは禁止です。',
    legal_advisor: '法律家として、**規制・制度・監督の面**から見てください。'
      + '「その取引や商品は今の制度で守られているのか」「投資家が損をしたとき誰が責任を負うのか」'
      + 'という問いを持ち込むこと。',
    finance: '金融情報の担当として、**数字として確認できている線と、まだ相場観にすぎない線を'
      + '切り分けて**見てください。あなたは議論の参加者ではなく、**議論が寄って立つ数字を'
      + '預かる立場**です。自分の相場観を述べたり、他の出演者の見解に賛否を示したりしないこと。'
      + '憶測が事実のように語られたときに線を引き直すのが役目です。',
    assistant: '生活者として、**自分や家族のお金にどう跳ね返るか**だけを考えてください。'
      + '住宅ローン・物価・給料・老後の蓄えといった身近な言葉に引き戻してよい。'
      + '分からないことは分からないと言ってよい。',
    comedian: '世間の感覚を代弁する立場として、**その経済の動きが、普通の人の財布や暮らしの実感とどうずれているか**を見てください。'
      + '専門家の数字の話に「で、それは普通の人にどう効くのか」と切り込み、自分の意見を言い切ってください。',
    doctor: '医師・元国会議員として、**医療・製薬・ヘルスケア産業や社会保障の財政**が絡む論点では最も詳しい立場です。'
      + 'それ以外の話題でも、**政策がどう決まり、それが現場や家計にどう届くのか**という実際を持ち込んでください。',
    marketer: 'マーケターとして、**消費者の心理と企業の打ち手**から見てください。数字の裏で'
      + '「人々が何にお金を使い、何を控え始めているのか」「企業はそれにどう仕掛けてくるか」を具体的に語ること。'
      + '相場の予想（上がる・下がる）はしないこと。',
  },
};

/**
 * 設定から討論コーナーの設定を読む。設定は毎回ファイルから読まれるため、変更は即座に効く。
 *
 * @param {any} config 番組の設定
 * @param {any} key 討論コーナーのキー
 * @returns {any} 名前・有効か・頻度・発言数の上限・開幕の曲の長さ
 */
function readDiscussionConfig(config, key) {
  const def = DISCUSSION_CORNERS[key];
  const conf = config?.show?.discussion_corners?.[key] || {};
  return {
    name: (typeof conf.name === 'string' && conf.name.trim()) ? conf.name.trim() : def.defaultName,
    // 画面の切り替えでオン・オフする。
    // ATTENTION: 頻度（frequency）でオフを代用しないこと。意味が混ざって後で分かりにくくなる。
    // 明示的に false のときだけオフ（項目が無い古い設定では今までどおりオン）。
    enabled: conf.enabled !== false,
    // 何回に1回このコーナーを挟むか。1 で毎回、0 で無効
    frequency: Number.isInteger(conf.frequency) ? Math.max(0, conf.frequency) : 1,
    maxTurns: Number.isInteger(conf.max_turns) ? Math.max(2, Math.min(10, conf.max_turns)) : def.maxTurns,
    // 開幕の曲を流す長さ。長すぎると議論が始まるまでの間が延びるため、3〜30秒に収める
    openingJingleMs: Number.isFinite(conf.opening_jingle_ms)
      ? Math.max(3000, Math.min(30000, conf.opening_jingle_ms)) : 15000,
  };
}

const discussionCornerMethods = {
  /**
   * 定義の表を外から見るための入口（検証で使う）。
   *
   * @returns {any} 討論コーナーの定義表
   */
  _discussionCornerDefs() { return DISCUSSION_CORNERS; },

  /**
   * 討論コーナーの設定を読む。
   *
   * @param {any} key 討論コーナーのキー
   * @returns {any} 読み込んだ設定
   */
  _readDiscussionConfig(key) { return readDiscussionConfig(this.getConfig(), key); },

  /**
   * 討論コーナーの開幕に流す曲を選ぶ。曲が鳴っている間に、裏で取材と次の原稿作りが進む。
   *
   * 探す順は、そのコーナー専用のフォルダー → 討論コーナー共通のフォルダー →
   * 従来の短いジングル。どのフォルダーも、中の曲から1つが無作為に選ばれる。
   * ATTENTION: 拡張子は小文字の .mp3 だけを見る。
   *
   * @param {any} key 討論コーナーのキー
   * @returns {any} 置き場と鳴らし方。曲が1つも無ければ null
   */
  _pickDiscussionOpeningJingle(key) {
    const base = path.join(__dirname, '..', 'assets', 'bgm');
    const hasMp3 = (dir) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.mp3'));
    const { openingJingleMs } = this._readDiscussionConfig(key);
    const own = path.join(base, 'discussion', key);
    if (hasMp3(own)) {
      return { dir: own, label: `discussion/${key}`, fadeInMs: 500, playDurationMs: openingJingleMs, fadeOutMs: 2000 };
    }
    const shared = path.join(base, 'discussion');
    if (hasMp3(shared)) {
      return { dir: shared, label: 'discussion', fadeInMs: 500, playDurationMs: openingJingleMs, fadeOutMs: 2000 };
    }
    const corner = path.join(base, 'corner');
    if (hasMp3(corner)) {
      return { dir: corner, label: 'corner', fadeInMs: 200, playDurationMs: 3000, fadeOutMs: 500 };
    }
    return null;
  },

  /**
   * 指定のコーナーが終わった直後に、討論コーナーを始めるべきか判定する。
   * ATTENTION: この呼び出しは「何回に1回」の回数を進めてしまう。準備と起動の両方で呼ぶと
   * 二重に数えるため、呼ぶのは準備の1か所だけにすること。
   *
   * @param {any} afterCornerKey 終わったコーナーのキー
   * @returns {any} 始める討論コーナーのキー。始めないなら null
   */
  _shouldStartDiscussionAfter(afterCornerKey) {
    for (const [key, def] of Object.entries(DISCUSSION_CORNERS)) {
      if (def.after !== afterCornerKey) continue;
      const { enabled, frequency } = this._readDiscussionConfig(key);
      // ATTENTION: オフの判定は回数を数えるより前に置くこと。オフの間も数えると、オンに
      // 戻したときに「何回に1回」の巡りがずれる。
      if (!enabled) {
        getLogger().info(`[Discussion] ${key}: オフに設定されているため流しません`);
        continue;
      }
      if (frequency <= 0) continue;
      if (!this._discussionCornerCounts) this._discussionCornerCounts = {};
      const n = (this._discussionCornerCounts[key] || 0) + 1;
      this._discussionCornerCounts[key] = n;
      if (n % frequency !== 0) {
        getLogger().info(`[Discussion] ${key}: 今回は見送り（${n}回目 / ${frequency}回に1回）`);
        continue;
      }
      return key;
    }
    return null;
  },

  /**
   * 出演者を決める。誰が入るかはディレクターの采配に委ねつつ、「議論する人が1人もいない編成に
   * はしない」という下限だけをコード側で保証する。
   *
   * BUGFIX: 足りないときの補充を「報道の担当とアシスタントを無条件に足す」と書いてはいけない。
   * 指名が空だとこの2人だけになり、議論する人が1人もいない回が続いた。
   * ATTENTION: 誰が今日出るかは、判断の記録ではなく編成のキューを直接見ること。再起動して
   * 保存済みのキューを復元した日は判断の記録が空のままで、キューに論客が並んでいても
   * 「ゲスト0人」に見える。
   *
   * @param {any} key 討論コーナーのキー
   * @param {any} [pick] 討論の直前にディレクターが決めた人選。無ければサイクルの編成判断から組む
   * @returns {string[]} 出演者のキーの配列（進行役は含まない）
   */
  _buildDiscussionCast(key, pick = null) {
    const def = DISCUSSION_CORNERS[key];
    const decision = this._lastAppliedDirectorDecision || {};
    const onlyAnalysts = (list) => (Array.isArray(list) ? list : []).filter(a => def.analysts.includes(a));
    // ゲストの論客は、ディレクターの指名があったときだけ席に着ける（補充には使わない）
    const canArgue = [...def.analysts, ...(def.guestAnalysts || [])];

    // ① ディレクターの指名を最優先で受け取る
    const pickedSource = pick
      ? [...pick.analysts, ...(pick.includeAssistant ? ['assistant'] : [])]
      : decision.deepDiveCast;
    const picked = Array.isArray(pickedSource)
      ? pickedSource.filter(a => def.candidates.includes(a))
      : [];
    const analysts = [...new Set(picked.filter(a => canArgue.includes(a)))];

    // ② 論客が2人に満たなければ、そのサイクルに実際に登場する人から補う。
    // 番組に出ていない人を討論だけに呼ぶと流れから浮くため、まずはここから探す。
    if (analysts.length < 2) {
      const inCycle = [...new Set([
        ...onlyAnalysts(decision.guests),
        ...(decision.includeLegalAdvisor ? ['legal_advisor'] : []),
        ...onlyAnalysts(this._cornerQueue),      // 再起動でキューを復元した日は、これだけが手がかり
        ...onlyAnalysts(this._recentCorners),
      ])];
      for (const a of inCycle) {
        if (analysts.length >= 2) break;
        if (!analysts.includes(a)) analysts.push(a);
      }
    }
    // ③ それでも足りなければ論客から補う。「番組の流れから浮く」ことより「議論する人が
    // 居ない」ことの方が、コーナーとして致命的。
    if (analysts.length < 2) {
      for (const a of [...def.analysts].sort(() => Math.random() - 0.5)) {
        if (analysts.length >= 2) break;
        if (!analysts.includes(a)) analysts.push(a);
      }
    }

    // ④ 素朴な疑問役と、事実を置く役。
    // アシスタントはディレクターが指名したとき、または指名そのものが無い回に入れる。
    // ATTENTION: 事実を置く役は必ず入れること（論客の枠は食わない）。進行役は取材の結果を
    // 待たないため、当事者の素性と確かめた事実を置けるのはこの人だけ。欠けると議論の土台が
    // 無くなり、当事者が何をしている組織かが一度も語られないまま抽象論に終始する。
    const withAssistant = pick ? pick.includeAssistant : (picked.includes('assistant') || picked.length === 0);
    const factChecker = def.factCheckers[0];
    return [
      ...analysts.slice(0, 2),
      ...(withAssistant ? ['assistant'] : []),
      ...(factChecker ? [factChecker] : []),
    ];
  },

  /**
   * 台本（誰がどの役割で話すか）を組み立てる。
   * 大事なのは発言の順番ではなく「前の人の発言を次の人が受け取ること」なので、並び自体は
   * コードが決め、受け渡しは各発言のプロンプトへ議事録を渡すことで担保する。
   *
   * @param {any} key 討論コーナーのキー
   * @param {string[]} cast 出演者のキーの配列
   * @returns {any[]} 発言の並び。各要素は { agent, role }
   */
  _buildDiscussionPlan(key, cast) {
    const def = DISCUSSION_CORNERS[key];
    const { maxTurns } = this._readDiscussionConfig(key);
    // ATTENTION: 議論の役を割り当てるのは論客だけ。「アシスタント以外は全員」としていた頃は、
    // 報道の担当まで分析や反論を割り当てられていた。
    const experts = cast.filter(a => def.analysts.includes(a) || (def.guestAnalysts || []).includes(a));
    const hasAssistant = cast.includes('assistant');
    // 事実を置く役は議論に混ぜず、議論が始まる前の1発言だけを担当する
    const factChecker = cast.find(a => def.factCheckers.includes(a)) || null;

    const plan = [{ agent: def.host, role: 'open' }];
    // 論より先に事実。ここで数字と「まだ分かっていない点」が置かれるので、続く論客は
    // 憶測だけで喋りにくくなる（取材の結果と合わせて二重の歯止めになる）。
    if (factChecker) plan.push({ agent: factChecker, role: 'factcheck' });
    // 最初の1人が立場を出し、2人目以降は必ず反論する
    experts.forEach((agent, i) => plan.push({ agent, role: i === 0 ? 'analyze' : 'challenge' }));
    // 専門家が1人だけだと反論役が居らず、独演会になる。その場合は進行役が突っ込む。
    if (experts.length === 1) plan.push({ agent: def.host, role: 'push' });
    // 反論されたら言い返す。順番に振っていく進行を、応酬に近づけるための1手。
    // 尺に余裕がなければ、下の打ち切りで最初に間引かれる。
    else if (experts.length >= 2) plan.push({ agent: experts[0], role: 'rebut' });
    if (hasAssistant) {
      plan.push({ agent: 'assistant', role: 'question' });
      if (experts.length > 0) plan.push({ agent: experts[0], role: 'answer' });
    }
    plan.push({ agent: def.host, role: 'close' });

    // 上限で打ち切る。
    // ATTENTION: 末尾から機械的に削らないこと。アシスタントの疑問だけが残って回答が落ち、
    // 問いが宙に浮く。削る順は ①言い返し ②2つ目以降の反論 ③進行役の突っ込み で、
    // 疑問・回答・締めは最後まで残すこと。
    while (plan.length > maxTurns) {
      const at = (role, last = false) => {
        const idx = plan.map((st, i) => ({ st, i })).filter(({ st }) => st.role === role).map(x => x.i);
        return idx.length ? (last ? idx[idx.length - 1] : idx[0]) : -1;
      };
      const challenges = plan.filter(st => st.role === 'challenge').length;
      let cut = at('rebut');
      if (cut === -1 && challenges > 1) cut = at('challenge', true);
      if (cut === -1) cut = at('push');
      // ATTENTION: 事実を置く発言は削らないこと。素性と事実がここで置かれるので、
      // 落とすと討論が抽象論に戻る。
      if (cut === -1) {
        const MUST = ['question', 'answer', 'close'];
        const keep = plan.filter(st => MUST.includes(st.role));
        const rest = plan.filter(st => !MUST.includes(st.role));
        return [...rest.slice(0, Math.max(1, maxTurns - keep.length)), ...keep];
      }
      plan.splice(cut, 1);
    }
    return plan;
  },

  /**
   * 討論コーナーを組み立てて、すぐ始める。
   * ATTENTION: 話題が決まらなければ始めないこと。無理に立てると、その場しのぎの話題で議論する
   * という、そもそも直そうとしていた状態に戻る。
   *
   * @param {any} key 討論コーナーのキー
   * @param {any} [opts] topicHint（話題の指定）・sourceText（話題の元になる原稿）
   * @returns {any} 立ち上げた討論コーナー。始めないなら null
   */
  _startDiscussionCorner(key, { topicHint = '', sourceText = null } = {}) {
    const dc = this._buildDiscussionCorner(key, { topicHint, sourceText });
    if (!dc) return null;
    this._discussionCorner = dc;
    return dc;
  },

  /**
   * 討論の直前に、実際に流れた放送の内容を見て、ディレクターが「何を深掘りするか」と
   * 「誰に議論させるか」を決める。
   *
   * ATTENTION: 話題と人選は一緒に決めること。サイクルの編成判断は1時間前後に1回、これから
   * 流れるニュースを知らないまま出演者を決めているため、話題に合う専門家を呼べない。
   *
   * 失敗したり出力が壊れていたら null を返し、呼び出し側は従来どおりの人選で進む。
   *
   * @param {any} key 討論コーナーのキー
   * @param {string} sourceText 直前のコーナーの原稿
   * @returns {Promise<any>} 話題・出どころ・論客2人・アシスタントを入れるか・理由。決まらなければ null
   */
  async _requestDiscussionCastDecision(key, sourceText) {
    const def = DISCUSSION_CORNERS[key];
    const source = (sourceText || '').replace(/\[PAUSE:\d+\]/g, '').trim().slice(0, 2500);
    if (!def || !source) return null;

    const config = this.getConfig();
    // ATTENTION: プロンプトに出る名前は必ず設定から取ること（直書き禁止）
    const nameOf = (a) => (config.agents?.[a]?.name) || a;
    const talents = getHiddenTalentsByLiveAgentKey();
    const exists = (a) => !!config.agents?.[a]?.name;
    // 人物像は各エージェント自身の設定の冒頭から取る。分野との対応づけを直書きしないため、
    // 管理画面で人物の設定を書き換えても追従する。
    const profile = (a) => {
      const gist = (config.agents?.[a]?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const talent = talents[a];
      return `- ${a}: ${nameOf(a)}${gist ? ` — ${gist}…` : ''}${talent ? `\n    （個人的な一面: ${talent}）` : ''}`;
    };
    const regulars = def.analysts.filter(exists);
    const guests = (def.guestAnalysts || []).filter(exists);
    const factChecker = def.factCheckers[0];
    const directorName = nameOf('director');
    const asstName = nameOf('assistant');
    const { name } = this._readDiscussionConfig(key);

    // 今日の社説で論調が割れている話題を、深掘りの候補としてディレクターへ渡す。
    // 判定は報道のコーナーで既に走って一定時間残るため、通常ここでは計算し直されない。
    let editorial = null;
    try {
      const clusters = await this.mediaCompareService.fetchEditorialClusters(config, { maxClusters: 4 });
      editorial = await screenEditorials({
        clusters,
        apiKey: this.getCredentials()?.gemini?.api_key,
        activitySessionId: this._activitySessionId,
      });
    } catch (e) {
      getLogger().debug(`[Discussion] 社説の候補取得に失敗（ニュースからの深掘りで続行）: ${e.message}`);
    }
    const editorialBlock = editorial
      ? `\n【今日の各社の社説（論調が割れている話題）】\n`
        + `${editorial.cluster.headlines.map((h) => `  ・${h.outlet}: 「${h.title}」`).join('\n')}\n`
        + `  → 分かれ方: ${editorial.finding.groups}\n`
      : '';

    const prompt = `${config.agents?.director?.prompt || `あなたは「${directorName}」、ラジオ番組のディレクタです。`}

この直後に討論コーナー「${name}」を行います（${def.theme}）。
司会は${nameOf(def.host)}、議論の土台になる事実を置く担当は${nameOf(factChecker)}で、どちらも決まっています。
あなたが決めるのは「何を深掘りするか」と「誰に議論させるか」です。

【直前に放送された内容】
${source}
${editorialBlock}
【議論に呼べる出演者】
▼ レギュラーの論客
${regulars.map(profile).join('\n')}
▼ ゲスト（自分のコーナーを持たない出演者）
${guests.length > 0 ? guests.map(profile).join('\n') : '（なし）'}

【決め方】
1. 深掘りする話題を1つ選んでください。選び方は2通りあります。
   (a) 上の放送内容から選ぶ（topic_source は "news"）。意見が分かれそうなもの・リスナーの生活や
       関心に引っかかるものを選び、1本目だから選ぶ、はしないでください。
   (b) ${editorialBlock ? '上の【今日の各社の社説】の話題を選び、**「同じ出来事なのに、なぜ各社の主張がここまで割れるのか」**を掘る回にする（topic_source は "editorial"）。\n'
    + '       各社の立場が正反対に割れている日は、出来事そのものより「なぜ評価が分かれるのか」を掘るほうが、\n'
    + '       リスナーにとって発見があります。毎回これを選ぶ必要はありません。放送内容の中に、より\n'
    + '       掘る価値のある話題があればそちらで構いません。'
    : '（今日は社説が割れている話題がないため、この選び方は使えません。topic_source は "news" にしてください）'}
2. その話題を議論する2人を、上の出演者から選んでください。見方が割れるよう、視点の違う2人が望ましい。
   - 話題の分野に一番詳しい人がいれば、その人を入れてください（例えば医療・健康の話題なら医療に
     携わる人、芸能・エンタメの話題なら芸能界の人、流行や消費の話題ならマーケティングの人）。
     これは考え方の例で、実際の対応づけは上の人物像を読んであなた自身が判断してください。
   - ゲストは毎回呼ぶ必要はありません。話題に合うとき、または専門家どうしでは出ない視点が加わると
     議論が面白くなりそうなとき（番組に花を添えたいとき）に呼んでください。
   - 人物像と話題が合っていないのに、目新しさだけで呼ぶのは避けてください。
3. ${asstName}（リスナー目線の素朴な疑問役）を加えるかも決めてください。

以下のJSON形式のみで出力してください（マークダウン不要・説明文不要）:
{
  "topic": "深掘りする話題を30字以内で",
  "topic_source": "news" または "editorial",
  "analysts": ["上の一覧のキー名を2つ"],
  "include_assistant": true または false,
  "reasoning": "この話題とこの人選にした理由を1〜2文で"
}`;

    const raw = await this._callGeminiRaw(prompt, 'light');
    const match = raw && raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      getLogger().warn(`[Discussion] ${key}: 人選のJSONパース失敗: ${e.message}`);
      return null;
    }
    const allowed = [...regulars, ...guests];
    const analysts = [...new Set((Array.isArray(parsed.analysts) ? parsed.analysts : [])
      .filter(a => allowed.includes(a)))].slice(0, 2);
    if (analysts.length === 0) return null;
    // 社説の話題を選べるのは、実際に候補が渡っている回だけ
    const topicSource = (parsed.topic_source === 'editorial' && editorial) ? 'editorial' : 'news';
    return {
      topic: typeof parsed.topic === 'string' ? parsed.topic.trim().slice(0, 60) : '',
      topicSource,
      editorial: topicSource === 'editorial' ? editorial : null,
      analysts,
      includeAssistant: parsed.include_assistant === true,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim().slice(0, 300) : '',
    };
  },

  /**
   * ディレクターの人選を、準備中の討論コーナーへ反映する。
   * ATTENTION: 既に1発言目が済んでいる、または手放された討論コーナーには反映しないこと。
   *
   * @param {any} dc 討論コーナーの状態
   * @param {any} pick ディレクターが決めた人選
   * @returns {boolean} 反映できたか
   */
  _applyDiscussionCastDecision(dc, pick) {
    if (!pick || dc.turnIndex > 0) return false;
    if (this._pendingDiscussion !== dc && this._discussionCorner !== dc) return false;
    const def = DISCUSSION_CORNERS[dc.key];
    // サイクルの判断で大きな話題が挙がっている回は、そちらを優先する
    const bigTopic = (this._lastAppliedDirectorDecision?.bigTopic || '').trim();
    if (!bigTopic && pick.topic) dc.topic = pick.topic;
    // 社説の割れを掘る回。話題は社説側のものを使う（ニュース原稿の話題ではない）
    if (pick.topicSource === 'editorial' && pick.editorial) {
      dc.editorialMode = true;
      dc.topic = pick.topic || pick.editorial.finding.topic || dc.topic;
    }
    dc.cast = this._buildDiscussionCast(dc.key, pick);
    dc.plan = this._buildDiscussionPlan(dc.key, dc.cast);

    const config = this.getConfig();
    const nameOf = (a) => (config.agents?.[a]?.name) || a;
    const castNames = [def.host, ...dc.cast].map(nameOf).join('・');
    getLogger().info(`[Discussion] ${dc.name}: ディレクターの人選 → 話題=${dc.topic.slice(0, 40)} / 出演=${castNames}`
      + `${pick.reasoning ? `（理由: ${pick.reasoning}）` : ''}`);
    // 編成の判断はディレクター自身の日記にも残す（どの話題に誰を呼んだかを後で振り返れるように）
    this._writeDiaryReflection('director', nameOf('director'),
      `討論コーナー「${dc.name}」の人選。話題: ${dc.topic} ／ 出演: ${castNames}`
      + `${pick.reasoning ? ` ／ 理由: ${pick.reasoning}` : ''}`,
      `${dc.key}_cast`, 'plan').catch(() => {});
    this._broadcastDiscussionStatus(dc, dc._dashState || 'preparing', { stepIndex: dc._dashStep ?? null });
    this._startDiscussionDataSheet(dc);
    if (dc.editorialMode) this._startEditorialMaterial(dc, pick.editorial);
    return true;
  },

  /**
   * 話題が決まった直後に、その話題に必要な数値を集めて全員へ渡す「数値シート」を作り始める。
   *
   * 取材は話題が決まる前に放送内容の全体に対して走るため的が絞れないが、こちらは話題が
   * 決まった後に走るので、話題に合わせて系列を選べる。
   * ATTENTION: どの系列が要るかの判断だけを言語モデルに任せ、取得と計算はコードで行うこと。
   *
   * 話題が相場・経済に関わる場合は、市場向けの取材も追加で走らせる。
   *
   * @param {any} dc 討論コーナーの状態
   * @returns {void}
   */
  _startDiscussionDataSheet(dc) {
    const def = DISCUSSION_CORNERS[dc.key];
    dc.dataPromise = buildDiscussionDataSheet({
      topic: dc.topic,
      sourceText: dc.source?.excerpt || '',
      cornerTheme: def?.theme || '',
      config: this.getConfig(),
      creds: this.getCredentials(),
      activitySessionId: this._activitySessionId,
    }).then((res) => {
      if (!res) return '';
      // 相場・経済の話題なのに出来事の取材しか走っていない回は、市場の取材を足す
      if (res.researchKind === 'market' && def?.research !== 'market' && !dc.extraResearchPromise) {
        getLogger().info(`[Discussion] ${dc.name}: 相場・経済の話題のため市場の取材を追加します`);
        dc.extraResearchPromise = this._startMarketResearch(`${dc.topic}\n\n${dc.source?.excerpt || ''}`);
      }
      return res.text || '';
    }).catch((e) => {
      getLogger().warn(`[Discussion] ${dc.name}: 数値シートの組み立てに失敗（数値なしで進行）: ${e.message}`);
      return '';
    });
  },

  /**
   * 社説の割れを掘る回の材料を用意する。今日の見出しと論調の分かれ方に加えて、
   * 各社が同じテーマで過去に何を書いてきたかを見出しだけ集めて並べる。
   *
   * 今日の見出しだけでは「今日はこう書いた」しか言えないが、同じテーマの過去の社説が並ぶと、
   * その社の一貫した立場として論じられる。
   * ATTENTION: 本文は取得しないこと（各社とも自動取得を全面的に拒否している）。
   *
   * @param {any} dc 討論コーナーの状態
   * @param {any} screened 選び出した社説のかたまりと、分かれ方の見立て
   * @returns {void}
   */
  _startEditorialMaterial(dc, screened) {
    if (!screened) return;
    const config = this.getConfig();
    dc.editorialPromise = (async () => {
      let past = [];
      try {
        past = await this.mediaCompareService.fetchPastEditorials(config, {
          terms: screened.cluster.topicTerms || [],
          // 今日の見出しも渡して手がかりの言葉を広げる（当事者名が入るため話題を特定しやすい）
          titles: screened.cluster.headlines.map((h) => h.title),
          outlets: screened.cluster.headlines.map((h) => h.outlet),
        });
      } catch (e) {
        getLogger().warn(`[Discussion] 過去の社説の取得に失敗（今日の見出しだけで進行）: ${e.message}`);
      }
      // 候補には、似た言葉が入っているだけの別の話題が混ざる。同じ話題のものだけを残す。
      if (past.length > 0) {
        past = await filterPastEditorialsByTopic({
          topic: screened.finding.topic || dc.topic,
          todayHeadlines: screened.cluster.headlines,
          past,
          apiKey: this.getCredentials()?.gemini?.api_key,
          activitySessionId: this._activitySessionId,
        }).catch(() => past);
      }
      const material = buildEditorialDeepDiveMaterial(screened, past);
      getLogger().info(`[Discussion] ${dc.name}: 社説の材料 ${material.length}字`
        + `（過去の社説 ${past.reduce((s, p) => s + p.items.length, 0)}本）`);
      return material;
    })().catch((e) => {
      getLogger().warn(`[Discussion] 社説の材料の組み立てに失敗: ${e.message}`);
      return '';
    });
  },

  /**
   * 出演者へ渡す「手元の事実」をひとまとめにする。取材の結果・数値シート・社説の材料・
   * 追加の市場の取材を待ってつなぐ。いずれも揃わなければ空文字を返し、討論は数字を使わずに進む。
   *
   * @param {any} dc 討論コーナーの状態
   * @param {number} capMs これ以上は待たない上限（放送に間を作らないため）
   * @returns {Promise<string>} つないだ材料。何も揃わなければ空文字
   */
  async _discussionFacts(dc, capMs) {
    const cap = (p) => Promise.race([
      Promise.resolve(p).then((v) => v || '', () => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), capMs)),
    ]);
    const [research, sheet, editorial] = await Promise.all([
      cap(dc.researchPromise), cap(dc.dataPromise), cap(dc.editorialPromise),
    ]);
    const extra = dc.extraResearchPromise ? await cap(dc.extraResearchPromise) : '';
    // 社説の回は、社説の材料を先頭に置く（議論の出発点がそこにあるため）
    return (dc.editorialMode
      ? [editorial, research, sheet, extra]
      : [research, sheet, editorial, extra]).filter(Boolean).join('\n\n');
  },

  /**
   * 討論コーナーの器を組み立てる（まだ起動しない）。
   *
   * ATTENTION: 組み立てと起動を分けたまま保つこと。ここで進行中の討論へ直接代入すると、
   * 前のコーナーを読み終えた後にしか組み立てられず、開幕の案内を作る20秒前後がまるごと
   * 無音になる。
   * ATTENTION: 読み上げの前に準備する場合、話題の元になる原稿は必ず引数で渡すこと。その時点の
   * 直前の発言は、まだ前回の放送内容を指している。
   *
   * @param {any} key 討論コーナーのキー
   * @param {any} [opts] topicHint（話題の指定）・sourceText（話題の元になる原稿）
   * @returns {any} 組み立てた討論コーナー。話題が決まらなければ null
   */
  _buildDiscussionCorner(key, { topicHint = '', sourceText = null } = {}) {
    const def = DISCUSSION_CORNERS[key];
    if (!def) return null;

    // 話題は、ディレクターが挙げた「本日の大きな話題」を最優先し、無ければ直前の放送内容から
    // 進行役に選ばせる。
    // BUGFIX: 直前のコーナーの冒頭を切り取って話題にしてはいけない。ニュースが何本読まれても
    // 必ず1本目が話題になり、リスナーの関心に触れた項目が差し置かれる。選んでいるのではなく
    // 切り取っているだけになる。原稿の全文を渡して選ばせること。
    const bigTopic = (this._lastAppliedDirectorDecision?.bigTopic || '').trim();
    const recent = (this._recentCornerContent || []).find(e => e.corner === def.after);
    const fullText = (this.lastSpeech?.[def.after] || '').replace(/\[PAUSE:\d+\]/g, '').trim();
    // 引数で渡された原稿を最優先する（読み上げ前の準備では、直前の発言がまだ古いため）
    const _source = (sourceText || '').replace(/\[PAUSE:\d+\]/g, '').trim() || fullText || recent?.excerpt || '';
    const topic = bigTopic || topicHint
      || (_source ? '（下記の放送内容の中から、進行役が1つ選ぶ）' : '');
    if (!topic) {
      getLogger().info(`[Discussion] ${key}: 深掘りする話題が特定できないため開始しません`);
      return null;
    }

    const cast = this._buildDiscussionCast(key);
    const plan = this._buildDiscussionPlan(key, cast);
    const { name } = this._readDiscussionConfig(key);

    const dc = {
      key, name, topic,
      // 直前のコーナーで実際に流れた内容。議論の出発点として全員が共有する。
      // ATTENTION: 上限は「ニュースが何本かひととおり入る」長さにすること。短く切ると、
      // 切り取りで話題が決まってしまう。
      source: _source
        ? { agentName: recent?.agentName || '', excerpt: _source.slice(0, 2500) }
        : null,
      cast, plan, turnIndex: 0,
      transcript: [],
      // 進行役の発話と並行して走らせる。2人目の発言までに間に合う
      researchPromise: this._startDiscussionResearch(_source, key),
      // 取材の進み具合（画面に出すためだけのもの）
      researchState: 'running',
      researchChars: 0,
    };
    // 取材が終わったことを画面へ知らせる。放送の流れそのものには一切影響しない
    dc.researchPromise.then(
      (v) => { dc.researchState = v ? 'done' : 'empty'; dc.researchChars = (v || '').length; },
      () => { dc.researchState = 'failed'; },
    ).then(() => {
      // 切断などで既に手放された討論コーナーについては知らせない
      if (this._discussionCorner === dc || this._pendingDiscussion === dc) {
        this._broadcastDiscussionStatus(dc, dc._dashState || 'preparing', { stepIndex: dc._dashStep ?? null });
      }
    });
    getLogger().info(`[Discussion] ${name} 準備: 出演=${[def.host, ...cast].join('・')} / ${plan.length}発言 / 話題=${topic.slice(0, 40)}…`);
    return dc;
  },

  /**
   * 話題に出てくる企業・組織の「素性」を調べ始める。何を提供し、誰が使い、何で稼いでいるか。
   *
   * BUGFIX: 出来事の数字（金額・時期・シェア）だけを取材しても足りない。出演者の手元に残るのが
   * 社名だけだと、「垂直統合」「エコシステム」のような、どの会社にも当てはまる言葉だけで
   * 議論が進み、その会社が何をしているのかが一度も語られない回になる。
   *
   * 出来事の取材と並行して走らせるので、放送の間は延びない。
   *
   * @param {string} sourceText 直前のコーナーの原稿
   * @returns {Promise<string>} 箇条書きの資料。取れなければ空文字
   */
  _startEntityResearch(sourceText) {
    const creds = this.getCredentials();
    const apiKey = creds?.gemini?.api_key;
    if (!apiKey || !sourceText) return Promise.resolve('');
    const prompt = `以下は、いまラジオで読まれたニュース原稿です。この直後に出演者が討論します。
討論の前提として、**ここに登場する企業・組織・製品が何者なのか**を調べてください。

${sourceText}

【なぜ必要か】出演者は社名を知っていても、その会社が実際に何を提供して誰が使っているのかを
正確には知りません。そのまま議論させると「エコシステム」「覇権」のような、どの会社にも
当てはまる空疎な話になります。それを防ぐための資料です。

【主要な2〜3組織について、それぞれ書くこと】
- **何をしている組織か**: 「AIの会社」のような曖昧な括りは禁止です。何を提供し、誰が何のために
  使うのかが分かる形で書いてください（例:「機械学習モデルとデータセットを公開・共有する
  プラットフォーム。開発者が学習済みモデルを取得する場所として事実上の標準になっている」）。
- **収益源**: 何で稼いでいるか。
- **規模**: 売上・評価額・利用者数・調達額など、確認できた数字。
- **業界での位置づけ**: 競合は誰か、代替はあるのか、なぜこの組織が重要なのか。
- **今回の出来事がその組織にとって何を意味するか**: 立場がどう変わるのか。

【厳守】
- **確認できた事実だけ**を書いてください。推測・見込みは書かないこと。
- 分からない項目は無理に埋めず「不明」と書いてください。
- 1組織あたり150字程度、全体で700字以内。箇条書きのみ。前置き・感想は不要です。`;

    return generateText({
      tier: 'research',
      apiKey,
      grounded: true,
      prompt,
      temperature: 0,
      agentKey: 'discussion_entity_research',
    })
      .then(({ text }) => (text || '').trim())
      .catch((e) => {
        getLogger().warn(`[Discussion] 素性の取材に失敗（出来事の取材だけで進行します）: ${e.message}`);
        return '';
      });
  },

  /**
   * 相場・経済の取材を始める。
   *
   * ニュース向けの取材（出来事の事実と当事者の素性）は相場には噛み合わない。相場で要るのは
   * 「何が起きたか」より「数字がどこからどこへ動いたのか・その裏で誰が何を織り込んだのか」。
   *
   * 材料は2つ重ねる。放送で実際に読んだ金融情報（既に手元にある実データ。同じ数字を全員が
   * 共有しないと議論が噛み合わない）と、検索で裏を取った市場の背景。
   *
   * @param {string} sourceText 討論の出発点になる原稿
   * @returns {Promise<string>} 箇条書きの資料。取れなければ空文字
   */
  _startMarketResearch(sourceText) {
    const creds = this.getCredentials();
    const apiKey = creds?.gemini?.api_key;
    if (!apiKey) return Promise.resolve('');

    // 放送で読んだ金融のデータそのもの。探させるより確実で、数字も揃う
    let onAir = '';
    try {
      const cached = this.financeService?.cache?.data;
      if (cached) onAir = String(cached).slice(0, 2000);
    } catch { /* 取れなければ検索だけで進める */ }

    const prompt = `以下は、いまラジオで読まれた金融情報と、この後の討論の材料です。
出演者が**相場の数字を繰り返すだけ**にならないよう、その裏で何が起きているのかを調べてください。

${onAir ? `【放送で読んだ金融情報（実データ）】\n${onAir}\n\n` : ''}${sourceText ? `【討論の出発点】\n${sourceText}\n\n` : ''}
【集めるもの】
- **今の水準と、その変化**: 主要な株価指数・長期金利・為替について、現在の水準と、
  直近（1週間・1ヶ月）でどれだけ動いたか。前回の高値／安値と比べてどこにいるか。
- **その動きを説明している出来事**: 中央銀行の決定と発言、発表された経済指標（物価・雇用・GDP）、
  政策や規制の変更、地政学的な出来事。**いつ・誰が・何を言ったか／出したか**を具体的に。
- **市場が今なにを織り込んでいるか**: 次回会合での利上げ／利下げの織り込み、
  企業業績の見通し、どのセクターへ資金が向かい、どこから抜けているか。
- **見方が割れている論点**: 同じ数字について強気と弱気で解釈が分かれている点があれば、
  両方の言い分を1行ずつ。ここが議論の火種になります。
- **生活への接点**: その動きが住宅ローン金利・輸入物価・給与・年金運用のどれに、
  どう跳ね返りうるか（確認できる範囲で）。

【厳守】
- **確認できた事実だけ**を書いてください。予想・相場観・「〜だろう」は書かないこと。
  ただし「市場が織り込んでいる確率」のように**観測された織り込み**は事実として扱ってよい。
- 各行の末尾に出典を簡潔に添えてください（例:「（日銀公表）」「（報道各社）」）。
- 数字が見つからない項目は、無理に書かず **「この項目は確かな数字が見つかりませんでした」** と書いてください。
- 箇条書きのみ。前置き・まとめ・感想は不要です。全体で800字以内。`;

    return generateText({
      tier: 'research',
      apiKey,
      grounded: true,
      prompt,
      temperature: 0,
      agentKey: 'discussion_market_research',
    })
      .then(({ text }) => {
        const t = (text || '').trim();
        return t ? `▼ 相場の数字と、その裏で動いているもの\n${t}` : '';
      })
      .catch((e) => {
        getLogger().warn(`[Discussion] 市場の取材に失敗（数字なしで進行します）: ${e.message}`);
        return '';
      });
  },

  /**
   * 討論の前に一度だけ取材して、全員が共有する実データを用意する。
   *
   * ATTENTION: 各自に検索させないこと。バラバラに調べると数字が食い違って議論が噛み合わず、
   * 誰も数字を持ってこない回も残る。共有の事実を1枚作り、全員がそこから引く形にする。
   * ATTENTION: 取材は討論の準備と同時に投げ、進行役の発話と並行させること。待つと放送に
   * 間が空く。失敗しても討論は続く（その場合は「数字を使わずに論じる」指示が効く）。
   *
   * @param {string} sourceText 直前のコーナーの原稿
   * @param {any} [key] 討論コーナーのキー
   * @returns {Promise<string>} 取材の結果をまとめたメモ。取れなければ空文字
   */
  _startDiscussionResearch(sourceText, key = 'news_deep_dive') {
    // コーナーによって要る材料が違う。相場は「当事者の素性」ではなく「数字と、その背後の
    // 力学」なので、取材そのものを差し替える。
    if (DISCUSSION_CORNERS[key]?.research === 'market') {
      return this._startMarketResearch(sourceText);
    }
    const creds = this.getCredentials();
    const apiKey = creds?.gemini?.api_key;
    if (!apiKey || !sourceText) return Promise.resolve('');
    const prompt = `以下は、いまラジオで読まれたニュース原稿です。この直後に出演者が討論します。
討論で使える**検証可能な事実**を集めてください。

${sourceText}

【集めるもの】議論になりそうな項目について、次のような「調べれば確かめられる数字・固有名詞」:
- 金額・規模（調達額、売上、時価総額、設備投資額、利用者数、シェア など）
- 時期（いつ決まったか、いつから始まるか、前回はいつか）
- 当事者の固有名詞（企業名・機関名・製品名・人の役職）
- 直近の同種の出来事と、そのときの結果

【厳守】
- **確認できた事実だけ**を書いてください。推測・見込み・「〜と言われている」は書かないこと。
- 各行の末尾に出典を簡潔に添えてください（例: 「（同社決算発表）」「（報道各社）」）。
- 数字が見つからない項目は、無理に書かず **「この項目は確かな数字が見つかりませんでした」** と書いてください。
- 箇条書きのみ。前置き・まとめ・感想は不要です。全体で600字以内。`;

    // 出来事の取材と素性の取材を並行で走らせ、1枚のメモにまとめる。
    // 素性を先に置くのは、それが議論の前提だから。
    const factsPromise = generateText({
      tier: 'research',            // 検索を伴う調べ物の段
      apiKey,
      grounded: true,              // 検索で裏を取る
      prompt,
      temperature: 0,              // 事実集めなので揺らさない
      agentKey: 'discussion_research',
    })
      .then(({ text }) => (text || '').trim())
      .catch((e) => {
        getLogger().warn(`[Discussion] 取材に失敗（数字なしで進行します）: ${e.message}`);
        return '';
      });

    return Promise.all([this._startEntityResearch(sourceText), factsPromise])
      .then(([entities, facts]) => {
        const parts = [];
        if (entities) parts.push(`▼ 登場する組織は何者か（議論の前提。ここを外すと空疎になります）\n${entities}`);
        if (facts) parts.push(`▼ この出来事について確認できた事実\n${facts}`);
        return parts.join('\n\n');
      });
  },

  /**
   * 議事録を、次の話者へ渡す形に整える（直近3発言）。
   *
   * @param {any} dc 討論コーナーの状態
   * @returns {string} 整えた議事録。まだ発言が無ければ空文字
   */
  _discussionTranscriptText(dc) {
    if (dc.transcript.length === 0) return '';
    return dc.transcript.slice(-3)
      .map(t => `【${t.name}】${t.text.replace(/\[PAUSE:\d+\]/g, '').trim().slice(0, 220)}`)
      .join('\n');
  },

  /**
   * 討論コーナーを、前のコーナーを読み上げている最中に準備する。
   *
   * ATTENTION: 前のコーナーの原稿が出来た直後（読み上げの前）に呼ぶこと。読み上げには1〜2分
   * かかるので、開幕の案内の生成は余裕で間に合う。読み上げが終わってから始めると、
   * コーナーの継ぎ目が20秒前後まるごと無音になる。
   * ATTENTION: 「何回に1回」の回数を進める判定は、ここでしか呼ばないこと。準備と起動の
   * 両方で呼ぶと二重に数える。
   *
   * @param {any} afterCornerKey いま読み上げようとしているコーナー
   * @param {string} sourceText そのコーナーの原稿（直前の発言はまだ古いので必ず渡す）
   * @param {any} ctx 進行の1歩で共有している値
   * @returns {any} 準備した討論コーナーのキー。始めない回は null
   */
  _prepareDiscussionAfterCorner(afterCornerKey, sourceText, ctx) {
    try {
      if (this._pendingDiscussion) return null;   // 二重に準備しない
      const key = this._shouldStartDiscussionAfter(afterCornerKey);
      if (!key) return null;
      const dc = this._buildDiscussionCorner(key, { sourceText });
      if (!dc) return null;

      // 話題と人選は、いま読み上げようとしている原稿を見てディレクターが決める。
      // ATTENTION: 開幕の案内は出演者を名前入りで紹介するので、人選が決まってから作ること。
      // 上限を過ぎた・失敗した場合は、既に組んである人選のまま進む。
      dc.castPromise = Promise.race([
        this._requestDiscussionCastDecision(key, sourceText).catch((e) => {
          getLogger().warn(`[Discussion] ${key}: ディレクターの人選に失敗（従来の人選で続行）: ${e.message}`);
          return null;
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), CAST_DECISION_WAIT_MS)),
      ]).then((pick) => {
        if (!pick) {
          getLogger().info(`[Discussion] ${dc.name}: ディレクターの人選が得られなかったため従来の人選で進めます`);
          return;
        }
        this._applyDiscussionCastDecision(dc, pick);
      });

      // 開幕の案内の原稿と1文目の音声を、いまのコーナーの読み上げ中に作っておく。
      // 置き場所は既存の先読みの枠。討論が続く回は次に鳴るのがこの案内なので、枠の
      // 使い道としてもこちらが正しい。進行役は人選に関係なく必ず先頭なので、話者はここで決まる。
      const step = dc.plan[0];
      const openTextPromise = dc.castPromise.then(() =>
        this.generateAgentSpeech(dc.plan[0].agent, this._buildDiscussionTurnContext(dc, dc.plan[0], '', ctx)));
      this._prefetchedSpeech = this._buildPrefetchedSpeech(
        `${dc.key}_0`,
        openTextPromise,
        step.agent,
      );
      this._pendingDiscussion = dc;
      dc._dashState = 'preparing';
      this._broadcastDiscussionStatus(dc, 'preparing', { after: afterCornerKey });
      getLogger().info(`[Discussion] ${dc.name}: 開幕アナウンスを先読み開始（${afterCornerKey}の読み上げ中）`);
      return key;
    } catch (e) {
      getLogger().warn(`[Discussion] 事前準備に失敗（従来どおり読了後に立てます）: ${e.message}`);
      this._pendingDiscussion = null;
      return null;
    }
  },

  /**
   * 準備済みの討論コーナーを起動する。前のコーナーを読み終えた直後に呼ぶ。
   *
   * 準備が無い場合はその場で立てる。先読みは効かないが放送は止まらない。準備の呼び出しを
   * まだ差していない場所から呼ばれたときに、黙って壊れるのではなく「遅いが動く」に倒すため。
   * その場合は警告を出して、差し忘れに気づけるようにしてある。
   *
   * @param {any} afterCornerKey 終わったコーナーのキー
   * @returns {boolean} 討論コーナーを開始したか
   */
  _activatePreparedDiscussion(afterCornerKey) {
    const pending = this._pendingDiscussion;
    this._pendingDiscussion = null;
    // 準備を済ませた後にオフへ切り替えられた場合は、準備済みでも起動しない。設定は毎回
    // 読み直すので、切り替えた直後の回から効く。先読みに積んだ案内も枠ごと空ける。
    // 討論が既に始まっている場合はここを通らないので、途中で打ち切られることはない。
    if (pending && !this._readDiscussionConfig(pending.key).enabled) {
      if (this._prefetchedSpeech?.key === `${pending.key}_0`) this._prefetchedSpeech = null;
      this._broadcastDiscussionStatus(pending, 'cancelled', { reason: 'disabled' });
      getLogger().info(`[Discussion] ${pending.name}: 準備の後にオフへ切り替えられたため起動しません`);
      return false;
    }
    if (pending) {
      this._discussionCorner = pending;
      getLogger().info(`[Discussion] ${pending.name} 開始（先読み済み）`);
      return true;
    }
    // 準備されていなかった場合だけ、ここで判定して作る
    const key = this._shouldStartDiscussionAfter(afterCornerKey);
    if (!key) return false;
    getLogger().warn(`[Discussion] ${key}: 事前準備がありません — ${afterCornerKey} のステップに`
      + ` _prepareDiscussionAfterCorner を入れてください（今回は読了後に生成するため無音が長くなります）`);
    return !!this._startDiscussionCorner(key);
  },

  /**
   * 討論コーナーの進み具合を画面へ知らせる。
   *
   * state は preparing（前のコーナーの読み上げ中に準備）／ running（発言中）／
   * finished（終了）／ cancelled（準備の後にオフへ切り替えられた）。
   * ATTENTION: 表示のためだけの通知で、放送の進行はこれを一切参照しない。失敗しても放送は
   * 止めないこと。
   *
   * @param {any} dc 討論コーナーの状態
   * @param {string} state 上記のいずれか
   * @param {any} [extra] 付け足す項目
   * @returns {void}
   */
  _broadcastDiscussionStatus(dc, state, extra = {}) {
    if (!dc) return;
    try {
      this._broadcast({
        event: 'DISCUSSION_STATUS',
        key: dc.key,
        name: dc.name,
        state,
        plan: (dc.plan || []).map((st) => ({ agent: st.agent, role: st.role })),
        stepIndex: null,
        turns: (dc.transcript || []).length,
        research: dc.researchState || 'running',
        researchChars: dc.researchChars || 0,
        ...extra,
      });
    } catch (e) {
      getLogger().debug(`[Discussion] ダッシュボードへの通知に失敗（放送は続行）: ${e.message}`);
    }
  },

  /**
   * 出演者の名前を「・」でつないだ文字列を返す。
   * ATTENTION: 本番の発話時と、次の話者を先に作るときの2か所から必要になる。片方のローカル変数
   * として書くと、もう片方が宣言されていない名前を参照して討論そのものが毎回落ちる。
   *
   * @param {any} dc 討論コーナーの状態
   * @param {any} def 討論コーナーの定義
   * @param {any} ctx 進行の1歩で共有している値
   * @returns {string} つないだ名前
   */
  _discussionCastNames(dc, def, ctx) {
    const { config, _an } = ctx;
    return [def.host, ...dc.cast]
      .map((a) => (config.agents?.[a]?.name) || _an[a] || a).join('・');
  },

  /**
   * 「直前に放送された内容」の部分を組み立てる。
   * ATTENTION: 出演者の名前と同じく、2か所から必要になる。片方のローカル変数にしないこと。
   *
   * @param {any} dc 討論コーナーの状態
   * @returns {string} 組み立てた部分。元の原稿が無ければ空文字
   */
  _discussionSourceBlock(dc) {
    return dc.source
      ? `\n【直前に放送された内容（${dc.source.agentName}）】\n${dc.source.excerpt}\n` : '';
  },

  /**
   * 討論の1発言ぶんのプロンプトを組み立てる。
   * ATTENTION: 本番の発話時と先読み時の2か所から呼ばれる。片方だけ直すと必ず食い違うので、
   * 組み立てはこの1か所に集約すること。
   *
   * @param {any} dc 討論コーナーの状態
   * @param {any} step 今回の発言（agent と role）
   * @param {string} facts 手元の材料（最初の発言では空文字。待つと放送に間が空くため）
   * @param {any} ctx 進行の1歩で共有している値
   * @returns {string} 組み立てたプロンプト
   */
  _buildDiscussionTurnContext(dc, step, facts, ctx) {
    const { _an, baseContextPrompt, config } = ctx;
    const def = DISCUSSION_CORNERS[dc.key];
    const agentKey = step.agent;
    const sourceBlock = this._discussionSourceBlock(dc);
    const factsBlock = facts
      ? `\n【手元の材料（放送前に裏を取った事実と、公式データから計算した数値）】\n${facts}\n`
      : '';
    const transcript = this._discussionTranscriptText(dc);
    const transcriptBlock = transcript
      ? `\n【ここまでの議論】\n${transcript}\n\n⚠️ 直前の発言を必ず受け取ってください。相手が言ったことを踏まえずに自分の話だけを始めるのは禁止です。\n`
      : '';
    const castNames = this._discussionCastNames(dc, def, ctx);

    // ATTENTION: 発言者ごとに、その人の手持ち（リスナー像・自分の日記の振り返り・裏の顔・
    // 継続観測のメモ・定期監視・自主リサーチ）を必ず渡すこと。討論コーナーは通常のコーナーと
    // 違って自前でプロンプトを組むため、渡し忘れると蓄積だけされて使われない片道の輪になる。
    // 実際、自分の持ち場では2,000字の監視結果を持っている人が、討論では人格の設定だけを
    // 持って席に着いていた。
    const personalBlock = buildAgentKnowledgePack({
      agentKey,
      selfDigest: this._getAgentDiarySelfDigest(agentKey),
      topic: dc.topic || '',
    });

    const cornerContext = `${baseContextPrompt}${personalBlock}
${'━'.repeat(50)}
【コーナー: ${dc.name}】${def.theme}
【深掘りする話題】${dc.topic}
【出演者】${castNames}
${sourceBlock}${factsBlock}${transcriptBlock}
${'━'.repeat(50)}
【あなたの役割】${def.roleInstructions[step.role]}${step.role === 'open'
  ? `\n\n⚠️ **最初の一文で、コーナー名「${dc.name}」をそのまま口に出して開始を告げてください。**`
    + `「では、${dc.name}を始めます」「ここからは${dc.name}のコーナーです」のように、`
    + `**この名前を一字一句そのまま**使うこと。言い換え・省略・英語化は禁止です。`
    + `リスナーに「番組が一つのコーナーに入った」と伝わる区切りにしてください。`
  : ''}
${def.agentLenses?.[agentKey] ? `\n【あなたが見るべき面】${def.agentLenses[agentKey]}\n` : ''}
${dc.editorialMode ? `
【この回の主題 — 同じ出来事に対する各社の主張の割れ】
掘るのは出来事そのものではなく、**なぜ各社の評価がここまで割れるのか**です。
- 各社が一致している事実と、割れているのは評価の部分である、という線引きから始めてください。
- 「その社が過去にこのテーマで何と書いてきたか」が材料にあれば、今日の主張がその延長にあるのか、
  変わったのかを見てください（変化そのものが論点になります）。
- 割れる理由を、構造で語ってください。例: 何を守ろうとしているか（安全保障・財政・生活・産業）、
  誰の側から書いているか、どの時間軸で見ているか。
- **禁止**: 「いいですね」「悪いですね」で終わる感想。「この社は偏っている」「◯◯寄りだ」という
  レッテル。どの社が正しいかを決めること。社説の本文は手元にありません（見出しだけです）。
` : ''}
【このコーナーの約束】
- ${step.role === 'factcheck'
    ? '他の出演者は意見をぶつけ合いますが、**あなたはその土台になる事実を置く役**です。議論には加わりません。'
    : 'ニュース原稿の読み上げではありません。**意見が割れることが前提の議論**です。'}
- 挨拶・自己紹介はしないでください（開幕のアナウンスは既に済んでいます）。
- 話題は1つに絞ってください。別の話題へ広げないこと。
- 事実として確認できないことを断定しないでください。

【話し方（雑談のような応酬にするため）】
- **指名されるのを待つ必要はありません。** 直前の発言に、そのまま返してください。
- 相手を名前で呼んで構いません（「〜さん、それはどうでしょう」）。
- 「いや」「でも」「ちょっと待ってください」のような**短い切り出しから入ってよい**です。
  整った演説より、会話の途中に入るような入り方のほうが望ましい。
- 「〜について申し上げますと」「〜という点について解説いたしますと」のような、
  **講演調の前置きは使わないでください。**
- 司会に許可を求めたり、次の人を指名したりしないでください（進行は番組側が決めます）。

【数字と固有名詞の扱い（最重要）】
${facts
  ? '- 数字・固有名詞は、上の【手元の材料】にあるものだけを使ってください。**そこに無い数字を'
    + '自分の記憶から出してはいけません。** 材料の数字は「〜だそうです」ではなく、'
    + '**自分で調べてきた事実として**言い切ってください。\n'
    + '- 材料に該当がなければ、数字を使わずに論じてください。「正確な数字は把握していませんが」と'
    + '断ったうえで構造や利害を語るのは構いません。\n'
    + '- 「■ 水準と変化」がある場合、水準（いくつか）だけでなく**変化（いつと比べてどれだけ動いたか）や'
    + '過去の中での位置**まで使ってください。水準を1つ読み上げるだけでは、なぜ今それが問題なのかが伝わりません。\n'
    + '- 「■ 連動性」がある場合、相関を語るときは**必ず期間を添えてください**'
    + '（「直近3か月では0.6程度」のように）。期間によって数値が変わっているなら、'
    + '**その変化自体**が論点になります（「足元で連動が強まっている」など）。\n'
    + '- 相関が高いことを理由に因果を断定しないでください。原因を語るなら、相関とは別の根拠を示すこと。'
    + '計算済みの数値を自分で計算し直したり、丸めた値から別の数値を作ったりしないでください。'
  : '- 裏の取れた数字が手元にありません。**もっともらしい数字を作ってはいけません。**\n'
    + '- 数字の代わりに、構造・利害・前例の「向き」で語ってください。'
    + '断定できないことは「私の見立てでは」と断ってから述べること。'}

【必ず入れるもの】
- 抽象論で終わらないこと。「一部で」「特定の分野で」「各国で」のようなぼかした言い方だけで
  終わらず、**誰の話なのか・どこの話なのかを名指し**してください。
- 次の型のどれかで「裏側」を語ること: 誰が得をして誰が損をするのか ／ なぜ「今」なのか ／
  前に似たことが起きたとき何が起きたか ／ 報じられていないが効いている条件は何か。

【この話題に出てくる組織について】
- 取材メモの「登場する組織は何者か」を**必ず踏まえてください**。その組織が何を提供し、
  誰が使っているのかを外したまま論じると、議論そのものが的を外します。
- **素性が分からない組織について、事業内容や戦略を推測で語らないでください。**
  メモに無ければ「そこは確認が要りますね」と言ってよい。知ったふりをするより誠実です。
- 「エコシステム」「垂直統合」「覇権」「プラットフォーマー」のような、**どの会社にも
  当てはまる言葉だけで語らないでください**。その会社が具体的に何をしているから
  そう言えるのか、中身に触れること。

【禁止】
- 相手に同意する枕詞（「ご指摘の通り」「おっしゃるとおり」「〜も一理あります」）。
- 逃げの締め方（「複雑な側面がある」「一概には言えない」「注視が必要」「今後の動向が注目されます」
  「奥深さを感じます」）。**言い切ってください。**
- 具体的な中身が無いのに使う思わせぶりな枕詞（「情報筋によると」「表に出ていない情報ですが」
  「某関係者から聞いた話ですが」）。**2026-09-13の放送で実際に「私の某関係者から聞いた話ですが」
  と言いながら中身が一般論だけ、という発言が出ました。** 続けて語れる具体（数字・固有名詞・
  前例）を持っていないなら、枕詞ごと使わないでください。

【長さ】ラジオの1発言です。**3文以内**に収めてください（進行役とアシスタントは1〜2文）。
言いたいことを全部言おうとせず、**一番強い一点に絞ってください**。取材メモの事実も、
使うのは1〜2個だけで十分です。列挙は退屈になります。`;

    return cornerContext;
  },

  /**
   * 討論コーナーの1発言を処理する。進行の1歩の振り分けから、討論が立っている間だけ呼ばれる。
   *
   * @param {any} ctx 進行の1歩で共有している値
   * @returns {Promise<void>}
   */
  async _runDiscussionTurn(ctx) {
    const { _myGen, _an, baseContextPrompt, config } = ctx;
    const dc = this._discussionCorner;
    if (!dc) return;
    const def = DISCUSSION_CORNERS[dc.key];

    const step = dc.plan[dc.turnIndex];
    if (!step) return this._finishDiscussionCorner(ctx);

    const agentKey = step.agent;
    const agentName = (config.agents?.[agentKey]?.name) || _an[agentKey] || agentKey;
    this.currentState = `TALKING_${dc.key.toUpperCase()}`;
    dc._dashState = 'running';
    dc._dashStep = dc.turnIndex;
    this._broadcastDiscussionStatus(dc, 'running', { stepIndex: dc.turnIndex });

    // 開幕の曲。
    // ATTENTION: ここで鳴り終わるのを待たないこと。待つと、そのあとの原稿作りが無音になる。
    // 走らせておいて、実際に話し始める直前で待つ。
    let jinglePromise = null;
    if (dc.turnIndex === 0) {
      this._broadcast({ event: 'CORNER_START', name: dc.name });
      try {
        // 鳴っている間に、裏では取材の完了待ちと次の話者の原稿作りが進む
        const jingle = this._pickDiscussionOpeningJingle(dc.key);
        if (jingle) {
          getLogger().info(`[Discussion] ${dc.name}: 開幕の曲（${jingle.label}・約${Math.round(jingle.playDurationMs / 1000)}秒）`);
          jinglePromise = this.mixer
            .playJingle(jingle.dir, { fadeInMs: jingle.fadeInMs, playDurationMs: jingle.playDurationMs, fadeOutMs: jingle.fadeOutMs })
            .catch(() => {});
        }
      } catch (e) {
        getLogger().warn(`[Discussion] ジングルの再生に失敗（無視して続行）: ${e.message}`);
      }
    }

    // 手元の材料。進行役の1発言目は話題を選ぶだけなので待たない（待つと放送に間が空く）
    let facts = '';
    if (dc.turnIndex > 0) {
      facts = await this._discussionFacts(dc, this._discussionResearchWaitMs ?? 30000);
      if (facts && !dc._factsLogged) {
        dc._factsLogged = true;
        getLogger().info(`[Discussion] 取材メモと数値データ ${facts.length}字を議論へ供給`);
      }
    }
    const cornerContext = this._buildDiscussionTurnContext(dc, step, facts, ctx);

    // 前の発言のときに用意してあれば、それを使う。
    // どちらの経路を通ったかはログに残す（先読みの原稿に材料が入っているかを後で確かめるため）。
    const prefetchKey = `${dc.key}_${dc.turnIndex}`;
    let text;
    let firstPcmPromise = null;
    if (this._prefetchedSpeech?.key === prefetchKey) {
      const ps = this._prefetchedSpeech;
      this._prefetchedSpeech = null;
      text = await ps.promise;
      firstPcmPromise = ps.firstPcmPromise || null;
      getLogger().info(`[Discussion] ${dc.name}: ${agentName}（${step.role}）は先読みの原稿を使用`);
    } else {
      getLogger().info(`[Discussion] ${dc.name}: ${agentName}（${step.role}）は先読みが無いためその場で生成`
        + `（取材メモ${facts ? `${facts.length}字あり` : 'なし'}）`);
      text = await this.generateAgentSpeech(agentKey, cornerContext);
    }
    if (!text) {
      getLogger().warn(`[Discussion] ${dc.name}: ${agentName}の発言が空 — コーナーを打ち切ります`);
      return this._finishDiscussionCorner(ctx);
    }
    if (!firstPcmPromise) firstPcmPromise = this._prefetchFirstSentencePcm(text, agentKey);

    dc.transcript.push({ agent: agentKey, name: agentName, text });
    this.lastSpeech[agentKey] = text;

    // 次の話者のセリフを、今の発話中に作っておく（無音を作らないため）
    dc.turnIndex += 1;
    const next = dc.plan[dc.turnIndex];
    if (next) {
      // ATTENTION: 先読みの原稿も、本番と同じ組み立ての関数で作ること。簡易版の文面で
      // 作ると、材料・手持ちの知識・見る角度・「数字は材料にあるものだけ」の決まりが抜ける。
      // 次の番では先読みの原稿がそのまま使われるので、本番の文面は捨てられる経路になる。
      //
      // 開幕の曲と案内の読み上げの間に取材の完了を待ってから作る。取材は前のコーナーの
      // 読み上げ中に始まっているので通常はすぐ終わるが、待つのは上限まで（過ぎたら材料なしで作る）。
      const nextStep = next;
      // 待ち時間は検証のために差し替えられる。本番では設定しないので常に30秒
      const RESEARCH_WAIT_MS = this._discussionResearchWaitMs ?? 30000;
      const nextTextPromise = (async () => {
        // 材料をまとめて待つ（上限を過ぎた分は空として扱う）
        const nextFacts = await this._discussionFacts(dc, RESEARCH_WAIT_MS);
        // ATTENTION: 待っている間に切断された、または別の討論へ入れ替わっていたら、次の原稿は
        // 作らないこと。待ち時間ができたことで「誰も聴いていないのに原稿を作る呼び出し」が
        // 走る余地ができた。この判定は材料のログより前に置く（作らない原稿を「反映」と
        // 記録しないため）。
        if (this._speakGeneration !== ctx._myGen || this._discussionCorner !== dc) {
          getLogger().info(`[Discussion] ${dc.name}: 取材を待つ間に番組が中断されたため、`
            + `${nextStep.role} の原稿は作りません`);
          return '';
        }
        if (!nextFacts) {
          getLogger().warn(`[Discussion] ${dc.name}: 取材メモ・数値データが${RESEARCH_WAIT_MS / 1000}秒以内に`
            + `揃わなかったため、${nextStep.role} の原稿は手元の材料なしで作ります`);
        } else if (!dc._factsInPrefetchLogged) {
          dc._factsInPrefetchLogged = true;
          getLogger().info(`[Discussion] ${dc.name}: 取材メモと数値データ ${nextFacts.length}字を先読みの原稿へ反映`);
        }
        // 検索は付けない。議論の受け答えは短く、検索を挟むと発言の間に長い無音が生じる
        return this.generateAgentSpeech(
          nextStep.agent, this._buildDiscussionTurnContext(dc, nextStep, nextFacts, ctx), false,
        );
      })();
      this._prefetchedSpeech = this._buildPrefetchedSpeech(
        `${dc.key}_${dc.turnIndex}`,
        nextTextPromise,
        next.agent,
      );
    } else {
      // ATTENTION: 討論が終わった後に戻る通常進行の原稿も、ここで作っておくこと。戻ってから
      // 作ると、入口と同じ大きさ（20秒前後）の無音が出口にもできる。
      // 材料はニュースではなく討論そのものにする。議論を聞いた直後なので、何が話されたかを
      // 受けて喋るほうが自然につながる。
      const _casterKey = 'caster';
      const _asstNameD = (config.agents?.assistant?.name) || _an.assistant;
      const _digest = dc.transcript.slice(-3)
        .map(t => `【${t.name}】${t.text.replace(/\[PAUSE:\d+\]/g, '').trim().slice(0, 200)}`).join('\n');
      const _afterCtx = `${baseContextPrompt}
あなたは${_asstNameD}と軽快なトークをしながら番組を進行します。
いま「${dc.name}」のコーナーが終わったところです。

【コーナーで実際に交わされた議論（終盤）】
${_digest}

この議論を受けて一言リアクションを述べてから、新しいトピックを1つ話し、
${_asstNameD}に「${_asstNameD}さんはどう思う？」と振ってください。
【重要】「こんにちは」「元気ですか」のような再挨拶は厳禁。議論への具体的なリアクションから
始めてください。コーナーのまとめ直しもしないでください（もう締めは済んでいます）。`;
      this._prefetchedSpeech = this._buildPrefetchedSpeech(
        'caster_turn0',
        this.generateAgentSpeech(_casterKey, _afterCtx, false),
        _casterKey,
      );
    }

    if (jinglePromise) await jinglePromise;   // 曲が鳴り終わってから話し始める
    const preloaded = firstPcmPromise ? (await firstPcmPromise) : null;
    // 次の発言へ移る合間も BGM を下げたまま保ち、討論が途切れて聞こえないようにする
    await this.speakText(text, agentKey, preloaded, { holdDuckMs: next ? 400 : 0, expectedGen: _myGen });

    if (dc.turnIndex >= dc.plan.length) return this._finishDiscussionCorner(ctx);
    this._scheduleNextStep(0, _myGen);
  },

  /**
   * 討論コーナーを終え、キャスターとアシスタントの通常の進行へ戻す。
   * 記録は通常のコーナーと全く同じ扱いにする。
   *
   * @param {any} ctx 進行の1歩で共有している値
   * @returns {void}
   */
  _finishDiscussionCorner(ctx) {
    const { _myGen, config } = ctx;
    const dc = this._discussionCorner;
    this._discussionCorner = null;
    if (!dc) return;

    const joined = dc.transcript.map(t => `【${t.name}】${t.text}`).join('\n');
    if (joined) {
      // ① コーナーをまたいで話題を継ぐための「直近の実発言」
      this._pushRecentCornerContent(dc.key, dc.name, joined);
      // ② 日記は発言した本人それぞれに書かせる。
      // ATTENTION: 討論では同じ人が何度も話すため、人ごとにまとめてから1回だけ書くこと。
      // 1コーナーで同じ人の日記が何件も増えてしまう。
      // ATTENTION: キャスターとアシスタントはコーナー単位の日記を持たない作りなので、
      // ここでは書かずに溜めておき、セッション終了時の1件へ合流させること。
      const _byAgent = new Map();
      for (const t of dc.transcript) {
        if (!_byAgent.has(t.agent)) _byAgent.set(t.agent, { name: t.name, texts: [] });
        _byAgent.get(t.agent).texts.push(t.text);
      }
      for (const [agent, v] of _byAgent) {
        const text = v.texts.join('\n');
        const name = (config.agents?.[agent]?.name) || v.name;
        if (agent === 'caster' || agent === 'assistant') {
          this._bufferMaxClaraDiaryText(agent, text);
        } else {
          this._writeDiaryReflection(agent, name, text, dc.key).catch(() => {});
        }
        // 継続観測のメモ（次回も追う話題）は、討論での発言からも溜める。自分のコーナーでしか
        // 書かないと、討論にどれだけ出ても手持ちが増えない。日記が「振り返り」なのに対し、
        // こちらは「追い続ける話題」を残す器で、別物。
        recordAgentNote(agent, text, {
          apiKey: this.getCredentials()?.gemini?.api_key,
          activitySessionId: this._activitySessionId,
          label: dc.key,
        });
      }
    }
    // ③ 編成の記録（ディレクターの振り返りの材料）
    this._recordCornerPlayed(dc.key);
    dc._dashState = 'finished';
    this._broadcastDiscussionStatus(dc, 'finished', { endedAt: Date.now() });
    getLogger().info(`[Discussion] ${dc.name} 終了（${dc.transcript.length}発言）`);

    this.conversationTurn = 0;
    this.currentTokenHolder = 'caster';
    this._scheduleNextStep(0, _myGen);
  },
};

module.exports = { DISCUSSION_CORNERS, discussionCornerMethods };
