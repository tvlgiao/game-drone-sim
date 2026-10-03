/**
 * DOM-free logic behind the Worlds screen (design 07 §6): the "Enter seed or code" field status, random
 * seeds, recording plays in the saved-worlds store, share links and the `?world=` deep link.
 */
import { lastPlayedWorld, loadWorlds, recordPlayed, saveWorlds, type SavedWorld, type WorldsStore } from '../game/worlds';
import { decodeSeed, encodeSeed, parseSeedInput, type SeedCodeError } from '../world/seed-code';
import { GEN_VERSION, SUPPORTED_GEN_VERSIONS } from '../world/world';

/** Hosted site: the iOS / Android shells share links to it (their own origin is capacitor://). */
export const SITE_URL = 'https://dronesim.coworkgamestudio.com/';
export const WORLD_PARAM = 'world';
export const MAX_SEED_INPUT = 64;

/** A world the UI can start: what `{ type: 'level', id: 'infinite', seed, gen }` carries. */
export interface WorldPick {
  seed: number;
  gen: number;
  code: string;
}

export type FieldTone = 'idle' | 'ok' | 'warn' | 'error';

/** Live verdict on the seed field: `pick` is null whenever Play must stay disabled. */
export interface FieldStatus {
  tone: FieldTone;
  message: string;
  pick: WorldPick | null;
}

const PARTIAL_CODE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{0,3}$/;
const LONG_CODE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{5,}$/;
const BARE_CODE = /^[0-9A-Za-z]{8}$/;
const CODE_CHARS = /[0-9A-HJKMNP-TV-Z]/;
const CODE_ALIASES = /[OIL]/;

const CODE_ERROR: Record<SeedCodeError, string> = {
  length: 'World codes have 8 characters, like K7Q2-9XMF',
  alphabet: 'That character is not used in world codes',
  checksum: 'This code has a typo — check each character',
  version: 'This world needs a newer version of Drone Sim',
};

/** First character of a dashed code that no code can contain (U, or punctuation), for the error message. */
function badCodeChar(text: string): string | null {
  for (const ch of text.replace('-', '').toUpperCase()) if (!CODE_CHARS.test(ch) && !CODE_ALIASES.test(ch)) return ch;
  return null;
}

const quote = (t: string): string => `“${t.length > 18 ? `${t.slice(0, 17)}…` : t}”`;

/**
 * Status of the "Enter seed or code" field. A dashed code must decode (typos are reported, never hashed), a
 * half-typed one waits, an over-long one is an error; digits are a seed; anything else is hashed (FNV-1a) — an
 * undashed 8-character string that fails its checksum is hashed too, with a warning.
 */
export function seedFieldStatus(text: string, store: WorldsStore | null = null): FieldStatus {
  const t = text.trim();
  if (!t) return { tone: 'idle', message: 'A code like K7Q2-9XMF, a number or any word', pick: null };
  if (PARTIAL_CODE.test(t)) {
    const n = 9 - t.length;
    return { tone: 'idle', message: `Keep typing — ${n} more character${n === 1 ? '' : 's'}`, pick: null };
  }
  if (LONG_CODE.test(t)) return { tone: 'error', message: CODE_ERROR.length, pick: null };
  const r = parseSeedInput(t, SUPPORTED_GEN_VERSIONS);
  switch (r.kind) {
    case 'empty':
      return { tone: 'idle', message: '', pick: null };
    case 'invalid-code': {
      const ch = r.error === 'alphabet' ? badCodeChar(t) : null;
      return { tone: 'error', message: ch ? `“${ch}” is not used in world codes — check the code` : CODE_ERROR[r.error], pick: null };
    }
    case 'code': {
      const saved = store?.worlds.find((w) => w.id === r.code);
      return { tone: 'ok', message: saved ? `Saved as ${saved.name}` : `World ${r.code}`, pick: { seed: r.seed, gen: r.version, code: r.code } };
    }
    case 'number':
    case 'text': {
      const code = encodeSeed(r.seed, GEN_VERSION);
      const pick = { seed: r.seed, gen: GEN_VERSION, code };
      if (r.kind === 'number') return { tone: 'ok', message: `Seed ${r.seed} → ${code}`, pick };
      if (BARE_CODE.test(t)) return { tone: 'warn', message: `Not a valid code — ${quote(t)} plays as a word → ${code}`, pick };
      return { tone: 'ok', message: `${quote(t)} → ${code}`, pick };
    }
  }
}

