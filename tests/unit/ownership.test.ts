import { describe, expect, it, vi } from 'vitest';
import { OWNED_KEY, QUEST_BILLING_SERVICE, checkQuestOwnership, isOwnerId, type OwnershipEnv } from '../../src/core/ownership';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const NOW = 1_790_000_000_000;

function env(over: Partial<OwnershipEnv> & { userId?: unknown } = {}): OwnershipEnv & { storage: Storage } {
  const { userId = '4815162342', ...rest } = over;
  return {
    getDigitalGoodsService: async () => ({ getLoggedInUserId: async () => userId }),
    online: true,
    storage: new MemStorage() as unknown as Storage,
    now: NOW,
    ...rest,
  } as OwnershipEnv & { storage: Storage };
}

describe('isOwnerId', () => {
  it('accepts non-zero numeric ids as numbers, bigints or strings', () => {
    expect(isOwnerId(4815162342)).toBe(true);
    expect(isOwnerId(4815162342n)).toBe(true);
    expect(isOwnerId('4815162342')).toBe(true);
  });
  it('rejects 0 and anything that is not an id', () => {
    for (const v of [0, '0', '000', 0n, '', null, undefined, NaN, -5, 'abc', {}]) expect(isOwnerId(v), String(v)).toBe(false);
  });
});

describe('checkQuestOwnership', () => {
  it('owned: asks the Quest billing service and caches a timestamp (never the id)', async () => {
    const get = vi.fn(async () => ({ getLoggedInUserId: async () => '4815162342' }));
    const e = env({ getDigitalGoodsService: get });
    expect(await checkQuestOwnership(e)).toEqual({ owned: true, via: 'store' });
    expect(get).toHaveBeenCalledWith(QUEST_BILLING_SERVICE);
    expect(e.storage.getItem(OWNED_KEY)).toBe(String(NOW));
  });

  it('user id 0 (signed in, does not own it) is not owned and clears an old cache', async () => {
    const e = env({ userId: 0 });
    e.storage.setItem(OWNED_KEY, '123');
    expect(await checkQuestOwnership(e)).toEqual({ owned: false, via: 'store' });
    expect(e.storage.getItem(OWNED_KEY)).toBeNull();
  });

  it('no Digital Goods API (a plain browser tab) is not owned, even with a cached success', async () => {
    const e = env({ getDigitalGoodsService: undefined });
    e.storage.setItem(OWNED_KEY, '123');
    expect(await checkQuestOwnership(e)).toEqual({ owned: false, via: 'no-api' });
  });

  it('a service without the Meta getLoggedInUserId extension is not owned', async () => {
    expect(await checkQuestOwnership(env({ getDigitalGoodsService: async () => ({}) }))).toEqual({ owned: false, via: 'error' });
  });

  it('a rejected store call is not owned without a cache, owned with one (and keeps the cache)', async () => {
    const reject = async () => {
      throw new DOMException('unsupported', 'OperationError');
    };
    expect(await checkQuestOwnership(env({ getDigitalGoodsService: reject }))).toEqual({ owned: false, via: 'error' });
    const e = env({ getDigitalGoodsService: reject });
    e.storage.setItem(OWNED_KEY, '123');
    expect(await checkQuestOwnership(e)).toEqual({ owned: true, via: 'cache' });
    expect(e.storage.getItem(OWNED_KEY)).toBe('123');
  });

  it('a store call that never settles times out instead of hanging the launch', async () => {
    const e = env({ getDigitalGoodsService: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(await checkQuestOwnership(e)).toEqual({ owned: false, via: 'error' });
  });

  it('offline with a cached success launches without calling the store', async () => {
    const get = vi.fn(async () => ({ getLoggedInUserId: async () => 0 }));
    const e = env({ getDigitalGoodsService: get, online: false });
    e.storage.setItem(OWNED_KEY, '123');
    expect(await checkQuestOwnership(e)).toEqual({ owned: true, via: 'cache' });
    expect(get).not.toHaveBeenCalled();
  });

  it('offline without a cache still asks the store (the TWA may answer from its own cache)', async () => {
    expect(await checkQuestOwnership(env({ online: false }))).toEqual({ owned: true, via: 'store' });
  });

  it('online re-checks even with a cache, so a refund or account change is picked up', async () => {
    const e = env({ userId: '0' });
    e.storage.setItem(OWNED_KEY, '123');
    expect((await checkQuestOwnership(e)).owned).toBe(false);
  });

  it('broken storage never breaks the check', async () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(await checkQuestOwnership(env({ storage: bad }))).toEqual({ owned: true, via: 'store' });
    expect(await checkQuestOwnership(env({ storage: null }))).toEqual({ owned: true, via: 'store' });
  });
});
