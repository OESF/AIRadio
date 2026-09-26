/**
 * @file 管理画面の、Gemini TTS の声の設定欄（全チャンネル共通）
 *
 * 声の選択と試聴、言語、演技の指示6項目（役柄・場面・話し方・訛り・ペース・文脈）を編集する。
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

import type { GeminiTtsAgent, LangOption } from '../types';

/**
 * Gemini TTS の声の設定欄。
 *
 * ATTENTION: accentColor に色を足したら、下の分岐すべて（枠線・背景・見出し・ボタン）へ足すこと。
 * 足し忘れると、その色だけ既定（琥珀色）で表示される。色の値は constants.ts の CHANNEL_ACCENT に合わせる。
 * @param props.agent 編集するエージェントの設定
 * @param props.setAgent 変更した項目だけを渡す
 * @param props.langOptions 言語の選択肢
 * @param props.onTest 試聴する
 * @param props.testingAgent 試聴中のエージェントのキー（試聴ボタンの表示に使う）
 * @param props.agentKey このエージェントのキー
 */
export function GeminiTtsFields({
  agent, setAgent, langOptions, currentLang,
  onTest, testingAgent, agentKey, accentColor,
}: {
  agent: GeminiTtsAgent;
  setAgent: (patch: Partial<GeminiTtsAgent>) => void;
  langOptions: LangOption[];
  currentLang: string;
  onTest: () => void;
  testingAgent: string | null;
  agentKey: string;
  accentColor: 'purple' | 'amber' | 'blue' | 'red' | 'cyan';
}) {
  const borderCol = accentColor === 'purple' ? 'rgba(99,102,241,0.3)' : accentColor === 'blue' ? 'rgba(59,130,246,0.3)' : accentColor === 'red' ? 'rgba(239,68,68,0.3)' : accentColor === 'cyan' ? 'rgba(8,145,178,0.3)' : 'rgba(245,158,11,0.2)';
  const bgCol     = accentColor === 'purple' ? 'rgba(99,102,241,0.08)' : accentColor === 'blue' ? 'rgba(59,130,246,0.08)' : accentColor === 'red' ? 'rgba(239,68,68,0.08)' : accentColor === 'cyan' ? 'rgba(8,145,178,0.08)' : 'rgba(245,158,11,0.04)';
  const hCol      = accentColor === 'purple' ? '#818cf8' : accentColor === 'blue' ? '#60a5fa' : accentColor === 'red' ? '#f87171' : accentColor === 'cyan' ? '#22d3ee' : '#fbbf24';
  const btnBase   = accentColor === 'purple'
    ? 'btn-dark border border-neon-purple/40 hover:border-neon-purple text-neon-purple'
    : accentColor === 'blue'
    ? 'btn-dark border border-blue-500/40 hover:border-blue-400 text-blue-400'
    : accentColor === 'red'
    ? 'btn-dark border border-red-500/40 hover:border-red-400 text-red-400'
    : accentColor === 'cyan'
    ? 'btn-dark border border-cyan-500/40 hover:border-cyan-400 text-cyan-400'
    : 'btn-dark border border-amber-500/40 hover:border-amber-400 text-amber-400';

  const chip = (
    active: boolean,
    label: string,
    onClick: () => void,
    activeCol = '#6366f1',
  ) => (
    <button key={label} type="button" onClick={onClick} style={{
      padding: '2px 10px', fontSize: '11px', borderRadius: '9999px', border: '1px solid',
      cursor: 'pointer',
      borderColor: active ? activeCol : '#4b5563',
      background:  active ? activeCol : 'transparent',
      color:       active ? '#fff'    : '#9ca3af',
    }}>{label}</button>
  );

  const VOICE_NAMES = ['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede',
    'Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome',
    'Algenib','Rasalghul','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima',
    'Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];
  const VOICE_STANDARD = VOICE_NAMES.slice(0, 8);
  const VOICE_EXTENDED = VOICE_NAMES.slice(8);

  const fieldDefs: { key: keyof GeminiTtsAgent; label: string; placeholder: string; rows?: number }[] = [
    { key: 'tts_profile_title', label: 'Profile Title　役割名',            placeholder: '例: eスポーツ大会の実況アナウンサーみたいに、大興奮で' },
    { key: 'tts_scene',         label: 'Scene　スタジオ・場所の情景',       placeholder: '例: 深夜、静かで落ち着いたラジオスタジオ。窓の外は雨が降っている。', rows: 2 },
    { key: 'tts_style',         label: 'Style　声のスタイル・トーン',       placeholder: '例: 落ち着いていて、でも芯のある説得力を感じさせる話し方。', rows: 2 },
    { key: 'tts_accent',        label: 'Accent　アクセント・出身地',        placeholder: '例: 標準的な日本語のイントネーション（未入力でも可）' },
    { key: 'tts_pacing',        label: 'Pacing　話すテンポ・リズム',       placeholder: '例: ゆったりと、間を大切にしながら話す。' },
    { key: 'tts_context',       label: 'Context　キャラクターの役割説明',  placeholder: '例: 20年のキャリアを持つベテランのラジオジャーナリスト。', rows: 2 },
  ];

  return (
    <div className="flex flex-col gap-4 rounded-lg" style={{ padding: '16px', background: bgCol, border: `1px solid ${borderCol}` }}>
      <div className="flex items-center justify-between">
        <h4 style={{ fontSize: '11px', fontWeight: 700, color: hCol, letterSpacing: '0.08em', textTransform: 'uppercase', margin: 0 }}>
          🎙️ Gemini TTS 設定
        </h4>
      </div>

      {/* ボイス選択 + テストボタン */}
      <div>
        <label>ボイス</label>
        <div className="flex gap-2">
          <select className="flex-1" value={agent.gemini_voice ?? 'Kore'}
            onChange={e => setAgent({ gemini_voice: e.target.value })}>
            <optgroup label="─ Standard ─">
              {VOICE_STANDARD.map(v => <option key={v} value={v}>{v}</option>)}
            </optgroup>
            <optgroup label="─ Extended ─">
              {VOICE_EXTENDED.map(v => <option key={v} value={v}>{v}</option>)}
            </optgroup>
          </select>
          <button type="button" disabled={testingAgent !== null} onClick={onTest}
            className={`btn px-4 text-sm flex-shrink-0 ${testingAgent === agentKey ? 'btn-secondary animate-pulse' : btnBase} disabled:opacity-30 disabled:cursor-not-allowed`}>
            {testingAgent === agentKey ? '再生中...' : '▶ テスト'}
          </button>
        </div>
      </div>

      {/* 言語 */}
      <div>
        <label style={{ fontSize: '12px', color: '#9ca3af' }}>Language　言語指定</label>
        <div className="flex flex-wrap gap-1 mt-1">
          {langOptions.map(opt => chip(
            currentLang === opt.value, opt.label,
            () => setAgent({ gemini_language: opt.value }), '#10b981'
          ))}
        </div>
      </div>

      {/* 6フィールド */}
      {fieldDefs.map(({ key, label, placeholder, rows }) => {
        const val = (agent[key] as string) ?? '';
        return (
          <div key={key}>
            <label style={{ fontSize: '12px', color: '#9ca3af' }}>{label}</label>
            {rows && rows > 1 ? (
              <textarea rows={rows} value={val}
                onChange={e => setAgent({ [key]: e.target.value } as Partial<GeminiTtsAgent>)}
                placeholder={placeholder} style={{ fontSize: '12px' }} />
            ) : (
              <input type="text" value={val}
                onChange={e => setAgent({ [key]: e.target.value } as Partial<GeminiTtsAgent>)}
                placeholder={placeholder} style={{ fontSize: '12px' }} />
            )}
          </div>
        );
      })}
      <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>
        単語の羅列ではなく、自然な一文で書くとGemini TTSに正確に伝わりやすくなります。変更後は ▶ テスト で確認。
      </p>
    </div>
  );
}
