/**
 * Models of the ambient life (docs/12), flat-shaded, sRGB vertex colours, metres, front at +Z. `uv.x` tags the
 * part the shader animates (LIFE_PART), `uv.y` how much a vertex moves (flutter / head bob weight).
 */
import type * as THREE from 'three';
import { GeoBuilder, type V3 } from './geo';

export const LIFE_PART = { still: 0, rotor: 1, head: 2, cloth: 3, lamp: 4, wheel: 5, beacon: 6 } as const;

/** hub height of the wind turbine model (m) and its rotor radius */
export const TURBINE_HUB = 52;
export const TURBINE_ROTOR = 24;

/**
 * Three-blade wind turbine, 52 m hub: a tapered tower, the nacelle, the hub and three blades (LIFE_PART.rotor,
 * spun about the hub's +Z axis in the shader). Faces +Z (into the wind).
 */
export function turbineModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const white = 0xe8e9e6;
  // tower: 8 facets, tapering
  const sides = 8;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const r0 = 1.7;
    const r1 = 0.95;
    const p = (a: number, r: number, y: number): V3 => [Math.cos(a) * r, y, Math.sin(a) * r];
    g.quad(p(a0, r0, 0), p(a0, r1, TURBINE_HUB - 1.2), p(a1, r1, TURBINE_HUB - 1.2), p(a1, r0, 0), white);
  }
  // nacelle and hub
  g.box(0, TURBINE_HUB, -1.2, 2.2, 2.4, 6.5, white);
  g.box(0, TURBINE_HUB, 2.35, 1.5, 1.5, 1.0, white, LIFE_PART.rotor);
  // blades: tapering, slightly twisted planks in the rotor plane (local XY at z = 2.6)
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const vx = -uy;
    const vy = ux;
    const P = (r: number, w: number, dz: number): V3 => [ux * r + vx * w, TURBINE_HUB + uy * r + vy * w, 2.6 + dz];
    const root = 1.0;
    const tip = TURBINE_ROTOR;
    // front and back faces of the blade
    g.quad(P(root, -0.9, 0.1), P(tip, -0.25, 0.05), P(tip, 0.2, 0.05), P(root, 0.9, 0.1), white, LIFE_PART.rotor);
    g.quad(P(root, 0.9, -0.1), P(tip, 0.2, -0.05), P(tip, -0.25, -0.05), P(root, -0.9, -0.1), white, LIFE_PART.rotor);
  }
  return g.build();
}

/**
 * Grazing animal (a cow; sheep are the same model shorter and woolly-white by instance scale and tint): body,
 * four legs, neck and head (LIFE_PART.head: bobs down to the grass and up in the shader, weight 1 at the muzzle).
 */
export function animalModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const coat = 0xffffff;
  const dark = 0x2a2522;
  g.box(0, 1.0, 0, 0.75, 0.75, 1.6, coat);
  for (const [x, z] of [
    [-0.24, 0.6],
    [0.24, 0.6],
    [-0.24, -0.6],
    [0.24, -0.6],
  ] as const) {
    g.box(x, 0.33, z, 0.16, 0.66, 0.16, coat);
    g.box(x, 0.04, z, 0.17, 0.08, 0.17, dark);
  }
  // tail
  g.box(0, 0.95, -0.82, 0.06, 0.5, 0.06, coat);
  // neck + head, hinged at the shoulders (the shader rotates them down by uv.y)
  const neck = (y: number, z: number, w: number, h: number, d: number, hex: number, k: number): void => {
    g.box(0, y, z, w, h, d, hex, LIFE_PART.head, k);
  };
  neck(1.18, 0.92, 0.36, 0.42, 0.4, coat, 0.5);
  neck(1.12, 1.28, 0.34, 0.36, 0.5, coat, 1);
  neck(1.02, 1.55, 0.26, 0.2, 0.12, 0x6a5045, 1);
  // ears / horns
  neck(1.35, 1.2, 0.56, 0.06, 0.1, dark, 1);
  return g.build();
}

/** Farm tractor (≈ 4 × 2.2 × 2.8 m): body, cab with glass, big rear wheels, a plough behind. */
export function tractorModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const paint = 0x2f7d32;
  const glass = 0x1a2026;
  const tyre = 0x1a1a1a;
  const rim = 0xd8b21a;
  g.box(0, 1.15, 0.8, 1.0, 0.9, 2.0, paint);
  g.box(0, 1.7, 1.3, 0.12, 0.6, 0.12, 0x333333);
  g.box(0, 1.25, -0.45, 1.6, 0.4, 1.4, paint);
  // cab: four pillars and a roof, glass panes
  g.box(0, 2.85, -0.45, 1.5, 0.12, 1.5, paint);
  g.box(0, 2.0, -0.45, 1.42, 1.5, 1.42, glass);
  // wheels: big rear, small front
  for (const s of [-1, 1]) {
    g.cylinderX(s * 0.92, 0.85, -0.55, 0.85, 0.5, 10, tyre, tyre, LIFE_PART.wheel, 0.85);
    g.cylinderX(s * 1.19, 0.85, -0.55, 0.5, 0.04, 10, rim, rim, LIFE_PART.wheel, 0.85);
    g.cylinderX(s * 0.62, 0.48, 1.35, 0.48, 0.32, 8, tyre, tyre, LIFE_PART.wheel, 0.48);
    g.cylinderX(s * 0.8, 0.48, 1.35, 0.28, 0.04, 8, rim, rim, LIFE_PART.wheel, 0.48);
  }
  // headlights
  for (const s of [-1, 1]) g.box(s * 0.35, 1.45, 1.81, 0.18, 0.12, 0.03, 0xf2efe2, LIFE_PART.lamp);
  // plough on a drawbar
  g.box(0, 0.6, -1.6, 0.2, 0.15, 0.9, 0x444444);
  for (let k = -1; k <= 1; k++) g.box(k * 0.6, 0.35, -2.25 - Math.abs(k) * 0.2, 0.5, 0.5, 0.12, 0x7a3a22);
  return g.build();
}

