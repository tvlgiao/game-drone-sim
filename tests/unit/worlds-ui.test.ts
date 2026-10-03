/**
 * Worlds UI logic (design 07 §6): seed field validation, plays / random worlds in the store, share links, the
 * `?world=` deep link, compass and minimap maths, units, the new settings and the XR card lines.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, minimapOn, saveSettings, validateSettings } from '../../src/core/settings';
import { WORLDS_KEY, emptyWorlds, loadWorlds, recordPlayed, renameWorld } from '../../src/game/worlds';
import { bearingDeg, headingFromQuat, headingText, tapeMarker, tapeOffsetPct, tapeTicks, TAPE_EDGE_DEG, TAPE_SPAN_DEG, wrap180, wrap360 } from '../../src/ui/compass';
import { formatDistance, heightValue, speedUnit, speedValue } from '../../src/ui/format';
import { cardModes, isSeededCard, levelAct, levelCardsHtml, parseLevelAct } from '../../src/ui/level-select';
import { clampToDisc, MAP_BUILDING, terrainMinimapSampler, worldToMap } from '../../src/ui/minimap';
import { gatePlayHref, lastPlayedText, parseWorldParam, playWorld, randomSeed, resumeOrNewWorld, seedFieldStatus, SITE_URL, stripWorldParam, worldShareUrl } from '../../src/ui/worlds-model';
import { xrHudContent, xrOutdoorLine, type XrHudState } from '../../src/ui/xr-hud';
import { BIOME, type BiomeSample, type TerrainField } from '../../src/world/terrain-field';
import { encodeSeed, fnv1a32 } from '../../src/world/seed-code';
import { GEN_VERSION } from '../../src/world/world';

function mem(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const CODE = encodeSeed(123456789, 1);

describe('seed field status', () => {
  it('empty and half-typed codes are not playable', () => {
    expect(seedFieldStatus('   ')).toMatchObject({ tone: 'idle', pick: null });
    expect(seedFieldStatus('K7Q2-')).toEqual({ tone: 'idle', message: 'Keep typing — 4 more characters', pick: null });
    expect(seedFieldStatus(CODE.slice(0, 8))).toEqual({ tone: 'idle', message: 'Keep typing — 1 more character', pick: null });
  });

  it('a valid code plays that seed, in any case, with or without the dash', () => {
    const want = { seed: 123456789, gen: 1, code: CODE };
    expect(seedFieldStatus(CODE)).toEqual({ tone: 'ok', message: `World ${CODE}`, pick: want });
    expect(seedFieldStatus(` ${CODE.toLowerCase()} `).pick).toEqual(want);
    expect(seedFieldStatus(CODE.replace('-', '')).pick).toEqual(want);
  });

  it('a saved code shows its name', () => {
    const store = renameWorld(recordPlayed(emptyWorlds(), 123456789, 1, 5).store, CODE, 'Lakeside');
    expect(seedFieldStatus(CODE, store).message).toBe('Saved as Lakeside');
  });

  it('typos in a dashed code are reported, never hashed', () => {
    // every single-character edit breaks the checksum
    for (let i = 0; i < 9; i++) {
      if (i === 4) continue;
      const ch = CODE[i] === 'A' ? 'B' : 'A';
      const typo = CODE.slice(0, i) + ch + CODE.slice(i + 1);
      const st = seedFieldStatus(typo);
      expect(st.pick, typo).toBeNull();
      expect(st.tone, typo).toBe('error');
    }
    expect(seedFieldStatus(`${CODE.slice(0, 8)}U`)).toEqual({ tone: 'error', message: '“U” is not used in world codes — check the code', pick: null });
    expect(seedFieldStatus(`${CODE}Z`)).toEqual({ tone: 'error', message: 'World codes have 8 characters, like K7Q2-9XMF', pick: null });
    expect(seedFieldStatus(encodeSeed(1, GEN_VERSION + 1))).toEqual({ tone: 'error', message: 'This world needs a newer version of Drone Sim', pick: null });
  });

  it('digits are the seed; free text is hashed with FNV-1a', () => {
    expect(seedFieldStatus('4294967295')).toEqual({ tone: 'ok', message: `Seed 4294967295 → ${encodeSeed(0xffffffff, GEN_VERSION)}`, pick: { seed: 0xffffffff, gen: GEN_VERSION, code: encodeSeed(0xffffffff, GEN_VERSION) } });
    const h = fnv1a32('hello world');
    expect(seedFieldStatus('hello world')).toEqual({ tone: 'ok', message: `“hello world” → ${encodeSeed(h, GEN_VERSION)}`, pick: { seed: h, gen: GEN_VERSION, code: encodeSeed(h, GEN_VERSION) } });
    expect(seedFieldStatus('a very long sentence of words').message).toBe(`“a very long sente…” → ${encodeSeed(fnv1a32('a very long sentence of words'), GEN_VERSION)}`);
  });

  it('an undashed 8-character string that fails the checksum plays as text, with a warning', () => {
    const bad = `${CODE.slice(0, 4)}${CODE.slice(5, 8)}${CODE[8] === 'A' ? 'B' : 'A'}`;
    const st = seedFieldStatus(bad);
    expect(st.tone).toBe('warn');
    expect(st.pick?.seed).toBe(fnv1a32(bad));
  });
});

describe('plays and random worlds', () => {
  it('randomSeed is the uint32 crypto produced', () => {
    expect(randomSeed((a) => a.fill(0xdeadbeef))).toBe(0xdeadbeef);
    const r = randomSeed();
    expect(Number.isInteger(r) && r >= 0 && r <= 0xffffffff).toBe(true);
  });

  it('playWorld saves the world as "World XXXX" and makes it the last one', () => {
    const st = mem();
    const w = playWorld(st, { seed: 123456789, gen: 1 }, 1000);
    expect(w).toMatchObject({ id: CODE, name: `World ${CODE.slice(0, 4)}`, lastPlayed: 1000 });
    expect(loadWorlds(st)).toMatchObject({ last: CODE, worlds: [{ id: CODE }] });
  });

  it('resumeOrNewWorld continues the last world, else rolls a new one', () => {
    const st = mem();
    const a = resumeOrNewWorld(st, 1, () => 42);
    expect(a).toEqual({ seed: 42, gen: GEN_VERSION, code: encodeSeed(42, GEN_VERSION) });
    const b = resumeOrNewWorld(st, 2, () => 7);
    expect(b.seed).toBe(42);
    expect(loadWorlds(st).worlds[0]!.lastPlayed).toBe(2);
    expect(resumeOrNewWorld(null, 3, () => 9).seed).toBe(9);
  });
});

describe('share links and the deep link', () => {
  it('links the edition the pilot is on, under the same site prefix', () => {
    expect(worldShareUrl(CODE, { origin: 'https://x.dev', pathname: '/play/' }, false)).toBe(`https://x.dev/play/?world=${CODE}`);
    // the Quest app shares the free web game: anyone can open it (the app itself still reads /app/?world=)
    expect(worldShareUrl(CODE, { origin: 'https://x.dev', pathname: '/app/index.html' }, false)).toBe(`https://x.dev/play/?world=${CODE}`);
    expect(worldShareUrl(CODE, { origin: 'https://x.github.io', pathname: '/drone-sim/app/' }, false)).toBe(`https://x.github.io/drone-sim/play/?world=${CODE}`);
    expect(worldShareUrl(CODE, { origin: 'https://x.github.io', pathname: '/drone-sim/play/' }, false)).toBe(`https://x.github.io/drone-sim/play/?world=${CODE}`);
    expect(worldShareUrl(CODE, { origin: 'http://localhost:5173', pathname: '/worlds-preview.html' }, false)).toBe(`http://localhost:5173/play/?world=${CODE}`);
    expect(worldShareUrl(CODE, { origin: 'capacitor://localhost', pathname: '/' }, false)).toBe(`${SITE_URL}play/?world=${CODE}`);
    expect(worldShareUrl(CODE, { origin: 'https://x.dev', pathname: '/app/' }, true)).toBe(`${SITE_URL}play/?world=${CODE}`);
  });

  it("the Quest store gate's web link keeps a valid ?world= (and nothing else)", () => {
    expect(gatePlayHref('')).toBe('../play/');
    expect(gatePlayHref(`?world=${CODE}`)).toBe(`../play/?world=${CODE}`);
    expect(gatePlayHref(`?xremu=1&world=${CODE.toLowerCase()}&owned=1`)).toBe(`../play/?world=${CODE}`);
    expect(gatePlayHref('?world=%3Cscript%3E')).toBe('../play/');
    expect(gatePlayHref('?foo=bar')).toBe('../play/');
  });

  it('parses ?world= from a search string, a Location or a full URL', () => {
    const want = { kind: 'world', seed: 123456789, gen: 1, code: CODE };
    expect(parseWorldParam({ search: `?world=${CODE}` })).toEqual(want);
    expect(parseWorldParam(`https://x.dev/play/?rotate=0&world=${CODE.toLowerCase()}#top`)).toEqual(want);
    expect(parseWorldParam(`dronesim://open?world=${CODE.replace('-', '')}`)).toEqual(want);
    expect(parseWorldParam({ search: '' })).toEqual({ kind: 'none' });
    expect(parseWorldParam({ search: '?world=' })).toEqual({ kind: 'none' });
    expect(parseWorldParam('https://x.dev/play/')).toEqual({ kind: 'none' });
  });

  it('a broken or future code is an error with the toast text', () => {
    const typo = `${CODE.slice(0, 8)}${CODE[8] === 'A' ? 'B' : 'A'}`;
    expect(parseWorldParam({ search: `?world=${typo}` })).toEqual({ kind: 'error', error: 'checksum', message: 'That world link is not valid — check the code' });
    expect(parseWorldParam({ search: '?world=hello' })).toMatchObject({ kind: 'error', error: 'length' });
    expect(parseWorldParam({ search: `?world=${encodeSeed(5, 3)}` })).toEqual({ kind: 'error', error: 'version', message: 'That world link needs a newer version of Drone Sim' });
  });

  it('stripWorldParam keeps every other parameter', () => {
    expect(stripWorldParam(`https://x.dev/play/?rotate=0&world=${CODE}#a`)).toBe('https://x.dev/play/?rotate=0#a');
    expect(stripWorldParam(`https://x.dev/play/?world=${CODE}`)).toBe('https://x.dev/play/');
  });

  it('last played reads like a person would say it', () => {
    const now = Date.UTC(2026, 9, 3, 12);
    expect(lastPlayedText(now + 5000, now)).toBe('just now');
    expect(lastPlayedText(now - 59_000, now)).toBe('just now');
    expect(lastPlayedText(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(lastPlayedText(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(lastPlayedText(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(lastPlayedText(now - 6 * 86_400_000, now)).toBe('6 days ago');
    expect(lastPlayedText(now - 8 * 86_400_000, now)).toMatch(/Sep 2\d, 2026/);
  });
});

/** Quaternion for a pure yaw that turns the nose to compass `deg` (clockwise from north = −Z). */
const yawQuat = (deg: number) => {
  const a = (-deg * Math.PI) / 180 / 2;
  return { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) };
};

