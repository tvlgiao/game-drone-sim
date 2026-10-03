import { describe, expect, it } from 'vitest';
import { GameAudio, type AudioSettings } from '../../src/audio/audio';
import { LIFE_VOICES, SlotAssigner, doppler, engineHz, type AmbientSource, type CarSource, type LifeHubLike } from '../../src/audio/life-sounds';
import { LIFE_SFX } from '../../src/audio/sfx-bank';
import { FakeContext, fakeOffline } from './fixtures/fake-audio';

const SOUND: AudioSettings = { volume: 0.7, musicOn: true, musicVolume: 0.7, sfxVolume: 0.9, ambienceVolume: 0.8, analogVideo: false, analogStrength: 0.35 };

const flush = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const car = (x: number, z: number, vx = 0, vz = 0, type = 0): CarSource => ({ x, y: 0.7, z, vx, vz, speed: Math.hypot(vx, vz), type, braking: false, distance: Math.hypot(x, z) });

/** A hub with a scripted street: `cars` (any order) and ambient sources; counts its listeners. */
class FakeHub implements LifeHubLike {
  cars: CarSource[] = [];
  ambient: AmbientSource[] = [];
  readonly listeners = new Map<string, ((e: { x: number; y: number; z: number }) => void)[]>();
  carCalls = 0;
  lastMax = 0;
  getTrafficEmitters(x: number, _y: number, z: number, max: number, out: CarSource[]): number {
    this.carCalls++;
    this.lastMax = max;
    const sorted = [...this.cars].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, max);
    sorted.forEach((c, i) => {
      out[i] ??= car(0, 0);
      Object.assign(out[i]!, c, { distance: Math.hypot(c.x - x, c.z - z) });
    });
    return sorted.length;
  }
  emitters(x: number, _y: number, z: number, max: number, out: AmbientSource[]): number {
    const sorted = [...this.ambient].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, max);
    sorted.forEach((e, i) => {
      out[i] ??= { ...e };
      Object.assign(out[i]!, e, { distance: Math.hypot(e.x - x, e.z - z) });
    });
    return sorted.length;
  }
  on(type: 'horn' | 'flock-scatter', fn: (e: { x: number; y: number; z: number }) => void): () => void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
    return () => l.splice(l.indexOf(fn), 1);
  }
  emit(type: 'horn' | 'flock-scatter', x: number, y: number, z: number): void {
    for (const f of [...(this.listeners.get(type) ?? [])]) f({ x, y, z });
  }
  get listening(): number {
    let n = 0;
    for (const l of this.listeners.values()) n += l.length;
    return n;
  }
}

describe('voice assignment', () => {
  it('each car keeps its voice while it drives on; a new car takes a free voice', () => {
    const a = new SlotAssigner(3);
    const cars = [car(0, 5, 10), car(0, 20, -10), car(30, 0)];
    a.assign(cars, 3, 0.1);
    const voices = [0, 1, 2].map((i) => a.slotOf[i]);
    expect(new Set(voices).size).toBe(3);
    expect([...a.fresh]).toEqual([1, 1, 1]);
    // 0.1 s later the first two moved 1 m, and the list order changed (nearest first)
    const moved = [car(0, 19, -10), car(1, 5, 10), car(30, 0)];
    a.assign(moved, 3, 0.1);
    expect(a.slotOf[0]).toBe(voices[1]);
    expect(a.slotOf[1]).toBe(voices[0]);
    expect(a.slotOf[2]).toBe(voices[2]);
    expect([...a.fresh]).toEqual([0, 0, 0]);
    // the far car leaves, a new one arrives elsewhere: it takes the freed voice, flagged fresh
    a.assign([car(0, 18, -10), car(2, 5, 10), car(-40, -40)], 3, 0.1);
    expect(a.slotOf[2]).toBe(voices[2]);
    expect(a.fresh[voices[2]!]).toBe(1);
  });

  it('a voice whose source is gone falls silent; never more sources than voices', () => {
    const a = new SlotAssigner(2);
    a.assign([car(0, 5), car(0, 9), car(0, 15)], 3, 0.1);
    expect(a.busy).toBe(2);
    expect([...a.sourceOf].sort()).toEqual([0, 1]); // the third (farthest) has none
    a.assign([car(0, 5)], 1, 0.1);
    expect(a.busy).toBe(1);
    expect([...a.sourceOf].filter((s) => s >= 0)).toEqual([0]);
    a.clear();
    expect(a.busy).toBe(0);
  });

  it('a different kind never inherits a voice (turbine vs tractor)', () => {
    const a = new SlotAssigner(1);
    a.assign([car(10, 10)], 1, 0.1, () => 1);
    a.assign([car(10, 10)], 1, 0.1, () => 2);
    expect(a.fresh[0]).toBe(1);
  });

  it('assigning allocates nothing per update', () => {
    const a = new SlotAssigner(12);
    const cars = Array.from({ length: 12 }, (_, i) => car(i * 7, 3, 8, 0));
    const arrays = [a.slotOf, a.sourceOf, a.fresh];
    for (let f = 0; f < 1000; f++) {
      for (const c of cars) c.x += 0.8;
      a.assign(cars, 12, 0.1);
    }
    expect([a.slotOf, a.sourceOf, a.fresh]).toEqual(arrays);
    expect(arrays.every((x, i) => x === [a.slotOf, a.sourceOf, a.fresh][i])).toBe(true);
    // all twelve still on their own voices after 1000 updates (none dropped, none swapped)
    expect(a.busy).toBe(12);
    expect([...a.fresh].every((f) => f === 0)).toBe(true);
  });

  it('Doppler: higher approaching, lower leaving; engine hum rises with speed, lower for big types', () => {
    expect(doppler(0, 0, 50, 0, -20)).toBeGreaterThan(1.05);
    expect(doppler(0, 0, 50, 0, 20)).toBeLessThan(0.95);
    expect(doppler(50, 0, 0, 0, 20)).toBeCloseTo(1, 5); // crossing: no shift
    expect(engineHz(15, 0)).toBeGreaterThan(engineHz(5, 0));
    expect(engineHz(10, 4)).toBeLessThan(engineHz(10, 0));
  });
});

