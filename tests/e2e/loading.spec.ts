/**
 * Level loading flow: the loading screen takes over the instant a level is picked, its bar only moves forward and
 * ends at 100 %, Back / Esc cancel to the level select, a failed load offers Retry, the drone cannot be armed before
 * the hand-off (and a Race's GO), and the load leaves no long frozen frame on desktop.
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';

test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Hook {
  screen: string;
  level: string;
  levelReady: boolean;
  armed: boolean;
  renders: number;
  race: { status: string };
  loading: { visible: boolean; blocking: boolean; loading: boolean; value: number; handoff: boolean };
  action: (a: Record<string, unknown>) => void;
  showScreen: (s: string) => void;
  press: (b: string) => void;
  setControl: (c: { throttle: number; pitch: number; roll: number; yaw: number }) => void;
}

/** the generated worlds' renderer chunk, with or without a retry query */
const WORLD_CHUNK = /world-level-view[^/]*\.(js|ts)(\?.*)?$/;

const errors: string[] = [];

async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?rotate=0');
  await page.waitForFunction(() => {
    const d = (window as unknown as { __drone?: Hook }).__drone;
    return !!d && d.renders >= 1 && d.levelReady;
  }, null, { timeout: 60_000 });
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

async function openLevels(page: Page): Promise<void> {
  await hook(page, (d) => d.showScreen('levels'));
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
}

