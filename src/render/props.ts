/**
 * Prop builders by PropDef.kind. Every builder stays inside the prop's collider volume
 * (box props: footprint size centred on position, bottom at position.y), so what the pilot sees
 * is what the drone can hit. Static parts are merged per material; the fan and TV screen stay live.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PropDef } from '../types';
import { StaticBatcher, type AddOptions } from './batcher';
import type { Materials } from './materials';
import { mulberry32 } from './textures';

/** Matches physics-world fan kinematics: 4 blades along local +X at k·π/2, hub r 0.12, tip r 0.9. */
const FAN_BLADES = 4;
const FAN_HUB_R = 0.12;
const FAN_BLADE_W = 0.14;

export interface LiveProps {
  fan: THREE.Group | null;
  tvScreen: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null;
  disposables: { dispose(): void }[];
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
}

export function buildProps(props: readonly PropDef[], mats: Materials, batch: StaticBatcher, root: THREE.Object3D): LiveProps {
  const live: LiveProps = { fan: null, tvScreen: null, disposables: [] };
  const f = new PropFrame(batch);
  const rnd = mulberry32(1234);
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
        f.add('rug', mats.rug, new THREE.BoxGeometry(w, Math.max(h, 0.008), d), 0, Math.max(h, 0.008) / 2, 0, 0, 0, 0, { castShadow: false });
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
        crate(f, mats, w, h, d);
        break;
      case 'lamp-floor':
        floorLamp(f, mats, h);
        break;
      case 'bulb-hanging':
        bulb(f, mats, h);
        break;
      case 'fan':
        live.fan = fan(f, mats, p, root, live);
        break;
    }
  }
  return live;
}

function pillar(f: PropFrame, m: Materials, r: number, h: number): void {
  f.add('concrete', m.concrete, new THREE.CylinderGeometry(r, r, h, 28, 1), 0, h / 2, 0, 0, 0, 0, { uvTile: 1.6 });
  for (const y of [0.35, h - 0.5]) {
    f.add('steelDark', m.steelDark, new THREE.CylinderGeometry(r + 0.006, r + 0.006, 0.06, 28, 1, true), 0, y, 0);
  }
  f.add('steelDark', m.steelDark, new THREE.CylinderGeometry(r * 0.98, r + 0.004, 0.12, 28), 0, 0.06, 0);
}

function beam(f: PropFrame, m: Materials, w: number, h: number, len: number): void {
  const fl = 0.035;
  const col = 0x4a2a24;
  f.add('painted', m.painted, new THREE.BoxGeometry(w, fl, len), 0, fl / 2, 0, 0, 0, 0, { color: col });
  f.add('painted', m.painted, new THREE.BoxGeometry(w, fl, len), 0, h - fl / 2, 0, 0, 0, 0, { color: col });
  f.add('painted', m.painted, new THREE.BoxGeometry(0.025, h - fl * 2, len), 0, h / 2, 0, 0, 0, 0, { color: col });
  // stiffener plates every 1.75 m
  for (let z = -len / 2 + 0.9; z < len / 2; z += 1.75) {
    f.add('painted', m.painted, new THREE.BoxGeometry(w * 0.9, h - fl * 2, 0.02), 0, h / 2, z, 0, 0, 0, { color: 0x3c211c });
  }
  // hangers up to the slab (thin, above the beam)
  for (let z = -len / 2 + 1; z < len / 2; z += 3) {
    f.add('steelDark', m.steelDark, new THREE.BoxGeometry(0.06, 0.2, 0.06), 0, h + 0.1, z);
  }
}

function duct(f: PropFrame, m: Materials, len: number, h: number, d: number, baseY: number): void {
  const inset = 0.03;
  f.add('galv', m.galvanized, new THREE.BoxGeometry(len, h - inset * 2, d - inset * 2), 0, h / 2, 0);
  for (let x = -len / 2 + 0.3; x <= len / 2 - 0.2; x += 1.2) {
    f.add('galv', m.galvanized, new THREE.BoxGeometry(0.04, h, d), x, h / 2, 0);
  }
  const rodLen = 6 - (baseY + h);
  for (let x = -len / 2 + 1.5; x < len / 2; x += 3.5) {
    for (const z of [-d / 2 + 0.04, d / 2 - 0.04]) {
      f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.008, 0.008, rodLen, 6), x, h + rodLen / 2, z);
    }
    f.add('steelBlack', m.steelBlack, new THREE.BoxGeometry(0.05, 0.03, d), x, -0.0, 0, 0, 0, 0, {}, 1, 0.5, 1);
  }
}

