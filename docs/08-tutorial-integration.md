# 08 — Wiring the tutorial into main.ts

The tutorial (docs/07-levels-design.md §4) is built and tested but nothing in the game calls it yet. This
note says exactly what `src/main.ts` has to do. Nothing here edits the files the level work package owns
(`types.ts`, `levels/**`, `race.ts`, `level-data.ts`, `physics/**`, `render/**`, `menus.ts`): the hooks
it needs from them are listed in section 9.

## 1. Modules

| File | What it provides |
|---|---|
| `src/game/tutorial.ts` | `TutorialMachine`, `TutorialCtx`, the step table `TUTORIAL_STEPS`, records `loadTutorialRecord` / `saveTutorialRecord` / `shouldOfferTutorial`, `TUTORIAL_KEY = 'drone-sim.tutorial.v1'`. Pure TS: no DOM, no three, and it never touches the flight controller. |
| `src/ui/tutorial-prompts.ts` | `promptFor(stepId, source, settings, { armed })` (1–2 lines built from the mode-labels helpers) and `tutorialView(machine, source, settings, armed)`, which returns the `TutorialView` both cards render. |
| `src/ui/tutorial-ui.ts` | `TutorialUi`: the step card, the hint glow on the HUD stick wells and touch buttons, the first-run prompt and the completion card. It only emits callbacks. |
| `src/ui/xr-hud.ts` | `xrTutorialCard(view)` and `xrTutorialPrompt()`: `XrPanelContent` for `view.xrPanel.set`. |
| `src/ui/mode-labels.ts` | New prompt helpers: `buttonLabel`, `pressVerb`, `channelDirLabel`, `channelSide`. Their button names copy the tables in `input-manager.ts` (`PAD_BUTTON` / `KEY_BUTTON` / `XR_BUTTON`), so a binding change has to be made in both files. |
| `tutorial-preview.html` + `src/ui/tutorial-preview.ts` | Dev-only harness, served by `vite` (not a build input). Takes `?step=1..12&source=keyboard\|gamepad\|touch\|xr&mode=1..4&trigger=1&hint=1&armed=0&prompt=1`. |

## 2. Construction (in `boot`, after `hud` and `input`)

```ts
import { TutorialMachine, loadTutorialRecord, shouldOfferTutorial, type TutorialCtx, type TutorialEvent } from './game/tutorial';
import { TutorialUi } from './ui/tutorial-ui';
import { tutorialView } from './ui/tutorial-prompts';
import { xrTutorialCard, xrTutorialPrompt } from './ui/xr-hud';
import { GP } from './input/gamepad';

const tutorial = new TutorialMachine({ storage });
let tutConfirm = false;        // card Continue button, consumed by the next frame
let tutRings = 0;              // ring-passed events since the tutorial started
let tutRespawnToPad = false;   // the next 'respawn' goes to the pad, not to a race checkpoint
const tutUi = new TutorialUi(uiRoot, {
  onStart: () => startTutorial(),
  onSkip: () => endTutorial(tutorial.skip()),
  onConfirm: () => { tutConfirm = true; },
  onFinish: (action) => {
    tutUi.hide();
    if (action === 'training') startLevel('training');   // section 9: the level API
    else onAction({ type: 'menu' });
  },
});
```

## 3. Start, replay, end

```ts
function startTutorial(): void {
  startLevel('training', { mode: 'tutorial' });  // pad spawn, LOS camera, rings live, no countdown (section 9)
  cameraMode = 'los';
  tutRings = 0;
  tutConfirm = false;
  input.latchTakeoff();
  tutorial.start(settings.flightMode);           // remembers the pilot's mode for endTutorial
  hud.showScreen('none');
}

/** After skip / done / quit: give the pilot back their own flight mode. */
function endTutorial(events: TutorialEvent[] = []): void {
  const mode = tutorial.playerFlightMode;
  if (mode && settings.flightMode !== mode) {
    settings = { ...settings, flightMode: mode };
    saveSettings(settings, storage);
    hud.setSettings(settings);
  }
  sim.fc.mode = settings.flightMode;
  if (events.some((e) => e.type === 'skipped')) {
    tutUi.hide();
    onAction({ type: 'menu' });
  }
}
```

- **Replay**: the menus' `UiAction { type: 'tutorial' }` (main menu and pause menu "Replay tutorial", section 9)
  calls `startTutorial()`. `start()` always begins at step 1. A finished tutorial keeps `done: true` in the
  record, so replaying never brings the first-run prompt back.
- **Quit / menu while it runs** (`onAction({ type: 'menu' })`, `exitGame`): call `tutorial.skip()` only when
  the pilot chose Skip; for a plain quit call `endTutorial()` and `tutUi.hide()`. The record keeps the step
  reached and leaves `skipped` false, so the first-run prompt is offered again next launch.

