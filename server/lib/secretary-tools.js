/**
 * @file 秘書の道具の振り分けと、中核となる道具の実装
 *
 * 秘書が会話中に呼ぶ道具の実処理をまとめた振り分け役。server/routes/secretary-live-routes.js
 * と裏方ヘルパーから呼ばれる。放送側のコーナー生成の経路には一切触れない、独立した道具立て。
 *
 * このファイルが持つのは、どの分野にも属さない中核部分だけ:
 *   - 雑多な道具（時刻・監視の要約・キャンバス表示・天気図）
 *   - 他のエージェントへの相談（consultAgent）
 *   - 渡されたファイル・スプレッドシート・Web ページの読み取り
 *   - 道具名とハンドラの対応表（TOOL_HANDLERS）と、その振り分け
 *
 * 分野ごとの実装は secretary-tools-services / -google / -spotify / -youtube / -obsidian /
 * -reports / -finance / -history / -presentation にあり、それぞれが公開する対応表を
 * ここで合流させている。呼んだ記録は secretary-store の daily-briefings に残る。
 *
 * ATTENTION: 言語モデルを呼ぶ経路を新しく足すときは、必ず agent-shared-mixin の
 * _collapseReasoningLeak を通すこと。内部の思考が出力へ混ざるのを防ぐ唯一の実装で、
 * 無防備な経路を足すとそこだけ漏れる。
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
'use strict';

const { generateText, imagePart } = require('./llm-client');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const secretaryStore = require('./secretary-store');
const secretaryMemory = require('./secretary-memory');
const agentDiary = require('./agent-diary');
const secretaryUploads = require('./secretary-uploads');
const { fetchWeatherChartBuffer, fetchSatelliteImageBuffer } = require('../routes/weather-satellite-routes');
const { googleService, weatherService, newsService, financeService, spotifyUserService,
  wrapDataForSpeechGuidance } = require('./secretary-tools-services');
// secretary-prompt.js経由だとsecretary-tools.js → secretary-prompt.js → secretary-loop.js →
// secretary-tools.jsという循環requireになるため、依存の無い独立ファイルから直接読み込む。
const { formatListenerProfile, getEffectiveLocationFromConfig } = require('./secretary-profile-format');
const googleToolsDomain = require('./secretary-tools-google');
const spotifyToolsDomain = require('./secretary-tools-spotify');
const youtubeToolsDomain = require('./secretary-tools-youtube');
const obsidianToolsDomain = require('./secretary-tools-obsidian');
const reportsToolsDomain = require('./secretary-tools-reports');
const financeToolsDomain = require('./secretary-tools-finance');
const historyToolsDomain = require('./secretary-tools-history');
const presentationToolsDomain = require('./secretary-tools-presentation');
const jobStore = require('./secretary-job-store');
const journalistWatch = require('./journalist-watch');
const { buildAgentKnowledgePack } = require('./agent-knowledge-pack');

// 思考の漏れを検知する処理は、ログに使う `this._channelId` しか見ない純粋な処理。
// このファイルはクラスを持たないため、最小限の入れ物を作って .call() で呼ぶ。
const _leakCtx = { _channelId: 'Secretary', _hasReasoningLeakSignal: sharedAgentMethods._hasReasoningLeakSignal };

// 本人の声への合成だけを打ち切る上限。
// ATTENTION: 音声合成にはテキストとは別の上限を必ず設けること。合成が長引いたとき、
// 呼び出し側の45秒の枠を巻き込んで、せっかく出来上がっているテキストの回答まで
// 「時間切れ」として捨てられてしまう。
// ATTENTION: この値を10秒まで下げないこと。合成1回あたりの所要時間が枠に収まらず、
// 声は出来ているのに捨てられ、秘書が代わりに読み直す形になる事故が起きた。
// 呼び出し側の45秒から本文の生成ぶんを引いてもなお余裕があるため、30秒を使い切ってよい。
const VOICE_SYNTHESIS_TIMEOUT_MS = 30000;

/**
 * 相談先の回答を、放送の読み上げと同じ「文に分ける → まとめて合成 → つなぐ」で音声にする。
 *
 * ATTENTION: 長い文をまとめて1回で合成しないこと。合成は長文1回より短文の方が明らかに速く
 * 安定して終わる。往復が長引くと、相手のモデルが応答を再開しないまま会話が黙り込む。
 * ATTENTION: 文の数だけ無制限に同時発火しないこと。長文で合成の側の制限に掛かる。
 *
 * @param {any} agentSystem Live のエージェントシステム（文分割と1文合成の道具を借りる）
 * @param {string} text 読ませる文章
 * @param {string} agentKey 話者のキー
 * @param {any} agentCfg 話者の設定（声・合成の種類）
 * @returns {Promise<any>} つなぎ合わせた PCM のバッファ
 */
async function synthesizeAgentVoicePcm(agentSystem, text, agentKey, agentCfg) {
  const useGemini = (agentCfg.tts_engine || 'gemini') === 'gemini';
  const sentences = useGemini
    ? agentSystem._splitTextToSentencesGemini(text)
    : agentSystem._splitTextToSentences(text);
  if (sentences.length === 0) return Buffer.alloc(0);

  // ATTENTION: 一度に流す数は、指示している長さなら必ず1回で終わる値にしておくこと。
  // 1つでも超えると2回に分かれ、所要時間がほぼ倍になる「崖」がある。実測では
  // 300字前後で4〜5区間、上限の450字で8区間なので、10なら常に1回で収まる。
  // ATTENTION: これ以上は増やさないこと。放送の読み上げが3に抑えているのと同じ理由で、
  // 合成の側の制限に掛かる。
  const CONCURRENCY = Math.min(sentences.length, 10);
  const results = new Array(sentences.length);
  for (let i = 0; i < sentences.length; i += CONCURRENCY) {
    const batch = sentences.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(s => agentSystem._collectPcmOrPause(s, agentKey)));
    batchResults.forEach((r, j) => { results[i + j] = r; });
  }
  const buffers = results.map(part => {
    if (Buffer.isBuffer(part)) return part;
    if (part && part.__silenceMs !== undefined) return agentSystem._makeSilencePcm(part.__silenceMs);
    if (part && part.__sfxPcm) return part.__sfxPcm;
    return Buffer.alloc(0);
  });
  return Buffer.concat(buffers);
}

/**
 * エージェント名から、括弧で書かれた役割の但し書きを落とす。
 *
 * 名前は管理画面で自由に変えられ、今はどれも「名前（役割）」の形になっている。呼びかけに
 * 括弧ごと渡すと、そのまま読み上げてしまうため、相手を呼ぶ場面ではこれを通す。
 * 括弧が無い名前はそのまま返るので、表記を変えても壊れない。
 *
 * @param {any} name エージェントの表示名
 * @returns {string} 但し書きを落とした名前
 */
function _stripRoleSuffix(name) {
  return String(name || '').replace(/[(（][^)）]*[)）]\s*$/, '').trim();
}

// 相談を取り次げるエージェント。ここに無いキーが渡されたらエラーを返す。
// 管理人・秘書・ディレクターは、自己参照か役割が合わないため対象外。
// ATTENTION: 放送に出る面々とそろえること。ここから外すと、モデルは「その人は居ない」と
// 判断して勝手に別の担当へ振り替え、存在しない肩書きを作って答えてしまう。
const CONSULTABLE_AGENT_KEYS = [
  'weather', 'traffic', 'news', 'finance', 'commentator', 'journalist',
  'world_report', 'legal_advisor', 'life_advisor', 'music_dj', 'caster', 'assistant',
  'comedian', 'doctor', 'marketer',
];

// 検索して調べる力を持たせる担当。放送側と同じ顔ぶれにそろえてある。
// ATTENTION: 放送で検索を持っている担当を、ここから落とさないこと。同じ人格が放送では
// 事実を語り、秘書経由では作り話をする、という食い違いが実際に起きた。
// 報道と気象は専用のデータも持つが、見出しの先や避難の呼びかけのように「数値には無いが
// 大事なこと」を確かめるため、検索も併せて持たせる。数値の根拠は実データ側で固定している。
const SEARCH_GROUNDED_AGENT_KEYS = [
  'traffic', 'commentator', 'journalist', 'music_dj',
  'life_advisor', 'world_report', 'legal_advisor',
  'comedian', 'doctor', 'marketer',
  'news', 'weather',
];

/**
 * 検索を持つ担当ごとに「何を調べるべきか」の手がかりを返す。
 * ATTENTION: 調べ先が漠然としていると、検索を省いて記憶で答えてしまう。必ず添えること。
 *
 * @param {string} agentKey エージェントのキー
 * @returns {string} 添える一文。該当が無ければ空文字
 */
