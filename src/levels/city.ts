/**
 * City (design 07 §3): 1.2 × 1.2 km of streets and towers from generateCity in late-afternoon sun, an 18-ring route through
 * street canyons, over rooftops and under the skybridges; pilot on a low roof at the south edge, ceiling
 * 250 m AGL, no pilot relocation. Every building, roof prop and park tree is a static collider in the grid.
 */
import type { OutdoorLevel } from '../types';
import { CITY_HALF, cityTerrainField, generateCity, type City } from '../world/city-gen';
import { GEN_VERSION } from '../world/world';
import { cityOutskirts, type Outskirts } from './city-outskirts';
import { createRuntime, type LevelRuntime } from './runtime';
import { outdoorEnv } from './skies';

export const CITY_SEED = 0x0c17_2026;
export const CITY_CEILING = 250;
/** afternoon haze: towers 1 km away still read, the outskirts melt into the horizon */
const CITY_VIEW = 2400;

export function cityLevel(city: City, outskirts: Outskirts): OutdoorLevel {
  return {
    id: 'city',
    kind: 'outdoor',
    name: 'City',
    env: outdoorEnv('afternoon', CITY_VIEW, 0.35),
    bounds: { kind: 'rect', min: [-CITY_HALF, -CITY_HALF], max: [CITY_HALF, CITY_HALF], maxAgl: CITY_CEILING },
    rings: city.rings,
    spawn: { position: [...city.spawn.position], yaw: city.spawn.yaw },
    pilot: [...city.pilot],
    pilotPlatform: 2,
    world: { gen: 'city', genVersion: GEN_VERSION, seed: city.seed },
    props: [],
    statics: [...city.colliders, ...outskirts.colliders],
  };
}

export function cityRuntime(seed = CITY_SEED): LevelRuntime {
  const city = generateCity(seed);
  const outskirts = cityOutskirts(city.seed);
  const rt = createRuntime(cityLevel(city, outskirts), cityTerrainField(city, GEN_VERSION));
  return { ...rt, content: { kind: 'city', city, outskirts, seed: city.seed } };
}
