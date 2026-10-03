/**
 * What each level sounds like (pure data): continuous beds, positional loops, scattered one-shots, the
 * reverb space and how wind follows altitude. The ambience runtime (ambience.ts) builds the graph from it.
 */
import type { LevelId } from '../types';
import type { ReverbKind, NoiseColour } from './dsp';
import type { SfxId } from './sfx-bank';

export type BedId = 'wind' | 'grass' | 'room' | 'hvac' | 'city-far' | 'traffic' | 'countryside' | 'insects';

export interface BedDef {
  id: BedId;
  noise: NoiseColour;
  filter: BiquadFilterType;
  freq: number;
  q: number;
  gain: number;
  /** slow gust modulation depth 0..1 */
  gust?: number;
  /** extra hum oscillator (HVAC): frequency (Hz) */
  hum?: number;
  /** gain change per 100 m above ground (negative: fades with height, e.g. street traffic) */
  perHundred?: number;
}

export type EmitterKind = 'fan' | 'neon' | 'window' | 'tractor';

export interface EmitterDef {
  kind: EmitterKind;
  position: [number, number, number];
  gain: number;
  /** panner reference distance (m): smaller = only heard up close */
  ref: number;
  /** lite tier skips it */
  optional?: boolean;
}

export type EventNear = 'listener' | 'village' | 'street' | 'river';

export interface EventDef {
  sounds: readonly SfxId[];
  /** seconds between events [min, max] */
  every: [number, number];
  /** distance from the anchor [min, max] (m) and height above the listener / ground */
  distance: [number, number];
  height: [number, number];
  gain: number;
  near: EventNear;
  /** pitch spread ±(fraction) */
  pitch: number;
}

export interface AmbienceProfile {
  reverb: ReverbKind;
  /** wet level of the level reverb on the effects bus */
  reverbMix: number;
  beds: readonly BedDef[];
  emitters: readonly EmitterDef[];
  events: readonly EventDef[];
  /** wind bed gain at the ground, and added per 100 m of height above ground (up to 200 m) */
  wind: { base: number; perHundred: number };
  /** river rush from the world's water field */
  river: boolean;
  /** village one-shots near settlements */
  village: boolean;
  /** speed-driven air rush scale (indoors the drone flies slower and there is no wind) */
  rush: number;
}

const wind = (gain: number, gust = 0.5): BedDef => ({ id: 'wind', noise: 'pink', filter: 'lowpass', freq: 520, q: 0.6, gain, gust });

/** Night Loft: room tone, HVAC hum, the city through the windows, ceiling fan, neon buzz. */
const LOFT: AmbienceProfile = {
  reverb: 'loft',
  reverbMix: 0.32,
  beds: [
    { id: 'room', noise: 'brown', filter: 'lowpass', freq: 180, q: 0.5, gain: 0.16 },
    { id: 'hvac', noise: 'pink', filter: 'bandpass', freq: 420, q: 0.9, gain: 0.05, hum: 59.6 },
    { id: 'city-far', noise: 'brown', filter: 'lowpass', freq: 420, q: 0.7, gain: 0.07, gust: 0.3 },
  ],
  emitters: [
    { kind: 'fan', position: [3.5, 5.25, 1], gain: 0.45, ref: 1.2 },
    { kind: 'neon', position: [-11.9, 3.3, 0.6], gain: 0.05, ref: 0.6 },
    { kind: 'neon', position: [-11.9, 2.35, 5.2], gain: 0.035, ref: 0.5, optional: true },
    { kind: 'window', position: [-6, 3.9, -6.9], gain: 0.16, ref: 2 },
    { kind: 'window', position: [2.5, 3.9, -6.9], gain: 0.16, ref: 2, optional: true },
    { kind: 'window', position: [11.9, 3.2, 0], gain: 0.2, ref: 2, optional: true },
    { kind: 'window', position: [0, 3.2, 6.9], gain: 0.2, ref: 2 },
  ],
  events: [{ sounds: ['siren', 'horn-1', 'horn-2'], every: [14, 32], distance: [60, 160], height: [0, 0], gain: 0.22, near: 'listener', pitch: 0.05 }],
  wind: { base: 0, perHundred: 0 },
  river: false,
  village: false,
  rush: 0.35,
};

/** Training: wind in the grass, birds, a tractor working the far field. */
const TRAINING: AmbienceProfile = {
  reverb: 'open',
  reverbMix: 0.18,
  beds: [wind(0.16, 0.6), { id: 'grass', noise: 'white', filter: 'bandpass', freq: 3400, q: 0.6, gain: 0.05, gust: 0.8 }],
  emitters: [{ kind: 'tractor', position: [-170, 1.5, -260], gain: 0.5, ref: 20, optional: true }],
  events: [{ sounds: ['bird-1', 'bird-2', 'bird-3'], every: [2.5, 7], distance: [12, 45], height: [3, 12], gain: 0.4, near: 'listener', pitch: 0.12 }],
  wind: { base: 1, perHundred: 0.6 },
  river: true,
  village: false,
  rush: 1,
};

