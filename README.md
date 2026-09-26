# Drone Sim — FPV Loft

Browser 3D FPV drone simulator: realistic 3-inch quad physics (1 kHz rigid body + Betaflight-style
flight controller), Xbox controller support, 12-ring race through a night-time industrial loft.

**Play:** https://tvlgiao.github.io/game-drone-sim/ (Chrome/Edge recommended; plug in an Xbox-style controller and press a button)

```bash
npm install && npm run dev   # local dev
npm test                     # unit tests
npm run test:e2e             # Playwright E2E (real GPU)
```

Docs: [design](docs/01-design.md) · [implementation plan](docs/02-implementation-plan.md) ·
[handover](docs/03-handover.md)
