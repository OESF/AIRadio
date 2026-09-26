/**
 * @file プレイヤーの My Secretary（Gemini Live との音声の会話）の接続・マイク・再生を扱うフック
 *
 * My Secretary のチャンネル専用の WebSocket（/stream-secretary、サーバー側は secretary-live-routes.js）を開き、
 * マイクの音（16kHz の PCM）を送り、返ってくる音声（24kHz の PCM）を AudioWorklet（secretaryAudioWorklet.ts）の
 * リングバッファで再生する。専門エージェント本人の声（consult_agent）の再生、画面に残す情報（キャンバス）、
 * ファイルの添付・テキストの共有、処理中・無応答・切断の表示も受け持つ。利用元は Player.tsx。
 *
 * @author Masataka Miura
 * @author Antigravity
 * @author Anthropic Claude
 * @copyright Copyright (c) 2026 Masataka Miura (Mark Brain Lab.)
 * @license MIT
 * SPDX-License-Identifier: MIT
 *
 * @doc-reviewed 2026-09-19
 */

import { useRef, useState } from 'react';
import { SECRETARY_MIC_WORKLET, SECRETARY_PLAYBACK_WORKLET } from '../secretaryAudioWorklet';

export type SecretaryStatus = 'idle' | 'connecting' | 'connected' | 'error';

/**
 * 「キャンバス」— show_on_canvas・show_weather_map で秘書が画面に残す情報の1件。
 * テキスト（メールのまとめ・株価の一覧・レシピなど、Markdown）か画像（天気図・衛星画像）のどちらかが入る。
 * imageBase64 があれば画像として、無ければ content を Markdown として表示する。
 */
export interface SecretaryCanvas {
  id: number;
  title: string;
  content?: string;
  imageBase64?: string;
  imageMime?: string;
}

/**
 * 裏で動いている仕事（ヘルパーへ頼んだ調べ物・スライド作成など）の1件。
 * 数分かかるうえ、その間モデルは何も話さないため、これを画面に出さないと黙り込んだように見える。
 */
export interface SecretaryJob {
  id: string;
  /** 'presentation' ならスライド作成、それ以外は一般の依頼 */
  kind: string;
  /** 依頼の文（長いので画面では丸める） */
  request: string;
  /** 今どこまで進んだか（例: '6/8枚 — 画像と説明'）。サーバーが随時書き換える */
  progress: string;
}

/** useSecretaryLive が使う、プレイヤー側の値と操作。 */
export interface UseSecretaryLiveDeps {
  wsUrl: string;
  // ファイルの添付（POST /api/secretary/upload-file）に使う HTTP の URL。Gemini Live の WebSocket（wsUrl）とは
  // 別に、通常の HTTP でアップロードする。
  serverUrl: string;
  showWarn: (msg: string) => void;
  // セッションが終わったとき（「切断して」などの声の指示や、予期しない切断）に呼ばれる。Player.tsx が
  // ウェルカム画面へ戻すのに使う。フック自身の切断は内部で済ませ、画面の遷移だけをこれに任せる。
  onSessionEnd?: () => void;
}

/**
 * My Secretary の音声の会話（双方向の音声の流れ）を扱うフック。
 *
 * ほかのチャンネルと違い、放送の配信とは関係の無い専用の WebSocket とマイクの入出力を自分で持つ。
 * Player.tsx はチャンネルの切り替えとして connect()・disconnect() を呼ぶだけでよい。
 *
 * @param deps プレイヤー側の値と操作
 * @returns 接続・話している・相談中・処理中・無応答・キャンバスなどの状態と、接続・切断・ファイルの添付・
 *   テキストの共有の関数
 */
