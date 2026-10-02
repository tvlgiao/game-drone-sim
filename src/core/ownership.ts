/**
 * Meta Horizon Store ownership check for the Quest app (/app/), client-side only.
 * Inside the store-installed app (a Trusted Web Activity) the Digital Goods API answers for the Quest
 * billing service, and Meta's `getLoggedInUserId()` returns the signed-in account's id when that account
 * owns the app (0 otherwise). A plain browser tab has no Digital Goods API at all.
 * One successful check is remembered (a timestamp, never the id) so the app still launches offline.
 */

export const QUEST_BILLING_SERVICE = 'https://quest.meta.com/billing';
export const OWNED_KEY = 'drone-sim.owned.v1';
/** A Digital Goods call that never settles must not leave the player on the splash forever. */
export const OWNERSHIP_TIMEOUT_MS = 5000;
/**
 * A cached success stands in for the store (offline, or the store failing) for this long after the last
 * successful online check; older than that, the store must answer again. Also bounds a refund's reach.
 */
export const OWNED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface QuestDigitalGoodsService {
  /** Meta-specific extension: absent from the standard Digital Goods API */
  getLoggedInUserId?: () => Promise<unknown> | unknown;
}

export interface OwnershipEnv {
  getDigitalGoodsService?: (serviceProvider: string) => Promise<QuestDigitalGoodsService | null | undefined>;
  online: boolean;
  storage: Storage | null;
  now: number;
  timeoutMs?: number;
}

export type OwnershipVia = 'store' | 'cache' | 'no-api' | 'error';

export interface OwnershipResult {
  owned: boolean;
  via: OwnershipVia;
}

function readCache(storage: Storage | null): number | null {
  try {
    const v = Number(storage?.getItem(OWNED_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeCache(storage: Storage | null, value: number | null): void {
  try {
    if (value === null) storage?.removeItem(OWNED_KEY);
    else storage?.setItem(OWNED_KEY, String(value));
  } catch {
    /* quota / privacy mode: the next launch simply checks again */
  }
}

/** Meta account ids arrive as numbers or decimal strings; 0 means "signed in but does not own it". */
export function isOwnerId(id: unknown): boolean {
  if (typeof id !== 'number' && typeof id !== 'bigint' && typeof id !== 'string') return false;
  const s = String(id).trim();
  return /^\d+$/.test(s) && !/^0+$/.test(s);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Offline with a recent cached success (OWNED_CACHE_TTL_MS): owned without asking. Online: the store
 * decides, and its answer refreshes or clears the cache; a store call that fails or times out falls back
 * to a recent cache only.
 */
export async function checkQuestOwnership(env: OwnershipEnv): Promise<OwnershipResult> {
  const stamp = readCache(env.storage);
  // a stamp from the future (clock moved back, edited storage) or older than the TTL is not trusted
  const cached = stamp !== null && stamp <= env.now && env.now - stamp <= OWNED_CACHE_TTL_MS ? stamp : null;
  if (!env.online && cached !== null) return { owned: true, via: 'cache' };
  if (typeof env.getDigitalGoodsService !== 'function') return { owned: false, via: 'no-api' };
  const ms = env.timeoutMs ?? OWNERSHIP_TIMEOUT_MS;
  try {
    const service = await withTimeout(Promise.resolve(env.getDigitalGoodsService(QUEST_BILLING_SERVICE)), ms);
    if (typeof service?.getLoggedInUserId !== 'function') throw new Error('getLoggedInUserId is not available');
    const id = await withTimeout(Promise.resolve(service.getLoggedInUserId()), ms);
    const owned = isOwnerId(id);
    writeCache(env.storage, owned ? env.now : null);
    return { owned, via: 'store' };
  } catch {
    return { owned: cached !== null, via: cached !== null ? 'cache' : 'error' };
  }
}

/** The live check for this page. */
export function checkThisDevice(storage: Storage | null): Promise<OwnershipResult> {
  const w = window as Window & { getDigitalGoodsService?: OwnershipEnv['getDigitalGoodsService'] };
  return checkQuestOwnership({
    getDigitalGoodsService: typeof w.getDigitalGoodsService === 'function' ? w.getDigitalGoodsService.bind(w) : undefined,
    online: navigator.onLine !== false,
    storage,
    now: Date.now(),
  });
}
