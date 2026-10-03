/**
 * LOS pilot placement on the large outdoor levels: the pilot starts within LOS range of the first ring (City,
 * Alpine, Infinite), and a re-planted City pilot stands clear of every collider (never inside a building) and
 * sees the drone past the buildings. The sight and body checks here are independent of the rig's own: a 0.25 m
 * ray march against the collider grid and a column test against every collider near the pilot.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, PILOT_EYE_HEIGHT, RELOCATE_OCCLUDED_SECONDS, RELOCATE_RANGE } from '../../src/render/camera-rig';
import { createDroneState } from '../../src/physics/physics-world';
import { cityRuntime } from '../../src/levels/city';
import { alpineLevel, ALPINE_SEED } from '../../src/levels/alpine';
import { infiniteLevel } from '../../src/levels/infinite';
import { createWorld, GEN_VERSION } from '../../src/world/world';
import type { GridCollider } from '../../src/physics/collider-grid';
import type { ColliderShape, OutdoorLevel } from '../../src/types';
import type { LevelRuntime } from '../../src/levels/runtime';

const DT = 1 / 60;
/** the pilot starts within this distance (m) of the first ring */
const START_RANGE = 150;

const startRange = (def: OutdoorLevel): number => new THREE.Vector3(...def.pilot).distanceTo(new THREE.Vector3(...def.rings[0]!.position));

describe('LOS pilot starts within range of the first ring', () => {
  it('City', () => {
    const def = cityRuntime().def as OutdoorLevel;
    expect(startRange(def)).toBeLessThanOrEqual(START_RANGE);
  });
  it('Alpine Valley', () => {
    expect(startRange(alpineLevel(createWorld({ seed: ALPINE_SEED, preset: 'alpine', genVersion: GEN_VERSION })))).toBeLessThanOrEqual(START_RANGE);
  });
  it('Infinite World (Seed Run), several seeds', () => {
    for (const seed of [1, 42, 0x2468ace0, 0xdeadbeef, 777]) {
      expect(startRange(infiniteLevel(createWorld({ seed, preset: 'infinite', genVersion: GEN_VERSION }))), `seed ${seed}`).toBeLessThanOrEqual(START_RANGE);
    }
  });
});

function inside(s: ColliderShape, p: THREE.Vector3, m = 0): boolean {
  if (s.kind === 'box') {
    const yaw = s.yaw ?? 0;
    const dx = p.x - s.center[0];
    const dz = p.z - s.center[2];
    const lx = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
    const lz = Math.sin(yaw) * dx + Math.cos(yaw) * dz;
    return Math.abs(lx) <= s.half[0] + m && Math.abs(p.y - s.center[1]) <= s.half[1] && Math.abs(lz) <= s.half[2] + m;
  }
  if (s.kind === 'cylinder') return Math.hypot(p.x - s.center[0], p.z - s.center[2]) <= s.radius + m && Math.abs(p.y - s.center[1]) <= s.halfHeight;
  return false;
}

/** 0.25 m ray march eye → drone against the grid's boxes (the last 0.3 m at the drone left out). */
function sightClear(rt: LevelRuntime, eye: THREE.Vector3, drone: THREE.Vector3): boolean {
  const found: GridCollider[] = [];
  const n = rt.grid!.query(Math.min(eye.x, drone.x), Math.min(eye.y, drone.y), Math.min(eye.z, drone.z), Math.max(eye.x, drone.x), Math.max(eye.y, drone.y), Math.max(eye.z, drone.z), found);
  const len = eye.distanceTo(drone);
  const p = new THREE.Vector3();
  for (let s = 0.25; s < len - 0.3; s += 0.25) {
    p.lerpVectors(eye, drone, s / len);
    if (p.y < (rt.terrain?.heightAt(p.x, p.z) ?? 0)) return false;
    for (let i = 0; i < n; i++) if (found[i]!.shape.kind === 'box' && inside(found[i]!.shape, p)) return false;
  }
  return true;
}

