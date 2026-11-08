# Quetex 1M — Android capture shell

A ~250-line Android app that wraps this web app in a WebView and **captures the screen itself**,
so you never take a screenshot again:

```
MediaProjection ──► ImageReader ──► JPEG ──► base64 ──► WebView ──► window.QP.onFrame()
                                                                        │
                                                              capture.js + predictor.js
                                                                        │
                                                              UP / DOWN + probability
```

The WebView side is already wired: `window.QP.onFrame(dataUrl)` accepts a frame, applies your saved
crop, reads the candles and refreshes the prediction.

> ⚠️ **This folder is a reference implementation.** It was written and reviewed here but **not
> compiled**, because this environment has no Android SDK. Expect to fix small build issues in
> Android Studio. Everything outside this folder is tested (`npm test`).

---

## Build it (one time, ~10 minutes)

1. Install **Android Studio** (Hedgehog or newer) with JDK 17 and SDK 34.
2. `File → Open…` → choose this `android/` folder.
3. Let Gradle sync.
4. Set your deployed app URL — either edit `APP_URL` in `app/build.gradle.kts`, or just launch the app
   and type the URL when it asks (it is stored in `SharedPreferences`, so you only do it once).
   It must be **https**.
5. `Build → Build Bundle(s)/APK(s) → Build APK(s)`.
6. Copy `app/build/outputs/apk/debug/app-debug.apk` to your phone, install it (allow "install unknown
   apps" once).

## Use it

1. Open the app → it loads Quetex in the WebView.
2. Tap **Start capture** → Android shows its screen-capture consent dialog → allow.
3. Switch to your broker app (Quotex, Pocket, TradingView…), open the 1-minute chart.
4. Frames are sent into Quetex **every 6 seconds**; the prediction card updates in the background
   and the result is logged in the session record.
5. Tap the notification → **Stop capture** when you are done.

The first time, drag once on the captured image to crop the candle area — Quetex remembers that crop
(normalised to the screen size), so every later frame is read automatically.

## What is in here

| File | Role |
|---|---|
| `app/src/main/java/com/quetex/pro1m/MainActivity.kt` | WebView, URL settings, capture permission, service start/stop |
| `app/src/main/java/com/quetex/pro1m/CaptureService.kt` | Foreground service: MediaProjection → ImageReader → JPEG → base64 → JS |
| `app/src/main/AndroidManifest.xml` | permissions + service declaration |
| `app/build.gradle.kts` | `APP_URL` build config, SDK levels, dependencies |

## Rules this app must respect

- **Android 14 (API 34):** the service must be started with
  `startForeground(..., FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)`, the
  `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission must be declared, and a
  `MediaProjection.Callback` must be registered before `createVirtualDisplay`. The code does all three.
- **Consent is per session.** The user sees a system dialog every time capture starts. That is not
  something an app can bypass, by design.
- **Nothing leaves the device.** Frames go straight into the local WebView; there is no upload, no
  analytics, no account.
- **Your broker's ToS still applies.** This automates *reading your own screen*; it does not log into
  your account, place orders or bypass any protection. Even so, check that your broker allows
  tool-assisted trading.

## Known limits

- The WebView pauses JavaScript when the activity is fully stopped on some OEM builds. If frames stop
  arriving, keep Quetex in split-screen next to the broker (or use a floating-window build).
- Frames are JPEG-compressed at quality 70 and capped at 1280 px wide — plenty for candle reading,
  small enough to inject through the JS bridge.
- This shell does not trade, log in, or store credentials. It only reads pixels.
