# 09 — World engine (`src/world`)

The procedural world of docs/07-levels-design.md §2 (and the City / Alpine content of §3) as a pure TypeScript
module: no DOM, no three.js. The same code runs in the chunk worker, on the main thread (physics, race, spawn)
and in Vitest, and produces the same bytes in every engine. This note is the contract the renderer (WP-H),
physics (WP-B), levels (WP-I) and UI (WP-J) consume. Nothing in `src/render`, `src/physics`, `src/levels`,
`src/ui` or `main.ts` uses it yet; integration comes later.

## 1. Modules

| File | What it provides |
|---|---|
| `world.ts` | `createWorld(spec)`, `WorldSpec { seed, preset, genVersion }`, `World`, `GEN_VERSION = 1`, `SUPPORTED_GEN_VERSIONS`, `worldKey`. |
| `index.ts` | Barrel of the public API below. |
| `generators/v1.ts` | Generator v1: wires presets, villages and roads together; the Alpine hamlet and road. Frozen once shipped. |
| `math.ts` | `clamp`, `mix`, `smoothstep`, `smin`/`smax`, deterministic `dsin`/`dcos`/`datan2`, `yawFacing`, `LruCache`, `cellKey`. |
| `rng.ts` | `hash2(seed, ix, iz, salt)` (murmur3 finalizer), `u01`, `rehash`, `subSeed`, stream salts `SALT`. |
| `noise.ts` | `noised` (gradient noise + derivative), `fbm`, `fbmDamped` (derivative-damped), `ridged`, `warp`. |
| `base-terrain.ts` | Layers 1–3 per preset (`training`, `alpine`, `infinite`): relief, rivers, lakes, `climate`. Alpine constants (`ALPINE_VALLEY`, `ALPINE_LAKE`, `ALPINE_MOUTH`, `ALPINE_HALF`). |
| `terrain-field.ts` | `TerrainField` interface, `ComposedTerrainField` (adds village plateaus and road beds), `BIOME`, `BiomeSample`, `classify`, `forestDensity`. |
| `settlements.ts` | Villages on the jittered 512 m grid, `villageLayout` (houses), `HOUSE_ARCHETYPES`. |
| `roads.ts` | Village links, Chaikin smoothing, bridges, `ROAD_HALF_WIDTH` / `ROAD_SHOULDER` / `ROAD_MAX_CUT`. |
| `scatter.ts` | Trees, rocks, houses and bridges per chunk, packed layouts and strides, `TREE_DIMENSIONS`. |
| `chunk-gen.ts` | `buildChunk`, `buildChunkSteps` (resumable), `chunkIndices`, `chunkColliders`, `chunkDigest`. |
| `worker/chunk-builder.ts` | `ChunkBuilder`, `WorkerChunkBuilder`, `InlineChunkBuilder`, `createChunkBuilder`. |
| `worker/world-worker.ts`, `worker/protocol.ts` | The module worker and the message handler it shares with tests. |
| `seed-code.ts` | `encodeSeed`, `decodeSeed`, `parseSeedInput`, `fnv1a32`. |
| `spawn.ts` | `spawnFromSeed(world)`. |
| `routes.ts` | `routeFromWaypoints`, `ALPINE_ROUTE`, `worldObstacles`, `distanceToShape`, `clearanceAt`. |
| `city-gen.ts` | `generateCity(seed)` (buildings, roof props, skybridges, slab, park, river, 18-ring route), `cityTerrainField`, `cityObstacles`, `clearPoint`. |
| `src/game/worlds.ts` | Saved Infinite worlds (`drone-sim.worlds.v1`). |

## 2. Rules that keep worlds reproducible

- **Arithmetic only** in `src/world`: `+ - * /`, `Math.sqrt|floor|ceil|round|abs|min|max|imul`, `>>>`. No
  `Math.sin/cos/tan/atan2/exp/log/pow/random/hypot`, no `**`, no `Date`. Trigonometry uses `dsin` / `dcos` /
  `datan2` (fixed polynomials). `tests/unit/world-determinism.test.ts` scans the folder.
