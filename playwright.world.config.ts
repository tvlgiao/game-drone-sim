import { defineConfig, devices } from '@playwright/test';

/**
 * World engine cross-engine determinism against the dev-only harness (tests/e2e/world-harness.html is served
 * by `vite`, not built), so this runs apart from playwright.config.ts:
 * `npx playwright test -c playwright.world.config.ts --reporter=list`. WORLD_PORT picks another port.
 */
const port = Number(process.env.WORLD_PORT ?? 5189);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['world-worker.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: { command: `npx vite --port ${port} --strictPort`, port, reuseExistingServer: false, timeout: 120_000 },
});
