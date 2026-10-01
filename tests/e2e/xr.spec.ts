/**
 * VR path on an emulated Meta Quest 2 (IWER via `?xremu=1`): Enter VR, Touch-controller menus,
 * arm + take-off latch, altitude hold on the centred thumbstick, camera cycle, pause and leaving VR.
 */
import { expect, test, type Page } from '@playwright/test';

interface Hook {
  state: { position: { x: number; y: number; z: number } };
  race: { status: string };
  tier: string;
  armed: boolean;
  camera: string;
  screen: string;
  xr: { presenting: boolean; source: string; latched: boolean; panelDraws: number };
  pixelRatio: number;
  renderScale: number;
  stats: () => { calls: number; triangles: number };
  action: (a: { type: string }) => void;
}

type Hand = 'left' | 'right';
interface EmuController {
  updateButtonValue(id: string, v: number): void;
  updateAxes(id: string, x: number, y: number): void;
}

/** Page globals: the game's debug hook and the IWER device (not declared globally: game.spec owns `__drone`). */
type W = { __drone: Hook; __xrDevice: { controllers: Record<Hand, EmuController> } };

const errors: string[] = [];

/** Tap a Touch button: held for a few frames, then released. */
async function press(page: Page, hand: Hand, button: string): Promise<void> {
  await page.evaluate(([h, b]) => (window as unknown as W).__xrDevice.controllers[h as Hand].updateButtonValue(b, 1), [hand, button]);
  await page.waitForTimeout(150);
  await page.evaluate(([h, b]) => (window as unknown as W).__xrDevice.controllers[h as Hand].updateButtonValue(b, 0), [hand, button]);
  await page.waitForTimeout(150);
}

/** Thumbstick in xr-standard axes (Y −1 = pushed up). */
const stick = (page: Page, hand: Hand, x: number, y: number) =>
  page.evaluate(([h, sx, sy]) => (window as unknown as W).__xrDevice.controllers[h as Hand].updateAxes('thumbstick', sx as number, sy as number), [hand, x, y] as const);

const altitude = (page: Page) => page.evaluate(() => (window as unknown as W).__drone.state.position.y);

test('emulated Quest 2: enter VR, fly with Touch controllers, pause and exit', async ({ page }) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  // fixed quality: 'auto' resizes on its own as the frame rate moves, which would hide a stale DPR
  await page.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: 'high' })));
  await page.goto('/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });

  const flatTier = await page.evaluate(() => (window as unknown as W).__drone.tier);
  // DPR cap of the tier (auto quality moves renderScale with the frame rate, so divide it out)
  const dprCap = () => page.evaluate(() => { const d = (window as unknown as W).__drone; return Math.round((d.pixelRatio / d.renderScale) * 100) / 100; });
  const flatDpr = await dprCap();
  const enter = page.getByRole('button', { name: 'Enter VR' });
  await expect(enter).toBeVisible();
  await enter.click();
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as W).__drone.tier)).toBe('low');
  expect(await page.evaluate(() => (window as unknown as W).__drone.stats().calls)).toBeGreaterThan(10);

  // Menu card: X = Free fly
  await press(page, 'left', 'x-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'freefly');
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.source)).toBe('xr');
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.latched)).toBe(true);

  // A arms with the centred (latched) thumbstick
  await press(page, 'right', 'a-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.armed);
  const ground = await altitude(page);

  // Push the left (Mode 2 throttle) stick up: releases the latch and climbs
  await stick(page, 'left', 0, -1);
  await page.waitForFunction((g) => (window as unknown as W).__drone.state.position.y > g + 0.8, ground, { timeout: 8_000 });
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.latched)).toBe(false);

  // The VR card (canvas → texture upload) refreshes its speed/altitude at ≤ 10 Hz, not every frame
  const d0 = await page.evaluate(() => (window as unknown as W).__drone.xr.panelDraws);
  await page.waitForTimeout(2000);
  const draws = (await page.evaluate(() => (window as unknown as W).__drone.xr.panelDraws)) - d0;
  expect(draws).toBeGreaterThan(0);
  expect(draws).toBeLessThanOrEqual(24);

  // Centre: altitude hold keeps it in the air
  await stick(page, 'left', 0, 0);
  await page.waitForTimeout(1200);
  const a1 = await altitude(page);
  await page.waitForTimeout(1500);
  const a2 = await altitude(page);
  expect(a2).toBeGreaterThan(ground + 0.5);
  expect(Math.abs(a2 - a1)).toBeLessThan(0.3);

  // Right stick click cycles the camera LOS → FPV
  expect(await page.evaluate(() => (window as unknown as W).__drone.camera)).toBe('los');
  await press(page, 'right', 'thumbstick');
  expect(await page.evaluate(() => (window as unknown as W).__drone.camera)).toBe('fpv');

  // Y pauses, B leaves VR and the flat-screen pause menu is waiting
  await press(page, 'left', 'y-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'paused');
  await press(page, 'right', 'b-button');
  await page.waitForFunction(() => !(window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as W).__drone.screen)).toBe('pause');
  expect(await page.evaluate(() => (window as unknown as W).__drone.tier)).toBe(flatTier);
  // the flat-screen pixel ratio is restored after three has handed the canvas back
  await page.waitForTimeout(300);
  expect(await dprCap()).toBe(flatDpr);

  expect(errors).toEqual([]);
});

test('two Enter VR requests in one tick start one working session (controllers still fly)', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
  // two requests in the same tick: the second must neither start nor tear down a session
  await page.evaluate(() => {
    const d = (window as unknown as W).__drone;
    d.action({ type: 'enter-vr' });
    d.action({ type: 'enter-vr' });
  });
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.presenting)).toBe(true);
  await press(page, 'left', 'x-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'freefly', null, { timeout: 5_000 });
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.source)).toBe('xr');
  expect(errs).toEqual([]);
});

test('Quest immersive app launch: sessiongranted enters VR without a click', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.presenting)).toBe(false);
  // what Quest Browser fires when the Horizon OS app is launched in immersive mode
  await page.evaluate(() => (navigator as Navigator & { xr: EventTarget }).xr.dispatchEvent(new Event('sessiongranted')));
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  expect(errs).toEqual([]);
});

test('sessiongranted with a refused session: no unhandled rejection, toast, Enter VR still offered', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Enter VR' })).toBeVisible();
  await page.evaluate(() => {
    const xr = (navigator as Navigator & { xr: EventTarget & { requestSession: () => Promise<never> } }).xr;
    xr.requestSession = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    xr.dispatchEvent(new Event('sessiongranted'));
  });
  await expect(page.locator('.ds-toast', { hasText: 'VR unavailable' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.presenting)).toBe(false);
  await expect(page.getByRole('button', { name: 'Enter VR' })).toBeVisible();
  expect(errs).toEqual([]);
});
