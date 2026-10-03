/**
 * Level lifecycle for UI modules (worlds screen, share link, minimap): what is loading, what is loaded and with
 * which seed / code. main.ts emits; listeners subscribe without importing main. DOM-free.
 */
import type { LevelId } from '../types';

export interface ActiveLevel {
  id: LevelId;
  /** generated levels: the world seed (City, Alpine: fixed; Infinite: the played world) */
  seed: number | null;
  /** Infinite: the shareable world code `XXXX-XXXX` */
  code: string | null;
}

export type LevelEvent =
  | { type: 'loading'; id: LevelId; seed: number | null; progress: number }
  | { type: 'loaded'; level: ActiveLevel }
  | { type: 'failed'; id: LevelId; error: string };

type Listener = (e: LevelEvent) => void;

export class LevelEvents {
  private readonly listeners = new Set<Listener>();
  private active: ActiveLevel | null = null;

  /** Subscribes; returns the unsubscribe function. */
  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(e: LevelEvent): void {
    if (e.type === 'loaded') this.active = e.level;
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        console.error('level event listener failed', err);
      }
    }
  }

  /** The level in play (null before the first one is loaded). */
  get current(): ActiveLevel | null {
    return this.active;
  }
}

/** The game's single event bus. */
export const levelEvents = new LevelEvents();
