/**
 * @file 秘書の Google Workspace の道具（カレンダー・メール・タスク・ドライブ）
 *
 * 秘書（Gemini Live・LINE・ヘルパー）が呼ぶツールのうち、Google のカレンダー・Gmail・Tasks・Drive を扱うものの
 * 宣言（TOOL_DECLARATIONS）と処理（TOOL_HANDLERS）を持つ。Google の API を実際に呼ぶのは
 * secretary-tools-services.js の googleService。結果は secretary-store.js（daily-briefings・email-logs）にも残す。
 *
 * 未読メールは優先度（高・中・低・無視）を LLM で付けて渡す。仕分けた結果はメールの ID ごとに覚えておき、
 * 次からは新しく届いた分だけを取り出して仕分ける（refreshEmailTriage）。
 *
 * 利用元は secretary-tools.js（処理の振り分け）・secretary-tool-declarations.js（宣言の取りまとめ）・
 * secretary-loop.js（先回りのメールの仕分け）。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-19
 */
'use strict';

const { generateText } = require('./llm-client');
const { sharedAgentMethods } = require('./agent-shared-mixin');
const { getLogger } = require('../logger');
const secretaryStore = require('./secretary-store');
const { googleService } = require('./secretary-tools-services');

/**
 * 予定の一覧を、秘書に渡す文にする。
 *
 * 予定の変更・削除（update_calendar_event・delete_calendar_event）には Google カレンダーの予定の ID が
 * 要るので、各行の末尾に [id: ...] を付けておく。声には出さず、後のツール呼び出しでだけ使うよう、
 * 冒頭で指示する（アップロードしたファイルの file_id と同じやり方）。
 *
 * @param {Array<any>} events 予定（dateLabel・timeStr・summary・location・id）
 * @returns {string} 秘書に渡す文
 */
function formatCalendarForSpeech(events) {
  if (events.length === 0) return '直近の予定はありません。';
  const lines = events.map(e => {
    const loc = e.location ? `（${e.location}）` : '';
    return `[${e.dateLabel}] ${e.timeStr} ${e.summary}${loc} [id: ${e.id}]`;
  }).join('\n');
  return `（各行末尾の[id: ...]はこの予定を一意に指す内部参照情報です。声には出さず、`
    + `この予定の変更・削除を頼まれた場合にupdate_calendar_event/delete_calendar_eventの`
    + `event_idへそのまま渡してください）\n\n${lines}`;
}

const EMAIL_PRIORITY_ORDER = ['高', '中', '低', '無視'];

/**
 * フィルターで除いたメールの件数を、秘書に伝えさせる一文にする。
 *
 * 除いたメールが見えないと、リスナーが取りこぼしに気づけないため。件数だけを伝え、中身には触れない。
 *
 * @param {Record<string, any>|null} excluded 除いた件数（counts・total・capped）
 * @returns {string} 秘書に渡す文（除いたものが無ければ空文字）
 */
function formatExcludedNote(excluded) {
  if (!excluded || !excluded.total) return '';
  const parts = Object.entries(excluded.counts).map(([label, n]) => `${label}${n}件`);
  return `\n\n【フィルタで除外した分（件数のみ・内容は取得していません）】`
    + `${parts.join('・')}${excluded.capped ? '以上' : ''}（合計${excluded.total}件${excluded.capped ? '以上' : ''}）\n`
    + `※ この件数は、リスナーが「他にもメールはある?」と気づけるように必ず一言添えてください`
    + `（例:「ほかにプロモーションが20件ありますが、こちらは省いています」）。ただし内容は`
    + `取得していないため、詳細を聞かれても答えられません。見たい場合はGmailで直接ご確認`
    + `いただくか、管理画面のフィルタ設定を変更する必要があることを伝えてください。`;
}

/**
 * 優先度を付けたメールを、優先度ごとにまとめた参考データの文にする。
 *
 * @param {Array<any>} emails 優先度を付けたメール（classifyEmails の結果）
 * @param {Record<string, any>|null} [excluded] フィルターで除いた件数
 * @returns {string} 秘書に渡す文
 */
