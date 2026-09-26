/**
 * Fixed-timestep accumulator ("Fix Your Timestep"): simulation advances in exact `dt` steps
 * regardless of display refresh; render interpolates with the returned alpha.
 */
export class FixedLoop {
  private accumulator = 0;

  constructor(
    readonly dt: number,
    /** spiral-of-death guard: extra time beyond this many steps is dropped (game slows down) */
    readonly maxStepsPerFrame: number,
  ) {}

  /** Advance by real frame time; calls `step` N times; returns interpolation alpha in [0,1). */
  advance(frameSeconds: number, step: (dt: number) => void): number {
    this.accumulator += Math.min(Math.max(frameSeconds, 0), 0.25);
    let steps = 0;
    while (this.accumulator >= this.dt && steps < this.maxStepsPerFrame) {
      step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    if (steps === this.maxStepsPerFrame && this.accumulator >= this.dt) this.accumulator = 0;
    return this.accumulator / this.dt;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

/** Exponential moving average frame-rate meter. */
export class FpsMeter {
  fps = 0;
  frameMs = 0;

  sample(frameSeconds: number): void {
    if (frameSeconds <= 0) return;
    const ms = frameSeconds * 1000;
    this.frameMs = this.frameMs === 0 ? ms : this.frameMs * 0.95 + ms * 0.05;
    this.fps = 1000 / this.frameMs;
  }
}
