/** Meadow ground: tiled grass detail under large-scale colour patches, the mowed flying field and the landing pad. */
import * as THREE from 'three';
import { fbmField, mulberry32 } from '../textures';

const MEADOW = [0x5d8f3a, 0x6f9d43, 0x7d9a45, 0x557f36] as const;
const STRIPE_A = 0x74a548;
const STRIPE_B = 0x649a3f;
/** metres per grass detail tile */
const GRASS_TILE = 3;

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/** Near-white tileable grass detail: multiplied over the vertex colours. */
export function grassDetailTexture(size = 256, anisotropy = 4): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const n = fbmField(size, 8, 4, 31);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 0.78 + n[i]! * 0.3;
    img.data[i * 4] = Math.min(255, 235 * v);
    img.data[i * 4 + 1] = Math.min(255, 250 * v);
    img.data[i * 4 + 2] = Math.min(255, 220 * v);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // short blade strokes, wrapped so the tile stays seamless
  const rnd = mulberry32(77);
  ctx.lineWidth = 1;
  for (let i = 0; i < size * 6; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const len = 2 + rnd() * 4;
    const lean = (rnd() - 0.5) * 2;
    const light = rnd() < 0.5;
    ctx.strokeStyle = light ? 'rgba(255,255,230,0.35)' : 'rgba(40,60,20,0.28)';
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + lean, y + oy - len);
        ctx.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}

/**
 * Landing pad: dark rubber square, white border, orange target ring and a teal H. 1 texel ≈ 1 cm.
 */
export function padTexture(size = 512): THREE.CanvasTexture {
  const [c, ctx] = canvas(size);
  const n = fbmField(128, 16, 3, 9);
  ctx.fillStyle = '#34373c';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = n[((y >> 2) & 127) * 128 + ((x >> 2) & 127)]! * 26 - 13;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i]! + v;
      img.data[i + 1] = img.data[i + 1]! + v;
      img.data[i + 2] = img.data[i + 2]! + v;
    }
  }
  ctx.putImageData(img, 0, 0);
  const s = size / 512;
  ctx.strokeStyle = '#f2efe6';
  ctx.lineWidth = 14 * s;
  ctx.strokeRect(14 * s, 14 * s, size - 28 * s, size - 28 * s);
  ctx.strokeStyle = '#ff6a1f';
  ctx.lineWidth = 22 * s;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 170 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#2fd0c8';
  const bar = 34 * s;
  const hh = 190 * s;
  const hw = 130 * s;
  ctx.fillRect(size / 2 - hw / 2, size / 2 - hh / 2, bar, hh);
  ctx.fillRect(size / 2 + hw / 2 - bar, size / 2 - hh / 2, bar, hh);
  ctx.fillRect(size / 2 - hw / 2, size / 2 - bar / 2, hw, bar);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Large meadow plane: vertex-colour patches (value noise) so the ground never reads as one tile. */
export function meadowGeometry(size: number, segments: number, seed = 5): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(size, size, segments, segments);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  const field = fbmField(64, 4, 3, seed);
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const pal = MEADOW.map((h) => new THREE.Color(h));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const fx = Math.floor(((x / size + 0.5) * 63.999) % 64);
    const fz = Math.floor(((z / size + 0.5) * 63.999) % 64);
    const v = field[fz * 64 + fx]!;
    const k = Math.min(pal.length - 1.001, v * (pal.length - 1) * 1.2);
    c.copy(pal[Math.floor(k)]!).lerp(pal[Math.floor(k) + 1]!, k - Math.floor(k));
    col.set([c.r, c.g, c.b], i * 3);
    uv.setXY(i, x / GRASS_TILE, z / GRASS_TILE);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Mowed field: hard-edged alternating stripes (one quad each) plus painted boundary lines. */
export function fieldGeometry(half: number, stripes: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const a = new THREE.Color(STRIPE_A);
  const b = new THREE.Color(STRIPE_B);
  const line = new THREE.Color(0xf4f1e8);
  const w = (half * 2) / stripes;
  const quad = (x0: number, z0: number, x1: number, z1: number, c: THREE.Color, y = 0): void => {
    const v = [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x0, z0],
      [x1, z1],
      [x1, z0],
    ];
    for (const [x, z] of v) {
      pos.push(x!, y, z!);
      col.push(c.r, c.g, c.b);
      uv.push(x! / GRASS_TILE, z! / GRASS_TILE);
    }
  };
  for (let i = 0; i < stripes; i++) quad(-half + i * w, -half, -half + (i + 1) * w, half, i % 2 === 0 ? a : b);
  const lw = 0.12;
  const y = 0.002;
  quad(-half, -half, half, -half + lw, line, y);
  quad(-half, half - lw, half, half, line, y);
  quad(-half, -half, -half + lw, half, line, y);
  quad(half - lw, -half, half, half, line, y);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