- **Hashes, not sequences**: every decision is `hash2(seed, integer cell, salt)`. Chunks build in any order, on any
  thread, with any cache history; the caches (`LruCache`) only hold pure functions of their key.
- **Versioned generators**: `GEN_VERSION` is stored with every saved world. Any change that moves a height, a tree,
  a house or a ring is a new generator (`generators/v2.ts`, `GEN_VERSION = 2`) for new worlds only; v1 stays in the
  repo. `createWorld` throws for a version this build does not ship.
- **Golden fixture**: `tests/unit/fixtures/world-golden.json` pins `heightAt` at 20 points × seeds 1, 42,
  0xFFFFFFFF × 3 presets plus five chunk digests. It is checked in Node (Vitest) and in Chromium and WebKit through
  the real module worker (`npx playwright test -c playwright.world.config.ts --reporter=list`). Regenerate only with
  a generator version bump: `WORLD_GOLDEN_UPDATE=1 npx vitest run tests/unit/world-determinism.test.ts`.

## 3. Creating a world

```ts
import { createWorld, GEN_VERSION } from '../world';
const world = createWorld({ seed: 0x1234abcd, preset: 'infinite', genVersion: GEN_VERSION });
world.field.heightAt(x, z);
```

| Preset | Area | Content |
|---|---|---|
| `training` | unbounded, the course inside ±40 m | Flat to ±0.3 m within the field, gentle 45 m hills from 110 m out, no water; no scatter within 110 m of the origin (`BaseTerrain.clearRadius`). The authored Training level keeps `world: { gen: 'flat' }` and its own props today; switching it to this preset is a level decision. |
| `alpine` | 3 × 3 km around the origin (`ALPINE_HALF`) | Ridged mountains to ≈ 800 m, a U-valley along an 8-point spline (`ALPINE_VALLEY`), a stream, a lake (`ALPINE_LAKE`, radius 150 m), a wide basin at the valley mouth with a 9-house hamlet and a road to the south edge, snow from 520 m, treeline 420 m. Fixed content; the seed changes the mountain noise. |
| `infinite` | ±50 km | Continental mask (6 km) blending plains (0–25 m), hills (≈ 120 m) and ridged mountains (≈ 650 m); meandering rivers that fade uphill; lakes below `LAKE_LEVEL = 6`; villages, roads, bridges; snow from 560 m, treeline 420 m. |

A `World` holds per-thread caches, so build one per spec per thread and reuse it (the worker keeps the last four).

## 4. `TerrainField` (physics, race, camera, spawn)

```ts
interface TerrainField {
  readonly seed: number; readonly genVersion: number; readonly preset: TerrainPreset | 'city';
  heightAt(x, z): number;            // final ground: rivers, lakes, village plateaus, road beds
  baseHeightAt(x, z): number;        // layers 1–3 only (placement tests)
  waterLevelAt(x, z): number;        // water surface, −Infinity when dry
  biomeAt(x, z, out: BiomeSample): BiomeSample;
  readonly maxHeight: number; readonly minHeight: number;   // culling bounds of heightAt
}
```

- It is a superset of `TerrainField` in `src/types.ts` (`heightAt` only), so `world.field` plugs into the
  `LevelRuntime.terrain` seam unchanged.
- **Slope cap**: |∇h| ≤ 2.5 everywhere, so `sphereVsTerrain` with a 0.25 m central difference cannot tunnel
  (07 §1.3). Every carve (valley, river bank, lake bowl) is a smooth-min against a cone of bounded slope, and the
  village / road layers blend with bounded steps, so the relief noise sets the cap. The test samples 50 000
  points per preset; the steepest found by a refining search over 16 seeds is ≈ 2.2 (Alpine) and ≈ 1.9 (Infinite).
- **Cost**: warm `heightAt` ≈ 0.7 µs (Apple M4, Node 22). The first call inside a new 128 m cell derives that
  cell's villages and roads (≈ 1 ms, then cached for 1 024 cells). Caches are per thread: with the worker building
  chunks, the main thread still pays that 1 ms once per cell the drone enters (Infinite only; ≈ every 3 s at
  40 m/s).
