/**
 * Loft prop builders by PropDef.kind. Every builder stays inside the prop's collider volume
 * (box props: footprint size centred on position, bottom at position.y), so what the pilot sees
 * is what the drone can hit; only hair-thin cords and flat decals go outside. Static parts are merged
 * per material; the fan (two meshes) and the TV screen stay live.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PropDef } from '../types';
import { StaticBatcher, type AddOptions } from './batcher';
import { DECAL, decalRect } from './env-materials/loft-canvas';
import { WOOD, type LoftMaterials } from './env-materials/loft-materials';
import { decalPlane, finish } from './loft/dress';
import { mulberry32 } from './textures';

/** Matches physics-world fan kinematics: 4 blades along local +X at k·π/2, hub r 0.12, tip r 0.9. */
const FAN_BLADES = 4;
const FAN_HUB_R = 0.12;
const FAN_BLADE_W = 0.14;

export interface LiveProps {
  fan: THREE.Group | null;
  tvScreen: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null;
  disposables: { dispose(): void }[];
  /** world positions of exposed lamps (filament centres) for halos */
  lamps: { position: THREE.Vector3; size: number; color: THREE.Color }[];
}

class PropFrame {
  private readonly base = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly out = new THREE.Matrix4();

  constructor(private readonly batch: StaticBatcher) {}

  set(prop: PropDef): this {
    this.e.set(0, prop.yaw ?? 0, 0);
    this.q.setFromEuler(this.e);
    this.p.set(prop.position[0], prop.position[1], prop.position[2]);
    this.s.set(1, 1, 1);
    this.base.compose(this.p, this.q, this.s);
    return this;
  }

  /** place geometry at local (x,y,z) with euler (rx,ry,rz) and scale. */
  add(key: string, mat: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, opts: AddOptions = {}, sx = 1, sy = 1, sz = 1): void {
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.p.set(x, y, z);
    this.s.set(sx, sy, sz);
    this.local.compose(this.p, this.q, this.s);
    this.out.multiplyMatrices(this.base, this.local);
    this.batch.add(key, mat, g, this.out, opts);
  }

  /** local → world point */
  world(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(x, y, z).applyMatrix4(this.base);
  }
}

export function buildProps(props: readonly PropDef[], mats: LoftMaterials, batch: StaticBatcher, root: THREE.Object3D): LiveProps {
  const live: LiveProps = { fan: null, tvScreen: null, disposables: [], lamps: [] };
  const f = new PropFrame(batch);
  const rnd = mulberry32(1234);
  let bulbIndex = 0;
  let crateIndex = 0;
  for (const p of props) {
    f.set(p);
    const [w, h, d] = p.size;
    switch (p.kind) {
      case 'pillar':
        pillar(f, mats, w / 2, h);
        break;
      case 'beam':
        beam(f, mats, w, h, d);
        break;
      case 'duct':
        duct(f, mats, w, h, d, p.position[1]);
        break;
      case 'sofa':
        sofa(f, mats, w, h, d);
        break;
      case 'table':
        table(f, mats, w, h, d);
        break;
      case 'rug':
        rug(f, mats, w, Math.max(h, 0.008), d);
        break;
      case 'tv-wall':
        live.tvScreen = tv(f, mats, p, w, h, d, root);
        live.disposables.push(live.tvScreen.geometry, live.tvScreen.material);
        break;
      case 'plant':
        plant(f, mats, w, h, rnd);
        break;
      case 'shelf':
        shelf(f, mats, w, h, d, rnd);
        break;
      case 'crate':
        crate(f, mats, w, h, d, crateIndex++);
        break;
      case 'lamp-floor':
        floorLamp(f, mats, h);
        live.lamps.push({ position: f.world(0, h - 0.19, 0), size: 0.55, color: new THREE.Color(1, 0.62, 0.32) });
        break;
      case 'bulb-hanging':
        bulb(f, mats, h, bulbIndex++);
        live.lamps.push({ position: f.world(0, 0.06, 0), size: 0.42, color: new THREE.Color(1, 0.58, 0.26) });
        break;
      case 'fan':
        live.fan = fan(f, mats, p, root, live);
        break;
    }
  }
  return live;
}

