/** Seeded PRNG (mulberry32) with a Box–Muller Gaussian; deterministic across runs and platforms. */
export class Rng {
  private s: number;
  private spare = 0;
  private hasSpare = false;

  constructor(seed = 1) {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal sample. */
  gaussian(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    const u = 1 - this.next();
    const v = this.next();
    const m = Math.sqrt(-2 * Math.log(u));
    this.spare = m * Math.sin(2 * Math.PI * v);
    this.hasSpare = true;
    return m * Math.cos(2 * Math.PI * v);
  }

  reseed(seed: number): void {
    this.s = seed >>> 0;
    this.hasSpare = false;
  }
}
