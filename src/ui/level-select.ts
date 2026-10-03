/**
 * Level picker cards (name, blurb, best lap, Race / Free Fly; the seeded Infinite World offers Free Fly and
 * Worlds…) with procedural canvas thumbnails.
 */
import './level-select.css';
import type { LevelId } from '../types';
import { formatTime } from './format';

export interface LevelCard {
  id: LevelId;
  name: string;
  blurb: string;
  best: number | null;
  /** 'seeded' levels (Infinite) have no race of their own: Free Fly + Worlds… */
  kind?: 'authored' | 'seeded';
  /** replaces the best-lap line (Infinite: the last world flown) */
  note?: string;
}

/** What a level run starts as. */
export type LevelMode = 'race' | 'freefly';
/** A card button: a run mode, or the Worlds screen of a seeded level. */
export type LevelCardMode = LevelMode | 'worlds';

const THUMB_W = 480;
const THUMB_H = 270;

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Infinite is seeded even when the card comes without a `kind` (older publishers). */
export const isSeededCard = (c: Pick<LevelCard, 'id' | 'kind'>): boolean => c.kind === 'seeded' || c.id === 'infinite';

/** `data-act` of a card button; parsed back by `parseLevelAct`. */
export const levelAct = (mode: LevelCardMode, id: LevelId): string => `level-${mode}:${id}`;

export function parseLevelAct(act: string): { mode: LevelCardMode; id: string } | null {
  const m = /^level-(race|freefly|worlds):([a-z-]+)$/.exec(act);
  return m ? { mode: m[1] as LevelCardMode, id: m[2]! } : null;
}

/** Card buttons in order: [primary, secondary]. */
export function cardModes(c: Pick<LevelCard, 'id' | 'kind'>): readonly [LevelCardMode, LevelCardMode] {
  return isSeededCard(c) ? ['freefly', 'worlds'] : ['race', 'freefly'];
}

const MODE_LABEL: Record<LevelCardMode, string> = { race: 'Race', freefly: 'Free Fly', worlds: 'Worlds…' };

export function levelCardsHtml(cards: readonly LevelCard[], current: LevelId): string {
  return cards
    .map((c) => {
      const name = esc(c.name);
      const best =
        c.note !== undefined
          ? `<span class="ds-lvl__note">${esc(c.note)}</span>`
          : c.best === null
            ? '<span class="ds-lvl__none">No lap yet</span>'
            : `<span class="ds-label">Best</span> <span class="ds-num">${formatTime(c.best)}</span>`;
      const btns = cardModes(c)
        .map((m, i) => {
          const label = MODE_LABEL[m];
          return `<button type="button" class="ds-btn ds-btn--sm${i === 0 ? ' ds-btn--primary' : ''}" data-nav data-act="${levelAct(m, c.id)}" aria-label="${label.replace('…', '')} · ${name}"><span>${label}</span></button>`;
        })
        .join('');
      return `
      <article class="ds-lvl${c.id === current ? ' is-current' : ''}" data-level="${c.id}" aria-label="${name}">
        <canvas class="ds-lvl__thumb" width="${THUMB_W}" height="${THUMB_H}" data-thumb="${c.id}" aria-hidden="true"></canvas>
        <div class="ds-lvl__body">
          <h3 class="ds-lvl__name">${name}${c.id === current ? '<span class="ds-lvl__tag">Selected</span>' : ''}</h3>
          <p class="ds-lvl__blurb">${esc(c.blurb)}</p>
          <p class="ds-lvl__best" data-f="best">${best}</p>
        </div>
        <div class="ds-lvl__acts">${btns}</div>
      </article>`;
    })
    .join('');
}

const THUMBS: Record<string, (ctx: CanvasRenderingContext2D, w: number, h: number) => void> = {
  training: drawTraining,
  'night-loft': drawLoft,
  city: drawCity,
  alpine: drawAlpine,
  infinite: drawInfinite,
};

/** Paint every `canvas[data-thumb]` under `root`. Unknown ids get a neutral card. */
export function drawThumbs(root: HTMLElement): void {
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-thumb]').forEach((cv) => {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    (THUMBS[cv.dataset.thumb ?? ''] ?? drawBlank)(ctx, cv.width, cv.height);
  });
}