describe('compass', () => {
  it('wraps headings', () => {
    expect([wrap360(0), wrap360(360), wrap360(-90), wrap360(725), wrap360(-0)]).toEqual([0, 0, 270, 5, 0]);
    expect([wrap180(180), wrap180(181), wrap180(-180), wrap180(350), wrap180(10)]).toEqual([180, -179, 180, -10, 10]);
  });

  it('heading from orientation: north is −Z, east is +X, clockwise', () => {
    for (const d of [0, 45, 90, 179, 180, 270, 359]) expect(headingFromQuat(yawQuat(d))).toBeCloseTo(d, 6);
    // pitched 30° nose down keeps the heading
    const p = Math.sin(-Math.PI / 12);
    const q = { x: p, y: 0, z: 0, w: Math.cos(Math.PI / 12) };
    expect(headingFromQuat(q)).toBeCloseTo(0, 6);
    // straight down: undefined
    expect(headingFromQuat({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })).toBeNaN();
  });

  it('bearings between ground points', () => {
    expect(bearingDeg(0, 0, 0, -10)).toBeCloseTo(0);
    expect(bearingDeg(0, 0, 10, 0)).toBeCloseTo(90);
    expect(bearingDeg(0, 0, 0, 10)).toBeCloseTo(180);
    expect(bearingDeg(0, 0, -10, 0)).toBeCloseTo(270);
    expect(bearingDeg(5, 5, 15, -5)).toBeCloseTo(45);
  });

  it('tape: the heading sits under the centre, markers pin at the edges across the 0/360 wrap', () => {
    expect(tapeOffsetPct(0)).toBe(50);
    expect(tapeOffsetPct(60)).toBeCloseTo(0);
    expect(tapeOffsetPct(360 + 60)).toBeCloseTo(0);
    expect(tapeMarker(10, 350)).toEqual({ pct: 50 + (20 / TAPE_SPAN_DEG) * 100, pinned: false });
    expect(tapeMarker(350, 10)).toEqual({ pct: 50 - (20 / TAPE_SPAN_DEG) * 100, pinned: false });
    expect(tapeMarker(180, 0)).toEqual({ pct: 50 + (TAPE_EDGE_DEG / TAPE_SPAN_DEG) * 100, pinned: true });
    expect(tapeMarker(181, 0)).toEqual({ pct: 50 - (TAPE_EDGE_DEG / TAPE_SPAN_DEG) * 100, pinned: true });
    expect(tapeMarker(TAPE_EDGE_DEG, 0).pinned).toBe(false);
    expect(headingText(359.6)).toBe('000');
    expect(headingText(5.4)).toBe('005');
  });

  it('tick strip covers any heading ± half the span with labels', () => {
    const t = tapeTicks();
    expect(t[0]!.pct).toBeCloseTo((-180 / TAPE_SPAN_DEG) * 100);
    expect(t.at(-1)!.pct).toBeCloseTo((540 / TAPE_SPAN_DEG) * 100);
    const at = (deg: number) => t.find((x) => Math.abs(x.pct - (deg / TAPE_SPAN_DEG) * 100) < 1e-9)!;
    expect([at(0).label, at(90).label, at(360).label, at(-90).label, at(30).label, at(15).label]).toEqual(['N', 'E', 'N', 'W', '030', '']);
    expect(at(45).major && !at(30).major).toBe(true);
  });
});

