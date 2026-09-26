/** Quality tiers, GPU probing and dynamic-resolution control (design §7). */
import type { QualityTier } from '../types';

export interface QualityProfile {
  tier: QualityTier;
  shadows: boolean;
  shadowMapSize: number;
  post: boolean;
  bloom: boolean;
  smaa: boolean;
  maxDpr: number;
  /** particle budget multiplier base (dust motes count) */
  particles: number;
  envMap: boolean;
  /** number of cheap (non-shadow) point lights allowed */
  pointLights: number;
  /** number of shadow-casting spot lights */
  shadowSpots: number;
  /** volumetric-looking light shafts */
  shafts: boolean;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  ultra: {
    tier: 'ultra', shadows: true, shadowMapSize: 4096, post: true, bloom: true, smaa: true,
    maxDpr: 1.5, particles: 1600, envMap: true, pointLights: 8, shadowSpots: 2, shafts: true,
  },
  high: {
    tier: 'high', shadows: true, shadowMapSize: 2048, post: true, bloom: true, smaa: true,
    maxDpr: 1.25, particles: 1000, envMap: true, pointLights: 8, shadowSpots: 1, shafts: true,
  },
  medium: {
    tier: 'medium', shadows: true, shadowMapSize: 1024, post: true, bloom: true, smaa: false,
    maxDpr: 1, particles: 500, envMap: true, pointLights: 4, shadowSpots: 0, shafts: true,
  },
  low: {
    tier: 'low', shadows: false, shadowMapSize: 512, post: false, bloom: false, smaa: false,
    maxDpr: 0.75, particles: 150, envMap: false, pointLights: 2, shadowSpots: 0, shafts: false,
  },
};

export interface GpuInfo {
  webgl2: boolean;
  software: boolean;
  renderer: string;
}

const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

/** Probe the GPU with a throwaway WebGL2 context; the context is released immediately. */
export function probeGpu(): GpuInfo {
  const info: GpuInfo = { webgl2: false, software: false, renderer: 'unknown' };
  if (typeof document === 'undefined') return info;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) {
      // Either no WebGL2 at all, or only a software path exists.
      const soft = canvas.getContext('webgl2');
      if (soft) {
        info.webgl2 = true;
        info.software = true;
        info.renderer = readRenderer(soft);
        soft.getExtension('WEBGL_lose_context')?.loseContext();
      }
      return info;
    }
    info.webgl2 = true;
    info.renderer = readRenderer(gl);
    info.software = SOFTWARE_RE.test(info.renderer);
  } catch {
    return info;
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return info;
}

function readRenderer(gl: WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return typeof r === 'string' ? r : 'unknown';
}

/** Map GPU info to a starting tier; dynamic resolution fine-tunes from there. */
export function pickTier(info: GpuInfo): QualityTier {
  if (!info.webgl2 || info.software) return 'low';
  const r = info.renderer.toLowerCase();
  if (/apple m\d+ (pro|max|ultra)|rtx [3-9]\d{3}|rtx \d{2}[5-9]0|radeon rx [67-9]\d{3}|radeon pro w/.test(r)) return 'ultra';
  if (/apple (m\d|gpu)|rtx|radeon rx|radeon pro|geforce gtx 1[06-9]|arc a\d/.test(r)) return 'high';
  if (/intel|iris|uhd|adreno|mali|powervr|radeon/.test(r)) return 'medium';
  return 'high';
}

/** EMA-filtered frame-time controller for render scale with hysteresis. */
export class DynamicResolution {
  private ema = 0;
  private scale = 1;
  private cooldown = 0;
  private readonly targetMs: number;

  constructor(targetFps: number) {
    this.targetMs = 1000 / Math.max(1, targetFps);
  }

  /** returns render scale 0.5..1 */
  update(frameMs: number): number {
    if (!(frameMs > 0) || frameMs > 250) return this.scale;
    this.ema = this.ema === 0 ? frameMs : this.ema + (frameMs - this.ema) * 0.08;
    if (this.cooldown > 0) {
      this.cooldown--;
      return this.scale;
    }
    if (this.ema > this.targetMs * 1.12 && this.scale > 0.5) {
      this.scale = Math.max(0.5, this.scale - 0.05);
      this.cooldown = 30;
    } else if (this.ema < this.targetMs * 1.04 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.cooldown = 90;
    }
    return this.scale;
  }

  reset(): void {
    this.ema = 0;
    this.scale = 1;
    this.cooldown = 0;
  }
}
