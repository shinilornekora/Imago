import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { adapterSettingsSnapshot } from './src/adapters/settings';

/**
 * Production-сборка кладётся в `dist` и отдаётся статическим обработчиком API (или шейпером) с корня `/`.
 * Dev-сервер (не участвует в измерениях) проксирует `/api` на Fastify и `/zero` на zero-cache.
 *
 * Сборка дополнительно эмитит `dist/adapter-settings.json` — машинный снимок `ADAPTER_SETTINGS`
 * и `Z_SETTINGS` ИМЕННО ЭТОЙ сборки. Паспорт серии (`passport.json → adapters`, docs/PASSPORT.md
 * §2.1) читает его, а не исходники, поэтому настройки в паспорте не могут разойтись с измеряемым
 * клиентом. Файл входит в `client.dist`/`client.buildId`.
 */
const emitAdapterSettings = {
  name: 'stand:adapter-settings',
  generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
    this.emitFile({ type: 'asset', fileName: 'adapter-settings.json', source: JSON.stringify(adapterSettingsSnapshot(), null, 2) + '\n' });
  },
};

export default defineConfig({
  base: '/',
  plugins: [react(), emitAdapterSettings],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/zero': { target: 'http://127.0.0.1:4848', changeOrigin: false, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});
