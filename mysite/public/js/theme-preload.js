// theme-preload.js — applies the saved theme before first paint.
//
// Loaded as a plain blocking <script src> in <head> (no defer/async) so it runs
// before the body is painted. It lives in a file rather than inline because the
// Content-Security-Policy in firebase.json sets script-src 'self' with no
// 'unsafe-inline' — an inline block here is silently never executed.
//
// Shared by student.html, teacher.html and admin.html; theme.js re-applies the
// same values later from the same localStorage keys.
(function () {
  var val = parseInt(localStorage.getItem('bookware-brightness') || '18', 10);
  if (isNaN(val)) val = 18;
  var t = val / 100;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function hex(v) { v = clamp(v); return '#' + v.toString(16).padStart(2, '0').repeat(3); }

  var base   = lerp(0, 255, t);
  var offAlt = lerp(16, -8, t);
  var r      = document.documentElement;

  r.style.setProperty('--bg',       hex(base));
  r.style.setProperty('--bg-card',  hex(base + lerp(-8, 8, t)));
  r.style.setProperty('--bg-inset', hex(base + lerp(-14, 12, t)));
  r.style.setProperty('--border',   hex(base + offAlt * 0.6));

  var tv = val <= 45 ? lerp(240, 200, val / 45)
         : val >= 55 ? lerp(200, 26, (val - 55) / 45)
         : 200;
  r.style.setProperty('--text', hex(tv));

  if (val >= 50) r.setAttribute('data-theme', 'light');

  var color = localStorage.getItem('bookware-color');
  if (color && color !== 'crimson') r.setAttribute('data-color', color);

  // This does NOT actually hide anything: both app.css and admin.css carry
  // `html { visibility: visible !important }`, and an author !important rule
  // outranks a normal inline style. It is kept because the flag is read as an
  // "init hasn't finished yet" marker — firebase.js revealWithError() only
  // paints its error screen when this is still 'hidden', and student.js /
  // teacher.js / admin.js clear it once auth resolves. Removing it would
  // silently disable that error screen.
  r.style.visibility = 'hidden';
})();
