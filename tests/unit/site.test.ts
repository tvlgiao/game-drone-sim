import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORLD_WORKER_RE, assertWorkerPrecached, precacheFiles, precacheUrls, swSource } from '../../build/offline-sw';
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

describe('native deep links (shared world links open the apps)', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');

  it('Android App Links: the Quest TWA and the Play upload certificates verify com.cowork.dronesim', () => {
    const links = JSON.parse(read('public/.well-known/assetlinks.json')) as { relation: string[]; target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    const prints = links.filter((l) => l.relation.includes('delegate_permission/common.handle_all_urls') && l.target.package_name === 'com.cowork.dronesim').flatMap((l) => l.target.sha256_cert_fingerprints);
    expect(prints).toContain('D3:4F:86:7E:4F:D6:1B:68:0D:4F:44:A8:5D:54:D5:49:B9:FC:A5:FB:EF:E1:60:BA:8C:1D:56:DA:24:B0:AA:12'); // Quest TWA
    expect(prints).toContain('6E:5A:75:96:0F:C8:31:5F:2F:24:58:EC:BC:EE:7B:1E:18:3C:56:17:44:66:14:BA:CF:7E:19:E0:45:A0:82:9A'); // Play upload key
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/<intent-filter android:autoVerify="true">[\s\S]*?android\.intent\.action\.VIEW[\s\S]*?android\.intent\.category\.BROWSABLE[\s\S]*?android:scheme="https" android:host="dronesim\.coworkgamestudio\.com" android:pathPrefix="\/play\/"/);
  });

  it('iOS Associated Domains: the entitlement and the site association for /play/*', () => {
    const aasa = JSON.parse(read('public/.well-known/apple-app-site-association')) as { applinks: { details: { appIDs: string[]; appID: string; paths: string[]; components: { '/': string }[] }[] } };
    const d = aasa.applinks.details[0]!;
    expect(d.appIDs).toEqual(['X6R8YNM53Z.com.cowork.dronesim']);
    expect(d.appID).toBe('X6R8YNM53Z.com.cowork.dronesim');
    expect(d.paths).toEqual(['/play/*']);
    expect(d.components[0]!['/']).toBe('/play/*');
    expect(read('ios/App/App/App.entitlements')).toContain('<string>applinks:dronesim.coworkgamestudio.com</string>');
    expect(read('ios/App/App.xcodeproj/project.pbxproj').match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)?.length).toBe(2);
    // served as-is (no Jekyll on Pages), never precached by the offline worker
    expect(existsSync(new URL('public/.nojekyll', root))).toBe(true);
    expect(precacheFiles(['.well-known/apple-app-site-association', '.well-known/assetlinks.json', 'play/index.html'])).toEqual(['play/index.html']);
  });
});
