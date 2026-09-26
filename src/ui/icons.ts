/** Inline SVG markup (static strings, no user data). */

export const ICON_GAMEPAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.2 6h9.6c2.3 0 3.9 1.5 4.4 3.8l1.2 5.9c.4 2-1 3.8-2.8 3.8-1.1 0-1.9-.6-2.5-1.5L15.8 16H8.2l-1.3 2c-.6.9-1.4 1.5-2.5 1.5-1.8 0-3.2-1.8-2.8-3.8L2.8 9.8C3.3 7.5 4.9 6 7.2 6Zm0 3.2v1.3H5.9v1.4h1.3v1.3h1.4v-1.3h1.3v-1.4H8.6V9.2H7.2Zm9.4 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm-1.8 1.8a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"/></svg>`;

export const ICON_KEYBOARD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3.5 6h17A1.5 1.5 0 0 1 22 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 16.5v-9A1.5 1.5 0 0 1 3.5 6Zm1 2.2v1.6h1.6V8.2H4.5Zm3 0v1.6h1.6V8.2H7.5Zm3 0v1.6h1.6V8.2h-1.6Zm3 0v1.6h1.6V8.2h-1.6Zm3 0v1.6h3v-1.6h-3Zm-12 3v1.6h3v-1.6h-3Zm4 0v1.6h1.6v-1.6H8.5Zm3 0v1.6h1.6v-1.6h-1.6Zm3 0v1.6h1.6v-1.6h-1.6Zm3 0v1.6h1.9v-1.6h-1.9ZM7 14.2v1.6h10v-1.6H7Z"/></svg>`;

export const ICON_TOUCH = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="13" r="2.2" fill="currentColor"/><circle cx="16" cy="11" r="2.2" fill="currentColor"/></svg>`;

export const ICON_NONE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 3"/></svg>`;

export interface DiagramLabels {
  left: string;
  right: string;
  rt: string;
  /** stick holding throttle, highlighted magenta ('rt' when the trigger is the throttle) */
  thr: 'left' | 'right' | 'rt';
}

/** Xbox-style controller with leader-line labels for the selected stick mode. Labels are static app strings. */
export const controllerDiagram = (l: DiagramLabels): string => `
<svg class="ds-pad" viewBox="0 0 760 370" role="img" aria-label="Xbox controller mapping diagram">
  <defs>
    <linearGradient id="dsPadBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2638"/><stop offset="1" stop-color="#0c121d"/>
    </linearGradient>
    <radialGradient id="dsStick" cx="0.4" cy="0.35" r="0.7">
      <stop offset="0" stop-color="#3a4760"/><stop offset="1" stop-color="#121926"/>
    </radialGradient>
  </defs>
  <g class="ds-pad__body">
    <rect x="245" y="64" width="54" height="26" rx="10" class="ds-pad__trig"/>
    <rect x="461" y="64" width="54" height="26" rx="10" class="ds-pad__trig${l.thr === 'rt' ? ' is-hot-m' : ''}"/>
    <path d="M232 104c14-12 52-16 82-10l-4 12c-28-4-58 0-74 8Z" class="ds-pad__bump"/>
    <path d="M528 104c-14-12-52-16-82-10l4 12c28-4 58 0 74 8Z" class="ds-pad__bump is-hot"/>
    <path d="M260 110C300 95 460 95 500 110C560 120 600 150 620 230C635 290 620 330 585 330C550 330 530 300 510 270C490 245 270 245 250 270C230 300 210 330 175 330C140 330 125 290 140 230C160 150 200 120 260 110Z" fill="url(#dsPadBody)" class="ds-pad__shell"/>
    <circle cx="380" cy="128" r="13" class="ds-pad__logo"/>
    <circle cx="295" cy="160" r="25" fill="url(#dsStick)" class="ds-pad__stick ${l.thr === 'left' ? 'is-hot-m' : 'is-hot'}"/>
    <circle cx="435" cy="218" r="25" fill="url(#dsStick)" class="ds-pad__stick ${l.thr === 'right' ? 'is-hot-m' : 'is-hot'}"/>
    <path d="M329 199h12v-12h10v12h12v10h-12v12h-10v-12h-12Z" class="ds-pad__dpad"/>
    <rect x="345" y="146" width="16" height="10" rx="5" class="ds-pad__small"/>
    <rect x="399" y="146" width="16" height="10" rx="5" class="ds-pad__small is-hot"/>
    <circle cx="480" cy="138" r="11" class="ds-pad__btn" style="--c:#ffd23d"/>
    <circle cx="458" cy="160" r="11" class="ds-pad__btn" style="--c:#4da3ff"/>
    <circle cx="502" cy="160" r="11" class="ds-pad__btn" style="--c:#ff4d5e"/>
    <circle cx="480" cy="182" r="11" class="ds-pad__btn" style="--c:#3dff9a"/>
    <text x="480" y="142" class="ds-pad__glyph">Y</text>
    <text x="458" y="164" class="ds-pad__glyph">X</text>
    <text x="502" y="164" class="ds-pad__glyph">B</text>
    <text x="480" y="186" class="ds-pad__glyph">A</text>
  </g>
  <g class="ds-pad__leads">
    <polyline points="270,160 190,160 170,140"/>
    <polyline points="329,204 190,250 170,250"/>
    <polyline points="407,146 407,40"/>
    <polyline points="515,70 580,50 600,50"/>
    <polyline points="518,104 580,94 600,94"/>
    <polyline points="491,134 580,128 600,128"/>
    <polyline points="513,160 600,164"/>
    <polyline points="491,186 580,200 600,200"/>
    <polyline points="460,222 580,262 600,262"/>
  </g>
  <g class="ds-pad__labels">
    <text x="20" y="128"><tspan class="k">LEFT STICK</tspan></text>
    <text x="20" y="148">${l.left}</text>
    <text x="20" y="246"><tspan class="k">D-PAD</tspan></text>
    <text x="20" y="266">Menu navigation</text>
    <text x="407" y="32" text-anchor="middle"><tspan class="k">MENU</tspan> Pause</text>
    <text x="606" y="55"><tspan class="k">RT</tspan> ${l.rt}</text>
    <text x="606" y="99"><tspan class="k">RB</tspan> Camera</text>
    <text x="606" y="133"><tspan class="k">Y</tspan> Flight mode</text>
    <text x="606" y="169"><tspan class="k">B</tspan> Reset · Back</text>
    <text x="606" y="205"><tspan class="k">A</tspan> Arm · Select</text>
    <text x="606" y="256"><tspan class="k">RIGHT STICK</tspan></text>
    <text x="606" y="276">${l.right}</text>
  </g>
</svg>`;
