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
const H = 384;
/** quad width in metres (height follows the canvas aspect) */
const QUAD_W = 0.64;

export class XrPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private key = '';
  /** canvas redraws + texture uploads so far (each is a full 1024×384 upload on the headset GPU) */
  draws = 0;
  private layout: XrPanelContent['layout'] = 'menu';

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

  set(c: XrPanelContent): void {
    this.layout = c.layout;
    const key = `${c.title}\u0000${c.sub}\u0000${c.hint}\u0000${c.accent ?? ''}\u0000${c.layout}`;
    if (key === this.key) return;
    this.key = key;
    this.draw(c);
  }

  /**
   * Places the card in dolly-local space in front of the reference head position `head`
   * (dolly forward is −Z): menus at eye level, the flight HUD low in view and tilted to face the eye.
   */
  place(head: THREE.Vector3): void {
    const menu = this.layout === 'menu';
    const down = menu ? 0.05 : 0.38;
    const dist = menu ? 0.9 : 0.75;
    this.mesh.position.set(head.x, head.y - down, head.z - dist);
    this.mesh.rotation.set(Math.atan2(down, dist), 0, 0);
    this.mesh.scale.setScalar(menu ? 1.25 : 1);
  }

  private draw(c: XrPanelContent): void {
    this.draws++;
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    const r = 36;
    g.fillStyle = 'rgba(6, 10, 20, 0.82)';
    g.strokeStyle = 'rgba(120, 220, 255, 0.55)';
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(4, 4, W - 8, H - 8, r);
    g.fill();
    g.stroke();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = c.accent ?? '#e9f6ff';
    g.font = '700 88px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(c.title, W / 2, 104, W - 64);
    g.fillStyle = '#b9d3e6';
    g.font = '500 54px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(c.sub, W / 2, 206, W - 64);
    g.fillStyle = '#7fe3ff';
    g.font = '600 46px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.fillText(c.hint, W / 2, 300, W - 64);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
