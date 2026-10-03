import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { GameAudio, audioTier, type AudioSettings } from '../../src/audio/audio';
import { ambienceFor, profileSounds, windAt } from '../../src/audio/ambience-profiles';
import { gust } from '../../src/audio/ambience';
import { foldTail, impulseResponse, noise, normalizeGain, rms } from '../../src/audio/dsp';
import { Scope, ceilingCurve } from '../../src/audio/graph';
import {
  BUSES,
  BUS_TRIM,
  MAX_RPM,
  airCutoff,
  bladePassHz,
  busGains,
  crashDuckDb,
  dopplerFactor,
  duckGain,
  effectiveGain,
  escWhineHz,
  masterGain,
  motorDuckDb,
  motorRpm,
  shaftHz,
  sliderGain,
  windRush,
} from '../../src/audio/mix';
import { MotorSound, propSpectrum } from '../../src/audio/motor';
import { MIXES, MusicDirector, finalStretch, musicMix, musicState, type MusicInputs } from '../../src/audio/music/director';
import { spaceLevel } from '../../src/audio/music/player';
import { BARS, LEVEL_SONG, SONGS, STEMS, STEPS_PER_BAR, lane, loopSamples, mtof, songFor } from '../../src/audio/music/songs';
import { CORE_SFX } from '../../src/audio/sfx-bank';
import { VoicePool } from '../../src/audio/sfx';
import { surfaceOf } from '../../src/audio/surface';
import { DEFAULT_SETTINGS, loadSettings, migrateAmbience, SETTINGS_KEY, validateSettings } from '../../src/core/settings';
import type { LevelId, RaceStatus } from '../../src/types';
import { FakeContext, fakeOffline, type FakeNode } from './fixtures/fake-audio';

const SOUND: AudioSettings = { volume: 0.7, musicOn: true, musicVolume: 0.7, sfxVolume: 0.9, ambienceVolume: 0.8, analogVideo: false, analogStrength: 0.35 };
const LEVELS: LevelId[] = ['training', 'night-loft', 'city', 'alpine', 'infinite'];

function mem(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

const flush = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** An engine on a fake context with instant offline renders. */
async function engine(level: LevelId = 'training', s: AudioSettings = SOUND, lite = false): Promise<{ a: GameAudio; ctx: FakeContext }> {
  const ctx = new FakeContext();
  let seed = 7;
  const a = new GameAudio({ createContext: () => ctx as unknown as BaseAudioContext, offline: fakeOffline, random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) });
  a.configure({ tier: lite ? 'low' : 'high', form: 'desktop' });
  a.applySettings(s);
  a.setLevel({ def: { id: level }, terrain: null });
  await a.resume();
  await flush();
  return { a, ctx };
}

const EYE = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.7, 10, 1] } };
function drone(motors: number[], armed = true, v = new Vector3(), p = new Vector3(0, 2, 0), batteryVoltage = 16.4) {
  return { position: p, velocity: v, motors: motors as [number, number, number, number], armed, batteryVoltage };
}
const race = (status: RaceStatus, nextRing = 0, totalRings = 12, time = 0, bestTime: number | null = null) => ({ status, nextRing, totalRings, time, bestTime });

// ---------------------------------------------------------------------------------------------------------------

