/**
 * @file 秘書が定期的に身の回りを見回り、変わったことがあれば次の接続で伝える（自律ループ）
 *
 * server.js が5分ごとに tick() を呼ぶ。実際の間隔・静かな時間帯・見る先の on/off は、そのたびに
 * config.secretary_loop（管理画面の「My Secretary → 自律ループ設定」）から読み直す。
 *
 * 見回りは2段構え。
 * - 前半（LLM を使わない）: メール・カレンダー・天気・ニュース・金融について、変わったかどうかをコードだけで
 *   決める（新着の ID の差・予定の近さ・閾値を超えたか・言葉の一致）。何度呼んでも費用はかからない
 * - 後半（LLM を1回だけ）: 前半で1つでも変化が見つかったときだけ、まとめて1回 LLM を呼び、秘書らしい
 *   一言にする。何も無ければ LLM は呼ばれない
 *
 * できた一言は pending.json に積み、次に秘書へ接続したときの挨拶で一度だけ使う（使うと消える）。
 * それとは別に、Live のディレクターが何度でも読めるよう live_signal_feed.json にも残す（消えない）。
 *
 * このループは、見回りとは別の定期の仕事も抱えている。どれも secretary_loop の on/off とは関係なく動く
 * （静かにファイルを書くだけで、リスナーへの割り込みではないため）。
 * - 2時間おきの天気の記録（デイリーノートの気温のグラフの実測に使う）
 * - 日次のレポート・業務ログ（23時50分）と、日曜の週次のレポート
 * - ジャーナリストの見張り・専門家の自主リサーチ・YouTube の興味の学習・受信箱の依頼の処理
 * - メールからの学習と、会話で使うメールの仕分けの先読み
 *
 * 保存先は server/data/secretary/notifications/（state.json・pending.json）と
 * server/data/secretary/memory/live_signal_feed.json。
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

const path = require('path');
const { generateText } = require('./llm-client');
const GoogleService = require('../services/google-service');
const NewsService = require('../services/news-service');
const WeatherService = require('../services/weather-service');
const FinanceService = require('../services/finance-service');
const { createDailyReport, createSecretaryActivityLog, createWeeklyReport } = require('./secretary-tools');
// 会話で使うメールの仕分けを、先に済ませておくために使う（tick 内を参照）
const { refreshEmailTriage } = require('./secretary-tools-google');
const secretaryMemory = require('./secretary-memory');
const { getLogger } = require('../logger');
const activityDb = require('../activity-db');
const secretaryStore = require('./secretary-store');
const financeImportStore = require('./finance-import-store');
const obsidianService = require('../services/obsidian-service');
const jsonFileStore = require('./json-file-store');
const secretaryInbox = require('./secretary-inbox');
const { maybeRunJournalistWatch } = require('./journalist-watch');
const { maybeRunAgentProactiveResearch } = require('./agent-proactive-research');
const { checkYoutubeInterestLearning } = require('./youtube-interest-learning');

// ATTENTION: 会話で使うもの（secretary-tools.js）とは別に作る。ループは会話とは無関係に動くので、
// 覚えている内容を共有すると互いに影響してしまう
const googleService = new GoogleService();
const newsService = new NewsService();
const weatherService = new WeatherService();
const financeService = new FinanceService();

const NOTIF_DIR = path.join(__dirname, '..', 'data', 'secretary', 'notifications');
const STATE_PATH = path.join(NOTIF_DIR, 'state.json');
const PENDING_PATH = path.join(NOTIF_DIR, 'pending.json');

// 見つけた変化を、Live のディレクターが何度でも読める形で残す先。挨拶用の pending.json（読むと消える）
// とは別にする。ほかのチャンネルへ渡してよい情報は、別のファイルに分けて置く
const MEMORY_DIR = path.join(__dirname, '..', 'data', 'secretary', 'memory');
const LIVE_SIGNAL_FEED_PATH = path.join(MEMORY_DIR, 'live_signal_feed.json');
const LIVE_SIGNAL_FEED_MAX_ENTRIES = 30;
// 資産データの催促は事務的な連絡で、放送には関係しないので、Live へは渡さない
const LIVE_SIGNAL_SOURCES = ['email', 'calendar', 'weather', 'news', 'finance'];

/**
 * 「もう知らせたメール」として覚えておく ID の数。
 *
 * ATTENTION: 一覧の API が返すのは直近24時間ぶんなので、この数だけ覚えておけば取りこぼさない。
 * 減らすと、窓から外れた ID が記録から落ちて、同じメールをまた「新着」と数えてしまう。
 */
const EMAIL_ID_MEMORY_MAX = 200;

const DEFAULT_LOOP_CONFIG = {
  enabled: false,
  check_interval_minutes: 20,
  quiet_hours_start: '23:00',
  quiet_hours_end: '07:00',
  cooldown_minutes_after_session: 30,
  calendar_lookahead_minutes: 30,
  finance_change_threshold_pct: 3,
  finance_fund_change_threshold_pct: 1,
  sources: { email: true, calendar: true, weather: true, news: true, finance: true },
};

// 天気を記録する時刻（2時間おき）。今の天気を自分で取って残すので、予報の API の刻みに縛られない。
// ATTENTION: 予報の側は3時間刻みでしか取れない。気温のグラフは、実測（2時間刻み・過去）と
// 予報（3時間刻み・これから）を1本につなぐので、後半の間隔が粗くなるのは承知のうえ
const WEATHER_SNAPSHOT_BUCKETS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

// 「その日が終わってからまとめる」処理の時刻（週次ノート・資産スクショの催促の締め）。
// ATTENTION: 管理画面から変えられるようにしないこと。時刻を早めると、まとめる対象の1日・1週間が
// まだ終わっておらず、中身が空になったり欠けたりする。
const DAY_END_TRIGGER_HOUR = 23;
const DAY_END_TRIGGER_MINUTE = 50;

