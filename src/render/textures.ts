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

/** fbm fields already computed (same arguments → same field): level switches and the texture prewarm reuse them */
const FBM_CACHE = new Map<string, Float32Array>();
/** memory cap of the cache (floats): 16 MB */
const FBM_CACHE_FLOATS = 4 * 1024 * 1024;
let fbmCached = 0;

/** Tileable fbm value noise in [0,1], `size`² samples (memoised: the caller gets its own copy). */
export function fbmField(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const key = `${size}|${basePeriod}|${octaves}|${seed}|${gain}`;
  const hit = FBM_CACHE.get(key);
  if (hit) return hit.slice();
  const out = fbmFieldRaw(size, basePeriod, octaves, seed, gain);
  if (out.length <= FBM_CACHE_FLOATS / 4) {
    while (fbmCached + out.length > FBM_CACHE_FLOATS && FBM_CACHE.size > 0) {
      const [k, v] = FBM_CACHE.entries().next().value!;
      FBM_CACHE.delete(k);
      fbmCached -= v.length;
    }
    FBM_CACHE.set(key, out);
    fbmCached += out.length;
  }
  return out.slice();
}

function fbmFieldRaw(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
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

export interface PbrMaps {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  bumpMap?: THREE.CanvasTexture;
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
