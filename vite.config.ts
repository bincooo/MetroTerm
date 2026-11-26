import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;
// Browser mode: /api (HTTP + WebSocket) → `metroterm web --no-www` (src-rust/src/server.rs).
const backendTarget = process.env.METROTERM_BACKEND || 'http://127.0.0.1:7681';
const proxy = { '/api': { target: backendTarget, ws: true, changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || '0.0.0.0',
    allowedHosts: true,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    proxy,
  },
  preview: { port: 1420, strictPort: true, host: '0.0.0.0', allowedHosts: true, proxy },
  // Pre-bundle heavy deps up front so the first preview load never hits a mid-load re-optimize/reload.
  optimizeDeps: {
    include: ['react', 'react-dom/client', '@xterm/xterm', '@xterm/addon-fit', '@tauri-apps/api/core', '@tauri-apps/api/event'],
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: ['es2021', 'chrome100', 'safari13'] },
  // esbuild's syntax minifier (up to at least 0.27), when lowering `x ||= {}` for safari13, drops the local `let x`
  // and leaves an assignment to an undeclared name: xterm 6's requestMode (DECRQM, sent by vim) threw a
  // ReferenceError in the middle of a write and the screen stopped updating. Identifiers / whitespace still minified.
  esbuild: { minifySyntax: false },
});