- **Water**: `waterLevelAt` returns the river / lake surface where it is above the ground. Rivers and the lake are
  ringed by levees, so water never ends in mid-air (tested).
- **Biomes**: `biomeAt` fills `BiomeSample { biome, height, water, slope, moisture, temperature, forest, road,
  village, river, snow }`; `biome` is one of `BIOME` (`water, beach, meadow, farmland, forest, conifer, scrub,
  rock, snow, village, road`). Four extra `heightAt` calls (slope); fine for a 4 Hz minimap, not per vertex.

## 5. Chunks (renderer)

```ts
buildChunk(world, { cx, cz, lod: 0 | 1 | 2, objects?: boolean }): ChunkData
```

- 128 m chunks (`CHUNK_SIZE`), origin `(cx·128, cz·128)`. LOD0 64 × 64 quads (2 m), LOD1 32 × 32 (4 m), LOD2
  16 × 16 (8 m) (`LOD_QUADS`, `LOD_STEP`). Coinciding vertices of different LODs and of neighbouring chunks have
  identical heights (tested); 6 m skirts (`SKIRT_DEPTH`) hide the remaining T-junction cracks.
- **Coordinates**: x and z in every array are relative to the chunk origin (`originX`, `originZ`); y is absolute.
  Place the mesh at `(originX − worldOrigin.x, 0, originZ − worldOrigin.z)` for the floating origin (07 §1.7).
- **Terrain mesh**: `positions` Float32 xyz, `normals` Int8 xyz (divide by 127), `colors` Uint8 RGB (baked from
  biome, slope, snow, moisture, farmland stripes, road verges), `gridSize = n + 1`. Vertex order: the `(n+1)²`
  grid row-major (row = z), then `4n` skirt vertices around the border. Indices are shared per LOD:
  `chunkIndices(lod)` (Uint16, counter-clockwise seen from above / outside). `minY` / `maxY` bound the chunk
  (skirts included) for culling.
- **`water`**: `{ positions, indices }` — quads over every terrain quad with a wet corner, at the water surface.
- **`roads`**: `{ positions, colors, indices }` — 6 m ribbons 0.06 m above the ground (`ROAD_LIFT`), three
  vertices across, dashed centre line in the colours; bridged spans are left out (they are `bridges`).
- **Instances** (Float32, chunk-local x / z, absolute y). Each object belongs to the chunk holding its anchor, so
  nothing is duplicated across chunks:

| Array | Stride | Fields |
|---|---|---|
| `trees` | `TREE_STRIDE = 6` | x, y, z, scale, yaw, species (0 conifer, 1 broadleaf, 2 scrub; `TREE_SPECIES`) |
| `rocks` | `ROCK_STRIDE = 5` | x, y, z, scale, yaw |
| `houses` | `HOUSE_STRIDE = 10` | x, y, z, w, wallHeight, d, yaw, archetype (`HOUSE_ARCHETYPES`: cottage, farmhouse, barn, tower), colour (0xRRGGBB), roofHeight |
| `bridges` | `BRIDGE_STRIDE = 6` | x, y (deck top), z, length, width, yaw (deck along local Z) |
| `colliders` | `COLLIDER_STRIDE = 9` | shape (`SHAPE`: 1 cylinder, 2 box), object (`OBJECT_KIND`: 1 tree, 2 house, 3 rock, 4 bridge), cx, cy, cz, a, b, c, yaw — cylinder a = radius, b = half height; box a, b, c = half extents |

  Yaw is `Object3D.rotation.y`. A house's door side is local +Z and faces the village centre. Tree sizes for the
  meshes and colliders: `TREE_DIMENSIONS[species]` × scale (`height`, `trunkRadius`, `crownRadius`, `crownBase`
  fraction). Rock collider half extents: `ROCK_HALF` × scale.
