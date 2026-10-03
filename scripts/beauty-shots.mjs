/**
 * Beauty shots of the render preview (render-preview.html) for look reviews: both levels, every camera,
 * desktop 1920×1080 per tier and an iPhone (WebKit) frame. Needs a dev server: `npx vite --port 5701`.
 * Usage: node scripts/beauty-shots.mjs <outdir> [port=5701] [name-filter]
 */
import { mkdirSync } from 'node:fs';
import { chromium, webkit, devices } from '@playwright/test';

const out = process.argv[2] ?? 'shots';
const port = process.argv[3] ?? '5701';
const filter = process.argv[4] ?? '';
const base = `http://localhost:${port}/render-preview.html`;
const START = { 'night-loft': 6.5, training: 9 };

const jobs = [];
for (const level of ['night-loft', 'training']) {
  for (const cam of ['los', 'fpv', 'chase']) jobs.push({ name: `${level}-${cam}-1920-ultra`, level, cam, tier: 'ultra' });
  for (const tier of ['high', 'medium', 'low']) jobs.push({ name: `${level}-chase-1920-${tier}`, level, cam: 'chase', tier });
  jobs.push({ name: `${level}-chase-iphone-medium`, level, cam: 'chase', tier: 'medium', iphone: true });
  jobs.push({ name: `${level}-los-iphone-medium`, level, cam: 'los', tier: 'medium', iphone: true });
}

mkdirSync(out, { recursive: true });
const browsers = {};
for (const j of jobs.filter((x) => x.name.includes(filter))) {
  const kind = j.iphone ? 'webkit' : 'chromium';
  browsers[kind] ??= await (kind === 'webkit' ? webkit : chromium).launch(
    kind === 'chromium' ? { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : {},
  );
  const ctx = await browsers[kind].newContext(j.iphone ? { ...devices['iPhone 15 Pro landscape'] } : { viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text());
  });
  await page.goto(`${base}?level=${j.level}&cam=${j.cam}&tier=${j.tier}&t=${START[j.level]}&pause`);
  await page.waitForFunction(() => !!window.__preview, null, { timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    document.getElementById('hud').style.display = 'none';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${j.name}.png` });
  const ms = j.iphone ? null : await page.evaluate(() => window.__preview.bench(120));
  console.log(j.name, ms === null ? '' : `${ms.toFixed(2)} ms/frame`, errs.length ? errs.slice(0, 3) : 'ok');
  await ctx.close();
}
for (const b of Object.values(browsers)) await b.close();
