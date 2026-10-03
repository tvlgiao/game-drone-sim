/**
 * Traffic lights: two phases per intersection — the ±x approaches together, then the ±z approaches — each green,
 * yellow, then a short all-red. Straight and right turns go on green; left turns yield to the oncoming approach
 * (the simulation checks the box and the oncoming lane). An intersection with only one axis present has one phase.
 * Each intersection starts its cycle at a hashed offset (no green wave across the whole grid). Pure; the state is a
 * function of the clock.
 */
import { hash1, u01 } from '../rng';

export const SIGNAL = { green: 0, yellow: 1, red: 2 } as const;
export type SignalState = (typeof SIGNAL)[keyof typeof SIGNAL];

export const SIGNAL_GREEN = 12;
export const SIGNAL_YELLOW = 3;
export const SIGNAL_ALL_RED = 1.5;
export const SIGNAL_SLOT = SIGNAL_GREEN + SIGNAL_YELLOW + SIGNAL_ALL_RED;
const SALT_SIGNAL = 0x51a1;

/** phase of an approach (0 +x, 1 +z, 2 −x, 3 −z arriving heading): 0 = the x axis, 1 = the z axis */
export const phaseOf = (approach: number): number => approach & 1;

export class SignalPlan {
  /** per node: bit 0 = x-axis phase present, bit 1 = z-axis phase present */
  private readonly phases: Uint8Array;
  private readonly offset: Float64Array;

  constructor(seed: number, approaches: readonly (readonly number[])[]) {
    const n = approaches.length;
    this.phases = new Uint8Array(n);
    this.offset = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const a of approaches[i]!) m |= 1 << phaseOf(a);
      this.phases[i] = m;
      this.offset[i] = u01(hash1(seed, i, SALT_SIGNAL)) * this.count(i) * SIGNAL_SLOT;
    }
  }

  get nodes(): number {
    return this.phases.length;
  }

  private count(node: number): number {
    const m = this.phases[node]!;
    return (m & 1) + ((m >> 1) & 1);
  }

  /** seconds one full cycle of `node` takes */
  cycle(node: number): number {
    return this.count(node) * SIGNAL_SLOT;
  }

  /** State of `approach` at `node` at clock `t` (s). */
  state(node: number, approach: number, t: number): SignalState {
    const m = this.phases[node]!;
    const n = (m & 1) + ((m >> 1) & 1);
    if (n === 0) return SIGNAL.green;
    const cyc = n * SIGNAL_SLOT;
    let local = (t + this.offset[node]!) % cyc;
    if (local < 0) local += cyc;
    const slot = Math.floor(local / SIGNAL_SLOT);
    // slot k → the k-th present phase
    const phase = n === 2 ? slot : m & 1 ? 0 : 1;
    if (phase !== phaseOf(approach)) return SIGNAL.red;
    const k = local - slot * SIGNAL_SLOT;
    return k < SIGNAL_GREEN ? SIGNAL.green : k < SIGNAL_GREEN + SIGNAL_YELLOW ? SIGNAL.yellow : SIGNAL.red;
  }
}
