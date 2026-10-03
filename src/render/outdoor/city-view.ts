/**
 * City rendering (design 07 §3): every building, slab, stilt, skybridge and outskirts block is one instance of a
 * unit box drawn in a single call; a facade shader derives floors, window columns, storefronts, roofs and lit
 * windows from the instance size and seed. The ground is one mesh following the river channel, with asphalt,
 * lane markings, crosswalks, sidewalks, plazas and the park drawn in its shader. Roof props are instanced boxes
 * and cylinders (antennas blink), park and street trees use the shared tree instancing, the river the shared
 * water shader; street lights, parked cars and kerbs are one instanced draw each.
 */
import * as THREE from 'three';
import type { Outskirts } from '../../levels/city-outskirts';
import { BUILDING_STRIDE, CITY_BLOCKS, CITY_HALF, CITY_RIVER, ROOF_PROP_STRIDE, type City } from '../../world/city-gen';
import { InstanceLayer } from './scatter-view';
import { instancedMaterials, type InstanceUniforms } from './terrain-materials';
import { carModel, LAMP_HEX, streetLightModel, unitBox, unitCylinder } from './scatter-models';
import { CAR_STRIDE, KERB_STRIDE, LIGHT_STRIDE, type CityFurniture } from '../../levels/city-furniture';

/** packed instance code: kind in the high bits, the building seed below (exact in float32) */
const KIND_SHIFT = 1048576;
export const BUILDING_KIND = { building: 0, slab: 1, skybridge: 2, outskirts: 3 } as const;

const FACADE_PARS = /* glsl */ `
uniform float uDusk;
uniform float uLit;
uniform sampler2D uDetail;
varying vec3 vFLocal;
varying vec3 vFN;
varying vec3 vFSize;
varying float vFBase;
float fh( float n ) { return fract( sin( mod( n, 251.0 ) * 12.9898 + 4.1414 ) * 43758.5453 ); }
// sin-hash arguments stay small (|p| < ~1000): a large argument collapses to the same value on GPUs
float fh3( vec3 p ) { return fract( sin( dot( mod( p, 251.0 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
vec3 srgb( float r, float g, float b ) { return pow( vec3( r, g, b ), vec3( 2.2 ) ); }
vec3 pick4( float t, vec3 a, vec3 b, vec3 c, vec3 d ) { return t < 0.25 ? a : t < 0.5 ? b : t < 0.75 ? c : d; }
float fRough;
float fMetal;
float fRefl;`;

/**
 * Facade: styles 0 glass curtain wall, 1 concrete ribbon windows, 2 brick punched windows, 3 stucco. Windows
 * fade to their average colour where they would alias (far away), lit windows add emissive by uDusk.
 */
