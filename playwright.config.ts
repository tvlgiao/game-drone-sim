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
      // Desktop Chrome on the real GPU: the original game specs, the "no touch UI on desktop" check and the emulated Quest 2 (IWER) VR flight.
      name: 'chromium',
      testMatch: ['game.spec.ts', 'mobile.spec.ts', 'xr.spec.ts', 'offline.spec.ts'],
      use: { browserName: 'chromium', launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } },
    },
    {
      name: 'webkit-iphone',
      testMatch: 'mobile.spec.ts',
      use: { ...devices['iPhone 15 Pro landscape'] },
    },
    {
      name: 'webkit-ipad',
      testMatch: 'mobile.spec.ts',
      use: { ...devices['iPad Pro 11 landscape'] },
    },
  ],
  webServer: { command: 'npm run build && npm run preview', port: 4173, reuseExistingServer: false, timeout: 120_000 },
});
