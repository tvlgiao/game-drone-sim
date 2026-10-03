import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CC0_SETS, LEVEL_TEXTURE_SETS, cc0Credits, type Cc0SetId } from '../../src/render/materials/assets';
import { QUALITY_PROFILES } from '../../src/core/quality';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CC0_DIR = join(ROOT, 'src/render/materials/cc0');
const MB = 1024 * 1024;
/** every texture / HDRI the visual upgrade ships with the web build */
const WEB_BUDGET = 12 * MB;
/** what one level may pull onto a Quest 2 (flat browser tiers; VR runs the low tier and loads none) */
const QUEST_LEVEL_BUDGET = 6 * MB;

function files(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out = statSync(p).isDirectory() ? out.concat(files(p)) : out.concat(p);
  }
  return out;
}

const setBytes = (id: Cc0SetId): number => files(join(CC0_DIR, CC0_SETS[id].slug)).reduce((s, f) => s + statSync(f).size, 0);

describe('asset budget', () => {
  it(`all shipped texture sets fit ${WEB_BUDGET / MB} MB`, () => {
    const total = files(CC0_DIR).reduce((s, f) => s + statSync(f).size, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(WEB_BUDGET);
  });

  it(`each level loads at most ${QUEST_LEVEL_BUDGET / MB} MB of texture sets`, () => {
    for (const [level, ids] of Object.entries(LEVEL_TEXTURE_SETS)) {
      const bytes = ids!.reduce((s, id) => s + setBytes(id), 0);
      expect(bytes, level).toBeLessThanOrEqual(QUEST_LEVEL_BUDGET);
    }
  });

  it('the VR tier (low) downloads no texture sets', () => {
    expect(QUALITY_PROFILES.low.pbrTextures).toBe(false);
  });

  it('every set folder is in the manifest (no orphan downloads) and every manifest set is complete WebP', () => {
    const slugs = new Set(Object.values(CC0_SETS).map((s) => s.slug));
    for (const dir of readdirSync(CC0_DIR)) expect(slugs.has(dir), dir).toBe(true);
    for (const s of Object.values(CC0_SETS)) {
      const names = readdirSync(join(CC0_DIR, s.slug)).sort();
      expect(names).toEqual(['albedo.webp', 'arm.webp', 'normal.webp']);
      for (const n of names) expect(readFileSync(join(CC0_DIR, s.slug, n)).subarray(8, 12).toString('latin1')).toBe('WEBP');
    }
  });

  it('licences file credits every CC0 set', () => {
    const licences = readFileSync(join(ROOT, 'public/licenses.txt'), 'utf8');
    expect(licences).toContain('CC0 1.0');
    for (const line of cc0Credits()) expect(licences).toContain(line);
  });
});
