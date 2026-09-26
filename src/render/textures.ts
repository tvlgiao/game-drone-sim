/** Procedural canvas textures (no external assets). All generators are deterministic (seeded). */
import * as THREE from 'three';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/** Tileable fbm value noise in [0,1], `size`² samples. */
export function fbmField(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  const rnd = mulberry32(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const period = basePeriod << o;
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
    const scale = period / size;
    for (let y = 0; y < size; y++) {
      const fy = y * scale;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % period) * period;
      const r1 = ((y0 + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const fx = x * scale;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % period;
        const c1 = (x0 + 1) % period;
        const a = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * sx;
        const b = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Draw `fn` at 3×3 offsets so strokes wrap around tile edges. */
function wrapDraw(size: number, fn: (ox: number, oy: number) => void): void {
  for (let oy = -size; oy <= size; oy += size) for (let ox = -size; ox <= size; ox += size) fn(ox, oy);
}

export interface PbrMaps {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  bumpMap?: THREE.CanvasTexture;
}

/** Polished concrete: mottled albedo, stains, hairline cracks, saw-cut joints; roughness variation. */
export function concreteMaps(size = 1024, seed = 7): PbrMaps {
  const n1 = fbmField(size, 4, 6, seed, 0.55);
  const n2 = fbmField(size, 16, 4, seed + 1, 0.5);
  const [ca, ctxA] = canvas(size);
  const [cr, ctxR] = canvas(size);
  const img = ctxA.createImageData(size, size);
  const rimg = ctxR.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const m = n1[i];
    const f = n2[i];
    const v = 88 + (m - 0.5) * 60 + (f - 0.5) * 22;
    img.data[i * 4] = v * 1.02;
    img.data[i * 4 + 1] = v * 0.99;
    img.data[i * 4 + 2] = v * 0.95;
    img.data[i * 4 + 3] = 255;
    const r = 0.28 + m * 0.35 + (f - 0.5) * 0.18;
    const rv = Math.max(0, Math.min(255, r * 255));
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = rv;
    rimg.data[i * 4 + 3] = 255;
  }
  ctxA.putImageData(img, 0, 0);
  ctxR.putImageData(rimg, 0, 0);
  const rnd = mulberry32(seed + 9);
  // stains
  for (let i = 0; i < 14; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 30 + rnd() * 140;
    const dark = rnd() < 0.7;
    wrapDraw(size, (ox, oy) => {
      const g = ctxA.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, dark ? 'rgba(30,26,22,0.22)' : 'rgba(200,196,190,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctxA.fillStyle = g;
      ctxA.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      const gr = ctxR.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, dark ? 'rgba(40,40,40,0.35)' : 'rgba(230,230,230,0.25)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctxR.fillStyle = gr;
      ctxR.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    });
  }
  // hairline cracks (random walks)
  ctxA.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    const pts: [number, number][] = [[x, y]];
    const steps = 20 + Math.floor(rnd() * 40);
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 0.9;
      x += Math.cos(a) * 6;
      y += Math.sin(a) * 6;
      pts.push([x, y]);
    }
    wrapDraw(size, (ox, oy) => {
      ctxA.strokeStyle = 'rgba(20,18,16,0.55)';
      ctxA.lineWidth = 0.9 + rnd() * 0.6;
      ctxA.beginPath();
      pts.forEach(([px, py], k) => (k === 0 ? ctxA.moveTo(px + ox, py + oy) : ctxA.lineTo(px + ox, py + oy)));
      ctxA.stroke();
    });
  }
  // saw-cut control joints at tile border (1 tile = 4 m => joint grid 4 m)
  ctxA.fillStyle = 'rgba(25,22,20,0.7)';
  ctxA.fillRect(0, 0, size, 2);
  ctxA.fillRect(0, 0, 2, size);
  ctxR.fillStyle = 'rgba(255,255,255,0.9)';
  ctxR.fillRect(0, 0, size, 2);
  ctxR.fillRect(0, 0, 2, size);
  return { map: toTexture(ca, true), roughnessMap: toTexture(cr, false) };
}

/** Running-bond brick with mortar, per-brick tint, chipped edges; bump from mortar depth. */
export function brickMaps(size = 1024, seed = 3): PbrMaps {
  const [ca, ctxA] = canvas(size);
  const [cb, ctxB] = canvas(size);
  const [cr, ctxR] = canvas(size);
  const rnd = mulberry32(seed);
  const rows = 16;
  const cols = 4; // 4 bricks per row per tile -> tile ~ 0.9 m wide
  const bh = size / rows;
  const bw = size / cols;
  const mortar = Math.max(2, size / 150);
  ctxA.fillStyle = '#6d655c';
  ctxA.fillRect(0, 0, size, size);
  ctxB.fillStyle = '#202020';
  ctxB.fillRect(0, 0, size, size);
  ctxR.fillStyle = '#f0f0f0';
  ctxR.fillRect(0, 0, size, size);
  for (let r = 0; r < rows; r++) {
    const off = r % 2 === 0 ? 0 : bw / 2;
    for (let c = -1; c < cols; c++) {
      const x = c * bw + off + mortar / 2;
      const y = r * bh + mortar / 2;
      const w = bw - mortar;
      const h = bh - mortar;
      const t = rnd();
      const red = 120 + t * 50 + (rnd() - 0.5) * 20;
      const g = 52 + t * 22 + (rnd() - 0.5) * 10;
      const b = 38 + t * 14;
      const burnt = rnd() < 0.12 ? 0.6 : 1;
      ctxA.fillStyle = `rgb(${red * burnt},${g * burnt},${b * burnt})`;
      ctxA.fillRect(x, y, w, h);
      ctxB.fillStyle = `rgb(${200 + rnd() * 40},${200},${200})`;
      ctxB.fillRect(x, y, w, h);
      ctxR.fillStyle = `rgb(${190 + rnd() * 50},0,0)`;
      ctxR.fillRect(x, y, w, h);
    }
  }
  // grime / speckle overlay
  const n = fbmField(size, 8, 5, seed + 5, 0.6);
  const img = ctxA.getImageData(0, 0, size, size);
  const bimg = ctxB.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    const k = 0.7 + n[i] * 0.55 + (rnd() - 0.5) * 0.12;
    img.data[i * 4] *= k;
    img.data[i * 4 + 1] *= k;
    img.data[i * 4 + 2] *= k;
    bimg.data[i * 4] = Math.min(255, bimg.data[i * 4] * (0.85 + rnd() * 0.3));
    bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = bimg.data[i * 4];
  }
  ctxA.putImageData(img, 0, 0);
  ctxB.putImageData(bimg, 0, 0);
  // roughness: brick R channel written, copy to G (roughness reads G)
  const rimg = ctxR.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) rimg.data[i * 4 + 1] = rimg.data[i * 4] || 250;
  ctxR.putImageData(rimg, 0, 0);
  return { map: toTexture(ca, true), roughnessMap: toTexture(cr, false), bumpMap: toTexture(cb, false) };
}

