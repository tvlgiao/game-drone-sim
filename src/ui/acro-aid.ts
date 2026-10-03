/**
 * Acro aids for new pilots (DOM-free): the one-time "no self-level" tip a touch pilot gets on switching to
 * Acro, and the attitude the HUD's artificial horizon shows while in Acro.
 */
import { Euler, Vector3, type Quaternion } from 'three';
import type { FlightMode, InputSource } from '../types';

export const ACRO_TIP_KEY = 'drone-sim.acro-tip.v1';
export const ACRO_TIP = 'Acro: no self-level — the stick sets rotation rate; centre it to hold the attitude. Switch to Angle for stable flight.';
/** how long the tip stays up (ms): it is longer than a mode toast */
export const ACRO_TIP_MS = 6500;

/**
 * Hands out the Acro tip once: the first switch to Acro from the touch sticks. Remembered in storage; with
 * storage blocked it is shown once per launch.
 */
export class AcroTip {
  private shown: boolean;

  constructor(private readonly storage: Storage | null) {
    let seen = false;
    try {
      seen = storage?.getItem(ACRO_TIP_KEY) === '1';
    } catch {
      // storage blocked: once per launch
    }
    this.shown = seen;
  }

  /** The tip text when `mode` was just switched to on `source` and the tip is due, else null (and it is spent). */
  take(source: InputSource, mode: FlightMode): string | null {
    if (this.shown || mode !== 'acro' || source !== 'touch') return null;
    this.shown = true;
    try {
      this.storage?.setItem(ACRO_TIP_KEY, '1');
    } catch {
      // quota / privacy mode: it still shows only once this launch
    }
    return ACRO_TIP;
  }
}

export interface Attitude {
  /** + right wing down (deg, −180..180) */
  rollDeg: number;
  /** + nose up (deg, −90..90) */
  pitchDeg: number;
  /** belly up (the body's up axis points below the horizon) */
  inverted: boolean;
}

const _e = new Euler();
const _up = new Vector3();

/** Roll / pitch of a body orientation (body +Y up, −Z forward) for the artificial horizon. */
export function attitudeOf(q: Quaternion, out: Attitude = { rollDeg: 0, pitchDeg: 0, inverted: false }): Attitude {
  _e.setFromQuaternion(q, 'YXZ');
  out.rollDeg = (-_e.z * 180) / Math.PI;
  out.pitchDeg = (_e.x * 180) / Math.PI;
  out.inverted = _up.set(0, 1, 0).applyQuaternion(q).y < 0;
  return out;
}
