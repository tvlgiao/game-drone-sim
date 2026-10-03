/**
 * Render pipeline sanity per level and tier: the frame is neither black, blown out nor flat. Luminance
 * statistics are taken from a real screenshot (decoded in the page), so tone mapping, exposure, grade
 * and post FX are all in the measurement.
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';

interface Lum {
  mean: number;
  /** share of pixels at ≥ 250 (clipped white) */
  clipped: number;
  /** share of pixels at ≤ 4 (crushed black) */
  crushed: number;
  /** standard deviation of luma, 0..1 */
  spread: number;
}

type Hook = { startLevel: (id: string) => Promise<boolean>; tier: string; level: string };

async function luminance(page: Page): Promise<Lum> {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = Math.round((img.height / img.width) * 320);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let sq = 0;
    let clipped = 0;
    let crushed = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      sum += y;
      sq += y * y;
      if (y >= 250) clipped++;
      if (y <= 4) crushed++;
    }
    const mean = sum / n;
    return { mean: mean / 255, clipped: clipped / n, crushed: crushed / n, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) / 255 };
  }, png);
}

/** expected mean luma band per level: a night interior and a sunny field */
const BANDS: Record<string, [number, number]> = { 'night-loft': [0.06, 0.4], training: [0.3, 0.75] };

for (const level of ['night-loft', 'training']) {
  for (const quality of ['ultra', 'medium', 'low']) {
    test(`${level} @ ${quality}: exposure in band, no clipping, no crushed blacks, not flat`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await skipTutorialOffer(ctx);
      await ctx.addInitScript((q) => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: q })), quality);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/play/');
      await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
      await page.evaluate((id) => (window as unknown as { __drone: Hook }).__drone.startLevel(id), level);
      await page.evaluate(() => {
        (document.getElementById('ui') as HTMLElement).style.display = 'none';
      });
      // texture sets stream in and the still frame redraws once they land
      await page.waitForTimeout(2500);
      expect(await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.tier)).toBe(quality);
      const lum = await luminance(page);
      test.info().annotations.push({ type: 'luma', description: JSON.stringify(lum) });
      const [lo, hi] = BANDS[level]!;
      expect(lum.mean).toBeGreaterThan(lo);
      expect(lum.mean).toBeLessThan(hi);
      expect(lum.clipped).toBeLessThan(0.04);
      expect(lum.crushed).toBeLessThan(level === 'night-loft' ? 0.25 : 0.02);
      expect(lum.spread).toBeGreaterThan(0.06);
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }
}

type FlightHook = Hook & { analog: number; action: (a: { type: string }) => void; press: (b: string) => void; camera: string; screen: string };

test('analog FPV feed: drawn in FPV on a post tier, never in LOS or on Low, off when the setting is off', async ({ browser }) => {
  const run = async (quality: string, analogVideo: boolean) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await skipTutorialOffer(ctx);
    await ctx.addInitScript(([q, a]) => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: q, analogVideo: a, analogStrength: 0.5 })), [quality, analogVideo] as const);
    const page = await ctx.newPage();
    await page.goto('/play/');
    await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
    await page.evaluate(() => (window as unknown as { __drone: FlightHook }).__drone.action({ type: 'freefly' }));
    await page.waitForFunction(() => (window as unknown as { __drone: FlightHook }).__drone.screen === 'none', null, { timeout: 10_000 });
    const levels: Record<string, number> = {};
    for (let i = 0; i < 3; i++) {
      // the camera blends over a few hundred ms: read mode and level once it has settled
      await page.waitForTimeout(900);
      const cam = await page.evaluate(() => (window as unknown as { __drone: FlightHook }).__drone.camera);
      levels[cam] = await page.evaluate(() => (window as unknown as { __drone: FlightHook }).__drone.analog);
      await page.evaluate(() => (window as unknown as { __drone: FlightHook }).__drone.press('cycleCamera'));
    }
    await ctx.close();
    return levels;
  };
  const on = await run('high', true);
  expect(on.fpv).toBeGreaterThan(0.4);
  expect(on.los).toBeLessThan(0.01);
  const low = await run('low', true);
  expect(Object.values(low).every((v) => v === 0)).toBe(true);
  const off = await run('high', false);
  expect(off.fpv).toBe(0);
});
