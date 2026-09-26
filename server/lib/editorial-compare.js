/**
 * @file 新聞各社の社説の見出しを読み比べ、論調の分かれ方（一社だけ突出・割れている）を見極める
 *
 * 目的は、一社だけ違う方向へ誘導していそうな箇所を拾うこと。全社が同じことを言っているなら取り上げない
 * （言い回しが違うだけのものも取り上げない）。見当たらない日は枠ごと省く。利用元は報道センター・コメンテーター
 * （agent-system.js）、討論コーナー（agent-discussion-corner.js）、ディレクターの材料（topical-materials.js）。
 *
 * 一般の記事の見出しはどの社も事実を淡々と書くので差が出ないが、社説の見出しは主張そのものなので、同じ出来事への
 * 評価が正面から割れる。
 *
 * ATTENTION: 社説の本文は取りに行かない。各社とも robots.txt で AI 系のクローラを拒否しており、その拒否を
 *            回避してまで取得しない。見出しだけで足りる。
 * ATTENTION: 返すのは「見出しのどの言葉からそう読めるか」まで。媒体そのものへの評価（偏っている・信用できない）は
 *            生成させず、放送の側の指示でも禁じる。
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

const { getLogger } = require('../logger');
const { generateText } = require('./llm-client');

// 同じ候補について報道センターとコメンテーターが続けて呼ぶので、判定を使い回す
// （media-compare-service のまとまり自体も30分キャッシュされる）
const CACHE_TTL_MS = 30 * 60 * 1000;
let _cache = { key: '', at: 0, result: null };

/**
 * キャッシュのキー（候補の見出しをつないだもの）。
 * @param {Array<Record<string, any>>} clusters
 * @returns {string}
 */
function _signature(clusters) {
  return clusters.map((c) => c.headlines.map((h) => `${h.outlet}:${h.title}`).join('|')).join('||');
}

/**
 * 社説の見出しから、論調の分かれ方を見極める。
 * @param {{ clusters: Array<Record<string, any>>, apiKey: string, activitySessionId?: any }} opts
 *   clusters は同じ話題ごとにまとめた社説の見出し（media-compare-service の fetchEditorialClusters）
 * @returns {Promise<{index:number, topic:string, pattern:string, groups:string, standout:string,
 *                    observation:string}|null>} 該当が無ければ null（それが普通の結果）
 */
async function judgeEditorials({ clusters, apiKey, activitySessionId = null }) {
  const listed = clusters.map((c, i) => {
    const lines = c.headlines.map((h) => `    ・${h.outlet}: 「${h.title}」`).join('\n');
    return `【候補${i + 1}】\n${lines}`;
  }).join('\n\n');

  const systemInstruction = 'あなたは新聞各社の社説を読み比べる編集者です。社説は事実の報道ではなく'
    + '**各社の主張**です。同じ出来事について各社がどちらを向いているかを、見出しの言葉から見極めます。'
    + '主張が実際に割れているときだけ取り上げ、全社が同じ方向を向いているなら「なし」と答えてください。';

  const prompt = `以下は、同じ日に各社が掲げた社説の見出しです。話題ごとにまとめてあります。

${listed}

【選ぶ基準】次のどちらかに当てはまる候補を、最大1件だけ選んでください。
- **一社だけ突出**: 1社だけが他社と違う方向を向いている（他社が問題視していることを評価する、
  他社が触れない論点にすり替える、責任の所在を別の相手に向ける など）
- **論調が割れている**: 各社が2つ以上の立場に分かれ、同じ出来事への評価が正反対になっている

【選ばない基準】
- 全社が同じ方向の主張をしている（言い回しが違うだけ）。**これが普通です。無理に差を探さないでください**
- 見出しが短すぎる・抽象的すぎて、どちらを向いているか読み取れない
- 同じ出来事についての社説が揃っていない（話題がばらばら）

【書き方の注意】
- 媒体そのものへの評価（偏っている・信用できない）は書かないでください。
- 見出しに実際に現れている言葉から言えることだけを書いてください。

【出力】該当が無ければ found を false にしてください。それが正常な結果です。
以下のJSON形式のみで出力してください:
{
  "found": true または false,
  "cluster_index": 候補の番号（1から始まる整数）,
  "topic": "何についての社説かを15字以内で",
  "pattern": "一社だけ突出" または "論調が割れている",
  "groups": "どの社がどういう立場かを1〜2文で（社名と見出しの言葉を挙げる）",
  "standout": "特に方向が違う社があればその社名。無ければ空文字",
  "observation": "見出しのどの言葉からそう読めるのかを1文で"
}`;

  const { text } = await generateText({
    tier: 'secretary_light',
    apiKey,
    systemInstruction,
    prompt,
    temperature: 0,
    json: true,
    thinkingBudget: 0,
    agentKey: 'editorial_compare',
    activitySessionId,
    logMeta: { purpose: 'editorial_compare' },
  });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    getLogger().warn(`[Editorial] 判定のJSON解析に失敗（読み比べは省略）: ${e.message}`);
    return null;
  }
  if (parsed.found !== true) return null;
  const index = Number.isInteger(parsed.cluster_index) ? parsed.cluster_index - 1 : -1;
  if (index < 0 || index >= clusters.length) return null;
  const groups = String(parsed.groups || '').trim();
  if (!groups) return null;
  return {
    index,
    topic: String(parsed.topic || '').trim(),
    pattern: String(parsed.pattern || '').trim(),
    groups,
    standout: String(parsed.standout || '').trim(),
    observation: String(parsed.observation || '').trim(),
  };
}

