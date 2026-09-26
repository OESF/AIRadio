/**
 * @file 稼働レポート用に、視聴セッションと中の出来事を SQLite に記録し、集計して返す
 *
 * sessions テーブルにチャンネル別の視聴セッション（開始・終了時刻）を、events テーブルに
 * セッション内の出来事（LLM 呼び出し・読み上げ・曲・コーナー・発話・エラー）を1行ずつ残す。
 * 記録は各チャンネルのエージェントシステム・秘書・LLM クライアントから、集計は稼働レポート
 * （report-routes.js）とシステム監視ダッシュボード（dashboard-routes.js）から呼ばれる。
 * コストの概算は lib/gemini-pricing.js の料金表で計算する。
 *
 * 保存先: server/data/activity.db（WAL モード）
 *
 * ATTENTION: 記録の関数は失敗しても例外を投げずログだけ出す。放送を止めないため。
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

const Database = require('better-sqlite3');
const path     = require('path');
const { calcGeminiCostUsd } = require('./lib/gemini-pricing');

const DB_PATH = path.join(__dirname, 'data', 'activity.db');

let _db = null;

/**
 * データベースを開いて返す。初回だけ開き、テーブルを作る。
 * @returns {any} better-sqlite3 の Database
 */
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _initSchema();
  }
  return _db;
}

/**
 * テーブルと索引が無ければ作る。
 * @returns {void}
 */
function _initSchema() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel     TEXT    NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      event_type  TEXT    NOT NULL,
      ts          INTEGER NOT NULL,
      agent       TEXT,
      duration_ms INTEGER,
      chars       INTEGER,
      metadata    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_type    ON events(event_type, ts);
  `);
}

// ─── セッション管理 ────────────────────────────────────────────────────────────

/**
 * 視聴セッションを始める。
 * @param {string} channel チャンネル ID
 * @returns {any} セッション ID（数値）。失敗したら null
 */
function openSession(channel) {
  try {
    const stmt = getDb().prepare(
      'INSERT INTO sessions (channel, started_at) VALUES (?, ?)'
    );
    const info = stmt.run(channel, Date.now());
    return info.lastInsertRowid;
  } catch (e) {
    console.error('[ActivityDB] openSession error:', e.message);
    return null;
  }
}

/**
 * 視聴セッションを終える（終了時刻を書く）。
 * @param {number|bigint|null} sessionId セッション ID。空なら何もしない
 * @returns {void}
 */
function closeSession(sessionId) {
  if (!sessionId) return;
  try {
    getDb().prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  } catch (e) {
    console.error('[ActivityDB] closeSession error:', e.message);
  }
}

// ─── イベント記録 ──────────────────────────────────────────────────────────────

/**
 * セッション内の出来事を1件記録する。セッション ID が無ければ何もしない。
 * @param {number|null} sessionId セッション ID
 * @param {string} eventType 種類。'llm_chat'・'llm_image'・'tts_gemini'・'tts_aivis'・'song_played'・
 *   'corner'・'agent_speaking'・'system_error' など
 * @param {object} [opts]
 * @param {string} [opts.agent] エージェントキー。無ければ裏方の処理として集計する
 * @param {number} [opts.durationMs] API 呼び出しにかかった時間（ミリ秒）
 * @param {number} [opts.chars] テキストの文字数
 * @param {object} [opts.metadata] 追加情報（モデル名・トークン数・曲名など）。JSON にして保存する
 * @returns {void}
 */
function logEvent(sessionId, eventType, opts = {}) {
  if (!sessionId) return;
  try {
    const { agent = null, durationMs = null, chars = null, metadata = null } = opts;
    getDb().prepare(`
      INSERT INTO events (session_id, event_type, ts, agent, duration_ms, chars, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      eventType,
      Date.now(),
      agent,
      durationMs != null ? Math.round(durationMs) : null,
      chars,
      metadata != null ? JSON.stringify(metadata) : null,
    );
  } catch (e) {
    console.error('[ActivityDB] logEvent error:', e.message);
  }
}

// ─── クエリ ────────────────────────────────────────────────────────────────────

