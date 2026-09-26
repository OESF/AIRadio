/**
 * @file Spotify・Google・YouTube の OAuth の認可と、許可されている範囲の確認の API
 *
 * 管理画面のボタンから認可のページへ送り（/api/<サービス>/auth）、戻ってきたコードを refresh_token に換えて
 * credentials.json に保存する（/callback・/callback/google・/callback/youtube）。/api/<サービス>/status は、
 * 実際にトークンを取り直して、どの範囲（スコープ）が許可されているかを管理画面へ返す。
 *
 * ATTENTION: redirect_uri は http://127.0.0.1:3001 に固定。各サービスの側に登録してあるので変えられない。
 * YouTube の /callback/youtube も、Google Cloud Console の「承認済みのリダイレクト URI」に別に登録が要る
 * （無いと redirect_uri_mismatch で失敗する）。
 *
 * ATTENTION: スコープを変えたら、管理画面で連携をやり直すまで古い範囲の refresh_token のまま。
 * また、サーバーのプロセスが古い範囲のアクセストークンをしばらく持ち続けるので、再連携の後は
 * サーバーの再起動が要る。
 *
 * ATTENTION: このファイルは結果を HTML で直接返す数少ない場所。外から来た値（認可の画面が付けてくる
 * error、例外の message）を HTML へ入れるときは必ず escapeHtml() を通すこと。error は URL の
 * クエリなので、リンクを踏ませるだけで任意のタグを差し込める。
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

const fs = require('fs');
const { getLogger } = require('../logger');

/**
 * HTML に埋め込む前に、タグとして解釈される文字を実体参照へ置き換える。
 *
 * ATTENTION: 外から来た値を res.send の文字列へ入れるときは必ずこれを通すこと。
 *
 * @param {any} value 埋め込みたい値（文字列以外も受ける）
 * @returns {string} そのまま HTML へ入れてよい文字列
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Google で求めるスコープと、管理画面に出す日本語の名前。
 * ATTENTION: 認可の要求と、管理画面の表示（/api/google/status）の両方がこの表を使う。別々に直すと
 * 食い違うので、スコープを足すときはここだけを直す。
 * Sheets は、プレゼンテーションのグラフの元になるスプレッドシートへ書き込むので、読み書きの範囲にしている。
 */
const GOOGLE_SCOPES = [
  { url: 'https://www.googleapis.com/auth/calendar', label: 'カレンダー（予定の閲覧・作成）' },
  { url: 'https://www.googleapis.com/auth/gmail.readonly', label: 'Gmail（メールの閲覧）' },
  { url: 'https://www.googleapis.com/auth/gmail.compose', label: 'Gmail（下書き作成・送信はしません）' },
  { url: 'https://www.googleapis.com/auth/tasks', label: 'Tasks（タスクの閲覧・追加）' },
  { url: 'https://www.googleapis.com/auth/drive.file', label: 'Drive（このアプリが作成したファイルのみ）' },
  { url: 'https://www.googleapis.com/auth/spreadsheets', label: 'スプレッドシート（読み取り・書き込み）' },
  { url: 'https://www.googleapis.com/auth/presentations', label: 'スライド（プレゼンテーションの作成・編集）' },
];

/**
 * YouTube で求めるスコープ。
 * BUGFIX: YouTube のスコープは、ほかの Google のスコープと同じ認可の要求に混ぜられない（混ぜると
 * 「cannot be requested together」の400で、Google の連携ごと失敗した）。同じ OAuth のクライアントを使いつつ、
 * 認可の要求・戻り先・refresh_token（youtube_refresh_token）を完全に分けている。これで、Google を
 * 再連携しても YouTube の許可は失われない。
 */
const YOUTUBE_SCOPES = [
  { url: 'https://www.googleapis.com/auth/youtube.readonly', label: 'YouTube（登録チャンネル・新着動画の閲覧）' },
];

/**
 * Spotify で求めるスコープと、管理画面に出す日本語の名前（GOOGLE_SCOPES と同じ考え方）。
 */
const SPOTIFY_SCOPES = [
  { url: 'streaming', label: 'ストリーミング再生（Web Playback SDK用）' },
  { url: 'user-read-email', label: 'メールアドレスの読み取り' },
  { url: 'user-read-private', label: 'アカウント情報の読み取り' },
  { url: 'user-library-read', label: 'ライブラリ（保存済みの曲）の読み取り' },
  { url: 'playlist-read-private', label: '非公開プレイリストの読み取り' },
  { url: 'user-read-currently-playing', label: '現在再生中の曲の読み取り' },
  { url: 'user-read-recently-played', label: '再生履歴の読み取り' },
  { url: 'user-top-read', label: 'よく聴く曲の読み取り' },
  { url: 'playlist-modify-public', label: '公開プレイリストの作成・編集' },
  { url: 'playlist-modify-private', label: '非公開プレイリストの作成・編集' },
];

