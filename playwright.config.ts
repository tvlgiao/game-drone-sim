import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
  },
  projects: [
    {
      // Desktop Chrome on the real GPU: the original game specs, the "no touch UI on desktop" check, the emulated Quest 2 (IWER) VR flight
      // and the site split (landing page, free /play/, store-gated /app/).
      name: 'chromium',
      testMatch: ['game.spec.ts', 'audio.spec.ts', 'hud.spec.ts', 'menus.spec.ts', 'mobile.spec.ts', 'xr.spec.ts', 'offline.spec.ts', 'site.spec.ts', 'levels.spec.ts', 'input-hints.spec.ts', 'tutorial.spec.ts', 'visual.spec.ts', 'environments.spec.ts', 'worlds.spec.ts', 'worlds-game.spec.ts', 'loading.spec.ts'],
      use: { browserName: 'chromium', launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } },
    },
    {
      name: 'webkit-iphone',
      testMatch: ['mobile.spec.ts', 'menus.spec.ts', 'levels.spec.ts', 'environments.spec.ts', 'worlds.spec.ts', 'worlds-game.spec.ts'],
      use: { ...devices['iPhone 15 Pro landscape'] },
    },
    {
      name: 'webkit-ipad',
      testMatch: ['mobile.spec.ts', 'menus.spec.ts'],
      use: { ...devices['iPad Pro 11 landscape'] },
    },
  ],
  webServer: { command: 'npm run build && npm run preview', port: 4173, reuseExistingServer: false, timeout: 120_000 },
});
