/**
 * Post FX via pmndrs/postprocessing, in linear HDR until the tone curve:
 *
 *   RenderPass → N8AO (high+) → DoF (still menu frames) → motion blur (FPV at speed)
 *   → main EffectPass [SMAA, aerial haze, bloom, tone mapping, grade, analog FPV feed, vignette, grain] + dithering
 *   → chromatic aberration (FPV at speed)
 *
 * Convolution effects (SMAA, DoF, motion blur, CA) cannot share a pass, so the optional ones live in
 * their own passes and are enabled only while they show; a disabled pass costs nothing.
 * Exposure is an effect of its own (after bloom, so the bloom threshold stays in scene units); the
 * renderer's toneMappingExposure stays 1 on this path.
 */
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  type Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
} from 'postprocessing';
import type { QualityProfile } from '../core/quality';
import { AerialPerspectiveEffect } from './effects/aerial';
import { ExposureEffect, GradeEffect } from './effects/grade';
import { MotionBlurEffect } from './effects/motion-blur';
import { createAnalogVideoEffect, type AnalogVideoEffect } from './vfx/analog-video';
import type { LevelLook, ToneMapper } from './looks';

const TONE_MODES: Record<ToneMapper, ToneMappingMode> = {
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
  neutral: ToneMappingMode.NEUTRAL,
};

/** N8AO pass surface used here (the package ships no types for its proxy-backed configuration) */
interface AoPass extends Pass {
  configuration: Record<string, unknown> & { color: THREE.Color };
  autoDetectTransparency: boolean;
  setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  setSize(w: number, h: number): void;
}

