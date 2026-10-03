/**
 * Shared PBR material library. One instance per GameView (`view.library`); scenery and drone code ask it
 * for presets instead of building materials and textures themselves:
 *
 *   const floor = view.library.material('concrete', { uvMeters: 1, color: 0xd8d4cf });
 *   const glass = view.library.material('glass');
 *
 * - Materials are cached by preset + options: asking twice returns the same instance. Treat them as
 *   read-only (or `.clone()` one to own it); the library disposes everything it handed out.
 * - Each preset's texture set is generated once (procedural, see procedural.ts) and shared. Different
 *   repeats use texture clones that share one GPU upload (three keys uploads by `Texture.source`).
 * - On tiers with `pbrTextures`, presets that have a CC0 photo-scanned set (assets.ts) swap their maps in
 *   place once the WebP files arrive; until then (or offline without them) the procedural set shows.
 * - Glass follows the tier: physical transmission + thickness + IOR on high tiers, a cheap reflective
 *   coat elsewhere. `setProfile()` switches existing glass materials in place.
 */
import * as THREE from 'three';
import type { QualityProfile } from '../../core/quality';
import type { LevelId } from '../../types';
import { CC0_SETS, LEVEL_TEXTURE_SETS, cc0Url, type Cc0SetId, type PbrMapName } from './assets';
import { generatePbr, type PixelMap, type ProceduralKind } from './procedural';

export type PresetName = ProceduralKind | 'glass';

export interface MaterialOptions {
  /** tint multiplied into the albedo map */
  color?: THREE.ColorRepresentation;
  /**
   * UV units in metres: 1 UV unit = `uvMeters` m. The library then sets the repeat from the physical
   * tile size of whichever set is active (procedural or scanned), so a swap keeps the real-world scale.
   */
  uvMeters?: number;
  /** explicit texture repeats per UV unit (overrides uvMeters) */
  repeat?: number | readonly [number, number];
  /** multiplies the roughness map (1 = as authored) */
  roughness?: number;
  /** metalness override; the ARM map's blue channel is multiplied by it */
  metalness?: number;
  envMapIntensity?: number;
  /** normal map strength (1 = as authored) */
  normalScale?: number;
}

export interface TextureSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  arm: THREE.Texture;
}

/** Fetches one image as a texture; injectable for tests. */
export type TextureFetcher = (url: string) => Promise<THREE.Texture>;

interface PresetDef {
  /** procedural set (null: untextured) */
  kind: ProceduralKind | null;
  /** photo-scanned upgrade, if any */
  cc0: Cc0SetId | null;
  /** real-world tile edge of the procedural set (m) */
  tileMeters: number;
  physical: boolean;
  params: THREE.MeshPhysicalMaterialParameters;
}

