import { defineConfig, devices } from '@playwright/test';

/**
 * Worlds UI (level cards, Worlds screen, outdoor HUD) against the dev-only harness worlds-preview.html, which
 * stands in for main.ts with a recording onAction: `npx playwright test -c playwright.worlds-ui.config.ts`.
 * WORLDS_UI_PORT picks another port when 5189 is taken; SHOTS_DIR keeps the screenshots for review.
 */
const port = Number(process.env.WORLDS_UI_PORT ?? 5189);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['worlds-ui.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1366, height: 768 } } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 15 Pro landscape'] } },
    { name: 'webkit-iphone-se', use: { ...devices['iPhone SE landscape'] } },
    { name: 'webkit-ipad', use: { ...devices['iPad Pro 11 landscape'] } },
  ],
  webServer: { command: `npx vite --port ${port} --strictPort`, port, reuseExistingServer: false, timeout: 120_000 },
});
