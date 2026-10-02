/**
 * Touch / mobile E2E. Runs on 'webkit-iphone' + 'webkit-ipad' (touch UI) and on desktop 'chromium'
 * (where the touch UI must stay hidden). Stick drags are synthetic PointerEvents (pointerType 'touch')
 * dispatched at real screen coordinates — WebKit has no CDP multi-touch — so they exercise the same
 * listeners as a finger. Buttons are tapped with Playwright's real touchscreen tap.
 */
import { expect, test, type Page } from '@playwright/test';

interface Track {
  cx: number;
  cy: number;
  x: number;
  y: number;
  holdsThrottle: boolean;
}
interface Hook {
  state: { position: { x: number; y: number; z: number }; velocity: { y: number } };
  race: { status: string };
  fps: number;
  tier: string;
  armed: boolean;
  camera: string;
  mode: string;
  screen: string;
  source: string;
  touchVisible: boolean;
  rotateOverlay: boolean;
  gateOpen: boolean;
  pixelRatio: number;
  renderScale: number;
  control: { throttle: number; pitch: number; roll: number; yaw: number } | null;
  device: { touch: boolean; form: string; ios: boolean; fullscreen: boolean; standalone: boolean };
  touch: { layer: HTMLElement | null; sticks: { opts: { radius: number }; l: Track; r: Track } };
  action: (a: { type: string }) => void;
  teleport: (x: number, y: number, z: number, yaw?: number) => void;
}

const errors: string[] = [];

async function boot(page: Page, path = '/'): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(path);
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 30_000 });
}

