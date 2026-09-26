/**
 * @file 管理画面の稼働レポートの「視聴記録」タブ（チャンネル別の視聴の推移・よく流れた曲とコーナー・リクエスト）
 *
 * 「これまでどうだったか」の統計なので、ダッシュボード（いま何が起きているか）ではなく稼働レポートに置く。
 * グラフのライブラリは入れず SVG を直接描く（棒グラフ1種類で足り、チャンネルの色もそのまま使える。読みにくい色は
 * readableOnPanel で補う）。
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

import { useEffect, useState } from 'react';
import { CHANNELS } from '../../../player/constants';
import { cornerLabel, readableOnPanel } from '../../../dashboard/constants';

// 開発時は API サーバーのポートへ、それ以外は同じオリジンへつなぐ（App.tsx・CostChart.tsx と同じ）
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : window.location.origin;

interface ChannelStat { channel: string; sessions: number; listenMs: number; songs: number }
interface TrendBucket { start: number; byChannel: Record<string, { sessions: number; listenMs: number }> }
interface TrackStat { title: string; artist: string; count: number; channels: string[] }
interface CornerStat { name: string; count: number }
interface RequestStat {
  total: number;
  byKind: Record<string, number>;
  top: { kind: string; label: string; count: number }[];
}
interface Stats {
  channels: ChannelStat[];
  trend: TrendBucket[];
  bucketDays: number;
  topTracks: TrackStat[];
  topCorners: CornerStat[];
  totalSessions: number;
  totalSongs: number;
  days: number;
  requests: RequestStat;
}

const RANGES = [
  { days: 7, label: '1週間' },
  { days: 28, label: '4週間' },
  { days: 90, label: '3か月' },
];

const REQUEST_KIND_LABELS: Record<string, string> = {
  corner: 'コーナー', music: '曲', topic: '話題', encore: 'アンコール',
};

// サーバーのセッションのチャンネル名は、表示用の ID と一部ずれる（theanswers）
const normalizeChannelId = (id: string) => (id === 'theanswers' ? 'the_answers' : id);

/**
 * チャンネルの表示名・絵文字・色。
 * @param rawId サーバーのチャンネル名
 * @returns 名前・絵文字・色
 */
function channelMeta(rawId: string) {
  const id = normalizeChannelId(rawId);
  const m = CHANNELS.find((c) => c.id === id);
  return { name: m?.name ?? id, emoji: m?.emoji ?? '📡', color: m?.color ?? '#64748b' };
}

const fmtHours = (ms: number) => {
  const h = ms / 3600000;
  return h >= 10 ? `${h.toFixed(0)}時間` : h >= 1 ? `${h.toFixed(1)}時間` : `${Math.round(ms / 60000)}分`;
};

const bucketLabel = (start: number, bucketDays: number) => {
  const d = new Date(start);
  const head = `${d.getMonth() + 1}/${d.getDate()}`;
  if (bucketDays <= 1) return head;
  const end = new Date(start + (bucketDays - 1) * 86400000);
  return `${head}–${end.getMonth() + 1}/${end.getDate()}`;
};

/**
 * 視聴記録のタブ。期間を選んで統計を取り、推移のグラフと各種の一覧を出す。
 */
export default function ListeningStatsPanel() {
  const [days, setDays] = useState(28);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setError(null);
    fetch(`${SERVER_URL}/api/dashboard/stats?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setStats(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [days]);

  return (
    <div className="glass-panel" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0' }}>聴かれかたの記録</h2>
          <p style={{ fontSize: '0.72rem', color: '#64748b' }}>
            どのチャンネルがどれだけ聴かれ、どの曲が流れたか（開発中のテスト接続も含みます）
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              style={{
                fontSize: '0.72rem', padding: '4px 12px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${days === r.days ? '#a78bfa' : 'rgba(255,255,255,0.12)'}`,
                background: days === r.days ? 'rgba(167,139,250,0.16)' : 'transparent',
                color: days === r.days ? '#c4b5fd' : '#94a3b8',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div style={{ fontSize: '0.82rem', color: 'var(--color-danger)' }}>統計を読み込めませんでした（{error}）</div>}
      {!stats && !error && <div style={{ fontSize: '0.82rem', color: '#64748b' }}>集計中…</div>}

      {stats && (
        <>
          <TrendChart stats={stats} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, alignItems: 'start' }}>
            <ChannelTable channels={stats.channels} />
            <TrackRanking tracks={stats.topTracks} />
            <CornerRanking corners={stats.topCorners} />
            <RequestSummary requests={stats.requests} />
          </div>
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '0.68rem', color: '#94a3b8', letterSpacing: '0.06em',
      fontWeight: 700, marginBottom: 8,
    }}>
      {children}
    </div>
  );
}

