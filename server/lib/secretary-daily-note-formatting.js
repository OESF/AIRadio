/**
 * @file Obsidian のデイリーノートに載せる天気・ニュース・金融の情報の整形
 *
 * 日報（create_daily_report、secretary-tools-reports.js の createDailyReport）が、各サービスの生のテキストを
 * デイリーノートで読みやすい Markdown（箇条書き・表・Mermaid のグラフ・コールアウト）にするための道具。
 * 外部との通信は無く、文字列の整形だけを行う。
 *
 * ATTENTION: 見出し・リンク・数値のように1文字も変えてはいけないデータ（ニュース・地震・台風・時間帯別の予報）は、
 * LLM に通さずここで決定的に組み立てる。LLM に任せると行が分かれたり重なったり、無い値を作ったりした。
 * 形の揺れが大きい残り（警報を除く天気の文など）だけを、secretary-tools-reports.js の
 * _formatDailyReportSectionsWithGemini が軽量モデルで整える（数値・固有名詞は変えさせず、失敗したら元の文に戻す）。
 *
 * ATTENTION: Obsidian の表は、直前に必ず空行を1行入れること（無いと直前の段落の続きとみなされ、表として
 * 描かれない）。表の途中には空行を入れないこと。
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

/**
 * newsService.fetch() が返す「1. [label] title」と「概要: desc」の形の文を、デイリーノート用の箇条書きにする。
 * 想定外の形で変換できなければ、元の文をそのまま返す。
 *
 * @param {string} rawNewsText ニュースの文
 * @returns {string} Markdown の箇条書き
 */
function formatNewsForDailyNote(rawNewsText) {
  const lines = (rawNewsText || '').split('\n');
  const out = [];
  for (const line of lines) {
    const headline = line.match(/^\d+\.\s*\[(.+?)\]\s*(.+)$/);
    if (headline) {
      out.push(`- **[${headline[1]}]** ${headline[2]}`);
    } else if (line.trim().startsWith('概要:')) {
      out.push(`  - ${line.trim().replace(/^概要:\s*/, '')}`);
    }
  }
  return out.length > 0 ? out.join('\n') : rawNewsText;
}

/**
 * ニュースの項目（newsService.cache.detailedItems）から、リンク付きの箇条書きを組み立てる。
 *
 * BUGFIX: 見出しだけでは元の記事をたどれず内容が分からなかったので、リンクと説明文を付ける。
 * 見出しとリンクは変えてはいけないので、LLM を通さずここで組み立てる。
 *
 * @param {Array<Record<string, any>>} items ニュースの項目（title・desc・link・label）
 * @returns {string|null} Markdown（項目が無ければ null）
 */
function _buildNewsMarkdown(items) {
  if (!items || items.length === 0) return null;
  const lines = [];
  for (const item of items) {
    const headline = item.link ? `[${item.title}](${item.link})` : item.title;
    // 「トップ」はフィードの名前で分類としての意味が無く紛らわしいので、表示しない（国内・国際・経済・IT は出す）
    const labelPart = item.label && item.label !== 'トップ' ? `**[${item.label}]** ` : '';
    lines.push(`- ${labelPart}${headline}`);
    if (item.desc) lines.push(`  - ${item.desc}`);
  }
  return lines.join('\n');
}

/**
 * 経済・マーケットのニュース（financeService.cache.businessNewsItems など）から、リンク付きの箇条書きを
 * 組み立てる（_buildNewsMarkdown と同じ理由で LLM を通さない）。
 *
 * @param {Array<Record<string, any>>} items ニュースの項目（title・link・desc・source）
 * @param {string} [heading] 見出し（既定 '### 経済・マーケットニュース'）
 * @returns {string|null} Markdown（項目が無ければ null）
 */
function _buildBusinessNewsMarkdown(items, heading = '### 経済・マーケットニュース') {
  if (!items || items.length === 0) return null;
  const lines = [heading];
  for (const item of items) {
    const label = item.source ? `${item.title}（${item.source}）` : item.title;
    lines.push(item.link ? `- [${label}](${item.link})` : `- ${label}`);
    // 題名だけでは内容が分からないので、説明文があれば添える
    if (item.desc) lines.push(`  - ${item.desc}`);
  }
  return lines.join('\n');
}

