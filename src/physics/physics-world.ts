/**
 * 6-DOF rigid-body quadcopter in a level: motors, aero, battery, ground effect and collisions.
 * Semi-implicit Euler at a fixed dt; step() performs no allocations.
 */
import { Quaternion, Vector3 } from 'three';
import type { Collider, ColliderShape, Contact, DroneState, RoomLevelData } from '../types';
import { levelColliders } from '../game/level-data';
import { isRuntime, type LevelRuntime } from '../levels/runtime';
import { AIR_DENSITY, CENTER_COLLIDER_OFFSET, DEFAULT_DRONE, GRAVITY, MOTOR_LAYOUT, type DroneParams } from './drone-params';
import { createSphereHit, shapeBoundingRadius, sphereVsPlane, sphereVsShape } from './collision';

/** Ceiling-fan kinematics (design §5). */
export const FAN_REV_PER_S = 1.4;
export const FAN_BLADE_RADIUS = 0.9;
export const FAN_BLADE_WIDTH = 0.14;
const FAN_HUB_RADIUS = 0.12;
const FAN_BLADE_HALF_THICKNESS = 0.012;

const MAX_CONTACTS = 32;
const POSITION_CORRECTION = 0.8;
const SLOP = 0.0005;
const RESTITUTION_THRESHOLD = 0.2; // m/s: slower impacts are treated as fully inelastic (stable resting)
const DEFAULT_RESTITUTION = 0.25;
const DEFAULT_FRICTION = 0.5;
const ROLLING_DAMPING = 12; // 1/s, damps rocking/rolling while resting on a surface
const VELOCITY_ITERATIONS = 4;
const MAX_ANGULAR_SPEED = 80; // rad/s safety clamp
const GROUND_EFFECT_MAX = 1.4;
/** prop + bell inertia (kg·m²) and top rotor speed (rad/s): spin-up reaction torque about yaw */
export const ROTOR_INERTIA = 1.2e-6;
export const MOTOR_MAX_RAD_S = 3500;

/** A level as physics sees it: a LevelRuntime, or raw room data (tests). */
export type PhysicsLevel = LevelRuntime | RoomLevelData;

/** Allocate a fresh DroneState (level, at origin, disarmed, full battery). */
export function createDroneState(params: DroneParams = DEFAULT_DRONE): DroneState {
  return {
    position: new Vector3(),
    velocity: new Vector3(),
    orientation: new Quaternion(),
    angularVelocity: new Vector3(),
    motors: [0, 0, 0, 0],
    armed: false,
    batteryVoltage: params.battery.full,
  };
}

/** Copy every field of `src` into `dst` without allocating. */
export function copyDroneState(src: DroneState, dst: DroneState): DroneState {
  dst.position.copy(src.position);
  dst.velocity.copy(src.velocity);
  dst.orientation.copy(src.orientation);
  dst.angularVelocity.copy(src.angularVelocity);
  for (let i = 0; i < 4; i++) dst.motors[i] = src.motors[i];
  dst.armed = src.armed;
  dst.batteryVoltage = src.batteryVoltage;
  return dst;
}

interface WorldCollider {
  id: string;
  shape: ColliderShape;
  bound: number;
  restitution: number;
  friction: number;
  /** true for fan blades: surface velocity = fan ω × r */
  moving: boolean;
  /** centre for moving colliders' rotation (fan hub) */
  pivot: Vector3;
}

interface FanBlade {
  collider: WorldCollider;
  shape: { kind: 'box'; center: [number, number, number]; half: [number, number, number]; yaw: number };
  hub: Vector3;
  index: number;
}

interface ContactExtra {
  restitution: number;
  friction: number;
  obstacleVelocity: Vector3;
  normalImpulse: number;
  approach: number;
  /** lever arm from COM to contact point (world) */
  r: Vector3;
}

export class PhysicsWorld {
  readonly params: DroneParams;
  readonly state: DroneState;
  readonly prevState: DroneState;
  /** rad, fan spins at FAN_REV_PER_S about +Y */
  fanAngle = 0;
  time = 0;
  /** summed-normalised-thrust·seconds drawn from the battery */
  consumed = 0;
  /** per-motor ground-effect factor of the last step (≥ 1), for tests/telemetry */
  readonly groundEffect: [number, number, number, number] = [1, 1, 1, 1];
  /** per-motor thrust (N) of the last step */
  readonly thrust: [number, number, number, number] = [0, 0, 0, 0];

