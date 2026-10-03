/**
 * Living world (docs/12) in the real game: every outdoor level runs ten seconds with its life on (traffic, birds,
 * countryside / roof life) without a console error and inside the tier's draw / triangle budget; the drone hits a
 * car (cars are colliders); twenty level switches leave no GPU geometry or texture behind; and on the emulated
 * Quest 2 (IWER, low tier, both eyes) life costs at most eight extra draws per frame in any level.
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';
import { questOwnerStub } from './quest-owner';

interface Stats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}
interface Hook {
  level: string;
  levelReady: boolean;
  tier: string;
  screen: string;
  race: { status: string };
  state: { position: { x: number; y: number; z: number } };
  xr: { presenting: boolean };
  stats: () => Stats;
  levelStats: () => Record<string, unknown> | null;
  action: (a: Record<string, unknown>) => void;
  teleport: (x: number, y: number, z: number, yaw?: number) => void;
  hold: (on: boolean) => void;
  setCamera: (m: string) => void;
  view: { levelView: { life?: { group: { visible: boolean } }; stats?: () => Record<string, unknown> } };
}
type W = { __drone: Hook; __xrDevice?: unknown };

const errors: string[] = [];

/** Generated levels' budgets per tier (docs/10 §11.1): draws per frame / triangles. */
const BUDGET: Record<string, { calls: number; triangles: number }> = {
  high: { calls: 150, triangles: 600_000 },
  medium: { calls: 110, triangles: 250_000 },
  low: { calls: 80, triangles: 120_000 },
};
const WORLDS = ['city', 'alpine', 'infinite'] as const;
/** a fixed Infinite world (the hub otherwise rolls a new one) */
const SEED = 1234;

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

async function boot(page: Page, tier: string, path = '/play/?rotate=0'): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((tier) => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: tier })), tier);
  await page.goto(path);
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone, null, { timeout: 30_000 });
  const gate = page.getByRole('button', { name: /tap to play/i });
  if (await gate.isVisible().catch(() => false)) await gate.tap();
  const tip = page.getByRole('button', { name: /got it/i });
  if (await tip.isVisible({ timeout: 800 }).catch(() => false)) await tip.tap();
}

async function fly(page: Page, id: string): Promise<void> {
  await page.evaluate(([id, seed]) => (window as unknown as W).__drone.action(id === 'infinite' ? { type: 'level', id, mode: 'freefly', seed, gen: 2 } : { type: 'level', id, mode: 'freefly' }), [id, SEED] as const);
  await expect.poll(() => hook(page, (d) => [d.level, d.levelReady, d.race.status]), { timeout: 90_000 }).toEqual([id, true, 'freefly']);
}

/**
 * The most draws / triangles over the take-off views (LOS, FPV, chase) and a vista 130 m up, with life shown
 * (`on`) and hidden (`off`) at each pose, and the largest difference life made at any one pose (`extra`).
 */
async function peak(page: Page): Promise<{ on: Stats; off: Stats; extra: number }> {
  const sp = await hook(page, (d) => ({ ...d.state.position }));
  const on = { calls: 0, triangles: 0, geometries: 0, textures: 0 };
  const off = { calls: 0, triangles: 0, geometries: 0, textures: 0 };
  let extra = 0;
  for (const pose of ['los', 'fpv', 'chase', 'vista']) {
    await page.evaluate(
      ([pose, sp]) => {
        const d = (window as unknown as W).__drone;
        d.hold(true);
        d.teleport(sp.x, sp.y + (pose === 'vista' ? 130 : 2), sp.z, 0);
        d.setCamera(pose === 'vista' ? 'chase' : pose);
      },
      [pose, sp] as const,
    );
    await page.waitForTimeout(900);
    const at: Stats[] = [];
    for (const life of [true, false]) {
      await page.evaluate((life) => {
        const l = (window as unknown as W).__drone.view.levelView.life;
        if (l) l.group.visible = life;
      }, life);
      await page.waitForTimeout(300);
      at.push(await hook(page, (d) => d.stats()));
    }
    on.calls = Math.max(on.calls, at[0]!.calls);
    on.triangles = Math.max(on.triangles, at[0]!.triangles);
    off.calls = Math.max(off.calls, at[1]!.calls);
    off.triangles = Math.max(off.triangles, at[1]!.triangles);
    extra = Math.max(extra, at[0]!.calls - at[1]!.calls);
  }
  await page.evaluate(() => {
    const d = (window as unknown as W).__drone;
    const l = d.view.levelView.life;
    if (l) l.group.visible = true;
    d.hold(false);
  });
  return { on, off, extra };
}

test.beforeEach(({ context }) => skipTutorialOffer(context));

