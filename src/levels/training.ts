/**
 * Training Field (design 07 §3): an 80 × 80 m flat meadow, pilot at the south edge looking north,
 * three big rings within 30 m so one LOS view shows the whole course. Set pieces are data so physics
 * and render agree: what the pilot sees is what the drone can hit (hills stay far out of reach).
 */
import type { Collider, OutdoorLevel, PropDef, RingDef } from '../types';

type V3 = [number, number, number];

export const TRAINING_HALF = 40;
export const TRAINING_CEILING = 40;
const RING_RADIUS = 1.25;
const RING_TUBE = 0.1;
const POLE_HEIGHT = 6;

function ring(i: number, position: V3, direction: V3): RingDef {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  return { id: `ring-${i}`, position, direction: [direction[0] / len, direction[1] / len, direction[2] / len], radius: RING_RADIUS, tube: RING_TUBE };
}

function cylinderProp(id: string, kind: PropDef['kind'], x: number, z: number, diameter: number, height: number, colliderRadius = diameter / 2): PropDef {
  return {
    id,
    kind,
    position: [x, 0, z],
    size: [diameter, height, diameter],
    colliders: [{ id, shape: { kind: 'cylinder', center: [x, height / 2, z], radius: colliderRadius, halfHeight: height / 2 } }],
  };
}

/** Deterministic 0..1 sequence (mulberry32): the treeline is the same on every device. */
function seq(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Trees in loose clumps 58–90 m out, all outside the field so they frame it without blocking the course. */
function treeline(): PropDef[] {
  const rnd = seq(20261002);
  const out: PropDef[] = [];
  const clumps = 17;
  for (let c = 0; c < clumps; c++) {
    const a = (c / clumps) * Math.PI * 2 + rnd() * 0.25;
    const r = 58 + rnd() * 26;
    const cx = Math.sin(a) * r;
    const cz = -Math.cos(a) * r;
    const n = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const x = cx + (rnd() - 0.5) * 14;
      const z = cz + (rnd() - 0.5) * 14;
      if (Math.max(Math.abs(x), Math.abs(z)) < TRAINING_HALF + 8) continue;
      const height = 6 + rnd() * 7;
      const crown = height * (0.42 + rnd() * 0.16);
      const id = `tree-${out.length}`;
      const trunk: Collider = { id, shape: { kind: 'cylinder', center: [x, height * 0.2, z], radius: 0.25, halfHeight: height * 0.2 } };
      const canopy: Collider = { id, shape: { kind: 'cylinder', center: [x, height * 0.62, z], radius: crown / 2, halfHeight: height * 0.38 } };
      out.push({ id, kind: 'tree', position: [x, 0, z], size: [crown, height, crown], yaw: rnd() * Math.PI * 2, colliders: [trunk, canopy] });
    }
  }
  return out;
}

const corner = (sx: number, sz: number): PropDef => cylinderProp(`pole-${sz < 0 ? 'n' : 's'}${sx < 0 ? 'w' : 'e'}`, 'pole', sx * TRAINING_HALF, sz * TRAINING_HALF, 0.24, POLE_HEIGHT);

const CONES: [number, number][] = [
  [-2.6, 30.4],
  [2.6, 30.4],
  [-2.6, 25.5],
  [2.6, 25.5],
  [19.5, 13.5],
  [21, 9],
  [-7, 21],
  [-7.5, 25],
];

const props: PropDef[] = [
  { id: 'pad', kind: 'pad', position: [0, 0, 33], size: [5, 0.01, 5], colliders: [] },
  corner(-1, -1),
  corner(1, -1),
  corner(-1, 1),
  corner(1, 1),
  ...CONES.map(([x, z], i) => cylinderProp(`cone-${i}`, 'cone', x, z, 0.36, 0.5, 0.16)),
  cylinderProp('windsock', 'windsock', -24, 30, 0.1, 4.5, 0.05),
  { id: 'hill-w', kind: 'hill', position: [-230, 0, -390], size: [380, 62, 240], colliders: [] },
  { id: 'hill-e', kind: 'hill', position: [250, 0, -350], size: [420, 84, 260], yaw: 0.4, colliders: [] },
  ...treeline(),
];

export const TRAINING_LEVEL: OutdoorLevel = {
  id: 'training',
  kind: 'outdoor',
  name: 'Training Field',
  env: {
    sky: {
      top: 0x2a6fd0,
      horizon: 0xbfd8ea,
      sunDir: [-0.5, 0.56, 0.66],
      sunColor: 0xffe2bc,
      sunIntensity: 7,
      hemi: [0xc4dcff, 0x5a6b34],
    },
    fog: { color: 0xbfd8ea, viewDistance: 1100 },
    ambience: { kind: 'wind', gain: 0.4 },
    shadows: 'static-sun',
  },
  bounds: { kind: 'rect', min: [-TRAINING_HALF, -TRAINING_HALF], max: [TRAINING_HALF, TRAINING_HALF], maxAgl: TRAINING_CEILING },
  rings: [ring(0, [0, 3, 22], [0, 0, -1]), ring(1, [14, 4, 8], [-1, 0, -1]), ring(2, [-4, 3, 28], [0, 0, 1])],
  spawn: { position: [0, 0.06, 33], yaw: 0 },
  pilot: [0, 1.7, 36],
  pilotPlatform: 2,
  world: { gen: 'flat' },
  props,
  statics: [],
};