function _searchHintFor(agentKey) {
  return {
    traffic:       '（最新の運行状況・渋滞情報を調べてください）',
    commentator:   '（今日のニュースや経済指標の最新の事実を調べ、その上で解説してください）',
    journalist:    '（いま実際に報じられている出来事を調べ、その上で切り込んでください）',
    music_dj:      '（曲名・アーティスト・発売年など、事実に関わる部分を確かめてください。'
                   + '確かめられない「新曲」を紹介してはいけません）',
    life_advisor:  '（季節・時期に関わる話題や、具体的な商品・施設名を挙げる場合は確かめてください）',
    world_report:  '（現地で実際に報じられている最新の出来事を調べてください）',
    legal_advisor: '（法改正や制度は変わります。現時点の内容を必ず確かめてください）',
    comedian:      '（世間で実際に話題になっている出来事を調べ、その上で庶民の感覚で噛み砕いてください）',
    doctor:        '（医学的な知見や制度は更新されます。現時点で確かめられる内容かを必ず確認してください）',
    marketer:      '（流行や企業の動きは移り変わります。いま実際に起きていることを調べた上で読み解いてください）',
  }[agentKey] || '';
}

/**
 * 図の記法が地の文のまま書かれていたら、その場でコードのかたまりとして囲み直す。
 *
 * BUGFIX: モデルが囲みを忘れると、画面側はただの段落として扱い、図を描く部品が一度も
 * 呼ばれないため生の記法がそのまま表示される。指示だけでは防ぎきれないので、
 * コード側で必ず直す。
 *
 * 図の各行は字下げされる決まりなので、字下げの有無をかたまりの切れ目の目印に使う。
 *
 * @param {string} content キャンバスへ出す本文
 * @returns {string} 囲みを補った本文
 */
function _ensureMermaidFenced(content) {
  if (!content || content.includes('```mermaid')) return content;
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t === 'xychart-beta' || t.startsWith('pie showData');
  });
  if (startIdx === -1) return content;
  let blockStart = startIdx;
  if (blockStart > 0 && lines[blockStart - 1].trim().startsWith('%%{')) blockStart--;
  let blockEnd = startIdx + 1;
  while (blockEnd < lines.length && /^\s+\S/.test(lines[blockEnd])) blockEnd++;
  const before = lines.slice(0, blockStart).join('\n').trim();
  const block = lines.slice(blockStart, blockEnd).join('\n');
  const after = lines.slice(blockEnd).join('\n').trim();
  getLogger().warn('[Secretary] show_on_canvas: フェンス無しのMermaid構文を検知し自動補正しました');
  return [before, `\`\`\`mermaid\n${block}\n\`\`\``, after].filter(Boolean).join('\n\n');
}

// ATTENTION: 図の書式の決まりは、道具の説明文でモデルに指示せずコード側で直すこと。
// 道具の宣言は毎回そのまま費用になるうえ、これらは守られたかどうかを機械的に判定できる。
// 指示に頼ると出力の揺れで失敗するが、コードで直せば確実に直る。
const XYCHART_THEME_INIT =
  '%%{init: {"themeVariables": {"xyChart": {"plotColorPalette": "#ffb385, #ff6b35"}}}}%%';

/**
 * 図のかたまり1つ分を、確実に描ける形へ整える。
 *
 * ATTENTION: 画面側と重なる処理（改行を表す2文字・曲がった引用符の直し）も、ここで先に
 * 済ませること。後続のラベルの引用符付けと色の指定が、整える前の文字列では正しく判定できない。
 *
 * @param {string} code 図のかたまりの中身
 * @returns {string} 整えた中身
 */
function _normalizeMermaidBlock(code) {
  let out = code
    .replace(/\\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const isXyChart = /^\s*xychart-beta\s*$/m.test(out);
  const isPie = /^\s*pie\b/m.test(out);

  if (isXyChart) {
    // 横軸のラベルを引用符で囲む。日本語や記号を含むラベルは、裸のままだと構文の誤りになる。
    // 数値の範囲で書かれた形は角括弧が無いので、この置き換えには掛からない。
    out = out.replace(/^([ \t]*x-axis[ \t]+)\[([^\]]*)\]/gm, (_m, head, body) => {
      const items = body.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => (/^".*"$/.test(s) ? s : `"${s.replace(/^['"]+|['"]+$/g, '')}"`))
        // BUGFIX: 中身の無いラベルは受け付けられず、図全体が構文の誤りになる。点が多い
        // グラフでは、モデルが4点に1つだけ日付を書いて残りを空で埋めることがある。
        // ATTENTION: 空のラベルを落としてはいけない。ラベルの数と点の数が合わなくなり、
        // 目盛りと値の対応がずれる。空白1つに置き換えて、位置を保ったまま通すこと。
        .map((s) => (s === '""' ? '" "' : s));
      return `${head}[${items.join(', ')}]`;
    });
    // 既定の色は薄くて見えにくいため、指定が無ければ必ず先頭へ入れる
    if (!out.includes('%%{')) out = `${XYCHART_THEME_INIT}\n${out}`;
  }

  if (isPie) {
    // ラベルの引用符が抜けている行を補う。題名や設定の行は数値を持たないので対象外になる
    out = out.replace(/^([ \t]*)([^\s"%][^:\n]*?)[ \t]*:[ \t]*(-?[\d.]+)[ \t]*$/gm,
      (_m, indent, label, num) => `${indent}"${label.trim()}" : ${num}`);
  }

  return out;
}

/**
 * キャンバスの本文に含まれる図のかたまりを、すべて整える。
 *
 * @param {string} content キャンバスへ出す本文
 * @returns {string} 整えた本文
 */
function _normalizeMermaidInContent(content) {
  if (!content || !content.includes('```mermaid')) return content;
  return content.replace(/```mermaid\n([\s\S]*?)```/g,
    (_m, body) => `\`\`\`mermaid\n${_normalizeMermaidBlock(body.replace(/\n$/, ''))}\n\`\`\``);
}

/**
 * 受け取ったファイル（文書・画像）を読み取って答える。
 * 「これに対して〜してほしい」という自由な依頼に応えるため、読み方は instruction に委ねる。
 *
 * @param {any} opts fileId・instruction・creds・activitySessionId
 * @returns {Promise<any>} 読み取り結果とファイル名。失敗時は error
 */
async function analyzeUploadedFile({ fileId, instruction, creds, activitySessionId }) {
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };

  const upload = secretaryUploads.getUpload(fileId);
  if (!upload) return { error: 'ファイルが見つかりませんでした。もう一度アップロードしてください。' };


  const _t0 = Date.now();
  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'analysis',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、リスナーが渡した文書・画像を分析するアシスタントです。'
        + '事実に基づいて正確に読み取り、依頼された内容に的確に答えてください。文書に無い情報を'
        + '推測で補って答えることは絶対にしないでください（読み取れない・不明な場合は正直にその旨を'
        + '伝えてください）。回答はその場で音声合成されて読み上げられるため、要点を絞って簡潔に'
        + 'まとめてください（詳細な全文書き起こしではなく、依頼に沿った分析結果を述べること）。'
        + '【重要】出力は読み上げられる自然な話し言葉の文章のみにしてください。番号付きリスト・'
        + '箇条書き記号（-や・）・「**」による強調・見出し（#）などのMarkdown書式は、そのまま'
        + '音声で読み上げられて不自然になるため絶対に使わないこと。複数の要点を挙げる場合も'
        + '「1点目は〜、2点目は〜」のように地の文で自然に話してください。',
      contents: [{
        role: 'user',
        parts: [
          imagePart(upload.buffer.toString('base64'), upload.mimeType),
          { text: instruction },
        ],
      }],
      agentKey: 'secretary_file_analysis',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] analyze_uploaded_file失敗: ${e.message}`);
    return { error: 'ファイルの分析に失敗しました。時間をおいて再度お試しください。' };
  }
  // ATTENTION: 他の経路と同じく、必ず思考の漏れの検知を通すこと
  const text = sharedAgentMethods._collapseReasoningLeak.call(_leakCtx, rawText, {});
  if (!text) return { error: 'ファイルの分析結果を安全に取得できませんでした。' };

  getLogger().info(`[Secretary] analyze_uploaded_file(${fileId}): 分析完了（${Date.now() - _t0}ms、${text.length}文字）`);
  secretaryStore.appendEntry('daily-briefings', { tool: 'analyze_uploaded_file', fileName: upload.originalName, instruction, result: text });
  return { result: text, fileName: upload.originalName };
}

// ATTENTION: 表は必ず行・列とも上限で切ること。画像や文書と違って数千行になり得る。
const SHEET_MAX_ROWS = 300;
const SHEET_MAX_COLS = 30;

/**
 * 表の値を、言語モデルに読ませやすいタブ区切りの文字列にする。上限を超えた分は省いた旨を書き添える。
 *
 * @param {any[]} rows 行ごとの値の配列
 * @returns {string} タブ区切りの文字列
 */
function _formatSheetRowsForPrompt(rows) {
  const truncatedRows = rows.length > SHEET_MAX_ROWS;
  const useRows = rows.slice(0, SHEET_MAX_ROWS);
  const lines = useRows.map((row) => {
    const truncatedCols = row.length > SHEET_MAX_COLS;
    const useCols = row.slice(0, SHEET_MAX_COLS);
    return useCols.join('\t') + (truncatedCols ? '\t…(以降の列省略)' : '');
  });
  if (truncatedRows) lines.push(`…(${rows.length - SHEET_MAX_ROWS}行省略)`);
  return lines.join('\n');
}

/**
 * 表の URL から、表の ID と（あれば）シートの番号を取り出す。
 *
 * ATTENTION: ホスト名とパスを表の置き場に限ること。文書やスライドも同じ形のパスを持つため、
 * 緩めると取り違える。
 *
 * @param {any} url 貼り付けられた URL
 * @returns {any} 表の ID とシートの番号。{ spreadsheetId, gid }
 */
function parseGoogleSheetUrl(url) {
  let parsed;
  try {
    parsed = new URL(url || '');
  } catch {
    return { spreadsheetId: null, gid: null };
  }
  if (parsed.hostname !== 'docs.google.com' || !parsed.pathname.startsWith('/spreadsheets/')) {
    return { spreadsheetId: null, gid: null };
  }
  const idMatch = /\/d\/([a-zA-Z0-9-_]+)/.exec(parsed.pathname);
  const gidMatch = /[?&#]gid=(\d+)/.exec(url);
  return {
    spreadsheetId: idMatch ? idMatch[1] : null,
    gid: gidMatch ? gidMatch[1] : null,
  };
}

/**
 * 貼り付けられた表の中身を読み取って答える。
 *
 * ファイルと違ってクラウド上にあるため、読み取り専用の権限で値を取ってくる。返す形は
 * ファイルの読み取りと同じく、そのまま読み上げられる文章にする。
 *
 * ATTENTION: 入り口では URL の中身を判断せず、生の URL を受け取ってここで解くこと。
 *
 * @param {any} opts url・instruction・creds・activitySessionId
 * @returns {Promise<any>} 読み取り結果と表の題名。失敗時は error
 */
async function analyzeGoogleSheet({ url, instruction, creds, activitySessionId }) {
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };
  const { spreadsheetId, gid } = parseGoogleSheetUrl(url);
  if (!spreadsheetId) return { error: 'スプレッドシートのURLが認識できませんでした。もう一度貼り付け直してください。' };

  let sheet;
  try {
    sheet = await googleService.fetchSpreadsheetValues(creds, { spreadsheetId, gid });
  } catch (e) {
    getLogger().warn(`[Secretary] analyze_google_sheet取得失敗: ${e.message}`);
    return { error: e.message.includes('アクセスできません')
      ? e.message
      : 'スプレッドシートの取得に失敗しました。Google連携が有効か管理画面でご確認ください。' };
  }
  if (sheet.rows.length === 0) {
    return { error: `「${sheet.sheetTitle}」シートにデータが見つかりませんでした。` };
  }

  const sheetText = _formatSheetRowsForPrompt(sheet.rows);

  const _t0 = Date.now();
  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'analysis',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、リスナーが共有したGoogleスプレッドシートのデータを'
        + '分析するアシスタントです。渡されるのはタブ区切りのテーブルデータ（1行目が見出しの'
        + '可能性が高い）です。事実に基づいて正確に読み取り、依頼された内容に的確に答えてください。'
        + 'データに無い情報を推測で補って答えることは絶対にしないでください。回答はその場で'
        + '音声合成されて読み上げられるため、要点を絞って簡潔にまとめてください。'
        + '【重要】出力は読み上げられる自然な話し言葉の文章のみにしてください。番号付きリスト・'
        + '箇条書き記号（-や・）・「**」による強調・見出し（#）・表形式などのMarkdown書式は、'
        + 'そのまま音声で読み上げられて不自然になるため絶対に使わないこと。複数の要点を挙げる'
        + '場合も「1点目は〜、2点目は〜」のように地の文で自然に話してください。',
      contents: [{
        role: 'user',
        parts: [{ text: `【スプレッドシート「${sheet.spreadsheetTitle}」/ シート「${sheet.sheetTitle}」のデータ】\n${sheetText}\n\n【依頼】\n${instruction}` }],
      }],
      agentKey: 'secretary_sheet_analysis',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] analyze_google_sheet分析失敗: ${e.message}`);
    return { error: 'スプレッドシートの分析に失敗しました。時間をおいて再度お試しください。' };
  }
  const text = sharedAgentMethods._collapseReasoningLeak.call(_leakCtx, rawText, {});
  if (!text) return { error: 'スプレッドシートの分析結果を安全に取得できませんでした。' };

  getLogger().info(`[Secretary] analyze_google_sheet(${spreadsheetId}): 分析完了（${Date.now() - _t0}ms、${text.length}文字）`);
  secretaryStore.appendEntry('daily-briefings', { tool: 'analyze_google_sheet', spreadsheetTitle: sheet.spreadsheetTitle, sheetTitle: sheet.sheetTitle, instruction, result: text });
  return { result: text, spreadsheetTitle: sheet.spreadsheetTitle };
}

