/**
 * @file 秘書の create_presentation ツール（調べた内容を Google スライドの資料にまとめる）
 *
 * 秘書に「この件を調べてスライドにまとめて」と頼むためのツール。作り方は2通りあり、この処理の中の
 * 分岐だけが接点で、互いに独立している。
 *
 * - 新しい方式: 管理画面でテンプレートが登録されていれば、専用のヘルパー（presentation-creator-agent.js）が
 *   レイアウトを選びながら1枚ずつ組み、見た目を見て直す
 * - 古い方式: テンプレートが無ければ、固定のテンプレートのデッキ（setup-presentation-template.js で作ったもの。
 *   デザインの正本は server/data/presentation-design.md）を複製し、次の順に作る
 *   1. _researchTopicForSlides: Google 検索を使って調べ、文章で返させる
 *   2. _planSlidesFromResearch: 調べた文章を、スライドの構成の JSON（SLIDE_PLAN_SCHEMA）にさせる
 *   3. buildPresentationFromPlan: 構成から、Slides API でデッキを組む（LLM は画像の生成だけ）
 *
 * ATTENTION: 1と2は1回にまとめない。Gemini は Google 検索（tools）と構造化出力（responseSchema）を
 * 同じリクエストで使えない。
 *
 * グラフは Google スプレッドシートにデータを書き、そのグラフをスライドにリンクして貼る（見た目がよく、
 * 元のデータを編集できる）。利用元は secretary-tools.js・secretary-tool-declarations.js・test-create-presentation.js。
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

const { generateText, generateImage } = require('./llm-client');
const { resolveModel } = require('./llm-models');
const { googleService } = require('./secretary-tools-services');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { buildChartSpec, buildChartValues } = require('./presentation-media');
const presConfig = require('./presentation-config');
const { runPresentationJob, chooseTemplateByAI } = require('./presentation-creator-agent');
const { getLogger } = require('../logger');

// 古い方式のテンプレートのデッキ。server/setup-presentation-template.js を実行して出た presentationId
const TEMPLATE_PRESENTATION_ID = '1fAzafnGDsgI_ZePRB_1cVvvx9x39QUCjkmKqXLNDVT4';

// テンプレートの中の、レイアウトの見本のスライドの ID（複製して使い、最後に消す）
const LAYOUT_SLIDE_IDS = {
  TITLE: 'layout_title',
  BULLET: 'layout_bullet',
  COMPARISON: 'layout_comparison',
  KPI: 'layout_kpi',
  CHART: 'layout_chart',
  IMAGE: 'layout_image',
};

/** このファイルのツールの宣言（Gemini の Function Calling の形）。 */
const TOOL_DECLARATIONS = [{
  name: 'create_presentation',
  // いつ呼ぶか（発動の条件）を宣言に書く（Gemini Live の推奨のやり方）。一番時間のかかるツールで、
  // 「お待ちください」と言ったところでターンが終わって止まりやすいため、最後まで呼ぶよう念を押している
  description: 'リサーチ内容を、編集可能なGoogleスライドのプレゼンテーションにまとめます。'
    + '完成後、共有可能なリンクを案内してください。'
    + '\n\n【発動条件】リスナーが「この件をリサーチしてスライドにまとめて」「〇〇についてプレゼン資料を'
    + '作って」のようにスライド・プレゼン資料の作成を求めたら、必ずこの機能を呼び出してください。'
    + 'リサーチはこの機能が内部で行うため、事前に別途調べておく必要はありません。'
    + '完了まで2分程度かかりますが、途中で諦めたり、代わりに口頭で構成案を述べて済ませたりせず、'
    + '必ず最後まで呼び出しきってください。',
  parameters: {
    type: 'OBJECT',
    properties: {
      topic: { type: 'STRING', description: 'プレゼンテーションのテーマ' },
      project: { type: 'STRING', description: '関連するプロジェクト名（あれば、タイトル整理用）' },
      // ここから下は依頼の骨子。どれも任意で、指定が無ければ presentation-design.md の既定値を使う
      // （古い方式では使わない）
      purpose: { type: 'STRING', description: '何のための資料か（例: 新規顧客への営業提案、社内の四半期報告）' },
      audience: { type: 'STRING', description: '誰に向けた資料か（例: 経営層、現場担当者、投資家）' },
      slides: { type: 'STRING', description: 'スライドの総数の目安（例: 8〜10枚）' },
      tone: { type: 'STRING', description: '資料のトーン（例: フォーマル、カジュアル、データドリブン）' },
      style: { type: 'STRING', description: '見た目の希望（例: 配色は青系、1枚の要点は3つまで、余白を広めに）' },
      template: { type: 'STRING', description: '使うテンプレートの名前（例: 社外提案用）。指定が無ければ既定を使う' },
    },
    required: ['topic'],
  },
}];

