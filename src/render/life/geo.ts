/**
 * Tiny flat-shaded mesh builder for the living world's low-poly models (vehicles, signals, animals, turbines):
 * triangles with a face normal, an sRGB vertex colour (linearised by the instanced shader) and a `uv` that carries
 * a part id (uv.x) and a free value (uv.y: e.g. how much a vertex sways or spins). Non-indexed output, the layout
 * InstanceLayer copies (position, normal, color, uv).
 */
import * as THREE from 'three';

export type V3 = readonly [number, number, number];

export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** One triangle (counter-clockwise seen from the front), flat normal. */
  tri(a: V3, b: V3, c: V3, hex: number, part = 0, extra = 0, extraB = extra, extraC = extra): this {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-12) return this;
    nx /= l;
    ny /= l;
    nz /= l;
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const bl = (hex & 255) / 255;
    const ex = [extra, extraB, extraC];
    [a, b, c].forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(r, g, bl);
      this.uv.push(part, ex[i]!);
    });
    return this;
  }

  quad(a: V3, b: V3, c: V3, d: V3, hex: number, part = 0, extra = 0): this {
    return this.tri(a, b, c, hex, part, extra).tri(a, c, d, hex, part, extra);
  }

  /** Axis-aligned box centred at (x, y, z); `skipBottom` drops the face nobody sees. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, hex: number, part = 0, extra = 0, skipBottom = true): this {
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2, z0 = z - d / 2, z1 = z + d / 2;
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], hex, part, extra); // top
    if (!skipBottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], hex, part, extra);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], hex, part, extra); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], hex, part, extra); // −z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], hex, part, extra); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], hex, part, extra); // −x
    return this;
  }

  /** Cylinder along X (wheels), centre (x, y, z), `sides` facets; caps in `capHex`. */
  cylinderX(x: number, y: number, z: number, r: number, w: number, sides: number, hex: number, capHex: number, part = 0, extra = 0): this {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const y0 = y + Math.cos(a0) * r, z0 = z + Math.sin(a0) * r;
      const y1 = y + Math.cos(a1) * r, z1 = z + Math.sin(a1) * r;
      this.quad([x0, y0, z0], [x0, y1, z1], [x1, y1, z1], [x1, y0, z0], hex, part, extra);
      this.tri([x1, y, z], [x1, y0, z0], [x1, y1, z1], capHex, part, extra);
      this.tri([x0, y, z], [x0, y1, z1], [x0, y0, z0], capHex, part, extra);
    }
    return this;
  }

  /** Vertical cylinder (poles, tanks) from y0 to y1, open bottom. */
  cylinderY(x: number, z: number, r: number, y0: number, y1: number, sides: number, hex: number, part = 0, extra = 0, extraTop = extra, cap = true): this {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const p0x = x + Math.cos(a0) * r, p0z = z + Math.sin(a0) * r;
      const p1x = x + Math.cos(a1) * r, p1z = z + Math.sin(a1) * r;
      this.tri([p0x, y0, p0z], [p1x, y1, p1z], [p1x, y0, p1z], hex, part, extra, extraTop, extra);
      this.tri([p0x, y0, p0z], [p0x, y1, p0z], [p1x, y1, p1z], hex, part, extra, extraTop, extraTop);
      if (cap) this.tri([x, y1, z], [p1x, y1, p1z], [p0x, y1, p0z], hex, part, extraTop);
    }
    return this;
  }

  /**
   * Side profile (z, y pairs, counter-clockwise seen from +X) extruded across x = ±half; above `belt` the sides
   * lean in by `inset` at `top` (tumblehome). `edgePart(i)` gives each profile edge's part / colour; `capHex` /
   * `capPart` the two side faces (fan-triangulated: the profile must be convex).
   */
  extrude(
    profile: readonly (readonly [number, number])[],
    half: number,
    o: { belt?: number; top?: number; inset?: number; edge: (i: number) => [number, number]; cap: [number, number]; skipEdges?: readonly number[] },
  ): this {
    const belt = o.belt ?? Infinity;
    const top = o.top ?? belt + 1;
    const inset = o.inset ?? 0;
    const hw = (y: number): number => (inset === 0 || !Number.isFinite(belt) ? half : half - inset * Math.min(1, Math.max(0, (y - belt) / Math.max(1e-6, top - belt))));
    const n = profile.length;
    for (let i = 0; i < n; i++) {
      if (o.skipEdges?.includes(i)) continue;
      const [z0, y0] = profile[i]!;
      const [z1, y1] = profile[(i + 1) % n]!;
      const [hex, part] = o.edge(i);
      const a: V3 = [hw(y0), y0, z0];
      const b: V3 = [hw(y1), y1, z1];
      const c: V3 = [-hw(y1), y1, z1];
      const d: V3 = [-hw(y0), y0, z0];
      // outward: the profile runs counter-clockwise seen from +X
      this.quad(d, c, b, a, hex, part);
    }
    const [capHex, capPart] = o.cap;
    for (let i = 1; i < n - 1; i++) {
      const p0 = profile[0]!, p1 = profile[i]!, p2 = profile[i + 1]!;
      this.tri([hw(p0[1]), p0[1], p0[0]], [hw(p1[1]), p1[1], p1[0]], [hw(p2[1]), p2[1], p2[0]], capHex, capPart);
      this.tri([-hw(p0[1]), p0[1], p0[0]], [-hw(p2[1]), p2[1], p2[0]], [-hw(p1[1]), p1[1], p1[0]], capHex, capPart);
    }
    return this;
  }

  /** Appends another builder's triangles transformed by `m`. */
  append(other: GeoBuilder, m?: THREE.Matrix4): this {
    const v = new THREE.Vector3();
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    for (let i = 0; i < other.pos.length; i += 3) {
      v.set(other.pos[i]!, other.pos[i + 1]!, other.pos[i + 2]!);
      if (m) v.applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      v.set(other.nor[i]!, other.nor[i + 1]!, other.nor[i + 2]!);
      if (nm) v.applyMatrix3(nm).normalize();
      this.nor.push(v.x, v.y, v.z);
      this.col.push(other.col[i]!, other.col[i + 1]!, other.col[i + 2]!);
    }
    this.uv.push(...other.uv);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}
