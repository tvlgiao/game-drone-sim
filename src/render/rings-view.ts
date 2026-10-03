/**
 * Race gates, AA style: a dark machined housing with hazard striping on the outside, an inner LED
 * channel of segmented emissive bars (chasing on the next gate), glowing light-pipe edges, an
 * inner-glow membrane that ripples on a pass, and a number tag that fades with distance.
 *
 * State colours are picked to read against every backdrop we have (night loft, green treeline, blue sky):
 * next = electric cyan with a white-hot chase, the one after = hot magenta, later ones = dim violet,
 * passed = amber (a white flash on the pass). Outdoors the LED channel runs at `gain` × so it stays the
 * brightest thing in a sunlit frame.
 *
 * Draw cost: the housings of all gates of one size are ONE instanced mesh (per-instance colour / state
 * attributes), membranes and tags show only where they carry information; the low tier (and VR) uses a
 * coarser torus and tags for the next two gates only.
 */
import * as THREE from 'three';
import type { QualityTier, RingDef } from '../types';
import { labelTexture } from './textures';

/** next gate */
export const NEXT_COLOR = new THREE.Color(0.0, 0.92, 1.0);
/** the gate after the next */
const UPCOMING = new THREE.Color(1.0, 0.1, 0.78);
/** gates further down the course */
const LATER = new THREE.Color(0.52, 0.3, 1.0);
/** gates already flown */
const PASSED = new THREE.Color(1.0, 0.56, 0.06);

/** label fades out beyond FAR × gate scale, and when the camera is right on it */
const LABEL_FAR = 26;
const LABEL_NEAR = 1.1;

const RIM_VERT = /* glsl */ `
attribute vec3 aColor;
/** x intensity, y pulse, z flash, w time offset */
attribute vec4 aState;
attribute float aSegments;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
varying vec3 vWN;
varying vec3 vColor;
varying vec4 vState;
varying float vSegments;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vColor = aColor;
  vState = aState;
  vSegments = aSegments;
  mat4 model = modelMatrix * instanceMatrix;
  vec4 mvPosition = viewMatrix * model * vec4(position, 1.0);
  vWN = normalize(mat3(model) * normal);
  vN = normalize(mat3(viewMatrix) * vWN);
  vView = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RIM_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGain;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
varying vec3 vWN;
varying vec3 vColor;
varying vec4 vState;
varying float vSegments;
#include <common>
#include <fog_pars_fragment>
void main() {
  float intensity = vState.x;
  float pulseOn = vState.y;
  float flash = vState.z;
  float t = uTime + vState.w;
  // vUv.x runs around the ring, vUv.y around the tube (0.5 = inner face, 0 / 1 = outer face)
  float tube = abs(vUv.y - 0.5) * 2.0;
  float inner = 1.0 - smoothstep(0.22, 0.3, tube);
  float edge = exp(-pow((tube - 0.48) * 26.0, 2.0));
  float seg = fract(vUv.x * vSegments - t * 2.2 * pulseOn);
  float bar = smoothstep(0.04, 0.1, seg) * (1.0 - smoothstep(0.78, 0.86, seg));
  // chasing white-hot highlight on the next gate
  float chase = pulseOn * pow(0.5 + 0.5 * sin(vUv.x * 6.2831 * 3.0 - t * 5.0), 8.0);
  float hazard = step(0.5, fract((vUv.x * vSegments * 0.5) + vUv.y * 2.0));
  float fres = pow(1.0 - abs(dot(vN, vView)), 3.0);
  // housing: dark anodised metal lit by a soft key from above + rim light, faint hazard stripes; it frames
  // the LEDs against bright skies, and its stripes pick up the state colour so it reads against trees
  float key = 0.35 + 0.65 * max(0.0, vWN.y);
  vec3 housing = vec3(0.045, 0.05, 0.06) * key + vec3(0.12, 0.13, 0.15) * fres;
  housing += vColor * hazard * (1.0 - inner) * 0.08 * intensity;
  float pulse = 1.0 + pulseOn * (0.25 * sin(t * 6.0) + 0.15);
  vec3 led = vColor * (bar * 1.4 + 0.22) * pulse + mix(vColor, vec3(1.0), 0.6) * chase * 1.8;
  vec3 col = housing + (led * inner * 1.15 + vColor * edge) * intensity * uGain;
  col += mix(vColor, vec3(1.0), 0.6) * flash * (inner * 1.3 + 0.25) * uGain;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const MEMBRANE_VERT = /* glsl */ `