function pillar(f: PropFrame, m: LoftMaterials, r: number, h: number): void {
  f.add('concrete', m.concrete, new THREE.CylinderGeometry(r - 0.004, r - 0.004, h, 32, 1), 0, h / 2, 0, 0, 0, 0, { uvTile: 1.4 });
  const steel = finish('steelDark');
  for (const y of [0.42, h - 0.55]) f.add('props', m.props, new THREE.CylinderGeometry(r, r, 0.07, 32, 1, true), 0, y, 0, 0, 0, 0, steel);
  f.add('props', m.props, new THREE.CylinderGeometry(r * 0.98, r, 0.1, 32), 0, 0.05, 0, 0, 0, 0, steel);
  // hazard-tape wrap at knee height
  const tape = new THREE.CylinderGeometry(r - 0.001, r - 0.001, 0.12, 32, 1, true);
  const [u0, v0, u1, v1] = decalRect(DECAL.hazardTape);
  const uv = tape.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * (0.43 + 0.14 * uv.getY(i)));
  f.add('decals', m.decals, tape, 0, 0.75, 0, 0, 0, 0, { castShadow: false });
}

/** Riveted I-beam: flanges, web, stiffeners, bolted splice plates, hangers to the deck. */
function beam(f: PropFrame, m: LoftMaterials, w: number, h: number, len: number): void {
  const fl = 0.035;
  const paint = finish('steelPaint');
  f.add('props', m.props, new THREE.BoxGeometry(w, fl, len), 0, fl / 2, 0, 0, 0, 0, paint);
  f.add('props', m.props, new THREE.BoxGeometry(w, fl, len), 0, h - fl / 2, 0, 0, 0, 0, paint);
  f.add('props', m.props, new THREE.BoxGeometry(0.022, h - fl * 2, len), 0, h / 2, 0, 0, 0, 0, paint);
  for (let z = -len / 2 + 0.9; z < len / 2; z += 1.75) {
    for (const s of [-1, 1]) f.add('props', m.props, new THREE.BoxGeometry(w * 0.42, h - fl * 2, 0.016), s * (w * 0.22 + 0.011), h / 2, z, 0, 0, 0, paint);
  }
  // rivet heads on the inner faces of both flanges, two rows each side of the web
  const rivet = () => new THREE.SphereGeometry(0.009, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
  for (let z = -len / 2 + 0.08; z < len / 2; z += 0.16) {
    for (const s of [-1, 1]) {
      const x = s * w * 0.3;
      f.add('props', m.props, rivet(), x, fl, z, 0, 0, 0, paint);
      f.add('props', m.props, rivet(), x, h - fl, z, Math.PI, 0, 0, paint);
    }
  }
  // splice plates with a 3 × 2 bolt group on both faces of the web
  const steel = finish('steelBlack');
  for (const z of [-len / 4, len / 4]) {
    for (const s of [-1, 1]) {
      f.add('props', m.props, new THREE.BoxGeometry(0.012, h - fl * 2 - 0.04, 0.34), s * 0.017, h / 2, z, 0, 0, 0, paint);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j += 2) {
        f.add('props', m.props, new THREE.CylinderGeometry(0.014, 0.014, 0.014, 6), s * 0.03, h / 2 + j * 0.09, z + i * 0.1, 0, 0, Math.PI / 2, steel);
      }
    }
  }
  for (let z = -len / 2 + 1; z < len / 2; z += 3) {
    f.add('props', m.props, new THREE.BoxGeometry(0.06, 0.15, 0.06), 0, h + 0.075, z, 0, 0, 0, steel);
    f.add('props', m.props, new THREE.BoxGeometry(0.16, 0.012, 0.12), 0, h + 0.006, z, 0, 0, 0, steel);
  }
}

/** Spiral-seam round duct inside the duct's box collider, with couplings, strap hangers and diffusers. */
function duct(f: PropFrame, m: LoftMaterials, len: number, h: number, d: number, baseY: number): void {
  const r = Math.min(h, d) / 2 - 0.02;
  const galv = finish('galvanized');
  const body = new THREE.CylinderGeometry(r, r, len - 0.04, 28, 1, true);
  f.add('props', m.props, body, 0, h / 2, 0, 0, 0, Math.PI / 2, galv);
  // spiral lock seam
  const turns = Math.floor(len / 0.32);
  const pts: THREE.Vector3[] = [];
  const steps = turns * 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(-len / 2 + 0.05 + t * (len - 0.1), h / 2 + Math.cos(a) * (r + 0.002), Math.sin(a) * (r + 0.002)));
  }
  f.add('props', m.props, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps, 0.004, 3, false), 0, 0, 0, 0, 0, 0, galv);
  for (let x = -len / 2 + 0.6; x <= len / 2 - 0.5; x += 2.4) {
    f.add('props', m.props, new THREE.CylinderGeometry(r + 0.008, r + 0.008, 0.05, 28, 1, true), x, h / 2, 0, 0, 0, Math.PI / 2, galv);
  }
  for (const s of [-1, 1]) f.add('props', m.props, new THREE.CircleGeometry(r, 28), s * (len / 2 - 0.02), h / 2, 0, 0, s * Math.PI / 2, 0, galv);
  const steel = finish('steelBlack');
  const rodLen = 6 - (baseY + h);
  for (let x = -len / 2 + 1.5; x < len / 2; x += 3.5) {
    f.add('props', m.props, new THREE.TorusGeometry(r + 0.006, 0.006, 4, 24, Math.PI), x, h / 2, 0, 0, Math.PI / 2, Math.PI, steel);
    for (const z of [-r - 0.006, r + 0.006]) {
      f.add('props', m.props, new THREE.CylinderGeometry(0.006, 0.006, rodLen + h / 2, 5), x, h / 2 + (rodLen + h / 2) / 2, z, 0, 0, 0, steel);
    }
  }
  for (const x of [-len / 2 + 3.2, -1.2, len / 2 - 4.5]) {
    f.add('props', m.props, new THREE.CylinderGeometry(0.1, 0.12, 0.05, 20), x, 0.045, 0, 0, 0, 0, galv);
    f.add('props', m.props, new THREE.CylinderGeometry(0.085, 0.085, 0.006, 20), x, 0.019, 0, 0, 0, 0, finish('rubber'));
  }
}

