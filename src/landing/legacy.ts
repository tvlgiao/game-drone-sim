/**
 * The site root used to be the game. Links and installs from that time land on the landing page now:
 * send them on to the game instead of showing marketing.
 *   - a game query (`?selftest=1`, `?xremu=1`, `?rotate=0`, …) → ./play/ with the query kept
 *   - a home-screen PWA or the Quest app installed before 1.0.3 (start URL "/", standalone display)
 *     → ./app/ on a Quest, ./play/ elsewhere
 */

const GAME_PARAMS = ['selftest', 'xremu', 'rotate', 'owned'];

export interface LegacyEnv {
  search: string;
  hash: string;
  /** display-mode standalone / fullscreen, or iOS navigator.standalone */
  standalone: boolean;
  /** Quest Browser user agent */
  quest: boolean;
}

/** Relative URL of the game page to go to, or null to stay on the landing page. */
export function legacyGameUrl(env: LegacyEnv): string | null {
  const q = new URLSearchParams(env.search);
  const deepLink = GAME_PARAMS.some((p) => q.has(p));
  if (!deepLink && !env.standalone) return null;
  const page = env.standalone && env.quest ? './app/' : './play/';
  return page + env.search + env.hash;
}
