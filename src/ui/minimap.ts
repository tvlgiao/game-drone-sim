/**
 * North-up outdoor minimap (design 07 §6): terrain classes sampled from the world around the drone at ~4 Hz,
 * drawn into a 64 × 64 cell image (16 m cells, ≈ 1 km across), with the drone arrow, the next ring and the pilot
 * on an overlay redrawn with the HUD text. Cells are cached by world coordinates, so moving only samples the new
 * edge; a per-refresh budget caps the cost of a teleport or a level change.
 */
import { BIOME, biomeSample, type BiomeId, type TerrainField } from '../world/terrain-field';
import { wrap180 } from './compass';

/** A city building footprint (the biome table has no such class). */
export const MAP_BUILDING = 11;
export type MapCell = BiomeId | typeof MAP_BUILDING;

/**
 * Provided by the level (X1 / main.ts). `cell` classifies the ground at world (x, z) metres; `size` is the cell
 * edge in metres, so thin features (roads, streams) can be reported when they cross the cell rather than only
 * when its centre lands on them.
 */
export interface MinimapSampler {
  cell(x: number, z: number, size: number): MapCell;
  /** playable area of a bounded level, drawn as its edge */
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface MinimapFrame {
  x: number;
  z: number;
  /** compass degrees */
  heading: number;
  ring: { x: number; z: number } | null;
  pilot: { x: number; z: number } | null;
}

export const MAP_CELLS = 64;
export const MAP_CELL_M = 16;
/** terrain refresh period (ms) */
export const MAP_PERIOD = 250;
/** new cells sampled per refresh at most (≈ 3 ms with the reference sampler's three `biomeAt`) */
export const MAP_BUDGET = 320;
const CACHE_MAX = MAP_CELLS * MAP_CELLS * 6;
const KEY_OFFSET = 1 << 15;

const COLORS: Record<number, [number, number, number]> = {
  [BIOME.water]: [38, 112, 190],
  [BIOME.beach]: [196, 180, 128],
  [BIOME.meadow]: [92, 132, 66],
  [BIOME.farmland]: [140, 140, 78],
  [BIOME.forest]: [40, 84, 50],
  [BIOME.conifer]: [32, 70, 52],
  [BIOME.scrub]: [110, 118, 74],
  [BIOME.rock]: [122, 118, 108],
  [BIOME.snow]: [222, 230, 236],
  [BIOME.village]: [204, 140, 88],
  [BIOME.road]: [226, 218, 196],
  [MAP_BUILDING]: [150, 160, 176],
};

/**
 * Map-space position (CSS px from the map's top-left) of a point `dx` east / `dz` south of the centre. North is
 * up, so −Z goes up the screen.
 */
export function worldToMap(dx: number, dz: number, metresPerPx: number, size: number): { x: number; y: number } {
  return { x: size / 2 + dx / metresPerPx, y: size / 2 + dz / metresPerPx };
}

/**
 * Keeps a marker on a round map: points beyond `radius` from the centre are pulled onto the rim along their
 * direction (`pinned`), so an off-map ring or pilot still shows which way to go.
 */
export function clampToDisc(x: number, y: number, size: number, radius: number): { x: number; y: number; pinned: boolean } {
  const cx = size / 2;
  const dx = x - cx;
  const dy = y - cx;
  const d = Math.hypot(dx, dy);
  if (d <= radius) return { x, y, pinned: false };
  return { x: cx + (dx / d) * radius, y: cx + (dy / d) * radius, pinned: true };
}

/**
 * Reference sampler over a world `TerrainField`: one `biomeAt` per cell at its centre, plus the two quarter
 * points on the diagonal so 8–10 m roads and streams read as lines rather than dots. City blocks (`village` in
 * the city field) draw as buildings.
 */
export function terrainMinimapSampler(field: TerrainField, bounds?: MinimapSampler['bounds']): MinimapSampler {
  const b = biomeSample();
  const city = field.preset === 'city';
  return {
    bounds,
    cell(x, z, size) {
      const c = field.biomeAt(x, z, b).biome;
      if (c === BIOME.water || c === BIOME.road) return c;
      const q = size / 4;
      for (const [dx, dz] of [
        [-q, -q],
        [q, q],
      ] as const) {
        const s = field.biomeAt(x + dx, z + dz, b).biome;
        if (s === BIOME.road || s === BIOME.water) return s;
      }
      return city && c === BIOME.village ? MAP_BUILDING : c;
    },
  };
}

const cellKey = (ix: number, iz: number): number => (ix + KEY_OFFSET) * 65536 + (iz + KEY_OFFSET);

export class Minimap {
  private sampler: MinimapSampler | null = null;
  private readonly cache = new Map<number, MapCell>();
  private readonly cells: HTMLCanvasElement;
  private readonly cellsCtx: CanvasRenderingContext2D | null;
  private readonly image: ImageData | null;
  private readonly terrainCtx: CanvasRenderingContext2D | null;
  private readonly overCtx: CanvasRenderingContext2D | null;
  private lastTerrain = -Infinity;
  /** world point the terrain image is centred on */
  private cx = 0;
  private cz = 0;
  private px = 1;
  /** cells still unknown after the last refresh: refresh again next tick instead of waiting for the period */
  private pending = false;

