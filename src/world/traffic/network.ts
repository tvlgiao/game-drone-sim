/**
 * Lane network the traffic simulation drives on: directed edges (lanes between intersections, connectors through
 * them, rural road lanes) with sampled centre-line geometry, successors and the signal guarding each lane's end.
 * Pure data plus allocation-free evaluation of a point / heading at an arc length.
 */

export const EDGE_LANE = 0;
export const EDGE_CONNECTOR = 1;
export const TURN = { straight: 0, right: 1, left: 2 } as const;

export interface Edge {
  readonly id: number;
  readonly kind: typeof EDGE_LANE | typeof EDGE_CONNECTOR;
  /** centre-line samples (x, z, and y when the lane follows terrain) with their cumulative arc length */
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly py: Float64Array | null;
  readonly ps: Float64Array;
  readonly length: number;
  /** successor edges and the turn each one is (TURN), parallel arrays */
  readonly next: number[];
  readonly turns: number[];
  /** signalled node at the end of a lane (−1: none) and the approach the lane arrives on */
  readonly node: number;
  readonly approach: number;
  /** connectors: the lane they leave (conflict group); lanes: −1 */
  readonly from: number;
  /** connectors: the turn they make (TURN) */
  readonly turn: number;
  /** speed limit, m/s */
  readonly limit: number;
  /** centre of the edge (spawn selection) */
  readonly midX: number;
  readonly midZ: number;
}

export interface Network {
  readonly edges: readonly Edge[];
  /** lanes cars may spawn on */
  readonly spawnable: readonly number[];
  /** signalled nodes: their centre and the approaches present */
  readonly nodes: readonly { x: number; z: number; approaches: number[] }[];
}

export function makeEdge(
  id: number,
  kind: Edge['kind'],
  xs: readonly number[],
  zs: readonly number[],
  ys: readonly number[] | null,
  o: { node?: number; approach?: number; from?: number; turn?: number; limit: number },
): Edge {
  const n = xs.length;
  const px = Float64Array.from(xs);
  const pz = Float64Array.from(zs);
  const py = ys ? Float64Array.from(ys) : null;
  const ps = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = px[i]! - px[i - 1]!;
    const dz = pz[i]! - pz[i - 1]!;
    ps[i] = ps[i - 1]! + Math.sqrt(dx * dx + dz * dz);
  }
  const length = ps[n - 1]!;
  let midX = 0;
  let midZ = 0;
  const half = length / 2;
  for (let i = 1; i < n; i++) {
    if (ps[i]! >= half) {
      const t = (half - ps[i - 1]!) / Math.max(1e-9, ps[i]! - ps[i - 1]!);
      midX = px[i - 1]! + (px[i]! - px[i - 1]!) * t;
      midZ = pz[i - 1]! + (pz[i]! - pz[i - 1]!) * t;
      break;
    }
  }
  return { id, kind, px, pz, py, ps, length, next: [], turns: [], node: o.node ?? -1, approach: o.approach ?? -1, from: o.from ?? -1, turn: o.turn ?? 0, limit: o.limit, midX, midZ };
}

/** Quadratic Bézier from p0 via c to p1, sampled at `n` + 1 points. */
export function bezierSamples(p0x: number, p0z: number, cx: number, cz: number, p1x: number, p1z: number, n: number): { xs: number[]; zs: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    xs.push(a * p0x + b * cx + c * p1x);
    zs.push(a * p0z + b * cz + c * p1z);
  }
  return { xs, zs };
}

/** Point on `e` at arc length `s` (clamped) → out[0..2] = x, y, z; returns the segment index used. */
export function pointAt(e: Edge, s: number, out: Float64Array | number[], hint = 0): number {
  const ps = e.ps;
  const n = ps.length;
  if (s <= 0) {
    out[0] = e.px[0]!;
    out[1] = e.py ? e.py[0]! : 0;
    out[2] = e.pz[0]!;
    return 0;
  }
  if (s >= e.length) {
    out[0] = e.px[n - 1]!;
    out[1] = e.py ? e.py[n - 1]! : 0;
    out[2] = e.pz[n - 1]!;
    return n - 2;
  }
  let i = hint > 0 && hint < n - 1 && ps[hint]! <= s ? hint : 0;
  if (n > 16 && i === 0) {
    // binary search on long polylines (rural roads)
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ps[mid]! <= s) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  while (i < n - 2 && ps[i + 1]! < s) i++;
  const t = (s - ps[i]!) / Math.max(1e-9, ps[i + 1]! - ps[i]!);
  out[0] = e.px[i]! + (e.px[i + 1]! - e.px[i]!) * t;
  out[1] = e.py ? e.py[i]! + (e.py[i + 1]! - e.py[i]!) * t : 0;
  out[2] = e.pz[i]! + (e.pz[i + 1]! - e.pz[i]!) * t;
  return i;
}
