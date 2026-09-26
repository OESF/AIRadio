# スライド生成の拡張ガイド

`create_presentation`（Secretaryへ「この件をリサーチしてスライドにまとめて」と依頼すると
Google Slidesのデッキが出来上がる機能）を、どこをどう触れば変えられるのかをまとめたもの。

> **⚠️ この文書は旧方式の解説です（2026-08-29 現在）**
>
> テンプレートを登録すると、**新方式（Presentation Creator）** で作られるようになり、
> 以下の手順は使いません。新方式では**コードを一切触らずに、Google Slidesの画面だけで**
> レイアウトを追加・変更できます。
>
> - 標準テンプレートを作る: `node server/build-standard-template.js`
> - 管理画面「My Secretary → スライドのテンプレート」でURLを登録する
> - 以降はSlidesの画面で自由に改造する（見本スライドを増やせばレイアウトが増える）
>
> 新方式の約束事は本文書末尾の「新方式のテンプレートの作り方」を参照。
> テンプレートが1つも登録されていない間は、下記の旧方式で動きます。

デザインの**値**の正本は `server/data/presentation-design.md`。この文書はその使い方と、
`.md` だけでは変えられない部分の変更手順を扱う。

---

## 1. 全体像

登場するファイルは4つ。役割がはっきり分かれている。

| ファイル | 役割 | 何を決めているか |
|---|---|---|
| `server/data/presentation-design.md` | デザイン値の正本 | 配色9色・フォント3種 |
| `server/lib/presentation-design-tokens.js` | 上のfrontmatterを読むローダー | （値は持たない） |
| `server/setup-presentation-template.js` | テンプレートを組み立てる | **レイアウト・配置・文字サイズ・箇条書きの見た目** |
| `server/lib/secretary-tools-presentation.js` | 実行時の生成処理 | 何を調べ、何枚に分け、どのレイアウトを選ぶか |

### 生成されるまでの流れ

1. **リサーチ** — Google検索グラウンディング付きでテーマを調査（プレーンテキスト）
2. **構成** — 調査結果を `SLIDE_PLAN_SCHEMA` に沿ったJSONへ整形（4〜7枚、レイアウトを選択）
3. **複製** — Drive上のテンプレートデッキを丸ごとコピー
4. **差し込み** — 必要なレイアウトを複製し、`{{TITLE}}` 等のマーカーを実際の文字へ置換
5. **画像・グラフ** — 表紙とIMAGEは画像を都度生成、CHARTはSheetsを作ってリンク貼り付け
6. **後片付け** — テンプレート由来のレイアウト6枚を削除

所要 実測1〜2分。**LLMに座標やデザインを考えさせていない**のが要点で、これが「生成のたびに
見た目がばらつく」問題を防いでいる。裏を返すと、**見た目を変えたければテンプレート側を
直すしかない**。

---

## 2. テンプレートはどこにあるか

**Google Drive上の実ファイル**。ローカルには存在しない。

- 実体: 三浦さんのGoogle Driveにある「AI Radio Presentation Template」というSlidesファイル
- ID: `secretary-tools-presentation.js` の `TEMPLATE_PRESENTATION_ID` 定数が指している
- 中身: 6枚のスライド（`layout_title` / `layout_bullet` / `layout_comparison` /
  `layout_kpi` / `layout_chart` / `layout_image`）が「レイアウトの見本帳」として並んでいる

このファイルは `node server/setup-presentation-template.js` が**毎回まっさらに作り直す**。
Slides UIで手編集しても構わないが、次に再構築すると消える（＝手編集は再現できない）ため、
恒久的な変更は必ずスクリプト側へ書く。

> **絶対に変えてはいけないもの**（実行時の動作根拠になっている）
> - マーカー文字列 `{{TITLE}}` `{{BODY}}` `{{SUBTITLE}}` `{{COMPARE_*}}` `{{STAT_n_*}}` `{{TAKEAWAY}}` `{{CAPTION}}`
> - alt-text `CHART_AREA` / `IMAGE_AREA` / `COVER_IMAGE_AREA`
> - スライドID `layout_*`

---

## 3. どこで何が変えられるか（早見表）

**ここが一番の要点。`.md` で変えられるのは配色とフォントだけ。**

