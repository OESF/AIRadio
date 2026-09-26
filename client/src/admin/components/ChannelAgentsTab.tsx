/**
 * @file 管理画面の Classic・Jazz・Mood・Beatles の「エージェント設定」タブ（チャンネル共通の部品）
 *
 * エージェントごとにアコーディオンで、表示名・声の演技指示（GeminiTtsFields）・パンと音量・LLM のモデル・
 * 最大の文字数・キャラクター設定のプロンプトを編集する。各チャンネルのパネルが役割の一覧と状態を渡す。
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
import { Sliders, ChevronDown } from 'lucide-react';
import type { ChannelAccent, ChannelAgentShape, GeminiTtsAgent } from '../types';
import { CHANNEL_ACCENT, GEMINI_MODELS } from '../constants';
import { GeminiTtsFields } from './GeminiTtsFields';
import { MaxCharsSelector } from './MaxCharsSelector';

/**
 * チャンネルのエージェントの設定の欄。
 * @param props.channelLabel 見出しに出すチャンネル名
 * @param props.accent チャンネルの色
 * @param props.agentRoles 並べる役割のキー
 * @param props.agents 役割ごとのエージェントの設定
 * @param props.setAgent 1人の設定を部分的に書き換える
 * @param props.onTest 声のテストを再生する
 * @param props.openAgents 開いているアコーディオン
 * @param props.creds 接続設定（既定のモデルの表示に使う）
 * @param props.avatarFile 役割の名前とアバターのファイル名が違うときの解決（省略すると役割の名前をそのまま使う）
 */
