# Drone Sim — FPV Loft

Browser 3D FPV drone simulator: realistic 3-inch quad physics (1 kHz rigid body + Betaflight-style
flight controller), Xbox controller support, 12-ring race through a night-time industrial loft.

**Play:** https://tvlgiao.github.io/game-drone-sim/ (Chrome/Edge recommended; plug in an Xbox-style controller and press a button)

**iPhone / iPad:** open the same link — on-screen twin sticks and buttons appear automatically (play in
landscape). iPad Safari goes full screen from the start tap. iPhone Safari cannot hide its bars for web
games: tap **Share → Add to Home Screen** and launch *Drone Sim* from the Home Screen for full screen.

**Meta Quest (VR):** open the link in the Quest Browser and press **Enter VR**. You stand at the pilot's
spot and watch the quad (LOS); the right stick click switches to horizon-locked FPV / chase. Touch
controllers, Mode 2: left thumbstick throttle/yaw (centre holds altitude), right thumbstick pitch/roll,
**A** arm · **B** Angle/Acro · **X** reset · **Y** pause · left stick click recentres. On the VR menu card:
A = primary, X = secondary, B = leave VR. Without a headset, add `?xremu=1` to emulate a Quest 2 (IWER).

```bash
npm install && npm run dev   # local dev
npm test                     # unit tests
npm run test:e2e             # Playwright E2E (desktop Chrome + emulated Quest 2 + WebKit iPhone/iPad)
```

Docs: [design](docs/01-design.md) · [implementation plan](docs/02-implementation-plan.md) ·
[handover](docs/03-handover.md) · [mobile design](docs/04-mobile-design.md)
