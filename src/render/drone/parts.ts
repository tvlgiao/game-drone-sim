/**
 * Procedural geometry of the hero quad: true-X carbon unibody with chamfered edges, standoffs and
 * top plate, FC/ESC stack, TPU camera mount, naked action cam, motors (base, windings, bell with
 * cap windows, shaft, nut), battery + straps + leads + XT60, capacitor, VTX/RX antennas.
 * Body frame: -Z forward, +X right, +Y up. Detail 0 = LOD0, 1 = LOD1 (fewer segments, no small parts).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MOTOR_LAYOUT } from '../../physics/drone-params';
import { SWATCH, type Swatch } from './textures';

export type Detail = 0 | 1;

/** Receives every static part; LOD0 batches by material, LOD1 merges everything into one mesh. */
export interface PartSink {
  carbon(g: THREE.BufferGeometry, m: THREE.Matrix4): void;
  hard(g: THREE.BufferGeometry, m: THREE.Matrix4, swatch: Swatch, color: THREE.ColorRepresentation): void;
  /** battery wrap: the geometry's 0..1 UVs map onto the label */
  label(g: THREE.BufferGeometry, m: THREE.Matrix4): void;
}

export const PALETTE = {
  accent: 0xff5a1a,
  gunmetal: 0x2f3136,
  blackAno: 0x141518,
  steel: 0xc3c8cf,
  copper: 0xc4723a,
  tpu: 0x24262b,
  camBody: 0x0f1013,
  pcb: 0x0c0e11,
  chip: 0x050506,
  gold: 0xd4a548,
  strap: 0x0d0d0f,
  wireRed: 0xc4161c,
  wireBlack: 0x0d0d0f,
  xt60: 0xf0bc14,
  capSleeve: 0x1b3f8f,
  grommet: 0x6a2bd9,
  white: 0xe9ebef,
  glass: 0x05070c,
} as const;

/** Prop radius (m), from the physics model. */
export const PROP_R = 0.038;
/** Plate thicknesses / heights (m). */
export const BOTTOM_T = 0.0028;
export const BOTTOM_Y = -BOTTOM_T / 2;
const TOP_Y = 0.0262;
const TOP_T = 0.002;
const PLATE_TOP = BOTTOM_Y + BOTTOM_T;
const STANDOFF_X = 0.0125;
const STANDOFF_Z = 0.022;
const STRAP_Z = [-0.011, 0.017] as const;
/** FPV camera: pivot height/depth (must match CAMERA_PIVOT in drone-model.ts) and half the 15 mm body */
const CAMERA_Y = 0.041;
const CAMERA_Z = -0.037;
const CAM_HALF = 0.0075;
/** label UV rows: v < LABEL_SIDE_V is the edge strip, above it the side art */
const LABEL_SIDE_V = 0.25;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();

/** TRS matrix (euler order YXZ), new instance each call (parts keep their matrix). */
export function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

const I = new THREE.Matrix4();

function roundedRect(hw: number, hl: number, r: number, cx = 0, cy = 0): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(cx - hw + r, cy - hl);
  s.lineTo(cx + hw - r, cy - hl);
  s.quadraticCurveTo(cx + hw, cy - hl, cx + hw, cy - hl + r);
  s.lineTo(cx + hw, cy + hl - r);
  s.quadraticCurveTo(cx + hw, cy + hl, cx + hw - r, cy + hl);
  s.lineTo(cx - hw + r, cy + hl);
  s.quadraticCurveTo(cx - hw, cy + hl, cx - hw, cy + hl - r);
  s.lineTo(cx - hw, cy - hl + r);
  s.quadraticCurveTo(cx - hw, cy - hl, cx - hw + r, cy - hl);
  return s;
}

function circlePath(cx: number, cy: number, r: number, cw: boolean): THREE.Path {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, Math.PI * 2, cw);
  return p;
}

/** Extrude plate shapes (shape x → body x, shape y → body -z), thickness up from y = 0, chamfered. */
function plate(shapes: THREE.Shape[], thickness: number, detail: Detail, chamfer = 0.0005): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: thickness - chamfer * 2,
    bevelEnabled: true,
    bevelThickness: chamfer,
    bevelSize: chamfer,
    bevelOffset: -chamfer,
    bevelSegments: 1,
    curveSegments: detail === 0 ? 10 : 4,
  });
  g.translate(0, 0, chamfer);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Unibody bottom plate: body + four tapered true-X arms with lightening slots and motor pads. */