function sofa(f: PropFrame, m: LoftMaterials, w: number, h: number, d: number): void {
  const legH = 0.1;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.add('wood', m.wood, new THREE.CylinderGeometry(0.025, 0.018, legH, 10), sx * (w / 2 - 0.1), legH / 2, sz * (d / 2 - 0.1), 0, 0, 0, { color: WOOD.walnut });
  }
  const armW = 0.2;
  f.add('leather', m.leather, new RoundedBoxGeometry(w, 0.26, d, 3, 0.04), 0, legH + 0.13, 0, 0, 0, 0, { uvTile: 0.3 });
  const backH = h - legH - 0.2;
  f.add('leather', m.leather, new RoundedBoxGeometry(w - armW * 2 + 0.02, backH, 0.2, 3, 0.05), 0, legH + 0.2 + backH / 2, -d / 2 + 0.1, 0, 0, 0, { uvTile: 0.3 });
  // rolled arms: a block topped by a bolster
  for (const sx of [-1, 1]) {
    f.add('leather', m.leather, new RoundedBoxGeometry(armW, 0.5 - legH, d, 3, 0.05), sx * (w / 2 - armW / 2), legH + (0.5 - legH) / 2, 0, 0, 0, 0, { uvTile: 0.3 });
    f.add('leather', m.leather, new THREE.CylinderGeometry(0.1, 0.1, d - 0.02, 18), sx * (w / 2 - armW / 2), 0.52, 0, Math.PI / 2, 0, 0, { uvTile: 0.3 });
  }
  const cw = (w - armW * 2) / 3;
  for (let i = 0; i < 3; i++) {
    const x = -w / 2 + armW + cw * (i + 0.5);
    f.add('leather', m.leather, new RoundedBoxGeometry(cw - 0.015, 0.14, d - 0.24, 3, 0.05), x, legH + 0.26 + 0.07, 0.1, 0, 0, 0, { uvTile: 0.3 });
    f.add('leather', m.leather, new RoundedBoxGeometry(cw - 0.02, 0.36, 0.14, 3, 0.06), x, legH + 0.4 + 0.18, -d / 2 + 0.24, -0.16, 0, 0, { uvTile: 0.3 });
    // tufting buttons on the back cushions
    for (const bx of [-0.18, 0, 0.18]) for (const by of [0.06, 0.2]) {
      f.add('leather', m.leather, new THREE.SphereGeometry(0.014, 8, 6), x + bx, legH + 0.4 + by + 0.05, -d / 2 + 0.315 - by * 0.16, 0, 0, 0, { uvTile: 0.3 });
    }
  }
  f.add('fabric', m.fabric, new RoundedBoxGeometry(0.4, 0.36, 0.12, 3, 0.05), -w / 2 + armW + 0.28, legH + 0.58, -d / 2 + 0.36, -0.3, 0.25, 0.05, { uvTile: 0.12 });
  f.add('fabric', m.fabric, new RoundedBoxGeometry(0.4, 0.36, 0.12, 3, 0.05), w / 2 - armW - 0.28, legH + 0.58, -d / 2 + 0.36, -0.3, -0.25, -0.05, { uvTile: 0.12 });
  // knitted throw folded over the right arm
  f.add('fabric', m.fabric, new RoundedBoxGeometry(0.24, 0.05, d * 0.7, 2, 0.02), w / 2 - armW / 2, 0.635, 0.05, 0, 0, 0.1, { uvTile: 0.12 });
  f.add('fabric', m.fabric, new RoundedBoxGeometry(0.03, 0.3, d * 0.7, 2, 0.012), w / 2 - 0.015, 0.47, 0.05, 0, 0, 0, { uvTile: 0.12 });
}

