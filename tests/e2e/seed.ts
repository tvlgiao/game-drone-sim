/** Shared e2e setup for specs that are not about the tutorial or the level defaults. */
import type { BrowserContext, Page } from '@playwright/test';

/**
 * Marks the tutorial as already skipped (unless the test stored a record itself), so the first-run
 * "New to FPV?" prompt does not cover the menus these specs drive.
 */
export async function skipTutorialOffer(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    try {
      if (localStorage.getItem('drone-sim.tutorial.v1') === null) localStorage.setItem('drone-sim.tutorial.v1', JSON.stringify({ done: false, skipped: true, step: 1, at: 0 }));
    } catch {
      /* storage blocked: the prompt shows and the spec sees it */
    }
  });
}

/** First-time pilots start on Training: specs written for the Night Loft course switch to it via the hook. */
export async function useNightLoft(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __drone: { startLevel: (id: string) => Promise<boolean> } }).__drone.startLevel('night-loft'));
}
