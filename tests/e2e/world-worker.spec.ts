/**
 * Cross-engine determinism of the world engine (design 07 §8 Tests): the real module Worker and the inline
 * builder produce the same chunk bytes as Node, and heightAt matches the Node golden fixture bit for bit,
 * in Chromium and WebKit. Run: `npx playwright test -c playwright.world.config.ts --reporter=list`.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { HarnessResult } from './world-harness';

const fixture = JSON.parse(readFileSync(new URL('../unit/fixtures/world-golden.json', import.meta.url), 'utf8')) as {
  heights: Record<string, Record<string, number[]>>;
  chunks: Record<string, string>;
};

test('worker and inline chunks and golden heights match the Node fixture', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/tests/e2e/world-harness.html');
  const res = await page.evaluate(() => (window as unknown as { __worldHarness: Promise<HarnessResult> }).__worldHarness);
  expect(errors).toEqual([]);
  expect(res.workerKind).toBe('worker');
  expect(res.transferredBytes).toBeGreaterThan(0);
  expect(res.worker).toEqual(fixture.chunks);
  expect(res.inline).toEqual(fixture.chunks);
  for (const preset of Object.keys(fixture.heights)) {
    for (const seed of Object.keys(fixture.heights[preset]!)) {
      const want = fixture.heights[preset]![seed]!;
      const got = res.heights[preset]![seed]!;
      expect(got.length).toBe(want.length);
      // JSON round-trips doubles exactly (shortest representation), so equality is bit equality
      got.forEach((h, i) => expect(h, `${preset} ${seed} #${i}`).toBe(want[i]));
    }
  }
});
