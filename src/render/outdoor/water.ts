/**
 * Rivers, lakes and the City river on the shared lighting: a MeshStandardMaterial (so the sun's specular glint,
 * the captured environment, the SH probe, fog and the shadow cascades all apply) with
 * - gentle ripples: two scrolling samples of a tileable ripple normal map, flattened with distance (they would
 *   only alias), or one analytic ripple where the profile turns the detail off (Quest);
 * - a near-black body (water absorbs; the colour comes from what it reflects) and a Fresnel reflection of the
 *   level's captured environment; tiers without an environment map reflect an analytic sky gradient instead;
 * - shore foam along `aShore` (0..1 per vertex: shallow water and the line where the bank meets it), broken up
 *   by animated noise.
 */
import * as THREE from 'three';
import type { SkyDef } from '../../types';
import { fbmField } from '../textures';

/** world metres per ripple tile (two samples: this and RIPPLE_TILE × 0.41) */
const RIPPLE_TILE = 23;

/**
 * Tileable ripple map: RG = tangent-space normal (x, z) of a soft fbm height, B = foam breakup noise, A = 1.
 * DataTexture, so it builds in Node tests.
 */
export function rippleTexture(size = 256): THREE.DataTexture {
  const h = fbmField(size, 8, 4, 911, 0.55);
  const foam = fbmField(size, 16, 3, 913, 0.6);
  const data = new Uint8Array(size * size * 4);
  const k = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = (h[y * size + ((x + 1) % size)]! - h[y * size + ((x + size - 1) % size)]!) * k;
      const dz = (h[((y + 1) % size) * size + x]! - h[((y + size - 1) % size) * size + x]!) * k;
      const l = Math.sqrt(dx * dx + 1 + dz * dz);
      data[i * 4] = Math.round((-dx / l) * 127.5 + 127.5);
      data[i * 4 + 1] = Math.round((-dz / l) * 127.5 + 127.5);
      data[i * 4 + 2] = Math.round(foam[i]! * 255);
      data[i * 4 + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const PARS_VERTEX = /* glsl */ `
attribute float aShore;
varying vec3 vWaterPos;
varying float vShore;`;

const PARS_FRAGMENT = /* glsl */ `
uniform sampler2D uRipple;
uniform float uTime;
uniform float uDetailOn;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uFoam;
varying vec3 vWaterPos;
varying float vShore;
float waterFoam = 0.0;`;

const RIPPLE_NORMAL = /* glsl */ `
{
  vec2 p = vWaterPos.xz;
  float dist = length( vViewPosition );
  vec2 n2;
  if ( uDetailOn > 0.5 ) {
    vec2 a = texture2D( uRipple, p * ${(1 / RIPPLE_TILE).toFixed(5)} + vec2( uTime * 0.011, uTime * 0.006 ) ).rg * 2.0 - 1.0;
    vec2 b = texture2D( uRipple, p * ${(1 / (RIPPLE_TILE * 0.41)).toFixed(5)} - vec2( uTime * 0.008, -uTime * 0.014 ) ).rg * 2.0 - 1.0;
    n2 = ( a + b ) * 0.32;
  } else {
    n2 = 0.05 * vec2( sin( p.x * 0.35 + uTime * 1.3 ) + sin( p.y * 0.21 - uTime * 0.7 ), cos( p.y * 0.29 - uTime * 1.1 ) );
  }
  // gentle near the camera, flat into the distance (ripples finer than a pixel only alias)
  n2 *= 1.0 - smoothstep( 40.0, 320.0, dist );
  vec3 wn = normalize( vec3( n2.x, 1.0, n2.y ) );
  normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
}`;

const FOAM_COLOR = /* glsl */ `
{
  float shore = clamp( vShore, 0.0, 1.0 );
  if ( shore > 0.002 && uDetailOn > 0.5 ) {
    float n = texture2D( uRipple, vWaterPos.xz * 0.11 + vec2( uTime * 0.02, -uTime * 0.013 ) ).b;
    float n2 = texture2D( uRipple, vWaterPos.xz * 0.37 - vec2( uTime * 0.03, uTime * 0.021 ) ).b;
    // a lacy band: dense at the bank, breaking into streaks further out
    waterFoam = smoothstep( 0.62, 0.9, shore * 0.85 + n * 0.45 + n2 * 0.25 - 0.18 ) * shore;
  } else if ( shore > 0.002 ) {
    waterFoam = smoothstep( 0.7, 1.0, shore ) * 0.6;
  }
  diffuseColor.rgb = mix( diffuseColor.rgb, uFoam, waterFoam );
}`;

/** No environment map (low tier, VR): reflect an analytic sky gradient, so the river still mirrors the sky. */
const SKY_REFLECTION = /* glsl */ `
#if defined( RE_IndirectSpecular ) && !defined( USE_ENVMAP )
{
  vec3 rv = reflect( -normalize( vViewPosition ), normal );
  rv = inverseTransformDirection( rv, viewMatrix );
  radiance += mix( uSkyHorizon, uSkyTop, pow( clamp( rv.y, 0.0, 1.0 ), 0.5 ) );
}
#endif
#if defined( RE_IndirectSpecular )
radiance *= 1.0 - waterFoam;
#endif`;

export interface WaterLook {
  /** linear body colour (what little light the water scatters back) */
  body: THREE.Color;
}

/** Linear sky colours for the analytic reflection: the dome's zenith / horizon at roughly its scene brightness. */
function skyColours(sky: SkyDef, top: THREE.Color, horizon: THREE.Color): void {
  const k = Math.max(0.4, sky.sunIntensity / 5) * 1.1;
  top.set(sky.top).multiplyScalar(k);
  horizon.set(sky.horizon).multiplyScalar(k);
}

/**
 * Water for a level lit by `sky`. `ripple` is the shared ripple map (rippleTexture); `detail` on = textured
 * ripples and foam noise, off = one analytic ripple (setWaterDetail toggles it later).
 */
export function waterMaterial(sky: SkyDef, ripple: THREE.Texture, detail: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x0b1d1f, roughness: 0.035, metalness: 0, envMapIntensity: 1 });
  m.name = 'water';
  const uniforms = {
    uRipple: { value: ripple },
    uTime: { value: 0 },
    uDetailOn: { value: detail ? 1 : 0 },
    uSkyTop: { value: new THREE.Color() },
    uSkyHorizon: { value: new THREE.Color() },
    uFoam: { value: new THREE.Color(0xd8e2e2) },
  };
  skyColours(sky, uniforms.uSkyTop.value, uniforms.uSkyHorizon.value);
  m.userData.water = uniforms;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_VERTEX}`)
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vWaterPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vShore = aShore;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS_FRAGMENT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FOAM_COLOR}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix( roughnessFactor, 0.85, waterFoam );')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${RIPPLE_NORMAL}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${SKY_REFLECTION}`);
  };
  m.customProgramCacheKey = () => 'water-v2';
  return m;
}

type WaterUniforms = { uTime: THREE.IUniform<number>; uDetailOn: THREE.IUniform<number>; uSkyTop: THREE.IUniform<THREE.Color>; uSkyHorizon: THREE.IUniform<THREE.Color> };

const uniformsOf = (m: THREE.Material): WaterUniforms => m.userData.water as WaterUniforms;

export function setWaterTime(m: THREE.Material, t: number): void {
  uniformsOf(m).uTime.value = t;
}

/** Textured ripples and foam (true) or the cheap analytic ripple (false). */
export function setWaterDetail(m: THREE.Material, on: boolean): void {
  uniformsOf(m).uDetailOn.value = on ? 1 : 0;
}

/** New sky (time of day changed): the analytic reflection follows it. */
export function setWaterSky(m: THREE.Material, sky: SkyDef): void {
  const u = uniformsOf(m);
  skyColours(sky, u.uSkyTop.value, u.uSkyHorizon.value);
}
