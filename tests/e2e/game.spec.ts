import { expect, test, type Page } from '@playwright/test';

interface DroneHook {
  state: { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; motors: number[] };
  race: { status: string; nextRing: number; time: number };
  fps: number;
  tier: string;
  armed: boolean;
  camera: string;
  audio: string;
  screen: string;
  stats: () => { calls: number; triangles: number };
  setControl: (c: { throttle: number; yaw: number; pitch: number; roll: number } | null) => void;
  press: (name: string) => void;
  action: (a: { type: string }) => void;
  teleport: (x: number, y: number, z: number, yaw?: number) => void;
}

declare global {
  interface Window {
    __drone: DroneHook;
  }
}

const errors: string[] = [];

async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => !!window.__drone, null, { timeout: 20_000 });
}

const control = (page: Page, throttle: number, pitch = 0, roll = 0, yaw = 0) =>
  page.evaluate((c) => window.__drone.setControl(c), { throttle, pitch, roll, yaw });

test('boots without console errors and renders on the GPU', async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => ({ tier: window.__drone.tier, stats: window.__drone.stats(), status: window.__drone.race.status }));
  expect(info.status).toBe('menu');
  expect(info.stats.calls).toBeGreaterThan(10);
  expect(info.stats.calls).toBeLessThan(250);
  expect(errors).toEqual([]);
});

test('frame rate', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.waitForTimeout(3000);
  const fps = await page.evaluate(() => window.__drone.fps);
  test.info().annotations.push({ type: 'fps', description: fps.toFixed(1) });
  console.log(`measured fps: ${fps.toFixed(1)}`);
  expect(fps).toBeGreaterThan(30);
});

test('arms, takes off and climbs in angle mode', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await control(page, 0);
  await page.evaluate(() => window.__drone.press('arm'));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__drone.armed)).toBe(true);
  await control(page, 0.75);
  await page.waitForTimeout(1200);
  const y = await page.evaluate(() => window.__drone.state.position.y);
  expect(y).toBeGreaterThan(0.8);
  await control(page, 0);
  await page.waitForTimeout(2500);
  const landed = await page.evaluate(() => window.__drone.state.position.y);
  expect(landed).toBeLessThan(0.3);
  expect(errors).toEqual([]);
});

test('arming is refused with throttle up (real FC safety)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await control(page, 0.5);
  await page.evaluate(() => window.__drone.press('arm'));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__drone.armed)).toBe(false);
});

test('race: countdown, pass ring 0, crash + respawn', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'race' }));
  expect(await page.evaluate(() => window.__drone.race.status)).toBe('countdown');
  await page.waitForFunction(() => window.__drone.race.status === 'racing', null, { timeout: 6000 });

  // Put the drone 2 m in front of ring 0 (at -9, 1.5, 1 facing -Z), arm, fly forward through it.
  await page.evaluate(() => window.__drone.teleport(-9, 1.5, 3, 0));
  await control(page, 0);
  await page.evaluate(() => window.__drone.press('arm'));
  await page.waitForTimeout(100);
  // Closed-loop "pilot": PD altitude hold at the ring centre height while pitching forward.
  await page.evaluate(() => {
    const d = window.__drone;
    (window as unknown as { __pilot: number }).__pilot = window.setInterval(() => {
      const y = d.state.position.y;
      const vy = d.state.velocity.y;
      const throttle = Math.min(1, Math.max(0, 0.56 + 0.35 * (1.5 - y) - 0.15 * vy));
      d.setControl({ throttle, pitch: 0.25, roll: 0, yaw: 0 });
    }, 16);
  });
  await page.waitForFunction(() => window.__drone.race.nextRing >= 1, null, { timeout: 5000 });
  await page.evaluate(() => clearInterval((window as unknown as { __pilot: number }).__pilot));

  // Slam into the north wall at speed → crash → respawn.
  await page.evaluate(() => window.__drone.teleport(0, 2.5, -4.5, 0));
  await control(page, 0);
  await page.evaluate(() => window.__drone.press('arm'));
  await page.waitForTimeout(100);
  await control(page, 1, 1);
  await page.waitForFunction(() => window.__drone.race.status === 'crashed', null, { timeout: 5000 });
  await page.waitForFunction(() => window.__drone.race.status === 'racing', null, { timeout: 4000 });
  expect(errors).toEqual([]);
});

test('camera starts in LOS (standing pilot) and cycles LOS → FPV → chase', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  const seen: string[] = [await page.evaluate(() => window.__drone.camera)];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.__drone.press('cycleCamera'));
    await page.waitForTimeout(80);
    seen.push(await page.evaluate(() => window.__drone.camera));
  }
  expect(seen).toEqual(['los', 'fpv', 'chase', 'los']);
});

test('disarm on quit-to-menu is reflected in drone state (HUD/LED stay in sync)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await control(page, 0);
  await page.evaluate(() => window.__drone.press('arm'));
  await page.waitForFunction(() => window.__drone.armed && (window.__drone.state as unknown as { armed: boolean }).armed);
  await page.evaluate(() => window.__drone.action({ type: 'menu' }));
  await page.waitForTimeout(100);
  const s = await page.evaluate(() => ({ fc: window.__drone.armed, state: (window.__drone.state as unknown as { armed: boolean }).armed }));
  expect(s).toEqual({ fc: false, state: false });
});

test('manual reset respawns and simulation keeps running', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.evaluate(() => window.__drone.teleport(0, 3, 0, 0));
  await page.evaluate(() => window.__drone.press('reset'));
  await page.waitForTimeout(300);
  const p = await page.evaluate(() => window.__drone.state.position);
  expect(Math.hypot(p.x + 9, p.z - 5.8)).toBeLessThan(0.3);
  expect(errors).toEqual([]);
});

test('HUD quit button asks for confirmation; cancel resumes, confirm returns to menu', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.getByRole('button', { name: 'Quit flight' }).click();
  expect(await page.evaluate(() => [window.__drone.screen, window.__drone.race.status])).toEqual(['confirm-quit', 'paused']);
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => [window.__drone.screen, window.__drone.race.status])).toEqual(['none', 'freefly']);
  await page.getByRole('button', { name: 'Quit flight' }).click();
  await page.locator('[data-act="menu"]:visible').first().click();
  expect(await page.evaluate(() => [window.__drone.screen, window.__drone.race.status])).toEqual(['main', 'menu']);
});

test('sound stops when the window is hidden and when quitting the game', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Free Fly' }).click(); // real gesture → audio starts
  await page.waitForFunction(() => window.__drone.audio === 'running');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__drone.audio === 'suspended');
  expect(await page.evaluate(() => window.__drone.race.status)).toBe('paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__drone.audio === 'running');

  await page.evaluate(() => window.__drone.action({ type: 'menu' }));
  await page.getByRole('button', { name: 'Quit', exact: true }).click();
  await page.waitForFunction(() => window.__drone.audio === 'suspended');
  expect(await page.evaluate(() => window.__drone.screen)).toBe('bye');
  await page.waitForTimeout(300); // a late resume() must not bring the sound back
  expect(await page.evaluate(() => window.__drone.audio)).toBe('suspended');
  expect(errors).toEqual([]);
});