| 変えたいもの | 変更する場所 | コードの知識 |
|---|---|---|
| 配色（背景・アクセント・グラフの色） | `presentation-design.md` のfrontmatter | 不要 |
| フォント（見出し・本文・等幅） | 同上 | 不要 |
| **箇条書きの見た目** | `setup-presentation-template.js` | 少し必要 |
| 文字サイズ | 同上 | 少し必要 |
| 要素の位置・大きさ | 同上 | 少し必要 |
| 罫線・円形モチーフの形 | 同上 | 少し必要 |
| **新しいレイアウトの追加** | スクリプト＋実行時処理の両方 | 必要 |
| スライドの枚数・構成の方針 | `secretary-tools-presentation.js` のプロンプト | 少し必要 |
| グラフの種類の選び方 | 同上 | 少し必要 |

### 効いていない設定（注意）

`presentation-design.md` には、一見効きそうで**実際にはどこからも読まれていない**項目がある。
書き換えても何も起きないので、値を信用しないこと。

| 項目 | 実態 |
|---|---|
| `typography.min_title_pt` / `min_body_pt` | ローダーは読むが、使う側がいない。文字サイズは全て `setup-presentation-template.js` に直書き（36/32/30/22/20/18/16/44pt） |
| `x_layout.max_bullet_lines` | 同上。実際の6行制限は構成プロンプトの文面が効かせている |
| `x_chart_rules.*`（`max_series` ほか5項目） | 全て未参照。系列数2の上限も色の割り当ても `secretary-tools-presentation.js` に直書き |

つまり現状、frontmatterで**本当に効くのは `colors`（9色）と `typography.heading/body/mono`
（3種）だけ**。他は人間向けの設計メモとして残っている状態。

---

## 4. 手順集

### 4-1. 配色・フォントを変える（コード不要）

`server/data/presentation-design.md` のfrontmatterを書き換える。

```yaml
colors:
  accent: "#9d4edd"      # ← ここを変える
typography:
  heading: "Orbitron"    # ← Google Fontsにある名前
```

反映するには、テンプレートを作り直す。

```bash
node server/setup-presentation-template.js
```

スクリプトが `TEMPLATE_PRESENTATION_ID` も自動で書き換えるので、IDを手でコピペする必要はない。
サーバー起動中なら再起動する。

フォント名は**Google Slidesが認識できる名前**でなければ既定フォントに落ちる。Google Fontsに
ある名前を正確に書くこと。日本語を含むスライドなら、日本語グリフを持つフォント（Noto Sans JP、
M PLUS 1p など）でないと本文が置き換わらない点に注意。

### 4-2. 箇条書きをかっこよくする

ご質問の直球の答え。**テンプレート側の1行を書き換える。**

`server/setup-presentation-template.js` の `buildBulletLayout()`：

```javascript
reqs.push({
  createParagraphBullets: {
    objectId: `${slideId}_body`,
    textRange: { type: 'ALL' },
    bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',   // ← ここ
  },
});
```

Slides APIが用意しているプリセットは15種類。

**記号系**

| プリセット | 1階層目のグリフ |
|---|---|
| `BULLET_DISC_CIRCLE_SQUARE` | ●（現在の設定） |
| `BULLET_DIAMONDX_ARROW3D_SQUARE` | ◆に×印 |
| `BULLET_CHECKBOX` | チェックボックス（全階層） |
| `BULLET_ARROW_DIAMOND_DISC` | 矢印 |
| `BULLET_STAR_CIRCLE_SQUARE` | 星 |
| `BULLET_ARROW3D_CIRCLE_SQUARE` | 立体矢印 |
| `BULLET_LEFTTRIANGLE_DIAMOND_DISC` | 左向き三角 |
| `BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE` | ◆に×印 |
| `BULLET_DIAMOND_CIRCLE_SQUARE` | ◆ |

**番号系**

`NUMBERED_DIGIT_ALPHA_ROMAN` / `NUMBERED_DIGIT_ALPHA_ROMAN_PARENS` /
`NUMBERED_DIGIT_NESTED` / `NUMBERED_UPPERALPHA_ALPHA_ROMAN` /
`NUMBERED_UPPERROMAN_UPPERALPHA_DIGIT` / `NUMBERED_ZERODIGIT_ALPHA_ROMAN`

書き換えたら 4-1 と同じくスクリプトを再実行する。

**プリセットで足りない場合**は、`createParagraphBullets` をやめて自前で作る手もある。
たとえばアクセント色の小さな四角を各行の左に置く、行間を広げて1行ずつカード状の帯を敷く、
といった表現は「箇条書き機能」ではなく図形とテキストボックスの組み合わせで作ることになる。
その場合は 4-4 の新レイアウト追加に近い作業量になる。

### 4-3. 文字サイズ・位置を変える

`setup-presentation-template.js` の各 `buildXxxLayout()` 内で、`textBox()` に渡している
引数を書き換える。

