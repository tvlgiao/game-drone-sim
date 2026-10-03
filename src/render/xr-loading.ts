/**
 * The headset's loading environment during a level switch: a dark room-sized sphere with a faint floor grid, and in
 * front of the pilot's head a progress ring around the level name and the percentage (a canvas card). Cheap: three
 * draws, no lights, no post; the GameView renders it instead of the level each XR frame while a load runs.
 */
import * as THREE from 'three';

const RING_SEGMENTS = 96;
const CARD_W = 512;
const CARD_H = 256;

export class XrLoadingPanel {
  readonly scene = new THREE.Scene();
  private readonly root = new THREE.Group();
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly track: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly card: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: THREE.CanvasTexture;
  private readonly shell: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private drawn = '';
  private readonly dollyPos = new THREE.Vector3();
  private readonly dollyQ = new THREE.Quaternion();

  constructor() {
    this.scene.background = new THREE.Color(0x05080f);
    const shellMat = new THREE.MeshBasicMaterial({ color: 0x0b1424, side: THREE.BackSide });
    this.shell = new THREE.Mesh(new THREE.SphereGeometry(30, 24, 12), shellMat);
    this.grid = new THREE.GridHelper(40, 40, 0x1b3554, 0x10223a);
    this.track = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.215, RING_SEGMENTS), new THREE.MeshBasicMaterial({ color: 0x1d3550 }));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.215, RING_SEGMENTS, 1, Math.PI / 2, Math.PI * 2), new THREE.MeshBasicMaterial({ color: 0x28e7ff, side: THREE.DoubleSide }));
    this.canvas = document.createElement('canvas');
    this.canvas.width = CARD_W;
    this.canvas.height = CARD_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.card = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.18), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }));
    this.ring.position.z = this.track.position.z = -0.001;
    this.root.add(this.track, this.ring, this.card);
    this.scene.add(this.shell, this.grid, this.root);
  }

  /** Places the panel 1.4 m in front of the head (the dolly's frame), sets the ring and the card text. */
  update(name: string, progress: number, dolly: THREE.Object3D, head: THREE.Camera): void {
    dolly.updateMatrixWorld();
    dolly.matrixWorld.decompose(this.dollyPos, this.dollyQ, new THREE.Vector3());
    // the room travels with the pilot: the floor grid sits under the dolly wherever the level left it
    this.shell.position.copy(this.dollyPos);
    this.grid.position.copy(this.dollyPos);
    const y = Math.max(1.1, head.position.y || 1.6);
    this.root.position.set(0, y, -1.4).applyQuaternion(this.dollyQ).add(this.dollyPos);
    this.root.quaternion.copy(this.dollyQ);
    const p = Math.min(1, Math.max(0, progress));
    // the ring's index range: whole segments, from the top
    this.ring.geometry.setDrawRange(0, Math.round(p * RING_SEGMENTS) * 6);
    const pct = Math.floor(p * 100);
    const key = `${name}|${pct}`;
    if (key !== this.drawn && this.ctx) {
      this.drawn = key;
      const c = this.ctx;
      c.clearRect(0, 0, CARD_W, CARD_H);
      c.textAlign = 'center';
      c.fillStyle = 'rgba(200,225,245,0.75)';
      c.font = '600 26px system-ui, sans-serif';
      c.fillText('LOADING', CARD_W / 2, 70);
      c.fillStyle = '#eaf6ff';
      c.font = '800 44px system-ui, sans-serif';
      c.fillText(name.toUpperCase(), CARD_W / 2, 135, CARD_W - 40);
      c.fillStyle = '#28e7ff';
      c.font = '700 38px ui-monospace, monospace';
      c.fillText(`${pct}%`, CARD_W / 2, 200);
      this.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.texture.dispose();
  }
}
