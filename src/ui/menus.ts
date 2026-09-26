/** Menu screens (main, settings, controller setup, rates, controls, pause, finish, error) with mouse / keyboard / gamepad focus. */
import {
  DEFAULT_AXIS_MAP,
  RATE_AXES,
  SETTINGS_OPTIONS,
  applyRatePreset,
  cloneSettings,
  rateRange,
  setRateValue,
  type RateAxis,
  type RateField,
  type Settings,
} from '../core/settings';
import { AxisCapture, MODE_TABLE, STICK_SLOTS, type Channel, type StickSlot } from '../input/stick';
import type { InputFrame, NavEvents } from '../types';
import { formatTime } from './format';
import { controllerDiagram } from './icons';
import { HOVER, RateCharts } from './rate-charts';
import { CH_NAME, CH_SHORT, keyboardKeys, padControls, stickLong, stickShort, throttleControl } from './mode-labels';

export type ScreenName = 'main' | 'settings' | 'controller' | 'rates' | 'controls' | 'pause' | 'finish' | 'error' | 'confirm-quit' | 'bye' | 'none';

export type UiAction =
  | { type: 'race' }
  | { type: 'freefly' }
  | { type: 'resume' }
  | { type: 'menu' }
  | { type: 'retry' }
  /** HUD quit button: pause and ask for confirmation */
  | { type: 'request-quit' }
  /** leave the game (close tab when allowed) */
  | { type: 'exit' }
  /** touch devices: toggle the Fullscreen API (needs the tap gesture) */
  | { type: 'fullscreen' }
  | { type: 'settings'; settings: Settings };

export interface FinishData {
  time?: number;
  best?: number | null;
  newBest?: boolean;
}

interface Item {
  el: HTMLElement;
  activate?: () => void;
  adjust?: (dir: -1 | 1) => void;
}

type Val = string | number;
interface RowBase {
  id: string;
  label: string;
  hint: string;
}
type Row =
  | (RowBase & { kind: 'enum'; options: { value: Val; label: string }[]; get: (s: Settings) => Val; set: (s: Settings, v: Val) => void })
  | (RowBase & { kind: 'range'; range: { min: number; max: number; step: number }; fmt: (v: number) => string; get: (s: Settings) => number; set: (s: Settings, v: number) => void })
  | (RowBase & { kind: 'bool'; on?: string; off?: string; get: (s: Settings) => boolean; set: (s: Settings, v: boolean) => void });

type NumKey = 'cameraTiltDeg' | 'fovDeg' | 'volume' | 'deadzone' | 'throttleExpo' | 'throttleLimit' | 'angleMaxTiltDeg';
const rangeRow = (id: NumKey, label: string, hint: string, fmt: (v: number) => string): Row => ({
  id,
  label,
  hint,
  kind: 'range',
  range: SETTINGS_OPTIONS[id],
  fmt,
  get: (s) => s[id],
  set: (s, v) => {
    s[id] = v;
  },
});

const FIELD_NAME: Record<RateField, string> = { center: 'Center sensitivity', max: 'Max rate', expo: 'Expo' };
const rateCell = (axis: RateAxis, field: RateField): Row => ({
  id: `rate.${axis}.${field}`,
  label: `${axis[0]!.toUpperCase()}${axis.slice(1)} ${FIELD_NAME[field].toLowerCase()}`,
  hint: '',
  kind: 'range',
  range: rateRange(field),
  fmt: (v) => (field === 'expo' ? v.toFixed(2) : String(Math.round(v))),
  get: (s) => s.rates[axis][field],
  set: (s, v) => setRateValue(s, axis, field, v),
});
const RATE_FIELDS: readonly RateField[] = ['center', 'max', 'expo'];
/** Throttle MID below the range = Auto (hover). */
const MID_AUTO = SETTINGS_OPTIONS.throttleMid.min - SETTINGS_OPTIONS.throttleMid.step;

const invertRow = (ch: Channel): Row => ({
  id: `invert.${ch}`,
  label: `Reverse ${CH_NAME[ch].toLowerCase()}`,
  hint: `Flip the ${CH_SHORT[ch]} channel direction`,
  kind: 'bool',
  on: 'Reversed',
  off: 'Normal',
  get: (s) => s.invert[ch],
  set: (s, v) => {
    s.invert[ch] = v;
  },
});

const MODE_HINT: Record<number, string> = {
  1: 'Left: pitch·yaw · Right: throttle·roll',
  2: 'Left: throttle·yaw · Right: pitch·roll',
  3: 'Left: pitch·roll · Right: throttle·yaw',
  4: 'Left: throttle·roll · Right: pitch·yaw',
};

