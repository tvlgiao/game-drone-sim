/**
 * Worlds screen for the Infinite World (design 07 §6): new random world, "Enter seed or code" with live
 * validation, and the saved list (name, code, last played) with Play / Rename / Share / Delete. The store lives in
 * localStorage (src/game/worlds.ts); this screen reads it on every open and writes it on every change. Menus owns
 * the screen element, focus and the delete confirmation.
 */
import './worlds-screen.css';
import { deleteWorld, loadWorlds, MAX_WORLD_NAME, MAX_WORLDS, renameWorld, saveWorlds, worldsByRecent, type SavedWorld, type WorldsStore } from '../game/worlds';
import { GEN_VERSION } from '../world/world';
import { esc } from './level-select';
import { lastPlayedText, MAX_SEED_INPUT, playWorld, randomSeed, seedFieldStatus, worldShareUrl, type WorldPick } from './worlds-model';

export interface WorldsHost {
  storage: Storage | null;
  now(): number;
  toast(msg: string): void;
  /** start the Infinite World on this seed (the play is already recorded) */
  play(pick: WorldPick): void;
  /** open the delete confirmation for this world */
  confirmDelete(w: SavedWorld): void;
  /** the screen's markup changed: re-collect focusable items and focus `act` (or keep the focus) */
  refresh(act?: string): void;
  /** moves the menu focus by one item (arrow keys inside a text field) */
  move(dir: -1 | 1): void;
  /** iOS / Android shell: share links point at the hosted web game */
  native: boolean;
  /** injectable for tests; defaults to crypto.getRandomValues */
  randomSeed?: () => number;
}

/** Acts this screen handles; Menus routes every `world-…` act here. */
export const WORLD_ACT = /^world-(new|field|go|play|rename|rename-save|rename-cancel|share|delete)(?::(.+))?$/;

export function worldsScreenHtml(btn: (act: string, label: string, primary?: boolean, extra?: string, attrs?: string) => string): string {
  return `
      <div class="ds-panel ds-glass ds-dialog ds-dialog--wide ds-worlds">
        <h2 class="ds-dialog__title">Worlds <small>Infinite World</small></h2>
        <div class="ds-worlds__start">
          ${btn('world-new', '<svg class="ds-worlds__die" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="8.2" cy="8.2" r="1.6"/><circle cx="15.8" cy="8.2" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="8.2" cy="15.8" r="1.6"/><circle cx="15.8" cy="15.8" r="1.6"/></svg>New random world', true, ' ds-worlds__new')}
          <div class="ds-worlds__seed" data-nav data-act="world-field">
            <label class="ds-label" for="ds-world-seed">Enter seed or code</label>
            <div class="ds-worlds__entry">
              <input id="ds-world-seed" class="ds-input ds-worlds__input" type="text" inputmode="text" enterkeyhint="go" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="${MAX_SEED_INPUT}" placeholder="K7Q2-9XMF" aria-describedby="ds-world-seed-status" />
              ${btn('world-go', 'Play', false, ' ds-btn--sm ds-worlds__go', ' disabled aria-disabled="true"')}
            </div>
            <p class="ds-worlds__status" id="ds-world-seed-status" data-f="seedStatus" data-tone="idle" aria-live="polite"></p>
          </div>
        </div>
        <h3 class="ds-h3 ds-worlds__head">Saved worlds <small data-f="count"></small></h3>
        <p class="ds-worlds__cap" data-f="cap" hidden>The list is full (${MAX_WORLDS}). Playing another world replaces the one flown longest ago.</p>
        <ul class="ds-worlds__list" data-f="list" aria-label="Saved worlds"></ul>
        <div class="ds-worlds__empty" data-f="empty" hidden>
          <svg viewBox="0 0 64 40" aria-hidden="true"><path d="M2 34 L18 16 L28 26 L40 10 L62 34 Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="50" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          <p><b>No saved worlds yet.</b> Start a new random world or enter a code — every world you fly is saved here.</p>
        </div>
        <div class="ds-dialog__actions">
          <p class="ds-foot ds-worlds__foot" data-pad-only><span><kbd class="ds-kbd">↑</kbd><kbd class="ds-kbd">↓</kbd> World</span><span><kbd class="ds-kbd">←</kbd><kbd class="ds-kbd">→</kbd> Action</span></p>
          ${btn('back', 'Back', true)}
        </div>
      </div>`;
}

