import { describe, expect, it } from 'vitest';
import { QUALITY_PROFILES, qualityProfile, type QualityProfile } from '../../src/core/quality';
import type { QualityTier } from '../../src/types';

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
const AO_RANK = { off: 0, medium: 1, high: 2 } as const;

describe('render pipeline tier knobs', () => {
  it('every knob is monotonic from low to ultra (a higher tier never drops an effect)', () => {
    for (let i = 1; i < ORDER.length; i++) {
      const lo = QUALITY_PROFILES[ORDER[i - 1]!];
      const hi = QUALITY_PROFILES[ORDER[i]!];
      const flags: (keyof QualityProfile)[] = ['post', 'sunCascades', 'aerial', 'grain', 'menuDof', 'motionBlur', 'pbrTextures', 'envMap', 'shadows'];
      for (const f of flags) if (lo[f]) expect(hi[f], `${String(f)} ${lo.tier}→${hi.tier}`).toBe(true);
      expect(AO_RANK[hi.ao]).toBeGreaterThanOrEqual(AO_RANK[lo.ao]);
      expect(hi.textureSize).toBeGreaterThanOrEqual(lo.textureSize);
      expect(hi.envSize).toBeGreaterThanOrEqual(lo.envSize);
      if (lo.glass === 'transmission') expect(hi.glass).toBe('transmission');
    }
  });

  it('low (also the VR tier on Quest) runs no post-only effect, no cascades and loads no texture sets', () => {
    const low = QUALITY_PROFILES.low;
    expect(low.post).toBe(false);
    expect(low.ao).toBe('off');
    expect([low.sunCascades, low.aerial, low.grain, low.menuDof, low.motionBlur, low.pbrTextures]).toEqual([false, false, false, false, false, false]);
    expect(low.glass).toBe('reflective');
  });

  it('post-only effects are only enabled on tiers that run the post stack', () => {
    for (const p of Object.values(QUALITY_PROFILES)) {
      if (p.post) continue;
      expect(p.ao).toBe('off');
      expect(p.aerial || p.grain || p.menuDof || p.motionBlur).toBe(false);
    }
  });

  it('cascaded sun shadows and AO only on high and ultra; medium keeps the single static map', () => {
    expect(QUALITY_PROFILES.ultra.sunCascades && QUALITY_PROFILES.high.sunCascades).toBe(true);
    expect(QUALITY_PROFILES.medium.sunCascades).toBe(false);
    expect(QUALITY_PROFILES.medium.shadows).toBe(true);
    expect(QUALITY_PROFILES.ultra.ao).toBe('high');
    expect(QUALITY_PROFILES.high.ao).toBe('medium');
    expect(QUALITY_PROFILES.medium.ao).toBe('off');
  });

  it('phones drop AO, motion blur and transmission glass; tablets keep medium AO; sizes are capped', () => {
    const phone = qualityProfile('ultra', 'phone');
    expect(phone.ao).toBe('off');
    expect(phone.motionBlur).toBe(false);
    expect(phone.glass).toBe('reflective');
    expect(phone.textureSize).toBeLessThanOrEqual(512);
    expect(phone.envSize).toBeLessThanOrEqual(128);
    const tablet = qualityProfile('ultra', 'tablet');
    expect(tablet.ao).toBe('medium');
    expect(tablet.glass).toBe('transmission');
    expect(tablet.shadowMapSize).toBeLessThanOrEqual(1024);
    expect(qualityProfile('low', 'tablet').ao).toBe('off');
  });
});