varying vec2 vP;
varying float vDepth;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const MEMBRANE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uRadius;
uniform float uRipple;
varying vec2 vP;
varying float vDepth;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r = length(vP) / uRadius;
  if (r > 1.0) discard;
  float a = atan(vP.y, vP.x);
  // inner glow hugging the rim, faint drifting caustics, a ring wave on a pass
  float glow = pow(smoothstep(0.45, 1.0, r), 2.6);
  float drift = pow(0.5 + 0.5 * sin(r * 18.0 - uTime * 2.4 + sin(a * 5.0 + uTime) * 0.8), 8.0) * smoothstep(0.2, 0.9, r);
  float wave = uRipple > 0.0 ? exp(-pow((r - uRipple * 1.25) * 9.0, 2.0)) * (1.0 - uRipple) : 0.0;
  float alpha = (glow * 0.7 + drift * 0.06) * uIntensity + wave * 0.6;
  // thins out as the camera flies through, so it never washes over the whole view
  alpha *= (1.0 - smoothstep(0.985, 1.0, r)) * smoothstep(0.6, 2.6, vDepth);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), wave * 0.5) * 0.9, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

interface RingVisual {
  def: RingDef;
  /** instanced housing this gate lives in, and its slot */
  batch: RimBatch;
  slot: number;
  membrane: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  label: THREE.Sprite;
  labelScale: number;
  base: THREE.Color;
  color: THREE.Color;
  intensity: number;
  memIntensity: number;
  flash: number;
  /** 0..1 pass flash timer */
  passT: number;
  /** pass ripple progress, -1 idle */
  ripple: number;
}

interface RimBatch {
  key: string;
  radius: number;
  tube: number;
  mesh: THREE.InstancedMesh<THREE.TorusGeometry, THREE.ShaderMaterial>;
  color: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
  segments: THREE.InstancedBufferAttribute;
}

const _target = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();

/** torus tessellation (tube × around) per tier class */
const DETAIL = { full: [18, 96], low: [10, 48] } as const;

export class RingsView {
  readonly group = new THREE.Group();
  private readonly rings: RingVisual[] = [];
  private readonly batches: RimBatch[] = [];
  private readonly discs = new Map<string, THREE.CircleGeometry>();
  private readonly textures: THREE.Texture[] = [];
  private readonly rimMat: THREE.ShaderMaterial;
  private low = false;
  private gain = 1;

