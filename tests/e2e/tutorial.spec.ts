/**
 * The tutorial wired into the game: first-run prompt shown once, Skip persists, scripted keyboard steps with the
 * spring-back keyboard (altitude hold), forced angle mode, skip paths (Esc, pause menu; no hold-to-skip), the
 * main-menu entry, and the LOS camera keeping the drone in frame on the Training course.
 */
import { devices, expect, test, type Page } from '@playwright/test';

interface Hook {
  screen: string;
  level: string;
  mode: string;
  camera: string;
  armed: boolean;
  race: { status: string };
  state: { position: { x: number; y: number; z: number } };
  tutorial: { on: boolean; phase: string; step: string; index: number; progress: number; dialog: string | null };
  droneNdc: { x: number; y: number; z: number };
  action: (a: Record<string, unknown>) => void;
  press: (b: string) => void;
  setControl: (c: { throttle: number; yaw: number; pitch: number; roll: number } | null) => void;
  startLevel: (id: string) => Promise<boolean>;
  startTutorial: (fromStep?: number) => void;
  teleport: (x: number, y: number, z: number, yaw?: number) => void;
}

const TUTORIAL_KEY = 'drone-sim.tutorial.v1';
const errors: string[] = [];

async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/?rotate=0');
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;
const step = (page: Page): Promise<string> => hook(page, (d) => d.tutorial.step);
const record = (page: Page): Promise<Record<string, unknown> | null> =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null') as Record<string, unknown> | null, TUTORIAL_KEY);

test('first run: Training is the default level and the tutorial offer shows once; Skip persists', async ({ page }) => {
  await boot(page);
  expect(await hook(page, (d) => d.level)).toBe('training');
  const prompt = page.getByRole('dialog', { name: 'New to FPV?' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Start' })).toBeFocused();
  await prompt.getByRole('button', { name: 'Skip' }).click();
  await expect(prompt).toBeHidden();
  expect(await record(page)).toMatchObject({ skipped: true, done: false });
  expect(await hook(page, (d) => d.screen)).toBe('main');
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone);
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog', { name: 'New to FPV?' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('keyboard tutorial: Enter, Space, hold W to climb, let go to hover; angle forced; Esc skips back to the menu', async ({ page }) => {
  // the pilot flies acro: steps 2–8 must still run in angle, and the pilot's mode comes back afterwards
  await page.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ flightMode: 'acro' })));
  await boot(page);
  await page.getByRole('dialog', { name: 'New to FPV?' }).getByRole('button', { name: 'Start' }).click();
  await expect.poll(() => hook(page, (d) => d.tutorial.on)).toBe(true);
  expect(await hook(page, (d) => [d.level, d.race.status, d.camera])).toEqual(['training', 'freefly', 'los']);
  const card = page.getByRole('region', { name: 'Tutorial' });
  await expect(card).toBeVisible();
  // one voice for Esc: the card's Skip button carries it; the chip row has no second, differently worded Esc chip
  await expect(card.getByRole('button', { name: 'Skip tutorial (Esc)' })).toBeVisible();
  await expect(card.locator('.ds-tut-continue')).toContainText('Enter');
  await expect(card).not.toContainText('Esc to skip');
  await expect(page.locator('#ui [data-bind="pause"]')).toHaveCount(0);
  // the legend folds to its chip while the card is up
  await expect(page.locator('#ui .ds-cmap')).toBeHidden();

  // every rendered frame of an angle-forced step flies angle, the frame the step starts included
  await page.evaluate(() => {
    const w = window as unknown as { __drone: Hook; __lag: string[] };
    const forced = new Set(['arm', 'throttle', 'hover', 'yaw', 'pitch-roll', 'land', 'disarm']);
    w.__lag = [];
    const tick = (): void => {
      const d = w.__drone;
      if (d.tutorial.on && forced.has(d.tutorial.step) && d.mode !== 'angle') w.__lag.push(`${d.tutorial.step}:${d.mode}`);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => step(page)).toBe('arm');
  expect(await hook(page, (d) => d.mode)).toBe('angle');
  await expect(card).toContainText('Press Space to arm.');
  await page.keyboard.press('Space');
  await expect.poll(() => step(page)).toBe('throttle');
  await expect(card).toContainText('Hold W to climb past 1.5 m.');

  // spring-back keyboard: W climbs, letting go holds the height (altitude hold), which completes the hover step
  await page.keyboard.down('KeyW');
  // let go as soon as the step completes (rAF polling), like a pilot watching the card
  await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.tutorial.step === 'hover', null, { polling: 'raf', timeout: 8000 });
  await page.keyboard.up('KeyW');
  await expect(card).toContainText('No key held = hold height');
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe('yaw');
  expect(await hook(page, (d) => d.state.position.y)).toBeGreaterThan(1);
  expect(await hook(page, (d) => d.mode)).toBe('angle');

  // M is locked while angle is forced: no mode change saved
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(200);
  expect(await hook(page, (d) => d.mode)).toBe('angle');

  expect(await page.evaluate(() => (window as unknown as { __lag: string[] }).__lag)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('main');
  expect(await hook(page, (d) => [d.tutorial.on, d.tutorial.phase])).toEqual([false, 'skipped']);
  await expect(card).toBeHidden();
  expect(await record(page)).toMatchObject({ skipped: true, step: 5 });
  // the pilot's own mode is back (settings untouched by the forced angle)
  expect(await hook(page, (d) => d.mode)).toBe('acro');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('drone-sim.settings')!).flightMode)).toBe('acro');
  expect(errors).toEqual([]);
});

