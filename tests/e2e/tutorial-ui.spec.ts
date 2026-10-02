import { expect, test, type Locator, type Page } from '@playwright/test';

/** Tutorial overlay on the dev harness (see playwright.tutorial.config.ts). */

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/tutorial-shots';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

async function open(page: Page, query: string): Promise<Locator> {
  await page.goto(`/tutorial-preview.html?${query}`);
  // the HUD fades in from the menu state: screenshots wait for it
  await expect(page.locator('.ds-hud')).toHaveCSS('opacity', '1');
  const card = page.locator('.ds-tut-card');
  return card;
}

/** The card sits inside the viewport, its text does not overflow, and it keeps clear of the given HUD parts. */
async function expectCardLayout(page: Page, card: Locator, avoid: string[]): Promise<void> {
  await expect(card).toBeVisible();
  const vp = page.viewportSize()!;
  const c = await box(card);
  expect(c.x).toBeGreaterThanOrEqual(0);
  expect(c.y).toBeGreaterThanOrEqual(0);
  expect(c.x + c.width).toBeLessThanOrEqual(vp.width);
  expect(c.y + c.height).toBeLessThanOrEqual(vp.height);
  const overflow = await card.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('*')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
  );
  expect(overflow).toEqual([]);
  for (const sel of avoid) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      expect(overlaps(c, await box(el)), `card overlaps ${sel}`).toBe(false);
    }
  }
}

