/**
 * Prop-wash ground decal: a ring of dust ripples racing outward under a low-hovering quad, broken
 * up by polar noise so it reads as blown dust rather than a target. Grows with height, fades with
 * throttle and distance to the ground. One small quad, one draw call, hidden when idle.
 */
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vP;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = position.xz * 2.0;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColor;
varying vec2 vP;
#include <common>
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  // ripples move outward; noise on the unit circle (no atan seam) tears them into gusts
  vec2 dir = vP / max(r, 1e-4);
  float n = vnoise(dir * 2.2 + vec2(0.0, r * 3.0 - uTime * 1.7)) * 0.6 + vnoise(dir * 5.0 + vec2(3.0, r * 7.0 - uTime * 3.1)) * 0.4;
  float rings = pow(0.5 + 0.5 * sin(r * 26.0 - uTime * 11.0 + n * 3.0), 3.0);
  float band = smoothstep(0.08, 0.32, r) * (1.0 - smoothstep(0.62, 1.0, r));
  float alpha = uIntensity * band * (0.3 + 0.7 * rings) * smoothstep(0.3, 0.8, n) * 0.2;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class PropWashDecal {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  enabled = true;
  private intensity = 0;

  constructor() {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uIntensity: { value: 0 }, uColor: { value: new THREE.Color(0.5, 0.47, 0.42) } }]),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vfx-prop-wash';
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  /** `strength` 0..1 (throttle × ground proximity); `height` above the surface at `surfaceY`. */
  update(dt: number, time: number, x: number, z: number, surfaceY: number, height: number, strength: number): void {
    const target = this.enabled ? strength : 0;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 5);
    this.mesh.visible = this.intensity > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.set(x, surfaceY + 0.005, z);
    this.mesh.scale.setScalar(0.5 + height * 1.4);
    const u = this.mesh.material.uniforms;
    u.uTime.value = time;
    u.uIntensity.value = this.intensity;
  }

  /** Dust colour of the surface (light concrete indoors, sandy/green-grey outdoors). */
  setColor(c: THREE.ColorRepresentation): void {
    this.mesh.material.uniforms.uColor.value.set(c);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
