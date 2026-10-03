/**
 * Environment rendering: both levels build and render on every tier without console errors, the frame
 * is neither blank nor blown out (luminance sanity), and the draw-call / triangle budgets hold per tier
 * (desktop ≤ 250 calls / 1.2 M triangles; low = the Quest tier ≤ 100 calls / 200 k triangles per view).
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';

interface Hook {
  level: string;
  tier: string;
  renders: number;
  stats: () => { calls: number; triangles: number; geometries: number; textures: number };
  startLevel: (id: string) => Promise<boolean>;
  action: (a: Record<string, unknown>) => void;
}

const BUDGET: Record<string, { calls: number; triangles: number }> = {
  ultra: { calls: 250, triangles: 1_200_000 },
  medium: { calls: 250, triangles: 1_200_000 },
  low: { calls: 100, triangles: 200_000 },
};

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

/** Mean / spread of luma and the share of near-black pixels in a screenshot, decoded in the page. */
async function luminance(page: Page): Promise<{ mean: number; std: number; black: number }> {
  const png = await page.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = Math.round((320 * img.height) / img.width);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let sum2 = 0;
    let black = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
      sum += y;
      sum2 += y * y;
      if (y < 0.01) black++;
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), black: black / n };
  }, png.toString('base64'));
}

test.beforeEach(({ context }) => skipTutorialOffer(context));

for (const level of ['training', 'night-loft'] as const) {
  for (const tier of ['ultra', 'medium', 'low'] as const) {
    test(`${level} @ ${tier}: renders clean, sane luminance, within the draw budget`, async ({ page }) => {
      test.skip(test.info().project.name !== 'chromium' && tier !== 'medium', 'other devices: one tier is enough');
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript((q) => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: q })), tier);
      await page.goto('/play/?rotate=0');
      await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
      await page.evaluate((id) => (window as unknown as { __drone: Hook }).__drone.startLevel(id), level);
      await expect.poll(() => hook(page, (d) => d.level), { timeout: 20_000 }).toBe(level);
      await page.evaluate((id) => (window as unknown as { __drone: Hook }).__drone.action({ type: 'level', id, mode: 'freefly' }), level);
      const before = await hook(page, (d) => d.renders);
      await expect.poll(() => hook(page, (d) => d.renders), { timeout: 10_000 }).toBeGreaterThan(before + 30);
      expect(await hook(page, (d) => d.tier)).toBe(tier);

      const stats = await hook(page, (d) => d.stats());
      const budget = BUDGET[tier]!;
      expect(stats.calls, 'draw calls').toBeGreaterThan(10);
      expect(stats.calls, 'draw calls').toBeLessThanOrEqual(budget.calls);
      expect(stats.triangles, 'triangles').toBeLessThanOrEqual(budget.triangles);

      await page.evaluate(() => {
        const ui = document.getElementById('ui');
        if (ui) ui.style.visibility = 'hidden';
      });
      await page.waitForTimeout(300);
      const lum = await luminance(page);
      // the loft is a night scene but never black; the field is bright but never white-out
      const range = level === 'night-loft' ? [0.025, 0.5] : [0.2, 0.85];
      expect(lum.mean, 'mean luminance').toBeGreaterThan(range[0]!);
      expect(lum.mean, 'mean luminance').toBeLessThan(range[1]!);
      expect(lum.std, 'contrast').toBeGreaterThan(0.04);
      expect(lum.black, 'pure-black share (NaN blocks / missing scenery)').toBeLessThan(level === 'night-loft' ? 0.35 : 0.02);
      expect(errors).toEqual([]);
    });
  }
}
