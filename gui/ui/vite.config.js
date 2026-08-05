import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the UI runs on 5173 and the API on 8787 (`make gui-dev` + `make gui`). In production the API
// server serves dist/ itself, so the app only ever talks to a same-origin /api and needs no CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.CROWDSIM_GUI_URL || 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