/**
 * セッションの一覧を、種類別の件数を付けて新しい順に返す。
 * @param {object} [opts]
 * @param {string} [opts.channel] チャンネル ID。'all' か空なら全チャンネル
 * @param {any} [opts.from] 開始時刻の下限（ミリ秒）
 * @param {any} [opts.to] 開始時刻の上限（ミリ秒）
 * @param {number} [opts.limit] 件数（既定 50）
 * @param {number} [opts.offset] 読み飛ばす件数
 * @returns {{rows: Array<any>, total: number}} 一覧と、条件に合う全件数
 */
function querySessions({ channel, from, to, limit = 50, offset = 0 } = {}) {
  const db     = getDb();
  const conds  = [];
  const params = [];

  if (channel && channel !== 'all') { conds.push('s.channel = ?'); params.push(channel); }
  if (from) { conds.push('s.started_at >= ?'); params.push(Number(from)); }
  if (to)   { conds.push('s.started_at <= ?'); params.push(Number(to)); }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      s.id, s.channel, s.started_at, s.ended_at,
      COUNT(CASE WHEN e.event_type = 'song_played'     THEN 1 END) AS songs,
      COUNT(CASE WHEN e.event_type = 'llm_chat'        THEN 1 END) AS llm_chat,
      COUNT(CASE WHEN e.event_type = 'llm_image'       THEN 1 END) AS llm_image,
      COUNT(CASE WHEN e.event_type = 'tts_gemini'      THEN 1 END) AS tts_gemini,
      COUNT(CASE WHEN e.event_type = 'tts_aivis'       THEN 1 END) AS tts_aivis,
      COUNT(CASE WHEN e.event_type = 'corner'          THEN 1 END) AS corners,
      COUNT(CASE WHEN e.event_type = 'agent_speaking'  THEN 1 END) AS agent_turns,
      COUNT(CASE WHEN e.event_type = 'system_error'    THEN 1 END) AS errors
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    ${where}
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM sessions s ${where}`
  ).get(...params).n;

  return { rows, total };
}

/**
 * セッション1件の詳細（出来事の一覧・集計・コーナー別とエージェント別の件数）を返す。
 * @param {number} sessionId セッション ID
 * @returns {Record<string, any>|null} 見つからなければ null
 */
function querySessionDetail(sessionId) {
  const db = getDb();

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const events = db.prepare(
    'SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC'
  ).all(sessionId);

  const parsedEvents = events.map(e => ({
    ...e,
    metadata: e.metadata ? (() => { try { return JSON.parse(e.metadata); } catch { return null; } })() : null,
  }));

  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN event_type = 'song_played'     THEN 1 END) AS songs,
      COUNT(CASE WHEN event_type = 'llm_chat'        THEN 1 END) AS llm_chat,
      COUNT(CASE WHEN event_type = 'llm_image'       THEN 1 END) AS llm_image,
      COUNT(CASE WHEN event_type = 'tts_gemini'      THEN 1 END) AS tts_gemini,
      COUNT(CASE WHEN event_type = 'tts_aivis'       THEN 1 END) AS tts_aivis,
      COUNT(CASE WHEN event_type = 'corner'          THEN 1 END) AS corners,
      COUNT(CASE WHEN event_type = 'agent_speaking'  THEN 1 END) AS agent_turns,
      COUNT(CASE WHEN event_type = 'system_error'    THEN 1 END) AS errors,
      SUM(CASE WHEN event_type = 'llm_chat'    THEN duration_ms ELSE 0 END) AS llm_chat_ms,
      SUM(CASE WHEN event_type = 'tts_gemini'  THEN duration_ms ELSE 0 END) AS tts_gemini_ms,
      SUM(CASE WHEN event_type = 'tts_aivis'   THEN duration_ms ELSE 0 END) AS tts_aivis_ms,
      SUM(CASE WHEN event_type = 'tts_gemini'  THEN chars ELSE 0 END) AS tts_gemini_chars,
      SUM(CASE WHEN event_type = 'tts_aivis'   THEN chars ELSE 0 END) AS tts_aivis_chars
    FROM events WHERE session_id = ?
  `).get(sessionId);

  // コーナー別内訳（name 別カウント）
  const cornerBreakdown = db.prepare(`
    SELECT json_extract(metadata, '$.name') AS name, COUNT(*) AS cnt
    FROM events
    WHERE session_id = ? AND event_type = 'corner' AND metadata IS NOT NULL
    GROUP BY name ORDER BY cnt DESC
  `).all(sessionId);

  // エージェント別発話回数
  const agentBreakdown = db.prepare(`
    SELECT agent, COUNT(*) AS cnt
    FROM events
    WHERE session_id = ? AND event_type = 'agent_speaking' AND agent IS NOT NULL
    GROUP BY agent ORDER BY cnt DESC
  `).all(sessionId);

  return { session, events: parsedEvents, stats, cornerBreakdown, agentBreakdown };
}

