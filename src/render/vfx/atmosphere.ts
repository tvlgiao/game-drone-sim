/** Moonlight shafts (additive soft prisms) and floating dust motes that live inside them. */
import * as THREE from 'three';
import type { WindowInfo } from '../room';
import { mulberry32 } from '../textures';

const SHAFT_VERT = /* glsl */ `
attribute vec2 aFace;   // x across face 0..1, y along shaft 0..1
varying vec2 vFace;
varying vec3 vWorld;
varying float vFacing;
void main() {
  vFace = aFace;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  // degenerate curtain triangles get a zero normal: normalize(0) is NaN on most GPUs
  vec3 n = mat3(modelMatrix) * normal;
  float nl = length(n);
  vec3 v = normalize(cameraPosition - wp.xyz);
  vFacing = nl > 1e-5 ? abs(dot(n / nl, v)) : 0.0;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SHAFT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec2 vFace;
varying vec3 vWorld;
varying float vFacing;
void main() {
  float across = sin(3.14159 * vFace.x);
  // pow() of a negative base is NaN, and interpolation overshoots vFace.y past 1.0 at some pixels;
  // one NaN pixel, spread by the bloom blur, blacked out whole blocks of the frame at 2560x1440
  float along = pow(clamp(1.0 - vFace.y, 0.0, 1.0), 1.2) * smoothstep(0.0, 0.08, vFace.y);
  // cheap drifting haze modulation (two crossed sine fields)
  float n = 0.7 + 0.15 * sin(vWorld.x * 2.3 + vWorld.y * 1.7 + uTime * 0.4) + 0.15 * sin(vWorld.z * 1.9 - vWorld.y * 2.9 - uTime * 0.3);
  float a = clamp(across * along * pow(clamp(vFacing, 0.0, 1.0), 1.4) * n * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(uColor * a, 1.0);
  #include <colorspace_fragment>
}`;

const DUST_VERT = /* glsl */ `
attribute vec4 aData; // phase, brightness, size, warm
uniform float uTime;
uniform float uPx;
uniform vec3 uDrone;
uniform float uWash;
varying float vB;
varying float vWarm;
void main() {
  float ph = aData.x;
  vec3 p = position;
  p += vec3(sin(uTime * 0.21 + ph * 6.1), sin(uTime * 0.13 + ph * 3.7) * 0.6, cos(uTime * 0.17 + ph * 5.3)) * 0.18;
  vec3 d = p - uDrone;
  float dist = length(d);
  p += d / max(dist, 1e-3) * uWash * smoothstep(1.2, 0.0, dist) * 0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.6 + 0.4 * sin(uTime * (1.3 + ph) + ph * 17.0);
  // fine dust: fade out close to the camera so motes never become big glowing orbs
  float depth = -mv.z;
  vB = aData.y * tw * smoothstep(0.35, 0.9, depth) * 0.55;
  vWarm = aData.w;
  gl_PointSize = clamp(aData.z * uPx / max(0.1, depth), 1.0, 4.5);
}`;

const DUST_FRAG = /* glsl */ `
varying float vB;
varying float vWarm;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 4.0) * vB;
  vec3 col = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.72, 0.45), vWarm);
  gl_FragColor = vec4(col * a, 1.0);
  #include <colorspace_fragment>
}`;

export class Atmosphere {
  readonly shafts: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly dust: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly maxDust: number;

