/**
 * VR path on an emulated Meta Quest 2 (IWER via `?xremu=1`): Enter VR, Touch-controller menus,
 * arm + take-off latch, altitude hold on the centred thumbstick, camera cycle, pause and leaving VR.
 * VR lives in the Quest app page (/app/), which boots only for a store owner: every test stubs the
 * Meta Digital Goods API with an owner's account.
 */
import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';
import { XR_CARD_PX, XR_CARD_TEXT_W, type XrPanelView } from '../../src/render/xr-panel';
import { questOwnerStub } from './quest-owner';

// the first-run tutorial offer is covered by tutorial.spec.ts; here it would cover the menus
test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Hook {
  state: { position: { x: number; y: number; z: number } };
  race: { status: string };
  tier: string;
  armed: boolean;
  camera: string;
  screen: string;
  audio: string;
  xr: { presenting: boolean; source: string; latched: boolean; panelDraws: number; frameRate: number | null; foveation: number | null; motorsMuted: boolean; panel: XrPanelView | null };
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
type W = { __drone: Hook; __xrDevice: { controllers: Record<Hand, EmuController>; updateVisibilityState(s: 'visible' | 'visible-blurred' | 'hidden'): void } };

const errors: string[] = [];

test.beforeEach(async ({ context }) => {
  await context.addInitScript(questOwnerStub);
});

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

/**
 * The VR card as laid out with the browser's real fonts: every line fits the text width at its own size
 * (drawn without fillText's maxWidth squeeze), and the flight card keeps sub / hint at full legible size.
 */
async function expectCardFits(page: Page, layout: 'menu' | 'hud'): Promise<void> {
  const panel = await page.evaluate(() => (window as unknown as W).__drone.xr.panel);
  expect(panel?.layout).toBe(layout);
  expect(panel!.lines.length).toBeGreaterThanOrEqual(2);
  for (const l of panel!.lines) {
    expect(l.width, l.text).toBeLessThanOrEqual(XR_CARD_TEXT_W);
    if (layout === 'hud' && l.weight !== 700) expect(l.px, l.text).toBe(l.weight === 500 ? XR_CARD_PX.sub : XR_CARD_PX.hint);
  }
}

const altitude = (page: Page) => page.evaluate(() => (window as unknown as W).__drone.state.position.y);

test('emulated Quest 2: enter VR, fly with Touch controllers, pause and exit', async ({ page }) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  // fixed quality: 'auto' resizes on its own as the frame rate moves, which would hide a stale DPR
  await page.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: 'high' })));
  await page.goto('/app/?xremu=1');
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
  await expectCardFits(page, 'menu');

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
  await expectCardFits(page, 'hud');

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
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.panel?.title === 'PAUSED');
  await expectCardFits(page, 'menu');
  const pauseHelp = await page.evaluate(() => (window as unknown as W).__drone.xr.panel!.lines.filter((l) => l.weight === 500).map((l) => l.text));
  expect(pauseHelp).toEqual(['L-stick click recentre', 'L-trigger heading arrow']);
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
  await page.goto('/app/?xremu=1');
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
  await page.goto('/app/?xremu=1');
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
  await page.goto('/app/?xremu=1');
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

const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/152.0.0.44.30 Chrome/152.0.7977.64 VR Safari/537.36';

for (const installed of [true, false]) {
  test(`Quest ${installed ? 'installed app (standalone) enters VR at launch' : 'browser tab does not auto-enter VR'}`, async ({ browser }) => {
    const ctx = await browser.newContext({ userAgent: QUEST_UA });
    await skipTutorialOffer(ctx);
    await ctx.addInitScript(questOwnerStub);
    if (installed) {
      // the Horizon OS app shows the page in display-mode standalone
      await ctx.addInitScript(() => {
        const mm = window.matchMedia.bind(window);
        window.matchMedia = (q: string) => (q.includes('display-mode: standalone') ? ({ ...mm(q), matches: true, media: q } as MediaQueryList) : mm(q));
      });
    }
    const page = await ctx.newPage();
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('/app/?xremu=1');
    await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
    if (installed) {
      await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
      // B leaves to the app's 2D panel: the card says so, and the panel offers Enter VR straight away
      await page.waitForFunction(() => (window as unknown as W).__drone.xr.panel?.hint.includes('B 2D menu'));
      expect(await page.evaluate(() => (window as unknown as W).__drone.xr.panel?.hint)).not.toContain('Exit VR');
      await press(page, 'right', 'b-button');
      await page.waitForFunction(() => !(window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
      expect(await page.evaluate(() => (window as unknown as W).__drone.screen)).toBe('main');
      await expect(page.locator('.ds-toast', { hasText: 'Press Enter VR to fly' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enter VR' })).toBeFocused();
    } else {
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => (window as unknown as W).__drone.xr.presenting)).toBe(false);
      await expect(page.getByRole('button', { name: 'Enter VR' })).toBeVisible();
    }
    expect(errs).toEqual([]);
    await ctx.close();
  });
}

test('Quest installed app, first run: no 2D tutorial dialog over Enter VR; the headset card offers it, R-stick click replays it', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: QUEST_UA });
  await ctx.addInitScript(questOwnerStub);
  await ctx.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes('display-mode: standalone') ? ({ ...mm(q), matches: true, media: q } as MediaQueryList) : mm(q));
  });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('/app/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  await expect(page.getByRole('dialog', { name: 'New to FPV?' })).toBeHidden();
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.panel?.title === 'NEW TO FPV?');
  type T = { tutorial: { on: boolean; step: string; phase: string } };
  await press(page, 'right', 'a-button');
  await page.waitForFunction(() => ((window as unknown as { __drone: T }).__drone.tutorial.on));
  const card = await page.evaluate(() => (window as unknown as W).__drone.xr.panel);
  expect(card).toMatchObject({ layout: 'card', kicker: 'STEP 1 / 12', title: 'Welcome, pilot' });
  // pause (Y) → X skips; back on the menu card R-stick click starts it again
  await press(page, 'left', 'y-button');
  await press(page, 'left', 'x-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'menu');
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.panel?.hint)).toContain('R-stick click Tutorial');
  await press(page, 'right', 'thumbstick');
  await page.waitForFunction(() => ((window as unknown as { __drone: T }).__drone.tutorial.on));
  expect(errs).toEqual([]);
  await ctx.close();
});

