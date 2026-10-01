/**
 * Procedural 3" cinewhoop: chamfered carbon X frame, brushless motors, tri-blade props with
 * rpm-driven blur discs, TPU ducts, LiPo + strap, tilted FPV camera, antennas, RGB LED strips.
 * Body frame: -Z forward, +X right, +Y up; motor placement/spin from MOTOR_LAYOUT.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MOTOR_LAYOUT } from '../physics/drone-params';
import type { DroneState } from '../types';
import { StaticBatcher } from './batcher';
import type { Materials } from './materials';

const PROP_R = 0.038;
const VIS_MAX_SPIN = 95; // rad/s visual prop speed at full rpm (beyond this it aliases anyway)
const WEAVE_TILE = 0.018; // metres per carbon texture tile
/** FPV lens position in body frame before tilt (camera pivot). */
export const CAMERA_PIVOT = new THREE.Vector3(0, 0.041, -0.037);
export const LENS_OFFSET = 0.016; // metres ahead of pivot along camera -Z

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();

/**
 * Orientation colours, like aircraft nav lights: the front half (−Z, camera side) is green, the rear
 * red, on LEDs, props, blur discs, ducts and the two nav-light glows — readable from across the loft.
 */
export const FRONT_COLOR = new THREE.Color(0.1, 1, 0.32);
export const REAR_COLOR = new THREE.Color(1, 0.12, 0.08);
/** screen-space size of the nav-light glows (fraction of the view height, sizeAttenuation off) */
const NAV_GLOW_SIZE = 0.022;

function scaleUV(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k, uv.getY(i) * k);
  return g;
}

/** Mirror across the XY plane and fix triangle winding. */
function mirrorZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.scale(1, 1, -1);
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
  } else {
    const pos = g.attributes.position;
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      const n = a.itemSize;
      for (let i = 0; i < pos.count; i += 3) {
        for (let k = 0; k < n; k++) {
          const t = a.array[(i + 1) * n + k];
          (a.array as Float32Array)[(i + 1) * n + k] = a.array[(i + 2) * n + k];
          (a.array as Float32Array)[(i + 2) * n + k] = t;
        }
      }
    }
  }
  g.computeVertexNormals();
  return g;
}

function plateShape(): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  const body = new THREE.Shape();
  const hw = 0.021;
  const hl = 0.036;
  const r = 0.006;
  body.moveTo(-hw + r, -hl);
  body.lineTo(hw - r, -hl);
  body.quadraticCurveTo(hw, -hl, hw, -hl + r);
  body.lineTo(hw, hl - r);
  body.quadraticCurveTo(hw, hl, hw - r, hl);
  body.lineTo(-hw + r, hl);
  body.quadraticCurveTo(-hw, hl, -hw, hl - r);
  body.lineTo(-hw, -hl + r);
  body.quadraticCurveTo(-hw, -hl, -hw + r, -hl);
  // lightening holes
  for (const y of [-0.018, 0.018]) {
    const h = new THREE.Path();
    h.absellipse(0, y, 0.008, 0.005, 0, Math.PI * 2, false, 0);
    body.holes.push(h);
  }
  shapes.push(body);
  for (const m of MOTOR_LAYOUT) {
    const mx = m.position[0];
    const my = -m.position[2]; // shape y = -body z
    const len = Math.hypot(mx, my);
    const ux = mx / len;
    const uy = my / len;
    const px = -uy;
    const py = ux;
    const w = 0.0065;
    const arm = new THREE.Shape();
    arm.moveTo(px * w, py * w);
    arm.lineTo(mx + px * w * 0.8, my + py * w * 0.8);
    arm.lineTo(mx - px * w * 0.8, my - py * w * 0.8);
    arm.lineTo(-px * w, -py * w);
    arm.closePath();
    shapes.push(arm);
    const pad = new THREE.Shape();
    pad.absarc(mx, my, 0.0115, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(mx, my, 0.003, 0, Math.PI * 2, true);
    pad.holes.push(hole);
    shapes.push(pad);
    // duct mounting ring (carbon), partially visible under the TPU duct
    const ring = new THREE.Shape();
    ring.absarc(mx, my, 0.047, 0, Math.PI * 2, false);
    const inner = new THREE.Path();
    inner.absarc(mx, my, 0.0425, 0, Math.PI * 2, true);
    ring.holes.push(inner);
    shapes.push(ring);
  }
  return shapes;
}

