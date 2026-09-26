/**
 * @file 秘書のヘルパーエージェントの仕事（ジョブ）の記録
 *
 * Gemini Live は1秒に満たない間でターンを交代する前提なので、数分かかる処理を会話の中で待つと、
 * 会話が固まるか切られる（実際、45秒の時間切れがわずかに先に来て、成功していた分析が失敗と報告された）。
 * そこで「受け付けた、後で報告する」というジョブを置き、このモジュールはその記録だけを持つ
 * （実行と報告は lib/secretary-helper-agent.js）。
 *
 * ファイルに残す理由は2つ:
 *   - サーバーの再起動をまたいで、動いたまま取り残されたジョブを見つけるため
 *   - あとの会話で「さっきの結果を Obsidian に残して」と言われたときに参照するため
 *
 * 保存先: data/secretary/jobs.json（新しい30件）
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

const path = require('path');
const crypto = require('crypto');
const { getLogger } = require('../logger');
const jsonFileStore = require('./json-file-store');
const sessionRegistry = require('./secretary-live-session-registry');

const JOBS_PATH = path.join(__dirname, '..', 'data', 'secretary', 'jobs.json');
const LOG_PREFIX = '[SecretaryJobs]';
/**
 * 残す件数（古いものから消す）。結果の文と画像（base64）を持つのでファイルが大きくなりやすく、控えめにしている。
 */
const MAX_STORED = 30;

// ダッシュボードへの通知。ジョブは会話のターンとは関係なく裏で数分動くので、知らせないとダッシュボードは
// その間ずっと「待機中」に見える。
// ATTENTION: 通知の関数は server.js が起動時に差し込む（dashboard-hub を直接 require すると循環するため）。
let _notifyDashboard = null;
/** ダッシュボードへ通知する関数を登録する。 @param {Function} fn */
function setDashboardNotifier(fn) { _notifyDashboard = fn; }
/**
 * ジョブの状態を、ダッシュボードと会話中の画面へ知らせる。失敗しても例外は出さない。
 *
 * ATTENTION: 画面（リスナーが見ている側）にも必ず流すこと。ジョブは数分かかるうえ、その間モデルは
 * 何も話さないため、知らせないとリスナーには「黙り込んだ」ようにしか見えない（実際に毎回
 * 「どうなってますか」と聞かれていた）。ダッシュボードは運用者向けで、リスナーは見ていない。
 *
 * @param {Record<string, any>|null} job
 */
function _notify(job) {
  if (!job) return;
  _notifyClient(job);
  if (!_notifyDashboard) return;
  try {
    _notifyDashboard({
      // 通常の作業とスライドの作成は同時に動くことがあるので、id でどのジョブかを示す（kind は表示の出し分け用）
      id: job.id,
      kind: job.kind || 'helper',
      state: job.status === 'running' ? 'running' : 'done',
      request: job.request,
      progress: job.progress,
      status: job.status,
      ts: Date.now(),
    });
  } catch (e) {
    getLogger().warn(`${LOG_PREFIX} ダッシュボード通知に失敗: ${e.message}`);
  }
}

/**
 * 会話中の画面へ、ジョブの状態を知らせる。接続が無ければ何もしない。
 * @param {Record<string, any>} job
 * @returns {void}
 */
