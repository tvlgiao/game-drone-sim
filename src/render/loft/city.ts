/**
 * The night city outside the loft windows, built for parallax rather than painted on a card: a sky
 * cylinder (gradient, stars, far skyline, street glow) around blocks of low-poly buildings across the
 * street whose façades carry a lit-window atlas, rooftop water towers and aviation lights, and the moon.
 * Two draw calls of its own; the lights and moon ride on the room's glow / spill buckets.
 */
import * as THREE from 'three';
import { StaticBatcher, boxProjectUV, trs } from '../batcher';
import type { LoftMaterials } from './materials';
import { clamp01, dataTexture, fbm, mix, mulberry32, rgba, smooth, texSize } from '../materials/texgen';
import type { WindowInfo } from '../room';

/** sky cylinder radius: the far corner of the room to it stays inside the indoor camera far plane (90 m) */
const SKY_R = 68;
const SKY_Y0 = -30;
const SKY_Y1 = 64;
/** street level below the loft floor */
const STREET_Y = -14;
const FACADE_CELLS = 8;
/** façade texture tile in metres (one window bay × storey per cell) */
const FACADE_TILE = 3.2 * FACADE_CELLS;

export interface CityBackdrop {
  meshes: THREE.Mesh[];
  dispose(): void;
}

/** Sky band: u = azimuth (CylinderGeometry: θ = atan2(x, z)), v = height from SKY_Y0 to SKY_Y1. */
function skyTexture(w: number, h: number, moonU: number): THREE.DataTexture {
  const horizon = (3 - SKY_Y0) / (SKY_Y1 - SKY_Y0);
  const rnd = mulberry32(42);
  const cloud = fbm(w, h, 6, 5, 43, 0.55);
  // far skyline: column heights per pixel (tileable around the cylinder)
  const sky = new Float32Array(w);
  const lit = new Uint8Array(w * 4);
  let x = 0;
  while (x < w) {
    const bw = Math.max(2, Math.round((4 + rnd() * 18) * (w / 2048)));
    const top = horizon + 0.01 + Math.pow(rnd(), 2.2) * 0.14;
    for (let k = 0; k < bw && x + k < w; k++) sky[x + k] = top;
    x += bw;
  }
  const stars = new Float32Array(w * h);
  for (let i = 0; i < w * h * 0.0015; i++) {
    const sx = Math.floor(rnd() * w);
    const sy = Math.floor(horizon * h + rnd() * (1 - horizon) * h);
    stars[sy * w + sx] = Math.pow(rnd(), 3) * 0.9 + 0.1;
  }
  for (let i = 0; i < lit.length; i++) lit[i] = rnd() < 0.18 ? 1 : 0;
  const data = rgba(w, h, (i, px, py, c) => {
    const v = (py + 0.5) / h;
    const t = clamp01((v - horizon) / (1 - horizon));
    // night gradient: sodium-orange city glow on the horizon to deep navy at the zenith
    let r = mix(0.36, 0.02, Math.pow(t, 0.35));
    let g = mix(0.2, 0.035, Math.pow(t, 0.35));
    let b = mix(0.26, 0.11, Math.pow(t, 0.5));
    // under the horizon: the street canyon glow
    if (v < horizon) {
      const s = clamp01((horizon - v) / horizon);
      r = mix(0.36, 0.5, s);
      g = mix(0.2, 0.26, s);
      b = mix(0.26, 0.14, s);
    }
    // thin clouds lit from below by the city
    const cl = smooth(0.55, 0.78, cloud.d[i]!) * smooth(horizon, horizon + 0.15, v) * (1 - smooth(0.7, 0.95, v));
    r = mix(r, 0.3, cl * 0.5);
    g = mix(g, 0.2, cl * 0.5);
    b = mix(b, 0.27, cl * 0.5);
    // stars fade into the glow
    const st = stars[i]! * smooth(horizon + 0.12, horizon + 0.35, v) * (1 - cl);
    r += st;
    g += st;
    b += st * 1.05;
    // moon halo
    const du = Math.min(Math.abs((px + 0.5) / w - moonU), 1 - Math.abs((px + 0.5) / w - moonU)) * (w / h) * 3.4;
    const mv = 0.93;
    const md = Math.hypot(du, (v - mv) * 1.2);
    const halo = Math.exp(-md * md * 90) * 0.25 + Math.exp(-md * md * 12) * 0.08;
    r += halo * 0.8;
    g += halo * 0.85;
    b += halo;
    // far skyline silhouettes with a few lit windows
    if (v < sky[px]! && v > horizon - 0.08) {
      const k = (sky[px]! - v) / 0.15;
      r = 0.035 + 0.02 * (1 - k);
      g = 0.04 + 0.02 * (1 - k);
      b = 0.075 + 0.02 * (1 - k);
      if (lit[(px * 7 + py * 13) % lit.length] && (px % 3 === 1) && (py % 3 === 1)) {
        r = 0.9;
        g = 0.65;
        b = 0.4;
      }
    }
    c[0] = Math.min(1, r);
    c[1] = Math.min(1, g);
    c[2] = Math.min(1, b);
  });
  const tex = dataTexture(data, w, h, { srgb: true, repeat: false });
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Façade atlas: FACADE_CELLS² window bays; dark masonry frame, lit / dark / blinds / TV-blue windows. */
function facadeTexture(size: number): THREE.DataTexture {
  const cell = size / FACADE_CELLS;
  const rnd = mulberry32(77);
  const kind = new Float32Array(FACADE_CELLS * FACADE_CELLS);
  const tone = new Float32Array(FACADE_CELLS * FACADE_CELLS);
  for (let i = 0; i < kind.length; i++) {
    kind[i] = rnd();
    tone[i] = rnd();
  }
  const n = fbm(size, size, 16, 3, 78, 0.5);
  const data = rgba(size, size, (i, x, y, c) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const lx = (x - cx * cell) / cell;
    const ly = (y - cy * cell) / cell;
    const k = kind[cy * FACADE_CELLS + cx]!;
    const tn = tone[cy * FACADE_CELLS + cx]!;
    const inWin = lx > 0.18 && lx < 0.82 && ly > 0.22 && ly < 0.8;
    const wall = 0.055 + (n.d[i]! - 0.5) * 0.03 + (ly < 0.08 ? 0.02 : 0);
    if (!inWin) {
      c[0] = wall;
      c[1] = wall * 0.98;
      c[2] = wall * 1.08;
      return;
    }
    const mull = Math.abs(lx - 0.5) < 0.012 || Math.abs(ly - 0.62) < 0.012;
    let r: number;
    let g: number;
    let b: number;
    if (k < 0.34) {
      // warm lit room, brighter at the top, sometimes blinds
      const blinds = tn > 0.6 ? 0.75 + 0.25 * Math.sin(ly * 140) : 1;
      const v = (0.55 + tn * 0.45) * (0.8 + ly * 0.25) * blinds;
      r = v;
      g = v * (0.7 + tn * 0.12);
      b = v * (0.42 + tn * 0.1);
    } else if (k < 0.42) {
      const v = 0.35 + tn * 0.3;
      r = v * 0.45;
      g = v * 0.7;
      b = v;
    } else {
      // dark glass reflecting the sky glow
      const v = 0.08 + (1 - ly) * 0.06 + tn * 0.03;
      r = v * 0.8;
      g = v * 0.8;
      b = v * 1.15;
    }
    if (mull) {
      r *= 0.25;
      g *= 0.25;
      b *= 0.25;
    }
    c[0] = r;
    c[1] = g;
    c[2] = b;
  });
  return dataTexture(data, size, size, { srgb: true });
}

