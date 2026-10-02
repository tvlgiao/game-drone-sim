import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import { TUTORIAL_STEPS, TutorialMachine, type TutorialStepId } from '../../src/game/tutorial';
import { buttonLabel, channelDirLabel, channelSide, pressVerb } from '../../src/ui/mode-labels';
import { promptFor, skipLabel, tutorialView, type PromptSettings } from '../../src/ui/tutorial-prompts';
import { xrProgressBar, xrTutorialCard } from '../../src/ui/xr-hud';
import type { InputSource } from '../../src/types';

const NO_INVERT = { throttle: false, yaw: false, pitch: false, roll: false };

function s(over: Partial<Settings> = {}): PromptSettings {
  return { stickMode: 2, throttleSource: 'stick', invert: NO_INVERT, touchThrottleCentre: true, ...over };
}

const SOURCES: InputSource[] = ['keyboard', 'gamepad', 'touch', 'xr'];
const IDS = TUTORIAL_STEPS.map((x) => x.id);
const text = (id: TutorialStepId, src: InputSource, st: PromptSettings, armed?: boolean): string => promptFor(id, src, st, { armed }).join(' | ');

describe('mode-labels prompt helpers', () => {
  it('buttonLabel follows the input manager bindings per source', () => {
    expect(['arm', 'toggleMode', 'cycleCamera', 'confirm'].map((b) => buttonLabel(b as 'arm', 'keyboard'))).toEqual(['Space', 'M', 'C', 'Enter']);
    expect(['arm', 'toggleMode', 'cycleCamera', 'confirm'].map((b) => buttonLabel(b as 'arm', 'gamepad'))).toEqual(['A', 'Y', 'RB', 'A']);
    expect(['arm', 'toggleMode', 'cycleCamera', 'confirm'].map((b) => buttonLabel(b as 'arm', 'touch'))).toEqual(['ARM', 'MODE', 'CAM', 'Continue']);
    expect(['arm', 'toggleMode', 'cycleCamera', 'confirm'].map((b) => buttonLabel(b as 'arm', 'xr'))).toEqual(['A', 'B', 'R-stick', 'A']);
    expect(buttonLabel('arm', 'none')).toBe('Space');
    expect(pressVerb('touch')).toBe('Tap');
    expect(pressVerb('gamepad')).toBe('Press');
  });

  it('channelDirLabel: keyboard keys per stick mode (WASD = left stick, arrows = right)', () => {
    const m2 = s();
    expect(['throttle', 'yaw', 'pitch', 'roll'].map((c) => channelDirLabel(m2, c as 'yaw', 1, 'keyboard'))).toEqual(['W', 'D', '↑', '→']);
    expect(['throttle', 'yaw', 'pitch', 'roll'].map((c) => channelDirLabel(m2, c as 'yaw', -1, 'keyboard'))).toEqual(['S', 'A', '↓', '←']);
    const m1 = s({ stickMode: 1 });
    expect(['throttle', 'yaw', 'pitch', 'roll'].map((c) => channelDirLabel(m1, c as 'yaw', 1, 'keyboard'))).toEqual(['↑', 'D', 'W', '→']);
    const m3 = s({ stickMode: 3 });
    expect(['throttle', 'yaw', 'pitch', 'roll'].map((c) => channelDirLabel(m3, c as 'yaw', 1, 'keyboard'))).toEqual(['↑', '→', 'W', 'D']);
    const m4 = s({ stickMode: 4 });
    expect(['throttle', 'yaw', 'pitch', 'roll'].map((c) => channelDirLabel(m4, c as 'yaw', 1, 'keyboard'))).toEqual(['W', '→', '↑', 'D']);
  });

  it('channelDirLabel: sticks / thumbs / trigger, inverted channels swap direction', () => {
    expect(channelDirLabel(s(), 'throttle', 1, 'gamepad')).toBe('Left stick ↑');
    expect(channelDirLabel(s({ stickMode: 1 }), 'throttle', 1, 'gamepad')).toBe('Right stick ↑');
    expect(channelDirLabel(s({ throttleSource: 'trigger' }), 'throttle', 1, 'gamepad')).toBe('Squeeze RT');
    expect(channelDirLabel(s({ throttleSource: 'trigger' }), 'throttle', -1, 'gamepad')).toBe('Release RT');
    // the trigger is a gamepad-only setting: touch / XR / keyboard still fly throttle on a stick
    expect(channelDirLabel(s({ throttleSource: 'trigger' }), 'throttle', 1, 'touch')).toBe('Left thumb ↑');
    expect(channelDirLabel(s({ throttleSource: 'trigger' }), 'throttle', 1, 'xr')).toBe('Left stick ↑');
    expect(channelDirLabel(s({ throttleSource: 'trigger' }), 'throttle', 1, 'keyboard')).toBe('W');
    expect(channelDirLabel(s(), 'yaw', 1, 'touch')).toBe('Left thumb →');
    expect(channelDirLabel(s({ invert: { ...NO_INVERT, pitch: true } }), 'pitch', 1, 'keyboard')).toBe('↓');
    expect(channelDirLabel(s({ invert: { ...NO_INVERT, roll: true } }), 'roll', 1, 'gamepad')).toBe('Right stick ←');
    expect(channelDirLabel(s({ throttleSource: 'trigger', invert: { ...NO_INVERT, throttle: true } }), 'throttle', 1, 'gamepad')).toBe('Release RT');
  });

  it('channelSide maps channels to sticks, null for the RT throttle', () => {
    expect(channelSide(s(), 'throttle', 'gamepad')).toBe('l');
    expect(channelSide(s({ stickMode: 1 }), 'throttle', 'touch')).toBe('r');
    expect(channelSide(s({ stickMode: 3 }), 'yaw', 'keyboard')).toBe('r');
    expect(channelSide(s({ throttleSource: 'trigger' }), 'throttle', 'gamepad')).toBeNull();
    expect(channelSide(s({ throttleSource: 'trigger' }), 'throttle', 'xr')).toBe('l');
  });
});

