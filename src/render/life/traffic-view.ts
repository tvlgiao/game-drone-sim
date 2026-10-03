/**
 * Cars and traffic lights on screen (docs/12). One instanced draw per vehicle type (sedan, hatchback, SUV, van,
 * bus, taxi) — on the low tier one draw for all of them (a generic body stretched per type); the instance carries
 * the pose, the paint index and the brake flag. At dusk the headlights, tail lights, the taxi sign and the bus
 * cabin glow; braking cars flare their tail lights; on high / ultra an additive layer adds the headlight pools and
 * beams and a red glow behind. Traffic lights: the housings (pole, mast arm, heads) in one draw, the lit lamps
 * (state from the SignalPlan) in another, both within range of the drone. Allocation-free per frame.
 */
import * as THREE from 'three';
import { InstanceLayer } from '../outdoor/scatter-view';
import { instancedMaterials, type InstanceUniforms } from '../outdoor/terrain-materials';
import { CAR_FLAG, type TrafficSim } from '../../world/traffic/traffic-sim';
import { PAINT, VEHICLES, VEHICLE_TYPES } from '../../world/traffic/vehicles';
import { SIGNAL, type SignalPlan } from '../../world/traffic/signals';
import { SIGNAL_ARM_Y, SIGNAL_HEAD_ACROSS, SIGNAL_POLE_ACROSS, SIGNAL_POLE_HEIGHT, SIGNAL_SHORT_HEAD_Y, SIGNAL_STRIDE } from '../../world/traffic/city-roads';
import { genericVehicleModel, vehicleModels, VEHICLE_PART } from './vehicle-models';
import { GeoBuilder } from './geo';

/** packed tint: paint index + PAINT_FLAGS × flags */
const PAINT_FLAGS = 16;
const FLAG_BRAKE = 1;

export interface TrafficViewOptions {
  /** one generic model for every type (low tier) */
  generic: boolean;
  /** headlight pools / beams (high, ultra) */
  glow: boolean;
  /** cars cast into the sun cascades (high, ultra) */
  shadows: boolean;
  /** traffic lights drawn within this distance of the drone, m */
  signalRange: number;
}

const VEHICLE_PARS = /* glsl */ `
uniform vec3 uPaint[ ${PAINT.length} ];
uniform float uLights;
varying float vPart;
float vRough;
float vMetal;`;

/** parts → colour, gloss, lamps (vTint: paint index + 16 × flags) */
const VEHICLE_FRAGMENT = /* glsl */ `
float part = floor( vPart + 0.5 );
float paintI = mod( vTint, ${PAINT_FLAGS.toFixed(1)} );
float brake = mod( floor( vTint / ${PAINT_FLAGS.toFixed(1)} ), 2.0 );
vRough = 0.7;
vMetal = 0.0;
vec3 emit = vec3( 0.0 );
if ( part == ${VEHICLE_PART.paint.toFixed(1)} ) {
  diffuseColor.rgb = uPaint[ int( paintI ) ];
  vRough = 0.34;
  vMetal = 0.25;
} else if ( part == ${VEHICLE_PART.glass.toFixed(1)} ) {
  diffuseColor.rgb = vec3( 0.012, 0.016, 0.02 );
  vRough = 0.08;
  vMetal = 0.2;
} else if ( part == ${VEHICLE_PART.cabin.toFixed(1)} ) {
  diffuseColor.rgb = vec3( 0.02, 0.025, 0.03 );
  vRough = 0.1;
  emit = vec3( 1.0, 0.86, 0.62 ) * 0.9 * uLights;
} else if ( part == ${VEHICLE_PART.head.toFixed(1)} ) {
  vRough = 0.2;
  emit = vec3( 1.0, 0.93, 0.8 ) * ( 0.04 + 7.0 * uLights );
} else if ( part == ${VEHICLE_PART.tail.toFixed(1)} ) {
  vRough = 0.25;
  emit = vec3( 1.0, 0.035, 0.02 ) * ( 0.9 * uLights + brake * ( 3.0 + 3.0 * uLights ) );
} else if ( part == ${VEHICLE_PART.sign.toFixed(1)} ) {
  emit = diffuseColor.rgb * ( 0.1 + 2.2 * uLights );
} else if ( part == ${VEHICLE_PART.tyre.toFixed(1)} ) {
  vRough = 0.9;
}
totalEmissiveRadiance += emit;`;