/** Records, every animation frame, the loading screen's value and visibility (window.__samples). */
async function sampleLoading(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __samples: { t: number; v: number; vis: boolean; blocking: boolean; armed: boolean; status: string }[]; __drone: Hook };
    w.__samples = [];
    const tick = (): void => {
      const d = w.__drone;
      w.__samples.push({ t: performance.now(), v: d.loading.value, vis: d.loading.visible, blocking: d.loading.blocking, armed: d.armed, status: d.race.status });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test('the loading screen is up within 150 ms of the click; the bar only grows and reaches 100 %', async ({ page }) => {
  await boot(page);
  await openLevels(page);
  // the time from the press to the moment the loading screen is in the DOM, visible
  await page.evaluate(() => {
    const w = window as unknown as { __shownAfter: number };
    w.__shownAfter = -1;
    document.addEventListener(
      'pointerdown',
      () => {
        const t0 = performance.now();
        const el = document.querySelector<HTMLElement>('.ds-load')!;
        const mo = new MutationObserver(() => {
          if (!el.hidden && w.__shownAfter < 0) {
            w.__shownAfter = performance.now() - t0;
            mo.disconnect();
          }
        });
        mo.observe(el, { attributes: true });
      },
      { capture: true, once: true },
    );
  });
  await sampleLoading(page);
  await page.locator('[data-act="level-freefly:night-loft"]').click();
  await expect(page.locator('.ds-load')).toBeVisible();
  await expect(page.locator('.ds-load [role="progressbar"]')).toBeVisible();
  await expect(page.locator('.ds-load__name')).toHaveText(/loft/i);
  await expect.poll(() => hook(page, (d) => [d.level, d.loading.visible, d.race.status]), { timeout: 45_000 }).toEqual(['night-loft', false, 'freefly']);
  const shownAfter = await page.evaluate(() => (window as unknown as { __shownAfter: number }).__shownAfter);
  expect(shownAfter).toBeGreaterThanOrEqual(0);
  expect(shownAfter).toBeLessThanOrEqual(150);
  const samples = await page.evaluate(() => (window as unknown as { __samples: { v: number; vis: boolean }[] }).__samples.filter((s) => s.vis));
  expect(samples.length).toBeGreaterThan(5);
  for (let i = 1; i < samples.length; i++) expect(samples[i]!.v).toBeGreaterThanOrEqual(samples[i - 1]!.v);
  expect(Math.max(...samples.map((s) => s.v))).toBe(1);
  expect(errors).toEqual([]);
});

// these two control the network for the worlds' renderer chunk: no service worker in between (it precaches it)
test.describe('network-dependent loads', () => {
  test.use({ serviceWorkers: 'block' });

  test('Esc on the loading screen cancels the load and returns to the level select', async ({ page }) => {
    // a slow network: the worlds' renderer chunk takes seconds, so both cancels land before the level swaps in
    await page.route(WORLD_CHUNK, async (r) => {
      await new Promise((res) => setTimeout(res, 9000));
      await r.continue().catch(() => undefined);
    });
    await boot(page);
    await openLevels(page);
    await page.locator('[data-act="level-freefly:city"]').click();
    await expect(page.locator('.ds-load')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ds-load')).toBeHidden();
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
    expect(await hook(page, (d) => [d.level, d.screen])).toEqual(['training', 'levels']);
    // and Back works the same way
    await page.locator('[data-act="level-freefly:alpine"]').click();
    await expect(page.locator('.ds-load')).toBeVisible();
    await page.locator('[data-act="load-back"]').click();
    await expect(page.locator('.ds-load')).toBeHidden();
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
    // once the chunk is in, neither cancelled load swaps its level in
    await page.waitForTimeout(9000);
    expect(await hook(page, (d) => [d.level, d.screen])).toEqual(['training', 'levels']);
    expect(errors).toEqual([]);
  });

  test('a load that fails (offline chunk) shows the error with Retry, and Retry loads the level', async ({ page }) => {
    // the generated worlds' renderer chunk cannot be fetched
    await page.route(WORLD_CHUNK, (r) => r.abort());
    await boot(page);
    await openLevels(page);
    await page.locator('[data-act="level-freefly:city"]').click();
    await expect(page.locator('.ds-load [role="alert"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ds-load [role="alert"]')).toContainText(/couldn.t be loaded/i);
    const retry = page.locator('[data-act="load-retry"]');
    await expect(retry).toBeVisible();
    expect(await hook(page, (d) => d.level)).toBe('training');
    await page.unroute(WORLD_CHUNK);
    await retry.click();
    await expect.poll(() => hook(page, (d) => [d.level, d.loading.visible, d.race.status]), { timeout: 45_000 }).toEqual(['city', false, 'freefly']);
  });
});

test('the drone cannot be armed during the hand-off, nor before a Race says GO', async ({ page }) => {
  await boot(page);
  await hook(page, (d) => d.setControl({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }));
  // keep trying to arm all through the load
  await page.evaluate(() => {
    const w = window as unknown as { __arming: number; __drone: Hook };
    w.__arming = window.setInterval(() => {
      w.__drone.setControl({ throttle: 0, pitch: 0, roll: 0, yaw: 0 });
      w.__drone.press('arm');
    }, 30);
  });
  await sampleLoading(page);
  await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'race' }));
  await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 45_000 }).toBe('racing');
  await expect.poll(() => hook(page, (d) => d.armed), { timeout: 3000 }).toBe(true);
  await page.evaluate(() => clearInterval((window as unknown as { __arming: number }).__arming));
  const samples = await page.evaluate(() => (window as unknown as { __samples: { blocking: boolean; armed: boolean; status: string }[] }).__samples);
  expect(samples.some((s) => s.blocking)).toBe(true);
  expect(samples.some((s) => s.status === 'countdown')).toBe(true);
  // armed only once the race runs: never under the loading screen, never in the countdown
  expect(samples.filter((s) => s.armed && (s.blocking || s.status !== 'racing'))).toEqual([]);

  // Free Fly: the hand-off ("Ready" and the fade) refuses arming too
  await hook(page, (d) => d.press('arm')); // disarm
  await hook(page, (d) => d.action({ type: 'menu' }));
  await expect.poll(() => hook(page, (d) => d.armed)).toBe(false);
  await page.evaluate(() => {
    const w = window as unknown as { __arming: number; __drone: Hook; __samples: unknown[] };
    w.__samples.length = 0;
    w.__arming = window.setInterval(() => {
      w.__drone.setControl({ throttle: 0, pitch: 0, roll: 0, yaw: 0 });
      if (!w.__drone.armed) w.__drone.press('arm');
    }, 30);
  });
  await hook(page, (d) => d.action({ type: 'level', id: 'training', mode: 'freefly' }));
  await expect.poll(() => hook(page, (d) => [d.level, d.loading.visible, d.race.status]), { timeout: 45_000 }).toEqual(['training', false, 'freefly']);
  await expect.poll(() => hook(page, (d) => d.armed), { timeout: 3000 }).toBe(true);
  await page.evaluate(() => clearInterval((window as unknown as { __arming: number }).__arming));
  const ff = await page.evaluate(() => (window as unknown as { __samples: { blocking: boolean; armed: boolean }[] }).__samples);
  expect(ff.some((s) => s.blocking)).toBe(true);
  expect(ff.filter((s) => s.armed && s.blocking)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Free Fly hands control over within 0.5 s of the loaded level, then fades', async ({ page }) => {
  await boot(page);
  await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'freefly' }));
  await page.waitForFunction(() => performance.getEntriesByName('handoff:control').length > 0, null, { timeout: 45_000 });
  const ms = await page.evaluate(() => performance.getEntriesByName('handoff:control')[0]!.startTime - performance.getEntriesByName('handoff:start')[0]!.startTime);
  test.info().annotations.push({ type: 'hand-off (ms)', description: ms.toFixed(0) });
  expect(ms).toBeLessThanOrEqual(500);
  // the fade is still running over the controllable scene
  expect(await hook(page, (d) => [d.loading.visible, d.loading.blocking])).toEqual([true, false]);
  await expect.poll(() => hook(page, (d) => d.loading.visible)).toBe(false);
});

test('no long frozen frame while a level loads (desktop long-task budget)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Long Tasks API: Chromium');
  await boot(page);
  await openLevels(page);
  await page.evaluate(() => {
    const w = window as unknown as { __lt: { start: number; dur: number }[] };
    w.__lt = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask' });
  });
  const t0 = await page.evaluate(() => performance.now());
  await page.locator('[data-act="level-freefly:night-loft"]').click();
  await expect.poll(() => hook(page, (d) => [d.level, d.loading.visible, d.race.status]), { timeout: 45_000 }).toEqual(['night-loft', false, 'freefly']);
  const longest = await page.evaluate((t0) => Math.max(0, ...(window as unknown as { __lt: { start: number; dur: number }[] }).__lt.filter((t) => t.start >= t0).map((t) => t.dur)), t0);
  test.info().annotations.push({ type: 'longest long task (ms)', description: longest.toFixed(0) });
  // target 200 ms (measured 100-155 ms on a loaded machine); 300 leaves room for a busier one
  expect(longest).toBeLessThan(300);
});
