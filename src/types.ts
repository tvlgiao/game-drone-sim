/**
 * Shared contracts between simulation, input, game and render layers.
 * Simulation modules (physics/control/game) must stay free of DOM and render imports.
 * Units: SI (m, kg, s, rad, N). World: +Y up. Body: +Y thrust axis, -Z forward, +X right.
 */
import type { Quaternion, Vector3 } from 'three';

/** Normalised pilot command after deadzone; rates/expo are applied by the flight controller. */
export interface ControlInput {
  /** 0..1 */
  throttle: number;
  /** -1..1, + = yaw right (clockwise seen from above) */
  yaw: number;
  /** -1..1, + = nose down / fly forward */
  pitch: number;
  /** -1..1, + = roll right */
  roll: number;
}

/** Edge-triggered buttons, true only on the frame they were pressed. */
export interface ButtonEvents {
  arm: boolean;
  toggleMode: boolean;
  cycleCamera: boolean;
  reset: boolean;
  pause: boolean;
  confirm: boolean;
  /** heading-arrow toggle */
  headingArrow: boolean;
  /** VR: recentre the view (keyboard: also centres the mouse stick) */
  recenter: boolean;
}

export type InputSource = 'gamepad' | 'keyboard' | 'touch' | 'xr' | 'none';

/** Edge-triggered menu navigation (d-pad / left stick flick / arrows / Enter / Esc / B). */
export interface NavEvents {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  back: boolean;
}

