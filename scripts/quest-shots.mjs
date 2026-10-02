/** Store listing screenshots at App Store / Horizon sizes. Needs `npm run build && npm run preview`; PNGs → JPEG with sips afterwards. */
import { chromium } from '@playwright/test';
const OUT = new URL('../store/screenshots', import.meta.url).pathname;
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
// /app/ boots only for a Meta Horizon Store owner: stub the Digital Goods API as the installed app sees it
await p.addInitScript(() => {
  window.getDigitalGoodsService = async () => ({ getLoggedInUserId: async () => '4815162342' });
});
await p.goto('http://localhost:4173/app/?xremu=1');
await p.waitForFunction(() => window.__drone && window.__xrDevice);
await p.getByRole('button', { name: 'Enter VR' }).click();
await p.waitForFunction(() => window.__drone.xr.presenting);
await p.waitForTimeout(800);
await p.screenshot({ path: `${OUT}/quest-1-vr-menu.png` });
const tap = async (h, btn) => { await p.evaluate(([h, b]) => window.__xrDevice.controllers[h].updateButtonValue(b, 1), [h, btn]); await p.waitForTimeout(150); await p.evaluate(([h, b]) => window.__xrDevice.controllers[h].updateButtonValue(b, 0), [h, btn]); await p.waitForTimeout(150); };
const stick = (h, x, y) => p.evaluate(([h, x, y]) => window.__xrDevice.controllers[h].updateAxes('thumbstick', x, y), [h, x, y]);
await tap('left', 'x-button');
await tap('right', 'a-button');
await stick('left', 0, -1); await p.waitForTimeout(900); await stick('left', 0, 0);
await stick('right', 0.15, -0.6); await p.waitForTimeout(1800); await stick('right', 0, 0);
await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}/quest-2-vr-los-platform.png` });
// look down at the platform and course
await p.evaluate(() => { const q = window.__xrDevice.quaternion; const a = -0.35; q.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); });
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/quest-3-vr-overview.png` });
await p.evaluate(() => window.__xrDevice.quaternion.set(0, 0, 0, 1));
await tap('right', 'thumbstick'); // FPV
await stick('right', 0, -0.7); await p.waitForTimeout(1200); await stick('right', 0, 0);
await p.waitForTimeout(200);
await p.screenshot({ path: `${OUT}/quest-4-vr-fpv.png` });
await b.close();
