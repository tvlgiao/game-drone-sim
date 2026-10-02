/**
 * Landing page images from the store screenshots: centre crops, resized and recompressed into
 * public/screenshots/ (macOS `sips`). Re-run after `node scripts/store-shots.mjs` refreshes the sources.
 *
 *   node scripts/landing-images.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../store/screenshots/', import.meta.url));
const OUT = fileURLToPath(new URL('../public/screenshots/', import.meta.url));
const QUALITY = '62';

/** output name → source screenshot, widths, aspect (default 16:9; the hero keeps the phone's full frame so no HUD is cut) */
const SHOTS = [
  { name: 'los', src: 'iphone-6.9-2-los.jpg', widths: [800, 1280], aspect: [2868, 1320] },
  { name: 'chase', src: 'iphone-6.9-3-chase.jpg', widths: [800] },
  { name: 'fpv', src: 'ipad-13-4-fpv.jpg', widths: [800] },
  { name: 'vr', src: 'quest-4-vr-fpv.jpg', widths: [800] },
  { name: 'menu', src: 'ipad-13-1-menu.jpg', widths: [800] },
];

const dims = (file) => {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString();
  return [Number(/pixelWidth: (\d+)/.exec(out)[1]), Number(/pixelHeight: (\d+)/.exec(out)[1])];
};

/** centre crop of `file` to w:h, scaled to `width`, written to `out` */
function render(file, out, aspectW, aspectH, width) {
  const [w, h] = dims(file);
  const cropH = Math.min(h, Math.round((w * aspectH) / aspectW));
  const cropW = Math.min(w, Math.round((cropH * aspectW) / aspectH));
  execFileSync('sips', ['-c', String(cropH), String(cropW), file, '--out', out]);
  execFileSync('sips', ['--resampleWidth', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', QUALITY, out, '--out', out]);
  console.log(`${out.slice(OUT.length)}  ${Math.round(statSync(out).size / 1024)} KB`);
}

mkdirSync(OUT, { recursive: true });
for (const s of SHOTS) for (const w of s.widths) render(SRC + s.src, `${OUT}${s.name}-${w}.jpg`, ...(s.aspect ?? [16, 9]), w);
// Open Graph / Twitter card: 1200 × 630
render(SRC + 'iphone-6.9-2-los.jpg', `${OUT}og.jpg`, 40, 21, 1200);
