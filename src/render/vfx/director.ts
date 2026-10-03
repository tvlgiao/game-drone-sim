/**
 * Owns every gameplay VFX system and turns game events into effects within the tier budget:
 * point particles (glows / soft puffs), spark streaks, tumbling debris, shockwave rings, prop-wash
 * dust + ground ripple decal (water spray via a probe hook), and FPV speed lines.
 * All pools are allocated up front; events and frames write into ring buffers only.
 */
import * as THREE from 'three';
import type { FormFactor } from '../../core/device';
import type { DroneState, QualityTier, RingDef } from '../../types';
import { vfxBudget, vfxCapacity, type VfxBudget } from './budget';
import { Debris } from './debris';
import { ParticlePool } from './particles';
import { PropWashDecal } from './prop-wash';
import { Shockwaves } from './shockwave';
import { SparkStreaks } from './sparks';
import { SpeedLines } from './speed-lines';

export interface VfxFrame {
  dt: number;
  time: number;
  /** pixels per unit tan(angle) of the active view (point-sprite sizing) */
  px: number;
  drone: DroneState;
  /** the camera being rendered (FPV speed lines live in its view space) */
  camera: THREE.Camera;
  /** 0 chase/LOS … 1 FPV */
  fpvWeight: number;
  /** top of the surface under the drone and the drone's height above it */
  surfaceY: number;
  height: number;
  /** WebXR presenting: no view-space effects */
  xr: boolean;
}

/**
 * Water at (x, z)? Levels with water install one; spray replaces dust there. A number is the water surface
 * height (−Infinity: dry), so spray rises off the surface rather than the river bed under it; `true` means
 * water at the ground height.
 */
export type WaterProbe = (x: number, z: number) => boolean | number;

/** Water surface under (x, z) per the probe, or null when dry (`true` = at the ground height `ground`). */
export function waterSurface(probe: WaterProbe | null, x: number, z: number, ground: number): number | null {
  const w = probe?.(x, z);
  if (w === true) return ground;
  if (typeof w === 'number' && w > -Infinity) return Math.max(w, ground);
  return null;
}

const WHITE = new THREE.Color(1, 1, 1);
const SPARK = new THREE.Color(1, 0.55, 0.16);
const HOT = new THREE.Color(1, 0.78, 0.45);
const CARBON = new THREE.Color(0.035, 0.036, 0.04);
const TPU = new THREE.Color(0.12, 0.12, 0.13);
const SOLDER = new THREE.Color(0.75, 0.75, 0.78);
const SPRAY = new THREE.Color(0.82, 0.9, 1);
const DUST = new THREE.Color(0.85, 0.72, 0.55);
const PROP_FRONT = new THREE.Color(0.1, 1, 0.32);
const PROP_REAR = new THREE.Color(1, 0.12, 0.08);
const UP = new THREE.Vector3(0, 1, 0);

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

export class VfxDirector {
  readonly group = new THREE.Group();
  /** additive glows/sparkles */
  readonly fx: ParticlePool;
  /** alpha-blended puffs, dust and fine bits */
  readonly soft: ParticlePool;
  readonly waves: Shockwaves;
  readonly sparks: SparkStreaks;
  readonly debris: Debris;
  readonly wash: PropWashDecal;
  readonly speedLines: SpeedLines;
  private budget: VfxBudget;
  private water: WaterProbe | null = null;
  private washAcc = 0;

  constructor(
    private readonly form: FormFactor = 'desktop',
    tier: QualityTier = 'high',
  ) {
    const cap = vfxCapacity(form);
    this.fx = new ParticlePool(cap.points, true);
    this.soft = new ParticlePool(cap.soft, false);
    this.waves = new Shockwaves(8);
    this.sparks = new SparkStreaks(cap.streaks);
    this.debris = new Debris(cap.debris);
    this.wash = new PropWashDecal();
    this.speedLines = new SpeedLines(cap.speedLines);
    this.group.name = 'vfx';
    this.group.add(this.fx.points, this.soft.points, this.waves.group, this.sparks.mesh, this.debris.mesh, this.wash.mesh, this.speedLines.mesh);
    this.budget = vfxBudget(tier, form);
    this.applyBudget();
  }

