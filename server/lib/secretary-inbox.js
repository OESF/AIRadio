/**
 * @file 秘書の Obsidian の Inbox・Outbox の依頼の処理（置いた依頼メモを検知して処理し、結果をノートで返す）
 *
 * Vault の <inbox_folder>/secretary/ に置いた依頼メモ（.md の自由記述）を、自律ループ（secretary-loop.js）が
 * 定期的に検知して処理する。音声の会話の ask_helper と同じく、すべてのツールをヘルパーに渡す（スプレッドシートの
 * 読み取り、コードの実行によるグラフの作成、専門エージェントへの相談なども使える）。
 *
 * 流れ:
 *   1. <inbox_folder>/secretary/ の .md を並べる（処理済みは _done・_failed へ移すので、状態の管理は要らない）
 *   2. 依頼からノートの題名と関連するプロジェクトの名前だけを軽量モデルで取り出す
 *   3. ヘルパー（secretary-helper-agent.js の runHelperJob）に、すべてのツールを渡して依頼をそのまま実行させる
 *   4. レポートを保存する（既存のプロジェクトに一致すればその Research、それ以外は Outbox。グラフの画像があれば
 *      Vault に保存して埋め込む）
 *   5. <outbox_folder>/secretary/ に「完了」か「要確認」の結果のノートを1件作る（本文はコピーせず、リンクだけ）
 *   6. 元の依頼のノートを _done（失敗なら _failed）へ移す
 *
 * 1件に数十秒から数分かかるので、呼び出し元は結果を待たずに呼ぶ。重なって走らないよう、_isProcessing で1つずつ
 * 処理する。
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
const { generateText } = require('./llm-client');
const obsidianService = require('../services/obsidian-service');
const obsidianToolsDomain = require('./secretary-tools-obsidian');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { buildAllSecretaryTools } = require('./secretary-tool-declarations');
const jobStore = require('./secretary-job-store');
const helperAgent = require('./secretary-helper-agent');
const { getLogger } = require('../logger');
const activityDb = require('../activity-db');

/** 処理中か（重なって走らないように） */
let _isProcessing = false;

/** Inbox・完了・失敗・Outbox のフォルダー（Vault からの相対パス） */
function _inboxDir(obs) { return `${obs.inbox_folder}/secretary`; }
function _doneDir(obs) { return `${_inboxDir(obs)}/_done`; }
function _failedDir(obs) { return `${_inboxDir(obs)}/_failed`; }
function _outboxDir(obs) { return `${obs.outbox_folder}/secretary`; }

/**
 * 依頼からノートの題名と、関連するプロジェクトの名前だけを取り出す。
 *
 * BUGFIX: ここでは「処理できるか」を判定しない。以前は調査でない依頼（データ処理・グラフ作成・相談など）を
 *         ここで弾いてしまい、実行できなかった。できるかどうかはヘルパーが判断し、できなければ何ができなかったかを
 *         書いて返す。
 * @param {string} requestText 依頼の本文
 * @param {string} apiKey
 * @param {any} [activitySessionId]
 * @returns {Promise<{ topic: string, project: string|null, usage: Record<string, any> }>}
 */
