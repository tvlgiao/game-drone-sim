# 10 — Render pipeline (tone, light, shadows, post, materials)

What every level, the drone and the VFX sit on. Owner files: `src/render/post.ts`, `src/render/effects/**`,
`src/render/looks.ts`, `src/render/ibl.ts`, `src/render/shadows.ts`, `src/render/lights.ts`,
`src/render/outdoor/sky.ts`, `src/render/materials/**`, the renderer set-up in `src/render/game-view.ts`,
and the tier knobs in `src/core/quality.ts`.

## 1. Frame, end to end

```
scene (linear HDR, physically based lights, captured IBL)
 └ RenderPass (HalfFloat)
   └ N8AO .............. high/ultra, half resolution, depth-aware upsample (lazy chunk)
   └ DoF ............... only on still frames behind menus (bokeh, focus on the quad)
   └ motion blur ....... high/ultra, FPV at speed (camera reprojection, 1/60 s shutter)
   └ main EffectPass ... SMAA (medium+) · aerial haze (outdoor) · bloom · exposure · tone map
   │                     · grade · analog FPV feed · vignette · grain (high/ultra) · dithering
   └ chromatic aberr. .. high/ultra, FPV at speed
```

- **No post (low tier, VR)**: the renderer tone-maps itself with the level's tone mapper and exposure, so
  the look survives without the stack. VR on Quest 2 runs `low`: MSAA (`antialias: true` on Quest),
  fixed foveation (`core/xr.ts`), no EffectComposer, no shadow maps, no texture-set downloads.
- **Colour**: textures with colour data are `SRGBColorSpace`; normal / ARM maps `NoColorSpace`;
  `renderer.outputColorSpace = SRGBColorSpace`. Dithering in the last pass removes banding in the dark loft
  gradients and the sky.
- **Analog FPV feed** (`vfx/analog-video.ts`): scanlines, per-frame noise, rolling sync bar, softer chroma,
  in the main pass after the grade (no extra pass). Intensity = FPV camera weight × the player's setting
  (Settings → Analog FPV feed, default on at 35 %); 0 on still menu frames; never on low / VR (no post).
- **Exposure** is an effect after bloom (bloom thresholds stay in scene units) and before the tone curve;
  on the post path `renderer.toneMappingExposure` stays 1.

## 2. Looks (`src/render/looks.ts`)

One `LevelLook` per level (fallback by indoor / outdoor): tone mapper, exposure, grade (lift / gamma /
gain, contrast, saturation, split-tone tints), bloom, AO radius / strength, vignette, grain, aerial haze,
and how much of the level's hemisphere light to keep when the captured environment already lights it.

| level | tone mapper | why |
| --- | --- | --- |
| Night Loft | ACES Filmic | deepest blacks and the most saturated neon / ring emissives of the three; AgX read flat and pastel at night even with a punchy grade, Neutral too clean for a moody interior |
| Training | Khronos PBR Neutral | daylight albedos (grass, cones, pad paint) stay true; ACES pushed the sky cyan-white and the grass yellow, AgX greyed both |

Bloom: the look's threshold is a floor under the level view's `bloomThreshold`. Outdoors it is 4 (scene
units): the sun's Mie halo peaks around 3, and a lower threshold turned the halo into a hard-edged
lavender disc.

Look test: `render-preview.html?level=training&cam=chase&tm=agx|aces|neutral`.

## 3. Light

- **Units**: three's physically based model (r155+): directional / hemisphere intensities are
  irradiance-like (lux-ish; a white Lambert surface facing a 7-unit sun reads 7/π), point and spot lights
  are candela with inverse-square decay (`decay = 2`), emissive is radiance.
- **Sky** (`outdoor/sky.ts`): three's Preetham model with its analytic clouds, scaled by `SKY_SCALE`
  so the zenith sits at ~⅓ of a sunlit white surface (clear-sky ratio), sun disc capped at 60 so it blooms
  without ringing the frame, lit ground below the horizon. `SkyDome` (visible) and `skyEnvironment()`
  (stand-in PMREM) share the shader.
- **IBL** (`ibl.ts`, `GameView.applyEnvironment`) — one mechanism for every level. Each level view
  declares a `probe` (position, near / far, min face size, `always`); the GameView captures the lit level
  from there once and uses the capture twice:
  - **PMREM** → `scene.environment` on tiers with `envMap`. A level whose own materials box-project it gets
    it through `LevelView.setEnvironment` on every tier (`always`): the loft's floor and windows, whose
    box projection origin *is* the probe point (0, 2.2, 0). Shaders compile once against a blank stand-in
    of the same size during the capture.
  - **SH `LightProbe`** (L2, from a 16² HDR cube) → the diffuse ambient on tiers without `envMap` (low,
    VR). It is taken under the high tier's light rig (all spots / practicals on, no shadow maps), so a tier
    that drops lights keeps the full rig's colour in its ambient.
  - Wherever either one lights the level, its hemisphere light drops to the look's `hemiWithIbl` (loft
    0.55, training 0.5): the capture already holds that ambient. No tier gets both PMREM and SH.
  - Drone, particles, rings, markers and VR furniture are hidden for the captures. The level view's own
    `environment` (analytic sky / hand-built dark loft) is only the fallback if a capture throws.
