import { expect, test, type Page } from '@playwright/test';

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