  get tierBudget(): VfxBudget {
    return this.budget;
  }

  setQuality(tier: QualityTier): void {
    this.budget = vfxBudget(tier, this.form);
    this.applyBudget();
  }

  private applyBudget(): void {
    this.speedLines.setCount(this.budget.speedLines);
    this.wash.enabled = this.budget.washDecal;
  }

  /** Hook for water surfaces (null = none): prop wash over water throws spray instead of dust. */
  setWaterProbe(probe: WaterProbe | null): void {
    this.water = probe;
  }

  /** Dust colour kicked up by prop wash on this level's ground. */
  setDustColor(c: THREE.ColorRepresentation): void {
    this.wash.setColor(c);
  }

  /** Gate pass: rim sparkles + streaks flung off the ring, a trail through it, two shockwaves. */
  ringPass(def: RingDef, color: THREE.Color, through: THREE.Vector3): void {
    const b = this.budget;
    _n.set(def.direction[0], def.direction[1], def.direction[2]).normalize();
    basis(_n, _t1, _t2);
    const cx = def.position[0];
    const cy = def.position[1];
    const cz = def.position[2];
    const R = def.radius + def.tube;
    for (let i = 0; i < b.ringParticles; i++) {
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rr = R * (0.92 + Math.random() * 0.14);
      const sp = 1.2 + Math.random() * 3.2;
      const fw = 0.3 + Math.random() * 2.2;
      _c.copy(Math.random() < 0.3 ? WHITE : color);
      this.fx.emit(
        cx + (_t1.x * ca + _t2.x * sa) * rr, cy + (_t1.y * ca + _t2.y * sa) * rr, cz + (_t1.z * ca + _t2.z * sa) * rr,
        (_t1.x * ca + _t2.x * sa) * sp + _n.x * fw, (_t1.y * ca + _t2.y * sa) * sp + _n.y * fw, (_t1.z * ca + _t2.z * sa) * sp + _n.z * fw,
        _c.r, _c.g, _c.b, 0.6 + Math.random() * 0.7, 0.03 + Math.random() * 0.025, 0.12, 2.2, 0,
      );
    }
    for (let i = 0; i < b.ringStreaks; i++) {
      const a = (i / Math.max(1, b.ringStreaks)) * Math.PI * 2 + Math.random() * 0.2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const sp = 2.5 + Math.random() * 3.5;
      _c.copy(color).lerp(WHITE, 0.35);
      this.sparks.emit(
        cx + (_t1.x * ca + _t2.x * sa) * R, cy + (_t1.y * ca + _t2.y * sa) * R, cz + (_t1.z * ca + _t2.z * sa) * R,
        (_t1.x * ca + _t2.x * sa) * sp + _n.x * 1.5, (_t1.y * ca + _t2.y * sa) * sp + _n.y * 1.5, (_t1.z * ca + _t2.z * sa) * sp + _n.z * 1.5,
        _c.r * 0.6, _c.g * 0.6, _c.b * 0.6, 0.35 + Math.random() * 0.25, 0.0035, { gravity: 0.15, stretch: 0.02 },
      );
    }
    const m = Math.round(b.ringParticles * 0.27);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * R * 0.6;
      const sp = 2 + Math.random() * 4;
      this.fx.emit(
        through.x + (_t1.x * Math.cos(a) + _t2.x * Math.sin(a)) * rr, through.y + (_t1.y * Math.cos(a) + _t2.y * Math.sin(a)) * rr, through.z + (_t1.z * Math.cos(a) + _t2.z * Math.sin(a)) * rr,
        _n.x * sp, _n.y * sp, _n.z * sp,
        color.r, color.g, color.b, 0.4 + Math.random() * 0.4, 0.02, 0, 3, 0,
      );
    }
    _v.set(cx, cy, cz);
    this.waves.spawn(_v, _n, color, R, R * 1.85, 0.55);
    _c2.copy(color).lerp(WHITE, 0.6);
    this.waves.spawn(_v, _n, _c2, R * 0.95, R * 1.35, 0.35);
  }

  /** Crash: impact flash, bouncing spark streaks, embers, tumbling debris, dust and smoke. */
  crash(pos: THREE.Vector3, speed: number, surfaceY: number): void {
    const b = this.budget;
    const sev = THREE.MathUtils.clamp(speed / 8, 0.35, 1);
    for (let i = 0; i < 2; i++) this.fx.emit(pos.x, pos.y, pos.z, 0, 0, 0, 1, 0.62, 0.3, 0.1 + i * 0.07, 0.22 + i * 0.2, 0, 1, 0);
    const n = Math.round(b.crashSparks * sev);
    for (let i = 0; i < n; i++) {
      randomDir(_v, 0.35);
      const sp = 1.5 + Math.random() * (3 + speed * 0.6);
      _c.copy(SPARK).lerp(HOT, Math.random() * 0.7);
      this.sparks.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, _c.r, _c.g, _c.b, 0.45 + Math.random() * 0.8, 0.0016 + Math.random() * 0.0022, { floorY: surfaceY, bounce: 0.25 + Math.random() * 0.2, delay: Math.random() * 0.05 });
    }
    const embers = Math.round(n * 0.12);
    for (let i = 0; i < embers; i++) {
      randomDir(_v, 0.6);
      const sp = 0.4 + Math.random() * 1.2;
      this.fx.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, 1, 0.42, 0.1, 1.2 + Math.random() * 1.4, 0.012 + Math.random() * 0.01, 0.06, 1.4, 0, Math.random() * 0.1);
    }
    const d = Math.round(b.debris * sev);
    for (let i = 0; i < d; i++) {
      randomDir(_v, 0.55);
      const sp = 0.8 + Math.random() * (1.5 + speed * 0.35);
      randomDir(_n, 0);
      const pick = i % 4;
      let glow = 0;
      let sx: number;
      let sy: number;
      let sz: number;
      if (pick === 0 || pick === 1) {
        _c.copy(CARBON);
        sx = 0.008 + Math.random() * 0.008;
        sy = 0.006 + Math.random() * 0.008;
        sz = 0.004;
      } else if (pick === 2) {
        _c.copy(Math.random() < 0.5 ? PROP_FRONT : PROP_REAR).multiplyScalar(0.8);
        sx = 0.014 + Math.random() * 0.008;
        sy = 0.004 + Math.random() * 0.003;
        sz = 0.003;
      } else if (Math.random() < 0.5) {
        _c.copy(SOLDER);
        sx = sy = sz = 0.0025 + Math.random() * 0.002;
        glow = 1;
      } else {
        _c.copy(TPU);
        sx = 0.006 + Math.random() * 0.004;
        sy = 0.005 + Math.random() * 0.003;
        sz = 0.008;
      }
      this.debris.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp, _v.z * sp, _n.x, _n.y, _n.z, 8 + Math.random() * 22, 2.2 + Math.random() * 1.6, surfaceY, sx, sy, sz, _c.r, _c.g, _c.b, glow);
    }
    // smoke puff at the impact, dust ring when on/near the ground
    const smoke = Math.max(1, Math.round(b.dust * 0.4));
    for (let i = 0; i < smoke; i++) {
      randomDir(_v, 0.8);
      const sp = 0.2 + Math.random() * 0.5;
      const g = 0.22 + Math.random() * 0.1;
      this.soft.emit(pos.x, pos.y, pos.z, _v.x * sp, _v.y * sp + 0.25, _v.z * sp, g, g, g * 1.05, 1.4 + Math.random() * 0.9, 0.09 + Math.random() * 0.07, -0.02, 1.6, 2);
    }
    if (pos.y - surfaceY < 0.6) {
      for (let i = 0; i < b.dust; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.6 + Math.random() * 1.8;
        this.soft.emit(pos.x, surfaceY + 0.06, pos.z, Math.cos(a) * sp, 0.2 + Math.random() * 0.3, Math.sin(a) * sp, 0.5, 0.48, 0.45, 1 + Math.random() * 0.8, 0.08 + Math.random() * 0.06, 0, 2.2, 2);
      }
      _v.set(pos.x, surfaceY + 0.02, pos.z);
      _c.copy(DUST).multiplyScalar(0.18);
      this.waves.spawn(_v, UP, _c, 0.1, 0.9, 0.5);
    } else {
      _c.copy(SPARK).multiplyScalar(0.4);
      this.waves.spawn(pos, UP, _c, 0.05, 0.7, 0.4);
    }
  }

  /** Scrape / bump: a short fan of sparks off the surface, a puff of dust on floors. */
  impact(point: THREE.Vector3, normal: THREE.Vector3, speed: number, surfaceY: number): void {
    const b = this.budget;
    const n = Math.max(3, Math.round(b.impactSparks * THREE.MathUtils.clamp(speed / 6, 0.3, 1)));
    for (let i = 0; i < n; i++) {
      randomDir(_v, 0);
      if (_v.dot(normal) < 0) _v.addScaledVector(normal, -2 * _v.dot(normal));
      _v.addScaledVector(normal, 0.6).normalize();
      const sp = 0.8 + Math.random() * (1 + speed * 0.5);
      _c.copy(SPARK).lerp(HOT, Math.random() * 0.6);
      this.sparks.emit(point.x, point.y, point.z, _v.x * sp, _v.y * sp, _v.z * sp, _c.r, _c.g, _c.b, 0.25 + Math.random() * 0.4, 0.0014 + Math.random() * 0.0016, { floorY: surfaceY, bounce: 0.3 });
    }
    if (normal.y > 0.7) {
      for (let i = 0; i < Math.max(1, Math.round(b.dust * 0.2)); i++) {
        const a = Math.random() * Math.PI * 2;
        this.soft.emit(point.x, point.y + 0.02, point.z, Math.cos(a) * 0.5, 0.15, Math.sin(a) * 0.5, 0.5, 0.48, 0.45, 0.8, 0.05, 0, 2.4, 2);
      }
    }
  }

  /** Respawn: a swirl of cyan motes and two rings on the floor. */
  respawn(pos: THREE.Vector3, surfaceY: number): void {
    const n = Math.round(150 * this.budget.scale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.12 + Math.random() * 0.12;
      const y = (Math.random() - 0.5) * 0.3;
      const swirl = 1.2 + Math.random();
      _c.setRGB(0.3, 0.9, 1).lerp(WHITE, Math.random() * 0.5);
      this.fx.emit(
        pos.x + Math.cos(a) * r, pos.y + y, pos.z + Math.sin(a) * r,
        -Math.sin(a) * swirl - Math.cos(a) * 0.3, 0.6 + Math.random() * 0.8, Math.cos(a) * swirl - Math.sin(a) * 0.3,
        _c.r, _c.g, _c.b, 0.7 + Math.random() * 0.6, 0.008 + Math.random() * 0.008, -0.03, 1.5, 0, Math.random() * 0.25,
      );
    }
    _c.setRGB(0.3, 0.9, 1);
    _v.copy(pos);
    _v.y = surfaceY + 0.02;
    this.waves.spawn(_v, UP, _c, 0.05, 0.9, 0.6);
    this.waves.spawn(pos, UP, WHITE, 0.02, 0.5, 0.35);
  }

  update(f: VfxFrame): void {
    const d = f.drone;
    let motors = 0;
    for (let i = 0; i < 4; i++) motors += d.motors[i];
    motors *= 0.25;
    const near = Math.max(0, 1 - f.height / 0.8);
    const washing = d.armed && motors > 0.18 && near > 0;
    if (washing) this.emitWash(d.position, motors, near, f.surfaceY, f.dt);
    const strength = d.armed ? THREE.MathUtils.clamp((motors - 0.12) * 2.2, 0, 1) * Math.pow(Math.max(0, 1 - f.height / 0.9), 1.5) : 0;
    this.wash.update(f.dt, f.time, d.position.x, d.position.z, f.surfaceY, f.height, strength);

    this.fx.update(f.time, f.px);
    this.soft.update(f.time, f.px);
    this.sparks.update(f.time);
    this.debris.update(f.time);
    this.waves.update(f.dt);
    this.speedLines.update(f.dt, d.velocity, f.camera, f.xr ? 0 : f.fpvWeight);
  }

  private emitWash(pos: THREE.Vector3, motors: number, near: number, surfaceY: number, dt: number): void {
    this.washAcc += dt * this.budget.washRate * motors * Math.pow(near, 1.5);
    const level = waterSurface(this.water, pos.x, pos.z, surfaceY);
    const wet = level !== null;
    if (wet) surfaceY = level;
    const y = surfaceY + 0.02;
    while (this.washAcc >= 1) {
      this.washAcc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 0.04 + Math.random() * 0.1;
      const sp = (1 + Math.random() * 2) * (0.5 + motors);
      if (wet) {
        this.sparks.emit(pos.x + Math.cos(a) * r, y, pos.z + Math.sin(a) * r, Math.cos(a) * sp, 0.6 + Math.random() * 1.4, Math.sin(a) * sp, SPRAY.r * 0.35, SPRAY.g * 0.35, SPRAY.b * 0.35, 0.4 + Math.random() * 0.4, 0.003, { floorY: surfaceY, bounce: 0, stretch: 0.015 });
        this.soft.emit(pos.x + Math.cos(a) * r, y, pos.z + Math.sin(a) * r, Math.cos(a) * sp * 0.6, 0.15 + Math.random() * 0.25, Math.sin(a) * sp * 0.6, SPRAY.r, SPRAY.g, SPRAY.b, 0.7 + Math.random() * 0.5, 0.05 + Math.random() * 0.05, 0, 2.2, 2);
        continue;
      }
      const g = 0.42 + Math.random() * 0.08;
      const size = 0.035 + Math.random() * 0.045;
      this.soft.emit(pos.x + Math.cos(a) * r, y + size * 0.5, pos.z + Math.sin(a) * r, Math.cos(a) * sp, 0.06 + Math.random() * 0.2, Math.sin(a) * sp, g, g * 0.96, g * 0.9, 0.6 + Math.random() * 0.5, size, 0, 2.6, 2);
    }
  }

  /** Emission totals per pool (diagnostics and budget tests). */
  emitted(): { points: number; soft: number; streaks: number; debris: number } {
    return { points: this.fx.emitted, soft: this.soft.emitted, streaks: this.sparks.emitted, debris: this.debris.emitted };
  }

  dispose(): void {
    this.fx.dispose();
    this.soft.dispose();
    this.waves.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    this.wash.dispose();
    this.speedLines.dispose();
  }
}

/** Orthonormal basis perpendicular to unit n. */
function basis(n: THREE.Vector3, t1: THREE.Vector3, t2: THREE.Vector3): void {
  if (Math.abs(n.y) < 0.9) t1.set(0, 1, 0);
  else t1.set(1, 0, 0);
  t1.crossVectors(n, t1).normalize();
  t2.crossVectors(n, t1).normalize();
}

/** Random unit vector with an upward bias (0 = uniform sphere). */
function randomDir(out: THREE.Vector3, upBias: number): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  out.set(s * Math.cos(a), z, s * Math.sin(a));
  out.y += upBias;
  return out.normalize();
}