test('reset and crash repeat the step from the pad; the main menu Tutorial entry replays from step 1', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ done: true, skipped: false, step: 12, at: 1 })), TUTORIAL_KEY);
  await boot(page);
  await expect(page.getByRole('dialog', { name: 'New to FPV?' })).toBeHidden();
  await page.getByRole('button', { name: 'Tutorial', exact: true }).click();
  await expect.poll(() => step(page)).toBe('welcome');
  await page.keyboard.press('Enter');
  // Space on the welcome card is locked (A = arm and confirm on a pad): arm once step 2 shows
  await expect.poll(() => step(page)).toBe('arm');
  await page.keyboard.press('Space');
  await expect.poll(() => step(page)).toBe('throttle');
  await page.keyboard.down('KeyW');
  await expect.poll(() => hook(page, (d) => d.state.position.y)).toBeGreaterThan(0.8);
  await page.keyboard.up('KeyW');
  // R: back on the pad (z = 33), disarmed, same step from zero
  const before = await step(page);
  expect(['throttle', 'hover']).toContain(before);
  await page.keyboard.press('KeyR');
  await expect.poll(() => hook(page, (d) => d.state.position.y < 0.2)).toBe(true);
  expect(await hook(page, (d) => [d.tutorial.step, d.tutorial.progress, d.armed, Math.round(d.state.position.z)])).toEqual([before, 0, false, 33]);
  await expect(page.getByRole('region', { name: 'Tutorial' })).toContainText('Disarmed: press Space to arm again.');
  // replay from the pause menu restarts at step 1 and keeps done: true
  await hook(page, (d) => d.action({ type: 'tutorial' }));
  await expect.poll(() => step(page)).toBe('welcome');
  expect(await record(page)).toMatchObject({ done: true });
  expect(errors).toEqual([]);
});