const FACADE_FRAGMENT = /* glsl */ `
float code = vTint;
float kind = floor( code / ${KIND_SHIFT.toFixed(1)} );
float seed = mod( code, ${KIND_SHIFT.toFixed(1)} );
float h1 = fh( seed * 0.00137 + 0.31 );
float h2 = fh( seed * 0.00071 + 1.73 );
float h3 = fh( seed * 0.00053 + 2.91 );
float h4 = fh( seed * 0.00031 + 5.17 );
vec3 n = normalize( vFN );
vec3 S = vFSize;
// 0 glass curtain wall, 1 concrete ribbon windows, 2 brick punched windows, 3 stucco
float style = kind == 2.0 ? 0.0 : kind == 1.0 ? 1.0
  : S.y > 70.0 ? ( h1 < 0.55 ? 0.0 : 1.0 )
  : S.y > 24.0 ? ( h1 < 0.25 ? 0.0 : h1 < 0.6 ? 1.0 : h1 < 0.85 ? 2.0 : 3.0 )
  : ( h1 < 0.15 ? 1.0 : h1 < 0.65 ? 2.0 : 3.0 );
vec3 glassTint = pick4( h2, srgb( 0.1, 0.17, 0.25 ), srgb( 0.09, 0.2, 0.21 ), srgb( 0.21, 0.16, 0.12 ), srgb( 0.13, 0.15, 0.19 ) );
vec3 wallCol = style == 0.0 ? pick4( h3, srgb( 0.2, 0.21, 0.23 ), srgb( 0.56, 0.57, 0.58 ), srgb( 0.08, 0.08, 0.09 ), srgb( 0.46, 0.43, 0.37 ) )
  : style == 1.0 ? pick4( h3, srgb( 0.62, 0.61, 0.58 ), srgb( 0.7, 0.67, 0.6 ), srgb( 0.47, 0.47, 0.46 ), srgb( 0.56, 0.53, 0.49 ) )
  : style == 2.0 ? pick4( h3, srgb( 0.45, 0.22, 0.16 ), srgb( 0.55, 0.3, 0.2 ), srgb( 0.35, 0.2, 0.16 ), srgb( 0.52, 0.42, 0.33 ) )
  : pick4( h3, srgb( 0.8, 0.75, 0.65 ), srgb( 0.86, 0.84, 0.8 ), srgb( 0.78, 0.69, 0.5 ), srgb( 0.76, 0.62, 0.55 ) );
vec3 trim = style == 0.0 ? wallCol : style == 2.0 ? srgb( 0.82, 0.8, 0.74 ) : style == 3.0 ? wallCol * 0.55 : wallCol * 0.45;
fRough = 0.86;
fMetal = 0.0;
fRefl = 1.0;
vec3 col = wallCol;
vec3 emit = vec3( 0.0 );
float grain = texture2D( uDetail, ( vFLocal.xz * S.xz + vFLocal.y * S.y ) * 0.21 ).r;
if ( n.y > 0.5 ) {
  // roof: tar / gravel, a lighter parapet coping, patches
  vec2 e = ( 0.5 - abs( vFLocal.xz ) ) * S.xz;
  float edge = 1.0 - step( 0.6, min( e.x, e.y ) );
  float blot = texture2D( uDetail, vFLocal.xz * S.xz * 0.031 ).b;
  vec3 roof = srgb( 0.3, 0.3, 0.29 ) * ( 0.75 + 0.35 * texture2D( uDetail, vFLocal.xz * S.xz * 0.15 ).r ) * ( 0.85 + 0.3 * blot );
  col = mix( roof * ( style == 0.0 ? 0.75 : 1.0 ), mix( wallCol, vec3( 0.6 ), 0.3 ), edge );
} else if ( n.y < -0.5 ) {
  col = srgb( 0.4, 0.4, 0.39 );
} else {
  bool xFace = abs( n.x ) > 0.5;
  float span = xFace ? S.z : S.x;
  float u = ( xFace ? vFLocal.z : vFLocal.x ) * span;
  float v = vFLocal.y * S.y;
  float yAbs = vFBase + v;
  float floorH = style == 0.0 ? 3.9 : style == 1.0 ? 3.7 : style == 2.0 ? 3.1 : 3.3;
  float colW = style == 0.0 ? 1.55 : style == 1.0 ? 2.7 : style == 2.0 ? 2.4 : 3.1;
  float winW = style == 0.0 ? 0.95 : style == 1.0 ? 0.88 : style == 2.0 ? 0.5 : 0.46;
  float winV0 = style == 0.0 ? 0.17 : style == 1.0 ? 0.28 : 0.3;
  float winV1 = style == 0.0 ? 0.98 : style == 1.0 ? 0.82 : 0.8;
  float ground = ( kind == 0.0 || kind == 3.0 ) && vFBase < 0.5 ? ( style == 0.0 ? 6.0 : 4.6 ) : 0.0;
  float vf = max( v - ground, 0.0 );
  float cu = u / colW + 0.5;
  float cv = vf / floorH;
  float fu = fract( cu );
  float fv = fract( cv );
  float fw = max( fwidth( cu ), fwidth( cv ) );
  float far = smoothstep( 0.1, 0.32, fw );
  float floorI = floor( cv );
  float colI = floor( cu );
  float faceI = n.x * 3.0 + n.z * 7.0;
  float seedK = h4 * 211.0;
  float rnd = fh3( vec3( floorI, colI, seedK + faceI ) );
  float win = step( 0.5 - winW * 0.5, fu ) * step( fu, 0.5 + winW * 0.5 ) * step( winV0, fv ) * step( fv, winV1 );
  // a frame of ~8 cm inside each window opening
  float fx = min( fu - ( 0.5 - winW * 0.5 ), ( 0.5 + winW * 0.5 ) - fu ) * colW;
  float fy = min( fv - winV0, winV1 - fv ) * floorH;
  float frame = win * ( 1.0 - step( 0.08, min( fx, fy ) ) );
  float cover = winW * ( winV1 - winV0 );
  float topBand = step( S.y - ( style == 0.0 ? 2.5 : 1.2 ), v );
  win *= 1.0 - topBand;
  frame *= 1.0 - topBand;
  if ( kind == 1.0 ) { win = 0.0; frame = 0.0; cover = 0.0; }
  float isStore = 0.0;
  if ( v < ground ) {
    // storefronts: tall glass between piers, a coloured fascia above
    float fs = fract( u / 4.2 + 0.5 );
    win = step( 0.08, fs ) * step( fs, 0.92 ) * step( 0.35, v ) * step( v, ground - 1.1 );
    frame = 0.0;
    cover = 0.84 * ( ground - 1.45 ) / ground;
    isStore = 1.0;
    wallCol *= ( style == 0.0 ? 0.6 : 0.82 );
    float fascia = step( ground - 1.0, v ) * step( v, ground - 0.35 );
    wallCol = mix( wallCol, pick4( fh( seed + colI * 0.37 ), srgb( 0.12, 0.2, 0.3 ), srgb( 0.45, 0.12, 0.1 ), srgb( 0.15, 0.15, 0.15 ), srgb( 0.12, 0.28, 0.2 ) ), fascia );
    rnd = fh( seed + colI * 1.7 );
  }
  // glass: dark interiors (some with lighter blinds) behind a reflective pane
  vec3 glass = style == 0.0 ? glassTint * ( 0.75 + 0.5 * rnd ) : mix( srgb( 0.05, 0.055, 0.065 ) * ( 0.6 + 0.9 * rnd ), srgb( 0.42, 0.39, 0.34 ), step( 0.86, rnd ) * ( 1.0 - isStore ) );
  float litP = isStore > 0.5 ? 0.12 + 0.75 * uDusk : uDusk * uDusk * 0.55 + 0.01;
  float lit = step( fh3( vec3( floorI + 17.0 * isStore, colI + 3.7, seedK * 1.37 + faceI ) ), litP );
  vec3 warm = mix( vec3( 1.0, 0.7, 0.4 ), vec3( 0.85, 0.9, 1.0 ), step( 0.75, rnd ) );
  vec3 litCol = warm * ( 0.7 + 0.6 * rnd ) * ( isStore > 0.5 ? 1.3 : 0.9 );
  // weathering: vertical streaks, a darker base
  float streak = texture2D( uDetail, vec2( u * 0.05, yAbs * 0.004 ) ).g;
  wallCol *= ( 0.86 + 0.24 * streak ) * ( 0.8 + 0.2 * smoothstep( 0.0, 6.0, yAbs ) ) * ( 0.9 + 0.2 * grain );
  // curtain walls: dark spandrel band at each slab
  if ( style == 0.0 && isStore < 0.5 ) wallCol = mix( wallCol, glassTint * 0.5, step( 0.04, fv ) * step( fv, winV0 - 0.02 ) * ( 1.0 - topBand ) );
  vec3 nearC = mix( mix( wallCol, glass, win ), trim, frame );
  vec3 farC = mix( wallCol, glass * 0.9, cover );
  col = mix( nearC, farC, far );
  float g = mix( win * ( 1.0 - frame ), cover, far );
  fRough = mix( 0.88, style == 0.0 ? 0.05 : 0.14, g );
  fMetal = mix( 0.0, style == 0.0 ? 0.3 : 0.05, g );
  // the sky probe has no buildings in it: windows reflect it dimmed, as if half the view were other facades
  fRefl = mix( 1.0, style == 0.0 ? 0.7 : 0.35, g );
  emit = litCol * mix( lit * win * ( 1.0 - frame ), litP * cover, far ) * uLit;
}
diffuseColor.rgb = col;
totalEmissiveRadiance += emit;`;

