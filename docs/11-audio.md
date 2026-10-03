# 11 — Audio (engine, motor, effects, ambience, music)

Everything the game plays. Owner files: `src/audio/**` (engine `audio.ts`), the sound settings in
`src/core/settings.ts`, the Settings rows in `src/ui/menus.ts`, and four hooks in `src/main.ts`
(`setLevel`, `applySettings` / `configure`, `frame`, `attachUi`). Nothing is downloaded: every sound is
synthesised on the device, the music and one-shots once (offline render), the motor and the beds live.

## 1. Graph

```
motor (FPV path | spatial path) ─┐
one-shots (pooled voices) ───────┼─ sfx ──────┐
level reverb (convolver) ────────┘            │
ambience (beds, emitters, river, rush,        │
          one-shots) ── menu/pause state ── ambience ─┤
music stems ── layer gains ── low-pass ── level ── duck ── music ─┤── master ── glue comp ── limiter ── ceiling ── out
menu ticks ───────────────────────────────── ui ─────┤
countdown, GO, battery, out-of-bounds ─────── voice ──┘
```

- **Buses** (`mix.ts`): music, sfx, ambience, ui, voice. Fader = trim × slider. Sliders use a square law
  (50 % = −12 dB, 0 = silence). ui and voice follow the effects slider (one "effects" control for players).
  Trims: music 2.1, sfx 1.4, ambience 1.6, ui 0.8, voice 1.1 — set so that at the default sliders an FPV
  flight sits at about −14 LUFS (motor ≈ −19 dBFS RMS, music ≈ −24, ambience ≈ −30).
- **Dynamics**: glue compressor (−18 dB, 2.5:1), limiter (−4 dB, 20:1, 1 ms), then a WaveShaper ceiling
  (unity below 0.8, tanh shoulder, never past −0.4 dBFS) that catches what the compressor's attack lets by.
- **Ducking**: music −3 dB (LOS / chase) or −5 dB (FPV) as mean RPM goes from 55 % to 100 %; −9 dB on a crash,
  released over 2.2 s; −7 dB under a lap stinger. Floored at −18 dB in total.
- **Pause** (platform norm): the motor bus mutes, music goes to the "paused" mix (650 Hz low-pass, −9 dB),
  ambience to 30 %. **Hidden tab / quit / XR system menu**: the AudioContext is suspended (main.ts).
- **Node ownership** (`graph.ts`): every node is made through a `Scope` that counts it and disconnects
  and stops everything on dispose. A level owns one scope (reverb + ambience); each playing song owns one;
  one-shot sources disconnect themselves on `ended`. Level switches fade the old scope out and dispose it.

## 2. Motor (`motor.ts`) — the core of an FPV sim

Driven per motor by `DroneState.motors` (lagged normalised speed). Reference quad: 3″, 4S, 1404 ~4600 KV,
3-blade props, 12N14P motors → `MAX_RPM` 33 000.

| layer | source | follows |
| --- | --- | --- |
| prop tone | one oscillator per motor at the **shaft rate** (RPM/60) with a PeriodicWave whose harmonics 3, 6, 9… (the **blade-pass family**, RPM/60 × 3) are strong and the others faint (imbalance) | RPM; per-motor trim 1 / 1.011 / 0.993 / 1.017 so the four beat |
| ESC / winding whine | sine at 7 × shaft rate (pole pairs), high-passed | RPM, louder under load / punch |
| prop wash | pink noise, band-pass 500 → 3100 Hz with thrust, amplitude-modulated at the blade-pass rate | mean thrust^1.5, punch |
| load buzz | soft-clip WaveShaper with pre-gain 0.7 → 2.2 by load, body low-pass 1.2 → 5.4 kHz | thrust², punch |
| punch | rate of the mean motor speed above 2.2 /s | wash, drive, whine, brightness |
| desync chirp | a hard punch straight from idle (35 %): one motor dips to 62 % for 60 ms with extra drive | random |

All parameters glide with `setTargetAtTime` (25–50 ms) at ≤ 90 Hz: no zipper noise. A stopped prop is
silent; idle (5.5 %) sings.

**Paths** — FPV: close and dry (presence peak at 2.6 kHz, 6 % reverb send) plus an optional **video-link
colour** when Settings › Analog FPV feed is on (high-pass to ~240 Hz, low-pass to ~6 kHz and a little hiss,
scaled by its strength). LOS / chase: air absorption (low-pass from 20 kHz to 1.8 kHz with distance) →
PannerNode (HRTF on desktop and Quest, equal-power on phones and tablets; inverse distance, ref 8 m) and a
28 % reverb send. **Doppler** is computed from the drone's velocity along the drone→listener line
(c = 343 m/s, clamped to ±1 octave, smoothed at 10/s) and applied to every motor frequency.