- **Loft without shadow maps** (low, VR): the moon is off (unshadowed it washed every wall facing it in
  cold blue); the window pools draw its light on the floor, the wall-washer spot stays on, and the SH probe
  carries the warm room ambient — low reads like ultra's room.

## 4. Shadows

| tier | sun (outdoor) | loft |
| --- | --- | --- |
| ultra / high | `SunLight`, 2 cascades in one atlas (2 × 2048² on desktop), fitted to the view frustum to 150 m, bounding-sphere fit + texel snapping (no shimmer), 10 % fade band between cascades; near cascade ≈ 3–5 cm texels → crisp contact under cones and the quad, far cascade softer (a contact-hardening feel by distance) | moon: static map 4096 / 2048 + 2 / 1 shadowed spots |
| medium | the level's single static map | static moon map, no spots |
| low / VR | none — contact blob (`vfx/contact-shadow.ts`) | same |

`shadows.ts` swaps the level's `DirectionalLight` (named `sun`, else the first) for the cascaded light and
restores it on a lower tier or a level switch. Level views keep authoring a plain directional sun.

## 5. Material system (`src/render/materials/`)

One system for every lit surface: the **library** (`library.ts`), its **texture sets** (procedural or CC0)
and its **shader patches** (`patches.ts`). Level art that is not a reusable surface (decal and neon atlases,
the rug, leather, the merged prop material) still goes through the library (`custom` / `texture`) so it
shares the cache and the lifetime rules. Unlit effect shaders (sky dome, city backdrop, halos, shafts, TV,
rings, VFX) stay with their effect.

```ts
const lib = view.library;                                   // one per GameView, disposed with it
const level = lib.scope('night-loft');                      // per-level owner: level.dispose() frees its share
const floor = level.material('slab', { uvMeters: 4, albedo: 0x67635e, patch: { box, macro } });
const wall  = level.material('paintedBrick', { uvMeters: 1.2, color: 0xd9d2c8, patch: { grime } });
const bark  = level.material('bark', { vertexColors: true, albedo: 0x8a7a6a, patch: { wind } });
const art   = level.texture('loft:floor-macro', () => floorMacro(...));     // cached one-off texture
const props = level.custom('loft:props', () => applyEnvPatch(new THREE.MeshStandardMaterial(...), { vertexRM: true }));
const pane  = lib.material('glass');                        // transmission on high tiers, reflective coat elsewhere
await lib.preload('training');                              // GameView does this on every level load
```

- **Presets**: `carbonFibre`, `brushedMetal`, `paintedMetal`, `rubber`, `concrete`, `slab` (concrete with
  saw-cut joints), `brick`, `paintedBrick` (brick + `paint`), `wood`, `plaster`, `asphalt`, `grass`,
  `gravel`, `bark`, `rock`, `foliage` (leaf-cluster card), `needles` (conifer spray card), `glass`.