  constructor(
    private readonly terrain: HTMLCanvasElement,
    private readonly over: HTMLCanvasElement,
  ) {
    this.cells = terrain.ownerDocument.createElement('canvas');
    this.cells.width = MAP_CELLS + 1;
    this.cells.height = MAP_CELLS + 1;
    this.cellsCtx = this.cells.getContext('2d');
    this.image = this.cellsCtx?.createImageData(MAP_CELLS + 1, MAP_CELLS + 1) ?? null;
    this.terrainCtx = terrain.getContext('2d');
    this.overCtx = over.getContext('2d');
  }

  /** New level (or none): drops every cached cell. */
  setSampler(s: MinimapSampler | null): void {
    this.sampler = s;
    this.cache.clear();
    this.lastTerrain = -Infinity;
  }

  get hasSampler(): boolean {
    return this.sampler !== null;
  }

  /** Backing-store size for the CSS size and device pixel ratio; call when the map is shown or resized. */
  resize(cssPx: number, dpr: number): void {
    const px = Math.max(16, Math.round(cssPx * Math.min(3, Math.max(1, dpr))));
    if (px === this.terrain.width && this.px === cssPx) return;
    this.px = cssPx;
    for (const c of [this.terrain, this.over]) {
      c.width = px;
      c.height = px;
    }
    this.lastTerrain = -Infinity;
  }

  /** Redraws the overlay; re-samples and redraws the terrain when its period has passed. */
  update(f: MinimapFrame, now: number): void {
    if (!this.sampler) return;
    if (this.pending || now - this.lastTerrain >= MAP_PERIOD) {
      this.lastTerrain = now;
      this.drawTerrain(f.x, f.z);
    }
    this.drawOverlay(f);
  }

  /** Number of cells sampled so far (tests / perf probes). */
  get cachedCells(): number {
    return this.cache.size;
  }

