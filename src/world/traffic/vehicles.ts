/**
 * Vehicle types of the living world: outer dimensions (the kinematic collider and the model's bounding box),
 * car-following parameters (intelligent driver model) and how often each type appears. Pure data.
 */

export const VEHICLE = { sedan: 0, hatchback: 1, suv: 2, van: 3, bus: 4, taxi: 5 } as const;
export type VehicleType = (typeof VEHICLE)[keyof typeof VEHICLE];
export const VEHICLE_TYPES = 6;

export interface VehicleSpec {
  readonly name: keyof typeof VEHICLE;
  /** length (local Z), width (X), height (Y), m */
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** desired speed, m/s */
  readonly v0: number;
  /** IDM maximum acceleration and comfortable deceleration, m/s² */
  readonly accel: number;
  readonly decel: number;
  /** IDM time headway, s */
  readonly headway: number;
  /** relative frequency in city traffic */
  readonly weight: number;
}

export const VEHICLES: readonly VehicleSpec[] = [
  { name: 'sedan', length: 4.5, width: 1.84, height: 1.45, v0: 13.5, accel: 2.0, decel: 3.0, headway: 1.3, weight: 0.33 },
  { name: 'hatchback', length: 3.95, width: 1.76, height: 1.5, v0: 13, accel: 2.0, decel: 3.0, headway: 1.3, weight: 0.21 },
  { name: 'suv', length: 4.75, width: 1.95, height: 1.76, v0: 13.5, accel: 1.8, decel: 3.0, headway: 1.4, weight: 0.18 },
  { name: 'van', length: 5.3, width: 2.0, height: 2.3, v0: 12, accel: 1.5, decel: 2.8, headway: 1.5, weight: 0.1 },
  { name: 'bus', length: 11.6, width: 2.5, height: 3.1, v0: 10.5, accel: 1.0, decel: 2.5, headway: 1.8, weight: 0.06 },
  { name: 'taxi', length: 4.6, width: 1.84, height: 1.5, v0: 13.5, accel: 2.1, decel: 3.0, headway: 1.2, weight: 0.12 },
];

/** tallest vehicle (ring clearance checks) */
export const VEHICLE_MAX_HEIGHT = 3.1;
/** widest vehicle */
export const VEHICLE_MAX_WIDTH = 2.5;
/** bumper-to-bumper gap a stopped car keeps, m (IDM s0) */
export const STANDSTILL_GAP = 2.2;

/** Paint colours (sRGB 0xRRGGBB): index into this is the car's colour; the renderer reads the same table. */
export const PAINT = [
  0x1b2433, // midnight blue
  0xc2c6ca, // silver
  0x8c1d1d, // red
  0xe9e7e1, // white
  0x2c2d30, // graphite
  0x14161a, // black
  0x2f4a3a, // forest green
  0x2e5a8c, // blue
  0x8a6a3a, // bronze
  0x5a5f66, // gunmetal
  0xb04a1c, // orange
  0x6d7b85, // steel blue
  0xd8b21a, // taxi yellow
  0xf3f1ea, // bus white
  0x1f6e8c, // bus teal
  0xa3241c, // bus red
] as const;
export const PAINT_TAXI = 12;
const PRIVATE_PAINTS = 12;
const BUS_PAINTS = [13, 14, 15] as const;

/** Picks a type from a uniform 0..1 by VEHICLES[].weight (or `allowed` only). */
export function pickVehicle(u: number, allowed: readonly number[] | null = null): VehicleType {
  let total = 0;
  for (let t = 0; t < VEHICLE_TYPES; t++) if (!allowed || allowed.includes(t)) total += VEHICLES[t]!.weight;
  let x = u * total;
  for (let t = 0; t < VEHICLE_TYPES; t++) {
    if (allowed && !allowed.includes(t)) continue;
    x -= VEHICLES[t]!.weight;
    if (x < 0) return t as VehicleType;
  }
  return (allowed ? allowed[allowed.length - 1]! : VEHICLE_TYPES - 1) as VehicleType;
}

/** Paint index for a vehicle of `type` from a uniform 0..1. */
export function pickPaint(type: number, u: number): number {
  if (type === VEHICLE.taxi) return PAINT_TAXI;
  if (type === VEHICLE.bus) return BUS_PAINTS[Math.min(BUS_PAINTS.length - 1, Math.floor(u * BUS_PAINTS.length))]!;
  return Math.min(PRIVATE_PAINTS - 1, Math.floor(u * PRIVATE_PAINTS));
}