// デイリーノートを作る時刻。朝の仕事を始める前に、その日に要る情報（今日の予報・警報・予定・
// ニュース・相場・おすすめレシピ）と、昨日の業務のふり返りをそろえるためのノートなので、
// 1日の終わりではなく朝に作る。
// ATTENTION: 金融の確定値は毎朝7時を締めにしている（finance-service.js の DAILY_ANCHOR_HOUR）。
// これより前へ動かすと、前日の値のまま書かれる。
const DAILY_NOTE_TRIGGER_HOUR = 7;
const DAILY_NOTE_TRIGGER_MINUTE = 30;

/**
 * 今が、その日が終わってからまとめる処理の時刻（23時50分）を過ぎているか。
 * @param {Date} now 今の時刻
 * @returns {boolean} 過ぎていれば true
 */
function _isPastDayEndTriggerTime(now) {
  return now.getHours() > DAY_END_TRIGGER_HOUR
    || (now.getHours() === DAY_END_TRIGGER_HOUR && now.getMinutes() >= DAY_END_TRIGGER_MINUTE);
}

/**
 * 今がデイリーノートを作る時刻（7時30分）を過ぎているか。
 * @param {Date} now 今の時刻
 * @returns {boolean} 過ぎていれば true
 */
function _isPastDailyNoteTriggerTime(now) {
  return now.getHours() > DAILY_NOTE_TRIGGER_HOUR
    || (now.getHours() === DAILY_NOTE_TRIGGER_HOUR && now.getMinutes() >= DAILY_NOTE_TRIGGER_MINUTE);
}

// 速報かどうかは、言葉の一致だけで決める。ディレクターの判断のように LLM は使わない（費用がかかるため）
const URGENT_NEWS_KEYWORDS = /速報|緊急|号外|大地震|震度[6-7]|噴火|津波警報|特別警報/;

/**
 * 日付を YYYY-MM-DD にする（サーバーのローカル時刻）。
 * @param {Date} [d] 日付
 * @returns {string} YYYY-MM-DD
 */
function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * JSON を読む（中身は json-file-store.js。ログの見出しだけ固定した薄い包み）。
 * @param {string} filePath ファイルのパス
 * @param {any} fallback 読めないときに返す値
 * @returns {any} 読んだ内容
 */
function readJson(filePath, fallback) {
  return jsonFileStore.readJsonFile(filePath, fallback, '[SecretaryLoop]');
}

/**
 * JSON を書く。
 * @param {string} filePath ファイルのパス
 * @param {any} data 書く内容
 * @returns {void}
 */
function writeJson(filePath, data) {
  jsonFileStore.writeJsonFile(filePath, data, '[SecretaryLoop]');
}

/**
 * ループの状態（最後に見回った時刻・通知済みの印など）を読む。
 * @returns {Record<string, any>} 状態
 */
function readState() {
  return readJson(STATE_PATH, {
    lastLoopRunAt: 0,
    lastSessionEndedAt: 0,
    lastEmailIds: [],
    notifiedEventKeys: [],
    weatherSignatureNotified: '',
    notifiedNewsTitles: [],
    notifiedFinanceKeys: [],
    lastAutoReportDate: null,
    lastActivityReportDate: null,
    lastWeatherSnapshotKey: null,
    lastAutoWeeklyReportDate: null,
    financeReminderNotifiedDate: null,
  });
}

/**
 * ループの状態を書く。
 * @param {Record<string, any>} state 状態
 * @returns {void}
 */
function writeState(state) {
  writeJson(STATE_PATH, state);
}

/**
 * 秘書との会話が終わった時刻を記録する（この時刻から一定時間は見回らない）。
 * secretary-live-routes.js が会話の終わりに呼ぶ。
 * @returns {void}
 */
function recordSessionEnded() {
  const state = readState();
  state.lastSessionEndedAt = Date.now();
  writeState(state);
}

/**
 * 今が静かな時間帯（見回らない時間）か。開始と終了が同じなら、静かな時間帯は無いものとして扱う。
 * @param {Record<string, any>} loopCfg ループの設定
 * @param {Date} [now] 今の時刻
 * @returns {boolean} 静かな時間帯なら true
 */
function isQuietHours(loopCfg, now = new Date()) {
  const [startH, startM] = (loopCfg.quiet_hours_start || '23:00').split(':').map(Number);
  const [endH, endM] = (loopCfg.quiet_hours_end || '07:00').split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  if (startMin === endMin) return false; // 開始と終了が同じなら無効
  if (startMin < endMin) {
    // 同じ日の中（例: 13:00〜18:00）
    return nowMin >= startMin && nowMin < endMin;
  }
  // 日をまたぐ（例: 23:00〜07:00）
  return nowMin >= startMin || nowMin < endMin;
}

// ── 前半: 変わったかどうかをコードだけで決める（LLM を使わない）─────────────

/**
 * 未読メールに新着があるか。前回見た ID との差で決める。
 *
 * BUGFIX: 見た ID は入れ替えず、積み上げて新しい方から一定数だけ残すこと。入れ替えていたころ、
 * 一覧の API が1回に返す件数（filter.max_fetch、既定15）を未読が上回ると、窓から外れた ID が
 * 記録から落ち、次の見回りで同じメールをまた「新着」と数えていた。
 * @param {Record<string, any>} creds 認証情報
 * @param {Record<string, any>} config config.json 全体（Gmail のフィルター）
 * @param {Record<string, any>} state ループの状態（書き換える）
 * @returns {Promise<any>} 変化（無ければ null）
 */
async function checkEmail(creds, config, state) {
  const filter = config.show?.gmail_filter || {};
  const ids = await googleService.fetchUnreadIds(creds, { filter });
  const prevIds = new Set(state.lastEmailIds || []);
  const newIds = ids.filter(id => !prevIds.has(id));
  // 学習側（minedEmailIds）と同じ積み上げ方にそろえてある
  state.lastEmailIds = [...new Set([...(state.lastEmailIds || []), ...ids])].slice(-EMAIL_ID_MEMORY_MAX);
  if (newIds.length === 0) return null;
  return { source: 'email', text: `新着の未読メールが${newIds.length}件届いています。` };
}

