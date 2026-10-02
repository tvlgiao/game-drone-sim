/** Human labels for the RC stick mode / throttle source (HUD, controls help, controller setup). */
import type { Settings } from '../core/settings';
import { MODE_TABLE, throttleSlot, type Channel } from '../input/stick';

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

/** Keyboard keys per channel for the selected mode (WASD = left stick, arrows = right stick). */
export function keyboardKeys(s: ModeSettings): Record<Channel, string> {
  const t = MODE_TABLE[s.stickMode];
  const keys: Record<string, string> = { lx: 'A / D', ly: 'W / S', rx: '← / →', ry: '↑ / ↓' };
  const out = {} as Record<Channel, string>;
  for (const slot of ['lx', 'ly', 'rx', 'ry'] as const) out[t[slot]] = keys[slot]!;
  out.throttle += ' (holds)';
  return out;
}

/** Gamepad control per channel for the selected mode. */
export function padControls(s: ModeSettings): Record<Channel, string> {
  const t = MODE_TABLE[s.stickMode];
  const names: Record<string, string> = { lx: 'Left stick ↔', ly: 'Left stick ↕', rx: 'Right stick ↔', ry: 'Right stick ↕' };
  const out = {} as Record<Channel, string>;
  for (const slot of ['lx', 'ly', 'rx', 'ry'] as const) out[t[slot]] = names[slot]!;
  out.throttle = s.throttleSource === 'trigger' ? 'Right trigger (RT)' : `${out.throttle} (full range)`;
  return out;
}

/** Touch thumb per channel for the selected mode (left / right half of the screen). */
export function touchControls(s: Pick<Settings, 'stickMode'>): Record<Channel, string> {
  const t = MODE_TABLE[s.stickMode];
  const names: Record<string, string> = { lx: 'Left thumb ↔', ly: 'Left thumb ↕', rx: 'Right thumb ↔', ry: 'Right thumb ↕' };
  const out = {} as Record<Channel, string>;
  for (const slot of ['lx', 'ly', 'rx', 'ry'] as const) out[t[slot]] = names[slot]!;
  return out;
}

/** Quest Touch thumbstick per channel: both spring back, so the throttle stick holds altitude and the other holds position. */
export function xrControls(s: Pick<Settings, 'stickMode'>): Record<Channel, string> {
  const t = MODE_TABLE[s.stickMode];
  const names: Record<string, string> = { lx: 'Left stick ↔', ly: 'Left stick ↕', rx: 'Right stick ↔', ry: 'Right stick ↕' };
  const out = {} as Record<Channel, string>;
  for (const slot of ['lx', 'ly', 'rx', 'ry'] as const) out[t[slot]] = names[slot]!;
  out.throttle += ' (centre holds altitude)';
  return out;
}

/** Disarmed hint: how to bring throttle to zero. */
export function throttleDownHint(s: ModeSettings, keyboard: boolean): string {
  const slot = throttleSlot(s.stickMode);
  if (keyboard) return slot === 'ly' ? 'Hold S' : 'Hold ↓';
  const c = throttleControl(s);
  return c === 'rt' ? 'Release RT' : `${c === 'left' ? 'Left' : 'Right'} stick fully down`;
}
