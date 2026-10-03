/**
 * Loft shell: polished slab, reclaimed brick (north / west) and painted brick (east / south) with real
 * window openings, riveted steel factory windows with dirty glass, timber deck ceiling, a sliding barn
 * door, conduit runs, the neon sign and wall / floor decals. Everything on a wall stays within 5 cm of it
 * (the room shell is a hard plane in physics), so nothing visible sticks out where the drone can fly.
 */
import * as THREE from 'three';
import type { RoomDef } from '../types';
import { StaticBatcher, trs } from './batcher';
import { BRICK_TILE_M, FLOOR_TILE_M } from './env-materials/loft-textures';
import { WOOD, type LoftMaterials } from './env-materials/loft-materials';
import { DECAL } from './env-materials/loft-canvas';
import { IDENTITY, cable, decalPlane, finish, rod } from './loft/dress';

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

export function wallFrame(wall: WindowInfo['wall'], sx: number, sz: number): WallFrame {
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
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Sliding door on the east wall (u range along the wall, metres). */
const DOOR = { wall: 'east' as const, u0: -6.3, u1: -3.9, h: 3.0 };

export function buildRoom(room: RoomDef, mats: LoftMaterials, batch: StaticBatcher): WindowInfo[] {
  const [sx, sy, sz] = room.size;
  const windows: WindowInfo[] = [];

  const floor = new THREE.PlaneGeometry(sx, sz);
  floor.rotateX(-Math.PI / 2);
  batch.add('floor', mats.floor, floor, trs(0, 0, 0), { uvTile: FLOOR_TILE_M });
  const ceil = new THREE.BoxGeometry(sx + WALL_T * 2, 0.3, sz + WALL_T * 2);
  batch.add('wood', mats.wood, ceil, trs(0, sy + 0.15, 0), { uvTile: 1.1, color: WOOD.deck });

  const walls: WindowInfo['wall'][] = ['north', 'east', 'south', 'west'];
  const brickWalls = new Set<WindowInfo['wall']>(['north', 'west']);
  for (const wall of walls) {
    const f = wallFrame(wall, sx, sz);
    const red = brickWalls.has(wall);
    const key = red ? 'brick' : 'paintedBrick';
    const mat = red ? mats.brick : mats.paintedBrick;
    const half = f.length / 2 + (wall === 'north' || wall === 'south' ? WALL_T : 0);
    const wins = room.windows
      .filter((w) => w.wall === wall)
      .map((w) => {
        // south/west frames mirror u so we keep the def's world-axis convention (x for N/S, z for E/W)
        const u = wall === 'south' || wall === 'west' ? -w.center[0] : w.center[0];
        return { u0: u - w.size[0] / 2, u1: u + w.size[0] / 2, y0: w.center[1] - w.size[1] / 2, y1: w.center[1] + w.size[1] / 2, def: w };
      })
      .sort((a, b) => a.u0 - b.u0);
    const box = (u0: number, u1: number, y0: number, y1: number) => {
      if (u1 - u0 < 1e-3 || y1 - y0 < 1e-3) return;
      const g = new THREE.BoxGeometry(u1 - u0, y1 - y0, WALL_T);
      f.point((u0 + u1) / 2, (y0 + y1) / 2, WALL_T / 2, _v);
      batch.add(key, mat, g, trs(_v.x, _v.y, _v.z, f.yaw), { uvTile: BRICK_TILE_M });
    };
    let cursor = -half;
    for (const w of wins) {
      box(cursor, w.u0, 0, sy);
      box(w.u0, w.u1, 0, w.y0);
      box(w.u0, w.u1, w.y1, sy);
      cursor = w.u1;
      buildWindow(f, w.u0, w.u1, w.y0, w.y1, mats, batch);
      // rain has run down the brick under every sill
      wallDecal(batch, mats, f, DECAL.waterStain, (w.u0 + w.u1) / 2, w.y0 - 0.95, Math.min(2.4, w.u1 - w.u0), 1.8);
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

    // steel skirting and a conduit run under the ceiling, with junction boxes
    const bb = new THREE.BoxGeometry(f.length, 0.14, 0.018);
    f.point(0, 0.07, -0.009, _v);
    batch.add('props', mats.props, bb, trs(_v.x, _v.y, _v.z, f.yaw), finish('steelBlack'));
    const cy = sy - 0.22;
    f.point(-f.length / 2 + 0.2, cy, -0.03, _a);
    f.point(f.length / 2 - 0.2, cy, -0.03, _b);
    batch.add('props', mats.props, rod(_a, _b, 0.011), IDENTITY, finish('galvanized'));
    for (let u = -f.length / 2 + 1.6; u < f.length / 2 - 1; u += 3.2) {
      f.point(u, cy, -0.035, _v);
      batch.add('props', mats.props, new THREE.BoxGeometry(0.11, 0.11, 0.05), trs(_v.x, _v.y, _v.z, f.yaw), finish('galvanized'));
      f.point(u + 0.4, cy, -0.012, _v);
      batch.add('props', mats.props, new THREE.BoxGeometry(0.03, 0.045, 0.024), trs(_v.x, _v.y, _v.z, f.yaw), finish('galvanized'));
    }
  }

  buildDoor(wallFrame(DOOR.wall, sx, sz), mats, batch);
  buildSwitches(wallFrame('west', sx, sz), mats, batch, sy);
  buildNeon(wallFrame('west', sx, sz), mats, batch);
  buildDecals(sx, sz, mats, batch);
  return windows;
}

/** Decal on a wall: centre (u, y), size w × h, 5 mm proud of the plaster. */
function wallDecal(batch: StaticBatcher, mats: LoftMaterials, f: WallFrame, cell: number, u: number, y: number, w: number, h: number, roll = 0): void {
  f.point(u, y, -0.005, _v);
  batch.add('decals', mats.decals, decalPlane(cell, w, h), trs(_v.x, _v.y, _v.z, f.yaw, 1, 1, 1, 0, roll), { castShadow: false });
}

/** Decal on the floor: centre (x, z), size, rotation about Y. */
function floorDecal(batch: StaticBatcher, mats: LoftMaterials, cell: number, x: number, z: number, w: number, h: number, yaw = 0, y = 0.003): void {
  const g = decalPlane(cell, w, h);
  g.rotateX(-Math.PI / 2);
  batch.add('decals', mats.decals, g, trs(x, y, z, yaw), { castShadow: false });
}

/** Industrial steel window: deep outer frame, T-bar mullions with glazing beads, concrete sill, dirty glass. */
function buildWindow(f: WallFrame, u0: number, u1: number, y0: number, y1: number, mats: LoftMaterials, batch: StaticBatcher): void {
  const w = u1 - u0;
  const h = y1 - y0;
  const d = WALL_T * 0.45;
  const steel = finish('steelDark');
  const bar = (uc: number, yc: number, bw: number, bh: number, bd: number, dd = d) => {
    const g = new THREE.BoxGeometry(bw, bh, bd);
    f.point(uc, yc, dd, _v);
    batch.add('props', mats.props, g, trs(_v.x, _v.y, _v.z, f.yaw), steel);
  };
  const fw = 0.09;
  const depth = 0.14;
  bar((u0 + u1) / 2, y0 + fw / 2, w, fw, depth);
  bar((u0 + u1) / 2, y1 - fw / 2, w, fw, depth);
  bar(u0 + fw / 2, (y0 + y1) / 2, fw, h, depth);
  bar(u1 - fw / 2, (y0 + y1) / 2, fw, h, depth);
  // reveal liners: steel angle wrapping the opening, so the brick end-grain is not seen through the glass
  bar((u0 + u1) / 2, y0 + 0.004, w, 0.008, WALL_T - 0.02, WALL_T / 2);
  bar((u0 + u1) / 2, y1 - 0.004, w, 0.008, WALL_T - 0.02, WALL_T / 2);
  const cols = Math.max(2, Math.round(w / 0.75));
  const rows = Math.max(2, Math.round(h / 0.62));
  for (let c = 1; c < cols; c++) {
    const uc = u0 + (w * c) / cols;
    bar(uc, (y0 + y1) / 2, 0.04, h - fw, 0.075);
    bar(uc, (y0 + y1) / 2, 0.012, h - fw, 0.11, d - 0.02);
  }
  for (let r = 1; r < rows; r++) {
    const yc = y0 + (h * r) / rows;
    bar((u0 + u1) / 2, yc, w - fw, 0.04, 0.075);
    bar((u0 + u1) / 2, yc, w - fw, 0.012, 0.11, d - 0.02);
  }
  const sill = new THREE.BoxGeometry(w + 0.12, 0.06, WALL_T + 0.02);
  f.point((u0 + u1) / 2, y0 - 0.03, WALL_T / 2 - 0.01, _v);
  batch.add('concrete', mats.concrete, sill, trs(_v.x, _v.y, _v.z, f.yaw), { uvTile: 1.5 });
  const glass = new THREE.PlaneGeometry(w - fw, h - fw);
  const uv = glass.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * cols, uv.getY(i) * rows);
  f.point((u0 + u1) / 2, (y0 + y1) / 2, d + 0.01, _v);
  batch.add('glass', mats.glass, glass, trs(_v.x, _v.y, _v.z, f.yaw), { castShadow: false });
}

/** Steel-framed timber barn door on its top track, slid half open over the painted brick (≤ 5 cm proud). */
function buildDoor(f: WallFrame, mats: LoftMaterials, batch: StaticBatcher): void {
  const { u0, u1, h } = DOOR;
  const w = u1 - u0;
  const uc = (u0 + u1) / 2;
  // the dark doorway the slab has slid off
  f.point(uc - 0.55, h / 2, -0.004, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(w - 1.1, h - 0.1, 0.006), trs(_v.x, _v.y, _v.z, f.yaw), finish('rubber'));
  // slab
  const du = uc + 0.35;
  f.point(du, h / 2 + 0.02, -0.025, _v);
  batch.add('wood', mats.wood, new THREE.BoxGeometry(w, h - 0.04, 0.04), trs(_v.x, _v.y, _v.z, f.yaw), { uvTile: 0.9, color: WOOD.walnut });
  const strap = (cu: number, cy: number, bw: number, bh: number, roll = 0) => {
    f.point(cu, cy, -0.047, _v);
    batch.add('props', mats.props, new THREE.BoxGeometry(bw, bh, 0.006), trs(_v.x, _v.y, _v.z, f.yaw, 1, 1, 1, 0, roll), finish('steelBlack'));
  };
  strap(du, 0.08, w, 0.12);
  strap(du, h - 0.08, w, 0.12);
  strap(du - w / 2 + 0.06, h / 2, 0.12, h - 0.1);
  strap(du + w / 2 - 0.06, h / 2, 0.12, h - 0.1);
  const diag = Math.hypot(w - 0.2, h - 0.3);
  strap(du, h / 2, diag, 0.1, Math.atan2(h - 0.3, w - 0.2));
  // bolts on the straps
  for (const [bu, by] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    f.point(du + bu * (w / 2 - 0.06), h / 2 + by * (h / 2 - 0.08), -0.05, _v);
    batch.add('props', mats.props, new THREE.CylinderGeometry(0.014, 0.014, 0.012, 8).rotateX(Math.PI / 2), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelBlack'));
  }
  // handle
  f.point(du - w / 2 + 0.22, 1.1, -0.045, _a);
  f.point(du - w / 2 + 0.22, 1.5, -0.045, _b);
  batch.add('props', mats.props, rod(_a, _b, 0.012, 8), IDENTITY, finish('steelBlack'));
  // track rail + rollers
  f.point(uc + 0.2, h + 0.12, -0.02, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(w * 2.1, 0.06, 0.012), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelBlack'));
  for (const ru of [du - w / 2 + 0.3, du + w / 2 - 0.3]) {
    f.point(ru, h + 0.12, -0.035, _v);
    batch.add('props', mats.props, new THREE.CylinderGeometry(0.07, 0.07, 0.025, 16).rotateX(Math.PI / 2), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelDark'));
  }
  // exit sign over the doorway: housing + green neon face
  f.point(uc - 0.55, h + 0.45, -0.03, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(0.62, 0.24, 0.05), trs(_v.x, _v.y, _v.z, f.yaw), finish('plasticDark'));
  f.point(uc - 0.55, h + 0.45, -0.056, _v);
  batch.add('neon', mats.neon, neonQuad(0, 0, 0.5, 0.5, 0.56, 0.28), trs(_v.x, _v.y, _v.z, f.yaw), { color: [0.4, 3.2, 1.1], castShadow: false });
  f.point(uc - 0.55, h + 0.3, -0.008, _v);
  batch.add('spill', mats.spill, new THREE.PlaneGeometry(1.4, 0.9), trs(_v.x, _v.y, _v.z, f.yaw), { color: [0.05, 0.35, 0.14], castShadow: false });
}

/** Light switches and an electrical panel next to the pilot's corner (west wall). */
function buildSwitches(f: WallFrame, mats: LoftMaterials, batch: StaticBatcher, sy: number): void {
  const panelU = 2.4;
  f.point(panelU, 1.6, -0.03, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(0.42, 0.62, 0.06), trs(_v.x, _v.y, _v.z, f.yaw), finish('galvanized'));
  f.point(panelU + 0.12, 1.75, -0.062, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(0.03, 0.08, 0.006), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelBlack'));
  f.point(panelU, 1.91, -0.025, _a);
  f.point(panelU, sy - 0.22, -0.025, _b);
  batch.add('props', mats.props, rod(_a, _b, 0.011), IDENTITY, finish('galvanized'));
  for (let i = 0; i < 3; i++) {
    f.point(panelU + 0.55 + i * 0.1, 1.35, -0.012, _v);
    batch.add('props', mats.props, new THREE.BoxGeometry(0.08, 0.12, 0.024), trs(_v.x, _v.y, _v.z, f.yaw), finish('ceramic'));
    f.point(panelU + 0.55 + i * 0.1, 1.35 + (i === 1 ? -0.012 : 0.012), -0.028, _v);
    batch.add('props', mats.props, new THREE.BoxGeometry(0.014, 0.03, 0.012), trs(_v.x, _v.y, _v.z, f.yaw), finish('brass'));
  }
}

/** Neon atlas sub-rect (u0, v0, u1, v1 in 0..1) on a w × h quad facing +Z. */
function neonQuad(u0: number, v0: number, u1: number, v1: number, w: number, h: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
  return g;
}

/** "FPV" neon on the west brick wall: backing rail, standoffs, transformer, tubes and the pink spill on the brick. */
function buildNeon(f: WallFrame, mats: LoftMaterials, batch: StaticBatcher): void {
  // west frame: u = -z
  const u = -0.6;
  const y = 3.3;
  f.point(u, y, -0.012, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(2.7, 0.8, 0.012), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelBlack'));
  for (const [i, du] of [-1.1, -0.35, 0.4, 1.15].entries()) {
    f.point(u + du, y + (i % 2 === 0 ? 0.18 : -0.18), -0.03, _v);
    batch.add('props', mats.props, new THREE.CylinderGeometry(0.008, 0.008, 0.03, 6).rotateX(Math.PI / 2), trs(_v.x, _v.y, _v.z, f.yaw), finish('galvanized'));
  }
  f.point(u + 1.55, y - 0.62, -0.035, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(0.22, 0.14, 0.06), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelDark'));
  f.point(u + 1.55, y - 0.55, -0.02, _a);
  f.point(u + 1.2, y - 0.3, -0.02, _b);
  batch.add('props', mats.props, cable(_a, _b, 0.05, 0.004), IDENTITY, finish('rubber'));
  f.point(u, y, -0.042, _v);
  batch.add('neon', mats.neon, neonQuad(0, 0.5, 1, 1, 2.75, 0.69), trs(_v.x, _v.y, _v.z, f.yaw), { color: [5, 0.55, 3.1], castShadow: false });
  f.point(u, y, -0.008, _v);
  batch.add('spill', mats.spill, new THREE.PlaneGeometry(5.2, 3.2), trs(_v.x, _v.y, _v.z, f.yaw), { color: [0.3, 0.035, 0.2], castShadow: false });
  // "OPEN" in teal by the pilot's corner
  f.point(-5.2, 2.35, -0.03, _v);
  batch.add('props', mats.props, new THREE.BoxGeometry(0.95, 0.36, 0.02), trs(_v.x, _v.y, _v.z, f.yaw), finish('steelBlack'));
  f.point(-5.2, 2.35, -0.042, _v);
  batch.add('neon', mats.neon, neonQuad(0.5, 0, 1, 0.5, 0.92, 0.46), trs(_v.x, _v.y, _v.z, f.yaw), { color: [0.4, 2.6, 3.2], castShadow: false });
  f.point(-5.2, 2.35, -0.008, _v);
  batch.add('spill', mats.spill, new THREE.PlaneGeometry(2.2, 1.6), trs(_v.x, _v.y, _v.z, f.yaw), { color: [0.02, 0.16, 0.2], castShadow: false });
}

/** Posters, stencils, stains and marks: the lived-in layer. */
function buildDecals(sx: number, sz: number, mats: LoftMaterials, batch: StaticBatcher): void {
  const north = wallFrame('north', sx, sz);
  const east = wallFrame('east', sx, sz);
  const south = wallFrame('south', sx, sz);
  const west = wallFrame('west', sx, sz);
  wallDecal(batch, mats, north, DECAL.posterRace, -3.55, 1.75, 0.8, 0.8, 0.02);
  wallDecal(batch, mats, north, DECAL.noSmoking, 0.3, 2.1, 0.55, 0.55);
  wallDecal(batch, mats, north, DECAL.posterClub, 8.9, 1.75, 0.75, 0.75, -0.03);
  wallDecal(batch, mats, north, DECAL.blueprint, 10.5, 1.65, 0.7, 0.7, 0.01);
  wallDecal(batch, mats, north, DECAL.tag, 4.6, 0.55, 1.1, 1.1);
  wallDecal(batch, mats, west, DECAL.posterWave, 4.1, 1.7, 0.8, 0.8, -0.02);
  wallDecal(batch, mats, west, DECAL.scuffs, -3.5, 0.35, 1.4, 0.7);
  wallDecal(batch, mats, east, DECAL.loadLimit, 3.6, 5.3, 1.3, 1.3);
  wallDecal(batch, mats, east, DECAL.scuffs, -2.8, 0.35, 1.6, 0.6);
  wallDecal(batch, mats, south, DECAL.blueprint, -6.5, 1.8, 0.75, 0.75, 0.02);
  wallDecal(batch, mats, south, DECAL.posterWave, 8.6, 1.85, 0.7, 0.7);

  // landing mat at the spawn, a taped pilot box, and wear on the slab
  floorDecal(batch, mats, DECAL.landingMat, -9, 5.8, 1.05, 1.05, 0, 0.004);
  const tape = (x: number, z: number, len: number, yaw: number) => floorDecal(batch, mats, DECAL.hazardTape, x, z, len, len * 0.32, yaw);
  tape(-10.6, 5.6, 1.5, 0);
  tape(-10.6, 4.9, 0.5, 0);
  tape(-9.9, 5.35, 0.9, Math.PI / 2);
  floorDecal(batch, mats, DECAL.oil, 9.1, 0.4, 1.6, 1.6, 0.4);
  floorDecal(batch, mats, DECAL.oil, -4.2, -4.8, 1.1, 1.1, 1.2);
  floorDecal(batch, mats, DECAL.tireMarks, 8.8, -4.6, 3.2, 3.2, Math.PI / 2 + 0.2);
  floorDecal(batch, mats, DECAL.scuffs, -1.5, -5.4, 2, 2, 0.3);
  floorDecal(batch, mats, DECAL.scuffs, 2.5, 1.5, 2.4, 2.4, 1.1);
  floorDecal(batch, mats, DECAL.scuffs, -6, 1.5, 2.2, 2.2, 2.4);
  floorDecal(batch, mats, DECAL.splatter, -2.1, -4.3, 1.2, 1.2, 0.8);
  floorDecal(batch, mats, DECAL.splatter, 10.7, -6.3, 0.9, 0.9, 2.1);
}

export { DOOR };
