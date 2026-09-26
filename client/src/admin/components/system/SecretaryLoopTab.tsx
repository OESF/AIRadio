/**
 * @file 管理画面の「自律ループ設定」タブ（秘書が裏で定期的に見張る設定）
 *
 * 秘書が会話していない間に、新着メール・間近の予定・気象の警報・ニュース・金融の変化を定期的に確かめ、
 * 伝えるべきことがあれば知らせる仕組み（lib/secretary-loop.js）の設定。確かめる間隔・静かにする時間帯・
 * 会話の後に空ける時間・金融の変化の閾値・見張る情報源を編集する。
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
import type { FullConfig, SecretaryLoopConfig } from '../../types';

/**
 * 自律ループの設定を編集して保存する。設定がまだ無ければ既定値で表示する。
 * @param props.config 管理画面の設定全体（secretary_loop を書き換える）
 */
export function SecretaryLoopTab({
  config, setConfig, saveConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
}) {
  const DEFAULT_LOOP: SecretaryLoopConfig = {
    enabled: false,
    check_interval_minutes: 20,
    quiet_hours_start: '23:00',
    quiet_hours_end: '07:00',
    cooldown_minutes_after_session: 30,
    calendar_lookahead_minutes: 30,
    finance_change_threshold_pct: 3,
    finance_fund_change_threshold_pct: 1,
    sources: { email: true, calendar: true, weather: true, news: true, finance: true },
  };
  const loop = config.secretary_loop ?? DEFAULT_LOOP;
  const setLoop = (patch: Partial<SecretaryLoopConfig>) => {
    setConfig({ ...config, secretary_loop: { ...DEFAULT_LOOP, ...loop, ...patch } });
  };
  const setSource = (key: keyof SecretaryLoopConfig['sources'], value: boolean) => {
    setLoop({ sources: { ...DEFAULT_LOOP.sources, ...loop.sources, [key]: value } });
  };
  const SOURCE_LABELS: Record<keyof SecretaryLoopConfig['sources'], string> = {
    email: '📧 新着メール', calendar: '📅 間近の予定', weather: '☀️ 気象警報・台風・地震',
    news: '📰 速報級ニュース', finance: '📈 相場の急変',
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">🔄</span>
        <h2 className="text-lg font-bold text-neon-blue">自律ループ設定</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        My Secretaryが接続していない間も、メール・予定・天気・ニュース・相場を定期的に
        チェックし、知らせる価値のある変化があれば次回接続時の挨拶でまとめて伝えます。
        判定はコード側の機械的な比較のみで行い（LLMは呼び出しません）、実際に変化が
        見つかったときだけ、まとめて1回だけAIで短い通知文を作成します。無駄なAPI利用料が
        発生しないよう設計されています。
      </p>
      <form onSubmit={saveConfig} className="flex flex-col gap-5">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={loop.enabled}
            onChange={e => setLoop({ enabled: e.target.checked })} />
          <span>自律監視ループを有効にする</span>
        </label>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label>チェック間隔（分）</label>
            <input type="number" min={5} max={180} value={loop.check_interval_minutes}
              onChange={e => setLoop({ check_interval_minutes: Number(e.target.value) || 20 })} />
            <p className="text-xs text-gray-500 mt-1">この間隔より短く呼ばれても、経過していなければ何もしません。</p>
          </div>
          <div>
            <label>セッション終了後のクールダウン（分）</label>
            <input type="number" min={0} max={180} value={loop.cooldown_minutes_after_session}
              onChange={e => setLoop({ cooldown_minutes_after_session: Number(e.target.value) || 0 })} />
            <p className="text-xs text-gray-500 mt-1">会話が終わった直後はチェックを休みます。</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label>クワイエットアワー開始</label>
            <input type="time" value={loop.quiet_hours_start}
              onChange={e => setLoop({ quiet_hours_start: e.target.value })} />
          </div>
          <div>
            <label>クワイエットアワー終了</label>
            <input type="time" value={loop.quiet_hours_end}
              onChange={e => setLoop({ quiet_hours_end: e.target.value })} />
          </div>
        </div>
        <p className="text-xs text-gray-500 -mt-3">この時間帯はチェック自体を行いません（開始・終了が同じ時刻なら無効）。</p>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label>予定の何分前から知らせるか</label>
            <input type="number" min={5} max={180} value={loop.calendar_lookahead_minutes}
              onChange={e => setLoop({ calendar_lookahead_minutes: Number(e.target.value) || 30 })} />
          </div>
          <div>
            <label>株式・指数等の変動通知閾値（%）</label>
            <input type="number" min={0.5} max={20} step={0.5} value={loop.finance_change_threshold_pct}
              onChange={e => setLoop({ finance_change_threshold_pct: Number(e.target.value) || 3 })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label>投資信託の変動通知閾値（%）</label>
            <input type="number" min={0.1} max={20} step={0.1} value={loop.finance_fund_change_threshold_pct}
              onChange={e => setLoop({ finance_fund_change_threshold_pct: Number(e.target.value) || 1 })} />
            <p className="text-xs text-gray-500 mt-1">投資信託（個人所有ファンド）は個別株ほど大きく動かないため、通常は低めに設定します。</p>
          </div>
        </div>

        <div>
          <label>チェック対象</label>
          <div className="flex flex-col gap-2 mt-2">
            {(Object.keys(SOURCE_LABELS) as Array<keyof SecretaryLoopConfig['sources']>).map(key => (
              <label key={key} className="flex items-center gap-3">
                <input type="checkbox" checked={loop.sources[key]}
                  onChange={e => setSource(key, e.target.checked)} />
                <span>{SOURCE_LABELS[key]}</span>
              </label>
            ))}
          </div>
        </div>

        <button type="submit" className="btn btn-primary py-3">💾 保存</button>
      </form>
    </div>
  );
}
