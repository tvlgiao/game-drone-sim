/**
 * The one material system. One instance per GameView (`view.library`); scenery, levels and the drone ask it
 * for presets instead of building materials and textures themselves:
 *
 *   const floor = view.library.material('slab', { uvMeters: 4, patch: { box, macro } });
 *   const wall  = view.library.material('paintedBrick', { uvMeters: 1.2, patch: { grime } });
 *   const glass = view.library.material('glass');
 *   const level = view.library.scope('night-loft');   // per-level lifetime: level.dispose() frees its share
 *   const ground = level.terrain({ rockAttribute: 'aRock', wetAttribute: 'aWet' });
 *
 * - Materials are cached by preset + options (+ patch object): asking twice returns the same instance. Treat
 *   them as read-only (or `.clone()` one to own it); the library (or the scope) disposes what it handed out.
 * - Each preset's texture set is generated once (procedural.ts per texel, generators.ts per field) and
 *   shared. Different repeats use texture clones that share one GPU upload (three keys uploads by `Source`).
 * - On tiers with `pbrTextures`, presets that have a CC0 photo-scanned set (assets.ts) swap their maps in
 *   place once the WebP files arrive; until then (or offline without them) the procedural set shows.
 *   Shader patches (patches.ts: box projection, grime, paint, detail, overlay, wind, terrain …) sit on top
 *   of whichever set is bound, so a level's look survives the swap.
 * - Glass follows the tier: physical transmission + thickness + IOR on high tiers, a cheap reflective
 *   coat elsewhere. `setProfile()` switches existing glass materials in place.
 * - `custom(key, factory)` caches one-off materials (a level's art: decal atlas, neon, rug) under the same
 *   lifetime rules, so a level never owns a material outside the library.
 */
import * as THREE from 'three';
import type { QualityProfile } from '../../core/quality';
import type { LevelId } from '../../types';
import { CC0_SETS, LEVEL_TEXTURE_SETS, cc0Url, type Cc0SetId, type PbrMapName } from './assets';
import { grungeOrm } from './generators';
import { applyEnvPatch, isEmptyPatch, type EnvPatch } from './patches';
import { GENERATED, setPixels, setTextures, type SetPixels, type SurfaceKind } from './set-pixels';
import { TextureWorkerClient } from './texture-client';
import { texSize } from './texgen';

export type { SurfaceKind } from './set-pixels';

export type PresetName =
  | 'carbonFibre'
  | 'brushedMetal'
  | 'paintedMetal'
  | 'rubber'
  | 'concrete'
  | 'slab'
  | 'brick'
  | 'paintedBrick'
  | 'wood'
  | 'plaster'
  | 'asphalt'
  | 'grass'
  | 'gravel'
  | 'bark'
  | 'rock'
  | 'foliage'
  | 'needles'
  | 'glass';

export interface MaterialOptions {
  /** tint multiplied into the albedo map */
  color?: THREE.ColorRepresentation;
  /**
   * Mean albedo the surface shows whichever set is bound: the map is divided by its own mean colour
   * (`detail` patch) and tinted to this. A level keeps its authored brightness and palette when a scan
   * (darker or warmer than the procedural stand-in) arrives; the set only brings the detail. Overrides `color`.
   */
  albedo?: THREE.ColorRepresentation;
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
  /** multiply per-vertex colours (geometry `color` attribute) into the albedo */
  vertexColors?: boolean;
  side?: THREE.Side;
  /** decal-style depth offset (factor = units, negative pulls towards the camera) for coplanar ground layers */
  polygonOffset?: number;
  /**
   * Shader patch features (patches.ts). Part of the cache key by object identity: build the patch once
   * per level and pass the same object for the same material.
   */
  patch?: EnvPatch;
}

