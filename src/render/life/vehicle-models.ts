/**
 * Low-poly vehicles of the living world (sedan, hatchback, SUV, van, bus, taxi), built to the VEHICLES dimensions:
 * front at +Z, ground at y = 0, centred on x / z. A side profile extruded across the width with the greenhouse
 * leaning in, glass, bumpers, light clusters, wheels with rims. Parts ride in uv.x (VEHICLE_PART) so one shader
 * paints the body by the instance colour, darkens the glass and lights the lamps.
 */
import type * as THREE from 'three';
import { VEHICLE, VEHICLES } from '../../world/traffic/vehicles';
import { GeoBuilder } from './geo';

export const VEHICLE_PART = { trim: 0, paint: 1, glass: 2, head: 3, tail: 4, tyre: 5, sign: 6, cabin: 7 } as const;

const TRIM = 0x26282b;
const BUMPER = 0x3a3c40;
const TYRE = 0x161616;
const RIM = 0x6d7176;
const GLASS = 0x1a2026;
const HEAD = 0xf2efe2;
const TAIL = 0x8a1410;

/** Clockwise (z right, y up) side profile → see GeoBuilder.extrude. */
type Profile = [number, number][];

interface Body {
  /** lower body profile */
  body: Profile;
  /** greenhouse: [base rear, rear top, front top, base front] (clockwise) */
  cabin: Profile;
  /** cabin edge indices that are glass (others paint) */
  glass: number[];
  belt: number;
  tumble: number;
  wheelR: number;
  axles: number[];
  /** light cluster height, front and rear */
  lightY: [number, number];
}

function wheels(g: GeoBuilder, W: number, r: number, axles: readonly number[], track = 0.1): void {
  // six-sided tyres showing only their outer face, the rim painted on it
  for (const z of axles) for (const s of [-1, 1]) g.cylinderX(s * (W / 2 - track), r, z, r, 0.22, 6, TYRE, RIM, VEHICLE_PART.tyre, 0, s as 1 | -1);
}

function car(type: number, b: Body): GeoBuilder {
  const spec = VEHICLES[type]!;
  const L = spec.length;
  const W = spec.width;
  const g = new GeoBuilder();
  const half = W / 2;
  g.extrude(b.body, half, { edge: () => [0xffffff, VEHICLE_PART.paint], cap: [0xffffff, VEHICLE_PART.paint] });
  g.extrude(b.cabin, half - 0.06, {
    belt: b.belt,
    top: Math.max(...b.cabin.map((p) => p[1])),
    inset: b.tumble,
    edge: (i) => (b.glass.includes(i) ? [GLASS, VEHICLE_PART.glass] : [0xffffff, VEHICLE_PART.paint]),
    cap: [GLASS, VEHICLE_PART.glass],
    skipEdges: [b.cabin.length - 1],
  });
  // B-pillar strip over the side glass
  const cz = (b.cabin[0]![0] + b.cabin[b.cabin.length - 1]![0]) / 2;
  const top = Math.max(...b.cabin.map((p) => p[1]));
  g.box(0, (b.belt + top) / 2, cz, W - 2 * 0.06 - b.tumble * 0.9 + 0.02, top - b.belt - 0.04, 0.12, 0xffffff, VEHICLE_PART.paint);
  // bumpers, grille, light clusters, mirrors
  const [fy, ry] = b.lightY;
  g.box(0, 0.36, L / 2 - 0.08, W + 0.02, 0.22, 0.2, BUMPER, VEHICLE_PART.trim);
  g.box(0, 0.36, -L / 2 + 0.08, W + 0.02, 0.22, 0.2, BUMPER, VEHICLE_PART.trim);
  g.panel(0, fy - 0.05, L / 2 + 0.01, W * 0.36, 0.13, 1, TRIM, VEHICLE_PART.trim);
  for (const s of [-1, 1]) {
    g.panel(s * (half - 0.26), fy, L / 2 + 0.012, 0.36, 0.13, 1, HEAD, VEHICLE_PART.head);
    g.panel(s * (half - 0.2), ry, -L / 2 - 0.012, 0.3, 0.14, -1, TAIL, VEHICLE_PART.tail);
  }
  wheels(g, W, b.wheelR, b.axles);
  return g;
}

