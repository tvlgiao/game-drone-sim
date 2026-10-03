/** Render seam between GameView and a level's scenery (room or outdoor set): built per level, disposed on switch. */
import type * as THREE from 'three';
import type { QualityProfile } from '../core/quality';

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

export interface LevelView {
  /** everything the level adds to the scene (meshes, lights) */
  readonly group: THREE.Group;
  /** pulses at the next ring (GameView drives it) */
  readonly ringLight: THREE.PointLight;
  readonly background: THREE.Color;
  readonly fog: THREE.FogExp2;
  /** PMREM environment (reflections), applied on tiers with envMap */
  readonly environment: THREE.Texture;
  readonly environmentIntensity: number;
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
}