describe('minimap projection', () => {
  it('north up: −Z goes up the map, +X right', () => {
    expect(worldToMap(0, 0, 8, 128)).toEqual({ x: 64, y: 64 });
    expect(worldToMap(80, 0, 8, 128)).toEqual({ x: 74, y: 64 });
    expect(worldToMap(0, -160, 8, 128)).toEqual({ x: 64, y: 44 });
  });

  it('markers off the disc are pulled onto the rim along their direction', () => {
    expect(clampToDisc(70, 64, 128, 50)).toEqual({ x: 70, y: 64, pinned: false });
    const p = clampToDisc(64 + 300, 64 - 400, 128, 50);
    expect(p.pinned).toBe(true);
    expect(p.x).toBeCloseTo(64 + 30);
    expect(p.y).toBeCloseTo(64 - 40);
  });

  it('reference sampler: thin roads / water found off-centre, city blocks are buildings', () => {
    const calls: [number, number][] = [];
    const field = (preset: TerrainField['preset'], at: (x: number, z: number) => number): TerrainField =>
      ({
        preset,
        biomeAt(x: number, z: number, out: BiomeSample) {
          calls.push([x, z]);
          out.biome = at(x, z) as BiomeSample['biome'];
          return out;
        },
      }) as unknown as TerrainField;
    const road = terrainMinimapSampler(field('infinite', (x) => (x > 2 ? BIOME.road : BIOME.meadow)));
    expect(road.cell(0, 0, 16)).toBe(BIOME.road);
    expect(calls).toEqual([
      [0, 0],
      [-4, -4],
      [4, 4],
    ]);
    expect(terrainMinimapSampler(field('infinite', () => BIOME.forest)).cell(0, 0, 16)).toBe(BIOME.forest);
    expect(terrainMinimapSampler(field('city', () => BIOME.village)).cell(0, 0, 16)).toBe(MAP_BUILDING);
    expect(terrainMinimapSampler(field('infinite', () => BIOME.village)).cell(0, 0, 16)).toBe(BIOME.village);
    const b = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    expect(terrainMinimapSampler(field('city', () => 0), b).bounds).toBe(b);
  });
});