function extrudePlate(shapes: THREE.Shape[], thickness: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.0004,
    bevelSize: 0.0004,
    bevelSegments: 1,
    curveSegments: 20,
  });
  g.rotateX(-Math.PI / 2); // shape (x, y) -> body (x, -z); extrude +Z -> +Y
  return scaleUV(g, 1 / WEAVE_TILE);
}

function bladeGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const r0 = 0.004;
  s.moveTo(r0, -0.004);
  s.bezierCurveTo(0.014, -0.009, 0.028, -0.008, PROP_R, -0.002);
  s.quadraticCurveTo(PROP_R + 0.0012, 0.001, PROP_R - 0.002, 0.003);
  s.bezierCurveTo(0.026, 0.006, 0.014, 0.006, r0, 0.004);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.0007, bevelEnabled: false, curveSegments: 10 });
  g.translate(0, 0, -0.00035);
  g.rotateX(-Math.PI / 2); // blade in XZ plane, chord along -Z/+Z
  // twist: pitch decreases toward the tip
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const pitch = 0.42 - (x / PROP_R) * 0.22;
    pos.setY(i, pos.getY(i) - z * Math.tan(pitch));
    pos.setZ(i, z * Math.cos(pitch));
  }
  g.computeVertexNormals();
  return g;
}

function propGeometry(ccw: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const b = bladeGeometry();
    b.rotateY((k * Math.PI * 2) / 3);
    parts.push(b);
  }
  const hub = new THREE.CylinderGeometry(0.0048, 0.0052, 0.0055, 16).toNonIndexed();
  parts.push(hub);
  const nut = new THREE.CylinderGeometry(0.0024, 0.0024, 0.006, 6).toNonIndexed();
  nut.translate(0, 0.003, 0);
  parts.push(nut);
  for (const p of parts) {
    for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
  }
  const merged = mergeSimple(parts);
  // CCW (spin +1, +Y angular velocity) blades lead with -Z edge when rotating +Y; mirror for CW.
  return ccw ? merged : mirrorZ(merged);
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
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

function ductGeometry(): THREE.BufferGeometry {
  const pts = [
    [0.0405, -0.011],
    [0.0405, 0.026],
    [0.0418, 0.0296],
    [0.0445, 0.031],
    [0.0468, 0.0292],
    [0.047, 0.02],
    [0.0462, -0.006],
    [0.0452, -0.0115],
    [0.043, -0.0132],
    [0.0412, -0.0125],
    [0.0405, -0.011],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 48);
}

const BLUR_VERT = /* glsl */ `
attribute float aRpm;
attribute vec3 aTint;
varying vec2 vP;
varying float vRpm;
varying vec3 vTint;
#include <common>
#include <fog_pars_vertex>
void main() {
  vP = position.xz / ${PROP_R.toFixed(4)};
  vRpm = aRpm;
  vTint = aTint;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const BLUR_FRAG = /* glsl */ `