function formatTriagedEmailsForSpeech(emails, excluded = null) {
  if (emails.length === 0) {
    return `直近24時間の新着未読メールはありません。${formatExcludedNote(excluded)}`;
  }
  const byPriority = {};
  for (const p of EMAIL_PRIORITY_ORDER) byPriority[p] = [];
  for (const e of emails) (byPriority[e.priority] || (byPriority[e.priority] = [])).push(e);

  const sections = [];
  for (const priority of Object.keys(byPriority)) {
    const list = byPriority[priority];
    if (list.length === 0) continue;
    if (priority === '無視') {
      sections.push(`【無視】${list.length}件（広告・スパム的な内容のため詳細は省略）`);
      continue;
    }
    // BUGFIX: 要点だけでなく受信時刻と送信元のアドレスも渡す。無いと「いつ届いたの」のような
    // 後からの質問に秘書が答えられなかった
    const lines = list.map(e => {
      const parts = [`件名: ${e.subject}（${e.from}より）`];
      if (e.receivedAt) parts.push(`受信: ${e.receivedAt}`);
      if (e.fromAddress) parts.push(`送信元アドレス: ${e.fromAddress}`);
      parts.push(`要点: ${e.summary || e.snippet}`);
      if (e.recommended_action) parts.push(`推奨: ${e.recommended_action}`);
      if (priority === '高' && e.reply_draft) parts.push(`返信案: ${e.reply_draft}`);
      return parts.join('\n  ');
    });
    sections.push(`【優先度: ${priority}】（${list.length}件）\n${lines.join('\n\n')}`);
  }
  // BUGFIX: 関数名に反して、中身は話し言葉ではなく参考データ。データの前に「そのまま読み上げない」
  // 指示を付ける。無いと秘書が全文を読み上げようとして、声の合成が途中で途切れて黙り込んだ。
  // BUGFIX: 画面に出すことは「表示しましょうか」と尋ねさせず、「表示しておきますね」と言い切らせる。
  // 尋ねさせると、答えを待たずに自分で答えてしまう（自問自答）ことがあった
  return `（以下は参考データです。全文をそのまま読み上げず、件数と特に重要な項目だけを`
    + `あなた自身の言葉で短く自然に要約して伝えてください。重要な項目があれば、許可を尋ねる`
    + `のではなく「詳しい内容は画面に表示しておきますね」のように断定的に伝えた上で画面表示`
    + `機能を呼び出してください）\n\n${sections.join('\n\n')}` + formatExcludedNote(excluded);
}

/**
 * 未読メールに、LLM で優先度（高・中・低・無視）と要点・勧める対応・返信の下書きを付ける。
 *
 * 仕分けに失敗したら、全部を「不明」のまま返す（仕分けが無くてもメールは読めるようにし、黙って隠さない）。
 *
 * @param {Array<any>} emails 未読メール（subject・from・body・snippet など）
 * @param {{creds: Record<string, any>, activitySessionId: any}} ctx 認証情報と記録用のセッション ID
 * @returns {Promise<Array<any>>} 優先度などを付けたメール
 */
