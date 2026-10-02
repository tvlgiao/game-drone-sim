import { devices, expect, test, type Page } from '@playwright/test';

// window.__drone is typed by the global declaration in game.spec.ts.

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__drone, null, { timeout: 20_000 });
}

/** Text, computed opacity (includes running/held Web Animations) and whether the box is on screen. */
const centerState = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-r="center"]')!;
    // The element is a full-width block (and shakes on crash): measure the glyphs, not the box.
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    return { text: el.textContent ?? '', opacity: Number(getComputedStyle(el).opacity), inView, status: window.__drone.race.status };
  });

test('boot splash is removed once the first frame is up', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#splash')).toBeAttached();
  await page.waitForFunction(() => !!window.__drone, null, { timeout: 20_000 });
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('body')).toHaveClass(/is-ready/);
});

test('race countdown digit stays visible for each whole second', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'race' }));
  // Each digit is checked just after its pop-in and again late in its second, where the old
  // 950 ms pulse had already faded it out (fill: 'forwards' at opacity 0).
  for (const d of ['3', '2', '1']) {
    await page.waitForFunction((t) => document.querySelector('[data-r="center"]')?.textContent === t, d, { timeout: 3_000 });
    for (const wait of [300, 520]) {
      await page.waitForTimeout(wait);
      const s = await centerState(page);
      if (s.text !== d) break;
      expect(s.opacity, `digit ${d} opacity`).toBeGreaterThan(0.5);
      expect(s.inView, `digit ${d} in viewport`).toBe(true);
    }
  }
});

test('CRASHED title stays visible while crashed (after a GO! pulse)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'race' }));
  await page.waitForFunction(() => window.__drone.race.status === 'racing', null, { timeout: 6_000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__drone.teleport(-9, 4.5, 5.8, 0));
  await page.waitForFunction(() => window.__drone.race.status === 'crashed', null, { timeout: 6_000 });
  await page.waitForTimeout(300); // past the 220 ms pop-in
  for (let i = 0; i < 4; i++) {
    const s = await centerState(page);
    if (s.status !== 'crashed') break;
    expect(s.text).toBe('CRASHED');
    expect(s.opacity, `opacity sample ${i}`).toBeGreaterThan(0.5);
    expect(s.inView).toBe(true);
    await page.waitForTimeout(250);
  }
  await expect(page.locator('[data-r="centerSub"]')).toHaveText(/respawning/i);
});

test('free fly hides the gate counter and best line, also when paused', async ({ page }) => {
  await boot(page);
  const gates = page.locator('[data-r="gates"]');
  const best = page.locator('[data-r="bestRow"]');
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.waitForFunction(() => window.__drone.race.status === 'freefly');
  await expect(gates).toBeHidden();
  await expect(best).toBeHidden();
  await page.evaluate(() => window.__drone.press('pause'));
  await page.waitForFunction(() => window.__drone.race.status === 'paused');
  await expect(gates).toBeHidden();
  await expect(best).toBeHidden();
  await page.evaluate(() => window.__drone.action({ type: 'race' }));
  await page.waitForFunction(() => window.__drone.race.status === 'countdown');
  await expect(gates).toBeVisible();
  await expect(best).toBeVisible();
});

test('toasts are cleared when the bye screen opens', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window.__drone as unknown as { toast: (m: string) => void }).toast('Controller connected'));
  await expect(page.locator('.ds-toast')).toHaveCount(1);
  await page.evaluate(() => (window.__drone as unknown as { showScreen: (s: string) => void }).showScreen('bye'));
  await expect(page.locator('.ds-toast')).toHaveCount(0, { timeout: 500 }); // well before its own 2.8 s expiry
});