describe('units', () => {
  it('distances, heights and speeds in metres or feet', () => {
    expect([formatDistance(132.4, 'm'), formatDistance(999.4, 'm'), formatDistance(2450, 'm'), formatDistance(12_345, 'm'), formatDistance(-3, 'm')]).toEqual(['132 m', '999 m', '2.45 km', '12.3 km', '0 m']);
    expect([formatDistance(100, 'ft'), formatDistance(1609.344, 'ft'), formatDistance(20_000, 'ft'), formatDistance(Number.NaN, 'ft')]).toEqual(['328 ft', '1.00 mi', '12.4 mi', '—']);
    expect([heightValue(25.34, 'm'), heightValue(99.94, 'm'), heightValue(250.4, 'm'), heightValue(10, 'ft'), heightValue(40, 'ft')]).toEqual(['25.3', '99.9', '250', '32.8', '131']);
    // boundaries: 1 km switches to km, 100 drops the decimal
    expect([formatDistance(1000, 'm'), heightValue(100, 'm'), heightValue(-100, 'm')]).toEqual(['1.00 km', '100', '-100']);
    expect([speedValue(22, 'm'), speedValue(22, 'ft'), speedUnit('m'), speedUnit('ft')]).toEqual(['79', '49', 'km/h', 'mph']);
  });
});

