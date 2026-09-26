/**
 * @file Obsidian の Vault への読み書き（ノートの作成・追記・検索・パスの解決）
 *
 * Secretary の会議準備・議事録・リサーチ・プロジェクト管理・デイリーノートなどは、独自の保存先を持たず、
 * リスナーが実際に使っている Obsidian の Vault（ローカルのフォルダー）へ直接読み書きする。Obsidian の
 * アプリを起動しておく必要は無い。利用元は secretary-tools-obsidian.js・日報・週報・資産レポートなど。
 *
 * LLM（Secretary との会話）から間接的に呼ばれるので、次の守りを置いている。
 * - ATTENTION: パスは必ず resolveSafePath を通し、Vault の外へ出るパスを拒否する。
 * - ATTENTION: writeNote は新規作成だけで、既存のファイルを上書きしない（リスナーが手で書いたノートを
 *   壊さないため）。追記は appendSection、Secretary 専用の欄の置き換えは setSectionContent を使う。
 * - Secretary が作ったノートには、フロントマターに source: ai-radio-secretary を必ず付け、本人の
 *   ノートと見分けられるようにする。
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
const matter = require('gray-matter');
const { getLogger } = require('../logger');

/** 検索やファイル名での探索で見ないフォルダー。 */
const EXCLUDED_DIRS = new Set(['.obsidian', '.claude', '.claudian', '.git', 'node_modules', '08_assets']);

/**
 * ローカル時刻の日付を YYYY-MM-DD にする。
 *
 * @param {Date} [d] 時刻（既定は今）
 * @returns {string} YYYY-MM-DD
 */
function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * デイリーノートの Vault 内のパスを組み立てる（例: 03_Daily Notes/2026-08/2026-08-23.md）。
 *
 * フォルダーの中が数か月分で散らからないよう、年月（YYYY-MM）のフォルダーに入れる。並べ替えできるよう、
 * ファイル名と同じ形式にし、「2026年8月」のような日本語の表記は使わない。
 * ATTENTION: デイリーノートのパスは、必ずこの関数で組み立てること（組み立て方が変わっても1か所で済む）。
 *
 * @param {string} dailyNotesFolder デイリーノートのフォルダー
 * @param {Date} [d] 日付（既定は今日）
 * @returns {string} Vault からの相対パス
 */
function dailyNoteRelPath(dailyNotesFolder, d = new Date()) {
  const dateStr = todayStr(d);
  const yearMonth = dateStr.slice(0, 7); // 'YYYY-MM'
  return `${dailyNotesFolder}/${yearMonth}/${dateStr}.md`;
}

/**
 * ウィークリーノートの Vault 内のパスを組み立てる（例: 04_Weekly Notes/2026/2026-08-17.md）。
 *
 * 週次は1年に52件ほどなので、月ではなく年（YYYY）のフォルダーに入れる。年は週の月曜日の年を使う
 * （ISO 週番号にすると「2026年最後の週なのにフォルダーは2027」のような直感に反する置き場所になりうる）。
 * ATTENTION: ウィークリーノートのパスは、必ずこの関数で組み立てること。
 *
 * @param {string} weeklyNotesFolder ウィークリーノートのフォルダー
 * @param {string} weekStart その週の月曜日（YYYY-MM-DD。secretary-weekly-note-formatting.js の datesForWeekEndingOn が返す）
 * @returns {string} Vault からの相対パス
 */
function weeklyNoteRelPath(weeklyNotesFolder, weekStart) {
  const year = weekStart.slice(0, 4); // 'YYYY'
  return `${weeklyNotesFolder}/${year}/${weekStart}.md`;
}

/**
 * Vault 内の相対パスを絶対パスにし、Vault の外へ出るパスなら例外を投げる。
 *
 * ATTENTION: LLM が組み立てた文字列を扱うので、.. によるトラバーサルを必ず拒否する。リスナーの実データが
 * 入った Vault を守る最後の防衛線。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス
 * @returns {string} 絶対パス
 * @throws {Error} Vault が設定されていない、または Vault の外のパスの場合
 */
