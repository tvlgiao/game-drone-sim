/**
 * Night-loft material set, owned by the loft view (built per level, disposed with it). Few materials on
 * purpose: tints, roughness and metalness of the small props ride on vertex attributes so the whole room
 * draws in ~20 calls. The floor and glass reflect a box-projected probe of the room itself.
 */
import * as THREE from 'three';
import { radialTexture } from '../textures';
import { decalAtlas, neonAtlas } from './loft-canvas';
import { brickSets, concreteSet, cookieMap, floorMacro, glassDirt, grungeOrm, leafMap, leatherSet, rugMap, weaveNormal, woodSet, type PbrSet } from './loft-textures';
import { applyEnvPatch, type BoxProjection } from './patches';
import { texSize } from './texgen';

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

export class LoftMaterials {
  readonly textures: THREE.Texture[] = [];
  readonly all: THREE.Material[] = [];

  readonly floor: THREE.MeshStandardMaterial;
  readonly brick: THREE.MeshStandardMaterial;
  readonly paintedBrick: THREE.MeshStandardMaterial;
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

  constructor(o: LoftMaterialOptions) {
    const [sx, sy, sz] = o.room;
    const big = texSize(1024, o.maxTexture);
    const mid = texSize(512, o.maxTexture);
    const small = texSize(256, o.maxTexture);
    const an = Math.min(o.anisotropy, 8);
    const tex = <T extends THREE.Texture>(t: T): T => {
      t.anisotropy = Math.max(t.anisotropy, an);
      this.textures.push(t);
      return t;
    };
    const reg = <M extends THREE.Material>(m: M): M => {
      this.all.push(m);
      return m;
    };
    const set = (s: PbrSet): PbrSet => {
      tex(s.map);
      tex(s.normalMap);
      tex(s.orm);
      return s;
    };

    this.box = {
      min: new THREE.Vector3(-sx / 2, 0, -sz / 2),
      max: new THREE.Vector3(sx / 2, sy, sz / 2),
      probe: new THREE.Vector3(0, 2.2, 0),
    };

    const grunge = tex(grungeOrm(mid, an));
    const fl = set(concreteSet(big, an));
    const macro = tex(floorMacro(sx, sz, mid, o.puddles));
    this.floor = reg(
      applyEnvPatch(
        new THREE.MeshStandardMaterial({ map: fl.map, normalMap: fl.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: fl.orm, aoMap: fl.orm, roughness: 1, metalness: 0, color: 0xe2ddd6, envMapIntensity: 1 }),
        { box: this.box, macro: { texture: macro, min: new THREE.Vector2(-sx / 2, -sz / 2), size: new THREE.Vector2(sx, sz) } },
      ),
    );

    const bricks = brickSets(big, an);
    set(bricks.red);
    tex(bricks.painted.map);
    tex(bricks.painted.orm);
    const grime = { texture: grunge, scale: 0.21, low: 0.7, top: sy };
    this.brick = reg(
      applyEnvPatch(new THREE.MeshStandardMaterial({ map: bricks.red.map, normalMap: bricks.red.normalMap, roughnessMap: bricks.red.orm, aoMap: bricks.red.orm, roughness: 1, metalness: 0, envMapIntensity: 0.4 }), { grime }),
    );
    this.paintedBrick = reg(
      applyEnvPatch(new THREE.MeshStandardMaterial({ map: bricks.painted.map, normalMap: bricks.painted.normalMap, roughnessMap: bricks.painted.orm, aoMap: bricks.painted.orm, roughness: 1, metalness: 0, color: 0xd9d2c8, envMapIntensity: 0.45 }), { grime }),
    );

    const cc = set(concreteSet(mid, an, { seed: 8, joints: false, rough: 0.78 }));
    this.concrete = reg(applyEnvPatch(new THREE.MeshStandardMaterial({ map: cc.map, normalMap: cc.normalMap, roughnessMap: cc.orm, aoMap: cc.orm, roughness: 1, color: 0xcfc8be, envMapIntensity: 0.5 }), { grime }));

    const wd = set(woodSet(mid, an));
    this.wood = reg(new THREE.MeshStandardMaterial({ vertexColors: true, map: wd.map, normalMap: wd.normalMap, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: wd.orm, aoMap: wd.orm, roughness: 1, metalness: 0, envMapIntensity: 0.7 }));

    this.props = reg(applyEnvPatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughnessMap: grunge, roughness: 1, metalness: 1, envMapIntensity: 1 }), { vertexRM: true }));

    const lth = leatherSet(small, an);
    tex(lth.normalMap);
    tex(lth.orm);
    this.leather = reg(new THREE.MeshPhysicalMaterial({ color: 0x7c3a1e, normalMap: lth.normalMap, roughnessMap: lth.orm, roughness: 1, clearcoat: 0.3, clearcoatRoughness: 0.45, sheen: 0.25, sheenColor: new THREE.Color(0xc98a62), sheenRoughness: 0.6, envMapIntensity: 0.9 }));
    const weave = tex(weaveNormal(small, an));
    this.fabric = reg(new THREE.MeshPhysicalMaterial({ color: 0x1d5a64, roughness: 0.9, normalMap: weave, normalScale: new THREE.Vector2(0.5, 0.5), sheen: 1, sheenColor: new THREE.Color(0x7fd6e0), sheenRoughness: 0.45 }));
    const leaf = tex(leafMap(small));
    this.leaf = reg(new THREE.MeshStandardMaterial({ map: leaf, roughness: 0.48, side: THREE.DoubleSide, envMapIntensity: 0.6 }));
    const rug = rugMap(big, an);
    tex(rug.map);
    tex(rug.normalMap);
    this.rug = reg(new THREE.MeshStandardMaterial({ map: rug.map, normalMap: rug.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 1, envMapIntensity: 0.2 }));

    const dirt = tex(glassDirt(mid));
    this.glass = reg(
      applyEnvPatch(
        new THREE.MeshStandardMaterial({ map: dirt, color: 0xc4d0d8, roughness: 0.04, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.3 }),
        { box: this.box, glass: { clearAlpha: 0.035, dirtRoughness: 0.55 } },
      ),
    );

    this.glow = reg(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    this.bulbShell = reg(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 0.28, 0.14), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    const neon = tex(neonAtlas(texSize(1024, o.maxTexture)));
    this.neon = reg(new THREE.MeshBasicMaterial({ map: neon, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.radial = tex(radialTexture(128));
    this.spill = reg(new THREE.MeshBasicMaterial({ map: this.radial, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const decals = tex(decalAtlas(texSize(2048, o.maxTexture)));
    this.decals = reg(new THREE.MeshStandardMaterial({ map: decals, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.78, metalness: 0, envMapIntensity: 0.35 }));
    this.cookie = tex(cookieMap(small));
  }

  /** Point floor and glass at the room probe (on every tier: one box-projected lookup is cheap). */
  setProbe(env: THREE.Texture): void {
    for (const m of [this.floor, this.glass]) {
      m.envMap = env;
      m.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
