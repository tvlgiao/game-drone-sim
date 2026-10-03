/**
 * Seed codes (design 07 §2.6) and the saved-worlds store.
 */
import { describe, expect, it } from 'vitest';
import { decodeSeed, encodeSeed, fnv1a32, parseSeedInput } from '../../src/world/seed-code';
import { deleteWorld, emptyWorlds, lastPlayedWorld, loadWorlds, MAX_WORLDS, recordPlayed, renameWorld, saveWorlds, WORLDS_KEY, worldsByRecent, type WorldsStore } from '../../src/game/worlds';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SEEDS = [0, 1, 42, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff, 123456789, 2654435761];

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  throwOnSet = false;
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.m.set(k, v);
  }
}

describe('seed codes', () => {
  it('round-trips every seed and version, shown as XXXX-XXXX in the Crockford alphabet', () => {
    for (const seed of SEEDS) {
      for (const v of [1, 2, 7]) {
        const code = encodeSeed(seed, v);
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        const d = decodeSeed(code, [v]);
        expect(d).toEqual({ ok: true, seed: seed >>> 0, version: v, code });
      }
    }
    // a deterministic sweep as well
    let s = 1;
    for (let i = 0; i < 2000; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const d = decodeSeed(encodeSeed(s, 1));
      expect(d.ok && d.seed).toBe(s);
    }
  });

  it('accepts lowercase, no dash, spaces and the Crockford aliases O / I / L', () => {
    const code = encodeSeed(0xdeadbeef, 1);
    const want = decodeSeed(code);
    expect(decodeSeed(code.toLowerCase())).toEqual(want);
    expect(decodeSeed(code.replace('-', ''))).toEqual(want);
    expect(decodeSeed(` ${code.slice(0, 2)} ${code.slice(2)} `)).toEqual(want);
    const withZero = SEEDS.map((x) => encodeSeed(x, 1)).find((c) => c.includes('0') || c.includes('1'));
    expect(withZero).toBeDefined();
    expect(decodeSeed(withZero!.replace(/0/g, 'O').replace(/1/g, 'I'))).toEqual(decodeSeed(withZero!));
  });

  it('the checksum catches every single-character edit', () => {
    for (const seed of SEEDS) {
      const code = encodeSeed(seed, 1).replace('-', '');
      let tried = 0;
      for (let pos = 0; pos < 8; pos++) {
        for (const ch of ALPHABET) {
          if (ch === code[pos]) continue;
          const edited = code.slice(0, pos) + ch + code.slice(pos + 1);
          const d = decodeSeed(edited, [1, 2, 3, 4, 5, 6, 7]);
          expect(d.ok, `${code} → ${edited}`).toBe(false);
          tried++;
        }
      }
      expect(tried).toBe(8 * 31);
    }
  });

  it('rejects bad length, alphabet and unsupported versions', () => {
    expect(decodeSeed('K7Q2-9XM')).toEqual({ ok: false, error: 'length' });
    expect(decodeSeed('K7Q2-9XMFF')).toEqual({ ok: false, error: 'length' });
    expect(decodeSeed('K7Q2-9XMU')).toEqual({ ok: false, error: 'alphabet' });
    const v2 = encodeSeed(42, 2);
    expect(decodeSeed(v2, [1])).toEqual({ ok: false, error: 'version' });
    expect(decodeSeed(v2, [1, 2]).ok).toBe(true);
    expect(() => encodeSeed(1, 0)).toThrow(RangeError);
    expect(() => encodeSeed(1, 8)).toThrow(RangeError);
  });

  it('FNV-1a matches the reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32('hello')).toBe(0x4f9f2cab);
  });

  it('parses the seed field: codes, typos in dashed codes, numbers, text', () => {
    const code = encodeSeed(777, 1);
    expect(parseSeedInput(code)).toEqual({ kind: 'code', seed: 777, version: 1, code });
    expect(parseSeedInput(code.replace('-', ''))).toEqual({ kind: 'code', seed: 777, version: 1, code });
    const typo = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
    expect(parseSeedInput(typo)).toEqual({ kind: 'invalid-code', error: 'checksum' });
    expect(parseSeedInput('  12345 ')).toEqual({ kind: 'number', seed: 12345 });
    expect(parseSeedInput('4294967296')).toEqual({ kind: 'text', seed: fnv1a32('4294967296') });
    expect(parseSeedInput('hello')).toEqual({ kind: 'text', seed: fnv1a32('hello') });
    expect(parseSeedInput('   ')).toEqual({ kind: 'empty' });
  });
});