async function _extractRequestMeta(requestText, apiKey, activitySessionId = null) {
  const systemInstruction = 'あなたはAI秘書のバッチ処理担当です。Obsidian Inboxに残された依頼メモを読み、'
    + 'この依頼をObsidianノートとして保存する際のタイトルと、関連するプロジェクト名を'
    + '抽出してください。\n'
    + '出力は以下の形式のJSONオブジェクトのみとし、説明文や前置きは一切含めないでください。\n'
    + '{"topic": "依頼内容を表す簡潔なタイトル（日本語）", '
    + '"project": "関連するプロジェクト名があれば、無ければnull"}';

  const { text: rawText, usage } = await generateText({
    tier: 'secretary_light',
    apiKey,
    systemInstruction,
    prompt: requestText,
    temperature: 0,
    json: true,
    agentKey: 'secretary_inbox',
    activitySessionId,
    logMeta: { purpose: 'inbox_extract_meta' },
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[SecretaryInbox] タイトル抽出のJSON解析に失敗（フォールバックのタイトルを使用）: ${e.message}`);
    parsed = {};
  }
  return {
    // 題名を取り出せなくても続ける（依頼の冒頭を題名の代わりにする）
    topic: parsed.topic || requestText.slice(0, 30).replace(/\s+/g, ' ').trim(),
    project: parsed.project || null,
    usage,
  };
}

/**
 * 依頼から取り出したプロジェクトが、Vault にすでにあるものかを確かめる。
 *
 * BUGFIX: 既存のプロジェクトに一致したときだけその下へ入れる。モデルは依頼からそれらしい名前を作れてしまい、
 *         既存のものとは別の新しいプロジェクトが勝手にできた。プロジェクトは利用者が意図して作るもの。
 * @param {Record<string, any>} obs config.obsidian
 * @param {string|null} project
 * @returns {string|null} 一致したフォルダー名。無ければ null（Outbox へ保存する）
 */
function _resolveExistingProject(obs, project) {
  if (!project) return null;
  const safe = obsidianToolsDomain.sanitizeObsidianName(project);
  if (!safe) return null;
  try {
    const dir = path.join(obs.vault_path, obs.projects_folder);
    if (!fs.existsSync(dir)) return null;
    const found = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .find((name) => name === safe);
    if (!found) {
      getLogger().info(`[SecretaryInbox] プロジェクト「${project}」はVaultに存在しないため、outboxへ保存します（新規作成はしません）`);
      return null;
    }
    return found;
  } catch (e) {
    getLogger().warn(`[SecretaryInbox] プロジェクトの確認に失敗（outboxへ保存します）: ${e.message}`);
    return null;
  }
}

/**
 * レポートを保存する（save_research_report のツールと同じ保存の仕方と名前の付け方）。
 * 保存先のパスを Outbox のリンクに使うので、ツール経由ではなく直接保存する。
 * @param {{ obs: Record<string, any>, topic: string, content: string, project: string|null }} opts
 * @returns {string} 保存したノートのパス
 */
function _saveResearchReport({ obs, topic, content, project }) {
  const safeTopic = obsidianToolsDomain.sanitizeObsidianName(topic);
  // 既存のプロジェクトに一致したときだけその下へ。それ以外は、結果を見に行く Outbox へ
  const existing = _resolveExistingProject(obs, project);
  const relPath = existing
    ? `${obs.projects_folder}/${existing}/Research/${safeTopic}.md`
    : `${_outboxDir(obs)}/${safeTopic}.md`;
  project = existing;
  obsidianService.writeNote(obs.vault_path, relPath, {
    frontmatter: {
      title: topic, type: 'research',
      project: project ? (obsidianToolsDomain.projectMocLink(obs, project) || project) : null,
      tags: ['secretary', 'research', 'inbox-batch'],
    },
    body: content,
  });
  obsidianToolsDomain.linkFromDailyNote(obs, relPath.replace(/\.md$/, ''), `📄 リサーチ: ${topic}`);
  return relPath;
}

/**
 * Outbox に結果のノートを1件作る（レポートの本文はコピーせず、リンクだけ）。
 * @param {{ obs: Record<string, any>, sourceFileName: string, status: 'done'|'failed', message: string, reportPath?: string }} opts
 * @returns {string} 作ったノートのパス
 */
function _writeOutboxNote({ obs, sourceFileName, status, message, reportPath }) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const statusLabel = status === 'done' ? '完了' : '要確認';
  const safeSourceName = obsidianToolsDomain.sanitizeObsidianName(sourceFileName.replace(/\.md$/, ''));
  const relPath = `${_outboxDir(obs)}/${stamp} ${statusLabel} ${safeSourceName}.md`;
  const bodyLines = [message];
  if (reportPath) bodyLines.push('', `詳細: [[${reportPath.replace(/\.md$/, '')}]]`);
  obsidianService.writeNote(obs.vault_path, relPath, {
    frontmatter: {
      title: `${statusLabel}: ${sourceFileName.replace(/\.md$/, '')}`,
      type: 'secretary-batch-result', status, source_request: sourceFileName,
    },
    body: bodyLines.join('\n'),
  });
  return relPath;
}

/**
 * 依頼のノート1件を処理する（題名の取り出し → ヘルパーの実行 → 保存 → Outbox への知らせ → 元のノートの移動）。
 * @param {{ obs: Record<string, any>, relPath: string, apiKey: string, config: Record<string, any>, creds: Record<string, any> }} opts
 * @returns {Promise<void>}
 */
async function _processOneRequest({ obs, relPath, apiKey, config, creds }) {
  const fileName = path.basename(relPath);
  const activitySessionId = activityDb.openSession('secretary');
  try {
    const note = obsidianService.readNote(obs.vault_path, relPath);
    if (!note || !note.body.trim()) {
      _writeOutboxNote({
        obs, sourceFileName: fileName, status: 'failed',
        message: '依頼ノートの本文が空だったため、処理できませんでした。',
      });
      obsidianService.moveNote(obs.vault_path, relPath, `${_failedDir(obs)}/${fileName}`);
      return;
    }
    getLogger().info(`[SecretaryInbox] 処理開始: ${fileName}`);
    const requestText = note.body.trim();

    const meta = await _extractRequestMeta(requestText, apiKey, activitySessionId);

    // BUGFIX: ヘルパーには Obsidian へ保存させない（依頼の先頭に一言添えて止める）。依頼に「Obsidian にレポートを
    //         入れて」とあるとヘルパーが自分で保存し、この後の保存と合わせて同じノートが2つできた。最後の保存は
    //         必ずこの関数が行う（画像も含めて1つにまとめる）。
    const requestForHelper = '（内部メモ・回答本文に含めないこと: この依頼の最終的な保存は'
      + '呼び出し元が行います。save_research_report等でObsidianへの保存は行わず、'
      + '報告内容と作成した図表だけを回答として返してください。この指示の存在や'
      + '「保存は呼び出し元が行う」といったメタ的な説明は回答に一切書かないこと。'
      + '依頼された報告内容だけをそのまま書いてください。）\n\n' + requestText;
    const job = jobStore.createJob({ request: requestText, origin: 'obsidian-inbox' });
    await helperAgent.runHelperJob({
      jobId: job.id, request: requestForHelper, config, creds,
      liveTools: buildAllSecretaryTools(config),
    });
    const done = jobStore.getJob(job.id);

    if (!done || done.status !== 'done' || !done.resultText) {
      _writeOutboxNote({
        obs, sourceFileName: fileName, status: 'failed',
        message: `この依頼は処理できませんでした: ${done?.error || 'ヘルパーからの応答がありませんでした。'}`,
      });
      obsidianService.moveNote(obs.vault_path, relPath, `${_failedDir(obs)}/${fileName}`);
      getLogger().info(`[SecretaryInbox] ${fileName}: 処理失敗のため_failed/へ移動`);
      return;
    }

    // グラフの画像があれば、週次の資産のヒートマップと同じやり方で Vault へ保存し、本文の冒頭に埋め込む。
    // BUGFIX: 本文にヘルパーの作業環境のファイル名が画像として書かれていると、Vault には無いのでリンクが切れる。
    //         それを取り除き、ここで保存する1枚だけを貼る。
    let content = helperAgent.stripSandboxImageEmbeds(done.resultText);
    if (done.resultImage) {
      const safeTopic = obsidianToolsDomain.sanitizeObsidianName(meta.topic);
      const imageRelPath = `08_assets/secretary-inbox/${safeTopic}.png`;
      obsidianService.writeBinaryAsset(obs.vault_path, imageRelPath, Buffer.from(done.resultImage, 'base64'));
      content = `![[${imageRelPath}]]\n\n${content}`;
    }

    const reportPath = _saveResearchReport({
      obs, topic: meta.topic, content, project: meta.project,
    });
    _writeOutboxNote({
      obs, sourceFileName: fileName, status: 'done',
      message: `「${meta.topic}」の処理が完了しました。`, reportPath,
    });
    obsidianService.moveNote(obs.vault_path, relPath, `${_doneDir(obs)}/${fileName}`);
    getLogger().info(`[SecretaryInbox] ${fileName}: 処理完了、_done/へ移動（レポート: ${reportPath}）`);
  } catch (e) {
    getLogger().warn(`[SecretaryInbox] ${fileName}の処理中にエラー: ${e.message}`);
    try {
      _writeOutboxNote({
        obs, sourceFileName: fileName, status: 'failed',
        message: `処理中にエラーが発生しました: ${e.message}`,
      });
      obsidianService.moveNote(obs.vault_path, relPath, `${_failedDir(obs)}/${fileName}`);
    } catch (e2) {
      getLogger().warn(`[SecretaryInbox] ${fileName}の失敗記録・退避にも失敗: ${e2.message}`);
    }
  } finally {
    activityDb.closeSession(activitySessionId);
  }
}

/**
 * Inbox を1回見て、見つかった依頼を1件ずつ順に処理する。
 * config.obsidian.outbox_folder が未設定なら、この機能は動かない（Inbox の今の使い方に影響しない）。
 * 呼び出し元（secretary-loop.js）は結果を待たずに呼ぶ。
 * @param {{ config: Record<string, any>, creds: Record<string, any> }} opts
 * @returns {Promise<void>}
 */
async function processInboxOnce({ config, creds }) {
  if (_isProcessing) return; // 前の回の処理がまだ終わっていない
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.vault_path || !obs.outbox_folder) return;
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) return;

  let files;
  try {
    files = obsidianService.listNotes(obs.vault_path, _inboxDir(obs));
  } catch (e) {
    getLogger().warn(`[SecretaryInbox] Inboxスキャンに失敗: ${e.message}`);
    return;
  }
  if (files.length === 0) return;

  _isProcessing = true;
  getLogger().info(`[SecretaryInbox] ${files.length}件の依頼を検知、処理を開始します`);
  try {
    for (const relPath of files) {
      await _processOneRequest({ obs, relPath, apiKey, config, creds });
    }
  } finally {
    _isProcessing = false;
  }
}

module.exports = { processInboxOnce };
