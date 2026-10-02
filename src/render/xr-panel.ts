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

const W = 1024;
const H = 448;
/** quad width in metres (height follows the canvas aspect) */
const QUAD_W = 0.64;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const HINT_PX = 56;
const TEXT_W = W - 64;
/**
 * Flight HUD placement in dolly-local metres from the head reference: low and a little left, below
 * the LOS line of sight to the quad and the flight path ahead in FPV / chase.
 */
export const XR_HUD_DOWN = 0.47;
export const XR_HUD_LEFT = 0.3;
const XR_HUD_DIST = 0.75;

export class XrPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private key = '';
  /** canvas redraws + texture uploads so far (each is a full 1024×448 upload on the headset GPU) */
  draws = 0;
  private layout: XrPanelContent['layout'] = 'menu';
  private current: XrPanelContent | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(QUAD_W, (QUAD_W * H) / W), mat);
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'xr-panel';
  }

  /** last content set (tests / debug hook) */
  get content(): Readonly<XrPanelContent> | null {
    return this.current;
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
    g.clearRect(0, 0, W, H);
    const r = 36;
    // near-opaque: the loft (rings, neon) must not read through the text
    g.fillStyle = 'rgba(6, 10, 20, 0.94)';
    g.strokeStyle = 'rgba(120, 220, 255, 0.55)';
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(4, 4, W - 8, H - 8, r);
    g.fill();
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = c.accent ?? '#e9f6ff';
    g.font = `700 88px ${FONT}`;
    g.fillText(c.title, W / 2, 96, TEXT_W);
    g.fillStyle = '#b9d3e6';
    g.font = `500 54px ${FONT}`;
    g.fillText(c.sub, W / 2, 192, TEXT_W);
    g.fillStyle = '#7fe3ff';
    g.font = `600 ${HINT_PX}px ${FONT}`;
    const lines = wrapHint(c.hint, (t) => g.measureText(t).width, TEXT_W);
    const top = lines.length > 1 ? 290 : 320;
    lines.forEach((line, i) => g.fillText(line, W / 2, top + i * (HINT_PX + 10), TEXT_W));
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
 * not foreshortened. Writes `pos` / `rot`; returns the uniform scale.
 */
export function xrPanelPose(layout: XrPanelContent['layout'], head: THREE.Vector3, pos: THREE.Vector3, rot: THREE.Euler): number {
  const menu = layout === 'menu';
  const down = menu ? 0.05 : XR_HUD_DOWN;
  const left = menu ? 0 : XR_HUD_LEFT;
  const dist = menu ? 0.9 : XR_HUD_DIST;
  pos.set(head.x - left, head.y - down, head.z - dist);
  rot.set(-Math.atan2(down, Math.hypot(dist, left)), Math.atan2(left, dist), 0, 'YXZ');
  return menu ? 1.25 : 1;
}

/**
 * Splits a ' · '-separated hint into at most two lines when it is wider than `max`, breaking at the
 * separator that balances the lines best (a single line is squeezed by fillText's maxWidth instead).
 */
export function wrapHint(hint: string, measure: (t: string) => number, max: number): string[] {
  if (measure(hint) <= max) return [hint];
  const parts = hint.split(' · ');
  if (parts.length < 2) return [hint];
  let best: string[] = [hint];
  let bestW = Infinity;
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join(' · ');
    const b = parts.slice(i).join(' · ');
    const w = Math.max(measure(a), measure(b));
    if (w < bestW) {
      bestW = w;
      best = [a, b];
    }
  }
  return best;
}