async function classifyEmails(emails, { creds, activitySessionId }) {
  if (emails.length === 0) return [];
  const apiKey = creds.gemini?.api_key;
  if (!apiKey) return emails.map(e => ({ ...e, priority: '不明', summary: e.body || e.snippet, recommended_action: '', reply_draft: '' }));

  // 仕分けは機械的な作業なので、会話用より軽いモデル（secretary_light）で足りる。
  // BUGFIX: 「概要」（本文の抜粋）に書かれていることだけを使い、推測で補わないよう指示する。無いと、
  // 書かれていない日時・場所・固有名詞を要点や返信の下書きに作り上げていた
  const systemInstruction = 'あなたはメールを優先度で仕分ける秘書アシスタントです。以下の基準で分類してください。\n'
    + '高: 返信期限がある・お金に関わる話・クレーム・重要な人物からの依頼\n'
    + '中: 返信は必要だが急ぎではない\n'
    + '低: CC・ニュースレター・お知らせ等、対応不要\n'
    + '無視: 広告・スパム的な内容\n'
    + '「高」の場合のみ、丁寧で簡潔な日本語の返信下書き(reply_draft)も作成してください。'
    + 'それ以外はreply_draftを空文字にしてください。summaryは1文で簡潔に。'
    + '【重要】summary・recommended_action・reply_draftは、必ず各メールの「概要」に実際に'
    + '書かれている内容だけを根拠にしてください。書かれていない日時・場所・金額・固有名詞などを'
    + '推測で補って書かないでください。「概要」が定型の挨拶文や配信停止案内だけで実質的な内容が'
    + '読み取れない場合は、無理に具体的な内容を作らず、summaryに「詳細不明（件名以外の情報なし）」'
    + 'のようにそのまま記載してください。'
    + '出力はJSON配列のみとし、説明文などは一切含めないでください。';
  const listText = emails.map((e, i) => `${i}. 件名: ${e.subject} / 送信者: ${e.from}\n概要: ${e.body || e.snippet}`).join('\n\n');
  const userPrompt = `以下のメール一覧を分類してください。\n\n${listText}\n\n`
    + '出力形式（この配列の形のJSONのみ）: '
    + '[{"index": 0, "priority": "高"|"中"|"低"|"無視", "summary": "...", "recommended_action": "...", "reply_draft": "..."}]';
  const { text: rawText } = await generateText({
    tier: 'secretary_light',
    apiKey,
    systemInstruction,
    prompt: userPrompt,
    temperature: 0,
    json: true,
    agentKey: 'secretary',
    activitySessionId,
  });

  let classifications;
  try {
    classifications = JSON.parse(rawText);
  } catch (e) {
    getLogger().warn(`[Secretary] メール分類のJSON解析に失敗（分類無しで返す）: ${e.message}`);
    return emails.map(e => ({ ...e, priority: '不明', summary: e.body || e.snippet, recommended_action: '', reply_draft: '' }));
  }

  return emails.map((e, i) => {
    const c = (classifications || []).find(c => c.index === i) || {};
    return {
      ...e,
      priority: c.priority || '不明',
      summary: c.summary || e.snippet,
      recommended_action: c.recommended_action || '',
      reply_draft: c.reply_draft || '',
    };
  });
}

/**
 * 未完了のタスクの一覧を、秘書に渡す文にする。
 * @param {Array<any>} tasks タスク（title・due）
 * @returns {string} 秘書に渡す文
 */
function formatTasksForSpeech(tasks) {
  if (tasks.length === 0) return '未完了のタスクはありません。';
  return tasks.map(t => `・${t.title}${t.due ? `（期限: ${t.due}）` : ''}`).join('\n');
}

