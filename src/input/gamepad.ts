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
/** Axes copied / watched per pad (covers non-standard pads that put sticks on axes 4+). */
export const MAX_AXES = 16;
const ACTIVITY_AXIS = 0.3;
const ACTIVITY_DELTA = 0.15;

/** Copy of the relevant part of one pad for the current frame. */
export interface PadSnapshot {
  id: string;
  index: number;
  mapping: string;
  /** raw axes (Standard: 0..3 = LX, LY, RX, RY; −1 = left / up); valid up to axisCount */
  axes: Float64Array;
  axisCount: number;
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
    mapping: '',
    axes: new Float64Array(MAX_AXES),
    axisCount: 0,
    values: new Float32Array(BUTTON_COUNT),
    pressed: new Array<boolean>(BUTTON_COUNT).fill(false),
  };
  /** Timestamp (ms) of the last activity on the selected pad, −∞ if never. */
  lastActivity = -Infinity;
  private tracks = new Map<number, PadTrack>();
  private activeIndex = -1;
  private readonly getPads: GamepadsFn | null;

  constructor(nav: Navigator | null) {
    this.getPads = nav && typeof nav.getGamepads === 'function' ? () => nav.getGamepads() : null;
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
        tr = { lastAxes: new Float32Array(MAX_AXES), lastActive: -Infinity };
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

  /** Gamepad index of the selected pad, −1 when none. */
  get selectedIndex(): number {
    return this.activeIndex;
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
    const n = Math.min(MAX_AXES, gp.axes.length);
    for (let i = 0; i < n; i++) {
      const v = gp.axes[i] ?? 0;
      // Sticks of a standard pad rest at 0; other axes (triggers on non-standard pads) may rest at ±1.
      const deflected = i < 4 && gp.mapping === 'standard' && Math.abs(v) > ACTIVITY_AXIS;
      if (deflected || Math.abs(v - tr.lastAxes[i]!) > ACTIVITY_DELTA) {
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
    s.mapping = gp.mapping ?? '';
    s.axisCount = Math.min(MAX_AXES, gp.axes.length);
    for (let i = 0; i < MAX_AXES; i++) {
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
