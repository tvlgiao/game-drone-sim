/**
 * Post FX via pmndrs/postprocessing: RenderPass + one merged EffectPass (SMAA, Bloom, ToneMapping,
 * Vignette). Chromatic aberration is a convolution effect that cannot merge with SMAA, so it lives
 * in a second pass that is only enabled while its intensity is non-zero (fast FPV flight).
 */
import * as THREE from 'three';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  type Effect,
} from 'postprocessing';
import type { QualityProfile } from '../core/quality';

export class PostFX {
  readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private mainPass: EffectPass | null = null;
  private caPass: EffectPass | null = null;
  private bloom: BloomEffect | null = null;
  private ca: ChromaticAberrationEffect | null = null;
  private effects: Effect[] = [];
  private caOn = false;
  private readonly caOffset = new THREE.Vector2();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, stencilBuffer: false, multisampling: 0 });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
  }

  /** (Re)build effect passes for a tier. */
  configure(p: QualityProfile): void {
    this.clearPasses();
    const effects: Effect[] = [];
    if (p.smaa) effects.push(new SMAAEffect({ preset: p.tier === 'ultra' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM }));
    if (p.bloom) {
      this.bloom = new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: 0.85,
        luminanceSmoothing: 0.25,
        intensity: 1.15,
        radius: 0.72,
        levels: p.tier === 'medium' ? 6 : 8,
      });
      effects.push(this.bloom);
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    effects.push(new VignetteEffect({ offset: 0.3, darkness: 0.55 }));
    this.effects = effects;
    this.mainPass = new EffectPass(this.camera, ...effects);
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

  /** Chromatic aberration strength 0..1 (FPV speed). */
  setAberration(amount: number): void {
    if (!this.ca) return;
    const on = amount > 0.02;
    const o = amount * 0.0022;
    this.caOffset.set(o, o * 0.6);
    this.ca.offset = this.caOffset;
    if (on !== this.caOn) {
      this.caOn = on;
      this.applyScreenTarget();
    }
  }

  setBloomBoost(k: number): void {
    if (this.bloom) this.bloom.intensity = 1.15 * k;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  private clearPasses(): void {
    for (const pass of [this.mainPass, this.caPass]) {
      if (pass) {
        this.composer.removePass(pass);
        pass.dispose();
      }
    }
    for (const e of this.effects) e.dispose();
    this.effects = [];
    this.mainPass = null;
    this.caPass = null;
    this.bloom = null;
    this.ca = null;
  }

  dispose(): void {
    this.clearPasses();
    this.composer.dispose();
  }
}