/**
 * まだ学習に使っていない新着メールがあれば、件名・差出人・本文の抜粋から学習させる
 * （secretary-memory.js）。会話に出てこないメールの内容も学べるようにするため。
 *
 * ATTENTION: 見た ID は、通知用（lastEmailIds）とは別の鍵（minedEmailIds）で覚える。通知は要らないが
 * 学習はしたい（またはその逆）を後から分けられるようにするため。
 * 本文の取り出しと学習は数秒かかるので待たない（ID の記録だけは先に済ませる）。
 *
 * @param {{creds: Record<string, any>, config: Record<string, any>, apiKey: string, state: Record<string, any>}} args
 * @returns {Promise<void>}
 */
async function checkAmbientEmailLearning({ creds, config, apiKey, state }) {
  if (!apiKey) return;
  const filter = config.show?.gmail_filter || {};
  const ids = await googleService.fetchUnreadIds(creds, { filter });
  const prevMined = new Set(state.minedEmailIds || []);
  const newIds = ids.filter(id => !prevMined.has(id));
  if (newIds.length === 0) return;
  // 1回で深追いしないよう上限を付ける（まとめて届いた残りは次の見回りで拾う）
  const targetIds = newIds.slice(0, 10);
  state.minedEmailIds = [...(state.minedEmailIds || []), ...targetIds].slice(-200);

  googleService.fetchEmailDetailsByIds(creds, targetIds).then((details) => {
    if (!details || details.length === 0) return null;
    const materialText = details
      .map(d => `件名: ${d.subject}\n差出人: ${d.from}\n本文抜粋: ${(d.body || d.snippet || '').slice(0, 500)}`)
      .join('\n\n---\n\n');
    // BUGFIX: 学習を足すだけでなく、圧縮とリスナー像の作り直しまで続けて行う。この経路だけで学習が
    // 増えた回に、リスナー像が古いまま取り残されないようにするため
    return secretaryMemory.summarizeAmbientLearnings(materialText, {
      apiKey, activitySessionId: null, listenerProfile: config.show?.user_profile || {}, sourceLabel: 'auto_ambient_email',
    })
      .finally(() => secretaryMemory.compactOldAutoLearnings({ apiKey, activitySessionId: null })
        .finally(() => secretaryMemory.summarizeListenerDigest({ apiKey, activitySessionId: null })
          .catch((e) => getLogger().warn(`[SecretaryLoop] リスナー情報ダイジェストの更新に失敗: ${e.message}`))));
  }).catch(e => getLogger().warn(`[SecretaryLoop] メールからのアンビエント学習に失敗: ${e.message}`));
}

/**
 * 間もなく始まる予定があるか（既定では30分先まで）。一度知らせた予定は、もう知らせない。
 * @param {Record<string, any>} creds 認証情報
 * @param {Record<string, any>} loopCfg ループの設定（何分先まで見るか）
 * @param {Record<string, any>} state ループの状態（書き換える）
 * @returns {Promise<any>} 変化（無ければ null）。一番早い予定の開始時刻を期限に付ける
 */
async function checkCalendar(creds, loopCfg, state) {
  const events = await googleService.fetchCalendar(creds, { rangeDays: 1, maxResults: 10 });
  const lookaheadMs = (loopCfg.calendar_lookahead_minutes || 30) * 60000;
  const now = Date.now();
  const notified = new Set(state.notifiedEventKeys || []);
  const upcoming = [];
  for (const ev of events) {
    if (!ev.startISO) continue; // 終日の予定は対象外
    const startMs = new Date(ev.startISO).getTime();
    const diffMs = startMs - now;
    if (diffMs < 0 || diffMs > lookaheadMs) continue;
    const key = `${ev.startISO}:${ev.summary}`;
    if (notified.has(key)) continue;
    notified.add(key);
    upcoming.push(ev);
  }
  // 増え続けないよう、直近50件だけ残す
  state.notifiedEventKeys = Array.from(notified).slice(-50);
  if (upcoming.length === 0) return null;
  const list = upcoming.map(ev => `${ev.dateLabel}${ev.timeStr}〜「${ev.summary}」`).join('、');
  // BUGFIX: 期限を付ける。「間もなく」という知らせは、予定が始まってしまえば意味を持たない。付けて
  // いなかったころ、開始の数時間後に接続して「14時から予定があります」と読み上げていた
  const earliestStart = Math.min(...upcoming.map(ev => new Date(ev.startISO).getTime()));
  return { source: 'calendar', text: `間もなく予定があります: ${list}`, expiresAt: earliestStart };
}

/**
 * 住んでいる所に関わる気象の危険（台風・警報・地震や津波）があるか。同じ内容は繰り返し知らせない。
 *
 * BUGFIX: 「データがあるか」ではなく「住んでいる所に影響するか」で決める。データの有無で見ていたころ、
 * 数百キロ離れた地域の警報や、はるか遠くの台風を「ここで出ています」と知らせていた。
 * BUGFIX: 地震は住んでいる所と結びつけず、独立した文にする。地震の情報は全国が対象なので、結びつけると
 * 「ここで震度3」のような、ありもしない詳細まで作文されていた。
 *
 * @param {Record<string, any>} creds 認証情報
 * @param {Record<string, any>} config config.json 全体（住んでいる所）
 * @param {Record<string, any>} state ループの状態（書き換える）
 * @returns {Promise<any>} 変化（無ければ null）
 */
