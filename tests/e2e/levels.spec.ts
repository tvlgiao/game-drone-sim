/**
 * Level picker and level switching: the picker on desktop and a landscape iPhone, Training free fly and
 * race, soft bounds, the remembered level, and GPU resources released when switching (renderer.info).
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';

// the first-run tutorial offer is covered by tutorial.spec.ts; here it would cover the menus
test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Stats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}
interface Hook {
  screen: string;
  level: string;
  race: { status: string; totalRings: number; nextRing: number };
  state: { position: { x: number; y: number; z: number } };
  renders: number;
  stats: () => Stats;
  action: (a: Record<string, unknown>) => void;
  teleport: (x: number, y: number, z: number, yaw?: number) => void;
  startLevel: (id: string) => Promise<boolean>;
}

const errors: string[] = [];

async function boot(page: Page, query = '?rotate=0'): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/play/${query}`);
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

/** Touch devices first show the tap-to-play gate (and on iOS the home-screen tip). */
async function passGate(page: Page): Promise<void> {
  const gate = page.getByRole('button', { name: /tap to play/i });
  if (await gate.isVisible().catch(() => false)) await gate.tap();
  const tip = page.getByRole('button', { name: /got it/i });
  if (await tip.isVisible({ timeout: 800 }).catch(() => false)) await tip.tap();
}

async function click(page: Page, name: string): Promise<void> {
  const b = page.getByRole('button', { name, exact: true });
  if (test.info().project.use.isMobile) await b.tap();
  else await b.click();
}

/** Fraction of distinct colours in a thumbnail canvas (0 = blank). */
const thumbVariety = (page: Page, id: string): Promise<number> =>
  page.evaluate((id) => {
    const c = document.querySelector<HTMLCanvasElement>(`canvas[data-thumb="${id}"]`)!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
    return seen.size / (d.length / (4 * 97));
  }, id);