/**
 * 古い方式の1段目。Google 検索を使ってテーマを調べ、調べた結果を文章で返す。
 * @param {{apiKey: string, topic: string, activitySessionId?: any}} args
 * @returns {Promise<{text: string, usage: any}>} 調べた結果の文章と使用量
 */
async function _researchTopicForSlides({ apiKey, topic, activitySessionId = null }) {
  const systemInstruction = 'あなたはプレゼンテーション作成のためのリサーチ担当です。指定された'
    + 'テーマについてWeb検索を使って調査してください。数値・比較・時系列の変化など、スライドの'
    + 'グラフや表にできる具体的なデータがあれば必ず含めてください。分からなかった点は推測で'
    + '埋めず「不明」と書いてください。出力は調査結果の文章のみとし、前置きや締めの言葉は'
    + '含めないでください。';
  const { text: text, usage } = await generateText({
    tier: 'analysis',
    apiKey,
    systemInstruction,
    prompt: `テーマ: ${topic}`,
    temperature: 0.3,
    grounded: true,
    // 使用量の記録は llm-client に任せる（ここで書くとモデル名を手書きすることになり、ティアを変えたときに古い名前で残る）
    agentKey: 'secretary_presentation',
    activitySessionId,
    logMeta: { purpose: 'presentation_research' },
  });
  return { text: text.trim(), usage };
}

/** 古い方式の2段目で、スライドの構成を出させる JSON の形（構造化出力のスキーマ）。 */
const SLIDE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    // 表紙に、テーマに合った画像を毎回作るための説明
    coverImagePrompt: { type: 'string', description: '表紙画像を生成するための視覚的な説明（テーマを象徴する情景）' },
    slides: {
      type: 'array',
      // BUGFIX: 枚数に上限を付ける。無いと、調べた内容が多い話題で枚数が際限なく増え、出力が途中で
      // 切れて JSON の解析に失敗した（構造化出力でも、長さそのものは制限されない）
      maxItems: 7,
      items: {
        type: 'object',
        properties: {
          layout: { type: 'string', enum: ['BULLET', 'COMPARISON', 'KPI', 'CHART', 'IMAGE'] },
          title: { type: 'string' },
          body: { type: 'string', description: '箇条書き。各行を\\nで区切る。最大6行' },
          compareLeftTitle: { type: 'string' },
          compareLeftBody: { type: 'string' },
          compareRightTitle: { type: 'string' },
          compareRightBody: { type: 'string' },
          stats: {
            type: 'array',
            items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] },
          },
          chartType: { type: 'string', enum: ['COLUMN', 'BAR', 'LINE', 'AREA', 'SCATTER', 'PIE'] },
          chartCategories: { type: 'array', items: { type: 'string' } },
          chartSeries: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] },
          },
          takeaway: { type: 'string' },
          imagePrompt: { type: 'string', description: 'IMAGEレイアウトのときのみ。挿入する画像の視覚的な説明' },
          caption: { type: 'string', description: 'IMAGEレイアウトのときのみ。画像の下に添える1行のキャプション' },
        },
        required: ['layout', 'title'],
      },
    },
  },
  required: ['title', 'slides'],
};

/**
 * 古い方式の2段目。調べた結果の文章を、スライドの構成の JSON（SLIDE_PLAN_SCHEMA）にする。
 * @param {{apiKey: string, topic: string, researchText: string, activitySessionId?: any}} args
 * @returns {Promise<{plan: any, usage: any}>} スライドの構成と使用量。解析できなければ例外を投げる
 */
