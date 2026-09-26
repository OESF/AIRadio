/**
 * @file 経済指標の取得（IMF・世界銀行・FRED・総務省 e-Stat）
 *
 * 日米と世界の経済指標（成長率・物価・失業率・債務・金利・外貨準備など）を公式の一次統計から取り、
 * プロンプトへそのまま入れられる文章にまとめる。IMF と世界銀行は API キー不要、FRED と e-Stat は
 * credentials.json（または環境変数 FRED_API_KEY・ESTAT_API_KEY）のキーがあるときだけ使う。
 *
 * キャッシュは2つ。
 * - cache: 月次・年次のデータを含む全体の文章。同じ暦日かつ24時間以内なら使い回す（日付が変わった
 *   最初の取得で更新する）。
 * - cacheDaily: FRED の日次の系列（10年債利回りなど）の1行ずつ。6時間。
 *
 * すべての取得に失敗したときは、前回の文章があればそれを返す。
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
'use strict';

const { getLogger } = require('../logger');

/** 経済指標を取得・キャッシュするサービス。 */
class EconomicService {
  constructor() {
    this.cache      = { data: null, lastFetch: 0 };
    this.cacheDaily = {}; // { [seriesId]: { line: string, ts: number } }
  }

  /**
   * キャッシュを両方とも空にする。
   *
   * @returns {void}
   */
  clear() {
    this.cache      = { data: null, lastFetch: 0 };
    this.cacheDaily = {};
  }

