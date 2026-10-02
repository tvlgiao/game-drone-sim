/**
 * Text of the in-headset card for each game state, with Quest Touch button hints.
 * Menu buttons in VR: A = primary, X = secondary, B = leave the session (see main.ts handleXrMenu).
 */
import type { XrPanelContent } from '../render/xr-panel';
import type { CameraMode, FlightMode, RaceSnapshot } from '../types';
import { formatTime } from './format';
import type { TutorialView } from './tutorial-prompts';

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
  /**
   * menu hint for B (leave the session). Default 'B Exit VR'; the installed Quest app, which lives in
   * VR, lands on its 2D menu (settings) instead and says so.
   */
  exitHint?: string;
  /** selected level name on the menu card; with it, Y cycles levels */
  level?: string;
}

export const XR_EXIT_HINT = 'B Exit VR';
export const XR_APP_EXIT_HINT = 'B 2D menu';

const CAM: Record<CameraMode, string> = { fpv: 'FPV', chase: 'CHASE', los: 'LOS' };
/** m/s → km/h, the unit of the flat-screen HUD */
const KMH = 3.6;
const CYAN = '#7fe3ff';
const GREEN = '#7dffb0';
const RED = '#ff7a6b';
const AMBER = '#ffc861';

function menuSub(level: string | undefined, best: number | null): string {
  const b = best !== null ? `Best ${formatTime(best)}` : '';
  return level ? (b ? `${level} · ${b}` : level) : b || 'Night Loft';
}

export function xrHudContent(s: XrHudState): XrPanelContent {
  const r = s.race;
  const flightLine = `${s.armed ? 'ARMED' : 'DISARMED'} · ${s.mode.toUpperCase()} · ${CAM[s.camera]} · ${s.altitude.toFixed(1)} m`;
  const buttons = 'B mode · X reset · R-stick click cam · Y pause';
  const flightHint = !s.armed ? `A arm · ${buttons}` : s.latched ? 'Push throttle up to take off' : `A disarm · ${buttons}`;
  const exit = s.exitHint ?? XR_EXIT_HINT;
  const hint = (h: string): string => s.toast || h;
  switch (r.status) {
    case 'menu':
      return { layout: 'menu', title: 'DRONE SIM VR', sub: menuSub(s.level, r.bestTime), hint: hint(`A Race · X Free fly · ${s.level ? 'Y Level · ' : ''}${exit}`), accent: CYAN };
    case 'paused':
      return { layout: 'menu', title: 'PAUSED', sub: 'L-stick click recentre · L-trigger heading arrow', hint: hint(`A Resume · X Menu · ${exit}`), accent: AMBER };
    case 'finished':
      return { layout: 'menu', title: `FINISH ${formatTime(r.time)}`, sub: r.bestTime !== null ? `Best ${formatTime(r.bestTime)}` : '', hint: hint(`A Retry · X Menu · ${exit}`), accent: GREEN };
    case 'countdown':
      return { layout: 'hud', title: r.countdown > 0 ? String(Math.ceil(r.countdown)) : 'GO', sub: flightLine, hint: hint(flightHint), accent: AMBER };
    case 'crashed':
      return { layout: 'hud', title: 'CRASHED', sub: 'Respawning…', hint: hint(''), accent: RED };
    case 'freefly':
      return { layout: 'hud', title: `FREE FLY · ${Math.round(s.speed * KMH)} km/h`, sub: flightLine, hint: hint(flightHint), accent: s.armed ? GREEN : CYAN };
    case 'racing':
    default:
      return { layout: 'hud', title: `${formatTime(r.time)} · Ring ${Math.min(r.nextRing + 1, r.totalRings)}/${r.totalRings}`, sub: flightLine, hint: hint(flightHint), accent: s.armed ? GREEN : CYAN };
  }
}

/** First-run tutorial offer in the headset (the DOM prompt is not visible there): A starts, X skips. */
export function xrTutorialPrompt(): XrPanelContent {
  return { layout: 'menu', title: 'NEW TO FPV?', sub: '3-minute tutorial: arm, hover, turn, land, fly a ring', hint: 'A Start · X Skip', accent: CYAN };
}

const XR_BAR_CELLS = 10;

/** Text progress bar for the canvas card (geometric-shape glyphs every headset font has; no extra texture or mesh). */
export function xrProgressBar(value: number): string {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const n = Math.round(v * XR_BAR_CELLS);
  return `${'●'.repeat(n)}${'○'.repeat(XR_BAR_CELLS - n)} ${Math.round(v * 100)}%`;
}

/**
 * In-headset tutorial card: step title, the instruction line, progress and how to skip. Welcome and done sit
 * at eye level ('menu'); flight steps use the low 'hud' placement so the drone stays in view.
 * VR buttons: A starts / confirms, hold B skips, on the done card A = Start Training, X = Menu.
 */
export function xrTutorialCard(v: TutorialView): XrPanelContent {
  if (v.id === 'done') {
    return { layout: 'menu', title: v.title.toUpperCase(), sub: v.lines[0] ?? '', hint: 'A Start Training · X Menu', accent: GREEN };
  }
  const welcome = v.id === 'welcome';
  const first = v.lines[0] ?? '';
  const sub = welcome ? (v.lines[1] ?? '') : v.hint && v.lines[1] ? `${first} · ${v.lines[1]}` : first;
  const status = welcome ? 'A start' : xrProgressBar(v.progress);
  const skip = v.skipHold > 0 ? `Skipping ${Math.round(v.skipHold * 100)}%` : v.skipLabel;
  return {
    layout: welcome ? 'menu' : 'hud',
    title: `${v.number}/${v.total} · ${v.title.toUpperCase()}`,
    sub,
    hint: `${status} · ${skip}`,
    accent: v.hint ? AMBER : CYAN,
  };
}