  constructor(defs: readonly RingDef[]) {
    this.group.name = 'rings';
    const fogUniforms = THREE.UniformsLib.fog;
    this.rimMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([fogUniforms, { uTime: { value: 0 }, uGain: { value: 1 } }]),
      vertexShader: RIM_VERT,
      fragmentShader: RIM_FRAG,
      fog: true,
    });
    const byKey = new Map<string, RingDef[]>();
    for (const d of defs) {
      const key = `${d.radius}|${d.tube}`;
      byKey.set(key, [...(byKey.get(key) ?? []), d]);
    }
    for (const [key, list] of byKey) this.batches.push(this.makeBatch(key, list[0]!.radius, list[0]!.tube, list.length, DETAIL.full));

    const slots = new Map<string, number>();
    defs.forEach((def, i) => {
      const key = `${def.radius}|${def.tube}`;
      const batch = this.batches.find((b) => b.key === key)!;
      const slot = slots.get(key) ?? 0;
      slots.set(key, slot + 1);
      _q.setFromUnitVectors(_z, new THREE.Vector3(...def.direction).normalize());
      batch.mesh.setMatrixAt(slot, _m.compose(new THREE.Vector3(...def.position), _q, _s));
      // LED bars about every 12 cm of circumference, whatever the gate size
      batch.segments.setX(slot, Math.max(24, Math.round((2 * Math.PI * (def.radius + def.tube)) / 0.12 / 2) * 2));

      let disc = this.discs.get(key);
      if (!disc) {
        disc = new THREE.CircleGeometry(def.radius + def.tube * 0.5, 64);
        this.discs.set(key, disc);
      }
      const base = (i % 2 === 0 ? NEXT_COLOR : UPCOMING).clone();
      const memMat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          fogUniforms,
          { uColor: { value: base.clone() }, uIntensity: { value: 0 }, uTime: { value: 0 }, uRadius: { value: def.radius + def.tube * 0.5 }, uRipple: { value: -1 } },
        ]),
        vertexShader: MEMBRANE_VERT,
        fragmentShader: MEMBRANE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: true,
      });
      memMat.forceSinglePass = true;
      const membrane = new THREE.Mesh(disc, memMat);
      membrane.renderOrder = 1;
      membrane.position.set(def.position[0], def.position[1], def.position[2]);
      membrane.quaternion.copy(_q);
      membrane.visible = false;
      const tex = labelTexture(String(i + 1));
      this.textures.push(tex);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, color: base.clone(), fog: true }));
      // big outdoor gates are read from 20–30 m: the number grows with the gate (loft rings: 0.75 m)
      const labelScale = 0.34 * Math.max(1, def.radius / 0.75);
      label.scale.setScalar(labelScale);
      label.position.set(def.position[0], def.position[1] + def.radius + def.tube + 0.3, def.position[2]);
      this.group.add(membrane, label);
      this.rings.push({ def, batch, slot, membrane, label, labelScale, base, color: base.clone(), intensity: 1, memIntensity: 0, flash: 0, passT: 0, ripple: -1 });
    });
    for (const b of this.batches) {
      b.mesh.instanceMatrix.needsUpdate = true;
      b.mesh.computeBoundingSphere();
    }
  }

  private makeBatch(key: string, radius: number, tube: number, count: number, detail: readonly [number, number]): RimBatch {
    const geo = new THREE.TorusGeometry(radius + tube, tube, detail[0], detail[1]);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const state = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    const segments = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    for (const a of [color, state]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', color);
    geo.setAttribute('aState', state);
    geo.setAttribute('aSegments', segments);
    const mesh = new THREE.InstancedMesh(geo, this.rimMat, count);
    mesh.name = 'ring-housings';
    mesh.castShadow = true;
    this.group.add(mesh);
    return { key, radius, tube, mesh, color, state, segments };
  }

  get count(): number {
    return this.rings.length;
  }

  /** draws this view issues per eye (housings + visible membranes + visible tags), for budgets / tests */
  get drawables(): number {
    let n = this.batches.length;
    for (const r of this.rings) n += (r.membrane.visible ? 1 : 0) + (r.label.visible ? 1 : 0);
    return n;
  }

  /**
   * Tier: low / VR takes the coarse housing (~2.6 k instead of ~7 k triangles a gate) and keeps tags on the
   * next two gates only. `gain` scales the LED channel (outdoor daylight needs ~2×).
   */
  setQuality(tier: QualityTier, gain = this.gain): void {
    this.gain = gain;
    this.rimMat.uniforms.uGain!.value = gain;
    const low = tier === 'low';
    if (low === this.low) return;
    this.low = low;
    for (const b of this.batches) {
      const [ts, rs] = low ? DETAIL.low : DETAIL.full;
      const g = new THREE.TorusGeometry(b.radius + b.tube, b.tube, ts, rs);
      g.setAttribute('aColor', b.color);
      g.setAttribute('aState', b.state);
      g.setAttribute('aSegments', b.segments);
      b.mesh.geometry.dispose();
      b.mesh.geometry = g;
    }
  }

  ringPosition(i: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.rings[i]?.def.position;
    return p ? out.set(p[0], p[1], p[2]) : out.set(0, 0, 0);
  }

  /** colour gate i is showing right now (the pass VFX take it on) */
  ringColor(i: number): THREE.Color {
    return this.rings[i]?.color ?? NEXT_COLOR;
  }

  /** Trigger the pass flash and the membrane ripple on ring i. */
  passed(i: number): void {
    const r = this.rings[i];
    if (r) {
      r.passT = 1;
      r.flash = 1;
      r.ripple = 0;
    }
  }

  /** `eye` (camera position) fades the number tags with distance; omit to keep them fully visible. */
  update(time: number, dt: number, nextRing: number, eye?: THREE.Vector3): void {
    const k = Math.min(1, dt * 5);
    const free = nextRing < 0;
    this.rimMat.uniforms.uTime!.value = time;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i]!;
      let intensity: number;
      let mem: number;
      let pulse = 0;
      let labelAlpha: number;
      let tag = !this.low;
      if (free) {
        _target.copy(r.base);
        intensity = 0.85;
        mem = this.low ? 0 : 0.15;
        labelAlpha = 0.7;
      } else if (i < nextRing) {
        _target.copy(PASSED);
        intensity = 0.42 + r.passT * 1.2;
        mem = r.passT * 0.6;
        labelAlpha = 0.25 + r.passT * 0.7;
      } else if (i === nextRing) {
        _target.copy(NEXT_COLOR);
        intensity = 1.25;
        mem = 0.85;
        pulse = 1;
        labelAlpha = 1;
        tag = true;
      } else if (i === nextRing + 1) {
        _target.copy(UPCOMING);
        intensity = 0.8;
        mem = this.low ? 0 : 0.25;
        labelAlpha = 0.75;
        tag = true;
      } else {
        _target.copy(LATER);
        intensity = 0.4;
        mem = 0;
        labelAlpha = 0.35;
      }
      r.passT = Math.max(0, r.passT - dt / 1.4);
      r.flash = Math.max(0, r.flash - dt * 4.5);
      if (r.ripple >= 0) {
        r.ripple += dt / 0.7;
        if (r.ripple >= 1) r.ripple = -1;
      }
      r.color.lerp(_target, k);
      r.intensity += (intensity - r.intensity) * k;
      r.memIntensity += (mem - r.memIntensity) * k;
      const b = r.batch;
      b.color.setXYZ(r.slot, r.color.r, r.color.g, r.color.b);
      b.state.setXYZW(r.slot, r.intensity, pulse, r.flash, i * 0.37);
      const mu = r.membrane.material.uniforms;
      mu.uColor!.value.copy(r.color);
      mu.uIntensity!.value = r.memIntensity * (pulse > 0 ? 0.8 + 0.2 * Math.sin(time * 6) : 1);
      mu.uTime!.value = time;
      mu.uRipple!.value = r.ripple;
      r.membrane.visible = r.memIntensity > 0.02 || r.ripple >= 0;
      const lm = r.label.material;
      lm.color.copy(r.color);
      const ly = r.def.position[1] + r.def.radius + r.def.tube + 0.3 + Math.sin(time * 1.6 + i) * 0.04;
      r.label.position.y = ly;
      let fade = 1;
      if (eye) {
        _p.set(r.def.position[0], ly, r.def.position[2]);
        const d = eye.distanceTo(_p);
        const gate = Math.max(1, r.def.radius / 0.75);
        fade = (1 - THREE.MathUtils.smoothstep(d, LABEL_FAR * gate * 0.6, LABEL_FAR * gate)) * THREE.MathUtils.smoothstep(d, LABEL_NEAR * 0.5, LABEL_NEAR);
      }
      lm.opacity = labelAlpha * fade;
      r.label.visible = tag && lm.opacity > 0.01;
      r.label.scale.setScalar(r.labelScale * (pulse > 0 ? 1.12 + 0.05 * Math.sin(time * 4) : 1));
    }
    for (const b of this.batches) {
      b.color.needsUpdate = true;
      b.state.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const r of this.rings) {
      r.membrane.material.dispose();
      r.label.material.dispose();
    }
    for (const b of this.batches) b.mesh.geometry.dispose();
    this.rimMat.dispose();
    for (const g of this.discs.values()) g.dispose();
    for (const t of this.textures) t.dispose();
  }
}
