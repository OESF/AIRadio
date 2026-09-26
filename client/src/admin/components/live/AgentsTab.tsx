/**
 * @file 管理画面の Live「エージェント設定」タブ（Live の全エージェントの名前・声・パンと音量・モデル・プロンプト）
 *
 * config.agents の各エージェントをアコーディオンで並べて編集する。秘書（secretary）は Live に出ないので除く
 * （「My Secretary → エージェント設定」に別のタブがある）。テスト発声の文は config.show.tts_test_text に保存する。
 *
 * ATTENTION: 丸角ボックスの内側の余白に使う bp-5 は、このプロジェクトで定義した独自のクラス
 * （client/src/index.css）。Tailwind の p-5 が dev モードで生成されないための代わりなので、
 * p-5 の打ち間違いと見て書き換えないこと。
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

import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { ChevronDown, Sliders } from 'lucide-react';
import type { FullConfig, AgentConfig } from '../../types';
import { GEMINI_MODELS } from '../../constants';
import { GeminiTtsFields } from '../GeminiTtsFields';
import { MaxCharsSelector } from '../MaxCharsSelector';

/**
 * Live のエージェントの設定の欄。
 * @param props.config 設定の全体
 * @param props.openAgents 開いているアコーディオン
 * @param props.playLiveTtsTest 声のテストを再生する
 * @param props.creds 接続設定（既定のモデルの表示に使う）
 */