// このファイルのツールの宣言（Gemini の Function Calling の形）。設定に依存しないので定数で持つ。
// description はモデルがツールを使うかどうか・どう使うかを決める材料なので、発動の条件まで書いてある
const TOOL_DECLARATIONS = [
      {
        name: 'get_calendar',
        // BUGFIX: 範囲（from_date・days）を指定できる。範囲が固定だったころ、範囲の外の日の予定を
        // 「何も入っていない」と答え、その混乱から予定を二重に登録していた
        description: 'リスナーのGoogleカレンダーの予定を取得します。「今日の予定は？」'
          + '「来週のスケジュールを確認して」「10月の予定を見せて」等に使います。'
          + '\n\n【範囲の指定・重要】既定は今日から7日間です。**それより先の日付について'
          + '聞かれた場合は、必ず from_date と days を指定してください。**指定を怠ると'
          + 'その日は取得範囲に入らず、予定があっても「何もありません」と誤って答えることになります。'
          + '\n例) 「9月3日の予定」→ from_date="2026-09-03", days=1'
          + '\n例) 「来週1週間」→ from_date=来週月曜の日付, days=7'
          + '\n例) 「10月の予定」→ from_date="2026-10-01", days=31'
          + '\n日付が曖昧なときは、先に get_current_time で今日の日付を確認してから計算してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            from_date: { type: 'STRING', description: '取得の起点となる日（YYYY-MM-DD）。省略時は今日' },
            days: { type: 'NUMBER', description: '起点から何日分か（既定7、最大90）' },
          },
        },
      },
      {
        name: 'create_calendar_event',
        description: 'リスナーのGoogleカレンダーに新しい予定を作成します。「〇月〇日の〇時から予定を入れて」のように'
          + '予定の追加を明示的に依頼されたときに使います。日時は必ずget_current_timeやこのプロンプト内の'
          + '【本日の日付・現在時刻】を基準に、正確なISO 8601形式（例: 2026-08-05T13:00:00+09:00）へ変換してください。'
          + '\n\n【重複の確認・重要】同じ時間帯に既に予定がある場合、この機能は**作成せずに**'
          + 'その予定を返します。そのときは勝手に登録し直さず、リスナーへ「すでに〇〇の予定が'
          + '入っておりますが、いかがしますか」と確認してください。重ねてよいと言われた場合だけ'
          + 'confirmed_overlap=true を付けて呼び直します。',
        parameters: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING', description: '予定の件名（例: 水道工事）' },
            start_datetime: { type: 'STRING', description: '開始日時（ISO 8601、日本時間、例: 2026-08-05T13:00:00+09:00）' },
            end_datetime: { type: 'STRING', description: '終了日時（ISO 8601、日本時間）' },
            location: { type: 'STRING', description: '場所（任意）' },
            description: { type: 'STRING', description: '詳細メモ（任意）' },
            confirmed_overlap: { type: 'BOOLEAN', description:
              'リスナーが「重なっても構わない」と了承した場合のみ true。'
              + '既定では時間帯の重複があると作成されず、確認を求められます。'
              + '自分の判断で true にしてはいけません（リスナーの了承が必要です）' },
          },
          required: ['summary', 'start_datetime', 'end_datetime'],
        },
      },
      {
        name: 'update_calendar_event',
        description: 'リスナーのGoogleカレンダーの既存の予定を変更します。「〇〇の予定を〇時に変更して」'
          + '「場所を変えて」のように、予定の変更を明示的に依頼されたときに使います。event_idは必ず、'
          + '直前のget_calendarの結果に含まれる各予定の[id: ...]をそのまま使ってください（自分で'
          + '作文しないこと）。get_calendarをまだこの会話で呼んでいない場合は、先にget_calendarを'
          + '呼んで対象の予定のevent_idを確認してから実行してください。変更したい項目だけを指定すれば'
          + 'よく（指定しなかった項目は変更されません）、日時は正確なISO 8601形式（例: '
          + '2026-08-05T13:00:00+09:00）へ変換してください。同じ名前の予定が複数見つかった場合は、'
          + '実行前にどちらの予定か確認してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            event_id: { type: 'STRING', description: '変更対象の予定のID（get_calendarの[id: ...]をそのまま使う）' },
            summary: { type: 'STRING', description: '新しい件名（変更する場合のみ）' },
            start_datetime: { type: 'STRING', description: '新しい開始日時（ISO 8601、日本時間、変更する場合のみ）' },
            end_datetime: { type: 'STRING', description: '新しい終了日時（ISO 8601、日本時間、変更する場合のみ）' },
            location: { type: 'STRING', description: '新しい場所（変更する場合のみ）' },
            description: { type: 'STRING', description: '新しい詳細メモ（変更する場合のみ）' },
          },
          required: ['event_id'],
        },
      },
      {
        name: 'delete_calendar_event',
        description: 'リスナーのGoogleカレンダーから既存の予定を削除します。「〇〇の予定をキャンセルして」'
          + '「その予定は無くなったので消して」のように、予定の削除を明示的に依頼されたときに使います。'
          + 'event_idは必ず、直前のget_calendarの結果に含まれる各予定の[id: ...]をそのまま使ってください'
          + '（自分で作文しないこと）。get_calendarをまだこの会話で呼んでいない場合は、先にget_calendarを'
          + '呼んで対象の予定のevent_idを確認してから実行してください。同じ名前の予定が複数見つかった'
          + '場合は、実行前にどちらの予定か確認してください。取り消せない操作のため、対象の予定（件名・'
          + '日時）を一言確認してから呼び出してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            event_id: { type: 'STRING', description: '削除対象の予定のID（get_calendarの[id: ...]をそのまま使う）' },
          },
          required: ['event_id'],
        },
      },
      {
        name: 'get_emails',
        // いつ呼ぶか（発動の条件）を宣言に書く（Gemini Live の推奨のやり方）。このツールは呼び漏れが
        // 一番多かった
        description: 'リスナーのGmailから、直近24時間の新着未読メール（件名・送信者・概要）を取得します。'
          + '\n\n【発動条件】リスナーが「メールをチェックして」「メールをまとめて」「メール見て」など、'
          + 'メールの確認を求める発言をしたら、必ずこの機能を呼び出してください。'
          + '聞き返して確認する必要はありません（対象は常に直近24時間の未読メールで、引数もありません）。'
          + 'メールの内容を推測で答えたり、以前の会話で得た内容を使い回したりすることは絶対にしないでください'
          + '——この機能を呼ばない限り、あなたは現在の受信箱の状態を一切知りません。'
          + '\n\n【force_refreshについて】通常は指定不要です。この機能は未読メールの顔ぶれが'
          + '前回から変わっていなければ、前回の結果を即座に返して待ち時間を減らします'
          + '（内容が同一であることは保証されています）。'
          + 'リスナーが「新しくチェックして」「もう一度取り直して」のように、あえて取り直すことを'
          + '求めた場合にだけ true を指定してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            force_refresh: {
              type: 'BOOLEAN',
              description: 'true にすると前回の結果を使わず必ず取り直す。'
                + 'リスナーが明示的に取り直しを求めたときだけ指定する。',
            },
          },
        },
      },
      {
        name: 'create_email_draft',
        description: 'Gmailに返信・新規メールの下書きを作成します（送信はしません。送信は必ずリスナー本人がGmail上で行います）。'
          + '「このメールに返信の下書きを作って」のように依頼されたときに使います。get_emailsが返す返信案（reply_draft）を'
          + 'そのまま使うか、リスナーの指示に合わせて書き直してください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            to: { type: 'STRING', description: '宛先メールアドレス' },
            subject: { type: 'STRING', description: '件名' },
            body: { type: 'STRING', description: '本文' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      {
        name: 'get_tasks',
        description: 'リスナーのGoogle Tasksから、未完了のタスク一覧を取得します。',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'create_task',
        description: 'リスナーのGoogle Tasksに新しいタスクを追加します。「買い物リストにタスクを追加して」のように依頼されたときに使います。',
        parameters: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING', description: 'タスクの内容' },
            notes: { type: 'STRING', description: '補足メモ（任意）' },
            due_date: { type: 'STRING', description: '期限（YYYY-MM-DD、任意）' },
          },
          required: ['title'],
        },
      },
      {
        name: 'create_drive_file',
        description: 'リスナーのGoogle Driveに新しいテキストファイルを作成します（プレーンテキストのみ対応）。'
          + '「議事録をドライブに保存して」「レシピをファイルにして」のように、会話内容をファイルとして'
          + '残すよう依頼されたときに使います。',
        parameters: {
          type: 'OBJECT',
          properties: {
            file_name: { type: 'STRING', description: 'ファイル名（例: 会議メモ_2026-08-05.txt）' },
            content: { type: 'STRING', description: 'ファイルの内容' },
          },
          required: ['file_name', 'content'],
        },
      },
      {
        // ATTENTION: この一覧は設定を受け取らない静的な宣言。説明文にリスナーやエージェントの名前を
        // 書かないこと（名前は管理画面で変えられる）。名前が要る説明は、設定を受け取る
        // secretary-tool-declarations.js 側で組み立てる。
        name: 'update_drive_file',
        description: 'create_drive_fileでSecretaryが以前作成したGoogle Driveのファイルへ追記、または内容を'
          + '置き換えます。リスナーご自身が別途作成した既存ファイルは対象にできません（Secretaryが作成した'
          + 'ファイルのみ）。ファイルが見つからない場合はエラーになるので、その場合は正直にその旨を伝えてください。',
        parameters: {
          type: 'OBJECT',
          properties: {
            file_name: { type: 'STRING', description: '対象ファイル名（create_drive_fileで作成したときと同じ名前）' },
            content: { type: 'STRING', description: '追記または置き換える内容' },
            mode: { type: 'STRING', description: 'append=末尾に追記、replace=全文を置き換え', enum: ['append', 'replace'] },
          },
          required: ['file_name', 'content', 'mode'],
        },
      },
];

