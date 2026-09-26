/**
 * @file Secretary の会話と放送の記録の参照、番組へのリクエストのツール
 *
 * Secretary のツールのうち、次の3つの宣言とハンドラ。
 * - get_secretary_history: 秘書とリスナーの過去のやり取り（音声・LINE をまたいで）を読む
 * - get_broadcast_history: 今どのチャンネルが放送中かと、放送で流れた発言・曲を読む
 * - request_show_content: 番組（Live・Classic・Jazz・Mood・Beatles）へリクエストを送る
 *
 * 音声（Gemini Live）と LINE は内部では別の経路だが、リスナーから見れば同じ秘書なので、経路をまたいで
 * 過去のやり取りを参照できるようにしている。ツールの一覧は secretary-tool-declarations.js にまとまっていて
 * LINE も使うので、音声から LINE の、LINE から音声の履歴の両方が読める。
 *
 * ATTENTION: 読めるのは「秘書とのやり取り」だけで、他人との LINE のトークではない（LINE の API は公式
 * アカウント宛のメッセージしか渡さない）。ツールの説明文でもそう伝えている。
 *
 * 記録は server/data/conversation_history.jsonl（放送のエージェントと秘書の発言がすべて入る）と、
 * 音楽チャンネルの played_tracks.json から読む。
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

const fs = require('fs');
const { writeJsonFile } = require('./atomic-json');
const path = require('path');
const { wrapDataForSpeechGuidance } = require('./secretary-tools-services');
const { getLogger } = require('../logger');

// 放送・秘書の発言がすべて入る会話の記録（管理画面の「会話履歴」タブと同じファイル。server.js・
// agent-system.js・channel-base.js の CONV_HISTORY_PATH と同じ場所）
const CONV_HISTORY_PATH = path.join(__dirname, '..', 'data', 'conversation_history.jsonl');

// ── 音楽チャンネルの再生の履歴 ───────────────────────────────────────
// 会話の記録（ナレーションの文）からだけでは曲名やアーティスト名が不正確になりうるので、
// AI Radio 管理人（text-command-routes.js の buildBroadcastContext）と同じ played_tracks.json も材料にする。
const DATA_DIR = path.join(__dirname, '..', 'data');
const CHANNEL_PLAYED_PATHS = {
  classic: path.join(DATA_DIR, 'channels', 'classic', 'played_tracks.json'),
  jazz:    path.join(DATA_DIR, 'channels', 'jazz',    'played_tracks.json'),
  mood:    path.join(DATA_DIR, 'channels', 'mood',    'played_tracks.json'),
  beatles: path.join(DATA_DIR, 'channels', 'beatles', 'played_tracks.json'),
};

/**
 * 再生の履歴の1件を「- 時刻 曲」の1行にする（text-command-routes.js の summarizePlayedEntry と同じ考え方）。
 *
 * @param {Record<string, any>} entry 再生の履歴の1件
 * @returns {string} 1行
 */
function _summarizePlayedEntry(entry) {
  const label = entry.composer && entry.composition
    ? `${entry.composer}「${entry.composition}」`
    : entry.artist && entry.title
      ? `${entry.artist} - ${entry.title}`
      : entry.title || entry.trackName || '(不明な曲)';
  return `- ${_formatTime(entry.playedAt)} ${label}`;
}

/**
 * チャンネルで実際に流れた曲の一覧（新しい順）を返す。Spotify で見つからなかった曲は除く。
 *
 * @param {*} channel チャンネル（classic・jazz・mood・beatles）
 * @param {number} [count] 件数（既定15）
 * @returns {string} 曲の一覧（対象外・記録なしなら空文字）
 */
