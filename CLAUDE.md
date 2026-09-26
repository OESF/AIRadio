# AI Radio — Claude 開発ルール

このファイルは Claude Code がセッション開始時に自動読み込みするプロジェクト専用ルールです。
コードを書く・修正する際は必ずこのルールに従ってください。

---

## 1. エージェント名は絶対にハードコードしない

管理画面（admin panel）でエージェント名は変更可能です。
**プロンプト文字列の中に名前を直書きしてはいけません。**

### NG 例（絶対禁止）
```javascript
// ❌ 名前をプロンプト内にハードコード
`高橋先生はどのようにご覧になりますか？`
`Steveが今どこにいるかは分かりません`
`DJ サキに聞いてみましょう`
`【MAXの直前の発言】${text}`
`Claraの発言を受けて`
```

### OK 例（正しい書き方）
```javascript
// ✅ _an オブジェクト経由（runSingleShowStep 内・Live チャンネル）
`${_an.commentator}はどのようにご覧になりますか？`
`${_an.world_report}が今どこにいるかは分かりません`
`${_an.music_dj}に聞いてみましょう`
`【${_an.caster}の直前の発言】${text}`
`${_an.assistant}の発言を受けて`

// ✅ スコープ変数経由（_buildCornerContext 内・Live チャンネル）
`${_wrName}が今どこにいるかは分かりません`
`${_djName}に聞いてみましょう`
`${_laName}がお届けしました！`

// ✅ スコープ変数経由（Classic/Jazz/Mood/Beatles の各パーソナリティ生成メソッド内）
`${_louName}'s radio script in English`
`${_joeName}の曲後コメントを2〜4文で書いてください`
`${_paulName}のラジオセリフを日本語で書いてください`
```

このプロジェクトには Live 以外に **Classic / Jazz / Mood / Beatles / 24You** の5チャンネルが存在し、
それぞれ `server/agent-system-classic.js` / `agent-system-jazz.js` / `agent-system-mood.js` /
`agent-system-beatles.js` に個別のエージェントシステムがある（24You はナレーション・エージェントが
一切無いため対象外）。**Live 専用の `runSingleShowStep`/`_an`/`_buildCornerContext` はこれらの
ファイルには存在しない** ので、それぞれの慣習に従うこと（下記「2. エージェント名変数の定義場所」参照）。

---

## 2. エージェント名変数の定義場所

### Live チャンネル（`server/agent-system.js`）

#### `runSingleShowStep` 内（メインループ）
メソッド冒頭の `try` ブロック内で `_an` オブジェクトが定義されています：

```javascript
const _an = {
  caster:       (config.agents?.caster?.name)       || 'MAX',
  assistant:    (config.agents?.assistant?.name)    || 'Clara',
  world_report: (config.agents?.world_report?.name) || 'Steve',
  music_dj:     (config.agents?.music_dj?.name)     || 'DJ サキ',
  life_advisor: (config.agents?.life_advisor?.name) || '平野ドレミ',
  commentator:  (config.agents?.commentator?.name)  || '高橋洋二教授',
  journalist:   (config.agents?.journalist?.name)   || '謎のジャーナリストX',
};
```

プロンプト文字列内では `_an.caster`, `_an.assistant`, `_an.world_report` 等を使う。

#### `_buildCornerContext` および `_build<Corner>CornerContext` 内
`_buildCornerContext` 冒頭でスコープ変数が定義されています：

```javascript
const _casterName = (config.agents?.caster?.name)       || 'MAX';
const _asstName   = (config.agents?.assistant?.name)    || 'Clara';
const _wrName     = (config.agents?.world_report?.name) || 'Steve';
const _djName     = (config.agents?.music_dj?.name)     || 'DJ サキ';
const _laName     = (config.agents?.life_advisor?.name) || '平野ドレミ';
const _cmName     = (config.agents?.commentator?.name)  || '高橋洋二教授';
const _jnName     = (config.agents?.journalist?.name)   || '謎のジャーナリストX';
const _lgName     = (config.agents?.legal_advisor?.name) || '北村昭雄';
```

コーナー別のコンテキスト組み立ては `_buildWeatherCornerContext` 〜 `_buildWorldReportCornerContext`
の10メソッドに分割されており、上記の変数は `ctx` オブジェクト経由で渡され、各メソッド冒頭の
分割代入（`const { _wrName, _djName, ... } = ctx;`）で同名のまま利用できる。
新しいコーナーメソッドを追加・編集する場合も、プロンプト内では必ずこれらの変数を使うこと。

#### その他のメソッド
アクセスできる `config` から都度取得する：

```javascript
const _name = (config.agents?.caster?.name) || 'MAX';
```

### Classic / Jazz / Mood / Beatles チャンネル（`agent-system-<channel>.js`）

これらのチャンネルは「ディレクター（音声なし・裏方）＋パーソナリティ（音声あり）」の2エージェント構成で、
Live のような複数エージェント間の掛け合いが無いため `_an` オブジェクトは存在しない。
パーソナリティが**自分自身**の名前をセリフ生成プロンプトに含める必要がある箇所（曲紹介・曲後コメントの
生成メソッド内）でのみ、メソッド冒頭にスコープ変数を定義する：

```javascript
// agent-system-jazz.js
const personalityCfg = config.agents?.jazz_personality || {};
const _louName        = personalityCfg.name || 'Louis';

