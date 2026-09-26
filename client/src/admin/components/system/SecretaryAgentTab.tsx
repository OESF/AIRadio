/**
 * @file 管理画面の「エージェント設定（My Secretary）」タブ
 *
 * 秘書の表示名・キャラクター設定・声を編集する。声は Gemini Live の制約で、常に Gemini の決まった声を使う。
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

import type { FormEvent } from 'react';
import type { FullConfig, AgentConfig } from '../../types';
import { GeminiTtsFields } from '../GeminiTtsFields';

/**
 * 秘書のアバターの確認、表示名・キャラクター設定プロンプト・声の設定（試聴付き）を編集して保存する。
 * @param props.avatarErrors 画像が読めなかったエージェント（絵文字で代わりに表示する）
 * @param props.onAvatarError 画像が読めなかったときに呼ぶ
 * @param props.playLiveTtsTest 試聴する
 */
export function SecretaryAgentTab({
  config, setConfig, saveConfig, testingAgent, playLiveTtsTest,
  avatarErrors, onAvatarError, getAgentEmoji,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
  testingAgent: string | null;
  playLiveTtsTest: (agentKey: string, agent: AgentConfig) => void;
  avatarErrors: Set<string>;
  onAvatarError: (key: string) => void;
  getAgentEmoji: (role: string) => string;
}) {
  const secretary = config.agents.secretary ?? {
    name: '', prompt: '', voice: '', tts_engine: 'gemini',
  };
  const setAgent = (patch: Partial<AgentConfig>) => {
    setConfig({ ...config, agents: { ...config.agents, secretary: { ...secretary, ...patch } } });
  };
  const currentLang = secretary.gemini_language ?? '';
  const LANG_OPTIONS = [
    { label: '自動', value: '' }, { label: '日本語', value: 'ja-JP' },
    { label: 'English US', value: 'en-US' }, { label: 'English UK', value: 'en-GB' },
    { label: '中文', value: 'zh-CN' }, { label: '한국어', value: 'ko-KR' },
    { label: 'Français', value: 'fr-FR' }, { label: 'Deutsch', value: 'de-DE' },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">👩‍💼</span>
        <h2 className="text-lg font-bold text-neon-blue">エージェント設定（My Secretary）</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        Live/Classicなど他チャンネルと同格の、独立した第8のチャンネルです。選択すると
        Gemini Live APIによる双方向のリアルタイム音声会話が始まり、起動と同時に秘書側から
        プロアクティブに挨拶します。放送のミキサー・コーナーローテーションとは無関係の、
        リスナー個人のためだけのセッションです。声はGemini Live APIの制約上、常にGemini
        プリセットボイスを使用します。
      </p>
      <form onSubmit={saveConfig} className="flex flex-col gap-5">
        {/* アバタープレビュー */}
        {!avatarErrors.has('secretary') ? (
          <div className="flex items-center gap-4">
            <img
              src="/avatars/secretary.png"
              alt="secretary"
              onError={() => onAvatarError('secretary')}
              className="w-24 h-24 object-contain rounded-xl flex-shrink-0"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
            />
            <div className="text-sm text-gray-500">
              <p className="text-white/60 font-mono">/avatars/secretary.png</p>
              <p className="mt-1">300×300px PNG（透過）</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="w-24 h-24 rounded-xl flex items-center justify-center flex-shrink-0 text-4xl"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px dashed rgba(255,255,255,0.15)' }}>
              {getAgentEmoji('secretary')}
            </div>
            <div className="text-sm text-gray-500">
              <p className="font-mono text-white/40">/avatars/secretary.png</p>
              <p className="mt-1 text-yellow-500/70">未設定 — ファイルをアップロードすると表示されます</p>
            </div>
          </div>
        )}
        <div>
          <label>表示名</label>
          <input type="text" value={secretary.name}
            onChange={e => setAgent({ name: e.target.value })} />
        </div>
        <div>
          <label>キャラクター設定プロンプト</label>
          <textarea rows={4} value={secretary.prompt}
            onChange={e => setAgent({ prompt: e.target.value })} />
        </div>

        <GeminiTtsFields
          agent={secretary}
          setAgent={setAgent}
          langOptions={LANG_OPTIONS}
          currentLang={currentLang}
          onTest={() => playLiveTtsTest('secretary', secretary)}
          testingAgent={testingAgent}
          agentKey="secretary"
          accentColor="blue"
        />

        <button type="submit" className="btn btn-primary py-3">💾 保存</button>
      </form>
    </div>
  );
}