function bottomPlateShapes(detail: Detail): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  const body = roundedRect(0.0165, 0.031, 0.007);
  if (detail === 0) {
    for (const z of STRAP_Z) for (const x of [-0.0138, 0.0138]) body.holes.push(roundedRect(0.0011, 0.0046, 0.0009, x, -z));
  }
  shapes.push(body);
  for (const m of MOTOR_LAYOUT) {
    const mx = m.position[0];
    const my = -m.position[2];
    const len = Math.hypot(mx, my);
    const ux = mx / len;
    const uy = my / len;
    const px = -uy;
    const py = ux;
    const w0 = 0.0058;
    const w1 = 0.0044;
    const start = 0.008;
    const arm = new THREE.Shape();
    arm.moveTo(ux * start + px * w0, uy * start + py * w0);
    arm.lineTo(mx + px * w1, my + py * w1);
    arm.lineTo(mx - px * w1, my - py * w1);
    arm.lineTo(ux * start - px * w0, uy * start - py * w0);
    arm.closePath();
    if (detail === 0) {
      // lightening slot along the arm
      const a = 0.024;
      const b = 0.034;
      const hw = 0.0016;
      const slot = new THREE.Path();
      slot.moveTo(ux * a + px * hw, uy * a + py * hw);
      slot.lineTo(ux * b + px * hw * 0.8, uy * b + py * hw * 0.8);
      slot.lineTo(ux * b - px * hw * 0.8, uy * b - py * hw * 0.8);
      slot.lineTo(ux * a - px * hw, uy * a - py * hw);
      slot.closePath();
      arm.holes.push(slot);
    }
    shapes.push(arm);
    const pad = new THREE.Shape();
    pad.absarc(mx, my, 0.0098, 0, Math.PI * 2, false);
    if (detail === 0) {
      pad.holes.push(circlePath(mx, my, 0.0028, true));
    }
    shapes.push(pad);
    // arm-tip guard past the motor
    const tip = new THREE.Shape();
    tip.absarc(mx + ux * 0.0075, my + uy * 0.0075, 0.0052, 0, Math.PI * 2, false);
    shapes.push(tip);
  }
  return shapes;
}

function topPlateShapes(detail: Detail): THREE.Shape[] {
  const top = roundedRect(0.0165, 0.031, 0.006);
  if (detail === 0) {
    for (const x of [-0.0085, 0.0085]) top.holes.push(roundedRect(0.0022, 0.0075, 0.0018, x, -0.01));
  }
  return [top];
}

/** Geometry with only position/normal (+uv) kept, transformed. */
function cyl(rt: number, rb: number, h: number, seg: number, open = false): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
}

function lathe(points: [number, number][], seg: number): THREE.LatheGeometry {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}

function tube(points: [number, number, number][], radius: number, seg: number, radial: number): THREE.TubeGeometry {
  const c = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.TubeGeometry(c, seg, radius, radial, false);
}

/** Bell top cap: outer rim + hub joined by six spokes; the windows between show the copper windings. */
function bellCap(sink: PartSink, mx: number, y: number, mz: number, detail: Detail): void {
  const seg = detail === 0 ? 28 : 10;
  const t = 0.0009;
  const ring = (r0: number, r1: number): THREE.LatheGeometry =>
    lathe([[r0, 0], [r1, 0], [r1, t * 0.6], [r1 - 0.0003, t], [r0, t], [r0, 0]], seg);
  if (detail === 1) {
    sink.hard(ring(0.0016, 0.0086), at(mx, y, mz), SWATCH.anodized, PALETTE.gunmetal);
    return;
  }
  sink.hard(ring(0.0073, 0.0086), at(mx, y, mz), SWATCH.anodized, PALETTE.gunmetal);
  sink.hard(ring(0.0016, 0.0038), at(mx, y, mz), SWATCH.anodized, PALETTE.gunmetal);
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    sink.hard(new THREE.BoxGeometry(0.0038, t * 0.85, 0.0016), at(mx + Math.cos(a) * 0.0055, y + t * 0.42, mz + Math.sin(a) * 0.0055, 0, -a, 0), SWATCH.anodized, PALETTE.gunmetal);
  }
}

