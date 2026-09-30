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

/** Must be called inside a user gesture (click / controller select). */
export function requestVrSession(nav: Navigator): Promise<XRSession> {
  const xr = (nav as Navigator & { xr?: XRSystem }).xr;
  if (!xr) return Promise.reject(new Error('WebXR is not available'));
  return xr.requestSession('immersive-vr', SESSION_INIT);
}