async function checkWeather(creds, config, state) {
  const profile = config.show?.user_profile || {};
  await weatherService.fetch({
    overrideLocation: null,
    defaultLocation: profile.location,
    isTempStay: false,
    apiKey: creds.openweathermap?.api_key,
    prefCode: profile.pref_code || '130000',
  });
  const s = weatherService.cache?.structured;
  if (!s) return null;
  // 知らせる基準（住んでいる所への影響は weather-service.js が判定する）。
  //   台風 … 進路が住んでいる所の近くまで来るもの（今どこにあるかではなく、どこへ向かうかで見る）
  //   警報 … 住んでいる地域が対象のもの
  //   地震 … 最大震度4以上、または津波の警報・注意報が出ているもの（陸の揺れが小さくても津波の被害は出る）
  const typhoonNear = s.hasTyphoon && s.typhoonAffectsListener === true;
  const warningLocal = s.hasWarning && s.warningAffectsListener === true;
  const quakeNotable = s.hasQuake && ((s.quakeMaxIntensity ?? 0) >= 4 || !!s.quakeTsunamiLevel);
  const hasHazard = typhoonNear || warningLocal || quakeNotable;
  const signature = [typhoonNear && s.typhoonSummary, warningLocal && s.warningSummary, quakeNotable && s.quakeSummary]
    .filter(Boolean).join('|');
  if (!hasHazard) {
    state.weatherSignatureNotified = '';
    return null;
  }
  if (signature === state.weatherSignatureNotified) return null; // 同じ内容は繰り返さない
  state.weatherSignatureNotified = signature;
  const localParts = [];
  if (typhoonNear) localParts.push(`台風情報（${s.typhoonSummary || '詳細確認要'}）`);
  if (warningLocal) localParts.push(`気象警報（${s.warningSummary || '詳細確認要'}）`);
  const sentences = [];
  if (localParts.length > 0) {
    sentences.push(`${profile.location || '居住地'}で${localParts.join('・')}が出ています。`);
  }
  if (quakeNotable) {
    sentences.push(`日本国内で地震情報（${s.quakeSummary || '詳細確認要'}）が発表されています`
      + `（${profile.location || 'リスナーの居住地'}で発生したとは限らないため、場所を`
      + `明記して伝えてください。詳細を聞かれたら必ずget_weatherで最新情報を確認してから`
      + `答えてください。記憶や推測で震度・場所を作文しないでください）。`);
  }
  if (sentences.length === 0) return null;
  return { source: 'weather', text: sentences.join(' ') };
}

/**
 * 速報にあたる見出しがあるか（URGENT_NEWS_KEYWORDS の言葉が入っているか）。一度知らせた見出しは除く。
 * @param {Record<string, any>} state ループの状態（書き換える）
 * @returns {Promise<any>} 変化（無ければ null）
 */
async function checkNews(state) {
  await newsService.fetch();
  const items = newsService.cache?.structured || [];
  const notified = new Set(state.notifiedNewsTitles || []);
  const urgent = items.filter(i => URGENT_NEWS_KEYWORDS.test(i.title) && !notified.has(i.title));
  for (const i of urgent) notified.add(i.title);
  state.notifiedNewsTitles = Array.from(notified).slice(-30);
  if (urgent.length === 0) return null;
  return { source: 'news', text: `速報級のニュースがあります: ${urgent.map(i => i.title).join('、')}` };
}

/**
 * 相場が大きく動いた銘柄があるか。同じ日に同じ銘柄は一度だけ知らせる。
 * 投資信託は個別の株ほど日々動かないので、株より低い閾値を使う。
 * @param {Record<string, any>} config config.json 全体
 * @param {Record<string, any>} loopCfg ループの設定（閾値）
 * @param {Record<string, any>} state ループの状態（書き換える）
 * @returns {Promise<any>} 変化（無ければ null）
 */
async function checkFinance(config, loopCfg, state) {
  await financeService.fetch(config);
  const items = financeService.cache?.structured || [];
  const stockThreshold = loopCfg.finance_change_threshold_pct ?? 3;
  const fundThreshold = loopCfg.finance_fund_change_threshold_pct ?? 1;
  const today = todayStr();
  // 印に日付を付けてあるので、日が変われば前日分は自然に消える（翌日はまた知らせる）
  const notified = new Set((state.notifiedFinanceKeys || []).filter(k => k.startsWith(today)));
  const moved = [];
  for (const item of items) {
    const threshold = item.kind === 'fund' ? fundThreshold : stockThreshold;
    if (Math.abs(item.pct) < threshold) continue;
    const key = `${today}:${item.key}`;
    if (notified.has(key)) continue;
    notified.add(key);
    moved.push(item);
  }
  state.notifiedFinanceKeys = Array.from(notified).slice(-50);
  if (moved.length === 0) return null;
  const list = moved.map(i => `${i.key}が${i.pct >= 0 ? '+' : ''}${i.pct.toFixed(1)}%`).join('、');
  return { source: 'finance', text: `相場が大きく動いています: ${list}` };
}

/**
 * 週次の資産レポートに使うデータが届いていなければ、土日のうちに1日1回だけ催促する。
 * 日曜の夜までに届かないと、週次のレポートが資産の欄を埋められないため。
 *
 * BUGFIX: 届いているかは、ブラウザ拡張からの取り込みで判定する。Vault の画像の更新日時で見ていたころ、
 * 画像を上げなくなると古い画像が残ったまま「更新されていません」と言い続けていた。
 *
 * @param {Record<string, any>} config config.json 全体
 * @param {Record<string, any>} state ループの状態（書き換える）
 * @returns {Promise<any>} 催促（要らなければ null）
 */