const PRESETS: Readonly<Record<PresetName, PresetDef>> = {
  carbonFibre: { kind: 'carbonFibre', cc0: null, tileMeters: 0.05, physical: true, params: { clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 } },
  brushedMetal: { kind: 'brushedMetal', cc0: null, tileMeters: 0.4, physical: true, params: { color: 0xc9ccd1, metalness: 1, anisotropy: 0.65, envMapIntensity: 1.1 } },
  paintedMetal: { kind: 'paintedMetal', cc0: null, tileMeters: 1, physical: false, params: { color: 0xffffff, metalness: 1 } },
  rubber: { kind: 'rubber', cc0: null, tileMeters: 0.2, physical: false, params: { color: 0xffffff, metalness: 0 } },
  concrete: { kind: 'concrete', cc0: 'concrete', tileMeters: 2, physical: false, params: { metalness: 0 } },
  brick: { kind: 'brick', cc0: 'brick', tileMeters: 0.6, physical: false, params: { metalness: 0, envMapIntensity: 0.6 } },
  wood: { kind: 'wood', cc0: 'wood', tileMeters: 1, physical: false, params: { metalness: 0 } },
  plaster: { kind: 'plaster', cc0: 'plaster', tileMeters: 2, physical: false, params: { metalness: 0, envMapIntensity: 0.6 } },
  asphalt: { kind: 'asphalt', cc0: 'asphalt', tileMeters: 1.5, physical: false, params: { metalness: 0 } },
  grass: { kind: 'grass', cc0: 'grass', tileMeters: 1, physical: false, params: { metalness: 0, envMapIntensity: 0.5 } },
  bark: { kind: 'bark', cc0: 'bark', tileMeters: 1, physical: false, params: { metalness: 0, envMapIntensity: 0.4 } },
  foliage: { kind: 'foliage', cc0: null, tileMeters: 0.5, physical: false, params: { metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide } },
  glass: { kind: null, cc0: null, tileMeters: 1, physical: true, params: {} },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

interface Entry {
  material: THREE.MeshStandardMaterial;
  preset: PresetName;
  opts: Readonly<MaterialOptions>;
  /** clones this entry owns (repeat ≠ 1) */
  owned: THREE.Texture[];
}

const defaultFetcher: TextureFetcher = (url) => new THREE.TextureLoader().loadAsync(url);

function dataTexture(px: PixelMap, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(px.data, px.width, px.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export class MaterialLibrary {
  private profile: QualityProfile;
  private readonly anisotropy: number;
  private readonly fetcher: TextureFetcher;
  private readonly procedural = new Map<ProceduralKind, TextureSet>();
  private readonly scanned = new Map<Cc0SetId, TextureSet>();
  private readonly pending = new Map<Cc0SetId, Promise<TextureSet | null>>();
  private readonly entries = new Map<string, Entry>();
  /** procedural sets given out through textures(): kept even after a scanned set replaces them */
  private readonly handedOut = new Set<ProceduralKind>();
  private disposed = false;

  constructor(profile: QualityProfile, opts: { anisotropy?: number; fetcher?: TextureFetcher } = {}) {
    this.profile = profile;
    this.anisotropy = Math.min(opts.anisotropy ?? 4, 8);
    this.fetcher = opts.fetcher ?? defaultFetcher;
  }

  /** Shared material for a preset (cached by preset + options). */
  material(preset: PresetName, opts: Readonly<MaterialOptions> = {}): THREE.MeshStandardMaterial {
    const key = `${preset}|${JSON.stringify(opts)}`;
    const hit = this.entries.get(key);
    if (hit) return hit.material;
    const def = PRESETS[preset];
    const mat = def.physical ? new THREE.MeshPhysicalMaterial(def.params) : new THREE.MeshStandardMaterial(def.params as THREE.MeshStandardMaterialParameters);
    mat.name = `lib:${preset}`;
    if (opts.color !== undefined) mat.color.set(opts.color);
    if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity;
    if (opts.metalness !== undefined) mat.metalness = opts.metalness;
    const entry: Entry = { material: mat, preset, opts, owned: [] };
    this.entries.set(key, entry);
    if (preset === 'glass') {
      this.applyGlass(mat as THREE.MeshPhysicalMaterial);
      return mat;
    }
    const scanned = def.cc0 ? this.scanned.get(def.cc0) : undefined;
    this.bindMaps(entry, scanned ?? this.proceduralSet(def.kind!), scanned ? CC0_SETS[def.cc0!].tileMeters : def.tileMeters);
    if (def.cc0 && !scanned && this.profile.pbrTextures) void this.loadScanned(def.cc0);
    return mat;
  }

  /** The procedural maps of a preset (shared, repeat 1; do not dispose). */
  textures(preset: Exclude<PresetName, 'glass'>): TextureSet {
    const kind = PRESETS[preset].kind!;
    this.handedOut.add(kind);
    return this.proceduralSet(kind);
  }

  /** Starts loading the scanned sets a level uses (no-op on tiers without pbrTextures). */
  preload(level: LevelId): Promise<void> {
    if (!this.profile.pbrTextures) return Promise.resolve();
    const ids = LEVEL_TEXTURE_SETS[level] ?? [];
    return Promise.all(ids.map((id) => this.loadScanned(id))).then(() => undefined);
  }

  /** New tier: glass switches technique; newly enabled scanned sets start loading for existing materials. */
  setProfile(p: QualityProfile): void {
    this.profile = p;
    for (const e of this.entries.values()) {
      if (e.preset === 'glass') this.applyGlass(e.material as THREE.MeshPhysicalMaterial);
      const id = PRESETS[e.preset].cc0;
      if (id && p.pbrTextures && !this.scanned.has(id)) void this.loadScanned(id);
    }
  }

  /** Material, texture and GPU-upload counts (uploads = distinct texture sources). */
  stats(): { materials: number; textures: number; uploads: number } {
    const textures = new Set<THREE.Texture>();
    for (const s of [...this.procedural.values(), ...this.scanned.values()]) for (const t of Object.values(s)) textures.add(t);
    for (const e of this.entries.values()) for (const t of e.owned) textures.add(t);
    const sources = new Set<unknown>();
    for (const t of textures) sources.add(t.source);
    return { materials: this.entries.size, textures: textures.size, uploads: sources.size };
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      e.material.dispose();
      for (const t of e.owned) t.dispose();
    }
    for (const s of [...this.procedural.values(), ...this.scanned.values()]) for (const t of Object.values(s)) t.dispose();
    this.entries.clear();
    this.procedural.clear();
    this.scanned.clear();
  }

  private proceduralSet(kind: ProceduralKind): TextureSet {
    let set = this.procedural.get(kind);
    if (!set) {
      const size = kind === 'foliage' ? Math.min(512, this.profile.textureSize) : this.profile.textureSize;
      const px = generatePbr(kind, size);
      set = { albedo: dataTexture(px.albedo, true), normal: dataTexture(px.normal, false), arm: dataTexture(px.arm, false) };
      for (const t of Object.values(set)) t.anisotropy = this.anisotropy;
      this.procedural.set(kind, set);
    }
    return set;
  }

  private loadScanned(id: Cc0SetId): Promise<TextureSet | null> {
    let p = this.pending.get(id);
    if (p) return p;
    const maps: PbrMapName[] = ['albedo', 'normal', 'arm'];
    const urls = maps.map((m) => cc0Url(id, m));
    p = (urls.some((u) => !u) ? Promise.reject(new Error(`missing CC0 set ${id}`)) : Promise.all(urls.map((u) => this.fetcher(u!))))
      .then((tex) => {
        const [albedo, normal, arm] = tex as [THREE.Texture, THREE.Texture, THREE.Texture];
        if (this.disposed) {
          for (const t of tex) t.dispose();
          return null;
        }
        albedo.colorSpace = THREE.SRGBColorSpace;
        normal.colorSpace = arm.colorSpace = THREE.NoColorSpace;
        for (const t of tex) {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = this.anisotropy;
          t.needsUpdate = true;
        }
        const set: TextureSet = { albedo, normal, arm };
        this.scanned.set(id, set);
        for (const e of this.entries.values()) {
          if (PRESETS[e.preset].cc0 === id) this.bindMaps(e, set, CC0_SETS[id].tileMeters);
        }
        // the stand-in is no longer referenced: free its GPU copy
        for (const name of PRESET_NAMES) {
          const kind = PRESETS[name].kind;
          const stale = kind && PRESETS[name].cc0 === id && !this.handedOut.has(kind) ? this.procedural.get(kind) : undefined;
          if (stale) {
            for (const t of Object.values(stale)) t.dispose();
            this.procedural.delete(kind!);
          }
        }
        return set;
      })
      // offline without the files, or a decode failure: the procedural maps stay; a later preload retries
      .catch(() => {
        this.pending.delete(id);
        return null;
      });
    this.pending.set(id, p);
    return p;
  }

  private bindMaps(e: Entry, set: TextureSet, tileMeters: number): void {
    const { opts } = e;
    let rx = 1;
    let ry = 1;
    if (opts.repeat !== undefined) {
      [rx, ry] = typeof opts.repeat === 'number' ? [opts.repeat, opts.repeat] : opts.repeat;
    } else if (opts.uvMeters !== undefined) {
      rx = ry = opts.uvMeters / tileMeters;
    }
    for (const t of e.owned) t.dispose();
    e.owned = [];
    const use = (t: THREE.Texture): THREE.Texture => {
      if (rx === 1 && ry === 1) return t;
      const c = t.clone();
      c.repeat.set(rx, ry);
      c.needsUpdate = true;
      e.owned.push(c);
      return c;
    };
    const m = e.material;
    const albedo = use(set.albedo);
    const arm = use(set.arm);
    m.map = albedo;
    m.normalMap = use(set.normal);
    m.normalScale.setScalar(opts.normalScale ?? 1);
    m.roughnessMap = arm;
    m.metalnessMap = arm;
    m.aoMap = arm;
    m.roughness = opts.roughness ?? 1;
    m.needsUpdate = true;
  }

  private applyGlass(m: THREE.MeshPhysicalMaterial): void {
    const physical = this.profile.glass === 'transmission';
    m.color.set(0xffffff);
    m.metalness = 0;
    m.roughness = 0.04;
    m.ior = 1.5;
    m.envMapIntensity = 1.2;
    m.side = THREE.FrontSide;
    if (physical) {
      m.transmission = 1;
      m.thickness = 0.01;
      m.attenuationColor.set(0xe8f4f0);
      m.attenuationDistance = 0.5;
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.specularIntensity = 1;
    } else {
      // reflective coat: Fresnel reflections over a faint tint, no refraction pass
      m.transmission = 0;
      m.thickness = 0;
      m.transparent = true;
      m.opacity = 0.14;
      m.depthWrite = false;
      m.specularIntensity = 1;
    }
    m.needsUpdate = true;
  }
}
