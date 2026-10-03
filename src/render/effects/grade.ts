/**
 * Display-referred colour grade, merged into the main EffectPass right after tone mapping:
 * lift / gamma / gain per channel, contrast and saturation around mid grey, and a split tone
 * (shadow and highlight tints). Graded in a gamma-2.2 domain so the controls behave like a colourist's.
 */
import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

export interface Grade {
  /** added to shadows (0 = none) */
  lift: [number, number, number];
  /** midtone power (1 = none; > 1 brightens) */
  gamma: [number, number, number];
  /** highlight multiplier (1 = none) */
  gain: [number, number, number];
  /** 1 = unchanged */
  contrast: number;
  /** 1 = unchanged, 0 = greyscale */
  saturation: number;
  /** tints mixed into dark / bright tones; colour × amount, 0 = none */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
}

export const NEUTRAL_GRADE: Readonly<Grade> = {
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  contrast: 1,
  saturation: 1,
  shadowTint: [0, 0, 0],
  highlightTint: [0, 0, 0],
};

const FRAG = /* glsl */ `
uniform vec3 gradeLift;
uniform vec3 gradeGamma;
uniform vec3 gradeGain;
uniform vec3 gradeShadowTint;
uniform vec3 gradeHighlightTint;
uniform float gradeContrast;
uniform float gradeSaturation;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = pow(max(inputColor.rgb, 0.0), vec3(1.0 / 2.2));
  c = gradeGain * (c + gradeLift * (1.0 - c));
  c = pow(max(c, 0.0), 1.0 / gradeGamma);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += gradeShadowTint * (1.0 - smoothstep(0.0, 0.5, l)) + gradeHighlightTint * smoothstep(0.5, 1.0, l);
  c = (c - 0.5) * gradeContrast + 0.5;
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, gradeSaturation);
  outputColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(2.2)), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor(grade: Readonly<Grade> = NEUTRAL_GRADE) {
    super('GradeEffect', FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['gradeLift', new THREE.Uniform(new THREE.Vector3())],
        ['gradeGamma', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gradeGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gradeShadowTint', new THREE.Uniform(new THREE.Vector3())],
        ['gradeHighlightTint', new THREE.Uniform(new THREE.Vector3())],
        ['gradeContrast', new THREE.Uniform(1)],
        ['gradeSaturation', new THREE.Uniform(1)],
      ]),
    });
    this.set(grade);
  }

  set(g: Readonly<Grade>): void {
    const u = this.uniforms;
    (u.get('gradeLift')!.value as THREE.Vector3).fromArray(g.lift);
    // a zero gamma would divide by zero in the shader
    (u.get('gradeGamma')!.value as THREE.Vector3).fromArray(g.gamma.map((v) => Math.max(0.05, v)));
    (u.get('gradeGain')!.value as THREE.Vector3).fromArray(g.gain);
    (u.get('gradeShadowTint')!.value as THREE.Vector3).fromArray(g.shadowTint);
    (u.get('gradeHighlightTint')!.value as THREE.Vector3).fromArray(g.highlightTint);
    u.get('gradeContrast')!.value = g.contrast;
    u.get('gradeSaturation')!.value = g.saturation;
  }
}

const EXPOSURE_FRAG = /* glsl */ `
uniform float sceneExposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb * sceneExposure, inputColor.a);
}
`;

/** Scene-referred exposure, applied in linear HDR right before the tone curve (post path). */
export class ExposureEffect extends Effect {
  constructor(exposure = 1) {
    super('ExposureEffect', EXPOSURE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([['sceneExposure', new THREE.Uniform(exposure)]]),
    });
  }

  set exposure(v: number) {
    this.uniforms.get('sceneExposure')!.value = v;
  }

  get exposure(): number {
    return this.uniforms.get('sceneExposure')!.value as number;
  }
}