describe('saved worlds store', () => {
  it('records, renames, deletes and remembers the last world', () => {
    let store = emptyWorlds();
    ({ store } = recordPlayed(store, 42, 1, 1000));
    const r = recordPlayed(store, 7, 1, 2000);
    store = r.store;
    expect(r.world.name).toBe(`World ${r.world.code.slice(0, 4)}`);
    expect(store.last).toBe(r.world.id);
    expect(lastPlayedWorld(store)?.seed).toBe(7);
    // playing again only touches lastPlayed
    ({ store } = recordPlayed(store, 42, 1, 3000));
    expect(store.worlds.length).toBe(2);
    expect(worldsByRecent(store).map((w) => w.seed)).toEqual([42, 7]);
    const id42 = encodeSeed(42, 1);
    store = renameWorld(store, id42, '   My   canyon run with a very long name   ');
    expect(store.worlds.find((w) => w.id === id42)?.name).toBe('My canyon run with a ver');
    expect(renameWorld(store, id42, '   ')).toBe(store);
    store = deleteWorld(store, id42);
    expect(store.worlds.map((w) => w.seed)).toEqual([7]);
    expect(store.last).toBeNull();
  });

  it('keeps at most 50, dropping the least recently played', () => {
    let store = emptyWorlds();
    for (let i = 0; i < MAX_WORLDS + 5; i++) ({ store } = recordPlayed(store, 1000 + i, 1, i));
    expect(store.worlds.length).toBe(MAX_WORLDS);
    const seeds = store.worlds.map((w) => w.seed);
    for (let i = 0; i < 5; i++) expect(seeds).not.toContain(1000 + i);
    expect(seeds).toContain(1000 + MAX_WORLDS + 4);
  });

  it('persists and reloads; corrupt JSON and bad entries fall back safely', () => {
    const storage = new MemoryStorage();
    let store = emptyWorlds();
    ({ store } = recordPlayed(store, 99, 1, 5));
    expect(saveWorlds(storage, store)).toBe(true);
    expect(loadWorlds(storage)).toEqual(store);

    storage.setItem(WORLDS_KEY, '{not json');
    expect(loadWorlds(storage)).toEqual(emptyWorlds());
    storage.setItem(WORLDS_KEY, JSON.stringify({ v: 2, worlds: [] }));
    expect(loadWorlds(storage)).toEqual(emptyWorlds());
    storage.setItem(WORLDS_KEY, JSON.stringify({ v: 1, last: 'nope', worlds: 'x' }));
    expect(loadWorlds(storage)).toEqual(emptyWorlds());

    const good = store.worlds[0]!;
    const tampered: WorldsStore = {
      v: 1,
      last: 'missing',
      worlds: [good, { ...good, seed: good.seed + 1 }, { ...good, id: 'X', code: 'ZZZZ-ZZZZ' }, null as never, good],
    };
    storage.setItem(WORLDS_KEY, JSON.stringify(tampered));
    expect(loadWorlds(storage)).toEqual({ v: 1, last: null, worlds: [good] });

    expect(loadWorlds(null)).toEqual(emptyWorlds());
    storage.throwOnSet = true;
    expect(saveWorlds(storage, store)).toBe(false);
    expect(saveWorlds(null, store)).toBe(false);
  });

  it('rejects generator versions this build does not ship', () => {
    expect(() => recordPlayed(emptyWorlds(), 1, 3, 0)).toThrow(RangeError);
  });
});
