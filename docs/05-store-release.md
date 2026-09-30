# Store release — iOS, Android, Meta Quest

App ID on every store: **`com.cowork.dronesim`** (cannot change after the first release).

| Target | Shell | Why |
|---|---|---|
| iPhone / iPad (App Store) | Capacitor `ios/` (WKWebView) | offline bundle of `dist/`, touch + gamepad |
| Android phones / tablets (Google Play) | Capacitor `android/` (WebView) | same |
| Meta Quest (Horizon Store) | PWA packaged as APK | Android WebView has no WebXR; the Quest Browser engine does |

## Build

```bash
npm run cap:sync        # vite build + copy dist/ into both native projects
npm run ios             # sync + open Xcode
npm run android         # sync + open Android Studio
npm run android:apk     # sync + debug APK → android/app/build/outputs/apk/debug/
```

Android builds need `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.
Icons / splash come from `assets/` (`npx capacitor-assets generate --ios --android`).

Native behaviour: landscape only, status/navigation bars hidden, dark splash. In the app the web
code sees `device.native` (`src/core/device.ts`): no "Add to Home Screen" gate, Quit exits on Android
and is hidden on iOS (apps must not close themselves).

## App Store (iOS / iPadOS)

1. Apple Developer Program ($99/yr). In Xcode → *App* target → *Signing & Capabilities*: pick the team;
   register the Bundle ID `com.cowork.dronesim`.
2. App Store Connect → new app (iPhone + iPad), SKU, primary language, category *Games → Simulation*.
3. Xcode → *Product → Archive* → *Distribute App* → App Store Connect → TestFlight → submit.
4. Store listing: screenshots 6.9" iPhone + 13" iPad (landscape), privacy policy URL, age rating,
   App Privacy = *Data not collected* (settings and best times stay on the device).

## Google Play (Android)

1. Play Console ($25 once) → create app `Drone Sim`, package `com.cowork.dronesim`.
2. Upload key: `keytool -genkey -v -keystore dronesim-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
   — keep the file and passwords outside the repo; enrol in Play App Signing.
3. Android Studio → *Build → Generate Signed App Bundle* (`.aab`) → internal testing → production.
4. Listing: phone + 7"/10" tablet screenshots, feature graphic 1024×500, privacy policy URL,
   Data safety = no data collected, content rating questionnaire. New personal accounts must run a
   closed test (12 testers, 14 days) before production.

## Meta Horizon Store (Quest)

Needs the game hosted at an HTTPS origin whose **root** serves `/.well-known/assetlinks.json`
(a GitHub *project* page cannot) — a custom domain on GitHub Pages / Cloudflare Pages.

1. Manifest for the store build: absolute `start_url` on that origin, `"display": "standalone"`,
   `"ovr_package_name": "com.cowork.dronesim"`.
2. `ovr-platform-util create-pwa -o drone-sim-quest.apk --android-sdk ~/Library/Android/sdk
   --manifest-content-file manifest.json --package-name com.cowork.dronesim` (signs with a keystore).
3. Publish `assetlinks.json` with that keystore's SHA-256 fingerprint.
4. Meta Developer Dashboard → organisation → new Quest app → upload the APK to a release channel
   (ALPHA for testers) → store listing, age rating (IARC), data-use checkup → submit for review.

The Capacitor Android APK is **not** for Quest (no VR there). Do not install both on one headset:
they share the package name with different signatures.