/** `library.terrain()`: one ground material that blends layers by per-vertex weights. */
export interface TerrainOptions {
  /** base layer preset (default grass) */
  base?: 'grass' | 'gravel' | 'asphalt' | 'concrete';
  /** UV metres of the base layer (geometry UVs in metres → 1) */
  uvMeters?: number;
  /** float attribute (0..1) blending to triplanar rock; null for none. Default 'aRock'. */
  rockAttribute?: string | null;
  /** float attribute (0..1) of bank wetness: darker, glossier, flatter. Default 'aWet'; null for none. */
  wetAttribute?: string | null;
  /** rock on slopes steeper than this (1 − normal.y, 0..1) even without the attribute; default off */
  slopeRock?: number;
  /** world metres per rock tile (triplanar) */
  rockMeters?: number;
  /**
   * Base albedo as a neutral detail layer under vertex colours (`detail` patch): the geometry's `color`
   * attribute carries the palette (meadow greens, farm parcels), the map only adds texture. Default true.
   */
  vertexColors?: boolean;
  envMapIntensity?: number;
  /** rock layer colour (the map brings detail only); default: the map's own colour */
  rockTint?: THREE.ColorRepresentation;
  /** second, coarser rock sample (tile metres) for faces seen from afar; default none */
  rockMacroMeters?: number;
  /** soil detail (CC0 forest ground where loaded) on bare earth and wet banks; default off */
  soil?: boolean;
  /** vertex colours are sRGB bytes (world engine palette): linearise them; default false */
  srgbColors?: boolean;
  /** whitest vertex colours read as snow (smoother, less grain, no rock); default false */
  snow?: boolean;
  /** base maps in world XZ metres instead of mesh UVs (heightfield chunks have none); default false */
  worldUv?: boolean;
  /** share of the base map's contrast kept as detail under the vertex colours (0..1); default 1 */
  detail?: number;
  /** base normal map strength (1 = as authored) */
  normalScale?: number;
  /** multiplies the base roughness map (1 = as authored) */
  roughness?: number;
  /** travelling wind gusts brighten meadow and crops (docs/12); default off */
  gust?: boolean;
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
  kind: SurfaceKind | null;
  /** photo-scanned upgrade, if any */
  cc0: Cc0SetId | null;
  /** real-world tile edge of the procedural set (m) */
  tileMeters: number;
  physical: boolean;
  params: THREE.MeshPhysicalMaterialParameters;
  /** limewash over the set (paintedBrick): a preset-level `paint` patch */
  paint?: { color: number; coverage: number; roughness: number };
}