// Web ページから取り出す本文の上限（渡す量を抑えるため）
const WEB_PAGE_TEXT_MAX_LENGTH = 20000;

/**
 * HTML の記号表記を元に戻し、タグを外して1つの文章にする。
 *
 * @param {string} html HTML の断片
 * @returns {string} タグを外した文章
 */
function _htmlToPlainText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Web ページの HTML から、題名と本文らしき文章を取り出す。
 * ページの構造は決め打ちできないため、script・style・コメントを除いてタグを剥がすだけに留める
 * （本文と周りの案内の区別は、読む側の力に委ねる）。
 *
 * @param {string} html ページの HTML
 * @returns {any} 題名と本文。{ title, text }
 */
function _extractWebPageText(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? _htmlToPlainText(titleMatch[1]) : '';
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  let text = _htmlToPlainText(stripped);
  if (text.length > WEB_PAGE_TEXT_MAX_LENGTH) text = text.slice(0, WEB_PAGE_TEXT_MAX_LENGTH) + '…';
  return { title, text };
}

/**
 * 貼り付けられた URL が普通の Web ページだった場合に、その中身を読み取って答える。
 * 表の読み取りと対になる作りで、こちらは認証なしの取得だけで完結する。
 *
 * @param {any} opts url・instruction・creds・activitySessionId
 * @returns {Promise<any>} 読み取り結果とページの題名。失敗時は error
 */
async function analyzeWebPage({ url, instruction, creds, activitySessionId }) {
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };
  if (!url) return { error: 'URLが指定されていません。' };

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIRadio/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    getLogger().warn(`[Secretary] analyze_web_page取得失敗: ${e.message}`);
    return { error: 'ページの取得に失敗しました。URLをご確認ください。' };
  }
  if (!res.ok) return { error: `ページの取得に失敗しました（HTTP ${res.status}）。` };
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('html') && !contentType.includes('text')) {
    return { error: 'このURLはWebページとして読み取れない形式でした（画像・PDF等の可能性があります）。' };
  }
  const html = await res.text();
  const { title, text } = _extractWebPageText(html);
  if (!text) return { error: 'ページから本文を取得できませんでした。' };


  const _t0 = Date.now();
  let rawText;
  try {
    ({ text: rawText } = await generateText({
      tier: 'analysis',
      apiKey,
      systemInstruction: 'あなたはAI秘書として、リスナーが共有したWebページの内容を分析する'
        + 'アシスタントです。渡されるのはページのタイトルと本文テキスト（ナビゲーション等の'
        + '無関係な文字列が混ざっている場合があります）です。事実に基づいて正確に読み取り、'
        + '依頼された内容に的確に答えてください。ページに無い情報を推測で補って答えることは'
        + '絶対にしないでください。回答はその場で音声合成されて読み上げられるため、要点を'
        + '絞って簡潔にまとめてください。'
        + '【重要】出力は読み上げられる自然な話し言葉の文章のみにしてください。番号付きリスト・'
        + '箇条書き記号（-や・）・「**」による強調・見出し（#）・表形式などのMarkdown書式は、'
        + 'そのまま音声で読み上げられて不自然になるため絶対に使わないこと。複数の要点を挙げる'
        + '場合も「1点目は〜、2点目は〜」のように地の文で自然に話してください。',
      contents: [{
        role: 'user',
        parts: [{ text: `【Webページ「${title || url}」の内容】\n${text}\n\n【依頼】\n${instruction}` }],
      }],
      agentKey: 'secretary_webpage_analysis',
      activitySessionId,
    }));
  } catch (e) {
    getLogger().warn(`[Secretary] analyze_web_page分析失敗: ${e.message}`);
    return { error: 'ページの分析に失敗しました。時間をおいて再度お試しください。' };
  }
  const outText = sharedAgentMethods._collapseReasoningLeak.call(_leakCtx, rawText, {});
  if (!outText) return { error: 'ページの分析結果を安全に取得できませんでした。' };

  getLogger().info(`[Secretary] analyze_web_page(${url}): 分析完了（${Date.now() - _t0}ms、${outText.length}文字）`);
  secretaryStore.appendEntry('daily-briefings', { tool: 'analyze_web_page', url, pageTitle: title, instruction, result: outText });
  return { result: outText, pageTitle: title };
}

// いまどこに居るかの判定（臨時の滞在先を含む）を、設定だけから行う。
// ATTENTION: 天気と交通で滞在先を必ず見ること。ここを住所そのままにしていたため、
// 滞在中でも自宅の天気・道路を答えていた時期がある。放送側は元から正しく見ている。
const _getEffectiveLocationFromConfig = getEffectiveLocationFromConfig;

