/** In-flight HUD + menu screens as a DOM overlay. update() is cheap enough to call every frame. */
import './styles.css';
import { DEFAULT_SETTINGS, defaultStorage, type Settings } from '../core/settings';
import type { CameraMode, DroneState, FlightMode, GameEvent, InputFrame, InputSource, LevelId, NavEvents, QualityTier, RaceSnapshot, RaceStatus } from '../types';
import { formatDelta, formatTime } from './format';
import { ICON_GAMEPAD, ICON_KEYBOARD, ICON_NONE, ICON_TOUCH } from './icons';
import type { LevelCard } from './level-select';
import { Menus, type FinishData, type ScreenName, type UiAction } from './menus';
import { throttleSlot } from '../input/stick';
import { stickShort, throttleControl, throttleDownHint } from './mode-labels';
import { KEY_STICKS, type InputExtras } from '../input/input-manager';
import { isCanvas, pointerLockSupported, releasePointerLock, requestPointerLock } from '../input/mouse';
import { ACTION_LABEL, actionGlyphs, channelHints, glyphHtml, glyphsHtml, hintScheme, keyCluster, keyGlyph, padGlyph, type HintAction, type HintScheme } from './input-glyphs';
import { CH_NAME } from './mode-labels';
import { GP } from '../input/gamepad';

export type { UiAction, ScreenName, FinishData } from './menus';

export interface HudFrame {
  race: RaceSnapshot;
  drone: DroneState;
  /** the input manager's frame carries the hint extras; previews / tests may leave them out */
  input: InputFrame & Partial<InputExtras>;
  fps: number;
  mode: FlightMode;
  camera: CameraMode;
  altitude: number;
  speed: number;
  tier: QualityTier;
  settings: Settings;
}

/** Numeric text refresh interval (ms) — ~20 Hz is plenty for humans and avoids DOM churn at 120 fps. */
const TEXT_INTERVAL = 50;
const STICK_TRAVEL = 0.36; // fraction of the stick-well diameter the dot can travel from centre
/** mouse stick dot travel in % of the dot (dot = 1/6 of the circle, edge at 0.42 of the diameter) */
const MOUSE_TRAVEL = 0.42 * 600;
const CAMERA_LABEL: Record<CameraMode, string> = { fpv: 'FPV', chase: 'CHASE', los: 'LOS' };
const CELLS = 4;
/** localStorage: 'open' / 'closed' once the pilot has seen (or toggled) the Controls legend */
export const LEGEND_STORE_KEY = 'drone-sim.controls-legend';
const FLIGHT_STATES: ReadonlySet<RaceStatus> = new Set(['countdown', 'racing', 'freefly', 'crashed']);
const SCHEME_NAME: Record<HintScheme, string> = {
  keyboard: 'Keyboard',
  xbox: 'Xbox',
  playstation: 'PlayStation',
  generic: 'Gamepad',
  quest: 'Quest Touch',
  touch: 'Touch',
};

type Ref =
  | 'time'
  | 'timeLabel'
  | 'best'
  | 'bestRow'
  | 'gates'
  | 'ringCur'
  | 'ringTot'
  | 'pips'
  | 'split'
  | 'mode'
  | 'modeText'
  | 'cam'
  | 'armed'
  | 'armedText'
  | 'fps'
  | 'quit'
  | 'center'
  | 'centerSub'
  | 'hint'
  | 'speed'
  | 'alt'
  | 'batt'
  | 'battCell'
  | 'thrFill'
  | 'thrVal'
  | 'srcIcon'
  | 'srcName'
  | 'stickL'
  | 'stickR'
  | 'wellL'
  | 'wellR'
  | 'lblL'
  | 'lblR'
  | 'flash'
  | 'toasts'
  | 'gArm'
  | 'gMode'
  | 'gCam'
  | 'gThr'
  | 'binds'
  | 'keysL'
  | 'keysR'
  | 'cmap'
  | 'mstick'
  | 'mdot'
  | 'mlbl';

