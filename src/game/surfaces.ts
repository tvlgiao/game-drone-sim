/**
 * Walkable top surfaces of a level (floor = 0, static box-prop tops, rugs): what the drone lands on.
 * Shared by the contact shadow and checkpoint respawns, which set the drone down on the surface
 * below the checkpoint instead of leaving it disarmed in mid-air.
 */
import type { LevelDef } from '../types';

export interface TopSurface {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  top: number;
}

export function buildSurfaces(level: LevelDef): TopSurface[] {
  const out: TopSurface[] = [];
  for (const p of level.props) {
    for (const c of p.colliders) {
      if (c.shape.kind !== 'box' || c.dynamic) continue;
      if (p.kind === 'bulb-hanging' || p.kind === 'beam' || p.kind === 'duct') continue;
      const s = c.shape;
      const yaw = s.yaw ?? 0;
      out.push({ cx: s.center[0], cz: s.center[2], hx: s.half[0], hz: s.half[2], cos: Math.cos(yaw), sin: Math.sin(yaw), top: s.center[1] + s.half[1] });
    }
    if (p.kind === 'rug') out.push({ cx: p.position[0], cz: p.position[2], hx: p.size[0] / 2, hz: p.size[2] / 2, cos: 1, sin: 0, top: p.size[1] });
  }
  return out;
}

/** Highest surface top at (x, z) that is not above `y` (0 = floor). */
export function surfaceBelow(surfaces: readonly TopSurface[], x: number, y: number, z: number): number {
  let top = 0;
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