describe('mix math', () => {
  it('slider curve: 0 is silence, 1 is unity, 50 % is −12 dB', () => {
    expect(sliderGain(0)).toBe(0);
    expect(sliderGain(1)).toBe(1);
    expect(20 * Math.log10(sliderGain(0.5))).toBeCloseTo(-12.04, 1);
    expect(sliderGain(-3)).toBe(0);
    expect(sliderGain(7)).toBe(1);
    expect(sliderGain(Number.NaN)).toBe(0);
  });

  it('bus gains = trim × slider; music off silences only music; ui / voice follow the effects slider', () => {
    const s = { master: 1, music: 0.5, musicOn: true, sfx: 0.8, ambience: 0.3 };
    const g = busGains(s);
    expect(g.music).toBeCloseTo(BUS_TRIM.music * 0.25);
    expect(g.sfx).toBeCloseTo(BUS_TRIM.sfx * 0.64);
    expect(g.ambience).toBeCloseTo(BUS_TRIM.ambience * 0.09);
    expect(g.ui).toBeCloseTo(BUS_TRIM.ui * 0.64);
    expect(g.voice).toBeCloseTo(BUS_TRIM.voice * 0.64);
    const off = busGains({ ...s, musicOn: false });
    expect(off.music).toBe(0);
    expect(off.sfx).toBe(g.sfx);
    expect(effectiveGain({ ...s, master: 0.5 }, 'sfx')).toBeCloseTo(0.25 * g.sfx);
    expect(masterGain({ ...s, master: 0 })).toBe(0);
  });

  it('ducks: motor duck grows with RPM (deeper in FPV), crash duck releases, the sum is floored', () => {
    expect(motorDuckDb(0.4, true)).toBeCloseTo(0);
    expect(motorDuckDb(1, true)).toBeCloseTo(-5);
    expect(motorDuckDb(1, false)).toBeCloseTo(-3);
    expect(motorDuckDb(0.8, true)).toBeLessThan(0);
    expect(crashDuckDb(0)).toBeCloseTo(-9);
    expect(crashDuckDb(1.1)).toBeGreaterThan(-9);
    expect(crashDuckDb(1.1)).toBeLessThan(0);
    expect(crashDuckDb(5)).toBe(0);
    expect(crashDuckDb(-Infinity)).toBe(0);
    expect(duckGain(-12, -12)).toBeCloseTo(Math.pow(10, -18 / 20));
    expect(duckGain()).toBe(1);
  });

  it('wind rush is silent at a hover and full at 30 m/s; air absorption darkens with distance', () => {
    expect(windRush(2)).toBe(0);
    expect(windRush(30)).toBe(1);
    expect(windRush(16)).toBeGreaterThan(0.2);
    expect(airCutoff(0)).toBe(20000);
    expect(airCutoff(300)).toBeLessThan(airCutoff(30));
    expect(airCutoff(1e6)).toBe(1800);
  });
});