/**
 * 終了時刻が空のまま残ったセッションを、今の時刻で閉じる。サーバーの起動時に呼ぶ。
 *
 * サーバーが止まると切断の処理が呼ばれず、セッションが開いたまま残るため。
 * @returns {void}
 */
function closeOrphanedSessions() {
  try {
    const now = Date.now();
    const info = getDb().prepare(
      'UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL'
    ).run(now);
    if (info.changes > 0) {
      console.warn(`[ActivityDB] 孤立セッション ${info.changes} 件を閉じました (ended_at = ${now})`);
    }
  } catch (e) {
    console.error('[ActivityDB] closeOrphanedSessions error:', e.message);
  }
}

/**
 * 期間とチャンネルで絞った集計（セッション数・視聴時間・種類別の件数・チャンネル別の内訳）を返す。
 *
 * ATTENTION: セッションの集計と出来事の集計は別のクエリにする。1つの JOIN にすると、
 * セッションの行が出来事の数だけ重なり、セッション数と視聴時間が膨らむ。
 * @param {{channel?: string, from?: any, to?: any}} [opts] channel（'all' か空なら全チャンネル）、
 *   from・to（セッション開始時刻の範囲、ミリ秒）
 * @returns {Record<string, any>}
 */
function querySummary({ channel, from, to } = {}) {
  const db     = getDb();
  const conds  = [];
  const params = [];
  if (channel && channel !== 'all') { conds.push('channel = ?'); params.push(channel); }
  if (from) { conds.push('started_at >= ?'); params.push(Number(from)); }
  if (to)   { conds.push('started_at <= ?'); params.push(Number(to)); }
  const sessWhere = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  // ── セッションの集計（JOIN しない）─────────────────────────────────────────
  const now = Date.now();
  const sessStats = db.prepare(`
    SELECT
      COUNT(*)                                              AS total_sessions,
      COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS total_listen_ms
    FROM sessions
    ${sessWhere}
  `).get(now, ...params);

  // ── 出来事の集計（期間の絞り込みのために sessions と JOIN する）─────────────
  const evConds = conds.map(c => `s.${c}`);
  const evWhere = evConds.length ? 'WHERE ' + evConds.join(' AND ') : '';
  const evStats = db.prepare(`
    SELECT
      COUNT(CASE WHEN e.event_type = 'song_played'     THEN 1 END) AS total_songs,
      COUNT(CASE WHEN e.event_type = 'llm_chat'        THEN 1 END) AS total_llm_chat,
      COUNT(CASE WHEN e.event_type = 'llm_image'       THEN 1 END) AS total_llm_image,
      COUNT(CASE WHEN e.event_type = 'tts_gemini'      THEN 1 END) AS total_tts_gemini,
      COUNT(CASE WHEN e.event_type = 'tts_aivis'       THEN 1 END) AS total_tts_aivis,
      COUNT(CASE WHEN e.event_type = 'corner'          THEN 1 END) AS total_corners,
      COUNT(CASE WHEN e.event_type = 'system_error'    THEN 1 END) AS total_errors
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    ${evWhere}
  `).get(...params);

  // ── チャンネル別内訳 ─────────────────────────────────────────────────────────
  const byChannel = db.prepare(`
    SELECT
      channel,
      COUNT(*)                                              AS sessions,
      COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS listen_ms
    FROM sessions
    ${sessWhere}
    GROUP BY channel
    ORDER BY listen_ms DESC
  `).all(now, ...params);

  return { ...sessStats, ...evStats, byChannel };
}

