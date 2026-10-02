/** Physical parameters of the reference 3-inch indoor quad (design doc §4). SI units. */

export interface MotorSpec {
  /** body-frame position of the rotor hub, metres (-Z forward, +X right, +Y up) */
  position: [number, number, number];
  /** +1: prop spins CCW seen from above (angular velocity along +Y); -1: CW */
  spin: 1 | -1;
}

export interface DroneParams {
  mass: number;
  /** principal moments Ixx, Iyy, Izz (kg·m²) in body frame */
  inertia: [number, number, number];
  armLength: number;
  maxThrustPerMotor: number;
  tauUp: number;
  tauDown: number;
  /** reaction torque per newton of thrust (m) */
  yawTorqueCoef: number;
  /** quadratic drag C_d·A per body axis (m²) */
  dragCdA: [number, number, number];
  /** linear rotor (H-force) drag per unit normalised total thrust, N/(m/s) */
  rotorDrag: number;
  propRadius: number;
  colliderRadius: number;
  propColliderRadius: number;
  /**
   * full/empty resting volts; sagPerThrust = volts lost per unit of summed normalised thrust (0..4);
   * capacityS = summed-normalised-thrust·seconds until empty (hover ≈ 0.88/s ⇒ ~5.5 min)
   */
  battery: { full: number; empty: number; sagPerThrust: number; capacityS: number };
  /** motor idle fraction when armed */
  idle: number;
}

const ARM = 0.066;
const D = ARM / Math.SQRT2;

export const DEFAULT_DRONE: DroneParams = {
  mass: 0.26,
  inertia: [3.2e-4, 5.6e-4, 3.2e-4],
  armLength: ARM,
  maxThrustPerMotor: 2.9,
  tauUp: 0.025,
  tauDown: 0.04,
  yawTorqueCoef: 0.012,
  dragCdA: [0.012, 0.018, 0.012],
  rotorDrag: 0.08,
  propRadius: 0.038,
  colliderRadius: 0.075,
  propColliderRadius: 0.04,
  // empty = 3.3 V/cell resting: load sag then crosses the HUD's 3.55 V warning (~85 %) and 3.3 V critical (~98 %)
  battery: { full: 16.8, empty: 13.2, sagPerThrust: 0.08, capacityS: 300 },
  idle: 0.055,
};

/** Motor order FR, RL, FL, RR. Diagonal pairs share spin direction (quad-X). */
export const MOTOR_LAYOUT: readonly MotorSpec[] = [
  { position: [D, 0.02, -D], spin: 1 },
  { position: [-D, 0.02, D], spin: 1 },
  { position: [-D, 0.02, -D], spin: -1 },
  { position: [D, 0.02, D], spin: -1 },
];

/** Body-frame offset of the centre collider sphere: above the COM so a landed quad rocks back level. */
export const CENTER_COLLIDER_OFFSET: [number, number, number] = [0, 0.03, 0];

export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.225;

/** Normalised motor command that exactly balances gravity with a full battery. */
export function hoverThrottle(p: DroneParams = DEFAULT_DRONE): number {
  return Math.sqrt((p.mass * GRAVITY) / (4 * p.maxThrustPerMotor));
}