test('level picker: cards with thumbnails and Race / Free Fly per level, focus on the current level, Back to the menu', async ({ page }) => {
  await boot(page);
  await passGate(page);
  await click(page, 'Race');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
  const cards = page.locator('.ds-screen--levels .ds-lvl');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Training Field');
  await expect(cards.nth(1)).toContainText('Night Loft');
  // a first-time pilot is on the beginner field
  await expect(cards.nth(0)).toContainText('Selected');
  // opened from Race: the current level's Race button has the focus
  await expect(page.locator('.ds-screen--levels .is-focused')).toHaveAttribute('data-act', 'level-race:training');
  for (const id of ['training', 'night-loft']) expect(await thumbVariety(page, id)).toBeGreaterThan(0.02);
  // every Race / Free Fly button is on screen and is what a tap at its centre hits (after the rise-in animation)
  await page.waitForTimeout(600);
  const vp = page.viewportSize()!;
  for (const act of ['level-race:training', 'level-freefly:training', 'level-race:night-loft', 'level-freefly:night-loft']) {
    const box = (await page.locator(`[data-act="${act}"]`).boundingBox())!;
    expect(box.y + box.height, act).toBeLessThanOrEqual(vp.height);
    expect(box.height, act).toBeGreaterThanOrEqual(44);
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-act]')?.getAttribute('data-act'), [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit).toBe(act);
  }
  await click(page, 'Back');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('main');
  expect(errors).toEqual([]);
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('keyboard: Free Fly opens the picker on Free Fly, ← → move between levels, Enter starts the Night Loft', async ({ page }) => {
    await boot(page);
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown', { delay: 40 });
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter', { delay: 40 });
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
    const focus = page.locator('.ds-screen--levels .is-focused');
    await expect(focus).toHaveAttribute('data-act', 'level-freefly:training');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight', { delay: 40 });
    await expect(focus).toHaveAttribute('data-act', 'level-freefly:night-loft');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter', { delay: 40 });
    await expect.poll(() => hook(page, (d) => [d.level, d.race.status, d.screen])).toEqual(['night-loft', 'freefly', 'none']);
    expect(errors).toEqual([]);
  });

  test('Training race: 3 rings, countdown to racing; the level is remembered across a reload', async ({ page }) => {
    await boot(page);
    await hook(page, (d) => d.action({ type: 'level', id: 'training', mode: 'race' }));
    await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 8_000 }).toBe('racing');
    expect(await hook(page, (d) => [d.level, d.race.totalRings, d.race.nextRing])).toEqual(['training', 3, 0]);
    const spawn = await hook(page, (d) => [d.state.position.x, d.state.position.z]);
    expect(spawn[0]).toBeCloseTo(0, 3);
    expect(spawn[1]).toBeCloseTo(33, 3);
    // the pick is remembered: Night Loft after a reload, although first-time pilots start on Training
    await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'freefly' }));
    await expect.poll(() => hook(page, (d) => d.level)).toBe('night-loft');
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone);
    expect(await hook(page, (d) => d.level)).toBe('night-loft');
    await expect(page.locator('.ds-screen--main [data-f="best"]')).toContainText('Night Loft');
    expect(errors).toEqual([]);
  });

  test('leaving the Training field shows a countdown and respawns on the pad after 5 s', async ({ page }) => {
    await boot(page);
    await hook(page, (d) => d.action({ type: 'level', id: 'training', mode: 'freefly' }));
    await expect.poll(() => hook(page, (d) => d.race.status)).toBe('freefly');
    // the first frames of a freshly built level compile its shaders: fly out only once it is rendering
    const r0 = await hook(page, (d) => d.renders);
    await expect.poll(() => hook(page, (d) => d.renders), { timeout: 15_000 }).toBeGreaterThan(r0 + 10);
    await hook(page, (d) => d.teleport(55, 0.2, 0));
    await expect(page.locator('.ds-center__big')).toHaveText('OUT OF BOUNDS', { timeout: 10_000 });
    await expect(page.locator('.ds-center__sub')).toContainText(/respawn in [1-5] s/);
    await expect.poll(() => hook(page, (d) => Math.round(d.state.position.z)), { timeout: 9_000 }).toBe(33);
    expect(await hook(page, (d) => Math.round(d.state.position.x))).toBe(0);
    await expect(page.locator('.ds-center__big')).toHaveText('');
    expect(errors).toEqual([]);
  });

  test('switching levels frees the old level: draw calls, geometries and textures return to the loft numbers', async ({ page }) => {
    await boot(page);
    const settled = async (): Promise<Stats> => {
      await page.waitForTimeout(2_500); // respawn shimmer and dust settle
      return hook(page, (d) => d.stats());
    };
    const go = async (id: string): Promise<Stats> => {
      await page.evaluate((id) => (window as unknown as { __drone: Hook }).__drone.action({ type: 'level', id, mode: 'freefly' }), id);
      await expect.poll(() => hook(page, (d) => d.level)).toBe(id);
      return settled();
    };
    const pick = (s: Stats): number[] => [s.geometries, s.textures, s.calls];
    const first = await go('night-loft');
    const training = await go('training');
    expect(training.calls).toBeGreaterThan(10);
    // the first round trip may create one-off shared resources; after it every trip must be identical
    const warm = await go('night-loft');
    expect(warm.geometries).toBe(first.geometries);
    const warmTraining = pick(await go('training'));
    const warmLoft = pick(await go('night-loft'));
    for (let i = 0; i < 2; i++) {
      expect(pick(await go('training'))).toEqual(warmTraining);
      expect(pick(await go('night-loft'))).toEqual(warmLoft);
    }
    expect(warmLoft).toEqual(pick(warm));
    expect(errors).toEqual([]);
  });

  test('the loft still flies after a round trip through Training: 12 rings, room walls stop the drone', async ({ page }) => {
    await boot(page);
    await hook(page, (d) => d.startLevel('training'));
    await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'race' }));
    await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 8_000 }).toBe('racing');
    expect(await hook(page, (d) => [d.level, d.race.totalRings])).toEqual(['night-loft', 12]);
    // dropped outside the east wall, physics pushes the drone back inside the 24 m room
    await hook(page, (d) => d.teleport(13, 2, 0));
    await expect.poll(() => hook(page, (d) => d.state.position.x)).toBeLessThan(12);
    expect(errors).toEqual([]);
  });
});

test.describe('touch', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch devices only');

  test('tapping Free Fly on the Training card starts it with the touch sticks', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await click(page, 'Free Fly');
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
    await page.getByRole('button', { name: 'Free Fly · Training Field' }).tap();
    await expect.poll(() => hook(page, (d) => [d.level, d.race.status])).toEqual(['training', 'freefly']);
    const before = await hook(page, (d) => d.renders);
    await page.waitForTimeout(500);
    expect(await hook(page, (d) => d.renders)).toBeGreaterThan(before + 5);
    expect(errors).toEqual([]);
  });
});