/** Physical stick positions −1..1 (X +right, Y +up). */
export interface StickPositions {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

/** Raw live values of the active gamepad (arrays are reused between frames). */
export interface RawPad {
  id: string;
  /** 'standard' or '' (non-standard layout) */
  mapping: string;
  axes: readonly number[];
  /** analog value 0..1 per button */
  buttons: readonly number[];
}

export interface InputFrame {
  control: ControlInput;
  buttons: ButtonEvents;
  nav: NavEvents;
  source: InputSource;
  gamepadId: string | null;
  /** processed stick positions (after deadzone / square gate) for the visualiser; keyboard / touch = virtual sticks */
  sticks: StickPositions;
  pad: RawPad | null;
  /** WebXR controller button edges (A/B/X/Y, stick clicks) while an XR session runs, else null */
  xr: XrButtonEdges | null;
}

/** Rising edges of the Quest Touch buttons for one frame. */
export interface XrButtonEdges {
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  rStick: boolean;
  lStick: boolean;
  /** left index trigger */
  lTrigger: boolean;
}

export type FlightMode = 'acro' | 'angle';

/** Per-axis rate profiles (Betaflight rateprofile). */
export interface AxisRates {
  roll: RateProfile;
  pitch: RateProfile;
  yaw: RateProfile;
}

export interface RateProfile {
  /** deg/s at stick centre (Betaflight Actual "center sensitivity") */
  center: number;
  /** deg/s at full stick */
  max: number;
  /** 0..1 */
  expo: number;
}

/** Full rigid-body state; vectors in world frame except angularVelocity (body frame). */
export interface DroneState {
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  angularVelocity: Vector3;
  /** lagged normalised motor speeds 0..1, order: FR, RL, FL, RR (Betaflight quad-X) */
  motors: [number, number, number, number];
  armed: boolean;
  batteryVoltage: number;
}

export interface Contact {
  /** unit normal pointing from obstacle towards the drone */
  normal: Vector3;
  depth: number;
  point: Vector3;
  /** closing speed along normal before response, m/s (positive = impact) */
  impactSpeed: number;
  colliderId: string;
}

/** Collision shapes; all positions world-space metres. */
export type ColliderShape =
  | { kind: 'box'; center: [number, number, number]; half: [number, number, number]; yaw?: number }
  | { kind: 'cylinder'; center: [number, number, number]; radius: number; halfHeight: number }
  | {
      kind: 'torus';
      center: [number, number, number];
      /** ring normal (direction of travel), unit */
      normal: [number, number, number];
      majorRadius: number;
      tubeRadius: number;
    };

export interface Collider {
  id: string;
  shape: ColliderShape;
  restitution?: number;
  friction?: number;
  /** if set, the collider is kinematic and its shape is updated each step by the world */
  dynamic?: 'fan';
}

export interface RingDef {
  id: string;
  position: [number, number, number];
  /** direction the drone must travel through the ring */
  direction: [number, number, number];
  /** inner (flyable) radius in metres */
  radius: number;
  tube: number;
}

/** Visual-only or visual+collider furniture. Render layer builds meshes from `kind`. */
export interface PropDef {
  id: string;
  kind:
    | 'sofa'
    | 'table'
    | 'shelf'
    | 'pillar'
    | 'lamp-floor'
    | 'bulb-hanging'
    | 'crate'
    | 'rug'
    | 'plant'
    | 'tv-wall'
    | 'beam'
    | 'duct'
    | 'fan'
    | 'pad'
    | 'pole'
    | 'cone'
    | 'windsock'
    | 'tree'
    | 'hill';
  position: [number, number, number];
  /** size in metres (w, h, d) for box-like props; for pillar (diameter, height, _) */
  size: [number, number, number];
  yaw?: number;
  /** collider(s) produced from this prop (empty for rugs etc.) */
  colliders: Collider[];
}

export interface RoomDef {
  /** interior size (x, y, z) metres; floor at y=0, centred on x/z origin */
  size: [number, number, number];
  windows: { wall: 'north' | 'south' | 'east' | 'west'; center: [number, number]; size: [number, number] }[];
}

/** Authored room level data (the loft's data file shape); `IndoorLevel` adds identity, environment and bounds. */
export interface RoomLevelData {
  name: string;
  room: RoomDef;
  props: PropDef[];
  rings: RingDef[];
  spawn: { position: [number, number, number]; yaw: number };
  /** LOS camera position (pilot standing) */
  pilot: [number, number, number];
}

export type LevelId = 'tutorial' | 'training' | 'night-loft' | 'city' | 'alpine' | 'infinite';

export interface SkyDef {
  /** zenith colour */
  top: number;
  horizon: number;
  /** unit vector towards the sun */
  sunDir: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  /** hemisphere light: sky colour, ground colour */
  hemi: [number, number];
  /** fog / haze colour where it differs from `horizon` (dusk: the horizon glows only towards the sun) */
  haze?: number;
}

export interface EnvDef {
  sky: 'night-loft' | SkyDef;
  /** generated outdoor levels: the sky preset `sky` came from (levels/skies.ts), so a time-of-day pick can swap it */
  time?: 'dawn' | 'noon' | 'golden' | 'dusk' | 'afternoon' | 'alpine';
  /** distance of 1 % visibility; FogExp2 density = 2.15 / viewDistance */
  fog: { color: number; viewDistance: number };
  ambience: { kind: 'room' | 'wind'; gain: number };
  shadows: 'static-spots' | 'static-sun' | 'sun-follow' | 'none';
}

/** Soft limits checked by the race; indoor levels keep the hard room planes in PhysicsWorld. */
export interface WorldBounds {
  kind: 'room' | 'rect' | 'infinite';
  /** x, z */
  min?: [number, number];
  max?: [number, number];
  /** altitude cap above ground */
  maxAgl: number;
}

export interface LevelBase {
  id: LevelId;
  name: string;
  env: EnvDef;
  bounds: WorldBounds;
  /** may be empty (free-fly-only levels) */
  rings: RingDef[];
  spawn: { position: [number, number, number]; yaw: number };
  /** LOS spot; y = ground + 1.7 outdoors */
  pilot: [number, number, number];
  /** XR deck height above ground (loft 2.4, outdoor 2.0) */
  pilotPlatform: number;
  /** best-time storage key when it is not the level id (Infinite: one per world code) */
  bestKey?: string;
}

export interface IndoorLevel extends LevelBase {
  kind: 'indoor';
  room: RoomDef;
  props: PropDef[];
}

export type WorldSpec =
  | { gen: 'flat' }
  | { gen: 'terrain'; genVersion: number; seed: number; preset: 'training' | 'alpine' | 'infinite' }
  | { gen: 'city'; genVersion: number; seed: number };

export interface OutdoorLevel extends LevelBase {
  kind: 'outdoor';
  world: WorldSpec;
  /** authored set pieces: meshes by kind plus their colliders */
  props: PropDef[];
  /** extra colliders that belong to no prop */
  statics: Collider[];
  /**
   * Free-roaming levels: re-plant the LOS pilot behind the drone when it flies out of range or stays
   * hidden behind terrain (outside VR). Fixed-route levels (Training, City) leave it off.
   */
  relocatePilot?: boolean;
}

export type LevelDef = IndoorLevel | OutdoorLevel;

/** Ground height field of an outdoor level; null on flat ground, where the ground is y = 0. */
export interface TerrainField {
  heightAt(x: number, z: number): number;
}

export type RaceStatus = 'menu' | 'countdown' | 'racing' | 'crashed' | 'finished' | 'paused' | 'freefly';

export interface RaceSnapshot {
  status: RaceStatus;
  /** seconds since GO (excluding pause) */
  time: number;
  countdown: number;
  nextRing: number;
  totalRings: number;
  bestTime: number | null;
  lastSplit: number | null;
}

/** Events emitted by simulation for audio/vfx/ui/rumble. */
export type GameEvent =
  | { type: 'ring-passed'; index: number; position: Vector3 }
  | { type: 'collision'; contact: Contact }
  | { type: 'crash'; position: Vector3; speed: number }
  | { type: 'respawn' }
  | { type: 'armed'; armed: boolean }
  | { type: 'race-start' }
  | { type: 'race-finish'; time: number; best: boolean }
  | { type: 'countdown'; value: number }
  /** left the level bounds; `seconds` until the automatic respawn, re-sent as it counts down */
  | { type: 'out-of-bounds'; seconds: number }
  | { type: 'in-bounds' };

export type CameraMode = 'fpv' | 'chase' | 'los';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';