```javascript
...textBox(`${slideId}_body`, slideId,
  { x: 0.7, y: 1.7, w: 8.6, h: 3.5 },   // ← 位置と大きさ（インチ）
  '{{BODY}}',
  { fontFamily: FONTS.body, fontSizePt: 20, colorHex: COLORS.lightInk }),  // ← 見た目
```

- 座標系はインチ。スライド全体は 10 × 5.625 インチ（16:9）
- `x`/`y` は左上が原点
- 内部ではEMU（1インチ = 914400）に変換される

配置を変えたら、必ず `node server/test-create-presentation.js` で目視確認する（後述）。

### 4-4. 新しいレイアウトを追加する

たとえば「引用」「タイムライン」「3カラム」といったレイアウトを増やす場合、
**7か所**を揃えて直す必要がある。1つでも漏れると、生成時に静かに別のレイアウトへ
フォールバックする（`LAYOUT_SLIDE_IDS[s.layout] || LAYOUT_SLIDE_IDS.BULLET`）。

**① テンプレート側** — `setup-presentation-template.js`

```javascript
function buildQuoteLayout() {
  const slideId = 'layout_quote';          // layout_ で始めること
  const reqs = [
    { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    setBackground(slideId, COLORS.darkBg),
    ...textBox(`${slideId}_quote`, slideId, { x: 1.0, y: 1.8, w: 8.0, h: 2.0 }, '{{QUOTE}}', {
      fontFamily: FONTS.heading, fontSizePt: 28, colorHex: '#ffffff', bold: true,
    }),
    ...textBox(`${slideId}_source`, slideId, { x: 1.0, y: 3.9, w: 8.0, h: 0.5 }, '{{QUOTE_SOURCE}}', {
      fontFamily: FONTS.mono, fontSizePt: 14, colorHex: '#c9c9d4',
    }),
  ];
  return { slideId, reqs };
}
```

**② 同ファイルの `main()`** — `layouts` 配列に `buildQuoteLayout()` を足す

**③ レイアウトID表** — `secretary-tools-presentation.js` の `LAYOUT_SLIDE_IDS` に
`QUOTE: 'layout_quote'` を追加（後片付けの削除処理はこの表を見ているので、ここに足せば自動で消える）

**④ スキーマ** — `SLIDE_PLAN_SCHEMA` の `layout` の `enum` に `'QUOTE'` を追加し、
必要なフィールド（`quote`、`quoteSource`）を `properties` に足す

**⑤ 構成プロンプト** — `_planSlidesFromResearch` の `systemInstruction` に
「印象的な発言・引用があればQUOTEレイアウトを使う」のような一文を足す。
**ここを書かないとモデルは新レイアウトを一度も選ばない。**

**⑥ 差し込み処理** — `buildPresentationFromPlan` の分岐に追加

```javascript
} else if (s.layout === 'QUOTE') {
  fillRequests.push(scoped('{{QUOTE}}', s.quote));
  fillRequests.push(scoped('{{QUOTE_SOURCE}}', s.quoteSource));
}
```

**⑦ 設計文書** — `presentation-design.md` の `## Components` に1行足す

最後にテンプレートを再構築し、検証スクリプトにダミーを1枚足して目視確認する。

画像やグラフの枠を持つレイアウトにする場合は、上記に加えて
`updatePageElementAltText` で目印を付け、実行時に
`_replacePlaceholderWithImage` を呼ぶ処理も要る（`buildImageLayout` と
`buildPresentationFromPlan` のIMAGE処理が手本になる）。

### 4-5. 構成の方針を変える（枚数・グラフの選び方）

`secretary-tools-presentation.js` の `_planSlidesFromResearch` にある
`systemInstruction` が、スライドの枚数・レイアウトの選び方・文字数上限を決めている。
「もっと図を多く」「箇条書きは4行まで」といった調整はここ。

枚数上限を増やすときは `SLIDE_PLAN_SCHEMA` の `maxItems: 7` と
`maxOutputTokens` も一緒に上げる必要がある。出力が上限に当たるとJSONが文字列の
途中で切れ、`Unterminated string in JSON` で失敗する（過去に3回再発している）。

---

## 5. 変更の確認方法

テンプレートを触ったら、必ずこれで確認する。

```bash
node server/test-create-presentation.js
```

Geminiのリサーチ・構成生成を経由せず、ハードコードしたダミー構成で全レイアウトを1枚ずつ
生成する。出力されたリンクを開いて、次を目で見る。

- `{{...}}` の置換漏れが無いか
- テンプレート由来のレイアウト6枚が消えているか
- 箇条書きが実際にリスト表示になっているか
- グラフをクリックして「ソースを開く」が出るか（＝リンクが生きている）
- 画像が枠いっぱいに入っているか（余白だらけなら縦横比の指定を直す）