function table(f: PropFrame, m: LoftMaterials, w: number, h: number, d: number): void {
  const top = 0.045;
  f.add('wood', m.wood, new RoundedBoxGeometry(w, top, d, 2, 0.01), 0, h - top / 2, 0, 0, 0, 0, { color: WOOD.oak, uvTile: 0.9 });
  f.add('wood', m.wood, new THREE.BoxGeometry(w - 0.12, 0.02, d - 0.12), 0, 0.12, 0, 0, 0, 0, { color: WOOD.oak, uvTile: 0.9 });
  const steel = finish('steelBlack');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.08);
    const z = sz * (d / 2 - 0.08);
    f.add('props', m.props, new THREE.CylinderGeometry(0.008, 0.008, h - top, 6), x, (h - top) / 2, z, sz * 0.06, 0, -sx * 0.06, steel);
    f.add('props', m.props, new THREE.CylinderGeometry(0.008, 0.008, h - top, 6), x * 0.9, (h - top) / 2, z, sz * 0.06, 0, sx * 0.04, steel);
  }
  const books = [0x2d4a7a, 0xc9a24a, 0x8a2f2f];
  books.forEach((c, i) => {
    f.add('props', m.props, new THREE.BoxGeometry(0.24, 0.035, 0.17), -0.35, h + 0.0175 + i * 0.035, -0.05, 0, i * 0.2 - 0.2, 0, { color: c, rm: [0.7, 0] });
    f.add('props', m.props, new THREE.BoxGeometry(0.235, 0.028, 0.165), -0.352, h + 0.0175 + i * 0.035, -0.045, 0, i * 0.2 - 0.2, 0, finish('paper'));
  });
  f.add('props', m.props, new THREE.CylinderGeometry(0.04, 0.036, 0.1, 18), 0.1, h + 0.05, 0.12, 0, 0, 0, finish('ceramic'));
  f.add('props', m.props, new THREE.TorusGeometry(0.025, 0.006, 6, 12, Math.PI), 0.14, h + 0.05, 0.12, 0, 0, -Math.PI / 2, finish('ceramic'));
  // radio transmitter with gimbals and an antenna
  const tx = finish('plasticDark');
  f.add('props', m.props, new RoundedBoxGeometry(0.2, 0.05, 0.13, 2, 0.015), 0.32, h + 0.025, -0.06, 0, -0.4, 0, tx);
  for (const sx of [-0.05, 0.05]) f.add('props', m.props, new THREE.CylinderGeometry(0.006, 0.006, 0.04, 6), 0.32 + sx, h + 0.07, -0.06, 0, 0, 0, finish('steelBlack'));
  f.add('props', m.props, new THREE.CylinderGeometry(0.004, 0.006, 0.16, 6), 0.4, h + 0.12, -0.12, 0.5, 0, 0.2, finish('rubber'));
  // a spare 4S pack
  f.add('props', m.props, new THREE.BoxGeometry(0.07, 0.035, 0.035), -0.05, h + 0.0175, 0.18, 0, 0.6, 0, { color: 0xe8b81c, rm: [0.4, 0] });
}

function rug(f: PropFrame, m: LoftMaterials, w: number, h: number, d: number): void {
  f.add('rug', m.rug, new THREE.BoxGeometry(w, h, d), 0, h / 2, 0, 0, 0, 0, { castShadow: false });
  const fr = finish('paper');
  const strands = Math.round(d / 0.035);
  for (const s of [-1, 1]) {
    for (let i = 0; i < strands; i++) {
      const z = -d / 2 + (i + 0.5) * (d / strands);
      f.add('props', m.props, new THREE.BoxGeometry(0.09, 0.003, 0.008), s * (w / 2 + 0.04), 0.0015, z, 0, (Math.sin(i * 12.9) * 0.25), 0, fr);
    }
  }
}

