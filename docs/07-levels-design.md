# 07 — Levels, procedural world, tutorial and monetisation (design)

Status: design only. Grounded in `src/types.ts` (`LevelDef`, `Collider`, `ColliderShape`, `RingDef`,
`PropDef`), `src/game/level-data.ts` (`LOFT_LEVEL`, `levelColliders`), `src/game/race.ts`
(`RaceController`), `src/game/surfaces.ts` (`buildSurfaces`, `surfaceBelow`),
`src/physics/physics-world.ts` (`PhysicsWorld.collide`), `src/render/camera-rig.ts` (`CameraRig`,
`pullInsideBox`), `src/render/game-view.ts` (`GameView`, `XR_TIER`, `XR_LOS_PLATFORM`),
`src/core/quality.ts` (`QUALITY_PROFILES`, `qualityProfile`, `DynamicResolution`), `src/main.ts`,
`src/ui/menus.ts`. Verify before starting a work package (not opened while designing):
`src/audio/audio.ts`, `src/render/lights.ts` internals, `src/core/settings.ts`, `src/ui/xr-hud.ts`,
`src/ui/mode-labels.ts`, the service worker (`build/offline-sw.ts`).

## 0. Decisions in one screen

- **Free**: Tutorial, Training Field, Night Loft. **Full Game** (one non-consumable, **$4.99**, SKU
  `full_game`): City, Alpine Valley (mountains / forest), Infinite World. The free tier shows the physics,
  the FC feel and the signature look; the paid content is the volume (large outdoor levels, replayable
  through seeds).
- **One engine for all outdoor content**: a pure-TS `src/world/` module (no DOM, no three) exposing an
  analytic `TerrainField.heightAt(x, z)` plus chunk generators. Training, Alpine Valley and Infinite are
  presets of it; City uses the same chunk / instancing plumbing with a grid generator.
- **Physics never reads meshes**: it calls the same `heightAt` the worker uses. Object colliders stream in
  through a spatial hash.
- **Determinism rule**: generation uses only `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.imul`, `>>>`. No
  `Math.random`, no `Math.sin/cos/exp/pow/atan2` (not bit-exact across engines), no `Date`, no
  iteration-order dependence, no state shared between chunks.
- **Platforms**: web / PWA demo (free tier only, store links), iOS / Android through StoreKit / Play
  Billing, Quest through the Digital Goods API, all behind one `EntitlementProvider`.

## 1. Level system refactor

### 1.1 Types (src/types.ts)

`LevelDef` is indoor-only today (`room: RoomDef`, `props`). Split it and keep the old shape as
`IndoorLevel`, so `LOFT_LEVEL` and its tests keep compiling.

```ts
export type LevelId = 'tutorial' | 'training' | 'night-loft' | 'city' | 'alpine' | 'infinite';
export interface EnvDef {
  sky: 'night-loft' | { top: number; horizon: number; sunDir: [number, number, number]; sunColor: number; sunIntensity: number; hemi: [number, number] };
  fog: { color: number; viewDistance: number };   // 1 % visibility; FogExp2 density = 2.15 / viewDistance
  ambience: { kind: 'room' | 'wind'; gain: number };
  shadows: 'static-spots' | 'sun-follow' | 'none';
}
export interface WorldBounds {                      // soft limits; indoor keeps hard planes in PhysicsWorld
  kind: 'room' | 'rect' | 'infinite';
  min?: [number, number]; max?: [number, number];  // x, z
  maxAgl: number;                                   // altitude cap above ground (outdoor 120 m)
}
export interface LevelBase {
  id: LevelId; name: string; tier: 'free' | 'full';
  env: EnvDef; bounds: WorldBounds;
  rings: RingDef[];                                 // may be empty (Infinite free fly)
  spawn: { position: [number, number, number]; yaw: number };
  pilot: [number, number, number];                  // LOS spot; y = ground + 1.7 outdoors
  pilotPlatform: number;                            // XR deck height above ground (loft 2.4, outdoor 2.0)
}
export interface IndoorLevel extends LevelBase { kind: 'indoor'; room: RoomDef; props: PropDef[] }
export interface OutdoorLevel extends LevelBase { kind: 'outdoor'; world: WorldSpec; statics: Collider[] } // authored extras
export type LevelDef = IndoorLevel | OutdoorLevel;
export type WorldSpec =
  | { gen: 'terrain'; genVersion: number; seed: number; preset: 'training' | 'alpine' | 'infinite' }
  | { gen: 'city'; genVersion: number; seed: number };
```

`ColliderShape` gets no new geometry for terrain: the heightfield is the `TerrainField`, and contacts
report `Contact.colliderId = 'terrain'`.

### 1.2 Registry (src/levels/registry.ts)

```ts
export interface LevelEntry {
  id: LevelId; name: string; tier: 'free' | 'full'; kind: 'authored' | 'seeded';
  build(arg?: { seed?: number }): LevelRuntime; blurb: string;
}
export const LEVELS: readonly LevelEntry[];
export function buildLevel(id: LevelId, seed?: number): LevelRuntime;
export interface LevelRuntime {
  def: LevelDef; terrain: TerrainField | null; colliders: ColliderSource; surfaces: SurfaceProvider; ready: Promise<void>;
}
```