// ── メールの仕分けの覚え ─────────────────────────────────────────────
//
// メールの本文の取得と仕分け（LLM）は合わせて10秒ほどかかるが、未読の ID の一覧だけなら1秒かからない。
// そこで仕分けたメールを ID ごとに覚えておき、次は ID を突き合わせて
//   ・消えたもの（既読になったなど） … 捨てる
//   ・覚えているもの                 … 取り出しも仕分けもせず、そのまま使う
//   ・新しいもの                     … これだけ取り出して仕分ける
// とする。
//
// ATTENTION: 時間で期限を切る覚え方にしない。その間に届いたメールを見落とし、「メールは来ていない」と
// 答えてしまう。ID で突き合わせる限り、取りこぼしは起きない。
// ATTENTION: 仕分けに失敗した分（優先度が「不明」）は覚えないこと。覚えると、取り直しを
// はっきり求められるまで仕分け直されず、「不明」のまま残り続ける。
const _emailCache = {
  byId: new Map(),   // メールの ID → 仕分けたメール
  excluded: null,    // フィルターで除いた件数（軽い一覧の API で取れるので毎回取り直す）
};

/**
 * 未読メールの仕分けを最新にして返す（新しく届いた分だけを仕分ける。上の _emailCache 参照）。
 * get_emails ツールと、秘書のループの先回りの仕分け（secretary-loop.js）の両方から呼ぶ。
 *
 * @param {{config:object, creds:object, activitySessionId:number|null}} ctx
 * @param {{forceRefresh?:boolean, reason?:string}} [opts]
 *   forceRefresh: 覚えを使わず全部取り直す（リスナーがはっきり求めたとき）
 *   reason: ログに出す、呼び出し元の説明
 * @returns {Promise<{result:string, emails:object[], error?:string}>}
 */
