/**
 * Night-loft palette, built from the material library (a per-level scope, freed with the loft). Few
 * materials on purpose: tints, roughness and metalness of the small props ride on vertex attributes so the
 * whole room draws in ~20 calls. Floor and glass reflect a box-projected probe of the room itself (the
 * GameView's captured environment, `setProbe`).
 *
 * Surfaces with a CC0 scan (slab and sills: concrete, walls: brick / painted brick, columns: plaster, deck and
 * door: wood) are library presets, so the scans replace the procedural maps on tiers that load them; the
 * loft's own patches (floor macro + puddles, wall grime, box projection, dirty glass) ride on top.
 */
import * as THREE from 'three';
import { radialTexture } from '../textures';
import type { MaterialSource } from '../materials/library';
import { cookieMap, floorMacro, glassDirt, leafMap, leatherSet, rugMap, weaveNormal } from '../materials/generators';
import { applyEnvPatch, type BoxProjection, type EnvPatch, type WallGrime } from '../materials/patches';
import { texSize } from '../materials/texgen';
import { decalAtlas, neonAtlas } from './art';

export interface LoftMaterialOptions {
  anisotropy: number;
  /** canvas / data texture size cap (mobile memory budget) */
  maxTexture: number;
  /** interior size x, y, z (m) */
  room: readonly [number, number, number];
  /** world-space puddles on the floor (rain under the windows) */
  puddles: readonly { x: number; z: number; r: number }[];
}

/** Tint / roughness / metalness presets for the merged prop material (`props`). */
export const FINISH = {
  steelPaint: { color: 0x2a201d, rm: [0.5, 0] },
  steelDark: { color: 0x2b2f34, rm: [0.42, 0.8] },
  steelBlack: { color: 0x121315, rm: [0.5, 0.6] },
  galvanized: { color: 0xc3c9cf, rm: [0.4, 0.88] },
  brass: { color: 0xc89b4a, rm: [0.28, 1] },
  copper: { color: 0xc9774a, rm: [0.3, 1] },
  rubber: { color: 0x0d0d0e, rm: [0.75, 0] },
  ceramic: { color: 0xe8e2d8, rm: [0.22, 0] },
  enamelGreen: { color: 0x2f4a3c, rm: [0.3, 0] },
  terracotta: { color: 0xa65a3a, rm: [0.85, 0] },
  soil: { color: 0x2b1d14, rm: [1, 0] },
  paper: { color: 0xe6dcc6, rm: [0.9, 0] },
  plasticDark: { color: 0x1d1f23, rm: [0.4, 0] },
  bezel: { color: 0x08090b, rm: [0.2, 0.2] },
  cardboard: { color: 0xa57a4f, rm: [0.95, 0] },
} as const satisfies Record<string, { color: number; rm: readonly [number, number] }>;

/** Wood tints over the neutral plank texture. */
export const WOOD = { oak: 0xd9a46c, walnut: 0x7d5238, pine: 0xf0cf98, deck: 0x5a3f2c, crate: 0xc9a06a } as const;

/** UV metres the room builders map each surface with (batcher `uvTile`): the library scales the set to it. */
export const LOFT_UV = { floor: 4, brick: 1.2, plaster: 1.4, concrete: 1.5, wood: 1 } as const;

export class LoftMaterials {
  readonly floor: THREE.MeshStandardMaterial;
  readonly brick: THREE.MeshStandardMaterial;
  readonly paintedBrick: THREE.MeshStandardMaterial;
  readonly plaster: THREE.MeshStandardMaterial;
  readonly concrete: THREE.MeshStandardMaterial;
  readonly wood: THREE.MeshStandardMaterial;
  /** merged small props: vertex colour + `aRM` (roughness, metalness) */
  readonly props: THREE.MeshStandardMaterial;
  readonly leather: THREE.MeshPhysicalMaterial;
  readonly fabric: THREE.MeshPhysicalMaterial;
  readonly leaf: THREE.MeshStandardMaterial;
  readonly rug: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  /** unlit HDR vertex colour: filaments, lamp diffusers, LED strips */
  readonly glow: THREE.MeshBasicMaterial;
  /** additive bulb envelopes */
  readonly bulbShell: THREE.MeshBasicMaterial;
  /** additive neon tubes from the atlas, vertex colour per sign */
  readonly neon: THREE.MeshBasicMaterial;
  /** additive soft radial glow on walls / floor (neon spill, light pools) */
  readonly spill: THREE.MeshBasicMaterial;
  readonly decals: THREE.MeshStandardMaterial;
  readonly cookie: THREE.Texture;
  readonly radial: THREE.Texture;
  /** box projection of the room, shared by floor and glass */
  readonly box: BoxProjection;

