/**
 * Velocity-stretched spark streaks: one instanced quad per spark, motion solved in the vertex
 * shader (ballistic flight, one damped bounce off the floor under the emission point), the quad
 * stretched along the screen-space velocity like a camera's motion blur. Ring-buffer allocation,
 * fixed GPU buffers, one draw call, additive HDR colour (feeds bloom).
 */
import * as THREE from 'three';

const STRIDE = 16; // p0(3) v0(3) color(3) t0 life width stretch gravity floorY bounce

const VERT = /* glsl */ `
attribute vec2 corner;
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec3 aColor;
attribute vec4 aLife;   // t0, life, width, stretch
attribute vec3 aPhys;   // gravity scale, floor y, bounce
uniform float uTime;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vCorner;
#include <common>
#include <fog_pars_vertex>
void main() {
  float age = uTime - aLife.x;
  if (age < 0.0 || age > aLife.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  float g = 9.81 * aPhys.x;
  vec3 p;
  vec3 v;
  // first floor contact (y0 - floor + vy t - g t²/2 = 0)
  float dy = aP0.y - aPhys.y;
  float tHit = g > 0.0 ? (aV0.y + sqrt(max(0.0, aV0.y * aV0.y + 2.0 * g * dy))) / g : 1e6;
  if (age < tHit) {
    p = aP0 + aV0 * age;
    p.y -= 0.5 * g * age * age;
    v = vec3(aV0.x, aV0.y - g * age, aV0.z);
  } else {
    vec3 hp = aP0 + aV0 * tHit;
    hp.y = aPhys.y;
    vec3 hv = vec3(aV0.x, -(aV0.y - g * tHit), aV0.z) * aPhys.z;
    float t = age - tHit;
    p = hp + hv * t;
    p.y = max(aPhys.y + 0.002, p.y - 0.5 * g * t * t);
    v = vec3(hv.x, hv.y - g * t, hv.z);
  }
  float t01 = age / aLife.y;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vec3 vv = (modelViewMatrix * vec4(v, 0.0)).xyz;
  // stretch: length ∝ speed (a shutter of ~1/60 s), in view space, perpendicular width toward the eye
  float speed = length(vv);
  vec3 dir = speed > 1e-4 ? vv / speed : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(dir, normalize(mvPosition.xyz)) + vec3(1e-5, 0.0, 0.0));
  float w = aLife.z * (1.0 - 0.6 * t01);
  float len = w + speed * aLife.w;
  mvPosition.xyz += dir * corner.y * len + side * corner.x * w;
  vCorner = corner;
  vColor = aColor * (0.7 + 1.5 * (1.0 - t01));
  vAlpha = (1.0 - t01 * t01) * smoothstep(0.05, 0.25, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying vec2 vCorner;
#include <common>
#include <fog_pars_fragment>
void main() {
  // hot core along the streak, soft edges, brighter head (corner.y = +1 is the leading end)
  float across = 1.0 - abs(vCorner.x);
  float along = smoothstep(-1.0, 0.6, vCorner.y) * (1.0 - smoothstep(0.85, 1.0, vCorner.y));
  float a = pow(across, 1.6) * along * vAlpha;
  if (a < 0.004) discard;
  vec3 col = mix(vColor, vec3(1.0, 0.95, 0.85) * length(vColor), pow(across, 6.0) * 0.6);
  gl_FragColor = vec4(col * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export interface SparkInit {
  /** seconds of shutter: streak length = speed × stretch */
  stretch?: number;
  gravity?: number;
  floorY?: number;
  bounce?: number;
  delay?: number;
}

export class SparkStreaks {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly data: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private head = 0;
  private dirtyStart = -1;
  private dirtyEnd = -1;
  private wrapped = false;
  private time = 0;
  /** last moment any streak is alive: the draw is skipped after it */
  private until = -1;
  /** total streaks emitted (budget tests) */
  emitted = 0;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 9] = -1e6;
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    // three needs a position attribute for the draw range; the shader ignores it
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aP0', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    g.setAttribute('aV0', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    g.setAttribute('aColor', new THREE.InterleavedBufferAttribute(this.buffer, 3, 6));
    g.setAttribute('aLife', new THREE.InterleavedBufferAttribute(this.buffer, 4, 9));
    g.setAttribute('aPhys', new THREE.InterleavedBufferAttribute(this.buffer, 3, 13));
    g.instanceCount = capacity;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
      fog: true,
    });
    mat.forceSinglePass = true;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vfx-sparks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  /** Emit one streak (world space, m and m/s). `width` in metres. */
  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, life: number, width: number, o: SparkInit = {}): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.head === 0) this.wrapped = true;
    const k = i * STRIDE;
    const d = this.data;
    d[k] = px;
    d[k + 1] = py;
    d[k + 2] = pz;
    d[k + 3] = vx;
    d[k + 4] = vy;
    d[k + 5] = vz;
    d[k + 6] = r;
    d[k + 7] = g;
    d[k + 8] = b;
    d[k + 9] = this.time + (o.delay ?? 0);
    d[k + 10] = life;
    d[k + 11] = width;
    d[k + 12] = o.stretch ?? 0.012;
    d[k + 13] = o.gravity ?? 1;
    d[k + 14] = o.floorY ?? -1e4;
    d[k + 15] = o.bounce ?? 0.35;
    this.until = Math.max(this.until, d[k + 9] + life);
    if (this.dirtyStart < 0) this.dirtyStart = i;
    this.dirtyEnd = i;
    this.emitted++;
  }

  update(time: number): void {
    this.time = time;
    this.mesh.material.uniforms.uTime.value = time;
    this.mesh.visible = time <= this.until;
    if (this.dirtyStart < 0) return;
    this.buffer.clearUpdateRanges();
    if (this.wrapped || this.dirtyEnd < this.dirtyStart) this.buffer.addUpdateRange(0, this.capacity * STRIDE);
    else this.buffer.addUpdateRange(this.dirtyStart * STRIDE, (this.dirtyEnd - this.dirtyStart + 1) * STRIDE);
    this.buffer.needsUpdate = true;
    this.dirtyStart = -1;
    this.dirtyEnd = -1;
    this.wrapped = false;
  }

  /** Streaks still alive at the current time (CPU-side count, for tests/diagnostics). */
  alive(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const t0 = this.data[i * STRIDE + 9];
      if (this.time >= t0 && this.time - t0 <= this.data[i * STRIDE + 10]) n++;
    }
    return n;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
