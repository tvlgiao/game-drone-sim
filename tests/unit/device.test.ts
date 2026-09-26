import { describe, expect, it } from 'vitest';
import { canVibrate, formFactor, fullscreenSupported, isIOS, isStandalone, isTouchDevice, needsRotate, requestFullscreen, type DeviceEnv } from '../../src/core/device';
import { MOBILE_MAX_DPR, QUALITY_PROFILES, pickTier, qualityProfile, targetFps, type GpuInfo } from '../../src/core/quality';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IPADOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function env(extra: Partial<DeviceEnv>): DeviceEnv {
  return { maxTouchPoints: 0, coarsePointer: false, userAgent: MAC_CHROME, screenW: 1920, screenH: 1080, navigatorStandalone: false, displayModeApp: false, hasVibrate: false, ...extra };
}

describe('device detection', () => {
  it('touch = maxTouchPoints > 1 or coarse pointer; desktop mouse is not touch', () => {
    expect(isTouchDevice(env({}))).toBe(false);
    expect(isTouchDevice(env({ maxTouchPoints: 1 }))).toBe(false); // some Windows laptops report 1
    expect(isTouchDevice(env({ maxTouchPoints: 5 }))).toBe(true);
    expect(isTouchDevice(env({ coarsePointer: true }))).toBe(true);
  });

  it('iOS: iPhone UA, and iPadOS desktop-class UA with touch points (not a real Mac)', () => {
    expect(isIOS(env({ userAgent: IPHONE, maxTouchPoints: 5 }))).toBe(true);
    expect(isIOS(env({ userAgent: IPADOS, maxTouchPoints: 5 }))).toBe(true);
    expect(isIOS(env({ userAgent: IPADOS, maxTouchPoints: 0 }))).toBe(false);
    expect(isIOS(env({ userAgent: ANDROID, maxTouchPoints: 5 }))).toBe(false);
  });

  it('phone vs tablet by the short screen side (< 500 CSS px), either orientation', () => {
    expect(formFactor(env({ maxTouchPoints: 5, screenW: 402, screenH: 874 }))).toBe('phone');
    expect(formFactor(env({ maxTouchPoints: 5, screenW: 874, screenH: 402 }))).toBe('phone');
    expect(formFactor(env({ maxTouchPoints: 5, screenW: 1032, screenH: 1376 }))).toBe('tablet');
    expect(formFactor(env({ maxTouchPoints: 5, screenW: 744, screenH: 1133 }))).toBe('tablet'); // iPad mini
    expect(formFactor(env({ screenW: 390, screenH: 844 }))).toBe('desktop'); // small window, no touch
  });

  it('standalone: navigator.standalone (iOS) or display-mode standalone/fullscreen', () => {
    expect(isStandalone(env({}))).toBe(false);
    expect(isStandalone(env({ navigatorStandalone: true }))).toBe(true);
    expect(isStandalone(env({ displayModeApp: true }))).toBe(true);
  });

  it('vibrate only when present and never on iOS', () => {
    expect(canVibrate(env({ userAgent: ANDROID, maxTouchPoints: 5, hasVibrate: true }))).toBe(true);
    expect(canVibrate(env({ userAgent: IPHONE, maxTouchPoints: 5, hasVibrate: true }))).toBe(false);
    expect(canVibrate(env({ userAgent: ANDROID, hasVibrate: false }))).toBe(false);
  });

  it('rotate overlay only for phones in portrait', () => {
    expect(needsRotate('phone', 402, 874)).toBe(true);
    expect(needsRotate('phone', 874, 402)).toBe(false);
    expect(needsRotate('tablet', 1032, 1376)).toBe(false);
    expect(needsRotate('desktop', 500, 900)).toBe(false);
  });
});

describe('fullscreen helpers', () => {
  const doc = (el: Record<string, unknown>, extra: Record<string, unknown> = {}): Document => ({ documentElement: el, ...extra }) as unknown as Document;

  it('supported via the standard or webkit-prefixed API, unless disabled', () => {
    expect(fullscreenSupported(doc({}))).toBe(false); // iPhone Safari: no element fullscreen
    expect(fullscreenSupported(doc({ requestFullscreen: () => Promise.resolve() }, { fullscreenEnabled: true }))).toBe(true);
    expect(fullscreenSupported(doc({ webkitRequestFullscreen: () => undefined }, { webkitFullscreenEnabled: true }))).toBe(true);
    expect(fullscreenSupported(doc({ requestFullscreen: () => Promise.resolve() }, { fullscreenEnabled: false }))).toBe(false);
  });

  it('request uses the webkit fallback with navigationUI hide and reports refusal as false', async () => {
    let opts: unknown = null;
    const ok = await requestFullscreen(doc({ webkitRequestFullscreen: (o: unknown) => void (opts = o) }, { webkitFullscreenEnabled: true }));
    expect(ok).toBe(true);
    expect(opts).toEqual({ navigationUI: 'hide' });
    const refused = await requestFullscreen(doc({ requestFullscreen: () => Promise.reject(new Error('denied')) }, { fullscreenEnabled: true }));
    expect(refused).toBe(false);
    expect(await requestFullscreen(doc({}))).toBe(false);
  });
});

describe('mobile quality', () => {
  const apple: GpuInfo = { webgl2: true, software: false, renderer: 'Apple GPU' };

  it('phone → medium, tablet → high, desktop keeps the GPU heuristic; software GL stays low', () => {
    expect(pickTier(apple, 'phone')).toBe('medium');
    expect(pickTier(apple, 'tablet')).toBe('high');
    expect(pickTier(apple, 'desktop')).toBe('high');
    expect(pickTier(apple)).toBe('high');
    expect(pickTier({ ...apple, software: true }, 'tablet')).toBe('low');
  });

  it('mobile profiles cap DPR (phone 1.5, tablet 1.75), shadow maps ≤ 1024 and halve/trim particles', () => {
    const ph = qualityProfile('medium', 'phone');
    expect(ph.maxDpr).toBe(MOBILE_MAX_DPR.phone);
    expect(ph.particles).toBe(QUALITY_PROFILES.medium.particles / 2);
    const tab = qualityProfile('high', 'tablet');
    expect(tab.maxDpr).toBe(1.75);
    expect(tab.shadowMapSize).toBe(1024);
    expect(tab.particles).toBe(Math.round(QUALITY_PROFILES.high.particles * 0.75));
    expect(qualityProfile('low', 'phone').maxDpr).toBe(1);
    expect(qualityProfile('ultra', 'desktop')).toBe(QUALITY_PROFILES.ultra);
    expect(qualityProfile('high', 'tablet')).toBe(tab); // cached, no per-call allocation
  });

  it('dynamic resolution targets 60 fps on mobile, 120 on desktop', () => {
    expect(targetFps('phone')).toBe(60);
    expect(targetFps('tablet')).toBe(60);
    expect(targetFps('desktop')).toBe(120);
  });
});