const PRESETS: Readonly<Record<PresetName, PresetDef>> = {
  carbonFibre: { kind: 'carbonFibre', cc0: null, tileMeters: 0.05, physical: true, params: { clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.2 } },
  brushedMetal: { kind: 'brushedMetal', cc0: null, tileMeters: 0.4, physical: true, params: { color: 0xc9ccd1, metalness: 1, anisotropy: 0.65, envMapIntensity: 1.1 } },
  paintedMetal: { kind: 'paintedMetal', cc0: null, tileMeters: 1, physical: false, params: { color: 0xffffff, metalness: 1 } },
  rubber: { kind: 'rubber', cc0: null, tileMeters: 0.2, physical: false, params: { color: 0xffffff, metalness: 0 } },
  concrete: { kind: 'concrete', cc0: 'concrete', tileMeters: GENERATED.concrete.tileMeters, physical: false, params: { metalness: 0 } },
  slab: { kind: 'slab', cc0: 'concrete', tileMeters: GENERATED.slab.tileMeters, physical: false, params: { metalness: 0 } },
  brick: { kind: 'brick', cc0: 'brick', tileMeters: GENERATED.brick.tileMeters, physical: false, params: { metalness: 0, envMapIntensity: 0.6 } },
  paintedBrick: {
    kind: 'brick',
    cc0: 'brick',
    tileMeters: GENERATED.brick.tileMeters,
    physical: false,
    params: { metalness: 0, envMapIntensity: 0.5 },
    paint: { color: 0xc4beb4, coverage: 0.88, roughness: 0.7 },
  },
  wood: { kind: 'wood', cc0: 'wood', tileMeters: GENERATED.wood.tileMeters, physical: false, params: { metalness: 0 } },
  plaster: { kind: 'plaster', cc0: 'plaster', tileMeters: 2, physical: false, params: { metalness: 0, envMapIntensity: 0.6 } },
  asphalt: { kind: 'asphalt', cc0: 'asphalt', tileMeters: 1.5, physical: false, params: { metalness: 0 } },
  grass: { kind: 'grass', cc0: 'grass', tileMeters: 1, physical: false, params: { metalness: 0, envMapIntensity: 0.5 } },
  gravel: { kind: 'gravel', cc0: null, tileMeters: GENERATED.gravel.tileMeters, physical: false, params: { metalness: 0, envMapIntensity: 0.3 } },
  bark: { kind: 'bark', cc0: 'bark', tileMeters: 1, physical: false, params: { metalness: 0, envMapIntensity: 0.4 } },
  rock: { kind: 'rock', cc0: 'rock', tileMeters: 3, physical: false, params: { metalness: 0, envMapIntensity: 0.5 } },
  foliage: { kind: 'foliage', cc0: null, tileMeters: 0.5, physical: false, params: { metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide } },
  needles: { kind: 'needles', cc0: null, tileMeters: 0.5, physical: false, params: { metalness: 0, alphaTest: 0.45, side: THREE.DoubleSide } },
  glass: { kind: null, cc0: null, tileMeters: 1, physical: true, params: {} },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

/** Owner of everything asked for on the library itself (lives as long as the library). */
const ROOT = '';

interface Entry {
  material: THREE.Material;
  /** null: a custom material */
  preset: PresetName | null;
  opts: Readonly<MaterialOptions>;
  /** clones this entry owns (repeat ≠ 1) */
  owned: THREE.Texture[];
  /** custom materials: textures / objects created by the factory */
  extra: { dispose(): void }[];
  owners: Set<string>;
  /** extra layers bound from scanned sets (terrain rock / soil): rebound when a scan arrives */
  onScan?: (id: Cc0SetId, set: TextureSet) => void;
}

interface SetWatcher {
  owner: string;
  id: Cc0SetId;
  cb: (set: TextureSet, tileMeters: number) => void;
}

/**
 * Scans decode off the main thread where the browser can (`createImageBitmap`, flipped at decode: WebGL cannot
 * flip an ImageBitmap on upload); elsewhere the image element path.
 */
const defaultFetcher: TextureFetcher = async (url) => {
  if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
    try {
      const blob = await (await fetch(url)).blob();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const t = new THREE.Texture(bmp);
      t.flipY = false;
      t.needsUpdate = true;
      return t;
    } catch {
      // fall through to the image element
    }
  }
  return new THREE.TextureLoader().loadAsync(url);
};

/** Library presets each level builds with (texture sets to have ready before its scenery is built). */
/** Procedural sets made before any library exists (the boot), by `kind|size`; the first library takes them. */
const PREFETCHED = new Map<string, SetPixels>();
/** the boot's texture worker, handed to the first library */
let bootWorker: TextureWorkerClient | null = null;

/**
 * Generates the procedural sets `level` draws with, at `textureSize`, in the texture worker before the game view is
 * built: the boot then binds ready pixels instead of generating them on the main thread (a long frozen splash).
 */
export async function prefetchLevelSurfaces(level: LevelId, textureSize: number): Promise<void> {
  const kinds = new Set<SurfaceKind>();
  for (const name of LEVEL_SURFACES[level] ?? []) {
    const kind = PRESETS[name].kind;
    if (kind) kinds.add(kind);
  }
  const worker = (bootWorker ??= new TextureWorkerClient());
  await Promise.all(
    [...kinds].map(async (kind) => {
      const key = `${kind}|${textureSize}`;
      if (PREFETCHED.has(key)) return;
      try {
        PREFETCHED.set(key, await worker.build(kind, textureSize));
      } catch {
        // generated on first use instead
      }
    }),
  );
}

