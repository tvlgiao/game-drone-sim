/**
 * Worlds UI on the dev harness (worlds-preview.html: the real Hud / Menus with a recording onAction in place of
 * main.ts): five level cards, Infinite Free Fly / Worlds…, the Worlds screen (new world, seed field, rename,
 * delete with confirmation, share → clipboard), keyboard navigation, and the outdoor HUD (compass, minimap, units).
 * Run: `npx playwright test -c playwright.worlds-ui.config.ts`.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

interface Hook {
  actions: { type: string; id?: string; mode?: string; seed?: number; gen?: number }[];
  toasts: string[];
  screen: string;
  show: (s: string) => void;
  pad: (k: 'up' | 'down' | 'left' | 'right' | 'back') => void;
  setSettings: (p: Record<string, unknown>) => void;
  xrPause: () => { kicker?: string };
}
interface Saved {
  last: string | null;
  worlds: { id: string; name: string; seed: number }[];
}

const SHOTS = process.env.SHOTS_DIR;
const errors: string[] = [];

async function open(page: Page, query: string): Promise<void> {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const touch = test.info().project.use.isMobile ? '&touch=1' : '';
  await page.goto(`/worlds-preview.html?${query}${touch}`);
  await page.waitForFunction(() => !!(window as unknown as { __worldsUi?: unknown }).__worldsUi);
  // the screens rise in
  await page.waitForTimeout(500);
}

const hook = <T>(page: Page, fn: (h: Hook) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__worldsUi)`) as Promise<T>;
const saved = (page: Page): Promise<Saved> => page.evaluate(() => JSON.parse(localStorage.getItem('drone-sim.worlds.v1') ?? '{"last":null,"worlds":[]}') as Saved);

async function press(page: Page, name: string | RegExp, scope = page.locator('.ds-screen.is-open')): Promise<void> {
  const b = scope.getByRole('button', { name, exact: typeof name === 'string' }).first();
  if (test.info().project.use.isMobile) await b.tap();
  else await b.click();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png` });
}

/** The open dialog never scrolls sideways and fits the viewport width. */
async function noSideScroll(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const d = document.querySelector<HTMLElement>('.ds-screen.is-open > .ds-dialog')!;
    return { right: d.getBoundingClientRect().right, vw: window.innerWidth, sw: d.scrollWidth, cw: d.clientWidth };
  });
  expect(r.right).toBeLessThanOrEqual(r.vw + 0.5);
  expect(r.sw).toBeLessThanOrEqual(r.cw + 1);
}

test('level select: five cards with drawn thumbnails; Infinite offers Free Fly and Worlds…', async ({ page }) => {
  await open(page, 'screen=levels&worlds=3');
  const cards = page.locator('.ds-screen--levels .ds-lvl');
  await expect(cards).toHaveCount(5);
  await expect(cards).toHaveText([/Training Field/, /Night Loft/, /City/, /Alpine Valley/, /Infinite World/]);
  for (const id of ['training', 'night-loft', 'city', 'alpine', 'infinite']) {
    const variety = await page.evaluate((id) => {
      const c = document.querySelector<HTMLCanvasElement>(`canvas[data-thumb="${id}"]`)!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
      return seen.size / (d.length / (4 * 97));
    }, id);
    expect(variety, id).toBeGreaterThan(0.05);
  }
  const inf = cards.nth(4);
  await expect(inf.locator('[data-act]')).toHaveText(['Free Fly', 'Worlds…']);
  const last = (await saved(page)).last!;
  await expect(inf.locator('.ds-lvl__note')).toHaveText(`Last world · ${last}`);
  await noSideScroll(page);
  await shot(page, 'levels');
  // the Infinite card's Free Fly continues the last world
  await inf.locator('[data-act="level-freefly:infinite"]').scrollIntoViewIfNeeded();
  await press(page, 'Free Fly · Infinite World', inf);
  const a = (await hook(page, (h) => h.actions)).at(-1)!;
  const w = (await saved(page)).worlds.find((x) => x.id === last)!;
  expect(a).toEqual({ type: 'level', id: 'infinite', mode: 'freefly', seed: w.seed, gen: 1 });
  expect(errors).toEqual([]);
});

test('Worlds…: new random world plays and is saved; empty state first', async ({ page }) => {
  await open(page, 'screen=levels&fresh=1');
  await expect(page.locator('.ds-screen--levels .ds-lvl__note')).toHaveText('Free Fly starts a new random world');
  await page.locator('[data-act="level-worlds:infinite"]').scrollIntoViewIfNeeded();
  await press(page, 'Worlds · Infinite World');
  await expect.poll(() => hook(page, (h) => h.screen)).toBe('worlds');
  await expect(page.locator('.ds-worlds__empty')).toBeVisible();
  await expect(page.locator('.ds-worlds__list')).toBeHidden();
  await shot(page, 'worlds-empty');
  await press(page, /New random world/);
  const a = (await hook(page, (h) => h.actions)).at(-1)!;
  expect(a).toMatchObject({ type: 'level', id: 'infinite', mode: 'freefly', gen: 1 });
  const s = await saved(page);
  expect(s.worlds).toHaveLength(1);
  expect(s.worlds[0]!.seed).toBe(a.seed);
  expect(s.last).toBe(s.worlds[0]!.id);
  expect(errors).toEqual([]);
});

