/**
 * World engine public API (docs/09-world-engine.md). Pure TS: importable by the main thread, the chunk
 * worker and tests.
 */
export { createWorld, GEN_VERSION, SUPPORTED_GEN_VERSIONS, worldKey, type World, type WorldSpec } from './world';
export { LAKE_LEVEL, type TerrainPreset } from './base-terrain';
export { BIOME, BIOME_NAMES, biomeSample, type BiomeId, type BiomeSample, type TerrainField } from './terrain-field';
export {
  buildChunk,
  chunkColliders,
  chunkDigest,
  chunkIndices,
  chunkKey,
  CHUNK_SIZE,
  LOD_QUADS,
  LOD_STEP,
  ROAD_LIFT,
  SKIRT_DEPTH,
  type ChunkData,
  type ChunkRequest,
  type Lod,
  type RibbonMesh,
} from './chunk-gen';
export {
  BRIDGE_STRIDE,
  COLLIDER_STRIDE,
  HOUSE_STRIDE,
  OBJECT_KIND,
  ROCK_HALF,
  ROCK_STRIDE,
  SHAPE,
  TREE_DIMENSIONS,
  TREE_SPECIES,
  TREE_STRIDE,
} from './scatter';
export { HOUSE_ARCHETYPES } from './settlements';
export { spawnFromSeed, type SpawnPoint } from './spawn';
export { decodeSeed, encodeSeed, fnv1a32, formatCode, parseSeedInput, type DecodeResult, type SeedInput } from './seed-code';
export {
  ALPINE_RING_COUNT,
  ALPINE_RING_RADIUS,
  ALPINE_ROUTE,
  clearanceAt,
  distanceToShape,
  routeFromWaypoints,
  type RouteOptions,
  type RouteWaypoint,
} from './routes';
export { BUILDING_STRIDE, cityObstacles, cityTerrainField, generateCity, ROOF_PROP_STRIDE, type City } from './city-gen';
export { ChunkCancelledError, createChunkBuilder, InlineChunkBuilder, WorkerChunkBuilder, type ChunkBuilder } from './worker/chunk-builder';