export const LEVEL_SURFACES: Readonly<Partial<Record<LevelId, readonly PresetName[]>>> = {
  'night-loft': ['slab', 'brick', 'paintedBrick', 'wood', 'plaster', 'concrete'],
  training: ['grass', 'gravel', 'asphalt', 'bark', 'foliage', 'needles'],
  city: ['brick', 'concrete', 'gravel', 'bark', 'foliage', 'needles'],
  alpine: ['grass', 'rock', 'gravel', 'bark', 'foliage', 'needles'],
  infinite: ['grass', 'rock', 'gravel', 'bark', 'foliage', 'needles'],
};



/** The library API a level sees: the same calls, with everything it asks for released by `dispose()`. */
export interface MaterialSource {
  material(preset: PresetName, opts?: Readonly<MaterialOptions>): THREE.MeshStandardMaterial;
  custom<M extends THREE.Material>(key: string, factory: (track: <T extends { dispose(): void }>(d: T) => T) => M): M;
  /** a one-off texture under the same lifetime rules (a level's macro map, a cookie) */
  texture<T extends THREE.Texture>(key: string, factory: () => T): T;
  terrain(opts?: Readonly<TerrainOptions>): THREE.MeshStandardMaterial;
  textures(preset: Exclude<PresetName, 'glass'>): TextureSet;
  /**
   * The best maps of a preset for a custom shader: called now with the procedural set (or the scan if it is
   * already in), and again when the CC0 scan arrives on a tier that loads it. Released with the owner.
   */
  watchSet(preset: Exclude<PresetName, 'glass'>, cb: (set: TextureSet, tileMeters: number) => void): void;
  /** shared tileable noise (G = breakup, R = blotchy AO, B = 1): grime, paint chips, metal roughness */
  grunge(): THREE.Texture;
  readonly profile: QualityProfile;
}

export class MaterialScope implements MaterialSource {
  private disposed = false;

  constructor(
    private readonly lib: MaterialLibrary,
    readonly name: string,
  ) {}

  get profile(): QualityProfile {
    return this.lib.profile;
  }

  material(preset: PresetName, opts: Readonly<MaterialOptions> = {}): THREE.MeshStandardMaterial {
    return this.lib.acquire(this.name, preset, opts);
  }

  custom<M extends THREE.Material>(key: string, factory: (track: <T extends { dispose(): void }>(d: T) => T) => M): M {
    return this.lib.acquireCustom(this.name, key, factory);
  }

  texture<T extends THREE.Texture>(key: string, factory: () => T): T {
    return this.lib.acquireTexture(this.name, key, factory);
  }

  terrain(opts: Readonly<TerrainOptions> = {}): THREE.MeshStandardMaterial {
    return this.lib.acquireTerrain(this.name, opts);
  }

  textures(preset: Exclude<PresetName, 'glass'>): TextureSet {
    return this.lib.textures(preset);
  }

  watchSet(preset: Exclude<PresetName, 'glass'>, cb: (set: TextureSet, tileMeters: number) => void): void {
    this.lib.watchFor(this.name, preset, cb);
  }

  grunge(): THREE.Texture {
    return this.lib.grunge();
  }

  /** Releases this scope's share; materials no other owner holds are disposed, idle texture sets leave the GPU. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lib.release(this.name);
  }
}

export class MaterialLibrary implements MaterialSource {
  private _profile: QualityProfile;
  private readonly anisotropy: number;
  private readonly fetcher: TextureFetcher;
  private readonly procedural = new Map<SurfaceKind, TextureSet>();
  private readonly scanned = new Map<Cc0SetId, TextureSet>();
  private readonly pending = new Map<Cc0SetId, Promise<TextureSet | null>>();
  private readonly entries = new Map<string, Entry>();
  /** procedural sets given out through textures(): kept even after a scanned set replaces them */
  private readonly handedOut = new Set<SurfaceKind>();
  private readonly patchIds = new WeakMap<EnvPatch, number>();
  private readonly watchers: SetWatcher[] = [];
  private readonly textureWorker: TextureWorkerClient;
  private nextPatchId = 1;
  private grungeTex: THREE.DataTexture | null = null;
  private scopeSeq = 0;
  private disposed = false;

