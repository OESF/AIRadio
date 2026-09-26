/**
 * @file 管理画面の「録音」タブ（放送の録音の開始・停止と履歴）
 *
 * チャンネルを選んで放送を録音し、録音した履歴を再生・ダウンロード・削除する。
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

import type { RecordableChannel, RecordingEntry } from '../../types';
import { RECORDING_CHANNELS } from '../../constants';

/**
 * 録音の操作と履歴。録音・取得は親が行う。
 * @param props.recordings 録音した履歴
 */
export function RecordingTab({
  serverUrl,
  recordingChannel, setRecordingChannel, recordingActive, startProgramRecording, stopProgramRecording,
  recordingElapsedSec, recordingCurrentTarget, recordingHistory, fetchRecordingHistory,
  formatRecordingDuration, playingRecordingId, setPlayingRecordingId, deleteRecording, formatFileSize,
}: {
  serverUrl: string;
  recordingChannel: RecordableChannel;
  setRecordingChannel: (v: RecordableChannel) => void;
  recordingActive: boolean;
  startProgramRecording: () => void;
  stopProgramRecording: () => void;
  recordingElapsedSec: number;
  recordingCurrentTarget: string | null;
  recordingHistory: RecordingEntry[];
  fetchRecordingHistory: () => void;
  formatRecordingDuration: (sec: number) => string;
  playingRecordingId: string | null;
  setPlayingRecordingId: (v: string | null) => void;
  deleteRecording: (id: string) => void;
  formatFileSize: (bytes: number) => string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <span className="text-neon-blue text-xl">🎙️</span>
        <h2 className="text-lg font-bold text-neon-blue">番組録音</h2>
      </div>
      <p className="text-xs text-gray-400">
        選んだチャンネルの放送を録音します。
        Spotify楽曲の再生中（無音区間）は著作権保護のため自動的にスキップされ、録音されません。
      </p>

      {/* 録音コントロール */}
      {/* BUGFIX: 選択欄の幅は style で固定する。index.css の select { width: 100% } に w-40 が負けて、
                  選択欄が行いっぱいに広がり、ラベルやボタンが折り返された */}
      <div className="bg-black/20 border border-glass rounded-xl flex flex-col gap-2" style={{ padding: '10px 16px' }}>
        <div className="flex items-center gap-3 flex-nowrap">
          <label className="text-xs text-gray-400 flex-shrink-0">チャンネル</label>
          <select
            value={recordingChannel}
            onChange={e => setRecordingChannel(e.target.value as RecordableChannel)}
            disabled={recordingActive}
            className="input-field text-sm"
            style={{ flex: 1, padding: '4px 10px' }}
          >
            {RECORDING_CHANNELS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>

          {!recordingActive ? (
            <button onClick={startProgramRecording}
              className="btn btn-dark text-sm border border-red-500/40 hover:border-red-500 text-red-400"
              style={{ padding: '4px 14px', flexShrink: 0 }}>
              ● 録音開始
            </button>
          ) : (
            <button onClick={stopProgramRecording}
              className="btn btn-dark text-sm border border-yellow-500/60 hover:border-yellow-400 text-yellow-400 animate-pulse"
              style={{ padding: '4px 14px', flexShrink: 0 }}>
              ■ 停止
            </button>
          )}

          {recordingActive && (
            <span className="text-sm font-mono text-red-400 truncate">
              ⏺ 録音中… {formatRecordingDuration(recordingElapsedSec)}
              {recordingChannel === 'all' && (
                <> — {recordingCurrentTarget
                  ? `現在: ${RECORDING_CHANNELS.find(c => c.key === recordingCurrentTarget)?.label || recordingCurrentTarget}`
                  : '視聴者待機中'}</>
              )}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">
          ※ 放送の途中で録音を開始した場合はその時点から、番組開始前にONにしておけば開始から終了まで録音されます。
          ALLモードでは、どのチャンネルでも視聴が始まれば自動的に録音を開始し、そのチャンネルの視聴が終わった時点で
          1件の録音として履歴に確定します。停止するまでは、次に視聴が始まったチャンネルをまた自動的に録音します
          （録音内容がゼロだった場合はファイルを作成しません）。
        </p>
      </div>

      {/* 録音履歴 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-gray-300">録音履歴</h3>
          <button onClick={fetchRecordingHistory} className="btn btn-dark text-xs px-3 py-1">↻ 更新</button>
        </div>
        {recordingHistory.length === 0 ? (
          <p className="text-gray-500 text-sm">まだ録音がありません</p>
        ) : (
          <div className="flex flex-col gap-2">
            {recordingHistory.map(rec => (
              <div key={rec.id} className="rounded-xl border border-gray-600 bg-black/20" style={{ padding: '8px 12px' }}>
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-white/10 text-gray-200 uppercase">{rec.channel}</span>
                  <span className="text-sm text-gray-300">{new Date(rec.startedAt).toLocaleString('ja-JP')}</span>
                  <span className="text-xs text-gray-500 font-mono">{formatRecordingDuration(rec.durationSec)}</span>
                  {rec.skippedSec > 0 && (
                    <span className="text-xs text-gray-600">
                      （{rec.channel === 'secretary' ? '無音スキップ' : '楽曲スキップ'} {formatRecordingDuration(rec.skippedSec)}）
                    </span>
                  )}
                  <span className="text-xs text-gray-600">{formatFileSize(rec.sizeBytes)}</span>
                  <div className="flex-1" />
                  {/* BUGFIX: 余白は style で指定する。.btn の padding（12px 24px）が Tailwind の px-3 py-1 より後に
                              効いて、行の高さが膨らんでいた */}
                  <a
                    href={`${serverUrl}/api/recordings/${rec.id}/download`}
                    className="btn btn-dark"
                    style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                    title={rec.filename.endsWith('.wav') ? 'WAVをダウンロード' : 'MP3に変換してダウンロード'}
                  >⬇ {rec.filename.endsWith('.wav') ? 'WAV' : 'MP3'}</a>
                  <button
                    onClick={() => setPlayingRecordingId(playingRecordingId === rec.id ? null : rec.id)}
                    className="btn btn-dark"
                    style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                  >{playingRecordingId === rec.id ? '▲ 閉じる' : '▶ 再生'}</button>
                  <button
                    onClick={() => deleteRecording(rec.id)}
                    className="text-red-400 hover:text-red-300 text-sm"
                    title="削除"
                  >✕</button>
                </div>
                {playingRecordingId === rec.id && (
                  <audio
                    controls
                    autoPlay
                    src={`${serverUrl}/api/recordings/${rec.id}/audio`}
                    className="w-full mt-3"
                    style={{ height: '32px' }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
