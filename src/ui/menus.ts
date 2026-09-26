/** Menu screens (main, settings, controls, pause, finish, error) with mouse / keyboard / gamepad focus navigation. */
import { SETTINGS_OPTIONS, type Settings } from '../core/settings';
import type { NavEvents } from '../types';
import { formatTime } from './format';
import { CONTROLLER_DIAGRAM } from './icons';

export type ScreenName = 'main' | 'settings' | 'controls' | 'pause' | 'finish' | 'error' | 'none';

export type UiAction =
  | { type: 'race' }
  | { type: 'freefly' }
  | { type: 'resume' }
  | { type: 'menu' }
  | { type: 'retry' }
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

type Option<T> = { value: T; label: string };
type Row =
  | { key: 'throttleSource' | 'flightMode' | 'ratePreset' | 'quality'; label: string; hint: string; options: Option<string>[] }
  | { key: 'cameraTiltDeg' | 'fovDeg' | 'volume' | 'deadzone'; label: string; hint: string; range: { min: number; max: number; step: number }; fmt: (v: number) => string }
  | { key: 'showFps'; label: string; hint: string; bool: true };

const ROWS: Row[] = [
  {
    key: 'throttleSource',
    label: 'Throttle',
    hint: 'Left stick = full-range Mode 2 gimbal · RT = trigger',
    options: [
      { value: 'left-stick', label: 'Left stick' },
      { value: 'right-trigger', label: 'Right trigger' },
    ],
  },
  {
    key: 'flightMode',
    label: 'Flight mode',
    hint: 'Angle self-levels · Acro is full manual',
    options: [
      { value: 'angle', label: 'Angle' },
      { value: 'acro', label: 'Acro' },
    ],
  },
  {
    key: 'ratePreset',
    label: 'Rates',
    hint: 'Stick sensitivity (Betaflight Actual)',
    options: [
      { value: 'beginner', label: 'Beginner' },
      { value: 'freestyle', label: 'Freestyle' },
      { value: 'race', label: 'Race' },
    ],
  },
  { key: 'cameraTiltDeg', label: 'Camera tilt', hint: 'FPV camera uptilt', range: SETTINGS_OPTIONS.cameraTiltDeg, fmt: (v) => `${Math.round(v)}°` },
  { key: 'fovDeg', label: 'Field of view', hint: 'FPV lens width', range: SETTINGS_OPTIONS.fovDeg, fmt: (v) => `${Math.round(v)}°` },
  {
    key: 'quality',
    label: 'Graphics',
    hint: 'Auto picks a tier from your GPU',
    options: SETTINGS_OPTIONS.quality.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) })),
  },
  { key: 'volume', label: 'Volume', hint: 'Master volume', range: SETTINGS_OPTIONS.volume, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'showFps', label: 'Show FPS', hint: 'Frame-rate counter in the HUD', bool: true },
  { key: 'deadzone', label: 'Stick deadzone', hint: 'Radial deadzone for worn sticks', range: SETTINGS_OPTIONS.deadzone, fmt: (v) => v.toFixed(2) },
];

const html = (s: string): string => s;

