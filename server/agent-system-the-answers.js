/**
 * @file 討論番組「The Answers」のチャンネル
 *
 * 討論番組「The Answers」のチャンネル。1つの議題について、他チャンネルの出演者から選んだ
 * パネリストが語り合う。他のチャンネルと違って流しっぱなしではなく、議題が送られたときだけ
 * 1回分（エピソード）を始めて終わる。
 *
 * 流れ:
 *   テーマを決める → 出演者を選ぶ → 司会の挨拶 → 事実の共有（報道）→ 世の中の反応 →
 *   討論（司会が毎ターン次に何をするか判断する）→ 締め → エンディング
 *
 * パネリストの実体（名前・声・人格）は各チャンネルの設定にあり、このチャンネルの設定には
 * その人を指す鍵と、この番組でだけ使う追加の情報（裏の顔・声の演技の調整など）だけを置く。
 * 名前と声は毎回そちらから読むので、名前を直書きしない決まりを満たせる。
 *
 * 1回分の記録（日時・テーマ・出演者・全発言・番組全体の録音）は archive.json と archive_audio/
 * に溜める。同じ人が続けて出ないようにする判定にも、この記録をそのまま使う。
 *
 * ATTENTION: 実行中の1回分は、外から強制的に止められない。全員が退出したときは中断の印を立て、
 * 各段階の合間でそれを見て自分から打ち切る形にしてある。
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

const fs   = require('fs');
const { writeJsonFile } = require('./lib/atomic-json');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getLogger } = require('./logger');
const ChannelAgentBase = require('./channel-base');
const { buildAgentKnowledgePack, recordAgentNote } = require('./lib/agent-knowledge-pack');
const youtubeWatchStore = require('./lib/youtube-watch-store');
const { ProgramRecorder } = require('./audio-mixer');
const NewsService = require('./services/news-service');
const WeatherService = require('./services/weather-service');
const TrendingService = require('./services/trending-service');
const FinanceService = require('./services/finance-service');
const topical = require('./lib/topical-materials');
const directorBoard = require('./lib/director-board');
const agentDiary = require('./lib/agent-diary');

const THE_ANSWERS_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'the_answers', 'config.json');
// 1回分の記録の置き場。同じ人が続けて出ないようにする判定にも、この記録をそのまま使う
const THE_ANSWERS_ARCHIVE_PATH      = path.join(__dirname, 'data', 'channels', 'the_answers', 'archive.json');
const THE_ANSWERS_ARCHIVE_AUDIO_DIR = path.join(__dirname, 'data', 'channels', 'the_answers', 'archive_audio');
// 古い形式の出演履歴。残っていれば起動時に1回だけ引き継ぐ
const THE_ANSWERS_LEGACY_HISTORY_PATH = path.join(__dirname, 'data', 'channels', 'the_answers', 'panel_history.json');

// パネリストの実体（名前・声・本来の人格）が置かれている、各チャンネルの設定。
// ATTENTION: 名前や声はここから毎回読むこと。このチャンネルの設定側に写し取らない。
const LIVE_CONFIG_PATH        = path.join(__dirname, 'data', 'config.json');

const CLASSIC_CH_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'classic', 'config.json');
const JAZZ_CH_CONFIG_PATH     = path.join(__dirname, 'data', 'channels', 'jazz',    'config.json');
const MOOD_CH_CONFIG_PATH     = path.join(__dirname, 'data', 'channels', 'mood',   'config.json');
const BEATLES_CH_CONFIG_PATH  = path.join(__dirname, 'data', 'channels', 'beatles','config.json');

const HOME_CONFIG_PATHS = {
  live:    LIVE_CONFIG_PATH,
  classic: CLASSIC_CH_CONFIG_PATH,
  jazz:    JAZZ_CH_CONFIG_PATH,
  mood:    MOOD_CH_CONFIG_PATH,
  beatles: BEATLES_CH_CONFIG_PATH,
};

const ROTATION_LOOKBACK_EPISODES = 3;  // 直近何エピソード分を「連続起用回避」の対象にするか

// 記録の要約を作れる最低の発言数。これより少ない回（早い段階で中断した回など）は要約できない。
// ATTENTION: 画面側の判定と必ず同じ値にすること。
const ARCHIVE_SUMMARY_MIN_TRANSCRIPT_ENTRIES = 5;

// BGM は3つのフォルダーを使い分ける。開始直後に繰り返す曲、討論中ずっと静かに流す曲、
// 締めの後に鳴らす曲。
// ATTENTION: ミキサーは置き場からの相対ファイル名しか受け付けないため、開始用から本編用への
// 切り替えは置き場そのものを差し替えて行う。
const THE_ANSWERS_BGM_OPENING_DIR = path.join(__dirname, 'assets', 'channels', 'the_answers', 'bgm', 'opening');
const THE_ANSWERS_BGM_MAIN_DIR    = path.join(__dirname, 'assets', 'channels', 'the_answers', 'bgm', 'main');
const THE_ANSWERS_BGM_ENDING_DIR  = path.join(__dirname, 'assets', 'channels', 'the_answers', 'bgm', 'ending');

// 開始の曲の最低再生時間。準備がこれより早く終わっても、曲が短く切れた印象にならないよう
// ここまでは流し続ける。準備が長引く場合は繰り返し再生が無音を埋める。
const OPENING_MIN_PLAY_MS = 15000;

/**
 * 討論番組のエージェントシステム。
 *
 * @param {any} mixer このチャンネルのミキサー
 * @param {any} serverWrapper 一斉配信と接続数を持つ入れ物
 */
