/**
 * Shader patches for MeshStandardMaterial / MeshPhysicalMaterial used by the environments (onBeforeCompile):
 * box-projected environment reflections, a world-space floor macro map (stains, wax, puddles), wall grime,
 * per-vertex roughness / metalness for the merged prop material and premultiplied glass. Every division and
 * normalisation is guarded: one NaN pixel spread by the bloom blur blacks out whole blocks of the frame.
 */
import * as THREE from 'three';

export interface BoxProjection {
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** where the environment probe was captured */
  probe: THREE.Vector3;
}

export interface MacroMap {
  texture: THREE.Texture;
  /** world x / z of the map's (0,0) corner */
  min: THREE.Vector2;
  /** metres covered along x / z */
  size: THREE.Vector2;
}

export interface WallGrime {
  /** tileable noise, G channel used */
  texture: THREE.Texture;
  /** noise repeats per metre */
  scale: number;
  /** dirt rises this high off the floor (m) */
  low: number;
  /** soot band under the ceiling at this height (m) */
  top: number;
}

export interface EnvPatch {
  box?: BoxProjection;
  macro?: MacroMap;
  grime?: WallGrime;
  /** `aRM` vertex attribute (roughness, metalness) drives the merged prop material */
  vertexRM?: boolean;
  /** transparent glass: reflections stay at full strength while the body fades (premultiplied blending) */
  glass?: { clearAlpha: number; dirtRoughness: number };
}

const VERT_HEAD = /* glsl */ `
varying vec3 vEnvWorld;
#ifdef ENV_VERTEX_RM
attribute vec2 aRM;
varying vec2 vRM;
#endif
`;

const VERT_BODY = /* glsl */ `
{
  vec4 envWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    envWp = instanceMatrix * envWp;
  #endif
  vEnvWorld = ( modelMatrix * envWp ).xyz;
}
#ifdef ENV_VERTEX_RM
vRM = aRM;
#endif
`;

const FRAG_HEAD = /* glsl */ `
varying vec3 vEnvWorld;
#ifdef ENV_BOX
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uBoxProbe;
#endif
#ifdef ENV_MACRO
uniform sampler2D uMacro;
uniform vec2 uMacroMin;
uniform vec2 uMacroSize;
#endif
#ifdef ENV_GRIME
uniform sampler2D uGrime;
uniform float uGrimeScale;
uniform float uGrimeLow;
uniform float uGrimeTop;
#endif
#ifdef ENV_VERTEX_RM
varying vec2 vRM;
#endif
#ifdef ENV_GLASS
uniform float uClearAlpha;
uniform float uDirtRough;
#endif
`;

const BOX_REFLECT = /* glsl */ `
reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
#ifdef ENV_BOX
{
  vec3 rv = vec3(
    reflectVec.x >= 0.0 ? max( reflectVec.x, 1e-4 ) : min( reflectVec.x, -1e-4 ),
    reflectVec.y >= 0.0 ? max( reflectVec.y, 1e-4 ) : min( reflectVec.y, -1e-4 ),
    reflectVec.z >= 0.0 ? max( reflectVec.z, 1e-4 ) : min( reflectVec.z, -1e-4 ) );
  vec3 tFar = max( ( uBoxMax - vEnvWorld ) / rv, ( uBoxMin - vEnvWorld ) / rv );
  float tHit = clamp( min( min( tFar.x, tFar.y ), tFar.z ), 0.0, 1e4 );
  vec3 hit = vEnvWorld + reflectVec * tHit - uBoxProbe;
  float hitLen = length( hit );
  reflectVec = hitLen > 1e-4 ? hit / hitLen : reflectVec;
}
#endif
`;