/**
 * Gemini の呼び出し（llm_chat・llm_image・tts_gemini）を、モデル別とエージェント別に集計し、
 * 概算コスト（USD）を付けて返す。
 *
 * metadata の JSON を読む必要があるため、SQL では集計せず行を取り出して JS で足し上げる
 * （個人利用の規模なら行数は問題にならない）。料金表に無いモデルは costUnknown を立てる。
 * @param {{channel?: string, from?: any, to?: any}} [opts] channel（'all' か空なら全チャンネル）、
 *   from・to（セッション開始時刻の範囲、ミリ秒）
 * @returns {{byModel: Array<any>, byAgent: Array<any>}} どちらもコストの高い順
 */
function queryCostBreakdown({ channel, from, to } = {}) {
  const db     = getDb();
  const conds  = ["e.event_type IN ('llm_chat', 'llm_image', 'tts_gemini')"];
  const params = [];
  if (channel && channel !== 'all') { conds.push('s.channel = ?'); params.push(channel); }
  if (from) { conds.push('s.started_at >= ?'); params.push(Number(from)); }
  if (to)   { conds.push('s.started_at <= ?'); params.push(Number(to)); }
  const where = 'WHERE ' + conds.join(' AND ');

  const rows = db.prepare(`
    SELECT e.event_type, e.agent, e.metadata
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    ${where}
  `).all(...params);

  const byModel = new Map();
  const byAgent = new Map();
  const bump = (map, key, eventType, usage, costUsd, fallbackLabel) => {
    const k = key || fallbackLabel;
    if (!map.has(k)) {
      map.set(k, {
        key: k, count: 0, llmCount: 0, ttsCount: 0,
        promptTokens: 0, outputTokens: 0, thoughtsTokens: 0,
        costUsd: 0, costUnknown: false,
      });
    }
    const row = map.get(k);
    row.count += 1;
    if (eventType === 'tts_gemini') row.ttsCount += 1; else row.llmCount += 1;
    row.promptTokens   += usage.promptTokens   ?? 0;
    row.outputTokens    += usage.outputTokens   ?? 0;
    row.thoughtsTokens += usage.thoughtsTokens ?? 0;
    if (costUsd == null) row.costUnknown = true;
    else row.costUsd += costUsd;
  };

  for (const row of rows) {
    let metadata = null;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch { /* ignore */ }
    const model = metadata?.model ?? null;
    const usage = {
      promptTokens: metadata?.promptTokens ?? null,
      outputTokens: metadata?.outputTokens ?? null,
      thoughtsTokens: metadata?.thoughtsTokens ?? null,
      // 入出力の種類（テキスト・音声・画像）で単価が違うモデル（Live API など）用。無ければ計算で無視される
      promptTextTokens: metadata?.promptTextTokens,
      promptAudioTokens: metadata?.promptAudioTokens,
      promptImageTokens: metadata?.promptImageTokens,
      outputTextTokens: metadata?.outputTextTokens,
      outputAudioTokens: metadata?.outputAudioTokens,
    };
    const costUsd = model ? calcGeminiCostUsd(model, usage) : null;
    bump(byModel, model, row.event_type, usage, costUsd, '(不明)');
    // エージェントの無い呼び出し（セッションの要約・ディレクターの判断・レシピの抽出など、
    // 特定の人物に結びつかない裏方の処理）は 'backstage' にまとめる
    bump(byAgent, row.agent, row.event_type, usage, costUsd, 'backstage');
  }

  const toSortedArray = map => Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd);
  return { byModel: toSortedArray(byModel), byAgent: toSortedArray(byAgent) };
}