test('gamepad: no hold-to-skip; Start opens the pause menu with Replay / Skip tutorial (no Restart)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('drone-sim.tutorial.v1', JSON.stringify({ done: true, skipped: false, step: 12, at: 1 }));
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', index: 0, connected: true, mapping: 'standard', axes: [0, 1, 0, 0], buttons, timestamp: 0, vibrationActuator: null };
    const w = window as unknown as { __pad: typeof pad };
    w.__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [w.__pad], configurable: true });
  });
  await boot(page);
  type PadWin = { __pad: { buttons: { pressed: boolean; touched: boolean; value: number }[] } };
  const btn = (i: number, on: boolean): Promise<void> =>
    page.evaluate(([i, on]) => {
      (window as unknown as PadWin).__pad.buttons[i as number] = { pressed: on as boolean, touched: on as boolean, value: on ? 1 : 0 };
    }, [i, on] as const);
  await hook(page, (d) => d.startTutorial());
  await expect.poll(() => step(page)).toBe('welcome');
  // A = confirm on the welcome card (arm is locked there)
  await btn(0, true);
  await expect.poll(() => step(page)).toBe('arm');
  await btn(0, false);
  expect(await hook(page, (d) => d.armed)).toBe(false);
  const card = page.getByRole('region', { name: 'Tutorial' });
  await expect(card.getByRole('button', { name: 'Skip tutorial (pause with Menu)' })).toBeVisible();
  // holding B (reset / back) for 2 s does not skip any more
  await btn(1, true);
  await page.waitForTimeout(2000);
  await btn(1, false);
  expect(await hook(page, (d) => [d.tutorial.on, d.tutorial.phase])).toEqual([true, 'running']);
  // Start (Menu) pauses: the pause menu offers Replay / Skip tutorial instead of Restart
  await btn(9, true);
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('pause');
  await btn(9, false);
  await expect(card).toBeHidden();
  const pause = page.locator('.ds-screen--pause');
  await expect(pause.getByRole('button', { name: 'Skip tutorial' })).toBeVisible();
  await expect(pause.getByRole('button', { name: 'Replay tutorial' })).toBeVisible();
  await expect(pause.getByRole('button', { name: 'Restart' })).toBeHidden();
  await pause.getByRole('button', { name: 'Skip tutorial' }).click();
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('main');
  expect(await record(page)).toMatchObject({ skipped: true, done: true });
  // outside the tutorial the pause menu is the usual one again
  await hook(page, (d) => d.action({ type: 'freefly' }));
  await btn(9, true);
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('pause');
  await expect(pause.getByRole('button', { name: 'Restart' })).toBeVisible();
  await expect(pause.getByRole('button', { name: 'Skip tutorial' })).toBeHidden();
  expect(errors).toEqual([]);
});

test('Training LOS keeps the drone inside the frame while it climbs off the pad and flies the course', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ done: true, skipped: true, step: 1, at: 1 })), TUTORIAL_KEY);
  await boot(page);
  await hook(page, (d) => d.action({ type: 'level', id: 'training', mode: 'freefly' }));
  await expect.poll(() => hook(page, (d) => d.race.status)).toBe('freefly');
  expect(await hook(page, (d) => d.camera)).toBe('los');
  await hook(page, (d) => d.press('arm'));
  await expect.poll(() => hook(page, (d) => d.armed)).toBe(true);
  // full climb straight off the pad (the case that left the frame), then forward, a bank and a yaw
  const legs: [number, { throttle: number; yaw: number; pitch: number; roll: number }][] = [
    [1800, { throttle: 0.95, yaw: 0, pitch: 0, roll: 0 }],
    [1500, { throttle: 0.6, yaw: 0, pitch: 0.5, roll: 0 }],
    [1500, { throttle: 0.6, yaw: 0.4, pitch: 0.4, roll: 0.4 }],
    [1500, { throttle: 0.55, yaw: 0, pitch: -0.5, roll: -0.3 }],
  ];
  let worst = 0;
  let samples = 0;
  for (const [ms, c] of legs) {
    await page.evaluate((c) => (window as unknown as { __drone: Hook }).__drone.setControl(c), c);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const [ndc, status] = await hook(page, (d) => [d.droneNdc, d.race.status] as const);
      if (status === 'freefly') {
        expect(ndc.z, 'drone behind the LOS camera').toBeLessThan(1);
        worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
        samples++;
      }
      await page.waitForTimeout(60);
    }
  }
  await hook(page, (d) => d.setControl(null));
  expect(samples).toBeGreaterThan(40);
  expect(worst, 'drone projected outside the safe area').toBeLessThan(0.8);
  expect(errors).toEqual([]);
});