// agent-system-mood.js
const personalityCfg = config.agents?.mood_personality || {};
const _joeName        = personalityCfg.name || 'ジョー匠';

// agent-system-beatles.js
const personalityCfg = config.agents?.beatles_personality || {};
const _paulName       = personalityCfg.name || 'ポール小野';
```

**Classic（`classic_personality`）はこの変数定義パターンを使っていない** —
`agent-system-classic.js` はパーソナリティ自身の名前をプロンプト内で参照しないため
（`directorCfg.prompt`/`personalityCfg.prompt` を素通しするのみ）、現状ハードコードのリスクが無い。
今後 Classic のプロンプトに名前参照を追加する場合は、上記と同じスコープ変数パターン
（`personalityCfg.name || 'デフォルト名'`）を用いること。

ディレクター側（`jazz_director`/`mood_director`/`beatles_director`/`classic_director`）は
音声を持たず自分の名前をプロンプトで参照しないため、同様の変数は定義されていない。

---

## 3. チェックリスト（コード変更後）

プロンプト文字列（バッククォートのテンプレートリテラル）に以下の文字列が残っていないか確認：

- **Live**: `MAX` / `Max` / `Clara` / `Steve` / `DJ サキ` / `平野ドレミ` / `ドレミさん` / `高橋先生` / `謎のジャーナリストX` / `Xさん` / `サキさん`
- **Classic**: `北野ひけし` / `小澤征三`
- **Jazz**: `Ellie` / `Louis`
- **Mood**: `佐藤智子` / `ジョー匠`
- **Beatles**: `湊洋子` / `ポール小野`

（24You はエージェント自体が存在しないため対象外）

確認コマンド（Live）：
```bash
grep -n "DJ サキ\|高橋先生\|謎のジャーナリスト\|平野ドレミ\|ドレミさん\b\|\bSteve\b\|\bMax\b\|\bClara\b" server/agent-system.js \
  | grep -v "//\| || '" | grep -v "AGENT_DEFAULT\|7459:\|7463:\|7466:\|7471:\|7484:\|7486:\|7489:"
```

確認コマンド（Classic/Jazz/Mood/Beatles）：
```bash
grep -n "北野ひけし\|小澤征三\|\bEllie\b\|\bLouis\b\|佐藤智子\|ジョー匠\|湊洋子\|ポール小野" \
  server/agent-system-classic.js server/agent-system-jazz.js server/agent-system-mood.js server/agent-system-beatles.js \
  | grep -v "//\| || '"