/**
 * 日ごと・モデル別の概算コストを返す。コストグラフ（積み上げの棒グラフ）用。
 *
 * ATTENTION: 日付は出来事の時刻（events.ts）で分ける。queryCostBreakdown のようにセッションの
 * 開始時刻で分けると、24時間放送では1つのセッションが日をまたぐため、その日の出費がずれる。
 * 日付の境目はサーバーのローカル時刻（日本時間）。UTC で切ると朝9時より前が前日になる。
 *
 * @param {{days?: number}} [opts] さかのぼる日数（既定 30・最大 180）
 * @returns {{days: Array<{date: string, total: number, costUnknown: boolean,
 *   byModel: Object<string, number>, count: number}>, models: string[], total: number,
 *   costUnknown: boolean}} days は出来事の無い日も含む。models は期間全体のコストの高い順で、
 *   グラフを積み上げる順に使う
 */
function queryDailyCost({ days = 30 } = {}) {
  const nDays = Math.min(Math.max(1, Number(days) || 30), 180);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (nDays - 1));
  const from = start.getTime();

  const rows = getDb().prepare(`
    SELECT ts, event_type, metadata FROM events
    WHERE event_type IN ('llm_chat', 'llm_image', 'tts_gemini') AND ts >= ?
  `).all(from);

  const localDate = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // 空の日も棒として並べたいので、先に全日分の器を作る
  const buckets = new Map();
  for (let i = 0; i < nDays; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    buckets.set(localDate(d.getTime()), { date: localDate(d.getTime()), total: 0, costUnknown: false, byModel: {}, count: 0 });
  }

  const modelTotals = new Map();
  for (const row of rows) {
    const b = buckets.get(localDate(row.ts));
    if (!b) continue;
    let metadata = null;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch { /* ignore */ }
    const model = metadata?.model ?? null;
    const usage = {
      promptTokens: metadata?.promptTokens ?? null,
      outputTokens: metadata?.outputTokens ?? null,
      thoughtsTokens: metadata?.thoughtsTokens ?? null,
      promptTextTokens: metadata?.promptTextTokens,
      promptAudioTokens: metadata?.promptAudioTokens,
      promptImageTokens: metadata?.promptImageTokens,
      outputTextTokens: metadata?.outputTextTokens,
      outputAudioTokens: metadata?.outputAudioTokens,
    };
    const costUsd = model ? calcGeminiCostUsd(model, usage) : null;
    b.count += 1;
    if (costUsd == null) { b.costUnknown = true; continue; }
    const key = model || '(不明)';
    b.byModel[key] = (b.byModel[key] || 0) + costUsd;
    b.total += costUsd;
    modelTotals.set(key, (modelTotals.get(key) || 0) + costUsd);
  }

  const daysArr = [...buckets.values()];
  return {
    days: daysArr,
    models: [...modelTotals.entries()].sort((a, b2) => b2[1] - a[1]).map(([m]) => m),
    total: daysArr.reduce((sum, d) => sum + d.total, 0),
    costUnknown: daysArr.some((d) => d.costUnknown),
  };
}

/**
 * 期間内の視聴の傾向（チャンネル別の視聴時間・週ごとの推移・よく流れた曲とコーナー）を返す。
 * システム監視ダッシュボード（/dashboard）の統計の表示用。
 *
 * 稼働レポートの集計がコストと処理量を見るのに対し、こちらは何がどれだけ聴かれたかを見る。
 * 行を取り出して JS で集計する（数千行程度で、週ごとの区切りは SQL の日付計算より読みやすいため）。
 *
 * @param {{from?:number, to?:number, bucketDays?:number, trackLimit?:number}} [opts]
 *   from・to（セッション開始時刻の範囲、ミリ秒）、bucketDays（推移の1区切りの日数、既定 7）、
 *   trackLimit（曲の上位の件数、既定 12）
 * @returns {Record<string, any>}
 */
