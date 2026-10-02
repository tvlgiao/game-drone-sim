# Store release — iOS, Android, Meta Quest

App ID on every store: **`com.cowork.dronesim`** (cannot change after the first release).

| Target | Shell | Why |
|---|---|---|
| iPhone / iPad (App Store) | Capacitor `ios/` (WKWebView) | offline bundle of `dist-native/`, touch + gamepad |
| Android phones / tablets (Google Play) | Capacitor `android/` (WebView) | same |
| Meta Quest (Horizon Store) | PWA packaged as APK, start URL `/app/` | Android WebView has no WebXR; the Quest Browser engine does |

## Website layout (since 1.0.3)

| URL | Page | Edition (`src/core/edition.ts`) |
|---|---|---|
| `/` | landing page (`index.html`, `src/landing/`): pitch, screenshots, store badges, Play button | — |
| `/play/` | free web game, every level on a flat screen, **never VR** (no Enter VR, `sessiongranted` ignored) | `web-free` |
| `/app/` | the Quest store app (TWA start URL): full game with VR, only after the store ownership check | `quest-app` |
| `dist-native/` index | the iOS / Android apps: the game page at the root, no landing, no gate, no VR UI | `native` |

Store badges on the landing page and the Quest gate come from `STORE_LINKS` in `src/site/stores.ts`:
a `null` url renders as "Coming soon". Paste each listing URL there once it is live.

`/app/` ownership check (`src/core/ownership.ts`, client-only): `window.getDigitalGoodsService('https://quest.meta.com/billing')`
must resolve and its Meta-specific `getLoggedInUserId()` must return a non-zero id. Success is cached in
`localStorage['drone-sim.owned.v1']` (a timestamp, never the id), so the app launches offline after one
online check; online launches re-check. A plain browser tab (no API), id 0, or a failed check with no cache
shows the full-screen store gate (store link + "Play free on the web" → `../play/`). `?owned=1` skips the
check in `npm run dev` only.

Old links: the root used to be the game. `src/landing/legacy.ts` sends a root URL with a game query
(`?selftest=1`, `?xremu=1`, `?rotate=0`, `?owned=…`) to `./play/` with the query kept, and a standalone
(installed) launch of the root to `./app/` on a Quest (Quest APK ≤ 1.0.2, start URL `/`) or `./play/`
elsewhere (old home-screen PWAs).

## Build

```bash
npm run cap:sync        # build:native (vite --mode native → dist-native/) + copy into both native projects
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

`quest/twa-manifest.json`: `startUrl: "/app/"`, `webManifestUrl` …`/app/manifest.webmanifest`, `isMetaQuest`, `horizonOSAppMode: "immersive"` (a 2D app cannot open a WebXR
session on Quest; the game enters VR on the browser's `sessiongranted` event, Enter VR stays as a fallback),
landscape, minSdk 32. Bump `appVersionCode` for every upload. Builds are kept in `quest/dist/`
(git-ignored).

Store: Meta Developer Dashboard → organisation → new Meta Horizon Store app → upload the APK to the
ALPHA channel → listing (screenshots 2560×1440, cover art), IARC age rating, data-use checkup →
submit for review. The Data Use Checkup must declare the **User ID** platform feature: `/app/` calls
`getLoggedInUserId()` to confirm ownership (used on the device only, not stored or sent). Then paste the
store URL into `STORE_LINKS` (`src/site/stores.ts`).

The Capacitor Android APK is **not** for Quest (no VR there). Do not install both on one headset:
they share the package name with different signatures.