async function _planSlidesFromResearch({ apiKey, topic, researchText, activitySessionId = null }) {
  const systemInstruction = '渡されたリサーチ結果を、プレゼンテーションのスライド構成に整形して'
    + 'ください。\n'
    + '・4〜7枚程度のスライドにまとめる。slidesは絶対に7要素を超えないこと\n'
    + '・数値の比較や時系列の変化があるデータは必ずCHARTレイアウトを1枚以上使う\n'
    + '・重要な数値を強調したい場合はKPIレイアウト（statsは最大3件）を使う\n'
    + '・2つの対象を対比する場合はCOMPARISONレイアウトを使う\n'
    + '・それ以外の説明はBULLETレイアウト（bodyは最大6行、各行\\nで区切る）を使う\n'
    + '・写真や情景を見せた方が伝わる内容（場所・人物・製品・雰囲気等）が1つでもあれば、'
    + 'IMAGEレイアウトを1枚使う（imagePromptに挿入する画像の視覚的な説明、captionに'
    + '1行の説明文を書く）。無理に使う必要は無い\n'
    + '・coverImagePromptには、テーマ全体を象徴する情景を必ず記述する（表紙に使う）\n'
    + '・imagePrompt/coverImagePromptは、実際に写真・イラストとして生成できる具体的な'
    + '視覚描写にする（「〇〇のイメージ」のような曖昧な表現は避ける）\n'
    + '・chartCategories/chartSeriesはCHARTレイアウトのときのみ埋める。系列は最大2つ\n'
    + '・chartTypeは内容に合わせて選ぶこと: 時系列の推移はLINE、累積・構成比の推移は'
    + 'AREA、複数項目の比較はCOLUMN、項目名が長い/件数が多いランキングはBAR、'
    + '全体に占める内訳・シェアはPIE（このときchartSeriesは1つだけにする）、'
    + '2つの数値の相関関係はSCATTERを使う\n'
    + '・リサーチ結果に無い情報を創作しないこと\n'
    + '【重要・文字数厳守】各文字列フィールドは必ず簡潔にすること。title/caption/'
    + 'compareLeftTitle/compareRightTitle/stat.labelは20文字以内、body/'
    + 'compareLeftBody/compareRightBody/takeawayは150文字以内、imagePrompt/'
    + 'coverImagePromptは100文字以内。リサーチ結果の文章をそのまま長く転記しないこと。';
  const { text: text, usage, finishReason } = await generateText({
    tier: 'analysis',
    apiKey,
    systemInstruction,
    prompt: `テーマ: ${topic}\n\n【リサーチ結果】\n${researchText}`,
    temperature: 0.2,
    schema: SLIDE_PLAN_SCHEMA,
    agentKey: 'secretary_presentation',
    activitySessionId,
    logMeta: { purpose: 'presentation_plan' },
  });
  try {
    return { plan: JSON.parse(text), usage };
  } catch (e) {
    throw new Error(`スライド構成のJSON解析に失敗しました（応答が${text.length}文字、`
      + `finishReason=${finishReason}）: ${e.message}`);
  }
}

/**
 * スライドに入れる画像を1枚作る。
 * @param {{apiKey: string, prompt: string, aspectRatio: string, imageModel?: string|null, activitySessionId?: any}} args
 *   aspectRatio は枠の形に近い縦横比（'3:4'・'16:9' など）
 * @returns {Promise<{imageBase64: string, mimeType: string, usage: any}|null>} 作れなければ null
 */
async function _generateSlideImage({ apiKey, prompt, aspectRatio, imageModel, activitySessionId = null }) {
  // ATTENTION: 縦横比を枠に合わせること。合わないと、Slides は画像の形を保ったまま枠に収めるので、
  //            枠の大半が余白になる。今の SDK（@google/genai）でも指定が効くことは実機で確認済み。
  const img = await generateImage({
    tier: 'image',
    apiKey,
    prompt,
    aspectRatio,
    modelOverrideForCompat: imageModel || null,
    agentKey: 'secretary_presentation',
    activitySessionId,
    logMeta: { purpose: 'presentation_image' },
  });
  return img ? { imageBase64: img.imageBase64, mimeType: img.mimeType, usage: img.usage } : null;
}

/**
 * 作った画像を Drive に置き、Slides API の createImage が取り込める URL を返す。
 *
 * ATTENTION: 画像は「リンクを知っている全員が見られる」にする必要がある。Slides が匿名で URL を取りに行くため。
 *
 * @param {Record<string, any>} creds 認証情報
 * @param {{name: string, imageBase64: string, mimeType: string}} image ファイル名と画像
 * @returns {Promise<string>} 画像の URL
 */
