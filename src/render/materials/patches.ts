/**
 * Shader patches for the library's MeshStandardMaterial / MeshPhysicalMaterial (one onBeforeCompile per
 * material, features switched by defines so each combination is one program):
 *
 * - `box`      box-projected environment reflections (room-sized probe, floor and glass)
 * - `macro`    world-space floor macro map (stains, wax, puddles)
 * - `grime`    wall grime rising off the floor and soot under the ceiling
 * - `paint`    limewash over the base maps, chipped by noise (painted brick)
 * - `detail`   the albedo map becomes a neutral detail layer: divided by its own mean colour (its smallest
 *              mip), so vertex colours keep the palette and a scanned or procedural set only adds texture
 * - `overlay`  an RGBA picture laid on a world-space XZ rectangle (landing-pad markings over asphalt)
 * - `stripes`  view-dependent mowing stripes
 * - `terrain`  triplanar rock on a per-vertex weight (two scales, tinted, bump-mapped), wet banks on another,
 *              bare-earth soil detail and smoother snow by the vertex colour (see `MaterialLibrary.terrain`)
 * - `vertexRM` per-vertex roughness / metalness (`aRM`) for merged prop materials
 * - `glass`    premultiplied dirty glass: reflections stay at full strength while the body fades
 * - `wind`     sway by the per-vertex `aSway` (metres), optional leaf flutter
 *
 * Every division and normalisation is guarded: one NaN pixel spread by the bloom blur blacks out whole
 * blocks of the frame.
 */
import * as THREE from 'three';
import { GUST_GLSL, TERRAIN_GUST } from '../life/gust';

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

export interface PaintCoat {
  /** linear paint colour */
  color: THREE.Color;
  /** tileable noise (G channel) that decides where the paint has chipped */
  texture: THREE.Texture;
  /** noise repeats per metre (world space) */
  scale: number;
  /** 0..1 share of the wall still painted */
  coverage: number;
  /** roughness of the paint film */
  roughness: number;
}

export interface WindUniforms {
  uTime: THREE.IUniform<number>;
  uWind: THREE.IUniform<THREE.Vector2>;
}

export interface TerrainLayer {
  albedo: THREE.Texture;
  arm: THREE.Texture;
  /** world metres per tile */
  tileMeters: number;
}

export interface TerrainPatch {
  rock: TerrainLayer;
  /** float attribute (0..1) that blends to rock; null: no rock */
  rockAttribute: string | null;
  /** float attribute (0..1) of wetness (darker, glossier banks); null: dry */
  wetAttribute: string | null;
  /** above this world-normal steepness (1 − n.y) rock shows even without the attribute; > 1 disables */
  slopeRock: number;
  /** linear colour the rock layer is normalised to (the map only brings its detail); absent: the map's own colour */
  rockTint?: THREE.Color;
  /** second, coarser triplanar rock sample (tile metres): breaks the repeat on mountain faces seen from afar */
  rockMacroMeters?: number;
  /** soil detail where the vertex colour is bare earth (redder than green: fields, tracks) and on wet banks */
  soil?: TerrainLayer;
  /** vertex colours are sRGB bytes (the world engine's palette): linearised in the vertex shader */
  srgbColors?: boolean;
  /** the whitest vertex colours read as snow: less grain, smoother, no rock */
  snow?: boolean;
  /** the base maps take world XZ (metres) instead of the geometry's UVs (heightfield chunks carry none) */
  worldUv?: boolean;
  /** travelling wind gusts brighten meadow and crops (TERRAIN_GUST uniforms, docs/12) */
  gust?: boolean;
}

export interface EnvPatch {
  box?: BoxProjection;
  macro?: MacroMap;
  grime?: WallGrime;
  paint?: PaintCoat;
  /** true, or the share of the map's luminance contrast kept (0..1; 1 = all of it) */
  detail?: boolean | number;
  overlay?: MacroMap;
  stripes?: { half: number; width: number; strength: number };
  terrain?: TerrainPatch;
  /** `aRM` vertex attribute (roughness, metalness) drives the merged prop material */
  vertexRM?: boolean;
  /** transparent glass: reflections stay at full strength while the body fades (premultiplied blending) */
  glass?: { clearAlpha: number; dirtRoughness: number };
  wind?: { uniforms: WindUniforms; flutter: boolean };
  /** travelling wind gusts brighten meadow and crop vertex colours (TERRAIN_GUST uniforms, docs/12) */
  gust?: boolean;
}