  constructor(profile: QualityProfile, opts: { anisotropy?: number; fetcher?: TextureFetcher; textureWorker?: TextureWorkerClient } = {}) {
    this._profile = profile;
    this.anisotropy = Math.min(opts.anisotropy ?? 4, 8);
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.textureWorker = opts.textureWorker ?? bootWorker ?? new TextureWorkerClient();
    bootWorker = null;
  }

  get profile(): QualityProfile {
    return this._profile;
  }

  /** A per-level (or per-object) owner: what it asks for is freed by its `dispose()` unless shared. */
  scope(name: string): MaterialScope {
    return new MaterialScope(this, `${name}#${++this.scopeSeq}`);
  }

  /** Shared material for a preset (cached by preset + options), owned by the library itself. */
  material(preset: PresetName, opts: Readonly<MaterialOptions> = {}): THREE.MeshStandardMaterial {
    return this.acquire(ROOT, preset, opts);
  }

  custom<M extends THREE.Material>(key: string, factory: (track: <T extends { dispose(): void }>(d: T) => T) => M): M {
    return this.acquireCustom(ROOT, key, factory);
  }

  texture<T extends THREE.Texture>(key: string, factory: () => T): T {
    return this.acquireTexture(ROOT, key, factory);
  }

  /**
   * Ground material for heightfield terrain: the base preset (grass by default, CC0 on tiers that load it)
   * under vertex colours, triplanar rock blended in by a per-vertex weight (`rockAttribute`, and optionally
   * by slope), wet banks by another (`wetAttribute`). Missing attributes read as 0.
   */
  terrain(opts: Readonly<TerrainOptions> = {}): THREE.MeshStandardMaterial {
    return this.acquireTerrain(ROOT, opts);
  }

  watchSet(preset: Exclude<PresetName, 'glass'>, cb: (set: TextureSet, tileMeters: number) => void): void {
    this.watchFor(ROOT, preset, cb);
  }

  /** @internal */
  watchFor(owner: string, preset: Exclude<PresetName, 'glass'>, cb: (set: TextureSet, tileMeters: number) => void): void {
    const def = PRESETS[preset];
    const id = def.cc0;
    const scanned = id ? this.scanned.get(id) : undefined;
    if (scanned) cb(scanned, CC0_SETS[id!].tileMeters);
    else cb(this.textures(preset), def.tileMeters);
    if (!id || scanned) return;
    this.watchers.push({ owner, id, cb });
    if (this._profile.pbrTextures) void this.loadScanned(id);
  }

  /** The procedural maps of a preset (shared, repeat 1; do not dispose). */
  textures(preset: Exclude<PresetName, 'glass'>): TextureSet {
    const kind = PRESETS[preset].kind!;
    this.handedOut.add(kind);
    return this.proceduralSet(kind);
  }

  grunge(): THREE.Texture {
    if (!this.grungeTex) this.grungeTex = grungeOrm(texSize(512, Math.max(256, this._profile.textureSize)), this.anisotropy);
    return this.grungeTex;
  }

  /** Starts loading the scanned sets a level uses (no-op on tiers without pbrTextures). */
  preload(level: LevelId): Promise<void> {
    if (!this._profile.pbrTextures) return Promise.resolve();
    const ids = LEVEL_TEXTURE_SETS[level] ?? [];
    return Promise.all(ids.map((id) => this.loadScanned(id))).then(() => undefined);
  }