export function useSecretaryLive({ wsUrl, serverUrl, showWarn, onSessionEnd }: UseSecretaryLiveDeps) {
  const [status, setStatus] = useState<SecretaryStatus>('idle');
  // ファイルの添付をアップロードしている間 true（WebSocket とは別の HTTP なので、見た目のために状態で持つ）
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  // アバターを光らせるため、秘書の音声を受け取っている間 true（turnComplete・interrupted・切断で false）。
  // ほかのチャンネルの isAudioActive と同じ役割。
  const [isSpeaking, setIsSpeaking] = useState(false);
  // 専門エージェント本人の声（consult_agent）を再生している間の、そのエージェントの名前（画面に「〇〇が回答中」と出す）
  const [consultingAgentName, setConsultingAgentName] = useState<string | null>(null);
  // 相談中のエージェントのキー（アバターの画像 /avatars/{key}.png を引くため。表示名からは引けない）。
  // サーバーの CONSULT_AGENT_AUDIO がキーも送ってくるので、それをそのまま持つ（クライアントで名前からキーを
  // 逆引きしない）。
  const [consultingAgentKey, setConsultingAgentKey] = useState<string | null>(null);
  // 相談を呼び出してから本人の声が流れ始めるまで（30秒ほど）の間の、相手の名前。
  // consultingAgentName は本人が話している間だけなので、その待ち時間に誰に繋いでいるかを出すために、
  // 呼び出した瞬間にサーバーが送る SECRETARY_CONSULT_PENDING の名前を持つ。
  const [consultPendingName, setConsultPendingName] = useState<string | null>(null);
  // サーバー側でツール実行中（SECRETARY_PROCESSING）の間true。「処理中」表示に使う。
  const [isProcessing, setIsProcessing] = useState(false);
  // サーバー側の「だんまり」検知（SECRETARY_STALLED、一定時間Gemini Liveから無応答）でtrue。
  const [isStalled, setIsStalled] = useState(false);
  // 裏で動いている仕事。終わったものは取り除くので、中身があれば「今まさに処理中」を意味する。
  const [activeJobs, setActiveJobs] = useState<SecretaryJob[]>([]);
  // キャンバスに出した内容の履歴。上書きせず、下へ足していく。セッションの開始と終了で空にする
  // （connect・disconnect 参照）。
  const [canvasEntries, setCanvasEntries] = useState<SecretaryCanvas[]>([]);
  const canvasIdRef = useRef(0);
  // end_session が呼ばれた後、別れの挨拶を鳴らし終えてから切断するための印。
  // onSessionEnd は描画のたびに新しい関数になりうるので、ref で常に最新のものを持つ。
  const pendingSessionEndRef = useRef(false);
  const onSessionEndRef = useRef(onSessionEnd);
  onSessionEndRef.current = onSessionEnd;
  // 自分から切断する（「会話を終了」のボタン・end_session）ときに true にする。ws.onclose でこれが false のときだけ
  // 「予期しない切断」としてトーストを出し、ウェルカム画面へ戻す（自分から切ったときは、呼び出し元がすでに
  // 画面を移しているので二重にしない）。
  const intentionalDisconnectRef = useRef(false);
  // goAway（Gemini Live がセッションの終わりが近いと知らせる合図）を受け取ったことがあるか。
  // サーバー側がセッションを引き継ぐ（sessionResumption）ので、goAway の後も実際には切れずに続くことが多い。
  // 切断時のトーストの文言を分けるのに使い、idleTimeoutSignaledRef の方を優先する（ws.onclose 参照）。
  const timeoutSignaledRef = useRef(false);
  // 無操作によるサーバー側の切断（SECRETARY_IDLE_TIMEOUT）の予告を受け取ったか。
  // 接続したまましばらく会話の動きが無いと、サーバーが離席とみなして接続を終える。切断時のトーストの文言を分けるのに使う。
  const idleTimeoutSignaledRef = useRef(false);

  const wsRef            = useRef<WebSocket | null>(null);
  const micStreamRef      = useRef<MediaStream | null>(null);
  const inputCtxRef       = useRef<AudioContext | null>(null);
  const outputCtxRef      = useRef<AudioContext | null>(null);
  const micWorkletRef     = useRef<AudioWorkletNode | null>(null);
  const playbackWorkletRef = useRef<AudioWorkletNode | null>(null);
  // 専門エージェント本人の声を再生している間は、マイクの送信を止める（ハウリングと、Gemini Live が割り込みと
  // 誤って判定するのを防ぐ）。ノードの接続は切らず、この印で送信だけを飛ばす。
  const micMutedRef = useRef(false);
  // 直前に予定した本人の声が鳴り終わる時刻（outputCtx.currentTime と同じ時間軸）と、再生待ち・再生中の件数。
  // BUGFIX: queryRemainingSeconds はリングバッファ（秘書自身の声）の残りしか分からないので、本人の声が2件
  // 続けて届くと2件目が重なって鳴っていた。自分で予定した分は自分で覚えておき、次を必ずその後ろに並べる。
  const consultAudioEndsAtRef = useRef(0);
  const consultAudioPendingRef = useRef(0);

  /** ArrayBuffer を base64 にする（マイクの音を送るため）。 */
  const arrayBufferToBase64 = (buf: ArrayBuffer): string => {
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  /** base64 を16ビットの PCM にする（秘書の音声を再生するため）。 */
  const base64ToInt16 = (b64: string): Int16Array => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  };

  /** base64 を ArrayBuffer にする（本人の声の WAV をデコードするため）。 */
  const base64ToArrayBuffer = (b64: string): ArrayBuffer => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  /**
   * リングバッファに残っている音声の長さ（秒）を、ワークレットに問い合わせる（応答が無ければ0）。
   *
   * BUGFIX: 本人の声は、リングバッファ（秘書自身の声、例:「〇〇に確認します」）とは別の経路で鳴らすので、
   * すぐに start すると両方が重なって聞こえていた。残りの分だけ開始を遅らせて重なりを防ぐ。
   *
   * @param node 再生のワークレット
   * @param sampleRate 再生のサンプリングレート
   * @returns 残りの秒数
   */
  const queryRemainingSeconds = (node: AudioWorkletNode, sampleRate: number): Promise<number> => {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve(0), 500); // 応答が無ければ遅延なしで開始（フェイルセーフ）
      const handler = (ev: MessageEvent) => {
        if (ev.data && typeof ev.data.remainingSamples === 'number') {
          clearTimeout(timeoutId);
          node.port.removeEventListener('message', handler);
          resolve(ev.data.remainingSamples / sampleRate);
        }
      };
      node.port.addEventListener('message', handler);
      node.port.start();
      node.port.postMessage('query-remaining');
    });
  };

  /** マイク・AudioContext・ワークレット・WebSocket をすべて止めて片付ける（画面の状態は変えない）。 */
  const cleanup = () => {
    micMutedRef.current = false;
    // ATTENTION: 本人の声の予定をここで必ず戻すこと。consultAudioEndsAtRef は outputCtx.currentTime と同じ時間軸の
    // 値で、次のセッションでは新しい AudioContext が0から数え直すので、前の大きな値が残ると次の本人の声が
    // はるか先に予定されて聞こえなくなる。
    consultAudioEndsAtRef.current = 0;
    consultAudioPendingRef.current = 0;
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    micWorkletRef.current?.disconnect();
    micWorkletRef.current = null;
    playbackWorkletRef.current?.disconnect();
    playbackWorkletRef.current = null;
    inputCtxRef.current?.close().catch(() => {});
    inputCtxRef.current = null;
    outputCtxRef.current?.close().catch(() => {});
    outputCtxRef.current = null;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.close();
    wsRef.current = null;
  };

  /** 自分から切断し、画面の状態（話している・相談中・処理中・キャンバスなど）を初めに戻す。 */
  const disconnect = () => {
    intentionalDisconnectRef.current = true;
    cleanup();
    setStatus('idle');
    setIsSpeaking(false);
    setConsultingAgentName(null);
    setIsProcessing(false);
    setIsStalled(false);
    // セッションが終わったらキャンバスを空にする
    setCanvasEntries([]);
    setActiveJobs([]);
  };

  /**
   * ファイル（決算書など）を添付して、秘書に分析させる。
   * Gemini Live の WebSocket にはファイルを流し込めないので、先に HTTP（POST /api/secretary/upload-file）で
   * 保存し、終わったら file_id を WebSocket で秘書に知らせる（URL を口で伝えずに済む）。
   */
  const uploadFile = async (file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      showWarn('My Secretaryと接続していない状態ではファイルを送れません');
      return;
    }
    setIsUploadingFile(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${serverUrl}/api/secretary/upload-file`, { method: 'POST', body: formData });
      const json = await res.json();
      if (!res.ok) {
        showWarn(json.error || 'ファイルのアップロードに失敗しました');
        return;
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          event: 'SECRETARY_FILE_UPLOADED',
          fileId: json.fileId, fileName: json.fileName, mimeType: json.mimeType,
        }));
      }
    } catch (e) {
      console.error('[Secretary] ファイルアップロードに失敗:', e);
      showWarn('ファイルのアップロードに失敗しました');
    } finally {
      setIsUploadingFile(false);
    }
  };

  /**
   * URL や長い文など、声では伝えにくい情報を秘書と共有する。
   * 聞き取りにくく誤認識しやすいので声では送らず、WebSocket の制御メッセージとして送る（ファイルが無いので
   * HTTP のアップロードは要らない）。内容の種類はクライアントでは判断せず、そのまま送る。
   */
  const shareInfo = (text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      showWarn('My Secretaryと接続していない状態では情報を共有できません');
      return;
    }
    wsRef.current.send(JSON.stringify({ event: 'SECRETARY_INFO_SHARED', text }));
  };

  /** マイクの許可を取り、WebSocket と音声の入出力をつないで会話を始める。 */
  const connect = async () => {
    setStatus('connecting');
    setCanvasEntries([]);
    setActiveJobs([]);
    intentionalDisconnectRef.current = false;
    timeoutSignaledRef.current = false;
    // 一度でも接続できたセッションだけを「予期しない切断」の対象にする。マイクの拒否やサーバーが動いていない
    // など、接続する前の失敗は、同じ画面で「もう一度試す」を出す（ウェルカム画面へは戻さない）。
    let hadConnected = false;
    try {
      // マイクの許可は WebSocket より先に求める（拒否されたときに無駄な接続を張らないため）。
      //
      // BUGFIX: マイクの音の処理を明示する。ブラウザの既定のままだと、自動の音量調整（autoGainControl）が静かなときの
      // 環境音を声の大きさまで上げ、Gemini Live の発話検知が誤って割り込み（interrupted）と判定していた。
      // そうなったセッションでは、次の依頼で「かしこまりました」を2回繰り返していた。
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,   // 秘書自身の声がスピーカーからマイクに回り込むのを抑える
          noiseSuppression: true,   // 環境音でVADが誤発火するのを抑える
          autoGainControl: false,   // 無音時に環境音を増幅させない（誤検知の主因になりうる）
        },
      });
      micStreamRef.current = micStream;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      // BUGFIX: onopen は WebSocket を作った直後に設定する。後ろ（AudioWorklet の読み込みを待った後）で設定して
      // いたころは、localhost への接続が先に終わって open を取りこぼし、表示が「接続中…」のまま固まっていた。
      ws.onopen = () => { setStatus('connected'); hadConnected = true; };

      // 入力（マイク → 16kHz の PCM）用の AudioContext。サンプリングレートを16000にして、変換はブラウザに任せる。
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioContextClass({ sampleRate: 16000 });
      inputCtxRef.current = inputCtx;
      const micBlob = new Blob([SECRETARY_MIC_WORKLET], { type: 'application/javascript' });
      const micUrl = URL.createObjectURL(micBlob);
      await inputCtx.audioWorklet.addModule(micUrl);
      URL.revokeObjectURL(micUrl);

      const micSource = inputCtx.createMediaStreamSource(micStream);
      const micNode = new AudioWorkletNode(inputCtx, 'secretary-mic-processor');
      micWorkletRef.current = micNode;
      micNode.port.onmessage = ({ data }: { data: ArrayBuffer }) => {
        if (ws.readyState !== WebSocket.OPEN || micMutedRef.current) return;
        ws.send(JSON.stringify({
          realtimeInput: { audio: { data: arrayBufferToBase64(data), mimeType: 'audio/pcm;rate=16000' } },
        }));
      };
      micSource.connect(micNode);
      // ノードをグラフに保持しておくため無音でdestinationへ繋ぐ（音声としては出力しない）
      const silentGain = inputCtx.createGain();
      silentGain.gain.value = 0;
      micNode.connect(silentGain).connect(inputCtx.destination);

      // 出力（Gemini Live → 24kHz の PCM）用の AudioContext。Gemini Live の音声は24kHz（secretary-live-routes.js 参照）。
      const outputCtx = new AudioContextClass({ sampleRate: 24000 });
      outputCtxRef.current = outputCtx;
      const playbackBlob = new Blob([SECRETARY_PLAYBACK_WORKLET], { type: 'application/javascript' });
      const playbackUrl = URL.createObjectURL(playbackBlob);
      await outputCtx.audioWorklet.addModule(playbackUrl);
      URL.revokeObjectURL(playbackUrl);

      const playbackNode = new AudioWorkletNode(outputCtx, 'secretary-playback-processor');
      playbackWorkletRef.current = playbackNode;
      playbackNode.connect(outputCtx.destination);
      // BUGFIX: 再生のバッファが上限まで広げても溢れたら、必ず記録に残す。以前は黙って捨てており、
      // 「長い回答の最後が途切れる」という症状からしか分からなかった（secretaryAudioWorklet.ts 参照）。
      playbackNode.port.addEventListener('message', (ev: MessageEvent) => {
        if (ev.data && typeof ev.data.droppedSamples === 'number') {
          const sec = (ev.data.droppedSamples / 24000).toFixed(1);
          console.warn(`[Secretary] 再生バッファが上限(${(ev.data.capSamples / 24000).toFixed(0)}秒)を超え、${sec}秒分の音声を破棄しました`);
          showWarn('応答が長すぎたため、音声の一部を再生できませんでした');
        }
      });
      playbackNode.port.start();

      ws.onmessage = (ev) => {
        let parsed: any;
        try { parsed = JSON.parse(ev.data); } catch { return; }

        if (parsed.event === 'SECRETARY_ERROR') {
          showWarn(parsed.message || 'My Secretaryとの通信でエラーが発生しました');
          return;
        }

        // Gemini Live がセッションの終わりが近いと知らせる合図（goAway）。本当に切れたら ws.onclose が届くので、
        // ここでは印を立てるだけにし、切断時のトーストの文言をこれで分ける。
        if (parsed.goAway) {
          timeoutSignaledRef.current = true;
          return;
        }

        // サーバーが無操作（離席）と判断し、まもなく接続を終える合図。本当の切断は、この後の ws.onclose で届く。
        if (parsed.event === 'SECRETARY_IDLE_TIMEOUT') {
          idleTimeoutSignaledRef.current = true;
          return;
        }

        // サーバー側がツール実行中（consult_agent等）かどうかを知らせる。「処理中」表示に使う。
        if (parsed.event === 'SECRETARY_PROCESSING') {
          setIsProcessing(!!parsed.processing);
          // ツール実行が終わったら「お繋ぎしています」も必ず畳む。音声が届かずに終わった場合
          // （相談が失敗した・音声合成に失敗した等）でも表示が残り続けないようにするため。
          if (!parsed.processing) setConsultPendingName(null);
          return;
        }
        // 相談の呼び出しを受け付けた瞬間にサーバーから届く。本人の声が始まるまでの間、
        // 誰に繋いでいるのかを画面に出すために使う（秘書が声で言うかはモデル任せのため、
        // 表示だけはコード側で必ず出す）。
        if (parsed.event === 'SECRETARY_CONSULT_PENDING') {
          setConsultPendingName(parsed.agentName || null);
          return;
        }
        // サーバー側の「だんまり」検知（一定時間Gemini Liveから無応答）。
        if (parsed.event === 'SECRETARY_STALLED') {
          setIsStalled(!!parsed.stalled);
          return;
        }
        // 裏で動いている仕事の進み具合。running の間は一覧に置き、終わったら取り除く。
        // ATTENTION: 画面に出すのはリスナーのため。ダッシュボードにも同じ通知が行くが、そちらは
        //            運用者向けで、会話している本人は見ていない。
        if (parsed.event === 'SECRETARY_JOB_STATUS') {
          setActiveJobs(prev => {
            const rest = prev.filter(j => j.id !== parsed.id);
            if (parsed.status !== 'running') return rest;
            return [...rest, {
              id: parsed.id,
              kind: parsed.kind || 'helper',
              request: parsed.request || '',
              progress: parsed.progress || '',
            }];
          });
          return;
        }
        // show_on_canvas・show_weather_map で秘書が画面に残した情報（メールのまとめ・株価の一覧・レシピ・天気図など）。
        // 上書きせず、履歴として下へ足していく。
        if (parsed.event === 'CANVAS_UPDATE') {
          canvasIdRef.current += 1;
          setCanvasEntries(prev => [...prev, {
            id: canvasIdRef.current,
            title: parsed.title || '',
            content: parsed.content || undefined,
            imageBase64: parsed.imageBase64 || undefined,
            imageMime: parsed.imageMime || undefined,
          }]);
          return;
        }
        // end_sessionツールが呼ばれた合図。別れの挨拶はこのメッセージの前後で音声として
        // 既に流れてきている（turnCompleteの音声チャンクと同じ経路）ため、ここでは即座に
        // 切断せず、下のturnComplete処理で再生完了を確認してから切断する。
        if (parsed.event === 'SECRETARY_SESSION_END') {
          pendingSessionEndRef.current = true;
          return;
        }

        // consult_agent「本人の声」の逐次差し込み再生。Gemini Live自身の音声（リングバッファ
        // 経由）とは別に、この1本だけは直接AudioBufferSourceNodeで再生する（decodeAudioDataが
        // WAVを自前でデコードしてくれるため、リングバッファへ流し込む変換は不要）。
        // 再生中はマイクを止め、終わったらCONSULT_AGENT_AUDIO_DONEをサーバーへ返して
        // Gemini Live側の会話継続（toolResponse送信）を許可する。
        if (parsed.event === 'CONSULT_AGENT_AUDIO') {
          micMutedRef.current = true;
          setConsultingAgentName(parsed.agentName || null);
          setConsultingAgentKey(parsed.agentKey || null);
          // 本人が喋り始めたので「お繋ぎしています」は畳む（以降は「〇〇が回答中…」の表示へ）
          setConsultPendingName(null);
          // 本人の声は2件続けて届くことがある（consultAudioEndsAtRef 参照）ので、1件目が終わった時点で
          // マイクを開けたりアバターを戻したりしないよう、再生待ち・再生中の件数で管理する。
          // ATTENTION: 完了の通知（DONE）は音声1本につき必ず1回だけ送ること。サーバーは届いた DONE を
          // 古い待ちから順に1件ずつ消費するので、1対1が崩れると待ちが迷子になる。
          consultAudioPendingRef.current += 1;
          let finished = false;
          const finishConsultAudio = () => {
            if (finished) return; // onendedとcatchの両方から呼ばれても二重送信しない
            finished = true;
            consultAudioPendingRef.current = Math.max(0, consultAudioPendingRef.current - 1);
            if (consultAudioPendingRef.current === 0) {
              micMutedRef.current = false;
              setConsultingAgentName(null);
              setConsultingAgentKey(null);
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ event: 'CONSULT_AGENT_AUDIO_DONE' }));
            }
          };
          Promise.all([
            outputCtx.decodeAudioData(base64ToArrayBuffer(parsed.audioBase64)),
            queryRemainingSeconds(playbackNode, 24000),
          ])
            .then(([buffer, delaySeconds]) => {
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              source.onended = finishConsultAudio;
              // リングバッファ（秘書自身の声）の残りと、自分で予定した本人の声の
              // 終了予定時刻の「遅い方」を開始時刻にする。どちらか一方だけを見ていると、
              // もう一方と重なって同時に鳴ってしまう。
              const startAt = Math.max(
                outputCtx.currentTime + delaySeconds,
                consultAudioEndsAtRef.current,
              );
              source.start(startAt);
              consultAudioEndsAtRef.current = startAt + buffer.duration;
            })
            .catch((e) => {
              showWarn(`${parsed.agentName || '委任先エージェント'}の音声再生に失敗しました`);
              console.error('[Secretary] consult_agent音声のデコードに失敗:', e);
              finishConsultAudio();
            });
          return;
        }

        // barge-in（ユーザーが話し始めた）検出時は再生待ちの音声を即座に破棄する
        if (parsed.serverContent?.interrupted) {
          playbackNode.port.postMessage('reset');
          setIsSpeaking(false);
        }
        if (parsed.serverContent?.turnComplete) {
          setIsSpeaking(false);
          // end_sessionが呼ばれた後の最初のturnComplete＝別れの挨拶のターンが終わった合図。
          // ただしリングバッファにはまだ再生待ちの音声が残っている可能性があるため
          // （consult_agentの音声重なりバグと同じ理由）、残り再生時間を確認してから切断する。
          if (pendingSessionEndRef.current) {
            pendingSessionEndRef.current = false;
            queryRemainingSeconds(playbackNode, 24000).then((delaySeconds) => {
              setTimeout(() => {
                disconnect();
                onSessionEndRef.current?.();
              }, delaySeconds * 1000 + 300);
            });
          }
        }

        const parts = parsed.serverContent?.modelTurn?.parts;
        if (parts) {
          for (const p of parts) {
            if (p.inlineData?.data) {
              setIsSpeaking(true);
              const pcm16 = base64ToInt16(p.inlineData.data);
              const float32 = new Float32Array(pcm16.length);
              for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x8000;
              playbackNode.port.postMessage(float32.buffer, [float32.buffer]);
            }
          }
        }
      };

      ws.onerror = () => {
        showWarn('My Secretaryへの接続でエラーが発生しました');
        setStatus('error');
      };

      ws.onclose = () => {
        const wasIntentional = intentionalDisconnectRef.current;
        const wasIdleTimeout = idleTimeoutSignaledRef.current;
        const wasTimeout = timeoutSignaledRef.current;
        cleanup();
        setStatus('idle');
        setIsSpeaking(false);
        setConsultingAgentName(null);
        setIsProcessing(false);
        setIsStalled(false);
        setCanvasEntries([]);
        setActiveJobs([]);
        // 放置によるタイムアウトなどの予期しない切断は、同じ画面に留まらず、トーストを出してウェルカム画面へ戻す。
        // 自分から切断したとき（呼び出し元が画面を移し済み）と、接続する前の失敗（同じ画面で再試行させたい）は対象外。
        // ATTENTION: 無操作の切断（wasIdleTimeout）を最優先で判定すること。goAway を受けた後もセッションの引き継ぎで
        // 続いていることがあり、その後の無操作の切断を「タイムアウト」と誤って表示しないため。
        if (!wasIntentional && hadConnected) {
          showWarn(wasIdleTimeout
            ? '💤 しばらく操作が無かったため接続を終了しました。ウェルカム画面に戻ります。'
            : wasTimeout
              ? '⏱️ タイムアウトが発生しました。ウェルカム画面に戻ります。'
              : '⚠️ My Secretaryとの接続が切断されました。ウェルカム画面に戻ります。');
          onSessionEndRef.current?.();
        }
      };
    } catch (e: any) {
      showWarn(e?.name === 'NotAllowedError'
        ? 'マイクの使用が許可されませんでした。ブラウザの設定を確認してください。'
        : 'My Secretaryの起動に失敗しました');
      cleanup();
      setStatus('error');
      setIsSpeaking(false);
      setConsultingAgentName(null);
    }
  };

  return {
    status, isSpeaking, consultingAgentName, consultingAgentKey, consultPendingName, isProcessing, isStalled,
    activeJobs, canvasEntries, connect, disconnect,
    uploadFile, isUploadingFile, shareInfo,
  };
}
