/** Merges gamepad + keyboard + touch + WebXR controllers into one normalised InputFrame per render frame. */
import type { Settings } from '../core/settings';
import type { InputFrame, InputSource, StickPositions } from '../types';
import { GP, GamepadInput, prettyPadName } from './gamepad';
import { KeyboardInput } from './keyboard';
import { EdgeDetector, RepeatTrigger, VirtualSticks, mapSticks, throttleSlot, type StickMapOptions, type StickSlot } from './stick';
import { TouchInput, throttleSideOf } from './touch';
import { XrControllers, shapeXrControl, type XrButtons } from './xr-controllers';

export { applyRadialDeadzone, applyAxialDeadzone, stickToThrottle, triggerToThrottle, mapSticks, squareGate, VirtualSticks, EdgeDetector } from './stick';

/** Fired on gamepad connect/disconnect so the HUD can toast it. */
export interface GamepadConnectionEvent {
  connected: boolean;
  id: string;
  name: string;
  /** a disconnect of the pad that was flying (the active source), so the game can pause */
  wasActive: boolean;
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
/** Quest Touch layout: A arm/confirm, B mode/back, X reset, Y pause, right stick click = camera. */
const XR_BUTTON: Record<ButtonName, keyof XrButtons> = {
  arm: 'a',
  toggleMode: 'b',
  cycleCamera: 'rStick',
  reset: 'x',
  pause: 'y',
  confirm: 'a',
  back: 'b',
};
const BUTTON_NAMES = Object.keys(PAD_BUTTON) as ButtonName[];
type NavDir = 'up' | 'down' | 'left' | 'right';
const NAV_DIRS: readonly NavDir[] = ['up', 'down', 'left', 'right'];
const NAV_KEYS: Record<NavDir, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const NAV_PAD: Record<NavDir, number> = { up: GP.UP, down: GP.DOWN, left: GP.LEFT, right: GP.RIGHT };

export class InputManager {
  /** Called on gamepad connect / disconnect (e.g. hud.toast). */
  onConnection: ((e: GamepadConnectionEvent) => void) | null = null;
  /** Virtual touch sticks + on-screen buttons (UI attaches its layer to it). */
  readonly touch = new TouchInput();
  /** WebXR (Quest Touch) controllers; fed the session's input sources by main while presenting. */
  readonly xr = new XrControllers();

  private settings: Settings;
  private readonly win: Window | null;
  private readonly pad: GamepadInput;
  private readonly kb: KeyboardInput;
  private readonly vsticks = new VirtualSticks();
  private readonly padEdges = new Map<ButtonName, EdgeDetector>(BUTTON_NAMES.map((n) => [n, new EdgeDetector()]));
  private readonly navRepeat = new Map<NavDir, RepeatTrigger>(NAV_DIRS.map((d) => [d, new RepeatTrigger()]));
  private readonly raw: Record<StickSlot, number> = { lx: 0, ly: 0, rx: 0, ry: 0 };
  private readonly padAxes: number[] = [];
  private readonly padButtons: number[] = [];
  private readonly padRaw = { id: '', mapping: '', axes: this.padAxes as readonly number[], buttons: this.padButtons as readonly number[] };
  private source: InputSource = 'none';
  /** Touch device: touch is the default source until a keyboard / gamepad is used. */
  private readonly touchDevice: boolean;
  /** mapSticks options for touch: square gate off (the virtual gate is already square), stick throttle. */
  private readonly touchOpts: StickMapOptions;
  /** keyboard has no trigger: its throttle is always the mode's throttle stick */
  private readonly kbOpts: StickMapOptions;
  /** XR thumbsticks: radial deadzone on the flight stick, throttle raw (altitude hold centres it) */
  private readonly xrOpts: StickMapOptions;
  private readonly frame: InputFrame = {
    control: { throttle: 0, yaw: 0, pitch: 0, roll: 0 },
    buttons: { arm: false, toggleMode: false, cycleCamera: false, reset: false, pause: false, confirm: false },
    nav: { up: false, down: false, left: false, right: false, back: false },
    source: 'none',
    gamepadId: null,
    sticks: { lx: 0, ly: -1, rx: 0, ry: 0 },
    pad: null,
    xr: null,
  };