/** 期間ごとの視聴時間をチャンネル別に積み上げた棒グラフ。 */
function TrendChart({ stats }: { stats: Stats }) {
  const H = 120;
  const buckets = stats.trend;
  if (buckets.length === 0) {
    return <div style={{ fontSize: '0.82rem', color: '#64748b' }}>この期間の記録はまだありません。</div>;
  }
  const totals = buckets.map((b) => Object.values(b.byChannel).reduce((s, v) => s + v.listenMs, 0));
  const max = Math.max(...totals, 1);
  // 凡例は、この期間に実際に出てきたチャンネルだけを、視聴時間の多い順に出す
  const order = stats.channels.map((c) => c.channel);

  return (
    <div>
      <SectionLabel>{stats.bucketDays === 1 ? '日ごとの視聴時間' : `${stats.bucketDays}日ごとの視聴時間`}</SectionLabel>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', overflowX: 'auto', paddingBottom: 4 }}>
        {buckets.map((b) => {
          const total = Object.values(b.byChannel).reduce((s, v) => s + v.listenMs, 0);
          return (
            <div key={b.start} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: '1 0 46px', minWidth: 46 }}>
              <span style={{ fontSize: '0.62rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                {fmtHours(total)}
              </span>
              <svg width="100%" height={H} viewBox={`0 0 10 ${H}`} preserveAspectRatio="none" role="img"
                aria-label={`${bucketLabel(b.start, stats.bucketDays)} 合計${fmtHours(total)}`}>
                {(() => {
                  let y = H;
                  return order.map((ch) => {
                    const v = b.byChannel[ch];
                    if (!v || v.listenMs <= 0) return null;
                    const h = (v.listenMs / max) * (H - 2);
                    y -= h;
                    return (
                      <rect key={ch} x={0} y={y} width={10} height={h} fill={channelMeta(ch).color}>
                        <title>{`${channelMeta(ch).name}: ${fmtHours(v.listenMs)} / ${v.sessions}回`}</title>
                      </rect>
                    );
                  });
                })()}
              </svg>
              <span style={{ fontSize: '0.6rem', color: '#6c7b91', whiteSpace: 'nowrap' }}>
                {bucketLabel(b.start, stats.bucketDays)}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
        {order.map((ch) => {
          const m = channelMeta(ch);
          return (
            <span key={ch} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', color: readableOnPanel(m.color) }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: m.color, flexShrink: 0 }} />
              {m.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ChannelTable({ channels }: { channels: ChannelStat[] }) {
  const max = Math.max(...channels.map((c) => c.listenMs), 1);
  return (
    <div>
      <SectionLabel>チャンネル別の合計</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {channels.map((c) => {
          const m = channelMeta(c.channel);
          return (
            <div key={c.channel} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.74rem' }}>
                <span style={{ color: readableOnPanel(m.color), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.emoji} {m.name}
                </span>
                <span style={{ color: '#94a3b8', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtHours(c.listenMs)} ・ {c.sessions}回{c.songs > 0 ? ` ・ ${c.songs}曲` : ''}
                </span>
              </div>
              <div style={{ height: 5, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${(c.listenMs / max) * 100}%`, height: '100%', background: m.color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrackRanking({ tracks }: { tracks: TrackStat[] }) {
  return (
    <div>
      <SectionLabel>よく流れた曲</SectionLabel>
      {tracks.length === 0 ? (
        <div style={{ fontSize: '0.74rem', color: '#64748b' }}>この期間に流れた曲はまだありません。</div>
      ) : (
        <ol style={{ display: 'flex', flexDirection: 'column', gap: 5, listStyle: 'none' }}>
          {tracks.map((t, i) => (
            <li key={`${t.title}-${t.artist}-${i}`} style={{ display: 'flex', gap: 8, fontSize: '0.74rem', alignItems: 'baseline' }}>
              <span style={{ color: '#475569', width: '1.4em', textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <span style={{ color: '#e2e8f0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                title={`${t.title} — ${t.artist}`}>
                {t.title}<span style={{ color: '#64748b' }}> — {t.artist || 'アーティスト不明'}</span>
              </span>
              <span style={{ color: '#94a3b8', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{t.count}回</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CornerRanking({ corners }: { corners: CornerStat[] }) {
  const max = Math.max(...corners.map((c) => c.count), 1);
  return (
    <div>
      <SectionLabel>放送されたコーナー（Live）</SectionLabel>
      {corners.length === 0 ? (
        <div style={{ fontSize: '0.74rem', color: '#64748b' }}>この期間に放送されたコーナーはまだありません。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {corners.map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.74rem' }}>
              <span style={{ color: '#cbd5e1', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>
                {c.name}
              </span>
              <span style={{ width: 60, height: 5, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
                <span style={{ display: 'block', width: `${(c.count / max) * 100}%`, height: '100%', background: '#a78bfa' }} />
              </span>
              <span style={{ color: '#94a3b8', flexShrink: 0, width: '2.6em', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{c.count}回</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RequestSummary({ requests }: { requests: RequestStat }) {
  return (
    <div>
      <SectionLabel>リクエスト・アンコール</SectionLabel>
      {!requests || requests.total === 0 ? (
        <div style={{ fontSize: '0.74rem', color: '#64748b', lineHeight: 1.6 }}>
          まだ記録がありません。<br />
          コーナー・曲・話題のリクエストと、音楽チャンネルの「もう一度」を、
          この期間ぶん数えて表示します。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(requests.byKind).map(([kind, n]) => (
              <span key={kind} style={{
                fontSize: '0.7rem', color: '#fcd34d', border: '1px solid rgba(252,211,77,0.35)',
                borderRadius: 999, padding: '2px 9px',
              }}>
                {REQUEST_KIND_LABELS[kind] ?? kind} {n}件
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {requests.top.slice(0, 6).map((t, i) => (
              <div key={`${t.kind}-${t.label}-${i}`} style={{ display: 'flex', gap: 8, fontSize: '0.74rem' }}>
                <span style={{ color: '#64748b', flexShrink: 0 }}>{REQUEST_KIND_LABELS[t.kind] ?? t.kind}</span>
                <span style={{ color: '#e2e8f0', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.kind === 'corner' ? cornerLabel(t.label) : t.label}
                </span>
                <span style={{ color: '#94a3b8', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{t.count}回</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
