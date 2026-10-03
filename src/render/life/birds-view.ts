/**
 * Bird flocks on screen: one instanced draw for every bird of the level (pigeons, gulls, crows / swallows), the
 * wings beating in the vertex shader (faster while a flock flees), heading from the velocity, a slight bank into
 * the turn. The flocks themselves are the pure BirdFlocks simulation (src/world/life/birds.ts).
 */
import * as THREE from 'three';
import { BirdFlocks, BIRD_STATE } from '../../world/life/birds';
import type { EmitterSource, LifeEmitter, LifeHub } from '../../world/life/hub';
import { InstanceLayer } from '../outdoor/scatter-view';
import type { InstanceUniforms } from '../outdoor/terrain-materials';
import { animatedMaterials } from './anim-material';
import { GeoBuilder } from './geo';

export const BIRD_KIND = { pigeon: 0, gull: 1, crow: 2, swallow: 3 } as const;

/** One flock family: the simulation and how its birds look. */
export interface BirdGroup {
  sim: BirdFlocks;
  kind: number;
  /** model scale (wingspan ≈ 1.1 m × scale) */
  scale: number;
}

/** Wing beat in the vertex shader: uv.y = 1 on the wings (amplitude grows to the tips), tint = kind + phase / 2 + 0.5 × fleeing. */
const BIRD_PRE = /* glsl */ `
float kindB = floor( aInstB.w );
float frac = aInstB.w - kindB;
float flee = step( 0.5, frac );
float ph = ( frac - 0.5 * flee ) * 2.0;
float rate = ( kindB == 1.0 ? 5.0 : kindB == 3.0 ? 11.0 : 8.0 ) * ( 1.0 + 0.6 * flee );
// gulls and crows glide between beats; pigeons and swallows keep flapping
float beat = sin( ( uTime * rate + ph * 6.2831 ) );
float glide = kindB == 1.0 || kindB == 2.0 ? smoothstep( -0.2, 0.6, sin( uTime * 0.7 + ph * 9.0 ) ) : 0.0;
float flap = beat * mix( 1.0, 0.15, glide * ( 1.0 - flee ) );
float span = abs( p.x );
p.y += flap * uv.y * span * 0.75;
p.x *= 1.0 - abs( flap ) * uv.y * 0.12;`;

const BIRD_COLOR = /* glsl */ `
float kindC = floor( vTint );
vec3 body = kindC == 0.0 ? vec3( 0.32, 0.33, 0.36 ) : kindC == 1.0 ? vec3( 0.92, 0.92, 0.9 ) : kindC == 2.0 ? vec3( 0.05, 0.05, 0.06 ) : vec3( 0.06, 0.07, 0.12 );
vec3 wing = kindC == 0.0 ? vec3( 0.42, 0.43, 0.46 ) : kindC == 1.0 ? vec3( 0.55, 0.58, 0.62 ) : body;
diffuseColor.rgb = mix( body, wing, step( 0.5, vWeight ) ) * diffuseColor.rgb;`;

/** A bird ~1.1 m across: body, head, tail, two wings (each wing two triangles, its tip swept back). */
export function birdModel(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const w = 0xffffff;
  // body: a stretched diamond along +Z (front)
  const nose: [number, number, number] = [0, 0.02, 0.26];
  const tail: [number, number, number] = [0, 0.0, -0.2];
  const top: [number, number, number] = [0, 0.07, 0.02];
  const bot: [number, number, number] = [0, -0.06, 0.02];
  const l: [number, number, number] = [-0.06, 0, 0.02];
  const r: [number, number, number] = [0.06, 0, 0.02];
  g.tri(nose, r, top, w).tri(nose, top, l, w).tri(nose, bot, r, w).tri(nose, l, bot, w);
  g.tri(tail, top, r, w).tri(tail, l, top, w).tri(tail, r, bot, w).tri(tail, bot, l, w);
  // tail fan
  g.tri([0, 0, -0.18], [-0.08, 0, -0.34], [0.08, 0, -0.34], w);
  g.tri([0, 0, -0.18], [0.08, 0, -0.34], [-0.08, 0, -0.34], w);
  // wings (both faces), uv.y = 1: they flap
  for (const s of [-1, 1]) {
    const root0: [number, number, number] = [s * 0.05, 0.02, 0.1];
    const root1: [number, number, number] = [s * 0.05, 0.02, -0.06];
    const mid: [number, number, number] = [s * 0.32, 0.03, 0.04];
    const tip: [number, number, number] = [s * 0.56, 0.01, -0.12];
    for (const flip of [false, true]) {
      const t = (a: [number, number, number], b: [number, number, number], c: [number, number, number]): void => {
        if ((s > 0) !== flip) g.tri(a, b, c, w, 0, 1);
        else g.tri(a, c, b, w, 0, 1);
      };
      t(root0, mid, root1);
      t(root1, mid, tip);
    }
  }
  return g.build();
}