test('acro pilot: the modes step starts in angle and needs both switches (no head start for flying acro)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('drone-sim.settings', JSON.stringify({ flightMode: 'acro' }));
    localStorage.setItem('drone-sim.tutorial.v1', JSON.stringify({ done: true, skipped: false, step: 12, at: 1 }));
  });
  await boot(page);
  await hook(page, (d) => d.startTutorial(9));
  await expect.poll(() => step(page)).toBe('modes');
  await page.waitForTimeout(300);
  expect(await hook(page, (d) => [d.mode, d.tutorial.progress])).toEqual(['angle', 0]);
  await page.keyboard.press('KeyM');
  await expect.poll(() => hook(page, (d) => d.tutorial.progress)).toBe(0.5);
  expect(await hook(page, (d) => d.mode)).toBe('acro');
  await page.keyboard.press('KeyM');
  await expect.poll(() => step(page)).toBe('cameras');
  // the pilot's acro comes back when the tutorial ends
  await page.keyboard.press('Escape');
  await expect.poll(() => hook(page, (d) => d.mode)).toBe('acro');
  expect(errors).toEqual([]);
});

test('one voice: no amber hint, arm toast or ARMED pulse while the card runs; outside it the hint wins over the toast', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ done: true, skipped: false, step: 12, at: 1 })), TUTORIAL_KEY);
  await boot(page);
  await hook(page, (d) => d.startTutorial(2));
  await expect.poll(() => step(page)).toBe('arm');
  await expect(page.locator('#ui .ds-hint')).not.toHaveClass(/is-on/);
  await page.keyboard.press('Space');
  await expect.poll(() => step(page)).toBe('throttle');
  await page.waitForTimeout(300);
  // count now: a retrying toHaveCount(0) would pass once a toast had faded
  expect(await page.locator('#ui .ds-toast').count()).toBe(0);
  await expect(page.locator('#ui .ds-hint')).not.toHaveClass(/is-on/);
  expect(await page.locator('#ui .ds-center__big').textContent()).toBe('');
  await page.keyboard.press('Escape');
  await expect.poll(() => hook(page, (d) => d.screen)).toBe('main');

  await hook(page, (d) => d.action({ type: 'freefly' }));
  await expect.poll(() => hook(page, (d) => d.race.status)).toBe('freefly');
  await expect(page.locator('#ui .ds-hint')).toHaveClass(/is-on/);
  await page.keyboard.press('Space');
  await expect(page.locator('#ui .ds-hint')).toContainText('to take off');
  await page.waitForTimeout(300);
  expect(await page.locator('#ui .ds-toast', { hasText: 'Armed' }).count()).toBe(0);
  expect(errors).toEqual([]);
});