const FACADE_VERTEX = /* glsl */ `
vFLocal = position;
vFN = normal;
vFSize = aInstB.xyz;
vFBase = aInst.y;`;

const GROUND_PARS = /* glsl */ `
uniform sampler2D uDetail;
uniform vec2 uPark;
uniform float uDusk;
varying vec3 vGround;
vec3 gsrgb( float r, float g, float b ) { return pow( vec3( r, g, b ), vec3( 2.2 ) ); }`;

/**
 * Street ground: 80 m grid (16 m streets, 3 m sidewalks), double yellow centre lines, dashed lane lines,
 * zebra crossings before every intersection, paving in the blocks, grass in the park, stone quays at the river.
 */
const GROUND_FRAGMENT = /* glsl */ `
vec2 p = vGround.xz;
vec2 q = p + ${CITY_HALF.toFixed(1)};
vec2 l = mod( q, 80.0 );
vec2 dc = min( l, 80.0 - l );
float dist = length( vViewPosition );
float aa = max( fwidth( p.x ), fwidth( p.y ) );
float grain = texture2D( uDetail, p * 0.37 ).r;
float macro = texture2D( uDetail, p * 0.011 ).a;
bool stX = dc.x < 8.0;
bool stZ = dc.y < 8.0;
float reach = max( abs( p.x ), abs( p.y ) );
vec3 asphalt = gsrgb( 0.2, 0.205, 0.21 ) * ( 0.78 + 0.35 * grain ) * ( 0.85 + 0.3 * macro );
vec3 paving = gsrgb( 0.58, 0.56, 0.52 ) * ( 0.85 + 0.25 * grain );
vec3 col;
float rough = 0.9;
if ( vGround.y < -0.25 || abs( p.x - ${CITY_RIVER.x.toFixed(1)} ) < ${(CITY_RIVER.halfWidth + 6).toFixed(1)} ) {
  // quays and the embankment down to the water
  col = gsrgb( 0.5, 0.48, 0.44 ) * ( 0.75 + 0.35 * grain ) * ( vGround.y < -0.25 ? 0.7 : 1.0 );
} else if ( reach > 1820.0 ) {
  col = gsrgb( 0.36, 0.42, 0.24 ) * ( 0.75 + 0.4 * macro ) * ( 0.85 + 0.3 * grain );
} else if ( stX || stZ ) {
  col = asphalt;
  rough = 0.8;
  if ( !( stX && stZ ) ) {
    float across = stX ? dc.x : dc.y;
    float along = stX ? p.y : p.x;
    float side = stX ? dc.y : dc.x;
    float paint = 0.0;
    // double yellow centre
    float y1 = 1.0 - smoothstep( 0.07 - aa, 0.07 + aa, abs( across - 0.18 ) );
    // dashed lane lines between the two lanes of each direction
    float dash = step( 0.5, fract( along / 9.0 ) );
    float lane = ( 1.0 - smoothstep( 0.06 - aa, 0.06 + aa, abs( across - 3.9 ) ) ) * dash;
    // zebra crossing just outside the intersection, stripes along the traffic
    float zebraBand = step( 8.6, side ) * step( side, 12.2 );
    float zebra = zebraBand * step( 0.5, fract( ( stX ? p.x : p.y ) / 1.1 ) ) * step( across, 7.2 );
    // stop line before the crossing on the incoming lanes
    float stop = step( 12.6, side ) * step( side, 13.0 ) * step( 0.4, across ) * step( across, 7.2 );
    vec3 white = gsrgb( 0.86, 0.85, 0.8 );
    vec3 yellow = gsrgb( 0.85, 0.66, 0.16 );
    float inCity = step( reach, ${(CITY_HALF + 8).toFixed(1)} );
    col = mix( col, yellow, y1 );
    col = mix( col, white, max( max( lane, zebra ), stop ) * mix( 0.6, 1.0, inCity ) );
    paint = max( max( y1, lane ), max( zebra, stop ) );
    rough = mix( rough, 0.6, paint );
  } else {
    col *= 0.94;
  }
} else if ( dc.x < 11.0 || dc.y < 11.0 ) {
  // sidewalk with a curb and 1.5 m paving joints
  float curb = min( dc.x, dc.y );
  vec2 j = abs( fract( p / 1.5 ) - 0.5 );
  float joint = 1.0 - smoothstep( 0.47, 0.5, max( j.x, j.y ) ) * 0.15;
  col = paving * joint * ( curb < 8.35 ? 1.18 : 1.0 );
} else {
  vec2 bi = floor( q / 80.0 );
  if ( all( equal( bi, uPark ) ) ) {
    col = gsrgb( 0.3, 0.45, 0.2 ) * ( 0.75 + 0.45 * grain ) * ( 0.85 + 0.3 * macro );
    // gravel paths across the park
    float path = min( abs( l.x - 40.0 ), abs( l.y - 40.0 ) );
    col = mix( col, gsrgb( 0.62, 0.56, 0.45 ), 1.0 - smoothstep( 1.4, 1.8, path ) );
    rough = 0.95;
  } else {
    vec2 j = abs( fract( p / 3.0 ) - 0.5 );
    col = paving * 0.92 * ( 1.0 - ( 1.0 - smoothstep( 0.46, 0.5, max( j.x, j.y ) ) ) * -0.1 );
  }
}
diffuseColor.rgb = col;`;