`LevelRuntime` replaces the raw `LevelDef` in `PhysicsWorld`, `RaceController`, `CameraRig` and
`GameView`. `LOFT_LEVEL` is wrapped by `src/levels/night-loft.ts` (adds `kind: 'indoor'`, `env`,
`bounds`); `level-data.ts` stays the data file and keeps exporting `levelColliders`.

`main.ts` builds `GameView`, `Simulation` and `RaceController` once with `LOFT_LEVEL` today. The new
`startLevel(id, seed?)`:
1. checks the entitlement;
2. `buildLevel`;
3. `await runtime.ready` (the chunks around the spawn);
4. `view.loadLevel(runtime)`, `sim.world.setLevel(runtime)`, `race.setLevel(runtime)`;
5. rebuilds the camera rig and teleports to the spawn.

`GameView.loadLevel` disposes the previous level group (geometry, textures, instanced buffers).

### 1.3 Physics (src/physics)

`PhysicsWorld.collide()` tests 5 spheres against 6 room planes plus a linear scan of `this.colliders`
using `bound`. Changes:

1. A `Boundary` strategy replaces the six `sphereVsPlane` calls. `IndoorBoundary` is the current code
   verbatim (loft behaviour and tests unchanged); `OutdoorBoundary` handles terrain and soft bounds.
2. New `sphereVsTerrain(c, r, field, hit)` in `collision.ts`:
   - `h = field.heightAt(c.x, c.z)`; if `c.y - r > h + 1` return false (early out).
   - Normal by central differences, eps 0.25 m: `n = normalize(h(x-e) - h(x+e), 2e, h(z-e) - h(z+e))`.
   - Distance along the normal `d = (c.y - h) * n.y`; hit when `d < r`, depth `r - d`, point `c - n·d`.
     Slope-correct, so cliffs up to the generator's slope cap do not tunnel.
   - The generator guarantees a Lipschitz slope ≤ 2.5 (≈ 68°) by soft saturation of the gradient; a unit
     test checks it.
   - Cost: one `heightAt` per step at the drone centre; above 1 m AGL skip all 5 spheres (offsets ≤ 0.1 m,
     so the slope cap bounds the miss at 0.25 m). Budget ≤ 10 µs per step on average (1 % of a core at
     1 kHz).
3. `ColliderGrid` (`src/physics/collider-grid.ts`): uniform hash, 16 m cells, key
   `((ix & 0xffff) << 16) | (iz & 0xffff)` in a `Map<number, WorldCollider[]>`. Each collider goes in
   every cell its `bound` overlaps. `insertOwned(owner, colliders)` / `removeOwner(owner)` support chunk
   streaming (owner = chunk key). `collide()` queries only the sphere's cell(s). Indoor keeps its flat
   list of about 30 colliders.
4. No new shapes. Buildings are `box` with `yaw`; trunks and canopies `cylinder`; bridges and skybridges
   `box`; a house is two boxes (walls + a roof box approximating the gable). Only objects within one
   chunk ring of the drone are registered (3×3 chunks, ≈ 150–500 colliders); the grid makes the query O(1).
5. `groundEffectAt` / `groundBoxes`: outdoors the base height is `terrain.heightAt` instead of 0, box tops
   come from the grid query.
6. The `reset()` floor clamp `minY` uses the ground height at the spawn.
7. Terrain is always available even when a chunk's objects are not generated yet, so the drone cannot
   fall through the world while the worker is busy; chunk priority builds the 3×3 around the drone first.

Physics runs in float64, exact far from the origin; only the renderer needs rebasing (1.7).

### 1.4 Race (src/game/race.ts, surfaces.ts)

- `buildSurfaces(level)` becomes `SurfaceProvider { topBelow(x, y, z): number }`. `surfaceBelow` starts
  from `groundAt(x, z)` (0 indoors, `heightAt` outdoors) instead of `let top = 0`, then raises to box tops
  ≤ y. Rooftops come from the same collider boxes (the non-walkable list `bulb-hanging/beam/duct` stays).
- `respawnPoint()` keeps `this.level.spawn.position[1]` as the clearance over `surfaceBelow`. Under water
  (`terrain.waterLevelAt(x, z) > ground`) search 8 directions out to 40 m for dry ground.
- `UPSIDE_DOWN_HEIGHT = 0.3` is compared with `state.position.y`; change it to AGL (`y - groundAt`).
- Infinite free fly: `respawnPoint()` returns the last landing (disarmed and still) or the spawn.
- Bounds: `step()` handles `WorldBounds`. Outside the bounds or above `maxAgl` it emits
  `{ type: 'out-of-bounds'; seconds: number }`, and after 5 s it respawns.
