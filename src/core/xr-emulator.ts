/**
 * `?xremu=1`: installs Meta's IWER runtime as an emulated Quest 2 with Touch controllers, so the
 * VR path can be flown and tested in a desktop browser (and Playwright) without a headset.
 * The device is exposed as `window.__xrDevice` for scripted controller input.
 */
import { XRDevice, metaQuest2 } from 'iwer';

export function installXrEmulator(): XRDevice {
  const device = new XRDevice(metaQuest2);
  device.installRuntime({ forceInstall: true });
  (window as unknown as { __xrDevice: XRDevice }).__xrDevice = device;
  return device;
}