function readPlayedTracksSummary(channel, count = 15) {
  const p = CHANNEL_PLAYED_PATHS[channel];
  if (!p || !fs.existsSync(p)) return '';
  try {
    const played = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(played) || played.length === 0) return '';
    // played_tracks.json は新しい順（先頭が最新）に保存されている（buildBroadcastContext と同じ前提）
    return played.filter(e => !e.spotifyFailed).slice(0, count).map(_summarizePlayedEntry).join('\n');
  } catch (e) {
    getLogger().warn(`[Secretary] played_tracks.json読み込み失敗(${channel}): ${e.message}`);
    return '';
  }
}

// ── 番組へのリクエストの送信 ──────────────────────────────────────────
// AI Radio 管理人の content_request と同じ経路を使う。
// - Live: config.show.current_instruction への書き込み（live-control-routes.js の POST /api/direction と同じ）
// - Classic・Jazz・Mood・Beatles: 動いているチャンネルの handleListenerRequest()（Spotify で探してすぐキューの
//   先頭に入れる。channel-api.js の POST /api/<channel>/listener-request と同じ）
// 後者は動いているインスタンスでしか呼べないので、ctx.getChannelSystem でチャンネル名から受け取る。
// 取れないときは、handleListenerRequest が解析に失敗したときと同じく config.program.listener_request へ
// 直接書き込み、どの経路でも必ず届くようにする。
const LIVE_CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CHANNEL_CONFIG_PATHS = {
  classic: path.join(DATA_DIR, 'channels', 'classic', 'config.json'),
  jazz:    path.join(DATA_DIR, 'channels', 'jazz',    'config.json'),
  mood:    path.join(DATA_DIR, 'channels', 'mood',    'config.json'),
  beatles: path.join(DATA_DIR, 'channels', 'beatles', 'config.json'),
};
const REQUESTABLE_CHANNELS = { live: 'AI Radio Live', classic: '静寂のスコア',
  jazz: '琥珀色のインプロヴィゼーション', mood: 'トワイライト・ラウンジ', beatles: 'Eight Days A Week' };

/**
 * リクエストを config.json へ直接書き込む（動いているインスタンスが取れないときの代わりの経路）。
 *
 * @param {*} channel チャンネル（live・classic・jazz・mood・beatles）
 * @param {string} text リクエストの内容
 * @returns {boolean} 書き込めたら true
 */
function _writeShowRequestFallback(channel, text) {
  const configPath = channel === 'live' ? LIVE_CONFIG_PATH : CHANNEL_CONFIG_PATHS[channel];
  if (!configPath || !fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (channel === 'live') {
      config.show = config.show || {};
      config.show.current_instruction = `リスナーからのリクエスト: ${text}`;
    } else {
      config.program = config.program || {};
      config.program.listener_request = text;
    }
    writeJsonFile(configPath, config);
    return true;
  } catch (e) {
    getLogger().warn(`[Secretary] request_show_content フォールバック書き込み失敗(${channel}): ${e.message}`);
    return false;
  }
}

/**
 * 番組へリクエストを送る。動いているインスタンスが取れればそちらを使う。
 *
 * @param {string} channel チャンネル（live・classic・jazz・mood・beatles）
 * @param {string} text リクエストの内容
 * @param {Function} [getChannelSystem] チャンネル名から動いているエージェントシステムを返す関数
 * @returns {boolean} 送れたら true
 */
function sendShowRequest(channel, text, getChannelSystem) {
  const sys = typeof getChannelSystem === 'function' ? getChannelSystem(channel) : null;
  if (channel === 'live') {
    // Live は config.show.current_instruction へ書き込むだけで済む（agent-system.js の getConfig() は毎回
    // ディスクから読み直すので、インスタンス経由でも直接の書き込みでも同じ）
    const ok = _writeShowRequestFallback('live', text);
    // 管理人の content_request と同じく、音楽のキーワードがあればすぐ音楽DJのコーナーをキューに入れる
    // （インスタンスが取れるときだけの追加の効き目で、無くても動く）
    if (sys && typeof sys._instantMusicRequestIfDetected === 'function') {
      sys._instantMusicRequestIfDetected(text);
    }
    return ok;
  }
  if (sys && typeof sys.handleListenerRequest === 'function') {
    sys.handleListenerRequest(text);
    return true;
  }
  // 動いているインスタンスが取れないときの代わり。Spotify での解析はされず、次のセッションの企画のときに
  // 話題として反映される（handleListenerRequest が解析に失敗したときと同じ経路）。
  return _writeShowRequestFallback(channel, text);
}

