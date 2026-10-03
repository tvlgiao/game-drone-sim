/**
 * The worlds UI wired into the real game (not the harness): every generated level starts from its level card
 * with the outdoor HUD up, a new random world from the Worlds screen is flown and then listed, a `?world=` link
 * opens that world (the same ground after a reload, the parameter dropped from the address bar), and a bad code
 * only toasts.
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';
import { encodeSeed } from '../../src/world/seed-code';
import { GEN_VERSION } from '../../src/world/world';

test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Hook {
  level: string;
  levelReady: boolean;
  screen: string;
  race: { status: string };
  state: { position: { x: number; y: number; z: number } };
  world: { id: string; seed: number | null; code: string | null } | null;
  heightAt: (x: number, z: number) => number;
  action: (a: Record<string, unknown>) => void;
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
  const gate = page.getByRole('button', { name: /tap to play/i });
  if (await gate.isVisible().catch(() => false)) await gate.tap();
  const tip = page.getByRole('button', { name: /got it/i });
  if (await tip.isVisible({ timeout: 800 }).catch(() => false)) await tip.tap();
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

async function press(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  if (test.info().project.use.isMobile) await el.tap();
  else await el.click();
}

async function flying(page: Page, id: string): Promise<void> {
  await expect.poll(() => hook(page, (d) => [d.level, d.levelReady, d.race.status, d.screen]), { timeout: 60_000 }).toEqual([id, true, 'freefly', 'none']);
}

const PROBES: [number, number][] = [
  [0, 0],
  [311.5, -97.25],
  [-1500, 2200],
];
const heights = (page: Page): Promise<number[]> => page.evaluate((p) => p.map(([x, z]) => (window as unknown as { __drone: Hook }).__drone.heightAt(x, z)), PROBES);

test('each generated level starts from its card with the outdoor HUD: compass, minimap, AGL', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  for (const id of ['city', 'alpine', 'infinite'] as const) {
    await hook(page, (d) => d.action({ type: 'menu' }));
    await press(page, '.ds-screen--main [data-act="levels"], .ds-screen--main button:has-text("Free Fly")');
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
    await press(page, `[data-act="level-freefly:${id}"]`);
    await flying(page, id);
    await expect(page.locator('.ds-compass')).toBeVisible();
    await expect(page.locator('.ds-minimap')).toBeVisible();
    await expect.poll(() => page.locator('.ds-compass [data-r="cAgl"]').textContent()).toMatch(/^\d+(\.\d)? m$/);
  }
  // indoors the outdoor HUD goes away again
  await hook(page, (d) => d.action({ type: 'level', id: 'night-loft', mode: 'freefly' }));
  await flying(page, 'night-loft');
  await expect(page.locator('.ds-compass')).toBeHidden();
  await expect(page.locator('.ds-minimap')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Worlds…: a new random world flies, and after Back it is in the saved list', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await press(page, '.ds-screen--main button:has-text("Free Fly")');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('levels');
  await press(page, '[data-act="level-worlds:infinite"]');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('worlds');
  await press(page, 'button:has-text("New random world")');
  await flying(page, 'infinite');
  const code = (await hook(page, (d) => d.world?.code)) as string;
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await page.waitForTimeout(800);
  // back out to the menu and open the Worlds screen again
  await hook(page, (d) => d.action({ type: 'menu' }));
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('main');
  await press(page, '.ds-screen--main button:has-text("Free Fly")');
  await press(page, '[data-act="level-worlds:infinite"]');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('worlds');
  await expect(page.locator('.ds-wrow').first()).toContainText(code);
  await expect(page.locator('.ds-wrow').first()).toContainText('Last flown');
  expect(errors).toEqual([]);
});

test('?world=CODE opens that world and drops the parameter; a reload keeps the same ground', async ({ page }) => {
  test.setTimeout(120_000);
  const seed = 0x2468ace0;
  const code = encodeSeed(seed, GEN_VERSION);
  await boot(page, `?rotate=0&world=${code}`);
  await flying(page, 'infinite');
  expect(await hook(page, (d) => [d.world?.seed, d.world?.code])).toEqual([seed, code]);
  expect(new URL(page.url()).searchParams.has('world')).toBe(false);
  const a = await heights(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone);
  await expect.poll(() => hook(page, (d) => [d.level, d.levelReady, d.world?.seed]), { timeout: 60_000 }).toEqual(['infinite', true, seed]);
  expect(await heights(page)).toEqual(a);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('drone-sim.worlds.v1') ?? 'null') as { last: string });
  expect(saved.last).toBe(code);
  expect(errors).toEqual([]);
});

test('a bad ?world= code only toasts', async ({ page }) => {
  await boot(page, '?rotate=0&world=ZZZZ-ZZZZ');
  await expect(page.locator('.ds-toast')).toContainText('That world link is not valid');
  expect(new URL(page.url()).searchParams.has('world')).toBe(false);
  expect(await hook(page, (d) => d.level)).not.toBe('infinite');
  expect(errors).toEqual([]);
});
