import type { ControlInput, DroneState, RoomLevelData } from '../../src/types';
import { GRAVITY, type DroneParams } from '../../src/physics/drone-params';

/** Huge empty room: no props, no rings — for free-flight physics truths. */
export const EMPTY_LEVEL: RoomLevelData = {
  name: 'empty',
  room: { size: [2000, 1000, 2000], windows: [] },
  props: [],
  rings: [],
  spawn: { position: [0, 0.1, 0], yaw: 0 },
  pilot: [0, 1.7, 5],
};

export function input(throttle = 0, roll = 0, pitch = 0, yaw = 0): ControlInput {
  return { throttle, roll, pitch, yaw };
}

/** Total mechanical energy (translational + rotational + potential), J. */
export function energy(s: DroneState, p: DroneParams): number {
  const w = s.angularVelocity;
  const I = p.inertia;
  return (
    0.5 * p.mass * s.velocity.lengthSq() +
    0.5 * (I[0] * w.x * w.x + I[1] * w.y * w.y + I[2] * w.z * w.z) +
    p.mass * GRAVITY * s.position.y
  );
}

/** Tilt of body +Y from world +Y, degrees. */
export function tiltDeg(s: DroneState): number {
  const q = s.orientation;
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI;
}