```

`grep -v "//\| || '"` で「コメント」と「スコープ変数のデフォルト値定義（` || 'Louis'` 等、同じ行に収まるもの）」
を除外している。ただし `personalityCfg.prompt ||` の次の行に続く初期プロンプト全文（下記4.参照）は
改行を挟むためこのフィルタでは除外されず、ヒットしても問題ない。

**既知の誤検出（実害なし、確認不要）**:
- `agent-system-mood.js` の `'あなたはジョー匠、ラジオ番組のパーソナリティです...'` — `personalityCfg.prompt ||`
  の初期プロンプト全文フォールバック（下記4.参照）
- `agent-system-jazz.js` の楽曲カタログ定数（`{ artist: 'Louis Armstrong', ... }` 等、
  実在アーティスト名としての "Louis"）— プロンプト内のエージェント名参照ではない

それ以外にヒットした行はハードコードの疑いがあるため要確認。

---

## 4. デフォルト値定義（` || 'デフォルト名'`）が許容される例外

以下は静的なフォールバック値のためエージェント名を動的にできない（許容される例外）：

- **`AGENT_DEFAULTS`**（`agent-system.js` 冒頭の静的オブジェクト）: config.json で上書きされるため実害なし
- **`getOfflineMockDialog`**: API 障害時のデモテキスト。`_mockCaster` 等の変数は定義済み
- **各チャンネルの `personalityCfg.name || 'デフォルト名'`**（上記「2.」参照）: config.json 側の
  `name` が空の場合のみ使われるフォールバックであり、通常運用では config.json の値が優先される
- **各チャンネルの `personalityCfg.prompt || 'あなたは○○、ラジオ番組のパーソナリティです...'`**
  （`_generateIntroduction` 等）: `prompt` が空の場合のみ使われる初期プロンプト全文フォールバック。
  キャラクター名を含むが、config.json の `prompt` が優先されるため実害なし

---

## 5. その他コーディングルール

### prefetch と非同期処理
- `_buildCornerContext('world_report', ...)` は必ず `_resolveWorldReportCity()` の **await 後** に呼ぶこと
  - 都市が未確定のまま呼ぶとフォールバックモードになり、Steve が別の都市をレポートするバグが発生する
- `_prefetchedSpeech` キーを変更する前に `caster_turn0` が入っていないか確認する
  - `max_react` フェーズで上書きされる場合は `_savedCasterTurn0` に退避してから変更する

### _broadcast イベント名
- `CORNER_START` の `name` フィールドはフロントエンドに表示されるため、必ず `_an.*` を使って動的化する（Live）
- Classic/Jazz/Mood/Beatles の `SHOW_INFO` イベントの `name` フィールド（番組名）も同様に
  `config.program?.name || 'デフォルト番組名'` で動的化すること（エージェント名ではなく番組名だが同じ理由）

### 禁止ワード（自分自身を指す際）
- MAX が自分を指す際に「MAXさんの〜」という三人称表現は禁止（システムプロンプト参照）

---

## 6. エージェント日記

エージェント日記（一人称振り返り、`server/lib/agent-diary.js` が
`server/data/agent-diary/<channel>/<agentKey>/` に保存）は Live/Classic/Jazz/Mood/Beatles/
The Answers の全チャンネルに実装済み（2026-07時点。24You はナレーション・エージェントが
無いため対象外）。

### サーバー側の書き込みフック（チャンネル系統ごとに実装が異なる）
- **Live**（`server/agent-system.js`）: `_writeDiaryReflection(cornerKey, agentName, spokenText, label)`。
  各コーナー終了直後（天気/交通/ニュース/金融/コメンテーター/ジャーナリストX/法律相談/
  ワールドレポート/音楽DJ/生活アドバイス）、および MAX・Clara のオープニング／エンディング時に
  fire-and-forget で呼ぶ。**「エンディング」は2箇所ある**: ① `runEndingSequence()`
  （`POST /api/show/end` の明示操作でのみ発火。24時間運用では滅多に呼ばれない）、
  ② `onClientDisconnected()` の全リスナー退出パス（Classic/Jazz/Mood/Beatles の
  `_handleSessionShutdown` と同じ、実際に頻繁に起きる方のセッション区切り）。②では
  `_resetSessionConversationState('切断')` が `this.lastSpeech` を空にする**直前**に、
  まだ残っている `lastSpeech.caster`/`lastSpeech.assistant` を材料に読むこと（先に
  reset を呼んでしまうと空文字列しか渡せなくなる）。
  MAX・Clara はコーナーを持たないため、オープニングとエンディングの**両方**でそれぞれ
  書くと1セッションに2件書かれてしまう（実際に発覚したバグ）。そのためコーナー担当
  エージェントとは異なり直接 `_writeDiaryReflection` を呼ばず、`_bufferMaxClaraDiaryText
  (agentKey, text)`（オープニング側、3経路すべてで使用）でオープニングの発言をバッファに
  貯めておくだけにし、`_flushMaxClaraDiary(agentKey, agentName, finalText)`（エンディング
  側 ①②両方で使用）でバッファ＋最後の発言を1本にまとめ `scope: 'episode'` で1回だけ書く。
- **Classic/Jazz/Mood/Beatles**（`server/channel-base.js`、`MusicChannelAgentBase` 経由で共通）:
  24時間ノンストップ放送で「番組終了」に相当する明確な区切りが無い（テーマ＝セッションが
  数曲ごとに切り替わるだけ）ため、曲ごとに書くのではなく**全リスナー退出時に1回だけ**書く
  （The Answers の episode 終了と同じ考え方）。曲後コメントの `speakText` 直後
  （Spotify再生ありなし両分岐）で `_writeMusicDiaryReflection(introText, commentText)` を
  呼ぶが、これは LLM を呼ばず `this._diaryTranscriptBuffer` に貯めるだけの軽量処理。
  実際に日記を書くのは `_flushMusicDiarySession()` で、`_handleSessionShutdown()`
  （`onClientDisconnected` 経由で全リスナー退出時に1回だけ呼ばれる、`_isShuttingDown`
  ガード付きの既存フック）から呼ぶ。バッファを1本にまとめて `_writeDiaryReflection(agentKey,
  agentName, joinedText, 'session', 'episode')` に渡す（`scope: 'episode'` で「番組全体を
  振り返る」プロンプトに切り替わる）。個別チャンネルのファイルを触る必要はない —
  `channel-base.js` 側の1箇所の実装が4ch全てに効く。
- **The Answers**（`server/agent-system-the-answers.js`）: 他chと異なり**発言のたびにではなく、
  エピソード終了時に1回だけ**書く（討論の1エピソードは長時間・多発言のため、発言単位では
  ログの延長になってしまい「日記」として意味を持たないため）。`_saveArchiveEntry()`
  （natural end の `_endEpisode` / 中断 end の `_resetEpisodeState` いずれの経路でも
  `_historyRecorded` ガードにより1回だけ通る、既存のアーカイブ保存の唯一の合流点）内で
  `_writeEpisodeDiaryReflections(transcript)` を呼び、transcript を speaker（poolKey）
  単位でグルーピングして、各パネリストの全発言をまとめて `_writeDiaryReflection(poolKey,
  name, joinedLines, 'episode', 'episode')` に渡す（第5引数 `scope: 'episode'` で
  「番組全体を振り返る」プロンプトに切り替わる。既定の `scope: 'moment'` は「直前の一場面」用）。
  司会進行役の MAX（poolKey: `live_caster`）も transcript 上の一発言者として同じ扱いになる
  ため、特別扱いせずこの仕組みだけで司会者の日記も自然にカバーされる。poolKey
  （例: `live_commentator`）は home チャンネル側のエージェントとは別の器に記録され、
  裏プロファイル込みの出演回ごとの振り返りとして扱う（home 側の日記とは混ぜない）。
  `_channelId` が `'TheAnswers'`（キャメルケース）のため、`channel-base.js` の
  `_writeDiaryReflection` 内でスネークケース化（`the_answers`）してから保存する。
  名前解決は `getConfig().agents` ではなく `_resolveArchiveSpeakerName(poolKey)` を使うこと
  （中断パスでは `_saveArchiveEntry` 実行時点で `_activePanel` が既に空にリセットされている
  ため、`getConfig().agents` 経由では解決できない）。

### ディレクター系エージェントの日記（`scope: 'plan'`）
Classic/Jazz/Mood/Beatles/The Answers にはディレクター（音声を持たず放送に出ない裏方）が
存在し、それぞれ番組の構成・選曲・テーマを決めている。話した内容ではなく決めた内容が
材料になるため、`_writeDiaryReflection` に3つ目の scope として `'plan'` を追加した
（「あなたは番組のディレクターとして...構成・企画を決めました」という振り返りプロンプトに
切り替わる）。
- **Classic/Jazz/Mood/Beatles**（`server/channel-base.js`）: `_writeDirectorSessionDiary
  (sessionPlan)` が `_directorAgentKey`（ゲッター、各chで定義済み）と
  `sessionPlan.{theme,concept,pieces}` から振り返りを書く。`_planSession()` が新しい
  セッション計画を確定させる3箇所（通常オープニング／プリフェッチ消費／通常フロー）全てで
  呼ぶことで、セッション1回につき1回の書き込みを保証している（曲ごとではない）。
  `_directorPlan()`（`_planSession` 失敗時の単曲フォールバック）は呼ばない —
  滅多に起きない上、セッションという単位を持たないため対象外とした。
- **The Answers**（`server/agent-system-the-answers.js`）: `_runEpisode` 内、
  `_selectTheme()` でテーマが決まった直後（1エピソードにつき1回）に直接
  `_writeDiaryReflection('director', ...)` を呼ぶ。The Answers の director は
  `config.director`（`panelist_pool` とは別のトップレベルフィールド）で、
  `getConfig()` のオーバーライドで `agents.director` として常に露出しているため
  （`_activePanel` に依存しない）、poolKey 系エージェントと違って
  `_resolveArchiveSpeakerName` を使わず `getConfig().agents?.director?.name` で直接
  解決できる。
- **Live**（`server/agent-system.js`）: 2026-07時点で実装済み。それまで `config.agents.director`
  （森田正義）は定義だけあって未使用で、コーナーローテーション（`_refillCornerQueue()`）は
  `Math.random()` だけで決まる完全アルゴリズムだった。これを「森田が編成方針を判断し、
  技術的制約（必須4コーナー・連続禁止等）は引き続きコードが保証する」ハイブリッド方式に変更した:
  - `_selectNextCorner()`（後述の理由により**同期・即時応答が絶対条件**）→ キューが空なら
    `_refillCornerQueue()` を呼ぶ。ここは **LLM を一切待たない**。既に先読み済みの
    `this._prefetchedDirectorDecision` があればそれを使い、無ければ
    `_getFallbackDirectorDecision()`（旧実装と全く同じ確率分布の即時代替）を使う。
  - 実際のキュー組み立ては `_buildCornerQueueFromDirectorDecision(decision)` が担う。
    森田（またはフォールバック）が決めるのは「ゲスト人数・どのゲストか・世界レポート/
    法律相談の有無・music_dj頻度」のみで、必須4コーナーのシャッフル・music_dj挿入アルゴリズム・
    直近重複回避は元のロジックのまま**常にコードが保証**する（コーナー名の並び順そのものは
    LLMに生成させない — 幻覚・必須コーナー漏れのリスクを避けるため）。
  - `_refillCornerQueue()` は自分の実行の最後に必ず `_prefetchNextDirectorDecision()`
    （fire-and-forget）を呼び、**次サイクル分**の判断を裏で先読みしておく。1サイクルの消化には
    実測で1時間前後かかることが多い（music_dj挿入のたびに曲をまるまる1曲再生するため。
    ディレクタへのプロンプト文中では簡略化して「20分程度」と伝えているが、実態とは
    ズレがある）。数秒で終わるこの LLM 呼び出しは次にキューが空になるまでに十分間に合う設計
    （`_prefetchedSessionPlan` 等、このコードベース全体で使われている先読みパターンを踏襲）。
  - `_requestDirectorCycleDecision()` が実際に Gemini（`gemini-2.5-flash-lite`）へ JSON形式で
    問い合わせ、`_validateDirectorDecision()` が出力を検証・正規化する（型不正・
    guest_count と guests 配列の件数不一致・未知の値は自動修復し、修復不能なら null を返して
    呼び出し元がフォールバックに落ちる）。妥当な出力が得られた場合のみ、含まれる
    `reasoning`（1〜2文の理由）を材料に `_writeDiaryReflection('director', ..., 'cycle_plan',
    'plan')` を呼ぶ（Live で `scope: 'plan'` を使う箇所の1つ）。
  - **この `cycle_plan` 日記だけでは不十分**: 1サイクルの消化に1時間前後かかる一方、
    サイクル補充自体は「キューが尽きたとき」にしか起きないため、実際の運用では数時間に
    1回程度しか発生しない。さらに LLM 呼び出しが失敗（API障害・レート制限等）すれば
    その回は日記が書かれない。このため、短い・または巡り合わせの悪いセッションでは
    森田の日記が一度も書かれないことが実際に発生した（2026-07-28、Geminiプリペイド残高
    枯渇と重なったセッションで確認）。森田は「LLM判断が成功したときだけ」ではなく
    「番組の編成という仕事を毎セッション行っている」はずなので、`_writeDirectorSessionSummaryDiary()`
    を新設し、MAX・Clara と同じ2箇所（`runEndingSequence()`・`onClientDisconnected()` の
    全リスナー退出パス）で必ず1回、そのセッションの振り返りを保証するようにした。
    材料は `_recordCornerPlayed()` にフックして貯めた「今セッションで実際に流れたコーナー」
    （`_directorCornersThisSession`、コーナーごとの回数付き）と、直近で適用された編成方針
    `_lastAppliedDirectorDecision`（LLM判断・フォールバックのどちらでも可。フォールバックで
    あっても「森田が決めたことにする」という diegetic な扱いは他の日記と一貫させている）。
    `cycle_plan`（LLM判断成功時のみ・「なぜこの編成にしたか」）と
    `session_summary`（毎セッション保証・「実際にどう流れたか」）は役割が異なるため、
    同一セッションで両方書かれることもある（意図的な仕様、MAX/Claraのような重複バグではない）。
  - なぜ同期が絶対条件か: `_selectNextCorner()` は3ターン先読みパイプライン内など
    タイミングクリティカルな箇所から複数呼ばれており（コメント内に「41秒あればほぼ確実に
    間に合う」等の実測に基づく記述がある）、ここで LLM 呼び出しを `await` すると
    番組進行が数秒〜数十秒詰まる。先読み＋即時フォールバックの二段構えでこれを回避している。
  - **カレンダー上の事実（曜日・祝日・本日初回か）は LLM に判断させず、常にコードが
    決定的に適用する**: `_refillCornerQueue()` が消化タイミング（＝今まさに必要になった
    瞬間）に `isWeekend`（`[0,6].includes(new Date().getDay())`）・`isHoliday`
    （`this.holidayService.isHoliday()`）・`isFirstCycleOfDay`（`_getShowDay()` を
    `this._lastDirectorPlanShowDay` と比較）を求め、`isMarketClosed = isWeekend ||
    isHoliday` として `_buildCornerQueueFromDirectorDecision(decision, { isMarketClosed,
    isFirstCycleOfDay })` に渡す。`isMarketClosed` なら finance を必須コーナーから外し
    （株式市場が休みの週末・祝日はほぼ不要）、`isFirstCycleOfDay` なら news を先頭に
    固定する（その日最初の放送はニュースから）。**先読み時点（1サイクル前）の情報は
    日付・曜日をまたぐと古くなる可能性があるため**、これらはあえて decision オブジェクトに
    含めず、消化時に毎回その場で再計算する。ニュースを先頭に固定する際、除去した news の
    前後が music_dj 同士で隣接してしまうケースがあり（実装時にテストで発見したバグ）、
    その場合は片方の music_dj も一緒に除去してから unshift する。
    一方、それ以外の判断（ゲスト構成・music_dj頻度等）は曜日・祝日名・時間帯を**事実として
    プロンプトに渡した上で** 森田自身の裁量に委ねている（`_requestDirectorCycleDecision`
    のプロンプトに曜日・時間帯・週末/祝日フラグ・祝日名を含める）。
  - **祝日判定は `server/services/holiday-service.js`（`HolidayService`）が担う**:
    holidays-jp（`https://holidays-jp.github.io/api/v1/date.json`、内閣府データを機械
    可読化した無料API）から `{ "YYYY-MM-DD": "祝日名" }` を取得し24時間キャッシュする。
    他の外部データサービス（weather/finance/news/economic-service.js）と同じ
    `this.cache` パターン。`_refillCornerQueue()` は同期・即時応答必須のため、
    `isHoliday()`/`getHolidayName()` は**キャッシュを読むだけの同期メソッド**にしてあり、
    実際の fetch（`refresh()`）は起動時とサイクル補充のたびに fire-and-forget で
    呼ぶだけ（TTL内なら即座に no-op で返るため毎回呼んでも軽い）。未取得・取得失敗時は
    「祝日ではない」side に倒す（安全側 — 誤って finance を削らない）。日付の比較は
    `_getShowDay()` 等の既存コードと同じくサーバーのローカル時刻（`getFullYear()`/
    `getMonth()`/`getDate()`）を使い、UTC変換はしない（一貫性のため）。
  - **緊急性の高い情報はそのコーナーを優先する（`priorityCorners` 方式）**:
    「本日最初はニュースから」に加えて、天気・ニュースにも同様の優先ロジックを実装した。
    `_buildCornerQueueFromDirectorDecision` 内の「先頭へ寄せる」処理を汎用化し、
    `priorityCorners`（優先度が低いものを先に積む配列。最後に処理したものが結果的に
    先頭に来る）で複数コーナーを扱えるようにした:
    - **天気（最優先・事実ベース）**: `weatherService.cache.structured` の
      `hasTyphoon`/`hasWarning`/`hasQuake`（`_buildWeatherCornerContext` の「緊急情報検出」
      判定と同じデータソースを再利用）のいずれかが true なら `weatherEmergency = true` とし、
      `_refillCornerQueue()` が決定的に天気を先頭へ寄せる。LLMには「判断不要」と明示して
      二重判断させない。
    - **ニュース（次点・LLM判断）**: 「本日初回」に加えて、ディレクタ自身が
      `prioritize_news: true` と判断した場合もニュースを優先する。事実で割り切れないため
      （見出しが本当に「速報級」かはニュース記事の内容次第）、`_requestDirectorCycleDecision`
      が直近のニュース見出し5件（`newsService.cache.structured`）をプロンプトに渡し、
      森田自身に「多くのリスナーが気になっているであろう大きな出来事があるか」を判断させる。
      `_validateDirectorDecision`/`_getFallbackDirectorDecision` 双方に
      `prioritizeNews`（既定 false）を追加。
    - 天気とニュースが同時に優先対象になった場合は天気が最優先（`priorityCorners` の
      配列順で news → weather の順に積み、weather を最後に unshift することで保証）。
      この2段階の優先付けを含めて 2400 パターンのストレステストで検証済み
      （必須コーナー充足・music_dj連続禁止・優先順位いずれも0件失敗）。
  - **大きな話題はコメンテーター・ジャーナリストX・弁護士へ横断的に振れる（`big_topic`）**:
    `prioritize_news` だけだとニュースコーナー止まりなので、森田が「これは複数の専門家の
    視点で深掘りする価値がある」と判断した場合、その話題を `big_topic`（短い要約文字列）
    として返させる。`_refillCornerQueue()` はこれを、今サイクルに実際に登場するゲスト
    （`decision.guests`/`decision.includeLegalAdvisor` で判定）に限って、既存の
    リスナートピックリクエスト機構（`pendingCommentatorRequest`/`pendingJournalistRequest`/
    `pendingLegalAdvisorRequest` — 元々は「AI Radio管理人」窓口経由のリスナー個別リクエスト用）
    へ流し込む。**ただし丸ごと使い回すと各コーナーのプロンプトが「リスナーの◯◯さんから
    リクエストが届いています」と誤って言ってしまう**ため、注入するオブジェクトに
    `source: 'director'` を付け、`_buildCommentatorCornerContext`/
    `_buildJournalistCornerContext`/`_buildLegalAdvisorCornerContext` 側で
    `topicRequest.source === 'director'` を見て「本日の大きな話題」という文脈に
    フレーズを分岐させている（実装時に気づいた重要な注意点）。本物のリスナーリクエストが
    既に入っている場合は上書きしない（人間の明示的なリクエストを優先）。
    天気コーナー自体が緊急時に詳細解説へ切り替わる仕組み（`_buildWeatherCornerContext`
    の `_hasDisaster` 分岐）は本機能追加前から既に存在していたため、変更していない。
  - **プロンプト内で言及する他エージェントの名前は必ず動的取得**: `_requestDirectorCycleDecision`
    は森田自身だけでなく、プロンプト文中でコメンテーター・ジャーナリストX・弁護士・
    ワールドレポート・DJの名前にも言及するため、それぞれ
    `(config.agents?.<role>?.name) || '<デフォルト名>'` で解決した変数を使うこと。
    実装時に一度、JSON出力スキーマの説明文（`"include_world_report": ...（Steveの
    ワールドレポートを入れるか）` 等）にベタ書きしてしまうミスをした — コメント欄だけでなく
    **Geminiへ実際に送信するプロンプト文字列そのもの**が対象になることに注意
    （`grep`でのセルフチェック時は `// ` や ` * ` で始まるコメント行だけでなく、
    テンプレートリテラル内の地の文もヒットする）。
  - **平野ドレミ（life_advisor）の「料理・レシピ」テーマは、既存の自己完結した
    ローテーションロジック内（`_buildLifeAdvisorCornerContext`、ディレクタの判断とは
    無関係）で時間帯バイアスを掛けている**: 10-11時・16-18時台（昼食・夕食の少し前）は、
    直近で使っていなければ「料理・レシピ」テーマを優先的に選ぶ。コーナーの並び順
    （キュー内のどこに life_advisor が来るか）は1サイクルの消化に十数分〜それ以上かかり
    正確な時刻を予測できないため、ディレクタ側で「レシピを昼前後に置く」ような制御はせず、
    実際にコーナー内容を生成する瞬間（＝ほぼ実時刻）にテーマ側で判断する方が確実、という
    設計判断。