// 会話の記録での、経路ごとの agentKey（音声は secretary-live-routes.js、LINE は secretary-line.js が書き込む）
const CHANNEL_KEYS = {
  voice: { user: 'secretary_user',      secretary: 'secretary',      label: '音声' },
  line:  { user: 'secretary_line_user', secretary: 'secretary_line', label: 'LINE' },
};

// ── 放送の発言の見分け方 ──────────────────────────────────────────────
// 秘書も放送を「聴いて」いられるよう、会話の記録から放送の発言を読めるようにする。
// ATTENTION: 放送側の agentKey を並べるのではなく「秘書のもの以外すべて」と決めること。エージェントが増えても
// 自動で放送側として扱われ、書き足し忘れが起きない（一覧を並べる方式は、更新し忘れて誤答した前例がある）。
const SECRETARY_AGENT_KEYS = new Set(
  Object.values(CHANNEL_KEYS).flatMap((v) => [v.user, v.secretary]),
);

/**
 * agentKey から、その発言が流れたチャンネルの表示名を決める（The Answers のパネリストは、出演元の
 * チャンネル名を前に付けた poolKey で記録される）。
 *
 * @param {string} agentKey 発言したエージェントのキー
 * @returns {string|undefined} チャンネルの表示名
 */
function _broadcastChannelOf(agentKey) {
  // The Answersのパネリストは出演元チャンネル名を前置したpoolKey（live_commentator等）
  if (/^(live|classic|jazz|mood|beatles)_/.test(agentKey) && !/_(personality|director)$/.test(agentKey)) {
    return 'The Answers';
  }
  const m = agentKey.match(/^(classic|jazz|mood|beatles)_(personality|director)$/);
  if (m) return { classic: '静寂のスコア', jazz: '琥珀色のインプロヴィゼーション',
                  mood: 'トワイライト・ラウンジ', beatles: 'Eight Days A Week' }[m[1]];
  return 'AI Radio Live';
}

/** get_broadcast_history で指定できるチャンネル → 表示名。 */
const BROADCAST_CHANNEL_FILTERS = {
  live: 'AI Radio Live', classic: '静寂のスコア', jazz: '琥珀色のインプロヴィゼーション',
  mood: 'トワイライト・ラウンジ', beatles: 'Eight Days A Week', the_answers: 'The Answers',
};

/**
 * 今放送中のチャンネルを、動いているインスタンスに聞いて調べる。
 *
 * 放送中とは「番組のループが動いていて、かつそのチャンネルにリスナーが接続している」こと。
 * 確かめられないチャンネル（インスタンスや接続数が取れない）は判定から外し、「放送中」と言い切らない
 * （誤って「放送中です」と言う方が害が大きい）。
 *
 * BUGFIX: 会話の記録を読むだけだったころは、何も放送していないのに、数時間前に終わった放送を今も続いている
 * ものとして答えていた。
 * BUGFIX: isLoopRunning だけでは判定しない。番組のループはサーバーが動いている間ずっと回り、リスナーが
 * 全員抜けても下りないので、ウェルカム画面に戻った後も「放送中」と判定されていた。
 *
 * @param {Function} [getChannelSystem] チャンネル名から動いているエージェントシステムを返す関数
 * @returns {{onAir: string[], offAir: string[]}|null} 放送中・停止中のチャンネル（確かめられなければ null）
 */
