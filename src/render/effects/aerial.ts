/**
 * Height fog / aerial perspective in linear HDR (before bloom and tone mapping). Fog density falls off
 * exponentially with altitude and is integrated analytically along each view ray, so low ground haze
 * thickens towards the horizon while the drone a few metres up stays crisp. A forward-scattering lobe
 * warms the haze towards the sun. The sky (depth = far plane) is left alone: it already has its haze.
 */
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

export interface AerialSettings {
  /** haze colour (linear) away from the sun */
  color: number;
  /** extra in-scatter towards the sun (linear, added to color) */
  sunColor: number;
  /** extinction per metre at the base height */
  density: number;
  /** density halves every ln2 / falloff metres of altitude */
  falloff: number;
  /** world y of the densest layer */
  base: number;
  /** cap on fog opacity so far geometry keeps a silhouette */
  maxOpacity: number;
}

const FRAG = /* glsl */ `
uniform mat4 aerialProjInv;
uniform mat4 aerialCamWorld;
uniform vec3 aerialColor;
uniform vec3 aerialSun;
uniform vec3 aerialSunDir;
uniform vec4 aerialParams; // density, falloff, base, maxOpacity

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (depth >= 0.99999) {
    outputColor = inputColor;
    return;
  }
  vec4 view = aerialProjInv * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
  view /= view.w;
  vec3 world = (aerialCamWorld * vec4(view.xyz, 1.0)).xyz;
  vec3 eye = aerialCamWorld[3].xyz;
  vec3 ray = world - eye;
  float dist = length(ray);
  float k = aerialParams.y;
  float dy = ray.y;
  // integral of density * exp(-k (h - base)) along the ray, h going from eye.y to world.y
  float layer = exp(-k * max(eye.y - aerialParams.z, 0.0));
  float kdy = k * dy;
  float spread = abs(kdy) > 1e-3 ? (1.0 - exp(-kdy)) / kdy : 1.0 - 0.5 * kdy;
  float optical = aerialParams.x * layer * dist * spread;
  float t = min(1.0 - exp(-optical), aerialParams.w);
  float mu = max(dot(ray / max(dist, 1e-4), aerialSunDir), 0.0);
  vec3 haze = aerialColor + aerialSun * (mu * mu * mu * mu * mu * mu * mu * mu);
  outputColor = vec4(mix(inputColor.rgb, haze, t), inputColor.a);
}
`;

export class AerialPerspectiveEffect extends Effect {
  constructor(private readonly camera: THREE.PerspectiveCamera) {
    super('AerialPerspectiveEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['aerialProjInv', new THREE.Uniform(new THREE.Matrix4())],
        ['aerialCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['aerialColor', new THREE.Uniform(new THREE.Color())],
        ['aerialSun', new THREE.Uniform(new THREE.Color())],
        ['aerialSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['aerialParams', new THREE.Uniform(new THREE.Vector4(0, 0.1, 0, 0))],
      ]),
    });
  }

  configure(s: Readonly<AerialSettings>, sunDir: THREE.Vector3): void {
    const u = this.uniforms;
    (u.get('aerialColor')!.value as THREE.Color).set(s.color);
    (u.get('aerialSun')!.value as THREE.Color).set(s.sunColor);
    (u.get('aerialSunDir')!.value as THREE.Vector3).copy(sunDir).normalize();
    (u.get('aerialParams')!.value as THREE.Vector4).set(s.density, Math.max(1e-4, s.falloff), s.base, s.maxOpacity);
  }

  override update(): void {
    (this.uniforms.get('aerialProjInv')!.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    (this.uniforms.get('aerialCamWorld')!.value as THREE.Matrix4).copy(this.camera.matrixWorld);
  }
}