function sofa(f: PropFrame, m: Materials, w: number, h: number, d: number): void {
  const legH = 0.1;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.add('walnut', m.walnut, new THREE.CylinderGeometry(0.025, 0.018, legH, 10), sx * (w / 2 - 0.1), legH / 2, sz * (d / 2 - 0.1));
  }
  const armW = 0.2;
  f.add('leather', m.leather, new RoundedBoxGeometry(w, 0.26, d, 3, 0.04), 0, legH + 0.13, 0);
  // back rest (local -Z is the back)
  f.add('leather', m.leather, new RoundedBoxGeometry(w - armW * 2 + 0.02, h - legH - 0.2, 0.2, 3, 0.05), 0, legH + 0.2 + (h - legH - 0.2) / 2, -d / 2 + 0.1);
  // arms
  for (const sx of [-1, 1]) {
    f.add('leather', m.leather, new RoundedBoxGeometry(armW, 0.62 - legH, d, 3, 0.06), sx * (w / 2 - armW / 2), legH + (0.62 - legH) / 2, 0);
  }
  // seat cushions
  const cw = (w - armW * 2) / 3;
  for (let i = 0; i < 3; i++) {
    const x = -w / 2 + armW + cw * (i + 0.5);
    f.add('leather', m.leather, new RoundedBoxGeometry(cw - 0.015, 0.14, d - 0.24, 3, 0.05), x, legH + 0.26 + 0.07, 0.1);
    f.add('leather', m.leather, new RoundedBoxGeometry(cw - 0.02, 0.36, 0.14, 3, 0.06), x, legH + 0.4 + 0.18, -d / 2 + 0.24, -0.16, 0, 0);
  }
  // teal throw pillows for colour contrast
  f.add('fabric', m.fabric, new RoundedBoxGeometry(0.4, 0.36, 0.12, 3, 0.05), -w / 2 + armW + 0.28, legH + 0.58, -d / 2 + 0.36, -0.3, 0.25, 0.05);
  f.add('fabric', m.fabric, new RoundedBoxGeometry(0.4, 0.36, 0.12, 3, 0.05), w / 2 - armW - 0.28, legH + 0.58, -d / 2 + 0.36, -0.3, -0.25, -0.05);
}

function table(f: PropFrame, m: Materials, w: number, h: number, d: number): void {
  const top = 0.04;
  f.add('oak', m.oak, new RoundedBoxGeometry(w, top, d, 2, 0.01), 0, h - top / 2, 0);
  f.add('oak', m.oak, new THREE.BoxGeometry(w - 0.12, 0.02, d - 0.12), 0, 0.12, 0);
  // hairpin legs
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w / 2 - 0.08);
    const z = sz * (d / 2 - 0.08);
    f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.008, 0.008, h - top, 6), x, (h - top) / 2, z, sz * 0.06, 0, -sx * 0.06);
    f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.008, 0.008, h - top, 6), x * 0.9, (h - top) / 2, z, sz * 0.06, 0, sx * 0.04);
  }
  // items: book stack, mug, radio transmitter
  const books = [0x2d4a7a, 0xc9a24a, 0x8a2f2f];
  books.forEach((c, i) => {
    f.add('painted', m.painted, new THREE.BoxGeometry(0.24, 0.035, 0.17), -0.35, h + 0.0175 + i * 0.035, -0.05, 0, i * 0.2 - 0.2, 0, { color: c });
  });
  f.add('ceramic', m.ceramic, new THREE.CylinderGeometry(0.04, 0.036, 0.1, 18), 0.1, h + 0.05, 0.12);
  f.add('painted', m.painted, new RoundedBoxGeometry(0.2, 0.05, 0.13, 2, 0.015), 0.32, h + 0.025, -0.06, 0, -0.4, 0, { color: 0x202225 });
  for (const sx of [-0.05, 0.05]) {
    f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.006, 0.006, 0.04, 6), 0.32 + sx, h + 0.07, -0.06);
  }
}