test('Quest system menu / headset off: the flight pauses and the sound stops; back in view the sound returns', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('/app/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Enter VR' }).click();
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  await press(page, 'left', 'x-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'freefly');
  await press(page, 'right', 'a-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.armed);
  await page.waitForFunction(() => (window as unknown as W).__drone.audio === 'running', null, { timeout: 5_000 });

  for (const state of ['visible-blurred', 'hidden'] as const) {
    await page.evaluate((s) => (window as unknown as W).__xrDevice.updateVisibilityState(s), state);
    await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'paused', null, { timeout: 5_000 });
    await page.waitForFunction(() => (window as unknown as W).__drone.audio === 'suspended', null, { timeout: 5_000 });
    await page.evaluate(() => (window as unknown as W).__xrDevice.updateVisibilityState('visible'));
    await page.waitForFunction(() => (window as unknown as W).__drone.audio === 'running', null, { timeout: 5_000 });
    // still paused until the pilot resumes with A; the audio context runs again (menu sounds), the motors stay muted
    expect(await page.evaluate(() => (window as unknown as W).__drone.race.status)).toBe('paused');
    expect(await page.evaluate(() => (window as unknown as W).__drone.xr.motorsMuted)).toBe(true);
    await press(page, 'right', 'a-button');
    await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'freefly');
    await page.waitForFunction(() => !(window as unknown as W).__drone.xr.motorsMuted);
  }
  expect(errs).toEqual([]);
});

test('VR session runs at 72 Hz with fixed foveation; the browser card offers B Exit VR and the full flight hints', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('/app/?xremu=1');
  await page.waitForFunction(() => !!(window as unknown as Partial<W>).__drone && !!(window as unknown as Partial<W>).__xrDevice, null, { timeout: 20_000 });
  // record what the game asks the runtime for (IWER starts at 72 Hz already)
  await page.evaluate(() => {
    const proto = (window as unknown as { XRSession: { prototype: { updateTargetFrameRate(r: number): Promise<void> } } }).XRSession.prototype;
    const orig = proto.updateTargetFrameRate;
    const asked: number[] = [];
    (window as unknown as { __asked: number[] }).__asked = asked;
    proto.updateTargetFrameRate = function (this: unknown, r: number) {
      asked.push(r);
      return orig.call(this, r);
    };
  });
  await page.getByRole('button', { name: 'Enter VR' }).click();
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.presenting, null, { timeout: 10_000 });
  await page.waitForFunction(() => (window as unknown as { __asked: number[] }).__asked.length > 0, null, { timeout: 5_000 });
  expect(await page.evaluate(() => (window as unknown as { __asked: number[] }).__asked)).toEqual([72]);
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.frameRate)).toBe(72);
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.foveation)).toBe(1);
  await page.waitForFunction(() => (window as unknown as W).__drone.xr.panel?.hint.includes('B Exit VR'));

  await press(page, 'left', 'x-button');
  await page.waitForFunction(() => (window as unknown as W).__drone.race.status === 'freefly');
  for (const armed of [false, true]) {
    if (armed) {
      await press(page, 'right', 'a-button');
      await page.waitForFunction(() => (window as unknown as W).__drone.armed);
      // past the take-off latch (its prompt replaces the button hints)
      await stick(page, 'left', 0, -1);
      await page.waitForFunction(() => !(window as unknown as W).__drone.xr.latched);
      await stick(page, 'left', 0, 0);
    }
    await page.waitForTimeout(400);
    const hint = await page.evaluate(() => (window as unknown as W).__drone.xr.panel?.hint ?? '');
    for (const part of ['B mode', 'X reset', 'R-stick click cam', 'Y pause']) expect(hint, `armed=${armed}`).toContain(part);
  }
  expect(await page.evaluate(() => (window as unknown as W).__drone.xr.panel?.title)).toMatch(/km\/h$/);
  expect(errs).toEqual([]);
});
