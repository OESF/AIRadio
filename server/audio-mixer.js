/**
 * @file BGM と話し声を混ぜて、聴いている人へ配るオーディオミキサー（と番組の録音）
 *
 * BGM（と環境音・ジングル）を鳴らしながら、エージェントの話し声を重ね、一定の間隔で1フレームずつ
 * WebSocket で配る。チャンネルごとに1つ作る（BGM のフォルダーを差し替えられる）。利用元は server.js・
 * agent-system-the-answers.js・routes/recording-routes.js。
 *
 * - 出力は 24kHz・2チャンネル・24ビットの PCM。話し声は 24kHz・1チャンネル・16ビットで受け取り、
 *   左右の振り分け（パン）を付けて混ぜる
 * - 話しているあいだは BGM を自動で下げる（ダッキング）。下げるのは速く、戻すのはゆっくり
 * - ジングルとオープニングの間は自動のダッキングを止め、フェードで音量を作る
 * - 番組の録音は ProgramRecorder（このファイルの下）が持ち、attach して出力を受け取る。無音が続く区間
 *   （曲の再生中）は書かずに飛ばす
 *
 * ATTENTION: フレームの大きさとサンプルレートは組で決まっている。片方だけ変えないこと。ダッキングの速さは
 * 1フレームあたりの量で書いてあるので、フレームの長さが変わると実際の速さも変わる。
 * ATTENTION: 使い回すバッファの大きさは必ず this.frameSize から計算すること。別の既定値を書いていたころ、
 * フレームの大きさを変えたときにここだけ取り残され、前のフレームの残りかすが毎回混ざって雑音になった。
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

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const { decodeTo24le, decodeTo24leOnce } = require('../utils/audio-decoder');
const { getLogger } = require('./logger');

/** BGM と話し声を混ぜて配るミキサー（ファイルの冒頭参照）。 */
class AudioMixer {
  /**
   * @param {{frameSize?: number, bgmDir?: string, openingDir?: string, noDummyBgm?: boolean}} [options]
   *   bgmDir と openingDir はチャンネルごとに差し替える
   */
  constructor(options = {}) {
    // 話し声は元から 24kHz で作られるので、配るのも 24kHz にする（BGM は 24kHz に落とす）。
    // 上げ直す工程が無くなり、配るデータ量も4割ほど減る
    this.sampleRate = 24000;
    this.channels = 2;
    this.bytesPerSample = 3; // 配る音は 24 ビットに固定
    // 1フレームのサンプル数。1152 / 24000 = 48ミリ秒。
    // ATTENTION: サンプルレートと組で決めること。ここだけ変えると1フレームの長さが変わり、ダッキングの
    // 速さ（1フレームあたりの量で書いてある）が実質的に変わってしまう
    this.frameSize = options.frameSize || 1152;
    this._frameMs = (this.frameSize / this.sampleRate) * 1000; // 1フレームの長さ（録音の無音を測るのに使う）
    this.use24bit = true;
    // BGM のフォルダー（チャンネルごとに差し替えられる）
    this.bgmDir     = options.bgmDir     || path.resolve(__dirname, 'assets', 'bgm');
    this.openingDir = options.openingDir || path.resolve(__dirname, 'assets', 'bgm', 'opening');

    this.clients = new Set();
    this.isBroadcasting = false;
    // ATTENTION: 一定間隔のタイマー（setInterval）は使わない。実際の時刻に合わせてずれを直しながら
    // 次を予約する。一定間隔だと、ごみ集めや入出力で遅れたぶんが積もり、聴いている側で音が途切れる
    this._mixerTimer = null;
    this._nextFrameAt = 0; // 次フレームの予定送出時刻 (Date.now() ベース)

    // 毎フレームの確保をやめ、使い回すバッファ（混ぜた結果・BGM・話し声の3つ）。
    // BUGFIX: 大きさは必ず this.frameSize から計算すること。別の既定値を書いていたころ、フレームの
    // 大きさを変えたときにここだけ取り残され、前のフレームの残りかすが毎回一緒に配られて雑音になった
    const _bytesPerFrame = this.frameSize * 2 * 3;
    this._staticMixedFrame  = Buffer.alloc(_bytesPerFrame);
    this._staticBgmPart     = Buffer.alloc(_bytesPerFrame);
    this._staticTalkPart    = Buffer.alloc(_bytesPerFrame);

    // 音量
    this.targetBgmVolume = 1.0;
    this.currentBgmVolume = 1.0;
    // ダッキングの速さ（1フレームあたりの変化量）。下げるのは速く（音が割れないように）、戻すのはゆっくり
    this.duckingSpeedDown   = 0.50;  // 下げる: 約100ミリ秒で下がりきる
    this.duckingSpeedUp     = 0.08;  // 戻す: 約500ミリ秒かけて戻る
    // 目標がほぼ0（オープニングなどの素早いフェード）のときの速さ
    this.duckingSpeedFast = 0.45;

    // 話している間（文と文の間も含む）は BGM を下げたままにする印
    this.isSpeakerBusy = false;

    // ジングルやオープニングのフェード中は、自動のダッキングを止める
    this._volumeLocked = false;
    // 進行中のフェード（やり直すときに止める）
    this._fadeInterval = null;
    // BGM が止まった後の、次の曲への切り替えのタイマー（二重に動かさないため）
    this._bgmRestartTimer = null;
    // 環境音のときの基準の音量（null なら通常の BGM）。話している間は半分に、そうでなければこの値に戻す
    this._ambientBaseVolume = null;

    // 話し声の出だしと終わりのプチ音を抑えるためのフェード
    this._prevTalkIsAudible = false;   // 前のフレームに声があったか
    this._talkPartialFadeStart = -1;   // 最後の半端なフレームで、フェードを始めるサンプルの位置

    // BGM の読み込みが速すぎて溜まりすぎないよう、止める・再開する目安
    this.bgmHighWater = this.sampleRate * 2 * 3 * 1;     // 1秒分 (上限)
    this.bgmLowWater  = Math.round(this.sampleRate * 2 * 3 * 0.5); // 0.5秒分 (再開閾値)

    this.currentBgmFile = null;
    this.bgmProcess = null;
    this.bgmStream = null; // バックプレッシャー用に decodeTo24le のストリームを保持
    this.bgmBuffer = Buffer.alloc(0);
    // ATTENTION: BGM を止めた後に、前の読み込みの続きが遅れて動いて上書きするのを防ぐための世代の番号。
    // 止めるたびに増やし、読み込みの完了時に番号が違えばその場で捨てる
    this._bgmGeneration = 0;

    // エージェント発話音声キュー/バッファ
    this.talkBuffer = Buffer.alloc(0);

    // 番組の録音（付けられている間だけ書き込む）
    this._activeRecorder = null;

    this.ensureJingleDirs();
    if (!options.noDummyBgm) this.ensureDummyBgm();
  }