function tv(f: PropFrame, m: LoftMaterials, p: PropDef, w: number, h: number, d: number, root: THREE.Object3D): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  f.add('props', m.props, new RoundedBoxGeometry(w, h, d, 2, 0.01), 0, h / 2, 0, 0, 0, 0, finish('bezel'));
  const g = new THREE.PlaneGeometry(w - 0.06, h - 0.06);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform float uTime;
      void main(){
        vec2 uv = vUv;
        float t = uTime * 0.25;
        vec3 a = vec3(0.05,0.55,0.95), b = vec3(0.95,0.18,0.75), c = vec3(1.0,0.55,0.15);
        float w1 = sin(uv.x*3.0 + t*2.0 + sin(uv.y*4.0 + t)) * 0.5 + 0.5;
        float w2 = sin(uv.y*5.0 - t*3.0 + uv.x*2.0) * 0.5 + 0.5;
        vec3 col = mix(mix(a, b, w1), c, w2 * 0.35);
        // stylised gate tunnel
        vec2 q = (uv - vec2(0.5, 0.45)) * vec2(1.76, 1.0);
        float r = length(q);
        float rings = smoothstep(0.02, 0.0, abs(fract(log(r + 0.02) * 1.5 - uTime * 0.6) - 0.5) - 0.44);
        col += rings * vec3(0.4, 1.0, 1.2) * smoothstep(0.9, 0.1, r);
        col *= 0.55 + 0.45 * smoothstep(0.0, 0.05, uv.y);
        col *= 0.92 + 0.08 * sin(uv.y * 400.0);
        // HUD bar
        col = mix(col, vec3(0.02,0.03,0.05), step(uv.y, 0.12) * 0.7);
        col += vec3(1.0,0.2,0.25) * step(0.03, uv.x) * step(uv.x, 0.12) * step(0.04, uv.y) * step(uv.y, 0.08) * (0.6 + 0.4 * step(0.5, fract(uTime)));
        gl_FragColor = vec4(col * 0.45, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const screen = new THREE.Mesh(g, mat);
  const yaw = p.yaw ?? 0;
  screen.position.set(p.position[0] + Math.sin(yaw) * (d / 2 + 0.002), p.position[1] + h / 2, p.position[2] + Math.cos(yaw) * (d / 2 + 0.002));
  screen.rotation.y = yaw;
  screen.name = 'tv-screen';
  root.add(screen);
  // power cable dropping to the skirting, flush on the wall behind
  f.add('props', m.props, new THREE.CylinderGeometry(0.004, 0.004, p.position[1] + 0.05, 5), w * 0.3, -(p.position[1] - 0.05) / 2, -d / 2 + 0.005, 0, 0, 0, finish('rubber'));
  return screen;
}

/** Leaf blade with UVs across its own extent (for the vein texture), bent along its length. */
function leafGeometry(len = 0.32, width = 0.1): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(width * 0.9, len * 0.15, width, len * 0.68, 0, len);
  s.bezierCurveTo(-width, len * 0.68, -width * 0.9, len * 0.15, 0, 0);
  const g = new THREE.ShapeGeometry(s, 8);
  const pos = g.attributes.position;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    uv.setXY(i, x / (width * 2.2) + 0.5, y / len);
    pos.setZ(i, (y / len) * (y / len) * len * 0.8 - Math.abs(x) * 0.3);
  }
  g.computeVertexNormals();
  return g;
}

/** Fiddle-leaf fig in a terracotta pot; leaves stay inside the w × h footprint. */
function plant(f: PropFrame, m: LoftMaterials, w: number, h: number, rnd: () => number): void {
  const potH = 0.4;
  f.add('props', m.props, new THREE.CylinderGeometry(0.2, 0.15, potH, 24), 0, potH / 2, 0, 0, 0, 0, finish('terracotta'));
  f.add('props', m.props, new THREE.TorusGeometry(0.2, 0.015, 6, 24), 0, potH - 0.01, 0, Math.PI / 2, 0, 0, finish('terracotta'));
  f.add('props', m.props, new THREE.CylinderGeometry(0.19, 0.19, 0.02, 20), 0, potH - 0.03, 0, 0, 0, 0, finish('soil'));
  const stems = 3;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rnd() * 0.5;
    const top = h - 0.05 - rnd() * 0.25;
    const lean = 0.05 + rnd() * 0.04;
    const len = top - potH;
    f.add('wood', m.wood, new THREE.CylinderGeometry(0.01, 0.016, len, 6), Math.cos(a) * lean * 0.5, potH + len / 2, Math.sin(a) * lean * 0.5, Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12, { color: 0x6b5a44 });
    const leaves = 6 + Math.floor(rnd() * 3);
    for (let k = 0; k < leaves; k++) {
      const t = 0.3 + (k / leaves) * 0.7;
      const ly = potH + t * len;
      const la = a + k * 2.4 + rnd() * 0.4;
      const r = Math.min(w / 2 - 0.2, lean * t + 0.02);
      const s = 0.75 + (1 - t) * 0.5 + rnd() * 0.2;
      f.add('leaf', m.leaf, leafGeometry(0.24, 0.1), Math.cos(la) * r, ly, Math.sin(la) * r, 0.65 + rnd() * 0.5, -la + Math.PI / 2, (rnd() - 0.5) * 0.4, {}, s, s, s);
    }
  }
}

