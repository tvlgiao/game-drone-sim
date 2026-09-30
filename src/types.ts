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
    | 'fan';
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

export interface LevelDef {
  name: string;
  room: RoomDef;
  props: PropDef[];
  rings: RingDef[];
  spawn: { position: [number, number, number]; yaw: number };
  /** LOS camera position (pilot standing) */
  pilot: [number, number, number];
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
  | { type: 'countdown'; value: number };

export type CameraMode = 'fpv' | 'chase' | 'los';

export type QualityTier = 'ultra' | 'high' | 'medium' | 'low';
