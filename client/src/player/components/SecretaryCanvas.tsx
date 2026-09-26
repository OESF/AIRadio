/**
 * @file 秘書（My Secretary）の「キャンバス」表示（show_on_canvas・show_weather_map で見せる内容）
 *
 * Markdown は react-markdown と remark-gfm（表・打ち消し線・自動リンクなど）で描き、components でダークテーマの
 * 見た目だけを当てる（自前のパーサーは、構文を足すたびに別の構文が欠けたのでやめた）。mermaid のコードブロックは
 * 図にする。キャンバスは上書きではなく追記していき、各項目はコピーと Obsidian への保存ができる。
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

import { isValidElement, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import type { SecretaryCanvas } from '../hooks/useSecretaryLive';


/**
 * mermaid は、実際に mermaid のコードブロックを表示するときだけ読み込む。本体は依存込みで 600KB を超え、
 * 静的に読み込むとメインのバンドルが倍以上になり、秘書を使わないリスナーにも読み込みの負担がかかる。
 */
let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null;
function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => {
      // 自動で走査させず、React の描画に合わせて mermaid.render() を呼ぶ（自動の走査は React の DOM の管理とぶつかる）
      mod.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      return mod;
    });
  }
  return mermaidModulePromise;
}
let mermaidRenderCounter = 0;

/**
 * Gemini が書いた mermaid のコードを、描く直前に決まった手順で直す。
 *
 * BUGFIX: グラフが表示されない原因は、改行の代わりに「\n」という2文字を書いてしまうことと、タイトルや
 *         ラベルを全角の引用符で囲んでしまうこと（mermaid は半角の引用符しか受け付けない）だった。
 *         LLM の出力は揺れるので、プロンプトの指示だけでは防ぎきれない。
 * @param code mermaid のコード
 * @returns 直したコード
 */
function sanitizeMermaidCode(code: string): string {
  return code
    .replace(/\\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/**
 * mermaid のコードブロックを SVG に描く。
 *
 * ATTENTION: ID はグローバルな番号で一意にする。キャンバスは追記式なので同じ画面に何度も描かれ、mermaid は
 *            同じ ID の SVG がすでに DOM にあると失敗する。
 * @param props.code mermaid のコード
 */
function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `secretary-mermaid-${++mermaidRenderCounter}`;
    loadMermaid()
      .then(({ default: mermaid }) => mermaid.render(id, code))
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) containerRef.current.innerHTML = svg;
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    // 構文エラーのときは、生のコードを表示する（不格好だが、黙って消えるより失敗が分かる方がよい）
    return <pre className="bg-black/40 rounded p-3 overflow-x-auto text-xs my-2 text-red-400">{code}</pre>;
  }
  return <div ref={containerRef} className="my-2 flex justify-center [&_svg]:max-w-full" />;
}

/** Markdown の要素ごとの見た目（ダークテーマ）。 */
const markdownComponents: Components = {
  h1: ({ children }) => <h2 className="text-base font-bold text-neon-blue mt-3 mb-1 text-left first:mt-0">{children}</h2>,
  h2: ({ children }) => <h2 className="text-base font-bold text-neon-blue mt-3 mb-1 text-left first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold text-white mt-3 mb-1 text-left first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-bold text-white mt-2 mb-1 text-left first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="text-sm text-gray-300 leading-relaxed mb-1.5 text-left">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 flex flex-col gap-1 mb-2 text-left text-sm text-gray-300">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 flex flex-col gap-1 mb-2 text-left text-sm text-gray-300">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="text-white font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic text-gray-200">{children}</em>,
  del: ({ children }) => <del className="line-through text-gray-500">{children}</del>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-neon-blue underline">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <img src={typeof src === 'string' ? src : undefined} alt={alt} className="max-w-full h-auto rounded my-2 block" />
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-white/20 pl-3 italic text-gray-400 my-2 text-sm">{children}</blockquote>
  ),
  hr: () => <hr className="border-white/10 my-3" />,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className || '');
    if (/language-mermaid/.test(className || '')) {
      return <MermaidDiagram code={sanitizeMermaidCode(String(children).replace(/\n$/, ''))} />;
    }
    if (isBlock) return <code className={`${className} text-xs`}>{children}</code>;
    return <code className="text-neon-blue bg-black/40 px-1 rounded text-xs">{children}</code>;
  },
  pre: ({ children }) => {
    // mermaid のブロックは code の側で枠の無い図を返しているので、普通のコードブロックの枠で二重に包まない
    // （子の className で判定する）
    const child = Array.isArray(children) ? children[0] : children;
    const isMermaid = isValidElement(child)
      && /language-mermaid/.test(String((child.props as { className?: string })?.className || ''));
    if (isMermaid) return <>{children}</>;
    return <pre className="bg-black/40 rounded p-3 overflow-x-auto text-xs my-2 text-gray-300">{children}</pre>;
  },
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2">
      <table className="w-full text-sm text-left border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-white/8">{children}</tr>,
  th: ({ children }) => (
    <th className="border-b border-white/20 px-2 py-1 text-purple-300 font-bold whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1 text-gray-300 align-top">{children}</td>,
};