function readOnAirStatus(getChannelSystem) {
  if (typeof getChannelSystem !== 'function') return null;
  const onAir = [];
  const offAir = [];
  for (const [key, label] of Object.entries(BROADCAST_CHANNEL_FILTERS)) {
    let sys = null;
    try { sys = getChannelSystem(key); } catch { sys = null; }
    if (!sys) continue;                       // 実体が引けないチャンネルは判定対象から外す
    // リスナーの接続数も見る（上の BUGFIX 参照）。接続数を取れないチャンネルは判定から外す
    const listeners = typeof sys.server?.getClientCount === 'function' ? sys.server.getClientCount() : null;
    if (listeners === null) continue;
    ((sys.isLoopRunning && listeners > 0) ? onAir : offAir).push(label);
  }
  if (onAir.length === 0 && offAir.length === 0) return null;
  return { onAir, offAir };
}

/**
 * 放送の状況を、モデルが読み違えようのない文にする。
 *
 * @param {{onAir: string[], offAir: string[]}|null} status 放送中・停止中のチャンネル（不明なら null）
 * @param {number|null} lastEntryTime 記録の最後の発言の時刻（ミリ秒）
 * @returns {string} 放送の状況の文
 */
function formatOnAirStatus(status, lastEntryTime) {
  if (!status) {
    // BUGFIX: 確かめられないときも、その旨をはっきり書く。何も書かないと、記録の最後が Live だったときに
    // モデルが「今も放送中」と答えていた。
    return '【現在の放送状況】今どのチャンネルが放送中かは確認できませんでした。'
      + '以下は**過去の放送の記録**です。「今どんな番組をやっている？」と聞かれても、'
      + '今放送中だと断定せず、「直近ではこういう放送がありました」という形で答えてください。\n';
  }
  const now = Date.now();
  const nowText = new Date(now).toLocaleString('ja-JP', { hour12: false });
  let head;
  if (status.onAir.length > 0) {
    head = `【現在の放送状況】${nowText}時点で、${status.onAir.join('・')}が放送中です。`;
  } else {
    head = `【現在の放送状況】${nowText}時点で、**放送中のチャンネルはありません**`
      + `（${status.offAir.join('・')}はいずれも停止中です）。`
      + `「今どんな番組をやっている？」と聞かれたら、放送は行われていないと正直に答えてください。`
      + `以下の記録は**すでに終わった過去の放送**であり、現在進行中の番組ではありません。`
      + `これを今放送されているものとして説明しないでください。`;
  }
  if (lastEntryTime) {
    const mins = Math.round((now - lastEntryTime) / 60000);
    const ago = mins < 60 ? `${mins}分前` : `${Math.floor(mins / 60)}時間${mins % 60}分前`;
    head += `\n（記録に残っている最後の発言は${ago}のものです。）`;
  }
  return `${head}\n\n`;
}

/**
 * 放送で流れた発言を、新しい方から count 件取り出す（返す配列は古い順）。秘書とのやり取りは除く。
 *
 * @param {{channel?: any, count?: number}} [opts] チャンネル（all なら全部）と件数（最大 MAX_COUNT）
 * @returns {Array<Record<string, any>>} 発言（time・channel・agentName・text）
 */
