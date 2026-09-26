/**
 * @file プレーヤー画面（index.html）の起動口
 *
 * Player（リスナーが番組を聴く画面）を #root に描画する。Vite の複数エントリの1つ（vite.config.ts）。
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

import { createRoot } from 'react-dom/client'
import './index.css'
import Player from './Player.tsx'

createRoot(document.getElementById('root')!).render(
  <Player />
)