  /**
   * BGM のフォルダーが空なら、確認用のサイン波の音を1つ作る。
   * @returns {void}
   */
  ensureDummyBgm() {
    if (!fs.existsSync(this.bgmDir)) {
      fs.mkdirSync(this.bgmDir, { recursive: true });
    }
    const files = fs.readdirSync(this.bgmDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
    if (files.length === 0) {
      getLogger().info('No BGM files found. Creating a dummy 440Hz sinewave test BGM...');
      const dummyPath = path.join(this.bgmDir, 'test_bgm.wav');
      
      // 10秒の音を作る。サンプルレートはミキサーに合わせておく（読み込んだときの動きをそろえるため）
      const sampleRate = this.sampleRate;
      const duration = 10; // 秒
      const numSamples = sampleRate * duration;
      const header = Buffer.alloc(44);
      
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + numSamples * 2 * 2, 4); // 16-bit stereo
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); // Subchunk1Size
      header.writeUInt16LE(1, 20); // AudioFormat PCM
      header.writeUInt16LE(2, 22); // NumChannels Stereo
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2 * 2, 28); // ByteRate
      header.writeUInt16LE(4, 32); // BlockAlign
      header.writeUInt16LE(16, 34); // BitsPerSample
      header.write('data', 36);
      header.writeUInt32LE(numSamples * 2 * 2, 40);

      const data = Buffer.alloc(numSamples * 2 * 2);
      for (let i = 0; i < numSamples; i++) {
        // 左と右に違う高さの音を、少し音量を下げて書く
        const sampleL = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 8000;
        const sampleR = Math.sin(2 * Math.PI * 330 * (i / sampleRate)) * 8000;
        
        data.writeInt16LE(Math.floor(sampleL), i * 4);
        data.writeInt16LE(Math.floor(sampleR), i * 4 + 2);
      }