/**
 * 秘書を通した相談のやり取りを、担当したエージェント本人の日記に残す。
 *
 * 相談は最も中身の濃いやり取りで、資産・契約・体調といった実際の材料を持ち込んで名指しで
 * 専門家に問いかける場面になる。ここを残さないと、次に同じことを聞いてもゼロから始まる。
 *
 * 放送側の書き込みはエージェントシステムのメソッドで、LINE 経由では使えない。書き込み自体は
 * 単発の言語モデル呼び出しとファイルへの追記だけなので、経路に依らない下請けをここに置き、
 * 音声でも LINE でも同じように残るようにする。
 *
 * ATTENTION: 材料には「何を聞かれたか」「何を材料にしたか」「どう答えたか」の3つを入れること。
 * 回答だけでは、次に読み返したときに何の話だったのかが分からない。
 * ATTENTION: 呼び出し側は完了を待たないこと。相談の応答時間に日記の数秒を上乗せしてはいけない。
 *
 * @param {any} opts agentKey・agentName・task・contextText・answerText・apiKey・activitySessionId
 * @returns {Promise<void>}
 */
async function writeConsultDiary({ agentKey, agentName, task, contextText, answerText, apiKey, activitySessionId }) {
  if (!answerText || !apiKey) return;
  try {
    const material = [
      `【受けたご相談】${String(task || '').slice(0, 300)}`,
      contextText ? `【渡された材料（抜粋）】${String(contextText).replace(/[\n\r]+/g, ' ').slice(0, 700)}` : '',
      `【自分が答えた内容】${String(answerText).replace(/[\n\r]+/g, ' ')}`,
    ].filter(Boolean).join('\n');
    const excerpt = material.slice(0, agentDiary.REFLECTION_EXCERPT_LIMITS.consult || 1800);
    const prompt = agentDiary.buildReflectionPrompt({ agentName, excerpt, scope: 'consult' });

    // 放送側の日記と同じ軽い段。裏で数秒走るだけなので、考え込ませる必要は無い
    const { text: _diaryRaw } = await generateText({
      tier: 'light',
      apiKey,
      prompt,
      thinkingBudget: 0,
      includeThoughts: false,
      agentKey,
      activitySessionId,
      logMeta: { kind: 'consult_diary' },
    });
    const text = _diaryRaw.trim();
    if (!text) return;

    // ATTENTION: 放送側の日記と同じ器へ溜めること。別々にすると、学びが分断される。
    // 相談できる相手はすべて Live のエージェントなので、チャンネルは live で固定してよい。
    agentDiary.appendDiaryEntry({
      channel: 'live', agentKey, agentName, corner: 'consult', text,
    });
    getLogger().info(`[Diary] ${agentName} が相談の振り返りを記録しました（${text.length}文字）`);
  } catch (e) {
    getLogger().debug(`[Diary] ${agentKey} の相談日記の生成に失敗（無視して続行）: ${e.message}`);
  }
}

/**
 * 指名されたエージェントに相談を取り次ぎ、本人の言葉と声で答えを返す。
 *
 * 人格の設定に加えて、その担当が放送で持っているのと同じ材料（実データ・検索・リスナー像・
 * 自分の日記・手持ちの知識）を渡す。材料が渡された場合は、報告ではなく評価の型に切り替える。
 *
 * ATTENTION: 同じ人格が場面によって別人にならないよう、放送側と同じ材料を渡すこと。人格の
 * 設定だけで呼んでいた頃は、手元に何も無いまま事実を作って答えていた（存在しない政策金利・
 * 実在しない出来事・架空の気温など、実際に確認された）。
 *
 * @param {any} opts agentKey・task・contextText・config・creds・activitySessionId・getAgentSystem
 * @returns {Promise<any>} 相手の名前・回答・音声。失敗時は error
 */
