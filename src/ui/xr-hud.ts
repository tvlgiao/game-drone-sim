/**
 * Text of the in-headset card for each game state, with Quest Touch button hints.
 * Menu buttons in VR: A = primary, X = secondary, B = leave VR (see main.ts handleXrMenu).
 */
import type { XrPanelContent } from '../render/xr-panel';
import type { CameraMode, FlightMode, RaceSnapshot } from '../types';
import { formatTime } from './format';

export interface XrHudState {
  race: RaceSnapshot;
  armed: boolean;
  /** armed but the centring throttle is still latched at the bottom */
  latched: boolean;
  mode: FlightMode;
  camera: CameraMode;
  altitude: number;
  speed: number;
  /** transient message (toast) shown instead of the hint line, '' for none */
  toast: string;
}

const CAM: Record<CameraMode, string> = { fpv: 'FPV', chase: 'CHASE', los: 'LOS' };
const CYAN = '#7fe3ff';
const GREEN = '#7dffb0';
const RED = '#ff7a6b';
const AMBER = '#ffc861';

export function xrHudContent(s: XrHudState): XrPanelContent {
  const r = s.race;
  const flightLine = `${s.armed ? 'ARMED' : 'DISARMED'} · ${s.mode.toUpperCase()} · ${CAM[s.camera]} · ${s.altitude.toFixed(1)} m`;
  const flightHint = !s.armed ? 'A arm · B mode · stick click cam · Y pause' : s.latched ? 'Push throttle up to take off' : 'A disarm · X reset · Y pause';
  const hint = (h: string): string => s.toast || h;
  switch (r.status) {
    case 'menu':
      return { layout: 'menu', title: 'DRONE SIM VR', sub: r.bestTime !== null ? `Best ${formatTime(r.bestTime)}` : 'Night Loft', hint: hint('A Race · X Free fly · B Exit VR'), accent: CYAN };
    case 'paused':
      return { layout: 'menu', title: 'PAUSED', sub: 'L-stick click recentre · L-trigger arrow', hint: hint('A Resume · X Menu · B Exit VR'), accent: AMBER };
    case 'finished':
      return { layout: 'menu', title: `FINISH ${formatTime(r.time)}`, sub: r.bestTime !== null ? `Best ${formatTime(r.bestTime)}` : '', hint: hint('A Retry · X Menu · B Exit VR'), accent: GREEN };
    case 'countdown':
      return { layout: 'hud', title: r.countdown > 0 ? String(Math.ceil(r.countdown)) : 'GO', sub: flightLine, hint: hint(flightHint), accent: AMBER };
    case 'crashed':
      return { layout: 'hud', title: 'CRASHED', sub: 'Respawning…', hint: hint(''), accent: RED };
    case 'freefly':
      return { layout: 'hud', title: `FREE FLY · ${s.speed.toFixed(1)} m/s`, sub: flightLine, hint: hint(flightHint), accent: s.armed ? GREEN : CYAN };
    case 'racing':
    default:
      return { layout: 'hud', title: `${formatTime(r.time)} · Ring ${Math.min(r.nextRing + 1, r.totalRings)}/${r.totalRings}`, sub: flightLine, hint: hint(flightHint), accent: s.armed ? GREEN : CYAN };
  }
}
