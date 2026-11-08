# Getting a chart into Quetex on a phone — iframe, backend browser, or share sheet?

**সংক্ষেপে (Bangla):**

- **iframe দিয়ে হবে না।** ব্রোকার সাইট `X-Frame-Options` / CSP দিয়ে ফ্রেম ব্লক করে, আর ক্রস-অরিজিন
  ফ্রেমের ভেতরের ছবি পড়ার কোনো API-ই নেই। ফলাফল: ফাঁকা বাক্স।
- **backend browser** (সার্ভারে হেডলেস Chromium) কৌশলগতভাবে সম্ভব, কিন্তু ব্রোকার অ্যাকাউন্টের
  পাসওয়ার্ড/2FA সার্ভারে রাখতে হয়, bot-protection আর ToS-এ আটকায়, খরচও বেশি। **আমরা এটা করি না।**
- **যেটা সত্যিই কাজ করে:** ফোনে অ্যাপটা **install** করে নিন → স্ক্রিনশট নিন → **Share → Quetex 1M**।
  দুই ট্যাপ। এটা এখন বানানো আছে (PWA + Web Share Target)।

---

## 1. Why an iframe cannot work

Three independent blockers. Any one of them alone is fatal.

| # | Blocker | What you actually observe |
|---|---|---|
| 1 | `X-Frame-Options: DENY` / `SAMEORIGIN`, or CSP `frame-ancestors 'self'` on the broker page | The frame stays **blank**. Console: *"Refused to display … in a frame because it set 'X-Frame-Options'"*. Quotex, Pocket Option, Binance and TradingView all do this. |
| 2 | Same-origin policy | Even if it rendered, `iframe.contentDocument` is `null` and `contentWindow.document` throws. You cannot read the DOM, the canvas, or the pixels. |
| 3 | No rasterisation API for frames | `canvas.drawImage(iframeElement)` does not exist. `element.captureStream()` works for `<video>` and `<canvas>`, **not** for a browsing context. `html2canvas` runs inside the page — it cannot cross an origin. |

So an iframe gives you a **rectangle with nothing in it** — and even a same-origin iframe could not be
screenshotted from JavaScript, because the rendering of a document is done by the compositor, not by
anything script can reach.

The only browser API that can hand you somebody else's pixels is `getDisplayMedia()` — which is
**desktop only**. On Chrome Android and iOS Safari the function does not exist:

```js
navigator.mediaDevices.getDisplayMedia
// Chrome (desktop) → function
// Chrome Android   → undefined
// Safari iOS       → undefined
```

That is not a permission you can request. The API is simply not shipped.

---

## 2. The backend-browser idea (headless Chromium on a server)

Architecture people usually mean:

```
 phone ──► your server (Node + Playwright) ──► headless Chromium ──► broker page
                    │                                                   │
                    │◄──────────── screenshot (PNG) ────────────────────┘
                    │
                    ▼
        pixel reader (this repo's capture.js) ──► candles ──► prediction ──► phone
```

It is technically buildable. It is also the wrong trade for a retail trader. Here is the full bill:

| Requirement | Reality |
|---|---|
| Broker credentials on the server | You must store username/password **and** the session cookie. That is a credential vault + encryption + audit trail. One breach and your trading account is gone. |
| 2FA / OTP | Most brokers force an OTP on new logins. The server needs your phone, SMS or an authenticator seed. Now the server *is* your account. |
| Anti-bot | Brokers sit behind Cloudflare / DataDome / PerimeterX. Headless Chromium gets challenged, and "stealth" plugins are an arms race you lose monthly. |
| IP reputation | Datacenter IPs are flagged. You need a residential proxy that matches your account's country — another monthly cost and another party holding your session. |
| Terms of service | Almost every broker forbids automated access. Account closure, and you lose the balance. |
| Cost | A browser session is ~1–2 vCPU and 2 GB RAM. A $5 VPS cannot run several. Realistically $20–60/month per concurrent session, plus the proxy. |
| Latency | 3–10 s per screenshot. For a 1-minute candle you need it every 60 s, reliably, forever, or the feature silently dies. |
| Legal | You become a data controller for someone else's trading credentials. That is a compliance problem, not a coding problem. |

**Verdict:** it works in a demo, it does not work as a product. And note: *this* environment has no
outbound access to brokers at all, so it could not even be prototyped here.

### What a backend *can* legitimately do

Public market data needs no login:

```js
// tiny proxy so a geo-blocked phone can still reach the venue
app.get('/api/klines', async (req, res) => {
  const { symbol = 'BTCUSDT', interval = '1m', limit = 500 } = req.query;
  const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  res.json(await r.json());
});
```

