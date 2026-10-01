/** Offline play: after one online visit the service worker serves the whole game with no network. */
import { expect, test } from '@playwright/test';

type W = { __drone?: { race: { status: string }; renders: number; action: (a: { type: string }) => void } };

test('plays offline after the first visit (service worker precache)', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as W).__drone, null, { timeout: 20_000 });
  // worker installed (precache done) and controlling the page
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('dronesim-')) && !!navigator.serviceWorker.controller, null, { timeout: 20_000 });

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as W).__drone, null, { timeout: 20_000 });
  await page.evaluate(() => (window as unknown as Required<W>).__drone.action({ type: 'freefly' }));
  await page.waitForTimeout(500);
  const d = await page.evaluate(() => ({ status: (window as unknown as Required<W>).__drone.race.status, renders: (window as unknown as Required<W>).__drone.renders }));
  expect(d.status).toBe('freefly');
  expect(d.renders).toBeGreaterThan(5);
  expect(errors).toEqual([]);
  await context.setOffline(false);
});