/** Rooftop AC unit's fan: a grey ring housing and four blades (LIFE_PART.rotor, spun about +Y). */
export function acFanModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  // a dark grille disc, then four blades on a hub (34 triangles)
  const sides = 6;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const r = 0.66;
    g.quad([Math.cos(a0) * r, 0, Math.sin(a0) * r], [Math.cos(a0) * r, 0.16, Math.sin(a0) * r], [Math.cos(a1) * r, 0.16, Math.sin(a1) * r], [Math.cos(a1) * r, 0, Math.sin(a1) * r], 0x75787c);
    g.tri([0, 0.02, 0], [Math.cos(a1) * r, 0.02, Math.sin(a1) * r], [Math.cos(a0) * r, 0.02, Math.sin(a0) * r], 0x1c1d1f);
  }
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const p = (r: number, w: number, y: number): V3 => [c * r - s * w, y, s * r + c * w];
    g.quad(p(0.08, -0.1, 0.1), p(0.6, -0.13, 0.12), p(0.6, 0.13, 0.08), p(0.08, 0.1, 0.1), 0xa9adb2, LIFE_PART.rotor);
  }
  return g.build();
}

/** Flag on a pole: 7 m pole, a 1.8 × 1.1 m cloth along +X from the top (LIFE_PART.cloth, uv.y = 0 at the pole → 1 at the fly). */
export function flagModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.cylinderY(0, 0, 0.05, 0, 7, 6, 0xb8bcc0);
  g.box(0, 7.03, 0, 0.12, 0.06, 0.12, 0xd8b21a);
  const cols = 6;
  const rows = 2;
  const W = 1.8;
  const H = 1.1;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x0 = (i / cols) * W;
      const x1 = ((i + 1) / cols) * W;
      const y0 = 6.9 - H + (j / rows) * H;
      const y1 = 6.9 - H + ((j + 1) / rows) * H;
      const k0 = i / cols;
      const k1 = (i + 1) / cols;
      // two faces, the weight along the cloth rides in uv.y (the stripe colour is the instance tint)
      const hex = 0xffffff;
      g.tri([x0, y0, 0], [x1, y0, 0], [x1, y1, 0], hex, LIFE_PART.cloth, k0, k1, k1);
      g.tri([x0, y0, 0], [x1, y1, 0], [x0, y1, 0], hex, LIFE_PART.cloth, k0, k1, k0);
      g.tri([x0, y0, 0], [x1, y1, 0], [x1, y0, 0], hex, LIFE_PART.cloth, k0, k1, k1);
      g.tri([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], hex, LIFE_PART.cloth, k0, k0, k1);
    }
  }
  return g.build();
}

/** Aircraft obstruction light: a small red lamp on a stub (LIFE_PART.beacon blinks). */
export function beaconModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0.25, 0, 0.12, 0.5, 0.12, 0x3a3c40);
  g.box(0, 0.6, 0, 0.3, 0.22, 0.3, 0xffffff, LIFE_PART.beacon);
  return g.build();
}

/** Wi-Fi router for the loft desk: a dark box, two antennas and a row of five LEDs (LIFE_PART.lamp, uv.y = LED index / 4). */
export function routerModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0.025, 0, 0.26, 0.05, 0.17, 0x15171a);
  g.box(0, 0.052, 0, 0.24, 0.004, 0.15, 0x22252a);
  for (const s of [-1, 1]) {
    g.box(s * 0.11, 0.06, -0.075, 0.02, 0.03, 0.02, 0x15171a);
    g.box(s * 0.11, 0.15, -0.08, 0.016, 0.17, 0.016, 0x15171a);
  }
  for (let k = 0; k < 5; k++) g.box(-0.08 + k * 0.04, 0.03, 0.0851, 0.012, 0.008, 0.002, 0xffffff, LIFE_PART.lamp, k / 4);
  return g.build();
}

/** A camera-facing smoke / steam puff: a quad, the puff's shape and age come from the shader. */
export function puffModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.quad([-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], 0xffffff);
  return g.build();
}