type Box = { top: number; bottom: number; left: number; right: number };
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Union box of the centre title glyphs and its sub-label pill, plus the newest toast's box. */
const toastVsCenter = (page: Page) =>
  page.evaluate(() => {
    const big = document.querySelector<HTMLElement>('[data-r="center"]')!;
    const range = document.createRange();
    range.selectNodeContents(big);
    const boxes = [range.getBoundingClientRect()];
    const sub = document.querySelector<HTMLElement>('[data-r="centerSub"]')!;
    if (sub.textContent) boxes.push(sub.getBoundingClientRect());
    const center = {
      top: Math.min(...boxes.map((b) => b.top)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
      left: Math.min(...boxes.map((b) => b.left)),
      right: Math.max(...boxes.map((b) => b.right)),
    };
    const t = [...document.querySelectorAll<HTMLElement>('.ds-toast')].pop()!.getBoundingClientRect();
    return { text: big.textContent ?? '', center, toast: { top: t.top, bottom: t.bottom, left: t.left, right: t.right } };
  });

const toast = (page: Page, m: string) => page.evaluate((msg) => (window.__drone as unknown as { toast: (s: string) => void }).toast(msg), m);

// Desktop, and a touch phone where the toast lane sits right on the centre title stack (round-2 audit).
for (const [name, opts] of [
  ['desktop', {}],
  ['phone', { viewport: devices['Pixel 7 landscape'].viewport, hasTouch: true, isMobile: true, userAgent: devices['Pixel 7 landscape'].userAgent }],
] as const) {
  test.describe(`toast lane (${name})`, () => {
    test.use(opts);

    const start = async (page: Page) => {
      await boot(page);
      const gate = page.getByRole('button', { name: /tap to play/i });
      if (await gate.isVisible().catch(() => false)) await gate.click();
      await page.evaluate(() => window.__drone.action({ type: 'race' }));
    };

    test('a toast never covers the CRASHED title or its sub-label', async ({ page }) => {
      await start(page);
      await page.waitForFunction(() => window.__drone.race.status === 'racing', null, { timeout: 6_000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.__drone.teleport(-9, 4.5, 5.8, 0));
      await page.waitForFunction(() => window.__drone.race.status === 'crashed', null, { timeout: 6_000 });
      await page.waitForTimeout(300);
      await toast(page, 'Controller connected: Xbox Wireless Controller');
      await page.waitForTimeout(450); // past the toast entrance and the lane transition
      const s = await toastVsCenter(page);
      expect(s.text).toBe('CRASHED');
      expect(overlaps(s.toast, s.center), JSON.stringify(s)).toBe(false);
    });

    test('a toast never covers the countdown digit', async ({ page }) => {
      await start(page);
      await page.waitForFunction(() => document.querySelector('[data-r="center"]')?.textContent === '3', null, { timeout: 3_000 });
      await toast(page, 'Controller connected: Xbox Wireless Controller');
      await page.waitForTimeout(450);
      const s = await toastVsCenter(page);
      expect(s.text).toMatch(/^[123]$/);
      expect(overlaps(s.toast, s.center), JSON.stringify(s)).toBe(false);
    });
  });
}

test('bye screen hides the centre banners and race timer', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'race' }));
  await page.waitForFunction(() => window.__drone.race.status === 'racing', null, { timeout: 6_000 });
  await page.evaluate(() => window.__drone.teleport(-9, 4.5, 5.8, 0));
  await page.waitForFunction(() => window.__drone.race.status === 'crashed', null, { timeout: 6_000 });
  await page.evaluate(() => (window.__drone as unknown as { showScreen: (s: string) => void }).showScreen('bye'));
  await expect(page.locator('.ds-screen--bye')).toBeVisible();
  await expect(page.locator('[data-r="center"]')).toBeHidden();
  await expect(page.locator('[data-r="centerSub"]')).toBeHidden();
  await expect(page.locator('[data-r="time"]')).toBeHidden();
});

test('finish delta is green when faster and amber when slower', async ({ page }) => {
  await boot(page);
  const show = (d: object) => page.evaluate((data) => (window.__drone as unknown as { showScreen: (s: string, d: object) => void }).showScreen('finish', data), d);
  const delta = page.locator('.ds-screen--finish [data-f="delta"]');
  const color = () => delta.evaluate((el) => getComputedStyle(el).color);
  await show({ time: 83.456, best: 80.12, newBest: false });
  await expect(delta).toHaveText(/^\+/);
  expect(await color()).toBe('rgb(255, 197, 61)');
  await show({ time: 79.9, best: 79.9, newBest: true, prevBest: 81.1 });
  await expect(delta).toHaveText(/^−/);
  expect(await color()).toBe('rgb(61, 255, 160)');
});

test('free fly shows a running FLIGHT clock instead of a lone ∞', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.waitForFunction(() => window.__drone.race.status === 'freefly');
  await expect(page.locator('[data-r="timeLabel"]')).toHaveText(/flight/i);
  await page.waitForTimeout(1200);
  const t = await page.locator('[data-r="time"]').textContent();
  expect(t).toMatch(/^00:0[1-9]\.\d\d$/);
});
