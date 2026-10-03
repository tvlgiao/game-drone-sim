/**
 * Heading arrow for LOS / chase flying: three chevrons through the quad along its nose direction
 * (yaw only), rolled about that direction to face the viewer so they never turn edge-on, scaled
 * with viewing distance so they stay readable across the loft. A soft light pulse runs tail → tip.
 */
import * as THREE from 'three';

/** arrow length (m) per metre of viewing distance, and its clamp */
const LEN_PER_M = 0.07;
const LEN_MIN = 0.28;
const LEN_MAX = 1.4;
const CHEVRONS = 3;

const _f = new THREE.Vector3();
const _n = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Unit arrow along +X (tail at 0, tip at 1) in the XY plane: CHEVRONS nested chevrons. */
function chevronGeometry(): THREE.ShapeGeometry {
  const shapes: THREE.Shape[] = [];
  const step = 1 / CHEVRONS;
  const depth = 0.2;
  const th = 0.13;
  for (let i = 0; i < CHEVRONS; i++) {
    const tip = (i + 1) * step;
    const back = tip - depth;
    const hw = 0.2 + i * 0.03;
    const s = new THREE.Shape();
    s.moveTo(tip, 0);
    s.lineTo(back, hw);
    s.lineTo(back - th * 0.7, hw);
    s.lineTo(tip - th, 0);
    s.lineTo(back - th * 0.7, -hw);
    s.lineTo(back, -hw);
    s.closePath();
    shapes.push(s);
  }
  return new THREE.ShapeGeometry(shapes);
}

const VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
varying vec2 vP;
void main() {
  float along = clamp(vP.x, 0.0, 1.0);
  float pulse = exp(-pow((fract(uTime * 0.8) * 1.6 - 0.3 - along) * 4.5, 2.0));
  float ramp = 0.35 + 0.65 * along;
  vec3 col = mix(uColor, vec3(1.0), pulse * 0.45) * (1.0 + pulse * 0.6);
  gl_FragColor = vec4(col, uOpacity * ramp * (0.75 + 0.25 * pulse));
  #include <colorspace_fragment>
}`;

export class HeadingArrow {
  readonly mesh: THREE.Mesh<THREE.ShapeGeometry, THREE.ShaderMaterial>;

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 0.84, 0.3) }, uTime: { value: 0 }, uOpacity: { value: 0.82 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    mat.forceSinglePass = true;
    this.mesh = new THREE.Mesh(chevronGeometry(), mat);
    this.mesh.name = 'heading-arrow';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** `orientation` = drone attitude (only its yaw is used); hides itself when `visible` is false. */
  update(position: THREE.Vector3, orientation: THREE.Quaternion, eye: THREE.Vector3, visible: boolean, time = 0): void {
    this.mesh.visible = visible;
    if (!visible) return;
    this.mesh.material.uniforms.uTime.value = time;
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
    _m.setPosition(position.x + _f.x * 0.1, position.y, position.z + _f.z * 0.1);
    this.mesh.matrix.copy(_m);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