async function refreshEmailTriage(ctx, { forceRefresh = false, reason = '会話' } = {}) {
  const { config, creds, activitySessionId } = ctx;
  const filter = config.show?.gmail_filter || {};
  const _t0 = Date.now();

  let ids;
  try {
    // 未読の ID の一覧だけを取る軽い呼び出し（秘書のループが5分ごとに使っているのと同じもの）
    ids = await googleService.fetchUnreadIds(creds, { filter });
  } catch (e) {
    getLogger().warn(`[Secretary] get_emails: 未読IDの取得に失敗: ${e.message}`);
    return { error: 'メールの確認に失敗しました。時間をおいて再度お試しください。' };
  }

  if (forceRefresh) _emailCache.byId.clear();

  // 今も未読のものだけを残し、消えたもの（既読になったなど）は捨てる
  const known = new Set(ids.filter((id) => _emailCache.byId.has(id)));
  const newIds = ids.filter((id) => !_emailCache.byId.has(id));
  for (const id of [..._emailCache.byId.keys()]) {
    if (!ids.includes(id)) _emailCache.byId.delete(id);
  }

  // 仕分けに失敗した分。この回の結果には含めるが覚えず、次の呼び出しで仕分け直させる
  // （覚えてしまうと「不明」のまま残り続ける。_emailCache のコメント参照）。
  const unresolved = new Map();
  let fetchMs = 0;
  let classifyMs = 0;
  if (newIds.length > 0) {
    const _tf = Date.now();
    const rawNew = await googleService.fetchEmailDetailsByIds(creds, newIds);
    fetchMs = Date.now() - _tf;
    const _tc = Date.now();
    const classified = await classifyEmails(rawNew, { creds, activitySessionId });
    classifyMs = Date.now() - _tc;
    for (const e of classified) {
      if (e.priority === '不明') unresolved.set(e.id, e);
      else _emailCache.byId.set(e.id, e);
    }
  }

  // 除いた件数は一覧の API を数回呼ぶだけなので、毎回取り直す（新着の有無にかかわらず正確に伝えたい）
  let excluded = _emailCache.excluded;
  try {
    excluded = await googleService.countExcludedEmails(creds, { filter });
    _emailCache.excluded = excluded;
  } catch { /* 取れなくても本体は返す */ }

  // Gmail が返した順（新しい順）に並べ直す
  const emails = ids.map((id) => _emailCache.byId.get(id) || unresolved.get(id)).filter(Boolean);
  const cap = filter.max_fetch || 15;
  getLogger().info(`[Secretary] get_emails内訳(${reason}): 全${ids.length}件`
    + `${ids.length >= cap ? `（上限${cap}に到達・取りこぼしの可能性あり）` : ''} = `
    + `再利用${known.size}件 + 新規${newIds.length}件, `
    + `除外=${excluded?.total ?? '?'}件${excluded && Object.keys(excluded.counts).length ? `（${Object.entries(excluded.counts).map(([k, v]) => `${k}${v}`).join('・')}）` : ''}, `
    + `新規取得=${fetchMs}ms, 新規分類=${classifyMs}ms, 合計=${Date.now() - _t0}ms`);

  const result = formatTriagedEmailsForSpeech(emails, excluded);
  secretaryStore.appendEntry('email-logs', {
    counts: EMAIL_PRIORITY_ORDER.reduce((acc, p) => { acc[p] = emails.filter(e => e.priority === p).length; return acc; }, {}),
    emails,
  });
  return { result, emails };
}

