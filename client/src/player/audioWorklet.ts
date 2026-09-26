/**
 * @file 再生用の AudioWorklet（左右の音声のリングバッファと VU メーター）のソース
 *
 * Player.tsx が Blob URL にしてから AudioWorklet として読み込む。そのため、処理の本体は1つの文字列になっている。
 *   - 受け取った PCM（左右交互の Float32）をリングバッファに貯め、0.3秒分貯まってから再生を始める
 *   - 途中で足りなくなったら、残りを短くフェードアウトして止め、また貯まるのを待つ
 *   - 出力の RMS を 2048 サンプルごとにメインスレッドへ送る（VU メーター用）
 *   - 'reset' を受け取るとバッファを空にする
 *
 * ATTENTION: 文字列の中の 24000（サンプリングレート）は、Player.tsx で AudioContext を作るときの
 *            sampleRate と必ず一致させること。ずれると再生の速さが変わる。AudioWorklet の中からは
 *            AudioContext の sampleRate を参照できないので、定数で持っている。
 * ATTENTION: PCM_RING_WORKLET はまるごと1つの文字列。中の「//」もコメントではなく文字列の一部なので、
 *            書き換えると AudioWorklet の中身が変わる。
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

export const PCM_RING_WORKLET = `
class PCMRingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 【2026-08-15・音声ミキサー24kHz移行】このAudioWorklet自体はAudioContextの実際の
    // sampleRateを直接参照できないため定数のまま持つ。Player.tsxのAudioContext生成時の
    // sampleRateと必ず一致させること（ズレると再生速度が変わる）。
    const CAP      = 24000 * 2 * 5;
    this._ring     = new Float32Array(CAP);
    this._cap      = CAP;
    this._writeIdx = 0;
    this._readIdx  = 0;
    this._count    = 0;
    this._ready    = false;
    this._PREBUF   = Math.floor(24000 * 2 * 0.3);
    // VU メーター
    this._vuL = 0; this._vuR = 0; this._vuN = 0;
    this._VU_INT = 2048;

    this.port.onmessage = ({ data }) => {
      if (data === 'reset') {
        this._writeIdx = 0; this._readIdx = 0;
        this._count = 0; this._ready = false;
        this._vuL = 0; this._vuR = 0; this._vuN = 0;
        return;
      }
      const src  = new Float32Array(data);
      const free = this._cap - this._count;
      const n    = Math.min(src.length, free);
      for (let i = 0; i < n; i++) {
        this._ring[this._writeIdx] = src[i];
        if (++this._writeIdx >= this._cap) this._writeIdx = 0;
      }
      this._count += n;
    };
  }

  process(_inputs, outputs) {
    const left  = outputs[0][0];
    const right = outputs[0][1];
    const need  = left.length;

    if (!this._ready) {
      if (this._count < this._PREBUF) { left.fill(0); right.fill(0); return true; }
      this._ready = true;
    }
    const need2 = need * 2;
    if (this._count >= need2) {
      for (let i = 0; i < need; i++) {
        left[i]  = this._ring[this._readIdx]; if (++this._readIdx >= this._cap) this._readIdx = 0;
        right[i] = this._ring[this._readIdx]; if (++this._readIdx >= this._cap) this._readIdx = 0;
      }
      this._count -= need2;
    } else if (this._count >= 2) {
      const avail = Math.floor(this._count / 2);
      const fs    = Math.max(0, avail - 32);
      for (let i = 0; i < avail; i++) {
        const g = i >= fs ? 1 - (i - fs) / (avail - fs) : 1;
        left[i]  = this._ring[this._readIdx] * g; if (++this._readIdx >= this._cap) this._readIdx = 0;
        right[i] = this._ring[this._readIdx] * g; if (++this._readIdx >= this._cap) this._readIdx = 0;
      }
      left.fill(0, avail); right.fill(0, avail);
      this._count = 0; this._ready = false;
    } else {
      left.fill(0); right.fill(0);
    }

    // VU メーター: 出力サンプルの RMS を計測してメインスレッドへ送信
    for (let i = 0; i < need; i++) {
      this._vuL += left[i]  * left[i];
      this._vuR += right[i] * right[i];
    }
    this._vuN += need;
    if (this._vuN >= this._VU_INT) {
      this.port.postMessage({
        type: 'vu',
        l: Math.sqrt(this._vuL / this._vuN),
        r: Math.sqrt(this._vuR / this._vuN),
      });
      this._vuL = 0; this._vuR = 0; this._vuN = 0;
    }
    return true;
  }
}
registerProcessor('pcm-ring-processor', PCMRingProcessor);
`;
