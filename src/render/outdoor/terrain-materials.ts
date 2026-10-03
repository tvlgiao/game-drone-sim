/**
 * Materials for generated terrain: vertex-colour ground with a procedural detail texture (grass grain on flats,
 * rock strata on slopes, blended by the normal: triplanar-ish), road ribbons with painted lines, and the shared
 * instancing transform used by trees, rocks, houses and bridges. Textures are DataTextures (no canvas), so the
 * module also builds in Node tests.
 */
import * as THREE from 'three';
import { fbmField } from '../textures';

/** metres per fine detail tile; a second, coarser tile hides the repetition */
export const DETAIL_TILE = 4;
const DETAIL_TILE_COARSE = 29;

/**
 * RGBA detail: R fine grain (grass / soil), G stretched strata (rock faces), B medium blotches, A macro
 * variation. Tileable, mipmapped, values around 0.5.
 */
export function terrainDetailTexture(size = 256, anisotropy = 4): THREE.DataTexture {
  const fine = fbmField(size, 32, 3, 101, 0.55);
  const strata = fbmField(size, 8, 4, 202, 0.5);
  const mid = fbmField(size, 8, 4, 303, 0.6);
  const macro = fbmField(size, 4, 3, 404, 0.5);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // strata: the same noise squashed vertically reads as layered rock
      const sy = (Math.floor(y / 4) * 4) % size;
      const s = strata[sy * size + x]! * 0.6 + strata[i]! * 0.4;
      data[i * 4] = Math.round(fine[i]! * 255);
      data[i * 4 + 1] = Math.round(s * 255);
      data[i * 4 + 2] = Math.round(mid[i]! * 255);
      data[i * 4 + 3] = Math.round(macro[i]! * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** sRGB-authored vertex colours (the world engine's palette) to linear, before lighting. */
const COLOR_VERTEX_SRGB = /* glsl */ `
#include <color_vertex>
#if defined( USE_COLOR )
  vColor.rgb = pow( vColor.rgb, vec3( 2.2 ) );
#endif`;

const TERRAIN_VARYINGS = /* glsl */ `
varying vec3 vTerrainPos;
varying vec3 vTerrainN;`;

const DETAIL_FN = /* glsl */ `
uniform sampler2D uDetail;
float terrainDetail( vec3 p, vec3 n, float dist, out float steep ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= ( w.x + w.y + w.z );
  steep = 1.0 - smoothstep( 0.55, 0.8, n.y );
  float k = 1.0 / ${DETAIL_TILE.toFixed(1)};
  float kc = 1.0 / ${DETAIL_TILE_COARSE.toFixed(1)};
  vec4 top = texture2D( uDetail, p.xz * k );
  vec4 topC = texture2D( uDetail, p.xz * kc + 0.37 );
  float grass = top.r * 0.55 + topC.b * 0.45;
  float rock = texture2D( uDetail, p.zy * kc ).g * w.x + texture2D( uDetail, p.xy * kc ).g * w.z + topC.g * w.y;
  rock = rock * 0.7 + top.r * 0.3;
  float d = mix( grass, rock, steep );
  // far away the grain only shimmers: fade to the mean
  return mix( d, 0.5, smoothstep( 120.0, 520.0, dist ) );
}
// screen-space bump from a height (three's perturbNormalArb without a bump map)
vec3 terrainBump( vec3 p, vec3 n, float h ) {
  vec3 sx = dFdx( p );
  vec3 sy = dFdy( p );
  vec3 r1 = cross( sy, n );
  vec3 r2 = cross( n, sx );
  float det = dot( sx, r1 ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  vec3 grad = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 );
  return normalize( abs( det ) * n - grad );
}`;

/**
 * Terrain: vertex colours × detail, macro tint variation, wetter / glossier snow. One program for every
 * chunk and LOD (and the far backdrop, which adds its own colours).
 */
export function terrainMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0, envMapIntensity: 0.2 });
  m.name = 'terrain';
  m.onBeforeCompile = (s) => {
    s.uniforms.uDetail = { value: detail };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VARYINGS}`)
      .replace('#include <color_vertex>', COLOR_VERTEX_SRGB)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  vTerrainPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vTerrainN = normalize( mat3( modelMatrix ) * objectNormal );`,
      );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VARYINGS}\n${DETAIL_FN}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float steep;
  float dist = length( vViewPosition );
  float d = terrainDetail( vTerrainPos, normalize( vTerrainN ), dist, steep );
  float macro = texture2D( uDetail, vTerrainPos.xz * 0.0021 ).a;
  float snow = smoothstep( 0.62, 0.8, min( diffuseColor.r, diffuseColor.b ) );
  diffuseColor.rgb *= mix( 0.62 + 0.76 * d, 0.9 + 0.2 * d, snow );
  diffuseColor.rgb *= mix( vec3( 0.84, 0.9, 0.82 ), vec3( 1.1, 1.05, 0.95 ), macro );
  // rock faces: gullies down the fall line and banded strata, large enough to survive the distance fade
  float gully = texture2D( uDetail, vec2( dot( vTerrainPos.xz, vec2( 0.0071, 0.0049 ) ), vTerrainPos.y * 0.0012 ) ).g;
  float band = texture2D( uDetail, vec2( vTerrainPos.y * 0.011, 0.37 ) ).r;
  vec3 rockTint = mix( vec3( 0.74, 0.77, 0.82 ), vec3( 1.02, 0.98, 0.9 ), band );
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * rockTint * ( 0.62 + 0.62 * gully ), steep * ( 1.0 - snow ) );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor, 0.55, snow );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  // crags on rock faces, a softer grain on grass; gone with the detail at distance
  normal = terrainBump( -vViewPosition, normal, ( d - 0.5 ) * mix( 0.12, 0.9, steep ) * ( 1.0 - snow * 0.6 ) );`,
      );
  };
  m.customProgramCacheKey = () => 'terrain-v3';
  return m;
}

const ROAD_VARYINGS = /* glsl */ `
varying vec2 vRoad;
varying vec3 vRoadPos;`;

/**
 * Road ribbons: asphalt grain, a crisp dashed centre line and solid edge lines from the per-vertex `aRoad`
 * (across −1..1, dash 0/1), gravel shoulders at the very edge.
 */
export function roadMaterial(detail: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, envMapIntensity: 0.5 });
  m.name = 'road';
  m.onBeforeCompile = (s) => {
    s.uniforms.uDetail = { value: detail };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aRoad;\n${ROAD_VARYINGS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n  vRoad = aRoad;\n  vRoadPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uDetail;\n${ROAD_VARYINGS}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float a = abs( vRoad.x );
  float grain = texture2D( uDetail, vRoadPos.xz * 0.5 ).r;
  vec3 asphalt = vec3( 0.052, 0.054, 0.058 ) * ( 0.8 + 0.4 * grain );
  float aa = fwidth( vRoad.x ) * 1.5;
  float centre = ( 1.0 - smoothstep( 0.035 - aa, 0.035 + aa, a ) ) * step( 0.5, vRoad.y );
  float edge = smoothstep( 0.83 - aa, 0.83 + aa, a ) * ( 1.0 - smoothstep( 0.88 - aa, 0.88 + aa, a ) );
  vec3 paint = vec3( 0.78, 0.76, 0.68 );
  vec3 shoulder = vec3( 0.2, 0.18, 0.14 ) * ( 0.7 + 0.6 * grain );
  vec3 col = mix( asphalt, paint, max( centre, edge ) );
  col = mix( col, shoulder, smoothstep( 0.92, 0.99, a ) );
  diffuseColor.rgb = col;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix( 0.86, 0.6, max( centre, edge ) );');
  };
  m.customProgramCacheKey = () => 'road-v1';
  return m;
}

/**
 * Vertex transform for packed instances: `aInst` (x, y, z relative to the floating origin, yaw) and `aInstB`
 * (scale x, y, z, tint). Houses (INST_ROOF) add `aInstC.x` = roof height: model vertices above y = 1 are the roof
 * and stretch by it instead of the wall height. Normals follow the inverse scale.
 */
export const INSTANCE_PARS = /* glsl */ `
attribute vec4 aInst;
attribute vec4 aInstB;
#ifdef INST_ROOF
attribute vec4 aInstC;
#endif
uniform float uTime;
uniform float uSway;
varying float vTint;`;

const INSTANCE_SCALE = /* glsl */ `
vec3 instScale = aInstB.xyz;
#ifdef INST_ROOF
  if ( position.y > 1.0001 ) instScale.y = aInstC.x;