// 表示された内容を手元に残す操作。キャンバスは会話の間だけのもので、切断すると消える。
//   コピー: その場で他のアプリへ貼りたいとき（テキストは Markdown、画像は画像のまま）
//   Obsidian へ: 手元に残しておきたいとき（ノートのフォルダーへ、フロントマター付きで書く）
// 残したいかどうかは見た本人にしか分からないので、AI の判断ではなくボタンの操作にする。
type SaveState = 'idle' | 'busy' | 'done' | 'error';

/**
 * キャンバスの1項目のコピーと保存のボタン。
 * @param props.canvas 表示している項目
 */
function CanvasEntryActions({ canvas }: { canvas: SecretaryCanvas }) {
  const [copied, setCopied] = useState<SaveState>('idle');
  const [saved, setSaved] = useState<SaveState>('idle');

  const flash = (set: (v: SaveState) => void, v: SaveState) => {
    set(v);
    setTimeout(() => set('idle'), 2200);
  };

  const onCopy = async () => {
    try {
      if (canvas.imageBase64) {
        // 画像は画像のままクリップボードへ載せる（他のアプリへそのまま貼れるように）
        const mime = canvas.imageMime || 'image/png';
        const bin = atob(canvas.imageBase64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        await navigator.clipboard.write([new ClipboardItem({ [mime]: new Blob([buf], { type: mime }) })]);
      } else {
        const text = [canvas.title ? `## ${canvas.title}` : '', canvas.content || ''].filter(Boolean).join('\n\n');
        await navigator.clipboard.writeText(text);
      }
      flash(setCopied, 'done');
    } catch {
      // ブラウザが ClipboardItem に対応していない・権限が無いなど。黙って失敗させない
      flash(setCopied, 'error');
    }
  };

  const onSave = async () => {
    setSaved('busy');
    try {
      const r = await fetch('/api/secretary/canvas-to-obsidian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: canvas.title, content: canvas.content,
          imageBase64: canvas.imageBase64, imageMime: canvas.imageMime,
        }),
      });
      flash(setSaved, r.ok ? 'done' : 'error');
    } catch {
      flash(setSaved, 'error');
    }
  };

  const btn = 'text-[10px] px-2 py-0.5 rounded border transition-colors';
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <button
        type="button" onClick={onCopy} title="この内容をコピー"
        className={`${btn} ${copied === 'done' ? 'border-emerald-400/60 text-emerald-300'
          : copied === 'error' ? 'border-red-400/60 text-red-300'
            : 'border-white/15 text-gray-400 hover:border-purple-400/50 hover:text-purple-300'}`}
      >
        {copied === 'done' ? 'コピーしました' : copied === 'error' ? 'できませんでした' : 'コピー'}
      </button>
      <button
        type="button" onClick={onSave} disabled={saved === 'busy'} title="Obsidianのノートとして保存"
        className={`${btn} ${saved === 'done' ? 'border-emerald-400/60 text-emerald-300'
          : saved === 'error' ? 'border-red-400/60 text-red-300'
            : 'border-white/15 text-gray-400 hover:border-purple-400/50 hover:text-purple-300'}`}
      >
        {saved === 'busy' ? '保存中…' : saved === 'done' ? '保存しました'
          : saved === 'error' ? '保存できませんでした' : 'Obsidianへ'}
      </button>
    </div>
  );
}

/**
 * キャンバスの1項目（画像か Markdown）。
 * @param props.canvas 表示する項目
 */
function SecretaryCanvasEntryView({ canvas }: { canvas: SecretaryCanvas }) {
  return (
    <div className="text-left">
      <div className="flex items-start justify-between gap-2 mb-2">
        {canvas.title
          ? <p className="text-xs font-bold text-purple-300 uppercase tracking-wider min-w-0">{canvas.title}</p>
          : <span />}
        <CanvasEntryActions canvas={canvas} />
      </div>
      {canvas.imageBase64 ? (
        <img
          src={`data:${canvas.imageMime || 'image/png'};base64,${canvas.imageBase64}`}
          alt={canvas.title}
          className="w-full h-auto rounded"
        />
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {canvas.content || ''}
        </ReactMarkdown>
      )}
    </div>
  );
}

/**
 * キャンバスの全体。項目が増えるたびに、一番下（最新）が見えるよう自動でスクロールする。
 * スクロールの領域もこのコンポーネントが持つ（Player.tsx は高さと枠線だけを外から指定する）。
 * @param props.entries 表示する項目（古い順）
 * @param props.className 外側の要素のクラス
 */
export function SecretaryCanvasView({ entries, className }: { entries: SecretaryCanvas[]; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div ref={scrollRef} className={className}>
      <div className="flex flex-col gap-4">
        {entries.map((entry, i) => (
          <div key={entry.id} className={i > 0 ? 'pt-4 border-t border-white/8' : ''}>
            <SecretaryCanvasEntryView canvas={entry} />
          </div>
        ))}
      </div>
    </div>
  );
}