/** Uniform uint32 from `crypto.getRandomValues` (injectable for tests). */
export function randomSeed(fill: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a)): number {
  return fill(new Uint32Array(1))[0]! >>> 0;
}

/** Records a play (adds "World XXXX" when new), persists it and returns the saved entry. */
export function playWorld(storage: Storage | null, pick: { seed: number; gen: number }, now: number): SavedWorld {
  const { store, world } = recordPlayed(loadWorlds(storage), pick.seed, pick.gen, now);
  saveWorlds(storage, store);
  return world;
}

/**
 * The world Infinite "Free fly" (and the VR card's level cycle) starts: the last one played, else a new random
 * world. Either way it is recorded as played.
 */
export function resumeOrNewWorld(storage: Storage | null, now: number, seed: () => number = randomSeed): WorldPick {
  const last = lastPlayedWorld(loadWorlds(storage));
  const pick = last ? { seed: last.seed, gen: last.gen } : { seed: seed(), gen: GEN_VERSION };
  const w = playWorld(storage, pick, now);
  return { seed: w.seed, gen: w.gen, code: w.code };
}

/**
 * Share link for a code. Web: the edition the pilot is on (`/play/`, or `/app/` for the Quest store app) under
 * the same site prefix; native shells link the hosted web game.
 */
export function worldShareUrl(code: string, loc: { origin: string; pathname: string }, native: boolean): string {
  const q = `?${WORLD_PARAM}=${encodeURIComponent(code)}`;
  if (native || !/^https?:/.test(loc.origin)) return `${SITE_URL}play/${q}`;
  // the Quest app (/app/) shares the free web game too: anyone can open the link, owner or not
  const m = /^(.*\/)(app|play)\/(?:index\.html)?$/.exec(loc.pathname);
  return m ? `${loc.origin}${m[1]}play/${q}` : `${loc.origin}/play/${q}`;
}

/**
 * The Quest store gate's "Play free on the web" link: the web game, keeping a valid `?world=` from the /app/ URL
 * (as its canonical code, nothing else of the query).
 */
export function gatePlayHref(search: string): string {
  const r = parseWorldParam({ search });
  return r.kind === 'world' ? `../play/?${WORLD_PARAM}=${encodeURIComponent(r.code)}` : '../play/';
}

export type WorldParam = { kind: 'none' } | ({ kind: 'world' } & WorldPick) | { kind: 'error'; error: SeedCodeError; message: string };

/**
 * `?world=K7Q2-9XMF` at boot (or in a Capacitor `appUrlOpen` URL). Accepts a full URL, a search string or a
 * Location. A missing / empty parameter is 'none'; anything that does not decode is an error with the toast text.
 */
export function parseWorldParam(src: string | { search: string }): WorldParam {
  let search: string;
  if (typeof src === 'string') {
    const i = src.indexOf('?');
    search = i >= 0 ? src.slice(i).split('#')[0]! : '';
  } else {
    search = src.search;
  }
  const raw = new URLSearchParams(search).get(WORLD_PARAM);
  if (raw === null || !raw.trim()) return { kind: 'none' };
  const d = decodeSeed(raw.slice(0, 32), SUPPORTED_GEN_VERSIONS);
  if (!d.ok) {
    const message = d.error === 'version' ? 'That world link needs a newer version of Drone Sim' : 'That world link is not valid — check the code';
    return { kind: 'error', error: d.error, message };
  }
  return { kind: 'world', seed: d.seed, gen: d.version, code: d.code };
}

/** The same URL without `?world=` (for `history.replaceState`, so a reload does not re-open the link). */
export function stripWorldParam(href: string): string {
  const u = new URL(href);
  u.searchParams.delete(WORLD_PARAM);
  return u.toString();
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const DTF = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/** "just now", "5 minutes ago", "yesterday", then a date after a week. */
export function lastPlayedText(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return RTF.format(-Math.floor(s / 60), 'minute');
  if (s < 86_400) return RTF.format(-Math.floor(s / 3600), 'hour');
  if (s < 7 * 86_400) return RTF.format(-Math.floor(s / 86_400), 'day');
  return DTF.format(at);
}
