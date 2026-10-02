/**
 * Menu screens: About, reset to defaults, custom rates, confirm dialogs, finish / error copy and the
 * context-aware Controls screen. Desktop specs run on 'chromium'; the touch spec on the WebKit devices.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

interface Hook {
  screen: string;
  race: { status: string };
  action: (a: { type: string }) => void;
  showScreen: (name: string, data?: Record<string, unknown>) => void;
  showError: (msg: string) => void;
}

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const QUEST_UA =
  'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/152.0.0.44.30 Chrome/152.0.7977.64 VR Safari/537.36';

const errors: string[] = [];

async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;
const screenOf = (page: Page): Promise<string> => hook(page, (d) => d.screen);
const stored = (page: Page): Promise<Record<string, unknown>> =>
  page.evaluate(() => JSON.parse(localStorage.getItem('drone-sim.settings') ?? '{}') as Record<string, unknown>);
const focused = (page: Page, screen: string) => page.locator(`.ds-screen--${screen} .is-focused`);

test.describe('desktop menus', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('About is reachable from the main menu by keyboard and from Settings; shows version, support and privacy link', async ({ page }) => {
    await boot(page);
    await page.waitForTimeout(300);
    // one key per frame: the menu polls the keyboard in the game loop
    for (const next of ['Free Fly', 'Settings', 'Controls', 'About']) {
      await page.waitForTimeout(150); // the key must be up for a frame before the next press counts
      await page.keyboard.press('ArrowDown', { delay: 40 });
      await expect(focused(page, 'main')).toHaveText(next);
    }
    await page.keyboard.press('Enter', { delay: 40 });
    await expect.poll(() => screenOf(page)).toBe('about');
    const about = page.locator('.ds-screen--about');
    await expect(about.locator('[data-f="version"]')).toHaveText(VERSION);
    await expect(about.locator('[data-f="version"]')).not.toHaveClass(/ds-num/);
    await expect(about).toContainText('COWORK Game Studio');
    await expect(about).toContainText('support@coworkgamestudio.com');
    const privacy = about.getByRole('link', { name: /Privacy policy/ });
    await expect(privacy).toHaveAttribute('href', './privacy/');
    await expect(privacy).toHaveAttribute('target', '_blank');
    await expect(about.getByRole('link', { name: /Email support/ })).toHaveAttribute('href', /^mailto:support@coworkgamestudio\.com/);
    await expect(about.getByRole('link', { name: /Licences/ })).toHaveAttribute('href', './licenses.txt');
    const licences = await page.request.get('./licenses.txt');
    expect(licences.ok()).toBe(true);
    expect(await licences.text()).toContain('IWER (Immersive Web Emulation Runtime)');
    await expect(about).toContainText('IWER (MIT)');
    expect((await page.request.get('./privacy/')).ok()).toBe(true);
    await page.keyboard.press('Escape', { delay: 40 });
    await expect.poll(() => screenOf(page)).toBe('main');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('.ds-screen--settings').getByRole('button', { name: 'About' }).click();
    await expect.poll(() => screenOf(page)).toBe('about');
    await page.locator('.ds-screen--about').getByRole('button', { name: 'Back' }).click();
    await expect.poll(() => screenOf(page)).toBe('settings');
    expect(errors).toEqual([]);
  });

  test('exactly one item is focused after moving between screens', async ({ page }) => {
    await boot(page);
    await page.waitForTimeout(300);
    for (const next of ['Free Fly', 'Settings']) {
      await page.waitForTimeout(150);
      await page.keyboard.press('ArrowDown', { delay: 40 });
      await expect(focused(page, 'main')).toHaveText(next);
    }
    await page.keyboard.press('Enter', { delay: 40 });
    await expect.poll(() => screenOf(page)).toBe('settings');
    await expect(page.locator('#ui .is-focused')).toHaveCount(1);
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape', { delay: 40 });
    await expect.poll(() => screenOf(page)).toBe('main');
    await expect(page.locator('#ui .is-focused')).toHaveCount(1);
    await expect(focused(page, 'main')).toHaveText('Race');
    expect(errors).toEqual([]);
  });

  test('Reset all settings asks first (Cancel focused) and restores defaults', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const fov = page.locator('.ds-screen--settings [data-key="fovDeg"]');
    await fov.locator('[data-dir="1"]').click();
    await fov.locator('[data-dir="1"]').click();
    await expect(fov.locator('.ds-row__value')).toHaveText('120°');
    const flight = page.locator('.ds-screen--settings [data-key="flightMode"] .ds-row__value');
    await expect(flight).toHaveText('Angle');
    await page.locator('.ds-screen--settings [data-key="flightMode"] [data-dir="1"]').click();
    await expect(flight).toHaveText('Acro');
    expect((await stored(page)).fovDeg).toBe(120);

    await page.getByRole('button', { name: 'Reset all settings' }).click();
    await expect.poll(() => screenOf(page)).toBe('confirm-reset');
    await expect(focused(page, 'confirm-reset')).toHaveText('Cancel');
    await page.keyboard.press('Enter', { delay: 40 }); // Cancel: nothing changes
    await expect.poll(() => screenOf(page)).toBe('settings');
    await expect(fov.locator('.ds-row__value')).toHaveText('120°');

    await page.getByRole('button', { name: 'Reset all settings' }).click();
    await page.getByRole('button', { name: 'Reset all', exact: true }).click();
    await expect.poll(() => screenOf(page)).toBe('settings');
    await expect(fov.locator('.ds-row__value')).toHaveText('110°');
    await expect(flight).toHaveText('Angle');
    expect(await stored(page)).toMatchObject({ fovDeg: 110, flightMode: 'angle' });
    expect(errors).toEqual([]);
  });

  test('custom rates survive a preset cycle; fine step only on rate cells and Throttle mid leaves Auto', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Rates ›', exact: true }).click();
    const rates = page.locator('.ds-screen--rates');
    const cell = (k: string) => rates.locator(`[data-key="${k}"] .ds-row__value`);
    const preset = rates.locator('[data-key="ratePreset"] .ds-row__value');
    await expect(preset).toHaveText('Freestyle');
    await rates.locator('[data-key="rate.roll.center"] [data-dir="1"]').click();
    await rates.locator('[data-key="rate.roll.center"] [data-dir="1"]').click();
    await expect(cell('rate.roll.center')).toHaveText('210');
    await expect(preset).toHaveText('Custom');

    for (const name of ['Beginner', 'Freestyle', 'Race', 'Custom']) {
      await rates.locator('[data-key="ratePreset"] [data-dir="1"]').click();
      await expect(preset).toHaveText(name);
    }
    await expect(cell('rate.roll.center')).toHaveText('210');
    await expect(cell('rate.pitch.center')).toHaveText('210'); // linked roll & pitch

    // fine step: toggled from a rate cell, steps the expo by 0.002 and shows the stored value
    await rates.locator('[data-key="rate.yaw.expo"] .ds-row__value').click();
    await expect(rates.locator('[data-f="fine"]')).toContainText('Fine step ON');
    await rates.locator('[data-key="rate.yaw.expo"] [data-dir="1"]').click();
    await expect(cell('rate.yaw.expo')).toHaveText('0.542');
    expect(((await stored(page)).rates as { yaw: { expo: number } }).yaw.expo).toBeCloseTo(0.542, 6);

    // Throttle mid is not fine-stepped: one step leaves Auto even with fine step on
    const mid = cell('throttleMid');
    await expect(mid).toHaveText(/^Auto/);
    await rates.locator('[data-key="throttleMid"] [data-dir="1"]').click();
    await expect(mid).toHaveText('25%');
    expect((await stored(page)).throttleMid).toBe(0.25);
    await expect(rates).toContainText('Roll/pitch rates apply in Acro mode; Angle mode self-levels');
    await expect(rates.locator('[data-f="altHold"]')).toBeHidden(); // desktop, no VR: the throttle curve applies
    expect(errors).toEqual([]);
  });

  test('confirm-quit starts on Cancel and Quit is not the primary button', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'freefly' }));
    await page.getByRole('button', { name: 'Quit flight' }).click();
    await expect.poll(() => screenOf(page)).toBe('confirm-quit');
    await expect(focused(page, 'confirm-quit')).toHaveText('Cancel');
    const quit = page.locator('.ds-screen--confirm-quit [data-act="menu"]');
    await expect(quit).not.toHaveClass(/ds-btn--primary/);
    await expect(quit).toHaveClass(/ds-btn--quit/);
    await page.keyboard.press('Enter', { delay: 40 });
    await expect.poll(() => hook(page, (d) => [d.screen, d.race.status])).toEqual(['none', 'freefly']);
    expect(errors).toEqual([]);
  });

  test('controller setup without a pad shows only the empty state: no remap buttons, no lone Reset mapping', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Controller ›', exact: true }).click();
    const ctl = page.locator('.ds-screen--controller');
    await expect(ctl.locator('[data-f="devEmpty"]')).toBeVisible();
    await expect(ctl).toContainText('Connect a Bluetooth or USB controller');
    await expect(ctl.locator('[data-act="remap-lx"]')).toBeHidden();
    await expect(ctl.locator('[data-f="devName"]')).toBeHidden();
    await expect(ctl.locator('[data-act="remap-reset"]')).toBeHidden();
    await expect(ctl.getByRole('heading', { name: 'Axis mapping' })).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Controls on desktop: no RT callout unless RT is the throttle; stick throttle tip', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Controls' }).click();
    const body = page.locator('.ds-screen--controls [data-f="body"]');
    await expect(body.locator('.ds-pad__labels')).not.toContainText('RT');
    await expect(body.locator('[data-f="padTip"]')).toContainText('does not re-centre');
    await expect(body.locator('[data-f="touchTable"]')).toHaveCount(0);
    await expect(body.locator('thead')).not.toContainText('Touch controllers');
    expect(errors).toEqual([]);
  });

  test('Settings: About and Reset are rows of the list; the footer is one row of same-size buttons', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const settings = page.locator('.ds-screen--settings');
    for (const act of ['about', 'confirm-reset']) await expect(settings.locator(`.ds-rows > .ds-row[data-act="${act}"]`)).toBeVisible();
    const footer = settings.locator('.ds-dialog__actions');
    await expect(footer).toHaveCount(1);
    const boxes = await footer.locator('.ds-btn:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.top), Math.round(r.height)]));
    expect(boxes.map((b) => b[0] - boxes[0]![0])).toEqual(boxes.map(() => 0)); // one row
    expect(new Set(boxes.map((b) => b[1])).size).toBe(1); // one height
    await expect(footer.locator('.ds-btn--sm')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('throttle curve: the 0 % label clears the live dot at the origin', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Rates ›', exact: true }).click();
    const chart = page.locator('.ds-screen--rates [data-f="thrChart"]');
    await expect(chart.locator('.ds-chart__dot')).toHaveAttribute('transform', /^translate\(/); // placed by the live update (stick at 0)
    const dot = (await chart.locator('.ds-chart__dot').boundingBox())!;
    const label = (await chart.locator('.ds-chart__ylabel', { hasText: /^0%$/ }).boundingBox())!;
    const zero = (await chart.locator('.ds-chart__xlabel', { hasText: /^0$/ }).boundingBox())!;
    expect(label.x + label.width).toBeLessThan(dot.x);
    expect(zero.y).toBeGreaterThan(dot.y + dot.height);
    expect(errors).toEqual([]);
  });

  test('Rates warns that editing a named preset replaces the saved Custom rates', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Rates ›', exact: true }).click();
    const rates = page.locator('.ds-screen--rates');
    const hint = rates.locator('[data-f="replaceHint"]');
    await expect(hint).toBeHidden(); // nothing saved yet
    await rates.locator('[data-key="rate.roll.center"] [data-dir="1"]').click();
    await expect(hint).toBeHidden(); // on Custom: edits extend it
    await rates.locator('[data-key="ratePreset"] [data-dir="1"]').click(); // Custom → Beginner
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('replaces your saved Custom rates');
    await rates.locator('[data-key="rate.yaw.max"] [data-dir="1"]').click();
    await expect(rates.locator('[data-key="ratePreset"] .ds-row__value')).toHaveText('Custom');
    await expect(hint).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Field of view hint shows the narrower FOV a 4:3 screen really gets', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const row = page.locator('.ds-screen--settings [data-key="fovDeg"]');
    const hint = row.locator('.ds-row__hint');
    await expect(hint).toHaveText('FPV lens width');
    for (let i = 0; i < 3; i++) await row.locator('[data-dir="1"]').click(); // 110 → 125
    await expect(row.locator('.ds-row__value')).toHaveText('125°');
    await expect(hint).toHaveText('FPV lens width');
    await row.locator('[data-dir="1"]').click(); // 130: capped by the camera's vertical FOV
    await expect(hint).toHaveText(/this screen shows 12[0-9]°/);
    expect(errors).toEqual([]);
  });

  test('Bye copy: a browser tab is told to close the tab', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.showScreen('bye'));
    await expect(page.locator('.ds-screen--bye [data-f="byeText"]')).toContainText('close this tab');
  });

  test('Bye copy: an installed app names Drone Sim instead of a tab', async ({ page }) => {
    await page.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q: string) => (q === '(display-mode: standalone)' ? ({ ...mm(q), matches: true, media: q } as MediaQueryList) : mm(q));
    });
    await boot(page);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.showScreen('bye'));
    const text = page.locator('.ds-screen--bye [data-f="byeText"]');
    await expect(text).toContainText('You can now close Drone Sim.');
    await expect(text).not.toContainText('tab');
  });

  test('finish on a new best shows the previous best and the gain; error screen hides the jargon', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const d = (window as unknown as { __drone: Hook }).__drone;
      d.showScreen('finish', { time: 83.456, best: 80.12, newBest: false });
    });
    const fin = page.locator('.ds-screen--finish');
    await expect(fin.locator('[data-f="delta"]')).toHaveText('+3.34 s');
    await expect(fin.locator('[data-f="delta"]')).toHaveAttribute('data-sign', 'slower');
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.showScreen('finish', { time: 79.9, best: 79.9, newBest: true }));
    await expect(fin.locator('[data-f="badge"]')).toBeVisible();
    await expect(fin.locator('[data-f="bestLabel"]')).toHaveText('Previous best');
    await expect(fin.locator('[data-f="best"]')).toHaveText('01:20.12');
    await expect(fin.locator('[data-f="delta"]')).toHaveText('−0.22 s');
    await expect(fin.locator('[data-f="delta"]')).toHaveAttribute('data-sign', 'faster');
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.showScreen('finish', { time: 80.004, best: 80, newBest: false }));
    await expect(fin.locator('[data-f="delta"]')).toHaveText('0.00 s');
    await expect(fin.locator('[data-f="delta"]')).toHaveAttribute('data-sign', '');

    await page.evaluate(() =>
      (window as unknown as { __drone: Hook }).__drone.showError('WebGL2 is not available on this device/browser (context lost). Enable hardware acceleration.'),
    );
    const err = page.locator('.ds-screen--error');
    await expect(err).toContainText('couldn’t start 3D graphics');
    await expect(err.locator('[data-f="msg"]')).toBeHidden(); // under the collapsed "Technical details"
    await expect(err.locator('[data-f="advice"]')).toContainText('hardware acceleration');
    await expect(focused(page, 'error')).toHaveText('Reload');
  });
});

test.describe('Quest Browser', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop Chromium with a Quest user agent');
  test.use({ userAgent: QUEST_UA });

  test('Controls list the Touch controller buttons', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Controls' }).click();
    const body = page.locator('.ds-screen--controls [data-f="body"]');
    await expect(body.locator('thead')).toContainText('Touch controllers');
    const row = (name: string) => body.locator('[data-f="padTable"] tbody tr', { has: page.locator('th', { hasText: new RegExp(`^${name}$`) }) }).locator('td').first();
    await expect(row('Arm / disarm')).toHaveText('A');
    await expect(row('Flight mode')).toHaveText('B');
    await expect(row('Reset to checkpoint')).toHaveText('X');
    await expect(row('Pause')).toHaveText('Y');
    await expect(row('Camera')).toHaveText('Right stick click');
    await expect(row('Recentre view')).toHaveText('Left stick click');
    await expect(row('Heading arrow')).toHaveText('Left trigger');
    await expect(body.locator('[data-f="xrTip"]')).toContainText('holds altitude');
    await expect(body.locator('.ds-pad-wrap')).toHaveCount(0); // no Xbox diagram for a headset without a gamepad
    expect(errors).toEqual([]);
  });
});

test.describe('touch devices', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch devices only');

  async function passGate(page: Page): Promise<void> {
    const gate = page.locator('.ds-gate__btn');
    await expect(gate).toBeVisible();
    await gate.tap();
    await expect(gate).toBeHidden();
    const ok = page.locator('[data-sheet="ok"]');
    await page.waitForTimeout(300);
    if (await ok.isVisible()) await ok.tap();
  }

  test('Controls show the touch layout first with the ARM flow that matches the throttle setting', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await page.getByRole('button', { name: 'Controls' }).tap();
    const body = page.locator('.ds-screen--controls [data-f="body"]');
    const tip = body.locator('[data-f="touchTip"]');
    await expect(body.locator('[data-f="touchTable"]')).toBeVisible();
    await expect(tip).toContainText('springs back to centre');
    await expect(tip).toContainText('Tap ARM, then push the throttle up');
    await expect(body).not.toContainText('fully down, then press A');
    await expect(body.locator('[data-f="padTable"]')).toHaveCount(0); // gamepad section collapsed

    const more = page.locator('.ds-screen--controls [data-act="controls-more"]');
    await expect(more.locator('..')).toContainText('Controller ›'); // in the footer, beside the other nav buttons
    await more.tap();
    await expect(body.locator('[data-f="padTable"]')).toBeVisible();
    await expect(more).toHaveText('Hide gamepad ‹');
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    // Hold mode: the tip follows the setting
    await page.locator('.ds-screen--controls [data-act="back"]').tap();
    await page.getByRole('button', { name: 'Settings' }).tap();
    await page.locator('.ds-screen--settings [data-key="touchThrottleCentre"] [data-dir="1"]').tap();
    await page.locator('.ds-screen--settings [data-act="back"]').tap();
    await page.getByRole('button', { name: 'Controls' }).tap();
    await expect(tip).toContainText('holds where you let go');
    await expect(tip).toContainText('Pull it fully down, then tap ARM');
    expect(errors).toEqual([]);
  });

  test('main menu on a landscape phone: Quit fills its own row instead of a lone half cell', async ({ page }) => {
    await boot(page);
    await passGate(page);
    const quit = page.locator('.ds-screen--main [data-act="exit"]');
    test.skip(!(await quit.isVisible()), 'Quit hidden on this platform');
    const race = (await page.locator('.ds-screen--main [data-act="race"]').boundingBox())!;
    const q = (await quit.boundingBox())!;
    expect(Math.abs(q.width - race.width)).toBeLessThan(2);
    expect(errors).toEqual([]);
  });

  test('gamepad-only hints are hidden; Rates notes altitude hold for auto-centre touch throttle', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await page.getByRole('button', { name: 'Settings' }).tap();
    await page.getByRole('button', { name: 'Rates ›', exact: true }).tap();
    const rates = page.locator('.ds-screen--rates');
    await expect(rates.locator('[data-f="fine"]')).toBeHidden();
    await expect(rates.locator('[data-f="altHold"]')).toContainText("throttle mid, expo and limit don't apply");
    expect(errors).toEqual([]);
  });
});
