/**
 * The site split: `/` landing page, `/play/` free flat-screen game (never VR), `/app/` Meta Quest store
 * app (VR, only for a store owner; everyone else gets the store gate).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { questOwnerStub } from './quest-owner';

type W = {
  __drone?: { xr: { presenting: boolean }; screen: string; action: (a: { type: string }) => void };
  __xrDevice?: unknown;
};

const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/152.0.0.44.30 Chrome/152.0.7977.64 VR Safari/537.36';
const GATE_TITLE = 'Drone Sim VR is available on the Meta Horizon Store';

function trackErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  return errs;
}

const booted = (page: Page) => page.waitForFunction(() => !!(window as unknown as W).__drone, null, { timeout: 20_000 });
const presenting = (page: Page) => page.evaluate(() => (window as unknown as W).__drone!.xr.presenting);

/** display-mode: standalone, as the installed Horizon OS app (and a home-screen PWA) sees it */
async function standalone(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q.includes('display-mode: standalone') ? ({ ...mm(q), matches: true, media: q } as MediaQueryList) : mm(q));
  });
}

test.describe('landing page', () => {
  test('renders the pitch, store badges and footer without the game bundle; Play boots the free game', async ({ page }) => {
    const errs = trackErrors(page);
    const scripts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'script') scripts.push(r.url());
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Drone Sim' })).toBeVisible();
    for (const name of ['FPV, line of sight and chase', 'Betaflight-style rates', 'Gamepad, touch or keyboard', 'Meta Quest VR']) {
      await expect(page.getByRole('heading', { level: 3, name })).toBeVisible();
    }
    // listings are not live yet: every badge is a "Coming soon" label, not a link
    const badges = page.locator('.st-badge');
    await expect(badges).toHaveCount(3);
    await expect(badges).toContainText(['Meta Quest', 'App Store', 'Google Play']);
    await expect(page.locator('a.st-badge')).toHaveCount(0);
    await expect(page.locator('.st-badge.is-soon', { hasText: 'Coming soon' })).toHaveCount(3);
    await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', './privacy/');
    await expect(page.getByRole('link', { name: 'support@coworkgamestudio.com' })).toHaveAttribute('href', 'mailto:support@coworkgamestudio.com');
    await expect(page.locator('footer')).toContainText('© COWORK Game Studio');
    expect(await page.locator('meta[property="og:image"]').getAttribute('content')).toMatch(/^https:\/\/dronesim\.coworkgamestudio\.com\/screenshots\/og\.jpg$/);
    expect((await page.request.get('/screenshots/og.jpg')).ok()).toBe(true);
    // every image has its size and a description
    for (const img of await page.locator('main img').all()) {
      expect(await img.getAttribute('alt')).toBeTruthy();
      expect(await img.getAttribute('width')).toBeTruthy();
      expect(await img.getAttribute('height')).toBeTruthy();
    }
    // fast: no three.js / game bundle on the landing page
    await page.waitForLoadState('networkidle');
    expect(scripts.some((u) => /\/assets\/main-/.test(u))).toBe(false);
    expect(await page.evaluate(() => 'serviceWorker' in navigator && navigator.serviceWorker.controller)).toBeFalsy();

    await page.getByRole('link', { name: 'Play free on the web' }).first().click();
    await expect(page).toHaveURL(/\/play\/$/);
    await booted(page);
    expect(await page.evaluate(() => (window as unknown as W).__drone!.screen)).toBe('main');
    expect(errs).toEqual([]);
  });

  test('an old game link to the root (game query string) lands in the free game with its query', async ({ page }) => {
    await page.goto('/?rotate=0');
    await expect(page).toHaveURL(/\/play\/\?rotate=0$/);
    await booted(page);
  });

  test('a Quest app installed before the split (start URL "/") is sent to /app/', async ({ browser }) => {
    const ctx = await browser.newContext({ userAgent: QUEST_UA });
    await standalone(ctx);
    await ctx.addInitScript(questOwnerStub);
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/app\/$/);
    await booted(page);
    await ctx.close();
  });
});