      fs.writeFileSync(dummyPath, Buffer.concat([header, data]));
      getLogger().info('Dummy BGM created successfully at', dummyPath);
    }
  }

  /**
   * オープニングのジングルのフォルダーが無ければ作る。
   * @returns {void}
   */
  ensureJingleDirs() {
    if (!fs.existsSync(this.openingDir)) fs.mkdirSync(this.openingDir, { recursive: true });
  }

  /**
   * フォルダーの中から MP3 を1つ選ぶ。
   * @param {string} dir フォルダー
   * @returns {string|null} ファイルのパス（無ければ null）
   */
  _pickMp3FromDir(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) return null;
    return path.join(dir, files[Math.floor(Math.random() * files.length)]);
  }

  /**
   * 聴いている人（WebSocket）を登録する。最初の1人で配信を始め、切れたら自動で外す。
   * @param {any} ws WebSocket
   * @returns {void}
   */
  registerClient(ws) {
    this.clients.add(ws);
    if (!this.isBroadcasting) {
      this.startBroadcast();
    }
    ws.on('close', () => {
      this.unregisterClient(ws);
    });
  }

  /**
   * 聴いている人を外す。誰もいなくなったら配信を止める。
   * @param {any} ws WebSocket
   * @returns {void}
   */
  unregisterClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0 && this.isBroadcasting) {
      this.stopBroadcast();
    }
  }

  /**
   * BGM のフォルダーから、次に流す曲を選ぶ（直前の曲は候補から外す）。
   * @returns {string|null} ファイル名（1つも無ければ今の曲、または null）
   */
  _pickNextBgmFile() {
    const files = fs.readdirSync(this.bgmDir)
      .filter(f => (f.endsWith('.mp3') || f.endsWith('.wav')) && !f.startsWith('.'));
    if (files.length === 0) return this.currentBgmFile || null;
    if (files.length === 1) return files[0];
    const candidates = files.filter(f => f !== this.currentBgmFile);
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    getLogger().info(`[Mixer] BGM shuffle: ${this.currentBgmFile} → ${next}`);
    return next;
  }

  /**
   * フォルダーの中の MP3 を順不同で続けて流す（海外レポートなどの環境音用）。
   * 全部流したら並べ直して繰り返す。止めるのは stopBgm。
   * @param {string} folderPath 環境音のフォルダー
   * @param {number} [volume] 音量（0〜1）。この値を基準にダッキングする
   * @returns {boolean} 始められたら true
   */
  playAmbientShuffle(folderPath, volume = 0.25) {
    this.stopBgm();
    if (!fs.existsSync(folderPath)) {
      getLogger().error(`[Mixer ERROR] Ambient folder not found: ${folderPath}`);
      return false;
    }
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) {
      getLogger().warn(`[Mixer] No MP3 files in ambient folder: ${folderPath}`);
      return false;
    }

    this._ambientFolder     = folderPath;
    this._ambientFiles      = null; // 最初の1回は次の関数の中で並べる
    this._ambientIndex      = 0;
    this._ambientBaseVolume = volume; // 自動のダッキングの上と下をこの値に合わせる

    // 音量はすぐ反映する（自動のダッキングは止めない）
    this.currentBgmVolume = volume;
    this.targetBgmVolume  = volume;

    this._playNextAmbient(folderPath, volume);
    return true;
  }

  /**
   * 環境音の次のファイルを流す。並びを使い切ったら並べ直して最初から。
   * ATTENTION: 途中で止められた（別の音が始まった）ら、その場でやめること。
   * @param {string} folderPath 環境音のフォルダー
   * @param {number} volume 音量
   * @returns {void}
   */
  _playNextAmbient(folderPath, volume) {
    if (this._ambientFolder !== folderPath) return;

    if (!this._ambientFiles || this._ambientIndex >= this._ambientFiles.length) {
      const files = fs.readdirSync(folderPath)
        .filter(f => f.endsWith('.mp3'))
        .map(f => path.join(folderPath, f));
      for (let i = files.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [files[i], files[j]] = [files[j], files[i]];
      }
      this._ambientFiles = files;
      this._ambientIndex = 0;
      getLogger().debug(`[Mixer] Ambient shuffle: リスト再構築 ${files.length}件`);
    }

    const filePath = this._ambientFiles[this._ambientIndex++];
    getLogger().info(`[Mixer] Ambient shuffle: ${path.basename(filePath)} (${this._ambientIndex}/${this._ambientFiles.length})`);

    decodeTo24leOnce(filePath)
      .then(stream => {
        if (this._ambientFolder !== folderPath) {
          // 読み込みが終わる前に止められていたら捨てる
          stream.destroy();
          return;
        }
        this.use24bit   = true;
        this.bgmStream  = stream;
        this.bgmProcess = { kill: () => { stream.destroy(); this.bgmStream = null; } };

        stream.on('data', chunk => {
          this.bgmBuffer = Buffer.concat([this.bgmBuffer, chunk]);
          if (this.bgmBuffer.length > this.bgmHighWater) stream.pause();
        });
        stream.on('error', err => {
          getLogger().error('[Mixer] Ambient stream error:', err);
          // 失敗しても次のファイルへ
          if (this._ambientFolder === folderPath) {
            setTimeout(() => this._playNextAmbient(folderPath, this.currentBgmVolume || volume), 1000);
          }
        });
        stream.on('end', () => {
          this.bgmProcess = null;
          this.bgmStream  = null;
          // 1曲終わったら次へ（止められていなければ）
          if (this._ambientFolder === folderPath) {
            setTimeout(() => this._playNextAmbient(folderPath, this.currentBgmVolume || volume), 100);
          }
        });
      })
      .catch(err => {
        getLogger().error('[Mixer] Ambient play error:', err);
        if (this._ambientFolder === folderPath) {
          setTimeout(() => this._playNextAmbient(folderPath, this.currentBgmVolume || volume), 2000);
        }
      });
  }

  /**
   * BGM を1曲流す。終わったら次の曲へ移る。読み込みに失敗したときは少し待って次の曲を試す。
   * @param {string} filename BGM のフォルダーの中のファイル名
   * @returns {boolean} 始められたら true
   */
  playBgm(filename) {
    this.stopBgm(); // ここで世代の番号も増える
    const _gen = this._bgmGeneration; // 止めた後の番号を控え、遅れて動く読み込みを見分ける
    const filePath = path.join(this.bgmDir, filename);
    if (!fs.existsSync(filePath)) {
      getLogger().error(`[Mixer ERROR] BGM file not found: ${filePath}`);
      return false;
    }
    this.currentBgmFile = filename;
    decodeTo24leOnce(filePath)
      .then(stream => {
        // 読み込みが終わる前に止められていたら捨てる
        if (this._bgmGeneration !== _gen) { stream.destroy(); return; }
        this.use24bit = true;
        this.bgmStream = stream;
        this.bgmProcess = { kill: () => {
          stream.destroy();
          this.bgmStream = null;
        }};

        stream.on('data', chunk => {
          this.bgmBuffer = Buffer.concat([this.bgmBuffer, chunk]);

          // 溜まりすぎたら読み込みを止める（実時間よりずっと速く読むため）
          if (this.bgmBuffer.length > this.bgmHighWater) {
            stream.pause();
          }
        });
        stream.on('error', err => {
          getLogger().error(`[Mixer ERROR] BGM decode stream error:`, err);
          this.use24bit = false;
          // 読み込みに失敗したので、少し待って次の曲へ
          if (this.isBroadcasting && !this._bgmRestartTimer) {
            this._bgmRestartTimer = setTimeout(() => {
              this._bgmRestartTimer = null;
              if (this.isBroadcasting) {
                const next = this._pickNextBgmFile();
                if (next) {
                  getLogger().info(`[Mixer] BGM error → shuffle restart: ${next}`);
                  this.playBgm(next);
                }
              }
            }, 5000);
          }
        });
        stream.on('end', () => {
          this.bgmProcess = null;
          this.bgmStream = null;
          // 1曲終わったので次の曲へ
          if (this.isBroadcasting && !this._bgmRestartTimer) {
            this._bgmRestartTimer = setTimeout(() => {
              this._bgmRestartTimer = null;
              if (this.isBroadcasting) {
                const next = this._pickNextBgmFile();
                if (next) {
                  getLogger().info(`[Mixer] BGM ended → shuffle next: ${next}`);
                  this.playBgm(next);
                }
              }
            }, 500); // 曲間の間
          }
        });
      })
      .catch(err => {
        getLogger().error(`[Mixer ERROR] Failed to initialize BGM decoder for ${filename}:`, err);
        this.use24bit = false;
      });
    return true;
  }

  /**
   * BGM（環境音・ジングルを含む）を止め、溜めてある音も捨てる。
   * @returns {void}
   */
  stopBgm() {
    // 進行中の読み込みを無効にする
    this._bgmGeneration++;
    // 次の曲へ移るタイマーも止める（明示的に止めたのに勝手に始まらないように）
    if (this._bgmRestartTimer) {
      clearTimeout(this._bgmRestartTimer);
      this._bgmRestartTimer = null;
    }
    if (this.bgmProcess) {
      this.bgmProcess.kill();
      this.bgmProcess = null;
    }
    this.bgmStream = null;
    this.currentBgmFile = null;
    this.bgmBuffer = Buffer.alloc(0);
    this._ambientFolder     = null;
    this._ambientFiles      = null;
    this._ambientIndex      = 0;
    this._ambientBaseVolume = null; // 環境音をやめ、通常のダッキングに戻す
  }

  /**
   * BGM の音量を、指定した時間をかけて目標まで滑らかに変える。重ねて呼ぶと前のフェードは止まる。
   * ATTENTION: _volumeLocked を true にしてから呼ぶこと（自動のダッキングと取り合いになる）。
   * @param {number} toVol 目標の音量
   * @param {number} durationMs かける時間（ミリ秒）
   * @returns {Promise<void>} 終わったら解決する
   */
  fadeBgmTo(toVol, durationMs) {
    return new Promise(resolve => {
      if (this._fadeInterval) {
        clearInterval(this._fadeInterval);
        this._fadeInterval = null;
      }

      const fromVol = this.currentBgmVolume;
      const stepMs  = 50;
      const steps   = Math.max(1, Math.round(durationMs / stepMs));
      let step = 0;

      this._fadeInterval = setInterval(() => {
        step++;
        const progress = Math.min(1, step / steps);
        const newVol = fromVol + (toVol - fromVol) * progress;
        this.currentBgmVolume = Math.max(0, Math.min(1, newVol));
        this.targetBgmVolume  = this.currentBgmVolume; // ミキサー側の自動の追従を止める

        if (step >= steps) {
          clearInterval(this._fadeInterval);
          this._fadeInterval = null;
          this.currentBgmVolume = toVol;
          this.targetBgmVolume  = toVol;
          resolve();
        }
      }, stepMs);
    });
  }

  /**
   * フォルダーから MP3 を1つ選び、ジングルとして流す。流している間は自動のダッキングを止める。
   * 終わったら、直前に流していた BGM に戻す（restoreBgm が false なら戻さない）。
   * ファイルが無ければ、警告を出してすぐ返る。
   *
   * @param {string} dirPath MP3 の入ったフォルダー
   * @param {{fadeInMs?: number, playDurationMs?: number, fadeOutMs?: number, restoreBgm?: boolean}} [opts]
   *   playDurationMs は フェードイン＋そのまま＋フェードアウト の合計
   * @returns {Promise<void>}
   */
  async playJingle(dirPath, { fadeInMs = 0, playDurationMs = 15000, fadeOutMs = 2000, restoreBgm = true } = {}) {
    const mp3 = this._pickMp3FromDir(dirPath);
    if (!mp3) {
      getLogger().warn(`[Mixer] No MP3 files in ${dirPath}, skipping jingle`);
      return;
    }

    getLogger().info(`[Mixer] Starting jingle: ${mp3}`);
    this._volumeLocked = true;

    // ATTENTION: 今の BGM のファイル名は、止める前に控えること。止めると消えてしまい、後で戻せない
    const bgmFileToRestore = this.currentBgmFile;

    this.stopBgm();

    const startVol = fadeInMs > 0 ? 0 : 1.0;
    this.currentBgmVolume = startVol;
    this.targetBgmVolume  = startVol;

    const { decodeTo24leOnce } = require('../utils/audio-decoder');
    try {
      const stream = await decodeTo24leOnce(mp3);
      this.use24bit   = true;
      this.bgmStream  = stream;
      this.bgmProcess = { kill: () => { stream.destroy(); this.bgmStream = null; } };

      // 音が予定より早く終わったときに、待つのをやめるための合図
      let jingleEndedEarly = false;
      let resolveEarlyEnd;
      const earlyEndPromise = new Promise(r => { resolveEarlyEnd = r; });
      stream.once('end', () => { jingleEndedEarly = true; resolveEarlyEnd(); });
      stream.once('error', err => {
        getLogger().error('[Mixer] Jingle stream error:', err);
        jingleEndedEarly = true;
        resolveEarlyEnd();
      });

      stream.on('data', chunk => {
        this.bgmBuffer = Buffer.concat([this.bgmBuffer, chunk]);
        if (this.bgmBuffer.length > this.bgmHighWater) stream.pause();
      });

      if (fadeInMs > 0) await this.fadeBgmTo(1.0, fadeInMs);

      const holdMs = Math.max(0, playDurationMs - fadeInMs - fadeOutMs);
      if (holdMs > 0) {
        await Promise.race([new Promise(r => setTimeout(r, holdMs)), earlyEndPromise]);
      }

      if (!jingleEndedEarly && fadeOutMs > 0) await this.fadeBgmTo(0, fadeOutMs);
    } finally {
      this.stopBgm();
      this._volumeLocked = false;

      // ジングルの後に BGM を戻す
      if (restoreBgm && bgmFileToRestore) {
        getLogger().info(`[Mixer] Jingle finished — restoring BGM: ${bgmFileToRestore}`);
        this.currentBgmVolume = 0;
        this.targetBgmVolume  = 0;
        this.playBgm(bgmFileToRestore);
      } else if (!restoreBgm) {
        getLogger().info('[Mixer] Jingle finished — BGM restore skipped (restoreBgm=false)');
      }
    }
  }

  /**
   * 通常の BGM を1つ選んで流し始める。音量は0から始め、自動のダッキングが自然に上げていく。
   * @returns {void}
   */
  startRegularBgm() {
    const files = fs.readdirSync(this.bgmDir)
      .filter(f => (f.endsWith('.mp3') || f.endsWith('.wav')) && !f.startsWith('.'));

    if (files.length === 0) {
      getLogger().warn('[Mixer] No regular BGM files found in', this.bgmDir);
      return;
    }

    const selected = files[Math.floor(Math.random() * files.length)];
    getLogger().info(`[Mixer] Starting regular BGM: ${selected}`);
    this.currentBgmVolume = 0;
    this.targetBgmVolume  = 0;
    this.playBgm(selected);
  }

  /**
   * エージェントの話し声を、ミキサーへ流し込む。
   * ATTENTION: 溜める量に上限を付けないこと。呼び出し側が「1文入れる → 流し終わるまで待つ」を守るので
   * 同時に溜まることはなく、上限を付けると長い文の語尾が切れる。
   * @param {Buffer} rawPcm16bitMono 話し声（1チャンネル・16ビット）
   * @param {number} [inputSampleRate] 入力のサンプルレート
   * @param {number} [pan] 左右の位置（-1 が左、0 が中央、+1 が右）
   * @returns {void}
   */
  injectTalkAudio(rawPcm16bitMono, inputSampleRate = 24000, pan = 0) {
    const convertedBuffer = this.resamplePcm16MonoToMixerStereo24(rawPcm16bitMono, inputSampleRate, pan);
    
    this.talkBuffer = Buffer.concat([this.talkBuffer, convertedBuffer]);
  }

  /**
   * 1チャンネル16ビットの音を、ミキサーの形（2チャンネル24ビット・this.sampleRate）に変える。
   * 途中の値は前後から補い、左右の振り分けは聴こえる大きさが変わらない配分（中央で両方 0.707）にする。
   * @param {Buffer} inputBuffer 入力の音
   * @param {number} inputSampleRate 入力のサンプルレート
   * @param {number} [pan] 左右の位置（-1 が左、0 が中央、+1 が右）
   * @returns {Buffer} 変えた音
   */
  resamplePcm16MonoToMixerStereo24(inputBuffer, inputSampleRate, pan = 0) {
    const inputSamplesCount = Math.floor(inputBuffer.length / 2);
    if (inputSamplesCount === 0) return Buffer.alloc(0);
    const outputSamplesCount = Math.floor(inputSamplesCount * (this.sampleRate / inputSampleRate));

    // 左右の配分（角度に直して cos と sin で求める）
    const p     = Math.max(-1, Math.min(1, pan));
    const angle = (p + 1) * Math.PI / 4;
    const gainL = Math.cos(angle);        // 中央では両方およそ 0.707
    const gainR = Math.sin(angle);

    const outputBuffer = Buffer.alloc(outputSamplesCount * this.channels * this.bytesPerSample);

    for (let i = 0; i < outputSamplesCount; i++) {
      const inputIdx = i * (inputSampleRate / this.sampleRate);
      const lowIdx = Math.floor(inputIdx);
      if (lowIdx >= inputSamplesCount) break;
      const highIdx = Math.min(lowIdx + 1, inputSamplesCount - 1);
      const frac = inputIdx - lowIdx;

      // 範囲の外を読まないように
      if (highIdx >= inputSamplesCount) continue;

      const s0 = inputBuffer.readInt16LE(lowIdx * 2);
      const s1 = inputBuffer.readInt16LE(highIdx * 2);
      const sample16 = Math.round(s0 + (s1 - s0) * frac);
      // 24 ビットに広げ、左右の配分を掛ける
      const writePos = i * this.channels * this.bytesPerSample;
      this.writeInt24LE(outputBuffer, Math.round((sample16 << 8) * gainL), writePos);
      this.writeInt24LE(outputBuffer, Math.round((sample16 << 8) * gainR), writePos + 3);
    }

    return outputBuffer;
  }

  /**
   * 16 ビットの値を書く。
   * @param {Buffer} buffer 書き込む先
   * @param {number} value 値
   * @param {number} offset 位置
   * @returns {void}
   */
  writeInt16LE(buffer, value, offset) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
  }

  /**
   * 24 ビットの値を書く。
   * @param {Buffer} buffer 書き込む先
   * @param {number} value 値
   * @param {number} offset 位置
   * @returns {void}
   */
  writeInt24LE(buffer, value, offset) {
    buffer[offset] = value & 0xff;
    buffer[offset + 1] = (value >> 8) & 0xff;
    buffer[offset + 2] = (value >> 16) & 0xff;
  }

  /**
   * 16 ビットの値を読む（符号を復元する）。
   * @param {Buffer} buffer 読む先
   * @param {number} offset 位置
   * @returns {number} 値
   */
  readInt16LE(buffer, offset) {
    let value = buffer[offset] | (buffer[offset + 1] << 8);
    if (value & 0x8000) value |= 0xffff0000;
    return value;
  }

  /**
   * 24 ビットの値を読む（符号を復元する）。
   * @param {Buffer} buffer 読む先
   * @param {number} offset 位置
   * @returns {number} 値
   */
  readInt24LE(buffer, offset) {
    let value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    // 24 ビット目が1ならマイナスにする
    if (value & 0x800000) {
      value |= 0xff000000;
    }
    return value;
  }

  /**
   * BGM の音量の目標を決める（実際の音量はフレームごとに近づく）。
   * @param {number} volume 目標の音量
   * @returns {void}
   */
  setBgmVolumeTarget(volume) {
    getLogger().debug(`[Mixer] setBgmVolumeTarget called: target=${volume}`);
    this.targetBgmVolume = volume;
  }

  /**
   * BGM の音量を、目標へ1フレームぶん近づける。
   * @returns {void}
   */
  updateVolumeGains() {
    const goingDown = this.currentBgmVolume > this.targetBgmVolume;
    // 目標がほぼ0なら速く。ふだんは下げるのが速く、戻すのはゆっくり
    const speed = this.targetBgmVolume < 0.1
      ? this.duckingSpeedFast
      : (goingDown ? this.duckingSpeedDown : this.duckingSpeedUp);

    if (this.currentBgmVolume !== this.targetBgmVolume) {
      if (this.currentBgmVolume < this.targetBgmVolume) {
        this.currentBgmVolume = Math.min(this.currentBgmVolume + speed, this.targetBgmVolume);
      } else {
        this.currentBgmVolume = Math.max(this.currentBgmVolume - speed, this.targetBgmVolume);
      }
    }
  }

  /**
   * 配信を始める（BGM を流し、一定の間隔でフレームを配り続ける）。
   * @returns {void}
   */
  startBroadcast() {
    if (this.isBroadcasting) return;
    this.isBroadcasting = true;

    // BGM を自動で流す（ジングルの最中なら触らない）
    if (!this._volumeLocked) {
      const bgmFiles = fs.readdirSync(this.bgmDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
      if (bgmFiles.length > 0) {
        const selected = bgmFiles.find(f => f.endsWith('.mp3')) || bgmFiles[0];
        this.playBgm(selected);
      } else {
        getLogger().warn(`[Mixer] No BGM files found in ${this.bgmDir}`);
      }
    }

    // ATTENTION: 1フレームの時間は丸めないこと。丸めると毎秒わずかにずれ、そのずれが積もる
    const intervalMs = (this.frameSize / this.sampleRate) * 1000;

    this._nextFrameAt = Date.now() + intervalMs;
    const tick = () => {
      if (!this.isBroadcasting) return;
      this.mixAndStreamFrame();

      // 実際に経った時間を見て、次までの待ちを調整する
      this._nextFrameAt += intervalMs;
      const now = Date.now();
      let delay = this._nextFrameAt - now;

      // 大きく遅れたときは、まとめて取り返そうとせずに基準を引き直す
      if (delay < -intervalMs * 3) {
        this._nextFrameAt = now + intervalMs;
        delay = intervalMs;
      }
      this._mixerTimer = setTimeout(tick, Math.max(0, delay));
    };
    this._mixerTimer = setTimeout(tick, intervalMs);
  }

  // ── 番組の録音（無音の区間は飛ばす）──────────────────────────────
  // 録音の状態は ProgramRecorder（このファイルの下）が持ち、attach した間だけ出力を受け取る。

  // 無音とみなす大きさ。曲の再生中はサーバー側の音を止めているので、ここに残る小さな音は無音として扱ってよい
  static REC_SILENCE_AMPLITUDE = 200;

  /**
   * このミキサーの出力を録音の対象にする。
   * @param {any} recorder ProgramRecorder
   * @returns {void}
   */
  attachRecorder(recorder) {
    this._activeRecorder = recorder;
  }

  /**
   * 録音の対象から外す。
   * @returns {any} それまで付いていた ProgramRecorder（無ければ null）
   */
  detachRecorder() {
    const r = this._activeRecorder;
    this._activeRecorder = null;
    return r;
  }

  /**
   * そのフレームが実質無音か（録音を飛ばすかの判定に使う）。
   * @param {Buffer} frame 混ぜ終わったフレーム
   * @returns {boolean} 無音なら true
   */
  _isFrameSilent(frame) {
    const sampleCount = frame.length / this.bytesPerSample;
    for (let i = 0; i < sampleCount; i++) {
      if (Math.abs(this.readInt24LE(frame, i * this.bytesPerSample)) > AudioMixer.REC_SILENCE_AMPLITUDE) {
        return false;
      }
    }
    return true;
  }

  /**
   * 配信を止め、BGM と溜めてある話し声を捨てて音量を0に戻す。
   * @returns {void}
   */
  stopBroadcast() {
    this.isBroadcasting = false;
    if (this._mixerTimer) {
      clearTimeout(this._mixerTimer);
      this._mixerTimer = null;
    }
    if (this._fadeInterval) {
      clearInterval(this._fadeInterval);
      this._fadeInterval = null;
    }
    this._volumeLocked = false;
    this.stopBgm();
    // 残っている音を捨てる（次につないだときに、前の残りが鳴ってしまわないように）
    this.talkBuffer = Buffer.alloc(0);
    this.currentBgmVolume = 0;
    this.targetBgmVolume  = 0;
  }

  /**
   * 1フレームぶんの音を作って配る（BGM と話し声を混ぜ、録音にも渡す）。
   * ATTENTION: フレームの中で音量を少しずつ変えること。フレームの切れ目で急に変えると、そこがプチ音になる。
   * @returns {void}
   */
  mixAndStreamFrame() {
    if (this.clients.size === 0) return;

    const volumeAtFrameStart = this.currentBgmVolume;
    this.updateVolumeGains();
    const volumeAtFrameEnd = this.currentBgmVolume;
    
    if (this._frameCount === undefined) this._frameCount = 0;
    this._frameCount++;
    
    const bytesPerFrame = this.frameSize * this.channels * this.bytesPerSample;

    // 使い回すバッファ（毎フレーム確保しない）
    const mixedFrame = this._staticMixedFrame;
    const bgmPart    = this._staticBgmPart;
    const talkPartBuf = this._staticTalkPart;

    const bgmBytesPerSample = this.use24bit ? 3 : 2; // BGM が 24 ビットか 16 ビットか
    const bgmPartSize = this.frameSize * this.channels * bgmBytesPerSample;
    if (this.bgmBuffer.length > 0) {
      const copyLen = Math.min(this.bgmBuffer.length, bgmPartSize);
      // サンプルの途中で切らないよう、きりのよい長さだけ写す
      const srcBytesPerSample = this.use24bit ? 3 : 2;
      const frameByteSize = this.channels * srcBytesPerSample;
      const alignedCopyLen = Math.floor(copyLen / frameByteSize) * frameByteSize;
      if (alignedCopyLen > 0) {
        this.bgmBuffer.copy(bgmPart, 0, 0, alignedCopyLen);
        this.bgmBuffer = this.bgmBuffer.slice(alignedCopyLen);
      }
      if (alignedCopyLen < bgmPartSize) {
        bgmPart.fill(0, alignedCopyLen);
      }
    } else {
      bgmPart.fill(0);
    }

    // 溜めてある BGM が減ってきたら、止めていた読み込みを再開する
    if (this.bgmStream && this.bgmStream.isPaused() &&
        this.bgmBuffer.length < this.bgmLowWater) {
      this.bgmStream.resume();
    }

    // 話し声を1フレームぶん取り出す
    const talkPart = talkPartBuf;
    talkPart.fill(0); // 前のフレームの残りが混ざらないように
    let hasTalk = false;
    this._talkPartialFadeStart = -1;
    if (this.talkBuffer.length >= bytesPerFrame) {
      this.talkBuffer.copy(talkPart, 0, 0, bytesPerFrame);
      this.talkBuffer = this.talkBuffer.slice(bytesPerFrame);
      hasTalk = true;
    } else if (this.talkBuffer.length > 0) {
      // 残りが1フレームに満たないので、末尾をフェードアウトして無音へつなぐ
      const remainingBytes = this.talkBuffer.length;
      this.talkBuffer.copy(talkPart, 0, 0, remainingBytes);
      talkPart.fill(0, remainingBytes);
      this.talkBuffer = Buffer.alloc(0);
      hasTalk = true;
      // 最後の最大256サンプルをかけて下げる
      const realSamples = Math.floor(remainingBytes / (this.channels * this.bytesPerSample));
      const fadeSamples = Math.min(256, realSamples);
      this._talkPartialFadeStart = realSamples - fadeSamples;
    }

    // 話し声が実際に入っているか
    let talkIsAudible = false;
    if (hasTalk) {
      const sampleCount = talkPart.length / this.bytesPerSample;
      for (let i = 0; i < sampleCount; i++) {
        const sample = this.readInt24LE(talkPart, i * this.bytesPerSample);
        if (sample !== 0) { talkIsAudible = true; break; }
      }
    }

    // 無音から声に変わるところでは、フレームの中でフェードインする
    const talkFadeIn = talkIsAudible && !this._prevTalkIsAudible;
    this._prevTalkIsAudible = talkIsAudible;

    // ジングルやオープニングの最中は、そちらが音量を作るので自動のダッキングはしない
    if (!this._volumeLocked) {
      // 文と文の間（次の音声を作っている間）も下げたままにする。環境音のときは基準の音量に合わせ、
      // 話している間はその半分にする（環境音を残しつつ声を前に出す）
      const _base = this._ambientBaseVolume;
      const _speechTarget = _base != null ? Math.max(0.06, _base * 0.5) : 0.15;
      const _idleTarget   = _base != null ? _base                        : 1.0;
      if (talkIsAudible || this.isSpeakerBusy) {
        if (Math.abs(this.targetBgmVolume - _speechTarget) > 0.001) {
          this.setBgmVolumeTarget(_speechTarget);
        }
      } else {
        if (Math.abs(this.targetBgmVolume - _idleTarget) > 0.001) {
          this.setBgmVolumeTarget(_idleTarget);
        }
      }
    }

    // BGM と話し声を混ぜる
    const readBgm = this.use24bit ? this.readInt24LE.bind(this) : (buffer, offset) => {
      const val16 = this.readInt16LE(buffer, offset);
      return val16 << 8;
    };
    const readTalk = this.readInt24LE.bind(this);
    const writeSample = this.writeInt24LE.bind(this);
    const clipMin = -8388608;
    const clipMax = 8388607;
    const totalSamples = this.frameSize * this.channels;
    const volumeDelta = volumeAtFrameEnd - volumeAtFrameStart;
    for (let i = 0; i < totalSamples; i++) {
      // フレームの中で音量を少しずつ変える
      const t = (i >> 1) / this.frameSize;
      const vol = volumeAtFrameStart + volumeDelta * t;

      const srcOffsetBgm = this.use24bit ? i * this.bytesPerSample : i * 2;
      const bgmVal = readBgm(bgmPart, srcOffsetBgm);
      const talkVal = readTalk(talkPart, i * this.bytesPerSample);
      const adjustedBgm = Math.floor(bgmVal * vol);

      // 声の出だしは0から1へ、終わりは1から0へ。プチ音を抑えるため。
      // TODO: このプチ音は代わりの読み上げ（MP3）に由来する可能性が高い。良い読み上げに替えたら、この
      // フェードは要らなくなるかもしれない
      const sampleIdx = i >> 1;
      let talkMult = 1.0;
      if (talkFadeIn) {
        talkMult = t; // t = 0→1 across frame → fade in from silence
      } else if (this._talkPartialFadeStart >= 0 && sampleIdx >= this._talkPartialFadeStart) {
        const fadeLen = this.frameSize - this._talkPartialFadeStart;
        talkMult = 1.0 - (sampleIdx - this._talkPartialFadeStart) / fadeLen; // 1→0
      }
      const adjustedTalk = Math.floor(talkVal * talkMult);
      let mixedVal = adjustedBgm + adjustedTalk;
      mixedVal = Math.max(clipMin, Math.min(clipMax, mixedVal));
      writeSample(mixedFrame, mixedVal, i * this.bytesPerSample);
    }

    // 聴いている全員へ配る
    this.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(mixedFrame, { binary: true });
      }
    });

    // 録音（付いているときだけ。無音の区間＝曲の再生中は書かずに飛ばす）
    if (this._activeRecorder) {
      this._activeRecorder.writeFrame(mixedFrame, this._isFrameSilent(mixedFrame), this._frameMs);
    }

  }

  /**
   * 溜めてある話し声を配り終わるまで待つ。誰も聴いていなければ捨ててすぐ返る。
   * ATTENTION: 確かめる間隔は短くすること（長いと、文と文の間に無音ができてプチ音になる）。
   * @param {number} [pollMs] 確かめる間隔（ミリ秒）
   * @param {number} [timeoutMs] 待つ上限（ミリ秒。超えたら捨てて進む）
   * @returns {Promise<void>}
   */
  waitForTalkDrain(pollMs = 4, timeoutMs = 120000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        // 誰も聴いていないと配られないので、捨てて先へ進む
        if (this.clients.size === 0) {
          if (this.talkBuffer.length > 0) {
            getLogger().debug('[Mixer] waitForTalkDrain: no clients, fast-clearing talkBuffer');
            this.talkBuffer = Buffer.alloc(0);
          }
          resolve();
          return;
        }
        if (this.talkBuffer.length === 0) {
          resolve();
        } else if (Date.now() > deadline) {
          getLogger().warn('[Mixer] waitForTalkDrain: timeout, force clearing');
          this.talkBuffer = Buffer.alloc(0);
          resolve();
        } else {
          setTimeout(check, pollMs);
        }
      };
      check();
    });
  }

  /**
   * 話し始め・話し終わりを知らせる（文と文の間も BGM を下げたままにするため）。
   * BUGFIX: 待たせているタイマーは、true でも false でも必ず止めること。止めないと、次の人の音声を
   * 作っている最中にそのタイマーが動いて BGM が浮き上がる。
   * @param {boolean} busy 話している間は true
   * @returns {void}
   */
  setSpeakerBusy(busy) {
    if (this._speakerBusyHoldTimer) {
      clearTimeout(this._speakerBusyHoldTimer);
      this._speakerBusyHoldTimer = null;
    }
    this.isSpeakerBusy = busy;
  }

  /**
   * 話し終わった後も、決めた時間だけ「話している」ことにする（その間に BGM が浮き上がらないように）。
   * @param {number} ms 保つ時間（ミリ秒）
   * @returns {void}
   */
  keepSpeakerBusyMs(ms) {
    if (this._speakerBusyHoldTimer) clearTimeout(this._speakerBusyHoldTimer);
    this.isSpeakerBusy = true;
    this._speakerBusyHoldTimer = setTimeout(() => {
      this.isSpeakerBusy = false;
      this._speakerBusyHoldTimer = null;
    }, ms);
  }

}