export class Menus {
  current: ScreenName = 'none';
  private readonly screens = new Map<ScreenName, HTMLElement>();
  private items: Item[] = [];
  private focus = 0;
  private returnTo: 'main' | 'pause' = 'main';
  private settings: Settings;
  private readonly rowEls = new Map<Row['key'], { value: HTMLElement; fill: HTMLElement | null }>();
  private readonly finishEls: { time: HTMLElement; best: HTMLElement; badge: HTMLElement };
  private readonly errorMsg: HTMLElement;
  private readonly menuBest: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly onAction: (a: UiAction) => void,
    settings: Settings,
  ) {
    this.settings = { ...settings };
    this.screens.set('main', this.buildMain());
    this.screens.set('settings', this.buildSettings());
    this.screens.set('controls', this.buildControls());
    this.screens.set('pause', this.buildPause());
    const fin = this.buildFinish();
    this.screens.set('finish', fin);
    const err = this.buildError();
    this.screens.set('error', err);
    this.finishEls = {
      time: fin.querySelector<HTMLElement>('[data-f="time"]')!,
      best: fin.querySelector<HTMLElement>('[data-f="best"]')!,
      badge: fin.querySelector<HTMLElement>('[data-f="badge"]')!,
    };
    this.errorMsg = err.querySelector<HTMLElement>('[data-f="msg"]')!;
    this.menuBest = this.screens.get('main')!.querySelector<HTMLElement>('[data-f="best"]')!;
    for (const el of this.screens.values()) root.appendChild(el);
  }

  setSettings(s: Settings): void {
    this.settings = { ...s };
    this.renderSettings();
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
    if (name === 'settings' || name === 'controls') {
      if (this.current === 'main' || this.current === 'pause') this.returnTo = this.current;
    }
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
    if (nav.up) this.setFocus((this.focus - 1 + n) % n);
    if (nav.down) this.setFocus((this.focus + 1) % n);
    const item = this.items[this.focus];
    if (!item) return;
    if (nav.left) item.adjust?.(-1);
    if (nav.right) item.adjust?.(1);
    if (confirm) item.activate?.();
  }

  back(): void {
    switch (this.current) {
      case 'settings':
      case 'controls':
        this.show(this.returnTo);
        break;
      case 'pause':
        this.onAction({ type: 'resume' });
        break;
      default:
        break;
    }
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
      const item: Item = { el };
      const act = el.dataset.act;
      const key = el.dataset.key as Row['key'] | undefined;
      if (key) {
        item.adjust = (dir) => this.adjust(key, dir);
        item.activate = () => this.adjust(key, 1);
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
        this.onAction({ type: act });
        break;
      case 'settings':
      case 'controls':
        this.show(act);
        break;
      case 'back':
        this.back();
        break;
      case 'reload':
        location.reload();
        break;
    }
  }

  private adjust(key: Row['key'], dir: -1 | 1): void {
    const row = ROWS.find((r) => r.key === key);
    if (!row) return;
    const s = this.settings as unknown as Record<string, unknown>;
    if ('options' in row) {
      const idx = row.options.findIndex((o) => o.value === s[key]);
      const n = row.options.length;
      s[key] = row.options[(Math.max(0, idx) + dir + n) % n]!.value;
    } else if ('range' in row) {
      const { min, max, step } = row.range;
      const v = Math.round((((s[key] as number) + dir * step) / step)) * step;
      s[key] = Math.min(max, Math.max(min, Number(v.toFixed(4))));
    } else {
      s[key] = !s[key];
    }
    this.renderSettings();
    this.onAction({ type: 'settings', settings: { ...this.settings } });
  }

  private renderSettings(): void {
    const s = this.settings as unknown as Record<string, unknown>;
    for (const row of ROWS) {
      const els = this.rowEls.get(row.key);
      if (!els) continue;
      const v = s[row.key];
      let text: string;
      let frac: number | null = null;
      if ('options' in row) text = row.options.find((o) => o.value === v)?.label ?? String(v);
      else if ('range' in row) {
        text = row.fmt(v as number);
        frac = ((v as number) - row.range.min) / (row.range.max - row.range.min);
      } else text = v ? 'On' : 'Off';
      if (els.value.textContent !== text) els.value.textContent = text;
      if (els.fill && frac !== null) els.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
    }
  }

  private screen(name: string, inner: string): HTMLElement {
    const el = document.createElement('section');
    el.className = `ds-screen ds-screen--${name}`;
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    el.innerHTML = inner;
    el.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-nav], [data-dir]');
      if (!target) return;
      const dirBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-dir]');
      const navEl = target.closest<HTMLElement>('[data-nav]') ?? target;
      const idx = this.items.findIndex((i) => i.el === navEl);
      if (idx >= 0) this.setFocus(idx);
      const item = this.items[idx];
      if (!item) return;
      if (dirBtn && item.adjust) item.adjust(dirBtn.dataset.dir === '-1' ? -1 : 1);
      else item.activate?.();
    });
    el.addEventListener('pointermove', (e) => {
      const navEl = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
      if (!navEl) return;
      const idx = this.items.findIndex((i) => i.el === navEl);
      if (idx >= 0 && idx !== this.focus) this.setFocus(idx);
    });
    return el;
  }

  private btn(act: string, label: string, primary = false): string {
    return `<button type="button" class="ds-btn${primary ? ' ds-btn--primary' : ''}" data-nav data-act="${act}"><span>${label}</span></button>`;
  }

  private buildMain(): HTMLElement {
    return this.screen(
      'main',
      html(`
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
        </nav>
        <p class="ds-main__best" data-f="best"></p>
        <footer class="ds-foot">
          <span><kbd class="ds-kbd ds-kbd--a">A</kbd><kbd class="ds-kbd">Enter</kbd> Select</span>
          <span><kbd class="ds-kbd ds-kbd--b">B</kbd><kbd class="ds-kbd">Esc</kbd> Back</span>
          <span><kbd class="ds-kbd">D-pad</kbd><kbd class="ds-kbd">↑↓</kbd> Move</span>
        </footer>
      </div>`),
    );
  }

  private buildSettings(): HTMLElement {
    const rows = ROWS.map((r) => {
      const track = 'range' in r ? `<span class="ds-row__track" aria-hidden="true"><span class="ds-row__fill"></span></span>` : '';
      return `
        <div class="ds-row" data-nav data-key="${r.key}" role="group" aria-label="${r.label}">
          <div class="ds-row__text"><span class="ds-row__label">${r.label}</span><span class="ds-row__hint">${r.hint}</span></div>
          <div class="ds-row__ctl">
            <button type="button" class="ds-arrow" data-dir="-1" aria-label="Previous ${r.label}" tabindex="-1">‹</button>
            <span class="ds-row__value" aria-live="polite"></span>
            <button type="button" class="ds-arrow" data-dir="1" aria-label="Next ${r.label}" tabindex="-1">›</button>
            ${track}
          </div>
        </div>`;
    }).join('');
    const el = this.screen(
      'settings',
      html(`
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">Settings</h2>
        <div class="ds-rows">${rows}</div>
        <div class="ds-dialog__actions">${this.btn('back', 'Back')}</div>
        <p class="ds-foot ds-foot--inline"><span><kbd class="ds-kbd">←</kbd><kbd class="ds-kbd">→</kbd> Change</span><span><kbd class="ds-kbd ds-kbd--b">B</kbd> Back</span></p>
      </div>`),
    );
    el.querySelectorAll<HTMLElement>('.ds-row').forEach((rowEl) => {
      const key = rowEl.dataset.key as Row['key'];
      this.rowEls.set(key, { value: rowEl.querySelector<HTMLElement>('.ds-row__value')!, fill: rowEl.querySelector<HTMLElement>('.ds-row__fill') });
    });
    this.renderSettings();
    return el;
  }

  private buildControls(): HTMLElement {
    const map: [string, string, string][] = [
      ['Throttle', 'Left stick ↕ (full range) · or RT', 'W / S (ramped)'],
      ['Yaw', 'Left stick ↔', 'A / D'],
      ['Pitch', 'Right stick ↕', '↑ / ↓'],
      ['Roll', 'Right stick ↔', '← / →'],
      ['Arm / disarm', 'A', 'Space'],
      ['Flight mode', 'Y', 'M'],
      ['Camera', 'RB', 'C'],
      ['Reset to checkpoint', 'B', 'R'],
      ['Pause', 'Menu (☰)', 'Esc'],
    ];
    const rows = map
      .map(([a, x, k]) => `<tr><th scope="row">${a}</th><td>${x}</td><td><kbd class="ds-kbd">${k}</kbd></td></tr>`)
      .join('');
    return this.screen(
      'controls',
      html(`
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide">
        <h2 class="ds-dialog__title">Controls <small>Mode 2</small></h2>
        <div class="ds-pad-wrap">${CONTROLLER_DIAGRAM}</div>
        <table class="ds-table">
          <thead><tr><th>Action</th><th>Xbox controller</th><th>Keyboard</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="ds-tip">Arming needs throttle at zero. Hold the left stick fully down (or release RT) and press A.</p>
        <div class="ds-dialog__actions">${this.btn('back', 'Back', true)}</div>
      </div>`),
    );
  }

  private buildPause(): HTMLElement {
    return this.screen(
      'pause',
      html(`
      <div class="ds-panel ds-glass ds-dialog">
        <h2 class="ds-dialog__title">Paused</h2>
        <nav class="ds-menu">
          ${this.btn('resume', 'Resume', true)}
          ${this.btn('retry', 'Restart')}
          ${this.btn('settings', 'Settings')}
          ${this.btn('controls', 'Controls')}
          ${this.btn('menu', 'Main menu')}
        </nav>
      </div>`),
    );
  }

  private buildFinish(): HTMLElement {
    return this.screen(
      'finish',
      html(`
      <div class="ds-panel ds-glass ds-dialog ds-finish">
        <p class="ds-finish__kicker">Finish</p>
        <span class="ds-badge-new" data-f="badge" hidden>New best</span>
        <div class="ds-finish__time" data-f="time">--:--.--</div>
        <p class="ds-finish__best"><span class="ds-label">Best</span> <span data-f="best">--:--.--</span></p>
        <nav class="ds-menu ds-menu--row">
          ${this.btn('retry', 'Retry', true)}
          ${this.btn('menu', 'Menu')}
        </nav>
      </div>`),
    );
  }

  private buildError(): HTMLElement {
    return this.screen(
      'error',
      html(`
      <div class="ds-panel ds-glass ds-dialog ds-error">
        <h2 class="ds-dialog__title">Can't start the simulator</h2>
        <p class="ds-error__msg" data-f="msg"></p>
        <div class="ds-dialog__actions">${this.btn('reload', 'Reload', true)}</div>
      </div>`),
    );
  }
}
