import { describe, expect, it } from 'vitest';
import { WORLD_WORKER_RE, assertWorkerPrecached, precacheUrls, swSource } from '../../build/offline-sw';
import { legacyGameUrl } from '../../src/landing/legacy';
import { storeBadgeHtml, storeBadgesHtml } from '../../src/site/badge';
import { STORE_LINKS } from '../../src/site/stores';

const tab = { search: '', hash: '', standalone: false, quest: false };

describe('legacyGameUrl (old links to the site root, which used to be the game)', () => {
  it('a plain visit stays on the landing page', () => {
    expect(legacyGameUrl(tab)).toBeNull();
    expect(legacyGameUrl({ ...tab, search: '?utm_source=x', quest: true })).toBeNull();
  });

  it('game query strings go to the free web game, query and hash kept', () => {
    expect(legacyGameUrl({ ...tab, search: '?selftest=1' })).toBe('./play/?selftest=1');
    expect(legacyGameUrl({ ...tab, search: '?rotate=0&xremu=1', hash: '#x' })).toBe('./play/?rotate=0&xremu=1#x');
  });

  it('a home-screen install from before the split opens the game: /app/ on a Quest, /play/ elsewhere', () => {
    expect(legacyGameUrl({ ...tab, standalone: true })).toBe('./play/');
    expect(legacyGameUrl({ ...tab, standalone: true, quest: true })).toBe('./app/');
  });
});

describe('store badges', () => {
  it('every store is listed once, and a missing listing renders as a non-link "Coming soon"', () => {
    expect(STORE_LINKS.map((s) => s.id)).toEqual(['quest', 'app-store', 'google-play']);
    const html = storeBadgesHtml(STORE_LINKS.map((s) => ({ ...s, url: null })));
    expect(html).not.toContain('<a ');
    expect(html.match(/Coming soon/g)).toHaveLength(3);
  });

  it('a live listing renders as a new-tab link with the store name', () => {
    const html = storeBadgeHtml({ id: 'quest', name: 'Meta Quest', kicker: 'Get it on', url: 'https://www.meta.com/experiences/123/' });
    expect(html).toMatch(/^<a class="st-badge st-badge--quest" data-store="quest" href="https:\/\/www\.meta\.com\/experiences\/123\/" target="_blank" rel="noopener">/);
    expect(html).toContain('Get it on');
    expect(html).not.toContain('Coming soon');
  });

  it('only https URLs become links, and text is escaped', () => {
    expect(storeBadgeHtml({ id: 'quest', name: 'Q', kicker: 'k', url: 'javascript:alert(1)' })).not.toContain('<a ');
    expect(storeBadgeHtml({ id: 'quest', name: '<b>', kicker: 'k', url: null })).toContain('&lt;b&gt;');
  });
});

describe('offline service worker', () => {
  const files = ['index.html', 'play/index.html', 'app/index.html', 'privacy/index.html', 'assets/main.js'];

  it('precaches each page under its directory URL too (/play/ is requested, not /play/index.html)', () => {
    const urls = precacheUrls(files);
    for (const u of ['./', './play/', './app/', './privacy/', './play/index.html', './assets/main.js']) expect(urls).toContain(u);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('the generated worker lists them', () => {
    expect(swSource(files, 'abc')).toContain('"./play/"');
    expect(swSource(files, 'abc')).toContain("const CACHE = 'dronesim-abc'");
  });

  it('the build fails when the world chunk worker is not precached, and passes once it is', () => {
    expect(() => assertWorkerPrecached(files)).toThrow(/world chunk worker/);
    const withWorker = [...files, 'assets/world-worker-BxQ1a9Zz.js'];
    expect(() => assertWorkerPrecached(withWorker)).not.toThrow();
    expect(swSource(withWorker, 'abc')).toContain('"./assets/world-worker-BxQ1a9Zz.js"');
    expect(WORLD_WORKER_RE.test('assets/world-worker.js.map')).toBe(false);
    expect(WORLD_WORKER_RE.test('assets/my-world-worker-x.js')).toBe(false);
  });
});