### クライアント側のUI配置
閲覧タブは**システム管理の共通タブではなく、各チャンネルの「番組設定（Xxx）」グループ内に
配置する**（`client/src/App.tsx`）。共通の `AgentDiaryTab` コンポーネント（`serverUrl`/
`channel`/`emptyMessage` を props で受け取る）を使い、チャンネルごとに
`{adminSubTab === 'xxx_diary' && <AgentDiaryTab channel="xxx" .../>}` を各チャンネル
グループの末尾に配置する（`live_diary`/`classic_diary`/`jazz_diary`/`mood_diary`/
`beatles_diary`/`answers_diary`）。Live だけは先に個別実装済みの独自ブロックをそのまま
使っている（バッジ色が手動マップ、他chはハッシュ関数 `diaryBadgeClass` で自動割当）。
取得APIは共通の `GET /api/agent-diary?channel=<channel>` のみで、新規エンドポイントは
チャンネル追加のたびに増やさない。新しい `adminSubTab` キーを追加したら、`!config` で
ロード中表示を出すガード条件（`adminSubTab !== 'xxx_diary'` の除外リスト）にも追加すること
（忘れると日記タブの下に「ロード中...」が二重表示される）。

24You に将来ナレーション機能を追加する場合も、この節と同じパターン
（サーバー側フック＋`AgentDiaryTab`の追加）を踏襲すること。