/** ツール名ごとの処理。引数は (args, ctx)。ctx には config・creds・activitySessionId などが入る。 */
const TOOL_HANDLERS = {
  get_calendar: async (args, ctx) => {
    const { creds } = ctx;
    const { from_date: fromDate, days } = args || {};
    // 範囲は1〜90日に収める（極端な指定で API を呼ばないため）
    const rangeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
    const events = await googleService.fetchCalendar(creds, { rangeDays, fromDate: fromDate || null });
    // BUGFIX: どの範囲を見たかを必ず添える。範囲の外を「予定なし」と答え、予定を二重に登録したことがある
    const label = fromDate ? `${fromDate}から${rangeDays}日間` : `本日から${rangeDays}日間`;
    const result = `【確認した範囲: ${label}】\n${formatCalendarForSpeech(events)}`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_calendar', result });
    return { result };
  },

  create_calendar_event: async (args, ctx) => {
    const { creds } = ctx;
    const { summary, start_datetime, end_datetime, location, description, confirmed_overlap } = args || {};

    // BUGFIX: 時間帯の重なりはコードで必ず確かめ、重なっていれば作らずにリスナーへ確かめさせる。
    // プロンプトの指示に任せていたころ、同じ時間帯に予定を二重に登録していた。
    // 重ねてよいとリスナーが了承したときだけ、confirmed_overlap=true で呼び直される
    if (!confirmed_overlap) {
      const overlapping = await googleService.findOverlappingEvents(creds, {
        startISO: start_datetime, endISO: end_datetime,
      });
      if (overlapping.length > 0) {
        const list = overlapping.map((e) => `「${e.summary}」（${e.when}）`).join('、');
        return {
          result: `その時間帯には既に${list}が入っています。予定は作成していません。`
            + 'リスナーへ「すでに予定が入っておりますが、いかがしますか」と確認してください。'
            + '重ねて登録してよいと言われた場合のみ、confirmed_overlap=true を付けてもう一度呼んでください。',
          needs_confirmation: true,
          overlapping: overlapping.map((e) => ({ summary: e.summary, when: e.when })),
        };
      }
    }

    await googleService.createCalendarEvent(creds, {
      summary, startISO: start_datetime, endISO: end_datetime, location, description,
    });
    const result = `予定「${summary}」を作成しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'create_calendar_event', result, summary, start_datetime, end_datetime });
    return { result };
  },

  update_calendar_event: async (args, ctx) => {
    const { creds } = ctx;
    const { event_id, summary, start_datetime, end_datetime, location, description } = args || {};
    await googleService.updateCalendarEvent(creds, {
      eventId: event_id, summary, startISO: start_datetime, endISO: end_datetime, location, description,
    });
    const result = summary ? `予定「${summary}」に変更しました。` : '予定を変更しました。';
    secretaryStore.appendEntry('daily-briefings', {
      tool: 'update_calendar_event', result, event_id, summary, start_datetime, end_datetime,
    });
    return { result };
  },

  delete_calendar_event: async (args, ctx) => {
    const { creds } = ctx;
    const { event_id } = args || {};
    await googleService.deleteCalendarEvent(creds, { eventId: event_id });
    const result = '予定を削除しました。';
    secretaryStore.appendEntry('daily-briefings', { tool: 'delete_calendar_event', result, event_id });
    return { result };
  },

  get_emails: async (args, ctx) => {
    const res = await refreshEmailTriage(ctx, { forceRefresh: !!args?.force_refresh });
    if (res.error) return { error: res.error };
    return { result: res.result, emails: res.emails };
  },

  create_email_draft: async (args, ctx) => {
    const { creds } = ctx;
    const { to, subject, body } = args || {};
    await googleService.createEmailDraft(creds, { to, subject, body });
    const result = `「${subject}」の下書きを作成しました。送信前にGmailでご確認ください。`;
    secretaryStore.appendEntry('email-logs', { tool: 'create_email_draft', result, to, subject });
    return { result };
  },

  get_tasks: async (args, ctx) => {
    const { creds } = ctx;
    const tasks = await googleService.fetchTasks(creds);
    const result = formatTasksForSpeech(tasks);
    secretaryStore.appendEntry('daily-briefings', { tool: 'get_tasks', result });
    return { result };
  },

  create_task: async (args, ctx) => {
    const { creds } = ctx;
    const { title, notes, due_date } = args || {};
    await googleService.createTask(creds, { title, notes, dueISO: due_date ? new Date(`${due_date}T00:00:00+09:00`).toISOString() : null });
    const result = `タスク「${title}」を追加しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'create_task', result, title });
    return { result };
  },

  create_drive_file: async (args, ctx) => {
    const { creds } = ctx;
    const { file_name, content } = args || {};
    const file = await googleService.createDriveFile(creds, { name: file_name, content });
    const result = `ファイル「${file_name}」をGoogle Driveに作成しました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'create_drive_file', result, file_name, fileId: file.id });
    return { result };
  },

  update_drive_file: async (args, ctx) => {
    const { creds } = ctx;
    const { file_name, content, mode } = args || {};
    await googleService.updateDriveFile(creds, { name: file_name, content, mode });
    const result = mode === 'append'
      ? `ファイル「${file_name}」に追記しました。`
      : `ファイル「${file_name}」の内容を置き換えました。`;
    secretaryStore.appendEntry('daily-briefings', { tool: 'update_drive_file', result, file_name, mode });
    return { result };
  },
};

// refreshEmailTriage は秘書のループの先回りの仕分け（secretary-loop.js）からも呼ぶので公開する
module.exports = { TOOL_HANDLERS, TOOL_DECLARATIONS, refreshEmailTriage };
