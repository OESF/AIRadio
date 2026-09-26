/**
 * @file 管理画面の稼働レポートの「日ごとの概算コスト」の積み上げ棒グラフ
 *
 * 稼働レポートのモデル別・エージェント別の表が「期間全体の内訳」を見るのに対し、こちらは「いつ跳ねたか」を
 * 見るためのもの。積み上げはモデル別（コストの多い上位6件と、その他）にする。どのモデルが効いているかが
 * 分かれば、LLM のティア表のどこを見直せばよいかに直結するため。
 *
 * 描き方は「視聴記録」（ListeningStatsPanel.tsx）と同じインラインの SVG にそろえる（グラフのライブラリを増やさない）。
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

/**
 * 開発時（localhost）は API サーバーのポートへ、それ以外は同じオリジンへつなぐ（App.tsx・Dashboard.tsx と同じ）。
 */
const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3001'
  : window.location.origin;

/** GET /api/report/daily-cost の結果。 */
type DailyCost = {
  days: { date: string; total: number; costUnknown: boolean; byModel: Record<string, number>; count: number }[];
  models: string[];
  total: number;
  costUnknown: boolean;
};

/**
 * 積み上げの色。モデルは増減するので、期間全体のコストの多い順（サーバーが返す models の順）に上から割り当てる。
 * 7つ目以降は「その他」にまとめるので、7色で足りる。
 */
const SERIES_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#64748b'];
const TOP_N = 6;
const CHART_HEIGHT = 160;

/**
 * 日ごとの概算コストの積み上げ棒グラフ（1週間・1か月などの期間を切り替えられる）。
 */
export function CostChart() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DailyCost | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (d: number) => {
    setLoading(true);
    setError(null);
    fetch(`${SERVER_URL}/api/report/daily-cost?days=${d}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => setData(j))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(days); }, [days]);

  if (error) {
    return <p className="text-sm text-red-400">コストデータの取得に失敗しました（{error}）</p>;
  }
  if (!data) {
    return <p className="text-sm text-gray-500">{loading ? '読み込み中...' : 'データがありません'}</p>;
  }

  const top = data.models.slice(0, TOP_N);
  const hasOther = data.models.length > TOP_N;
  const series = hasOther ? [...top, 'その他'] : top;
  const colorOf = (name: string) => SERIES_COLORS[series.indexOf(name)] ?? SERIES_COLORS[SERIES_COLORS.length - 1];

  // 上位以外は「その他」にまとめてから積む
  const stackOf = (d: DailyCost['days'][number]) => {
    const out: Record<string, number> = {};
    for (const [model, usd] of Object.entries(d.byModel)) {
      const key = top.includes(model) ? model : 'その他';
      out[key] = (out[key] || 0) + usd;
    }
    return out;
  };

  const max = Math.max(...data.days.map((d) => d.total), 0.0001);
  const active = data.days.filter((d) => d.total > 0);
  const avg = active.length > 0 ? data.total / active.length : 0;
  const peak = data.days.reduce((a, b) => (b.total > a.total ? b : a), data.days[0]);
  const fmtUsd = (v: number) => `$${v.toFixed(v >= 1 ? 2 : 4)}`;
  const fmtDay = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  // 日数が多いと棒が細くなり、全部の日に金額と日付を出すと文字が重なる。金額は1週間の表示のときだけ全部の日に出し、
  // それより長ければいちばん使った日だけにする。日付は間引く（期間が分かるよう、最初と最後は必ず出す）
  const showAllValues = data.days.length <= 10;
  const labelEvery = data.days.length <= 10 ? 1 : data.days.length <= 32 ? 3 : 7;
  const showDayLabel = (i: number) => i === 0 || i === data.days.length - 1 || i % labelEvery === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* 期間切り替え */}
      <div className="flex items-center gap-2 flex-wrap">
        {[{ d: 7, label: '1週間' }, { d: 30, label: '1ヶ月' }, { d: 90, label: '3ヶ月' }].map(({ d, label }) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
              days === d
                ? 'bg-white/15 border-white/30 text-white'
                : 'border-white/10 text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
        {loading && <span className="text-xs text-gray-500">読み込み中...</span>}
      </div>

      {/* サマリー */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: '期間合計', val: fmtUsd(data.total) },
          { label: '1日あたり平均', val: fmtUsd(avg) },
          { label: '最も使った日', val: peak ? `${fmtDay(peak.date)}　${fmtUsd(peak.total)}` : '—' },
          { label: '呼び出し回数', val: data.days.reduce((s, d) => s + d.count, 0).toLocaleString() },
        ].map(({ label, val }) => (
          <div key={label} className="rounded-xl border border-white/10 bg-white/3" style={{ padding: '12px' }}>
            <div className="text-xs text-gray-500 mb-1">{label}</div>
            <div className="text-lg font-bold text-white" style={{ fontVariantNumeric: 'tabular-nums' }}>{val}</div>
          </div>
        ))}
      </div>

      {/* 積み上げ棒グラフ */}
      <div className="rounded-xl border border-white/10 bg-white/3" style={{ padding: '16px' }}>
        <div className="text-xs text-gray-400 mb-3 font-bold">日ごとの概算コスト（モデル別・USD）</div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', overflowX: 'auto', paddingBottom: 4 }}>
          {data.days.map((d, i) => {
            const stack = stackOf(d);
            const isPeak = peak && d.date === peak.date && d.total > 0;
            return (
              <div key={d.date}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: '1 0 22px', minWidth: 22 }}>
                <span style={{
                  fontSize: '0.58rem', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                  color: isPeak ? '#e2e8f0' : '#94a3b8', fontWeight: isPeak ? 700 : 400,
                }}>
                  {d.total > 0 && (showAllValues || isPeak) ? d.total.toFixed(2) : '\u00a0'}
                </span>
                <svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 10 ${CHART_HEIGHT}`} preserveAspectRatio="none"
                  role="img" aria-label={`${d.date} 合計${fmtUsd(d.total)}`}>
                  <rect x={0} y={CHART_HEIGHT - 1} width={10} height={1} fill="rgba(255,255,255,0.08)" />
                  {(() => {
                    let y = CHART_HEIGHT;
                    return series.map((name) => {
                      const v = stack[name];
                      if (!v || v <= 0) return null;
                      const h = (v / max) * (CHART_HEIGHT - 4);
                      y -= h;
                      return (
                        <rect key={name} x={0} y={y} width={10} height={h} fill={colorOf(name)}>
                          <title>{`${d.date}　${name}: ${fmtUsd(v)}`}</title>
                        </rect>
                      );
                    });
                  })()}
                </svg>
                <span style={{ fontSize: '0.58rem', color: '#6c7b91', whiteSpace: 'nowrap' }}>
                  {showDayLabel(i) ? fmtDay(d.date) : '\u00a0'}
                </span>
              </div>
            );
          })}
        </div>

        {/* 凡例 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
          {series.map((name) => (
            <span key={name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', color: '#cbd5e1' }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: colorOf(name), flexShrink: 0 }} />
              <span className="font-mono">{name}</span>
            </span>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-600">
        料金表（<span className="font-mono">server/lib/gemini-pricing.js</span>）に基づく概算です。
        日付はサーバーのローカル時刻（JST）で切っています。
        {data.costUnknown && ' 料金表に無いモデルの呼び出しが含まれており、その分は合計に入っていません。'}
      </p>
    </div>
  );
}