function shelf(f: PropFrame, m: LoftMaterials, w: number, h: number, d: number, rnd: () => number): void {
  const pipe = finish('steelBlack');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.add('props', m.props, new THREE.CylinderGeometry(0.016, 0.016, h, 10), sx * (w / 2 - 0.03), h / 2, sz * (d / 2 - 0.03), 0, 0, 0, pipe);
    f.add('props', m.props, new THREE.CylinderGeometry(0.035, 0.035, 0.012, 12), sx * (w / 2 - 0.03), 0.006, sz * (d / 2 - 0.03), 0, 0, 0, pipe);
  }
  const levels = [0.1, 0.62, 1.14, 1.66, h - 0.025];
  for (const y of levels) {
    f.add('wood', m.wood, new THREE.BoxGeometry(w - 0.01, 0.035, d - 0.01), 0, y - 0.0175, 0, 0, 0, 0, { color: WOOD.oak, uvTile: 0.9 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      f.add('props', m.props, new THREE.CylinderGeometry(0.022, 0.022, 0.05, 10), sx * (w / 2 - 0.03), y - 0.0175, sz * (d / 2 - 0.03), 0, 0, 0, pipe);
    }
  }
  const bookCols = [0x8a2f2f, 0x2d4a7a, 0xc9a24a, 0x3d6b4a, 0xd8d0c0, 0x5a3d6b, 0x1f1f22, 0xb4552d, 0x6d7f8c];
  for (let li = 0; li < levels.length - 1; li++) {
    const y0 = levels[li]!;
    const clear = levels[li + 1]! - y0 - 0.06;
    let x = -w / 2 + 0.08;
    while (x < w / 2 - 0.12) {
      const pick = rnd();
      if (pick < 0.45) {
        const n = 4 + Math.floor(rnd() * 9);
        for (let k = 0; k < n && x < w / 2 - 0.08; k++) {
          const bw = 0.022 + rnd() * 0.022;
          const bh = Math.min(clear, 0.19 + rnd() * 0.13);
          const bd = 0.15 + rnd() * 0.07;
          const lean = k === n - 1 && rnd() < 0.4 ? 0.18 : 0;
          const c = bookCols[Math.floor(rnd() * bookCols.length)]!;
          f.add('props', m.props, new THREE.BoxGeometry(bw, bh, bd), x + bw / 2, y0 + bh / 2, 0.02, 0, 0, -lean, { color: c, rm: [0.55 + rnd() * 0.3, 0] });
          x += bw + 0.002;
        }
        x += 0.05;
      } else if (pick < 0.68) {
        const bw = 0.22 + rnd() * 0.16;
        const bh = Math.min(clear, 0.15 + rnd() * 0.2);
        const bd = Math.min(d - 0.08, 0.25 + rnd() * 0.1);
        f.add('props', m.props, new THREE.BoxGeometry(bw, bh, bd), x + bw / 2, y0 + bh / 2, 0, 0, (rnd() - 0.5) * 0.15, 0, rnd() < 0.6 ? finish('cardboard') : finish('plasticDark'));
        x += bw + 0.04;
      } else if (pick < 0.8) {
        const r = 0.04 + rnd() * 0.035;
        const jh = Math.min(clear, 0.1 + rnd() * 0.14);
        f.add('props', m.props, new THREE.CylinderGeometry(r, r * 0.9, jh, 16), x + r, y0 + jh / 2, 0.04, 0, 0, 0, finish('ceramic'));
        x += r * 2 + 0.05;
      } else if (pick < 0.9) {
        // spare quad props, battery packs
        f.add('props', m.props, new THREE.BoxGeometry(0.075, 0.035, 0.035), x + 0.04, y0 + 0.0175, 0.02, 0, rnd(), 0, { color: 0xe8b81c, rm: [0.4, 0] });
        f.add('props', m.props, new THREE.BoxGeometry(0.075, 0.035, 0.035), x + 0.05, y0 + 0.0525, 0.03, 0, rnd(), 0, { color: 0xd8182f, rm: [0.4, 0] });
        x += 0.13;
      } else {
        f.add('props', m.props, new THREE.CylinderGeometry(0.06, 0.05, 0.1, 12), x + 0.06, y0 + 0.05, 0, 0, 0, 0, finish('terracotta'));
        for (let k = 0; k < 5; k++) {
          const a = k * 1.3;
          f.add('leaf', m.leaf, leafGeometry(0.11, 0.045), x + 0.06 + Math.cos(a) * 0.02, y0 + 0.1, Math.sin(a) * 0.02, 0.7, -a + Math.PI / 2, 0);
        }
        x += 0.16;
      }
    }
  }
}

