/**
 * @file 番組の録音の API（チャンネル別・ALL モードの自動追従・無音のスキップ・履歴の管理）
 *
 * POST /api/recordings/start・/stop、GET /api/recordings/status・/api/recordings（一覧）・/:id/audio・/:id/download、
 * DELETE /api/recordings/:id。録音は RECORDINGS_DIR（server/data/recordings）に MP3 で保存し、履歴は同じ場所の recordings.json に置く。
 *
 * 各チャンネルのミキサーと WebSocket は server.js が後から代入するので、チャンネル名から解決する関数
 * （resolveMixer・resolveWss）を受け取り、リクエストのときに解決する。
 * 秘書はミキサーを通らないので、専用の SecretaryRecorder（lib/secretary-recorder.js）を使う。
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

const fs = require('fs');
const path = require('path');
const { ProgramRecorder } = require('../audio-mixer');
const { SecretaryRecorder, wavBufferToMp3, setActiveRecorder: setActiveSecretaryRecorder, clearActiveRecorder: clearActiveSecretaryRecorder } = require('../lib/secretary-recorder');

const RECORDABLE_CHANNELS = ['live', 'classic', 'jazz', 'mood', 'beatles', 'the_answers'];
const RECORDING_ALL_POLL_MS = 1000;

/**
 * 録音の API を登録する。
 * @param {import('express').Express} app
 * @param {{
 *   RECORDINGS_DIR: string, readJsonFile: Function, uuidv4: () => string,
 *   resolveMixer: (channel: string) => any, resolveWss: (channel: string) => any,
 *   getTheAnswersSystem: () => any,
 * }} ctx
 */