function readBroadcastHistory({ channel = 'all', count = DEFAULT_COUNT } = {}) {
  if (!fs.existsSync(CONV_HISTORY_PATH)) return [];
  const wantChannel = BROADCAST_CHANNEL_FILTERS[channel] || null;
  const entries = [];
  for (const line of fs.readFileSync(CONV_HISTORY_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const key = obj.agentKey;
    if (!key || SECRETARY_AGENT_KEYS.has(key)) continue;
    const ch = _broadcastChannelOf(key);
    if (wantChannel && ch !== wantChannel) continue;
    entries.push({ time: obj.time, channel: ch, agentName: obj.agentName || key, text: String(obj.text ?? '') });
  }
  return entries.slice(-Math.min(Math.max(1, count), MAX_COUNT));
}

/** さかのぼる発言の数の既定と上限。 */
const DEFAULT_COUNT = 20;
const MAX_COUNT = 60;
// 1つの発言で渡す最大の文字数。LINE の返信は長くなりがちで、全部渡すとモデルのコンテキストを圧迫するので、
// 頭だけ渡す（何を頼んだかを思い出すには足りる）。
const MAX_TEXT_LEN = 200;

/**
 * 会話の記録から、秘書とのやり取りだけを新しい方から count 件取り出す（返す配列は古い順）。
 * ファイル全体を読んでから絞る素朴な作りだが、ファイルは2000行で入れ替わるので問題ない
 * （secretary-line.js の _readRecentLineHistory と同じ判断）。
 *
 * @param {{channel?: string, count?: number}} [opts] 経路（'voice'・'line'・'all'）と件数（最大 MAX_COUNT）
 * @returns {Array<Record<string, any>>} やり取り（time・text・channel・role）
 */
function readSecretaryHistory({ channel = 'all', count = DEFAULT_COUNT } = {}) {
  if (!fs.existsSync(CONV_HISTORY_PATH)) return [];

  const targets = channel === 'all' ? ['voice', 'line'] : [channel];
  const keyToChannel = {};
  for (const ch of targets) {
    const spec = CHANNEL_KEYS[ch];
    if (!spec) continue;
    keyToChannel[spec.user]      = { channel: ch, role: 'user' };
    keyToChannel[spec.secretary] = { channel: ch, role: 'secretary' };
  }

  const lines = fs.readFileSync(CONV_HISTORY_PATH, 'utf8').split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; /* 壊れた行は無視して続行 */ }
    const hit = keyToChannel[obj.agentKey];
    if (!hit) continue;
    entries.push({ time: obj.time, text: String(obj.text ?? ''), ...hit });
  }
  return entries.slice(-Math.min(Math.max(1, count), MAX_COUNT));
}

/**
 * 時刻を「本日 HH:MM」か「M/D HH:MM」にする。
 *
 * @param {*} ts 時刻
 * @returns {string} 表示用の時刻（無ければ空文字）
 */
function _formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `本日 ${hhmm}` : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

/**
 * 秘書とのやり取りを、読み上げ用の一覧の文にする。話す人の名前は設定から取り、決まった名前を埋め込まない。
 *
 * @param {Array<Record<string, any>>} entries やり取り
 * @param {{channel: string, config?: Record<string, any>}} opts 経路（'voice'・'line'・'all'）と設定全体
 * @returns {string} 一覧の文
 */
function formatHistoryForSpeech(entries, { channel, config }) {
  const userName = config?.show?.user_profile?.name || 'リスナー';
  const secretaryName = config?.agents?.secretary?.name || '秘書';
  const scopeLabel = channel === 'all' ? 'LINE・音声の両方'
    : channel === 'line' ? 'LINE' : '音声';

  if (entries.length === 0) {
    return `${scopeLabel}での過去のやり取りは、記録に残っている範囲では見つかりませんでした。`;
  }

  const body = entries.map((e) => {
    const who = e.role === 'user' ? `${userName}さん` : secretaryName;
    // BUGFIX: 1つの発言を1行にする（改行を空白に潰してから切る）。LINE の返信は改行が多く、そのままだと
    // 一覧のどこまでが1件か読み取れなくなった。
    const flat = e.text.replace(/\s+/g, ' ').trim();
    const text = flat.length > MAX_TEXT_LEN ? `${flat.slice(0, MAX_TEXT_LEN)}…` : flat;
    return `- ${_formatTime(e.time)}［${CHANNEL_KEYS[e.channel].label}］${who}: ${text}`;
  }).join('\n');

  return `【${scopeLabel}での、これまでのやり取り（古い順・${entries.length}件）】\n${body}`;
}

