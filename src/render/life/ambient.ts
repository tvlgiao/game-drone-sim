/**
 * Building blocks of the ambient life (docs/12): an instanced animated layer (one draw, the motion in the vertex
 * shader), the shader snippets that move each model (turbine rotors, grazing heads, flags, AC fans, blinking
 * beacons) and the soft smoke / steam puffs (one draw for every chimney and vent of the level, animated entirely
 * on the GPU: each puff's age is a function of the clock and its phase).
 */
import * as THREE from 'three';
import { InstanceLayer } from '../outdoor/scatter-view';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import { animatedMaterials, type AnimatedMaterialOptions } from './anim-material';
import { LIFE_PART, TURBINE_HUB } from './life-models';

/** One instanced draw of an animated model. */
export class AnimLayer {
  readonly layer: InstanceLayer;
  private readonly owned: { dispose(): void }[];

  constructor(model: THREE.BufferGeometry, o: AnimatedMaterialOptions, shared: InstanceUniforms, castShadow: boolean) {
    const m = animatedMaterials(o, shared);
    this.layer = new InstanceLayer(model, m.material, castShadow ? m.depth : null, o.key);
    this.layer.mesh.castShadow = castShadow;
    this.owned = [model, m.material, m.depth, this.layer];
  }

  get mesh(): THREE.Mesh {
    return this.layer.mesh;
  }

  get count(): number {
    return this.layer.mesh.visible ? this.layer.count : 0;
  }

  dispose(): void {
    this.layer.mesh.removeFromParent();
    for (const d of this.owned) d.dispose();
  }
}

/** Turbine rotor: spins about the hub's +Z axis (≈ 16 rpm), each turbine at its own angle. */
export const TURBINE_PRE = /* glsl */ `
if ( uv.x == ${LIFE_PART.rotor.toFixed(1)} ) {
  float a = uTime * 1.65 + lifeSeed * 6.2831;
  float c = cos( a );
  float s = sin( a );
  vec2 q = p.xy - vec2( 0.0, ${TURBINE_HUB.toFixed(1)} );
  p.xy = vec2( c * q.x - s * q.y, s * q.x + c * q.y ) + vec2( 0.0, ${TURBINE_HUB.toFixed(1)} );
  n.xy = vec2( c * n.x - s * n.y, s * n.x + c * n.y );
}`;

/**
 * Grazing: the head and neck pitch down to the grass about the shoulders for most of the time and come up now and
 * then (per animal timing), the tail swishes. Instance tint: 0 brown cow, 1 black-and-white cow, 2 sheep.
 */
export const ANIMAL_PRE = /* glsl */ `
vWorldLife = position;
if ( uv.x == ${LIFE_PART.head.toFixed(1)} ) {
  float graze = smoothstep( -0.35, 0.35, sin( uTime * 0.21 + lifeSeed * 40.0 ) + 0.35 * sin( uTime * 0.53 + lifeSeed * 13.0 ) );
  float chew = sin( uTime * 5.0 + lifeSeed * 9.0 ) * 0.04 * graze;
  float a = ( 0.95 * graze + chew ) * uv.y + ( 1.0 - graze ) * 0.12 * sin( uTime * 0.9 + lifeSeed * 5.0 );
  float c = cos( a );
  float s = sin( a );
  vec2 q = p.yz - vec2( 1.12, 0.72 );
  p.yz = vec2( c * q.x - s * q.y, s * q.x + c * q.y ) + vec2( 1.12, 0.72 );
}
if ( p.z < -0.7 && p.y < 1.15 ) p.x += sin( uTime * 2.3 + lifeSeed * 17.0 ) * 0.12 * ( 1.15 - p.y );`;

export const ANIMAL_COLOR = /* glsl */ `
float breed = floor( vTint + 0.5 );
vec3 coat = breed < 0.5 ? vec3( 0.36, 0.2, 0.11 ) : breed < 1.5 ? vec3( 0.86, 0.85, 0.82 ) : vec3( 0.82, 0.8, 0.74 );
// black patches on the black-and-white cows (a cheap 3D blotch)
if ( breed > 0.5 && breed < 1.5 ) {
  float blot = sin( vWorldLife.x * 3.1 + vWorldLife.z * 1.7 ) * sin( vWorldLife.y * 4.3 - vWorldLife.z * 2.9 ) + sin( vWorldLife.x * 1.3 - vWorldLife.y * 2.2 );
  coat = mix( coat, vec3( 0.03, 0.03, 0.03 ), step( 0.45, blot ) );
}
diffuseColor.rgb *= coat;`;

