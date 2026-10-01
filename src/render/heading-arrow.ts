/**
 * Heading arrow for LOS / chase flying: a flat arrow through the quad along its nose direction
 * (yaw only), rolled about that direction to face the viewer so it never turns edge-on, and scaled
 * with viewing distance so it stays readable across the loft.
 */
import * as THREE from 'three';

/** arrow length (m) per metre of viewing distance, and its clamp */
const LEN_PER_M = 0.07;
const LEN_MIN = 0.28;
const LEN_MAX = 1.4;

const _f = new THREE.Vector3();
const _n = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Unit arrow along +X (tail at 0, tip at 1) in the XY plane. */
function arrowGeometry(): THREE.ShapeGeometry {
  const s = new THREE.Shape();
  const w = 0.09;
  const head = 0.58;
  const hw = 0.26;
  s.moveTo(0, -w);
  s.lineTo(head, -w);
  s.lineTo(head, -hw);
  s.lineTo(1, 0);
  s.lineTo(head, hw);
  s.lineTo(head, w);
  s.lineTo(0, w);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

export class HeadingArrow {
  readonly mesh: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;

  constructor() {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.86, 0.2), transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false });
    this.mesh = new THREE.Mesh(arrowGeometry(), mat);
    this.mesh.name = 'heading-arrow';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** `orientation` = drone attitude (only its yaw is used); hides itself when `visible` is false. */
  update(position: THREE.Vector3, orientation: THREE.Quaternion, eye: THREE.Vector3, visible: boolean): void {
    this.mesh.visible = visible;
    if (!visible) return;
    _f.set(0, 0, -1).applyQuaternion(orientation);
    _f.y = 0;
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
    _f.normalize();
    // face the eye: normal = eye direction with its along-arrow part removed
    _n.copy(eye).sub(position);
    const dist = _n.length();
    _n.addScaledVector(_f, -_n.dot(_f));
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    _y.crossVectors(_n, _f);
    const len = THREE.MathUtils.clamp(dist * LEN_PER_M, LEN_MIN, LEN_MAX);
    _m.makeBasis(_f, _y, _n).scale(_y.set(len, len, len));
    // tail just ahead of the quad so the arrow never hides it
    _m.setPosition(position.x + _f.x * 0.09, position.y, position.z + _f.z * 0.09);
    this.mesh.matrix.copy(_m);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
