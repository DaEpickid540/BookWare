// ─────────────────────────────────────────────────────────────────────────────
// BookWare Service Worker  v1.0
// Strategy:
//   - Precache app shell on install
//   - HTML pages: network-first (always fresh), fall back to cache when offline
//   - Static assets (CSS/JS/icons): cache-first, update in background
//   - External CDN (Firebase, Google, jsDelivr): pass-through (no caching)
// ─────────────────────────────────────────────────────────────────────────────

const CACHE  = 'bookware-v2';
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
  '/js/student.js',
  '/js/teacher.js',
  '/js/admin.js',
  '/js/books.js',
  '/js/booklist.js',
  '/js/quiz.js',
  '/js/qr.js',
  '/js/theme.js',
  '/js/teacher-access.js',
  '/js/teacher-signup.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

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
      fetch(req)
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
    // Cache-first for static assets — fast load, refresh in background
    evt.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        });
        return cached || network;
      })
    );
  }
});