describe('outdoor settings', () => {
  it('defaults: auto time and view distance, device-default minimap, metres', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ timeOfDay: 'auto', viewDistance: 'auto', minimap: null, units: 'm', ambienceVolume: 0.8 });
    expect([minimapOn({ minimap: null }, false), minimapOn({ minimap: null }, true), minimapOn({ minimap: true }, true), minimapOn({ minimap: false }, false)]).toEqual([true, false, true, false]);
  });

  it('validates values and migrates unit spellings', () => {
    expect(validateSettings({ timeOfDay: 'golden', viewDistance: 'long', minimap: false, units: 'ft', ambienceVolume: 0.3 })).toMatchObject({ timeOfDay: 'golden', viewDistance: 'long', minimap: false, units: 'ft', ambienceVolume: 0.3 });
    expect(validateSettings({ timeOfDay: 7, viewDistance: null, minimap: 1, units: 'yards', ambienceVolume: -2 })).toMatchObject({ timeOfDay: 'auto', viewDistance: 'auto', minimap: null, units: 'm', ambienceVolume: 0 });
    expect(validateSettings({ units: 'Imperial' }).units).toBe('ft');
    expect(validateSettings({ units: 'feet' }).units).toBe('ft');
    expect(validateSettings({ units: 'metric' }).units).toBe('m');
  });

  it('persist across a reload; v3 saves without the new fields get the defaults', () => {
    const st = mem();
    saveSettings({ ...validateSettings({}), timeOfDay: 'dusk', viewDistance: 'short', minimap: true, units: 'ft', ambienceVolume: 0.2 }, st);
    expect(loadSettings(st)).toMatchObject({ timeOfDay: 'dusk', viewDistance: 'short', minimap: true, units: 'ft', ambienceVolume: 0.2 });
    const old = mem({ [SETTINGS_KEY]: JSON.stringify({ v: 3, fovDeg: 120 }) });
    expect(loadSettings(old)).toMatchObject({ fovDeg: 120, timeOfDay: 'auto', viewDistance: 'auto', minimap: null, units: 'm', ambienceVolume: 0.8 });
  });
});