/**
 * 金融の文から「■ 経済・マーケットニュース」の欄を取り除く（_buildBusinessNewsMarkdown でリンク付きに
 * 組み立て直して後ろに付けるので、LLM には渡さない）。
 *
 * @param {string} financeText 金融の文
 * @returns {string} 取り除いた文
 */
function _extractBusinessNewsSectionFromFinanceText(financeText) {
  if (!financeText) return financeText;
  const marker = '■ 経済・マーケットニュース';
  const idx = financeText.indexOf(marker);
  if (idx === -1) return financeText;
  const afterMarker = financeText.slice(idx);
  const nextMatch = afterMarker.slice(1).search(/\n\n|\n■/);
  const blockEnd = nextMatch === -1 ? financeText.length : idx + 1 + nextMatch;
  return (financeText.slice(0, idx) + financeText.slice(blockEnd)).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 金融の文から、LLM 向けの注意書き【この前日比を必ずそのまま使うこと・自分で計算禁止】を取り除く。
 * 人が読むノートには邪魔なので、デイリーノートの経路でだけ消す（financeService の文そのものは
 * 放送が使うので変えない）。
 *
 * @param {string} rawFinanceText 金融の文
 * @returns {string} 整えた文
 */
function formatFinanceForDailyNote(rawFinanceText) {
  return (rawFinanceText || '')
    .replace(/【この前日比を必ずそのまま使うこと・自分で計算禁止】/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]+$/, '');
}

/**
 * 文の中から「【見出し】」で始まる欄を1つ抜き出す（地震・予報・警報などに共通）。
 * 欄の終わりは、次の空行か次の【の手前。
 *
 * @param {string} text 天気の文
 * @param {string} markerPrefix 欄の見出しの書き出し（例: 【🔴 地震情報）
 * @returns {{block: string|null, remainingText: string}} 抜き出した欄と、残りの文
 */
function _extractBracketedBlock(text, markerPrefix) {
  if (!text) return { block: null, remainingText: text };
  const idx = text.indexOf(markerPrefix);
  if (idx === -1) return { block: null, remainingText: text };
  const afterMarker = text.slice(idx);
  const nextMatch = afterMarker.slice(1).search(/\n\n|\n【/);
  const blockEnd = nextMatch === -1 ? text.length : idx + 1 + nextMatch;
  const block = text.slice(idx, blockEnd);
  const remainingText = (text.slice(0, idx) + text.slice(blockEnd)).replace(/\n{3,}/g, '\n\n').trim();
  return { block, remainingText };
}

/**
 * 地震情報の1行（weather-service.js の「日時 震源 M規模 最大震度X」の形）を分ける。
 * 震源に空白や読点が入りうるので、先頭から split せず、末尾から最大震度・規模の順に剥がして残りを震源にする。
 *
 * @param {string} line 地震情報の1行
 * @returns {{at: string, hypo: string, mag: string, maxi: string}|null} 日時・震源・規模・最大震度（形が違えば null）
 */
function _parseQuakeLine(line) {
  const atMatch = line.match(/^(\d{1,2}\/\d{1,2} \d{1,2}:\d{2}) (.+)$/);
  if (!atMatch) return null;
  const at = atMatch[1];
  let rest = atMatch[2];
  let maxi = null;
  const maxiMatch = rest.match(/ 最大震度(\S+)$/);
  if (maxiMatch) {
    maxi = maxiMatch[1];
    rest = rest.slice(0, maxiMatch.index);
  }
  let mag = null;
  const magMatch = rest.match(/ (M[\d.]+)$/);
  if (magMatch) {
    mag = magMatch[1];
    rest = rest.slice(0, magMatch.index);
  }
  return { at, hypo: rest.trim() || '震源不明', mag: mag || '-', maxi: maxi || '-' };
}

/**
 * 気温の棒グラフ（Mermaid の xychart-beta）を組み立てる（2点未満なら意味が無いので null）。
 * 本日と明日の気温の推移のグラフが共用している。
 *
 * ATTENTION: ラベルは日本語を含むので引用符で囲むこと（囲まないと Mermaid が読めずエラーになる）。
 * showDataLabel（棒の中の数値）は themeVariables ではなく xyChart の直下に置くこと。
 * BUGFIX: 棒の色は明るい青（#9ec5f4）にする。Mermaid は棒の中の数値を黒で描き、色を変えられないので、
 * 濃い色の棒では数値が読めなかった。
 *
 * @param {string} title グラフの題名
 * @param {Array<{label: string, temp: number}>} points 時刻のラベルと気温
 * @returns {string|null} Mermaid のコードブロック（2点未満なら null）
 */
