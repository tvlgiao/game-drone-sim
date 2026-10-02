/** Night Loft: the original indoor course, LOFT_LEVEL unchanged plus identity, environment and bounds. */
import { LOFT_LEVEL } from '../game/level-data';
import type { IndoorLevel } from '../types';

export const NIGHT_LOFT: IndoorLevel = {
  ...LOFT_LEVEL,
  id: 'night-loft',
  kind: 'indoor',
  env: {
    sky: 'night-loft',
    fog: { color: 0x0b0f1a, viewDistance: 2.15 / 0.016 },
    ambience: { kind: 'room', gain: 1 },
    shadows: 'static-spots',
  },
  bounds: { kind: 'room', maxAgl: LOFT_LEVEL.room.size[1] },
  // VR LOS deck in the loft corner (eye ≈ 4 m): the course seen from above, not rings stacked behind each other
  pilotPlatform: 2.4,
};
