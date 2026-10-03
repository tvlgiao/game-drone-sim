/**
 * Camera motion blur: each pixel's world position (from depth) is reprojected with last frame's
 * view-projection, and the colour is averaged along that screen-space velocity. Only camera motion is
 * captured, which is exactly the FPV case (the quad itself is not in view). Normalised to a 1/60 s
 * shutter so the streak length does not depend on the frame rate.
 */
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const SAMPLES = 8;
const SHUTTER = 1 / 60;
/** longest streak as a fraction of the screen: keeps whip pans readable */
const MAX_BLUR = 0.035;

const FRAG = /* glsl */ `
uniform mat4 blurProjInv;
uniform mat4 blurCamWorld;
uniform mat4 blurPrevViewProj;
uniform float blurScale;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 view = blurProjInv * vec4(vec3(uv, min(depth, 0.99999)) * 2.0 - 1.0, 1.0);
  view /= view.w;
  vec4 world = blurCamWorld * vec4(view.xyz, 1.0);
  vec4 prev = blurPrevViewProj * world;
  vec2 prevUv = prev.xy / max(prev.w, 1e-4) * 0.5 + 0.5;
  vec2 vel = (uv - prevUv) * blurScale;
  float len = length(vel);
  if (len < 0.0005) {
    outputColor = inputColor;
    return;
  }
  vel *= min(1.0, ${MAX_BLUR.toFixed(4)} / len);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${SAMPLES}; i++) {
    float t = float(i) / float(${SAMPLES - 1}) - 0.5;
    acc += texture2D(inputBuffer, clamp(uv + vel * t, 0.0, 1.0)).rgb;
  }
  outputColor = vec4(acc / float(${SAMPLES}), inputColor.a);
}
`;

export class MotionBlurEffect extends Effect {
  private readonly prevViewProj = new THREE.Matrix4();
  private primed = false;
  /** 0..1 strength scale, driven by flight speed */
  amount = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    super('MotionBlurEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['blurProjInv', new THREE.Uniform(new THREE.Matrix4())],
        ['blurCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['blurPrevViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['blurScale', new THREE.Uniform(0)],
      ]),
    });
  }

  /** forget last frame's camera (cuts, respawns, mode switches would smear the whole screen) */
  reset(): void {
    this.primed = false;
  }

  override update(_renderer: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, deltaTime?: number): void {
    const cam = this.camera;
    const u = this.uniforms;
    (u.get('blurProjInv')!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (u.get('blurCamWorld')!.value as THREE.Matrix4).copy(cam.matrixWorld);
    const prev = u.get('blurPrevViewProj')!.value as THREE.Matrix4;
    if (this.primed) prev.copy(this.prevViewProj);
    else prev.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const dt = deltaTime && deltaTime > 0 ? deltaTime : SHUTTER;
    u.get('blurScale')!.value = this.primed ? this.amount * Math.min(2, SHUTTER / dt) : 0;
    this.prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.primed = true;
  }
}