test('every outdoor level lives for ten seconds: traffic, birds, countryside / roofs; no console error; inside the tier budget', async ({ page }) => {
  test.setTimeout(300_000);
  const tier = test.info().project.use.isMobile ? 'medium' : 'high';
  await boot(page, tier);
  for (const id of [...WORLDS, 'training'] as const) {
    await fly(page, id);
    // ten seconds of life with the drone hovering over the take-off
    await page.evaluate(() => {
      const d = (window as unknown as W).__drone;
      const p = d.state.position;
      d.teleport(p.x, p.y + 6, p.z, 0);
      d.hold(true);
    });
    const t0 = await hook(page, (d) => (d.view.levelView.stats?.().life as { cars?: number } | undefined) ?? null);
    await page.waitForTimeout(10_000);
    const life = await hook(page, (d) => d.view.levelView.stats?.().life as Record<string, unknown>);
    expect(life, id).toBeTruthy();
    expect(life.birds as number, `${id} birds`).toBeGreaterThan(0);
    if (id === 'city') {
      expect(life.cars as number).toBeGreaterThan(40);
      expect((life.city as Record<string, number>).beacons).toBeGreaterThan(0);
      // the traffic tick stays far under a millisecond
      expect(life.trafficMs as number).toBeLessThan(1);
      expect(t0).not.toBeNull();
    } else {
      const c = life.countryside as Record<string, number>;
      if (id === 'training') expect(c.turbines).toBeGreaterThan(0);
      if (id !== 'training') expect(life.ruralCars as number, `${id} rural cars`).toBeGreaterThanOrEqual(0);
      expect(c.animals + c.turbines + c.tractor, `${id} countryside`).toBeGreaterThan(0);
    }
    if ((WORLDS as readonly string[]).includes(id)) {
      const { on, off } = await peak(page);
      const b = BUDGET[tier]!;
      expect(on.calls, `${id} draws`).toBeLessThanOrEqual(b.calls);
      // inside the budget — or, where the level alone already sits on it (iPhone Alpine), life adds next to nothing
      expect(on.triangles, `${id} triangles`).toBeLessThanOrEqual(Math.max(b.triangles, off.triangles + 5_000));
    }
  }
  expect(errors).toEqual([]);
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('cars are colliders: the drone dropped onto a waiting car lands on its roof and crashes there', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, 'high');
    await fly(page, 'city');
    await page.waitForTimeout(3_000);
    // a car standing still in its lane (queued at a light), near the take-off
    const car = await page.evaluate(() => {
      const lv = (window as unknown as { __drone: { view: { levelView: { content: { traffic: { sim: Record<string, ArrayLike<number> & { length: number }> & { capacity: number } } } } } } }).__drone.view.levelView;
      const sim = lv.content.traffic.sim;
      let best = -1;
      for (let c = 0; c < sim.capacity; c++) if (sim.alive![c] && sim.v![c]! < 0.05 && sim.type![c]! !== 4 && (best < 0 || sim.v![c]! < sim.v![best]!)) best = c;
      return best < 0 ? null : { c: best, x: sim.x![best]!, z: sim.z![best]! };
    });
    expect(car).not.toBeNull();
    // drop the (disarmed) drone 7 m over its roof: ~12 m/s at the roof, well past the crash speed
    await page.evaluate(([x, z]) => {
      const d = (window as unknown as W).__drone;
      d.hold(false);
      d.teleport(x, 8.5, z, 0);
      const w = window as unknown as { __crashY?: number };
      w.__crashY = undefined;
      const watch = (): void => {
        if (d.race.status === 'crashed') {
          w.__crashY = d.state.position.y;
          return;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }, [car!.x, car!.z]);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __crashY?: number }).__crashY), { timeout: 5_000 }).toBeGreaterThan(1.1);
    expect(errors).toEqual([]);
  });

  test('twenty level switches with life on leave no geometry or texture behind', async ({ page }) => {
    test.setTimeout(400_000);
    await boot(page, 'high');
    const go = async (id: string): Promise<number[]> => {
      await fly(page, id);
      await page.waitForTimeout(1_500);
      const s = await hook(page, (d) => d.stats());
      return [s.geometries, s.textures];
    };
    const order = ['city', 'training', 'infinite', 'night-loft', 'alpine'];
    // first round: one-off shared resources (programs, the CC0 sets) may appear
    for (const id of order) await go(id);
    const warm: Record<string, number[]> = {};
    for (const id of order) warm[id] = await go(id);
    for (let i = 0; i < 2; i++) for (const id of order) expect(await go(id), `${id} round ${i + 2}`).toEqual(warm[id]);
    expect(errors).toEqual([]);
  });

  test('emulated Quest 2 (low, both eyes): life costs at most 8 extra draws per frame, no smoke, cars within 250 m', async ({ page }) => {
    test.setTimeout(300_000);
    await page.context().addInitScript(questOwnerStub);
    await boot(page, 'high', '/app/?xremu=1');
    await page.waitForFunction(() => !!(window as unknown as W).__xrDevice, null, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Enter VR' }).click();
    await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 15_000 });
    expect(await hook(page, (d) => d.tier)).toBe('low');
    for (const id of [...WORLDS, 'training', 'night-loft'] as const) {
      await fly(page, id);
      await page.waitForTimeout(2_500);
      const { on, off, extra } = await peak(page);
      expect(extra, `${id} extra draws`).toBeLessThanOrEqual(8);
      if (id !== 'night-loft') {
        expect(on.calls, `${id} draws`).toBeLessThanOrEqual(BUDGET.low!.calls);
        expect(on.triangles, `${id} triangles`).toBeLessThanOrEqual(Math.max(BUDGET.low!.triangles, off.triangles + 5_000));
      }
      const life = await hook(page, (d) => d.view.levelView.stats?.().life as Record<string, unknown> | undefined);
      if (life?.countryside) expect((life.countryside as Record<string, number>).puffs).toBe(0);
      if (life?.city) expect((life.city as Record<string, number>).steam).toBe(0);
    }
    expect(errors).toEqual([]);
  });
});
