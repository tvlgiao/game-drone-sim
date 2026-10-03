/**
 * Instanced MeshStandardMaterial for the living world's animated models (birds flapping, fans and rotors turning,
 * flags fluttering, animals grazing): the same packed instance layout as the scenery (`aInst` = x, y, z, yaw;
 * `aInstB` = scale x, y, z, tint) but with a `pre` GLSL hook that moves the model's vertex `p` (and its normal `n`)
 * in model space before the instance transform — so the animation is free on the CPU. `uv.x` is the model's part
 * id, `uv.y` a per-vertex weight (how much a vertex flaps / spins / flutters), `vTint` the instance tint, `uTime`
 * the shared clock. A matching depth material casts the same animated shadow.
 */
import * as THREE from 'three';
import type { InstanceUniforms } from '../outdoor/terrain-materials';

export interface AnimatedMaterialOptions {
  key: string;
  /** GLSL: may change `p` (model position) and `n` (model normal); `uv`, `aInstB`, `aInst`, `uTime`, `lifeSeed` (0..1 per instance) in scope */
  pre?: string;
  vertexPars?: string;
  /** fragment code after color_fragment (vTint, vPart, vWeight, diffuseColor available) */
  fragment?: string;
  fragmentPars?: string;
  afterRoughness?: string;
  uniforms?: Record<string, THREE.IUniform>;
  roughness?: number;
  envMapIntensity?: number;
  side?: THREE.Side;
}

const PARS = /* glsl */ `
attribute vec4 aInst;
attribute vec4 aInstB;
uniform float uTime;
varying float vTint;
varying float vPart;
varying float vWeight;
vec3 lifeP;
vec3 lifeN;`;

function body(pre: string): string {
  return /* glsl */ `
{
  vec3 p = position;
  vec3 n = normal;
  float lifeSeed = fract( sin( dot( aInst.xz, vec2( 0.1731, 0.3197 ) ) ) * 9631.17 );
  ${pre}
  p *= aInstB.xyz;
  float c = cos( aInst.w );
  float s = sin( aInst.w );
  lifeP = vec3( c * p.x + s * p.z, p.y, -s * p.x + c * p.z ) + aInst.xyz;
  lifeN = normalize( vec3( c * n.x + s * n.z, n.y, -s * n.x + c * n.z ) );
  vTint = aInstB.w;
  vPart = uv.x;
  vWeight = uv.y;
}`;
}

function patch(s: THREE.WebGLProgramParametersWithUniforms, o: AnimatedMaterialOptions, shared: InstanceUniforms, depth: boolean): void {
  s.uniforms.uTime = shared.uTime;
  if (o.uniforms) Object.assign(s.uniforms, o.uniforms);
  const code = body(o.pre ?? '');
  s.vertexShader = s.vertexShader.replace('#include <common>', `#include <common>\n${PARS}\n${o.vertexPars ?? ''}`);
  if (depth) {
    s.vertexShader = s.vertexShader.replace('#include <begin_vertex>', `${code}\nvec3 transformed = lifeP;`);
    return;
  }
  s.vertexShader = s.vertexShader
    .replace('#include <beginnormal_vertex>', `${code}\nvec3 objectNormal = lifeN;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif`)
    .replace('#include <begin_vertex>', 'vec3 transformed = lifeP;')
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
#if defined( USE_COLOR )
  vColor.rgb = pow( vColor.rgb, vec3( 2.2 ) );
#endif`,
    );
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying float vTint;\nvarying float vPart;\nvarying float vWeight;\nuniform float uTime;\n${o.fragmentPars ?? ''}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${o.fragment ?? ''}`)
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${o.afterRoughness ?? ''}`);
}

/** Lit animated instanced material (vertex colours, sRGB → linear) plus its shadow depth material. */
export function animatedMaterials(o: AnimatedMaterialOptions, shared: InstanceUniforms): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: o.roughness ?? 0.85, metalness: 0, envMapIntensity: o.envMapIntensity ?? 0.5, side: o.side ?? THREE.FrontSide });
  material.name = o.key;
  material.onBeforeCompile = (s) => patch(s, o, shared, false);
  material.customProgramCacheKey = () => `life-${o.key}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: o.side ?? THREE.FrontSide });
  depth.onBeforeCompile = (s) => patch(s, o, shared, true);
  depth.customProgramCacheKey = () => `life-depth-${o.key}`;
  return { material, depth };
}
