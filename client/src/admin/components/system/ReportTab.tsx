/**
 * @file 管理画面の「稼働レポート」（セッションの記録・LLM と TTS の利用・概算コスト）
 *
 * サーバーの活動記録（server/activity-db.js、/api/report/*）を、4つのタブで見せる。
 * - 主要レポート: 期間とチャンネルで絞ったサマリー・チャンネル別の内訳・モデル別とエージェント別の概算コスト
 * - コストグラフ: 日ごとの概算コスト（CostChart.tsx）
 * - 視聴記録: チャンネル別の視聴の推移など（ListeningStatsPanel.tsx）
 * - セッションレポート: セッションの一覧と、1件ごとの詳細（イベントの時系列・統計）
 * データの取得と状態は App.tsx が持ち、このコンポーネントは表示と絞り込みの入力だけを受け持つ。
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
import type { ReportSession, ReportDetail, ReportSummary, ReportCostBreakdown } from '../../types';
import { REPORT_PAGE_SIZE } from '../../constants';
import { CostChart } from './CostChart';
import ListeningStatsPanel from './ListeningStatsPanel';

/**
 * 稼働レポートの中のタブ（情報が多いので分けて見せる）。
 *
 * 開いた直後はサマリーとコストの内訳だけが見える main を既定にする（セッションの一覧は見る頻度が低いため）。
 */
const REPORT_VIEWS = [
  { key: 'main',     label: '主要レポート',     icon: '📊' },
  { key: 'cost',     label: 'コストグラフ',     icon: '📈' },
  { key: 'listening', label: '視聴記録',          icon: '👂' },
  { key: 'sessions', label: 'セッションレポート', icon: '📻' },
] as const;
type ReportView = typeof REPORT_VIEWS[number]['key'];

/**
 * 稼働レポートの画面（一覧、または1つのセッションの詳細）。
 *
 * 主要レポートとセッションレポートは、上の絞り込み（チャンネル・期間）を共有し、「検索」で取り直す。
 * コストグラフと視聴記録は自分でデータを取り、期間も自分で選ぶので、この絞り込みの影響を受けない。
 *
 * @param props.reportDetail 表示中のセッションの詳細（null なら一覧を出す）
 * @param props.setReportDetail 詳細の表示を切り替える（null で一覧に戻る）
 * @param props.reportEventFilter 詳細で絞り込むイベントの種類（all ならすべて）
 * @param props.setReportEventFilter イベントの種類の絞り込みを変える
 * @param props.reportSummary 期間の集計
 * @param props.reportCostBreakdown モデル別・エージェント別の概算コスト
 * @param props.reportSessions 今のページのセッション
 * @param props.reportTotal 絞り込みに当たったセッションの総数
 * @param props.reportLoading 取得中か
 * @param props.reportPage 今のページ（0から）
 * @param props.setReportPage ページを変える
 * @param props.reportChannel 絞り込むチャンネル（all ならすべて）
 * @param props.setReportChannel 絞り込むチャンネルを変える
 * @param props.reportFrom 絞り込みの開始日（YYYY-MM-DD）
 * @param props.setReportFrom 開始日を変える
 * @param props.reportTo 絞り込みの終了日（YYYY-MM-DD）
 * @param props.setReportTo 終了日を変える
 * @param props.fetchReport 条件を指定して一覧・集計・コストを取り直す
 * @param props.fetchReportDetail 1つのセッションの詳細を取る
 * @returns 稼働レポートの要素
 */