/**
 * 論調の違いを見極め、放送のプロンプトへ差し込むブロックと一緒に返す（30分キャッシュ）。
 *
 * @param {{ clusters: Array<Record<string, any>>, apiKey: string, activitySessionId?: any }} opts
 * @returns {Promise<{finding: Record<string, any>, cluster: Record<string, any>, block: string}|null>}
 *   違いが無い・失敗したときは null（呼び出し側は読み比べの枠ごと省く）
 */
async function screenEditorials({ clusters, apiKey, activitySessionId = null }) {
  if (!Array.isArray(clusters) || clusters.length === 0 || !apiKey) return null;
  const key = _signature(clusters);
  if (_cache.key === key && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.result;

  let finding = null;
  try {
    finding = await judgeEditorials({ clusters, apiKey, activitySessionId });
  } catch (e) {
    getLogger().warn(`[Editorial] 見極めに失敗（読み比べは省略）: ${e.message}`);
    _cache = { key, at: Date.now(), result: null };
    return null;
  }
  if (!finding) {
    getLogger().info(`[Editorial] ${clusters.length}件の候補に、論調の違いは見当たりませんでした（読み比べは省略）`);
    _cache = { key, at: Date.now(), result: null };
    return null;
  }

  const cluster = clusters[finding.index];
  const lines = cluster.headlines.map((h) => `    ・${h.outlet}: 「${h.title}」`).join('\n');
  const block = `
【各社の社説の見出し（同じ話題・実際に掲載されたものをそのまま引用）】
  ${finding.topic ? `話題: ${finding.topic}\n` : ''}${lines}

【論調の分かれ方】
  ・${finding.pattern || '違いあり'}
  ・${finding.groups}
${finding.standout ? `  ・特に方向が違うのは「${finding.standout}」です\n` : ''}${finding.observation ? `  ・${finding.observation}\n` : ''}`;

  getLogger().info(`[Editorial] ${finding.topic || '話題不明'}: ${finding.pattern}`
    + `${finding.standout ? `（突出: ${finding.standout}）` : ''}`);
  const result = { finding, cluster, block };
  _cache = { key, at: Date.now(), result };
  return result;
}

/**
 * 報道センター・コメンテーター向けのブロックだけを返す。
 * @param {{ clusters: Array<Record<string, any>>, apiKey: string, activitySessionId?: any }} opts
 * @returns {Promise<string>} 該当が無ければ空文字（読み比べの枠ごと省く）
 */
async function buildEditorialCompareBlock(opts) {
  const res = await screenEditorials(opts);
  return res ? res.block : '';
}

/**
 * 過去の社説の候補から、今日と同じ話題のものだけを選ぶ。
 *
 * BUGFIX: 同じ話題かどうかはモデルに判断させる。語の一致で絞ると、「知事」のように話題を特定しない語で
 *         別の県の話が混ざり、条件をきつくすると関係のあるものが落ちた。取得と整形はコード、判断はモデル。
 * 失敗したら候補をそのまま返す（放送は止めない。多少混ざるより、材料が空になる方が惜しい）。
 *
 * @param {{topic: string, todayHeadlines: Array<{outlet: string, title: string}>,
 *          past: Array<{outlet: string, items: Array<{title: string, date: string}>}>,
 *          apiKey: string, activitySessionId?: any}} opts
 * @returns {Promise<Array<{outlet: string, items: Array<{title: string, date: string}>}>>} 同じ話題が無ければ空
 */
async function filterPastEditorialsByTopic({ topic, todayHeadlines, past, apiKey, activitySessionId = null }) {
  const flat = [];
  for (const p of past) for (const i of p.items) flat.push({ outlet: p.outlet, ...i });
  if (flat.length === 0 || !apiKey) return past;

  const listed = flat.map((f, i) => `${i + 1}. ${f.outlet}（${f.date}）「${f.title}」`).join('\n');
  const today = todayHeadlines.map((h) => `  ・${h.outlet}: 「${h.title}」`).join('\n');
  const prompt = `今日、各社が次の話題について社説を掲げました。

【話題】${topic}
【今日の社説】
${today}

以下は、同じ各社が最近書いた社説の候補です。この中から、**今日と同じ話題（同じ出来事・同じ論点）を
扱っているもの**だけを選んでください。似た言葉が入っているだけで別の出来事を扱っているものは
選ばないでください（例: 「沖縄県知事選」に対する「三重県知事の国籍要件」は別の話題です）。
同じテーマの経緯・前段にあたるもの（例: 同じ法案・同じ選挙・同じ制度についての以前の社説）は
選んで構いません。

${listed}

該当する番号だけをJSONで返してください。1つも無ければ空配列にしてください。
{ "keep": [番号, ...] }`;

  try {
    const { text } = await generateText({
      tier: 'secretary_light',
      apiKey,
      systemInstruction: '社説の見出しを見比べ、同じ話題を扱っているものだけを選ぶ仕事です。'
        + '関係の薄いものを混ぜないでください。',
      prompt,
      temperature: 0,
      json: true,
      thinkingBudget: 0,
      agentKey: 'editorial_compare',
      activitySessionId,
      logMeta: { purpose: 'editorial_past_filter' },
    });
    const parsed = JSON.parse(text);
    const keep = new Set((Array.isArray(parsed.keep) ? parsed.keep : [])
      .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= flat.length));
    if (keep.size === 0) {
      getLogger().info('[Editorial] 過去の社説はいずれも別の話題でした（今日の見出しだけで議論します）');
      return [];
    }
    const byOutlet = new Map();
    flat.forEach((f, i) => {
      if (!keep.has(i + 1)) return;
      if (!byOutlet.has(f.outlet)) byOutlet.set(f.outlet, []);
      byOutlet.get(f.outlet).push({ title: f.title, date: f.date });
    });
    const out = [...byOutlet.entries()].map(([outlet, items]) => ({ outlet, items }));
    getLogger().info(`[Editorial] 過去の社説 ${flat.length}本 → 同じ話題は ${keep.size}本`);
    return out;
  } catch (e) {
    getLogger().warn(`[Editorial] 過去の社説の絞り込みに失敗（候補のまま使います）: ${e.message}`);
    return past;
  }
}

