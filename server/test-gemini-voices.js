#!/usr/bin/env node
/**
 * @file Gemini TTS の全ての声を試す検証スクリプト
 *
 * 声ごと・キャラクターごとの試験文を合成して、WAV ファイルに保存する。
 *
 * 使い方: node server/test-gemini-voices.js
 * 出力先: server/voice-samples/
 * 読み込み元: data/credentials.json
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

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CREDENTIALS_PATH = path.join(__dirname, 'data', 'credentials.json');
const OUTPUT_DIR       = path.join(__dirname, 'voice-samples');

// ── ボイス一覧 ──────────────────────────────────────────────────────
const VOICES = {
  standard: [
    { name: 'Zephyr',  desc: 'Bright（明るい）' },
    { name: 'Puck',    desc: 'Upbeat（陽気）' },
    { name: 'Charon',  desc: 'Informative（情報的）' },
    { name: 'Kore',    desc: 'Firm（しっかり）' },
    { name: 'Fenrir',  desc: 'Excitable（興奮気味）' },
    { name: 'Leda',    desc: 'Youthful（若々しい）' },
    { name: 'Orus',    desc: 'Firm（威厳）' },
    { name: 'Aoede',   desc: 'Breezy（軽やか）' },
  ],
  extended: [
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel',
    'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalghul',
    'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux',
    'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix',
    'Sadachbia', 'Sadaltager', 'Sulafat',
  ].map(name => ({ name, desc: 'Extended' })),
};

// ── テスト文（キャラクターごと） ───────────────────────────────────
const TEST_SCRIPTS = {
  energetic: {
    label: '元気・ノリ（MAX向け）',
    text: 'さあ、始まりましょう！今日もAIラジオへようこそ！盛りだくさんでお届けしますよ！今日も最高の一日にしていきましょう！',
    instruction: 'energetic, upbeat',
  },
  dj: {
    label: 'DJ・カジュアル（DJ サキ向け）',
    text: 'イェーイ！今夜もサイコーな曲をお届けするよ！テンション上げていこう！次の曲、最高にクールだから聴いてみて！',
    instruction: 'casual, excited, young',
  },
  mysterious: {
    label: 'ミステリアス（謎のX向け）',
    text: '真実は、常に闇の中に隠されている。この情報が表に出ることを、彼らは望んでいないだろう。しかし私は伝えなければならない。',
    instruction: 'mysterious, slow, serious',
  },
};

// ── API 呼び出し ────────────────────────────────────────────────────
/**
 * 1つの文を合成する。
 * @param {string} text
 * @param {string} voiceName Gemini の声の名前
 * @param {string} instruction 話し方の指示
 */
async function synthesize(text, voiceName, instruction) {
  const creds  = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const apiKey = creds?.gemini?.api_key;
  if (!apiKey) throw new Error('Gemini API キーが未設定');

  const model   = 'gemini-2.5-flash-preview-tts';
  const bodyText = instruction ? `${instruction}\n\n${text}` : text;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: bodyText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }

  const json     = await res.json();
  const audioB64 = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audioB64) throw new Error('音声データなし');

  const pcmBuf = Buffer.from(audioB64, 'base64');

  // WAV ヘッダー付加
  const sampleRate  = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate    = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign  = numChannels * bitsPerSample / 8;
  const dataSize    = pcmBuf.length;
  const header      = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]);
}

// ── メイン ─────────────────────────────────────────────────────────
/** 全ての声で試験文を合成して保存し、最後に結果の一覧を出す。 */
async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allVoices = [...VOICES.standard, ...VOICES.extended];
  const results   = {};

  for (const [scriptKey, script] of Object.entries(TEST_SCRIPTS)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`【${script.label}】`);
    console.log('='.repeat(60));
    results[scriptKey] = { label: script.label, ok: [], fail: [] };

    for (const voice of allVoices) {
      const filename = `${scriptKey}_${voice.name}.wav`;
      const filepath = path.join(OUTPUT_DIR, filename);
      process.stdout.write(`  ${voice.name.padEnd(18)} (${voice.desc.padEnd(18)}) ... `);

      try {
        const wav = await synthesize(script.text, voice.name, script.instruction);
        fs.writeFileSync(filepath, wav);
        console.log(`✅ OK  → ${filename}`);
        results[scriptKey].ok.push(voice.name);
      } catch (e) {
        console.log(`❌ ${e.message.slice(0, 60)}`);
        results[scriptKey].fail.push({ name: voice.name, error: e.message });
      }

      // レート制限対策
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // ── サマリー出力 ──────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('【結果サマリー】');
  console.log('='.repeat(60));
  for (const [key, r] of Object.entries(results)) {
    console.log(`\n${r.label}`);
    console.log(`  成功: ${r.ok.join(', ') || 'なし'}`);
    if (r.fail.length > 0) {
      console.log(`  失敗: ${r.fail.map(f => f.name).join(', ')}`);
    }
  }

  console.log(`\n音声ファイルは ${OUTPUT_DIR} に保存されました。`);
  console.log('ファイル名: {キャラクター}_{ボイス名}.wav');
}

main().catch(e => { console.error('致命的エラー:', e); process.exit(1); });
