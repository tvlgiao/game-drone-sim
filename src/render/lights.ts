/** Lighting rig: moonlight (static shadow), practical spots, cheap point lights, PMREM environment. */
import * as THREE from 'three';
import type { QualityProfile } from '../core/quality';
import type { IndoorLevel } from '../types';

/** Direction moonlight travels (from outside NE, high) — enters the north and east windows. */
export const MOON_DIR = new THREE.Vector3(-7, -10, 11).normalize();

interface Practical {
  light: THREE.PointLight;
  base: number;
  flicker: number;
  phase: number;
  /** lower = kept on lower tiers */
  priority: number;
}

export class Lights {
  readonly hemi: THREE.HemisphereLight;
  readonly moon: THREE.DirectionalLight;
  readonly spots: THREE.SpotLight[] = [];
  readonly ringLight: THREE.PointLight;
  private readonly practicals: Practical[] = [];
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private profile: QualityProfile | null = null;

  constructor(private readonly scene: THREE.Object3D, level: Pick<IndoorLevel, 'room' | 'props'>) {
    const [sx, sy, sz] = level.room.size;
    this.hemi = new THREE.HemisphereLight(0x8fa6d8, 0x3a2a20, 0.55);
    scene.add(this.hemi);

    this.moon = new THREE.DirectionalLight(0xa9c1ff, 2.6);
    this.moon.position.copy(MOON_DIR).multiplyScalar(-30);
    this.moon.target.position.set(0, 0, 0);
    scene.add(this.moon, this.moon.target);
    this.fitMoonShadow(sx, sy, sz);

    // Warm key spot over the living area and a grazing wall-washer on the north brick wall.
    const living = new THREE.SpotLight(0xffb070, 70, 0, 0.72, 0.85, 2);
    living.position.set(5.4, 5.85, 3.2);
    living.target.position.set(4.6, 0, 5.2);
    const washer = new THREE.SpotLight(0xffd2a0, 55, 0, 0.62, 0.9, 2);
    washer.position.set(-4.5, 5.85, -5.2);
    washer.target.position.set(-4.5, 1.2, -7.2);
    const wash2 = new THREE.SpotLight(0xbfd4ff, 30, 0, 0.7, 0.9, 2);
    wash2.position.set(-9.5, 5.85, 2.5);
    wash2.target.position.set(-12, 2.2, 1.5);
    for (const s of [living, washer, wash2]) {
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.02;
      s.shadow.radius = 4;
      s.shadow.camera.near = 0.3;
      s.shadow.camera.far = 14;
      s.shadow.autoUpdate = false;
      scene.add(s, s.target);
      this.spots.push(s);
    }

    // Practicals derived from level props.
    const bulbs = level.props.filter((p) => p.kind === 'bulb-hanging');
    const clusterA = bulbs.slice(0, 3);
    const clusterB = bulbs.slice(3, 5);
    const rest = bulbs.slice(5);
    const avg = (ps: typeof bulbs) => {
      const v = new THREE.Vector3();
      for (const p of ps) v.add(new THREE.Vector3(p.position[0], p.position[1] + 0.05, p.position[2]));
      return v.multiplyScalar(1 / Math.max(1, ps.length));
    };
    const warm = 0xffa45a;
    if (clusterA.length) this.addPractical(avg(clusterA), warm, 9 * clusterA.length, 0, 0.04);
    if (clusterB.length) this.addPractical(avg(clusterB), warm, 9 * clusterB.length, 0, 0.04);
    for (const b of rest) this.addPractical(avg([b]), warm, 9, 2, 0.05);
    const lamp = level.props.find((p) => p.kind === 'lamp-floor');
    if (lamp) this.addPractical(new THREE.Vector3(lamp.position[0], lamp.position[1] + lamp.size[1] - 0.25, lamp.position[2]), 0xffc080, 10, 1, 0.02);
    const tv = level.props.find((p) => p.kind === 'tv-wall');
    if (tv) this.addPractical(new THREE.Vector3(tv.position[0], tv.position[1] + tv.size[1] / 2, tv.position[2] + 0.9), 0x7a6cff, 5, 3, 0.15);
    // neon sign glow on the west brick wall
    this.addPractical(new THREE.Vector3(-sx / 2 + 0.6, 3.3, 0.6), 0xff4fb8, 6, 3, 0.03);

    this.ringLight = new THREE.PointLight(0x19e6ff, 0, 7, 2);
    scene.add(this.ringLight);
  }

  private addPractical(pos: THREE.Vector3, color: number, intensity: number, priority: number, flicker: number): void {
    const l = new THREE.PointLight(color, intensity, 0, 2);
    l.position.copy(pos);
    this.scene.add(l);
    this.practicals.push({ light: l, base: intensity, flicker, phase: this.practicals.length * 1.7, priority });
  }

