/**
 * Full-screen gate for /app/ when the Meta Horizon Store ownership check fails: points to the store
 * listing and to the free flat-screen version at ../play/. Shown instead of booting the game.
 */
import './tokens.css';
import '../site/badge.css';
import './store-gate.css';
import { storeBadgeHtml } from '../site/badge';
import { storeLink } from '../site/stores';

export function showStoreGate(doc: Document): HTMLElement {
  const quest = storeLink('quest');
  const el = doc.createElement('main');
  el.className = 'ds-site ds-store-gate';
  el.setAttribute('aria-labelledby', 'ds-store-gate-title');
  el.innerHTML = `
    <div class="ds-store-gate__card">
      <p class="ds-store-gate__logo" aria-hidden="true">DRONE SIM</p>
      <h1 class="ds-store-gate__title" id="ds-store-gate-title">Drone Sim VR is available on the Meta&nbsp;Horizon&nbsp;Store</h1>
      <p class="ds-store-gate__text">This page is the Quest app. Install it from the store to fly in VR, or play the free flat-screen version in your browser.</p>
      <div class="ds-store-gate__actions">
        <a class="ds-store-gate__play" href="../play/" data-gate="play">Play free on the web</a>
        ${storeBadgeHtml(quest)}
      </div>
    </div>`;
  doc.body.append(el);
  el.querySelector<HTMLElement>('[data-gate="play"]')?.focus({ preventScroll: true });
  return el;
}