/** Flags: the cloth ripples away from the pole (uv.y = 0 at the pole … 1 at the fly), faster in gusts. */
export const FLAG_PRE = /* glsl */ `
vWorldLife = position;
if ( uv.x == ${LIFE_PART.cloth.toFixed(1)} ) {
  float k = uv.y;
  float w = uTime * 6.5 - k * 5.5 + lifeSeed * 20.0;
  p.z += sin( w ) * 0.22 * k + sin( w * 1.7 + 1.3 ) * 0.06 * k;
  p.y += sin( w * 0.8 ) * 0.05 * k - 0.06 * k * k;
  p.x -= ( 1.0 - cos( sin( w ) * 0.3 ) ) * k * 0.6;
  n = normalize( vec3( 0.0, 0.0, 1.0 ) + vec3( -cos( w ) * 0.6 * k, 0.0, 0.0 ) );
}`;

/** Flag colours by instance tint: three horizontal stripes from a small palette. */
export const FLAG_COLOR = /* glsl */ `
if ( floor( vPart + 0.5 ) == ${LIFE_PART.cloth.toFixed(1)} ) {
  float f = floor( vTint + 0.5 );
  float band = floor( clamp( ( vWorldLife.y - 5.8 ) / 1.1, 0.0, 0.999 ) * 3.0 );
  vec3 a = f < 0.5 ? vec3( 0.75, 0.05, 0.06 ) : f < 1.5 ? vec3( 0.02, 0.2, 0.55 ) : f < 2.5 ? vec3( 0.05, 0.45, 0.2 ) : vec3( 0.95, 0.75, 0.1 );
  vec3 b = vec3( 0.92, 0.92, 0.9 );
  diffuseColor.rgb = band == 1.0 ? b : a;
}`;

/** AC fan blades turn fast about +Y. */
export const FAN_PRE = /* glsl */ `
if ( uv.x == ${LIFE_PART.rotor.toFixed(1)} ) {
  float a = uTime * ( 9.0 + 4.0 * lifeSeed ) + lifeSeed * 6.2831;
  float c = cos( a );
  float s = sin( a );
  p.xz = vec2( c * p.x - s * p.z, s * p.x + c * p.z );
}`;

/** Aircraft obstruction lights: a 1 s red flash every 1.5 s, all synchronised (as real ones are). */
export const BEACON_COLOR = /* glsl */ `
if ( floor( vPart + 0.5 ) == ${LIFE_PART.beacon.toFixed(1)} ) {
  float on = step( fract( uTime / 1.5 ), 0.45 );
  diffuseColor.rgb = vec3( 0.3, 0.02, 0.02 );
  totalEmissiveRadiance += vec3( 4.0, 0.1, 0.05 ) * ( 0.08 + on );
}`;

/** Varying of the model-space position for colour patterns (`vWorldLife`, set in the vertex shader). */
export const LIFE_LOCAL_PARS_V = 'varying vec3 vWorldLife;';
export const LIFE_LOCAL_PARS_F = 'varying vec3 vWorldLife;';
export const LIFE_LOCAL_SET = 'vWorldLife = position;';

// ---------------------------------------------------------------- smoke / steam puffs