  private fitMoonShadow(sx: number, sy: number, sz: number): void {
    const cam = this.moon.shadow.camera;
    this.moon.updateMatrixWorld();
    this.moon.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(this.moon.position, this.moon.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(this.moon.position);
    const inv = view.clone().invert();
    const box = new THREE.Box3();
    const m = 0.5;
    for (const x of [-sx / 2 - m, sx / 2 + m]) for (const y of [0, sy + 0.4]) for (const z of [-sz / 2 - m, sz / 2 + m]) {
      box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inv));
    }
    cam.left = box.min.x;
    cam.right = box.max.x;
    cam.bottom = box.min.y;
    cam.top = box.max.y;
    cam.near = Math.max(0.1, -box.max.z);
    cam.far = -box.min.z;
    cam.updateProjectionMatrix();
    this.moon.shadow.bias = -0.0003;
    this.moon.shadow.normalBias = 0.03;
    this.moon.shadow.radius = 3;
    this.moon.shadow.autoUpdate = false;
  }

  /** Build a small custom env scene (dark loft, cool windows, warm practicals) into PMREM. */
  buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
    const env = new THREE.Scene();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const room = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x1b1d22, side: THREE.BackSide }));
    room.scale.set(24, 6, 14);
    room.position.y = 3;
    env.add(room);
    const panel = (x: number, y: number, z: number, w: number, h: number, d: number, c: THREE.Color) => {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c }));
      mesh.position.set(x, y, z);
      mesh.scale.set(w, h, d);
      env.add(mesh);
    };
    const cool = new THREE.Color(0.55, 0.7, 1.4);
    panel(-6, 3.9, -6.95, 3, 2.6, 0.1, cool);
    panel(2.5, 3.9, -6.95, 3, 2.6, 0.1, cool);
    panel(11.95, 3.2, 0, 0.1, 3.2, 4.5, cool);
    panel(0, 3.2, 6.95, 5, 3, 0.1, new THREE.Color(1.2, 0.7, 0.6));
    const warm = new THREE.Color(6, 3.6, 1.8);
    panel(0, 4.2, -2.2, 0.6, 0.3, 0.6, warm);
    panel(6, 3.7, 4.8, 0.6, 0.3, 0.6, warm);
    panel(-9, 3.9, 4.4, 0.4, 0.3, 0.4, warm);
    panel(0, 0.02, 0, 24, 0.04, 14, new THREE.Color(0.12, 0.11, 0.1));
    panel(-11.9, 3.3, 0.6, 0.05, 0.6, 2.6, new THREE.Color(3, 0.5, 2));
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = pmrem.fromScene(env, 0.035, 0.1, 40);
    pmrem.dispose();
    env.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
    });
    geo.dispose();
    return this.envTarget.texture;
  }

  /** Apply tier: shadow casters, map sizes, how many practicals stay on. */
  setQuality(p: QualityProfile): void {
    this.profile = p;
    this.moon.castShadow = p.shadows;
    this.moon.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    this.moon.shadow.map?.dispose();
    this.moon.shadow.map = null;
    this.moon.shadow.needsUpdate = true;
    const spotSize = Math.max(512, p.shadowMapSize / 2);
    this.spots.forEach((s, i) => {
      s.castShadow = p.shadows && i < p.shadowSpots;
      s.shadow.mapSize.set(spotSize, spotSize);
      s.shadow.map?.dispose();
      s.shadow.map = null;
      s.shadow.needsUpdate = true;
      s.visible = p.tier !== 'low' || i === 0;
    });
    const sorted = [...this.practicals].sort((a, b) => a.priority - b.priority);
    const budget = Math.max(0, p.pointLights - 1); // ring light always counts
    sorted.forEach((pr, i) => {
      pr.light.visible = i < budget;
      // Compensate for dropped lights on low tiers so the room is not darker.
      pr.light.intensity = pr.base * (p.pointLights < 6 ? 1.4 : 1);
    });
    this.hemi.intensity = p.tier === 'low' ? 0.7 : 0.55;
  }

  /** Request re-render of static shadow maps on next frame. */
  refreshShadows(): void {
    this.moon.shadow.needsUpdate = true;
    for (const s of this.spots) s.shadow.needsUpdate = true;
  }

  update(time: number): void {
    const boost = this.profile && this.profile.pointLights < 6 ? 1.4 : 1;
    for (const p of this.practicals) {
      if (!p.light.visible || p.flicker === 0) continue;
      const n = Math.sin(time * 7.3 + p.phase) * 0.5 + Math.sin(time * 17.1 + p.phase * 2.3) * 0.3 + Math.sin(time * 2.1 + p.phase) * 0.2;
      p.light.intensity = p.base * boost * (1 + n * p.flicker);
    }
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.moon.shadow.map?.dispose();
    for (const s of this.spots) s.shadow.map?.dispose();
    this.moon.dispose();
    this.hemi.dispose();
    this.ringLight.dispose();
    for (const s of this.spots) s.dispose();
    for (const p of this.practicals) p.light.dispose();
  }
}
