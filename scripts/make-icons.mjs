// Generates the home-screen / PWA icons procedurally: hand-written SVG → PNG via a headless
// Playwright Chromium screenshot (no canvas / image dependencies). Run: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

/** `pad` = fraction of the canvas kept clear around the artwork (maskable safe zone needs ≥ 10 %). */
function svg(pad) {
  const s = 512;
  const k = 1 - 2 * pad;
  const t = (v) => (pad * s + v * k).toFixed(1);
  const r = (v) => (v * k).toFixed(1);
  // Gate ring + an X-frame quad with four rotors seen from above.
  const rotors = [
    [176, 176],
    [336, 176],
    [176, 336],
    [336, 336],
  ]
    .map(
      ([x, y]) =>
        `<circle cx="${t(x)}" cy="${t(y)}" r="${r(44)}" fill="rgba(40,231,255,0.10)" stroke="#8ff3ff" stroke-width="${r(7)}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0" stop-color="#16244a"/><stop offset="0.6" stop-color="#0a1024"/><stop offset="1" stop-color="#05070d"/>
    </radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#28e7ff"/><stop offset="1" stop-color="#ff3de8"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${r(10)}"/></filter>
  </defs>
  <rect width="${s}" height="${s}" fill="url(#bg)"/>
  <circle cx="${t(256)}" cy="${t(256)}" r="${r(196)}" fill="none" stroke="url(#ring)" stroke-width="${r(30)}" filter="url(#glow)" opacity="0.9"/>
  <circle cx="${t(256)}" cy="${t(256)}" r="${r(196)}" fill="none" stroke="url(#ring)" stroke-width="${r(20)}"/>
  <path d="M${t(176)} ${t(176)} L${t(336)} ${t(336)} M${t(336)} ${t(176)} L${t(176)} ${t(336)}" stroke="#eaf6ff" stroke-width="${r(18)}" stroke-linecap="round"/>
  <rect x="${t(226)}" y="${t(222)}" width="${r(60)}" height="${r(68)}" rx="${r(14)}" fill="#eaf6ff"/>
  <circle cx="${t(256)}" cy="${t(232)}" r="${r(8)}" fill="#ff3de8"/>
  ${rotors}
</svg>`;
}

const targets = [
  { file: 'icon-180.png', size: 180, pad: 0.06 }, // apple-touch-icon (iOS rounds corners itself)
  { file: 'icon-192.png', size: 192, pad: 0.06 },
  { file: 'icon-512.png', size: 512, pad: 0.06 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.16 },
];

writeFileSync(join(out, 'icon.svg'), svg(0.06));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const t of targets) {
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(`<html><body style="margin:0;background:#05070d">${svg(t.pad).replace('width="512" height="512"', `width="${t.size}" height="${t.size}"`)}</body></html>`);
    await page.screenshot({ path: join(out, t.file), clip: { x: 0, y: 0, width: t.size, height: t.size } });
    console.log('wrote', t.file);
  }
} finally {
  await browser.close();
}