function motor(sink: PartSink, mx: number, mz: number, detail: Detail): void {
  const seg = detail === 0 ? 28 : 10;
  // stator base
  sink.hard(lathe([[0.0001, PLATE_TOP], [0.0089, PLATE_TOP], [0.0091, PLATE_TOP + 0.0004], [0.0091, PLATE_TOP + 0.0018], [0.0084, PLATE_TOP + 0.0022], [0.0001, PLATE_TOP + 0.0022]], seg), at(mx, 0, mz), SWATCH.anodized, PALETTE.gunmetal);
  const bellBottom = PLATE_TOP + 0.0027;
  const bellTop = 0.0152;
  // bell: accent anodized side wall with a chamfered lip
  sink.hard(
    lathe([[0.0087, bellBottom], [0.0094, bellBottom], [0.0096, bellBottom + 0.0005], [0.0096, bellTop - 0.0016], [0.0089, bellTop], [0.0084, bellTop]], seg),
    at(mx, 0, mz),
    SWATCH.anodized,
    PALETTE.accent,
  );
  bellCap(sink, mx, bellTop, mz, detail);
  if (detail === 1) return;
  // dark band at the bell base (magnet ring)
  sink.hard(cyl(0.00965, 0.00965, 0.0012, seg, true), at(mx, bellBottom + 0.0012, mz), SWATCH.anodized, PALETTE.blackAno);
  // windings: 12 copper teeth on a dark stator, seen through the cap windows and the base gap
  sink.hard(cyl(0.0042, 0.0042, 0.0094, 14), at(mx, PLATE_TOP + 0.0072, mz), SWATCH.anodized, PALETTE.gunmetal);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    sink.hard(new THREE.BoxGeometry(0.0021, 0.0088, 0.0028), at(mx + Math.cos(a) * 0.0058, PLATE_TOP + 0.0073, mz + Math.sin(a) * 0.0058, 0, -a, 0), SWATCH.enamel, PALETTE.copper);
  }
  // shaft, prop washer + nyloc nut
  sink.hard(cyl(0.0012, 0.0012, 0.009, 10), at(mx, bellTop + 0.0045, mz), SWATCH.steel, PALETTE.steel);
  sink.hard(cyl(0.0026, 0.0026, 0.0018, 6), at(mx, 0.0234, mz), SWATCH.steel, PALETTE.steel);
  sink.hard(cyl(0.0024, 0.0026, 0.0012, 12), at(mx, 0.0249, mz), SWATCH.anodized, PALETTE.accent);
  // mounting screws under the arm
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    sink.hard(cyl(0.0016, 0.0016, 0.0009, 6), at(mx + Math.cos(a) * 0.0058, BOTTOM_Y - 0.00045, mz - Math.sin(a) * 0.0058), SWATCH.steel, PALETTE.steel);
  }
  // motor wires along the arm into the stack
  const len = Math.hypot(mx, mz);
  const ux = mx / len;
  const uz = mz / len;
  const y = PLATE_TOP + 0.0011;
  sink.hard(
    tube([[mx - ux * 0.0088, y + 0.0006, mz - uz * 0.0088], [ux * 0.03, y, uz * 0.03], [ux * 0.017, y, uz * 0.017], [ux * 0.011, PLATE_TOP + 0.003, uz * 0.011]], 0.00105, 10, 5),
    I,
    SWATCH.rubber,
    PALETTE.wireBlack,
  );
}

