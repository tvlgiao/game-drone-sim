/**
 * Saved Infinite worlds (design 07 §2.6): `drone-sim.worlds.v1` =
 * `{ v: 1, last: id | null, worlds: [{ id, name, code, seed, gen, created, lastPlayed }] }`, at most 50,
 * least recently played dropped first. Corrupt JSON or entries fall back to an empty / filtered list.
 * DOM-free: storage and clock are injected.
 */
import { decodeSeed, encodeSeed } from '../world/seed-code';
import { SUPPORTED_GEN_VERSIONS } from '../world/world';

export const WORLDS_KEY = 'drone-sim.worlds.v1';
export const MAX_WORLDS = 50;
export const MAX_WORLD_NAME = 24;

export interface SavedWorld {
  /** the canonical code (one entry per code) */
  id: string;
  name: string;
  code: string;
  seed: number;
  gen: number;
  /** ms since epoch */
  created: number;
  lastPlayed: number;
}

export interface WorldsStore {
  v: 1;
  last: string | null;
  worlds: SavedWorld[];
}

export function emptyWorlds(): WorldsStore {
  return { v: 1, last: null, worlds: [] };
}

function validEntry(e: unknown): e is SavedWorld {
  if (!e || typeof e !== 'object') return false;
  const w = e as Record<string, unknown>;
  if (typeof w.id !== 'string' || typeof w.name !== 'string' || typeof w.code !== 'string') return false;
  if (typeof w.seed !== 'number' || typeof w.gen !== 'number' || typeof w.created !== 'number' || typeof w.lastPlayed !== 'number') return false;
  const d = decodeSeed(w.code, [w.gen]);
  return d.ok && d.seed === w.seed >>> 0 && d.version === w.gen && w.id === d.code;
}

/** Reads the store; any parse / shape problem yields an empty or filtered store, never a throw. */
export function loadWorlds(storage: Storage | null): WorldsStore {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(WORLDS_KEY) ?? null;
  } catch {
    return emptyWorlds();
  }
  if (!raw) return emptyWorlds();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyWorlds();
  }
  if (!data || typeof data !== 'object' || (data as { v?: unknown }).v !== 1 || !Array.isArray((data as { worlds?: unknown }).worlds)) return emptyWorlds();
  const d = data as { last?: unknown; worlds: unknown[] };
  const seen = new Set<string>();
  const worlds: SavedWorld[] = [];
  for (const e of d.worlds) {
    if (!validEntry(e) || seen.has(e.id)) continue;
    seen.add(e.id);
    worlds.push({ id: e.id, name: cleanName(e.name) || defaultName(e.code), code: e.code, seed: e.seed >>> 0, gen: e.gen, created: e.created, lastPlayed: e.lastPlayed });
    if (worlds.length >= MAX_WORLDS) break;
  }
  const last = typeof d.last === 'string' && seen.has(d.last) ? d.last : null;
  return { v: 1, last, worlds };
}

/** Writes the store; false when storage is unavailable or full. */
export function saveWorlds(storage: Storage | null, store: WorldsStore): boolean {
  if (!storage) return false;
  try {
    storage.setItem(WORLDS_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_WORLD_NAME);
}

/** "World K7Q2" — the first half of the code. */
export function defaultName(code: string): string {
  return `World ${code.slice(0, 4)}`;
}

/**
 * Records that a world was played (adds it as "World XXXX" if new) and makes it the last one. Returns a new
 * store; the oldest-played entries beyond MAX_WORLDS are dropped.
 */
export function recordPlayed(store: WorldsStore, seed: number, gen: number, now: number): { store: WorldsStore; world: SavedWorld } {
  if (!SUPPORTED_GEN_VERSIONS.includes(gen)) throw new RangeError(`Unsupported generator version ${gen}`);
  const code = encodeSeed(seed, gen);
  const existing = store.worlds.find((w) => w.id === code);
  const world: SavedWorld = existing ? { ...existing, lastPlayed: now } : { id: code, name: defaultName(code), code, seed: seed >>> 0, gen, created: now, lastPlayed: now };
  let worlds = [world, ...store.worlds.filter((w) => w.id !== code)];
  if (worlds.length > MAX_WORLDS) worlds = [...worlds].sort((a, b) => b.lastPlayed - a.lastPlayed || a.id.localeCompare(b.id)).slice(0, MAX_WORLDS);
  return { store: { v: 1, last: code, worlds }, world };
}

/** Renames a world; empty names are rejected (returns the store unchanged). */
export function renameWorld(store: WorldsStore, id: string, name: string): WorldsStore {
  const clean = cleanName(name);
  if (!clean || !store.worlds.some((w) => w.id === id)) return store;
  return { ...store, worlds: store.worlds.map((w) => (w.id === id ? { ...w, name: clean } : w)) };
}

export function deleteWorld(store: WorldsStore, id: string): WorldsStore {
  return { v: 1, last: store.last === id ? null : store.last, worlds: store.worlds.filter((w) => w.id !== id) };
}

/** Saved worlds, most recently played first. */
export function worldsByRecent(store: WorldsStore): SavedWorld[] {
  return [...store.worlds].sort((a, b) => b.lastPlayed - a.lastPlayed || a.id.localeCompare(b.id));
}

export function lastPlayedWorld(store: WorldsStore): SavedWorld | null {
  return store.worlds.find((w) => w.id === store.last) ?? null;
}
