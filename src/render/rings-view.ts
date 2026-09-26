/** Race gates: emissive tori with scrolling chevrons, energy membrane, number labels, state colours. */
import * as THREE from 'three';
import type { RingDef } from '../types';
import { labelTexture } from './textures';

const CYAN = new THREE.Color(0.1, 0.9, 1.0);
const MAGENTA = new THREE.Color(1.0, 0.17, 0.84);
const GREEN = new THREE.Color(0.24, 1.0, 0.48);

const RIM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
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
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
#include <common>
#include <fog_pars_fragment>
void main() {
  // vUv.x runs around the ring, vUv.y around the tube
  float around = vUv.x * 36.0;
  float tube = abs(vUv.y - 0.5) * 2.0;
  float chev = fract(around + tube * 0.9 - uTime * 1.6);
  float chevron = smoothstep(0.0, 0.08, chev) * (1.0 - smoothstep(0.34, 0.46, chev));
  float fres = pow(1.0 - abs(dot(vN, vView)), 2.0);
  float core = 0.68 + 0.32 * chevron;
  float pulse = 1.0 + uPulse * (0.35 * sin(uTime * 6.0) + 0.25);
  vec3 col = uColor * (core * pulse + fres * 0.9) * uIntensity;
  col += vec3(1.0) * uFlash * 2.5;
  // dark metallic base keeps the silhouette when dim
  col += vec3(0.05, 0.06, 0.08) * (0.4 + fres);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const MEMBRANE_VERT = /* glsl */ `
varying vec2 vP;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const MEMBRANE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uRadius;
varying vec2 vP;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r = length(vP) / uRadius;
  float a = atan(vP.y, vP.x);
  float waves = pow(0.5 + 0.5 * sin(r * 22.0 + uTime * 7.0), 6.0);
  float spokes = pow(0.5 + 0.5 * sin(a * 12.0 + uTime * 1.5), 12.0) * smoothstep(0.35, 0.95, r);
  float edge = smoothstep(0.55, 1.0, r);
  float alpha = (edge * 0.55 + waves * 0.18 * r + spokes * 0.12) * uIntensity * (1.0 - smoothstep(0.98, 1.0, r));
  gl_FragColor = vec4(uColor * 1.6, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

interface RingVisual {
  def: RingDef;
  rim: THREE.Mesh<THREE.TorusGeometry, THREE.ShaderMaterial>;
  membrane: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  label: THREE.Sprite;
  base: THREE.Color;
  color: THREE.Color;
  intensity: number;
  memIntensity: number;
  flash: number;
  /** 0..1 green pass flash timer */
  passT: number;
}

const _target = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1);

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
        torus = new THREE.TorusGeometry(def.radius + def.tube, def.tube, 20, 96);
        this.geometries.set(`t${key}`, torus);
      }
      let disc = this.geometries.get(`d${key}`) as THREE.CircleGeometry | undefined;
      if (!disc) {
        disc = new THREE.CircleGeometry(def.radius + def.tube * 0.5, 64);
        this.geometries.set(`d${key}`, disc);
      }
      const base = (i % 2 === 0 ? CYAN : MAGENTA).clone();
      const rimMat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          fogUniforms,
          { uColor: { value: base.clone() }, uIntensity: { value: 1 }, uTime: { value: 0 }, uPulse: { value: 0 }, uFlash: { value: 0 } },
        ]),
        vertexShader: RIM_VERT,
        fragmentShader: RIM_FRAG,
        fog: true,
      });
      const rim = new THREE.Mesh(torus, rimMat);
      const memMat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          fogUniforms,
          { uColor: { value: base.clone() }, uIntensity: { value: 0 }, uTime: { value: 0 }, uRadius: { value: def.radius + def.tube * 0.5 } },
        ]),
        vertexShader: MEMBRANE_VERT,
        fragmentShader: MEMBRANE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: true,
      });
      const membrane = new THREE.Mesh(disc, memMat);
      membrane.renderOrder = 1;
      const holder = new THREE.Group();
      holder.position.set(def.position[0], def.position[1], def.position[2]);
      holder.quaternion.setFromUnitVectors(_z, new THREE.Vector3(...def.direction));
      holder.add(rim, membrane);
      rim.castShadow = true;
      const tex = labelTexture(String(i + 1));
      this.textures.push(tex);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, color: base.clone(), fog: true }));
      label.scale.setScalar(0.34);
      label.position.set(def.position[0], def.position[1] + def.radius + def.tube + 0.3, def.position[2]);
      this.group.add(holder, label);
      this.rings.push({ def, rim, membrane, label, base, color: base.clone(), intensity: 1, memIntensity: 0, flash: 0, passT: 0 });
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

  /** Trigger the green pass flash on ring i. */
  passed(i: number): void {
    const r = this.rings[i];
    if (r) {
      r.passT = 1;
      r.flash = 1;
    }
  }

  update(time: number, dt: number, nextRing: number): void {
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
        mem = 0.25;
        labelAlpha = 0.7;
      } else if (i < nextRing) {
        _target.copy(GREEN);
        intensity = 0.1 + r.passT * 2.4;
        mem = r.passT * 0.9;
        labelAlpha = 0.12 + r.passT * 0.8;
      } else if (i === nextRing) {
        _target.copy(CYAN);
        intensity = 1.5;
        mem = 0.75;
        pulse = 1;
        labelAlpha = 1;
      } else if (i === nextRing + 1) {
        _target.copy(MAGENTA);
        intensity = 0.5;
        mem = 0.12;
        labelAlpha = 0.65;
      } else {
        _target.copy(r.base);
        intensity = 0.14;
        mem = 0;
        labelAlpha = 0.3;
      }
      r.passT = Math.max(0, r.passT - dt / 1.4);
      r.flash = Math.max(0, r.flash - dt * 3.5);
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
      r.membrane.visible = r.memIntensity > 0.01;
      const lm = r.label.material;
      lm.color.copy(r.color);
      lm.opacity = labelAlpha;
      r.label.position.y = r.def.position[1] + r.def.radius + r.def.tube + 0.3 + Math.sin(time * 1.6 + i) * 0.04;
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
