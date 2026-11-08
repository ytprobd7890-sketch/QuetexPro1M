/**
 * Quetex Pro 1M — service worker
 *
 * 1. app shell: network-first with an offline cache fallback
 * 2. Web Share Target: catches a screenshot shared from the Android share sheet,
 *    stores it in the Cache API and redirects to the app with ?shared=1
 *
 * That share target is the only way a phone can hand a chart to the app without
 * a native client: mobile browsers have no tab-capture API.
 */

const VERSION = 'qp1m-v5';
const SHARE_CACHE = 'qp1m-share';
const SHARE_KEY = '/__shared-chart';

// Resolved against the service worker's own scope, so the app also works when
// it is hosted under a sub-path (github.io/RepoName/, Netlify branch, …).
const BASE = new URL('./', self.registration.scope);
const abs = (p) => new URL(p, BASE).href;
const SHARE_PATH = new URL('share-target', BASE).pathname;

const SHELL = [
  '',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/edge.js',
  'js/predictor.js',
  'js/capture.js',
  'js/chart.js',
  'js/data.js',
  'js/strategy.js',
  'js/backtest.js',
  'js/indicators.js',
  'js/utils.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
].map(abs);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ---- Web Share Target ----
  if (req.method === 'POST' && url.pathname === SHARE_PATH) {
    event.respondWith(handleShare(req));
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(VERSION);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match(abs('index.html'));
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.get('chart') || form.get('image') || form.get('file');
    if (file && typeof file !== 'string' && file.size > 0) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(
        SHARE_KEY,
        new Response(file, {
          headers: {
            'Content-Type': file.type || 'image/png',
            'X-File-Name': encodeURIComponent(file.name || 'chart.png')
          }
        })
      );
    }
  } catch {
    /* fall through to the redirect — the app will ask for an upload */
  }
  return Response.redirect(new URL('?shared=1', BASE).href, 303);
}