/** the ground height the street mesh follows (the river channel) */
export interface GroundField {
  heightAt(x: number, z: number): number;
}

/** Aircraft warning light on the antenna tip: 1 s red flash every 2 s, phase per antenna. */
const ANTENNA_BLINK = /* glsl */ `
if ( vAntY > 0.94 ) {
  float on = step( 0.5, fract( uTime * 0.5 + vTint ) );
  diffuseColor.rgb = vec3( 0.25, 0.02, 0.02 );
  totalEmissiveRadiance += vec3( 3.0, 0.12, 0.05 ) * on;
}`;

/** Street lamps glow at dusk (the lamp is the LAMP_HEX vertex colour). */
const LAMP_GLOW = /* glsl */ `
if ( distance( vColor.rgb, pow( vec3( ${((LAMP_HEX >> 16) & 255) / 255}, ${((LAMP_HEX >> 8) & 255) / 255}, ${(LAMP_HEX & 255) / 255} ), vec3( 2.2 ) ) ) < 0.05 ) {
  totalEmissiveRadiance += vec3( 1.0, 0.82, 0.55 ) * ( 0.15 + 2.5 * uDusk );
}`;

/** Car bodies (white in the model) take the instance colour packed in the tint. */
const CAR_PAINT = /* glsl */ `
if ( vColor.r > 0.98 && vColor.g > 0.98 && vColor.b > 0.98 ) {
  float c = vTint;
  vec3 paint = vec3( floor( c / 65536.0 ), mod( floor( c / 256.0 ), 256.0 ), mod( c, 256.0 ) ) / 255.0;
  diffuseColor.rgb = pow( paint, vec3( 2.2 ) );
}`;