  /** room shell (indoor: six hard planes); null = open sky over the ground plane y = 0 */
  private room: { halfX: number; halfZ: number; height: number } | null = null;
  private readonly colliders: WorldCollider[] = [];
  private readonly fanBlades: FanBlade[] = [];
  private readonly groundBoxes: { center: [number, number, number]; half: [number, number, number]; yaw: number }[] = [];

  /** views[n] = first n pooled contacts; returning a view avoids resizing arrays in step() */
  private readonly views: Contact[][] = [];
  private readonly contactPool: Contact[] = [];
  private readonly extras: ContactExtra[] = [];
  private contactCount = 0;

  private readonly sphereLocal: Vector3[] = [];
  private readonly sphereRadius: number[] = [];
  private readonly sphereWorld: Vector3[] = [];
  private readonly motorPos: Vector3[] = [];
  private readonly hit = createSphereHit();
  private readonly fanOmega = new Vector3(0, 2 * Math.PI * FAN_REV_PER_S, 0);

  // scratch
  private readonly qInv = new Quaternion();
  private readonly dq = new Quaternion();
  private readonly vBody = new Vector3();
  private readonly fBody = new Vector3();
  private readonly tBody = new Vector3();
  private readonly fWorld = new Vector3();
  private readonly iw = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly rB = new Vector3();
  private readonly nB = new Vector3();
  private readonly jB = new Vector3();
  private readonly vp = new Vector3();
  private readonly shift = new Vector3();
  private readonly axis = new Vector3();
  private lastDt = -1;
  private alphaUp = 0;
  private alphaDown = 0;
  private readonly invI: [number, number, number];

  constructor(level: PhysicsLevel, params: DroneParams = DEFAULT_DRONE) {
    this.params = params;
    this.state = createDroneState(params);
    this.prevState = createDroneState(params);
    this.invI = [1 / params.inertia[0], 1 / params.inertia[1], 1 / params.inertia[2]];

    this.sphereLocal.push(new Vector3().fromArray(CENTER_COLLIDER_OFFSET));
    this.sphereRadius.push(params.colliderRadius);
    for (const m of MOTOR_LAYOUT) {
      this.sphereLocal.push(new Vector3().fromArray(m.position));
      this.sphereRadius.push(params.propColliderRadius);
      this.motorPos.push(new Vector3());
    }
    for (let i = 0; i < this.sphereLocal.length; i++) this.sphereWorld.push(new Vector3());

    for (let i = 0; i < MAX_CONTACTS; i++) {
      this.contactPool.push({ normal: new Vector3(), depth: 0, point: new Vector3(), impactSpeed: 0, colliderId: '' });
      this.extras.push({ restitution: 0, friction: 0, obstacleVelocity: new Vector3(), normalImpulse: 0, approach: 0, r: new Vector3() });
    }
    for (let n = 0; n <= MAX_CONTACTS; n++) this.views.push(this.contactPool.slice(0, n));
    this.setLevel(level);
  }

  /** Replace the level geometry (room shell or open ground, colliders) and put the drone on its spawn. */
  setLevel(level: PhysicsLevel): void {
    this.colliders.length = 0;
    this.fanBlades.length = 0;
    this.groundBoxes.length = 0;
    this.fanAngle = 0;
    let colliders: readonly Collider[];
    let spawn: RoomLevelData['spawn'];
    if (isRuntime(level)) {
      const d = level.def;
      this.room = d.kind === 'indoor' ? { halfX: d.room.size[0] / 2, halfZ: d.room.size[2] / 2, height: d.room.size[1] } : null;
      colliders = level.colliders;
      spawn = d.spawn;
    } else {
      this.room = { halfX: level.room.size[0] / 2, halfZ: level.room.size[2] / 2, height: level.room.size[1] };
      colliders = levelColliders(level);
      spawn = level.spawn;
    }
    for (const c of colliders) this.addCollider(c);
    const s = spawn.position;
    this.reset(this.tmp.set(s[0], s[1], s[2]), spawn.yaw);
  }

