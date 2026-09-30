import type { CapacitorConfig } from '@capacitor/cli';

/** Native iOS / Android shells around the Vite build (dist/). Meta Quest ships as a PWA instead (WebXR). */
const config: CapacitorConfig = {
  appId: 'com.cowork.dronesim',
  appName: 'Drone Sim',
  webDir: 'dist',
  backgroundColor: '#05070d',
  ios: { contentInset: 'never', backgroundColor: '#05070d' },
  android: { backgroundColor: '#05070d' },
};

export default config;
