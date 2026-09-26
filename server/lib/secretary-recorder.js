/**
 * @file 秘書（My Secretary）の会話の録音（マイクと Gemini Live の応答を1本の音声にまとめる）
 *
 * 管理画面の「システム管理 → 番組録音」から手動で始める（routes/recording-routes.js）。音声は
 * routes/secretary-live-routes.js が append() で流し込む。
 *
 * 番組の録音（audio-mixer.js の ProgramRecorder）はミキサーの出力を ffmpeg で MP3 にしながら書くが、秘書の音声は
 * ミキサーを通らず、Base64 の PCM として WebSocket を流れるだけなので、ここで別に組み立てる。
 *   - どちらの向きも非圧縮の PCM（マイク 16kHz・応答 24kHz、16bit モノラル）なので、24kHz にそろえて
 *     届いた順につなぎ、WAV のヘッダを付けるだけでよい（交互に話す会話なので、ミキシングは要らない）
 *   - 保存は MP3 にするので、最後に wavBufferToMp3() で変換する
 *   - 無音が続いたら書き込みを止める（ジャンプカット）。ツールの実行待ちなどで無音が長くなり、聞き返すのが
 *     大変になるため。マイクはクライアントに VAD が無く、会話の有無に関わらず流れ続ける。考え方と値は
 *     ProgramRecorder とそろえる
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
'use strict';

const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

const OUTPUT_SAMPLE_RATE = 24000; // Gemini Live の応答の音声と同じレート
const MIC_SAMPLE_RATE = 16000;
const SILENCE_AMPLITUDE = 400; // 無音とみなす振幅（16bit の ±32767 に対して）
const SILENCE_SKIP_AFTER_MS = 2500; // ProgramRecorder と同じ値
const MP3_BITRATE = '96k'; // ProgramRecorder と同じ値

/**
 * 16bit モノラルの PCM に、WAV のヘッダ（44バイト）を付ける。
 * @param {Buffer} pcmBuffer
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function pcm16MonoToWav(pcmBuffer, sampleRate) {
  const channels = 1;
  const bitDepth = 16;
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataSize);
  let offset = 0;
  wav.write('RIFF', offset); offset += 4;
  wav.writeUInt32LE(36 + dataSize, offset); offset += 4;
  wav.write('WAVE', offset); offset += 4;
  wav.write('fmt ', offset); offset += 4;
  wav.writeUInt32LE(16, offset); offset += 4;
  wav.writeUInt16LE(1, offset); offset += 2; // PCM
  wav.writeUInt16LE(channels, offset); offset += 2;
  wav.writeUInt32LE(sampleRate, offset); offset += 4;
  wav.writeUInt32LE(byteRate, offset); offset += 4;
  wav.writeUInt16LE(blockAlign, offset); offset += 2;
  wav.writeUInt16LE(bitDepth, offset); offset += 2;
  wav.write('data', offset); offset += 4;
  wav.writeUInt32LE(dataSize, offset); offset += 4;
  pcmBuffer.copy(wav, 44);
  return wav;
}

/**
 * マイクの音声を 16kHz から 24kHz へ線形補間で上げる。append() の呼び出しをまたいで続けて補間するための状態を持つ。
 *
 * BUGFIX: チャンクの末尾のサンプルを次の呼び出しへ持ち越してから補間する。クライアントは約8ms（128サンプル）
 *         ごとに送ってくるので、チャンクごとに別々に補間すると、末尾で「次のサンプル」が無く自分を複製して
 *         しまい、1秒に約125回の不連続が「ブチブチ」というノイズになった。
 * BUGFIX: _pos は「次に作る出力のサンプルが、入力のどの位置（小数）にあたるか」を表し、呼び出しをまたいで
 *         増え続ける。出力の数を毎回「入力の数 × レートの比」の四捨五入で決めると、端数の誤差がたまって
 *         録音全体で少しずつずれた。_pos なら、1歩進めるだけのデータが無いところで止まって次回そこから
 *         続けるだけなので、誤差がたまらない。
 */
class _MicUpsampler {
  constructor() {
    this._buffer = Buffer.alloc(0); // まだ使っていない入力（16kHz）
    this._pos = 0; // _buffer の中の読み取り位置（入力のサンプル単位の小数）
  }

  /**
   * チャンクを足し、補間できるところまでを 24kHz にして返す。
   * @param {Buffer} chunk 16bit モノラルの PCM（16kHz）
   * @returns {Buffer} 24kHz の PCM
   */
  push(chunk) {
    this._buffer = this._buffer.length > 0 ? Buffer.concat([this._buffer, chunk]) : chunk;
    const inSamples = this._buffer.length / 2;
    const step = MIC_SAMPLE_RATE / OUTPUT_SAMPLE_RATE; // 出力1サンプルごとに入力で進む幅（0.666…）
    const outSamples = [];
    // 次のサンプル（hi）がまだ届いていないところで止め、次の push() で続きから補間する
    while (Math.floor(this._pos) + 1 < inSamples) {
      const lo = Math.floor(this._pos);
      const hi = lo + 1;
      const frac = this._pos - lo;
      const s0 = this._buffer.readInt16LE(lo * 2);
      const s1 = this._buffer.readInt16LE(hi * 2);
      outSamples.push(Math.round(s0 + (s1 - s0) * frac));
      this._pos += step;
    }
    const out = Buffer.alloc(outSamples.length * 2);
    for (let i = 0; i < outSamples.length; i++) out.writeInt16LE(outSamples[i], i * 2);

    // 使い終えた先頭を切り詰める（バッファが伸び続けないように）
    const consumed = Math.floor(this._pos);
    if (consumed > 0) {
      this._buffer = this._buffer.subarray(consumed * 2);
      this._pos -= consumed;
    }
    return out;
  }
}

