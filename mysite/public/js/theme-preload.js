// theme-preload.js — applies the saved theme before first paint.
//
// Loaded as a plain blocking <script src> in <head> (no defer/async) so it runs
// before the body is painted. It lives in a file rather than inline because the
// Content-Security-Policy in firebase.json sets script-src 'self' with no
// 'unsafe-inline' — an inline block here is silently never executed.
//
// ─── THIS FILE OWNS THE BRIGHTNESS → COLOR MATH ─────────────────────────────
// computeThemeVars() is exported on window.BookWareTheme and is the ONE
// definition of it. theme.js calls this same function when the slider moves.
//
// It used to be duplicated: a copy here and a copy in theme.js. They drifted,
// and the copies disagreeing is what shipped a light theme whose text was
// lighter than its own background. A plain <script> can't be an ES module
// (modules are deferred, which defeats the whole point of running before
// paint), so this is the direction the sharing has to go.
(function () {
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }
  function hex(v) { v = clamp(v); return '#' + v.toString(16).padStart(2, '0').repeat(3); }

  // ── Contrast helpers (WCAG relative luminance, and its inverse) ───────────
  function chanToLum(v) {
    var c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function lumToChan(L) {
    L = Math.min(Math.max(L, 0), 1);
    var c = L <= 0.0031308 ? L * 12.92 : 1.055 * Math.pow(L, 1 / 2.4) - 0.055;
    return c * 255;
  }

  /** The grey that hits `ratio` against background `bgV`, placed on the dark
   *  side of it when `darkSide`, the light side otherwise. Clamps to pure
   *  black/white when the ratio simply isn't reachable — which is what happens
   *  around the middle of the slider, where the background is mid-grey and
   *  NOTHING contrasts well with it. */
  function forContrast(bgV, ratio, darkSide) {
    var Lbg = chanToLum(bgV);
    var L = darkSide ? (Lbg + 0.05) / ratio - 0.05
                     : (Lbg + 0.05) * ratio - 0.05;
    return clamp(lumToChan(L));
  }

  /** Every colour the brightness slider controls, for slider value 0-100.
   *
   *  The three text tones are derived from a target contrast ratio against the
   *  ACTUAL background, not from fixed hex values. That is the whole fix: the
   *  light-theme block in app.css pins --text-2/--text-3 to greys chosen for a
   *  pure white page (#4a4a58 / #8a8a9a), but this slider puts the background
   *  anywhere from mid-grey to white. At brightness 50-70 the background is
   *  grey while those greys stayed put, so muted text — section labels, author
   *  names, hints, every .muted-text — was lighter than the surface it sat on
   *  and effectively invisible. Deriving them keeps them readable at every
   *  position instead of at one. */
  function computeThemeVars(val) {
    var t = val / 100;
    var base = lerp(0, 255, t);
    var offAlt = lerp(16, -8, t);
    // Clamped: the offset drives this below 0 at the very bottom of the slider
    // (and above 255 at the top). hex() clamps on the way out, but the raw
    // value is also used in the maths below, where a negative fed to
    // Math.pow(x, 1.5) is NaN — which silently poisoned the whole theme.
    var card = clamp(base + lerp(-8, 8, t));

    // data-theme still flips at 50 — that governs the LIGHT/DARK look of
    // borders, hovers and shadows, and is a deliberate design switch.
    var light = val >= 50;

    // Text polarity, however, is decided by the background itself, not by that
    // flag. Tying the two together is what created the "unfixable" 40-50 band:
    // the flag flips at 50, but the point where dark text starts beating light
    // text is a background of ~#757575, i.e. slider ~46. Between 46 and 50 the
    // old code insisted on light text on an already-light grey and bottomed out
    // near 2.6:1. Choosing whichever side actually wins removes the band
    // entirely — the worst case anywhere on the slider becomes 4.58:1, at the
    // exact background where black and white tie, which still clears AA.
    var Lcard  = chanToLum(card);
    var vsWhite = 1.05 / (Lcard + 0.05);
    var vsBlack = (Lcard + 0.05) / 0.05;
    var darkText = vsBlack >= vsWhite;

    // Primary text aims high, then is held to a floor/ceiling so dark mode
    // still reads near-white and light mode near-black rather than drifting to
    // whatever the ratio alone would allow.
    var textV = forContrast(card, 13, darkText);
    textV = darkText ? Math.min(textV, 30) : Math.max(textV, 235);

    // Secondary/muted tones, then held back so they never out-contrast the
    // primary text. Near the tie point all three converge on the same extreme:
    // there is simply no headroom left for a hierarchy, and legibility wins.
    var t2 = forContrast(card, 7.2, darkText);
    var t3 = forContrast(card, 4.9, darkText);
    if (darkText) {
      t2 = Math.max(t2, textV);
      t3 = Math.max(t3, t2);
    } else {
      t2 = Math.min(t2, textV);
      t3 = Math.min(t3, t2);
    }

    // Chromatic tokens. --accent and friends stay the RAW palette hue so fills,
    // buttons and badges keep the brand colour at full saturation. Only the
    // -text variants are contrast-corrected, via oklch lightness in app.css,
    // and those are what foreground/border usages reference.
    //
    // Lightness is derived, not fitted. For a grey, Oklab lightness is very
    // close to the cube root of relative luminance (checks out: #808080 has
    // luminance 0.2158, cbrt 0.5998, and its actual oklch L is 0.5989). So:
    // work out the grey that would hit the target ratio, then take that grey's
    // lightness. Hand-fitted curves used to live here and needed a floor of
    // 0.14, which is exactly what kept the tie point stuck at 4.44:1.
    //
    // The target carries margin over 4.5 because a chromatic colour at a given
    // lightness has LOWER luminance than the grey at that lightness (red worst).
    // 6.5 is the smallest margin that clears 4.5:1 for every hue at every
    // slider position — solved for, and anything higher only costs chroma
    // without improving the worst case, which is pinned at 4.54:1 by the tie.
    var hueL = Math.cbrt(chanToLum(forContrast(card, 6.5, darkText)));

    // Chroma has to give way near the tie point. A saturated hue cannot reach
    // the luminance of white or black — push crimson to lightness 1 and it
    // becomes pale peach, not white, stalling around 3.6:1 against a mid-grey.
    // So as the available headroom shrinks, so does chroma, until the token is
    // effectively the grey that we know can hit the target. Colour is the thing
    // worth losing there; legibility isn't. Full chroma returns as soon as the
    // background gives it room, which is everywhere a real preset lives.
    var headroom = Math.max(vsWhite, vsBlack);
    var hueC = headroom >= 8.5
      ? 1
      : Math.max(0.05, (headroom - 4.5) / (8.5 - 4.5));

    return {
      "--bg": hex(base),
      "--bg-card": hex(card),
      "--bg-inset": hex(base + lerp(-14, 12, t)),
      "--border": hex(base + offAlt * 0.6),
      "--text": hex(textV),
      "--text-2": hex(t2),
      "--text-3": hex(t3),
      "--hue-l": hueL.toFixed(3),
      "--hue-c": hueC.toFixed(3),
      light: light,
    };
  }

  window.BookWareTheme = { computeThemeVars: computeThemeVars };

  // ── Apply the saved theme now, before paint ──────────────────────────────
  var val = parseInt(localStorage.getItem('bookware-brightness') || '18', 10);
  if (isNaN(val)) val = 18;

  var vars = computeThemeVars(val);
  var r = document.documentElement;
  for (var k in vars) {
    if (k.charAt(0) === '-') r.style.setProperty(k, vars[k]);
  }
  if (vars.light) r.setAttribute('data-theme', 'light');

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
