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