/**
 * 放送の発言を「- 時刻［チャンネル］名前: 本文」の行にする（本文の改行は空白に潰す）。
 * ツールの戻り値と system instruction への注入の両方で使う。
 *
 * @param {Array<Record<string, any>>} entries 放送の発言
 * @param {number} [maxLen] 発言1つあたりの最大文字数
 * @returns {string} 行の並び
 */
function formatBroadcastLines(entries, maxLen = MAX_TEXT_LEN) {
  return entries.map((e) => {
    const flat = e.text.replace(/\s+/g, ' ').trim();
    const text = flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
    return `- ${_formatTime(e.time)}［${e.channel}］${e.agentName}: ${text}`;
  }).join('\n');
}

/**
 * 放送の状況と発言の一覧を、読み上げ用の文にする。音楽チャンネルなら、実際に流れた曲の一覧
 * （played_tracks.json）も添える（ナレーションの文だけでは曲名が不正確になりうるため）。
 *
 * @param {Array<Record<string, any>>} entries 放送の発言
 * @param {{channel: any, onAirStatus?: {onAir: string[], offAir: string[]}|null}} opts チャンネルと放送の状況
 * @returns {string} 一覧の文
 */
function formatBroadcastForSpeech(entries, { channel, onAirStatus = null }) {
  const scope = BROADCAST_CHANNEL_FILTERS[channel] || '全チャンネル';
  // ATTENTION: 放送の状況は必ず記録より前に置くこと。後ろに付けると、モデルは並んだ発言の方を今の放送として読む。
  const head = formatOnAirStatus(onAirStatus, entries.length > 0 ? entries[entries.length - 1].time : null);
  let text = head + (entries.length === 0
    ? `${scope}の放送は、記録に残っている範囲では見つかりませんでした。`
    : `【${scope}で過去に放送された発言（古い順・${entries.length}件）】\n${formatBroadcastLines(entries)}`);

  const trackSummary = readPlayedTracksSummary(channel);
  if (trackSummary) {
    text += `\n\n【${scope}で実際に流れた楽曲一覧（新しい順・正確な記録）】\n${trackSummary}`;
  }
  return text;
}

/**
 * 会話・放送の記録とリクエストのツールの宣言。
 * @type {Array<Record<string, any>>}
 */
