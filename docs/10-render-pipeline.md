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
   │                     · grade · vignette · grain (high/ultra) · dithering
   └ chromatic aberr. .. high/ultra, FPV at speed
```

- **No post (low tier, VR)**: the renderer tone-maps itself with the level's tone mapper and exposure, so
  the look survives without the stack. VR on Quest 2 runs `low`: MSAA (`antialias: true` on Quest),
  fixed foveation (`core/xr.ts`), no EffectComposer, no shadow maps, no texture-set downloads.
- **Colour**: textures with colour data are `SRGBColorSpace`; normal / ARM maps `NoColorSpace`;
  `renderer.outputColorSpace = SRGBColorSpace`. Dithering in the last pass removes banding in the dark loft
  gradients and the sky.
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
- **IBL** (`ibl.ts`, `GameView.environmentFor`): on tiers with `envMap` the level is captured once into a
  PMREM cube from the middle of the course (`envSize` 256 / 128) — the loft as lit by its practicals and
  moonlight, the meadow under the sky. Drone, particles, rings, markers and VR furniture are hidden for the
  capture. Outdoors the hemisphere light drops to `hemiWithIbl` (0.5) so sky light is not counted twice.
  The level view's own `environment` stays as the fallback (and is what low tier never uses).

## 4. Shadows

| tier | sun (outdoor) | loft |
| --- | --- | --- |
| ultra / high | `SunLight`, 2 cascades in one atlas (2 × 2048² on desktop), fitted to the view frustum to 150 m, bounding-sphere fit + texel snapping (no shimmer), 10 % fade band between cascades; near cascade ≈ 3–5 cm texels → crisp contact under cones and the quad, far cascade softer (a contact-hardening feel by distance) | moon: static map 4096 / 2048 + 2 / 1 shadowed spots |
| medium | the level's single static map | static moon map, no spots |
| low / VR | none — contact blob (`vfx/contact-shadow.ts`) | same |

`shadows.ts` swaps the level's `DirectionalLight` (named `sun`, else the first) for the cascaded light and
restores it on a lower tier or a level switch. Level views keep authoring a plain directional sun.

## 5. Materials library (`src/render/materials/`)

```ts
const lib = view.library;                                  // one per GameView, disposed with it
const floor = lib.material('concrete', { uvMeters: 1 });  // UVs in metres: repeat follows the real tile size
const brick = lib.material('brick', { uvMeters: 1, color: 0xf2e6dc });
const frame = lib.material('carbonFibre', { repeat: 4 });
const pane  = lib.material('glass');                       // transmission on high tiers, reflective coat elsewhere
const { albedo, normal, arm } = lib.textures('rubber');    // raw procedural maps (shared, do not dispose)
await lib.preload('night-loft');                           // GameView already does this on every level load
```

- Presets: `carbonFibre`, `brushedMetal` (anisotropic), `paintedMetal` (chipped), `rubber`, `concrete`,
  `brick`, `wood`, `plaster`, `asphalt`, `grass`, `bark`, `foliage` (alpha-tested leaf cards), `glass`.
- Options: `color` (tint), `uvMeters` or `repeat`, `roughness` (multiplier), `metalness`,
  `envMapIntensity`, `normalScale`.
- **Caching**: preset + options → one material; ask again, get the same instance. Treat it as read-only
  (`.clone()` to own one). Texture sets are generated once per preset; different repeats are clones that
  share one `Source`, so the GPU uploads each map once (`lib.stats().uploads`, unit-tested).
- **Maps**: albedo (sRGB), normal (OpenGL +Y), ARM packed like the CC0 sets (R AO, G roughness, B
  metalness) → `aoMap = roughnessMap = metalnessMap`. Procedural sets are pure TS (`procedural.ts`,
  tileable, deterministic) at `profile.textureSize` (1024 / 512 / 256; phones ≤ 512).
- **CC0 upgrade**: presets with a Poly Haven set (`assets.ts`) start procedural and swap to the scanned maps
  in place when the WebP files arrive (tiers with `pbrTextures`), keeping real-world scale via
  `tileMeters`. Offline without the files, the procedural maps simply stay. The stand-in's GPU copy is freed
  after the swap.

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
Night Loft 172 calls / 150 k per eye pass. The emulator caps at the desktop's 60 Hz rAF and runs on a
desktop GPU, so it only proves the path is light (no composer, no shadow maps, no PMREM capture, no
texture downloads). 72 fps on a real headset is not measured here: the claim rests on the VR path's
budgets being unchanged from the previous release. Flat Quest Browser (Adreno → medium) loads at most the level's CC0 sets (≤ 2.9 MB).
