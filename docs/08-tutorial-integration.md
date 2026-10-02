# 08 — The tutorial in the game

The tutorial (docs/07-levels-design.md §4) is wired into `src/main.ts`. This note says how the pieces fit, so a
change to one of them does not silently break another.

## 1. Modules

| File | What it provides |
|---|---|
| `src/game/tutorial.ts` | `TutorialMachine`, `TutorialCtx`, the step table `TUTORIAL_STEPS`, records `loadTutorialRecord` / `saveTutorialRecord` / `shouldOfferTutorial`, `TUTORIAL_KEY = 'drone-sim.tutorial.v1'`. Pure TS: no DOM, no three, and it never touches the flight controller. |
| `src/ui/tutorial-prompts.ts` | `promptFor(stepId, source, settings, { armed, padId })` (1–2 lines) and `tutorialView(machine, source, settings, armed, padId)`, the `TutorialView` both cards render. |
| `src/ui/tutorial-ui.ts` | `TutorialUi`: the step card, the hint glow on the HUD stick wells and touch buttons, the first-run prompt and the completion card. It only emits callbacks. |
| `src/ui/xr-hud.ts` | `xrTutorialCard(view)` and `xrTutorialPrompt()`: `XrPanelContent` for `view.xrPanel.set`. |
| `src/ui/mode-labels.ts` | Prompt helpers `buttonLabel`, `pressVerb`, `channelDirLabel`, `channelSide`. Button and key names are read from the input manager's tables (`KEY_BUTTON`, `PAD_BUTTON`, `XR_BUTTON`, `KEY_STICKS`) through the HUD glyphs in `input-glyphs.ts`: a binding change shows up in the HUD, the Controls legend and the tutorial at once. Only touch keeps its own names (the on-screen buttons). |
| `tutorial-preview.html` + `src/ui/tutorial-preview.ts` | Dev-only harness, served by `vite` (not a build input). Takes `?step=1..12&source=keyboard\|gamepad\|touch\|xr&mode=1..4&trigger=1&hint=1&armed=0&prompt=1`. |

## 2. How main.ts runs it

- **Start / replay**: the first-run prompt's Start, the main menu's **Tutorial** button and the pause menu's
  **Replay tutorial** (shown only while the tutorial runs) call `startTutorial()`: Training is loaded, a free
  flight starts on the pad (no timer, every ring passable, crashes and resets respawn on the spawn pad), the camera
  goes to LOS and `tutorial.start(settings.flightMode)` begins at step 1.
- **Each flying frame** (`frame`, flying branch): `sim.fc.mode = tutorial.requiredFlightMode() ?? settings.flightMode`
  (angle on steps 2–8; settings untouched), `lockedButtons()` are dropped (arm on the welcome card, the mode toggle
  while angle is forced), then after the physics steps `tutorial.update(ctx)` with `agl` from
  `level.surfaces.topBelow`, the ring count from `ring-passed` events and `confirm` = Enter / A / the card's Continue.
  The machine never sees time pass while paused or behind a menu (it is only updated in the flying branch).
- **Crash / reset**: `crash` events and the reset button call `tutorial.crash()` (the step starts over); the free
  flight respawns the drone disarmed on the pad. On the flying steps the card's second line becomes the amber
  re-arm notice (`view.rearm`).
- **Done**: the race pauses under the completion card ([Menu] [Start Training]); A = Start Training, X = Menu in VR.
- **End**: skip, quit to menu or the completion card call `endTutorial()`, which restores the pilot's flight mode.
  A plain quit keeps the record's step and `skipped: false`.

## 3. Skip policy (owner decision)

There is **no hold-to-skip**. The tutorial is skipped with:

| Input | How |
|---|---|
| Keyboard | Esc (during the tutorial Esc skips instead of pausing) |
| Mouse / touch | the card's Skip button |
| Gamepad | Start / Menu opens the pause menu → **Skip tutorial** |
| Quest Touch | Y opens the pause card → X **Skip tutorial** |

The card's skip line says so per source (`skipLabel`: "Esc to skip", "Menu › Skip tutorial", "Y › Skip tutorial").

## 4. First-run prompt (shown once)

`shouldOfferTutorial(record)` is true only while there is no record at all: starting, skipping or finishing the
tutorial writes one, so the "New to FPV? 3-minute tutorial" [Skip] [Start] prompt appears once per device. A pilot
who left half-way replays it from the main menu. While `tutUi.dialogOpen` is set, menu input goes to the dialog
(VR: `xrTutorialPrompt()` on the card, A Start, X Skip).

## 5. Keyboard behaviour the prompts assume

Keys spring back like a stick and the keyboard flies with altitude hold (`holdsAltitude`): the arm key zeroes the
throttle itself, holding the throttle-up key climbs and letting go holds the height. The prompts say "Press Space
to arm", "Hold W to climb past 1.5 m", "Let go of W to hold that height", "Hold S to descend and touch down", with
the keys of the selected stick mode.

## 6. Input bindings

| Action | Keyboard | Gamepad (Xbox) | Touch | Quest Touch |
|---|---|---|---|---|
| Continue (step 1) | Enter | A | card Continue | A |
| Arm / disarm | Space | A | ARM | A |
| Flight mode | M | Y | MODE | B |
| Camera | C | RB | CAM | right stick click |
| Reset (repeat step) | R | B | RESET | X |
| Heading arrow | V | LB | — | left trigger |
| Recentre view (VR) | Z | LS click | — | left stick click |
| Skip | Esc | Menu › Skip tutorial | card Skip | Y › Skip tutorial |

## 7. Tests

- Unit: `tests/unit/tutorial.test.ts`, `tests/unit/tutorial-prompts.test.ts`.
- Layout: `npx playwright test -c playwright.tutorial.config.ts` (dev harness on port 5187, `TUTORIAL_PORT` to
  change it): card, hint glow, prompt and completion card on desktop widths and phones, and the card never
  overlapping the touch controls.
- Game: `tests/e2e/tutorial.spec.ts` (first-run prompt once, Skip persists, scripted keyboard steps 1–5 with
  altitude hold, forced angle, Esc skip, reset to the pad, replay, gamepad pause-menu skip and no hold-to-skip,
  LOS framing on Training).