function stack(sink: PartSink): void {
  for (const y of [0.0052, 0.0128]) {
    sink.hard(new THREE.BoxGeometry(0.02, 0.0012, 0.02), at(0, y, 0), SWATCH.pcb, PALETTE.pcb);
  }
  // FC components: MCU, gyro, regulators, USB port, BEC caps
  sink.hard(new THREE.BoxGeometry(0.0065, 0.001, 0.0065), at(0, 0.0139, -0.001, 0, Math.PI / 4, 0), SWATCH.gloss, PALETTE.chip);
  sink.hard(new THREE.BoxGeometry(0.003, 0.0008, 0.003), at(0.006, 0.0138, 0.006), SWATCH.gloss, PALETTE.chip);
  sink.hard(new THREE.BoxGeometry(0.0045, 0.0018, 0.0035), at(-0.0085, 0.0143, 0.004), SWATCH.steel, PALETTE.steel);
  for (const [x, z] of [[0.006, -0.006], [-0.005, -0.007], [0.007, 0.001]]) {
    sink.hard(new THREE.BoxGeometry(0.0016, 0.0009, 0.001), at(x, 0.0138, z), SWATCH.gloss, PALETTE.gold);
  }
  // ESC FETs
  for (const [x, z] of [[0.006, 0.006], [-0.006, 0.006], [0.006, -0.006], [-0.006, -0.006]]) {
    sink.hard(new THREE.BoxGeometry(0.004, 0.0009, 0.003), at(x, 0.0062, z), SWATCH.gloss, PALETTE.chip);
  }
  // soft-mount grommets
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    sink.hard(cyl(0.0017, 0.0017, 0.0064, 10), at(sx * 0.0085, 0.009, sz * 0.0085), SWATCH.tpu, PALETTE.grommet);
  }
}

function standoffs(sink: PartSink, detail: Detail): void {
  const h = TOP_Y - PLATE_TOP;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * STANDOFF_X;
    const z = sz * STANDOFF_Z;
    sink.hard(cyl(0.0021, 0.0021, h, detail === 0 ? 12 : 6), at(x, PLATE_TOP + h / 2, z), SWATCH.anodized, PALETTE.gunmetal);
    if (detail === 0) {
      // button-head screws top and bottom
      sink.hard(lathe([[0.0001, 0], [0.0021, 0], [0.0021, 0.0004], [0.0013, 0.0011], [0.0001, 0.0011]], 12), at(x, TOP_Y + TOP_T, z), SWATCH.anodized, PALETTE.accent);
      sink.hard(lathe([[0.0001, 0], [0.0021, 0], [0.0021, 0.0004], [0.0013, 0.0011], [0.0001, 0.0011]], 12), at(x, BOTTOM_Y, z, Math.PI), SWATCH.steel, PALETTE.blackAno);
    }
  }
}

/** FPV camera TPU pod: two side cheeks joined by a roof, on the front of the top plate. */
function cameraMount(sink: PartSink, detail: Detail): void {
  const base = TOP_Y + TOP_T;
  const s = new THREE.Shape();
  // profile in (body z, body y)
  s.moveTo(-0.019, base);
  s.lineTo(-0.041, base);
  s.quadraticCurveTo(-0.0475, base, -0.0478, 0.034);
  s.lineTo(-0.047, 0.046);
  s.quadraticCurveTo(-0.0465, 0.0505, -0.0425, 0.0505);
  s.lineTo(-0.027, 0.0505);
  s.quadraticCurveTo(-0.0205, 0.0505, -0.0195, 0.044);
  s.closePath();
  const t = 0.0026;
  for (const sx of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: detail === 0, bevelThickness: 0.0005, bevelSize: 0.0005, bevelSegments: 2, curveSegments: detail === 0 ? 8 : 3 });
    g.rotateY(-Math.PI / 2);
    // extrusion now spans x ∈ [-t, 0]
    const x = sx > 0 ? CAM_HALF + 0.0004 + t : -CAM_HALF - 0.0004;
    sink.hard(g, at(x, 0, 0), SWATCH.tpu, PALETTE.tpu);
    if (detail === 0) {
      // camera pivot screw
      const sc = lathe([[0.0001, 0], [0.0017, 0], [0.0017, 0.0004], [0.0011, 0.001], [0.0001, 0.001]], 12);
      sc.rotateZ((-sx * Math.PI) / 2);
      sink.hard(sc, at(sx * (CAM_HALF + 0.0004 + t + 0.0004), CAMERA_Y, CAMERA_Z), SWATCH.anodized, PALETTE.accent);
    }
  }
  sink.hard(new RoundedBoxGeometry(2 * (CAM_HALF + 0.0004 + t), 0.0024, 0.019, detail === 0 ? 2 : 1, 0.0009), at(0, 0.0503, -0.034), SWATCH.tpu, PALETTE.tpu);
}