新レイアウトを足したときは、このスクリプトの `DUMMY_PLAN.slides` にもその1枚を追加する。

---

## 6. 制約として知っておくこと

- **グラデーションは塗れない** — Slides APIの公開APIがサポートしていない。隅の淡いグローは
  低透明度（12%）の円形シェイプで代用している
- **円グラフの色は指定できない** — `pieChart` にはスライスごとの色指定手段が無く、Sheetsの
  既定パレットになる。他のグラフは指定どおりの配色になる
- **グラフの系列は2本まで** — コードで `.slice(0, 2)` している
- **要素の種類で内部の基準寸法が違う** — 矩形の `size`/`transform` をそのまま
  `createSheetsChart` に渡すとグラフが縦につぶれる。実寸（size × scale）を計算して
  `scale: 1` で渡す形にしてある。新しい埋め込み要素を足すときも同じ扱いが要る
- **画像は都度生成** — テンプレートに焼き込まれていない。表紙は3:4、IMAGEは16:9で生成し、
  Driveへ上げて「リンクを知っている全員が閲覧可」にしてから埋め込む（Slidesが匿名で
  取りに行くため）

---

## 7. まとめ

- **色とフォントだけ変えたい** → `presentation-design.md` を書き換えてスクリプト再実行
- **箇条書きの見た目を変えたい** → `setup-presentation-template.js` の
  `bulletPreset` を書き換えてスクリプト再実行
- **レイアウトを増やしたい** → 4-4 の7か所を揃えて直す
- **どこを直しても** → `node server/setup-presentation-template.js` →
  `node server/test-create-presentation.js` で目視確認 → サーバー再起動


---

## 新方式のテンプレートの作り方（2026-08-29〜）

新方式では、レイアウトは**ユーザーがGoogle Slidesの画面で作る資産**になる。
コードはその中身を一切知らず、その場で読み取って流し込むだけ。
**レイアウトを増やしてもコードは1行も変わらない。**

### 出発点を作る

```bash
node server/build-standard-template.js
```

10種類の見本スライド（表紙・章扉・箇条書き・3カード比較・左右対比・グラフと結論・
画像と説明・フロー図・大きな数字・引用）を持つテンプレートが作られる。
出力されたURLを管理画面「My Secretary → スライドのテンプレート」で登録する。

このスクリプトは**一度だけ**動かすもの。以降はSlidesの画面で自由に改造してよく、
再実行すると別ファイルが新規に作られる。

### 約束事は4つだけ

| やりたいこと | 書き方 |
|---|---|
| レイアウトを増やす | 見本スライドを1枚足す |
| レイアウトに名前を付ける | 画面外（負の座標）に `{{LAYOUT_NAME:3カード比較}}` |
| 文字を差し込む場所 | `{{見出し}}` のように書いたテキストボックス |
| 図・グラフの場所 | `{{CHART}}` / `{{IMAGE}}` |
| ロゴ・フッター・背景 | マスターに置く（全スライドが自動継承） |
| デッキ全体で1回だけ差し替える値 | マスターに `{{会社名}}` のように書く |

レイアウト名はAIが使い分ける手がかりになるので、内容が分かる名前を付ける。
画面外に置いた要素は描画されず、生成時に自動で消える。

### なぜ「見本スライド」なのか（Slides APIの制約）

Google Slidesの「レイアウト」機能を使う方が筋が良さそうに見えるが、実測で3つの壁に当たった。

1. **レイアウト名をAPIで変更できない**（`updateLayoutProperties` が存在しない）
2. **プレースホルダーを新規に作れない**（Slidesの画面でしか作れない）
3. **レイアウト上の `{{変数}}` はスライド単位で置換できない** — レイアウトのテキストは
   スライドへ継承表示されているだけで実体が無いため、`replaceAllText` をスライドに
   絞ると1件も一致しない。実際にカード3枚のレイアウトを作って試すと、意匠は完璧に
   出たのに文字が `{{カード1数値}}` のまま残った

スライドを複製すると各要素が実体としてコピーされるため、3つとも解決する。
旧実装がスライドをレイアウト代わりに使っていたのは、この制約への正しい回避策だった。

### 既定値の置き場所

目的・想定読者・枚数・トーン、余白・図解の方針は
`server/data/presentation-design.md` の `content_defaults` / `design_defaults`。
会話で「経営層向けに10枚でフォーマルに」と言えば、その回だけ上書きされる。

テンプレートの一覧だけは `config.json` 側（管理画面から編集するため。
`.md` へ書き戻すと解説コメントが失われてしまう）。