  constructor(windows: readonly WindowInfo[], moonDir: THREE.Vector3, warmSources: readonly THREE.Vector3[], maxDust = 2000) {
    this.maxDust = maxDust;
    // --- shafts -------------------------------------------------------------------------
    const pos: number[] = [];
    const face: number[] = [];
    const lit = windows.filter((w) => w.inward.dot(moonDir) > 0.15);
    const far = (c: THREE.Vector3) => c.clone().addScaledVector(moonDir, (c.y / -moonDir.y) * 0.97);
    for (const w of lit) {
      const c = w.corners;
      const f = c.map(far);
      for (let k = 0; k < 4; k++) {
        const a = c[k];
        const b = c[(k + 1) % 4];
        const fa = f[k];
        const fb = f[(k + 1) % 4];
        // two triangles: a, b, fb / a, fb, fa
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, fb.x, fb.y, fb.z, a.x, a.y, a.z, fb.x, fb.y, fb.z, fa.x, fa.y, fa.z);
        face.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      }
      // two internal curtains through the middle for volume
      for (const s of [0.33, 0.66]) {
        const a = c[0].clone().lerp(c[1], s);
        const b = c[3].clone().lerp(c[2], s);
        const fa = far(a);
        const fb = far(b);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, fb.x, fb.y, fb.z, a.x, a.y, a.z, fb.x, fb.y, fb.z, fa.x, fa.y, fa.z);
        face.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    sg.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 2));
    sg.computeVertexNormals();
    this.shafts = new THREE.Mesh(
      sg,
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0.42, 0.55, 0.9) }, uIntensity: { value: 0.16 }, uTime: { value: 0 } },
        vertexShader: SHAFT_VERT,
        fragmentShader: SHAFT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.shafts.renderOrder = 5;
    this.shafts.frustumCulled = false;

    // --- dust motes ----------------------------------------------------------------------
    const rnd = mulberry32(99);
    const dp = new Float32Array(maxDust * 3);
    const dd = new Float32Array(maxDust * 4);
    for (let i = 0; i < maxDust; i++) {
      const pick = rnd();
      let x: number;
      let y: number;
      let z: number;
      let b: number;
      let warm = 0;
      if (pick < 0.62 && lit.length > 0) {
        const w = lit[Math.floor(rnd() * lit.length)];
        const u = rnd();
        const v = rnd();
        const c = w.corners;
        x = c[0].x + (c[1].x - c[0].x) * u + (c[3].x - c[0].x) * v;
        y = c[0].y + (c[1].y - c[0].y) * u + (c[3].y - c[0].y) * v;
        z = c[0].z + (c[1].z - c[0].z) * u + (c[3].z - c[0].z) * v;
        const l = (y / -moonDir.y) * Math.pow(rnd(), 0.8);
        x += moonDir.x * l;
        y += moonDir.y * l;
        z += moonDir.z * l;
        b = 0.55 + rnd() * 0.45;
      } else if (pick < 0.8 && warmSources.length > 0) {
        const s = warmSources[Math.floor(rnd() * warmSources.length)];
        const r = Math.cbrt(rnd()) * 1.4;
        const th = rnd() * Math.PI * 2;
        const ph = Math.acos(2 * rnd() - 1);
        x = s.x + r * Math.sin(ph) * Math.cos(th);
        y = Math.max(0.2, s.y - 0.4 + r * Math.cos(ph));
        z = s.z + r * Math.sin(ph) * Math.sin(th);
        b = 0.45 + rnd() * 0.4;
        warm = 1;
      } else {
        x = (rnd() - 0.5) * 23;
        y = 0.2 + rnd() * 5.5;
        z = (rnd() - 0.5) * 13;
        b = 0.08 + rnd() * 0.12;
      }
      dp[i * 3] = x;
      dp[i * 3 + 1] = y;
      dp[i * 3 + 2] = z;
      dd[i * 4] = rnd();
      dd[i * 4 + 1] = b;
      dd[i * 4 + 2] = 0.01 + rnd() * 0.012;
      dd[i * 4 + 3] = warm;
    }
    // shuffle so any drawRange prefix keeps the same mix
    for (let i = maxDust - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      for (let k = 0; k < 3; k++) [dp[i * 3 + k], dp[j * 3 + k]] = [dp[j * 3 + k], dp[i * 3 + k]];
      for (let k = 0; k < 4; k++) [dd[i * 4 + k], dd[j * 4 + k]] = [dd[j * 4 + k], dd[i * 4 + k]];
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dg.setAttribute('aData', new THREE.BufferAttribute(dd, 4));
    this.dust = new THREE.Points(
      dg,
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uPx: { value: 800 }, uDrone: { value: new THREE.Vector3(0, -10, 0) }, uWash: { value: 0 } },
        vertexShader: DUST_VERT,
        fragmentShader: DUST_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 5;
  }

  setQuality(dustCount: number, shafts: boolean): void {
    this.dust.geometry.setDrawRange(0, Math.min(this.maxDust, dustCount));
    this.shafts.visible = shafts;
  }

  update(time: number, px: number, drone: THREE.Vector3, wash: number): void {
    this.shafts.material.uniforms.uTime.value = time;
    const u = this.dust.material.uniforms;
    u.uTime.value = time;
    u.uPx.value = px;
    u.uDrone.value.copy(drone);
    u.uWash.value = wash;
  }

  dispose(): void {
    this.shafts.geometry.dispose();
    this.shafts.material.dispose();
    this.dust.geometry.dispose();
    this.dust.material.dispose();
  }
}
