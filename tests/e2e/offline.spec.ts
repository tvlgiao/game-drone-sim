/** Offline play: after one online visit the service worker serves the whole game with no network. */
import { expect, test } from '@playwright/test';
import { skipTutorialOffer } from './seed';

// the first-run tutorial offer is covered by tutorial.spec.ts; here it would cover the menus
test.beforeEach(({ context }) => skipTutorialOffer(context));

type W = { __drone?: { race: { status: string }; renders: number; action: (a: { type: string }) => void } };

test('plays offline after the first visit (service worker precache)', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/');
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

test('the Quest app launches offline after one successful store check (cached ownership)', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // the store answers only while online, like a Digital Goods call that needs the network
  await context.addInitScript(() => {
    (window as unknown as { getDigitalGoodsService: () => Promise<unknown> }).getDigitalGoodsService = async () => {
      if (!navigator.onLine) throw new Error('network error');
      return { getLoggedInUserId: async () => '4815162342' };
    };
  });
  await page.goto('/app/');
  await page.waitForFunction(() => !!(window as unknown as W).__drone, null, { timeout: 20_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('dronesim-')) && !!navigator.serviceWorker.controller, null, { timeout: 20_000 });

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as W).__drone, null, { timeout: 20_000 });
  await expect(page.locator('.ds-store-gate')).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.setOffline(false);
});

test('texture maps are cached when a level first uses them: a visited level and an unvisited one both fly offline', async ({ page, context }) => {
  test.setTimeout(120_000);
  type H = { level: string; levelReady: boolean; loading: { visible: boolean }; startLevel: (id: string) => Promise<boolean> };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/');
  await page.waitForFunction(() => !!(window as unknown as { __drone?: H }).__drone, null, { timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith('dronesim-')) && !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
  const maps = (): Promise<number> =>
    page.evaluate(async () => {
      let n = 0;
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (/\/assets\/(albedo|normal|arm)-[^/]+\.webp$/.test(r.url)) n++;
      return n;
    });
  // nothing of the ~6 MB of maps on install
  expect(await maps()).toBe(0);
  // the loft, visited online through the worker: its maps land in the cache
  expect(await page.evaluate(() => (window as unknown as { __drone: H }).__drone.startLevel('night-loft'))).toBe(true);
  await expect.poll(maps, { timeout: 20_000 }).toBeGreaterThan(0);

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __drone?: H }).__drone, null, { timeout: 30_000 });
  // visited: from the cache; unvisited (City): its procedural sets
  for (const id of ['night-loft', 'city']) {
    expect(await page.evaluate((id) => (window as unknown as { __drone: H }).__drone.startLevel(id), id)).toBe(true);
    expect(await page.evaluate(() => { const d = (window as unknown as { __drone: H }).__drone; return [d.level, d.levelReady, d.loading.visible]; })).toEqual([id, true, false]);
  }
  expect(errors).toEqual([]);
  await context.setOffline(false);
});