  private addCollider(c: Collider): void {
    const restitution = c.restitution ?? DEFAULT_RESTITUTION;
    const friction = c.friction ?? DEFAULT_FRICTION;
    if (c.dynamic === 'fan') {
      const cc = c.shape.center;
      const hub = new Vector3(cc[0], cc[1], cc[2]);
      const hubShape: ColliderShape = { kind: 'cylinder', center: [cc[0], cc[1], cc[2]], radius: FAN_HUB_RADIUS, halfHeight: 0.06 };
      this.colliders.push({ id: c.id, shape: hubShape, bound: shapeBoundingRadius(hubShape), restitution, friction, moving: false, pivot: hub });
      const halfLen = (FAN_BLADE_RADIUS - FAN_HUB_RADIUS) / 2;
      for (let k = 0; k < 4; k++) {
        const shape = {
          kind: 'box' as const,
          center: [cc[0], cc[1], cc[2]] as [number, number, number],
          half: [halfLen, FAN_BLADE_HALF_THICKNESS, FAN_BLADE_WIDTH / 2] as [number, number, number],
          yaw: 0,
        };
        const collider: WorldCollider = { id: c.id, shape, bound: shapeBoundingRadius(shape), restitution, friction, moving: true, pivot: hub };
        this.colliders.push(collider);
        this.fanBlades.push({ collider, shape, hub, index: k });
      }
      this.updateFan();
      return;
    }
    this.colliders.push({ id: c.id, shape: c.shape, bound: shapeBoundingRadius(c.shape), restitution, friction, moving: false, pivot: new Vector3() });
    if (c.shape.kind === 'box') this.groundBoxes.push({ center: c.shape.center, half: c.shape.half, yaw: c.shape.yaw ?? 0 });
  }

  private updateFan(): void {
    const mid = (FAN_BLADE_RADIUS + FAN_HUB_RADIUS) / 2;
    for (let i = 0; i < this.fanBlades.length; i++) {
      const b = this.fanBlades[i];
      const yaw = this.fanAngle + (b.index * Math.PI) / 2;
      b.shape.yaw = yaw;
      // blade extends along its local +X; local → world = R_y(yaw)
      b.shape.center[0] = b.hub.x + Math.cos(yaw) * mid;
      b.shape.center[1] = b.hub.y;
      b.shape.center[2] = b.hub.z - Math.sin(yaw) * mid;
    }
  }

  /** Current fan blade shapes (world), e.g. for debug drawing. */
  fanShapes(): readonly ColliderShape[] {
    return this.fanBlades.map((b) => b.shape);
  }

  /**
   * Place the drone level at `position` facing `yaw` (rad about +Y; 0 = facing -Z), at rest.
   * The height is raised if needed so the drone does not start inside the floor.
   */
  reset(position: Vector3, yaw: number, refillBattery = true): void {
    const s = this.state;
    const minY = this.params.colliderRadius - CENTER_COLLIDER_OFFSET[1] + SLOP;
    s.position.set(position.x, Math.max(position.y, minY), position.z);
    s.velocity.set(0, 0, 0);
    s.orientation.setFromAxisAngle(this.axis.set(0, 1, 0), yaw);
    s.angularVelocity.set(0, 0, 0);
    for (let i = 0; i < 4; i++) s.motors[i] = 0;
    if (refillBattery) this.consumed = 0;
    s.batteryVoltage = this.restingVoltage();
    this.contactCount = 0;
    copyDroneState(s, this.prevState);
  }

  private restingVoltage(): number {
    const b = this.params.battery;
    const f = Math.min(1, this.consumed / b.capacityS);
    // gentle LiPo-like discharge: mostly linear, steeper near empty
    return b.full - (b.full - b.empty) * (0.6 * f + 0.4 * f * f * f * f);
  }

