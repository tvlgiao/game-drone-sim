/**
 * The ground as physics, race and camera see it: an analytic height field (no meshes). The world
 * engine's TerrainField satisfies this structurally; flat levels use FLAT_GROUND (y = 0).
 */

export interface HeightField {
  /** ground height (m) at world (x, z); must be finite everywhere and cheap (called every physics step) */
  heightAt(x: number, z: number): number;
  /** water surface height at (x, z); there is water where it is above heightAt. Absent = no water anywhere. */
  waterLevelAt?(x: number, z: number): number;
}

export const FLAT_GROUND: HeightField = { heightAt: () => 0 };

export function isUnderWater(field: HeightField, x: number, z: number): boolean {
  return field.waterLevelAt !== undefined && field.waterLevelAt(x, z) > field.heightAt(x, z);
}

const DRY_DIRECTIONS = 8;
const DRY_STEP = 2;

/**
 * Nearest dry ground to (x, z) along 8 compass directions, out to `maxDist` metres in 2 m steps
 * (rings first, so the closest shore wins). Writes it to `out`; false when every probe is wet.
 */
export function findDryGround(field: HeightField, x: number, z: number, out: { x: number; z: number }, maxDist = 40): boolean {
  if (!isUnderWater(field, x, z)) {
    out.x = x;
    out.z = z;
    return true;
  }
  for (let d = DRY_STEP; d <= maxDist + 1e-9; d += DRY_STEP) {
    for (let k = 0; k < DRY_DIRECTIONS; k++) {
      const a = (k / DRY_DIRECTIONS) * Math.PI * 2;
      const px = x + Math.sin(a) * d;
      const pz = z - Math.cos(a) * d;
      if (!isUnderWater(field, px, pz)) {
        out.x = px;
        out.z = pz;
        return true;
      }
    }
  }
  return false;
}
