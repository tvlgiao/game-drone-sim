/**
 * Physically based daytime sky: three's Preetham scattering model with its analytic clouds, scaled
 * into the scene's light units and closed below the horizon with the lit ground colour. The same
 * shader feeds the visible dome and the PMREM environment, so reflections match the sky you see.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { SkyDef } from '../../types';

/**
 * Preetham radiance → scene units. The sun lights a white Lambert surface at E / π; a clear sky is
 * ~1/8 of that at the zenith, which this factor reproduces for a 7-unit sun at ~35° elevation.
 */
const SKY_SCALE = 0.35;
/** caps the sun disc (linear): enough to bloom, not enough to ring the whole frame */
const SUN_DISC_MAX = 60;

export interface SkyLook {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  cloudCoverage: number;
  cloudDensity: number;
  cloudElevation: number;
  /** cloud feature frequency: larger = smaller clouds */
  cloudScale: number;
}

export const DEFAULT_SKY_LOOK: Readonly<SkyLook> = {
  turbidity: 3.2,
  rayleigh: 1.0,
  mieCoefficient: 0.0022,
  mieDirectionalG: 0.82,
  cloudCoverage: 0.3,
  cloudDensity: 0.55,
  cloudElevation: 0.45,
  cloudScale: 0.00038,
};

function patch(src: string, find: string, replace: string): string {
  if (!src.includes(find)) throw new Error(`sky shader patch point missing: ${find.slice(0, 40)}`);
  return src.replace(find, replace);
}

interface ShaderSource {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Sky.SkyShader with a radiance scale, a sun-disc cap and a ground below the horizon (exported for tests). */
export function physicalSkyShader(): ShaderSource {
  // typed as `object` in @types/three
  const base = Sky.SkyShader as ShaderSource;
  let frag = patch(base.fragmentShader, 'uniform float time;', 'uniform float time;\nuniform float skyScale;\nuniform float sunDiscMax;\nuniform vec3 skyGround;');
  frag = patch(
    frag,
    'gl_FragColor = vec4( texColor, 1.0 );',
    `texColor = min( texColor * skyScale, vec3( sunDiscMax ) );
			// below the horizon: the lit ground fading in through a thin band of haze
			texColor = mix( texColor, skyGround, smoothstep( 0.0, -0.05, direction.y ) );
			gl_FragColor = vec4( texColor, 1.0 );`,
  );
  return {
    uniforms: THREE.UniformsUtils.merge([
      base.uniforms,
      { skyScale: { value: SKY_SCALE }, sunDiscMax: { value: SUN_DISC_MAX }, skyGround: { value: new THREE.Color() } },
    ]),
    vertexShader: base.vertexShader,
    fragmentShader: frag,
  };
}

/** Linear radiance of a Lambert ground of `albedo` under the level's sun and sky. */
function groundRadiance(sky: SkyDef, albedo: THREE.ColorRepresentation, out: THREE.Color): THREE.Color {
  const sun = new THREE.Vector3(...sky.sunDir).normalize();
  const irradiance = sky.sunIntensity * Math.max(0, sun.y) + sky.sunIntensity * 0.18;
  return out.set(albedo).multiplyScalar(irradiance / Math.PI);
}

export class SkyDome {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(sky: SkyDef, ground: THREE.ColorRepresentation, radius = 800, clouds = 1, look: Readonly<SkyLook> = DEFAULT_SKY_LOOK) {
    const g = new THREE.SphereGeometry(radius, 32, 16);
    const shader = physicalSkyShader();
    const m = new THREE.ShaderMaterial({ ...shader, side: THREE.BackSide, depthWrite: false, fog: false });
    const u = m.uniforms;
    u.turbidity!.value = look.turbidity;
    u.rayleigh!.value = look.rayleigh;
    u.mieCoefficient!.value = look.mieCoefficient;
    u.mieDirectionalG!.value = look.mieDirectionalG;
    u.cloudCoverage!.value = look.cloudCoverage * clouds;
    u.cloudDensity!.value = look.cloudDensity;
    u.cloudElevation!.value = look.cloudElevation;
    u.cloudScale!.value = look.cloudScale;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.setSky(sky, ground);
  }

  /** New sun position (time of day): the scattering, the sun disc and the lit ground below the horizon follow. */
  setSky(sky: SkyDef, ground: THREE.ColorRepresentation): void {
    const u = this.mesh.material.uniforms;
    // Preetham wants the sun far away: 450 000 is the horizon fade length its vertex shader assumes
    (u.sunPosition!.value as THREE.Vector3).set(...sky.sunDir).normalize().multiplyScalar(450_000);
    groundRadiance(sky, ground, u.skyGround!.value as THREE.Color);
  }

  /** The dome rides with the camera: it is infinitely far away. */
  follow(camera: THREE.Vector3): void {
    this.mesh.position.copy(camera);
  }

  /** drifts the clouds */
  update(time: number): void {
    this.mesh.material.uniforms.time!.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Image-based light from the sky over a ground of `ground` albedo (no scene geometry). GameView
 * replaces it with a capture of the whole level on tiers with environment maps; this is the cheap
 * stand-in the level view is built with.
 */
export function skyEnvironment(renderer: THREE.WebGLRenderer, sky: SkyDef, ground: THREE.ColorRepresentation): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const dome = new SkyDome(sky, ground, 50, 0.6);
  // the sun disc is the light's job: in the env map it only adds fireflies to rough surfaces
  dome.mesh.material.uniforms.sunDiscMax!.value = 8;
  env.add(dome.mesh);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.02, 0.1, 100);
  pmrem.dispose();
  dome.dispose();
  return target;
}
