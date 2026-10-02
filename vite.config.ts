/// <reference types="vitest/config" />
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import { offlineServiceWorker } from './build/offline-sw';
import { storeBadgesHtml } from './src/site/badge';
import { STORE_LINKS } from './src/site/stores';
import pkg from './package.json';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };
const build = { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 } as const;
/** unit tests (vitest) — the same in every mode, so `--mode native` cannot point them at play/ */
const test = { root: ROOT, include: ['tests/unit/**/*.test.ts'], environment: 'node' as const };

/** Landing page store badges, rendered at build time from STORE_LINKS (no JS, no layout shift). */
function storeBadges(): Plugin {
  return {
    name: 'store-badges',
    transformIndexHtml: (html) => html.replace('<!--store-badges-->', storeBadgesHtml(STORE_LINKS)),
  };
}

/**
 * Website (GitHub Pages): `/` landing page, `/play/` free web game (no VR), `/app/` Meta Quest store app.
 * Relative asset URLs keep the build working at a domain root or under a sub-path.
 */
const web: UserConfig = {
  base: './',
  plugins: [storeBadges(), offlineServiceWorker()],
  define,
  build: {
    ...build,
    rolldownOptions: {
      input: { landing: resolve(ROOT, 'index.html'), play: resolve(ROOT, 'play/index.html'), app: resolve(ROOT, 'app/index.html') },
    },
  },
  test,
};

/**
 * iOS / Android (Capacitor, `npm run build:native` → dist-native/): the game page itself is the root
 * index.html, with only the files the game uses. No landing, no web manifest, no service worker.
 */
const native: UserConfig = {
  root: resolve(ROOT, 'play'),
  base: './',
  publicDir: false,
  define,
  plugins: [
    {
      name: 'native-shell',
      transformIndexHtml: (html) => html.replace(/\s*<link rel="manifest"[^>]*>/, ''),
      closeBundle() {
        const out = resolve(ROOT, 'dist-native');
        cpSync(resolve(ROOT, 'public/icons'), resolve(out, 'icons'), { recursive: true });
        cpSync(resolve(ROOT, 'public/licenses.txt'), resolve(out, 'licenses.txt'));
      },
    },
  ],
  build: { ...build, outDir: resolve(ROOT, 'dist-native'), emptyOutDir: true },
  test,
};

export default defineConfig(({ mode }) => (mode === 'native' ? native : web));
