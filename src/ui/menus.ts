/** Menu screens (main, settings, controller setup, rates, controls, about, pause, finish, error) with mouse / keyboard / gamepad focus. */
import { detectDevice } from '../core/device';
import {
  DEFAULT_AXIS_MAP,
  DEFAULT_SETTINGS,
  RATE_AXES,
  SETTINGS_OPTIONS,
  applyRatePreset,
  cloneSettings,
  rateEditReplacesCustom,
  rateRange,
  setRateValue,
  type RateAxis,
  type RateField,
  type Settings,
} from '../core/settings';
import { isQuestBrowser } from '../core/xr';
import { AxisCapture, MODE_TABLE, STICK_SLOTS, type Channel, type StickSlot } from '../input/stick';
import type { InputFrame, LevelId, NavEvents } from '../types';
import { formatTime } from './format';
import { drawThumbs, levelAct, levelCardsHtml, parseLevelAct, type LevelCard, type LevelMode } from './level-select';
import { controllerDiagram } from './icons';
import { actionGlyphs, channelHints, glyphHtml, glyphsHtml, keyGlyph, type HintAction, type HintScheme } from './input-glyphs';
import { HOVER, RateCharts } from './rate-charts';
import { CH_NAME, CH_SHORT, effectiveFovDeg, stickLong, stickShort, throttleControl } from './mode-labels';

/** package.json version, injected by vite.config.ts `define`. */
declare const __APP_VERSION__: string;

export const APP_VERSION = __APP_VERSION__;
export const SUPPORT_EMAIL = 'support@coworkgamestudio.com';
/** The bundled copy inside the iOS / Android shells cannot open in the system browser: link the hosted one there. */
const SITE_URL = 'https://dronesim.coworkgamestudio.com/';

export type ScreenName =
  | 'main'
  | 'levels'
  | 'settings'
  | 'controller'
  | 'rates'
  | 'controls'
  | 'about'
  | 'pause'
  | 'finish'
  | 'error'
  | 'confirm-quit'
  | 'confirm-reset'
  | 'bye'
  | 'none';

export type UiAction =
  | { type: 'race' }
  | { type: 'freefly' }
  /** level picker: switch to that level (if needed) and start a run */
  | { type: 'level'; id: LevelId; mode: LevelMode; /** Infinite: the world to play */ seed?: number }
  | { type: 'resume' }
  | { type: 'menu' }
  | { type: 'retry' }
  /** start (or replay) the tutorial on the Training field */
  | { type: 'tutorial' }
  /** pause menu while the tutorial runs: end it for good (no first-run prompt again) */
  | { type: 'skip-tutorial' }
  /** HUD quit button: pause and ask for confirmation */
  | { type: 'request-quit' }
  /** leave the game (close tab when allowed) */
  | { type: 'exit' }
  /** touch devices: toggle the Fullscreen API (needs the tap gesture) */
  | { type: 'fullscreen' }
  /** WebXR headsets: start an immersive-vr session (needs the click gesture) */
  | { type: 'enter-vr' }
  | { type: 'settings'; settings: Settings };

export interface FinishData {
  time?: number;
  best?: number | null;
  newBest?: boolean;
  /** best time before this run; when omitted the last best the menus were shown is used */
  prevBest?: number | null;
}

/** Where the game runs: decides platform-specific copy (quit, error advice, links). */
type Platform = 'ios' | 'android' | 'quest' | 'desktop';

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

type NumKey = 'cameraTiltDeg' | 'fovDeg' | 'volume' | 'deadzone' | 'throttleExpo' | 'throttleLimit' | 'angleMaxTiltDeg' | 'mouseSensitivity' | 'mouseExpo' | 'mouseDeadzone';
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

