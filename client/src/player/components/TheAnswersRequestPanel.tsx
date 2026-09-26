/**
 * @file The Answers（プレーヤー画面）の議題・時間、出演者の3Dカルーセル、参加（挙手と発言）
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

import type { TheAnswersPanelMember, TheAnswersHandState, TheAnswersRoundTimer } from '../types';

/**
 * 「名前（役職）」の形の名前を、役職と名前に分ける（カルーセルの狭いラベルに2段で出すため）。
 * 括弧は半角・全角のどちらでもよい。
 * @param fullName 設定の名前
 * @returns 役職が無ければ title は null
 */
function splitNameTitle(fullName: string): { title: string | null; name: string } {
  const m = fullName.match(/^(.*?)[（(]([^）)]*)[）)]\s*$/);
  if (!m) return { title: null, name: fullName.trim() };
  return { title: m[2].trim(), name: m[1].trim() };
}

/**
 * The Answers のパネル。状態と操作は useTheAnswers が持つ。
 * @param props.carouselRotation カルーセルの回転の角度（度）
 */
export function TheAnswersRequestPanel({
  theme, roundTimer, closing, panel, carouselRotation, activeSpeaker,
  avatarErrors, onAvatarError,
  handState, textInput, onTextInputChange, onRaiseHand, onSubmitText,
}: {
  theme: string | null;
  roundTimer: TheAnswersRoundTimer | null;
  closing: boolean;
  panel: TheAnswersPanelMember[];
  carouselRotation: number;
  activeSpeaker: string | null;
  avatarErrors: Set<string>;
  onAvatarError: (key: string) => void;
  handState: TheAnswersHandState;
  textInput: string;
  onTextInputChange: (v: string) => void;
  onRaiseHand: () => void;
  onSubmitText: () => void;
}) {
  const count        = panel.length;
  const anglePerItem = count > 0 ? 360 / count : 0;
  const RADIUS  = count <= 3 ? 100 : count <= 5 ? 130 : 155;
  const ITEM_SIZE = 82;

  return (
    <>
      {/* The Answers: テーマ・タイマー */}
      <fieldset className="glass-fieldset">
        <legend>
          <span className="text-xl">🗣️</span>
          <span className="text-base font-normal text-gray-300">議論のテーマ</span>
        </legend>
        {/* BUGFIX: 長い議題でも列の幅を広げない（overflowWrap: anywhere）。区切りの無い英数字や URL が混ざると、
            折り返せずに箱の外へはみ出した */}
        <p className="text-base text-white font-semibold mt-1" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {theme || 'テーマ整理中…'}
        </p>
        {roundTimer && roundTimer.capMs > 0 && (
          <div className="mt-2">
            <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-cyan-500/70 transition-all"
                style={{ width: `${Math.min(100, (roundTimer.elapsedMs / roundTimer.capMs) * 100)}%` }} />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {roundTimer.elapsedMs >= roundTimer.targetMs
                ? '予定時間を超過'
                : `残り約${Math.ceil((roundTimer.targetMs - roundTimer.elapsedMs) / 60000)}分`}
              {closing && '（まとめに入っています）'}
            </p>
          </div>
        )}
      </fieldset>

      {/* 出演者の3Dカルーセル。話している人が正面に来るよう、リング全体を rotateY で回す（角度は useTheAnswers が更新する） */}
      {panel.length > 0 && (
        <fieldset className="glass-fieldset">
          <legend>
            <span className="text-xl">🎙️</span>
            <span className="text-base font-normal text-gray-300">パネリスト</span>
          </legend>
          <div className="mt-3" style={{ position: 'relative', height: 120, perspective: '1100px' }}>
            <div style={{
              position: 'absolute', inset: 0,
              transformStyle: 'preserve-3d',
              transform: `rotateY(${carouselRotation}deg)`,
              transition: 'transform 0.7s cubic-bezier(0.25, 0.8, 0.3, 1)',
            }}>
              {panel.map((p, i) => {
                const baseAngle = i * anglePerItem;
                // 今の向き（回転を含む）を0〜360度にし、正面にどれだけ近いかで大きさと濃さを変える
                // （cos は正面で1、真裏で-1）
                const effectiveAngle = ((baseAngle + carouselRotation) % 360 + 360) % 360;
                const depth   = Math.cos(effectiveAngle * Math.PI / 180);
                const depthT  = (depth + 1) / 2; // 0(裏)〜1(正面)
                const scale   = 0.6 + 0.4 * depthT;
                const opacity = 0.35 + 0.65 * depthT;
                const isActive = activeSpeaker === p.key;
                return (
                  <div key={p.key} style={{
                    position: 'absolute', left: '50%', top: '50%',
                    width: ITEM_SIZE,
                    transform: `translate(-50%, -50%) rotateY(${baseAngle}deg) translateZ(${RADIUS}px)`,
                  }}>
                    <div className="flex flex-col items-center gap-1" style={{
                      transform: `scale(${scale})`,
                      opacity,
                      zIndex: Math.round(depthT * 100),
                      transition: 'transform 0.7s cubic-bezier(0.25, 0.8, 0.3, 1), opacity 0.7s',
                    }}>
                      {!avatarErrors.has(p.sourceAgentKey) ? (
                        <img src={`/avatars/${p.sourceAgentKey}.png`} alt={p.name}
                          onError={() => onAvatarError(p.sourceAgentKey)}
                          style={{
                            width: ITEM_SIZE, height: ITEM_SIZE, objectFit: 'contain',
                            filter: isActive
                              ? 'drop-shadow(0 0 6px rgba(34,211,238,0.9)) drop-shadow(0 0 14px rgba(34,211,238,0.6))'
                              : 'none',
                            transition: 'filter 0.3s',
                          }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-white/10 rounded-full" style={{ fontSize: ITEM_SIZE * 0.35 }}>🎙️</div>
                      )}
                      {(() => {
                        const { title, name } = splitNameTitle(p.name);
                        return (
                          <span className="flex flex-col items-center leading-tight" style={{ width: ITEM_SIZE }}>
                            {title && (
                              <span className="text-[9px] text-gray-500 text-center truncate w-full">{title}</span>
                            )}
                            <span className="text-[10px] text-gray-300 text-center truncate w-full">{name}</span>
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </fieldset>
      )}

      {/* The Answers: 参加（挙手して発言権を得てから送信） */}
      <fieldset className="glass-fieldset">
        <legend>
          <span className="text-xl">✋</span>
          <span className="text-base font-normal text-gray-300">議論に参加する</span>
        </legend>
        <div className="mt-3 flex flex-col gap-2">
          <button onClick={onRaiseHand} disabled={handState !== 'idle'}
            className="btn btn-dark w-full text-sm">
            {handState === 'idle' ? '✋ 手を挙げる'
              : handState === 'waiting' ? '⏳ 順番待ち…' : '🎤 どうぞ！'}
          </button>
          <textarea
            value={textInput}
            onChange={e => onTextInputChange(e.target.value)}
            placeholder={
              handState === 'granted' ? 'ご意見をどうぞ（送信すると番組で紹介されます）'
                : handState === 'waiting' ? '順番をお待ちください…'
                : 'まず「✋ 手を挙げる」を押してから発言できます'
            }
            rows={2}
            disabled={handState !== 'granted'}
            className="input-field w-full text-sm"
            style={{ resize: 'none' }}
          />
          <button onClick={onSubmitText}
            disabled={!textInput.trim() || handState !== 'granted'}
            className="btn btn-dark w-full text-sm">
            送信
          </button>
        </div>
      </fieldset>
    </>
  );
}
