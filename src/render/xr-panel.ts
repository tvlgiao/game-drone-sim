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
  /** 'menu' sits at eye level and larger; 'hud' sits low in view */
  layout: 'menu' | 'hud';
}

/** One drawn text line in canvas px; `width` is measured at `px` and never exceeds XR_CARD_TEXT_W. */
export interface XrCardLine {
  text: string;
  weight: number;
  px: number;
  colour: string;
  y: number;
  width: number;
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
const LINE_H = 1.12;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
/** canvas px per block; sub / hint are sized so their cap height clears ~1.1° on the flight card */
export const XR_CARD_PX = { title: 92, sub: 66, hint: 66 } as const;
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
    const key = `${c.title}\u0000${c.sub}\u0000${c.hint}\u0000${c.accent ?? ''}\u0000${c.layout}`;
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
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    this.lines = layoutCard(c, (t, weight, px) => {
      g.font = xrCardFont(weight, px);
      return g.measureText(t).width;
    });
    for (const l of this.lines) {
      g.fillStyle = l.colour;
      g.font = xrCardFont(l.weight, l.px);
      // no maxWidth: canvas would squeeze the glyphs horizontally; layoutCard wraps / shrinks instead
      g.fillText(l.text, XR_CARD_W / 2, l.y);
    }
    this.texture.needsUpdate = true;
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
  const menu = layout === 'menu';
  const down = menu ? 0.05 : XR_HUD_DOWN;
  const left = menu ? 0 : XR_HUD_LEFT;
  const dist = menu ? 0.9 : XR_HUD_DIST;
  pos.set(head.x - left, head.y - down, head.z - dist);
  rot.set(-Math.atan2(down, Math.hypot(dist, left)), Math.atan2(left, dist), 0, 'YXZ');
  return menu ? XR_MENU_WIDTH : XR_HUD_WIDTH;
}

type Measure = (text: string, weight: number, px: number) => number;

/**
 * Lays the title / sub / hint blocks out on the card: each block wraps to at most two lines (wrapHint)
 * and, if a line still overflows, that block's font shrinks uniformly; the whole stack shrinks if too tall.
 * Every returned line fits XR_CARD_TEXT_W at its own px, so none is drawn with a horizontal squeeze.
 */
export function layoutCard(c: XrPanelContent, measure: Measure): XrCardLine[] {
  const blocks = [
    { text: c.title, weight: 700, px: XR_CARD_PX.title, colour: c.accent ?? '#e9f6ff' },
    { text: c.sub, weight: 500, px: XR_CARD_PX.sub, colour: '#b9d3e6' },
    { text: c.hint, weight: 600, px: XR_CARD_PX.hint, colour: '#7fe3ff' },
  ].filter((b) => b.text !== '');
  for (let k = 1; ; k *= 0.94) {
    const laid = blocks.map((b) => fitBlock(b.text, b.weight, Math.floor(b.px * k), measure));
    const total = laid.reduce((h, l) => h + l.lines.length * l.px * LINE_H, 0) + BLOCK_GAP * Math.max(0, laid.length - 1);
    if (total > XR_CARD_H - 2 * PAD_Y && k > 0.3) continue;
    const out: XrCardLine[] = [];
    let y = (XR_CARD_H - total) / 2;
    laid.forEach((l, i) => {
      const { weight, colour } = blocks[i];
      const lh = l.px * LINE_H;
      for (const text of l.lines) {
        out.push({ text, weight, px: l.px, colour, y: y + lh / 2, width: measure(text, weight, l.px) });
        y += lh;
      }
      y += BLOCK_GAP;
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
  const parts = text.split(sep);
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
