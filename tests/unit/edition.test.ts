import { describe, expect, it } from 'vitest';
import { detectEdition, editionCaps } from '../../src/core/edition';

describe('detectEdition', () => {
  it('/play/ is the free web game, /app/ the Quest store app (with or without index.html)', () => {
    expect(detectEdition('/play/', false, false)).toBe('web-free');
    expect(detectEdition('/play/index.html', false, false)).toBe('web-free');
    expect(detectEdition('/app/', false, false)).toBe('quest-app');
    expect(detectEdition('/app/index.html', false, false)).toBe('quest-app');
  });

  it('works under a sub-path (GitHub Pages project site)', () => {
    expect(detectEdition('/game-drone-sim/play/', false, false)).toBe('web-free');
    expect(detectEdition('/game-drone-sim/app/', false, false)).toBe('quest-app');
  });

  it('the Capacitor shell is native whatever its path', () => {
    expect(detectEdition('/', true, false)).toBe('native');
    expect(detectEdition('/app/', true, false)).toBe('native');
  });

  it('an unknown path is dev under `npm run dev` and the free web edition in a production build', () => {
    expect(detectEdition('/render-preview.html', false, true)).toBe('dev');
    expect(detectEdition('/', false, false)).toBe('web-free');
    expect(detectEdition('/apple/', false, false)).toBe('web-free');
    expect(detectEdition('/app/extra', false, false)).toBe('web-free');
  });
});

describe('editionCaps', () => {
  it('only the Quest app and dev get VR; only the Quest app checks ownership', () => {
    expect(editionCaps('web-free')).toEqual({ vr: false, ownershipCheck: false });
    expect(editionCaps('quest-app')).toEqual({ vr: true, ownershipCheck: true });
    expect(editionCaps('native')).toEqual({ vr: false, ownershipCheck: false });
    expect(editionCaps('dev')).toEqual({ vr: true, ownershipCheck: false });
  });
});
