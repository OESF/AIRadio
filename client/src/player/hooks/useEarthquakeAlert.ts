/**
 * @file 通知専用の WebSocket で、緊急地震速報とシステムの異常を受け取る
 *
 * この WebSocket はページを開いた時点で接続するので、ウェルカム画面でも受け取れる。
 * AI の利用料金の残高切れのような異常は、どこで起きても必ずメイン画面に出したいので、同じ経路に載せている。
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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EarthquakeAlert } from '../types';

/**
 * システムの異常（AI の利用料金の残高不足など）。判定も文面もサーバーの lib/system-alerts.js が
 * 決めて送ってくるので、画面の側では書き分けない。
 */
export type SystemAlert = {
  kind: string;
  severity: 'critical' | 'warning';
  title: string;
  detail: string;
  since: number;
  lastSeen: number;
  count: number;
};

/**
 * 通知専用の WebSocket につなぎ、切れたら5秒後につなぎ直す。
 * @returns 表示中の地震速報・その setter・速報を処理する関数・表示中のシステムの異常
 */
export function useEarthquakeAlert() {
  const [earthquakeAlert, setEarthquakeAlert] = useState<EarthquakeAlert | null>(null);
  const [systemAlerts, setSystemAlerts] = useState<SystemAlert[]>([]);
  const notifyWsRef = useRef<WebSocket | null>(null);

  /** 地震速報を表示し、チャイムを鳴らしてから定型文を読み上げる（ブラウザの読み上げ機能）。 */
  const handleEarthquakeAlert = useCallback((payload: EarthquakeAlert) => {
    setEarthquakeAlert(payload);
    const audio = new Audio('/api/earthquake-chime');
    audio.volume = 1.0;
    const playChime = audio.play();
    // チャイムが鳴り終わってから読み上げる（鳴らせなければすぐに読み上げる）
    const speak = () => {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(payload.alertText);
      utter.lang = 'ja-JP';
      utter.rate = 0.85;
      utter.volume = 1.0;
      // 日本語女性ボイスを優先
      const voices = window.speechSynthesis.getVoices();
      const jaVoice = voices.find(v => v.lang === 'ja-JP' && v.name.includes('Kyoko'))
        ?? voices.find(v => v.lang === 'ja-JP')
        ?? null;
      if (jaVoice) utter.voice = jaVoice;
      window.speechSynthesis.speak(utter);
    };
    if (playChime) {
      playChime.then(() => { audio.addEventListener('ended', speak, { once: true }); }).catch(speak);
    } else {
      speak();
    }
  }, []);

  useEffect(() => {
    const NOTIFY_URL = window.location.hostname === 'localhost'
      ? 'ws://localhost:3001/notifications'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/notifications`;

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let unmounted = false;

    // 今の異常をサーバーから取り直す。WebSocket の通知は、そのときつながっている画面にしか届かない。
    // BUGFIX: 異常が起きたあとに開いた画面に加え、通知の接続が切れている間に「解消」の知らせを取りこぼした画面でも、
    //         つながり直したときに今の状態へそろえる（取りこぼすと、直った後も警告が消えずに残っていた）
    const syncSystemAlerts = () => {
      fetch('/api/system-alerts')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!unmounted && d?.alerts) setSystemAlerts(d.alerts); })
        .catch(() => { /* 取得できなくても画面は動く */ });
    };

    const connect = () => {
      if (unmounted) return;
      ws = new WebSocket(NOTIFY_URL);
      notifyWsRef.current = ws;
      ws.onopen = () => syncSystemAlerts();
      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data as string);
          if (payload.event === 'EARTHQUAKE_ALERT') handleEarthquakeAlert(payload);
          else if (payload.event === 'SYSTEM_ALERT') {
            setSystemAlerts((prev) => [...prev.filter((a) => a.kind !== payload.alert.kind), payload.alert]);
          } else if (payload.event === 'SYSTEM_ALERT_CLEARED') {
            setSystemAlerts((prev) => prev.filter((a) => a.kind !== payload.kind));
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        if (!unmounted) reconnectTimer = setTimeout(connect, 5000);
      };
      ws.onerror = () => {};
    };

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      ws?.close();
      notifyWsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { earthquakeAlert, setEarthquakeAlert, handleEarthquakeAlert, systemAlerts };
}
