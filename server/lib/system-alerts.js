/**
 * @file システムの異常（AI の残高切れなど）を判定して、必ずメイン画面へ出すための集約点
 *
 * Gemini の残高が尽きると、放送も秘書も日報も止まる。LINE は見ていないことがあるので、必ず見るメイン画面
 * （ウェルカム画面を含む）に出す。LINE から依頼したときは、「システムエラー」ではなく理由まで返す。
 *
 * 異常の判定と配信をここに集める。呼び出し側（llm-client・tts-client・live-client・LINE など）は
 * report(err, { source }) を呼ぶだけでよく、どういう異常か・誰にどう伝えるかを各所で書き分けない。
 * 配信は /notifications の WebSocket（ページを開いた時点でつながるので、ウェルカム画面でも受け取れる）に載せる。
 *
 * WebSocket の配信は、そのときつながっている画面にしか届かない。異常が起きたあとに開いた画面でも見えるよう、
 * 今の異常をメモリに持ち、GET /api/system-alerts で取れるようにしている。
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

const { getLogger } = require('../logger');

/**
 * 異常の種類。severity は画面での出し方（critical は消えない赤い帯、warning は控えめ）。
 * userMessage は、LINE などでリスナーにそのまま返せる文。
 */
const ALERT_KINDS = {
  billing: {
    severity: 'critical',
    title: 'AIの利用料金の残高が不足しています',
    detail: 'Gemini APIのプリペイド残高が尽きたため、放送の原稿生成・音声合成・Secretary・'
      + 'デイリーノートなど、AIを使う機能がすべて停止しています。'
      + 'Google AI Studio（https://ai.studio/projects）で入金すると自動的に復旧します。',
    userMessage: '申し訳ありません。AIの利用料金の残高が不足しているため、いま処理ができません。'
      + 'Google AI Studioでの入金が必要です。',
  },
  rate_limit: {
    severity: 'warning',
    title: 'AIの利用が一時的に制限されています',
    detail: '短時間に呼び出しが集中したため、APIのレート制限に達しました。'
      + 'しばらく待つと自動的に復旧します。',
    userMessage: '申し訳ありません。いまAIの利用が混み合っていて処理ができませんでした。'
      + '少し時間をおいてもう一度お願いします。',
  },
  auth: {
    severity: 'critical',
    title: 'AIのAPIキーが無効です',
    detail: 'APIキーが拒否されました。管理画面の認証情報でGemini APIキーを確認してください。',
    userMessage: '申し訳ありません。AIのAPIキーに問題があるため処理ができません。設定の確認が必要です。',
  },
  service_unavailable: {
    severity: 'warning',
    title: 'AIのサービスが応答していません',
    detail: 'Gemini API側が一時的に応答不能（5xx）です。通常は自動的に復旧します。',
    userMessage: '申し訳ありません。AI側が一時的に応答していないため処理できませんでした。'
      + '少し時間をおいてもう一度お願いします。',
  },
};

/**
 * 今起きている異常（ALERT_KINDS のキー → 異常）。
 */
const _active = new Map();

/**
 * 一時的な異常（Gemini 側の不調・レート制限）を、失敗が止んでから自動で解消とみなすまでの時間（ミリ秒）。
 *
 * BUGFIX: 解消の合図を「次の呼び出しの成功」だけにしていると、リスナーのいない時間帯は呼び出しがほとんど無いので、
 *         一度の不調で出た警告がメイン画面に残り続け、消すために再起動するしかなかった。この種類の異常は待てば直るので、
 *         この時間だけ新しい失敗が無ければ解消として画面から消す。残高切れ・API キーの不正は待っても直らないので対象外。
 */
const TRANSIENT_QUIET_MS = 3 * 60 * 1000;
const TRANSIENT_KINDS = new Set(['service_unavailable', 'rate_limit']);

/**
 * 一時的な異常の自動解消のタイマー（ALERT_KINDS のキー → タイマー）。
 */
const _quietTimers = new Map();

/**
 * 配信する関数（server.js が起動時に登録する。未登録でも例外にしない）。
 */
let _broadcaster = null;

/**
 * 配信する関数（全チャンネルと /notifications へ送る）を登録する。
 * @param {Function} fn
 */
function setBroadcaster(fn) { _broadcaster = typeof fn === 'function' ? fn : null; }

/**
 * 例外から異常の種類を判定する。
 *
 * ATTENTION: 残高切れとレート制限は、どちらも 429 / RESOURCE_EXHAUSTED で返るので、状態の文字列だけで
 *            判定しないこと。Gemini の SDK は応答の JSON をそのまま e.message に入れて投げてくるので、本文も見る
 *            （例: "Your prepayment credits are depleted..."）。
 * @param {any} err
 * @returns {string|null} ALERT_KINDS のキー。判定できなければ null（通知しない）
 */