/** City at dusk: traffic bed, horns, the wind between the towers growing with height. */
const CITY: AmbienceProfile = {
  reverb: 'city',
  reverbMix: 0.3,
  beds: [
    { id: 'traffic', noise: 'brown', filter: 'lowpass', freq: 320, q: 0.6, gain: 0.22, perHundred: -0.45 },
    { id: 'city-far', noise: 'pink', filter: 'bandpass', freq: 1100, q: 0.5, gain: 0.05, gust: 0.3, perHundred: -0.3 },
    wind(0.05, 0.7),
  ],
  emitters: [],
  events: [
    { sounds: ['horn-1', 'horn-2'], every: [3, 9], distance: [20, 90], height: [0, 1], gain: 0.4, near: 'street', pitch: 0.08 },
    { sounds: ['siren'], every: [25, 60], distance: [150, 300], height: [0, 0], gain: 0.35, near: 'street', pitch: 0.04 },
  ],
  wind: { base: 0.6, perHundred: 1.6 },
  river: true,
  village: false,
  rush: 1,
};

/** Alpine: wind rising with altitude, river rush near water, cowbells by the villages, birds. */
const ALPINE: AmbienceProfile = {
  reverb: 'valley',
  reverbMix: 0.22,
  beds: [wind(0.14, 0.7)],
  emitters: [],
  events: [
    { sounds: ['bird-2', 'bird-3'], every: [5, 14], distance: [15, 50], height: [2, 15], gain: 0.3, near: 'listener', pitch: 0.1 },
    { sounds: ['cowbell-1', 'cowbell-2'], every: [1.2, 3.5], distance: [10, 70], height: [0, 1], gain: 0.4, near: 'village', pitch: 0.06 },
    { sounds: ['church-bell'], every: [40, 90], distance: [80, 200], height: [10, 20], gain: 0.35, near: 'village', pitch: 0.02 },
  ],
  wind: { base: 1, perHundred: 0.9 },
  river: true,
  village: true,
  rush: 1,
};

/** Infinite: a countryside bed, rivers, village sounds. */
const INFINITE: AmbienceProfile = {
  reverb: 'open',
  reverbMix: 0.18,
  beds: [wind(0.09, 0.5), { id: 'countryside', noise: 'pink', filter: 'bandpass', freq: 1800, q: 0.4, gain: 0.03, gust: 0.4 }, { id: 'insects', noise: 'white', filter: 'bandpass', freq: 6200, q: 4, gain: 0.012, gust: 0.9 }],
  emitters: [],
  events: [
    { sounds: ['bird-1', 'bird-2', 'bird-3'], every: [4, 10], distance: [12, 45], height: [3, 12], gain: 0.32, near: 'listener', pitch: 0.12 },
    { sounds: ['cowbell-1', 'cowbell-2'], every: [2, 5], distance: [10, 70], height: [0, 1], gain: 0.35, near: 'village', pitch: 0.06 },
    { sounds: ['church-bell'], every: [45, 100], distance: [60, 160], height: [10, 20], gain: 0.3, near: 'village', pitch: 0.02 },
  ],
  wind: { base: 1, perHundred: 0.7 },
  river: true,
  village: true,
  rush: 1,
};

const PROFILES: Readonly<Record<LevelId, AmbienceProfile>> = {
  tutorial: TRAINING,
  training: TRAINING,
  'night-loft': LOFT,
  city: CITY,
  alpine: ALPINE,
  infinite: INFINITE,
};

/** The level's ambience; the lite tier drops optional emitters and halves the one-shot rate. */
export function ambienceFor(level: LevelId, lite = false): AmbienceProfile {
  const p = PROFILES[level] ?? TRAINING;
  if (!lite) return p;
  return {
    ...p,
    emitters: p.emitters.filter((e) => !e.optional),
    events: p.events.map((e) => ({ ...e, every: [e.every[0] * 2, e.every[1] * 2] as [number, number] })),
  };
}

/** One-shot sounds a profile needs rendered. */
export function profileSounds(p: AmbienceProfile): SfxId[] {
  const out = new Set<SfxId>();
  for (const e of p.events) for (const s of e.sounds) out.add(s);
  for (const e of p.emitters) if (e.kind === 'tractor') out.add('tractor');
  return [...out];
}

/** Wind bed level at `agl` metres above ground for a profile (before the ambience slider). */
export function windAt(p: AmbienceProfile, agl: number): number {
  return p.wind.base + Math.min(2, Math.max(0, agl) / 100) * p.wind.perHundred;
}
