/**
 * Wind gusts that travel across the land (docs/12): broad bands moving downwind at ~12 m/s, their fronts bent by a
 * slow cross-wind wave. The same field drives the Training grass (stronger bend, a lighter sheen where the blades
 * lie over), every swaying tree and bush (wind patch), and the meadow / crop colour of the generated worlds (the
 * terrain's `gust` sheen) — so one gust visibly rolls through grass, crops and treelines together.
 */
import * as THREE from 'three';

/** GLSL: gust strength 0..1 at world xz `p` for unit wind `w` at time `t`. */
export const GUST_GLSL = /* glsl */ `
float lifeGust( vec2 p, vec2 w, float t ) {
  vec2 q = vec2( dot( p, w ), dot( p, vec2( -w.y, w.x ) ) );
  float a = sin( q.x * 0.045 - t * 0.55 + sin( q.y * 0.013 + t * 0.07 ) * 2.2 );
  float b = sin( q.x * 0.071 - t * 0.83 + q.y * 0.021 + 1.7 );
  return smoothstep( 0.3, 1.0, a * 0.65 + b * 0.35 );
}`;

/** The same field on the CPU (tests, the windsock). */
export function gustAt(x: number, z: number, wx: number, wz: number, t: number): number {
  const qx = x * wx + z * wz;
  const qy = -x * wz + z * wx;
  const a = Math.sin(qx * 0.045 - t * 0.55 + Math.sin(qy * 0.013 + t * 0.07) * 2.2);
  const b = Math.sin(qx * 0.071 - t * 0.83 + qy * 0.021 + 1.7);
  const v = a * 0.65 + b * 0.35;
  const k = Math.min(1, Math.max(0, (v - 0.3) / 0.7));
  return k * k * (3 - 2 * k);
}

/**
 * Shared uniforms of the terrain's gust sheen (one level is drawn at a time; its view writes them every frame):
 * clock, unit wind direction (x, z), and the floating origin the ground is drawn relative to.
 */
export const TERRAIN_GUST = {
  uGustTime: { value: 0 },
  uGustWind: { value: new THREE.Vector2(1, 0) },
  uGustOrigin: { value: new THREE.Vector2(0, 0) },
};
