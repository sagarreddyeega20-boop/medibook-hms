import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Defaults: web on 5173, API on 4000. The Playwright suite runs its own pair (WEB_PORT=5180, API_PROXY_TARGET=:4400).
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  envDir: '..', // single root .env; only VITE_* vars are exposed
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
});