test.describe('/play/: free web game, never VR', () => {
  test('a VR-capable browser gets no Enter VR, and sessiongranted / enter-vr do not start a session', async ({ page }) => {
    const errs = trackErrors(page);
    await page.goto('/play/?xremu=1');
    await page.waitForFunction(() => !!(window as unknown as W).__drone && !!(window as unknown as W).__xrDevice, null, { timeout: 20_000 });
    expect(await page.evaluate(() => navigator.xr!.isSessionSupported('immersive-vr'))).toBe(true);
    await page.waitForTimeout(1000);
    await expect(page.getByRole('button', { name: 'Enter VR' })).toBeHidden();
    await page.evaluate(() => (navigator as Navigator & { xr: EventTarget }).xr.dispatchEvent(new Event('sessiongranted')));
    await page.evaluate(() => (window as unknown as W).__drone!.action({ type: 'enter-vr' }));
    await page.waitForTimeout(1500);
    expect(await presenting(page)).toBe(false);
    expect(errs).toEqual([]);
  });

  test('installed on a Quest (standalone), it still does not auto-enter VR', async ({ browser }) => {
    const ctx = await browser.newContext({ userAgent: QUEST_UA });
    await standalone(ctx);
    const page = await ctx.newPage();
    await page.goto('/play/?xremu=1');
    await page.waitForFunction(() => !!(window as unknown as W).__drone && !!(window as unknown as W).__xrDevice, null, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(await presenting(page)).toBe(false);
    await expect(page.getByRole('button', { name: 'Enter VR' })).toBeHidden();
    await ctx.close();
  });
});

test.describe('/app/: Meta Quest store app', () => {
  test('without the Digital Goods API (a browser tab) shows the store gate instead of the game', async ({ page }) => {
    const errs = trackErrors(page);
    await page.goto('/app/?xremu=1');
    await expect(page.getByRole('heading', { level: 1, name: GATE_TITLE })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#splash')).toBeHidden();
    expect(await page.evaluate(() => !!(window as unknown as W).__drone)).toBe(false);
    await expect(page.locator('.ds-store-gate .st-badge--quest')).toContainText('Coming soon');
    // its own styles only: the game's touch tap gate (mobile.css) must not leak in
    const title = page.getByRole('heading', { level: 1, name: GATE_TITLE });
    expect(await title.evaluate((el) => getComputedStyle(el).letterSpacing)).toBe('normal');
    expect(await title.evaluate((el) => getComputedStyle(el).textShadow)).toBe('none');
    const play = page.getByRole('link', { name: 'Play free on the web' });
    await expect(play).toBeFocused();
    await play.click();
    await expect(page).toHaveURL(/\/play\/$/);
    await booted(page);
    expect(errs).toEqual([]);
  });

  test('a signed-in account that does not own the app (user id 0) gets the gate', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { getDigitalGoodsService: () => Promise<unknown> }).getDigitalGoodsService = async () => ({ getLoggedInUserId: async () => 0 });
    });
    await page.goto('/app/?xremu=1');
    await expect(page.getByRole('heading', { level: 1, name: GATE_TITLE })).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => !!(window as unknown as W).__drone)).toBe(false);
  });

  test('the store-installed app (owner) boots the full game with Enter VR', async ({ page }) => {
    const errs = trackErrors(page);
    await page.addInitScript(questOwnerStub);
    await page.goto('/app/?xremu=1');
    await page.waitForFunction(() => !!(window as unknown as W).__drone && !!(window as unknown as W).__xrDevice, null, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Enter VR' })).toBeVisible();
    await expect(page.getByRole('heading', { name: GATE_TITLE })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('drone-sim.owned.v1'))).toMatch(/^\d{13}$/);
    expect(errs).toEqual([]);
  });

  test('?owned=1 is a dev-server-only override: the production build ignores it', async ({ page }) => {
    await page.goto('/app/?owned=1');
    await expect(page.getByRole('heading', { level: 1, name: GATE_TITLE })).toBeVisible({ timeout: 20_000 });
  });
});