const HUD_HTML = `
<div class="ds-hud" aria-hidden="false">
  <div class="ds-flash" data-r="flash"></div>
  <div class="ds-hud__tl ds-panel">
    <span class="ds-label" data-r="timeLabel">Time</span>
    <div class="ds-timer" data-r="time">00:00.00</div>
    <div class="ds-sub" data-r="bestRow"><span class="ds-label">Best</span><span class="ds-num" data-r="best">--:--.--</span></div>
  </div>
  <div class="ds-hud__tc">
    <div class="ds-gates ds-panel" data-r="gates">
      <span class="ds-label">Gate</span>
      <span class="ds-gates__num"><b data-r="ringCur">0</b><i>/</i><span data-r="ringTot">0</span></span>
      <div class="ds-pips" data-r="pips"></div>
    </div>
    <div class="ds-split" data-r="split"></div>
  </div>
  <div class="ds-hud__tr">
    <span class="ds-chip ds-armed" data-r="armed"><span class="ds-chip__g" data-r="gArm"></span><i class="ds-dot"></i><span data-r="armedText">DISARMED</span></span>
    <span class="ds-chip ds-chip--mode" data-r="mode"><span class="ds-chip__g" data-r="gMode"></span><span data-r="modeText">ANGLE</span></span>
    <span class="ds-chip ds-chip--cam"><span class="ds-chip__g" data-r="gCam"></span><span data-r="cam">FPV</span></span>
    <span class="ds-chip ds-chip--fps" data-r="fps">— fps</span>
    <button type="button" class="ds-chip ds-chip--quit" data-r="quit" aria-label="Quit flight">✕ Quit</button>
    <div class="ds-binds" data-r="binds"></div>
  </div>
  <section class="ds-cmap ds-panel" data-r="cmap" aria-label="Controls" hidden></section>
  <div class="ds-center">
    <div class="ds-center__big" data-r="center"></div>
    <div class="ds-center__sub" data-r="centerSub"></div>
  </div>
  <div class="ds-hint" data-r="hint"></div>
  <div class="ds-hud__bl ds-panel">
    <div class="ds-thr" aria-label="Throttle">
      <div class="ds-thr__bar"><div class="ds-thr__fill" data-r="thrFill"></div></div>
      <span class="ds-label">Thr</span><span class="ds-thr__g" data-r="gThr"></span>
      <span class="ds-num ds-thr__val" data-r="thrVal">0</span>
    </div>
    <div class="ds-tele">
      <div class="ds-tele__speed"><span class="ds-num ds-big" data-r="speed">0</span><span class="ds-unit">km/h</span></div>
      <div class="ds-tele__row"><span class="ds-label">Alt</span><span class="ds-num" data-r="alt">0.0</span><span class="ds-unit">m</span></div>
      <div class="ds-tele__row" data-r="batt"><span class="ds-label">Bat</span><span class="ds-num" data-r="battCell">16.8</span><span class="ds-unit">V</span></div>
    </div>
  </div>
  <div class="ds-hud__br ds-panel">
    <div class="ds-mstick" data-r="mstick" hidden><div class="ds-mstick__well"><i class="ds-mstick__ring"></i><i class="ds-mstick__dot" data-r="mdot"></i></div><span class="ds-mstick__lbl" data-r="mlbl"></span></div>
    <div class="ds-src"><span class="ds-src__icon" data-r="srcIcon"></span><span class="ds-src__name" data-r="srcName">No input</span></div>
    <div class="ds-sticks">
      <div class="ds-stick"><div class="ds-well" data-r="wellL"><i class="ds-well__cross"></i><i class="ds-well__rail"></i><i class="ds-well__dot" data-r="stickL"></i></div><span class="ds-stick__lbl" data-r="lblL">THR·YAW</span><span class="ds-stick__keys" data-r="keysL"></span></div>
      <div class="ds-stick"><div class="ds-well" data-r="wellR"><i class="ds-well__cross"></i><i class="ds-well__rail"></i><i class="ds-well__dot" data-r="stickR"></i></div><span class="ds-stick__lbl" data-r="lblR">PIT·ROL</span><span class="ds-stick__keys" data-r="keysR"></span></div>
    </div>
  </div>
  <div class="ds-toasts" data-r="toasts" role="status" aria-live="polite"></div>
</div>`;

/** state classes `setCenter` toggles on the centre title and its wrapper */
const CENTER_KINDS = ['is-crash', 'is-count', 'is-go', 'is-ok', 'is-dim', 'is-warn'] as const;