/** Naked action cam on a 20° TPU wedge on the top plate, behind the FPV pod. */
function actionCam(sink: PartSink, detail: Detail): void {
  const tilt = THREE.MathUtils.degToRad(20);
  const depth = 0.017;
  const wz = -0.0075;
  const rear = 0.0022;
  const front = rear + depth * Math.tan(tilt);
  const wedge = new THREE.Shape();
  // (shape x = body z, shape y = body y): rises toward the front
  wedge.moveTo(wz + depth / 2, 0);
  wedge.lineTo(wz + depth / 2, rear);
  wedge.lineTo(wz - depth / 2, front);
  wedge.lineTo(wz - depth / 2, 0);
  wedge.closePath();
  const wg = new THREE.ExtrudeGeometry(wedge, { depth: 0.02, bevelEnabled: false });
  wg.rotateY(-Math.PI / 2);
  sink.hard(wg, at(0.01, TOP_Y + TOP_T, 0), SWATCH.tpu, PALETTE.tpu);
  const h = 0.0185;
  const mid = TOP_Y + TOP_T + (rear + front) / 2;
  const cy = mid + (h / 2) * Math.cos(tilt);
  const cz = wz + (h / 2) * Math.sin(tilt);
  const frame = at(0, cy, cz, tilt);
  const local = (x: number, y: number, z: number, rx = 0) => at(x, y, z, rx).premultiply(frame);
  sink.hard(new RoundedBoxGeometry(0.027, h, 0.0145, detail === 0 ? 3 : 1, 0.0022), frame.clone(), SWATCH.gloss, 0x1b1c20);
  const lx = 0.0055;
  const lens = cyl(0.0052, 0.0056, 0.003, detail === 0 ? 24 : 10);
  lens.rotateX(Math.PI / 2);
  sink.hard(lens, local(lx, 0.0012, -0.0085), SWATCH.anodized, PALETTE.blackAno);
  const glass = new THREE.SphereGeometry(0.0042, detail === 0 ? 20 : 8, detail === 0 ? 6 : 3, 0, Math.PI * 2, 0, Math.PI / 3.2);
  glass.rotateX(-Math.PI / 2);
  sink.hard(glass, local(lx, 0.0012, -0.0083), SWATCH.glass, PALETTE.glass);
  if (detail === 1) return;
  const ring = new THREE.TorusGeometry(0.0051, 0.00045, 6, 24);
  sink.hard(ring, local(lx, 0.0012, -0.0101), SWATCH.anodized, PALETTE.accent);
  // record LED, shutter button, rear screen, TPU strap band
  sink.hard(new THREE.BoxGeometry(0.002, 0.001, 0.0006), local(-0.0085, 0.0058, -0.0074), SWATCH.gloss, 0xff2020);
  sink.hard(cyl(0.002, 0.002, 0.0011, 12), local(-0.0075, h / 2 + 0.0004, 0.001), SWATCH.gloss, 0xc81a1a);
  sink.hard(new THREE.BoxGeometry(0.019, 0.012, 0.0005), local(0, 0.0004, 0.0073), SWATCH.glass, 0x0b0d12);
  sink.hard(new RoundedBoxGeometry(0.0292, 0.0045, 0.0158, 1, 0.0012), local(0, -h / 2 + 0.002, 0), SWATCH.tpu, PALETTE.tpu);
}

/**
 * Battery wrap UVs (battery-local box w × h × l): label art on the long sides (mirrored on +x so
 * it reads correctly from both sides), the edge strip on top/bottom, plain wrap on the ends.
 */
