/**
 * Device detection (touch / phone / tablet / iOS / home-screen app) and Fullscreen API helpers.
 * Decisions are made on a plain `DeviceEnv` snapshot so they stay unit-testable without a DOM.
 * iPadOS reports a Mac user agent, so touch is detected from touch points + pointer media, never UA alone.
 */

export type FormFactor = 'phone' | 'tablet' | 'desktop';

/** Raw browser facts the helpers decide on. */
export interface DeviceEnv {
  maxTouchPoints: number;
  /** matchMedia('(pointer: coarse)') */
  coarsePointer: boolean;
  userAgent: string;
  /** screen width / height in CSS px (orientation-dependent on some browsers) */
  screenW: number;
  screenH: number;
  /** navigator.standalone (iOS home-screen web app) */
  navigatorStandalone: boolean;
  /** display-mode: standalone | fullscreen */
  displayModeApp: boolean;
  /** navigator.vibrate exists */
  hasVibrate: boolean;
}

export interface DeviceInfo {
  touch: boolean;
  form: FormFactor;
  ios: boolean;
  standalone: boolean;
  /** Fullscreen API usable on document.documentElement */
  fullscreen: boolean;
  vibrate: boolean;
}

/** Short screen side below this (CSS px) = phone. */
export const PHONE_MAX_SHORT_SIDE = 500;

export function isTouchDevice(env: Pick<DeviceEnv, 'maxTouchPoints' | 'coarsePointer'>): boolean {
  return env.maxTouchPoints > 1 || env.coarsePointer;
}

/** iPhone / iPod / iPad, including iPadOS 13+ which claims to be a Mac but has touch points. */
export function isIOS(env: Pick<DeviceEnv, 'userAgent' | 'maxTouchPoints'>): boolean {
  if (/iPhone|iPad|iPod/i.test(env.userAgent)) return true;
  return /Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1;
}

export function formFactor(env: Pick<DeviceEnv, 'maxTouchPoints' | 'coarsePointer' | 'screenW' | 'screenH'>): FormFactor {
  if (!isTouchDevice(env)) return 'desktop';
  const short = Math.min(env.screenW, env.screenH);
  return short > 0 && short < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
}

export function isStandalone(env: Pick<DeviceEnv, 'navigatorStandalone' | 'displayModeApp'>): boolean {
  return env.navigatorStandalone || env.displayModeApp;
}

/** Haptics: iOS Safari has no navigator.vibrate (and must never be asked). */
export function canVibrate(env: Pick<DeviceEnv, 'hasVibrate' | 'userAgent' | 'maxTouchPoints'>): boolean {
  return env.hasVibrate && !isIOS(env);
}

/** Landscape required on phones only; tablets play in either orientation. */
export function needsRotate(form: FormFactor, viewW: number, viewH: number): boolean {
  return form === 'phone' && viewH > viewW;
}

const media = (win: Window, q: string): boolean => {
  try {
    return typeof win.matchMedia === 'function' && win.matchMedia(q).matches;
  } catch {
    return false;
  }
};

export function readEnv(win: Window): DeviceEnv {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  return {
    maxTouchPoints: nav.maxTouchPoints || 0,
    coarsePointer: media(win, '(pointer: coarse)'),
    userAgent: nav.userAgent || '',
    screenW: win.screen?.width || win.innerWidth || 0,
    screenH: win.screen?.height || win.innerHeight || 0,
    navigatorStandalone: nav.standalone === true,
    displayModeApp: media(win, '(display-mode: standalone)') || media(win, '(display-mode: fullscreen)'),
    hasVibrate: typeof nav.vibrate === 'function',
  };
}

export function detectDevice(win: Window = window): DeviceInfo {
  const env = readEnv(win);
  return {
    touch: isTouchDevice(env),
    form: formFactor(env),
    ios: isIOS(env),
    standalone: isStandalone(env),
    fullscreen: fullscreenSupported(win.document),
    vibrate: canVibrate(env),
  };
}

// ---------------------------------------------------------------- Fullscreen API (+ webkit prefix)

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: (opts?: FullscreenOptions) => Promise<void> | void;
};
type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export function fullscreenSupported(doc: Document): boolean {
  const d = doc as FsDocument;
  const el = d.documentElement as FsElement | null;
  if (!el) return false;
  const api = typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? api;
  return api && enabled !== false;
}

export function isFullscreen(doc: Document): boolean {
  const d = doc as FsDocument;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/** Requests fullscreen on <html>; resolves true on success, false when unsupported or refused. */
export async function requestFullscreen(doc: Document): Promise<boolean> {
  if (!fullscreenSupported(doc)) return false;
  const el = doc.documentElement as FsElement;
  try {
    const opts: FullscreenOptions = { navigationUI: 'hide' };
    if (typeof el.requestFullscreen === 'function') await el.requestFullscreen(opts);
    else await el.webkitRequestFullscreen!(opts);
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen(doc: Document): Promise<void> {
  if (!isFullscreen(doc)) return;
  const d = doc as FsDocument;
  try {
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* already left */
  }
}

/** Toggles fullscreen; returns the resulting state. */
export async function toggleFullscreen(doc: Document): Promise<boolean> {
  if (isFullscreen(doc)) {
    await exitFullscreen(doc);
    return false;
  }
  return requestFullscreen(doc);
}