async function consultAgent({ agentKey, task, contextText, config, creds, activitySessionId, getAgentSystem }) {
  if (!CONSULTABLE_AGENT_KEYS.includes(agentKey)) {
    return { error: `agent_key "${agentKey}" には委任できません。利用可能: ${CONSULTABLE_AGENT_KEYS.join(', ')}` };
  }
  const agentCfg = config.agents?.[agentKey];
  if (!agentCfg?.prompt) {
    return { error: `agent_key "${agentKey}" の設定が見つかりません` };
  }
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return { error: 'Gemini APIキーが設定されていません' };

  // 人格の設定は放送向けに書かれているため、そのままでは一対一の相談でも放送の口調になり、
  // 1000文字を超える長さにもなる。以下で場面と長さを上書きする。
  // ATTENTION: 禁止事項だけを並べないこと。誰に向かって話すのか、依頼を受けてどう応じるのか
  // を書かないと、要点を平坦に述べて終わる返事になる。
  // ATTENTION: 名前は必ず設定から取ること（直書き禁止）。括弧の但し書きは口に出すと不自然。
  const _listenerName = _stripRoleSuffix(config.show?.user_profile?.short_name
    || config.show?.user_profile?.name) || 'リスナー';
  const _secretaryName = _stripRoleSuffix(config.agents?.secretary?.name) || '秘書';
  const _selfName = _stripRoleSuffix(agentCfg.name) || '';

  // ATTENTION: 材料を渡されたときは、報告の型（手元から2〜3件選んで掘り下げる）をそのまま
  // 使ってはいけない。情報を届ける場面には合うが、評価を求められた場面に当てると
  // 「全体を評価せず個別を抜き出す」という誤った振る舞いを誘発する。型ごと評価へ切り替える。
  const analysisNote = contextText
    ? '\n\n【今回は「渡された材料を評価する」依頼です — ここが最も重要】\n'
      + 'これは情報をお届けする場面ではなく、**あなたの専門性そのものを求められている場面**です。'
      + '次を必ず守ってください。\n'
      + '① **まず全体を見てください。** 個別の項目を2〜3件抜き出して論評して終わる、という'
      + '答え方はここでは不合格です。材料全体としてどういう性格・傾向を持っているのか'
      + '（偏り・重複・集中・バランス・抜けているもの）を最初に述べてください。\n'
      + `② **${_listenerName}さんが自分では気づけない点を、必ず最低1つ指摘してください。** `
      + 'それがあなたに相談した理由です。渡された数字を読み上げ直すだけなら、専門家は要りません。'
      + '「言われてみればそうだ」と思わせる指摘を1つ入れてください。\n'
      + '③ **良い点だけで終わらせないでください。** 懸念・リスク・見落としがあれば率直に'
      + '伝えてください。お世辞や励ましだけの評価は、かえって判断を誤らせます。'
      + 'ただし断定的な指示ではなく、専門家としての見立てとして伝え、最終的な判断は'
      + `${_listenerName}さんご自身のものである、という姿勢を保ってください。\n`
      + '④ **最後は「ではどうするか」に触れてください。** 「様子を見ましょう」「静観が最善です」'
      + 'のような、何も言っていないのと同じ結論で終わらせないでください。\n'
      + '⑤ 相場やニュースの背景説明を、それ単体で長々と述べないでください。求められているのは'
      + '**この材料についての評価**です。背景に触れるときは必ず材料と結びつけてください。\n'
      // ATTENTION: 以下の3項目を削らないこと。これが無いと、誰でも知っている教科書的な
      // 助言で終わったり、手元の数字を一つも使わないまま人格の色付けで全体が埋まったりする。
      + '⑥ **相手は素人ではありません。** リスナーは長年ご自身で投資をされている方です'
      + '（プロフィール参照）。「分散が大事」「長期保有を心がけて」「時間分散で少しずつ」'
      + '「焦らず様子を見て」のような、**その道の人なら誰でも知っていることを"助言"として'
      + '述べてはいけません。** 言われた側は「そんなことは分かっている」としか思いません。'
      + '専門家に聞く価値があるのは、本人が持っていない視点・情報・判断材料です。\n'
      + '⑦ **いま起きていることと結びつけてください。** 材料だけを見て閉じた評価をせず、'
      + '手元にある現在の数字や出来事（金利・為替・米国市場・各指数の動き・世界情勢など、'
      + 'あなたが持っている材料）と関連づけて、**この局面でこの材料に何が効いてくるのか**を'
      + '述べてください。数字を挙げるときは手元の実際の値を使い、記憶や推測で埋めないこと。\n'
      // ATTENTION: 参照記号を書かせないこと。回答は音声になるため、記号や数字がそのまま
      // 読み上げられて聞くに堪えないものになる。
      + '⑧ **渡された材料の行番号や「[3, 11]」のような参照記号を、回答の中に書かないで'
      + 'ください。** この回答は音声で読み上げられるため、記号や数字がそのまま声になって'
      + 'しまいます。どれを指しているかは、番号ではなく名前（銘柄名・項目名など）で'
      + '呼んでください。\n'
      + '⑨ **あなたの人格・口調は保ってよいのですが、それで中身を置き換えてはいけません。**'
      + '比喩・詩的な表現・ユーモアは味付けであって、分析の代わりではありません。'
      + '1〜2箇所に留め、そのぶん中身を削ることのないようにしてください。'
      + '雰囲気だけの美しい言葉で全体が埋まった回答は、何も答えていないのと同じです。'
    : '';

  const contextNote = '\n\n【この会話の場面】\n'
    + `現在は番組放送中ではありません。秘書の${_secretaryName}さんから電話を取り次がれ、`
    + `いま${_listenerName}さんご本人と直接お話ししているところです。`
    + `${_listenerName}さんに向かって、一対一で話しかけてください。`
    + 'リスナー全体への呼びかけや、他の出演者・キャスターへの話の受け渡しは不要です。\n'
    // ATTENTION: 人格の設定には触らず、この場面では放送の体裁を外すよう指示すること。
    // 番号付けや間を作る記号といった放送の作法が一対一の相談に持ち込まれると、記号が
    // そのまま残って崩れる。特定の担当に限らず効く書き方にしてある。
    + 'また、あなたの設定に放送用の体裁（「〇つ目のニュースです」のような番号付け、'
    + '「…」「。さて、」といった間を作る記号、「以上、〇本をお伝えしました」という'
    + '締めの定型など）が書かれていても、**この場面では使わないでください。**'
    + 'それらは放送で複数の項目を続けて読むための作法であり、一対一の会話では'
    + '不自然になります。ふつうの話し言葉でつなげてください。\n\n'
    + '【応対の流れ】\n'
    + 'いきなり本題の要点だけを述べて終わる、という応対はしないでください。'
    + '短い会話であっても、次の順序で「人が応対している」と感じられるようにしてください。\n'
    + `① まず一言受け答えをする。「${_listenerName}さん、お疲れさまです」`
    + `${_selfName ? `「${_selfName}です」` : ''}「ご依頼ありがとうございます」`
    + '「はい、承りました」など、場面に合った自然な言葉で構いません。\n'
    + (contextText
      ? '② 渡された材料に目を通した、という体で本題に入る。'
        + '「拝見しました」「早速見せていただきました」など。\n'
      : '② 自分が動いて調べてきた、という体で本題に入る。'
        + '「早速お調べしました」「確認してまいりました」「今ちょうど見ていたところです」など。\n')
    + '③ 本題を伝える（下の【中身の濃さ】を必ず守ってください）。\n'
    + '④ 最後に一言添えて締める。「また何かあればいつでもお声がけください」'
    + '「お気をつけて」など、次につながる言葉で終えてください。\n\n'
    + '【口調】\n'
    + 'あなたの人格・話し方の設定はそのまま保ってください。そのうえで、原稿を読み上げる'
    + '口調ではなく、目の前の相手に語りかける会話の口調にしてください。\n\n'
    + '【中身の濃さ】\n'
    + '短くまとめようとするあまり、要点を並べただけの素っ気ない返事にしないでください。\n'
    + (contextText
      // 材料を渡された場面で件数を絞らせると、全体を評価せず個別を抜き出す振る舞いになる
      ? '・渡された材料は**全体を評価**してください。数字をなぞるだけで終わらせず、'
        + 'それが何を意味するのかまで踏み込むこと。\n'
      : '・本題は2〜3件まで。ただし**1件目は必ず具体的に掘り下げてください** — '
        + 'いつ・どこで・どれくらい（数字・固有名詞）を落とさず、そのニュースなり数値なりが'
        + '「何を意味するのか」まで踏み込むこと。見出しをなぞるだけで終わらせない。\n')
    + `・**あなた自身の見立てを必ず一言入れてください。** 「これは${_listenerName}さんにとって`
    + '〜という意味があります」「私はこう見ています」といった、専門家としての受け止めです。'
    + '事実の列挙だけで終わる回答は不合格です。\n'
    + (contextText ? ''
      : '・2件目以降は一言ずつで構いません。手元に項目が何件あっても全部を読み上げてはいけません。'
        + '放送ではないので「まず1本目」「続いて2本目」と順に並べる必要はありません。\n')
    + '・**字数を埋めるための水増しは禁止です。** 同じことを言い換えたり、'
    + '一般論や当たり障りのない前置きを足したりしないでください。'
    + '薄い内容を長くするくらいなら、短いままの方がましです。\n\n'
    + '【長さ・厳守】\n'
    + 'この回答はその場で音声合成されて再生されます。長すぎると合成が間に合わず、'
    + 'あなたの声が届かなくなります。'
    + (contextText
      // 評価は踏み込む余地が要るため上限を上げる。この長さでも音声合成は1回で収まる
      ? '**全体で400字前後、最大でも450字**に収めてください。'
      : '**全体で300字前後、最大でも350字**に収めてください。')
    + '文の数ではなく文字数で測ってください（短い文をいくつ並べても構いません）。\n'
    + (contextText
      ? '内訳の目安: ①②で40字程度、③で320〜380字、④で30字程度。'
        + '**挨拶や前置きに字数を使わず、評価そのものに使ってください。**\n'
      : '内訳の目安: ①②で50字程度、③で200〜250字、④で30字程度。\n')
    + '**ただしこれは上限であって、埋めるべきノルマではありません。** '
    + '伝えるべきことが少ない日（大きな動きが無い・数値に変化が無い等）は、'
    + '150字でも200字でも構いません。無い話を膨らませるより、'
    + '「今日は目立った動きはありません」と正直に短く伝える方が価値があります。';
  // 自分の日記の要約を読むだけの処理なので、最小限の入れ物を作って .call() で呼ぶ。
  // 相談できる相手はすべて Live のエージェントなので、チャンネルは Live で固定してよい。
  const _diaryCtx = { _channelId: 'Live', _diaryChannelId: sharedAgentMethods._diaryChannelId };
  // ATTENTION: 放送で同じ人が持っている手持ち（継続観測のメモ・定期監視・自主リサーチ・
  // 見た動画・裏の顔）は、必ず同じ仕組みを通してここでも渡すこと。自前で一部だけ組み立てて
  // いた頃は、相談すると本人がメモも調べ物も持たないまま答えていた。
  // ファイルを読むだけで言語モデルは呼ばないため、相談のたびに通しても費用には響かない。
  const knowledgePack = buildAgentKnowledgePack({
    agentKey,
    selfDigest: sharedAgentMethods._getAgentDiarySelfDigest.call(_diaryCtx, agentKey) || '',
    scene: 'consult',   // 公開範囲は lib/listener-context.js の決まりに従う
    topic: task || '',  // 「分かったこと」の台帳から、相談に関係する事実を選ぶ
    listenerName: config.show?.user_profile?.name || '',
  });
  // 会話から学んだ人物像だけでなく、設定に入っている項目（特別な日・音楽の好み・職業など）も
  // 全部渡す。担当ごとに一部だけ選ばず、誰に繋いでも判断材料になるようにする。
  const fullProfile = formatListenerProfile(config.show?.user_profile || {});
  const systemInstruction = agentCfg.prompt + contextNote + analysisNote
    + fullProfile + knowledgePack;

  // ATTENTION: 担当の「持ち場のデータ」を必ず渡すこと。各センターの人格は「原稿を読む」役
  // として書かれており、自分でデータを取る手段を持たない。渡す原稿が無いまま聞かれると、
  // その場でニュースや相場を作って答える（呼ぶたびに内容が変わる）。
  // 道具経由（get_news など）と同じ入れ物を使うので、聞き方によって答えが食い違うことも無い。
  // Live 側ではなく秘書側の入れ物を使うのは、LINE 経由では Live 側が無いため。
  let agentData = null;
  try {
    if (agentKey === 'news') {
      agentData = await newsService.fetch({ maxItems: 8 });
    } else if (agentKey === 'weather') {
      const profile = config.show?.user_profile || {};
      // 臨時の滞在先が有効ならそちらを使う。警報で使う都道府県コードは、滞在先の設定に
      // その項目自体が無いため、放送側と同じく常に自宅の値を使う。
      const { location: effectiveLocation, isTempStay } = _getEffectiveLocationFromConfig(config);
      agentData = await weatherService.fetch({
        overrideLocation: null,
        defaultLocation: effectiveLocation,
        isTempStay,
        apiKey: creds.openweathermap?.api_key,
        prefCode: profile.pref_code || '130000',
      });
    } else if (agentKey === 'finance') {
      agentData = await financeService.fetch(config);
    } else if (agentKey === 'caster' || agentKey === 'assistant') {
      // ATTENTION: キャスターとアシスタントにも天気とニュースを渡すこと。放送では他の
      // 出演者の発言が流れてくるので自分で調べる必要が無いが、直接聞かれると材料が何も無く、
      // 天気も相場も作り話になる。どちらも溜めてあるものを読むだけで、費用は増えない。
      const profile = config.show?.user_profile || {};
      const { location: effectiveLocation, isTempStay } = _getEffectiveLocationFromConfig(config);
      const [w, n] = await Promise.all([
        weatherService.fetch({
          overrideLocation: null, defaultLocation: effectiveLocation, isTempStay,
          apiKey: creds.openweathermap?.api_key, prefCode: profile.pref_code || '130000',
        }).catch(() => null),
        newsService.fetch({ maxItems: 6 }).catch(() => null),
      ]);
      agentData = [w, n].filter(Boolean).join('\n\n') || null;
    }
  } catch (e) {
    // 取得に失敗しても相談は続ける。下の指示により「今は取得できていない」と正直に答える
    getLogger().warn(`[Secretary] consult_agent(${agentKey}): 担当データの取得に失敗: ${e.message}`);
  }

  // ATTENTION: 作り話の禁止は、データが取れたかどうかに関わらず必ず添えること。
  // この歯止めが無かったことが、事実を作って答えていた原因そのものだった。
  const HAS_DATA_SOURCE = ['news', 'weather', 'finance', 'caster', 'assistant'].includes(agentKey);
  const dataNote = HAS_DATA_SOURCE
    ? (agentData
      ? `\n\n【あなたの手元にある最新の実データ】\n${agentData}\n\n`
        + '【厳守】天気・気温・株価・為替・出来事といった**事実に関わる部分は、必ず上記の'
        + '実データだけを根拠にしてください。** ここに書かれていない出来事・数値・固有名詞を、'
        + 'あなたの記憶から補ったり創作したりすることは絶対にしないでください。'
        + 'あなたの学習データは古く、それを最新の情報として伝えることは誤報になります。'
        + '（あなた自身の感想・見立て・番組の話など、事実の主張を含まない部分はこの限りでは'
        + 'ありません。）'
        + (SEARCH_GROUNDED_AGENT_KEYS.includes(agentKey)
          ? '\n検索機能も使えます。**数値は必ず上の実データの値を使い**、検索は'
            + '背景・経緯・詳細（被害の状況、避難の呼びかけ、出来事のいきさつ等）を'
            + '補うためだけに使ってください。検索結果が上のデータと食い違う場合は、'
            + '上のデータを正とします。'
          : '')
      : '\n\n【重要】現在、担当データを取得できていません。推測や記憶で事実を作らず、'
        + '「ただいま最新の情報を取得できていません」と正直に伝えてください。')
    // 検索で調べる担当への指示。事前のデータを持たせる代わりに検索そのものを持たせている
    // だけで、「作り話を許さない」という要求は同じ。
    : (SEARCH_GROUNDED_AGENT_KEYS.includes(agentKey)
      ? `\n\n【厳守】あなたにはGoogle検索でリアルタイムの情報を調べる機能が備わっています。`
        + `**必ず実際に検索してから答えてください。**${_searchHintFor(agentKey)}\n`
        + '検索結果に無い出来事・数値・固有名詞・日付を、記憶や推測で補ったり創作したりする'
        + 'ことは絶対にしないでください。**あなたの学習データは古く、それを最新の情報として'
        + '伝えることは誤報になります。** 検索しても該当する情報が見つからない場合は、'
        + '「現在、詳しい情報が見つかりませんでした」と正直に伝えてください。'
      // 検索も専用のデータも持たない担当（今は該当なし。今後の追加に備えて残す）
      : '\n\n【厳守】確認できていない出来事・数値・固有名詞・日付を、記憶や推測で'
        + '事実として述べないでください。一般的な考え方や助言として述べるに留め、'
        + '具体的な事実が必要な場面では「詳しくは確認が必要です」と正直に伝えてください。');

  // 専門家ごとの「プロとして手元に無いと話にならない材料」。
  // ATTENTION: 何を渡すかは、放送側の各コーナーが渡しているものにそろえること。放送では
  // 持っているのに秘書経由では持っていない、という状態は、同じ人格が場面によって別人に
  // なることを意味する。実際、市場の数字を持たない経済の専門家は教科書的な助言しか返さず、
  // 追う相手の一覧を持たないジャーナリストは一般論になり、再生履歴を持たない DJ は
  // 想像で曲を薦めていた。
  let marketReferenceNote = '';
  try {
    if (agentKey === 'commentator') {
      const [market, news] = await Promise.all([
        financeService.fetch(config).catch(() => null),
        newsService.fetch({ maxItems: 8 }).catch(() => null),
      ]);
      const blocks = [];
      if (market) blocks.push(market);
      if (news) blocks.push(news);
      if (blocks.length > 0) {
        marketReferenceNote = `\n\n【いま手元にある市場データとニュース（数値・出来事の根拠にしてください）】\n${blocks.join('\n\n')}\n\n`
          + '【使い方】株価・指数・為替・金利・コモディティの**数値はこのデータの値をそのまま'
          + '使ってください**（記憶や推測の数字を混ぜないこと）。背景にある出来事や世界情勢は'
          + '検索で補って構いませんが、ここに載っている数値と食い違う説明はしないでください。';
      }
      // 保有銘柄の先取り調査は、上の知識の詰め合わせに含まれるのでここでは足さない
    } else if (agentKey === 'journalist') {
      // ATTENTION: 渡すのは名前の一覧だけにすること。検索式を大量に埋めると「文脈は十分」と
      // 判断して検索を省いてしまう（放送側でも同じことが実測されている）。
      const wl = config.journalist_watchlist || {};
      const nameList = (arr) => (arr || []).map((e) => (typeof e === 'string' ? e : e.name)).join('・');
      const rows = [
        ['日本政府・省庁', wl.japan_official], ['日本政治', wl.japan_politics],
        ['米国政府・政治', [...(wl.us_official || []), ...(wl.us_politics || [])]],
        ['テック・ビジネス', wl.tech_business], ['世界の指導者', wl.world_leaders],
        ['国際機関', wl.international_orgs], ['一次通信社', wl.primary_wire],
      ].map(([label, arr]) => (arr && arr.length ? `- ${label}: ${nameList(arr)}` : '')).filter(Boolean);
      if (rows.length > 0) {
        marketReferenceNote = '\n\n【あなたが日頃ウォッチしている情報源】\n' + rows.join('\n')
          + '\n検索するときは、これらの発言・投稿・発表を優先して当たってください。'
          + '一般的な解説記事ではなく、一次情報から拾うのがあなたの持ち味です。'
          // ATTENTION: 役どころと事実の線を明示的に引くこと。「独自の情報源を持つ」という
          // 人格の設定が強いため、一般的な作り話の禁止だけでは押し切られ、裏の取れない話を
          // 「極秘情報」として断定的に語った。
          + '\n\n【重要】あなたが「独自ソース」「極秘情報」という体で語るのは**演出**であって、'
          + '中身まで作ってよいという意味ではありません。実際に検索で確認できた事実だけを、'
          + 'その口調で伝えてください。裏の取れていない話に「関係者によると」「極秘情報ですが」'
          + 'と付けて語れば、それは演出ではなく偽情報です。**確認できないものは、そもそも'
          + '話題に出さないでください。** 切り口の鋭さで勝負するのであって、話の派手さでは'
          + 'ありません。';
      }
    } else if (agentKey === 'music_dj') {
      // リスナーが実際に何を聴いているかは、DJ にとっての持ち場のデータ。放送側の道具は
      // LINE 経由では使えないため、秘書側の同じ入れ物から読む。つながっていなければ黙って省く。
      const [recent, top] = await Promise.all([
        spotifyUserService.getRecentlyPlayed(creds, { limit: 10 }).catch(() => null),
        spotifyUserService.getTopTracks(creds, { limit: 10 }).catch(() => null),
      ]);
      const fmt = (list) => (Array.isArray(list) ? list : [])
        .map((t) => `${t.trackName || ''}／${t.artists || ''}`)
        .filter((x) => x.replace('／', '').trim() !== '').slice(0, 10);
      const r = fmt(recent);
      const t = fmt(top);
      if (r.length > 0 || t.length > 0) {
        marketReferenceNote = '\n\n【リスナーが実際に聴いている曲（Spotify）】\n'
          + (r.length ? `▼最近再生した曲:\n${r.map((x) => `- ${x}`).join('\n')}\n` : '')
          + (t.length ? `▼よく聴く曲:\n${t.map((x) => `- ${x}`).join('\n')}\n` : '')
          + '想像で好みを決めつけず、この実際の履歴を手がかりにしてください。'
          + 'ここに無い曲を薦めるのは構いませんが、その場合も曲名・アーティスト・発売年は'
          + '検索で確かめてから挙げてください。';
      }
    }
  } catch (e) {
    getLogger().warn(`[Secretary] consult_agent(${agentKey}): 参考データの取得に失敗: ${e.message}`);
  }

  const _profile = config.show?.user_profile || {};
  let personalizationNote = '';
  if (agentKey === 'traffic') {
    const { location: _effLoc, isTempStay: _isTempStay, tempStay: _tempStay } = _getEffectiveLocationFromConfig(config);
    if (_isTempStay) {
      personalizationNote = `\n\n【重要・一時滞在中】リスナーは現在${_effLoc}に一時的に滞在中`
        + `${_tempStay?.purpose ? `（${_tempStay.purpose}）` : ''}です。自宅周辺ではなく`
        + `${_effLoc}周辺の交通情報をGoogle検索し、答えてください。`;
    } else if (_profile.traffic_areas?.length > 0) {
      personalizationNote = `\n\n【リスナーがよく使う道路・エリア】${_profile.traffic_areas.join('・')}\n`
        + 'これらの情報を踏まえ、リスナーに関係の深い路線・道路を優先してGoogle検索し、答えてください。';
    }
  } else if (agentKey === 'news') {
    const hobbies = _profile.hobbies || '';
    const interests = _profile.interests || '';
    if (hobbies || interests) {
      personalizationNote = `\n\n【リスナーの興味・関心】${hobbies ? `趣味: ${hobbies}。` : ''}`
        + `${interests ? `興味: ${interests}。` : ''}\n政治・経済・災害等の大きなニュースを`
        + '優先しつつ、これらに関連しそうなニュースが実データの中に見つかった場合は、'
        + '別枠で一言添えて紹介してください（無理にこじつける必要はありません）。';
    }
  }

  // 他の専門家の日記に、今回の相談に関係する知見が無いか探す。ある担当が相談で得たことを、
  // 別の担当も参照できるようにする仕組みで、相手を問わず効く。
  // 自分の日記は除く（自己の振り返りは、別に用意された自己ダイジェストが担う）。
  let crossAgentDiaryNote = '';
  try {
    const diaryMatches = agentDiary.searchDiaryEntries({
      queryText: contextText ? `${task}\n${contextText}` : task,
      excludeAgentKey: agentKey,
    });
    if (diaryMatches.length > 0) {
      const lines = diaryMatches.map((m) => {
        const dateLabel = new Date(m.time).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
        return `- ${m.agentName}（${dateLabel}）: ${m.text}`;
      });
      crossAgentDiaryNote = '\n\n【他の専門家が過去の相談・振り返りで得た関連知見】\n' + lines.join('\n')
        + '\n参考になりそうであれば踏まえてください。関係が薄ければ無視して構いません。';
    }
  } catch (e) {
    getLogger().warn(`[Secretary] consult_agent(${agentKey}): 日記横断検索に失敗: ${e.message}`);
  }

  const userTurn = contextText
    ? `以下の内容について、あなたの専門的な視点で意見・見解を述べてください。\n\n【内容】\n${contextText}\n\n【依頼】\n${task}${dataNote}${marketReferenceNote}${personalizationNote}${crossAgentDiaryNote}`
    : `${task}${dataNote}${marketReferenceNote}${personalizationNote}${crossAgentDiaryNote}`;

  // 思考の設定・思考部分の除外・使用量の記録は、呼び出しの層がまとめて引き受ける。
  // 稼働レポートには実際に話した担当のキーで記録され、秘書自身の分とは別に集計される。
  const _t0 = Date.now();
  const { text: rawText } = await generateText({
    tier: 'analysis',
    apiKey,
    creds,
    systemInstruction,
    prompt: userTurn,
    grounded: SEARCH_GROUNDED_AGENT_KEYS.includes(agentKey),
    agentKey,
    activitySessionId,
  });

  // 印が正しく付かなかった場合に備えた2段目の安全網
  const text = sharedAgentMethods._collapseReasoningLeak.call(
    _leakCtx, rawText, { detectEnglishPrefix: sharedAgentMethods._promptExpectsJapanese(agentCfg.prompt) }
  );
  if (text == null) return { error: `${agentCfg.name || agentKey}からの応答を安全に取得できませんでした` };
  getLogger().info(`[Secretary] consult_agent(${agentKey}): テキスト生成完了（${Date.now() - _t0}ms、${text.length}文字）`);

  // 本人の声に切り替える。借りるのは声の合成の部分だけで、放送のコーナー生成・ミキサー・
  // 一斉配信には触れない。
  // ATTENTION: 合成に失敗しても致命的にしないこと。テキストだけで会話を続けられるようにする。
  let audioBase64 = null;
  const agentSystem = getAgentSystem?.();
  if (agentSystem) {
    // 声になったかどうかに関わらず、回答の中身は会話履歴に残す
    agentSystem._logConversationHistory(agentKey, text);
    try {
      // 合成そのものは打ち切らない。「これ以上待たずにテキストだけで返す」ための競争であり、
      // 負けた側は裏で走り続けて、誰にも参照されないまま捨てられるだけ。
      const pcm = await Promise.race([
        synthesizeAgentVoicePcm(agentSystem, text, agentKey, agentCfg),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`音声合成が${VOICE_SYNTHESIS_TIMEOUT_MS / 1000}秒以内に完了しませんでした`)),
          VOICE_SYNTHESIS_TIMEOUT_MS
        )),
      ]);
      if (pcm && pcm.length > 0) {
        audioBase64 = agentSystem._pcmToWav(pcm, 24000, 1, 16).toString('base64');
        getLogger().info(`[Secretary] consult_agent(${agentKey}): 音声合成に成功（${audioBase64.length}文字のbase64）`);
      } else {
        getLogger().warn(`[Secretary] ${agentKey}の音声合成結果が空でした（テキストのみで継続）`);
      }
    } catch (e) {
      getLogger().warn(`[Secretary] ${agentKey}の音声合成に失敗（テキストのみで継続）: ${e.message}`);
    }
  }

  // やり取りを本人の日記に残す。完了は待たない（相談の応答時間に上乗せしないため）。
  // BUGFIX: ここに存在しない変数を渡していたため、相手が誰かに関係なく毎回失敗していた。
  // 音声合成の後に投げられるので、声は出来ているのに結果ごと捨てられ、秘書が「音声の連結に
  // 問題があったみたい」と言ってテキストを代読する形になっていた。引数を足すときは、
  // その変数がこの関数の中に実在するか必ず確かめること。
  writeConsultDiary({
    agentKey, agentName: agentCfg.name || agentKey, task, contextText, answerText: text,
    apiKey, activitySessionId,
  }).catch(() => {});

  getLogger().info(`[Secretary] consult_agent(${agentKey}): 呼び出し元へ結果を返します（audio=${audioBase64 ? 'あり' : 'なし'}）`);
  // 他の道具と同じく記録に残す。1日の活動を振り返る材料になる
  secretaryStore.appendEntry('daily-briefings', {
    tool: 'consult_agent', result: `${agentCfg.name || agentKey}に相談: ${task}`, agentKey,
  });
  return { agentKey, agentName: agentCfg.name || agentKey, text, audioBase64 };
}

