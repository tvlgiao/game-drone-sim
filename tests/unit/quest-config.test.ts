import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';

const manifest = JSON.parse(readFileSync(new URL('../../quest/twa-manifest.json', import.meta.url), 'utf8')) as {
  packageId: string;
  applicationId: string;
  horizonOSAppMode: string;
  signingKey: { path: string; alias: string };
  host: string;
  startUrl: string;
  webManifestUrl: string;
  fullScopeUrl: string;
  appVersionName: string;
  appVersionCode: number;
};
const appManifest = JSON.parse(readFileSync(new URL('../../public/app/manifest.webmanifest', import.meta.url), 'utf8')) as { start_url: string; scope: string };
const assetlinks = JSON.parse(readFileSync(new URL('../../public/.well-known/assetlinks.json', import.meta.url), 'utf8')) as {
  target: { package_name: string; sha256_cert_fingerprints: string[] };
}[];

describe('Quest store config', () => {
  it('keeps the signing key path relative (no build-machine home directory in the repo)', () => {
    expect(manifest.signingKey.path.startsWith('./')).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/\/(Users|home)\//);
  });

  it('is an immersive app with no placeholder Meta app id (OCULUS_APP_ID "0" shows "App name unavailable")', () => {
    expect(manifest.horizonOSAppMode).toBe('immersive');
    // empty until the Horizon Store assigns the real numeric id; never the generator default "0"
    expect(manifest.applicationId === '' || /^[1-9][0-9]{6,}$/.test(manifest.applicationId)).toBe(true);
  });

  it('assetlinks binds the same package the Quest APK is built as', () => {
    expect(assetlinks[0]!.target.package_name).toBe(manifest.packageId);
    expect(assetlinks[0]!.target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('starts at the Quest app page (/app/, behind the store ownership check), not the landing page or the free /play/', () => {
    expect(manifest.startUrl).toBe('/app/');
    expect(manifest.webManifestUrl).toBe(`https://${manifest.host}/app/manifest.webmanifest`);
    expect(manifest.fullScopeUrl).toBe(`https://${manifest.host}/app/`);
    expect(existsSync(new URL('../../app/index.html', import.meta.url))).toBe(true);
    expect(appManifest.start_url).toBe('./');
    expect(appManifest.scope).toBe('./');
  });

  it('ships the same version the About screen shows', () => {
    expect(manifest.appVersionName).toBe(pkg.version);
    expect(Number.isInteger(manifest.appVersionCode) && manifest.appVersionCode >= 4).toBe(true);
  });
});
