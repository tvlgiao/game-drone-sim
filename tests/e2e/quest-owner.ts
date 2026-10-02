/** Init script: the Meta Horizon Store's Digital Goods API as the store-installed Quest app sees it, for an owner. */
export function questOwnerStub(): void {
  (window as unknown as { getDigitalGoodsService: (url: string) => Promise<unknown> }).getDigitalGoodsService = async (url: string) => {
    if (url !== 'https://quest.meta.com/billing') throw new Error(`unsupported payment method ${url}`);
    return { getLoggedInUserId: async () => '4815162342' };
  };
}
