/** Landing page (site root): redirects pre-split game links (legacy.ts). Everything else is static HTML. */
import '../ui/tokens.css';
import '../site/badge.css';
import './landing.css';
import { isQuestBrowser } from '../core/xr';
import { legacyGameUrl } from './legacy';

function matches(q: string): boolean {
  try {
    return window.matchMedia(q).matches;
  } catch {
    return false;
  }
}

const target = legacyGameUrl({
  search: location.search,
  hash: location.hash,
  standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true || matches('(display-mode: standalone)') || matches('(display-mode: fullscreen)'),
  quest: isQuestBrowser(navigator.userAgent),
});
if (target) location.replace(target);
