/**
 * @file Secretary の Obsidian 連携ツール（ノートの検索・読み取り・記録・保存）
 *
 * Secretary が使う Obsidian 関連の6ツール（検索・1件の読み取り・デイリーノートへの記録・
 * リサーチの保存・会議ノート・プロジェクトのタスク）の宣言とハンドラ。独自の保存先は持たず、
 * リスナーが実際に使っている Obsidian の Vault へ obsidian-service.js 経由で直接読み書きする。
 *
 * Vault の外へ書き込ませない最後の守りは obsidian-service.js の resolveSafePath が持つ。ここでは
 * その前に、連携が有効かどうか（_requireObsidian）と、ファイル名に使う文字列の無害化
 * （sanitizeObsidianName）を行う。
 *
 * _requireObsidian は日報・週報・資産レポート（secretary-tools-reports.js・secretary-tools-finance.js）も、
 * sanitizeObsidianName・projectMocLink・linkFromDailyNote は Inbox の一括処理（secretary-inbox.js）も使う。
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

const obsidianService = require('../services/obsidian-service');
const { getLogger } = require('../logger');
const secretaryStore = require('./secretary-store');

const OBSIDIAN_DISABLED_ERROR = { error: 'Obsidian連携が現在無効です。管理画面で設定してください。' };

// read_obsidian_note が1回に返す最大文字数。デイリーノート（実測で約8,300字）もウィークリーノート
// （約9,500字）も1回で丸ごと読める大きさにしている。これより長いノートは offset で続きを読む。
const READ_NOTE_MAX_CHARS = 20000;

/**
 * 伝えられたパスや日付を、Vault の中に実在するノートのパスへ解決する。
 *
 * @param {Record<string, any>} obs 設定の obsidian（vault_path・各フォルダー）
 * @param {string} requested Vault 内のパス、またはノートの日付（YYYY-MM-DD）
 * @returns {any} Vault からの相対パス（文字列。見つからなければ null）
 */
function _resolveNote(obs, requested) {
  return obsidianService.resolveNotePath(obs.vault_path, requested, {
    dailyNotesFolder: obs.daily_notes_folder,
    weeklyNotesFolder: obs.weekly_notes_folder,
  });
}

/**
 * Obsidian 連携が有効か（enabled と vault_path がそろっているか）を確かめる共通の関門。
 *
 * @param {Record<string, any>} config 設定全体
 * @returns {{obs: Record<string, any>, error: null} | {obs: null, error: {error: string}}}
 *   有効なら設定の obsidian、無効ならリスナーへ返すエラー
 */
function _requireObsidian(config) {
  const obs = config.obsidian || {};
  if (!obs.enabled || !obs.vault_path) return { obs: null, error: OBSIDIAN_DISABLED_ERROR };
  return { obs, error: null };
}

/**
 * ノートのファイル名・フォルダー名に使う文字列を無害化する（パスの区切りなどを _ に置き換え、80字で切る）。
 *
 * topic・title・project は LLM が自由に組み立てるので、パスの区切りが入りうる。Vault の外への
 * 書き込みは obsidian-service.js でも防いでいるが、ここは意図しないサブフォルダーを作らせないための一段目。
 *
 * @param {string} name 元の文字列
 * @returns {string} 無害化した名前（空なら「無題」）
 */