- `objects: false` skips the scatter (far LOD2 rings that only need ground).
- Cost (Node 22, Apple M4, fresh world per build, best of 3): LOD0 median 6.6 ms / p95 8.5 ms (Infinite),
  11.7 / 15.4 ms (Alpine); LOD1 ≈ 3 ms; LOD2 ≈ 2 ms. Budget 40 ms (test). Under a full parallel test run the p95 rises
  to ≈ 25 ms.

### Rendering a chunk (`src/render/outdoor/terrain-view.ts`, docs/10 §11)

- Chunk meshes, the batched LOD2 rings and the far backdrop draw with the material library's terrain
  (`library.terrain`, docs/10 §5): the `colors` palette (sRGB bytes, linearised in the shader) over the grass
  set as detail, world-space UVs.
- `surface` reaches the GPU as two normalised byte attributes over one interleaved buffer with the same
  layout (`addSurfaceAttributes`): `aRock` (`SURFACE_ROCK`) → triplanar rock, `aWet` (`SURFACE_BANK`) → darker,
  glossier banks with soil detail. v1 chunks (empty `surface`) read 0; rock still shows on slopes past ~25°.
- `water`: drawn with the shared water material; every water vertex sits on a grid point, so its depth over
  the chunk's own ground gives the shore foam (`shoreFoam`: 1 where the bank rises over the surface, 0 by
  ~1.1 m of depth) as the `aShore` attribute. Water and road ribbons carry straight-up normals.

## 6. Building chunks off the main thread

```ts
const builder = createChunkBuilder();            // WorkerChunkBuilder, or InlineChunkBuilder without Worker
const chunk = await builder.build(world.spec, { cx, cz, lod }, priority);   // lower priority runs first
builder.cancel((spec, req) => far(req));          // queued jobs reject with ChunkCancelledError
builder.dispose();
```

- `WorkerChunkBuilder`: 1 module worker, 2 when `hardwareConcurrency ≥ 6`, created with
  `new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' })`; results arrive as transferred
  typed arrays (`chunkBuffers`). If a worker cannot be constructed or errors (WKWebView, `capacitor://`), every
  queued and running job moves to an `InlineChunkBuilder` for good (`builder.kind` becomes `'inline'`).
- `InlineChunkBuilder`: the same `buildChunkSteps` generator on the calling thread, one grid row per step,
  `sliceMs` (default 3) per slice; pass `schedule: requestAnimationFrame` to slice per frame.
- Both paths are byte-identical (`chunkDigest`), in Node and in the browsers (tests).
- Integration (WP-K): the service-worker precache must include the emitted worker chunk.

## 7. Physics (WP-B)

- Terrain: call `world.field.heightAt` directly; it is always available, even before any chunk is built.
- Objects: `chunkColliders(chunk)` turns a chunk's packed colliders into `Collider[]` in absolute coordinates with
  ids `tree:<cx>,<cz>:<i>` / `house:…` / `rock:…` / `bridge:…`, ready for `ColliderGrid.insertOwned(chunkKey, …)`.
  Colliders are LOD-independent: take them from whichever LOD of the chunk arrives first.
- `routes.worldObstacles(world)` gives an obstacle query `(x, z, range) → ColliderShape[]` built the same way
  (memoised per chunk), for code that needs objects without the streamer.

## 8. Levels (WP-I)

- **Alpine Valley**: `createWorld({ seed, preset: 'alpine', genVersion: 1 })` with a fixed seed;
  `routeFromWaypoints(world.field, ALPINE_ROUTE, 3, { count: ALPINE_RING_COUNT, radius: ALPINE_RING_RADIUS,
  obstacles: worldObstacles(world), maxAgl: 60 })` gives 16 rings (≈ 3.4 km of ring-to-ring path): valley floor,
  forest, around the lake, saddle, ridge, back to the mouth. Rings sit ≥ 3 m above ground and water under the
  whole ring and ≥ 3 m from every tree / rock / house / bridge (tested for several seeds). Spawn / lookout near
  `ALPINE_MOUTH`; bounds `±ALPINE_HALF`.
- **Infinite**: `spawnFromSeed(world)` → `{ position, yaw, village }`: the edge of the nearest village within
  600 m of the origin, facing it, else a 32 m square spiral to the first dry spot with slope < 0.08; always clear of
  roads, water and objects; y = ground + 0.06.