const hook = <T>(page: Page, fn: (d: Hook) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__drone)`) as Promise<T>;

/** Dismisses the "Tap to play" gate (and the Add-to-Home-Screen sheet if the fullscreen request was refused). */
async function passGate(page: Page): Promise<void> {
  const gate = page.locator('.ds-gate__btn');
  await expect(gate).toBeVisible();
  await gate.tap();
  await expect(gate).toBeHidden();
  const ok = page.locator('[data-sheet="ok"]');
  await page.waitForTimeout(300);
  if (await ok.isVisible()) await ok.tap();
}

/** Synthetic touch pointer event at viewport coordinates on whatever element is there. */
async function touch(page: Page, type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([type, id, x, y]) => {
      const target = document.elementFromPoint(x as number, y as number) ?? document.body;
      target.dispatchEvent(
        new PointerEvent(type as string, { pointerId: id as number, pointerType: 'touch', clientX: x as number, clientY: y as number, bubbles: true, cancelable: true, isPrimary: id === 1 }),
      );
    },
    [type, id, x, y] as const,
  );
}

/** Knob screen position of a stick (layer is full-viewport). */
async function knob(page: Page, side: 'l' | 'r'): Promise<{ x: number; y: number; R: number }> {
  return page.evaluate((side) => {
    const d = (window as unknown as { __drone: Hook }).__drone;
    const t = d.touch.sticks[side];
    const R = d.touch.sticks.opts.radius;
    return { x: t.cx + t.x * R, y: t.cy - t.y * R, R };
  }, side);
}

async function startFreeFly(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Free Fly' }).tap();
  await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.touchVisible, null, { timeout: 5000 });
}

test.describe('desktop (no touch)', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('touch UI, tap gate and rotate overlay never show on desktop', async ({ page }) => {
    await boot(page);
    expect(await hook(page, (d) => d.gateOpen)).toBe(false);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'freefly' }));
    await page.waitForTimeout(500);
    const s = await hook(page, (d) => ({ touch: d.device.touch, visible: d.touchVisible, source: d.source, rotate: d.rotateOverlay }));
    expect(s).toEqual({ touch: false, visible: false, source: 'none', rotate: false });
    await expect(page.locator('.ds-touch')).toHaveCount(0);
    await expect(page.locator('.ds-hud__br')).toBeVisible(); // stick visualiser stays on desktop
    expect(errors).toEqual([]);
  });
});

test.describe('touch devices', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch devices only');

  test('device detection, tier and tap gate → main menu by tap, no console errors', async ({ page }, info) => {
    await boot(page);
    const d = await hook(page, (d) => ({ ...d.device, tier: d.tier, dpr: d.pixelRatio }));
    const phone = info.project.name.includes('iphone');
    expect(d.touch).toBe(true);
    expect(d.ios).toBe(true);
    expect(d.form).toBe(phone ? 'phone' : 'tablet');
    expect(d.tier).toBe(phone ? 'medium' : 'high');
    expect(d.dpr).toBeLessThanOrEqual(phone ? 1.5 : 1.75);
    await passGate(page);
    expect(await hook(page, (d) => d.screen)).toBe('main');
    await expect(page.locator('.ds-foot').first()).toBeHidden(); // keyboard/gamepad hints hidden on touch
    // Settings by tap: touch rows are there, stepper arrows ≥ 44 px and change the value.
    await page.getByRole('button', { name: 'Settings' }).tap();
    const row = page.locator('.ds-screen--settings [data-key="touchThrottleCentre"]');
    await expect(row).toBeVisible();
    await expect(row.locator('.ds-row__value')).toHaveText('Auto-centre'); // MOBA-style default
    const arrow = row.locator('[data-dir="1"]');
    await page.waitForTimeout(500); // dialog rise animation scales the panel
    const box = (await arrow.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await arrow.tap();
    await expect(row.locator('.ds-row__value')).toHaveText('Hold');
    await arrow.tap();
    await expect(row.locator('.ds-row__value')).toHaveText('Auto-centre');
    await page.locator('.ds-screen--settings [data-act="back"]').tap();
    expect(await hook(page, (d) => d.screen)).toBe('main');
    expect(errors).toEqual([]);
  });

  test('touch sticks show in flight, HUD visualiser hidden, nothing overlaps the buttons', async ({ page }, info) => {
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    expect(await hook(page, (d) => d.source)).toBe('touch');
    await expect(page.locator('.ds-touch')).toBeVisible();
    await expect(page.locator('.ds-hud__br')).toBeHidden();
    for (const name of ['arm', 'toggleMode', 'cycleCamera', 'reset', 'pause']) {
      const b = (await page.locator(`[data-tbtn="${name}"]`).boundingBox())!;
      expect(b.width, name).toBeGreaterThanOrEqual(44);
      expect(b.height, name).toBeGreaterThanOrEqual(44);
    }
    // Buttons and visible HUD panels must not overlap each other.
    const rects = await page.evaluate(() => {
      const sel = ['[data-tbtn]', '.ds-hud__tl', '.ds-hud__tc .ds-gates', '.ds-hud__tr .ds-chip', '.ds-hud__bl'];
      const out: { n: string; l: number; t: number; r: number; b: number }[] = [];
      for (const s of sel) {
        document.querySelectorAll<HTMLElement>(s).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') out.push({ n: el.dataset.tbtn ?? el.className, l: r.left, t: r.top, r: r.right, b: r.bottom });
        });
      }
      return out;
    });
    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        if (a.n.includes('ds-chip') && b.n.includes('ds-chip')) continue;
        if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) overlaps.push(`${a.n} × ${b.n}`);
      }
    expect(overlaps).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`touch-hud-${info.project.name}.png`) });
  });

  test('race HUD, hint and toast never overlap the buttons; CAM keeps its width; layout survives the pause menu', async ({ page }, info) => {
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    const camW: number[] = [];
    for (let i = 0; i < 3; i++) {
      camW.push((await page.locator('[data-tbtn="cycleCamera"]').boundingBox())!.width);
      await page.locator('[data-tbtn="cycleCamera"]').tap();
    }
    expect(new Set(camW).size, `CAM widths ${camW}`).toBe(1);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'race' }));
    await page.waitForTimeout(3600);
    await page.evaluate(() => (window as unknown as { __drone: Hook & { toast: (t: string) => void } }).__drone.toast('Controller connected: Xbox Wireless Controller'));
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const sel = ['[data-tbtn]', '.ds-hud__tl', '.ds-hud__tc .ds-gates', '.ds-hud__tr', '.ds-hud__bl', '.ds-hint.is-on', '.ds-toast'];
      const out: { n: string; l: number; t: number; r: number; b: number }[] = [];
      for (const s of sel)
        document.querySelectorAll<HTMLElement>(s).forEach((el) => {
          const b = el.getBoundingClientRect();
          if (b.width > 0 && el.offsetParent && getComputedStyle(el).visibility !== 'hidden') out.push({ n: el.dataset.tbtn ?? s, l: b.left, t: b.top, r: b.right, b: b.bottom });
        });
      const hits: string[] = [];
      for (let i = 0; i < out.length; i++)
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i]!;
          const b = out[j]!;
          if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) hits.push(`${a.n} × ${b.n}`);
        }
      return { hits, names: out.map((o) => o.n), chips: document.querySelector('.ds-hud__tr')!.getBoundingClientRect().height };
    });
    expect(r.names).toEqual(expect.arrayContaining(['.ds-hud__tc .ds-gates', '.ds-hint.is-on', '.ds-toast']));
    expect(r.hits).toEqual([]);
    expect(r.chips).toBeLessThanOrEqual(30); // one row of chips
    await page.screenshot({ path: test.info().outputPath(`race-hud-${info.project.name}.png`) });
    await page.locator('[data-tbtn="pause"]').tap();
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('pause');
    await expect(page.locator('.ds-ui')).toHaveClass(/ds-touch-on/); // dimmed HUD keeps the touch layout
    await expect(page.locator('.ds-touch')).toBeHidden();
    await expect(page.locator('.ds-hud__br')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('rates steppers fit their cells and the table stays inside the dialog', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await page.evaluate(() => (window as unknown as { __drone: { showScreen: (s: string) => void } }).__drone.showScreen('rates'));
    await page.waitForTimeout(600);
    const bad = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll<HTMLElement>('.ds-screen--rates .ds-cell').forEach((c) => {
        const cr = c.getBoundingClientRect();
        c.querySelectorAll<HTMLElement>('.ds-arrow').forEach((a) => {
          const ar = a.getBoundingClientRect();
          if (ar.width < 44 || ar.left < cr.left - 0.5 || ar.right > cr.right + 0.5) out.push(c.dataset.key!);
        });
      });
      const t = document.querySelector('.ds-screen--rates .ds-rtable')!.getBoundingClientRect();
      const d = document.querySelector('.ds-screen--rates .ds-dialog')!.getBoundingClientRect();
      if (t.right > d.right + 0.5) out.push('table past dialog');
      return out;
    });
    expect(bad).toEqual([]);
  });

  // Audit device widths: the ones the project's own viewport doesn't cover are emulated by resizing.
  const PHONE_VIEWS = [
    { width: 568, height: 320 },
    { width: 734, height: 343 },
    { width: 863, height: 360 },
  ];
  const TABLET_VIEWS = [
    { width: 1024, height: 768 },
    { width: 1138, height: 712 },
    { width: 1194, height: 834 },
    { width: 834, height: 1194 },
  ];
  const views = (project: string) => (project.includes('iphone') ? PHONE_VIEWS : TABLET_VIEWS);
  const showScreen = (page: Page, s: string) =>
    page.evaluate((s) => (window as unknown as { __drone: { showScreen: (s: string) => void } }).__drone.showScreen(s), s);

  test('rates: the stepper table never runs into the chart column at any audit width', async ({ page }, info) => {
    await boot(page);
    await passGate(page);
    await showScreen(page, 'rates');
    for (const vp of views(info.project.name)) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        const [a, b] = [...document.querySelectorAll<HTMLElement>('.ds-screen--rates .ds-ctl__col')].map((c) => c.getBoundingClientRect());
        const cells = [...document.querySelectorAll<HTMLElement>('.ds-screen--rates .ds-cell')].map((c) => c.getBoundingClientRect());
        const right = Math.max(...cells.map((c) => c.right));
        const bottom = Math.max(...cells.map((c) => c.bottom));
        const sideBySide = b!.top < a!.bottom - 1;
        // charts beside the table: every cell ends left of them; stacked: the charts start below the cells
        return { sideBySide, clash: sideBySide ? right - b!.left : bottom - b!.top, pastCol: right - a!.right };
      });
      expect(r.clash, `${vp.width}×${vp.height} ${JSON.stringify(r)}`).toBeLessThanOrEqual(-8);
      expect(r.pastCol, `${vp.width}×${vp.height}`).toBeLessThanOrEqual(0.5);
    }
  });

  test('settings on tablets: hints wrap instead of being cut off; the footer stays on one row', async ({ page }, info) => {
    test.skip(info.project.name.includes('iphone'), 'tablets only (phones hide hints)');
    await boot(page);
    await passGate(page);
    await showScreen(page, 'settings');
    // Android Chrome shows Full screen too (WebKit has no element fullscreen): the four-button footer is the one that wrapped.
    await page.evaluate(() => document.querySelectorAll<HTMLElement>('.ds-screen--settings [data-fs-only]').forEach((b) => (b.hidden = false)));
    for (const vp of TABLET_VIEWS) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        const hints = [...document.querySelectorAll<HTMLElement>('.ds-screen--settings .ds-row__hint')].filter((h) => h.offsetParent);
        const clipped = hints.filter((h) => h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1).map((h) => h.textContent!.slice(0, 24));
        const acts = [...document.querySelectorAll<HTMLElement>('.ds-screen--settings .ds-dialog__actions')].pop()!;
        const rows = new Set([...acts.querySelectorAll<HTMLElement>('.ds-btn')].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().top)));
        return { shown: hints.length, clipped, rows: rows.size };
      });
      expect(r.shown, `${vp.width}×${vp.height}`).toBeGreaterThan(0);
      expect(r.clipped, `${vp.width}×${vp.height}`).toEqual([]);
      expect(r.rows, `${vp.width}×${vp.height}`).toBe(1);
    }
  });

  test('tap gate copy fits the form factor (tablets fly in portrait too)', async ({ page }, info) => {
    await boot(page);
    const sub = page.locator('.ds-gate__sub');
    if (info.project.name.includes('iphone')) await expect(sub).toContainText('Landscape');
    else await expect(sub).not.toContainText('Landscape');
    await expect(sub).toContainText('two thumbs', { ignoreCase: true });
  });

  test('phone HUD: micro labels ≥ 9 px, CRASHED and toasts clear the buttons, toasts centred on ≤ 2 lines', async ({ page }, info) => {
    test.skip(!info.project.name.includes('iphone'), 'phones only');
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'race' }));
    await page.waitForTimeout(3600);
    const msg = 'Controller connected: Xbox Wireless Controller';
    // one toast at a time: stacked repeats would push the newest one down onto the telemetry panel
    const toast = (page: Page) =>
      page.evaluate((m) => {
        document.querySelectorAll('.ds-toast').forEach((t) => t.remove());
        (window as unknown as { __drone: { toast: (t: string) => void } }).__drone.toast(m);
      }, msg);
    const measure = () =>
      page.evaluate((m) => {
        const gap = (a: DOMRect, b: DOMRect) => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
        const blockers = [...document.querySelectorAll<HTMLElement>('[data-tbtn], .ds-hud__tl, .ds-hud__tc .ds-gates, .ds-hud__tr, .ds-hud__bl')]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none')
          .map((e) => e.getBoundingClientRect());
        const small = [...document.querySelectorAll<HTMLElement>('.ds-hud .ds-label, .ds-hud .ds-unit, .ds-tbtn small')]
          .filter((e) => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 9)
          .map((e) => `${e.textContent} ${getComputedStyle(e).fontSize}`);
        const t = [...document.querySelectorAll<HTMLElement>('.ds-toast')].filter((x) => x.textContent === m).pop();
        let tr = null;
        if (t) {
          const r = t.getBoundingClientRect();
          const cs = getComputedStyle(t);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
          tr = {
            off: Math.abs((r.left + r.right) / 2 - innerWidth / 2),
            lines: Math.round((t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh),
            gap: Math.min(...blockers.map((b) => gap(r, b))),
          };
        }
        const big = document.querySelector<HTMLElement>('.ds-center__big.is-crash');
        let crash = null;
        if (big && big.textContent) {
          const rg = document.createRange();
          rg.selectNodeContents(big);
          const ink = rg.getBoundingClientRect();
          crash = Math.min(...blockers.map((b) => gap(ink, b)));
          if (t) crash = Math.min(crash, gap(ink, t.getBoundingClientRect()));
        }
        return { small, tr, crash };
      }, msg);
    for (const vp of [page.viewportSize()!, ...PHONE_VIEWS]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(300);
      await toast(page);
      await page.waitForTimeout(450);
      const m = await measure();
      const at = `${vp.width}×${vp.height} ${JSON.stringify(m)}`;
      expect(m.small, at).toEqual([]);
      expect(m.tr!.off, at).toBeLessThanOrEqual(1);
      expect(m.tr!.lines, at).toBeLessThanOrEqual(2);
      expect(m.tr!.gap, at).toBeGreaterThanOrEqual(10);
    }
    for (const vp of PHONE_VIEWS) {
      await page.setViewportSize(vp);
      await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 5000 }).not.toBe('crashed');
      await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.teleport(-9, 4.5, 5.8, 0));
      await expect.poll(() => hook(page, (d) => d.race.status), { timeout: 5000 }).toBe('crashed');
      await toast(page);
      await page.waitForTimeout(400);
      const m = await measure();
      const at = `crashed ${vp.width}×${vp.height} ${JSON.stringify(m)}`;
      expect(m.crash, at).toBeGreaterThanOrEqual(10);
      expect(m.tr!.off, at).toBeLessThanOrEqual(1);
      expect(m.tr!.gap, at).toBeGreaterThanOrEqual(10);
    }
    expect(errors).toEqual([]);
  });

  for (const end of ['bye', 'error'] as const) {
    test(`${end} screen: sticks and touch buttons are gone, the card is centred`, async ({ page }) => {
      await boot(page);
      await passGate(page);
      await startFreeFly(page);
      await expect(page.locator('[data-tbtn="arm"]')).toBeVisible();
      await page.evaluate((end) => {
        const d = (window as unknown as { __drone: { showScreen: (s: string) => void; showError: (m: string) => void } }).__drone;
        if (end === 'error') d.showError('WebGL2 is not available on this device/browser (context lost).');
        else d.showScreen('bye');
      }, end);
      await page.waitForTimeout(500);
      // also when the frame loop that normally hides the layer has stopped (fatal error)
      await page.evaluate(() => document.querySelector('.ds-touch')!.classList.add('is-on'));
      for (const sel of ['.ds-touch', '[data-tbtn="arm"]', '[data-tbtn="pause"]', '.ds-tstick__base']) await expect(page.locator(sel).first(), sel).toBeHidden();
      const vp = page.viewportSize()!;
      const card = (await page.locator(`.ds-screen--${end}.is-open .ds-panel, .ds-screen--${end}.is-open .ds-dialog`).first().boundingBox())!;
      if (card.height < vp.height - 24) expect(Math.abs(card.y + card.height / 2 - vp.height / 2), `${end} card centre`).toBeLessThan(4);
    });
  }

  test('Add-to-Home-Screen sheet names the device and is a centred modal', async ({ page }, info) => {
    await boot(page);
    // Fullscreen is refused in Playwright WebKit, so the gate tap offers the sheet on iOS.
    await page.locator('.ds-gate__btn').tap();
    const sheet = page.locator('.ds-sheet');
    await expect(sheet).toBeVisible();
    const device = info.project.name.includes('ipad') ? 'iPad' : 'iPhone';
    await expect(sheet.locator('p').first()).toContainText(`Safari on ${device}`);
    await page.waitForTimeout(450); // rise animation
    const vp = page.viewportSize()!;
    const card = (await sheet.locator('.ds-sheet__card').boundingBox())!;
    expect(Math.abs(card.y + card.height / 2 - vp.height / 2)).toBeLessThan(4);
    await expect(page.locator('[data-sheet="ok"]')).toBeFocused();
    await page.locator('[data-sheet="ok"]').tap();
    await expect(sheet).toBeHidden();
  });

  test('default auto-centre stick: rest → ARM, push up takes off, release hovers (stick returns to centre)', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    const thr = await knob(page, 'l');
    expect(await hook(page, (d) => d.control!.throttle)).toBe(0); // take-off latch: idle at rest
    await page.locator('[data-tbtn="arm"]').tap();
    await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.armed, null, { timeout: 2000 });
    await page.waitForTimeout(500);
    expect(await hook(page, (d) => d.state.position.y)).toBeLessThan(0.1); // armed, still on the ground
    await touch(page, 'pointerdown', 1, thr.x, thr.y);
    await touch(page, 'pointermove', 1, thr.x, thr.y - thr.R * 0.7); // push up
    await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.state.position.y > 1, null, { timeout: 4000 });
    await touch(page, 'pointerup', 1, thr.x, thr.y - thr.R * 0.7); // let go
    await page.waitForTimeout(100);
    expect(await hook(page, (d) => d.control!.throttle)).toBeCloseTo(0.5, 1); // centre = hover
    const y0 = await hook(page, (d) => d.state.position.y);
    await page.waitForTimeout(1500);
    const y1 = await hook(page, (d) => d.state.position.y);
    expect(await hook(page, (d) => d.armed)).toBe(true);
    expect(Math.abs(y1 - y0)).toBeLessThan(0.3); // altitude hold: stick centred = holds height
    expect(y1).toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
  });

  test('auto-centre stick pushed and released while disarmed still lets ARM through', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    const thr = await knob(page, 'l');
    await touch(page, 'pointerdown', 1, thr.x, thr.y);
    await touch(page, 'pointermove', 1, thr.x, thr.y - thr.R * 0.7);
    await page.waitForTimeout(100);
    expect(await hook(page, (d) => d.control!.throttle)).toBeGreaterThan(0.5); // latch released by the push
    await touch(page, 'pointerup', 1, thr.x, thr.y - thr.R * 0.7);
    await page.waitForTimeout(100);
    expect(await hook(page, (d) => d.control!.throttle)).toBe(0); // springing stick re-latched at idle
    await page.locator('[data-tbtn="arm"]').tap();
    await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.armed, null, { timeout: 2000 });
    expect(errors).toEqual([]);
  });

  test('two-thumb flight (hold-throttle mode): throttle down + ARM tap arms, throttle up climbs, pitch stick moves forward', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ v: 2, touchThrottleCentre: false })));
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    const thr = await knob(page, 'l'); // mode 2: throttle on the left
    expect(await page.locator('.ds-tstick[data-side="l"]').getAttribute('class')).toContain('is-thr');
    await touch(page, 'pointerdown', 1, thr.x, thr.y);
    await touch(page, 'pointermove', 1, thr.x, thr.y + 10); // already at the bottom: stays 0
    await page.locator('[data-tbtn="arm"]').tap();
    await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.armed, null, { timeout: 2000 });
    // Second finger on the right stick while the first holds throttle.
    await touch(page, 'pointermove', 1, thr.x, thr.y - thr.R * 1.4); // throttle ≈ 0.7
    await page.waitForTimeout(150);
    expect(await hook(page, (d) => d.control!.throttle)).toBeGreaterThan(0.6);
    await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.state.position.y > 0.8, null, { timeout: 3000 });
    await touch(page, 'pointermove', 1, thr.x, thr.y - thr.R); // centre ≈ hover
    await page.waitForTimeout(300);
    expect(await hook(page, (d) => [d.race.status, d.armed])).toEqual(['freefly', true]);
    const p0 = await hook(page, (d) => ({ x: d.state.position.x, z: d.state.position.z }));
    const pit = await knob(page, 'r');
    await touch(page, 'pointerdown', 2, pit.x, pit.y);
    await touch(page, 'pointermove', 2, pit.x, pit.y - pit.R * 0.4);
    await page.waitForTimeout(100);
    const c = await hook(page, (d) => d.control!);
    expect(c.pitch).toBeGreaterThan(0.3);
    expect(c.throttle).toBeGreaterThan(0.4); // first finger still holds throttle
    await page.waitForTimeout(1200);
    await touch(page, 'pointerup', 2, pit.x, pit.y);
    const p1 = await hook(page, (d) => ({ x: d.state.position.x, z: d.state.position.z }));
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeGreaterThan(0.3);
    await touch(page, 'pointerup', 1, thr.x, thr.y);
    await page.waitForTimeout(100); // next frame polls the release
    expect(await hook(page, (d) => d.control!.pitch)).toBe(0);
    expect(await hook(page, (d) => d.control!.throttle)).toBeGreaterThan(0.4); // non-centering: held
    expect(errors).toEqual([]);
  });

  test('stick mode 1 puts the throttle on the right thumb', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ stickMode: 1 })));
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    expect(await page.locator('.ds-tstick[data-side="r"]').getAttribute('class')).toContain('is-thr');
    const r = await knob(page, 'r');
    await touch(page, 'pointerdown', 5, r.x, r.y);
    await touch(page, 'pointermove', 5, r.x, r.y - r.R * 2);
    await page.waitForTimeout(80);
    expect(await hook(page, (d) => d.control!.throttle)).toBe(1);
    const l = await knob(page, 'l');
    await touch(page, 'pointerdown', 6, l.x, l.y);
    await touch(page, 'pointermove', 6, l.x, l.y - l.R);
    await page.waitForTimeout(80);
    expect(await hook(page, (d) => d.control!.pitch)).toBe(1);
    await touch(page, 'pointerup', 5, 0, 0);
    await touch(page, 'pointerup', 6, 0, 0);
  });

  test('MODE, CAM, RESET and PAUSE buttons work by tap', async ({ page }) => {
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    const mode0 = await hook(page, (d) => d.mode);
    await page.locator('[data-tbtn="toggleMode"]').tap();
    await expect.poll(() => hook(page, (d) => d.mode)).not.toBe(mode0);
    await page.locator('[data-tbtn="toggleMode"]').tap();
    await expect.poll(() => hook(page, (d) => d.mode)).toBe(mode0);
    await page.locator('[data-tbtn="cycleCamera"]').tap();
    await expect.poll(() => hook(page, (d) => d.camera)).toBe('fpv');
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.teleport(0, 3, 0, 0));
    await page.locator('[data-tbtn="reset"]').tap();
    await expect.poll(() => hook(page, (d) => Math.hypot(d.state.position.x + 9, d.state.position.z - 5.8))).toBeLessThan(0.3);
    await page.locator('[data-tbtn="pause"]').tap();
    await expect.poll(() => hook(page, (d) => d.screen)).toBe('pause');
    expect(await hook(page, (d) => d.touchVisible)).toBe(false);
    await page.locator('.ds-screen--pause [data-act="resume"]').tap();
    await expect.poll(() => hook(page, (d) => [d.screen, d.touchVisible])).toEqual(['none', true]);
    expect(errors).toEqual([]);
  });

  test('portrait on a phone shows the rotate overlay and pauses; landscape returns to the pause menu', async ({ page }, info) => {
    test.skip(!info.project.name.includes('iphone'), 'phones only');
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    const land = page.viewportSize()!;
    await page.setViewportSize({ width: land.height, height: land.width });
    await expect(page.locator('.ds-rotate')).toBeVisible();
    await expect.poll(() => hook(page, (d) => [d.rotateOverlay, d.race.status])).toEqual([true, 'paused']);
    await page.screenshot({ path: test.info().outputPath('rotate-overlay.png') });
    await page.setViewportSize(land);
    await expect(page.locator('.ds-rotate')).toBeHidden();
    expect(await hook(page, (d) => d.screen)).toBe('pause');
    expect(errors).toEqual([]);
  });

  test('frame rate sample', async ({ page }, info) => {
    await boot(page);
    await passGate(page);
    await startFreeFly(page);
    await page.waitForTimeout(3000);
    const r = await hook(page, (d) => ({ fps: d.fps, tier: d.tier, dpr: d.pixelRatio, scale: d.renderScale }));
    info.annotations.push({ type: 'fps', description: `${r.fps.toFixed(1)} fps · ${r.tier} · dpr ${r.dpr} · scale ${r.scale}` });
    console.log(`[${info.project.name}] fps ${r.fps.toFixed(1)} tier ${r.tier} dpr ${r.dpr} scale ${r.scale}`);
    expect(r.fps).toBeGreaterThan(10);
  });

  test('?selftest=1 flies the scripted touch flight and reports PASS', async ({ page }, info) => {
    await boot(page, '/?selftest=1');
    await page.waitForFunction(() => (window as unknown as { __selftest?: { done: boolean } }).__selftest?.done, null, { timeout: 30_000 });
    const r = await page.evaluate(() => (window as unknown as { __selftest: { pass: boolean; fps: number; checks: { name: string; ok: boolean; detail: string; soft?: boolean }[] } }).__selftest);
    console.log(`[${info.project.name}] selftest ${r.pass ? 'PASS' : 'FAIL'} fps ${r.fps.toFixed(1)}: ${r.checks.map((c) => `${c.name}=${c.detail}`).join('; ')}`);
    await page.screenshot({ path: test.info().outputPath('selftest.png') });
    expect(r.checks.filter((c) => !c.ok && !c.soft)).toEqual([]);
    expect(r.pass).toBe(true);
  });
});