const ROW_DEFS: Row[] = [
  {
    id: 'stickMode',
    label: 'Stick mode',
    hint: 'RC transmitter layout (Mode 2 is most common)',
    kind: 'enum',
    options: SETTINGS_OPTIONS.stickMode.map((m) => ({ value: m, label: `Mode ${m}` })),
    get: (s) => s.stickMode,
    set: (s, v) => {
      s.stickMode = v as Settings['stickMode'];
    },
  },
  {
    id: 'throttleSource',
    label: 'Throttle source',
    hint: 'Throttle stick of the mode, or right trigger',
    kind: 'enum',
    options: [
      { value: 'stick', label: 'Stick' },
      { value: 'trigger', label: 'Right trigger' },
    ],
    get: (s) => s.throttleSource,
    set: (s, v) => {
      s.throttleSource = v as Settings['throttleSource'];
    },
  },
  {
    id: 'squareGate',
    label: 'Square gate',
    hint: 'Diagonals reach full deflection like an RC gimbal',
    kind: 'bool',
    get: (s) => s.squareGate,
    set: (s, v) => {
      s.squareGate = v;
    },
  },
  invertRow('throttle'),
  invertRow('yaw'),
  invertRow('pitch'),
  invertRow('roll'),
  {
    id: 'flightMode',
    label: 'Flight mode',
    hint: 'Angle levels itself (DJI "A"/Atti) · Acro holds attitude',
    kind: 'enum',
    options: [
      { value: 'angle', label: "Angle (self-level · 'A/Atti')" },
      { value: 'acro', label: 'Acro (rate)' },
    ],
    get: (s) => s.flightMode,
    set: (s, v) => {
      s.flightMode = v as Settings['flightMode'];
    },
  },
  {
    id: 'ratePreset',
    label: 'Rates',
    hint: 'Stick sensitivity (Betaflight Actual)',
    kind: 'enum',
    options: [
      { value: 'beginner', label: 'Beginner' },
      { value: 'freestyle', label: 'Freestyle' },
      { value: 'race', label: 'Race' },
      { value: 'custom', label: 'Custom' },
    ],
    get: (s) => s.ratePreset,
    set: (s, v) => applyRatePreset(s, v as Settings['ratePreset']),
  },
  {
    id: 'linkRollPitch',
    label: 'Link roll & pitch',
    hint: 'Editing roll also sets pitch (and vice versa)',
    kind: 'bool',
    get: (s) => s.linkRollPitch,
    set: (s, v) => {
      s.linkRollPitch = v;
    },
  },
  ...RATE_AXES.flatMap((a) => RATE_FIELDS.map((f) => rateCell(a, f))),
  {
    id: 'throttleMid',
    label: 'Throttle mid',
    hint: 'Motor output at stick centre',
    kind: 'range',
    range: { ...SETTINGS_OPTIONS.throttleMid, min: MID_AUTO },
    fmt: (v) => (v < SETTINGS_OPTIONS.throttleMid.min ? `Auto (${Math.round(HOVER * 100)}%)` : `${Math.round(v * 100)}%`),
    get: (s) => s.throttleMid ?? MID_AUTO,
    set: (s, v) => {
      s.throttleMid = v < SETTINGS_OPTIONS.throttleMid.min - 1e-6 ? null : v;
    },
  },
  rangeRow('throttleExpo', 'Throttle expo', 'Flattens the curve around mid', (v) => v.toFixed(2)),
  rangeRow('throttleLimit', 'Throttle limit', 'Scales maximum motor output', (v) => `${Math.round(v * 100)}%`),
  rangeRow('angleMaxTiltDeg', 'Max tilt angle', 'Angle mode: tilt at full stick', (v) => `${Math.round(v)}°`),
  rangeRow('cameraTiltDeg', 'Camera tilt', 'FPV camera uptilt', (v) => `${Math.round(v)}°`),
  rangeRow('fovDeg', 'Field of view', 'FPV lens width', (v) => `${Math.round(v)}°`),
  {
    id: 'quality',
    label: 'Graphics',
    hint: 'Auto picks a tier from your GPU',
    kind: 'enum',
    options: SETTINGS_OPTIONS.quality.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) })),
    get: (s) => s.quality,
    set: (s, v) => {
      s.quality = v as Settings['quality'];
    },
  },
  rangeRow('volume', 'Volume', 'Master volume', (v) => `${Math.round(v * 100)}%`),
  {
    id: 'showFps',
    label: 'Show FPS',
    hint: 'Frame-rate counter in the HUD',
    kind: 'bool',
    get: (s) => s.showFps,
    set: (s, v) => {
      s.showFps = v;
    },
  },
  rangeRow('deadzone', 'Stick deadzone', 'Radial deadzone for worn sticks', (v) => v.toFixed(2)),
  {
    id: 'touchThrottleCentre',
    label: 'Touch throttle',
    hint: 'Hold stays where released (like a radio) · Auto-centre = hover',
    kind: 'bool',
    on: 'Auto-centre',
    off: 'Hold',
    get: (s) => s.touchThrottleCentre,
    set: (s, v) => {
      s.touchThrottleCentre = v;
    },
  },
  {
    id: 'touchSticksFixed',
    label: 'Touch sticks',
    hint: 'Floating: stick appears under your thumb',
    kind: 'bool',
    on: 'Fixed',
    off: 'Floating',
    get: (s) => s.touchSticksFixed,
    set: (s, v) => {
      s.touchSticksFixed = v;
    },
  },
];
/** Rows only shown on touch devices. */
const TOUCH_ROWS: ReadonlySet<string> = new Set(['touchThrottleCentre', 'touchSticksFixed']);
const ROWS = new Map(ROW_DEFS.map((r) => [r.id, r]));
const SETTINGS_ROWS = ['stickMode', 'touchThrottleCentre', 'touchSticksFixed', 'throttleSource', 'flightMode', 'ratePreset', 'cameraTiltDeg', 'fovDeg', 'quality', 'volume', 'showFps', 'deadzone'];
const CONTROLLER_ROWS = ['stickMode', 'throttleSource', 'squareGate', 'invert.throttle', 'invert.yaw', 'invert.pitch', 'invert.roll'];
const CHANNELS: readonly Channel[] = ['throttle', 'yaw', 'pitch', 'roll'];
const SLOT_NAME: Record<StickSlot, string> = { lx: 'LX', ly: 'LY', rx: 'RX', ry: 'RY' };
const LIVE_TEXT_MS = 50;
const MAX_AXIS_ROWS = 12;

interface LiveEls {
  wells: Record<'l' | 'r', { dot: HTMLElement; well: HTMLElement; v: HTMLElement; h: HTMLElement }>;
  chans: Record<Channel, { fill: HTMLElement; us: HTMLElement; pct: HTMLElement }>;
  devName: HTMLElement;
  devMap: HTMLElement;
  devWarn: HTMLElement;
  axes: HTMLElement;
  buttons: HTMLElement;
  remapStatus: HTMLElement;
  remapBtns: Record<StickSlot, HTMLElement>;
  title: HTMLElement;
}

