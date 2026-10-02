/**
 * Key / button glyphs for the flight HUD's control hints, per active input scheme. Every binding is read
 * from the input layer's tables (input-manager.ts), so a remap there shows up here unchanged.
 */
import type { Settings } from '../core/settings';
import { GP } from '../input/gamepad';
import { KEY_BUTTON, KEY_STICKS, LEGEND_KEY, LEGEND_PAD_BUTTON, MOUSE_CENTRE_KEY, PAD_BUTTON, XR_BUTTON, XR_EXTRA, holdsAltitude } from '../input/input-manager';
import { MODE_TABLE, slotOf, throttleSlot, type Channel, type StickSlot } from '../input/stick';
import type { XrButtons } from '../input/xr-controllers';
import type { InputSource } from '../types';

export type PadFamily = 'xbox' | 'playstation' | 'generic';
export type HintScheme = 'keyboard' | 'xbox' | 'playstation' | 'generic' | 'quest' | 'touch';

/** Controller family from a Gamepad id (vendor 045e = Microsoft, 054c = Sony). */
export function padFamily(id: string | null | undefined): PadFamily {
  if (!id) return 'generic';
  if (/dualsense|dualshock|playstation|054c/i.test(id)) return 'playstation';
  if (/xbox|xinput|045e/i.test(id)) return 'xbox';
  return 'generic';
}

/** Glyph set for the active source; no source yet on a desktop = keyboard (the likeliest first input). */
export function hintScheme(source: InputSource, padId: string | null): HintScheme {
  if (source === 'gamepad') return padFamily(padId);
  if (source === 'xr') return 'quest';
  if (source === 'touch') return 'touch';
  return 'keyboard';
}

export type GlyphStyle = 'key' | 'face' | 'shoulder' | 'system' | 'stick' | 'mouse';
export type PsShape = 'cross' | 'circle' | 'square' | 'triangle';

export interface Glyph {
  style: GlyphStyle;
  /** visible text ('' for a drawn shape) */
  label: string;
  /** accessible name */
  name: string;
  tone?: 'green' | 'red' | 'blue' | 'yellow';
  shape?: PsShape;
  /** stick: pressed (click); mouse: axis arrow */
  press?: boolean;
}

const KEY_NAMES: Record<string, [label: string, name: string]> = {
  Space: ['Space', 'Space'],
  Escape: ['Esc', 'Escape'],
  Enter: ['Enter', 'Enter'],
  NumpadEnter: ['Enter', 'Enter'],
  Backspace: ['⌫', 'Backspace'],
  ArrowUp: ['↑', 'Up arrow'],
  ArrowDown: ['↓', 'Down arrow'],
  ArrowLeft: ['←', 'Left arrow'],
  ArrowRight: ['→', 'Right arrow'],
};

export function keyGlyph(code: string): Glyph {
  const known = KEY_NAMES[code];
  const label = known ? known[0] : code.replace(/^(Key|Digit)/, '');
  return { style: 'key', label, name: known ? known[1] : label };
}

type FaceInfo = { label: string; name: string; tone?: Glyph['tone']; shape?: PsShape };
const FACE: Record<PadFamily, FaceInfo[]> = {
  xbox: [
    { label: 'A', name: 'A', tone: 'green' },
    { label: 'B', name: 'B', tone: 'red' },
    { label: 'X', name: 'X', tone: 'blue' },
    { label: 'Y', name: 'Y', tone: 'yellow' },
  ],
  playstation: [
    { label: '', name: 'Cross', shape: 'cross' },
    { label: '', name: 'Circle', shape: 'circle' },
    { label: '', name: 'Square', shape: 'square' },
    { label: '', name: 'Triangle', shape: 'triangle' },
  ],
  generic: [
    { label: 'A', name: 'A (bottom)' },
    { label: 'B', name: 'B (right)' },
    { label: 'X', name: 'X (left)' },
    { label: 'Y', name: 'Y (top)' },
  ],
};
const SHOULDER: Record<PadFamily, readonly string[]> = {
  xbox: ['LB', 'RB', 'LT', 'RT'],
  playstation: ['L1', 'R1', 'L2', 'R2'],
  generic: ['LB', 'RB', 'LT', 'RT'],
};
const SYSTEM: Record<PadFamily, readonly [label: string, name: string][]> = {
  xbox: [
    ['⧉', 'View'],
    ['☰', 'Menu'],
  ],
  playstation: [
    ['Create', 'Create'],
    ['Options', 'Options'],
  ],
  generic: [
    ['Back', 'Back'],
    ['Start', 'Start'],
  ],
};
const STICK_CLICK: Record<PadFamily, readonly string[]> = { xbox: ['LS', 'RS'], playstation: ['L3', 'R3'], generic: ['LS', 'RS'] };

