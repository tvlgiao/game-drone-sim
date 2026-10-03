/**
 * Texture worker: builds procedural texture sets off the main thread. Message in: `{ id, kind, size }` (size = the
 * profile's texture size); out: `{ id, px }` with the three maps' buffers transferred, or `{ id, error }`.
 * Spawned by `TextureWorkerClient` (texture-client.ts).
 */
import { setPixels, transferables, type SurfaceKind } from './set-pixels';

interface Req {
  id: number;
  kind: SurfaceKind;
  size: number;
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<Req>) => void) | null; postMessage(msg: unknown, transfer?: Transferable[]): void };

scope.onmessage = (e) => {
  const { id, kind, size } = e.data;
  try {
    const px = setPixels(kind, size);
    scope.postMessage({ id, px }, transferables(px));
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