describe('motor: RPM → frequency', () => {
  it('blade-pass = RPM / 60 × 3 blades; whine = 7 pole pairs × shaft rate', () => {
    expect(motorRpm(1)).toBe(MAX_RPM);
    expect(motorRpm(0.5)).toBe(MAX_RPM / 2);
    expect(motorRpm(2)).toBe(MAX_RPM);
    expect(shaftHz(30000)).toBe(500);
    expect(bladePassHz(30000)).toBe(1500);
    expect(bladePassHz(30000, 2)).toBe(1000);
    expect(escWhineHz(30000)).toBe(3500);
    // per-motor trim: the four tones differ so they beat
    expect(new Set([0, 1, 2, 3].map((i) => motorRpm(0.5, i))).size).toBe(4);
  });

  it('the prop voice is strongest on the blade-pass family', () => {
    const a = propSpectrum(24);
    expect(a[3]).toBeGreaterThan(a[1]! * 3);
    expect(a[6]).toBeGreaterThan(a[5]! * 3);
    expect(a[9]).toBeGreaterThan(a[10]! * 3);
    expect(a[0]).toBe(0);
  });

  it('Doppler: approaching raises, receding lowers, clamped to an octave', () => {
    expect(dopplerFactor(0)).toBe(1);
    expect(dopplerFactor(30)).toBeCloseTo(343 / 313, 5);
    expect(dopplerFactor(-30)).toBeCloseTo(343 / 373, 5);
    expect(dopplerFactor(1e6)).toBeLessThanOrEqual(2);
    expect(dopplerFactor(-1e6)).toBeGreaterThanOrEqual(0.5);
  });

  it('drives each oscillator at its shaft rate; idle sings, a stopped prop is silent; punch is detected', () => {
    const ctx = new FakeContext();
    const scope = new Scope(ctx as unknown as BaseAudioContext, { created: 0, released: 0 });
    const out = ctx.createGain();
    const noiseBuf = ctx.createBuffer(1, 4800, 48000);
    const m = new MotorSound(scope, out as unknown as AudioNode, out as unknown as AudioNode, noiseBuf as unknown as AudioBuffer, true, () => 0.99);
    const frame = { motors: [0.5, 0.5, 0.5, 0.5], armed: true, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, lx: 0, ly: 0, lz: 0, fpv: true, dt: 1 / 60 };
    m.update(frame);
    const oscs = ctx.nodes.filter((n) => n.kind === 'osc') as unknown as { frequency: { value: number } }[];
    // first four voices: [prop, whine] pairs in construction order
    expect(oscs[0]!.frequency.value).toBeCloseTo(shaftHz(motorRpm(0.5, 0)), 5);
    expect(oscs[1]!.frequency.value).toBeCloseTo(escWhineHz(motorRpm(0.5, 0)), 5);
    expect(oscs[2]!.frequency.value).toBeCloseTo(shaftHz(motorRpm(0.5, 1)), 5);
    expect(m.last.bladePass[0]).toBeCloseTo(bladePassHz(MAX_RPM * 0.5), 5);
    expect(m.last.gains.every((g) => g > 0)).toBe(true);
    m.update({ ...frame, motors: [0, 0, 0, 0], armed: false });
    expect(m.last.gains).toEqual([0, 0, 0, 0]);
    expect(m.last.wash).toBe(0);
    m.update({ ...frame, motors: [0.055, 0.055, 0.055, 0.055] });
    expect(m.last.gains.every((g) => g > 0)).toBe(true);
    m.update({ ...frame, motors: [0.95, 0.95, 0.95, 0.95] });
    expect(m.last.punch).toBeGreaterThan(0.5);
  });

  it('external path: Doppler and distance from the listener; FPV path ignores both', () => {
    const ctx = new FakeContext();
    const scope = new Scope(ctx as unknown as BaseAudioContext, { created: 0, released: 0 });
    const out = ctx.createGain();
    const m = new MotorSound(scope, out as unknown as AudioNode, out as unknown as AudioNode, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer, false);
    const f = { motors: [0.6, 0.6, 0.6, 0.6], armed: true, px: -50, py: 2, pz: 0, vx: 40, vy: 0, vz: 0, lx: 0, ly: 2, lz: 0, fpv: false, dt: 0.5 };
    for (let i = 0; i < 10; i++) m.update(f);
    expect(m.last.doppler).toBeGreaterThan(1.05);
    expect(m.last.distance).toBeCloseTo(50, 5);
    for (let i = 0; i < 10; i++) m.update({ ...f, vx: -40 });
    expect(m.last.doppler).toBeLessThan(0.95);
    for (let i = 0; i < 10; i++) m.update({ ...f, fpv: true });
    expect(m.last.doppler).toBeCloseTo(1, 2);
  });
});

