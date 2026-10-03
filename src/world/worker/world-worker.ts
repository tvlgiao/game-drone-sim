/**
 * Module worker entry: builds chunks off the main thread and transfers the typed arrays back. Created by
 * WorkerChunkBuilder with `new Worker(new URL('./world-worker.ts', import.meta.url), { type: 'module' })`.
 */
import { handleBuild, WorldCache, type BuildMessage } from './protocol';

interface WorkerScope {
  onmessage: ((e: MessageEvent<BuildMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const worlds = new WorldCache();

scope.onmessage = (e) => {
  const { reply, transfer } = handleBuild(e.data, worlds);
  scope.postMessage(reply, transfer);
};
