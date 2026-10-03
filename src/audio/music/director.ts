/**
 * Adaptive music state machine (pure): game status, race progress and the last crash pick a music state;
 * each state is a target mix of the six stems plus a low-pass and a level. The player glides to it.
 */
import type { RaceStatus } from '../../types';
import { STEMS, type StemName } from './songs';

export type MusicState = 'menu' | 'chill' | 'countdown' | 'race' | 'final' | 'crash' | 'paused' | 'finished';

export interface MusicInputs {
  status: RaceStatus;
  /** race: index of the next ring and the course length */
  nextRing: number;
  totalRings: number;
  /** race clock and the level's best (s) */
  time: number;
  bestTime: number | null;
  /** status the race was in before a crash / pause (crash keeps the race mix under the filter) */
  previous?: MusicState;
}

export interface MusicMix {
  layers: Record<StemName, number>;
  /** music low-pass cutoff (Hz) */
  cutoff: number;
  /** music level (dB) */
  gainDb: number;
  /** glide time constant towards this mix (s) */
  glide: number;
}

/** Progress (0..1) from which a race counts as the final stretch, and the share of the best time that does. */
export const FINAL_PROGRESS = 0.75;
export const FINAL_PACE = 0.8;

/** Whether a race is in its final stretch: the last quarter of the rings, or the clock closing on the best. */
export function finalStretch(i: Pick<MusicInputs, 'nextRing' | 'totalRings' | 'time' | 'bestTime'>): boolean {
  if (i.totalRings > 0 && i.nextRing / i.totalRings >= FINAL_PROGRESS) return true;
  return i.bestTime !== null && i.bestTime > 0 && i.time >= FINAL_PACE * i.bestTime;
}

export function musicState(i: MusicInputs): MusicState {
  switch (i.status) {
    case 'menu':
      return 'menu';
    case 'countdown':
      return 'countdown';
    case 'racing':
      return finalStretch(i) ? 'final' : 'race';
    case 'freefly':
      return 'chill';
    case 'crashed':
      return 'crash';
    case 'paused':
      return 'paused';
    case 'finished':
      return 'finished';
  }
}

const L = (pad: number, bass: number, arp: number, beat: number, perc: number, lead: number): Record<StemName, number> => ({ pad, bass, arp, beat, perc, lead });

const OPEN = 18000;

export const MIXES: Readonly<Record<Exclude<MusicState, 'crash' | 'paused'>, MusicMix>> = {
  menu: { layers: L(0.9, 0.35, 0.55, 0, 0, 0), cutoff: 4200, gainDb: -2, glide: 0.8 },
  chill: { layers: L(0.85, 0.8, 0.75, 0.6, 0, 0), cutoff: OPEN, gainDb: -1, glide: 0.9 },
  countdown: { layers: L(0.9, 0.6, 0.5, 0, 0.85, 0), cutoff: 6000, gainDb: 0, glide: 0.25 },
  race: { layers: L(0.75, 1, 0.9, 1, 0.85, 0), cutoff: OPEN, gainDb: 0, glide: 0.3 },
  final: { layers: L(0.75, 1, 0.9, 1, 1, 0.9), cutoff: OPEN, gainDb: 0.5, glide: 0.5 },
  finished: { layers: L(1, 0.4, 0.6, 0, 0, 0), cutoff: 9000, gainDb: -2, glide: 1.2 },
};

/**
 * Target mix for `state`. Crash and pause keep the layers of the state before (`previous`) and only change
 * the filter and level: a crash sinks the music under a low-pass, a pause muffles it.
 */
export function musicMix(state: MusicState, previous: MusicState = 'chill'): MusicMix {
  if (state === 'crash' || state === 'paused') {
    const base = previous === 'crash' || previous === 'paused' ? MIXES.chill : MIXES[previous];
    return state === 'crash'
      ? { layers: { ...base.layers }, cutoff: 380, gainDb: -4, glide: 0.12 }
      : { layers: { ...base.layers }, cutoff: 650, gainDb: -9, glide: 0.2 };
  }
  return { ...MIXES[state], layers: { ...MIXES[state].layers } };
}

/**
 * Stateful wrapper: remembers the last "playing" state so crash / pause keep its layers, and reports a
 * change only when the state moves.
 */
export class MusicDirector {
  state: MusicState = 'menu';
  /** last state that was not crash / pause */
  base: MusicState = 'menu';

  /** Returns the new mix when the state changed, otherwise null. */
  update(i: MusicInputs): MusicMix | null {
    const next = musicState(i);
    if (next === this.state) return null;
    this.state = next;
    if (next !== 'crash' && next !== 'paused') this.base = next;
    return musicMix(next, this.base);
  }

  /** Mix of the current state (level change, music switched back on). */
  current(): MusicMix {
    return musicMix(this.state, this.base);
  }
}

export { STEMS };