export function ChannelAgentsTab<TAgent extends ChannelAgentShape, TRole extends string>({
  channelLabel, accent, agentRoles, agents, setAgent,
  ttsTestText, setTtsTestText, onTest, onSubmit,
  avatarErrors, onAvatarError, getAgentEmoji, openAgents, setOpenAgents,
  testingAgent, creds, avatarFile,
}: {
  channelLabel: string;
  accent: ChannelAccent;
  agentRoles: readonly TRole[];
  agents: Record<TRole, TAgent>;
  setAgent: (role: TRole, patch: Partial<TAgent>) => void;
  ttsTestText: string;
  setTtsTestText: (v: string) => void;
  onTest: (role: TRole, agent: TAgent) => void;
  onSubmit: (e: FormEvent) => void;
  avatarErrors: Set<string>;
  onAvatarError: (role: string) => void;
  getAgentEmoji: (role: string) => string;
  openAgents: Set<string>;
  setOpenAgents: Dispatch<SetStateAction<Set<string>>>;
  testingAgent: string | null;
  creds: { gemini?: { model?: string } } | null;
  avatarFile?: (role: TRole) => string;
}) {
  const col = CHANNEL_ACCENT[accent];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <Sliders className="w-5 h-5" style={{ color: col.icon }} />
        <h2 className="text-lg font-bold" style={{ color: col.heading }}>エージェント設定（{channelLabel}）</h2>
      </div>
      {/* テスト発声テキスト */}
      <div className="bg-black/20 border border-glass rounded-xl bp-5 flex flex-col gap-2">
        <label className="text-xs font-bold text-neon-blue uppercase tracking-wider">テスト発声テキスト</label>
        <div className="flex gap-2">
          <input type="text" value={ttsTestText} onChange={e => setTtsTestText(e.target.value)}
            placeholder="テスト再生するセリフを入力..." className="flex-1" />
        </div>
        <p className="text-xs text-gray-600">各エージェントの ▶ テスト ボタンを押すとこのテキストで発声テストを行います。</p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-6">
        {agentRoles.map(role => {
          const agent = agents[role];
          const isOpen = openAgents.has(role);
          const toggleAgent = () => setOpenAgents(prev => {
            const next = new Set(prev);
            next.has(role) ? next.delete(role) : next.add(role);
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
          const setThisAgent = (patch: Partial<TAgent>) => setAgent(role, patch);
          const avatarKey = avatarFile ? avatarFile(role) : role;
          return (
            <div key={role} className="border border-glass rounded-xl overflow-hidden" style={{ background: 'rgba(0,0,0,0.2)' }}>

              {/* アコーディオンヘッダー */}
              <button
                type="button"
                onClick={toggleAgent}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left"
              >
                <span className="flex items-center gap-3">
                  {avatarErrors.has(avatarKey) ? (
                    <span className="text-xl flex-shrink-0">{getAgentEmoji(avatarKey)}</span>
                  ) : (
                    <img
                      src={`/avatars/${avatarKey}.png`}
                      alt={role}
                      onError={() => onAvatarError(avatarKey)}
                      className="w-9 h-9 object-contain rounded-full flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.04)' }}
                    />
                  )}
                  {/* 名前・役職を固定幅にして、全行で役職の開始位置を揃える */}
                  <span className="font-bold text-white truncate" style={{ width: '280px', flexShrink: 0 }}>{agent.name}</span>
                  <span className="text-xs text-gray-500 uppercase tracking-widest truncate" style={{ width: '150px', flexShrink: 0 }}>{role}</span>
                </span>
                <ChevronDown
                  className={`w-4 h-4 text-gray-500 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {/* 展開コンテンツ */}
              {isOpen && (
              <div className="flex flex-col gap-5 border-t border-glass" style={{ padding: '20px' }}>

                {/* アバタープレビュー */}
                {!avatarErrors.has(avatarKey) ? (
                  <div className="flex items-center gap-4">
                    <img
                      src={`/avatars/${avatarKey}.png`}
                      alt={role}
                      onError={() => onAvatarError(avatarKey)}
                      className="w-24 h-24 object-contain rounded-xl flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
                    />
                    <div className="text-sm text-gray-500">
                      <p className="text-white/60 font-mono">/avatars/{avatarKey}.png</p>
                      <p className="mt-1">300×300px PNG（透過）</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-4">
                    <div className="w-24 h-24 rounded-xl flex items-center justify-center flex-shrink-0 text-4xl"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.15)' }}>
                      {getAgentEmoji(avatarKey)}
                    </div>
                    <div className="text-sm text-gray-500">
                      <p className="font-mono text-white/40">/avatars/{avatarKey}.png</p>
                      <p className="mt-1 text-yellow-500/70">未設定 — ファイルをアップロードすると表示されます</p>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* 表示名 */}
                  <div>
                    <label>表示名</label>
                    <input type="text" value={agent.name}
                      onChange={e => setThisAgent({ name: e.target.value } as Partial<TAgent>)} />
                  </div>
                </div>

                {/* 声の演技指示（6項目） */}
                <GeminiTtsFields
                  agent={agent}
                  setAgent={setThisAgent as (patch: Partial<GeminiTtsAgent>) => void}
                  langOptions={[
                    { label: '自動', value: '' }, { label: '日本語', value: 'ja-JP' },
                    { label: 'English US', value: 'en-US' }, { label: 'English UK', value: 'en-GB' },
                    { label: '中文', value: 'zh-CN' }, { label: '한국어', value: 'ko-KR' },
                    { label: 'Français', value: 'fr-FR' }, { label: 'Deutsch', value: 'de-DE' },
                  ]}
                  currentLang={agent.gemini_language ?? ''}
                  onTest={() => onTest(role, agent)}
                  testingAgent={testingAgent}
                  agentKey={role}
                  accentColor={accent}
                />

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
                          onChange={e => setThisAgent({ pan: Number(e.target.value) / 100 } as Partial<TAgent>)}
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
                            setThisAgent({ volume: Math.pow(10, db / 20) } as Partial<TAgent>);
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
                <div className="flex flex-col gap-4 rounded-lg" style={{ padding: '16px', background: col.llmBg, border: `1px solid ${col.llmBorder}` }}>
                  <h4 style={{ fontSize: '11px', fontWeight: 700, color: col.llmHeading, letterSpacing: '0.08em', textTransform: 'uppercase', margin: 0 }}>
                    🤖 LLM 設定
                  </h4>

                  {/* Gemini モデル個別設定（会話） */}
                  <div>
                    <label>Gemini モデル・会話（個別設定）</label>
                    <select
                      value={agent.gemini_model ?? ''}
                      onChange={e => setThisAgent({ gemini_model: e.target.value === '' ? undefined : e.target.value } as Partial<TAgent>)}
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
                    onChange={v => setThisAgent({ max_chars: v === 0 ? undefined : v } as Partial<TAgent>)}
                    accentColor={accent}
                  />

                  {/* キャラクター設定プロンプト */}
                  <div>
                    <label>キャラクター設定プロンプト</label>
                    <textarea rows={4} value={agent.prompt}
                      onChange={e => setThisAgent({ prompt: e.target.value } as Partial<TAgent>)} />
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