---

## 7. コメントの書き方（JSDoc）

ソースのコメントは JSDoc の形にそろえ、「このコードが何をするか」を書く。
**いつ・誰の指示で・どんなバグを直したか、という経緯はコメントに書かない**（git の履歴・
RELEASENOTE.md に残っている）。経緯の中の「こうすると壊れる」という知見だけを、下のタグで残す。

**2026-09-20 に全ファイル（274ファイル・85,214行）の整理が完了し、この形式がこのリポジトリの
標準になった。** 以降に新しく作るファイル・新しく足す関数は、あとから整理するのではなく
**最初からこの形式で書く**こと。既存ファイルに手を入れるときも、触った範囲はこの形式へそろえる。

### 新しくファイルを作るとき（必須）
- 1行目（`'use strict';` より前）に下のファイルヘッダーを置く。`@doc-reviewed` には作成日を書く。
- すべての関数・メソッド・クラスに JSDoc を付ける（1行の要約＋`@param`＋`@returns`）。
- 経緯を書かない。「こうすると壊れる」は `ATTENTION:`、「消すと再発する」は `BUGFIX:` で残す。
- コメントの中でエージェントを指すときは、設定で変わる名前ではなく役割名
  （キャスター・アシスタント・音楽DJ 等）を使う（本ファイル1節と同じ理由）。
