import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { execSync } from 'child_process'

const buildHash = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; }
})();

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
    __BUILD_HASH__:  JSON.stringify(buildHash),
  },
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main:      resolve(__dirname, 'index.html'),
        admin:     resolve(__dirname, 'admin.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
  server: {
    host: true, // 0.0.0.0 でリッスン → LAN 内の他デバイスからアクセス可能
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/stream': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  }
})
