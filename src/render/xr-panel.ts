/**
 * In-headset HUD / menu card for WebXR: the DOM HUD is not composited into an immersive session,
 * so status and button hints are drawn to a canvas texture on a quad that rides with the XR dolly.
 * The canvas is only redrawn when the text changes.
 */
import * as THREE from 'three';

export interface XrPanelContent {
  /** large first line (status / timer) */
  title: string;
  /** second line (mode, camera, altitude…) */
  sub: string;
  /** button hints, bottom line */
  hint: string;
  /** accent colour of the title, CSS colour */
  accent?: string;
  /** small label above the title (tutorial step "STEP 2 / 12") */
  kicker?: string;
  /** 0..1: a drawn progress bar between the text and the hint line */
  progress?: number;
  /** 'menu' sits at eye level and larger; 'hud' sits low in view; 'card' (tutorial) a little further out, facing the pilot */
  layout: 'menu' | 'hud' | 'card';
}

/** One drawn text line in canvas px; `width` is measured at `px` and never exceeds XR_CARD_TEXT_W. */
export interface XrCardLine {
  text: string;
  weight: number;
  px: number;
  colour: string;
  y: number;
  width: number;
  /** a progress bar (0..1) drawn in this slot instead of text */
  bar?: number;
}

export interface XrPanelView extends XrPanelContent {
  lines: readonly XrCardLine[];
}

export const XR_CARD_W = 1024;
export const XR_CARD_H = 512;
const PAD_X = 64;
const PAD_Y = 36;
export const XR_CARD_TEXT_W = XR_CARD_W - 2 * PAD_X;
const BLOCK_GAP = 16;
/** the action line follows the text above it at line rhythm: a block gap there reads as a detached footer */
const HINT_GAP = 2;
const LINE_H = 1.12;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** canvas px per block; sub / hint are sized so their cap height clears ~1.1° on the flight card */
export const XR_CARD_PX = { title: 92, sub: 66, hint: 66 } as const;
/** tutorial card: step label, title, instruction, progress bar, skip line */
export const XR_TUT_PX = { kicker: 40, title: 76, sub: 54, hint: 46 } as const;
const BAR_H = 16;
/** menu cards are twice the flight card's angular size: their hints can step down below the title */
export const XR_MENU_HINT_PX = 56;
const HINT_COLOUR = '#7fe3ff';
const MENU_HINT_COLOUR = '#6aa9c2';
/** cap height / font size of system-ui (SF, Roboto, Segoe all ≈ 0.7) */
export const XR_CAP_RATIO = 0.7;
/**
 * Flight HUD placement in dolly-local metres from the head reference: low and a little left, below
 * the LOS line of sight to the quad and the flight path ahead in FPV / chase.
 */
export const XR_HUD_DOWN = 0.47;
export const XR_HUD_LEFT = 0.3;
const XR_HUD_DIST = 0.75;
/** quad widths in metres: the flight card spans ~25° of view, menus are larger at eye level */
export const XR_HUD_WIDTH = 0.41;
export const XR_MENU_WIDTH = 0.8;
/** tutorial card: ~1.2 m out, just under eye level (the drone sits low on the pad in LOS), ~42° wide */
export const XR_TUT_DIST = 1.2;
export const XR_TUT_DOWN = 0.12;
export const XR_TUT_WIDTH = 0.92;

/**
 * Quest button glyphs in card text: a part of a ' · '-separated line that starts with "A ", "B ", "X " or "Y "
 * is drawn as a round button glyph followed by the rest ("A Race", "Y › Skip tutorial").
 */
export interface XrTextRun {
  glyph: string | null;
  text: string;
}

export function xrTextRuns(line: string): XrTextRun[] {
  const out: XrTextRun[] = [];
  line.split(' · ').forEach((part, i) => {
    if (i > 0) out.push({ glyph: null, text: ' · ' });
    const m = /^([ABXY]) (\S.*)$/.exec(part);
    if (m) out.push({ glyph: m[1]!, text: m[2]! });
    else out.push({ glyph: null, text: part });
  });
  return out;
}

/** glyph circle diameter and the gap after it, per font px */
const GLYPH_D = 1.0;
const GLYPH_GAP = 0.28;
const GLYPH_TONE: Record<string, string> = { A: '#3ddc84', B: '#ff6b6b', X: '#5aa9ff', Y: '#ffd24d' };

/** Width of a line with its glyphs, for any text measure at `px`. */
export function measureRuns(line: string, px: number, measureText: (t: string) => number): number {
  let w = 0;
  for (const r of xrTextRuns(line)) {
    if (r.glyph) w += px * (GLYPH_D + GLYPH_GAP);
    w += measureText(r.text);
  }
  return w;
}

export const xrCardFont = (weight: number, px: number): string => `${weight} ${px}px ${FONT}`;