- Persistence: `bestTimeKey(levelName)` is keyed by display name; switch to `LevelId` and migrate the
  `Night Loft` key to `night-loft` once at boot. Infinite has no best times; the optional "Seed Run"
  (10 generated rings along a path, `ringsFromSeed(field, seed)`) stores `drone-sim.best.infinite.<code>`.
- `RaceController` `Mode` gains `'tutorial'`: free-fly semantics, no timer, rings passable, a crash
  respawns to the pad.

### 1.5 Camera rig (src/render/camera-rig.ts)

- The constructor `(pilot, roomSize)` becomes `(level: LevelRuntime)`.
- `pullInsideBox` stays as `IndoorConstraint`. `OutdoorConstraint.pullCamera(from, cam)` keeps
  `cam.y ≥ heightAt(cam) + 0.35`, marches the drone→camera segment in 8 steps against the terrain and the
  16 m collider grid (boxes), and pulls back to the last clear sample. It replaces `pullInside` in both
  `updateChase` calls.
- LOS outdoors (`updateHead`): `overview` = the next ring, else the level centre.
- LOS FOV tightens with range: 62° at ≤ 40 m down to 28° at ≥ 200 m (smoothed).
- Pilot relocation (non-VR): over 260 m, or terrain blocking eye→drone for over 1.5 s, fade 0.3 s and
  re-plant the pilot 35 m behind the drone (against its velocity), eye at ground + 1.7. Fixed-route
  levels (Training, City) never relocate.
- `losFloorAnchor` returns the ground y instead of 0; the LOS marker and the XR platform use it.

### 1.6 Render (src/render)

`GameView` builds the room, props, `Lights(scene, level)`, background `0x04060b` and
`FogExp2(0x0b0f1a, 0.016)` inline today. Extract:

```ts
export interface LevelView {
  readonly group: THREE.Group; readonly staticMeshes: THREE.Mesh[];
  update(dt: number, drone: DroneState, camPos: THREE.Vector3): void;   // streaming, sky, sun follow
  setProfile(p: QualityProfile, o: OutdoorProfile): void; dispose(): void;
}
```

- `IndoorLevelView` wraps the existing code unchanged (room, `buildProps`, `Lights`, `StaticBatcher`,
  `Atmosphere`).
- `OutdoorLevelView` (`src/render/outdoor/`):
  - `sky.ts`: dome with a vertical gradient shader, sun disc, analytic cloud layer; no textures.
  - `sun.ts`: `DirectionalLight` + `HemisphereLight`; shadow camera a 90 m box following the drone,
    snapped to the texel grid, ultra / high only.
  - `terrain-view.ts` (chunk mesh pool), `scatter-view.ts` (trees, houses, rocks as instances),
    `water.ts`, `city-view.ts`.
- Fog: `FogExp2` density `2.15 / viewDistance`, colour = sky horizon (one shared uniform), so distant
  terrain dissolves into the sky.
- Materials: `MeshLambertMaterial` with vertex colours for terrain and houses (flat-shaded low-poly); a
  256 px canvas-generated detail noise multiplied in through `onBeforeCompile` for grass breakup.
  Instancing uses a custom `InstancedBufferAttribute` `aInst` (x, y, z, scale, packed yaw) transformed in
  the vertex shader: 20 B per instance instead of a 64 B matrix.
- `Atmosphere` dust motes are indoor only; speed lines and FX still work outdoors. `ContactShadow`
  samples the ground height.

### 1.7 Floating origin

`WorldOrigin { x, z }` is an integer multiple of the chunk size. `GameView` subtracts it from the drone,
camera and chunk positions; rebase when `|drone − origin| > 1024 m` (move chunk meshes, rebuild instance
buffers, ≈ 1 ms). Physics, race and generation keep absolute doubles. World radius is capped at 50 km (a
soft "edge of the world" prompt) so integer hashing never overflows.

### 1.8 Audio and XR

- `GameAudio.setAmbience({ kind: 'wind', gain })`: a looped synthesized pink-noise buffer through a
  lowpass, cutoff and gain driven by speed and AGL plus a slow gust LFO. No assets.
- XR: the `xrDolly` y offset is `ground + pilotPlatform` (loft keeps 2.4 = `XR_LOS_PLATFORM`; outdoors a
  2.0 m lookout deck with rails at `terrain.heightAt(pilot)`). `XR_TIER = 'low'` selects the Quest
  outdoor profile. VR relocation is a fade-teleport (no FOV change, no smooth locomotion) beyond 120 m.
  Level select and tutorial cards render through `XrPanel`.

## 2. Procedural world engine (src/world)

Pure TS, importable by the worker, the main thread (physics) and Vitest.

### 2.1 Randomness and noise (rng.ts, noise.ts)

- `hash2(seed, ix, iz, salt)`: a 32-bit murmur3-style finalizer (`Math.imul`, `>>>`, xor-shifts);
  `u01(h) = h / 4294967296`. Every feature draws from a pure hash of (seed, integer cell, stream salt),
  never from a sequential generator, so chunk order and thread do not matter.
