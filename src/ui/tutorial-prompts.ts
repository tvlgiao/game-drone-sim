/**
 * Tutorial copy, generated per input source and stick setup from the mode-labels helpers (never hard-coded keys),
 * and the `TutorialView` both the DOM card and the VR card render.
 */
import type { Settings } from '../core/settings';
import type { Channel } from '../input/stick';
import type { InputSource } from '../types';
import { TUTORIAL_STEP_COUNT, type TutorialMachine, type TutorialPhase, type TutorialStepId } from '../game/tutorial';
import { holdsAltitude } from '../input/input-manager';
import { buttonLabel, channelDirLabel, channelSide, pressVerb, stickLong, type PromptButton } from './mode-labels';

export type PromptSettings = Pick<Settings, 'stickMode' | 'throttleSource' | 'invert' | 'touchThrottleCentre'>;

export interface PromptOptions {
  /** drone armed now: the flying steps (3–7) say how to re-arm after a crash / disarm */
  armed?: boolean;
  /** Gamepad id: PlayStation pads name their face buttons (Cross, Triangle) */
  padId?: string | null;
}

export interface TutorialViewPart {
  id: string;
  label: string;
  value: number;
}

export interface TutorialView {
  id: TutorialStepId;
  /** 1-based */
  number: number;
  total: number;
  title: string;
  /** one or two lines */
  lines: string[];
  /** the second line is the re-arm notice (keep it visible even where the card shows one line) */
  rearm: boolean;
  progress: number;
  overall: number;
  hint: boolean;
  parts: TutorialViewPart[];
  /** sticks (by side) and button a hint highlights; `trigger` = RT carries the throttle */
  focus: { sides: ('l' | 'r')[]; button: PromptButton | null; trigger: boolean };
  phase: TutorialPhase;
  /** how to skip on this source, e.g. "Esc to skip" */
  skipLabel: string;
  source: InputSource;
}

/** steps whose second line becomes the re-arm notice when disarmed (see `flying` in promptFor) */
const REARM_STEPS: ReadonlySet<TutorialStepId> = new Set(['throttle', 'hover', 'yaw', 'pitch-roll', 'land']);

/** Keys (like a spring-back stick) and the centring sticks fly with altitude hold: let go = hold height. */
const centringThrottle = (src: InputSource, s: PromptSettings): boolean => holdsAltitude(src === 'none' ? 'keyboard' : src, s);
const isKeyboard = (src: InputSource): boolean => src === 'keyboard' || src === 'none';

function controlsSummary(src: InputSource, s: PromptSettings): string {
  if (src === 'keyboard' || src === 'none') {
    const d = (ch: Channel, a: 1 | -1, b: 1 | -1): string => `${channelDirLabel(s, ch, a, src)} / ${channelDirLabel(s, ch, b, src)}`;
    return `Throttle ${d('throttle', 1, -1)} · Yaw ${d('yaw', -1, 1)} · Pitch ${d('pitch', 1, -1)} · Roll ${d('roll', -1, 1)}`;
  }
  const ms = { stickMode: s.stickMode, throttleSource: src === 'gamepad' ? s.throttleSource : ('stick' as const) };
  const name = src === 'touch' ? ['Left thumb', 'Right thumb'] : ['Left stick', 'Right stick'];
  return `${name[0]}: ${stickLong(ms, 'l')} · ${name[1]}: ${stickLong(ms, 'r')}`;
}

/**
 * How to bring the throttle to zero before arming; '' when the source's centring throttle is already latched at
 * zero for take-off (keyboard, touch auto-centre), so arming is just the button.
 */
function throttleDown(src: InputSource, s: PromptSettings): string {
  if (isKeyboard(src) || (src === 'touch' && s.touchThrottleCentre)) return '';
  if (src === 'xr') return `Let go of the ${channelSide(s, 'throttle', src) === 'l' ? 'left' : 'right'} stick`;
  return `Throttle fully down (${channelDirLabel(s, 'throttle', -1, src)})`;
}