function batteryUV(g: THREE.BufferGeometry, w: number, h: number, l: number): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const along = THREE.MathUtils.clamp(pos.getZ(i) / l + 0.5, 0, 1);
    let u: number;
    let v: number;
    if (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)) {
      u = nx > 0 ? 1 - along : along;
      v = LABEL_SIDE_V + (1 - LABEL_SIDE_V) * THREE.MathUtils.clamp(pos.getY(i) / h + 0.5, 0, 1);
    } else if (Math.abs(ny) >= Math.abs(nz)) {
      u = along;
      v = LABEL_SIDE_V * THREE.MathUtils.clamp(pos.getX(i) / w + 0.5, 0, 1);
    } else {
      u = 0.01;
      v = 0.97;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Bottom-mounted 4S pack with anti-slip pad, two straps through the bottom plate, leads + XT60, capacitor. */
function battery(sink: PartSink, detail: Detail): void {
  const w = 0.033;
  const h = 0.0285;
  const l = 0.062;
  const cz = 0.004;
  const cy = BOTTOM_Y - 0.0007 - h / 2;
  sink.label(batteryUV(new RoundedBoxGeometry(w, h, l, detail === 0 ? 3 : 1, 0.0035), w, h, l), at(0, cy, cz));
  sink.hard(new RoundedBoxGeometry(w - 0.004, 0.0022, l - 0.008, 1, 0.0008), at(0, cy - h / 2 - 0.0008, cz), SWATCH.rubber, PALETTE.strap);
  for (const z of STRAP_Z) {
    sink.hard(new RoundedBoxGeometry(w + 0.0024, h + BOTTOM_T + 0.0034, 0.0085, detail === 0 ? 2 : 1, 0.0026), at(0, cy + (BOTTOM_T + 0.0007) / 2 + 0.0004, z), SWATCH.rubber, PALETTE.strap);
    if (detail === 0) sink.hard(new RoundedBoxGeometry(0.0115, 0.0012, 0.009, 1, 0.0005), at(0, cy - h / 2 - 0.0021, z), SWATCH.anodized, PALETTE.accent);
  }
  // leads out of the rear of the pack up to the XT60 behind the frame
  const rearZ = cz + l / 2;
  const lx = 0.006;
  const xz = rearZ + 0.012;
  const xy = cy + 0.003;
  const rs = detail === 0 ? 2 : 1;
  sink.hard(new RoundedBoxGeometry(0.0125, 0.0068, 0.012, rs, 0.0012), at(lx, xy, xz), SWATCH.gloss, PALETTE.xt60);
  sink.hard(new RoundedBoxGeometry(0.0128, 0.007, 0.011, rs, 0.0012), at(lx, xy + 0.0005, xz + 0.0115), SWATCH.gloss, PALETTE.xt60);
  if (detail === 1) return;
  for (const [dx, col] of [[-0.003, PALETTE.wireRed], [0.003, PALETTE.wireBlack]] as const) {
    sink.hard(tube([[lx + dx, cy + 0.006, rearZ - 0.003], [lx + dx * 1.1, cy + 0.007, rearZ + 0.002], [lx + dx, xy, xz - 0.006]], 0.0015, 8, 6), I, SWATCH.gloss, col);
    sink.hard(tube([[lx + dx, xy + 0.0005, xz + 0.017], [lx + dx * 1.3, xy + 0.006, xz + 0.02], [lx + dx, 0.008, 0.036], [dx * 1.5, 0.0075, 0.018]], 0.0015, 12, 6), I, SWATCH.gloss, col);
  }
  // low-ESR capacitor on the ESC leads, blue sleeve with a white stripe, poking out the rear
  const cap = cyl(0.0042, 0.0042, 0.013, 16);
  cap.rotateZ(Math.PI / 2);
  sink.hard(cap, at(-0.0105, 0.0098, 0.032, 0, -0.55, 0), SWATCH.gloss, PALETTE.capSleeve);
  const stripe = cyl(0.00425, 0.00425, 0.0024, 16, true);
  stripe.rotateZ(Math.PI / 2);
  sink.hard(stripe, at(-0.0105 - Math.cos(0.55) * 0.004, 0.0098, 0.032 - Math.sin(0.55) * 0.004, 0, -0.55, 0), SWATCH.gloss, PALETTE.white);
}

function antennas(sink: PartSink, detail: Detail): void {
  // VTX: TPU mount on the top-plate rear, coax leaning back, lollipop cap in accent TPU
  const by = TOP_Y + TOP_T + 0.0028;
  const bz = 0.0245;
  sink.hard(new RoundedBoxGeometry(0.011, 0.0056, 0.009, detail === 0 ? 2 : 1, 0.0016), at(0, by, bz), SWATCH.tpu, PALETTE.tpu);
  const lean = 0.62;
  const len = 0.038;
  const coax = cyl(0.0012, 0.0014, len, detail === 0 ? 8 : 5);
  coax.translate(0, len / 2, 0);
  sink.hard(coax, at(0, by + 0.002, bz, lean), SWATCH.rubber, PALETTE.wireBlack);
  _v.set(0, len, 0).applyEuler(_e.set(lean, 0, 0, 'YXZ'));
  sink.hard(
    lathe([[0.0001, -0.006], [0.0028, -0.006], [0.0044, -0.003], [0.0046, 0.003], [0.0034, 0.0058], [0.0001, 0.0062]], detail === 0 ? 18 : 8),
    at(0, by + 0.002 + _v.y, bz + _v.z, lean),
    SWATCH.tpu,
    PALETTE.accent,
  );
  if (detail === 1) return;
  // ELRS whiskers in TPU sleeves, out of the rear between the plates
  for (const sx of [-1, 1]) {
    const m = at(sx * 0.007, PLATE_TOP + 0.009, 0.03, 1.95, sx * 0.62, 0);
    const wsk = cyl(0.0005, 0.0005, 0.03, 5);
    wsk.translate(0, 0.015, 0);
    sink.hard(wsk, m, SWATCH.gloss, PALETTE.white);
    const sl = cyl(0.0011, 0.0011, 0.009, 8);
    sl.translate(0, 0.0045, 0);
    sink.hard(sl, m.clone(), SWATCH.tpu, PALETTE.tpu);
  }
}

/** Every static part of the airframe at the given detail. */
export function buildAirframe(sink: PartSink, detail: Detail): void {
  sink.carbon(plate(bottomPlateShapes(detail), BOTTOM_T, detail), at(0, BOTTOM_Y, 0));
  sink.carbon(plate(topPlateShapes(detail), TOP_T, detail, 0.0004), at(0, TOP_Y, 0));
  standoffs(sink, detail);
  if (detail === 0) stack(sink);
  for (const m of MOTOR_LAYOUT) motor(sink, m.position[0], m.position[2], detail);
  cameraMount(sink, detail);
  actionCam(sink, detail);
  battery(sink, detail);
  antennas(sink, detail);
}

/** FPV camera (tilts as a group around CAMERA_PIVOT): 15 mm body, lens barrel, focus ring, glass dome. */
export function buildFpvCamera(sink: PartSink, detail: Detail): void {
  const s = CAM_HALF * 2;
  sink.hard(new RoundedBoxGeometry(s, s, 0.0145, detail === 0 ? 3 : 1, 0.0018), at(0, 0, 0.0005), SWATCH.gloss, PALETTE.camBody);
  const barrel = lathe([[0.0059, 0], [0.0059, 0.0045], [0.0055, 0.0052], [0.0055, 0.0086], [0.0049, 0.0091], [0.0042, 0.0091]], detail === 0 ? 28 : 10);
  barrel.rotateX(-Math.PI / 2);
  sink.hard(barrel, at(0, 0, -0.0068), SWATCH.anodized, PALETTE.blackAno);
  if (detail === 0) {
    const ring = cyl(0.0061, 0.0061, 0.0014, 28, true);
    ring.rotateX(Math.PI / 2);
    sink.hard(ring, at(0, 0, -0.0095), SWATCH.anodized, PALETTE.accent);
    // camera PCB/back plate
    sink.hard(new RoundedBoxGeometry(s - 0.001, s - 0.001, 0.0016, 1, 0.0005), at(0, 0, 0.0083), SWATCH.pcb, PALETTE.pcb);
  }
}

/** Glass dome of the FPV lens (camera-local). */
export function fpvGlass(detail: Detail): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.0049, detail === 0 ? 28 : 10, detail === 0 ? 8 : 3, 0, Math.PI * 2, 0, Math.PI / 3.2);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -0.0131);
  return g;
}

