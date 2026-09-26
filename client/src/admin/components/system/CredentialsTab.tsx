/**
 * @file 管理画面の「システム接続設定」（各サービスの鍵と連携、Gmail のフィルター、地震速報、ngrok）
 *
 * Gemini・Google（カレンダー・Gmail・タスク・Drive・スプレッドシート・スライド）・YouTube・LINE・
 * Spotify・OpenWeatherMap の鍵と連携、Gmail のフィルター、緊急地震速報、ngrok の自動起動を、
 * 折りたたみの節ごとに並べる。
 *
 * 鍵などは creds（server/data/credentials.json）に、フィルターなどの設定は config（config.json）に入る。
 * 保存は親から渡される saveCredentials と saveConfig が行う。Google・YouTube・Spotify は、保存の有無ではなく
 * 実際に許可されている権限をサーバーに問い合わせて（/api/<service>/status）表示する。
 *
 * ATTENTION: 秘密の値（API キー・シークレット・トークン）の入力欄は type="password" にし、保存済みのときは
 * 値ではなく伏せ字を placeholder に出す。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-20
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Database, Calendar, Music } from 'lucide-react';
import type { FullConfig, Credentials, GmailFilter, EarthquakeFilter } from '../../types';
import { GEMINI_MODELS, GEMINI_IMAGE_MODELS, PREFECTURES } from '../../constants';
import { AccordionSection } from '../AccordionSection';

/**
 * 「システム接続設定」のタブ。節ごとの折りたたみは親（openCredsSections・toggleCredsSection）が持つ。
 *
 * @param props.serverUrl サーバーの URL（許可状況の確認と、サインインのリンクに使う）
 * @param props.config 管理画面の設定全体（Gmail のフィルター・地震速報・ngrok を書き換える）
 * @param props.setConfig 設定を差し替える
 * @param props.saveConfig 設定を保存する（フォームの送信で creds と一緒に呼ぶ）
 * @param props.creds 各サービスの鍵と連携の情報
 * @param props.setCreds 鍵と連携の情報を差し替える
 * @param props.saveCredentials 鍵と連携の情報を保存する
 * @param props.openCredsSections 今開いている節の id
 * @param props.toggleCredsSection 節の開閉を切り替える
 */