describe('engine: buses and routing', () => {
  it('motor → sfx bus → master → glue → limiter → ceiling → output; slider changes move the bus gains', async () => {
    const { a, ctx } = await engine();
    const motorOsc = ctx.nodes.find((n) => n.kind === 'osc')!;
    const path = ctx.path(motorOsc);
    expect(path[0]).toBe('osc');
    expect(path.slice(-4)).toEqual(['compressor', 'compressor', 'shaper', 'destination']);
    const d0 = a.debug();
    expect(d0.target.buses).toEqual(busGains({ master: 0.7, music: 0.7, musicOn: true, sfx: 0.9, ambience: 0.8 }));
    for (const b of BUSES) expect(d0.buses[b]).toBeCloseTo(d0.target.buses[b]);
    expect(d0.master).toBeCloseTo(masterGain({ master: 0.7, music: 0, musicOn: true, sfx: 0, ambience: 0 }));
    a.applySettings({ ...SOUND, musicVolume: 0.2, sfxVolume: 0.5, ambienceVolume: 0, volume: 1 });
    const d1 = a.debug();
    expect(d1.buses.music).toBeCloseTo(BUS_TRIM.music * 0.04);
    expect(d1.buses.sfx).toBeCloseTo(BUS_TRIM.sfx * 0.25);
    expect(d1.buses.ambience).toBe(0);
    expect(d1.master).toBe(1);
    a.applySettings({ ...SOUND, musicOn: false });
    expect(a.debug().buses.music).toBe(0);
    expect(a.debug().music.playing).toBe(false);
  });

  it('each bus reaches the output exactly through the master', async () => {
    const { ctx } = await engine();
    const live = ctx.liveGraph();
    const gains = ctx.nodes.filter((n) => n.kind === 'gain' && live.has(n));
    // the master is the one gain feeding the glue compressor
    const master = gains.find((g) => [...g.outputs].some((o) => (o as FakeNode).kind === 'compressor'))!;
    const intoMaster = gains.filter((g) => g.outputs.has(master));
    expect(intoMaster.length).toBe(BUSES.length);
  });

  it('legacy setters still work: master volume and the old wind slider (now ambience)', async () => {
    const { a } = await engine();
    a.setVolume(0.5);
    expect(a.debug().master).toBeCloseTo(0.25);
    a.setWindVolume(0.5);
    expect(a.debug().buses.ambience).toBeCloseTo(BUS_TRIM.ambience * 0.25);
  });

  it('music ducks under a loud motor in FPV and on a crash; pause muffles it', async () => {
    const { a } = await engine();
    a.frame(drone([0.3, 0.3, 0.3, 0.3]), race('freefly'), 'fpv', EYE);
    const quiet = a.debug().music.duck;
    expect(quiet).toBeCloseTo(1, 2);
    const ctx = (a as unknown as { ctx: FakeContext }).ctx;
    ctx.currentTime += 0.1;
    a.frame(drone([1, 1, 1, 1]), race('freefly'), 'fpv', EYE);
    expect(a.debug().music.duck).toBeLessThan(0.6);
    ctx.currentTime += 0.1;
    a.handleEvent({ type: 'crash', position: new Vector3(), speed: 8 });
    ctx.currentTime += 0.05;
    a.frame(drone([0, 0, 0, 0], false), race('crashed'), 'fpv', EYE);
    expect(a.debug().music.duck).toBeLessThan(0.4);
    expect(a.debug().music.state).toBe('crash');
    ctx.currentTime += 0.1;
    a.frame(drone([0, 0, 0, 0], false), race('paused'), 'fpv', EYE);
    expect(a.debug().music.state).toBe('paused');
  });

  it('countdown(n) beeps once per number; GO for 0; race events use the same path', async () => {
    const { a, ctx } = await engine();
    const before = a.debug().created;
    a.countdown(3);
    a.countdown(3);
    expect(a.debug().created - before).toBe(1);
    a.handleEvent({ type: 'countdown', value: 3 });
    expect(a.debug().created - before).toBe(1);
    a.handleEvent({ type: 'countdown', value: 2 });
    a.handleEvent({ type: 'race-start' });
    expect(a.debug().created - before).toBe(3);
    ctx.endSources();
  });

  it('low battery: an FC-style warning after a second below 3.55 V/cell, never while disarmed', async () => {
    // the loft: no one-shot ambience in the first seconds to muddle the count
    const { a, ctx } = await engine('night-loft');
    const start = a.debug().created;
    for (let i = 0; i < 30; i++) {
      ctx.currentTime += 0.05;
      a.frame(drone([0.5, 0.5, 0.5, 0.5], false, undefined, undefined, 13.6), race('freefly'), 'fpv', EYE);
    }
    expect(a.debug().created).toBe(start);
    for (let i = 0; i < 30; i++) {
      ctx.currentTime += 0.05;
      a.frame(drone([0.5, 0.5, 0.5, 0.5], true, undefined, undefined, 13.6), race('freefly'), 'fpv', EYE);
    }
    expect(a.debug().created).toBe(start + 1);
  });

  it('suspend / resume follow the context; nothing plays before the first gesture', async () => {
    const a = new GameAudio({ createContext: () => new FakeContext() as unknown as BaseAudioContext, offline: null });
    expect(a.state).toBe('none');
    a.handleEvent({ type: 'race-start' });
    a.frame(drone([0.5, 0.5, 0.5, 0.5]), race('freefly'), 'fpv', EYE);
    await a.resume();
    expect(a.state).toBe('running');
    await a.suspend();
    expect(a.state).toBe('suspended');
    await a.resume();
    expect(a.state).toBe('running');
    a.dispose();
  });

  it('engine tier: lite on phones and medium / low quality; HRTF on desktop and Quest only', () => {
    expect(audioTier('high', 'desktop')).toEqual({ lite: false, hrtf: true });
    expect(audioTier('medium', 'desktop')).toEqual({ lite: true, hrtf: true });
    expect(audioTier('ultra', 'phone')).toEqual({ lite: true, hrtf: false });
    expect(audioTier('high', 'tablet')).toEqual({ lite: false, hrtf: false });
  });
});

