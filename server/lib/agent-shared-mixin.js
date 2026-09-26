/**
 * @file 全チャンネルのエージェントシステムが共通で使う、低い層の処理をまとめたもの
 *
 * Live（agent-system.js）と音楽などの共通の土台（channel-base.js）の両方で同じだった処理を集めてある。
 * applySharedAgentMethods でそれぞれのクラスに取り込む。中のメソッドは this（取り込んだ側のインスタンス）
 * 経由でしか状態に触らないので、混ぜても動きは変わらない。
 *
 * 主な中身。
 * - 読み上げ（TTS）: 文から音声（PCM）を作る・音量・効果音・間・読み方の下ごしらえ
 * - 思考の漏れの始末: モデルの下書きや検討の過程が本文に混ざったときの検知と切り落とし
 * - 認証情報・Spotify のトークン
 * - リスナーの情報・秘書が作ったリスナー像・資産のまとめ・日記のふり返りの読み込み
 *
 * ATTENTION: ここに足してよいのは、Live と共通の土台で中身が同じ処理だけ。違いがあるなら、その違いを
 * 名前の付いたフック（既定をここに置き、違う側だけが上書きする）に切り出してから入れる。本体の中で
 * チャンネル名によって分けるのは禁止（結局2つの実装を抱えることになり、まとめた意味が無くなる）。
 *
 * ATTENTION: 取り込みには applySharedAgentMethods を使う（Object.assign を直接使わないこと）。理由は
 * その関数の説明を参照。
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

const { thinkingBudgetForModel } = require('./llm-models');
const { extractUsage } = require('./llm-client');
const { synthesizeSpeech } = require('./tts-client');
const fs = require('fs');
const { writeJsonFile } = require('./atomic-json');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const { normalizeLargeNumbersForSpeech } = require('./number-speech-format');
const { normalizeCompassDirectionsForSpeech } = require('./compass-direction-format');
const { normalizeReadingsForSpeech } = require('./dictionary-reading-format');
const { getLogger } = require('../logger');
const sfxLibrary = require('../sfx-library');
const activityDb = require('../activity-db');
const agentDiary = require('./agent-diary');

// リスナーの情報は、どのチャンネルからも Live の設定（data/config.json）を読む。リスナーは1人で、
// 名前や起きる時刻などは Live の設定にまとめてあるため
const LIVE_CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

// 秘書が会話から学んでまとめたリスナー像。secretary-memory.js を読み込むと重い依存が付くので、
// 作られたファイルを直接読むだけにする（LLM は呼ばない）
const LISTENER_DIGEST_PATH = path.join(__dirname, '..', 'data', 'secretary', 'memory', 'digest.json');

// 秘書が読み取った資産のまとめ（ほかのチャンネルへ渡してよい範囲）。上と同じ理由で、ファイルを直接読む
const FINANCE_PUBLIC_SUMMARY_PATH = path.join(__dirname, '..', 'data', 'secretary', 'memory', 'finance_public_summary.json');

/** 取り込む共通のメソッド（ファイルの冒頭参照）。 */
const sharedAgentMethods = {
  /**
   * 指定した長さの無音の音声を作る。
   * @param {number} ms 長さ（ミリ秒。0〜3000 に収める）
   * @returns {Buffer} 無音の音声
   */
  _makeSilencePcm(ms) {
    const samples = Math.round(24000 * Math.max(0, Math.min(ms, 3000)) / 1000);
    return Buffer.alloc(samples * 2, 0);
  },

  /**
   * 1文ぶんの音声を用意する。間（PAUSE）と効果音（SFX）の印はそれぞれの形に、先に作ってあればそれを、
   * 無ければその場で合成する。
   * @param {string} sentence 文、または間・効果音の印
   * @param {string} agentKey 話すエージェントのキー
   * @param {any} [preloaded] 先に作ってある音声
   * @returns {Promise<any>} 音声、または間・効果音を表すもの
   */
  _collectPcmOrPause(sentence, agentKey, preloaded = null) {
    const pauseMatch = sentence.match(/^\[PAUSE:(\d+)\]$/);
    if (pauseMatch) return Promise.resolve({ __silenceMs: parseInt(pauseMatch[1], 10) });
    const sfxMatch = sentence.match(/^\[SFX:(\w+)\]$/);
    if (sfxMatch) {
      const name = sfxMatch[1].toLowerCase();
      return sfxLibrary.getSfxPcm(name).then(buf => ({ __sfxPcm: buf }));
    }
    if (preloaded !== null) return Promise.resolve(preloaded);
    return this._collectPcm(sentence, agentKey);
  },

  /**
   * セリフの中に書ける演技のタグ（[laughs] など）の使い方の案内（日本語）。セリフを書かせる指示に足して使う。
   * ATTENTION: タグは声に出して読まれない制御の記号であることと、1回の発話に1つまでであることを必ず書く。
   * 書かないと、ト書きの禁止とぶつかったり、使いすぎて不自然になったりする。
   * @returns {string} 指示に足す文
   */
  _geminiInlineTagGuidanceJa() {
    return '・【表現力タグ（任意・控えめに）】このテキストはGemini TTSでそのまま音声合成されます。' +
      '感情を強く込めたい一言の直前にだけ、半角角括弧の演技タグを埋め込むことができます' +
      '（例:「[laughs]あはは、それは傑作ですね」「[whispers]ここだけの話ですが」）。' +
      'これはナレーション文やト書きとは別物の、TTSへの制御記号です。音声として読み上げられることはありません。\n' +
      'よく使う例: [laughs] [sighs] [whispers] [excitedly] [nervously] [sarcastically]\n' +
      '使用は1回の発話につき最大1個まで。ここぞという場面が無ければ無理に使わないでください（多用すると不自然になります）。';
  },

  /**
   * 上の英語版（英語で話すパーソナリティ向け）。
   * @returns {string} 指示に足す文
   */
  _geminiInlineTagGuidanceEn() {
    return '[Expressive tags — optional, use sparingly] This text will be synthesized as-is by Gemini TTS. ' +
      'You may embed a bracketed acting tag right before a moment of strong emotion ' +
      '(e.g. "[laughs] Oh, that\'s a classic," "[whispers] Between you and me,"). ' +
      'This is a synthesis control marker, not narration or a stage direction — it will never be spoken aloud.\n' +
      'Common tags: [laughs] [sighs] [whispers] [excitedly] [nervously] [sarcastically]\n' +
      'Use at most once per turn. Skip it entirely if there\'s no clear emotional beat — overuse sounds unnatural.';
  },

  /**
   * 文を読み上げた音声を作る。合成そのものは lib/tts-client.js に任せ、ここでは受け取った音声を
   * ffmpeg で 24kHz に変換し、音量をそろえて返す。所要時間と使用量も記録する。
   *
   * ATTENTION: プロバイダーに依らない後処理だけをここに置くこと（合成の呼び出し方は層に隠す）。
   * 読み上げは放送の費用の1割以上を占めるので、他社へ移れる形を保つ。
   *
   * @param {string} text 読み上げる文
   * @param {string} [voiceName] 声の名前
   * @param {any} [options] 声の演技の指定（文字列なら instruction として扱う）
   * @param {any} [agentKey] 記録用のエージェントのキー
   * @returns {Promise<Buffer>} 音声（24kHz・1チャンネル）
   */
  async _geminiSynthesizeToBuffer(text, voiceName = 'Kore', options = {}, agentKey = null) {
    const direction = (typeof options === 'string') ? { instruction: options } : options;
    const _ttsStart = Date.now();

    const { audio, mimeType, usage, model } = await synthesizeSpeech({
      text,
      voice: voiceName,
      direction,
      creds: this.getCredentials(),
      logLabel: `${this._channelId} TTS`,
    });

    // ここから下は、どのプロバイダーから取っても同じ音声の処理
    const mimeTypeLower = (mimeType || '').toLowerCase();
    const isPcm = mimeTypeLower.startsWith('audio/pcm') || mimeTypeLower.startsWith('audio/l16');
    const rateMatch = (mimeType || '').match(/rate=(\d+)/);
    const inputRate = rateMatch ? rateMatch[1] : '24000';

    const ffmpegArgs = isPcm
      ? ['-f', 's16le', '-ar', inputRate, '-ac', '1', '-i', 'pipe:0',
         '-af', 'loudnorm=I=-14:LRA=7:TP=-1',
         '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', 'pipe:1']
      : ['-i', 'pipe:0',
         '-af', 'loudnorm=I=-14:LRA=7:TP=-1',
         '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', 'pipe:1'];

    return await new Promise((resolve, reject) => {
      const chunks = [];
      const ffmpeg = spawn(ffmpegStatic, ffmpegArgs);
      ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
      ffmpeg.stdout.on('end', () => {
        const pcm = Buffer.concat(chunks);
        // ATTENTION: 記録の名前（tts_gemini）は変えない。稼働レポートの集計がこの名前を見ている。
        // 所要時間は ffmpeg まで含めて測りたいので、ここで記録する
        activityDb.logEvent(this._activitySessionId, 'tts_gemini', {
          agent: agentKey,
          durationMs: Date.now() - _ttsStart,
          chars: text.length,
          metadata: { model, voice: voiceName, ...usage },
        });
        resolve(pcm);
      });
      ffmpeg.stderr.on('data', () => {});
      ffmpeg.on('error', reject);
      ffmpeg.stdin.write(audio);
      ffmpeg.stdin.end();
    });
  },

  /**
   * 代わりの読み上げ（本命の合成が失敗したときに使う）。
   * @param {string} text 読み上げる文
   * @param {string|null} [audioFilter] 'telephone' なら国際電話ふうに音の幅を狭める（海外レポート用）
   * @returns {Promise<Buffer>} 音声（24kHz・1チャンネル）
   */
  async _googleSynthesizeToBuffer(text, audioFilter = null) {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ja&client=tw-ob&q=${encodeURIComponent(text)}`;
    const response = await fetch(ttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`Google TTS HTTP ${response.status}`);
    const mp3Buffer = Buffer.from(await response.arrayBuffer());

    const _ffmpegArgsG = ['-i', 'pipe:0'];
    if (audioFilter === 'telephone') {
      _ffmpegArgsG.push('-af', 'highpass=f=300:poles=2,lowpass=f=3400:poles=2,acompressor=threshold=0.1:ratio=8:attack=0.5:release=60:makeup=2,loudnorm=I=-14:LRA=7:TP=-1');
    } else {
      _ffmpegArgsG.push('-af', 'loudnorm=I=-14:LRA=7:TP=-1');
    }
    _ffmpegArgsG.push('-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', 'pipe:1');

    return new Promise((resolve, reject) => {
      const chunks = [];
      const ffmpeg = spawn(ffmpegStatic, _ffmpegArgsG);

      ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
      ffmpeg.stdout.on('end', () => resolve(Buffer.concat(chunks)));
      ffmpeg.stderr.on('data', () => {}); // ffmpeg の進み具合の出力を捨てる
      ffmpeg.on('error', err => {
        getLogger().error(`[${this._channelId} TTS] ffmpeg error (Google): ${err.message}`);
        reject(err);
      });

      ffmpeg.stdin.write(mp3Buffer);
      ffmpeg.stdin.end();
    });
  },

  /**
   * 1文を読み上げた音声を作って返す（再生はしない）。再生と並行して呼べば、文と文の間が空かない。
   * 本命の合成が失敗したら、代わりの読み上げに切り替える。最後まで失敗したら空の音声を返す。
   * @param {string} text 読み上げる文
   * @param {string} agentKey 話すエージェントのキー
   * @returns {Promise<Buffer>} 音声（失敗すれば空）
   */
  async _collectPcm(text, agentKey) {
    const config = this.getConfig();
    const agent  = (config.agents && config.agents[agentKey]) || {};
    const volume = agent.volume ?? 1.0;  // config.json の volume（デフォルト等倍）

    // 読み上げる前の下ごしらえ。
    // ATTENTION: 順番を変えないこと（組み込みの決まり → 管理画面の発声辞書 → 汎用の辞書）。汎用の辞書を先に
    // 当てると、手で登録した正しい読みに直るより前に別の読みへ変わってしまい、発声辞書が二度と当たらなくなる
    text = this._builtinNormalizeTtsText(text);
    text = this._normalizeTtsText(text);
    text = await normalizeReadingsForSpeech(text);

    const audioFilter = this._ttsAudioFilterFor(agentKey);

    try {
      let pcm;
      // 番組ごとに声を決めるチャンネル（音楽など）では、エージェントに指定が無ければ番組の設定を使う
      const voiceName = agent.gemini_voice || config.program?.gemini_tts_voice || 'Kore';
      const ttsOpts   = {
        name:         agent.name              || '',
        profileTitle: agent.tts_profile_title || '',
        scene:        agent.tts_scene         || '',
        style:        agent.tts_style || agent.gemini_instruction
                      || config.program?.gemini_tts_instruction || '',
        accent:       agent.tts_accent        || '',
        pacing:       agent.tts_pacing        || '',
        context:      agent.tts_context       || '',
        languageCode: agent.gemini_language   || null,
      };
      try {
        pcm = await this._geminiSynthesizeToBuffer(text, voiceName, ttsOpts, agentKey);
      } catch (geminiErr) {
        getLogger().warn(`[${this._channelId} TTS] Gemini TTS 失敗 → Google TTS にフォールバック: ${geminiErr.message}`);
        pcm = await this._googleSynthesizeToBuffer(text, audioFilter);
      }
      // 管理画面の音量の設定を掛ける（1.0 ならそのまま）
      return Math.abs(volume - 1.0) < 0.01 ? pcm : this._applyVolumeToPcm(pcm, volume);
    } catch (e) {
      this._onTtsSynthesisFailure(agentKey, e);
      return Buffer.alloc(0);
    }
  },

  /**
   * 代わりの読み上げのときに掛ける音のフィルター（_collectPcm のフック）。
   * 既定は無し。Live だけが海外レポートで国際電話ふうにするため上書きしている。
   *
   * 引数 _agentKey: 話すエージェントのキー
   * @returns {string|null} フィルターの名前（無ければ null）
   */
  _ttsAudioFilterFor(_agentKey) {
    return null;
  },

  /**
   * 読み上げが最後まで失敗したときの後始末（_collectPcm のフック）。
   * 既定はログと記録だけ。Live はこれに加えて画面へも知らせるため上書きしている。
   *
   * 引数 agentKey: 話すエージェントのキー
   * 引数 err: 失敗の内容
   * @returns {void}
   */
  _onTtsSynthesisFailure(agentKey, err) {
    getLogger().error(`[${this._channelId} TTS] ${agentKey}: ${err.message}`);
    activityDb.logEvent(this._activitySessionId, 'system_error', {
      agent: agentKey,
      metadata: { code: 'TTS_FAILED', message: err.message?.slice(0, 200) },
    });
  },

  /**
   * 音声に音量を掛けた新しい音声を返す（元は変えない）。
   * @param {Buffer} pcm 音声
   * @param {number} vol 倍率
   * @returns {Buffer} 音量を変えた音声
   */
  _applyVolumeToPcm(pcm, vol) {
    const out = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length - 1; i += 2) {
      const sample = pcm.readInt16LE(i);
      const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * vol)));
      out.writeInt16LE(scaled, i);
    }
    return out;
  },

  /**
   * 効果音を、そのエージェントの発話として鳴らす（話している印と画面への知らせも出す）。
   * @param {string} sfxName 効果音の名前
   * @param {string} agentKey エージェントのキー
   * @param {number} [pan] 左右の位置
   * @returns {Promise<void>}
   */
  async _playSfxAsAgent(sfxName, agentKey, pan = 0) {
    const pcm = await sfxLibrary.getSfxPcm(sfxName);
    if (!pcm) return;
    this._broadcast({ event: 'AGENT_SPEAKING', agent: agentKey });
    this.mixer.setSpeakerBusy(true);
    try {
      await this._injectAndWait(pcm, pan);
    } finally {
      this.mixer.keepSpeakerBusyMs(300);
      this._broadcast({ event: 'AGENT_SILENT', agent: agentKey });
    }
  },

  /**
   * 曲の再生が終わった知らせを受けて、待っている処理を先へ進める。
   * @returns {void}
   */
  spotifyPlayDone() {
    if (this._spotifyPlayResolve) {
      clearTimeout(this._spotifyPlayTimer);
      this._spotifyPlayResolve();
      this._spotifyPlayResolve = null;
    }
  },

  /**
   * 音声をミキサーの話し声の側へ流し込み、流し終わるまで待つ。
   * @param {Buffer} pcmBuffer 音声
   * @param {number} [pan] 左右の位置
   * @returns {Promise<void>}
   */
  async _injectAndWait(pcmBuffer, pan = 0) {
    if (!pcmBuffer || pcmBuffer.length === 0) return;
    // ミキサー側に10秒ぶんの余裕があるので、まとめて流し込んでも溢れない
    this.mixer.injectTalkAudio(pcmBuffer, 24000, pan);
    await this.mixer.waitForTalkDrain();
  },

  /**
   * 読み上げる前の下ごしらえのうち、組み込みの決まり（発声辞書より先に当てる）。
   * 日付の特別な読み・数え方の促音・ヶ月とヶ所・日本語の直後の括弧の中の英字の除去・方位・大きな数。
   * @param {string} text 読み上げる文
   * @returns {string} 直した文
   */
  _builtinNormalizeTtsText(text) {
    // ── 日付の特別な読み ────────────────────────────────────────────
    // ATTENTION: 長いものを先に置くこと（先に短いものが当たると崩れる）
    text = text.replace(/月24日/g, '月にじゅうよっか');
    text = text.replace(/月20日/g, '月はつか');
    text = text.replace(/月14日/g, '月じゅうよっか');
    text = text.replace(/月10日/g, '月とおか');
    text = text.replace(/月9日/g,  '月ここのか');
    text = text.replace(/月8日/g,  '月ようか');
    text = text.replace(/月7日/g,  '月なのか');
    text = text.replace(/月6日/g,  '月むいか');
    text = text.replace(/月5日/g,  '月いつか');
    text = text.replace(/月4日/g,  '月よっか');
    text = text.replace(/月3日/g,  '月みっか');
    text = text.replace(/月2日/g,  '月ふつか');
    text = text.replace(/月1日/g,  '月ついたち');

    // ── 「一」＋数え方の促音 ────────────────────────────────────────
    text = text.replace(/一曲/g, 'いっきょく');
    text = text.replace(/一首/g, 'いっしゅ');
    text = text.replace(/一冊/g, 'いっさつ');
    text = text.replace(/一個/g, 'いっこ');
    text = text.replace(/一本/g, 'いっぽん');
    text = text.replace(/一足/g, 'いっそく');
    text = text.replace(/一杯/g, 'いっぱい');
    text = text.replace(/一棟/g, 'いっとう');
    text = text.replace(/一発/g, 'いっぱつ');
    text = text.replace(/一服/g, 'いっぷく');
    text = text.replace(/一歩/g, 'いっぽ');

    // ── ヶ月 / ヶ所 ──────────────────────────────────────────────────
    text = text.replace(/([0-9０-９]+)[ヶヵ]月/g, (_, n) => `${n}かげつ`);
    text = text.replace(/([0-9０-９]+)[ヶヵ]所/g, (_, n) => `${n}かしょ`);

    // ── 方位（風向きなど）の読み違いを直す ─────────────────────────────
    // 中身は compass-direction-format.js（秘書の側からも同じ変換を使うので、式が2か所に分かれないように）
    text = normalizeCompassDirectionsForSpeech(text);

    // ── 日本語の直後の括弧の中の英字を消す（同じ言葉を二度読まないため）───────
    // 例: ナスダック(nasdaq) → ナスダック。括弧の中が日本語や数字だけなら消さない
    text = text.replace(
      /([぀-ゟ゠-ヿ一-龯㐀-䶿])\s*[\(（]([A-Za-z][A-Za-z0-9\s\.\-\&\,\/]*?)[\)）]/g,
      '$1'
    );

    // ── 大きな数を「万・億」の区切りに直す ─────────────────────────────
    // BUGFIX: 3桁ごとのカンマのままでは、5桁以上で日本語の区切り（1万＝4桁）とずれ、金額を読み違える。
    // 中身は number-speech-format.js（秘書の側からも同じ変換を使う）
    text = normalizeLargeNumbersForSpeech(text);

    return text;
  },

  /**
   * 認証情報（credentials.json）を読む。
   * @returns {Record<string, any>} 認証情報（読めなければ空）
   */
  getCredentials() {
    try {
      return JSON.parse(fs.readFileSync(this.credentialsPath, 'utf-8'));
    } catch (e) {
      return {};
    }
  },

  /**
   * 応答の使用量（トークン数）を、記録に載せる形にする。中身は llm-client の extractUsage に任せる。
   * 読み上げや画像の生成など、文の生成の形に乗らない経路から呼ばれるのでここに残してある。
   * @param {any} usageMetadata 応答の usageMetadata
   * @returns {Record<string, any>} 記録に載せる形
   */
  _extractGeminiUsage(usageMetadata) {
    return extractUsage(usageMetadata);
  },

  /**
   * 呼び出しに渡す思考の設定を、モデルに応じて作る。どのモデルを切ってよいかは llm-models.js が持つ。
   *
   * BUGFIX: 思考を切ってよいモデルの一覧を、ここに書かないこと。2か所に書いていたころ、モデルを替えたときに
   * 片方の更新が漏れ、思考が切れないまま処理が何倍も遅くなっていた。
   * ATTENTION: includeThoughts は必ず true のままにする（思考が本文に漏れたときの検知に要る）。
   *
   * @param {string} model モデル名
   * @returns {{thinkingBudget: any, includeThoughts: boolean}} 思考の設定
   */
  _thinkingConfigFor(model) {
    return {
      thinkingBudget: thinkingBudgetForModel(model),
      includeThoughts: true,
    };
  },

  // ── 思考の漏れの検知と切り落とし（全チャンネル・全経路で唯一の実装）──────
  // モデルが内部の検討や下書きに印を付け損ねることがあり、そのまま本文に混ざって放送に乗る。
  // 印で落とすだけでは足りないので、ここが二段目の備えになる。
  // ATTENTION: 検知の条件はここにだけ書くこと。経路ごとに書き足していたころ、そのとき通った経路にしか
  // 対策が入らず、同じ種類の漏れが別の経路で何度も再発した。

  /**
   * 文の全体に、思考の漏れらしい印（見出し・箇条書き・強調の多用・検討を表す言葉）があるか。
   * @param {string} text 生成された文
   * @returns {boolean} 漏れの疑いがあれば true
   */
  _hasReasoningLeakSignal(text) {
    const hasListLikeLine = /^\s*(?:[*\-・]|\d+[.)])\s/m.test(text);
    return /^#{1,3}\s/m.test(text)
      || /思考プロセス|構成案|要件の確認|最終案の調整|最終チェック|組み立て直し|下書き/.test(text)
      || (text.match(/\*\*[^*\n]{2,30}\*\*/g) || []).length >= 3
      || hasListLikeLine;
  },

  /**
   * 「これから◯◯のセリフを作成します」のような、書く前の宣言の一文か。
   * そのまま読み上げに回すと放送に乗るうえ、合成が止まって無音になる原因にもなる。
   * @param {string} sentence 1文
   * @returns {boolean} 宣言の一文なら true
   */
  _isMetaAnnouncement(sentence) {
    return /(セリフ|コメント|挨拶|紹介文?|ナレーション|台本|原稿)を(作成|生成|執筆|考案)します[。.]?$/.test(sentence);
  },

  /**
   * 1文が、思考や下書きの切れ端か（文ごとに届くストリーミング用）。
   * 全体をまとめて見る _collapseReasoningLeak と違い、文が決まるたびに判定する。
   * @param {string} sentence 1文
   * @returns {boolean} 切れ端なら true
   */
  _isReasoningLeakSentence(sentence) {
    return /^#{1,3}\s/.test(sentence)
      || /^[*\-・]\s/.test(sentence)
      || /^\d+[.)]\s/.test(sentence)
      || /^\(.{0,10}文字\)/.test(sentence)
      || /文字数チェック|文字数制限|合計[:：].{0,40}=\s*\d+文字|を短縮|の余地がある|調整が必要|下書き|最終チェック|組み立て直し/.test(sentence);
  },

  /**
   * そのエージェントが日本語で話す想定か（人物の設定の文で判定する）。
   * 英語の思考の前置きを落としてよいかの判断に使う。
   * ATTENTION: 生成された文ではなく設定の文で判定すること。生成の側は漏れで汚れている可能性がある。
   * @param {string} systemPrompt 人物の設定の文
   * @returns {boolean} 日本語で話す想定なら true
   */
  _promptExpectsJapanese(systemPrompt) {
    if (!systemPrompt) return true;
    const jp = (systemPrompt.match(/[ぁ-んァ-ヶ一-龯]/g) || []).length;
    const en = (systemPrompt.match(/[A-Za-z]/g) || []).length;
    return jp * 3 >= en;
  },

  /**
   * 思考の混ざった文から、実際に話すべき本文だけを取り出す。
   *
   * 漏れの印が無ければ、そのまま返す。印はあるが安全な本文を取り出せないときは null を返す
   * （呼び出し元が作り直す。混ざったまま放送するより安全）。
   *
   * ATTENTION: JSON を作らせるときなど、話す文でない呼び出しには使わないこと。
   * ATTENTION: 英語で話すエージェントでは detectEnglishPrefix を false にすること。本物の英語のセリフを
   * 思考とみなして削ってしまう。呼び出し元は _promptExpectsJapanese の結果をそのまま渡せばよい。
   *
   * @param {string} text 生成された文
   * @param {{detectEnglishPrefix?: boolean}} [opts] 英語の前置きを落とすか（既定 true）
   * @returns {string|null} 本文（漏れが無ければそのまま。取り出せなければ null）
   */
  _collapseReasoningLeak(text, opts = {}) {
    if (!text) return text;
    const { detectEnglishPrefix = true } = opts;

    // ── 英語の思考の前置きを落とす ──────────────────────────────────────
    // BUGFIX: 英語の検討文が印なしで本文の前にくっついて届くことがある。日本語の言葉や記号を見る検知では
    // まったく反応しないので、ここが唯一の備えになる。
    // 後ろから見て日本語の文が続く所までを本文とし、その前が英語ばかりなら思考とみなして落とす
    if (detectEnglishPrefix) {
      const _sentences = text.split(/(?<=[。．！？!?.])/);
      const _latinOf = (s) => (s.match(/[A-Za-z]/g) || []).length;
      const _jpOf    = (s) => (s.match(/[ぁ-んァ-ヶ一-龯]/g) || []).length;
      const _isEnglishSentence = (s) => { const l = _latinOf(s); return l >= 10 && l > _jpOf(s) * 2; };
      // 後ろから走査し、英語文に突き当たった位置を本文サフィックスの境界とする
      let _cut = 0;
      for (let i = _sentences.length - 1; i >= 0; i--) {
        if (_isEnglishSentence(_sentences[i])) { _cut = i + 1; break; }
      }
      if (_cut > 0 && _cut < _sentences.length) {
        const _prefix = _sentences.slice(0, _cut).join('');
        const _rest   = _sentences.slice(_cut).join('').trim();
        // 前置きが英語ばかりで、残りが十分な日本語のときだけ落とす。
        // ATTENTION: 英語と日本語の比の境目（2.2）は実際の発話5,500件あまりで調整した値。下げると、日英を
        // 交ぜて話すエージェントの本物のセリフを削ってしまい、上げると本物の漏れを取りこぼす
        const _ENGLISH_PREFIX_DOMINANCE = 2.2;
        if (_latinOf(_prefix) >= 60 && _latinOf(_prefix) > _jpOf(_prefix) * _ENGLISH_PREFIX_DOMINANCE &&
            _rest.length >= 20 && _jpOf(_rest) >= 10) {
          getLogger().warn(`[${this._channelId} Gemini] 英語の内部思考プレフィックスを検知→除去 (${_prefix.length}文字)`);
          text = _rest;
        }
      }
    }

    if (!this._hasReasoningLeakSignal(text)) return text;

    const paragraphs = text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
    const segments = paragraphs.length > 1 ? paragraphs : text.split(/\n+/).map(p => p.trim()).filter(Boolean);

    // BUGFIX: 段落は、先頭の行だけでなく全部の行を見て判定する。先頭だけを見ていたころ、見出しに続けて
    // 箇条書きが並ぶ段落を、ふつうの文として見逃していた
    const isListLikeSegment = (p) => {
      const lines = p.split('\n').map(l => l.trim()).filter(Boolean);
      return lines.some(l => /^#{1,3}\s|^[*\-・]\s|^\d+[.)]\s/.test(l));
    };
    const isClean = (p) => {
      if (p.length < 20) return false;
      if (/\*\*/.test(p)) return false;
      if (/思考プロセス|構成案|要件の確認|最終案|最終チェック|再構成|スタンス表明/.test(p)) return false;
      if (isListLikeSegment(p)) return false;
      return true;
    };

    for (let i = segments.length - 1; i >= 0; i--) {
      if (isClean(segments[i])) {
        // BUGFIX: 末尾から続く安全な段落をまとめて採る。1段落だけを返していたころ、本文が複数の段落に
        // 分かれていると最後の段落しか残らず、締めの一言だけが放送に乗って中身が丸ごと失われた
        let _start = i;
        while (_start - 1 >= 0
               && isClean(segments[_start - 1])
               && !this._hasReasoningLeakSignal(segments[_start - 1])) {
          _start--;
        }
        const _adopted = segments.slice(_start, i + 1).join('\n\n');
        const _discarded = segments.slice(0, _start).join('\n\n');
        getLogger().warn(`[${this._channelId} Gemini] 内部思考の混入を検知→末尾の発言部分のみ採用`
          + `（採用${_adopted.length}文字 / 元${text.length}文字・${i - _start + 1}段落）`);
        // ATTENTION: 捨てた側もログに残すこと。文字数だけでは、本当に思考だったのか本文を捨てたのかが
        // 後から分からない
        if (_discarded) {
          getLogger().warn(`[${this._channelId} Gemini] 破棄した先頭部分: ${_discarded.slice(0, 300).replace(/\n/g, ' ⏎ ')}`);
        }

        // BUGFIX: 元が長いのに極端に削れた結果は、救えたのではなく本文をもぎ取った疑いが濃いので捨てて
        // 作り直させる。報道センターが、見出しを強調や番号付きで書いたためにニュース6本を丸ごと捨てられ、
        // 読み比べと締めだけを放送したことがある
        const _EXTREME_ORIGINAL_LEN = 3000;
        const _EXTREME_KEEP_RATIO   = 0.20;
        if (text.length >= _EXTREME_ORIGINAL_LEN && _adopted.length / text.length < _EXTREME_KEEP_RATIO) {
          getLogger().warn(`[${this._channelId} Gemini] 削りすぎ（残存`
            + `${(_adopted.length / text.length * 100).toFixed(1)}%）— 本文を捨てた疑いがあるため破棄して再生成に回します`);
          return null;
        }
        return _adopted;
      }
      if (isListLikeSegment(segments[i])) {
        // 箇条書きの下書きに突き当たったら、そこで探すのをやめる。それより前は同じ下書きの一部である
        // ことが多く、一見きれいに見えても誤って採ってしまう
        break;
      }
    }
    getLogger().warn(`[${this._channelId} Gemini] 内部思考の混入を検知したが安全な発言部分を抽出できず→破棄`);
    return null;
  },

  /**
   * 管理画面の発声辞書（tts_dict.json）で読みを直す（組み込みの決まりの後に当てる）。
   * @param {string} text 読み上げる文
   * @returns {string} 直した文
   */
  _normalizeTtsText(text) {
    let entries = [];
    try {
      const raw = fs.readFileSync(this.ttsDictPath, 'utf-8');
      entries = JSON.parse(raw).filter(e => e.enabled !== false);
    } catch (e) {
      // 辞書が無い・読めないときは何もしない
    }

    let result = text;
    for (const entry of entries) {
      try {
        const re = new RegExp(entry.pattern, entry.flags || 'g');
        result = result.replace(re, entry.replacement);
      } catch (e) {
        getLogger().warn(`[TtsDict] 不正な正規表現をスキップ: id=${entry.id} pattern="${entry.pattern}" — ${e.message}`);
      }
    }
    return result;
  },

  /**
   * 同じ内容が2回書かれていたら、前半だけを採る（まれにモデルが同じ文を繰り返すため）。
   * 3回以上の繰り返しは1回では縮みきらないので、変わらなくなるまで3周まで掛ける。
   * @param {string} text 生成された文
   * @returns {string} 直した文
   */
  _collapseDuplicatedWholeText(text) {
    let out = text;
    for (let pass = 0; pass < 3; pass++) {
      const next = this._collapseDuplicatedWholeTextOnce(out);
      if (next === out) break;
      out = next;
    }
    return out;
  },

  /**
   * 重複を縮める1周ぶん。隣り合う同じ長さの塊を見る方法と、末尾の一定の長さが文中にもう一度出るかを
   * 見る方法の2段で判定する。
   *
   * BUGFIX: 末尾を指紋として使う判定を外さないこと。隣り合う塊を突き合わせる方法だけでは、2つ目の複製に
   * 違う書き出しが付くと位置がずれて当たらない。実際に、レシピが丸ごと2回・6分近く放送されたことがある。
   *
   * @param {string} text 生成された文
   * @returns {string} 直した文
   */
  _collapseDuplicatedWholeTextOnce(text) {
    if (!text || text.length < 30) return text;
    const boundary = /[。！？\n]/g;
    const cuts = [];
    let m;
    while ((m = boundary.exec(text)) !== null) cuts.push(m.index + 1);
    if (cuts.length < 2) return text;

    let bestCut = null;
    for (const cut of cuts) {
      const tail = text.slice(cut).trim();
      if (tail.length < 40) continue; // 短い一致は相づちなどを誤って拾うので対象外
      const precedingStart = cut - tail.length;
      if (precedingStart < 0) continue;
      const preceding = text.slice(precedingStart, cut).trim();
      if (preceding.length < 15) continue;
      if (preceding === tail || tail.startsWith(preceding) || preceding.startsWith(tail)) {
        if (bestCut === null || cut < bestCut) bestCut = cut;
      }
    }
    if (bestCut !== null) {
      getLogger().warn(`[${this._channelId} Gemini] 生成テキストの重複を検出→前半のみ採用`);
      return text.slice(0, bestCut).trim();
    }

    // 位置のずれに左右されない判定。複製が起きたときは必ず同じ終わり方が2回現れるので、末尾を指紋にして
    // その最初の出現の直後で切る
    const FINGERPRINT_LEN = 120;   // 決まり文句の繰り返しを誤って拾わない程度に長く取る
    if (text.length >= FINGERPRINT_LEN * 2 + 80) {
      const fingerprint = text.slice(-FINGERPRINT_LEN);
      const firstIdx = text.indexOf(fingerprint);
      const cut = firstIdx + FINGERPRINT_LEN;
      // 指紋が末尾以外にもある＝同じ終わり方が2回。切り落とす側が十分に長いときだけ重複とみなす
      if (firstIdx !== -1 && cut < text.length && text.length - cut >= 80) {
        getLogger().warn(`[${this._channelId} Gemini] 生成テキストの重複を検出（末尾の指紋が再出現）`
          + `→ 前半のみ採用: ${text.length}文字 → ${cut}文字`);
        return text.slice(0, cut).trim();
      }
    }
    return text;
  },

  /**
   * Spotify のトークンを取る（覚えている間は使い回す）。
   * 期限切れで断られたら、保存してある更新用のトークンを消し、検索だけはできる形で取り直す。
   * @returns {Promise<string|null>} トークン（取れなければ null）
   */
  async _getSpotifyToken() {
    const now = Date.now();
    if (this._spotifyTokenCache?.token && now < this._spotifyTokenCache.expiresAt) {
      return this._spotifyTokenCache.token;
    }

    const creds = this.getCredentials();
    const { client_id, client_secret, refresh_token } = creds.spotify || {};
    if (!client_id || !client_secret) return null;

    const authHeader = 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64');
    const body = refresh_token
      ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token })
      : new URLSearchParams({ grant_type: 'client_credentials' });

    try {
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': authHeader },
        body,
      });
      const data = await res.json();
      if (!res.ok) {
        // 更新用のトークンが期限切れ（半年使わないと切れる）。捨てて、検索だけできる形で取り直す
        if (data.error === 'invalid_grant') {
          getLogger().error(`[${this._channelId} Spotify] refresh_token が期限切れ (invalid_grant)。管理画面で Spotify を再認証してください。`);
          const creds = this.getCredentials();
          if (creds.spotify?.refresh_token) {
            creds.spotify.refresh_token = '';
            writeJsonFile(this.credentialsPath, creds);
          }
          // 再認証までの間、検索だけは使えるようにする
          const fallbackRes = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': authHeader },
            body: new URLSearchParams({ grant_type: 'client_credentials' }),
          });
          const fallbackData = await fallbackRes.json();
          if (fallbackRes.ok && fallbackData.access_token) {
            this._spotifyTokenCache = { token: fallbackData.access_token, expiresAt: now + (fallbackData.expires_in - 60) * 1000 };
            return fallbackData.access_token;
          }
          return null;
        }
        getLogger().warn(`[${this._channelId} Spotify] トークン取得失敗 HTTP ${res.status}: ${data.error || ''}`);
        return null;
      }
      this._spotifyTokenCache = {
        token:     data.access_token,
        expiresAt: now + (data.expires_in - 60) * 1000, // 期限の60秒前に切れたことにする
      };
      return data.access_token;
    } catch (e) {
      getLogger().warn(`[${this._channelId} Spotify] トークン取得エラー: ` + e.message);
      return null;
    }
  },

  /**
   * リスナーの情報を読む（どのチャンネルからも Live の設定を読む）。
   * @returns {Record<string, any>} リスナーの情報（読めなければ空）
   */
  _getListenerProfile() {
    try {
      const liveConfig = JSON.parse(fs.readFileSync(LIVE_CONFIG_PATH, 'utf-8'));
      return liveConfig?.show?.user_profile || {};
    } catch (e) {
      return {};
    }
  },

  /**
   * 秘書が会話から学んでまとめたリスナー像（数文）を読む。作られたものを読むだけで、LLM は呼ばない。
   * @returns {string} リスナー像（まだ無ければ空文字）
   */
  _getListenerDigest() {
    try {
      const digest = JSON.parse(fs.readFileSync(LISTENER_DIGEST_PATH, 'utf-8'));
      return digest?.text || '';
    } catch (e) {
      return '';
    }
  },

  /**
   * 秘書が読み取った資産のまとめを読む（銘柄・金額・損益・推移まで含む）。渡す先は金融情報センターと
   * コメンテーター。何をどこまで渡すかの一覧は lib/listener-context.js を参照。
   * @returns {Record<string, any>|null} 資産のまとめ（まだ無ければ null）
   */
  _getFinancePortfolioSummary() {
    try {
      return JSON.parse(fs.readFileSync(FINANCE_PUBLIC_SUMMARY_PATH, 'utf-8'));
    } catch (e) {
      return null;
    }
  },

  /**
   * チャンネルの名前を、日記の置き場のフォルダー名にする（'TheAnswers' → 'the_answers'）。
   * 日記を書く側と同じ変換を、読む側でも使う。
   * @returns {string} フォルダー名
   */
  _diaryChannelId() {
    return String(this._channelId || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  },

  /**
   * そのエージェント自身の日記から作ったふり返り（週1回、agent-diary-feedback.js が作る）を読む。
   * @param {string} agentKey エージェントのキー
   * @returns {string} プロンプトに足す文（まだ無ければ空文字）
   */
  _getAgentDiarySelfDigest(agentKey) {
    try {
      const filePath = path.join(agentDiary.DIARY_DIR, this._diaryChannelId(), agentKey, 'digest.json');
      const digest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!digest?.text) return '';
      return `\n\n【自分自身の直近の振り返り（非公開の日記より）】${digest.text}`;
    } catch (e) {
      return '';
    }
  },

  /**
   * ディレクターが受け取る、出演者全員の日記から見えた編成の気づきを読む。
   * @param {string} directorAgentKey ディレクターのエージェントキー
   * @returns {string} プロンプトに足す文（まだ無ければ空文字）
   */
  _getAgentDiaryTeamDigest(directorAgentKey) {
    try {
      const filePath = path.join(agentDiary.DIARY_DIR, this._diaryChannelId(), directorAgentKey, 'team_digest.json');
      const digest = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!digest?.text) return '';
      return `\n\n【出演者たちの直近の日記から見えた編成上の気づき】${digest.text}`;
    } catch (e) {
      return '';
    }
  },

  /**
   * 番組の上での日付（YYYY-MM-DD）。リスナーの一日の始まり（day_start_hour、既定は4時）より前なら前日にする。
   * 深夜も前の日の続きとして記録するため。
   * @returns {string} 日付
   */
  _getShowDay() {
    const dayStartHour = this._getListenerProfile().day_start_hour ?? 4;
    const now = new Date();
    const d   = new Date(now);
    if (now.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  },

  /**
   * 曲の再生が終わる知らせを待つ。誰も聴いていなければすぐ返り、時間切れになれば番組を先へ進める。
   * @param {number} [timeoutMs] 待つ上限（ミリ秒）
   * @returns {Promise<void>}
   */
  _waitForSpotifyPlayDone(timeoutMs = 300000) {
    if (this.server.getClientCount() === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this._spotifyPlayResolve = resolve;
      this._spotifyPlayTimer = setTimeout(() => {
        if (this._spotifyPlayResolve === resolve) {
          getLogger().info(`[${this._channelId}] Spotify 再生タイムアウト — 次の楽曲へ`);
          this._spotifyPlayResolve = null;
          resolve();
        }
      }, timeoutMs);
    });
  },
};

/**
 * 共通のメソッドを、対象のクラスに取り込む。
 *
 * ATTENTION: Object.assign を直接使わないこと。クラス本体で定義したメソッドが、ここの既定の実装で
 * 上書きされてしまう（クラスの評価の後に代入されるため）。実際に、Live が上書きしていたフックが静かに
 * 無効になりかけた。この関数は、既にクラスが持っている名前を飛ばし、クラス側の定義を必ず優先する。
 *
 * @param {any} TargetClass 取り込む先のクラス
 * @returns {void}
 */
function applySharedAgentMethods(TargetClass) {
  for (const [name, fn] of Object.entries(sharedAgentMethods)) {
    if (Object.prototype.hasOwnProperty.call(TargetClass.prototype, name)) continue;
    TargetClass.prototype[name] = fn;
  }
}

module.exports = { sharedAgentMethods, applySharedAgentMethods };