- 作ったら `node scripts/doc-progress.js` に整理済みとして数えられることを確認する。

### ファイルヘッダー（全ファイル共通）
```javascript
/**
 * @file <このファイルが何を処理するものか（1行）>
 *
 * <概要。何をするか・どういう仕組みか・利用元・保存先など>
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed YYYY-MM-DD
 */
'use strict';
```
ライセンスの全文はリポジトリ直下の `LICENSE` にだけ置く。

TS/TSX ファイルには `'use strict';` を置かない。ヘッダーの後はそのまま `import` から始める。

### 関数
1行の要約、`@param`（引数ごと）、`@returns` をそろえる。行内のコメントは「なぜそうしているか」だけ。
コードを読めば分かる「何をしているか」は書かない。

- **JS**: 型も書く（`@param {string} name 説明`）。
- **TS/TSX**: 型はコードにあるので、JSDoc には説明だけを書く（`@param name 説明`）。

JS の型で `tsc` の指摘を増やさないための注意（実際に踏んだもの）:
- `{Buffer}` は TS2322 を呼ぶ → `{any}`。`Set` を返す関数に `{any[]}` は TS2740 → `{any}`
- 分割代入の引数に角括弧付きの `[opts]` は TS2463 → 角括弧を外して `@param {any} opts`
- union 型の引数を `{string}`/`{any}` に緩めると、キーとして使う箇所で TS2322/TS7053 が増える →
  union のまま残す