function _buildTempLineChart(title, points) {
  if (!points || points.length < 2) return null;
  const labels = points.map(p => `"${p.label}"`).join(', ');
  const temps = points.map(p => p.temp);
  const yMin = Math.floor((Math.min(...temps) - 2) / 5) * 5;
  const yMax = Math.ceil((Math.max(...temps) + 2) / 5) * 5;
  return [
    '```mermaid',
    '%%{init: {"xyChart": {"showDataLabel": true}, "themeVariables": {"xyChart": {"plotColorPalette": "#9ec5f4"}}}}%%',
    'xychart-beta',
    `    title "${title}"`,
    `    x-axis [${labels}]`,
    `    y-axis "気温(C)" ${yMin} --> ${yMax}`,
    `    bar [${temps.join(', ')}]`,
    '```',
  ].join('\n');
}

/**
 * 時間帯別の予報の表で、天気の説明文に付ける絵文字の規則（上から順に当てる）。
 *
 * 説明文は OpenWeatherMap（lang=ja）や気象庁の週間予報の日本語で、「小雨を伴う雷雨」のように語を組み合わせた
 * 表現が多いので、完全一致ではなくキーワードの優先順で当てる。
 * ATTENTION: 順番に意味があるので入れ替えないこと。
 * - 「雷」は雨や雪と一緒に書かれることが多いので最優先
 * - 「霧雨」は「霧」より先に判定しないと霧の絵文字になる
 * - 「曇りがち」「薄い雲」は、広い「雲|曇」より先に判定する
 * どれにも当たらなければ絵文字を付けない（知らない表現に誤った絵文字を付けるより安全）。
 */
const _WEATHER_EMOJI_RULES = [
  [/竜巻/,                    '🌪️'],
  // OpenWeatherMap の日本語訳は一部がカタカナのまま（例: ライトサンダーストーム）なので、漢字だけでは拾えない
  [/雷|サンダーストーム/,        '⛈️'],
  [/みぞれ|雨と雪/,            '🌨️'],
  [/雪/,                      '❄️'],
  [/霧雨|にわか雨|小雨/,       '🌦️'],
  [/雨/,                      '🌧️'],
  [/砂|埃|灰|煙|もや|靄|霧|霞/, '🌫️'],
  [/晴/,                      '☀️'],
  [/薄い雲/,                  '🌤️'],
  [/曇りがち/,                '⛅'],
  // 気象庁の週間予報の天気（weather-service.js の _weatherCodeCategory）は「くもり」とひらがなで来るので、それも拾う
  [/雲|曇|くもり/,             '☁️'],
];

/**
 * 天気の説明文に合う絵文字を返す（_WEATHER_EMOJI_RULES を上から順に当てる）。
 *
 * @param {string} desc 天気の説明文
 * @returns {any} 絵文字（文字列。当てはまらなければ空文字）
 */
function _weatherEmoji(desc) {
  if (!desc) return '';
  for (const [pattern, emoji] of _WEATHER_EMOJI_RULES) {
    if (pattern.test(desc)) return emoji;
  }
  return '';
}

/**
 * 時間帯別の予報の1行（「HH時: 天気 T℃ 降水確率P%」の形。実況の推移も同じ形）を分ける。
 *
 * @param {string} line 予報の1行
 * @returns {{hour: string, desc: string, temp: number, pop: string|null}|null} 時・天気・気温・降水確率（形が違えば null）
 */
function _parseForecastLine(line) {
  const m = line.match(/^\s*(\d{1,2})時: (.+?) (-?\d+)℃(?: 降水確率(\d+)%)?\s*$/);
  if (!m) return null;
  return { hour: m[1], desc: m[2], temp: parseInt(m[3], 10), pop: m[4] != null ? m[4] : null };
}

/**
 * 時間帯別の予報の欄を、行の一覧と要約の行（「最高◯℃・最低◯℃」。明日の予報にだけある）に分ける。
 *
 * @param {string} block 予報の欄（1行目は見出し）
 * @returns {{rows: Array<any>, summaryLine: string|null}} 予報の行と要約の行
 */