function crate(f: PropFrame, m: LoftMaterials, w: number, h: number, d: number, index: number): void {
  const t = 0.05;
  const wood = { uvTile: 0.8, color: WOOD.crate };
  const frame = { uvTile: 0.8, color: WOOD.walnut };
  f.add('wood', m.wood, new THREE.BoxGeometry(w - 0.02, h - 0.02, d - 0.02), 0, h / 2, 0, 0, 0, 0, wood);
  for (const sy of [t / 2, h - t / 2]) {
    for (const sz of [-1, 1]) f.add('wood', m.wood, new THREE.BoxGeometry(w, t, t * 0.6), 0, sy, sz * (d / 2 - t * 0.3), 0, 0, 0, frame);
    for (const sx of [-1, 1]) f.add('wood', m.wood, new THREE.BoxGeometry(t * 0.6, t, d), sx * (w / 2 - t * 0.3), sy, 0, 0, 0, 0, frame);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.add('wood', m.wood, new THREE.BoxGeometry(t * 0.6, h, t * 0.6), sx * (w / 2 - t * 0.3), h / 2, sz * (d / 2 - t * 0.3), 0, 0, 0, frame);
  }
  const diag = Math.hypot(w - t, h - t);
  const ang = Math.atan2(h - t, w - t);
  for (const sz of [-1, 1]) f.add('wood', m.wood, new THREE.BoxGeometry(diag - 0.05, t * 0.8, t * 0.4), 0, h / 2, sz * (d / 2 - t * 0.2), 0, 0, ang * sz, frame);
  for (const sx of [-1, 1]) f.add('wood', m.wood, new THREE.BoxGeometry(t * 0.4, t * 0.8, diag - 0.05), sx * (w / 2 - t * 0.2), h / 2, 0, ang * sx, 0, 0, frame);
  // stencil on the front panel, between the frame boards
  const cell = index % 2 === 0 ? DECAL.fragile : DECAL.droneParts;
  f.add('decals', m.decals, decalPlane(cell, w * 0.7, h * 0.7, [0, 0.2, 1, 0.8]), 0, h / 2, d / 2 - 0.008, 0, 0, 0, { castShadow: false });
}

function floorLamp(f: PropFrame, m: LoftMaterials, h: number): void {
  const hub = 1.05;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const r = 0.18;
    const len = Math.hypot(r, hub);
    const tilt = Math.atan2(r, hub);
    f.add('wood', m.wood, new THREE.CylinderGeometry(0.012, 0.015, len, 8), Math.cos(a) * r * 0.5, hub / 2, Math.sin(a) * r * 0.5, Math.sin(a) * -tilt, 0, Math.cos(a) * tilt, { color: WOOD.walnut });
  }
  f.add('props', m.props, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), 0, hub, 0, 0, 0, 0, finish('brass'));
  f.add('props', m.props, new THREE.CylinderGeometry(0.009, 0.009, h - 0.3 - hub, 8), 0, hub + (h - 0.3 - hub) / 2, 0, 0, 0, 0, finish('brass'));
  const shadeH = 0.3;
  f.add('props', m.props, new THREE.CylinderGeometry(0.1, 0.2, shadeH, 32, 1, true), 0, h - shadeH / 2, 0, 0, 0, 0, finish('enamelGreen'));
  f.add('props', m.props, new THREE.TorusGeometry(0.2, 0.006, 6, 32), 0, h - shadeH, 0, Math.PI / 2, 0, 0, finish('brass'));
  f.add('glow', m.glow, new THREE.CylinderGeometry(0.098, 0.197, shadeH - 0.01, 32, 1, true), 0, h - shadeH / 2, 0, 0, 0, 0, { color: [2.4, 1.5, 0.75], castShadow: false });
  f.add('glow', m.glow, new THREE.SphereGeometry(0.045, 16, 12), 0, h - shadeH * 0.55, 0, 0, 0, 0, { color: [9, 5.4, 2.6], castShadow: false });
}

