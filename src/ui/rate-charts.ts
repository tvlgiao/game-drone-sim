/** Betaflight-style rate preview + throttle curve (SVG). Curves redraw on settings change only; live dots are cheap attribute updates. */
import { throttleOutput } from '../control/flight-controller';
import { actualRate } from '../control/rates';
import { RATE_AXES, type RateAxis, type Settings } from '../core/settings';
import { hoverThrottle } from '../physics/drone-params';
import type { ControlInput } from '../types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SAMPLES = 48;
const LIVE_MS = 16;
const TEXT_MS = 50;

const RW = 420;
const RH = 240;
const RP = { l: 46, r: 12, t: 12, b: 24 };
const TW = 420;
const TH = 170;
const TP = { l: 50, r: 12, t: 10, b: 28 };
/** clearance between the axis labels and the plot edge: the live dot (r 5 + stroke) sits on the 0 / 0 % corner */
const T_LABEL_GAP = 10;

export const HOVER = hoverThrottle();

/** Motor command the flight controller produces for a stick value (mid auto = hover). */
export function throttleOut(stick: number, s: Pick<Settings, 'throttleMid' | 'throttleExpo' | 'throttleLimit'>): number {
  return throttleOutput(stick, s.throttleMid ?? HOVER, s.throttleExpo, s.throttleLimit);
}

/** Rate chart y-range: max rate rounded up to 200 °/s, at least 400. */
export function rateScale(s: Pick<Settings, 'rates'>): number {
  const m = Math.max(s.rates.roll.max, s.rates.pitch.max, s.rates.yaw.max);
  return Math.max(400, Math.ceil(m / 200) * 200);
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
}

export class RateCharts {
  private readonly rateSvg: SVGSVGElement;
  private readonly thrSvg: SVGSVGElement;
  private readonly grid: SVGGElement;
  private readonly paths: Record<RateAxis, SVGPathElement>;
  private readonly dots: Record<RateAxis, SVGCircleElement>;
  private readonly thrGrid: SVGGElement;
  private readonly thrPath: SVGPathElement;
  private readonly thrDot: SVGCircleElement;
  private readonly legend: Record<RateAxis, { max: HTMLElement; now: HTMLElement }>;
  private readonly thrNow: HTMLElement;
  private readonly cache = new Map<Element, string>();
  private key = '';
  private scale = 800;
  private settings: Settings | null = null;
  private liveAt = -Infinity;
  private textAt = -Infinity;

  constructor(rateBox: HTMLElement, thrBox: HTMLElement) {
    this.rateSvg = el('svg', { viewBox: `0 0 ${RW} ${RH}`, class: 'ds-chart__svg', role: 'img', 'aria-label': 'Rate curves, deg/s vs stick' }, rateBox);
    this.grid = el('g', { class: 'ds-chart__grid' }, this.rateSvg);
    this.paths = {} as Record<RateAxis, SVGPathElement>;
    this.dots = {} as Record<RateAxis, SVGCircleElement>;
    for (const a of RATE_AXES) this.paths[a] = el('path', { class: `ds-chart__line is-${a}` }, this.rateSvg);
    for (const a of RATE_AXES) this.dots[a] = el('circle', { r: 5, class: `ds-chart__dot is-${a}` }, this.rateSvg);

    const legend = document.createElement('div');
    legend.className = 'ds-legend';
    this.legend = {} as Record<RateAxis, { max: HTMLElement; now: HTMLElement }>;
    for (const a of RATE_AXES) {
      const item = document.createElement('span');
      item.className = `ds-legend__item is-${a}`;
      item.innerHTML = `<i></i><b>${a.toUpperCase()}</b> <span class="ds-num" data-v="max"></span><span class="ds-num ds-legend__now" data-v="now"></span>`;
      legend.appendChild(item);
      this.legend[a] = { max: item.querySelector<HTMLElement>('[data-v="max"]')!, now: item.querySelector<HTMLElement>('[data-v="now"]')! };
    }
    rateBox.appendChild(legend);

    this.thrSvg = el('svg', { viewBox: `0 0 ${TW} ${TH}`, class: 'ds-chart__svg', role: 'img', 'aria-label': 'Throttle curve' }, thrBox);
    this.thrGrid = el('g', { class: 'ds-chart__grid' }, this.thrSvg);
    this.thrPath = el('path', { class: 'ds-chart__line is-thr' }, this.thrSvg);
    this.thrDot = el('circle', { r: 5, class: 'ds-chart__dot is-thr' }, this.thrSvg);
    const tl = document.createElement('div');
    tl.className = 'ds-legend';
    tl.innerHTML = `<span class="ds-legend__item is-thr"><i></i><b>THR</b> <span class="ds-num" data-v="now"></span></span><span class="ds-legend__item is-hover"><i></i><b>HOVER</b> <span class="ds-num">${Math.round(HOVER * 100)}%</span></span>`;
    thrBox.appendChild(tl);
    this.thrNow = tl.querySelector<HTMLElement>('[data-v="now"]')!;
  }

