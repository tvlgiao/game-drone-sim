# 12 — Living world (traffic, birds, water, wind, roof and countryside life)

The owner's ask: "The city should have moving cars, and the surrounding scenery should have some animation." This
note is the contract of that layer: what moves, where it lives, what it costs per tier, and the hooks physics,
audio and tests use. Simulation code is pure TypeScript in `src/world/traffic/**` and `src/world/life/**` (no DOM,
no three.js, arithmetic-only like the rest of `src/world`, docs/09 §2); drawing lives in `src/render/life/**`. The
level views only create, update and dispose one object each (`WorldLife`, `TrainingLife`, `LoftLife`).

## 1. Modules

| File | What it provides |
|---|---|
| `world/traffic/vehicles.ts` | `VEHICLES` (sedan, hatchback, SUV, van, bus, taxi: size, IDM parameters, weight), `PAINT`, `pickVehicle`, `pickPaint`. |
| `world/traffic/network.ts` | `Network` / `Edge` (lanes, connectors, sampled centre lines, successors, the signal at a lane's end), `pointAt`. |
| `world/traffic/city-roads.ts` | `buildCityRoads(city)`: 14 × 14 intersections, 728 lanes, connectors, traffic-light poles + colliders. |
| `world/traffic/signals.ts` | `SignalPlan`: two-phase lights per intersection, hashed offsets. |
| `world/traffic/traffic-sim.ts` | `TrafficSim`: spawn / despawn, car following, lights, intersections, drone avoidance, poses, `queryMovers`, `nearestEmitters`, `drainEvents`; `carsOverlap`. |
| `world/traffic/city-traffic.ts` | `createCityTraffic(city)`, `ringConflicts`. |
| `world/traffic/rural-roads.ts` | `buildRuralNetwork(world, x, z, r)`: village roads as two lanes on the ground / bridge decks. |
| `world/life/movers.ts` | `MoverCollider`, `MoverSource`, `MoverSet` (moving colliders physics tests each step). |
| `world/life/hub.ts` | `LifeHub` (`rt.life`): movers, audio emitters, events. |
| `world/life/birds.ts` | `BirdFlocks`: boids-lite flocks that scatter from the drone. |
| `world/life/water-flow.ts` | `waterFlow(...)`: per-vertex river flow from the generator's water surface; `CITY_RIVER_FLOW`. |
| `world/life/countryside.ts` | `countrysideAround(world, x, z, r, faceYaw)`: chimneys, herds, turbine rows, the tractor's field. |
| `world/life/tractor.ts` | `Tractor`: a ploughing path, pose by clock, a mover. |
| `render/life/budget.ts` | `LIFE_BUDGETS` / `lifeBudget(tier, form)`. |
| `render/life/traffic-view.ts`, `vehicle-models.ts` | Vehicle draws, light pools, traffic lights. |
| `render/life/birds-view.ts`, `ambient.ts`, `anim-material.ts`, `life-models.ts`, `geo.ts` | Birds, animated instanced layers (GPU motion), puffs, the models. |
| `render/life/world-life.ts`, `city-life.ts`, `countryside-view.ts`, `training-life.ts`, `loft-life.ts` | One owner per level kind. |
| `render/life/gust.ts` | `GUST_GLSL`, `gustAt`, `TERRAIN_GUST` (travelling gusts). |

Hooks in existing files (small): `PhysicsWorld` tests `level.life.movers`; `LevelRuntime.life` (every runtime);
`cityRuntime` creates the traffic, puts the signal poles in the grid and the cars in the hub; the three level views
own their life object; `GameView` passes the runtime to `OutdoorLevelView`; water / grass / wind / terrain shaders
gain flow and gusts; the City facade shader switches some windows; `SkyDome.update` drives the clouds.

## 2. City traffic

- **Graph** (`buildCityRoads`): nodes at every crossing of the inner street lines (`streetLine(1…14)` on both
  axes). One lane per direction on the inner lane the ground shader paints, `LANE_OFFSET` = 2.1 m right of the
  double yellow line (right-hand traffic). A lane runs from 13 m past one intersection to the painted stop line
  13 m before the next (54 m). Connectors cross the box: straight lines, right and left turns as quadratic Béziers
  whose control point is where the two lane lines cross. No U-turns. Turn choice 56 % straight, 22 % right, 22 %
  left (deterministic stream).
- **Lights** (`SignalPlan`): per intersection the ±x approaches go together, then the ±z ones: 12 s green, 3 s
  yellow, 1.5 s all red, a hashed start offset per node. A car may enter on green when no cross traffic is still
  in the box, no oncoming left-turner is in it and its exit lane has room for it; left turners also yield to an
  oncoming car within 38 m. On yellow a car goes only if it cannot stop comfortably (and is then committed through
  the red); a committed car that has to wait at the line after all loses the commitment. The check is repeated at
  the moment the front crosses the line, so two cars deciding in the same step cannot both enter.
- **Driving**: the intelligent driver model (`v0`, `accel`, `decel`, headway, 2.2 m standstill gap) against the
  nearest obstacle: the car ahead on the lane, the stop line, the tail of the next lane / connector, the sibling
  car that just left the same lane onto another connector (until its rear is 14 m in), or the drone. A hard clamp
  keeps every move short of the obstacle, so cars cannot overlap even when the IDM overshoots. Sub-steps of
  ≤ 1/30 s.
- **The drone in the road**: below 3.6 m over the street and within the car's width + 1.1 m ahead (35 m), the
  drone is a stopped obstacle; a hard brake for it raises a `horn` event (6 s cool-down per car).
- **Spawning**: `sim.target` cars live within `sim.radius` of the drone and leave past radius + 40 m. The first
  fill (and any fill after a jump, when fewer than a quarter remain) covers the whole disc; afterwards new cars
  appear between 0.6 R and R, on a lane with ≥ 8 m to its neighbours.
- **Determinism**: own xorshift stream from the city seed; the same seed, dt sequence and drone path give
  identical traffic (tested by digest).
- **Colliders**: every car is a kinematic oriented box (`queryMovers`) with its velocity; `PhysicsWorld` queries
  the level's `MoverSet` around the drone each physics step and solves contacts against the relative velocity (a
  hit car pushes the drone along; a hit above `CRASH_SPEED` crashes). Signal poles and arms are static colliders
  (`traffic-signals` grid owner).
