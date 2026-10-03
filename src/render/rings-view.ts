/**
 * Race gates, AA style: a dark machined housing with hazard striping on the outside, an inner LED
 * channel of segmented emissive bars (chasing on the next gate), glowing light-pipe edges, an
 * inner-glow membrane that ripples on a pass, and a number tag that fades with distance.
 * State colours: next = cyan pulse, the one after = magenta, passed = green flash then dim.
 */
import * as THREE from 'three';
import type { RingDef } from '../types';
import { labelTexture } from './textures';

const CYAN = new THREE.Color(0.1, 0.9, 1.0);
const MAGENTA = new THREE.Color(1.0, 0.17, 0.84);
const GREEN = new THREE.Color(0.24, 1.0, 0.48);

/** label fades out beyond FAR × gate scale, and when the camera is right on it */
const LABEL_FAR = 26;
const LABEL_NEAR = 1.1;

const RIM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
varying vec3 vWN;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vWN = normalize(mat3(modelMatrix) * normal);
  vView = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RIM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uPulse;
uniform float uFlash;
uniform float uSegments;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
varying vec3 vWN;
#include <common>
#include <fog_pars_fragment>
void main() {
  // vUv.x runs around the ring, vUv.y around the tube (0.5 = inner face, 0 / 1 = outer face)
  float tube = abs(vUv.y - 0.5) * 2.0;
  float inner = 1.0 - smoothstep(0.22, 0.3, tube);
  float edge = exp(-pow((tube - 0.48) * 26.0, 2.0));
  float seg = fract(vUv.x * uSegments - uTime * 2.2 * uPulse);
  float bar = smoothstep(0.04, 0.1, seg) * (1.0 - smoothstep(0.78, 0.86, seg));
  // chasing highlight on the next gate
  float chase = uPulse * pow(0.5 + 0.5 * sin(vUv.x * 6.2831 * 3.0 - uTime * 5.0), 8.0);
  float hazard = step(0.5, fract((vUv.x * uSegments * 0.5) + vUv.y * 2.0));
  float fres = pow(1.0 - abs(dot(vN, vView)), 3.0);
  // housing: dark anodised metal lit by a soft key from above + rim light, faint hazard stripes
  float key = 0.35 + 0.65 * max(0.0, vWN.y);
  vec3 housing = vec3(0.045, 0.05, 0.06) * key + vec3(0.12, 0.13, 0.15) * fres;
  housing += uColor * hazard * (1.0 - inner) * 0.05 * uIntensity;
  float pulse = 1.0 + uPulse * (0.25 * sin(uTime * 6.0) + 0.15);
  vec3 led = uColor * (bar * 1.4 + 0.18) * pulse + mix(uColor, vec3(1.0), 0.5) * chase * 1.6;
  vec3 col = housing + led * inner * uIntensity * 1.15 + uColor * edge * uIntensity;
  col += mix(uColor, vec3(1.0), 0.45) * uFlash * (inner * 1.3 + 0.25);
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
  rim: THREE.Mesh<THREE.TorusGeometry, THREE.ShaderMaterial>;
  membrane: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  label: THREE.Sprite;
  labelScale: number;
  base: THREE.Color;
  color: THREE.Color;
  intensity: number;
  memIntensity: number;
  flash: number;
  /** 0..1 green pass flash timer */
  passT: number;
  /** pass ripple progress, -1 idle */
  ripple: number;
}

const _target = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1);
const _p = new THREE.Vector3();

export class RingsView {
  readonly group = new THREE.Group();
  private readonly rings: RingVisual[] = [];
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly textures: THREE.Texture[] = [];