describe('promptFor', () => {
  it('every step has one or two non-empty lines for every source, mode and throttle source', () => {
    for (const src of [...SOURCES, 'none'] as InputSource[]) {
      for (const stickMode of [1, 2, 3, 4] as const) {
        for (const throttleSource of ['stick', 'trigger'] as const) {
          for (const id of IDS) {
            for (const armed of [undefined, true, false]) {
              const lines = promptFor(id, src, s({ stickMode, throttleSource }), { armed });
              expect(lines.length, `${id} ${src}`).toBeGreaterThanOrEqual(1);
              expect(lines.length).toBeLessThanOrEqual(2);
              for (const l of lines) {
                expect(l.trim()).not.toBe('');
                expect(l).not.toMatch(/undefined|null|NaN/);
              }
            }
          }
        }
      }
    }
  });

  it('keyboard, mode 2', () => {
    const st = s();
    expect(text('welcome', 'keyboard', st)).toBe('Throttle W / S · Yaw A / D · Pitch ↑ / ↓ · Roll ← / → | Press Enter to start.');
    expect(text('arm', 'keyboard', st)).toContain('Throttle fully down (S), then press Space.');
    expect(text('throttle', 'keyboard', st)).toContain('Throttle up (W)');
    expect(text('throttle', 'keyboard', st)).toContain('Ease off');
    expect(text('yaw', 'keyboard', st)).toContain('Yaw right (D) and left (A)');
    expect(text('pitch-roll', 'keyboard', st)).toContain('Pitch (↑ / ↓) flies forward and back, roll (← / →) sideways.');
    expect(text('land', 'keyboard', st)).toContain('(S)');
    expect(text('disarm', 'keyboard', st)).toContain('Press Space to disarm.');
    expect(text('modes', 'keyboard', st)).toContain('Press M for ACRO');
    expect(text('cameras', 'keyboard', st)).toContain('Press C to switch views');
  });

  it('keyboard, mode 1: throttle on the arrows, pitch on W / S', () => {
    const st = s({ stickMode: 1 });
    expect(text('welcome', 'keyboard', st)).toContain('Throttle ↑ / ↓ · Yaw A / D · Pitch W / S · Roll ← / →');
    expect(text('throttle', 'keyboard', st)).toContain('Throttle up (↑)');
    expect(text('arm', 'keyboard', st)).toContain('(↓)');
    expect(text('pitch-roll', 'keyboard', st)).toContain('Pitch (W / S)');
    expect(text('throttle', 'keyboard', st)).not.toContain('(W)');
  });

  it('gamepad, modes 1 and 2, and RT throttle', () => {
    expect(text('welcome', 'gamepad', s())).toBe('Left stick: ↕ Throttle · ↔ Yaw · Right stick: ↕ Pitch · ↔ Roll | Press A to start.');
    expect(text('welcome', 'gamepad', s({ stickMode: 1 }))).toContain('Left stick: ↕ Pitch · ↔ Yaw · Right stick: ↕ Throttle · ↔ Roll');
    expect(text('arm', 'gamepad', s())).toContain('Throttle fully down (Left stick ↓), then press A.');
    expect(text('arm', 'gamepad', s({ stickMode: 1 }))).toContain('(Right stick ↓)');
    expect(text('throttle', 'gamepad', s({ stickMode: 1 }))).toContain('Throttle up (Right stick ↑)');
    expect(text('yaw', 'gamepad', s({ stickMode: 1 }))).toContain('Yaw right (Left stick →)');
    expect(text('pitch-roll', 'gamepad', s({ stickMode: 1 }))).toContain('Pitch (Left stick ↑ / Left stick ↓)');
    expect(text('throttle', 'gamepad', s({ throttleSource: 'trigger' }))).toContain('Throttle up (Squeeze RT)');
    expect(text('arm', 'gamepad', s({ throttleSource: 'trigger' }))).toContain('(Release RT)');
    expect(text('welcome', 'gamepad', s({ throttleSource: 'trigger' }))).toContain('RT is throttle');
    expect(text('modes', 'gamepad', s())).toContain('Press Y for ACRO');
    expect(text('cameras', 'gamepad', s())).toContain('Press RB');
  });

  it('touch points at the on-screen ARM / MODE / CAM buttons and thumbs; centring throttle holds height', () => {
    expect(text('welcome', 'touch', s())).toContain('Tap Continue to start.');
    expect(text('welcome', 'touch', s())).toContain('Left thumb: ↕ Throttle');
    expect(text('arm', 'touch', s())).toContain('Throttle fully down (Left thumb ↓), then tap ARM.');
    expect(text('arm', 'touch', s({ stickMode: 1 }))).toContain('(Right thumb ↓)');
    expect(text('throttle', 'touch', s())).toContain('Let go of the stick to hold that height.');
    expect(text('throttle', 'touch', s({ touchThrottleCentre: false }))).toContain('Ease off');
    expect(text('modes', 'touch', s())).toContain('Tap MODE');
    expect(text('cameras', 'touch', s())).toContain('Tap CAM');
  });

  it('Quest Touch: A / B / R-stick, thumbsticks, centring throttle', () => {
    expect(text('welcome', 'xr', s())).toContain('Press A to start.');
    expect(text('arm', 'xr', s())).toContain('Let go of the left stick, then press A.');
    expect(text('arm', 'xr', s({ stickMode: 1 }))).toContain('Let go of the right stick');
    expect(text('throttle', 'xr', s())).toContain('Throttle up (Left stick ↑)');
    expect(text('hover', 'xr', s())).toContain('centred throttle stick holds');
    expect(text('modes', 'xr', s())).toContain('Press B for ACRO');
    expect(text('cameras', 'xr', s())).toContain('Press R-stick');
  });

  it('flying steps tell a disarmed pilot how to re-arm', () => {
    for (const id of ['throttle', 'hover', 'yaw', 'pitch-roll', 'land'] as const) {
      expect(promptFor(id, 'keyboard', s(), { armed: false })[1]).toBe('Disarmed: throttle fully down (S), then press Space.');
      expect(promptFor(id, 'keyboard', s(), { armed: true })[1]).not.toContain('Disarmed');
    }
    expect(promptFor('hover', 'xr', s(), { armed: false })[1]).toBe('Disarmed: let go of the left stick, then press A.');
    expect(promptFor('hover', 'touch', s(), { armed: false })[1]).toBe('Disarmed: throttle fully down (Left thumb ↓), then tap ARM.');
  });

  it('skip labels per source', () => {
    expect(SOURCES.map(skipLabel)).toEqual(['Esc to skip', 'Hold B to skip', 'Skip', 'Hold B to skip']);
  });
});