async function checkFinanceScreenshotReminder(config, state) {
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.vault_path) return null;

  const now = new Date();
  if (![0, 6].includes(now.getDay())) return null; // 土日だけ
  if (_isPastDayEndTriggerTime(now)) return null; // この時刻からは週次の処理に任せる

  const today = todayStr(now);
  if (state.financeReminderNotifiedDate === today) return null; // 今日はもう知らせた

  const { fresh, stale } = financeImportStore.readFreshImports({ maxAgeDays: 8 });
  if (fresh.rakuten && fresh.paypay) return null; // どちらも新しいので何も言わない

  const screenshotFallback = config.finance_import?.screenshot_fallback === true;
  const rakutenFolder = obs.rakuten_screenshot_folder || '20_asset_data/Rakuten';
  const paypayFolder = obs.paypay_screenshot_folder || '20_asset_data/PayPay';
  const anyScreenshot = screenshotFallback && !!(
    obsidianService.findLatestImageFile(obs.vault_path, rakutenFolder)
    || obsidianService.findLatestImageFile(obs.vault_path, paypayFolder)
  );
  // 取り込みが一度も無く、画像も使っていない＝この機能をまだ使っていないので催促しない
  if (!fresh.rakuten && !fresh.paypay && !stale.rakuten && !stale.paypay && !anyScreenshot) return null;

  const which = [['rakuten', '楽天証券'], ['paypay', 'PayPay銀行']]
    .filter(([k]) => !fresh[k])
    .map(([k, label]) => {
      if (!stale[k]) return `${label}（未受信）`;
      const days = Math.floor((Date.now() - new Date(stale[k].receivedAt).getTime()) / 86400000);
      return `${label}（${days}日前）`;
    })
    .join('・');

  state.financeReminderNotifiedDate = today;
  return { source: 'finance_screenshot', text: `週次金融レポート用の資産データが最近更新されていません（${which}）。ブラウザで口座ページを開くと自動で送信されます` };
}

// ── 後半: 変化が見つかったときだけ、まとめて1回 LLM で一言にする ────────────

/**
 * 見つけた変化を、秘書が次の挨拶で話せる短い一言（1〜3文）にまとめる。
 * @param {Array<any>} signals 見つけた変化
 * @param {string} apiKey Gemini の API キー
 * @param {any} activitySessionId 記録用
 * @returns {Promise<{text: string}>} まとめた一言
 */
async function composeNotification(signals, apiKey, activitySessionId) {
  const systemInstruction = 'あなたはAI秘書です。以下に列挙する複数の変化点を、次回リスナーと'
    + '会話が始まったときに秘書自身の言葉で自然に伝えられる、短い日本語の一言（1〜3文）に'
    + 'まとめてください。事実を正確に伝え、大げさな煽りや不要な前置きは避けてください。'
    + '出力は本文のみとし、説明文や箇条書き記号は含めないでください。';
  const userPrompt = '以下の変化が検知されました:\n' + signals.map(s => `- ${s.text}`).join('\n');

  // 短い作文なので 'light' ティア。使用量の記録は llm-client に任せる（ここで書くとモデル名が二重になる）
  const { text } = await generateText({
    tier: 'light',
    apiKey,
    systemInstruction,
    prompt: userPrompt,
    temperature: 0.3,
    agentKey: 'secretary_loop',
    activitySessionId,
  });
  return { text: text.trim() };
}

/**
 * 今の天気を2時間おきに記録する（WEATHER_SNAPSHOT_BUCKETS の時刻ごとに1回だけ）。
 *
 * 予報の API は先の時間帯しか返さないので、記録しておかないと、夜に作るデイリーノートの
 * 「本日の気温」に、その日の過去の分が入らない。記録は weather-history として残す。
 *
 * @param {{config: Record<string, any>, creds: Record<string, any>}} args
 * @returns {Promise<void>}
 */
async function maybeRecordWeatherSnapshot({ config, creds }) {
  if (!creds.openweathermap?.api_key) return;
  const now = new Date();
  const currentBucket = WEATHER_SNAPSHOT_BUCKETS.filter(h => h <= now.getHours()).pop() ?? 0;
  const key = `${todayStr(now)}-${currentBucket}`;

  const state = readState();
  if (state.lastWeatherSnapshotKey === key) return; // この時間帯は記録済み

  try {
    const profile = config.show?.user_profile || {};
    await weatherService.fetch({
      overrideLocation: null,
      defaultLocation: profile.location,
      isTempStay: false,
      apiKey: creds.openweathermap.api_key,
      prefCode: profile.pref_code || '130000',
    });
    const s = weatherService.cache?.structured;
    if (!s || s.temp == null || !s.desc) return; // 取れなければ次の見回りでやり直す

    secretaryStore.appendEntry('weather-history', { bucketHour: currentBucket, temp: s.temp, desc: s.desc });
    state.lastWeatherSnapshotKey = key;
    writeState(state);
    getLogger().debug(`[SecretaryLoop] 天気実況スナップショットを記録: ${currentBucket}時 ${s.temp}℃ ${s.desc}`);
  } catch (e) {
    getLogger().debug(`[SecretaryLoop] 天気実況スナップショットの記録に失敗: ${e.message}`);
  }
}

/**
 * 頼まれなくても、その日の天気・ニュース・金融をまとめたデイリーノートを1日1回作る（7時30分以降）。
 * 中身は会話から呼ぶときと同じ処理（secretary-tools.js の createDailyReport）。
 *
 * ATTENTION: これだけは朝に作る。朝の仕事を始める前に読むノートなので、1日の終わりにまとめる
 * 業務ログ・週次ノートとは時刻を分けてある（DAILY_NOTE_TRIGGER_HOUR）。
 *
 * ATTENTION: 失敗したときは日付を記録しないこと。記録すると、その日はもう作り直されない。
 *
 * @param {{config: Record<string, any>, creds: Record<string, any>}} args
 * @returns {Promise<void>}
 */
async function maybeCreateAutoDailyReport({ config, creds }) {
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.auto_daily_report) return;

  const now = new Date();
  if (!_isPastDailyNoteTriggerTime(now)) return;

  const state = readState();
  const today = todayStr(now);
  if (state.lastAutoReportDate === today) return; // 今日の分は作成済み

  try {
    const res = await createDailyReport({ config, creds });
    if (res.error) {
      getLogger().debug(`[SecretaryLoop] 自動デイリーレポートをスキップ: ${res.error}`);
      return; // 日付を記録せずに戻り、次の見回りでやり直す
    }
    getLogger().info(`[SecretaryLoop] 自動デイリーレポートを作成しました（${(res.filled || []).join('・') || 'データ無し'}）`);
  } catch (e) {
    getLogger().warn(`[SecretaryLoop] 自動デイリーレポート作成に失敗: ${e.message}`);
    return; // 次の見回りでやり直す
  }
  state.lastAutoReportDate = today;
  writeState(state);
}

