/** Room shell: floor, brick/plaster walls with real window openings, steel windows, ceiling, city backdrop. */
import * as THREE from 'three';
import type { RoomDef } from '../types';
import { StaticBatcher, trs } from './batcher';
import type { Materials } from './materials';

export interface WindowInfo {
  wall: 'north' | 'south' | 'east' | 'west';
  /** world-space opening corners: bl, br, tr, tl (as seen from inside) */
  corners: THREE.Vector3[];
  center: THREE.Vector3;
  /** unit normal pointing into the room */
  inward: THREE.Vector3;
  width: number;
  height: number;
}

const WALL_T = 0.35;

interface WallFrame {
  /** maps (u, y, depth-outward) to world */
  point(u: number, y: number, d: number, out: THREE.Vector3): THREE.Vector3;
  yaw: number;
  length: number;
  inward: THREE.Vector3;
}

function wallFrame(wall: WindowInfo['wall'], sx: number, sz: number): WallFrame {
  const hx = sx / 2;
  const hz = sz / 2;
  switch (wall) {
    case 'north':
      return { point: (u, y, d, o) => o.set(u, y, -hz - d), yaw: 0, length: sx, inward: new THREE.Vector3(0, 0, 1) };
    case 'south':
      return { point: (u, y, d, o) => o.set(-u, y, hz + d), yaw: Math.PI, length: sx, inward: new THREE.Vector3(0, 0, -1) };
    case 'east':
      return { point: (u, y, d, o) => o.set(hx + d, y, u), yaw: -Math.PI / 2, length: sz, inward: new THREE.Vector3(-1, 0, 0) };
    case 'west':
      return { point: (u, y, d, o) => o.set(-hx - d, y, -u), yaw: Math.PI / 2, length: sz, inward: new THREE.Vector3(1, 0, 0) };
  }
}

const _v = new THREE.Vector3();

export function buildRoom(room: RoomDef, mats: Materials, batch: StaticBatcher): WindowInfo[] {
  const [sx, sy, sz] = room.size;
  const windows: WindowInfo[] = [];

  // Floor (receives only) and ceiling.
  const floor = new THREE.PlaneGeometry(sx, sz);
  floor.rotateX(-Math.PI / 2);
  batch.add('floor', mats.floor, floor, trs(0, 0, 0), { uvTile: 4, castShadow: false });
  const ceil = new THREE.BoxGeometry(sx + WALL_T * 2, 0.3, sz + WALL_T * 2);
  batch.add('ceiling', mats.ceiling, ceil, trs(0, sy + 0.15, 0), { uvTile: 3 });

  const walls: WindowInfo['wall'][] = ['north', 'east', 'south', 'west'];
  const brickWalls = new Set<WindowInfo['wall']>(['north', 'west']);
  for (const wall of walls) {
    const f = wallFrame(wall, sx, sz);
    const key = brickWalls.has(wall) ? 'brick' : 'plaster';
    const mat = brickWalls.has(wall) ? mats.brick : mats.plaster;
    const tile = brickWalls.has(wall) ? 1.2 : 3;
    const half = f.length / 2 + (wall === 'north' || wall === 'south' ? WALL_T : 0);
    const wins = room.windows
      .filter((w) => w.wall === wall)
      .map((w) => {
        // south/west frames mirror u so we keep the def's world-axis convention (x for N/S, z for E/W)
        const u = wall === 'south' || wall === 'west' ? -w.center[0] : w.center[0];
        return { u0: u - w.size[0] / 2, u1: u + w.size[0] / 2, y0: w.center[1] - w.size[1] / 2, y1: w.center[1] + w.size[1] / 2, def: w };
      })
      .sort((a, b) => a.u0 - b.u0);
    let cursor = -half;
    const box = (u0: number, u1: number, y0: number, y1: number) => {
      if (u1 - u0 < 1e-3 || y1 - y0 < 1e-3) return;
      const g = new THREE.BoxGeometry(u1 - u0, y1 - y0, WALL_T);
      f.point((u0 + u1) / 2, (y0 + y1) / 2, WALL_T / 2, _v);
      batch.add(key, mat, g, trs(_v.x, _v.y, _v.z, f.yaw), { uvTile: tile });
    };
    for (const w of wins) {
      box(cursor, w.u0, 0, sy);
      box(w.u0, w.u1, 0, w.y0);
      box(w.u0, w.u1, w.y1, sy);
      cursor = w.u1;
      buildWindow(f, w.u0, w.u1, w.y0, w.y1, mats, batch);
      const corners = [
        f.point(w.u0, w.y0, 0, new THREE.Vector3()),
        f.point(w.u1, w.y0, 0, new THREE.Vector3()),
        f.point(w.u1, w.y1, 0, new THREE.Vector3()),
        f.point(w.u0, w.y1, 0, new THREE.Vector3()),
      ];
      windows.push({
        wall,
        corners,
        center: f.point((w.u0 + w.u1) / 2, (w.y0 + w.y1) / 2, 0, new THREE.Vector3()),
        inward: f.inward.clone(),
        width: w.u1 - w.u0,
        height: w.y1 - w.y0,
      });
    }
    box(cursor, half, 0, sy);

    // Baseboard and a steel ledge line near the top (wall-flush, 2 cm).
    const bb = new THREE.BoxGeometry(f.length, 0.12, 0.02);
    f.point(0, 0.06, -0.01, _v);
    batch.add('steelBlack', mats.steelBlack, bb, trs(_v.x, _v.y, _v.z, f.yaw), { castShadow: false });

    // City backdrop outside walls that have windows.
    if (wins.length > 0) {
      const dist = 16;
      const w = f.length + 40;
      const h = 30;
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const uOff = wall === 'north' ? 0 : wall === 'east' ? 0.42 : 0.2;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uOff + uv.getX(i) * 0.55);
      f.point(0, 1.5, dist, _v);
      batch.add('skyline', mats.skyline, g, trs(_v.x, _v.y, _v.z, f.yaw), { castShadow: false });
    }
  }

  // Neon sign on the west brick wall (visible from spawn / pilot).
  const neon = new THREE.PlaneGeometry(2.6, 0.65);
  batch.add('neon', mats.neon, neon, trs(-sx / 2 + 0.03, 3.3, 0.6, Math.PI / 2), { castShadow: false });
  const neonBack = new THREE.BoxGeometry(2.8, 0.85, 0.02);
  batch.add('steelBlack', mats.steelBlack, neonBack, trs(-sx / 2 + 0.01, 3.3, 0.6, Math.PI / 2), { castShadow: false });

  return windows;
}