## 4. First-run prompt

Right after `hud.showScreen('main')` at boot:

```ts
if (shouldOfferTutorial(loadTutorialRecord(storage))) tutUi.showPrompt();
```

`shouldOfferTutorial` is true until the tutorial is finished or skipped once, so after a Skip it never nags
again. While `tutUi.dialogOpen` is set, menu input goes to it instead of the menus, in the `!flying` branch
of `frame`:

```ts
if (!flying) {
  if (inVr && inp.xr) {
    if (tutUi.dialogOpen === 'prompt') {          // the DOM prompt is invisible in a headset
      if (inp.xr.a) { tutUi.hide(); startTutorial(); }
      else if (inp.xr.x) { tutUi.hide(); endTutorial(tutorial.skip()); }
    } else handleXrMenu(status, inp.xr);
  } else if (!tutUi.navigate(inp.nav, inp.buttons.confirm)) {
    hud.navigate(inp.nav, inp.buttons.confirm);
    // …existing paused / resume handling
  }
}
```

In VR, show `xrTutorialPrompt()` on the card while the prompt is open (section 7).

## 5. Each frame while the tutorial runs

Put this in the `flying` branch, after `loop.advance(...)` and the respawn teleport, and before
`handleFlightButtons(inp.buttons, inp.control)`:

```ts
if (tutorial.active) {
  // 1. angle forced on steps 2–8; the pilot's own mode otherwise (settings are not touched)
  sim.fc.mode = tutorial.requiredFlightMode() ?? settings.flightMode;
  // 2. arm on the welcome card (A = confirm on pad and Quest), mode toggle while angle is forced
  for (const b of tutorial.lockedButtons()) inp.buttons[b] = false;
  // 3. skip: Esc on a keyboard (Start still pauses on a pad); hold B on pad / Quest (machine times it)
  if (inp.source === 'keyboard' && inp.buttons.pause) {
    inp.buttons.pause = false;
    endTutorial(tutorial.skip());
  }
  // 4. reset (R / pad B / Quest X) starts the step again on the pad instead of a race checkpoint
  if (inp.buttons.reset) {
    inp.buttons.reset = false;
    if (tutorial.crash()) respawnOnPad();
  }
  const s = sim.world.state;
  const ctx: TutorialCtx = {
    dt: frameSec,
    drone: s,                                         // DroneState fits TutorialDrone structurally
    agl: s.position.y - groundBelow(s.position),      // section 9; resting ≈ 0.075 m < LAND_AGL 0.15
    armed: sim.fc.armed,
    flightMode: sim.fc.mode,
    cameraMode,
    source: inp.source,
    ringsPassed: tutRings,
    confirm: inp.buttons.confirm || tutConfirm,
    skipHeld:
      (inp.source === 'gamepad' && (inp.pad?.buttons[GP.B] ?? 0) > 0.5) ||
      (inp.source === 'xr' && input.xr.held.b),
  };
  tutConfirm = false;
  const events = tutorial.update(ctx);
  if (events.some((e) => e.type === 'skipped' || e.type === 'done')) endTutorial(events);
}
```

Notes:

- `requiredFlightMode()` is applied to `sim.fc.mode` only. `settings.flightMode` changes only when the pilot
  presses MODE on step 9 (the existing `toggleMode` handler saves it); `endTutorial` restores the mode the
  pilot started with.
- Update the machine only in the `flying` branch: it must not see time pass while paused (status `paused`
  is not flying) or while a menu covers the view.
- `handleFlightButtons`' mode toggle reads `sim.fc.mode`, which is the forced `angle` on steps 2–8. That is
  why `toggleMode` is in `lockedButtons()` there: without it, a press would save `acro` to the settings.
- Quest B is both the mode toggle and hold-to-skip. On steps 2–8 the toggle is locked; on steps 9–11 the
  first instant of a B hold also toggles the mode. That is harmless: `endTutorial` restores the mode.
- Pad B is also `reset`, so its press edge restarts the current step before the hold skips. Acceptable,
  because the pilot is leaving anyway.

## 6. Crash, respawn on the pad, rings

In `dispatch(e)`:

```ts
case 'crash':
  // …existing rumble / disarm
  if (tutorial.crash()) tutRespawnToPad = true;   // same step again, from the pad
  break;
case 'respawn':
  respawnPending = true;
  break;
case 'ring-passed':
  // …existing rumble
  tutRings++;
  break;
```

And where `respawnPending` is handled:

```ts
if (respawnPending) {
  respawnPending = false;
  const p = tutRespawnToPad ? { position: padPosition(), yaw: level.spawn.yaw } : race.respawnPoint();
  tutRespawnToPad = false;
  placeDrone(p.position, p.yaw);
  if (tutorial.active) input.latchTakeoff();
  alpha = 1;
}
```

