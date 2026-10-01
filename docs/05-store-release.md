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

Hosted at **https://dronesim.coworkgamestudio.com** (GitHub Pages custom domain, CNAME `dronesim` →
`tvlgiao.github.io` on Namecheap). `public/.well-known/assetlinks.json` binds the domain to the
package; `deploy.yml` sets `include-hidden-files` so it is published.

Signing key: `~/.keystores/cowork-dronesim-quest.jks`, alias `quest`, password in the macOS Keychain
(`security find-generic-password -a cowork-dronesim-quest -s "Drone Sim Quest keystore" -w`).
SHA-256 `D3:4F:86:7E:…:24:B0:AA:12` — must match `assetlinks.json`. **Back the keystore up**: the
store rejects updates signed with any other key.

Build (Meta's Bubblewrap fork; JDK 17 + SDK paths in `~/.bubblewrap/config.json`):

```bash
npm i -g @meta-quest/bubblewrap-cli          # once
mkdir -p /tmp/qb && cp quest/twa-manifest.json /tmp/qb && cd /tmp/qb
ln -sf ~/.keystores/cowork-dronesim-quest.jks quest-upload.jks   # signingKey.path is relative
export BUBBLEWRAP_KEYSTORE_PASSWORD=$(security find-generic-password -a cowork-dronesim-quest -s "Drone Sim Quest keystore" -w)
export BUBBLEWRAP_KEY_PASSWORD=$BUBBLEWRAP_KEYSTORE_PASSWORD
bubblewrap update --skipVersionUpgrade && bubblewrap build --skipPwaValidation
# → app-release-signed.apk (sideload / Horizon upload), app-release-bundle.aab
```

`quest/twa-manifest.json`: `isMetaQuest`, `horizonOSAppMode: "immersive"` (a 2D app cannot open a WebXR
session on Quest; the game enters VR on the browser's `sessiongranted` event, Enter VR stays as a fallback),
landscape, minSdk 32. Bump `appVersionCode` for every upload. Builds are kept in `quest/dist/`
(git-ignored).

Store: Meta Developer Dashboard → organisation → new Meta Horizon Store app → upload the APK to the
ALPHA channel → listing (screenshots 2560×1440, cover art), IARC age rating, data-use checkup →
submit for review.

The Capacitor Android APK is **not** for Quest (no VR there). Do not install both on one headset:
they share the package name with different signatures.