function tv(f: PropFrame, m: Materials, p: PropDef, w: number, h: number, d: number, root: THREE.Object3D): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  f.add('tvBezel', m.tvBezel, new RoundedBoxGeometry(w, h, d, 2, 0.01), 0, h / 2, 0);
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
  return screen;
}

function leafGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0.09, 0.05, 0.1, 0.22, 0, 0.32);
  s.bezierCurveTo(-0.1, 0.22, -0.09, 0.05, 0, 0);
  const g = new THREE.ShapeGeometry(s, 6);
  // bend the leaf along its length
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    pos.setZ(i, y * y * 0.9 - Math.abs(x) * 0.25);
  }
  g.computeVertexNormals();
  return g;
}

function plant(f: PropFrame, m: Materials, w: number, h: number, rnd: () => number): void {
  const potH = 0.42;
  f.add('ceramic', m.ceramic, new THREE.CylinderGeometry(0.2, 0.16, potH, 24), 0, potH / 2, 0);
  f.add('painted', m.painted, new THREE.CylinderGeometry(0.185, 0.185, 0.02, 20), 0, potH - 0.02, 0, 0, 0, 0, { color: 0x2b1d14 });
  // stems + leaves spiralling up, contained in the w×h footprint
  const stems = 7;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rnd() * 0.4;
    const top = potH + 0.35 + rnd() * (h - potH - 0.55);
    const lean = 0.08 + rnd() * 0.08;
    const len = top - potH;
    f.add('walnut', m.walnut, new THREE.CylinderGeometry(0.006, 0.01, len, 5), Math.cos(a) * lean * 0.5, potH + len / 2, Math.sin(a) * lean * 0.5, Math.sin(a) * 0.2, 0, -Math.cos(a) * 0.2);
    const leaves = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < leaves; k++) {
      const ly = potH + 0.15 + (k / leaves) * len;
      const la = a + (k % 2 === 0 ? 0.6 : -0.6) + rnd() * 0.5;
      const r = Math.min(w / 2 - 0.2, lean + 0.02);
      const s = 0.7 + rnd() * 0.5;
      f.add('leaf', m.leaf, leafGeometry(), Math.cos(la) * r, ly, Math.sin(la) * r, 0.5 + rnd() * 0.5, -la + Math.PI / 2, 0, {}, s, s, s);
    }
  }
}

