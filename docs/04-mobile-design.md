# Drone Sim — Mobile / Touch Design (iPhone · iPad)

Version 0.2 · 2026-09-26 · companion to 01-design.md

## 1. Goals

- Playable and smooth on iPhone and iPad (Mobile Safari, iOS/iPadOS 17+), landscape.
- MOBA-style **virtual joysticks**, shown **only on touch devices** (hidden on desktop, hidden
  while a gamepad is the active input).
- Every button/menu usable by touch (≥ 44 × 44 pt hit targets, no hover dependence).
- Full screen: real Fullscreen API where available (iPad, Android), otherwise installable
  **home-screen web app** that launches full screen (the only route on iPhone).
- Frame rate: locked 60 fps on iPhone 13-class and newer, iPad; no thermal-throttle stutter
  in a 5-minute session.

## 2. Research findings (iOS constraints)

| Constraint | Consequence |
|---|---|
| iPhone Safari: Fullscreen API not available for non-video elements (partial/flagged). iPad: `webkitRequestFullscreen` on elements works. | Try `requestFullscreen ?? webkitRequestFullscreen`; if unsupported or rejected, show "Add to Home Screen" guide. |
| Home-screen web app with manifest `display: "fullscreen"` + `apple-mobile-web-app-capable=yes` runs without browser chrome. | Ship `manifest.webmanifest`, 180/192/512 icons, `apple-mobile-web-app-status-bar-style=black-translucent`. Detect `navigator.standalone` / `display-mode: fullscreen|standalone`. |
| Notch / Dynamic Island / home indicator. | `viewport-fit=cover`; HUD + sticks padded with `env(safe-area-inset-*)`. |
| `screen.orientation.lock` unsupported on iOS. | Portrait on phone ⇒ "Rotate to landscape" overlay, game paused. |
| Safari gestures: pinch-zoom, double-tap zoom, edge swipe, text selection, callout. | `touch-action: none` on game layer, `gesturestart/gesturechange` preventDefault, `user-select: none`, `-webkit-touch-callout: none`, `maximum-scale=1, user-scalable=no`, `overscroll-behavior: none`. |
| iPadOS reports a Mac user-agent. | Detect touch by `navigator.maxTouchPoints > 1` + `matchMedia('(pointer: coarse)')` + first `touchstart`/`pointerType==='touch'`, never by UA alone. |
| WebGL renderer string is "Apple GPU" on both Mac and iOS. | Mobile detection chooses tier (phone → medium, iPad → high), `maxDpr` phone 1.5 / iPad 1.75 capped, DynamicResolution on. |
| iOS Safari rAF runs at 60 Hz (ProMotion 120 Hz only with the Safari feature flag). | Target 60; simulation stays 1 kHz fixed-step so feel is identical. |
| WebAudio starts only from a user gesture; silent switch mutes it. | Unlock on first `touchend`; note in help. No `navigator.vibrate` on iOS ⇒ haptics skipped. |
| Memory limits on iOS WebGL (~1–1.5 GB tab). | Canvas textures ≤ 1024 px on mobile, shadow map ≤ 1024, particle pool reduced. |

## 3. Touch controls (virtual RC transmitter)

- Two **floating joysticks**, MOBA style: touching anywhere in the left/right half (excluding
  buttons) spawns the stick base under the thumb; the knob follows the finger, clamped to the
  base radius (≈ 60 pt phone, 72 pt tablet). Optional **fixed** placement setting.
- Sticks follow the chosen **stick mode 1–4** (same `MODE_TABLE`). The throttle axis behaves
  like a real gimbal: **non-centering** — releasing the thumb keeps throttle where it was
  (visual rail + marker); other axes spring back to centre. Setting "Throttle auto-centre"
  (centre = hover) for casual play.
- Output = same `ControlInput` path as the gamepad (deadzone, square gate off for touch since the
  virtual gate is already square-clamped per axis, rates/expo applied by the FC).
