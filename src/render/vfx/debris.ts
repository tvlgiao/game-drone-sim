/**
 * Crash debris: lit, tumbling shards (carbon flakes, prop chips, hot solder bits) as one instanced
 * draw. Flight is solved in the vertex shader: ballistic arc, one damped bounce, then a skid that
 * settles; spin decays after the bounce; pieces shrink away at end of life. Ring-buffer slots,
 * fixed buffers, no per-frame allocation.
 */
import * as THREE from 'three';

const STRIDE = 20; // p0(3) v0(3) axis(3) spin t0 life floorY glow scale(3) color(3)

const VERT_PARS = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aAxis;   // axis xyz, spin rad/s
attribute vec4 aLife;   // t0, life, floor y, glow
attribute vec3 aScale;
attribute vec3 aTint;
uniform float uTime;
varying vec3 vTint;
varying float vGlow;
vec3 rotAxis(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
`;

const VERT_SOLVE = /* glsl */ `
  float age = uTime - aLife.x;
  bool alive = age >= 0.0 && age <= aLife.y;
  float g = 9.81;
  float dy = aP0.y - aLife.z;
  float tHit = (aV0.y + sqrt(max(0.0, aV0.y * aV0.y + 2.0 * g * dy))) / g;
  vec3 dP;
  float ang;
  if (age < tHit) {
    dP = aV0 * age;
    dP.y -= 0.5 * g * age * age;
    ang = aAxis.w * age;
  } else {
    vec3 hp = aV0 * tHit;
    hp.y = aLife.z - aP0.y;
    float t = age - tHit;
    float vyb = -(aV0.y - g * tHit) * 0.3;
    float skid = (1.0 - exp(-4.0 * t)) / 4.0;
    dP = hp + vec3(aV0.x, 0.0, aV0.z) * 0.45 * skid;
    dP.y += max(0.0, vyb * t - 0.5 * g * t * t);
    ang = aAxis.w * (tHit + skid * 0.6);
  }
  float shrink = alive ? 1.0 - smoothstep(0.8, 1.0, age / aLife.y) : 0.0;
  vec3 dbAxis = normalize(aAxis.xyz);
  vTint = aTint;
  vGlow = aLife.w * (1.0 - smoothstep(0.0, 0.6, age));
`;

export class Debris {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  private readonly data: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly uniforms = { uTime: { value: 0 } };
  private head = 0;
  private dirtyStart = -1;
  private dirtyEnd = -1;
  private wrapped = false;
  private time = 0;
  /** last moment any piece is alive: the draw is skipped after it */
  private until = -1;
  /** total pieces emitted (budget tests) */
  emitted = 0;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 10] = -1e6;
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    // an irregular flat pentagonal shard; per-instance non-uniform scale makes flakes, chips and chunks
    const s = new THREE.Shape();
    s.moveTo(-0.5, -0.4);
    s.lineTo(0.45, -0.5);
    s.lineTo(0.55, 0.15);
    s.lineTo(0.05, 0.5);
    s.lineTo(-0.45, 0.25);
    s.closePath();
    const shard = new THREE.ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: false });
    shard.translate(0, 0, -0.15);
    const g = new THREE.InstancedBufferGeometry();
    g.index = shard.index;
    g.setAttribute('position', shard.attributes.position);
    g.setAttribute('normal', shard.attributes.normal);
    g.setAttribute('aP0', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    g.setAttribute('aV0', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    g.setAttribute('aAxis', new THREE.InterleavedBufferAttribute(this.buffer, 4, 6));
    g.setAttribute('aLife', new THREE.InterleavedBufferAttribute(this.buffer, 4, 10));
    g.setAttribute('aScale', new THREE.InterleavedBufferAttribute(this.buffer, 3, 14));
    g.setAttribute('aTint', new THREE.InterleavedBufferAttribute(this.buffer, 3, 17));
    g.instanceCount = capacity;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <beginnormal_vertex>', `${VERT_SOLVE}\nvec3 objectNormal = rotAxis(normal, dbAxis, ang);\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif`)
        .replace('#include <begin_vertex>', 'vec3 transformed = aP0 + dP + rotAxis(position * aScale * shrink, dbAxis, ang);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\nvarying float vGlow;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTint;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.45, 0.12) * vGlow * 6.0;');
    };
    mat.customProgramCacheKey = () => 'vfx-debris';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vfx-debris';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Emit one piece. `scale` = shard size (m) per axis; `glow` 0..1 makes it a hot, self-lit bit. */
  emit(px: number, py: number, pz: number, vx: number, vy: number, vz: number, ax: number, ay: number, az: number, spin: number, life: number, floorY: number, sx: number, sy: number, sz: number, r: number, gr: number, b: number, glow = 0): void {
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
    d[k + 6] = ax;
    d[k + 7] = ay;
    d[k + 8] = az;
    d[k + 9] = spin;
    d[k + 10] = this.time;
    d[k + 11] = life;
    d[k + 12] = floorY;
    d[k + 13] = glow;
    d[k + 14] = sx;
    d[k + 15] = sy;
    d[k + 16] = sz;
    d[k + 17] = r;
    d[k + 18] = gr;
    d[k + 19] = b;
    this.until = Math.max(this.until, this.time + life);
    if (this.dirtyStart < 0) this.dirtyStart = i;
    this.dirtyEnd = i;
    this.emitted++;
  }

  update(time: number): void {
    this.time = time;
    this.uniforms.uTime.value = time;
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

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