async function _uploadSlideImage(creds, { name, imageBase64, mimeType }) {
  const uploaded = await googleService.uploadImageToDrive(creds, { name, base64Data: imageBase64, mimeType });
  await googleService.makeFilePublicReadable(creds, { fileId: uploaded.id });
  return `https://drive.google.com/uc?export=view&id=${uploaded.id}`;
}

/**
 * テンプレートの画像の枠（代替テキストで印を付けた四角）を消し、同じ位置と大きさに画像を入れる。
 *
 * @param {Record<string, any>} creds 認証情報
 * @param {{presentationId: string, slideId: string, placeholderElement: any, imageUrl: string}} args
 *   placeholderElement は枠の要素（位置と大きさを読む）
 * @returns {Promise<void>}
 */
async function _replacePlaceholderWithImage(creds, { presentationId, slideId, placeholderElement, imageUrl }) {
  // 実際の表示の大きさ（size×scale）を計算し、scale=1 で渡す。要素の種類によって内部の基準の大きさが
  // 違うため（buildPresentationFromPlan のグラフの BUGFIX 参照）。画像でも念のため同じようにする
  const effectiveWidthEmu = Math.round(placeholderElement.size.width.magnitude * (placeholderElement.transform.scaleX ?? 1));
  const effectiveHeightEmu = Math.round(placeholderElement.size.height.magnitude * (placeholderElement.transform.scaleY ?? 1));
  await googleService.batchUpdatePresentation(creds, {
    presentationId,
    requests: [
      { deleteObject: { objectId: placeholderElement.objectId } },
      {
        createImage: {
          url: imageUrl,
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: effectiveWidthEmu, unit: 'EMU' },
              height: { magnitude: effectiveHeightEmu, unit: 'EMU' },
            },
            transform: {
              scaleX: 1, scaleY: 1,
              translateX: placeholderElement.transform.translateX ?? 0,
              translateY: placeholderElement.transform.translateY ?? 0,
              unit: 'EMU',
            },
          },
        },
      },
    ],
  });
}

/**
 * スライドの構成（SLIDE_PLAN_SCHEMA の形）から、Google スライドのデッキを1つ組み立てる（古い方式）。
 *
 * テンプレートを複製し、表紙と各スライドを見本から複製して並べ、文字を差し込み、表紙と画像のスライドに
 * 画像を、グラフのスライドに Sheets のグラフを入れ、最後に見本のスライドを消す。
 * LLM は画像を作るときしか呼ばないので、test-create-presentation.js から直接呼んでスライドの部分だけを
 * 試せる。本番もこの関数をそのまま使う（試すものと本番を分けないため）。
 *
 * @param {Record<string, any>} creds 認証情報
 * @param {{plan: any, deckTitle: string, templateId?: string, activitySessionId?: any}} args
 * @returns {Promise<{ presentationId: string, webViewLink: string }>}
 */