interface Block {
  x: number;
  z: number;
  w: number;
  d: number;
  top: number;
}

/** Blocks across the street from every window wall: rows of buildings, taller further out. */
function layout(walls: ReadonlySet<WindowInfo['wall']>, sx: number, sz: number): Block[] {
  const rnd = mulberry32(1907);
  const out: Block[] = [];
  const row = (axis: 'x' | 'z', sign: number, near: number, depth: number, span: number, minTop: number, maxTop: number) => {
    let s = -span;
    while (s < span) {
      const w = 7 + rnd() * 12;
      const d = depth * (0.7 + rnd() * 0.3);
      const top = minTop + Math.pow(rnd(), 1.6) * (maxTop - minTop);
      const c = near + d / 2 + rnd() * 2;
      const along = s + w / 2;
      if (axis === 'z') out.push({ x: along, z: sign * c, w, d, top });
      else out.push({ x: sign * c, z: along, w: d, d: w, top });
      s += w + 1 + rnd() * 4;
    }
  };
  if (walls.has('north')) {
    row('z', -1, sz / 2 + 16, 12, 56, 2, 16);
    row('z', -1, sz / 2 + 32, 14, 60, 10, 34);
  }
  if (walls.has('south')) {
    row('z', 1, sz / 2 + 18, 12, 56, 0, 14);
    row('z', 1, sz / 2 + 34, 12, 58, 8, 30);
  }
  if (walls.has('east')) {
    row('x', 1, sx / 2 + 15, 12, 40, 2, 18);
    row('x', 1, sx / 2 + 30, 12, 46, 10, 30);
  }
  if (walls.has('west')) row('x', -1, sx / 2 + 16, 12, 40, 2, 18);
  // keep every block well inside the sky cylinder
  return out.filter((b) => Math.hypot(Math.abs(b.x) + b.w / 2, Math.abs(b.z) + b.d / 2) < SKY_R - 4);
}