  constructor(lib: MaterialSource, o: LoftMaterialOptions) {
    const [sx, sy, sz] = o.room;
    const big = texSize(1024, o.maxTexture);
    const mid = texSize(512, o.maxTexture);
    const small = texSize(256, o.maxTexture);
    const an = Math.min(o.anisotropy, 8);

    this.box = {
      min: new THREE.Vector3(-sx / 2, 0, -sz / 2),
      max: new THREE.Vector3(sx / 2, sy, sz / 2),
      probe: new THREE.Vector3(0, 2.2, 0),
    };

    const grunge = lib.grunge();
    const macro = lib.texture('loft:floor-macro', () => floorMacro(sx, sz, mid, o.puddles));
    const floorPatch: EnvPatch = { box: this.box, macro: { texture: macro, min: new THREE.Vector2(-sx / 2, -sz / 2), size: new THREE.Vector2(sx, sz) } };
    // authored mean albedos: the scans bring their detail, the loft keeps its polished pale slab and
    // light sills whatever set is bound
    this.floor = lib.material('slab', { uvMeters: LOFT_UV.floor, albedo: 0x67635e, normalScale: 0.6, envMapIntensity: 1, patch: floorPatch });

    const grime: WallGrime = { texture: grunge, scale: 0.21, low: 0.7, top: sy };
    const wallPatch: EnvPatch = { grime };
    this.brick = lib.material('brick', { uvMeters: LOFT_UV.brick, envMapIntensity: 0.4, patch: wallPatch });
    this.paintedBrick = lib.material('paintedBrick', { uvMeters: LOFT_UV.brick, color: 0xd9d2c8, envMapIntensity: 0.45, patch: wallPatch });
    this.plaster = lib.material('plaster', { uvMeters: LOFT_UV.plaster, albedo: 0xa7a199, normalScale: 0.7, envMapIntensity: 0.45, patch: wallPatch });
    this.concrete = lib.material('concrete', { uvMeters: LOFT_UV.concrete, albedo: 0x8c877f, envMapIntensity: 0.5, patch: wallPatch });
    this.wood = lib.material('wood', { uvMeters: LOFT_UV.wood, vertexColors: true, normalScale: 0.7, envMapIntensity: 0.7 });

    this.props = lib.custom('loft:props', () =>
      applyEnvPatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughnessMap: grunge, roughness: 1, metalness: 1, envMapIntensity: 1 }), { vertexRM: true }),
    );
    this.leather = lib.custom('loft:leather', (track) => {
      const lth = leatherSet(small, an);
      return new THREE.MeshPhysicalMaterial({
        color: 0x7c3a1e,
        normalMap: track(lth.normalMap),
        roughnessMap: track(lth.orm),
        roughness: 1,
        clearcoat: 0.3,
        clearcoatRoughness: 0.45,
        sheen: 0.25,
        sheenColor: new THREE.Color(0xc98a62),
        sheenRoughness: 0.6,
        envMapIntensity: 0.9,
      });
    });
    this.fabric = lib.custom(
      'loft:fabric',
      (track) =>
        new THREE.MeshPhysicalMaterial({ color: 0x1d5a64, roughness: 0.9, normalMap: track(weaveNormal(small, an)), normalScale: new THREE.Vector2(0.5, 0.5), sheen: 1, sheenColor: new THREE.Color(0x7fd6e0), sheenRoughness: 0.45 }),
    );
    this.leaf = lib.custom('loft:leaf', (track) => new THREE.MeshStandardMaterial({ map: track(leafMap(small)), roughness: 0.48, side: THREE.DoubleSide, envMapIntensity: 0.6 }));
    this.rug = lib.custom('loft:rug', (track) => {
      const rug = rugMap(big, an);
      return new THREE.MeshStandardMaterial({ map: track(rug.map), normalMap: track(rug.normalMap), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 1, envMapIntensity: 0.2 });
    });
    this.glass = lib.custom('loft:glass', (track) =>
      applyEnvPatch(
        new THREE.MeshStandardMaterial({ map: track(glassDirt(mid)), color: 0xc4d0d8, roughness: 0.04, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.3 }),
        { box: this.box, glass: { clearAlpha: 0.035, dirtRoughness: 0.55 } },
      ),
    );

    this.glow = lib.custom('loft:glow', () => new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    this.bulbShell = lib.custom('loft:bulb-shell', () => new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.28, 0.14), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.neon = lib.custom(
      'loft:neon',
      (track) => new THREE.MeshBasicMaterial({ map: track(neonAtlas(texSize(1024, o.maxTexture))), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.spill = lib.custom('loft:spill', (track) => new THREE.MeshBasicMaterial({ map: track(radialTexture(128)), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.radial = this.spill.map!;
    this.decals = lib.custom(
      'loft:decals',
      (track) =>
        new THREE.MeshStandardMaterial({
          map: track(decalAtlas(texSize(2048, Math.max(1024, o.maxTexture)))),
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
          roughness: 0.78,
          metalness: 0,
          envMapIntensity: 0.35,
        }),
    );
    this.cookie = lib.texture('loft:cookie', () => cookieMap(small));
  }

  /** Point floor and glass at the room probe (on every tier: one box-projected lookup is cheap). */
  setProbe(env: THREE.Texture): void {
    for (const m of [this.floor, this.glass]) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }
}
