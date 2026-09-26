# Drone Sim — Design Document (GDD + TDD)

Version 0.1 · 2026-09-26

## 1. Vision

Browser-based 3D FPV drone simulator. Player flies a 3-inch indoor quadcopter through a large
loft room, threading glowing rings in order and dodging furniture, pillars and a spinning
ceiling fan. Flight feel must match a real quad: same thrust-to-weight, motor lag, drag,
ground effect, Betaflight-style rates and PID loop. Xbox controller first, keyboard fallback.

Pillars:
1. **Real flight physics** — rigid-body 6-DOF, SI units, 1 kHz fixed step, real FC loop.
2. **Readable, beautiful 3D** — PBR, soft shadows, bloom, emissive rings, VFX, clear silhouettes.
3. **High frame rate** — 60 fps floor, 120 fps target on mid-range GPU; adaptive quality.

## 2. Game loop

```
Menu ──► Countdown (3-2-1) ──► Racing ──► Finished (time, best, retry)
                                 │  ▲
                        crash ►  Crashed ──(1.5 s / reset btn)─┘ respawn at last passed ring
```

- Course: ordered list of rings (N ≈ 12), 1 lap. Timer starts on "GO".
- Pass ring = drone centre crosses ring plane in forward direction inside inner radius,
  and ring is the *next* expected one. Out-of-order rings do nothing; next ring highlighted,
  subsequent ring dimmed; a HUD arrow points to the next ring.
- Crash = impact normal speed > 5 m/s, or drone upside down on floor > 1 s. Light bumps bounce.
  Race clock keeps running while crashed (≈1.5 s penalty, like a real race). Respawn 1.2 m past the last passed ring, facing the next.
- Free-fly mode: no timer, rings optional.
- Best time persisted in `localStorage` (try/catch).

## 3. Controls (Mode 2, like a real radio)

| Action | Xbox | Keyboard |
|---|---|---|
| Throttle | Left stick Y (full range: down = 0 %, up = 100 %) *or* RT (option) | W / S (ramped) |
| Yaw | Left stick X | A / D |
| Pitch | Right stick Y | ↑ / ↓ |
| Roll | Right stick X | ← / → |
| Arm / disarm | A | Space |
| Flight mode Acro ↔ Angle | Y | M |
| Camera FPV / Chase / LOS | RB | C |
| Reset to checkpoint | B | R |
| Pause / menu | Start (Menu) | Esc |

Stick processing: radial deadzone 0.05, then Betaflight *Actual* rates
(center sensitivity 200 °/s, max rate 670 °/s, expo 0.54). Throttle has mid/expo curve.
Angle mode: max tilt 55°, yaw still rate. Beginner default = Angle; Acro for experts.
Rumble on crash / ring pass via `vibrationActuator` when supported.

## 4. Flight model (the "truth")

Reference craft: 3-inch indoor quad (cinewhoop class), X-frame.

| Param | Value | Note |
|---|---|---|
| mass | 0.260 kg | AUW with 650 mAh 4S |
| arm (motor to centre, diag) | 0.066 m | 132 mm wheelbase |
| inertia Ixx, Iyy (yaw), Izz | 3.2e-4, 5.6e-4, 3.2e-4 kg·m² | body +Y = yaw axis |
| max static thrust / motor | 2.9 N | T/W ≈ 4.5 |
| motor time constant τ | 0.025 s up, 0.040 s down | first order lag (spin-down slower) |
| yaw torque coefficient kQ/kT | 0.012 m | reaction torque |
| body drag CdA (x, y, z) | 0.012, 0.018, 0.012 m² | quadratic, body axes; gives 15.7 m/s top speed at 55° tilt (cinewhoop-realistic) |
| rotor drag (H-force) | 0.08 N/(m/s) per unit thrust-normalised | linear, horizontal-in-body |
| ground effect | Cheeseman–Bennett `T/T∞ = 1/(1-(R/4z)²)`, clamped ≤ 1.4 | R = 0.038 m |
| battery | 16.8 → 14.0 V over ~5 min, 0.08 V instant sag per unit normalised thrust | scales max thrust ∝ (V/Vfull)² |
| gravity | 9.81 m/s² | air ρ = 1.225 kg/m³ |

Equations (world frame W, body frame B, body +Y = up/thrust axis, −Z = forward):
- Motor: `ω̇ = (ω_cmd − ω)/τ`, thrust `T_i = k_T ω_i²` (we normalise: `T_i = T_max·u_i²·batteryScale`
  where `u_i∈[0,1]` is the lagged normalised rpm).
- Force: `F = R·(0, ΣT_i·groundEffect, 0) + m g + F_drag + F_rotorDrag + F_contact`.
- Torque (body): `τ = Σ r_i × (0,T_i,0) + (0, Σ ±k_Q T_i, 0) − ω × Iω`.
- Integrator: semi-implicit Euler at **dt = 1 ms** (1000 Hz), quaternion re-normalised each step.
  Render interpolates between last two states (`alpha = accumulator/dt`).
- Max 250 physics steps per frame (spiral-of-death guard); game time slows instead.

Flight controller (runs every physics step, like an 1k/1k Betaflight setup):
- Rate PID per axis on gyro (gyro = true ω + small Gaussian noise 0.3 °/s, 1st-order LPF 100 Hz),
  D-term on measurement with LPF 80 Hz, I-term anti-windup (clamp, relax when throttle low).
- Angle mode: outer P loop on attitude error → rate setpoint.
- Mixer quad-X with **airmode** (shift to keep full authority at zero throttle), idle 5.5 %.
- Disarmed ⇒ motors 0.

## 5. Collision

