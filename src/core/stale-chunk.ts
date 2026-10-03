/**
 * Stale code after a deploy: a tab opened before it asks for a hashed chunk the new build no longer has (404). When
 * a lazy import fails for good and a newer version is out, the page reloads once onto it; the session flag keeps
 * a broken network from turning that into a reload loop.
 */

export const RELOAD_FLAG = 'drone-sim.stale-chunk-reload';

/** A failed dynamic import (Chromium, Firefox, Safari wording) or Vite's preload of one. */
export function isChunkLoadError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(m);
}

/** The page's entry script file (`main-HASH.js`) in an HTML document's text, or null. */
export function entryScript(html: string): string | null {
  const m = /<script[^>]+src="[^"]*\/(main-[\w-]+\.js)"/.exec(html);
  return m ? m[1]! : null;
}

export interface VersionProbe {
  /** a service worker with a newer build installing / waiting, after asking it to check */
  newerWorker(): Promise<boolean>;
  /** the page's HTML on the server now (no worker in between), or null */
  freshHtml(): Promise<string | null>;
  /** the entry script this page runs */
  currentEntry(): string | null;
}

/** Whether a newer build than this page's is deployed. */
export async function newerVersion(p: VersionProbe): Promise<boolean> {
  try {
    if (await p.newerWorker()) return true;
  } catch {
    // no worker / offline: try the page itself
  }
  const now = p.currentEntry();
  if (!now) return false;
  try {
    const html = await p.freshHtml();
    const next = html ? entryScript(html) : null;
    return !!next && next !== now;
  } catch {
    return false;
  }
}

/**
 * After a chunk failed for good: reload once if a newer build is out. Resolves true when the reload was started
 * (the caller stops there), false otherwise (show the error as usual).
 */
export async function reloadForNewVersion(err: unknown, p: VersionProbe, session: Pick<Storage, 'getItem' | 'setItem'> | null, reload: () => void): Promise<boolean> {
  if (!isChunkLoadError(err)) return false;
  try {
    if (session?.getItem(RELOAD_FLAG)) return false;
  } catch {
    return false;
  }
  if (!(await newerVersion(p))) return false;
  try {
    session?.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    // without the flag a second failure could reload again: do not risk a loop
    return false;
  }
  reload();
  return true;
}

/** The browser's probe: the service worker registration, then the page's HTML when no worker is in control. */
export function browserVersionProbe(): VersionProbe {
  return {
    async newerWorker() {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      if (!reg) return false;
      await reg.update();
      return !!(reg.installing || reg.waiting);
    },
    async freshHtml() {
      // with a worker in control a fetch would get its cached page: only the worker check above counts then
      if (navigator.serviceWorker?.controller) return null;
      const url = new URL(location.href);
      url.hash = '';
      url.searchParams.set('version-check', String(Date.now()));
      const res = await fetch(url, { cache: 'no-store' });
      return res.ok ? res.text() : null;
    },
    currentEntry() {
      const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/main-"]');
      return s ? (new URL(s.src, location.href).pathname.split('/').pop() ?? null) : null;
    },
  };
}
