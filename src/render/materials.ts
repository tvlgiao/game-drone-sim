/** Shared material library for the drone (the scenery owns its own sets). Created once per GameView, disposed with it. */
import * as THREE from 'three';
import { carbonMaps, batteryTexture, radialTexture } from './textures';

export class Materials {
  readonly textures: THREE.Texture[] = [];
  readonly all: THREE.Material[] = [];

  readonly brass: THREE.MeshStandardMaterial;
  readonly ceramic: THREE.MeshPhysicalMaterial;

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

  /** `_maxTexture` (mobile texture cap) is kept for callers; the drone's textures are all small. */
  constructor(anisotropy: number, _maxTexture = 2048) {
    const tex = <T extends THREE.Texture>(t: T): T => {
      t.anisotropy = Math.min(anisotropy, 8);
      this.textures.push(t);
      return t;
    };
    const reg = <M extends THREE.Material>(m: M): M => {
      this.all.push(m);
      return m;
    };

    this.brass = reg(new THREE.MeshStandardMaterial({ color: 0xc89b4a, metalness: 1, roughness: 0.3 }));
    this.ceramic = reg(new THREE.MeshPhysicalMaterial({ color: 0xe8e2d8, roughness: 0.25, clearcoat: 0.6 }));

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
