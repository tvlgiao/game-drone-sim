/**
 * Main-thread side of the texture worker: `build(kind, size)` resolves with the set's pixels. Where there is no
 * module Worker (unit tests, very old WebViews) or the worker fails, the set is built on this thread instead, after
 * yielding once so a loading screen gets a frame in between.
 */
import { yieldToMain } from '../../core/yield';
import { setPixels, type SetPixels, type SurfaceKind } from './set-pixels';

interface Pending {
  resolve: (px: SetPixels) => void;
  kind: SurfaceKind;
  size: number;
}

export class TextureWorkerClient {
  private worker: Worker | null = null;
  private failed = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  /** Starts the worker now (its script loads while the menu is idle). */
  warm(): void {
    this.spawn();
  }

  private spawn(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    if (typeof Worker === 'undefined') {
      this.failed = true;
      return null;
    }
    try {
      const w = new Worker(new URL('./texture-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; px?: SetPixels; error?: string }>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.px) p.resolve(e.data.px);
        else void this.inline(p.kind, p.size).then(p.resolve);
      };
      w.onerror = () => this.fail();
      this.worker = w;
    } catch {
      this.failed = true;
    }
    return this.worker;
  }

  /** The worker died: everything still pending is built on this thread. */
  private fail(): void {
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    const left = [...this.pending.values()];
    this.pending.clear();
    for (const p of left) void this.inline(p.kind, p.size).then(p.resolve);
  }

  private async inline(kind: SurfaceKind, size: number): Promise<SetPixels> {
    await yieldToMain();
    return setPixels(kind, size);
  }

  build(kind: SurfaceKind, size: number): Promise<SetPixels> {
    const w = this.spawn();
    if (!w) return this.inline(kind, size);
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, kind, size });
      w.postMessage({ id, kind, size });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