describe('no node leaks', () => {
  it('50 level switches: live nodes and the connected graph return to the same size', { timeout: 120_000 }, async () => {
    // lite tier: smaller stems keep the instant "renders" quick
    const { a, ctx } = await engine('training', SOUND, true);
    const settle = async (): Promise<void> => {
      await flush();
      ctx.currentTime += 5;
      a.frame(drone([0.5, 0.5, 0.5, 0.5]), race('freefly'), 'chase', EYE);
      a.flush();
      ctx.endSources();
    };
    await settle();
    const sizes: number[] = [];
    const graphs: number[] = [];
    for (let i = 0; i < 50; i++) {
      a.setLevel({ def: { id: LEVELS[i % LEVELS.length]! }, terrain: null });
      for (let k = 0; k < 4; k++) a.handleEvent({ type: 'ring-passed', index: k, position: new Vector3() });
      a.handleEvent({ type: 'collision', contact: { normal: new Vector3(), depth: 0, point: new Vector3(), impactSpeed: 2, colliderId: 'wall-north' } });
      await settle();
      if (i % LEVELS.length === LEVELS.length - 1) {
        sizes.push(a.debug().nodes);
        graphs.push(ctx.liveGraph().size);
      }
    }
    // the same level (infinite) at the end of every round: identical counts every time
    expect(new Set(sizes).size).toBe(1);
    expect(new Set(graphs).size).toBe(1);
    const d = a.debug();
    expect(d.created - d.released).toBe(d.nodes);
    expect(d.music.song).toBe(LEVEL_SONG.infinite);
  });

  it('voice pool: one-shots release their source when they end; a busy pool steals the oldest', () => {
    const ctx = new FakeContext();
    const stats = { created: 0, released: 0 };
    const scope = new Scope(ctx as unknown as BaseAudioContext, stats);
    const out = ctx.createGain();
    const pool = new VoicePool(scope, out as unknown as AudioNode, 3, 'equalpower');
    const base = stats.created;
    const buf = ctx.createBuffer(1, 100, 48000) as unknown as AudioBuffer;
    for (let i = 0; i < 5; i++) pool.play(buf, 1, 1, 0, 0, 0, 0);
    expect(stats.created - base).toBe(5);
    expect(stats.released).toBe(2);
    expect(pool.busy).toBe(3);
    ctx.endSources();
    expect(pool.busy).toBe(0);
    expect(stats.created - base - stats.released).toBe(0);
  });
});

