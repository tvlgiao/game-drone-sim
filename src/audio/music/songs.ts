/**
 * The soundtrack, written as data: one 8-bar adaptive loop per level, split in six stems that the director
 * layers by game state. Everything is original and rendered on the device (no recordings, no licences).
 *
 * Steps are 16th notes; a bar has 16, the loop 128. Chords change every two bars.
 */
import type { LevelId } from '../../types';

export type StemName = 'pad' | 'bass' | 'arp' | 'beat' | 'perc' | 'lead';
export const STEMS: readonly StemName[] = ['pad', 'bass', 'arp', 'beat', 'perc', 'lead'];

export const BARS = 8;
export const STEPS_PER_BAR = 16;
export const LOOP_STEPS = BARS * STEPS_PER_BAR;

export type DrumKind = 'kick' | 'snare' | 'clap' | 'hat' | 'openhat' | 'shaker' | 'tamb' | 'rim' | 'tom' | 'taiko' | 'ride';

export interface NoteEvent {
  /** start step (16ths from the loop start) */
  step: number;
  /** length in steps */
  len: number;
  midi: number;
  vel: number;
}

export interface DrumEvent {
  step: number;
  kind: DrumKind;
  vel: number;
}

/** Synth voices the renderer knows (music/instruments.ts). */
export type PadVoice = 'saw-pad' | 'warm-pad' | 'dark-pad' | 'string-pad' | 'air-pad';
export type BassVoice = 'pulse-bass' | 'pluck-bass' | 'roll-bass' | 'string-bass' | 'sub-bass';
export type ArpVoice = 'square-arp' | 'pluck-arp' | 'acid-arp' | 'spiccato' | 'bell';
export type LeadVoice = 'saw-lead' | 'whistle' | 'stab' | 'horn' | 'flute';
export type Kit = 'synthwave' | 'house' | 'techno' | 'taiko' | 'soft';

export interface Song {
  id: string;
  title: string;
  mood: string;
  bpm: number;
  /** four chords, two bars each: voicing for the pad (MIDI) */
  chords: readonly (readonly number[])[];
  /** bass root per chord (MIDI) */
  roots: readonly number[];
  voices: { pad: PadVoice; bass: BassVoice; arp: ArpVoice; lead: LeadVoice; kit: Kit };
  /** reverb send per stem 0..1 and the delay (in steps) the arp / lead echo at */
  space: { reverb: number; delaySteps: number; delayMix: number };
  /** per-stem events of the 8-bar loop */
  notes: Record<'pad' | 'bass' | 'arp' | 'lead', NoteEvent[]>;
  drums: Record<'beat' | 'perc', DrumEvent[]>;
}

// --- helpers -----------------------------------------------------------------------------------------------

/** Drum lane from 16-char bar strings ('x' full, 'o' soft, '-' ghost, '.' rest); `bars[i]` falls back to the last. */
export function lane(kind: DrumKind, bars: readonly string[]): DrumEvent[] {
  const out: DrumEvent[] = [];
  for (let b = 0; b < BARS; b++) {
    const pat = bars[Math.min(b, bars.length - 1)]!;
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const c = pat[s];
      const vel = c === 'x' ? 1 : c === 'o' ? 0.6 : c === '-' ? 0.3 : 0;
      if (vel > 0) out.push({ step: b * STEPS_PER_BAR + s, kind, vel });
    }
  }
  return out;
}

/** Seven bars of `a` and a fill bar. */
const fill = (a: string, f: string): string[] => [a, a, a, a, a, a, a, f];

/** Pad: one sustained chord per two bars. */
function padChords(chords: readonly (readonly number[])[], vel = 0.8): NoteEvent[] {
  const out: NoteEvent[] = [];
  chords.forEach((c, i) => {
    for (const m of c) out.push({ step: i * 32, len: 32, midi: m, vel });
  });
  return out;
}

/**
 * Bass line: `pattern` is a 16-char bar ('r' root, 'o' octave up, 'f' fifth, 's' seventh below the octave,
 * '.' rest); every hit lasts `len` steps.
 */