describe('tutorialView', () => {
  it('maps the step focus to stick sides for the stick mode, RT as trigger', () => {
    const m = new TutorialMachine();
    m.start('angle', 4); // hover: throttle
    expect(tutorialView(m, 'gamepad', s(), true).focus).toEqual({ sides: ['l'], button: null, trigger: false });
    expect(tutorialView(m, 'gamepad', s({ stickMode: 1 }), true).focus).toEqual({ sides: ['r'], button: null, trigger: false });
    expect(tutorialView(m, 'gamepad', s({ throttleSource: 'trigger' }), true).focus).toEqual({ sides: [], button: null, trigger: true });
    m.start('angle', 6); // pitch & roll: right stick in mode 2, left in mode 3, split in mode 1
    expect(tutorialView(m, 'touch', s(), true).focus.sides).toEqual(['r']);
    expect(tutorialView(m, 'touch', s({ stickMode: 3 }), true).focus.sides).toEqual(['l']);
    expect(tutorialView(m, 'touch', s({ stickMode: 1 }), true).focus.sides.sort()).toEqual(['l', 'r']);
    m.start('angle', 2);
    expect(tutorialView(m, 'touch', s(), false).focus).toEqual({ sides: ['l'], button: 'arm', trigger: false });
  });

  it('carries number, title, labelled parts, re-arm line and skip label', () => {
    const m = new TutorialMachine();
    m.start('angle', 5);
    const v = tutorialView(m, 'keyboard', { ...DEFAULT_SETTINGS }, false);
    expect(v).toMatchObject({ id: 'yaw', number: 5, total: 12, title: 'Yaw: turn on the spot', phase: 'running', skipLabel: 'Esc to skip', source: 'keyboard' });
    expect(v.parts.map((p) => p.label)).toEqual(['Right', 'Left']);
    expect(v.lines[1]).toContain('Disarmed');
    m.start('angle', 9);
    expect(tutorialView(m, 'keyboard', s(), false).lines[1]).not.toContain('Disarmed');
  });
});