describe('adaptive music', () => {
  const inp = (status: RaceStatus, extra: Partial<MusicInputs> = {}): MusicInputs => ({ status, nextRing: 0, totalRings: 12, time: 0, bestTime: null, ...extra });

  it('state per game status', () => {
    expect(musicState(inp('menu'))).toBe('menu');
    expect(musicState(inp('freefly'))).toBe('chill');
    expect(musicState(inp('countdown'))).toBe('countdown');
    expect(musicState(inp('racing'))).toBe('race');
    expect(musicState(inp('crashed'))).toBe('crash');
    expect(musicState(inp('paused'))).toBe('paused');
    expect(musicState(inp('finished'))).toBe('finished');
  });

  it('final stretch: last quarter of the rings, or the clock at 80 % of the best', () => {
    expect(finalStretch({ nextRing: 8, totalRings: 12, time: 0, bestTime: null })).toBe(false);
    expect(finalStretch({ nextRing: 9, totalRings: 12, time: 0, bestTime: null })).toBe(true);
    expect(finalStretch({ nextRing: 1, totalRings: 12, time: 23, bestTime: 30 })).toBe(false);
    expect(finalStretch({ nextRing: 1, totalRings: 12, time: 24, bestTime: 30 })).toBe(true);
    expect(musicState(inp('racing', { nextRing: 10 }))).toBe('final');
  });

  it('layers: menu calm, chill without tops, race adds drums and tops, final adds the lead', () => {
    expect(MIXES.menu.layers.beat).toBe(0);
    expect(MIXES.chill.layers.beat).toBeGreaterThan(0);
    expect(MIXES.chill.layers.lead).toBe(0);
    expect(MIXES.race.layers.beat).toBe(1);
    expect(MIXES.race.layers.perc).toBeGreaterThan(MIXES.chill.layers.perc);
    expect(MIXES.final.layers.lead).toBeGreaterThan(0.5);
    for (const m of Object.values(MIXES)) for (const s of STEMS) expect(m.layers[s]).toBeGreaterThanOrEqual(0);
  });

  it('crash and pause keep the layers of the state before and only filter / lower it', () => {
    const d = new MusicDirector();
    expect(d.update(inp('racing'))?.layers.beat).toBe(1);
    const crash = d.update(inp('crashed'))!;
    expect(crash.layers).toEqual(MIXES.race.layers);
    expect(crash.cutoff).toBeLessThan(500);
    expect(d.update(inp('crashed'))).toBeNull();
    const pause = d.update(inp('paused'))!;
    expect(pause.layers).toEqual(MIXES.race.layers);
    expect(pause.cutoff).toBeLessThan(1000);
    expect(pause.gainDb).toBeLessThan(-6);
    expect(d.update(inp('racing'))?.cutoff).toBeGreaterThan(10000);
    expect(musicMix('paused', 'menu').layers).toEqual(MIXES.menu.layers);
  });

  it('every level has its own theme; songs are 8 bars with 4 chords and stay in range', () => {
    const ids = new Set((['training', 'night-loft', 'city', 'alpine', 'infinite'] as LevelId[]).map((l) => songFor(l).id));
    expect(ids.size).toBe(5);
    expect(songFor('tutorial').id).toBe(songFor('training').id);
    for (const s of Object.values(SONGS)) {
      expect(s.chords.length).toBe(4);
      for (const k of ['pad', 'bass', 'arp', 'lead'] as const)
        for (const n of s.notes[k]) {
          expect(n.step).toBeGreaterThanOrEqual(0);
          expect(n.step).toBeLessThan(BARS * STEPS_PER_BAR);
          expect(mtof(n.midi)).toBeGreaterThan(30);
          expect(mtof(n.midi)).toBeLessThan(4200);
        }
      expect(s.drums.beat.length).toBeGreaterThan(0);
      // loops are whole bars at any rate: stems stay in phase
      expect(loopSamples(s, 48000) % BARS).toBe(0);
      expect(loopSamples(s, 24000) % BARS).toBe(0);
    }
  });

  it('drum lanes parse x / o / - / . and fall back to the last bar', () => {
    const l = lane('kick', ['x...o...-.......']);
    expect(l.length).toBe(3 * BARS);
    expect(l.slice(0, 3).map((e) => [e.step, e.vel])).toEqual([[0, 1], [4, 0.6], [8, 0.3]]);
  });

  it('the hall follows the layers that feed it', () => {
    const s = SONGS['neon-loft']!;
    const none = { pad: 0, bass: 0, arp: 0, beat: 0, perc: 0, lead: 0 };
    expect(spaceLevel(s, none)).toBe(0);
    expect(spaceLevel(s, { pad: 1, bass: 1, arp: 1, beat: 1, perc: 1, lead: 1 })).toBeCloseTo(1);
    expect(spaceLevel(s, { ...none, pad: 1 })).toBeGreaterThan(spaceLevel(s, { ...none, bass: 1 }));
  });
});

