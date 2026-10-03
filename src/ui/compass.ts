/**
 * Compass maths for the outdoor HUD. World axes: +X east, −Z north (the Training pilot stands at the south
 * edge looking north), +Y up. Headings and bearings are compass degrees, clockwise from north, in [0, 360).
 */

/** Degrees of heading the compass tape shows across its full width. */
export const TAPE_SPAN_DEG = 120;
/** Markers further off the nose than this sit pinned at the tape's edge. */
export const TAPE_EDGE_DEG = TAPE_SPAN_DEG / 2 - 4;

const RAD = 180 / Math.PI;

export function wrap360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d === 0 ? 0 : d;
}

/** (−180, 180]: signed turn from one heading to another (+ = to the right). */
export function wrap180(deg: number): number {
  const d = wrap360(deg);
  return d > 180 ? d - 360 : d;
}

/**
 * Heading of the drone's nose (body −Z) from its orientation quaternion. NaN when the nose points (almost)
 * straight up or down, where heading is undefined: the caller keeps the last value.
 */
export function headingFromQuat(q: { x: number; y: number; z: number; w: number }): number {
  const east = -2 * (q.x * q.z + q.w * q.y);
  const north = 1 - 2 * (q.x * q.x + q.y * q.y);
  if (east * east + north * north < 1e-6) return Number.NaN;
  return wrap360(Math.atan2(east, north) * RAD);
}

/** Compass bearing from one ground point to another. */
export function bearingDeg(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return wrap360(Math.atan2(toX - fromX, fromZ - toZ) * RAD);
}

export function groundDistance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

/** Strip translation (% of the tape width) that puts `heading` under the centre line. */
export function tapeOffsetPct(heading: number): number {
  return 50 - (wrap360(heading) / TAPE_SPAN_DEG) * 100;
}

/** Marker position along the tape (% from the left) for a bearing, and whether it is pinned to an edge. */
export function tapeMarker(bearing: number, heading: number): { pct: number; pinned: boolean } {
  const rel = wrap180(bearing - heading);
  const c = Math.max(-TAPE_EDGE_DEG, Math.min(TAPE_EDGE_DEG, rel));
  return { pct: 50 + (c / TAPE_SPAN_DEG) * 100, pinned: c !== rel };
}

const CARDINALS: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

/**
 * Tick marks for the tape strip, every 15° over [−180°, 540°] so any heading ± half the span is covered without
 * wrapping. Positions are % of the tape width (the strip is as wide as the tape and translated).
 */
export function tapeTicks(): { pct: number; label: string; major: boolean }[] {
  const out: { pct: number; label: string; major: boolean }[] = [];
  for (let d = -180; d <= 540; d += 15) {
    const w = wrap360(d);
    const label = CARDINALS[w] ?? (w % 30 === 0 ? String(w).padStart(3, '0') : '');
    out.push({ pct: (d / TAPE_SPAN_DEG) * 100, label, major: w % 45 === 0 });
  }
  return out;
}

/** "045" — the heading box text. */
export function headingText(heading: number): string {
  return String(Math.round(wrap360(heading)) % 360).padStart(3, '0');
}