function _notifyClient(job) {
  try {
    const session = sessionRegistry.getActiveSession();
    if (!session || typeof session.sendJobStatus !== 'function') return;
    session.sendJobStatus({
      id: job.id,
      kind: job.kind || 'helper',
      status: job.status,
      request: job.request || '',
      progress: job.progress || '',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    getLogger().warn(`${LOG_PREFIX} 画面への通知に失敗: ${msg}`);
  }
}

/** 全ジョブを読む。 @returns {Array<Record<string, any>>} */
function _readAll() {
  const list = jsonFileStore.readJsonFile(JOBS_PATH, [], LOG_PREFIX);
  return Array.isArray(list) ? list : [];
}

/** 全ジョブを書く（新しい MAX_STORED 件だけを残す）。 @param {Array<Record<string, any>>} list */
function _writeAll(list) {
  jsonFileStore.writeJsonFile(JOBS_PATH, list.slice(-MAX_STORED), LOG_PREFIX);
}

/**
 * ジョブを1件作って記録する。
 * @param {{ request?: string, origin?: string, kind?: string }} [args]
 *   request はリスナーの依頼の文、origin はどこから来たか（'voice'・'line' など）、
 *   kind は 'helper'（通常の作業）か 'presentation'（スライドの作成）
 * @returns {Record<string, any>} 作ったジョブ
 */
function createJob({ request, origin = 'voice', kind = 'helper' } = {}) {
  const job = {
    id: crypto.randomUUID(),
    request: String(request || '').trim(),
    origin,
    // kind はダッシュボードで、どのエージェントが動いているかを見分けるため
    kind,
    status: 'running',
    progress: '受け付けました',
    resultText: null,
    // 画像は base64 で持つ（画面に出すとき、そのまま使える形）
    resultImage: null,
    resultImageMime: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const list = _readAll();
  list.push(job);
  _writeAll(list);
  getLogger().info(`${LOG_PREFIX} ジョブを受け付けました id=${job.id.slice(0, 8)} 依頼=${job.request.slice(0, 60)}`);
  _notify(job);
  return job;
}

/**
 * ジョブの一部の項目を書き換える。
 * 実行中に他の書き込みが挟まっても取りこぼさないよう、読み直してから書き換える。
 * @param {string} id
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>|null} 該当が無ければ null
 */
function updateJob(id, patch) {
  const list = _readAll();
  const job = list.find((j) => j.id === id);
  if (!job) return null;
  Object.assign(job, patch);
  _writeAll(list);
  return job;
}

/**
 * 進み具合の一言を書き換える（ヘルパーが段階ごとに呼ぶ）。
 * @param {string} id
 * @param {string} progress
 */
function setProgress(id, progress) {
  getLogger().debug(`${LOG_PREFIX} 進捗 id=${String(id).slice(0, 8)}: ${progress}`);
  const job = updateJob(id, { progress });
  _notify(job);
  return job;
}

/**
 * ジョブを完了にし、結果を記録する。
 * @param {string} id
 * @param {{resultText?: string, resultImage?: string, resultImageMime?: string}} [result] 画像は base64
 * @returns {Record<string, any>|null}
 */
function finishJob(id, { resultText, resultImage, resultImageMime } = {}) {
  getLogger().info(`${LOG_PREFIX} 完了 id=${String(id).slice(0, 8)}（${resultImage ? '画像あり・' : ''}${(resultText || '').length}文字）`);
  return _notified(updateJob(id, {
    status: 'done',
    progress: '完了',
    resultText: resultText ?? null,
    resultImage: resultImage ?? null,
    resultImageMime: resultImageMime ?? null,
    finishedAt: new Date().toISOString(),
  }));
}

/**
 * ジョブを失敗にする。
 * @param {string} id
 * @param {any} error
 * @returns {Record<string, any>|null}
 */
function failJob(id, error) {
  getLogger().warn(`${LOG_PREFIX} 失敗 id=${String(id).slice(0, 8)}: ${error}`);
  return _notified(updateJob(id, {
    status: 'failed',
    progress: '失敗',
    error: String(error || '不明なエラー'),
    finishedAt: new Date().toISOString(),
  }));
}

/**
 * ダッシュボードへ知らせてから、ジョブをそのまま返す。
 */
function _notified(job) { _notify(job); return job; }

/** @param {string} id @returns {Record<string, any>|null} 無ければ null */
function getJob(id) {
  return _readAll().find((j) => j.id === id) || null;
}

/**
 * ジョブを新しい順に返す。 @param {{limit?: number}} [opts]
 */
function listJobs({ limit = 10 } = {}) {
  return _readAll().slice(-limit).reverse();
}

/**
 * 動いているジョブだけを新しい順に返す（「今何か動いているか」の判定用）。
 */
function listRunningJobs() {
  return _readAll().filter((j) => j.status === 'running').reverse();
}

/**
 * 動いたまま取り残されたジョブを失敗にする（起動時に呼ぶ）。
 * 前のプロセスが落ちたジョブは二度と終わらないので、そのままだと「処理中です」と答え続けてしまう。
 */
function failOrphanedJobs() {
  const list = _readAll();
  let n = 0;
  for (const job of list) {
    if (job.status !== 'running') continue;
    job.status = 'failed';
    job.progress = '中断';
    job.error = 'サーバーの再起動により処理が中断されました。もう一度お試しください。';
    job.finishedAt = new Date().toISOString();
    n += 1;
  }
  if (n > 0) {
    _writeAll(list);
    getLogger().warn(`${LOG_PREFIX} 再起動により中断された実行中ジョブ${n}件を失敗として確定しました`);
  }
  return n;
}

module.exports = {
  setDashboardNotifier,
  createJob, updateJob, setProgress, finishJob, failJob,
  getJob, listJobs, listRunningJobs, failOrphanedJobs,
};
