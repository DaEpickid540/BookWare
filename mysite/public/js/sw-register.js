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
  // Whether a worker already controlled this page when the script parsed. A
  // first-ever install also fires `controllerchange` (the worker calls
  // clients.claim()), and reloading on that would be pointless churn — so only
  // an UPDATE, where control passes from one worker to another, triggers one.
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;

  // When a new worker takes over, the page is still running whatever code the
  // old one served. Reload once so the release actually takes effect, rather
  // than leaving the user on stale JS until they happen to refresh again —
  // which is exactly how shipped fixes came to look like they did nothing.
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) {
        // Check for a new worker now instead of waiting for the browser's own
        // schedule, so a fix lands on this load rather than hours later.
        reg.update().catch(function () {});
      })
      .catch(function (err) { console.warn('[SW] registration failed:', err); });
  });
}