function resolveSafePath(vaultPath, relativePath) {
  if (!vaultPath) throw new Error('Obsidian Vaultのパスが設定されていません');
  const root = path.resolve(vaultPath);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Vault外のパスへのアクセスは拒否されました: ${relativePath}`);
  }
  return resolved;
}

/**
 * ノートを1件読み、フロントマターと本文に分けて返す。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス
 * @returns {{frontmatter: Record<string, any>, body: string, raw: string}|null} ノート（無ければ null）
 */
function readNote(vaultPath, relativePath) {
  const full = resolveSafePath(vaultPath, relativePath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const raw = fs.readFileSync(full, 'utf-8');
  const parsed = matter(raw);
  return { frontmatter: parsed.data, body: parsed.content.trim(), raw };
}

/**
 * 新しいノートを作る。フロントマターには source と created を自動で足す。
 *
 * ATTENTION: すでにファイルがあれば例外にする（上書きの事故を防ぐため。更新は appendSection を使う）。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス（.md）
 * @param {{frontmatter?: Record<string, any>, body?: string}} [note] フロントマターと本文
 * @returns {string} 作ったファイルの絶対パス
 */
function writeNote(vaultPath, relativePath, { frontmatter = {}, body = '' } = {}) {
  if (!relativePath.endsWith('.md')) throw new Error('Obsidianノートは.md拡張子のみ作成できます');
  const full = resolveSafePath(vaultPath, relativePath);
  if (fs.existsSync(full)) {
    throw new Error(`既に存在するファイルのため作成できません（上書き保護）: ${relativePath}`);
  }
  const finalFrontmatter = {
    ...frontmatter,
    source: 'ai-radio-secretary',
    created: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const content = matter.stringify(body, finalFrontmatter);
  fs.writeFileSync(full, content, 'utf-8');
  getLogger().info(`[Obsidian] ノートを作成: ${relativePath}`);
  return full;
}

/**
 * ファイルがあればその中身を、無ければテンプレートから作った中身を返す（テンプレートも無ければ空）。
 *
 * テンプレートの {{date:YYYY-MM-DD}}・{{date:YYYY年}}・{{date:MM月}} は今日の日付で埋める。
 * templateVars（例: { weekStart, weekEnd }）を渡すと、{{date:weekStart}} のように任意の名前でも埋められる
 * （週次のノートで、今日とは違う日付を題名に入れるため）。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} full ノートの絶対パス
 * @param {string|null} templateRelativePath テンプレートの Vault からの相対パス
 * @param {Record<string, any>} [templateVars] テンプレートに埋める値
 * @returns {string} ノートの中身
 */
function _readExistingOrFromTemplate(vaultPath, full, templateRelativePath, templateVars = {}) {
  if (fs.existsSync(full)) return fs.readFileSync(full, 'utf-8');
  if (!templateRelativePath) return '';
  const templateFull = resolveSafePath(vaultPath, templateRelativePath);
  if (!fs.existsSync(templateFull)) return '';
  const now = new Date();
  let result = fs.readFileSync(templateFull, 'utf-8')
    .replace(/\{\{date:YYYY-MM-DD\}\}/g, todayStr(now))
    .replace(/\{\{date:YYYY年\}\}/g, `${now.getFullYear()}年`)
    .replace(/\{\{date:MM月\}\}/g, `${String(now.getMonth() + 1).padStart(2, '0')}月`);
  for (const [key, value] of Object.entries(templateVars)) {
    result = result.replace(new RegExp(`\\{\\{date:${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * 本文の中から「## 見出し」の欄の位置を探す。
 *
 * ATTENTION: 欄の終わりは「次の ##」だけで決めないこと。次の # の大見出し（ノートを大きく分ける
 * 区切り）と、末尾の --- 区切り（この後ろにタグ行が入る）でも終わらせる。## だけで見ていたころ、
 * 最後の欄へ書くとタグ行ごと消え、大見出しも次に書いたときに巻き込まれて消えていた。
 * ### 以下の小見出しは欄の中身なので、終わりとはみなさない。
 *
 * @param {*} existing ノートの中身（文字列）
 * @param {string} heading 見出し（## を除く）
 * @returns {{headingIdx: number, sectionBodyStart: number, sectionEnd: number}|null}
 *   見出しの行の先頭・欄の本文の先頭・欄の終わり。無ければ null
 */
function _locateSection(existing, heading) {
  const headingLine = `## ${heading}`;
  let headingIdx = -1;
  if (existing.startsWith(`${headingLine}\n`)) {
    headingIdx = 0;
  } else {
    const idx = existing.indexOf(`\n${headingLine}\n`);
    if (idx !== -1) headingIdx = idx + 1;
  }
  if (headingIdx === -1) return null;
  const sectionBodyStart = existing.indexOf('\n', headingIdx) + 1;
  const nextHeadingMatch = existing.slice(sectionBodyStart).match(/\n(?:#{1,2} |---(?:\n|$))/);
  const sectionEnd = nextHeadingMatch ? sectionBodyStart + nextHeadingMatch.index + 1 : existing.length;
  return { headingIdx, sectionBodyStart, sectionEnd };
}

/**
 * ノートに見出し付きの欄を追記する。
 *
 * 同じ見出しがすでにあれば、見出しを重ねず、その欄の終わりに追記する（1日に何度も記録しても
 * 見出しが並ばないように）。ファイルが無ければテンプレート（無ければ空）から作る。リスナーが
 * 手で書いた中身は変えない。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス（.md）
 * @param {string} heading 見出し（## を除く）
 * @param {string} body 追記する本文
 * @param {{templateRelativePath?: string|null, templateVars?: Record<string, any>}} [opts] テンプレートと埋める値
 * @returns {string} ノートの絶対パス
 */
function appendSection(vaultPath, relativePath, heading, body, { templateRelativePath = null, templateVars = {} } = {}) {
  if (!relativePath.endsWith('.md')) throw new Error('Obsidianノートは.md拡張子のみ操作できます');
  const full = resolveSafePath(vaultPath, relativePath);
  const existing = _readExistingOrFromTemplate(vaultPath, full, templateRelativePath, templateVars);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  const loc = _locateSection(existing, heading);
  let output;
  if (loc) {
    const insertText = `${body.trim()}\n\n`;
    output = existing.slice(0, loc.sectionEnd) + insertText + existing.slice(loc.sectionEnd);
  } else {
    const sectionText = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}\n## ${heading}\n${body.trim()}\n\n`;
    output = existing + sectionText;
  }
  fs.writeFileSync(full, output, 'utf-8');
  getLogger().info(`[Obsidian] ノートへ追記: ${relativePath}（見出し: ${heading}）`);
  return full;
}

/**
 * ノートの「## 見出し」の欄の中身を丸ごと置き換える（見出しが無ければ新しく足す）。
 * テンプレートの空欄（「- 」）を実際の内容に差し替えるのに使う。
 *
 * ATTENTION: 天気・ニュース・金融の情報のように、その日の最新の状態を入れる Secretary 専用の欄にだけ
 * 使うこと。リスナーが手で書く欄（今日のタスク・ログ・学び・気づきなど）には決して使わない。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス（.md）
 * @param {string} heading 見出し（## を除く）
 * @param {string} content 欄の新しい中身
 * @param {{templateRelativePath?: string|null, templateVars?: Record<string, any>}} [opts] テンプレートと埋める値
 * @returns {string} ノートの絶対パス
 */
function setSectionContent(vaultPath, relativePath, heading, content, { templateRelativePath = null, templateVars = {} } = {}) {
  if (!relativePath.endsWith('.md')) throw new Error('Obsidianノートは.md拡張子のみ操作できます');
  const full = resolveSafePath(vaultPath, relativePath);
  const existing = _readExistingOrFromTemplate(vaultPath, full, templateRelativePath, templateVars);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  const loc = _locateSection(existing, heading);
  let output;
  if (loc) {
    output = existing.slice(0, loc.sectionBodyStart) + `${content.trim()}\n\n` + existing.slice(loc.sectionEnd);
  } else {
    const sectionText = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}\n## ${heading}\n${content.trim()}\n\n`;
    output = existing + sectionText;
  }
  fs.writeFileSync(full, output, 'utf-8');
  getLogger().info(`[Obsidian] ノートのセクションを更新: ${relativePath}（見出し: ${heading}）`);
  return full;
}

/**
 * ノートの「## 見出し」の欄（既定は「タスク」）に、チェックリストの項目（- [ ] 項目）を1件足す。
 * プロジェクトのタスク管理（update_project_tasks）用。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス（.md）
 * @param {string} item 項目
 * @param {{heading?: string, templateRelativePath?: string|null}} [opts] 見出しとテンプレート
 * @returns {string} ノートの絶対パス
 */
function appendChecklistItem(vaultPath, relativePath, item, { heading = 'タスク', templateRelativePath = null } = {}) {
  return appendSection(vaultPath, relativePath, heading, `- [ ] ${item.trim()}`, { templateRelativePath });
}

/**
 * ノートの未完了のチェックリストの項目（- [ ] ...）のうち、itemQuery を含む最初の行を完了（- [x]）にする。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス
 * @param {string} itemQuery 項目の一部（大文字小文字は区別しない）
 * @returns {boolean} 完了にできたら true（見つからなければ false。呼び出し元がエラーの文にする）
 */
function completeChecklistItem(vaultPath, relativePath, itemQuery) {
  const full = resolveSafePath(vaultPath, relativePath);
  if (!fs.existsSync(full)) return false;
  const content = fs.readFileSync(full, 'utf-8');
  const q = (itemQuery || '').trim().toLowerCase();
  let matched = false;
  const updatedLines = content.split('\n').map((line) => {
    if (!matched && /^- \[ \] /.test(line) && line.toLowerCase().includes(q)) {
      matched = true;
      return line.replace('- [ ]', '- [x]');
    }
    return line;
  });
  if (!matched) return false;
  fs.writeFileSync(full, updatedLines.join('\n'), 'utf-8');
  getLogger().info(`[Obsidian] チェックリスト項目を完了にしました: ${relativePath} — ${itemQuery}`);
  return true;
}

/**
 * 画像などのファイルを Vault に保存する。
 *
 * ノートと違って上書きする。日をまたいで上書きしてしまわないよう、呼び出し元がファイル名に日付を
 * 含める（create_daily_report 参照）。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} relativePath Vault からの相対パス
 * @param {Buffer} buffer 中身
 * @returns {string} 保存したファイルの絶対パス
 */
function writeBinaryAsset(vaultPath, relativePath, buffer) {
  const full = resolveSafePath(vaultPath, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  getLogger().info(`[Obsidian] アセットを保存: ${relativePath} (${buffer.length} bytes)`);
  return full;
}

/** findLatestImageFile が画像として扱う拡張子。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif']);

/**
 * フォルダーの直下の画像のうち、更新日時が最も新しい1件を返す。
 * 毎週フォルダーに画像を足していく使い方なので、ファイル名の日付には頼らず更新日時で選ぶ。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} folderRelativePath フォルダーの Vault からの相対パス
 * @returns {{ relativePath: string, absolutePath: string, mtimeMs: number, buffer: Buffer, mimeType: string }|null}
 *   画像（フォルダーが無い・画像が無いときは null）
 */
function findLatestImageFile(vaultPath, folderRelativePath) {
  const full = resolveSafePath(vaultPath, folderRelativePath);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return null;
  const candidates = fs.readdirSync(full, { withFileTypes: true })
    .filter(e => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map(e => {
      const abs = path.join(full, e.name);
      return { name: e.name, abs, mtimeMs: fs.statSync(abs).mtimeMs };
    });
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((best, c) => (c.mtimeMs > best.mtimeMs ? c : best));
  const ext = path.extname(latest.name).toLowerCase();
  const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' }[ext] || 'application/octet-stream';
  return {
    relativePath: path.join(folderRelativePath, latest.name),
    absolutePath: latest.abs,
    mtimeMs: latest.mtimeMs,
    buffer: fs.readFileSync(latest.abs),
    mimeType,
  };
}

/**
 * フォルダーの直下のノート（.md）の一覧を返す。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} folderRelativePath フォルダーの Vault からの相対パス
 * @returns {string[]} ノートの Vault からの相対パス
 */
function listNotes(vaultPath, folderRelativePath) {
  const full = resolveSafePath(vaultPath, folderRelativePath);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return [];
  return fs.readdirSync(full, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(folderRelativePath, e.name));
}

/**
 * ノートを別の場所へ移す（Inbox の一括処理で、済んだ依頼のノートを _done・_failed へ移すのに使う）。
 * ATTENTION: 移動先にすでにファイルがあれば例外にする（writeNote と同じ上書きの防止）。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} fromRelativePath 移動元の Vault からの相対パス
 * @param {string} toRelativePath 移動先の Vault からの相対パス
 * @returns {void}
 */
function moveNote(vaultPath, fromRelativePath, toRelativePath) {
  const fromFull = resolveSafePath(vaultPath, fromRelativePath);
  const toFull = resolveSafePath(vaultPath, toRelativePath);
  if (!fs.existsSync(fromFull)) throw new Error(`移動元のファイルが存在しません: ${fromRelativePath}`);
  if (fs.existsSync(toFull)) throw new Error(`移動先に既にファイルが存在します（上書き保護）: ${toRelativePath}`);
  fs.mkdirSync(path.dirname(toFull), { recursive: true });
  fs.renameSync(fromFull, toFull);
  getLogger().info(`[Obsidian] ノートを移動: ${fromRelativePath} → ${toRelativePath}`);
}

/**
 * Vault 全体（EXCLUDED_DIRS を除く）のノートをキーワードで探す（大文字小文字を区別しない部分一致）。
 * 本文・ファイル名・フォルダーを含むパスのどれかに当たればよい。読み取りだけ。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} query キーワード
 * @param {{maxResults?: number, snippetLength?: number}} [opts] 最大件数（既定8）と抜粋の文字数（既定120）
 * @returns {Array<{path: string, title: string, snippet: string}>} 見つかったノート
 */
function searchVault(vaultPath, query, { maxResults = 8, snippetLength = 120 } = {}) {
  const root = path.resolve(vaultPath);
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];

  function walk(dir) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        let raw;
        try {
          raw = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        const lower = raw.toLowerCase();
        const idx = lower.indexOf(q);
        const relativePath = path.relative(root, full);
        // BUGFIX: フォルダーを含むパスでも当たるようにする。フォルダー込みで探されると、本文にもファイル名にも
        // 無いので0件になっていた。
        if (idx === -1 && !entry.name.toLowerCase().includes(q)
          && !relativePath.split(path.sep).join('/').toLowerCase().includes(q)) continue;
        const parsed = matter(raw);
        const snippetStart = Math.max(0, idx - snippetLength / 2);
        const snippet = idx === -1
          ? parsed.content.trim().slice(0, snippetLength)
          : raw.slice(snippetStart, snippetStart + snippetLength).replace(/\n/g, ' ');
        results.push({
          path: relativePath,
          title: parsed.data?.title || entry.name.replace(/\.md$/, ''),
          snippet: snippet.trim(),
        });
      }
    }
  }

  walk(root);
  return results;
}

/**
 * 会話で伝えられたノートの場所を、Vault の中に実在するノートの相対パスへ解決する。
 *
 * 人の記憶や LLM が組み立てるパスは、先頭に Vault の名前が付いていたり、年と月が別のフォルダーに
 * なっていたりと少しずれる。次の順で候補を試す。
 *   1. そのまま（.md が無ければ補う。Vault の中の絶対パスは相対に直す）
 *   2. 先頭の Vault の名前（空白や大文字小文字は問わない）を落とす
 *   3. YYYY/MM/ を YYYY-MM/ に読み替える
 *   4. 日付が含まれていれば、デイリーノート・ウィークリーノートの規則で場所を組み立てる
 *   5. ファイル名だけで、Vault の中に1件だけ見つかればそれ（複数あれば取り違えを避けて null）
 * Vault の外へ出るパスは resolveSafePath が例外にするので、どの候補にもならない。
 *
 * @param {string} vaultPath Vault のフォルダーの絶対パス
 * @param {string} requested 伝えられたパスや日付
 * @param {{dailyNotesFolder?: string|null, weeklyNotesFolder?: string|null}} [opts] デイリー・ウィークリーのフォルダー
 * @returns {string|null} Vault からの相対パス（見つからなければ null）
 */
function resolveNotePath(vaultPath, requested, { dailyNotesFolder = null, weeklyNotesFolder = null } = {}) {
  if (!vaultPath) return null;
  const root = path.resolve(vaultPath);
  let rel = String(requested || '').trim().replace(/\\/g, '/');
  if (!rel) return null;
  if (path.isAbsolute(rel)) {
    const abs = path.resolve(rel);
    if (abs.startsWith(root + path.sep)) rel = path.relative(root, abs).split(path.sep).join('/');
  }
  rel = rel.replace(/^\/+/, '');

  const isNoteFile = (candidate) => {
    try {
      const full = resolveSafePath(vaultPath, candidate);
      return fs.existsSync(full) && fs.statSync(full).isFile();
    } catch {
      return false; // Vault外
    }
  };
  const withMd = (p) => (/\.md$/i.test(p) ? p : `${p}.md`);
  const normName = (s) => s.toLowerCase().replace(/\s+/g, '');

  const candidates = [];
  const add = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
  add(withMd(rel));
  const parts = rel.split('/');
  if (parts.length > 1 && normName(parts[0]) === normName(path.basename(root))) {
    add(withMd(parts.slice(1).join('/')));
  }
  for (const c of [...candidates]) {
    add(c.replace(/(^|\/)(\d{4})\/(\d{1,2})\//, (_, pre, y, m) => `${pre}${y}-${m.padStart(2, '0')}/`));
  }
  const direct = candidates.find(isNoteFile);
  if (direct) return direct;

  // 「2026年9月14日」「2026/9/14」のような書き方も日付として拾う
  const dm = rel.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (dm) {
    const d = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
    const daily = dailyNotesFolder ? dailyNoteRelPath(dailyNotesFolder, new Date(`${d}T12:00:00`)) : null;
    const weekly = weeklyNotesFolder ? weeklyNoteRelPath(weeklyNotesFolder, d) : null;
    const order = /weekly|ウィークリー/i.test(rel) ? [weekly, daily] : [daily, weekly];
    const byDate = order.filter(Boolean).find(isNoteFile);
    if (byDate) return byDate;
  }

  const wanted = path.basename(withMd(rel)).toLowerCase();
  const found = [];
  const walk = (dir) => {
    if (found.length > 1) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length > 1) return;
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.length === 1 ? found[0] : null;
}

module.exports = {
  resolveSafePath, readNote, writeNote, appendSection, setSectionContent,
  appendChecklistItem, completeChecklistItem, listNotes, moveNote, searchVault, todayStr,
  dailyNoteRelPath, weeklyNoteRelPath, writeBinaryAsset, findLatestImageFile, resolveNotePath,
};
