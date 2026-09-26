/** Discrete filters used by the flight controller. */

/** First-order low-pass (RC) filter; dt may vary per sample. */
export class LowPass1 {
  value = 0;
  private readonly rc: number;

  constructor(cutoffHz: number) {
    this.rc = 1 / (2 * Math.PI * cutoffHz);
  }

  update(x: number, dt: number): number {
    this.value += (dt / (this.rc + dt)) * (x - this.value);
    return this.value;
  }

  reset(v = 0): void {
    this.value = v;
  }
}