/** A level's card art at any size (the loading screen draws it full-bleed). */
export function drawLevelArt(ctx: CanvasRenderingContext2D, id: string, w: number, h: number): void {
  (THUMBS[id] ?? drawBlank)(ctx, w, h);
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string, w: number): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = w * 4;
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Daylight meadow from the pilot's spot: sky, sun, hills, treeline, mowed stripes, pad and three rings. */
function drawTraining(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = h * 0.5;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#2f78d0');
  sky.addColorStop(1, '#d6e7ee');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);
  const sun = ctx.createRadialGradient(w * 0.16, h * 0.18, 0, w * 0.16, h * 0.18, h * 0.32);
  sun.addColorStop(0, 'rgba(255,246,220,1)');
  sun.addColorStop(0.12, 'rgba(255,236,190,0.9)');
  sun.addColorStop(1, 'rgba(255,226,170,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, horizon);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (const [cx, cy, s] of [
    [0.55, 0.16, 1],
    [0.8, 0.26, 0.7],
    [0.36, 0.3, 0.55],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(w * cx, h * cy, w * 0.07 * s, h * 0.035 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(w * (cx + 0.05 * s), h * (cy + 0.012), w * 0.06 * s, h * 0.03 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#8fae9a';
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.quadraticCurveTo(w * 0.18, horizon - h * 0.16, w * 0.42, horizon);
  ctx.quadraticCurveTo(w * 0.7, horizon - h * 0.2, w, horizon - h * 0.04);
  ctx.lineTo(w, horizon);
  ctx.fill();
  ctx.fillStyle = '#3f6e45';
  for (let i = 0; i < 26; i++) {
    const x = (i / 25) * w;
    const th = h * (0.035 + ((i * 37) % 11) / 220);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.025, horizon + 1);
    ctx.lineTo(x, horizon - th);
    ctx.lineTo(x + w * 0.025, horizon + 1);
    ctx.fill();
  }
  // mowed stripes converge on a vanishing point above the horizon centre
  const vx = w * 0.5;
  for (let i = -6; i < 6; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#74a548' : '#649a3f';
    ctx.beginPath();
    ctx.moveTo(vx + i * w * 0.03, horizon);
    ctx.lineTo(vx + (i + 1) * w * 0.03, horizon);
    ctx.lineTo(vx + (i + 1) * w * 0.32, h);
    ctx.lineTo(vx + i * w * 0.32, h);
    ctx.fill();
  }
  ctx.fillStyle = '#34373c';
  ctx.beginPath();
  ctx.moveTo(w * 0.38, h * 0.84);
  ctx.lineTo(w * 0.62, h * 0.84);
  ctx.lineTo(w * 0.7, h);
  ctx.lineTo(w * 0.3, h);
  ctx.fill();
  ctx.strokeStyle = '#ff6a1f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.92, w * 0.09, h * 0.035, 0, 0, Math.PI * 2);
  ctx.stroke();
  for (const [px, top] of [
    [0.07, 0.3],
    [0.93, 0.3],
  ] as const) {
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = k % 2 === 0 ? '#e2462f' : '#f3efe6';
      ctx.fillRect(w * px - 2, h * (top + k * 0.035), 4, h * 0.035);
    }
  }
  ring(ctx, w * 0.5, h * 0.5, w * 0.075, h * 0.13, '#28e7ff', 4);
  ring(ctx, w * 0.72, h * 0.42, w * 0.03, h * 0.07, '#ff3de8', 3);
  ring(ctx, w * 0.3, h * 0.62, w * 0.11, h * 0.15, '#ff3de8', 4);
}

