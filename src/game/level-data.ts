/**
 * Single source of truth for the loft level: physics colliders and render meshes are both
 * built from this data, so what the pilot sees is exactly what the drone can hit.
 */
import type { Collider, PropDef, RingDef, RoomLevelData } from '../types';

type V3 = [number, number, number];

function boxProp(id: string, kind: PropDef['kind'], position: V3, size: V3, yaw = 0, collide = true): PropDef {
  const colliders: Collider[] = collide
    ? [{ id, shape: { kind: 'box', center: [position[0], position[1] + size[1] / 2, position[2]], half: [size[0] / 2, size[1] / 2, size[2] / 2], yaw } }]
    : [];
  return { id, kind, position, size, yaw, colliders };
}

function pillar(id: string, x: number, z: number, diameter: number, height: number): PropDef {
  return {
    id,
    kind: 'pillar',
    position: [x, 0, z],
    size: [diameter, height, diameter],
    colliders: [{ id, shape: { kind: 'cylinder', center: [x, height / 2, z], radius: diameter / 2, halfHeight: height / 2 } }],
  };
}

function ring(i: number, position: V3, direction: V3, radius = 0.75): RingDef {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  return {
    id: `ring-${i}`,
    position,
    direction: [direction[0] / len, direction[1] / len, direction[2] / len],
    radius,
    tube: 0.07,
  };
}

const ROOM_H = 6;

const props: PropDef[] = [
  pillar('pillar-nw', -4.5, -2, 0.5, ROOM_H),
  pillar('pillar-sw', -4.5, 2.5, 0.5, ROOM_H),
  pillar('pillar-ne', 4.5, -2, 0.5, ROOM_H),
  pillar('pillar-se', 4.5, 2.5, 0.5, ROOM_H),

  // Ceiling beams (along z) and a duct (along x)
  boxProp('beam-w', 'beam', [-8, 5.45, 0], [0.3, 0.4, 14]),
  boxProp('beam-c', 'beam', [0, 5.45, 0], [0.3, 0.4, 14]),
  boxProp('beam-e', 'beam', [8, 5.45, 0], [0.3, 0.4, 14]),
  boxProp('duct-n', 'duct', [0, 4.75, -6.3], [22, 0.5, 0.5]),

  // Living area (south-east)
  boxProp('sofa', 'sofa', [6.2, 0, 5.9], [2.4, 0.85, 0.95], Math.PI),
  boxProp('coffee-table', 'table', [3.2, 0, 4.9], [1.2, 0.42, 0.6]),
  boxProp('rug', 'rug', [4.5, 0, 4.4], [4.2, 0.01, 2.8], 0, false),
  boxProp('tv-wall', 'tv-wall', [6.2, 1.2, -6.9], [2.2, 1.25, 0.08]),
  boxProp('plant-se', 'plant', [10.9, 0, 6.2], [0.6, 1.3, 0.6]),

  // Storage (north)
  boxProp('shelf-nw', 'shelf', [-9, 0, -6.6], [2.2, 2.2, 0.45]),
  boxProp('shelf-nc', 'shelf', [-1.5, 0, -6.6], [2.2, 2.2, 0.45]),
  boxProp('crate-1', 'crate', [8.6, 0, -1], [0.8, 0.8, 0.8], 0.2),
  boxProp('crate-2', 'crate', [8.6, 0.8, -1], [0.8, 0.8, 0.8], -0.15),
  boxProp('crate-3', 'crate', [9.5, 0, -1.2], [0.8, 0.8, 0.8], 0.05),
  boxProp('crate-4', 'crate', [-10.6, 0, -2.5], [0.8, 0.8, 0.8], 0.3),

  // Lighting practicals
  {
    id: 'lamp-floor-w',
    kind: 'lamp-floor',
    position: [-11, 0, -5],
    size: [0.45, 1.8, 0.45],
    colliders: [{ id: 'lamp-floor-w', shape: { kind: 'cylinder', center: [-11, 0.9, -5], radius: 0.2, halfHeight: 0.9 } }],
  },
  ...([
    [-1.2, 4.3, -2.2],
    [0, 4.0, -2.6],
    [1.1, 4.4, -1.9],
    [6.5, 3.6, 4.6],
    [5.5, 3.8, 5.1],
    [-9, 3.9, 4.4],
  ] as V3[]).map<PropDef>((p, i) => ({
    id: `bulb-${i}`,
    kind: 'bulb-hanging',
    position: p,
    size: [0.14, ROOM_H - p[1], 0.14],
    colliders: [{ id: `bulb-${i}`, shape: { kind: 'box', center: [p[0], p[1] + 0.1, p[2]], half: [0.07, 0.12, 0.07] } }],
  })),

  // Ceiling fan: blades are a kinematic collider animated by the physics world.
  {
    id: 'fan',
    kind: 'fan',
    position: [3.5, 5.25, 1],
    size: [1.8, 0.3, 1.8],
    colliders: [{ id: 'fan', dynamic: 'fan', shape: { kind: 'cylinder', center: [3.5, 5.25, 1], radius: 0.9, halfHeight: 0.04 } }],
  },
];

const rings: RingDef[] = [
  ring(0, [-9, 1.5, 1], [0, 0, -1]),
  ring(1, [-7.5, 2.2, -3.8], [0.5, 0, -0.85]),
  ring(2, [-2, 1.3, -5.2], [1, 0, 0]),
  ring(3, [3, 2.6, -4.6], [1, 0.1, 0.1]),
  ring(4, [8.5, 3.6, -3.2], [0.6, 0, 0.8]),
  ring(5, [9.8, 1.3, 1.8], [0, -0.25, 1]),
  ring(6, [5.6, 0.9, 3.4], [-1, 0, 0]),
  ring(7, [1, 2, 2.8], [-1, 0.2, -0.2]),
  ring(8, [-3, 3, 1.2], [0, 1, 0]),
  ring(9, [-7, 4.3, -0.5], [-1, 0, 0]),
  ring(10, [-10.3, 2.2, 1.8], [0, -0.2, 1]),
  ring(11, [-6.5, 1.4, 4.6], [1, 0, 0]),
];

export const LOFT_LEVEL: RoomLevelData = {
  name: 'Night Loft',
  room: {
    size: [24, ROOM_H, 14],
    windows: [
      { wall: 'north', center: [-6, 3.9], size: [3, 2.6] },
      { wall: 'north', center: [2.5, 3.9], size: [3, 2.6] },
      { wall: 'east', center: [0, 3.2], size: [4.5, 3.2] },
      { wall: 'south', center: [0, 3.2], size: [5, 3] },
    ],
  },
  props,
  rings,
  spawn: { position: [-9, 0.06, 5.8], yaw: 0 },
  pilot: [-11.3, 1.7, 6.5],
};

/** Ring colliders (rims) so the frame of a gate is solid, like a real race gate. */
export function ringColliders(level: { rings: readonly RingDef[] }): Collider[] {
  return level.rings.map((r) => ({
    id: r.id,
    restitution: 0.3,
    shape: { kind: 'torus', center: r.position, normal: r.direction, majorRadius: r.radius + r.tube, tubeRadius: r.tube },
  }));
}

/** All static + kinematic colliders of a level (room shell planes / ground are handled by PhysicsWorld). */
export function levelColliders(level: { props: readonly PropDef[]; rings: readonly RingDef[]; statics?: readonly Collider[] }): Collider[] {
  return [...level.props.flatMap((p) => p.colliders), ...(level.statics ?? []), ...ringColliders(level)];
}