function bassLine(roots: readonly number[], pattern: string, len: number, accent = 1, alt?: string): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (let b = 0; b < BARS; b++) {
    const root = roots[b >> 1]!;
    const pat = alt && b % 2 === 1 ? alt : pattern;
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const c = pat[s];
      const off = c === 'r' ? 0 : c === 'o' ? 12 : c === 'f' ? 7 : c === 's' ? 10 : c === 'd' ? -5 : null;
      if (off === null) continue;
      out.push({ step: b * STEPS_PER_BAR + s, len, midi: root + off, vel: s === 0 ? accent : 0.75 });
    }
  }
  return out;
}

/**
 * Arpeggio over each chord's tones (+ `octave` semitones): `idx` indexes the chord tones, wrapping into
 * the next octave; one index per `every` steps; negative = rest.
 */
function arpeggio(chords: readonly (readonly number[])[], idx: readonly number[], every: number, len: number, octave = 12, vel = 0.8): NoteEvent[] {
  const out: NoteEvent[] = [];
  let k = 0;
  for (let step = 0; step < LOOP_STEPS; step += every, k++) {
    const c = chords[Math.floor(step / 32)]!;
    const i = idx[k % idx.length]!;
    if (i < 0) continue;
    const midi = c[i % c.length]! + 12 * Math.floor(i / c.length) + octave;
    out.push({ step, len, midi, vel: vel * (k % 4 === 0 ? 1 : 0.78) });
  }
  return out;
}

/** Melody from [step, len, midi] triples. */
const melody = (m: readonly (readonly [number, number, number])[], vel = 0.85): NoteEvent[] => m.map(([step, len, midi]) => ({ step, len, midi, vel }));

// --- the five themes ---------------------------------------------------------------------------------------

/** Night Loft — "Neon Loft": 100 BPM synthwave in A minor (i–VI–III–VII), gated snare, octave bass. */
const loftChords = [
  [57, 60, 64, 71],
  [53, 57, 60, 64],
  [55, 60, 64, 67],
  [55, 59, 62, 67],
];
const NEON_LOFT: Song = {
  id: 'neon-loft',
  title: 'Neon Loft',
  mood: 'synthwave night',
  bpm: 100,
  chords: loftChords,
  roots: [33, 29, 36, 31],
  voices: { pad: 'saw-pad', bass: 'pulse-bass', arp: 'square-arp', lead: 'saw-lead', kit: 'synthwave' },
  space: { reverb: 0.35, delaySteps: 3, delayMix: 0.32 },
  notes: {
    pad: padChords(loftChords, 0.7),
    bass: bassLine([33, 29, 36, 31], 'rorororororororo', 1.6, 1),
    arp: arpeggio(loftChords, [0, 1, 2, 3, 4, 3, 2, 1], 1, 0.9, 12, 0.7),
    lead: melody([
      [0, 6, 76], [6, 2, 74], [8, 4, 72], [12, 4, 71], [16, 8, 69], [24, 4, 72], [28, 4, 76],
      [32, 6, 77], [38, 2, 76], [40, 4, 72], [44, 4, 69], [48, 12, 72], [60, 4, 74],
      [64, 6, 76], [70, 2, 74], [72, 4, 72], [76, 4, 67], [80, 8, 72], [88, 4, 74], [92, 4, 76],
      [96, 8, 79], [104, 4, 76], [108, 4, 74], [112, 12, 71], [124, 4, 74],
    ]),
  },
  drums: {
    beat: [
      ...lane('kick', fill('x.......x.......', 'x.......x...x.x.')),
      ...lane('snare', fill('....x.......x...', '....x.......x-xx')),
      ...lane('hat', fill('x.o.x.o.x.o.x.o.', 'x.o.x.o.x.o.....')),
      ...lane('tom', fill('................', '............xo.o')),
    ],
    perc: [
      ...lane('shaker', ['-o-x-o-x-o-x-o-x']),
      ...lane('openhat', ['..............o.', '................']),
      ...lane('clap', ['....o.......o...']),
    ],
  },
};

