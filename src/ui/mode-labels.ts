/** Human labels for the RC stick mode / throttle source (HUD, controls help, controller setup). */
import { FPV_FOV_V_RANGE } from '../core/camera-limits';
import type { Settings } from '../core/settings';
import { MODE_TABLE, slotOf, throttleSlot, type Channel, type StickSlot } from '../input/stick';
import type { InputSource } from '../types';
import { KEY_BUTTON, KEY_STICKS, PAD_BUTTON } from '../input/input-manager';
import { actionGlyphs, keyGlyph, padFamily, padGlyph, type Glyph } from './input-glyphs';

export const CH_SHORT: Record<Channel, string> = { throttle: 'THR', yaw: 'YAW', pitch: 'PIT', roll: 'ROL' };
export const CH_NAME: Record<Channel, string> = { throttle: 'Throttle', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };

type ModeSettings = Pick<Settings, 'stickMode' | 'throttleSource'>;

/** Channel on a stick axis, or null when it is the throttle axis but RT is the throttle. */
function axisChannel(s: ModeSettings, slot: 'lx' | 'ly' | 'rx' | 'ry'): Channel | null {
  const ch = MODE_TABLE[s.stickMode][slot];
  return ch === 'throttle' && s.throttleSource === 'trigger' ? null : ch;
}

/** e.g. "THR·YAW" (vertical·horizontal). */
export function stickShort(s: ModeSettings, side: 'l' | 'r'): string {
  const v = axisChannel(s, side === 'l' ? 'ly' : 'ry');
  const h = axisChannel(s, side === 'l' ? 'lx' : 'rx');
  return `${v ? CH_SHORT[v] : '—'}·${h ? CH_SHORT[h] : '—'}`;
}

/** e.g. "↕ Throttle · ↔ Yaw". */
export function stickLong(s: ModeSettings, side: 'l' | 'r'): string {
  const v = axisChannel(s, side === 'l' ? 'ly' : 'ry');
  const h = axisChannel(s, side === 'l' ? 'lx' : 'rx');
  return `↕ ${v ? CH_NAME[v] : '— (RT is throttle)'} · ↔ ${h ? CH_NAME[h] : '—'}`;
}

/** Which gamepad control carries throttle. */
export function throttleControl(s: ModeSettings): 'left' | 'right' | 'rt' {
  if (s.throttleSource === 'trigger') return 'rt';
  return throttleSlot(s.stickMode) === 'ly' ? 'left' : 'right';
}

/** Disarmed hint: how to bring throttle to zero. */
export function throttleDownHint(s: ModeSettings, keyboard: boolean): string {
  const slot = throttleSlot(s.stickMode);
  if (keyboard) return slot === 'ly' ? 'Hold S' : 'Hold ↓';
  const c = throttleControl(s);
  return c === 'rt' ? 'Release RT' : `${c === 'left' ? 'Left' : 'Right'} stick fully down`;
}

/** Flight / menu buttons a prompt can name (the `ButtonEvents` the input manager emits). */
export type PromptButton = 'arm' | 'toggleMode' | 'cycleCamera' | 'reset' | 'pause' | 'confirm';

/** Touch has no binding table: its on-screen buttons carry these names (the card's Continue button confirms). */
const TOUCH_LABEL: Record<PromptButton, string> = { arm: 'ARM', toggleMode: 'MODE', cycleCamera: 'CAM', reset: 'RESET', pause: 'Pause', confirm: 'Continue' };

/** No device used yet: a desktop browser most likely, so keyboard names. */
const promptSource = (src: InputSource): Exclude<InputSource, 'none'> => (src === 'none' ? 'keyboard' : src);

/** A glyph as prompt text: its label, the name of a drawn (PlayStation) or symbol (☰) glyph, "R-stick" for a Quest stick click. */
function glyphText(g: Glyph): string {
  if (g.style === 'stick') return g.label.length === 1 ? `${g.label}-stick` : g.label;
  return g.label && g.style !== 'system' ? g.label : g.name;
}