class TheAnswersAgentSystem extends ChannelAgentBase {
  constructor(mixer, serverWrapper) {
    super(mixer, serverWrapper, THE_ANSWERS_CONFIG_PATH, 'TheAnswers');

    if (!fs.existsSync(THE_ANSWERS_ARCHIVE_AUDIO_DIR)) fs.mkdirSync(THE_ANSWERS_ARCHIVE_AUDIO_DIR, { recursive: true });

    // 古い形式の出演履歴が残っていれば引き継ぐ（続けて出さない判定の材料を失わないため）
    if (!fs.existsSync(THE_ANSWERS_ARCHIVE_PATH) && fs.existsSync(THE_ANSWERS_LEGACY_HISTORY_PATH)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(THE_ANSWERS_LEGACY_HISTORY_PATH, 'utf-8'));
        if (Array.isArray(legacy) && legacy.length > 0) {
          const migrated = legacy.map(e => ({ id: uuidv4(), transcript: [], recordingFilename: null, recordingSizeBytes: 0, ...e }));
          writeJsonFile(THE_ANSWERS_ARCHIVE_PATH, migrated);
          getLogger().info('[TheAnswers] 旧パネル起用履歴をアーカイブへ移行しました');
        }
      } catch (e) { getLogger().warn('[TheAnswers] 旧履歴の移行に失敗: ' + e.message); }
    }

    // 1回分の記録。件数の上限は設けず、すべて溜める
    this._playedPath = THE_ANSWERS_ARCHIVE_PATH;
    this._playedPieces = this._loadPlayedPieces(); // [{ id, theme, panelKeys, playedAt, interrupted?, transcript, recordingFilename, recordingSizeBytes }]
    this._archiveRecorder = null; // 現在のエピソードを録音中のProgramRecorder（無ければnull）

    // BUGFIX: 候補として見せたが選ばれなかったテーマも覚えておくこと。放送した回しか見て
    // いなかった頃は、「他の候補を見る」を続けて押しても同じような案が並んだ。
    // 保存はせず動いている間だけ持つ（再起動や開始で自然に消えてよい）。
    this._recentSuggestedThemes = []; // [{ theme, ts }]

    // テーマを決める材料を取るためのサービス。
    // ATTENTION: 実際のニュース・気象・相場を見ずにテーマを決めないこと。見ていなかった頃は
    // 毎回似たようなテーマに収束していた。
    this.newsService = new NewsService();
    this.weatherService = new WeatherService();
    // 世間で反応が多かった話題（テーマを決める材料）
    this.trendingService = new TrendingService();
    // 相場の急な動き（テーマを決める材料）
    this.financeService = new FinanceService();

    // 1回分の進み具合
    this._state           = 'idle'; // idle | running
    this._activePanel     = {};     // poolKey -> 解決済みプロファイル（エピソード開始時にキャッシュ）
    this._topic           = null;
    this._transcript       = [];    // [{ speaker: poolKey|'user', text, ts }]
    this._handRaiseQueue   = [];    // [{ clientId, ts }]
    this._sessionStartTime = null;
    this._recentlySpokenKeys = [];  // 直近発言したpoolKeyのリングバッファ
    this._grantWaiters    = new Map(); // clientId -> { resolve, timeout } 手を挙げて指名された人の発言待ち
    // ATTENTION: 実行中の処理は外から強制的に止められない。開始のたびに新しい印を発行し、
    // 各段階の合間でそれを見て自分から打ち切る形にすること。
    this._episodeToken = null;
    // 自然に終わった側で既に記録済みかどうか（中断側と二重に記録しないための印）
    this._historyRecorded = false;

    getLogger().info('[TheAnswers] TheAnswersAgentSystem 初期化完了');
  }

  /**
   * 設定を返す。このチャンネルの設定にはディレクターと出演者の候補しか無いため、共通の
   * 読み上げの仕組みがそのまま使えるよう、いま出演中のパネリストを組み合わせて返す。
   *
   * @returns {any} 出演者を合成した設定
   */
  getConfig() {
    const raw = super.getConfig();
    const agents = {};
    if (raw.director) agents.director = raw.director;
    for (const poolKey of Object.keys(this._activePanel)) {
      agents[poolKey] = this._activePanel[poolKey];
    }
    return { ...raw, agents };
  }

  /**
   * パネリスト1人の情報を組み立てる。元のチャンネルの設定（名前・声・本来の人格）と、
   * この番組でだけ使う追加の情報（裏の顔・声の演技の調整など）を重ねる。
   *
   * @param {any} poolKey この番組での出演者の鍵
   * @param {any} pool 出演者の候補の一覧
   * @returns {any} 組み立てた出演者の情報。元が見つからなければ null
   */
  _resolvePanelistProfile(poolKey, pool) {
    const entry = pool[poolKey];
    if (!entry) return null;
    const homePath = HOME_CONFIG_PATHS[entry.sourceChannel];
    if (!homePath) return null;

    let homeConfig = {};
    try { homeConfig = JSON.parse(fs.readFileSync(homePath, 'utf-8')); } catch { return null; }
    const homeAgent = homeConfig.agents?.[entry.sourceAgentKey];
    if (!homeAgent || !homeAgent.name) return null; // リネーム・削除済みなら安全にスキップ

    return {
      poolKey,
      sourceChannel:   entry.sourceChannel,
      sourceAgentKey:  entry.sourceAgentKey,
      name:            homeAgent.name,
      role:            homeAgent.role,
      tts_engine:      homeAgent.tts_engine,
      gemini_voice:    homeAgent.gemini_voice,
      gemini_language: homeAgent.gemini_language,
      gemini_instruction: homeAgent.gemini_instruction,
      volume:          homeAgent.volume,
      pan:             homeAgent.pan,
      prompt:          homeAgent.prompt,
      tts_profile_title: homeAgent.tts_profile_title,
      tts_scene:       homeAgent.tts_scene,
      tts_style:       homeAgent.tts_style,
      tts_accent:      homeAgent.tts_accent,
      tts_context:     homeAgent.tts_context,
      max_chars:       homeAgent.max_chars,
      // ATTENTION: 追加の情報はこのチャンネルの設定だけに持つこと。元のチャンネル側は書き換えない
      tts_pacing:            entry.tts_pacing_override || homeAgent.tts_pacing,
      hidden_talent_prompt:  entry.hidden_talent_prompt || '',
      always_include:        !!entry.always_include,
      rotation_eligible:     entry.rotation_eligible !== false,
      opinion_research_default: !!entry.opinion_research_default,
      news_briefing_default: !!entry.news_briefing_default,
      // 出演者の顔ぶれが偏らないようにするための属性
      gender:            entry.gender || '',
      age_bracket:       entry.age_bracket || '',
      marital_status:    entry.marital_status || '',
      political_stance:  entry.political_stance || '',
      hometown_region:   entry.hometown_region || '',
      perspective_type:  entry.perspective_type || '',
    };
  }

  /**
   * 直近の回に出演した人の鍵を集める。同じ人が続けて出ないようにするために使う。
   *
   * @param {number} [lookbackEpisodes] 何回分さかのぼるか
   * @returns {any} 出演した人の鍵（重複なし）
   */
  _recentPanelKeys(lookbackEpisodes = ROTATION_LOOKBACK_EPISODES) {
    const recent = this._playedPieces.slice(0, lookbackEpisodes);
    const keys = new Set();
    for (const ep of recent) (ep.panelKeys || []).forEach(k => keys.add(k));
    return keys;
  }

  /**
   * 録音を止め、書き出しが終わるのを待つ。録音していなければ何もしない。
   * ミキサーからの切り離しはその場で済ませるので、この呼び出しの直後に次の回が録音を
   * 始めてもぶつからない。
   *
   * @returns {Promise<any>} 録音したファイルの情報。録音していなければ null
   */
  async _finalizeArchiveRecording() {
    const recorder = this._archiveRecorder;
    this._archiveRecorder = null;
    if (!recorder) return null;
    try { this.mixer.detachRecorder(); } catch { /* ignore */ }
    return await recorder.stop().catch(() => null);
  }

  /**
   * 1回分を記録へ保存する。
   *
   * ATTENTION: 発言の一覧は引数で受け取ること。保持しているものを直接読むと、中断の経路で
   * 保存が終わる前に中身が消され、空のまま保存される。
   *
   * @param {any} theme その回のテーマ
   * @param {any} panelKeys 出演者の鍵
   * @param {any} interrupted 途中で打ち切られたか
   * @param {any} recordingResult 録音したファイルの情報
   * @param {any} transcript その時点の全発言
   * @returns {void}
   */
  _saveArchiveEntry(theme, panelKeys, interrupted, recordingResult, transcript) {
    let recordingFilename = null;
    let recordingSizeBytes = 0;
    if (recordingResult && recordingResult.dataBytes > 0) {
      recordingFilename = path.basename(recordingResult.path);
      try { recordingSizeBytes = fs.statSync(recordingResult.path).size; } catch { /* ignore */ }
    } else if (recordingResult && recordingResult.path) {
      // 中身が無い（無音だけ）ならファイルごと捨てる
      try { fs.unlinkSync(recordingResult.path); } catch { /* ignore */ }
    }
    this._playedPieces.unshift({
      id: uuidv4(),
      theme, panelKeys, playedAt: new Date().toISOString(),
      ...(interrupted ? { interrupted: true } : {}),
      transcript: (transcript || []).map(t => ({ speaker: t.speaker, text: t.text, ts: t.ts })),
      recordingFilename, recordingSizeBytes,
    });
    this._savePlayedPieces();
    this._historyRecorded = true;
    this._writeEpisodeDiaryReflections(transcript);
  }

  /**
   * その回の日記を、発言した人ごとに1回だけ書く。
   *
   * ATTENTION: 発言のたびに書かないこと。1回の討論は長く発言も多いため、発言単位で書くと
   * ログの延長になって「日記」として意味を持たない。
   * 司会も発言者の1人として同じ扱いになるので、これだけで司会の日記も残る。
   *
   * @param {any} transcript その回の全発言
   * @returns {void}
   */
  _writeEpisodeDiaryReflections(transcript) {
    const bySpeaker = new Map();
    for (const t of (transcript || [])) {
      if (!t.speaker || t.speaker === 'user' || !t.text) continue;
      if (!bySpeaker.has(t.speaker)) bySpeaker.set(t.speaker, []);
      bySpeaker.get(t.speaker).push(t.text);
    }
    const _apiKey = this.getCredentials?.()?.gemini?.api_key || null;
    for (const [poolKey, lines] of bySpeaker) {
      const name = this._resolveArchiveSpeakerName(poolKey);
      const joined = lines.join('\n');
      this._writeDiaryReflection(poolKey, name, joined, 'episode', 'episode').catch(() => {});
      // 振り返りとは別に、継続観測のメモ（次回も追う話題）へも溜める。出演した場所に
      // 関わらず手持ちが厚くなるようにするため。
      recordAgentNote(poolKey, joined, { apiKey: _apiKey, activitySessionId: this._activitySessionId, label: 'the_answers' });
    }
  }

  /**
   * 記録を1回分消す。録音のファイルがあれば一緒に消す。
   *
   * @param {any} id 消す回の識別子
   * @returns {any} 消せたかどうか
   */
  deleteArchiveEntry(id) {
    const idx = this._playedPieces.findIndex(e => e.id === id);
    if (idx === -1) return { error: 'アーカイブが見つかりません' };
    const [removed] = this._playedPieces.splice(idx, 1);
    if (removed.recordingFilename) {
      const filePath = path.join(THE_ANSWERS_ARCHIVE_AUDIO_DIR, removed.recordingFilename);
      try { fs.unlinkSync(filePath); } catch { /* ファイルが既に無くても無視 */ }
    }
    this._savePlayedPieces();
    return { ok: true };
  }

  /**
   * 手を挙げて指名されたリスナーを呼ぶときの名前を返す。設定が無ければ「リスナー」。
   *
   * @returns {string} 呼びかけに使う名前
   */
  _getListenerName() {
    return this._getListenerProfile().name || 'リスナー';
  }

  /**
   * 出演者の鍵から表示名を引く。
   * ATTENTION: いま出演中の顔ぶれに頼らず、毎回候補の一覧から引くこと。過去の記録には
   * 今とは違う顔ぶれが入っている。中断の経路では出演中の情報が既に消えている点も同じ理由。
   *
   * @param {any} poolKey 出演者の鍵
   * @returns {string} 表示名。引けなければ鍵をそのまま返す
   */
  _resolveArchiveSpeakerName(poolKey) {
    if (poolKey === 'user') return 'リスナー';
    const pool = this.getConfig().panelist_pool || {};
    const profile = this._resolvePanelistProfile(poolKey, pool);
    return profile?.name || poolKey;
  }

  /**
   * 記録した回の要約を作る。既に作ってあればそれをそのまま返す。
   * 全体のまとめに加えて、心に残る発言と面白かったやり取りも取り上げる。
   *
   * @param {any} id 対象の回の識別子
   * @returns {Promise<any>} 要約。作れなければ error
   */
  async generateArchiveSummary(id) {
    const entry = this._playedPieces.find(e => e.id === id);
    if (!entry) return { error: 'アーカイブが見つかりません' };
    if (entry.summary) return entry.summary;

    const transcript = entry.transcript || [];
    if (transcript.length < ARCHIVE_SUMMARY_MIN_TRANSCRIPT_ENTRIES) {
      return { error: '会話量が少ないため要約を生成できません' };
    }

    const transcriptText = transcript
      .map(t => `${this._resolveArchiveSpeakerName(t.speaker)}: ${t.text}`)
      .join('\n');

    const config = this.getConfig();
    const systemPrompt = 'あなたは『The Answers』という討論番組の内容を振り返る、要約作成の専門家です。';
    const userPrompt = `以下は討論番組『The Answers』の1エピソード分の会話ログです。テーマ「${entry.theme}」について
${(entry.panelKeys || []).length}名のパネリストが議論しました。

【会話ログ】
${transcriptText}

上記を踏まえて、以下をJSON形式で出力してください（マークダウン不要）:
{
  "summary": "番組全体でどんな意見が出て、どう議論が展開したかを4〜6文程度でまとめる（結論を一つに絞る必要はない。対立した意見があればそれも書く）",
  "highlights": ["心に残る名言・鋭い指摘・面白かったやり取りを1〜2文の形で3〜5個。「○○さんの『〜』という発言が印象的でした」のように、誰の発言かが分かる形で書く"]
}`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'archive_summary');
    const match = raw && raw.match(/\{[\s\S]*\}/);
    if (!match) return { error: '要約の生成に失敗しました' };
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      getLogger().warn('[TheAnswers] アーカイブ要約パース失敗: ' + e.message);
      return { error: '要約の生成に失敗しました' };
    }
    if (!parsed.summary) return { error: '要約の生成に失敗しました' };

    const summary = {
      summary: parsed.summary,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.filter(h => typeof h === 'string' && h.trim()) : [],
      generatedAt: new Date().toISOString(),
    };
    entry.summary = summary;
    this._savePlayedPieces();
    return summary;
  }

  // 討論が成り立つ「具体的で答えを持てる問い」の書き方。テーマを自動で決めるときと、
  // 送られた議題を言い換えるときの両方で使う。
  // ATTENTION: 漠然とした一般論をテーマにしないこと。具体的な意見が出せず討論にならない。
  // ATTENTION: 対立軸のある問いに偏らせないこと。二択ばかりになるため、各自が自分なりの
  // 見立てを展開できる開かれた問いも同じ重さの選択肢として示す。
  static THEME_DEBATE_GUIDE = `【重要】テーマは必ず、次のどちらかの形の「具体的で答えを持てる1つの問い」にしてください。
漠然とした一般論のトピック名（「〜について」「〜のあり方」）は禁止です。

■ 形式A: 賛否が分かれる対立軸のある問い（「Aすべきか、Aすべきでないか」「Xか、Yか」）
良い例:
- 「AIの活用は政府などの機関が規制すべきか、それとも自由な発展に任せるべきか？」
- 「熊は駆除すべきか、駆除すべきではないか？」
- 「選択的夫婦別姓は導入すべきか、しないべきか？」

■ 形式B: 一つの正解が無く、各パネリストが自分なりの理論・見立てを展開できる開かれた問い
（「なぜ〜なのか」「〜の根本的な原因・解決策は何か」）。賛否を問う対立構造で無くてよい。
むしろ「対立させる」のではなく「それぞれの理論・仮説を持ち寄って議論を深める」形になる。
良い例:
- 「日本の相続税はなぜこんなに高いのか？」
- 「気候変動の根本的な解決策は何か？」
- 「少子化が一向に改善しないのは、本当は何が原因なのか？」

形式A・Bのどちらも歓迎します。**形式Aの二択テーマ（〜か、それとも〜か）ばかりに偏らせず、
形式Bの開かれた問いも積極的に選んでください。**
悪い例（形式A・Bどちらにも当てはまらない、問いの形になっていない漠然とした一般論。避けること）:
- 「AIが社会に与える影響」（問いの形になっておらず、対立軸も理論展開の余地も無い）
- 「熊と人間の共生について」（同上）

【重要・テーマのジャンルを幅広く・バランスよく】政治・経済・社会問題・国際情勢・芸能ニュースのような
時事性の高いテーマと、身近で具体的な生活密着型のテーマの両方を積極的に混ぜてください。
どちらか一方に偏らせないこと（生活密着型の些細な話題ばかりが続くのも、硬いニュースばかりが
続くのも、どちらも避けること）。
良い例（時事性の高いテーマ。政治・国際情勢・経済・芸能など）:
- 「野党の審議拒否は正当な行動か、それとも職務放棄か？」（形式A）
- 「ホルムズ海峡の封鎖は正当な手段か、それとも国際法違反か？」（形式A）
- 「日本の相続税はなぜこんなに高いのか？」（形式B）
良い例（身近で具体的な生活密着型テーマ）:
- 「大谷翔平選手は二刀流を続けるべきか、投手またはバッターに専念すべきか？」（形式A）
- 「カレーライスの肉は牛肉であるべきか、豚肉であるべきか？」（形式A。ただしこの手の二択ばかりに
  ならないよう、形式Bの開かれた問いも忘れず混ぜること）
（生活密着型の些細なテーマを大まじめに議論するのもこの番組の魅力の一つですが、それだけに
偏らせず、硬派な時事ネタ・形式Bの理論展開テーマともバランスよく組み合わせてください）
悪い例（テーマの規模の大小に関わらず、具体的な出来事に紐づかず抽象的・漠然としすぎている。避けること）:
- 「国際的なAIガバナンスのあり方について」（一般論で問いの形になっていない）
- 「経済政策の今後について」（同上）
金融政策・国際情勢のように抽象論になりがちな分野を扱う場合は、実際の出来事・具体的な状況に
紐づけて形式Aか形式Bいずれかの具体的な問いに落とし込むこと（例:「中央銀行デジタル通貨（CBDC）は
推進すべきか？」ではなく「CBDCが導入され現金が使えなくなる可能性があっても、それでも導入に
賛成すべきか？」（形式A）、あるいは「なぜ各国はCBDC導入に慎重なのか？」（形式B）のように、
一般論ではなく具体的な問いで扱う）。`;

  // ATTENTION: リスナーの趣味や興味は手がかりに留めること。本人だけの具体的な事情を
  // そのままテーマにすると、誰も議論できない回になる（実際に起きている）。
  static THEME_BROAD_APPEAL_NOTE = `【重要・リスナー個人の趣味をテーマ化しない】リスナーの興味・プロフィールは、
話題の「分野」を選ぶ際のヒントとして参考程度に使ってよいですが、リスナー本人だけの具体的な状況や
決断をそのままテーマにしてはいけません。テーマは、リスナーではなく世の中の多くの人が意見を持てる、
一般的な問いにしてください。
悪い例（リスナー個人の話になってしまっている）:
- 「リスナーが趣味で作っているオーディオアンプは自作すべきか、既製品を買うべきか？」
良い例（同じ「オーディオ」という分野からヒントを得つつ、一般化した問い）:
- 「オーディオ機器はハイレゾ音源にこだわるべきか、手軽さを優先すべきか？」`;

  /**
   * テーマを決めるための材料を集めて1本の文章にする。ニュース・気象・相場・世間の反応・
   * 社説の割れ・専門分野の動き・見た動画・他のディレクターの方針、そして既出のテーマ。
   *
   * ATTENTION: 実際の出来事を渡さずにテーマを決めさせないこと。渡していなかった頃は、
   * 書き方の説明に入っている例文にそのまま収束していた。
   * どの取得も失敗してよい（個別に握りつぶし、テーマ選びそのものは止めない）。
   *
   * @returns {Promise<string>} 集めた材料。何も取れなければ空文字
   */
  async _buildTopicalGroundingText() {
    const listener = this._getListenerProfile();
    const creds = this.getCredentials();
    const config = this.getConfig();

    // ニュースの見出し（総合・国内・国際・経済）
    const newsHeadlines = await topical.buildNewsHeadlinesText(this.newsService);

    let weatherNote = '';
    try {
      await this.weatherService.fetch({
        overrideLocation: null,
        defaultLocation: listener.location,
        isTempStay: false,
        apiKey: creds.openweathermap && creds.openweathermap.api_key,
        prefCode: listener.pref_code || '130000',
      });
      const w = this.weatherService.cache?.structured;
      // ATTENTION: 他県の特別警報も見ること。台風・警報・地震しか見ていなかった頃は、
      // 他県で起きている大きな被害がテーマの材料に入らなかった。
      if (w && (w.hasTyphoon || w.hasWarning || w.hasQuake || w.hasNationalAlert)) {
        weatherNote = `\n【現在の気象状況（緊急性が高い場合はテーマ選定の参考に）】${[w.typhoonSummary, w.warningSummary, w.quakeSummary, w.nationalAlertSummary].filter(Boolean).join(' / ')}`;
      }
    } catch (e) {
      getLogger().warn('[TheAnswers] テーマ選定用の気象データ取得に失敗: ' + e.message);
    }

    // 相場の大きな動き。見守り一覧を持たないため、未設定時の既定（主要な指数と為替）を使う。
    // 前日比1%以上だけを拾う（それ未満は通常の値動きで、テーマにならない）。
    let financeNote = '';
    try {
      await this.financeService.fetch(config);
      const structured = this.financeService.cache?.structured || [];
      const notable = structured.filter((r) => typeof r.pct === 'number' && Math.abs(r.pct) >= 1.0);
      if (notable.length > 0) {
        const lines = notable.map((r) => `${r.key}: ${r.pct >= 0 ? '+' : ''}${r.pct.toFixed(1)}%`
          + `（${r.diff >= 0 ? '+' : ''}${r.diff}${r.unit}）`);
        financeNote = `\n【市場の大きな動き（前日比1%以上）】\n${lines.join('\n')}`;
      }
    } catch (e) {
      getLogger().warn('[TheAnswers] テーマ選定用の金融データ取得に失敗: ' + e.message);
    }

    // 世の中の反応。討論のテーマ選びでは「見方が割れている箇所」が材料になるので、
    // 数だけでなく個人の声も含める。
    const trendingText = await topical.buildTrendingText(this.trendingService, { includeVoices: true });

    const recentThemes = this._playedPieces.slice(0, 15).map(p => p.theme).filter(Boolean);
    const recentThemesText = recentThemes.length > 0
      ? `\n【直近に扱った既出テーマ（必ず避けること。同じ話題の言い換えも避けること）】\n${recentThemes.map(t => `- ${t}`).join('\n')}`
      : '';

    // ATTENTION: 「実際に放送した」ものと「見せたが選ばれなかった」ものは別枠で渡すこと。
    // 意味が違うので、まとめると取り違える。
    const suggestedThemes = this._pruneRecentSuggestedThemes();
    const suggestedThemesText = suggestedThemes.length > 0
      ? `\n【直近に候補として提示したが選ばれなかったテーマ（必ず避けること。同じ話題の言い換えも避けること）】\n${suggestedThemes.map(t => `- ${t}`).join('\n')}`
      : '';

    // ① 社説の読み比べ。同じ出来事に対して各社の主張がはっきり割れているものだけが返るので、
    //    「答えは一つじゃない」というこの番組の軸にそのまま合う。判定は他の場所と共有しており、
    //    一定時間は結果が残るため呼び出しは増えない。
    const editorialText = await topical.buildEditorialSplitText({
      apiKey: creds?.gemini?.api_key,
      usageNote: '※ 同じ出来事について新聞各社の主張が実際に割れているものです。討論のテーマとして最も成立しやすい材料なので、'
        + '最優先で検討してください（どちらが正しいかではなく、なぜ割れるのかを問いにすると良い）。',
    });

    // ② 専門分野の最新の動き。
    //    ATTENTION: この番組にはリスナー本人の情報を渡さないので、住んでいる地域の名前を
    //    含む項目も除くこと。
    const specialistText = topical.buildSpecialistDigestText({
      excludeListenerLocal: true,
      usageNote: '※ ニュースの見出しには出てこない、各分野の新しい動きです。暮らし・健康・流行・芸能など'
        + '時事ニュース以外の分野からテーマを選ぶときの手がかりにしてください。',
    });

    // リスナーが実際に見た動画。
    // ATTENTION: ニュースの見出しの後ろに置くこと。先に報道の事実を読ませてから照らし合わせる
    // ためで、順序を逆にすると動画の主張が先入観になる。
    let watchedVideos = '';
    try {
      watchedVideos = youtubeWatchStore.formatForThemeSelection() || '';
    } catch (e) {
      getLogger().debug('[TheAnswers] 視聴動画の読み込みに失敗（無視して続行）: ' + e.message);
    }

    // 他の番組のディレクターが直近に決めた方針
    const otherDirectors = directorBoard.formatOthersForDirector('answers_director', {
      usageNote: '※ Liveで大きな話題として扱っている出来事や、音楽番組の今夜のテーマです。同じ話題を別の角度から'
        + '議論するのも、あえて重ならない分野を選ぶのも自由です。',
    });

    return `\n\n【本日の実際のニュース見出し（Yahoo!ニュース、これらの中から具体的な出来事に基づいたテーマを積極的に選ぶこと）】\n${newsHeadlines}${editorialText}${specialistText}${trendingText}${watchedVideos}${otherDirectors}${weatherNote}${financeNote}${recentThemesText}${suggestedThemesText}`;
  }

  /**
   * 候補として見せたテーマの一覧を、経過時間と件数の両方で頭打ちにして返す。呼ぶたびに
   * 古いものを取り除く。
   * ATTENTION: 時間でも切ること。溜め込み続けると数日経っても同じ話題を避け、新鮮な話題まで
   * 使えなくなる。狙いは同じ場での重複を避けることで、恒久的に外すことではない。
   *
   * @returns {any[]} いま避けるべきテーマ
   */
  _pruneRecentSuggestedThemes() {
    const WINDOW_MS = 3 * 60 * 60 * 1000;
    const MAX_ENTRIES = 30;
    const cutoff = Date.now() - WINDOW_MS;
    this._recentSuggestedThemes = this._recentSuggestedThemes.filter(e => e.ts >= cutoff).slice(-MAX_ENTRIES);
    return this._recentSuggestedThemes.map(e => e.theme);
  }

  /**
   * 作った候補のテーマを「見せたもの」として記録する。
   *
   * @param {any[]} themes 見せたテーマ
   * @returns {void}
   */
  _recordSuggestedThemes(themes) {
    const now = Date.now();
    for (const theme of themes) {
      if (typeof theme === 'string' && theme.trim()) this._recentSuggestedThemes.push({ theme: theme.trim(), ts: now });
    }
    this._pruneRecentSuggestedThemes();
  }

  /**
   * その回のテーマを決める。送られた議題があれば、それを議論できる問いの形へ言い換える。
   *
   * @param {any} userTopic 送られた議題。無ければ自動で決める
   * @returns {Promise<any>} テーマと、その背景の説明
   */
  async _selectTheme(userTopic) {
    const config = this.getConfig();
    const directorCfg = config.director || {};
    const listener = this._getListenerProfile();
    // 秘書との会話から学んだリスナー像の要約
    const listenerDigest = this._getListenerDigest();
    // 週1回まとめている振り返り。自分のテーマ選びの偏りと、出演者の日記から見えた気づき
    const diaryFeedback = this._getAgentDiarySelfDigest('director') + this._getAgentDiaryTeamDigest('director');
    const systemPrompt = directorCfg.prompt ||
      'あなたはディスカッション番組『The Answers』のディレクターです。今日議論すべきテーマを決めてください。';

    if (userTopic && userTopic.trim()) {
      // 送られた議題も、問いの形になっていなければ言い換える（話題そのものは変えない）
      const userPrompt = `リスナーから「${userTopic.trim()}」という議題が提案されました。
${TheAnswersAgentSystem.THEME_DEBATE_GUIDE}

リスナーが意図した話題領域（対象そのもの）はそのまま保つこと。話題を全く別のものに変えてはいけません。
その上で、既に形式Aまたは形式Bの具体的な問いになっており、かつ身近で具体的なテーマであればそのまま
（言い換えずに）使ってください。
もし話題は明確でも、金融政策・マクロ経済・国際政治のようにスケールが大きすぎる・抽象的すぎる場合は、
同じ話題領域の中で、リスナーの生活に近い具体的な切り口に絞り込んでください
（例:「CBDCは推進すべきか？」→「CBDCが導入されたら、あなたの給料や貯金の管理はどう変わるのか、
それでもCBDCの導入に賛成すべきか？」（形式A）、あるいは「なぜCBDCの議論はなかなか進まないのか？」
（形式B）のように、抽象的な政策論ではなく身近な問いに落とし込む）。

有効なJSONのみ出力（マークダウン不要）:
{ "theme": "形式Aまたは形式Bの問いの形にしたテーマ", "concept": "" }`;
      const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'answers_director');
      const match = raw && raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.theme) return { theme: parsed.theme, concept: parsed.concept || '', fromUser: true };
        } catch (e) {
          getLogger().warn('[TheAnswers] ユーザー議題の言い換えパース失敗: ' + e.message);
        }
      }
      return { theme: userTopic.trim(), concept: '', fromUser: true }; // 言い換え失敗時はそのまま使う
    }

    const groundingText = await this._buildTopicalGroundingText();
    const userPrompt = `リスナーから議題の指定はありませんでした。今日、複数の視点から議論しがいのある旬な話題を1つ選んでください。
${listener.interests ? `リスナーの興味（あくまで参考程度のヒント）: ${listener.interests}` : ''}${listenerDigest ? `\n【AI秘書がこれまでの会話から学んだリスナー像（あくまで参考程度のヒント）】${listenerDigest}` : ''}${diaryFeedback}
「答えは一つじゃない」という番組コンセプトに合うテーマが望ましいです（社会問題・時事ニュース・身近な論争・各人の理論が試されるような根源的な問いなど）。
${TheAnswersAgentSystem.THEME_BROAD_APPEAL_NOTE}
${TheAnswersAgentSystem.THEME_DEBATE_GUIDE}
${groundingText}

【重要】上に列挙した「本日の実際のニュース見出し」「各社の主張が割れている話題」「専門分野の最新の動き」
「世の中で反応が多かった話題」「リスナーが実際に見た解説動画」「既出テーマ」を必ず確認し、既出テーマとの
重複・言い換えを避けた上で、実際に起きている出来事に基づいた具体的なテーマを優先してください。
【最重要・2026-09-18】「各社の主張が割れている話題」があれば、それが討論として最も成立しやすい材料です。
なぜ主張が割れるのかを問いにする形で、最優先で検討してください。
【最重要・2026-09-14】**ニュース見出しと、リスナーが見た解説動画を照らし合わせてください。**
両方に同じ出来事が現れていれば、それは報道されていて**かつ**リスナーが自分で掘りに行った話題
——議論しがいがあり、かつ聴いてもらえる可能性が最も高い組み合わせです。最優先で検討してください。
動画にだけ現れている論点は、まだ表で議論されていない争点かもしれません（ただし個人の発信を含む
未検証の情報なので、動画の主張をそのままテーマにせず、争点だけを取り出して問いに組み直すこと）。
【最重要・2026-08-23】「反応が多かった話題」にはブックマーク数＝実際に反応した人数が添えてあります。
**数字が大きいものほど多くの人が関心を持った話題**なので、手がかりとして重視してください。
ただし件数の順に機械的に選ぶのではなく、**討論として成立するか**（賛否が割れる／複数の見方が
できる／各人の理論を展開できる）で選ぶこと。芸能人の結婚・スポーツの結果のように、事実の報告で
終わって議論の余地が乏しいものは、反応が多くても避けてください。
出来事そのものをテーマにするのではなく、**そこから立ち上がる問い**に変換すること
（例:「出社より完全リモートワークの方が幸福度が高いという研究結果」→「リモートワークは本当に
幸福度を高めるのか、それとも出社にしかない価値があるのか？」、「内閣支持率が発足以来最低の50%」
→「支持率50%は『ここまで来てまだ50%ある』のか『ついに50%まで落ちた』のか？」）。
【最優先・2026-08-23】「その記事に対して実際に書き込まれた個人の声」の中で、**同じ出来事に
相反する見方が同居している箇所**を見つけたら、それを軸にしたテーマを最優先で選んでください。
そこが討論として最も成立する場所です（例: 支持率の記事に「50もあれば十分だろ」と「まだ高い」が
併存 →「支持率50%は『まだ50%もある』のか『ついに50%まで落ちた』のか？」）。
ただし前述のとおり、書き込みの内容を事実として扱わないこと。**見方が分かれているという事実**
だけを使ってください。
どれも議論に向かない場合のみ、ガイド中の例文のような一般的なテーマで構いません。

有効なJSONのみ出力（マークダウン不要）:
{ "theme": "対立軸のある問いの形のテーマ", "concept": "このテーマを選んだ理由（1〜2文）" }`;

    const raw = await this._callGemini(systemPrompt, userPrompt, true, 'main', 'answers_director');
    const fallback = { theme: '熊は駆除すべきか、駆除すべきではないか？', concept: '', fromUser: false };
    if (!raw) return fallback;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      const parsed = JSON.parse(match[0]);
      return { theme: parsed.theme || fallback.theme, concept: parsed.concept || '', fromUser: false };
    } catch (e) {
      getLogger().warn('[TheAnswers] テーマ選定パース失敗: ' + e.message);
      return fallback;
    }
  }

  /**
   * 始める前の画面に出す、テーマの候補を3つ作る。選ぶだけで始められるようにするためのもので、
   * これ自体は1回分を開始しない。何度でも呼び直せる。
   *
   * @returns {Promise<any>} 候補のテーマ
   */
  async generateThemeCandidates() {
    // この処理はまだ接続されていない状態で呼ばれることが多いが、配信は接続数に関わらず
    // 行えて、ダッシュボードへ転送される。
    // ATTENTION: アバターの鍵は Live のディレクターの鍵とぶつからない専用のものを使うこと。
    this._broadcast({ event: 'AGENT_THINKING', agent: 'answers_director', state: 'start' });
    try {
      return await this._generateThemeCandidatesInner();
    } finally {
      this._broadcast({ event: 'AGENT_THINKING', agent: 'answers_director', state: 'end' });
    }
  }

  async _generateThemeCandidatesInner() {
    const config = this.getConfig();
    const directorCfg = config.director || {};
    const listener = this._getListenerProfile();
    // ATTENTION: 1つに決める側へ渡している材料は、こちらにも同じだけ渡すこと。実際には
    // こちらの経路のほうがよく使われる。
    const listenerDigest = this._getListenerDigest();
    const diaryFeedback = this._getAgentDiarySelfDigest('director') + this._getAgentDiaryTeamDigest('director');
    const systemPrompt = directorCfg.prompt ||
      'あなたはディスカッション番組『The Answers』のディレクターです。今日議論すべきテーマを決めてください。';

    const groundingText = await this._buildTopicalGroundingText();
    const userPrompt = `複数の視点から議論しがいのある旬な話題を3つ選んでください。
${listener.interests ? `リスナーの興味（あくまで参考程度のヒント）: ${listener.interests}` : ''}${listenerDigest ? `\n【AI秘書がこれまでの会話から学んだリスナー像（あくまで参考程度のヒント）】${listenerDigest}` : ''}${diaryFeedback}
「答えは一つじゃない」という番組コンセプトに合うテーマが望ましいです（社会問題・時事ニュース・身近な論争・各人の理論が試されるような根源的な問いなど）。
${TheAnswersAgentSystem.THEME_BROAD_APPEAL_NOTE}
${TheAnswersAgentSystem.THEME_DEBATE_GUIDE}
${groundingText}

3つは互いに異なる分野からバランスよく選び、似たようなテーマばかりにならないようにしてください。
既出テーマとの重複・言い換えは避けてください。
【最重要・2026-09-18】「各社の主張が割れている話題」があれば、3つのうち1つはそれを軸にしてください
（なぜ主張が割れるのかを問いにする）。また「専門分野の最新の動き」も確認し、時事ニュースに偏らないよう、
暮らし・健康・流行・芸能などの新しい動きから立ち上がる問いも候補に入れてください。
【最重要・2026-08-23】3つのうち**最低2つ**は、上に列挙した「本日の実際のニュース見出し」または
「世の中で反応が多かった話題」に基づいた具体的なテーマにしてください（一般論ではなく、実際に
起きている・起こりうる具体的な状況を踏まえること）。
特に「反応が多かった話題」はブックマーク数＝実際に反応した人数が添えてあります。**数字が大きい
ものほど多くの人が関心を持った話題**なので、テーマ選びの手がかりとして重視してください。
ただし件数の順に機械的に選ぶのではなく、**討論として成立するか**（賛否が割れる／複数の見方が
できる／各人の理論を展開できる）で選ぶこと。芸能人の結婚・スポーツの結果のように、事実の報告で
終わって議論の余地が乏しいものは、反応が多くても避けてください。
良い例:「出社するより完全リモートワークの方が幸福度が高いという研究結果」→「リモートワークは
本当に幸福度を高めるのか、それとも出社にしかない価値があるのか？」、「内閣支持率が発足以来最低の
50%」→「支持率50%は『ここまで来てまだ50%ある』のか『ついに50%まで落ちた』のか？」のように、
出来事そのものではなく**そこから立ち上がる問い**に変換すること。
【最優先・2026-08-23】「その記事に対して実際に書き込まれた個人の声」の中で、**同じ出来事に
相反する見方が同居している箇所**を見つけたら、それを軸にしたテーマを最優先で選んでください。
そこが討論として最も成立する場所です（例: 支持率の記事に「50もあれば十分だろ」と「まだ高い」が
併存 →「支持率50%は『まだ50%もある』のか『ついに50%まで落ちた』のか？」）。
ただし前述のとおり、書き込みの内容を事実として扱わないこと。**見方が分かれているという事実**
だけを使ってください。
残りの1つは、身近で具体的な生活密着型のテーマなど、それとは異なる分野から選んでください。
**3つとも形式A（対立軸のある二択）に偏らせず、最低1つは形式B（各人の理論・見立てを展開できる
開かれた問い。例:「日本の相続税はなぜこんなに高いのか？」「気候変動の根本的な解決策は何か？」）
にすること。**

有効なJSONのみ出力（マークダウン不要）:
{ "themes": ["テーマ1（形式Aまたは形式B）", "テーマ2", "テーマ3"] }`;

    const fallback = [
      '熊は駆除すべきか、駆除すべきではないか？',
      '目玉焼きには醤油をかけるべきか、ソースをかけるべきか？',
      'スマートフォンの学校への持ち込みは禁止すべきか、認めるべきか？',
    ];
    const raw = await this._callGemini(systemPrompt, userPrompt, true, 'main', 'answers_director');
    if (!raw) return fallback;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.themes) && parsed.themes.length > 0) {
        const themes = parsed.themes.filter(t => typeof t === 'string' && t.trim()).slice(0, 3);
        // 次に候補を作り直すとき、この3つを避けられるよう記録する
        this._recordSuggestedThemes(themes);
        return themes;
      }
      return fallback;
    } catch (e) {
      getLogger().warn('[TheAnswers] テーマ候補生成パース失敗: ' + e.message);
      return fallback;
    }
  }

  /**
   * その回の出演者を選ぶ。専門家型に偏らせず、視点の種類を散らし、直近に出た人は避ける。
   *
   * @param {any} theme その回のテーマ
   * @returns {Promise<any[]>} 選んだ出演者
   */
  async _selectPanelists(theme) {
    const config = this.getConfig();
    const pool = config.panelist_pool || {};
    const directorCfg = config.director || {};
    const recentKeys = this._recentPanelKeys();

    const allProfiles = Object.keys(pool)
      .map(k => this._resolvePanelistProfile(k, pool))
      .filter(Boolean);

    const alwaysInclude = allProfiles.filter(p => p.always_include);
    const candidates = allProfiles.filter(p => !p.always_include);

    const candidateLines = candidates.map(p => {
      const flags = [
        p.news_briefing_default ? '実際のニュースが元になったテーマなら優先起用（事実解説担当）' : null,
        recentKeys.has(p.poolKey) ? '直近起用済み（できれば避ける）' : null,
      ].filter(Boolean).join('・');
      const attrs = [p.gender, p.age_bracket, p.marital_status, p.political_stance, p.hometown_region, p.perspective_type].filter(Boolean).join('/');
      // ATTENTION: 人物像（本来の人格の冒頭）も渡すこと。名前と属性だけでは、テーマに合う
      // 経歴の人を見分ける材料が無い。肩書きは持たない人もいるので、ある場合だけ付ける。
      const gist = (p.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return `- ${p.poolKey}: ${p.name}${p.role ? `（${p.role}）` : ''}${attrs ? ` [${attrs}]` : ''}`
        + `${gist ? ` — 人物像: ${gist}…` : ''} — 隠れた才能: ${p.hidden_talent_prompt || 'なし'}${flags ? ` [${flags}]` : ''}`;
    }).join('\n');

    const systemPrompt = directorCfg.prompt ||
      'あなたはディスカッション番組『The Answers』のディレクターです。テーマに応じてパネリストを選出してください。';
    const userPrompt = `今回のテーマ「${theme}」にふさわしいパネリストを、以下の候補から${config.program?.panelist_count_min || 3}〜${config.program?.panelist_count_max || 4}名選んでください。誰を呼ぶかは完全にあなたの裁量です。

【候補一覧】各候補の[ ]内は「性別/年代/未婚・既婚/政治的スタンス/出身地/視点タイプ」です。
${candidateLines}

【選定方針】
- 専門家型ばかりに偏らせないこと。専門家型（法律・金融・報道・気象・交通等の専門知識で語るタイプ）以外の
  視点（庶民感覚型／芸術家・感性型／こだわり・目利き型／変わり者・独自路線型）を必ず2名以上含めること
- 直近起用済みの人はできるだけ避け、別の顔ぶれを優先する
- 「隠れた才能」を活かせる意外な組み合わせを歓迎する
- テーマに直接関係する専門性を持つ候補がいれば積極的に含める
- テーマが実際のニュース・出来事（政策決定・事件・経済指標など）が元になっている場合は、
  事実解説担当（news_briefing_default）を積極的に含めること
- 毎回同じ顔ぶれに偏らないこと。候補全員を対象に多様な組み合わせを積極的に試すこと
- 意見がぶつかり合いそうな、対照的な立場を取りそうな組み合わせを意識すること（同じような意見しか出ない
  組み合わせは避ける）

【属性バランス】
- 性別は男性・女性どちらか一方に偏らせないこと（両方を必ず含める）
- 年代・未婚/既婚・政治的スタンス（保守/中道/革新）は、選ぶメンバー間でできるだけばらけさせること
  （全員が同じ年代・同じスタンスに偏らないようにする。ただしテーマとの関連性や意見の対立構図を
  優先し、属性を揃えるために不自然な人選をする必要はない）
- テーマに地域差が関わる場合（例:食べ物・方言・生活習慣の東西差など）は、出身地の異なる候補を
  積極的に組み合わせること（例: 関東出身と関西出身の両方を含める）
- 視点タイプも同じタイプに偏らせず、上記【選定方針】の専門家型以外2名以上ルールを満たしつつ
  できるだけ多様なタイプを組み合わせること

有効なJSONのみ出力（マークダウン不要）:
{ "panelKeys": ["poolKeyの配列"] }`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'answers_director');
    let selectedKeys = [];
    const match = raw && raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.panelKeys)) selectedKeys = parsed.panelKeys.filter(k => pool[k] && !pool[k].always_include);
      } catch (e) {
        getLogger().warn('[TheAnswers] パネリスト選定パース失敗: ' + e.message);
      }
    }
    // 選べなかった場合は、専門家型以外の視点を優先しつつ機械的に選ぶ
    if (selectedKeys.length === 0) {
      const fallbackCount = config.program?.panelist_count_max || 4;
      const nonExpert = candidates.find(p => p.perspective_type && p.perspective_type !== '専門家型' && !recentKeys.has(p.poolKey));
      const others = candidates.filter(p => p !== nonExpert && !recentKeys.has(p.poolKey));
      selectedKeys = [nonExpert, ...others].filter(Boolean).slice(0, fallbackCount).map(p => p.poolKey);
    }

    const resolvedSelected = selectedKeys.map(k => this._resolvePanelistProfile(k, pool)).filter(Boolean);
    const panel = [...alwaysInclude, ...resolvedSelected];

    this._activePanel = {};
    for (const p of panel) this._activePanel[p.poolKey] = p;
    return panel;
  }

  /**
   * 放送ループ。このチャンネルは議題が送られるまで完全に待つので、ここでは何もしない。
   *
   * @returns {void}
   */
  startShowLoop() {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;
    this._broadcastCastList();
    getLogger().info('[TheAnswers] 待機状態で起動（議題送信を待機中）');
  }

  async startEpisode(userTopic) {
    if (this._state !== 'idle') return { ok: false, error: 'エピソードが既に進行中です' };
    this._state = 'running';
    this._sessionStartTime = Date.now();
    this._transcript = [];
    this._handRaiseQueue = [];
    this._recentlySpokenKeys = [];
    this._historyRecorded = false;

    const token = { aborted: false };
    this._episodeToken = token;

    this._runEpisode(userTopic, token).catch(e => {
      getLogger().error('[TheAnswers] エピソード実行エラー: ' + e.message);
      if (this._episodeToken === token) this._resetEpisodeState();
    });
    return { ok: true };
  }

  /**
   * 実行中の1回分を打ち切って初期状態へ戻す。全リスナーが退出したときなどに呼ぶ。
   * 実行中の処理は中断の印を見て自分から止まるので、ここでの初期化とぶつからない。
   *
   * @returns {void}
   */
  _resetEpisodeState() {
    if (this._episodeToken) this._episodeToken.aborted = true;
    // ATTENTION: 途中で終わった回でも、出演者が決まっていたなら記録に残すこと。続けて出さない
    // 判定の対象にもなるべきため。自然に終わった側で記録済みなら、印を見て二重に残さない。
    // 記録に残さない場合でも、録音は始まっている可能性があるので必ず止めて後始末する。
    const cleanupEmptyRecording = () => {
      if (!this._archiveRecorder) return;
      this._finalizeArchiveRecording().then(result => {
        if (result?.path) { try { fs.unlinkSync(result.path); } catch { /* ignore */ } }
      });
    };

    if (!this._historyRecorded && this._topic) {
      const panelKeys = Object.values(this._activePanel).filter(p => !p.always_include).map(p => p.poolKey);
      if (panelKeys.length > 0) {
        // 録音の停止は時間がかかるため、この後の初期化より先に発言の一覧を控えておく
        const theme = this._topic;
        const transcriptSnapshot = this._transcript.slice();
        this._historyRecorded = true; // 非同期保存の完了を待たず直ちに二重記録防止フラグを立てる
        this._finalizeArchiveRecording().then(result => {
          this._saveArchiveEntry(theme, panelKeys, true, result, transcriptSnapshot);
        });
      } else {
        cleanupEmptyRecording();
      }
    } else {
      cleanupEmptyRecording();
    }
    this._episodeToken = null;
    this._state = 'idle';
    this._activePanel = {};
    this._topic = null;
    this._transcript = [];
    this._handRaiseQueue = [];
    // ATTENTION: 先に作っておいた締めのセリフは必ず捨てること。残っていると、次の回で
    // 無関係な締めが使い回される。
    this._closingTextPrefetch = null;
    for (const waiter of this._grantWaiters.values()) { clearTimeout(waiter.timeout); waiter.resolve(null); }
    this._grantWaiters.clear();
    // 締めの音量の切り替え中に割り込む可能性があるため、音量の固定はここでも必ず解く
    // （解かないと次の回で自動の音量調整が効かないままになる）
    try { this.mixer._volumeLocked = false; this.mixer.stopBgm(); } catch { /* ignore */ }
  }

  /**
   * リスナーが切断したときに呼ばれる。全員が退出したら、実行中の回を打ち切って初期化する。
   * ATTENTION: 初期化しないと実行中のまま残り、再接続しても新しい回を始められなくなる。
   *
   * @returns {void}
   */
  onClientDisconnected() {
    super.onClientDisconnected();
    if (this.server.getClientCount() === 0 && this._state !== 'idle') {
      getLogger().info('[TheAnswers] 全リスナー退出のためエピソードを打ち切ります');
      this._resetEpisodeState();
    }
  }

  /**
   * 1回分を通して進める。テーマ決め → 出演者選び → 挨拶 → 事実の共有 → 世の中の反応 →
   * 討論 → 締め、まで。
   *
   * @param {any} userTopic 送られた議題。無ければ自動で決める
   * @param {any} token 中断の印
   * @returns {Promise<void>}
   */
  async _runEpisode(userTopic, token) {
    // 録音を始め、開始の曲を繰り返し流しておく（テーマと出演者を決める間を無音にしないため）
    this._startArchiveRecording();
    const { openingFile, openingStartedAt } = this._startOpeningBgmLoop();

    // 「テーマを整理中」の区間を画面に出す。
    // ATTENTION: 途中で例外が起きても必ず終わりを送ること。送らないと「思考中」のまま固まる。
    this._broadcast({ event: 'AGENT_THINKING', agent: 'answers_director', state: 'start' });
    let themeInfo;
    try {
      themeInfo = await this._selectTheme(userTopic);
    } finally {
      this._broadcast({ event: 'AGENT_THINKING', agent: 'answers_director', state: 'end' });
    }
    if (token.aborted) return;
    this._topic = themeInfo.theme;
    this._broadcast({ event: 'THEME_ANNOUNCED', theme: themeInfo.theme, concept: themeInfo.concept });
    // 他の番組のディレクターへ、この回のテーマを共有する
    try {
      directorBoard.post({
        directorKey: 'answers_director',
        directorName: this.getConfig().agents?.director?.name || '',
        programName: this.getConfig().program?.name || '',
        title: themeInfo.theme, detail: themeInfo.concept || '',
      });
    } catch (e) {
      getLogger().debug(`[DirectorBoard] The Answers: 書き込みに失敗（無視）: ${e.message}`);
    }

    // ディレクターは声を持たず放送に出ないが、テーマを決めた判断そのものが振り返りの材料になる
    const directorName = this.getConfig().agents?.director?.name || 'マーク三浦';
    this._writeDiaryReflection(
      'director', directorName,
      `テーマ「${themeInfo.theme}」\n狙い: ${themeInfo.concept || '（特になし）'}`,
      'theme_selection', 'plan'
    ).catch(() => {});

    const panel = await this._selectPanelists(themeInfo.theme);
    if (token.aborted) return;
    this._broadcastCastList();
    this._broadcast({
      event: 'PANEL_ASSIGNED',
      director: (this.getConfig().director || {}).name || 'マーク三浦',
      panel: panel.map(p => ({
        key: p.poolKey, sourceAgentKey: p.sourceAgentKey, name: p.name, role: p.role,
        perspectiveType: p.perspective_type,
      })),
    });

    getLogger().info(`[TheAnswers] エピソード開始: テーマ「${themeInfo.theme}」 パネル: ${panel.map(p => p.name).join('、')}`);

    // ATTENTION: 各段階の「原稿づくり」と「発話」を重ねること。1つの発話が流れている間に
    // 次の原稿を裏で作らないと、段階の継ぎ目が毎回無音になる。
    const config = this.getConfig();
    const targetMs = (config.program?.session_target_minutes || 25) * 60000;
    const capMs    = (config.program?.session_max_minutes    || 30) * 60000;
    const speakerKeys = panel.filter(p => p.poolKey !== 'live_caster').map(p => p.poolKey);

    // 実際の出来事が元になっているテーマで報道の担当が出ていれば、まず事実を共有してもらう
    // （意見や世論より先に「何が起きたか」を置く）
    const hasNewsDesk = !!this._activePanel['live_news'];
    // 世の中の反応を調べる担当。挨拶からの引き継ぎの言葉に使う
    const opinionSpeakerKey = this._activePanel['live_journalist'] ? 'live_journalist' : 'live_caster';

    // ATTENTION: 検索を伴う重い原稿づくりは、挨拶の原稿を作るより前に始めること。挨拶の
    // 原稿づくりと読み上げにかかる時間をまるごと待ち時間に充てられる。後に回すと、挨拶が
    // 終わっても検索が終わらず空白ができる。
    const afterOpeningPromise = hasNewsDesk
      ? this._withLeadingPcms(this._generateNewsBriefingText(themeInfo), 'live_news').catch(e => { getLogger().warn('[TheAnswers] ニュース解説の先読み生成失敗: ' + e.message); return null; })
      : this._withLeadingPcms(this._generateOpinionResearchText(themeInfo), opinionSpeakerKey).catch(e => { getLogger().warn('[TheAnswers] 世論調査の先読み生成失敗: ' + e.message); return null; });

    // ATTENTION: 曲を落とし始めるのは、挨拶の原稿と冒頭の音声が完全に揃ってから。先に落とすと、
    // 準備が長引いたときに「曲が止まったのに何も聞こえない」時間ができる。繰り返し再生は
    // どれだけ長引いても埋めてくれるので、落とし始めを遅らせれば無音は原理的に出ない。
    const openingText = await this._generateOpeningText(themeInfo, panel, hasNewsDesk, opinionSpeakerKey);
    if (token.aborted) return;
    const openingLeadingPcms = await this._synthesizeLeadingPcms(openingText, 'live_caster');
    if (token.aborted) return;

    if (openingFile) {
      // 準備が最低再生時間より早く終わった場合は、曲が短く切れた印象にならないよう待つ
      const elapsedMs = Date.now() - openingStartedAt;
      if (elapsedMs < OPENING_MIN_PLAY_MS) {
        await new Promise(r => setTimeout(r, OPENING_MIN_PLAY_MS - elapsedMs));
      }
      if (token.aborted) return;
      await this.mixer.fadeBgmTo(0, 2000);
      this.mixer.stopBgm();
    }
    if (token.aborted) return;

    if (openingText) {
      await this.speakText(openingText, 'live_caster', openingLeadingPcms);
      this._transcript.push({ speaker: 'live_caster', text: openingText, ts: Date.now() });
    }
    if (token.aborted) return;

    let opinion;
    if (hasNewsDesk) {
      const newsBriefing = await afterOpeningPromise;
      if (token.aborted) return;
      // 事実の共有を話している間に、続く世の中の反応を裏で作る
      const opinionPromise = this._withLeadingPcms(this._generateOpinionResearchText(themeInfo), opinionSpeakerKey)
        .catch(e => { getLogger().warn('[TheAnswers] 世論調査の先読み生成失敗: ' + e.message); return null; });
      if (newsBriefing) {
        await this.speakText(newsBriefing.text, 'live_news', newsBriefing.leadingPcms);
        this._transcript.push({ speaker: 'live_news', text: newsBriefing.text, ts: Date.now() });
        this._broadcast({ event: 'NEWS_BRIEFING', summary: newsBriefing.text });
      }
      opinion = await opinionPromise;
    } else {
      opinion = await afterOpeningPromise;
    }
    if (token.aborted) return;

    let firstTurnPromise = null;
    if (opinion) {
      // 世の中の反応を話している間に、討論の最初のターンを裏で用意する。
      // ATTENTION: いま読んでいる内容はまだ発言の一覧に入っていないので、明示的に渡すこと。
      firstTurnPromise = this._prepareNextTurn(themeInfo, panel, speakerKeys, targetMs, capMs,
        [{ speaker: opinion.speakerKey, text: opinion.text }])
        .catch(e => { getLogger().warn('[TheAnswers] 最初のターンの先読み失敗: ' + e.message); return null; });
      await this.speakText(opinion.text, opinion.speakerKey, opinion.leadingPcms);
      this._transcript.push({ speaker: opinion.speakerKey, text: opinion.text, ts: Date.now() });
      this._broadcast({ event: 'OPINION_RESEARCH', summary: opinion.text, speaker: opinion.speakerKey });
    }
    if (token.aborted) return;

    // ここから出演者どうしの討論が始まるので、このタイミングで初めて静かな背景の曲を流す。
    // 挨拶や事実の共有の間は流さない（開始の曲 → 無音 → 討論と同時に背景の曲、という区切りを
    // はっきりさせるため）。
    if (fs.existsSync(THE_ANSWERS_BGM_MAIN_DIR) && fs.readdirSync(THE_ANSWERS_BGM_MAIN_DIR).some(f => f.endsWith('.mp3'))) {
      this.mixer.playAmbientShuffle(THE_ANSWERS_BGM_MAIN_DIR, 0.3);
    }

    await this._runDiscussion(themeInfo, panel, firstTurnPromise, token);
    if (token.aborted) return;
    await this._generateClosing(panel);
    if (token.aborted) return;
    // 締めの後、エンディングの曲の前に一度だけ拍手を鳴らす。
    // ATTENTION: 鳴らす合図はコード側で出すこと（生成された印には頼らない）。
    // 司会の発話中として囲み、演出の間にアバターが切り替わらないようにする。
    await this._playSfxAsAgent('applause', 'live_caster', 0);
    await this._endEpisode(themeInfo, panel);
  }

  /**
   * フォルダーの中から曲のファイル名を1つ無作為に返す（絶対パスではなくファイル名）。
   * ミキサーが置き場からの相対のファイル名を求めるため、絶対パスを返すものとは別に用意している。
   *
   * @param {string} dir 探すフォルダー
   * @returns {any} ファイル名。無ければ null
   */
  _pickMp3FileName(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) return null;
    return files[Math.floor(Math.random() * files.length)];
  }

  /**
   * 1回分の全体を録音し始める。開始の曲が鳴る前から録り始めて、最初から最後までを1本に残す。
   *
   * @returns {void}
   */
  _startArchiveRecording() {
    const archiveRecorder = new ProgramRecorder();
    archiveRecorder.start(path.join(THE_ANSWERS_ARCHIVE_AUDIO_DIR, `${uuidv4()}.mp3`));
    this.mixer.attachRecorder(archiveRecorder);
    this._archiveRecorder = archiveRecorder;
  }

  /**
   * 開始の曲を、準備が整うまで先に繰り返し流しておく。聴き始めた瞬間から何か鳴っている状態にし、
   * テーマと出演者を決める数十秒を無音にしないため。
   *
   * @returns {any} 流した曲と開始時刻。曲が無ければどちらも null
   */
  _startOpeningBgmLoop() {
    const openingFile = this._pickMp3FileName(THE_ANSWERS_BGM_OPENING_DIR);
    let openingStartedAt = null;
    if (openingFile) {
      this._broadcast({ event: 'NOTIFY', message: 'オープニング' });
      this.mixer.playBgm(openingFile);
      openingStartedAt = Date.now();
    }
    return { openingFile, openingStartedAt };
  }

  /**
   * 原稿づくりの後ろに「冒頭2文の音声合成」をつなぐ。原稿が出来上がると同時に冒頭の音声も
   * 用意され、話し始めるときの待ちが無くなる。
   *
   * @param {any} p 原稿づくりの処理
   * @param {any} fallbackSpeakerKey 話者が決まっていない場合に使う話者の鍵
   * @returns {Promise<any>} 原稿と冒頭の音声
   */
  _withLeadingPcms(p, fallbackSpeakerKey) {
    return p.then(async result => {
      if (!result) return null;
      const spk = result.speakerKey || fallbackSpeakerKey;
      const leadingPcms = await this._synthesizeLeadingPcms(result.text, spk).catch(() => null);
      return { ...result, leadingPcms };
    });
  }

  /**
   * 司会がテーマと出演者を紹介する挨拶の原稿を作る（読み上げはしない）。
   *
   * @param {any} themeInfo その回のテーマ
   * @param {any} panel 出演者
   * @param {boolean} [hasNewsDesk] 事実の共有をする担当が出ているか
   * @param {any} [opinionSpeakerKey] 世の中の反応を話す担当の鍵。司会自身が続けるなら null
   * @returns {Promise<any>} 挨拶の原稿
   */
  async _generateOpeningText(themeInfo, panel, hasNewsDesk = false, opinionSpeakerKey = null) {
    const config = this.getConfig();
    const casterProfile = this._activePanel['live_caster'];
    if (!casterProfile) return null;

    const panelNames = panel.filter(p => p.poolKey !== 'live_caster')
      .map(p => p.name).join('、');
    const newsProfile = hasNewsDesk ? this._activePanel['live_news'] : null;
    const opinionProfile = (!hasNewsDesk && opinionSpeakerKey && opinionSpeakerKey !== 'live_caster')
      ? this._activePanel[opinionSpeakerKey] : null;
    const systemPrompt = this._applyMaxChars(casterProfile.prompt, 'live_caster');

    // BUGFIX: いまの日時を必ず渡すこと。渡さないと、この番組には無い「毎週◯曜の夜にお届け」
    // のような架空の放送予定を司会が口にする。
    const now = new Date();
    const dateStr = now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const hour = now.getHours();
    const timeOfDay = hour < 5 ? '深夜' : hour < 10 ? '朝' : hour < 17 ? '昼' : hour < 21 ? '夕方〜夜' : '夜';

    // ATTENTION: 本人の名前を明示的に伝えること。人格の設定は自分の名前を書かない作りなので、
    // 渡さないと自己紹介で穴埋めの記号がそのまま読まれる。
    const userPrompt = `『The Answers』のオープニングです。あなたの名前は${casterProfile.name}です。
【現在の日時】${dateStr}・${timeOfDay}（${String(hour).padStart(2, '0')}時台）
今日のテーマ「${themeInfo.theme}」を紹介し、本日のパネリスト（${panelNames}）を紹介してください。
「答えは一つじゃない」という番組コンセプトにも軽く触れてください。
自己紹介では必ず実際の名前「${casterProfile.name}」を名乗ってください（プレースホルダや仮名は使わないこと）。
⚠️【重要】この番組は曜日・時間帯が固定されていない、リスナーが好きなタイミングで開始できる番組です。
「毎週○曜日の夜にお届けする」のような、存在しない定期放送スケジュールを絶対に口にしないでください。
挨拶は上記の【現在の日時】に合わせて自然に（朝なら「おはようございます」、夜なら「こんばんは」等）行うこと。
❌NG例: 「毎週月曜の夜にお届けする『The Answers』」（固定スケジュールの創作）
✅OK例: 「こんばんは、『The Answers』の時間です」のように、曜日・定期性に触れない自然な挨拶
3〜5文程度で、テンポよく話してください。
${newsProfile ? `【重要】このテーマは実際のニュース・出来事が元になっているため、この直後に${newsProfile.name}が
ニュースをベースに事実関係を解説する構成になっています。オープニングの締めくくりで、
「まずはこの話題について、${newsProfile.name}さんからニュースをベースに詳しく解説してもらいましょう」
のように、自然に話を振ってから終えてください（唐突に場面が切り替わらないようにするため）。` : ''}
${opinionProfile ? `【重要】この直後、${opinionProfile.name}が世間の反応を調べて紹介する構成になっています。
オープニングの締めくくりで、「まずは${opinionProfile.name}さんに、世間の反応を調べてもらいましょう」
のように、自然に話を振ってから終えてください（唐突に場面が切り替わらないようにするため）。` : ''}
${this._noStageDirectionsNote()}`;

    const openingRaw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'live_caster');
    if (openingRaw && !this._looksLikeJapanese(openingRaw)) {
      getLogger().warn(`[TheAnswers] オープニング生成結果が日本語として不自然なため破棄: "${openingRaw.slice(0, 60)}"`);
      return null;
    }
    return openingRaw;
  }

  /**
   * 挨拶より後の発話すべてに添える注意書きを作る。
   *
   * ATTENTION: 話者の名前と「番組は既に始まっている」という文脈を毎回明示すること。1回ずつが
   * 独立した呼び出しなので、渡さないと毎回挨拶と自己紹介をやり直したり、名前を穴埋めの記号の
   * まま読んだりする。
   *
   * @param {any} speakerProfile 話す人の情報
   * @returns {string} 添える注意書き
   */
  _continuationNote(speakerProfile) {
    return `⚠️【最重要】あなたの名前は${speakerProfile.name}です。自己紹介・名乗りの際は必ずこの実際の名前を
使ってください（「〇〇（MCの名前）」のようなプレースホルダ・仮名は絶対禁止）。

⚠️【絶対禁止】番組『The Answers』のオープニング挨拶は、別の発言で既に終わっています。
あなたが今から話すのはその続きです。「皆さんこんにちは」「○○です」「さあ、始まりました」のような
挨拶・自己紹介・番組の再オープニングを繰り返すことは絶対に禁止です（放送事故になります）。
❌NG例: 「はい、皆さんこんにちは！${speakerProfile.name}です！さあ、今日のテーマは...」
✅OK例: 「さて、このテーマについて調べてみたのですが、」のように、挨拶抜きでいきなり本題から始めること

${this._noStageDirectionsNote()}`;
  }

  /**
   * 同じ内容を言い換えて2回述べてしまった応答から、2周目を切り落とす。
   *
   * 検索を伴う生成では、言い回しを変えて同じ話を繰り返すことがまれにある。文字列がそろわない
   * ので完全一致の判定では拾えない。この注意書きを使う発言は必ず冒頭で名乗るため、名乗りが
   * 2回以上出てきたら2周目が始まった証拠とみなす。
   *
   * @param {string} text 生成された文章
   * @param {any} speakerName 話者の名前
   * @returns {string} 1周目だけにした文章
   */
  _stripDuplicateSelfIntro(text, speakerName) {
    if (!text || !speakerName) return text;
    const coreName = speakerName.split(/[（(]/)[0].trim();
    if (!coreName) return text;
    const escaped = coreName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}[^。\\n]{0,15}?(?:です|でーす)`, 'g');
    const matches = [...text.matchAll(pattern)];
    if (matches.length < 2) return text;
    const truncated = text.slice(0, matches[1].index).trim();
    if (truncated) {
      getLogger().warn(`[TheAnswers] ${speakerName}の自己紹介パターンが2回検出→2回目以降を切り捨て`);
      return truncated;
    }
    return text;
  }

  /**
   * 生成された文章が日本語かどうかを大まかに判定する。この番組では全員が日本語で話す。
   *
   * BUGFIX: ほぼ英語の文章はここで捨てること。内部の思考が混ざったり生成に失敗したりして、
   * テーマと無関係な英文がそのまま返り、読み上げに渡って弾かれた事故がある。
   * ATTENTION: 機械が読む形を取り出す呼び出しには使わないこと（記号と英数字が主体になる）。
   *
   * @param {string} text 判定する文章
   * @returns {boolean} 日本語とみなせるなら true
   */
  _looksLikeJapanese(text) {
    if (!text) return true;
    const jpChars = (text.match(/[぀-ヿ一-鿿]/g) || []).length;
    const latinChars = (text.match(/[A-Za-z]/g) || []).length;
    if (jpChars + latinChars < 10) return true; // 判定材料が少なすぎる場合は素通し
    return jpChars / (jpChars + latinChars) > 0.3;
  }

  async _generateNewsBriefingText(themeInfo) {
    const config = this.getConfig();
    const newsProfile = this._activePanel['live_news'];
    if (!newsProfile) return null;

    const systemPrompt = this._applyMaxChars(newsProfile.prompt, 'live_news');
    const userPrompt = `${this._continuationNote(newsProfile)}

⚠️【最重要】ここは『The Answers』というディスカッション番組です。あなたが普段いる報道センターの
「複数のニュースを読み上げるコーナー」ではありません。今回話すのは1つのテーマについての
事実解説だけであり、複数本のニュースを読み上げる構成ではありません。
そのため、「まず最初のニュースです」「〇つ目のニュースです」のような区切り言葉や、
「以上、〇本のニュースをお伝えしました」のような締めくくりは絶対に使わないでください
（これは報道センターでの通常コーナー用の形式であり、ここでは不自然です）。
❌NG例: 「まず最初のニュースです。〜。以上、3本のニュースをお伝えしました。」
✅OK例: 「調べてみたところ、〜という経緯があります。」のように、1つの解説として自然に話すこと

テーマ「${themeInfo.theme}」について、これがどのような出来事・経緯から来ているのか、
Google検索で事実関係を調べてください。

意見や論評は交えず、「何が・いつ・どのように決定/発生したか」という客観的事実の整理に徹してください
（2〜4文程度）。この後パネリストによる意見交換に入るので、その土台となる事実を簡潔に共有してください。`;

    const raw = await this._callGemini(systemPrompt, userPrompt, true, 'main', 'live_news');
    if (raw && !this._looksLikeJapanese(raw)) {
      getLogger().warn(`[TheAnswers] ニュース解説の生成結果が日本語として不自然なため破棄: "${raw.slice(0, 60)}"`);
      return null;
    }
    const text = this._stripDuplicateSelfIntro(raw, newsProfile.name);
    return text ? { text } : null;
  }

  /**
   * 世の中の反応を調べて紹介する原稿を作る（読み上げはしない）。検索で実際の反応を当たる。
   * 担当は、取材を役どころとする人が出ていればその人、いなければ司会が直接紹介する。
   *
   * @param {any} themeInfo その回のテーマ
   * @returns {Promise<any>} 原稿と話者の鍵
   */
  async _generateOpinionResearchText(themeInfo) {
    const config = this.getConfig();
    const journalistProfile = this._activePanel['live_journalist'];
    const speakerProfile = journalistProfile || this._activePanel['live_caster'];
    if (!speakerProfile) return null;
    const speakerKey = journalistProfile ? 'live_journalist' : 'live_caster';

    const systemPrompt = this._applyMaxChars(speakerProfile.prompt, speakerKey);
    const userPrompt = `${this._continuationNote(speakerProfile)}

テーマ「${themeInfo.theme}」について、世間一般はどう見ているかをGoogle検索で調べてください。
「${themeInfo.theme} 世論 反応」「${themeInfo.theme} Yahoo知恵袋」「${themeInfo.theme} SNS 意見」といった検索で、
ニュースのコメント欄・Q&Aサイト・X（旧Twitter）等の実際の生の反応を調べてください。

調べた内容を2〜4文で紹介してください。必ず「あくまでネット上で見られる反応であり、科学的な世論調査ではない」という
留保を自然な形で含めてください。この後、パネリストによるディスカッションに入るための前振りとして話してください。`;

    const raw = await this._callGemini(systemPrompt, userPrompt, true, 'main', speakerKey);
    if (raw && !this._looksLikeJapanese(raw)) {
      getLogger().warn(`[TheAnswers] 世論調査の生成結果が日本語として不自然なため破棄: "${raw.slice(0, 60)}"`);
      return null;
    }
    const text = this._stripDuplicateSelfIntro(raw, speakerProfile.name);
    return text ? { text, speakerKey } : null;
  }

  /**
   * 出演者1人ぶんの指示を組み立てる。本来の人格に、この番組での裏の顔・番組の性質・
   * 自分が積み上げてきた知識を重ねる。
   *
   * @param {any} profile 出演者の情報
   * @param {any} [themeInfo] その回のテーマ
   * @returns {string} 組み立てた指示
   */
  _buildPanelistSystemPrompt(profile, themeInfo = null) {
    const base = profile.prompt || '';
    const casterName = this._activePanel['live_caster']?.name || '司会者';
    // ATTENTION: 同じ人物が自分のチャンネルで積み上げてきた知識も渡すこと。人格と裏の顔
    // だけでは、手ぶらで議論の席に着くことになる。
    // 知識は元のチャンネルの鍵で保存されているのでそちらを使い、日記の要約だけはこの番組
    // 専用の器から読む（元のチャンネルの日記とは混ぜないという取り決めを守るため）。
    const knowledge = buildAgentKnowledgePack({
      agentKey: profile.sourceAgentKey || profile.poolKey || '',
      selfDigest: this._getAgentDiarySelfDigest(profile.poolKey || ''),
      includeListener: false,   // The Answers は不特定多数へ向けた討論番組のため
      // ATTENTION: 裏の顔は下で番組向けの使い方と一緒に渡すので、ここでは入れないこと。
      // 両方に入れると2回渡り、使う頻度の指示も食い違う。
      includeHiddenTalent: false,
      topic: [themeInfo?.theme, themeInfo?.concept].filter(Boolean).join('\n'),
    });
    // ATTENTION: 人物像を表すのに、本人へ届いていなかった2つも渡すこと。声の演技の設定
    // （合成の指示にだけ使われていた）と、この番組での属性（出演者を選ぶときにだけ使われていた）。
    const roleNote = [profile.tts_profile_title, profile.tts_context]
      .map((t) => String(t || '').trim().replace(/[。.]+$/, '')).filter(Boolean).join('。');
    const attrs = [
      profile.gender && `性別: ${profile.gender}`,
      profile.age_bracket && `年代: ${profile.age_bracket}`,
      profile.marital_status && `家族: ${profile.marital_status}`,
      profile.political_stance && `政治的な立場: ${profile.political_stance}`,
      profile.perspective_type && `ものの見方: ${profile.perspective_type}`,
    ].filter(Boolean);
    const personaBlock = (roleNote || attrs.length)
      ? `\n\n【あなたの人物像】${roleNote ? `\n番組での役柄: ${roleNote}` : ''}${attrs.length ? `\n${attrs.join(' ／ ')}` : ''}\n`
        + '※ これはあなたが議論で立場を取るときの土台です。感じ方や価値観、どこに目が行くかに自然に反映してください。'
        + '自分から属性を名乗る必要はありません。また、属性から連想される紋切り型の意見に寄せる必要もありません。\n'
      : '';

    // 音楽チャンネルの出演者は、知識の詰め合わせに載るものをほとんど持たない。代わりに、
    // 自分の番組で最近企画したテーマと、自分のチャンネルでの週ごとの振り返りを持ち込む。
    let homeBlock = '';
    if (profile.sourceChannel && profile.sourceChannel !== 'live') {
      try {
        const planner = `${profile.sourceChannel}_director`;
        const themes = directorBoard.formatOwnHistory(planner, {
          limit: 6,
          heading: profile.sourceAgentKey === planner
            ? '【あなたが自分の番組で最近企画したテーマ】'
            : '【あなたの番組で最近取り上げたテーマ】',
        });
        const digest = agentDiary.readDigestText({ channel: profile.sourceChannel, agentKey: profile.sourceAgentKey });
        homeBlock = `${themes}${digest ? `\n\n【自分の番組での振り返り（非公開の日記より）】${digest}\n` : ''}`;
        if (homeBlock) {
          homeBlock += '※ あなたが自分の番組で積み上げてきた見識です。議論のテーマと重なるときは、音楽や番組作りの'
            + '経験から見えることを、自分ならではの視点として活かしてください。\n';
        }
      } catch (e) {
        getLogger().debug(`[TheAnswers] ${profile.poolKey}: 自分の番組での見識の読み込みに失敗（無視）: ${e.message}`);
      }
    }

    return `${base}${personaBlock}${knowledge ? `\n${knowledge}` : ''}${homeBlock}

【The Answers ディスカッション出演時の追加設定】
あなたには本業とは別の「隠れた才能」があります: ${profile.hidden_talent_prompt || '特になし'}。
⚠️【隠れた才能の使用頻度・厳守】これはごくたまに（体感5回に1回程度）、本当にテーマと自然に
重なったときだけさりげなく滲ませる隠し味であり、毎回の発言に必ず盛り込む要素ではありません。
「〜に例えると」「〜の経験から言うと」のように、隠れた才能を軸にした例え話・講釈を毎回の発言の
組み立てに使うことは絶対禁止です。
❌「まるでワインのテイスティングのように、この問題も奥深さがあって〜」（発言のたびにワインへ例える）
❌「バイオリン製作で木材を選ぶときの感覚に似ていて〜」（無関係な話題に無理やりこじつける）
✅ ほとんどの発言では隠れた才能に一切触れず、普通の一人の人間として率直に思ったことをそのまま話す
ここは複数の出演者が"同じ部屋に集まって"顔を合わせて議論するディスカッション番組『The Answers』です。
テンポよく簡潔に（2〜4文程度）発言してください。
${profile.hometown_region ? `あなたの出身地は${profile.hometown_region}です。目玉焼きの調味料・カレーの肉の種類のような
地域差が関わる身近なテーマでは、自分の出身地の感覚に基づいて自然に意見を述べてください（無理にこじつける必要はありません）。` : ''}

【最重要・あなた自身の答えをはっきり出すこと】
『The Answers』の「答えは一つじゃない」というコンセプトは、"番組として"複数の視点を並べて収束させない、
という意味であり、"あなた自身"が意見を濁してよいという意味では全くありません。
むしろ逆で、あなた個人ははっきりとした結論を持ってください。
- テーマが「Aすべきか、Aすべきでないか」のような賛否を問う形式の場合: 発言の冒頭で、まず自分の立場を
  YES/NO・賛成/反対・プラス/マイナスのように明確に宣言すること
- テーマが「なぜ〜なのか」「根本的な解決策は何か」のような、賛否を問わない開かれた問いの場合:
  賛否の宣言は不要。代わりに発言の冒頭で「私は〜が本質的な原因だと思います」「私が考える解決策は
  〜です」のように、自分なりの理論・見立てを一つの明確な主張として打ち出すこと
- いずれの場合も「難しい問題ですね」「一概には言えません」のような玉虫色の答えは絶対に禁止
- そのうえで理由を述べること。ただしこの理由は整った理屈・専門知識である必要は全くありません。
  「なんとなく」「理屈じゃなく直感でそう思う」「うまく言葉にできないけど、こっちの方がいいと感じる」
  のような、根拠を言い切れない人間的な感覚に基づく意見を積極的に歓迎してください。
  全員が理路整然と専門知識・隠れた才能で理由を組み立てると不自然で堅苦しい討論になるため、
  意識的にこうした直感ベースの発言を混ぜること（理屈だけで固めた模範解答のような発言は避ける）
- 八方美人な政治家のような態度（誰の顔も立てて自分の意見を言わない）は、この番組では一番嫌われます

【話し方・議論への向き合い方】
- あなたは今、目の前にいる他の出演者と直接意見を交わしています。電話やリモート出演ではありません
- 発言の最後に「${casterName}さん、どうぞ」「以上です」のように形式的に進行役へ発言権を返す必要はありません。
  そのまま自分の意見を述べて終えてください（進行はあなたの仕事ではありません）
- 直前の発言者（他のパネリスト）の意見に対して、賛成か反対か、あるいはどこが違うと思うかをはっきりさせてから、
  自分の視点を述べてください。ただ自分の意見を独立して述べるだけでなく、相手の主張に食い込んでいくこと
- 相手への呼びかけがあれば「○○さんの意見はわかりますが」のように直接名前を呼んでよい
- 遠慮は不要です。多少強い言葉・感情的な反論になっても構いません（特定個人への誹謗中傷・人格攻撃でなければ
  問題ありません）。AI Radioに「放送事故」という概念はなく、白熱した議論は歓迎されます

${this._noStageDirectionsNote()}`;
  }

  /**
   * 発言者の鍵を、読んで分かる名前に直す。
   *
   * @param {string} speakerKey 発言者の鍵
   * @returns {string} 表示名
   */
  _labelFor(speakerKey) {
    if (speakerKey === 'user') return 'リスナー';
    return this._activePanel[speakerKey]?.name || speakerKey;
  }

  /**
   * 発言の一覧を、名前付きの読める文章に直す。
   *
   * @param {any[]} entries 発言の一覧
   * @returns {string} 整えた文章
   */
  _transcriptText(entries) {
    return entries.map(t => `${this._labelFor(t.speaker)}: ${t.text}`).join('\n');
  }

  /**
   * いま再生中のターンの内容を、まだ一覧に入っていない発言として取り出す。
   *
   * BUGFIX: 次のターンを先に作るとき、いま流れている発言はまだ一覧に入っていない。これを
   * 渡さないと、次の話者が古い情報のまま判断し、既に応えた発言に的外れに反応する。
   *
   * @param {any} prepared 先に用意したターン
   * @returns {any[]} まだ一覧に入っていない発言
   */
  _pendingEntriesFor(prepared) {
    if (!prepared) return [];
    const entries = [];
    if (prepared.transition_line) entries.push({ speaker: 'live_caster', text: prepared.transition_line });
    if (prepared.action === 'panelist_turn' && prepared.target && prepared.preparedText) {
      entries.push({ speaker: prepared.target, text: prepared.preparedText });
    }
    return entries;
  }

  /**
   * 出演者の発言の原稿だけを作る（読み上げはしない。先に作っておくために分けてある）。
   *
   * ATTENTION: 指名されたリスナーの投稿があれば、その本文を必ず渡すこと。直近の発言の一覧
   * だけに頼ると、一般的な指示に落ちて、リスナーの投稿に触れないまま議論が続く。
   *
   * @param {any} poolKey 話す人の鍵
   * @param {any} themeInfo その回のテーマ
   * @param {any[]} [pendingEntries] まだ一覧に入っていない、いま流れている発言
   * @param {any} [userText] 指名されたリスナーの投稿
   * @returns {Promise<any>} 発言の原稿
   */
  async _generatePanelistText(poolKey, themeInfo, pendingEntries = [], userText = null) {
    const profile = this._activePanel[poolKey];
    if (!profile) return null;
    const config = this.getConfig();
    const systemPrompt = this._applyMaxChars(this._buildPanelistSystemPrompt(profile, themeInfo), poolKey);
    const combinedEntries = [...this._transcript.slice(-6), ...pendingEntries];
    const recentContext = this._transcriptText(combinedEntries);

    // BUGFIX: 直近の会話とは別枠で、その人自身の過去の発言だけを必ず渡すこと。出演者が多い
    // 構成では直近の数件に自分の前の発言が残らず、数ターン前に自分がはっきり述べた立場を
    // 知らないまま新しい問いに素直に答えて、傍から見ると主張が急に反転したように見える。
    const ownPriorEntries = this._transcript.filter(t => t.speaker === poolKey);
    const ownPriorNote = ownPriorEntries.length === 0 ? '' : (`\n【あなた自身の、この回でのこれまでの発言（要約ではなく実際の発言）】\n`
      + `${ownPriorEntries.map((e, i) => `${i + 1}. ${e.text}`).join('\n')}\n`
      + `上記はあなた自身が既に述べた内容です。今回の発言でこれと矛盾する結論を出す場合は、`
      + `「〜と言われて考えが変わりました」「〜という点を見落としていました」のように、`
      + `気持ちが変わったこと自体を自分の言葉で明示してください。理由もなく前と違う結論を`
      + `急に述べることは、一貫性のない発言として絶対に避けてください。もちろん、新しい指摘や`
      + `視点を受けて考えが変わること自体は自然なことです——変わってはいけないのではなく、`
      + `変わったなら変わったと自覚して話してください。\n`);

    const lastEntry = combinedEntries[combinedEntries.length - 1];
    const lastSpeakerName = lastEntry ? this._labelFor(lastEntry.speaker) : null;
    const reactionInstruction = userText
      ? `リスナーから次の投稿がありました:「${userText}」。この投稿に直接触れ、リスナーの意見・疑問に
対してあなた自身の立場をはっきり述べてください（無視して自分の話を続けることは禁止です）。`
      : (lastSpeakerName && lastSpeakerName !== 'リスナー'
        ? `直前に${lastSpeakerName}が話した内容に対して、賛成か反対か（テーマが開かれた問いの場合は、
自分の理論・見立てとどう同じ/違うか）を明確にしたうえで、あなた自身の視点を述べてください。`
        : 'あなたの視点をはっきり述べてください。');
    const userPrompt = `テーマ「${themeInfo.theme}」について議論しています。
${recentContext ? `【直近の発言】\n${recentContext}\n` : ''}${ownPriorNote}
${reactionInstruction}
一問一答のように理由を説明するだけで終わらせず、議論を前に進める・相手に切り込む発言にしてください。
冒頭でまず自分の立場・見立てをはっきりと打ち出してから理由を述べること（システムプロンプトの
「あなた自身の答えをはっきり出すこと」を参照）。曖昧な態度は禁止です。`;

    const panelistRaw = await this._callGemini(systemPrompt, userPrompt, false, 'main', poolKey);
    if (panelistRaw && !this._looksLikeJapanese(panelistRaw)) {
      getLogger().warn(`[TheAnswers] ${poolKey}の生成結果が日本語として不自然なため破棄: "${panelistRaw.slice(0, 60)}"`);
      return null;
    }
    return panelistRaw;
  }

  /**
   * 出来ている原稿を実際に読み上げ、発言の一覧に記録する。
   *
   * @param {any} poolKey 話す人の鍵
   * @param {string} text 読み上げる原稿
   * @param {any} [preloadedLeadingPcms] 先に合成しておいた冒頭の音声
   * @returns {Promise<void>}
   */
  async _speakPanelistText(poolKey, text, preloadedLeadingPcms = null) {
    if (!text) return;
    await this.speakText(text, poolKey, preloadedLeadingPcms);
    this._transcript.push({ speaker: poolKey, text, ts: Date.now() });
    this._recentlySpokenKeys.push(poolKey);
    if (this._recentlySpokenKeys.length > 10) this._recentlySpokenKeys.shift();
    // ATTENTION: 日記はここで書かないこと。1回分が終わったときにまとめて1回だけ書く
  }

  /**
   * 台本のト書きや効果音の指示を書かせないための注意書き。発話を作るすべての指示に添える。
   *
   * BUGFIX: この注意書きが無かった頃は、括弧書きの演出メモがそのまま読み上げられる放送事故が
   * 起きた。原稿をそのまま音声にする作りなので、後から取り除くのではなく作る段階で防ぐ。
   * ATTENTION: 括弧書きだけでなく、「◯◯の音が響く中、◯◯が話し始める」のような三人称の
   * 地の文も明示的に禁じること（同じ事故が報告されている）。
   *
   * @returns {string} 添える注意書き
   */
  _noStageDirectionsNote() {
    return 'このセリフはそのまま音声合成されて放送されます。「（SE：〜）」「（BGMフェードアウト）」のような括弧書きの' +
      '効果音・演出指示、ト書き、話者名の表記（「MAX:」等）は絶対に含めないでください。\n' +
      '⚠️また、括弧を使わない地の文（小説・脚本のナレーションのように、状況や話者自身の動作を三人称で' +
      '説明する文）も絶対に含めないでください。\n' +
      '❌NG例:「シンギングボウルとカリンバの優しい音色が心地よく響く中、Maxがゆっくりと話し始める。」\n' +
      '⚠️さらに、「一呼吸置きます」「ここで少し間を置きます」「声のトーンを落とします」のような、' +
      '自分の話し方・間の取り方をそのままナレーションしてしまう一言も絶対に含めないでください' +
      '（間はTTSが自律的に制御するものであり、言葉で説明するものではありません）。\n' +
      '❌NG例:「一呼吸置きます。さて、このテーマについて調べてみたのですが、」\n' +
      '✅OK例: そのようなナレーション文を書かず、いきなり実際に声に出す言葉（「さて、」「今日のテーマは」等）から始めること。\n' +
      '実際に声に出して話す言葉だけを出力すること。\n\n' +
      this._geminiInlineTagGuidanceJa();
  }

  /**
   * 司会が次に何をするかを決める。ターンの区切りごとに呼ばれる。
   *
   * @param {any} themeInfo その回のテーマ
   * @param {any} panel 出演者
   * @param {number} elapsedMs 経過時間
   * @param {number} targetMs 目安の長さ
   * @param {number} capMs 上限の長さ
   * @param {any[]} [pendingEntries] まだ一覧に入っていない、いま流れている発言
   * @returns {Promise<any>} 次の行動と、つなぎの一言
   */
  async _decideNextTurn(themeInfo, panel, elapsedMs, targetMs, capMs, pendingEntries = []) {
    const config = this.getConfig();
    const casterProfile = this._activePanel['live_caster'];
    if (!casterProfile) return { action: 'move_to_closing', target: null, transition_line: '' };

    const speakerKeys = panel.filter(p => p.poolKey !== 'live_caster').map(p => p.poolKey);
    const pendingSpeakerKeys = pendingEntries
      .filter(e => e.speaker !== 'live_caster' && e.speaker !== 'user')
      .map(e => e.speaker);
    const recentSet = new Set([...this._recentlySpokenKeys.slice(-2), ...pendingSpeakerKeys]);
    const notRecentlySpoken = speakerKeys.filter(k => !recentSet.has(k));
    const recentContext = this._transcriptText([...this._transcript.slice(-8), ...pendingEntries]);

    const systemPrompt = casterProfile.prompt;
    const userPrompt = `あなたはディスカッション番組『The Answers』の進行役です。次に何をすべきか判断してください。

【テーマ】${themeInfo.theme}
【経過時間】${Math.floor(elapsedMs / 60000)}分 / 目標${Math.floor(targetMs / 60000)}分（上限${Math.floor(capMs / 60000)}分）
【パネリスト】${speakerKeys.map(k => `${k}(${this._activePanel[k]?.name})`).join('、')}
【直近発言していない人（優先的に振るとよい）】${notRecentlySpoken.join('、') || 'なし'}
【手を挙げているリスナー】${this._handRaiseQueue.length}人待機中

【直近の発言】
${recentContext || '（まだ発言なし）'}

以下のアクションから1つ選んでください:
- panelist_turn: 指定したパネリストに発言してもらう（targetにpoolKeyを指定すること）
- grant_hand_raise: 手を挙げているリスナーを指名する（手を挙げている人がいる場合のみ選べる）
- move_to_closing: 議論をまとめに入る

【重要】
- 経過時間が上限に近い場合は必ずmove_to_closingを選ぶこと
- 同じ人ばかり連続で指名しないこと
- ⚠️【最重要・リスナー参加を後回しにしない】手を挙げているリスナーが1人以上いる場合、
  次のアクションは原則としてgrant_hand_raiseを選んでください。panelist_turnを選ぶのは、
  今まさに二人のパネリストが直接ぶつかり合っていてここで割り込むと著しく不自然になる場合など、
  明確な理由がある時だけです。「後で拾えばいい」と何ターンも後回しにし続けることは禁止です
  （実際に、挙手したリスナーがいつまでも指名されない不具合が過去にありました）。
- あなた（${casterProfile.name}）は交通整理役です。全ての発言に毎回口を挟む必要はありません。
  直前の発言に対して明確に反論・反応したそうな人がいれば、その人を指名して直接ぶつけ合わせてください
  （「一問一答」でテーマの別の面を尋ねるより、今出た意見への反論・応酬を優先すること）
- transition_lineは短く（1文以内）。「では次に○○さん」のような形式的な進行は最小限にし、
  「○○さん、今の意見に異論がありそうですね」のように対立を煽る一言にするか、
  よほど流れを変える必要が無ければ空文字（""）にして、指名されたパネリストにそのまま
  直前の発言へ反応させても構いません
- ⚠️【grant_hand_raise選択時は必ずtransition_lineを空文字（""）にすること】挙手した
  リスナーへの呼びかけ（名前を尋ねる・話したい話題を尋ねる・電話が繋がった、等の演出）は
  この直後にシステムが自動的に行うため、あなたがここで別途「お名前と、どんな話が聞きたいか
  教えてください」「お電話繋がっていますね」のような呼びかけを作文すると、二重・矛盾した
  呼びかけになってしまいます（実際にリスナーの名前が判明済みなのに名前を尋ねる、存在しない
  電話機能に言及する、といった放送事故が発生しました）。grant_hand_raiseの場合は
  transition_lineを空文字にし、呼びかけは一切生成しないこと
- transition_lineはそのまま音声合成されて放送されます。「（SE：〜）」のような効果音・演出指示、
  ト書きは絶対に含めないでください。実際に声に出す言葉だけを入れること

有効なJSONのみ出力（マークダウン不要）:
{ "action": "panelist_turn|grant_hand_raise|move_to_closing", "target": "poolKeyまたはnull", "transition_line": "${casterProfile.name}の短い一言、または空文字" }`;

    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'live_caster');
    const match = raw && raw.match(/\{[\s\S]*\}/);
    if (!match) return { action: 'move_to_closing', target: null, transition_line: '' };
    try {
      const parsed = JSON.parse(match[0]);
      return {
        action: parsed.action || 'move_to_closing',
        target: parsed.target || null,
        transition_line: parsed.transition_line || '',
      };
    } catch (e) {
      getLogger().warn('[TheAnswers] ターン判断パース失敗: ' + e.message);
      return { action: 'move_to_closing', target: null, transition_line: '' };
    }
  }

  /**
   * 指名したリスナーの投稿を待つ。時間切れなら何も返さない。
   * ATTENTION: 待ち時間を短くしないこと。入力の途中で時間切れになったという報告がある。
   *
   * @param {any} clientId 指名した相手
   * @param {number} [timeoutMs] 待つ時間
   * @returns {Promise<any>} 届いた投稿。時間切れなら null
   */
  _waitForGrantedText(clientId, timeoutMs = 90000) {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        this._grantWaiters.delete(clientId);
        resolve(null);
      }, timeoutMs);
      this._grantWaiters.set(clientId, { resolve, timeout });
    });
  }

  /**
   * 次のターンを決め、話す内容まで先に作っておく。
   *
   * ATTENTION: 「決める→喋る」を毎回順番にやらないこと。判断と原稿づくりで2往復ぶんの待ち
   * 時間がそのまま無音になり、会話として聞けたものにならない。いまのターンを読み上げている
   * 間に、次のぶんをここで裏で作る。
   *
   * @param {any} themeInfo その回のテーマ
   * @param {any} panel 出演者
   * @param {any} speakerKeys 話せる人の鍵
   * @param {number} targetMs 目安の長さ
   * @param {number} capMs 上限の長さ
   * @param {any[]} [pendingEntries] まだ一覧に入っていない、いま流れている発言
   * @returns {Promise<any>} 次のターンの判断と原稿
   */
  async _prepareNextTurn(themeInfo, panel, speakerKeys, targetMs, capMs, pendingEntries = []) {
    const elapsedMs = Date.now() - this._sessionStartTime;
    const decision = await this._decideNextTurn(themeInfo, panel, elapsedMs, targetMs, capMs, pendingEntries);
    const prepared = { ...decision, preparedText: null, preparedLeadingPcms: null, transitionLeadingPcms: null };

    // つなぎの一言の冒頭も、出演者の原稿づくりと並行してここで音声まで作っておく
    // （原稿だけ先に作っても、読み始めるときに合成待ちの無音ができる）
    const transitionPcmPromise = decision.transition_line
      ? this._synthesizeLeadingPcms(decision.transition_line, 'live_caster')
      : Promise.resolve(null);

    if (decision.action === 'panelist_turn' && decision.target && this._activePanel[decision.target]) {
      prepared.preparedText = await this._generatePanelistText(decision.target, themeInfo, pendingEntries);
      prepared.preparedLeadingPcms = await this._synthesizeLeadingPcms(prepared.preparedText, decision.target);
    }

    prepared.transitionLeadingPcms = await transitionPcmPromise;
    return prepared;
  }

  /**
   * 先に用意しておいたターンを実際に流す。
   *
   * @param {any} prepared 用意しておいたターン
   * @param {any} speakerKeys 話せる人の鍵
   * @param {any} themeInfo その回のテーマ
   * @returns {Promise<void>}
   */
  async _executeTurn(prepared, speakerKeys, themeInfo) {
    // ATTENTION: 指名する回では、作られたつなぎの一言は流さないこと。この直後に決まった文面で
    // 呼びかけるため。指示だけでなくコード側でも二重に止める（分かっている名前を尋ねる、
    // 存在しない機能に言及するといった食い違った呼びかけが作られても放送に乗らないように）。
    if (prepared.transition_line && prepared.action !== 'grant_hand_raise') {
      await this.speakText(prepared.transition_line, 'live_caster', prepared.transitionLeadingPcms);
      this._transcript.push({ speaker: 'live_caster', text: prepared.transition_line, ts: Date.now() });
    }

    if (prepared.action === 'panelist_turn' && prepared.target && this._activePanel[prepared.target]) {
      if (prepared.preparedText) {
        await this._speakPanelistText(prepared.target, prepared.preparedText, prepared.preparedLeadingPcms);
      } else {
        // 先に作れていなければその場で作り直す（少しの無音は許してでも進行は止めない）
        await this._speakPanelistText(prepared.target, await this._generatePanelistText(prepared.target, themeInfo));
      }
    } else if (prepared.action === 'grant_hand_raise' && this._handRaiseQueue.length > 0) {
      const next = this._handRaiseQueue.shift();
      const listenerName = this._getListenerName();
    // ATTENTION: 指名の知らせは、司会が読み上げた後に送ること。画面の入力欄はこの知らせで
    // 開くため、先に送ると司会がまだ話している最中に送信できてしまう。
      const grantLine = `${listenerName}さんからのご意見もお伺いいたします、どうぞ。`;
      await this.speakText(grantLine, 'live_caster');
      this._transcript.push({ speaker: 'live_caster', text: grantLine, ts: Date.now() });
      this._broadcast({ event: 'HAND_RAISE_GRANTED', clientId: next.clientId });

      const text = await this._waitForGrantedText(next.clientId);
      if (!text) {
        const skipLine = 'すみません、少しお時間をいただいてもよろしいですか？また後ほどお伺いしますね。';
        await this.speakText(skipLine, 'live_caster');
        this._transcript.push({ speaker: 'live_caster', text: skipLine, ts: Date.now() });
        // ATTENTION: 時間切れも必ず知らせること。知らせないと入力欄が開いたまま固まり、
        // もう一度手を挙げられなくなる。
        this._broadcast({ event: 'HAND_RAISE_TIMEOUT', clientId: next.clientId });
      } else {
        // 司会がリスナーの発言を読んで紹介してから、出演者の誰かが実際に応える。
        // ATTENTION: 発言をかぎ括弧で囲まないこと。句点で終わると閉じ括弧だけが1つの
        // かたまりとして切り出され、読み上げの合成がその断片を受け付けずに失敗する。
        const introLine = `${listenerName}さんから、こんなご意見をいただきました。${text}`;
        await this.speakText(introLine, 'live_caster');
        this._transcript.push({ speaker: 'live_caster', text: introLine, ts: Date.now() });
        const reactKey = speakerKeys[Math.floor(Math.random() * speakerKeys.length)];
        const reply = await this._generatePanelistText(reactKey, themeInfo, [], text);
        await this._speakPanelistText(reactKey, reply);
      }
    } else {
      // 話す相手が決まらなかった場合の代わりの選び方
      const fallbackKey = speakerKeys[Math.floor(Math.random() * speakerKeys.length)];
      await this._speakPanelistText(fallbackKey, await this._generatePanelistText(fallbackKey, themeInfo));
    }
  }

  /**
   * 討論の本体。司会が毎ターン次の行動を判断しながら進める。
   * いまのターンを流している間に次のターンを用意することで、ターンの間の無音を無くす。
   *
   * @param {any} themeInfo その回のテーマ
   * @param {any} panel 出演者
   * @param {any} [prefetchedFirstTurn] 既に用意してある最初のターン。無ければここで作る
   * @param {any} [token] 中断の印
   * @returns {Promise<void>}
   */
  async _runDiscussion(themeInfo, panel, prefetchedFirstTurn = null, token = null) {
    const config = this.getConfig();
    const targetMs = (config.program?.session_target_minutes || 25) * 60000;
    const capMs    = (config.program?.session_max_minutes    || 30) * 60000;
    const speakerKeys = panel.filter(p => p.poolKey !== 'live_caster').map(p => p.poolKey);
    if (speakerKeys.length === 0) return;

    const timerInterval = setInterval(() => {
      this._broadcast({ event: 'ROUND_TIMER', elapsedMs: Date.now() - this._sessionStartTime, targetMs, capMs });
    }, 15000);

    try {
      let pending = prefetchedFirstTurn
        ? (await prefetchedFirstTurn) || await this._prepareNextTurn(themeInfo, panel, speakerKeys, targetMs, capMs)
        : await this._prepareNextTurn(themeInfo, panel, speakerKeys, targetMs, capMs);
      while (true) {
        if (token?.aborted) break;
        const elapsedMs = Date.now() - this._sessionStartTime;
        if (elapsedMs >= capMs || pending.action === 'move_to_closing') break;

        const current = pending;
        // いまのターンを流している間に、次のターンの判断と原稿づくりを裏で進める。
        // ATTENTION: いま流れている内容はまだ一覧に入っていないので、明示的に渡すこと。
        const pendingEntries = this._pendingEntriesFor(current);
        const nextPromise = this._prepareNextTurn(themeInfo, panel, speakerKeys, targetMs, capMs, pendingEntries)
          .catch(e => { getLogger().warn('[TheAnswers] 次ターン先読み失敗: ' + e.message); return { action: 'move_to_closing', target: null, transition_line: '' }; });

        // ATTENTION: 「まとめに入る」と分かった時点で、締めの原稿づくりを裏で始めること。
        // いまのターンを読み終えてからゼロで始めると、その間が無音になる。
        nextPromise.then(result => {
          if (result?.action === 'move_to_closing' && !this._closingTextPrefetch) {
            this._closingTextPrefetch = this._generateClosingText(panel).catch(e => {
              getLogger().warn('[TheAnswers] クロージング先読み失敗: ' + e.message);
              return null;
            });
          }
        });

        await this._executeTurn(current, speakerKeys, themeInfo);

        pending = await nextPromise;
      }
    } finally {
      clearInterval(timerInterval);
    }
  }

  /**
   * 締めの原稿だけを作る（読み上げはしない）。出演者それぞれへの一言と、1つの結論に
   * まとめないサマリー。先に作っておけるよう、読み上げと分けてある。
   *
   * @param {any} panel 出演者
   * @returns {Promise<any>} 締めの原稿
   */
  async _generateClosingText(panel) {
    const config = this.getConfig();
    const casterProfile = this._activePanel['live_caster'];
    if (!casterProfile) return null;

    const panelNames = panel.filter(p => p.poolKey !== 'live_caster')
      .map(p => p.name).join('、');
    const recentContext = this._transcript.slice(-8).map(t => `${t.speaker}: ${t.text}`).join('\n');
    const systemPrompt = this._applyMaxChars(casterProfile.prompt, 'live_caster');
    // ATTENTION: 本人の名前を明示的に伝えること。人格の設定は自分の名前を書かない作りなので、
    // 渡さないと締めの挨拶の名前の部分に穴埋めの記号がそのまま出る。
    const userPrompt = `『The Answers』のクロージングです。あなたの名前は${casterProfile.name}です。
パネリスト（${panelNames}）それぞれに軽く触れながら、今日の議論を振り返ってください。
【重要】結論を一つに収束させないでください。「こんな多様な意見がありました。皆さんはどう考えるでしょうか？」のように、
複数の視点を並べて聴き手に問いかける形で締めくくってください。
${recentContext ? `【議論の流れ】\n${recentContext}\n` : ''}
最後に「お相手は私、メインMCの${casterProfile.name}でした」のように、実際の名前を使って締めの挨拶をしてください
（プレースホルダや仮名は絶対に使わないこと）。
⚠️【重要】この番組は曜日・時間帯が固定されていない、リスナーが好きなタイミングで開始できる番組です。
「また来週」「来週もお楽しみに」のような、存在しない定期放送スケジュールを絶対に口にしないでください。
❌NG例: 「お相手は私、メインMCの${casterProfile.name}でした。また来週！」（固定スケジュールの創作）
✅OK例: 「お相手は私、メインMCの${casterProfile.name}でした。次回またこのチャンネルでお会いしましょう」
のように、次回の頻度・曜日に触れない締め方
4〜6文程度でまとめてください。
${this._noStageDirectionsNote()}`;

    let text = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'live_caster');
    if (text && !this._looksLikeJapanese(text)) {
      getLogger().warn(`[TheAnswers] クロージングの生成結果が日本語として不自然なため破棄: "${text.slice(0, 60)}"`);
      text = null;
    }
    return text;
  }

  /**
   * 締めを読み上げる。先に作ってあればそれを使う。
   *
   * @param {any} panel 出演者
   * @returns {Promise<void>}
   */
  async _generateClosing(panel) {
    this._broadcast({ event: 'CLOSING' });
    // 先に作り始めてあればそれを使う。無ければその場で作る
    const text = this._closingTextPrefetch
      ? await this._closingTextPrefetch
      : await this._generateClosingText(panel);
    this._closingTextPrefetch = null;
    if (text) {
      await this.speakText(text, 'live_caster');
      this._transcript.push({ speaker: 'live_caster', text, ts: Date.now() });
    }
  }

  /**
   * 1回分を終える。エンディングの曲を鳴らし、記録を保存し、状態を戻して終了を知らせる。
   *
   * @param {any} themeInfo その回のテーマ
   * @param {any} panel 出演者
   * @returns {Promise<void>}
   */
  async _endEpisode(themeInfo, panel) {
    // ATTENTION: 背景の曲を落とす間は音量を固定すること。固定しないと自動の音量調整が
    // 基準へ引き戻そうとして、落とす処理と綱引きになる。
    this.mixer._volumeLocked = true;
    await this.mixer.fadeBgmTo(0, 1000);
    this.mixer.stopBgm();

    const endingDir = THE_ANSWERS_BGM_ENDING_DIR;
    const hasEnding = fs.existsSync(endingDir) && fs.readdirSync(endingDir).some(f => f.endsWith('.mp3'));
    if (hasEnding) {
      // 15秒ほどでエンディングの曲を流し切る。音量の固定は曲の側が終了時に解く
      await this.mixer.playJingle(endingDir, { fadeInMs: 1500, playDurationMs: 15000, fadeOutMs: 3000, restoreBgm: false });
    } else {
      // ATTENTION: 曲を鳴らさない場合は、上で固定した音量を自分で解くこと。解かないと
      // 次の回から自動の音量調整が効かないままになる。
      this.mixer._volumeLocked = false;
    }

    const panelKeys = panel.filter(p => !p.always_include).map(p => p.poolKey);
    // エンディングの曲が鳴り終わるまで録音を続けてから止める（全体を1本に残すため）
    const transcriptSnapshot = this._transcript.slice();
    const recordingResult = await this._finalizeArchiveRecording();
    this._saveArchiveEntry(themeInfo.theme, panelKeys, false, recordingResult, transcriptSnapshot);

    this._resetEpisodeState();
    this._broadcast({ event: 'SHOW_ENDED' });
    getLogger().info('[TheAnswers] エピソード終了');
  }

  // 一次の足切りに使う語
  static NG_WORDS = ['死ね', 'ばか', 'アホ', 'クズ', '殺す', 'キモい', 'ゴミ'];

  /**
   * 放送に乗せてよい内容かを確かめる。踏み込んだ議題を扱ううえ、議題も発言も自由に書けるため、
   * 必ず通す。
   *
   * 2段構え。まず決まった語での足切り、次に文脈の判定（個人への攻撃・中傷・煽りだけを見つけ、
   * テーマそのものへの踏み込んだ意見は歓迎する）。
   * ATTENTION: 判定に失敗したときは安全側（拒否）に倒すこと。
   *
   * @param {string} text 確かめる文章
   * @returns {Promise<any>} 通してよいかと、理由
   */
  async _moderateText(text) {
    const hit = TheAnswersAgentSystem.NG_WORDS.find(w => text.includes(w));
    if (hit) return { allowed: false, reason: `NGワード検出: ${hit}` };

    const config = this.getConfig();
    const systemPrompt = `あなたはディスカッション番組『The Answers』のコンテンツモデレーターです。
番組は「答えは一つじゃない」をテーマに、熊の駆除・離婚・戦争のような踏み込んだ社会問題を扱う、本音で話す番組です。
そのため、テーマ自体への強い意見・踏み込んだ主張・賛否が分かれる立場表明は歓迎され、ブロックしてはいけません。
一方で、以下は検知してブロックしてください:
- 特定の個人・団体への誹謗中傷・攻撃
- 差別的な発言
- 暴力・違法行為の扇動
- 過度に扇動的・攻撃的な政治的言い回し（意見の表明自体はOK。攻撃的な物言いがNG）`;
    const userPrompt = `次のテキストは番組に投稿された議題またはリスナーの発言です。上記の基準で放送してよいか判定してください。

テキスト: 「${text}」

有効なJSONのみ出力（マークダウン不要）:
{ "allowed": true または false, "reason": "判定理由（1文）" }`;

    try {
      const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', 'moderation');
      const match = raw && raw.match(/\{[\s\S]*\}/);
      if (!match) return { allowed: false, reason: 'モデレーション判定に失敗したため安全側でリジェクト' };
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.allowed !== 'boolean') return { allowed: false, reason: 'モデレーション応答が不正なため安全側でリジェクト' };
      return { allowed: parsed.allowed, reason: parsed.reason || '' };
    } catch (e) {
      getLogger().warn('[TheAnswers] モデレーション判定エラー（安全側でリジェクト）: ' + e.message);
      return { allowed: false, reason: 'モデレーション判定エラー' };
    }
  }

  /**
   * リスナーが手を挙げたことを受け付ける。
   *
   * @param {any} clientId 手を挙げた相手
   * @returns {void}
   */
  raiseHand(clientId) {
    if (this._handRaiseQueue.some(h => h.clientId === clientId)) return; // 二重挙手防止
    this._handRaiseQueue.push({ clientId, ts: Date.now() });
    this._broadcast({ event: 'HAND_RAISE_ACK', clientId, position: this._handRaiseQueue.length });
  }

  /**
   * 指名されたリスナーの投稿を受け取る。
   *
   * @param {any} clientId 送ってきた相手
   * @param {string} rawText 投稿の本文
   * @returns {Promise<void>}
   */
  async submitUserText(clientId, rawText) {
    const text = (rawText || '').trim();
    if (!text) return;
    // ATTENTION: 手を挙げて指名される前の投稿は受け付けないこと。番組の決まりをサーバー側でも守る
    const waiter = this._grantWaiters.get(clientId);
    if (!waiter) {
      this._broadcast({ event: 'SUBMIT_REJECTED_NOT_GRANTED', clientId, reason: '発言権がありません。挙手をしてお待ちください。' });
      return;
    }
    const mod = await this._moderateText(text);
    if (!mod.allowed) {
      this._broadcast({ event: 'MODERATION_REJECTED', clientId, reason: 'その内容は番組では紹介できません。表現を変えて試してみてください。' });
      getLogger().warn(`[TheAnswers] モデレーション却下: ${mod.reason}`);
      return;
    }
    // 確かめている間に指名の待ちが時間切れになっている可能性があるため、もう一度確かめる
    if (!this._grantWaiters.has(clientId)) {
      this._broadcast({ event: 'SUBMIT_REJECTED_NOT_GRANTED', clientId, reason: '発言権の受付時間が終了しました。' });
      return;
    }
    this._transcript.push({ speaker: 'user', text, ts: Date.now() });
    this._broadcast({ event: 'USER_SPEAKING', clientId, text });
    clearTimeout(waiter.timeout);
    this._grantWaiters.delete(clientId);
    waiter.resolve(text);
  }
}

module.exports = TheAnswersAgentSystem;
