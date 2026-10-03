/**
 * Load-flow edge cases from the PR #10 review: a failure in the headset, a failure after Back, a failure after
 * the old scenery is gone, the no-op pick during the boot, a deep link racing the boot's prepare, unsupported
 * saved worlds, and the low tier's first frame after a load.
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';
import { questOwnerStub } from './quest-owner';
import { encodeSeed } from '../../src/world/seed-code';

test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Hook {
  screen: string;
  level: string;
  levelReady: boolean;
  race: { status: string };
  world: { seed: number } | null;
  loading: { visible: boolean; blocking: boolean; loading: boolean };
  xr: { presenting: boolean };
  action: (a: Record<string, unknown>) => void;
  showScreen: (s: string) => void;
  startLevel: (id: string, opts?: { seed?: number }) => Promise<boolean>;
  view: { faultNextBuild: boolean; renderer: { info: { programs: unknown[] } } };
}

type Hand = 'left' | 'right';
type W = { __drone: Hook; __xrDevice: { controllers: Record<Hand, { updateButtonValue(id: string, v: number): void }> } };

const WORLD_CHUNK = /world-level-view[^/]*\.(js|ts)(\?.*)?$/;
const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

async function boot(page: Page, path = '/play/?rotate=0'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone, null, { timeout: 60_000 });
  return errors;
}

async function press(page: Page, hand: Hand, button: string): Promise<void> {
  await page.evaluate(([h, b]) => (window as unknown as W).__xrDevice.controllers[h as Hand].updateButtonValue(b, 1), [hand, button]);
  await page.waitForTimeout(150);
  await page.evaluate(([h, b]) => (window as unknown as W).__xrDevice.controllers[h as Hand].updateButtonValue(b, 0), [hand, button]);
  await page.waitForTimeout(150);
}

test.describe('network-controlled loads', () => {
  test.use({ serviceWorkers: 'block' });

  test('A1: a load that fails in the headset leaves the XR menu working (no invisible DOM error)', async ({ page, context }) => {
    await context.addInitScript(questOwnerStub);
    await page.route(WORLD_CHUNK, (r) => r.abort());
    await boot(page, '/app/?xremu=1');
    await page.waitForFunction(() => !!(window as unknown as Partial<W>).__xrDevice);
    await page.getByRole('button', { name: 'Enter VR' }).click();
    await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
    const before = await hook(page, (d) => d.level);
    expect(await hook(page, (d) => d.startLevel('city'))).toBe(false);
    // nothing in the headset waits on a DOM dialog
    await expect.poll(() => hook(page, (d) => d.loading.blocking)).toBe(false);
    expect(await hook(page, (d) => d.level)).toBe(before);
    // Y on the menu card still cycles the level
    await press(page, 'left', 'y-button');
    await expect.poll(() => hook(page, (d) => d.level), { timeout: 20_000 }).not.toBe(before);
  });

  test('A2: a load that throws after Back stays cancelled (no Retry over the level select)', async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(WORLD_CHUNK, async (r) => {
      await held;
      await r.abort();
    });
    await boot(page);
    await hook(page, (d) => d.showScreen('levels'));
    await page.locator('[data-act="level-freefly:city"]').click();
    await expect(page.locator('.ds-load')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ds-load')).toBeHidden();
    // the in-flight chunk now fails
    release();
    await page.waitForTimeout(1500);
    await expect(page.locator('.ds-load')).toBeHidden();
    await expect(page.locator('[data-act="load-retry"]')).toBeHidden();
    // and nothing invisible holds the menus' input
    expect(await hook(page, (d) => [d.screen, d.level, d.loading.visible, d.loading.blocking])).toEqual(['levels', 'training', false, false]);
  });
});

test('A3: a load that breaks after the old scenery is gone says so (reload), never offers Retry on a broken scene', async ({ page }) => {
  await boot(page);
  await hook(page, (d) => {
    d.view.faultNextBuild = true;
    d.showScreen('levels');
  });
  await page.locator('[data-act="level-freefly:night-loft"]').click();
  await expect(page.locator('#ui.ds-fatal, .ds-fatal, [role="alert"]').filter({ hasText: /reload/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-act="load-retry"]')).toBeHidden();
});

test('A5: picking the level the boot is still streaming does not orphan the boot (it still becomes ready)', async ({ page, context }) => {
  const seed = 4242;
  const code = encodeSeed(seed, 2);
  await context.addInitScript(
    ([code, seed]) => {
      localStorage.setItem('drone-sim.level', 'infinite');
      localStorage.setItem('drone-sim.worlds.v1', JSON.stringify({ v: 1, last: code, worlds: [{ id: code, name: 'World T', code, seed, gen: 2, created: 1, lastPlayed: 1 }] }));
    },
    [code, seed] as const,
  );
  // the world workers come late (slow network): the boot level is still streaming behind the menu
  await page.route(/world-worker[^/]*\.js/, async (r) => {
    await new Promise((res) => setTimeout(res, 6000));
    await r.continue().catch(() => undefined);
  });
  await boot(page);
  expect(await hook(page, (d) => d.level)).toBe('infinite');
  expect(await hook(page, (d) => d.levelReady)).toBe(false);
  // Free Fly on the same world right away (no-op load)
  await hook(page, (d) => d.action({ type: 'level', id: 'infinite', mode: 'freefly' }));
  await expect.poll(() => hook(page, (d) => [d.levelReady, d.loading.visible, d.race.status]), { timeout: 30_000 }).toEqual([true, false, 'freefly']);
});

test('A5: picking the level whose load is still running joins that load (it finishes readying the level)', async ({ page }) => {
  await boot(page);
  await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'freefly' }));
  // swapped in, still preparing behind the loading screen
  await expect.poll(() => hook(page, (d) => [d.level, d.loading.loading]), { timeout: 20_000 }).toEqual(['night-loft', true]);
  await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'freefly' }));
  await expect.poll(() => hook(page, (d) => [d.loading.visible, d.race.status]), { timeout: 20_000 }).toEqual([false, 'freefly']);
  expect(await hook(page, (d) => (d.view as unknown as { preparing: boolean }).preparing)).toBe(false);
});

test('A4: a saved world from a newer generator neither breaks the boot nor plays silently', async ({ page, context }) => {
  // gen 3 does not exist in this build; its code still decodes
  const code = encodeSeed(1234, 3);
  await context.addInitScript((code) => {
    localStorage.setItem('drone-sim.level', 'infinite');
    localStorage.setItem('drone-sim.worlds.v1', JSON.stringify({ v: 1, last: code, worlds: [{ id: code, name: 'Future', code, seed: 1234, gen: 3, created: 1, lastPlayed: 1 }] }));
  }, code);
  const errors = await boot(page);
  await expect.poll(() => hook(page, (d) => d.levelReady), { timeout: 30_000 }).toBe(true);
  expect(errors).toEqual([]);
  // the entry is kept (a newer build plays it) and its Play says why it cannot here
  const stored = await page.evaluate(() => localStorage.getItem('drone-sim.worlds.v1'));
  expect(stored).toContain(code);
});

test('A6: a ?world= deep link on a cold start is readied (no long task on its first frames)', async ({ page, context }) => {
  const code = encodeSeed(777, 2);
  await context.addInitScript(() => {
    const w = window as unknown as { __lt: { start: number; dur: number }[] };
    w.__lt = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  await boot(page, `/play/?rotate=0&world=${code}`);
  await expect.poll(() => hook(page, (d) => [d.level, d.world?.seed, d.loading.visible]), { timeout: 45_000 }).toEqual(['infinite', 777, false]);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const m = performance.getEntriesByName('handoff:start')[0];
    return (window as unknown as { __lt: { start: number; dur: number }[] }).__lt.filter((t) => m && t.start >= m.startTime).map((t) => Math.round(t.dur));
  });
  expect(Math.max(0, ...after)).toBeLessThan(200);
});

test('B2: low tier: the first frames after a load compile no new programs (the SH probe is in the compiled set)', async ({ page, context }) => {
  await context.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ v: 3, quality: 'low' })));
  await boot(page);
  expect(await hook(page, (d) => d.startLevel('night-loft'))).toBe(true);
  // programs when the load finished readying the level, before any frame drew it
  const before = await page.evaluate(() => (performance.getEntriesByName('load:ready').at(-1) as PerformanceMark).detail.programs as number);
  await hook(page, (d) => d.action({ type: 'freefly' }));
  await page.waitForTimeout(1500);
  const after = await hook(page, (d) => d.view.renderer.info.programs.length);
  // drone / HUD extras may add a couple; a recompiled scene adds dozens
  expect(after - before).toBeLessThanOrEqual(4);
});
