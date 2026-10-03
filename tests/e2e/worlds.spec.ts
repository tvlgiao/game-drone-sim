/**
 * Generated levels in the real build: City, Alpine Valley and Infinite boot behind the loading overlay and reach
 * free fly with their chunks streamed by the module worker; a scripted pilot flies the City race to the finish;
 * an Infinite seed gives the same ground after a reload (and lands in the saved worlds); switching through every
 * level returns renderer.info to the same numbers (nothing leaks).
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';

test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Stats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}
interface Ring {
  position: [number, number, number];
  direction: [number, number, number];
}
interface Hook {
  level: string;
  levelReady: boolean;
  race: { status: string; totalRings: number; nextRing: number; time: number };
  state: { position: { x: number; y: number; z: number }; velocity: { y: number } };
  rings: Ring[];
  world: { id: string; seed: number | null; code: string | null } | null;
  stats: () => Stats;
  levelStats: () => Record<string, unknown> | null;
  census: () => Record<string, { draws: number; tris: number }>;
  hold: (on: boolean) => void;
  heightAt: (x: number, z: number) => number;
  action: (a: Record<string, unknown>) => void;
  teleport: (x: number, y: number, z: number, yaw?: number) => void;
  press: (b: string) => void;
  setControl: (c: { throttle: number; pitch: number; roll: number; yaw: number } | null) => void;
  startLevel: (id: string, opts?: { seed?: number }) => Promise<boolean>;
}

const errors: string[] = [];

async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?rotate=0');
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
  const gate = page.getByRole('button', { name: /tap to play/i });
  if (await gate.isVisible().catch(() => false)) await gate.tap();
  const tip = page.getByRole('button', { name: /got it/i });
  if (await tip.isVisible({ timeout: 800 }).catch(() => false)) await tip.tap();
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

async function fly(page: Page, id: string, mode: 'freefly' | 'race', seed?: number): Promise<void> {
  await page.evaluate(([id, mode, seed]) => (window as unknown as { __drone: Hook }).__drone.action({ type: 'level', id, mode, seed }), [id, mode, seed] as const);
  await expect
    .poll(() => page.evaluate((seed) => {
      const d = (window as unknown as { __drone: Hook & { loading: { visible: boolean } } }).__drone;
      // ready = the loading screen has handed over (its textures uploaded, its shaders compiled)
      return [d.level, d.levelReady && !d.loading.visible, seed === undefined || d.world?.seed === seed];
    }, seed), { timeout: 45_000 })
    .toEqual([id, true, true]);
}

for (const id of ['city', 'alpine', 'infinite'] as const) {
  test(`${id}: boots behind the loading overlay and reaches free fly on streamed ground`, async ({ page }) => {
    await boot(page);
    await fly(page, id, 'freefly', id === 'infinite' ? 4242 : undefined);
    await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 10_000 }).toBe('freefly');
    await expect(page.locator('.ds-load')).toBeHidden();
    // the drone rests on the ground of the level, not on y = 0
    const agl = await hook(page, (d) => d.state.position.y - d.heightAt(d.state.position.x, d.state.position.z));
    expect(agl).toBeGreaterThan(-0.05);
    expect(agl).toBeLessThan(0.5);
    if (id !== 'city') {
      const s = (await hook(page, (d) => d.levelStats())) as { chunks: number; colliderChunks: number; builder: string; failures: number };
      expect(s.chunks).toBeGreaterThanOrEqual(9);
      expect(s.colliderChunks).toBeGreaterThanOrEqual(4);
      expect(s.failures).toBe(0);
      // Chromium and WebKit both run the module worker (the inline fallback is for WKWebView / no Worker)
      expect(s.builder).toBe('worker');
    }
    const st = await hook(page, (d) => d.stats());
    expect(st.calls).toBeGreaterThan(10);
    expect(errors).toEqual([]);
  });
}

/** Scenery share of the XR budget (07 §7, per frame = both eyes): what the generated level itself adds. */
const LOW_SCENERY_DRAWS = 12;
const LOW_SCENERY_TRIS = 50_000;

test.describe('low tier (Quest XR budget)', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop Chromium with the low tier forced');
  test.beforeEach(({ context }) => context.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ v: 3, quality: 'low' }))));

  for (const id of ['city', 'alpine', 'infinite'] as const) {
    test(`${id}: the scenery stays within ${LOW_SCENERY_DRAWS} draws and ${LOW_SCENERY_TRIS / 1000}k triangles per eye`, async ({ page }) => {
      await boot(page);
      await fly(page, id, 'freefly', id === 'infinite' ? 21 : undefined);
      expect(await hook(page, (d) => (d as unknown as { tier: string }).tier)).toBe('low');
      await page.waitForTimeout(2_000);
      const census = await hook(page, (d) => d.census());
      let draws = 0;
      let tris = 0;
      for (const [k, v] of Object.entries(census)) {
        if (!k.startsWith('world/')) continue;
        draws += v.draws;
        tris += v.tris;
      }
      test.info().annotations.push({ type: 'scenery', description: `${id}: ${draws} draws, ${tris} tris` });
      expect(draws).toBeLessThanOrEqual(LOW_SCENERY_DRAWS);
      expect(tris).toBeLessThanOrEqual(LOW_SCENERY_TRIS);
      expect(errors).toEqual([]);
    });
  }
});

/** iPhone / tablet (medium) frame budget (07 §7). */
const PHONE_DRAWS = 110;
const PHONE_TRIS = 250_000;

