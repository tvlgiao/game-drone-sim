/**
 * Full-screen gate for /app/ when the Meta Horizon Store ownership check fails: points to the store
 * listing and to the free flat-screen version at ../play/. Shown instead of booting the game.
 */
import './tokens.css';
import '../site/badge.css';
import './store-gate.css';
import { storeBadgeHtml } from '../site/badge';
import { storeLink } from '../site/stores';
import { gatePlayHref } from './worlds-model';

/**
 * `not-owned`: no store install or no purchase. `unverified`: the store could not be reached (offline on the
 * first launch, timeout, store error) — a real owner must be told to retry, not shown the shop.
 */
export type GateReason = 'not-owned' | 'unverified';

export function showStoreGate(doc: Document, reason: GateReason = 'not-owned'): HTMLElement {
  const quest = storeLink('quest');
  const unverified = reason === 'unverified';
  // a shared world link that landed on the Quest app page still opens that world in the web game
  const play = gatePlayHref(doc.location?.search ?? '');
  const el = doc.createElement('main');
  el.className = 'ds-site ds-store-gate';
  el.setAttribute('aria-labelledby', 'ds-store-gate-title');
  el.innerHTML = `
    <div class="ds-store-gate__card">
      <p class="ds-store-gate__logo" aria-hidden="true">DRONE SIM</p>
      ${
        unverified
          ? `<h1 class="ds-store-gate__title" id="ds-store-gate-title">Couldn’t confirm your purchase</h1>
      <p class="ds-store-gate__text">The Meta Horizon Store didn’t answer. Connect to the internet and try again — after one successful check the app also starts offline.</p>
      <div class="ds-store-gate__actions">
        <button type="button" class="ds-store-gate__play" data-gate="retry">Try again</button>
        <a class="ds-store-gate__play ds-store-gate__play--ghost" href="${play}" data-gate="play">Play free on the web</a>
      </div>`
          : `<h1 class="ds-store-gate__title" id="ds-store-gate-title">Drone Sim VR is available on the Meta&nbsp;Horizon&nbsp;Store</h1>
      <p class="ds-store-gate__text">This page is the Quest app. Install it from the store to fly in VR, or play the free flat-screen version in your browser.</p>
      <div class="ds-store-gate__actions">
        <a class="ds-store-gate__play" href="${play}" data-gate="play">Play free on the web</a>
        ${storeBadgeHtml(quest)}
      </div>`
      }
    </div>`;
  doc.body.append(el);
  el.querySelector('[data-gate="retry"]')?.addEventListener('click', () => doc.location.reload());
  el.querySelector<HTMLElement>(unverified ? '[data-gate="retry"]' : '[data-gate="play"]')?.focus({ preventScroll: true });
  return el;
}
