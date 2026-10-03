/**
 * Loading progress from weighted stages (DOM-free, unit-tested). Stages report 0..1 of their own work; the
 * overall `target` is the weighted sum, monotonic (a stage never goes back, later reports complete the earlier
 * stages). `tick(now)` gives what the bar shows: it eases toward the target and, while no report arrives, creeps
 * on inside the current stage (asymptotically, never past CREEP_SHARE of what is left of it), so the bar is always
 * moving and never jumps backwards.
 */

export interface LoadStage {
  id: string;
  /** shown under the bar */
  label: string;
  /** share of the whole load (normalised over the stages) */
  weight: number;
}

/** while a stage is silent the bar may creep this share of the rest of the stage */
export const CREEP_SHARE = 0.85;
/** creep time constant (ms): about 63 % of the allowed creep after this long without a report */
export const CREEP_MS = 1400;
/** easing time constant of the shown value towards the goal (ms) */
export const EASE_MS = 120;
/** once everything is done the bar closes the rest this fast (ms): the hand-off does not wait on a slow tail */
export const EASE_DONE_MS = 40;

export class LoadProgress {
  private readonly stages: readonly LoadStage[];
  private readonly starts: number[] = [];
  private readonly total: number;
  private index = 0;
  private within = 0;
  private reportedAt = 0;
  private shown = 0;
  private lastTick = -1;
  private done = false;

  constructor(stages: readonly LoadStage[], now = 0) {
    if (stages.length === 0) throw new Error('LoadProgress needs at least one stage');
    this.stages = stages;
    let sum = 0;
    for (const s of stages) {
      this.starts.push(sum);
      sum += Math.max(0, s.weight);
    }
    this.total = sum > 0 ? sum : 1;
    this.reportedAt = now;
  }

  /** the stage running now */
  get stage(): LoadStage {
    return this.stages[this.index]!;
  }

  /** overall progress the reports add up to (0..1, never decreases) */
  get target(): number {
    if (this.done) return 1;
    const s = this.stages[this.index]!;
    return Math.min(1, (this.starts[this.index]! + Math.max(0, s.weight) * this.within) / this.total);
  }

  /** end of the current stage (0..1) */
  private get stageEnd(): number {
    return Math.min(1, (this.starts[this.index]! + Math.max(0, this.stages[this.index]!.weight)) / this.total);
  }

  /**
   * Stage `id` is `f` (0..1) done. A later stage completes everything before it; a report for an earlier stage, or
   * a smaller fraction for the current one, changes nothing (monotonic). Unknown ids are ignored.
   */
  report(id: string, f: number, now = 0): void {
    if (this.done) return;
    const i = this.stages.findIndex((s) => s.id === id);
    if (i < 0 || i < this.index) return;
    const frac = Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0));
    if (i > this.index) {
      this.index = i;
      this.within = frac;
    } else if (frac > this.within) this.within = frac;
    else return;
    this.reportedAt = now;
  }

  /** Everything done: the bar runs to 100 %. */
  complete(): void {
    this.done = true;
  }

  get completed(): boolean {
    return this.done;
  }

  /** The value the bar shows at `now` (ms): eased toward the target plus creep; never decreases, 1 once complete and caught up. */
  tick(now: number): number {
    const dt = this.lastTick < 0 ? 16 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const target = this.target;
    let goal = target;
    if (!this.done) {
      const silent = Math.max(0, now - this.reportedAt);
      goal = target + (this.stageEnd - target) * CREEP_SHARE * (1 - Math.exp(-silent / CREEP_MS));
    }
    const k = 1 - Math.exp(-dt / (this.done ? EASE_DONE_MS : EASE_MS));
    let next = this.shown + (goal - this.shown) * k;
    // never stall on a sub-pixel tail: finish the last bit once very close
    if (this.done && 1 - next < 0.002) next = 1;
    this.shown = Math.min(1, Math.max(this.shown, next));
    return this.shown;
  }

  /** what the bar shows now (last tick) */
  get shownValue(): number {
    return this.shown;
  }
}

/** Load stages of a level (labels as the loading screen shows them); generated levels spend longer generating. */
export function levelStages(kind: 'indoor' | 'authored' | 'terrain' | 'city'): LoadStage[] {
  const gen = kind === 'terrain' ? { label: 'Generating terrain', weight: 34 } : kind === 'city' ? { label: 'Building city', weight: 22 } : { label: 'Building level', weight: 8 };
  return [
    { id: 'code', label: 'Loading level', weight: 4 },
    { id: 'generate', ...gen },
    { id: 'textures', label: 'Loading textures', weight: kind === 'indoor' ? 26 : 18 },
    { id: 'scene', label: 'Building scenery', weight: 12 },
    { id: 'shaders', label: 'Compiling shaders', weight: 22 },
    { id: 'lighting', label: 'Preparing lighting', weight: 10 },
    { id: 'warm', label: 'Ready', weight: 4 },
  ];
}