/**
 * Name of the control behind a button for an input source, e.g. "Space", "A", "ARM", read from the input
 * manager's binding tables through the HUD glyphs, so the tutorial and the HUD can never disagree.
 */
export function buttonLabel(b: PromptButton, src: InputSource, padId: string | null = null): string {
  const p = promptSource(src);
  if (p === 'touch') return TOUCH_LABEL[b];
  if (p === 'keyboard') return keyGlyph(KEY_BUTTON[b][0]!).label;
  if (p === 'xr') return glyphText(actionGlyphs('quest', b === 'confirm' ? 'arm' : b)[0]!);
  return glyphText(padGlyph(padFamily(padId), PAD_BUTTON[b]));
}

/** Verb for a button on a source: touch buttons are tapped, everything else pressed. */
export function pressVerb(src: InputSource): 'Tap' | 'Press' {
  return src === 'touch' ? 'Tap' : 'Press';
}

/** Keyboard key for one direction of a stick slot ([negative, positive] as in KEY_STICKS). */
const keyDir = (slot: StickSlot, i: 0 | 1): string => keyGlyph(KEY_STICKS[slot][i]).label;
const ARROW: Record<StickSlot, [string, string]> = { lx: ['←', '→'], ly: ['↓', '↑'], rx: ['←', '→'], ry: ['↓', '↑'] };

type DirSettings = Pick<Settings, 'stickMode' | 'throttleSource' | 'invert'>;

/**
 * The physical stick ('l' / 'r') carrying a channel for a source, or null when the gamepad's right trigger is the
 * throttle. Only gamepads use the trigger setting; keyboard, touch and XR always fly throttle on a stick.
 */
export function channelSide(s: Pick<Settings, 'stickMode' | 'throttleSource'>, ch: Channel, src: InputSource): 'l' | 'r' | null {
  if (ch === 'throttle' && src === 'gamepad' && s.throttleSource === 'trigger') return null;
  return slotOf(s.stickMode, ch)[0] === 'l' ? 'l' : 'r';
}

/**
 * The control that moves a channel one way, e.g. throttle +1 → "W" (keyboard, mode 2), "Left stick ↑" (pad),
 * "Right thumb ↑" (touch, mode 1), "Squeeze RT" (trigger throttle). `dir` is the channel's sign (+ = throttle up,
 * yaw right, pitch forward, roll right); an inverted channel swaps the physical direction.
 */
export function channelDirLabel(s: DirSettings, ch: Channel, dir: 1 | -1, src: InputSource): string {
  const phys = s.invert[ch] ? -dir : dir;
  const side = channelSide(s, ch, src);
  if (side === null) return phys > 0 ? 'Squeeze RT' : 'Release RT';
  const slot = slotOf(s.stickMode, ch);
  const i = phys > 0 ? 1 : 0;
  const p = promptSource(src);
  if (p === 'keyboard') return keyDir(slot, i);
  const stick = p === 'touch' ? (side === 'l' ? 'Left thumb' : 'Right thumb') : side === 'l' ? 'Left stick' : 'Right stick';
  return `${stick} ${ARROW[slot][i]}`;
}

const RAD = Math.PI / 180;

/**
 * Horizontal FOV the FPV camera really shows for a settings FOV at a viewport aspect (w / h).
 * Differs from `fovDeg` only when the rig's vertical clamp kicks in (wide FOV on a narrow screen).
 */
export function effectiveFovDeg(fovDeg: number, aspect: number): number {
  if (!(aspect > 0)) return fovDeg;
  const v = 2 * Math.atan(Math.tan((fovDeg * RAD) / 2) / aspect) / RAD;
  const vc = Math.min(FPV_FOV_V_RANGE.max, Math.max(FPV_FOV_V_RANGE.min, v));
  return vc === v ? fovDeg : (2 * Math.atan(Math.tan((vc * RAD) / 2) * aspect)) / RAD;
}