async function buildPresentationFromPlan(creds, { plan, deckTitle, templateId = TEMPLATE_PRESENTATION_ID, activitySessionId = null }) {
  if (!templateId) throw new Error('プレゼンテーションのテンプレートがまだ設定されていません。');
  const dup = await googleService.duplicatePresentation(creds, { templateId, name: deckTitle });
  const presentationId = dup.id;

  // ① 表紙と全部のスライドを、見本から1回の batchUpdate で複製する。
  // BUGFIX: 表紙は LLM の構成に任せず、plan.title と plan.subtitle から必ず1枚作る。構成に任せていたころ、
  // 表紙が一度も選ばれず、表紙の無いデッキになっていた
  const slides = plan.slides || [];
  const dupRequests = [
    { duplicateObject: { objectId: LAYOUT_SLIDE_IDS.TITLE } },
    ...slides.map(s => ({ duplicateObject: { objectId: LAYOUT_SLIDE_IDS[s.layout] || LAYOUT_SLIDE_IDS.BULLET } })),
  ];
  const dupReply = await googleService.batchUpdatePresentation(creds, { presentationId, requests: dupRequests });
  const [titleSlideId, ...newSlideIds] = (dupReply.replies || []).map(r => r.duplicateObject.objectId);

  // ② 文字を差し込み、並び順を決める（複製したスライドは見本のすぐ後ろに入るので、並べ直す）
  const fillRequests = [];
  const scopedFor = slideId => (marker, value) => ({
    replaceAllText: { containsText: { text: marker, matchCase: true }, replaceText: value ?? '', pageObjectIds: [slideId] },
  });
  if (titleSlideId) {
    fillRequests.push({ updateSlidesPosition: { slideObjectIds: [titleSlideId], insertionIndex: 0 } });
    const scopedTitle = scopedFor(titleSlideId);
    fillRequests.push(scopedTitle('{{TITLE}}', plan.title || deckTitle));
    fillRequests.push(scopedTitle('{{SUBTITLE}}', plan.subtitle));
  }
  slides.forEach((s, i) => {
    const slideId = newSlideIds[i];
    if (!slideId) return;
    // 表紙が先頭なので、ほかのスライドは1つずつ後ろにずれる
    fillRequests.push({ updateSlidesPosition: { slideObjectIds: [slideId], insertionIndex: i + 1 } });
    const scoped = scopedFor(slideId);
    fillRequests.push(scoped('{{TITLE}}', s.title));
    if (s.layout === 'BULLET') {
      fillRequests.push(scoped('{{BODY}}', s.body));
    } else if (s.layout === 'COMPARISON') {
      fillRequests.push(scoped('{{COMPARE_LEFT_TITLE}}', s.compareLeftTitle));
      fillRequests.push(scoped('{{COMPARE_LEFT_BODY}}', s.compareLeftBody));
      fillRequests.push(scoped('{{COMPARE_RIGHT_TITLE}}', s.compareRightTitle));
      fillRequests.push(scoped('{{COMPARE_RIGHT_BODY}}', s.compareRightBody));
    } else if (s.layout === 'KPI') {
      (s.stats || []).slice(0, 3).forEach((stat, si) => {
        fillRequests.push(scoped(`{{STAT_${si + 1}_VALUE}}`, stat.value));
        fillRequests.push(scoped(`{{STAT_${si + 1}_LABEL}}`, stat.label));
      });
    } else if (s.layout === 'CHART') {
      fillRequests.push(scoped('{{TAKEAWAY}}', s.takeaway));
    } else if (s.layout === 'IMAGE') {
      fillRequests.push(scoped('{{CAPTION}}', s.caption));
    }
  });
  if (fillRequests.length > 0) await googleService.batchUpdatePresentation(creds, { presentationId, requests: fillRequests });

  // ③ 表紙と画像・グラフのスライドに、画像とグラフを入れる。どれも枠の位置を読む必要があるので、
  // 1回の getPresentation でまとめて取る
  const apiKey = creds?.gemini?.api_key;
  // 画像のモデル（管理画面の接続設定の image_model が既定値より優先）は image ティアが決める
  const imageModel = resolveModel('image', { creds });
  const chartSlideIndexes = slides.map((s, i) => (s.layout === 'CHART' ? i : -1)).filter(i => i >= 0);
  const imageSlideIndexes = slides.map((s, i) => (s.layout === 'IMAGE' ? i : -1)).filter(i => i >= 0);
  const needsPlaceholderLookup = chartSlideIndexes.length > 0 || imageSlideIndexes.length > 0 || (titleSlideId && plan.coverImagePrompt);
  if (needsPlaceholderLookup) {
    const got = await googleService.getPresentation(creds, {
      presentationId,
      fields: 'slides(objectId,pageElements(objectId,size,transform,description))',
    });

    // 表紙の画像
    if (titleSlideId && plan.coverImagePrompt && apiKey) {
      const titleSlideData = (got.slides || []).find(sl => sl.objectId === titleSlideId);
      const coverArea = (titleSlideData?.pageElements || []).find(pe => pe.description === 'COVER_IMAGE_AREA');
      if (coverArea) {
        try {
          // 表紙の画像の枠は縦長（およそ 0.71:1）なので、使える比率で一番近い 3:4 にする
          const img = await _generateSlideImage({ apiKey, prompt: plan.coverImagePrompt, aspectRatio: '3:4', imageModel, activitySessionId });
          if (img) {
            // 使用量の記録（llm_image）は llm-client の generateImage で済んでいる
            const imageUrl = await _uploadSlideImage(creds, { name: `${deckTitle} - cover`, imageBase64: img.imageBase64, mimeType: img.mimeType });
            await _replacePlaceholderWithImage(creds, { presentationId, slideId: titleSlideId, placeholderElement: coverArea, imageUrl });
          }
        } catch (e) {
          getLogger().warn(`[Secretary] 表紙画像の生成に失敗（本文のみで続行）: ${e.message}`);
        }
      }
    }

    // 画像のスライド
    for (const i of imageSlideIndexes) {
      const s = slides[i];
      const slideId = newSlideIds[i];
      if (!s.imagePrompt || !apiKey) continue;
      const slideData = (got.slides || []).find(sl => sl.objectId === slideId);
      const imageArea = (slideData?.pageElements || []).find(pe => pe.description === 'IMAGE_AREA');
      if (!imageArea) continue;
      try {
        // 画像のスライドの枠は横長（2:1）なので、使える比率で一番近い 16:9 にする
        const img = await _generateSlideImage({ apiKey, prompt: s.imagePrompt, aspectRatio: '16:9', imageModel, activitySessionId });
        if (img) {
            // 使用量の記録（llm_image）は llm-client の generateImage で済んでいる
          const imageUrl = await _uploadSlideImage(creds, { name: `${deckTitle} - ${s.title}`, imageBase64: img.imageBase64, mimeType: img.mimeType });
          await _replacePlaceholderWithImage(creds, { presentationId, slideId, placeholderElement: imageArea, imageUrl });
        }
      } catch (e) {
        getLogger().warn(`[Secretary] スライド画像の生成に失敗（キャプションのみで続行）: ${e.message}`);
      }
    }

    // グラフのスライド（データを書いた Sheets を作り、そのグラフをリンクして貼る）
    for (const i of chartSlideIndexes) {
      const s = slides[i];
      const slideId = newSlideIds[i];
      const slideData = (got.slides || []).find(sl => sl.objectId === slideId);
      const chartArea = (slideData?.pageElements || []).find(pe => pe.description === 'CHART_AREA');
      if (!chartArea || !s.chartCategories?.length || !s.chartSeries?.length) continue;

      const sheet = await googleService.createSpreadsheet(creds, { title: `${deckTitle} - ${s.title}` });
      const sheetId = sheet.sheets?.[0]?.properties?.sheetId ?? 0;
      const values = buildChartValues({ categories: s.chartCategories, series: s.chartSeries, chartType: s.chartType });
      await googleService.writeSpreadsheetValues(creds, { spreadsheetId: sheet.spreadsheetId, range: 'Data!A1', values });
      const chartSpec = buildChartSpec({ sheetId, title: s.title, chartType: s.chartType, categories: s.chartCategories, series: s.chartSeries });
      const chartId = await googleService.addSheetsChart(creds, { spreadsheetId: sheet.spreadsheetId, sheetId, chartSpec });

      // BUGFIX: 実際の表示の大きさ（size×scale）を計算し、scale=1 で渡す。枠の四角の size と transform を
      // そのまま渡すと、グラフは内部の基準の大きさが四角と違うため、縦につぶれて表示された
      const effectiveWidthEmu = Math.round(chartArea.size.width.magnitude * (chartArea.transform.scaleX ?? 1));
      const effectiveHeightEmu = Math.round(chartArea.size.height.magnitude * (chartArea.transform.scaleY ?? 1));

      await googleService.batchUpdatePresentation(creds, {
        presentationId,
        requests: [
          { deleteObject: { objectId: chartArea.objectId } },
          {
            createSheetsChart: {
              spreadsheetId: sheet.spreadsheetId,
              chartId,
              linkingMode: 'LINKED',
              elementProperties: {
                pageObjectId: slideId,
                size: {
                  width: { magnitude: effectiveWidthEmu, unit: 'EMU' },
                  height: { magnitude: effectiveHeightEmu, unit: 'EMU' },
                },
                transform: {
                  scaleX: 1, scaleY: 1,
                  translateX: chartArea.transform.translateX ?? 0,
                  translateY: chartArea.transform.translateY ?? 0,
                  unit: 'EMU',
                },
              },
            },
          },
        ],
      });
    }
  }

  // ④ テンプレートから来た見本のスライド（6枚）を消す
  await googleService.batchUpdatePresentation(creds, {
    presentationId,
    requests: Object.values(LAYOUT_SLIDE_IDS).map(id => ({ deleteObject: { objectId: id } })),
  });

  return { presentationId, webViewLink: dup.webViewLink };
}

