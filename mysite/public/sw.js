// ─────────────────────────────────────────────────────────────────────────────
// BookWare Service Worker  v1.0
// Strategy:
//   - Precache app shell on install
//   - HTML pages: network-first (always fresh), fall back to cache when offline
//   - Static assets (CSS/JS/icons): network-first, fall back to cache offline
//   - External CDN (Firebase, Google, jsDelivr): pass-through (no caching)
// ─────────────────────────────────────────────────────────────────────────────

// Assets are NETWORK-FIRST now (see the fetch handler), so picking up a release
// no longer depends on remembering to bump this. It used to: assets were
// cache-first, and the version below was the only thing that evicted them.
// That trap went off exactly as its old comment warned — release after release
// shipped while browsers kept running the PREVIOUS build's JavaScript, so every
// deployed fix appeared to do nothing at all. Bump it when you want old entries
// evicted outright; correctness no longer hinges on it.
const CACHE  = 'bookware-v7';
const SHELL  = [
  '/',
  '/index.html',
  '/student.html',
  '/teacher.html',
  '/admin.html',
  '/teacher-access.html',
  '/teacher-signup.html',
  '/manifest.json',
  '/favicon.svg',
  '/css/index.css',
  '/css/app.css',
  '/css/admin.css',
  '/css/signup.css',
  '/js/auth.js',
  '/js/config.js',
  '/js/firebase.js',
  '/js/theme-preload.js',
  '/js/sw-register.js',
  '/js/login-notice.js',
  '/js/student.js',
  '/js/teacher.js',
  '/js/admin.js',
  '/js/books.js',
  '/js/barcode.js',
  '/js/preloader.js',
  '/js/retention.js',
  '/css/preloader.css',
  '/privacy.html',
  '/css/privacy.css',
  '/js/booklist.js',
  '/js/quiz.js',
  '/js/welcome.js',
  '/js/qr.js',
  '/js/theme.js',
  '/js/teacher-access.js',
  '/js/teacher-signup.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];


// Fetch that genuinely goes to the network.
//
// `fetch(req)` inside a service worker STILL consults the browser's HTTP cache.
// Firebase Hosting's default for files with no explicit Cache-Control is
// max-age=3600, so "network-first" below was quietly returning hour-old
// responses — including their hour-old *headers*. That is how a corrected
// Content-Security-Policy kept failing to take effect after a deploy: the
// document was replayed from cache with the old policy attached.
//
// Built from req.url rather than passing init to fetch(req): a navigation
// request has mode 'navigate', and re-constructing one of those with an init
// object throws.
function networkFirstFetch(req) {
  return fetch(req.url, {
    cache: 'reload',            // bypass the HTTP cache outright
    credentials: 'same-origin',
    redirect: 'follow',
  });
}

// ── Install — precache all shell assets ───────────────────────────────────────
self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate — delete stale caches ───────────────────────────────────────────
self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch — serve requests ────────────────────────────────────────────────────
self.addEventListener('fetch', evt => {
  const req = evt.request;
  const url = new URL(req.url);

  // Only intercept GET requests from our own origin
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const isHTML = req.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    // Network-first for HTML — always try to load fresh, offline falls back to cache
    evt.respondWith(
      networkFirstFetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req)
            .then(cached => cached || caches.match('/index.html'))
        )
    );
  } else {
    // Network-first for static assets, cache only as an offline fallback.
    //
    // This was `cached || network`, which handed a returning user the PREVIOUS
    // release's JS/CSS on every load — the network copy it fetched alongside
    // only refreshed the cache for some future visit. The practical effect was
    // that deploying a fix changed nothing for anyone who had already used the
    // app, indefinitely, and the only escape hatch was remembering to bump
    // CACHE by hand. Serving stale application code by default is not a
    // trade-off worth the few milliseconds it saved.
    evt.respondWith(
      networkFirstFetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        // Offline (or the request failed): fall back to whatever we cached.
        // respondWith() rejects on undefined, so never hand it a miss.
        .catch(() => caches.match(req).then(cached => cached || Response.error()))
    );
  }
});
