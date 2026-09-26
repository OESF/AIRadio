/**
 * @file Live のディレクターが、コーナーの編成を決めてコーナーの順番（キュー）を組み立てる処理
 *
 * Live のディレクター（config.agents.director）に、次の放送サイクルの編成の方針（どのゲストを呼ぶか・
 * ワールドレポートと法律相談を入れるか・音楽コーナーの頻度・ニュースを優先するか・大きな話題・討論コーナーの
 * 出演者）を LLM で判断させ、その方針からコーナーのキューを組み立てる。
 *
 * 方針を決めるのはディレクターだが、守るべき決まり（基本のコーナーを1回ずつ・同じコーナーを続けない・
 * 音楽コーナーを続けない）と、カレンダーや気象の事実（市場の休み・その日の最初のサイクル・気象の緊急情報）は
 * 常にコードが守る。コーナーの並びそのものは LLM に作らせない（決まりを破ったり、存在しない名前を
 * 作ったりするため）。
 *
 * agent-system.js が Object.assign(AgentSystem.prototype, directorDecisionMethods) で取り込むので、
 * 中のメソッドは AgentSystem の this（_cornerQueue・_recentCorners・pending〜Request・weatherService・
 * newsService・holidayService・marketCalendar・getConfig・_callGeminiRaw・_writeDiaryReflection など）を使う。
 *
 * ATTENTION: _selectNextCorner と _refillCornerQueue は番組の進行の途中から同期で呼ばれるので、LLM を待っては
 * いけない。ディレクターの判断は1つ前のサイクルのときに裏で先読みしておき（_prefetchNextDirectorDecision）、
 * 無ければすぐに代わりの方針（_getFallbackDirectorDecision）を使う。
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

const { getLogger } = require('../logger');

// ゲストの論客3人（芸人・医師・マーケター）。自分のコーナーを持つ
const GUEST_ANALYST_KEYS = ['comedian', 'doctor', 'marketer'];
// 討論コーナー（ニュースディープダイブ）にディレクターが選べる出演者。司会（caster）は
// 討論の仕組み（lib/agent-discussion-corner.js）が必ず付けるので含めない。
// ATTENTION: ここを増やしたら、_requestDirectorCycleDecision のプロンプトの deep_dive_cast の
// 選択肢にも必ず足すこと。書かないと、受け付けるのに一度も選ばれない状態になる。
const VALID_DEEP_DIVE_CAST = ['assistant', 'news', 'commentator', 'journalist', 'legal_advisor', ...GUEST_ANALYST_KEYS];

/**
 * 配列を偏りなく並べ替えた新しい配列を返す（Fisher–Yates）。元の配列は変えない。
 *
 * BUGFIX: sort に乱数の比較関数を渡す混ぜ方は偏る（結果が並べ替えの内部の動きに左右される）。
 * ゲストの候補を5人にしたとき、選ばれる割合が人によって大きく違っていた。
 *
 * @param {Array<any>} list 元の配列
 * @returns {Array<any>} 並べ替えた配列
 */
function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 気象の緊急情報（住んでいる所に実際に影響する台風・警報・地震・津波と、全国の特別警報）があるか。
 *
 * BUGFIX: 「データがあるか」ではなく「住んでいる所に影響があるか」で判定する。データの有無で見ていたころ、
 * 遠くの台風や離島の注意報・小さな地震でも天気コーナーが最優先になっていた。他の県の特別警報は
 * 命に関わるので含める。
 * BUGFIX: 判定は _refillCornerQueue と _requestDirectorCycleDecision の両方がこの関数を使う。片方の
 * ローカル変数をもう片方から参照していたころ、先読みが毎回 ReferenceError で失敗し（例外は握りつぶされて
 * 見えなかった）、ディレクターの判断が一度も使われていなかった。
 *
 * @param {any} weatherStructured weatherService.cache.structured
 * @returns {boolean} 緊急情報があれば true
 */
function detectWeatherEmergency(weatherStructured) {
  return !!(
    weatherStructured?.typhoonImpact === 'direct' || weatherStructured?.typhoonImpact === 'near'
    || weatherStructured?.warningAffectsListener
    || (weatherStructured?.quakeMaxIntensity ?? 0) >= 4
    || weatherStructured?.quakeTsunamiLevel
    || weatherStructured?.hasNationalAlert);
}

// 秘書のループが見つけた変化（メール・カレンダー・天気・ニュース・金融）を、Live のディレクターの判断の
// 材料にする。今は Live だけが読むので、全チャンネル共通の agent-shared-mixin.js ではなくここで読み込む
const { getRecentLiveSignals } = require('./secretary-loop');
const listenerContext = require('./listener-context');
const topical = require('./topical-materials');
const directorBoard = require('./director-board');
// The Answers で設定されている各出演者の「個人的な一面」も、編成の判断の参考にする（hidden-talent-profiles.js）
const { getHiddenTalentsByLiveAgentKey } = require('./hidden-talent-profiles');

