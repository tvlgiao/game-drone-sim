/** Keyboard listener: tracks held keys by `KeyboardEvent.code` and blocks browser defaults for game keys. */

/** Keys the game consumes (default action prevented: scrolling, find-as-you-type…). */
export const GAME_KEYS: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyS',
  'KeyA',
  'KeyD',
  'KeyM',
  'KeyC',
  'KeyR',
  'KeyH',
  'KeyZ',
  'KeyV',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'NumpadEnter',
  'Escape',
  'Backspace',
]);

export class KeyboardInput {
  /** Timestamp (ms, event.timeStamp clock ≈ performance.now) of the last game key press. */
  lastActivity = -Infinity;
  private held = new Set<string>();
  private tapped = new Set<string>();
  private readonly target: Window | null;

  private readonly onDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!GAME_KEYS.has(e.code)) return;
    if (isEditable(e.target)) return;
    e.preventDefault();
    this.held.add(e.code);
    if (!e.repeat) this.tapped.add(e.code);
    this.lastActivity = performance.now();
  };

  private readonly onUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };

  constructor(win: Window | null) {
    this.target = win;
    if (!win) return;
    win.addEventListener('keydown', this.onDown);
    win.addEventListener('keyup', this.onUp);
    win.addEventListener('blur', this.onBlur);
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** True once per physical key press (survives press+release between two polls). */
  wasPressed(code: string): boolean {
    return this.tapped.has(code);
  }

  /** Clears the per-poll press set; call at the end of each poll. */
  endFrame(): void {
    this.tapped.clear();
  }

  dispose(): void {
    const w = this.target;
    if (!w) return;
    w.removeEventListener('keydown', this.onDown);
    w.removeEventListener('keyup', this.onUp);
    w.removeEventListener('blur', this.onBlur);
    this.held.clear();
  }
}

function isEditable(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false;
  const el = t as HTMLElement;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}
