/**
 * @file 音楽・討論チャンネル共通の土台（読み上げ・Spotify・記憶・放送ループ）
 *
 * 音楽チャンネル（Classic / Jazz / Mood / Beatles）と The Answers が継承する土台のクラス。
 * 読み上げ・Spotify・言語モデル呼び出し・長期記憶・再生履歴・放送の1周という、チャンネルに
 * 依らない部分をここに持つ。チャンネル固有の進行と原稿づくりは、各 agent-system-*.js が
 * フックを上書きして実装する。
 *
 * ATTENTION: 「not implemented」を投げるメソッドは、サブクラスが必ず上書きする約束の場所。
 * ここに既定の実装を足すと、上書きを忘れたチャンネルが黙って別の動きをする。
 *
 * ATTENTION: Live と共通の低い層の処理は、末尾で lib/agent-shared-mixin.js から取り込む。
 * ここに同じものを書き足さないこと（過去に両方へ別実装があり、片方だけ直る事故が起きた）。
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

const fs          = require('fs');
const { writeJsonFile } = require('./lib/atomic-json');
const path        = require('path');
const { generateText, generateJson, streamText, extractText } = require('./lib/llm-client');
const { spawn }   = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const { getLogger } = require('./logger');
const directorBoard = require('./lib/director-board');
const listenerContext = require('./lib/listener-context');
const topical = require('./lib/topical-materials');
const pcmCache    = require('./lib/pcm-cache');
const activityDb  = require('./activity-db');
const spotifyRateLimit = require('./spotify-rate-limit');
const spotifyService = require('./services/spotify-service');
const sfxLibrary = require('./sfx-library');
const { applySharedAgentMethods } = require('./lib/agent-shared-mixin');
const agentDiary = require('./lib/agent-diary');
const listenerRequests = require('./lib/listener-requests');
const jsonFileStore = require('./lib/json-file-store');

const CREDENTIALS_PATH  = path.join(__dirname, 'data', 'credentials.json');
const TTS_DICT_PATH     = path.join(__dirname, 'data', 'tts_dict.json');
const CONV_HISTORY_PATH = path.join(__dirname, 'data', 'conversation_history.jsonl');
const LIVE_CONFIG_PATH  = path.join(__dirname, 'data', 'config.json');

// 長期記憶（セッションの要約）を残しておく期間
const MEMORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// 次の曲の紹介は、いま流れている曲の再生中に先に作っておく。
// ATTENTION: 紹介文の中の「現在時刻」は、作った時点ではなく実際に読まれる頃の時刻にすること。
// そのままだと曲の長さぶんずれ、長い曲では十数分ずれる。この定数は、曲の後のコメントと
// 間合いにかかるおおよその時間。
const PREFETCH_INTRO_SPEAK_BUFFER_MS = 30000;

// オープニング曲の最低再生時間。準備（計画 → 曲探し → 紹介文 → 読み上げの合成）がこれより
// 早く終わっても、曲が短く切れた印象にならないようここまでは流し続ける。
// 準備がこれより長引く場合は、繰り返し再生が無音を埋める。
const OPENING_MIN_PLAY_MS = 15000;

/**
 * 音楽チャンネルと討論チャンネルが継承する土台のクラス。
 *
 * @param {any} mixer そのチャンネルのミキサー
 * @param {any} serverWrapper 一斉配信と接続数を持つ入れ物
 * @param {string} configPath そのチャンネルの設定ファイルの絶対パス
 * @param {string} channelId チャンネル名（ログの見出しに使う）
 */
class ChannelAgentBase {
  constructor(mixer, serverWrapper, configPath, channelId) {
    this.mixer         = mixer;
    this.server        = serverWrapper;
    this._configPath   = configPath;
    this._channelId    = channelId;
    // ATTENTION: 共通の低い層の処理はインスタンス経由でこれらのパスを見るため、必ず持たせること
    this.credentialsPath = CREDENTIALS_PATH;
    this.ttsDictPath     = TTS_DICT_PATH;
    this.isLoopRunning = false;
    this.heartbeatInterval = null;

    this._spotifyTokenCache     = null;
    this._spotifyPlayResolve    = null;
    this._spotifyPlayTimer      = null;
    this._speakGeneration       = 0;
    this._clientCount           = 0;
    this._prefetchedSessionPlan = null;
    this._activitySessionId     = null;
  }

  // ─── 設定・資格情報 ─────────────────────────────────────────────

  /**
   * そのチャンネルの設定を読む。読めなければ空のオブジェクトを返す。
   *
   * @returns {any} 設定
   */
  getConfig() {
    try {
      return JSON.parse(fs.readFileSync(this._configPath, 'utf-8'));
    } catch (e) {
      return {};
    }
  }

  // ─── 一斉配信 ────────────────────────────────────────────────────

  /**
   * 画面へイベントを配信し、必要なものは稼働レポートにも記録する。
   *
   * @param {any} payload 配信するイベント
   * @returns {void}
   */
  _broadcast(payload) {
    const EVENT_CATS = {
      AGENT_SPEAKING: 'program', AGENT_SILENT: 'program',
      BGM_START: 'program',      BGM_STOP: 'program',
      CORNER_START: 'program',   NOTIFY: 'program',
      SHOW_INFO: 'program',      MUSIC_PLAY_START: 'program',
      MUSIC_PLAY_END: 'program', SPOTIFY_PLAY: 'program',
      CAST_LIST: 'program',
      CAPTION: 'program',
      // The Answers 専用のイベント
      THEME_ANNOUNCED: 'program', PANEL_ASSIGNED: 'program', OPINION_RESEARCH: 'program', NEWS_BRIEFING: 'program',
      HAND_RAISE_ACK: 'program', HAND_RAISE_GRANTED: 'program', USER_SPEAKING: 'program',
      HAND_RAISE_TIMEOUT: 'program', SUBMIT_REJECTED_NOT_GRANTED: 'program',
      MODERATION_REJECTED: 'program', ROUND_TIMER: 'program', CLOSING: 'program', SHOW_ENDED: 'program',
      HEARTBEAT: 'system',
      AGENT_THINKING: 'debug',   SYSTEM_ERROR: 'debug',
    };
    const cat = EVENT_CATS[payload.event] ?? 'debug';
    this.server.broadcastToClients({ cat, ...payload, ts: Date.now() });

    // 稼働レポートへの記録
    if (this._activitySessionId) {
      const ev = payload.event;
      if (ev === 'CORNER_START') {
        activityDb.logEvent(this._activitySessionId, 'corner', {
          metadata: { name: payload.name ?? null, ticker_type: payload.ticker?.type ?? null },
        });
      } else if (ev === 'AGENT_SPEAKING') {
        activityDb.logEvent(this._activitySessionId, 'agent_speaking', {
          agent: payload.agent ?? null,
        });
      } else if (ev === 'SYSTEM_ERROR') {
        activityDb.logEvent(this._activitySessionId, 'system_error', {
          metadata: { code: payload.code ?? null },
        });
      }
    }
  }

  // ─── 読み上げ ───────────────────────────────────────────────────

  /**
   * 文章を、読み上げの合成に掛ける単位へ分ける。間合いの指定と効果音の指定は壊さずに残す。
   *
   * @param {string} text 分ける文章
   * @param {any} [opts] minLen（1つ分の最低の長さ）・keepPauseTags（間合いの指定を残すか）・
   *   splitOnNewlines（改行でも分けるか）
   * @returns {string[]} 分けた結果
   */
  _splitTextToSentences(text, { minLen = 20, keepPauseTags = true, splitOnNewlines = true } = {}) {
    const TAG_RE = /(\[PAUSE:\d+\]|\[SFX:\w+\])/g;
    const parts = text.split(TAG_RE);
    const result = [];
    for (const part of parts) {
      if (/^\[PAUSE:\d+\]$/.test(part)) {
        if (keepPauseTags) result.push(part);
        continue;
      }
      if (/^\[SFX:\w+\]$/.test(part)) {
        result.push(part); // 効果音は実際の音の差し込みなので、間合いの設定に関わらず残す
        continue;
      }
      // 改行でも分ける場合は、先に行へ分けてから句読点で分ける（短い行はつなぐ）
      const lines = splitOnNewlines
        ? part.split('\n').map(l => l.trim()).filter(l => l)
        : [part];
      let pending = '';
      for (const line of lines) {
        const segs = (line.match(/[^。！？]+[。！？]?/gu) || [line]).map(s => s.trim()).filter(s => s);
        for (const seg of segs) {
          pending = pending ? pending + seg : seg;
          if (pending.replace(/[。！？\s]/g, '').length >= minLen) {
            result.push(pending);
            pending = '';
          }
        }
      }
      if (pending) result.push(pending);
    }
    return result.filter(s => /^\[PAUSE:\d+\]$/.test(s) || /^\[SFX:\w+\]$/.test(s) || s.replace(/[。！？\s]/g, '').length > 0);
  }

  /**
   * 読み上げの合成に掛ける単位へ分ける（声の演技が効く合成向け）。間合いの指定は落とし、
   * 改行では分けない。
   *
   * ATTENTION: 1つ分の最低の長さを短くしないこと。区切りをまたぐたびに演技の指示を解釈し
   * 直すため、細かく切るほど「発話の途中で急に雰囲気が変わる」。実データでの試算では、
   * 40字だと1発話あたり平均6.75個に分かれ、80字なら平均4.30個まで減る。一方で最初の1つ
   * （再生が始まるまでの待ち時間に直結する）の長さは72字から118字への増加に留まる。
   *
   * @param {string} text 分ける文章
   * @returns {string[]} 分けた結果
   */
  _splitTextToSentencesGemini(text) {
    return this._splitTextToSentences(text, { minLen: 80, keepPauseTags: false, splitOnNewlines: false });
  }

  /**
   * そのエージェントの読み上げの方式を返す。エージェント側に無ければ番組の設定を使う。
   *
   * @param {string} agentKey エージェントのキー
   * @returns {string} 読み上げの方式
   */
  _getAgentTtsEngine(agentKey) {
    const config = this.getConfig();
    return (config.agents?.[agentKey]?.tts_engine) || config.program?.tts_engine || 'gemini';
  }

