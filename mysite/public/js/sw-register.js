// sw-register.js — registers the service worker.
//
// Extracted from an inline <script> because the Content-Security-Policy in
// firebase.json sets script-src 'self' with no 'unsafe-inline', which meant the
// inline version never ran in production and the service worker was never
// registered at all — offline support and asset caching silently did nothing.
//
// Waits for `load` so registration never competes with the page's own critical
// requests. Load with `defer`.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .catch(function (err) { console.warn('[SW] registration failed:', err); });
  });
}