const ACTION_ROWS: readonly [string, HintAction][] = [
  ['Arm / disarm', 'arm'],
  ['Flight mode', 'toggleMode'],
  ['Camera', 'cycleCamera'],
  ['Reset to checkpoint', 'reset'],
  ['Pause', 'pause'],
  ['Heading arrow', 'headingArrow'],
];
const FOV_HINT = 'FPV lens width';
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const MOUSE_STICK_LABEL: Record<Settings['mouseStick'], string> = { auto: 'Auto', hold: 'Hold', spring: 'Spring' };
const FIELD_NAME: Record<RateField, string> = { center: 'Center sensitivity', max: 'Max rate', expo: 'Expo' };
const rateCell = (axis: RateAxis, field: RateField): Row => ({
  id: `rate.${axis}.${field}`,
  label: `${axis[0]!.toUpperCase()}${axis.slice(1)} ${FIELD_NAME[field].toLowerCase()}`,
  hint: '',
  kind: 'range',
  range: rateRange(field),
  // fine steps land between the 0.01 expo grid: show the third decimal only then, so the cell matches the stored value
  fmt: (v) => (field === 'expo' ? v.toFixed(Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? 3 : 2) : String(Math.round(v))),
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
    hint: 'Angle self-levels (like DJI "A"/Atti) · Acro holds attitude (rate mode)',
    kind: 'enum',
    options: [
      { value: 'angle', label: 'Angle' },
      { value: 'acro', label: 'Acro' },
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
  rangeRow('throttleLimit', 'Throttle limit', 'Caps full-stick output; centre stick still hovers', (v) => `${Math.round(v * 100)}%`),
  rangeRow('angleMaxTiltDeg', 'Max tilt angle', 'Angle mode: tilt at full stick', (v) => `${Math.round(v)}°`),
  rangeRow('cameraTiltDeg', 'Camera tilt', 'FPV camera uptilt', (v) => `${Math.round(v)}°`),
  rangeRow('fovDeg', 'Field of view', FOV_HINT, (v) => `${Math.round(v)}°`),
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
  {
    id: 'headingArrow',
    label: 'Heading arrow',
    hint: 'Arrow under the quad pointing where the nose faces (VR: left trigger)',
    kind: 'bool',
    get: (s) => s.headingArrow,
    set: (s, v) => {
      s.headingArrow = v;
    },
  },
  rangeRow('deadzone', 'Stick deadzone', 'Radial deadzone for worn sticks', (v) => v.toFixed(2)),
  {
    id: 'mouseStick',
    label: 'Mouse stick',
    hint: 'Auto: Angle hold / Acro spring · Hold stays put · Spring re-centres',
    kind: 'enum',
    options: SETTINGS_OPTIONS.mouseStick.map((m) => ({ value: m, label: MOUSE_STICK_LABEL[m] })),
    get: (s) => s.mouseStick,
    set: (s, v) => {
      s.mouseStick = v as Settings['mouseStick'];
    },
  },
  rangeRow('mouseSensitivity', 'Mouse sensitivity', 'Stick travel per mouse movement', pct),
  {
    id: 'mouseInvertY',
    label: 'Invert mouse Y',
    hint: 'Off: push the mouse away to pitch forward, like a stick',
    kind: 'bool',
    on: 'Inverted',
    off: 'Normal',
    get: (s) => s.mouseInvertY,
    set: (s, v) => {
      s.mouseInvertY = v;
    },
  },
  {
    id: 'mouseXAxis',
    label: 'Mouse X axis',
    hint: 'What left / right flies (Yaw moves roll onto the yaw keys)',
    kind: 'enum',
    options: SETTINGS_OPTIONS.mouseXAxis.map((a) => ({ value: a, label: a === 'roll' ? 'Roll' : 'Yaw' })),
    get: (s) => s.mouseXAxis,
    set: (s, v) => {
      s.mouseXAxis = v as Settings['mouseXAxis'];
    },
  },
  rangeRow('mouseExpo', 'Mouse expo', 'Softens small mouse movements', pct),
  rangeRow('mouseDeadzone', 'Mouse deadzone', 'Mouse travel around centre that reads as centred', pct),
  {
    id: 'touchThrottleCentre',
    label: 'Touch throttle',
    hint: 'Auto-centre: stick springs back, centre holds altitude (DJI-style) · Hold: stays where released like an FPV radio',
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
/** Rows hidden on touch devices (pointer-lock mouse flight is a desktop feature). */
const MOUSE_ROWS: ReadonlySet<string> = new Set(['mouseStick', 'mouseSensitivity', 'mouseInvertY', 'mouseXAxis', 'mouseExpo', 'mouseDeadzone']);
const ROWS = new Map(ROW_DEFS.map((r) => [r.id, r]));
const SETTINGS_ROWS = ['stickMode', 'touchThrottleCentre', 'touchSticksFixed', 'throttleSource', 'flightMode', 'ratePreset', 'cameraTiltDeg', 'fovDeg', 'quality', 'volume', 'showFps', 'headingArrow', 'deadzone', ...MOUSE_ROWS];
const CONTROLLER_ROWS = ['stickMode', 'throttleSource', 'squareGate', 'invert.throttle', 'invert.yaw', 'invert.pitch', 'invert.roll'];
const CHANNELS: readonly Channel[] = ['throttle', 'yaw', 'pitch', 'roll'];
const SLOT_NAME: Record<StickSlot, string> = { lx: 'LX', ly: 'LY', rx: 'RX', ry: 'RY' };
const LIVE_TEXT_MS = 50;
const DELTA_FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const MAX_AXIS_ROWS = 12;
const ERROR_ADVICE: Record<Platform, (native: boolean) => string> = {
  ios: (native) =>
    `Update iOS in Settings › General › Software Update, then ${native ? 'reopen the app' : 'reload this page'}.${native ? '' : ' Every browser on iPhone and iPad uses Apple’s WebKit engine, so a different browser won’t help.'}`,
  android: (native) =>
    native
      ? 'Update Android System WebView and Chrome from Google Play, then reopen the app.'
      : 'Update Chrome (or your browser) from Google Play, then reload this page.',
  quest: () => 'Close and reopen Meta Quest Browser, or update the headset in Settings › System › Software Update.',
  desktop: () => 'Turn on hardware acceleration in your browser settings, update your graphics driver, or try a recent Chrome, Edge, Firefox or Safari.',
};
const REMAP_PROMPT = 'Select a stick axis, then move that stick.';
/** Settings rows that open a screen or dialog instead of cycling a value. */
const SETTINGS_ACTION_ROWS: { act: string; label: string; hint: string; danger?: boolean }[] = [
  { act: 'about', label: 'About', hint: `Version ${APP_VERSION}, support, privacy policy and licences` },
  { act: 'confirm-reset', label: 'Reset all settings', hint: 'Controls, rates, mapping, graphics and sound back to defaults', danger: true },
];
/** Stick (left / right) carrying throttle for the mode, regardless of the RT option (touch and VR always use a stick). */
const throttleSlotSide = (s: Settings): 'left' | 'right' => (throttleControl({ stickMode: s.stickMode, throttleSource: 'stick' }) === 'left' ? 'left' : 'right');

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
  private ratesEls!: { preset: HTMLElement; fine: HTMLElement; box: HTMLElement; replaceHint: HTMLElement };
  private settings: Settings;
  private readonly rowEls = new Map<string, { value: HTMLElement; fill: HTMLElement | null }[]>();
  private readonly finishEls: { time: HTMLElement; best: HTMLElement; bestLabel: HTMLElement; delta: HTMLElement; badge: HTMLElement };
  private readonly errorMsg: HTMLElement;
  private readonly altHoldNote: HTMLElement;
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
  private aboutReturn: ScreenName = 'main';
  /** touch device (set by enableTouch) */
  private touch = false;
  private tutorial = false;
  /** immersive VR available (set by enableVr) */
  private vr = false;
  /** a gamepad is connected (live, from updateLive) */
  private padPresent = false;
  /** Controls screen: gamepad / keyboard section expanded on a touch device */
  private controlsMore = false;
  /** best lap last shown on the main menu or finish screen: the "previous best" of the next new record */
  private knownBest: number | null = null;
  private levelCards: readonly LevelCard[] = [];
  private currentLevel: LevelId | null = null;
  private levelsKey = '';
  private readonly levelsBox: HTMLElement;
  private menuBestValue: number | null = null;
  private readonly platform: Platform;
  /** installed app (Capacitor shell or home-screen / Quest app) rather than a browser tab */
  private readonly installed: boolean;
  private readonly native: boolean;
  private readonly quest: boolean;

  constructor(
    private readonly root: HTMLElement,
    private readonly onAction: (a: UiAction) => void,
    settings: Settings,
  ) {
    this.settings = cloneSettings(settings);
    const dev = detectDevice(window);
    this.quest = isQuestBrowser(navigator.userAgent) && 'xr' in navigator;
    this.platform = dev.ios ? 'ios' : this.quest ? 'quest' : /Android/i.test(navigator.userAgent) || dev.native === 'android' ? 'android' : 'desktop';
    this.installed = dev.standalone;
    this.native = dev.native !== null;
    this.screens.set('main', this.buildMain());
    this.screens.set('levels', this.buildLevels());
    this.screens.set('settings', this.buildSettings());
    const ctl = this.buildController();
    this.screens.set('controller', ctl);
    this.screens.set('rates', this.buildRates());
    const controls = this.buildControls();
    this.screens.set('controls', controls);
    this.screens.set('about', this.buildAbout());
    this.screens.set('pause', this.buildPause());
    this.screens.set('confirm-quit', this.buildConfirmQuit());
    this.screens.set('confirm-reset', this.buildConfirmReset());
    this.screens.set('bye', this.buildBye());
    const fin = this.buildFinish();
    this.screens.set('finish', fin);
    const err = this.buildError();
    this.screens.set('error', err);
    const q = <T extends HTMLElement = HTMLElement>(el: HTMLElement, sel: string): T => el.querySelector<T>(sel)!;
    this.finishEls = {
      time: q(fin, '[data-f="time"]'),
      best: q(fin, '[data-f="best"]'),
      bestLabel: q(fin, '[data-f="bestLabel"]'),
      delta: q(fin, '[data-f="delta"]'),
      badge: q(fin, '[data-f="badge"]'),
    };
    this.errorMsg = q(err, '[data-f="msg"]');
    this.altHoldNote = q(this.screens.get('rates')!, '[data-f="altHold"]');
    this.menuBest = q(this.screens.get('main')!, '[data-f="best"]');
    this.levelsBox = q(this.screens.get('levels')!, '[data-f="levelCards"]');
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
    this.applyGates();
    this.renderSettings();
  }

  setSettings(s: Settings): void {
    this.settings = cloneSettings(s);
    this.renderSettings();
  }

  /** Touch device: reveal touch-only rows/tips; `fullscreen` also shows the Full screen button. */
  enableTouch(fullscreen: boolean): void {
    this.touch = true;
    for (const el of this.screens.values()) {
      el.querySelectorAll<HTMLElement>('[data-touch-only]').forEach((x) => {
        x.hidden = false;
      });
      el.querySelectorAll<HTMLElement>('[data-mouse-only]').forEach((x) => {
        x.hidden = true;
      });
      if (fullscreen) {
        el.querySelectorAll<HTMLElement>('[data-fs-only]').forEach((x) => {
          x.hidden = false;
        });
      }
    }
    this.applyGates();
    this.renderSettings();
    this.refreshItems();
  }

  /** iOS app: no Quit (apps must not close themselves); the menu stays as the home screen. */
  hideExit(): void {
    for (const el of this.screens.values()) {
      el.querySelectorAll<HTMLElement>('[data-act="exit"]').forEach((x) => {
        x.hidden = true;
      });
    }
    this.refreshItems();
  }

  /** While the tutorial runs the pause menu offers Replay / Skip tutorial instead of Restart. */
  setTutorial(on: boolean): void {
    if (on === this.tutorial) return;
    this.tutorial = on;
    for (const el of this.screens.values()) {
      el.querySelectorAll<HTMLElement>('[data-tut-only]').forEach((x) => {
        x.hidden = !on;
      });
      el.querySelectorAll<HTMLElement>('[data-no-tut]').forEach((x) => {
        x.hidden = on;
      });
    }
    this.refreshItems();
  }

  /** WebXR headset (immersive-vr supported): reveal the Enter VR button. */
  enableVr(): void {
    this.vr = true;
    for (const el of this.screens.values()) {
      el.querySelectorAll<HTMLElement>('[data-vr-only]').forEach((x) => {
        x.hidden = false;
      });
    }
    this.renderSettings();
    this.refreshItems();
  }

  /** Re-reads the focusable items of the open screen after elements were shown / hidden, keeping the focused one. */
  private refreshItems(): void {
    if (this.current === 'none') return;
    const was = this.items[this.focus]?.el ?? null;
    was?.classList.remove('is-focused');
    this.items = this.collectItems(this.screens.get(this.current)!);
    const i = was ? this.items.findIndex((it) => it.el === was) : -1;
    this.setFocus(i >= 0 ? i : Math.max(0, Math.min(this.focus, this.items.length - 1)), false);
  }

  /** Shows gamepad / keyboard-only hints unless this is a touch device without a pad; pad-only controls need a pad. */
  private applyGates(): void {
    const padUi = !this.touch || this.padPresent;
    const pad = this.padPresent;
    for (const el of this.screens.values()) {
      el.querySelectorAll<HTMLElement>('[data-pad-only],[data-needs-pad],[data-no-pad]').forEach((x) => {
        x.hidden = (x.hasAttribute('data-pad-only') && !padUi) || (x.hasAttribute('data-needs-pad') && !pad) || (x.hasAttribute('data-no-pad') && pad);
      });
    }
    if (this.live && !this.capture.active) {
      const idle = pad ? REMAP_PROMPT : '';
      if (this.live.remapStatus.textContent !== idle) this.stopCapture(idle);
    }
  }

  setMenuBest(best: number | null): void {
    // a stored best never goes away: null only means "not known here" (e.g. the menu before any race)
    if (best !== null) this.knownBest = best;
    this.menuBestValue = best;
    this.renderMenuBest();
  }

  /** Main-menu level button under the menu: the selected level and its best lap; it opens the level picker. */
  private renderMenuBest(): void {
    const name = this.levelCards.find((c) => c.id === this.currentLevel)?.name ?? '';
    const best = this.menuBestValue === null ? '' : `Best lap ${formatTime(this.menuBestValue)}`;
    const text = name ? (best ? `Level: ${name} · ${best}` : `Level: ${name}`) : best;
    if (this.menuBest.textContent !== text) this.menuBest.textContent = text;
    const btn = this.menuBest.parentElement!;
    if (btn.hidden !== !name) {
      btn.hidden = !name;
      if (this.current === 'main') this.refreshItems();
    }
  }

  /** Level picker contents: one card per playable level; `current` is the level loaded now. */
  setLevels(cards: readonly LevelCard[], current: LevelId): void {
    if (current !== this.currentLevel) {
      // the finish screen's "previous best" belongs to one level only
      this.knownBest = null;
      this.menuBestValue = null;
    }
    this.levelCards = cards;
    this.currentLevel = current;
    this.renderMenuBest();
    const key = JSON.stringify([cards, current]);
    if (key === this.levelsKey) return;
    this.levelsKey = key;
    const focusedAct = this.current === 'levels' ? (this.items[this.focus]?.el.dataset.act ?? null) : null;
    this.levelsBox.innerHTML = levelCardsHtml(cards, current);
    drawThumbs(this.levelsBox);
    if (this.current !== 'levels') return;
    this.refreshItems();
    const i = focusedAct ? this.items.findIndex((it) => it.el.dataset.act === focusedAct) : -1;
    if (i >= 0) this.setFocus(i, false);
  }

  /** Open the picker focused on the current level's Race or Free Fly button. */
  private openLevels(mode: LevelMode): void {
    this.show('levels');
    const act = this.currentLevel ? levelAct(mode, this.currentLevel) : null;
    const i = act ? this.items.findIndex((it) => it.el.dataset.act === act) : -1;
    this.setFocus(Math.max(0, i), false);
  }

  /** Left / right on a card button: the same button on the neighbouring card. */
  private moveCard(el: HTMLElement, dir: -1 | 1): void {
    const parsed = parseLevelAct(el.dataset.act ?? '');
    if (!parsed) return;
    const ids = this.levelCards.map((c) => c.id);
    const k = ids.indexOf(parsed.id as LevelId);
    if (k < 0 || ids.length < 2) return;
    const target = levelAct(parsed.mode, ids[(k + dir + ids.length) % ids.length]!);
    const i = this.items.findIndex((it) => it.el.dataset.act === target);
    if (i >= 0) this.setFocus(i);
  }

  /** Fatal start-up error: friendly, platform-specific advice; `msg` goes under "Technical details". */
  setError(msg: string): void {
    this.errorMsg.textContent = msg;
    this.show('error');
  }

  show(name: ScreenName, data?: FinishData): void {
    if (this.current === 'error' && name !== 'error') return;
    if ((name === 'settings' || name === 'controls') && (this.current === 'main' || this.current === 'pause')) this.returnTo = this.current;
    if (name === 'controller' && (this.current === 'settings' || this.current === 'controls')) this.controllerReturn = this.current;
    if (name === 'rates' && (this.current === 'settings' || this.current === 'controller')) this.ratesReturn = this.current;
    if (name === 'about' && (this.current === 'main' || this.current === 'settings')) this.aboutReturn = this.current;
    if (name !== 'rates') this.setFine(false);
    if (name !== 'controller') this.stopCapture('');
    if (name === 'finish' && data) this.renderFinish(data);
    if (name === 'settings') this.renderFovHint();
    this.current = name;
    for (const [n, el] of this.screens) {
      const on = n === name;
      el.classList.toggle('is-open', on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
      el.inert = !on;
    }
    this.root.classList.toggle('has-screen', name !== 'none');
    const el = this.screens.get(name);
    // unmark the old item before the list changes, or the old index would unmark the wrong element
    this.items[this.focus]?.el.classList.remove('is-focused');
    this.items = el ? this.collectItems(el) : [];
    if (el) el.scrollTop = 0;
    // Dialogs with a destructive choice start on the safe one (data-autofocus).
    this.setFocus(Math.max(0, this.items.findIndex((it) => it.el.hasAttribute('data-autofocus'))), false);
  }

  private renderFinish(data: FinishData): void {
    const F = this.finishEls;
    const time = data.time ?? null;
    const prev = data.prevBest !== undefined ? data.prevBest : this.knownBest;
    F.time.textContent = formatTime(time);
    F.badge.hidden = !data.newBest;
    let label = 'Best';
    let best = data.best ?? null;
    let delta: number | null = null;
    if (data.newBest) {
      // a new record would only repeat the big time as "best": compare with the record it beat
      label = 'Previous best';
      best = prev !== null && prev !== time ? prev : null;
      if (best !== null && time !== null) delta = time - best;
    } else if (best !== null && time !== null) {
      delta = time - best;
    }
    F.bestLabel.textContent = label;
    F.best.textContent = best === null ? '—' : formatTime(best);
    F.delta.textContent = delta === null ? '' : `${DELTA_FMT.format(delta).replace('-', '−')} s`;
    // signed like the shown text: a delta that rounds to 0.00 s is neither faster nor slower
    const shown = delta === null ? 0 : Math.round(delta * 100);
    F.delta.dataset.sign = shown < 0 ? 'faster' : shown > 0 ? 'slower' : '';
    F.delta.hidden = delta === null;
    F.bestLabel.parentElement!.hidden = data.newBest === true && best === null;
    if (data.best !== undefined) this.knownBest = data.best ?? null;
  }

  /** Gamepad / keyboard menu navigation. */
  navigate(nav: NavEvents, confirm: boolean): void {
    if (this.current === 'none') return;
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
      case 'about':
        this.show(this.aboutReturn);
        break;
      case 'confirm-reset':
        this.show('settings');
        break;
      case 'levels':
        this.show('main');
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
    if (!!input.pad !== this.padPresent) {
      this.padPresent = !!input.pad;
      this.applyGates();
      this.renderSettings();
      this.refreshItems();
    }
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
        item.activate = screen === this.screens.get('rates') && key.startsWith('rate.') ? () => this.setFine(!this.fine) : () => this.adjust(key, 1);
      } else if (act) {
        item.activate = () => this.act(act);
        if (parseLevelAct(act)) item.adjust = (dir) => this.moveCard(el, dir);
      } else if (el instanceof HTMLAnchorElement) {
        item.activate = () => el.click();
      }
      list.push(item);
    });
    return list;
  }

  private act(act: string): void {
    const lvl = parseLevelAct(act);
    if (lvl) {
      const card = this.levelCards.find((c) => c.id === lvl.id);
      if (card) this.onAction({ type: 'level', id: card.id, mode: lvl.mode });
      return;
    }
    switch (act) {
      case 'levels-race':
        this.openLevels('race');
        break;
      case 'levels-freefly':
        this.openLevels('freefly');
        break;
      case 'race':
      case 'freefly':
      case 'resume':
      case 'menu':
      case 'retry':
      case 'exit':
      case 'enter-vr':
      case 'tutorial':
      case 'skip-tutorial':
        this.onAction({ type: act });
        break;
      case 'settings':
      case 'controls':
      case 'controller':
      case 'rates':
      case 'about':
      case 'confirm-reset':
        this.show(act);
        break;
      case 'reset-all':
        this.settings = cloneSettings(DEFAULT_SETTINGS);
        this.emitSettings();
        this.show('settings');
        break;
      case 'controls-more':
        this.controlsMore = !this.controlsMore;
        this.renderControls();
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
      const step = this.fine && this.current === 'rates' && id.startsWith('rate.') ? row.range.step / 5 : row.range.step;
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
      this.ratesEls.replaceHint.hidden = !rateEditReplacesCustom(s);
    }
    this.renderFovHint();
    if (this.altHoldNote) {
      const touchHold = this.touch && !this.padPresent && s.touchThrottleCentre;
      const vr = this.quest || this.vr;
      const who = touchHold && vr ? 'With touch auto-centre and in VR' : touchHold ? 'With touch auto-centre' : 'In VR';
      const text = touchHold || vr ? `${who} the throttle stick holds altitude at centre, so throttle mid, expo and limit don't apply there.` : '';
      if (this.altHoldNote.textContent !== text) this.altHoldNote.textContent = text;
      this.altHoldNote.hidden = !text;
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

  /** FOV row hint: the FPV camera caps its vertical FOV, so a narrow screen shows less than the setting. */
  private renderFovHint(): void {
    const list = this.rowEls.get('fovDeg');
    if (!list) return;
    const set = this.settings.fovDeg;
    const eff = Math.round(effectiveFovDeg(set, window.innerWidth / window.innerHeight));
    const text = eff < Math.round(set) ? `${FOV_HINT} · this screen shows ${eff}°` : FOV_HINT;
    for (const els of list) {
      const h = els.value.closest('.ds-row')?.querySelector<HTMLElement>('.ds-row__hint');
      if (h && h.textContent !== text) h.textContent = text;
    }
  }

  private renderControls(): void {
    const s = this.settings;
    const touchFirst = this.touch && !this.padPresent;
    const xr = this.quest || this.vr;
    const key = `${s.stickMode}|${s.throttleSource}|${s.touchThrottleCentre}|${s.touchSticksFixed}|${this.touch}|${this.padPresent}|${xr}|${this.controlsMore}`;
    if (key === this.controlsKey || !this.controlsBody) return;
    this.controlsKey = key;
    const touchHtml = this.touchControlsHtml(s);
    // headset without a paired gamepad: an Xbox diagram shows the wrong controller; the table covers Touch
    const padHtml = this.padControlsHtml(s, xr, !xr || this.padPresent);
    let html: string;
    if (touchFirst) {
      html = `${touchHtml}${this.controlsMore ? `<h3 class="ds-h3">Gamepad &amp; keyboard</h3>${padHtml}` : ''}`;
    } else {
      html = this.touch ? `${padHtml}<h3 class="ds-h3">Touch</h3>${touchHtml}` : padHtml;
    }
    this.controlsBody.innerHTML = html;
    const screen = this.screens.get('controls');
    const t = screen?.querySelector('[data-f="modeTag"]');
    if (t) t.textContent = `Mode ${s.stickMode}`;
    const more = screen?.querySelector<HTMLElement>('[data-act="controls-more"]');
    if (more) {
      more.hidden = !touchFirst;
      more.setAttribute('aria-expanded', String(this.controlsMore));
      more.firstElementChild!.textContent = this.controlsMore ? 'Hide gamepad ‹' : 'Gamepad ›';
    }
    if (this.current === 'controls') this.refreshItems();
  }

  private touchControlsHtml(s: Settings): string {
    const arrows = { throttle: '↕', yaw: '↔', pitch: '↕', roll: '↔' } as const;
    const chan = channelHints('touch', s).map((c) => `${glyphsHtml(c.glyphs)}<small class="ds-table__note">${arrows[c.channel]}</small>`);
    const btn = (t: string): string => `<kbd class="ds-g ds-g--touch">${t}</kbd>`;
    const rows: [string, string][] = [
      ['Throttle', chan[0]!],
      ['Yaw', chan[1]!],
      ['Pitch', chan[2]!],
      ['Roll', chan[3]!],
      ['Arm / disarm', btn('ARM')],
      ['Flight mode (Angle / Acro)', btn('MODE')],
      ['Camera', btn('CAM')],
      ['Reset to checkpoint', btn('RESET ↺')],
      ['Pause', `${btn('❚❚')}<small class="ds-table__note">top left</small>`],
    ];
    const where = s.touchSticksFixed
      ? 'Use the two sticks in the bottom corners.'
      : 'Put a thumb anywhere on the left or right half — the stick appears under it.';
    const thr = s.touchThrottleCentre
      ? 'The throttle stick (magenta) springs back to centre, and centre holds altitude. Tap ARM, then push the throttle up to take off.'
      : 'The throttle stick (magenta) holds where you let go, like a real radio. Pull it fully down, then tap ARM.';
    return `
      <table class="ds-table" data-f="touchTable">
        <thead><tr><th>Action</th><th>Touch</th></tr></thead>
        <tbody>${rows.map(([a, x]) => `<tr><th scope="row">${a}</th><td>${x}</td></tr>`).join('')}</tbody>
      </table>
      <p class="ds-tip" data-f="touchTip">${where} ${thr}</p>`;
  }

  private padControlsHtml(s: Settings, xr: boolean, diagram: boolean): string {
    const thr = throttleControl(s);
    const note = (t: string): string => (t ? `<small class="ds-table__note">${t}</small>` : '');
    const chans = (scheme: HintScheme): string[] => channelHints(scheme, s).map((c) => `${glyphsHtml(c.glyphs)}${note(c.note)}`);
    const act = (scheme: HintScheme, a: HintAction): string => {
      const g = actionGlyphs(scheme, a);
      if (!g.length) return '<span class="ds-table__none">—</span>';
      return `${glyphsHtml(g)}${g[0]!.style === 'stick' ? note('click') : ''}`;
    };
    const [vT, vY, vP, vR] = chans('quest');
    const [pT, pY, pP, pR] = chans('xbox');
    const [kT, kY, kP, kR] = chans('keyboard');
    const map: [string, string, string, string][] = [
      ['Throttle', vT!, pT!, kT!],
      ['Yaw', vY!, pY!, kY!],
      ['Pitch', vP!, pP!, kP!],
      ['Roll', vR!, pR!, kR!],
      ...ACTION_ROWS.map(([label, a]): [string, string, string, string] => [label, act('quest', a), act('xbox', a), act('keyboard', a)]),
      [xr ? 'Recentre view' : 'Recentre view (VR)', act('quest', 'recenter'), act('xbox', 'recenter'), act('keyboard', 'recenter')],
      ['Mouse flight', '<span class="ds-table__none">—</span>', '<span class="ds-table__none">—</span>', `${glyphHtml({ style: 'mouse', label: '', name: 'Mouse' })}${note(`click the view · ${glyphHtml(keyGlyph('Escape'))} frees it`)}`],
    ];
    const rows = map.map(([a, v, x, k]) => `<tr><th scope="row">${a}</th>${xr ? `<td>${v}</td>` : ''}<td>${x}</td><td>${k}</td></tr>`).join('');
    const kbTip = 'Keyboard: keys spring back like a stick and centre holds altitude; press Space to arm, then hold W (↑ in modes 1/3) to take off.';
    const padTip =
      thr === 'rt'
        ? 'Arming needs throttle at zero: release RT, then press A.'
        : `Arming needs throttle at zero: hold the ${thr} stick fully down, then press A. The throttle does not re-centre — like a real radio.`;
    // next to the VR note the two would contradict (Touch sticks spring back, a gamepad throttle does not)
    const tip = `${xr ? `Gamepad: ${padTip.charAt(0).toLowerCase()}${padTip.slice(1)}` : padTip} ${kbTip}`;
    const thrXr = throttleSlotSide(s);
    const xrTip = xr
      ? `<p class="ds-tip" data-f="xrTip">VR: the Touch controller sticks spring back — the ${thrXr} stick's centre holds altitude and the other stick's centre holds position. Press A to arm, then push the ${thrXr} stick up to take off.</p>`
      : '';
    return `
      ${diagram ? `<div class="ds-pad-wrap">${controllerDiagram({ left: stickLong(s, 'l'), right: stickLong(s, 'r'), rt: thr === 'rt' ? 'Throttle' : null, thr })}</div>` : ''}
      <table class="ds-table" data-f="padTable">
        <thead><tr><th>Action</th>${xr ? '<th>Touch controllers</th>' : ''}<th>Xbox controller</th><th>Keyboard</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.quest ? xrTip : ''}<p class="ds-tip" data-f="padTip">${tip}</p>${this.quest ? '' : xrTip}`;
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
      if (navEl instanceof HTMLAnchorElement) return; // the link opens natively
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
        <div class="ds-row" data-nav data-key="${r.id}" role="group" aria-label="${r.label}"${TOUCH_ROWS.has(r.id) ? ' data-touch-only hidden' : MOUSE_ROWS.has(r.id) ? ' data-mouse-only' : ''}>
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

  /** Link rows that open a screen: label + chevron, no value cell, so they never read as a stepper. */
  private actionRowsHtml(): string {
    return SETTINGS_ACTION_ROWS.map(
      (r) => `
        <div class="ds-row ds-row--link${r.danger ? ' ds-row--danger' : ''}" data-nav data-act="${r.act}" role="button" aria-label="${r.label}">
          <div class="ds-row__text"><span class="ds-row__label">${r.label}</span><span class="ds-row__hint">${r.hint}</span></div>
          <span class="ds-row__chev" aria-hidden="true">›</span>
        </div>`,
    ).join('');
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
          <p class="ds-logo__sub">FPV Racing Simulator</p>
        </header>
        <nav class="ds-menu" aria-label="Main menu">
          ${this.btn('enter-vr', 'Enter VR', false, '', ' data-vr-only hidden')}
          ${this.btn('levels-race', 'Race', true)}
          ${this.btn('levels-freefly', 'Free Fly')}
          ${this.btn('tutorial', 'Tutorial')}
          ${this.btn('settings', 'Settings')}
          ${this.btn('controls', 'Controls')}
          ${this.btn('about', 'About')}
          ${this.btn('exit', 'Quit', false, ' ds-btn--quit', ' style="grid-column:1/-1"')}
        </nav>
        <button type="button" class="ds-main__level" data-nav data-act="levels-race" hidden><span data-f="best"></span><span class="ds-main__chev" aria-hidden="true">›</span></button>
        <footer class="ds-foot" data-pad-only>
          <span><kbd class="ds-kbd ds-kbd--a">A</kbd><kbd class="ds-kbd">Enter</kbd> Select</span>
          <span><kbd class="ds-kbd ds-kbd--b">B</kbd><kbd class="ds-kbd">Esc</kbd> Back</span>
          <span><kbd class="ds-kbd">D-pad</kbd><kbd class="ds-kbd">↑↓</kbd> Move</span>
        </footer>
      </div>`,
    );
  }

  private buildLevels(): HTMLElement {
    return this.screen(
      'levels',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--xwide ds-levels">
        <h2 class="ds-dialog__title">Choose a level</h2>
        <div class="ds-levels__grid" data-f="levelCards"></div>
        <div class="ds-dialog__actions">
          <p class="ds-foot ds-levels__foot" data-pad-only><span><kbd class="ds-kbd">←</kbd><kbd class="ds-kbd">→</kbd> Level</span><span><kbd class="ds-kbd">↑</kbd><kbd class="ds-kbd">↓</kbd> Race / Free Fly</span></p>
          ${this.btn('back', 'Back', true)}
        </div>
      </div>`,
    );
  }

  private buildSettings(): HTMLElement {
    const el = this.screen(
      'settings',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">Settings</h2>
        <div class="ds-rows">${this.rowsHtml(SETTINGS_ROWS)}${this.actionRowsHtml()}</div>
        <div class="ds-dialog__actions">${this.btn('fullscreen', 'Full screen', false, ' ds-btn--ghost', ' data-fs-only hidden')}${this.btn('rates', 'Rates ›', false, ' ds-btn--ghost')}${this.btn('controller', 'Controller ›', false, ' ds-btn--ghost')}${this.btn('back', 'Back', true)}</div>
        <p class="ds-foot ds-foot--inline" data-pad-only><span><kbd class="ds-kbd">←</kbd><kbd class="ds-kbd">→</kbd> Change</span><span><kbd class="ds-kbd ds-kbd--b">B</kbd> Back</span></p>
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
    const remap = STICK_SLOTS.map((s) => this.btn(`remap-${s}`, SLOT_NAME[s], false, ' ds-btn--sm', ' data-needs-pad hidden')).join('');
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
              <p class="ds-dev__name" data-f="devName" data-needs-pad hidden>—</p>
              <p class="ds-dev__meta" data-needs-pad hidden><span class="ds-label">Mapping</span> <span class="ds-dev__map" data-f="devMap">—</span>
                <span class="ds-label">Buttons</span> <span class="ds-num" data-f="buttons">—</span></p>
              <p class="ds-dev__warn" data-f="devWarn" hidden>Non-standard mapping — sticks may be on other axes. Use Remap below.</p>
              <div class="ds-axes" data-f="axes" data-needs-pad hidden></div>
              <p class="ds-dev__name" data-no-pad data-f="devEmpty">${this.quest ? 'No gamepad connected' : 'No controller connected'}</p>
              ${
                this.quest
                  ? '<p class="ds-help" data-no-pad>In VR you fly with the Touch controllers — no gamepad needed. To use one, pair a Bluetooth gamepad with the headset and press any button on it; its sticks, axes and remap options appear here.</p>'
                  : `<p class="ds-help" data-no-pad>Connect a Bluetooth or USB controller, then press any button on it. Its sticks, axes and remap options appear here.</p>
              <p class="ds-help" data-no-pad data-pad-only>Keyboard: WASD and the arrow keys work as the two sticks.</p>`
              }
            </div>
            <h3 class="ds-h3" data-needs-pad hidden>Axis mapping</h3>
            <div class="ds-remap" data-needs-pad hidden>${remap}${this.btn('remap-reset', 'Reset mapping', false, ' ds-btn--sm')}</div>
            <p class="ds-remap__status" data-f="remapStatus" data-needs-pad hidden></p>
          </section>
        </div>
        <div class="ds-dialog__actions">${this.btn('rates', 'Rates ›', false, ' ds-btn--ghost')}${this.btn('back', 'Back', true)}</div>
      </div>`,
    );
    this.registerRows(el);
    return el;
  }

  private setFine(on: boolean): void {
    this.fine = on;
    if (!this.ratesEls) return;
    this.ratesEls.box.classList.toggle('is-fine', on);
    this.ratesEls.fine.textContent = on ? 'Fine step ON · A / Enter to toggle' : 'A / Enter on a rate value: fine step';
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
            <p class="ds-tip" data-f="replaceHint" hidden>Editing a value replaces your saved Custom rates with this preset plus your change.</p>
            <p class="ds-help">Center sensitivity: rotation rate around stick centre. Max rate: rate at full stick. Expo: softens the centre.</p>
            <p class="ds-help">Roll/pitch rates apply in Acro mode; Angle mode self-levels (see Max tilt below). Yaw rate applies in both.</p>
            <p class="ds-help ds-help--fine" data-f="fine" data-pad-only>A / Enter on a rate value: fine step</p>
            <h3 class="ds-h3">Throttle</h3>
            <div class="ds-rows">${this.rowsHtml(['throttleMid', 'throttleExpo', 'throttleLimit'])}</div>
            <p class="ds-help">Mid: output at stick centre (Auto = hover). Expo: finer control around mid. Limit: caps full throttle.</p>
            <p class="ds-tip" data-f="altHold" hidden></p>
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
      replaceHint: el.querySelector<HTMLElement>('[data-f="replaceHint"]')!,
    };
    return el;
  }

  private buildControls(): HTMLElement {
    return this.screen(
      'controls',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">Controls <small data-f="modeTag">Mode 2</small></h2>
        <div data-f="body"></div>
        <div class="ds-dialog__actions">${this.btn('controls-more', 'Gamepad ›', false, ' ds-btn--ghost', ' aria-expanded="false" hidden')}${this.btn('controller', 'Controller ›', false, ' ds-btn--ghost')}${this.btn('back', 'Back', true)}</div>
      </div>`,
    );
  }

  private buildAbout(): HTMLElement {
    // the web game lives one level down (/play/, /app/); privacy and licences sit at the site root
    const base = this.native ? SITE_URL : '../';
    // Inline style: links styled as buttons must not show the anchor underline (no CSS rule in this module's scope).
    const link = (href: string, label: string, ext: boolean): string =>
      `<a class="ds-btn ds-btn--sm ds-btn--ghost" data-nav href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}><span>${label}</span></a>`;
    const oss: [string, string][] = [
      ['three.js', 'MIT'],
      ['postprocessing', 'Zlib'],
      ['Capacitor', 'MIT'],
      ['IWER', 'MIT'],
      ['gl-matrix', 'MIT'],
      ['WebXR Layers polyfill', 'Apache-2.0'],
    ];
    return this.screen(
      'about',
      `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">About</h2>
        <table class="ds-table">
          <tbody>
            <tr><th scope="row">App</th><td>Drone Sim</td></tr>
            <tr><th scope="row">Version</th><td data-f="version">${APP_VERSION}</td></tr>
            <tr><th scope="row">Developer</th><td>COWORK Game Studio</td></tr>
            <tr><th scope="row">Support</th><td>${SUPPORT_EMAIL}</td></tr>
          </tbody>
        </table>
        <h3 class="ds-h3">Open-source software</h3>
        <p class="ds-help">${oss.map(([n, l]) => `${n} (${l})`).join(' · ')}. Full licence texts are included with the app.</p>
        <div class="ds-dialog__actions ds-about__links">
          ${link(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Drone Sim ${APP_VERSION}`)}`, 'Email support', false)}
          ${link(`${base}privacy/`, 'Privacy policy ↗', true)}
          ${link(`${base}licenses.txt`, 'Licences ↗', true)}
        </div>
        <div class="ds-dialog__actions">${this.btn('back', 'Back', true)}</div>
      </div>`,
    );
  }

  private buildConfirmReset(): HTMLElement {
    return this.screen(
      'confirm-reset',
      `
      <div class="ds-panel ds-glass ds-dialog">
        <h2 class="ds-dialog__title">Reset settings?</h2>
        <p class="ds-dialog__text">Every setting — controls, rates, controller mapping, graphics and sound — goes back to its default. Best times are&nbsp;kept.</p>
        <nav class="ds-menu">
          ${this.btn('reset-all', 'Reset all', false, ' ds-btn--quit')}
          ${this.btn('back', 'Cancel', true, '', ' data-autofocus')}
        </nav>
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
          ${this.btn('retry', 'Restart', false, '', ' data-no-tut')}
          ${this.btn('tutorial', 'Replay tutorial', false, '', ' data-tut-only hidden')}
          ${this.btn('skip-tutorial', 'Skip tutorial', false, '', ' data-tut-only hidden')}
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
          ${this.btn('menu', 'Quit to menu', false, ' ds-btn--quit')}
          ${this.btn('resume', 'Cancel', true, '', ' data-autofocus')}
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
        <p class="ds-dialog__text" data-f="byeText">${this.installed || this.native ? 'Sound is off. You can now close Drone&nbsp;Sim.' : 'Sound is off. You can now close this&nbsp;tab.'}</p>
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
        <p class="ds-finish__best"><span class="ds-label" data-f="bestLabel">Best</span> <span data-f="best">--:--.--</span> <span data-f="delta" hidden></span></p>
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
        <h2 class="ds-dialog__title">Can’t start the simulator</h2>
        <p class="ds-dialog__text">Drone Sim couldn’t start 3D graphics on this&nbsp;${this.native ? 'device' : 'browser'}.</p>
        <p class="ds-dialog__text" data-f="advice">${ERROR_ADVICE[this.platform](this.native)}</p>
        <details class="ds-help ds-dialog__text">
          <summary>Technical details</summary>
          <p class="ds-error__msg" data-f="msg"></p>
        </details>
        <nav class="ds-menu">${this.btn('reload', this.native ? 'Try again' : 'Reload', true)}</nav>
      </div>`,
    );
  }
}
