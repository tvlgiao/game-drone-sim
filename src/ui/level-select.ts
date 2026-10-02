/** Level picker cards (name, blurb, best lap, Race / Free Fly) with procedural canvas thumbnails. */
import './level-select.css';
import type { LevelId } from '../types';
import { formatTime } from './format';

export interface LevelCard {
  id: LevelId;
  name: string;
  blurb: string;
  best: number | null;
}

export type LevelMode = 'race' | 'freefly';

const THUMB_W = 480;
const THUMB_H = 270;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `data-act` of a card button; parsed back by `parseLevelAct`. */
export const levelAct = (mode: LevelMode, id: LevelId): string => `level-${mode}:${id}`;

export function parseLevelAct(act: string): { mode: LevelMode; id: string } | null {
  const m = /^level-(race|freefly):([a-z-]+)$/.exec(act);
  return m ? { mode: m[1] as LevelMode, id: m[2]! } : null;
}

export function levelCardsHtml(cards: readonly LevelCard[], current: LevelId): string {
  return cards
    .map((c) => {
      const name = esc(c.name);
      const best = c.best === null ? '<span class="ds-lvl__none">No lap yet</span>' : `<span class="ds-label">Best</span> <span class="ds-num">${formatTime(c.best)}</span>`;
      return `
      <article class="ds-lvl${c.id === current ? ' is-current' : ''}" data-level="${c.id}" aria-label="${name}">
        <canvas class="ds-lvl__thumb" width="${THUMB_W}" height="${THUMB_H}" data-thumb="${c.id}" aria-hidden="true"></canvas>
        <div class="ds-lvl__body">
          <h3 class="ds-lvl__name">${name}${c.id === current ? '<span class="ds-lvl__tag">Selected</span>' : ''}</h3>
          <p class="ds-lvl__blurb">${esc(c.blurb)}</p>
          <p class="ds-lvl__best" data-f="best">${best}</p>
        </div>
        <div class="ds-lvl__acts">
          <button type="button" class="ds-btn ds-btn--sm ds-btn--primary" data-nav data-act="${levelAct('race', c.id)}" aria-label="Race · ${name}"><span>Race</span></button>
          <button type="button" class="ds-btn ds-btn--sm" data-nav data-act="${levelAct('freefly', c.id)}" aria-label="Free Fly · ${name}"><span>Free Fly</span></button>
        </div>
      </article>`;
    })
    .join('');
}

/** Paint every `canvas[data-thumb]` under `root`. Unknown ids get a neutral card. */
export function drawThumbs(root: HTMLElement): void {
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-thumb]').forEach((cv) => {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const id = cv.dataset.thumb;
    if (id === 'training') drawTraining(ctx, cv.width, cv.height);
    else if (id === 'night-loft') drawLoft(ctx, cv.width, cv.height);
    else drawBlank(ctx, cv.width, cv.height);
  });
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