/** Additive light pools / beams: model in metres at the car's front (front part) or rear (rear part). */
const GLOW_VERT = /* glsl */ `
attribute vec4 aInst;
attribute vec4 aInstB;
uniform float uLights;
varying vec2 vUvG;
varying float vSide;
varying float vBrake;
varying float vFogDepth;
varying float vAcross;
void main() {
  vec3 p = position;
  float alongV = clamp( uv.y, 0.0, 1.0 );
  // 0 on the centre line .. 1 at the pool's edge (pools widen away from the lamps)
  vAcross = uv.x < 0.5 ? abs( p.x ) / mix( 0.95, 2.1, alongV ) : abs( p.x ) / mix( 0.9, 1.4, alongV );
  float rear = step( 1.5, uv.x );
  // aInstB: width, length, -, tint
  p.z += mix( 0.5, -0.5, rear ) * aInstB.y;
  p.x *= aInstB.x / 1.9;
  float c = cos( aInst.w );
  float s = sin( aInst.w );
  p = vec3( c * p.x + s * p.z, p.y, -s * p.x + c * p.z ) + aInst.xyz;
  vUvG = uv;
  vSide = rear;
  vBrake = mod( floor( aInstB.w / ${PAINT_FLAGS.toFixed(1)} ), 2.0 );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const GLOW_FRAG = /* glsl */ `
