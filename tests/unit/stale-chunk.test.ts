import { describe, expect, it } from 'vitest';
import { RELOAD_FLAG, entryScript, isChunkLoadError, newerVersion, reloadForNewVersion, type VersionProbe } from '../../src/core/stale-chunk';

const CHUNK_ERR = new TypeError('Failed to fetch dynamically imported module: https://x.dev/assets/world-level-view-OLD.js');

function mem(): Pick<Storage, 'getItem' | 'setItem'> & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const probe = (o: Partial<{ worker: boolean; html: string | null; entry: string | null; throws: boolean }>): VersionProbe => ({
  newerWorker: async () => {
    if (o.throws) throw new Error('no worker');
    return o.worker ?? false;
  },
  freshHtml: async () => o.html ?? null,
  currentEntry: () => (o.entry === undefined ? 'main-OLD.js' : o.entry),
});

describe('stale chunk after a deploy', () => {
  it('recognises failed lazy imports in each engine', () => {
    expect(isChunkLoadError(CHUNK_ERR)).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: x'))).toBe(true);
    expect(isChunkLoadError(new Error('injected level-view fault'))).toBe(false);
  });

  it("reads the page's entry script from its HTML", () => {
    expect(entryScript('<script type="module" crossorigin src="../assets/three.core-a.js"></script><script type="module" crossorigin src="../assets/main-NEW1.js"></script>')).toBe('main-NEW1.js');
    expect(entryScript('<p>no script</p>')).toBeNull();
  });

  it('a newer build: a worker waiting, or the served page names another entry', async () => {
    expect(await newerVersion(probe({ worker: true }))).toBe(true);
    expect(await newerVersion(probe({ html: '<script src="../assets/main-NEW.js"></script>' }))).toBe(true);
    expect(await newerVersion(probe({ html: '<script src="../assets/main-OLD.js"></script>' }))).toBe(false);
    expect(await newerVersion(probe({ throws: true, html: '<script src="../assets/main-NEW.js"></script>' }))).toBe(true);
    expect(await newerVersion(probe({ html: null }))).toBe(false);
  });

  it('reloads once per session onto the new build, never for other errors or without a newer build', async () => {
    const s = mem();
    let reloads = 0;
    const reload = (): void => void reloads++;
    expect(await reloadForNewVersion(new Error('boom'), probe({ worker: true }), s, reload)).toBe(false);
    expect(await reloadForNewVersion(CHUNK_ERR, probe({}), s, reload)).toBe(false);
    expect(reloads).toBe(0);
    expect(await reloadForNewVersion(CHUNK_ERR, probe({ worker: true }), s, reload)).toBe(true);
    expect(reloads).toBe(1);
    expect(s.m.has(RELOAD_FLAG)).toBe(true);
    // the reloaded page fails again (a real network problem): no second reload, the error shows
    expect(await reloadForNewVersion(CHUNK_ERR, probe({ worker: true }), s, reload)).toBe(false);
    expect(reloads).toBe(1);
    // storage that cannot keep the flag: no reload at all (a loop is worse than an error)
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(await reloadForNewVersion(CHUNK_ERR, probe({ worker: true }), broken, reload)).toBe(false);
    expect(reloads).toBe(1);
  });
});
