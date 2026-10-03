/**
 * Optional "analog FPV feed" look as a postprocessing Effect: 240-line scanlines, luma noise that
 * changes every frame, a slow rolling sync bar, slightly crushed chroma and lifted blacks, a lens
 * vignette. No neighbour sampling, so it merges into the main EffectPass (one fullscreen pass).
 * Intensity 0 leaves the image untouched; drive it only for the FPV camera.
 */
import { Uniform } from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uTime;

float avHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  // analog chroma: less saturated, blacks lifted toward a cold grey
  vec3 a = mix(vec3(luma), c, 0.78);
  a = a * 0.95 + vec3(0.012, 0.013, 0.016);
  float scan = 0.88 + 0.12 * sin(uv.y * 240.0 * 3.14159265);
  float noise = (avHash(uv * resolution + fract(uTime * 37.0) * 91.7) - 0.5) * 0.06;
  float bar = 1.0 - 0.07 * exp(-pow((fract(uv.y * 0.6 - uTime * 0.11) - 0.5) * 7.0, 2.0));
  vec2 v = uv - 0.5;
  float vig = 1.0 - dot(v, v) * 0.9;
  a = (a * scan * bar + noise) * vig;
  outputColor = vec4(mix(c, a, uIntensity), inputColor.a);
}
`;

export class AnalogVideoEffect extends Effect {
  constructor(intensity = 1) {
    super('AnalogVideoEffect', FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['uIntensity', new Uniform(Math.min(1, Math.max(0, intensity)))],
        ['uTime', new Uniform(0)],
      ]),
    });
  }

  /** 0 = off (pass-through), 1 = full analog look. */
  get intensity(): number {
    return this.uniforms.get('uIntensity')!.value as number;
  }

  set intensity(v: number) {
    this.uniforms.get('uIntensity')!.value = Math.min(1, Math.max(0, v));
  }

  override update(_renderer: unknown, _input: unknown, deltaTime = 0): void {
    const t = this.uniforms.get('uTime')!;
    t.value = ((t.value as number) + deltaTime) % 1000;
  }
}

/** Factory for the pipeline: add the returned effect to the main EffectPass (after tone mapping). */
export function createAnalogVideoEffect(intensity = 0): AnalogVideoEffect {
  return new AnalogVideoEffect(intensity);
}
