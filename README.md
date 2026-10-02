# Drone Sim — FPV Loft

Browser 3D FPV drone simulator: realistic 3-inch quad physics (1 kHz rigid body + Betaflight-style
flight controller), Xbox controller support, 12-ring race through a night-time industrial loft.

**Play free:** https://dronesim.coworkgamestudio.com/play/ (Chrome/Edge recommended; plug in an Xbox-style controller and press a button).
The site root is the landing page; `/app/` is the Meta Quest store app (VR, store owners only). See
[docs/05-store-release.md](docs/05-store-release.md#website-layout-since-103).

**iPhone / iPad:** open the same link — on-screen twin sticks and buttons appear automatically (play in
landscape). iPad Safari goes full screen from the start tap. iPhone Safari cannot hide its bars for web
games: tap **Share → Add to Home Screen** and launch *Drone Sim* from the Home Screen for full screen.

**Meta Quest (VR):** install *Drone Sim* from the Meta Horizon Store (the free `/play/` page has no VR). You stand on a raised
platform in the loft corner and watch the quad (LOS); the right stick click switches to horizon-locked
FPV / chase. Touch controllers fly DJI-style, Mode 2: left thumbstick throttle/yaw (centre holds
altitude), right thumbstick speed forward/sideways (release = brake and hold position, Angle mode),
**A** arm · **B** Angle/Acro · **X** reset · **Y** pause · left trigger heading arrow · left stick click
recentres. The quad's front is green, its rear red. On the VR menu card: A = primary, X = secondary,
B = leave VR. Without a headset, run `npm run dev` and open `/app/?xremu=1&owned=1` to emulate a Quest 2
(IWER) with the store check skipped.

```bash
npm install && npm run dev   # local dev
npm test                     # unit tests
npm run test:e2e             # Playwright E2E (desktop Chrome + emulated Quest 2 + WebKit iPhone/iPad)
npm run ios / npm run android   # native App Store / Google Play shells (Capacitor)
```

Docs: [design](docs/01-design.md) · [implementation plan](docs/02-implementation-plan.md) ·
[handover](docs/03-handover.md) · [mobile design](docs/04-mobile-design.md) · [store release](docs/05-store-release.md)
