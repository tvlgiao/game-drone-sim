/**
 * City (design 07 §3): 1.2 × 1.2 km of streets and towers from generateCity at dusk, an 18-ring route through
 * street canyons, over rooftops and under the skybridges; the pilot starts at the start line, ceiling 250 m AGL,
 * pilot relocation on (a clear street or roof spot near the drone). Every building, roof prop and park tree is a
 * static collider in the grid.
 */
import type { OutdoorLevel } from '../types';
import { CITY_HALF, cityTerrainField, generateCity, type City } from '../world/city-gen';
import { GEN_VERSION } from '../world/world';
import { cityFurniture, type CityFurniture } from './city-furniture';
import { cityOutskirts, type Outskirts } from './city-outskirts';
import { createRuntime, type LevelRuntime } from './runtime';
import { outdoorEnv } from './skies';
import { createCityTraffic } from '../world/traffic/city-traffic';

export const CITY_SEED = 0x0c17_2026;
export const CITY_CEILING = 250;
/** dusk haze: towers 1 km away still read, the outskirts melt into the horizon */
const CITY_VIEW = 2400;

export function cityLevel(city: City, outskirts: Outskirts, furniture: CityFurniture): OutdoorLevel {
  return {
    id: 'city',
    kind: 'outdoor',
    name: 'City',
    env: outdoorEnv('dusk', CITY_VIEW, 0.35),
    bounds: { kind: 'rect', min: [-CITY_HALF, -CITY_HALF], max: [CITY_HALF, CITY_HALF], maxAgl: CITY_CEILING },
    rings: city.rings,
    spawn: { position: [...city.spawn.position], yaw: city.spawn.yaw },
    pilot: [...city.pilot],
    pilotPlatform: 2,
    world: { gen: 'city', genVersion: GEN_VERSION, seed: city.seed },
    props: [],
    statics: [...city.colliders, ...furniture.colliders, ...outskirts.colliders],
    relocatePilot: true,
  };
}

export function cityRuntime(seed = CITY_SEED): LevelRuntime {
  const city = generateCity(seed);
  const outskirts = cityOutskirts(city.seed);
  const furniture = cityFurniture(city);
  const rt = createRuntime(cityLevel(city, outskirts, furniture), cityTerrainField(city, GEN_VERSION));
  // living world (docs/12): cars on the street grid (kinematic colliders through the life hub) and traffic lights
  const traffic = createCityTraffic(city);
  rt.grid?.insertOwned('traffic-signals', traffic.roads.signalColliders);
  rt.life?.addTraffic(traffic.sim);
  return { ...rt, content: { kind: 'city', city, outskirts, furniture, seed: city.seed, traffic } };
}