- **City**: `generateCity(seed)` → `City`:
  - `buildings` (`BUILDING_STRIDE = 8`: x, y base, z, w, h, d, seed (24 bit), kind 0 building / 1 slab),
    axis-aligned, 15 × 15 blocks of 80 m (64 m + 16 m street) on ±600 m; block classes downtown 80–180 m,
    midrise 25–60 m, low 8–20 m; 1–4 buildings per block with 2 m setbacks; ≈ 500 buildings.
  - `roofProps` (`ROOF_PROP_STRIDE = 7`: kind 0 AC / 1 tank / 2 antenna, x, y base, z, sx, sy, sz),
    `skybridges` (x, y, z centre, w, h, d), the pass-through slab on four stilts (block 4, 9), a park block with
    trees in the scatter layout (absolute coordinates), the river channel in block column 14.
  - `colliders: Collider[]` (≈ 1 700 boxes / cylinders), `pilot` (on a low roof at the south edge),
    `spawn` (street, facing east), `rings` (18: street-canyon slalom at 15–25 m, rooftop hop, street dive,
    under / over the skybridges; ≈ 2.7 km; every ring ≥ 3 m from colliders and ground, tested over 25 seeds).
  - `cityTerrainField(city, genVersion)`: flat y = 0 with the river channel (bed −4 m, water −0.8 m).
  - `cityObstacles(city, x, z, range)` for the camera rig / ring checks.

- **Time of day**: `EnvDef.time` names the sky preset a level was built with (`outdoorEnv`): City `dusk`,
  Alpine `alpine` (golden hour in thin air), Infinite `afternoon` (day — the per-seed `timeFromSeed` is kept
  for tools but no longer picks the sky). Settings → Time of day overrides it (`levelTime(env, setting)`;
  golden hour on Alpine stays its own variant); the view swaps sky, sun, fog, water and look at runtime.
  `SkyDef.haze` is the fog / aerial colour where it differs from the horizon (dusk).