export function ReportTab({
  reportDetail, setReportDetail, reportEventFilter, setReportEventFilter, reportSummary,
  reportCostBreakdown,
  reportSessions, reportTotal, reportLoading, reportPage, setReportPage,
  reportChannel, setReportChannel, reportFrom, setReportFrom, reportTo, setReportTo,
  fetchReport, fetchReportDetail,
}: {
  reportDetail: ReportDetail | null;
  setReportDetail: (v: ReportDetail | null) => void;
  reportEventFilter: string;
  setReportEventFilter: (v: string) => void;
  reportSummary: ReportSummary | null;
  reportCostBreakdown: ReportCostBreakdown | null;
  reportSessions: ReportSession[];
  reportTotal: number;
  reportLoading: boolean;
  reportPage: number;
  setReportPage: (v: number) => void;
  reportChannel: string;
  setReportChannel: (v: string) => void;
  reportFrom: string;
  setReportFrom: (v: string) => void;
  reportTo: string;
  setReportTo: (v: string) => void;
  fetchReport: (page?: number, channel?: string, from?: string, to?: string) => void;
  fetchReportDetail: (id: number) => void;
}) {
  const [view, setView] = useState<ReportView>('main');
  // コストグラフと視聴記録は自分でデータを取るので、ヘッダーの「更新」では取り直されない。
  // key を変えて作り直すことで、どのタブにいても「更新」が効くようにする。
  const [costReloadKey, setCostReloadKey] = useState(0);
  const fmtMs = (ms: number | null) => {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };
  const fmtTime = (ts: number) => new Date(ts).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const channelColor: Record<string, string> = {
    live: 'text-purple-300 bg-purple-900/40 border-purple-700/40',
    classic: 'text-amber-300 bg-amber-900/40 border-amber-700/40',
    jazz: 'text-orange-300 bg-orange-900/40 border-orange-700/40',
    mood: 'text-blue-300 bg-blue-900/40 border-blue-700/40',
    beatles: 'text-red-300 bg-red-900/40 border-red-700/40',
  };
  const EVENT_TYPES = [
    'all', 'song_played', 'llm_chat', 'llm_image',
    'tts_gemini', 'tts_aivis', 'corner', 'agent_speaking',
    'system_error',
  ];
  const eventLabel: Record<string, string> = {
    all: 'すべて', song_played: '🎵 曲再生', llm_chat: '🤖 LLM会話', llm_image: '🖼️ LLM画像',
    tts_gemini: '🔊 Gemini TTS', tts_aivis: '🔊 AivisSpeech',
    corner: '📻 コーナー', agent_speaking: '🎙 発話',
    system_error: '⚠️ エラー',
  };
  const eventColor: Record<string, string> = {
    song_played: 'text-emerald-400', llm_chat: 'text-purple-400',
    llm_image: 'text-pink-400', tts_gemini: 'text-cyan-400', tts_aivis: 'text-amber-400',
    corner: 'text-indigo-400', agent_speaking: 'text-gray-400',
    system_error: 'text-red-400',
  };

  if (reportDetail) {
    // ── 詳細ビュー ──
    const { session, events, stats, cornerBreakdown, agentBreakdown } = reportDetail;
    const filteredEvents = reportEventFilter === 'all' ? events : events.filter(e => e.event_type === reportEventFilter);
    const durMs = session.ended_at ? session.ended_at - session.started_at : null;
    return (
      <div className="flex flex-col gap-5">
        {/* ヘッダー */}
        <div className="flex items-center gap-3 border-b border-glass pb-4 flex-wrap">
          <button type="button" onClick={() => setReportDetail(null)}
            className="text-gray-400 hover:text-white text-sm px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/30 transition-colors">
            ← 一覧に戻る
          </button>
          <span className={`text-xs font-bold px-2 py-1 rounded border ${channelColor[session.channel] ?? 'text-gray-300 bg-gray-800 border-gray-700'}`}>
            {session.channel.toUpperCase()}
          </span>
          <h2 className="text-lg font-bold text-white">セッション #{session.id}</h2>
          <span className="text-sm text-gray-400">{fmtTime(session.started_at)}</span>
          {durMs && <span className="text-sm text-gray-400">({fmtMs(durMs)})</span>}
          {!session.ended_at && <span className="text-xs text-green-400 border border-green-700/50 bg-green-900/30 px-2 py-0.5 rounded-full">進行中</span>}
        </div>

        {/* 統計カード */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {[
            { label: '再生曲数', val: stats.songs, icon: '🎵', col: 'text-emerald-400' },
            { label: 'LLM会話', val: stats.llm_chat, icon: '🤖', col: 'text-purple-400' },
            { label: 'LLM画像', val: stats.llm_image, icon: '🖼️', col: 'text-pink-400' },
            { label: 'Gemini TTS', val: stats.tts_gemini, icon: '🔊', col: 'text-cyan-400' },
            { label: 'AivisSpeech', val: stats.tts_aivis, icon: '🔊', col: 'text-amber-400' },
            { label: 'コーナー', val: stats.corners, icon: '📻', col: 'text-indigo-400' },
            { label: 'エラー', val: stats.errors, icon: '⚠️', col: stats.errors > 0 ? 'text-red-400' : 'text-gray-600' },
          ].map(({ label, val, icon, col }) => (
            <div key={label} className="rounded-xl border border-white/10 bg-white/3 flex flex-col gap-1" style={{ padding: '12px' }}>
              <span className="text-xs text-gray-500">{icon} {label}</span>
              <span className={`text-2xl font-bold ${col}`}>{val ?? 0}</span>
            </div>
          ))}
        </div>

        {/* 平均応答時間 */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'LLM平均応答', ms: stats.llm_chat > 0 ? Math.round((stats.llm_chat_ms ?? 0) / stats.llm_chat) : null },
            { label: 'Gemini TTS平均', ms: stats.tts_gemini > 0 ? Math.round((stats.tts_gemini_ms ?? 0) / stats.tts_gemini) : null },
            { label: 'AivisSpeech平均', ms: stats.tts_aivis > 0 ? Math.round((stats.tts_aivis_ms ?? 0) / stats.tts_aivis) : null },
            { label: '発話回数', ms: null, extra: `${stats.agent_turns ?? 0}回` },
          ].map(({ label, ms, extra }) => (
            <div key={label} className="rounded-xl border border-white/10 bg-white/3" style={{ padding: '12px' }}>
              <span className="text-xs text-gray-500">{label}</span>
              <div className="text-base font-bold text-white mt-1">{extra ?? (ms != null ? `${ms}ms` : '—')}</div>
            </div>
          ))}
        </div>

        {/* コーナー内訳 + エージェント発話 */}
        {(cornerBreakdown.length > 0 || agentBreakdown.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {cornerBreakdown.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-white/3 flex flex-col gap-2" style={{ padding: '16px' }}>
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">📻 コーナー別回数</span>
                <div className="flex flex-col gap-1">
                  {cornerBreakdown.map(({ name, cnt }) => (
                    <div key={name ?? 'unknown'} className="flex items-center gap-2">
                      <span className="text-xs text-gray-300 flex-1 truncate">{name ?? '不明'}</span>
                      <span className="text-xs font-bold text-indigo-400 shrink-0">{cnt}回</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {agentBreakdown.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-white/3 flex flex-col gap-2" style={{ padding: '16px' }}>
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">🎙 エージェント発話回数</span>
                <div className="flex flex-col gap-1">
                  {agentBreakdown.map(({ agent, cnt }) => (
                    <div key={agent} className="flex items-center gap-2">
                      <span className="text-xs text-gray-300 flex-1 truncate">{agent}</span>
                      <span className="text-xs font-bold text-gray-400 shrink-0">{cnt}回</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* イベントタイムライン */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-gray-300">イベント ({filteredEvents.length}件)</span>
            <div className="flex gap-1 flex-wrap">
              {EVENT_TYPES.map(t => (
                <button key={t} type="button"
                  onClick={() => setReportEventFilter(t)}
                  className={`text-xs px-2 py-1 rounded-md border transition-colors ${reportEventFilter === t ? 'bg-white/15 border-white/30 text-white' : 'border-white/10 text-gray-500 hover:text-gray-300'}`}>
                  {eventLabel[t] ?? t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 max-h-[520px] overflow-y-auto pr-1">
            {filteredEvents.length === 0
              ? <p className="text-sm text-gray-600 py-4 text-center">イベントなし</p>
              : filteredEvents.map(ev => {
                const meta = ev.metadata as Record<string, string | number | boolean> | null;
                // エージェント列（event_type 別に最適なエージェント表示を決定）
                const agentCol = (() => {
                  switch (ev.event_type) {
                    case 'llm_chat':       return ev.agent ?? '—';
                    case 'llm_image':      return (meta?.agentKey as string) ?? ev.agent ?? '—';
                    case 'tts_gemini':     return ev.agent ?? '—';
                    case 'tts_aivis':      return ev.agent ?? '—';
                    case 'agent_speaking': return ev.agent ?? '—';
                    default:               return '—';
                  }
                })();
                // 詳細列（モデル・曲名・ステータスなど）
                const detail = (() => {
                  switch (ev.event_type) {
                    case 'song_played':     return meta ? `${meta.title} — ${meta.artist}` : '';
                    case 'llm_chat':        return `${meta?.model ?? ''}${ev.chars ? ` / ${ev.chars}字` : ''}${meta?.search ? ' [検索あり]' : ''}`;
                    case 'llm_image':       return `${meta?.model ?? ''}`;
                    case 'tts_gemini':      return `${meta?.voice ?? ''}${ev.chars ? ` / ${ev.chars}字` : ''}`;
                    case 'tts_aivis':       return `${ev.chars ? `${ev.chars}字` : ''}${meta?.speakerId != null ? ` [id:${meta.speakerId}]` : ''}`;
                    case 'corner':          return meta?.name ?? '';
                    case 'agent_speaking':  return '';
                    case 'system_error':    return `code: ${meta?.code ?? '—'}`;
                    default:                return '';
                  }
                })();
                return (
                  <div key={ev.id} className="grid py-1 px-2 rounded-lg hover:bg-white/4 transition-colors text-xs font-mono"
                    style={{ gridTemplateColumns: '6rem 9rem 7rem 1fr 5rem' }}>
                    <span className="text-gray-500 truncate">
                      {new Date(ev.ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <span className={`truncate ${eventColor[ev.event_type] ?? 'text-gray-400'}`}>
                      {ev.event_type}
                    </span>
                    <span className="text-gray-400 truncate">{agentCol}</span>
                    <span className="text-gray-300 truncate">{detail}</span>
                    <span className="text-gray-600 text-right">
                      {ev.duration_ms != null ? `${ev.duration_ms}ms` : ''}
                    </span>
                  </div>
                );
              })
            }
          </div>
        </div>
      </div>
    );
  }

  // ── 一覧ビュー ──
  return (
    <div className="flex flex-col gap-5">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 border-b border-glass pb-4">
        <span className="text-xl">📊</span>
        <h2 className="text-lg font-bold text-white">稼働レポート</h2>
        <button
          type="button"
          className="ml-auto btn-dark border border-white/15 text-sm px-3 py-1.5 rounded-lg text-gray-300 hover:text-white flex items-center gap-1.5 disabled:opacity-40"
          disabled={reportLoading}
          onClick={() => {
            if (view === 'cost' || view === 'listening') setCostReloadKey(k => k + 1);
            else fetchReport(reportPage, reportChannel, reportFrom, reportTo);
          }}
        >
          <span className={reportLoading ? 'animate-spin inline-block' : ''}>🔄</span>
          更新
        </button>
      </div>

      {/* 内部タブ */}
      <div className="flex gap-2 flex-wrap">
        {REPORT_VIEWS.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`text-sm px-4 py-2 rounded-lg border transition-colors ${
              view === key
                ? 'bg-white/15 border-white/30 text-white font-bold'
                : 'border-white/10 text-gray-500 hover:text-gray-300'
            }`}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      {/* コストグラフと視聴記録は独立したデータ源（/api/report/daily-cost・
          /api/dashboard/stats）を持つため、上のフィルター（チャンネル・期間）の影響を
          受けない。それぞれ自分で期間を選ばせる。 */}
      {view === 'cost' && <CostChart key={costReloadKey} />}
      {view === 'listening' && <ListeningStatsPanel key={costReloadKey} />}

      {/* フィルター（主要レポート・セッションレポートで共有） */}
      {view !== 'cost' && view !== 'listening' && (<>
      <div className="flex items-end gap-3 flex-wrap rounded-xl border border-white/10 bg-white/3" style={{ padding: '16px' }}>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">チャンネル</label>
          <select value={reportChannel} onChange={e => setReportChannel(e.target.value)}
            className="text-sm bg-gray-800 border border-white/15 rounded-lg px-3 py-1.5 text-gray-200">
            <option value="all">すべて</option>
            <option value="live">Live</option>
            <option value="classic">Classic</option>
            <option value="jazz">Jazz</option>
            <option value="mood">Mood</option>
            <option value="beatles">Beatles</option>
            <option value="theanswers">The Answers</option>
            <option value="24you">24You</option>
            <option value="secretary">My Secretary</option>
            <option value="secretary_presentation">Secretary（プレゼン作成）</option>
            <option value="administrator">AI Radio管理人</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">開始日（From）</label>
          <input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)}
            className="text-sm bg-gray-800 border border-white/15 rounded-lg px-3 py-1.5 text-gray-200" />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">終了日（To）</label>
          <input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)}
            className="text-sm bg-gray-800 border border-white/15 rounded-lg px-3 py-1.5 text-gray-200" />
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary text-sm px-4 py-1.5"
            onClick={() => { setReportPage(0); fetchReport(0, reportChannel, reportFrom, reportTo); }}>
            🔍 検索
          </button>
          <button type="button" className="btn-dark border border-white/15 text-sm px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-200"
            onClick={() => { setReportChannel('all'); setReportFrom(''); setReportTo(''); setReportPage(0); fetchReport(0, 'all', '', ''); }}>
            リセット
          </button>
        </div>
      </div>

      {/* ── 主要レポート ─────────────────────────────────────────── */}
      {view === 'main' && (<>

      {/* サマリーカード */}
      {reportSummary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {[
            { label: 'セッション数', val: reportSummary.total_sessions, icon: '📻' },
            { label: '総聴取時間', val: fmtMs(reportSummary.total_listen_ms), icon: '⏱️' },
            { label: '総再生曲数', val: reportSummary.total_songs, icon: '🎵' },
            { label: 'LLM呼び出し', val: (reportSummary.total_llm_chat + reportSummary.total_llm_image), icon: '🤖' },
            { label: 'コーナー', val: reportSummary.total_corners, icon: '📡' },
            { label: 'エラー', val: reportSummary.total_errors, icon: '⚠️' },
          ].map(({ label, val, icon }) => (
            <div key={label} className="rounded-xl border border-white/10 bg-white/3" style={{ padding: '12px' }}>
              <div className="text-xs text-gray-500 mb-1">{icon} {label}</div>
              <div className="text-xl font-bold text-white">{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* チャンネル別内訳 */}
      {reportSummary?.byChannel && reportSummary.byChannel.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {reportSummary.byChannel.map(ch => (
            <div key={ch.channel} className={`rounded-lg border text-xs flex gap-3 items-center ${channelColor[ch.channel] ?? 'text-gray-300 bg-gray-800/60 border-gray-700/40'}`} style={{ padding: '8px 12px' }}>
              <span className="font-bold uppercase">{ch.channel}</span>
              <span>{ch.sessions}セッション</span>
              <span>{fmtMs(ch.listen_ms)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Geminiコスト内訳（モデル別・エージェント別） */}
      {reportCostBreakdown && (reportCostBreakdown.byModel.length > 0 || reportCostBreakdown.byAgent.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {([
            { title: 'モデル別コスト（概算）', rows: reportCostBreakdown.byModel },
            { title: 'エージェント別コスト（概算）', rows: reportCostBreakdown.byAgent },
          ] as const).map(({ title, rows }) => (
            <div key={title} className="rounded-xl border border-white/10 bg-white/3" style={{ padding: '12px' }}>
              <div className="text-xs text-gray-400 mb-2 font-bold">{title}</div>
              {rows.length === 0 ? (
                <p className="text-xs text-gray-600">データなし</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 text-left">
                        <th className="pb-1 pr-2">名前</th>
                        <th className="pb-1 pr-2 text-right">回数</th>
                        <th className="pb-1 pr-2 text-right">入力tok</th>
                        <th className="pb-1 pr-2 text-right">出力tok</th>
                        <th className="pb-1 pr-2 text-right">思考tok</th>
                        <th className="pb-1 text-right">概算コスト</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.key} className="border-t border-white/5">
                          <td className="py-1 pr-2 text-gray-200 font-mono">{r.key}</td>
                          <td className="py-1 pr-2 text-right text-gray-400">{r.count}</td>
                          <td className="py-1 pr-2 text-right text-gray-400">{r.promptTokens.toLocaleString()}</td>
                          <td className="py-1 pr-2 text-right text-gray-400">{r.outputTokens.toLocaleString()}</td>
                          <td className="py-1 pr-2 text-right text-gray-400">{r.thoughtsTokens.toLocaleString()}</td>
                          <td className="py-1 text-right text-white font-bold">
                            {r.costUnknown && r.costUsd === 0
                              ? <span className="text-gray-600 font-normal">不明</span>
                              : <>${r.costUsd.toFixed(4)}{r.costUnknown && <span className="text-gray-600 font-normal">+?</span>}</>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      {(() => {
                        const total = rows.reduce((acc, r) => ({
                          count: acc.count + r.count,
                          promptTokens: acc.promptTokens + r.promptTokens,
                          outputTokens: acc.outputTokens + r.outputTokens,
                          thoughtsTokens: acc.thoughtsTokens + r.thoughtsTokens,
                          costUsd: acc.costUsd + r.costUsd,
                          costUnknown: acc.costUnknown || r.costUnknown,
                        }), { count: 0, promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, costUsd: 0, costUnknown: false });
                        return (
                          <tr className="border-t border-white/20">
                            <td className="py-1 pr-2 text-gray-200 font-bold">合計</td>
                            <td className="py-1 pr-2 text-right text-gray-300 font-bold">{total.count}</td>
                            <td className="py-1 pr-2 text-right text-gray-300 font-bold">{total.promptTokens.toLocaleString()}</td>
                            <td className="py-1 pr-2 text-right text-gray-300 font-bold">{total.outputTokens.toLocaleString()}</td>
                            <td className="py-1 pr-2 text-right text-gray-300 font-bold">{total.thoughtsTokens.toLocaleString()}</td>
                            <td className="py-1 text-right text-white font-bold">
                              ${total.costUsd.toFixed(4)}{total.costUnknown && <span className="text-gray-600 font-normal">+?</span>}
                            </td>
                          </tr>
                        );
                      })()}
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-gray-600 lg:col-span-2">
            ※ Google公式料金表（2026-07時点、手動更新）を用いた概算。「思考tok」は画面に出ない
            Gemini内部の思考トークンで、出力と同じ単価で別途課金される。集計対象期間より前に
            記録されたイベント（usageMetadata未対応の旧ログ）は「不明」または合計に含まれない。
          </p>
        </div>
      )}

      </>)}

      {/* ── セッションレポート ───────────────────────────────────── */}
      {view === 'sessions' && (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">{reportTotal} セッション</span>
          {reportLoading && <span className="text-xs text-gray-500">読み込み中...</span>}
        </div>

        {/* ヘッダー行 */}
        <div className="grid text-xs text-gray-500 font-semibold px-3 py-1.5 uppercase tracking-wider"
          style={{ gridTemplateColumns: '3rem 6rem 1fr 1fr 5rem 3rem 3rem 3rem 4rem 4rem' }}>
          <span>#</span><span>CH</span><span>開始</span><span>終了</span>
          <span>時間</span><span title="再生曲数">🎵</span><span title="LLM会話">🤖</span><span title="コーナー">📻</span>
          <span title="Gemini TTS">G-TTS</span><span title="AivisSpeech">Aivis</span>
        </div>

        {reportSessions.length === 0 && !reportLoading && (
          <p className="text-sm text-gray-600 text-center py-8">セッションが見つかりません</p>
        )}

        {reportSessions.map(s => {
          const durMs = s.ended_at ? s.ended_at - s.started_at : null;
          return (
            <div key={s.id}
              onClick={() => { fetchReportDetail(s.id); setReportEventFilter('all'); }}
              className="grid items-center text-sm rounded-xl border border-white/8 bg-white/3 cursor-pointer hover:bg-white/7 hover:border-white/20 transition-all"
              style={{ gridTemplateColumns: '3rem 6rem 1fr 1fr 5rem 3rem 3rem 3rem 4rem 4rem', padding: '10px 12px' }}>
              <span className="text-gray-600 text-xs font-mono">{s.id}</span>
              <span className={`text-xs font-bold px-2 py-0.5 rounded border w-fit ${channelColor[s.channel] ?? 'text-gray-400 bg-gray-800 border-gray-700'}`}>
                {s.channel.toUpperCase()}
              </span>
              <span className="text-gray-300 text-xs">{fmtTime(s.started_at)}</span>
              <span className="text-gray-400 text-xs">{s.ended_at ? fmtTime(s.ended_at) : <span className="text-green-400">進行中</span>}</span>
              <span className="text-gray-400 text-xs">{fmtMs(durMs)}</span>
              <span className="text-emerald-400 text-xs font-bold">{s.songs}</span>
              <span className="text-purple-400 text-xs font-bold">{s.llm_chat}</span>
              <span className="text-indigo-400 text-xs font-bold">{s.corners}</span>
              <span className="text-cyan-400 text-xs font-bold">{s.tts_gemini}</span>
              <span className="text-amber-400 text-xs font-bold">{s.tts_aivis}</span>
            </div>
          );
        })}

        {/* ページネーション */}
        {reportTotal > REPORT_PAGE_SIZE && (
          <div className="flex justify-center gap-2 mt-2">
            <button type="button" disabled={reportPage === 0}
              onClick={() => { const p = reportPage - 1; setReportPage(p); fetchReport(p); }}
              className="text-sm px-4 py-1.5 rounded-lg border border-white/15 text-gray-400 hover:text-white disabled:opacity-30">
              ← 前へ
            </button>
            <span className="text-sm text-gray-500 self-center">
              {reportPage + 1} / {Math.ceil(reportTotal / REPORT_PAGE_SIZE)}
            </span>
            <button type="button" disabled={(reportPage + 1) * REPORT_PAGE_SIZE >= reportTotal}
              onClick={() => { const p = reportPage + 1; setReportPage(p); fetchReport(p); }}
              className="text-sm px-4 py-1.5 rounded-lg border border-white/15 text-gray-400 hover:text-white disabled:opacity-30">
              次へ →
            </button>
          </div>
        )}
      </div>
      )}

      </>)}
    </div>
  );
}
