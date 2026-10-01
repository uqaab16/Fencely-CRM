import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev / preview proxy: the React app calls relative /api/* paths and Vite
// forwards them to the local Fencely CRM backend (npm start in the repo root,
// default http://localhost:4173). In production the static host must rewrite
// /api/* to the backend instead (see README.md).
const apiProxy = {
  '/api': {
    target: 'http://localhost:4173',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 4174,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
  },
});
