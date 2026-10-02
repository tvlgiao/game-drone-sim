/**
 * Control hints in the flight HUD (glyphs per active input), the Controls legend, keyboard spring-back
 * with altitude hold, and keyboard + mouse flight under pointer lock.
 */
import { expect, test, type Page } from '@playwright/test';

// window.__drone is typed by the global declaration in game.spec.ts.
type Ctl = { control: { throttle: number; pitch: number; roll: number; yaw: number } | null };

const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';

async function fly(page: Page): Promise<void> {
  await page.goto('/play/');
  await page.waitForFunction(() => !!window.__drone, null, { timeout: 20_000 });
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.waitForFunction(() => window.__drone.race.status === 'freefly');
}

/** A fake pad whose left stick is nudged, so it becomes the active source. */
async function fakePad(page: Page, id: string): Promise<void> {
  await page.addInitScript((padId) => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: padId, index: 0, connected: true, mapping: 'standard', axes: [0.5, 1, 0, 0], buttons, timestamp: 0, vibrationActuator: null };
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad], configurable: true });
  }, id);
}

const ui = (page: Page, sel: string) => page.locator(`#ui ${sel}`);
const control = (page: Page) => page.evaluate(() => (window.__drone as unknown as Ctl).control!);

test('keyboard: keycaps beside arm / mode / camera, a reset / pause strip, stick key clusters and the legend', async ({ page }) => {
  await fly(page);
  await page.keyboard.press('KeyA');
  await expect(page.locator('#ui')).toHaveAttribute('data-scheme', 'keyboard');
  await expect(ui(page, '[data-r="gArm"] .ds-g--key')).toHaveText('Space');
  await expect(ui(page, '[data-r="gMode"] .ds-g--key')).toHaveText('M');
  await expect(ui(page, '[data-r="gCam"] .ds-g--key')).toHaveText('C');
  await expect(ui(page, '[data-bind="reset"]')).toHaveText(/R\s*Reset/);
  await expect(ui(page, '[data-bind="pause"]')).toHaveText(/Esc\s*Pause/);
  await expect(ui(page, '[data-r="keysL"] .ds-g')).toHaveText(['W', 'A', 'S', 'D']);
  await expect(ui(page, '[data-r="keysR"] .ds-g')).toHaveText(['↑', '←', '↓', '→']);
  await expect(ui(page, '[data-r="hint"]')).toHaveText(/press\s*Space\s*to arm/);
  const legend = ui(page, '[data-r="cmap"]');
  await expect(legend).toBeVisible(); // first flight
  await expect(legend).toContainText('Throttle');
  await expect(legend).toContainText('centre = hover');
});

test('Xbox pad: coloured A / Y face buttons, RB, Menu', async ({ page }) => {
  await fakePad(page, XBOX);
  await fly(page);
  await expect(page.locator('#ui')).toHaveAttribute('data-scheme', 'xbox');
  await expect(ui(page, '[data-r="gArm"] .ds-g--face.is-green')).toHaveText('A');
  await expect(ui(page, '[data-r="gMode"] .ds-g--face.is-yellow')).toHaveText('Y');
  await expect(ui(page, '[data-r="gCam"] .ds-g--shoulder')).toHaveText('RB');
  await expect(ui(page, '[data-bind="pause"] .ds-g')).toHaveAttribute('aria-label', 'Menu');
  await expect(ui(page, '[data-r="hint"] .ds-g--face')).toHaveText('A');
});

test('DualSense: ✕ △ ○ shapes, R1, Options / Create', async ({ page }) => {
  await fakePad(page, DUALSENSE);
  await fly(page);
  await expect(page.locator('#ui')).toHaveAttribute('data-scheme', 'playstation');
  await expect(ui(page, '[data-r="gArm"] .ds-g--ps.is-cross')).toHaveAttribute('aria-label', 'Cross');
  await expect(ui(page, '[data-r="gMode"] .ds-g--ps.is-triangle')).toBeVisible();
  await expect(ui(page, '[data-r="gCam"] .ds-g')).toHaveText('R1');
  await expect(ui(page, '[data-bind="reset"] .ds-g--ps.is-circle')).toBeVisible();
  await expect(ui(page, '[data-bind="pause"]')).toContainText('Options');
  await expect(ui(page, '[data-legend]')).toContainText('Create');
});