/** Night loft: brick wall, moonlit windows, neon sign, warm bulbs and glowing rings. */
function drawLoft(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0b1222');
  bg.addColorStop(1, '#05070d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(160,90,70,0.16)';
  ctx.lineWidth = 1;
  for (let y = 0; y < h * 0.72; y += 12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    for (let x = (y / 12) % 2 === 0 ? 0 : 18; x < w; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 12);
      ctx.stroke();
    }
  }
  for (const wx of [0.18, 0.56]) {
    const g = ctx.createLinearGradient(0, h * 0.1, 0, h * 0.45);
    g.addColorStop(0, 'rgba(150,185,255,0.75)');
    g.addColorStop(1, 'rgba(60,90,170,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(w * wx, h * 0.1, w * 0.18, h * 0.32);
    ctx.fillStyle = 'rgba(5,8,14,0.9)';
    ctx.fillRect(w * (wx + 0.088), h * 0.1, 3, h * 0.32);
    ctx.fillRect(w * wx, h * 0.25, w * 0.18, 3);
  }
  const floor = ctx.createLinearGradient(0, h * 0.72, 0, h);
  floor.addColorStop(0, '#1a1b20');
  floor.addColorStop(1, '#0c0d10');
  ctx.fillStyle = floor;
  ctx.fillRect(0, h * 0.72, w, h * 0.28);
  ctx.save();
  ctx.font = `italic 800 ${Math.round(h * 0.13)}px system-ui, sans-serif`;
  ctx.fillStyle = '#ff7ad9';
  ctx.shadowColor = '#ff3de8';
  ctx.shadowBlur = 18;
  ctx.fillText('FPV', w * 0.81, h * 0.36);
  ctx.restore();
  for (const [bx, by] of [
    [0.42, 0.2],
    [0.47, 0.26],
    [0.88, 0.5],
  ] as const) {
    const g = ctx.createRadialGradient(w * bx, h * by, 0, w * bx, h * by, h * 0.12);
    g.addColorStop(0, 'rgba(255,200,120,1)');
    g.addColorStop(1, 'rgba(255,160,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(w * bx - h * 0.12, h * by - h * 0.12, h * 0.24, h * 0.24);
  }
  ring(ctx, w * 0.3, h * 0.6, w * 0.06, h * 0.12, '#28e7ff', 4);
  ring(ctx, w * 0.55, h * 0.55, w * 0.04, h * 0.085, '#ff3de8', 3);
  ring(ctx, w * 0.72, h * 0.62, w * 0.03, h * 0.065, '#28e7ff', 2.5);
}

function drawBlank(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#0d1424';
  ctx.fillRect(0, 0, w, h);
  ring(ctx, w / 2, h / 2, w * 0.1, h * 0.18, '#28e7ff', 4);
}

/** Small deterministic generator so a thumbnail looks the same on every visit. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vGradient(ctx: CanvasRenderingContext2D, y0: number, y1: number, stops: readonly [number, string][]): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, inner: string, outer: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** One skyline layer: buildings standing on `base`, lit windows drawn when `lit` > 0. */
function skyline(ctx: CanvasRenderingContext2D, w: number, base: number, o: { seed: number; minH: number; maxH: number; minW: number; maxW: number; color: string; lit: number; win: number }): void {
  const r = rng(o.seed);
  let x = -r() * o.maxW;
  while (x < w) {
    const bw = o.minW + r() * (o.maxW - o.minW);
    // a few towers rise well above the block
    const tall = r() < 0.18 ? 1.5 : 1;
    const bh = (o.minH + r() * (o.maxH - o.minH)) * tall;
    ctx.fillStyle = o.color;
    ctx.fillRect(x, base - bh, bw - 1, bh);
    if (r() < 0.3) ctx.fillRect(x + bw * 0.4, base - bh - o.win * 3, Math.max(1, bw * 0.06), o.win * 3);
    if (o.lit > 0) {
      const cols = Math.max(1, Math.floor((bw - 4) / (o.win * 2)));
      const rows = Math.floor((bh - 6) / (o.win * 2.2));
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if (r() > o.lit) continue;
          ctx.fillStyle = r() < 0.82 ? `rgba(255, ${200 + Math.floor(r() * 40)}, ${120 + Math.floor(r() * 50)}, ${0.55 + r() * 0.4})` : 'rgba(150, 230, 255, 0.8)';
          ctx.fillRect(x + 3 + i * o.win * 2, base - bh + 5 + j * o.win * 2.2, o.win, o.win * 1.1);
        }
      }
    }
    x += bw + r() * 3;
  }
}