export class Menus {
  current: ScreenName = 'none';
  private readonly screens = new Map<ScreenName, HTMLElement>();
  private items: Item[] = [];
  private focus = 0;
  private returnTo: 'main' | 'pause' = 'main';
  private controllerReturn: ScreenName = 'settings';
  private ratesReturn: ScreenName = 'settings';
  private fine = false;
  private charts!: RateCharts;
  private ratesEls!: { preset: HTMLElement; fine: HTMLElement; box: HTMLElement };
  private settings: Settings;
  private readonly rowEls = new Map<string, { value: HTMLElement; fill: HTMLElement | null }[]>();
  private readonly finishEls: { time: HTMLElement; best: HTMLElement; badge: HTMLElement };
  private readonly errorMsg: HTMLElement;
  private readonly menuBest: HTMLElement;
  private readonly controlsBody: HTMLElement;
  private readonly live: LiveEls;
  private readonly liveCache = new Map<HTMLElement, string>();
  private liveTextAt = -Infinity;
  private axisRows: { fill: HTMLElement; val: HTMLElement }[] = [];
  private lastInput: InputFrame | null = null;
  private readonly capture = new AxisCapture();
  private captureSlot: StickSlot | null = null;
  private controlsKey = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly onAction: (a: UiAction) => void,
    settings: Settings,
  ) {
    this.settings = cloneSettings(settings);
    this.screens.set('main', this.buildMain());
    this.screens.set('settings', this.buildSettings());
    const ctl = this.buildController();
    this.screens.set('controller', ctl);
    this.screens.set('rates', this.buildRates());
    const controls = this.buildControls();
    this.screens.set('controls', controls);
    this.screens.set('pause', this.buildPause());
    this.screens.set('confirm-quit', this.buildConfirmQuit());
    this.screens.set('bye', this.buildBye());
    const fin = this.buildFinish();
    this.screens.set('finish', fin);
    const err = this.buildError();
    this.screens.set('error', err);
    const q = <T extends HTMLElement = HTMLElement>(el: HTMLElement, sel: string): T => el.querySelector<T>(sel)!;
    this.finishEls = { time: q(fin, '[data-f="time"]'), best: q(fin, '[data-f="best"]'), badge: q(fin, '[data-f="badge"]') };
    this.errorMsg = q(err, '[data-f="msg"]');
    this.menuBest = q(this.screens.get('main')!, '[data-f="best"]');
    this.controlsBody = q(controls, '[data-f="body"]');
    const well = (side: 'l' | 'r') => ({
      well: q(ctl, `[data-w="${side}"]`),
      dot: q(ctl, `[data-w="${side}"] .ds-well__dot`),
      v: q(ctl, `[data-w="${side}v"]`),
      h: q(ctl, `[data-w="${side}h"]`),
    });
    const chan = (c: Channel) => ({ fill: q(ctl, `[data-ch="${c}"] .ds-chan__fill`), us: q(ctl, `[data-ch="${c}"] [data-f="us"]`), pct: q(ctl, `[data-ch="${c}"] [data-f="pct"]`) });
    this.live = {
      wells: { l: well('l'), r: well('r') },
      chans: { throttle: chan('throttle'), yaw: chan('yaw'), pitch: chan('pitch'), roll: chan('roll') },
      devName: q(ctl, '[data-f="devName"]'),
      devMap: q(ctl, '[data-f="devMap"]'),
      devWarn: q(ctl, '[data-f="devWarn"]'),
      axes: q(ctl, '[data-f="axes"]'),
      buttons: q(ctl, '[data-f="buttons"]'),
      remapStatus: q(ctl, '[data-f="remapStatus"]'),
      remapBtns: { lx: q(ctl, '[data-act="remap-lx"] span'), ly: q(ctl, '[data-act="remap-ly"] span'), rx: q(ctl, '[data-act="remap-rx"] span'), ry: q(ctl, '[data-act="remap-ry"] span') },
      title: q(ctl, '[data-f="modeTitle"]'),
    };
    for (const el of this.screens.values()) root.appendChild(el);
    this.renderSettings();
  }

  setSettings(s: Settings): void {
    this.settings = cloneSettings(s);
    this.renderSettings();
  }

  /** Touch device: reveal touch-only rows/tips; `fullscreen` also shows the Full screen button. */
  enableTouch(fullscreen: boolean): void {
    for (const el of this.screens.values()) {
      el.querySelectorAll<HTMLElement>('[data-touch-only]').forEach((x) => {
        x.hidden = false;
      });
      if (fullscreen) {
        el.querySelectorAll<HTMLElement>('[data-fs-only]').forEach((x) => {
          x.hidden = false;
        });
      }
    }
    if (this.current !== 'none') this.items = this.collectItems(this.screens.get(this.current)!);
  }

  setMenuBest(best: number | null): void {
    const text = best === null ? '' : `Best lap ${formatTime(best)}`;
    if (this.menuBest.textContent !== text) this.menuBest.textContent = text;
  }

  setError(msg: string): void {
    this.errorMsg.textContent = msg;
    this.show('error');
  }

  show(name: ScreenName, data?: FinishData): void {
    if (this.current === 'error' && name !== 'error') return;
    if ((name === 'settings' || name === 'controls') && (this.current === 'main' || this.current === 'pause')) this.returnTo = this.current;
    if (name === 'controller' && (this.current === 'settings' || this.current === 'controls')) this.controllerReturn = this.current;
    if (name === 'rates' && (this.current === 'settings' || this.current === 'controller')) this.ratesReturn = this.current;
    if (name !== 'rates') this.setFine(false);
    if (name !== 'controller') this.stopCapture('');
    if (name === 'finish' && data) {
      this.finishEls.time.textContent = formatTime(data.time ?? null);
      this.finishEls.best.textContent = formatTime(data.best ?? null);
      this.finishEls.badge.hidden = !data.newBest;
    }
    this.current = name;
    for (const [n, el] of this.screens) {
      const on = n === name;
      el.classList.toggle('is-open', on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
      el.inert = !on;
    }
    this.root.classList.toggle('has-screen', name !== 'none');
    const el = this.screens.get(name);
    this.items = el ? this.collectItems(el) : [];
    if (el) el.scrollTop = 0;
    this.setFocus(0, false);
  }

  /** Gamepad / keyboard menu navigation. */
  navigate(nav: NavEvents, confirm: boolean): void {
    if (this.current === 'none' || this.current === 'error') return;
    if (nav.back) {
      this.back();
      return;
    }
    const n = this.items.length;
    if (n === 0) return;
    // On the controller screen the sticks are being tested: only d-pad / keys move the focus.
    const dirOk = this.current !== 'controller' || !this.stickDriven();
    if (dirOk && nav.up) this.setFocus((this.focus - 1 + n) % n);
    if (dirOk && nav.down) this.setFocus((this.focus + 1) % n);
    const item = this.items[this.focus];
    if (!item) return;
    if (dirOk && nav.left) item.adjust?.(-1);
    if (dirOk && nav.right) item.adjust?.(1);
    if (confirm) item.activate?.();
  }

  back(): void {
    switch (this.current) {
      case 'controller':
        if (this.capture.active) this.stopCapture('Remap cancelled');
        else this.show(this.controllerReturn);
        break;
      case 'rates':
        this.show(this.ratesReturn);
        break;
      case 'settings':
      case 'controls':
        this.show(this.returnTo);
        break;
      case 'pause':
      case 'confirm-quit':
        this.onAction({ type: 'resume' });
        break;
      case 'bye':
        this.onAction({ type: 'menu' });
        break;
      default:
        break;
    }
  }

  /** Live data for the controller setup screen; call every frame while it is open. */
  updateLive(input: InputFrame, dt: number, now: number): void {
    this.lastInput = input;
    if (this.current === 'rates') this.charts.updateLive(input.control, now);
    if (this.current !== 'controller') return;
    const L = this.live;
    const st = input.sticks;
    this.dot(L.wells.l.dot, st.lx, st.ly);
    this.dot(L.wells.r.dot, st.rx, st.ry);
    const c = input.control;
    for (const ch of CHANNELS) {
      const v = ch === 'throttle' ? c.throttle : c[ch];
      this.liveStyle(L.chans[ch].fill, ch === 'throttle' ? `scaleX(${v.toFixed(3)})` : `scaleX(${(v / 2).toFixed(3)})`);
    }
    const pad = input.pad;
    if (pad) {
      if (pad.axes.length !== this.axisRows.length) this.buildAxisRows(Math.min(pad.axes.length, MAX_AXIS_ROWS));
      for (let i = 0; i < this.axisRows.length; i++) this.liveStyle(this.axisRows[i]!.fill, `scaleX(${((pad.axes[i] ?? 0) / 2).toFixed(3)})`);
    } else if (this.axisRows.length) {
      this.buildAxisRows(0);
    }
    if (this.capture.active && pad) {
      const idx = this.capture.sample(pad.axes, dt);
      if (idx !== null && this.captureSlot) {
        if (idx < 0) this.stopCapture('No movement detected — try again');
        else {
          const slot = this.captureSlot;
          this.settings.axisMap[slot] = idx;
          this.emitSettings();
          this.stopCapture(`${SLOT_NAME[slot]} → axis ${idx} saved`);
        }
      }
    }
    if (now - this.liveTextAt < LIVE_TEXT_MS) return;
    this.liveTextAt = now;
    for (const ch of CHANNELS) {
      const v = ch === 'throttle' ? c.throttle : c[ch];
      const us = ch === 'throttle' ? 1000 + 1000 * v : 1500 + 500 * v;
      this.liveText(L.chans[ch].us, String(Math.round(us)));
      this.liveText(L.chans[ch].pct, `${Math.round(v * 100)}%`);
    }
    this.liveText(L.devName, pad ? pad.id : input.source === 'keyboard' ? 'Keyboard (virtual sticks: WASD + arrows)' : 'No gamepad — press any button on it');
    const std = pad ? pad.mapping === 'standard' : true;
    this.liveText(L.devMap, pad ? (std ? 'standard' : pad.mapping || '(none)') : '—');
    L.devMap.classList.toggle('is-bad', !std);
    L.devWarn.hidden = std;
    if (pad) {
      for (let i = 0; i < this.axisRows.length; i++) this.liveText(this.axisRows[i]!.val, (pad.axes[i] ?? 0).toFixed(2));
      let pressed = '';
      for (let i = 0; i < pad.buttons.length; i++) if ((pad.buttons[i] ?? 0) > 0.5) pressed += `${pressed ? ' ' : ''}B${i}`;
      this.liveText(L.buttons, pressed || '—');
    } else {
      this.liveText(L.buttons, '—');
    }
  }

  private stickDriven(): boolean {
    const inp = this.lastInput;
    if (!inp || inp.source !== 'gamepad' || !inp.pad) return false;
    const b = inp.pad.buttons;
    return !((b[12] ?? 0) > 0.5 || (b[13] ?? 0) > 0.5 || (b[14] ?? 0) > 0.5 || (b[15] ?? 0) > 0.5);
  }

  private setFocus(i: number, scroll = true): void {
    this.items[this.focus]?.el.classList.remove('is-focused');
    this.focus = i;
    const it = this.items[i];
    if (!it) return;
    it.el.classList.add('is-focused');
    if (scroll) it.el.scrollIntoView?.({ block: 'nearest' });
  }

  private collectItems(screen: HTMLElement): Item[] {
    const list: Item[] = [];
    screen.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
      if (el.closest('[hidden]')) return;
      const item: Item = { el };
      const act = el.dataset.act;
      const key = el.dataset.key;
      if (key) {
        item.adjust = (dir) => this.adjust(key, dir);
        item.activate = screen === this.screens.get('rates') && ROWS.get(key)?.kind === 'range' ? () => this.setFine(!this.fine) : () => this.adjust(key, 1);
      } else if (act) {
        item.activate = () => this.act(act);
      }
      list.push(item);
    });
    return list;
  }

  private act(act: string): void {
    switch (act) {
      case 'race':
      case 'freefly':
      case 'resume':
      case 'menu':
      case 'retry':
      case 'exit':
        this.onAction({ type: act });
        break;
      case 'settings':
      case 'controls':
      case 'controller':
      case 'rates':
        this.show(act);
        break;
      case 'back':
        this.back();
        break;
      case 'remap-lx':
      case 'remap-ly':
      case 'remap-rx':
      case 'remap-ry':
        this.startCapture(act.slice(6) as StickSlot);
        break;
      case 'remap-reset':
        this.settings.axisMap = { ...DEFAULT_AXIS_MAP };
        this.emitSettings();
        this.stopCapture('Mapping reset to standard (0, 1, 2, 3)');
        break;
      case 'reload':
        location.reload();
        break;
      case 'fullscreen':
        this.onAction({ type: 'fullscreen' });
        break;
    }
  }

  private startCapture(slot: StickSlot): void {
    const pad = this.lastInput?.pad;
    if (!pad) {
      this.stopCapture('Connect a gamepad and press a button on it first');
      return;
    }
    this.capture.start(pad.axes);
    this.captureSlot = slot;
    const ch = MODE_TABLE[this.settings.stickMode][slot];
    this.live.remapStatus.textContent = `Move ${SLOT_NAME[slot]} (${CH_NAME[ch]}) fully back and forth now…  B = cancel`;
    this.live.remapStatus.className = 'ds-remap__status is-live';
  }

  private stopCapture(msg: string): void {
    this.capture.cancel();
    this.captureSlot = null;
    if (!this.live) return;
    this.live.remapStatus.textContent = msg;
    this.live.remapStatus.className = 'ds-remap__status';
  }

  private adjust(id: string, dir: -1 | 1): void {
    const row = ROWS.get(id);
    if (!row) return;
    const s = this.settings;
    if (row.kind === 'enum') {
      const idx = row.options.findIndex((o) => o.value === row.get(s));
      const n = row.options.length;
      row.set(s, row.options[(Math.max(0, idx) + dir + n) % n]!.value);
    } else if (row.kind === 'range') {
      const { min, max } = row.range;
      const step = this.fine && this.current === 'rates' ? row.range.step / 5 : row.range.step;
      const v = Math.round((row.get(s) + dir * step) / step) * step;
      row.set(s, Math.min(max, Math.max(min, Number(v.toFixed(4)))));
    } else {
      row.set(s, !row.get(s));
    }
    this.emitSettings();
  }

  private emitSettings(): void {
    this.renderSettings();
    this.onAction({ type: 'settings', settings: cloneSettings(this.settings) });
  }

  private renderSettings(): void {
    const s = this.settings;
    for (const [id, list] of this.rowEls) {
      const row = ROWS.get(id)!;
      let text: string;
      let frac: number | null = null;
      if (row.kind === 'enum') {
        const v = row.get(s);
        text = row.options.find((o) => o.value === v)?.label ?? String(v);
      } else if (row.kind === 'range') {
        const v = row.get(s);
        text = row.fmt(v);
        frac = (v - row.range.min) / (row.range.max - row.range.min);
      } else {
        text = row.get(s) ? (row.on ?? 'On') : (row.off ?? 'Off');
      }
      for (const els of list) {
        if (els.value.textContent !== text) els.value.textContent = text;
        if (els.fill && frac !== null) els.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
        els.value.classList.toggle('is-alert', row.kind === 'bool' && id.startsWith('invert.') && row.get(s));
      }
      if (id === 'stickMode') {
        for (const els of list) {
          const h = els.value.closest('.ds-row')?.querySelector<HTMLElement>('.ds-row__hint');
          if (h) h.textContent = MODE_HINT[s.stickMode]!;
        }
      }
    }
    if (this.charts) {
      this.charts.redraw(s);
      this.ratesEls.preset.textContent = s.ratePreset === 'custom' ? 'Custom' : s.ratePreset[0]!.toUpperCase() + s.ratePreset.slice(1);
    }
    if (!this.live) return;
    // Controller screen: mode-dependent labels.
    const L = this.live;
    L.title.textContent = `Mode ${s.stickMode}`;
    const thr = throttleControl(s);
    for (const side of ['l', 'r'] as const) {
      const w = L.wells[side];
      const [v, h] = stickShort(s, side).split('·');
      w.v.textContent = v!;
      w.h.textContent = h!;
      w.well.classList.toggle('is-thr', (side === 'l' && thr === 'left') || (side === 'r' && thr === 'right'));
    }
    for (const slot of STICK_SLOTS) L.remapBtns[slot].textContent = `${SLOT_NAME[slot]} · ${CH_SHORT[MODE_TABLE[s.stickMode][slot]]} → axis ${s.axisMap[slot]}`;
    this.renderControls();
  }

  private renderControls(): void {
    const s = this.settings;
    const key = `${s.stickMode}|${s.throttleSource}`;
    if (key === this.controlsKey || !this.controlsBody) return;
    this.controlsKey = key;
    const pad = padControls(s);
    const kb = keyboardKeys(s);
    const thr = throttleControl(s);
    const map: [string, string, string][] = [
      ['Throttle', pad.throttle, kb.throttle],
      ['Yaw', pad.yaw, kb.yaw],
      ['Pitch', pad.pitch, kb.pitch],
      ['Roll', pad.roll, kb.roll],
      ['Arm / disarm', 'A', 'Space'],
      ['Flight mode', 'Y', 'M'],
      ['Camera', 'RB', 'C'],
      ['Reset to checkpoint', 'B', 'R'],
      ['Pause', 'Menu (☰)', 'Esc'],
    ];
    const rows = map.map(([a, x, k]) => `<tr><th scope="row">${a}</th><td>${x}</td><td><kbd class="ds-kbd">${k}</kbd></td></tr>`).join('');
    const tip =
      thr === 'rt'
        ? 'Arming needs throttle at zero: release RT, then press A.'
        : `Arming needs throttle at zero: hold the ${thr} stick fully down, then press A. The throttle axis does not re-centre in the sim — like a real radio.`;
    this.controlsBody.innerHTML = `
      <div class="ds-pad-wrap">${controllerDiagram({ left: stickLong(s, 'l'), right: stickLong(s, 'r'), rt: thr === 'rt' ? 'Throttle' : '—', thr })}</div>
      <table class="ds-table">
        <thead><tr><th>Action</th><th>Xbox controller</th><th>Keyboard</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="ds-tip">${tip}</p>`;
    const t = this.screens.get('controls')?.querySelector('[data-f="modeTag"]');
    if (t) t.textContent = `Mode ${s.stickMode}`;
  }

  private buildAxisRows(n: number): void {
    const box = this.live.axes;
    box.textContent = '';
    this.axisRows = [];
    for (let i = 0; i < n; i++) {
      const row = document.createElement('div');
      row.className = 'ds-axis';
      row.innerHTML = `<span class="ds-axis__i">A${i}</span><span class="ds-axis__bar"><span class="ds-axis__fill"></span></span><span class="ds-axis__v ds-num">0.00</span>`;
      box.appendChild(row);
      this.axisRows.push({ fill: row.querySelector<HTMLElement>('.ds-axis__fill')!, val: row.querySelector<HTMLElement>('.ds-axis__v')! });
    }
    if (n === 0) box.textContent = '—';
  }

  private dot(el: HTMLElement, x: number, y: number): void {
    // Dot is 1/8 of the well; travel ±0.42 well → ±336 % of the dot.
    this.liveStyle(el, `translate(-50%, -50%) translate(${(x * 336).toFixed(1)}%, ${(-y * 336).toFixed(1)}%)`);
  }

  private liveStyle(el: HTMLElement, t: string): void {
    const k = `s:${t}`;
    if (this.liveCache.get(el) === k) return;
    this.liveCache.set(el, k);
    el.style.transform = t;
  }

  private liveText(el: HTMLElement, t: string): void {
    if (this.liveCache.get(el) === t) return;
    this.liveCache.set(el, t);
    el.textContent = t;
  }

  private screen(name: string, inner: string): HTMLElement {
    const el = document.createElement('section');
    el.className = `ds-screen ds-screen--${name}`;
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    el.innerHTML = inner;
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-dir]')) return; // handled on pointerdown (hold to repeat)
      const navEl = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
      if (!navEl) return;
      const idx = this.items.findIndex((i) => i.el === navEl);
      if (idx >= 0) this.setFocus(idx);
      this.items[idx]?.activate?.();
    });
    el.addEventListener('pointerdown', (e) => {
      const dirBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]');
      const navEl = dirBtn?.closest<HTMLElement>('[data-nav]');
      if (!dirBtn || !navEl) return;
      e.preventDefault();
      const idx = this.items.findIndex((i) => i.el === navEl);
      const item = this.items[idx];
      if (!item?.adjust) return;
      this.setFocus(idx);
      const dir = dirBtn.dataset.dir === '-1' ? -1 : 1;
      item.adjust(dir);
      let timer = window.setTimeout(function repeat() {
        item.adjust!(dir);
        timer = window.setTimeout(repeat, 70);
      }, 400);
      const stop = (): void => {
        clearTimeout(timer);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        dirBtn.removeEventListener('pointerleave', stop);
      };
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      dirBtn.addEventListener('pointerleave', stop);
    });
    el.addEventListener('pointermove', (e) => {
      const navEl = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
      if (!navEl) return;
      const idx = this.items.findIndex((i) => i.el === navEl);
      if (idx >= 0 && idx !== this.focus) this.setFocus(idx);
    });
    return el;
  }

  private btn(act: string, label: string, primary = false, extra = '', attrs = ''): string {
    return `<button type="button" class="ds-btn${primary ? ' ds-btn--primary' : ''}${extra}" data-nav data-act="${act}"${attrs}><span>${label}</span></button>`;
  }

  private rowsHtml(ids: string[]): string {
    return ids
      .map((id) => {
        const r = ROWS.get(id)!;
        const track = r.kind === 'range' ? `<span class="ds-row__track" aria-hidden="true"><span class="ds-row__fill"></span></span>` : '';
        return `
        <div class="ds-row" data-nav data-key="${r.id}" role="group" aria-label="${r.label}"${TOUCH_ROWS.has(r.id) ? ' data-touch-only hidden' : ''}>
          <div class="ds-row__text"><span class="ds-row__label">${r.label}</span><span class="ds-row__hint">${r.hint}</span></div>
          <div class="ds-row__ctl">
            <button type="button" class="ds-arrow" data-dir="-1" aria-label="Previous ${r.label}" tabindex="-1">‹</button>
            <span class="ds-row__value" aria-live="polite"></span>
            <button type="button" class="ds-arrow" data-dir="1" aria-label="Next ${r.label}" tabindex="-1">›</button>
            ${track}
          </div>
        </div>`;
      })
      .join('');
  }

  private registerRows(el: HTMLElement): void {
    el.querySelectorAll<HTMLElement>('[data-key]').forEach((rowEl) => {
      const id = rowEl.dataset.key!;
      const list = this.rowEls.get(id) ?? [];
      list.push({ value: rowEl.querySelector<HTMLElement>('.ds-row__value')!, fill: rowEl.querySelector<HTMLElement>('.ds-row__fill') });
      this.rowEls.set(id, list);
    });
  }

  private buildMain(): HTMLElement {
    return this.screen(
      'main',
      `
      <div class="ds-main">
        <header class="ds-logo">
          <div class="ds-logo__ring" aria-hidden="true"><i></i><i></i></div>
          <h1 class="ds-logo__title" data-text="DRONE SIM">DRONE SIM</h1>
          <p class="ds-logo__sub">FPV Racing · Night Loft</p>
        </header>
        <nav class="ds-menu" aria-label="Main menu">
          ${this.btn('race', 'Race', true)}
          ${this.btn('freefly', 'Free Fly')}
          ${this.btn('settings', 'Settings')}
          ${this.btn('controls', 'Controls')}
          ${this.btn('exit', 'Quit', false, ' ds-btn--quit')}
        </nav>
        <p class="ds-main__best" data-f="best"></p>
        <footer class="ds-foot">
          <span><kbd class="ds-kbd ds-kbd--a">A</kbd><kbd class="ds-kbd">Enter</kbd> Select</span>
          <span><kbd class="ds-kbd ds-kbd--b">B</kbd><kbd class="ds-kbd">Esc</kbd> Back</span>
          <span><kbd class="ds-kbd">D-pad</kbd><kbd class="ds-kbd">↑↓</kbd> Move</span>
        </footer>
      </div>`,
    );
  }

  private buildSettings(): HTMLElement {
    const el = this.screen(
      'settings',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">Settings</h2>
        <div class="ds-rows">${this.rowsHtml(SETTINGS_ROWS)}</div>
        <div class="ds-dialog__actions">${this.btn('fullscreen', 'Full screen', false, ' ds-btn--ghost', ' data-fs-only hidden')}${this.btn('rates', 'Rates &amp; sensitivity ›', false, ' ds-btn--ghost')}${this.btn('controller', 'Controller setup ›', false, ' ds-btn--ghost')}${this.btn('back', 'Back')}</div>
        <p class="ds-foot ds-foot--inline"><span><kbd class="ds-kbd">←</kbd><kbd class="ds-kbd">→</kbd> Change</span><span><kbd class="ds-kbd ds-kbd--b">B</kbd> Back</span></p>
      </div>`,
    );
    this.registerRows(el);
    return el;
  }

  private buildController(): HTMLElement {
    const well = (side: 'l' | 'r', name: string) => `
      <figure class="ds-cwell-box">
        <span class="ds-cwell__v" data-w="${side}v">THR</span>
        <div class="ds-well ds-well--big" data-w="${side}"><i class="ds-well__cross"></i><i class="ds-well__rail"></i><i class="ds-well__dot"></i></div>
        <span class="ds-cwell__h" data-w="${side}h">YAW</span>
        <figcaption>${name}</figcaption>
      </figure>`;
    const chans = CHANNELS.map(
      (c) => `
        <div class="ds-chan${c === 'throttle' ? ' ds-chan--thr' : ''}" data-ch="${c}">
          <span class="ds-chan__name">${CH_SHORT[c]}</span>
          <span class="ds-chan__bar"><span class="ds-chan__mid"></span><span class="ds-chan__fill"></span></span>
          <span class="ds-num ds-chan__us"><b data-f="us">1500</b> µs</span>
          <span class="ds-num ds-chan__pct" data-f="pct">0%</span>
        </div>`,
    ).join('');
    const remap = STICK_SLOTS.map((s) => this.btn(`remap-${s}`, SLOT_NAME[s], false, ' ds-btn--sm')).join('');
    const el = this.screen(
      'controller',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--xwide ds-ctl">
        <h2 class="ds-dialog__title">Controller setup <small data-f="modeTitle">Mode 2</small></h2>
        <div class="ds-ctl__grid">
          <section class="ds-ctl__col">
            <div class="ds-ctl__sticks">${well('l', 'Left stick')}${well('r', 'Right stick')}</div>
            <div class="ds-rows">${this.rowsHtml(CONTROLLER_ROWS)}</div>
          </section>
          <section class="ds-ctl__col">
            <h3 class="ds-h3">Channels</h3>
            <div class="ds-chans">${chans}</div>
            <h3 class="ds-h3">Device</h3>
            <div class="ds-dev">
              <p class="ds-dev__name" data-f="devName">—</p>
              <p class="ds-dev__meta"><span class="ds-label">Mapping</span> <span class="ds-dev__map" data-f="devMap">—</span>
                <span class="ds-label">Buttons</span> <span class="ds-num" data-f="buttons">—</span></p>
              <p class="ds-dev__warn" data-f="devWarn" hidden>Non-standard mapping — sticks may be on other axes. Use Remap below.</p>
              <div class="ds-axes" data-f="axes">—</div>
            </div>
            <h3 class="ds-h3">Axis mapping</h3>
            <div class="ds-remap">${remap}${this.btn('remap-reset', 'Reset mapping', false, ' ds-btn--sm')}</div>
            <p class="ds-remap__status" data-f="remapStatus">Select a stick axis, then move that stick.</p>
          </section>
        </div>
        <div class="ds-dialog__actions">${this.btn('rates', 'Rates &amp; sensitivity ›', false, ' ds-btn--ghost')}${this.btn('back', 'Back', true)}</div>
      </div>`,
    );
    this.registerRows(el);
    return el;
  }

  private setFine(on: boolean): void {
    this.fine = on;
    if (!this.ratesEls) return;
    this.ratesEls.box.classList.toggle('is-fine', on);
    this.ratesEls.fine.textContent = on ? 'Fine step ON · A to toggle' : 'A / Enter on a value: fine step';
  }

  private buildRates(): HTMLElement {
    const cell = (a: RateAxis, f: RateField) => `
      <td><div class="ds-cell" data-nav data-key="rate.${a}.${f}" role="group" aria-label="${a} ${FIELD_NAME[f]}">
        <button type="button" class="ds-arrow" data-dir="-1" aria-label="Decrease" tabindex="-1">‹</button>
        <span class="ds-row__value ds-num"></span>
        <button type="button" class="ds-arrow" data-dir="1" aria-label="Increase" tabindex="-1">›</button>
      </div></td>`;
    const body = RATE_AXES.map((a) => `<tr><th scope="row" class="is-${a}">${a.toUpperCase()}</th>${RATE_FIELDS.map((f) => cell(a, f)).join('')}</tr>`).join('');
    const el = this.screen(
      'rates',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--xwide ds-rates">
        <h2 class="ds-dialog__title">Rates &amp; sensitivity <small data-f="preset">Freestyle</small></h2>
        <div class="ds-ctl__grid">
          <section class="ds-ctl__col">
            <div class="ds-rows">${this.rowsHtml(['ratePreset', 'linkRollPitch'])}</div>
            <table class="ds-rtable">
              <thead><tr><th></th><th>Center <small>°/s</small></th><th>Max rate <small>°/s</small></th><th>Expo</th></tr></thead>
              <tbody>${body}</tbody>
            </table>
            <p class="ds-help">Center sensitivity: rotation rate around stick centre. Max rate: rate at full stick. Expo: softens the centre.</p>
            <p class="ds-help ds-help--fine" data-f="fine">A / Enter on a value: fine step</p>
            <h3 class="ds-h3">Throttle</h3>
            <div class="ds-rows">${this.rowsHtml(['throttleMid', 'throttleExpo', 'throttleLimit'])}</div>
            <p class="ds-help">Mid: output at stick centre (Auto = hover). Expo: finer control around mid. Limit: caps full throttle.</p>
            <h3 class="ds-h3">Angle mode &amp; sticks</h3>
            <div class="ds-rows">${this.rowsHtml(['angleMaxTiltDeg', 'deadzone'])}</div>
            <p class="ds-help">Max tilt: how far Angle mode leans at full stick. Deadzone: ignored stick travel at centre.</p>
          </section>
          <section class="ds-ctl__col">
            <h3 class="ds-h3">Rate preview <small>deg/s vs stick</small></h3>
            <div class="ds-chart" data-f="rateChart"></div>
            <h3 class="ds-h3">Throttle curve <small>output vs stick</small></h3>
            <div class="ds-chart" data-f="thrChart"></div>
          </section>
        </div>
        <div class="ds-dialog__actions">${this.btn('back', 'Back', true)}</div>
      </div>`,
    );
    this.registerRows(el);
    this.charts = new RateCharts(el.querySelector<HTMLElement>('[data-f="rateChart"]')!, el.querySelector<HTMLElement>('[data-f="thrChart"]')!);
    this.ratesEls = {
      preset: el.querySelector<HTMLElement>('[data-f="preset"]')!,
      fine: el.querySelector<HTMLElement>('[data-f="fine"]')!,
      box: el.querySelector<HTMLElement>('.ds-rates')!,
    };
    return el;
  }

  private buildControls(): HTMLElement {
    return this.screen(
      'controls',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">Controls <small data-f="modeTag">Mode 2</small></h2>
        <p class="ds-tip" data-touch-only hidden>Touch: put a thumb anywhere on the left or right half — the stick appears under it. The throttle stick (magenta) holds where you let go, like a real radio. Pull it fully down, then tap ARM. Buttons: ARM, MODE (Angle/Acro), CAM, RESET, pause.</p>
        <div data-f="body"></div>
        <div class="ds-dialog__actions">${this.btn('controller', 'Controller setup ›', false, ' ds-btn--ghost')}${this.btn('back', 'Back', true)}</div>
      </div>`,
    );
  }

  private buildPause(): HTMLElement {
    return this.screen(
      'pause',
      `
      <div class="ds-panel ds-glass ds-dialog">
        <h2 class="ds-dialog__title">Paused</h2>
        <nav class="ds-menu">
          ${this.btn('resume', 'Resume', true)}
          ${this.btn('retry', 'Restart')}
          ${this.btn('settings', 'Settings')}
          ${this.btn('controls', 'Controls')}
          ${this.btn('menu', 'Quit to menu', false, ' ds-btn--quit')}
        </nav>
      </div>`,
    );
  }

  private buildConfirmQuit(): HTMLElement {
    return this.screen(
      'confirm-quit',
      `
      <div class="ds-panel ds-glass ds-dialog">
        <h2 class="ds-dialog__title">Quit?</h2>
        <p class="ds-dialog__text">Leave this flight and return to the main menu. The current run is not saved.</p>
        <nav class="ds-menu">
          ${this.btn('menu', 'Quit to menu', true, ' ds-btn--quit')}
          ${this.btn('resume', 'Cancel')}
        </nav>
      </div>`,
    );
  }

  private buildBye(): HTMLElement {
    return this.screen(
      'bye',
      `
      <div class="ds-panel ds-glass ds-dialog">
        <h2 class="ds-dialog__title">Drone Sim closed</h2>
        <p class="ds-dialog__text">Sound is off. You can close this browser tab now.</p>
        <nav class="ds-menu">
          ${this.btn('menu', 'Back to game', true)}
        </nav>
      </div>`,
    );
  }

  private buildFinish(): HTMLElement {
    return this.screen(
      'finish',
      `
      <div class="ds-panel ds-glass ds-dialog ds-finish">
        <p class="ds-finish__kicker">Finish</p>
        <span class="ds-badge-new" data-f="badge" hidden>New best</span>
        <div class="ds-finish__time" data-f="time">--:--.--</div>
        <p class="ds-finish__best"><span class="ds-label">Best</span> <span data-f="best">--:--.--</span></p>
        <nav class="ds-menu ds-menu--row">
          ${this.btn('retry', 'Retry', true)}
          ${this.btn('menu', 'Menu')}
        </nav>
      </div>`,
    );
  }

  private buildError(): HTMLElement {
    return this.screen(
      'error',
      `
      <div class="ds-panel ds-glass ds-dialog ds-error">
        <h2 class="ds-dialog__title">Can't start the simulator</h2>
        <p class="ds-error__msg" data-f="msg"></p>
        <div class="ds-dialog__actions">${this.btn('reload', 'Reload', true)}</div>
      </div>`,
    );
  }
}