That is the useful backend: **public candles, zero credentials**. It is exactly what the app's `live`
mode already does from the browser, and it becomes worthwhile only if your venue is geo-blocked on
mobile — in which case host the proxy somewhere legal for you, and never put a broker login on it.

---

## 3. Killing the "screenshot every minute" loop

Three levels, cheapest first:

| Level | What you do per minute | Where |
|---|---|---|
| **Live** | nothing | any browser, BTC/ETH/SOL/BNB |
| **Auto-capture (desktop)** | nothing — share the tab once | desktop Chrome/Edge |
| **Android shell** | nothing — grant capture once | Android (build the APK, see `android/`) |
| Share sheet | 2 taps | Android |
| Upload | 3–4 taps | everywhere |

**Saved crop.** The first time you crop the candle area, the app stores that rectangle
(normalised, in `localStorage`). Every later screenshot is cropped the same way and analysed
automatically — the share flow becomes *Share → prediction*, with no dragging and no button.

**Auto-capture (desktop).** After `Share tab`, tick **Auto-capture every 6 s**. The service keeps
the stream open, grabs a frame, reads the candles and refreshes the prediction without any clicking.
Stop sharing and it stops.

**Android shell.** The only zero-touch path on a phone. `android/` contains a ~250-line app that
mirrors the screen with `MediaProjection` and pushes a JPEG into the web app every 6 seconds:

```
MediaProjection → ImageReader → JPEG → base64 → window.QP.onFrame() → capture.js → predictor.js
```

Build it once in Android Studio (see `android/README.md`), install it, tap **Start capture**, switch
to your broker chart. After that, nothing else to do.

---

## 4. What is actually shipped (works today)

| Method | Phone | Desktop | Status |
|---|---|---|---|
| **PWA share target** — screenshot → Share → Quetex 1M | Android ✅ (iOS ❌) | — | **done** |
| **Upload** — pick any screenshot | ✅ | ✅ | **done** |
| **Camera** — photograph another screen / tablet | ✅ | ✅ | **done** |
| **Paste** — copy an image, paste into the app | most Chromium builds | ✅ | **done** |
| **Tab share + auto-capture** — `getDisplayMedia`, re-read every 6 s | ❌ API absent | ✅ | **done** |
| **Manual paste** — `open,high,low,close` rows | ✅ | ✅ | **done** |
| **Android shell** — MediaProjection, zero touch (`android/`) | ✅ (build APK) | — | source provided |
| iframe | ❌ | ❌ | impossible (see §1) |
| Backend browser | ⚠️ | ⚠️ | deliberately not built (see §2) |

### The Android share flow, step by step

1. Open the app in Chrome → menu → **Add to Home screen** (or tap **Install app** in the capture card).
2. Take a normal screenshot of your broker chart.
3. In the gallery/screenshot preview, tap **Share** → choose **Quetex 1M**.
4. The app opens with the screenshot already loaded. Drag to crop the candle area → **Analyse**.

Under the hood: the manifest declares a `share_target` posting `multipart/form-data` to
`/share-target`; the service worker intercepts that POST, stores the image in the Cache API and
redirects to `/?shared=1`; the app picks the image up, deletes it from the cache and runs the same
pixel reader as an upload. Nothing is uploaded to a server.

### iOS

Safari supports PWAs ("Add to Home Screen") but **not** the Web Share Target API. Two options:

- **Upload** from Photos — two extra taps, works today.
- Build a **Shortcut** (Shortcuts app → "Receive Images" → "Open URLs" with the app open) — fiddly but automatable.

---

## 5. The only true screen capture on a phone: a native app

Android exposes `MediaProjection` (Screen Capture API). It requires:

- a real Android app (Java/Kotlin) — the web platform cannot call it,
- a per-session system consent dialog,
- a persistent foreground-service notification while capturing.

iOS has `ReplayKit` with the same shape. Both mean building, signing and sideloading an APK/IPA, plus
the whole app around it. That is the only honest route to "share my screen to an AI on mobile", and it
is a native-app project, not a web one.

---

## 6. Recommendation

1. **Today:** install the PWA, use Share → Quetex on Android, Upload everywhere else.
2. **If you must automate on a phone:** build the native Android screen-capture client and post frames
   to this same analysis engine — the pixel reader and predictor are already framework-free ES modules.
3. **Never:** put broker credentials on a box you do not physically control, and never let a "signal bot"
   trade an account whose ToS forbids automation.
