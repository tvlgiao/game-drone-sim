/** Flight controller + physics world wired together at the fixed physics rate. */
import type { Vector3 } from 'three';
import type { Contact, ControlInput, LevelDef } from '../types';
import { FlightController } from '../control/flight-controller';
import { DEFAULT_DRONE, type DroneParams } from './drone-params';
import { PhysicsWorld } from './physics-world';

export class Simulation {
  readonly world: PhysicsWorld;
  readonly fc: FlightController;

  constructor(level: LevelDef, params: DroneParams = DEFAULT_DRONE, seed = 1) {
    this.world = new PhysicsWorld(level, params);
    this.fc = new FlightController(params, seed);
  }

  /** fc.update → world.step; keeps state.armed/motors in sync. */
  step(dt: number, input: ControlInput): readonly Contact[] {
    const cmd = this.fc.update(dt, input, this.world.state);
    const contacts = this.world.step(dt, cmd);
    this.world.state.armed = this.fc.armed;
    return contacts;
  }

  /** Arm/disarm through the FC safety checks; returns the resulting armed state. */
  setArmed(armed: boolean, input: ControlInput): boolean {
    const a = this.fc.setArmed(armed, input, this.world.state);
    this.world.state.armed = a;
    return a;
  }

  /** Teleport (respawn) the drone; FC loops are cleared, armed state is kept. */
  reset(position: Vector3, yaw: number, refillBattery = true): void {
    this.world.reset(position, yaw, refillBattery);
    this.fc.reset();
    this.world.state.armed = this.fc.armed;
    this.world.prevState.armed = this.fc.armed;
  }
}
