/**
 * Store badge markup for a STORE_LINKS entry: a link when the listing is live, a "Coming soon" label
 * until then. Plain strings with no DOM, so the build can render the landing page's badges into its HTML
 * (vite.config.ts) and the Quest gate can reuse them at runtime. Styles: badge.css.
 */
import type { StoreId, StoreLink } from './stores';

/** Generic glyphs (not the stores' trademarked logos): headset, phone, play triangle. */
const GLYPHS: Record<StoreId, string> = {
  quest: 'M3 8.5A2.5 2.5 0 0 1 5.5 6h13A2.5 2.5 0 0 1 21 8.5v6a2.5 2.5 0 0 1-2.5 2.5h-3.2l-1.6-2.2a2 2 0 0 0-3.4 0L8.7 17H5.5A2.5 2.5 0 0 1 3 14.5z',
  'app-store': 'M8 2.5h8A1.5 1.5 0 0 1 17.5 4v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5zM10.5 18.5h3',
  'google-play': 'M6 3.5v17l14-8.5z',
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Only http(s) listing URLs become links. */
function safeUrl(url: string | null): string | null {
  return url !== null && /^https:\/\//.test(url) ? url : null;
}

export function storeBadgeHtml(link: StoreLink): string {
  const url = safeUrl(link.url);
  const icon = `<svg class="st-badge__icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="${GLYPHS[link.id]}"/></svg>`;
  const kicker = url ? link.kicker : 'Coming soon';
  const text = `<span class="st-badge__text"><span class="st-badge__kicker">${esc(kicker)}</span><span class="st-badge__name">${esc(link.name)}</span></span>`;
  return url
    ? `<a class="st-badge st-badge--${link.id}" data-store="${link.id}" href="${esc(url)}" target="_blank" rel="noopener">${icon}${text}</a>`
    : `<span class="st-badge st-badge--${link.id} is-soon" data-store="${link.id}">${icon}${text}</span>`;
}

export function storeBadgesHtml(links: readonly StoreLink[]): string {
  return links.map(storeBadgeHtml).join('');
}