- 途中で return しない経路があるメソッドに `@returns {Promise<boolean>}` は TS2366 → `{any}`
- `{object}` はプロパティの無い型になる → `{Record<string, any>}` か `{any}`

### 注意書きのタグ（検索用。`//` の行でも JSDoc の中でも同じ形で書く）
| タグ | 意味 |
|---|---|
| `ATTENTION:` | 守らないと壊れる制約、やってはいけない操作 |
| `BUGFIX:` | 過去のバグの再発防止のためにこうなっている（消すと再発する） |
| `TODO:` | やり残し、将来やること |
| `FIXME:` | 分かっているが、まだ直していない不具合 |

検索例: `git grep -n "ATTENTION:"`

### 既存ファイルのコメントを整理するとき
2026-09-20 に全ファイルの整理は終わっているが、大きな改修の後などで整え直す場合は
`/doc-cleanup` を使う（手順は `.claude/skills/doc-cleanup/SKILL.md`）。

- `@doc-reviewed` がヘッダーにあるファイルが整理済み。進み具合は `node scripts/doc-progress.js` で見る。
- 整理したら必ず `node scripts/doc-verify.js <file>` で、コメントと空白以外が HEAD と同一であることを
  確かめる（プロンプト文字列の書き換えも検出できる）。コメント整理とコードの変更は同じ回に混ぜない。
- 型の指摘が増えていないかは `node scripts/doc-typecheck.js <server の js>` で見る。ただしこの
  「増えた指摘」には型の表記が変わっただけのものが含まれるため、**エラーコードごとの件数**で
  判定する（どの種類も増えていなければ許容）。クライアント側は
  `(cd client && node_modules/.bin/tsc -b --noEmit)` が0件のままであること。