/**
 * デイリーノートの「昨日の業務内容」「報告事項」「所感」を、1日1回自動で埋める（7時30分以降）。
 * 昨日に秘書が行ったことの記録を LLM で1回まとめる。
 *
 * ATTENTION: まとめる対象は昨日で、書き込む先は今日のノート。朝に読むノートなので、今日の分は
 * まだ何も起きていない。
 * ATTENTION: 天気などのレポート（maybeCreateAutoDailyReport）とは、済んだかどうかの印を分けてある。
 * 片方が失敗しても、もう片方に影響させないため。on/off の設定は同じものを使う（リスナーにとっては
 * 「その日のノートをまとめる」という1つのこと）。
 *
 * @param {{config: Record<string, any>, creds: Record<string, any>}} args
 * @returns {Promise<void>}
 */
async function maybeCreateSecretaryActivityReport({ config, creds }) {
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.auto_daily_report) return;

  const now = new Date();
  if (!_isPastDailyNoteTriggerTime(now)) return;

  const state = readState();
  const today = todayStr(now);
  if (state.lastActivityReportDate === today) return; // 今日の分は作成済み

  try {
    const res = await createSecretaryActivityLog({ config, creds });
    if (res.error) {
      getLogger().debug(`[SecretaryLoop] 自動業務ログをスキップ: ${res.error}`);
      return; // 日付を記録せずに戻り、次の見回りでやり直す
    }
    if (res.skipped) {
      getLogger().debug('[SecretaryLoop] 自動業務ログをスキップ: 本日はまだ記録できる業務が無い');
      return; // 夜遅くに会話があるかもしれないので、日付を確定させずにやり直す
    }
    getLogger().info('[SecretaryLoop] 自動業務ログ（本日の業務内容・報告事項・所感）を作成しました');
  } catch (e) {
    getLogger().warn(`[SecretaryLoop] 自動業務ログ作成に失敗: ${e.message}`);
    return; // 次の見回りでやり直す
  }
  state.lastActivityReportDate = today;
  writeState(state);
}

/**
 * 週次のノート（1週間の天気のふり返り・来週の予報・主なニュース・週の記録・資産）を、
 * 日曜の23時50分以降に1回だけ作る。
 *
 * ATTENTION: 済んだかどうかの印は、日次のものとは分けてある（片方の失敗を、もう片方に影響させないため）。
 *
 * @param {{config: Record<string, any>, creds: Record<string, any>}} args
 * @returns {Promise<void>}
 */
async function maybeCreateAutoWeeklyReport({ config, creds }) {
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.auto_daily_report) return;

  const now = new Date();
  if (now.getDay() !== 0) return; // 日曜だけ
  if (!_isPastDayEndTriggerTime(now)) return;

  const state = readState();
  const today = todayStr(now);
  if (state.lastAutoWeeklyReportDate === today) return; // 今週の分は作成済み

  try {
    const res = await createWeeklyReport({ config, creds });
    if (res.error) {
      getLogger().debug(`[SecretaryLoop] 自動ウィークリーレポートをスキップ: ${res.error}`);
      return; // 日付を記録せずに戻り、次の見回りでやり直す
    }
    getLogger().info(`[SecretaryLoop] 自動ウィークリーレポートを作成しました（${(res.filled || []).join('・') || 'データ無し'}）`);
  } catch (e) {
    getLogger().warn(`[SecretaryLoop] 自動ウィークリーレポート作成に失敗: ${e.message}`);
    return; // 次の見回りでやり直す
  }
  state.lastAutoWeeklyReportDate = today;
  writeState(state);
}

/**
 * server.js から5分おきに呼ばれる。実際の間隔と on/off は設定から読み直すので、呼ぶ側は気にしなくてよい。
 *
 * 前半は、ループの on/off とは関係なく動く定期の仕事（天気の記録・レポート・見張り・学習）。
 * 後半は、設定が有効で、静かな時間帯でも会話の直後でもなく、前回から間隔が空いているときだけ行う見回り。
 *
 * ATTENTION: 天気の記録はレポートより先に呼ぶこと。同じ回のレポートで、最新の記録を使えるようにするため。
 *
 * @param {{config: Record<string, any>, creds: Record<string, any>, onCycle?: Function}} args
 *   onCycle は見回りの開始と終了を画面へ知らせる関数
 * @returns {Promise<void>}
 */
