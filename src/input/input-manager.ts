/** Merges gamepad + keyboard into one normalised InputFrame per render frame. */
import type { Settings } from '../core/settings';
import type { InputFrame, InputSource } from '../types';
import { GP, GamepadInput, prettyPadName } from './gamepad';
import { KeyboardInput } from './keyboard';
import {
  EdgeDetector,
  KeyboardAxes,
  RepeatTrigger,
  applyAxialDeadzone,
  applyRadialDeadzone,
  stickToThrottle,
  triggerToThrottle,
  type Vec2,
} from './stick';

export { applyRadialDeadzone, applyAxialDeadzone, stickToThrottle, triggerToThrottle, KeyboardAxes, EdgeDetector } from './stick';

/** Fired on gamepad connect/disconnect so the HUD can toast it. */
export interface GamepadConnectionEvent {
  connected: boolean;
  id: string;
  name: string;
}

const FLICK = 0.6;

type ButtonName = 'arm' | 'toggleMode' | 'cycleCamera' | 'reset' | 'pause' | 'confirm' | 'back';
const PAD_BUTTON: Record<ButtonName, number> = {
  arm: GP.A,
  toggleMode: GP.Y,
  cycleCamera: GP.RB,
  reset: GP.B,
  pause: GP.START,
  confirm: GP.A,
  back: GP.B,
};
const KEY_BUTTON: Record<ButtonName, readonly string[]> = {
  arm: ['Space'],
  toggleMode: ['KeyM'],
  cycleCamera: ['KeyC'],
  reset: ['KeyR'],
  pause: ['Escape'],
  confirm: ['Enter', 'NumpadEnter'],
  back: ['Escape', 'Backspace'],
};
const BUTTON_NAMES = Object.keys(PAD_BUTTON) as ButtonName[];
type NavDir = 'up' | 'down' | 'left' | 'right';
const NAV_DIRS: readonly NavDir[] = ['up', 'down', 'left', 'right'];
const NAV_KEYS: Record<NavDir, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const NAV_PAD: Record<NavDir, number> = { up: GP.UP, down: GP.DOWN, left: GP.LEFT, right: GP.RIGHT };

export class InputManager {
  /** Called on gamepad connect / disconnect (e.g. hud.toast). */
  onConnection: ((e: GamepadConnectionEvent) => void) | null = null;

  private settings: Settings;
  private readonly win: Window | null;
  private readonly pad: GamepadInput;
  private readonly kb: KeyboardInput;
  private readonly kbAxes = new KeyboardAxes();
  private readonly padEdges = new Map<ButtonName, EdgeDetector>(BUTTON_NAMES.map((n) => [n, new EdgeDetector()]));
  private readonly navRepeat = new Map<NavDir, RepeatTrigger>(NAV_DIRS.map((d) => [d, new RepeatTrigger()]));
  private readonly stick: Vec2 = { x: 0, y: 0 };
  private source: InputSource = 'none';
  private readonly frame: InputFrame = {
    control: { throttle: 0, yaw: 0, pitch: 0, roll: 0 },
    buttons: { arm: false, toggleMode: false, cycleCamera: false, reset: false, pause: false, confirm: false },
    nav: { up: false, down: false, left: false, right: false, back: false },
    source: 'none',
    gamepadId: null,
  };