function sanitizeObsidianName(name) {
  const cleaned = (name || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  return cleaned || '無題';
}

/**
 * プロジェクトのフォルダーのパス（projects_folder/プロジェクト名）を組み立てる。
 *
 * @param {Record<string, any>} obs 設定の obsidian
 * @param {string} project プロジェクト名
 * @returns {string} Vault からの相対パス
 */
function _projectDir(obs, project) {
  return `${obs.projects_folder}/${sanitizeObsidianName(project)}`;
}

/**
 * プロジェクトの MOC（Map of Content、例: 02_Projects/AI Radio/_MOC.md）があれば、そこへの
 * wikilink（例: "[[02_Projects/AI Radio/_MOC]]"）を返す。
 *
 * ノートのフロントマターの project に入れて、関連するノートを自動でつなぐために使う。MOC が無い
 * プロジェクトでは null を返し、呼び出し元はプロジェクト名をそのまま書く（存在しないノートへの
 * リンクを大量に作らないため）。
 *
 * @param {Record<string, any>} obs 設定の obsidian
 * @param {string} project プロジェクト名
 * @returns {string|null} MOC への wikilink（無ければ null）
 */
function projectMocLink(obs, project) {
  if (!project) return null;
  const mocPath = `${_projectDir(obs, project)}/_MOC.md`;
  const moc = obsidianService.readNote(obs.vault_path, mocPath);
  if (!moc) return null;
  return `[[${mocPath.replace(/\.md$/, '')}]]`;
}

/**
 * 今日のデイリーノートの「## 🔗 関連ノート」に、作ったノートへのリンクを1行足す。
 *
 * デイリーノートを「その日 Secretary が作ったノートの一覧」にするためのもの。新しいファイルを作った
 * とき（会議ノート・リサーチノート・タスク一覧の新設）だけ呼び、既存ファイルへの小さな追記では呼ばない。
 * 見出しは appendSection がまとめるので、1日に何度呼んでも重複しない。
 * 失敗してもノート自体は作れているので、例外は投げず警告のログだけ残す。
 *
 * @param {Record<string, any>} obs 設定の obsidian
 * @param {string} notePathNoExt リンク先のノート（拡張子 .md を除いた Vault からの相対パス）
 * @param {string} label リンクに表示する文字
 * @returns {void}
 */
function linkFromDailyNote(obs, notePathNoExt, label) {
  try {
    const dailyRelPath = obsidianService.dailyNoteRelPath(obs.daily_notes_folder);
    obsidianService.appendSection(obs.vault_path, dailyRelPath, '🔗 関連ノート', `- [[${notePathNoExt}|${label}]]`, {
      templateRelativePath: obs.daily_note_template,
    });
  } catch (e) {
    getLogger().warn(`[Secretary] デイリーノートへのリンク追記に失敗（ノート自体の作成は成功済み）: ${e.message}`);
  }
}

/**
 * Obsidian 関連ツールの宣言（Function Calling の tool 宣言）。
 * @type {Array<Record<string, any>>}
 */
const TOOL_DECLARATIONS = [
      {
        name: 'search_obsidian_notes',
        description: 'リスナーが実際に使っているObsidian Vault（Markdownのメモアプリ）内の既存ノートを検索します。'
          + '「前にまとめた〇〇の資料ある？」「〇〇プロジェクトの前回の議事録は？」のように、過去のノートを参照したい'
          + 'ときに使います。**返すのは各ノートのパスと短い抜粋だけ**です。ノートの中身を読む・表示するには、'
          + '見つかったパスを read_obsidian_note に渡してください（検索を言い換えて繰り返しても中身は出てきません）。'
          + 'Obsidian連携が管理画面で有効になっていない場合はエラーを返します。',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: '検索キーワード（ノートのタイトル・本文・パスのどれにも一致します）' },
          },
          required: ['query'],
        },
      },
      // BUGFIX: ノートを開いて読むツール。これが無かったころは、検索（抜粋120字だけを返す）と書き込みしか
      // 無く、ヘルパーが中身を求めて検索の言い換えを繰り返し、往復の上限で打ち切られていた
      // （同じ引数の繰り返しを止める仕組みは、言い換えには効かない）。
      {
        name: 'read_obsidian_note',
        description: 'Obsidian Vault内のノートを1件開いて、本文を読みます。ノートの中身を知りたい・要約したい・'
          + '画面に表示したいときに使います。search_obsidian_notes で見つけたパス（例: 03_Daily Notes/2026-09/2026-09-14.md）を'
          + '渡してください。「9月14日のデイリーノート」のように日付で頼まれた場合は、パスが分からなくても path に'
          + '日付（例: 2026-09-14）を入れればデイリーノート・ウィークリーノートの場所を探して開きます。'
          + '長いノートは途中までを返すので、続きは offset を指定して読んでください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Vault内のノートのパス（検索結果に出てくる形）、またはノートの日付（YYYY-MM-DD）' },
            offset: { type: 'NUMBER', description: '何文字目から読むか（長いノートの続きを読むときだけ指定。既定0）' },
          },
          required: ['path'],
        },
      },
      {
        name: 'log_to_daily_note',
        description: '今日のObsidianデイリーノートに、短いメモ・気づき・会話の要点を1件記録します。'
          + '「これメモしておいて」「今日の記録に残しておいて」のような軽い記録依頼に使います。',
        parameters: {
          type: 'OBJECT',
          properties: {
            text: { type: 'STRING', description: '記録する内容（短く簡潔に）' },
          },
          required: ['text'],
        },
      },
      {
        name: 'save_research_report',
        // 説明文の末尾に「いつ呼ぶか」を明示する（Gemini Live のベストプラクティス）。口で「保存しました」と
        // 言うだけで、実際には呼ばないことを防ぐ。
        description: '調べ物・リサーチの結果をObsidianにノートとして保存します。Google検索や専門エージェントへの'
          + '相談で得た情報をまとめて残しておきたいときに使います。特定のプロジェクトに関連する調べ物であれば'
          + 'projectを指定してください（省略した場合は一般的な参考ノートとして保存されます）。'
          + '\n\n【発動条件】リスナーが「調べてノートにまとめておいて」「この件をリサーチして保存して」の'
          + 'ようにリサーチ結果を残すことを求めたら、必ずこの機能を呼び出してください。'
          + '口頭で結果を述べただけでは、どこにも保存されず後から読み返せません。'
          + '「保存しました」「ノートに残しておきます」と言うのであれば、必ず実際にこの機能を'
          + '呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            topic: { type: 'STRING', description: '調べ物のタイトル・テーマ' },
            content: { type: 'STRING', description: 'レポート本文（Markdown形式で見出し・箇条書きを使ってよい）' },
            project: { type: 'STRING', description: '関連するプロジェクト名（あれば）' },
          },
          required: ['topic', 'content'],
        },
      },
      {
        name: 'create_meeting_notes',
        description: '会議の準備メモ、または会議後の議事録をObsidianに保存します。プロジェクト名は必須です'
          + '（どのプロジェクトの会議か分からない場合はリスナーに確認してください）。',
        parameters: {
          type: 'OBJECT',
          properties: {
            project: { type: 'STRING', description: 'プロジェクト名' },
            title: { type: 'STRING', description: '会議名・議題' },
            content: { type: 'STRING', description: '会議の内容（準備メモなら論点・確認事項、議事録なら決定事項・アクションアイテム・次回予定）' },
          },
          required: ['project', 'title', 'content'],
        },
      },
      {
        name: 'update_project_tasks',
        description: 'Obsidian上のプロジェクトのタスク一覧に、タスクを追加または完了にします。'
          + '「〇〇プロジェクトにタスクを追加して」「〇〇のタスクを完了にして」のような依頼に使います。',
        parameters: {
          type: 'OBJECT',
          properties: {
            project: { type: 'STRING', description: 'プロジェクト名' },
            task: { type: 'STRING', description: 'タスクの内容' },
            action: { type: 'STRING', description: '追加なら"add"、完了にするなら"complete"', enum: ['add', 'complete'] },
          },
          required: ['project', 'task', 'action'],
        },
      },
];