- Multi-touch: each stick tracks its own `pointerId`; ≥ 2 simultaneous fingers + buttons.
- Buttons (right/left upper edges, thumb-reachable, safe-area aware): **ARM**, **MODE**
  (Angle/Acro), **CAM**, **RESET**, **⏸ (pause)**. Large, glass, labelled, pressed state.
- Visibility: shown when last input source is touch; hidden when gamepad/keyboard used; never
  shown on non-touch desktops.

### 3.1 Default: auto-centre + altitude hold (v0.3, after user feedback)

Players expect MOBA sticks to spring back. Default touch mode is therefore **Auto-centre**:
both sticks re-centre on release and the throttle stick commands **climb rate** through a
DJI-style altitude hold ("A/Atti" mode with barometer): centre = hold altitude (captured once the
climb is braked, P on altitude → PI on vertical speed, tilt-compensated), full up +3 m/s, full down
−2.5 m/s. A **take-off latch** keeps throttle at 0 after a new session/respawn/disarm, so ARM works
with the stick at rest and the quad idles on the ground until the first push up.
"Hold" (real FPV gimbal, manual throttle, no altitude hold) stays available in Settings.

### 3.2 Acro on touch (after the 1.0.5 report "Acro always falls")

Acro does not self-level: the right stick sets a rotation rate and a centred stick keeps whatever
attitude the quad has. Measured on the iPhone profile, a thumb resting ≈ 30 % forward (pitch 0.26) for
1.5 s turned a hovering quad to 102° (belly up); past ≈ 69° the altitude hold cannot hold
(cos-tilt floor 0.35), the motors saturate and it falls at 15 m/s. Aids, with the Acro physics unchanged:

- touch Acro flies the roll / pitch **centre rate halved** (`TOUCH_ACRO_CENTER_SCALE`; max rate and expo
  kept, so full-stick flips still go round; custom rates are flown as set): the same thumb now gives 67°;
- the first switch to Acro on the touch sticks shows a one-time tip (no self-level, centre holds the
  attitude, Angle for stable flight), remembered in storage;
- in Acro the telemetry panel shows a small artificial horizon that turns red belly up.

## 4. Full-screen flow

1. Start screen on touch devices shows **"Tap to play full screen"** — the tap is the user
   gesture that unlocks audio and calls the Fullscreen API.
2. If fullscreen not available (iPhone Safari tab) → one-time dismissible sheet:
   "For full screen: Share → Add to Home Screen" with icon illustration; remembered in storage.
3. Running as home-screen app ⇒ already full screen; sheet never shown.

## 5. UI adaptations

- All menus: tap targets ≥ 44 pt, no hover-only affordances, scrollable dialogs with
  momentum scroll, safe-area padding, landscape phone height (≈ 390 pt) fits without clipping.
- HUD compacts on small screens; stick visualiser hidden when touch sticks visible (the
  sticks themselves are the visualiser).
- Quit chip, settings rows, steppers usable by tap and press-and-hold repeat.

## 6. Performance plan (mobile)

- Tier: phone → `medium` (shadows 1024, bloom on, SMAA off → FXAA-less; DPR ≤ 1.5),
  low-end/iPhone < 13 heuristics → `low`; iPad → `high` with DPR ≤ 1.75.
- DynamicResolution target 60 fps.
- Touch handlers passive where possible; no layout reads in pointermove; stick DOM moved by
  `transform` only.

## 7. Verification

- Unit: touch stick math (clamp, dead zone, non-centering throttle, mode mapping), device
  detection helpers.
- E2E (Playwright **WebKit** with iPhone 15 Pro + iPad Pro device descriptors, `hasTouch`):
  sticks visible only on touch, hidden on desktop project; multi-touch drag arms/lifts drone;
  all buttons tap-able; portrait overlay; no console errors; fps sample.
- Real Mobile Safari: iOS Simulator (iPhone 17 Pro, iPad Pro 13") via `xcrun simctl openurl`
  + screenshots, including a `?selftest=1` in-page scripted flight overlay that reports fps and
  pass/fail on the device itself.
- Final: user test on a physical iPhone/iPad via the GitHub Pages URL.