test('seed field: live validation, typos rejected, codes and words play', async ({ page }) => {
  await open(page, 'screen=worlds&worlds=2');
  const field = page.locator('#ds-world-seed');
  const status = page.locator('[data-f="seedStatus"]');
  const go = page.locator('[data-act="world-go"]');
  await field.fill('K7Q2-9XM');
  await expect(status).toHaveAttribute('data-tone', 'idle');
  await expect(go).toBeDisabled();
  await field.fill('K7Q2-9XMU');
  await expect(status).toHaveText('“U” is not used in world codes — check the code');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(go).toBeDisabled();
  // a known-good code: the first saved world's, with one character changed
  const code = (await saved(page)).worlds[0]!.id;
  const typo = code.slice(0, 2) + (code[2] === 'A' ? 'B' : 'A') + code.slice(3);
  await field.fill(typo);
  await expect(status).toHaveAttribute('data-tone', 'error');
  await expect(go).toBeDisabled();
  // Enter on a typo plays nothing
  const before = (await hook(page, (h) => h.actions)).length;
  await field.press('Enter');
  await expect(status).toHaveClass(/is-nudge/);
  expect(await hook(page, (h) => h.actions.length)).toBe(before);
  // gamepad B first closes the keyboard, then leaves the screen
  await field.focus();
  await hook(page, (h) => h.pad('back'));
  await expect(field).not.toBeFocused();
  expect(await hook(page, (h) => h.screen)).toBe('worlds');
  await field.fill(code.toLowerCase());
  await expect(status).toHaveAttribute('data-tone', 'ok');
  await expect(status).toContainText('Saved as');
  await shot(page, 'worlds-valid');
  await field.press('Enter');
  const want = (await saved(page)).worlds.find((w) => w.id === code)!.seed;
  expect((await hook(page, (h) => h.actions)).at(-1)).toMatchObject({ type: 'level', id: 'infinite', seed: want });
  // free text hashes to a new world, saved as "World XXXX"
  await hook(page, (h) => h.show('worlds'));
  await page.locator('#ds-world-seed').fill('hello');
  await expect(status).toContainText('“hello” →');
  await press(page, 'Play', page.locator('.ds-worlds__entry'));
  expect((await hook(page, (h) => h.actions)).at(-1)).toMatchObject({ seed: 0x4f9f2cab });
  expect((await saved(page)).worlds).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('rename, delete with confirmation, share falls back to the clipboard', async ({ page, context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, 'screen=worlds&worlds=3&noshare=1');
  const rows = page.locator('.ds-wrow');
  await expect(rows).toHaveCount(3);
  const first = rows.first();
  const id = (await first.getAttribute('data-world'))!;
  // rename: empty is refused, a name is kept and persisted
  await press(page, /^Rename /, first);
  const name = page.locator('#ds-world-rename');
  await expect(name).toBeFocused();
  await name.fill('   ');
  await name.press('Enter');
  await expect(name).toBeVisible();
  await name.fill('Morning valley run that is far too long');
  await shot(page, 'worlds-rename');
  await name.press('Enter');
  await expect(first.locator('.ds-wrow__name')).toContainText('Morning valley run that');
  expect((await saved(page)).worlds.find((w) => w.id === id)!.name).toBe('Morning valley run that');
  // share: no navigator.share here, so the link goes to the clipboard
  await press(page, /^Share /, rows.first());
  await expect.poll(() => hook(page, (h) => h.toasts.at(-1) ?? '')).toMatch(new RegExp(`^(Link copied · ${id}|Share this link: .*/play/\\?world=${id})$`));
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/play/\\?world=${id}$`));
  // delete: Cancel keeps it, Delete removes it
  await press(page, /^Delete /, rows.first());
  await expect.poll(() => hook(page, (h) => h.screen)).toBe('confirm-world-delete');
  await expect(page.locator('[data-f="delText"]')).toContainText(id);
  await page.waitForTimeout(450);
  await shot(page, 'worlds-delete');
  await press(page, 'Cancel');
  await expect.poll(() => hook(page, (h) => h.screen)).toBe('worlds');
  await expect(rows).toHaveCount(3);
  await press(page, /^Delete /, rows.first());
  await press(page, 'Delete', page.locator('.ds-screen--confirm-world-delete'));
  await expect(rows).toHaveCount(2);
  expect((await saved(page)).worlds.map((w) => w.id)).not.toContain(id);
  expect(await hook(page, (h) => h.toasts.at(-1))).toBe('Deleted Morning valley run that');
  expect(errors).toEqual([]);
});

test('a full list says so', async ({ page }) => {
  await open(page, 'screen=worlds&worlds=50');
  await expect(page.locator('[data-f="cap"]')).toBeVisible();
  await expect(page.locator('[data-f="count"]')).toHaveText('50 / 50');
  await noSideScroll(page);
  await shot(page, 'worlds-full');
});

test.describe('desktop keyboard', () => {
  test.skip(({ isMobile }) => isMobile, 'keyboard');

  test('← → reach the Infinite card; the list keeps its column on ↑ ↓; Esc leaves the field, then the screen', async ({ page }) => {
    await open(page, 'screen=main&worlds=3');
    const focus = page.locator('.ds-screen.is-open .is-focused');
    const key = async (k: string): Promise<void> => {
      await page.keyboard.press(k, { delay: 30 });
      await page.waitForTimeout(90);
    };
    await key('Enter');
    await expect(focus).toHaveAttribute('data-act', 'level-race:training');
    for (let i = 0; i < 4; i++) await key('ArrowRight');
    await expect(focus).toHaveAttribute('data-act', 'level-freefly:infinite');
    await key('ArrowDown');
    await expect(focus).toHaveAttribute('data-act', 'level-worlds:infinite');
    await key('Enter');
    await expect.poll(() => hook(page, (h) => h.screen)).toBe('worlds');
    await expect(focus).toHaveAttribute('data-act', 'world-new');
    await key('ArrowDown');
    await expect(focus).toHaveAttribute('data-act', 'world-field');
    await key('Enter');
    await expect(page.locator('#ds-world-seed')).toBeFocused();
    await page.keyboard.type('sunset', { delay: 20 });
    await key('ArrowDown');
    await expect(page.locator('#ds-world-seed')).not.toBeFocused();
    await expect(focus).toHaveAttribute('data-act', 'world-go');
    await key('ArrowDown');
    await expect(focus).toHaveAttribute('data-act', /^world-play:/);
    await key('ArrowRight');
    await key('ArrowRight');
    await expect(focus).toHaveAttribute('data-act', /^world-share:/);
    await key('ArrowDown');
    await expect(focus).toHaveAttribute('data-act', /^world-share:/);
    const second = await page.locator('.ds-wrow').nth(1).getAttribute('data-world');
    await expect(focus).toHaveAttribute('data-act', `world-share:${second}`);
    await key('Escape');
    await expect.poll(() => hook(page, (h) => h.screen)).toBe('levels');
    await expect(focus).toHaveAttribute('data-act', 'level-worlds:infinite');
    expect(errors).toEqual([]);
  });
});

test('outdoor HUD: compass, minimap with terrain, units', async ({ page }) => {
  await open(page, 'screen=race&heading=40');
  const compass = page.locator('.ds-compass');
  await expect(compass).toBeVisible();
  await expect(page.locator('[data-r="cHdg"]')).toHaveText('040');
  await expect(page.locator('[data-r="cRingD"]')).toHaveText(/^\d+ m$/);
  await expect(page.locator('[data-r="cAgl"]')).toHaveText(/^\d+(\.\d)? m$/);
  const map = page.locator('.ds-minimap');
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(88);
  // terrain cells are drawn (opaque pixels at the centre of the map)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-r="mapTerrain"]')!;
        const d = c.getContext('2d')!.getImageData(c.width / 2, c.height / 2, 1, 1).data;
        return d[3];
      }),
    )
    .toBe(255);
  // compass and minimap stay clear of each other and of the screen edges
  const cb = (await compass.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(cb.x + cb.width <= box.x || box.x + box.width <= cb.x || cb.y + cb.height <= box.y || box.y + box.height <= cb.y).toBe(true);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  await shot(page, 'hud');
  await hook(page, (h) => h.setSettings({ units: 'ft' }));
  await expect(page.locator('[data-r="cAgl"]')).toHaveText(/ ft$/);
  await expect(page.locator('[data-r="speedUnit"]')).toHaveText('mph');
  await hook(page, (h) => h.setSettings({ minimap: false }));
  await expect(map).toBeHidden();
  expect(await hook(page, (h) => h.xrPause().kicker)).toMatch(/^PILOT \d+ ft · AGL [\d.]+ ft$/);
  expect(errors).toEqual([]);
});

test('settings list the outdoor rows', async ({ page }) => {
  await open(page, 'screen=settings');
  for (const label of ['Time of day', 'View distance', 'Minimap', 'Units', 'Wind volume']) await expect(page.locator(`.ds-row[aria-label="${label}"]`)).toHaveCount(1);
  await expect(page.locator('.ds-row[aria-label="Units"] .ds-row__value')).toHaveText('Metres · km/h');
  await expect(page.locator('.ds-row[aria-label="Minimap"] .ds-row__value')).toHaveText('On');
});