export class PostFX {
  readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private mainPass: EffectPass | null = null;
  private caPass: EffectPass | null = null;
  private dofPass: EffectPass | null = null;
  private blurPass: EffectPass | null = null;
  private aoPass: AoPass | null = null;
  private bloom: BloomEffect | null = null;
  private ca: ChromaticAberrationEffect | null = null;
  private dof: DepthOfFieldEffect | null = null;
  private blur: MotionBlurEffect | null = null;
  private aerial: AerialPerspectiveEffect | null = null;
  private grade: GradeEffect | null = null;
  private tone: ToneMappingEffect | null = null;
  private exposure: ExposureEffect | null = null;
  private analog: AnalogVideoEffect | null = null;
  private analogIntensity = 0;
  private effects: Effect[] = [];
  private caOn = false;
  private bloomThreshold = 0.85;
  private bloomIntensity = 1;
  private readonly caOffset = new THREE.Vector2();
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private look: Readonly<LevelLook> | null = null;
  private profile: QualityProfile | null = null;
  /** bumps on every configure(): a late N8AO import for an older configuration is dropped */
  private generation = 0;
  private width = 1;
  private height = 1;

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, stencilBuffer: false, multisampling: 0 });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
  }

  /** (Re)build the effect passes for a tier and a level look. */
  configure(p: QualityProfile, look: Readonly<LevelLook>): void {
    this.clearPasses();
    this.generation++;
    this.profile = p;
    this.look = look;
    const effects: Effect[] = [];
    // medium (phones' default) gets the cheap preset: at DPR ≤ 1.5 un-antialiased edges crawl badly
    if (p.smaa) effects.push(new SMAAEffect({ preset: p.tier === 'ultra' ? SMAAPreset.HIGH : p.tier === 'high' ? SMAAPreset.MEDIUM : SMAAPreset.LOW }));
    if (p.aerial && look.aerial) {
      this.aerial = new AerialPerspectiveEffect(this.camera);
      this.aerial.configure(look.aerial, this.sunDir);
      effects.push(this.aerial);
    }
    if (p.bloom) {
      this.bloom = new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: this.bloomThreshold,
        luminanceSmoothing: look.bloom.smoothing,
        intensity: look.bloom.intensity,
        radius: look.bloom.radius,
        levels: p.tier === 'medium' ? 6 : 8,
      });
      this.bloomIntensity = look.bloom.intensity;
      effects.push(this.bloom);
    }
    this.exposure = new ExposureEffect(look.exposure);
    this.tone = new ToneMappingEffect({ mode: TONE_MODES[look.toneMapping] });
    this.grade = new GradeEffect(look.grade);
    // the analog feed works on display-referred colour: after the tone curve and grade, before the lens vignette
    this.analog = createAnalogVideoEffect(this.analogIntensity);
    effects.push(this.exposure, this.tone, this.grade, this.analog, new VignetteEffect({ offset: look.vignette.offset, darkness: look.vignette.darkness }));
    if (p.grain && look.grain > 0) {
      const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
      grain.blendMode.opacity.value = look.grain;
      effects.push(grain);
    }
    this.effects = effects;
    this.mainPass = new EffectPass(this.camera, ...effects);
    this.mainPass.dithering = true;

    if (p.menuDof) {
      this.dof = new DepthOfFieldEffect(this.camera, { focusDistance: 3, focusRange: 1.6, bokehScale: 3, resolutionScale: 0.5 });
      this.dofPass = new EffectPass(this.camera, this.dof);
      this.dofPass.enabled = false;
      this.composer.addPass(this.dofPass);
      this.effects.push(this.dof);
    }
    if (p.motionBlur) {
      this.blur = new MotionBlurEffect(this.camera);
      this.blurPass = new EffectPass(this.camera, this.blur);
      this.blurPass.enabled = false;
      this.composer.addPass(this.blurPass);
      this.effects.push(this.blur);
    }
    this.composer.addPass(this.mainPass);
    if (p.tier === 'ultra' || p.tier === 'high') {
      this.ca = new ChromaticAberrationEffect({ offset: this.caOffset, radialModulation: true, modulationOffset: 0.25 });
      this.caPass = new EffectPass(this.camera, this.ca);
      this.caPass.enabled = false;
      this.composer.addPass(this.caPass);
      this.effects.push(this.ca);
    }
    this.caOn = false;
    this.applyScreenTarget();
    this.warmUp();
    if (p.ao !== 'off') void this.loadAo(this.generation);
  }

  /**
   * Compiles every pass now: the optional ones (DoF, motion blur, CA, a late N8AO) would otherwise compile
   * on the frame they first switch on — a 0.3–1.5 s freeze on ANGLE/Metal in the middle of a flight. Renders
   * once with everything on, then once as configured so a still menu frame shows the right image.
   */
  private warmUp(): void {
    const optional = [this.dofPass, this.blurPass, this.caPass].filter((x): x is EffectPass => x !== null);
    if (optional.length === 0 && !this.aoPass) return;
    const was = optional.map((x) => x.enabled);
    for (const x of optional) x.enabled = true;
    if (this.mainPass) this.mainPass.renderToScreen = this.caPass === null;
    if (this.caPass) this.caPass.renderToScreen = true;
    this.composer.render(0);
    optional.forEach((x, i) => (x.enabled = was[i]!));
    this.blur?.reset();
    this.applyScreenTarget();
    // draw-call stats (renderer.info, reset per game frame) should describe a normal frame, not the warm-up
    this.composer.getRenderer().info.reset();
    this.composer.render(0);
  }

  /** N8AO is ~100 kB of shader code: fetched only on tiers that use it. */
  private async loadAo(gen: number): Promise<void> {
    let mod: typeof import('n8ao');
    try {
      mod = await import('n8ao');
    } catch {
      // offline without the chunk cached: the frame is still complete, only without contact darkening
      return;
    }
    if (gen !== this.generation || !this.profile || !this.look) return;
    const pass = new mod.N8AOPostPass(this.scene, this.camera, this.width, this.height) as unknown as AoPass;
    // transparent rings, glass and particles would otherwise be drawn a second time every frame
    pass.autoDetectTransparency = false;
    pass.configuration.transparencyAware = false;
    pass.configuration.gammaCorrection = false;
    // full resolution costs ~4× for detail the denoiser blurs away anyway
    pass.configuration.halfRes = true;
    pass.setQualityMode(this.profile.ao === 'high' ? 'High' : 'Medium');
    this.applyAoLook(pass, this.look);
    this.aoPass = pass;
    this.composer.addPass(pass, 1);
    pass.setSize(this.width, this.height);
    this.warmUp();
  }

  private applyAoLook(pass: AoPass, look: Readonly<LevelLook>): void {
    pass.configuration.aoRadius = look.ao.radius;
    pass.configuration.intensity = look.ao.intensity;
    pass.configuration.distanceFalloff = look.ao.falloff;
  }

  private applyScreenTarget(): void {
    if (!this.mainPass) return;
    const caActive = this.caOn && this.caPass !== null;
    this.mainPass.renderToScreen = !caActive;
    if (this.caPass) {
      this.caPass.enabled = caActive;
      this.caPass.renderToScreen = caActive;
    }
  }

  /** Direction towards the sun, for the forward-scatter glow in the aerial haze. */
  setSunDirection(dir: THREE.Vector3): void {
    this.sunDir.copy(dir).normalize();
    if (this.aerial && this.look?.aerial) this.aerial.configure(this.look.aerial, this.sunDir);
  }

  /** Chromatic aberration strength 0..1 (FPV speed). */
  setAberration(amount: number): void {
    if (!this.ca) return;
    const on = amount > 0.02;
    const o = amount * 0.0016;
    this.caOffset.set(o, o * 0.6);
    this.ca.offset = this.caOffset;
    if (on !== this.caOn) {
      this.caOn = on;
      this.applyScreenTarget();
    }
  }

  /** Camera motion blur strength 0..1 (FPV speed); 0 disables the pass. */
  setMotionBlur(amount: number): void {
    if (!this.blur || !this.blurPass) return;
    const on = amount > 0.02;
    if (on && !this.blurPass.enabled) this.blur.reset();
    this.blurPass.enabled = on;
    this.blur.amount = amount;
  }

  /**
   * Still frame behind a menu: bokeh depth of field focused on `focus` (the quad). Live frames pass
   * null. Returns whether the blur is active.
   */
  setStill(focus: THREE.Vector3 | null): boolean {
    if (!this.dof || !this.dofPass) return false;
    this.dofPass.enabled = focus !== null;
    if (focus) {
      const d = this.camera.position.distanceTo(focus);
      this.dof.cocMaterial.focusDistance = d;
      // sharp zone grows with distance so a far LOS quad is not a single sharp pixel
      this.dof.cocMaterial.focusRange = THREE.MathUtils.clamp(d * 0.45, 0.6, 6);
    }
    return focus !== null;
  }

  /**
   * Analog FPV video look (scanlines, per-frame noise, rolling sync bar, softer chroma), 0 = off. It lives
   * in the main pass, so it costs a few ALU ops per pixel and no extra pass; GameView drives it with the
   * FPV camera weight × the player's setting.
   */
  setAnalog(intensity: number): void {
    this.analogIntensity = THREE.MathUtils.clamp(intensity, 0, 1);
    if (this.analog) this.analog.intensity = this.analogIntensity;
  }

  get analogLevel(): number {
    return this.analogIntensity;
  }

  /** Scene exposure on top of the look's (e.g. a respawn flash); 1 = the look as authored. */
  setExposureScale(k: number): void {
    if (this.exposure && this.look) this.exposure.exposure = this.look.exposure * k;
  }

  setBloomThreshold(v: number): void {
    this.bloomThreshold = v;
    if (this.bloom) this.bloom.luminanceMaterial.threshold = v;
  }

  setBloomBoost(k: number): void {
    if (this.bloom) this.bloom.intensity = this.bloomIntensity * k;
  }

  get toneMapper(): ToneMapper | null {
    return this.look?.toneMapping ?? null;
  }

  /** passes that rendered last frame, for tests and the render preview */
  get activePasses(): string[] {
    return this.composer.passes.filter((p) => p.enabled).map((p) => p.name);
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.composer.setSize(w, h, false);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  private clearPasses(): void {
    for (const pass of [this.mainPass, this.caPass, this.dofPass, this.blurPass, this.aoPass]) {
      if (pass) {
        this.composer.removePass(pass);
        pass.dispose();
      }
    }
    for (const e of this.effects) e.dispose();
    this.effects = [];
    this.mainPass = null;
    this.caPass = null;
    this.dofPass = null;
    this.blurPass = null;
    this.aoPass = null;
    this.bloom = null;
    this.ca = null;
    this.dof = null;
    this.blur = null;
    this.aerial = null;
    this.grade = null;
    this.tone = null;
    this.exposure = null;
    this.analog = null;
  }

  dispose(): void {
    this.generation++;
    this.clearPasses();
    this.composer.dispose();
  }
}
