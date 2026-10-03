/**
 * Rivers, lakes and the City river: a cheap opaque water shader. Two scrolling detail samples perturb the normal,
 * Fresnel mixes the deep colour with the sky (zenith → horizon, the fog colour), a sun glint on top. The Quest
 * variant skips the texture taps and animates a single analytic ripple.
 */
import * as THREE from 'three';
import type { SkyDef } from '../../types';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uDetail;
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uDetailOn;
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz;
  vec2 n2;
  if ( uDetailOn > 0.5 ) {
    vec2 a = texture2D( uDetail, p * 0.031 + vec2( uTime * 0.012, uTime * 0.007 ) ).rb;
    vec2 b = texture2D( uDetail, p * 0.073 - vec2( uTime * 0.009, -uTime * 0.016 ) ).rb;
    n2 = ( a + b - 1.0 ) * 0.2;
  } else {
    n2 = 0.06 * vec2( sin( p.x * 0.35 + uTime * 1.3 ), cos( p.y * 0.29 - uTime * 1.1 ) );
  }
  vec3 N = normalize( vec3( n2.x, 1.0, n2.y ) );
  vec3 V = normalize( cameraPosition - vWorld );
  float dist = length( cameraPosition - vWorld );
  // ripples flatten out with distance (they would only alias)
  N = normalize( mix( N, vec3( 0.0, 1.0, 0.0 ), smoothstep( 60.0, 400.0, dist ) ) );
  float ndv = max( dot( N, V ), 0.0 );
  float fres = 0.03 + 0.97 * pow( 1.0 - ndv, 5.0 );
  vec3 R = reflect( -V, N );
  vec3 sky = mix( uSkyHorizon, uSkyTop, pow( clamp( R.y, 0.0, 1.0 ), 0.5 ) );
  vec3 body = mix( uShallow, uDeep, clamp( 1.0 - ndv * 0.6, 0.0, 1.0 ) );
  vec3 col = mix( body, sky * 0.8, fres );
  float glint = pow( max( dot( R, uSunDir ), 0.0 ), 260.0 );
  col += uSunColor * glint * 4.0;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export interface WaterUniforms {
  uTime: THREE.IUniform<number>;
}

/** Water material lit by `sky`; `detail` on = animated normals from the detail texture. */
export function waterMaterial(sky: SkyDef, detailTex: THREE.Texture, detail: boolean): THREE.ShaderMaterial {
  const lin = (hex: number): THREE.Color => new THREE.Color(hex);
  const m = new THREE.ShaderMaterial({
    name: 'water',
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uDetail: { value: null },
        uTime: { value: 0 },
        uDeep: { value: lin(0x0d2226) },
        uShallow: { value: lin(0x1e3c38) },
        uSkyTop: { value: lin(sky.top) },
        uSkyHorizon: { value: lin(sky.horizon) },
        uSunDir: { value: new THREE.Vector3(...sky.sunDir).normalize() },
        uSunColor: { value: lin(sky.sunColor).multiplyScalar(Math.min(1.5, sky.sunIntensity / 4)) },
        uDetailOn: { value: detail ? 1 : 0 },
      },
    ]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    fog: true,
  });
  // merge() clones values: the texture must be the shared instance
  m.uniforms.uDetail!.value = detailTex;
  return m;
}

export function setWaterTime(m: THREE.ShaderMaterial, t: number): void {
  m.uniforms.uTime!.value = t;
}
