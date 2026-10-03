/**
 * Canvas-drawn loft art (needs a DOM): the decal atlas (posters, stencils, scuffs, stains, tape) and the
 * neon sign atlas. All drawn procedurally; no fonts or images are downloaded.
 */
import * as THREE from 'three';
import { mulberry32 } from '../materials/texgen';

/** Decal atlas: 4 × 4 cells; `DECAL` names each cell. */
export const DECAL_GRID = 4;
export const DECAL = {
  posterRace: 0,
  posterClub: 1,
  posterWave: 2,
  blueprint: 3,
  noSmoking: 4,
  landingMat: 5,
  scuffs: 6,
  splatter: 7,
  oil: 8,
  hazardTape: 9,
  loadLimit: 10,
  waterStain: 11,
  fragile: 12,
  droneParts: 13,
  tag: 14,
  tireMarks: 15,
} as const;

/** UV rect (u0, v0, u1, v1) of an atlas cell (canvas textures are flipped: row 0 is the top). */
export function decalRect(cell: number): [number, number, number, number] {
  const c = cell % DECAL_GRID;
  const r = Math.floor(cell / DECAL_GRID);
  const s = 1 / DECAL_GRID;
  const pad = s * 0.01;
  return [c * s + pad, 1 - (r + 1) * s + pad, (c + 1) * s - pad, 1 - r * s - pad];
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Paper ageing: speckle, edge darkening and a few creases over the current cell. */
function age(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rnd: () => number, amount = 1): void {
  const g = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.3, x + w / 2, y + h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(60,40,20,0)');
  g.addColorStop(1, `rgba(60,40,20,${0.35 * amount})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  for (let i = 0; i < 400 * amount; i++) {
    ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
    ctx.fillRect(x + rnd() * w, y + rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.moveTo(x + rnd() * w, y);
    ctx.lineTo(x + rnd() * w, y + h);
    ctx.stroke();
  }
}

/** Torn / tape corners for a poster occupying the cell. */
function tape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = 'rgba(230,225,200,0.75)';
  for (const [cx, cy, a] of [[x + 10, y + 10, -0.6], [x + w - 10, y + 10, 0.6], [x + 10, y + h - 10, 0.6], [x + w - 10, y + h - 10, -0.6]] as const) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillRect(-26, -8, 52, 16);
    ctx.restore();
  }
}

export function decalAtlas(size: number): THREE.CanvasTexture {
  const [c, ctx] = canvas(size, size);
  const cs = size / DECAL_GRID;
  const k = cs / 512;
  const rnd = mulberry32(2026);
  const cell = (i: number, draw: (x: number, y: number, s: number) => void) => {
    const x = (i % DECAL_GRID) * cs;
    const y = Math.floor(i / DECAL_GRID) * cs;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cs, cs);
    ctx.clip();
    ctx.translate(x, y);
    ctx.scale(k, k);
    draw(0, 0, 512);
    ctx.restore();
  };

  cell(DECAL.posterRace, (x, y, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, '#120c2e');
    g.addColorStop(0.55, '#5a1660');
    g.addColorStop(1, '#ff6a3d');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, s, s);
    // sun bands
    ctx.fillStyle = '#ffb347';
    ctx.beginPath();
    ctx.arc(s / 2, s * 0.62, s * 0.24, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#5a1660';
    for (let i = 0; i < 5; i++) ctx.fillRect(s * 0.2, s * 0.5 + i * 18, s * 0.6, 4 + i * 2);
    // quad silhouette
    ctx.fillStyle = '#0b0b14';
    ctx.save();
    ctx.translate(s / 2, s * 0.36);
    ctx.fillRect(-60, -10, 120, 20);
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(sx * 78, -14, 46, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(sx * 78 - 5, -14, 10, 24);
    }
    ctx.restore();
    ctx.fillStyle = '#ffe9d0';
    ctx.font = `900 italic 86px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('FPV', s / 2, s * 0.86);
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText('NIGHT  RACES', s / 2, s * 0.94);
    ctx.font = `600 22px ${FONT}`;
    ctx.fillStyle = '#ffd8f0';
    ctx.fillText('FRIDAY · 9 PM · LOFT 7', s / 2, s * 0.12);
    age(ctx, x, y, s, s, rnd, 0.8);
    tape(ctx, x, y, s, s);
  });

  cell(DECAL.posterClub, (x, y, s) => {
    ctx.fillStyle = '#e9e1cc';
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(30, 30, s - 60, 150);
    ctx.fillStyle = '#e9e1cc';
    ctx.font = `900 64px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('DRONE', s / 2, 105);
    ctx.font = `800 46px ${FONT}`;
    ctx.fillText('CLUB', s / 2, 160);
    ctx.strokeStyle = '#1d2a44';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(s / 2, 320, 95, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 6;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(s / 2, 320);
      ctx.lineTo(s / 2 + Math.cos(a) * 95, 320 + Math.sin(a) * 95);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s / 2 + Math.cos(a) * 95, 320 + Math.sin(a) * 95, 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#1d2a44';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText('EST. 2019  ·  MEMBERS ONLY', s / 2, 480);
    age(ctx, x, y, s, s, rnd, 1.1);
  });

  cell(DECAL.posterWave, (x, y, s) => {
    ctx.fillStyle = '#0d1f2b';
    ctx.fillRect(x, y, s, s);
    for (let i = 0; i < 14; i++) {
      ctx.strokeStyle = `hsl(${180 + i * 6}, 80%, ${45 + i * 2}%)`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      for (let t = 0; t <= s; t += 8) {
        const yy = 120 + i * 22 + Math.sin(t * 0.02 + i * 0.6) * 30;
        if (t === 0) ctx.moveTo(t, yy);
        else ctx.lineTo(t, yy);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#f5f0e6';
    ctx.font = `800 54px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('SIGNAL', 34, 470);
    ctx.font = `500 22px ${FONT}`;
    ctx.fillText('5.8 GHz  ·  LIVE SET', 36, 80);
    age(ctx, x, y, s, s, rnd, 0.6);
    tape(ctx, x, y, s, s);
  });

  cell(DECAL.blueprint, (x, y, s) => {
    ctx.fillStyle = '#16407a';
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= s; i += 16) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, s);
      ctx.moveTo(0, i);
      ctx.lineTo(s, i);
      ctx.stroke();
    }
    ctx.strokeStyle = '#e8f1ff';
    ctx.lineWidth = 3;
    ctx.strokeRect(186, 186, 140, 140);
    for (const [cx, cy] of [[140, 140], [372, 140], [140, 372], [372, 372]]) {
      ctx.beginPath();
      ctx.arc(cx!, cy!, 82, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx!, cy!, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(256, 256);
      ctx.lineTo(cx!, cy!);
      ctx.stroke();
    }
    ctx.font = `600 18px ${FONT}`;
    ctx.fillStyle = '#e8f1ff';
    ctx.fillText('CINEWHOOP 3" — TOP VIEW   SCALE 1:2', 24, 490);
    ctx.fillText('DWG 07-A', 400, 30);
    age(ctx, x, y, s, s, rnd, 0.5);
  });

  cell(DECAL.noSmoking, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(240,236,226,0.92)';
    ctx.fillRect(56, 120, 400, 272);
    ctx.strokeStyle = '#c62828';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(160, 256, 70, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.fillRect(110, 248, 90, 18);
    ctx.beginPath();
    ctx.moveTo(112, 206);
    ctx.lineTo(208, 306);
    ctx.stroke();
    ctx.fillStyle = '#c62828';
    ctx.font = `900 46px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('NO', 262, 238);
    ctx.fillText('SMOKING', 262, 292);
  });

  cell(DECAL.landingMat, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(28,30,34,0.95)';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, 248, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ff7a1a';
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, 214, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#e8eef5';
    ctx.font = `900 230px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', s / 2, s / 2 + 10);
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < 1600; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.15 * rnd()})`;
      ctx.fillRect(rnd() * s, rnd() * s, 3, 3);
    }
  });

  cell(DECAL.scuffs, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const x0 = 40 + rnd() * 430;
      const y0 = 40 + rnd() * 430;
      const a = rnd() * Math.PI * 2;
      const l = 20 + rnd() * 90;
      ctx.strokeStyle = `rgba(15,12,10,${0.25 + rnd() * 0.4})`;
      ctx.lineWidth = 2 + rnd() * 7;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + Math.cos(a + 0.4) * l * 0.5, y0 + Math.sin(a + 0.4) * l * 0.5, x0 + Math.cos(a) * l, y0 + Math.sin(a) * l);
      ctx.stroke();
    }
  });

  cell(DECAL.splatter, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    const cols = ['rgba(240,240,235,0.9)', 'rgba(30,140,200,0.85)', 'rgba(230,180,30,0.85)'];
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = cols[k]!;
      const cx = 140 + k * 120 + rnd() * 40;
      const cy = 180 + rnd() * 160;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 + rnd() * 30, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 40; i++) {
        const a = rnd() * Math.PI * 2;
        const d = 30 + rnd() * 120;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 1 + rnd() * 8 * (1 - d / 160), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  cell(DECAL.oil, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 7; i++) {
      const cx = s / 2 + (rnd() - 0.5) * 160;
      const cy = s / 2 + (rnd() - 0.5) * 160;
      const r = 50 + rnd() * 130;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(10,8,6,0.55)');
      g.addColorStop(0.7, 'rgba(14,11,8,0.35)');
      g.addColorStop(1, 'rgba(14,11,8,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r, r * (0.6 + rnd() * 0.4), rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  cell(DECAL.hazardTape, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#f2c018';
    ctx.fillRect(0, 216, s, 80);
    ctx.fillStyle = '#151515';
    for (let i = -2; i < 14; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 48, 296);
      ctx.lineTo(i * 48 + 24, 296);
      ctx.lineTo(i * 48 + 24 + 80, 216);
      ctx.lineTo(i * 48 + 80, 216);
      ctx.fill();
    }
    for (let i = 0; i < 500; i++) {
      ctx.clearRect(rnd() * s, 216 + rnd() * 80, 2 + rnd() * 3, 2);
    }
  });

  cell(DECAL.loadLimit, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(245,240,228,0.85)';
    ctx.font = `800 64px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('LOAD LIMIT', s / 2, 230);
    ctx.font = `900 92px ${FONT}`;
    ctx.fillText('500 KG', s / 2, 330);
    for (let i = 0; i < 900; i++) ctx.clearRect(rnd() * s, 150 + rnd() * 200, 2 + rnd() * 4, 2 + rnd() * 3);
  });

  cell(DECAL.waterStain, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      const x0 = 60 + rnd() * 390;
      const w = 4 + rnd() * 18;
      const l = 120 + rnd() * 360;
      const g = ctx.createLinearGradient(0, 0, 0, l);
      g.addColorStop(0, 'rgba(25,20,14,0.38)');
      g.addColorStop(1, 'rgba(25,20,14,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x0, 0, w, l);
    }
  });

  const stencil = (text: string, sub: string) => (_x: number, _y: number, s: number) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(25,22,18,0.82)';
    ctx.font = `900 ${text.length > 7 ? 70 : 96}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(text, s / 2, 250);
    ctx.font = `800 52px ${FONT}`;
    ctx.fillText(sub, s / 2, 330);
    for (let i = 0; i < 700; i++) ctx.clearRect(rnd() * s, 150 + rnd() * 220, 2 + rnd() * 5, 2 + rnd() * 3);
  };
  cell(DECAL.fragile, stencil('FRAGILE', '↑  THIS SIDE UP  ↑'));
  cell(DECAL.droneParts, stencil('DRONE', 'PARTS · NO 07'));

  cell(DECAL.tag, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.save();
    ctx.translate(s / 2, s / 2);
    ctx.rotate(-0.12);
    ctx.font = `900 italic 150px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 16;
    ctx.strokeStyle = 'rgba(20,20,24,0.9)';
    ctx.strokeText('RIP', 0, 0);
    ctx.fillStyle = 'rgba(40,200,190,0.9)';
    ctx.fillText('RIP', 0, 0);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.strokeText('RIP', -4, -4);
    ctx.restore();
    ctx.fillStyle = 'rgba(40,200,190,0.7)';
    for (let i = 0; i < 60; i++) ctx.fillRect(130 + rnd() * 260, 300 + rnd() * 30, 3, 10 + rnd() * 50);
  });

  cell(DECAL.tireMarks, (_x, _y, s) => {
    ctx.clearRect(0, 0, s, s);
    for (const off of [-40, 40]) {
      ctx.strokeStyle = 'rgba(12,10,9,0.22)';
      ctx.lineWidth = 22;
      ctx.beginPath();
      ctx.moveTo(40, 256 + off);
      ctx.bezierCurveTo(180, 230 + off, 320, 300 + off, 480, 250 + off);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(12,10,9,0.25)';
      ctx.lineWidth = 3;
      for (let k = -9; k <= 9; k += 6) {
        ctx.beginPath();
        ctx.moveTo(40, 256 + off + k);
        ctx.bezierCurveTo(180, 230 + off + k, 320, 300 + off + k, 480, 250 + off + k);
        ctx.stroke();
      }
    }
  });

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Neon sign atlas, white strokes on black (colour comes from the material / vertex colour). Top half: "FPV"; bottom: "EXIT" | "OPEN". */
export function neonAtlas(w: number): THREE.CanvasTexture {
  const h = w / 2;
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const k = w / 1024;
  ctx.scale(k, k);
  const glowText = (text: string, x: number, y: number, size: number, italic: boolean) => {
    ctx.font = `${italic ? 'italic ' : ''}700 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // halo, tube body, hot core
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 26;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 18;
    ctx.strokeText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 9;
    ctx.strokeText(text, x, y);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
  };
  glowText('FPV', 512, 128, 190, true);
  glowText('EXIT', 256, 384, 120, false);
  glowText('OPEN', 768, 384, 110, false);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