  constructor(defs: readonly RingDef[]) {
    this.group.name = 'rings';
    const fogUniforms = THREE.UniformsLib.fog;
    defs.forEach((def, i) => {
      const key = `${def.radius}|${def.tube}`;
      let torus = this.geometries.get(`t${key}`) as THREE.TorusGeometry | undefined;
      if (!torus) {
        torus = new THREE.TorusGeometry(def.radius + def.tube, def.tube, 18, 96);
        this.geometries.set(`t${key}`, torus);
      }
      let disc = this.geometries.get(`d${key}`) as THREE.CircleGeometry | undefined;
      if (!disc) {
        disc = new THREE.CircleGeometry(def.radius + def.tube * 0.5, 64);
        this.geometries.set(`d${key}`, disc);
      }
      const base = (i % 2 === 0 ? CYAN : MAGENTA).clone();
      // LED bars about every 12 cm of circumference, whatever the gate size
      const segments = Math.max(24, Math.round((2 * Math.PI * (def.radius + def.tube)) / 0.12 / 2) * 2);
      const rimMat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          fogUniforms,
          { uColor: { value: base.clone() }, uIntensity: { value: 1 }, uTime: { value: 0 }, uPulse: { value: 0 }, uFlash: { value: 0 }, uSegments: { value: segments } },
        ]),
        vertexShader: RIM_VERT,
        fragmentShader: RIM_FRAG,
        fog: true,
      });
      const rim = new THREE.Mesh(torus, rimMat);
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
      const holder = new THREE.Group();
      holder.position.set(def.position[0], def.position[1], def.position[2]);
      holder.quaternion.setFromUnitVectors(_z, new THREE.Vector3(...def.direction).normalize());
      holder.add(rim, membrane);
      rim.castShadow = true;
      const tex = labelTexture(String(i + 1));
      this.textures.push(tex);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, color: base.clone(), fog: true }));
      // big outdoor gates are read from 20–30 m: the number grows with the gate (loft rings: 0.75 m)
      const labelScale = 0.34 * Math.max(1, def.radius / 0.75);
      label.scale.setScalar(labelScale);
      label.position.set(def.position[0], def.position[1] + def.radius + def.tube + 0.3, def.position[2]);
      this.group.add(holder, label);
      this.rings.push({ def, rim, membrane, label, labelScale, base, color: base.clone(), intensity: 1, memIntensity: 0, flash: 0, passT: 0, ripple: -1 });
    });
  }

  get count(): number {
    return this.rings.length;
  }

  ringPosition(i: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.rings[i]?.def.position;
    return p ? out.set(p[0], p[1], p[2]) : out.set(0, 0, 0);
  }

  ringColor(i: number): THREE.Color {
    return this.rings[i]?.base ?? CYAN;
  }

  /** Trigger the green pass flash and the membrane ripple on ring i. */
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
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      let intensity: number;
      let mem: number;
      let pulse = 0;
      let labelAlpha: number;
      if (free) {
        _target.copy(r.base);
        intensity = 0.8;
        mem = 0.15;
        labelAlpha = 0.7;
      } else if (i < nextRing) {
        _target.copy(GREEN);
        intensity = 0.12 + r.passT * 1.3;
        mem = r.passT * 0.6;
        labelAlpha = 0.1 + r.passT * 0.8;
      } else if (i === nextRing) {
        _target.copy(CYAN);
        intensity = 1;
        mem = 0.85;
        pulse = 1;
        labelAlpha = 1;
      } else if (i === nextRing + 1) {
        _target.copy(MAGENTA);
        intensity = 0.55;
        mem = 0.25;
        labelAlpha = 0.65;
      } else {
        _target.copy(r.base);
        intensity = 0.18;
        mem = 0.04;
        labelAlpha = 0.3;
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
      const u = r.rim.material.uniforms;
      u.uColor.value.copy(r.color);
      u.uIntensity.value = r.intensity;
      u.uTime.value = time + i * 0.37;
      u.uPulse.value = pulse;
      u.uFlash.value = r.flash;
      const mu = r.membrane.material.uniforms;
      mu.uColor.value.copy(r.color);
      mu.uIntensity.value = r.memIntensity * (pulse > 0 ? 0.8 + 0.2 * Math.sin(time * 6) : 1);
      mu.uTime.value = time;
      mu.uRipple.value = r.ripple;
      r.membrane.visible = r.memIntensity > 0.01 || r.ripple >= 0;
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
      r.label.visible = lm.opacity > 0.01;
      r.label.scale.setScalar(r.labelScale * (pulse > 0 ? 1.12 + 0.05 * Math.sin(time * 4) : 1));
    }
  }

  dispose(): void {
    for (const r of this.rings) {
      r.rim.material.dispose();
      r.membrane.material.dispose();
      r.label.material.dispose();
    }
    for (const g of this.geometries.values()) g.dispose();
    for (const t of this.textures) t.dispose();
  }
}