  private readonly onConnected = (e: Event): void => this.emitConnection(e, true, false);
  private readonly onDisconnected = (e: Event): void => {
    const gp = (e as GamepadEvent).gamepad;
    const wasActive = this.source === 'gamepad' && !!gp && gp.index === this.pad.selectedIndex;
    if (gp) this.pad.forget(gp.index);
    this.emitConnection(e, false, wasActive);
  };

  constructor(win: Window | null, settings: Settings, touchDevice = false) {
    this.win = win;
    this.settings = settings;
    this.touchDevice = touchDevice;
    this.touchOpts = { stickMode: settings.stickMode, throttleSource: 'stick', squareGate: false, invert: settings.invert, deadzone: settings.deadzone };
    this.kbOpts = { ...this.touchOpts, squareGate: settings.squareGate };
    this.xrOpts = { ...this.touchOpts };
    this.pad = new GamepadInput(win?.navigator ?? null);
    this.kb = new KeyboardInput(win);
    if (win) this.touch.listen(win);
    win?.addEventListener('gamepadconnected', this.onConnected);
    win?.addEventListener('gamepaddisconnected', this.onDisconnected);
    this.updateSettings(settings);
  }

  updateSettings(s: Settings): void {
    this.settings = s;
    for (const o of [this.touchOpts, this.kbOpts, this.xrOpts]) {
      o.stickMode = s.stickMode;
      o.invert = s.invert;
      o.deadzone = s.deadzone;
    }
    this.kbOpts.squareGate = s.squareGate;
    const t = this.touch.sticks;
    t.configure(throttleSideOf(throttleSlot(s.stickMode)), s.touchThrottleCentre, s.touchSticksFixed, t.opts.radius);
    this.xr.setThrottleSlot(throttleSlot(s.stickMode));
  }

  /**
   * Throttle back to the bottom for a fresh take-off (respawn, disarm, new flight): re-arms the latch of
   * the centring throttles (touch auto-centre, XR thumbstick) and drops the keyboard's held throttle,
   * which would otherwise launch the respawned quad at the old setting.
   */
  latchTakeoff(): void {
    this.touch.sticks.latchTakeoff();
    this.xr.latchTakeoff();
    this.vsticks.setThrottle(0);
  }

  /** The active source's throttle is still latched at the bottom (armed but not yet pushed up). */
  get takeoffLatched(): boolean {
    if (this.source === 'xr') return this.xr.latched;
    return this.source === 'touch' && this.touch.sticks.latched;
  }

