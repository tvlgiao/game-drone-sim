import { describe, expect, it } from 'vitest';
import { ColliderGrid, GRID_CELL, boxTopAt, type GridCollider } from '../../src/physics/collider-grid';
import { shapeBoundingRadius } from '../../src/physics/collision';
import type { Collider } from '../../src/types';
import { box, rng } from './terrain-helpers';

const cyl = (id: string, x: number, y: number, z: number, r = 0.5, hh = 3): Collider => ({ id, shape: { kind: 'cylinder', center: [x, y, z], radius: r, halfHeight: hh } });

function ids(grid: ColliderGrid, min: number[], max: number[]): string[] {
  const out: GridCollider[] = [];
  const n = grid.query(min[0]!, min[1]!, min[2]!, max[0]!, max[1]!, max[2]!, out);
  return out
    .slice(0, n)
    .map((e) => e.id)
    .sort();
}

describe('ColliderGrid ownership', () => {
  it('insertOwned / removeOwner add and drop exactly one owner’s colliders', () => {
    const g = new ColliderGrid();
    g.insertOwned('chunk:0,0', [box('house', [4, 3, 4], [3, 3, 3]), cyl('tree', 10, 3, 10)]);
    g.insertOwned('chunk:1,0', [box('barn', [20, 3, 4], [3, 3, 3])]);
    expect(g.size).toBe(3);
    expect(ids(g, [-50, -50, -50], [50, 50, 50])).toEqual(['barn', 'house', 'tree']);
    expect(g.removeOwner('chunk:0,0')).toBe(true);
    expect(g.size).toBe(1);
    expect(ids(g, [-50, -50, -50], [50, 50, 50])).toEqual(['barn']);
    expect(g.removeOwner('chunk:0,0')).toBe(false);
    expect(g.has('chunk:1,0')).toBe(true);
  });

  it('re-inserting an owner replaces its colliders instead of duplicating them', () => {
    const g = new ColliderGrid();
    g.insertOwned(7, [box('a', [0, 1, 0], [1, 1, 1])]);
    g.insertOwned(7, [box('b', [0, 1, 0], [1, 1, 1])]);
    expect(g.size).toBe(1);
    expect(ids(g, [-5, -5, -5], [5, 5, 5])).toEqual(['b']);
  });

  it('two owners can hold colliders in the same cell; removing one leaves the other', () => {
    const g = new ColliderGrid();
    g.insertOwned('a', [box('a1', [1, 1, 1], [0.5, 0.5, 0.5])]);
    g.insertOwned('b', [box('b1', [2, 1, 1], [0.5, 0.5, 0.5])]);
    g.removeOwner('a');
    expect(ids(g, [0, 0, 0], [3, 3, 3])).toEqual(['b1']);
    g.removeOwner('b');
    expect(ids(g, [-100, -100, -100], [100, 100, 100])).toEqual([]);
    expect(g.size).toBe(0);
  });

  it('a collider spanning many cells is returned once, and removed from all of them', () => {
    const g = new ColliderGrid();
    g.insertOwned('big', [box('hangar', [0, 5, 0], [40, 5, 40])]);
    expect(ids(g, [-60, 0, -60], [60, 10, 60])).toEqual(['hangar']);
    expect(ids(g, [35, 0, 35], [36, 1, 36])).toEqual(['hangar']);
    g.removeOwner('big');
    expect(ids(g, [35, 0, 35], [36, 1, 36])).toEqual([]);
  });

  it('kinematic (fan) colliders are refused outdoors', () => {
    const g = new ColliderGrid();
    expect(() => g.insertOwned('x', [{ ...cyl('fan', 0, 3, 0), dynamic: 'fan' }])).toThrow(/kinematic/);
  });

  it('works at negative coordinates and far from the origin (50 km)', () => {
    const g = new ColliderGrid();
    g.insertOwned('far', [box('w', [-49_990, 1, 49_990], [1, 1, 1]), box('e', [49_990, 1, -49_990], [1, 1, 1])]);
    expect(ids(g, [-50_000, 0, 49_980], [-49_980, 2, 50_000])).toEqual(['w']);
    expect(ids(g, [49_980, 0, -50_000], [50_000, 2, -49_980])).toEqual(['e']);
  });
});

describe('ColliderGrid queries match brute force', () => {
  it('500 random boxes vs 300 colliders (mixed shapes, cell-straddling, yawed)', () => {
    const r = rng(42);
    const g = new ColliderGrid();
    const all: Collider[] = [];
    for (let chunk = 0; chunk < 6; chunk++) {
      const batch: Collider[] = [];
      for (let i = 0; i < 50; i++) {
        const x = (r() - 0.5) * 200;
        const z = (r() - 0.5) * 200;
        const y = r() * 20;
        const id = `c${chunk}-${i}`;
        batch.push(r() < 0.5 ? box(id, [x, y, z], [0.5 + r() * 6, 0.5 + r() * 6, 0.5 + r() * 6], r() * 6) : cyl(id, x, y, z, 0.2 + r() * 4, 0.5 + r() * 8));
      }
      all.push(...batch);
      g.insertOwned(`chunk-${chunk}`, batch);
    }
    // drop one chunk so stale entries would show up
    g.removeOwner('chunk-3');
    const live = all.filter((c) => !c.id.startsWith('c3-'));
    const out: GridCollider[] = [];
    let nonEmpty = 0;
    for (let q = 0; q < 500; q++) {
      const cx = (r() - 0.5) * 220;
      const cz = (r() - 0.5) * 220;
      const cy = r() * 25;
      const hx = r() * (q % 10 === 0 ? 40 : 3);
      const hy = r() * 3;
      const hz = r() * 3;
      const n = g.query(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz, out);
      const got = out
        .slice(0, n)
        .map((e) => e.id)
        .sort();
      const want = live
        .filter((c) => {
          const s = c.shape.center;
          const b = shapeBoundingRadius(c.shape);
          return !(s[0] + b < cx - hx || s[0] - b > cx + hx || s[1] + b < cy - hy || s[1] - b > cy + hy || s[2] + b < cz - hz || s[2] - b > cz + hz);
        })
        .map((c) => c.id)
        .sort();
      expect(got).toEqual(want);
      if (want.length > 0) nonEmpty++;
    }
    // the comparison is not vacuous
    expect(nonEmpty).toBeGreaterThan(100);
  });

  it('a query inside one cell only looks at that cell (neighbours stay out)', () => {
    const g = new ColliderGrid();
    g.insertOwned('o', [box('near', [GRID_CELL / 2, 1, GRID_CELL / 2], [0.5, 0.5, 0.5]), box('next', [GRID_CELL * 1.5, 1, GRID_CELL / 2], [0.5, 0.5, 0.5])]);
    expect(ids(g, [GRID_CELL / 2 - 1, 0, GRID_CELL / 2 - 1], [GRID_CELL / 2 + 1, 2, GRID_CELL / 2 + 1])).toEqual(['near']);
  });
});

describe('boxTopAt', () => {
  it('is the box top inside the yawed footprint, -Infinity outside or for non-boxes', () => {
    const b = box('b', [0, 2, 0], [4, 2, 1], Math.PI / 2).shape;
    // yawed 90°: the long side runs along z
    expect(boxTopAt(b, 0, 3.5)).toBe(4);
    expect(boxTopAt(b, 3.5, 0)).toBe(-Infinity);
    expect(boxTopAt(cyl('c', 0, 0, 0).shape, 0, 0)).toBe(-Infinity);
  });
});