/** AgentSystem に取り込む、ディレクターの編成の判断のメソッド。 */
const directorDecisionMethods = {
  /**
   * 次に流すコーナーを返す。キューが空なら、新しいサイクルのキューを組み立てる。
   * ATTENTION: 同期で即座に返すこと（番組の進行の途中から呼ばれる。ファイルの冒頭参照）。
   * @param {boolean} isBirthday リスナーの誕生日か（半分の確率で音楽にする）
   * @returns {string} コーナーのキー
   */
  _selectNextCorner(isBirthday) {
    if (isBirthday && Math.random() > 0.5) return 'music';

    if (this._cornerQueue.length === 0) {
      this._refillCornerQueue();
    }
    const next = this._cornerQueue.shift();
    getLogger().debug(`[Corner] キューから取得: ${next}（残り ${this._cornerQueue.length} 件）`);
    return next;
  },

  /**
   * 新しいサイクルのコーナーのキューを組み立てる。
   *
   * 方針は、先読みしておいたディレクターの判断を使い、無ければ代わりの方針を使う。市場の休み・その日の
   * 最初のサイクル・気象の緊急情報は、方針を先読みした時点ではなく今の値を使う（先読みは日付をまたぐと
   * 古くなる）。組み立てたら、ディレクターの掲示板への共有・キューの保存・大きな話題のゲストへの割り振り・
   * 次のサイクルの判断の先読みまで行う。
   *
   * ATTENTION: LLM を待たないこと（同期で呼ばれる。ファイルの冒頭参照）。
   * @returns {void}
   */
  _refillCornerQueue() {
    const decision = this._prefetchedDirectorDecision || this._getFallbackDirectorDecision();
    this._prefetchedDirectorDecision = null;
    // セッションの終わりのディレクターの日記（_writeDirectorSessionSummaryDiary）の材料として、
    // 実際に使った方針を覚えておく（LLM の判断でも代わりの方針でも）
    this._lastAppliedDirectorDecision = decision;
    // ディレクター同士の掲示板に、この回の方針を共有する（LLM で判断したときだけ。代わりの方針には
    // 方針と呼べる中身が無いので書かない）
    if (decision.fromDirector) {
      try {
        const _cfg = this.getConfig();
        const _nm = (k) => _cfg.agents?.[k]?.name || k;
        const _guests = [...(decision.guests || []).map(_nm),
          ...(decision.includeLegalAdvisor ? [_nm('legal_advisor')] : []),
          ...(decision.includeWorldReport ? [_nm('world_report')] : [])];
        directorBoard.post({
          directorKey: 'director',
          directorName: _cfg.agents?.director?.name || '',
          programName: _cfg.program?.name || '',
          title: decision.bigTopic ? `本日の大きな話題「${decision.bigTopic}」` : '通常編成',
          detail: [_guests.length ? `ゲスト: ${_guests.join('・')}` : '', decision.prioritizeNews ? 'ニュース優先' : '',
            decision.reasoning || ''].filter(Boolean).join(' ／ '),
        });
      } catch (e) {
        getLogger().debug(`[DirectorBoard] Live: 書き込みに失敗（無視）: ${e.message}`);
      }
    }

    // 市場の休み・その日の最初のサイクルかは、今の値をここで求める（先読みした方針は日付をまたぐと古い）。
    // カレンダーの事実なので LLM に判断させず、方針がどちらでも常にコードで決める
    const now = new Date();
    // BUGFIX: 金融コーナーを必須から外すのは、東京と米国の市場がどちらも休みのときだけ。日本の週末・祝日
    // だけで判断していたころ、米国が開いている日にも外し、米国だけが休みの日は見逃していた
    const _mkt = this.marketCalendar.getAllMarketStatuses(now);
    const isMarketClosed = !_mkt.tokyo.tradesOnJapanDate && !_mkt.us.tradesOnJapanDate;
    const showDay = this._getShowDay();
    const isFirstCycleOfDay = showDay !== this._lastDirectorPlanShowDay;
    this._lastDirectorPlanShowDay = showDay;

    // 気象の緊急情報は、天気コーナーと同じデータ（weatherService）から判定する。事実なので LLM に判断させない
    const weatherStructured = this.weatherService.cache.structured;
    const weatherEmergency = detectWeatherEmergency(weatherStructured);

    this._cornerQueue = this._buildCornerQueueFromDirectorDecision(decision, { isMarketClosed, isFirstCycleOfDay, weatherEmergency });
    getLogger().info(`[Director] 新サイクル計画（${this._cornerQueue.length}コーナー・${decision.fromDirector ? 'ディレクタ判断' : 'フォールバック'}${isFirstCycleOfDay ? '・本日初回' : ''}${isMarketClosed ? '・両市場とも休場' : (!_mkt.tokyo.tradesOnJapanDate ? '・東京のみ休場' : (!_mkt.us.tradesOnJapanDate ? '・米国のみ休場' : ''))}${weatherEmergency ? '・気象緊急情報あり' : ''}${decision.prioritizeNews ? '・ニュース優先' : ''}${decision.bigTopic ? `・話題「${decision.bigTopic}」` : ''}）: ${this._cornerQueue.join(' → ')}`);
    this._broadcastQueueUpdate();
    // 組み立てたキューを保存し、同じ日のうちは次の接続や再起動の後も続きから始める
    // （agent-system.js の _saveCornerQueueState）
    this._saveCornerQueueState();

    // 大きな話題があれば、このサイクルに出るゲスト（コメンテーター・ジャーナリスト・弁護士）にその話題を振る。
    // リスナーの話題のリクエストの仕組み（pending〜Request）を使う。
    // ATTENTION: source: 'director' を付けること。無いとコーナーのプロンプトが「リスナーからのリクエスト」と
    // 言ってしまう（_buildCommentatorCornerContext などが見ている）。本物のリスナーのリクエストが入っていたら
    // 上書きしない（人が頼んだものを優先する）
    if (decision.bigTopic) {
      const topicReq = { rawText: decision.bigTopic, topic: decision.bigTopic, source: 'director' };
      if (!this.pendingCommentatorRequest && decision.guests.includes('commentator')) {
        this.pendingCommentatorRequest = topicReq;
      }
      if (!this.pendingJournalistRequest && decision.guests.includes('journalist')) {
        this.pendingJournalistRequest = topicReq;
      }
      if (!this.pendingLegalAdvisorRequest && decision.includeLegalAdvisor) {
        this.pendingLegalAdvisorRequest = topicReq;
      }
    }

    // 祝日のデータを新しく保つ（期限内なら何もせずに返るので、毎回呼んでも軽い）
    this.holidayService.refresh().catch(() => {});

    // 次のサイクルの判断を裏で先読みする（このサイクルは数十分以上かかるので、数秒の LLM の呼び出しは十分に間に合う）
    this._prefetchNextDirectorDecision();
  },

  /**
   * 編成の方針から、実際のコーナーのキューを組み立てる。
   *
   * 基本のコーナーを混ぜる・音楽コーナーを挟む・直前と同じコーナーを先頭にしない・優先するコーナーを先頭へ、
   * はコードが決める。方針（decision）が左右するのはゲスト・ワールドレポート・法律相談・音楽の頻度・
   * ニュースの優先だけ。
   * ATTENTION: 並べ替えは必ず shuffled() を使うこと。sort に乱数の比較関数を渡す混ぜ方は偏る
   * （shuffled の BUGFIX 参照）。
   *
   * @param {Record<string, any>} decision 編成の方針
   * @param {{isMarketClosed?: boolean, isFirstCycleOfDay?: boolean, weatherEmergency?: boolean}} [facts]
   *   東京と米国の市場がどちらも休みか・その日の最初のサイクルか・気象の緊急情報があるか
   * @returns {string[]} コーナーのキーの並び
   */
  _buildCornerQueueFromDirectorDecision(decision, { isMarketClosed = false, isFirstCycleOfDay = false, weatherEmergency = false } = {}) {
    // ① 必須のコーナー（1サイクルに1回ずつ）。金融は市場が休みの日にはほとんど要らないので、市場が開く日だけ必須
    const requiredBase = isMarketClosed ? ['news', 'weather', 'traffic'] : ['news', 'weather', 'traffic', 'finance'];
    const required = shuffled(requiredBase);

    // ② ゲスト・ワールドレポート・法律相談は方針に従う
    const guests = decision.guests;
    const worldReport = decision.includeWorldReport ? ['world_report'] : [];
    const legalAdvisor = decision.includeLegalAdvisor ? ['legal_advisor'] : [];

    // ③ 生活アドバイスは毎回1回（政治や経済に偏らないよう、生活の情報で釣り合いを取る）
    const lifeAdvisor = ['life_advisor'];

    // ④ 全部のコーナーを混ぜる
    const allCorners = shuffled([...required, ...guests, ...worldReport, ...lifeAdvisor, ...legalAdvisor]);

    // ⑤ コーナーの間に音楽コーナーを確率で挟む（確率は方針の頻度で決まる）
    const freqBands = {
      low:    { mid: 0.35, tail: 0.40 },
      medium: { mid: 0.65, tail: 0.70 }, // 既定
      high:   { mid: 0.85, tail: 0.90 },
    };
    const { mid, tail } = freqBands[decision.musicDjFrequency] || freqBands.medium;
    const queue = [];
    for (const corner of allCorners) {
      // 音楽コーナーを続けない
      if (queue.length > 0 && queue[queue.length - 1] !== 'music_dj' && Math.random() < mid) {
        queue.push('music_dj');
      }
      queue.push(corner);
    }
    // 最後が音楽コーナーでなければ、確率で足す
    if (queue[queue.length - 1] !== 'music_dj' && Math.random() < tail) {
      queue.push('music_dj');
    }

    // ⑥ 先頭のコーナーが直前に流したもの（_recentCorners、無ければ _lastCorner）と同じなら後ろに回す
    // （サイクルをまたいで同じコーナーが続かないように）。音楽コーナーは多いので対象外
    const _recentNonDj = (this._recentCorners.length > 0
      ? this._recentCorners
      : (this._lastCorner ? [this._lastCorner] : [])
    ).filter(c => c !== 'music_dj');
    let _safetyCount = 0;
    while (queue.length > 1 && _recentNonDj.includes(queue[0]) && _safetyCount++ < queue.length) {
      queue.push(queue.shift());
    }

    // ⑦ 優先するコーナーを先頭へ寄せる（⑥より優先。その日の最初や緊急時には「直前と同じ」は気にしなくてよい）。
    //    配列には優先度の低いものから積み、最後に寄せたものが先頭に来る:
    //      ニュース: その日の最初のサイクル、またはディレクターが大きな出来事があると判断したとき
    //      天気（最優先）: 気象の緊急情報があるとき
    const priorityCorners = [];
    if (isFirstCycleOfDay || decision.prioritizeNews) priorityCorners.push('news');
    if (weatherEmergency) priorityCorners.push('weather');
    for (const cornerKey of priorityCorners) {
      const idx = queue.indexOf(cornerKey);
      if (idx > 0) {
        queue.splice(idx, 1);
        // BUGFIX: 抜いた所の前後が音楽コーナーどうしになったら、片方を消す（音楽コーナーが続かないように）
        if (queue[idx - 1] === 'music_dj' && queue[idx] === 'music_dj') {
          queue.splice(idx, 1);
        }
        queue.unshift(cornerKey);
      }
    }

    return queue;
  },

  /**
   * LLM を呼ばずにすぐ作れる、代わりの編成の方針（乱数で決める）。
   * @returns {Record<string, any>} 編成の方針（fromDirector は false）
   */
  _getFallbackDirectorDecision() {
    // ゲストは論客3人も含めた5人を平等に扱う（話題との相性は判断できないが、除くと判断に失敗した回に
    // 3人の出番が無くなる）
    const guestPool = shuffled(['commentator', 'journalist', ...GUEST_ANALYST_KEYS]);
    const guestCount = Math.random() < 0.10 ? 0 : Math.random() < 0.55 ? 1 : 2;
    return {
      guests: guestPool.slice(0, guestCount),
      includeWorldReport: Math.random() < 0.40,
      includeLegalAdvisor: Math.random() < 0.50,
      musicDjFrequency: 'medium',
      prioritizeNews: false, // 大きな出来事かどうかは LLM なしでは判断できない
      bigTopic: '', // 同じく、話題も取り出せない
      // 討論コーナーの出演者も選べないので空。討論の仕組み（agent-discussion-corner.js）が、このサイクルに
      // 出るゲストから組み立てる
      deepDiveCast: [],
      reasoning: '',
      fromDirector: false,
    };
  },

  /**
   * 次のサイクルの判断を裏で先読みしておく（待たない。失敗したら次は代わりの方針になる）。
   * @returns {void}
   */
  _prefetchNextDirectorDecision() {
    this._requestDirectorCycleDecision()
      .then(decision => { this._prefetchedDirectorDecision = decision; })
      .catch(e => { getLogger().debug(`[Director] サイクル方針の先読みに失敗（次回はフォールバック使用）: ${e.message}`); });
  },

  /**
   * ディレクターに、次のサイクルの編成の方針を JSON で判断させる。
   *
   * 材料は、曜日・時間帯・祝日・市場の開閉・直前のコーナー・気象の緊急情報・ニュースの見出し・各社の主張が
   * 割れている話題・専門分野の新しい動き・世の中の反応・ほかのディレクターの方針・秘書が見つけた変化・
   * 日記のふり返り・出演者の専門分野と個人的な一面・リスナーの今。コーナーの並び順や必須のコーナーは
   * 判断させない（コードが守る）。判断の理由は日記（'cycle_plan'）に書く。
   * 出力が使えなければ代わりの方針を返す。
   *
   * ATTENTION: プロンプトの中のほかの出演者の名前は、必ず config から取る（直書きしない。CLAUDE.md 参照）。
   * @returns {Promise<Record<string, any>>} 編成の方針
   */
  async _requestDirectorCycleDecision() {
    const config = this.getConfig();
    const directorCfg = config.agents?.director || {};
    const directorName = directorCfg.name || '森田正義（ディレクタ）';
    const _cmName2 = (config.agents?.commentator?.name)  || '高橋洋二教授';
    const _jnName2 = (config.agents?.journalist?.name)   || '謎のジャーナリストX';
    const _lgName2 = (config.agents?.legal_advisor?.name) || '北村昭雄';
    const _wrName2 = (config.agents?.world_report?.name)  || 'Steve';
    const _djName2 = (config.agents?.music_dj?.name)      || 'DJ サキ';
    // 討論コーナーの司会と、リスナーの目線で疑問を出す役・報道センター
    const _casterName2 = (config.agents?.caster?.name)    || 'MAX';
    const _asstName2   = (config.agents?.assistant?.name) || 'Clara';
    const _newsName2   = (config.agents?.news?.name)      || '報道センター';
    // ATTENTION: 討論の出演者の選択肢にもゲスト論客3人を含めること。検査側（VALID_DEEP_DIVE_CAST）は
    // 受け付けるので、ここに書かないと「受け付けるのに一度も選ばれない」状態になる。
    const _gaNames2 = GUEST_ANALYST_KEYS
      .map((k) => `"${k}"(${config.agents?.[k]?.name || k})`).join('、');
    const recentCorners = this._recentCorners.length > 0 ? this._recentCorners.join('、') : '（まだ無し）';
    const now = new Date();
    const hour = now.getHours();
    const dayNames = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
    const dayOfWeek = dayNames[now.getDay()];
    const isWeekend = [0, 6].includes(now.getDay());
    const holidayName = this.holidayService.getHolidayName(now);
    // 市場の開閉は東京と米国を別々に伝える
    const _mktForPrompt = this.marketCalendar.getAllMarketStatuses(now);
    const _mktNote = ['tokyo', 'us'].map((k) => {
      const st = _mktForPrompt[k];
      return `${st.label}は${st.tradesOnJapanDate ? '本日立会日' : `休場（${st.japanDateClosedName}）`}`;
    }).join('・');
    const calendarNote = (holidayName ? `（祝日「${holidayName}」・` : isWeekend ? '（週末・' : '（平日・')
      + `${_mktNote}）`;

    // 気象の緊急情報はコードが天気コーナーを優先するので、「判断しなくてよい」と伝えるだけにする
    // （二重に判断させて混乱させないため）
    const weatherStructured = this.weatherService.cache.structured;
    const weatherEmergency = detectWeatherEmergency(weatherStructured);
    const weatherEmergencyNote = weatherEmergency
      ? `\n【⚠️気象の緊急情報あり】${[weatherStructured.typhoonSummary, weatherStructured.warningSummary, weatherStructured.quakeSummary, weatherStructured.nationalAlertSummary].filter(Boolean).join(' / ')}（天気コーナーは自動的に優先されるため、これについて判断する必要はありません）`
      : '';

    // 世の中の動きの材料は、The Answers のディレクターと同じものを共通の組み立て（lib/topical-materials.js）
    // から渡す（ゲスト・大きな話題・ニュースの優先は、どれも今日の世の中で何が大きいかで決まるため）。
    // 裏で先読みされる判断なので、取り出しに数秒かかっても番組は止まらない。
    //
    // ① ニュースの見出し（総合・国内・国際・経済）
    const newsHeadlines = await topical.buildNewsHeadlinesText(this.newsService);
    // ② 各社の主張が割れている話題（報道センター・教授・討論コーナーと30分キャッシュを共有）
    const editorialSplit = await topical.buildEditorialSplitText({
      apiKey: this.getCredentials()?.gemini?.api_key,
      activitySessionId: this._activitySessionId,
      mediaCompareService: this.mediaCompareService,
      usageNote: '※ 同じ出来事について新聞各社の主張が実際に割れているものです。複数の専門家の視点で'
        + '深掘りする価値が高いので、big_topic の有力な候補です。',
    });
    // ③ 専門分野の最新の動き（教授・弁護士の調査はリスナー本人の情報にもとづくため含まない。
    //    森田はリスナー像で住む地域を既に知っているので、地域の項目は除かない）
    const specialistDigest = topical.buildSpecialistDigestText({
      usageNote: '※ ニュースの見出しには出てこない、各分野の新しい動きです。大きな発表や多くの人に関わる動きが'
        + 'あれば、その分野に詳しい出演者（出演者の専門分野を参照）をゲストに起用したり、big_topic にしたりする'
        + '判断材料にしてください。',
    });
    // ④ 世の中の反応（はてなブックマークの反応数・Googleトレンド）。記事に書き込まれた個人の声は、
    //    討論のテーマ選び向けの材料で長いため、編成の判断では含めない
    const trendingText = await topical.buildTrendingText(null, { includeVoices: false });
    // ⑤ ほかの番組のディレクターが最近決めた方針（lib/director-board.js）
    const otherDirectors = directorBoard.formatOthersForDirector('director', {
      usageNote: '※ 局全体で話題や空気が重なりすぎないようにする参考です。The Answers が議論しているテーマに'
        + '関係する出来事があれば、Liveでも専門家の視点を添える判断材料にしてかまいません。',
    });

    // ⑥ 秘書のループ（secretary-loop.js）が見つけた変化。ニュースとは別の、リスナー個人にとって意味のある
    // 変化（持っている銘柄の大きな動きなど）を含む。prioritize_news と big_topic の判断の材料にさせる
    const secretaryLoopSignals = getRecentLiveSignals() || '（特になし）';

    // ⑦ リスナーの今（リスナー像・予定・最近見た動画の題名・リクエストの履歴）。人選と編成の手がかり。
    // 何を渡してよいかと出典の管理は lib/listener-context.js
    const listenerNow = listenerContext.formatListenerNowForDirector('director', { channel: 'live' });

    // ⑧ 出演者の専門分野。大きな話題を、分野の合う出演者へつなげるための手がかり。
    // ATTENTION: 「経済ならコメンテーター」のような対応をコードに直書きしない。管理画面で人物の設定（prompt）を
    // 変えると嘘になる。各出演者の prompt の先頭（人物像と専門分野が書いてある）を120文字渡し、対応づけは
    // ディレクターに判断させる。The Answers の「個人的な一面」（趣味など）も添え、専門分野だけでは
    // つながらない起用もできるようにする
    const _hiddenTalents = getHiddenTalentsByLiveAgentKey();
    const _guestProfile = (key, fallbackName) => {
      const a = config.agents?.[key] || {};
      const name = a.name || fallbackName;
      const gist = (a.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const talent = _hiddenTalents[key];
      const talentNote = talent ? `\n    （個人的な一面: ${talent}）` : '';
      return (gist ? `- ${name}: ${gist}…` : `- ${name}`) + talentNote;
    };
    const guestProfiles = [
      _guestProfile('commentator', _cmName2),
      _guestProfile('journalist', _jnName2),
      _guestProfile('legal_advisor', _lgName2),
      ...GUEST_ANALYST_KEYS.map((k) => _guestProfile(k, k)),
    ].join('\n');

    // ⑨ 日記のふり返り（週1回、agent-diary-feedback.js が作る）。ディレクター自身の判断の癖と、出演者全員の
    // 日記から見えた編成の気づき。まだ無ければ空文字
    const diaryFeedback = this._getAgentDiarySelfDigest('director') + this._getAgentDiaryTeamDigest('director');

    const prompt = `${directorCfg.prompt || `あなたは「${directorName}」、ラジオ番組のディレクタです。`}

次の放送サイクル（20分程度。天気・交通・ニュース、生活アドバイスは必ず1回ずつ含まれます）の
編成方針を決めてください。

【現在】${dayOfWeek}・${hour}時台${calendarNote}
【直近に扱ったコーナー】${recentCorners}${weatherEmergencyNote}
【直近のニュース見出し】
${newsHeadlines}${editorialSplit}${specialistDigest}${otherDirectors}${trendingText ? `${trendingText}\n※ 反応の数は、多くの人が実際に関心を持った度合いの手がかりです（事実の裏付けではありません）。\n` : ''}
【秘書が検知した最近の変化】（ニュース見出しとは別に、My Secretaryが普段の監視の中で
検知した変化点です。リスナー個人にとって意味のある内容が含まれることがあります。
大きな意味がありそうならprioritize_newsやbig_topicの判断に反映してください）
${secretaryLoopSignals}
${diaryFeedback}

この時間帯・曜日・祝日らしい編成を、あなた自身の裁量で判断してください
（例: 週末や祝日はリスナーがゆったり過ごしていることが多い、深夜は落ち着いた選曲が合う、など）。
上記のニュース見出しの中に、速報級・多くのリスナーが気になっているであろう大きな出来事が
あれば、ニュースコーナーを優先すべきと判断してください（無ければ無理に優先しなくて構いません。
これは「私だけのAI Radio」として、リスナーが本当に関心を持ちそうな情報を届けるための判断です）。

【出演者の専門分野】
${guestProfiles}
${listenerNow}
大きな話題がある場合は、ニュースコーナーだけで終わらせず、上記の出演者にもその話題を振って、
それぞれの専門的な視点から深掘りする展開を積極的に検討してください（guest_count・guests・
include_legal_advisor で該当ゲストを起用したうえで、big_topic にその話題を書けば、各ゲストの
コーナーで自動的にその話題が中心テーマとして扱われます）。

【最重要・ゲスト選びの考え方】ゲストは「今日は誰を出すか」と切り離して選ぶのではなく、
**その話題を掘り下げるのに最もふさわしい専門分野は誰か**という観点で選んでください。
上記の専門分野の説明と、話題の性質を突き合わせて判断します。例えば、法廷・裁判・事件・
契約など法律が絡む話題なら法律の専門家を、株価・為替・景気・企業業績など経済や金融が
絡む話題ならその分野に強い出演者を、報道の裏側や独自の視点が活きる話題ならそれが得意な
出演者を起用する、といった具合です（これはあくまで考え方の例であり、実際の対応づけは
上記の専門分野の説明を読んで、あなた自身が判断してください）。
専門分野だけでなく、括弧書きの「個人的な一面」と話題が重なる場合も起用の良い理由になります
（その出演者ならではの熱のこもった語りが期待できるため）。ただしこれは編成を考えるうえでの
参考であって、番組で私生活を語らせることが目的ではありません。
こうしてニュースとその後のコーナーが繋がることで、番組全体が一本の流れになります。
無理に全員へ振る必要はありません。話題に合う専門家が1人だけならその1人で構いませんし、
そもそも大きな話題が無ければ、いつも通り時間帯・曜日に合わせた編成で構いません。

以下のJSON形式のみで出力してください（マークダウン不要・説明文不要）:
{
  "guest_count": 0〜2の整数（自分のコーナーを持つゲストの起用人数の合計）,
  "guests": ["commentator", "journalist", "comedian", "doctor", "marketer"] のうち guest_count 件
（順不同・重複無し。後ろの3人は毎回出す必要はなく、**その話題にその人ならではの見方があるときだけ**
起用してください。上の【出演者の専門分野】を読んで、話題との相性で判断します）,
  "include_world_report": true または false（${_wrName2}のワールドレポートを入れるか）,
  "include_legal_advisor": true または false（${_lgName2}の法律相談を入れるか）,
  "music_dj_frequency": "low", "medium", "high" のいずれか（${_djName2}の音楽コーナーをどれくらいの頻度で挟むか）,
  "prioritize_news": true または false（見出しに大きな出来事があり、ニュースを優先すべきか）,
  "big_topic": "多くのリスナーが関心を持ちそうな大きな話題があれば、その要約を10文字程度で
（例:「〇〇地震の被害状況」「日銀の追加利上げ」）。無ければ空文字",
  "deep_dive_cast": ["commentator"(${_cmName2}), "journalist"(${_jnName2}), "legal_advisor"(${_lgName2}),
${_gaNames2}、"assistant"(${_asstName2}), "news"(${_newsName2}) のキー名] から0〜3名
（ニュースコーナーの直後に行う討論コーナー「ニュースディープダイブ」に誰を出すか。
表面的な報道の裏にある背景や意味まで踏み込み、出演者どうしが意見をぶつけ合う枠です。
司会は${_casterName2}が務めるので選ぶ必要はありません。

**議論の中心は${_cmName2}・${_jnName2}・${_lgName2}の3人です。この中から、
話題に応じて必ず2人を選んでください**（見方が割れるように、専門の違う2人が望ましい）。

自分のコーナーを持つゲスト（${_gaNames2}）も、**その話題にその人ならではの見方があるときだけ**
議論に加えてかまいません（上の【出演者の専門分野】を読んで、話題との相性で判断します）。
毎回出す必要はありません。

${_newsName2}は報道機関であり、ニュースを正確に伝えるのが役割です。**議論の参加者では
ありません**。この枠に入れた場合は、意見を述べるのではなく、確認の取れている事実と
まだ憶測にすぎない点を示して議論の土台を作る役に回ります。事実関係が込み入っていて
土台を固める必要がある回だけ加えてください。

${_asstName2}はリスナー目線の素朴な疑問役です。加えるかどうかは判断に委ねます。無ければ空配列）,
  "reasoning": "この編成にした理由を1〜2文で（あなた自身の裁量で決めた理由）"
}`;

    const raw = await this._callGeminiRaw(prompt, 'light');
    const match = raw && raw.match(/\{[\s\S]*\}/);
    if (!match) return this._getFallbackDirectorDecision();

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      getLogger().warn(`[Director] サイクル方針のJSONパース失敗: ${e.message}`);
      return this._getFallbackDirectorDecision();
    }

    const decision = this._validateDirectorDecision(parsed);
    if (!decision) return this._getFallbackDirectorDecision();

    if (decision.reasoning) {
      this._writeDiaryReflection('director', directorName, decision.reasoning, 'cycle_plan', 'plan').catch(() => {});
    }
    return decision;
  },

  /**
   * ディレクターの JSON の出力を確かめ、編成の方針の形に整える。
   *
   * ゲストの数と一覧が合わなければ、足りない分は混ぜた候補から埋め、多すぎれば削る。知らない値は既定値にする。
   *
   * @param {Record<string, any>} parsed 解析した JSON
   * @returns {Record<string, any>|null} 編成の方針（fromDirector は true）。guest_count が使えなければ null
   */
  _validateDirectorDecision(parsed) {
    const validGuests = ['commentator', 'journalist', ...GUEST_ANALYST_KEYS];
    const guestCount = Number.isInteger(parsed.guest_count) ? Math.max(0, Math.min(2, parsed.guest_count)) : null;
    if (guestCount === null) return null;

    let guests = Array.isArray(parsed.guests) ? [...new Set(parsed.guests.filter(g => validGuests.includes(g)))] : [];
    if (guests.length < guestCount) {
      // 足りない分を埋める。定義の順のままだといつも先頭の2人になるので、混ぜてから埋める（全員を平等に）
      for (const g of shuffled(validGuests)) {
        if (guests.length >= guestCount) break;
        if (!guests.includes(g)) guests.push(g);
      }
    } else if (guests.length > guestCount) {
      guests = guests.slice(0, guestCount);
    }

    const validFreq = ['low', 'medium', 'high'];
    return {
      guests,
      includeWorldReport:  typeof parsed.include_world_report  === 'boolean' ? parsed.include_world_report  : Math.random() < 0.40,
      includeLegalAdvisor: typeof parsed.include_legal_advisor === 'boolean' ? parsed.include_legal_advisor : Math.random() < 0.50,
      musicDjFrequency: validFreq.includes(parsed.music_dj_frequency) ? parsed.music_dj_frequency : 'medium',
      prioritizeNews: typeof parsed.prioritize_news === 'boolean' ? parsed.prioritize_news : false,
      bigTopic: typeof parsed.big_topic === 'string' ? parsed.big_topic.trim().slice(0, 100) : '',
      // 討論コーナーの出演者（ディレクターが決める）。司会は討論の仕組みが付けるので含めない。
      // 使えなければ空にし、討論の仕組みがこのサイクルのゲストから組み立てる
      deepDiveCast: Array.isArray(parsed.deep_dive_cast)
        ? [...new Set(parsed.deep_dive_cast.filter(a => VALID_DEEP_DIVE_CAST.includes(a)))].slice(0, 3)
        : [],
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : '',
      fromDirector: true,
    };
  },

  /**
   * セッションの終わりに、ディレクターの日記（実際に流れたコーナーと使った方針のふり返り）を書く。
   *
   * 判断の理由の日記（'cycle_plan'）は LLM の判断が成功したときだけで、サイクルの補充も数時間に1回なので、
   * 一度も書かれないセッションがある。ディレクターは毎セッション編成をしているので、キャスター・アシスタントと
   * 同じく、セッションの終わり（runEndingSequence・onClientDisconnected の両方）に必ず1回書く。
   *
   * @returns {Promise<any>} 日記を書き終えるまでの Promise（流れたコーナーが無ければすぐ終わる）
   */
  _writeDirectorSessionSummaryDiary() {
    const corners = this._directorCornersThisSession || [];
    this._directorCornersThisSession = [];
    if (corners.length === 0) return Promise.resolve();

    const counts = {};
    for (const c of corners) counts[c] = (counts[c] || 0) + 1;
    const cornerSummary = Object.entries(counts).map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join('、');

    const decision = this._lastAppliedDirectorDecision;
    const decisionSummary = decision
      ? `ゲスト起用: ${decision.guests.length > 0 ? decision.guests.join('・') : 'なし'} / 世界レポート: ${decision.includeWorldReport ? 'あり' : 'なし'} / 法律相談: ${decision.includeLegalAdvisor ? 'あり' : 'なし'} / music_dj頻度: ${decision.musicDjFrequency}${decision.bigTopic ? ` / 大きな話題: ${decision.bigTopic}` : ''}`
      : '（編成情報なし）';
    const material = `今回のセッションで実際に流れたコーナー: ${cornerSummary}\n編成方針: ${decisionSummary}`;

    const config = this.getConfig();
    const directorName = (config.agents?.director?.name) || '森田正義（ディレクタ）';
    return this._writeDiaryReflection('director', directorName, material, 'session_summary', 'plan');
  },
};

module.exports = { directorDecisionMethods };
