/** Drone contact shadow blob + LED ground glow, projected on the floor or the prop top below. */
import * as THREE from 'three';
import type { LevelDef } from '../../types';

interface TopSurface {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  cos: number;
  sin: number;
  top: number;
}

export class ContactShadow {
  readonly group = new THREE.Group();
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly surfaces: TopSurface[] = [];
  /** height of the drone above the surface under it (m), updated each frame */
  height = 10;
  surfaceY = 0;

  constructor(level: LevelDef, radial: THREE.Texture) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x000000, map: radial, transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.glow = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.8, 1), map: radial, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    );
    this.shadow.renderOrder = 1;
    this.glow.renderOrder = 1;
    this.group.add(this.shadow, this.glow);
    for (const p of level.props) {
      for (const c of p.colliders) {
        if (c.shape.kind !== 'box' || c.dynamic) continue;
        if (p.kind === 'bulb-hanging' || p.kind === 'beam' || p.kind === 'duct') continue;
        const s = c.shape;
        const yaw = s.yaw ?? 0;
        this.surfaces.push({ cx: s.center[0], cz: s.center[2], hx: s.half[0], hz: s.half[2], cos: Math.cos(yaw), sin: Math.sin(yaw), top: s.center[1] + s.half[1] });
      }
      if (p.kind === 'rug') this.surfaces.push({ cx: p.position[0], cz: p.position[2], hx: p.size[0] / 2, hz: p.size[2] / 2, cos: 1, sin: 0, top: p.size[1] });
    }
  }

  update(pos: THREE.Vector3, ledColor: THREE.Color, ledOn: number): void {
    let y = 0;
    for (const s of this.surfaces) {
      if (s.top > pos.y || s.top <= y) continue;
      const dx = pos.x - s.cx;
      const dz = pos.z - s.cz;
      // world -> local = R_y(-yaw)
      const lx = s.cos * dx - s.sin * dz;
      const lz = s.sin * dx + s.cos * dz;
      if (Math.abs(lx) <= s.hx && Math.abs(lz) <= s.hz) y = s.top;
    }
    this.surfaceY = y;
    const h = Math.max(0, pos.y - y);
    this.height = h;
    const fade = Math.max(0, 1 - h / 2.5);
    this.shadow.visible = fade > 0.01;
    this.shadow.position.set(pos.x, y + 0.004, pos.z);
    this.shadow.scale.setScalar(0.2 + h * 0.18);
    this.shadow.material.opacity = 0.75 * fade * fade;
    const g = Math.max(0, 1 - h / 1.2) * ledOn;
    this.glow.visible = g > 0.01;
    this.glow.position.set(pos.x, y + 0.006, pos.z);
    this.glow.scale.setScalar(0.3 + h * 0.5);
    this.glow.material.color.copy(ledColor);
    this.glow.material.opacity = g * 0.5;
  }

  dispose(): void {
    this.shadow.geometry.dispose();
    this.shadow.material.dispose();
    this.glow.material.dispose();
  }
}