test('completion card: the flight timer stops and the HUD hides behind it', async ({ page }) => {
  await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ done: true, skipped: false, step: 12, at: 1 })), TUTORIAL_KEY);
  await boot(page);
  await hook(page, (d) => d.startTutorial(11));
  await expect.poll(() => step(page)).toBe('ring');
  // through ring 1 (0, 3, 22), facing −Z: hold ~3 m on raw throttle (no input source = no altitude hold) while
  // pitching forward; a pass that drifts off the ring is flown again from the same start
  for (let attempt = 0; attempt < 4 && (await hook(page, (d) => d.tutorial.phase)) !== 'done'; attempt++) {
    await hook(page, (d) => d.teleport(0, 3, 25.5, 0));
    await page.waitForTimeout(150);
    await hook(page, (d) => d.press('arm'));
    await page.waitForTimeout(150);
    for (let t = Date.now(); Date.now() - t < 6000; ) {
      const [phase, y, vy, z] = await hook(page, (d) => [d.tutorial.phase, d.state.position.y, (d.state as unknown as { velocity: { y: number } }).velocity.y, d.state.position.z] as const);
      if (phase === 'done' || z < 19) break;
      const throttle = Math.min(0.9, Math.max(0.3, 0.55 + 0.15 * (3 - y) - 0.1 * vy));
      await page.evaluate((c) => (window as unknown as { __drone: Hook }).__drone.setControl(c), { throttle, yaw: 0, pitch: 0.25, roll: 0 });
      await page.waitForTimeout(30);
    }
    await hook(page, (d) => d.setControl(null));
  }
  expect(await hook(page, (d) => d.tutorial.phase)).toBe('done');
  await expect(page.getByRole('dialog', { name: 'Tutorial complete' })).toBeVisible();
  const timer = page.locator('#ui [data-r="time"]');
  const t0 = await timer.textContent();
  await page.waitForTimeout(1000);
  expect(await timer.textContent()).toBe(t0);
  await expect.poll(() => page.locator('#ui .ds-hud').evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
  expect(errors).toEqual([]);
});

for (const name of ['iPhone 15 Pro landscape', 'iPhone SE landscape', 'iPad Pro 11 landscape'] as const) {
  test(`${name}: the tutorial card stays in the top band, clear of the drone in LOS and of the buttons`, async ({ browser }) => {
    const { defaultBrowserType: _, ...dev } = devices[name];
    const ctx = await browser.newContext(dev);
    await ctx.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ done: true, skipped: false, step: 12, at: 1 })), TUTORIAL_KEY);
    const page = await ctx.newPage();
    await page.goto('/play/?rotate=0');
    await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
    const gate = page.getByRole('button', { name: /tap to play/i });
    if (await gate.isVisible().catch(() => false)) await gate.tap();
    await hook(page, (d) => d.startTutorial(2));
    await expect.poll(() => hook(page, (d) => d.tutorial.on)).toBe(true);
    // a touch on the view makes touch the active source (the card's touch layout)
    await page.touchscreen.tap(dev.viewport.width / 2, dev.viewport.height / 2);
    for (const from of [2, 3, 5, 6, 11]) {
      await page.evaluate((f) => (window as unknown as { __drone: Hook }).__drone.startTutorial(f), from);
      await expect.poll(() => hook(page, (d) => d.tutorial.index)).toBe(from - 1);
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => {
        const box = (sel: string): DOMRect | null => document.querySelector(sel)?.getBoundingClientRect() ?? null;
        const n = (window as unknown as { __drone: Hook }).__drone.droneNdc;
        return { card: box('.ds-tut-card')!, drone: { x: ((n.x + 1) / 2) * innerWidth, y: ((1 - n.y) / 2) * innerHeight }, btns: [...document.querySelectorAll('[data-tbtn]')].map((b) => b.getBoundingClientRect()) };
      });
      const m = 40;
      const coversDrone = r.drone.x > r.card.left - m && r.drone.x < r.card.right + m && r.drone.y > r.card.top - m && r.drone.y < r.card.bottom + m;
      expect(coversDrone, `step ${from}: card ${JSON.stringify(r.card)} vs drone ${JSON.stringify(r.drone)}`).toBe(false);
      expect(r.card.bottom, `step ${from}`).toBeLessThan(r.drone.y - m);
      // readable: a squeezed card would clear everything by being unreadably narrow
      expect(r.card.width, `step ${from}`).toBeGreaterThanOrEqual(230);
      for (const b of r.btns) {
        if (!b.width) continue;
        const overlap = b.left < r.card.right && r.card.left < b.right && b.top < r.card.bottom && r.card.top < b.bottom;
        expect(overlap, `step ${from}: card overlaps a touch button`).toBe(false);
      }
    }
    await ctx.close();
  });
}