  /**
   * 円換算に使う実勢のドル円を取る。
   *
   * ATTENTION: 換算のレートを固定値にしないこと。放送で読む金額が実際と食い違う。
   * 取れなかったときは null を返し、呼び出し側は円換算ごと省く（古い数字を放送しないため）。
   *
   * @returns {Promise<number|null>} 1ドルあたりの円。取れなければ null
   */
  async _fetchUsdJpyRate() {
    try {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
        + 'USDJPY%3DX?interval=1d&range=2d&includePrePost=false';
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept':     'application/json',
        },
      });
      if (!res.ok) return null;
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      return Number.isFinite(price) ? price : null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      getLogger().warn(`[EcoIndicators] ドル円の取得に失敗（円換算は省きます）: ${msg}`);
      return null;
    }
  }

  /**
   * 経済指標を取り、出典と注意書きを付けた文章にして返す。
   *
   * @param {Record<string, any>} credentials 認証情報（fred.api_key・estat.api_key を使う）
   * @returns {Promise<string|null>} 経済指標の文章（何も取れず、前回の文章も無ければ null）
   */
  async fetch(credentials) {
    // ── キャッシュ判定 ──────────────────────────────────────────────────────
    // 同じ暦日かつ24時間以内ならキャッシュを返す（日付が変わった最初の取得で更新される）
    const CACHE_TTL_MS  = 24 * 3600 * 1000; // 24 時間（最大保持時間）
    const toDateStr     = (ts) => new Date(ts).toLocaleDateString('ja-JP'); // "2026/5/30"
    const nowTs         = Date.now();
    const cacheStillValid =
      this.cache.data &&
      (nowTs - this.cache.lastFetch < CACHE_TTL_MS) &&
      (toDateStr(this.cache.lastFetch) === toDateStr(nowTs)); // 同じ暦日
    if (cacheStillValid) {
      getLogger().debug('[EcoIndicators] キャッシュ使用（同日・24h以内）');
      return this.cache.data;
    }

    const creds       = credentials || {};
    const currentYear = new Date().getFullYear();

    // 年ラベル（実績 / 速報推計 / 予測）
    const yearLabel = (y) => {
      const yr = parseInt(y);
      if (yr < currentYear)   return '実績';
      if (yr === currentYear) return '速報推計';
      return '予測';
    };

    // 数値フォーマット（符号付きパーセント）
    const fmtPct = (v, signed = true) => {
      const n = Number(v);
      if (!isFinite(n)) return 'N/A';
      return (signed && n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    };

    const sections  = [];
    const usedSources = [];

    // ─── 1. IMF DataMapper API（APIキー不要）────────────────────────────────
    // 出典: IMF World Economic Outlook（WEO）— 年2回更新（4月・10月）
    const IMF_INDICATORS = [
      { id: 'NGDP_RPCH',   label: '実質GDP成長率（前年比%）',                              signed: true  },
      { id: 'PCPIPCH',     label: 'CPI インフレ率（前年比%）',                              signed: true  },
      { id: 'LUR',         label: '失業率（%）',                                           signed: false },
      { id: 'BCA_NGDPD',   label: '経常収支（対GDP比%）',                                   signed: true  },
      { id: 'GGXWDG_NGDP',        label: '政府総債務＝グロス（対GDP比%）',                                        signed: false },
      { id: 'GGXWDN_G01_GDP_PT', label: '政府純債務＝ネット・金融資産控除後（対GDP比%）',                          signed: true  },
      // バランスシートの視点: 純債務 = 総債務 − 政府が持つ金融資産。差は外貨準備・年金基金・
      // 政府系金融機関への債権などの合計で、日本は差が大きい。総債務だけを見て「財政危機」と語ると、
      // バランスシートの半分しか見ていないことになるので、両方を並べて渡す。
      { id: 'GGXCNL_NGDP',       label: '財政収支（対GDP比%）',                                                    signed: true  },
    ];
    const IMF_COUNTRIES  = { JPN: '日本', USA: '米国', WLD: '世界平均' };
    const targetYears    = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map(String);

    const imfFetched = {};
    await Promise.all(IMF_INDICATORS.map(async (ind) => {
      try {
        const url = `https://www.imf.org/external/datamapper/api/v1/${ind.id}/JPN/USA/WLD`;
        const res = await fetch(url, {
          signal:  AbortSignal.timeout(9000),
          headers: { 'Accept': 'application/json', 'User-Agent': 'AIRadio/1.0' },
        });
        if (!res.ok) return;
        const data   = await res.json();
        const values = data?.values?.[ind.id];
        if (!values) return;
        imfFetched[ind.id] = { ...ind, countries: {} };
        for (const [country, yearData] of Object.entries(values)) {
          if (!IMF_COUNTRIES[country]) continue;
          imfFetched[ind.id].countries[country] = targetYears
            .filter(y => yearData[y] != null)
            .map(y => ({ year: y, value: yearData[y], lbl: yearLabel(y) }));
        }
      } catch (e) {
        getLogger().warn(`[EcoIndicators] IMF ${ind.id}: ${e.message}`);
      }
    }));

    if (Object.keys(imfFetched).length > 0) {
      usedSources.push('IMF WEO');
      for (const country of ['JPN', 'USA', 'WLD']) {
        const rows = [];
        // IMF_INDICATORS の定義順に並べる（Promise.all の非同期解決順に依存しない）
        for (const ind of IMF_INDICATORS) {
          const indData = imfFetched[ind.id];
          if (!indData) continue;
          const cData = indData.countries[country];
          if (!cData || cData.length === 0) continue;
          const vals = cData.map(d => `${d.year}年(${d.lbl}):${fmtPct(d.value, indData.signed)}`).join('  ');
          rows.push(`  ${indData.label}: ${vals}`);
        }
        if (rows.length > 0) {
          sections.push(`【IMF WEO — ${IMF_COUNTRIES[country]}】\n${rows.join('\n')}`);
        }
      }
      getLogger().info(`[EcoIndicators] IMF: ${Object.keys(imfFetched).length} indicators`);
    }

    // ─── 2. World Bank API（APIキー不要）────────────────────────────────────
    // 出典: World Bank Open Data — 名目GDP（USD）
    try {
      const wbRes = await fetch(
        'https://api.worldbank.org/v2/country/JP;US/indicator/NY.GDP.MKTP.CD?format=json&mrv=3&per_page=10',
        { signal: AbortSignal.timeout(18000), headers: { 'User-Agent': 'AIRadio/1.0' } }
      );
      if (wbRes.ok) {
        const wbData = await wbRes.json();
        const entries = (wbData[1] || []).filter(e => e.value != null);
        if (entries.length > 0) {
          const byCountry = {};
          for (const e of entries) {
            const c = e.countryiso3code === 'JPN' ? '日本' : (e.countryiso3code === 'USA' ? '米国' : null);
            if (!c) continue;
            if (!byCountry[c]) byCountry[c] = [];
            byCountry[c].push(e);
          }
          const rows = [];
          for (const [c, es] of Object.entries(byCountry)) {
            const sorted = es.sort((a, b) => parseInt(b.date) - parseInt(a.date)).slice(0, 2);
            const vals   = sorted.map(e => `${e.date}年: ${(e.value / 1e12).toFixed(2)}兆ドル`).join('  ');
            rows.push(`  ${c}: ${vals}`);
          }
          if (rows.length > 0) {
            sections.push(`【世界銀行 — 名目GDP（USD）】\n${rows.join('\n')}`);
            usedSources.push('世界銀行');
          }
        }
      }
    } catch (e) {
      getLogger().warn(`[EcoIndicators] World Bank: ${e.message}`);
    }

    // ─── 3. FRED API（任意: credentials.json に fred.api_key を追加）───────────
    // 出典: セントルイス連銀 FRED — 米国・日本の月次/四半期公式統計
    //
    // キャッシュ戦略（シリーズ別）:
    //   monthly  = 月次発表 → 24h キャッシュ（本関数のメインキャッシュで管理）
    //   quarterly= 四半期発表 → 24h キャッシュ（同上）
    //   daily    = 日次発表（10年債利回りなど）→ 6h 別キャッシュで管理
    const fredKey = process.env.FRED_API_KEY || (creds.fred && creds.fred.api_key);
    if (fredKey) {
      // units フィールド:
      //   ''     = デフォルト（水準値・レート系はそのまま）
      //   'pc1'  = Percent Change from Year Ago（指数系をYoY変化率に変換）
      // freq フィールド:
      //   'monthly' / 'quarterly' = 24h メインキャッシュに含める
      //   'daily'                 = 6h 別キャッシュ（economicCacheDaily）で管理
      const FRED_SERIES = [
        // ── 米国（月次・四半期）──
        { id: 'A191RL1Q225SBEA', label: '実質GDP成長率（前期比年率%）',              tag: 'USA', units: '',    signed: true,  freq: 'quarterly' },
        { id: 'CPIAUCSL',        label: 'CPI 総合（前年比%）',                        tag: 'USA', units: 'pc1', signed: true,  freq: 'monthly'   },
        { id: 'CPILFESL',        label: 'コアCPI（食料・エネルギー除く、前年比%）',    tag: 'USA', units: 'pc1', signed: true,  freq: 'monthly'   },
        { id: 'PCEPILFE',        label: 'コアPCE（前年比%）',                         tag: 'USA', units: 'pc1', signed: true,  freq: 'monthly'   },
        { id: 'UNRATE',          label: '失業率（%）',                               tag: 'USA', units: '',    signed: false, freq: 'monthly'   },
        { id: 'FEDFUNDS',        label: 'FF金利（月次平均%）',                        tag: 'USA', units: '',    signed: false, freq: 'monthly'   },
        { id: 'DGS10',           label: '10年国債利回り（%）',                        tag: 'USA', units: '',    signed: false, freq: 'daily'     }, // 日次→別キャッシュ
        // ── 日本（月次・四半期）──
        { id: 'IRSTCI01JPM156N', label: '政策金利（BOJ）（%）',                       tag: 'JPN', units: '',    signed: false, freq: 'monthly'   },
        { id: 'IRLTLT01JPM156N', label: '10年国債利回り（JGB）（%）',                  tag: 'JPN', units: '',    signed: false, freq: 'monthly'   },
        { id: 'LRUN74TTJPQ156S', label: '失業率（%）',                               tag: 'JPN', units: '',    signed: false, freq: 'quarterly' },
      ];

      // 日次シリーズは 6h 別キャッシュで管理（メインキャッシュとは独立）
      const DAILY_CACHE_TTL = 6 * 3600 * 1000; // 6時間
      if (!this.cacheDaily) this.cacheDaily = {};

      const fredByTag = { USA: [], JPN: [] };
      await Promise.all(FRED_SERIES.map(async (s) => {
        try {
          // 日次シリーズ: 6h キャッシュを先にチェック
          if (s.freq === 'daily') {
            const dc = this.cacheDaily[s.id];
            if (dc && (nowTs - dc.ts < DAILY_CACHE_TTL)) {
              fredByTag[s.tag].push(dc.line);
              return;
            }
          }
          const unitsParam = s.units ? `&units=${s.units}` : '';
          const url = `https://api.stlouisfed.org/fred/series/observations` +
            `?series_id=${s.id}&api_key=${fredKey}&file_type=json` +
            `&sort_order=desc&limit=2&observation_start=2024-01-01${unitsParam}`;
          const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
          if (!res.ok) return;
          const data = await res.json();
          const obs  = (data.observations || []).filter(o => o.value !== '.' && o.value !== '');
          if (obs.length === 0) return;
          const latest = obs[0];
          const n = Number(latest.value);
          const valStr = isFinite(n)
            ? (s.signed && n >= 0 ? '+' : '') + n.toFixed(2) + '%'
            : latest.value;
          const line = `  ${s.label}: ${valStr}（${latest.date}時点）`;
          fredByTag[s.tag].push(line);
          // 日次シリーズはキャッシュに保存
          if (s.freq === 'daily') {
            this.cacheDaily[s.id] = { line, ts: nowTs };
          }
        } catch (e) {
          getLogger().warn(`[EcoIndicators] FRED ${s.id}: ${e.message}`);
        }
      }));
      const fredLabels = { USA: '米国', JPN: '日本' };
      for (const [tag, lines] of Object.entries(fredByTag)) {
        if (lines.length > 0) {
          sections.push(`【FRED（セントルイス連銀）— ${fredLabels[tag]} 詳細】\n${lines.join('\n')}`);
        }
      }
      if (fredByTag.USA.length + fredByTag.JPN.length > 0) usedSources.push('FRED');
      getLogger().info(`[EcoIndicators] FRED: ${fredByTag.USA.length} USA + ${fredByTag.JPN.length} JPN series`);
    }

    // ─── 4. 総務省 e-Stat API（credentials.json の estat.api_key）────────────
    // 出典: 総務省統計局 — 消費者物価指数（2020年基準）全国・月次
    // statsDataId: 0003427113
    // cat01 コード体系（確認済み）:
    //   0001 = 総合 / 0161 = コアCPI（生鮮食品除く）
    //   0178 = コアコアCPI（生鮮食品・エネルギー除く）/ 0167 = エネルギー
    // tab=3 = 前年同月比（%）
    // time コード形式: YYYY00MMFF（例: 2026000404 = 2026年4月）
    const estatKey = process.env.ESTAT_API_KEY || (creds.estat && creds.estat.api_key);
    if (estatKey) {
      const ESTAT_STATS_ID = '0003427113';
      const ESTAT_CPI_CATS = [
        { code: '0001', label: 'CPI 総合（前年同月比%）' },
        { code: '0161', label: 'コアCPI（生鮮食品除く、前年同月比%）' },
        { code: '0178', label: 'コアコアCPI（生鮮食品・エネルギー除く、前年同月比%）' },
        { code: '0167', label: 'エネルギー（前年同月比%）' },
      ];

      // time コード → 日本語表示（例: 2026000404 → "2026年4月"）
      const parseEStatTime = (t) => {
        const y = t.slice(0, 4);
        if (t.slice(4, 6) === '10') return `${y}年度`;
        if (t.slice(6, 8) === '00') return `${y}年（年次）`;
        return `${y}年${parseInt(t.slice(6, 8))}月`;
      };

      const estatResults = {};
      await Promise.all(ESTAT_CPI_CATS.map(async (cat) => {
        try {
          const url = `https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData` +
            `?appId=${estatKey}` +
            `&statsDataId=${ESTAT_STATS_ID}` +
            `&cdTab=3` +          // 前年同月比
            `&cdCat01=${cat.code}` +
            `&cdArea=00000` +     // 全国
            `&metaGetFlg=N&cntGetFlg=N&sectionHeaderFlg=1&replaceSpChars=0` +
            `&startPosition=1&limit=2`; // 最新2ヶ月
          const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
          if (!res.ok) return;
          const data   = await res.json();
          const values = data?.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE;
          if (!values) return;
          const arr = Array.isArray(values) ? values : [values];
          if (arr.length === 0) return;
          const latest = arr[0];
          const val    = parseFloat(latest?.['$'] ?? '0');
          const period = parseEStatTime(latest?.['@time'] ?? '');
          const sign   = val >= 0 ? '+' : '';
          estatResults[cat.code] = `  ${cat.label}: ${sign}${val.toFixed(1)}%（${period}）`;
        } catch (e) {
          getLogger().warn(`[EcoIndicators] e-Stat cat=${cat.code}: ${e.message}`);
        }
      }));

      // 定義順に並べて出力
      const estatLines = ESTAT_CPI_CATS.map(c => estatResults[c.code]).filter(Boolean);
      if (estatLines.length > 0) {
        sections.push(`【総務省 e-Stat — 消費者物価指数（CPI）全国・最新月】\n${estatLines.join('\n')}`);
        usedSources.push('e-Stat');
        getLogger().info(`[EcoIndicators] e-Stat: ${estatLines.length} CPI categories`);
      }
    }

    // ─── 5. 外貨準備・米国債の保有（FRED 経由。元は IMF・米財務省のデータ）─────────────
    // 単位はすべて百万ドル。1000で割って十億ドルにする。
    // 外貨準備は、政府の総債務と純債務の差の大部分を占める。為替介入は「無駄遣い」と報じられがちだが、
    // 取得したときより高いレートで売れば利益になるので、バランスシートの資産の側として正確に伝える。
    //
    // ATTENTION: 円換算のレートは実勢のドル円を取って使うこと（_fetchUsdJpyRate）。固定値にすると、
    // 為替が動いたときに実際と食い違う金額を放送してしまう。下の分析メモも同じ理由で、
    // 取得時のレートや債務比率といった古くなる数字は書かない。
    if (fredKey) {
      const usdJpy = await this._fetchUsdJpyRate();
      const FX_RESERVE_SERIES = [
        {
          id: 'TRESEGJPM052N',
          label: '日本 外貨準備残高（金除く）',
          note: '財務省・日銀が保有するドル・ユーロ・英ポンド等の外貨資産合計',
        },
        {
          id: 'FORTREASPOS42609',
          label: '日本の米国国債保有残高（長短合計）',
          note: '外貨準備の中核。世界最大級の米国債保有国',
        },
        {
          id: 'FORLTTREASPOS42609',
          label: '日本の米国長期国債保有残高',
          note: '10年超の長期米国債。金利リスクを受け持つ部分',
        },
      ];

      const fxRows = [];
      await Promise.all(FX_RESERVE_SERIES.map(async (s) => {
        try {
          const url = `https://api.stlouisfed.org/fred/series/observations` +
            `?series_id=${s.id}&api_key=${fredKey}&file_type=json` +
            `&sort_order=desc&limit=3`;
          const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
          if (!res.ok) return;
          const data = await res.json();
          const obs = (data.observations || []).filter(o => o.value !== '.' && o.value !== '');
          if (obs.length === 0) return;

          const latest   = obs[0];
          const prev     = obs[1];
          const valMil   = Number(latest.value);             // 百万ドル
          const valBil   = valMil / 1000;                    // 十億ドル（billion）
          const valTril  = valBil / 1000;                    // 兆ドル
          // 参考円換算（実勢のドル円。取れていなければ換算ごと省く）
          const jpyTril  = usdJpy ? Math.round(valBil * usdJpy / 10) / 100 : null; // 兆円
          const diffBil  = prev ? ((valMil - Number(prev.value)) / 1000) : null;
          const diffStr  = diffBil !== null
            ? `（前月比: ${diffBil >= 0 ? '+' : ''}${diffBil.toFixed(0)}十億ドル）`
            : '';

          fxRows.push({
            id: s.id,
            line: `  ${s.label}: ${valTril.toFixed(3)}兆ドル`
              + `${usdJpy ? `（約${jpyTril}兆円 — 1ドル${usdJpy.toFixed(2)}円で換算）` : ''}${diffStr}`
              + `\n    ※ ${s.note}`,
          });
        } catch (e) {
          getLogger().warn(`[EcoIndicators] FX Reserve ${s.id}: ${e.message}`);
        }
      }));

      if (fxRows.length > 0) {
        // 定義順に並べる
        const orderedLines = FX_RESERVE_SERIES
          .map(s => fxRows.find(r => r.id === s.id)?.line)
          .filter(Boolean);

        // 外貨準備の含み益についての分析メモを付ける
        sections.push(
          `【財務省・日銀 外貨準備（BS資産サイド）/ US Treasury データ】\n` +
          orderedLines.join('\n') +
          `\n\n  ★ 分析メモ（コメントに活用）:\n` +
          `  ・外貨準備の多くは、今より円高だった時期に積み上げられたもの\n` +
          `    （円安が進んだ分だけ、円建ての評価額は大きくなる）\n` +
          `  ・為替介入（円買い・ドル売り）は「国民の税金の浪費」ではなく\n` +
          `    「資産の売却（含み益の実現）」という側面がある\n` +
          `  ・日本の政府債務は、総債務と純債務で比率が大きく違う。その差の大部分は\n` +
          `    この外貨準備などの資産による\n` +
          `  ・BS（バランスシート）の資産サイドとして正確に捉えるべき数字\n` +
          `  ※ 具体的な比率や取得時のレートは、ここでは渡していません。数字を述べるときは\n` +
          `    上に実際の値があるものだけを使い、推測で補わないでください`
        );
        if (!usedSources.includes('FRED')) usedSources.push('FRED');
        getLogger().info(`[EcoIndicators] FX Reserves: ${fxRows.length} series`);
      }
    }

    // ─── 出力フォーマット ────────────────────────────────────────────────────
    if (sections.length === 0) {
      getLogger().warn('[EcoIndicators] 全データソースの取得に失敗（古いキャッシュがあれば使用）');
      return this.cache.data || null;
    }

    const now      = new Date();
    const dateStr  = now.toLocaleDateString('ja-JP');
    const ts       = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

    // キャッシュの有効期限を、読める形で書いておく
    const nextRefreshNote =
      `次回リフレッシュ: 翌日 or 24時間後（月次発表データのため）`;

    const notes = [
      `取得日時: ${dateStr} ${ts}（${nextRefreshNote}）`,
      'IMFデータ: 直近2年=実績、今年度=速報推計、来年度以降=予測（WEO最新版）',
      'FRED月次: 公式統計のリアルタイム実測値 / FRED日次（10年債利回り）: 6時間キャッシュ',
      'e-Stat: 総務省統計局 公式CPI（当月最新値）',
      '━━ このデータと矛盾する数字は一切使用禁止（学習データ・検索結果に関わらず） ━━',
    ].join('\n  ');

    const header = `【⚠️ 経済指標 公式一次統計データ】ソース: ${usedSources.join(' / ')}
  ${notes}`;

    const result = header + '\n\n' + sections.join('\n\n');
    this.cache = { data: result, lastFetch: nowTs };
    getLogger().info(`[EcoIndicators] Fetched OK: ${usedSources.join(', ')} (${sections.length} sections) — 次回: 翌日リフレッシュ`);
    return result;
  }
}

module.exports = EconomicService;