function sedan(): GeoBuilder {
  return car(VEHICLE.sedan, {
    body: [
      [-2.25, 0.3],
      [-2.25, 0.82],
      [-2.05, 0.95],
      [1.95, 0.88],
      [2.25, 0.7],
      [2.25, 0.3],
    ],
    cabin: [
      [-1.55, 0.95],
      [-0.95, 1.43],
      [0.15, 1.45],
      [0.95, 0.9],
    ],
    glass: [0, 2],
    belt: 0.92,
    tumble: 0.16,
    wheelR: 0.32,
    axles: [-1.4, 1.38],
    lightY: [0.72, 0.82],
  });
}

function taxi(): GeoBuilder {
  const g = car(VEHICLE.taxi, {
    body: [
      [-2.3, 0.3],
      [-2.3, 0.84],
      [-2.08, 0.96],
      [2.0, 0.89],
      [2.3, 0.7],
      [2.3, 0.3],
    ],
    cabin: [
      [-1.58, 0.96],
      [-0.98, 1.42],
      [0.15, 1.44],
      [0.97, 0.9],
    ],
    glass: [0, 2],
    belt: 0.93,
    tumble: 0.16,
    wheelR: 0.32,
    axles: [-1.42, 1.4],
    lightY: [0.72, 0.83],
  });
  // roof sign
  g.box(0, 1.5, -0.42, 0.62, 0.14, 0.3, 0xfff1a8, VEHICLE_PART.sign);
  return g;
}

function hatchback(): GeoBuilder {
  return car(VEHICLE.hatchback, {
    body: [
      [-1.97, 0.3],
      [-1.97, 0.92],
      [1.72, 0.88],
      [1.97, 0.68],
      [1.97, 0.3],
    ],
    cabin: [
      [-1.95, 0.93],
      [-1.75, 1.47],
      [0.05, 1.5],
      [0.85, 0.9],
    ],
    glass: [0, 2],
    belt: 0.92,
    tumble: 0.14,
    wheelR: 0.31,
    axles: [-1.25, 1.25],
    lightY: [0.7, 0.98],
  });
}

function suv(): GeoBuilder {
  return car(VEHICLE.suv, {
    body: [
      [-2.37, 0.38],
      [-2.37, 1.05],
      [2.0, 1.02],
      [2.37, 0.88],
      [2.37, 0.38],
    ],
    cabin: [
      [-2.3, 1.05],
      [-2.15, 1.74],
      [0.25, 1.76],
      [1.05, 1.02],
    ],
    glass: [0, 2],
    belt: 1.04,
    tumble: 0.12,
    wheelR: 0.38,
    axles: [-1.5, 1.45],
    lightY: [0.88, 1.1],
  });
}

function van(): GeoBuilder {
  const g = car(VEHICLE.van, {
    body: [
      [-2.65, 0.36],
      [-2.65, 1.15],
      [1.95, 1.1],
      [2.65, 0.8],
      [2.65, 0.36],
    ],
    cabin: [
      [-2.62, 1.15],
      [-2.62, 2.3],
      [1.25, 2.3],
      [2.0, 1.1],
    ],
    glass: [2],
    belt: 1.12,
    tumble: 0.05,
    wheelR: 0.36,
    axles: [-1.75, 1.75],
    lightY: [0.85, 1.25],
  });
  return g;
}