  /** One fixed step. motorCmd 0..1 per motor (after mixer). Returns contacts of this step (reused array). */
  step(dt: number, motorCmd: readonly number[]): readonly Contact[] {
    const p = this.params;
    const s = this.state;
    copyDroneState(s, this.prevState);
    this.time += dt;
    this.fanAngle = (this.fanAngle + 2 * Math.PI * FAN_REV_PER_S * dt) % (2 * Math.PI);
    if (this.fanBlades.length > 0) this.updateFan();

    if (dt !== this.lastDt) {
      this.lastDt = dt;
      this.alphaUp = 1 - Math.exp(-dt / p.tauUp);
      this.alphaDown = 1 - Math.exp(-dt / p.tauDown);
    }

    // Motors: first-order lag on normalised rpm.
    let sumNorm = 0;
    let spinUpTorque = 0;
    for (let i = 0; i < 4; i++) {
      const raw = motorCmd[i] ?? 0;
      const cmd = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const u = s.motors[i];
      const du = (cmd - u) * (cmd > u ? this.alphaUp : this.alphaDown);
      s.motors[i] = u + du;
      sumNorm += s.motors[i] * s.motors[i];
      // accelerating a +Y-spinning rotor pushes the frame about -Y
      spinUpTorque -= MOTOR_LAYOUT[i].spin * ROTOR_INERTIA * MOTOR_MAX_RAD_S * (du / dt);
    }

    // Battery: resting voltage by consumption + load sag; thrust scales with V².
    this.consumed += sumNorm * dt;
    const frac = Math.min(1, this.consumed / p.battery.capacityS);
    const volts = this.restingVoltage() - p.battery.sagPerThrust * sumNorm * (1 + frac);
    s.batteryVoltage = volts;
    const vr = volts / p.battery.full;
    const batteryScale = vr * vr;

    const q = s.orientation;
    this.qInv.copy(q).invert();

    // Thrust + ground effect and torques (body frame).
    this.fBody.set(0, 0, 0);
    this.tBody.set(0, 0, 0);
    let totalThrust = 0;
    for (let i = 0; i < 4; i++) {
      const m = MOTOR_LAYOUT[i];
      const u = s.motors[i];
      let T = p.maxThrustPerMotor * u * u * batteryScale;
      let ge = 1;
      if (T > 0) {
        const mp = this.motorPos[i].fromArray(m.position).applyQuaternion(q).add(s.position);
        ge = this.groundEffectAt(mp);
        T *= ge;
      }
      this.groundEffect[i] = ge;
      this.thrust[i] = T;
      totalThrust += T;
      const x = m.position[0];
      const z = m.position[2];
      // r × (0,T,0) = (-z·T, 0, x·T); prop reaction yaw = -spin·kQ·T
      this.tBody.x += -z * T;
      this.tBody.z += x * T;
      this.tBody.y += -m.spin * p.yawTorqueCoef * T;
    }
    this.fBody.y = totalThrust;
    this.tBody.y += spinUpTorque;

    // Aero: quadratic body-axis drag + rotor H-force drag (in rotor plane, ∝ thrust).
    const vb = this.vBody.copy(s.velocity).applyQuaternion(this.qInv);
    const speed = vb.length();
    const k = 0.5 * AIR_DENSITY * speed;
    this.fBody.x -= k * p.dragCdA[0] * vb.x;
    this.fBody.y -= k * p.dragCdA[1] * vb.y;
    this.fBody.z -= k * p.dragCdA[2] * vb.z;
    const thrustNorm = totalThrust / (p.mass * GRAVITY);
    this.fBody.x -= p.rotorDrag * thrustNorm * vb.x;
    this.fBody.z -= p.rotorDrag * thrustNorm * vb.z;

    // Linear: semi-implicit Euler.
    const f = this.fWorld.copy(this.fBody).applyQuaternion(q);
    f.y -= p.mass * GRAVITY;
    s.velocity.addScaledVector(f, dt / p.mass);

    // Angular (body frame): I ω̇ = τ − ω × Iω.
    const w = s.angularVelocity;
    const I = p.inertia;
    const iw = this.iw.set(I[0] * w.x, I[1] * w.y, I[2] * w.z);
    const gyro = this.tmp.crossVectors(w, iw);
    w.x += ((this.tBody.x - gyro.x) * this.invI[0]) * dt;
    w.y += ((this.tBody.y - gyro.y) * this.invI[1]) * dt;
    w.z += ((this.tBody.z - gyro.z) * this.invI[2]) * dt;
    const wl = w.length();
    if (wl > MAX_ANGULAR_SPEED) w.multiplyScalar(MAX_ANGULAR_SPEED / wl);

    s.position.addScaledVector(s.velocity, dt);
    this.integrateOrientation(dt);

    this.collide(dt);
    return this.views[this.contactCount];
  }

  private integrateOrientation(dt: number): void {
    const s = this.state;
    const w = s.angularVelocity;
    const wl = w.length();
    if (wl > 1e-12) {
      this.dq.setFromAxisAngle(this.axis.copy(w).divideScalar(wl), wl * dt);
      s.orientation.multiply(this.dq);
    }
    s.orientation.normalize();
  }

  /** Cheeseman–Bennett factor for a rotor at world position `mp` (floor and box tops below it). */
  private groundEffectAt(mp: Vector3): number {
    let h = mp.y;
    for (let i = 0; i < this.groundBoxes.length; i++) {
      const b = this.groundBoxes[i];
      const top = b.center[1] + b.half[1];
      if (mp.y < top || mp.y - top >= h) continue;
      const dx = mp.x - b.center[0];
      const dz = mp.z - b.center[2];
      const c = Math.cos(b.yaw);
      const sn = Math.sin(b.yaw);
      const lx = c * dx - sn * dz;
      const lz = sn * dx + c * dz;
      if (Math.abs(lx) <= b.half[0] && Math.abs(lz) <= b.half[2]) h = mp.y - top;
    }
    return groundEffectFactor(h, this.params.propRadius);
  }