/**
 * 声の側へ渡すために、Markdown の記号（見出し・強調・斜体・箇条書き・区切り線・コード）を落とす。
 *
 * スライド作成のヘルパーの報告は Markdown で返ることがある。画面にはそのまま出し、声の側だけ記号を落とす
 * （読み上げると記号まで読んでしまうため。secretary-helper-agent.js の _toSpeechSafeText と同じ考え方）。
 *
 * @param {string} text 報告の文
 * @returns {string} 記号を落とした文
 */
function _toPlainText(text) {
  if (!text) return '';
  return String(text)
    .replace(/^#{1,6}\s*/gm, '')          // 見出し記号
    .replace(/\*\*(.+?)\*\*/g, '$1')     // 強調
    .replace(/(^|\s)\*(?!\*)([^*\n]+)\*/g, '$1$2') // 斜体
    .replace(/^\s*[-*+]\s+/gm, '')        // 箇条書き記号
    .replace(/^\s*---+\s*$/gm, '')        // 区切り線
    .replace(/`([^`]+)`/g, '$1')           // インラインコード
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ツール名ごとの処理。引数は (args, ctx)。 */
const TOOL_HANDLERS = {
  create_presentation: async (args, ctx) => {
    const { creds, activitySessionId } = ctx;
    const { topic, project } = args || {};
    const apiKey = creds?.gemini?.api_key;
    if (!apiKey) return { error: 'Gemini APIキーが設定されていません。' };
    if (!TEMPLATE_PRESENTATION_ID) {
      return { error: 'プレゼンテーションのテンプレートがまだ設定されていません。' };
    }
    if (!topic) return { error: 'テーマを指定してください。' };

    // テンプレートが登録されていれば新しい方式で作る。無ければこの下の古い方式で作る（テンプレートは
    // リスナーが Slides の画面で用意するもので、無いと新しい方式は動けない）
    let chosen = presConfig.resolveTemplate(args?.template, ctx.config);
    if (chosen) {
      try {
        const brief = presConfig.buildBrief(args || {});
        // テンプレートの指定があればそれに従う（matchedBy='requested'）。指定が無く、候補が2つ以上のときだけ
        // AI に選ばせ、外すこともあるので選んだ理由を報告に添えさせる
        let templateReason = null;
        const candidates = presConfig.listTemplates(ctx.config);
        if (chosen.matchedBy !== 'requested' && candidates.length >= 2) {
          const picked = await chooseTemplateByAI({ apiKey, templates: candidates, topic, brief, activitySessionId });
          if (picked) {
            chosen = { ...candidates.find((t) => t.id === picked.id), matchedBy: 'ai' };
            templateReason = picked.reason;
          }
        }
        getLogger().info(`[Secretary] create_presentation: 新方式（テンプレート「${chosen.name}」/ ${chosen.matchedBy}）で作成します`);
        const out = await runPresentationJob({
          jobId: ctx.jobId || null,
          topic, brief, config: ctx.config, creds,
          template: { ...chosen, reason: templateReason },
        });
        // result は声の側へ渡るので、Markdown の記号を落とした文にする（画面の canvas は元のまま）
        return {
          result: `${_toPlainText(out.summary)}\n${out.webViewLink}`,
          url: out.webViewLink,
          canvas: out.summary,
          slideCount: out.slideCount,
        };
      } catch (e) {
        getLogger().warn(`[Secretary] 新方式での作成に失敗（旧方式へは切り替えません）: ${e.message}`);
        return { error: `プレゼンテーションの作成に失敗しました（${e.message}）` };
      }
    }

    try {
      const research = await _researchTopicForSlides({ apiKey, topic, activitySessionId });
      const { plan } = await _planSlidesFromResearch({
        apiKey, topic, researchText: research.text, activitySessionId,
      });

      const deckTitle = project ? `${plan.title || topic}（${project}）` : (plan.title || topic);
      const { webViewLink } = await buildPresentationFromPlan(creds, { plan, deckTitle, activitySessionId });

      const result = `「${deckTitle}」のプレゼンテーションを作成しました: ${webViewLink}`;
      return { result, url: webViewLink };
    } catch (e) {
      getLogger().warn(`[Secretary] create_presentation失敗: ${e.message}`);
      return { error: `プレゼンテーションの作成に失敗しました（${e.message}）` };
    }
  },
};

module.exports = { TOOL_DECLARATIONS, TOOL_HANDLERS, buildPresentationFromPlan };
