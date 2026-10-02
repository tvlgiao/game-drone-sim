/**
 * Touch-device chrome around the game: "Tap to play full screen" gate (the tap is the user gesture
 * that unlocks audio + requests fullscreen), the one-time "Add to Home Screen" sheet for browsers
 * without element fullscreen (iPhone Safari), and the phone "Rotate your device" overlay.
 */
import './mobile.css';
import { formFactor, readEnv, type FormFactor } from '../core/device';

export const A2HS_DISMISSED_KEY = 'drone-sim.a2hs-dismissed';

const SHARE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v7A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const ADD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8.5v7M8.5 12h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

/** iPadOS 13+ Safari reports a Mac user agent; only the touch points give it away. */
export function iosDeviceName(userAgent: string, maxTouchPoints: number): 'iPhone' | 'iPad' {
  return /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1) ? 'iPad' : 'iPhone';
}

/** Phones are held in landscape (portrait shows the rotate overlay); tablets fly either way up. */
export function gateHint(form: FormFactor): string {
  return form === 'phone' ? 'Landscape · two thumbs · sound on' : 'Two thumbs · sound on';
}

export interface MobileShellOptions {
  storage: Storage | null;
  /** already running as a home-screen app (no fullscreen needed) */
  standalone: boolean;
  /** called synchronously inside the gate tap (user gesture) */
  onGateTap: () => void;
  /** Add-to-Home-Screen wording; detected from the user agent when omitted */
  iosDevice?: 'iPhone' | 'iPad';
  /** gate wording; detected from the screen when omitted */
  form?: FormFactor;
}

export class MobileShell {
  private readonly gate: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly rotate: HTMLElement;
  private readonly sheetOk: HTMLButtonElement;
  private readonly storage: Storage | null;
  private rotating = false;

  constructor(root: HTMLElement, opts: MobileShellOptions) {
    this.storage = opts.storage;
    const label = opts.standalone ? 'Tap to play' : 'Tap to play full screen';
    const form = opts.form ?? (typeof window === 'undefined' ? 'phone' : formFactor(readEnv(window)));
    this.gate = this.el(
      root,
      'ds-gate',
      `<button type="button" class="ds-gate__btn" aria-label="${label}">
         <span class="ds-gate__ring" aria-hidden="true"></span>
         <span class="ds-gate__title">DRONE SIM</span>
         <span class="ds-gate__cta">${label}</span>
         <span class="ds-gate__sub">${gateHint(form)}</span>
       </button>`,
    );
    this.gate.querySelector('button')!.addEventListener('click', () => {
      this.hideGate();
      opts.onGateTap();
    });

    const nav = typeof navigator === 'undefined' ? null : navigator;
    const iosDevice = opts.iosDevice ?? iosDeviceName(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0);
    this.sheet = this.el(
      root,
      'ds-sheet',
      `<div class="ds-sheet__card" role="dialog" aria-modal="true" aria-labelledby="ds-sheet-title">
         <h2 id="ds-sheet-title" class="ds-dialog__title">Play full screen</h2>
         <p>Safari on ${iosDevice} can’t hide its toolbars for web games. Add Drone Sim to your Home Screen and open it from there:</p>
         <ol class="ds-sheet__steps">
           <li><span class="ds-sheet__ico">${SHARE_ICON}</span><span>Tap <b>Share</b> in the Safari toolbar</span></li>
           <li><span class="ds-sheet__ico">${ADD_ICON}</span><span>Choose <b>Add to Home Screen</b></span></li>
           <li><span class="ds-sheet__ico ds-sheet__ico--app" aria-hidden="true"></span><span>Launch <b>Drone Sim</b> from the Home Screen</span></li>
         </ol>
         <button type="button" class="ds-sheet__ok" data-sheet="ok">Got it</button>
       </div>`,
    );
    this.sheetOk = this.sheet.querySelector<HTMLButtonElement>('[data-sheet="ok"]')!;
    this.sheetOk.addEventListener('click', () => this.dismissSheet());
    this.sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.dismissSheet();
    });

    this.rotate = this.el(
      root,
      'ds-rotate',
      `<div class="ds-rotate__phone" aria-hidden="true"><i></i></div>
       <p class="ds-rotate__title">Rotate your device</p>
       <p class="ds-rotate__sub">Drone Sim flies in landscape</p>`,
    );
    this.rotate.setAttribute('role', 'alert');
  }

  showGate(): void {
    this.gate.classList.add('is-open');
  }

  hideGate(): void {
    this.gate.classList.remove('is-open');
  }

  get gateOpen(): boolean {
    return this.gate.classList.contains('is-open');
  }

  /** Shows the Add-to-Home-Screen guide unless the player dismissed it before. */
  offerHomeScreen(): boolean {
    if (this.dismissed()) return false;
    this.sheet.classList.add('is-open');
    this.sheetOk.focus({ preventScroll: true });
    return true;
  }

  get sheetOpen(): boolean {
    return this.sheet.classList.contains('is-open');
  }

  setRotate(on: boolean): void {
    if (on === this.rotating) return;
    this.rotating = on;
    this.rotate.classList.toggle('is-open', on);
  }

  get rotateOpen(): boolean {
    return this.rotating;
  }

  private dismissSheet(): void {
    this.sheet.classList.remove('is-open');
    try {
      this.storage?.setItem(A2HS_DISMISSED_KEY, '1');
    } catch {
      /* private mode */
    }
  }

  private dismissed(): boolean {
    try {
      return this.storage?.getItem(A2HS_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  private el(root: HTMLElement, cls: string, html: string): HTMLElement {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    root.appendChild(el);
    return el;
  }
}

/**
 * Blocks Safari page gestures that fight the game: pinch zoom (gesture*), double-tap zoom, long-press
 * callout menu. CSS `touch-action` handles scrolling; dialogs keep `pan-y` to stay scrollable.
 */
export function hardenGestures(doc: Document): void {
  const block = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) doc.addEventListener(type, block, { passive: false });
  doc.addEventListener(
    'contextmenu',
    (e) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('input, textarea')) block(e);
    },
    { passive: false },
  );
  // Two-finger pinch on iOS < 13 still arrives as a multi-touch touchmove outside touch-action areas.
  doc.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 && !(e.target as Element | null)?.closest?.('.ds-touch')) block(e);
    },
    { passive: false },
  );
}
