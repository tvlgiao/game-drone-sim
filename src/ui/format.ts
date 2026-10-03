/** Text formatting for HUD / menus. */

/** 83.456 → "01:23.45"; null/invalid → "--:--.--". */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t) || t < 0) return '--:--.--';
  const cs = Math.floor(t * 100 + 1e-6);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${c < 10 ? '0' : ''}${c}`;
}

/** Signed split delta: 0.42 → "+0.42", -1.3 → "−1.30". */
export function formatDelta(d: number): string {
  const sign = d > 0.004 ? '+' : d < -0.004 ? '−' : '±';
  return `${sign}${Math.abs(d).toFixed(2)}`;
}

export type LengthUnits = 'm' | 'ft';

const FT_PER_M = 3.28084;
const MPH_PER_MS = 2.236936;
const KMH_PER_MS = 3.6;
const FT_PER_MI = 5280;

/** Distance with its unit: 132.4 → "132 m", 2450 → "2.45 km"; feet switch to miles from 1 mi. */
export function formatDistance(m: number, units: LengthUnits): string {
  if (!Number.isFinite(m)) return '—';
  const d = Math.max(0, m);
  if (units === 'ft') {
    const ft = d * FT_PER_M;
    return ft >= FT_PER_MI ? `${(ft / FT_PER_MI).toFixed(ft >= 10 * FT_PER_MI ? 1 : 2)} mi` : `${Math.round(ft)} ft`;
  }
  return d >= 1000 ? `${(d / 1000).toFixed(d >= 10_000 ? 1 : 2)} km` : `${Math.round(d)} m`;
}

/** Height number (AGL / altitude) in the pilot's unit: one decimal below 100, whole numbers above. */
export function heightValue(m: number, units: LengthUnits): string {
  const v = units === 'ft' ? m * FT_PER_M : m;
  return Math.abs(v) < 100 ? v.toFixed(1) : String(Math.round(v));
}

/** Speed number for m/s: km/h with metres, mph with feet. */
export function speedValue(ms: number, units: LengthUnits): string {
  return String(Math.round(ms * (units === 'ft' ? MPH_PER_MS : KMH_PER_MS)));
}

export function speedUnit(units: LengthUnits): string {
  return units === 'ft' ? 'mph' : 'km/h';
}