async function tick({ config, creds, onCycle }) {
  // ここから下の4つは、ループの on/off や静かな時間帯とは関係なく動く（静かにファイルへ書くだけで、
  // リスナーへの割り込みではないため）
  await maybeRecordWeatherSnapshot({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] 天気実況スナップショット処理で例外: ${e.message}`);
  });
  await maybeCreateAutoDailyReport({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] 自動デイリーレポート処理で例外: ${e.message}`);
  });
  await maybeCreateSecretaryActivityReport({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] 自動業務ログ処理で例外: ${e.message}`);
  });
  // 週次は日次の後に走らせる（厳密な依存は無いが、同じ回の中で自然な順序にそろえる）
  await maybeCreateAutoWeeklyReport({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] 自動ウィークリーレポート処理で例外: ${e.message}`);
  });
  // ジャーナリストの見張り（要人・機関の一次情報を1日4回先取りする。journalist-watch.js）
  await maybeRunJournalistWatch({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] ジャーナリストウォッチ処理で例外: ${e.message}`);
  });
  // 専門家（コメンテーター・弁護士）の自主リサーチ（リスナーの状況を材料に、調べる価値があるかを1日1回
  // 問いかける。agent-proactive-research.js）
  await maybeRunAgentProactiveResearch({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] エージェント能動的リサーチ処理で例外: ${e.message}`);
  });
  // YouTube の登録チャンネルから興味の傾向を学ぶ（一覧の取得は軽く、LLM は登録が変わったときだけ動く。
  // youtube-interest-learning.js）
  await checkYoutubeInterestLearning({ creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] YouTube興味傾向学習処理で例外: ${e.message}`);
  });

  const loopCfg = { ...DEFAULT_LOOP_CONFIG, ...(config.secretary_loop || {}) };
  if (!loopCfg.enabled) return;
  if (!creds?.gemini?.api_key) return; // 後半の一言作りに要るので、無ければ見回り自体をやめる
  if (isQuietHours(loopCfg)) return;

  const state = readState();
  const now = Date.now();
  if (state.lastSessionEndedAt && now - state.lastSessionEndedAt < (loopCfg.cooldown_minutes_after_session || 30) * 60000) return;
  const intervalMs = (loopCfg.check_interval_minutes || 20) * 60000;
  if (now - state.lastLoopRunAt < intervalMs) return;

  state.lastLoopRunAt = now;

  // Obsidian の受信箱に置かれた依頼の処理（secretary-inbox.js）。調べ物やレポート作りで数分かかることが
  // あるので、待たずに走らせる（この後の軽い見回りを止めないため）
  secretaryInbox.processInboxOnce({ config, creds }).catch((e) => {
    getLogger().warn(`[SecretaryLoop] Inboxバッチ処理で例外: ${e.message}`);
  });

  // 会話で使うメールの仕分けを先に済ませておく（会話中の確認が ID の突き合わせだけで済む）。
  // 新着が無ければ LLM は呼ばれない。ここは裏の作業なので、記録は会話のセッションに混ぜない
  refreshEmailTriage({ config, creds, activitySessionId: null }, { reason: '自律ループの事前準備' })
    .catch((e) => getLogger().warn(`[SecretaryLoop] メールの事前取得で例外: ${e.message}`));

  // ダッシュボードに、見回りをしている間だけ「確認中」と出す。途中で失敗しても必ず元に戻す
  onCycle?.({ state: 'checking' });
  try {
    const sources = { ...DEFAULT_LOOP_CONFIG.sources, ...(loopCfg.sources || {}) };
    const checks = [];
    if (sources.email)    checks.push(['email',    checkEmail(creds, config, state)]);
    if (sources.calendar) checks.push(['calendar', checkCalendar(creds, loopCfg, state)]);
    if (sources.weather)  checks.push(['weather',  checkWeather(creds, config, state)]);
    if (sources.news)     checks.push(['news',     checkNews(state)]);
    if (sources.finance)  checks.push(['finance',  checkFinance(config, loopCfg, state)]);
    checks.push(['finance_screenshot', checkFinanceScreenshotReminder(config, state)]);

    // メールからの学習。知らせるべき変化の判定とは別の裏の作業なので、変化の一覧には加えない
    if (sources.email) {
      await checkAmbientEmailLearning({ creds, config, apiKey: creds.gemini?.api_key, state }).catch((e) => {
        getLogger().debug(`[SecretaryLoop] メールのアンビエント学習チェックに失敗（無視して続行）: ${e.message}`);
      });
    }

    const signals = [];
    for (const [name, promise] of checks) {
      try {
        const signal = await promise;
        if (signal) signals.push(signal);
      } catch (e) {
        getLogger().debug(`[SecretaryLoop] ${name}のチェックに失敗（無視して続行）: ${e.message}`);
      }
    }

    if (signals.length === 0) {
      writeState(state);
      getLogger().debug('[SecretaryLoop] チェック完了、変化なし（LLM呼び出しなし）');
      return;
    }

    // Live のディレクターが読む側へも残す（挨拶用とは別で、読んでも消えない）。LLM を使わないので、
    // この後の一言作りが失敗してもここは残る
    const liveSignals = signals.filter((s) => LIVE_SIGNAL_SOURCES.includes(s.source));
    if (liveSignals.length > 0) {
      const feed = readJson(LIVE_SIGNAL_FEED_PATH, []);
      const now = new Date().toISOString();
      for (const s of liveSignals) feed.push({ source: s.source, text: s.text, detectedAt: now });
      writeJson(LIVE_SIGNAL_FEED_PATH, feed.slice(-LIVE_SIGNAL_FEED_MAX_ENTRIES));
    }

    getLogger().info(`[SecretaryLoop] ${signals.length}件の変化を検知、通知文を作成します: ${signals.map(s => s.source).join(',')}`);
    const activitySessionId = activityDb.openSession('secretary');
    try {
      const { text } = await composeNotification(signals, creds.gemini.api_key, activitySessionId);
      // ATTENTION: 期限のある変化（予定の「間もなく」など）が混ざっていたら、一番早い期限を全体の期限に
      // する。1つでも事実と食い違えば、まとめた文全体が信用できないため
      const expiries = signals.map((s) => s.expiresAt).filter((x) => typeof x === 'number');
      const expiresAt = expiries.length > 0 ? Math.min(...expiries) : null;
      if (text) addPendingNotification(text, { sources: signals.map(s => s.source), expiresAt });
    } catch (e) {
      getLogger().warn(`[SecretaryLoop] 通知文の作成に失敗: ${e.message}`);
    } finally {
      activityDb.closeSession(activitySessionId);
    }

    writeState(state);
  } finally {
    onCycle?.({ state: 'idle' });
  }
}

// 種類ごとの既定の期限。接続していない間に溜まった知らせが、伝わる頃には古くなっているため。
// 予定は検知の側が開始時刻を期限にするので、ここには入れない
const DEFAULT_TTL_MS = {
  weather: 6 * 60 * 60 * 1000,   // 警報・地震。半日も経てば状況が変わっている
  news: 12 * 60 * 60 * 1000,
  finance: 12 * 60 * 60 * 1000,
  email: 12 * 60 * 60 * 1000,    // 「未読が1件」自体は残っていても、半日前の検知は伝える価値が薄い
};
const FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 次の接続で伝える知らせを1件積む。ループのほか、ヘルパー（secretary-helper-agent.js）が
 * 「仕事が終わったが誰も接続していない」ときにも使う。
 *
 * BUGFIX: 同じ文は最新の1件だけ残す。残していたころ、同じ知らせが何件も並び、次の接続でその数だけ
 * 読み上げられていた。
 *
 * @param {string} text 知らせの文
 * @param {{sources?: any, expiresAt?: number|null}} [opts] どの見回りからか、いつまで有効か
 * @returns {void}
 */
function addPendingNotification(text, { sources = [], expiresAt = null } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const pending = readJson(PENDING_PATH, []);

  const deduped = pending.filter((n) => n.text !== trimmed);
  const removed = pending.length - deduped.length;
  if (removed > 0) getLogger().info(`[SecretaryLoop] 同じ内容の保留通知${removed}件を新しいものへまとめました`);

  // 期限。指定が無ければ種類ごとの既定値（複数あれば一番短いもの）
  const ttls = sources.map((s) => DEFAULT_TTL_MS[s]).filter(Boolean);
  const effectiveExpiry = expiresAt
    ?? (ttls.length > 0 ? Date.now() + Math.min(...ttls) : Date.now() + FALLBACK_TTL_MS);

  deduped.push({
    id: Date.now(), text: trimmed, createdAt: new Date().toISOString(), sources,
    expiresAt: effectiveExpiry,
  });
  writeJson(PENDING_PATH, deduped);
}

/**
 * 期限を過ぎた知らせを取り除く。期限を持たない古い形式のものは、作った時刻に既定の期限を当てて判定する。
 * @param {Array<any>} list 知らせの一覧
 * @returns {Array<any>} 期限内のものだけ
 */
function _dropExpired(list) {
  const now = Date.now();
  return list.filter((n) => {
    if (typeof n.expiresAt === 'number') return n.expiresAt > now;
    const created = new Date(n.createdAt || 0).getTime();
    if (!created) return true;
    const ttls = (n.sources || []).map((s) => DEFAULT_TTL_MS[s]).filter(Boolean);
    const ttl = ttls.length > 0 ? Math.min(...ttls) : FALLBACK_TTL_MS;
    return created + ttl > now;
  });
}

/**
 * 溜まっている知らせの件数だけを返す（画面のバッジ用）。中身は消さない（実際に接続して聞くまでは
 * 「まだ伝えていない」ままにするため）。期限切れは数に入れない（バッジと読み上げの数がずれないように）。
 * @returns {number} 件数
 */
function peekPendingNotificationCount() {
  return _dropExpired(readJson(PENDING_PATH, [])).length;
}

/**
 * 溜まっている知らせを取り出し、同時に空にする（挨拶で一度だけ使うため）。
 * BUGFIX: 期限切れはここで捨てる。捨てていなかったころ、始まってしまった予定を「間もなくあります」と
 * 読み上げていた。
 * @returns {Array<any>} 期限内の知らせ
 */
function getAndClearPendingNotifications() {
  const raw = readJson(PENDING_PATH, []);
  const list = _dropExpired(raw);
  const dropped = raw.length - list.length;
  if (dropped > 0) getLogger().info(`[SecretaryLoop] 期限切れの保留通知${dropped}件を配信せずに破棄しました`);
  if (raw.length > 0) writeJson(PENDING_PATH, []);
  return list;
}

/**
 * 溜まっている知らせを、秘書のプロンプトに入れる形で返す（取り出すと同時に空にする）。
 *
 * BUGFIX: 「これは見出しであって詳細の出どころではない」と添える。添えていなかったころ、「詳しく教えて」と
 * 聞かれた秘書が、短い知らせの文だけを元に場所や震度といった詳細を作文していた。
 *
 * @returns {string} プロンプトに入れる文（知らせが無ければ空文字）
 */
function consumePendingNotificationsForPrompt() {
  const list = getAndClearPendingNotifications();
  if (list.length === 0) return '';
  const lines = list.map(n => `- ${n.text}`);
  return `\n\n【自律監視ループが検知した、前回接続時からの変化】起動時の挨拶の中で、これらを`
    + `聞かれる前に自然な会話の一部として伝えてください（一つずつ読み上げるのではなく、`
    + `簡潔にまとめてOKです。検知の有無自体は事実に基づいていますが、以下の文はあくまで`
    + `簡潔な見出しです）。\n${lines.join('\n')}\n\n【重要】上記についてリスナーから`
    + `「詳しく教えて」「本当に？」のように詳細を聞かれた場合、この見出し文だけを元に`
    + `場所・震度・被害状況などの具体的な詳細を記憶や推測で作文することは絶対にしないで`
    + `ください。必ず対応する機能（天気・地震関連ならget_weather等）を実際に呼び出して`
    + `最新の実データを確認してから答えてください。確認しても該当する詳細が見つからない`
    + `場合は、正直に「詳しい情報がまだ確認できていません」と伝えてください。`;
}

/**
 * 見つけた変化のうち、直近のものだけを Live のディレクター向けの文として返す。
 * ATTENTION: 読んでも消さないこと（挨拶用とは違い、何度も・複数の所から読まれる）。
 * @param {{maxAgeMinutes?: number}} [opts] 何分前までを対象にするか
 * @returns {string} 渡す文（該当が無ければ空文字）
 */
function getRecentLiveSignals({ maxAgeMinutes = 120 } = {}) {
  const feed = readJson(LIVE_SIGNAL_FEED_PATH, []);
  if (feed.length === 0) return '';
  const cutoff = Date.now() - maxAgeMinutes * 60000;
  const recent = feed.filter((s) => new Date(s.detectedAt).getTime() >= cutoff);
  if (recent.length === 0) return '';
  return recent.map((s) => `- ${s.text}`).join('\n');
}

module.exports = {
  tick,
  recordSessionEnded,
  addPendingNotification,
  peekPendingNotificationCount,
  getAndClearPendingNotifications,
  consumePendingNotificationsForPrompt,
  getRecentLiveSignals,
  maybeCreateAutoDailyReport,
  maybeCreateSecretaryActivityReport,
  maybeCreateAutoWeeklyReport,
  maybeRecordWeatherSnapshot,
  DEFAULT_LOOP_CONFIG,
};
