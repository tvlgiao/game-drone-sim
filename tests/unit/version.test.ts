import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { APP_VERSION } from '../../src/ui/menus';

describe('app version', () => {
  it('the About screen version is package.json, injected by the vite define (also under vitest)', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });
});
