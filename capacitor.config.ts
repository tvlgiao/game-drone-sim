import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native iOS / Android shells around the native game build (`npm run build:native` → dist-native/, whose
 * index.html is the game itself: no landing page, no store gate). Meta Quest ships as a PWA instead (WebXR).
 */
const config: CapacitorConfig = {
  appId: 'com.cowork.dronesim',
  appName: 'Drone Sim',
  webDir: 'dist-native',
  backgroundColor: '#05070d',
  ios: { contentInset: 'never', backgroundColor: '#05070d' },
  android: { backgroundColor: '#05070d' },
};

export default config;