varying vec2 vP;
varying float vRpm;
varying vec3 vTint;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r = length(vP);
  float a = atan(vP.y, vP.x);
  float ghosts = pow(0.5 + 0.5 * cos(3.0 * a), 5.0);
  float radial = smoothstep(0.12, 0.22, r) * (1.0 - smoothstep(0.93, 1.0, r));
  float tip = smoothstep(0.84, 0.94, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float alpha = vRpm * (radial * (0.16 + ghosts * 0.22) + tip * 0.5);
  if (alpha < 0.004) discard;
  vec3 col = vTint * (0.7 + 0.5 * ghosts) + vec3(1.0) * tip * 0.8;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const LED_VERT = /* glsl */ `
varying vec3 vBody;
void main() {
  vBody = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LED_FRAG = /* glsl */ `
uniform float uTime;
uniform float uArmed;
uniform float uBoost;
uniform vec3 uFront;
uniform vec3 uRear;
varying vec3 vBody;
void main() {
  // front (−Z) green, rear red: disarmed breathes, armed is solid with a running chase
  float rad = length(vBody.xz) / 0.05;
  vec3 side = vBody.z < 0.0 ? uFront : uRear;
  float breathe = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 2.6));
  float chase = 0.7 + 0.3 * smoothstep(0.3, 0.0, abs(fract(rad * 1.5 - uTime * 3.0) - 0.5));
  vec3 col = side * mix(breathe, chase, uArmed) * (3.2 + uBoost);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class DroneModel {
  readonly root = new THREE.Group();
  /** tilting FPV camera assembly (hidden in FPV view) */
  readonly camera = new THREE.Group();
  private readonly propsCCW: THREE.InstancedMesh;
  private readonly propsCW: THREE.InstancedMesh;
  private readonly blur: THREE.InstancedMesh;
  private readonly blurRpm: THREE.InstancedBufferAttribute;
  private readonly ledMat: THREE.ShaderMaterial;
  private readonly propMat: THREE.MeshPhysicalMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly glint: THREE.Sprite;
  /** front (green) / rear (red) glows of constant screen size; hidden from the FPV lens */
  readonly navLights = new THREE.Group();
  private readonly angles = [0, 0, 0, 0];
  private readonly propIndex: { mesh: THREE.InstancedMesh; slot: number }[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly ownMaterials: THREE.Material[] = [];
  private armedBlend = 0;
  private tiltDeg = NaN;

  constructor(mats: Materials) {
    this.root.name = 'drone';
    const batch = new StaticBatcher();
    const I = new THREE.Matrix4();
    const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
      _q.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
      return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, _s);
    };
    const opts = { castShadow: false };

    // Frame: bottom plate at y -0.0015..0.0015, top plate above the stack.
    batch.add('carbon', mats.carbon, extrudePlate(plateShape(), 0.0022), at(0, -0.0011, 0), opts);
    const top = new THREE.Shape();
    top.absellipse(0, 0, 0.018, 0.03, 0, Math.PI * 2, false, 0);
    const topHole = new THREE.Path();
    topHole.absellipse(0, 0.012, 0.006, 0.004, 0, Math.PI * 2, true, 0);
    top.holes.push(topHole);
    batch.add('carbon', mats.carbon, extrudePlate([top], 0.0018), at(0, 0.0235, 0), opts);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      batch.add('anodized', mats.anodized, new THREE.CylinderGeometry(0.0022, 0.0022, 0.022, 10), at(sx * 0.013, 0.0125, sz * 0.022), opts);
    }
    // Stack: ESC + FC boards
    batch.add('pcb', mats.pcb, new THREE.BoxGeometry(0.026, 0.0016, 0.026), at(0, 0.006, 0), opts);
    batch.add('pcb', mats.pcb, new THREE.BoxGeometry(0.026, 0.0016, 0.026), at(0, 0.014, 0), opts);
    batch.add('motorBase', mats.motorBase, new THREE.BoxGeometry(0.008, 0.002, 0.008), at(0, 0.0158, 0), opts);
    batch.add('motorBase', mats.motorBase, new THREE.BoxGeometry(0.01, 0.002, 0.006), at(0.006, 0.0078, 0.004), opts);

    // Motors, ducts, bumpers
    const duct = ductGeometry();
    const tpuFront = mats.tpu.clone();
    tpuFront.color.set(0x2c9a4e);
    tpuFront.sheenColor.set(0x9fffc0);
    const tpuRear = mats.tpu.clone();
    tpuRear.color.set(0xa3302a);
    tpuRear.sheenColor.set(0xffb0a0);
    this.ownMaterials.push(tpuFront, tpuRear);
    for (const m of MOTOR_LAYOUT) {
      const [mx, , mz] = m.position;
      const front = mz < 0;
      const tpuKey = front ? 'tpuFront' : 'tpuRear';
      const tpu = front ? tpuFront : tpuRear;
      batch.add('motorBase', mats.motorBase, new THREE.CylinderGeometry(0.0095, 0.0098, 0.0026, 24), at(mx, 0.0024, mz), opts);
      batch.add('copper', mats.copper, new THREE.CylinderGeometry(0.0086, 0.0086, 0.004, 24), at(mx, 0.0056, mz), opts);
      batch.add('anodized', mats.anodized, new THREE.CylinderGeometry(0.0094, 0.0096, 0.0085, 28), at(mx, 0.0118, mz), opts);
      batch.add('motorBase', mats.motorBase, new THREE.CylinderGeometry(0.0068, 0.0092, 0.0012, 28), at(mx, 0.0166, mz), opts);
      batch.add('aluminium', mats.aluminium, new THREE.CylinderGeometry(0.0012, 0.0012, 0.006, 8), at(mx, 0.0185, mz), opts);
      batch.add(tpuKey, tpu, duct.clone(), at(mx, 0, mz), opts);
      const len = Math.hypot(mx, mz);
      const ox = mx / len;
      const oz = mz / len;
      batch.add('wireBlack', mats.wireBlack, new THREE.CylinderGeometry(0.0042, 0.0034, 0.012, 12), at(mx + ox * 0.043, -0.018, mz + oz * 0.043), opts);
      // arm bracing ribs (TPU) from duct to frame body
      batch.add(tpuKey, tpu, new THREE.BoxGeometry(0.004, 0.012, 0.02), at(mx - ox * 0.035, -0.006, mz - oz * 0.035, 0, Math.atan2(ox, oz), 0), opts);
    }
    duct.dispose();

    // Battery + straps + XT30 + leads
    batch.add('battery', mats.battery, new RoundedBoxGeometry(0.034, 0.027, 0.058, 3, 0.004), at(0, 0.039, 0.012), opts);
    for (const z of [-0.004, 0.028]) {
      batch.add('strap', mats.strap, new RoundedBoxGeometry(0.036, 0.0295, 0.011, 2, 0.003), at(0, 0.0385, z), opts);
    }
    batch.add('connector', mats.connector, new RoundedBoxGeometry(0.011, 0.006, 0.014, 2, 0.0015), at(0.004, 0.03, 0.054, 0, 0.3, 0), opts);
    const wire = (x: number, mat: THREE.Material, key: string) => {
      const c = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, 0.034, 0.041),
        new THREE.Vector3(x * 1.4, 0.036, 0.05),
        new THREE.Vector3(x + 0.002, 0.031, 0.052),
      ]);
      batch.add(key, mat, new THREE.TubeGeometry(c, 12, 0.0014, 6, false), I, opts);
    };
    wire(-0.004, mats.wireRed, 'wireRed');
    wire(0.006, mats.wireBlack, 'wireBlack');

    // Camera cage side plates (carbon)
    const cage = new THREE.Shape();
    cage.moveTo(0, 0);
    cage.lineTo(0.03, 0);
    cage.lineTo(0.026, 0.028);
    cage.lineTo(0.004, 0.03);
    cage.closePath();
    const camHole = new THREE.Path();
    camHole.absarc(0.017, 0.016, 0.0025, 0, Math.PI * 2, true);
    cage.holes.push(camHole);
    for (const sx of [-1, 1]) {
      const g = new THREE.ExtrudeGeometry(cage, { depth: 0.0016, bevelEnabled: true, bevelThickness: 0.0003, bevelSize: 0.0003, bevelSegments: 1 });
      scaleUV(g, 1 / WEAVE_TILE);
      batch.add('carbon', mats.carbon, g, at(sx * 0.0125 - 0.0008, 0.025, -0.022, 0, Math.PI / 2, 0), opts);
    }

    // Antennas: VTX whip with cap at the rear, ELRS T-antenna whiskers.
    const vtx = new THREE.CylinderGeometry(0.0011, 0.0011, 0.05, 6);
    vtx.translate(0, 0.025, 0);
    batch.add('wireBlack', mats.wireBlack, vtx, at(0.012, 0.026, 0.026, 0.75, 0, 0), opts);
    _v.set(0, 0.05, 0).applyEuler(new THREE.Euler(0.75, 0, 0));
    batch.add('anodized', mats.anodized, new THREE.CylinderGeometry(0.0038, 0.0045, 0.012, 12), at(0.012, 0.026 + _v.y, 0.026 + _v.z, 0.75, 0, 0), opts);
    for (const sx of [-1, 1]) {
      const w = new THREE.CylinderGeometry(0.0006, 0.0006, 0.035, 5);
      w.translate(0, 0.0175, 0);
      batch.add('ceramic', mats.ceramic, w, at(sx * 0.008, 0.026, 0.03, 1.25, sx * 0.6, 0), opts);
    }

    for (const mesh of batch.build(this.root)) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.geometries.push(mesh.geometry);
    }

    // Tilting camera assembly
    const camGroup = this.camera;
    camGroup.position.copy(CAMERA_PIVOT);
    const bodyG = new RoundedBoxGeometry(0.0195, 0.0195, 0.018, 2, 0.002);
    const lensG = new THREE.CylinderGeometry(0.0062, 0.0068, 0.009, 24);
    lensG.rotateX(Math.PI / 2);
    const glassG = new THREE.SphereGeometry(0.0056, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.4);
    glassG.rotateX(-Math.PI / 2);
    const ringG = new THREE.TorusGeometry(0.0063, 0.0009, 8, 28);
    this.geometries.push(bodyG, lensG, glassG, ringG);
    const body = new THREE.Mesh(bodyG, mats.camBody);
    const lens = new THREE.Mesh(lensG, mats.camBody);
    lens.position.z = -0.0125;
    const glass = new THREE.Mesh(glassG, mats.lens);
    glass.position.z = -0.0165;
    const ring = new THREE.Mesh(ringG, mats.brass);
    ring.position.z = -0.0168;
    camGroup.add(body, lens, glass, ring);
    const glintMat = new THREE.SpriteMaterial({ map: mats.radial, color: new THREE.Color(3, 3.4, 4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
    this.ownMaterials.push(glintMat);
    this.glint = new THREE.Sprite(glintMat);
    this.glint.scale.setScalar(0.03);
    this.glint.position.z = -0.019;
    camGroup.add(this.glint);
    this.root.add(camGroup);

    // Props (instanced by spin direction) + blur discs
    const ccwG = propGeometry(true);
    const cwG = propGeometry(false);
    this.geometries.push(ccwG, cwG);
    const nCCW = MOTOR_LAYOUT.filter((m) => m.spin === 1).length;
    // white base: the per-instance colour (front green / rear red) is the prop colour
    this.propMat = mats.propMat.clone();
    this.propMat.color.set(0xffffff);
    this.propMat.emissive.set(0x151515);
    this.ownMaterials.push(this.propMat);
    this.propsCCW = new THREE.InstancedMesh(ccwG, this.propMat, nCCW);
    this.propsCW = new THREE.InstancedMesh(cwG, this.propMat, MOTOR_LAYOUT.length - nCCW);
    let a = 0;
    let b = 0;
    for (const m of MOTOR_LAYOUT) {
      const col = m.position[2] < 0 ? FRONT_COLOR : REAR_COLOR;
      const mesh = m.spin === 1 ? this.propsCCW : this.propsCW;
      const slot = m.spin === 1 ? a++ : b++;
      mesh.setColorAt(slot, col);
      this.propIndex.push({ mesh, slot });
    }
    const discG = new THREE.CircleGeometry(PROP_R + 0.001, 48);
    discG.rotateX(-Math.PI / 2);
    this.geometries.push(discG);
    this.blurRpm = new THREE.InstancedBufferAttribute(new Float32Array(MOTOR_LAYOUT.length), 1);
    this.blurRpm.setUsage(THREE.DynamicDrawUsage);
    discG.setAttribute('aRpm', this.blurRpm);
    const tints = new Float32Array(MOTOR_LAYOUT.length * 3);
    MOTOR_LAYOUT.forEach((m, i) => (m.position[2] < 0 ? FRONT_COLOR : REAR_COLOR).toArray(tints, i * 3));
    discG.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.ownMaterials.push(this.blurMat);
    this.blur = new THREE.InstancedMesh(discG, this.blurMat, MOTOR_LAYOUT.length);
    this.blur.renderOrder = 2;
    for (const im of [this.propsCCW, this.propsCW, this.blur]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      this.root.add(im);
    }

    // RGB LED strips under the arms + rear bar
    const ledParts: THREE.BufferGeometry[] = [];
    for (const m of MOTOR_LAYOUT) {
      const [mx, , mz] = m.position;
      const len = Math.hypot(mx, mz);
      const g = new THREE.BoxGeometry(0.003, 0.0018, 0.03, 1, 1, 6);
      g.rotateY(Math.atan2(mx, mz));
      g.translate((mx / len) * 0.03, -0.0022, (mz / len) * 0.03);
      ledParts.push(g.toNonIndexed());
      g.dispose();
    }
    const rear = new THREE.BoxGeometry(0.03, 0.0035, 0.0025, 6, 1, 1);
    rear.translate(0, 0.0012, 0.0378);
    ledParts.push(rear.toNonIndexed());
    rear.dispose();
    for (const p of ledParts) for (const n of Object.keys(p.attributes)) if (n !== 'position' && n !== 'normal') p.deleteAttribute(n);
    const ledG = mergeSimple(ledParts);
    this.geometries.push(ledG);
    this.ledMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uArmed: { value: 0 }, uBoost: { value: 0 }, uFront: { value: FRONT_COLOR.clone() }, uRear: { value: REAR_COLOR.clone() } },
      vertexShader: LED_VERT,
      fragmentShader: LED_FRAG,
    });
    this.ownMaterials.push(this.ledMat);
    const led = new THREE.Mesh(ledG, this.ledMat);
    this.root.add(led);

    for (const [z, col] of [[-0.05, FRONT_COLOR], [0.045, REAR_COLOR]] as const) {
      const m = new THREE.SpriteMaterial({ map: mats.radial, color: col.clone().multiplyScalar(2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: false, fog: false });
      this.ownMaterials.push(m);
      const glow = new THREE.Sprite(m);
      glow.scale.setScalar(NAV_GLOW_SIZE);
      glow.position.set(0, 0.012, z);
      this.navLights.add(glow);
    }
    this.navLights.name = 'nav-lights';
    this.root.add(this.navLights);

    this.updateProps([0, 0, 0, 0]);
  }

  /** Sync pose, prop spin, blur, LEDs and camera tilt. `eye` = active camera world position. */
  update(state: DroneState, dt: number, time: number, cameraTiltDeg: number, eye: THREE.Vector3): void {
    this.root.position.copy(state.position);
    this.root.quaternion.copy(state.orientation);
    this.root.updateMatrixWorld();

    for (let i = 0; i < 4; i++) {
      const m = state.motors[i];
      this.angles[i] = (this.angles[i] + MOTOR_LAYOUT[i].spin * m * VIS_MAX_SPIN * dt) % (Math.PI * 2);
    }
    this.updateProps(state.motors);

    let avg = 0;
    for (let i = 0; i < 4; i++) avg += state.motors[i];
    avg *= 0.25;
    this.propMat.opacity = 0.9 - Math.min(1, avg * 1.6) * 0.72;

    this.armedBlend += ((state.armed ? 1 : 0) - this.armedBlend) * Math.min(1, dt * 6);
    this.ledMat.uniforms.uTime.value = time;
    this.ledMat.uniforms.uArmed.value = this.armedBlend;
    this.ledMat.uniforms.uBoost.value = Math.max(0, this.ledMat.uniforms.uBoost.value - dt * 4);

    if (cameraTiltDeg !== this.tiltDeg) {
      this.tiltDeg = cameraTiltDeg;
      this.camera.rotation.x = THREE.MathUtils.degToRad(cameraTiltDeg);
    }
    // lens glint: bright when the viewer is near the lens axis
    this.camera.updateMatrixWorld();
    this.glint.getWorldPosition(_p);
    _v.copy(eye).sub(_p).normalize();
    _p.set(0, 0, -1).transformDirection(this.camera.matrixWorld);
    const facing = Math.max(0, _v.dot(_p));
    (this.glint.material as THREE.SpriteMaterial).opacity = Math.pow(facing, 12) * (0.6 + 0.4 * Math.sin(time * 3.1));
  }

  /** Flash LEDs (ring pass / respawn). */
  flash(amount = 4): void {
    this.ledMat.uniforms.uBoost.value = amount;
  }

  private updateProps(motors: readonly number[]): void {
    for (let i = 0; i < MOTOR_LAYOUT.length; i++) {
      const pos = MOTOR_LAYOUT[i].position;
      _q.setFromAxisAngle(_up, this.angles[i]);
      _p.set(pos[0], pos[1], pos[2]);
      _m.compose(_p, _q, _s);
      const pi = this.propIndex[i];
      pi.mesh.setMatrixAt(pi.slot, _m);
      _p.y += 0.0015;
      _m.compose(_p, _q, _s);
      this.blur.setMatrixAt(i, _m);
      this.blurRpm.setX(i, Math.min(1, Math.max(0, (motors[i] - 0.04) * 2.2)));
    }
    this.propsCCW.instanceMatrix.needsUpdate = true;
    this.propsCW.instanceMatrix.needsUpdate = true;
    this.blur.instanceMatrix.needsUpdate = true;
    this.blurRpm.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.ownMaterials) m.dispose();
    this.propsCCW.dispose();
    this.propsCW.dispose();
    this.blur.dispose();
  }
}
