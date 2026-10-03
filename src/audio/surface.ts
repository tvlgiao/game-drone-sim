/** Impact surfaces: which crash sound a collider (or the ground under the drone) makes. Pure. */
import type { LevelId } from '../types';
import type { SfxId } from './sfx-bank';

export type Surface = 'concrete' | 'wood' | 'metal' | 'soft' | 'water';

export const CRASH_SFX: Readonly<Record<Surface, SfxId>> = {
  concrete: 'crash-concrete',
  wood: 'crash-wood',
  metal: 'crash-metal',
  soft: 'crash-grass',
  water: 'crash-water',
};

const RULES: readonly [RegExp, Surface][] = [
  [/^ring-/, 'metal'],
  [/tree|^bridge:|^beam|^shelf|^table|^crate|ceiling/, 'wood'],
  [/^(car|light)-|-ac\d|-tank|-antenna|^fan$|^bulb-|^lamp|^duct|^pole|^windsock/, 'metal'],
  [/^sofa|^rug|^plant|^cone/, 'soft'],
  [/^(bld|out)-|^house:|^rock:|^pillar|^wall-|^floor$|^tv-wall/, 'concrete'],
];

/**
 * Surface of a collider id. Ground ('ground' / 'terrain') is `ground` (the caller knows what the ground is
 * made of at that spot: grass, water, snow, road).
 */
export function surfaceOf(colliderId: string, level: LevelId, ground: Surface = 'soft'): Surface {
  if (colliderId === 'ground' || colliderId === 'terrain') return ground;
  if (colliderId === 'floor') return level === 'night-loft' ? 'concrete' : ground;
  for (const [re, s] of RULES) if (re.test(colliderId)) return s;
  return level === 'night-loft' ? 'wood' : 'concrete';
}