const PUFF_VERT = /* glsl */ `
attribute vec4 aInst;   // source x, y, z (origin-relative), phase 0..1
attribute vec4 aInstB;  // kind (0 smoke, 1 steam), rise (m), size (m), period (s)
uniform float uTime;
uniform vec2 uWindDir;
varying vec2 vQ;
varying float vAlpha;
varying float vKind;
varying float vFogDepth;
void main() {
  float age = fract( uTime / aInstB.w + aInst.w );
  float seed = fract( aInst.w * 7.13 + aInst.x * 0.13 );
  vec3 c = aInst.xyz;
  // rise slowing down, drift downwind faster as it climbs, a little curl
  c.y += aInstB.y * ( 1.0 - ( 1.0 - age ) * ( 1.0 - age ) );
  c.xz += uWindDir * age * age * aInstB.y * 1.1;
  c.x += sin( age * 5.0 + seed * 20.0 ) * 0.5 * age;
  c.z += cos( age * 4.0 + seed * 13.0 ) * 0.5 * age;
  float size = aInstB.z * ( 0.35 + 1.4 * age );
  vec4 mv = modelViewMatrix * vec4( c, 1.0 );
  float r = seed * 6.2831 + age * 1.3;
  vec2 q = vec2( cos( r ) * position.x - sin( r ) * position.y, sin( r ) * position.x + cos( r ) * position.y );
  mv.xy += q * size;
  vQ = position.xy * 2.0;
  vAlpha = smoothstep( 0.0, 0.12, age ) * ( 1.0 - age ) * ( 1.0 - age );
  vKind = aInstB.x;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PUFF_FRAG = /* glsl */ `
uniform vec3 uSmoke;
uniform vec3 uSteam;
uniform float uFogDensity;
uniform vec3 uFogColor;
varying vec2 vQ;
varying float vAlpha;
varying float vKind;
varying float vFogDepth;
void main() {
  float d = dot( vQ, vQ );
  // a soft lumpy disc
  float lump = 0.85 + 0.15 * sin( vQ.x * 5.0 + vQ.y * 3.0 ) * sin( vQ.y * 4.0 - vQ.x * 2.0 );
  float a = exp( -d * 3.2 ) * lump * vAlpha * ( vKind > 0.5 ? 0.55 : 0.42 );
  if ( a < 0.004 ) discard;
  vec3 col = vKind > 0.5 ? uSteam : uSmoke;
  float fog = 1.0 - exp( -uFogDensity * uFogDensity * vFogDepth * vFogDepth );
  gl_FragColor = vec4( mix( col, uFogColor, fog ), a * ( 1.0 - fog * 0.7 ) );
  #include <colorspace_fragment>
}`;

export const PUFF_KIND = { smoke: 0, steam: 1 } as const;

/** Smoke from chimneys and steam from rooftop vents: `perSource` puffs per source, one draw. */
export class PuffLayer {
  readonly layer: InstanceLayer;
  readonly uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uSmoke: { value: new THREE.Color(0.32, 0.3, 0.29) },
    uSteam: { value: new THREE.Color(0.8, 0.8, 0.82) },
    uFogDensity: { value: 0 },
    uFogColor: { value: new THREE.Color() },
  };
  private readonly owned: { dispose(): void }[];
  /** most puffs drawn (tier budget) */
  budget = Infinity;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.layer = new InstanceLayer(g, m, null, 'puffs');
    this.layer.mesh.castShadow = false;
    this.layer.mesh.receiveShadow = false;
    this.layer.mesh.renderOrder = 5;
    this.owned = [g, m, this.layer];
  }

  /** Rebuilds the puffs from sources (x, y, z, kind) relative to the origin; nearest `budget` sources first is the caller's job. */
  set(sources: ArrayLike<number>, n: number, ox: number, oz: number, perSource = 6): void {
    const L = this.layer;
    L.begin();
    let made = 0;
    for (let k = 0; k < n && made + perSource <= this.budget; k++) {
      const x = sources[k * 4]! - ox;
      const y = sources[k * 4 + 1]!;
      const z = sources[k * 4 + 2]! - oz;
      const kind = sources[k * 4 + 3]!;
      const seed = Math.abs(Math.sin(x * 12.9898 + z * 78.233)) % 1;
      for (let i = 0; i < perSource; i++) {
        const steam = kind === PUFF_KIND.steam;
        L.push(x, y, z, (i / perSource + seed) % 1, kind, steam ? 5 : 9, steam ? 1.6 : 2.2, steam ? 4.5 : 9);
        made++;
      }
    }
    L.end();
  }

  get count(): number {
    return this.layer.mesh.visible ? this.layer.count : 0;
  }

  dispose(): void {
    this.layer.mesh.removeFromParent();
    for (const d of this.owned) d.dispose();
  }
}
