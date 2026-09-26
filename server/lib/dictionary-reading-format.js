/**
 * @file 形態素解析の辞書（UniDic）で、読み上げ用に漢字の語をカタカナの読みに直す
 *
 * 管理画面の発音辞書（tts_dict.json）は1件ずつ登録が要り、同じ種類の誤読が色々な語で起きるので
 * 登録しきれない。そこで、名詞・形状詞のうち漢字を含む2文字以上の語だけを、辞書の読みに置き換える。
 * 全文をかなにしない理由は、Gemini TTS は普通の語の読みはもともと得意で、全部かなにすると自然さや
 * アクセントが崩れるため。問題が起きやすい語だけを直す、という手作業の辞書と同じ考え方にしている。
 *
 * 形態素解析は lindera-wasm（UniDic 内蔵）。最初に作る解析器（約700ms）を使い回すので、2回目以降は
 * 1ms 未満で終わる（以前使っていた sudachi は初回の読み込みに20秒前後、毎回150〜250ms かかった）。
 *
 * 分かっている限界:
 *   - 1文字の漢字（方・公・上・下など）は文脈で読みが変わり、辞書でも読み違えるので対象外
 *   - 動詞・形容詞は活用で読みの体系が変わることがあるので対象外
 *   - 既存の発音辞書30件で試すと、完全に一致したのは9件。大半は1文字が漢字のまま残る安全な部分変換
 *
 * ATTENTION: 発音辞書（tts_dict.json）より後に適用すること。先に適用すると、辞書に登録した語が
 *            （場合によっては誤った）読みに書き換わってから辞書を探すことになり、辞書が二度と当たらなくなる
 *            （例: 「通行止め」→「ツウコウトメ」になると、「通行止め」→「ツウコウドメ」の登録が効かない）。
 *
 * 主な利用元: lib/agent-shared-mixin.js（TTS の前の正規化）・server.js（起動時の warmUp）
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

/** すぐに止めるためのスイッチ。false にすると、文をそのまま返す。 */
const ENABLED = true;

/** 解析器（作るのに約700ms かかるので、プロセスで1回だけ作る）。 */
let _tokenizerPromise = null;

/**
 * 解析器を返す（初回だけ作る）。読み込みに失敗したら null を返し、以後この機能は働かない。
 * @returns {Promise<any|null>}
 */
async function _loadTokenizer() {
  if (!_tokenizerPromise) {
    _tokenizerPromise = (async () => {
      try {
        const { TokenizerBuilder } = require('lindera-wasm-unidic-nodejs');
        const builder = new TokenizerBuilder();
        builder.setDictionary('embedded://unidic');
        builder.setMode('normal');
        return builder.build();
      } catch (e) {
        getLogger().warn(`[DictionaryReading] lindera-wasmのロードに失敗、以後この機能は無効化: ${e.message}`);
        return null;
      }
    })();
  }
  return _tokenizerPromise;
}

/**
 * 読みを直す品詞（UniDic の品詞の大分類）。名詞と形状詞（「元気」のようなナ形容詞の語幹）だけ。
 * 動詞・形容詞は活用で読みがぶれるので外す。助詞・記号などはもともと直す必要が無い。
 */
const TARGET_POS_PREFIXES = ['名詞', '形状詞'];

/** 漢字を含むか（CJK 統合漢字の範囲）。 */
const KANJI_RE = /[一-龯㐀-䶿]/;

/** 解析結果の details で、読み（カタカナ）が入っている位置（実測: "北西" → details[6] = "ホクセイ"）。 */
const READING_DETAIL_INDEX = 6;

/**
 * 文中の、漢字を含む2文字以上の名詞・形状詞を、辞書の読み（カタカナ）に置き換える。
 * 読み込みや解析に失敗したときは、元の文をそのまま返す（読み上げは止めない）。
 * @param {string} text
 * @returns {Promise<string>}
 */
async function normalizeReadingsForSpeech(text) {
  if (!ENABLED || !text) return text;

  const tokenizer = await _loadTokenizer();
  if (!tokenizer) return text;

  try {
    const tokens = tokenizer.tokenize(text);

    let result = '';
    for (const t of tokens) {
      const surface = t.surface;
      const pos0 = t.details && t.details[0];
      const reading = t.details && t.details[READING_DETAIL_INDEX];

      const isTarget = !t.is_unknown
        && surface.length >= 2
        && KANJI_RE.test(surface)
        && TARGET_POS_PREFIXES.includes(pos0)
        && reading && /^[ァ-ヶー]+$/.test(reading); // 読みがカタカナで取れたときだけ

      result += isTarget ? reading : surface;
    }
    return result;
  } catch (e) {
    getLogger().warn(`[DictionaryReading] 変換失敗、元テキストのまま続行: ${e.message}`);
    return text;
  }
}

/**
 * 辞書を先に読み込んでおく（サーバーの起動時に呼ぶ）。
 *
 * ATTENTION: server.js は、これを await してから接続の受け付け（server.listen）を始めること。
 *            先に受け付けると、再起動の直後に接続したリスナーは、辞書の読み込みが終わるまで
 *            キャスターが話し始めず無音になる（以前の辞書では最大20秒近くかかった）。
 * @returns {Promise<void>}
 */
function warmUp() {
  if (!ENABLED) return Promise.resolve();
  const t0 = Date.now();
  return _loadTokenizer().then((tokenizer) => {
    if (tokenizer) getLogger().info(`[DictionaryReading] UniDic辞書の初期ロード完了（${Date.now() - t0}ms）`);
  });
}

module.exports = { normalizeReadingsForSpeech, warmUp };