  private readonly onConnected = (e: Event): void => this.emitConnection(e, true);
  private readonly onDisconnected = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    if (gp) this.pad.forget(gp.index);
    this.emitConnection(e, false);
  };

  constructor(win: Window | null, settings: Settings) {
    this.win = win;
    this.settings = settings;
    this.pad = new GamepadInput(win?.navigator ?? null);
    this.kb = new KeyboardInput(win);
    win?.addEventListener('gamepadconnected', this.onConnected);
    win?.addEventListener('gamepaddisconnected', this.onDisconnected);
  }

  updateSettings(s: Settings): void {
    this.settings = s;
  }

  /** Current keyboard throttle (0..1); lets the game zero it on respawn/disarm. */
  setKeyboardThrottle(v: number): void {
    this.kbAxes.throttle = Math.min(1, Math.max(0, v));
  }

  /**
   * Reads devices once per render frame. The returned frame object is reused between calls.
   * Buttons/nav are rising-edge events from either device; sticks come from the last-used device.
   */
  poll(dt: number): InputFrame {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const f = this.frame;
    const snap = this.pad.poll(now);
    const kb = this.kb;

    this.kbAxes.update(dt, {
      throttleUp: kb.isDown('KeyW'),
      throttleDown: kb.isDown('KeyS'),
      yawLeft: kb.isDown('KeyA'),
      yawRight: kb.isDown('KeyD'),
      pitchForward: kb.isDown('ArrowUp'),
      pitchBack: kb.isDown('ArrowDown'),
      rollLeft: kb.isDown('ArrowLeft'),
      rollRight: kb.isDown('ArrowRight'),
    });

    if (kb.lastActivity > -Infinity && kb.lastActivity >= this.pad.lastActivity) this.source = 'keyboard';
    else if (snap && (this.pad.lastActivity > kb.lastActivity || this.source === 'none')) this.source = 'gamepad';
    if (!snap && this.source === 'gamepad') this.source = kb.lastActivity > -Infinity ? 'keyboard' : 'none';

    const c = f.control;
    if (this.source === 'gamepad' && snap) {
      const dz = this.settings.deadzone;
      c.throttle =
        this.settings.throttleSource === 'right-trigger' ? triggerToThrottle(snap.values[GP.RT]!) : stickToThrottle(snap.axes[1]!);
      c.yaw = applyAxialDeadzone(snap.axes[0]!, dz);
      applyRadialDeadzone(snap.axes[2]!, snap.axes[3]!, dz, this.stick);
      c.roll = this.stick.x;
      c.pitch = -this.stick.y;
    } else {
      c.throttle = this.kbAxes.throttle;
      c.yaw = this.kbAxes.yaw;
      c.pitch = this.kbAxes.pitch;
      c.roll = this.kbAxes.roll;
    }

    const b = f.buttons;
    let back = false;
    for (const name of BUTTON_NAMES) {
      const padEdge = this.padEdges.get(name)!.update(snap ? snap.pressed[PAD_BUTTON[name]]! : false);
      const keyEdge = KEY_BUTTON[name].some((k) => kb.wasPressed(k));
      if (name === 'back') back = padEdge || keyEdge;
      else b[name] = padEdge || keyEdge;
    }

    const n = f.nav;
    n.back = back;
    for (const d of NAV_DIRS) {
      let held = kb.isDown(NAV_KEYS[d]) || kb.wasPressed(NAV_KEYS[d]);
      if (snap) {
        held ||= snap.pressed[NAV_PAD[d]]!;
        const lx = snap.axes[0]!;
        const ly = snap.axes[1]!;
        if (d === 'up') held ||= ly < -FLICK;
        else if (d === 'down') held ||= ly > FLICK;
        else if (d === 'left') held ||= lx < -FLICK;
        else held ||= lx > FLICK;
      }
      n[d] = this.navRepeat.get(d)!.update(held, dt);
    }

    f.source = this.source;
    f.gamepadId = snap ? snap.id : null;
    kb.endFrame();
    return f;
  }

  /** Dual-rumble on the active pad when supported; magnitudes 0..1. */
  rumble(strong: number, weak: number, ms: number): void {
    const pad = this.pad.activePad();
    if (!pad) return;
    const act = (pad as { vibrationActuator?: GamepadHapticActuator | null }).vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return;
    try {
      act
        .playEffect('dual-rumble', {
          startDelay: 0,
          duration: Math.max(0, ms),
          strongMagnitude: Math.min(1, Math.max(0, strong)),
          weakMagnitude: Math.min(1, Math.max(0, weak)),
        })
        .catch(() => undefined);
    } catch {
      /* unsupported effect */
    }
  }

  dispose(): void {
    this.kb.dispose();
    this.win?.removeEventListener('gamepadconnected', this.onConnected);
    this.win?.removeEventListener('gamepaddisconnected', this.onDisconnected);
    this.onConnection = null;
  }

  private emitConnection(e: Event, connected: boolean): void {
    const gp = (e as GamepadEvent).gamepad;
    const id = gp?.id ?? 'Gamepad';
    if (connected && this.source === 'none') this.source = 'gamepad';
    this.onConnection?.({ connected, id, name: prettyPadName(id) });
  }
}
