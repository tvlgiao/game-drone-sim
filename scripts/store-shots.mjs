/** Store listing screenshots at App Store / Horizon sizes. Needs `npm run build && npm run preview`; PNGs → JPEG with sips afterwards. */
import { chromium } from '@playwright/test';
const OUT = new URL('../store/screenshots', import.meta.url).pathname;
const devices = [
  { name: 'iphone-6.9', viewport: { width: 956, height: 440 }, dpr: 3, touch: true },
  { name: 'ipad-13', viewport: { width: 1376, height: 1032 }, dpr: 2, touch: true },
];
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const d of devices) {
  const ctx = await b.newContext({ viewport: d.viewport, deviceScaleFactor: d.dpr, hasTouch: d.touch, isMobile: d.touch });
  const p = await ctx.newPage();
  await p.addInitScript(() => localStorage.setItem('drone-sim.settings', JSON.stringify({ quality: 'ultra', showFps: false })));
  await p.goto('http://localhost:4173/play/?rotate=0&selftest=0');
  await p.waitForFunction(() => window.__drone);
  const h = (fn, arg) => p.evaluate(fn, arg);
  // dismiss the tap gate on touch devices
  if (d.touch) { await p.mouse.click(d.viewport.width / 2, d.viewport.height * 0.66); await p.waitForTimeout(400); }
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/${d.name}-1-menu.png` });
  const fly = async (x, y, z, yaw, cam, ctl, secs) => {
    await h(() => window.__drone.action({ type: 'freefly' }));
    for (let i = 0; i < 3 && (await h(() => window.__drone.camera)) !== cam; i++) { await h(() => window.__drone.press('cycleCamera')); await p.waitForTimeout(120); }
    await h(() => window.__drone.setControl({ throttle: 0, yaw: 0, pitch: 0, roll: 0 }));
    await h(([x, y, z, yaw]) => { window.__drone.teleport(x, y, z, yaw); window.__drone.press('arm'); }, [x, y, z, yaw]);
    await p.waitForTimeout(40);
    await h(() => window.__drone.setControl({ throttle: 0.75, yaw: 0, pitch: 0, roll: 0 }));
    await p.waitForTimeout(400);
    await h((c) => window.__drone.setControl(c), ctl);
    await p.waitForTimeout(secs * 1000);
    // scripted setControl bypasses the take-off latch, so its 'push the throttle up' toast is misleading
    await h(() => document.querySelectorAll('.ds-toasts').forEach((e) => (e.style.display = 'none')));
  };
  await fly(-9, 1.8, 5.2, 0, 'los', { throttle: 0.5, yaw: 0.05, pitch: 0.2, roll: 0.05 }, 2.6);
  await p.screenshot({ path: `${OUT}/${d.name}-2-los.png` });
  await fly(-9, 1.6, 5.2, 0, 'chase', { throttle: 0.5, yaw: 0.03, pitch: 0.2, roll: 0 }, 2.4);
  await p.screenshot({ path: `${OUT}/${d.name}-3-chase.png` });
  await fly(-9, 1.5, 5.2, 0, 'fpv', { throttle: 0.5, yaw: 0, pitch: 0.2, roll: 0 }, 2.4);
  await p.screenshot({ path: `${OUT}/${d.name}-4-fpv.png` });
  await ctx.close();
}
await b.close();