// 道具の名前とハンドラの対応表。各ハンドラは (args, ctx) を受け取り、result か error を含む
// オブジェクトを返す。ctx は config・creds・activitySessionId・getAgentSystem。
// 分野ごとの道具は、各 secretary-tools-*.js が公開する対応表を展開して合流させている。
const TOOL_HANDLERS = {
  get_current_time: async () => {
    return { result: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'full', timeStyle: 'short' }) };
  },

  get_watchlist_updates: async () => {
    const watch = journalistWatch.getLatestDigest();
    if (!watch) {
      return { result: 'まだ定期監視のデータがありません（次の取得タイミングは0時・6時・12時・18時のいずれかです）。' };
    }
    const updatedLabel = new Date(watch.fetchedAt).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
    return { result: `【${updatedLabel}時点でジャーナリストXが把握している最新情報】\n${watch.digest}` };
  },

  // ── Google Workspace連携（secretary-tools-google.js） ──────────────────────
  ...googleToolsDomain.TOOL_HANDLERS,

  // 裏方ヘルパー専用の、生のまま取る道具。
  // ATTENTION: 分析の土台にする値を、要約の道具で取らないこと。読ませて返させると、途中で
  // 値が落ちたり丸められたりする余地があるうえ、桁違いに時間がかかる。取得は取得として
  // そのまま行い、解釈と計算はヘルパー側のコードに任せる。
  fetch_spreadsheet_data: async (args, ctx) => {
    const { creds } = ctx;
    const { spreadsheetId, gid } = parseGoogleSheetUrl(args?.url);
    if (!spreadsheetId) {
      return { error: 'GoogleスプレッドシートのURLとして認識できませんでした。共有されたURLをそのまま渡してください。' };
    }
    let sheet;
    try {
      sheet = await googleService.fetchSpreadsheetValues(creds, { spreadsheetId, gid });
    } catch (e) {
      getLogger().warn(`[Secretary] fetch_spreadsheet_data失敗: ${e.message}`);
      return { error: `スプレッドシートを取得できませんでした（${e.message}）` };
    }
    const rows = sheet.rows || [];
    if (rows.length === 0) {
      return { error: `シート「${sheet.sheetTitle}」にはデータがありませんでした。別のタブ（gid）を指定してみてください。` };
    }
    // タブ区切りのまま返す。整形も要約もしない（読み解くのはコード側）
    const tsv = rows.map((r) => r.join('\t')).join('\n');
    return { result: `【スプレッドシート「${sheet.spreadsheetTitle}」／シート「${sheet.sheetTitle}」の生データ`
      + `（${rows.length}行・タブ区切り・値は表示形式そのまま）】\n${tsv}` };
  },

  // 裏方ヘルパーへ出した依頼の進み具合を答える、唯一の手段。
  // ATTENTION: ヘルパーへ依頼する道具そのものは、この対応表に載せないこと。この表は
  // ヘルパー側からも使われるため、載せるとヘルパーが自分自身を呼び続けうる。
  get_job_status: async () => {
    const running = jobStore.listRunningJobs();
    if (running.length > 0) {
      const lines = running.map((j) => `・「${j.request}」— ${j.progress}`);
      return { result: wrapDataForSpeechGuidance(
        `現在${running.length}件の作業を処理中です。\n${lines.join('\n')}\n\n`
        + '完了したら自動的に画面へ表示されお知らせが届くので、リスナーには'
        + 'まだ処理中である旨だけを短く伝えてください。いつ終わるかの予測を作らないでください。',
      ) };
    }
    const recent = jobStore.listJobs({ limit: 3 });
    if (recent.length === 0) return { result: '現在処理中の作業はありません。まだ何も依頼を受けていません。' };
    const lines = recent.map((j) => {
      if (j.status === 'done') return `・「${j.request}」— 完了済み（結果: ${String(j.resultText || '').slice(0, 200)}）`;
      return `・「${j.request}」— 失敗（${j.error || '理由不明'}）`;
    });
    return { result: wrapDataForSpeechGuidance(
      `現在処理中の作業はありません。直近の依頼はこちらです。\n${lines.join('\n')}`,
    ) };
  },

  get_news: async (args) => {
    // 話題での絞り込みは、見出しの一致でコード側が決める
    const topic = args?.topic || '';
    // 件数を指定されなければ既定の8件
    const parsedCount = parseInt(args?.count, 10);
    const maxItems = Number.isInteger(parsedCount) && parsedCount > 0 ? parsedCount : 8;
    // BUGFIX: 海外のニュースは、必ず海外の配信元から取ること。取る手段が無かった頃は、
    // 本文は検索で得ながらリンクだけ直前の国内の結果を流用する、という出典の食い違いが起きた。
    if (args?.scope === 'world') {
      const items = await newsService.fetchGlobalNews({
        category: /経済|市場|株|ビジネス|econom|market|business/i.test(topic) ? 'all' : 'tech',
        perFeed: Math.max(4, Math.ceil(maxItems / 2)),
      });
      // 話題の指定があれば、見出しと概要への部分一致で絞る。
      // ATTENTION: 合致するかどうかの判定をモデルの目に委ねず、コード側で決めること。
      const needle = topic.trim().toLowerCase();
      const matched = needle
        ? items.filter(i => `${i.title} ${i.desc}`.toLowerCase().includes(needle))
        : items;
      const picked = matched.slice(0, maxItems);
      const worldResult = picked.length === 0
        ? `海外のニュースフィードには、現時点で「${topic || '該当するもの'}」に関連する見出しが見つかりませんでした。`
        : `海外ニュース（${picked.map(i => i.source).filter((v, idx, a) => a.indexOf(v) === idx).join('・')}）`
          + `${topic ? `「${topic}」に関連する見出し` : '最新の見出し'}（${picked.length}件）:\n`
          + picked.map((i, idx) => `${idx + 1}. [${i.source}] ${i.title}`
            + `${i.desc ? `\n   概要: ${i.desc}` : ''}\n   URL: ${i.link}`).join('\n');
      const worldWrapped = wrapDataForSpeechGuidance(worldResult);
      secretaryStore.appendEntry('daily-briefings', { tool: 'get_news', args: { topic, maxItems, scope: 'world' }, result: worldResult });
      return { result: worldWrapped };
    }
    const news = await newsService.fetch({ topic, maxItems });
    const result = news ? wrapDataForSpeechGuidance(news) : '現在ニュースを取得できませんでした。';
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_news', args: { topic, maxItems }, result: news || result });
    return { result };
  },

  get_weather: async (args, ctx) => {
    const { config, creds } = ctx;
    const profile = config.show?.user_profile || {};
    const weather = await weatherService.fetch({
      overrideLocation: null,
      defaultLocation: profile.location,
      isTempStay: false,
      apiKey: creds.openweathermap?.api_key,
      prefCode: profile.pref_code || '130000',
    });
    const result = weather ? wrapDataForSpeechGuidance(weather) : '現在天気情報を取得できませんでした。';
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_weather', result: weather || result });
    return { result };
  },

  get_finance: async (args, ctx) => {
    const { config } = ctx;
    const finance = await financeService.fetch(config);
    const result = finance ? wrapDataForSpeechGuidance(finance) : '現在金融情報を取得できませんでした。';
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_finance', result: finance || result });
    return { result };
  },

  // ── Spotify連携（secretary-tools-spotify.js） ───────────────────────────────
  ...spotifyToolsDomain.TOOL_HANDLERS,

  // ── YouTube連携（secretary-tools-youtube.js） ───────────────────────────────
  ...youtubeToolsDomain.TOOL_HANDLERS,

  remember_fact: async (args) => {
    const { fact } = args || {};
    secretaryMemory.rememberExplicit(fact);
    return { result: '承知しました、覚えておきます。' };
  },

  end_session: async () => {
    return { result: '会話を終了します。', endSession: true };
  },

  show_on_canvas: async (args) => {
    const { title, content } = args || {};
    return { result: 'キャンバスに表示しました。', canvas: { title, content: _normalizeMermaidInContent(_ensureMermaidFenced(content)) } };
  },

  show_weather_map: async (args) => {
    const { map_type } = args || {};
    const isSatellite = map_type === '衛星画像';
    try {
      const { buf, label } = isSatellite ? await fetchSatelliteImageBuffer() : await fetchWeatherChartBuffer();
      const imageMime = isSatellite ? 'image/webp' : 'image/png';
      const title = isSatellite ? `衛星画像（${label}）` : `地上天気図（${label}）`;
      return {
        result: `${isSatellite ? '衛星画像' : '天気図'}をキャンバスに表示しました。`,
        canvas: { title, imageBase64: buf.toString('base64'), imageMime },
      };
    } catch (e) {
      getLogger().warn(`[Secretary] show_weather_map(${map_type})の取得に失敗: ${e.message}`);
      return { error: `${isSatellite ? '衛星画像' : '天気図'}の取得に失敗しました。時間をおいて再度お試しください。` };
    }
  },

  consult_agent: async (args, ctx) => {
    const { config, creds, activitySessionId, getAgentSystem } = ctx;
    const { agent_key, task, context_text } = args || {};
    const res = await consultAgent({
      agentKey: agent_key, task, contextText: context_text, config, creds, activitySessionId, getAgentSystem,
    });
    if (res.error) return { error: res.error };
    // result だけが会話を続けるためにモデルへ返る。
    // ATTENTION: 音声を result に混ぜないこと。巨大な符号化データをモデルへ送る意味が無い。
    // 音声と名前とキーは別の項目のまま返し、呼び出し側が再生とアバターの切り替えに使う。
    // キーは画面側で名前から引き直させず、サーバーが持っているものをそのまま渡す。
    return {
      result: `${res.agentName}の見解: ${res.text}`,
      agentName: res.agentName, agentKey: res.agentKey, audioBase64: res.audioBase64,
    };
  },

  analyze_uploaded_file: async (args, ctx) => {
    const { creds, activitySessionId } = ctx;
    const { file_id, instruction } = args || {};
    const res = await analyzeUploadedFile({ fileId: file_id, instruction, creds, activitySessionId });
    if (res.error) return { error: res.error };
    return { result: res.result };
  },

  analyze_google_sheet: async (args, ctx) => {
    const { creds, activitySessionId } = ctx;
    const { url, instruction } = args || {};
    const res = await analyzeGoogleSheet({ url, instruction, creds, activitySessionId });
    if (res.error) return { error: res.error };
    return { result: res.result };
  },

  analyze_web_page: async (args, ctx) => {
    const { creds, activitySessionId } = ctx;
    const { url, instruction } = args || {};
    const res = await analyzeWebPage({ url, instruction, creds, activitySessionId });
    if (res.error) return { error: res.error };
    return { result: res.result };
  },

  // ── Obsidian連携（secretary-tools-obsidian.js） ─────────────────────────────
  ...obsidianToolsDomain.TOOL_HANDLERS,

  // ── 日報・週報生成（secretary-tools-reports.js） ────────────────────────────
  ...reportsToolsDomain.TOOL_HANDLERS,

  // ── 資産（金融）レポート生成（secretary-tools-finance.js） ──────────────────
  ...financeToolsDomain.TOOL_HANDLERS,

  // ── 会話履歴の横断参照（secretary-tools-history.js） ──────────────────────
  // 音声と LINE は実装としては別の経路だが、利用者から見れば同じ秘書への依頼。
  // どちらの過去のやり取りも読み出せるようにする。
  ...historyToolsDomain.TOOL_HANDLERS,

  // ── プレゼンテーション作成（secretary-tools-presentation.js） ────────────────
  ...presentationToolsDomain.TOOL_HANDLERS,
};

/**
 * 道具の名前で対応するハンドラを呼ぶ。未知の名前や実行中の例外は、エラーとして返す。
 *
 * @param {string} name 道具の名前
 * @param {any} args 道具へ渡す引数
 * @param {any} ctx config・creds・activitySessionId・getAgentSystem
 * @returns {Promise<any>} result か error を含む結果
 */
async function executeSecretaryTool(name, args, ctx) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { error: `unknown tool: ${name}` };
  try {
    return await handler(args, ctx);
  } catch (e) {
    getLogger().warn(`[Secretary] tool "${name}" 実行失敗: ${e.message}`);
    return { error: e.message };
  }
}

module.exports = {
  executeSecretaryTool, CONSULTABLE_AGENT_KEYS, createDailyReport: reportsToolsDomain.createDailyReport,
  createSecretaryActivityLog: reportsToolsDomain.createSecretaryActivityLog,
  updateFinanceReport: financeToolsDomain.updateFinanceReport, createWeeklyReport: reportsToolsDomain.createWeeklyReport,
};
