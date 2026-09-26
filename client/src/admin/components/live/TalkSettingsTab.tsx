/**
 * @file 管理画面の Live「トーク設定」（キャスターとアシスタントの往復数・コーナーリクエストの上限）
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

import type { FullConfig } from '../../types';

/**
 * 2つのスライダーを表示する。保存は親のフォームが行う。
 *   - 往復の上限（conversation_exchanges、1〜4、既定 4）… キャスターが盛り上がりを見て、この範囲で調整する
 *   - キューの上限（corner_queue_max、1〜5、既定 3）… 超えたコーナーリクエストは受け付けない
 *
 * ATTENTION: 画面に出す出演者の名前は、必ず設定（config.agents）から引くこと。管理画面で変えられる。
 *        管理画面で名前を変えても追従しない。
 * @param props.config 管理画面の設定全体（show を書き換える）
 */
export function TalkSettingsTab({
  config, setConfig,
}: {
  config: FullConfig;
  setConfig: (v: FullConfig) => void;
}) {
  const casterName = config.agents?.caster?.name || 'キャスター';
  const asstName   = config.agents?.assistant?.name || 'アシスタント';
  return (
    <div>
      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-3">💬 トーク設定</h3>
      <div className="bg-black/20 border border-glass rounded-xl grid grid-cols-1 md:grid-cols-2 gap-4" style={{ padding: '16px' }}>
        <div>
          <label className="mb-1">{casterName} ↔ {asstName} の往復上限</label>
          {(() => {
            const ex = config.show.conversation_exchanges ?? 4;
            const desc = ex === 1 ? '最大1往復（テンポ重視）'
                       : ex === 2 ? '最大2往復'
                       : ex === 3 ? '最大3往復'
                       : `最大4往復（${casterName} が判断）`;
            return (
              <>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="text-xs text-gray-500 flex-shrink-0">短め</span>
                  <input
                    type="range" min="1" max="4" step="1"
                    value={ex}
                    onChange={e => setConfig({ ...config, show: { ...config.show, conversation_exchanges: Number(e.target.value) } })}
                    className="flex-1 min-w-0 accent-neon-blue"
                  />
                  <span className="text-xs text-gray-500 flex-shrink-0">長め</span>
                  <span className="text-sm font-bold font-mono text-neon-blue w-6 text-right flex-shrink-0">{ex}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">{desc} — {casterName} が会話の盛り上がりを判断して自動調整。この値は上限です。</p>
              </>
            );
          })()}
        </div>
        <div>
          <label className="mb-1">コーナーリクエスト キュー上限（Max-Q）</label>
          {(() => {
            const mq = config.show.corner_queue_max ?? 3;
            return (
              <>
                <div className="flex items-center gap-2 flex-nowrap">
                  <span className="text-xs text-gray-500 flex-shrink-0">1件</span>
                  <input
                    type="range" min="1" max="5" step="1"
                    value={mq}
                    onChange={e => setConfig({ ...config, show: { ...config.show, corner_queue_max: Number(e.target.value) } })}
                    className="flex-1 min-w-0 accent-neon-blue"
                  />
                  <span className="text-xs text-gray-500 flex-shrink-0">5件</span>
                  <span className="text-sm font-bold font-mono text-neon-blue w-6 text-right flex-shrink-0">{mq}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">最大 {mq} 件までリクエストをキューイング。上限超過時は新規リクエストを拒否します。</p>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