/**
 * 番組の録音（MP3 にして書き出す）。
 * ミキサーとは別に持ち、attachRecorder でどのチャンネルのミキサーからでも受け取れるようにしてある。
 * 音声が主なので、そのままの音で保存せず（1時間で500MBほどになる）、その場で MP3 にして書く。
 */
class ProgramRecorder {
  static MP3_BITRATE = '96k';
  // これだけ無音が続いたら、曲の再生中とみなして録音を飛ばす
  static SILENCE_SKIP_AFTER_MS = 2500;

  constructor() {
    this.ffmpeg = null;
    this.path = null;
    this.bytes = 0;       // 書き込んだ音の量（中身が空かどうかの判定用。MP3 の大きさではない）
    this.silentMs = 0;    // 無音が続いている時間
    this.skipping = false;
    this.skippedMs = 0;   // 飛ばした時間の合計
    this._closePromise = null;
  }

  /**
   * 録音を始める（受け取った音を MP3 にして書き出す）。
   * @param {string} filePath 保存先（例: server/data/recordings/xxx.mp3）
   * @returns {void}
   */
  start(filePath) {
    this.path = filePath;
    this.bytes = 0;
    this.silentMs = 0;
    this.skipping = false;
    this.skippedMs = 0;

    // ATTENTION: 受け取る形はミキサーの出力に合わせること（24kHz・24ビット・2チャンネル）
    const args = [
      '-f', 's24le', '-ar', '24000', '-ac', '2', '-i', 'pipe:0',
      '-codec:a', 'libmp3lame', '-b:a', ProgramRecorder.MP3_BITRATE,
      '-y', filePath,
    ];
    this.ffmpeg = spawn(ffmpegStatic, args);
    this.ffmpeg.stderr.on('data', () => {}); // 変換の途中経過は捨てる
    this._closePromise = new Promise((resolve) => { this.ffmpeg.on('close', resolve); });

    getLogger().info(`[Recorder] 録音開始 → ${filePath}（MP3 ${ProgramRecorder.MP3_BITRATE}）`);
  }

