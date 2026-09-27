# Drone Sim — Handover

Version 0.1.0 · 2026-09-26 · ~9.9k lines TypeScript

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (game)
                     # /render-preview.html   renderer alone, scripted drone
                     # /ui-preview.html?screen=main|hud|settings|controls|pause|finish
npm run build && npm run preview   # production build on :4173
npm test             # unit tests (Vitest)
npm run test:e2e     # E2E: chromium (desktop, real GPU) + webkit-iphone + webkit-ipad projects
                     # first time: npx playwright install webkit
```

Plug in an Xbox controller (USB/Bluetooth) and press any button — the browser only exposes
gamepads after an input. Chrome/Edge recommended (rumble supported there).

## How to fly

1. Main menu → **Race** (or **Free Fly**).
2. Pull the **left stick fully down** (throttle 0) → press **A** to arm. A real FC refuses to
   arm with throttle up or when tilted > 60°, and so does this one.
3. Left stick up/down = throttle (centre ≈ hover in Angle mode), left X = yaw,
   right stick = pitch/roll. **Y** Acro/Angle, **RB** camera LOS (default) → FPV → Chase, **B** reset to checkpoint,
   **Start** pause. Keyboard: W/S throttle, A/D yaw, arrows pitch/roll, Space arm, M, C, R, Esc.
4. Fly through the rings in order (cyan = next, magenta = the one after). Impact > 5 m/s = crash
   → respawn after the last ring (clock keeps running, like a real race).

Stick mode 1–4, square gate, per-channel reverse, axis remap and a live channel monitor are in
Settings → **Controller setup** (check it first with a new controller).

Sensitivity: Settings → **Rates & sensitivity** — preset or custom Betaflight Actual rates per axis
(center °/s, max °/s, expo) with live curve, throttle mid/expo/limit, Angle-mode max tilt, deadzone.

Touch (iPhone/iPad) default: sticks spring back to centre; throttle stick = climb rate with
altitude hold (centre holds height, DJI-style). Tap ARM with thumbs off, push the throttle stick
up to take off. Settings → Touch throttle → Hold for a manual FPV throttle.

Tip: an Xbox left stick springs back to centre (≈ 50 % throttle). Settings → Throttle source →
**Right trigger** gives a throttle that rests at zero.

## iPhone / iPad (touch)

Spec: [04-mobile-design.md](04-mobile-design.md). Same URL; touch devices get the touch UI automatically.

- **Start:** "Tap to play full screen" — the tap unlocks audio and requests fullscreen.
  - **iPad** (Safari): element Fullscreen API works → real full screen. Settings → **Full screen** toggles it.
  - **iPhone** (Safari tab): no element fullscreen → one-time sheet *Share → Add to Home Screen*
    (dismissal remembered). Launched from the Home Screen the app runs full screen (manifest
    `display: fullscreen`, `apple-mobile-web-app-capable`), landscape, notch-safe.
- **Sticks:** thumb anywhere on the left/right half spawns that stick under it (Settings → Touch sticks:
  Floating / Fixed). Follows stick mode 1–4. The throttle stick (magenta, rail) **holds** where released like
  a real gimbal; Settings → Touch throttle → Auto-centre springs it to hover instead.
- **Buttons:** top-left ⏸ pause, CAM; top-right RESET, MODE (Angle/Acro), ARM/DISARM. Arm = pull the
  throttle stick fully down, tap ARM.
- Touch UI shows only while touch is the last-used input and a flight is running; a gamepad or keyboard
  takes over the moment it is used (HUD stick visualiser returns).
- **Phones in portrait:** "Rotate your device" overlay, flight paused → rotate back → pause menu.
- **Performance:** phone → Medium tier, DPR ≤ 1.5; iPad → High, DPR ≤ 1.75; shadow maps / canvas
  textures ≤ 1024, particle pools halved; dynamic resolution targets 60 fps.
- **`?selftest=1`**: scripted on-device flight through the real touch path (arm → 1.5 m → forward →
  land → disarm) with a PASS/FAIL panel (fps, tier, DPR, render scale, viewport, fullscreen support).
  `&rotate=0` lets it run in portrait (simulators that cannot be rotated).
- Icons: `node scripts/make-icons.mjs` regenerates `public/icons/*` (SVG → PNG via Playwright).

### Verified

| Where | Result |
|---|---|
| Playwright WebKit `iPhone 15 Pro landscape` / `iPad Pro 11 landscape` | mobile spec 8/8 each: touch UI, two-thumb arm + climb + forward, mode 1 right-thumb throttle, all buttons by tap, portrait overlay (phone), menus by tap with ≥ 44 px steppers, no overlap of buttons/HUD, selftest PASS, ≈ 60 fps |
| iOS Simulator iPhone 17 Pro (iOS 26.5 Mobile Safari) | selftest **PASS**, 60.0 fps, medium · DPR 1.50 · scale 1.00, fullscreen unsupported → A2HS sheet |
| iOS Simulator iPad Pro 13" M5 | selftest **PASS**, 56.8 fps, high · DPR 1.49 (1.75 × dyn-res 0.85), fullscreen supported |

Simulator fps runs on the Mac GPU and is not a device benchmark. The simulator could not be rotated
from the command line (no Simulator.app GUI in this Xcode, `simctl` has no orientation command), so
simulator screenshots are portrait (`docs/screenshots/ios-*.png`); landscape layout is shown by the
WebKit captures (`docs/screenshots/webkit-*.png`).

### UAT checklist — iPhone

- [ ] Open the Pages URL in Safari → "Tap to play full screen" → the Add to Home Screen sheet appears once; "Got it" never shows it again.
- [ ] Share → Add to Home Screen: icon + name "Drone Sim"; launched from the Home Screen it has no Safari bars, content clear of the notch/Dynamic Island and home indicator.
- [ ] Portrait shows "Rotate your device" and pauses; landscape → pause menu → Resume.
- [ ] Sound starts after the first tap; silent switch mutes it (expected).
- [ ] Free Fly: pull left stick down, tap ARM → armed; throttle holds when the thumb lifts; right stick pitches/rolls and re-centres.
- [ ] Both thumbs at once + tapping a button with a third finger works; no page zoom, scroll, bounce or text-selection callout.
- [ ] MODE, CAM, RESET, pause buttons respond instantly; HUD never covers them.
- [ ] Settings/Rates dialogs scroll with momentum; every stepper works by tap and press-and-hold.
- [ ] 5-minute flight: steady 60 fps, no thermal stutter (HUD fps chip).
- [ ] `?selftest=1` shows PASS.

### UAT checklist — iPad

- [ ] "Tap to play full screen" enters real full screen; Settings → Full screen toggles it.
- [ ] Sticks larger (72 pt); both orientations usable; no rotate overlay.
- [ ] Bluetooth Xbox controller: using it hides the touch UI; touching the screen brings it back.
- [ ] Hardware keyboard (Magic Keyboard): keys take over the same way.
- [ ] `?selftest=1` shows PASS; fps ≈ 60.

## What was delivered

| Area | Result |
|---|---|
| Physics | 6-DOF rigid body at 1 kHz fixed step; motor lag (τ 25/40 ms), thrust ∝ rpm², reaction yaw torque, quadratic body drag, rotor H-drag, ground effect (Cheeseman–Bennett), battery sag. T/W 4.5, top speed 15.7 m/s at 55° tilt. |
| Flight controller | Betaflight-style: gyro noise + LPF, rate PID (D on measurement, I relax/anti-windup), Angle mode (55° max), Actual rates, quad-X mixer with airmode, arming safety. Step response ~40 ms, overshoot < 1 %. |
| Collision | Compound sphere drone vs box/yawed box/cylinder/torus (ring rims)/room shell/rotating fan blades; impulse with restitution + friction at contact point (prop strikes flip the quad). No energy gain (tested). |
| Game | 12-ring race in a 24×6×14 m night loft, countdown, splits vs best, best time saved, crash/respawn, free-fly. |
| Graphics | Procedural PBR loft (brick, concrete, wood, steel windows, city skyline), PMREM reflections, shadowed moonlight + spots, bloom/SMAA/vignette/ACES, emissive animated rings, particle VFX (dust, ring burst + shockwave, sparks, prop wash, respawn shimmer), procedural cinewhoop model with spinning props + blur discs + RGB LEDs. |
| Input | Xbox (standard mapping, rumble), keyboard fallback, gamepad-navigable menus, touch virtual sticks + buttons (iPhone/iPad). |
| Audio | Synthesised motor whine per motor, prop wash, wind, ring chime, crash, countdown, fanfare. |
| GPU / fallback | WebGL2 hardware path; GPU probe picks tier; software rasteriser detected → Low tier (no post/shadows, DPR 0.75); dynamic resolution keeps frame rate on Auto; clear error screen if no WebGL2. |

### Measured performance (Apple M4, 1920×1080, vsync off, in flight)

| Tier | FPS | Draw calls | Triangles |
|---|---|---|---|
| Ultra | 163 | 66 | 47k |
| High | 160 | 62 | 40k |
| Medium | 229 | 56 | 40k |
| Low | 412 | 42 | 39k |

Physics ≈ 3 µs/step (≈ 0.05 ms per 60 Hz frame).

## Quality gates (all green)

- `tsc --noEmit` strict: 0 errors · `vite build`: OK
- Unit 128/128: physical truths (hover equilibrium, free fall, analytic terminal velocity,
  torque signs, energy/angular-momentum conservation, bounce ≈ e²·h, floor rest < 1 mm,
  ground effect, battery), FC (rate step response, self-level, recovery from inverted,
  determinism bit-exact), collision per shape, race rules, input mapping, settings, fixed loop.
- E2E 8/8 on real GPU: boot without console errors, frame rate, arm → take-off → land,
  arming refused with throttle up, race countdown → pass ring 0 → crash → respawn,
  camera cycling, armed-state sync on quit, manual reset.
- Independent code review: 3 integration bugs + 2 hot-path allocations found and fixed
  (pause kept motor audio playing, stale ARMED indicator after quit/finish, re-entrant
  loop reset dropping physics steps on respawn).

## Manual UAT checklist (needs a person + controller)

- [ ] Xbox controller detected (toast), sticks move the HUD stick visualiser correctly.
- [ ] Arm only works with throttle at bottom; motors idle audibly after arming.
- [ ] Angle mode: centre stick ≈ hover; release pitch/roll → quad levels itself.
- [ ] Acro mode: attitude holds when sticks centred; flips/rolls feel crisp.
- [ ] Rumble on ring pass / crash (Chrome/Edge).
- [ ] Full race lap, finish screen, best time persists after reload.
- [ ] Settings (FOV, camera tilt, rates, quality) apply live and persist.
- [ ] 120 Hz display: HUD FPS shows ≈ 120.

## Known limitations / next steps

- Not yet tested with a physical Xbox controller or by ear (audio) — only simulated inputs.
- Aero not modelled: axial-inflow thrust loss, blade flapping, propwash turbulence when
  descending through own wake.
- Drone casts a blob shadow (not a real shadow map); pillars can occlude the chase camera.
- One level. Level data format (`src/game/level-data.ts`) is ready for more tracks.
- WebGPU renderer (three `WebGPURenderer`) could replace WebGL2 later; architecture isolates it
  behind `GameView`.

## Map of the code

```
src/main.ts               orchestration: input → fixed step (FC+physics+race) → render/HUD/audio
src/core/                 loop (fixed timestep), quality tiers + dyn-res, settings
src/physics/              drone params, rigid body world, collision, simulation wrapper
src/control/              rates, PID, filters, mixer, flight controller
src/game/                 level data (single source of truth), race rules
src/render/               GameView facade, room/props/drone/rings, lights, post, camera rig, vfx/
src/input/ audio/ ui/     gamepad+keyboard+touch, WebAudio synth, DOM HUD/menus/touch controls
src/core/device.ts        touch/phone/tablet/iOS/standalone detection, Fullscreen API helpers
src/ui/selftest.ts        ?selftest=1 on-device scripted touch flight
docs/                     01-design, 02-implementation-plan, 03-handover, screenshots/
```
