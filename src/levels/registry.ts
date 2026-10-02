/**
 * Playable levels and the last one the pilot chose. Paid upfront: every listed level is playable,
 * so there is no tier or lock here. DOM-free (storage injected).
 */
import type { LevelId } from '../types';
import { NIGHT_LOFT } from './night-loft';
import { createRuntime, type LevelRuntime } from './runtime';
import { TRAINING_LEVEL } from './training';

export type { LevelRuntime } from './runtime';

export interface LevelEntry {
  id: LevelId;
  name: string;
  kind: 'authored' | 'seeded';
  blurb: string;
  build(arg?: { seed?: number }): LevelRuntime;
}

/** Menu order: the beginner field first. */
export const LEVELS: readonly LevelEntry[] = [
  {
    id: 'training',
    name: TRAINING_LEVEL.name,
    kind: 'authored',
    blurb: 'Open meadow in daylight. Three big rings, room to learn.',
    build: () => createRuntime(TRAINING_LEVEL),
  },
  {
    id: 'night-loft',
    name: NIGHT_LOFT.name,
    kind: 'authored',
    blurb: 'Tight indoor course at night: twelve rings, beams and a ceiling fan.',
    build: () => createRuntime(NIGHT_LOFT),
  },
];

/** Level the game starts in until the pilot picks one: first-time pilots land on the beginner field. */
export const DEFAULT_LEVEL: LevelId = 'training';
export const LAST_LEVEL_KEY = 'drone-sim.level';

export function levelEntry(id: LevelId): LevelEntry | undefined {
  return LEVELS.find((l) => l.id === id);
}

export function isPlayableLevel(id: unknown): id is LevelId {
  return typeof id === 'string' && LEVELS.some((l) => l.id === id);
}

/** Throws for a level that is not in LEVELS (callers validate ids from storage / UI first). */
export function buildLevel(id: LevelId, seed?: number): LevelRuntime {
  const entry = levelEntry(id);
  if (!entry) throw new Error(`Unknown level: ${id}`);
  return entry.build(seed === undefined ? undefined : { seed });
}

export function loadLastLevel(storage: Storage | null): LevelId {
  try {
    const v = storage?.getItem(LAST_LEVEL_KEY);
    return isPlayableLevel(v) ? v : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

export function saveLastLevel(storage: Storage | null, id: LevelId): void {
  try {
    storage?.setItem(LAST_LEVEL_KEY, id);
  } catch {
    // quota / privacy mode: the choice just is not remembered
  }
}

/** Next playable level after `id` (wraps), for one-button cycling on the VR card. */
export function nextLevel(id: LevelId, dir: 1 | -1 = 1): LevelId {
  const i = LEVELS.findIndex((l) => l.id === id);
  const n = LEVELS.length;
  return LEVELS[(Math.max(0, i) + dir + n) % n]!.id;
}