`respawnOnPad()` (used by reset in section 5) does the same directly:
`placeDrone(padPosition(), level.spawn.yaw); sim.setArmed(false, zeroThrottle); input.latchTakeoff();`.

After a crash the drone is disarmed on the pad. On the flying steps (3–7) the card's second line becomes an
amber "Disarmed: … then press Space / tap ARM / press A" notice (`view.rearm`), so the repeated step reads
correctly without its own re-arm step.

## 7. Rendering (DOM and VR)

At the end of `frame`, after `hud.update(...)`:

```ts
const tutShown = tutorial.active || tutorial.phase === 'done';
tutUi.render(tutShown ? tutorialView(tutorial, inp.source, settings, sim.fc.armed) : null);
```

- `render` is cheap per frame (only changed text touches the DOM). On the done step it opens the completion
  card ([Menu] [Start Training], Start Training focused); `navigate` drives it from pad and keyboard. Once
  answered, `onFinish` fires and the card stays closed even if `render` keeps receiving the done view.
- When the completion card opens, `tutUi.dialogOpen === 'done'`. Route `inp.nav` / `inp.buttons.confirm` to
  `tutUi.navigate` in that state too, even though the status is still a flying one. Simplest: run
  `tutUi.navigate(...)` before the `if (!flying)` block and skip the flight buttons when it returns true.
- Hint (20 s with no progress): the card turns amber and re-announces its lines (`aria-live`). The control
  to use glows: HUD stick well (`[data-r="wellL|R"]`), throttle bar when RT is the throttle, touch stick base
  or ARM / MODE / CAM button. The glow uses the existing markup's selectors in `hud.ts` and
  `touch-controls.ts`; renaming those attributes breaks the glow silently.
- Touch: the card's Skip button is the "Skip" chip; the welcome card shows a Continue button (`onConfirm`).

VR card, in the `if (inVr)` block, replacing the `xrHudContent` call while the tutorial owns the card:

```ts
const content = tutUi.dialogOpen === 'prompt'
  ? xrTutorialPrompt()
  : tutShown
    ? xrTutorialCard(tutorialView(tutorial, 'xr', settings, sim.fc.armed))
    : xrHudContent({ /* …unchanged */ });
view.xrPanel.set(content);
```

`xrTutorialCard` puts the welcome and done cards at eye level (`layout: 'menu'`) and flight steps low
(`'hud'`), so the drone stays in view from the LOS platform. Done card buttons in VR: A = Start Training,
X = Menu. Handle them like `handleXrMenu`: `if (inp.xr?.a) finish('training') else if (inp.xr?.x) finish('menu')`,
where `finish` is the same function as `onFinish`. Keep the redraw throttle (`XR_PANEL_PERIOD`): the card
only redraws when its text changes.

## 8. Input bindings the prompts assume

| Action | Keyboard | Gamepad | Touch | Quest Touch |
|---|---|---|---|---|
| Continue (step 1) | Enter | A | card Continue | A |
| Arm / disarm | Space | A | ARM | A |
| Flight mode | M | Y | MODE | B |
| Camera | C | RB | CAM | right stick click |
| Skip | Esc | hold B 1 s | card Skip | hold B 1.5 s |

Stick directions come from `channelDirLabel` and follow the stick mode (1–4), the gamepad's RT throttle
setting and the per-channel inverts. Axis remaps (`axisMap`) do not change the labels: the pilot remapped
the axes so that their physical sticks match the mode.

## 9. What the level work package has to provide

- `startLevel('training', { mode: 'tutorial' })`: Training with the pad spawn, rings live, no countdown and
  no lap timer, and `ring-passed` events from ring 0. Whatever the race mode is called, the tutorial only
  counts `ring-passed` events.
- `groundBelow(position)` for AGL (Training: `surfaceBelow` / `heightAt` of the meadow, ± 0.3 m) and
  `padPosition()` (the Training spawn).
- `UiAction { type: 'tutorial' }` on the main menu and the pause menu ("Replay tutorial").

## 10. Tests

- Unit: `tests/unit/tutorial.test.ts` (machine on synthetic `TutorialCtx` sequences) and
  `tests/unit/tutorial-prompts.test.ts` (prompts per source and stick mode, view, VR card). Both run in
  `npm test`.
- Layout: `npx playwright test -c playwright.tutorial.config.ts` starts `vite` on port 5187 (`TUTORIAL_PORT`
  to change it) and checks the card, hint glow, prompt and completion card at 1280, 1440 and 2560 px wide
  (Chromium) and on an iPhone in landscape (WebKit). `SHOTS_DIR` sets where the screenshots go.
- An e2e run of the wired game (first-run prompt once, Skip persists, steps 1–4 with scripted keys, replay)
  belongs in the integration package's specs, once `main.ts` is wired.