/** Industrial steel window: outer frame, mullion grid, sill, single glass sheet. */
function buildWindow(f: WallFrame, u0: number, u1: number, y0: number, y1: number, mats: Materials, batch: StaticBatcher): void {
  const w = u1 - u0;
  const h = y1 - y0;
  const depth = 0.12;
  const d = WALL_T * 0.45;
  const bar = (uc: number, yc: number, bw: number, bh: number, bd = 0.07) => {
    const g = new THREE.BoxGeometry(bw, bh, bd);
    f.point(uc, yc, d, _v);
    batch.add('steelDark', mats.steelDark, g, trs(_v.x, _v.y, _v.z, f.yaw));
  };
  const fw = 0.08;
  bar((u0 + u1) / 2, y0 + fw / 2, w, fw, depth);
  bar((u0 + u1) / 2, y1 - fw / 2, w, fw, depth);
  bar(u0 + fw / 2, (y0 + y1) / 2, fw, h, depth);
  bar(u1 - fw / 2, (y0 + y1) / 2, fw, h, depth);
  const cols = Math.max(2, Math.round(w / 0.75));
  const rows = Math.max(2, Math.round(h / 0.62));
  for (let c = 1; c < cols; c++) bar(u0 + (w * c) / cols, (y0 + y1) / 2, 0.035, h - fw);
  for (let r = 1; r < rows; r++) bar((u0 + u1) / 2, y0 + (h * r) / rows, w - fw, 0.035);
  // concrete sill across the full wall depth (flush with interior plane)
  const sill = new THREE.BoxGeometry(w + 0.1, 0.05, WALL_T);
  f.point((u0 + u1) / 2, y0 - 0.025, WALL_T / 2, _v);
  batch.add('concrete', mats.concrete, sill, trs(_v.x, _v.y, _v.z, f.yaw), { uvTile: 2 });
  const glass = new THREE.PlaneGeometry(w - fw, h - fw);
  f.point((u0 + u1) / 2, (y0 + y1) / 2, d + 0.01, _v);
  batch.add('glass', mats.glass, glass, trs(_v.x, _v.y, _v.z, f.yaw), { castShadow: false });
}
