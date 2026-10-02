/**
 * On-screen RC transmitter for touch devices: two virtual stick visuals (base + knob, throttle rail)
 * and ARM / MODE / CAM / RESET / PAUSE buttons. Visual updates are transform-only and skipped when
 * nothing moved; geometry (safe areas, anchors) is measured on resize, never per frame.
 */
import './mobile.css';
import type { Settings } from '../core/settings';
import type { StickTrack, TouchButton, TouchInput } from '../input/touch';
import type { CameraMode, FlightMode } from '../types';
import { stickShort, throttleControl } from './mode-labels';

const CAMERA_LABEL: Record<CameraMode, string> = { fpv: 'FPV', chase: 'CHASE', los: 'LOS' };
/** Gap between a stick base and the screen edge (inside the safe area), CSS px. */
const EDGE_PAD = 26;

const HTML = `
<div class="ds-touch" aria-hidden="true">
  <div class="ds-tstick" data-side="l">
    <div class="ds-tstick__base"><i class="ds-tstick__cross"></i><i class="ds-tstick__rail"></i><span class="ds-tstick__lbl"></span></div>
    <div class="ds-tstick__knob"></div>
  </div>
  <div class="ds-tstick" data-side="r">
    <div class="ds-tstick__base"><i class="ds-tstick__cross"></i><i class="ds-tstick__rail"></i><span class="ds-tstick__lbl"></span></div>
    <div class="ds-tstick__knob"></div>
  </div>
  <div class="ds-tbtns ds-tbtns--l">
    <button type="button" class="ds-tbtn ds-tbtn--icon" data-tbtn="pause" aria-label="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></button>
    <button type="button" class="ds-tbtn" data-tbtn="cycleCamera" aria-label="Camera"><small>CAM</small><b data-t="cam">LOS</b></button>
  </div>
  <div class="ds-tbtns ds-tbtns--r">
    <button type="button" class="ds-tbtn" data-tbtn="reset" aria-label="Reset to checkpoint"><small>RESET</small><b>↺</b></button>
    <button type="button" class="ds-tbtn" data-tbtn="toggleMode" aria-label="Flight mode"><small>MODE</small><b data-t="mode">ANGLE</b></button>
    <button type="button" class="ds-tbtn ds-tbtn--arm" data-tbtn="arm" aria-label="Arm or disarm"><b data-t="arm">ARM</b></button>
  </div>
  <div class="ds-touch__probe"></div>
</div>`;

interface StickEls {
  root: HTMLElement;
  base: HTMLElement;
  knob: HTMLElement;
  lbl: HTMLElement;
  /** last written values (skip DOM writes when unchanged) */
  cx: number;
  cy: number;
  x: number;
  y: number;
  active: boolean;
}

export class TouchControls {
  readonly layer: HTMLElement;
  private readonly input: TouchInput;
  private readonly root: HTMLElement;
  private readonly radius: number;
  private readonly sticks: Record<'l' | 'r', StickEls>;
  private readonly probe: HTMLElement;
  private readonly txt: { cam: HTMLElement; mode: HTMLElement; arm: HTMLElement; armBtn: HTMLElement };
  private readonly cache = new Map<HTMLElement, string>();
  private visible = false;
  /** `ds-touch-on` on the UI root: the compact touch HUD layout (outlives the sticks while a menu is open) */
  private touchLayout = false;
  private settingsRef: Settings | null = null;
  private panel: HTMLElement | null = null;
  private panelH = -1;
  private readonly panelObserver: ResizeObserver | null;

