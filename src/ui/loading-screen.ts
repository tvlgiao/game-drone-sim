/**
 * Level loading screen: full-bleed level art (the level-select card painting, drawn large and softened), the level
 * name and mode, the world code for Infinite, a weighted-stage progress bar with the stage under it (LoadProgress:
 * always moving, never backwards), a rotating pilot tip, Back (Esc / gamepad B) to cancel, and an error state with
 * Retry and Back. On success it fills to 100 %, shows "Ready" (Free Fly) and fades into the scene.
 *
 * Accessible: role="dialog" with the stage in an aria-live region and a progressbar with aria-valuenow (updated a
 * few times a second, not every frame); prefers-reduced-motion drops the fade, the art drift and the tip slide.
 */
import './loading-screen.css';
import { drawLevelArt } from './level-select';
import { LoadProgress, type LoadStage } from './load-progress';
import { nextFrame } from '../core/yield';

export interface LoadInfo {
  id: string;
  name: string;
  /** "Race" / "Free Fly" (shown above the name) */
  mode: string;
  /** Infinite: the world code */
  code?: string | null;
}

export const PILOT_TIPS: readonly string[] = [
  'Look where you want to go: in FPV the drone follows your eyes, not the other way round.',
  'Small stick inputs. Fast pilots are smooth pilots.',
  'Carry speed through a gate: aim for the exit of the next one, not the centre of this one.',
  'Lost orientation in FPV? Switch to LOS or chase with the camera button and get your bearings.',
  'Angle mode levels the drone for you. Try Acro once you can hover without thinking.',
  'Throttle down before you hit the ground: a tumble on low throttle often keeps the drone flying.',
  'Wind gusts are strongest over open water and ridgelines.',
  'Infinite worlds have codes: share yours, or type a friend’s in the Worlds screen.',
];

