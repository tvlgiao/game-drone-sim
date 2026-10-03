/**
 * Shareable world codes (design 07 §2.6): 8 Crockford base32 characters shown as `K7Q2-9XMF`.
 *
 * 40 bits = 3-bit generator version + 32-bit seed + 5-bit checksum. The design sketch had 4 + 32 + 4, but a
 * 4-bit checksum cannot catch every single-character edit: one character carries 5 bits, so 32 values
 * would share 16 checksums. A full 5-bit check symbol, (Σ odd weight · symbol) mod 32, changes for any edit
 * of one character, because an odd weight times a non-zero difference below 32 is never ≡ 0 (mod 32).
 * Versions 1–7 fit, which leaves generator room for years.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_VERSION = 7;

const DECODE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET[i]!] = i;
// Crockford aliases: O → 0, I / L → 1
DECODE.O = 0;
DECODE.I = 1;
DECODE.L = 1;

export type SeedCodeError = 'length' | 'alphabet' | 'checksum' | 'version';

export type DecodeResult = { ok: true; seed: number; version: number; code: string } | { ok: false; error: SeedCodeError };

function checksum(symbols: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += symbols[i]! * (2 * i + 1);
  return sum % 32;
}

/** Formats a canonical code as `XXXX-XXXX`. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

/** Encodes (seed, generator version) as `XXXX-XXXX`. */
export function encodeSeed(seed: number, version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) throw new RangeError(`version ${version} out of range 1..${MAX_VERSION}`);
  const s = seed >>> 0;
  // 35 data bits: version (3) then seed (32), split into 7 symbols of 5 bits from the top
  const hi = version * 8 + Math.floor(s / 0x20000000); // version + top 3 seed bits (6 bits)
  const lo = s % 0x20000000; // low 29 bits
  const symbols: number[] = [];
  // bits 34..30 → symbol 0: version(3) + seed bits 31..30
  symbols.push(Math.floor(hi / 2));
  // remaining 30 bits: seed bit 29 (hi & 1) then lo (29 bits)
  const rest = (hi % 2) * 0x20000000 + lo;
  const low: number[] = [];
  let r = rest;
  for (let k = 0; k < 6; k++) {
    low.push(r % 32);
    r = Math.floor(r / 32);
  }
  for (let k = 5; k >= 0; k--) symbols.push(low[k]!);
  symbols.push(checksum(symbols));
  return formatCode(symbols.map((v) => ALPHABET[v]).join(''));
}

/**
 * Decodes a code typed by a person: case-insensitive, optional dash / spaces, Crockford aliases (O, I, L).
 * `supported` lists the generator versions this build can play.
 */
export function decodeSeed(input: string, supported: readonly number[] = [1]): DecodeResult {
  const clean = input.replace(/[\s-]/g, '').toUpperCase();
  if (clean.length !== 8) return { ok: false, error: 'length' };
  const symbols: number[] = [];
  for (const ch of clean) {
    const v = DECODE[ch];
    if (v === undefined) return { ok: false, error: 'alphabet' };
    symbols.push(v);
  }
  if (checksum(symbols) !== symbols[7]) return { ok: false, error: 'checksum' };
  const version = symbols[0]! >> 2;
  let rest = 0;
  for (let k = 1; k <= 6; k++) rest = rest * 32 + symbols[k]!;
  const seed = ((symbols[0]! & 3) * 0x40000000 + rest) >>> 0;
  if (!supported.includes(version)) return { ok: false, error: 'version' };
  return { ok: true, seed, version, code: formatCode(symbols.map((v) => ALPHABET[v]).join('')) };
}

/** FNV-1a 32-bit over the UTF-8 bytes of `text`. */
export function fnv1a32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type SeedInput =
  | { kind: 'code'; seed: number; version: number; code: string }
  | { kind: 'number'; seed: number }
  | { kind: 'text'; seed: number }
  | { kind: 'invalid-code'; error: SeedCodeError }
  | { kind: 'empty' };

const CODE_SHAPE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/;
const BARE_CODE = /^[0-9A-Za-z]{8}$/;

/**
 * Interprets the "Enter seed or code" field: a dashed code must be valid (typos are reported, never silently
 * hashed); an undashed 8-character code is used when its checksum matches, else it is text; digits are a
 * uint32 seed; anything else is hashed with FNV-1a.
 */
export function parseSeedInput(input: string, supported: readonly number[] = [1]): SeedInput {
  const t = input.trim();
  if (!t) return { kind: 'empty' };
  if (CODE_SHAPE.test(t)) {
    const r = decodeSeed(t, supported);
    return r.ok ? { kind: 'code', seed: r.seed, version: r.version, code: r.code } : { kind: 'invalid-code', error: r.error };
  }
  if (BARE_CODE.test(t)) {
    const r = decodeSeed(t, supported);
    if (r.ok) return { kind: 'code', seed: r.seed, version: r.version, code: r.code };
  }
  if (/^\d{1,10}$/.test(t) && Number(t) <= 0xffffffff) return { kind: 'number', seed: Number(t) };
  return { kind: 'text', seed: fnv1a32(t) };
}