- **Race rings**: rings sit ≥ 6 m over the street (their lowest point); `ringConflicts` checks every lane and
  connector envelope (full width, ground to the 3.1 m bus roof) against every ring tube: none for 25 seeds
  (tested). If one ever did, its edges' cars stop being colliders (the drone flies through the ring), they keep
  driving. Traffic-light arms that would come within ring radius + 3 m become short poles instead.
- **Parked cars** (`city-furniture.ts`) are unchanged.

## 3. Vehicles on screen

- One instanced draw per type (`vehicle-sedan` … `vehicle-taxi`), ~140 triangles a car (bus 194): an extruded side
  profile, a greenhouse leaning in, glass, B-pillar, bumpers, grille, light clusters, six-sided wheels with rims.
  Paint from `PAINT` per instance (taxis yellow, buses in livery). The low tier draws all types with one generic
  model (100 triangles) stretched to each type's size.
- Dusk (`setDusk`): headlights, tail lights, the taxi sign, the lit bus cabin; braking cars (`CAR_FLAG.brake`:
  decelerating or queued) flare their tail lights. High / ultra add one additive draw of headlight pools, faint
  beams and a red glow behind (stronger when braking).
- Traffic lights: housings (pole, mast arm over the lane, a head on the arm and one on the pole) in one draw within
  `signalRange`; lit lamps (red / yellow / green per the plan) in another.
- Cars cast into the sun cascades on ultra only (high stays inside its 0.6 M triangles).

## 4. Ambient life