const VERT_HEAD = /* glsl */ `
varying vec3 vEnvWorld;
#ifdef ENV_VERTEX_RM
attribute vec2 aRM;
varying vec2 vRM;
#endif
#ifdef ENV_WIND
attribute float aSway;
uniform float uTime;
uniform vec2 uWind;
${GUST_GLSL}
#endif
#ifdef ENV_TERRAIN
varying vec3 vEnvWorldN;
varying vec2 vTerrain;
#ifdef ENV_ROCK_ATTR
attribute float ENV_ROCK_ATTR;
#endif
#ifdef ENV_WET_ATTR
attribute float ENV_WET_ATTR;
#endif
#endif
`;

const VERT_WIND = /* glsl */ `
#ifdef ENV_WIND
{
  // aSway is in world metres: instanced trees take the wind into their own (scaled, turned) frame and
  // a phase from their position, so a treeline does not sway in lockstep
  float ph = dot( transformed.xz, vec2( 0.11, 0.07 ) );
  #ifdef USE_INSTANCING
  ph += dot( instanceMatrix[3].xz, vec2( 0.11, 0.07 ) );
  vec3 windLocal = inverse( mat3( instanceMatrix ) ) * vec3( uWind.x, 0.0, uWind.y );
  #else
  vec3 windLocal = vec3( uWind.x, 0.0, uWind.y );
  #endif
  float gust = sin( uTime * 1.25 + ph ) * 0.55 + sin( uTime * 2.3 + ph * 1.7 ) * 0.25 + 0.4;
  // travelling gusts (docs/12): a band rolling downwind leans the whole treeline further
  #ifdef USE_INSTANCING
  vec2 gustAt = instanceMatrix[3].xz;
  #else
  vec2 gustAt = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;
  #endif
  gust *= 1.0 + 1.3 * lifeGust( gustAt, uWind, uTime );
  transformed += windLocal * gust * aSway;
  #ifdef ENV_FLUTTER
  transformed += vec3( sin( uTime * 8.0 + ph * 13.0 ), sin( uTime * 6.3 + ph * 11.0 ) * 0.6, cos( uTime * 7.1 + ph * 9.0 ) ) * 0.06 * aSway;
  #endif
}
#endif
`;