function registerRecordingRoutes(app, ctx) {
  const { RECORDINGS_DIR, readJsonFile, uuidv4, resolveMixer, resolveWss, getTheAnswersSystem } = ctx;

  if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const RECORDINGS_INDEX_PATH = path.join(RECORDINGS_DIR, 'recordings.json');

  function loadRecordingsIndex() {
    return readJsonFile(RECORDINGS_INDEX_PATH, []);
  }
  function saveRecordingsIndex(list) {
    fs.writeFileSync(RECORDINGS_INDEX_PATH, JSON.stringify(list, null, 2), 'utf-8');
  }

  // チャンネル名から今のミキサーと WebSocket へ（起動後に代入し直されるので、呼ぶたびに解決する）
  const getMixerForRecording = (channel) => resolveMixer(channel);
  const getWssForRecording   = (channel) => resolveWss(channel);

  // ALL モードで録るチャンネル（リスナーが1人以上いるもの。複数なら先頭）。無ければ null
  function getListenedChannel() {
    for (const ch of RECORDABLE_CHANNELS) {
      const w = getWssForRecording(ch);
      if (w && w.clients.size > 0) return ch;
    }
    return null;
  }

  // ALL モードでは、1回の視聴を1つの録音にする。リスナーがいなくなったらその録音を確定して履歴に残し、
  // ALL モードが続いていれば次の視聴を待つ（チャンネルをまたいで1本につなげることはしない）
  let allModeArmed  = null; // { pollTimer } | null（ALL モードで待機中か）
  let activeRecording = null; // { channel, filename, filePath, startedAt, recorder, isAll } | null

  // 録音を履歴に残す。中身が無い（無音だけ）ならファイルごと捨てて、履歴には残さない。
  function saveRecordingEntry(filePath, filename, channel, startedAt, result) {
    if (!result || !result.dataBytes) {
      try { fs.unlinkSync(filePath); } catch { /* 既に存在しない */ }
      return null;
    }
    const stat = fs.statSync(filePath);
    const endedAt = Date.now();
    const skippedSec = Math.round((result.skippedMs || 0) / 1000);
    const entry = {
      id: uuidv4(),
      channel,
      filename,
      startedAt,
      endedAt,
      durationSec: Math.max(0, Math.round((endedAt - startedAt) / 1000) - skippedSec),
      skippedSec,
      sizeBytes: stat.size,
    };
    const list = loadRecordingsIndex();
    list.unshift(entry);
    saveRecordingsIndex(list);
    return entry;
  }

  // チャンネルの録音を始める（単独のチャンネルでも、ALL モードの各視聴でも使う）。
  // 秘書だけはミキサーを通らないので、SecretaryRecorder を使う（MP3 への変換は確定のときに行う）。
  function beginRecordingSession(channel, isAll) {
    const startedAt = Date.now();
    const ts = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (channel === 'secretary') {
      const filename = `secretary_${ts}.mp3`;
      const filePath = path.join(RECORDINGS_DIR, filename);
      const recorder = new SecretaryRecorder();
      setActiveSecretaryRecorder(recorder);
      activeRecording = { channel, filename, filePath, startedAt, recorder, isAll };
      return;
    }
    const filename = `${channel}_${ts}.mp3`;
    const filePath = path.join(RECORDINGS_DIR, filename);
    const recorder = new ProgramRecorder();
    recorder.start(filePath);
    getMixerForRecording(channel)?.attachRecorder(recorder);
    activeRecording = { channel, filename, filePath, startedAt, recorder, isAll };
  }

  // 今の録音を確定して履歴に残す（中身が無ければファイルを捨てる）
  async function finalizeRecordingSession() {
    if (!activeRecording) return null;
    const { channel, filename, filePath, startedAt, recorder } = activeRecording;
    let result;
    if (channel === 'secretary') {
      clearActiveSecretaryRecorder();
      const finished = recorder.finish(); // WAV を組み立てるだけ（同期）
      if (finished) {
        // 他のチャンネルと形式をそろえるため、MP3 に変換して保存する
        const mp3Buffer = await wavBufferToMp3(finished.buffer);
        fs.writeFileSync(filePath, mp3Buffer);
        result = { skippedMs: finished.skippedMs, dataBytes: finished.dataBytes };
      } else {
        result = null;
      }
    } else {
      getMixerForRecording(channel)?.detachRecorder();
      result = await recorder.stop(); // { path, skippedMs, dataBytes } | null
    }
    activeRecording = null;
    return saveRecordingEntry(filePath, filename, channel, startedAt, result);
  }

  // ALL モードの見回り: 視聴中のチャンネルに応じて録音を始める・確定する。
  // 確定（ffmpeg のエンコードの終わり）を待つ間に、重ねて走らないようにする
  let _pollAllModeRunning = false;
  async function pollAllMode() {
    if (!allModeArmed || _pollAllModeRunning) return;
    _pollAllModeRunning = true;
    try {
      const ch = getListenedChannel();
      if (ch && !activeRecording) {
        beginRecordingSession(ch, true);
      } else if (!ch && activeRecording) {
        await finalizeRecordingSession();
      } else if (ch && activeRecording && ch !== activeRecording.channel) {
        // 視聴がゼロにならずに別のチャンネルへ移った場合も、前の録音を確定してから始める
        await finalizeRecordingSession();
        beginRecordingSession(ch, true);
      }
    } finally {
      _pollAllModeRunning = false;
    }
  }

  /** POST /api/recordings/start — 指定チャンネル（または 'all'）の番組録音を開始 */
  app.post('/api/recordings/start', async (req, res) => {
    const { channel } = req.body || {};
    const isAll = channel === 'all';
    // 秘書はミキサーを持たないので、ミキサーの有無では確かめられず、別に許可する
    if (!isAll && channel !== 'secretary' && !getMixerForRecording(channel)) {
      return res.status(400).json({ error: '対象チャンネルが無効です（24/You は録音に対応していません）' });
    }
    if (activeRecording || allModeArmed) {
      return res.status(409).json({ error: `既に${activeRecording?.channel || 'ALL'}チャンネルを録音中です。先に停止してください。` });
    }
    // ATTENTION: The Answers はエピソードごとに自動で録音している。ミキサーに付けられる録音先は1つだけなので、
    //            ここで別の録音先を付けると、自動の録音ができなくなる。
    if (channel === 'the_answers' && getTheAnswersSystem()?._state === 'running') {
      return res.status(409).json({ error: 'The Answersは進行中のエピソードを自動でアーカイブ録音しています。手動録音は不要です（管理画面のアーカイブから再生・確認できます）。' });
    }

    try {
      if (isAll) {
        allModeArmed = { pollTimer: setInterval(pollAllMode, RECORDING_ALL_POLL_MS) };
        await pollAllMode(); // すでに視聴中なら、すぐに始める
      } else {
        beginRecordingSession(channel, false);
      }
      res.json({ ok: true, channel, startedAt: activeRecording ? activeRecording.startedAt : null });
    } catch (e) {
      if (allModeArmed) { clearInterval(allModeArmed.pollTimer); allModeArmed = null; }
      activeRecording = null;
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /api/recordings/stop — 録音（ALLモードは待機も含め）を停止する。進行中のセッションは履歴に確定する */
  app.post('/api/recordings/stop', async (req, res) => {
    if (!activeRecording && !allModeArmed) return res.json({ ok: false, message: '録音は開始されていません' });
    try {
      if (allModeArmed) {
        clearInterval(allModeArmed.pollTimer);
        allModeArmed = null;
      }
      const entry = await finalizeRecordingSession();
      if (entry) {
        res.json({ ok: true, recording: entry });
      } else {
        res.json({ ok: false, message: '録音内容がありませんでした（対象チャンネルの視聴がなかったため）' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /api/recordings/status — 現在の録音状況（画面再読み込み時の状態復元用） */
  app.get('/api/recordings/status', (req, res) => {
    if (!activeRecording && !allModeArmed) return res.json({ recording: false });
    res.json({
      recording: true,
      channel: allModeArmed ? 'all' : activeRecording.channel,
      // ALL モードで今録っているチャンネル（待機中は null）
      currentTarget: activeRecording ? activeRecording.channel : null,
      startedAt: activeRecording ? activeRecording.startedAt : null,
    });
  });

  /** GET /api/recordings — 録音履歴一覧 */
  app.get('/api/recordings', (req, res) => {
    res.json(loadRecordingsIndex());
  });

  /** GET /api/recordings/:id/audio — 録音 MP3 の再生（Range 対応・シーク可） */
  app.get('/api/recordings/:id/audio', (req, res) => {
    const list = loadRecordingsIndex();
    const entry = list.find(r => r.id === req.params.id);
    if (!entry) return res.status(404).json({ error: '見つかりません' });
    const filePath = path.join(RECORDINGS_DIR, entry.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'ファイルが存在しません' });
    res.sendFile(filePath);
  });

  /** GET /api/recordings/:id/download — 録音 MP3 をダウンロードさせる（保存時点で既に MP3 のためそのまま送るだけ） */
  app.get('/api/recordings/:id/download', (req, res) => {
    const list = loadRecordingsIndex();
    const entry = list.find(r => r.id === req.params.id);
    if (!entry) return res.status(404).json({ error: '見つかりません' });
    const filePath = path.join(RECORDINGS_DIR, entry.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'ファイルが存在しません' });
    res.download(filePath, entry.filename);
  });

  /** DELETE /api/recordings/:id — 録音を履歴・ディスクから削除 */
  app.delete('/api/recordings/:id', (req, res) => {
    const list = loadRecordingsIndex();
    const idx = list.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '見つかりません' });
    const [entry] = list.splice(idx, 1);
    try { fs.unlinkSync(path.join(RECORDINGS_DIR, entry.filename)); } catch { /* already gone */ }
    saveRecordingsIndex(list);
    res.json({ ok: true });
  });
}

module.exports = { registerRecordingRoutes };