describe('level cards', () => {
  it('Infinite has Free Fly + Worlds…, the rest Race + Free Fly', () => {
    expect(cardModes({ id: 'city' })).toEqual(['race', 'freefly']);
    expect(cardModes({ id: 'infinite' })).toEqual(['freefly', 'worlds']);
    expect(cardModes({ id: 'alpine', kind: 'seeded' })).toEqual(['freefly', 'worlds']);
    expect(isSeededCard({ id: 'training', kind: 'authored' })).toBe(false);
    expect(parseLevelAct(levelAct('worlds', 'infinite'))).toEqual({ mode: 'worlds', id: 'infinite' });
    expect(parseLevelAct('level-seedrun:infinite')).toBeNull();
    const html = levelCardsHtml(
      [
        { id: 'city', name: 'City', blurb: 'Dusk', best: null },
        { id: 'infinite', name: 'Infinite <World>', blurb: 'x', best: null, note: `Last world · ${CODE}` },
      ],
      'city',
    );
    expect(html).toContain('data-act="level-race:city"');
    expect(html).toContain('data-act="level-worlds:infinite"');
    expect(html).not.toContain('data-act="level-race:infinite"');
    expect(html).toContain(`Last world · ${CODE}`);
    expect(html).toContain('Infinite &#60;World&#62;');
  });
});

describe('XR card outdoors', () => {
  const base: XrHudState = {
    race: { status: 'paused', time: 0, countdown: 0, nextRing: -1, totalRings: 0, bestTime: null, lastSplit: null },
    armed: true,
    latched: false,
    mode: 'angle',
    camera: 'fpv',
    altitude: 80,
    speed: 10,
    toast: '',
  };

  it('pause card kicker: pilot distance, AGL and the world code', () => {
    expect(xrOutdoorLine({ agl: 35.04, pilotDistance: 120.4 }, 'm', CODE)).toBe(`PILOT 120 m · AGL 35.0 m · ${CODE}`);
    expect(xrOutdoorLine({ agl: 10, pilotDistance: null }, 'ft', undefined)).toBe('AGL 32.8 ft');
    expect(xrHudContent({ ...base, outdoor: { agl: 35, pilotDistance: 120 }, world: CODE }).kicker).toBe(`PILOT 120 m · AGL 35.0 m · ${CODE}`);
    expect(xrHudContent(base).kicker).toBeUndefined();
  });

  it('menu card names the world; the flight line shows AGL in the pilot’s units', () => {
    const menu = xrHudContent({ ...base, race: { ...base.race, status: 'menu' }, level: 'Infinite World', world: CODE });
    expect(menu.sub).toBe(`Infinite World · ${CODE}`);
    const fly = xrHudContent({ ...base, race: { ...base.race, status: 'freefly' }, outdoor: { agl: 12.3, pilotDistance: 5 }, units: 'ft' });
    expect(fly.sub).toContain('AGL 40.4 ft');
    expect(fly.title).toBe('FREE FLY · 22 mph');
    expect(xrHudContent({ ...base, race: { ...base.race, status: 'freefly' } }).sub).toContain('80.0 m');
  });
});

describe('store key', () => {
  it('worlds live under drone-sim.worlds.v1', () => {
    expect(WORLDS_KEY).toBe('drone-sim.worlds.v1');
  });
});
