/**
 * FPV air streaks: thin additive lines in view space on a cylinder around the flight direction,
 * streaming past the lens as the quad flies. Positions are a pure function of distance travelled,
 * so there is no per-frame CPU work beyond a few uniforms. One draw call; off on the low tier.
 */
import * as THREE from 'three';
import { mulberry32 } from '../textures';

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 aSeed; // angle, radius, phase, length factor
uniform vec3 uAxis;      // view-space direction of travel (unit)
uniform float uTravel;   // metres flown (scrolls the streaks)
uniform float uSpan;
uniform float uNear;
uniform float uLength;
uniform float uIntensity;
varying float vAlpha;
varying vec2 vCorner;
void main() {
  vec3 axis = uAxis;
  vec3 ref = abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 b1 = normalize(cross(axis, ref));
  vec3 b2 = cross(axis, b1);
  float f = fract(aSeed.z - uTravel / uSpan);
  float depth = uNear + f * uSpan;
  vec3 c = axis * depth + (b1 * cos(aSeed.x) + b2 * sin(aSeed.x)) * aSeed.y;
  float len = uLength * aSeed.w;
  vec3 toEye = normalize(-c);
  vec3 side = normalize(cross(axis, toEye));
  float w = 0.003 * (0.6 + depth * 0.1);
  vec3 p = c + axis * corner.y * len + side * corner.x * w;
  vCorner = corner;
  // fade in from the far end, out as they rush past, and keep the centre of the image clear
  vec4 cc = projectionMatrix * vec4(c, 1.0);
  float off = cc.w > 0.0 ? length(cc.xy / cc.w) : 0.0;
  vAlpha = uIntensity * smoothstep(1.0, 0.7, f) * smoothstep(0.0, 0.15, f) * smoothstep(0.4, 0.85, off);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
varying float vAlpha;
varying vec2 vCorner;
void main() {
  float a = (1.0 - abs(vCorner.x)) * (1.0 - abs(vCorner.y)) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(0.75, 0.86, 1.0) * a, a);
  #include <colorspace_fragment>
}`;

const _axis = new THREE.Vector3();

export class SpeedLines {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private travel = 0;
  private intensity = 0;

  constructor(readonly capacity: number, seed = 9) {
    const rnd = mulberry32(seed);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      seeds[i * 4] = rnd() * Math.PI * 2;
      seeds[i * 4 + 1] = 0.7 + Math.pow(rnd(), 0.7) * 2.8;
      seeds[i * 4 + 2] = rnd();
      seeds[i * 4 + 3] = 0.5 + rnd();
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uAxis: { value: new THREE.Vector3(0, 0, -1) },
        uTravel: { value: 0 },
        uSpan: { value: 16 },
        uNear: { value: 0.6 },
        uLength: { value: 0.5 },
        uIntensity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
    });
    mat.forceSinglePass = true;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vfx-speed-lines';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
  }

  /** Number of streaks drawn (tier budget, ≤ capacity). */
  setCount(n: number): void {
    this.mesh.geometry.instanceCount = Math.max(0, Math.min(this.capacity, Math.floor(n)));
  }

  /**
   * `velocity` world m/s, `camera` = the FPV camera, `weight` 0..1 (FPV blend × enable).
   * Streaks appear from ~9 m/s and saturate at ~24 m/s.
   */
  update(dt: number, velocity: THREE.Vector3, camera: THREE.Camera, weight: number): void {
    const speed = velocity.length();
    const target = this.mesh.geometry.instanceCount > 0 ? weight * THREE.MathUtils.smoothstep(speed, 9, 24) : 0;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 6);
    this.mesh.visible = this.intensity > 0.01;
    if (!this.mesh.visible) return;
    this.travel = (this.travel + speed * dt) % 1e4;
    _axis.copy(velocity).transformDirection(camera.matrixWorldInverse);
    // a zero axis would put NaNs into the frame (and through bloom, black out the screen)
    if (_axis.lengthSq() < 1e-6) _axis.set(0, 0, -1);
    const u = this.mesh.material.uniforms;
    u.uAxis.value.copy(_axis);
    u.uTravel.value = this.travel;
    u.uLength.value = 0.12 + speed * 0.022;
    u.uIntensity.value = this.intensity * 0.32;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