The **listener** is the rendered eye every frame: the flight camera, the pilot's eyes in LOS, and in a
headset the XR camera (`renderer.xr.getCamera()`), so spatial audio turns with the head.

## 3. Effects (`sfx-bank.ts`, `sfx.ts`, `surface.ts`)

Rendered once, mono, by an OfflineAudioContext at start (core set, ~0.3 s on a desktop) and per level
(ambience one-shots); played through **pooled voices**: 6 positional (HRTF / equal-power) on sfx, 4 sfx,
3 ui, 3 voice, 5 ambience (lite: 4 / 3). The oldest voice is stolen when a pool is busy.

| event | sound |
| --- | --- |
| crash | per surface: concrete (crack + grit), wood (resonant knock), metal (modal ring), grass / soft (thud + rustle), water (splash + bubbles); each with a body thump and plastic debris; gain by impact speed, ±8 % pitch |
| surface | the last collider within 0.3 s (`surfaceOf`: rings / cars / lamps / AC units = metal, trees / crates / beams = wood, buildings / walls / rock = concrete, sofa / rugs = soft); the ground asks the world (water at the surface, rock / road / village = concrete, else soft) |
| collision | prop-strike ticks (2–4 clicks a blade apart), plus a bump above 1.2 m/s; at the contact point |
| ring pass | FM bell pair, pitched up a pentatonic step per ring while the combo lasts (2.6 s); every 4th ring a sector arpeggio |
| race finish | lap stinger (arpeggio into a brass chord, cymbal swell); best lap: higher, longer, with sparkle |
| countdown | 880 Hz beeps, GO at 1760 Hz; `audio.countdown(n)` (n ≤ 0 = GO) is public and de-duplicates, so a loading screen and the race can both call it |
| arm / disarm | ESC tones through a resonant "motor bell": three rising notes / two falling, from the drone |
| low battery | FC piezo beeper (2.73 kHz): 2 beeps every 4 s below 3.55 V/cell, 4 every 1.6 s below 3.3 V, after 1 s below the line (sag filter), only armed and flying |
| out of bounds | two-tone warning each second of the countdown; a rising chirp when back in |
| menus | hover / focus tick (also value arrows), select blip, back blip — from the menus' DOM (`attachUi`: clicks on `[data-act]` / `[data-dir]`, `is-focused` class changes), no menu code changes |

## 4. Ambience (`ambience-profiles.ts`, `ambience.ts`, `probe.ts`)

| level | beds | positional | one-shots | reverb |
| --- | --- | --- | --- | --- |
| Night Loft | room tone (brown), HVAC (pink band + 59.6 Hz hum), distant city | ceiling fan whoosh at the fan (7.2 Hz blade AM), neon buzz at the FPV / OPEN signs (120 Hz), the city through 2–4 windows | sirens and horns far outside | loft room 1.15 s |
| Training | wind, grass rustle | tractor in the far field | birds around the listener | open field |
| City (dusk) | traffic (fades with height), city hum, wind | — | horns at street level, distant sirens | street-canyon slapback (72–262 ms) |
| Alpine | wind | river rush at the nearest water | birds, cowbells near villages, church bell | valley echoes (0.42–0.93 s) |
| Infinite | wind, countryside, insects | river rush | birds, cowbells, church bell near villages | open field |

- **Reactive**: wind = base + per-100 m of height above ground (to 200 m; City ×1.6 per 100 m — the wind
  between the towers); the wind filter opens with gusts and height; a speed rush (pink band 450 → 2850 Hz)
  grows with speed², weighted FPV 1 / chase 0.6 / LOS 0.
- **World probe**: generated levels ask the world engine's field (`biomeAt`) three times a second around
  the listener (centre + 8 directions at 28 and 70 m; lite: 28 m only) for water and villages. The river
  emitter glides to the nearest water; village one-shots are placed around the nearest village.
- **Convolution reverbs** are generated (`dsp.impulseResponse`): taps + damped noise tail, normalised to
  unit energy. Lite: 60 % length, mono.

### 4.1 Living world (`life-sounds.ts`)

A level whose runtime has a life hub (docs/12) gets `LifeSounds` with its level scope (so it fades and is disposed
with the level, on the ambience bus):