/** Training — "Green Field": 124 BPM bright house-pop in G major (I–V–vi–IV), plucks and a whistle hook. */
const fieldChords = [
  [59, 62, 67, 71],
  [57, 62, 66, 69],
  [59, 64, 67, 71],
  [60, 64, 67, 72],
];
const GREEN_FIELD: Song = {
  id: 'green-field',
  title: 'Green Field',
  mood: 'upbeat',
  bpm: 124,
  chords: fieldChords,
  roots: [31, 38, 40, 36],
  voices: { pad: 'warm-pad', bass: 'pluck-bass', arp: 'pluck-arp', lead: 'whistle', kit: 'house' },
  space: { reverb: 0.25, delaySteps: 3, delayMix: 0.22 },
  notes: {
    pad: padChords(fieldChords, 0.55),
    bass: bassLine([31, 38, 40, 36], 'r..r..f.r.o.r.f.', 1.5, 1, 'r..r..f.r.o.f.o.'),
    arp: arpeggio(fieldChords, [0, 2, 1, 3, 2, 4, 3, 5], 2, 1.2, 12, 0.75),
    lead: melody([
      [0, 4, 71], [4, 4, 74], [8, 8, 79], [16, 4, 78], [20, 4, 76], [24, 8, 74],
      [32, 4, 74], [36, 4, 76], [40, 8, 78], [48, 4, 81], [52, 4, 78], [56, 8, 74],
      [64, 4, 76], [68, 4, 79], [72, 8, 83], [80, 4, 81], [84, 4, 79], [88, 8, 76],
      [96, 4, 76], [100, 4, 74], [104, 4, 72], [108, 4, 71], [112, 12, 72], [124, 4, 74],
    ]),
  },
  drums: {
    beat: [
      ...lane('kick', fill('x...x...x...x...', 'x...x...x...x.x.')),
      ...lane('clap', fill('....x.......x...', '....x.......x.xx')),
      ...lane('openhat', ['..x...x...x...x.']),
    ],
    perc: [
      ...lane('shaker', ['-o-o-o-o-o-o-o-o']),
      ...lane('tamb', ['....o.......o...']),
      ...lane('rim', ['...o......o.....', '...o..o.......o.']),
    ],
  },
};

/** City — "Dusk Grid": 125 BPM dark electronic in F minor (i–VI–iv–V), rolling 16th bass, metallic tops. */
const cityChords = [
  [53, 56, 60, 63],
  [49, 53, 56, 60],
  [46, 53, 58, 61],
  [48, 52, 55, 58],
];
const DUSK_GRID: Song = {
  id: 'dusk-grid',
  title: 'Dusk Grid',
  mood: 'dark electronic',
  bpm: 125,
  chords: cityChords,
  roots: [29, 25, 34, 24],
  voices: { pad: 'dark-pad', bass: 'roll-bass', arp: 'acid-arp', lead: 'stab', kit: 'techno' },
  space: { reverb: 0.3, delaySteps: 3, delayMix: 0.3 },
  notes: {
    pad: padChords(cityChords, 0.6),
    bass: bassLine([29, 25, 34, 24], '.rr.rrr.rro.rrr.', 0.9, 0.9, '.rr.rrr.rro.rso.'),
    arp: arpeggio(cityChords, [0, 2, 1, 2, 3, 2, 1, 2, 0, 2, 1, 2, 4, 3, 2, 1], 1, 0.7, 12, 0.65),
    lead: melody([
      [0, 2, 77], [3, 2, 77], [6, 2, 80], [10, 4, 75],
      [32, 2, 77], [35, 2, 77], [38, 2, 80], [42, 4, 84],
      [64, 2, 77], [67, 2, 77], [70, 2, 82], [74, 4, 80],
      [96, 2, 79], [99, 2, 79], [102, 2, 82], [106, 6, 76], [116, 4, 79], [120, 4, 84],
    ], 0.9),
  },
  drums: {
    beat: [
      ...lane('kick', fill('x...x...x...x...', 'x...x...x...xxxx')),
      ...lane('clap', ['....x.......x...']),
      ...lane('hat', ['..x...x...x...x.']),
    ],
    perc: [
      ...lane('ride', ['x-o-x-o-x-o-x-o-']),
      ...lane('rim', ['...x......x...o.', '...x..o...x.....']),
      ...lane('openhat', ['......o.......o.']),
    ],
  },
};

