/** Gamepad API reader (Standard mapping, Xbox layout). Picks the most recently active pad. */

/** Standard-mapping button indices. */
export const GP = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const BUTTON_COUNT = 17;
const ACTIVITY_AXIS = 0.3;
const ACTIVITY_DELTA = 0.15;

/** Copy of the relevant part of one pad for the current frame. */
export interface PadSnapshot {
  id: string;
  index: number;
  /** LX, LY, RX, RY (Standard: −1 = left / up) */
  axes: Float32Array;
  /** analog value 0..1 per button */
  values: Float32Array;
  pressed: boolean[];
}

interface PadTrack {
  lastAxes: Float32Array;
  lastActive: number;
}

type GamepadsFn = () => (Gamepad | null)[];

export class GamepadInput {
  readonly snap: PadSnapshot = {
    id: '',
    index: -1,
    axes: new Float32Array(4),
    values: new Float32Array(BUTTON_COUNT),
    pressed: new Array<boolean>(BUTTON_COUNT).fill(false),
  };
  /** Timestamp (ms) of the last activity on the selected pad, −∞ if never. */
  lastActivity = -Infinity;
  private tracks = new Map<number, PadTrack>();
  private activeIndex = -1;
  private readonly getPads: GamepadsFn | null;

  constructor(nav: Navigator | null) {
    this.getPads = nav && typeof nav.getGamepads === 'function' ? () => Array.from(nav.getGamepads()) : null;
  }

  /** Reads all pads; returns the selected pad snapshot or null when none is connected. */
  poll(now: number): PadSnapshot | null {
    if (!this.getPads) return null;
    let pads: (Gamepad | null)[];
    try {
      pads = this.getPads();
    } catch {
      return null;
    }
    let best: Gamepad | null = null;
    let bestTime = -Infinity;
    let fallback: Gamepad | null = null;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      fallback ??= gp;
      let tr = this.tracks.get(gp.index);
      if (!tr) {
        tr = { lastAxes: new Float32Array(4), lastActive: -Infinity };
        this.tracks.set(gp.index, tr);
      }
      if (this.isActive(gp, tr)) tr.lastActive = now;
      if (tr.lastActive > bestTime) {
        bestTime = tr.lastActive;
        best = gp;
      }
    }
    const pad = best ?? (this.activeIndex >= 0 ? (pads.find((p) => p?.index === this.activeIndex) ?? fallback) : fallback);
    if (!pad) {
      this.activeIndex = -1;
      return null;
    }
    this.activeIndex = pad.index;
    this.lastActivity = bestTime;
    this.copy(pad);
    return this.snap;
  }

  /** The live Gamepad object currently selected (for haptics). */
  activePad(): Gamepad | null {
    if (!this.getPads || this.activeIndex < 0) return null;
    try {
      return this.getPads().find((p) => p?.index === this.activeIndex) ?? null;
    } catch {
      return null;
    }
  }

  forget(index: number): void {
    this.tracks.delete(index);
    if (this.activeIndex === index) this.activeIndex = -1;
  }

  private isActive(gp: Gamepad, tr: PadTrack): boolean {
    let active = false;
    const n = Math.min(4, gp.axes.length);
    for (let i = 0; i < n; i++) {
      const v = gp.axes[i] ?? 0;
      if (Math.abs(v) > ACTIVITY_AXIS || Math.abs(v - tr.lastAxes[i]!) > ACTIVITY_DELTA) {
        active = true;
        tr.lastAxes[i] = v;
      }
    }
    const nb = Math.min(BUTTON_COUNT, gp.buttons.length);
    for (let i = 0; i < nb && !active; i++) {
      const b = gp.buttons[i];
      if (b && (b.pressed || b.value > 0.2)) active = true;
    }
    return active;
  }

  private copy(gp: Gamepad): void {
    const s = this.snap;
    s.id = gp.id;
    s.index = gp.index;
    for (let i = 0; i < 4; i++) {
      const v = gp.axes[i];
      s.axes[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    for (let i = 0; i < BUTTON_COUNT; i++) {
      const b = gp.buttons[i];
      s.values[i] = b ? b.value : 0;
      s.pressed[i] = b ? b.pressed || b.value > 0.5 : false;
    }
  }
}

/** Short, human-friendly controller name from a Gamepad id string. */
export function prettyPadName(id: string): string {
  const cleaned = id
    .replace(/\(.*?(Vendor|STANDARD GAMEPAD).*?\)/gi, '')
    .replace(/[0-9a-f]{4}-[0-9a-f]{4}-/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/xbox|xinput|045e/i.test(id)) return cleaned || 'Xbox Controller';
  return cleaned || 'Gamepad';
}