function _parseForecastBlock(block) {
  const bodyLines = block.split('\n').slice(1).filter(l => l.trim());
  let summaryLine = null;
  const dataLines = [];
  for (const l of bodyLines) {
    if (/^\s*最高/.test(l)) { summaryLine = l.trim(); continue; }
    dataLines.push(l);
  }
  const rows = dataLines.map(_parseForecastLine).filter(Boolean);
  return { rows, summaryLine };
}

/**
 * 時間帯別の予報の欄（今日の残り・明日・実況の推移）から、表と気温のグラフの Markdown を組み立てる。
 * 要約の行は表にせず、見出しのすぐ下に文として残す。
 *
 * @param {string} headingText 見出し
 * @param {string} chartTitle グラフの題名
 * @param {string|null} block 予報の欄
 * @returns {string|null} Markdown（行が無ければ null）
 */
function _buildForecastSection(headingText, chartTitle, block) {
  if (!block) return null;
  const { rows, summaryLine } = _parseForecastBlock(block);
  if (rows.length === 0) return null;

  const hasPop = rows.some(r => r.pop != null);
  const headParts = [headingText];
  if (summaryLine) headParts.push(summaryLine);
  const tableLines = [
    hasPop ? '| 時刻 | 天気 | 気温 | 降水確率 |' : '| 時刻 | 天気 | 気温 |',
    hasPop ? '|---|---|---|---|' : '|---|---|---|',
  ];
  for (const r of rows) {
    const emoji = _weatherEmoji(r.desc);
    // 絵文字は説明文の前に付ける（置き換えると「小雨」と「適度な雨」のように同じ絵文字になるものの区別が消える）
    const weather = emoji ? `${emoji} ${r.desc}` : r.desc;
    tableLines.push(hasPop
      ? `| ${r.hour}時 | ${weather} | ${r.temp}℃ | ${r.pop != null ? r.pop + '%' : '-'} |`
      : `| ${r.hour}時 | ${weather} | ${r.temp}℃ |`);
  }
  // BUGFIX: 見出しと表の間に空行を入れる。無いと Obsidian が表を直前の段落の続きとみなし、表として描かれない。
  const table = [headParts.join('\n'), tableLines.join('\n')].join('\n\n');
  const chart = _buildTempLineChart(chartTitle, rows.map(r => ({ label: `${r.hour}時`, temp: r.temp })));
  return chart ? `${table}\n\n${chart}` : table;
}

/**
 * 天気の文から指定した欄を抜き出し、表とグラフの Markdown にする。
 * headingText を省くと、欄の1行目の【...】をそのまま見出しにする（明日の予報は月日が変わるので、
 * 見出しを作らず元の表記を使う）。
 *
 * @param {string} text 天気の文
 * @param {string} markerPrefix 欄の見出しの書き出し
 * @param {{headingText?: string|null, chartTitle: string}} opts 見出しとグラフの題名
 * @returns {{sectionMd: string|null, remainingText: string}} Markdown と、残りの文
 */
function _extractForecastSectionDeterministic(text, markerPrefix, { headingText = null, chartTitle }) {
  const { block, remainingText } = _extractBracketedBlock(text, markerPrefix);
  if (!block) return { sectionMd: null, remainingText: text };
  const heading = headingText || `### ${block.split('\n')[0].replace(/^【|】$/g, '')}`;
  const sectionMd = _buildForecastSection(heading, chartTitle, block);
  return { sectionMd, remainingText };
}

/**
 * 天気の文から指定した予報の欄を抜き出し、Markdown にする前の行だけを返す。
 * 「本日の気温」で、実測（3時間おきの記録）と残りの時間帯の予報を1本の系列につなげてから
 * _buildTempLineChart を呼ぶために使う。
 *
 * @param {string} text 天気の文
 * @param {string} markerPrefix 欄の見出しの書き出し
 * @returns {{rows: Array<Record<string, any>>, summaryLine: string|null, remainingText: string}} 予報の行・要約の行・残りの文
 */
function _extractForecastRowsDeterministic(text, markerPrefix) {
  const { block, remainingText } = _extractBracketedBlock(text, markerPrefix);
  if (!block) return { rows: [], summaryLine: null, remainingText: text };
  const { rows, summaryLine } = _parseForecastBlock(block);
  return { rows, summaryLine, remainingText };
}

