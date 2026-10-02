/**
 * Tutorial DOM overlay: the step card, the hint glow on the HUD stick wells / touch controls, the first-run
 * prompt and the completion card. Emits callbacks only; the integrator wires them to the game (see
 * docs/08-tutorial-integration.md). Dialog buttons follow the menus' focus model (.is-focused, d-pad / arrows,
 * confirm, back) and stay plain buttons for pointer, Tab and screen readers.
 */
import './tutorial.css';
import type { InputSource, NavEvents } from '../types';
import { GP } from '../input/gamepad';
import { buttonLabel, type PromptButton } from './mode-labels';
import { glyphHtml, hintScheme, keyGlyph, padFamily, padGlyph, type Glyph } from './input-glyphs';
import { TOKEN_CLOSE, TOKEN_OPEN, type TutorialView } from './tutorial-prompts';

export type TutorialFinishAction = 'training' | 'menu';

export interface TutorialUiCallbacks {
  /** first-run prompt: Start */
  onStart(): void;
  /** first-run prompt Skip, or the card's Skip button */
  onSkip(): void;
  /** the welcome card's Continue button (pointer / touch); feed it into `TutorialCtx.confirm` */
  onConfirm(): void;
  /** completion card */
  onFinish(action: TutorialFinishAction): void;
}

type DialogName = 'prompt' | 'done';

/** HUD / touch elements a hint can highlight (selectors into hud.ts and touch-controls.ts markup). */
const STICK_TARGETS: Record<'l' | 'r', string> = {
  l: '[data-r="wellL"], .ds-tstick[data-side="l"] .ds-tstick__base',
  r: '[data-r="wellR"], .ds-tstick[data-side="r"] .ds-tstick__base',
};
const BUTTON_TARGETS: Partial<Record<PromptButton, string>> = {
  arm: '[data-tbtn="arm"], [data-r="armed"]',
  toggleMode: '[data-tbtn="toggleMode"], [data-r="mode"]',
  cycleCamera: '[data-tbtn="cycleCamera"], [data-r="cam"]',
  confirm: '.ds-tut-continue',
};
const THROTTLE_TARGET = '[data-r="thrFill"]';

const CARD_HTML = `
<div class="ds-tut-card ds-panel" role="region" aria-label="Tutorial" hidden>
  <div class="ds-tut-card__head">
    <span class="ds-tut-card__step" data-t="step"></span>
    <span class="ds-tut-card__tag" data-t="tag" hidden>Hint</span>
    <button type="button" class="ds-tut-skip" data-t="skip"><span>Skip</span><span class="ds-tut-skip__g" data-t="skipg"></span></button>
  </div>
  <h2 class="ds-tut-card__title" data-t="title"></h2>
  <div class="ds-tut-card__lines" data-t="lines" aria-live="polite"><p></p><p></p></div>
  <div class="ds-tut-parts" data-t="parts" hidden></div>
  <div class="ds-tut-bar" data-t="bar" role="progressbar" aria-label="Step progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
  <div class="ds-tut-card__foot" data-t="foot" hidden>
    <button type="button" class="ds-btn ds-btn--sm ds-btn--primary ds-tut-continue" data-t="continue"><span class="ds-tut-continue__g" data-t="contg"></span><span>Continue</span></button>
  </div>
</div>`;

const PROMPT_HTML = `
<div class="ds-screen ds-tut-screen" data-dialog="prompt" role="dialog" aria-modal="true" aria-labelledby="ds-tut-prompt-title" aria-describedby="ds-tut-prompt-text">
  <div class="ds-dialog ds-panel ds-glass">
    <h2 class="ds-dialog__title" id="ds-tut-prompt-title">New to FPV?</h2>
    <p class="ds-tut-dialog__lead" id="ds-tut-prompt-text">A 3-minute tutorial: arm, hover, turn, land and fly your first ring.</p>
    <p class="ds-tut-dialog__text">You can replay it any time from the menu.</p>
    <div class="ds-dialog__actions">
      <button type="button" class="ds-btn ds-btn--ghost" data-act="skip">Skip</button>
      <button type="button" class="ds-btn ds-btn--primary" data-act="start" data-autofocus>Start</button>
    </div>
  </div>
</div>`;

