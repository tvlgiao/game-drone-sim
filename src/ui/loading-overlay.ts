/**
 * "Building the world" overlay shown while a generated level streams its first chunks (the level's `ready`).
 * Mounted inside the game UI root (.ds-ui tokens); progress 0..1 drives the bar and the aria value.
 */
import './loading-overlay.css';

export class LoadingOverlay {
  private readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly label: HTMLElement;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ds-loading';
    this.root.hidden = true;
    this.root.setAttribute('role', 'progressbar');
    this.root.setAttribute('aria-valuemin', '0');
    this.root.setAttribute('aria-valuemax', '100');
    this.label = document.createElement('div');
    this.label.className = 'ds-loading__label';
    const track = document.createElement('div');
    track.className = 'ds-loading__track';
    this.bar = document.createElement('div');
    this.bar.className = 'ds-loading__bar';
    track.append(this.bar);
    this.root.append(this.label, track);
    parent.append(this.root);
  }

  get visible(): boolean {
    return this.shown;
  }

  show(title: string): void {
    this.label.textContent = title;
    this.root.setAttribute('aria-label', title);
    this.set(0);
    this.root.hidden = false;
    this.shown = true;
  }

  set(progress: number): void {
    const p = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    this.bar.style.transform = `scaleX(${p / 100})`;
    this.root.setAttribute('aria-valuenow', String(p));
  }

  hide(): void {
    this.root.hidden = true;
    this.shown = false;
  }
}