const VERT_COLOR = /* glsl */ `
#if defined( ENV_SRGB_COLOR ) && defined( USE_COLOR )
vColor.rgb = pow( vColor.rgb, vec3( 2.2 ) );
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
#ifdef ENV_WORLD_UV
#ifdef USE_MAP
vMapUv = ( mapTransform * vec3( vEnvWorld.xz, 1.0 ) ).xy;
#endif
#ifdef USE_NORMALMAP
vNormalMapUv = ( normalMapTransform * vec3( vEnvWorld.xz, 1.0 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
vRoughnessMapUv = ( roughnessMapTransform * vec3( vEnvWorld.xz, 1.0 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
vMetalnessMapUv = ( metalnessMapTransform * vec3( vEnvWorld.xz, 1.0 ) ).xy;
#endif
#ifdef USE_AOMAP
vAoMapUv = ( aoMapTransform * vec3( vEnvWorld.xz, 1.0 ) ).xy;
#endif
#endif
#ifdef ENV_TERRAIN
vEnvWorldN = normalize( mat3( modelMatrix ) * objectNormal );
vTerrain = vec2( 0.0 );
#ifdef ENV_ROCK_ATTR
vTerrain.x = ENV_ROCK_ATTR;
#endif
#ifdef ENV_WET_ATTR
vTerrain.y = ENV_WET_ATTR;
#endif
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
#if defined( ENV_GRIME ) || defined( ENV_PAINT )
uniform sampler2D uGrime;
uniform float uGrimeScale;
#endif
#ifdef ENV_GRIME
uniform float uGrimeLow;
uniform float uGrimeTop;
#endif
#ifdef ENV_PAINT
uniform vec3 uPaintColor;
uniform float uPaintScale;
uniform float uPaintCover;
uniform float uPaintRough;
float envPaint = 0.0;
#endif
#ifdef ENV_OVERLAY
uniform sampler2D uOverlay;
uniform vec2 uOverlayMin;
uniform vec2 uOverlaySize;
float envOverlay = 0.0;
#endif
#ifdef ENV_STRIPES
uniform float uStripeHalf;
uniform float uStripeW;
uniform float uStripeK;
#endif
#ifdef ENV_GUST
uniform float uGustTime;
uniform vec2 uGustWind;
uniform vec2 uGustOrigin;
${GUST_GLSL}
#endif
#ifdef ENV_TERRAIN
varying vec3 vEnvWorldN;
varying vec2 vTerrain;
uniform sampler2D uRockMap;
uniform sampler2D uRockArm;
uniform float uRockScale;
uniform float uSlopeRock;
float envRock = 0.0;
float envRockH = 0.5;
float envSnow = 0.0;
#ifdef ENV_ROCK_TINT
uniform vec3 uRockTint;
#endif
#ifdef ENV_ROCK_MACRO
uniform float uRockMacro;
#endif
#ifdef ENV_SOIL
uniform sampler2D uSoilMap;
uniform float uSoilScale;
#endif
// screen-space bump from a height in metres (three's perturbNormalArb without a bump map)
vec3 envBump( vec3 p, vec3 n, float h ) {
  vec3 sx = dFdx( p );
  vec3 sy = dFdy( p );
  vec3 r1 = cross( sy, n );
  vec3 r2 = cross( n, sx );
  float det = dot( sx, r1 ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  vec3 grad = sign( det ) * ( dFdx( h ) * r1 + dFdy( h ) * r2 );
  vec3 bn = abs( det ) * n - grad;
  float l = length( bn );
  return l > 1e-6 ? bn / l : n;
}
vec3 envTriplanar( sampler2D tex, vec3 p, vec3 n ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= max( w.x + w.y + w.z, 1e-4 );
  return texture2D( tex, p.zy ).rgb * w.x + texture2D( tex, p.xz ).rgb * w.y + texture2D( tex, p.xy ).rgb * w.z;
}
#endif
#ifdef ENV_VERTEX_RM
varying vec2 vRM;
#endif
vec3 envDetailK = vec3( 1.0 );
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
#if defined( ENV_DETAIL ) && defined( USE_MAP )
{
  // the smallest mip is the map's mean colour: what is left is texture, not tint. Mostly its luminance:
  // a scan's dry blades or fallen leaves must not repaint the level's palette
  vec3 dr = sampledDiffuseColor.rgb / max( texture2D( map, vec2( 0.5 ), 16.0 ).rgb, vec3( 0.03 ) );
  envDetailK = mix( vec3( 1.0 ), mix( vec3( dot( dr, vec3( 0.2126, 0.7152, 0.0722 ) ) ), dr, 0.3 ), ENV_DETAIL );
  diffuseColor.rgb = diffuse * envDetailK;
}
#endif
#if defined( ENV_PAINT ) && defined( USE_MAP )
{
  float pn = texture2D( uGrime, vec2( vEnvWorld.x + vEnvWorld.z, vEnvWorld.y ) * uPaintScale ).g;
  float pn2 = texture2D( uGrime, vec2( vEnvWorld.x - vEnvWorld.z, vEnvWorld.y ) * uPaintScale * 3.7 ).g;
  envPaint = smoothstep( 1.0 - uPaintCover - 0.06, 1.0 - uPaintCover + 0.06, pn * 0.7 + pn2 * 0.3 );
  // brick faces are saturated, mortar is grey: the coat stays a shade darker in the joints and each
  // brick keeps a ghost of its own tone, so the courses read through the limewash
  vec3 under = diffuseColor.rgb;
  float hi = max( max( under.r, under.g ), under.b );
  float lo = min( min( under.r, under.g ), under.b );
  float sat = hi > 1e-4 ? ( hi - lo ) / hi : 0.0;
  float face = smoothstep( 0.18, 0.42, sat );
  float ghost = clamp( hi / max( texture2D( map, vec2( 0.5 ), 16.0 ).r, 0.02 ), 0.6, 1.4 );
  vec3 coat = uPaintColor * mix( 0.6, 1.0, face ) * mix( 1.0, ghost, 0.25 * face ) * ( 0.95 + 0.1 * pn2 );
  diffuseColor.rgb = mix( diffuseColor.rgb, coat, envPaint );
}
#endif
#ifdef ENV_OVERLAY
{
  vec2 ouv = ( vEnvWorld.xz - uOverlayMin ) / uOverlaySize;
  vec4 o = texture2D( uOverlay, clamp( ouv, 0.0, 1.0 ) );
  envOverlay = o.a * step( 0.0, ouv.x ) * step( ouv.x, 1.0 ) * step( 0.0, ouv.y ) * step( ouv.y, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, o.rgb, envOverlay );
}
#endif
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

const AFTER_COLOR = /* glsl */ `
#ifdef ENV_STRIPES
{
  vec2 toEye = cameraPosition.xz - vEnvWorld.xz;
  float len = length( toEye );
  float facing = len > 1e-3 ? toEye.y / len : 0.0;
  float parity = mod( floor( ( vEnvWorld.x + uStripeHalf ) / uStripeW ), 2.0 ) * 2.0 - 1.0;
  float inside = step( abs( vEnvWorld.x ), uStripeHalf ) * step( abs( vEnvWorld.z ), uStripeHalf );
  diffuseColor.rgb *= 1.0 + uStripeK * parity * facing * inside;
}
#endif
#ifdef ENV_TERRAIN
{
  vec3 tn = normalize( vEnvWorldN );
  float envDist = length( vViewPosition );
  float wet = clamp( vTerrain.y, 0.0, 1.0 );
  #if defined( ENV_SNOW ) && defined( USE_COLOR )
  envSnow = smoothstep( 0.5, 0.72, min( vColor.r, vColor.b ) );
  // snow keeps a third of the grain
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuse * vColor.rgb * mix( vec3( 1.0 ), envDetailK, 0.35 ), envSnow );
  #endif
  #if defined( ENV_SOIL ) && defined( USE_COLOR )
  {
    // bare earth: a darker vertex colour redder than it is green (ploughed fields, tracks, garden beds; not the
    // bright crops), and the wet banks
    float earth = smoothstep( 0.95, 0.85, vColor.g / max( vColor.r, 1e-3 ) ) * ( 1.0 - smoothstep( 0.18, 0.27, dot( vColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ) );
    float soilW = max( earth, wet * 0.85 ) * ( 1.0 - envSnow );
    if ( soilW > 0.002 ) {
      vec3 sr = texture2D( uSoilMap, vEnvWorld.xz * uSoilScale ).rgb / max( texture2D( uSoilMap, vec2( 0.5 ), 16.0 ).rgb, vec3( 0.03 ) );
      float sl = mix( dot( sr, vec3( 0.2126, 0.7152, 0.0722 ) ), 1.0, 0.25 + 0.75 * smoothstep( 90.0, 420.0, envDist ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, diffuse * vColor.rgb * sl, soilW );
    }
  }
  #endif
  // the generator's weight carries ±0.25 of noise even on flat ground: only what rises above it is rock
  envRock = clamp( max( smoothstep( 0.25, 0.6, vTerrain.x ), smoothstep( uSlopeRock, uSlopeRock + 0.15, 1.0 - tn.y ) ), 0.0, 1.0 ) * ( 1.0 - envSnow * 0.9 );
  if ( envRock > 0.002 ) {
    vec3 rmean = max( texture2D( uRockMap, vec2( 0.5 ), 16.0 ).rgb, vec3( 0.03 ) );
    vec3 rock = envTriplanar( uRockMap, vEnvWorld * uRockScale, tn );
    #ifdef ENV_ROCK_MACRO
    {
      // the coarse sample carries the face from afar; the fine one adds texture near the drone, then fades
      vec3 rockM = envTriplanar( uRockMap, vEnvWorld * uRockMacro, tn );
      rock = mix( rockM * ( rock / rmean ), rockM, smoothstep( 80.0, 360.0, envDist ) );
    }
    #endif
    envRockH = dot( rock / rmean, vec3( 0.333 ) ) * 0.5;
    #ifdef ENV_ROCK_TINT
    {
      // the scan's contrast pushed a little (a mountain face reads from a kilometre away), tinted to the level
      vec3 rr = pow( max( rock / rmean, vec3( 0.0 ) ), vec3( 1.45 ) );
      vec3 tint = uRockTint;
      #ifdef USE_COLOR
      tint = mix( tint, vColor.rgb, 0.12 );
      #endif
      rock = tint * mix( vec3( dot( rr, vec3( 0.2126, 0.7152, 0.0722 ) ) ), rr, 0.45 );
    }
    #endif
    diffuseColor.rgb = mix( diffuseColor.rgb, rock, envRock );
  }
  diffuseColor.rgb *= mix( 1.0, 0.55, wet );
}
#endif
#if defined( ENV_GUST ) && defined( USE_COLOR )
{
  // a gust rolling over meadow and crops: the bent blades / ears show their paler side (docs/12)
  float green = smoothstep( 0.9, 1.15, vColor.g / max( vColor.r, 1e-3 ) ) + smoothstep( 0.3, 0.55, vColor.r + vColor.g - 2.0 * vColor.b ) * 0.6;
  float crop = clamp( green, 0.0, 1.0 );
  #ifdef ENV_TERRAIN
  crop *= ( 1.0 - envRock ) * ( 1.0 - envSnow ) * ( 1.0 - clamp( vTerrain.y, 0.0, 1.0 ) );
  #endif
  float g = lifeGust( vEnvWorld.xz + uGustOrigin, uGustWind, uGustTime ) * ( 1.0 - smoothstep( 250.0, 700.0, length( vViewPosition ) ) );
  diffuseColor.rgb *= 1.0 + 0.16 * g * crop;
}
#endif
`;

const AFTER_ROUGH = /* glsl */ `
#ifdef ENV_MACRO
roughnessFactor = mix( clamp( roughnessFactor + ( envMacro.g - 0.5 ), 0.04, 1.0 ), 0.06, envMacro.b );
#endif
#if defined( ENV_PAINT ) && defined( USE_MAP )
roughnessFactor = mix( roughnessFactor, uPaintRough, envPaint );
#endif
#ifdef ENV_OVERLAY
roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.85, envOverlay );
#endif
#ifdef ENV_TERRAIN
if ( envRock > 0.002 ) roughnessFactor = mix( roughnessFactor, envTriplanar( uRockArm, vEnvWorld * uRockScale, normalize( vEnvWorldN ) ).g, envRock );
roughnessFactor = mix( roughnessFactor, 0.12, clamp( vTerrain.y, 0.0, 1.0 ) );
roughnessFactor = mix( roughnessFactor, 0.55, envSnow );
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
#ifdef ENV_TERRAIN
{
  // rock and standing water flatten the grass normal map; the rock gets its own relief from its height
  vec3 flatN = normalize( vNormal );
  normal = normalize( mix( normal, flatN, max( envRock, clamp( vTerrain.y, 0.0, 1.0 ) ) * 0.85 ) );
  if ( envRock > 0.002 ) {
    float near = 1.0 - smoothstep( 220.0, 900.0, length( vViewPosition ) );
    normal = envBump( -vViewPosition, normal, ( envRockH - 0.5 ) * 1.4 * envRock * near );
  }
}
#endif
`;

const GLASS_OUT = /* glsl */ `
gl_FragColor = vec4( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance, diffuseColor.a );
`;

/** Program cache key of a patch: the feature set (uniform values do not change the program). */
export function patchKey(p: EnvPatch): string {
  const t = p.terrain;
  return [
    'env',
    p.box ? 'b' : '',
    p.macro ? 'm' : '',
    p.grime ? 'g' : '',
    p.paint ? 'p' : '',
    p.detail ? `d${p.detail === true ? 1 : p.detail}` : '',
    p.overlay ? 'o' : '',
    p.stripes ? 's' : '',
    t ? `t${t.rockAttribute ?? ''}:${t.wetAttribute ?? ''}${t.rockTint ? 'k' : ''}${t.rockMacroMeters ? 'm' : ''}${t.soil ? 's' : ''}${t.srgbColors ? 'c' : ''}${t.snow ? 'n' : ''}${t.worldUv ? 'w' : ''}${t.gust ? 'g' : ''}` : '',
    p.vertexRM ? 'v' : '',
    p.glass ? 'gl' : '',
    p.wind ? (p.wind.flutter ? 'wf' : 'w') : '',
    p.gust ? 'G' : '',
  ].join('');
}

/** True when the patch changes nothing (the material keeps three's stock program). */
export function isEmptyPatch(p: EnvPatch): boolean {
  return patchKey(p) === 'env';
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
  if (p.paint) {
    defines.ENV_PAINT = '';
    // grime and paint share the noise sampler (and its scale when both are on)
    uniforms.uGrime ??= { value: p.paint.texture };
    uniforms.uGrimeScale ??= { value: p.paint.scale };
    uniforms.uPaintColor = { value: p.paint.color };
    uniforms.uPaintScale = { value: p.paint.scale };
    uniforms.uPaintCover = { value: p.paint.coverage };
    uniforms.uPaintRough = { value: p.paint.roughness };
  }
  if (p.detail) defines.ENV_DETAIL = (p.detail === true ? 1 : Math.min(1, Math.max(0, p.detail))).toFixed(3);
  if (p.overlay) {
    defines.ENV_OVERLAY = '';
    uniforms.uOverlay = { value: p.overlay.texture };
    uniforms.uOverlayMin = { value: p.overlay.min };
    uniforms.uOverlaySize = { value: p.overlay.size };
  }
  if (p.stripes) {
    defines.ENV_STRIPES = '';
    uniforms.uStripeHalf = { value: p.stripes.half };
    uniforms.uStripeW = { value: p.stripes.width };
    uniforms.uStripeK = { value: p.stripes.strength };
  }
  if (p.terrain) {
    const t = p.terrain;
    defines.ENV_TERRAIN = '';
    if (t.rockAttribute) defines.ENV_ROCK_ATTR = t.rockAttribute;
    if (t.wetAttribute) defines.ENV_WET_ATTR = t.wetAttribute;
    uniforms.uRockMap = { value: t.rock.albedo };
    uniforms.uRockArm = { value: t.rock.arm };
    uniforms.uRockScale = { value: 1 / Math.max(0.01, t.rock.tileMeters) };
    uniforms.uSlopeRock = { value: t.slopeRock };
    if (t.rockTint) {
      defines.ENV_ROCK_TINT = '';
      uniforms.uRockTint = { value: t.rockTint };
    }
    if (t.rockMacroMeters) {
      defines.ENV_ROCK_MACRO = '';
      uniforms.uRockMacro = { value: 1 / Math.max(0.01, t.rockMacroMeters) };
    }
    if (t.soil) {
      defines.ENV_SOIL = '';
      uniforms.uSoilMap = { value: t.soil.albedo };
      uniforms.uSoilScale = { value: 1 / Math.max(0.01, t.soil.tileMeters) };
    }
    if (t.srgbColors) defines.ENV_SRGB_COLOR = '';
    if (t.snow) defines.ENV_SNOW = '';
    if (t.worldUv) defines.ENV_WORLD_UV = '';
  }
  if (p.gust || p.terrain?.gust) {
    defines.ENV_GUST = '';
    Object.assign(uniforms, TERRAIN_GUST);
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
  if (p.wind) {
    defines.ENV_WIND = '';
    if (p.wind.flutter) defines.ENV_FLUTTER = '';
    uniforms.uTime = p.wind.uniforms.uTime;
    uniforms.uWind = p.wind.uniforms.uWind;
  }
  mat.userData.envUniforms = uniforms;
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  const k = patchKey(p);
  mat.customProgramCacheKey = () => k;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_WIND}`)
      .replace('#include <color_vertex>', `#include <color_vertex>\n${VERT_COLOR}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${AFTER_MAP}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${AFTER_COLOR}`)
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