  /** Rebuilds curves when rate / throttle settings changed. */
  redraw(s: Settings): void {
    this.settings = s;
    const r = s.rates;
    const key = JSON.stringify([r, s.throttleMid, s.throttleExpo, s.throttleLimit]);
    if (key === this.key) return;
    this.key = key;
    this.scale = rateScale(s);
    this.drawRateGrid();
    for (const a of RATE_AXES) {
      let d = '';
      for (let i = 0; i <= SAMPLES; i++) {
        const x = -1 + (2 * i) / SAMPLES;
        d += `${i ? 'L' : 'M'}${this.rx(x).toFixed(1)} ${this.ry(actualRate(x, r[a])).toFixed(1)}`;
      }
      this.paths[a].setAttribute('d', d);
      this.legend[a].max.textContent = `${Math.round(r[a].max)}°/s`;
    }
    this.drawThrGrid(s);
    let d = '';
    for (let i = 0; i <= SAMPLES; i++) {
      const x = i / SAMPLES;
      d += `${i ? 'L' : 'M'}${this.tx(x).toFixed(1)} ${this.ty(throttleOut(x, s)).toFixed(1)}`;
    }
    this.thrPath.setAttribute('d', d);
    this.cache.clear();
    this.liveAt = -Infinity;
  }

  /** Moves the live stick dots (≤60 Hz) and refreshes live numbers (~20 Hz). */
  updateLive(c: ControlInput, now: number): void {
    const s = this.settings;
    if (!s || now - this.liveAt < LIVE_MS) return;
    this.liveAt = now;
    const text = now - this.textAt >= TEXT_MS;
    if (text) this.textAt = now;
    for (const a of RATE_AXES) {
      const stick = c[a];
      const v = actualRate(stick, s.rates[a]);
      this.attr(this.dots[a], `translate(${this.rx(stick).toFixed(1)} ${this.ry(v).toFixed(1)})`);
      if (text) this.txt(this.legend[a].now, `${v >= 0 ? ' ' : ''}${Math.round(v)}°/s`);
    }
    const out = throttleOut(c.throttle, s);
    this.attr(this.thrDot, `translate(${this.tx(c.throttle).toFixed(1)} ${this.ty(out).toFixed(1)})`);
    if (text) this.txt(this.thrNow, `${Math.round(c.throttle * 100)}% → ${Math.round(out * 100)}%`);
  }

  private rx(stick: number): number {
    return RP.l + ((stick + 1) / 2) * (RW - RP.l - RP.r);
  }

  private ry(dps: number): number {
    return RP.t + (1 - (dps + this.scale) / (2 * this.scale)) * (RH - RP.t - RP.b);
  }

  private tx(v: number): number {
    return TP.l + v * (TW - TP.l - TP.r);
  }

  private ty(v: number): number {
    return TP.t + (1 - v) * (TH - TP.t - TP.b);
  }

  private drawRateGrid(): void {
    const g = this.grid;
    g.textContent = '';
    const m = this.scale;
    for (const v of [-m, -m / 2, 0, m / 2, m]) {
      el('line', { x1: RP.l, x2: RW - RP.r, y1: this.ry(v), y2: this.ry(v), class: v === 0 ? 'is-zero' : '' }, g);
      el('text', { x: RP.l - 6, y: this.ry(v) + 4, class: 'ds-chart__ylabel' }, g).textContent = `${v}`;
    }
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      el('line', { x1: this.rx(x), x2: this.rx(x), y1: RP.t, y2: RH - RP.b, class: x === 0 ? 'is-zero' : '' }, g);
      el('text', { x: this.rx(x), y: RH - 6, class: 'ds-chart__xlabel' }, g).textContent = x === 0 ? '0' : `${x > 0 ? '+' : ''}${x}`;
    }
  }

  private drawThrGrid(s: Settings): void {
    const g = this.thrGrid;
    g.textContent = '';
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      el('line', { x1: TP.l, x2: TW - TP.r, y1: this.ty(v), y2: this.ty(v) }, g);
      el('text', { x: TP.l - T_LABEL_GAP, y: this.ty(v) + 4, class: 'ds-chart__ylabel' }, g).textContent = `${v * 100}%`;
      el('line', { x1: this.tx(v), x2: this.tx(v), y1: TP.t, y2: TH - TP.b }, g);
      el('text', { x: this.tx(v), y: TH - TP.b + T_LABEL_GAP + 8, class: 'ds-chart__xlabel' }, g).textContent = `${v * 100}`;
    }
    el('line', { x1: TP.l, x2: TW - TP.r, y1: this.ty(HOVER), y2: this.ty(HOVER), class: 'is-hover' }, g);
    if (s.throttleLimit < 1) el('line', { x1: TP.l, x2: TW - TP.r, y1: this.ty(s.throttleLimit), y2: this.ty(s.throttleLimit), class: 'is-limit' }, g);
  }

  private attr(e: SVGElement, t: string): void {
    if (this.cache.get(e) === t) return;
    this.cache.set(e, t);
    e.setAttribute('transform', t);
  }

  private txt(e: HTMLElement, t: string): void {
    if (this.cache.get(e) === t) return;
    this.cache.set(e, t);
    e.textContent = t;
  }
}
