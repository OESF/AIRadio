---
name: "AI Radio Presentation"
version: "0.3"
description: "create_presentationツールが生成するGoogle Slidesデッキのデザインシステム"
colors:
  dark_bg: "#14141a"
  dark_surface: "#232330"
  light_bg: "#f5f4f8"
  light_ink: "#1c1c1c"
  accent: "#9d4edd"
  chart_secondary: "#00b4d8"
  success: "#06d6a0"
  danger: "#ef476f"
  gridline: "#d9d9de"
typography:
  heading: "Orbitron"
  body: "Inter"
  mono: "Roboto Mono"
  # 【注意・2026-08-29】min_title_pt / min_body_pt は現状どこからも参照されていない。
  # ローダー（presentation-design-tokens.js）はSIZESとして読み出しているが、その
  # SIZES自体を使うコードが無く、実際の文字サイズは setup-presentation-template.js に
  # 直書きされている（36/32/30/22/20/18/16/44pt）。ここを書き換えても何も変わらない。
  # 人間向けの設計方針（この値を下回らせない）としてのみ機能している。
  min_title_pt: 40
  min_body_pt: 18
# ── ここから下（x_で始まるキー）はGoogle公式DESIGN.md仕様（colors/typography/rounded/
# spacing/components等）には存在しない、プレゼンテーション固有の拡張。仕様書自身が
# 「未知のトークンは警告付きで受け入れる」拡張性を明言しているため、公式キーと
# 混在させず、拡張であることが一目で分かるようx_プレフィックスを付けている。
# 【注意・2026-08-29】以下のx_キーも現状どこからも参照されていない（人間向けの設計方針
# としてのみ機能している）。系列数の上限2も、主系列＝accent・副系列＝chart_secondaryの
# 割り当ても secretary-tools-presentation.js の _buildChartSpec に直書きされており、
# max_bullet_lines の6行制限は _planSlidesFromResearch のプロンプト文面が効かせている。
# ここを書き換えても出力は変わらない。実際に効くのは colors（9色）と
# typography.heading/body/mono（3種）だけ。
# 変更手順の全体像は docs/presentation-guide.md を参照。
x_chart_rules:
  max_series: 2
  primary_series: "accent"       # colors.accentを使う
  secondary_series: "chart_secondary" # colors.chart_secondaryを使う
  positive_delta_color: "success"
  negative_delta_color: "danger"
x_layout:
  max_bullet_lines: 6

# ═══════════════════════════════════════════════════════════════════
# 【2026-08-29追加】ここから下は Presentation Creator（新方式）が読む設定。
# 上のcolors/typographyは旧create_presentationが使う値で、今後テンプレート側へ
# 役割が移るが、旧方式が動いている間は残しておく（両者は共存している）。
#
# 新方式では **レイアウトはコードではなくユーザーがSlidesの画面で作る資産** であり、
# このファイルは「プロンプトの既定値の入れ物」になる。指示が無いときに使われる値を
# ここへ書いておき、その回の依頼で上書きできる。
# ═══════════════════════════════════════════════════════════════════

# 使うテンプレート（ユーザーがGoogle Slidesで作ったファイル）。
# 「マスターAで作って」のように会話で指定でき、指定が無ければAIがdescriptionを見て選ぶ。
# confidential: internal=リスナー情報を使う / external=個人情報を一切読み込まない
#   （資産データや家族の話が社外資料に紛れる事故を、AIの判断ではなく仕組みで止めるため）
default_template: ""
templates: []
#  例:
#  - id: "standard"
#    presentation_id: "1AbC..."
#    name: "標準"
#    description: "汎用。社内共有・自分用の資料"
#    confidential: "internal"
#  - id: "corporate"
#    presentation_id: "1XyZ..."
#    name: "社外提案用"
#    description: "コーポレートカラーの青基調。ロゴ・機密表記入り"
#    confidential: "external"

# ── 基本プロンプトの既定値（何のための資料か）──────────────────
content_defaults:
  purpose: "テーマの要点を分かりやすく共有する資料"
  audience: "予備知識のない一般の読み手"
  slides: "5〜7"
  tone: "落ち着いた説明調。誇張しない"

