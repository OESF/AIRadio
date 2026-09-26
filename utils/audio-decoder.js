/**
 * @file ffmpeg で音声ファイルを PCM へデコードする（BGM のループ・ジングル・効果音）
 *
 * ミキサー（server/audio-mixer.js）と効果音の一覧（server/sfx-library.js）が使う。出力はミキサーに合わせて 24kHz。
 * BGM とジングルはストリームで返し、効果音はメモリに置けるよう Buffer で返す。
 *
 * ATTENTION: サンプリングレートはミキサーと必ずそろえる。ずれると音程と速さが変わる。
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

const { spawn } = require('child_process');
const ffprobeStatic = require('ffprobe-static');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { getLogger } = require('../server/logger');

/**
 * ffprobe でファイルか URL を調べ、最初のストリームの情報を返す。
 * @param {string} inputPath ファイルのパスか URL
 * @returns {Promise<Record<string, any>>} codec_name・channels・sample_rate
 */
function probe(inputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'json', inputPath];
    const proc = spawn(ffprobeStatic.path, args);
    let data = '';
    proc.stdout.on('data', chunk => data += chunk);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const json = JSON.parse(data);
        resolve(json.streams[0] || {});
      } catch (e) {
        reject(e);
      }
    });
    proc.stderr.on('data', () => {});
  });
}

/**
 * 音声（MP3・WAV・OGG・AAC など）を、24bit・24kHz・ステレオの PCM（s24le）へ、ループさせながらデコードする（BGM 用）。
 * @param {string} inputPath ファイルのパスか URL
 * @returns {Promise<import('stream').Readable>} PCM のストリーム
 */
async function decodeTo24le(inputPath) {
  // ローカルのファイルは、先に有無を確かめる
  if (!inputPath.startsWith('http')) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }
  }

  const args = [
    '-stream_loop', '-1', // BGM なのでループさせる
    '-i', inputPath,
    '-ar', '24000',      // ミキサーと同じサンプリングレート
    '-ac', '2',          // ステレオ
    '-f', 's24le',
    '-acodec', 'pcm_s24le',
    'pipe:1'
  ];
  const ff = spawn(ffmpegStatic, args);

  // ミキサーが BGM の切り替えなどでストリームを閉じたときは、終了コードに関わらず正常な終了とみなす。
  // SIGTERM の後の終了コードは環境やタイミングで 224・255 以外（例: 1）にもなり、コードだけでは
  // 意図した停止と本当の失敗を区別できないので、stdout 側から閉じたかどうかで判定する
  let stoppedByUs = false;
  ff.stdout.on('close', () => {
    stoppedByUs = true;
    if (!ff.killed) ff.kill('SIGTERM');
  });

  const BROKEN_PIPE_PATTERNS = [
    'broken pipe',
    'error muxing',
    'error writing trailer',
    'conversion failed',
  ];
  ff.stderr.on('data', (data) => {
    const logStr = data.toString().trim();
    const lower = logStr.toLowerCase();
    if (BROKEN_PIPE_PATTERNS.some(p => lower.includes(p))) return;
    if (lower.includes('error') || lower.includes('fail')) {
      getLogger().error(`[Decoder ERROR] ${logStr}`);
    }
  });

  ff.on('close', (code) => {
    if (stoppedByUs) return;
    if (code !== 0 && code !== null && code !== 224) {
      getLogger().error(`[Decoder] ffmpeg exited with code ${code}`);
    }
  });

  return ff.stdout;
}

/**
 * decodeTo24le と同じだが、ループさせずに1回だけデコードする（ジングル用）。
 * パイプが閉じたときの Broken pipe 系のメッセージはログに出さない。
 * @param {string} inputPath ファイルのパス
 * @returns {Promise<import('stream').Readable>} PCM のストリーム
 */
async function decodeTo24leOnce(inputPath) {
  if (!inputPath.startsWith('http')) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }
  }

  const args = [
    '-i', inputPath,
    '-ar', '24000',
    '-ac', '2',
    '-f', 's24le',
    '-acodec', 'pcm_s24le',
    'pipe:1'
  ];
  const ff = spawn(ffmpegStatic, args);

  // 意図して閉じたときは正常な終了とみなす（decodeTo24le と同じ理由）
  let stoppedByUs = false;
  ff.stdout.on('close', () => {
    stoppedByUs = true;
    if (!ff.killed) ff.kill('SIGTERM');
  });

  // Broken pipe 系は、ジングルの再生を終えたときに必ず出る正常な終了の知らせなので無視する
  const BROKEN_PIPE_PATTERNS = [
    'broken pipe',
    'error muxing',
    'error writing trailer',
    'conversion failed',
  ];
  ff.stderr.on('data', (data) => {
    const logStr = data.toString().trim();
    const lower = logStr.toLowerCase();
    if (BROKEN_PIPE_PATTERNS.some(p => lower.includes(p))) return;
    if (lower.includes('error') || lower.includes('fail')) {
      getLogger().error(`[Decoder ERROR] ${logStr}`);
    }
  });

  ff.on('close', (code) => {
    // 意図した停止なら無視する。224（macOS の SIGPIPE）と 255（macOS の SIGTERM）も念のため正常とみなす
    if (stoppedByUs) return;
    if (code !== 0 && code !== null && code !== 224 && code !== 255) {
      getLogger().error(`[Decoder] ffmpeg (once) exited with code ${code}`);
    }
  });

  return ff.stdout;
}

/**
 * 短い音声（効果音など）を、16bit・24kHz・モノラルの PCM（s16le）の Buffer へ一度にデコードする。
 *
 * ミキサーへ何度も差し込むので、あらかじめ一度だけデコードしてメモリに置く用途。音声合成の音量と
 * そろえるため loudnorm をかける。
 * @param {string} inputPath ファイルのパス
 * @returns {Promise<Buffer>}
 */
function decodeToPcm16MonoOnce(inputPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error(`Input file not found: ${inputPath}`));
      return;
    }
    const args = [
      '-i', inputPath,
      '-af', 'loudnorm=I=-14:LRA=7:TP=-1',
      '-ar', '24000',
      '-ac', '1',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
    const ff = spawn(ffmpegStatic, args);
    const chunks = [];
    ff.stdout.on('data', chunk => chunks.push(chunk));
    ff.stderr.on('data', (data) => {
      const logStr = data.toString().trim();
      if (logStr.toLowerCase().includes('error')) {
        getLogger().error(`[Decoder ERROR] ${logStr}`);
      }
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`ffmpeg (pcm16mono) exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

module.exports = { decodeTo24le, decodeTo24leOnce, decodeToPcm16MonoOnce, probe };
