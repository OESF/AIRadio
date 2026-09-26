/**
 * @file ダッシュボード（dashboard.html）の起動口
 *
 * Dashboard を #root に描画する。Vite の複数エントリの1つ（vite.config.ts）。
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
import Dashboard from './dashboard/Dashboard.tsx'

createRoot(document.getElementById('root')!).render(
  <Dashboard />
)