# ── デザインプロンプトの既定値（どう見せるか）──────────────────
# colors/fonts の「テンプレートに従う」はそのままにしておけば一切上書きしない。
# 色名やフォント名を書いた場合だけ、その回のデッキ全体へ適用される。
# それ以外の項目はAIへの指示としてそのままプロンプトに入る（コードは解釈しない）。
design_defaults:
  colors: "テンプレートに従う"
  fonts: "テンプレートに従う"
  layout: "1スライドの要点は3つまで。1行は40字を目安に収める"
  diagrams: "手順・工程はフロー図、数値の比較は棒グラフ、構成比は円グラフ、時系列は折れ線"
  whitespace: "余白を十分に取り、詰め込まない。迷ったら情報を減らす"
  notes: "各スライドに発表者用のメモを付ける。話す順序と想定質問を含める"

# ── 日本語のフォント名 → 実フォント名 ──────────────────────────
# 【重要】Slidesは知らないフォント名を渡しても警告なく既定へ落ちる（実測確認済み。
# 存在しない名前を指定したスライドが、それらしい明朝体で描画され見分けが付かなかった）。
# そのため表に無い名前は使わず、指定が解決できない場合はテンプレートの書式のままにする。
font_aliases:
  ゴシック体: "Noto Sans JP"
  ゴシック: "Noto Sans JP"
  明朝体: "Noto Serif JP"
  明朝: "Noto Serif JP"
  丸ゴシック: "Kosugi Maru"
  太ゴシック: "M PLUS 1p"
---

# AI Radio — Presentation DESIGN.md（v0.2）

Secretaryの`create_presentation`ツールが生成するGoogle Slidesデッキの、唯一のデザイン正本。