async function engine(life: FakeHub | null, tier: 'high' | 'low' = 'high'): Promise<{ a: GameAudio; ctx: FakeContext }> {
  const ctx = new FakeContext();
  let seed = 11;
  const a = new GameAudio({ createContext: () => ctx as unknown as BaseAudioContext, offline: fakeOffline, random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) });
  a.configure({ tier, form: 'desktop' });
  a.applySettings(SOUND);
  a.setLevel({ def: { id: 'city' }, terrain: null, life });
  await a.resume();
  await flush();
  return { a, ctx };
}

const EYE = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.7, 0, 1] } };
const DRONE = { position: { x: 0, y: 1.7, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, motors: [0, 0, 0, 0] as [number, number, number, number], armed: false, batteryVoltage: 16.4 };
const RACE = { status: 'freefly' as const, nextRing: 0, totalRings: 0, time: 0, bestTime: null };

describe('living-world voices in the engine', () => {
  it('the nearest cars get voices (pool by tier), horns and wing flaps play on the hub events', async () => {
    const hub = new FakeHub();
    hub.cars = Array.from({ length: 30 }, (_, i) => car((i % 6) * 9 - 20, Math.floor(i / 6) * 9 - 20, 8, 0, i % 5));
    const { a, ctx } = await engine(hub);
    ctx.currentTime += 0.2;
    a.frame(DRONE as never, RACE, 'los', EYE);
    expect(hub.lastMax).toBe(LIFE_VOICES.full.cars);
    expect(a.debug().life?.cars).toBe(LIFE_VOICES.full.cars);
    expect(a.debug().bank).toBeGreaterThan(0);
    const before = a.debug().created;
    hub.emit('horn', 3, 0.7, 4);
    hub.emit('flock-scatter', -5, 6, 2);
    expect(a.debug().life?.horns).toBe(1);
    expect(a.debug().life?.wings).toBe(1);
    expect(a.debug().created - before).toBe(2); // one buffer source each, no new voices
    // updates create no nodes (only the City's own scattered one-shots add a source each)
    const n0 = a.debug().created;
    const e0 = a.debug().ambience!.events;
    for (let i = 0; i < 50; i++) {
      for (const c of hub.cars) c.x += 0.8;
      ctx.currentTime += 0.1;
      a.frame(DRONE as never, RACE, 'los', EYE);
    }
    expect(a.debug().created - n0).toBe(a.debug().ambience!.events - e0);
  });

  it('lite tier: half the car voices', async () => {
    const hub = new FakeHub();
    hub.cars = Array.from({ length: 20 }, (_, i) => car(i * 4, 6, 8));
    const { a, ctx } = await engine(hub, 'low');
    ctx.currentTime += 0.2;
    a.frame(DRONE as never, RACE, 'los', EYE);
    expect(hub.lastMax).toBe(LIFE_VOICES.lite.cars);
    expect(a.debug().life?.carVoices).toBe(LIFE_VOICES.lite.cars);
  });

  it('a level switch releases the voices and stops listening to the old hub', async () => {
    const hub = new FakeHub();
    hub.cars = [car(5, 5, 8)];
    const { a, ctx } = await engine(hub);
    expect(hub.listening).toBe(2);
    a.setLevel({ def: { id: 'training' }, terrain: null, life: null });
    await flush();
    expect(hub.listening).toBe(0);
    expect(a.debug().life).toBeNull();
    const calls = hub.carCalls;
    ctx.currentTime += 0.2;
    a.frame(DRONE as never, RACE, 'los', EYE);
    expect(hub.carCalls).toBe(calls); // the old hub is not asked any more
    // the old level's scope (and its voices) is disposed after its fade
    ctx.currentTime += 2;
    a.flush();
    expect(a.debug().nodes).toBeLessThan(a.debug().created);
  });

  it('herds ring bells near, turbines and the tractor take loop voices', async () => {
    const hub = new FakeHub();
    const em = (kind: string, x: number, z: number, speed = 0.3): AmbientSource => ({ kind, x, y: 1, z, vx: 0, vy: 0, vz: 0, speed, intensity: 0.8, variant: 0, distance: 0 });
    hub.ambient = [em('turbine', 40, 0), em('tractor', -30, 10, 2.4), em('herd', 20, 20), em('flock', 5, 5)];
    const { a, ctx } = await engine(hub);
    const n0 = a.debug().created;
    for (let i = 0; i < 80; i++) {
      ctx.currentTime += 0.1;
      a.frame(DRONE as never, RACE, 'los', EYE);
    }
    expect(a.debug().life?.ambient).toBe(2);
    // cowbells: a handful of one-shots in 8 s (one buffer source each)
    const shots = a.debug().created - n0;
    expect(shots).toBeGreaterThanOrEqual(1);
    expect(shots).toBeLessThanOrEqual(6);
  });

  it('the life sounds are rendered with a level that has life', () => {
    expect(LIFE_SFX).toEqual(expect.arrayContaining(['horn-1', 'wings', 'bleat']));
  });
});