- Drone collider: compound — sphere r = 0.075 m at centre + 4 spheres r = 0.040 m at props.
- World colliders (from level data): AABB box, oriented box (yaw only), vertical cylinder,
  torus (ring rim, tube radius), infinite planes for room shell.
- Narrow phase per step: sphere vs shape → contact (normal, depth, point). Broad phase: all
  shapes (≈ 60) — trivial cost; spatial grid not needed at this scale.
- Response: positional correction (Baumgarte-free projection, 80 %), impulse with restitution
  e = 0.25 and Coulomb friction μ = 0.5, applied at contact point ⇒ produces angular impulse
  (prop strikes flip the quad realistically).
- Moving obstacle (ceiling fan blades) = oriented boxes updated each step, contact adds blade
  surface velocity.

## 6. World / art direction

"Night-time industrial loft": 24 m × 14 m × 6 m, concrete floor with subtle roughness map,
brick + plaster walls, big steel-frame windows with moonlight + city glow, warm practical
lamps, wood/steel furniture, pillars, shelves, hanging Edison bulbs, sofa, rug, table,
ceiling fan, cable trays. High contrast between dark room and **cyan/magenta emissive rings**
so gates read instantly. Next ring pulses, passed rings go green then fade.

Lighting: 1 shadow-casting directional (moonlight through windows), 2–3 shadow spots
(tier-dependent), cheap point lights without shadow, PMREM environment (RoomEnvironment)
for PBR reflections, ACES filmic tone mapping, sRGB output.

Post FX (pmndrs `postprocessing`, merged EffectPass): Bloom (mipmap blur), SMAA,
vignette, subtle chromatic aberration in FPV at high speed, tone mapping.

VFX: GPU point sprites (dust motes in light shafts), ring pass burst (radial particles +
expanding shockwave torus), crash sparks + debris, prop-wash dust ring near floor,
propeller blur discs (alpha shader scaled with rpm), drone LED strips, FPV camera
shake from vibration.

Drone model: procedural (no external assets): carbon-fibre frame (procedural weave
texture), 4 motors with bells & copper windings hint, tri-blade props (+ blur disc),
TPU ducts (cinewhoop), battery with strap, FPV camera cage + lens, antennas, RGB LEDs.

Cameras: **LOS (default)** — standing pilot at the SW corner beside the take-off pad (eye 1.7 m, vertical FOV 62°), resting gaze on the whole room, head turns only when the drone nears the frame edge (dead-zone + critically damped spring), screen-constant locator brackets around a distant drone;
FPV (camera tilt 25° up, FOV 110° horizontal-ish ⇒ vertical 80°),
Chase (critically-damped spring), LOS (fixed tripod at pilot position, tracks drone).

Audio: WebAudio synthesised motor whine per motor (freq ∝ rpm), prop noise, ring chime,
crash thump. Starts after first user gesture.

## 7. Performance plan

- Budget @120 fps = 8.3 ms: physics ≤ 0.5 ms, scene update ≤ 1 ms, GPU ≤ 6 ms.
- Draw calls < 150: instancing for repeated props (bulbs, shelves items, pillars),
  merged static geometry, shared materials.
- Shadow maps: static casters rendered once (`shadowMap.autoUpdate=false` +
  `needsUpdate` only on tier change), drone uses a small dedicated contact-shadow blob +
  real shadow from key spot.
- **Quality tiers** (Ultra/High/Medium/Low) chosen by GPU probe (WEBGL_debug_renderer_info,
  `failIfMajorPerformanceCaveat`) then **dynamic resolution** controller keeps frame time
  under target (render scale 0.5–1.0 × DPR ≤ 2).
- **GPU when possible, CPU fallback**: WebGL2 hardware path by default. If context creation
  fails with `failIfMajorPerformanceCaveat` (software/SwiftShader), fall back to a CPU-friendly
  "Low" tier: no post FX, no shadows, DPR 0.75, fewer particles. If WebGL is totally
  unavailable show an explanatory screen. Physics is always CPU (it is tiny).
- rAF uncapped ⇒ runs at display refresh (60/120/144 Hz). FPS meter in HUD.

## 8. Architecture

```
main.ts ─ App
  ├─ core/      FixedLoop (accumulator), Quality (tier + dyn-res), Settings (persist)
  ├─ input/     GamepadInput, KeyboardInput → InputManager → ControlInput (normalised)
  ├─ control/   Rates, Pid, Mixer, FlightController   (pure, deterministic)
  ├─ physics/   DroneParams, DronePhysics (6DOF), Collision (shapes, contacts), PhysicsWorld
  ├─ game/      LevelData (single source), RaceController (state machine, ring logic)
  ├─ render/    Renderer (+post), Room, Materials, DroneModel, RingsView, CameraRig, vfx/*
  ├─ audio/     MotorAudio, Sfx
  └─ ui/        Hud, Menus (DOM overlay, CSS)
```
Data flow per frame: `input.poll → loop.step(n × {fc.update → physics.step → race.update})
→ view.sync(interpolated state) → render`. Simulation modules never import render/DOM
⇒ unit-testable in Node.

## 9. Quality gates / Definition of Done

- `tsc` strict clean, `vite build` OK.
- Unit tests: physics truths (hover throttle = √(mg/4Tmax) within 2 %, free fall 9.81,
  terminal velocity analytic, energy not created by collisions, ring pass logic, rates
  curve matches Betaflight formula, mixer airmode, PID step response settles, determinism).
- E2E (Playwright, real GPU): app boots, no console errors, WebGL context, measured FPS,
  simulated gamepad/keyboard flight takes off and lands, ring pass increments counter.
- Manual UAT checklist delivered in handover.