  constructor(root: HTMLElement, input: TouchInput, radius: number) {
    this.root = root;
    this.input = input;
    this.radius = radius;
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    const layer = wrap.firstElementChild as HTMLElement;
    root.style.setProperty('--ds-stick-r', `${radius}px`);
    // Below the HUD (whose panels are pointer-transparent) so the HUD quit chip stays tappable.
    root.prepend(layer);
    this.layer = layer;
    const q = (sel: string): HTMLElement => layer.querySelector<HTMLElement>(sel)!;
    const stick = (side: 'l' | 'r'): StickEls => {
      const r = q(`.ds-tstick[data-side="${side}"]`);
      return {
        root: r,
        base: r.querySelector<HTMLElement>('.ds-tstick__base')!,
        knob: r.querySelector<HTMLElement>('.ds-tstick__knob')!,
        lbl: r.querySelector<HTMLElement>('.ds-tstick__lbl')!,
        cx: NaN,
        cy: NaN,
        x: NaN,
        y: NaN,
        active: false,
      };
    };
    this.sticks = { l: stick('l'), r: stick('r') };
    this.probe = q('.ds-touch__probe');
    this.txt = { cam: q('[data-t="cam"]'), mode: q('[data-t="mode"]'), arm: q('[data-t="arm"]'), armBtn: q('[data-tbtn="arm"]') };

    layer.querySelectorAll<HTMLElement>('[data-tbtn]').forEach((btn) => {
      const name = btn.dataset.tbtn as TouchButton;
      const release = (): void => btn.classList.remove('is-pressed');
      btn.addEventListener('pointerdown', (e) => {
        if (e.cancelable) e.preventDefault();
        btn.classList.add('is-pressed');
        input.press(name);
      });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
      // Keyboard / assistive activation (pointer taps are already handled on pointerdown).
      btn.addEventListener('click', (e) => {
        if (e.detail === 0) input.press(name);
      });
    });

    input.attach(layer);
    const relayout = (): void => this.layout();
    const hasRO = typeof ResizeObserver !== 'undefined';
    if (hasRO) new ResizeObserver(relayout).observe(layer);
    this.panelObserver = hasRO ? new ResizeObserver(() => this.measurePanel()) : null;
    window.addEventListener('orientationchange', relayout);
    this.layout();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Sticks + buttons on/off. With `overFlight` (pause / finish and the menus opened from them cover a
   * flight) the compact touch HUD layout stays, so the dimmed HUD behind does not jump to the desktop
   * layout; back at the main menu it is dropped.
   */
  setVisible(on: boolean, overFlight = false): void {
    const layout = on || (this.touchLayout && overFlight);
    if (layout !== this.touchLayout) {
      this.touchLayout = layout;
      this.root.classList.toggle('ds-touch-on', layout);
      if (layout) this.watchPanel();
    }
    if (on === this.visible) return;
    this.visible = on;
    this.layer.classList.toggle('is-on', on);
    this.layer.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (!on) this.input.sticks.releaseAll();
    else this.layout();
  }

  /** Per-frame refresh: stick transforms (only when moved) and button labels. */
  update(settings: Settings, armed: boolean, mode: FlightMode, camera: CameraMode): void {
    if (settings !== this.settingsRef) {
      this.settingsRef = settings;
      const thr = throttleControl({ stickMode: settings.stickMode, throttleSource: 'stick' });
      this.sticks.l.root.classList.toggle('is-thr', thr === 'left');
      this.sticks.r.root.classList.toggle('is-thr', thr === 'right');
      const labels = { stickMode: settings.stickMode, throttleSource: 'stick' as const };
      this.text(this.sticks.l.lbl, stickShort(labels, 'l'));
      this.text(this.sticks.r.lbl, stickShort(labels, 'r'));
      this.layer.classList.toggle('is-fixed', settings.touchSticksFixed);
    }
    this.input.sticks.setArmed(armed);
    if (!this.visible) return;
    const s = this.input.sticks;
    this.moveStick(this.sticks.l, s.l);
    this.moveStick(this.sticks.r, s.r);
    this.text(this.txt.cam, CAMERA_LABEL[camera]);
    this.text(this.txt.mode, mode === 'acro' ? 'ACRO' : 'ANGLE');
    this.text(this.txt.arm, armed ? 'DISARM' : 'ARM');
    const armedCls = armed ? 'on' : 'off';
    if (this.txt.armBtn.dataset.armed !== armedCls) {
      this.txt.armBtn.dataset.armed = armedCls;
      this.txt.armBtn.classList.toggle('is-armed', armed);
    }
  }

  /** Measures the layer + safe-area insets and places the stick rest anchors. */
  layout(): void {
    const rect = this.layer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cs = getComputedStyle(this.probe);
    const px = (v: string): number => Number.parseFloat(v) || 0;
    const sl = px(cs.paddingLeft);
    const sr = px(cs.paddingRight);
    const sb = px(cs.paddingBottom);
    const R = this.radius;
    const off = R + EDGE_PAD;
    // Leave room below the base for a throttle knob resting at the bottom (knob radius ≈ 0.46 R).
    const y = rect.height - sb - R * 1.5 - EDGE_PAD;
    this.input.layout(rect.left, rect.top, rect.width, { lx: sl + off, ly: y, rx: rect.width - sr - off, ry: y }, R);
    for (const k of ['l', 'r'] as const) this.sticks[k].cx = NaN;
  }

  /** Publishes the telemetry panel height so the arm hint sits above it whatever its content. */
  private watchPanel(): void {
    if (!this.panel) {
      this.panel = this.root.querySelector<HTMLElement>('.ds-hud__bl');
      if (this.panel) this.panelObserver?.observe(this.panel);
    }
    this.measurePanel();
  }

  private measurePanel(): void {
    const h = this.panel?.offsetHeight ?? 0;
    if (h <= 0 || h === this.panelH) return;
    this.panelH = h;
    this.root.style.setProperty('--ds-tpanel-h', `${h}px`);
  }

  private moveStick(el: StickEls, t: StickTrack): void {
    const R = this.radius;
    if (t.active !== el.active) {
      el.active = t.active;
      el.root.classList.toggle('is-active', t.active);
    }
    if (t.cx !== el.cx || t.cy !== el.cy) {
      el.cx = t.cx;
      el.cy = t.cy;
      el.base.style.transform = `translate3d(${(t.cx - R).toFixed(1)}px, ${(t.cy - R).toFixed(1)}px, 0)`;
      el.x = NaN;
    }
    if (t.x !== el.x || t.y !== el.y) {
      el.x = t.x;
      el.y = t.y;
      el.knob.style.transform = `translate3d(${(t.cx + t.x * R).toFixed(1)}px, ${(t.cy - t.y * R).toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
  }

  private text(el: HTMLElement, v: string): void {
    if (this.cache.get(el) === v) return;
    this.cache.set(el, v);
    el.textContent = v;
  }
}
