/**
 * Distant mountain ridges with aerial perspective: three rings of noisy ridgelines between ~650 m and
 * ~1050 m, each layer tinted further towards the horizon haze (bluer, lighter, less contrast) and drawn
 * without scene fog so the silhouettes stay readable. One merged, vertex-coloured, unlit-ish draw.
 */
import * as THREE from 'three';
import { mulberry32 } from '../materials/texgen';

interface Layer {
  radius: number;
  base: number;
  peak: number;
  haze: number;
  seed: number;
}

const LAYERS: readonly Layer[] = [
  { radius: 1040, base: 40, peak: 210, haze: 0.72, seed: 3 },
  { radius: 860, base: 20, peak: 130, haze: 0.58, seed: 7 },
  { radius: 680, base: 8, peak: 70, haze: 0.44, seed: 11 },
];

/** Periodic 1D fbm over the ring (so the ridge closes on itself). */
function ridge(seed: number, samples: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(samples);
  let amp = 1;
  let total = 0;
  for (let oct = 0; oct < 5; oct++) {
    const period = 6 << oct;
    const lat = Array.from({ length: period }, () => rnd());
    for (let i = 0; i < samples; i++) {
      const f = (i / samples) * period;
      const i0 = Math.floor(f);
      const t = f - i0;
      const s = t * t * (3 - 2 * t);
      // ridged: sharpen peaks
      const v = lat[i0 % period]! + (lat[(i0 + 1) % period]! - lat[i0 % period]!) * s;
      out[i] = out[i]! + (oct < 2 ? 1 - Math.abs(v * 2 - 1) : v) * amp;
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < samples; i++) out[i] = out[i]! / total;
  return out;
}

export function mountainBackdrop(horizon: THREE.ColorRepresentation, rock: THREE.ColorRepresentation = 0x5d6f63): THREE.Mesh {
  const hz = new THREE.Color(horizon);
  const rk = new THREE.Color(rock);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const segs = 256;
  const c = new THREE.Color();
  for (const L of LAYERS) {
    const r = ridge(L.seed, segs);
    const start = pos.length / 3;
    const tint = rk.clone().lerp(hz, L.haze);
    const foot = rk.clone().lerp(hz, Math.min(0.95, L.haze + 0.2));
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const h = L.base + Math.pow(r[i % segs]!, 1.6) * L.peak * 1.2;
      const x = Math.sin(a) * L.radius;
      const z = Math.cos(a) * L.radius;
      pos.push(x, -30, z, x, h, z);
      c.copy(foot);
      col.push(c.r, c.g, c.b);
      // lit ridge tops facing the sun-ish side are a touch lighter
      c.copy(tint).multiplyScalar(1.02 + Math.sin(a + 0.8) * 0.04 + r[i % segs]! * 0.06);
      col.push(c.r, c.g, c.b);
    }
    for (let i = 0; i < segs; i++) {
      const a = start + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  m.name = 'mountains';
  m.renderOrder = -4;
  m.matrixAutoUpdate = false;
  return m;
}
