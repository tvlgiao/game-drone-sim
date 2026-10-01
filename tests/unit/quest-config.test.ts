import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../../quest/twa-manifest.json', import.meta.url), 'utf8')) as {
  packageId: string;
  signingKey: { path: string; alias: string };
};
const assetlinks = JSON.parse(readFileSync(new URL('../../public/.well-known/assetlinks.json', import.meta.url), 'utf8')) as {
  target: { package_name: string; sha256_cert_fingerprints: string[] };
}[];

describe('Quest store config', () => {
  it('keeps the signing key path relative (no build-machine home directory in the repo)', () => {
    expect(manifest.signingKey.path.startsWith('./')).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/\/(Users|home)\//);
  });

  it('assetlinks binds the same package the Quest APK is built as', () => {
    expect(assetlinks[0]!.target.package_name).toBe(manifest.packageId);
    expect(assetlinks[0]!.target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