const TOOL_DECLARATIONS = [
  {
    name: 'get_secretary_history',
    description: 'あなた（秘書）とリスナーとの過去のやり取りの記録を振り返ります。'
      + 'あなたは音声（この会話）とLINEの両方の窓口を持っており、リスナーから見ればどちらも'
      + '同じあなたへの依頼です。しかし各セッションの中では、もう一方の窓口でのやり取りも、'
      + '過去のセッションでのやり取りも、あなたの記憶には入っていません。このツールはその'
      + '記録を読み出すためのものです。\n'
      + '「LINEで何を頼んだっけ？」「さっきLINEで話した件だけど」「今日は何をお願いした？」'
      + '「前回話したことを覚えてる？」のように、過去のやり取りの内容を尋ねられたときに使って'
      + 'ください。特にLINEについて聞かれた場合は、channelに"line"を指定してください。\n'
      + '\n【重要】これはあなた自身とリスナーとのやり取りの記録であって、リスナーが他の人と'
      + 'LINEで交わしたトークではありません。LINEのAPIは個人間のトーク内容を外部へ提供して'
      + 'おらず、それを読むことは原理的にできません。「友達からのLINEを読んで」「〇〇さんからの'
      + 'メッセージに返信して」のような依頼を受けた場合は、このツールを使わず、他の方との'
      + 'トークは読めないことを正直に伝えてください。',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel: {
          type: 'STRING',
          description: '振り返る窓口。"line"＝LINEでのやり取りのみ、"voice"＝音声での会話のみ、'
            + '"all"＝両方をまとめて時系列で。特に指定が無ければ"all"を使ってください。',
        },
        count: {
          type: 'INTEGER',
          description: `さかのぼる発言数（既定${DEFAULT_COUNT}件、最大${MAX_COUNT}件）。`
            + '「もっと前の」と言われた場合に増やしてください。',
        },
      },
    },
  },
  {
    name: 'get_broadcast_history',
    description: '**いまどのチャンネルが放送中か（あるいはどこも放送していないか）**と、'
      + 'AI Radioの放送で過去に流れた発言の記録を読みます。'
      + 'あなたはこのAI Radioの中にいる秘書であり、リスナーが聴いている番組と同じ放送局の一員です。'
      + 'ただし放送はあなたとの1対1の会話とは別の場所で進んでいるため、いま放送中かどうかも、'
      + '番組で何が話されたかも、このツールで読まない限り分かりません。\n'
      + '「今どんな番組をやってる？」「今放送している番組は？」のように**現在の放送状況**を'
      + '尋ねられたときは、必ずこのツールを使い、返ってくる【現在の放送状況】に従って答えてください。'
      + '放送していないときに、記録に残っている過去の発言を根拠に「〇〇を放送中です」と'
      + '答えてはいけません。\n'
      + '「さっきの番組で言ってた件」「今日のラジオで何の話をしてた？」「MAXは何て言ってた？」'
      + '「どんな曲がかかった？」のように、放送の内容について尋ねられたときにも使ってください。'
      + 'リスナーが番組の話題を前提に話し始めたときも、憶測で話を合わせず、まずこれで確認して'
      + 'ください。\n'
      + '\n【重要】ここに出てくる発言は、キャスター・アシスタント・各センターの担当者・'
      + 'パーソナリティなど、放送に出ている人たちのものです。あなた自身の発言ではありません。'
      + '出演者の発言をあなたが言ったことのように話さないでください。'
      + '記録に無いことを、放送であったかのように作って話すことも絶対にしないでください。',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel: {
          type: 'STRING',
          description: '対象のチャンネル。"live"＝AI Radio Live、"classic"＝静寂のスコア、'
            + '"jazz"＝琥珀色のインプロヴィゼーション、"mood"＝トワイライト・ラウンジ、'
            + '"beatles"＝Eight Days A Week、"the_answers"＝The Answers、'
            + '"all"＝全チャンネルをまとめて時系列で。特に指定が無ければ"all"を使ってください。',
        },
        count: {
          type: 'INTEGER',
          description: `さかのぼる発言数（既定${DEFAULT_COUNT}件、最大${MAX_COUNT}件）。`,
        },
      },
    },
  },
  {
    name: 'request_show_content',
    description: 'AI Radioの番組（Live・Classic・Jazz・Mood・Beatlesのいずれか）へ、'
      + '話題や曲のリクエストを送っておきます。放送中の番組はあなたとの会話とは別の場所で'
      + '進んでいるため、リアルタイムに割り込むことはできません。リクエストは番組側が'
      + '次の適切なタイミング（次のコーナー・次の選曲サイクル等）で取り上げます。\n'
      + '「番組に〇〇をリクエストしておいて」「ラジオで△△について話してほしいと伝えて」'
      + '「ジャズに□□をかけてってお願いしておいて」のように頼まれたら使ってください。\n'
      + '\n【重要】これは「予約」であって「即時実行」ではありません。呼び出した直後に'
      + '「もうかかりました」「もう話しています」のように、実行済みであるかのように'
      + '話さないでください。「番組にお伝えしておきますね」のように、依頼を受け付けた'
      + 'という趣旨で答えてください。\n'
      + 'また、これはリクエストを伝えるだけの機能で、番組を今すぐ操作すること'
      + '（チャンネルの切り替え・停止・音量変更・現在の曲のスキップ等）はできません。'
      + 'そのような操作を頼まれた場合は、番組画面の「お問い合わせ・リクエスト」窓口を'
      + '使うようご案内してください。',
    parameters: {
      type: 'OBJECT',
      properties: {
        channel: {
          type: 'STRING',
          description: 'リクエスト先のチャンネル。"live"＝AI Radio Live、"classic"＝静寂のスコア、'
            + '"jazz"＝琥珀色のインプロヴィゼーション、"mood"＝トワイライト・ラウンジ、'
            + '"beatles"＝Eight Days A Week。リスナーの発言からどのチャンネル宛か明確な場合は'
            + 'それを指定し、不明な場合は聞き返してください（推測で決めないこと）。',
        },
        text: {
          type: 'STRING',
          description: 'リクエスト内容をそのまま（要約せず）。例:「スターウォーズのテーマをかけて」'
            + '「最近の円安について話してほしい」',
        },
      },
      required: ['channel', 'text'],
    },
  },
];