Google Labsが公開している[design.md仕様](https://github.com/google-labs-code/design.md)
（`name`必須、YAML frontmatterに`colors`/`typography`等の機械可読トークン、本文はh2見出し
8種）にできる限り準拠している。本家はWeb/UI向けの仕様であり、プレゼンテーション用の
公式な派生仕様は存在しない（SlideSpeak社が非公式に同種の試みを公開しているが、
そちらはYAML frontmatterを持たない散文形式のプロンプト集であり、コードから値を
機械的に読み取る用途には使えない——このためGoogle公式仕様の構造を優先した）。
本家の8見出しのうちプレゼンには意味を持たないものは無く、全て以下のように意味を
持たせている。Googleの仕様では表現しきれない項目（グラフの配色ルール等）だけを、
`x_`で始まる拡張キー・専用セクションとして明示的に分離している。

`server/lib/presentation-design-tokens.js`がこのファイルのfrontmatterを直接読み込み
（`gray-matter`で解析）、`setup-presentation-template.js`（テンプレート構築）と
`secretary-tools-presentation.js`（グラフの配色）の両方がその値を使う。**つまりこの
ファイルのfrontmatterを直接書き換えるだけで、コードを一切触らずに配色・フォントを
変更できる。**

ただし**コードから実際に読まれているのは`colors`（9色）と`typography.heading`/`body`/`mono`
（3種）だけ**である。`min_title_pt`/`min_body_pt`・`x_chart_rules`・`x_layout`は人間向けの
設計方針として書かれているだけで、書き換えても出力は変わらない（各項目のコメント参照）。
箇条書きの見た目・文字サイズ・要素の配置・レイアウトの追加といった構造的な変更は
`setup-presentation-template.js`側を直す必要がある。**その手順は
[`docs/presentation-guide.md`](../../docs/presentation-guide.md)にまとめてある。**

変更を反映するには以下を実行する（実在するGoogle Slidesファイルを書き換える都合上、
この手順自体は省略できない）。

```bash
node server/setup-presentation-template.js
```

このコマンドはテンプレートを新規に作り直し、`secretary-tools-presentation.js`の
`TEMPLATE_PRESENTATION_ID`定数も自動的に書き換える。サーバーが起動中であれば
再起動して読み込み直すこと。

## Overview

配色・フォントはAI Radio自身のUI（`client/src/index.css`）から流用している。ゼロから
新しいブランドを作るのではなく、既にアプリ本体が持っている「ダークグラスモーフィズム＋
ネオン」の視覚言語をスライドにも適用するという判断による。

## Colors（`colors`）

1スライド内で背景は1種類のみ、混在させない。

- **ダーク**（`dark_bg`/`dark_surface`。タイトル・KPIスライド用。インパクト重視、文字量は少ない）
- **ライト**（`light_bg`/`light_ink`。本文・比較・グラフスライド用。印刷/PDF出力時の可読性を優先）

単一アクセントは`accent`（紫）。用途はタイトルの強調・KPIの数値・見出し下の罫線・グラフの
主系列。`chart_secondary`（シアン）は装飾用の第2ブランド色として扱わず、グラフの副系列専用
とする。1枚のスライドの中で両方を装飾として同時に使わない。`success`/`danger`は増減注釈
専用（下記Extensions参照）。

## Typography（`typography`）

- 見出し: `heading`（アプリ本体のh1〜h3・`.brand`と同じOrbitron）
- 本文: `body`（アプリ本体の本文と同じInter）
- データ・出典表記・スライド番号のみ: `mono`
- 本文は`min_body_pt`未満にしない、タイトルは`min_title_pt`未満にしない

## Layout

- 左揃えを基本とする（アプリ本体のUIと同じ）。中央揃えのブロックレイアウトは使わない
- 1枚の本文スライドに箇条書きを`x_layout.max_bullet_lines`行を超えて詰め込まない
- グラフを載せたスライドには必ず1行の結論文（本文フォント）を添える。グラフだけを置いて
  終わらせない

## Elevation & Depth

フラットデザイン。ドロップシャドウは使わない。奥行きの表現はShapes（下記）のグロー/
モチーフに任せる。

## Shapes

- 全スライド共通のシグネチャーモチーフ: タイトル直下に2pxの`accent`罫線
- 全スライド共通: 隅に低透明度のグラデーション風の円形シェイプ（ダークスライドは`accent`、
  ライトスライドは`chart_secondary`）。`index.css`のbody背景にある2つのラジアルグラデーションを
  再現したもの（Slides APIは真のグラデーション塗りをサポートしないため、低アルファの
  円形シェイプで代替している）

## Components

このデッキが持つ再利用可能な6種のスライドレイアウト（`setup-presentation-template.js`が
実体を構築する）:

- **TITLE** — 表紙。ダーク背景、大見出し＋サブタイトル＋右半分にテーマごとの生成画像
  （`x_image_generation`参照）
- **BULLET** — 箇条書き本文。ライト背景
- **COMPARISON** — 2項目の対比。中央に縦の区切り線
- **KPI** — 重要数値を3つまで並べる。ダーク背景
- **CHART** — グラフ＋1行の結論文。ライト背景
- **IMAGE** — テーマごとの生成画像＋1行のキャプション。ライト背景（`x_image_generation`参照）

## Do's and Don'ts

**Do**
- 配色・フォントは本ファイルのfrontmatterの値をそのまま使う
- 1つのアクセント色を一貫して使う
- グラフには必ず結論文を添える

**Don't**
- Google Slides標準テーマの配色・グラデーションを使わない
- ドロップシャドウを使わない
- クリップアート・ストック素材のアイコンセットを使わない
- 1スライドに装飾用アクセント色を2色以上使わない
- 中央揃えのブロックレイアウトを使わない

## Extensions（`x_`プレフィックス。Google公式仕様には無い、プレゼン固有の拡張）

Web/UI向けの本家仕様には「グラフ」という概念自体が存在しないため、以下はGoogleの
仕様では表現しきれない拡張として独立させている。

- `x_chart_rules.max_series`: グラフの系列数の上限（2）
- `x_chart_rules.primary_series`/`secondary_series`: どの色トークンをグラフのどの系列に
  割り当てるか（`colors`の値を参照する）
- `x_chart_rules.positive_delta_color`/`negative_delta_color`: プラス/マイナスの増減注釈
  専用の色（`colors.success`/`colors.danger`）。デフォルトの系列色としては使わない
- グラフのデータラベルは棒グラフなら棒の外側、折れ線なら点の上。塗りつぶし内部に文字を
  置かない
- グリッド線は`colors.gridline`（薄いグレー、低コントラスト）。黒の全濃度は使わない
- `x_layout.max_bullet_lines`: 1枚の本文スライドの箇条書き行数上限

### `x_image_generation`（生成のたびに毎回画像を作る。テンプレートへの焼き込みではない）

TITLE（表紙）とIMAGEレイアウトは、色・フォントのような固定トークンではなく、
**生成のたびにテーマに応じて新しい画像を作る**（Gemini画像生成モデルを使用、
`agent-system.js`の`_callGeminiWithImage`——レシピ写真生成で実運用中——と同じ方式）。
Web/UI向けの本家仕様には「AIが都度画像を生成する」という概念自体が無いため、これも
拡張として扱う。設定できるトークンは無く、`secretary-tools-presentation.js`内の
`_planSlidesFromResearch`のプロンプトが「どんな画像を作るか」をリサーチ内容から
都度判断する。