- 2D gradient noise (Perlin-style): lattice gradients from 8 literal unit vectors (e.g. `(1, 0)`,
  `(0.7071067811865476, 0.7071067811865476)`), quintic fade `t*t*t*(t*(t*6-15)+10)`; a `noised` variant
  returns value + derivative.
- Terrain fBm is derivative-damped (each octave's amplitude divided by `1 + |Σ gradients|²`), which gives
  erosion-like slopes and flat valley floors. 5 octaves for the physics-critical base, up to 7 for visual
  detail at LOD0; octaves rotated by the literal matrix (0.8, −0.6; 0.6, 0.8), lacunarity 2.0, gain 0.5.
- Mountains add a ridged term `(1 − |n|)²` weighted by the mountain mask.
- Domain warp: two low-frequency noise samples shift the sampling position by up to 120 m.
- No transcendental functions in `src/world`: a unit test scans the folder for
  `Math.(sin|cos|tan|atan2|exp|log|pow|random)` and `Date`.

### 2.2 Height function (terrain-field.ts)

```ts
export interface TerrainField {
  readonly seed: number; readonly genVersion: number;
  heightAt(x: number, z: number): number;        // final, includes carving / flattening
  baseHeightAt(x: number, z: number): number;    // pre-settlement, for placement tests
  waterLevelAt(x: number, z: number): number;    // -Infinity when dry
  biomeAt(x: number, z: number, out: BiomeSample): void;
  readonly maxHeight: number;                    // for chunk culling
}
```

Layers in a fixed order (no circular dependencies): (1) continental mask (6 km wavelength) blending plains
(0–25 m), hills (≈ 120 m) and mountains (≈ 700 m); (2) rivers carve; (3) lakes fill basins below
`LAKE_LEVEL = 6 m`; (4) village plateaus; (5) road flattening. Placement of villages and roads uses
layers 1–3 only.

**Rivers**: channels are the zero set of a warped low-frequency noise, valley mask
`v = 1 − smoothstep(0, W, |warpedNoise|)`; they meander and occasionally branch, fully analytic. Water
surface `wl = lowpassHeight(x, z) − 1.2` (2 lowest octaves) so it changes smoothly along the channel;
carving `h = mix(h, wl − 2.5, channelMask)` with a 60 m valley bias so the surface descends
monotonically. The mask fades above 300 m so streams end in the mountains. Not a true drainage network:
fall back to a lake where it looks wrong.

**Villages and roads** (settlements.ts, roads.ts): villages on a jittered 512 m grid, one candidate per
cell by hash, accepted when slope < 0.12, `baseHeightAt` > lake level + 2 and outside river masks;
radius 60–140 m, 6–30 houses on 2–3 street rings, one church or tower, a plateau at the mean low-pass
height. Roads link each village to up to 2 nearest accepted neighbours in the 3×3 cell block: a polyline
with hash-displaced midpoints sampled every 24 m, smoothed (Chaikin ×2); mask by distance to the nearest
segment (per-cell memoised segment lists), `h = mix(h, lowpassHeightAtNearest, mask)` (6 m deck, 10 m
shoulder). Where a road crosses a river mask > 0.3 a bridge prop (deck box + two rail boxes) replaces
flattening. Per-thread LRU caches of 256 cells.

**Trees** (scatter.ts): jittered 8 m grid, accepted by `forestDensity(x, z) = f(moisture, elevation, slope)`
against `u01(hash)`; none on roads, rivers, village plateaus, above the 420 m treeline or on slopes > 0.9.
Conifer above 120 m or in cold biomes, broadleaf in lowlands, scrub in dry zones; scale 0.8–1.4 by hash.
Rocks on steep or high cells.

### 2.3 Chunks and streaming (chunk-gen.ts, chunk-builder.ts, world-worker.ts)

- 128 m chunks keyed by integers `cx, cz`; nested LOD grids so shared vertices coincide: LOD0 64×64 quads
  (2 m), LOD1 32×32 (4 m), LOD2 16×16 (8 m); 6 m skirts hide cracks.
- Worker output per chunk (transferable typed arrays): `positions` Float32 (n²·3), `normals` Int8,
  `colors` Uint8 (baked from slope, height, biome, moisture: snow, rock, grass tint, farmland, verge), a
  `water` ribbon mesh, a `roads` ribbon mesh (6 m wide, +0.06 m, dashed centre line in vertex colour),
  `trees` Float32 (x, y, z, scale, yaw, species), `houses` Float32 (x, y, z, w, h, d, yaw, archetype,
  colour), packed `colliders`; index buffers shared per LOD.
- Cost: ≈ 4 225 height evaluations for LOD0 at ≈ 3 µs → ≈ 13 ms per chunk in a worker; LOD2 ≈ 1 ms.
- `ChunkBuilder` with `WorkerChunkBuilder` (module worker,
  `new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' })`, 2 workers when
  `hardwareConcurrency ≥ 6`) and `InlineChunkBuilder` (same code, time-sliced 3 ms per frame) for tests,
  WKWebView failures and no-worker environments.
- `ChunkStreamer`: ring order by distance; ≤ 2 uploads per frame desktop, 1 on Quest / phone; LOD
  hysteresis 0.25 chunk; the 3×3 around the drone is never dropped; a pool of 128 meshes / geometries is
  recycled. `ready` resolves when the 3×3 around the spawn is built (< 600 ms desktop, < 1.5 s Quest).
- Physics registration: chunks within one ring of the drone call `grid.insertOwned(key, colliders)` and
  are removed when they leave.

### 2.4 Instancing and LOD

Trees: conifer (3 stacked cones + trunk, 96 tris) and broadleaf (low icosphere + trunk, 110 tris) at LOD0;
LOD1 a 6-triangle double cone / cross; fog hides the rest → four `InstancedMesh` (2 species × 2 LODs).
Houses: 4 archetypes (cottage, farmhouse, barn, tower), merged geometry with vertex colours, 2 instanced
meshes, windows lit at dusk through an emissive vertex-colour channel. Rocks: 1 mesh. Instance buffers are
rebuilt only when the chunk or LOD set changes (< 1 ms). No impostors needed.

### 2.5 Memory

LOD0 chunk ≈ 84 KB GPU, LOD2 ≈ 5 KB; desktop ultra (121 chunks) ≈ 4 MB terrain + 0.5 MB instances. Caps:
2 000 cached cells, 160 chunk results. Targets: Quest < 150 MB total, phones < 200 MB, desktop < 400 MB.

### 2.6 Seeds, codes and saves (seed-code.ts, src/game/worlds.ts)

- `GEN_VERSION` is stored with every world; each version's generator stays in the repo forever
  (`generators/v1.ts`) so old seeds always reproduce the same map; new algorithms ship as `v2` for new
  worlds only.
- Seed = uint32; free text (e.g. "hello") is hashed to a uint32 with FNV-1a.
- Code: 40 bits = 4-bit version + 32-bit seed + 4-bit checksum, Crockford base32, shown as `K7Q2-9XMF`
  (no I, L, O, U). Decode validates length, alphabet, checksum and version, so typos are caught.
- Share link `https://<host>/?world=K7Q2-9XMF` (PWA, Capacitor via `App.addListener('appUrlOpen')`,
  Quest); `navigator.share` with a clipboard fallback.
- Storage `drone-sim.worlds.v1`:
  `{ v: 1, last: string | null, worlds: [{ id, name (≤ 24), code, seed, gen, created, lastPlayed }] }`, max
  50 entries; corrupt JSON falls back to an empty list.
- Spawn from the seed: spiral out from (0, 0) in 32 m steps to the first dry cell with slope < 0.08,
  preferring the edge of the nearest village within 600 m, facing it. Time of day also from the seed
  (dawn, noon, golden hour, dusk), with a settings override.

## 3. Content plan

Art direction without external assets: stylised low-poly, flat-shaded vertex colours, soft gradient sky,
strong sun, long warm shadows, a teal / orange palette echoing the loft's neon; everything from boxes,
cones, cylinders, icospheres and ribbons.

### Training Field (free, `training`)

- 80 × 80 m flat meadow (± 0.3 m), ceiling 40 m AGL, soft bounds, daytime.
- Pilot spot at the south edge (0, 1.7, 36) looking north; all rings within 30 m, so one fixed LOS view
  (FOV 62°) shows everything. A painted 5 m landing pad 3 m in front of the pilot is the spawn.
- 3 rings, radius 1.25 m (loft 0.75): R0 (0, 3, 22) facing north; R1 (14, 4, 8) facing west-north;
  R2 (−4, 3, 28) facing south, back over the pad. Route ≈ 65 m, a beginner lap ≈ 25 s.
- Aids: 4 striped 6 m corner poles, cones along the route, a wind sock, 2 backdrop hills; the next ring
  pulses. The tutorial runs here (`mode: 'tutorial'`).

### City (full, `city`)

- 1.2 × 1.2 km: 15 × 15 blocks of 80 m (64 m block, 16 m street), bounded, ceiling 250 m AGL, flat ground,
  a river on the east edge, a park block.
- `city-gen.ts`: block height class from a distance-from-centre field + hash (downtown 80–180 m, midrise
  25–60 m, low 8–20 m); 1–4 buildings per block with 2 m setbacks; rooftop props (AC boxes, water tanks,
  antennas); two skybridges and one pass-through slab on stilts.
- Rendering: one instanced unit box with per-instance (size, seed); a facade shader draws floors and
  windows from world-space coordinates, some windows lit by hash; streets one ground plane with lane
  markings / crosswalks in shader; park trees use the shared tree instancing. ≈ 700 buildings in 1 draw.
- Colliders: one box per building + rooftop boxes in the grid (≈ 2 500).
- Route: 18 rings (r 1.5–2 m), ≈ 3 km in 3 acts: street-canyon slalom at 15–25 m, rooftop hop, dive
  through the downtown gap and up the skybridge. Free fly on the same map. Pilot spot on a low roof at the
  south edge; no relocation; FOV narrows with range.

### Alpine Valley (full, `alpine`)

- 3 × 3 km bounded, ceiling 400 m AGL, terrain preset `alpine` with a fixed seed. A hand-authored valley
  spline (6 waypoints) is blended in as a low-amplitude carve so the route is always flyable; the rest is
  ridged mountains, pine forest, a lake, a stream, snow above 520 m, one hamlet with a road.
- 16 rings generated by `routeFromWaypoints(field, waypoints, clearance)` (y = terrain + 6–40 m, direction
  along the path tangent); a test checks no ring is inside a collider or within 3 m of terrain.
- Route ≈ 2.8 km: valley floor, forest trunk slalom, around the lake, saddle crossing, ridge run, valley
  return. Lookout hill at the valley mouth; relocation on; golden hour.

### Infinite World (full, `infinite`)

Free fly + optional Seed Run; no bounds except 50 km and `maxAgl 120 m` (section 2).

## 4. Tutorial (src/game/tutorial.ts, src/ui/tutorial-ui.ts)

`TutorialMachine` is DOM-free and pure, like `RaceController`.

```ts
export interface TutorialCtx {
  dt: number; drone: DroneState; agl: number; armed: boolean; flightMode: FlightMode;
  cameraMode: CameraMode; input: InputFrame; source: InputSource; ringsPassed: number; confirm: boolean;
}
export interface TutorialStepDef {
  id: string; title: string; prompts: (src: InputSource, s: Settings) => string[];
  enter?(m: TutorialMachine): void;
  update(ctx: TutorialCtx, m: TutorialMachine): number; // progress 0..1, 1 = done
  hintAfter: number;
}
export type TutorialPhase = 'idle' | 'running' | 'done' | 'skipped';
```

| # | Step | Complete when |
|---|---|---|
| 1 | Welcome & controls | `confirm` |
| 2 | Arm | `ctx.armed` (FC safety checks apply: throttle low) |
| 3 | Throttle up | `agl ≥ 1.5` |
| 4 | Hover | 3 s with `agl` in [1, 3] and `abs(vy) < 0.4` |
| 5 | Yaw | integrated signed yaw reaches +180° and −180° (two bars) |
| 6 | Pitch & roll | 4 m body-frame travel forward, back, right and left (angle mode forced) |
| 7 | Land | armed, `agl < 0.15`, speed < 0.3 for 1 s |
| 8 | Disarm | `!armed` |
| 9 | Angle vs acro | toggle to acro seen, then back to angle; copy explains self-level |
| 10 | Cameras | LOS, FPV and chase each active once |
| 11 | First ring | `ringsPassed ≥ 1` (Training ring 0) |
| 12 | Done | Start Training / Menu |

- Angle mode forced during steps 2–8, the player's setting restored on exit. A crash resets to the pad and
  repeats the step. No progress for 20 s → hint highlights the relevant stick on the visualiser and
  repeats the prompt.
- Prompts are generated, never hard-coded: `promptFor(stepId, source, settings)` composes strings from
  `mode-labels.ts` (`stickLong`, `stickShort`, `padControls`, `keyboardKeys`, `throttleControl`,
  `throttleDownHint`), honouring stick modes 1–4 and remaps. Touch points at the virtual sticks and ARM;
  gamepad shows the pad diagram; keyboard shows key caps; XR shows Touch controller glyphs.
- VR: an `xrHudContent` `tutorial` branch — one card in front of the platform with title, 1–2 lines and
  a progress bar; trigger advances, holding B 1.5 s skips; LOS on the platform; no DOM in the headset.
- Skip: HUD button, Esc, gamepad B held 1 s, touch "Skip" chip, VR B-hold.
- Storage `drone-sim.tutorial.v1 = { done, skipped, step, at }`. First run: modal "New to FPV? 3-minute
  tutorial" [Start] [Skip]; Skip never nags again. Replay from the menu and the pause menu. Completion
  shows the Full Game card once, non-blocking.

## 5. Entitlements and IAP (src/store)

```ts
export type Sku = 'full_game';
export interface EntitlementProvider {
  readonly id: 'quest' | 'ios' | 'android' | 'web';
  init(): Promise<void>;
  price(sku: Sku): Promise<{ text: string; value: string; currency: string } | null>;
  has(sku: Sku): boolean;                       // sync, from cache
  purchase(sku: Sku): Promise<'ok' | 'cancelled' | 'pending' | 'error'>;
  restore(): Promise<boolean>;
}
export class Entitlements {
  constructor(p: EntitlementProvider, storage: Storage | null);
  isUnlocked(level: LevelEntry): boolean; onChange(cb: () => void): void;
}
```

- Cache `drone-sim.ent.v1 = { sku, provider, at }` so offline play works after a purchase; re-verified on
  every online launch via `restore()` (refunds revoked at the next online check).
- **Quest** (`providers/quest.ts`): `getDigitalGoodsService('https://quest.meta.com/billing')`;
  `getDetails(['full_game'])` for the localized price; `listPurchases()` to restore (non-consumable).
  Purchase: `new PaymentRequest([{ supportedMethods: 'https://quest.meta.com/billing', data: { sku: 'full_game' } }], { total: { label: 'Full Game', amount: { currency: 'USD', value: '4.99' } } })`,
  `await req.show()`, `response.complete('success')`. Feature-detect; on failure behave as demo with a
  visible error. Needs the SKU in the Meta dashboard and the app id (reintroduce `OCULUS_APP_ID` with the
  real id when listing). Server-side verification later; v1 trusts the client + cache.
- **iOS / Android** (`providers/native.ts`): a thin Capacitor plugin `DroneSimBilling` (StoreKit 2 / Play
  Billing 7: `getProduct`, `purchase`, `restore`), ≈ 150 lines per platform, product id `full_game` at the
  $4.99 tier. Visible "Restore Purchases" (Apple); no web store links or external purchase hints in native
  builds (App Store 3.1.1).
- **Web** (`providers/web.ts`): `has()` false, no purchase; locked cards show "Get the full game" with App
  Store / Google Play / Quest links. `?unlock=1` dev override only when `import.meta.env.DEV`.
- Gating: (1) `Entitlements.isUnlocked` in level select (badge); (2) a hard guard in `main.startLevel`
  (locked id → paywall); (3) `?world=` deep links on a locked build open the paywall and keep the code
  pending. Optional 3-minute Infinite preview per launch (owner decides; default off). One bundle SKU, not
  per-level purchases; entitlements are not shared across stores.

## 6. UI

- Main menu (`menus.ts`): `ScreenName` gains `'levels' | 'worlds' | 'paywall' | 'tutorial-prompt'`;
  `UiAction` gains `{ type: 'tutorial' }`, `{ type: 'level'; id; seed? }`, `{ type: 'purchase' }`,
  `{ type: 'restore' }`; Race / Free Fly act on the selected level.
- Level select (`level-select.ts`): cards with a procedural canvas thumbnail, name, blurb, best time; a
  `Locked` badge with the price; gamepad / keyboard focus via the existing `Item` list and `NavEvents`;
  Race and Free Fly per level (Infinite: Free Fly and Seed Run).
- Worlds (Infinite): "New random world" (seed from `crypto.getRandomValues`, then deterministic); "Enter
  seed or code" with live validation; saved list (name, code, last played) with Rename / Delete / Share /
  Play; playing a seed auto-saves it as "World K7Q2" until renamed.
- HUD outdoors: compass tape (heading, distance to pilot, AGL); a 128 px north-up minimap (drone arrow,
  bearing to the next ring, rivers / roads from `biomeAt` at 64 m/px, 4 Hz), off by default on Quest
  (the XR card shows distance + AGL).
- Settings: time of day, view distance (Auto / Short / Medium / Long), minimap, wind volume, units
  (m / ft), Restore Purchases. Out-of-bounds toast with the 5 s countdown; pause menu "Return to pilot".

## 7. Performance budgets and tiers

An `OutdoorProfile` table next to `QUALITY_PROFILES`; XR forces `'low'`.

| Target | Frame | Chunk radius / count | LOD0 / LOD1 / LOD2 | Fog 1 % | Trees LOD0 / LOD1 | Shadows | Draw calls | Triangles |
|---|---|---|---|---|---|---|---|---|
| Desktop ultra | 120 Hz | 5 / 121 | 9 / 16 / 96 | 1200 m | 3000 / 12000 | sun 2048, 90 m | ≤ 180 | ≤ 0.9 M |
| Desktop high | 60–120 | 4 / 81 | 9 / 16 / 56 | 900 m | 2000 / 8000 | sun 2048 | ≤ 150 | ≤ 0.6 M |
| iPhone / tablet (medium) | 60 Hz | 3 / 49 | 1 / 8 / 40 | 600 m | 800 / 4000 | contact only | ≤ 110 | ≤ 250 k |
| Quest 2 (XR low) | 72 Hz, 2 eyes | 2 / 25 | 0 / 4 / 21 | 350 m | 300 (40 tris) / 2500 | none | ≤ 80 | ≤ 120 k |
| Low / software GPU | 30–60 | 2 / 25 | 0 / 4 / 21 | 300 m | 0 / 1500 | none | ≤ 70 | ≤ 80 k |

CPU: terrain physics ≤ 10 µs per step; chunk upload ≤ 2 ms desktop, ≤ 1 ms phone / Quest; instance
rebuild ≤ 1 ms only on chunk change; no per-frame allocations in update paths. City: 1 draw for
buildings, 1 for ground, ≈ 30 for trees / props (Quest uses a facade shader without lit windows).
Adaptive: `DynamicResolution` first; if the render scale sits at 0.5 for over 3 s, scale fog distance and
chunk radius by 0.75 (floor 2 chunks) via `OutdoorLevelView.setViewScale`.

## 8. Work packages

One owner per file; `src/main.ts` is owned only by WP-K.

**Phase 0 (serial)** — WP-A Contracts: `src/types.ts`, `src/levels/registry.ts`, `src/levels/night-loft.ts`,
`src/game/level-data.ts` (adds `kind`, `env`, `bounds`; exports unchanged), `src/game/surfaces.ts`,
`src/game/race.ts`, race tests. Deliverable: types + the `LevelRuntime` seam with every loft test green.

**Phase 1 (parallel after A)**
- WP-B Physics: `physics-world.ts`, `collision.ts`, `collider-grid.ts`, `simulation.ts`, tests (stub
  `TerrainField` until WP-C lands).
- WP-C World engine core: `src/world/{rng,noise,terrain-field,settlements,roads,scatter,chunk-gen,generators/v1}.ts`
  + tests, `src/world/worker/{world-worker,chunk-builder}.ts`.
- WP-D Render seam + camera: `game-view.ts`, `level-view.ts`, `indoor-level-view.ts`, `camera-rig.ts`,
  `lights.ts`, `core/quality.ts`, `audio/audio.ts`.
- WP-E Entitlements: `src/store/**`, native billing plugin dirs, `capacitor.config.ts` (registration).
- WP-F Tutorial: `game/tutorial.ts`, `ui/tutorial-ui.ts`, `ui/xr-hud.ts`, `ui/mode-labels.ts`, tests.
- WP-G Seeds / worlds: `world/seed-code.ts`, `game/worlds.ts`, tests.

**Phase 2 (parallel after C, D)**
- WP-H Outdoor renderer: `render/outdoor/{outdoor-view,sky,sun,terrain-view,scatter-view,water}.ts`,
  `render/materials-outdoor.ts`.
- WP-I Content: `levels/{training,alpine,infinite,city}.ts`, `world/city-gen.ts`, `world/routes.ts`,
  `render/outdoor/city-view.ts`, tests.
- WP-J UI: `menus.ts`, `level-select.ts`, `worlds-screen.ts`, `hud.ts`, `minimap.ts`, `core/settings.ts`,
  styles.

**Phase 3 (serial)** — WP-K Integration: `main.ts` (`startLevel`, entitlement guard, deep links, tutorial
hooks, bounds events), service-worker precache (worker chunk + new files), Playwright specs, performance
pass.

Dependencies: B, C, D, E, F, G need A only (B and D can start on stubs); H needs C, D; I needs A, C (and G
for the Infinite spawn); J needs A, E, G; K needs all.

### Tests

- Unit: hash / PRNG golden vectors; `heightAt` golden values at 20 points for seeds 1, 42, 0xFFFFFFFF
  (bit-exact fixture); chunk results identical across LODs at shared vertices and independent of
  generation order; the no-transcendentals scan; slope cap over 50 k samples; seed-code round-trip,
  checksum catches any single-character edit, version rejection; worlds store corrupt-JSON fallback;
  `sphereVsTerrain` (rest on flat, roll on slope, no tunnelling at 40 m/s, cliff); `ColliderGrid`
  ownership; ring routes never inside colliders and ≥ 3 m above terrain; `surfaceBelow` on terrain and
  rooftops; respawn onto terrain and the out-of-bounds timer; tutorial machine on synthetic `TutorialCtx`
  sequences (incl. skip and crash-repeat); entitlement providers with fakes.
- Cross-engine determinism: `InlineChunkBuilder` and `WorkerChunkBuilder` byte-identical; the golden
  fixture run under Node, Playwright Chromium and WebKit.
- E2E: level select locked badges + paywall on the web build; `?unlock=1` dev build starts every level
  and reaches free fly; tutorial first-run prompt once, Skip persists, steps 1–4 with scripted keyboard,
  replay; seed flow (new, rename, save, reload, reopen, compare a height probe via the debug hook);
  `?world=` share link; IWER XR smoke for the tutorial card and the Quest platform height.
- Performance: Playwright capture of draw calls / triangles per tier against the table (20 % margin);
  Quest measured on device before release.

### Risks

1. Module workers inside WKWebView (`capacitor://`) and the service-worker precache → `InlineChunkBuilder`
   fallback + a test that the worker chunk is precached.
2. Cross-engine float drift → arithmetic-only rule + cross-engine golden test; fallback: quantise heights
   to 1/64 m.
3. Quest 2 frame time with trees and fog → tree LOD0 off on Quest if over budget, fog end 250 m.
4. River realism on steep terrain → lakes / thinner streams on high slopes; owner reviews 20 seeds.
5. Terrain physics at 1 kHz → early-out + single-sample check, benchmark test fails above 20 µs per step.
6. IAP needs console work only the owner can do (Apple restore button / no external links, Meta SKU and
   policy, Google product activation); Quest entitlement client-trusted until server verification.
7. Scope: City facade shader and Alpine route tuning are the largest content costs. Ship order:
   Training + Tutorial, then Alpine, Infinite, City.