function classify(err) {
  if (!err) return null;
  const raw = typeof err === 'string' ? err : (err.message || '');
  const text = String(raw);
  const lower = text.toLowerCase();

  let code = null;
  const m = text.match(/"code"\s*:\s*(\d{3})/) || text.match(/\b(4\d{2}|5\d{2})\b/);
  if (m) code = Number(m[1]);
  if (err && typeof err.status === 'number') code = err.status;

  if (/prepay|prepayment credits|billing|quota.*exceeded.*billing|free tier/.test(lower)
      && !/rate limit/.test(lower)) {
    // 残高切れは待っても直らない（入金するまで全部止まる）ので critical
    if (/prepay|billing/.test(lower)) return 'billing';
  }
  if (code === 429) {
    // 429 は残高切れとレート制限の両方で返るので、本文で分ける
    return /prepay|credits are depleted|billing/.test(lower) ? 'billing' : 'rate_limit';
  }
  if (code === 401 || code === 403 || /api key not valid|api_key_invalid|permission denied/.test(lower)) {
    return 'auth';
  }
  if (code && code >= 500) return 'service_unavailable';
  return null;
}

/**
 * 異常を記録し、必要なら画面へ配信する。
 *
 * 同じ異常が続く間は最初の1回だけ配信し、あとは件数を数えるだけにする（放送は数秒おきに LLM を
 * 呼ぶので、毎回配信すると通知であふれる）。
 * @param {any} err
 * @param {{source?: string}} [opts] source はどこで起きたか（ログ用）
 * @returns {Record<string, any>|null} 異常の内容。判定できなければ null（呼び出し側は普段のエラー処理を続ける）
 */
function report(err, { source = 'unknown' } = {}) {
  const kind = classify(err);
  if (!kind) return null;
  const spec = ALERT_KINDS[kind];
  const now = Date.now();
  const prev = _active.get(kind);
  const alert = {
    kind, ...spec,
    since: prev?.since || now,
    lastSeen: now,
    count: (prev?.count || 0) + 1,
    sources: [...new Set([...(prev?.sources || []), source])],
  };
  _active.set(kind, alert);

  // 一時的な異常は、失敗が続く間はタイマーを延ばし、止んだら自動で消す
  if (TRANSIENT_KINDS.has(kind)) {
    clearTimeout(_quietTimers.get(kind));
    const timer = setTimeout(() => {
      _quietTimers.delete(kind);
      clear(kind);
    }, TRANSIENT_QUIET_MS);
    if (typeof timer.unref === 'function') timer.unref();   // このタイマーだけでプロセスを生かし続けない
    _quietTimers.set(kind, timer);
  }

  if (!prev) {
    getLogger().error(`[SystemAlert] ${spec.title}（検知元: ${source}）— メイン画面へ通知します`);
    if (_broadcaster) {
      try { _broadcaster({ event: 'SYSTEM_ALERT', ts: now, alert: _publicShape(alert) }); }
      catch (e) { getLogger().warn(`[SystemAlert] 配信に失敗: ${e.message}`); }
    }
  }
  return alert;
}

/**
 * 異常が直ったことを記録し、画面から消す。
 * @param {string} kind
 */
function clear(kind) {
  clearTimeout(_quietTimers.get(kind));
  _quietTimers.delete(kind);
  if (!_active.has(kind)) return;
  const alert = _active.get(kind);
  _active.delete(kind);
  getLogger().info(`[SystemAlert] 解消: ${alert.title}（${alert.count}回発生）`);
  if (_broadcaster) {
    try { _broadcaster({ event: 'SYSTEM_ALERT_CLEARED', ts: Date.now(), kind }); }
    catch { /* 配信失敗は無視 */ }
  }
}

/**
 * LLM・TTS の呼び出しが成功したときに呼ぶ。成功すれば直ったと言える種類の異常を消す
 * （入金すれば次の呼び出しが通るので、それが最も確かな「直った」の合図）。
 */
function reportSuccess() {
  for (const kind of ['billing', 'rate_limit', 'service_unavailable', 'auth']) clear(kind);
}

/**
 * 画面に送る形にする（内部だけの項目を除く）。
 * @param {Record<string, any>} a
 * @returns {object}
 */
function _publicShape(a) {
  return {
    kind: a.kind, severity: a.severity, title: a.title, detail: a.detail,
    since: a.since, lastSeen: a.lastSeen, count: a.count,
  };
}

/**
 * 今の異常の一覧（重いものから）。GET /api/system-alerts が返す。
 * @returns {object[]}
 */
function getActive() {
  return [..._active.values()]
    .sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1))
    .map(_publicShape);
}

/**
 * 待ってやり直せば通る見込みのある失敗か（Gemini 側の 5xx と、通信の一時的な失敗）。
 * llm-client.js が、この場合だけ少し待ってやり直す。
 *
 * ATTENTION: 残高切れ・API キーの不正・レート制限（429）は含めないこと。前の2つはやり直しても通らず、
 *            レート制限はやり直すと呼び出しがさらに集中する。
 * @param {any} err
 * @returns {boolean} やり直してよい失敗なら true
 */
function isRetryable(err) {
  if (classify(err) === 'service_unavailable') return true;
  const text = String((err && (err.message || err.code)) || err || '').toLowerCase();
  return /fetch failed|econnreset|etimedout|eai_again|socket hang up|network/.test(text);
}

/**
 * リスナーにそのまま返せる文を返す（LINE の返信・秘書の応答用）。
 * @param {any} err
 * @returns {string|null} 判定できなければ null（呼び出し側はいつもの文にする）
 */
function userMessageFor(err) {
  const kind = classify(err);
  return kind ? ALERT_KINDS[kind].userMessage : null;
}

module.exports = {
  ALERT_KINDS, setBroadcaster, classify, report, clear, reportSuccess, getActive, userMessageFor, isRetryable,
  TRANSIENT_QUIET_MS,
};
