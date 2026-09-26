/** Shared material library for the loft scene. Created once per GameView, disposed with it. */
import * as THREE from 'three';
import {
  brickMaps,
  carbonMaps,
  concreteMaps,
  plasterMaps,
  rugTexture,
  skylineTexture,
  woodMaps,
  batteryTexture,
  radialTexture,
  neonTexture,
} from './textures';

export class Materials {
  readonly textures: THREE.Texture[] = [];
  readonly all: THREE.Material[] = [];

  readonly floor: THREE.MeshStandardMaterial;
  readonly brick: THREE.MeshStandardMaterial;
  readonly plaster: THREE.MeshStandardMaterial;
  readonly ceiling: THREE.MeshStandardMaterial;
  readonly concrete: THREE.MeshStandardMaterial;
  readonly steelDark: THREE.MeshStandardMaterial;
  readonly steelBlack: THREE.MeshStandardMaterial;
  readonly galvanized: THREE.MeshStandardMaterial;
  readonly brass: THREE.MeshStandardMaterial;
  readonly oak: THREE.MeshStandardMaterial;
  readonly walnut: THREE.MeshStandardMaterial;
  readonly pine: THREE.MeshStandardMaterial;
  readonly fabric: THREE.MeshPhysicalMaterial;
  readonly leather: THREE.MeshPhysicalMaterial;
  readonly leaf: THREE.MeshStandardMaterial;
  readonly ceramic: THREE.MeshPhysicalMaterial;
  readonly painted: THREE.MeshStandardMaterial;
  readonly rug: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshPhysicalMaterial;
  readonly bulbGlow: THREE.MeshStandardMaterial;
  readonly lampGlow: THREE.MeshStandardMaterial;
  readonly cord: THREE.MeshStandardMaterial;
  readonly skyline: THREE.MeshBasicMaterial;
  readonly neon: THREE.MeshBasicMaterial;
  readonly tvBezel: THREE.MeshPhysicalMaterial;

  // drone
  readonly carbon: THREE.MeshPhysicalMaterial;
  readonly anodized: THREE.MeshPhysicalMaterial;
  readonly aluminium: THREE.MeshStandardMaterial;
  readonly copper: THREE.MeshStandardMaterial;
  readonly motorBase: THREE.MeshStandardMaterial;
  readonly tpu: THREE.MeshPhysicalMaterial;
  readonly propMat: THREE.MeshPhysicalMaterial;
  readonly battery: THREE.MeshPhysicalMaterial;
  readonly strap: THREE.MeshStandardMaterial;
  readonly camBody: THREE.MeshStandardMaterial;
  readonly lens: THREE.MeshPhysicalMaterial;
  readonly pcb: THREE.MeshStandardMaterial;
  readonly wireRed: THREE.MeshStandardMaterial;
  readonly wireBlack: THREE.MeshStandardMaterial;
  readonly connector: THREE.MeshStandardMaterial;

  readonly radial: THREE.Texture;