const NACA_T = [0.2969, -0.126, -0.3516, 0.2843, -0.1036];

/**
 * One blade along +X in the XZ plane, leading edge toward -Z (CCW spin about +Y): a cambered
 * NACA-style section lofted over radial stations with chord taper, washout twist and tip sweep.
 */
export function bladeGeometry(detail: Detail): THREE.BufferGeometry {
  const nr = detail === 0 ? 11 : 4;
  const nc = detail === 0 ? 6 : 2;
  const r0 = 0.0042;
  const loop = nc * 2;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < nr; i++) {
    const t = i / (nr - 1);
    const r = r0 + (PROP_R - r0) * t;
    const tipRound = t > 0.82 ? Math.sqrt(Math.max(0, 1 - ((t - 0.82) / 0.18) ** 2)) : 1;
    const chord = (0.0068 + 0.0062 * Math.sin(Math.PI * Math.min(1, t * 1.25)) * (1 - 0.35 * t)) * Math.max(0.28, tipRound);
    const pitch = THREE.MathUtils.degToRad(27 - 15 * t);
    const thick = 0.12 - 0.05 * t;
    const camber = 0.05;
    const sweep = 0.0026 * t * t;
    for (let k = 0; k < loop; k++) {
      // around the section: upper surface LE→TE, then lower TE→LE (cosine spacing)
      const upper = k < nc;
      const s = upper ? k / nc : 1 - (k - nc) / nc;
      const x = 0.5 - 0.5 * Math.cos(Math.PI * s);
      const yt = 5 * thick * (NACA_T[0] * Math.sqrt(x) + NACA_T[1] * x + NACA_T[2] * x * x + NACA_T[3] * x ** 3 + NACA_T[4] * x ** 4);
      const yc = camber * 4 * x * (1 - x);
      const y = (yc + (upper ? yt : -yt)) * chord;
      const z = (x - 0.4) * chord + sweep;
      const c = Math.cos(pitch);
      const sn = Math.sin(pitch);
      pos.push(r, y * c - z * sn, y * sn + z * c);
    }
    if (i > 0) {
      const a = (i - 1) * loop;
      const b = i * loop;
      for (let k = 0; k < loop; k++) {
        const k1 = (k + 1) % loop;
        idx.push(a + k, b + k, b + k1, a + k, b + k1, a + k1);
      }
    }
  }
  // tip cap fan
  const last = (nr - 1) * loop;
  for (let k = 1; k < loop - 1; k++) idx.push(last, last + k, last + k + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Three blades + hub, CCW. CW props mirror it across the blade plane in the prop shader. */
export function propGeometry(detail: Detail): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const b = bladeGeometry(detail);
    b.rotateY((k * Math.PI * 2) / 3);
    parts.push(b.toNonIndexed());
    b.dispose();
  }
  const hub = lathe([[0.0001, -0.0042], [0.0046, -0.0042], [0.005, -0.0034], [0.005, 0.001], [0.0042, 0.0018], [0.0001, 0.0018]], detail === 0 ? 20 : 8);
  parts.push(hub.toNonIndexed());
  hub.dispose();
  return mergePositionNormal(parts);
}