test('the legend shows for the first flight, then stays collapsed; H toggles it and the choice persists', async ({ page }) => {
  await fly(page);
  const legend = ui(page, '[data-r="cmap"]');
  await expect(legend).toBeVisible();
  await page.evaluate(() => window.__drone.action({ type: 'menu' }));
  await page.waitForFunction(() => window.__drone.race.status === 'menu');
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await page.waitForFunction(() => window.__drone.race.status === 'freefly');
  await expect(legend).toBeHidden();
  await page.keyboard.press('KeyH');
  await expect(legend).toBeVisible();
  await expect(ui(page, '[data-legend]')).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await page.waitForFunction(() => !!window.__drone, null, { timeout: 20_000 });
  await page.evaluate(() => window.__drone.action({ type: 'freefly' }));
  await expect(legend).toBeVisible();
  await ui(page, '[data-legend]').click();
  await expect(legend).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('drone-sim.controls-legend'))).toBe('closed');
});

test('keyboard: hold W climbs, release springs to hover and holds altitude, S lands', async ({ page }) => {
  await fly(page);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__drone.armed);
  await expect(ui(page, '[data-r="hint"]')).toHaveText(/Hold\s*W\s*to take off/);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1300);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  expect((await control(page)).throttle).toBe(0.5);
  await page.waitForTimeout(1000);
  const y0 = await page.evaluate(() => window.__drone.state.position.y);
  expect(y0).toBeGreaterThan(1);
  await page.waitForTimeout(2000);
  const y1 = await page.evaluate(() => window.__drone.state.position.y);
  expect(Math.abs(y1 - y0)).toBeLessThan(0.25);
  await page.keyboard.down('KeyS');
  await page.waitForFunction(() => window.__drone.state.position.y < 0.3, null, { timeout: 8000 });
  await page.keyboard.up('KeyS');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !window.__drone.armed);
});

test('keyboard + mouse: clicking the view captures the mouse, motion tilts, Z centres, losing the lock pauses', async ({ page }) => {
  await fly(page);
  await page.keyboard.press('KeyA');
  await expect(ui(page, '[data-bind="mouse"]')).toContainText('Click view');
  await page.mouse.click(960, 500);
  const locked = await page
    .waitForFunction(() => !!document.pointerLockElement, null, { timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!locked) {
    // headless without pointer lock: drive the same pointerlockchange path with a stubbed lock
    test.info().annotations.push({ type: 'pointer-lock', description: 'stubbed: the browser refused a real lock' });
    await page.evaluate(() => {
      let el: Element | null = document.getElementById('game');
      Object.defineProperty(document, 'pointerLockElement', { get: () => el, configurable: true });
      Object.defineProperty(document, 'exitPointerLock', {
        value: () => {
          el = null;
          document.dispatchEvent(new Event('pointerlockchange'));
        },
        configurable: true,
      });
      document.dispatchEvent(new Event('pointerlockchange'));
      (window as unknown as { __unlock: () => void }).__unlock = () => {
        el = null;
        document.dispatchEvent(new Event('pointerlockchange'));
      };
    });
  }
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 120, movementY: -90 })));
  await expect(ui(page, '[data-r="mstick"]')).toBeVisible();
  await expect(ui(page, '[data-r="srcName"]')).toHaveText('Keyboard + mouse');
  await page.waitForTimeout(200);
  const c = await control(page);
  expect(c.roll).toBeGreaterThan(0.2); // 'auto' in Angle = hold: the tilt stays
  expect(c.pitch).toBeGreaterThan(0.1);
  await page.waitForTimeout(500);
  expect((await control(page)).roll).toBeCloseTo(c.roll, 3);
  await page.keyboard.press('KeyZ');
  await page.waitForTimeout(100);
  expect((await control(page)).roll).toBe(0);
  // the lock lost behind the game's back (Esc / alt-tab) pauses the flight
  if (locked) await page.evaluate(() => document.exitPointerLock());
  else await page.evaluate(() => (window as unknown as { __unlock: () => void }).__unlock());
  await page.waitForFunction(() => window.__drone.race.status === 'paused', null, { timeout: 2000 });
});
