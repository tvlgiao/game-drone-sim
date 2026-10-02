/** WebXR availability and session request (Meta Quest Browser, desktop emulators). */

/** Features asked for; local-floor puts y = 0 on the real floor so the pilot stands at their own height. */
const SESSION_INIT: XRSessionInit = { optionalFeatures: ['local-floor', 'bounded-floor'] };

/** Quest Browser (and other Oculus/Meta runtimes) by user agent — used before the async support check. */
export function isQuestBrowser(userAgent: string): boolean {
  return /OculusBrowser|Quest/i.test(userAgent);
}

/** Resolves true when an immersive-vr session can be started on this browser/device. */
export async function vrSupported(nav: Navigator): Promise<boolean> {
  const xr = (nav as Navigator & { xr?: XRSystem }).xr;
  if (!xr) return false;
  try {
    return await xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

/**
 * Quest Browser fires `sessiongranted` on navigator.xr when the page was opened from VR (the Horizon
 * Store app in immersive mode, or a link followed inside a session): requestSession may then be called
 * without a user gesture. Returns an unsubscribe function.
 */
export function onSessionGranted(nav: Navigator, cb: () => void): () => void {
  const xr = (nav as Navigator & { xr?: XRSystem }).xr;
  if (!xr || typeof xr.addEventListener !== 'function') return () => undefined;
  xr.addEventListener('sessiongranted', cb);
  return () => xr.removeEventListener('sessiongranted', cb);
}

/** Must be called inside a user gesture (click / controller select), or after `sessiongranted`. */
export function requestVrSession(nav: Navigator): Promise<XRSession> {
  const xr = (nav as Navigator & { xr?: XRSystem }).xr;
  if (!xr) return Promise.reject(new Error('WebXR is not available'));
  return xr.requestSession('immersive-vr', SESSION_INIT);
}

/** Quest's native refresh rate: the game holds it at Quest 2 budget instead of chasing 90/120 Hz. */
export const XR_TARGET_FPS = 72;

/** The session parts tuneXrSession touches (optional: older runtimes lack the frame-rate API). */
export interface TunableXrSession {
  supportedFrameRates?: ArrayLike<number> | null;
  updateTargetFrameRate?: (rate: number) => Promise<void>;
}

/**
 * Pins the headset to XR_TARGET_FPS where the runtime offers it and asks for maximum fixed foveation
 * (edges at lower resolution). Never throws: unsupported runtimes simply keep their defaults.
 */
export async function tuneXrSession(session: TunableXrSession, xr: { setFoveation(v: number): void }): Promise<void> {
  try {
    xr.setFoveation(1);
  } catch {
    /* no fixed foveation on this layer type */
  }
  const rates = session.supportedFrameRates;
  if (typeof session.updateTargetFrameRate !== 'function' || !rates || !Array.prototype.includes.call(rates, XR_TARGET_FPS)) return;
  try {
    await session.updateTargetFrameRate(XR_TARGET_FPS);
  } catch {
    /* the runtime refused the rate: its own default stays */
  }
}

/** The pilot cannot see or reach the game (system menu over it, headset taken off): pause and mute. */
export function xrSessionObscured(state: XRVisibilityState | undefined): boolean {
  return state === 'hidden' || state === 'visible-blurred';
}
