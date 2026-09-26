/**
 * @file 秘書（Gemini Live の会話）用の AudioWorklet（マイク入力と、返事の音声の再生）のソース
 *
 * Player.tsx が Blob URL にしてから AudioWorklet として読み込む。そのため、処理の本体はそれぞれ1つの文字列になっている。
 *   - SECRETARY_MIC_WORKLET      … マイクの音を 16bit の PCM にしてメインスレッドへ送る
 *   - SECRETARY_PLAYBACK_WORKLET … 届いた返事の音声（24kHz・モノラル）を貯めて再生する。
 *                                  'reset' で捨て（話の途中で割り込まれたとき）、'query-remaining' で
 *                                  残りの長さを返す（専門家の声を重ねずに続けて流すため）
 *
 * 放送用の player/audioWorklet.ts（ステレオ・24kHz）とは用途が違うので、混ぜない。
 *
 * ATTENTION: 再生側のバッファは足りなくなったら大きくする作りにしてあり、固定の長さに戻さないこと。
 *            Gemini Live は音声を実時間より速く送ってくるので、固定長（以前は30秒）だと長い返事の
 *            終わりが黙って捨てられ、読み上げが途中で切れる。上限（5分）まで広げても入りきらなければ
 *            droppedSamples を送って知らせる。
 * ATTENTION: 2つの定数はまるごと文字列。中の「//」もコメントではなく文字列の一部なので、書き換えると
 *            AudioWorklet の中身が変わる。
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

export const SECRETARY_MIC_WORKLET = `
class SecretaryMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channelData = input[0];
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}
registerProcessor('secretary-mic-processor', SecretaryMicProcessor);
`;

export const SECRETARY_PLAYBACK_WORKLET = `
class SecretaryPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // BUGFIX: 長い回答の読み上げが最後の方で途切れる
    // 不具合の原因はここだった。以前は容量を「24000 * 30（30秒分）」の固定長にしており、
    // 満杯になると書き込み側で Math.min(src.length, free) により**溢れた分を黙って捨てて**
    // いた。Gemini Liveは音声を実時間より速く生成して送ってくるため（放送ミキサー側の
    // PCM_RING_WORKLETが5秒で足りるのは、あちらがサーバー側で実時間ペース配信のため）、
    // 30秒を超える長さの回答では末尾が確実に失われる。実測では音声およそ6.4文字/秒
    // （consult_agentのログより: 189文字＝29.5秒）で、280文字ほどの回答は約44秒に達し、
    // 30秒の上限を大きく超えていた。
    // 固定長をやめ、必要に応じて倍々に拡張する方式へ変更する。初期値を余裕のある60秒に
    // 取ったうえで、それでも足りなければ上限まで自動的に伸ばす。
    this._cap      = 24000 * 60;  // 初期60秒分（大半の回答はここに収まる）
    this._maxCap   = 24000 * 300; // 上限5分（これを超える発話は現実的に想定しない）
    this._ring     = new Float32Array(this._cap);
    this._writeIdx = 0;
    this._readIdx  = 0;
    this._count    = 0;

    this.port.onmessage = ({ data }) => {
      if (data === 'reset') {
        // Gemini Liveのbarge-in（interrupted）検出時、再生待ちの音声を即座に破棄する
        this._writeIdx = 0; this._readIdx = 0; this._count = 0;
        return;
      }
      if (data === 'query-remaining') {
        // consult_agentの本人音声（別経路のAudioBufferSourceNode）を、このリングバッファが
        // 再生中の音声（例: 「〇〇に確認します、少々お待ちください」）と重ねずに済むよう、
        // 残り再生時間をサンプル数で返す。呼び出し元はこれをsource.start()の開始時刻に加算する。
        this.port.postMessage({ remainingSamples: this._count });
        return;
      }
      const src = new Float32Array(data);
      if (src.length > this._cap - this._count) this._grow(src.length);
      const free = this._cap - this._count;
      const n    = Math.min(src.length, free);
      for (let i = 0; i < n; i++) {
        this._ring[this._writeIdx] = src[i];
        if (++this._writeIdx >= this._cap) this._writeIdx = 0;
      }
      this._count += n;
      if (n < src.length) {
        // 上限まで拡張してもなお入りきらなかった場合。以前はここで黙って捨てていたため
        // 「音声が途中で途切れる」という現象として現れるだけで原因が追えなかった。必ず通知する。
        this.port.postMessage({ droppedSamples: src.length - n, capSamples: this._cap });
      }
    };
  }

  /** 上限まで容量を倍々に拡張し、既存の未再生データを先頭から詰め直す。 */
  _grow(minAdditional) {
    const needed = this._count + minAdditional;
    let newCap = this._cap;
    while (newCap < needed && newCap < this._maxCap) {
      newCap = Math.min(newCap * 2, this._maxCap);
    }
    if (newCap === this._cap) return;
    const next = new Float32Array(newCap);
    for (let i = 0; i < this._count; i++) {
      next[i] = this._ring[(this._readIdx + i) % this._cap];
    }
    this._ring     = next;
    this._cap      = newCap;
    this._readIdx  = 0;
    this._writeIdx = this._count;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this._count > 0) {
        out[i] = this._ring[this._readIdx];
        if (++this._readIdx >= this._cap) this._readIdx = 0;
        this._count--;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor('secretary-playback-processor', SecretaryPlaybackProcessor);
`;