/**
 * Obsidian 関連ツールのハンドラ（ツール名 → 処理）。
 *
 * どれも (args, ctx) を受け取り、{ result } か { error } を返す。ctx.config は設定全体。
 * 連携が無効なら OBSIDIAN_DISABLED_ERROR を返す。記録・保存したものは secretaryStore の
 * daily-briefings にも1件残す。
 * @type {Record<string, (args: any, ctx: any) => Promise<Record<string, any>>>}
 */
const TOOL_HANDLERS = {
  search_obsidian_notes: async (args, ctx) => {
    const { config } = ctx;
    const { obs, error: _obsErr } = _requireObsidian(config);
    if (_obsErr) return _obsErr;
    const { query } = args || {};
    const results = obsidianService.searchVault(obs.vault_path, query);
    // パスらしい問い合わせは、本文やファイル名の部分一致では当たらないことがある（フォルダーの形が
    // 違うなど）。実在するノートへ解決できたら、それを先頭に置く。
    if (/[\\/]|\.md$/i.test(String(query || ''))) {
      const direct = _resolveNote(obs, query);
      if (direct && !results.some((r) => r.path === direct)) {
        const note = obsidianService.readNote(obs.vault_path, direct);
        results.unshift({
          path: direct,
          title: note?.frontmatter?.title || direct.split('/').pop().replace(/\.md$/, ''),
          snippet: (note?.body || '').slice(0, 120).replace(/\n/g, ' '),
        });
      }
    }
    const result = results.length === 0
      ? `「${query}」に一致するノートは見つかりませんでした。`
      : `関連しそうなノートが${results.length}件見つかりました（抜粋のみ。中身は read_obsidian_note にパスを渡して読んでください）:\n` +
        results.map(r => `・「${r.title}」（${r.path}）: ${r.snippet}`).join('\n');
    return { result };
  },

  read_obsidian_note: async (args, ctx) => {
    const { config } = ctx;
    const { obs, error: _obsErr } = _requireObsidian(config);
    if (_obsErr) return _obsErr;
    const requested = String(args?.path || '').trim();
    if (!requested) return { error: 'path（ノートのパス、またはノートの日付 YYYY-MM-DD）を指定してください。' };
    const relPath = _resolveNote(obs, requested);
    if (!relPath) {
      return {
        error: `「${requested}」に当たるノートが見つかりませんでした。search_obsidian_notes で探し、`
          + '結果に出てきたパスをそのまま渡してください。',
      };
    }
    const note = obsidianService.readNote(obs.vault_path, relPath);
    if (!note) return { error: `ノート「${relPath}」を読めませんでした。` };
    const raw = note.raw;
    const offset = Math.max(0, Math.floor(Number(args?.offset) || 0));
    if (offset >= raw.length) {
      return { result: `ノート「${relPath}」は全${raw.length}字で、${offset + 1}字目より後ろに本文はありません。` };
    }
    const chunk = raw.slice(offset, offset + READ_NOTE_MAX_CHARS);
    const end = offset + chunk.length;
    const rest = raw.length - end;
    getLogger().info(`[Secretary] Obsidianのノートを読みました: ${relPath}（全${raw.length}字・${offset}〜${end}字目）`);
    const header = rest > 0
      ? `ノート「${relPath}」の本文（全${raw.length}字のうち${offset + 1}〜${end}字目。続きは offset=${end} で読めます）:`
      : `ノート「${relPath}」の本文${offset > 0 ? `（${offset + 1}字目から最後まで）` : ''}:`;
    return { result: `${header}\n\n${chunk}` };
  },

  log_to_daily_note: async (args, ctx) => {
    const { config } = ctx;
    const { obs, error: _obsErr } = _requireObsidian(config);
    if (_obsErr) return _obsErr;
    const { text } = args || {};
    const relPath = obsidianService.dailyNoteRelPath(obs.daily_notes_folder);
    obsidianService.appendSection(obs.vault_path, relPath, 'AI秘書との記録', text, {
      templateRelativePath: obs.daily_note_template,
    });
    const result = '今日のデイリーノートに記録しました。';
    secretaryStore.appendEntry('daily-briefings', { tool: 'log_to_daily_note', result, text });
    return { result };
  },

  save_research_report: async (args, ctx) => {
    const { config } = ctx;
    const { obs, error: _obsErr } = _requireObsidian(config);
    if (_obsErr) return _obsErr;
    const { topic, content, project } = args || {};
    const safeTopic = sanitizeObsidianName(topic);
    const relPath = project
      ? `${_projectDir(obs, project)}/Research/${safeTopic}.md`
      : `${obs.notes_folder}/${safeTopic}.md`;
    obsidianService.writeNote(obs.vault_path, relPath, {
      frontmatter: { title: topic, type: 'research', project: project ? (projectMocLink(obs, project) || project) : null, tags: ['secretary', 'research'] },
      body: content,
    });
    linkFromDailyNote(obs, relPath.replace(/\.md$/, ''), `📄 リサーチ: ${topic}`);
    const result = `リサーチレポート「${topic}」をObsidianに保存しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'save_research_report', result, topic, project });
    return { result };
  },

  create_meeting_notes: async (args, ctx) => {
    const { config } = ctx;
    const { obs, error: _obsErr } = _requireObsidian(config);
    if (_obsErr) return _obsErr;
    const { project, title, content } = args || {};
    const relPath = `${_projectDir(obs, project)}/Meetings/`
      + `${obsidianService.todayStr()} ${sanitizeObsidianName(title)}.md`;
    obsidianService.writeNote(obs.vault_path, relPath, {
      frontmatter: { title, type: 'meeting-notes', project: projectMocLink(obs, project) || project, tags: ['secretary', 'meeting'] },
      body: content,
    });
    linkFromDailyNote(obs, relPath.replace(/\.md$/, ''), `📅 会議ノート: ${title}`);
    const result = `会議ノート「${title}」をObsidianに保存しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'create_meeting_notes', result, project, title });
    return { result };
  },

  update_project_tasks: async (args, ctx) => {
    const { config } = ctx;
    const { obs, error: _obsErr } = _requireObsidian(config);
    if (_obsErr) return _obsErr;
    const { project, task, action } = args || {};
    const relPath = `${_projectDir(obs, project)}/_Secretary-Tasks.md`;
    if (action === 'complete') {
      const done = obsidianService.completeChecklistItem(obs.vault_path, relPath, task);
      const result = done ? `タスク「${task}」を完了にしました。` : `該当するタスク「${task}」が見つかりませんでした。`;
      return { result };
    }
    const existing = obsidianService.readNote(obs.vault_path, relPath);
    if (!existing) {
      obsidianService.writeNote(obs.vault_path, relPath, {
        frontmatter: { title: `${project} タスク一覧`, type: 'task-list', project: projectMocLink(obs, project) || project, tags: ['secretary', 'tasks'] },
        body: `## タスク\n- [ ] ${task}`,
      });
      linkFromDailyNote(obs, relPath.replace(/\.md$/, ''), `✅ タスク一覧: ${project}`);
    } else {
      obsidianService.appendChecklistItem(obs.vault_path, relPath, task);
    }
    const result = `プロジェクト「${project}」にタスク「${task}」を追加しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'update_project_tasks', result, project, task, action });
    return { result };
  },
};

module.exports = {
  TOOL_HANDLERS, TOOL_DECLARATIONS, _requireObsidian, OBSIDIAN_DISABLED_ERROR,
  // Inbox の一括処理（secretary-inbox.js）が、save_research_report と同じ保存のしかた・名前の付け方を
  // 使うために公開している（ツール呼び出しではなく関数として直接呼ぶ）
  sanitizeObsidianName, projectMocLink, linkFromDailyNote,
};
