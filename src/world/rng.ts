/**
 * Stateless hashing for the world generator. Every random decision is a pure function of
 * (seed, integer cell, stream salt), never a sequential generator, so chunk order and thread do not matter.
 */

/** murmur3 32-bit finalizer. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 32-bit hash of (seed, ix, iz, salt); integer inputs (non-integers are truncated). */
export function hash2(seed: number, ix: number, iz: number, salt: number): number {
  let h = fmix32((seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0);
  h = fmix32((h ^ Math.imul(ix | 0, 0x85ebca77)) >>> 0);
  h = fmix32((h ^ Math.imul(iz | 0, 0xc2b2ae3d)) >>> 0);
  return h;
}

/** 32-bit hash of (seed, i, salt). */
export function hash1(seed: number, i: number, salt: number): number {
  return hash2(seed, i, 0x5bd1e995, salt);
}

/** Uniform [0, 1) from a 32-bit hash. */
export function u01(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** Next hash in a per-item stream: `rehash(h, k)` gives independent draws k = 1, 2, … from one cell hash. */
export function rehash(h: number, k: number): number {
  return fmix32((h ^ Math.imul(k + 1, 0x27d4eb2f)) >>> 0);
}

/** Derived sub-seed for a named generator stream. */
export function subSeed(seed: number, salt: number): number {
  return fmix32((seed ^ Math.imul(salt, 0x2545f491)) >>> 0);
}

/** Stream salts: one per independent feature, so adding a feature never reshuffles the others. */
export const SALT = {
  warpX: 11,
  warpZ: 12,
  continent: 13,
  plains: 14,
  hills: 15,
  mountains: 16,
  river: 17,
  riverMask: 18,
  moisture: 19,
  temperature: 20,
  detail: 21,
  village: 31,
  villageLayout: 32,
  road: 33,
  tree: 41,
  rock: 42,
  farm: 43,
  colour: 44,
  city: 51,
} as const;
