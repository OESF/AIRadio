#!/usr/bin/env node
/**
 * @file プレゼンテーション作成（create_presentation）の、Google スライド連携部分だけを試す検証スクリプト
 *
 * 秘書の会話やリサーチ（Gemini の呼び出し）を通さず、secretary-tools-presentation.js の
 * buildPresentationFromPlan を、固定のダミーの構成（各レイアウト1枚とグラフ）で直接呼ぶ。
 *
 * 使い方: node server/test-create-presentation.js [<templatePresentationId>]
 *   （省略すると secretary-tools-presentation.js の TEMPLATE_PRESENTATION_ID を使う）
 *
 * 表示された URL を開いて、目で確かめること:
 *   - {{...}} の置き換え漏れが無いか
 *   - テンプレートのレイアウト見本が消え、作ったスライドだけになっているか
 *   - グラフがリンク付きで編集できるか（クリックして「ソースを開く」が出るか）
 *   - 箇条書きが箇条書きとして表示されているか（改行が段落に変わっているか）
 *
 * 読み込み元: data/credentials.json
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

const fs = require('fs');
const path = require('path');
const { buildPresentationFromPlan } = require('./lib/secretary-tools-presentation');

const CREDENTIALS_PATH = path.join(__dirname, 'data', 'credentials.json');

/** ダミーのスライド構成（BULLET・IMAGE・COMPARISON・KPI・CHART の各レイアウトと、円グラフ）。 */
const DUMMY_PLAN = {
  title: 'テストプレゼンテーション',
  subtitle: 'create_presentation機能の検証用',
  coverImagePrompt: '夜明けのラジオ放送スタジオ、紫とシアンのネオンに照らされた抽象的な音波の情景、フォトリアルで幻想的な雰囲気',
  slides: [
    {
      layout: 'BULLET',
      title: '概要',
      body: '検証項目1行目\n検証項目2行目\n検証項目3行目',
    },
    {
      layout: 'IMAGE',
      title: '画像スライドの検証',
      imagePrompt: '静かな山間の温泉旅館の露天風呂から見える紅葉、朝霧が立ち込める幻想的な情景、フォトリアル',
      caption: '生成された画像がここに入る想定。',
    },
    {
      layout: 'COMPARISON',
      title: '比較スライドの検証',
      compareLeftTitle: '案A',
      compareLeftBody: '案Aの説明文をここに入れる。',
      compareRightTitle: '案B',
      compareRightBody: '案Bの説明文をここに入れる。',
    },
    {
      layout: 'KPI',
      title: 'KPIスライドの検証',
      stats: [
        { value: '128%', label: '成長率' },
        { value: '3.2万', label: '利用者数' },
        { value: '92点', label: '満足度' },
      ],
    },
    {
      layout: 'CHART',
      title: 'グラフスライドの検証',
      chartType: 'COLUMN',
      chartCategories: ['4月', '5月', '6月', '7月'],
      chartSeries: [
        { name: '売上', values: [120, 135, 150, 180] },
        { name: '目標', values: [130, 130, 140, 160] },
      ],
      takeaway: '7月は目標を大きく上回った。',
    },
    {
      layout: 'CHART',
      title: '円グラフの検証（PIE）',
      chartType: 'PIE',
      chartCategories: ['A社', 'B社', 'C社', 'その他'],
      chartSeries: [
        { name: 'シェア', values: [40, 25, 20, 15] },
      ],
      takeaway: 'A社が最大シェアを占める。',
    },
  ],
};

async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const templateId = process.argv[2];

  console.log('プレゼンテーションを構築中...');
  const { webViewLink } = await buildPresentationFromPlan(creds, {
    plan: DUMMY_PLAN,
    deckTitle: DUMMY_PLAN.title,
    ...(templateId ? { templateId } : {}),
  });

  console.log('');
  console.log('完了しました。以下を開いて目視確認してください:');
  console.log(webViewLink);
}

main().catch((e) => {
  console.error('検証に失敗しました:', e.message);
  process.exit(1);
});
