# UI / product audit loop

Repeatable loop used to bring every screen, device and setting to commercial standard. Run it before
every store submission, and after any change that touches UI, input, settings or rendering.

## 1. Capture

```bash
npm run build && npm run preview                 # http://localhost:4173
node scripts/ui-audit.mjs round-N                # all devices
node scripts/ui-audit.mjs round-N http://localhost:4173 iphone   # one device class
open audit/round-N/index.html                    # contact sheet (audit/ is git-ignored)
```

`scripts/ui-audit.mjs` drives the real build through the `window.__drone` debug hook
(`showScreen`, `showError`, `toast`, `action`, `press`, `setControl`, `teleport`) and the IWER Quest 2
emulator (`?xremu=1`). Each device folder gets numbered shots plus `-scrolled` variants for panels that
scroll; `manifest.json` lists shots and any console/page errors per device.

| Device class | Configs |
|---|---|
| Desktop | 1920×1080 (+ emulated Quest 2 VR card states), 2560×1440, 1366×768, 1280×720 |
| Quest Browser 2D panel | 1280×720, Quest UA, no touch |
| iPhone (WebKit, Safari toolbars included) | SE landscape 568×320, 15 Pro landscape, 15 Pro Max landscape, 15 Pro portrait (rotate overlay) |
| iPad (WebKit) | mini landscape, Pro 11 landscape and portrait |
| Android (Chromium) | Pixel 7 landscape, Galaxy Tab S4 landscape |

Screens per device: tap gate, Add to Home Screen (iOS), main menu, settings, rates, controls, controller
setup, pause, confirm quit, finish (normal + new best), race countdown / racing / crashed, flight HUD in
LOS / FPV / chase (touch sticks on touch devices), toast, bye, error; VR: Enter VR menu, VR menu card,
VR flight, VR paused card.

## 2. Review (parallel subagents, read-only)

| Agent | Scope | Output |
|---|---|---|
| Visual: phones | iPhone + Android phone folders | findings P0–P3 with screenshot path + fix location |
| Visual: tablets | iPad + Android tablet folders | same |
| Visual: desktop / Quest / VR | desktop, quest-browser, VR shots | same |
| Functional | every setting traced from UI → consumer, copy vs real bindings, numbers (rates, FOV, deadzone, holds, HUD units), runtime probes via `window.__drone` | findings + per-setting OK/BROKEN table |
| Commercial | store requirements (Apple, Google, Meta VRCs), onboarding, about/support/privacy, accessibility, comfort, content | prioritised list with effort |

Review agents never edit files, so their evidence stays tied to the captured build.

## 3. Triage (orchestrator)

Merge the reports, drop duplicates and false positives (verify each one on the screenshot or in the
code), and assign every accepted finding to exactly one fix agent by **file ownership**, so parallel
fixers never edit the same file. Out-of-scope or account-dependent items go to the backlog below.

## 4. Fix (subagents in isolated worktrees)

Each fixer owns a disjoint file set, works in its own git worktree, adds a test for each functional fix
(mutation-checked: the test must fail on the old code), and runs `npx tsc --noEmit`, `npx vitest run`
and the relevant Playwright specs. The orchestrator merges the branches, runs the full suite, then
**re-captures** (step 1) and checks every fixed finding on the new screenshots.

## 5. Ship

One PR per round → bot review loop (fix or rebut each finding with evidence, resolve threads) → merge →
deploy → spot-check the live domain.

## Round log

| Round | Date | Shots | Findings (P0/P1/P2/P3) | Fixed | Notes |
|---|---|---|---|---|---|
| 1 | 2026-10-02 | 382 on 14 configs, 0 errors | phones 24 (3/9/9/3), tablets 18, desktop+Quest+VR 19 (2 P0), functional 13 (+ per-setting table), commercial 25 (8 P0) | in progress | P0 found and fixed by the orchestrator: light-shaft shader NaN blacked out blocks of the frame at 2560×1440 (bloom spread it). Harness fix: desktop flights now hover (0.48) instead of climbing into the ceiling. |

### Round 1 triage → fixers (parallel worktrees, disjoint files)

| Fixer | Owns | Scope |
|---|---|---|
| F1 touch HUD | mobile.css, touch-controls.ts, mobile-shell.ts, input/touch.ts | chip/button/toast/timer overlaps on phones, rates cells, opaque gate + rotate overlay, countdown size, CAM width, touch layout behind menus, iPad wording of the home-screen sheet, touch re-latch |
| F2 menus | menus.ts, mode-labels.ts, icons.ts, rate-charts.ts, version define | Flight-mode label, context-aware Controls (touch / Quest Touch / gamepad), controller empty state, Rates help + custom-rates preservation + fine step, confirm-quit focus, bye/error copy, new-best delta, **About screen** (version, support, privacy, licences), reset to defaults |
| F3 settings/input/VR | main.ts, settings defaults, input, control, xr, camera rig | FPS chip off by default, throttle-limit floor, keyboard throttle reset, battery critical reachable, XR pause on visibilitychange + pad disconnect, 72 Hz + foveation, Quest-app Exit VR dead end, VR card legibility/placement/hints/km/h, chase/FPV at the ceiling |
| F4 desktop visuals | styles.css, hud.ts, index.html | fluid UI scale up to 2560, countdown/CRASHED titles, RESPAWNING contrast, free-fly HUD state, glass opacity, hover vs focus, ghost buttons, dialog text/titles, loading splash, toasts behind full-screen menus |

Backlog (needs a product decision, accounts or a later round): monetisation + entitlement (free + Full Game IAP), first-run tutorial, settings inside VR, VR comfort options (vignette), colour-blind nav palette / UI scale / reduced motion, separate audio buses, more tracks and quads, local medals/ghost, i18n, iOS PrivacyInfo.xcprivacy (needs an Xcode project resource entry).

