/**
 * Gameplay geometry freeze: the scenery can be redressed freely, but what the drone can hit, the rings,
 * the spawn and the pilot spot must not move. The snapshot was recorded before the environment rework.
 */
import { describe, expect, it } from 'vitest';
import { levelColliders } from '../../src/game/level-data';
import { NIGHT_LOFT } from '../../src/levels/night-loft';
import { TRAINING_LEVEL } from '../../src/levels/training';
import type { LevelDef } from '../../src/types';

const round = (v: unknown): unknown =>
  typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : Array.isArray(v) ? v.map(round) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;

function gameplay(level: LevelDef): unknown {
  return round({
    colliders: levelColliders(level),
    props: level.props.map((p) => ({ id: p.id, kind: p.kind, position: p.position, size: p.size, yaw: p.yaw ?? 0 })),
    rings: level.rings,
    spawn: level.spawn,
    pilot: level.pilot,
    bounds: level.bounds,
    room: level.kind === 'indoor' ? level.room : null,
  });
}

describe('gameplay geometry is frozen', () => {
  it('Night Loft colliders, props, rings, spawn and pilot', () => {
    expect(gameplay(NIGHT_LOFT)).toMatchSnapshot();
  });

  it('Training Field colliders, props, rings, spawn and pilot', () => {
    expect(gameplay(TRAINING_LEVEL)).toMatchSnapshot();
  });
});