  /**
   * Everything a level's materials need, ready before its scenery is built: the CC0 scans it uses (tiers that load
   * them, decoded off the main thread) and the procedural sets that no loaded scan replaces, generated in the texture
   * worker. Building the level then finds every set cached instead of generating it on the main thread.
   * `onProgress` gets 0..1.
   */
  async prepareLevel(level: LevelId, onProgress?: (f: number) => void): Promise<void> {
    const scans = this._profile.pbrTextures ? (LEVEL_TEXTURE_SETS[level] ?? []) : [];
    const kinds = (): SurfaceKind[] => {
      const out = new Set<SurfaceKind>();
      for (const name of LEVEL_SURFACES[level] ?? []) {
        const def = PRESETS[name];
        if (!def.kind || (def.cc0 && this.scanned.has(def.cc0))) continue;
        if (!this.procedural.has(def.kind)) out.add(def.kind);
      }
      return [...out];
    };
    const total = scans.length + kinds().length || 1;
    let done = 0;
    const tick = (): void => onProgress?.(Math.min(1, ++done / total));
    await Promise.all(scans.map((id) => this.loadScanned(id).then(tick)));
    // a scan that failed (offline) leaves its kind to the procedural set
    const todo = kinds();
    const all = done + todo.length || 1;
    const step = (): void => onProgress?.(Math.min(1, ++done / all));
    const ts = this._profile.textureSize;
    await Promise.all(
      todo.map(async (kind) => {
        const px = await this.textureWorker.build(kind, ts);
        if (this.disposed) return;
        if (!this.procedural.has(kind) && this._profile.textureSize === ts) this.procedural.set(kind, setTextures(px, this.anisotropy));
        step();
      }),
    );
    onProgress?.(1);
  }

  /** Starts the texture worker (its script loads during idle menu time). */
  warmWorker(): void {
    this.textureWorker.warm();
  }

  /** New tier: glass switches technique; newly enabled scanned sets start loading for existing materials. */
  setProfile(p: QualityProfile): void {
    this._profile = p;
    for (const e of this.entries.values()) {
      if (!e.preset) continue;
      if (e.preset === 'glass') this.applyGlass(e.material as THREE.MeshPhysicalMaterial);
      const id = PRESETS[e.preset].cc0;
      if (id && p.pbrTextures && !this.scanned.has(id)) void this.loadScanned(id);
    }
    if (p.pbrTextures) for (const w of this.watchers) if (!this.scanned.has(w.id)) void this.loadScanned(w.id);
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

  /** Live materials by name (`lib:<preset>` / custom key), for tests and the render preview. */
  materialNames(): string[] {
    return [...this.entries.values()].map((e) => e.material.name);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) this.disposeEntry(e);
    for (const s of [...this.procedural.values(), ...this.scanned.values()]) for (const t of Object.values(s)) t.dispose();
    this.grungeTex?.dispose();
    this.grungeTex = null;
    this.entries.clear();
    this.procedural.clear();
    this.scanned.clear();
  }

  // ---- internals (MaterialScope calls these) ------------------------------------------------------

  /** @internal */
  acquire(owner: string, preset: PresetName, opts: Readonly<MaterialOptions>): THREE.MeshStandardMaterial {
    const key = `${preset}|${this.optionsKey(opts)}`;
    return this.build(owner, key, preset, opts) as THREE.MeshStandardMaterial;
  }

  /** @internal */
  acquireCustom<M extends THREE.Material>(owner: string, key: string, factory: (track: <T extends { dispose(): void }>(d: T) => T) => M): M {
    const k = `custom|${key}`;
    const hit = this.entries.get(k);
    if (hit) {
      hit.owners.add(owner);
      return hit.material as M;
    }
    const extra: { dispose(): void }[] = [];
    const material = factory((d) => {
      extra.push(d);
      return d;
    });
    if (!material.name) material.name = key;
    this.entries.set(k, { material, preset: null, opts: {}, owned: [], extra, owners: new Set([owner]) });
    return material;
  }

  /** @internal — a texture rides on a hidden carrier entry so it shares the materials' lifetime rules */
  acquireTexture<T extends THREE.Texture>(owner: string, key: string, factory: () => T): T {
    const carrier = this.acquireCustom(owner, `texture|${key}`, (track) => new THREE.MeshBasicMaterial({ map: track(factory()) }));
    return carrier.map as T;
  }