/** City at dusk: banded sky, low sun, three skyline layers with lit windows, river reflection, rings in a canyon. */
function drawCity(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = h * 0.74;
  ctx.fillStyle = vGradient(ctx, 0, horizon, [
    [0, '#1b1e4a'],
    [0.38, '#4a2c6e'],
    [0.66, '#b2476f'],
    [0.86, '#f08a4b'],
    [1, '#ffc37a'],
  ]);
  ctx.fillRect(0, 0, w, horizon);
  const st = rng(7);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  for (let i = 0; i < 40; i++) ctx.fillRect(st() * w, st() * h * 0.3, 1, 1);
  glow(ctx, w * 0.7, horizon - h * 0.1, h * 0.42, 'rgba(255, 214, 140, 0.9)', 'rgba(255, 140, 80, 0)');
  ctx.fillStyle = '#ffe2a8';
  ctx.beginPath();
  ctx.arc(w * 0.7, horizon - h * 0.1, h * 0.06, 0, Math.PI * 2);
  ctx.fill();
  skyline(ctx, w, horizon, { seed: 3, minH: h * 0.12, maxH: h * 0.3, minW: w * 0.03, maxW: w * 0.07, color: '#6b4f86', lit: 0, win: 2 });
  skyline(ctx, w, horizon + 2, { seed: 11, minH: h * 0.16, maxH: h * 0.42, minW: w * 0.05, maxW: w * 0.1, color: '#2e2850', lit: 0.28, win: 2 });
  skyline(ctx, w, horizon + 6, { seed: 23, minH: h * 0.08, maxH: h * 0.22, minW: w * 0.07, maxW: w * 0.13, color: '#161630', lit: 0.4, win: 3 });
  // river: the sky and the lights, broken into ripples
  ctx.fillStyle = vGradient(ctx, horizon + 6, h, [
    [0, '#f2a066'],
    [0.35, '#7d3d6a'],
    [1, '#141433'],
  ]);
  ctx.fillRect(0, horizon + 6, w, h - horizon - 6);
  const rp = rng(41);
  for (let i = 0; i < 70; i++) {
    const y = horizon + 8 + rp() * (h - horizon - 8);
    ctx.fillStyle = rp() < 0.5 ? 'rgba(255, 220, 160, 0.35)' : 'rgba(20, 16, 50, 0.35)';
    ctx.fillRect(rp() * w, y, w * (0.02 + rp() * 0.08), 1.5);
  }
  ctx.fillStyle = 'rgba(10, 10, 26, 0.9)';
  ctx.fillRect(0, horizon + 4, w, 3);
  ring(ctx, w * 0.36, h * 0.5, w * 0.06, h * 0.12, '#ff3de8', 4);
  ring(ctx, w * 0.52, h * 0.42, w * 0.035, h * 0.075, '#28e7ff', 3);
  ring(ctx, w * 0.62, h * 0.38, w * 0.022, h * 0.05, '#28e7ff', 2.5);
}