/**
 * 討論コーナー（ディープダイブ）へ渡す材料を組み立てる。
 *
 * 各社の報道をなぞって終わらず、各社がなぜ違う書き方をするのかを掘れるよう、今日の見出しと論調の割れ方に
 * 加えて、各社が同じテーマで過去に何を書いてきたかを並べる。一貫した立場が見えれば、「今日たまたま」ではなく
 * 「その社の姿勢」として論じられる。本文は読んでいないので、見出しから言えることに限ると明記する。
 *
 * @param {{finding: Record<string, any>, cluster: Record<string, any>}|null} screened screenEditorials の戻り値
 * @param {Array<{outlet: string, items: Array<{title: string, date: string}>}>} [past] 過去の社説
 * @returns {string} screened が無ければ空文字
 */
function buildEditorialDeepDiveMaterial(screened, past = []) {
  if (!screened) return '';
  const { finding, cluster } = screened;
  const today = cluster.headlines.map((h) => `  ・${h.outlet}: 「${h.title}」`).join('\n');

  const pastByOutlet = new Map(past.map((p) => [p.outlet, p.items]));
  const pastLines = [];
  for (const h of cluster.headlines) {
    const items = (pastByOutlet.get(h.outlet) || []).filter((i) => i.title !== h.title);
    if (items.length === 0) continue;
    pastLines.push(`  ・${h.outlet}: ${items.map((i) => `${i.date}「${i.title}」`).join(' ／ ')}`);
  }
  const missing = cluster.headlines
    .filter((h) => !(pastByOutlet.get(h.outlet) || []).some((i) => i.title !== h.title))
    .map((h) => h.outlet);

  return `▼ 各社の社説（見出しのみ。本文は取得していません）
■ 今日の社説
${today}

■ 論調の分かれ方
  ・${finding.pattern || '違いあり'}
  ・${finding.groups}
${finding.standout ? `  ・特に方向が違うのは「${finding.standout}」です\n` : ''}${finding.observation ? `  ・${finding.observation}\n` : ''}
${pastLines.length > 0 ? `■ 各社がこのテーマで最近書いてきた社説（直近180日・見出しのみ）
${pastLines.join('\n')}
${missing.length > 0 ? `  （過去の社説が見つからなかった社: ${missing.join('・')}）\n` : ''}` : '■ 各社の過去の社説は見つかりませんでした（このテーマを継続的に論じている社が少ないか、単発の出来事です）\n'}
⚠️ 社説の**本文は読んでいません**。見出しに現れている言葉と、上の並びから言えることに限って論じてください。
各社の主張の背景を語るときも、「この社は◯◯寄りだ」というレッテルではなく、見出しが示す立場と
これまでの書きぶりから言えることに留めてください。`;
}

/**
 * 試験用に、キャッシュを空にする。
 */
function _clearCache() { _cache = { key: '', at: 0, result: null }; }

module.exports = {
  buildEditorialCompareBlock, screenEditorials, judgeEditorials,
  buildEditorialDeepDiveMaterial, filterPastEditorialsByTopic, _clearCache,
};