test.describe('desktop (keyboard / gamepad)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'desktop layout runs on chromium');

  for (const [w, h] of [
    [1280, 720],
    [1440, 900],
    [2560, 1440],
  ] as const) {
    test(`step card at ${w}×${h}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      const card = await open(page, 'step=6&source=keyboard');
      await expectCardLayout(page, card, ['.ds-hud__tl', '.ds-hud__tc', '.ds-hud__tr', '.ds-hud__br', '.ds-hud__bl', '.ds-cmap']);
      await expect(card.locator('.ds-tut-card__step')).toHaveText('Step 6 / 12');
      await expect(card.locator('.ds-tut-part')).toHaveCount(4);
      await expect(card.locator('.ds-tut-part.is-done')).toHaveCount(1);
      await page.screenshot({ path: `${SHOTS}/desktop-${w}x${h}-step6.png` });
    });
  }

  test('hint glows the throttle stick well (mode 2: left, mode 1: right)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await open(page, 'step=4&source=gamepad&hint=1');
    await expect(card).toHaveClass(/is-hint/);
    await expect(page.locator('[data-r="wellL"]')).toHaveClass(/ds-tut-glow/);
    await expect(page.locator('[data-r="wellR"]')).not.toHaveClass(/ds-tut-glow/);
    await page.screenshot({ path: `${SHOTS}/desktop-hint-mode2.png` });
    await open(page, 'step=4&source=gamepad&hint=1&mode=1');
    await expect(page.locator('[data-r="wellR"]')).toHaveClass(/ds-tut-glow/);
    await expect(page.locator('[data-r="wellL"]')).not.toHaveClass(/ds-tut-glow/);
  });

  test('welcome card: Continue button, keyboard copy, skip hint', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await open(page, 'step=1&source=keyboard');
    await expect(card.locator('.ds-tut-card__lines p').first()).toHaveText('Throttle W / S · Yaw A / D · Pitch ↑ / ↓ · Roll ← / →');
    await expect(card.locator('.ds-tut-card__skiphint')).toHaveText('Esc to skip');
    await card.locator('.ds-tut-continue').click();
    await card.locator('.ds-tut-skip').click();
    expect(await page.evaluate(() => window.__tutorialPreview!.log)).toEqual(['confirm', 'skip']);
    await page.screenshot({ path: `${SHOTS}/desktop-welcome.png` });
  });

  test('first-run prompt: Start focused, Tab stays inside, Skip / Start report back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'prompt=1');
    const dlg = page.getByRole('dialog', { name: 'New to FPV?' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Start' })).toBeFocused();
    await page.screenshot({ path: `${SHOTS}/desktop-prompt.png` });
    await page.keyboard.press('Tab');
    await expect(dlg.getByRole('button', { name: 'Skip' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dlg.getByRole('button', { name: 'Start' })).toBeFocused();
    await dlg.getByRole('button', { name: 'Skip' }).click();
    await expect(dlg).toBeHidden();
    expect(await page.evaluate(() => window.__tutorialPreview!.log)).toEqual(['skip']);
  });

  test('completion card: Start Training / Menu', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await open(page, 'step=12&source=keyboard');
    const dlg = page.getByRole('dialog', { name: 'Tutorial complete' });
    await expect(dlg).toBeVisible();
    await expect(card).toBeHidden();
    await expect(dlg.getByRole('button', { name: 'Start Training' })).toBeFocused();
    await page.screenshot({ path: `${SHOTS}/desktop-done.png` });
    await dlg.getByRole('button', { name: 'Start Training' }).click();
    await expect(dlg).toBeHidden();
    expect(await page.evaluate(() => window.__tutorialPreview!.log)).toEqual(['finish:training']);
  });

  test('VR card mock (XrPanel layout) for a flight step and a hint', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'step=5&source=xr');
    await page.screenshot({ path: `${SHOTS}/desktop-xr-step5.png` });
    await open(page, 'step=3&source=xr&hint=1&armed=0');
    await page.screenshot({ path: `${SHOTS}/desktop-xr-step3-hint.png` });
  });

  test('reduced motion: the hint glow does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await open(page, 'step=4&source=keyboard&hint=1');
    await expect(card).toHaveClass(/is-hint/);
    expect(await card.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });
});

test.describe('phone (touch)', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'touch layout runs on the iPhone profile');

  test('step card clears the touch buttons and the timer row; ARM glows on the arm hint', async ({ page }) => {
    const card = await open(page, 'step=2&source=touch&hint=1');
    await expect(page.locator('.ds-ui')).toHaveClass(/ds-touch-on/);
    await expectCardLayout(page, card, ['.ds-tbtn', '.ds-hud__tl', '.ds-hud__tr']);
    await expect(page.locator('[data-tbtn="arm"]')).toHaveClass(/ds-tut-glow/);
    await expect(card.locator('.ds-tut-card__lines p').first()).toContainText(/tap ARM/i);
    const skip = await box(card.locator('.ds-tut-skip'));
    expect(skip.width).toBeGreaterThanOrEqual(44);
    expect(skip.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `${SHOTS}/phone-step2-hint.png` });
  });

  test('sub-goal chips fit on a phone', async ({ page }) => {
    const card = await open(page, 'step=6&source=touch');
    await expectCardLayout(page, card, ['.ds-tbtn', '.ds-hud__tl', '.ds-hud__tr']);
    await page.screenshot({ path: `${SHOTS}/phone-step6.png` });
  });

  test('welcome Continue is a 44 px target and reports a confirm', async ({ page }) => {
    const card = await open(page, 'step=1&source=touch');
    await expectCardLayout(page, card, ['.ds-tbtn', '.ds-hud__tl', '.ds-hud__tr']);
    const cont = card.locator('.ds-tut-continue');
    expect((await box(cont)).height).toBeGreaterThanOrEqual(44);
    await cont.tap();
    expect(await page.evaluate(() => window.__tutorialPreview!.log)).toEqual(['confirm']);
    await page.screenshot({ path: `${SHOTS}/phone-welcome.png` });
  });

  // Every touch control the card could cover. Stick bases grow by the hint glow's outline (2 × 3 px at --ds-u ≈ 1).
  const TOUCH_PARTS: readonly [selector: string, pad: number][] = [
    ['.ds-tstick__base', 8],
    ['.ds-tstick__knob', 0],
    ['.ds-tstick__lbl', 0],
    ['.ds-tbtn', 8],
    ['.ds-hud__tl', 0],
    ['.ds-hud__tr', 0],
    ['.ds-hud__bl', 0],
    ['.ds-hint.is-on', 0],
  ];
  const STATES = ['step=1', 'step=2&hint=1', 'step=3&armed=0', 'step=3&armed=0&hint=1', 'step=4&hint=1', 'step=6', 'step=6&hint=1', 'step=9&hint=1', 'step=11'];

  for (const [label, size] of [
    ['iPhone landscape', null],
    ['iPhone SE landscape', { width: 667, height: 375 }],
    ['iPad landscape', { width: 1180, height: 820 }],
  ] as const) {
    for (const mode of [2, 1]) {
      test(`card never overlaps a touch control: ${label}, mode ${mode}`, async ({ page }) => {
        if (size) await page.setViewportSize(size);
        for (const state of STATES) {
          const card = await open(page, `${state}&source=touch&mode=${mode}`);
          await expect(page.locator('.ds-ui')).toHaveClass(/ds-touch-on/);
          await expect(card).toBeVisible();
          const c = await box(card);
          let checked = 0;
          for (const [sel, pad] of TOUCH_PARTS) {
            for (const el of await page.locator(sel).all()) {
              if (!(await el.isVisible())) continue;
              const b = await box(el);
              const grown = { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
              expect(overlaps(c, grown), `${state}: card ${JSON.stringify(c)} overlaps ${sel} ${JSON.stringify(grown)}`).toBe(false);
              checked++;
            }
          }
          // both stick bases, both labels, five buttons at least: an empty selector list must not pass
          expect(checked, state).toBeGreaterThanOrEqual(9);
          const small = await card.evaluate((el) =>
            [...el.querySelectorAll<HTMLElement>('p, h2, h3, span, button')]
              .filter((e) => e.offsetParent && e.textContent?.trim() && Number.parseFloat(getComputedStyle(e).fontSize) < 12)
              .map((e) => `${e.className}:${getComputedStyle(e).fontSize}`),
          );
          expect(small, `${state}: text under 12 px`).toEqual([]);
          // the step label stays on one line (a narrow card used to break "STEP 1 / 12" over three)
          const stepLines = await card.locator('.ds-tut-card__step').evaluate((el) => el.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(el).fontSize));
          expect(stepLines, `${state}: step label wraps`).toBeLessThan(2);
        }
        await page.screenshot({ path: `${SHOTS}/touch-${label.replace(/\W+/g, '-')}-mode${mode}-last.png` });
      });
    }
  }

  test('first-run prompt and completion card fit a phone', async ({ page }) => {
    await open(page, 'prompt=1&source=touch');
    const dlg = page.getByRole('dialog', { name: 'New to FPV?' });
    await expect(dlg).toBeVisible();
    const vp = page.viewportSize()!;
    const d = await box(dlg.locator('.ds-dialog'));
    expect(d.y + d.height).toBeLessThanOrEqual(vp.height);
    await page.screenshot({ path: `${SHOTS}/phone-prompt.png` });
    await open(page, 'step=12&source=touch');
    await expect(page.getByRole('dialog', { name: 'Tutorial complete' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/phone-done.png` });
  });
});
