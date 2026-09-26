/**
 * @file ダッシュボードのエージェントの顔（アバター画像）
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

import { useState } from 'react';
import { getAgentEmoji } from '../../player/utils';

interface Props {
  agentKey?: string | null;
  size?: number;
  glowColor?: string;
  active?: boolean;
}

/**
 * /avatars/{agentKey}.png を丸く表示する（プレーヤー画面と同じ規則）。画像が無ければ絵文字を出す。
 * agentKey が無い（誰も話していない）ときは「–」だけの枠を出す。
 * @param props.size 直径（px）
 * @param props.active 話している最中なら、glowColor で光らせる
 */
export default function AgentAvatar({ agentKey, size = 44, glowColor = 'rgba(157,78,221,0.5)', active = false }: Props) {
  const [errored, setErrored] = useState(false);

  if (!agentKey) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#475569', fontSize: size * 0.4, flexShrink: 0,
      }}>
        –
      </div>
    );
  }

  const commonStyle: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
    border: `2px solid ${active ? glowColor : 'rgba(255,255,255,0.12)'}`,
    boxShadow: active ? `0 0 12px ${glowColor}` : 'none',
    transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
  };

  return errored ? (
    <div style={{
      ...commonStyle, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.5, background: 'rgba(255,255,255,0.04)',
    }}>
      {getAgentEmoji(agentKey)}
    </div>
  ) : (
    <img
      key={agentKey}
      src={`/avatars/${agentKey}.png`}
      alt={agentKey}
      onError={() => setErrored(true)}
      style={commonStyle}
      draggable={false}
    />
  );
}
