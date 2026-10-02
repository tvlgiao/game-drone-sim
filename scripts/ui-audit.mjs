/**
 * UI audit capture: every screen × every device class → audit/<round>/<device>/<nn-screen>.png,
 * plus audit/<round>/index.html (contact sheet) and manifest.json (for review agents).
 * Per device: the landing page (/) first, then the game under /play/, the Quest app's store gate
 * (/app/ in a plain browser) and, on the VR device, the VR states under /app/ with an owner's store stub.
 *
 *   npm run build && npm run preview          # serves http://localhost:4173
 *   node scripts/ui-audit.mjs round-1 [baseUrl] [deviceFilter]
 *
 * See docs/06-ui-audit-process.md for the review / fix loop that consumes these shots.
 */
import { chromium, webkit, devices } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUND = process.argv[2] ?? 'round-1';
const BASE = process.argv[3] ?? 'http://localhost:4173';
const FILTER = process.argv[4] ?? '';
const OUT = fileURLToPath(new URL(`../audit/${ROUND}/`, import.meta.url));
const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/152.0.0.44.30 Chrome/152.0.7977.64 VR Safari/537.36';
const GPU = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];

/** name, browser, context options, flags */
const DEVICES = [
  { name: 'desktop-1920x1080', engine: 'chromium', ctx: { viewport: { width: 1920, height: 1080 } }, vr: true },
  { name: 'desktop-2560x1440', engine: 'chromium', ctx: { viewport: { width: 2560, height: 1440 } } },
  { name: 'desktop-1366x768', engine: 'chromium', ctx: { viewport: { width: 1366, height: 768 } } },
  { name: 'desktop-1280x720', engine: 'chromium', ctx: { viewport: { width: 1280, height: 720 } } },
  { name: 'quest-browser-1280x720', engine: 'chromium', ctx: { viewport: { width: 1280, height: 720 }, userAgent: QUEST_UA } },
  { name: 'iphone-se-landscape', engine: 'webkit', ctx: devices['iPhone SE landscape'], touch: true },
  { name: 'iphone-15pro-landscape', engine: 'webkit', ctx: devices['iPhone 15 Pro landscape'], touch: true },
  { name: 'iphone-15promax-landscape', engine: 'webkit', ctx: devices['iPhone 15 Pro Max landscape'], touch: true },
  { name: 'iphone-15pro-portrait', engine: 'webkit', ctx: devices['iPhone 15 Pro'], touch: true, portrait: true },
  { name: 'iphone-se-portrait', engine: 'webkit', ctx: devices['iPhone SE'], touch: true, portrait: true },
  { name: 'ipad-mini-landscape', engine: 'webkit', ctx: devices['iPad Mini landscape'], touch: true },
  { name: 'ipad-pro11-landscape', engine: 'webkit', ctx: devices['iPad Pro 11 landscape'], touch: true },
  { name: 'ipad-pro11-portrait', engine: 'webkit', ctx: devices['iPad Pro 11'], touch: true },
  { name: 'android-pixel7-landscape', engine: 'chromium', ctx: devices['Pixel 7 landscape'], touch: true },
  { name: 'android-tab-landscape', engine: 'chromium', ctx: devices['Galaxy Tab S4 landscape'], touch: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Meta Horizon Store Digital Goods API as an owner's store-installed Quest app sees it (init script). */
function questOwnerStub() {
  window.getDigitalGoodsService = async () => ({ getLoggedInUserId: async () => '4815162342' });
}

async function run() {
  mkdirSync(OUT, { recursive: true });
  const manifest = [];
  const browsers = { chromium: await chromium.launch({ args: GPU }), webkit: await webkit.launch() };
  for (const d of DEVICES.filter((x) => !FILTER || x.name.includes(FILTER))) {
    const dir = join(OUT, d.name);
    mkdirSync(dir, { recursive: true });
    const ctx = await browsers[d.engine].newContext({ ...d.ctx, ...(d.engine === 'chromium' ? {} : {}) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const shots = [];
    let n = 0;
    const shot = async (label, note = '', fullPage = false) => {
      const file = `${String(++n).padStart(2, '0')}-${label}.png`;
      await page.screenshot({ path: join(dir, file), fullPage });
      shots.push({ file, label, note });
    };
    const h = (fn, arg) => page.evaluate(fn, arg);
    /** scroll every scrollable panel to the bottom (long dialogs) */
    const scrollPanels = (to) =>
      h((t) => {
        for (const el of document.querySelectorAll('#ui *')) {
          if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = t === 'bottom' ? el.scrollHeight : 0;
        }
      }, to);
    const screen = async (name, data, extra = '') => {
      await h(([s, dt]) => window.__drone.showScreen(s, dt), [name, data]);
      await sleep(450);
      await shot(name + extra);
      const scrollable = await h(() => [...document.querySelectorAll('#ui *')].some((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible' && el.offsetParent));
      if (scrollable) {
        await scrollPanels('bottom');
        await sleep(250);
        await shot(name + extra + '-scrolled', 'panel scrolled to bottom');
        await scrollPanels('top');
      }
    };
    try {
      await page.goto(`${BASE}/`);
      await page.waitForLoadState('networkidle');
      await shot('landing');
      await shot('landing-full', 'whole landing page', true);
      // plain load first: ?xremu=1 makes the app treat the desktop as a Quest (Touch copy, Quest advice)
      await page.goto(`${BASE}/play/${d.portrait ? '' : '?rotate=0'}`);
      await page.waitForFunction(() => !!window.__drone, null, { timeout: 30_000 });
      await sleep(1500);
      if (d.portrait) {
        await shot('rotate-overlay', 'phone held in portrait');
        await ctx.close();
        manifest.push({ device: d.name, viewport: d.ctx.viewport, touch: !!d.touch, shots, errors });
        continue;
      }
      if (d.touch) {
        await shot('tap-gate');
        const gate = page.getByRole('button', { name: /tap to play/i });
        if (await gate.isVisible().catch(() => false)) await gate.click();
        await sleep(700);
        const a2hs = page.getByRole('button', { name: /got it/i });
        if (await a2hs.isVisible().catch(() => false)) {
          await shot('add-to-home-screen');
          await a2hs.click();
          await sleep(400);
        }
      }
      // first launch: the tutorial offer covers the main menu once
      const offer = page.getByRole('dialog', { name: 'New to FPV?' });
      if (await offer.isVisible().catch(() => false)) {
        await shot('tutorial-offer');
        await offer.getByRole('button', { name: 'Skip' }).click();
        await sleep(400);
      }
      await shot('main-menu');
      await page.getByRole('button', { name: 'Race', exact: true }).click();
      await sleep(700);
      await shot('levels');
      await screen('main');
      for (const s of ['settings', 'rates', 'controls', 'controller', 'about', 'confirm-reset']) await screen(s);
      await screen('main');
      // flight HUD in each camera, on the Night Loft like earlier rounds (first-time pilots start on Training)
      await h(() => window.__drone.startLevel('night-loft'));
      await sleep(600);
      await h(() => window.__drone.action({ type: 'freefly' }));
      await h(() => {
        window.__drone.teleport(-9, 1.6, 5.2, 0);
        window.__drone.setControl({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
        window.__drone.press('arm');
      });
      await sleep(120);
      // near hover: desktop/gamepad has no altitude hold, so 0.55 climbed into the ceiling (black FPV shots)
      await h(() => window.__drone.setControl({ throttle: 0.48, yaw: 0, pitch: 0.12, roll: 0 }));
      await sleep(1600);
      for (const cam of ['los', 'fpv', 'chase']) {
        for (let i = 0; i < 3 && (await h(() => window.__drone.camera)) !== cam; i++) {
          await h(() => window.__drone.press('cycleCamera'));
          await sleep(150);
        }
        await sleep(700);
        await shot(`flight-${cam}`);
      }
      await h(() => window.__drone.setControl(null));
      await h(() => window.__drone.press('pause'));
      await sleep(500);
      await shot('pause');
      await screen('confirm-quit');
      await screen('finish', { time: 83.456, best: 80.12, newBest: false }, '-normal');
      await screen('finish', { time: 79.9, best: 79.9, newBest: true }, '-new-best');
      // race: countdown, racing HUD, crash
      await h(() => window.__drone.action({ type: 'race' }));
      await sleep(900);
      await shot('race-countdown');
      await sleep(2600);
      await shot('race-racing');
      await h(() => window.__drone.teleport(-9, 4.5, 5.8, 0));
      await sleep(1100);
      await shot('race-crashed');
      await h(() => window.__drone.toast('Controller connected: Xbox Wireless Controller'));
      await sleep(250);
      await shot('toast');
      await h(() => window.__drone.startTutorial());
      await sleep(1500);
      await shot('tutorial-welcome', 'tutorial step 1 on Training (LOS)');
      await h(() => window.__drone.action({ type: 'menu' }));
      await sleep(400);
      await screen('bye');
      await h(() => window.__drone.showError('WebGL2 is not available on this device/browser (context lost). Enable hardware acceleration or try a recent Chrome, Edge, Firefox or Safari.'));
      await sleep(400);
      await shot('error');
      // the Quest app page in a plain browser (no Digital Goods API): the store gate
      await page.goto(`${BASE}/app/`);
      await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30_000 });
      await sleep(300);
      await shot('store-gate');
      if (d.vr) {
        await ctx.addInitScript(questOwnerStub);
        await page.goto(`${BASE}/app/?rotate=0&xremu=1`);
        await page.waitForFunction(() => !!window.__drone && !!window.__xrDevice, null, { timeout: 30_000 });
        await sleep(800);
        await shot('main-menu-with-enter-vr');
        await page.getByRole('button', { name: 'Enter VR' }).click();
        await page.waitForFunction(() => window.__drone.xr.presenting, null, { timeout: 10_000 });
        await sleep(600);
        await shot('vr-menu-card');
        const tap = async (hand, btn) => {
          await h(([a, b]) => window.__xrDevice.controllers[a].updateButtonValue(b, 1), [hand, btn]);
          await sleep(150);
          await h(([a, b]) => window.__xrDevice.controllers[a].updateButtonValue(b, 0), [hand, btn]);
          await sleep(250);
        };
        await tap('left', 'x-button');
        await tap('right', 'a-button');
        await h(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1));
        await sleep(700);
        await h(() => window.__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
        await sleep(400);
        await shot('vr-flight-los');
        await tap('left', 'y-button');
        await sleep(300);
        await shot('vr-paused-card');
      }
    } catch (e) {
      errors.push('AUDIT SCRIPT: ' + e.message.split('\n')[0]);
    }
    manifest.push({ device: d.name, viewport: d.ctx.viewport, touch: !!d.touch, shots, errors });
    await ctx.close();
    console.log(`${d.name}: ${shots.length} shots, ${errors.length} errors`);
  }
  await browsers.chromium.close();
  await browsers.webkit.close();
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const html = `<!doctype html><meta charset="utf-8"><title>UI audit ${ROUND}</title>
<style>body{background:#111;color:#ddd;font:14px system-ui;margin:16px}h2{margin:28px 0 8px}figure{display:inline-block;margin:6px;vertical-align:top}img{max-width:420px;max-height:300px;border:1px solid #333;display:block}figcaption{font-size:12px;color:#9ab}</style>
<h1>UI audit ${ROUND}</h1>${manifest
    .map(
      (m) =>
        `<h2>${m.device} — ${m.viewport?.width}×${m.viewport?.height}${m.touch ? ' touch' : ''}${m.errors.length ? ` — <span style="color:#f77">${m.errors.length} errors</span>` : ''}</h2>${m.shots
          .map((s) => `<figure><a href="${m.device}/${s.file}"><img loading="lazy" src="${m.device}/${s.file}"></a><figcaption>${s.file}</figcaption></figure>`)
          .join('')}${m.errors.map((e) => `<pre style="color:#f77">${e}</pre>`).join('')}`,
    )
    .join('')}`;
  writeFileSync(join(OUT, 'index.html'), html);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