/** Soft mottled plaster. */
export function plasterMaps(size = 512, seed = 11): PbrMaps {
  const n = fbmField(size, 4, 6, seed, 0.6);
  const [ca, ctx] = canvas(size);
  const [cb, ctxB] = canvas(size);
  const img = ctx.createImageData(size, size);
  const bimg = ctxB.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 150 + (n[i] - 0.5) * 40;
    img.data[i * 4] = v * 1.0;
    img.data[i * 4 + 1] = v * 0.97;
    img.data[i * 4 + 2] = v * 0.92;
    img.data[i * 4 + 3] = 255;
    const b = n[i] * 255;
    bimg.data[i * 4] = bimg.data[i * 4 + 1] = bimg.data[i * 4 + 2] = b;
    bimg.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctxB.putImageData(bimg, 0, 0);
  return { map: toTexture(ca, true), roughnessMap: toTexture(cb, false), bumpMap: toTexture(cb, false) };
}

/** Wood planks with grain; `tone` picks warm oak vs dark walnut. */
export function woodMaps(size = 512, seed = 21, tone: 'oak' | 'walnut' | 'pine' = 'oak'): PbrMaps {
  const [ca, ctx] = canvas(size);
  const [cr, ctxR] = canvas(size);
  const base = tone === 'oak' ? [150, 102, 62] : tone === 'walnut' ? [86, 56, 36] : [184, 146, 96];
  const n = fbmField(size, 2, 5, seed, 0.55);
  const rnd = mulberry32(seed);
  const planks = 4;
  const img = ctx.createImageData(size, size);
  const rimg = ctxR.createImageData(size, size);
  const plankTint: number[] = [];
  for (let p = 0; p < planks; p++) plankTint.push(0.82 + rnd() * 0.3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = Math.floor((y / size) * planks);
      const grain = Math.pow(Math.sin((x / size) * 90 + n[i] * 5 + p * 3 + Math.sin(y * 0.05 + p) * 0.6) * 0.5 + 0.5, 3);
      const k = plankTint[p] * (0.78 + grain * 0.22 + (n[i] - 0.5) * 0.25);
      const edge = (y % (size / planks)) < 2 ? 0.45 : 1;
      img.data[i * 4] = base[0] * k * edge;
      img.data[i * 4 + 1] = base[1] * k * edge;
      img.data[i * 4 + 2] = base[2] * k * edge;
      img.data[i * 4 + 3] = 255;
      const r = (0.55 + grain * 0.2) * 255;
      rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = r;
      rimg.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctxR.putImageData(rimg, 0, 0);
  return { map: toTexture(ca, true), roughnessMap: toTexture(cr, false) };
}

/** 2×2 twill carbon weave (albedo + roughness), tiles every 8 tows. */
export function carbonMaps(size = 256): PbrMaps {
  const [ca, ctx] = canvas(size);
  const [cr, ctxR] = canvas(size);
  const tows = 8;
  const t = size / tows;
  for (let y = 0; y < tows; y++) {
    for (let x = 0; x < tows; x++) {
      const horiz = ((x + y) >> 1) % 2 === 0;
      const g = horiz ? ctx.createLinearGradient(0, y * t, 0, y * t + t) : ctx.createLinearGradient(x * t, 0, x * t + t, 0);
      g.addColorStop(0, '#0b0c0e');
      g.addColorStop(0.5, horiz ? '#3a3d44' : '#24262b');
      g.addColorStop(1, '#0b0c0e');
      ctx.fillStyle = g;
      ctx.fillRect(x * t, y * t, t, t);
      ctxR.fillStyle = horiz ? '#707070' : '#9a9a9a';
      ctxR.fillRect(x * t, y * t, t, t);
      // tow fibres
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let k = 1; k < 6; k++) {
        ctx.beginPath();
        if (horiz) {
          ctx.moveTo(x * t, y * t + (k * t) / 6);
          ctx.lineTo(x * t + t, y * t + (k * t) / 6);
        } else {
          ctx.moveTo(x * t + (k * t) / 6, y * t);
          ctx.lineTo(x * t + (k * t) / 6, y * t + t);
        }
        ctx.stroke();
      }
    }
  }
  return { map: toTexture(ca, true), roughnessMap: toTexture(cr, false) };
}

