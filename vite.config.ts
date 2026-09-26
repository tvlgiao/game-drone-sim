/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