const DONE_HTML = `
<div class="ds-screen ds-tut-screen" data-dialog="done" role="dialog" aria-modal="true" aria-labelledby="ds-tut-done-title" aria-describedby="ds-tut-done-text">
  <div class="ds-dialog ds-panel ds-glass">
    <h2 class="ds-dialog__title" id="ds-tut-done-title">Tutorial complete</h2>
    <p class="ds-tut-dialog__lead" id="ds-tut-done-text"></p>
    <p class="ds-tut-dialog__text" data-t="done-next"></p>
    <div class="ds-dialog__actions">
      <button type="button" class="ds-btn ds-btn--ghost" data-act="menu">Menu</button>
      <button type="button" class="ds-btn ds-btn--primary" data-act="training" data-autofocus>Start Training</button>
    </div>
  </div>
</div>`;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (t: string): string => t.replace(/[&<>"]/g, (c) => ESC[c]!);
const ARROW_WORD: Record<string, string> = { '↑': 'up', '↓': 'down', '←': 'left', '→': 'right' };

/** Prompt name of a glyph, as mode-labels' buttonLabel spells it ("A", "Cross", "Menu", "R-stick"). */
function promptName(g: Glyph): string {
  if (g.style === 'stick') return g.label.length === 1 ? `${g.label}-stick` : g.label;
  return g.label && g.style !== 'system' ? g.label : g.name;
}

/**
 * Glyph chip(s) for one prompt token: keycaps for keys, coloured face / shoulder glyphs for pad and Quest buttons,
 * a stick glyph plus its arrow for stick directions, the on-screen button's own look for touch.
 */
export function tokenHtml(token: string, src: InputSource, padId: string | null): string {
  const stick = /^(Left|Right) (stick|thumb) ([↑↓←→])$/.exec(token);
  if (stick) {
    const name = `${stick[1]} ${stick[2]} ${ARROW_WORD[stick[3]!]}`;
    return `<span class="ds-tut-tok" role="img" aria-label="${name}">${glyphHtml({ style: 'stick', label: stick[1]![0]!, name: `${stick[1]} ${stick[2]}` })}<span class="ds-tut-tok__arrow" aria-hidden="true">${stick[3]}</span></span>`;
  }
  const scheme = hintScheme(src === 'none' ? 'keyboard' : src, padId);
  const family = padFamily(padId);
  const trigger = /^(Squeeze|Release) (\S+)$/.exec(token);
  if (trigger) return `${trigger[1]} ${glyphHtml(padGlyph(family, GP.RT))}`;
  if (scheme === 'touch') return `<kbd class="ds-g ds-g--touch">${escapeHtml(token)}</kbd>`;
  if (scheme === 'quest') {
    const face = /^[ABXY]$/.test(token);
    return glyphHtml(face ? { style: 'face', label: token, name: token } : { style: 'stick', label: token[0]!, name: token, press: true });
  }
  if (scheme !== 'keyboard') {
    for (let i = 0; i <= GP.RIGHT; i++) {
      const g = padGlyph(family, i);
      if (promptName(g) === token) return glyphHtml(g);
    }
  }
  const named = Object.entries({ Esc: 'Escape', Space: 'Space', Enter: 'Enter' }).find(([l]) => l === token);
  return glyphHtml(named ? keyGlyph(named[1]) : keyGlyph(token.length === 1 && /[A-Z0-9]/.test(token) ? `Key${token}` : token));
}

/** A prompt line with its delimited tokens as glyph chips (the copy around them is escaped). */
export function richHtml(line: string, src: InputSource, padId: string | null): string {
  let out = '';
  let rest = line;
  for (let i = rest.indexOf(TOKEN_OPEN); i >= 0; i = rest.indexOf(TOKEN_OPEN)) {
    const j = rest.indexOf(TOKEN_CLOSE, i);
    if (j < 0) break;
    out += escapeHtml(rest.slice(0, i)) + tokenHtml(rest.slice(i + 1, j), src, padId);
    rest = rest.slice(j + 1);
  }
  return out + escapeHtml(rest);
}

/** The control that skips the tutorial, drawn in the card's Skip button ('' on touch: the button is it). */
function skipGlyphHtml(src: InputSource, padId: string | null): string {
  if (src === 'keyboard' || src === 'none') return glyphHtml(keyGlyph('Escape'));
  if (src === 'gamepad') return glyphHtml(padGlyph(padFamily(padId), GP.START));
  return '';
}

function fragment(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export class TutorialUi {
  private readonly root: HTMLElement;
  private readonly cb: TutorialUiCallbacks;
  private readonly card: HTMLElement;
  private readonly dialogs: Record<DialogName, HTMLElement>;
  private readonly el: {
    step: HTMLElement;
    title: HTMLElement;
    lines: HTMLParagraphElement[];
    parts: HTMLElement;
    bar: HTMLElement;
    barFill: HTMLElement;
    skip: HTMLButtonElement;
    skipGlyph: HTMLElement;
    tag: HTMLElement;
    cont: HTMLButtonElement;
    contGlyph: HTMLElement;
    foot: HTMLElement;
  };
  private readonly htmlCache = new Map<HTMLElement, string>();
  private readonly textCache = new Map<HTMLElement, string>();
  private open: DialogName | null = null;
  private focus = 0;
  private returnFocus: HTMLElement | null = null;
  private glowing: HTMLElement[] = [];
  private glowKey = '';
  private partsKey = '';
  private hintShown = false;
  /** the completion card was answered: a done view keeps rendering until the integrator drops the tutorial */
  private doneDismissed = false;
  private disposed = false;

  constructor(root: HTMLElement, cb: TutorialUiCallbacks) {
    this.root = root;
    this.cb = cb;
    this.card = fragment(CARD_HTML);
    this.dialogs = { prompt: fragment(PROMPT_HTML), done: fragment(DONE_HTML) };
    root.append(this.card, this.dialogs.prompt, this.dialogs.done);
    const q = <T extends HTMLElement>(sel: string): T => this.card.querySelector<T>(`[data-t="${sel}"]`)!;
    const lines = q('lines');
    this.el = {
      step: q('step'),
      title: q('title'),
      lines: [...lines.querySelectorAll('p')],
      parts: q('parts'),
      bar: q('bar'),
      barFill: q('bar').firstElementChild as HTMLElement,
      skip: q<HTMLButtonElement>('skip'),
      skipGlyph: q('skipg'),
      tag: q('tag'),
      cont: q<HTMLButtonElement>('continue'),
      contGlyph: q('contg'),
      foot: q('foot'),
    };
    this.el.skip.addEventListener('click', () => this.cb.onSkip());
    this.el.cont.addEventListener('click', () => this.cb.onConfirm());
    for (const name of ['prompt', 'done'] as const) {
      const d = this.dialogs[name];
      d.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b, i) => {
        b.addEventListener('click', () => this.activate(b.dataset.act!));
        b.addEventListener('pointerenter', () => this.open === name && this.setFocus(i, false));
      });
      d.addEventListener('keydown', (e) => this.onKey(e));
    }
  }

  /** A tutorial dialog is open (the integrator routes nav / confirm here instead of the menus). */
  get dialogOpen(): DialogName | null {
    return this.open;
  }

  /** First-run modal "New to FPV?" [Skip] [Start]. */
  showPrompt(): void {
    this.openDialog('prompt');
  }

  /**
   * Shows the state of the tutorial; null hides the card and any completion card. Cheap per frame: only
   * changed text / values touch the DOM.
   */
  render(view: TutorialView | null): void {
    if (this.disposed) return;
    const running = view !== null && view.phase === 'running';
    this.card.hidden = !running;
    // phones hide the HUD's arm hint under a running card: the card says the same, and there is no room for both
    this.root.classList.toggle('ds-tut-running', running);
    if (view?.id !== 'done') this.doneDismissed = false;
    if (view?.id === 'done' && view.phase === 'done' && !this.doneDismissed) {
      this.text(this.dialogs.done.querySelector<HTMLElement>('#ds-tut-done-text')!, view.lines[0] ?? '');
      this.text(this.dialogs.done.querySelector<HTMLElement>('[data-t="done-next"]')!, view.lines[1] ?? '');
      if (this.open !== 'done') this.openDialog('done');
    } else if (this.open === 'done') {
      this.closeDialog();
    }
    if (!running || !view) {
      this.setGlow(null);
      return;
    }
    const e = this.el;
    if (this.card.dataset.step !== view.id) this.card.dataset.step = view.id;
    this.html(e.step, `<span class="ds-tut-card__stepw">Step </span>${view.number} / ${view.total}`);
    this.text(e.title, view.title);
    // a hint re-announces the prompt: the live region only speaks changed text
    const reannounce = view.hint && !this.hintShown;
    this.hintShown = view.hint;
    // the welcome card's "Press Enter to start" is the Continue button (its glyph says which key)
    const welcome = view.id === 'welcome';
    const rich = welcome ? view.rich.slice(0, 1) : view.rich;
    for (let i = 0; i < e.lines.length; i++) {
      const p = e.lines[i]!;
      const t = rich[i] ?? '';
      if (reannounce) {
        this.htmlCache.delete(p);
        p.textContent = '';
      }
      this.html(p, t ? richHtml(t, view.source, view.padId) : '');
      p.hidden = t === '';
    }
    e.lines[1]?.classList.toggle('is-notice', view.rearm);
    this.card.classList.toggle('is-hint', view.hint);
    e.tag.hidden = !view.hint;
    const pct = Math.round(view.progress * 100);
    e.barFill.style.setProperty('--v', view.progress.toFixed(3));
    if (e.bar.getAttribute('aria-valuenow') !== String(pct)) e.bar.setAttribute('aria-valuenow', String(pct));
    this.renderParts(view);
    e.foot.hidden = !welcome;
    const skipG = skipGlyphHtml(view.source, view.padId);
    this.html(e.skipGlyph, skipG);
    e.skipGlyph.hidden = skipG === '';
    const via = view.source === 'gamepad' ? `pause with ${buttonLabel('pause', view.source, view.padId)}` : view.source === 'keyboard' || view.source === 'none' ? 'Esc' : '';
    e.skip.setAttribute('aria-label', via ? `Skip tutorial (${via})` : 'Skip tutorial');
    if (welcome) {
      const confirm = view.source === 'touch' ? '' : tokenHtml(buttonLabel('confirm', view.source, view.padId), view.source, view.padId);
      this.html(e.contGlyph, confirm);
      e.contGlyph.hidden = confirm === '';
    }
    this.setGlow(view.hint ? view : null);
  }

  /** Gamepad / keyboard on an open dialog. Returns true when the input was consumed. */
  navigate(nav: NavEvents, confirm: boolean): boolean {
    const name = this.open;
    if (!name) return false;
    const n = this.buttons().length;
    if (nav.left || nav.up) this.setFocus((this.focus - 1 + n) % n);
    if (nav.right || nav.down) this.setFocus((this.focus + 1) % n);
    if (confirm) this.activate(this.buttons()[this.focus]?.dataset.act ?? '');
    else if (nav.back) this.activate(name === 'prompt' ? 'skip' : 'menu');
    return true;
  }

  /** Hides the card and closes any dialog. */
  hide(): void {
    this.render(null);
    this.closeDialog();
  }

  dispose(): void {
    this.hide();
    this.disposed = true;
    this.card.remove();
    this.dialogs.prompt.remove();
    this.dialogs.done.remove();
  }

  private renderParts(view: TutorialView): void {
    const key = view.parts.map((p) => p.id).join('|');
    const box = this.el.parts;
    if (key !== this.partsKey) {
      this.partsKey = key;
      box.replaceChildren(
        ...view.parts.map((p) => {
          const chip = document.createElement('span');
          chip.className = 'ds-tut-part';
          chip.dataset.part = p.id;
          const fill = document.createElement('i');
          const label = document.createElement('span');
          label.textContent = p.label;
          chip.append(fill, label);
          return chip;
        }),
      );
      box.hidden = view.parts.length === 0;
    }
    view.parts.forEach((p, i) => {
      const chip = box.children[i] as HTMLElement | undefined;
      if (!chip) return;
      const done = p.value >= 1;
      if (chip.classList.contains('is-done') !== done) {
        chip.classList.toggle('is-done', done);
        chip.setAttribute('aria-label', `${p.label}${done ? ' done' : ''}`);
      }
      (chip.firstElementChild as HTMLElement).style.setProperty('--v', p.value.toFixed(3));
    });
  }

  private setGlow(view: TutorialView | null): void {
    const sels: string[] = [];
    if (view) {
      for (const s of view.focus.sides) sels.push(STICK_TARGETS[s]);
      if (view.focus.trigger) sels.push(THROTTLE_TARGET);
      const b = view.focus.button && BUTTON_TARGETS[view.focus.button];
      if (b) sels.push(b);
    }
    const key = sels.join(',');
    // touch controls mount after the tutorial: re-query while a hint is on
    if (key === this.glowKey && (!key || this.glowing.length > 0)) return;
    this.glowKey = key;
    for (const el of this.glowing) el.classList.remove('ds-tut-glow');
    this.glowing = key ? [...this.root.querySelectorAll<HTMLElement>(key)] : [];
    for (const el of this.glowing) el.classList.add('ds-tut-glow');
  }

  private buttons(): HTMLButtonElement[] {
    return this.open ? [...this.dialogs[this.open].querySelectorAll<HTMLButtonElement>('[data-act]')] : [];
  }

  private openDialog(name: DialogName): void {
    if (this.open === name) return;
    if (this.open) this.closeDialog();
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    this.open = name;
    const d = this.dialogs[name];
    d.classList.add('is-open');
    const btns = this.buttons();
    this.setFocus(Math.max(0, btns.findIndex((b) => b.hasAttribute('data-autofocus'))));
  }

  private closeDialog(): void {
    const name = this.open;
    if (!name) return;
    this.open = null;
    const d = this.dialogs[name];
    d.classList.remove('is-open');
    d.querySelectorAll('.is-focused').forEach((b) => b.classList.remove('is-focused'));
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    else if (d.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private setFocus(i: number, moveDomFocus = true): void {
    const btns = this.buttons();
    btns.forEach((b, k) => b.classList.toggle('is-focused', k === i));
    this.focus = i;
    if (moveDomFocus) btns[i]?.focus({ preventScroll: true });
  }

  /**
   * Tab cycles inside the open dialog. Arrows, Enter and Esc arrive through `navigate` from the game's input
   * manager (it consumes those keys), exactly like the menus.
   */
  private onKey(e: KeyboardEvent): void {
    const btns = this.buttons();
    if (e.key !== 'Tab' || !btns.length) return;
    e.preventDefault();
    this.setFocus((this.focus + (e.shiftKey ? btns.length - 1 : 1)) % btns.length);
  }

  private activate(act: string): void {
    const name = this.open;
    if (!name) return;
    if (name === 'prompt' && (act === 'start' || act === 'skip')) {
      this.closeDialog();
      if (act === 'start') this.cb.onStart();
      else this.cb.onSkip();
    } else if (name === 'done' && (act === 'training' || act === 'menu')) {
      this.doneDismissed = true;
      this.closeDialog();
      this.cb.onFinish(act);
    }
  }

  private html(el: HTMLElement, h: string): void {
    if (this.htmlCache.get(el) === h) return;
    this.htmlCache.set(el, h);
    el.innerHTML = h;
  }

  private text(el: HTMLElement, t: string): void {
    if (this.textCache.get(el) === t) return;
    this.textCache.set(el, t);
    el.textContent = t;
  }
}