  /**
   * 少しずつ届く文章のたまりから、最初の1文を切り出す。
   *
   * @param {string} buffer これまでに届いた文章
   * @returns {any} 切り出した文と残り。まだ1文に満たなければ null
   */
  _extractNextSentence(buffer) {
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c === '。' || c === '！' || c === '？') {
        return { sentence: buffer.slice(0, i + 1).trim(), rest: buffer.slice(i + 1) };
      }
      if ((c === '.' || c === '!' || c === '?') && i + 1 < buffer.length && /[\s\n]/.test(buffer[i + 1])) {
        return { sentence: buffer.slice(0, i + 1).trim(), rest: buffer.slice(i + 1) };
      }
      if (c === '\n') {
        const line = buffer.slice(0, i).trim();
        return { sentence: line.length > 5 ? line : null, rest: buffer.slice(i + 1) };
      }
    }
    return null;
  }

  /**
   * 文章の先頭から何文かを、先に読み上げの音声にしておく。
   *
   * ATTENTION: 読み上げ本体とまったく同じ分け方を使うこと。分け方が食い違うと、先に作った
   * 音声が別の文の中身になり、発話の一部が抜け落ちる。
   * ATTENTION: 2文は作ること。1文目だけ先に作っても、2文目の合成は1文目の再生と同時に始まる
   * ため、1文目が短いとすぐ終わって間に合わず、聞いて分かる無音ができる。
   *
   * @param {string} text 読ませる文章
   * @param {string} agentKey 話者のキー
   * @param {number} [count] 先に作る文の数
   * @returns {Promise<any[]>} 読み上げ本体がそのまま受け取れる並び
   */
  async _synthesizeLeadingPcms(text, agentKey, count = 2) {
    if (!text) return [];
    const sentences = this._getAgentTtsEngine(agentKey) === 'gemini'
      ? this._splitTextToSentencesGemini(text)
      : this._splitTextToSentences(text);
    const targets = sentences.slice(0, count);
    return Promise.all(targets.map(s => {
      // 間合いと効果音の指定は読み上げ本体が処理するので、ここでは合成しない
      if (/^\[PAUSE:\d+\]$/.test(s) || /^\[SFX:\w+\]$/.test(s)) return null;
      return this._collectPcm(s, agentKey).catch(() => null);
    }));
  }

  /**
   * 発話に添える字幕（英語で話すチャンネルの訳など）を先に作るための差し込み口。
   * 既定では何もしない。必要なチャンネルだけが上書きする。
   * 曲の再生中（発話の数分前）に呼ばれるので、発話と同時に字幕を出せる。
   *
   * @param {string} _text 発話する文章
   * @param {string} _agentKey 話者のキー
   * @returns {Promise<any>} 字幕。既定では null
   */
  async _maybePrefetchCaption(_text, _agentKey) { return null; }

  /**
   * 文章を読み上げる。文ごとに合成しながら、次の文を先に合成して無音を作らないようにする。
   *
   * 字幕は、先に作ってあればすぐ出し、無ければその場で作る（出るまで少し遅れる）。
   * ATTENTION: 字幕は呼び出しごとに番号を振り、出す時点で最新でなければ捨てること。前の発話の
   * 訳が後から届いて、関係のないタイミングで表示されてしまう。
   *
   * @param {string} text 読ませる文章
   * @param {string} agentKey 話者のキー
   * @param {any} [preloadedFirstPcm] 先に合成しておいた音声（1つでも並びでもよい）
   * @param {any} [preloadedCaption] 先に作っておいた字幕
   * @returns {Promise<void>}
   */
  async speakText(text, agentKey, preloadedFirstPcm = null, preloadedCaption = undefined) {
    if (!text || typeof text !== 'string' || text.trim() === '') return;

    const _capSeq = (this._captionSeq = (this._captionSeq || 0) + 1);
    if (preloadedCaption !== undefined) {
      if (preloadedCaption) {
        this._broadcast({ event: 'CAPTION', agent: agentKey, text: preloadedCaption });
      }
    } else {
      this._maybePrefetchCaption(text, agentKey)
        .then(cap => {
          if (!cap) return;
          if (this._captionSeq === _capSeq) {
            this._broadcast({ event: 'CAPTION', agent: agentKey, text: cap });
          }
        })
        .catch(() => {});
    }

    try {
      const config = this.getConfig();
      const name = (config.agents?.[agentKey]?.name) || agentKey;
      const entry = JSON.stringify({ time: Date.now(), agentKey, agentName: name, text, channel: this._channelId.toLowerCase() }) + '\n';
      fs.appendFileSync(CONV_HISTORY_PATH, entry, 'utf8');
    } catch { }

    this._broadcast({ event: 'AGENT_SPEAKING', agent: agentKey });
    this.mixer.setSpeakerBusy(true);

    const agentCfg = (this.getConfig().agents?.[agentKey]) || {};
    const pan      = agentCfg.pan ?? 0;
    // ATTENTION: 先に合成した側と同じ分け方を使うこと。違う分け方を使うと境目がずれ、
    // 先に作った音声に含まれる文が、この後の文とだぶって再生される。
    const preloadedLeadingPcms = Array.isArray(preloadedFirstPcm)
      ? preloadedFirstPcm
      : (preloadedFirstPcm != null ? [preloadedFirstPcm] : []);
    const sentences = this._getAgentTtsEngine(agentKey) === 'gemini'
      ? this._splitTextToSentencesGemini(text)
      : this._splitTextToSentences(text);
    const _myGen    = this._speakGeneration;

    getLogger().debug(`[${this._channelId} TTS] ${agentKey}: ${sentences.length}チャンク分割 → ${sentences.map((s,i) => `[${i}]${s.slice(0,20)}…`).join(' / ')}`);

    // 効果音は指示を無視して多用されることがあるため、1発話あたりの回数に上限を設ける
    const MAX_SFX_PER_TURN = 2;
    let _sfxPlayedCount = 0;

    try {
      const pcmPromises = [this._collectPcmOrPause(sentences[0], agentKey, preloadedLeadingPcms[0] ?? null)];
      if (sentences.length > 1) {
        getLogger().debug(`[${this._channelId} TTS] ${agentKey}: チャンク[0][1]を並行プリフェッチ開始`);
        pcmPromises.push(this._collectPcmOrPause(sentences[1], agentKey, preloadedLeadingPcms[1] ?? null));
      }

      for (let i = 0; i < sentences.length; i++) {
        if (this._speakGeneration !== _myGen) break;

        const result = await pcmPromises[i];
        if (i + 2 < sentences.length) {
          getLogger().debug(`[${this._channelId} TTS] ${agentKey}: チャンク[${i+2}]プリフェッチ開始（[${i}]再生中）`);
          pcmPromises[i + 2] = this._collectPcmOrPause(sentences[i + 2], agentKey);
        }

        if (result && result.__silenceMs !== undefined) {
          const silencePcm = this._makeSilencePcm(result.__silenceMs);
          if (silencePcm.length > 0) await this._injectAndWait(silencePcm, pan);
        } else if (result && result.__sfxPcm !== undefined) {
          if (!result.__sfxPcm) {
            getLogger().debug(`[${this._channelId} TTS] ${agentKey}: 未知のSFX名のため無視`);
          } else if (_sfxPlayedCount >= MAX_SFX_PER_TURN) {
            getLogger().debug(`[${this._channelId} TTS] ${agentKey}: SFX上限(${MAX_SFX_PER_TURN}/発話)に達したためスキップ`);
          } else {
            _sfxPlayedCount++;
            await this._injectAndWait(result.__sfxPcm, pan);
          }
        } else if (result && result.length > 0) {
          await this._injectAndWait(result, pan);
        }
        pcmPromises[i] = null;
      }
    } finally {
      this.mixer.keepSpeakerBusyMs(600);
      this._broadcast({ event: 'AGENT_SILENT', agent: agentKey });
      if (this._captionSeq === _capSeq) this._broadcast({ event: 'CAPTION', agent: agentKey, text: '' });
    }
  }

  /**
   * 少しずつ積まれていく音声を、積まれた順に再生する（原稿を作りながら読む経路で使う）。
   *
   * @param {any} streamData 音声の待ち行列・積み終わったかの印・本文・字幕
   * @param {string} agentKey 話者のキー
   * @returns {Promise<void>}
   */
  async _speakPcmQueue(streamData, agentKey) {
    if (!streamData?.pcmQueue) return;

    const _capSeq = (this._captionSeq = (this._captionSeq || 0) + 1);
    this._broadcast({ event: 'AGENT_SPEAKING', agent: agentKey });
    this.mixer.setSpeakerBusy(true);

    // 字幕は音声の再生を待たせず、並行して待つ。番号が合わなければ古い結果として捨てる
    if (streamData.captionPromise) {
      streamData.captionPromise
        .then(cap => {
          if (!cap) return;
          if (this._captionSeq === _capSeq) {
            this._broadcast({ event: 'CAPTION', agent: agentKey, text: cap });
          }
        })
        .catch(() => {});
    }

    const agentCfg = this.getConfig().agents?.[agentKey] || {};
    const pan      = agentCfg.pan ?? 0;
    const _myGen   = this._speakGeneration;

    try {
      let i = 0;
      while (true) {
        if (this._speakGeneration !== _myGen) break;
        if (i < streamData.pcmQueue.length) {
          const pcm = await streamData.pcmQueue[i++];
          if (pcm && pcm.length > 0) await this._injectAndWait(pcm, pan);
        } else if (streamData.pcmQueueDone) {
          break;
        } else {
          await new Promise(r => setTimeout(r, 30));
        }
      }
    } finally {
      // 本文は作りながら伸びていくため、再生し終えてから記録する
      try {
        const config = this.getConfig();
        const name = config.agents?.[agentKey]?.name || agentKey;
        const entry = JSON.stringify({ time: Date.now(), agentKey, agentName: name, text: streamData.introText || '', channel: this._channelId.toLowerCase() }) + '\n';
        fs.appendFileSync(CONV_HISTORY_PATH, entry, 'utf8');
      } catch { }
      this.mixer.keepSpeakerBusyMs(600);
      this._broadcast({ event: 'AGENT_SILENT', agent: agentKey });
      if (this._captionSeq === _capSeq) this._broadcast({ event: 'CAPTION', agent: agentKey, text: '' });
    }
  }

  // ─── Spotify ────────────────────────────────────────────────────

  /**
   * Spotify で曲を探し、計画に最も近い1曲を返す。
   *
   * @param {string} query 検索の文字列
   * @param {any} [plan] 求めている曲の情報（作曲者・演奏者など）
   * @returns {Promise<any>} 見つかった曲。見つからなければ null
   */
  async _searchSpotifyTrack(query, plan = null) {
    // ATTENTION: 待機中は問い合わせず即座に諦めること。利用の資格は全チャンネル共通なので、
    // 待機の状態もプロセス全体で共有している。
    if (spotifyRateLimit.isBackedOff()) {
      return null;
    }
    const token = await this._getSpotifyToken();
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}` };

    // 混み合っているときの待ち方は共通のサービス側にまとめてある。このチャンネルでの
    // 待ち方（同期で待つのは10秒まで、長すぎる指示なら待機に入れて諦める）は引数で渡す。
    try {
      const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=5`;
      const res = await spotifyService.spotifyFetch(url, {
        headers,
        logPrefix: `[${this._channelId}]`,
        maxSyncWaitMs: 10 * 1000,
        persistBackoffMs: 0,
      });
      if (!res || !res.ok) return null;
      const data = await res.json();
      return this._pickBestSpotifyTrack(data.tracks?.items || [], plan);
    } catch { return null; }
  }

  /**
   * 曲の情報から演奏者名の並びを取り出す。
   *
   * @param {any} track 曲の情報
   * @returns {string[]} 演奏者名の並び
   */
  _extractSpotifyArtistNames(track) {
    return (track?.artists || []).map(a => a.name).filter(Boolean);
  }

  /**
   * 検索結果から、計画に最も近い1曲を選ぶ。
   *
   * @param {any[]} items 検索結果
   * @param {any} plan 求めている曲の情報
   * @returns {any} 選んだ曲
   */
  _pickBestSpotifyTrack(items, plan) {
    if (!items || items.length === 0) return null;
    if (items.length === 1) return items[0];
    const scored = items
      .map(track => ({ track, score: this._scoreSpotifyTrack(track, plan) }))
      .filter(x => x.score > -Infinity)
      .sort((a, b) => b.score - a.score);
    return scored.length > 0 ? scored[0].track : items[0];
  }

  /**
   * 1曲が、求めている曲とどれだけ合っているかを点数にする。
   *
   * @param {any} track 候補の曲
   * @param {any} plan 求めている曲の情報
   * @returns {number} 点数（大きいほど合っている）
   */
  _scoreSpotifyTrack(track, plan) {
    if (!track) return -Infinity;
    if (track.duration_ms < 60 * 1000) return -Infinity;
    let score = 0;
    if (track.duration_ms > 3 * 60 * 1000) score += 2;
    if (track.album?.images?.length > 0) score += 1;

    if (!plan) return score;
    const target = [
      track.name || '',
      track.album?.name || '',
      ...(track.artists || []).map(a => a.name || ''),
    ].join(' ').toLowerCase();

    // 演奏者名の突き合わせ（指揮者の欄とアーティストの欄の両方で使う）
    const matchFields = [plan.conductor, plan.ensemble, plan.artist, plan.key_performers];
    for (const field of matchFields) {
      if (!field) continue;
      for (const w of field.toLowerCase().split(/[\s,··\/]+/).filter(w => w.length > 2)) {
        if (target.includes(w)) score += 2;
      }
    }
    return score;
  }

  // ─── 言語モデルの呼び出し ──────────────────────────────────────
  // ATTENTION: 内部の思考が出力へ混ざるのを防ぐ判定は、共通の低い層にまとめてある。
  // ここに別実装を書かないこと。以前は Live 側とここに別々の実装があり、検知の条件が
  // 食い違って、漏れが起きるたび片方にだけ対処を足す状態になっていた。

  /**
   * 言語モデルを1回呼んで、発話用の文章を受け取る。
   *
   * ATTENTION: どのモデルを使うかは段（tier）で指定すること。呼び出し側でモデル名を
   * 組み立てて渡さない。利用者の設定による上書きは、モデルを決める層がまとめて見ている。
   *
   * @param {string} systemPrompt 人格・役割の指示
   * @param {string} userPrompt その場の依頼
   * @param {boolean} [useSearch] 検索で裏を取らせるか
   * @param {string} [tier] 使うモデルの段
   * @param {any} [agentKey] 話者のキー（稼働レポートと「思考中」表示に使う）
   * @returns {Promise<any>} 生成された文章。失敗すれば null
   */
  async _callGemini(systemPrompt, userPrompt, useSearch = false, tier = 'main', agentKey = null) {
    const creds = this.getCredentials();
    const config = this.getConfig();
    const apiKey = creds.gemini?.api_key;
    if (!apiKey) return null;

    // 画面の「思考中」表示。話者のキーが無いとき（計画づくりなど）は出さない
    if (agentKey) this._broadcast({ event: 'AGENT_THINKING', agent: agentKey, state: 'start' });
    try {
      // ATTENTION: モデル固有の応答の形をここで触らないこと。結合・思考部分の除外は
      // 呼び出しの層の仕事で、ここに残るのは文章への後処理だけ。
      const { text: _rawSpeech } = await generateText({
        tier,
        apiKey,
        creds, config,
        systemInstruction: systemPrompt,
        prompt: userPrompt,
        grounded: useSearch,
        agentKey,
        activitySessionId: this._activitySessionId,
        logMeta: { search: useSearch },
      });
      // ここから下は文章への後処理。本文がそのまま2回繰り返される場合への備え
      let _joined = this._collapseDuplicatedWholeText(_rawSpeech);
      // 内部の思考が混ざった場合への備え。
      // ATTENTION: 英語の書き出しを落とす判定は、日本語で話すエージェントにだけ掛けること。
      // 正当に英語で話すチャンネルに掛けると、本文全体を思考と誤判定して削り落とす。
      _joined = this._collapseReasoningLeak(_joined, {
        detectEnglishPrefix: this._promptExpectsJapanese(systemPrompt),
      });
      // 使用量の記録は、呼び出しの層で済んでいる
      return _joined || null;
    } catch (e) {
      getLogger().error(`[${this._channelId} Gemini] エラー: ${e.message}`);
      activityDb.logEvent(this._activitySessionId, 'system_error', {
        agent: agentKey,
        metadata: { code: 'GEMINI_FAILED', message: e.message?.slice(0, 200) },
      });
      if (e.message?.includes('prepayment credits')) {
        this._broadcast({ event: 'SYSTEM_ERROR', code: 'GOOGLE_CREDIT_DEPLETED' });
      }
      return null;
    } finally {
      if (agentKey) this._broadcast({ event: 'AGENT_THINKING', agent: agentKey, state: 'end' });
    }
  }

  /**
   * 担当したエージェントに、一人称の短い振り返り（日記）を書かせて保存する。
   *
   * ATTENTION: 呼び出し側は完了を待たないこと。放送の進行を止めてはいけない。
   *
   * @param {string} agentKey 保存先のフォルダー名になるキー
   * @param {string} agentName 表示名（設定から取った動的な値）
   * @param {string} spokenText 振り返りの材料になる発言
   * @param {any} [label] 日記に残す文脈の名前
   * @param {'moment'|'episode'|'plan'} [scope] moment（直前の一場面・既定）／episode（番組全体）／
   *   plan（自分では話さず決めた構成を振り返る。ディレクター向け）
   * @returns {Promise<void>}
   */
  async _writeDiaryReflection(agentKey, agentName, spokenText, label = null, scope = 'moment') {
    if (!spokenText) return;
    try {
      // ATTENTION: 文面と材料の上限は日記の側にまとめてある。ここで別に持たないこと
      // （放送・討論・相談で振り返りの観点が食い違う）。
      const excerpt = spokenText.replace(/[\n\r]+/g, ' ')
        .slice(0, agentDiary.REFLECTION_EXCERPT_LIMITS[scope] || 800);
      const systemPrompt = `あなたは「${agentName}」です。`;
      const userPrompt = agentDiary.buildReflectionPrompt({ agentName, excerpt, scope });
      const diaryText = await this._callGemini(systemPrompt, userPrompt, false, 'light', agentKey);
      if (!diaryText) return;
      agentDiary.appendDiaryEntry({
        // チャンネル名は、フォルダー名などで使う下線区切りの形へそろえる
        channel: String(this._channelId || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
        agentKey,
        agentName,
        corner: label,
        text: diaryText.trim(),
      });
      // ATTENTION: 日記の本文は非公開の振り返りなので、画面へは短い抜粋だけを流すこと
      // （全文は管理画面の日記のタブで読める）。
      this._broadcast({
        event: 'DIARY_WRITTEN', agentKey, agentName, corner: label,
        excerpt: diaryText.trim().slice(0, 40),
      });
    } catch (e) {
      getLogger().debug(`[Diary] ${agentKey} の日記生成に失敗しました（無視して続行）: ${e.message}`);
    }
  }

  /**
   * 曲の紹介と曲の後のコメントを、日記の材料として溜める。
   *
   * ATTENTION: 曲ごとに日記を書かないこと。音楽チャンネルは24時間止まらず、テーマが数曲ごとに
   * 切り替わるだけで「番組終了」に当たる区切りが無い。全リスナーが退出した時点で1回だけ書く。
   *
   * 中に待つ処理は無いが、呼び出し側が失敗を拾える形にするため常に Promise を返す。
   *
   * @param {string} introText 曲の紹介
   * @param {string} commentText 曲の後のコメント
   * @returns {Promise<void>}
   */
  async _writeMusicDiaryReflection(introText, commentText) {
    const spokenText = [introText, commentText].filter(Boolean).join('\n');
    if (!spokenText) return;
    this._diaryTranscriptBuffer ??= [];
    this._diaryTranscriptBuffer.push(spokenText);
  }

  /**
   * 溜めておいた材料を1本の振り返りにまとめて書く。全リスナーが退出したときに呼ぶ。
   *
   * @returns {void}
   */
  _flushMusicDiarySession() {
    const buffer = this._diaryTranscriptBuffer;
    this._diaryTranscriptBuffer = [];
    if (!buffer || buffer.length === 0) return Promise.resolve();
    const agentKey  = this._interruptAgentKey;
    const agentName = this.getConfig().agents?.[agentKey]?.name || agentKey;
    return this._writeDiaryReflection(agentKey, agentName, buffer.join('\n'), 'session', 'episode');
  }

  /**
   * ディレクターの振り返りを書く。声を持たず放送には出ないが、構成と選曲を決めた判断そのものが
   * 振り返りの材料になる。新しい計画が固まった直後（1回の計画につき1回）に呼ぶ。
   *
   * @param {any} sessionPlan 決まったテーマ・狙い・曲目
   * @returns {void}
   */
  _writeDirectorSessionDiary(sessionPlan) {
    if (!sessionPlan?.pieces?.length) return;
    const directorKey  = this._directorAgentKey;
    const directorName = this.getConfig().agents?.[directorKey]?.name || directorKey;
    const piecesText = sessionPlan.pieces
      .map(p => `${p.artist} "${p.title}"${p.role ? `（${p.role}）` : ''}`)
      .join('、');
    const material = `テーマ「${sessionPlan.theme}」\n狙い: ${sessionPlan.concept || '（特になし）'}\n選曲: ${piecesText}`;
    this._writeDiaryReflection(directorKey, directorName, material, 'session_plan', 'plan').catch(() => {});
    // 他の番組のディレクターへ、今回のテーマを共有する
    try {
      directorBoard.post({
        directorKey, directorName, programName: this.getConfig().program?.name || '',
        title: sessionPlan.theme || '', detail: sessionPlan.concept || '',
      });
    } catch (e) {
      getLogger().debug(`[DirectorBoard] ${directorKey}: 書き込みに失敗（無視）: ${e.message}`);
    }
  }

  /**
   * 計画づくりに添える、ディレクター同士で共有する材料を組み立てる。各チャンネルの計画から呼ぶ。
   *   ① 他の番組のディレクターが直近に決めた方針
   *   ② リスナーの予定とやること（公開範囲は lib/listener-context.js の決まりに従う）
   *   ③ 季節と世の中の動き
   * どれも失敗してよい（空文字になるだけで、計画は止めない）。
   *
   * @param {any} [opts] lang（ja / en）
   * @returns {Promise<string>} 添える材料。何も取れなければ空文字
   */
  async _buildDirectorSharedContext({ lang = 'ja' } = {}) {
    const directorKey = this._directorAgentKey;
    const parts = [];
    try {
      parts.push(directorBoard.formatOthersForDirector(directorKey, {
        lang,
        usageNote: lang === 'en'
          ? 'Use these only as background to avoid clashing themes or to echo the mood of the station. Do not copy them.'
          : '※ 他の番組とテーマが重なりすぎないようにしたり、局全体の空気を意識したりする参考にしてください。そのまま真似る必要はありません。',
      }));
    } catch (e) { getLogger().debug(`[DirectorBoard] 読み込みに失敗（無視）: ${e.message}`); }
    try {
      parts.push(listenerContext.formatScheduleForPrompt(directorKey, { scene: 'broadcast' }));
    } catch (e) { getLogger().debug(`[ListenerContext] 予定の読み込みに失敗（無視）: ${e.message}`); }
    try {
      parts.push(await topical.buildBriefWorldText({
        usageNote: '※ 選曲テーマを考えるときの参考です（季節の行事や世の中の空気）。ニュースそのものをテーマにする必要は'
          + 'ありません。深刻な出来事を軽く扱ったり、曲に結び付けたりしないでください。',
      }));
    } catch (e) { getLogger().debug(`[TopicalMaterials] 読み込みに失敗（無視）: ${e.message}`); }
    return parts.filter(Boolean).join('');
  }

  /**
   * 言語モデルを呼び、文が1つ出来上がるたびに知らせる。読み上げを待たせずに始めるために使う。
   *
   * ATTENTION: 思考の設定は必ず明示して送ること。省略すると既定の動きに委ねられ、内部の思考に
   * 印が付かないまま出力へ混ざることがある。
   * ATTENTION: 思考を明示的に無効にしないこと（0を渡さない）。考えた内容をそのまま本文として
   * 出してしまう不具合がある。
   *
   * @param {string} systemPrompt 人格・役割の指示
   * @param {string} userPrompt その場の依頼
   * @param {any} onSentence 1文ごとに呼ばれる関数
   * @param {number} [thinkingBudget] 思考の量。-1 でモデルに任せる
   * @param {string} [tier] 使うモデルの段
   * @param {any} [agentKey] 話者のキー
   * @returns {Promise<string>} 出来上がった全文
   */
  async _callGeminiStreaming(systemPrompt, userPrompt, onSentence, thinkingBudget = -1, tier = 'main', agentKey = null) {
    const creds  = this.getCredentials();
    const config = this.getConfig();
    const apiKey = creds.gemini?.api_key;
    if (!apiKey) return null;

    // 画面の「思考中」表示（1回の呼び出しと同じ）
    if (agentKey) this._broadcast({ event: 'AGENT_THINKING', agent: agentKey, state: 'start' });
    try {
      // ATTENTION: 少しずつ届く形をここで直接扱わないこと。区切り方も終わり方もモデルに
      // よって違うため、呼び出しの層に任せる。ここに残るのは文の切り出しと漏れの判定だけ。
      const _t0 = Date.now();
      const streamResult = streamText({
        tier,
        apiKey,
        creds, config,
        systemInstruction: systemPrompt,
        prompt: userPrompt,
        thinkingBudget: thinkingBudget >= 0 ? thinkingBudget : -1,
        agentKey,
        activitySessionId: this._activitySessionId,
        logMeta: { chars: null },
      });

      let fullText   = '';
      let spokenText = '';
      let buffer     = '';

      // ここは文ごとに確定していくため、全文をまとめて見る判定は使えない。文が決まるたびに
      // 1文単位の判定に掛け、該当した文だけを捨てる。
      // ATTENTION: 判定の条件そのものは共通の低い層にまとめてある。新しい漏れの言い回しが
      // 見つかったらそちらを直すこと。全チャンネル・両方の経路に同時に効く。
      const _isLeakSentence = s => this._isMetaAnnouncement(s) || this._isReasoningLeakSentence(s);

      for await (const { textDelta } of streamResult) {
        const chunkText = textDelta;
        buffer   += chunkText;
        fullText += chunkText;

        let extracted;
        while ((extracted = this._extractNextSentence(buffer)) !== null) {
          if (extracted.sentence && _isLeakSentence(extracted.sentence)) {
            getLogger().warn(`[${this._channelId} Gemini Stream] 内部思考/下書きの混入を検知→破棄: "${extracted.sentence}"`);
          } else if (extracted.sentence && extracted.sentence.replace(/[\s。！？!?.]/g, '').length >= 10) {
            if (onSentence) onSentence(extracted.sentence);
            spokenText += extracted.sentence;
          }
          buffer = extracted.rest;
        }
      }

      const rem = buffer.trim();
      if (rem && _isLeakSentence(rem)) {
        getLogger().warn(`[${this._channelId} Gemini Stream] 内部思考/下書きの混入を検知→破棄（末尾）: "${rem}"`);
      } else if (rem && rem.replace(/[\s。！？!?.]/g, '').length >= 5) {
        if (onSentence) onSentence(rem);
        spokenText += rem;
      }

      // 使用量の記録は、呼び出しの層が引き受ける
      getLogger().debug(`[${this._channelId} Gemini Stream] 完了 model=${streamResult.result.model} `
        + `${fullText?.length ?? 0}文字 ${Date.now() - _t0}ms`);
      return spokenText || null;
    } catch (e) {
      getLogger().error(`[${this._channelId} Gemini Stream] エラー: ${e.message}`);
      activityDb.logEvent(this._activitySessionId, 'system_error', {
        agent: agentKey,
        metadata: { code: 'GEMINI_FAILED', message: e.message?.slice(0, 200) },
      });
      if (e.message?.includes('prepayment credits')) {
        this._broadcast({ event: 'SYSTEM_ERROR', code: 'GOOGLE_CREDIT_DEPLETED' });
      }
      return null;
    } finally {
      if (agentKey) this._broadcast({ event: 'AGENT_THINKING', agent: agentKey, state: 'end' });
    }
  }

  // ─── 番組の日付・長期記憶・再生履歴 ──────────────────────────────

  /**
   * 最後に挨拶した日を記憶のファイルへ保存する。
   *
   * @param {any} showDay 番組としての日付
   * @returns {void}
   */
  _saveGreetingDay(showDay) {
    const data = jsonFileStore.readJsonFile(this._memoryPath, {}, `[${this._channelId}]`);
    data.last_greeting_show_day = showDay;
    jsonFileStore.writeJsonFile(this._memoryPath, data, `[${this._channelId}]`);
  }

  /**
   * 再生履歴を読む。
   *
   * @returns {any[]} これまでに流した曲
   */
  _loadPlayedPieces() {
    return jsonFileStore.readJsonFile(this._playedPath, [], `[${this._channelId}]`);
  }

  /**
   * 再生履歴を保存する。
   *
   * @returns {void}
   */
  _savePlayedPieces() {
    jsonFileStore.writeJsonFile(this._playedPath, this._playedPieces, `[${this._channelId}]`);
  }

  /**
   * オープニング曲があるチャンネルで、接続時に BGM が自動再生されるのを先に止めておく。
   * 放送ループの起動時と、終了処理が済んだ後（次の接続に備えて）の2か所から呼ぶ。
   *
   * @returns {void}
   */
  _applyOpeningPreLock() {
    const openingDir = path.join(__dirname, 'assets', 'channels', this._channelId.toLowerCase(), 'bgm', 'opening');
    const hasJingle  = fs.existsSync(openingDir) && fs.readdirSync(openingDir).some(f => f.endsWith('.mp3'));
    if (!hasJingle) return;
    this.mixer._volumeLocked = true;
    try {
      const bgmFiles = fs.readdirSync(this.mixer.bgmDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
      const bgmSel   = bgmFiles.find(f => f.endsWith('.mp3')) || bgmFiles[0];
      if (bgmSel) this.mixer.currentBgmFile = bgmSel;
    } catch (_) {}
  }

  /**
   * 曲が流れている間に、次の曲の紹介文と最初の音声を裏で作っておく。
   *
   * ATTENTION: 実際に読まれるまでの見込み時間を必ず渡すこと。紹介文の中の「現在時刻」をその分
   * 先にずらして作らないと、作った時点と読まれる時点で曲の長さぶんずれる。
   *
   * @param {any} plan 次に流す曲の計画
   * @param {number} [speakDelayMs] 実際に読まれるまでの見込み時間
   * @returns {Promise<any>} 紹介文と先に作った音声・字幕
   */
  async _prefetchNextIntro(plan, speakDelayMs = 0) {
    const pfx      = `[${this._channelId} Prefetch]`;
    const agentKey = this._interruptAgentKey;
    const planLabel = plan.composer
      ? `${plan.composer}「${plan.composition}」`
      : `${plan.artist} "${plan.title}"`;
    try {
      getLogger().debug(`${pfx} Spotify 事前確認: ${plan.spotify_query}`);
      const track = await this._searchSpotifyTrack(plan.spotify_query, plan);
      if (!track) {
        getLogger().warn(`${pfx} Spotify で見つからないためプリフェッチをスキップ: ${plan.spotify_query}`);
        return null;
      }
      const spotifyArtists = this._extractSpotifyArtistNames(track);
      const performerInfo  = this._buildPrefetchPerformerInfo(track, plan, spotifyArtists);

      getLogger().debug(`${pfx} イントロ生成開始: ${planLabel}（予測時刻 +${Math.round(speakDelayMs / 1000)}秒）`);
      const text = await this._generateIntroduction(plan, false, null, performerInfo, null, speakDelayMs);

      // 字幕も音声の合成と並行して先に作る
      const captionPromise = this._maybePrefetchCaption(text, agentKey).catch(() => null);

      const sentences = this._getAgentTtsEngine(agentKey) === 'gemini'
        ? this._splitTextToSentencesGemini(text)
        : this._splitTextToSentences(text);
      getLogger().debug(`${pfx} イントロ生成完了 ${sentences.length}チャンク → TTS冒頭2チャンク合成開始`);
      // 冒頭2文を先に作る（1文目が短いと、2文目を待つ間に無音ができるため）
      const pcms = await this._synthesizeLeadingPcms(text, agentKey);
      const caption = await captionPromise;
      getLogger().info(`${pfx} 次曲プリフェッチ完了: ${planLabel}`);
      return { ...plan, text, pcms, caption };
    } catch (e) {
      getLogger().warn(`${pfx} プリフェッチ失敗: ` + e.message);
      return null;
    }
  }

  /**
   * 長期記憶から直近の数回分を読み、プロンプトに渡す形へ整える。
   * 見出しと曲目の書き方はチャンネルごとに違うため、フックを上書きして決める。
   *
   * @returns {Promise<string>} 整えた文章。何も無ければ空文字
   */
  async _loadLongTermMemory() {
    try {
      if (!fs.existsSync(this._memoryPath)) return '';
      const data = JSON.parse(fs.readFileSync(this._memoryPath, 'utf-8'));
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (entries.length === 0) return '';
      const recent = entries.slice(-5);
      const lines = recent.map(e => {
        const date = new Date(e.timestamp).toLocaleDateString('ja-JP');
        const pieces = (e.pieces_played || [])
          .map(p => `  - ${this._formatMemoryPieceLine(p)}`)
          .join('\n');
        return `${this._getMemorySessionHeader(date)}\n${e.summary}${pieces ? '\n' + pieces : ''}`;
      });
      return lines.join('\n\n');
    } catch (e) {
      getLogger().warn(`[${this._channelId}] 長期記憶読み込みエラー: ` + e.message);
      return '';
    }
  }

  _getMemorySessionHeader(/* date */)  { throw new Error(`${this._channelId}: _getMemorySessionHeader not implemented`); }
  _formatMemoryPieceLine(/* piece */)  { throw new Error(`${this._channelId}: _formatMemoryPieceLine not implemented`); }

  /**
   * その回に流れた曲をまとめて、長期記憶に残す要約を作らせる。
   * 文面と曲目の書き方はチャンネルごとに違うため、フックを上書きして決める。
   *
   * @returns {Promise<any>} 要約。作るだけの材料が無ければ null
   */
  async _generateSessionSummary() {
    const sessionPieces = this._playedPieces.filter(p => {
      if (p.spotifyFailed) return false;
      return new Date(p.playedAt).getTime() >= this._sessionStartTime;
    });
    if (sessionPieces.length < this._getSessionSummaryMinPieces()) {
      getLogger().info(`[${this._channelId}] 演奏曲数が少ないためサマリーをスキップ`);
      return null;
    }
    const piecesList = sessionPieces.map(p => this._formatSummaryPieceLine(p)).join('\n');
    const { systemPrompt, userPrompt } = this._getSessionSummaryPrompts(piecesList);
    // BUGFIX: 話者のキーは 'director' と直書きせず、そのチャンネルのディレクターのキーを使う。
    // 直書きすると Live のディレクターのキーとぶつかり、画面に別人の名前とアバターが出る。
    const raw = await this._callGemini(systemPrompt, userPrompt, false, 'main', this._directorAgentKey);
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  /**
   * 要約を作る対象とする、最低限の曲数。
   *
   * @returns {number} 曲数
   */
  _getSessionSummaryMinPieces() { return 2; }

  _formatSummaryPieceLine(/* piece */)      { throw new Error(`${this._channelId}: _formatSummaryPieceLine not implemented`); }
  _getSessionSummaryPrompts(/* piecesList */) { throw new Error(`${this._channelId}: _getSessionSummaryPrompts not implemented`); }

  /**
   * 要約を長期記憶へ保存する。保持期間を過ぎたものはここで落とす。
   *
   * @param {any} summary 保存する要約
   * @returns {Promise<void>}
   */
  async _saveSessionSummary(summary) {
    if (!summary) return;
    try {
      let data = { entries: [] };
      if (fs.existsSync(this._memoryPath)) {
        try { data = JSON.parse(fs.readFileSync(this._memoryPath, 'utf-8')); } catch { }
      }
      if (!Array.isArray(data.entries)) data.entries = [];
      const cutoff = Date.now() - MEMORY_TTL_MS;
      data.entries = data.entries.filter(e => new Date(e.timestamp).getTime() > cutoff);
      data.entries.push({
        timestamp:     new Date().toISOString(),
        summary:       summary.summary || '',
        highlights:    summary.highlights || '',
        pieces_played: summary.pieces_played || [],
      });
      const dir = path.dirname(this._memoryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      writeJsonFile(this._memoryPath, data);
      getLogger().info(`[${this._channelId}] 長期記憶を保存しました`);
    } catch (e) {
      getLogger().error(`[${this._channelId}] 長期記憶保存エラー: ` + e.message);
    }
  }

  /**
   * 演奏者の情報を組み立てる。チャンネルごとに書き方が違うため、サブクラスが上書きする。
   * 引数 track/plan/spotifyArtists: 見つかった曲・計画・こちらで求めた演奏者名の並び。
   *
   * @returns {any} 演奏者の情報
   */
  _buildPrefetchPerformerInfo(track, plan, spotifyArtists) {
    return { spotifyArtists, spotifyAlbum: track.album?.name || '' };
  }

  /**
   * オープニングの演出。曲を流しながら、裏で計画づくり・1曲目の紹介文・読み上げの合成を進める。
   *
   * ATTENTION: 曲は固定の長さで1回流すのではなく、準備が終わるまで繰り返し流すこと。準備が
   * 長引くと、曲が終わったのに誰も話し出さない無音ができる。
   *
   * @param {any} recentKeys 直近に流した曲の目印（重複を避けるために渡す）
   * @returns {Promise<void>}
   */
  async _runOpeningPrefetch(recentKeys) {
    const config     = this.getConfig();
    const openingDir = path.join(__dirname, 'assets', 'channels', this._channelId.toLowerCase(), 'bgm', 'opening');
    const hasJingle  = fs.existsSync(openingDir) &&
      fs.readdirSync(openingDir).some(f => f.endsWith('.mp3'));
    const personalityKey = this._interruptAgentKey;
    const directorKey    = this._directorAgentKey;
    const pfx = `[${this._channelId} Opening]`;

    // 冒頭2文の合成が終わったら放送ループを始める、という合図
    let resolveOpeningReady;
    const openingReadyPromise = new Promise(r => { resolveOpeningReady = r; });

    // 曲と並行して、原稿を作りながら読む処理を始める
    (async () => {
      let plan;
      try {
        this._broadcast({ event: 'AGENT_THINKING', agent: directorKey, state: 'start' });
        this._sessionPlan = await this._planSession(recentKeys);
        this._broadcast({ event: 'AGENT_THINKING', agent: directorKey, state: 'end' });
        if (!this._sessionPlan?.pieces?.length) { resolveOpeningReady(); return null; }
        this._writeDirectorSessionDiary(this._sessionPlan);

        plan = this._sessionPlan.pieces.shift();
        const sessionInfo = { theme: this._sessionPlan.theme, concept: this._sessionPlan.concept };
        getLogger().info(`${pfx} 第1曲: ${this._getPlanLabel(plan)}`);

        let spotifyTrack = null, performerInfo = null;
        spotifyTrack = await this._searchSpotifyTrack(plan.spotify_query, plan);
        if (!spotifyTrack) {
          getLogger().warn(`${pfx} Spotify 未発見: ${plan.spotify_query}`);
          this._sessionPlan.pieces.unshift(plan);
          resolveOpeningReady();
          return null;
        }
        const spotifyArtists = this._extractSpotifyArtistNames(spotifyTrack);
        performerInfo = this._buildPrefetchPerformerInfo(spotifyTrack, plan, spotifyArtists);

        const streamData = {
          plan, spotifyTrack, performerInfo,
          introText: '', pcmQueue: [], pcmQueueDone: false,
        };
        this._broadcast({ event: 'AGENT_THINKING', agent: personalityKey, state: 'start' });
        let sentenceIdx = 0;
        await this._generateIntroduction(plan, true, sessionInfo, performerInfo, (sentence) => {
          streamData.introText += (sentenceIdx > 0 ? ' ' : '') + sentence;
          const pcmPromise = this._collectPcm(sentence, personalityKey);
          streamData.pcmQueue.push(pcmPromise);
          if (sentenceIdx === 0) {
            // 冒頭2文の合成を待ってから合図する（文の間に無音ができるのを防ぐ）
            pcmPromise.then(async () => {
              if (streamData.pcmQueue.length > 1) {
                try { await streamData.pcmQueue[1]; } catch { }
              }
              this._openingPlanData = streamData;
              this._broadcast({ event: 'AGENT_THINKING', agent: personalityKey, state: 'end' });
              getLogger().info(`${pfx} 開幕準備完了（第1・2文TTS完成 — ストリーミング）`);
              resolveOpeningReady();
            }).catch(() => { resolveOpeningReady(); });
          }
          sentenceIdx++;
        });
        // 「思考中」の終わりは1文目の合成時に送信済み（作れなかった場合はここで送る）
        if (sentenceIdx === 0) {
          this._broadcast({ event: 'AGENT_THINKING', agent: personalityKey, state: 'end' });
        }

        // 1文も作れなかった場合の代わりの文面
        if (sentenceIdx === 0) {
          const fallback = this._getOpeningFallbackText(plan);
          streamData.introText = fallback;
          const fallbackPcm = this._collectPcm(fallback, personalityKey);
          streamData.pcmQueue.push(fallbackPcm);
          fallbackPcm.then(() => {
            this._openingPlanData = streamData;
            resolveOpeningReady();
          }).catch(() => { resolveOpeningReady(); });
        }

        // 字幕の先読みも、曲が鳴っている間に済ませる
        streamData.captionPromise = this._maybePrefetchCaption(streamData.introText, personalityKey).catch(() => null);

        // 積み終わった印は、合成の完了を待たずに立てる
        streamData.pcmQueueDone = true;
        getLogger().info(`${pfx} 全文TTS キュー完成`);
        return streamData;
      } catch (e) {
        getLogger().error(`${pfx} パイプラインエラー: ` + e.message);
        if (plan && this._sessionPlan) this._sessionPlan.pieces.unshift(plan);
        resolveOpeningReady();
        return null;
      }
    })();

    // BUGFIX: 通常の BGM のファイル名をここで控えておくこと。繰り返し再生の開始が BGM を
    // 止めてしまうため、控えないとオープニングの後に BGM が鳴らなくなる。
    const bgmFileToRestore = this.mixer.currentBgmFile;
    let openingStartedAt = null;
    if (hasJingle) {
      this._broadcast({ event: 'NOTIFY', message: 'オープニング' });
      this.mixer.playAmbientShuffle(openingDir, 1.0);
      // 繰り返し再生はいきなり最大音量になるため、入りだけ手で滑らかにする（裏で進める）
      this.mixer.currentBgmVolume = 0;
      this.mixer.fadeBgmTo(1.0, 500);
      openingStartedAt = Date.now();
    }

    // 冒頭2文の合成が終わるのを待ってから、放送ループへ移る
    await openingReadyPromise;

    if (hasJingle) {
      // 準備が最低再生時間より早く終わった場合は、曲が短く切れた印象にならないよう待つ
      const elapsedMs = Date.now() - openingStartedAt;
      if (elapsedMs < OPENING_MIN_PLAY_MS) {
        await new Promise(r => setTimeout(r, OPENING_MIN_PLAY_MS - elapsedMs));
      }
      this.mixer._volumeLocked = true;
      await this.mixer.fadeBgmTo(0, 2000);
      this.mixer.stopBgm();
      this.mixer._volumeLocked = false;
      // オープニング曲が終わったら通常の BGM へ戻す。音量0から始め、自動で上がるのに任せる
      // （この後に話し始めると自動的に下がる）。
      if (bgmFileToRestore) {
        getLogger().info(`[${this._channelId} Opening] ジングル終了 — 通常BGMを復元: ${bgmFileToRestore}`);
        this.mixer.currentBgmVolume = 0;
        this.mixer.targetBgmVolume  = 0;
        this.mixer.playBgm(bgmFileToRestore);
        // BGM が上がってすぐ下がると切り替わりが慌ただしいため、話し始める前に少しだけ
        // BGM 単独で流す
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  _getOpeningFallbackText(/* plan */) { throw new Error(`${this._channelId}: _getOpeningFallbackText not implemented`); }

  /**
   * 曲が流れている間に、曲の後のコメントと最初の音声を裏で作っておく。
   *
   * @param {any} plan いま流している曲の計画
   * @param {any} actualTrackName 実際に流れている曲名
   * @param {any} performerInfo 演奏者の情報
   * @returns {Promise<any>} コメントと先に作った音声・字幕
   */
  async _prefetchComment(plan, actualTrackName, performerInfo) {
    const pfx      = `[${this._channelId} Prefetch]`;
    const agentKey = this._interruptAgentKey;
    const planLabel = plan.composer
      ? `${plan.composer}「${actualTrackName}」`
      : `${plan.artist || ''} "${actualTrackName}"`;
    try {
      getLogger().debug(`${pfx} 曲後コメント生成開始: ${planLabel}`);
      const text = await this._generateComment(plan, actualTrackName, performerInfo);

      // 字幕も音声の合成と並行して先に作る
      const captionPromise = this._maybePrefetchCaption(text, agentKey).catch(() => null);

      // 冒頭2文を先に作る（1文目が短いと、2文目を待つ間に無音ができるため）
      const pcms = await this._synthesizeLeadingPcms(text, agentKey);
      const caption = await captionPromise;
      getLogger().info(`${pfx} 曲後コメントプリフェッチ完了: ${plan.composer || plan.artist || ''}`);
      return { text, pcms, caption };
    } catch (e) {
      getLogger().warn(`${pfx} 曲後コメントプリフェッチ失敗: ` + e.message);
      return null;
    }
  }

  // ─── 放送ループ ─────────────────────────────────────────────────

  /**
   * リスナーが接続したときに呼ばれる。待機中なら放送を再開する。
   *
   * @returns {void}
   */
  onClientConnected() {
    this._clientCount++;
    if (this._clientCount === 1) {
      this._activitySessionId = activityDb.openSession(this._channelId.toLowerCase());
    }
  }

  /**
   * リスナーが切断したときに呼ばれる。全員が退出したら終了処理へ進む。
   *
   * @returns {void}
   */
  onClientDisconnected() {
    this._clientCount = Math.max(0, this._clientCount - 1);
    if (this._clientCount === 0 && this._activitySessionId) {
      activityDb.closeSession(this._activitySessionId);
      this._activitySessionId = null;
    }
  }

  /**
   * 曲の再生完了を待っている状態を、その場で解く。
   * ATTENTION: 切断時に必ず呼ぶこと。誰も聴いていないのに曲が終わるのを待ち続けてしまう。
   *
   * @returns {void}
   */
  _interruptSpotifyPlayWait() {
    if (this._spotifyPlayResolve) {
      clearTimeout(this._spotifyPlayTimer);
      const resolve = this._spotifyPlayResolve;
      this._spotifyPlayResolve = null;
      this._spotifyPlayTimer   = null;
      setTimeout(resolve, 0);
    }
  }

  /**
   * 最後のリスナーが切断したときの終了処理。要約を長期記憶へ保存し、日記を書く。
   * ATTENTION: 計画や長期記憶の仕組みを持たないチャンネルからは呼ばないこと（必要なフックが
   * 無く例外になる）。
   *
   * @returns {void}
   */
  _handleSessionShutdown() {
    const remaining = this.server.getClientCount();
    if (remaining !== 0 || this._isShuttingDown) return;
    this._isShuttingDown = true;

    // 状態はすぐ戻す。終了処理が終わる前に再接続されても、必ずオープニングから始まる
    this._sessionPlan       = null;
    this._nextIntroPrefetch = null;
    this._openingPlanData   = null;
    this._needsNewSession   = true;
    this._applyOpeningPreLock();
    this._flushMusicDiarySession().catch(() => {});

    this._generateSessionSummary()
      .then(summary => this._saveSessionSummary(summary))
      .then(() => this._loadLongTermMemory())
      .then(ctx => {
        this._longTermContext  = ctx;
        this._isShuttingDown   = false;
        this._sessionStartTime = Date.now();
      })
      .catch(e => {
        getLogger().error(`[${this._channelId}] セッションサマリー保存エラー: ` + e.message);
        this._isShuttingDown = false;
      });
  }

  /**
   * 接続してきた画面へ、出演者・番組名・再生履歴・待ち行列をまとめて送る。
   * ATTENTION: ナレーションを持たないチャンネルからは呼ばないこと（必要なフックが無く例外になる）。
   *
   * @returns {void}
   */
  _broadcastConnectionInfo() {
    this._broadcastCastList();
    const config = this.getConfig();
    this._broadcast({
      event: 'SHOW_INFO',
      slot:  this._channelId.toLowerCase(),
      name:  config.program?.name || this._getDefaultProgramName(),
    });
    this._broadcastPlayedList();
    this._broadcastQueueUpdate();
  }

  /**
   * 放送ループを始める。リスナーが来るまでは何もしない。
   *
   * @returns {void}
   */
  startShowLoop() {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;
    getLogger().debug(`[${this._channelId}] ショーループ開始`);

    this.heartbeatInterval = setInterval(() => {
      this._broadcast({ event: 'HEARTBEAT' });
    }, 30000);

    this._broadcastCastList();

    this._showLoop().catch(e => {
      getLogger().error(`[${this._channelId}] ショーループ致命エラー: ` + e.message);
    });
  }

  /**
   * 出演者の一覧を画面へ送る。
   *
   * @returns {void}
   */
  _broadcastCastList() {
    const config = this.getConfig();
    const agents = config.agents || {};
    this._broadcast({
      event:   'CAST_LIST',
      channel: this._channelId.toLowerCase(),
      agents: Object.entries(agents).map(([key, a]) => ({
        key,
        name: a.name || key,
        role: a.role || key,
      })),
    });
  }

  /**
   * 再生履歴を画面へ送る。イベント名はチャンネル名から自動で決まる。
   *
   * @returns {void}
   */
  _broadcastPlayedList() {
    const recent = this._playedPieces
      .filter(p => !p.spotifyFailed)
      .slice(0, 20);
    this._broadcast({ event: `${this._channelId.toUpperCase()}_PLAYED_LIST`, list: recent });
  }

  /**
   * リクエストの待ち行列を画面へ送る。
   *
   * @returns {void}
   */
  _broadcastQueueUpdate() {
    this._broadcast({ event: `${this._channelId.toUpperCase()}_QUEUE_UPDATE`, queue: this._requestQueue });
  }

  /**
   * もう一度かけてほしい、という依頼を待ち行列の先頭へ入れる。
   *
   * @param {any} track 依頼された曲
   * @returns {void}
   */
  addReplayRequest(track) {
    this._requestQueue.push(track);
    this._broadcastQueueUpdate();
    getLogger().info(`[${this._channelId}] リクエスト追加: ${this._getPlanLabel(track)} (キュー: ${this._requestQueue.length}件)`);
    // もう一度という依頼は、推し量る必要のないはっきりした意思表示なので記録に残す
    // （待ち行列に置くだけだと、切断したときに何を頼まれたか消える）
    listenerRequests.recordRequest({
      channel: this._channelId.toLowerCase(), kind: 'encore',
      label: this._getPlanLabel(track), detail: { track },
    });
  }

  /**
   * 放送の本体。曲を決め、紹介し、流し、曲の後のコメントを読む、という周回を続ける。
   *
   * @returns {Promise<void>}
   */
  async _showLoop() {
    let isFirstPieceOfSession = true;
    const recentTracks = [];
    const ch = `[${this._channelId}]`;

    this._applyOpeningPreLock();

    this._longTermContext = await this._loadLongTermMemory();
    if (this._longTermContext) getLogger().info(`${ch} 長期記憶を読み込みました`);

    while (this.isLoopRunning && this.server.getClientCount() === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this.isLoopRunning) return;

    await this._runOpeningPrefetch(recentTracks);

    while (this.isLoopRunning) {
      if (this.server.getClientCount() === 0) {
        await new Promise(r => setTimeout(r, this._needsNewSession ? 100 : 3000));
        continue;
      }

      if (this._needsNewSession) {
        this._needsNewSession       = false;
        this._prefetchedSessionPlan = null;
        isFirstPieceOfSession = true;
        recentTracks.length = 0;
        await this._runOpeningPrefetch(recentTracks);
      }

      try {
        // ─── 1. 流す曲を決める ────────────────────────────────────────
        let plan;
        let _fromOpening = null;

        if (this._requestQueue.length > 0) {
          const req = this._requestQueue.shift();
          this._broadcastQueueUpdate();
          plan = this._buildRequestPlan(req);
          getLogger().info(`${ch} リクエスト曲: ${this._getPlanLabel(plan)}`);
        } else if (isFirstPieceOfSession && this._openingPlanData) {
          _fromOpening = this._openingPlanData;
          this._openingPlanData = null;
          plan = _fromOpening.plan;
          getLogger().info(`${ch} オープニング事前計算を使用: ${this._getPlanLabel(plan)}`);
        } else {
          if (!this._sessionPlan?.pieces?.length) {
            // 先に作ってあればそれを使う（たいてい出来上がっているので待たない）
            if (this._prefetchedSessionPlan) {
              getLogger().info(`${ch} プリフェッチ済みセッション計画を待機中...`);
              const _prefetchedPlan = await this._prefetchedSessionPlan;
              this._prefetchedSessionPlan = null;
              if (_prefetchedPlan?.pieces?.length) {
                this._sessionPlan = _prefetchedPlan;
                getLogger().info(`${ch} セッション計画（プリフェッチ）: テーマ「${_prefetchedPlan.theme}」 ${_prefetchedPlan.pieces.length}曲`);
                this._writeDirectorSessionDiary(_prefetchedPlan);
              } else {
                getLogger().warn(`${ch} セッション計画プリフェッチ失敗 → 通常計画にフォールバック`);
              }
            }

            // 先に作ったものが無い・失敗した場合は、その場で計画を立てる
            if (!this._sessionPlan?.pieces?.length) {
              getLogger().info(`${ch} 新しいセッションを計画中...`);
              this._broadcast({ event: 'AGENT_THINKING', agent: this._directorAgentKey, state: 'start' });
              this._sessionPlan = await this._planSession(recentTracks);
              this._broadcast({ event: 'AGENT_THINKING', agent: this._directorAgentKey, state: 'end' });
              if (this._sessionPlan?.pieces?.length) this._writeDirectorSessionDiary(this._sessionPlan);

              if (!this._sessionPlan?.pieces?.length) {
                getLogger().warn(`${ch} セッション計画失敗。従来方式にフォールバック。`);
                this._broadcast({ event: 'AGENT_THINKING', agent: this._directorAgentKey, state: 'start' });
                plan = await this._directorPlan(recentTracks);
                this._broadcast({ event: 'AGENT_THINKING', agent: this._directorAgentKey, state: 'end' });
                if (!plan) {
                  await new Promise(r => setTimeout(r, 5000));
                  continue;
                }
              }
            }
          }

          if (!plan) {
            plan = this._sessionPlan.pieces.shift();
            getLogger().info(`${ch} セッション「${this._sessionPlan.theme}」から楽曲取得: ${this._getPlanLabel(plan)}（残り ${this._sessionPlan.pieces.length} 曲）`);
            // 最後の曲を取り出したので、次の計画を裏で作り始める
            if (this._sessionPlan.pieces.length === 0 && !this._prefetchedSessionPlan) {
              const _recentSnapshot = [this._getRecentKey(plan), ...recentTracks];
              getLogger().info(`${ch} 次セッション計画のプリフェッチ開始`);
              this._prefetchedSessionPlan = this._planSession(_recentSnapshot).catch(e => {
                getLogger().warn(`${ch} セッション計画プリフェッチ失敗: ${e.message}`);
                return null;
              });
            }
          }
        }

        getLogger().info(`${ch} 次の楽曲: ${this._getPlanLabel(plan)}`);

        const sessionInfo = (isFirstPieceOfSession && this._sessionPlan && !plan.isReplay)
          ? { theme: this._sessionPlan.theme, concept: this._sessionPlan.concept }
          : null;
        const isOpening = isFirstPieceOfSession && !plan.isReplay;

        // ─── 2. その曲が実際に流せるか確かめる ────────────────────────
        const config = this.getConfig();
        let _spotifyTrack = null;
        let _performerInfo = null;

        if (_fromOpening) {
          _spotifyTrack  = _fromOpening.spotifyTrack;
          _performerInfo = _fromOpening.performerInfo;
        } else {
          getLogger().info(`${ch} Spotify 事前確認: ${plan.spotify_query}`);
          _spotifyTrack = await this._searchSpotifyTrack(plan.spotify_query, plan);

          if (!_spotifyTrack) {
            getLogger().warn(`${ch} Spotify で見つからないため紹介をスキップ: ${plan.spotify_query}`);
            this._playedPieces.unshift(this._buildSpotifyFailedEntry(plan));
            if (this._playedPieces.length > this._playedMax) this._playedPieces.pop();
            this._savePlayedPieces();
            continue;
          }

          _performerInfo = this._buildSpotifyPerformerInfo(_spotifyTrack, plan);
          getLogger().info(`${ch} 演奏者情報: artists=[${(_performerInfo.spotifyArtists || []).join(', ')}] album="${_performerInfo.spotifyAlbum}"`);
        }

        // ─── 3. 曲を紹介する ──────────────────────────────────────
        this._broadcast({ event: 'CORNER_START', name: this._getCornerStartName(plan) });

        const _cached = this._nextIntroPrefetch;
        this._nextIntroPrefetch = null;
        const _cacheHit = !isOpening && !plan.isReplay && _cached && this._checkIntroCacheHit(_cached, plan);

        let introText, preloadedFirstPcm, preloadedCaption, _useStreamQueue = false;
        if (_fromOpening) {
          if (_fromOpening.pcmQueue) {
            getLogger().info(`[${this._channelId} Opening] 事前生成イントロを使用（ストリーミング PCM キュー）`);
            _useStreamQueue = true;
            introText = _fromOpening.introText;
          } else {
            getLogger().info(`[${this._channelId} Opening] 事前生成イントロを使用 → 生成スキップ`);
            introText         = _fromOpening.introText;
            preloadedFirstPcm = _fromOpening.firstPcm;
            preloadedCaption  = _fromOpening.caption;
          }
        } else if (_cacheHit) {
          getLogger().info(`[${this._channelId} Prefetch] キャッシュヒット → イントロ生成スキップ: ${this._getPlanLabel(plan)}`);
          introText         = _cached.text;
          preloadedFirstPcm = _cached.pcms;
          preloadedCaption  = _cached.caption;
        } else {
          this._broadcast({ event: 'AGENT_THINKING', agent: this._interruptAgentKey, state: 'start' });
          introText = await this._generateIntroduction(plan, isOpening, sessionInfo, _performerInfo);
          this._broadcast({ event: 'AGENT_THINKING', agent: this._interruptAgentKey, state: 'end' });
          preloadedFirstPcm = null;
        }

        if (isOpening) this._saveGreetingDay(this._getShowDay());
        isFirstPieceOfSession = false;

        let _openingIntroPrePromise = null;
        let _openingCommentPrePromise = null;
        if (isOpening && _spotifyTrack && !plan.isReplay) {
          const _piece2 = this._sessionPlan?.pieces?.length > 0 ? this._sessionPlan.pieces[0] : null;
          if (_piece2) {
            // オープニングの挨拶と、この曲の長さと、曲の後のコメントの分だけ先の時刻を見込む
            const _openingSpeakDelayMs = PREFETCH_INTRO_SPEAK_BUFFER_MS
              + (_spotifyTrack.duration_ms || 5 * 60 * 1000)
              + PREFETCH_INTRO_SPEAK_BUFFER_MS;
            _openingIntroPrePromise = this._prefetchNextIntro(_piece2, _openingSpeakDelayMs);
            getLogger().info(`[${this._channelId} Prefetch] オープニング中に次曲イントロ先行生成: ${this._getPlanLabel(_piece2)}`);
          }
          _openingCommentPrePromise = this._prefetchComment(plan, _spotifyTrack.name, _performerInfo);
          getLogger().info(`[${this._channelId} Prefetch] オープニング中にコメント先行生成開始`);
        }

        if (_useStreamQueue) {
          await this._speakPcmQueue(_fromOpening, this._interruptAgentKey);
        } else {
          await this.speakText(introText, this._interruptAgentKey, preloadedFirstPcm, preloadedCaption);
        }

        // ─── 4. 曲を流す ─────────────────────────────────────────
        const durationMs = _spotifyTrack.duration_ms || 5 * 60 * 1000;
        const waitMs = durationMs + 15000;

        const { spotifyArtists, spotifyAlbum } = _performerInfo;

        const bgmFileToRestore = this.mixer.currentBgmFile;
        // 画面側に溜まっている音を出し切らせるために少し待つ
        await new Promise(r => setTimeout(r, 500));
        if (bgmFileToRestore) {
          this.mixer._volumeLocked = true;
          await this.mixer.fadeBgmTo(0, 1200);
          this.mixer.stopBgm();
          this.mixer._volumeLocked = false;
        } else {
          this.mixer.stopBgm();
        }

        if (this.server.getClientCount() === 0) continue;

        const displayArtist = this._getDisplayArtist(_performerInfo, plan);
        this._broadcast({
          event:      'SPOTIFY_PLAY',
          uri:        _spotifyTrack.uri,
          title:      _spotifyTrack.name,
          artist:     displayArtist,
          durationMs: durationMs,
        });
        this._broadcast({
          event:      'MUSIC_PLAY_START',
          mode:       'spotify_sdk',
          title:      _spotifyTrack.name,
          artist:     displayArtist,
          albumImage: _spotifyTrack.album?.images?.[0]?.url || null,
        });

        this._playedPieces.unshift(this._buildPlayedEntry(plan, _spotifyTrack, _performerInfo));
        if (this._playedPieces.length > this._playedMax) this._playedPieces.pop();
        this._savePlayedPieces();
        this._broadcastPlayedList();
        activityDb.logEvent(this._activitySessionId, 'song_played', {
          metadata: {
            title:      _spotifyTrack.name,
            artist:     displayArtist,
            uri:        _spotifyTrack.uri,
            album:      _spotifyTrack.album?.name ?? null,
            duration_ms: durationMs,
          },
        });

        // 曲が流れている間に、次の曲の紹介と曲の後のコメントを並行して作る。
        // オープニングでは既に始めてあるものを使い回し、二重に作らない
        const _nextPieceForPrefetch = (!plan.isReplay && this._requestQueue.length === 0)
          ? (this._sessionPlan?.pieces?.[0] ?? null)
          : null;
        // いま流している曲の長さと、曲の後のコメントの分だけ先の時刻を紹介文へ反映する
        const _nextIntroSpeakDelayMs = durationMs + PREFETCH_INTRO_SPEAK_BUFFER_MS;
        const _nextIntroPrefetchPromise = _openingIntroPrePromise
          ?? (_nextPieceForPrefetch ? this._prefetchNextIntro(_nextPieceForPrefetch, _nextIntroSpeakDelayMs) : Promise.resolve(null));
        const _commentPrefetchPromise = _openingCommentPrePromise
          ?? this._prefetchComment(plan, _spotifyTrack.name, _performerInfo);

        await this._waitForSpotifyPlayDone(waitMs);
        this._broadcast({ event: 'MUSIC_PLAY_END', title: _spotifyTrack.name });

        const [_nextIntroResult, _prefetchedComment] = await Promise.all([
          _nextIntroPrefetchPromise,
          _commentPrefetchPromise,
        ]);
        this._nextIntroPrefetch = _nextIntroResult;

        if (this.server.getClientCount() === 0) {
          this.mixer.stopBgm();
          continue;
        }

        // BGM を戻す。
        // ATTENTION: 音量を0に戻してから始めること。曲の再生中に音量が最大まで押し上げられて
        // いるため、戻さないと BGM がいきなり最大音量で鳴り出す。
        if (bgmFileToRestore) {
          this.mixer.setSpeakerBusy(true);
          this.mixer.currentBgmVolume = 0;
          this.mixer.targetBgmVolume  = 0;
          this.mixer.playBgm(bgmFileToRestore);
        }

        // ─── 5. 曲の後のコメント ──────────────────────────────────
        let commentText, commentPcms, commentCaption;
        if (_prefetchedComment) {
          getLogger().info(`[${this._channelId} Prefetch] 曲後コメントキャッシュヒット → 生成スキップ`);
          commentText    = _prefetchedComment.text;
          commentPcms    = _prefetchedComment.pcms;
          commentCaption = _prefetchedComment.caption;
        } else {
          this._broadcast({ event: 'AGENT_THINKING', agent: this._interruptAgentKey, state: 'start' });
          commentText = await this._generateComment(plan, _spotifyTrack.name, _performerInfo);
          this._broadcast({ event: 'AGENT_THINKING', agent: this._interruptAgentKey, state: 'end' });
          commentPcms = null;
        }
        await this.speakText(commentText, this._interruptAgentKey, commentPcms, commentCaption);
        this._writeMusicDiaryReflection(introText, commentText).catch(() => {});

        recentTracks.unshift(this._getRecentKey(plan));
        if (recentTracks.length > 3) recentTracks.pop();

        await new Promise(r => setTimeout(r, 3000));

      } catch (e) {
        getLogger().error(`${ch} ショーループエラー: ` + e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // ─── サブクラスが必ず上書きするフック ─────────────────────────────
  // ATTENTION: ここに既定の実装を足さないこと。上書きを忘れたチャンネルが黙って別の動きをする。

  get _directorAgentKey()                    { throw new Error(`${this._channelId}: _directorAgentKey not implemented`); }

  _buildRequestPlan(/* req */)               { throw new Error(`${this._channelId}: _buildRequestPlan not implemented`); }
  _getPlanLabel(/* plan */)                  { throw new Error(`${this._channelId}: _getPlanLabel not implemented`); }
  _buildSpotifyPerformerInfo(/* t, p */)     { throw new Error(`${this._channelId}: _buildSpotifyPerformerInfo not implemented`); }
  _buildSpotifyFailedEntry(/* plan */)       { throw new Error(`${this._channelId}: _buildSpotifyFailedEntry not implemented`); }
  _checkIntroCacheHit(/* cached, plan */)    { throw new Error(`${this._channelId}: _checkIntroCacheHit not implemented`); }
  _getDisplayArtist(/* info, plan */)        { throw new Error(`${this._channelId}: _getDisplayArtist not implemented`); }
  _buildPlayedEntry(/* p, t, info */)        { throw new Error(`${this._channelId}: _buildPlayedEntry not implemented`); }
  _getCornerStartName(/* plan */)            { throw new Error(`${this._channelId}: _getCornerStartName not implemented`); }
  _getRecentKey(/* plan */)                  { throw new Error(`${this._channelId}: _getRecentKey not implemented`); }
  _getDefaultProgramName()                   { throw new Error(`${this._channelId}: _getDefaultProgramName not implemented`); }

  /**
   * 放送で読み上げる「いまの日時」を、読み違えようのない1つの語句にして返す。
   *
   * BUGFIX: 曜日と時刻だけを渡してはいけない。「◯曜日深夜」は放送の言い方では「その曜日の夜＝
   * 翌日にかけての夜」を指すため、0時を回ると「もう翌日だ」と辻褄を合わせて1日ずれた案内になる。
   * 対処は2つ。暦の日付を必ず添えること、0〜4時台は「深夜」ではなく「未明」と呼ぶこと。
   * 「未明0時13分」は前日の夜という読み方ができないので、禁止事項を書き足さなくても誤読が
   * 成立しない（曖昧でない言葉を渡す方が、禁止を増やすより確実）。
   *
   * @param {any} now いま（読み上げが始まる見込みの時刻）
   * @param {string} timeLabel チャンネル側が決めた時間帯の呼び名（未明の時間帯では使わない）
   * @param {any} [opts] lang（ja / en）
   * @returns {string} 例:「2026年9月17日（木曜日）未明0時13分」
   */
  _buildDateTimeContext(now, timeLabel, { lang = 'ja' } = {}) {
    const hour = now.getHours();
    const min  = String(now.getMinutes()).padStart(2, '0');
    // ATTENTION: 各チャンネルが「深夜」と呼ぶ範囲と必ずそろえること。ここだけ狭めると、
    // その時間帯が「◯曜日深夜◯時」に戻って元の誤読が復活する。
    const isSmallHours = hour < 6;

    if (lang === 'en') {
      const dayEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
      const monthEn = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'][now.getMonth()];
      const stamp = `${monthEn} ${now.getDate()}, ${now.getFullYear()}, ${String(hour).padStart(2, '0')}:${min}`;
      return isSmallHours
        ? `the small hours of ${dayEn} morning — ${stamp} (the date has already changed to ${dayEn})`
        : `${dayEn} ${timeLabel} — ${stamp}`;
    }

    const dayJa = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];
    const stamp = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${dayJa}曜日）`;
    return isSmallHours
      ? `${stamp}未明${hour}時${min}分`
      : `${stamp}${timeLabel}${hour}時${min}分`;
  }

  /**
   * そのエージェントに文字数の上限が設定されていれば、指示の末尾に書き足す。
   * ディレクターのような、機械が読む形を作らせる呼び出しには使わないこと。
   *
   * ATTENTION: 「◯文程度」という文の数での指示に置き換えないこと。実測では、長さの制御の
   * 精度はほぼ同じなのに、文の数を指示すると毎回1,300〜1,400トークンの思考を誘発し、
   * 費用が増えるだけだった。文字数の指示は機械的な整形の決まりとして扱われ、思考をほとんど
   * 起こさない。
   *
   * @param {string} systemPrompt 元の指示
   * @param {string} agentKey エージェントのキー
   * @returns {string} 書き足した指示
   */
  _applyMaxChars(systemPrompt, agentKey) {
    const maxChars = this.getConfig()?.agents?.[agentKey]?.max_chars;
    if (!maxChars || maxChars <= 0) return systemPrompt;
    return `${systemPrompt}\n\n【文字数制限】発話テキストは${maxChars}文字以内（句読点・記号を含む）に収めること。`;
  }

  // ─── リスナーリクエスト共通処理 ──────────────────────────────────────────

  /**
   * リクエストの文から、曲の情報を取り出す。
   *
   * @param {string} request リクエストの文
   * @returns {Promise<any>} 作曲者・曲名・演奏者・検索の文字列など
   */
  async _extractSongFromRequest(request) {
    const apiKey = this.getCredentials()?.gemini?.api_key;
    if (!apiKey) throw new Error('APIキーなし');
    const userPrompt =
      `音楽リクエスト「${request}」から楽曲情報を JSON 形式のみで出力してください。\n` +
      `{ "composer": "作曲者名（英語）", "composition": "クラシック曲名（英語）", ` +
      `"artist": "アーティスト名（英語）", "title": "曲名（英語）", ` +
      `"period": "時代（例: romantic）", "category": "ジャンル", ` +
      `"film_title": "映画タイトルまたはnull", "spotify_query": "英語の Spotify 検索クエリ" }`;
    // ATTENTION: ここだけ直接 API を叩かないこと。応答の形を扱うのは呼び出しの層の仕事。
    const { data: info } = await generateJson({
      tier: 'light',
      apiKey,
      creds: this.getCredentials(),
      config: this.getConfig(),
      prompt: userPrompt,
      temperature: 0,
      agentKey: 'song_extract',
      activitySessionId: this._activitySessionId,
      logMeta: { kind: 'song_extract', channel: this._channelId },
    });
    if (!info) throw new Error('楽曲情報のJSONを解析できませんでした');
    if (!info.spotify_query) throw new Error('楽曲情報が不完全');
    return info;
  }

  /**
   * 取り出した曲の情報を、そのチャンネルの待ち行列の形へ直す。サブクラスが上書きする。
   * 引数 info: 取り出した曲の情報。
   *
   * @returns {any} 待ち行列に入れる形
   */
  _buildExtractedRequestTrack(/* info */) {
    throw new Error(`${this._channelId}: _buildExtractedRequestTrack not implemented`);
  }

  /**
   * リスナーからのリクエストを受け取り、曲を特定して待ち行列の先頭へ入れる。
   * 特定できなければ、計画づくりへリクエストの文をそのまま渡して立て直させる。
   *
   * @param {any} request リクエストの文
   * @returns {void}
   */
  handleListenerRequest(request) {
    if (!request?.trim()) return;
    const ch = `[${this._channelId}]`;
    getLogger().info(`${ch} リスナーリクエスト受信: ${request.slice(0, 60)}`);

    this._extractSongFromRequest(request).then(info => {
      const track = this._buildExtractedRequestTrack(info);
      this._requestQueue.unshift(track); // 最優先で待ち行列の先頭へ
      this._broadcastQueueUpdate();
      getLogger().info(`${ch} リクエスト解析完了 → キュー追加: ${this._getPlanLabel(track)}`);
    }).catch(e => {
      // 特定できなければ、計画にリクエストの文を埋め込んで立て直させる
      getLogger().warn(`${ch} リクエスト解析失敗 → フォールバック: ${e.message}`);
      try {
        const config = this.getConfig();
        if (!config.program) config.program = {};
        config.program.listener_request = request;
        writeJsonFile(this._configPath, config);
        if (this._sessionPlan?.pieces?.length > 1) this._sessionPlan.pieces = [];
      } catch (e2) {
        getLogger().error(`${ch} リクエスト保存エラー: ${e2.message}`);
      }
      // 画面の「解析中」表示を消す
      this._broadcastQueueUpdate();
    });
  }

}

// ATTENTION: Live と共通の低い層の処理は、ここで取り込むこと。このクラスに同じものを
// 書き足すと、片方だけ直る状態に戻る。
applySharedAgentMethods(ChannelAgentBase);

module.exports = ChannelAgentBase;