  private collide(dt: number): void {
    const s = this.state;
    const q = s.orientation;
    this.contactCount = 0;

    for (let i = 0; i < this.sphereLocal.length; i++) {
      const c = this.sphereWorld[i].copy(this.sphereLocal[i]).applyQuaternion(q).add(s.position);
      const r = this.sphereRadius[i];
      const hit = this.hit;
      const room = this.room;
      if (room) {
        if (sphereVsPlane(c, r, 0, 1, 0, 0, hit)) this.addContact('floor', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
        if (sphereVsPlane(c, r, 0, -1, 0, -room.height, hit)) this.addContact('ceiling', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
        if (sphereVsPlane(c, r, 1, 0, 0, -room.halfX, hit)) this.addContact('wall-west', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
        if (sphereVsPlane(c, r, -1, 0, 0, -room.halfX, hit)) this.addContact('wall-east', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
        if (sphereVsPlane(c, r, 0, 0, 1, -room.halfZ, hit)) this.addContact('wall-north', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
        if (sphereVsPlane(c, r, 0, 0, -1, -room.halfZ, hit)) this.addContact('wall-south', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
      } else if (sphereVsPlane(c, r, 0, 1, 0, 0, hit)) {
        // open sky: only the ground stops the drone; leaving the level is the race's soft bounds
        this.addContact('ground', DEFAULT_RESTITUTION, DEFAULT_FRICTION, null);
      }
      for (let j = 0; j < this.colliders.length; j++) {
        const col = this.colliders[j];
        const sc = col.shape.center;
        const dx = c.x - sc[0];
        const dy = c.y - sc[1];
        const dz = c.z - sc[2];
        const reach = col.bound + r;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        if (sphereVsShape(c, r, col.shape, hit)) this.addContact(col.id, col.restitution, col.friction, col.moving ? col : null);
      }
    }
    if (this.contactCount === 0) return;
    this.resolve(dt);
  }

  private addContact(id: string, restitution: number, friction: number, moving: WorldCollider | null): void {
    if (this.contactCount >= MAX_CONTACTS) return;
    const idx = this.contactCount++;
    const c = this.contactPool[idx];
    const e = this.extras[idx];
    const s = this.state;
    c.normal.copy(this.hit.normal);
    c.depth = this.hit.depth;
    c.point.copy(this.hit.point);
    c.colliderId = id;
    e.restitution = restitution;
    e.friction = friction;
    e.normalImpulse = 0;
    e.r.copy(c.point).sub(s.position);
    if (moving) e.obstacleVelocity.crossVectors(this.fanOmega, this.tmp2.copy(c.point).sub(moving.pivot));
    else e.obstacleVelocity.set(0, 0, 0);
    const vn = this.pointVelocity(e.r, e.obstacleVelocity, this.vp).dot(c.normal);
    e.approach = vn;
    c.impactSpeed = -vn;
  }

  /** Relative velocity of the drone at lever arm r (world) w.r.t. an obstacle moving at vObs. */
  private pointVelocity(r: Vector3, vObs: Vector3, out: Vector3): Vector3 {
    const s = this.state;
    const ww = this.tmp.copy(s.angularVelocity).applyQuaternion(s.orientation);
    return out.crossVectors(ww, r).add(s.velocity).sub(vObs);
  }

  /** Effective inverse mass along world direction d at lever arm r: 1/m + (r×d)ᵀ I⁻¹ (r×d). */
  private inverseMassAlong(r: Vector3, d: Vector3): number {
    const rb = this.rB.copy(r).applyQuaternion(this.qInv);
    const db = this.nB.copy(d).applyQuaternion(this.qInv);
    const rn = this.jB.crossVectors(rb, db);
    return 1 / this.params.mass + rn.x * rn.x * this.invI[0] + rn.y * rn.y * this.invI[1] + rn.z * rn.z * this.invI[2];
  }

  /** Apply world impulse J at lever arm r (world). */
  private applyImpulse(r: Vector3, jx: number, jy: number, jz: number): void {
    const s = this.state;
    s.velocity.x += jx / this.params.mass;
    s.velocity.y += jy / this.params.mass;
    s.velocity.z += jz / this.params.mass;
    const rb = this.rB.copy(r).applyQuaternion(this.qInv);
    const jb = this.jB.set(jx, jy, jz).applyQuaternion(this.qInv);
    const t = this.nB.crossVectors(rb, jb);
    s.angularVelocity.x += t.x * this.invI[0];
    s.angularVelocity.y += t.y * this.invI[1];
    s.angularVelocity.z += t.z * this.invI[2];
  }

  private resolve(dt: number): void {
    const s = this.state;
    const n = this.contactCount;
    this.qInv.copy(s.orientation).invert();

    // 1) Positional projection without double counting contacts that share a direction.
    const shift = this.shift.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const c = this.contactPool[i];
      const want = (c.depth - SLOP) * POSITION_CORRECTION;
      if (want <= 0) continue;
      const already = shift.dot(c.normal);
      if (want > already) shift.addScaledVector(c.normal, want - already);
    }
    s.position.add(shift);

    // 2) Normal impulses (sequential, accumulated & clamped), restitution from the pre-step approach speed.
    for (let it = 0; it < VELOCITY_ITERATIONS; it++) {
      for (let i = 0; i < n; i++) {
        const c = this.contactPool[i];
        const e = this.extras[i];
        const vn = this.pointVelocity(e.r, e.obstacleVelocity, this.vp).dot(c.normal);
        const approach = -e.approach;
        const target = approach > RESTITUTION_THRESHOLD ? e.restitution * approach : 0;
        let dj = (target - vn) / this.inverseMassAlong(e.r, c.normal);
        const acc = Math.max(0, e.normalImpulse + dj);
        dj = acc - e.normalImpulse;
        e.normalImpulse = acc;
        if (dj !== 0) this.applyImpulse(e.r, c.normal.x * dj, c.normal.y * dj, c.normal.z * dj);
      }
    }

    // 3) Coulomb friction, bounded by each contact's normal impulse.
    let resting = false;
    for (let i = 0; i < n; i++) {
      const c = this.contactPool[i];
      const e = this.extras[i];
      if (e.normalImpulse <= 0) continue;
      if (c.normal.y > 0.7 && -e.approach < 0.5 && s.velocity.lengthSq() < 1) resting = true;
      const v = this.pointVelocity(e.r, e.obstacleVelocity, this.vp);
      const vn = v.dot(c.normal);
      const t = v.addScaledVector(c.normal, -vn);
      const vt = t.length();
      if (vt < 1e-9) continue;
      t.divideScalar(vt);
      const jt = Math.min(vt / this.inverseMassAlong(e.r, t), e.friction * e.normalImpulse);
      this.applyImpulse(e.r, -t.x * jt, -t.y * jt, -t.z * jt);
    }

    // 4) Rolling resistance while resting: kills the neutral rocking of a sphere-bottomed body.
    if (resting) s.angularVelocity.multiplyScalar(Math.exp(-ROLLING_DAMPING * dt));

    for (let i = 0; i < n; i++) {
      // keep the reported point/depth consistent with the projected position
      this.contactPool[i].depth = Math.max(0, this.contactPool[i].depth - shift.dot(this.contactPool[i].normal));
    }
  }

  /** Render interpolation between prevState (alpha=0) and state (alpha=1). */
  interpolate(alpha: number, out: DroneState): DroneState {
    const a = this.prevState;
    const b = this.state;
    out.position.lerpVectors(a.position, b.position, alpha);
    out.velocity.lerpVectors(a.velocity, b.velocity, alpha);
    out.orientation.slerpQuaternions(a.orientation, b.orientation, alpha);
    out.angularVelocity.lerpVectors(a.angularVelocity, b.angularVelocity, alpha);
    for (let i = 0; i < 4; i++) out.motors[i] = a.motors[i] + (b.motors[i] - a.motors[i]) * alpha;
    out.armed = b.armed;
    out.batteryVoltage = b.batteryVoltage;
    return out;
  }
}

/** Cheeseman–Bennett ground-effect thrust ratio for a rotor of radius R at height h. */
export function groundEffectFactor(h: number, R: number): number {
  const q = R / 4;
  if (h <= q * 1.05) return GROUND_EFFECT_MAX;
  const x = q / h;
  const f = 1 / (1 - x * x);
  return f > GROUND_EFFECT_MAX ? GROUND_EFFECT_MAX : f;
}