  /** `maxTexture` caps canvas texture size (mobile memory budget). */
  constructor(anisotropy: number, maxTexture = 2048) {
    const tex = <T extends THREE.Texture>(t: T): T => {
      t.anisotropy = Math.min(anisotropy, 8);
      this.textures.push(t);
      return t;
    };
    const reg = <M extends THREE.Material>(m: M): M => {
      this.all.push(m);
      return m;
    };

    const conc = concreteMaps(1024);
    tex(conc.map);
    tex(conc.roughnessMap);
    this.floor = reg(new THREE.MeshStandardMaterial({ map: conc.map, roughnessMap: conc.roughnessMap, roughness: 1, metalness: 0, envMapIntensity: 0.9, color: 0xd8d4cf }));

    const br = brickMaps(1024);
    tex(br.map);
    tex(br.roughnessMap);
    if (br.bumpMap) tex(br.bumpMap);
    this.brick = reg(new THREE.MeshStandardMaterial({ map: br.map, roughnessMap: br.roughnessMap, bumpMap: br.bumpMap, bumpScale: 3.5, roughness: 1, metalness: 0, envMapIntensity: 0.5 }));

    const pl = plasterMaps(512);
    tex(pl.map);
    tex(pl.roughnessMap);
    if (pl.bumpMap) tex(pl.bumpMap);
    this.plaster = reg(new THREE.MeshStandardMaterial({ map: pl.map, bumpMap: pl.bumpMap, bumpScale: 0.8, roughness: 0.92, metalness: 0, color: 0xc9c2b8, envMapIntensity: 0.5 }));
    this.ceiling = reg(new THREE.MeshStandardMaterial({ map: pl.map, bumpMap: pl.bumpMap, bumpScale: 1.2, roughness: 0.95, color: 0x5f5a55, envMapIntensity: 0.3 }));
    this.concrete = reg(new THREE.MeshStandardMaterial({ map: conc.map, roughnessMap: conc.roughnessMap, roughness: 1, color: 0xb9b4ad, envMapIntensity: 0.6 }));

    this.steelDark = reg(new THREE.MeshStandardMaterial({ color: 0x2a2e33, metalness: 0.75, roughness: 0.42, envMapIntensity: 1 }));
    this.steelBlack = reg(new THREE.MeshStandardMaterial({ color: 0x121416, metalness: 0.6, roughness: 0.5 }));
    this.galvanized = reg(new THREE.MeshStandardMaterial({ color: 0xa7adb3, metalness: 0.9, roughness: 0.32, envMapIntensity: 1.2 }));
    this.brass = reg(new THREE.MeshStandardMaterial({ color: 0xc89b4a, metalness: 1, roughness: 0.3 }));

    const oak = woodMaps(512, 21, 'oak');
    tex(oak.map);
    tex(oak.roughnessMap);
    this.oak = reg(new THREE.MeshStandardMaterial({ map: oak.map, roughnessMap: oak.roughnessMap, roughness: 1, envMapIntensity: 0.7 }));
    const wal = woodMaps(512, 33, 'walnut');
    tex(wal.map);
    tex(wal.roughnessMap);
    this.walnut = reg(new THREE.MeshStandardMaterial({ map: wal.map, roughnessMap: wal.roughnessMap, roughness: 1, envMapIntensity: 0.6 }));
    const pine = woodMaps(512, 45, 'pine');
    tex(pine.map);
    tex(pine.roughnessMap);
    this.pine = reg(new THREE.MeshStandardMaterial({ map: pine.map, roughnessMap: pine.roughnessMap, roughness: 1 }));

    this.fabric = reg(new THREE.MeshPhysicalMaterial({ color: 0x1d5a64, roughness: 0.85, sheen: 1, sheenColor: new THREE.Color(0x7fd6e0), sheenRoughness: 0.45, bumpMap: pl.bumpMap, bumpScale: 0.6 }));
    this.leather = reg(new THREE.MeshPhysicalMaterial({ color: 0x8a4522, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.45, bumpMap: pl.bumpMap, bumpScale: 0.4 }));
    this.leaf = reg(new THREE.MeshStandardMaterial({ color: 0x3f8a3c, roughness: 0.55, side: THREE.DoubleSide }));
    this.ceramic = reg(new THREE.MeshPhysicalMaterial({ color: 0xe8e2d8, roughness: 0.25, clearcoat: 0.6 }));
    this.painted = reg(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 }));
    const rug = tex(rugTexture());
    this.rug = reg(new THREE.MeshStandardMaterial({ map: rug, roughness: 1, envMapIntensity: 0.2 }));
    this.glass = reg(new THREE.MeshPhysicalMaterial({ color: 0x9fb7c9, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false, envMapIntensity: 1.4, side: THREE.DoubleSide }));
    this.bulbGlow = reg(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffa95c, emissiveIntensity: 9, roughness: 0.3 }));
    this.lampGlow = reg(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc488, emissiveIntensity: 3.5, side: THREE.DoubleSide }));
    this.cord = reg(new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.6 }));
    const sky = tex(skylineTexture(Math.min(2048, maxTexture), Math.min(1024, maxTexture / 2)));
    this.skyline = reg(new THREE.MeshBasicMaterial({ map: sky, fog: false, color: new THREE.Color(1.6, 1.6, 1.7) }));
    const neon = tex(neonTexture('FPV'));
    this.neon = reg(new THREE.MeshBasicMaterial({ map: neon, color: new THREE.Color(5, 0.6, 3.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.tvBezel = reg(new THREE.MeshPhysicalMaterial({ color: 0x08090b, roughness: 0.25, metalness: 0.2, clearcoat: 1 }));

    const cf = carbonMaps(256);
    tex(cf.map);
    tex(cf.roughnessMap);
    cf.map.repeat.set(6, 6);
    cf.roughnessMap.repeat.set(6, 6);
    this.carbon = reg(new THREE.MeshPhysicalMaterial({ map: cf.map, roughnessMap: cf.roughnessMap, roughness: 0.6, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.3 }));
    this.anodized = reg(new THREE.MeshPhysicalMaterial({ color: 0xff5a14, metalness: 0.85, roughness: 0.28, clearcoat: 0.5, envMapIntensity: 1.5 }));
    this.aluminium = reg(new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.25 }));
    this.copper = reg(new THREE.MeshStandardMaterial({ color: 0xd07a3a, metalness: 1, roughness: 0.35 }));
    this.motorBase = reg(new THREE.MeshStandardMaterial({ color: 0x1a1b1f, metalness: 0.7, roughness: 0.4 }));
    this.tpu = reg(new THREE.MeshPhysicalMaterial({ color: 0x474d56, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color(0x9fb4d8), clearcoat: 0.25, clearcoatRoughness: 0.4, envMapIntensity: 1 }));
    this.propMat = reg(new THREE.MeshPhysicalMaterial({ color: 0x2ad9ff, roughness: 0.2, metalness: 0, transparent: true, opacity: 0.88, clearcoat: 1, side: THREE.DoubleSide, emissive: 0x0a3a4a, emissiveIntensity: 0.6 }));
    const bat = tex(batteryTexture());
    this.battery = reg(new THREE.MeshPhysicalMaterial({ map: bat, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }));
    this.strap = reg(new THREE.MeshStandardMaterial({ color: 0xd8182f, roughness: 0.7 }));
    this.camBody = reg(new THREE.MeshStandardMaterial({ color: 0x17181c, metalness: 0.4, roughness: 0.5 }));
    this.lens = reg(new THREE.MeshPhysicalMaterial({ color: 0x0a1426, metalness: 0.1, roughness: 0.02, clearcoat: 1, iridescence: 0.8, iridescenceIOR: 1.6, envMapIntensity: 2 }));
    this.pcb = reg(new THREE.MeshStandardMaterial({ color: 0x0d3d26, roughness: 0.6, metalness: 0.2 }));
    this.wireRed = reg(new THREE.MeshStandardMaterial({ color: 0xc41616, roughness: 0.5 }));
    this.wireBlack = reg(new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.5 }));
    this.connector = reg(new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.5 }));

    this.radial = tex(radialTexture(128));
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