/** Every collider near the pilot stays clear of the body (feet → eye, 0.3 m around; standing on a roof is fine). */
function bodyClear(rt: LevelRuntime, eye: THREE.Vector3): boolean {
  const found: GridCollider[] = [];
  const n = rt.grid!.query(eye.x - 1, eye.y - PILOT_EYE_HEIGHT, eye.z - 1, eye.x + 1, eye.y + 0.2, eye.z + 1, found);
  const p = new THREE.Vector3();
  for (let h = 0.1; h <= PILOT_EYE_HEIGHT + 0.2; h += 0.1) {
    p.set(eye.x, eye.y - PILOT_EYE_HEIGHT + h, eye.z);
    for (let i = 0; i < n; i++) if (inside(found[i]!.shape, p, 0.3)) return false;
  }
  return true;
}

/** Deterministic drone spots over the City: every ring, plus streets and roofs (2–40 m over the surface). */
function citySpots(rt: LevelRuntime): THREE.Vector3[] {
  const out = rt.def.rings.map((r) => new THREE.Vector3(...r.position));
  let s = 12345;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  while (out.length < 160) {
    const x = (rnd() - 0.5) * 1150;
    const z = (rnd() - 0.5) * 1150;
    const top = rt.surfaces.topBelow(x, 400, z);
    out.push(new THREE.Vector3(x, top + 2 + rnd() * 38, z));
  }
  return out;
}

describe('City LOS pilot relocation', () => {
  const rt = cityRuntime();
  const def = rt.def as OutdoorLevel;

  it('the start spot is on the street, clear of every collider, and sees the take-off and the first ring', () => {
    const eye = new THREE.Vector3(...def.pilot);
    expect(eye.y).toBeCloseTo((rt.terrain?.heightAt(eye.x, eye.z) ?? 0) + PILOT_EYE_HEIGHT, 6);
    expect(bodyClear(rt, eye)).toBe(true);
    expect(sightClear(rt, eye, new THREE.Vector3(...def.spawn.position).setY(def.spawn.position[1] + 0.5))).toBe(true);
    expect(sightClear(rt, eye, new THREE.Vector3(...def.rings[0]!.position))).toBe(true);
  });

  it('out of range or hidden behind buildings: re-planted clear of every collider, seeing the drone', () => {
    let moved = 0;
    for (const spot of citySpots(rt)) {
      const rig = new CameraRig(def.pilot, null);
      rig.setLevel(rt);
      const d = createDroneState();
      d.position.copy(spot);
      d.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.x * 0.01);
      let t = 0;
      rig.update({ dt: DT, time: t, drone: d, mode: 'chase', cameraTiltDeg: 25, fovDeg: 110, speed: 0, instant: true });
      while (t < RELOCATE_OCCLUDED_SECONDS + 0.2 && rig.relocations === 0) {
        rig.update({ dt: DT, time: (t += DT), drone: d, mode: 'chase', cameraTiltDeg: 25, fovDeg: 110, speed: 0 });
      }
      const eye = rig.pilotEye;
      const start = new THREE.Vector3(...def.pilot);
      const far = start.distanceTo(spot) > RELOCATE_RANGE;
      if (far) expect(rig.relocations, `far spot ${spot.toArray()}`).toBeGreaterThan(0);
      if (rig.relocations === 0) {
        // left alone only when the start spot already sees the drone
        expect(sightClear(rt, start, spot), `stayed at ${spot.toArray()}`).toBe(true);
        continue;
      }
      moved++;
      expect(bodyClear(rt, eye), `pilot ${eye.toArray()} for drone ${spot.toArray()}`).toBe(true);
      expect(sightClear(rt, eye, spot), `pilot ${eye.toArray()} sees drone ${spot.toArray()}`).toBe(true);
      expect(eye.distanceTo(spot)).toBeLessThan(RELOCATE_RANGE);
    }
    expect(moved).toBeGreaterThan(100);
  });
});