export interface CityViewOptions {
  /** share of the outskirts drawn (profile.outskirts), 0..1 */
  outskirts: number;
  facadeDetail: boolean;
}

export class CityView {
  readonly group = new THREE.Group();
  readonly buildings: InstanceLayer;
  private readonly props: InstanceLayer[];
  private readonly ground: THREE.Mesh;
  private readonly owned: { dispose(): void }[] = [];
  private readonly dusk = { value: 0 };
  private readonly lit = { value: 1 };
  private readonly city: City;
  private readonly outskirts: Outskirts;
  private readonly furniture: CityFurniture;

  constructor(city: City, outskirts: Outskirts, furniture: CityFurniture, field: GroundField, detail: THREE.Texture, shared: InstanceUniforms, opts: CityViewOptions) {
    this.group.name = 'city';
    this.lit.value = opts.facadeDetail ? 1 : 0;
    this.city = city;
    this.outskirts = outskirts;
    this.furniture = furniture;
    const box = unitBox(0xffffff);
    const { material, depth } = instancedMaterials(
      {
        key: 'facade',
        roughness: 0.85,
        vertexPars: 'varying vec3 vFLocal;\nvarying vec3 vFN;\nvarying vec3 vFSize;\nvarying float vFBase;',
        vertex: FACADE_VERTEX,
        fragmentPars: FACADE_PARS,
        fragment: FACADE_FRAGMENT,
        afterRoughness: 'roughnessFactor = fRough;',
        afterMetalness: 'metalnessFactor = fMetal;',
        afterLightMaps: '#if defined( RE_IndirectSpecular )\n  radiance *= fRefl;\n#endif',
        uniforms: { uDusk: this.dusk, uLit: this.lit, uDetail: { value: detail } },
      },
      shared,
    );
    this.buildings = new InstanceLayer(box, material, depth, 'buildings');
    this.owned.push(box, material, depth);
    this.group.add(this.buildings.mesh);
    this.setOutskirts(opts.outskirts);

    const mkProps = (model: THREE.BufferGeometry, key: string, extra: { fragment?: string; fragmentPars?: string; vertex?: string; vertexPars?: string; shadow?: boolean } = {}): InstanceLayer => {
      const m = instancedMaterials({ key, roughness: 0.7, ...extra, uniforms: { uDusk: this.dusk } }, shared);
      const layer = new InstanceLayer(model, m.material, extra.shadow === false ? null : m.depth, key);
      this.owned.push(model, m.material, m.depth);
      this.group.add(layer.mesh);
      return layer;
    };
    this.props = [
      mkProps(unitBox(0x9a9c9e), 'roof-ac'),
      mkProps(unitCylinder(0x8a7a66, 6), 'roof-tank'),
      mkProps(unitBox(0xb8b8b8), 'roof-antenna', { vertexPars: 'varying float vAntY;', vertex: 'vAntY = position.y;', fragmentPars: 'uniform float uTime;\nvarying float vAntY;', fragment: ANTENNA_BLINK }),
      mkProps(streetLightModel(), 'street-lights', { fragmentPars: 'uniform float uDusk;', fragment: LAMP_GLOW }),
      mkProps(carModel(), 'cars', { fragment: CAR_PAINT }),
      mkProps(unitBox(0xb4ada0), 'kerbs', { shadow: false }),
    ];
    for (const l of this.props) l.begin();
    const rp = city.roofProps;
    for (let k = 0; k < rp.length; k += ROOF_PROP_STRIDE) {
      const kind = Math.min(2, Math.max(0, rp[k]! | 0));
      // tint: the antenna's blink phase
      this.props[kind]!.push(rp[k + 1]!, rp[k + 2]!, rp[k + 3]!, 0, rp[k + 4]!, rp[k + 5]!, rp[k + 6]!, (rp[k + 1]! * 0.137 + rp[k + 3]! * 0.071) % 1);
    }
    for (const l of this.props) l.end();
    this.setFurniture(Infinity, 0, 0);

    this.ground = new THREE.Mesh(cityGroundGeometry(field), groundMaterial(detail, city, this.dusk));
    this.ground.name = 'city-ground';
    this.ground.receiveShadow = true;
    this.owned.push(this.ground.geometry, this.ground.material as THREE.Material);
    this.group.add(this.ground);
  }

