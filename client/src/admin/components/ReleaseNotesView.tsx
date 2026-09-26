/**
 * @file リリースノート（RELEASENOTE.md）の簡易表示
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

import type { ReactNode } from 'react';
import { CheckCircle } from 'lucide-react';
import { renderInlineMarkdown } from '../utils';

/**
 * RELEASENOTE.md が実際に使っている記法（見出し #・##・###、チェックリスト、箇条書き、太字、
 * インラインコード）だけを表示する。汎用の Markdown パーサーではない。
 * @param props.content RELEASENOTE.md の本文
 */
export function ReleaseNotesView({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  let listBuffer: ReactNode[] = [];
  const flushList = (key: string) => {
    if (listBuffer.length > 0) {
      blocks.push(<ul key={`ul-${key}`} className="flex flex-col gap-2 mb-3">{listBuffer}</ul>);
      listBuffer = [];
    }
  };

  content.split('\n').forEach((line, idx) => {
    const key = String(idx);
    if (line.startsWith('## ')) {
      flushList(key);
      blocks.push(<h2 key={key} className="text-lg font-bold text-neon-blue mt-6 mb-2 pb-2 border-b border-glass first:mt-0">{renderInlineMarkdown(line.slice(3))}</h2>);
    } else if (line.startsWith('### ')) {
      flushList(key);
      blocks.push(<h3 key={key} className="text-sm font-bold text-purple-300 mt-4 mb-1">{renderInlineMarkdown(line.slice(4))}</h3>);
    } else if (line.startsWith('# ')) {
      flushList(key);
      blocks.push(<h1 key={key} className="text-xl font-bold text-white mb-2">{renderInlineMarkdown(line.slice(2))}</h1>);
    } else if (/^- \[[xX]\] /.test(line)) {
      listBuffer.push(
        <li key={key} className="flex gap-2 text-sm text-gray-300 leading-relaxed">
          <CheckCircle className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
          <span>{renderInlineMarkdown(line.replace(/^- \[[xX]\] /, ''))}</span>
        </li>
      );
    } else if (line.startsWith('- [ ] ')) {
      listBuffer.push(
        <li key={key} className="flex gap-2 text-sm text-gray-500 leading-relaxed">
          <span className="w-4 h-4 shrink-0 border border-gray-600 rounded-sm mt-0.5" />
          <span>{renderInlineMarkdown(line.slice(6))}</span>
        </li>
      );
    } else if (line.startsWith('- ')) {
      listBuffer.push(
        <li key={key} className="flex gap-2 text-sm text-gray-300 leading-relaxed">
          <span className="text-gray-600">•</span>
          <span>{renderInlineMarkdown(line.slice(2))}</span>
        </li>
      );
    } else if (line.trim() === '') {
      flushList(key);
    } else {
      flushList(key);
      blocks.push(<p key={key} className="text-sm text-gray-400 leading-relaxed mb-2">{renderInlineMarkdown(line)}</p>);
    }
  });
  flushList('end');

  return <div className="flex flex-col">{blocks}</div>;
}