export function CredentialsTab({
  serverUrl,
  config, setConfig, saveConfig,
  creds, setCreds, saveCredentials, openCredsSections, toggleCredsSection,
}: {
  serverUrl: string;
  config: FullConfig | null;
  setConfig: (v: FullConfig) => void;
  saveConfig: (e: FormEvent) => void;
  creds: Credentials;
  setCreds: (v: Credentials) => void;
  saveCredentials: (e: FormEvent) => void;
  openCredsSections: Set<string>;
  toggleCredsSection: (id: string) => void;
}) {
  // Google 連携で実際に許可されている権限。入力欄だけでは保存されているかしか分からないため。
  // サーバーが refresh_token を access_token に交換し、Google に問い合わせた結果なので、こちらが
  // 要求したつもりの権限ではなく、本当に許可されているものが出る
  const [googleStatus, setGoogleStatus] = useState<
    { connected: boolean; scopes?: { label: string; granted: boolean }[]; error?: string } | null
  >(null);
  const [googleStatusLoading, setGoogleStatusLoading] = useState(false);
  const fetchGoogleStatus = () => {
    setGoogleStatusLoading(true);
    fetch(`${serverUrl}/api/google/status`)
      .then(r => r.json())
      .then(setGoogleStatus)
      .catch(() => setGoogleStatus({ connected: false, error: '確認に失敗しました' }))
      .finally(() => setGoogleStatusLoading(false));
  };
  useEffect(() => {
    // ATTENTION: queueMicrotask で1回ずらして呼ぶ。直接呼ぶと、中の setState が effect と同じ流れで
    // 動いてしまい、react-hooks/set-state-in-effect（描き直しの連鎖を避ける決まり）に引っかかる
    if (openCredsSections.has('google')) queueMicrotask(fetchGoogleStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCredsSections.has('google')]);

  // YouTube 連携で実際に許可されている権限。
  // ATTENTION: Google 本体の連携とは別の認可・別の refresh_token。YouTube の権限を Google の権限と一緒に
  // 要求すると、Google が「一緒には要求できない」と断る（server/routes/oauth-routes.js 参照）
  const [youtubeStatus, setYoutubeStatus] = useState<
    { connected: boolean; scopes?: { label: string; granted: boolean }[]; error?: string } | null
  >(null);
  const [youtubeStatusLoading, setYoutubeStatusLoading] = useState(false);
  const fetchYoutubeStatus = () => {
    setYoutubeStatusLoading(true);
    fetch(`${serverUrl}/api/youtube/status`)
      .then(r => r.json())
      .then(setYoutubeStatus)
      .catch(() => setYoutubeStatus({ connected: false, error: '確認に失敗しました' }))
      .finally(() => setYoutubeStatusLoading(false));
  };
  useEffect(() => {
    // ずらして呼ぶ理由は、上の Google の方の ATTENTION 参照
    if (openCredsSections.has('youtube')) queueMicrotask(fetchYoutubeStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCredsSections.has('youtube')]);

  // Spotify 連携で実際に許可されている権限（Google と同じ理由・同じ作り）
  const [spotifyStatus, setSpotifyStatus] = useState<
    { connected: boolean; scopes?: { label: string; granted: boolean }[]; error?: string } | null
  >(null);
  const [spotifyStatusLoading, setSpotifyStatusLoading] = useState(false);
  const fetchSpotifyStatus = () => {
    setSpotifyStatusLoading(true);
    fetch(`${serverUrl}/api/spotify/status`)
      .then(r => r.json())
      .then(setSpotifyStatus)
      .catch(() => setSpotifyStatus({ connected: false, error: '確認に失敗しました' }))
      .finally(() => setSpotifyStatusLoading(false));
  };
  useEffect(() => {
    // ずらして呼ぶ理由は、上の Google の方の ATTENTION 参照
    if (openCredsSections.has('spotify')) queueMicrotask(fetchSpotifyStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCredsSections.has('spotify')]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: "20px" }}>
        <Database className="w-5 h-5 text-neon-blue" />
        <h2 className="text-lg font-bold text-neon-blue">システム接続設定</h2>
      </div>

      <div className="bg-black/20 rounded-xl" style={{ padding: '20px' }}>
      {/* BUGFIX: 送信では creds と config の両方を保存する。creds だけを保存していたころ、同じフォームの中に
          ある Gmail のフィルターなど config 側の変更が、まったく送られていなかった */}
      <form onSubmit={(e) => { saveCredentials(e); saveConfig(e); }} className="flex flex-col gap-6">

        {/* Gemini（鍵・読み上げのモデル・文のモデル・画像のモデル） */}
        <AccordionSection id="gemini" title="🤖 Gemini Live / Text API" open={openCredsSections.has('gemini')} onToggle={toggleCredsSection}>
          <div>
            <label>Gemini API Key</label>
            <input type="password"
              placeholder={creds.gemini.api_key ? '●●●●●●●● (保存済み)' : 'AIzaSy...'}
              value={creds.gemini.api_key}
              onChange={e => setCreds({ ...creds, gemini: { ...creds.gemini, api_key: e.target.value } })}
            />
          </div>
          <div>
            <label>Gemini TTS モデル（全チャンネル共通）</label>
            <input type="text"
              placeholder="gemini-3.1-flash-tts-preview"
              value={creds.gemini.tts_model ?? ''}
              onChange={e => setCreds({ ...creds, gemini: { ...creds.gemini, tts_model: e.target.value || undefined } })}
            />
            <p className="text-xs text-gray-500 mt-1">空欄の場合は <code>gemini-3.1-flash-tts-preview</code> が使用されます</p>
          </div>
          <div>
            <label>Gemini テキスト生成モデル（全チャンネル共通デフォルト）</label>
            <select value={creds.gemini.model ?? 'gemini-2.5-flash'}
              onChange={e => setCreds({ ...creds, gemini: { ...creds.gemini, model: e.target.value || undefined } })}
            >
              {GEMINI_MODELS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              エージェントごとに個別設定がない場合に使用されます。デバッグ中は <code className="text-neon-blue mx-1">gemini-2.5-flash</code> を推奨。
            </p>
          </div>
          <div>
            <label>Gemini 画像生成モデル / Nano Banana（全チャンネル共通デフォルト）</label>
            <select value={creds.gemini.image_model ?? 'gemini-2.5-flash-image'}
              onChange={e => setCreds({ ...creds, gemini: { ...creds.gemini, image_model: e.target.value || undefined } })}
            >
              {GEMINI_IMAGE_MODELS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              ドレミのレシピ画像やSecretaryのプレゼン資料など、画像生成が必要な場面すべてで使用される唯一の設定です。
            </p>
          </div>
        </AccordionSection>

        {/* Google 連携（OAuth2） */}
        <AccordionSection id="google" title={<span className="flex items-center gap-2"><Calendar className="w-4 h-4 text-cyan-400" /> Google Calendar / Gmail / Tasks / Drive / Sheets / Slides 連携 (OAuth2){creds.google.refresh_token ? <span className="ml-1 text-xs text-green-400 font-normal">✓ 認証済み</span> : null}</span>} open={openCredsSections.has('google')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            My Secretaryから予定の追加・メール下書きの作成・タスクの追加・Driveファイルの
            作成/更新・Googleスプレッドシートの読み取りができるよう、複数の権限で連携します。
            下の「実際の許可状況」で、今どの権限が使える状態か確認できます。<span className="text-yellow-500/80">
            以前古いスコープで連携済みの場合や、新しい機能追加でスコープが増えた場合は、
            その権限が「未許可」と表示されるので、一度サインインし直してください。</span>
          </p>

          {/* 実際に許可されている権限の一覧（サーバーが Google に問い合わせた結果） */}
          <div className="bg-black/20 border border-glass rounded-lg px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-gray-300">実際の許可状況</span>
              <button
                onClick={fetchGoogleStatus}
                disabled={googleStatusLoading}
                className="btn btn-dark text-xs px-2 py-1 border border-glass text-gray-400"
              >
                {googleStatusLoading ? '確認中…' : '🔄 更新'}
              </button>
            </div>
            {googleStatus === null || googleStatusLoading ? (
              <p className="text-xs text-gray-600">確認中…</p>
            ) : !googleStatus.connected ? (
              <p className="text-xs text-gray-600">
                {googleStatus.error ? `未接続（${googleStatus.error}）` : '未接続 — 下の「Google でサインイン」から連携してください'}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {googleStatus.scopes?.map(s => (
                  <div key={s.label} className="flex items-center gap-2 text-xs">
                    <span className={s.granted ? 'text-green-400' : 'text-red-400'}>
                      {s.granted ? '✅' : '❌'}
                    </span>
                    <span className={s.granted ? 'text-white/80' : 'text-gray-500'}>{s.label}</span>
                    {!s.granted && <span className="text-yellow-500/70">未許可</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ATTENTION: この3つの入力欄は消さない。ふだんは触らないが、最初の設定のときと、鍵を入れ替える
              ときに要る */}
          <div>
            <label>Google Client ID</label>
            <input type="text"
              placeholder={creds.google.client_id ? '●●●● (保存済み)' : '12345-abc.apps.googleusercontent.com'}
              value={creds.google.client_id}
              onChange={e => setCreds({ ...creds, google: { ...creds.google, client_id: e.target.value } })}
            />
          </div>
          <div>
            <label>Google Client Secret</label>
            <input type="password"
              placeholder={creds.google.client_secret ? '●●●● (保存済み)' : ''}
              value={creds.google.client_secret}
              onChange={e => setCreds({ ...creds, google: { ...creds.google, client_secret: e.target.value } })}
            />
          </div>
          <div>
            <label>Google OAuth2 Refresh Token</label>
            <input type="password"
              placeholder={creds.google.refresh_token ? '●●●● (保存済み)' : '未取得 — 下のボタンで自動取得'}
              value={creds.google.refresh_token}
              onChange={e => setCreds({ ...creds, google: { ...creds.google, refresh_token: e.target.value } })}
            />
          </div>
          <a
            href={`${serverUrl}/api/google/auth`}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn border border-cyan-500 bg-cyan-500/10 text-cyan-300
              hover:bg-cyan-500/20 text-sm font-bold py-3 text-center transition-all
              ${(!creds.google.client_id || !creds.google.client_secret)
                ? 'opacity-40 pointer-events-none' : ''}`}
          >
            <Calendar className="w-4 h-4 inline mr-2" />
            Google でサインイン（Calendar・Gmail・Tasks・Drive・Sheets 権限）
          </a>
          {(!creds.google.client_id || !creds.google.client_secret) && (
            <p className="text-xs text-yellow-500">
              ⚠ Client ID と Client Secret を保存してからサインインボタンを押してください
            </p>
          )}

          {/* 今後つなげられそうな他の Google のサービスの一覧（参考。機能を考えるときの手がかりとして置く） */}
          <div className="bg-black/20 border border-glass rounded-lg px-3 py-3">
            <span className="text-xs font-bold text-gray-300">連携を検討できる他のGoogleサービス</span>
            <p className="text-[11px] text-gray-600 mt-1 mb-2">
              今のSheets連携と同じ仕組み（スコープ追加＋コード実装）で、理屈上は連携できます。
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                { name: 'Google Docs', api: 'Docs API', use: '議事録・レポートをドキュメントとして作成' },
                { name: 'Google Slides', api: 'Slides API', use: '簡単なプレゼン資料の自動生成' },
                { name: 'Google Keep', api: 'Keep API', use: '簡易メモの読み書き' },
                { name: '連絡先', api: 'People API', use: '「〇〇さんの連絡先を教えて」に対応' },
                { name: 'Google Photos', api: 'Photos Library API', use: '写真の検索・アルバム作成' },
                { name: 'Google Maps/Places', api: 'Maps Platform', use: '経路案内・お店検索（交通情報センターの強化にも）' },
                { name: 'YouTube', api: 'YouTube Data API', use: '動画の検索・再生リスト管理' },
                { name: 'Google Fit', api: 'Fitness API', use: '健康データの参照（歩数・睡眠等）' },
                { name: 'Google Meet', api: 'Meet REST API', use: '会議リンクの発行' },
              ].map(s => (
                <div key={s.name} className="text-xs">
                  <span className="text-white/80 font-bold">{s.name}</span>
                  <span className="text-gray-500 ml-1">（{s.api}）</span>
                  <span className="text-gray-500"> — {s.use}</span>
                </div>
              ))}
            </div>
          </div>
        </AccordionSection>

        {/* Gmail のフィルター（Live の読み上げと秘書の両方で使う） */}
        {config && (
        <AccordionSection id="gmail" title="📧 Gmail フィルタ設定" open={openCredsSections.has('gmail')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            除外するカテゴリと上限件数は、Live（番組内の読み上げ）とMy Secretary
            （「メールをチェックして」等）の両方で共通して使われます。取得対象は
            直近24時間の未読メールのみで、チェックを入れたカテゴリは除外されます。
          </p>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-400 font-semibold">除外するカテゴリ</p>
            {(
              [
                { key: 'exclude_promotions', label: 'プロモーション（通販・クーポン・広告）' },
                { key: 'exclude_social',     label: 'SNS・ソーシャル通知' },
                { key: 'exclude_updates',    label: 'サービス更新・アップデート通知' },
                { key: 'exclude_forums',     label: 'フォーラム・コミュニティ通知' },
              ] as { key: keyof GmailFilter; label: string }[]
            ).map(({ key, label }) => {
              const gf: GmailFilter = config.show.gmail_filter ?? { exclude_promotions: false, exclude_social: false, exclude_updates: false, exclude_forums: false, max_fetch: 10, max_announce: 5 };
              return (
                <label key={key} className="flex items-center gap-2 cursor-pointer text-sm text-gray-300 hover:text-white">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-cyan-400"
                    checked={!!(gf[key])}
                    onChange={e => setConfig({ ...config, show: { ...config.show, gmail_filter: { ...gf, [key]: e.target.checked } } } as FullConfig)}
                  />
                  {label}
                </label>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">未読メール取得の上限件数</label>
              <select
                className="bg-black/40 border border-glass rounded px-2 py-1 text-sm text-white"
                value={config.show.gmail_filter?.max_fetch ?? 10}
                onChange={e => {
                  const gf: GmailFilter = config.show.gmail_filter ?? { exclude_promotions: false, exclude_social: false, exclude_updates: false, exclude_forums: false, max_fetch: 10, max_announce: 5 };
                  setConfig({ ...config, show: { ...config.show, gmail_filter: { ...gf, max_fetch: Number(e.target.value) } } } as FullConfig);
                }}
              >
                {[5, 10, 15, 20].map(n => <option key={n} value={n}>{n}件</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">1回の紹介件数の上限（Liveのみ）</label>
              <select
                className="bg-black/40 border border-glass rounded px-2 py-1 text-sm text-white"
                value={config.show.gmail_filter?.max_announce ?? 5}
                onChange={e => {
                  const gf: GmailFilter = config.show.gmail_filter ?? { exclude_promotions: false, exclude_social: false, exclude_updates: false, exclude_forums: false, max_fetch: 10, max_announce: 5 };
                  setConfig({ ...config, show: { ...config.show, gmail_filter: { ...gf, max_announce: Number(e.target.value) } } } as FullConfig);
                }}
              >
                {[1, 2, 3, 5, 7, 10].map(n => <option key={n} value={n}>{n}件</option>)}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            ※ スパム・ゴミ箱は常に除外されます。設定変更後は「保存」ボタンを押してください。
          </p>
        </AccordionSection>
        )}

        {/* OpenWeatherMap（お天気コーナー） */}
        <AccordionSection id="openweathermap" title="☁️ OpenWeatherMap API（お天気コーナー）" open={openCredsSections.has('openweathermap')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            <a href="https://openweathermap.org/api" target="_blank" rel="noopener noreferrer"
              className="text-neon-blue underline">openweathermap.org</a> で無料登録して取得。空欄の場合は天気データなしで放送されます。
          </p>
          <div>
            <label>OpenWeatherMap API Key</label>
            <input type="password"
              placeholder={creds.openweathermap?.api_key ? '●●●● (保存済み)' : ''}
              value={creds.openweathermap?.api_key ?? ''}
              onChange={e => setCreds({ ...creds, openweathermap: { api_key: e.target.value } })}
            />
          </div>
        </AccordionSection>

        {/* YouTube。動画の検索（API キーだけ）と登録チャンネルの新着の確認（OAuth）は、認証の仕方が
            まったく別だが、どちらも YouTube の設定なので同じ節に①②として並べる */}
        <AccordionSection id="youtube" title={<span className="flex items-center gap-2">▶️ YouTube連携{youtubeStatus?.connected ? <span className="ml-1 text-xs text-green-400 font-normal">✓ 登録チャンネル認証済み</span> : null}</span>} open={openCredsSections.has('youtube')} onToggle={toggleCredsSection}>
          <div>
            <span className="text-xs font-bold text-gray-300">① 動画検索（APIキー）</span>
            <p className="text-xs text-gray-500 mt-1 mb-2">
              <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer"
                className="text-neon-blue underline">Google Cloud Console</a> で「YouTube Data API v3」を有効化し、
              APIキーを発行して入力してください。空欄の場合はSecretaryの動画検索機能が使えません。
            </p>
            <div>
              <label>YouTube Data API Key</label>
              <input type="password"
                placeholder={creds.youtube?.api_key ? '●●●● (保存済み)' : ''}
                value={creds.youtube?.api_key ?? ''}
                onChange={e => setCreds({ ...creds, youtube: { api_key: e.target.value } })}
              />
            </div>
          </div>

          <div className="pt-4 border-t border-white/10">
            <span className="text-xs font-bold text-gray-300">② 登録チャンネルの新着確認（OAuth）</span>
            <p className="text-xs text-gray-500 mt-1 mb-2">
              Google側の制約により、上の「Google Calendar/Gmail/.../連携」セクションとは別画面での
              追加認証が必要です（同じClient ID / Client Secretを使うため、先にそちらを設定してください）。
            </p>
            <div className="bg-black/20 border border-glass rounded-lg px-3 py-3 mb-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-gray-300">実際の許可状況</span>
                <button
                  onClick={fetchYoutubeStatus}
                  disabled={youtubeStatusLoading}
                  className="btn btn-dark text-xs px-2 py-1 border border-glass text-gray-400"
                >
                  {youtubeStatusLoading ? '確認中…' : '🔄 更新'}
                </button>
              </div>
              {youtubeStatus === null || youtubeStatusLoading ? (
                <p className="text-xs text-gray-600">確認中…</p>
              ) : !youtubeStatus.connected ? (
                <p className="text-xs text-gray-600">
                  {youtubeStatus.error ? `未接続（${youtubeStatus.error}）` : '未接続 — 下の「YouTubeでサインイン」から連携してください'}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {youtubeStatus.scopes?.map(s => (
                    <div key={s.label} className="flex items-center gap-2 text-xs">
                      <span className={s.granted ? 'text-green-400' : 'text-red-400'}>
                        {s.granted ? '✅' : '❌'}
                      </span>
                      <span className={s.granted ? 'text-white/80' : 'text-gray-500'}>{s.label}</span>
                      {!s.granted && <span className="text-yellow-500/70">未許可</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <a
              href={`${serverUrl}/api/youtube/auth`}
              target="_blank"
              rel="noopener noreferrer"
              className={`btn border border-red-500 bg-red-500/10 text-red-300
                hover:bg-red-500/20 text-sm font-bold py-3 text-center transition-all block
                ${(!creds.google.client_id || !creds.google.client_secret)
                  ? 'opacity-40 pointer-events-none' : ''}`}
            >
              ▶️ YouTubeでサインイン（登録チャンネルの閲覧権限）
            </a>
            {(!creds.google.client_id || !creds.google.client_secret) && (
              <p className="text-xs text-yellow-500 mt-1">
                ⚠ 上の「Google Calendar/.../連携」セクションでClient ID と Client Secret を
                保存してからサインインボタンを押してください
              </p>
            )}
          </div>
        </AccordionSection>

        {/* LINE（秘書とのやり取り） */}
        <AccordionSection id="line" title="💬 LINE連携（My Secretary）" open={openCredsSections.has('line')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            <a href="https://developers.line.biz/console/" target="_blank" rel="noopener noreferrer"
              className="text-neon-blue underline">LINE Developers</a> でMy Secretary専用のMessaging
            APIチャンネルを作成し、チャネルアクセストークン・チャネルシークレットを同じ設定画面から
            発行して入力してください。本人確認（userIdの登録）は「My Secretary → LINE連携設定」から
            行います。
          </p>
          <div>
            <label>チャネルアクセストークン</label>
            <input type="password"
              placeholder={creds.line?.channel_access_token ? '●●●● (保存済み)' : ''}
              value={creds.line?.channel_access_token ?? ''}
              onChange={e => setCreds({ ...creds, line: { ...creds.line, channel_access_token: e.target.value } })}
            />
          </div>
          <div>
            <label>チャネルシークレット</label>
            <input type="password"
              placeholder={creds.line?.channel_secret ? '●●●● (保存済み)' : ''}
              value={creds.line?.channel_secret ?? ''}
              onChange={e => setCreds({ ...creds, line: { ...creds.line, channel_secret: e.target.value } })}
            />
          </div>
        </AccordionSection>

        {/* Spotify（音楽チャンネルの再生） */}
        <AccordionSection id="spotify" title={<span className="flex items-center gap-2"><Music className="w-4 h-4 text-green-400" /> Spotify Premium 連携 (OAuth2){creds.spotify.refresh_token ? <span className="ml-1 text-xs text-green-400 font-normal">✓ 認証済み</span> : null}</span>} open={openCredsSections.has('spotify')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            Spotify Developer Dashboard で Client ID / Client Secret を取得し、保存後に下のボタンで認証してください。
            Redirect URI には <code className="text-neon-blue">http://127.0.0.1:3001/callback</code> を登録してください。
            下の「実際の許可状況」で、今どの権限が使える状態か確認できます。<span className="text-yellow-500/80">
            以前古いスコープで連携済みの場合や、新しい機能追加でスコープが増えた場合は、
            その権限が「未許可」と表示されるので、一度サインインし直してください。</span>
          </p>

          {/* 実際に許可されている権限の一覧（Google と同じ理由） */}
          <div className="bg-black/20 border border-glass rounded-lg px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-gray-300">実際の許可状況</span>
              <button
                onClick={fetchSpotifyStatus}
                disabled={spotifyStatusLoading}
                className="btn btn-dark text-xs px-2 py-1 border border-glass text-gray-400"
              >
                {spotifyStatusLoading ? '確認中…' : '🔄 更新'}
              </button>
            </div>
            {spotifyStatus === null || spotifyStatusLoading ? (
              <p className="text-xs text-gray-600">確認中…</p>
            ) : !spotifyStatus.connected ? (
              <p className="text-xs text-gray-600">
                {spotifyStatus.error ? `未接続（${spotifyStatus.error}）` : '未接続 — 下の「Spotify でサインイン」から連携してください'}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {spotifyStatus.scopes?.map(s => (
                  <div key={s.label} className="flex items-center gap-2 text-xs">
                    <span className={s.granted ? 'text-green-400' : 'text-red-400'}>
                      {s.granted ? '✅' : '❌'}
                    </span>
                    <span className={s.granted ? 'text-white/80' : 'text-gray-500'}>{s.label}</span>
                    {!s.granted && <span className="text-yellow-500/70">未許可</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label>Spotify Client ID</label>
            <input type="text"
              placeholder={creds.spotify.client_id ? '●●●● (保存済み)' : ''}
              value={creds.spotify.client_id}
              onChange={e => setCreds({ ...creds, spotify: { ...creds.spotify, client_id: e.target.value } })}
            />
          </div>
          <div>
            <label>Spotify Client Secret</label>
            <input type="password"
              placeholder={creds.spotify.client_secret ? '●●●● (保存済み)' : ''}
              value={creds.spotify.client_secret}
              onChange={e => setCreds({ ...creds, spotify: { ...creds.spotify, client_secret: e.target.value } })}
            />
          </div>
          <div>
            <label>Spotify Refresh Token</label>
            <input type="password"
              placeholder={creds.spotify.refresh_token ? '●●●● (保存済み)' : '未取得 — 下のボタンで自動取得'}
              value={creds.spotify.refresh_token}
              onChange={e => setCreds({ ...creds, spotify: { ...creds.spotify, refresh_token: e.target.value } })}
            />
          </div>
          <a
            href={`${serverUrl}/api/spotify/auth`}
            target="_blank"
            rel="noopener noreferrer"
            className={`btn border border-green-500 bg-green-500/10 text-green-300
              hover:bg-green-500/20 text-sm font-bold py-3 text-center transition-all
              ${(!creds.spotify.client_id || !creds.spotify.client_secret)
                ? 'opacity-40 pointer-events-none' : ''}`}
          >
            <Music className="w-4 h-4 inline mr-2" />
            Spotify でサインイン（再生・ライブラリ・プレイリスト権限）
          </a>
          {(!creds.spotify.client_id || !creds.spotify.client_secret) && (
            <p className="text-xs text-yellow-500">
              ⚠ Client ID と Client Secret を保存してからサインインボタンを押してください
            </p>
          )}
        </AccordionSection>

        {/* 緊急地震速報（受信の絞り込みと、テストの発火） */}
        {config && (
        <AccordionSection id="earthquake" title="🚨 緊急地震速報" open={openCredsSections.has('earthquake')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            気象庁の緊急地震速報（P2PQuake経由）を受信し、震度4以上の警報を放送に割り込んでお知らせします。
            フィルタを有効にすると、指定した都道府県が対象エリアに含まれる速報のみを通知します
            （無効時は全国の速報を通知します）。
          </p>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="eew_filter_enabled"
              checked={!!config.show.earthquake_filter?.enabled}
              onChange={e => {
                const ef: EarthquakeFilter = config.show.earthquake_filter ?? { enabled: false, pref: '' };
                setConfig({ ...config, show: { ...config.show, earthquake_filter: { ...ef, enabled: e.target.checked } } });
              }}
            />
            <label htmlFor="eew_filter_enabled" className="mb-0 cursor-pointer">自分の地域でフィルタする</label>
          </div>
          <div className="flex flex-col gap-1" style={{ maxWidth: '240px' }}>
            <label className="text-xs text-gray-400">対象都道府県</label>
            <select
              className="bg-black/40 border border-glass rounded px-2 py-1 text-sm text-white"
              value={config.show.earthquake_filter?.pref ?? ''}
              onChange={e => {
                const ef: EarthquakeFilter = config.show.earthquake_filter ?? { enabled: false, pref: '' };
                setConfig({ ...config, show: { ...config.show, earthquake_filter: { ...ef, pref: e.target.value } } });
              }}
            >
              <option value="">未選択</option>
              {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <p className="text-xs text-gray-500">設定変更後は「接続設定を保存」ボタンを押してください。</p>

          <div className="border border-red-500/30 rounded-xl" style={{ padding: '16px', background: 'rgba(239,68,68,0.05)', marginTop: '4px' }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-base">🚨</span>
              <span className="text-sm font-bold text-red-300">テスト発火</span>
              <span className="text-xs text-gray-500">実際のアラートUIとチャイム音が鳴ります（上記フィルタも適用されます）</span>
            </div>
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">震源地</label>
                <input
                  id="eew_test_hypocenter"
                  type="text"
                  defaultValue="東京都南部"
                  className="bg-black/40 border border-glass rounded px-2 py-1 text-sm text-white w-36"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">対象都道府県</label>
                <select
                  id="eew_test_pref"
                  defaultValue={config.show.earthquake_filter?.pref || '東京都'}
                  className="bg-black/40 border border-glass rounded px-2 py-1 text-sm text-white"
                >
                  {PREFECTURES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">最大震度 (scaleFrom)</label>
                <select
                  id="eew_test_scale"
                  defaultValue={50}
                  className="bg-black/40 border border-glass rounded px-2 py-1 text-sm text-white"
                >
                  <option value={40}>震度4</option>
                  <option value={45}>震度4強</option>
                  <option value={50}>震度5弱</option>
                  <option value={55}>震度5強</option>
                  <option value={60}>震度6弱</option>
                  <option value={65}>震度6強</option>
                  <option value={70}>震度7</option>
                </select>
              </div>
              <button
                type="button"
                className="btn py-1.5 px-4 text-sm font-bold"
                style={{ background: 'rgba(239,68,68,0.3)', border: '1px solid rgba(239,68,68,0.6)', color: '#fca5a5', borderRadius: '8px' }}
                onClick={async () => {
                  const hypocenter = (document.getElementById('eew_test_hypocenter') as HTMLInputElement)?.value || '東京都南部';
                  const pref       = (document.getElementById('eew_test_pref') as HTMLSelectElement)?.value || '東京都';
                  const scaleFrom  = Number((document.getElementById('eew_test_scale') as HTMLSelectElement)?.value ?? 50);
                  try {
                    const r = await fetch(`${serverUrl}/api/test-earthquake`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ hypocenter, pref, scaleFrom }),
                    });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  } catch (e) {
                    alert(`テスト発火失敗: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}
              >
                🚨 テスト発火
              </button>
            </div>
          </div>
        </AccordionSection>
        )}

        {/* ngrok のトンネルの自動起動（LINE の webhook など、外から届く必要がある機能のため） */}
        {config && (
        <AccordionSection id="ngrok" title="🌐 ngrokトンネル自動起動" open={openCredsSections.has('ngrok')} onToggle={toggleCredsSection}>
          <p className="text-xs text-gray-500">
            LINE Webhook等、外部からこのローカルサーバー（localhost:3001）へ到達する必要がある
            機能のために、固定ドメインのngrokトンネルを起動しておく必要があります。LINE専用の
            設定ではなく、外部公開が必要な機能全般で使う汎用インフラのため、ここに配置しています。
            有効にすると、AI Radioサーバー起動時にトンネルが既に起動しているかを自動確認し、
            起動していなければ自動的に起動します（<code>ngrok</code>コマンドがこのマシンの
            PATHに通っている必要があります）。無効のままなら、これまで通りご自身で手動起動して
            ください。
          </p>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={config.ngrok?.auto_start ?? false}
              onChange={e => setConfig({ ...config, ngrok: { auto_start: e.target.checked, domain: config.ngrok?.domain ?? '' } })} />
            <span>サーバー起動時にngrokトンネルを自動起動する</span>
          </label>
          <div>
            <label>ngrok固定ドメイン</label>
            <input type="text" value={config.ngrok?.domain ?? ''} placeholder="例: your-domain.ngrok-free.dev"
              onChange={e => setConfig({ ...config, ngrok: { auto_start: config.ngrok?.auto_start ?? false, domain: e.target.value } })} />
          </div>
        </AccordionSection>
        )}

        <button type="submit" className="btn btn-primary py-3">
          接続設定を保存
        </button>
      </form>
      </div>
    </div>
  );
}