  /** Rebuilds the building instances: the city plus the nearest `share` of the outskirts. */
  setOutskirts(share: number): void {
    const b = this.buildings;
    b.begin();
    const c = this.city;
    const pushAll = (arr: Float32Array, n: number, outskirts: boolean): void => {
      for (let i = 0; i < n; i++) {
        const k = i * BUILDING_STRIDE;
        const kind = outskirts ? BUILDING_KIND.outskirts : arr[k + 7]! === 1 ? BUILDING_KIND.slab : BUILDING_KIND.building;
        b.push(arr[k]!, arr[k + 1]!, arr[k + 2]!, 0, arr[k + 3]!, arr[k + 4]!, arr[k + 5]!, kind * KIND_SHIFT + ((arr[k + 6]! | 0) % KIND_SHIFT));
      }
    };
    pushAll(c.buildings, c.buildings.length / BUILDING_STRIDE, false);
    const sb = c.skybridges;
    for (let k = 0; k < sb.length; k += 6) {
      b.push(sb[k]!, sb[k + 1]! - sb[k + 4]! / 2, sb[k + 2]!, 0, sb[k + 3]!, sb[k + 4]!, sb[k + 5]!, BUILDING_KIND.skybridge * KIND_SHIFT + k);
    }
    const no = this.outskirts.buildings.length / BUILDING_STRIDE;
    pushAll(this.outskirts.buildings, Math.round(no * Math.min(1, Math.max(0, share))), true);
    b.end();
  }