  /** Current source (last used device). */
  get activeSource(): InputSource {
    return this.source;
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
    const xr = this.xr;
    if (xr.active) xr.poll(now);

    const st = this.settings;
    const hold = throttleSlot(st.stickMode);
    this.vsticks.update(
      dt,
      {
        lUp: kb.isDown('KeyW'),
        lDown: kb.isDown('KeyS'),
        lLeft: kb.isDown('KeyA'),
        lRight: kb.isDown('KeyD'),
        rUp: kb.isDown('ArrowUp'),
        rDown: kb.isDown('ArrowDown'),
        rLeft: kb.isDown('ArrowLeft'),
        rRight: kb.isDown('ArrowRight'),
      },
      hold,
    );

    const touchT = this.touch.lastActivity;
    const kbT = kb.lastActivity;
    const padT = this.pad.lastActivity;
    if (touchT > -Infinity && touchT >= kbT && touchT >= padT) this.source = 'touch';
    else if (kbT > -Infinity && kbT >= padT) this.source = 'keyboard';
    else if (snap && (padT > Math.max(kbT, touchT) || this.source === 'none')) this.source = 'gamepad';
    if (!snap && this.source === 'gamepad') this.source = touchT > kbT ? 'touch' : kbT > -Infinity ? 'keyboard' : 'none';
    if (this.source === 'none' && this.touchDevice) this.source = 'touch';
    // In a headset the Touch controllers are the default; a paired gamepad used more recently wins.
    if (xr.active && xr.connected && !(snap && padT > xr.lastActivity)) this.source = 'xr';
    else if (!xr.active && this.source === 'xr') this.source = 'none';

    const opts: StickMapOptions = st;
    const sticks: StickPositions = f.sticks;
    if (this.source === 'gamepad' && snap) {
      const am = st.axisMap;
      const ax = snap.axes;
      const n = snap.axisCount;
      const read = (i: number): number => (i < n ? ax[i]! : 0);
      // Gamepad Y is +down; sticks are +up.
      this.raw.lx = read(am.lx);
      this.raw.ly = -read(am.ly);
      this.raw.rx = read(am.rx);
      this.raw.ry = -read(am.ry);
      mapSticks(this.raw, snap.values[GP.RT]!, opts, sticks, f.control, true);
    } else if (this.source === 'xr') {
      mapSticks(xr.pos, 0, this.xrOpts, sticks, f.control, true);
      shapeXrControl(f.control);
    } else if (this.source === 'touch') {
      mapSticks(this.touch.sticks.pos, 0, this.touchOpts, sticks, f.control, true);
    } else {
      mapSticks(this.vsticks.pos, 0, this.kbOpts, sticks, f.control, false);
    }

    if (snap) {
      const pr = this.padRaw;
      pr.id = snap.id;
      pr.mapping = snap.mapping;
      this.padAxes.length = snap.axisCount;
      for (let i = 0; i < snap.axisCount; i++) this.padAxes[i] = snap.axes[i]!;
      this.padButtons.length = snap.values.length;
      for (let i = 0; i < snap.values.length; i++) this.padButtons[i] = snap.values[i]!;
      f.pad = pr;
    } else {
      f.pad = null;
    }

    const b = f.buttons;
    let back = false;
    for (const name of BUTTON_NAMES) {
      const padEdge = this.padEdges.get(name)!.update(snap ? snap.pressed[PAD_BUTTON[name]]! : false);
      const keyEdge = KEY_BUTTON[name].some((k) => kb.wasPressed(k));
      const xrEdge = xr.active && xr.pressed[XR_BUTTON[name]];
      if (name === 'back') back = padEdge || keyEdge || xrEdge;
      else b[name] = padEdge || keyEdge || xrEdge;
    }
    this.touch.drainButtons(b);

    const n = f.nav;
    n.back = back;
    for (const d of NAV_DIRS) {
      let held = kb.isDown(NAV_KEYS[d]) || kb.wasPressed(NAV_KEYS[d]);
      if (snap) {
        held ||= snap.pressed[NAV_PAD[d]]!;
        const am = this.settings.axisMap;
        const lx = am.lx < snap.axisCount ? snap.axes[am.lx]! : 0;
        const ly = am.ly < snap.axisCount ? snap.axes[am.ly]! : 0;
        if (d === 'up') held ||= ly < -FLICK;
        else if (d === 'down') held ||= ly > FLICK;
        else if (d === 'left') held ||= lx < -FLICK;
        else held ||= lx > FLICK;
      }
      n[d] = this.navRepeat.get(d)!.update(held, dt);
    }

    f.xr = xr.active ? xr.pressed : null;
    f.source = this.source;
    f.gamepadId = snap ? snap.id : null;
    kb.endFrame();
    return f;
  }

  /** Dual-rumble on the active pad when supported; magnitudes 0..1. */
  rumble(strong: number, weak: number, ms: number): void {
    if (this.source === 'xr') {
      this.xr.pulse(Math.max(strong, weak), ms);
      return;
    }
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
    this.touch.dispose();
    this.win?.removeEventListener('gamepadconnected', this.onConnected);
    this.win?.removeEventListener('gamepaddisconnected', this.onDisconnected);
    this.onConnection = null;
  }

  private emitConnection(e: Event, connected: boolean, wasActive: boolean): void {
    const gp = (e as GamepadEvent).gamepad;
    const id = gp?.id ?? 'Gamepad';
    if (connected && this.source === 'none') this.source = 'gamepad';
    this.onConnection?.({ connected, id, name: prettyPadName(id), wasActive });
  }
}