- `worldField(runtime)` returns the world engine field behind a generated level (Alpine / Infinite: the
  world's; City: `cityTerrainField`) for water, biome and minimap queries; null for authored levels.

## 9. Seeds, codes and saves (WP-G / WP-J)

- **Code**: 8 Crockford base32 characters shown as `XXXX-XXXX`, 40 bits = **3-bit generator version + 32-bit seed
  + 5-bit check symbol** (Σ (2i + 1) · symbolᵢ mod 32). 07 §2.6 sketched 4 + 32 + 4, but a 4-bit checksum cannot
  catch every single-character edit (one character carries 5 bits, so 32 values would share 16 checksums); an odd
  weight times a non-zero difference below 32 is never ≡ 0 mod 32, so every single edit is caught (tested).
  Versions 1–7.
- `decodeSeed(text, supported)` accepts lowercase, spaces, no dash and the Crockford aliases O → 0, I / L → 1, and
  returns `{ ok: false, error: 'length' | 'alphabet' | 'checksum' | 'version' }` otherwise.
- `parseSeedInput(text)` for the "Enter seed or code" field: a dashed code must be valid (`invalid-code` with the
  reason — typos are never silently hashed); an undashed 8-character string is a code only when its checksum
  matches; digits up to 2³²−1 are the seed; anything else is FNV-1a (`fnv1a32`) of the UTF-8 text.
- **Saved worlds** (`src/game/worlds.ts`, storage injected): `loadWorlds(storage)` (corrupt JSON / entries → empty
  or filtered, never a throw), `saveWorlds`, `recordPlayed(store, seed, gen, now)` (adds "World K7Q2", touches
  `lastPlayed`, keeps the 50 most recently played), `renameWorld` (trimmed, ≤ 24 chars, empty rejected),
  `deleteWorld`, `worldsByRecent`, `lastPlayedWorld`. Entry id = the code.

**In the game** (`src/main.ts`):

- Level cards: Infinite is `kind: 'seeded'` (Free Fly + Worlds…) with the last world flown as its note.
  A `level` action carries `seed` / `gen`; `startLevel(id, { seed, gen })` then `newSession(mode)`.
- `?world=CODE` at boot (and a Capacitor `appUrlOpen` URL): `parseWorldParam` → `playWorld` (recorded as
  played), `history.replaceState` without the parameter, Infinite free fly; a code that does not decode only
  toasts ("That world link is not valid — check the code" / "…needs a newer version"). A reload returns to the
  last level and world, so the ground is the same.
- VR card: Y cycles the levels; arriving on Infinite resumes the last world (`resumeOrNewWorld`).
- HUD: outdoor levels get `HudFrame.outdoor` (AGL, the LOS pilot's spot, the next ring while racing) and a
  minimap sampler per level (`terrainMinimapSampler(worldField(rt), bounds)`, City blocks drawn as buildings);
  the XR cards get the world code, AGL / pilot distance and the units.

## 9b. Generator v2 (`GEN_VERSION = 2`)

New worlds are v2; v1 stays byte-identical (golden fixture) for saved seeds. Relief, rivers, lakes, villages and roads
are the same; v2 branches on `genVersion` in the shared modules (`generators/v2.ts`, `scatter-v2.ts`,
`chunk-gen-v2.ts`, `settlements.villageLayoutV2`, `terrain-field`):

- Forests thin out up to slope 1.2 (`FOREST_MAX_SLOPE_V2`), conifers past 0.9; boulders on slopes over 0.9.
- Species: conifer 0, broadleaf 1, scrub 2, birch 3 (`TREE_DIMENSIONS[3]`), clustered by the clump noise into
  forest cores, mixed edges (birch, shrubs) and lone meadow trees.
- Villages have no plateau: the ground is smoothed towards the low-pass height over a noise-warped falloff of at least
  `VILLAGE_FALLOFF_V2` m, houses stand on the lowest corner of their footprint, the blend ring keeps the surrounding
  biome (trees reach into its outer part, `VILLAGE_TREES_V2`); Voronoi garden parcels (`GARDEN_CELL`) with hedges along
  some edges and tree clusters; houses within `ROAD_FACING_V2` of a road face it; the packed archetype is
  `archetype + 4 · roof` (`houseArchetype`, `ROOF_COLOURS_V2`).
- Fields (`fields.ts`): irregular Voronoi parcels (`FIELD_CELL` ≈ 70 m) on farmland noise and along roads, crops with
  furrows, farm tracks on some edges; trees only along field edges (hedgerows). Ground colour varies in dry / lush /
  dark patches at 350 m and 90 m.
- Water: one quad of dilation under the banks, dipping below dry ground (smooth shoreline at every LOD).
- `ChunkData.surface`: `SURFACE_STRIDE` bytes per vertex, rock and bank weights 0..255 (empty for v1).
- Codes carry the version; `decodeSeed` / `parseSeedInput` accept every shipped version by default, and
  `buildLevel(id, seed, genVersion)` replays a saved world with its own generator.

## 10. Known limits and deviations from 07

- Rivers are zero contours of a low-frequency noise, not a drainage network: they can form loops and end where they
  fade out uphill. Lakes are flat at 6 m.
- Villages: about one per 0.5 km² in the lowlands (70 % of 512 m cells pass the hash, then the flatness / water
  tests). Houses on 2–3 rings; spots on roads are skipped, so a village has 3–30 houses.
- The terrain mesh uses the physics `heightAt` at every LOD (no extra visual-only octaves at LOD0), so what the
  pilot sees is what the drone hits.
- City: ≈ 500 buildings and ≈ 1 700 colliders (07 estimated ≈ 700 / 2 500); the route is ≈ 2.7 km (07: ≈ 3 km).
- Code layout 3 + 32 + 5 bits instead of 4 + 32 + 4 (§9).
- The Alpine lake's shore levee is redundant for the v1 geometry (the bowl already rises above the water at the
  shore); it is kept as a guard, and a mutation test reports it as an equivalent mutant.