function queryListeningStats({ from, to, bucketDays = 7, trackLimit = 12 } = {}) {
  const db = getDb();
  const now = Date.now();
  const conds = [];
  const params = [];
  if (from) { conds.push('started_at >= ?'); params.push(Number(from)); }
  if (to)   { conds.push('started_at <= ?'); params.push(Number(to)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const sessions = db.prepare(
    `SELECT id, channel, started_at, ended_at FROM sessions ${where} ORDER BY started_at`
  ).all(...params);

  const evWhere = conds.length ? 'WHERE ' + conds.map(c => `s.${c}`).join(' AND ') : '';
  const songRows = db.prepare(
    `SELECT s.channel AS channel, e.metadata AS metadata
       FROM events e JOIN sessions s ON s.id = e.session_id
      ${evWhere}${evWhere ? ' AND' : 'WHERE'} e.event_type = 'song_played'`
  ).all(...params);
  const cornerRows = db.prepare(
    `SELECT e.metadata AS metadata
       FROM events e JOIN sessions s ON s.id = e.session_id
      ${evWhere}${evWhere ? ' AND' : 'WHERE'} e.event_type = 'corner'`
  ).all(...params);

  // ── チャンネル別の合計（セッション数・視聴時間）──────────────────────────
  // 進行中のセッションは今の時刻までを視聴時間とする。閉じられずに残った異常に長い
  // セッション（プロセスが落ちたときなど）は6時間で打ち切る
  const MAX_SESSION_MS = 6 * 3600 * 1000;
  const channels = {};
  const buckets = new Map();
  const bucketMs = bucketDays * 86400000;
  const origin = sessions.length ? sessions[0].started_at : now;
  for (const r of sessions) {
    const ms = Math.min(Math.max(0, (r.ended_at ?? now) - r.started_at), MAX_SESSION_MS);
    const ch = r.channel;
    (channels[ch] ??= { channel: ch, sessions: 0, listenMs: 0, songs: 0 });
    channels[ch].sessions += 1;
    channels[ch].listenMs += ms;

    const bIdx = Math.floor((r.started_at - origin) / bucketMs);
    const bStart = origin + bIdx * bucketMs;
    if (!buckets.has(bStart)) buckets.set(bStart, { start: bStart, byChannel: {} });
    const b = buckets.get(bStart).byChannel;
    (b[ch] ??= { sessions: 0, listenMs: 0 });
    b[ch].sessions += 1;
    b[ch].listenMs += ms;
  }

  // ── 曲（何がどれだけ流れたか）────────────────────────────────────────────
  const trackCounts = new Map();
  for (const r of songRows) {
    let m; try { m = JSON.parse(r.metadata || '{}'); } catch { continue; }
    const title = (m.title || '').trim();
    if (!title) continue;
    const artist = (m.artist || m.composer || '').trim();
    (channels[r.channel] ??= { channel: r.channel, sessions: 0, listenMs: 0, songs: 0 }).songs += 1;
    const key = `${title}\u0000${artist}`;
    const hit = trackCounts.get(key) || { title, artist, count: 0, channels: new Set() };
    hit.count += 1;
    hit.channels.add(r.channel);
    trackCounts.set(key, hit);
  }
  const topTracks = [...trackCounts.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, trackLimit)
    .map(t => ({ title: t.title, artist: t.artist, count: t.count, channels: [...t.channels] }));

  // ── コーナー（Live で何が何回流れたか）─────────────────────────────────
  const cornerCounts = {};
  for (const r of cornerRows) {
    let m; try { m = JSON.parse(r.metadata || '{}'); } catch { continue; }
    const name = (m.name || '').trim();
    if (!name) continue;
    cornerCounts[name] = (cornerCounts[name] || 0) + 1;
  }
  const topCorners = Object.entries(cornerCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));

  return {
    channels: Object.values(channels).sort((a, b) => b.listenMs - a.listenMs),
    trend: [...buckets.values()].sort((a, b) => a.start - b.start),
    bucketDays,
    topTracks,
    topCorners,
    totalSessions: sessions.length,
    totalSongs: songRows.length,
  };
}

module.exports = { openSession, closeSession, closeOrphanedSessions, logEvent, querySessions, querySessionDetail, querySummary, queryCostBreakdown, queryDailyCost, queryListeningStats };
