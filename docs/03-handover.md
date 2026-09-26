# Drone Sim — Handover

Version 0.1.0 · 2026-09-26 · ~9.9k lines TypeScript

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (game)
                     # /render-preview.html   renderer alone, scripted drone
                     # /ui-preview.html?screen=main|hud|settings|controls|pause|finish
npm run build && npm run preview   # production build on :4173
npm test             # 128 unit tests (Vitest)
npm run test:e2e     # 8 E2E tests (Playwright, real GPU, fresh build)
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

Tip: an Xbox left stick springs back to centre (≈ 50 % throttle). Settings → Throttle source →
**Right trigger** gives a throttle that rests at zero.

## What was delivered

| Area | Result |
|---|---|
| Physics | 6-DOF rigid body at 1 kHz fixed step; motor lag (τ 25/40 ms), thrust ∝ rpm², reaction yaw torque, quadratic body drag, rotor H-drag, ground effect (Cheeseman–Bennett), battery sag. T/W 4.5, top speed 15.7 m/s at 55° tilt. |
| Flight controller | Betaflight-style: gyro noise + LPF, rate PID (D on measurement, I relax/anti-windup), Angle mode (55° max), Actual rates, quad-X mixer with airmode, arming safety. Step response ~40 ms, overshoot < 1 %. |
| Collision | Compound sphere drone vs box/yawed box/cylinder/torus (ring rims)/room shell/rotating fan blades; impulse with restitution + friction at contact point (prop strikes flip the quad). No energy gain (tested). |
| Game | 12-ring race in a 24×6×14 m night loft, countdown, splits vs best, best time saved, crash/respawn, free-fly. |
| Graphics | Procedural PBR loft (brick, concrete, wood, steel windows, city skyline), PMREM reflections, shadowed moonlight + spots, bloom/SMAA/vignette/ACES, emissive animated rings, particle VFX (dust, ring burst + shockwave, sparks, prop wash, respawn shimmer), procedural cinewhoop model with spinning props + blur discs + RGB LEDs. |
| Input | Xbox (standard mapping, rumble), keyboard fallback, gamepad-navigable menus. |
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
src/input/ audio/ ui/     gamepad+keyboard, WebAudio synth, DOM HUD/menus
docs/                     01-design, 02-implementation-plan, 03-handover, screenshots/
```