export class Hud {
  private readonly root: HTMLElement;
  private readonly refs: Record<Ref, HTMLElement>;
  private readonly menus: Menus;
  private readonly textCache = new Map<HTMLElement, string>();
  private readonly styleCache = new Map<HTMLElement, string>();
  private lastText = -Infinity;
  private status: RaceStatus | null = null;
  /** the centre shows the out-of-bounds countdown (cleared on return or respawn) */
  private outOfBounds = false;
  private nextRing = -1;
  private totalRings = -1;
  private pipEls: HTMLElement[] = [];
  private countdown = -1;
  private flashAt = -Infinity;
  private source: InputSource | null = null;
  private settingsRef: Settings | null = null;
  private stickL = [9, 9];
  private stickR = [9, 9];
  private throttle = 9;
  private lastUpdate = -Infinity;
  private goTimer: ReturnType<typeof setTimeout> | null = null;
  private free: boolean | null = null;
  /** Free-fly session clock (s): the race clock stays at 0 outside a race. */
  private flightTime = 0;
  private hintKey = '';
  private hintSettings: Settings | null = null;
  private hintHtml = '';
  private mouseLbl = '';
  private legendOpen = false;
  private legendStored: 'open' | 'closed' | null = null;
  private wasFlying = false;
  /** flight view without a menu over it: pointer lock may be taken, the legend toggles */
  private flightView = false;
  /** the tutorial runs: on a keyboard Esc skips it instead of pausing */
  private tutorial = false;
  private readonly storage: Storage | null;

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.flightView || e.pointerType !== 'mouse' || e.button !== 0) return;
    if (!isCanvas(e.target) || this.root.classList.contains('is-touch')) return;
    requestPointerLock(e.target);
  };

  constructor(root: HTMLElement, onAction: (a: UiAction) => void, storage: Storage | null = defaultStorage()) {
    this.root = root;
    this.storage = storage;
    try {
      const v = storage?.getItem(LEGEND_STORE_KEY);
      this.legendStored = v === 'open' || v === 'closed' ? v : null;
    } catch {
      this.legendStored = null;
    }
    root.classList.add('ds-ui');
    const hud = document.createElement('div');
    hud.innerHTML = HUD_HTML;
    const hudEl = hud.firstElementChild as HTMLElement;
    root.appendChild(hudEl);
    const refs = {} as Record<Ref, HTMLElement>;
    hudEl.querySelectorAll<HTMLElement>('[data-r]').forEach((el) => {
      refs[el.dataset.r as Ref] = el;
    });
    this.refs = refs;
    this.menus = new Menus(root, onAction, { ...DEFAULT_SETTINGS });
    refs.quit.addEventListener('click', () => onAction({ type: 'request-quit' }));
    refs.binds.addEventListener('click', (e) => {
      if ((e.target as Element | null)?.closest?.('[data-legend]')) this.toggleLegend();
    });
    root.ownerDocument.addEventListener('pointerdown', this.onPointerDown);
    this.setStatus('menu');
    this.setSource('none');
  }

  /** Per-frame HUD refresh. Only changed values touch the DOM; numeric text is throttled to ~20 Hz. */
  update(f: HudFrame): void {
    const r = this.refs;
    const race = f.race;
    const now = performance.now();

    const dt = Number.isFinite(this.lastUpdate) ? Math.min(0.1, (now - this.lastUpdate) / 1000) : 0;
    this.lastUpdate = now;
    if (f.settings !== this.settingsRef) {
      this.settingsRef = f.settings;
      this.menus.setSettings(f.settings);
      this.root.classList.toggle('ds-hide-fps', !f.settings.showFps);
      this.text(r.lblL, stickShort(f.settings, 'l'));
      this.text(r.lblR, stickShort(f.settings, 'r'));
      const thr = throttleControl(f.settings);
      r.wellL.classList.toggle('is-thr', thr === 'left');
      r.wellR.classList.toggle('is-thr', thr === 'right');
    }
    this.menus.updateLive(f.input, dt, now);
    if (race.status !== this.status) this.setStatus(race.status);
    if (race.status === 'freefly' || (race.status === 'crashed' && race.nextRing < 0)) this.flightTime += dt;
    if (race.status === 'menu') this.menus.setMenuBest(race.bestTime);
    this.updateRings(race, now);
    this.updateCountdown(race);
    const free = race.nextRing < 0;
    if (free !== this.free) {
      this.free = free;
      r.gates.hidden = free;
      r.bestRow.hidden = free;
    }

    const textDue = now - this.lastText >= TEXT_INTERVAL;
    if (textDue) {
      this.lastText = now;
      this.text(r.timeLabel, free ? 'Flight' : 'Time');
      this.text(r.time, formatTime(free ? this.flightTime : race.time));
      this.text(r.best, formatTime(race.bestTime));
      this.text(r.speed, String(Math.round(f.speed * 3.6)));
      this.text(r.alt, Math.max(0, f.altitude).toFixed(1));
      const v = f.drone.batteryVoltage;
      this.text(r.battCell, v.toFixed(1));
      const cell = v / CELLS;
      this.cls(r.batt, cell < 3.3 ? 'is-crit' : cell < 3.55 ? 'is-warn' : '');
      this.text(r.fps, `${Math.round(f.fps)} fps · ${f.tier}`);
      this.text(r.thrVal, `${Math.round(f.input.control.throttle * 100)}%`);
    }

    this.text(r.modeText, f.mode === 'acro' ? 'ACRO' : 'ANGLE');
    this.cls(r.mode, f.mode === 'acro' ? 'is-acro' : '');
    this.text(r.cam, CAMERA_LABEL[f.camera]);
    const armed = f.drone.armed;
    this.text(r.armedText, armed ? 'ARMED' : 'DISARMED');
    this.cls(r.armed, armed ? 'is-on' : '');

    if (f.input.source !== this.source) this.setSource(f.input.source);
    const flying = FLIGHT_STATES.has(race.status);
    if (flying !== this.wasFlying) {
      this.wasFlying = flying;
      if (flying) this.legendOpen = this.legendStored !== 'closed';
    }
    // the first flight shows the legend; back at the main menu it collapses for good (until toggled)
    if (race.status === 'menu' && this.legendStored === null && this.legendOpen) {
      this.legendOpen = false;
      this.storeLegend('closed');
    }
    this.flightView = flying && this.menus.current === 'none';
    if (!this.flightView) releasePointerLock(this.root.ownerDocument);
    else if (f.input.legend) this.toggleLegend();
    this.updateBindings(f);
    this.updateHint(f);
    this.updateSticks(f.input);
    this.updateMouseStick(f.input);
  }

  showScreen(s: 'main' | 'levels' | 'pause' | 'finish' | 'none' | 'settings' | 'controls' | 'controller' | 'rates' | 'confirm-quit' | 'confirm-reset' | 'about' | 'bye', data?: FinishData & { best?: number | null }): void {
    if (s === 'main' && data && 'best' in data) this.menus.setMenuBest(data.best ?? null);
    if (s === 'bye') this.clearToasts();
    this.menus.show(s as ScreenName, data);
  }

  /** Level picker cards and the level loaded now (main-menu level line). */
  setLevels(cards: readonly LevelCard[], current: LevelId): void {
    this.menus.setLevels(cards, current);
  }

  /** Currently open menu screen ('none' while flying). */
  get screen(): ScreenName {
    return this.menus.current;
  }

  /** iOS app: hide the main-menu Quit button. */
  hideExit(): void {
    this.menus.hideExit();
  }

  /** WebXR headset: show the Enter VR button on the main menu. */
  enableVr(): void {
    this.menus.enableVr();
  }

  /** Touch device: `is-touch` styling (44 pt targets, pan-y dialogs) and touch-only settings rows. */
  enableTouch(fullscreen: boolean): void {
    this.root.classList.add('is-touch');
    this.menus.enableTouch(fullscreen);
  }

  navigate(nav: NavEvents, confirm: boolean): void {
    this.menus.navigate(nav, confirm);
  }

  /** The tutorial is running: the pause menu offers Replay / Skip tutorial. */
  setTutorial(on: boolean): void {
    this.tutorial = on;
    this.menus.setTutorial(on);
  }

  /** Keeps the settings screen in sync when settings change outside it (e.g. Y toggles flight mode). */
  setSettings(s: Settings): void {
    this.menus.setSettings(s);
  }

  /** Optional: flashes / popups driven by simulation events. */
  handleEvent(e: GameEvent): void {
    switch (e.type) {
      case 'ring-passed':
        this.ringFlash(performance.now());
        break;
      case 'crash':
        this.flash('is-crash');
        break;
      case 'armed':
        // The armed chip already shows it; a centre pulse would replace the countdown digit or CRASHED.
        if (this.status !== 'racing' && this.status !== 'freefly') break;
        this.centerPulse(e.armed ? 'ARMED' : 'DISARMED', e.armed ? 'is-ok' : 'is-dim', 700);
        break;
      case 'out-of-bounds':
        this.outOfBounds = true;
        this.setCenter('OUT OF BOUNDS', 'is-warn', `Turn back · respawn in ${e.seconds} s`);
        break;
      case 'in-bounds':
      case 'respawn':
        if (this.outOfBounds && this.status !== 'crashed') this.setCenter('', '', '');
        this.outOfBounds = false;
        break;
      default:
        break;
    }
  }

  toast(msg: string): void {
    const box = this.refs.toasts;
    const t = document.createElement('div');
    t.className = 'ds-toast';
    t.textContent = msg;
    box.appendChild(t);
    while (box.childElementCount > 3) box.firstElementChild?.remove();
    this.placeToasts();
    setTimeout(() => {
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 400);
    }, 2800);
  }

  setError(msg: string): void {
    this.clearToasts();
    this.root.classList.add('ds-fatal');
    this.menus.setError(msg);
  }

  private clearToasts(): void {
    this.refs.toasts.textContent = '';
  }

  private setStatus(s: RaceStatus): void {
    const prev = this.status;
    this.status = s;
    this.root.dataset.status = s;
    if (s === 'crashed') {
      this.setCenter('CRASHED', 'is-crash', 'Respawning…');
      this.popIn();
    } else if (s === 'racing' && prev === 'countdown') {
      this.centerPulse('GO!', 'is-go', 900);
    } else if (s !== 'countdown' && s !== 'paused') {
      this.setCenter('', '', '');
    }
    if (s === 'menu') this.countdown = -1;
    if (s === 'freefly' && prev !== 'paused' && prev !== 'crashed') this.flightTime = 0;
  }

  private updateRings(race: RaceSnapshot, now: number): void {
    const r = this.refs;
    if (race.totalRings !== this.totalRings) {
      this.totalRings = race.totalRings;
      r.pips.textContent = '';
      this.pipEls = [];
      for (let i = 0; i < race.totalRings; i++) {
        const p = document.createElement('i');
        r.pips.appendChild(p);
        this.pipEls.push(p);
      }
      this.text(r.ringTot, String(race.totalRings));
      this.nextRing = -2;
    }
    if (race.nextRing === this.nextRing) return;
    const passedNew = race.nextRing > this.nextRing && this.nextRing >= 0 && race.status !== 'countdown';
    this.nextRing = race.nextRing;
    const done = Math.max(0, race.nextRing);
    this.text(r.ringCur, String(Math.min(done, race.totalRings)));
    this.pipEls.forEach((p, i) => {
      p.className = i < done ? 'is-done' : i === race.nextRing ? 'is-next' : '';
    });
    if (passedNew) {
      this.ringFlash(now);
      const split = r.split;
      const d = race.lastSplit;
      split.textContent = d === null ? formatTime(race.time) : formatDelta(d);
      split.className = `ds-split ${d === null ? '' : d > 0.004 ? 'is-slow' : 'is-fast'}`;
      split.animate?.(
        [
          { opacity: 0, transform: 'translateY(-6px) scale(0.92)' },
          { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.12 },
          { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.8 },
          { opacity: 0, transform: 'translateY(4px) scale(0.98)' },
        ],
        { duration: 2200, easing: 'ease-out', fill: 'forwards' },
      );
    }
  }

  private updateCountdown(race: RaceSnapshot): void {
    if (race.status !== 'countdown') return;
    if (race.countdown === this.countdown) return;
    this.countdown = race.countdown;
    if (race.countdown > 0) {
      this.setCenter(String(race.countdown), 'is-count', '');
      this.popIn();
    }
  }

  private updateHint(f: HudFrame): void {
    const st = f.race.status;
    const inFlight = f.altitude < 0.5 && (st === 'racing' || st === 'freefly' || st === 'countdown');
    const scheme = hintScheme(f.input.source, f.input.gamepadId);
    const thr = f.input.control.throttle;
    let html = '';
    if (inFlight && !f.drone.armed) {
      if (scheme === 'touch') {
        const side = throttleSlot(f.settings.stickMode) === 'ly' ? 'left' : 'right';
        html = thr > 0.05 ? `Pull the ${side} stick fully down, then tap ARM` : 'DISARMED — tap ARM to arm';
      } else {
        const arm = glyphsHtml(actionGlyphs(scheme, 'arm'));
        if (scheme === 'keyboard') {
          // the arm key zeroes the centring keyboard throttle itself; only a held throttle-up key blocks it
          html = thr > 0.55 ? `Release ${this.throttleUpKey(f.settings)}, then press ${arm} to arm` : `DISARMED — press ${arm} to arm`;
        } else if (thr > 0.05 && scheme !== 'quest') {
          const low = f.settings.throttleSource === 'trigger' ? `release ${glyphHtml(padGlyph(scheme, GP.RT))}` : throttleDownHint(f.settings, false).toLowerCase();
          html = `Throttle to zero — ${low}, then press ${arm} to arm`;
        } else {
          html = `DISARMED — press ${arm} to arm`;
        }
      }
    } else if (inFlight && f.drone.armed && f.input.latched && scheme === 'keyboard') {
      html = `Hold ${this.throttleUpKey(f.settings)} to take off`;
    }
    if (this.hintHtml === html) return;
    this.hintHtml = html;
    this.refs.hint.innerHTML = html;
    this.cls(this.refs.hint, html ? 'is-on' : '');
    this.placeToasts();
  }

  private throttleUpKey(s: Settings): string {
    return glyphHtml(keyGlyph(KEY_STICKS[throttleSlot(s.stickMode)][1]));
  }

  /** Glyph chips, bind strip, stick key clusters and the Controls legend for the active input scheme. */
  private updateBindings(f: HudFrame): void {
    const r = this.refs;
    const inp = f.input;
    const doc = this.root.ownerDocument;
    const scheme = hintScheme(inp.source, inp.gamepadId);
    const mouse = !!inp.mouse;
    const locked = !!doc.pointerLockElement;
    const lockable = scheme === 'keyboard' && !this.root.classList.contains('is-touch') && pointerLockSupported(doc);
    const key = [scheme, inp.source, inp.gamepadId, mouse, locked, lockable, this.legendOpen, this.tutorial].join('|');
    if (key === this.hintKey && f.settings === this.hintSettings) return;
    this.hintKey = key;
    this.hintSettings = f.settings;
    const s = f.settings;
    this.root.dataset.scheme = scheme;
    this.text(r.srcName, mouse ? 'Keyboard + mouse' : sourceName(inp.source, inp.gamepadId));

    r.gArm.innerHTML = glyphsHtml(actionGlyphs(scheme, 'arm'));
    r.gMode.innerHTML = glyphsHtml(actionGlyphs(scheme, 'toggleMode'));
    r.gCam.innerHTML = glyphsHtml(actionGlyphs(scheme, 'cycleCamera'));

    const bind = (action: HintAction, label: string = ACTION_LABEL[action], tag: string = action): string => {
      const g = actionGlyphs(scheme, action);
      return g.length ? `<span class="ds-bind" data-bind="${tag}">${glyphsHtml(g)}<span>${label}</span></span>` : '';
    };
    // under pointer lock Esc both releases the mouse and pauses: one chip says so
    // recentring only does something in a headset; on a flat screen the legend lists it as a VR control
    const pauseLabel = this.tutorial && scheme === 'keyboard' ? 'Skip tutorial' : ACTION_LABEL.pause;
    let strip = bind('reset') + (lockable && locked ? bind('pause', `${pauseLabel} · free mouse`, 'mouse') : bind('pause', pauseLabel)) + (scheme === 'quest' ? bind('recenter') : '') + bind('headingArrow', 'Arrow');
    if (lockable && !locked) strip += `<span class="ds-bind" data-bind="mouse">${glyphHtml({ style: 'mouse', label: '', name: 'Mouse' })}<span>Click view: fly with mouse</span></span>`;
    if (mouse && s.mouseStick === 'hold') strip += bind('mouseCentre');
    const legendG = actionGlyphs(scheme, 'legend');
    if (legendG.length) {
      strip += `<button type="button" class="ds-bind ds-bind--btn" data-legend aria-expanded="${this.legendOpen}">${glyphsHtml(legendG)}<span>${this.legendOpen ? 'Hide controls' : 'Controls'}</span></button>`;
    }
    r.binds.innerHTML = strip;

    r.keysL.innerHTML = this.stickKeysHtml(scheme, s, mouse, 'l');
    r.keysR.innerHTML = this.stickKeysHtml(scheme, s, mouse, 'r');
    const padScheme = scheme === 'xbox' || scheme === 'playstation' || scheme === 'generic' ? scheme : null;
    r.gThr.innerHTML = padScheme && s.throttleSource === 'trigger' ? glyphHtml(padGlyph(padScheme, GP.RT)) : '';

    const showMap = this.legendOpen && scheme !== 'touch';
    r.cmap.hidden = !showMap;
    if (!showMap) return;
    const row = (dt: string, dd: string): string => `<div class="ds-cmap__row"><dt>${dt}</dt><dd>${dd}</dd></div>`;
    const rows = channelHints(scheme, s, mouse)
      .map((c) => row(CH_NAME[c.channel], `${glyphsHtml(c.glyphs)}${c.note ? `<small>${c.note}</small>` : ''}`))
      .join('');
    const actions = (['arm', 'toggleMode', 'cycleCamera', 'reset', 'pause', 'recenter', 'headingArrow'] as const)
      .map((a) => {
        const g = actionGlyphs(scheme, a);
        const label = a === 'recenter' && scheme !== 'quest' ? `${ACTION_LABEL[a]} (VR)` : a === 'pause' ? pauseLabel : ACTION_LABEL[a];
        return g.length ? row(label, glyphsHtml(g)) : '';
      })
      .join('');
    let extra = '';
    if (lockable) {
      extra += row('Mouse flight', locked ? `${glyphHtml(keyGlyph('Escape'))}<small>frees the mouse</small>` : '<small>click the view</small>');
      if (s.mouseStick === 'hold') extra += row(ACTION_LABEL.mouseCentre, glyphsHtml(actionGlyphs(scheme, 'mouseCentre')));
    }
    const close = glyphsHtml(legendG);
    const foot = scheme === 'keyboard' ? '<p class="ds-cmap__foot">Keys spring back like a stick · centre holds altitude</p>' : '';
    r.cmap.innerHTML =
      `<header class="ds-cmap__head"><span class="ds-label">Controls</span><span class="ds-cmap__src">${mouse ? 'Keys + mouse' : SCHEME_NAME[scheme]}</span>${close ? `<span class="ds-cmap__close">${close}<span>hide</span></span>` : ''}</header>` +
      `<dl class="ds-cmap__list">${rows}</dl><dl class="ds-cmap__list ds-cmap__list--act">${actions}${extra}</dl>${foot}`;
  }

  private stickKeysHtml(scheme: HintScheme, s: Settings, mouse: boolean, side: 'l' | 'r'): string {
    if (scheme === 'touch') return '';
    if (scheme !== 'keyboard') return glyphHtml({ style: 'stick', label: side === 'l' ? 'L' : 'R', name: side === 'l' ? 'Left stick' : 'Right stick' });
    const c = keyCluster(s, side, mouse);
    const m = c.mouseV || c.mouseH ? glyphHtml({ style: 'mouse', label: c.mouseV && c.mouseH ? '✥' : c.mouseV ? '↕' : '↔', name: 'Mouse' }) : '';
    return `<span class="ds-kc"><span class="ds-kc__u">${glyphHtml(c.up)}</span>${glyphHtml(c.left)}${glyphHtml(c.down)}${glyphHtml(c.right)}</span>${m}`;
  }

  private toggleLegend(): void {
    this.legendOpen = !this.legendOpen;
    this.storeLegend(this.legendOpen ? 'open' : 'closed');
  }

  private storeLegend(v: 'open' | 'closed'): void {
    this.legendStored = v;
    try {
      this.storage?.setItem(LEGEND_STORE_KEY, v);
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  }

  private updateSticks(input: InputFrame): void {
    const c = input.control;
    const st = input.sticks;
    const lx = st.lx;
    const ly = -st.ly;
    const rx = st.rx;
    const ry = -st.ry;
    const eps = 0.004;
    if (Math.abs(lx - this.stickL[0]!) > eps || Math.abs(ly - this.stickL[1]!) > eps) {
      this.stickL[0] = lx;
      this.stickL[1] = ly;
      this.moveDot(this.refs.stickL, lx, ly);
    }
    if (Math.abs(rx - this.stickR[0]!) > eps || Math.abs(ry - this.stickR[1]!) > eps) {
      this.stickR[0] = rx;
      this.stickR[1] = ry;
      this.moveDot(this.refs.stickR, rx, ry);
    }
    if (Math.abs(c.throttle - this.throttle) > 0.002) {
      this.throttle = c.throttle;
      this.style(this.refs.thrFill, `scaleY(${c.throttle.toFixed(3)})`);
    }
  }

  /** Mouse stick circle: where the mouse holds the stick ('hold') or how far it is deflecting ('spring'). */
  private updateMouseStick(input: HudFrame['input']): void {
    const m = input.mouseStick ?? null;
    const r = this.refs;
    if (r.mstick.hidden !== !m) r.mstick.hidden = !m;
    if (!m) return;
    const z = glyphsHtml(actionGlyphs('keyboard', 'mouseCentre'));
    const lbl = `<span>Mouse · ${m.kind === 'hold' ? 'hold' : 'spring'}</span>${z}<span>centre</span>`;
    if (this.mouseLbl !== lbl) {
      this.mouseLbl = lbl;
      r.mlbl.innerHTML = lbl;
    }
    this.cls(r.mstick, m.kind === 'hold' ? 'is-on' : '');
    this.style(r.mdot, `translate(-50%, -50%) translate(${(m.x * MOUSE_TRAVEL).toFixed(1)}%, ${(-m.y * MOUSE_TRAVEL).toFixed(1)}%)`);
  }

  private moveDot(el: HTMLElement, x: number, y: number): void {
    // Percent translate is relative to the dot; the dot is 1/5 of the well, so 5 × travel.
    const k = STICK_TRAVEL * 500;
    this.style(el, `translate(-50%, -50%) translate(${(x * k).toFixed(1)}%, ${(y * k).toFixed(1)}%)`);
  }

  private setSource(src: InputSource): void {
    this.source = src;
    const r = this.refs;
    r.srcIcon.innerHTML = src === 'gamepad' || src === 'xr' ? ICON_GAMEPAD : src === 'keyboard' ? ICON_KEYBOARD : src === 'touch' ? ICON_TOUCH : ICON_NONE;
    this.root.dataset.source = src;
  }

  private ringFlash(now: number): void {
    if (now - this.flashAt < 120) return;
    this.flashAt = now;
    this.flash('is-ring');
  }

  private flash(kind: 'is-ring' | 'is-crash'): void {
    const el = this.refs.flash;
    el.className = `ds-flash ${kind}`;
    el.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: kind === 'is-ring' ? 450 : 900, easing: 'ease-out', fill: 'forwards' });
  }

  private setCenter(big: string, kind: string, sub: string): void {
    if (this.goTimer) {
      clearTimeout(this.goTimer);
      this.goTimer = null;
    }
    const r = this.refs;
    // A finished pulse is held by fill:'forwards' at opacity 0; it would hide whatever is shown next.
    r.center.getAnimations?.().forEach((a) => a.cancel());
    this.text(r.center, big);
    r.center.className = `ds-center__big ${kind}`;
    const wrap = r.center.parentElement;
    if (wrap) {
      wrap.classList.remove(...CENTER_KINDS);
      if (kind) wrap.classList.add(kind);
    }
    this.text(r.centerSub, sub);
    this.placeToasts();
  }

  /**
   * Toasts get their own lane. While a centre title (countdown digit, CRASHED, GO!) is up they sit just
   * above the bottom telemetry card / arm hint, clear of the title and of the respawning drone under it;
   * when that gap is too short they fall back to just under the title stack. Otherwise the stylesheet's
   * top-of-screen lane applies.
   */
  private placeToasts(): void {
    const box = this.refs.toasts;
    // default lane ('' = the stylesheet's); styles are only written when the lane actually changes
    const lane = (top: string, bottom: string): void => {
      if (box.style.top !== top) box.style.top = top;
      if (box.style.bottom !== bottom) box.style.bottom = bottom;
    };
    const center = this.refs.center.parentElement;
    const up = !!(this.refs.center.textContent || this.refs.centerSub.textContent);
    if (!up || !box.childElementCount || !center) return lane('', '');
    // the lane's width and height don't depend on top/bottom, so it is measured where it currently sits
    const hud = box.offsetParent as HTMLElement | null;
    if (!hud) return lane('', '');
    const host = hud.getBoundingClientRect();
    // Big digits overflow their line-height:1 box (and pop in scaled up): measure the glyphs too.
    const glyphs = document.createRange();
    glyphs.selectNodeContents(this.refs.center);
    const titleBottom = Math.max(center.getBoundingClientRect().bottom, glyphs.getBoundingClientRect().bottom);
    const gap = 12;
    const laneBox = box.getBoundingClientRect();
    const floorAbove = (els: (HTMLElement | null)[]): number => {
      let floor = host.bottom - gap;
      for (const el of els) {
        const r = el?.getBoundingClientRect();
        if (r && r.height > 0 && r.left < laneBox.right && laneBox.left < r.right) floor = Math.min(floor, r.top - gap);
      }
      return floor;
    };
    const tele = hud.querySelector<HTMLElement>('.ds-hud__bl');
    const hint = this.refs.hint.classList.contains('is-on') ? this.refs.hint : null;
    // Short screens: no room above the arm hint, so the toast sits over it (opaque, it hides the hint for its 3 s).
    const floor = [floorAbove([tele, hint]), floorAbove([tele])].find((f) => f - laneBox.height >= titleBottom + gap);
    if (floor !== undefined) {
      lane('auto', `${Math.round(host.bottom - floor)}px`);
    } else {
      lane(`${Math.round(titleBottom - host.top + gap)}px`, '');
    }
  }

  /** Entrance only: the text stays fully visible until the next setCenter (countdown digit, CRASHED). */
  private popIn(): void {
    this.refs.center.animate?.(
      [
        { opacity: 0, transform: 'scale(1.5)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
      ],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }

  /** Transient message (GO!, ARMED) that fades out and clears itself. */
  private centerPulse(big: string, kind: string, ms: number): void {
    this.setCenter(big, kind, '');
    this.refs.center.animate?.(
      [
        { opacity: 0, transform: 'scale(1.6)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'scale(1)', filter: 'blur(0)', offset: 0.18 },
        { opacity: 1, transform: 'scale(0.96)', offset: 0.75 },
        { opacity: 0, transform: 'scale(0.9)' },
      ],
      { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
    );
    this.goTimer = setTimeout(() => {
      this.goTimer = null;
      if (this.status !== 'crashed') this.text(this.refs.center, '');
      this.placeToasts();
    }, ms);
  }

  private text(el: HTMLElement, v: string): void {
    if (this.textCache.get(el) === v) return;
    this.textCache.set(el, v);
    el.textContent = v;
  }

  private style(el: HTMLElement, transform: string): void {
    if (this.styleCache.get(el) === transform) return;
    this.styleCache.set(el, transform);
    el.style.transform = transform;
  }

  private cls(el: HTMLElement, state: string): void {
    const key = `cls:${state}`;
    const prev = el.dataset.state ?? '';
    if (prev === key) return;
    el.dataset.state = key;
    for (const c of ['is-on', 'is-warn', 'is-crit', 'is-acro']) el.classList.remove(c);
    if (state) el.classList.add(state);
  }
}

function sourceName(src: InputSource, id: string | null): string {
  return src === 'gamepad' ? shortPad(id) : src === 'xr' ? 'Quest Touch' : src === 'keyboard' ? 'Keyboard' : src === 'touch' ? 'Touch' : 'No input';
}

function shortPad(id: string | null): string {
  if (!id) return 'Gamepad';
  if (/xbox|xinput|045e/i.test(id)) return 'Xbox controller';
  if (/dualsense|dualshock|054c/i.test(id)) return 'PlayStation controller';
  const s = id.replace(/\(.*?\)/g, '').trim();
  return s.length > 22 ? `${s.slice(0, 21)}…` : s || 'Gamepad';
}