function shelf(f: PropFrame, m: Materials, w: number, h: number, d: number, rnd: () => number): void {
  const post = 0.04;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.add('steelDark', m.steelDark, new THREE.BoxGeometry(post, h, post), sx * (w / 2 - post / 2), h / 2, sz * (d / 2 - post / 2));
  }
  const levels = [0.08, 0.6, 1.12, 1.64, h - 0.02];
  for (const y of levels) {
    f.add('oak', m.oak, new THREE.BoxGeometry(w - 0.02, 0.03, d - 0.02), 0, y - 0.015, 0);
    f.add('steelDark', m.steelDark, new THREE.BoxGeometry(w, 0.035, 0.02), 0, y - 0.03, d / 2 - 0.01);
  }
  // back X-braces
  const diag = Math.hypot(w, h);
  const ang = Math.atan2(h, w);
  f.add('steelDark', m.steelDark, new THREE.BoxGeometry(diag - 0.1, 0.012, 0.012), 0, h / 2, -d / 2 + 0.01, 0, 0, ang);
  f.add('steelDark', m.steelDark, new THREE.BoxGeometry(diag - 0.1, 0.012, 0.012), 0, h / 2, -d / 2 + 0.01, 0, 0, -ang);
  const bookCols = [0x8a2f2f, 0x2d4a7a, 0xc9a24a, 0x3d6b4a, 0xd8d0c0, 0x5a3d6b, 0x1f1f22, 0xb4552d];
  for (let li = 0; li < levels.length - 1; li++) {
    const y0 = levels[li];
    const clear = levels[li + 1] - y0 - 0.05;
    let x = -w / 2 + 0.08;
    while (x < w / 2 - 0.12) {
      const pick = rnd();
      if (pick < 0.45) {
        // row of books
        const n = 4 + Math.floor(rnd() * 8);
        for (let k = 0; k < n && x < w / 2 - 0.06; k++) {
          const bw = 0.025 + rnd() * 0.02;
          const bh = Math.min(clear, 0.2 + rnd() * 0.12);
          const bd = 0.16 + rnd() * 0.06;
          f.add('painted', m.painted, new THREE.BoxGeometry(bw, bh, bd), x + bw / 2, y0 + bh / 2, 0.02, 0, 0, 0, { color: bookCols[Math.floor(rnd() * bookCols.length)] });
          x += bw + 0.002;
        }
        x += 0.05;
      } else if (pick < 0.75) {
        const bw = 0.22 + rnd() * 0.18;
        const bh = Math.min(clear, 0.15 + rnd() * 0.22);
        const bd = Math.min(d - 0.08, 0.25 + rnd() * 0.1);
        f.add('painted', m.painted, new THREE.BoxGeometry(bw, bh, bd), x + bw / 2, y0 + bh / 2, 0, 0, (rnd() - 0.5) * 0.15, 0, { color: rnd() < 0.6 ? 0xa57a4f : 0x2b2f36 });
        x += bw + 0.04;
      } else if (pick < 0.9) {
        const r = 0.04 + rnd() * 0.035;
        const jh = Math.min(clear, 0.1 + rnd() * 0.14);
        f.add('ceramic', m.ceramic, new THREE.CylinderGeometry(r, r * 0.9, jh, 16), x + r, y0 + jh / 2, 0.04);
        x += r * 2 + 0.05;
      } else {
        // small plant pot
        f.add('painted', m.painted, new THREE.CylinderGeometry(0.06, 0.05, 0.1, 12), x + 0.06, y0 + 0.05, 0, 0, 0, 0, { color: 0xb4552d });
        f.add('leaf', m.leaf, new THREE.IcosahedronGeometry(0.08, 1), x + 0.06, y0 + 0.16, 0, 0, 0, 0, {}, 1, 0.8, 1);
        x += 0.16;
      }
    }
  }
}

function crate(f: PropFrame, m: Materials, w: number, h: number, d: number): void {
  const t = 0.05;
  f.add('pine', m.pine, new THREE.BoxGeometry(w - 0.02, h - 0.02, d - 0.02), 0, h / 2, 0, 0, 0, 0, { uvTile: 0.8 });
  // edge frame boards
  for (const sy of [t / 2, h - t / 2]) {
    for (const sz of [-1, 1]) f.add('walnut', m.walnut, new THREE.BoxGeometry(w, t, t * 0.6), 0, sy, sz * (d / 2 - t * 0.3), 0, 0, 0, { uvTile: 0.8 });
    for (const sx of [-1, 1]) f.add('walnut', m.walnut, new THREE.BoxGeometry(t * 0.6, t, d), sx * (w / 2 - t * 0.3), sy, 0, 0, 0, 0, { uvTile: 0.8 });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    f.add('walnut', m.walnut, new THREE.BoxGeometry(t * 0.6, h, t * 0.6), sx * (w / 2 - t * 0.3), h / 2, sz * (d / 2 - t * 0.3), 0, 0, 0, { uvTile: 0.8 });
  }
  // diagonal braces on the four sides
  const diag = Math.hypot(w - t, h - t);
  const ang = Math.atan2(h - t, w - t);
  for (const sz of [-1, 1]) f.add('walnut', m.walnut, new THREE.BoxGeometry(diag - 0.05, t * 0.8, t * 0.4), 0, h / 2, sz * (d / 2 - t * 0.2), 0, 0, ang * sz, { uvTile: 0.8 });
  for (const sx of [-1, 1]) f.add('walnut', m.walnut, new THREE.BoxGeometry(t * 0.4, t * 0.8, diag - 0.05), sx * (w / 2 - t * 0.2), h / 2, 0, ang * sx, 0, 0, { uvTile: 0.8 });
}

