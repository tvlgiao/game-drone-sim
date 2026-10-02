import { defineConfig, devices } from '@playwright/test';

/**
 * Tutorial overlay layout checks against the dev-only harness (tutorial-preview.html is served by `vite`, not
 * built), so this runs apart from playwright.config.ts: `npx playwright test -c playwright.tutorial.config.ts`.
 * TUTORIAL_PORT picks another port when 5187 is taken; SHOTS_DIR keeps the screenshots for review.
 */
const port = Number(process.env.TUTORIAL_PORT ?? 5187);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['tutorial-ui.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 15 Pro landscape'] } },
  ],
  webServer: { command: `npx vite --port ${port} --strictPort`, port, reuseExistingServer: false, timeout: 120_000 },
});