/**
 * 金融の文から「■ 日本国債利回り」の欄を取り除く（デイリーノートでは日次で見る必要が無いため）。
 * finance-service.js は変えないので、放送では引き続き使える。
 * 欄は「■ 見出し」から次の「■」か終わりまで（天気の【】の欄とは書き方が違うので専用に作ってある）。
 *
 * @param {string} financeText 金融の文
 * @returns {string} 取り除いた文
 */
function _stripJgbSection(financeText) {
  if (!financeText) return financeText;
  const marker = '■ 日本国債利回り';
  const idx = financeText.indexOf(marker);
  if (idx === -1) return financeText;
  const nextMarkerIdx = financeText.indexOf('\n■', idx + marker.length);
  const blockEnd = nextMarkerIdx === -1 ? financeText.length : nextMarkerIdx;
  return (financeText.slice(0, idx) + financeText.slice(blockEnd))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 天気の文から気象警報・注意報の欄を抜き出し、ノートの冒頭に置くコールアウトにする。
 *
 * ATTENTION: 警報は LLM に渡さず、ここで決定的に組み立てること。地域名・警報の種類は1文字も
 * 変えてはいけない（ファイルの冒頭の決まりと同じ）。
 *
 * 朝に読むノートなので、今まさに出ている警報は主役として最初に置く。出ていなければ何も作らない
 * （「警報はありません」という行は、毎朝ノートの先頭を占める割に情報が無いため）。
 *
 * @param {string} weatherText 天気の文
 * @returns {{warningMd: string|null, remainingText: string}} 警報の Markdown（無ければ null）と、残りの文
 */
function _extractWeatherWarningSection(weatherText) {
  const { block, remainingText } = _extractBracketedBlock(weatherText, '【⚠️ 気象警報・注意報');
  if (!block) return { warningMd: null, remainingText: weatherText };

  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const body = lines.slice(1); // 1行目は【⚠️ 気象警報・注意報…】の見出し
  if (body.length === 0) return { warningMd: null, remainingText };

  const md = ['> [!warning] 気象警報・注意報', ...body.map((l) => `> ${l}`)].join('\n');
  return { warningMd: md, remainingText };
}

/**
 * 天気の文から地震情報の欄を抜き出し、表にする（LLM には渡さない）。
 *
 * BUGFIX: 地震情報の表を LLM に作らせると、1つの地震が複数の行に分かれたり行が重なったりした。
 * 行の形は weather-service.js で厳密に決まっているので、ここで正規表現で読み、入力の1行が必ず出力の1行に
 * なるようにしている。
 *
 * @param {string} weatherText 天気の文
 * @returns {{quakeTable: string|null, remainingText: string}} 表の Markdown と、残りの文
 */
function _extractQuakeSectionDeterministic(weatherText) {
  const { block, remainingText } = _extractBracketedBlock(weatherText, '【🔴 地震情報');
  if (!block) return { quakeTable: null, remainingText: weatherText };

  const rows = block.split('\n').slice(1).filter(l => l.trim()).map(_parseQuakeLine).filter(Boolean);
  if (rows.length === 0) return { quakeTable: null, remainingText: weatherText };

  // 見出しの直後に空行を入れないと表として描かれない（_buildForecastSection 参照）
  const lines = [
    '### 地震情報',
    '',
    '| 日時 | 震源地 | 規模 | 最大震度 |',
    '|---|---|---|---|',
    ...rows.map(r => `| ${r.at} | ${r.hypo} | ${r.mag} | ${r.maxi} |`),
  ];
  return { quakeTable: lines.join('\n'), remainingText };
}

/**
 * 天気の文から台風情報の欄を抜き出し、台風ごとの箇条書きにする（LLM には渡さない）。
 *
 * 元の文は1つの台風が1行で、「／」で区切って位置・進路・暴風域・日本への影響が書いてある。
 * BUGFIX: 4列の表に押し込ませていたころは、日本への影響や進路の文が削られ、号数の無い熱帯低気圧に
 * 「台風NaN号」という無い文字列まで作られた。「／」の区切りをそのまま箇条書きにして情報を保つ。
 *
 * @param {string} weatherText 天気の文
 * @returns {{typhoonMd: string|null, remainingText: string}} Markdown と、残りの文
 */
function _extractTyphoonSectionDeterministic(weatherText) {
  const { block, remainingText } = _extractBracketedBlock(weatherText, '【🌀 台風情報】');
  if (!block) return { typhoonMd: null, remainingText: weatherText };

  const typhoonLines = block.split('\n').slice(1).filter((l) => l.trim());
  if (typhoonLines.length === 0) return { typhoonMd: null, remainingText };

  const items = typhoonLines.map((line) => {
    const segments = line.split('／').map((s) => s.trim()).filter(Boolean);
    const [title, ...rest] = segments;
    const bullets = rest.map((s) => `- ${s}`).join('\n');
    return bullets ? `**${title}**\n${bullets}` : `**${title}**`;
  });
  const typhoonMd = ['### 🌀 台風情報', ...items].join('\n\n');
  return { typhoonMd, remainingText };
}

/**
 * 天気の文から気象庁の公式予報の欄を抜き出し、今日と明日それぞれの Markdown にする。
 *
 * ATTENTION: デイリーノートは朝7時30分に作るので、「本日:」の予報こそ主役になる。以前は1日の終わりに
 * 作っていたため本日を捨てて明日だけ残していたが、朝に読むノートでは逆。weatherService の文そのものは
 * 放送と共通なので変えず、ここでデイリーノート用に切り分ける。
 *
 * @param {string} weatherText 天気の文
 * @returns {{todayMd: string|null, tomorrowMd: string|null, remainingText: string}}
 *   今日・明日それぞれの Markdown（無ければ null）と、残りの文
 */
function _extractOfficialForecastSectionDeterministic(weatherText) {
  const { block, remainingText } = _extractBracketedBlock(weatherText, '【気象庁の公式予報');
  if (!block) return { todayMd: null, tomorrowMd: null, remainingText: weatherText };

  const lines = block.split('\n');
  const areaMatch = lines[0].match(/（([^・]+)・(\d{1,2}:\d{2})発表）/);
  const areaLabel = areaMatch ? `（気象庁 ${areaMatch[1]}・${areaMatch[2]}発表）` : '';

  const todayLine = lines.find((l) => l.trim().startsWith('本日:'));
  const todayMd = todayLine
    ? [`### ☀️ 今日の天気予報${areaLabel}`, todayLine.trim().replace(/^本日:\s*/, '')].join('\n')
    : null;

  const tomorrowLine = lines.find((l) => l.trim().startsWith('明日:'));
  const popsLine = lines.find((l) => l.trim().startsWith('明日の降水確率:'));
  const tomorrowMd = tomorrowLine
    ? [
        `### 🔮 明日の天気予報${areaLabel}`,
        tomorrowLine.trim().replace(/^明日:\s*/, ''),
        popsLine ? popsLine.trim().replace(/^明日の降水確率:\s*/, '降水確率: ') : '',
      ].filter(Boolean).join('\n')
    : null;

  return { todayMd, tomorrowMd, remainingText };
}

/**
 * 天気の文から「◯◯の現在のお天気: ...」の1行を消す。デイリーノートは23:50に作るので、夜の一時点の
 * 様子にしかならず、1日をふり返るノートには要らない。
 *
 * ATTENTION: createDailyReport はこの行から本日の最高・最低の気温を読むので、読み取りはこの関数を呼ぶ
 * 前に済ませておくこと（消した後は読めない）。
 *
 * @param {string} weatherText 天気の文
 * @returns {string} 消した後の文
 */
function _stripCurrentWeatherLine(weatherText) {
  if (!weatherText) return weatherText;
  return weatherText
    .replace(/^.*の現在のお天気:.*$\n?/m, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  formatNewsForDailyNote,
  _buildNewsMarkdown,
  _buildBusinessNewsMarkdown,
  _extractBusinessNewsSectionFromFinanceText,
  formatFinanceForDailyNote,
  _extractQuakeSectionDeterministic,
  _extractTyphoonSectionDeterministic,
  _extractOfficialForecastSectionDeterministic,
  _extractForecastSectionDeterministic,
  _extractForecastRowsDeterministic,
  _extractWeatherWarningSection,
  _stripJgbSection,
  _stripCurrentWeatherLine,
  _buildTempLineChart,
  _weatherEmoji,
};
