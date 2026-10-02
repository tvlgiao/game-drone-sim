/**
 * Which build of the game this page is, decided once from its URL path and the native shell:
 *   web-free  — /play/ on the website: every level on a flat screen, never VR
 *   quest-app — /app/, the Meta Horizon Store app (TWA start URL): VR, behind the store ownership check
 *   native    — the Capacitor iOS / Android apps (paid in their stores): full game, no VR UI
 *   dev       — any other path under `npm run dev` (scratch pages): everything on, no gate
 */

export type Edition = 'web-free' | 'quest-app' | 'native' | 'dev';

export interface EditionCaps {
  /** Enter VR button, `sessiongranted` and the installed-Quest-app auto-enter */
  vr: boolean;
  /** Meta Horizon Store ownership check before the game boots */
  ownershipCheck: boolean;
}

const CAPS: Record<Edition, EditionCaps> = {
  'web-free': { vr: false, ownershipCheck: false },
  'quest-app': { vr: true, ownershipCheck: true },
  native: { vr: false, ownershipCheck: false },
  dev: { vr: true, ownershipCheck: false },
};

/** Unknown paths in a production build fall back to the free web edition: never VR without the check. */
export function detectEdition(pathname: string, native: boolean, dev: boolean): Edition {
  if (native) return 'native';
  if (/\/app\/(index\.html)?$/.test(pathname)) return 'quest-app';
  if (/\/play\/(index\.html)?$/.test(pathname)) return 'web-free';
  return dev ? 'dev' : 'web-free';
}

export function editionCaps(edition: Edition): EditionCaps {
  return CAPS[edition];
}