/** Standard-mapping button index → glyph of that controller family. */
export function padGlyph(family: PadFamily, index: number): Glyph {
  if (index >= GP.A && index <= GP.Y) {
    const f = FACE[family][index - GP.A]!;
    return { style: 'face', label: f.label, name: f.name, tone: f.tone, shape: f.shape };
  }
  if (index >= GP.LB && index <= GP.RT) {
    const l = SHOULDER[family][index - GP.LB]!;
    return { style: 'shoulder', label: l, name: l };
  }
  if (index === GP.BACK || index === GP.START) {
    const [label, name] = SYSTEM[family][index - GP.BACK]!;
    return { style: 'system', label, name };
  }
  if (index === GP.LS || index === GP.RS) {
    const l = STICK_CLICK[family][index - GP.LS]!;
    return { style: 'stick', label: l, name: `${l} (stick click)`, press: true };
  }
  const dpad: Record<number, string> = { [GP.UP]: 'D-pad ↑', [GP.DOWN]: 'D-pad ↓', [GP.LEFT]: 'D-pad ←', [GP.RIGHT]: 'D-pad →' };
  const l = dpad[index] ?? `Button ${index}`;
  return { style: 'system', label: l, name: l };
}

const XR_GLYPH: Record<keyof XrButtons, Glyph> = {
  a: { style: 'face', label: 'A', name: 'A' },
  b: { style: 'face', label: 'B', name: 'B' },
  x: { style: 'face', label: 'X', name: 'X' },
  y: { style: 'face', label: 'Y', name: 'Y' },
  rStick: { style: 'stick', label: 'R', name: 'Right stick click', press: true },
  lStick: { style: 'stick', label: 'L', name: 'Left stick click', press: true },
  lTrigger: { style: 'shoulder', label: 'L trigger', name: 'Left trigger' },
};

export type HintAction = 'arm' | 'toggleMode' | 'cycleCamera' | 'reset' | 'pause' | 'headingArrow' | 'recenter' | 'legend' | 'mouseCentre';

export const ACTION_LABEL: Readonly<Record<HintAction, string>> = {
  arm: 'Arm / disarm',
  toggleMode: 'Flight mode',
  cycleCamera: 'Camera',
  reset: 'Reset',
  pause: 'Pause',
  headingArrow: 'Heading arrow',
  recenter: 'Recentre view',
  legend: 'Controls',
  mouseCentre: 'Centre mouse',
};

/** Glyph(s) of an action for a scheme; [] = not bound on that input (touch labels its own buttons). */
export function actionGlyphs(scheme: HintScheme, action: HintAction): Glyph[] {
  if (scheme === 'touch') return [];
  if (scheme === 'keyboard') {
    if (action === 'legend') return [keyGlyph(LEGEND_KEY)];
    if (action === 'mouseCentre') return [keyGlyph(MOUSE_CENTRE_KEY)];
    if (action === 'headingArrow' || action === 'recenter') return [];
    return [keyGlyph(KEY_BUTTON[action][0]!)];
  }
  if (scheme === 'quest') {
    if (action === 'headingArrow' || action === 'recenter') return [XR_GLYPH[XR_EXTRA[action]]];
    if (action === 'legend' || action === 'mouseCentre') return [];
    return [XR_GLYPH[XR_BUTTON[action]]];
  }
  if (action === 'legend') return [padGlyph(scheme, LEGEND_PAD_BUTTON)];
  if (action === 'headingArrow' || action === 'recenter' || action === 'mouseCentre') return [];
  return [padGlyph(scheme, PAD_BUTTON[action])];
}

type HintSettings = Pick<Settings, 'stickMode' | 'throttleSource' | 'mouseXAxis' | 'touchThrottleCentre'>;

/**
 * Keyboard keys driving a stick slot: with the mouse on yaw (mouseXAxis 'yaw') the yaw and roll key
 * pairs trade places, as in InputManager.keyboardSticks.
 */
function keySlot(s: HintSettings, mouse: boolean, slot: StickSlot): StickSlot {
  if (!mouse || s.mouseXAxis !== 'yaw') return slot;
  const yaw = slotOf(s.stickMode, 'yaw');
  const roll = slotOf(s.stickMode, 'roll');
  return slot === yaw ? roll : slot === roll ? yaw : slot;
}

/** Physical layout of one keyboard "stick" for the compact HUD cluster. */
export interface KeyCluster {
  up: Glyph;
  down: Glyph;
  left: Glyph;
  right: Glyph;
  /** the mouse also drives this stick's vertical / horizontal axis */
  mouseV: boolean;
  mouseH: boolean;
}