- **Cars**: a fixed pool of voices (12 full, 6 lite / Quest / phones), each a sawtooth engine hum (fundamental
  by speed and vehicle type, low-passed) plus pink tyre noise (louder with speed, a little more when braking)
  through an equal-power panner. Every audio update `hub.getTrafficEmitters` gives the nearest cars and
  `SlotAssigner` keeps each car on its voice (matched by position moved on by its velocity), gives new cars
  the free voices (fade in) and silences voices whose car is gone. Doppler by hand (`dopplerFactor` on the
  car's radial speed relative to the moving listener) on the hum frequency and the noise playback rate.
- **Turbines and the tractor**: loop voices (4 full, 2 lite) from `hub.emitters`: a low broad swish pulsing at
  the blade-pass rate, a narrow diesel growl with a fast chug. The profile's fixed Training tractor is dropped
  on full tiers (the life's tractor plays instead).
- **Herds**: cowbells (cows) or a bleat (sheep) from somewhere in the nearest herd within 80 m every 1.5–5 s.
- **Events**: `horn` → a car horn at the car, `flock-scatter` → a burst of wing claps (new bank sounds `wings`,
  `bleat`).
- No node or object per update (pool built once; tested), and the hub's listeners are dropped on a level
  switch. Main-thread cost of the update 0.04–0.08 ms (City high, 12 voices; `audioMix.life.ms`); the graph is
  ~360 nodes in a City flight on high, ~280 on low.

## 5. Music (`music/`)

Option A (procedural): five original themes, one per level, written as data (`songs.ts`) and rendered
on the device into looping stems. Royalty-free by construction; nothing to licence.

| level | theme | style | tempo / key | voices |
| --- | --- | --- | --- | --- |
| Training, tutorial | Green Field | upbeat house-pop | 124 BPM, G major (I–V–vi–IV) | warm pad, pluck bass, pluck arp, whistle hook, house kit |
| Night Loft | Neon Loft | synthwave night | 100 BPM, A minor (i–VI–III–VII) | detuned saw pad, octave pulse bass, square arp, saw lead, gated snare |
| City | Dusk Grid | dark electronic | 125 BPM, F minor (i–VI–iv–V7) | dark pad, rolling 16th bass, acid arp, stabs, techno kit |
| Alpine | Summit | cinematic | 75 BPM, D minor (i–VI–III–VII) | string pad, string bass, spiccato ostinato, horn theme, taiko |
| Infinite | Open Country | ambient | 75 BPM, E major | air pad, sub bass, FM bells, flute, soft pulse |

- **Stems**: pad, bass, arp, beat, perc, lead, plus the song's **hall** (one convolution pass over all
  stems at their send levels). 8 bars; each stem is rendered with its tail and the tail is **folded onto the
  start** (`dsp.foldTail`), so the loop is seamless; loops are whole bars at the render rate, so stems stay
  sample-locked. Every stem is normalised to a role loudness (pad −25, bass −23, arp −28, beat −21,
  perc −31, lead −25 dBFS RMS, peak ≤ −3 dBFS), so a layer mix means the same in every song.
- **Adaptive** (`director.ts`, pure): menu = calm (pad, soft arp, a little bass, 4.2 kHz low-pass); free
  flight = chill (no tops, no lead); countdown = pad + building perc; race = full beat and tops; **final
  stretch** (last quarter of the rings, or the clock at 80 % of the best time) adds the lead; crash keeps the
  race layers under a 380 Hz low-pass (−4 dB) until the respawn; pause muffles; finish = outro (pad + arp).
  Layers crossfade with `setTargetAtTime` (0.12–1.2 s); songs crossfade over 1.6 s on a level change.
- **Rendering** is progressive (pad first, the hall last) and off the main thread (OfflineAudioContext); the
  current and the last song stay cached (lite: the current one). Music off = nothing is rendered.

## 6. Settings and migration

Settings › Master volume, Music (on/off), Music volume, Effects volume, Ambience volume. Defaults 70 % / on /
70 % / 90 % / 80 %. The X1 "Wind volume" folds into Ambience volume: a stored value is carried over only if
the pilot had moved it off the old default (0.6); saves without it get the new default (`migrateAmbience`).

## 7. Platforms

- **Autoplay / iOS unlock**: the context is created and resumed on the first gesture (`pointerdown`,
  `keydown`, `touchend`, `pointerup`, the mobile gate tap). After an interruption (a call on iOS, another
  app) the engine resumes on the next gesture.
- **iOS silent switch**: `navigator.audioSession.type = 'ambient'` (iOS 17+ / Safari 16.4+): the game
  respects the ring / silent switch and mixes with the player's own music — the iOS game norm.
- **Capacitor**: `App` `pause` suspends, `resume` resumes (when the game wanted sound), on top of the page
  visibility handling in main.ts.
- **Quest / WebXR**: the listener is the head pose; the XR system menu suspends (main.ts).

## 8. Assets and licences

| asset | source | licence | size |
| --- | --- | --- | --- |
| all music (5 themes) | original, `src/audio/music/songs.ts` + synth voices `instruments.ts` | © COWORK Game Studio | 0 bytes downloaded |
| all effects (35) | original recipes, `src/audio/sfx-bank.ts` | © COWORK Game Studio | 0 bytes downloaded |
| ambience beds, IRs | procedural, `ambience*.ts`, `dsp.ts` | © COWORK Game Studio | 0 bytes downloaded |

No third-party recordings or samples. `public/licenses.txt` and Settings › About say so. Download cost is
code only: `src/audio/**` is 150 KB of source, ≤ 64 KB minified / 22 KB gzipped (the old engine: 14 KB of
source). Nothing to precache beyond the bundle the service worker already caches.

## 9. Budgets (measured 2026-10-03, Apple-silicon Mac, Chrome headless)

Audio-thread load = offline render time / audio time of the whole in-flight graph (motor in chase, the
level's ambience and reverb, the race mix of the music), best of 3 on a shared machine. The previous
engine on the same footing: 0.45 %.

| level | full tier | lite tier | live nodes (full / lite) |
| --- | --- | --- | --- |
| Training | 4.4 % | 2.7 % | 138 / 122 |
| Night Loft | 6.2 % | 4.3 % | 168 / 146 |
| City | 5.1 % | 2.9 % | 137 / 125 |
| Alpine | 5.6 % | 3.2 % | 131 / 119 |
| Infinite | 4.3 % | 4.0 % | 137 / 125 |

- Biggest costs: the level reverb (~2 % stereo), the motor (~1–1.5 %), the two compressors (~0.5 %).
  **Trap**: never ramp a PannerNode position or the AudioListener (`setTargetAtTime`) — Chrome then pans
  every sample forever (measured 5.5 % vs 0.65 % for ten panners). `placePanner` / `placeListener` write
  plain values once per frame, and the listener is only written when the eye moved.
- **Main thread**: `frame()` ≈ 10–30 µs; no allocation per frame (reused frame objects, scalar math);
  the world probe runs at 3 Hz.
- **Memory**: music stems — full tier 32 kHz, stereo only for pad / arp / hall: 20–33 MB per song (two kept);
  lite 24 kHz mono: 10–17 MB (one kept). Effects bank ≈ 5 MB (lite ≈ 3 MB), noise beds 2.3 MB.
- **Start-up**: effects bank ≈ 0.3 s; a song's first stem (pad) in ≈ 0.3–0.9 s, the full song 1.5–4 s on
  a desktop, rendered while the level loads / the menu plays.
- **Tiers** (`audioTier`): lite = quality medium / low or a phone (Quest runs medium): mono 24 kHz stems,
  shorter mono room, optional emitters dropped (2 of 4 loft windows, the second neon, the tractor),
  one-shot rate halved, smaller pools. HRTF only on desktop / Quest, and only on the motor and impacts.

## 10. Tests

- Unit (`tests/unit/audio.test.ts`, fake WebAudio in `tests/unit/fixtures/fake-audio.ts`): bus routing and
  gain math, RPM → blade-pass / whine, Doppler, motor gating and punch, the music state machine (states,
  final stretch, crash / pause keep the layers), ambience per level, surfaces, IR energy, seamless loop fold,
  normalisation, the output ceiling, settings migration, battery filter, countdown de-dup, listener from the
  eye, plain-write positions, and **50 level switches without node leaks** (live nodes and the connected
  graph return to the same size, with time-based clean-up only).
- e2e (`tests/e2e/audio.spec.ts`): the context starts on the first tap and the menu music comes in;
  settings sliders move the live bus gains; every level plays its theme and ambience without console
  errors; pausing muffles and lowers the music and resuming opens it again.

## 11. Tuning and recording

Every number above lives in one place: bus trims and ducks in `mix.ts`, motor shaping in `motor.ts`, level
beds in `ambience-profiles.ts`, layer mixes in `music/director.ts`, stem loudness in `music/render.ts`,
effect trims in `sfx-bank.ts`. To listen without a device, drive `GameAudio` with an `OfflineAudioContext`
as its context (`new GameAudio({ createContext })`), call `frame()` / `handleEvent()` from
`ctx.suspend(t)` callbacks every ~16 ms of a scripted flight, and write the rendered buffer to WAV.
