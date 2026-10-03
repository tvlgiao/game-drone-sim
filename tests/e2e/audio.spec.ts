import { expect, test, type Page } from '@playwright/test';
import { skipTutorialOffer } from './seed';

test.beforeEach(({ context }) => skipTutorialOffer(context));

interface Mix {
  state: string;
  master: number;
  buses: Record<'music' | 'sfx' | 'ambience' | 'ui' | 'voice', number>;
  target: { master: number; buses: Record<'music' | 'sfx' | 'ambience' | 'ui' | 'voice', number> };
  music: { state: string; song: string | null; playing: boolean; duck: number; stems: number; level: number; cutoff: number };
  nodes: number;
  level: string | null;
  ambience: { wind: number; river: number; rush: number; village: number; events: number } | null;
  bank: number;
}
interface Hook {
  audio: string;
  audioMix: Mix;
  screen: string;
  race: { status: string };
  action: (a: { type: string }) => void;
  press: (name: string) => void;
  startLevel: (id: string) => Promise<boolean>;
}
const hook = (page: Page) => page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.audioMix);

const errors: string[] = [];
async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/play/');
  await page.waitForFunction(() => !!(window as unknown as { __drone?: Hook }).__drone, null, { timeout: 20_000 });
}

test('the AudioContext starts on the first tap and the menu music comes in', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.audio)).toBe('none');
  await page.mouse.click(5, 5); // a real gesture anywhere
  await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.audio === 'running');
  await page.waitForFunction(() => {
    const m = (window as unknown as { __drone: Hook }).__drone.audioMix;
    return m.music.playing && m.bank >= 20 && m.ambience !== null;
  }, null, { timeout: 30_000 });
  const m = await hook(page);
  expect(m.music.state).toBe('menu');
  expect(m.music.song).toBe('green-field'); // Training is the first level
  expect(errors).toEqual([]);
});

test('settings sliders move the bus gains', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.audio === 'running');
  const before = await hook(page);
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Previous Music volume' }).click();
  await page.getByRole('button', { name: 'Previous Effects volume' }).click();
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Previous Ambience volume' }).click();
  await page.getByRole('button', { name: 'Previous Master volume' }).click();
  await expect.poll(async () => (await hook(page)).buses.music).toBeLessThan(before.buses.music * 0.8);
  const after = await hook(page);
  expect(after.target.buses.music).toBeLessThan(before.target.buses.music);
  expect(after.target.buses.sfx).toBeLessThan(before.target.buses.sfx);
  expect(after.target.buses.ambience).toBeLessThan(before.target.buses.ambience);
  expect(after.target.master).toBeLessThan(before.target.master);
  // the live gains follow the targets
  await expect.poll(async () => {
    const m = await hook(page);
    return Math.max(...(['music', 'sfx', 'ambience'] as const).map((b) => Math.abs(m.buses[b] - m.target.buses[b])), Math.abs(m.master - m.target.master));
  }).toBeLessThan(0.01);
  // music off silences only the music bus
  await page.getByRole('button', { name: 'Next Music', exact: true }).click();
  await expect.poll(async () => (await hook(page)).buses.music).toBeLessThan(0.001);
  expect((await hook(page)).buses.sfx).toBeGreaterThan(0.1);
  expect(errors).toEqual([]);
});

test('every level plays its theme and ambience without console errors', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.audio === 'running');
  const songs: Record<string, string> = { training: 'green-field', 'night-loft': 'neon-loft', city: 'dusk-grid', alpine: 'summit', infinite: 'open-country' };
  for (const [id, song] of Object.entries(songs)) {
    expect(await page.evaluate((id) => (window as unknown as { __drone: Hook }).__drone.startLevel(id), id)).toBe(true);
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'freefly' }));
    await page.waitForFunction((song) => {
      const m = (window as unknown as { __drone: Hook }).__drone.audioMix;
      return m.music.song === song && m.music.playing && m.ambience !== null;
    }, song, { timeout: 40_000 });
    const m = await hook(page);
    expect(m.level).toBe(id);
    expect(m.music.state).toBe('chill');
    await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'menu' }));
  }
  // switching levels does not pile up nodes: back on Training, the graph is about the size it was
  const first = await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.startLevel('training'));
  expect(first).toBe(true);
  await page.waitForTimeout(2500);
  expect((await hook(page)).nodes).toBeLessThan(400);
  expect(errors).toEqual([]);
});

test('pausing muffles the music and mutes the motors; resuming opens it again', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Free Fly' }).click();
  await page.getByRole('button', { name: /^Free Fly · / }).first().click();
  await page.waitForFunction(() => {
    const m = (window as unknown as { __drone: Hook }).__drone.audioMix;
    return m.music.state === 'chill' && m.music.playing;
  }, null, { timeout: 30_000 });
  await expect.poll(async () => (await hook(page)).music.cutoff).toBeGreaterThan(10000);
  const open = await hook(page);
  await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.press('pause'));
  await page.waitForFunction(() => (window as unknown as { __drone: Hook }).__drone.race.status === 'paused');
  await expect.poll(async () => (await hook(page)).music.state).toBe('paused');
  await expect.poll(async () => (await hook(page)).music.cutoff).toBeLessThan(1000);
  await expect.poll(async () => (await hook(page)).music.level).toBeLessThan(open.music.level * 0.5);
  await page.evaluate(() => (window as unknown as { __drone: Hook }).__drone.action({ type: 'resume' }));
  await expect.poll(async () => (await hook(page)).music.state).toBe('chill');
  await expect.poll(async () => (await hook(page)).music.cutoff).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
});