/** Alpine — "Summit": 75 BPM cinematic in D minor (i–VI–III–VII), taiko, string ostinato, horn theme. */
const alpineChords = [
  [50, 57, 62, 65],
  [46, 53, 58, 62],
  [45, 53, 57, 60],
  [48, 55, 60, 64],
];
const SUMMIT: Song = {
  id: 'summit',
  title: 'Summit',
  mood: 'cinematic',
  bpm: 75,
  chords: alpineChords,
  roots: [38, 34, 29, 36],
  voices: { pad: 'string-pad', bass: 'string-bass', arp: 'spiccato', lead: 'horn', kit: 'taiko' },
  space: { reverb: 0.55, delaySteps: 6, delayMix: 0.12 },
  notes: {
    pad: padChords(alpineChords, 0.75),
    bass: bassLine([38, 34, 29, 36], 'r.......r...o...', 7, 1),
    arp: arpeggio(alpineChords, [0, 1, 2, 1, 3, 1, 2, 1], 1, 0.8, 0, 0.6),
    lead: melody([
      [0, 8, 69], [8, 8, 74], [16, 12, 77], [28, 4, 76],
      [32, 8, 74], [40, 8, 70], [48, 16, 74],
      [64, 8, 72], [72, 8, 77], [80, 12, 81], [92, 4, 79],
      [96, 8, 77], [104, 8, 76], [112, 16, 72],
    ], 0.8),
  },
  drums: {
    beat: [
      ...lane('taiko', fill('x.........o.x...', 'x.....o.x.o.xooo')),
      ...lane('tom', fill('......o.......o.', '......o...o.o.oo')),
    ],
    perc: [
      ...lane('shaker', ['o-o-o-o-o-o-o-o-']),
      ...lane('rim', ['....o.......o...']),
    ],
  },
};

/** Infinite — "Open Country": 75 BPM ambient in E major (I–vi–IV–V), FM bells, soft pulse. */
const countryChords = [
  [52, 59, 63, 66],
  [49, 56, 59, 64],
  [45, 52, 56, 61],
  [47, 54, 58, 63],
];
const OPEN_COUNTRY: Song = {
  id: 'open-country',
  title: 'Open Country',
  mood: 'ambient',
  bpm: 75,
  chords: countryChords,
  roots: [28, 25, 33, 35],
  voices: { pad: 'air-pad', bass: 'sub-bass', arp: 'bell', lead: 'flute', kit: 'soft' },
  space: { reverb: 0.6, delaySteps: 6, delayMix: 0.35 },
  notes: {
    pad: padChords(countryChords, 0.65),
    bass: bassLine([28, 25, 33, 35], 'r...............', 14, 0.9),
    arp: arpeggio(countryChords, [0, -1, -1, 2, -1, -1, 4, -1, 3, -1, -1, 5, -1, 2, -1, -1], 1, 3, 12, 0.55),
    lead: melody([
      [4, 8, 76], [12, 4, 78], [16, 12, 80],
      [36, 8, 76], [44, 4, 73], [48, 12, 71],
      [68, 8, 73], [76, 4, 76], [80, 12, 78],
      [100, 8, 75], [108, 4, 78], [112, 14, 80],
    ], 0.7),
  },
  drums: {
    beat: [...lane('kick', ['o.......o.......']), ...lane('rim', ['........-.......', '........-.....-.'])],
    perc: [...lane('shaker', ['-.o.-.o.-.o.-.o.'])],
  },
};

export const SONGS: Readonly<Record<string, Song>> = {
  [NEON_LOFT.id]: NEON_LOFT,
  [GREEN_FIELD.id]: GREEN_FIELD,
  [DUSK_GRID.id]: DUSK_GRID,
  [SUMMIT.id]: SUMMIT,
  [OPEN_COUNTRY.id]: OPEN_COUNTRY,
};

/** The theme each level plays (the tutorial flies the Training field). */
export const LEVEL_SONG: Readonly<Record<LevelId, string>> = {
  tutorial: GREEN_FIELD.id,
  training: GREEN_FIELD.id,
  'night-loft': NEON_LOFT.id,
  city: DUSK_GRID.id,
  alpine: SUMMIT.id,
  infinite: OPEN_COUNTRY.id,
};

export function songFor(level: LevelId): Song {
  return SONGS[LEVEL_SONG[level]] ?? GREEN_FIELD;
}

/** Seconds per 16th step. */
export function stepSeconds(bpm: number): number {
  return 60 / bpm / 4;
}

/** Loop length in samples at `sampleRate`: whole bars, each rounded to a sample, so stems stay locked. */
export function loopSamples(song: Song, sampleRate: number): number {
  return BARS * Math.round(stepSeconds(song.bpm) * STEPS_PER_BAR * sampleRate);
}

export function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