/** Alpine valley at golden hour: ridges with snow, pine slopes, a still lake with reflections and a hamlet. */
function drawAlpine(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const lakeY = h * 0.66;
  ctx.fillStyle = vGradient(ctx, 0, lakeY, [
    [0, '#3d7cc9'],
    [0.55, '#9cc3e0'],
    [1, '#f6d6a3'],
  ]);
  ctx.fillRect(0, 0, w, lakeY);
  glow(ctx, w * 0.82, h * 0.2, h * 0.36, 'rgba(255, 236, 190, 0.95)', 'rgba(255, 220, 160, 0)');
  const ridge = (seed: number, base: number, amp: number, color: string, snow: string | null, step: number): number[] => {
    const r = rng(seed);
    const pts: number[] = [];
    let y = base - amp * 0.5;
    for (let x = 0; x <= w + step; x += step) {
      y = Math.min(base, Math.max(base - amp, y + (r() - 0.5) * amp * 0.55));
      pts.push(x, y);
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, lakeY);
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    ctx.lineTo(w, lakeY);
    ctx.closePath();
    ctx.fill();
    if (snow) {
      // caps: the top band of every peak
      ctx.fillStyle = snow;
      for (let i = 2; i < pts.length - 2; i += 2) {
        const py = pts[i + 1]!;
        if (py > base - amp * 0.62) continue;
        if (py > pts[i - 1]! || py > pts[i + 3]!) continue;
        const px = pts[i]!;
        const d = amp * 0.16;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + step * 0.7, py + d);
        ctx.lineTo(px + step * 0.25, py + d * 0.7);
        ctx.lineTo(px - step * 0.2, py + d * 1.05);
        ctx.lineTo(px - step * 0.7, py + d);
        ctx.closePath();
        ctx.fill();
      }
    }
    return pts;
  };
  ridge(5, lakeY - h * 0.22, h * 0.36, '#8aa1bf', '#f4f1ea', w / 18);
  ridge(9, lakeY - h * 0.08, h * 0.32, '#56708a', '#e9eef2', w / 14);
  // pine slopes framing the valley
  const slope = (left: boolean): void => {
    ctx.fillStyle = '#2c4a37';
    ctx.beginPath();
    if (left) {
      ctx.moveTo(0, h * 0.34);
      ctx.quadraticCurveTo(w * 0.22, h * 0.48, w * 0.4, lakeY);
      ctx.lineTo(0, lakeY);
    } else {
      ctx.moveTo(w, h * 0.4);
      ctx.quadraticCurveTo(w * 0.8, h * 0.52, w * 0.62, lakeY);
      ctx.lineTo(w, lakeY);
    }
    ctx.fill();
    const r = rng(left ? 17 : 19);
    for (let i = 0; i < 70; i++) {
      const t = r();
      const x = left ? t * w * 0.4 : w - t * w * 0.38;
      const top = left ? h * 0.34 + (lakeY - h * 0.34) * (t * t) : h * 0.4 + (lakeY - h * 0.4) * (t * t);
      const y = top + r() * (lakeY - top);
      const s = h * (0.03 + r() * 0.035);
      ctx.fillStyle = r() < 0.5 ? '#1d3a2b' : '#24452f';
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s * 0.38, y);
      ctx.lineTo(x - s * 0.38, y);
      ctx.fill();
    }
  };
  slope(true);
  slope(false);
  // hamlet on the far shore
  const hr = rng(29);
  for (let i = 0; i < 6; i++) {
    const x = w * (0.47 + i * 0.022 + hr() * 0.01);
    const y = lakeY - 2 - hr() * 3;
    ctx.fillStyle = '#efe4d2';
    ctx.fillRect(x, y - 5, 7, 5);
    ctx.fillStyle = '#9b3d2c';
    ctx.beginPath();
    ctx.moveTo(x - 1, y - 5);
    ctx.lineTo(x + 3.5, y - 8.5);
    ctx.lineTo(x + 8, y - 5);
    ctx.fill();
  }
  // lake: sky colours and a soft mirror of the slopes
  ctx.fillStyle = vGradient(ctx, lakeY, h, [
    [0, '#e9cf9f'],
    [0.25, '#7fa6c4'],
    [1, '#2c5677'],
  ]);
  ctx.fillRect(0, lakeY, w, h - lakeY);
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#1f3b2d';
  ctx.beginPath();
  ctx.moveTo(0, lakeY);
  ctx.quadraticCurveTo(w * 0.22, lakeY + h * 0.14, w * 0.4, lakeY);
  ctx.moveTo(w, lakeY);
  ctx.quadraticCurveTo(w * 0.8, lakeY + h * 0.11, w * 0.62, lakeY);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  const lr = rng(31);
  for (let i = 0; i < 26; i++) ctx.fillRect(lr() * w, lakeY + 4 + lr() * (h - lakeY - 4), w * (0.02 + lr() * 0.05), 1);
  ring(ctx, w * 0.42, h * 0.56, w * 0.05, h * 0.1, '#ff3de8', 3.5);
  ring(ctx, w * 0.58, h * 0.47, w * 0.03, h * 0.065, '#28e7ff', 3);
  ring(ctx, w * 0.42, lakeY + h * 0.2, w * 0.05, h * 0.06, 'rgba(255, 61, 232, 0.35)', 2);
}

/**
 * Infinite countryside from the drone: a ground plane in perspective with patchwork fields, a winding river, a
 * road with a village, tree clumps and hazy hills.
 */