const TIP_MS = 4500;
const FADE_MS = 400;
const READY_MS = 220;
/** aria-valuenow updates at most this often (screen readers do not want 60 per second) */
const ARIA_MS = 250;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class LoadingScreen {
  readonly root: HTMLElement;
  private readonly art: HTMLCanvasElement;
  private readonly modeEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly codeEl: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly pctEl: HTMLElement;
  private readonly tipEl: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly retry: HTMLButtonElement;
  private readonly goEl: HTMLElement;
  private progress: LoadProgress | null = null;
  private raf = 0;
  private tipIndex = 0;
  private tipAt = 0;
  private ariaAt = 0;
  private shownStage = '';
  private onRetry: (() => void) | null = null;
  /** Back / Esc / gamepad B while loading or after an error */
  onCancel: (() => void) | null = null;
  private state: 'hidden' | 'loading' | 'error' | 'finishing' = 'hidden';
  /** the hand-off has released control (the fade is running) */
  private releasing = false;

  constructor(parent: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'ds-load';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'ds-load-name');
    root.innerHTML = `
      <canvas class="ds-load__art" width="960" height="540" aria-hidden="true"></canvas>
      <div class="ds-load__shade" aria-hidden="true"></div>
      <div class="ds-load__panel">
        <p class="ds-load__mode ds-label" data-l="mode"></p>
        <h2 class="ds-load__name" id="ds-load-name" data-l="name"></h2>
        <p class="ds-load__code" data-l="code" hidden></p>
        <div class="ds-load__progress" data-l="busy">
          <div class="ds-load__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-labelledby="ds-load-stage" data-l="bar"><i data-l="fill"></i></div>
          <div class="ds-load__row">
            <span class="ds-load__stage" id="ds-load-stage" aria-live="polite" data-l="stage"></span>
            <span class="ds-load__pct ds-num" data-l="pct">0%</span>
          </div>
          <p class="ds-load__tip" data-l="tip"></p>
        </div>
        <div class="ds-load__error" data-l="error" hidden>
          <p role="alert" data-l="errorText"></p>
        </div>
        <div class="ds-load__actions">
          <button type="button" class="ds-btn ds-btn--ghost" data-l="back" data-act="load-back">Back</button>
          <button type="button" class="ds-btn ds-btn--primary" data-l="retry" data-act="load-retry" hidden>Retry</button>
        </div>
      </div>
      <div class="ds-load__go" data-l="go" aria-live="assertive"></div>`;
    parent.append(root);
    this.root = root;
    const q = <T extends HTMLElement>(k: string): T => root.querySelector<T>(`[data-l="${k}"]`)!;
    this.art = root.querySelector('canvas')!;
    this.modeEl = q('mode');
    this.nameEl = q('name');
    this.codeEl = q('code');
    this.bar = q('bar');
    this.fill = q('fill');
    this.stageEl = q('stage');
    this.pctEl = q('pct');
    this.tipEl = q('tip');
    this.errorBox = q('error');
    this.errorText = q('errorText');
    this.back = q('back');
    this.retry = q('retry');
    this.goEl = q('go');
    this.back.addEventListener('click', () => this.cancel());
    this.retry.addEventListener('click', () => this.onRetry?.());
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      }
    });
  }

  get visible(): boolean {
    return this.state !== 'hidden';
  }

  /** loading (not failed, not fading out) */
  get loading(): boolean {
    return this.state === 'loading';
  }

  /** shown value 0..1 (tests) */
  get value(): number {
    return this.progress?.shownValue ?? 0;
  }

  /** Puts the screen up at once (call before any heavy work) with the stages of this load. */
  show(info: LoadInfo, stages: readonly LoadStage[]): void {
    this.progress = new LoadProgress(stages, performance.now());
    this.state = 'loading';
    this.root.hidden = false;
    this.root.classList.remove('is-fading', 'is-error');
    this.root.style.removeProperty('opacity');
    this.root.dataset.level = info.id;
    this.modeEl.textContent = info.mode;
    this.nameEl.textContent = info.name;
    this.codeEl.hidden = !info.code;
    this.codeEl.textContent = info.code ? `World ${info.code}` : '';
    this.errorBox.hidden = true;
    this.retry.hidden = true;
    this.back.hidden = false;
    this.goEl.textContent = '';
    this.root.querySelector<HTMLElement>('[data-l="busy"]')!.hidden = false;
    const ctx = this.art.getContext('2d');
    if (ctx) drawLevelArt(ctx, info.id, this.art.width, this.art.height);
    this.tipIndex = Math.floor(Math.random() * PILOT_TIPS.length);
    this.tipEl.textContent = `Tip: ${PILOT_TIPS[this.tipIndex]}`;
    this.tipAt = performance.now();
    this.shownStage = '';
    this.render(performance.now(), true);
    this.back.focus({ preventScroll: true });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  /** stage `id` is `f` done */
  report(id: string, f: number): void {
    this.progress?.report(id, f, performance.now());
  }

  private loop(now: number): void {
    if (this.state === 'hidden') return;
    this.render(now, false);
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  /**
   * Advances the bar outside the page's rAF (a headset's frame loop: the window's rAF is paused in an immersive
   * session); returns the shown value 0..1.
   */
  tick(now: number): number {
    if (this.state !== 'hidden') this.render(now, false);
    return this.value;
  }

  private render(now: number, force: boolean): void {
    const p = this.progress;
    if (!p) return;
    const v = p.tick(now);
    this.fill.style.transform = `scaleX(${v.toFixed(4)})`;
    const pct = Math.floor(v * 100);
    this.pctEl.textContent = `${pct}%`;
    if (force || now - this.ariaAt > ARIA_MS) {
      this.ariaAt = now;
      this.bar.setAttribute('aria-valuenow', String(pct));
    }
    const label = p.completed ? 'Ready' : p.stage.label;
    if (label !== this.shownStage) {
      this.shownStage = label;
      this.stageEl.textContent = label;
    }
    if (this.state === 'loading' && now - this.tipAt > TIP_MS) {
      this.tipAt = now;
      this.tipIndex = (this.tipIndex + 1) % PILOT_TIPS.length;
      this.tipEl.textContent = `Tip: ${PILOT_TIPS[this.tipIndex]}`;
      this.tipEl.classList.remove('is-new');
      void this.tipEl.offsetWidth;
      this.tipEl.classList.add('is-new');
    }
  }

  /** Back / Esc / B: cancels a running load or leaves the error state. */
  cancel(): void {
    if (this.state !== 'loading' && this.state !== 'error') return;
    this.hide();
    this.onCancel?.();
  }

  /** The load failed: a clear message with Retry and Back. */
  fail(message: string, onRetry: () => void): void {
    this.state = 'error';
    this.onRetry = onRetry;
    this.root.classList.add('is-error');
    this.root.querySelector<HTMLElement>('[data-l="busy"]')!.hidden = true;
    this.errorBox.hidden = false;
    this.errorText.textContent = message;
    this.retry.hidden = false;
    this.retry.focus({ preventScroll: true });
  }

  /**
   * Success: the bar runs to 100 %, "Ready" shows for Free Fly (`ready`), then the screen fades into the scene over
   * FADE_MS (instantly with reduced motion). Resolves once it is gone.
   */
  async finish(ready: boolean, onControl?: () => void): Promise<void> {
    if (this.state !== 'loading' || !this.progress) return;
    this.state = 'finishing';
    this.releasing = false;
    this.progress.complete();
    this.back.hidden = true;
    const reduced = reducedMotion();
    // the bar runs to the end (its own loop, or this one where the page gets no rAF: a headset)
    while (this.state === 'finishing' && (this.progress?.shownValue ?? 1) < 1) {
      await nextFrame();
      this.render(performance.now(), false);
    }
    if (this.gone) return;
    if (ready) {
      this.goEl.textContent = 'Ready';
      await new Promise((r) => setTimeout(r, reduced ? 250 : READY_MS));
    }
    if (this.gone) return;
    // the pilot has the drone from here: the fade runs over a live, controllable scene
    this.releasing = true;
    onControl?.();
    if (!reduced) {
      this.root.classList.add('is-fading');
      await new Promise((r) => setTimeout(r, FADE_MS));
    }
    if (this.gone) return;
    this.hide();
  }

  /** up and taking input (loading, failed, or the hand-off before control is released) */
  get blocking(): boolean {
    return this.state !== 'hidden' && !this.releasing;
  }

  /** hidden (a cancel or another load may hide it while finish() waits) */
  private get gone(): boolean {
    return this.state === 'hidden';
  }

  hide(): void {
    this.state = 'hidden';
    this.releasing = false;
    cancelAnimationFrame(this.raf);
    this.root.hidden = true;
    this.root.classList.remove('is-fading', 'is-error');
    this.progress = null;
  }
}