export function keyCluster(s: HintSettings, side: 'l' | 'r', mouse: boolean): KeyCluster {
  const v: StickSlot = side === 'l' ? 'ly' : 'ry';
  const h: StickSlot = side === 'l' ? 'lx' : 'rx';
  const kv = KEY_STICKS[keySlot(s, mouse, v)];
  const kh = KEY_STICKS[keySlot(s, mouse, h)];
  const xSlot = slotOf(s.stickMode, s.mouseXAxis);
  const ySlot = slotOf(s.stickMode, 'pitch');
  return {
    up: keyGlyph(kv[1]),
    down: keyGlyph(kv[0]),
    left: keyGlyph(kh[0]),
    right: keyGlyph(kh[1]),
    mouseV: mouse && (ySlot === v || xSlot === v),
    mouseH: mouse && (ySlot === h || xSlot === h),
  };
}

export interface ChannelHint {
  channel: Channel;
  glyphs: Glyph[];
  /** short qualifier, e.g. 'centre = hover' */
  note: string;
}

const mouseGlyph = (axis: '↔' | '↕'): Glyph => ({ style: 'mouse', label: axis, name: axis === '↔' ? 'Mouse left / right' : 'Mouse up / down' });
const CHANNELS: readonly Channel[] = ['throttle', 'yaw', 'pitch', 'roll'];

/** Per-channel bindings for the Controls legend (stick mode, throttle source and mouse aware). */
export function channelHints(scheme: HintScheme, s: HintSettings, mouse = false): ChannelHint[] {
  const table = MODE_TABLE[s.stickMode];
  const thr = throttleSlot(s.stickMode);
  return CHANNELS.map((channel) => {
    const slot = (Object.keys(table) as StickSlot[]).find((k) => table[k] === channel)!;
    const vertical = slot === 'ly' || slot === 'ry';
    const side = slot[0] === 'l' ? 'L' : 'R';
    const glyphs: Glyph[] = [];
    let note = '';
    if (scheme === 'keyboard') {
      const keys = KEY_STICKS[keySlot(s, mouse, slot)];
      // read like the keyboard: up / down, left / right
      if (vertical) glyphs.push(keyGlyph(keys[1]), keyGlyph(keys[0]));
      else glyphs.push(keyGlyph(keys[0]), keyGlyph(keys[1]));
      if (mouse && channel === 'pitch') glyphs.unshift(mouseGlyph('↕'));
      if (mouse && channel === s.mouseXAxis) glyphs.unshift(mouseGlyph('↔'));
      if (channel === 'throttle' && holdsAltitude('keyboard', s)) note = 'centre = hover';
    } else if (scheme === 'touch') {
      glyphs.push({ style: 'stick', label: side, name: `${side === 'L' ? 'Left' : 'Right'} thumb` });
    } else {
      const family = scheme === 'quest' ? null : scheme;
      if (channel === 'throttle' && family && s.throttleSource === 'trigger') {
        glyphs.push(padGlyph(family, GP.RT));
      } else {
        glyphs.push({ style: 'stick', label: side, name: `${side === 'L' ? 'Left' : 'Right'} stick ${vertical ? 'up / down' : 'left / right'}` });
        note = vertical ? '↕' : '↔';
      }
      if (channel === 'throttle' && scheme === 'quest') note = '↕ centre = hover';
      else if (channel === 'throttle' && slot === thr && s.throttleSource !== 'trigger') note = '↕ full range';
    }
    return { channel, glyphs, note };
  });
}

const PS_SVG: Record<PsShape, string> = {
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  circle: '<circle cx="12" cy="12" r="6.5"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="0.5"/>',
  triangle: '<path d="M12 5.2l7 12.1H5z"/>',
};

const MOUSE_SVG =
  '<svg viewBox="0 0 16 22" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="19" rx="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 2v6" stroke="currentColor" stroke-width="1.6"/></svg>';

/** Static markup for one glyph (labels come from the tables above, never from user data). */
export function glyphHtml(g: Glyph): string {
  const cls = ['ds-g', `ds-g--${g.style}`];
  if (g.tone) cls.push(`is-${g.tone}`);
  if (g.shape) cls.push('ds-g--ps', `is-${g.shape}`);
  if (g.press) cls.push('is-press');
  if (g.label.length > 2 && g.style === 'key') cls.push('is-wide');
  const named = g.label !== g.name ? ` aria-label="${g.name}" title="${g.name}"` : '';
  let body = g.label;
  if (g.shape) body = `<svg viewBox="0 0 24 24" aria-hidden="true">${PS_SVG[g.shape]}</svg>`;
  else if (g.style === 'mouse') body = `${MOUSE_SVG}<span aria-hidden="true">${g.label}</span>`;
  return `<kbd class="${cls.join(' ')}"${named}>${body}</kbd>`;
}

export const glyphsHtml = (gs: readonly Glyph[]): string => gs.map(glyphHtml).join('');
