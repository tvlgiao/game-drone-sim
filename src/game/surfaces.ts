/**
 * Walkable top surfaces of a level (ground, static box-prop tops, rugs / painted pads): what the drone lands on.
 * Shared by the contact shadow and checkpoint respawns, which set the drone down on the surface
 * below the checkpoint instead of leaving it disarmed in mid-air.
 */
import type { PropDef, TerrainField } from '../types';

export interface TopSurface {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  top: number;
}

/** Height of the highest walkable surface at (x, z) that is not above `y`. */
export interface SurfaceProvider {
  topBelow(x: number, y: number, z: number): number;
}

/** Flat decals the drone can sit on: their size y is the surface height. */
const FLAT_DECALS: ReadonlySet<PropDef['kind']> = new Set(['rug', 'pad']);

export function buildSurfaces(level: { props: readonly PropDef[] }): TopSurface[] {
  const out: TopSurface[] = [];
  for (const p of level.props) {
    for (const c of p.colliders) {
      if (c.shape.kind !== 'box' || c.dynamic) continue;
      if (p.kind === 'bulb-hanging' || p.kind === 'beam' || p.kind === 'duct') continue;
      const s = c.shape;
      const yaw = s.yaw ?? 0;
      out.push({ cx: s.center[0], cz: s.center[2], hx: s.half[0], hz: s.half[2], cos: Math.cos(yaw), sin: Math.sin(yaw), top: s.center[1] + s.half[1] });
    }
    if (FLAT_DECALS.has(p.kind)) out.push({ cx: p.position[0], cz: p.position[2], hx: p.size[0] / 2, hz: p.size[2] / 2, cos: 1, sin: 0, top: p.position[1] + p.size[1] });
  }
  return out;
}

/** Highest surface top at (x, z) that is not above `y`, starting from `ground` (0 = floor). */
export function surfaceBelow(surfaces: readonly TopSurface[], x: number, y: number, z: number, ground = 0): number {
  let top = ground;
  for (const s of surfaces) {
    if (s.top > y || s.top <= top) continue;
    const dx = x - s.cx;
    const dz = z - s.cz;
    // world -> local = R_y(-yaw)
    const lx = s.cos * dx - s.sin * dz;
    const lz = s.sin * dx + s.cos * dz;
    if (Math.abs(lx) <= s.hx && Math.abs(lz) <= s.hz) top = s.top;
  }
  return top;
}

/** Surface provider over prop tops on the ground (y = 0) or on a terrain height field. */
export function createSurfaces(props: readonly PropDef[], terrain: TerrainField | null = null): SurfaceProvider {
  const tops = buildSurfaces({ props });
  return {
    topBelow: (x, y, z) => surfaceBelow(tops, x, y, z, terrain ? terrain.heightAt(x, z) : 0),
  };
}