/** Edison bulb: hot filament, faint envelope, brass socket, cloth cord to a ceiling canopy; every other one caged. */
function bulb(f: PropFrame, m: LoftMaterials, cordLen: number, index: number): void {
  // collider box spans y -0.02..0.22 local, ±0.07 in x / z
  f.add('bulbShell', m.bulbShell, new THREE.SphereGeometry(0.052, 18, 14), 0, 0.055, 0, 0, 0, 0, { castShadow: false }, 1, 1.25, 1);
  const hot: AddOptions = { color: [14, 7.2, 2.6], castShadow: false };
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    f.add('glow', m.glow, new THREE.TorusGeometry(0.016, 0.0018, 4, 10, Math.PI), Math.cos(a) * 0.004, 0.06, Math.sin(a) * 0.004, 0, a, 0, hot);
  }
  f.add('glow', m.glow, new THREE.CylinderGeometry(0.003, 0.003, 0.05, 4), 0, 0.085, 0, 0, 0, 0, { color: [1.2, 0.7, 0.35], castShadow: false });
  f.add('props', m.props, new THREE.CylinderGeometry(0.024, 0.02, 0.07, 14), 0, 0.15, 0, 0, 0, 0, finish('brass'));
  f.add('props', m.props, new THREE.CylinderGeometry(0.016, 0.024, 0.03, 14), 0, 0.2, 0, 0, 0, 0, finish('brass'));
  if (index % 2 === 0) {
    const wire = finish('steelBlack');
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      f.add('props', m.props, new THREE.CylinderGeometry(0.0015, 0.0015, 0.17, 3), Math.cos(a) * 0.064, 0.085, Math.sin(a) * 0.064, 0, 0, 0, wire);
    }
    for (const y of [0.0, 0.08, 0.17]) f.add('props', m.props, new THREE.TorusGeometry(0.064, 0.0018, 3, 18), 0, y, 0, Math.PI / 2, 0, 0, wire);
  }
  f.add('props', m.props, new THREE.CylinderGeometry(0.0035, 0.0035, cordLen - 0.2, 5), 0, 0.2 + (cordLen - 0.2) / 2, 0, 0, 0, 0, finish('rubber'));
  f.add('props', m.props, new THREE.CylinderGeometry(0.05, 0.05, 0.025, 16), 0, cordLen - 0.0125, 0, 0, 0, 0, finish('steelBlack'));
}

/** Fan: static downrod + canopy merged into the room; the rotor is one rotating group of two merged meshes. */
function fan(f: PropFrame, m: LoftMaterials, p: PropDef, root: THREE.Object3D, live: LiveProps): THREE.Group {
  const [x, y, z] = p.position;
  const radius = p.size[0] / 2;
  const rodLen = 6 - (y + 0.14);
  f.add('props', m.props, new THREE.CylinderGeometry(0.018, 0.018, rodLen, 10), 0, 0.14 + rodLen / 2, 0, 0, 0, 0, finish('steelDark'));
  f.add('props', m.props, new THREE.CylinderGeometry(0.06, 0.09, 0.08, 20), 0, rodLen + 0.1, 0, 0, 0, 0, finish('steelDark'));
  const g = new THREE.Group();
  g.name = 'fan';
  g.position.set(x, y, z);
  const rotor = new StaticBatcher();
  const at = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const place = (key: string, mat: THREE.Material, geo: THREE.BufferGeometry, px: number, py: number, pz: number, yaw: number, pitch: number, opts: AddOptions) => {
    // blade frame: rotate about Y by the blade angle, then pitch about the blade's own axis (X)
    e.set(pitch, yaw, 0, 'YXZ');
    q.setFromEuler(e);
    const pos = new THREE.Vector3(px, py, pz).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    at.compose(pos, q, new THREE.Vector3(1, 1, 1));
    rotor.add(key, mat, geo, at, opts);
  };
  place('props', m.props, new THREE.CylinderGeometry(FAN_HUB_R, FAN_HUB_R * 0.8, 0.12, 28), 0, 0.05, 0, 0, 0, finish('steelDark'));
  place('props', m.props, new THREE.SphereGeometry(FAN_HUB_R * 0.5, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0, -0.01, 0, 0, 0, finish('brass'));
  const mid = (radius + FAN_HUB_R) / 2;
  for (let k = 0; k < FAN_BLADES; k++) {
    const a = (k * Math.PI * 2) / FAN_BLADES;
    place('wood', m.wood, new RoundedBoxGeometry(radius - FAN_HUB_R - 0.02, 0.014, FAN_BLADE_W, 2, 0.006), mid + 0.01, 0, 0, a, 0.12, { color: WOOD.walnut, uvTile: 0.6 });
    place('props', m.props, new THREE.BoxGeometry(0.16, 0.012, 0.04), FAN_HUB_R + 0.04, 0.012, 0, a, 0, finish('brass'));
  }
  const meshes = rotor.build(g);
  for (const mesh of meshes) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    live.disposables.push(mesh.geometry);
  }
  root.add(g);
  return g;
}