  /**
   * Street lights, parked cars and kerbs within `range` of (x, z). Everything the drone can reach is drawn: on the
   * Quest tier the range sits inside the fog, and the view refills as the drone moves.
   */
  setFurniture(range: number, x: number, z: number, kerbsOn = true): void {
    const [, , , lights, cars, kerbs] = this.props as [InstanceLayer, InstanceLayer, InstanceLayer, InstanceLayer, InstanceLayer, InstanceLayer];
    for (const l of [lights, cars, kerbs]) l.begin();
    const r2 = range * range;
    const near = (px: number, pz: number): boolean => (px - x) * (px - x) + (pz - z) * (pz - z) <= r2;
    const f = this.furniture;
    for (let k = 0; k < f.lights.length; k += LIGHT_STRIDE) if (near(f.lights[k]!, f.lights[k + 1]!)) lights.push(f.lights[k]!, 0, f.lights[k + 1]!, f.lights[k + 2]!, 1, 1, 1, 0);
    for (let k = 0; k < f.cars.length; k += CAR_STRIDE) if (near(f.cars[k]!, f.cars[k + 2]!)) cars.push(f.cars[k]!, f.cars[k + 1]!, f.cars[k + 2]!, f.cars[k + 3]!, 1, 1, 1, f.cars[k + 4]!);
    if (kerbsOn) for (let k = 0; k < f.kerbs.length; k += KERB_STRIDE) if (near(f.kerbs[k]!, f.kerbs[k + 1]!)) kerbs.push(f.kerbs[k]!, 0, f.kerbs[k + 1]!, f.kerbs[k + 3]!, 0.3, 0.15, f.kerbs[k + 2]!, 0);
    for (const l of [lights, cars, kerbs]) l.end();
  }

  /** Quest: no lit windows (07 §7). */
  setFacadeDetail(on: boolean): void {
    this.lit.value = on ? 1 : 0;
  }

  /** 0 by day .. 1 at dusk: lit windows and storefronts. */
  setDusk(k: number): void {
    this.dusk.value = k;
  }

  /** park and street trees (absolute coordinates) for the shared tree instancing */
  get trees(): Float32Array {
    const a = this.city.trees;
    const b = this.furniture.trees;
    const out = new Float32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  dispose(): void {
    this.buildings.dispose();
    for (const l of this.props) l.dispose();
    for (const d of this.owned) d.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

function groundMaterial(detail: THREE.Texture, city: City, dusk: { value: number }): THREE.MeshStandardMaterial {
  let park = new THREE.Vector2(-99, -99);
  for (let j = 0; j < CITY_BLOCKS; j++) for (let i = 0; i < CITY_BLOCKS; i++) if (city.blockClass(i, j) === 'park') park = new THREE.Vector2(i, j);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 0.4 });
  m.name = 'city-ground';
  m.onBeforeCompile = (s) => {
    s.uniforms.uDetail = { value: detail };
    s.uniforms.uPark = { value: park };
    s.uniforms.uDusk = dusk;
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGround;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vGround = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>\n${GROUND_PARS}`).replace('#include <color_fragment>', `#include <color_fragment>\n${GROUND_FRAGMENT}`);
  };
  m.customProgramCacheKey = () => 'city-ground-v1';
  return m;
}

/** Ground grid over ±OUTSKIRTS: coarse rows along z, fine columns across the river channel's banks. */
export function cityGroundGeometry(field: GroundField, reach = 2600): THREE.BufferGeometry {
  const xs: number[] = [];
  const r = CITY_RIVER;
  const bank0 = r.x - r.halfWidth - 8;
  const bank1 = r.x + r.halfWidth + 8;
  for (let x = -reach; x < bank0; x += 100) xs.push(x);
  for (let x = bank0; x <= bank1; x += 2) xs.push(x);
  for (let x = Math.ceil(bank1 / 100) * 100; x <= reach; x += 100) xs.push(x);
  const zs: number[] = [];
  for (let z = -reach; z <= reach; z += 100) zs.push(z);
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const nor = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const v = j * nx + i;
      const x = xs[i]!;
      const y = field.heightAt(x, 0);
      pos[v * 3] = x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = zs[j]!;
      const e = 0.5;
      const gx = (field.heightAt(x + e, 0) - field.heightAt(x - e, 0)) / (2 * e);
      const l = Math.sqrt(gx * gx + 1);
      nor[v * 3] = -gx / l;
      nor[v * 3 + 1] = 1 / l;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** The river surface across the whole ground (x = channel, z = ±reach). */
export function cityRiverGeometry(reach = 2600): THREE.BufferGeometry {
  const r = CITY_RIVER;
  const g = new THREE.PlaneGeometry(r.halfWidth * 2, reach * 2, 1, 8);
  g.rotateX(-Math.PI / 2);
  g.translate(r.x, r.level, 0);
  return g;
}