function floorLamp(f: PropFrame, m: Materials, h: number): void {
  const hub = 1.05;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const r = 0.18;
    const len = Math.hypot(r, hub);
    const tilt = Math.atan2(r, hub);
    f.add('walnut', m.walnut, new THREE.CylinderGeometry(0.012, 0.015, len, 8), Math.cos(a) * r * 0.5, hub / 2, Math.sin(a) * r * 0.5, Math.sin(a) * -tilt, 0, Math.cos(a) * tilt);
  }
  f.add('brass', m.brass, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), 0, hub, 0);
  f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.009, 0.009, h - 0.3 - hub, 8), 0, hub + (h - 0.3 - hub) / 2, 0);
  const shadeH = 0.3;
  f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.1, 0.2, shadeH, 28, 1, true), 0, h - shadeH / 2, 0);
  f.add('lampGlow', m.lampGlow, new THREE.CylinderGeometry(0.098, 0.197, shadeH - 0.01, 28, 1, true), 0, h - shadeH / 2, 0, 0, 0, 0, { castShadow: false });
  f.add('bulbGlow', m.bulbGlow, new THREE.SphereGeometry(0.045, 16, 12), 0, h - shadeH * 0.55, 0, 0, 0, 0, { castShadow: false });
}

function bulb(f: PropFrame, m: Materials, cordLen: number): void {
  // Edison bulb glass (collider box spans y -0.02..0.22 local)
  f.add('bulbGlow', m.bulbGlow, new THREE.SphereGeometry(0.052, 18, 14), 0, 0.055, 0, 0, 0, 0, { castShadow: false }, 1, 1.25, 1);
  f.add('brass', m.brass, new THREE.CylinderGeometry(0.024, 0.02, 0.07, 14), 0, 0.15, 0);
  f.add('brass', m.brass, new THREE.CylinderGeometry(0.016, 0.024, 0.03, 14), 0, 0.2, 0);
  f.add('cord', m.cord, new THREE.CylinderGeometry(0.0035, 0.0035, cordLen - 0.2, 5), 0, 0.2 + (cordLen - 0.2) / 2, 0, 0, 0, 0, { castShadow: false });
  f.add('steelBlack', m.steelBlack, new THREE.CylinderGeometry(0.05, 0.05, 0.025, 16), 0, cordLen - 0.0125, 0, 0, 0, 0, { castShadow: false });
}

function fan(f: PropFrame, m: Materials, p: PropDef, root: THREE.Object3D, live: LiveProps): THREE.Group {
  const [x, y, z] = p.position;
  const radius = p.size[0] / 2;
  // static downrod + canopy (merged)
  const rodLen = 6 - (y + 0.14);
  f.add('steelDark', m.steelDark, new THREE.CylinderGeometry(0.018, 0.018, rodLen, 10), 0, 0.14 + rodLen / 2, 0);
  f.add('steelDark', m.steelDark, new THREE.CylinderGeometry(0.06, 0.09, 0.08, 20), 0, rodLen + 0.1, 0);
  // rotating group: motor housing + blades
  const g = new THREE.Group();
  g.name = 'fan';
  g.position.set(x, y, z);
  const geos: THREE.BufferGeometry[] = [];
  const housingGeo = new THREE.CylinderGeometry(FAN_HUB_R, FAN_HUB_R * 0.8, 0.12, 28);
  const capGeo = new THREE.SphereGeometry(FAN_HUB_R * 0.5, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const bladeGeo = new RoundedBoxGeometry(radius - FAN_HUB_R - 0.02, 0.014, FAN_BLADE_W, 2, 0.006);
  const ironGeo = new THREE.BoxGeometry(0.16, 0.012, 0.04);
  geos.push(housingGeo, capGeo, bladeGeo, ironGeo);
  const housing = new THREE.Mesh(housingGeo, m.steelDark);
  housing.position.y = 0.05;
  const cap = new THREE.Mesh(capGeo, m.brass);
  cap.position.y = -0.01;
  g.add(housing, cap);
  const mid = (radius + FAN_HUB_R) / 2;
  for (let k = 0; k < FAN_BLADES; k++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (k * Math.PI * 2) / FAN_BLADES;
    const blade = new THREE.Mesh(bladeGeo, m.walnut);
    blade.position.set(mid + 0.01, 0, 0);
    blade.rotation.x = 0.12; // blade pitch
    const iron = new THREE.Mesh(ironGeo, m.steelDark);
    iron.position.set(FAN_HUB_R + 0.04, 0.012, 0);
    pivot.add(blade, iron);
    g.add(pivot);
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = false;
      o.receiveShadow = true;
    }
  });
  root.add(g);
  live.disposables.push(...geos);
  return g;
}