  /**
   * 1フレームぶんを書く（無音が続いている間は書かずに飛ばす）。付いているミキサーが毎フレーム呼ぶ。
   * @param {Buffer} frame 混ぜ終わったフレーム
   * @param {boolean} isSilent そのフレームが無音か
   * @param {number} frameMs 1フレームの長さ（ミリ秒）
   * @returns {void}
   */
  writeFrame(frame, isSilent, frameMs) {
    if (!this.ffmpeg) return;
    if (isSilent) {
      this.silentMs += frameMs;
      if (this.silentMs >= ProgramRecorder.SILENCE_SKIP_AFTER_MS) this.skipping = true;
    } else {
      this.silentMs = 0;
      this.skipping = false;
    }

    if (this.skipping) {
      this.skippedMs += frameMs;
    } else {
      this.ffmpeg.stdin.write(frame);
      this.bytes += frame.length;
    }
  }

  /**
   * 録音を止め、書き出しが終わるのを待ってからファイルを確定する。
   * @returns {Promise<{ path: string, skippedMs: number, dataBytes: number } | null>} 保存先と、
   *   飛ばした時間・書き込んだ量（録音していなければ null）
   */
  async stop() {
    if (!this.ffmpeg) return null;
    const ffmpeg = this.ffmpeg;
    const closePromise = this._closePromise;
    const dataBytes = this.bytes;
    const skippedMs = this.skippedMs;
    const savedPath = this.path;
    this.ffmpeg = null;

    ffmpeg.stdin.end();
    await closePromise;

    getLogger().info(`[Recorder] 録音停止 → ${savedPath}（無音スキップ ${(skippedMs / 1000).toFixed(0)}秒）`);
    return { path: savedPath, skippedMs, dataBytes };
  }
}

module.exports = { AudioMixer, ProgramRecorder };
