/**
 * Drone contact shadow + LED ground glow (green ahead, red behind, like the quad's own LEDs),
 * projected on the floor or the prop top below.
 * Near the ground the shadow is the quad's own silhouette (a signed-distance texture of the X frame,
 * battery and spinning prop discs, turned with the yaw) whose penumbra widens with height; a soft
 * ambient blob takes over as the quad climbs.
 */
import * as THREE from 'three';
import type { SurfaceProvider } from '../../game/surfaces';
import { MOTOR_LAYOUT } from '../../physics/drone-params';

const FRONT_GLOW = new THREE.Color(0.1, 1, 0.32);
const REAR_GLOW = new THREE.Color(1, 0.12, 0.08);
/** metres covered by the silhouette texture (prop tip to prop tip ≈ 0.17 m) */
const SIL_SIZE = 0.26;
/** signed distance range encoded in the texture (± metres) */
const SDF_RANGE = 0.03;

function sdBox(px: number, pz: number, cx: number, cz: number, hx: number, hz: number, r: number): number {
  const dx = Math.abs(px - cx) - hx + r;
  const dz = Math.abs(pz - cz) - hz + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0) - r;
}

function sdSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number, r: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - ax - vx * t, pz - az - vz * t) - r;
}

/** R: frame silhouette, G: prop discs; both signed distances (m) mapped to 0..1. */
export function silhouetteTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * SIL_SIZE;
      // plane v runs toward −z (forward) after the floor rotation
      const z = -((j + 0.5) / size - 0.5) * SIL_SIZE;
      let d = sdBox(x, z, 0, 0.004, 0.0175, 0.032, 0.006);
      d = Math.min(d, sdBox(x, z, 0, -0.034, 0.0105, 0.015, 0.003));
      let dp = 1;
      for (const m of MOTOR_LAYOUT) {
        const mx = m.position[0];
        const mz = m.position[2];
        d = Math.min(d, sdSegment(x, z, 0, 0, mx, mz, 0.005), Math.hypot(x - mx, z - mz) - 0.0098);
        dp = Math.min(dp, Math.hypot(x - mx, z - mz) - 0.038);
      }
      const k = (j * size + i) * 4;
      data[k] = Math.round(THREE.MathUtils.clamp(d / (2 * SDF_RANGE) + 0.5, 0, 1) * 255);
      data[k + 1] = Math.round(THREE.MathUtils.clamp(dp / (2 * SDF_RANGE) + 0.5, 0, 1) * 255);
      data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const SIL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SIL_FRAG = /* glsl */ `
uniform sampler2D uSdf;
uniform float uSoft;
uniform float uOpacity;
uniform float uProps;
varying vec2 vUv;
void main() {
  vec2 s = texture2D(uSdf, vUv).rg;
  float d = (s.r - 0.5) * ${(2 * SDF_RANGE).toFixed(3)};
  float dp = (s.g - 0.5) * ${(2 * SDF_RANGE).toFixed(3)};
  float frame = 1.0 - smoothstep(-uSoft, uSoft, d);
  float props = (1.0 - smoothstep(-uSoft, uSoft, dp)) * uProps;
  float a = max(frame, props) * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uFront;
uniform vec3 uRear;
uniform vec3 uTint;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float d = length(p) * 2.0;
  if (d > 1.0) discard;
  // the arm LEDs spill their own colour: green ahead of the quad, red behind, blended in the middle
  vec3 side = mix(uRear, uFront, smoothstep(-0.18, 0.18, p.y));
  float fall = pow(1.0 - d, 2.2);
  gl_FragColor = vec4(mix(side, uTint, 0.3) * fall * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;

export class ContactShadow {
  readonly group = new THREE.Group();
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly silhouette: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly sdf: THREE.DataTexture;
  /** walkable surfaces of the current level (GameView swaps them with the level) */
  surfaces: SurfaceProvider;
  /** height of the drone above the surface under it (m), updated each frame */
  height = 10;
  surfaceY = 0;

  constructor(surfaces: SurfaceProvider, radial: THREE.Texture) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0x000000, map: radial, transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.sdf = silhouetteTexture();
    this.silhouette = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { uSdf: { value: this.sdf }, uSoft: { value: 0.002 }, uOpacity: { value: 0 }, uProps: { value: 0 } },
        vertexShader: SIL_VERT,
        fragmentShader: SIL_FRAG,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2.5,
        polygonOffsetUnits: -2.5,
      }),
    );
    this.silhouette.scale.setScalar(SIL_SIZE);
    this.glow = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { uFront: { value: FRONT_GLOW.clone() }, uRear: { value: REAR_GLOW.clone() }, uTint: { value: new THREE.Color() }, uOpacity: { value: 0 } },
        vertexShader: SIL_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    this.shadow.name = 'contact-shadow';
    this.silhouette.name = 'contact-shadow-silhouette';
    this.shadow.renderOrder = 1;
    this.silhouette.renderOrder = 1;
    this.glow.renderOrder = 1;
    this.group.add(this.shadow, this.silhouette, this.glow);
    this.surfaces = surfaces;
  }

  /** `yaw` = drone heading about +Y (radians), `props` = mean motor speed 0..1 (prop-disc shadow). */
  update(pos: THREE.Vector3, ledColor: THREE.Color, ledOn: number, yaw = 0, props = 0): void {
    const y = this.surfaces.topBelow(pos.x, pos.y, pos.z);
    this.surfaceY = y;
    const h = Math.max(0, pos.y - y);
    this.height = h;
    const fade = Math.max(0, 1 - h / 2.5);
    this.shadow.visible = fade > 0.01;
    this.shadow.position.set(pos.x, y + 0.004, pos.z);
    this.shadow.scale.setScalar(0.22 + h * 0.2);
    // the blob is the ambient part: lighter while the crisp silhouette carries the contact
    const crisp = Math.max(0, 1 - h / 0.9);
    this.shadow.material.opacity = 0.6 * fade * fade * (1 - 0.45 * crisp);
    this.silhouette.visible = crisp > 0.01;
    this.silhouette.position.set(pos.x, y + 0.005, pos.z);
    this.silhouette.rotation.y = yaw;
    const u = this.silhouette.material.uniforms;
    u.uSoft.value = 0.0015 + h * 0.03;
    u.uOpacity.value = 0.62 * crisp * crisp;
    u.uProps.value = THREE.MathUtils.clamp(props * 1.4, 0, 0.35);
    const g = Math.max(0, 1 - h / 1.2) * ledOn;
    this.glow.visible = g > 0.01;
    this.glow.position.set(pos.x, y + 0.006, pos.z);
    this.glow.rotation.y = yaw;
    this.glow.scale.setScalar(0.3 + h * 0.5);
    const gu = this.glow.material.uniforms;
    gu.uTint.value.copy(ledColor);
    gu.uOpacity.value = g * 0.32;
  }

  dispose(): void {
    this.shadow.geometry.dispose();
    this.shadow.material.dispose();
    this.silhouette.material.dispose();
    this.glow.material.dispose();
    this.sdf.dispose();
  }
}
