/** Daytime sky: gradient dome with sun disc and soft analytic clouds (no textures), plus its PMREM environment. */
import * as THREE from 'three';
import type { SkyDef } from '../../types';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // pin the dome to the far plane so it never clips nearer geometry
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uClouds;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
  // a brighter band just above the horizon, warmer towards the sun
  // guarded: at the zenith the horizontal direction is zero, and one NaN pixel spreads over the whole frame through bloom
  vec2 across = d.xz / max(length(d.xz), 1e-4);
  float sunFacing = max(dot(across, normalize(uSunDir.xz)), 0.0);
  col += uSunColor * 0.12 * pow(1.0 - clamp(h, 0.0, 1.0), 6.0) * (0.4 + 0.6 * sunFacing);
  col = mix(col, uGround, smoothstep(0.0, -0.08, h));
  float cosSun = dot(d, uSunDir);
  col += uSunColor * (pow(max(cosSun, 0.0), 220.0) * 0.9 + pow(max(cosSun, 0.0), 12.0) * 0.18);
  col += uSunColor * smoothstep(0.9993, 0.9997, cosSun) * 6.0;
  if (h > 0.0 && uClouds > 0.0) {
    vec2 uv = d.xz / (h + 0.12) * 1.6;
    float c = smoothstep(0.52, 0.78, fbm(uv + vec2(3.1, 0.0)));
    float lit = 0.85 + 0.15 * sunFacing;
    col = mix(col, vec3(1.0, 0.98, 0.95) * lit, c * uClouds * smoothstep(0.0, 0.25, h));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SkyDome {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(sky: SkyDef, ground: THREE.ColorRepresentation, radius = 800, clouds = 0.55) {
    const g = new THREE.SphereGeometry(radius, 48, 24);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(sky.top) },
        uHorizon: { value: new THREE.Color(sky.horizon) },
        uGround: { value: new THREE.Color(ground) },
        uSunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() },
        uSunColor: { value: new THREE.Color(sky.sunColor) },
        uClouds: { value: clouds },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  /** The dome rides with the camera: it is infinitely far away. */
  follow(camera: THREE.Vector3): void {
    this.mesh.position.copy(camera);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Image-based light from the sky over a meadow-coloured ground, for reflections on the quad. */
export function skyEnvironment(renderer: THREE.WebGLRenderer, sky: SkyDef, ground: THREE.ColorRepresentation): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const dome = new SkyDome(sky, ground, 50, 0);
  env.add(dome.mesh);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.04, 0.1, 100);
  pmrem.dispose();
  dome.dispose();
  return target;
}
