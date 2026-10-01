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
