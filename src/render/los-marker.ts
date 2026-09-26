/**
 * Screen-constant locator around the drone for the LOS (standing pilot) camera: at 15–20 m a
 * 13 cm quad is only a few pixels, so a thin ring + range label keeps it trackable.
 */
import * as THREE from 'three';

const SIZE = 128;

function markerTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const m = SIZE / 2;
  g.strokeStyle = 'rgba(120, 240, 255, 0.95)';
  g.lineWidth = 7;
  g.shadowColor = 'rgba(0, 220, 255, 0.9)';
  g.shadowBlur = 8;
  // four corner brackets
  const r = m - 10;
  const k = 16;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    g.beginPath();
    g.moveTo(m + sx * r, m + sy * (r - k));
    g.lineTo(m + sx * r, m + sy * r);
    g.lineTo(m + sx * (r - k), m + sy * r);
    g.stroke();
  }
  g.beginPath();
  g.arc(m, m, 4, 0, Math.PI * 2);
  g.fillStyle = 'rgba(160, 250, 255, 0.9)';
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LosMarker {
  readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;

  constructor() {
    this.material = new THREE.SpriteMaterial({
      map: markerTexture(),
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      fog: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.renderOrder = 20;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
  }

  /** weight = LOS blend 0..1; fades in with distance so it never clutters a close drone. */
  update(dronePos: THREE.Vector3, camPos: THREE.Vector3, weight: number, time: number): void {
    const dist = dronePos.distanceTo(camPos);
    const a = weight * THREE.MathUtils.clamp((dist - 3) / 4, 0, 1);
    this.sprite.visible = a > 0.01;
    if (!this.sprite.visible) return;
    this.sprite.position.copy(dronePos);
    this.material.opacity = a * (0.75 + 0.25 * Math.sin(time * 4));
    const s = 0.085 + 0.015 * Math.min(1, (dist - 3) / 12);
    this.sprite.scale.set(s, s, 1);
  }

  dispose(): void {
    this.material.map?.dispose();
    this.material.dispose();
  }
}