const AFTER_MAP = /* glsl */ `
#ifdef ENV_MACRO
vec4 envMacro = texture2D( uMacro, clamp( ( vEnvWorld.xz - uMacroMin ) / uMacroSize, 0.0, 1.0 ) );
diffuseColor.rgb *= envMacro.r * 2.0 * mix( 1.0, 0.6, envMacro.b );
#endif
#ifdef ENV_GRIME
{
  float gN = texture2D( uGrime, vec2( vEnvWorld.x + vEnvWorld.z, vEnvWorld.y ) * uGrimeScale ).g;
  float low = 1.0 - smoothstep( 0.0, uGrimeLow, vEnvWorld.y );
  float high = smoothstep( uGrimeTop - 1.6, uGrimeTop, vEnvWorld.y );
  diffuseColor.rgb *= ( 1.0 - 0.4 * low * ( 0.4 + gN ) ) * ( 1.0 - 0.35 * high * ( 0.3 + gN ) ) * ( 0.88 + 0.24 * gN );
}
#endif
#ifdef ENV_GLASS
float envDirt = diffuseColor.a;
diffuseColor.a = mix( uClearAlpha, 1.0, envDirt );
#endif
`;

const AFTER_ROUGH = /* glsl */ `
#ifdef ENV_MACRO
roughnessFactor = mix( clamp( roughnessFactor + ( envMacro.g - 0.5 ), 0.04, 1.0 ), 0.06, envMacro.b );
#endif
#ifdef ENV_VERTEX_RM
roughnessFactor = clamp( vRM.x + ( roughnessFactor - 0.75 ) * 0.6, 0.04, 1.0 );
#endif
#ifdef ENV_GLASS
roughnessFactor = mix( roughnessFactor, uDirtRough, envDirt );
#endif
`;

const AFTER_METAL = /* glsl */ `
#ifdef ENV_VERTEX_RM
metalnessFactor = vRM.y;
#endif
`;

const AFTER_NORMAL = /* glsl */ `
#ifdef ENV_MACRO
{
  vec3 flatN = normalize( vNormal );
  normal = normalize( mix( normal, flatN, envMacro.b * 0.9 ) );
}
#endif
`;

const GLASS_OUT = /* glsl */ `
gl_FragColor = vec4( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance, diffuseColor.a );
`;

function key(p: EnvPatch): string {
  return ['env', p.box ? 'b' : '', p.macro ? 'm' : '', p.grime ? 'g' : '', p.vertexRM ? 'v' : '', p.glass ? 'gl' : ''].join('');
}

/** Install the patch on `mat` (replaces any previous onBeforeCompile). Uniform values stay live on `mat.userData.envUniforms`. */
export function applyEnvPatch<M extends THREE.MeshStandardMaterial>(mat: M, p: EnvPatch): M {
  const uniforms: Record<string, THREE.IUniform> = {};
  const defines: Record<string, string> = {};
  if (p.box) {
    defines.ENV_BOX = '';
    uniforms.uBoxMin = { value: p.box.min };
    uniforms.uBoxMax = { value: p.box.max };
    uniforms.uBoxProbe = { value: p.box.probe };
  }
  if (p.macro) {
    defines.ENV_MACRO = '';
    uniforms.uMacro = { value: p.macro.texture };
    uniforms.uMacroMin = { value: p.macro.min };
    uniforms.uMacroSize = { value: p.macro.size };
  }
  if (p.grime) {
    defines.ENV_GRIME = '';
    uniforms.uGrime = { value: p.grime.texture };
    uniforms.uGrimeScale = { value: p.grime.scale };
    uniforms.uGrimeLow = { value: p.grime.low };
    uniforms.uGrimeTop = { value: p.grime.top };
  }
  if (p.vertexRM) {
    defines.ENV_VERTEX_RM = '';
    mat.userData.vertexRM = true;
  }
  if (p.glass) {
    defines.ENV_GLASS = '';
    uniforms.uClearAlpha = { value: p.glass.clearAlpha };
    uniforms.uDirtRough = { value: p.glass.dirtRoughness };
    mat.premultipliedAlpha = true;
  }
  mat.userData.envUniforms = uniforms;
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  const k = key(p);
  mat.customProgramCacheKey = () => k;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${AFTER_MAP}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${AFTER_ROUGH}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${AFTER_METAL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${AFTER_NORMAL}`);
    if (p.box) {
      fs = fs.replace('#include <envmap_physical_pars_fragment>', THREE.ShaderChunk.envmap_physical_pars_fragment.replace('reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );', BOX_REFLECT));
    }
    if (p.glass) {
      fs = fs.replace('#include <opaque_fragment>', GLASS_OUT).replace('#include <premultiplied_alpha_fragment>', '');
    }
    shader.fragmentShader = fs;
  };
  mat.needsUpdate = true;
  return mat;
}