export class BirdsView implements EmitterSource {
  readonly group = new THREE.Group();
  private readonly groups: BirdGroup[];
  private readonly layer: InstanceLayer;
  private readonly owned: { dispose(): void }[] = [];
  private readonly hub: LifeHub | null;
  private readonly c = new Float64Array(3);
  private readonly onScatter: (flock: number) => void;
  private scatterGroup = 0;
  /** world origin of the rendered positions (floating origin) */
  readonly origin = { x: 0, z: 0 };

  constructor(groups: BirdGroup[], shared: InstanceUniforms, hub: LifeHub | null) {
    this.group.name = 'birds';
    this.groups = groups;
    this.hub = hub;
    const model = birdModel();
    const m = animatedMaterials({ key: 'birds', pre: BIRD_PRE, fragment: BIRD_COLOR, roughness: 0.9, side: THREE.DoubleSide }, shared);
    this.layer = new InstanceLayer(model, m.material, null, 'birds');
    this.layer.mesh.castShadow = false;
    this.layer.mesh.receiveShadow = false;
    this.owned.push(model, m.material, m.depth, this.layer);
    this.group.add(this.layer.mesh);
    hub?.addSource(this);
    this.onScatter = (k: number): void => {
      const sim = this.groups[this.scatterGroup]!.sim;
      sim.centre(k, this.c);
      this.hub?.emit('flock-scatter', this.c[0]!, this.c[1]!, this.c[2]!);
    };
  }

  /** birds per flock / flocks drawn (tier budget) */
  setBudget(flocks: number, birds: number): void {
    for (const g of this.groups) {
      g.sim.activeFlocks = Math.max(0, Math.min(g.sim.flocks, flocks));
      g.sim.active = Math.max(1, Math.min(g.sim.perFlock, birds));
    }
  }

  update(dt: number, drone: THREE.Vector3): void {
    this.layer.begin();
    const ox = this.origin.x;
    const oz = this.origin.z;
    for (let gi = 0; gi < this.groups.length; gi++) {
      const { sim, kind, scale } = this.groups[gi]!;
      sim.update(dt, drone.x, drone.y, drone.z);
      this.scatterGroup = gi;
      sim.drainScatters(this.onScatter);
      for (let k = 0; k < sim.activeFlocks; k++) {
        const flee = sim.state[k] === BIRD_STATE.scattered ? 0.5 : 0;
        for (let i = 0; i < sim.active; i++) {
          const b = k * sim.perFlock + i;
          const vx = sim.vx[b]!;
          const vz = sim.vz[b]!;
          const yaw = Math.atan2(vx, vz);
          this.layer.push(sim.x[b]! - ox, sim.y[b]!, sim.z[b]! - oz, yaw, scale, scale, scale, kind + flee + sim.phase[b]! * 0.49);
        }
      }
    }
    this.layer.end();
  }

  collectEmitters(out: LifeEmitter[], n: number): number {
    for (const { sim, kind } of this.groups) {
      for (let k = 0; k < sim.activeFlocks; k++) {
        if (n >= out.length) return n;
        sim.centre(k, this.c);
        const e = out[n++]!;
        e.kind = 'flock';
        e.x = this.c[0]!;
        e.y = this.c[1]!;
        e.z = this.c[2]!;
        e.vx = 0;
        e.vy = 0;
        e.vz = 0;
        e.speed = sim.state[k] === BIRD_STATE.scattered ? 2 : 1;
        e.intensity = sim.state[k] === BIRD_STATE.scattered ? 1 : 0.4;
        e.variant = kind;
      }
    }
    return n;
  }

  get count(): number {
    return this.layer.count;
  }

  dispose(): void {
    this.hub?.removeSource(this);
    this.group.removeFromParent();
    for (const d of this.owned) d.dispose();
    this.group.clear();
  }
}
