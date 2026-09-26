# 私だけの AI Radio 🎙️ — v2.10.0

> **Special Thanks to Claude Sonnet 4.6** 🤖✨  
> このプロジェクトは、Anthropic の [Claude Sonnet 4.6](https://www.anthropic.com/claude) との共同開発によって実現しました。  
> アーキテクチャ設計・実装・デバッグ・ドキュメント作成にわたる全工程で、Claude の卓越した技術力と洞察が欠かせませんでした。  
> *— Masataka Miura*

---

パーソナライズされた AI マルチエージェント・ラジオ局。  
Gemini でセリフを生成し、Gemini TTS でキャラクターごとの声で喋り、リアルタイム天気・交通・ニュース・経済指標・Spotify 楽曲を交えながら番組を自律進行します。  
ブラウザ・スマートフォンなど WebSocket が使え、Spotify の SDK が実行できる端末なら受信できます。

プレイヤーには「💬 お問い合わせ・リクエスト」窓口（**AI Radio管理人**）を搭載。過去の番組記録・長期記憶をもとに放送内容に関する質問に答えるほか、チャンネル切り替え・音量調整・コーナーや曲のリクエストもテキスト入力ひとつで受け付けます。同日内の再接続では挨拶・メンバー紹介を省略した短縮オープニングで素早く再開します。

---

## 目次

1. [アーキテクチャ](#アーキテクチャ)
2. [エージェント構成](#エージェント構成)
3. [外部 API 連携](#外部-api-連携)
4. [ディレクトリ構成](#ディレクトリ構成)
5. [セットアップ](#セットアップ)
6. [設定ファイル](#設定ファイル)
7. [管理画面](#管理画面)
8. [システム監視ダッシュボード](#システム監視ダッシュボード)
9. [AI Radio管理人（お問い合わせ・リクエスト）](#ai-radio管理人お問い合わせリクエスト)
10. [My Secretary（会話型AI秘書）](#my-secretary会話型ai秘書)
11. [WebSocket イベント仕様](#websocket-イベント仕様)
12. [音声パイプライン](#音声パイプライン)
13. [オーディオミキサー構成](#オーディオミキサー構成)
14. [TTS 発音正規化](#tts-発音正規化)
15. [ログ](#ログ)
16. [リリースノート](#リリースノート)

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                         Node.js サーバー                         │
│                                                                 │
│  AgentSystem（トークンパッシング状態マシン）                       │
│   Director → Caster ⇄ Assistant → Corner → ...                  │
│        ↓ LLM抽象化層でセリフ生成（モデルはティア表で管理）        │
│        ↓ Google Search グラウンディング（交通・ジャーナリスト等）  │
│        ↓ Gemini TTS（演技タグ対応・失敗時 Google TTS）             │
│        ↓ 組み込み TTS 正規化 → 発音辞書（ユーザー定義）           │
│        ↓ 3ターン先読みパイプライン（最大41秒の先行生成）            │
│                                                                 │
│  AudioMixer（BGM + TTS ダッキング）                              │
│   BGM（MP3）＋ TTS（PCM）→ 24kHz / 24bit Stereo PCM             │
│   BGM シャッフル再生（同一曲の連続なし）                           │
│                                                                 │
│  外部 API（一次データ優先）                                       │
│   OpenWeatherMap / JMA（台風・警報・地震）                        │
│   Gemini Google Search / Yahoo News RSS                         │
│   Yahoo Finance（株価・為替）                                     │
│   IMF DataMapper / World Bank / FRED / e-Stat（経済指標）        │
│   Google Calendar / Gmail / Google Tasks                        │
│   Spotify Web API + Web Playback SDK（楽曲フル再生）             │
│   Spotify audio-features（テンポ・ムード・ジャンル情報）          │
└──────────────┬──────────────────────────────────────────────────┘
               │ WebSocket  ws://host:3001/stream         （Live チャンネル）
               │ WebSocket  ws://host:3001/stream-classic （Classic チャンネル）
               │ WebSocket  ws://host:3001/stream-jazz    （Jazz チャンネル）
               │ WebSocket  ws://host:3001/stream-mood    （Mood チャンネル）
               │ WebSocket  ws://host:3001/stream-beatles （Beatles チャンネル）
               │ WebSocket  ws://host:3001/stream-24you   （24/You チャンネル・PCM 音声なし）
               │ PCM 24kHz / 24bit / Stereo（バイナリ、24/You を除く）
               │
          ブラウザ UI
     (React + AudioWorklet)
```

---

## エージェント構成

| エージェント | キャラクター | 役割 |
|---|---|---|
| **森田（ディレクタ）** | パニックになりやすい愛すべきリーダー | コーナー編成判断（ゲスト構成・music_dj頻度・話題優先度をLLM判断。話題の分野と各出演者の専門分野・裏の顔を突き合わせて起用を決める。必須コーナー保証は引き続きコード担当・音声なし） |
| **Max（キャスター）** | 明るく元気・音楽好き | メイン MC・フリートーク・コーナー紹介 |
| **Clara（アシスタント）** | 礼儀正しいが時々毒舌 | Max のサポート・掛け合い |
| **たかいち なえ（気象情報）** | 途中から哲学的思考に落ち込む気象予報士 | 天気情報コーナー（JMA 台風・警報・地震付き） |
| **片山夏樹（交通情報）** | 渋滞情報を詩的に語るアナウンサー | 交通情報コーナー（Google Search グラウンディング） |
| **いけがみ あきらめ（報道センター）** | 感情ゼロのプロフェッショナル | ニュースコーナー（Google Search 必須グラウンディング） |
| **マブチ マリーナ（金融情報センター）** | 株価に異常なまでの詩的ロマンを感じるアナリスト | 株価・為替コーナー |
| **高橋洋二 教授（コメンテーター）** | 元財務省・経済学者・ユーモアもある大学教授 | 経済・政治・社会コメント（一次統計データ注入済み） |
| **謎のジャーナリスト X** | 素性不明・膨大な情報パイプを持つ独立系記者 | 最新 X 投稿・公式発表を独自角度で深掘り（Google Search） |
| **Steve（ワールドレポート特派員）** | 世界中を飛び回る神出鬼没な現地特派員 | 世界各地からの現地レポート（毎回異なる都市・Google Search） |
| **DJ サキ（音楽）** | 音楽全ジャンル精通の元気な DJ キャスター | Spotify フル再生・複数曲特集・リスナーの好みを反映した選曲 |
| **平野ドレミ（生活アドバイザー）** | 方言混じりで親しみやすい生活コーナー担当 | 地域情報・生活アドバイス・地元イベント（Google Search） |
| **北村昭雄 弁護士（法律相談）** | 歩く六法全書と呼ばれる辣腕弁護士 | 法律相談コーナー（刑事・民事・家族・労働・消費者問題、Google Search） |
| **難波亭 ボケ（お笑い芸人）** | 関西出身の大御所・庶民感覚で本質を突く人情家 | 世間ばなしコーナー（世の中の出来事を噛み砕く・素朴な疑問で本質を突く、Google Search）／討論コーナーにも起用 |
| **華院 麗子（医師）** | 元国会議員の開業医・上品だが言うべきことは言う | 健康・医療コーナー（医学的な整理／制度の建前と現場／実践できる具体策、Google Search）／討論コーナーにも起用 |
| **世界 創（マーケター）** | 企業再生と大規模な仕掛けで実績を残したマーケター | トレンド解析コーナー（何が人の心を動かしたかを読み解く、Google Search）／討論コーナーにも起用 |

### Classic チャンネル（静寂のスコア）エージェント

| エージェント | キー | 役割 | 備考 |
|---|---|---|---|
| **北野ひけし（ディレクター）** | `classic_director` | 楽曲選定・指揮者/演奏者推奨（Gemini） | 音声なし |
| **小澤征三（パーソナリティ）** | `classic_personality` | 楽曲紹介・演奏後コメント | Gemini TTS |

### Jazz チャンネル（琥珀色のインプロヴィゼーション）エージェント

| エージェント | キー | 役割 | 備考 |
|---|---|---|---|
| **Ellie（ディレクター）** | `jazz_director` | 楽曲選定・アーティスト推奨（Gemini）| 音声なし |
| **Louis（パーソナリティ）** | `jazz_personality` | 楽曲紹介・演奏後コメント（英語、日本語訳テロップ付き）| Gemini TTS |

### Mood チャンネル（トワイライト・ラウンジ）エージェント

| エージェント | キー | 役割 | 備考 |
|---|---|---|---|
| **佐藤智子（ディレクター）** | `mood_director` | 楽曲選定・進行指示（Gemini）| 音声なし |
| **ジョー匠（パーソナリティ）** | `mood_personality` | 楽曲紹介・演奏後コメント | Gemini TTS |

### Beatles チャンネル（Eight Days A Week）エージェント

| エージェント | キー | 役割 | 備考 |
|---|---|---|---|
| **湊洋子（ディレクター）** | `beatles_director` | 楽曲選定・進行指示（Gemini）| 音声なし |
| **ポール小野（パーソナリティ）** | `beatles_personality` | 楽曲紹介・演奏後コメント | Gemini TTS |

### コーナー確率制御

直前コーナーによって次コーナーの選択確率を動的に調整します。

| 直前コーナー | 次の選択傾向 |
|---|---|
| ニュース / 金融の後 | コメンテーター・ジャーナリストが優先（話題の文脈継続） |
| コメンテーターの後 | ジャーナリスト寄り |
| ジャーナリストの後 | コメンテーター寄り |
| 天気 / 交通の後 | ベース（特定コーナー優先なし） |

### 編成キューの永続化（放送日単位）

森田ディレクタが組んだコーナー編成キューは`server/data/director_queue_state.json`へ
放送日付きで保存され、サーバー再起動やリスナーの再接続をまたいで引き継がれる。

- **その日の最初の接続**でのみ新規に編成する（ニュースを先頭へ固定する「本日初回」判定もここで働く）
- **同じ日の2回目以降の接続**は、保存済みのキューを途中から引き継いで再開する
- **日付が変わる**と保存内容は破棄され、その日の最初の接続で改めて編成される
- キューを使い切った際にディレクタが自動で次サイクルを補充する挙動は従来どおり

保存のタイミングはキューから取り出した時ではなく、コーナーを**実際に流し終えた時**
（`_recordCornerPlayed`）。3ターン先読みパイプラインがコーナーを先に取り出すため、
取り出し時点で保存すると未再生のコーナーが消化済みとして失われてしまうため。
現在保存されている編成キューは[システム監視ダッシュボード](#システム監視ダッシュボード)で確認できる。

### 番組進行フロー

```
オープニングジングル
    ↓
Max 挨拶
    ↓
[ループ]
  Max（話題提示 → Clara に振る） ← ここで次コーナーの3ターン先読み開始
    ↓
  Clara（返答）                  ← 先読み継続中（最大41秒の先行生成窓）
    ↓
  Max（リアクション → コーナー紹介）← ここまでに先読みが完了していれば無音なし
    ↓
  コーナージングル（3秒）
    ↓
  コーナー（天気 / 交通 / ニュース / 金融 / コメンテーター /
            ジャーナリスト / Steve ワールドレポート / DJ サキ / 生活アドバイザー / 北村弁護士 法律相談）
    ↓
  討論コーナー（ニュースの後・複数ターン。出演者はディレクタ采配）← frequency=0 で無効化
    ↓
  ← 繰り返し ←
    ↓（約1時間後）
エンディングジングル
```

> **3ターン先読みパイプライン**  
> コーナー生成（特に Google Search を使う交通・ジャーナリストなど）は10〜30秒かかる場合がある。  
> `caster turn=0` の発話直前に次コーナーのデータ取得＋TTS を非同期で先行開始することで、  
> コーナー本番までに最大約41秒の生成窓を確保し、音声の無音区間を防いでいる。

---

## 外部 API 連携

### データ取得 API

| サービス | 用途 | APIキー設定先 | キャッシュ TTL |
|---|---|---|---|
| **Google Gemini** | セリフ生成・Google Search グラウンディング。使用モデルは `server/lib/llm-models.js` のティア表で一元管理する（用途ごとにティアを指定し、呼び出し側はモデル名を持たない） | `credentials.json` > `gemini.api_key` | なし |
| **Gemini TTS** | 音声合成（全チャンネル共通、失敗時は Google Translate TTS へフォールバック）。`server/lib/tts-client.js` 経由 | `credentials.json` > `gemini.api_key` | — |
| **OpenWeatherMap** | 天気データ | `credentials.json` > `openweathermap.api_key` | 20分 |
| **気象庁 JMA API** | 台風・気象警報・震度3以上の地震、週間天気予報（My Secretaryウィークリーノート用・7日先まで無料・認証不要） | 不要 | リアルタイム |
| **Yahoo Japan RSS** | ニュース（最大8件・複数フィード）| 不要・無料 | 20分 |
| **Google ニュース RSS（媒体指定）** | Live 報道センター・コメンテーターの「社説の読み比べ」。全国紙5紙＋東京新聞の**社説の見出しだけ**を `site:` クエリで集め（産経は「主張」）、同じテーマで論調が割れているときだけ材料として扱う（`server/services/media-compare-service.js` / `server/lib/editorial-compare.js`）。各社とも robots.txt で AI 系クローラを全面拒否しているため、本文・要約は取得しない | 不要・無料 | 30分 |
| **財務省 国債金利情報（CSV）** | 国債利回りの全期間＋当月の履歴。討論コーナーの数値シートとコメンテーターの定点観測シートが使う（`server/lib/market-data-kit.js`、Shift_JIS・和暦を解釈）| 不要・無料 | 6時間 |
| **TechCrunch AI / VentureBeat AI / MIT Technology Review RSS** | My Secretary: 海外のAI・テクノロジーニュース（`get_news` の `scope="world"`・ウィークリーノートの「今週のAI技術ニュース」）。日本語ソースの陳腐さを避けるため海外メディアから直接取得する | 不要・無料 | 20分 |
| **CNBC Economy / Finance RSS** | 海外マーケット情報（CPI・FRB・財務長官発言等）。デイリーノートは軽量モデルで日本語へ翻訳、放送の金融情報コーナーは原文のまま渡す | 不要・無料 | 20分 |
| **Yahoo Finance** | 株価・為替データ。投資信託（証券コードを持たない）は Yahoo!ファイナンス日本版の投信ページから投信協会コードで基準価額を取得（`_fetchFundQuote`、`finance_watchlist.personal_holdings`のkind:'fund'向け） | 不要・無料 | 10分 |
| **IMF DataMapper API** | GDP・インフレ率・失業率・財政収支・政府債務（年次）| 不要・無料 | 24h（日付変わりで自動更新） |
| **World Bank Open Data** | GDP・インフレ・失業率（補完用）| 不要・無料 | 24h |
| **FRED（セントルイス連銀）** | 米国 CPI・コア PCE・FF 金利・10年債利回り / 日本政策金利・JGB・外貨準備 | `credentials.json` > `fred.api_key` | 月次24h / 日次6h |
| **e-Stat（総務省統計局）** | 日本 CPI・コア CPI・コアコア CPI・エネルギー（月次）| `credentials.json` > `estat.api_key` | 24h |
| **Spotify Web API + Web Playback SDK** | 楽曲検索・フル再生（Premium 必須） | `credentials.json` > `spotify.*` | — |
| **Spotify audio-features** | 曲のテンポ・ムード・ジャンル・アルバム情報（MAX/Clara の感想品質向上）| 同上 | 再生時取得 |
| **Spotify Web API（My Secretary）** | 現在再生中・再生履歴・よく聴く曲・楽曲検索・保存済みの曲/プレイリストの確認、プレイリスト作成・曲追加（`server/services/spotify-user-service.js`、Live再生SDKとは別実装・実際の再生操作は不可） | 同上 | — |
| **Google Calendar / Gmail / Tasks / Drive / Sheets / Slides** | Live: スケジュール・メール・TODO 読み上げ（読み取りのみ） / My Secretary: 上記に加え予定作成・変更・削除・メール下書き作成・タスク追加・Driveファイル作成/更新（書き込み対応）、Googleスプレッドシートの読み取り分析・書き込み（`spreadsheets`、2026-08-26に読み取り専用から昇格）、Google Slidesプレゼンテーションの生成・編集（`presentations`、`create_presentation`） | `credentials.json` > `google.*` | 5分（Live） |
| **YouTube Data API v3（検索）** | My Secretary: キーワードでの動画検索・再生数順/新着順の並び替え（`search_youtube_videos`） | `credentials.json` > `youtube.api_key` | — |
| **YouTube Data API v3（登録チャンネル・OAuth）** | My Secretary: 登録チャンネルの新着動画確認（`get_new_subscription_videos`）。Googleの制約によりCalendar/Gmail等とは別の独立したOAuthフロー（`/callback/youtube`、Google Cloud Console側でリダイレクトURIの追加登録が必要） | `credentials.json` > `google.youtube_refresh_token`（管理画面「YouTubeでサインイン」から自動取得） | — |
| **YouTube 文字起こし（ブラウザ拡張）** | 実際に視聴した動画の字幕を取り込み、要約して蓄積（`server/lib/youtube-watch-store.js`）。公式APIの `captions.download` は自分が所有する動画しか対象にできないため、Tampermonkey がページ内の文字起こしパネルから取得して `POST /api/youtube-import` へ送る。資産取り込みと同じ共有トークン＋localhost限定 | `credentials.json` > `finance_import.token`（共用） | — |
| **holidays-jp API** | 日本の祝日判定（無料・認証不要）。東京市場の休業日判定に使う（`server/services/holiday-service.js`）。**米国市場（NYSE/Nasdaq）の休場日はAPIを使わず `server/services/market-calendar.js` がルール（第N月曜・復活祭・週末振替）で算出する**ため、取得失敗で判定不能にならない | 不要 | 24h |
| **LINE Messaging API** | My Secretary専用LINE公式アカウントとの1対1トーク。受信は`POST /line_webhook`（X-Line-Signature署名検証・userIdホワイトリスト照合）、送信はReply API（無料）優先・Push API（月200通まで無料）へフォールバック | `credentials.json` > `line.channel_access_token`（送信）・`line.channel_secret`（署名検証） | — |

### 天気コーナー（JMA 統合）

天気コーナーでは OpenWeatherMap に加え、気象庁の無料 API から以下のリアルタイム情報を取得してプロンプトに注入します。

| 情報 | API エンドポイント |
|---|---|
| 台風情報（予報進路） | `https://www.jma.go.jp/bosai/typhoon/data/lastestinfo.json` |
| 特別警報（全国・レベル5のみ） | `https://www.jma.go.jp/bosai/warning/data/warning/map.json`（48バイトの`map_time.json`で更新有無を先に確認し、変化が無ければ本体を取得しない） |
| 気象警報・注意報（居住地の都道府県） | `https://www.jma.go.jp/bosai/warning/data/warning/r8/{都道府県コード}.json`（令和8年の名称改定に伴い新設されたパス。旧パス`warning/data/warning/{code}.json`は2026-05-26/28で更新が止まっている） |
| 地震情報（最大震度3以上／津波警報・注意報あり／M6.0以上・直近24h）| `https://www.jma.go.jp/bosai/quake/data/list.json`（津波は各地震の詳細電文のForecastCommentと気象庁津波フィードの2経路で判定） |

#### 伝える時間帯をコード側で決める

現在時刻を未明／朝／日中／夕方／夜の5区分に分け、主役にすべき時間帯を明示して渡します
（`_buildWeatherFocusGuidance`）。「今日の残りと明日を伝えて」という曖昧な指示では、
21時台の放送で既に過ぎた今日の日中の天気を読み上げてしまうためです。

#### 助言は閾値の判定をコードが行う

「傘が必要なら伝えて」という指示だけでは、モデルが数値に気づくかどうか任せになります。
判定はコードが確実に行い、言葉にするのだけをモデルに任せる分担にしています
（`_buildWeatherAdvisories`）。判定するのは、今日これからの雨・明日の朝の雨・明日の日中の雨・
猛暑・蒸し暑さ・寝苦しさ・寒暖差・冷え込み・強風・服装・夜の冷え・空気の乾燥・日差しの強さ。
紫外線指数は取得していないため、晴天予報と季節から言える範囲に留め数値は述べさせません。

明日のカレンダーも読み込み、「明日10時にお出かけのご予定がありますが、その頃は雨の予報です」
のように天気と行動を結び付けられるようにしています（予定が無い日は欄ごと出ません）。

#### 緊急情報は「存在するか」ではなく「影響があるか」で判定

台風・警報・地震のデータは日本のどこかで該当すれば取得できてしまうため、presence-only の
判定では常時 true になり緊急モードが意味を失っていました（実データで三陸沖 M4.7 最大震度1・
約2,400km 東の熱帯低気圧・伊豆諸島の注意報がすべて true）。

台風はその後、「現在位置からの距離」ではなく気象庁の予報進路（12/24/48/72時間後の中心位置
と予報円）から判定する方式に改めました。日本への影響（direct/near/watch/none）とリスナー
居住地への影響（予報進路が500km以内へ入るか）を別軸で判定し、遠方から接近中の台風の
見落としと、近くても離れていく台風で騒ぐ問題の両方を解消しています。警報は居住地の
都道府県に加え、全国のレベル5（特別警報）も対象にしました（生命に関わる情報は居住地に
限らず一言流してほしいとの要望）。地震は**最大震度3以上／津波警報・注意報あり／M6.0以上**
のいずれかを採用基準にしています。


### コメンテーター（高橋教授）へのデータ注入

高橋教授コーナーでは、学習データによる誤情報を防ぐため、以下のデータをリアルタイム取得してプロンプトに注入します。

```
【実測値①: 株式・為替マーケット】    ← Yahoo Finance（10分キャッシュ）
  日経平均・TOPIX・ダウ・ナスダック・S&P500 / USD/JPY・EUR/JPY

【実測値②: 公式一次統計 経済指標】   ← IMF / World Bank / FRED / e-Stat（24hキャッシュ）
  日本: 実質GDP成長率・CPI各種・失業率・経常収支・政府総債務・純債務・財政収支
  米国: 実質GDP・CPI・コアCPI・コアPCE・失業率・FF金利・10年債利回り
  外貨準備: 日本外貨準備残高・米国債保有残高（長短）

【参考: 本日のニュースヘッドライン】  ← Yahoo News RSS（話題トピック参照のみ）
```

> **設計思想**  
> 政府債務 204%/GDP のような数字は「ニュース記事の解釈」ではなく IMF 一次データから取得。  
> グロス債務（204%）と純債務（134%）を両方渡すことで、高橋教授が BS（バランスシート）分析を行えるようにしています。

### 謎のジャーナリスト X の情報収集

Google Search グラウンディングにより、当日日付を付与した以下のクエリを自律生成して検索します。

```
「2026年6月2日 高市早苗 X」「2026年6月2日 Donald Trump Truth Social」
「2026年6月2日 Reuters breaking news」... （ウォッチリストから自動生成・約39クエリ）
```

ウォッチリストは `config.json` > `journalist_watchlist` で管理。日本政府・省庁・政治家 / 米国政府・政治 / テック企業 / 世界の指導者 / 国際機関 / 一次通信社 / スポーツの各カテゴリを収録。管理画面「リスナープロファイル › ジャーナリストウォッチリスト」から人物・機関の追加/削除が可能。

**定期監視ループ（2026-09-01追加）**: コーナー実行時のその場限りの検索とは別に、`server/lib/journalist-watch.js`が0時・6時・12時・18時の1日4回、決まった時刻に1回だけ全ウォッチリストを検索する。重複排除は前回取得結果をプロンプトに含め「そこに無いものだけ報告して」とGeminiに指示する方式。番組のジャーナリストコーナーには、ライブ検索の前に定期取得済みの内容が「既に把握済みの最新情報」として渡される（ライブ検索自体は残る）。My Secretaryには専用ツール`get_watchlist_updates`があり、ローカルファイルを読むだけのため「トランプさんは何か言ってた？」「大きなニュースある？」にask_helperを経由せず即答する。

### DJ サキ（楽曲選曲・Spotify フル再生）

- リスナープロファイルの `favorite_artists`・`music_genres` を最優先で参照して選曲
- **LLM による音楽リクエスト分類**：ディレクタ Gemini がユーザーリクエストを「特定曲・テーマ特集・一般」の3種に自動分類。MAXが番組内で口頭でDJへ振ったリクエストも同じ分類器で検出し、リスナーのテキストリクエストと同じくSpotify検索・強制反映の対象になる
- **複数曲特集コーナー**：「Beatles 特集」「雨にまつわる曲の特集」など複数曲を連続再生（`[TRACK:]` タグ方式）
- Spotify で楽曲 URI を取得 → Web Playback SDK でブラウザ上フル再生（Premium 必須）
- **Spotify audio-features 取得**：再生曲のテンポ・ムード（valence/energy）・ジャンル・アルバム名・リリース年を取得し MAX/Clara の感想コンテキストに注入
- **MAX/Clara は DJ ブースから音楽を「聴いた」設定**：曲の歌詞・雰囲気・テーマをコメントに反映
- **再生履歴管理**（200曲・48時間窓）：直近 48 時間以内の曲を選曲禁止リストとしてプロンプトに渡す
- **再生失敗時のフォールバック**：曲が見つからない場合、同アーティストの別曲を自動検索（429 対応・1.5秒待機後リトライ）
- **再生失敗曲の記録**：失敗曲も `playFailed: true` フラグ付きで履歴に保存し繰り返し選択を防止
- **再生開始時に即時履歴登録**：サーバー再起動による取りこぼしを防ぐ
- Spotify 429 (Too Many Requests) 時は `Retry-After` ヘッダーに従いリトライ（単曲検索）
- **トラック一覧取得の 429 対策**：60クエリ一括送信を最大15クエリに制限。バッチ間 250ms 待機・全件 429 検出時に即中断・`Retry-After` を次バッチ前に待機
- DJ の紹介トークと楽曲再生を並列処理し、トーク終了と同時に音楽が始まるよう設計
- 楽曲再生中に BGM を停止し、終了後に自動復元

### Steve ワールドレポート

- 毎回異なる都市・地域を選択（`world_report_cities.json` に最大 20 都市を永続保存し繰り返しを防止）
- Google Search グラウンディングで現地の最新ニュース・文化・トリビアを取得
- Phase 1（接続フレーズ）→ Phase 2（現地レポート本文）の 2 フェーズ発話
- Steve の居場所をプロンプトの冒頭に `🔒【絶対不変の前提】` として固定し、検索結果による場所の混乱を防止
- Steve への「場所リクエスト」は神出鬼没というキャラクター設定でユーモアたっぷりに断る（MAX が返答）

### 生活アドバイザー（平野ドレミ）

- リスナーの年齢・居住地・職業・趣味・興味を参照してアドバイスをパーソナライズ
- Google Search で地域イベント・お祭り・行政情報を取得
- 10テーマ（料理・健康・節約・DIY・読書・時事・地域・季節・ライフハック・おすすめアプリ）からランダム選択
- **紹介済みトピック履歴**：過去に紹介した食材・料理レシピの重複を防ぐ（`life_advisor_history.json` に保存）
- 思考過程（chain-of-thought）の出力を抑制し、本番セリフのみを TTS に渡す

### Google Calendar / Gmail 連携

- **Gmail フィルタ設定**：管理画面「システム管理 › システム接続資格情報」から除外カテゴリ（promotions/social/updates/forums）と取得件数・紹介件数を設定可能
- デフォルトはスパム・ゴミ箱のみ除外（通販・GitHub・株式関連メールも対象）
- 新着メールがある場合は番組内で優先的に言及

### カレンダー・スケジュール告知のスロットリング

同じ予定を何度もアナウンスしないよう、種別ごとに間隔制限を設けています。

| 種別 | 間隔 | 最大回数 |
|---|---|---|
| リマインダー（ゴミ / 掃除 / 病院 など） | 2時間 | 4回 |
| 通常イベント | 1時間 | 3回 |
| 告知記録の有効期限 | — | 2日間 |

### 特別な日・臨時滞在地

- **特別な日**（`config.json` > `show.user_profile.special_dates`）：管理画面から日付範囲・ラベル・番組指示を登録。クリスマス・記念日・誕生日などに応じた特集を自動実施。年をまたぐ期間（大晦日〜元日など）にも対応。個人の記念日／共通行事の別（`personal`）を設定でき、個人の記念日はパーソナリティ自身の身内の出来事と誤って語らないよう区別される
- **臨時滞在地**（`config.json` > `show.temp_stay`）：旅行・出張中の滞在地を登録すると、天気・交通情報が現地のものに切り替わり、会話のコンテキストにも反映される

---

## ディレクトリ構成

```
AI Radio/
├── server/
│   ├── server.js                  # Express + WebSocket サーバー・REST API（Live + Classic + Jazz + Mood + Beatles + 24/You）
│   ├── agent-system.js            # Live チャンネル マルチエージェント状態マシン
│   ├── agent-system-classic.js    # Classic チャンネル エージェントシステム
│   ├── agent-system-jazz.js       # Jazz チャンネル エージェントシステム
│   ├── agent-system-mood.js       # Mood チャンネル エージェントシステム
│   ├── agent-system-beatles.js    # Beatles チャンネル エージェントシステム
│   ├── agent-system-24you.js      # 24/You チャンネル（ナレーションなし選曲専用）
│   ├── agent-system-the-answers.js # The Answers（マルチアングル・ディスカッション）
│   ├── channel-base.js            # チャンネル共通基底クラス（ChannelAgentBase）
│   ├── music-channel-base.js      # 音楽系4ch中間基底（MusicChannelAgentBase）
│   ├── services/                  # 外部データ取得・API アクセスのサービス群
│   │   ├── news-service.js        #   ニュース（Yahoo RSS）
│   │   ├── finance-service.js     #   金融（Yahoo Finance + JGB + 経済RSS）
│   │   ├── weather-service.js     #   天気（OpenWeatherMap + 気象庁）
│   │   ├── economic-service.js    #   経済指標（IMF/世銀/FRED/e-Stat）
│   │   ├── media-compare-service.js #   各社の社説見出しの収集・束ね（Googleニュース RSS・30分キャッシュ）
│   │   ├── holiday-service.js     #   日本の祝日（holidays-jp・24hキャッシュ・同期読み出し）
│   │   ├── market-calendar.js     #   東京市場・米国市場の開閉判定（米国休場はルールで算出）
│   │   ├── google-service.js      #   Google認証・トークンキャッシュ（API別は下記へ分割）
│   │   ├── google-service-gmail.js / -calendar.js / -drive.js  #   Gmail / カレンダー / Drive
│   │   ├── google-service-sheets.js / -slides.js / -youtube.js / -tasks.js
│   │   └── spotify-service.js     #   Spotify API の 429対応 fetch プリミティブ（全ch共有）
│   ├── audio-mixer.js             # BGM + TTS ミキサー・ダッキング・ジングル・BGMシャッフル
│   ├── logger.js                  # pino + pino-roll ロガー（日次ローテート・7世代保持）
│   ├── activity-db.js             # 稼働レポート用アクティビティ集計
│   ├── earthquake-monitor.js      # 緊急地震速報（P2PQuake WebSocket）監視
│   ├── lib/
│   │   ├── atomic-json.js         # JSONの原子的書き込み（一時ファイル→rename。kill -9でも壊れない）
│   │   ├── llm-models.js          # モデルのティア表（用途→モデル名。差し替え時に触る唯一の場所）
│   │   ├── llm-client.js          # LLM抽象化層: テキスト・ツール呼び出し・画像・ストリーミング
│   │   ├── tts-client.js          # 音声合成の抽象化層（演技指示の組み立て・リトライ）
│   │   ├── live-client.js         # リアルタイム音声対話（Live API）の抽象化層
│   │   ├── agent-shared-mixin.js  # Live/各ch共通のインフラ・メソッド（Object.assignで両取り込み）
│   │   ├── pcm-cache.js           # TTS PCM キャッシュ（割り込み音声の事前生成保持）
│   │   ├── system-alerts.js       # システム異常の集約点（残高不足等の判定・文面・全画面への配信）
│   │   ├── agent-discussion-corner.js # 討論コーナー機構（ニュースディープダイブ／インサイト・マネー。Nターンの掛け合い・出演者はディレクタ采配）
│   │   ├── agent-knowledge-pack.js # エージェントの手持ちを1か所で組み立て（Liveの全コーナー・討論・The Answers・秘書の相談が共通で使う・項目ごとの上限）
│   │   ├── listener-context.js    # リスナー本人の情報の台帳と公開範囲（誰にどこまで見せるか・出典と時点）
│   │   ├── topical-materials.js   # 「世の中の動き」の材料を1か所で組み立て（見出し・割れている社説・専門分野の動き・世の中の反応。森田と The Answers が共通で使う）
│   │   ├── director-board.js      # ディレクター同士の掲示板（各chのディレクターが直近の方針を書き、互いに読む）
│   │   ├── agent-knowledge-ledger.js # エージェントの「分かったこと」の台帳（日付・出典付きの事実を溜め、話題に関係するものを選んで渡す）
│   │   ├── agent-proactive-research.js # 毎朝の自主リサーチ（教授・弁護士・医師・生活アドバイス・マーケター・芸人。直近7日分を保持）
│   │   ├── guest-analyst-corner.js # ゲスト論客3人のコーナーの文面（進行は1実装を使い回す）
│   │   ├── guest-agent-notes.js   # ゲスト論客3人の継続観測メモ（1つの作り方から3人分の器を生やす）
│   │   ├── market-data-kit.js     # 数値の取得と計算（財務省国債・Yahoo・FRED／変化・5年内の位置・相関4期間）
│   │   ├── discussion-data-sheet.js # 話題ごとに必要な系列を選び、討論コーナーへ数値シートを渡す
│   │   ├── standing-data-sheet.js # 解説コーナー用の定点観測シート（毎回同じ顔ぶれ・LLM不使用）
│   │   ├── editorial-compare.js   # 社説の読み比べ判定（割れているときだけ拾う・過去社説の絞り込み）
│   │   ├── finance-import.js      # 楽天CSV・PayPay HTML の解析（数値はコードで確定・LLM不使用）
│   │   ├── youtube-watch-store.js # 視聴した動画の要約を蓄積（生の字幕は残さない・最大300件・持ち場の正面にある人だけが論点を書き留める）
│   │   ├── youtube-watch-summarize.js # 字幕を議論に使える要約へ（軽量モデル・検索なし）
│   │   ├── finance-import-store.js #  取り込みデータの材料置き場（社ごと・週次系列には書かない）
│   │   ├── holdings-treemap-svg.js #  資産ヒートマップのSVG生成（依存パッケージ0）
│   │   ├── agent-diary.js         # エージェント日記の永続化ヘルパー（保存・横断読み出し）
│   │   ├── agent-diary-feedback.js # 日記フィードバックループ（週1回、自己反映＋ディレクター横断監督）
│   │   └── hidden-talent-profiles.js # The Answers の「裏の顔」設定を Live の各エージェントへ対応付け
│   ├── routes/                    # Express ルートを機能別に分割（server.js から登録・分割は継続中）
│   │   ├── report-routes.js       #   稼働レポート（/api/report/*）
│   │   ├── agent-diary-routes.js  #   エージェント日記閲覧API（/api/agent-diary）
│   │   ├── agent-diary-feedback-routes.js #   日記フィードバック手動トリガー（/api/agent-diary-feedback/run）
│   │   ├── config-data-routes.js  #   設定・認証情報・辞書等の CRUD（/api/config・/api/discussion-corners/:key 他）
│   │   ├── oauth-routes.js        #   Spotify/Google OAuth2 認証フロー
│   │   ├── channel-api.js         #   5ch共通の登録ファクトリ（config/direction/bgm/tts-test）
│   │   ├── channel-24you-routes.js #  24/You チャンネル設定・モード
│   │   ├── channel-the-answers-routes.js # The Answers 固有API（議題・挙手・アーカイブ）
│   │   ├── recording-routes.js    #   番組録音サブシステム（状態機械・ALLモード追従）
│   │   ├── live-control-routes.js #   Live制御（status/show-end/direction）
│   │   ├── tts-test-routes.js     #   スピーカー一覧・音声テスト
│   │   ├── bgm-routes.js          #   BGM 一覧・プレビュー配信・テストストリーミング（/test/bgm）
│   │   ├── weather-satellite-routes.js # 天気図・衛星画像プロキシ
│   │   ├── log-routes.js          #   ログ取得・リリースノート
│   │   ├── conversation-history-routes.js # 会話履歴の取得・クリア
│   │   ├── earthquake-routes.js   #   EEW チャイム・テスト発火
│   │   ├── spotify-diagnostics-routes.js # Spotify SDK トークン・診断
│   │   ├── text-command-routes.js #   AI管理人 窓口・番組コンテキスト・交通エリア提案
│   │   ├── dashboard-routes.js    #   システム監視ダッシュボード向けREST（接続数スナップショット）・リスナー情報の台帳（/api/listener-context）・知見の台帳の件数（/api/agent-knowledge）
│   │   ├── finance-import-routes.js #  資産取り込み口・ユーザースクリプト配信（共有トークン＋localhost限定）
│   │   ├── youtube-import-routes.js #  視聴記録の受け口（カバー率・字数で異常なデータを拒否）
│   │   ├── recipe-routes.js       #   レシピのObsidian保存・一覧・画像配信（1件ずつ送る）
│   │   └── static-routes.js       #   フロントエンド静的配信・SPAフォールバック
│   ├── tampermonkey/              # ブラウザ拡張用ユーザースクリプト（配信時にトークンを差し込む）
│   │   ├── rakuten.user.js        #   楽天証券（公式CSVを裏で取得）
│   │   ├── paypay.user.js         #   PayPay銀行（ページのHTMLを送信・隠しフィールドは除去）
│   │   └── youtube.user.js        #   YouTube（画面外で文字起こしを開いて読む・画面は動かさない）
│   ├── data/
│   │   ├── config.json               # Live チャンネル設定・エージェント・watchlist 等
│   │   ├── credentials.json          # APIキー群（Git 管理外・.gitignore 済み）
│   │   ├── tts_dict.json             # 発音辞書（管理画面から編集可能）
│   │   ├── played_tracks.json        # Live Spotify 再生履歴（200曲・再起動で保持）
│   │   ├── director_queue_state.json # 森田ディレクタの編成キュー（放送日単位で継続・Git 管理外）
│   │   ├── life_advisor_history.json # ドレミの紹介済みトピック履歴（最大30件）
│   │   ├── world_report_cities.json  # Steve の訪問済み都市履歴（最大20件）
│   │   ├── long_term_memory.json     # Live 長期記憶（セッションサマリー・Git 管理外）
│   │   ├── agent-diary/               # エージェント日記（チャンネル/エージェント/日付別JSON。
│   │   │                              #   同ディレクトリに digest.json/team_digest.json
│   │   │                              #   （週1回の自己/チームダイジェスト）・predictions.json
│   │   │                              #   （見立ての答え合わせ管理）も併存・Git 管理外）
│   │   ├── finance-import/            # 拡張から届いた資産データ（社ごと・Git 管理外）
│   │   ├── secretary/youtube-watched.json # 視聴したYouTubeの要約（拡張から取り込み・Git 管理外）
│   │   ├── agent-diary-feedback-state.json # 日記フィードバック週次バッチの実行済み日付ゲート
│   │   └── channels/
│   │       ├── classic/
│   │       │   ├── config.json           # Classic チャンネル設定・エージェント設定
│   │       │   ├── played_tracks.json    # Classic 再生履歴（200曲・指揮者/演奏者情報付き）
│   │       │   └── long_term_memory.json # Classic 長期記憶
│   │       ├── jazz/
│   │       │   ├── config.json           # Jazz チャンネル設定・エージェント設定
│   │       │   ├── played_tracks.json    # Jazz 再生履歴（200曲・アーティスト/タイトル情報付き）
│   │       │   └── long_term_memory.json # Jazz 長期記憶
│   │       ├── mood/
│   │       │   ├── config.json           # Mood チャンネル設定・エージェント設定
│   │       │   ├── played_tracks.json    # Mood 再生履歴（200曲）
│   │       │   └── long_term_memory.json # Mood 長期記憶
│   │       ├── beatles/
│   │       │   ├── config.json           # Beatles チャンネル設定・エージェント設定
│   │       │   ├── played_tracks.json    # Beatles 再生履歴（200曲）
│   │       │   └── long_term_memory.json # Beatles 長期記憶
│   │       └── 24you/
│   │           ├── config.json           # 24/You チャンネル設定（選曲モード。agents キーなし）
│   │           ├── played_tracks.json    # 24/You 再生履歴（200曲）
│   │           └── track_batch_cache.json # 24/You 選曲候補バッチのキャッシュ（モード|条件ごと・最大24件）
│   ├── assets/
│   │   ├── bgm/
│   │   │   ├── *.mp3            # Live 通常 BGM（シャッフル再生）
│   │   │   ├── opening/*.mp3    # Live オープニングジングル
│   │   │   ├── corner/*.mp3     # 天気・交通・ニュース・金融コーナー冒頭の3秒ジングル
│   │   │   └── discussion/*.mp3 # 討論コーナーの開幕曲（約15秒。<コーナーのキー>/ で個別指定可・無ければ corner/）
│   │   └── channels/
│   │       ├── classic/
│   │       │   └── bgm/
│   │       │       ├── main/*.mp3     # Classic BGM（任意）
│   │       │       └── opening/*.mp3  # Classic オープニングジングル
│   │       ├── jazz/
│   │       │   └── bgm/
│   │       │       ├── main/*.mp3     # Jazz BGM（任意）
│   │       │       └── opening/*.mp3  # Jazz オープニングジングル
│   │       ├── mood/
│   │       │   └── bgm/
│   │       │       ├── main/*.mp3     # Mood BGM（任意）
│   │       │       └── opening/*.mp3  # Mood オープニングジングル
│   │       └── beatles/
│   │           └── bgm/
│   │               ├── main/*.mp3     # Beatles BGM（任意）
│   │               └── opening/*.mp3  # Beatles オープニングジングル
│   │       （24/You はナレーション・BGM を使わないため bgm/ フォルダなし）
│   └── logs/
│       └── server.*.log     # ローテートログファイル（自動生成）
├── client/
│   ├── index.html           # プレイヤーページ（エンドユーザー向け・/）
│   ├── admin.html           # 管理画面（/admin）
│   ├── dashboard.html       # システム監視ダッシュボード（/dashboard）
│   ├── public/
│   │   ├── logo.png         # メインカード用ロゴ（オフライン時・チャンネル未接続時に表示）
│   │   ├── live_logo.png    # Live チャンネル接続中に表示するロゴ
│   │   ├── classic_logo.png # Classic チャンネル接続中に表示するロゴ
│   │   ├── jazz_logo.png    # Jazz チャンネル接続中に表示するロゴ
│   │   ├── mood_logo.png    # Mood チャンネル接続中に表示するロゴ
│   │   ├── beatles_logo.png # Beatles チャンネル接続中に表示するロゴ
│   │   ├── 24you_logo.png   # 24/You チャンネル接続中に表示するロゴ
│   │   ├── Bland_logo.png   # ヘッダー用ブランドロゴ（全画面共通・固定）
│   │   └── avatars/              # エージェントアバター PNG（300×300 透過PNG・任意）
│   │       ├── caster.png / assistant.png / music_dj.png
│   │       ├── world_report.png / life_advisor.png / commentator.png
│   │       ├── journalist.png / weather.png / traffic.png / news.png
│   │       ├── finance.png / legal_advisor.png / director.png
│   │       ├── comedian.png / doctor.png / marketer.png  # ゲスト論客3人
│   │       ├── classic_director.png     # Classic ディレクター
│   │       ├── classic_personality.png  # Classic パーソナリティ
│   │       ├── jazz_director.png        # Jazz ディレクター
│   │       ├── jazz_personality.png     # Jazz パーソナリティ
│   │       ├── mood_director.png        # Mood ディレクター
│   │       ├── mood_personality.png     # Mood パーソナリティ
│   │       ├── beatles_director.png     # Beatles ディレクター
│   │       ├── beatles_personality.png  # Beatles パーソナリティ
│   │       ├── answers_director.png     # The Answers ディレクター（声を持たず放送に出ない）
│   │       └── secretary.png            # My Secretary
│   │       （24/You はエージェントが存在しないためアバターなし）
│   └── src/
│       ├── Player.tsx       # プレイヤー UI 本体（エンドユーザー向け・Vite MPA）
│       ├── main.tsx         # プレイヤーエントリポイント
│       ├── App.tsx          # 管理 UI 本体（管理者向け・Vite MPA、チャンネル別state/handlerを保有）
│       ├── admin-main.tsx   # 管理画面エントリポイント
│       ├── dashboard-main.tsx # システム監視ダッシュボードエントリポイント
│       ├── admin/           # 管理画面（App.tsx）専用の分割モジュール
│       │   ├── types.ts / constants.ts / utils.tsx  # 型・定数・純粋ヘルパー
│       │   ├── components/  # チャンネル横断の共有UIパーツ（TTSフィールド・日記タブ・アコーディオン等）
│       │   └── panels/      # チャンネル別の管理タブ本体（Classic/Jazz/Mood/Beatles/24You/TheAnswers/System/Live）
│       ├── player/          # プレイヤー（Player.tsx）専用の分割モジュール
│       │   ├── types.ts / constants.ts / audioWorklet.ts / utils.ts
│       │   └── components/  # キャプション・ティッカー・再生履歴・リクエストキューパネル等
│       └── dashboard/       # システム監視ダッシュボード（Dashboard.tsx）専用モジュール
│           ├── Dashboard.tsx        # ルートコンポーネント（WS接続・状態管理）
│           ├── dashboard.css        # 3段の段組み（画面幅に応じた切り替え）
│           ├── types.ts / constants.ts # スナップショット/イベント型・コーナーラベル・討論コーナーの表示情報等
│           ├── hooks/       # useDashboardSocket（/stream-dashboard接続）・useAgentNames・useDiscussionSettings
│           └── components/  # Live/Secretary/The Answers の固定パネル・音楽chの小タイル・畳んだ記録等
├── utils/
│   └── audio-decoder.js     # ffmpeg ラッパー（MP3 → s24le PCM 変換・ループ/ワンショット）
├── scripts/                 # コメント整理（JSDoc）の検査ツール
│   ├── doc-verify.js        #   字句列をHEADと突き合わせ、コードが変わっていないことを確認
│   ├── doc-typecheck.js     #   tscの指摘が整理前より増えていないかを比較
│   └── doc-progress.js      #   @doc-reviewed の付いたファイル数・行数で進み具合を表示
├── LICENSE                  # MIT ライセンス全文（各ファイルのヘッダーは SPDX 識別子のみ）
└── package.json             # ワークスペース定義
```

---

## セットアップ

### 必要なもの

- **Node.js 18 以上**
- **ffmpeg**（`ffmpeg-static` npm パッケージで自動解決されるため別途インストール不要）
- **Gemini API キー**（セリフ生成・音声合成の両方に使用）
- **Spotify Premium アカウント**（楽曲フル再生に必要）

### インストール

```bash
# リポジトリをクローン後
npm run install:all
```

### Spotify Developer Dashboard の設定

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) でアプリを登録
2. アプリ設定で **「Web Playback SDK」にチェックを入れる**（未設定だと楽曲再生不可）
3. Redirect URI に `http://localhost:3001/callback` を追加
4. `client_id` / `client_secret` / `refresh_token` を `credentials.json` に設定

> ⚠️ **Spotify Web Playback SDK の制約**  
> SDK はブラウザの JavaScript として動作するため、**プレイヤーページが表示されていないと Spotify デバイスとして認識されません**。  
> プレイヤー（`/`）と管理画面（`/admin`）は独立したページとして分離されています。Spotify 再生中に管理画面を開く場合は別タブで開いてください。

> ℹ️ **バックグラウンドタブでの Spotify 再生について**  
> ブラウザの自動再生ポリシーにより、タブが非表示（バックグラウンド）の状態では Spotify SDK の AudioContext が suspended 状態になり、音声出力がブロックされます。これはセキュリティではなく UX ポリシーです。  
> - **回避策**：Chrome のサイト設定（アドレスバー左の 🔒 → サイトの設定 → 音声: 許可）で `localhost` を許可すると、バックグラウンドでも AudioContext が running 状態を維持しやすくなります。  
> - **バックグラウンドスキップ機能**：`SPOTIFY_PLAY` 受信時にタブが非表示の場合、OS ネイティブ通知（Web Notification API）でリスナーに通知したうえで **30 秒間**切り替えを待機します。30 秒経過しても非表示のままであれば再生をスキップして番組を続行します。重要な設計として、タイムアウト時は Spotify API への再生コマンドを送信しないため、後からタブに戻っても音声と会話が重なる競合状態は発生しません。

> 🚨 **Chrome で Spotify が再生されない場合（既知の不具合）**  
> Chrome の `hardware-media-key-handling` 機能が有効になっていると、Spotify Web Playback SDK の Widevine DRM 初期化がハングし、デバイスを作成できなくなります。  
>
> **対処法：**  
> 1. Chrome で `chrome://flags/#hardware-media-key-handling` を開く  
> 2. ドロップダウンを **Disabled** に変更  
> 3. Chrome を再起動  
>
> この問題は Chrome 130 以降と Spotify Web Playback SDK の非互換によって発生します。  
> `player.connect()` が永続的にハングし、`ready` イベントが発火しないため、ブラウザ上に仮想デバイスが作成されません。  
> Safari は Widevine 非対応（FairPlay のみ）のため Spotify Web Playback SDK は使用できません。

### APIキーの設定

`server/data/credentials.json` を作成し、使用するサービスのキーを設定します（[設定ファイル](#設定ファイル) 参照）。  
Gemini APIキーのみ設定すれば最低限の番組進行が可能です。

### 番組設定の作成

`server/data/config.json` はリスナー本人の情報（氏名・居住地・家族の記念日・保有銘柄など）を含むため、
リポジトリには含めていません。雛形をコピーして使います。

```bash
cp server/data/config.example.json server/data/config.json
```

コピーした後、管理画面の「リスナープロファイル」から自分の情報に書き換えてください。
エージェントの名前・人格設定・ウォッチリストは雛形の値をそのまま使えます。

### サーバー起動

```bash
# サーバーのみ起動（番組ループも同時に開始）
npm run start:server

# フロントエンド開発サーバーも同時起動
npm run dev
```

### ブラウザで受信

```
http://localhost:5173        # 開発時 — プレイヤー（Vite dev server）
http://localhost:5173/admin  # 開発時 — 管理画面
http://localhost:3001        # 本番ビルド後 — プレイヤー
http://localhost:3001/admin  # 本番ビルド後 — 管理画面
```

> プレイヤー（`/`）はエンドユーザー向けのシンプルな受信 UI です。  
> 管理画面（`/admin`）はエージェント設定・BGM・API キー管理などを行う管理者向け UI です。  
> Vite MPA（Multi-Page Application）構成により、2つのページは独立したバンドルとしてビルドされます。

### 外部公開する場合（ngrok等）

ローカル環境をngrok等で外部公開してブラウザからアクセスする場合、CORSブロックを避けるため
`server/.env`に公開URLを設定してください。

```
NGROK_ORIGIN=https://xxxx.ngrok-free.app
```

設定後はサーバーの再起動が必要です（`localhost`・LAN内IPからのアクセスは設定不要で従来通り許可されます）。

---

## 設定ファイル

### `server/data/config.json`

番組の雰囲気・ユーザープロフィール・エージェント設定・ジャーナリストウォッチリスト。管理画面から主要項目を変更可能。

```json
{
  "show": {
    "atmosphere": "通常 (フレンドリーで元気な放送)",
    "theme": "私だけの AI Radio",
    "gmail_filter": {
      "exclude_promotions": false,
      "exclude_social": false,
      "exclude_updates": false,
      "exclude_forums": false,
      "max_fetch": 10,
      "max_announce": 5
    },
    "user_profile": {
      "name": "リスナー名",
      "name_reading": "りすなーめい",
      "birthday": "YYYY-MM-DD",
      "location": "東京都渋谷区",
      "nearest_station": "渋谷駅",
      "traffic_areas": ["居住地周辺", "首都高C1（都心環状線）"],
      "occupation": "エンジニア",
      "hobbies": "音楽鑑賞",
      "interests": "テクノロジー、株式投資",
      "music_genres": ["J-POP", "ロック"],
      "favorite_artists": ["YOASOBI", "米津玄師"],
      "music_notes": "アップテンポな曲が好き",
      "day_start_hour": 4,
      "special_dates": [
        {
          "start": "12-22",
          "end": "12-25",
          "label": "クリスマス",
          "instruction": "クリスマスソングを中心に特集を組んでください。",
          "personal": false
        },
        {
          "start": "08-19",
          "end": "08-19",
          "label": "娘の誕生日",
          "instruction": "娘の好きなアーティストの特集をお願いします。",
          "personal": true
        }
      ]
    },
    "temp_stay": {
      "location": "長野県白馬村",
      "purpose": "レジャー",
      "start": "2026-06-22",
      "end": "2026-06-25",
      "timezone": "Asia/Tokyo",
      "note": "リゾートの温泉でリフレッシュ"
    },
    "current_instruction": "",
    "conversation_exchanges": 4,
    "corner_queue_max": 3,
    "tts_test_text": "こんにちは！今日もよろしくお願いします。",
    "display": {
      "ticker": { "enabled": true, "font_size_rem": 1.5, "scroll_speed": 10 },
      "info_view": { "enabled": true, "world_report_zoom_start": 1, "world_report_zoom": 16, "zoom_duration_sec": 36 }
    },
    "discussion_corners": {
      "news_deep_dive": {
        "name": "ニュースディープダイブ",
        "enabled": true,
        "frequency": 1,
        "max_turns": 7,
        "opening_jingle_ms": 15000
      },
      "insight_money": {
        "name": "インサイト・マネー",
        "enabled": true,
        "frequency": 1,
        "max_turns": 7,
        "opening_jingle_ms": 15000
      }
    },
    "debug": {
      "enabled": false,
      "force_full_opening": false,
      "disable_memory": false,
      "skip_music_play": false,
      "music_play_minutes": 0
    }
  },
  "agents": {
    "caster": {
      "name": "Max (キャスター)",
      "prompt": "...",
      "voice": "...",
      "speaker_id": 1310138976,
      "pan": 0,
      "speed_scale": 1.0,
      "intonation_scale": 1.0,
      "pitch_scale": 0.0,
      "volume": 1.0,
      "gemini_model": "gemini-2.5-flash"
    },
    "world_report": {
      "name": "Steve（ワールドレポート特派員）",
      "prompt": "...",
      "tts_engine": "gemini",
      "gemini_voice": "Puck",
      "gemini_instruction": "energetic field reporter voice",
      "gemini_language": "en-US",
      "tts_profile_title": "...",
      "tts_scene": "...",
      "tts_style": "...",
      "tts_accent": "...",
      "tts_pacing": "...",
      "tts_context": "...",
      "max_chars": 300
    }
  },
  "shortcuts": {
    "open_inquiry": { "ctrlKey": true, "altKey": true, "metaKey": false, "shiftKey": false, "code": "KeyM" },
    "mute_toggle":  { "ctrlKey": true, "altKey": true, "metaKey": false, "shiftKey": false, "code": "KeyU" }
  },
  "journalist_watchlist": {
    "japan_official":  [{ "name": "首相官邸",    "x_handle": "kantei" }, ...],
    "japan_politics":  [{ "name": "高市早苗",    "x_handle": "takaichi_sanae" }, ...],
    "us_official":     [{ "name": "White House", "x_handle": "WhiteHouse" }, ...],
    "us_politics":     [{ "name": "Donald Trump","x_handle": "realDonaldTrump" }, ...],
    "tech_business":   [{ "name": "Elon Musk",   "x_handle": "elonmusk" }, ...],
    "world_leaders":   [{ "name": "Emmanuel Macron", "x_handle": "EmmanuelMacron" }, ...],
    "international_orgs": [...],
    "primary_wire":    [{ "name": "Reuters", "x_handle": "Reuters" }, ...],
    "sports":          [{ "name": "大谷翔平", "x_handle": null }, ...]
  }
}
```

#### `gmail_filter` について

| フィールド | 型 | 説明 |
|---|---|---|
| `exclude_promotions` | boolean | プロモーション（通販・クーポン）を除外 |
| `exclude_social` | boolean | SNS 通知を除外 |
| `exclude_updates` | boolean | サービス更新通知を除外 |
| `exclude_forums` | boolean | フォーラム通知を除外 |
| `max_fetch` | number | API から取得する最大件数（5〜20）|
| `max_announce` | number | 一度に紹介する最大件数（1〜10）|

スパム・ゴミ箱は設定に関わらず常時除外されます。管理画面「システム管理 › システム接続資格情報」から GUI 設定可能。

#### `shortcuts` について

キーボードショートカット13操作分の設定（`{ ctrlKey, altKey, metaKey, shiftKey, code }`、`code`は`KeyboardEvent.code`）。
一覧・デフォルト値は[AI Radio管理人の「キーボードショートカット」節](#キーボードショートカット)を参照。
管理画面「システム管理 › ショートカットキー」から GUI 設定可能。

#### `special_dates` について

| フィールド | 型 | 説明 |
|---|---|---|
| `start` | string | 開始日（MM-DD 形式）|
| `end` | string | 終了日（MM-DD 形式）。単日は start と同じ値 |
| `label` | string | 表示名（例: "クリスマス"）|
| `instruction` | string | 番組への指示（例: "クリスマス特集コーナーを盛大に！"）|
| `personal` | boolean | `true`（既定）: リスナー個人・家族の記念日（誕生日等）。`false`: 誰にとっても共通の行事（クリスマス等）|

`start > end` の場合は年またぎ期間として扱います（例: `12-31` 〜 `01-01`）。

`personal`は`server/agent-system.js`のプロンプト生成で参照される。`true`の場合はリスナー本人・
家族の出来事であることを明示し、パーソナリティ自身の身内の出来事として語らないよう注意書きを
添える（例:「僕の息子」ではなく「〇〇さんの息子さん」）。`false`の場合はこの注意書きを省略する。

#### `temp_stay` について

| フィールド | 型 | 説明 |
|---|---|---|
| `location` | string | 滞在地名（例: "長野県白馬村"）|
| `purpose` | string | 目的（"出張" / "レジャー" / "その他"）|
| `start` | string | 開始日（YYYY-MM-DD）|
| `end` | string | 終了日（YYYY-MM-DD）|
| `timezone` | string | タイムゾーン（"Asia/Tokyo" / "America/New_York" など）|
| `note` | string | 自由メモ（任意）|

有効期間中は天気・交通情報が滞在地のものに切り替わります。

#### `debug` について

管理画面の「デバッグ設定」メニューは廃止済み。緊急地震速報のテスト発火のみ「システム接続設定」
タブへ移設され、都道府県単位のフィルタリング機能も追加された（[サイドバー構成](#サイドバー構成)参照）。
`skip_opening` / `force_first_corner` は内部データとしては存在し実際にコーナー選択へ反映されるが、
管理画面 UI からの編集手段は無い（コード直編集専用）。`max_tokens` はコード側でも未参照で事実上使われていない。

#### エージェントパラメータ一覧

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `volume` | number | 1.0 | 音量倍率（dB 換算: -20〜+6 dB）|
| `pan` | number | 0 | ステレオパン（-1.0=L〜+1.0=R）|
| `tts_engine` | string | `"gemini"` | 実質 `"gemini"`（Gemini TTS）のみ。合成失敗時は自動的に Google Translate TTS へフォールバックする |
| `gemini_voice` | string | — | Gemini TTS 使用時のボイス名（例: `Charon`, `Puck`, `Aoede`）|
| `gemini_instruction` | string | — | Gemini TTS への簡易音声指示（例: "warm deep elderly voice"）|
| `gemini_language` | string | — | Gemini TTS の言語コード（例: `en-US`）|
| `tts_profile_title` / `tts_scene` / `tts_style` / `tts_accent` / `tts_pacing` / `tts_context` | string | — | Gemini 3.1 TTS 用の詳細プロンプト項目（管理画面「エージェント設定」から個別入力可能）|
| `max_chars` | number | — | このエージェントの1発話あたり最大文字数の上書き |

> **インライン演技タグ**  
> 発話生成プロンプト（`agent-shared-mixin.js` の `_geminiInlineTagGuidanceJa`/`_geminiInlineTagGuidanceEn`）が、
> セリフ本文中に `[laughs]` `[whispers]` `[excitedly]` のような角括弧タグを控えめに（1発話につき最大1個）
> 埋め込むよう全6チャンネルへ指示している。Gemini TTS がその位置の感情・話し方を再現する制御記号で、
> 音声として読み上げられることはない。

#### エージェント個別の `gemini_model` について

各エージェントに `gemini_model` を指定すると、そのエージェントのみ別モデルを使用できます。  
未指定の場合は `show.gemini_model`（グローバル設定）にフォールバックします。

### `server/data/credentials.json`

各サービスの API キーを設定。このファイルは `.gitignore` に追加済みです。

```json
{
  "gemini":         { "api_key": "YOUR_GEMINI_API_KEY", "tts_model": "gemini-2.5-flash-preview-tts" },
  "openweathermap": { "api_key": "YOUR_OWM_API_KEY" },
  "youtube":        { "api_key": "YOUR_YOUTUBE_API_KEY" },
  "fred": {
    "_comment": "セントルイス連銀 FRED API（無料・要登録）https://fred.stlouisfed.org/",
    "api_key": "YOUR_FRED_API_KEY"
  },
  "estat": {
    "_comment": "総務省統計局 e-Stat API（無料・要登録）https://www.e-stat.go.jp/api/",
    "api_key": "YOUR_ESTAT_API_KEY"
  },
  "google": {
    "client_id":     "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "refresh_token": "YOUR_REFRESH_TOKEN",
    "youtube_refresh_token": "（管理画面「YouTubeでサインイン」から自動取得。手入力不要）"
  },
  "spotify": {
    "client_id":     "YOUR_SPOTIFY_CLIENT_ID",
    "client_secret": "YOUR_SPOTIFY_CLIENT_SECRET",
    "refresh_token": "YOUR_SPOTIFY_REFRESH_TOKEN"
  },
  "finance_import": {
    "_comment": "ブラウザ拡張からの資産取り込み用。任意の長い文字列を設定する",
    "token": "YOUR_IMPORT_TOKEN",
    "allow_remote": false
  }
}
```

> ⚠️ `credentials.json` は `.gitignore` に追加されています。絶対にリポジトリにコミットしないでください。

### `server/data/tts_dict.json`

発音辞書エントリの配列。管理画面の「システム管理 › 発声辞書」から GUI 編集可能。  
各エントリは正規表現パターンと置換文字列のペアで、TTS に渡す直前に適用されます。

```json
[
  { "id": 1, "pattern": "NHK", "flags": "g", "replacement": "エヌエイチケー", "note": "放送局略語", "enabled": true },
  { "id": 2, "pattern": "GDP", "flags": "gi", "replacement": "ジーディーピー", "note": "経済指標", "enabled": true }
]
```

### `server/data/played_tracks.json`

Spotify 再生履歴。サーバー再起動後も保持されます。

- 直近 **200 曲** を保存（再生開始時点で即時記録）
- DJ サキの選曲プロンプトには **直近 48 時間以内** の曲のみ禁止リストとして渡す
- 再生失敗曲は `"playFailed": true` フラグ付きで記録し、繰り返し選択を防止

---

## 管理画面

`http://localhost:5173/admin`（開発時）または `http://localhost:3001/admin`（本番）にアクセス。

管理画面はプレイヤーとは完全に独立した MPA（Multi-Page Application）ページです。WebSocket・AudioContext・Spotify SDK は持たず、REST API のみで動作します。左側のツリービュー型サイドバーから各設定画面に移動します。

### サイドバー構成

```
▾ 👤 リスナープロファイル
    リスナー情報          ← 名前・誕生日・居住地・最寄り駅・職業・趣味・興味・1日の開始時刻
    音楽プロファイル       ← 好きなジャンル・アーティスト・音楽メモ
    交通情報エリア        ← 監視する道路・路線（AI 自動提案あり）
    臨時滞在地           ← 旅行・出張先登録（有効期間中は天気・交通が切り替わる）
    特別な日             ← 記念日・イベント期間・番組への指示を登録
    金融情報ウォッチリスト  ← 指数・為替・債券・コモディティ・個別株の管理
                          ＋個人所有ファンド・株式（投資信託・株式・ETF）の登録・自動価格取得
    ジャーナリストウォッチリスト ← 謎のジャーナリストXが情報収集の参考にする人物・機関を9カテゴリで追加/削除

▾ 📻 番組プロファイル（Live）
    番組設定             ← テーマ・雰囲気（モード）・Gemini モデル・Max↔Clara往復上限・
                          コーナーリクエストキュー上限・放送中に表示するメタ情報の設定
                          （旧「トーク設定」「情報表示」を統合）
    BGM管理             ← BGM ファイル一覧・即時切り替え
    エージェント設定       ← 各キャラのプロンプト・ボイス・音量・モデル・試聴テスト
    エージェント日記       ← 各エージェントのコーナー終了後・オープニング/エンディングの
                          一人称振り返り（フィルター・自動更新）

▾ 🎼 番組プロファイル（Classic）
    番組設定             ← Gemini モデル・Spotify 有効・再生時間（0=全曲）・セッション曲数
    エージェント設定       ← ディレクター / パーソナリティのプロンプト・ボイス・音量・試聴テスト
    BGM管理             ← Classic BGM ファイル一覧
    エージェント日記       ← パーソナリティの一人称振り返り（全リスナー退出時にセッション
                          分をまとめて1回・フィルター・自動更新）

▾ 🎷 番組プロファイル（Jazz）
    番組設定             ← Gemini モデル・翻訳テロップ ON/OFF・スクロール速度など
    エージェント設定       ← ディレクター / パーソナリティのプロンプト・ボイス・音量・試聴テスト
    BGM管理             ← Jazz BGM ファイル一覧
    エージェント日記       ← パーソナリティの一人称振り返り（全リスナー退出時にセッション
                          分をまとめて1回・フィルター・自動更新）

▾ 🌙 番組プロファイル（Mood）
    番組設定             ← Gemini モデル・Spotify 有効・再生時間・セッション曲数
    エージェント設定       ← ディレクター / パーソナリティのプロンプト・ボイス・音量・試聴テスト
    BGM管理             ← Mood BGM ファイル一覧
    エージェント日記       ← パーソナリティの一人称振り返り（全リスナー退出時にセッション
                          分をまとめて1回・フィルター・自動更新）

▾ 🪲 番組プロファイル（Beatles）
    番組設定             ← Gemini モデル・Spotify 有効・再生時間・セッション曲数
    エージェント設定       ← ディレクター / パーソナリティのプロンプト・ボイス・音量・試聴テスト
    BGM管理             ← Beatles BGM ファイル一覧
    エージェント日記       ← パーソナリティの一人称振り返り（全リスナー退出時にセッション
                          分をまとめて1回・フィルター・自動更新）

▾ 🔀 番組プロファイル（24/You）
    番組設定             ← 選曲モード（おまかせ／あの頃／歌手／新譜／わがまま）・言語の好み・
                          「あの頃」年齢設定・わがままリクエスト文
                          （エージェント・BGM がないため他チャンネルと異なりタブは1つのみ）

▾ 🗣️ 番組プロファイル（The Answers）
    番組設定             ← Gemini モデル・パネリスト人数・ローテーション参照エピソード数など
    ディレクタ設定        ← テーマ選定を行うディレクターのプロンプト・Gemini モデル
    パネリスト裏プロファイル ← 各チャンネルのエージェントに設定する「隠れた才能」等の追加設定
    BGM管理             ← The Answers BGM（オープニング/エンディング）ファイル一覧
    アーカイブ            ← 放送済みエピソードのテーマ・パネリスト・全発言テキスト・録音を蓄積
    エージェント日記       ← パネリスト（poolKey単位。MAXを含む）の一人称振り返り
                          （エピソード終了時にまとめて1回・フィルター・自動更新）

▾ 🎙️ My Secretary
    エージェント設定       ← 秘書のプロンプト・声・キャラクター設定
    学習項目             ← 「覚えておいて」で明示的に保存した学習内容
    学習内容             ← セッション終了時に会話全体から自動要約された学習内容
    エージェント日記       ← Secretary自身の一人称振り返り（セッション終了時にまとめて1回・
                          フィルター・自動更新）
    自律ループ設定        ← メール・予定・天気・ニュース・相場の定期チェック設定
                          （有効化・チェック間隔・クワイエットアワー・ソース別ON/OFF）
    Obsidian連携設定      ← PARA機能（会議準備・議事録・リサーチ・タスク管理）用のVault設定
                          （有効化・Vaultパス・フォルダ構成・デイリーレポート自動作成）

▾ ⚙️ システム管理
    発声辞書             ← 正規表現ベース TTS 発音辞書（変換プレビュー付き）
    AI管理者設定         ← 「💬 お問い合わせ・リクエスト」窓口の応答者（表示名・TTSエンジン・ボイス）
    ショートカットキー     ← マウス操作の代替となるキーボードショートカットを操作ごとに変更
    システム接続設定      ← Gemini / OpenWeatherMap / FRED / Google / Spotify API キー・Gmail フィルタ・
                          🚨緊急地震速報テスト（震源地入力＋マグニチュード選択・都道府県フィルタ）
    ログ                ← サーバーログビューア（レベルフィルター・自動更新）
    会話履歴             ← エージェントごとの発話履歴（フィルター・自動更新）
    番組録音             ← チャンネル別の放送録音・履歴・再生（Spotify 楽曲区間は自動スキップ。
                          My Secretaryは無音区間を自動スキップして圧縮。保存形式は
                          全チャンネル共通で MP3 / libmp3lame 96kbps）
    稼働レポート          ← 稼働状況・利用実績レポート（4タブ: 主要レポート／コストグラフ／
                          視聴記録／セッションレポート。既定は主要レポート）
    リリースノート        ← RELEASENOTE.md の内容を表示
```

### ディレクタへのリアルタイム指示

「ユーザーリクエスト」欄に入力して送信すると、次のターンから反映されます。  
例：「深夜モードで静かに進行してください」「Masatakaさんの誕生日を祝ってください」「雨にまつわる曲の特集をお願いします」

ディレクタ Gemini がリクエストを「特定曲リクエスト / テーマ特集 / 一般会話」の3種に自動分類し、適切なコーナーへルーティングします。

#### 全出演者へのダイレクトリクエスト

キャストを名指しで特定トピックへのリクエストが送れます。MAXが橋渡しセリフを生成して該当エージェントへ繋ぎ、2フェーズ発話でリクエストテーマを中心に Google Search を実施します。

| キーワード例 | ルーティング先 |
|---|---|
| 「高橋先生に日銀の利上げについて解説してほしい」 | 高橋洋二 教授（コメンテーター） |
| 「ジャーナリストXに政府の動きを調べてほしい」 | 謎のジャーナリスト X |
| 「ドレミさんにカブのレシピを教えてほしい」 | 平野ドレミ（生活アドバイザー） |
| 「北村弁護士に相続トラブルの相談をしたい」 | 北村昭雄 弁護士（法律相談） |
| 「大阪の天気を教えて」 | たかいち なえ（気象情報） |
| 「名古屋までの交通情報が知りたい」 | 片山夏樹（交通情報） |
| 「トヨタの株価について」 | マブチ マリーナ（金融情報センター） |

---

## システム監視ダッシュボード

`http://host:3001/dashboard` — 管理画面（`/admin`）とは別に、放送を裏で動かしている
全エージェントの稼働状況を横断的に見渡せる、読み取り専用の独立画面。設定変更UIは
一切持たない「常に眺めていられる監視用ダッシュボード」という位置づけで、`/admin`と
同じくViteの独立HTMLエントリポイント（`client/dashboard.html`）として実現している。

対象はLive/Classic/Jazz/Mood/Beatles/24/You/The Answers/My Secretaryの全チャンネル。
情報量に合わせて画面を3段に分けている（2026-09-15に見直し。段組みは`client/src/dashboard/dashboard.css`）。

- **上段: Live・My Secretary・The Answers の固定パネル**（情報が多いため大きく常時表示）
  - **Live**: 左半分に「いま」（話者・思考中エージェントのアバター、コーナー、再生中の曲）と
    **討論コーナー**（ニュースディープダイブ／インサイト・マネー）。討論コーナーはふだん
    「オン・オフ／前回いつ流れたか」だけを出し、準備中・進行中になると台本（誰がどの役で
    何番目に話すか）をアバターの列で広げ、取材メモが揃ったかも表示する。右半分は森田ディレクタの
    **編成**（ON AIR / NEXT / この後の予定 / 直近に放送）で、ニュース・金融の後に続く討論コーナーを
    「↳」で添える。編成は放送日単位で永続化されたキュー（[編成キューの永続化](#編成キューの永続化放送日単位)参照）
    のため、リスナーが切断してもその日のうちは残る
  - **My Secretary**: 会話の状態・自律監視チェック中、裏で動いているヘルパーの作業（走行中は全件、
    無ければ直近の1件）、LINEからの依頼
  - **The Answers**: 進行の段階と経過時間の棒、テーマ（3行まで）と狙い、出演者全員（話し中・考え中を強調）
- **中段: 音楽チャンネルの小タイル**（静寂のスコア〜24/You）: 1チャンネル3行（名前と状態／
  話し中の人・考え中の人・再生中の曲のうち最も大事なもの／最終接続）に省略する
- **下段: できごとの記録**: ふだんは1行に畳み、**注意が必要な出来事（エラー・地震速報・依頼の失敗）
  だけ**を直近3件まで出す。「すべて表示」で全チャンネル横断の全件を時系列で開ける（開閉はブラウザに記憶）。
  内部のイベント名やエージェントキーは表示せず、`client/src/dashboard/eventDescriptions.ts`
  の対応表で日本語へ置き換える。字幕データ（`CAPTION`）や15秒ごとの経過時間（`ROUND_TIMER`）の
  ように画面描画用で「出来事」ではないイベントは、同ファイルの`FEED_HIDDEN_EVENTS`で記録から除外している

画面幅が1440px以下のときは、Liveが1段まるごと使い、My SecretaryとThe Answersをその下に並べる。

なお「どのチャンネルがどれだけ聴かれ、どの曲が流れたか」という**統計**は、リアルタイム性の
無い別種の情報のため、この画面ではなく管理画面の[稼働レポート](#管理画面)のタブ「視聴記録」へ
集約している（2026-09-08に移設）。このダッシュボードは「いま何が起きているか」に専念する。

サーバー側は各チャンネルの既存WebSocketブロードキャストを`server.js`側でラップして
`/stream-dashboard`（詳細は[WebSocket イベント仕様](#websocket-イベント仕様)参照）
1本へ集約転送する設計のため、ダッシュボードのためにチャンネル実装（`agent-system.js`/
`channel-base.js`）の配信経路を変える必要は無い。討論コーナーの進み具合（`DISCUSSION_STATUS`）だけは
それまで流れていなかったため、`agent-discussion-corner.js`がLiveのブロードキャストへ追加で流している。

---

## AI Radio管理人（お問い合わせ・リクエスト）

プレイヤー左カラムの「💬 お問い合わせ・リクエスト」ボタン、またはキーボードショートカット
（デフォルト`Ctrl+Option+M`、[管理画面](#管理画面)「ショートカットキー」から変更可能）から起動できる、
質問・チャンネル操作・リクエストを1つの窓口で受け付けるテキストチャット。全チャンネル
（Live/Classic/Jazz/Mood/Beatles/24You）で利用可能。

以前はマイクボタン・キーボードショートカット・音声認識（STT）を使うハンズフリーの音声操作
アシスタントだったが、OS標準の音声入力（Typelessなど）がキーボード入力欄に対して十分な精度・速度で
使えるようになったため、アプリ内蔵の音声入力（録音・STT・ダッキング中の待受）は廃止し、テキスト
入力ひとつに一本化した（呼び出しショートカット自体は、窓口を開く用途としてそのまま引き継いでいる）。
AI管理者からの応答は引き続き音声で読み上げられる（テキストと音声を併用）。

### 操作フロー

```
1. 「💬 お問い合わせ・リクエスト」を開く（ボタンクリック or ショートカット）
2. ダッキング → GET /api/text-command/greeting の固定挨拶（先頭に「はい、○○さん。」、続けて
   画面のチャット欄冒頭と同じ文言「AI Radio管理人です。ご質問・チャンネル操作・曲や話題の
   リクエストなど、何でもどうぞ。」。チャンネル・放送状況に関わらず常にこの文言）を再生
   → ダッキング解除（待ち時間は無く番組音声はそのまま流れる）
3. テキストを入力して送信
4. POST /api/text-command（Gemini flash-liteで分類 → 応答テキスト生成）。この「考え中」の間も
   番組音声はダッキングしない
5. 応答をチャット欄にテキスト表示
6. 応答音声がある場合のみ、ダッキング → AI管理者の声で読み上げ → ダッキング解除
7. 実行可能なリクエスト（チャンネル切替・コーナー/曲リクエスト等）はその場で実行
```

応答再生用の音声出力には専用の`AudioContext`を使う。`fetch`完了後（ユーザー操作から数秒
経ってから）に素の`Audio`要素で再生しようとするとブラウザの自動再生ブロックで無音になることが
あるため、クリック/Enter/ショートカットの同期区間で`resume()`しておき、以降はこのContext経由で
`decodeAudioData`+`AudioBufferSourceNode`でスケジュール再生する。

`corner_request`/`content_request`/`recording_start`は、対象チャンネル・放送状況から実行可否を
`isVoiceCommandRequestFeasible`（`server/voice-command-classifier.js`）がコード側で決定的に判定する
（LLMの応答文言には依存しない）。実行不可の場合は固定文言「申し訳ありません。ご依頼いただいた
リクエストは処理できません。」に差し替えてディスクキャッシュ経由で合成するため、都度のTTS呼び出しを
避けられる（実行可能な場合の応答は引き続き内容に応じた動的な文言で、キャッシュ対象外）。

### 分類 intent 一覧

`server/voice-command-classifier.js` が入力テキストを1つのJSONに分類する。厳密なパターンマッチではなく、Gemini flash-liteに幅広い自然文を解釈させる方式。

| intent | 主なパラメータ | 内容 |
|---|---|---|
| `channel_switch` | `channel` | チャンネル切り替え |
| `stop` | — | 放送停止 |
| `the_answers_start` | `topic` | The Answers開始 |
| `volume_relative` / `volume_absolute` | `direction` / `value` | 音量操作 |
| `mute_toggle` | `state` | ミュート切り替え |
| `24you_mode` | `mode` 等 | 24/Youの選曲モード変更 |
| `corner_request` | `corner` | Live専用。特定コーナー（天気/交通/ニュース等11種）の指名。Live以外・未放送中の場合はクライアント側が自動でLiveへ切り替えてから実行 |
| `content_request` | `text` / `channel`（省略可） | 曲・話題等のリクエスト（Live/Classic/Jazz/Mood/Beatles共通）。「トワイライトラウンジに切り替えて〇〇をかけて」のように切り替えとリクエストが1文で求められた場合、`channel`に切り替え先が入り、クライアント側が自動で切り替えてから実行する |
| `recording_start` / `recording_stop` | `channel` | 番組録音の開始・停止（[管理画面](#管理画面)の「番組録音」と同じAPIを使用） |
| `sleep_timer` | `minutes` | スリープタイマーの設定・解除（時間指定を伴う停止指示。`minutes`がnullなら解除） |
| `show_recipes` | — | 保存したレシピの一覧を表示 |
| `the_answers_topic_suggest` | — | The Answersのテーマ候補を提案（`/api/the_answers/theme-candidates`を呼び、候補一覧をチャット欄にテキスト表示） |
| `info_query` | — | 上記いずれにも該当しない質問・雑談。番組コンテキスト（長期記憶・直近の会話・チャンネル再生履歴）を渡し、responseフィールドにその場で実際の回答を生成させる（取り次ぎではなく直接回答） |

`info_query`の回答は`server/server.js`の`buildBroadcastContext(channel)`が組み立てた文脈を
プロンプトに含めて生成する。これにより「今の話どう思う？」「さっきの天気コーナーの話だけど」
のような文脈依存の質問にもその場で答えられる。参照する内容はチャンネルによって異なり、Live は
長期記憶（直近30セッション）+ 現在の会話履歴（直近30件）、Classic/Jazz/Mood/Beatles/24You は
（ナレーションの会話ログを持たないため）そのチャンネル自身の`played_tracks.json`再生履歴
（直近20件）を使う。

### 長期記憶に保存される情報（Live チャンネルのみ）

番組終了（切断・サーバー停止）時に Gemini がセッションをサマリーして `long_term_memory.json` に保存します。

| フィールド | 内容 |
|---|---|
| `summary` | 番組全体の流れ（2〜3文） |
| `topics` | 話題キーワード（最大5個） |
| `music_played` | 流れた曲（アーティスト - 曲名・全曲） |
| `weather` | 天気コーナーで伝えた内容 |
| `world_report_city` | Steve のワールドレポート訪問都市 |
| `recipe` | ドレミのレシピ名・材料・ポイント |
| `news_headlines` | ニュースコーナーの見出し（最大5件） |
| `listener_notes` | リスナーのアクション（リクエストなど） |
| `agent_highlights` | 各エージェントの印象的な発言（最大6件） |

### API

```
GET  /api/text-command/greeting
Response: { "speechWavBase64": "..." }
  固定挨拶の音声（ディスクキャッシュ済み）。先頭にリスナー名での呼びかけ、続けて
  画面のチャット欄冒頭と同じ文言を読み上げる（チャンネル・放送状況に関わらず常に同じ）

POST /api/text-command
Body: { "text": "入力テキスト", "channel": "live" }
Response: { "intent": "...", "params": {...}, "message": "...", "speechWavBase64": "..." }
```

`channel` は `live` / `classic` / `jazz` / `mood` / `beatles` / `24you` のいずれか（省略時は放送していない扱い）。

### キーボードショートカット

マウス操作なしでも一通り操作できるよう、主要な操作にキーボードショートカットが割り当てられています。
[管理画面](#管理画面)「システム管理 › ショートカットキー」から操作ごとに変更可能。入力欄にフォーカスが
ある間は無効化されます。設定は`config.shortcuts.<action>`（`{ ctrlKey, altKey, metaKey, shiftKey, code }`、
`code`は`KeyboardEvent.code`でレイアウト非依存）に保存され、未設定時はデフォルト値にフォールバックします。

| action | デフォルト | 内容 |
|---|---|---|
| `open_inquiry` | `Ctrl+Option+M` | 「💬 お問い合わせ・リクエスト」を開閉 |
| `mute_toggle` | `Ctrl+Option+U` | ミュート切替 |
| `volume_up` / `volume_down` | `Ctrl+Option+↑` / `↓` | 音量を10ずつ増減 |
| `toggle_connection` | `Ctrl+Option+X` | 選択中チャンネルへの接続/切断（The Answersは対象外） |
| `show_recipes` | `Ctrl+Option+R` | 保存したレシピの表示切替 |
| `channel_live`〜`channel_the_answers` | `Ctrl+Option+1`〜`7` | 各チャンネルへの切り替え（1:Live 2:Classic 3:Jazz 4:Mood 5:Beatles 6:24You 7:The Answers） |
| `corner_weather` | `Ctrl+Option+W` | 【Live専用】天気コーナーをリクエスト |
| `corner_traffic` | `Ctrl+Option+T` | 【Live専用】交通コーナーをリクエスト |
| `corner_news` | `Ctrl+Option+N` | 【Live専用】ニュースコーナーをリクエスト |
| `corner_finance` | `Ctrl+Option+F` | 【Live専用】金融コーナーをリクエスト |
| `corner_commentator` | `Ctrl+Option+C` | 【Live専用】コメンテーターコーナーをリクエスト |
| `corner_journalist` | `Ctrl+Option+J` | 【Live専用】X情報（ジャーナリスト）コーナーをリクエスト |
| `corner_music_dj` | `Ctrl+Option+D` | 【Live専用】DJコーナーをリクエスト |
| `corner_life_advisor` | `Ctrl+Option+L` | 【Live専用】ライフコーナーをリクエスト |
| `corner_world_report` | `Ctrl+Option+G` | 【Live専用】ワールドレポートコーナーをリクエスト |
| `corner_legal_advisor` | `Ctrl+Option+H` | 【Live専用】法律コーナーをリクエスト |
| `corner_comedian` | `Ctrl+Option+B` | 【Live専用】世間ばなし（お笑い芸人）コーナーをリクエスト |
| `corner_doctor` | `Ctrl+Option+E` | 【Live専用】健康・医療（医師）コーナーをリクエスト |
| `corner_marketer` | `Ctrl+Option+K` | 【Live専用】トレンド解析（マーケター）コーナーをリクエスト |
| `corner_activities` | `Ctrl+Option+S` | 【Live専用】スケジュール確認をリクエスト |

`corner_*`はLiveチャンネル選択中（`selectedChannel === 'live'`）のみ有効。それ以外のチャンネルでは
押しても何も起こらない（他チャンネルには対応するコーナー概念自体が無いため）。

音量・ミュート・チャンネル切替・レシピ表示は「💬 お問い合わせ・リクエスト」欄のテキスト指示
（「音量を50にして」等）でも実行できますが、そちらはLLM分類を経由するぶん一呼吸遅れるため、
頻繁に使う操作は直接ショートカットで即座に反応させる想定です。

### 将来の拡張予定

`info_query`は現在、全テキストをプロンプトに直接渡す方式。セッション数が増えた際には
`conversation_history.jsonl` の全発話を Gemini Embedding API でベクトル化し、ベクトル DB
（Qdrant など）で意味的検索を行う **RAG（Retrieval-Augmented Generation）** 方式へ移行予定。

### かつての乱入（オーナー割り込み）・音声入力について

ウェイクワード時代は、音声トリガーで番組へ割り込みディレクタと直接会話する「乱入」機能が
存在した。ウェイクワード廃止でその唯一の起動経路が失われ、機能的にも本セクションの
AI Radio管理人（`content_request`）と同等の役割になったため、コードごと削除済み。
乱入が持っていた挙動のうち音楽キーワード即時キュー投入（`_instantMusicRequestIfDetected()`、
`server/agent-system.js`。発話/入力中の音楽キーワードを検出すると分類結果を待たずに`music_dj`
コーナーを即座にキューへ追加する、`POST /api/direction`の`instantMusicCheck: true`フラグ経由）
のみ、Liveチャンネルの`content_request`に引き継がれている。

その後導入したマイクボタン・キーボードショートカットによる音声操作（Gemini STTでの文字起こし）も、
OS標準の音声入力で十分に代替できるためコードごと削除し、テキスト入力に一本化した
（応答の音声読み上げ自体は継続）。

---

## My Secretary（会話型AI秘書）

Live/Classic/Jazz/Mood/Beatles/24You/The Answersと同格の**第8のチャンネル**。他チャンネルの
「複数リスナー共有のブロードキャスト」とは異なり、選択すると接続ごとに専用の Gemini Live API
セッション（双方向リアルタイム音声ストリーミング、`gemini-3.1-flash-live-preview`）が張られ、
起動と同時に秘書側からプロアクティブに挨拶する。マイクに向かって話しかけると自然な会話が続く
（AI Radio管理人のようなテキスト入力ではなく音声対話）。

エージェント名・声・キャラクター設定は[管理画面](#管理画面)の独立メニュー「🎙️ My Secretary」から
変更可能（`config.agents.secretary`）。

自律監視ループ（下記）が検知済みの未消化通知があれば、接続する前のTopのウェルカム画面時点で
チャンネルボタンの絵文字が🙋‍♀️に切り替わり、「伝えたいことがある」状態を一目で確認できる
（`GET /api/secretary-notifications/pending-count`、`pending.json` を非消費でポーリング）。

### 構成: Liveは発話専任、実処理はヘルパーが担う（2026-08-27）

Gemini Live は1秒未満のターン交代を前提とした仕組みで、その中で数十秒〜数分かかる処理を
同期実行すると「会話が固まる」か「切られる」かにしかなりません。タイムアウトの延長では
原理的に解決しないため、**会話（発話）と実処理を分離**しています。

```
リスナー発話
  ↓
Gemini Live（発話のみ担当）→ ask_helper でジョブ投入
  ↓                            ↓ 裏でヘルパーが最後まで実行（時間制限なし）
「受け付けました」と即答      │   ・既存ツールでデータ取得
                              │   ・Pythonのコード実行で計算・作図（決定的）
                              ↓ 完了
              セッションが空いた瞬間に結果を注入 → 読み上げ＋画面表示
```

- **Liveに残したツールは7個だけ** — `get_current_time`／`remember_fact`／`show_on_canvas`／
  `end_session`／`ask_helper`／`get_job_status`、および `consult_agent`。
  `consult_agent` だけは成果物が「専門エージェント本人の声」であり、それを再生できるのは
  Liveの経路だけのためここに残しています（ヘルパー経由にすると本人の声が失われ、秘書が
  代読する別物になります）。データに触れる依頼はすべて `ask_helper` を通ります
- **ヘルパー**（`server/lib/secretary-helper-agent.js`） — 既存ツールに加えGeminiのコード実行
  （pandas/matplotlib）を持つツール呼び出しループ。ロジックはAIが担い、算術はコード実行が
  決定的に保証します。ジョブは `secretary-job-store.js` に記録され、完了結果は
  `secretary-live-session-registry.js` 経由でLiveセッションへ届きます（生成中なら次のターンまで
  保留、未接続なら `pending.json` へ持ち越し）
- **渡すツールは依頼ごとに絞る**（`server/lib/secretary-tool-groups.js`） — 毎ターン44機能の定義
  （約6,000トークン）を送っていたため、LLMが「どの機能を呼ぶか」決めるだけで2.2〜12.6秒と
  大きく振れていました。11の分野＋常時渡すcoreに束ね、その回に要る束だけを渡すことで
  入力を12,372→977トークンへ削減しています。あわせて**読み取りだけの依頼では書き込み系19機能を
  そもそも渡しません**（渡っていなければ呼びようがない、というのが唯一確実な歯止めのため。
  誤判定で詰まないよう `use_more_tools` で後から束を足せます）
- **所要時間で同期/非同期を振り分ける方式は採っていません** — 実運用で破綻したためです
  （`get_emails` が12.6秒で枠を超えた瞬間、Liveが同じツールを二度呼びキャンバスが3回
  書き換わりました）。中間状態を作らず、Liveに残した一瞬の操作か `ask_helper` かの二択にしています

裏で走っているジョブは[システム監視ダッシュボード](#システム監視ダッシュボード)に独立した軸で
表示されます（会話が待機中でも作業が走るため、これが無いと何も動いていないように見えるため）。

### 現在できること（2026-08時点）

| カテゴリ | 話しかけ方の例 | 内容 |
|---|---|---|
| リスナー認識 | 「私の趣味は何でしたっけ？」「今日は何か特別な日？」 | `config.show.user_profile`の全項目（生年月日・居住地・職業・趣味・興味・好きな音楽・特別な日）を認識。特別な日は当日該当なら自動的に話題にできる |
| 予定確認 | 「今日の予定を教えて」「来月3日は空いてる？」 | Googleカレンダーを取得（既定は今日から7日間、`from_date`/`days`で最大90日先まで指定可）。回答の先頭に「確認した範囲: 〇〇から〇日間」が必ず付き、範囲外を「予定なし」と誤って断言しないようにしている |
| メール確認 | 「メールをチェックしてまとめて」 | Gmail未読（直近24時間）を取得し、高/中/低/無視の4段階に自動分類。「高」は返信下書きも生成。分類結果は`server/data/secretary/areas/email-logs/`に保存される |
| タスク確認 | 「未完了のタスクを教えて」 | Google Tasksの未完了一覧を取得 |
| ニュース | 「最新ニュースを教えて」「AI関連のニュースをワールドワイドで」 | Yahoo Japanニュースの見出し・概要を取得（最大8件）。`scope="world"`で海外メディア（TechCrunch/VentureBeat/MIT Technology Review、経済系はCNBC）からも実URL付きで取得できる。話題を指定すると`topic`引数でタイトル一致による絞り込みを行う（「テクノロジー」「経済」等カテゴリ全体を指す言葉はフィード分類との同義語照合で対応。モデルの目視判断ではなくコード側の決定的な一致判定） |
| 天気 | 「今日の天気は？」 | 居住地のOpenWeatherMap予報（地震・台風・警報情報を含む） |
| 金融情報 | 「日経平均は？」「マーケットの状況は？」 | 管理画面に登録済みの金融ウォッチリストの最新値 |
| 資産の詳細質問 | 「PayPay銀行のNISAつみたて枠の収益は？」「楽天証券で一番増えているファンドは？」 | 直近の週次金融資産レポート作成時（下記Obsidian連携）のスナップショットから、保有ファンドごとの評価金額・評価損益・口座区分・騰落率を答える（`get_finance_details`、Obsidian連携有効かつ一度レポート作成済みの場合のみ）。スクリーンショットの再分析はせず、順位付けの質問（「騰落率の高い順に5件」等）はサーバー側で決定的にソートしてから渡す |
| 交通情報 | 「首都高の渋滞状況は？」 | 専用データソースが無いため、Gemini Live標準のGoogle検索グラウンディングでリアルタイムに調べて回答（Liveチャンネルの交通コーナーと同じ方式） |
| 専門家への相談 | 「北村先生にこのメールの法的な良し悪しをチェックしてもらって」「報道センターに読んでもらって」 | AI Radioに出演している専門エージェント（`news`/`weather`/`finance`/`commentator`/`journalist`/`world_report`/`legal_advisor`/`life_advisor`/`music_dj`/`caster`/`assistant`/`comedian`/`doctor`/`marketer`）に、放送とは無関係の個人的な相談として意見を求める。**回答はその本人の声（設定済みのTTS）で再生される**（秘書が「少々お待ちください」と繋いでから再生し、終わったら会話を継続する） |
| 学習・記憶 | 「これは覚えておいて」 | リスナーの訂正・好み・発見を`server/data/secretary/memory/learnings.json`へ永続化し、次回接続時にも参照する（詳細は下記「学習・記憶（セッションをまたいだ永続化）」を参照） |
| Spotify | 「今何が流れてる？」「よく聴く曲を教えて」「〇〇で検索して」「このプレイリストに追加して」 | 現在再生中・再生履歴・よく聴く曲の確認、楽曲検索、保存済みの曲・プレイリスト一覧の確認、新規プレイリスト作成・曲追加ができる（`server/services/spotify-user-service.js`、Liveチャンネルの再生SDKとは別実装）。一時停止・再開・スキップ・音量変更のような実際の再生操作はできない |
| YouTube動画検索 | 「〇〇に関する動画を探して」「〇〇の動画で再生数が多いものを教えて」 | YouTube Data API v3のキーワード検索（`search_youtube_videos`）。再生数順・新着順等の並び替えに対応し、再生数順の場合はサーバー側で実測値をもとに正確に再ソートする（`server/services/youtube-service.js`、APIキーのみで動作） |
| YouTube登録チャンネルの新着確認 | 「登録チャンネルで新しい動画は出てる？」「ここ24時間で新着ある？」 | 本人が登録しているチャンネルの中から、直近アップロードされた動画を確認する（`get_new_subscription_videos`）。youtube.readonlyスコープでの追加のOAuth認証が必要（Googleの制約によりCalendar/Gmail等とは別の独立した認証フロー。管理画面の「YouTubeでサインイン」から連携） |
| 予定を追加 | 「明日15時に会議を入れて」 | Googleカレンダーに予定を新規作成 |
| 予定を変更・削除 | 「〇〇の予定を〇時に変更して」「その予定はキャンセルして」 | Googleカレンダーの既存の予定を変更・削除（`update_calendar_event`/`delete_calendar_event`）。対象は必ず直前の`get_calendar`で取得したイベントIDで特定し、同名の予定を取り違える事故を防ぐ |
| メール下書き作成 | 「返信の下書きを作って」 | Gmail下書きを作成（送信はしない。必ず本人がGmail上で確認・送信する） |
| タスク追加 | 「牛乳を買うタスクを追加して」 | Google Tasksに新規タスクを追加 |
| Driveファイル操作 | 「議事録をDriveに保存して」 | Google Driveにテキストファイルを新規作成/追記・更新（Secretary自身が作成したファイルのみ操作可能） |
| 画面表示（キャンバス） | 「メールをまとめて画面に出して」「株価をグラフで見せて」「天気図を見せて」 | メールサマリー・株価一覧・レシピ等をMarkdownで（Mermaid記法によるグラフ表示にも対応）、または気象情報センターが使う地上天気図・衛星画像を画像として画面（キャンバス）に表示。上書きではなく追記していき、セッション終了時にクリアされる。表示された内容ごとに**コピー**（他アプリへ貼る用。画像は`ClipboardItem`で画像として載せる）と**Obsidianへ保存**（`01_Notes`へフロントマター付きで保存。画像はvault内へ実ファイルとして書き出し`![[...]]`で参照）の2つのボタンが付く |
| データの分析・作図 | 「資産台帳を読んで2口座のドローダウングラフを作って」「この数字を集計してグラフにして」 | ヘルパーがGeminiのコード実行（pandas/matplotlib）でデータを処理し、結果のグラフを画面に表示する。**ロジックはAIが担い、算術はコード実行が決定的に保証する**ため、モデルに暗算させて実在しない数値を創作させる事故が構造的に起きない。グラフ種類ごとのツールを増やす必要も無い（matplotlibが何でも描くため） |
| ファイル分析 | 画面から任意のファイルを添付し「これに対して主な収益と費用の変化を要約して」 | 形式は問わずアップロードして分析（20MBまで）。対応できない形式はGemini API呼び出し自体がエラーを返す。URLを声で伝える手間・誤認識を避けるため、Gemini Live WSとは別のHTTPエンドポイントでアップロードし、file_idのみをWS経由で伝える設計。ファイルはセッション終了時に自動削除される |
| URL・長文の情報共有 | 画面のテキスト共有欄にURLや長文を貼り付けて「このシートの売上傾向を教えて」「このページを要約して」 | 音声では伝えにくい情報（URL・長文等）を共有する汎用欄。システム側では内容の分類を一切行わず、共有された生テキストをそのままSecretaryへ渡し、GoogleスプレッドシートのURLか一般WebページのURLかの判断はSecretary自身が行う。GoogleスプレッドシートはGoogle連携（`spreadsheets.readonly`）経由で1シートあたり300行×30列まで、一般Webページは単純なHTTP取得＋本文抽出で対応 |
| 過去のやり取りの振り返り | 「LINEで何を頼んだっけ？」「さっき話した件だけど」「今日は何をお願いした？」 | 音声・LINE両方の窓口での過去のやり取りを`conversation_history.jsonl`から読み出す（`get_secretary_history`）。実装上は音声（Gemini Live）とLINE（通常のgenerateContent）で別経路だが、リスナーから見れば同じ秘書への依頼であるため、経路をまたいで参照できるようにしている。ツール宣言は`buildSecretaryTools`に集約されておりLINE側も同じものを使うため、「音声→LINE履歴」「LINE→音声履歴」の両方向に効く。**参照できるのは秘書自身とのやり取りのみ**で、リスナーが他の人と交わした個人間のLINEトークはLINE APIが外部提供しておらず読めない |
| 会話終了 | 「もう大丈夫です、ありがとう」「切断して」 | 別れの挨拶を話してから、自動的にTopのウェルカム画面へ戻る |

会話中に取得した予定・タスク・ニュース・天気・金融情報は`server/data/secretary/areas/daily-briefings/`
に、Secretary利用のセッション・トークン数・概算コストは[稼働レポート](#管理画面)の
「My Secretary」フィルタから確認できる。

リスナー・秘書双方の発話内容（音声認識テキスト）は、Liveチャンネルの各エージェント発話と
同じ既存の会話履歴（`server/data/conversation_history.jsonl`、管理画面「システム管理 →
会話履歴」タブ）にそのまま記録される。リスナー発話は`secretary_user`、秘書自身の発話は
`secretary`というagentKeyで、Gemini Live標準の音声文字起こし（`inputAudioTranscription`/
`outputAudioTranscription`）を1ターンごとに蓄積して書き込む。`consult_agent`で委任した
専門エージェントの回答も、本人のagentKey（`news`/`legal_advisor`等）でそのまま記録されるため、
放送中の発言と秘書経由の個人的な相談が同じ履歴ビューアで時系列に並んで確認できる。

### 専門エージェントへの相談（本人の声）と使い分け

「専門家への相談」がいつ秘書自身の声になり、いつ本人の声に切り替わるかは、相談相手によって
2パターンに分かれる（`server/routes/secretary-live-routes.js`のツール定義・システムプロンプトで
制御）。

**① データ取得ツールを持つ3エージェント（news / weather / finance）— 名指しの有無で分岐**

名指しせずに一般的に聞くと、秘書が自分でデータを取得してそのまま読み上げる。エージェントを
名指しすると、そのデータを本人（設定済みのTTS）に渡して相談し、回答を本人の声で再生する。

| 言い方 | 呼ばれるツール | 声 |
|---|---|---|
| 「天気を教えて」 | `get_weather` | 秘書 |
| 「気象情報センターに繋いで天気を教えて」 | `consult_agent(weather)` | 気象情報センター本人 |
| 「ニュースを教えて」 | `get_news` | 秘書 |
| 「報道センターに読んでもらって」 | `consult_agent(news)` | 報道センター本人 |
| 「日経平均は？」 | `get_finance` | 秘書 |
| 「金融情報センターに聞いて」 | `consult_agent(finance)` | 金融情報センター本人 |

**② データ取得ツールを持たない11エージェント（commentator / journalist / world_report /
legal_advisor / life_advisor / music_dj / caster / assistant / comedian / doctor / marketer）
— 常に本人の声**

これらは①のような「秘書が代わりに読める専用データ」がそもそも無く、`consult_agent`で相談する
以外に呼び出す方法が無い。そのため「北村先生にこのメールの法的リスクを見てもらって」のように
最初から名指しで相談する形になり、常に本人の声で回答する（秘書代読との分岐は無い）。

**③ 専用データソースを持たず、Google検索で自ら調べるエージェント（traffic）— 常に本人の声**

交通情報センターには`newsService`のような専用データサービスが無いが、放送中のコーナーと同じく
Google検索グラウンディングで自らリアルタイム情報を取得して回答する。②と同じく`consult_agent`で
名指しして相談する形になり、常に本人の声で回答する。プロフィールの居住地・最寄り駅・よく使う
道路（`traffic_areas`）が渡されるため、リスナーに関係の深い路線・道路を優先して調べる。

**相談時に本人へ渡されるもの**

`consult_agent`は、放送中の`_buildCornerContext`（`server/agent-system.js`）と同じ材料を
同じ関数から取得して渡す。これにより「放送に出ている本人」と「秘書経由で相談される本人」が
同じ蓄積を共有する。

| 渡すもの | 取得元 | 対象 |
|---|---|---|
| 持ち場の実データ | `newsService`/`weatherService`/`financeService`（`get_*`ツールと同一インスタンス） | news / weather / finance |
| Google検索グラウンディング | モデルに`googleSearch`ツールを付与（放送側の交通情報コーナーと同じ） | traffic |
| リスナープロフィール全項目 | `formatListenerProfile()`（`secretary-profile-format.js`） | 全15エージェント |
| リスナー像ダイジェスト | `secretaryMemory.getListenerDigestForPrompt()` | 全15エージェント |
| 本人の日記からの自己学習 | `_getAgentDiarySelfDigest()`（`agent-diary-feedback.js`が週次生成） | 全15エージェント |
| 他エージェントの関連知見 | `agentDiary.searchDiaryEntries()`（日記の横断キーワード検索、相談内容とキーワードが重なる他者の日記のみ） | 全15エージェント |

リスナープロフィールは一部の項目を選んで渡すのではなく、居住地・職業・趣味・興味・音楽の
好み・特別な日（家族の誕生日等）まで全項目を渡す——「あなただけのAIラジオ」を成立させて
いる情報であり、どのエージェントに繋いでも判断材料として使えるようにするため。天気・交通は
一時滞在地（`config.show.temp_stay`）が有効期間中ならそちらを優先する（放送側の
`_getEffectiveLocation()`と同じ判定を`_getEffectiveLocationFromConfig()`で行う）。

データ源を持つ4エージェント（news / weather / finance / traffic）には「渡された実データ・
検索結果以外を創作しない」制約も併せて指示する（取得に失敗した場合は、推測せず取得できて
いない旨を伝える）。なお、Google検索を付与するのは専用データソースを持たないtrafficだけで、
他のエージェントには付けない——調べ物は担当エージェントのデータ源に委ねる方針のため。

### 学習・記憶（セッションをまたいだ永続化）

Gemini Liveの1接続は毎回まっさらな状態から始まり、会話中に得た訂正・好みはそのままでは
接続が切れた瞬間に失われる。`server/lib/secretary-memory.js`が`server/data/secretary/memory/learnings.json`
に学習内容を永続化し、接続のたびに直近30件をシステムプロンプトへ注入することで、セッションを
またいだ学習を実現している。2つの経路で学習内容が増える。

- **明示的な保存**: リスナーが「これは覚えておいて」のように依頼すると、`remember_fact`ツール
  （Function Calling）で即座に保存される（確実・低コスト）
- **自動要約**: セッション切断のたびに、その回の会話全体を`gemini-3.1-flash-lite`で振り返り、
  訂正・好み・発見をJSON構造化出力で自動抽出して保存する（メールの優先度分類と同じ軽量モデル・
  パターンを踏襲。極端に短い会話は対象外）

学習内容は管理画面「My Secretary → 学習項目」（明示的な記憶）・「学習内容」（自動要約）の
各タブで確認でき、各項目の✏（編集）・🗑（削除）から訂正・除去できる（`GET /api/secretary-memory`・
`PUT`/`DELETE /api/secretary-memory/:id`）。自動要約が事実と異なる内容を記録することが実際に
あったための機能で、IDは「その時点のlistから採番」する方式のため、削除で欠番ができても
外部からの手動編集と整合性が保たれる。また、発音の取り違えを防ぐため、
`config.show.user_profile.name_reading`（管理画面「番組設定(Live) → リスナー情報」の
「名前の読み方（ひらがな）」欄）にリスナー名の読み方を設定すると、システムプロンプトの
最重要事項として毎回注入される（他チャンネルの発声辞書による決定的なテキスト置換と異なり、
Gemini Liveは音声対音声モデルのため確実性までは保証できないが、唯一の対策となる）。

**【2026-08-09追加】リスナー情報ダイジェストの全エージェントへの配信**: 上記の学習内容
（`learnings.json`）はこれまでMy Secretary自身の会話にしか反映されず、Live/Classic/Jazz/
Mood/Beatles/The Answersの他エージェントはリスナーについて何も学習できなかった。
`summarizeListenerDigest`（`server/lib/secretary-memory.js`）が学習内容全件を
`gemini-3.1-flash-lite`で3〜5文の人物紹介文へ要約し`server/data/secretary/memory/digest.json`
へ保存する（セッション終了のたびに更新を試みるが、前回生成時から学習内容に変化が無ければ
LLM呼び出しをスキップする）。この要約は「AI秘書がこれまでの会話から学んだリスナー像」として、
Liveの全13コーナー（`_buildCornerContext`の共有プリアンブル）、Classic/Jazz/Mood/Beatlesの
ディレクターによるセッション企画、The Answersのテーマ選定（リスナー指定議題が無い場合）に
それぞれ注入される。曲ごとの紹介・コメント生成のような高頻度メソッドへは意図的に配線しておらず、
セッション単位の企画判断にとどめている。

このダイジェストは全エージェントへ配信される性質上、誤った要約が生成されると影響範囲が広いため、
管理画面「My Secretary → 学習内容」に表示・編集用のカードを設けている
（`GET /api/secretary-digest`・`PUT /api/secretary-digest`）。手動で編集すると
`manuallyEdited: true`が付き、その文章は`manualCore`として保持される。

**【2026-09-12改訂】** 当初は`manuallyEdited`が立つと`summarizeListenerDigest`による自動再生成を
**丸ごとスキップ**していたが、これは「一度直すと永久に凍る」という副作用を持っていた。実際に
2026-09-02の手直し以降9日間まったく更新されず、その間に増えた83件の学習（証券会社・契約中の
サービス・保有ファンド等）が全エージェントへ一切届かなくなっていた。UIからの解除手段も無かった。
現在は再生成を止めず、**`manualCore`を一字一句そのまま残したうえで、そこに含まれない新しい事実
だけをモデルに書かせて後ろへ連結する**方式へ変更している（確定情報と食い違う学習は採用させない）。
手で直した内容をAIが黙って上書きしないという原則は維持したまま、学習の反映が止まらないようにした
（📌明示的な学習内容が自動圧縮の対象外なのと同じ考え方）。なお全文を書き直させる方式も試したが、
同関数の「3〜5文程度」という指示と衝突して確定情報の側が圧縮されて消えたため採用していない。

### 自律監視ループ（Phase 1.5）

秘書が接続していない間も、メール・カレンダー・天気・ニュース・金融を定期的にチェックし、
知らせる価値のある変化があれば次回接続時のプロアクティブ挨拶でまとめて報告する
（`server/lib/secretary-loop.js`）。無駄なLLM消費を避けるため、2段階構成にしている。

- **Stage A（判定・LLM不使用）**: 新着メールのID差分・カレンダーの直近予定・天気の
  警報フラグ・ニュース見出しの緊急キーワード・株価変動率の閾値超過を、すべてコード側の
  決定的な比較だけで判定する。変化が無ければLLMは一切呼ばれない
- **Stage B（作文・LLM、条件付き）**: Stage Aで1件でも変化が見つかった場合のみ、まとめて
  `gemini-2.5-flash-lite`を1回だけ呼び、秘書らしい一言に要約する

サーバー側は5分ごとの軽いベースティックでチェックし、実際の判定間隔・有効無効は
`config.secretary_loop`から都度読み直す。管理画面「My Secretary → 自律ループ設定」から
以下を編集できる。

| 設定項目 | 内容 | デフォルト |
|---|---|---|
| 有効/無効 | ループ自体のON/OFF | 無効 |
| チェック間隔 | 何分おきに判定するか | 20分 |
| クワイエットアワー | この時間帯はチェックしない | 23:00〜07:00 |
| セッション終了後のクールダウン | 会話終了直後は何分休むか | 30分 |
| 予定の何分前から知らせるか | カレンダーの先読み時間 | 30分 |
| 相場変動の通知閾値（株式・指数等） | 何%変動したら知らせるか | 3% |
| 相場変動の通知閾値（投資信託） | 投資信託は個別株ほど大きく動かないため別枠で設定 | 1% |
| チェック対象 | メール／予定／天気／ニュース／相場をそれぞれON/OFF | 全てON |

**【2026-08-15追加】Liveチャンネルへのデータ共有（実験）**: 上記のStage Aが検知した
メール・カレンダー・天気・ニュース・金融の変化シグナルを、秘書への通知用（`pending.json`、
接続時に消費されクリアされる）とは別に、`server/data/secretary/memory/live_signal_feed.json`
へ非破壊で記録している。Liveチャンネルのディレクター（森田）が編成サイクルを組み立てる際
（`_requestDirectorCycleDecision`）、この直近シグナルを追加のグラウンディングとして読み取り、
「大きな話題」の判断材料に加えられる。あわせて、資産の構成比（％。銘柄別の資産クラスごとの
比率のみで、評価額・評価損益等の絶対額は含めない）を`finance_public_summary.json`として算出し、
Liveの金融情報センターへ注入している。三浦さんの意向により、まずはLiveチャンネル限定の実験
として実装しており、他チャンネルへは配信されない。

### Obsidian連携（Phase 2・PARA機能）

会議準備・議事録・リサーチ・タスク管理は、独自のJSONストアを持たず、**実際に運用している
Obsidian Vaultへ直接読み書きする**方式で実装している（`server/services/obsidian-service.js`）。
Vaultはローカルフォルダなので、Obsidianアプリの起動は不要。管理画面「My Secretary →
Obsidian連携設定」で有効化・Vaultの絶対パス・各フォルダ名を設定する。

**安全設計（最優先事項）**: LLM経由の会話から間接的に呼ばれるため、他の書き込み系ツールより
一段階慎重なガードを設けている。

- パストラバーサル防止 — どんなパスも必ずVaultルート配下に解決されることを検証
- 既存ファイルの上書き禁止 — 新規ノート作成は既存ファイルがあれば必ずエラーになる設計。
  デイリーノート等への「追記」は別関数（既存内容は絶対に消えない）
- 作成したノートには`source: ai-radio-secretary`のフロントマターを自動付与し、
  ご自身のノートと区別できるようにする

**保存先マッピング**:

| 秘書の操作 | 保存先 |
|---|---|
| 「これメモしておいて」 | デイリーノートの「AI秘書との記録」セクションに追記 |
| 「今日のレポートを作って」 | デイリーノートの「🌤️ 天気」「📅 本日の予定」「📰 主なニュース」「💰 金融情報」「🍳 本日のおすすめレシピ」セクションを更新 |
| 「今日の業務ログをまとめて」 | デイリーノートの「昨日の業務内容」「報告事項」「所感」セクションを更新（三浦さんがテンプレートに追加した見出しにあわせて記入） |
| 「〇〇について調べて」 | プロジェクト指定あり: `<プロジェクト>/Research/`、無し: `01_Notes/` |
| 「〇〇プロジェクトの会議ノートを作って」 | `<プロジェクト>/Meetings/YYYY-MM-DD 議題名.md` |
| 「〇〇プロジェクトにタスク追加」 | `<プロジェクト>/_Secretary-Tasks.md`（Secretary専有ファイル） |
| ドレミのレシピを保存（Live画面の🔖ボタン） | `01_Notes/クッキングレシピ/<レシピ名>.md`（画像は同フォルダの`images/`へJPEGで書き出し、ノートから`![[...]]`で参照）。フォルダ名は管理画面の「レシピフォルダ名」で変更できる |

**デイリーレポートの自動作成**: `create_daily_report`は既存の天気・ニュース・金融データ取得
（get_weather/get_news/get_financeと同じサービス）を再利用する。データ取得自体はLLMを使わない。
台風情報・銘柄別の株価一覧のような複雑な構造を読みやすいMarkdownテーブルへ整形するため、
軽量モデルを1回だけ使う（三浦さんの要望・正規表現による自前パースより形式の揺れに強い方式を
選択）。整形に失敗しても元のテキスト（最低限の箇条書き整形）へ確実にフォールバックするため、
情報が失われることはない。
【2026-08-09更新】地震情報・時間帯別予報・ニュース見出し・経済マーケットニュースは、数値や
リンクを一切改変してはいけないデータのため正規表現による決定的な変換へ切り替えている
（地震情報が複数行に分裂して重複表示されるバグを機に、LLM任せをやめた）。
【2026-09-22更新】気象警報・注意報は、朝に読むレポートでは「今日これから効く情報」になるため、
ノート冒頭のコールアウトとして掲載する（`_extractWeatherWarningSection`。出ていない日は作らない。
夜にまとめていた頃は「その時点での警報でレポートとしては意味を持たない」として除去していた）。
「今日の気温」は`secretary-loop.js`が
2時間おきに記録する実測スナップショットと残り時間帯の予報（OpenWeatherMap無料APIの仕様上
3時間刻み固定）を1本の連続した気温系列としてつなげ、最高/最低の要約とMermaid xychart-beta
（データラベル付きの棒グラフ）で可視化する（天気予報API・未来のみでは埋まらない「本日の変化」を、
実測と予報の継ぎ目を意識させずに表示する設計。実測と予報で記録間隔が異なるため、グラフ後半
[予報部分]の間隔が粗くなる点は意図的な仕様）。あわせて「昨日の気温」（前日の実測だけで作る。
記録が無い日は欄ごと省く）を後ろへ置き、並びを「今すぐ効くもの → 今日 → 昨日」にしている。
朝に要るのは今日の動きのため、明日の詳細予報は載せない。ニュース・経済マーケットニュースは、Yahoo!のRSSフィード自体に
説明文が含まれていないことが判明したため、各記事ページの`og:description`メタタグを個別取得して
実際の要約を補う（見出しの出典リンクはMarkdownリンクとして付与。件数は主要8件のまま。
放送コーナー用のNewsService/FinanceServiceとは別インスタンスのため放送への影響は無い）。
会話中の依頼に加えて、指示が無くても毎日**朝7時30分**以降、その日まだ未作成であれば自動的に
作成される（この時刻は固定・管理画面から変更不可。`secretary-loop.js`の`DAILY_NOTE_TRIGGER`）。
【2026-09-22更新】従来は23時50分の「その日の終わりにまとめるもの」だったが、朝の仕事を始める
前に読むノートへ移した。7時30分なのは、金融の確定値の締めが毎朝7時（`finance-service.js`の
`DAILY_ANCHOR_HOUR`）であり、これより前へ動かすと前日の値になるため。カレンダーの予定と
残っているToDoから組み立てる「📅 本日の予定」（日時と件名は事実のためLLMに通さない。
連携していない・取得に失敗したときは欄ごと省く）と、今日の天気と予定を材料に生活アドバイザーが
1品だけ提案する「🍳 本日のおすすめレシピ」もこのとき書き込む。自律監視ループの5分ベースティックに
相乗りするが、判定はクワイエットアワー等のガードとは完全に独立している。
【2026-08-13追加】天気セクションの末尾に、気象庁の天気図とひまわり衛星画像を画像として
埋め込む（キャンバス表示用の`show_weather_map`と同じ取得処理を再利用しているため、新しい
外部APIは増えていない）。画像は`obsidian-service.js`の`writeBinaryAsset`（Vaultルート配下への
解決を`resolveSafePath`で検証してから書き込むバイナリ版）で
`08_assets/daily-weather/YYYY-MM-DD-weathermap.png`・`-satellite.webp`のように日付入りの
ファイル名で保存し、ノートからは`![[...]]`で参照する（日付を入れないと、後日の実行で過去日の
ノートが参照している画像まで上書きされてしまうため）。天気テキストの取得に失敗しても画像だけは
書き込まれる。「現在のお天気」の行は、日を通したレポートとしては意味を持たないため
`_stripCurrentWeatherLine`で除去する（最高/最低気温の抽出後に除去するため気温サマリーは残る）。

**業務ログの自動作成**: `report_daily_activity`は、その日secretaryStoreに記録された会話中の
ツール呼び出し（予定確認・メール確認・ファイル分析・専門エージェントへの相談等）から、
軽量モデルで「昨日の業務内容」「報告事項」「所感」の3つを1回のGemini呼び出しでまとめて
生成する（デイリーレポートと異なりこちらはLLM呼び出しが発生する）。天気・ニュース・金融の
自動作成と同じトリガー条件（有効/無効・朝7時30分固定の実行時刻）を流用しつつ、独立した日付ゲートで管理しているため、
どちらか一方が失敗してももう一方の自動実行には影響しない。その日まだ会話が無ければ何もせず、
次のチェックで再判定する。【2026-09-22更新】朝の作成に移したのに伴い、材料は**前日分**の
記録（`readEntriesForDate`）を読む。

**ノート間のwikilink**: プロジェクトに`_MOC.md`（Map of Content）が存在する場合、会議ノート・
リサーチノート・タスク一覧のフロントマターの`project`フィールドが実際のwikilink
（例: `[[02_Projects/AI Radio/_MOC]]`）になる。また、これらのノートを新規作成した日は、
その日のデイリーノートの「🔗 関連ノート」セクションに自動でリンクが追記され、デイリーノートが
「その日生まれた成果物のハブ」として機能する（同じファイルへの2件目以降の追記ではリンクは
増えない）。

**【2026-08-14追加】週次レポート（ウィークリーノート）**: デイリーノートとは別に、毎週日曜
23時50分（`secretary-loop.js`の`DAY_END_TRIGGER`。終わっていない週をまとめてしまうため、
デイリーノートと違い朝へは移していない）に1週間分のノートを`config.obsidian.weekly_notes_folder`
（既定`04_Weekly Notes`）へ自動作成する。ファイル名はその週の月曜日の日付。5つのセクションを
`setSectionContent`で冪等に書き込むため、自動バッチと会話内の手動再実行のどちらが先でも
正しく合成される。

- **天気の週間振り返り**: `secretary-loop.js`が2時間おきに記録している実測スナップショット
  （weather-history）から、月〜日の7日分を曜日別の最高/最低気温・代表天気として集計する
- **来週の天気予報**: OpenWeatherMap無料枠は5日先までしか取得できないため、気象庁の週間予報API
  （`https://www.jma.go.jp/bosai/forecast/data/forecast/{都道府県コード}.json`・無料・認証不要・
  7日先まで取得可能）を新規統合した（`weather-service.js`の`fetchWeeklyForecast`）。JMAの
  天気コードは信頼できる変換表が入手できなかったため、先頭桁による粗いカテゴリ分類
  （晴れ/くもり/雨/雪）に留めている
- **今週の主なニュース**: 「網羅ではなく注目すべき数件だけ」という設計のため、日次レポート
  生成時にその日の見出しを`weekly-news-log`へ構造化データのまま蓄積しておき（新規API呼び出し
  なし）、週次生成時に`gemini-3.1-flash-lite`で3〜5件へ厳選・重複統合する
- **秘書の週間活動記録**: `report_daily_activity`の週次版。`daily-briefings`/`email-logs`を
  7日分読み、1回のGemini呼び出しで日付別の活動と所感をまとめる
- **週次金融資産レポート**: リスナーが`config.obsidian.rakuten_screenshot_folder`・
  `paypay_screenshot_folder`（既定`20_asset_data/Rakuten`・`20_asset_data/PayPay`）へ
  あらかじめ保存しておいた証券会社・銀行の資産状況スクリーンショットのうち、更新日時が
  最も新しい1枚ずつを選んでGemini Visionで読み取る（ログイン・スクレイピングは一切
  行わない）。資産合計・前週比・ファンド別の評価金額/評価損益/口座区分・Mermaid円グラフ
  （ファンド名で合算・上位8件＋その他）・保有ファンドごとの騰落率（評価損益／取得元本）を
  まとめる。会話内トリガー用に`update_finance_report`ツールがあり、「今週の資産状況を
  まとめて」のような依頼で同じ処理を即座に実行できる。**画像は複数枚溜まる想定**（三浦さんが
  毎週追加していく運用）のため、当初はファイルのmtimeが前回と同じなら再分析をスキップする
  設計だったが、「週末に更新できない週は古いデータのままでよいので空のレポートにはしないで
  ほしい」という実地要望を受け、画像が1枚でも見つかれば常に分析するよう変更している
  （プロアクティブな更新リマインドのみ、`secretary-loop.js`の`checkFinanceScreenshotReminder`が
  土日にmtime比較で1日1回案内する）

**資産についての個別質問**: 上記の週次レポート作成とは別に、「PayPay銀行の新NISAのつみたて枠の
収益は？」のような自由な角度からの質問に、`get_finance_details`ツールが直近のスナップショット
（`finance-snapshots`）から即座に回答する。スクリーンショットの再分析は行わないため応答は一瞬で、
追加のAPI費用も発生しない。「騰落率が高い順に5件」のような順位付けの質問は、低レイテンシ優先の
音声対話モデルが暗算しきれず実在しない数値・銘柄名を出力してしまう事故が実地で確認されたため、
`sort_by`（rate/valuation/gain_loss）・`order`引数でサーバー側が決定的にソートしてから返す設計に
している。画面（キャンバス）表示は、内訳の比較・推移には`show_on_canvas`のMermaid
`xychart-beta`、構成比・ポートフォリオには`pie showData`（円グラフ）が使える。

### Inbox/Outboxバッチ処理（2026-08-21追加・2026-09-01に全ツール対応へ作り直し）

会話中の依頼とは別に、Obsidian Vaultの`<inbox_folder>/secretary/`（既定`00_Inbox/secretary`）
に依頼メモ（.md、自由記述）を置いておくと、`secretary_loop.js`が定期的に検知して非同期に
処理する「秘書へのバッチ処理」機能（`server/lib/secretary-inbox.js`）。会話を介さず依頼できる
ため、思いついたときにメモを残しておけば、次にMy Secretaryと話さなくても結果だけ受け取れる。

当初は「調査してレポート化」のみに対応を限定していたが、データ取得・コード実行・専門
エージェントへの相談を要する多段の依頼（例: 「PayPay銀行のNISAデータを名寄せしてグラフを
作り、高橋教授に評価してもらってObsidianへ保存して」）を実行できなかったため、Live会話の
`ask_helper`と全く同じ`runHelperJob`＋全ツール経由へ作り直した。

- **メタ情報抽出**: 依頼文をGemini（通常の`generateContent`、Live APIではない）でタイトル・
  プロジェクト名のみ軽く解釈する（`_extractRequestMeta`）。以前あった「実行可能かどうか」の
  事前判定は廃止した——`runHelperJob`のシステム指示が「対応できなかった場合は何ができなかった
  かを一言で書く」という振る舞いを既に持っているため、事前に弾く意味が無くなった
- **実行**: `secretary-job-store`でジョブを作成し、`runHelperJob`（Live会話の`ask_helper`と
  共通、コード実行・スプレッドシート読み取り・`consult_agent`を含む全ツール付き）に依頼文を
  渡して実行する
- **画像保存**: 結果に画像（グラフ等）が含まれる場合、`08_assets/secretary-inbox/`配下へ
  保存しレポート本文に埋め込む
- **保存**: `save_research_report`（会話中に使うツール）と全く同じ保存ロジック・命名規則で
  `<notes_folder>`または`<projects_folder>/<project>/Research/`へレポートノートを保存する
- **結果通知**: `<outbox_folder>/secretary/`（例: `09_outbox/secretary`）へ、「完了しました」
  または対応できなかった理由を記した結果ノートを1件作成する（レポート本文はコピーせず、
  wikilinkのみ）
- **後始末**: 処理済みの依頼メモは`<inbox_folder>/secretary/_done/`（対応不可・エラー時は
  `_failed/`）へ移動する。次回のスキャンでは対象から外れるため、状態管理は不要
- カレンダーの予定変更等、三浦さん自身のGoogleアカウント内で完結する操作も含め、Live会話と
  同じ範囲のツールが解禁されている（送信系ツール自体が存在しないため、外部への情報流出の
  リスクは無い）
- 重い処理（数十秒〜分）は5分間隔の軽量チェック（メール・カレンダー等の差分確認）を
  ブロックしないよう、`tick()`からawaitせずfire-and-forgetで実行する
- 管理画面「My Secretary → Obsidian連携設定」の「Outboxフォルダ名」が空欄の間は、この機能
  自体が無効になる（既存のInbox運用には一切影響しない）

### LINE連携（2026-08-21追加）

ブラウザでの音声会話とは別に、My Secretary専用のLINE公式アカウントを通じて、LINEの
トーク画面からテキストでやり取りできる（`server/lib/secretary-line.js`・
`server/routes/line-webhook-routes.js`）。予定の確認・変更・削除、メール確認・下書き
作成、Obsidianノート作成等、音声版とほぼ同じツール群がFunction Calling経由で使える
（画面表示＝キャンバス機能のみ音声チャンネル専用のため対象外）。

- **受信**: LINE側から`POST /line_webhook`へWebhook通知が届く。`X-Line-Signature`
  ヘッダーをチャネルシークレットでHMAC-SHA256検証し、送信者の`userId`があらかじめ
  管理画面で登録した本人のIDと一致する場合のみ応答する（第三者が公式アカウントを
  友だち追加しても一切応答しない）
- **処理**: Live/音声Secretaryと異なり、Gemini Live APIではなく通常の`generateContent`で
  Function Callingの多ターンループを自前で回す。ツール実行層（`executeSecretaryTool`）・
  ツール宣言の集約（`buildSecretaryTools`）はいずれも音声版とそのまま共有しており、
  新規の重複実装は無い。会話コンテキストは`conversation_history.jsonl`の
  `secretary_line_user`/`secretary_line`エントリから直近分を都度読み込む
- **送信**: `replyToken`を使うReply API（無料、受信への応答専用）を基本とし、失敗時
  （トークン期限切れ等）のみPush API（月200通まで無料）へフォールバックする
- **本人確認の登録**: 管理画面「My Secretary → LINE連携設定」で有効化。あなたの
  userIdが未登録の間は誰にも応答しない安全設計のため、公式アカウントへ一度何か
  メッセージを送ると、その送信元userIdが管理画面に表示される（LINE Developers
  コンソールの「Your user ID」からも取得可能）ので、それを登録する

**ngrokトンネルの自動起動**: LINE Webhookはこのローカルサーバーへ外部から到達できる
必要があるため、固定ドメインのngrokトンネル（`ngrok http 3001 --url=<固定ドメイン>`）を
別途起動しておく必要がある。「システム管理 → 認証情報設定 → 🌐 ngrokトンネル自動起動」を
有効にすると、AI Radioサーバー起動時にトンネルの稼働状況をngrokのローカルAPI
（`127.0.0.1:4040/api/tunnels`）で自動確認し、未起動なら`server/lib/ngrok-launcher.js`が
自動的に起動する（`ngrok`コマンドがPATHに無い等で失敗しても、サーバー本体の起動には
影響しないベストエフォート設計）。LINE専用の設定ではなく外部公開が必要な機能全般で
使う汎用インフラのため、`config.line`とは独立した`config.ngrok`に設定を持たせている。

### プレゼンテーション作成（Google Slides）

「この件をリサーチしてスライドにまとめて」のような依頼で、編集可能なGoogle Slidesの
プレゼンテーションを生成する（`create_presentation`）。

#### テンプレートは利用者の資産（Presentation Creator）

レイアウトをコードが組み立てる方式では、1つ増やすのにコードの7か所を直す必要がありました。
**テンプレートは利用者がSlidesの画面で作る資産**とし、コードは中身を一切知らず、その場で
読み取って流し込むだけにしています。

| ファイル | 役割 |
|---|---|
| `server/lib/presentation-template.js` | テンプレートを読み取り、見本スライド・差し込み口・分量の目安・サムネイルをマニフェスト化する。Drive の `modifiedTime` をキーにディスクへキャッシュする |
| `server/lib/presentation-render.js` | 描画の原始的な道具のみ。レイアウトごとの分岐を持たないため、レイアウトを増やしてもこのコードは変わらない |
| `server/lib/presentation-creator-agent.js` | 専用ヘルパー。`get_template_info`／`add_slide`／`look_at_slide`／`revise_slide`／`set_deck_variables` を使って作る |
| `server/lib/presentation-config.js` | `presentation-design.md` のテンプレート登録・既定値・フォント別名を読む |
| `server/build-standard-template.js` | 標準テンプレート（見本スライド11枚・アイコン付き）の構築スクリプト |

- **見本スライド方式** — 意味的な名前は画面外に置いた `{{LAYOUT_NAME:3カード比較}}` から取り、
  `duplicateObject` で複製してからスライド単位で置換します。Slidesの「レイアウト」機能を
  ライブラリに使う案は、①レイアウト名をAPIで変更できない（`updateLayoutProperties` が存在しない）
  ②プレースホルダーを新規に作れない ③**レイアウト上の `{{変数}}` はスライド単位で置換できない**
  （レイアウトのテキストは継承表示されているだけで実体が無いため）の3点で成立しませんでした
- **描く→見る→直すループ** — サムネイルAPIが任意のページに効くため、自分の出力を画像で確認して
  直せます。従来の一発生成では原理的に不可能だった「文字があふれている」「余白が死んでいる」
  といった、見れば分かる欠陥を自分で潰せるのがこの方式の最大の価値です
- **レイアウト選択はサムネイルを見て行う** — 差し込み口の名前一覧だけで選ばせると、埋める手間の
  少ない箇条書きへ流れます（実際にそうなっていました）。Google既定のレイアウト11種は選択肢から
  除外しています（テンプレート作者が作った構図こそがそのデッキのデザイン語彙であるため）
- **アイコン** — Material Symbols Outlined が合字でSlidesに描画できることを実測で確認し、53個を
  検証済みリストとして持っています。存在しない名前は英字がそのまま出て崩れるため、リスト外は
  代替へ倒して警告を残します
- **グラフ** — Google Sheetsへデータを書き込みリンク貼り付け（`createSheetsChart`）するため、
  生成後もSheets側で元データを直接編集できます。COLUMN/BAR/LINE/AREA/SCATTER/PIE の6種類
- **プロンプトの二層構造** — 基本（目的・ターゲット・枚数・トーン）とデザイン（配色・フォント・
  レイアウト・図解・余白）の既定値をすべて `server/data/presentation-design.md` に置き、
  会話での指定（`purpose`/`audience`/`slides`/`tone`/`style`/`template`）が優先されます
- **旧方式との振り分け** — テンプレートが1つも登録されていない場合は、従来の固定6レイアウト方式で
  作ります（テンプレートは利用者が用意する資産であり、無い状態では新方式が動けないため）。
  両方式は完全に独立しており、この分岐だけが接点です
- **利用要件** — Google OAuthで `presentations`・`spreadsheets`（読み書き）スコープの許可に加え、
  Google Cloud ConsoleでSlides/Drive/Sheets各APIが有効化されている必要がある

テンプレートの作り方・拡張手順は[スライド生成の拡張ガイド](docs/presentation-guide.md)を参照。

### 接続の制限（セッションタイムアウト・アイドル自動切断）

Gemini Live側の仕様で、1回の接続は10〜15分程度で自動的に打ち切られる（打ち切り直前に
`goAway`メッセージが届く）。【2026-08-14】以前はこの`goAway`を受けて予告の上で切断していたが、
「会話が続いているのに切られるのは困る」との指摘を受け、`sessionResumption`（会話の文脈を
保持したまま新しい接続へ引き継ぐGemini Live APIの機能）に対応した。`goAway`受信後、
1往復のやり取りが完結したタイミングでバックグラウンドに新しい接続を確立し、`setupComplete`が
取れた瞬間にリスナーには一切気づかせず古い接続と入れ替える（会話の途中で音声が途切れることは
無い）。再開用のハンドルがまだ無い極端なケースのみ、従来通り「一言お別れの挨拶をしてから
閉じる」にフォールバックする（`server/routes/secretary-live-routes.js`の
`startSessionResumption`）。

一方、この仕組みにより「会話が続いている間は無期限に延命され得る」ようになったため、
接続したままリスナーが実質的に離席した状態（発話・turnComplete・ツール呼び出しのいずれも
無い）が5分続くと、自動的に接続を終了する安全弁を別途設けている（`SECRETARY_IDLE_TIMEOUT`
イベント→クライアント側で専用のトースト表示）。マイクが接続されたまま無音の音声データが
送られ続けるだけでは「活動」とみなさない。

意図しない切断（アイドル自動切断・ネットワーク断等）が起きた場合は、トースト通知の上で
自動的にTopのウェルカム画面へ戻る（意図的な「会話を終了」操作とは区別して扱われる）。

### まだできないこと

- **Slack・Facebook・note連携**: 未実装（Facebook/noteは個人データ取得のAPI制約が大きく、実現可能性の調査が別途必要）

---

## WebSocket イベント仕様

| チャンネル | 接続先 | 備考 |
|---|---|---|
| Live | `ws://host:3001/stream` | マルチエージェント生放送 |
| Classic（静寂のスコア） | `ws://host:3001/stream-classic` | クラシック音楽専門 |
| Jazz（琥珀色のインプロヴィゼーション） | `ws://host:3001/stream-jazz` | ジャズ専門（英語 DJ、日本語訳テロップ付き） |
| Mood（トワイライト・ラウンジ） | `ws://host:3001/stream-mood` | ムードミュージック・映画音楽専門 |
| Beatles（Eight Days A Week） | `ws://host:3001/stream-beatles` | The Beatles 楽曲専門 |
| 24/You | `ws://host:3001/stream-24you` | ナレーションなし AI 選曲チャンネル |
| 通知専用 | `ws://host:3001/notifications` | 音声を持たない JSON 専用。**ページロード時に接続される**ためウェルカム画面でも受信できる。緊急地震速報（`EARTHQUAKE_ALERT`）と、システム異常の発生・解消（`SYSTEM_ALERT` / `SYSTEM_ALERT_CLEARED`。AI利用料金の残高不足など。現在有効な異常は `GET /api/system-alerts` でも取得できる）を配信する |

形式：受信はバイナリ（PCM 音声）＋ JSON テキスト（イベント）

### イベント分類（`cat` フィールド）

すべての JSON イベントには `cat` フィールドが付与されます。  
**端末側がどのハードウェアを持つか・どのイベントをどの動作にマッピングするかは端末側で決定します。**  
サーバーは意味的なイベントのみを送信し、LED 点灯・LCD 表示・通知音などの具体的な動作は規定しません。

| `cat` | 意味 | 対象 |
|---|---|---|
| `program` | 番組進行に直接関わる情報 | すべての受信端末（スマートフォン、ブラウザ） |
| `system` | サーバー稼働状況・モード変更など | 必要に応じて処理 |
| `debug` | デバッグ・開発用の詳細情報 | ブラウザ管理画面向け（他のクライアントは無視して問題ない） |

---

### 接続直後に届くイベント

WebSocket 接続が確立されると、直ちに `CAST_LIST` が送信されます。  
端末側はこの情報を使って、エージェントキーとハードウェア動作（LED 色・チャンネルなど）の対応表を初期化してください。

`cast[]` は Live チャンネルの `config.json` の `agents` オブジェクトを `Object.entries` して動的に構築されます（`name` が設定されているエージェントのみ）。`role` はサーバー内の `ROLE_LABELS` マップから日本語ラベルに変換されますが、このマップには `world_report` / `life_advisor` / `legal_advisor` のエントリが無いため、これら3エージェントの `role` は日本語ラベルではなく**キー名がそのまま入ります**（実装上の既知のギャップ）。

```json
{
  "event": "CAST_LIST",
  "cat": "program",
  "cast": [
    { "key": "director",     "name": "森田（ディレクタ）",          "role": "ディレクター" },
    { "key": "caster",       "name": "Max（キャスター）",            "role": "キャスター" },
    { "key": "assistant",    "name": "Clara（アシスタント）",        "role": "アシスタント" },
    { "key": "weather",      "name": "たかいち なえ",               "role": "気象センター" },
    { "key": "traffic",      "name": "片山夏樹",                    "role": "交通センター" },
    { "key": "news",         "name": "いけがみ あきらめ",            "role": "報道センター" },
    { "key": "finance",      "name": "マブチ マリーナ",              "role": "金融センター" },
    { "key": "commentator",  "name": "高橋洋二 教授",               "role": "コメンテーター" },
    { "key": "journalist",    "name": "謎のジャーナリスト X",         "role": "ジャーナリスト" },
    { "key": "world_report", "name": "Steve（ワールドレポート特派員）","role": "world_report" },
    { "key": "music_dj",     "name": "DJ サキ",                     "role": "DJ" },
    { "key": "life_advisor", "name": "平野ドレミ",                  "role": "life_advisor" },
    { "key": "legal_advisor","name": "北村昭雄（弁護士）",          "role": "legal_advisor" }
  ],
  "program": "通常",
  "slot": "morning",
  "ts": 1748654400000
}
```

---

### サーバー → クライアント（`cat: "program"`）

番組進行情報。スマートフォン・ブラウザなど、受信端末すべてが処理すべきイベント群。

| イベント | フィールド | 内容 |
|---|---|---|
| `CAST_LIST` | `cast[]` `program` `slot` | 接続直後に1回送信。出演者一覧（key・name・role）|
| `AGENT_SPEAKING` | `agent` `name` | エージェントの発話開始。`agent` はエージェントキー（`caster` など）|
| `AGENT_SILENT` | `agent` `name` | エージェントの発話終了 |
| `BGM_START` | `title` `artist` `duration_sec` | BGM 開始（曲名・アーティスト）|
| `BGM_STOP` | — | BGM 停止（緊急停止時）|
| `BGM_END` | — | BGM セグメント終了（通常終了）|
| `CORNER_START` | `name` `corner` | コーナー開始（コーナー名・内部キー）|
| `SHOW_INFO` | `name` `slot` | 番組・スロット情報（`morning`/`daytime`/`evening`/`night` など）|
| `SHOW_RESUME` | — | 番組進行再開 |
| `SHOW_STANDBY` | — | リスナー未接続・番組スタンバイ中 |
| `NOTIFY` | `message` | 通知メッセージ（コーナー完了・API エラーなど）|
| `MUSIC_PLAY_START` | `title` `artist` | Spotify 楽曲再生開始 |
| `MUSIC_PLAY_END` | `title` | Spotify 楽曲再生終了 |
| `SPOTIFY_PLAY` | `uri` `title` `artist` `durationMs` | ブラウザ側 Web Playback SDK に再生を指示 |

---

### サーバー → クライアント（`cat: "system"`）

サーバー稼働状況・モード変更などの運用情報。

| イベント | フィールド | 内容 |
|---|---|---|
| `HEARTBEAT` | `ts` | 定期生存確認（30秒間隔）|
| `MODE` | `mode` | 番組モード変更（`normal`/`midnight`/`quiet`）|

---

### サーバー → クライアント（`cat: "debug"`）

開発・デバッグ用の詳細情報。ブラウザ管理画面以外のクライアントは無視して問題ありません。

| イベント | フィールド | 内容 |
|---|---|---|
| `AGENT_THINKING` | `agent` `state` | Gemini 生成状態（`state: "start"/"end"`）|
| `SYSTEM_ERROR` | `code` `message` | エラー通知 |
| `VOLUME` | `bgm` `tts` | 音量レベル（高頻度）|
| `BGM_DUCK` | `state` | BGM ダッキング状態（`"start"/"end"`）|
| `CORNER_QUEUE_UPDATE` | `current` `next` `queue[]` `recent[]` | サイクルモニター更新（現在・次・残りキュー・直近履歴）|
| `DISCUSSION_STATUS` | `key` `name` `state` `plan[]` `stepIndex` `turns` `research` `researchChars` | 討論コーナーの進み具合（`state: "preparing"/"running"/"finished"/"cancelled"`。`plan` は `{agent, role}` の台本、`research` は取材の状態 `"running"/"done"/"empty"/"failed"`）。ダッシュボード表示用で、再生画面は使わない |
| `DISCUSSION_SETTINGS` | `corners` | 再生画面で討論コーナーのオン・オフが切り替えられた（`config.show.discussion_corners` の現在値）|
| `CORNER_REQUEST_QUEUED` | `corner` | コーナーリクエスト受付済み |
| `CORNER_REQUEST_DUPLICATE` | `corner` | コーナーリクエスト重複 |
| `DIRECTOR_INSTRUCTION` | `instruction` | ディレクション指示受信 |

---

### クライアント → サーバー（Live チャンネル）

| イベント | フィールド | 内容 |
|---|---|---|
| `CORNER_REQUEST` | `corner` | コーナーリクエスト（`weather`/`traffic`/`news`/`finance`/`commentator`/`journalist`/`world_report`/`music_dj`/`life_advisor`/`activities`）|
| `SPOTIFY_PLAY_DONE` | `title` `artist` | ブラウザ側 Spotify 再生完了通知（サーバーの待機を解除）|

### サーバー → クライアント（Classic チャンネル固有）

| イベント | フィールド | 内容 |
|---|---|---|
| `CLASSIC_PLAYED_LIST` | `list[]` | 再生済み楽曲リスト（最新20曲）。`composer` / `composition` / `period` / `performers[]` / `conductor` / `ensemble` / `albumName` / `trackName` / `playedAt` |
| `CLASSIC_QUEUE_UPDATE` | `queue[]` | 再演奏リクエストキュー現在状態 |

### クライアント → サーバー（Classic チャンネル）

| イベント | フィールド | 内容 |
|---|---|---|
| `SPOTIFY_PLAY_DONE` | `title` `artist` | Spotify 再生完了通知（Live と同じ形式）|
| `CLASSIC_REPLAY_REQUEST` | `track` | 再演奏リクエスト（`composer` / `composition` / `period` / `spotify_query` / `trackName`）|

### サーバー → クライアント（Jazz チャンネル固有）

| イベント | フィールド | 内容 |
|---|---|---|
| `JAZZ_PLAYED_LIST` | `list[]` | 再生済み楽曲リスト（最新20曲）。`artist` / `title` / `album` / `playedAt` |
| `JAZZ_QUEUE_UPDATE` | `queue[]` | 再演奏リクエストキュー現在状態 |

### クライアント → サーバー（Jazz チャンネル）

| イベント | フィールド | 内容 |
|---|---|---|
| `SPOTIFY_PLAY_DONE` | `title` `artist` | Spotify 再生完了通知（Live / Classic と同じ形式）|
| `JAZZ_REPLAY_REQUEST` | `track` | 再演奏リクエスト（`artist` / `title` / `album` / `spotify_query`）|

#### `CAPTION`（Jazz 固有・日本語訳テロップ）

| イベント | フィールド | 内容 |
|---|---|---|
| `CAPTION` | `agent` `text` | Louis（`jazz_personality`）の英語セリフの日本語訳。`text` が空文字の場合はクリア信号（クライアントは自身のスクロール完了まで表示を継続し、即座には消さない）|

### サーバー → クライアント（Mood チャンネル固有）

| イベント | フィールド | 内容 |
|---|---|---|
| `MOOD_PLAYED_LIST` | `list[]` | 再生済み楽曲リスト（最新20曲）。`artist` / `title` / `category` / `composer` / `film_title` / `performers[]` / `albumName` / `trackName` / `playedAt` |
| `MOOD_QUEUE_UPDATE` | `queue[]` | 再演奏リクエストキュー現在状態 |

### クライアント → サーバー（Mood チャンネル）

| イベント | フィールド | 内容 |
|---|---|---|
| `SPOTIFY_PLAY_DONE` | `title` `artist` | Spotify 再生完了通知（Live / Classic と同じ形式）|
| `MOOD_REPLAY_REQUEST` | `track` | 再演奏リクエスト（`artist` / `title` / `category` / `composer` / `film_title` / `spotify_query`）|

### サーバー → クライアント（Beatles チャンネル固有）

| イベント | フィールド | 内容 |
|---|---|---|
| `BEATLES_PLAYED_LIST` | `list[]` | 再生済み楽曲リスト（最新20曲）。`title` / `album` / `year` / `performers[]` / `albumName` / `trackName` / `playedAt` |
| `BEATLES_QUEUE_UPDATE` | `queue[]` | 再演奏リクエストキュー現在状態 |

### クライアント → サーバー（Beatles チャンネル）

| イベント | フィールド | 内容 |
|---|---|---|
| `SPOTIFY_PLAY_DONE` | `title` `artist` | Spotify 再生完了通知（Live / Classic と同じ形式）|
| `BEATLES_REPLAY_REQUEST` | `track` | 再演奏リクエスト（`title` / `album` / `year` / `spotify_query`）|

### サーバー → クライアント（24/You チャンネル固有）

24/You はナレーション・エージェントが一切無いため、上記チャンネルのような発話系イベント（`AGENT_SPEAKING` 等）は発生しない。

| イベント | フィールド | 内容 |
|---|---|---|
| `24YOU_PLAYED_LIST` | `list[]` | 再生済み楽曲リスト（最新200曲）。`title` / `artist` / `albumName` / `albumImage` / `releaseYear` / `uri` / `playedAt` |
| `24YOU_MODE_UPDATE` | `mode` `anokoro_age` `favorite_artists[]` `wagamama_request` `language_pref` | 選曲モード・各モード設定の変更通知（`mode`: `omakase`/`anokoro`/`artist`/`shinpu`/`wagamama`）|

### クライアント → サーバー（24/You チャンネル）

24/You はリクエスト機能が無く、選曲モードの切り替えは WebSocket ではなく `POST /api/24you/mode` で行う（[管理画面](#管理画面)参照）。

#### Spotify 再生フロー

```
サーバー                       ブラウザ（Web Playback SDK）
    │                              │
    │──── SPOTIFY_PLAY ───────────>│ uri / title / artist / durationMs
    │                              │  → player.play(uri) で楽曲フル再生
    │                              │  → durationMs 後に player.pause()
    │<─── SPOTIFY_PLAY_DONE ───────│ title / artist
    │  番組進行再開・BGM 復元       │
```

---

### サーバー → クライアント（ダッシュボード専用: `/stream-dashboard`）

[システム監視ダッシュボード](#システム監視ダッシュボード)専用のWebSocket。他チャンネルのような
音声配信は行わずJSONイベントのみで、上記の各チャンネルWSで実際に流れているイベント（`AGENT_SPEAKING`/
`AGENT_THINKING`/`CORNER_START`/`CORNER_QUEUE_UPDATE`/`SYSTEM_ERROR`/`SPOTIFY_PLAY`/`MUSIC_PLAY_START/END`/
`24YOU_MODE_UPDATE`/`DISCUSSION_STATUS`/`DISCUSSION_SETTINGS`/The Answers系イベント等）をそのままチャンネルタグ（`channel`フィールド）付きで
集約転送する（`server/lib/dashboard-hub.js`の`wrapWithDashboardForward`）。高頻度な`HEARTBEAT`は除外される。
`CHANNEL_RESET`の後もLiveの編成キュー・討論コーナーの前回の状態・オン・オフの設定は引き継がれ、
準備中・進行中だった討論コーナーは`interrupted`（中断）に書き換えられる。

| イベント | フィールド | 内容 |
|---|---|---|
| `DASHBOARD_SNAPSHOT` | `channels` | 接続直後に1回送信。全チャンネルの直近状態スナップショット（状態の即時復元用）|
| `CHANNEL_CONNECTED` | `channel` | そのチャンネルへ最初のリスナーが接続した瞬間（0人→1人以上）|
| `CHANNEL_RESET` | `channel` `lastSession` | 最後のリスナーが切断した瞬間。コーナー・再生中トラック等は空に戻るが、`lastSession`（開始〜終了時刻）だけは引き継がれる |
| `SECRETARY_ACTIVITY` | `state` | My Secretaryの会話中の稼働状態（`idle`/`searching`/`speaking`）。1対1のGemini Live中継のため専用フックで生成 |
| `SECRETARY_LOOP_STATUS` | `state` | secretary_loop（5分ベースの自律監視tick）の実チェック区間（`checking`/`idle`）|
| `SECRETARY_CONSULTING` | `agentKey` `agentName` | `consult_agent`の「本人の声」再生中の委任先。再生終了時は両フィールドが`null`|
| `SECRETARY_LINE_REQUEST` | `state` `requestText` `replyExcerpt` `error` | LINE経由の依頼の処理状況（`processing`/`idle`）。LINEはHTTP Webhookで音声セッションと独立しているため、`CHANNEL_RESET`でも表示は消えない |
| `DIARY_WRITTEN` | `agentKey` `agentName` `corner` `excerpt` | エージェント日記の書き込み。本文は非公開のため短い抜粋のみ（全文は[管理画面](#管理画面)で閲覧）|

---

### JSON イベントの共通構造

```json
{
  "event": "AGENT_SPEAKING",
  "cat":   "program",
  "agent": "caster",
  "name":  "Max（キャスター）",
  "ts":    1748654400000
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `event` | string | イベント名 |
| `cat` | string | `"program"` / `"system"` / `"debug"` |
| `ts` | number | Unix タイムスタンプ（ミリ秒）|
| その他 | — | イベント固有フィールド（上表参照）|

---

## 音声パイプライン

### サーバー側

```
[Gemini テキスト生成]
  （交通・ジャーナリスト・DJ・生活アドバイザー: Google Search グラウンディング使用）
  （コメンテーター: IMF/FRED/e-Stat/Yahoo Finance データ注入後に生成）
        ↓
[組み込み TTS 正規化]  日付・助数詞の促音・十六方位・大きな数値など（_builtinNormalizeTtsText）
        ↓
[ユーザー発音辞書]  tts_dict.json から読み込んだ正規表現ルールを適用
        ↓
[汎用辞書による読み補正]  UniDic（lindera-wasm-unidic-nodejs）で2文字以上の
                         名詞・形状詞の読みを自動補正（dictionary-reading-format.js）
        ↓
[Gemini TTS]  →  PCM/WAV（24kHzネイティブ・失敗時は Google Translate TTS へフォールバック）
        ↓
[ffmpeg]  →  s16le 24kHz mono PCM
           + ラウドネス正規化（EBU R128: loudnorm -14 LUFS / LRA 7 / TP -1）
             ※ Spotify 楽曲と同等の音圧に揃え、キャスター音声が BGM に埋もれない
        ↓
[AudioMixer.injectTalkAudio()]
        ↓
[ミキシング]  BGM（MP3 → s24le 24kHz stereo シャッフル再生）
           + TTS（24kHzネイティブ生成のためリサンプリング不要 → s24le 24kHz stereo）
           + ステレオパン（等パワーパン則: caster -0.65 ↔ assistant +0.65 など左右対称定位）
           + ダッキング（TTS 発話中 BGM を通常時は約 15% に減衰。Steve のワールドレポートなど
             アンビエント音声再生中は現在のアンビエント音量の半分・最低 6% まで減衰）
        ↓
[WebSocket バイナリ送信]  1152フレーム × 6バイト = 6,912バイト/パケット
        ↓
24kHz / 24bit / Stereo PCM
```

### クライアント側（Web Audio API）

```
[WebSocket バイナリ受信]
        ↓
[s24le → Float32 変換]（メインスレッド）
        ↓
[AudioWorkletNode へ転送]  Transferable ArrayBuffer（ゼロコピー）
        ↓
[PCMRingProcessor] ← AudioWorklet（専用オーディオスレッド）
  ・5秒分ステレオ Float32 のリングバッファ（起動時1回だけ確保・GCなし）
  ・300ms プリバッファ後に再生開始（バースト到着対策）
  ・バッファ不足時はフェードアウトで無音に（プツッとならない）
        ↓
[GainNode（masterGain）]  ← ボリュームスライダーで gain.value をリアルタイム変更
        ↓
[AudioContext] → スピーカー出力

※ Spotify 楽曲は Web Playback SDK が独立して出力（setVolume() で同期制御）
```

> **AudioWorklet 採用の背景**  
> 旧実装（ScriptProcessorNode）は GC が走るたびにメインスレッドが止まり、Chrome で「ガガガ」「ビビ」ノイズが発生していた。  
> AudioWorklet は専用のオーディオスレッドで動作し GC の影響を受けない。また Float32 アキュムレータを廃止して固定サイズリングバッファにすることで GC 負荷（旧: 約86MB/s）をゼロにした。

### ジングル再生

`server/assets/bgm/opening/` および `ending/` に MP3 を置くと自動認識。  
フェードイン → 再生 → フェードアウトの制御は `AudioMixer.playJingle()` が行います。

### 効果音（SFX）演出

`server/assets/sfx/` に配置した MP3（拍手・ファンファーレ・ドラムロール等）を、キャスター発話と同じトークチャンネル（CH2）に挟み込んで再生します。`server/sfx-library.js` が初回参照時に MP3 を PCM へ遅延デコード・キャッシュします。

- **LLM 主導**：発話テキストに `[SFX:name]` タグを埋め込むことで効果音を鳴らせます（既存の `[PAUSE:N]` タグと同じ仕組みを踏襲）。1 ターンあたり最大 2 回まで
- **対象はスタジオ在席エージェントのみ**：`SFX_ELIGIBLE_AGENT_KEYS` により MAX・Clara・高橋教授・謎のジャーナリスト X・DJ サキ・平野ドレミ等に限定。Steve（ワールドレポート、スターリンク経由）や天気・交通・報道・金融の各センター（リモート接続）には使用しません
- **コード主導フック**：特別な日のオープニングファンファーレ、The Answers クロージングの拍手は、LLM のタグ埋め込みに頼らず `_playSfxAsAgent()` から直接再生。`AGENT_SPEAKING`/`AGENT_SILENT` を正しく前後にブラケットし、演出中にアバターがロゴ表示へ戻らないようにしています

---

## オーディオミキサー構成

`audio-mixer.js` は放送スタジオのミキシングコンソールに相当する役割を担います。

### 現在の 3ch 構成

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AudioMixer（サーバー側）                           │
│                                                                     │
│  CH1: BGM        bgmBuffer     BGM（MP3 シャッフル再生）             │
│                  targetBgmVolume で独立制御                          │
│                  TTS 発話中は通常 15%（アンビエント音声中は半分・最低6%）│
│                  にダッキング                                        │
│                                                                     │
│  CH2: 放送 TTS   talkBuffer    MAX / Clara / Steve / 各コーナー      │
│                  ※発言権システムで「1人ずつ」使う共有バス              │
│                  ※エージェントごとの volume は TTS 合成前に適用       │
│                  ※ステレオパン（等パワーパン則）も各エージェント個別   │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  CH3: Spotify    Web Playback SDK（クライアント側・サーバー外）        │
│                  setVolume() で音量制御                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 出力信号の合成式

```
最終出力 = CH1×bgmVolume + CH2×1.0
         + CH3（Spotify SDK、別系統）

bgmVolume: TTS 発話中は 0.15、通常は 1.0
```

### 各チャンネルの役割と制御

| CH | バッファ | 対象 | 用途 |
|---|---|---|---|
| CH1 | `bgmBuffer` | BGM | BGM シャッフル再生 |
| CH2 | `talkBuffer` | 全放送エージェント | 発言権方式で1人ずつ使用 |
| CH3 | Spotify SDK | Spotify 楽曲 | 音楽フル再生（クライアント側で制御） |

### 発言権システムと CH2 の関係

CH2（放送 TTS）はすべての出演者が共有する**1本のバス**です。  
「発言権（トークンパッシング）」システムが時分割スケジューラとして機能し、任意の瞬間に発話するエージェントは常に1人だけです。  
各エージェントの `volume`（音量）・`pan`（定位）は TTS 合成前に PCM に反映されますが、フェーダーとして独立した CH を持っているわけではありません。

放送スタジオで例えると：

> **複数のマイクがつながったサブグループバス（CH2）**  
> 各マイクのゲインは個別設定済みだが、バスのフェーダーは1本共有。

### 将来のミキサー拡張ロードマップ

現在の設計は実用上の最小構成です。本格的なミキシングコンソール相当へ拡張する場合の方向性：

```
┌──────┬──────┬──────┬──────┬──────────┐
│ BGM  │ MAX  │Clara │Steve │ Spotify  │
│  🎵  │  🎙  │  🎙  │  🎙  │   🎵     │
│ [▓▓] │ [▓▓] │ [▓▓] │ [▓▓] │  [▓▓]   │ ← 独立フェーダー
│  Pan │ L20  │ R20  │ R30  │    C     │ ← パン
└──────┴──────┴──────┴──────┴──────────┘

[ 👏拍手 ]  [ 🔔チャイム ]  [ 😂笑い声 ]  [ 🎺ファンファーレ ]  ← SFXボタン
```

| 拡張項目 | 概要 |
|---|---|
| **エージェント独立 CH** | CH2 の共有バスをエージェントごとに分割し、管理画面でリアルタイム調整 |
| **SFX ボタン** | 拍手・笑い・チャイムなどの効果音を 1 クリックで独立 CH に注入 |
| **MCトリガー** | MAX が自らジングル・効果音をトリガーできる仕組み |
| **Spotify フェーダー統合** | Spotify の音量もサーバー側ミキサーの UI に統合 |
| **チャンネル ソロ/ミュート** | 特定エージェントだけを聴くデバッグ機能 |

---

## TTS 発音正規化

TTS に渡すテキストには三段階の正規化が適用されます。確信度の高いものから順に確定させ、
後段が前段の結果を上書きしないように設計されています（詳細は各段の説明を参照）。

### 1. 組み込みルール（`_builtinNormalizeTtsText`）

コードに組み込まれており、ユーザー辞書より先に常時適用されます。曖昧さの無い、機械的に
100%正しい変換のみを扱います。

| カテゴリ | 変換例 |
|---|---|
| 月初の読み | `月1日` → `月ついたち` |
| 和語日付 | `月2日`〜`月10日`・`月14日`・`月20日`・`月24日` → 全て和語読み |
| 助数詞の促音 | `一曲`→`いっきょく` / `一冊`→`いっさつ` / `一本`→`いっぽん` など8種 |
| ヶ月・ヶ所 | `3ヶ月`→`3かげつ` / `2ヶ所`→`2かしょ` |
| 5桁以上の千区切り数値 | `37,785,540`→`3778万5540`（万・億単位へ変換し誤読を防止） |
| 十六方位 | `北北西`→`ほくほくせい`（`compass-direction-format.js`。方位によっては一般的な辞書でも単語として認識されず誤読されるため専用対応） |

### 2. ユーザー発音辞書（`tts_dict.json`）

管理画面「システム管理 › 発声辞書」から GUI で追加・編集・無効化が可能です。  
正規表現フラグ（`g`・`i` など）も指定できます。人間が実際に耳で確認した検証済みの
読みのため、後段の汎用辞書（3.）より必ず先に適用し、機械的な推測に上書きされないようにしています。

### 3. 汎用辞書による自動読み補正（`dictionary-reading-format.js`）

「同じ読み間違いのパターンが色々な語で発生し、1件ずつ登録してもキリがない」という課題に
対応するため、形態素解析辞書（UniDic、`lindera-wasm-unidic-nodejs`）による自動補正を
1.・2.の後段に追加しています。

- **対象範囲**: 2文字以上の漢字を含み、UniDic上で名詞・形状詞（「上手」「元気」のような
  ナ形容詞語幹）として1語で認識された語のみ。単一文字の漢字（方・公・上・下等）は
  文脈で読みが大きく変わる同訓異字リスクが高いため対象外。動詞も対象外（実測で活用形に
  よって読みの一貫性が崩れるケースが見つかったため）
- **適用順序**: 必ずユーザー辞書（2.）より後に適用する。先に適用すると、ユーザーが
  手動登録した正しい読みへ書き換わるより前に漢字が別の読みへ変換されてしまい、
  ユーザー辞書のパターンが二度とマッチしなくなる事故につながる
- **精度**: 実測で、既存の`tts_dict.json`登録語のうち完全一致は約3割程度。固有名詞
  （人名等）や文脈依存の同訓異字（「公の場」「お出かけの方」等）までは解決しないため、
  引き続き2.の手動登録も必要（万能ではなく「登録すべき件数を減らす」役割）
- **無効化**: `dictionary-reading-format.js`の`ENABLED`を`false`にするだけで即座に無効化できる
- **起動時ウォームアップ**: 辞書の初期ロードに時間がかかるため（乗り換え前のsudachiでは
  約19〜23秒）、`server.js`が`server.listen()`より前にロード完了をawaitしてから接続受付を
  開始する。これにより再起動直後に接続したリスナーが無音を体験する事故を防いでいる

### My Secretary（Gemini Live）における扱い

上記1・2・3はいずれも「テキストを生成→正規化→TTSエンジンへ渡す」という**テキスト経由**の
パイプライン（`_collectPcm`）に組み込まれているため、[My Secretary](#my-secretary会話型ai秘書)の
`consult_agent`（専門エージェント本人の声での応答）には同様に適用される。一方、**秘書自身の発話**は
Gemini Live APIが音声を直接生成する「音声対音声」方式のため、介入できる合成前テキストの段階が
存在せず、辞書・組み込み正規化ルール・汎用辞書のいずれも機械的には適用できない。代わりに、
有効な辞書エントリを「この単語はこう読んでください」という自然文のリストに変換し、
system instructionへ渡している（`server/routes/secretary-live-routes.js`の`formatTtsDictForPrompt`）。
正規表現の後方参照（`$1`等）を含むエントリはこの変換で意味を成さなくなるため除外している。
決定的な文字列置換ほどの確実性は無い点に注意（3.の汎用辞書はこの経路には組み込まれていない）。

1.・2.でカバーしきれない語の一部は3.の汎用辞書が自動で拾うが、それでも解決しない固有名詞や
文脈依存の同訓異字には別途、一般的な発声ガイドライン（`server/lib/secretary-prompt.js`の
`buildPronunciationGuidanceSection`）をsystem instructionへ常時追加している。アルファベット・
略語のカタカナ化、読み間違えやすい漢字・固有名詞のひらがな/カタカナ表記、平易な話し言葉での
応答を促す3項目で、辞書登録の要不要に関わらず幅広く適用される。

### Gemini プロンプトへの TTS 指示

生成段階でも読み誤りを減らすため、全エージェントの `fullPrompt` に以下を追加しています。

- 月初の「1日」は「ついたち」と書く
- 和語日付（ふつか・みっか…はつか）を使う
- 促音を伴う助数詞はひらがなで書く
- 英略語は初出時カタカナ展開する（AI→エーアイ、BGM→ビージーエム 等）

---

## ログ

`server/logger.js` が pino + pino-roll によるロガーを提供します。

| 項目 | 設定 |
|---|---|
| ファイル保存先 | `server/logs/server.<日付>.<連番>.log` |
| ローテート | 日次（日付が変わったとき）またはファイルサイズ 20MB 超過時 |
| 保持世代数 | 7世代（7日分） |
| ファイル出力レベル | `debug` 以上（全レベル） |
| コンソール出力レベル | `info` 以上（カラー付き人間可読フォーマット） |

```
[HH:MM:SS] INFO  [Show] 番組ループを開始しました
[HH:MM:SS] INFO  [EcoIndicators] Fetched OK: IMF WEO, 世界銀行, FRED, e-Stat (7 sections) — 次回: 翌日リフレッシュ
[HH:MM:SS] INFO  [Search] journalist — 検索成功 queries=["..."] chunks=8 supports=7
[HH:MM:SS] INFO  [Search] commentator — 検索なし（注入済み経済データをコンテキストとして使用と推定）
[HH:MM:SS] DEBUG [Pipeline] 3ターン先読み開始: traffic
[HH:MM:SS] WARN  [Mixer] バッファアンダーラン
[HH:MM:SS] ERROR [Gemini] API呼び出し失敗: ...
```

---

## リリースノート

バージョンごとの変更履歴（新機能・修正の詳細）は [RELEASENOTE.md](RELEASENOTE.md) に分離しました。

---

## ライセンス

MIT License — © 2026 Masataka Miura (三浦雅孝)

> Developed with [Claude Code](https://claude.ai/claude-code) (Anthropic) and Antigravity.
