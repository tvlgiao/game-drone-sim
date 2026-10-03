/**
 * Night Loft details that move (docs/12): the "OPEN" neon stutters now and then (the "FPV" sign only hums), one
 * tired Edison bulb dips and flickers (its light and its halo together), and a Wi-Fi router on the coffee table
 * blinks its LEDs. The ceiling fan and the dust in the light shafts were already alive.
 */
import * as THREE from 'three';
import type { QualityTier } from '../../types';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import { AnimLayer } from './ambient';
import { LIFE_PART, routerModel } from './life-models';

/** GLSL: neon level 0..1 at time t — on, with stuttering bursts a few times a minute */
const NEON_FLICKER = /* glsl */ `
float lifeNeon( float t ) {
  float burst = step( 0.86, sin( t * 0.31 ) * 0.6 + sin( t * 0.137 + 1.1 ) * 0.5 );
  float stutter = step( 0.35, fract( sin( floor( t * 18.0 ) * 12.9898 ) * 43758.5453 ) );
  return mix( 1.0, 0.08 + 0.92 * stutter, burst );
}`;

/** CPU twin of NEON_FLICKER (tests, the neon's practical light). */
export function neonLevel(t: number): number {
  const burst = Math.sin(t * 0.31) * 0.6 + Math.sin(t * 0.137 + 1.1) * 0.5 >= 0.86 ? 1 : 0;
  const h = Math.sin(Math.floor(t * 18) * 12.9898) * 43758.5453;
  const stutter = h - Math.floor(h) >= 0.35 ? 1 : 0;
  return 1 + (0.08 + 0.92 * stutter - 1) * burst;
}

/** The tired bulb: mostly steady, then a few seconds of dips and buzz. */
export function bulbLevel(t: number): number {
  const bad = Math.sin(t * 0.23 + 0.7) > 0.7 ? 1 : 0;
  const n = Math.sin(t * 31.0) * Math.sin(t * 17.3 + 1.0);
  const drop = Math.sin(Math.floor(t * 9) * 78.233) * 43758.5453;
  const d = drop - Math.floor(drop) < 0.18 ? 0.25 : 1;
  return bad ? Math.max(0.15, d * (0.85 + 0.15 * n)) : 0.97 + 0.03 * Math.sin(t * 3.1);
}

/** Router LEDs: power steady, WAN / Wi-Fi blinking with traffic, a slow-breathing status LED. */
const ROUTER_COLOR = /* glsl */ `
if ( floor( vPart + 0.5 ) == ${LIFE_PART.lamp.toFixed(1)} ) {
  float i = floor( vWeight * 4.0 + 0.5 );
  float on = i < 0.5 ? 1.0
    : i < 1.5 ? step( 0.4, fract( sin( floor( uTime * 7.0 ) * 91.7 ) * 4375.85 ) )
    : i < 2.5 ? step( 0.55, fract( sin( floor( uTime * 11.0 + 3.0 ) * 47.3 ) * 2715.1 ) )
    : i < 3.5 ? 0.5 + 0.5 * sin( uTime * 1.6 )
    : step( 0.5, fract( uTime * 0.5 ) );
  vec3 c = i < 0.5 ? vec3( 0.2, 1.0, 0.3 ) : i < 3.5 ? vec3( 0.25, 0.9, 1.0 ) : vec3( 1.0, 0.6, 0.1 );
  diffuseColor.rgb = c * 0.1;
  totalEmissiveRadiance += c * 3.0 * on;
}`;

export interface LoftLifeHooks {
  /** the shared neon material (vertex colour per sign) */
  neon: THREE.Material;
  /** the tired bulb's practical light, and its base intensity read each frame */
  bulbLight: THREE.PointLight | null;
  /** the halos' instanced mesh and the tired bulb's instance */
  halos: THREE.InstancedMesh | null;
  haloIndex: number;
}

export class LoftLife {
  readonly group = new THREE.Group();
  private readonly router: AnimLayer;
  private readonly neonT = { value: 0 };
  private readonly hooks: LoftLifeHooks;
  private readonly haloBase = new THREE.Color();
  private readonly tmp = new THREE.Color();
  private readonly clock: InstanceUniforms = { uTime: { value: 0 } };
  /** last levels applied (tests) */
  neon = 1;
  bulb = 1;

  constructor(hooks: LoftLifeHooks) {
    this.group.name = 'loft-life';
    this.hooks = hooks;
    // neon: the "OPEN" sign (cyan: green and blue over 2) stutters, the rest hums
    const neon = hooks.neon as THREE.MeshBasicMaterial;
    const t = this.neonT;
    neon.onBeforeCompile = (s) => {
      s.uniforms.uNeonT = t;
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uNeonT;\n${NEON_FLICKER}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
#if defined( USE_COLOR )
  float isOpen = step( 2.0, vColor.g ) * step( 2.0, vColor.b );
  diffuseColor.rgb *= mix( 0.97 + 0.03 * sin( uNeonT * 377.0 ), lifeNeon( uNeonT ), isOpen );
#endif`,
        );
    };
    neon.customProgramCacheKey = () => 'loft-neon-life';
    neon.needsUpdate = true;
    if (hooks.halos && hooks.haloIndex >= 0) hooks.halos.getColorAt(hooks.haloIndex, this.haloBase);
    // the router on the coffee table beside the transmitter, its LEDs towards the sofa
    this.router = new AnimLayer(routerModel(), { key: 'router', fragment: ROUTER_COLOR, roughness: 0.5 }, this.clock, false);
    this.router.layer.begin();
    this.router.layer.push(3.6, 0.42, 5.07, 0, 1, 1, 1, 0);
    this.router.layer.end();
    this.group.add(this.router.mesh);
  }

  setQuality(_tier: QualityTier): void {}

  update(time: number): void {
    this.clock.uTime.value = time;
    this.neonT.value = time;
    this.neon = neonLevel(time);
    const k = bulbLevel(time);
    this.bulb = k;
    const h = this.hooks;
    if (h.bulbLight) h.bulbLight.intensity *= k;
    if (h.halos && h.haloIndex >= 0) {
      h.halos.setColorAt(h.haloIndex, this.tmp.copy(this.haloBase).multiplyScalar(k * k));
      h.halos.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.router.dispose();
    this.group.clear();
  }
}