describe('ambience per level', () => {
  it('Night Loft: room tone, HVAC hum, city through the windows, fan and neon emitters, a room reverb', () => {
    const p = ambienceFor('night-loft');
    expect(p.reverb).toBe('loft');
    expect(p.beds.map((b) => b.id)).toEqual(expect.arrayContaining(['room', 'hvac', 'city-far']));
    expect(p.beds.find((b) => b.id === 'hvac')!.hum).toBeGreaterThan(0);
    expect(p.emitters.filter((e) => e.kind === 'fan')).toHaveLength(1);
    expect(p.emitters.filter((e) => e.kind === 'neon').length).toBeGreaterThanOrEqual(1);
    expect(p.emitters.filter((e) => e.kind === 'window').length).toBeGreaterThanOrEqual(2);
    expect(p.river).toBe(false);
  });

  it('Training: wind in the grass, birds, a distant tractor', () => {
    const p = ambienceFor('training');
    expect(p.beds.map((b) => b.id)).toEqual(['wind', 'grass']);
    expect(p.events[0]!.sounds.every((s) => s.startsWith('bird'))).toBe(true);
    expect(p.emitters.map((e) => e.kind)).toEqual(['tractor']);
    expect(ambienceFor('tutorial')).toBe(p);
  });

  it('City: traffic bed fading with height, horns at street level, wind growing with height, canyon slapback', () => {
    const p = ambienceFor('city');
    expect(p.reverb).toBe('city');
    expect(p.beds.find((b) => b.id === 'traffic')!.perHundred).toBeLessThan(0);
    expect(p.events.some((e) => e.near === 'street' && e.sounds.includes('horn-1'))).toBe(true);
    expect(windAt(p, 150)).toBeGreaterThan(windAt(p, 0) * 2);
  });

  it('Alpine and Infinite: river from the water field, village sounds near villages, wind rising with altitude', () => {
    for (const id of ['alpine', 'infinite'] as const) {
      const p = ambienceFor(id);
      expect(p.river).toBe(true);
      expect(p.village).toBe(true);
      expect(p.events.some((e) => e.near === 'village' && e.sounds.some((s) => s.startsWith('cowbell')))).toBe(true);
      expect(windAt(p, 200)).toBeGreaterThan(windAt(p, 0));
    }
    expect(ambienceFor('alpine').reverb).toBe('valley');
  });

  it('the lite tier drops optional emitters and halves the one-shot rate', () => {
    const full = ambienceFor('night-loft');
    const lite = ambienceFor('night-loft', true);
    expect(lite.emitters.length).toBeLessThan(full.emitters.length);
    expect(lite.events[0]!.every[0]).toBe(full.events[0]!.every[0] * 2);
    expect(profileSounds(ambienceFor('training'))).toEqual(expect.arrayContaining(['bird-1', 'tractor']));
    expect(profileSounds(full)).not.toContain('tractor');
  });

  it('gust stays in a sane range and moves', () => {
    const v = Array.from({ length: 200 }, (_, i) => gust(i * 0.5));
    expect(Math.min(...v)).toBeGreaterThanOrEqual(-0.1);
    expect(Math.max(...v)).toBeLessThanOrEqual(1.1);
    expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(0.5);
  });

  it('every level builds its ambience on the engine (beds and emitters connected)', async () => {
    for (const id of LEVELS) {
      const { a, ctx } = await engine(id);
      expect(a.debug().ambience).not.toBeNull();
      expect(ctx.liveGraph().size).toBeGreaterThan(60);
      a.dispose();
    }
  });
});

describe('impacts', () => {
  it('collider ids map to surfaces; ground uses what the world says is there', () => {
    expect(surfaceOf('ring-3', 'city')).toBe('metal');
    expect(surfaceOf('car-12', 'city')).toBe('metal');
    expect(surfaceOf('bld-4', 'city')).toBe('concrete');
    expect(surfaceOf('bld-4-ac2', 'city')).toBe('metal');
    expect(surfaceOf('tree:3,4:1', 'alpine')).toBe('wood');
    expect(surfaceOf('house:1,2:0', 'infinite')).toBe('concrete');
    expect(surfaceOf('fan', 'night-loft')).toBe('metal');
    expect(surfaceOf('wall-north', 'night-loft')).toBe('concrete');
    expect(surfaceOf('floor', 'night-loft')).toBe('concrete');
    expect(surfaceOf('ceiling', 'night-loft')).toBe('wood');
    expect(surfaceOf('terrain', 'alpine', 'water')).toBe('water');
    expect(surfaceOf('ground', 'training')).toBe('soft');
  });

  it('the effects bank covers every flight sound', () => {
    for (const id of ['crash-concrete', 'crash-wood', 'crash-metal', 'crash-grass', 'crash-water', 'chime', 'stinger-best', 'beep', 'go', 'arm', 'disarm', 'batt-low', 'oob', 'ui-hover', 'ui-select', 'ui-back'] as const) expect(CORE_SFX).toContain(id);
  });
});