/**
 * OAuth のルートを登録する。
 *
 * @param {import('express').Express} app Express のアプリ
 * @param {{ CREDENTIALS_PATH: string, readJsonFile: Function, getInitialCredentials: Function }} ctx
 *   credentials.json のパス・JSON を読む関数・認証情報の初期値を返す関数
 * @returns {void}
 */
function registerOAuthRoutes(app, ctx) {
  const { CREDENTIALS_PATH, readJsonFile, getInitialCredentials } = ctx;

  // ── Spotify OAuth2 ──────────────────────────
  // 管理画面の「Spotify 認証」から呼ばれ、Spotify の認可のページへ送る
  app.get('/api/spotify/auth', (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.spotify || !creds.spotify.client_id) {
      return res.status(400).send(
        '<h2>Spotify client_id が未設定です</h2>' +
        '<p>管理画面の「認証情報」タブで client_id / client_secret を保存してから再度お試しください。</p>'
      );
    }
    const params = new URLSearchParams({
      client_id:     creds.spotify.client_id,
      response_type: 'code',
      redirect_uri:  'http://127.0.0.1:3001/callback',
      scope: SPOTIFY_SCOPES.map(s => s.url).join(' '),
    });
    res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
  });

  // Spotify が ?code= を付けて戻してくる。refresh_token に換えて credentials.json に保存する
  app.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.send(
        `<html><body style="font-family:sans-serif;padding:40px">` +
        `<h2>❌ Spotify 認証キャンセル</h2><p>${escapeHtml(error)}</p></body></html>`
      );
    }
    if (!code) {
      return res.status(400).send('code パラメータがありません');
    }

    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.spotify || !creds.spotify.client_id || !creds.spotify.client_secret) {
      return res.status(400).send(
        '<h2>Spotify client_id / client_secret が未設定です</h2>'
      );
    }

    try {
      const basicAuth = Buffer.from(
        `${creds.spotify.client_id}:${creds.spotify.client_secret}`
      ).toString('base64');

      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: 'http://127.0.0.1:3001/callback',
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.refresh_token) {
        getLogger().error('[Spotify Auth] Token error: ' + JSON.stringify(tokenData));
        return res.status(500).send(
          `<html><body style="font-family:sans-serif;padding:40px">` +
          `<h2>❌ トークン取得失敗</h2>` +
          `<pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre></body></html>`
        );
      }

      // refresh_token を保存する（以後はここからアクセストークンを取り直す）
      creds.spotify.refresh_token = tokenData.refresh_token;
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), 'utf-8');
      getLogger().info('[Spotify Auth] refresh_token saved successfully');

      res.send(`
        <html>
        <body style="font-family:sans-serif;padding:60px;text-align:center;background:#191414;color:#1DB954">
          <h2 style="font-size:2em">✅ Spotify 認証完了！</h2>
          <p style="color:#fff">refresh_token を保存しました。</p>
          <p style="color:#aaa;font-size:.9em">3 秒後にこのウィンドウを自動で閉じます。</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body>
        </html>
      `);
    } catch (e) {
      getLogger().error('[Spotify Auth] Unexpected error: ' + e.message);
      res.status(500).send(
        `<html><body style="font-family:sans-serif;padding:40px">` +
        `<h2>❌ エラー</h2><p>${escapeHtml(e.message)}</p></body></html>`
      );
    }
  });

  // Spotify で実際に許可されている範囲を返す。Spotify は、トークンを取り直した応答の scope に許可された
  // 範囲が入っているので、Google の tokeninfo のような別の問い合わせは要らない。
  app.get('/api/spotify/status', async (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.spotify?.refresh_token || !creds.spotify?.client_id || !creds.spotify?.client_secret) {
      return res.json({ connected: false });
    }
    try {
      const basicAuth = Buffer.from(`${creds.spotify.client_id}:${creds.spotify.client_secret}`).toString('base64');
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.spotify.refresh_token }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        // refresh_tokenが失効・取り消し済みの場合もここに来る（再連携が必要）。
        return res.json({ connected: false, error: tokenData.error_description || tokenData.error || 'アクセストークンの取得に失敗しました' });
      }
      const grantedSet = new Set((tokenData.scope || '').split(' ').filter(Boolean));
      const scopes = SPOTIFY_SCOPES.map(s => ({ label: s.label, granted: grantedSet.has(s.url) }));
      res.json({ connected: true, scopes });
    } catch (e) {
      getLogger().warn('[Spotify Auth] ステータス確認に失敗: ' + e.message);
      res.json({ connected: false, error: e.message });
    }
  });

  // ── Google OAuth2（Calendar・Gmail・Tasks・Drive・Sheets・Slides）──────────────
  // 管理画面の「Google でサインイン」から呼ばれ、Google の認可のページへ送る
  app.get('/api/google/auth', (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.google || !creds.google.client_id) {
      return res.status(400).send(
        '<h2>Google client_id が未設定です</h2>' +
        '<p>管理画面の「認証情報」タブで client_id / client_secret を保存してから再度お試しください。</p>'
      );
    }
    const params = new URLSearchParams({
      client_id:     creds.google.client_id,
      redirect_uri:  'http://127.0.0.1:3001/callback/google',
      response_type: 'code',
      // Gmail は gmail.readonly と gmail.compose を両方求める。compose だけでは受信トレイのメールを読めない
      // （get_emails が403になった）。サーバーは下書きを作るだけで、送信は必ず本人が Gmail で行う。
      // Drive は最小限の drive.file（このアプリが作った・開いたファイルだけ）にしている。
      scope: GOOGLE_SCOPES.map(s => s.url).join(' '),
      access_type: 'offline',
      prompt:      'consent', // refresh_token を必ず発行させる
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // Google が ?code= を付けて戻してくる。refresh_token に換えて credentials.json に保存する
  app.get('/callback/google', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.send(
        `<html><body style="font-family:sans-serif;padding:40px">` +
        `<h2>❌ Google 認証キャンセル</h2><p>${escapeHtml(error)}</p></body></html>`
      );
    }
    if (!code) return res.status(400).send('code パラメータがありません');

    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.google || !creds.google.client_id || !creds.google.client_secret) {
      return res.status(400).send(
        '<h2>Google client_id / client_secret が未設定です</h2>'
      );
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     creds.google.client_id,
          client_secret: creds.google.client_secret,
          code,
          redirect_uri:  'http://127.0.0.1:3001/callback/google',
          grant_type:    'authorization_code',
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.refresh_token) {
        getLogger().error('[Google Auth] Token error: ' + JSON.stringify(tokenData));
        return res.status(500).send(
          `<html><body style="font-family:sans-serif;padding:40px">` +
          `<h2>❌ トークン取得失敗</h2>` +
          `<pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre>` +
          `<p>※ Google Cloud Console で "アクセスの種類" を <strong>ウェブアプリケーション</strong>、` +
          `リダイレクト URI に <strong>http://127.0.0.1:3001/callback/google</strong> を登録しているか確認してください。</p>` +
          `</body></html>`
        );
      }

      creds.google.refresh_token = tokenData.refresh_token;
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), 'utf-8');
      getLogger().info('[Google Auth] refresh_token saved successfully');

      res.send(`
        <html>
        <body style="font-family:sans-serif;padding:60px;text-align:center;background:#0f172a;color:#34d399">
          <h2 style="font-size:2em">✅ Google 認証完了！</h2>
          <p style="color:#fff">カレンダー・Gmail の refresh_token を保存しました。</p>
          <p style="color:#aaa;font-size:.9em">3 秒後にこのウィンドウを自動で閉じます。</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body>
        </html>
      `);
    } catch (e) {
      getLogger().error('[Google Auth] Unexpected error: ' + e.message);
      res.status(500).send(
        `<html><body style="font-family:sans-serif;padding:40px">` +
        `<h2>❌ エラー</h2><p>${escapeHtml(e.message)}</p></body></html>`
      );
    }
  });

  // Google で実際に許可されている範囲を返す。refresh_token からアクセストークンを取り、tokeninfo に
  // 問い合わせて GOOGLE_SCOPES と突き合わせる。こちらが求めた範囲ではなく Google が実際に認めた範囲なので、
  // 一部だけ拒否された場合や古い refresh_token の場合も正確に分かる。
  app.get('/api/google/status', async (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.google?.refresh_token || !creds.google?.client_id || !creds.google?.client_secret) {
      return res.json({ connected: false });
    }
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.google.client_id,
          client_secret: creds.google.client_secret,
          refresh_token: creds.google.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        // refresh_tokenが失効・取り消し済みの場合もここに来る（再連携が必要）。
        return res.json({ connected: false, error: tokenData.error_description || tokenData.error || 'アクセストークンの取得に失敗しました' });
      }
      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokenData.access_token}`);
      const infoData = await infoRes.json();
      if (!infoRes.ok || !infoData.scope) {
        return res.json({ connected: false, error: '許可スコープの取得に失敗しました' });
      }
      const grantedSet = new Set(infoData.scope.split(' '));
      const scopes = GOOGLE_SCOPES.map(s => ({ label: s.label, granted: grantedSet.has(s.url) }));
      res.json({ connected: true, scopes });
    } catch (e) {
      getLogger().warn('[Google Auth] ステータス確認に失敗: ' + e.message);
      res.json({ connected: false, error: e.message });
    }
  });

  // ── YouTube OAuth2（Google とは別の認可の要求。YOUTUBE_SCOPES 参照）──
  // OAuth のクライアントは Google と同じものを使い、戻り先（/callback/youtube）と保存先
  // （youtube_refresh_token）だけを分ける。
  app.get('/api/youtube/auth', (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.google || !creds.google.client_id) {
      return res.status(400).send(
        '<h2>Google client_id が未設定です</h2>' +
        '<p>管理画面の「システム接続設定」で client_id / client_secret を保存してから再度お試しください' +
        '（YouTube連携もGoogleと同じOAuthクライアントを使います）。</p>'
      );
    }
    const params = new URLSearchParams({
      client_id:     creds.google.client_id,
      redirect_uri:  'http://127.0.0.1:3001/callback/youtube',
      response_type: 'code',
      scope: YOUTUBE_SCOPES.map(s => s.url).join(' '),
      access_type: 'offline',
      prompt:      'consent',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get('/callback/youtube', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.send(
        `<html><body style="font-family:sans-serif;padding:40px">` +
        `<h2>❌ YouTube 認証キャンセル</h2><p>${escapeHtml(error)}</p></body></html>`
      );
    }
    if (!code) return res.status(400).send('code パラメータがありません');

    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.google || !creds.google.client_id || !creds.google.client_secret) {
      return res.status(400).send(
        '<h2>Google client_id / client_secret が未設定です</h2>'
      );
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     creds.google.client_id,
          client_secret: creds.google.client_secret,
          code,
          redirect_uri:  'http://127.0.0.1:3001/callback/youtube',
          grant_type:    'authorization_code',
        }),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.refresh_token) {
        getLogger().error('[YouTube Auth] Token error: ' + JSON.stringify(tokenData));
        return res.status(500).send(
          `<html><body style="font-family:sans-serif;padding:40px">` +
          `<h2>❌ トークン取得失敗</h2>` +
          `<pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre>` +
          `<p>※ Google Cloud Console のOAuthクライアントの「承認済みのリダイレクト URI」に` +
          `<strong>http://127.0.0.1:3001/callback/youtube</strong> を登録しているか確認してください。</p>` +
          `</body></html>`
        );
      }

      // ATTENTION: Google の refresh_token（Calendar・Gmail など）は上書きせず、別のフィールドに保存する
      creds.google.youtube_refresh_token = tokenData.refresh_token;
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), 'utf-8');
      getLogger().info('[YouTube Auth] youtube_refresh_token saved successfully');

      res.send(`
        <html>
        <body style="font-family:sans-serif;padding:60px;text-align:center;background:#0f172a;color:#ef4444">
          <h2 style="font-size:2em">✅ YouTube 認証完了！</h2>
          <p style="color:#fff">登録チャンネルの閲覧権限を保存しました。</p>
          <p style="color:#aaa;font-size:.9em">3 秒後にこのウィンドウを自動で閉じます。</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body>
        </html>
      `);
    } catch (e) {
      getLogger().error('[YouTube Auth] Unexpected error: ' + e.message);
      res.status(500).send(
        `<html><body style="font-family:sans-serif;padding:40px">` +
        `<h2>❌ エラー</h2><p>${escapeHtml(e.message)}</p></body></html>`
      );
    }
  });

  // YouTube で実際に許可されている範囲を返す（/api/google/status と同じやり方）
  app.get('/api/youtube/status', async (req, res) => {
    const creds = readJsonFile(CREDENTIALS_PATH, getInitialCredentials());
    if (!creds.google?.youtube_refresh_token || !creds.google?.client_id || !creds.google?.client_secret) {
      return res.json({ connected: false });
    }
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.google.client_id,
          client_secret: creds.google.client_secret,
          refresh_token: creds.google.youtube_refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return res.json({ connected: false, error: tokenData.error_description || tokenData.error || 'アクセストークンの取得に失敗しました' });
      }
      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokenData.access_token}`);
      const infoData = await infoRes.json();
      if (!infoRes.ok || !infoData.scope) {
        return res.json({ connected: false, error: '許可スコープの取得に失敗しました' });
      }
      const grantedSet = new Set(infoData.scope.split(' '));
      const scopes = YOUTUBE_SCOPES.map(s => ({ label: s.label, granted: grantedSet.has(s.url) }));
      res.json({ connected: true, scopes });
    } catch (e) {
      getLogger().warn('[YouTube Auth] ステータス確認に失敗: ' + e.message);
      res.json({ connected: false, error: e.message });
    }
  });
}

module.exports = { registerOAuthRoutes };