  /** @internal */
  acquireTerrain(owner: string, o: Readonly<TerrainOptions>): THREE.MeshStandardMaterial {
    const key = `terrain|${JSON.stringify(o)}`;
    const hit = this.entries.get(key);
    if (hit) {
      hit.owners.add(owner);
      return hit.material as THREE.MeshStandardMaterial;
    }
    // rock and soil: the scan where it is already in, else the procedural stand-in until it arrives
    const rockScan = this.scanned.get('rock');
    const rockSet = rockScan ?? this.textures('rock');
    const rockMeters = o.rockMeters ?? PRESETS.rock.tileMeters;
    const soilScan = o.soil ? this.scanned.get('soil') : undefined;
    const soilSet = o.soil ? (soilScan ?? this.textures('gravel')) : null;
    const patch: EnvPatch = {
      detail: (o.vertexColors ?? true) ? (o.detail ?? true) : false,
      terrain: {
        rock: { albedo: rockSet.albedo, arm: rockSet.arm, tileMeters: rockMeters },
        rockAttribute: o.rockAttribute === undefined ? 'aRock' : o.rockAttribute,
        wetAttribute: o.wetAttribute === undefined ? 'aWet' : o.wetAttribute,
        slopeRock: o.slopeRock ?? 2,
        rockTint: o.rockTint !== undefined ? new THREE.Color(o.rockTint) : undefined,
        rockMacroMeters: o.rockMacroMeters,
        soil: soilSet ? { albedo: soilSet.albedo, arm: soilSet.arm, tileMeters: soilScan ? CC0_SETS.soil.tileMeters : GENERATED.gravel.tileMeters } : undefined,
        srgbColors: o.srgbColors,
        snow: o.snow,
        worldUv: o.worldUv,
        gust: o.gust,
      },
    };
    const opts: MaterialOptions = { uvMeters: o.uvMeters ?? 1, vertexColors: o.vertexColors ?? true, envMapIntensity: o.envMapIntensity ?? 0.4, normalScale: o.normalScale, roughness: o.roughness, patch };
    const m = this.build(owner, key, o.base ?? 'grass', opts) as THREE.MeshStandardMaterial;
    m.name = 'lib:terrain';
    const entry = this.entries.get(key)!;
    entry.onScan = (id, set) => {
      const u = m.userData.envUniforms as Record<string, THREE.IUniform>;
      if (id === 'rock') {
        u.uRockMap!.value = set.albedo;
        u.uRockArm!.value = set.arm;
      } else if (id === 'soil' && u.uSoilMap) {
        u.uSoilMap.value = set.albedo;
        u.uSoilScale!.value = 1 / CC0_SETS.soil.tileMeters;
      }
    };
    if (this._profile.pbrTextures) {
      if (!rockScan) void this.loadScanned('rock');
      if (o.soil && !soilScan) void this.loadScanned('soil');
    }
    return m;
  }

  /** @internal */
  release(owner: string): void {
    for (let i = this.watchers.length - 1; i >= 0; i--) if (this.watchers[i]!.owner === owner) this.watchers.splice(i, 1);
    for (const [k, e] of this.entries) {
      if (!e.owners.delete(owner) || e.owners.size > 0) continue;
      this.disposeEntry(e);
      this.entries.delete(k);
    }
    // texture sets nothing uses any more leave the GPU (the CPU copy stays for a quick re-upload)
    const live = new Set<THREE.Texture>();
    for (const e of this.entries.values()) {
      const m = e.material as THREE.MeshStandardMaterial;
      for (const t of [m.map, m.normalMap, m.roughnessMap]) if (t) live.add(t);
      for (const t of e.owned) live.add(t);
    }
    const inUse = (s: TextureSet) => [...live].some((t) => t.source === s.albedo.source || t.source === s.normal.source || t.source === s.arm.source);
    for (const [kind, s] of this.procedural) if (!this.handedOut.has(kind) && !inUse(s)) for (const t of Object.values(s)) t.dispose();
    for (const s of this.scanned.values()) if (!inUse(s)) for (const t of Object.values(s)) t.dispose();
  }