export class WorldsScreen {
  private store: WorldsStore;
  private editing: string | null = null;
  private readonly input: HTMLInputElement;
  private readonly go: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly count: HTMLElement;
  private readonly cap: HTMLElement;

  constructor(
    el: HTMLElement,
    private readonly host: WorldsHost,
  ) {
    const q = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
    this.input = q<HTMLInputElement>('#ds-world-seed');
    this.go = q<HTMLButtonElement>('[data-act="world-go"]');
    this.status = q('[data-f="seedStatus"]');
    this.list = q('[data-f="list"]');
    this.empty = q('[data-f="empty"]');
    this.count = q('[data-f="count"]');
    this.cap = q('[data-f="cap"]');
    this.store = loadWorlds(host.storage);
    this.input.addEventListener('input', () => this.renderStatus());
    this.input.addEventListener('keydown', (e) => this.onSeedKey(e));
    // the on-screen keyboard covers the lower half of a landscape phone: keep the field in view
    this.input.addEventListener('focus', () => this.input.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
    this.list.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.dataset.rename) this.onRenameKey(e, t.dataset.rename);
    });
    this.render();
  }

  /** Re-reads the store (a play elsewhere, a deep link) and redraws; called whenever the screen opens. */
  open(): void {
    this.store = loadWorlds(this.host.storage);
    this.editing = null;
    this.render();
  }

  /** Handles a `world-…` act; false when it is not one. */
  act(act: string): boolean {
    const m = WORLD_ACT.exec(act);
    if (!m) return false;
    const code = m[2] ?? '';
    switch (m[1]) {
      case 'new':
        this.start({ seed: (this.host.randomSeed ?? randomSeed)(), gen: GEN_VERSION });
        break;
      case 'field':
        this.input.focus();
        break;
      case 'go':
        this.playTyped();
        break;
      case 'play': {
        const w = this.find(code);
        if (w) this.start({ seed: w.seed, gen: w.gen });
        break;
      }
      case 'rename':
        this.beginRename(code);
        break;
      case 'rename-save':
        this.saveRename(code);
        break;
      case 'rename-cancel':
        this.endRename(code);
        break;
      case 'share': {
        const w = this.find(code);
        if (w) void this.share(w);
        break;
      }
      case 'delete': {
        const w = this.find(code);
        if (w) this.host.confirmDelete(w);
        break;
      }
    }
    return true;
  }

  /** Confirmed delete: removes the world and says so. Returns the act to focus next. */
  remove(id: string): string {
    const order = worldsByRecent(this.store).map((w) => w.id);
    const i = order.indexOf(id);
    const w = this.find(id);
    this.store = deleteWorld(this.store, id);
    saveWorlds(this.host.storage, this.store);
    if (w) this.host.toast(`Deleted ${w.name}`);
    this.render();
    const next = order[i + 1] ?? order[i - 1];
    return next && next !== id ? `world-play:${next}` : 'world-new';
  }

  /** Saved worlds, most recent first (tests, the VR card). */
  get worlds(): readonly SavedWorld[] {
    return worldsByRecent(this.store);
  }

  private find(id: string): SavedWorld | undefined {
    return this.store.worlds.find((w) => w.id === id);
  }

  private start(pick: { seed: number; gen: number }): void {
    const w = playWorld(this.host.storage, pick, this.host.now());
    this.store = loadWorlds(this.host.storage);
    this.input.blur();
    this.host.play({ seed: w.seed, gen: w.gen, code: w.code });
  }

  private playTyped(): void {
    const st = seedFieldStatus(this.input.value, this.store);
    if (!st.pick) {
      this.input.focus();
      this.status.classList.remove('is-nudge');
      void this.status.offsetWidth;
      this.status.classList.add('is-nudge');
      return;
    }
    this.start(st.pick);
  }

  private onSeedKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.playTyped();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.input.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.input.blur();
      this.host.move(e.key === 'ArrowDown' ? 1 : -1);
    }
  }

  private onRenameKey(e: KeyboardEvent, id: string): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.saveRename(id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.endRename(id);
    }
  }

  private beginRename(id: string): void {
    if (!this.find(id)) return;
    this.editing = id;
    this.render();
    this.host.refresh(`world-rename-save:${id}`);
    const field = this.list.querySelector<HTMLInputElement>('input[data-rename]');
    field?.focus();
    field?.select();
  }

  private saveRename(id: string): void {
    const field = this.list.querySelector<HTMLInputElement>('input[data-rename]');
    const name = field?.value ?? '';
    const next = renameWorld(this.store, id, name);
    if (next === this.store) {
      // empty (or whitespace) names are rejected by the store: keep editing
      this.host.toast('A world needs a name');
      field?.focus();
      return;
    }
    this.store = next;
    saveWorlds(this.host.storage, this.store);
    this.endRename(id);
  }

  private endRename(id: string): void {
    this.editing = null;
    this.render();
    this.host.refresh(`world-rename:${id}`);
  }

  private async share(w: SavedWorld): Promise<void> {
    const url = worldShareUrl(w.code, location, this.host.native);
    const text = `Fly my Drone Sim world ${w.code}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: `Drone Sim · ${w.name}`, text, url });
        return;
      } catch (err) {
        // the pilot closed the share sheet: nothing to report
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.host.toast(`Link copied · ${w.code}`);
    } catch {
      this.host.toast(`Share this link: ${url}`);
    }
  }

  private renderStatus(): void {
    const st = seedFieldStatus(this.input.value, this.store);
    this.status.textContent = st.message;
    this.status.dataset.tone = st.tone;
    const ok = st.pick !== null;
    this.go.disabled = !ok;
    this.go.setAttribute('aria-disabled', String(!ok));
    this.input.setAttribute('aria-invalid', String(st.tone === 'error'));
  }

  private render(): void {
    const now = this.host.now();
    const worlds = worldsByRecent(this.store);
    const n = worlds.length;
    this.count.textContent = n ? `${n} / ${MAX_WORLDS}` : '';
    this.cap.hidden = n < MAX_WORLDS;
    this.empty.hidden = n > 0;
    this.list.hidden = n === 0;
    this.list.innerHTML = worlds.map((w) => (w.id === this.editing ? this.editRowHtml(w) : this.rowHtml(w, now))).join('');
    this.renderStatus();
  }

  private rowHtml(w: SavedWorld, now: number): string {
    const name = esc(w.name);
    const b = (act: string, label: string, extra = ''): string =>
      `<button type="button" class="ds-btn ds-btn--sm${extra}" data-nav data-act="world-${act}:${w.id}" aria-label="${label} ${name}"><span>${label}</span></button>`;
    const isLast = this.store.last === w.id;
    return `
      <li class="ds-wrow${isLast ? ' is-last' : ''}" data-world="${w.id}">
        <div class="ds-wrow__main">
          <span class="ds-wrow__name">${name}${isLast ? '<span class="ds-lvl__tag">Last flown</span>' : ''}</span>
          <span class="ds-wrow__meta"><span class="ds-wrow__code ds-num">${w.code}</span><span class="ds-wrow__when">${lastPlayedText(w.lastPlayed, now)}</span></span>
        </div>
        <div class="ds-wrow__acts">${b('play', 'Play', ' ds-btn--primary')}${b('rename', 'Rename')}${b('share', 'Share')}${b('delete', 'Delete', ' ds-btn--quit')}</div>
      </li>`;
  }

  private editRowHtml(w: SavedWorld): string {
    const b = (act: string, label: string, extra = ''): string =>
      `<button type="button" class="ds-btn ds-btn--sm${extra}" data-nav data-act="world-${act}:${w.id}"><span>${label}</span></button>`;
    return `
      <li class="ds-wrow is-editing" data-world="${w.id}">
        <div class="ds-wrow__main">
          <label class="ds-label" for="ds-world-rename">Name · <span class="ds-num">${w.code}</span></label>
          <input id="ds-world-rename" class="ds-input" data-rename="${w.id}" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="words" spellcheck="false" maxlength="${MAX_WORLD_NAME}" value="${esc(w.name)}" />
        </div>
        <div class="ds-wrow__acts">${b('rename-save', 'Save', ' ds-btn--primary')}${b('rename-cancel', 'Cancel')}</div>
      </li>`;
  }
}