uniform float uLights;
uniform float uFogDensity;
varying vec2 vUvG;
varying float vSide;
varying float vBrake;
varying float vFogDepth;
varying float vAcross;
void main() {
  // uv.x: 0 front pool, 1 front beam, 2 rear pool; uv.y: 0 at the lamp .. 1 at the far end
  float kind = floor( vUvG.x + 0.5 );
  float along = clamp( vUvG.y, 0.0, 1.0 );
  float a;
  vec3 col;
  float edge = 1.0 - smoothstep( 0.35, 1.0, vAcross );
  if ( kind < 0.5 ) {
    // headlight pool: bright near the bumper, soft at the sides, gone by ~12 m
    a = ( 1.0 - along ) * ( 1.0 - along ) * smoothstep( 0.0, 0.08, along ) * edge * 0.16;
    col = vec3( 1.0, 0.9, 0.72 );
  } else if ( kind < 1.5 ) {
    // the beam in the dusk haze: barely there
    a = ( 1.0 - along ) * ( 1.0 - along ) * 0.022;
    col = vec3( 1.0, 0.93, 0.8 );
  } else {
    a = ( 1.0 - along ) * ( 1.0 - along ) * edge * ( 0.035 + 0.16 * vBrake );
    col = vec3( 1.0, 0.06, 0.03 );
  }
  float fog = exp( -uFogDensity * uFogDensity * vFogDepth * vFogDepth );
  gl_FragColor = vec4( col * a * uLights * fog, 1.0 );
}`;

/** Lit signal lamp: base dark, the state colour glows (tint: 0 red, 1 yellow, 2 green). */
const LAMP_FRAGMENT = /* glsl */ `
vec3 lampC = vTint < 0.5 ? vec3( 1.0, 0.05, 0.02 ) : vTint < 1.5 ? vec3( 1.0, 0.55, 0.02 ) : vec3( 0.05, 1.0, 0.45 );
diffuseColor.rgb = lampC * 0.25;
totalEmissiveRadiance += lampC * 4.0;`;

/** Pole, mast arm and two heads (one over the lane, one on the pole), local +X = towards the kerb side. */
function signalModel(full: boolean): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const grey = 0x3d4044;
  const head = 0x1c1e20;
  const h = full ? SIGNAL_POLE_HEIGHT : SIGNAL_SHORT_HEAD_Y + 0.6;
  g.cylinderY(0, 0, 0.12, 0, h, 6, grey);
  // pole head facing the traffic (+Z), lenses on its face
  const py = full ? 3.0 : SIGNAL_SHORT_HEAD_Y;
  g.box(0, py, 0.22, 0.34, 1.0, 0.26, head);
  g.box(0, py, 0.08, 0.5, 1.15, 0.03, head);
  for (const k of [-1, 0, 1]) g.box(0, py - k * 0.31, 0.36, 0.2, 0.2, 0.02, 0x0b0b0c);
  if (full) {
    const reach = SIGNAL_POLE_ACROSS - SIGNAL_HEAD_ACROSS;
    g.box(-reach / 2 - 0.2, SIGNAL_ARM_Y + 0.5, 0, reach + 0.6, 0.14, 0.14, grey);
    g.box(-reach / 2 * 0.6, SIGNAL_ARM_Y + 0.2, 0, 0.06, 0.6, 0.06, grey);
    const hy = SIGNAL_ARM_Y - 0.15;
    g.box(-reach, hy, 0.05, 0.36, 1.05, 0.28, head);
    g.box(-reach, hy, -0.08, 0.56, 1.25, 0.03, head);
    for (const k of [-1, 0, 1]) g.box(-reach, hy - k * 0.33, 0.2, 0.21, 0.21, 0.02, 0x0b0b0c);
  }
  return g.build();
}

/** lamp offsets in the housing's frame: [x, y, z] of red / yellow / green, over the lane and on the pole */
function lampOffsets(full: boolean): { lane: number[][]; pole: number[][] } {
  const reach = SIGNAL_POLE_ACROSS - SIGNAL_HEAD_ACROSS;
  const hy = SIGNAL_ARM_Y - 0.15;
  const py = full ? 3.0 : SIGNAL_SHORT_HEAD_Y;
  return {
    lane: [0.33, 0, -0.33].map((dy) => [-reach, hy + dy, 0.21]),
    pole: [0.31, 0, -0.31].map((dy) => [0, py + dy, 0.37]),
  };
}

export class TrafficView {
  readonly group = new THREE.Group();
  private sim: TrafficSim;
  /** floating origin the instances are drawn relative to */
  readonly origin = { x: 0, z: 0 };
  private readonly plan: SignalPlan | null;
  private readonly signals: Float32Array;
  private readonly layers: InstanceLayer[] = [];
  private readonly generic: InstanceLayer;
  private readonly glow: InstanceLayer;
  private readonly housings: InstanceLayer;
  private readonly housingsShort: InstanceLayer;
  private readonly lamps: InstanceLayer;
  private readonly owned: { dispose(): void }[] = [];
  private readonly lights = { value: 0 };
  private readonly fogDensity = { value: 0 };
  private opts: TrafficViewOptions;
  private readonly offsets = { full: lampOffsets(true), short: lampOffsets(false) };
  /** drone position of the last housings rebuild */
  private readonly housingAt = new THREE.Vector3(Infinity, 0, Infinity);

  constructor(sim: TrafficSim, plan: SignalPlan | null, signals: Float32Array | null, shared: InstanceUniforms, opts: TrafficViewOptions) {
    this.group.name = 'traffic';
    this.sim = sim;
    this.plan = plan;
    this.signals = signals ?? new Float32Array(0);
    this.opts = opts;
    const paint = PAINT.map((hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace));
    const uniforms = { uPaint: { value: paint }, uLights: this.lights };
    const mk = (model: THREE.BufferGeometry, key: string, extra: Partial<Parameters<typeof instancedMaterials>[0]> = {}): InstanceLayer => {
      const m = instancedMaterials(
        {
          key,
          roughness: 0.6,
          envMapIntensity: 0.9,
          vertexPars: 'varying float vPart;',
          vertex: 'vPart = uv.x;',
          fragmentPars: VEHICLE_PARS,
          fragment: VEHICLE_FRAGMENT,
          afterRoughness: 'roughnessFactor = vRough;',
          afterMetalness: 'metalnessFactor = vMetal;',
          uniforms,
          ...extra,
        },
        shared,
      );
      const layer = new InstanceLayer(model, m.material, m.depth, key);
      this.owned.push(model, m.material, m.depth, layer);
      this.group.add(layer.mesh);
      return layer;
    };
    const models = vehicleModels();
    for (let t = 0; t < VEHICLE_TYPES; t++) this.layers.push(mk(models[t]!, `vehicle-${VEHICLES[t]!.name}`));
    this.generic = mk(genericVehicleModel(), 'vehicle-generic');

    // light pools and beams (additive, no depth write)
    const gb = new GeoBuilder();
    // the pool ahead: widening from the bumper to ~12 m
    gb.tri([-0.95, 0.05, 0.2], [0.95, 0.05, 0.2], [2.09, 0.05, 12], 0xffffff, 0, 0, 0, 1);
    gb.tri([-0.95, 0.05, 0.2], [2.09, 0.05, 12], [-2.09, 0.05, 12], 0xffffff, 0, 0, 1, 1);
    // beams: two flat wedges from the lamps, slightly down
    for (const s of [-1, 1]) {
      gb.tri([s * 0.62, 0.7, 0.05], [s * 0.62 + 1.4, 0.15, 9], [s * 0.62 - 1.4, 0.15, 9], 0xffffff, 1, 0, 1, 1);
      gb.tri([s * 0.62, 0.7, 0.05], [s * 0.62, 1.2, 9], [s * 0.62, 0.02, 9], 0xffffff, 1, 0, 1, 1);
    }
    // rear: a short red pool behind (z negative), drawn from the rear bumper
    gb.tri([-0.9, 0.05, -0.1], [-1.4, 0.05, -2.6], [1.4, 0.05, -2.6], 0xffffff, 2, 0, 1, 1);
    gb.tri([-0.9, 0.05, -0.1], [1.4, 0.05, -2.6], [0.9, 0.05, -0.1], 0xffffff, 2, 0, 1, 0);
    const glowGeo = gb.build();
    const glowMat = new THREE.ShaderMaterial({
      uniforms: { uLights: this.lights, uFogDensity: this.fogDensity },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.glow = new InstanceLayer(glowGeo, glowMat, null, 'vehicle-lights');
    this.glow.mesh.castShadow = false;
    this.glow.mesh.receiveShadow = false;
    this.glow.mesh.renderOrder = 3;
    this.owned.push(glowGeo, glowMat, this.glow);
    this.group.add(this.glow.mesh);

    // traffic lights
    const hm = instancedMaterials({ key: 'signal-housing', roughness: 0.6 }, shared);
    const fullModel = signalModel(true);
    const shortModel = signalModel(false);
    this.housings = new InstanceLayer(fullModel, hm.material, hm.depth, 'signal-housings');
    this.housingsShort = new InstanceLayer(shortModel, hm.material, hm.depth, 'signal-housings-short');
    const lampBox = new GeoBuilder().box(0, 0, 0, 0.19, 0.19, 0.03, 0xffffff).build();
    const lm = instancedMaterials({ key: 'signal-lamp', roughness: 0.3, fragment: LAMP_FRAGMENT }, shared);
    this.lamps = new InstanceLayer(lampBox, lm.material, null, 'signal-lamps');
    this.lamps.mesh.castShadow = false;
    this.owned.push(this.housings, this.housingsShort, this.lamps, hm.material, hm.depth, lm.material, lm.depth, lampBox, fullModel, shortModel);
    this.group.add(this.housings.mesh, this.housingsShort.mesh, this.lamps.mesh);
    this.applyOptions();
  }

  /** Another simulation (rural roads rebuilt around the drone) on the same draws. */
  setSim(sim: TrafficSim): void {
    this.sim = sim;
  }

  setOptions(o: TrafficViewOptions): void {
    this.opts = o;
    this.housingAt.set(Infinity, 0, Infinity);
    this.applyOptions();
  }

  private applyOptions(): void {
    const o = this.opts;
    for (const l of this.layers) {
      l.mesh.visible = !o.generic && l.count > 0;
      l.mesh.castShadow = o.shadows;
    }
    this.generic.mesh.visible = o.generic && this.generic.count > 0;
    this.generic.mesh.castShadow = false;
    this.housings.mesh.castShadow = o.shadows;
    this.housingsShort.mesh.castShadow = o.shadows;
  }

  /** 0 day … 1 night: lamps on */
  setLights(k: number): void {
    this.lights.value = k;
  }

  setFog(density: number): void {
    this.fogDensity.value = density;
  }

  update(time: number, drone: THREE.Vector3): void {
    const sim = this.sim;
    const o = this.opts;
    for (const l of this.layers) l.begin();
    this.generic.begin();
    this.glow.begin();
    const lightsOn = this.lights.value > 0.05 && o.glow;
    for (let c = 0; c < sim.capacity; c++) {
      if (!sim.alive[c]) continue;
      const t = sim.type[c]!;
      const brake = sim.flags[c]! & CAR_FLAG.brake ? FLAG_BRAKE : 0;
      const tint = sim.paint[c]! + PAINT_FLAGS * brake;
      const x = sim.x[c]! - this.origin.x;
      const y = sim.y[c]!;
      const z = sim.z[c]! - this.origin.z;
      const yaw = sim.yaw[c]!;
      if (o.generic) {
        const s = VEHICLES[t]!;
        this.generic.push(x, y, z, yaw, s.width, s.height, s.length, tint);
      } else this.layers[t]!.push(x, y, z, yaw, 1, 1, 1, tint);
      if (lightsOn) {
        const s = VEHICLES[t]!;
        this.glow.push(x, y, z, yaw, s.width, s.length, 0, tint);
      }
    }
    for (const l of this.layers) l.end();
    this.generic.end();
    this.glow.end();
    this.applyVisibility();
    this.updateSignals(time, drone);
  }

  private applyVisibility(): void {
    const o = this.opts;
    for (const l of this.layers) if (o.generic) l.mesh.visible = false;
    if (!o.generic) this.generic.mesh.visible = false;
    this.glow.mesh.visible = this.glow.count > 0;
  }

  private updateSignals(time: number, drone: THREE.Vector3): void {
    const sg = this.signals;
    const plan = this.plan;
    if (!plan || sg.length === 0) {
      this.housings.mesh.visible = false;
      this.housingsShort.mesh.visible = false;
      this.lamps.mesh.visible = false;
      return;
    }
    // housings are static: re-collected when the drone has moved 30 m; lamps follow the lights every frame
    const moved = (drone.x - this.housingAt.x) ** 2 + (drone.z - this.housingAt.z) ** 2 > 30 * 30;
    if (moved) {
      this.housingAt.copy(drone);
      this.housings.begin();
      this.housingsShort.begin();
    }
    this.lamps.begin();
    const range = this.opts.signalRange;
    const r2 = range * range;
    const hx = this.housingAt.x;
    const hz = this.housingAt.z;
    for (let k = 0; k < sg.length; k += SIGNAL_STRIDE) {
      const x = sg[k]!;
      const z = sg[k + 1]!;
      if ((x - hx) * (x - hx) + (z - hz) * (z - hz) > r2) continue;
      const yaw = sg[k + 2]!;
      const short = sg[k + 5]! > 0.5;
      if (moved) (short ? this.housingsShort : this.housings).push(x, 0, z, yaw, 1, 1, 1, 0);
      const st = plan.state(sg[k + 3]!, sg[k + 4]!, time);
      // red top, yellow middle, green bottom; tint 0 red, 1 yellow, 2 green
      const slot = st === SIGNAL.red ? 0 : st === SIGNAL.yellow ? 1 : 2;
      const off = short ? this.offsets.short : this.offsets.full;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const heads = short ? 1 : 2;
      for (let h = 0; h < heads; h++) {
        const o = (h === 0 ? off.pole : off.lane)[slot]!;
        this.lamps.push(x + c * o[0]! + sn * o[2]!, o[1]!, z - sn * o[0]! + c * o[2]!, yaw, 1, 1, 1, slot);
      }
    }
    if (moved) {
      this.housings.end();
      this.housingsShort.end();
    }
    this.lamps.end();
  }

  /** instances drawn now, per layer (stats / tests) */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of [...this.layers, this.generic, this.glow, this.housings, this.housingsShort, this.lamps]) out[l.mesh.name] = l.mesh.visible ? l.count : 0;
    return out;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.owned) d.dispose();
    this.group.clear();
  }
}