  private optionsKey(opts: Readonly<MaterialOptions>): string {
    const { patch, ...rest } = opts;
    let pid = 0;
    if (patch && !isEmptyPatch(patch)) {
      pid = this.patchIds.get(patch) ?? 0;
      if (!pid) {
        pid = this.nextPatchId++;
        this.patchIds.set(patch, pid);
      }
    }
    return `${JSON.stringify(rest)}|p${pid}`;
  }

  private build(owner: string, key: string, preset: PresetName, opts: Readonly<MaterialOptions>): THREE.Material {
    const hit = this.entries.get(key);
    if (hit) {
      hit.owners.add(owner);
      return hit.material;
    }
    const def = PRESETS[preset];
    const mat = def.physical ? new THREE.MeshPhysicalMaterial(def.params) : new THREE.MeshStandardMaterial(def.params as THREE.MeshStandardMaterialParameters);
    mat.name = `lib:${preset}`;
    if (opts.color !== undefined) mat.color.set(opts.color);
    if (opts.albedo !== undefined) mat.color.set(opts.albedo);
    if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity;
    if (opts.metalness !== undefined) mat.metalness = opts.metalness;
    if (opts.vertexColors) mat.vertexColors = true;
    if (opts.side !== undefined) mat.side = opts.side;
    if (opts.polygonOffset !== undefined) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = mat.polygonOffsetUnits = opts.polygonOffset;
    }
    const entry: Entry = { material: mat, preset, opts, owned: [], extra: [], owners: new Set([owner]) };
    this.entries.set(key, entry);
    if (preset === 'glass') {
      this.applyGlass(mat as THREE.MeshPhysicalMaterial);
      return mat;
    }
    const patch: EnvPatch = { ...(opts.patch ?? {}) };
    if (opts.albedo !== undefined) patch.detail = true;
    if (def.paint && !patch.paint) {
      patch.paint = { color: new THREE.Color(def.paint.color), texture: this.grunge(), scale: 0.21, coverage: def.paint.coverage, roughness: def.paint.roughness };
    }
    if (!isEmptyPatch(patch)) applyEnvPatch(mat, patch);
    const scanned = def.cc0 ? this.scanned.get(def.cc0) : undefined;
    this.bindMaps(entry, scanned ?? this.proceduralSet(def.kind!), scanned ? CC0_SETS[def.cc0!].tileMeters : def.tileMeters);
    if (def.cc0 && !scanned && this._profile.pbrTextures) void this.loadScanned(def.cc0);
    return mat;
  }

  private disposeEntry(e: Entry): void {
    e.material.dispose();
    for (const t of e.owned) t.dispose();
    for (const d of e.extra) d.dispose();
  }

  private proceduralSet(kind: SurfaceKind): TextureSet {
    let set = this.procedural.get(kind);
    if (!set) {
      const key = `${kind}|${this._profile.textureSize}`;
      const ready = PREFETCHED.get(key);
      PREFETCHED.delete(key);
      set = setTextures(ready ?? setPixels(kind, this._profile.textureSize), this.anisotropy);
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
          if (e.preset && PRESETS[e.preset].cc0 === id) this.bindMaps(e, set, CC0_SETS[id].tileMeters);
          e.onScan?.(id, set);
        }
        for (let i = this.watchers.length - 1; i >= 0; i--) {
          const w = this.watchers[i]!;
          if (w.id !== id) continue;
          this.watchers.splice(i, 1);
          w.cb(set, CC0_SETS[id].tileMeters);
        }
        // the stand-in is no longer referenced: free its GPU copy
        for (const name of PRESET_NAMES) {
          const kind = PRESETS[name].kind;
          if (!kind || PRESETS[name].cc0 !== id || this.handedOut.has(kind)) continue;
          // a kind shared with a preset that has no scan of its own (or another scan) stays
          const shared = PRESET_NAMES.some((n) => PRESETS[n].kind === kind && PRESETS[n].cc0 !== id);
          const stale = shared ? undefined : this.procedural.get(kind);
          if (stale) {
            for (const t of Object.values(stale)) t.dispose();
            this.procedural.delete(kind);
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
    const m = e.material as THREE.MeshStandardMaterial;
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
    const physical = this._profile.glass === 'transmission';
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