function bus(): GeoBuilder {
  const spec = VEHICLES[VEHICLE.bus]!;
  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const g = new GeoBuilder();
  const z0 = -L / 2;
  const z1 = L / 2;
  // lower body
  g.extrude(
    [
      [z0, 0.35],
      [z0, 1.15],
      [z1, 1.15],
      [z1, 0.35],
    ],
    W / 2,
    { edge: () => [0xffffff, VEHICLE_PART.paint], cap: [0xffffff, VEHICLE_PART.paint] },
  );
  // window band (lit cabin at dusk) and the roof
  g.extrude(
    [
      [z0, 1.15],
      [z0, 2.55],
      [z1 - 0.15, 2.55],
      [z1, 1.15],
    ],
    W / 2 - 0.02,
    { edge: (i) => (i === 2 ? [GLASS, VEHICLE_PART.glass] : [0xffffff, VEHICLE_PART.paint]), cap: [GLASS, VEHICLE_PART.cabin], skipEdges: [3] },
  );
  g.extrude(
    [
      [z0, 2.55],
      [z0 + 0.1, H],
      [z1 - 0.3, H],
      [z1 - 0.15, 2.55],
    ],
    W / 2 - 0.02,
    { edge: () => [0xffffff, VEHICLE_PART.paint], cap: [0xffffff, VEHICLE_PART.paint], skipEdges: [3] },
  );
  // pillars between the side windows
  for (let z = z0 + 1.6; z < z1 - 1.5; z += 1.55) g.box(0, 1.85, z, W + 0.005, 1.4, 0.16, 0xffffff, VEHICLE_PART.paint);
  // destination sign, bumpers, lights
  g.panel(0, 2.35, z1 + 0.012, W * 0.7, 0.26, 1, 0xffb347, VEHICLE_PART.sign);
  g.box(0, 0.4, z1 - 0.05, W + 0.02, 0.3, 0.14, BUMPER, VEHICLE_PART.trim);
  g.box(0, 0.4, z0 + 0.05, W + 0.02, 0.3, 0.14, BUMPER, VEHICLE_PART.trim);
  for (const s of [-1, 1]) {
    g.panel(s * (W / 2 - 0.3), 0.75, z1 + 0.012, 0.34, 0.16, 1, HEAD, VEHICLE_PART.head);
    g.panel(s * (W / 2 - 0.2), 1.0, z0 - 0.012, 0.24, 0.32, -1, TAIL, VEHICLE_PART.tail);
  }
  wheels(g, W, 0.5, [-L / 2 + 2.6, L / 2 - 2.3], 0.15);
  return g;
}

/** One geometry per vehicle type (VEHICLE order). */
export function vehicleModels(): THREE.BufferGeometry[] {
  return [sedan(), hatchback(), suv(), van(), bus(), taxi()].map((g) => g.build());
}

/**
 * Low-tier stand-in for every type (Quest: one draw): a 1 × 1 × 1 body with a cabin and four wheels, stretched to
 * each vehicle's width / height / length per instance.
 */
export function genericVehicleModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.box(0, 0.42, 0, 1, 0.48, 1, 0xffffff, VEHICLE_PART.paint);
  // greenhouse: glass sides, painted roof
  g.extrude(
    [
      [-0.36, 0.66],
      [-0.26, 1],
      [0.12, 1],
      [0.26, 0.66],
    ],
    0.44,
    { edge: (i) => (i === 1 ? [0xffffff, VEHICLE_PART.paint] : [GLASS, VEHICLE_PART.glass]), cap: [GLASS, VEHICLE_PART.glass], skipEdges: [3] },
  );
  for (const s of [-1, 1]) {
    g.box(s * 0.32, 0.5, 0.501, 0.22, 0.1, 0.01, HEAD, VEHICLE_PART.head);
    g.box(s * 0.34, 0.55, -0.501, 0.2, 0.1, 0.01, TAIL, VEHICLE_PART.tail);
    for (const z of [-0.3, 0.3]) g.box(s * 0.46, 0.17, z, 0.1, 0.34, 0.15, TYRE, VEHICLE_PART.tyre);
  }
  return g.build();
}