/** One or two lines of instruction for a step on an input source, honouring stick mode, throttle source and inverts. */
export function promptFor(id: TutorialStepId, src: InputSource, s: PromptSettings, opts: PromptOptions = {}): string[] {
  const verb = pressVerb(src);
  const v = verb.toLowerCase();
  const btn = (b: PromptButton): string => buttonLabel(b, src, opts.padId ?? null);
  const dir = (ch: Channel, d: 1 | -1): string => channelDirLabel(s, ch, d, src);
  /** both directions of a channel, the stick named once: "Right thumb ↑ / ↓", "W / S" */
  const both = (ch: Channel, a: 1 | -1): string => {
    const x = dir(ch, a);
    const y = dir(ch, a === 1 ? -1 : 1);
    const cut = x.lastIndexOf(' ');
    return cut > 0 && y.startsWith(x.slice(0, cut + 1)) ? `${x} / ${y.slice(cut + 1)}` : `${x} / ${y}`;
  };
  const down = throttleDown(src, s);
  const rearm = down ? `Disarmed: ${down.replace(/^[A-Z]/, (c) => c.toLowerCase())}, then ${v} ${btn('arm')}.` : `Disarmed: ${v} ${btn('arm')} to arm again.`;
  const kb = isKeyboard(src);
  const flying = (lines: [string, string]): string[] => (opts.armed === false ? [lines[0], rearm] : lines);
  switch (id) {
    case 'welcome':
      return [controlsSummary(src, s), `${verb} ${btn('confirm')} to start.`];
    case 'arm':
      return [down ? `${down}, then ${v} ${btn('arm')}.` : `${verb} ${btn('arm')} to arm.`, 'Armed means the props spin: the drone is live.'];
    case 'throttle':
      return flying([
        kb ? `Hold ${dir('throttle', 1)} to climb past 1.5 m.` : `Throttle up (${dir('throttle', 1)}) to climb past 1.5 m.`,
        kb ? `Let go of ${dir('throttle', 1)} to hold that height.` : centringThrottle(src, s) ? 'Let go of the stick to hold that height.' : 'Ease off as it rises: small, gentle inputs.',
      ]);
    case 'hover':
      return flying([
        'Hold between 1 and 3 m, steady, for 3 seconds.',
        kb
          ? `No key held = hold height; tap ${both('throttle', 1)} to adjust.`
          : centringThrottle(src, s)
            ? 'A centred throttle stick holds the height.'
            : `Small throttle corrections (${both('throttle', 1)}).`,
      ]);
    case 'yaw':
      return flying([`Yaw right (${dir('yaw', 1)}) and left (${dir('yaw', -1)}) to turn on the spot.`, 'Turn 180° each way.']);
    case 'pitch-roll':
      return flying([
        `Pitch (${both('pitch', 1)}) flies forward and back, roll (${both('roll', -1)}) sideways.`,
        'Fly 4 m each way. Angle mode levels the drone when you let go.',
      ]);
    case 'land':
      return flying([kb ? `Hold ${dir('throttle', -1)} to descend and touch down.` : `Throttle down gently (${dir('throttle', -1)}) to touch down.`, 'Settle on the ground for a second.']);
    case 'disarm':
      return [`${verb} ${btn('arm')} to disarm.`, 'Always disarm once you have landed.'];
    case 'modes':
      return [`${verb} ${btn('toggleMode')} for ACRO, then again for ANGLE.`, 'Angle self-levels when you let go; acro keeps the tilt, like freestyle pilots fly.'];
    case 'cameras':
      return [`${verb} ${btn('cycleCamera')} to switch views: line of sight, FPV and chase.`, 'Try all three.'];
    case 'ring':
      return ['Arm, take off and fly through the glowing ring.', `Any view works: ${btn('cycleCamera')} switches cameras.`];
    case 'done':
      return ['You flew your first ring.', 'Next: Training, three rings on the same field.'];
  }
}

const PART_LABEL: Record<string, string> = {
  right: 'Right',
  left: 'Left',
  forward: 'Forward',
  back: 'Back',
  acro: 'Acro',
  angle: 'Angle',
  los: 'LOS',
  fpv: 'FPV',
  chase: 'Chase',
};

/**
 * Skip instruction per source. There is no hold-to-skip: keyboard skips with Esc, touch / mouse with the card's
 * Skip button, pad and Quest through the pause menu's "Skip tutorial" (pause = Start/Menu on a pad, Y on Quest).
 */
export function skipLabel(src: InputSource, padId: string | null = null): string {
  if (src === 'touch') return 'Skip';
  if (src === 'gamepad' || src === 'xr') return `${buttonLabel('pause', src, padId)} › Skip tutorial`;
  return `${buttonLabel('pause', src)} to skip`;
}

/** Everything a card needs for the machine's current state. */
export function tutorialView(m: TutorialMachine, src: InputSource, s: PromptSettings, armed: boolean, padId: string | null = null): TutorialView {
  const step = m.step;
  const focus = step.focus;
  const sides = new Set<'l' | 'r'>();
  let trigger = false;
  for (const ch of focus.channels) {
    const side = channelSide(s, ch, src);
    if (side) sides.add(side);
    else trigger = true;
  }
  return {
    id: step.id,
    number: m.index + 1,
    total: TUTORIAL_STEP_COUNT,
    title: step.title,
    lines: promptFor(step.id, src, s, { armed, padId }),
    rearm: REARM_STEPS.has(step.id) && !armed,
    progress: m.progress,
    overall: m.overall,
    hint: m.hint,
    parts: m.parts().map((p) => ({ ...p, label: PART_LABEL[p.id] ?? p.id })),
    focus: { sides: [...sides], button: focus.button, trigger },
    phase: m.phase,
    skipLabel: skipLabel(src, padId),
    source: src,
  };
}
