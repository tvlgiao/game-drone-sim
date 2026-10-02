/**
 * Store listings, shared by the landing page and the Quest app's ownership gate.
 * A null url renders as a "Coming soon" label: paste the real listing URL here once it is live.
 */

export type StoreId = 'quest' | 'app-store' | 'google-play';

export interface StoreLink {
  id: StoreId;
  /** store name as the platform writes it */
  name: string;
  /** small line above the name on the badge */
  kicker: string;
  url: string | null;
}

export const STORE_LINKS: readonly StoreLink[] = [
  { id: 'quest', name: 'Meta Quest', kicker: 'Get it on', url: null },
  { id: 'app-store', name: 'App Store', kicker: 'Download on the', url: null },
  { id: 'google-play', name: 'Google Play', kicker: 'Get it on', url: null },
];

export function storeLink(id: StoreId): StoreLink {
  return STORE_LINKS.find((s) => s.id === id)!;
}