/**
 * すべてのサンプルが無音のしきい値以下か。
 * @param {Buffer} buffer 16bit の PCM
 * @returns {boolean}
 */
function isBufferSilent(buffer) {
  const n = buffer.length / 2;
  for (let i = 0; i < n; i++) {
    if (Math.abs(buffer.readInt16LE(i * 2)) > SILENCE_AMPLITUDE) return false;
  }
  return true;
}

/** 秘書の会話1回分の録音。append() で流し込み、finish() で WAV を受け取る */
class SecretaryRecorder {
  constructor() {
    this.chunks = [];
    this.dataBytes = 0;
    this.silentMs = 0;
    this.skipping = false;
    this.skippedMs = 0;
    this._micUpsampler = new _MicUpsampler();
    // BUGFIX: 秘書が話している間は、マイクの音声を録音に入れない（setModelSpeaking()、呼び出し元は
    //         secretary-live-routes.js）。マイクは秘書が話している間もミュートされずに流れ続けるので、応答の
    //         音声の合間にマイクの小さなチャンクが届いた順に混ざり、秘書の声にも「プチプチ」というノイズが出た。
    this._modelSpeaking = false;
  }

  /**
   * 秘書が話している最中かを設定する（true の間はマイクの音声を録音に入れない）。
   * @param {boolean} speaking
   */
  setModelSpeaking(speaking) {
    this._modelSpeaking = speaking;
  }

  /**
   * 音声を足す。マイクの音声は 24kHz に上げ、無音が続いている間は書き込まない。
   * @param {Buffer} pcm16Buffer 16bit モノラルの PCM
   * @param {number} sampleRate 16000（マイク）か 24000（秘書の応答）
   */
  append(pcm16Buffer, sampleRate) {
    if (!pcm16Buffer || pcm16Buffer.length === 0) return;
    const isMic = sampleRate !== OUTPUT_SAMPLE_RATE;
    if (isMic && this._modelSpeaking) return;
    const resampled = isMic ? this._micUpsampler.push(pcm16Buffer) : pcm16Buffer;
    if (resampled.length === 0) return;
    const durationMs = (resampled.length / 2 / OUTPUT_SAMPLE_RATE) * 1000;

    if (isBufferSilent(resampled)) {
      this.silentMs += durationMs;
      if (this.silentMs >= SILENCE_SKIP_AFTER_MS) this.skipping = true;
    } else {
      this.silentMs = 0;
      this.skipping = false;
    }

    if (this.skipping) {
      this.skippedMs += durationMs;
      return;
    }
    this.chunks.push(resampled);
    this.dataBytes += resampled.length;
  }

  /**
   * 録音を WAV にまとめて返す。
   * @returns {{ buffer: Buffer, skippedMs: number, dataBytes: number } | null} 何も録れていなければ null
   */
  finish() {
    if (this.dataBytes === 0) return null;
    const pcm = Buffer.concat(this.chunks);
    return { buffer: pcm16MonoToWav(pcm, OUTPUT_SAMPLE_RATE), skippedMs: this.skippedMs, dataBytes: this.dataBytes };
  }
}

/**
 * WAV を MP3 に変換する（ProgramRecorder と同じコーデックとビットレート）。
 * 番組の録音はミキサーの出力を ffmpeg へ流し続けるが、秘書の録音は finish() で一度に WAV にするので、
 * それをまるごと ffmpeg へ通す（agent-shared-mixin.js の音声合成の変換と同じ形）。
 * @param {Buffer} wavBuffer
 * @returns {Promise<Buffer>}
 */
function wavBufferToMp3(wavBuffer) {
  return new Promise((resolve, reject) => {
    const args = ['-i', 'pipe:0', '-codec:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-f', 'mp3', 'pipe:1'];
    const ffmpeg = spawn(ffmpegStatic, args);
    const chunks = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    ffmpeg.stderr.on('data', () => {}); // 変換のログは出さない
    ffmpeg.on('error', reject);
    ffmpeg.stdin.write(wavBuffer);
    ffmpeg.stdin.end();
  });
}

// 今の録音先（1つだけ）。録音の開始・停止をする routes/recording-routes.js と、音声が流れる
// routes/secretary-live-routes.js は互いに依存しないので、audio-mixer.js の attachRecorder と同じく
// 「今の録音先は1つ」という考え方で、モジュールの変数を介して受け渡す。
let _activeRecorder = null;
function setActiveRecorder(recorder) { _activeRecorder = recorder; }
function getActiveRecorder() { return _activeRecorder; }
function clearActiveRecorder() { _activeRecorder = null; }

module.exports = { SecretaryRecorder, wavBufferToMp3, setActiveRecorder, getActiveRecorder, clearActiveRecorder };
