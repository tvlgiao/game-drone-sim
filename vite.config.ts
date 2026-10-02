/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { offlineServiceWorker } from './build/offline-sw';
import pkg from './package.json';

export default defineConfig({
  // Relative asset URLs: works at the domain root (dev) and under /game-drone-sim/ on GitHub Pages.
  base: './',
  plugins: [offlineServiceWorker()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
