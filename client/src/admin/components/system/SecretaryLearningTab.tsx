/**
 * @file 管理画面の「秘書の学習内容」タブ（リスナー情報のダイジェストと、個別の学習内容の確認・訂正）
 *
 * 秘書が覚えたこと（server/lib/secretary-memory.js）を見て、誤りを直す。明示的に覚えたものと自動で覚えたものは
 * 1ページにまとめ、由来は行ごとのバッジで示す。ダイジェスト（全件を要約した1本の文。全チャンネルのエージェントへ
 * 渡る）が主役で、個別の一覧は誤りを見つけて直すためのもの（既定で畳む）。
 * API: GET /api/secretary-memory、GET・PUT /api/secretary-digest ほか。
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

import { useEffect, useRef, useState } from 'react';

/**
 * 秘書の学習内容のタブ。状態はこのコンポーネントの中に閉じて持つ（App.tsx に持たせるほどの規模ではない）。
 * @param props.serverUrl API サーバーの URL
 */
export function SecretaryLearningTab({ serverUrl }: { serverUrl: string }) {
  const [secretaryLearnings, setSecretaryLearnings] = useState<
    { id: number; text: string; source: string; addedAt: string }[]
  >([]);
  useEffect(() => {
    fetch(`${serverUrl}/api/secretary-memory`)
      .then(r => r.json())
      .then(data => setSecretaryLearnings(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [serverUrl]);

  // リスナー情報のダイジェスト（server/data/secretary/memory/digest.json）。要約に誤りが入ることがあるので、
  // ここで直せる。直すと manuallyEdited が立つ。
  // BUGFIX: 直した後も自動の更新は止まらない。直した文は manualCore としてそのまま残し、そこに無い新しい事実だけを
  //         後ろへ足す（secretary-memory.js の summarizeListenerDigest）。以前はこの印で更新が止まり、学習が放送へ
  //         届かなくなった。
  const [secretaryDigest, setSecretaryDigest] = useState<
    { text: string; sourceMaxId: number; generatedAt: string; manuallyEdited?: boolean } | null
  >(null);
  const [digestEditing, setDigestEditing] = useState(false);
  const [digestEditText, setDigestEditText] = useState('');
  useEffect(() => {
    fetch(`${serverUrl}/api/secretary-digest`)
      .then(r => r.json())
      .then(data => setSecretaryDigest(data || null))
      .catch(() => {});
  }, [serverUrl]);
  const saveDigestEdit = () => {
    const text = digestEditText.trim();
    if (!text) return;
    fetch(`${serverUrl}/api/secretary-digest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then(r => r.json())
      .then((res) => {
        if (res.error) { window.alert(res.error); return; }
        setSecretaryDigest(res.digest);
        setDigestEditing(false);
      })
      .catch(() => window.alert('ダイジェストの更新に失敗しました'));
  };

  // 個別の学習内容の一覧の開閉（既定は閉じる）。情報源が増えるほど件数も増えるので、普段は畳んでおく
  const [showRawLearnings, setShowRawLearnings] = useState(false);

  // 学習内容の削除と編集（自動の要約が誤った内容を覚えることがあるため）
  const [secretaryLearningEditingId, setSecretaryLearningEditingId] = useState<number | null>(null);
  const [secretaryLearningEditingText, setSecretaryLearningEditingText] = useState('');
  // 件数が COMPACT_THRESHOLD を超えたら各行を1行に畳み、クリックで1件ずつ開く（ページが縦に伸び続けないように）
  const [expandedLearningIds, setExpandedLearningIds] = useState<Set<number>>(new Set());
  const COMPACT_LEARNING_THRESHOLD = 8;
  const toggleLearningExpanded = (id: number) => {
    setExpandedLearningIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  // スクロールの領域の高さを、リストの画面上の位置から測ってウィンドウの残りに収める（リサイズにも追従する）
  const learningListRef = useRef<HTMLDivElement>(null);
  const [learningListMaxHeight, setLearningListMaxHeight] = useState(560);
  useEffect(() => {
    const BOTTOM_MARGIN = 24; // 画面の下に残す余白
    const MIN_HEIGHT = 240;   // 画面が低くても確保する高さ
    const updateHeight = () => {
      if (!learningListRef.current) return;
      const top = learningListRef.current.getBoundingClientRect().top;
      setLearningListMaxHeight(Math.max(MIN_HEIGHT, window.innerHeight - top - BOTTOM_MARGIN));
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [secretaryLearnings.length]);

  const deleteSecretaryLearning = (id: number) => {
    if (!window.confirm('この学習内容を削除しますか？')) return;
    fetch(`${serverUrl}/api/secretary-memory/${id}`, { method: 'DELETE' })
      .then(r => r.json())
      .then((res) => {
        if (res.error) { window.alert(res.error); return; }
        setSecretaryLearnings(prev => prev.filter(l => l.id !== id));
      })
      .catch(() => window.alert('学習内容の削除に失敗しました'));
  };

  const saveSecretaryLearningEdit = (id: number) => {
    const text = secretaryLearningEditingText.trim();
    if (!text) return;
    fetch(`${serverUrl}/api/secretary-memory/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then(r => r.json())
      .then((res) => {
        if (res.error) { window.alert(res.error); return; }
        setSecretaryLearnings(prev => prev.map(l => (l.id === id ? { ...l, text } : l)));
        setSecretaryLearningEditingId(null);
      })
      .catch(() => window.alert('学習内容の更新に失敗しました'));
  };

  // 学習内容の1行（編集中はテキストエリア、それ以外は表示と操作のボタン）。由来はバッジで示し、compact の間は
  // 本文を1行に畳んで、クリックで開く。
  const renderSecretaryLearningRow = (l: { id: number; text: string; source: string; addedAt: string }, compact: boolean) => {
    const isEditing = secretaryLearningEditingId === l.id;
    const isExpanded = !compact || expandedLearningIds.has(l.id);
    const sourceBadge = l.source === 'explicit'
      ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-neon-blue/30 text-neon-blue whitespace-nowrap">📌 明示的</span>
      : l.source === 'compacted'
      ? <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 text-amber-300 whitespace-nowrap" title="古い【自動】学習内容をまとめて圧縮したものです">🗜️ 要約済み</span>
      : <span className="text-[10px] px-1.5 py-0.5 rounded border border-purple-400/30 text-purple-300 whitespace-nowrap">🧠 自動</span>;
    return (
      <div key={l.id} className="bg-black/20 border border-glass rounded-lg px-3 py-2">
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={secretaryLearningEditingText}
              onChange={(e) => setSecretaryLearningEditingText(e.target.value)}
              rows={2}
              className="w-full text-sm bg-black/30 border border-glass rounded px-2 py-1 text-white/90"
            />
            <div className="flex items-center gap-1 justify-end">
              <button
                onClick={() => saveSecretaryLearningEdit(l.id)}
                className="btn btn-dark text-xs px-2 py-1 border border-green-500/40 text-green-400 hover:border-green-400"
              >
                ✓ 保存
              </button>
              <button
                onClick={() => setSecretaryLearningEditingId(null)}
                className="btn btn-dark text-xs px-2 py-1 border border-glass text-gray-400"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <div
              className="flex-1 min-w-0"
              style={compact ? { cursor: 'pointer' } : undefined}
              onClick={compact ? () => toggleLearningExpanded(l.id) : undefined}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {sourceBadge}
                <span className="text-[10px] text-gray-600">{new Date(l.addedAt).toLocaleString('ja-JP')}</span>
              </div>
              <p className={`text-sm text-white/90 ${isExpanded ? 'whitespace-normal' : 'truncate'}`}>{l.text}</p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => { setSecretaryLearningEditingId(l.id); setSecretaryLearningEditingText(l.text); }}
                className="btn btn-dark text-xs px-2 py-1 border border-neon-blue/30 text-neon-blue hover:border-neon-blue"
                title="編集"
              >
                ✏
              </button>
              <button
                onClick={() => deleteSecretaryLearning(l.id)}
                className="btn btn-dark text-xs px-2 py-1 border border-red-500/30 text-red-400 hover:border-red-500"
                title="削除"
              >
                🗑
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const items = secretaryLearnings;
  const compact = items.length > COMPACT_LEARNING_THRESHOLD;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 border-b border-glass pb-4" style={{ marginBottom: '20px' }}>
        <span className="text-lg">🧠</span>
        <h2 className="text-lg font-bold text-neon-blue">学習内容</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        下の「リスナー情報ダイジェスト」が、AIが今どんな人物像を把握しているかの
        一目で分かる要約です。通常はこちらだけ確認すれば十分です。個別の学習内容
        （明示的に頼んだこと・会話やメールから自動で学んだこと）は、誤りを見つけて
        訂正したいときのための詳細表示として折りたたんであります。
      </p>

      {/* ── リスナー情報のダイジェスト: 学習内容の全件を要約した1本の文で、全チャンネルのエージェントへ渡る。この文も直せる（直した文はそのまま残り、新しい学習は後ろへ足される） ── */}
      <div className="bg-black/20 border border-neon-blue/20 rounded-lg p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-base">🧭</span>
            <h3 className="text-sm font-bold text-neon-blue">リスナー情報ダイジェスト</h3>
            {secretaryDigest?.manuallyEdited && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-neon-blue/30 text-neon-blue whitespace-nowrap">✏️ 手動訂正済み</span>
            )}
          </div>
          {secretaryDigest && !digestEditing && (
            <button
              onClick={() => { setDigestEditing(true); setDigestEditText(secretaryDigest.text); }}
              className="btn btn-dark text-xs px-2 py-1 border border-neon-blue/30 text-neon-blue hover:border-neon-blue"
            >
              ✏ 編集
            </button>
          )}
        </div>
        <p className="text-xs text-gray-500 -mt-1">
          上記の学習内容全件を3〜5文に要約したもので、Live各コーナー・Classic/Jazz/Mood/
          Beatlesのディレクター・The Answersのテーマ選定など、全エージェントへ共通で
          配信されます。内容に誤りがあれば直接訂正できます。訂正した文章は
          そのまま保持され、AIが勝手に書き換えることはありません。新しく学習した事実は
          その後ろへ追記される形で増えていきます（訂正内容と食い違う学習は採用されません）。
        </p>
        {!secretaryDigest ? (
          <p className="text-xs text-gray-600">
            まだダイジェストは生成されていません（My Secretaryとの会話終了後に生成されます）。
          </p>
        ) : digestEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={digestEditText}
              onChange={(e) => setDigestEditText(e.target.value)}
              rows={4}
              className="w-full text-sm bg-black/30 border border-glass rounded px-2 py-1 text-white/90"
            />
            <div className="flex items-center gap-1 justify-end">
              <button
                onClick={saveDigestEdit}
                className="btn btn-dark text-xs px-2 py-1 border border-green-500/40 text-green-400 hover:border-green-400"
              >
                ✓ 保存
              </button>
              <button
                onClick={() => setDigestEditing(false)}
                className="btn btn-dark text-xs px-2 py-1 border border-glass text-gray-400"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-white/90 whitespace-normal">{secretaryDigest.text}</p>
            <p className="text-[10px] text-gray-600">
              最終更新: {new Date(secretaryDigest.generatedAt).toLocaleString('ja-JP')}
            </p>
          </>
        )}
      </div>

      {/* ── 個別の学習内容の一覧: 誤りを見つけて直すときだけ開く（既定は畳む） ── */}
      <div className="bg-black/20 border border-glass rounded-lg">
        <button
          onClick={() => setShowRawLearnings(prev => !prev)}
          className="w-full flex items-center gap-2 px-4 py-3 text-left"
        >
          <span className="text-xs text-gray-400">{showRawLearnings ? '▾' : '▸'}</span>
          <span className="text-sm font-bold text-gray-300">個別の学習内容を表示</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 text-gray-500">{items.length}件</span>
          <span className="ml-auto text-[10px] text-gray-600">誤りの訂正・削除はこちらから</span>
        </button>
        {showRawLearnings && (
          <div className="px-4 pb-4">
            {items.length === 0 ? (
              <p className="text-xs text-gray-600">まだ学習内容はありません。</p>
            ) : (
              <div
                ref={learningListRef}
                className={`flex flex-col gap-2 ${compact ? 'overflow-y-auto pr-1' : ''}`}
                style={compact ? { maxHeight: learningListMaxHeight } : undefined}
              >
                {items.map(l => renderSecretaryLearningRow(l, compact))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