#endif`;

export const INSTANCE_NORMAL = /* glsl */ `
${INSTANCE_SCALE}
vec3 objectNormal = normalize( vec3( normal ) / instScale );
{
  float c = cos( aInst.w );
  float s = sin( aInst.w );
  objectNormal = vec3( c * objectNormal.x + s * objectNormal.z, objectNormal.y, -s * objectNormal.x + c * objectNormal.z );
}
#ifdef USE_TANGENT
  vec3 objectTangent = vec3( tangent.xyz );
#endif`;

export const INSTANCE_BEGIN = /* glsl */ `
vec3 transformed = vec3( position ) * aInstB.xyz;
#ifdef INST_ROOF
  if ( position.y > 1.0001 ) transformed.y = aInstB.y + ( position.y - 1.0 ) * aInstC.x;
#endif
// crowns sway with height (uSway = 0 for rigid objects)
transformed.xz += uSway * transformed.y * transformed.y * 0.0006 * vec2( sin( uTime * 1.3 + aInst.x * 0.21 + aInst.z * 0.17 ), cos( uTime * 1.1 + aInst.z * 0.19 ) );
{
  float c = cos( aInst.w );
  float s = sin( aInst.w );
  transformed = vec3( c * transformed.x + s * transformed.z, transformed.y, -s * transformed.x + c * transformed.z );
}
transformed += aInst.xyz;
vTint = aInstB.w;`;

