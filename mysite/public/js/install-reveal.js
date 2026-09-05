// install-reveal.js — fades the step cards in as they scroll into view on
// ios.html and android.html.
//
// A separate file rather than an inline <script> because the Content-Security-
// Policy in firebase.json sets script-src 'self' with no 'unsafe-inline'. The
// School-Map pages these were adapted from carried this inline; ported across
// unchanged it would never have run in production, and silently — the browser
// blocks it with nothing in the UI to show for it. Load with `defer`.
//
// The cards start VISIBLE in install.css and this hides the off-screen ones,
// which is the opposite of the usual pattern and deliberate: if this file is
// blocked or fails outright, the page still reads correctly instead of
// rendering a column of invisible cards.
(function () {
  var els = document.querySelectorAll('.step, .done-card');
  if (!els.length) return;

  // Honour the same preference the stylesheet does — no point hiding anything
  // if the transition that would bring it back is disabled.
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  var MARGIN = 40;
  function vh() { return window.innerHeight || document.documentElement.clientHeight; }
  function onScreen(el) { return el.getBoundingClientRect().top < vh() - MARGIN; }

  // Hide only what is currently below the fold, so nothing that has already
  // painted flickers out.
  var pending = [];
  for (var i = 0; i < els.length; i++) {
    if (!onScreen(els[i])) {
      els[i].classList.add('reveal-pending');
      pending.push(els[i]);
    }
  }
  if (!pending.length) return;

  function reveal(el) {
    el.classList.remove('reveal-pending');
    var at = pending.indexOf(el);
    if (at !== -1) pending.splice(at, 1);
  }

  // Primary mechanism: cheap, and fires as soon as a card scrolls in.
  var observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        reveal(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -' + MARGIN + 'px 0px' });
    pending.forEach(function (el) { observer.observe(el); });
  }

  // Backstop: a plain timer that re-checks the same geometry.
  //
  // Hiding content and waiting for an observer to hand it back is a bet that
  // the observer will run, and when that bet loses the page is not merely
  // "un-animated" — it is a column of permanently invisible cards the reader
  // cannot recover. An IntersectionObserver only delivers while the document's
  // rendering lifecycle is running, so an offscreen, throttled or backgrounded
  // renderer never fires it. That reproduced exactly this way during
  // development, where requestAnimationFrame and scroll events were stalled
  // too — which is why neither of those is used as the fallback, and why the
  // fallback can't simply be "did the observer deliver once?" either: it does
  // deliver an initial batch of non-intersecting entries, so that test passes
  // and the cards stay hidden anyway.
  //
  // setTimeout and getBoundingClientRect keep working in all of those states,
  // so this reveals cards on time regardless. It stops as soon as nothing is
  // pending, and after DEADLINE it gives up and shows whatever is left rather
  // than hiding it indefinitely.
  var DEADLINE = Date.now() + 20000;
  (function poll() {
    for (var i = pending.length - 1; i >= 0; i--) {
      if (onScreen(pending[i])) reveal(pending[i]);
    }
    if (!pending.length) {
      if (observer) observer.disconnect();
      return;
    }
    if (Date.now() >= DEADLINE) {
      if (observer) observer.disconnect();
      pending.slice().forEach(reveal);
      return;
    }
    setTimeout(poll, 400);
  })();
})();
