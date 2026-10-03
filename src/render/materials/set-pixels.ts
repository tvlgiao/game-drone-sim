/**
 * Pixels of a procedural texture set (albedo, normal, ARM), as plain transferable arrays: the same code builds
 * them on the main thread or in the texture worker (texture-worker.ts), and `setTextures` turns them into
 * DataTextures. DOM-free.
 */
import * as THREE from 'three';
import { BRICK_TILE_M, FLOOR_TILE_M, brickSet, concreteSet, gravelSet, woodSet, type PbrSet } from './generators';
import { generatePbr, type ProceduralKind } from './procedural';
import { texSize } from './texgen';

/** Field-based sets from generators.ts (the rest come from procedural.ts). */
export type GeneratedKind = 'brick' | 'slab' | 'concrete' | 'wood' | 'gravel';
export type SurfaceKind = ProceduralKind | GeneratedKind;

export const GENERATED: Readonly<Record<GeneratedKind, { tileMeters: number; minSize: number; make: (size: number, anisotropy: number) => PbrSet }>> = {
  brick: { tileMeters: BRICK_TILE_M, minSize: 512, make: (s, a) => brickSet(s, a) },
  slab: { tileMeters: FLOOR_TILE_M, minSize: 512, make: (s, a) => concreteSet(s, a) },
  concrete: { tileMeters: 2, minSize: 256, make: (s, a) => concreteSet(s, a, { seed: 8, joints: false, rough: 0.78 }) },
  wood: { tileMeters: 1, minSize: 256, make: (s, a) => woodSet(s, a) },
  gravel: { tileMeters: 1.2, minSize: 256, make: (s, a) => gravelSet(s, a) },
};

export const isGenerated = (k: SurfaceKind): k is GeneratedKind => k in GENERATED;
/** leaf-cluster / needle cards: single sprites, clamped at the edge */
export const isCard = (k: SurfaceKind): boolean => k === 'foliage' || k === 'needles';

export interface MapPixels {
  data: Uint8Array;
  width: number;
  height: number;
  srgb: boolean;
}

export interface SetPixels {
  kind: SurfaceKind;
  albedo: MapPixels;
  normal: MapPixels;
  arm: MapPixels;
}

/** Edge length of a kind's set at the profile's texture size (brick and slab keep their texels on real tiers). */
export function setSize(kind: SurfaceKind, textureSize: number): number {
  const ts = textureSize;
  if (isGenerated(kind)) return texSize(1024, ts < 64 ? ts : Math.max(GENERATED[kind].minSize, ts));
  return isCard(kind) ? Math.min(512, Math.max(ts < 64 ? ts : 256, ts)) : ts;
}

const fromTexture = (t: THREE.DataTexture): MapPixels => ({
  data: t.image.data as Uint8Array,
  width: t.image.width,
  height: t.image.height,
  srgb: t.colorSpace === THREE.SRGBColorSpace,
});

/** Generates a kind's three maps at the profile's texture size. */
export function setPixels(kind: SurfaceKind, textureSize: number): SetPixels {
  const size = setSize(kind, textureSize);
  if (isGenerated(kind)) {
    const s = GENERATED[kind].make(size, 1);
    return { kind, albedo: fromTexture(s.map), normal: fromTexture(s.normalMap), arm: fromTexture(s.orm) };
  }
  const px = generatePbr(kind, size);
  return {
    kind,
    albedo: { data: px.albedo.data, width: px.albedo.width, height: px.albedo.height, srgb: true },
    normal: { data: px.normal.data, width: px.normal.width, height: px.normal.height, srgb: false },
    arm: { data: px.arm.data, width: px.arm.width, height: px.arm.height, srgb: false },
  };
}

function texture(p: MapPixels, clamp: boolean, anisotropy: number): THREE.DataTexture {
  const t = new THREE.DataTexture(p.data, p.width, p.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = p.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** DataTextures of a generated set (repeat wrapping, mipmapped; cards clamp). */
export function setTextures(px: SetPixels, anisotropy: number): { albedo: THREE.DataTexture; normal: THREE.DataTexture; arm: THREE.DataTexture } {
  const clamp = isCard(px.kind);
  return { albedo: texture(px.albedo, clamp, anisotropy), normal: texture(px.normal, clamp, anisotropy), arm: texture(px.arm, clamp, anisotropy) };
}

/** The buffers to transfer from the worker. */
export function transferables(px: SetPixels): ArrayBuffer[] {
  return [px.albedo.data.buffer as ArrayBuffer, px.normal.data.buffer as ArrayBuffer, px.arm.data.buffer as ArrayBuffer];
}
