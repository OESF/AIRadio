/**
 * @file 管理画面の「AI管理者設定」タブ（お問い合わせ窓口の名前と声）
 *
 * AI Radio 管理人は「💬 お問い合わせ・リクエスト」窓口に応答するアシスタント。
 * 特定のチャンネルに属さず、放送中かどうかに関わらず使われる。
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
 * 管理人の表示名と、Gemini TTS の声の設定（試聴付き）を編集して保存する。
 * @param props.testingAgent 試聴中のエージェントのキー（試聴ボタンの表示に使う）
 * @param props.playLiveTtsTest 試聴する
 */
export function AdministratorTab({
  config, setConfig, saveConfig, testingAgent, playLiveTtsTest,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
  testingAgent: string | null;
  playLiveTtsTest: (agentKey: string, agent: AgentConfig) => void;
}) {
  const admin = config.agents.administrator ?? {
    name: '', prompt: '', voice: '', pan: 0, tts_engine: 'gemini',
  };
  const setAgent = (patch: Partial<AgentConfig>) => {
    setConfig({ ...config, agents: { ...config.agents, administrator: { ...admin, ...patch } } });
  };
  const currentLang = admin.gemini_language ?? '';
  const LANG_OPTIONS = [
    { label: '自動', value: '' }, { label: '日本語', value: 'ja-JP' },
    { label: 'English US', value: 'en-US' }, { label: 'English UK', value: 'en-GB' },
    { label: '中文', value: 'zh-CN' }, { label: '한국어', value: 'ko-KR' },
    { label: 'Français', value: 'fr-FR' }, { label: 'Deutsch', value: 'de-DE' },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">🤖</span>
        <h2 className="text-lg font-bold text-neon-blue">AI管理者設定</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        「💬 お問い合わせ・リクエスト」窓口に応答するアシスタントです（チャンネル切替・
        音量調整などアプリ全体の操作コマンド、コーナー・曲・話題のリクエスト、雑談・質問
        すべてに応答）。特定のチャンネルには属さず、放送中かどうかに関わらず共通で使われます。
      </p>
      <form onSubmit={saveConfig} className="flex flex-col gap-5">
        <div>
          <label>表示名</label>
          <input type="text" value={admin.name}
            onChange={e => setAgent({ name: e.target.value })} />
        </div>

        <GeminiTtsFields
          agent={admin}
          setAgent={setAgent}
          langOptions={LANG_OPTIONS}
          currentLang={currentLang}
          onTest={() => playLiveTtsTest('administrator', admin)}
          testingAgent={testingAgent}
          agentKey="administrator"
          accentColor="blue"
        />

        <button type="submit" className="btn btn-primary py-3">💾 保存</button>
      </form>
    </div>
  );
}