export interface InstancedMaterialOptions {
  roughness?: number;
  /** model has a roof part stretched by aInstC.x (houses) */
  roof?: boolean;
  sway?: number;
  /** extra fragment code after color_fragment (vTint, diffuseColor available) */
  fragment?: string;
  /** extra fragment uniforms / functions */
  fragmentPars?: string;
  /** fragment code after roughnessmap_fragment / metalnessmap_fragment (set roughnessFactor / metalnessFactor) */
  afterRoughness?: string;
  afterMetalness?: string;
  /** fragment code after lights_fragment_maps (e.g. scale `radiance`, the environment reflection) */
  afterLightMaps?: string;
  defines?: Record<string, string>;
  /** extra vertex varyings assigned after INSTANCE_BEGIN */
  vertex?: string;
  vertexPars?: string;
  uniforms?: Record<string, THREE.IUniform>;
  key: string;
}

/** Shared uniforms of every instanced material (time drives the crown sway). */
export interface InstanceUniforms {
  uTime: THREE.IUniform<number>;
}

function patchInstanced(s: THREE.WebGLProgramParametersWithUniforms, o: InstancedMaterialOptions, shared: InstanceUniforms, depth: boolean): void {
  s.uniforms.uTime = shared.uTime;
  s.uniforms.uSway = { value: o.sway ?? 0 };
  if (o.uniforms) Object.assign(s.uniforms, o.uniforms);
  s.vertexShader = s.vertexShader
    .replace('#include <common>', `#include <common>\n${INSTANCE_PARS}\n${o.vertexPars ?? ''}`)
    .replace('#include <beginnormal_vertex>', INSTANCE_NORMAL)
    .replace('#include <begin_vertex>', `${INSTANCE_BEGIN}\n${o.vertex ?? ''}`);
  if (depth) return;
  s.vertexShader = s.vertexShader.replace('#include <color_vertex>', COLOR_VERTEX_SRGB);
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying float vTint;\n${o.fragmentPars ?? ''}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragment ?? ''}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${o.afterRoughness ?? ''}`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${o.afterMetalness ?? ''}`)
    .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${o.afterLightMaps ?? ''}`);
}

/** MeshStandardMaterial (vertex colours) with the packed instance transform, plus the matching shadow depth material. */
export function instancedMaterials(o: InstancedMaterialOptions, shared: InstanceUniforms): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: o.roughness ?? 0.9, metalness: 0, envMapIntensity: 0.4 });
  material.name = o.key;
  material.defines = { ...(o.roof ? { INST_ROOF: '' } : {}), ...o.defines };
  material.onBeforeCompile = (s) => patchInstanced(s, o, shared, false);
  material.customProgramCacheKey = () => `inst-${o.key}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (o.roof) depth.defines = { INST_ROOF: '' };
  depth.onBeforeCompile = (s) => patchInstanced(s, o, shared, true);
  depth.customProgramCacheKey = () => `inst-depth-${o.key}`;
  return { material, depth };
}
