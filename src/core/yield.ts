/**
 * Cooperative scheduling for long loads: heavy work runs in slices of about SLICE_MS and gives the main thread
 * back between them, so input, the loading screen's animation and (in a headset) the XR frame loop keep going.
 */

/** work budget per slice before yielding (ms) */
export const SLICE_MS = 8;

interface SchedulerLike {
  yield?: () => Promise<void>;
}

/**
 * Yields to the event loop as soon as possible (after pending input and rendering): `scheduler.yield()` where the
 * browser has it, else a MessageChannel task (no 4 ms setTimeout clamp), else setTimeout.
 */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (s?.yield) return s.yield();
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Resolves on the next animation frame, or after FRAME_TIMEOUT_MS where none comes: during an immersive WebXR
 * session the window's rAF is paused (only the session's own frame loop runs), and in tests / workers there is none.
 */
export function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return yieldToMain();
  return new Promise((resolve) => {
    let done = false;
    const end = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(end);
    setTimeout(end, FRAME_TIMEOUT_MS);
  });
}

/** nextFrame()'s fallback when no animation frame comes (ms) */
export const FRAME_TIMEOUT_MS = 50;

/** Resolves once the frame after the next one has started: whatever the DOM shows now has been painted. */
export async function afterPaint(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

/**
 * A slice timer: `due()` is true once the current slice has used its budget; `yield()` then gives the thread back
 * and starts a new slice. Usage: `for (...) { work(); if (slicer.due()) await slicer.yield(); }`.
 */
export class Slicer {
  private start = performance.now();

  constructor(private readonly budget = SLICE_MS) {}

  due(): boolean {
    return performance.now() - this.start >= this.budget;
  }

  async yield(): Promise<void> {
    await yieldToMain();
    this.start = performance.now();
  }
}

/** requestIdleCallback with a timeout, or a delayed task where the browser has none (Safari). */
export function whenIdle(fn: () => void, timeout = 2000): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else setTimeout(fn, 200);
}
