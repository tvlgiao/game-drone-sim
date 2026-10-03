/**
 * CC0 PBR texture sets (Poly Haven, 1K, re-encoded to WebP by scripts/fetch-cc0-textures.py). Vite
 * emits each map as a hashed asset, so the web build, its offline worker and the native apps all
 * carry them; nothing is fetched until a level that uses a set is loaded on a tier with pbrTextures.
 */
import type { LevelId } from '../../types';

export type Cc0SetId = 'concrete' | 'brick' | 'wood' | 'plaster' | 'asphalt' | 'grass' | 'bark' | 'rock' | 'soil';
export type PbrMapName = 'albedo' | 'normal' | 'arm';

export interface Cc0Set {
  /** folder under ./cc0 and the Poly Haven asset slug */
  slug: string;
  title: string;
  authors: string;
  /** real-world edge length of one tile (m): materials set UV repeat from it */
  tileMeters: number;
}

export const CC0_SETS: Readonly<Record<Cc0SetId, Cc0Set>> = {
  concrete: { slug: 'concrete_floor_worn_001', title: 'Concrete Floor Worn 001', authors: 'Dimitrios Savva, Rico Cilliers', tileMeters: 3 },
  brick: { slug: 'red_brick', title: 'Red Brick', authors: 'Rob Tuytel', tileMeters: 1.4 },
  wood: { slug: 'wood_floor', title: 'Wood Floor', authors: 'Dimitrios Savva', tileMeters: 1.7 },
  asphalt: { slug: 'asphalt_02', title: 'Asphalt 02', authors: 'Rob Tuytel', tileMeters: 3 },
  plaster: { slug: 'painted_plaster_wall', title: 'Painted Plaster Wall', authors: 'Amal Kumar', tileMeters: 2 },
  grass: { slug: 'leafy_grass', title: 'Leafy Grass', authors: 'Charlotte Baglioni', tileMeters: 2 },
  bark: { slug: 'bark_brown_02', title: 'Bark Brown 02', authors: 'Rob Tuytel', tileMeters: 1 },
  // an aerial scan (50 m in reality): mountain faces seen from a drone read at this scale
  rock: { slug: 'aerial_rocks_02', title: 'Aerial Rocks 02', authors: 'Rob Tuytel', tileMeters: 50 },
  soil: { slug: 'forest_ground_04', title: 'Forest Ground 04', authors: 'Rico Cilliers, Rob Tuytel', tileMeters: 3.15 },
};

/** Sets each level may load (the Quest budget test sums these per level). */
export const LEVEL_TEXTURE_SETS: Readonly<Partial<Record<LevelId, readonly Cc0SetId[]>>> = {
  'night-loft': ['concrete', 'brick', 'wood', 'plaster'],
  training: ['grass', 'asphalt', 'bark'],
  alpine: ['grass', 'rock', 'soil'],
  infinite: ['grass', 'rock', 'soil'],
  city: ['concrete', 'brick'],
};

const URLS = import.meta.glob<string>('./cc0/*/*.webp', { eager: true, query: '?url', import: 'default' });

/** Built URL of one map of a set (undefined if the file is missing from the build). */
export function cc0Url(id: Cc0SetId, map: PbrMapName): string | undefined {
  return URLS[`./cc0/${CC0_SETS[id].slug}/${map}.webp`];
}

/** Credit lines for the licences file and the About screen (CC0 asks for none; we give it anyway). */
export function cc0Credits(): string[] {
  return Object.values(CC0_SETS).map((s) => `${s.title} by ${s.authors} — https://polyhaven.com/a/${s.slug} (CC0 1.0)`);
}