export function AgentsTab({
  config, setConfig, saveConfig,
  openAgents, setOpenAgents, avatarErrors, onAvatarError, getAgentEmoji,
  liveTtsTestText, setLiveTtsTestText, playLiveTtsTest, testingAgent, creds,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
  openAgents: Set<string>;
  setOpenAgents: Dispatch<SetStateAction<Set<string>>>;
  avatarErrors: Set<string>;
  onAvatarError: (role: string) => void;
  getAgentEmoji: (role: string) => string;
  liveTtsTestText: string;
  setLiveTtsTestText: (v: string) => void;
  playLiveTtsTest: (agentKey: string, agent: AgentConfig) => void;
  testingAgent: string | null;
  creds: { gemini?: { model?: string } } | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <Sliders className="w-5 h-5 text-neon-purple" />
        <h2 className="text-lg font-bold text-neon-purple">エージェント設定</h2>
      </div>
      {/* テスト発声テキスト入力 */}
      <div className="bg-black/20 border border-glass rounded-xl bp-5 flex flex-col gap-2">
        <label className="text-xs font-bold text-neon-blue uppercase tracking-wider">テスト発声テキスト</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={liveTtsTestText}
            onChange={e => { setLiveTtsTestText(e.target.value); setConfig({ ...config, show: { ...config.show, tts_test_text: e.target.value } }); }}
            placeholder="テスト再生するセリフを入力..."
            className="flex-1"
          />
        </div>
        <p className="text-xs text-gray-600">各エージェントの ▶ ボタンを押すとこのテキストを発声します。</p>
      </div>

      <form onSubmit={saveConfig} className="flex flex-col gap-6">
        {/* 秘書は Live に出ないので除く（「My Secretary → エージェント設定」に別のタブがある） */}
        {Object.entries(config.agents).filter(([key]) => key !== 'secretary').map(([key, agent]) => {
          const isOpen = openAgents.has(key);
          const toggleAgent = () => setOpenAgents(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
          });
          const panVal = agent.pan ?? 0;
          const panPct = Math.round(panVal * 100);
          const panLabel = panPct === 0 ? '中央' : panPct < 0 ? `L ${Math.abs(panPct)}` : `R ${panPct}`;
          const panColor = panPct === 0 ? 'text-gray-400' : panPct < 0 ? 'text-sky-400' : 'text-rose-400';
          const volumeVal = agent.volume ?? 1.0;
          const volumeDb = Math.round(20 * Math.log10(Math.max(volumeVal, 0.01)));
          const volumeLabel = volumeDb === 0 ? '0 dB' : volumeDb > 0 ? `+${volumeDb} dB` : `${volumeDb} dB`;
          const volumeColor = volumeDb < 0 ? 'text-sky-400' : volumeDb > 0 ? 'text-amber-400' : 'text-gray-400';
          return (
            <div key={key} className="border border-glass rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.2)' }}>

              {/* アコーディオンヘッダー */}
              <button
                type="button"
                onClick={toggleAgent}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left"
              >
                <span className="flex items-center gap-3">
                  {avatarErrors.has(key) ? (
                    <span className="text-xl flex-shrink-0">{getAgentEmoji(key)}</span>
                  ) : (
                    <img
                      src={`/avatars/${key}.png`}
                      alt={key}
                      onError={() => onAvatarError(key)}
                      className="w-9 h-9 object-contain rounded-full flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.04)' }}
                    />
                  )}
                  {/* 名前・役職を固定幅にして、全行で役職の開始位置を揃える */}
                  <span className="font-bold text-white truncate" style={{ width: '280px', flexShrink: 0 }}>{agent.name}</span>
                  <span className="text-xs text-gray-500 uppercase tracking-widest truncate" style={{ width: '150px', flexShrink: 0 }}>{key}</span>
                </span>
                <ChevronDown
                  className={`w-4 h-4 text-gray-500 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {/* 展開コンテンツ */}
              {isOpen && (
              <div className="flex flex-col gap-5 border-t border-glass" style={{ padding: '20px' }}>

              {/* アバタープレビュー */}
              {!avatarErrors.has(key) && (
                <div className="flex items-center gap-4">
                  <img
                    src={`/avatars/${key}.png`}
                    alt={key}
                    onError={() => onAvatarError(key)}
                    className="w-24 h-24 object-contain rounded-xl flex-shrink-0"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
                  />
                  <div className="text-sm text-gray-500">
                    <p className="text-white/60 font-mono">/avatars/{key}.png</p>
                    <p className="mt-1">300×300px PNG（透過）</p>
                  </div>
                </div>
              )}
              {avatarErrors.has(key) && (
                <div className="flex items-center gap-4">
                  <div className="w-24 h-24 rounded-xl flex items-center justify-center flex-shrink-0 text-4xl"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.15)' }}>
                    {getAgentEmoji(key)}
                  </div>
                  <div className="text-sm text-gray-500">
                    <p className="font-mono text-white/40">/avatars/{key}.png</p>
                    <p className="mt-1 text-yellow-500/70">未設定 — ファイルをアップロードすると表示されます</p>
                  </div>
                </div>
              )}

              {/* 表示名 + TTS エンジン選択 */}
              {(() => {
                const setAgent = (patch: Partial<AgentConfig>) => {
                  const newAgents = { ...config.agents };
                  newAgents[key] = { ...newAgents[key], ...patch };
                  setConfig({ ...config, agents: newAgents });
                };
                const currentLang = agent.gemini_language ?? '';
                const LANG_OPTIONS = [
                  { label: '自動', value: '' }, { label: '日本語', value: 'ja-JP' },
                  { label: 'English US', value: 'en-US' }, { label: 'English UK', value: 'en-GB' },
                  { label: '中文', value: 'zh-CN' }, { label: '한국어', value: 'ko-KR' },
                  { label: 'Français', value: 'fr-FR' }, { label: 'Deutsch', value: 'de-DE' },
                ];
                return (
                  <>
                    {/* 表示名 */}
                    <div>
                      <label>表示名</label>
                      <input type="text" value={agent.name}
                        onChange={e => setAgent({ name: e.target.value })} />
                    </div>

                    {/* 声の演技指示（6項目） */}
                    <GeminiTtsFields
                      agent={agent}
                      setAgent={setAgent}
                      langOptions={LANG_OPTIONS}
                      currentLang={currentLang}
                      onTest={() => playLiveTtsTest(key, agent)}
                      testingAgent={testingAgent}
                      agentKey={key}
                      accentColor="purple"
                    />
                  </>
                );
              })()}

              {/* ミキサー設定 */}
              <div className="flex flex-col gap-4 rounded-lg" style={{ padding: '16px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <h4 style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', letterSpacing: '0.08em', textTransform: 'uppercase', margin: 0 }}>
                  🎛 ミキサー設定
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1">ステレオパン</label>
                    <div className="flex items-center gap-2 flex-nowrap">
                      <span className="text-xs text-gray-500 flex-shrink-0">L</span>
                      <input
                        type="range" min="-100" max="100" step="5"
                        value={panPct}
                        onChange={e => {
                          const newAgents = { ...config.agents };
                          newAgents[key] = { ...newAgents[key], pan: Number(e.target.value) / 100 };
                          setConfig({ ...config, agents: newAgents });
                        }}
                        className="flex-1 min-w-0 accent-neon-blue"
                      />
                      <span className="text-xs text-gray-500 flex-shrink-0">R</span>
                      <span className={`text-sm font-bold font-mono ${panColor} w-14 text-right flex-shrink-0`}>{panLabel}</span>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1">音量</label>
                    <div className="flex items-center gap-2 flex-nowrap">
                      <span className="text-xs text-gray-500 flex-shrink-0">-20</span>
                      <input
                        type="range" min="-20" max="6" step="1"
                        value={volumeDb}
                        onChange={e => {
                          const db = Number(e.target.value);
                          const newAgents = { ...config.agents };
                          newAgents[key] = { ...newAgents[key], volume: Math.pow(10, db / 20) };
                          setConfig({ ...config, agents: newAgents });
                        }}
                        className="flex-1 min-w-0 accent-neon-blue"
                      />
                      <span className="text-xs text-gray-500 flex-shrink-0">+6</span>
                      <span className={`text-sm font-bold font-mono ${volumeColor} w-16 text-right flex-shrink-0`}>{volumeLabel}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* LLM 設定 */}
              <div className="flex flex-col gap-4 rounded-lg" style={{ padding: '16px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.3)' }}>
                <h4 style={{ fontSize: '11px', fontWeight: 700, color: '#818cf8', letterSpacing: '0.08em', textTransform: 'uppercase', margin: 0 }}>
                  🤖 LLM 設定
                </h4>

                {/* Gemini モデル個別設定（会話） */}
                <div>
                  <label>Gemini モデル・会話（個別設定）</label>
                  <select
                    value={agent.gemini_model ?? ''}
                    onChange={e => {
                      const newAgents = { ...config.agents };
                      const val = e.target.value;
                      newAgents[key] = { ...newAgents[key], gemini_model: val === '' ? undefined : val };
                      setConfig({ ...config, agents: newAgents });
                    }}
                  >
                    <option value="">— 接続設定のデフォルトに従う（{creds?.gemini?.model ?? 'gemini-2.5-flash'}）—</option>
                    {GEMINI_MODELS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  {agent.gemini_model && (
                    <p className="text-xs text-neon-blue mt-1">
                      ✓ このエージェントは <code className="mx-1">{agent.gemini_model}</code> を使用します
                    </p>
                  )}
                </div>

                {/* 最大発話文字数 */}
                <MaxCharsSelector
                  value={agent.max_chars}
                  onChange={v => {
                    const newAgents = { ...config.agents };
                    newAgents[key] = { ...newAgents[key], max_chars: v === 0 ? undefined : v };
                    setConfig({ ...config, agents: newAgents });
                  }}
                  accentColor="purple"
                />

                {/* キャラクター設定プロンプト */}
                <div>
                  <label>キャラクター設定プロンプト</label>
                  <textarea rows={4} value={agent.prompt}
                    onChange={e => {
                      const newAgents = { ...config.agents };
                      newAgents[key] = { ...newAgents[key], prompt: e.target.value };
                      setConfig({ ...config, agents: newAgents });
                    }}
                  />
                </div>
              </div>
              </div>
              )}
            </div>
          );
        })}
        <button type="submit" className="btn btn-primary py-3">
          エージェント設定を保存
        </button>
      </form>
    </div>
  );
}
