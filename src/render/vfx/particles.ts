/**
 * GPU particle pool: one interleaved buffer, ring-buffer allocation, motion solved in the vertex
 * shader (drag + gravity + floor clamp). Emission writes only the touched range; no per-frame allocs.
 */
import * as THREE from 'three';

const STRIDE = 16; // p0(3) v0(3) color(3) t0 life size gravity drag kind seed

export type ParticleKind = 0 | 1 | 2; // 0 spark/glow, 1 solid debris, 2 soft puff

const VERT = /* glsl */ `
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec4 aLife;   // t0, life, size, gravity
attribute vec3 aExtra;  // drag, kind, seed
uniform float uTime;
uniform float uPx;
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
#include <common>
#include <fog_pars_vertex>
void main() {
  float age = uTime - aLife.x;
  float life = aLife.y;
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  float k = max(aExtra.x, 0.001);
  float e = exp(-k * age);
  vec3 p = position + aVel * (1.0 - e) / k;
  float g = -9.81 * aLife.w;
  p.y += g * (age / k - (1.0 - e) / (k * k));
  p.y = max(p.y, 0.012);
  float t = age / life;
  float kind = aExtra.y;
  float size = aLife.z;
  if (kind > 1.5) { size *= 0.6 + t * 1.8; vAlpha = (1.0 - t) * (1.0 - t) * min(1.0, age * 10.0); }
  else if (kind > 0.5) { vAlpha = 1.0 - smoothstep(0.7, 1.0, t); }
  else { size *= (1.0 - t * 0.7); vAlpha = pow(1.0 - t, 1.5); }
  vColor = aColor;
  vKind = kind;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vAlpha *= smoothstep(0.12, 0.6, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(size * uPx / max(0.05, -mvPosition.z), 0.0, kind > 0.5 && kind < 1.5 ? 18.0 : (kind > 1.5 ? 64.0 : 32.0));
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float a;
  vec3 col = vColor;
  if (vKind > 1.5) { a = (1.0 - d * d) * (1.0 - d * d) * 0.4; }
  else if (vKind > 0.5) { a = 1.0 - smoothstep(0.75, 1.0, d); col *= 0.7 + 0.3 * (1.0 - d); }
  else { float core = exp(-d * d * 6.0); a = core; col = mix(col, vec3(1.0), core * 0.3) * 2.2; }
  gl_FragColor = vec4(col, a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class ParticlePool {
  readonly points: THREE.Points;
  private readonly data: Float32Array;
  private readonly buffer: THREE.InterleavedBuffer;
  private readonly material: THREE.ShaderMaterial;
  private head = 0;
  private dirtyStart = -1;
  private dirtyEnd = -1;
  private wrapped = false;
  private time = 0;

  constructor(readonly capacity: number, additive: boolean) {
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 9] = -1e6; // dead
    this.buffer = new THREE.InterleavedBuffer(this.data, STRIDE);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    g.setAttribute('aVel', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(this.buffer, 3, 6));
    g.setAttribute('aLife', new THREE.InterleavedBufferAttribute(this.buffer, 4, 9));
    g.setAttribute('aExtra', new THREE.InterleavedBufferAttribute(this.buffer, 3, 13));
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uPx: { value: 800 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  /** Emit one particle. Positions/velocities in world space, m and m/s. */
  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, life: number, size: number, gravity: number, drag: number, kind: ParticleKind, delay = 0): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = px;
    d[o + 1] = py;
    d[o + 2] = pz;
    d[o + 3] = vx;
    d[o + 4] = vy;
    d[o + 5] = vz;
    d[o + 6] = r;
    d[o + 7] = g;
    d[o + 8] = b;
    d[o + 9] = this.time + delay;
    d[o + 10] = life;
    d[o + 11] = size;
    d[o + 12] = gravity;
    d[o + 13] = drag;
    d[o + 14] = kind;
    d[o + 15] = Math.random();
    if (this.dirtyStart < 0) {
      this.dirtyStart = i;
      this.dirtyEnd = i;
    } else {
      this.dirtyEnd = i;
    }
  }

  /** Advance clock and upload the dirty range. `px` = pixels per metre at 1 m (viewport scale). */
  update(time: number, px: number): void {
    this.time = time;
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPx.value = px;
    if (this.dirtyStart >= 0) {
      this.buffer.clearUpdateRanges();
      if (this.wrapped || this.dirtyEnd < this.dirtyStart) {
        this.buffer.addUpdateRange(0, this.capacity * STRIDE);
      } else {
        this.buffer.addUpdateRange(this.dirtyStart * STRIDE, (this.dirtyEnd - this.dirtyStart + 1) * STRIDE);
      }
      this.buffer.needsUpdate = true;
      this.dirtyStart = -1;
      this.dirtyEnd = -1;
      this.wrapped = false;
    }
  }

  get now(): number {
    return this.time;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