describe('xrTutorialCard', () => {
  it('xrProgressBar: ten cells and a percentage, clamped', () => {
    expect(xrProgressBar(0)).toBe('░░░░░░░░░░ 0%');
    expect(xrProgressBar(0.5)).toBe('█████░░░░░ 50%');
    expect(xrProgressBar(2)).toBe('██████████ 100%');
    expect(xrProgressBar(Number.NaN)).toBe('░░░░░░░░░░ 0%');
  });

  it('welcome at eye level with A start; flight steps low with progress and hold-B skip', () => {
    const m = new TutorialMachine();
    m.start('angle');
    const w = xrTutorialCard(tutorialView(m, 'xr', s(), false));
    expect(w).toMatchObject({ layout: 'menu', title: '1/12 · WELCOME, PILOT', sub: 'Press A to start.', hint: 'A start · Hold B to skip' });
    m.start('angle', 3);
    m.update({ dt: 0.1, drone: { velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, agl: 0.75, armed: true, flightMode: 'angle', cameraMode: 'los', source: 'xr', ringsPassed: 0, confirm: false });
    const f = xrTutorialCard(tutorialView(m, 'xr', s(), true));
    expect(f.layout).toBe('hud');
    expect(f.title).toBe('3/12 · TAKE OFF');
    expect(f.sub).toBe('Throttle up (Left stick ↑) to climb past 1.5 m.');
    expect(f.hint).toBe('█████░░░░░ 50% · Hold B to skip');
  });

  it('a hint adds the second line and turns amber; holding B shows the skip fill', () => {
    const v = { ...tutorialView(new TutorialMachine(), 'xr', s(), true), id: 'hover' as const, hint: true, lines: ['a', 'b'], skipHold: 0.4 };
    const c = xrTutorialCard(v);
    expect(c.sub).toBe('a · b');
    expect(c.accent).toBe('#ffc861');
    expect(c.hint).toContain('Skipping 40%');
  });

  it('done card: A Start Training · X Menu', () => {
    const m = new TutorialMachine();
    m.start('angle', 11);
    const base = { dt: 0.1, drone: { velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, agl: 1, armed: true, flightMode: 'angle' as const, cameraMode: 'fpv' as const, source: 'xr' as const, confirm: false };
    m.update({ ...base, ringsPassed: 0 });
    m.update({ ...base, ringsPassed: 1 });
    const c = xrTutorialCard(tutorialView(m, 'xr', s(), true));
    expect(c).toMatchObject({ layout: 'menu', title: 'TUTORIAL COMPLETE', hint: 'A Start Training · X Menu', sub: 'You flew your first ring.' });
  });
});
