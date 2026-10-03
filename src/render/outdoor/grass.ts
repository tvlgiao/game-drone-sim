/**
 * Grass blades around the camera: one instanced draw of three-blade tufts scattered over a square patch
 * that wraps toroidally around the eye, so every tuft stays put in the world as the camera moves and
 * the far edge fades out. Mowed short on the flying field, long with wild flowers outside it, none on
 * the pad and gravel. Lit by the scene (sun, hemisphere, shadows) with ground-like normals so the blades
 * melt into the ground; wind sway in the vertex shader. Tier-gated count; off on the lowest tier.
 */
import * as THREE from 'three';
import { GUST_GLSL } from '../life/gust';
import { mulberry32 } from '../materials/texgen';

export interface GrassOptions {
  /** half-size of the flying field (mowed inside) */
  fieldHalf: number;
  /** rectangles with no grass (pad, gravel): [minX, minZ, maxX, maxZ] */
  bare: readonly (readonly [number, number, number, number])[];
  /** horizontal unit wind direction (x, z) */
  wind: THREE.Vector2;
  maxTufts: number;
}

const BLADES = 3;
/** blade cross-section rows: height fraction, half-width (m) */
const ROWS: readonly [number, number][] = [
  [0, 0.006],
  [0.35, 0.0055],
  [0.7, 0.0035],
  [1, 0],
];

function tuftGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const shade: number[] = [];
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI + 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const ox = Math.cos(a * 2.3) * 0.02;
    const oz = Math.sin(a * 2.3) * 0.02;
    const lean = 0.18 + b * 0.07;
    const base = pos.length / 3;
    for (const [h, w] of ROWS) {
      const bend = h * h * lean;
      for (const s of [-1, 1]) {
        pos.push(ox + ca * w * s - sa * bend, h, oz + sa * w * s + ca * bend);
        shade.push(h);
      }
    }
    for (let r = 0; r < ROWS.length - 1; r++) {
      const i = base + r * 2;
      idx.push(i, i + 1, i + 3, i, i + 3, i + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  g.setIndex(idx);
  return g;
}

const VERT_HEAD = /* glsl */ `
attribute vec3 aTuft;   // x, z inside the patch, random 0..1
attribute float aShade; // 0 root .. 1 tip
uniform vec2 uCenter;
uniform float uHalf;
uniform float uTime;
uniform vec2 uWind;
uniform float uFieldHalf;
uniform vec4 uBare[4];
uniform int uBareCount;
varying float vShade;
varying float vWild;
varying float vRnd;
varying float vGust;
${GUST_GLSL}
`;

const VERT_BODY = /* glsl */ `
vec2 world = uCenter + mod( aTuft.xy - uCenter + uHalf, 2.0 * uHalf ) - uHalf;
float rnd = aTuft.z;
float dist = length( world - uCenter );
float fade = 1.0 - smoothstep( uHalf * 0.55, uHalf * 0.95, dist );
float wild = 1.0 - step( abs( world.x ), uFieldHalf ) * step( abs( world.y ), uFieldHalf );
float height = mix( 0.06 + rnd * 0.05, 0.2 + rnd * 0.32, wild ) * fade;
for ( int i = 0; i < 4; i++ ) {
  if ( i >= uBareCount ) break;
  vec4 b = uBare[ i ];
  if ( world.x > b.x && world.x < b.z && world.y > b.y && world.y < b.w ) height = 0.0;
}
float ang = rnd * 6.2831853;
float ca = cos( ang );
float sa = sin( ang );
vec3 p = vec3( position.x * ca - position.z * sa, position.y, position.x * sa + position.z * ca );
p.y *= height;
p.xz *= 0.6 + height * 3.0;
// wind: gusts travel downwind; the bend grows with the square of the height along the blade
float gust = sin( dot( world, uWind ) * 0.35 - uTime * 1.9 + rnd * 1.3 ) * 0.5 + 0.5;
float flutter = sin( uTime * 7.0 + rnd * 40.0 ) * 0.15;
// travelling gusts (docs/12): a band rolling downwind lays the blades over
float big = lifeGust( world, uWind, uTime );
float bend = position.y * position.y * height * ( 0.25 + 0.55 * gust + flutter + 1.1 * big ) * mix( 0.5, 1.0, wild );
vGust = big;
p.xz += uWind * bend;
p.y -= bend * bend * 0.6;
vec3 transformed = vec3( world.x + p.x, p.y, world.y + p.z );
vShade = aShade;
vWild = wild;
vRnd = rnd;
`;

const FRAG_HEAD = /* glsl */ `
varying float vGust;
varying float vShade;
varying float vWild;
varying float vRnd;
uniform vec3 uMowed;
uniform vec3 uWild;
`;

const FRAG_COLOR = /* glsl */ `
{
  vec3 tip = mix( uMowed, uWild, vWild );
  // dry tips on some wild tufts, flowers on a few
  tip = mix( tip, tip * vec3( 1.35, 1.2, 0.75 ), step( 0.72, vRnd ) * vWild * 0.6 );
  vec3 col = mix( tip * 0.45, tip * ( 0.95 + vRnd * 0.2 ), smoothstep( 0.0, 0.9, vShade ) );
  float flower = step( 0.955, vRnd ) * vWild * smoothstep( 0.82, 0.95, vShade );
  vec3 petal = vRnd > 0.985 ? vec3( 0.95, 0.85, 0.2 ) : vRnd > 0.97 ? vec3( 0.95, 0.95, 0.92 ) : vec3( 0.65, 0.45, 0.9 );
  diffuseColor.rgb *= mix( col, petal, flower );
  // blades laid over by a gust show their paler side
  diffuseColor.rgb *= 1.0 + 0.22 * vGust * vShade;
}
`;

export class Grass {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshStandardMaterial>;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly maxTufts: number;

  constructor(o: GrassOptions) {
    this.maxTufts = o.maxTufts;
    const g = tuftGeometry();
    const rnd = mulberry32(4242);
    const data = new Float32Array(o.maxTufts * 3);
    for (let i = 0; i < o.maxTufts; i++) {
      data[i * 3] = rnd() * 64;
      data[i * 3 + 1] = rnd() * 64;
      data[i * 3 + 2] = rnd();
    }
    g.setAttribute('aTuft', new THREE.InstancedBufferAttribute(data, 3));
    g.instanceCount = 0;
    const bare = o.bare.slice(0, 4).map((b) => new THREE.Vector4(b[0], b[1], b[2], b[3]));
    while (bare.length < 4) bare.push(new THREE.Vector4(0, 0, 0, 0));
    this.uniforms = {
      uCenter: { value: new THREE.Vector2() },
      uHalf: { value: 14 },
      uTime: { value: 0 },
      uWind: { value: o.wind.clone().normalize() },
      uFieldHalf: { value: o.fieldHalf },
      uBare: { value: bare },
      uBareCount: { value: Math.min(4, o.bare.length) },
      uMowed: { value: new THREE.Color(0x6aa344) },
      uWild: { value: new THREE.Color(0x7b9a44) },
    };
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.3 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
        .replace('#include <begin_vertex>', VERT_BODY)
        // ground-like normals: the blades take the light the ground under them gets
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_COLOR}`);
    };
    mat.customProgramCacheKey = () => 'grass-tufts';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'grass';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
  }

  /** `count` tufts over a patch of half-size `half` (m); 0 hides the grass. */
  setDensity(count: number, half: number): void {
    const n = Math.max(0, Math.min(this.maxTufts, Math.round(count)));
    this.uniforms.uHalf!.value = half;
    const attr = this.mesh.geometry.getAttribute('aTuft') as THREE.InstancedBufferAttribute;
    const rnd = mulberry32(4242);
    for (let i = 0; i < this.maxTufts; i++) {
      attr.setXYZ(i, rnd() * half * 2, rnd() * half * 2, rnd());
    }
    attr.needsUpdate = true;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  get count(): number {
    return this.mesh.visible ? this.mesh.geometry.instanceCount : 0;
  }

  update(time: number, eye: THREE.Vector3): void {
    this.uniforms.uTime!.value = time;
    (this.uniforms.uCenter!.value as THREE.Vector2).set(eye.x, eye.z);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