/** Merge position+normal of non-indexed parts (consumes them). */
export function mergePositionNormal(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    if (!p.attributes.normal) p.computeVertexNormals();
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nor.set(p.attributes.normal.array as Float32Array, o * 3);
    o += p.attributes.position.count;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

/** LED strips under the arms + a rear tail bar (body frame). */
export function ledGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const m of MOTOR_LAYOUT) {
    const [mx, , mz] = m.position;
    const len = Math.hypot(mx, mz);
    const g = new THREE.BoxGeometry(0.0034, 0.0014, 0.024, 1, 1, 6);
    g.rotateY(Math.atan2(mx, mz));
    g.translate((mx / len) * 0.026, BOTTOM_Y - 0.0008, (mz / len) * 0.026);
    parts.push(g.toNonIndexed());
    g.dispose();
  }
  const rear = new THREE.BoxGeometry(0.022, 0.0026, 0.0018, 6, 1, 1);
  rear.translate(0, 0.0012, 0.0318);
  parts.push(rear.toNonIndexed());
  rear.dispose();
  // front "headlights" either side of the camera mount
  for (const sx of [-1, 1]) {
    const f = new THREE.BoxGeometry(0.003, 0.0018, 0.0012);
    f.translate(sx * 0.0112, 0.0305, -0.0513);
    parts.push(f.toNonIndexed());
    f.dispose();
  }
  return mergePositionNormal(parts);
}