export class XrPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private key = '';
  /** canvas redraws + texture uploads so far (each is a full card upload on the headset GPU) */
  draws = 0;
  private layout: XrPanelContent['layout'] = 'menu';
  private current: XrPanelContent | null = null;
  private lines: XrCardLine[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = XR_CARD_W;
    this.canvas.height = XR_CARD_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, XR_CARD_H / XR_CARD_W), mat);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'xr-panel';
  }

  /** last content set plus its laid-out lines (tests / debug hook) */
  get content(): Readonly<XrPanelView> | null {
    return this.current && { ...this.current, lines: this.lines };
  }

  set(c: XrPanelContent): void {
    this.layout = c.layout;
    this.current = c;
    const key = `${c.title}\u0000${c.sub}\u0000${c.hint}\u0000${c.accent ?? ''}\u0000${c.layout}\u0000${c.kicker ?? ''}\u0000${c.progress === undefined ? '' : c.progress.toFixed(2)}`;
    if (key === this.key) return;
    this.key = key;
    this.draw(c);
  }

  /** Places the card in front of the reference head position `head` (see xrPanelPose). */
  place(head: THREE.Vector3): void {
    this.mesh.scale.setScalar(xrPanelPose(this.layout, head, this.mesh.position, this.mesh.rotation));
  }

  private draw(c: XrPanelContent): void {
    this.draws++;
    const g = this.ctx;
    g.clearRect(0, 0, XR_CARD_W, XR_CARD_H);
    // near-opaque: the loft (rings, neon) must not read through the text
    g.fillStyle = 'rgba(6, 10, 20, 0.94)';
    g.strokeStyle = 'rgba(120, 220, 255, 0.55)';
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(4, 4, XR_CARD_W - 8, XR_CARD_H - 8, 36);
    g.fill();
    g.stroke();
    g.textBaseline = 'middle';
    this.lines = layoutCard(c, (t, weight, px) => {
      g.font = xrCardFont(weight, px);
      return measureRuns(t, px, (x) => g.measureText(x).width);
    });
    for (const l of this.lines) {
      if (l.bar !== undefined) {
        this.drawBar(l);
        continue;
      }
      g.font = xrCardFont(l.weight, l.px);
      // no maxWidth: canvas would squeeze the glyphs horizontally; layoutCard wraps / shrinks instead
      let x = (XR_CARD_W - l.width) / 2;
      g.textAlign = 'left';
      for (const r of xrTextRuns(l.text)) {
        if (r.glyph) {
          const d = l.px * GLYPH_D;
          g.fillStyle = GLYPH_TONE[r.glyph] ?? l.colour;
          g.beginPath();
          g.arc(x + d / 2, l.y, d / 2, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#0a0f1a';
          g.font = xrCardFont(800, Math.round(l.px * 0.66));
          g.textAlign = 'center';
          g.fillText(r.glyph, x + d / 2, l.y + l.px * 0.03);
          g.textAlign = 'left';
          g.font = xrCardFont(l.weight, l.px);
          x += l.px * (GLYPH_D + GLYPH_GAP);
        }
        g.fillStyle = l.colour;
        g.fillText(r.text, x, l.y);
        x += g.measureText(r.text).width;
      }
    }
    this.texture.needsUpdate = true;
  }

  private drawBar(l: XrCardLine): void {
    const g = this.ctx;
    const w = XR_CARD_TEXT_W;
    const x = (XR_CARD_W - w) / 2;
    const h = BAR_H;
    g.fillStyle = 'rgba(255, 255, 255, 0.12)';
    g.beginPath();
    g.roundRect(x, l.y - h / 2, w, h, h / 2);
    g.fill();
    const v = Math.min(1, Math.max(0, l.bar ?? 0));
    if (v > 0) {
      const grad = g.createLinearGradient(x, 0, x + w, 0);
      grad.addColorStop(0, '#28e7ff');
      grad.addColorStop(1, '#3dffa0');
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect(x, l.y - h / 2, Math.max(h, w * v), h, h / 2);
      g.fill();
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}

/**
 * Card pose in dolly-local space for the head reference `head` (dolly forward is −Z): menus at eye level,
 * the flight HUD low and to the left. The card's normal points straight at the eye, so the text is
 * not foreshortened. Writes `pos` / `rot`; returns the quad width in metres (the mesh's uniform scale).
 */
export function xrPanelPose(layout: XrPanelContent['layout'], head: THREE.Vector3, pos: THREE.Vector3, rot: THREE.Euler): number {
  const hud = layout === 'hud';
  const card = layout === 'card';
  const down = hud ? XR_HUD_DOWN : card ? XR_TUT_DOWN : 0.05;
  const left = hud ? XR_HUD_LEFT : 0;
  const dist = hud ? XR_HUD_DIST : card ? XR_TUT_DIST : 0.9;
  pos.set(head.x - left, head.y - down, head.z - dist);
  rot.set(-Math.atan2(down, Math.hypot(dist, left)), Math.atan2(left, dist), 0, 'YXZ');
  return hud ? XR_HUD_WIDTH : card ? XR_TUT_WIDTH : XR_MENU_WIDTH;
}

type Measure = (text: string, weight: number, px: number) => number;

/** Words of `text`, but a parenthesised group ("(Left stick ↑)") stays one word and an arrow never starts a line. */
function wordsKeepingGroups(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const w of text.split(' ')) {
    const glue = out.length > 0 && (depth > 0 || /^[↑↓←→↕↔]/.test(w));
    if (glue) out[out.length - 1] += ` ${w}`;
    else out.push(w);
    depth += (w.match(/\(/g)?.length ?? 0) - (w.match(/\)/g)?.length ?? 0);
  }
  return out;
}

/**
 * Lays the title / sub / hint blocks out on the card: each block wraps to at most two lines (wrapHint)
 * and, if a line still overflows, that block's font shrinks uniformly; the whole stack shrinks if too tall.
 * Every returned line fits XR_CARD_TEXT_W at its own px, so none is drawn with a horizontal squeeze.
 */
export function layoutCard(c: XrPanelContent, measure: Measure): XrCardLine[] {
  const menu = c.layout === 'menu';
  const card = c.layout === 'card';
  const accent = c.accent ?? '#e9f6ff';
  const blocks: { text: string; weight: number; px: number; colour: string; gap: number; bar?: number }[] = [
    { text: c.kicker ?? '', weight: 700, px: XR_TUT_PX.kicker, colour: accent, gap: 0 },
    { text: c.title, weight: 700, px: card ? XR_TUT_PX.title : XR_CARD_PX.title, colour: card ? '#e9f6ff' : accent, gap: c.kicker ? 6 : 0 },
    { text: c.sub, weight: 500, px: card ? XR_TUT_PX.sub : XR_CARD_PX.sub, colour: card ? '#d5e6f3' : '#b9d3e6', gap: BLOCK_GAP },
    ...(c.progress === undefined ? [] : [{ text: '', weight: 0, px: BAR_H / LINE_H, colour: '', gap: BLOCK_GAP + 8, bar: c.progress }]),
    { text: c.hint, weight: 600, px: card ? XR_TUT_PX.hint : menu ? XR_MENU_HINT_PX : XR_CARD_PX.hint, colour: menu || card ? MENU_HINT_COLOUR : HINT_COLOUR, gap: card ? BLOCK_GAP + 4 : HINT_GAP },
  ].filter((b) => b.text !== '' || b.bar !== undefined);
  // the tight hint gap applies only under the sub line; under the title alone it keeps a block gap
  const gaps = blocks.map((b, i) => (i === 0 ? 0 : b.gap === HINT_GAP && blocks[i - 1].gap === 0 ? BLOCK_GAP : b.gap));
  for (let k = 1; ; k *= 0.94) {
    const laid = blocks.map((b) => (b.bar !== undefined ? { lines: [''], px: b.px } : fitBlock(b.text, b.weight, Math.floor(b.px * k), measure)));
    const total = laid.reduce((h, l, i) => h + l.lines.length * l.px * LINE_H + gaps[i], 0);
    if (total > XR_CARD_H - 2 * PAD_Y && k > 0.3) continue;
    const out: XrCardLine[] = [];
    let y = (XR_CARD_H - total) / 2;
    laid.forEach((l, i) => {
      const { weight, colour, bar } = blocks[i];
      const lh = l.px * LINE_H;
      y += gaps[i];
      for (const text of l.lines) {
        if (bar !== undefined) out.push({ text: '', weight, px: l.px, colour, y: y + lh / 2, width: XR_CARD_TEXT_W, bar });
        else out.push({ text, weight, px: l.px, colour, y: y + lh / 2, width: measure(text, weight, l.px) });
        y += lh;
      }
    });
    return out;
  }
}

function fitBlock(text: string, weight: number, px: number, measure: Measure): { lines: string[]; px: number } {
  const lines = wrapHint(text, (t) => measure(t, weight, px), XR_CARD_TEXT_W);
  const widest = (p: number): number => Math.max(...lines.map((t) => measure(t, weight, p)));
  let p = px;
  for (let w = widest(p); p > 8 && w > XR_CARD_TEXT_W; w = widest(p)) p = Math.min(p - 1, Math.floor((p * XR_CARD_TEXT_W) / w));
  return { lines, px: p };
}

/**
 * Splits `text` into at most two lines when it is wider than `max`, breaking at the ' · ' separator
 * (or, for text without one, the space) that balances the lines best. A line may still exceed `max`
 * when no break fits; the caller shrinks the font for that.
 */
export function wrapHint(text: string, measure: (t: string) => number, max: number): string[] {
  if (measure(text) <= max) return [text];
  const sep = text.includes(' · ') ? ' · ' : ' ';
  const parts = sep === ' · ' ? text.split(sep) : wordsKeepingGroups(text);
  if (parts.length < 2) return [text];
  let best: string[] = [text];
  let bestW = Infinity;
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join(sep);
    const b = parts.slice(i).join(sep);
    const w = Math.max(measure(a), measure(b));
    if (w < bestW) {
      bestW = w;
      best = [a, b];
    }
  }
  return best;
}