  private drawTerrain(x: number, z: number): void {
    const s = this.sampler!;
    const img = this.image;
    const ctx = this.terrainCtx;
    if (!img || !ctx || !this.cellsCtx) return;
    if (this.cache.size > CACHE_MAX) this.evict(x, z);
    const half = MAP_CELLS / 2;
    const ix0 = Math.floor(x / MAP_CELL_M) - half;
    const iz0 = Math.floor(z / MAP_CELL_M) - half;
    let budget = MAP_BUDGET;
    let missing = false;
    const data = img.data;
    const n = MAP_CELLS + 1;
    // centre-out rows: with a budget, the cells around the drone fill first
    for (let k = 0; k < n; k++) {
      const j = half + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
      if (j < 0 || j >= n) continue;
      for (let i = 0; i < n; i++) {
        const key = cellKey(ix0 + i, iz0 + j);
        let c = this.cache.get(key);
        if (c === undefined) {
          if (budget <= 0) {
            missing = true;
            const o = (j * n + i) * 4;
            data[o + 3] = 0;
            continue;
          }
          budget--;
          c = s.cell((ix0 + i + 0.5) * MAP_CELL_M, (iz0 + j + 0.5) * MAP_CELL_M, MAP_CELL_M);
          this.cache.set(key, c);
        }
        const rgb = COLORS[c] ?? COLORS[BIOME.meadow]!;
        const o = (j * n + i) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
    this.pending = missing;
    this.cellsCtx.putImageData(img, 0, 0);
    this.cx = x;
    this.cz = z;
    const W = this.terrain.width;
    const scale = W / MAP_CELLS;
    // the cell grid is anchored to world cells: shift by the drone's offset inside its cell
    const ox = ((x / MAP_CELL_M) % 1 + 1) % 1;
    const oz = ((z / MAP_CELL_M) % 1 + 1) % 1;
    ctx.clearRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.cells, -ox * scale, -oz * scale, n * scale, n * scale);
    const b = s.bounds;
    if (b) {
      const mpp = (MAP_CELLS * MAP_CELL_M) / W;
      const tl = worldToMap(b.minX - x, b.minZ - z, mpp, W);
      const br = worldToMap(b.maxX - x, b.maxZ - z, mpp, W);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 197, 61, 0.9)';
      ctx.lineWidth = Math.max(1, W / 96);
      ctx.setLineDash([W / 32, W / 48]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.restore();
    }
  }

  private drawOverlay(f: MinimapFrame): void {
    const ctx = this.overCtx;
    if (!ctx) return;
    const W = this.over.width;
    const u = W / 128;
    const mpp = (MAP_CELLS * MAP_CELL_M) / W;
    ctx.clearRect(0, 0, W, W);
    // the terrain image lags the drone by up to one refresh: draw markers relative to the image centre
    const ox = f.x - this.cx;
    const oz = f.z - this.cz;
    const rim = W / 2 - 7 * u;
    const pilot = f.pilot ? clampToDisc(...xy(worldToMap(f.pilot.x - this.cx, f.pilot.z - this.cz, mpp, W)), W, rim) : null;
    if (pilot) {
      ctx.fillStyle = 'rgba(6, 10, 20, 0.85)';
      ctx.strokeStyle = '#eaf6ff';
      ctx.lineWidth = 1.6 * u;
      ctx.beginPath();
      ctx.arc(pilot.x, pilot.y, 4.6 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#eaf6ff';
      ctx.beginPath();
      ctx.arc(pilot.x, pilot.y, 1.8 * u, 0, Math.PI * 2);
      ctx.fill();
    }
    if (f.ring) {
      const p = clampToDisc(...xy(worldToMap(f.ring.x - this.cx, f.ring.z - this.cz, mpp, W)), W, rim);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.shadowColor = '#ff3de8';
      ctx.shadowBlur = 6 * u;
      ctx.fillStyle = '#ff3de8';
      ctx.strokeStyle = '#ffe6fb';
      ctx.lineWidth = 1.2 * u;
      if (p.pinned) {
        // a chevron on the rim pointing out, toward the ring
        ctx.rotate(Math.atan2(p.y - W / 2, p.x - W / 2) + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, -6 * u);
        ctx.lineTo(5 * u, 3 * u);
        ctx.lineTo(-5 * u, 3 * u);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.moveTo(0, -5.5 * u);
        ctx.lineTo(5.5 * u, 0);
        ctx.lineTo(0, 5.5 * u);
        ctx.lineTo(-5.5 * u, 0);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    const me = worldToMap(ox, oz, mpp, W);
    ctx.save();
    ctx.translate(me.x, me.y);
    ctx.rotate((wrap180(f.heading) * Math.PI) / 180);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4 * u;
    ctx.fillStyle = '#28e7ff';
    ctx.strokeStyle = '#04121a';
    ctx.lineWidth = 1.4 * u;
    ctx.beginPath();
    ctx.moveTo(0, -8 * u);
    ctx.lineTo(5.5 * u, 6 * u);
    ctx.lineTo(0, 3.2 * u);
    ctx.lineTo(-5.5 * u, 6 * u);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Keeps the cells within two map widths of the drone. */
  private evict(x: number, z: number): void {
    const ix = Math.floor(x / MAP_CELL_M) + KEY_OFFSET;
    const iz = Math.floor(z / MAP_CELL_M) + KEY_OFFSET;
    const r = MAP_CELLS * 2;
    for (const key of this.cache.keys()) {
      const kx = Math.floor(key / 65536);
      const kz = key % 65536;
      if (Math.abs(kx - ix) > r || Math.abs(kz - iz) > r) this.cache.delete(key);
    }
  }
}

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y];
