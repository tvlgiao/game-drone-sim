/** Render seam between GameView and a level's scenery (room or outdoor set): built per level, disposed on switch. */
import type * as THREE from 'three';
import type { QualityProfile } from '../core/quality';
import type { WorldTime } from './looks';
import type { WaterProbe } from './vfx/director';

export interface LevelFrame {
  time: number;
  dt: number;
  /** pixels per unit of tan(angle) of the rendering camera (particle sizing) */
  px: number;
  drone: THREE.Vector3;
  /** eye position of the rendering camera */
  camera: THREE.Vector3;
  /** 0..1 prop-wash strength near the surface below the drone */
  wash: number;
  fanAngle: number;
}

export interface LevelProbe {
  position: THREE.Vector3;
  near: number;
  far: number;
  /** smallest cube face size, whatever the tier's envSize (the loft's box-projected floor needs detail) */
  minSize: number;
  /** capture even on tiers without envMap: the level's own materials reflect it on every tier */
  always: boolean;
}

export interface LevelView {
  /** everything the level adds to the scene (meshes, lights) */
  readonly group: THREE.Group;
  /** pulses at the next ring (GameView drives it) */
  readonly ringLight: THREE.PointLight;
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  /**
   * Stand-in environment (an analytic sky or a dark room) for when the capture of the level fails; the
   * GameView normally captures the level itself from `probe` (ibl.ts) and uses that instead.
   */
  readonly environment: THREE.Texture;
  readonly environmentIntensity: number;
  /** where and how the GameView captures the level's environment (PMREM + SH light probe) */
  readonly probe: LevelProbe;
  /** the captured environment, for the level's own env-mapped materials (box-projected floor, glass) */
  setEnvironment(env: THREE.Texture): void;
  /** post FX bloom luminance threshold */
  readonly bloomThreshold: number;
  update(f: LevelFrame): void;
  setQuality(p: QualityProfile): void;
  /** re-render static shadow maps on the next frame */
  refreshShadows(): void;
  /** frees every GPU resource the level created; the shared Materials stay */
  dispose(): void;
  /** camera far plane the scenery needs (default: the camera rig's) */
  readonly cameraFar?: number;
  /** adaptive view distance: < 1 shrinks fog and streaming radius (render scale stuck at its floor) */
  setViewScale?(k: number): void;
  /** still streaming: main keeps drawing still frames behind menus so chunks upload */
  readonly busy?: boolean;
  /** streaming / instancing numbers for the debug hook */
  stats?(): Record<string, unknown>;
  /** view distance the sun cascades cover (m; default shadows.ts CASCADE_FAR) */
  readonly shadowFar?: number;
  /** water surface under (x, z) (−Infinity: dry): prop-wash spray, wash height over water */
  readonly waterProbe?: WaterProbe;
  /** generated levels: the sky preset drawn now, and a new one (time of day) */
  readonly time?: WorldTime;
  setTime?(time: WorldTime): void;
  /** generated levels: the pilot's View distance (1 = the tier's own) */
  setViewDistance?(k: number): void;
}