function drawInfinite(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const horizon = h * 0.3;
  const camH = 60;
  const f = w * 0.9;
  const project = (x: number, z: number): [number, number] => [w / 2 + (x * f) / z, horizon + (camH * f) / z];
  ctx.fillStyle = vGradient(ctx, 0, horizon, [
    [0, '#5b9be0'],
    [1, '#d9ebf5'],
  ]);
  ctx.fillRect(0, 0, w, horizon + 1);
  const cl = rng(2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  for (let i = 0; i < 6; i++) {
    const cx = cl() * w;
    const cy = h * (0.06 + cl() * 0.14);
    const s = 0.5 + cl() * 0.7;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.06 * s, h * 0.025 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + w * 0.04 * s, cy - h * 0.012 * s, w * 0.045 * s, h * 0.028 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // hazy hills on the horizon
  ctx.fillStyle = '#9fb7a8';
  ctx.beginPath();
  ctx.moveTo(0, horizon + 2);
  for (let x = 0; x <= w; x += w / 12) ctx.lineTo(x, horizon - h * (0.03 + 0.03 * Math.sin(x * 0.021) + 0.02 * Math.sin(x * 0.057)));
  ctx.lineTo(w, horizon + 2);
  ctx.fill();
  // patchwork fields, far to near so the near ones overlap
  const fr = rng(13);
  const palette = ['#7fae52', '#8db85a', '#a7b45c', '#c8b46a', '#6d9d4a', '#94a84e', '#b9c574', '#5f8f43'];
  const cell = 40;
  for (let zi = 40; zi >= 1; zi--) {
    for (let xi = -24; xi < 24; xi++) {
      const z0 = zi * cell;
      const z1 = z0 + cell;
      const x0 = xi * cell + ((zi * 13) % 7) * 3;
      const x1 = x0 + cell;
      const a = project(x0, z1);
      const b = project(x1, z1);
      const c = project(x1, z0);
      const d = project(x0, z0);
      if (c[0] < -w || d[0] > 2 * w) continue;
      ctx.fillStyle = palette[Math.floor(fr() * palette.length)]!;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(d[0], d[1]);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(60, 80, 40, 0.25)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }
  // distance haze over the far fields
  ctx.fillStyle = vGradient(ctx, horizon, horizon + h * 0.22, [
    [0, 'rgba(214, 232, 240, 0.85)'],
    [1, 'rgba(214, 232, 240, 0)'],
  ]);
  ctx.fillRect(0, horizon, w, h * 0.22);
  const ribbon = (path: (z: number) => number, width: number, color: string, edge: string | null): void => {
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let z = 1600; z >= 22; z *= 0.94) {
      const x = path(z);
      left.push(project(x - width / 2, z));
      right.push(project(x + width / 2, z));
    }
    ctx.beginPath();
    ctx.moveTo(left[0]![0], left[0]![1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i]![0], right[i]![1]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (edge) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  ribbon((z) => -120 + 140 * Math.sin(z / 260) + 40 * Math.sin(z / 90), 26, '#3f86c8', 'rgba(230, 240, 220, 0.6)');
  ribbon((z) => 60 + 0.18 * z - 70 * Math.sin(z / 400), 9, '#e3dac4', 'rgba(90, 80, 60, 0.35)');
  // tree clumps and a village along the road
  const tr = rng(57);
  for (let i = 0; i < 90; i++) {
    const z = 60 + tr() * 900;
    const x = (tr() - 0.5) * z * 1.1;
    const [px, py] = project(x, z);
    const s = Math.max(1.2, 900 / z);
    ctx.fillStyle = tr() < 0.5 ? '#2f5a33' : '#3b6b3a';
    ctx.beginPath();
    ctx.arc(px, py - s, s, 0, Math.PI * 2);
    ctx.fill();
  }
  const vr = rng(61);
  for (let i = 0; i < 14; i++) {
    const z = 150 + vr() * 90;
    const x = 60 + 0.18 * z - 70 * Math.sin(z / 400) + (vr() < 0.5 ? -1 : 1) * (10 + vr() * 18);
    const [px, py] = project(x, z);
    const s = 1100 / z;
    ctx.fillStyle = '#f1e8da';
    ctx.fillRect(px - s, py - s * 1.1, s * 2, s * 1.1);
    ctx.fillStyle = vr() < 0.6 ? '#b2483a' : '#6b5b52';
    ctx.beginPath();
    ctx.moveTo(px - s * 1.2, py - s * 1.1);
    ctx.lineTo(px, py - s * 2);
    ctx.lineTo(px + s * 1.2, py - s * 1.1);
    ctx.fill();
  }
  ring(ctx, w * 0.5, h * 0.52, w * 0.06, h * 0.13, '#28e7ff', 4);
  ring(ctx, w * 0.66, h * 0.42, w * 0.03, h * 0.07, '#ff3de8', 3);
}