test.describe('phone (medium budget)', () => {
  test.skip(({ isMobile }) => !isMobile, 'iPhone WebKit project');

  test(`City over the street canyon fits ${PHONE_DRAWS} draws and ${PHONE_TRIS / 1000}k triangles`, async ({ page }) => {
    await boot(page);
    await fly(page, 'city', 'freefly');
    expect(await hook(page, (d) => (d as unknown as { tier: string }).tier)).toBe('medium');
    await page.evaluate(() => {
      const d = (window as unknown as { __drone: Hook & { setCamera: (m: string) => void } }).__drone;
      d.teleport(-560, 20, -200, -Math.PI / 2);
      d.hold(true);
      d.setCamera('chase');
    });
    await page.waitForTimeout(2_500);
    const s = await hook(page, (d) => d.stats());
    test.info().annotations.push({ type: 'budget', description: `${s.calls} draws, ${s.triangles} tris` });
    expect(s.calls).toBeLessThanOrEqual(PHONE_DRAWS);
    expect(s.triangles).toBeLessThanOrEqual(PHONE_TRIS);
    expect(errors).toEqual([]);
  });
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('City race: a scripted pilot flies all 18 rings to the finish', async ({ page }) => {
    test.setTimeout(150_000);
    await boot(page);
    await fly(page, 'city', 'race');
    await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 10_000 }).toBe('racing');
    const rings = await hook(page, (d) => d.rings);
    expect(rings.length).toBe(18);
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i]!;
      const [dx, , dz] = r.direction;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      // 3 m before the ring on its axis, nose along it; arm, then a PD pilot holds the ring height while pitching forward
      await page.evaluate(
        ([x, y, z, yaw]) => {
          const d = (window as unknown as { __drone: Hook }).__drone;
          d.setControl({ throttle: 0, pitch: 0, roll: 0, yaw: 0 });
          d.teleport(x!, y!, z!, yaw);
          d.press('arm');
        },
        [r.position[0] - ux * 3, r.position[1], r.position[2] - uz * 3, Math.atan2(-ux, -uz)],
      );
      await page.waitForTimeout(80);
      await page.evaluate((targetY) => {
        const d = (window as unknown as { __drone: Hook }).__drone;
        const w = window as unknown as { __pilot: number };
        clearInterval(w.__pilot);
        w.__pilot = window.setInterval(() => {
          const y = d.state.position.y;
          const vy = d.state.velocity.y;
          d.setControl({ throttle: Math.min(1, Math.max(0, 0.56 + 0.35 * (targetY - y) - 0.15 * vy)), pitch: 0.22, roll: 0, yaw: 0 });
        }, 16);
      }, r.position[1]);
      await page.waitForFunction((n) => {
        const d = (window as unknown as { __drone: Hook }).__drone;
        return d.race.nextRing > n || d.race.status === 'finished';
      }, i, { timeout: 8_000 });
      await page.evaluate(() => clearInterval((window as unknown as { __pilot: number }).__pilot));
    }
    await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 5_000 }).toBe('finished');
    expect(await hook(page, (d) => d.race.time)).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  });

  test('Infinite: the same seed gives the same ground after a reload; the world is saved with its code', async ({ page }) => {
    test.setTimeout(120_000);
    const probes: [number, number][] = [
      [0, 0],
      [137.25, -911.5],
      [-2048, 4096],
      [12345.5, -6789.25],
      [-40_000, 31_000],
    ];
    await boot(page);
    await fly(page, 'infinite', 'freefly', 987654321);
    const a = await page.evaluate((p) => p.map(([x, z]) => (window as unknown as { __drone: Hook }).__drone.heightAt(x, z)), probes);
    const world = await hook(page, (d) => d.world);
    expect(world?.seed).toBe(987654321);
    expect(world?.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('drone-sim.worlds.v1') ?? 'null') as { last: string; worlds: { code: string; seed: number }[] });
    expect(saved.last).toBe(world!.code);
    expect(saved.worlds.find((w) => w.code === world!.code)?.seed).toBe(987654321);
    // another seed is another world
    await fly(page, 'infinite', 'freefly', 987654322);
    const other = await page.evaluate((p) => p.map(([x, z]) => (window as unknown as { __drone: Hook }).__drone.heightAt(x, z)), probes);
    expect(other).not.toEqual(a);
    // a reload comes back to the last played world (Infinite remembered), then the first seed again by code's seed
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone);
    await expect.poll(() => hook(page, (d) => [d.level, d.world?.seed])).toEqual(['infinite', 987654322]);
    await fly(page, 'infinite', 'freefly', 987654321);
    const b = await page.evaluate((p) => p.map(([x, z]) => (window as unknown as { __drone: Hook }).__drone.heightAt(x, z)), probes);
    expect(b).toEqual(a);
    expect(errors).toEqual([]);
  });

  test('switching through every level returns renderer.info to the same numbers (no leaked GPU resources)', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    const settled = async (): Promise<Stats> => {
      await page.waitForTimeout(2_500);
      return hook(page, (d) => d.stats());
    };
    const go = async (id: string): Promise<Stats> => {
      await fly(page, id, 'freefly', id === 'infinite' ? 77 : undefined);
      return settled();
    };
    const pick = (s: Stats): number[] => [s.geometries, s.textures];
    await go('training');
    // first lap creates one-off shared programs / resources; the laps after it must leave nothing behind
    for (const id of ['city', 'alpine', 'infinite', 'training']) await go(id);
    const base = pick(await go('training'));
    for (let lap = 0; lap < 2; lap++) {
      for (const id of ['city', 'alpine', 'infinite']) await go(id);
      expect(pick(await go('training'))).toEqual(base);
    }
    expect(errors).toEqual([]);
  });
});