/** Night city skyline for window backdrops (emissive). */
export function skylineTexture(w = 2048, h = 1024, seed = 42): THREE.CanvasTexture {
  const [c, ctx] = canvas(w, h);
  const rnd = mulberry32(seed);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#060a1c');
  sky.addColorStop(0.45, '#14224a');
  sky.addColorStop(0.72, '#3b3a6e');
  sky.addColorStop(0.86, '#a0587a');
  sky.addColorStop(1, '#e08a5c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  // stars
  for (let i = 0; i < 260; i++) {
    const a = rnd() * 0.7 + 0.2;
    ctx.fillStyle = `rgba(220,230,255,${a * (1 - i / 400)})`;
    const s = rnd() < 0.08 ? 2 : 1;
    ctx.fillRect(rnd() * w, rnd() * h * 0.5, s, s);
  }
  // moon with halo
  const mx = w * 0.72;
  const my = h * 0.2;
  const halo = ctx.createRadialGradient(mx, my, 10, mx, my, 220);
  halo.addColorStop(0, 'rgba(200,215,255,0.55)');
  halo.addColorStop(1, 'rgba(200,215,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - 220, my - 220, 440, 440);
  ctx.fillStyle = '#eef2ff';
  ctx.beginPath();
  ctx.arc(mx, my, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(160,170,200,0.35)';
  ctx.beginPath();
  ctx.arc(mx - 10, my + 6, 9, 0, Math.PI * 2);
  ctx.arc(mx + 12, my - 10, 6, 0, Math.PI * 2);
  ctx.fill();
  // three layers of buildings: far (hazy) -> near (dark with lit windows)
  const layers = [
    { base: 0.62, max: 0.22, col: '#2a2f55', win: 0.05, alpha: 0.9 },
    { base: 0.72, max: 0.3, col: '#161a36', win: 0.18, alpha: 1 },
    { base: 0.84, max: 0.36, col: '#090b1a', win: 0.32, alpha: 1 },
  ];
  for (const L of layers) {
    let x = -20;
    while (x < w) {
      const bw = 40 + rnd() * 120;
      const bh = (0.05 + rnd() * L.max) * h;
      const top = h * L.base - bh;
      ctx.globalAlpha = L.alpha;
      ctx.fillStyle = L.col;
      ctx.fillRect(x, top, bw, h - top);
      if (rnd() < 0.25) ctx.fillRect(x + bw * 0.4, top - 30 - rnd() * 40, 4, 40 + rnd() * 40); // antenna
      // windows
      const cols = Math.floor(bw / 12);
      const rows = Math.floor((h - top) / 16);
      for (let r = 1; r < rows; r++) {
        for (let k = 1; k < cols; k++) {
          if (rnd() > L.win) continue;
          const warm = rnd() < 0.7;
          const b = 0.55 + rnd() * 0.45;
          ctx.fillStyle = warm ? `rgba(255,${190 + rnd() * 40},${110 + rnd() * 40},${b})` : `rgba(150,210,255,${b})`;
          ctx.fillRect(x + k * 12 - 3, top + r * 16, 6, 8);
        }
      }
      if (rnd() < 0.15) {
        ctx.fillStyle = 'rgba(255,40,40,0.9)';
        ctx.fillRect(x + bw / 2 - 2, top - 4, 4, 4);
      }
      x += bw + rnd() * 10;
    }
  }
  ctx.globalAlpha = 1;
  // ground haze glow
  const haze = ctx.createLinearGradient(0, h * 0.7, 0, h);
  haze.addColorStop(0, 'rgba(255,140,90,0)');
  haze.addColorStop(1, 'rgba(255,150,100,0.35)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
  const t = toTexture(c, true, false);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Soft radial falloff sprite (white, alpha in all channels). */
export function radialTexture(size = 128, hard = 0): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(Math.min(0.95, 0.15 + hard), 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return toTexture(c, false, false);
}

/** Ring number label: bold numeral in a rounded holo tag. */
export function labelTexture(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgba(8,12,24,0.55)';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.roundRect(28, 28, 200, 200, 44);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 132px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 138);
  return toTexture(c, true, false);
}

/** Geometric wool rug pattern. */
export function rugTexture(seed = 5): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 683);
  const W = 1024;
  const H = 683;
  const rnd = mulberry32(seed);
  ctx.fillStyle = '#6b2330';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#d9b77a';
  ctx.lineWidth = 14;
  ctx.strokeRect(34, 34, W - 68, H - 68);
  ctx.strokeStyle = '#1f2a44';
  ctx.lineWidth = 26;
  ctx.strokeRect(70, 70, W - 140, H - 140);
  ctx.fillStyle = '#1f2a44';
  for (let y = 130; y < H - 120; y += 70) {
    for (let x = 130; x < W - 120; x += 70) {
      ctx.save();
      ctx.translate(x + 20, y + 20);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = (x + y) % 140 === 0 ? '#d9b77a' : '#2e3b5e';
      ctx.fillRect(-16, -16, 32, 32);
      ctx.restore();
    }
  }
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) {
    const k = 0.82 + rnd() * 0.3;
    img.data[i * 4] *= k;
    img.data[i * 4 + 1] *= k;
    img.data[i * 4 + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c, true, false);
}

/** LiPo battery wrap label. */
export function batteryTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 128);
  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#ffcc1a';
  ctx.fillRect(0, 0, 256, 30);
  ctx.fillRect(0, 98, 256, 30);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('4S  650mAh', 128, 23);
  ctx.fillStyle = '#f2f2f2';
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.fillText('LiPo 120C', 128, 80);
  return toTexture(c, true, false);
}

/** Lettering strip for wall neon / signs (used as alpha mask). */
export function neonTexture(text: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 256);
  ctx.clearRect(0, 0, 1024, 256);
  ctx.font = 'italic bold 170px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = 24;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 12;
  ctx.strokeText(text, 512, 132);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillText(text, 512, 132);
  return toTexture(c, true, false);
}