export function buildCity(windows: readonly WindowInfo[], room: readonly [number, number, number], moonDir: THREE.Vector3, mats: LoftMaterials, batch: StaticBatcher, parent: THREE.Object3D, maxTexture: number): CityBackdrop {
  const [sx, , sz] = room;
  const disposables: { dispose(): void }[] = [];
  const toMoon = moonDir.clone().negate();
  const moonTheta = Math.atan2(toMoon.x, toMoon.z);
  const moonU = (((moonTheta / (Math.PI * 2)) % 1) + 1) % 1;

  const skyTex = skyTexture(texSize(2048, maxTexture * 2), texSize(512, maxTexture / 2), moonU);
  const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false });
  const skyGeo = new THREE.CylinderGeometry(SKY_R, SKY_R, SKY_Y1 - SKY_Y0, 48, 1, true);
  skyGeo.translate(0, (SKY_Y0 + SKY_Y1) / 2, 0);
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'city-sky';
  sky.renderOrder = -5;
  sky.matrixAutoUpdate = false;
  disposables.push(skyTex, skyMat, skyGeo);

  const walls = new Set(windows.map((w) => w.wall));
  const facadeTex = facadeTexture(texSize(1024, Math.max(512, maxTexture)));
  const facadeMat = new THREE.MeshBasicMaterial({ map: facadeTex, vertexColors: true, color: new THREE.Color(1.5, 1.5, 1.5) });
  disposables.push(facadeTex, facadeMat);
  const city = new StaticBatcher();
  const rnd = mulberry32(31);
  const tints = [0xffffff, 0xd8dcff, 0xffe2cc, 0xc8d4dc];
  const roofUv = 0.5 / FACADE_CELLS / 8;
  for (const b of layout(walls, sx, sz)) {
    const h = b.top - STREET_Y;
    const g = new THREE.BoxGeometry(b.w, h, b.d).toNonIndexed();
    g.translate(b.x, STREET_Y + h / 2, b.z);
    boxProjectUV(g, FACADE_TILE);
    const nor = g.attributes.normal;
    const uv = g.attributes.uv as THREE.BufferAttribute;
    // roofs / undersides take a masonry texel, not windows
    for (let i = 0; i < uv.count; i++) if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, roofUv, roofUv);
    city.add('facade', facadeMat, g, trs(0, 0, 0), { color: tints[Math.floor(rnd() * tints.length)]! });
    // parapet cap
    city.add('facade', facadeMat, new THREE.BoxGeometry(b.w + 0.3, 0.5, b.d + 0.3), trs(b.x, b.top + 0.25, b.z), { color: 0x9aa0a8 });
    const roll = rnd();
    if (roll < 0.25 && b.top > 4) {
      // timber water tower on steel legs
      const tx = b.x + (rnd() - 0.5) * b.w * 0.5;
      const tz = b.z + (rnd() - 0.5) * b.d * 0.5;
      city.add('facade', facadeMat, new THREE.CylinderGeometry(1.6, 1.7, 3.2, 12), trs(tx, b.top + 4.3, tz), { color: 0x6a5040 });
      city.add('facade', facadeMat, new THREE.ConeGeometry(1.9, 1.3, 12), trs(tx, b.top + 6.55, tz), { color: 0x4a4440 });
      for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        city.add('facade', facadeMat, new THREE.BoxGeometry(0.18, 2.7, 0.18), trs(tx + lx * 1.1, b.top + 1.35, tz + lz * 1.1), { color: 0x3a3a3a });
      }
    } else if (roll < 0.6) {
      // HVAC boxes
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        city.add('facade', facadeMat, new THREE.BoxGeometry(2 + rnd() * 2, 1.2 + rnd(), 1.5 + rnd()), trs(b.x + (rnd() - 0.5) * b.w * 0.6, b.top + 0.9, b.z + (rnd() - 0.5) * b.d * 0.6), { color: 0x80868c });
      }
    }
    if (b.top > 18 || rnd() < 0.2) {
      // antenna mast with a red aviation light
      const ax = b.x + (rnd() - 0.5) * b.w * 0.4;
      const az = b.z + (rnd() - 0.5) * b.d * 0.4;
      const mh = 3 + rnd() * 5;
      city.add('facade', facadeMat, new THREE.CylinderGeometry(0.08, 0.12, mh, 5), trs(ax, b.top + mh / 2, az), { color: 0x555555 });
      batch.add('glow', mats.glow, new THREE.SphereGeometry(0.22, 8, 6), trs(ax, b.top + mh + 0.1, az), { color: [6, 0.25, 0.15], castShadow: false });
    }
  }
  const facadeMeshes = city.build(parent);
  for (const m of facadeMeshes) {
    m.castShadow = false;
    m.receiveShadow = false;
    disposables.push(m.geometry);
  }

  // the moon: a pale disc with darker maria and a soft halo, on the moon direction just inside the sky
  const moonPos = toMoon.clone().multiplyScalar(SKY_R - 6);
  moonPos.y = Math.min(moonPos.y, SKY_Y1 - 8);
  const look = new THREE.Matrix4().lookAt(moonPos, new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 1, 0));
  const rot = new THREE.Quaternion().setFromRotationMatrix(look);
  const e = new THREE.Euler().setFromQuaternion(rot, 'YXZ');
  // the disc faces +Z; lookAt points -Z at the room, so turn it around
  const face = (g: THREE.BufferGeometry) => g.rotateY(Math.PI);
  batch.add('glow', mats.glow, face(new THREE.CircleGeometry(2.6, 40)), trs(moonPos.x, moonPos.y, moonPos.z, e.y, 1, 1, 1, e.x, e.z), { color: [2.1, 2.2, 2.45], castShadow: false });
  for (const [ox, oy, r] of [[-0.7, 0.5, 0.7], [0.6, -0.4, 0.55], [0.2, 0.9, 0.35]] as const) {
    const g = face(new THREE.CircleGeometry(r, 16));
    g.translate(-ox, oy, -0.05);
    batch.add('glow', mats.glow, g, trs(moonPos.x, moonPos.y, moonPos.z, e.y, 1, 1, 1, e.x, e.z), { color: [1.55, 1.62, 1.85], castShadow: false });
  }
  batch.add('spill', mats.spill, face(new THREE.PlaneGeometry(26, 26)), trs(moonPos.x, moonPos.y, moonPos.z, e.y, 1, 1, 1, e.x, e.z), { color: [0.22, 0.26, 0.38], castShadow: false });

  parent.add(sky);
  return {
    meshes: [sky, ...facadeMeshes],
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