| What | Where | How |
|---|---|---|
| Clouds drift | every outdoor level | `SkyDome.update(time)` (Preetham clouds' own time), the look unchanged |
| Birds | City: pigeons over the park and two street corners, gulls over the river; Infinite: swallows; Alpine: choughs high in the valley; Training: swallows | `BirdFlocks` (circle a wandering home, cohesion / alignment / separation, ground clearance); within 22 m of the drone a flock flees away and up at 1.7× speed for 7 s and regroups 3 × the scare radius away (`flock-scatter` event). One instanced draw, wings beat in the vertex shader (gulls and crows glide) |
| Water | rivers, the Alpine stream, the City river | per-vertex `aFlow` from `waterFlow`: down the generator's own water surface (`lp − 1.2` on Infinite rivers, the valley floor in the Alpine stream), the across-channel part (along the depth gradient) dropped; ripples and foam advected with two blended phases (flow-map technique). Lakes are flat → no flow, the old breeze ripples. The City river has a level surface: drawn running south (`CITY_RIVER_FLOW`). Quest: the analytic ripple translated downstream |
| Gusts | Training grass blades and meadow, every swaying tree / bush / flag card, the worlds' meadows and crops | one field (`GUST_GLSL`): broad bands moving downwind at ~12 m/s, fronts bent by a slow cross-wind wave; blades bend further and show a paler side, trees lean further, meadow and crop colours brighten by up to 16 % under a gust |
| Windows | City facades at dusk | one lit room in five switches on / off on its own 25–95 s clock (facade shader) |
| AC fans | City roofs within 220 m | spinning blades in the AC units (one draw) |
| Steam | one AC unit in eight within 450 m | soft puffs (GPU-only age, rise, drift downwind, fade; the shared puff draw), tier-gated |
| Flags | one low / mid-rise roof in nine | pole + cloth rippling downwind (one draw); poles are colliders, never within a ring's clearance |
| Obstruction lights | corners of every tower over 90 m | synchronised red flash (one draw; the antennas already blinked) |
| Wind turbines | Infinite (rows of three on open land, one candidate per 640 m cell), Training (four on the northern rise) | rotor spun in the vertex shader (~16 rpm, own phase), facing into the wind; tower, nacelle and rotor disc are colliders |
| Chimney smoke | about half the cottages / farmhouses; Training farmhouse | puffs, tier-gated |
| Grazing animals | herds by the villages (cows; sheep on Infinite), the Training paddock | heads pitch down to graze and come up now and then, tails swish (vertex shader); static colliders |
| Tractor | a ploughed field by the village nearest the drone; Training by the red barn | up and down 6 m rows at 2.4 m/s with headland turns; a mover |
| Rural cars | Infinite / Alpine village roads (rebuilt around the drone every 420 m); the Training farm road | the same `TrafficSim` on `buildRuralNetwork` lanes, no lights, cars leave at a road's end |
| Training flags | the tent's feather flags | already fluttered (foliage card wind); the gusts now reach them too |
| Night Loft | ceiling fan, dust in the shafts (existing) | the "OPEN" neon stutters in bursts (the others hum), one bulb on its own light dips and buzzes (light + halo), a router on the coffee table blinks five LEDs |

Pedestrians were optional and are not in: the high-tier draw / triangle headroom went to traffic lights and roof
life.

## 5. Budgets

`LIFE_BUDGETS` (Quest / VR is always `low`):

| | ultra | high | medium (iPhone) | low (Quest) |
|---|---|---|---|---|
| City cars / radius | 220 / 420 m | 160 / 380 m | 90 / 300 m | 40 / 250 m, one generic draw |
| light pools / car shadows | ✓ / ✓ | ✓ / – | – / – | – / – |
| traffic lights drawn within | 260 m | 180 m | 170 m | 110 m |
| rural cars | 10 | 8 | 6 | 4 |
| flocks × birds | 3 × 16 | 3 × 12 | 2 × 10 | 1 × 8 |
| smoke / steam puffs | 160 | 110 | 60 | 0 |
| animals | 90 | 70 | 48 | 24 |
| tractor, roof life (fans, flags, beacons) | ✓ | ✓ | ✓ | – |

Measured per frame (renderer.info), the most of four poses (LOS on the take-off, FPV, chase, a vista 130 m up),
life hidden → shown in the same build (`scratchpad/living/measure.mjs`; 1920×1080 desktop, iPhone 15 Pro WebKit,
Quest = IWER immersive, both eyes):

| level | ultra | high (≤ 150 / 0.6 M) | medium | low | iPhone medium (≤ 110 / 250 k) | Quest IWER low, both eyes (≤ 80 / 120 k) |
| --- | --- | --- | --- | --- | --- | --- |
| City | 76 / 684 k → **104 / 811 k** | 76 / 555 k → **90 / 592 k** | 38 / 168 k → **51 / 193 k** | 14 / 52 k → **18 / 58 k** | 38 / 168 k → **51 / 193 k** | 30 / 105 k → **38 / 116 k** |
| Alpine Valley | 98 / 795 k → **103 / 797 k** | 98 / 538 k → **102 / 539 k** | 64 / 243 k → **69 / 244 k** | 17 / 55 k → **19 / 55 k** | 64 / 251 k → **69 / 253 k** | 32 / 110 k → **36 / 111 k** |
| Infinite (seed 1234) | 94 / 795 k → **109 / 817 k** | 91 / 507 k → **106 / 528 k** | 56 / 218 k → **64 / 226 k** | 17 / 48 k → **21 / 52 k** | 56 / 218 k → **64 / 225 k** | 36 / 97 k → **44 / 105 k** |
| Training | 78 / 1008 k → **90 / 1014 k** | 78 / 828 k → **90 / 834 k** | 43 / 279 k → **49 / 282 k** | 18 / 72 k → **22 / 73 k** | 43 / 189 k → **49 / 192 k** | 40 / 143 k → **48 / 146 k** |
| Night Loft | 109 / 332 k → **110 / 332 k** | 109 / 332 k → **110 / 332 k** | 76 / 134 k → **77 / 134 k** | 34 / 55 k → **35 / 55 k** | 76 / 134 k → **77 / 134 k** | 70 / 110 k → **72 / 110 k** |

draws / triangles, life off → **on** (2026-10-03, Apple-silicon Mac, ANGLE/Metal). Extra draws from life: City +4 to
+28 (ultra: six vehicle types, their two cascades, light pools, two signal draws, fans, flags, beacons, steam,
birds), the countryside +4 to +15, the loft +1 (router; the neon and the bulb add none). Quest: at most +8 per
frame for both eyes (City, Infinite, Training), traffic one generic draw. City high stays inside 0.6 M (cars cast
on ultra only, fans within 220 m, signals within 180 m). Over a budget before this work and still: Training high /
ultra triangles (the grass tufts), Training on Quest (143 k), iPhone Alpine (251 k): life adds ≤ 6 k there.

## 6. CPU

- City traffic, 220 cars (ultra): median 0.05–0.10 ms, p95 0.15–0.32 ms per update in Node on an Apple M4
  (`tests/unit/traffic.test.ts` prints it; the spread is the machine's load), 0.1–0.2 ms in the browser
  (`levelStats().life.trafficMs`). Tested < 1 ms.
- Birds: ≤ 58 birds, all pairs within a flock: negligible. Rural traffic ≤ 12 cars.
- Countryside placement around the drone (Infinite, every 320 m): 2–10 ms once (villages, houses, biome tests);
  the rural road network every 420 m.
- No allocation per frame (tested like the VFX pools: 1000 frames, no new three.js objects) — City, Infinite
  and the loft.

## 7. Audio hooks (wired: `src/audio/life-sounds.ts`, docs/11 §4.1)

```ts
const hub = runtime.life;                                   // LevelRuntime.life (every level has one)
const cars: TrafficEmitter[] = [];                          // reused objects; the array grows once
const n = hub.getTrafficEmitters(ear.x, ear.y, ear.z, 8, cars);
// cars[0 … n): nearest first — x, y, z (car centre), vx, vz, speed (m/s), type (VEHICLE), braking, distance

const all: LifeEmitter[] = [];
const m = hub.emitters(ear.x, ear.y, ear.z, 16, all);
// kind: 'car' | 'flock' | 'turbine' | 'herd' | 'tractor', position, velocity, speed, intensity 0..1, variant

const off = hub.on('horn', (e) => playHorn(e.x, e.y, e.z)); // a car braked hard for the drone
hub.on('flock-scatter', (e) => playWings(e.x, e.y, e.z));  // a flock took off
off();                                                      // unsubscribe (the hub is cleared with the level)
```

Event objects are reused: copy what you keep. Emitters reflect the last rendered frame (the level view ticks the
simulations).

## 8. Tests

- `tests/unit/traffic.test.ts`: the graph (lanes on the right, stop lines, connectors, no U-turns, a light per
  approach on a corner), the light cycle (never both axes), three minutes of 220 cars (no overlap — SAT on the
  car boxes —, no red-light entry checked from outside the sim, every car on its lane offset), a lone car stops at
  its line and goes on green, braking for a low drone but not a high one, radius / despawn / repopulation after a
  jump, determinism by seed, all six types, brake lights, CPU, rings (25 seeds) and the no-collide fallback,
  movers, and a PhysicsWorld drone hit and pushed by a car.
- `tests/unit/living-world.test.ts`: birds circle / scatter / determinism, river flow against the generator's
  water level and channel direction, flat water does not flow, countryside placement (deterministic, open ground),
  the tractor, rural roads on the ground, the hub hooks, budgets per tier, gusts travel downwind, neon / bulb, and
  no allocation + full dispose for the City, Infinite and loft views.
- `tests/e2e/living-world.spec.ts`: each outdoor level lives ten seconds with no console error inside its tier
  budget (desktop high, iPhone medium), a drone dropped on a waiting car crashes on its roof, twenty level
  switches leave no geometry / texture behind, and on the IWER Quest life adds ≤ 8 draws (both eyes) with no
  smoke.

## 9. Known limits

- City streets carry one lane per direction (the inner painted lane); the outer lane is parking / kerb.
- Car bodies yaw only (no pitch on the rural roads' slopes); wheels do not turn.
- Birds do not avoid buildings; flocks are placed over open ground and circle above low roofs.
- Rotor discs are boxes (a drone cannot slip between the blades).
- The countryside placement is recomputed on the main thread (a few ms every 320 m on Infinite).