- **Options**: `color` (tint), `albedo` (authored mean colour: the map is divided by its own mean — the
  smallest mip — and tinted to this, so a darker or warmer scan does not change the level's palette),
  `uvMeters` / `repeat`, `roughness` (multiplier), `metalness`, `envMapIntensity`, `normalScale`,
  `vertexColors`, `side`, `polygonOffset`, `patch`.
- **Cache**: preset + options + patch (by object identity) → one material. Build a patch object once per
  level and pass the same object. Texture sets are made once per kind; different repeats are clones that
  share one `Source` (one upload).
- **Lifetime**: `lib.scope(name)` — a level view's materials, customs and textures; `scope.dispose()`
  disposes what no other owner holds, and texture sets nothing uses leave the GPU (CPU copy kept for a
  quick re-upload). Things asked of `lib` directly live as long as the library.
- **Sets**: procedural first, generated at `profile.textureSize` (brick and slab never below 512 on a real
  tier) — per-texel samplers in `procedural.ts` (`noise.ts`), whole-field generators in `generators.ts`
  (`texgen.ts`; brick, slab, concrete, wood, gravel and the loft's single-purpose maps). On tiers with
  `pbrTextures` the presets with a CC0 scan swap their maps in place when the WebP files arrive, at the
  scan's real-world tile size. Patches sit on top of whichever set is bound, so the swap keeps the look.

### Shader patches (`EnvPatch`)

| feature | what | used by |
| --- | --- | --- |
| `box` | box-projected env reflections (room-sized probe) | loft floor, windows |
| `macro` | world-space floor map: stains, wax lanes, puddles | loft floor |
| `grime` | dirt rising off the floor, soot under the ceiling | loft walls, sills, columns |
| `paint` | limewash over the set, chipped by noise; mortar stays darker, bricks keep a ghost of their tone | `paintedBrick` |
| `detail` (true / 0..1) | albedo map → neutral luminance detail under vertex colours / `albedo` | meadow, field, `albedo` option |
| `overlay` | RGBA picture on a world XZ rectangle | landing-pad markings over asphalt |
| `stripes` | view-dependent mowing stripes | training field |
| `terrain` | triplanar rock by per-vertex weight (and slope), wet banks by another | `library.terrain()` |
| `vertexRM` | per-vertex roughness / metalness (`aRM`) | merged loft props |
| `glass` | premultiplied dirty glass (reflections stay, body fades) | loft windows |
| `wind` (+ flutter) | sway by `aSway` metres, world-space for instanced meshes | trees, bushes, flags |

Each feature is a define, so a combination is one program (`customProgramCacheKey` = the feature set).

### Terrain hook (for the outdoor worlds)

```ts
const ground = level.terrain({
  base: 'grass',              // base layer preset (grass | gravel | asphalt | concrete), CC0 where loaded
  uvMeters: 1,                // geometry UVs in metres
  rockAttribute: 'aRock',     // float 0..1 per vertex → triplanar rock (procedural `rock` set)
  wetAttribute: 'aWet',       // float 0..1 per vertex → darker, glossier, flatter (river / lake banks)
  slopeRock: 0.55,            // optional: rock also where 1 − normal.y > 0.55
  rockMeters: 3,              // rock tile size (m)
  vertexColors: true,         // default: the geometry's `color` is the palette, the base map only adds detail
});
```

Attributes that the geometry does not carry read as 0 (pass `null` to compile without them). The rock
layer samples three planar projections in world space, so cliffs do not stretch; normals flatten towards
the mesh normal under rock and water. Same options → same material.

## 6. Assets

| set (Poly Haven, CC0 1.0) | used by | size (3 × 1K WebP) |
| --- | --- | --- |
| concrete_floor_worn_001 | concrete | 0.17 MB |
| red_brick | brick | 0.51 MB |
| wood_floor | wood | 0.15 MB |
| painted_plaster_wall | plaster | 0.39 MB |
| asphalt_02 | asphalt | 1.03 MB |
| leafy_grass | grass | 1.07 MB |
| bark_brown_02 | bark | 0.76 MB |

Loft: `slab` (floor) and `concrete` (sills) → concrete_floor_worn_001, `brick` / `paintedBrick` → red_brick,
`plaster` → the columns, `wood` → deck, door, crates, shelves. Training: `grass` → meadow and field (as
detail), `asphalt` → landing pad, `bark` → tree trunks and branches.

Total 4.1 MB (budget 12 MB). Per level: loft 1.2 MB, training 2.9 MB (Quest budget 6 MB; the VR tier
loads none). Files live in `src/render/materials/cc0/` rather than `public/`: Vite emits them as hashed
assets, so the web build, the offline worker's precache and the native (Capacitor) build all carry them
without base-path logic. Re-fetch with `python3 scripts/fetch-cc0-textures.py`.
`tests/unit/asset-budget.test.ts` enforces the budgets, the manifest and the licence credits.

**Offline worker**: `build/offline-sw.ts` precaches every emitted file, so the 4.1 MB is downloaded at
install even by a player who only flies one level. Acceptable at this size; past ~10 MB the worker should
precache the core and cache texture sets on first use (runtime cache-first), since the procedural maps
already cover a cold offline start.

## 7. Tiers (`src/core/quality.ts`)

| knob | ultra | high | medium | low / VR |
| --- | --- | --- | --- | --- |
| post / SMAA | ✓ / High | ✓ / Medium | ✓ / Low | – (MSAA on Quest) |
| sun cascades | ✓ | ✓ | static map | blob |
| AO (N8AO, half res) | High (64 spp) | Medium (16 spp) | – | – |
| aerial haze / grain | ✓ / ✓ | ✓ / ✓ | ✓ / – | – |
| menu DoF / motion blur | ✓ / ✓ | ✓ / ✓ | ✓ / – | – |
| glass | transmission | transmission | reflective | reflective |
| CC0 sets / texture size / env size | ✓ / 1024 / 256 | ✓ / 1024 / 256 | ✓ / 512 / 128 | – / 256 / – |

Phones: no AO, no motion blur, reflective glass, ≤ 512 textures, ≤ 128 env. Tablets: AO at most Medium.

## 8. Tools

- `render-preview.html?level=…&cam=fpv|chase|los&tier=…&t=…&pause&tm=…&gallery` — `__preview.bench(n)`
  returns GPU-synced ms/frame.
- `node scripts/beauty-shots.mjs <dir> [port]` (needs `npx vite --port 5701`): both levels, every camera,
  every tier at 1920×1080 plus an iPhone frame, with ms/frame.

## 9. Cost (measured 2026-10-03)

GPU-synced ms/frame from `__preview.bench(120)`, 1920×1080 at DPR 1, chase camera, Apple-silicon Mac
under ANGLE/Metal (Playwright Chromium). Other GPU work was running on the machine, so treat ±1.5 ms as
noise.

| level | ultra | high | medium | low |
| --- | --- | --- | --- | --- |
| Night Loft before → after | 10.7 → 12.5 | 8.4 → 11.0 | 5.3 → 5.1 | 1.6 → 1.3 |
| Training before → after | 4.8 → 9.0 | 4.9 → 8.1 | 3.9 → 3.4 | 0.9 → 1.2 |

Most of the ultra / high delta is N8AO (half res: ~1.5 ms Medium, ~3.5 ms High at 720p) and, outdoors,
the two cascades re-rendered every frame. Full-resolution N8AO cost ~17 ms at 720p and was dropped.

**Quest 2 (72 Hz)**: VR runs `low`, which this work leaves at the pre-existing cost apart from the tone
mapper (one curve in the material shaders): emulated (IWER) Training draws 52 calls / 85 k triangles,
Night Loft 172 calls / 150 k per eye pass (before feat/visual; current numbers in §10). The emulator caps at the desktop's 60 Hz rAF and runs on a
desktop GPU, so it only proves the path is light (no composer, no shadow maps, no PMREM capture, no
texture downloads). 72 fps on a real headset is not measured here: the claim rests on the VR path's
budgets being unchanged from the previous release. Flat Quest Browser (Adreno → medium) loads at most the level's CC0 sets (≤ 2.9 MB).

## 10. Gates, trees, budgets (feat/visual)

**Gates** (`rings-view.ts`): next = electric cyan with a white-hot chase, the one after = hot magenta,
later = violet, passed = amber (white flash on the pass). The LED channel is multiplied by the look's
`ringGain` (loft 1, training 2.2) so gates out-shine a sunlit sky and treeline. All housings of one gate size
are one instanced draw; membranes and tags draw only where they say something; low / VR uses a coarser
housing and tags for the next two gates.

**Trees** (`outdoor/trees.ts`): oak, birch and pine archetypes grown once (10 m, 2.5 m crown) and instanced
per tree, scaled to its canopy collider. Ultra / high: flared trunk + branches (library `bark`) and leaf
cards / needle sprays (`foliage` / `needles`, alpha-tested, crown normals, wind with flutter). Medium / low /
VR: one opaque mesh per archetype (trunk + leaf masses or stacked cones). Archetypes stay inside the crown
cylinder above 24 % of the height and inside the trunk radius below it (unit-tested over every instance).

**Loft low / VR** hides the `props-detail` batch (rivets, bolts, duct seams, bulb cages).

### renderer.info per frame (2026-10-03, Apple-silicon Mac, ANGLE/Metal; ms = GPU-synced bench at 1920×1080)

| level · camera | ultra | high | medium | low | iPhone (medium) | Quest IWER (low, both eyes) |
| --- | --- | --- | --- | --- | --- | --- |
| Night Loft · LOS | 97 / 311 k · 12.8 ms | 97 / 311 k | 64 / 114 k | 38 / 55 k | 64 / 114 k | **72 / 110 k** |
| Night Loft · FPV | 79 / 309 k | 79 / 309 k | 46 / 111 k | 30 / 50 k | 46 / 111 k | 48 / 79 k |
| Night Loft · chase | 85 / 329 k | 85 / 329 k | 52 / 132 k | 33 / 54 k | 52 / 132 k | 60 / 89 k |
| Training · LOS | 73 / 988 k · 9.8 ms | 73 / 808 k | 38 / 259 k | 20 / 72 k | 39 / 260 k | **40 / 143 k** |
| Training · FPV | 68 / 977 k | 68 / 797 k | 35 / 259 k | 18 / 68 k | 35 / 259 k | 26 / 134 k |
| Training · chase | 76 / 1009 k | 76 / 829 k | 41 / 280 k | 21 / 72 k | 41 / 280 k | 38 / 143 k |

draws / triangles. Quest before this work: loft 140 draws / 228 k, training 52 / 221 k (same harness).
Training ultra / high triangles are mostly the grass tufts (30 k / 20 k instances). Measured with
`scratchpad` scripts equivalent to `scripts/beauty-shots.mjs` + `__drone.stats()` inside the IWER session.