/**
 * 会話・放送の記録とリクエストのツールのハンドラ（ツール名 → 処理）。
 * どれも (args, ctx) を受け取り、{ result } か { error } を返す。ctx.config は設定全体、
 * ctx.getChannelSystem はチャンネル名から動いているエージェントシステムを返す関数。
 * @type {Record<string, (args: any, ctx: any) => Promise<Record<string, any>>>}
 */
const TOOL_HANDLERS = {
  get_secretary_history: async (args, ctx) => {
    const channel = ['line', 'voice', 'all'].includes(args?.channel) ? args.channel : 'all';
    const count = Number(args?.count) > 0 ? Number(args.count) : DEFAULT_COUNT;
    const entries = readSecretaryHistory({ channel, count });
    getLogger().info(`[Secretary] 会話履歴の参照: channel=${channel} count=${count} → ${entries.length}件`);
    return { result: wrapDataForSpeechGuidance(formatHistoryForSpeech(entries, { channel, config: ctx?.config })) };
  },

  get_broadcast_history: async (args, ctx) => {
    const channel = Object.keys(BROADCAST_CHANNEL_FILTERS).includes(args?.channel) ? args.channel : 'all';
    const count = Number(args?.count) > 0 ? Number(args.count) : DEFAULT_COUNT;
    const entries = readBroadcastHistory({ channel, count });
    const onAirStatus = readOnAirStatus(ctx?.getChannelSystem);
    getLogger().info(`[Secretary] 放送内容の参照: channel=${channel} count=${count} → ${entries.length}件`
      + `（放送中: ${onAirStatus ? (onAirStatus.onAir.join('・') || 'なし') : '不明'}）`);
    return { result: wrapDataForSpeechGuidance(formatBroadcastForSpeech(entries, { channel, onAirStatus })) };
  },

  request_show_content: async (args, ctx) => {
    const channel = args?.channel;
    const text = String(args?.text || '').trim();
    if (!REQUESTABLE_CHANNELS[channel]) {
      return { error: `channelは${Object.keys(REQUESTABLE_CHANNELS).join('/')}のいずれかを指定してください。` };
    }
    if (!text) {
      return { error: 'リクエスト内容（text）が空です。' };
    }
    const ok = sendShowRequest(channel, text, ctx?.getChannelSystem);
    getLogger().info(`[Secretary] 番組へのリクエスト送信: channel=${channel} text="${text.slice(0, 60)}" → ${ok ? '成功' : '失敗'}`);
    return {
      result: ok
        ? `${REQUESTABLE_CHANNELS[channel]}へリクエストを送っておきました。`
          + '次の適切なタイミングで取り上げられます（すぐには反映されません）。'
        : `${REQUESTABLE_CHANNELS[channel]}は現在停止中のようで、リクエストを送れませんでした。`,
    };
  },
};

module.exports = {
  TOOL_HANDLERS, TOOL_DECLARATIONS,
  readSecretaryHistory, formatHistoryForSpeech,
  readBroadcastHistory, formatBroadcastForSpeech, formatBroadcastLines,
};