describe('dsp', () => {
  it('folding the tail makes the loop seamless (the tail lands on the start)', () => {
    const d = new Float32Array([1, 2, 3, 4, 10, 20]);
    expect([...foldTail(d, 4)]).toEqual([11, 22, 3, 4]);
    const wrap = new Float32Array([0, 0, 1, 2, 3]);
    expect([...foldTail(wrap, 2)]).toEqual([4, 2]);
  });

  it('impulse responses have unit energy, so a send of 1 returns about the dry level', () => {
    for (const k of ['loft', 'city', 'open', 'valley', 'hall'] as const) {
      const [l, r] = impulseResponse(k, 24000);
      let e = 0;
      for (const d of [l, r]) for (const v of d) e += v * v;
      expect(e / 2).toBeCloseTo(1, 3);
    }
    expect(impulseResponse('loft', 24000, 0.5)[0].length).toBeLessThan(impulseResponse('loft', 24000)[0].length);
  });

  it('noise loops without a seam and is deterministic per seed', () => {
    const a = noise(48000, 'pink', 3);
    expect([...noise(48000, 'pink', 3).subarray(0, 50)]).toEqual([...a.subarray(0, 50)]);
    // the jump across the loop point is no bigger than a normal sample step
    const seam = Math.abs(a[0]! - a[a.length - 1]!);
    let typical = 0;
    for (let i = 1; i < a.length; i++) typical += Math.abs(a[i]! - a[i - 1]!);
    expect(seam).toBeLessThan((typical / a.length) * 6);
    expect(rms(a)).toBeGreaterThan(0.01);
  });

  it('normalise to a target RMS, but never past the peak ceiling', () => {
    const d = new Float32Array(1000).fill(0.01);
    expect(normalizeGain([d], -20)).toBeCloseTo(10, 3);
    const spike = new Float32Array(1000);
    spike[0] = 0.5;
    expect(normalizeGain([spike], -20, -6) * 0.5).toBeCloseTo(Math.pow(10, -6 / 20), 5);
    expect(normalizeGain([new Float32Array(10)], -20)).toBe(1);
  });

  it('output ceiling: unity below the knee, never past full scale', () => {
    const c = ceilingCurve(0.8, 2001);
    expect(c[1000]).toBeCloseTo(0, 6);
    expect(c[1500]).toBeCloseTo(0.5, 2);
    expect(c[2000]).toBeLessThan(1);
    expect(c[2000]).toBeGreaterThan(0.9);
    expect(c[0]).toBeCloseTo(-c[2000]!, 6);
  });
});

describe('settings: sound', () => {
  it('defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ volume: 0.7, musicOn: true, musicVolume: 0.7, sfxVolume: 0.9, ambienceVolume: 0.8 });
  });

  it('migrates the old wind slider into ambience only when the pilot had changed it', () => {
    expect(migrateAmbience({ windVolume: 0.3 })).toBe(0.3);
    expect(migrateAmbience({ windVolume: 0.6 })).toBeUndefined();
    expect(migrateAmbience({ windVolume: 0.3, ambienceVolume: 0.9 })).toBe(0.9);
    expect(validateSettings({ windVolume: 0.3 }).ambienceVolume).toBe(0.3);
    expect(validateSettings({ windVolume: 0.6 }).ambienceVolume).toBe(0.8);
    expect(validateSettings({ windVolume: 'x' }).ambienceVolume).toBe(0.8);
    const old = mem({ [SETTINGS_KEY]: JSON.stringify({ v: 3, volume: 0.4, windVolume: 0 }) });
    expect(loadSettings(old)).toMatchObject({ volume: 0.4, ambienceVolume: 0, musicOn: true, musicVolume: 0.7, sfxVolume: 0.9 });
    expect('windVolume' in loadSettings(old)).toBe(false);
  });

  it('validates the new fields', () => {
    expect(validateSettings({ musicOn: false, musicVolume: 2, sfxVolume: -1, ambienceVolume: 0.25 })).toMatchObject({ musicOn: false, musicVolume: 1, sfxVolume: 0, ambienceVolume: 0.25 });
    expect(validateSettings({ musicOn: 'no' }).musicOn).toBe(true);
  });
});
